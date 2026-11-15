"use strict";

const photoshop = require("photoshop");
const { app, action, core, imaging, constants } = photoshop;
const { PluginError } = require("./errors");
const targets = require("./targets");
const evidenceImaging = require("./imaging");
const verification = require("./verification");
const {
  getExportFolder,
  resolvePersistentEntry,
  createTemporaryExportFile,
  readEntryBinary,
  materializeTemporaryImportFile,
  deleteEntry
} = require("./storage");

const jobs = new Map();
const approvalListeners = new Set();
const USER_ASSISTED_INSTRUCTIONS = Object.freeze({
  "document.save": "Photoshop에서 파일 > 저장 또는 다른 이름으로 저장을 완료한 뒤 아래의 ‘완료’를 누르세요. 저장하지 않으려면 ‘취소’를 누르세요.",
  "ui.camera_raw_filter": "Photoshop에서 필터 > Camera Raw 필터를 직접 열고 원하는 조정을 적용한 뒤 아래의 ‘완료’를 누르세요. 작업을 적용하지 않으려면 ‘취소’를 누르세요.",
  "selection.color_range_dialog": "Photoshop에서 선택 > 색상 범위를 직접 열고 범위를 설정한 뒤 아래의 ‘완료’를 누르세요. 선택을 적용하지 않으려면 ‘취소’를 누르세요.",
  "selection.select_and_mask_dialog": "Photoshop에서 선택 > 선택 및 마스크를 직접 열고 가장자리와 출력 설정을 완료한 뒤 아래의 ‘완료’를 누르세요. 적용하지 않으려면 ‘취소’를 누르세요.",
  "filter.liquify_dialog": "Photoshop에서 필터 > 픽셀 유동화를 직접 열고 변형을 적용한 뒤 아래의 ‘완료’를 누르세요. 적용하지 않으려면 ‘취소’를 누르세요.",
  "filter.vanishing_point_dialog": "Photoshop에서 필터 > 소실점을 직접 열고 평면과 편집을 완료한 뒤 아래의 ‘완료’를 누르세요. 적용하지 않으려면 ‘취소’를 누르세요.",
  "automation.batch_dialog": "Photoshop에서 파일 > 자동화 > 일괄 처리를 직접 열고 원본·대상·덮어쓰기 옵션을 확인하여 실행한 뒤 아래의 ‘완료’를 누르세요. 실행하지 않으려면 ‘취소’를 누르세요.",
  "output.print_dialog": "Photoshop에서 파일 > 인쇄를 직접 열고 프린터·용지·색상 설정을 확인하여 인쇄를 완료한 뒤 아래의 ‘완료’를 누르세요. 인쇄하지 않으려면 ‘취소’를 누르세요.",
  "application.preferences_dialog": "Photoshop에서 편집 > 환경 설정을 직접 열고 원하는 설정을 적용한 뒤 아래의 ‘완료’를 누르세요. 변경하지 않으려면 ‘취소’를 누르세요.",
  "application.workspace_dialog": "Photoshop에서 창 > 작업 영역을 직접 열고 작업 영역 선택·저장·재설정을 완료한 뒤 아래의 ‘완료’를 누르세요. 변경하지 않으려면 ‘취소’를 누르세요.",
  "action.record_dialog": "Photoshop의 액션 패널에서 새 액션을 만들고 기록·중지를 직접 완료한 뒤 아래의 ‘완료’를 누르세요. 기록하지 않으려면 ‘취소’를 누르세요."
});
const USER_ASSISTED_COMMANDS = new Set([
  "document.save", "ui.camera_raw_filter", "selection.color_range_dialog",
  "selection.select_and_mask_dialog", "filter.liquify_dialog",
  "filter.vanishing_point_dialog", "automation.batch_dialog",
  "output.print_dialog", "application.preferences_dialog",
  "application.workspace_dialog", "action.record_dialog"
]);

const MUTATING_COMMANDS = new Set([
  "document.create", "document.open_default", "document.close", "document.save", "document.export",
  "document.duplicate", "document.resize_canvas", "document.rotate", "document.color_mode_set",
  "document.bits_per_channel_set", "document.profile_convert",
  "mask.properties_set", "history.state_activate",
  "layer.create", "layer.delete", "layer.rename", "layer.group_create",
  "layer.visibility_set", "layer.opacity_set", "layer.translate", "layer.scale", "layer.rotate", "layer.clipping_set",
  "layer.blend_mode_set", "layer.fill_opacity_set", "layer.locked_set",
  "selection.select_all", "selection.deselect", "selection.invert",
  "selection.rectangle", "selection.ellipse", "selection.expand",
  "selection.contract", "selection.feather", "selection.border",
  "selection.polygon", "selection.grow", "selection.smooth",
  "filter.gaussian_blur", "filter.sharpen", "filter.add_noise",
  "filter.pinch", "filter.polar_coordinates", "filter.ripple", "filter.spherize",
  "filter.twirl", "filter.zigzag", "filter.ocean_ripple", "filter.diffuse_glow",
  "filter.clouds", "filter.difference_clouds",
  "channel.create", "channel.duplicate", "channel.delete",
  "channel.calculations_new", "layer.apply_image",
  "path.create", "path.create_from_selection", "path.select", "path.duplicate", "path.delete", "path.make_selection",
  "layer_comp.create", "layer_comp.apply", "layer_comp.duplicate", "layer_comp.recapture",
  "layer_comp.reset", "layer_comp.delete",
  "action.play",
  "generative.upscale",
  "text.create", "text.content_set", "text.character_style_set", "text.paragraph_style_set",
  "text.warp_style_set", "text.convert", "history.undo", "history.redo",
  "image.resize", "verified.batchplay"
]);

// These commands change pixels/layers in the current document and can be
// collapsed into one history state. Lifecycle, persistence, and history
// navigation commands still run modally, but cannot safely suspend history.
const HISTORY_SUSPEND_COMMANDS = new Set([
  "document.resize_canvas", "document.rotate", "document.color_mode_set", "document.bits_per_channel_set", "document.profile_convert", "layer.create", "layer.delete",
  "layer.rename", "layer.group_create", "layer.visibility_set", "layer.opacity_set",
  "layer.translate", "layer.scale", "layer.rotate",
  "mask.properties_set",
  "layer.clipping_set", "layer.blend_mode_set", "layer.fill_opacity_set",
  "layer.locked_set", "filter.gaussian_blur", "filter.sharpen", "filter.add_noise",
  "filter.pinch", "filter.polar_coordinates", "filter.ripple", "filter.spherize",
  "filter.twirl", "filter.zigzag", "filter.ocean_ripple", "filter.diffuse_glow",
  "filter.clouds", "filter.difference_clouds",
  "selection.select_all", "selection.deselect", "selection.invert",
  "selection.rectangle", "selection.ellipse", "selection.expand",
  "selection.contract", "selection.feather", "selection.border",
  "selection.polygon", "selection.grow", "selection.smooth",
  "channel.create", "channel.duplicate", "channel.delete",
  "channel.calculations_new", "layer.apply_image",
  "path.create", "path.create_from_selection", "path.duplicate", "path.delete", "path.make_selection",
  "text.create", "text.content_set", "text.character_style_set", "text.paragraph_style_set",
  "text.warp_style_set", "text.convert", "image.resize",
  "action.play",
  "verified.batchplay"
]);

const CORE_EXPANSION_COMMANDS = Object.freeze([
  "document.open_default", "document.duplicate", "document.resize_canvas", "document.rotate", "document.color_mode_set",
  "document.bits_per_channel_set", "document.profile_convert",
  "layer.group_create", "layer.visibility_set", "layer.opacity_set",
  "selection.invert", "selection.rectangle", "text.create", "text.content_set",
  "document.metadata_summary_get"
]);

const SECOND_DOM_COMMANDS = Object.freeze([
  "selection.ellipse", "selection.expand", "selection.contract",
  "selection.feather", "selection.border", "layer.clipping_set",
  "layer.blend_mode_set", "layer.fill_opacity_set", "layer.locked_set",
  "filter.gaussian_blur", "filter.sharpen", "filter.add_noise"
]);

const DISTORT_RENDER_COMMANDS = Object.freeze([
  "filter.pinch", "filter.polar_coordinates", "filter.ripple", "filter.spherize",
  "filter.twirl", "filter.zigzag", "filter.ocean_ripple", "filter.diffuse_glow",
  "filter.clouds", "filter.difference_clouds"
]);

const TEXT_DOM_COMMANDS = Object.freeze([
  "text.character_style_set", "text.paragraph_style_set", "text.warp_style_set", "text.convert"
]);

const CHANNEL_PATH_COMMANDS = Object.freeze([
  "channel.list", "channel.create", "channel.duplicate", "channel.delete",
  "channel.calculations_new", "layer.apply_image",
  "path.list", "path.create", "path.geometry_get", "path.select", "path.duplicate", "path.delete"
]);

const THIRD_DOM_COMMANDS = Object.freeze([
  "selection.polygon", "selection.grow", "selection.smooth",
  "path.create_from_selection", "path.make_selection", "action.list"
]);

const LAYER_COMP_COMMANDS = Object.freeze([
  "layer_comp.list", "layer_comp.create", "layer_comp.apply", "layer_comp.duplicate",
  "layer_comp.recapture", "layer_comp.reset", "layer_comp.delete"
]);

const ACTION_COMMANDS = Object.freeze(["action.play"]);

const LAYER_TRANSFORM_COMMANDS = Object.freeze(["layer.translate", "layer.scale", "layer.rotate"]);

const PUBLIC_CONTROL_COMMANDS = Object.freeze([
  "document.artboard_list", "layer.kind_inspect", "mask.properties_get", "mask.properties_set",
  "history.state_list", "history.state_activate"
]);

const EXPERIMENTAL_AI_COMMANDS = Object.freeze([
  "generative.upscale"
]);

const BLEND_MODES = Object.freeze({
  normal: "NORMAL", dissolve: "DISSOLVE", darken: "DARKEN", multiply: "MULTIPLY",
  color_burn: "COLORBURN", linear_burn: "LINEARBURN", darker_color: "DARKERCOLOR",
  lighten: "LIGHTEN", screen: "SCREEN", color_dodge: "COLORDODGE",
  linear_dodge: "LINEARDODGE", lighter_color: "LIGHTERCOLOR", overlay: "OVERLAY",
  soft_light: "SOFTLIGHT", hard_light: "HARDLIGHT", vivid_light: "VIVIDLIGHT",
  linear_light: "LINEARLIGHT", pin_light: "PINLIGHT", hard_mix: "HARDMIX",
  difference: "DIFFERENCE", exclusion: "EXCLUSION", subtract: "SUBTRACT",
  divide: "DIVIDE", hue: "HUE", saturation: "SATURATION", color: "COLOR",
  luminosity: "LUMINOSITY"
});

const NOISE_DISTRIBUTIONS = Object.freeze({ uniform: "UNIFORM", gaussian: "GAUSSIAN" });

const CHANNEL_CALCULATION_BLEND_MODES = Object.freeze({
  normal: "NORMAL", multiply: "MULTIPLY", screen: "SCREEN",
  darken: "DARKEN", lighten: "LIGHTEN", difference: "DIFFERENCE"
});

const DOCUMENT_COLOR_MODES = Object.freeze({
  rgb: "RGB", cmyk: "CMYK", grayscale: "GRAYSCALE", lab: "LAB", multichannel: "MULTICHANNEL"
});
const BITS_PER_CHANNEL_TYPES = Object.freeze({ 8: "EIGHT", 16: "SIXTEEN", 32: "THIRTYTWO" });
const PROFILE_INTENTS = Object.freeze({
  absolute_colorimetric: "ABSOLUTECOLORIMETRIC", perceptual: "PERCEPTUAL",
  relative_colorimetric: "RELATIVECOLORIMETRIC", saturation: "SATURATION"
});
const POLAR_CONVERSIONS = Object.freeze({ polar_to_rectangular: "POLARTORECTANGULAR", rectangular_to_polar: "RECTANGULARTOPOLAR" });
const RIPPLE_SIZES = Object.freeze({ small: "SMALL", medium: "MEDIUM", large: "LARGE" });
const SPHERIZE_MODES = Object.freeze({ normal: "NORMAL", horizontal: "HORIZONTAL", vertical: "VERTICAL" });
const ZIGZAG_STYLES = Object.freeze({ around_center: "AROUNDCENTER", out_from_center: "OUTFROMCENTER", pond_ripples: "PONDRIPPLES" });
const PATH_POINT_KINDS = Object.freeze({ corner: "CORNERPOINT", smooth: "SMOOTHPOINT" });
const PATH_SHAPE_OPERATIONS = Object.freeze({ add: "SHAPEADD", subtract: "SHAPESUBTRACT", intersect: "SHAPEINTERSECT", xor: "SHAPEXOR" });
const TEXT_JUSTIFICATIONS = Object.freeze({
  left: "LEFT", center: "CENTER", right: "RIGHT", left_justified: "LEFTJUSTIFIED",
  center_justified: "CENTERJUSTIFIED", right_justified: "RIGHTJUSTIFIED", fully_justified: "FULLYJUSTIFIED"
});
const TEXT_WARP_STYLES = Object.freeze({
  none: "NONE", arc: "ARC", arc_lower: "ARCLOWER", arc_upper: "ARCUPPER", arch: "ARCH",
  bulge: "BULGE", shell_lower: "SHELLLOWER", shell_upper: "SHELLUPPER", flag: "FLAG",
  wave: "WAVE", fish: "FISH", rise: "RISE", fisheye: "FISHEYE", inflate: "INFLATE",
  squeeze: "SQUEEZE", twist: "TWIST"
});
const TEXT_WARP_DIRECTIONS = Object.freeze({ horizontal: "HORIZONTAL", vertical: "VERTICAL" });

const CANVAS_ANCHORS = Object.freeze({
  top_left: "TOPLEFT", top_center: "TOPCENTER", top_right: "TOPRIGHT",
  middle_left: "MIDDLELEFT", middle_center: "MIDDLECENTER", middle_right: "MIDDLERIGHT",
  bottom_left: "BOTTOMLEFT", bottom_center: "BOTTOMCENTER", bottom_right: "BOTTOMRIGHT"
});

const INTERPOLATION_METHODS = Object.freeze({
  automatic: "AUTOMATIC", bicubic: "BICUBIC", bicubic_sharper: "BICUBICSHARPER",
  bicubic_smoother: "BICUBICSMOOTHER", bilinear: "BILINEAR", nearest_neighbor: "NEARESTNEIGHBOR"
});

const CORE_ALLOWED_ARGS = Object.freeze({
  "document.open_default": ["file_name"],
  "document.duplicate": ["name", "merge_layers_only"],
  "document.resize_canvas": ["width", "height", "anchor"],
  "document.rotate": ["angle"],
  "document.color_mode_set": ["mode"],
  "document.bits_per_channel_set": ["bits"],
  "document.profile_convert": ["destination_profile", "intent", "black_point_compensation", "dither"],
  "document.artboard_list": [],
  "layer.kind_inspect": [],
  "mask.properties_get": [],
  "mask.properties_set": ["layer_mask_density", "layer_mask_feather", "vector_mask_density", "vector_mask_feather"],
  "history.state_list": [],
  "history.state_activate": ["index", "name"],
  "document.metadata_summary_get": [],
  "layer.group_create": ["name"],
  "layer.visibility_set": ["visible"],
  "layer.opacity_set": ["opacity"],
  "layer.translate": ["horizontal", "vertical", "unit"],
  "layer.scale": ["width_percent", "height_percent", "anchor", "interpolation"],
  "layer.rotate": ["angle", "anchor", "interpolation"],
  "selection.invert": [],
  "selection.rectangle": ["left", "top", "right", "bottom", "feather", "anti_alias"],
  "text.create": ["content", "name"],
  "text.content_set": ["content"],
  "text.character_style_set": ["size", "leading", "tracking", "faux_bold", "faux_italic", "horizontal_scale", "vertical_scale", "use_auto_leading"],
  "text.paragraph_style_set": ["justification", "hyphenation", "first_line_indent", "left_indent", "right_indent", "space_before", "space_after"],
  "text.warp_style_set": ["style", "bend", "direction", "horizontal_distortion", "vertical_distortion"],
  "text.convert": ["operation"],
  "selection.ellipse": ["left", "top", "right", "bottom", "feather", "anti_alias"],
  "selection.expand": ["by", "apply_at_canvas_bounds"],
  "selection.contract": ["by", "apply_at_canvas_bounds"],
  "selection.feather": ["by", "apply_at_canvas_bounds"],
  "selection.border": ["width"],
  "layer.clipping_set": ["clipping"],
  "layer.blend_mode_set": ["blend_mode"],
  "layer.fill_opacity_set": ["fill_opacity"],
  "layer.locked_set": ["locked"],
  "filter.gaussian_blur": ["radius"],
  "filter.sharpen": [],
  "filter.add_noise": ["amount", "distribution", "monochromatic"],
  "filter.pinch": ["amount"],
  "filter.polar_coordinates": ["conversion"],
  "filter.ripple": ["amount", "size"],
  "filter.spherize": ["amount", "mode"],
  "filter.twirl": ["angle"],
  "filter.zigzag": ["amount", "ridges", "style"],
  "filter.ocean_ripple": ["size", "magnitude"],
  "filter.diffuse_glow": ["graininess", "glow_amount", "clear_amount"],
  "filter.clouds": [],
  "filter.difference_clouds": [],
  "channel.list": [],
  "channel.create": ["name"],
  "channel.duplicate": ["name"],
  "channel.delete": ["name"],
  "channel.calculations_new": ["blending", "opacity", "source1_invert", "source2_invert"],
  "layer.apply_image": ["blending", "opacity", "invert_source", "preserve_transparency"],
  "path.list": [],
  "path.create": ["name", "subpaths"],
  "path.geometry_get": ["name"],
  "path.create_from_selection": ["name", "tolerance"],
  "path.select": ["name"],
  "path.duplicate": ["name", "new_name"],
  "path.delete": ["name"],
  "selection.polygon": ["points", "feather", "anti_alias"],
  "selection.grow": ["tolerance", "anti_alias"],
  "selection.smooth": ["radius", "apply_at_canvas_bounds"],
  "path.make_selection": ["name", "feather", "anti_alias"],
  "action.list": [],
  "action.play": ["set_name", "action_name"],
  "layer_comp.list": [],
  "layer_comp.create": ["name", "comment", "visibility", "position", "appearance", "child_comp"],
  "layer_comp.apply": ["name"],
  "layer_comp.duplicate": ["name", "new_name"],
  "layer_comp.recapture": ["name"],
  "layer_comp.reset": ["name"],
  "layer_comp.delete": ["name"],
  "generative.upscale": ["scale"]
});

const VERIFIED_ACTIONS = Object.freeze({
  "selection.select_all.v1": () => [{
    _obj: "set",
    _target: [{ _ref: "channel", _property: "selection" }],
    to: { _enum: "ordinal", _value: "allEnum" },
    _options: { dialogOptions: "dontDisplay" }
  }],
  "selection.deselect.v1": () => [{
    _obj: "set",
    _target: [{ _ref: "channel", _property: "selection" }],
    to: { _enum: "ordinal", _value: "none" },
    _options: { dialogOptions: "dontDisplay" }
  }]
});

function activeDocument() { return targets.currentDocument(); }
function activeLayer() { return targets.currentLayer(); }

function activeTextItem() {
  const layer = activeLayer();
  let textItem = null;
  try { textItem = layer.textItem; } catch (_) {}
  if (!textItem || typeof textItem !== "object") throw new PluginError("PRECONDITION_FAILED", "The active layer is not a text layer");
  return { layer, textItem };
}

function compactLayer(layer) {
  const value = { id: layer.id, name: layer.name, kind: String(layer.kind), visible: layer.visible, locked: layer.locked, opacity: Number(layer.opacity) };
  try { if (layer.textItem) value.text = layer.textItem.contents; } catch (_) {}
  return value;
}

function compactChannel(channel) {
  const safe = (read) => { try { return read(); } catch (_) { return null; } };
  return {
    name: String(safe(() => channel.name) ?? ""),
    kind: String(safe(() => channel.kind) ?? "unknown"),
    visible: safe(() => Boolean(channel.visible)),
    opacity: safe(() => Number(channel.opacity))
  };
}

function compactPath(pathItem) {
  return {
    id: Number(pathItem.id),
    documentId: Number(pathItem.docId),
    name: String(pathItem.name),
    kind: String(pathItem.kind),
    subPathCount: pathItem.subPathItems ? Number(pathItem.subPathItems.length) : 0
  };
}

function compactActionTree(actionSets) {
  return Array.from(actionSets).map((set) => ({
    id: Number(set.id),
    index: Number(set.index),
    name: String(set.name),
    actions: Array.from(set.actions || []).map((item) => ({
      id: Number(item.id),
      index: Number(item.index),
      name: String(item.name)
    }))
  }));
}

function namedAction(setName, actionName) {
  const sets = Array.from(app.actionTree || []);
  const matchingSets = sets.filter((item) => String(item.name) === setName);
  if (matchingSets.length > 1) throw new PluginError("PRECONDITION_FAILED", `Action set name is ambiguous: ${setName}`);
  const set = matchingSets[0];
  if (!set) throw new PluginError("PRECONDITION_FAILED", `Action set not found: ${setName}`);
  const matches = Array.from(set.actions || []).filter((actionItem) => String(actionItem.name) === actionName);
  if (matches.length > 1) throw new PluginError("PRECONDITION_FAILED", `Action name is ambiguous: ${actionName}`);
  const item = matches[0];
  if (!item) throw new PluginError("PRECONDITION_FAILED", `Action not found: ${setName} / ${actionName}`);
  return { set, item };
}

function compactLayerComp(comp) {
  return {
    id: Number(comp.id),
    documentId: Number(comp.docId),
    name: String(comp.name),
    comment: String(comp.comment || ""),
    selected: Boolean(comp.selected),
    visibility: Boolean(comp.visibility),
    position: Boolean(comp.position),
    appearance: Boolean(comp.appearance),
    childComp: Boolean(comp.childComp)
  };
}

function namedLayerComp(name) {
  const collection = activeDocument().layerComps;
  if (!collection) throw new PluginError("UNVERIFIED", "Document.layerComps is unavailable in this Photoshop runtime");
  let matches = [];
  if (typeof collection.getAllByName === "function") matches = collection.getAllByName(name) || [];
  else matches = Array.from(collection).filter((item) => String(item.name) === name);
  if (!matches.length) throw new PluginError("PRECONDITION_FAILED", `Layer comp not found: ${name}`);
  if (matches.length !== 1) throw new PluginError("PRECONDITION_FAILED", `Layer comp name is ambiguous: ${name}`);
  return matches[0];
}

function namedCollectionItem(collection, name, label) {
  if (!collection) throw new PluginError("UNVERIFIED", `${label} collection is unavailable in this Photoshop runtime`);
  const getByName = requireMethod(collection, "getByName", `${label}.getByName`);
  let item;
  try { item = getByName(name); } catch (_) { item = null; }
  if (!item) throw new PluginError("PRECONDITION_FAILED", `${label} not found: ${name}`);
  return item;
}

function compactDocument(doc) {
  return {
    id: doc.id,
    title: doc.title,
    width: Number(doc.width),
    height: Number(doc.height),
    resolution: Number(doc.resolution),
    mode: String(doc.mode),
    saved: Boolean(doc.saved),
    activeLayers: (doc.activeLayers || []).map(compactLayer),
    layerCount: doc.layers ? doc.layers.length : 0
  };
}

function probeMember(owner, name, expectedType) {
  if (!owner) return null;
  try {
    const actualType = typeof owner[name];
    return expectedType ? actualType === expectedType : actualType !== "undefined";
  } catch (_) {
    return false;
  }
}

async function hostDescribe() {
  let hostInfo = {};
  let uxpVersions = {};
  try {
    const uxp = require("uxp");
    hostInfo = {
      name: uxp.host && uxp.host.name,
      version: uxp.host && uxp.host.version,
      uiLocale: uxp.host && uxp.host.uiLocale
    };
    uxpVersions = {
      uxp: uxp.versions && uxp.versions.uxp,
      plugin: uxp.versions && uxp.versions.plugin
    };
  } catch (_) {}
  const doc = app.activeDocument;
  const saveAs = doc && doc.saveAs;
  const selection = doc && doc.selection;
  const layer = doc && doc.activeLayers && doc.activeLayers.length ? doc.activeLayers[0] : null;
  let textItem = null;
  let characterStyle = null;
  let paragraphStyle = null;
  let warpStyle = null;
  try {
    textItem = layer && layer.textItem || null;
    characterStyle = textItem && textItem.characterStyle || null;
    paragraphStyle = textItem && textItem.paragraphStyle || null;
    warpStyle = textItem && textItem.warpStyle || null;
  } catch (_) {}
  return {
    app: "Photoshop",
    appVersion: hostInfo.version || app.version || null,
    locale: hostInfo.uiLocale || null,
    uxp: uxpVersions,
    apiVersion: 2,
    pluginVersion: "2.0.1",
    protocol: "ps-mcp-bridge/3",
    executeAsModal: typeof core.executeAsModal === "function",
    runtimeProbes: {
      app: {
        documentsAdd: Boolean(app.documents && typeof app.documents.add === "function"),
        createDocument: typeof app.createDocument === "function",
        open: probeMember(app, "open", "function")
      },
      action: { batchPlay: typeof action.batchPlay === "function" },
      core: { executeAsModal: typeof core.executeAsModal === "function" },
      imaging: {
        getPixels: Boolean(imaging && typeof imaging.getPixels === "function"),
        encodeImageData: Boolean(imaging && typeof imaging.encodeImageData === "function"),
        getLayerMask: Boolean(imaging && typeof imaging.getLayerMask === "function"),
        putLayerMask: Boolean(imaging && typeof imaging.putLayerMask === "function"),
        createLayerMask: false,
        deleteLayerMask: false
      },
      document: {
        probed: Boolean(doc),
        save: doc ? typeof doc.save === "function" : null,
        closeWithoutSaving: doc ? typeof doc.closeWithoutSaving === "function" : null,
        generativeUpscale: probeMember(doc, "generativeUpscale", "function"),
        saveAs: doc ? {
          png: Boolean(saveAs && typeof saveAs.png === "function"),
          jpg: Boolean(saveAs && typeof saveAs.jpg === "function"),
          psd: Boolean(saveAs && typeof saveAs.psd === "function")
        } : null
      },
      selection: {
        probed: Boolean(selection),
        selectEllipse: probeMember(selection, "selectEllipse", "function"),
        expand: probeMember(selection, "expand", "function"),
        contract: probeMember(selection, "contract", "function"),
        feather: probeMember(selection, "feather", "function"),
        selectBorder: probeMember(selection, "selectBorder", "function"),
        selectPolygon: probeMember(selection, "selectPolygon", "function"),
        grow: probeMember(selection, "grow", "function"),
        smooth: probeMember(selection, "smooth", "function")
      },
      layer: {
        probed: Boolean(layer),
        isClippingMask: probeMember(layer, "isClippingMask"),
        blendMode: probeMember(layer, "blendMode"),
        fillOpacity: probeMember(layer, "fillOpacity"),
        allLocked: probeMember(layer, "allLocked"),
        applyGaussianBlur: probeMember(layer, "applyGaussianBlur", "function"),
        applySharpen: probeMember(layer, "applySharpen", "function"),
        applyAddNoise: probeMember(layer, "applyAddNoise", "function"),
        applyPinch: probeMember(layer, "applyPinch", "function"),
        applyPolarCoordinates: probeMember(layer, "applyPolarCoordinates", "function"),
        applyRipple: probeMember(layer, "applyRipple", "function"),
        applySpherize: probeMember(layer, "applySpherize", "function"),
        applyTwirl: probeMember(layer, "applyTwirl", "function"),
        applyZigZag: probeMember(layer, "applyZigZag", "function"),
        applyOceanRipple: probeMember(layer, "applyOceanRipple", "function"),
        applyDiffuseGlow: probeMember(layer, "applyDiffuseGlow", "function"),
        applyClouds: probeMember(layer, "applyClouds", "function"),
        applyDifferenceClouds: probeMember(layer, "applyDifferenceClouds", "function")
      },
      text: {
        probed: Boolean(textItem),
        characterStyle: {
          probed: Boolean(characterStyle),
          size: probeMember(characterStyle, "size"),
          leading: probeMember(characterStyle, "leading"),
          tracking: probeMember(characterStyle, "tracking"),
          fauxBold: probeMember(characterStyle, "fauxBold"),
          fauxItalic: probeMember(characterStyle, "fauxItalic")
        },
        paragraphStyle: {
          probed: Boolean(paragraphStyle),
          justification: probeMember(paragraphStyle, "justification"),
          hyphenation: probeMember(paragraphStyle, "hyphenation"),
          firstLineIndent: probeMember(paragraphStyle, "firstLineIndent"),
          leftIndent: probeMember(paragraphStyle, "leftIndent"),
          rightIndent: probeMember(paragraphStyle, "rightIndent"),
          spaceBefore: probeMember(paragraphStyle, "spaceBefore"),
          spaceAfter: probeMember(paragraphStyle, "spaceAfter")
        },
        warpStyle: {
          probed: Boolean(warpStyle),
          style: probeMember(warpStyle, "style"),
          bend: probeMember(warpStyle, "bend"),
          direction: probeMember(warpStyle, "direction"),
          horizontalDistortion: probeMember(warpStyle, "horizontalDistortion"),
          verticalDistortion: probeMember(warpStyle, "verticalDistortion")
        },
        convertToParagraphText: probeMember(textItem, "convertToParagraphText", "function"),
        convertToPointText: probeMember(textItem, "convertToPointText", "function"),
        convertToShape: probeMember(textItem, "convertToShape", "function"),
        createWorkPath: probeMember(textItem, "createWorkPath", "function")
      },
      channels: {
        probed: Boolean(doc),
        collection: probeMember(doc, "channels"),
        componentCollection: probeMember(doc, "componentChannels")
      },
      paths: {
        probed: Boolean(doc),
        collection: probeMember(doc, "pathItems"),
        add: doc && doc.pathItems ? probeMember(doc.pathItems, "add", "function") : null,
        PathPointInfo: typeof app.PathPointInfo === "function",
        SubPathInfo: typeof app.SubPathInfo === "function"
      },
      actions: {
        actionTree: probeMember(app, "actionTree")
      },
      layerComps: {
        probed: Boolean(doc),
        collection: probeMember(doc, "layerComps"),
        add: doc && doc.layerComps ? probeMember(doc.layerComps, "add", "function") : null
      },
      network: {
        online: typeof navigator !== "undefined" && typeof navigator.onLine === "boolean" ? navigator.onLine : null
      }
    },
    gatedCapabilities: {
      generative: {
        status: probeMember(doc, "generativeUpscale", "function") ? "api_exposed" : "unavailable",
        available: probeMember(doc, "generativeUpscale", "function") === true,
        fill: { status: "unavailable", reason: "No public DOM and no Photoshop 27.9 Action Recorder fixture" },
        upscale: { status: probeMember(doc, "generativeUpscale", "function") ? "api_exposed" : "unavailable" }
      },
      neuralFilters: { status: "unavailable", available: false, reason: "No Photoshop 27.9 Action Recorder fixture" },
      entitlement: { status: "not_publicly_probeable", available: false },
      credits: { status: "not_publicly_probeable", available: false }
    }
  };
}

async function stateGet(payload = {}) {
  const safe = (read, fallback = null) => {
    try { return read(); } catch (_) { return fallback; }
  };
  let doc;
  try { doc = payload.target ? targets.resolveTarget(payload.target).document : activeDocument(); }
  catch (error) { if (!payload.allowMissing && payload.target) throw error; doc = null; }
  const activeLayers = doc ? safe(() => Array.from(doc.activeLayers || []), []) : [];
  const layer = activeLayers.length ? safe(() => compactLayer(activeLayers[0])) : null;
  let selectionBounds = null;
  if (doc && doc.selection) {
    try {
      const bounds = doc.selection.bounds;
      if (bounds) {
        selectionBounds = {
          left: Number(bounds.left),
          top: Number(bounds.top),
          right: Number(bounds.right),
          bottom: Number(bounds.bottom)
        };
      }
    } catch (_) {
      selectionBounds = null;
    }
  }
  const channels = doc ? safe(() => Array.from(doc.channels || []), []) : [];
  const activeChannels = doc ? safe(() => Array.from(doc.activeChannels || []), channels) : [];
  const pathCount = doc ? safe(() => Number(doc.pathItems && doc.pathItems.length || 0), 0) : 0;
  const exportFolderConfigured = Boolean(await getExportFolder().catch(() => null));
  return {
    hostEpoch: targets.hostEpoch,
    documentCount: safe(() => Number(app.documents.length), 0),
    hasDocument: Boolean(doc),
    activeDocument: doc ? safe(() => compactDocument(doc)) : null,
    activeLayer: layer,
    hasSelection: Boolean(selectionBounds),
    selection: selectionBounds ? { bounds: selectionBounds } : null,
    activeChannels: activeChannels.map((channel) => safe(() => compactChannel(channel))).filter(Boolean),
    channelCount: channels.length,
    pathCount,
    exportFolderConfigured,
    foregroundColor: safe(() => app.foregroundColor ? { typename: app.foregroundColor.typename || "SolidColor" } : null),
    backgroundColor: safe(() => app.backgroundColor ? { typename: app.backgroundColor.typename || "SolidColor" } : null)
  };
}

async function previewGet(payload = {}) {
  return { preview: await evidenceImaging.capture(payload) };
}

async function batchPlay(descriptors, dialog = "dontDisplay") {
  if (!Array.isArray(descriptors) || !descriptors.length) throw new PluginError("PRECONDITION_FAILED", "batchPlay descriptors must be a non-empty array");
  const safe = descriptors.map((item) => ({ ...item, _options: { ...(item._options || {}), dialogOptions: dialog } }));
  const results = await action.batchPlay(safe, { synchronousExecution: false });
  if (!Array.isArray(results) || results.length !== safe.length) throw new PluginError("HOST_ERROR", "batchPlay returned an incomplete result array", { effect: "unknown" });
  const failed = results.findIndex((entry) => entry && (entry._obj === "error" || (typeof entry.result === "number" && entry.result < 0)));
  if (failed >= 0) throw new PluginError("HOST_ERROR", results[failed].message || `batchPlay descriptor ${failed} failed`, { descriptorIndex: failed, hostResult: results[failed], effect: failed === 0 ? "unknown" : "partial" });
  return results;
}

function validateFileName(name) {
  if (!name || typeof name !== "string" || /[\\/:*?"<>|]/.test(name) || name === "." || name === "..") {
    throw new PluginError("PRECONDITION_FAILED", "A safe fileName is required");
  }
  return name;
}

function requireFinite(value, name, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new PluginError("PRECONDITION_FAILED", `${name} must be a finite number from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireString(value, name, allowEmpty = false, maximum = 100000) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum) {
    throw new PluginError("PRECONDITION_FAILED", `${name} must be ${allowEmpty ? "a" : "a non-empty"} string no longer than ${maximum} characters`);
  }
  return value;
}

function validateUserAssistedArgs(commandId, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new PluginError("PRECONDITION_FAILED", "args must be an object");
  const allowed = commandId === "document.save" ? ["as_copy"] : [];
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown) throw new PluginError("PRECONDITION_FAILED", `Unknown argument for ${commandId}: ${unknown}`);
  if (commandId === "document.save" && args.as_copy !== undefined && typeof args.as_copy !== "boolean") throw new PluginError("PRECONDITION_FAILED", "as_copy must be boolean");
}

function validateCoreArgs(commandId, args = {}) {
  if (!CORE_EXPANSION_COMMANDS.includes(commandId) && !SECOND_DOM_COMMANDS.includes(commandId) && !DISTORT_RENDER_COMMANDS.includes(commandId) && !TEXT_DOM_COMMANDS.includes(commandId) && !CHANNEL_PATH_COMMANDS.includes(commandId) && !THIRD_DOM_COMMANDS.includes(commandId) && !LAYER_COMP_COMMANDS.includes(commandId) && !ACTION_COMMANDS.includes(commandId) && !LAYER_TRANSFORM_COMMANDS.includes(commandId) && !PUBLIC_CONTROL_COMMANDS.includes(commandId) && !EXPERIMENTAL_AI_COMMANDS.includes(commandId)) return;
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new PluginError("PRECONDITION_FAILED", "args must be an object");
  const allowed = CORE_ALLOWED_ARGS[commandId];
  const unknown = Object.keys(args).find((key) => !allowed.includes(key));
  if (unknown) throw new PluginError("PRECONDITION_FAILED", `Unknown argument for ${commandId}: ${unknown}`);
  if (args.name !== undefined) requireString(args.name, "name", false, 255);
  switch (commandId) {
    case "document.open_default": {
      const fileName = requireString(args.file_name, "file_name", false, 255);
      if (/[\\/:*?"<>|\u0000-\u001F\u007F]/.test(fileName) || fileName === "." || fileName === "..") {
        throw new PluginError("PRECONDITION_FAILED", "file_name must be a safe basename");
      }
      const extensionIndex = fileName.lastIndexOf(".");
      const extension = extensionIndex >= 0 ? fileName.slice(extensionIndex).toLowerCase() : "";
      if (![".psd", ".psb", ".png", ".jpg", ".jpeg", ".tif", ".tiff"].includes(extension)) {
        throw new PluginError("PRECONDITION_FAILED", "file_name extension is not allowed");
      }
      break;
    }
    case "document.duplicate":
      if (args.merge_layers_only !== undefined && typeof args.merge_layers_only !== "boolean") throw new PluginError("PRECONDITION_FAILED", "merge_layers_only must be boolean");
      break;
    case "document.resize_canvas":
      requireFinite(args.width, "width", 1, 300000);
      requireFinite(args.height, "height", 1, 300000);
      if (!Number.isInteger(args.width) || !Number.isInteger(args.height)) throw new PluginError("PRECONDITION_FAILED", "width and height must be integers");
      if (args.anchor !== undefined && !Object.prototype.hasOwnProperty.call(CANVAS_ANCHORS, args.anchor)) throw new PluginError("PRECONDITION_FAILED", "anchor is invalid");
      break;
    case "document.rotate":
      requireFinite(args.angle, "angle", -359.999, 359.999);
      if (args.angle === 0) throw new PluginError("PRECONDITION_FAILED", "angle must be non-zero");
      break;
    case "document.color_mode_set":
      if (typeof args.mode !== "string" || !Object.prototype.hasOwnProperty.call(DOCUMENT_COLOR_MODES, args.mode)) throw new PluginError("PRECONDITION_FAILED", "mode is invalid");
      break;
    case "document.bits_per_channel_set":
      if (!Number.isInteger(args.bits) || !Object.prototype.hasOwnProperty.call(BITS_PER_CHANNEL_TYPES, args.bits)) throw new PluginError("PRECONDITION_FAILED", "bits must be 8, 16 or 32");
      break;
    case "document.profile_convert":
      requireString(args.destination_profile, "destination_profile", false, 255);
      if (/[\u0000-\u001F\u007F]/.test(args.destination_profile)) throw new PluginError("PRECONDITION_FAILED", "destination_profile must not contain control characters");
      if (typeof args.intent !== "string" || !Object.prototype.hasOwnProperty.call(PROFILE_INTENTS, args.intent)) throw new PluginError("PRECONDITION_FAILED", "intent is invalid");
      if (args.black_point_compensation !== undefined && typeof args.black_point_compensation !== "boolean") throw new PluginError("PRECONDITION_FAILED", "black_point_compensation must be boolean");
      if (args.dither !== undefined && typeof args.dither !== "boolean") throw new PluginError("PRECONDITION_FAILED", "dither must be boolean");
      break;
    case "mask.properties_set": {
      const fields = ["layer_mask_density", "layer_mask_feather", "vector_mask_density", "vector_mask_feather"];
      if (!fields.some((field) => args[field] !== undefined)) throw new PluginError("PRECONDITION_FAILED", "At least one mask property is required");
      for (const field of ["layer_mask_density", "vector_mask_density"]) if (args[field] !== undefined) requireFinite(args[field], field, 0, 100);
      for (const field of ["layer_mask_feather", "vector_mask_feather"]) if (args[field] !== undefined) requireFinite(args[field], field, 0, 1000);
      break;
    }
    case "history.state_activate": {
      const selectors = [args.index !== undefined, args.name !== undefined].filter(Boolean).length;
      if (selectors !== 1) throw new PluginError("PRECONDITION_FAILED", "Exactly one of index or name is required");
      if (args.index !== undefined && (!Number.isInteger(args.index) || args.index < 0 || args.index > 100000)) throw new PluginError("PRECONDITION_FAILED", "index must be a non-negative integer");
      if (args.name !== undefined) requireString(args.name, "name", false, 255);
      break;
    }
    case "layer.visibility_set":
      if (typeof args.visible !== "boolean") throw new PluginError("PRECONDITION_FAILED", "visible must be boolean");
      break;
    case "layer.opacity_set": requireFinite(args.opacity, "opacity", 0, 100); break;
    case "layer.translate":
      requireFinite(args.horizontal, "horizontal", -300000, 300000);
      requireFinite(args.vertical, "vertical", -300000, 300000);
      if (args.unit !== undefined && args.unit !== "pixels" && args.unit !== "percent") throw new PluginError("PRECONDITION_FAILED", "unit must be pixels or percent");
      break;
    case "layer.scale":
      requireFinite(args.width_percent, "width_percent", 0.1, 10000);
      requireFinite(args.height_percent, "height_percent", 0.1, 10000);
      if (args.anchor !== undefined && !Object.prototype.hasOwnProperty.call(CANVAS_ANCHORS, args.anchor)) throw new PluginError("PRECONDITION_FAILED", "anchor is invalid");
      if (args.interpolation !== undefined && !Object.prototype.hasOwnProperty.call(INTERPOLATION_METHODS, args.interpolation)) throw new PluginError("PRECONDITION_FAILED", "interpolation is invalid");
      break;
    case "layer.rotate":
      requireFinite(args.angle, "angle", -359.999, 359.999);
      if (args.angle === 0) throw new PluginError("PRECONDITION_FAILED", "angle must be non-zero");
      if (args.anchor !== undefined && !Object.prototype.hasOwnProperty.call(CANVAS_ANCHORS, args.anchor)) throw new PluginError("PRECONDITION_FAILED", "anchor is invalid");
      if (args.interpolation !== undefined && !Object.prototype.hasOwnProperty.call(INTERPOLATION_METHODS, args.interpolation)) throw new PluginError("PRECONDITION_FAILED", "interpolation is invalid");
      break;
    case "selection.rectangle":
    case "selection.ellipse": {
      const left = requireFinite(args.left, "left", 0, 300000);
      const top = requireFinite(args.top, "top", 0, 300000);
      const right = requireFinite(args.right, "right", 0, 300000);
      const bottom = requireFinite(args.bottom, "bottom", 0, 300000);
      if (right <= left || bottom <= top) throw new PluginError("PRECONDITION_FAILED", "right/bottom must be greater than left/top");
      if (args.feather !== undefined) requireFinite(args.feather, "feather", 0, 1000);
      if (args.anti_alias !== undefined && typeof args.anti_alias !== "boolean") throw new PluginError("PRECONDITION_FAILED", "anti_alias must be boolean");
      break;
    }
    case "selection.expand":
    case "selection.contract":
      requireFinite(args.by, "by", 1, 500);
      if (!Number.isInteger(args.by)) throw new PluginError("PRECONDITION_FAILED", "by must be an integer");
      if (args.apply_at_canvas_bounds !== undefined && typeof args.apply_at_canvas_bounds !== "boolean") throw new PluginError("PRECONDITION_FAILED", "apply_at_canvas_bounds must be boolean");
      break;
    case "selection.feather":
      requireFinite(args.by, "by", 0.1, 1000);
      if (args.apply_at_canvas_bounds !== undefined && typeof args.apply_at_canvas_bounds !== "boolean") throw new PluginError("PRECONDITION_FAILED", "apply_at_canvas_bounds must be boolean");
      break;
    case "selection.border":
      requireFinite(args.width, "width", 1, 200);
      if (!Number.isInteger(args.width)) throw new PluginError("PRECONDITION_FAILED", "width must be an integer");
      break;
    case "layer.clipping_set":
      if (typeof args.clipping !== "boolean") throw new PluginError("PRECONDITION_FAILED", "clipping must be boolean");
      break;
    case "layer.blend_mode_set":
      if (typeof args.blend_mode !== "string" || !Object.prototype.hasOwnProperty.call(BLEND_MODES, args.blend_mode)) throw new PluginError("PRECONDITION_FAILED", "blend_mode is invalid");
      break;
    case "layer.fill_opacity_set": requireFinite(args.fill_opacity, "fill_opacity", 0, 100); break;
    case "layer.locked_set":
      if (typeof args.locked !== "boolean") throw new PluginError("PRECONDITION_FAILED", "locked must be boolean");
      break;
    case "filter.gaussian_blur": requireFinite(args.radius, "radius", 0.1, 1000); break;
    case "filter.add_noise":
      requireFinite(args.amount, "amount", 0.1, 400);
      if (typeof args.distribution !== "string" || !Object.prototype.hasOwnProperty.call(NOISE_DISTRIBUTIONS, args.distribution)) throw new PluginError("PRECONDITION_FAILED", "distribution is invalid");
      if (typeof args.monochromatic !== "boolean") throw new PluginError("PRECONDITION_FAILED", "monochromatic must be boolean");
      break;
    case "filter.pinch": requireFinite(args.amount, "amount", -100, 100); break;
    case "filter.polar_coordinates":
      if (typeof args.conversion !== "string" || !Object.prototype.hasOwnProperty.call(POLAR_CONVERSIONS, args.conversion)) throw new PluginError("PRECONDITION_FAILED", "conversion is invalid");
      break;
    case "filter.ripple":
      requireFinite(args.amount, "amount", -999, 999);
      if (typeof args.size !== "string" || !Object.prototype.hasOwnProperty.call(RIPPLE_SIZES, args.size)) throw new PluginError("PRECONDITION_FAILED", "size is invalid");
      break;
    case "filter.spherize":
      requireFinite(args.amount, "amount", -100, 100);
      if (typeof args.mode !== "string" || !Object.prototype.hasOwnProperty.call(SPHERIZE_MODES, args.mode)) throw new PluginError("PRECONDITION_FAILED", "mode is invalid");
      break;
    case "filter.twirl": requireFinite(args.angle, "angle", -999, 999); break;
    case "filter.zigzag":
      requireFinite(args.amount, "amount", -100, 100);
      requireFinite(args.ridges, "ridges", 0, 20);
      if (!Number.isInteger(args.ridges)) throw new PluginError("PRECONDITION_FAILED", "ridges must be an integer");
      if (typeof args.style !== "string" || !Object.prototype.hasOwnProperty.call(ZIGZAG_STYLES, args.style)) throw new PluginError("PRECONDITION_FAILED", "style is invalid");
      break;
    case "filter.ocean_ripple":
      requireFinite(args.size, "size", 1, 15);
      requireFinite(args.magnitude, "magnitude", 1, 20);
      if (!Number.isInteger(args.size) || !Number.isInteger(args.magnitude)) throw new PluginError("PRECONDITION_FAILED", "size and magnitude must be integers");
      break;
    case "filter.diffuse_glow":
      requireFinite(args.graininess, "graininess", 0, 10);
      requireFinite(args.glow_amount, "glow_amount", 0, 20);
      requireFinite(args.clear_amount, "clear_amount", 0, 20);
      break;
    case "text.character_style_set":
      if (Object.keys(args).length === 0) throw new PluginError("PRECONDITION_FAILED", "At least one character style property is required");
      if (args.size !== undefined) requireFinite(args.size, "size", 0.01, 1296);
      if (args.leading !== undefined) requireFinite(args.leading, "leading", 0, 4999.99);
      if (args.tracking !== undefined) requireFinite(args.tracking, "tracking", -1000, 1000);
      if (args.horizontal_scale !== undefined) requireFinite(args.horizontal_scale, "horizontal_scale", 0, 1000);
      if (args.vertical_scale !== undefined) requireFinite(args.vertical_scale, "vertical_scale", 0, 1000);
      for (const key of ["faux_bold", "faux_italic", "use_auto_leading"]) {
        if (args[key] !== undefined && typeof args[key] !== "boolean") throw new PluginError("PRECONDITION_FAILED", `${key} must be boolean`);
      }
      break;
    case "text.paragraph_style_set":
      if (Object.keys(args).length === 0) throw new PluginError("PRECONDITION_FAILED", "At least one paragraph style property is required");
      if (args.justification !== undefined && (typeof args.justification !== "string" || !Object.prototype.hasOwnProperty.call(TEXT_JUSTIFICATIONS, args.justification))) throw new PluginError("PRECONDITION_FAILED", "justification is invalid");
      if (args.hyphenation !== undefined && typeof args.hyphenation !== "boolean") throw new PluginError("PRECONDITION_FAILED", "hyphenation must be boolean");
      for (const key of ["first_line_indent", "left_indent", "right_indent", "space_before", "space_after"]) {
        if (args[key] !== undefined) requireFinite(args[key], key, -1296, 1296);
      }
      break;
    case "text.warp_style_set":
      if (Object.keys(args).length === 0) throw new PluginError("PRECONDITION_FAILED", "At least one warp style property is required");
      if (args.style !== undefined && (typeof args.style !== "string" || !Object.prototype.hasOwnProperty.call(TEXT_WARP_STYLES, args.style))) throw new PluginError("PRECONDITION_FAILED", "style is invalid");
      if (args.direction !== undefined && (typeof args.direction !== "string" || !Object.prototype.hasOwnProperty.call(TEXT_WARP_DIRECTIONS, args.direction))) throw new PluginError("PRECONDITION_FAILED", "direction is invalid");
      for (const key of ["bend", "horizontal_distortion", "vertical_distortion"]) {
        if (args[key] !== undefined) requireFinite(args[key], key, -100, 100);
      }
      break;
    case "text.convert":
      if (!["point_to_paragraph", "paragraph_to_point", "to_shape", "create_work_path"].includes(args.operation)) throw new PluginError("PRECONDITION_FAILED", "operation is invalid");
      break;
    case "channel.create":
      if (args.name !== undefined) requireString(args.name, "name", false, 255);
      break;
    case "channel.duplicate":
    case "channel.delete":
    case "path.select":
    case "path.delete":
      requireString(args.name, "name", false, 255);
      break;
    case "channel.calculations_new":
    case "layer.apply_image":
      if (args.blending !== undefined && (typeof args.blending !== "string" || !Object.prototype.hasOwnProperty.call(CHANNEL_CALCULATION_BLEND_MODES, args.blending))) throw new PluginError("PRECONDITION_FAILED", "blending is invalid");
      if (args.opacity !== undefined) requireFinite(args.opacity, "opacity", 0, 100);
      for (const flag of commandId === "channel.calculations_new" ? ["source1_invert", "source2_invert"] : ["invert_source", "preserve_transparency"]) {
        if (args[flag] !== undefined && typeof args[flag] !== "boolean") throw new PluginError("PRECONDITION_FAILED", `${flag} must be boolean`);
      }
      break;
    case "path.duplicate":
      requireString(args.name, "name", false, 255);
      requireString(args.new_name, "new_name", false, 255);
      break;
    case "path.create": {
      requireString(args.name, "name", false, 255);
      if (!Array.isArray(args.subpaths) || args.subpaths.length < 1 || args.subpaths.length > 128) throw new PluginError("PRECONDITION_FAILED", "subpaths must contain 1 to 128 subpaths");
      let totalPoints = 0;
      for (const subpath of args.subpaths) {
        if (!subpath || typeof subpath !== "object" || Array.isArray(subpath) || Object.keys(subpath).some((key) => !["closed", "shape_operation", "points"].includes(key))) throw new PluginError("PRECONDITION_FAILED", "each subpath must contain only closed, shape_operation and points");
        if (typeof subpath.closed !== "boolean") throw new PluginError("PRECONDITION_FAILED", "subpath.closed must be boolean");
        if (typeof subpath.shape_operation !== "string" || !Object.prototype.hasOwnProperty.call(PATH_SHAPE_OPERATIONS, subpath.shape_operation)) throw new PluginError("PRECONDITION_FAILED", "subpath.shape_operation is invalid");
        const minimumPoints = subpath.closed ? 3 : 2;
        if (!Array.isArray(subpath.points) || subpath.points.length < minimumPoints || subpath.points.length > 10000) throw new PluginError("PRECONDITION_FAILED", `subpath.points must contain ${minimumPoints} to 10000 points`);
        totalPoints += subpath.points.length;
        if (totalPoints > 20000) throw new PluginError("PRECONDITION_FAILED", "path geometry must contain no more than 20000 points");
        for (const point of subpath.points) {
          if (!point || typeof point !== "object" || Array.isArray(point) || Object.keys(point).some((key) => !["anchor", "left_direction", "right_direction", "kind"].includes(key))) throw new PluginError("PRECONDITION_FAILED", "each path point must contain only anchor, left_direction, right_direction and kind");
          for (const key of ["anchor", "left_direction", "right_direction"]) {
            const coordinate = point[key];
            if (!Array.isArray(coordinate) || coordinate.length !== 2) throw new PluginError("PRECONDITION_FAILED", `${key} must be an [x, y] coordinate`);
            requireFinite(coordinate[0], `${key}[0]`, -300000, 300000);
            requireFinite(coordinate[1], `${key}[1]`, -300000, 300000);
          }
          if (typeof point.kind !== "string" || !Object.prototype.hasOwnProperty.call(PATH_POINT_KINDS, point.kind)) throw new PluginError("PRECONDITION_FAILED", "point.kind is invalid");
        }
      }
      break;
    }
    case "path.geometry_get":
      requireString(args.name, "name", false, 255);
      break;
    case "path.create_from_selection":
      requireString(args.name, "name", false, 255);
      requireFinite(args.tolerance === undefined ? 2 : args.tolerance, "tolerance", 0.5, 10);
      break;
    case "selection.polygon": {
      if (!Array.isArray(args.points) || args.points.length < 3 || args.points.length > 10000) throw new PluginError("PRECONDITION_FAILED", "points must contain 3 to 10000 points");
      const unique = new Set();
      for (const point of args.points) {
        if (!point || typeof point !== "object" || Array.isArray(point) || Object.keys(point).some((key) => key !== "x" && key !== "y")) throw new PluginError("PRECONDITION_FAILED", "each point must contain only x and y");
        const x = requireFinite(point.x, "point.x", -300000, 300000);
        const y = requireFinite(point.y, "point.y", -300000, 300000);
        unique.add(`${x}:${y}`);
      }
      if (unique.size < 3) throw new PluginError("PRECONDITION_FAILED", "points must contain at least three distinct coordinates");
      if (args.feather !== undefined) requireFinite(args.feather, "feather", 0, 1000);
      if (args.anti_alias !== undefined && typeof args.anti_alias !== "boolean") throw new PluginError("PRECONDITION_FAILED", "anti_alias must be boolean");
      break;
    }
    case "selection.grow":
      requireFinite(args.tolerance, "tolerance", 0, 255);
      if (!Number.isInteger(args.tolerance)) throw new PluginError("PRECONDITION_FAILED", "tolerance must be an integer");
      if (args.anti_alias !== undefined && typeof args.anti_alias !== "boolean") throw new PluginError("PRECONDITION_FAILED", "anti_alias must be boolean");
      break;
    case "selection.smooth":
      requireFinite(args.radius, "radius", 1, 500);
      if (!Number.isInteger(args.radius)) throw new PluginError("PRECONDITION_FAILED", "radius must be an integer");
      if (args.apply_at_canvas_bounds !== undefined && typeof args.apply_at_canvas_bounds !== "boolean") throw new PluginError("PRECONDITION_FAILED", "apply_at_canvas_bounds must be boolean");
      break;
    case "path.make_selection":
      requireString(args.name, "name", false, 255);
      if (args.feather !== undefined) requireFinite(args.feather, "feather", 0, 250);
      if (args.anti_alias !== undefined && typeof args.anti_alias !== "boolean") throw new PluginError("PRECONDITION_FAILED", "anti_alias must be boolean");
      break;
    case "layer_comp.create":
      requireString(args.name, "name", false, 255);
      if (args.comment !== undefined) requireString(args.comment, "comment", true, 1000);
      for (const key of ["visibility", "position", "appearance", "child_comp"]) {
        if (args[key] !== undefined && typeof args[key] !== "boolean") throw new PluginError("PRECONDITION_FAILED", `${key} must be boolean`);
      }
      break;
    case "layer_comp.apply":
    case "layer_comp.recapture":
    case "layer_comp.reset":
    case "layer_comp.delete":
      requireString(args.name, "name", false, 255);
      break;
    case "layer_comp.duplicate":
      requireString(args.name, "name", false, 255);
      requireString(args.new_name, "new_name", false, 255);
      break;
    case "action.play":
      requireString(args.set_name, "set_name", false, 255);
      requireString(args.action_name, "action_name", false, 255);
      break;
    case "generative.upscale":
      if (args.scale !== 2 && args.scale !== 4) throw new PluginError("PRECONDITION_FAILED", "scale must be 2 or 4");
      break;
    case "text.create": requireString(args.content, "content", false); break;
    case "text.content_set": requireString(args.content, "content", true); break;
    default: break;
  }
}

function requireMethod(owner, method, label) {
  if (!owner || typeof owner[method] !== "function") throw new PluginError("UNVERIFIED", `${label} is unavailable in this Photoshop runtime`);
  return owner[method].bind(owner);
}

function requireMember(owner, member, label) {
  if (!probeMember(owner, member)) throw new PluginError("UNVERIFIED", `${label} is unavailable in this Photoshop runtime`);
}

async function withTemporarilyUnlockedLayer(layer, operation) {
  const lockProperties = ["allLocked", "pixelsLocked", "positionLocked", "transparentPixelsLocked"];
  const original = [];
  for (const property of lockProperties) {
    if (probeMember(layer, property)) original.push([property, Boolean(layer[property])]);
  }
  if (!original.length) throw new PluginError("UNVERIFIED", "Layer lock properties are unavailable in this Photoshop runtime");
  try {
    for (const [property] of original) layer[property] = false;
    return await operation();
  } finally {
    for (const [property, value] of original.slice().reverse()) layer[property] = value;
  }
}

function requireMappedConstant(groupName, mapping, value) {
  const constantName = mapping[value];
  const group = constants[groupName];
  const resolved = group && group[constantName];
  if (resolved === undefined) throw new PluginError("UNVERIFIED", `${groupName}.${constantName || value} is unavailable in this Photoshop runtime`);
  return resolved;
}

function outputFileName(args, extension) {
  let name = validateFileName(args.file_name || `photoshop-export-${Date.now()}.${extension}`);
  if (!name.toLowerCase().endsWith(`.${extension}`)) name += `.${extension}`;
  return name;
}

async function resolveOutputEntry(args, extension) {
  if (args.entry_token) {
    if (args.on_conflict !== "overwrite") throw new PluginError("OUTPUT_CONFLICT", "An existing Entry token requires explicit on_conflict=overwrite");
    return resolvePersistentEntry(args.entry_token);
  }
  const folder = await getExportFolder();
  if (!folder) throw new PluginError("PRECONDITION_FAILED", "Choose an export folder in the plugin panel first");
  const name = outputFileName(args, extension);
  const policy = args.on_conflict || "error";
  const existing = await folder.getEntry(name).catch(() => null);
  if (existing && policy === "error") throw new PluginError("OUTPUT_CONFLICT", `File already exists: ${name}`);
  if (existing && policy === "overwrite") {
    if (args.expected_existing_sha256) {
      const bytes = await readEntryBinary(existing);
      const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== args.expected_existing_sha256) throw new PluginError("OUTPUT_CONFLICT", "Existing output differs from expected SHA-256");
    }
    return existing;
  }
  if (!existing) return folder.createFile(name, { overwrite: false });
  const stem = name.slice(0, -(extension.length + 1));
  for (let index = 1; index <= 10000; index++) {
    const candidate = `${stem}-v${index}.${extension}`;
    if (await folder.getEntry(candidate).catch(() => null)) continue;
    try { return await folder.createFile(candidate, { overwrite: false }); }
    catch (error) { if (!await folder.getEntry(candidate).catch(() => null)) throw error; }
  }
  throw new PluginError("OUTPUT_CONFLICT", "No available versioned output filename");
}

async function saveDocumentCopy(doc, entry, format, args) {
  if (format === "png") await doc.saveAs.png(entry, {}, true);
  else if (format === "jpg") await doc.saveAs.jpg(entry, { quality: Math.max(0, Math.min(12, Number(args.quality ?? 10))) }, true);
  else if (format === "psb") await doc.saveAs.psb(entry, { embedColorProfile: true }, true);
  else await doc.saveAs.psd(entry, { embedColorProfile: true }, true);
}

async function executeStable(commandId, args = {}, context = {}) {
  switch (commandId) {
    case "document.create": {
      const options = {
        name: args.name || "MCP Document",
        width: Number(args.width || 1024),
        height: Number(args.height || 1024),
        resolution: Number(args.resolution || 72)
      };
      const create = app.documents && typeof app.documents.add === "function"
        ? app.documents.add.bind(app.documents)
        : requireMethod(app, "createDocument", "Photoshop.createDocument");
      const doc = await create(options);
      return compactDocument(doc);
    }
    case "document.open_default": {
      if (typeof context.downloadImport !== "function") {
        throw new PluginError("PRECONDITION_FAILED", "Authenticated default import transport is unavailable");
      }
      const binary = await context.downloadImport(args.file_name);
      let temporary = null;
      try {
        temporary = await materializeTemporaryImportFile(args.file_name, binary);
        const open = requireMethod(app, "open", "Photoshop.open");
        const doc = await open(temporary);
        return { ...compactDocument(doc), source: "default_export_folder", fileName: args.file_name };
      } finally {
        if (temporary) await deleteEntry(temporary).catch(() => {});
      }
    }
    case "document.close": {
      const doc = activeDocument();
      const documentId = doc.id;
      if (args.save === true) await doc.save();
      else if (args.save !== false) throw new PluginError("PRECONDITION_FAILED", "document.close requires save=true or save=false");
      await doc.closeWithoutSaving();
      return { closedDocumentId: documentId, savedBeforeClose: args.save === true };
    }
    case "document.save": {
      const doc = activeDocument();
      if (args.entry_token) {
        const entry = await resolvePersistentEntry(args.entry_token);
        await doc.saveAs.psd(entry, {}, Boolean(args.as_copy));
      } else {
        await doc.save();
      }
      return compactDocument(doc);
    }
    case "document.export": {
      const doc = activeDocument();
      const format = String(args.format || "png").toLowerCase();
      if (!["png", "jpg", "jpeg", "psd", "psb"].includes(format)) throw new PluginError("UNSUPPORTED", `Unsupported export format: ${format}`);
      const normalized = format === "jpeg" ? "jpg" : format;
      const configuredFolder = args.entry_token ? null : await getExportFolder();
      if (args.entry_token || configuredFolder) {
        const entry = await resolveOutputEntry(args, normalized);
        await saveDocumentCopy(doc, entry, normalized, args);
        return { name: entry.name, format: normalized, destination: "selected_folder" };
      }
      if (typeof context.uploadExport !== "function") {
        throw new PluginError("PRECONDITION_FAILED", "No selected export folder or authenticated default-export bridge is available");
      }
      const name = outputFileName(args, normalized);
      const temporary = await createTemporaryExportFile(name);
      try {
        await saveDocumentCopy(doc, temporary, normalized, args);
        const binary = await readEntryBinary(temporary);
        const uploaded = await context.uploadExport(binary, {
          name,
          format: normalized,
          onConflict: args.on_conflict || "error"
        });
        return { ...uploaded, name, format: normalized, destination: "default_export_folder" };
      } finally {
        await deleteEntry(temporary).catch(() => {});
      }
    }
    case "document.duplicate": {
      const doc = activeDocument();
      const duplicate = requireMethod(doc, "duplicate", "Document.duplicate");
      return compactDocument(await duplicate(args.name, args.merge_layers_only === true));
    }
    case "document.resize_canvas": {
      const doc = activeDocument();
      const anchorName = CANVAS_ANCHORS[args.anchor || "middle_center"];
      const anchor = constants.AnchorPosition && constants.AnchorPosition[anchorName];
      if (anchor === undefined) throw new PluginError("UNVERIFIED", `AnchorPosition.${anchorName} is unavailable in this Photoshop runtime`);
      await requireMethod(doc, "resizeCanvas", "Document.resizeCanvas")(args.width, args.height, anchor);
      return compactDocument(doc);
    }
    case "document.rotate": {
      const doc = activeDocument();
      await requireMethod(doc, "rotate", "Document.rotate")(args.angle);
      return compactDocument(doc);
    }
    case "document.color_mode_set": {
      const doc = activeDocument();
      const constantName = DOCUMENT_COLOR_MODES[args.mode];
      const mode = constants.ChangeMode && constants.ChangeMode[constantName];
      if (mode === undefined) throw new PluginError("UNVERIFIED", `ChangeMode.${constantName} is unavailable in this Photoshop runtime`);
      await requireMethod(doc, "changeMode", "Document.changeMode")(mode);
      return { document: compactDocument(doc), requestedMode: args.mode };
    }
    case "document.bits_per_channel_set": {
      const doc = activeDocument();
      if (!probeMember(doc, "bitsPerChannel")) throw new PluginError("UNVERIFIED", "Document.bitsPerChannel is unavailable in this Photoshop runtime");
      doc.bitsPerChannel = requireMappedConstant("BitsPerChannelType", BITS_PER_CHANNEL_TYPES, args.bits);
      return { document: compactDocument(doc), bitsPerChannel: args.bits };
    }
    case "document.profile_convert": {
      const doc = activeDocument();
      const intent = requireMappedConstant("Intent", PROFILE_INTENTS, args.intent);
      const blackPointCompensation = args.black_point_compensation === undefined ? true : args.black_point_compensation;
      const dither = args.dither === undefined ? false : args.dither;
      await requireMethod(doc, "convertProfile", "Document.convertProfile")(args.destination_profile, intent, blackPointCompensation, dither);
      return { document: compactDocument(doc), destinationProfile: args.destination_profile, intent: args.intent, blackPointCompensation, dither };
    }
    case "document.artboard_list": {
      const doc = activeDocument();
      requireMember(doc, "artboards", "Document.artboards");
      return { documentId: Number(doc.id), artboards: Array.from(doc.artboards || []).map((layer) => compactLayer(layer)) };
    }
    case "document.metadata_summary_get": {
      const doc = activeDocument();
      for (const property of ["name", "title", "path", "saved", "cloudDocument", "colorProfileName", "colorProfileType"]) {
        if (!probeMember(doc, property)) throw new PluginError("UNVERIFIED", `Document.${property} is unavailable in this Photoshop runtime`);
      }
      return {
        documentId: Number(doc.id),
        name: String(doc.name),
        title: String(doc.title),
        path: String(doc.path),
        saved: Boolean(doc.saved),
        cloudDocument: Boolean(doc.cloudDocument),
        colorProfileName: String(doc.colorProfileName),
        colorProfileType: String(doc.colorProfileType),
        xmpPacket: { status: "unavailable", reason: "Photoshop Document DOM exposes no active-document XMP packet property" }
      };
    }
    case "layer.create": return compactLayer(await activeDocument().createLayer({ name: args.name || "MCP Layer" }));
    case "layer.group_create": {
      const doc = activeDocument();
      const group = await requireMethod(doc, "createLayerGroup", "Document.createLayerGroup")({ name: args.name || "MCP Group" });
      return compactLayer(group);
    }
    case "layer.delete": {
      const layer = activeLayer();
      const result = { id: layer.id, name: layer.name };
      await layer.delete();
      return result;
    }
    case "layer.rename": {
      const layer = activeLayer();
      if (!args.name || typeof args.name !== "string") throw new PluginError("PRECONDITION_FAILED", "name is required");
      layer.name = args.name;
      return compactLayer(layer);
    }
    case "layer.visibility_set": {
      const layer = activeLayer();
      layer.visible = args.visible;
      return compactLayer(layer);
    }
    case "layer.opacity_set": {
      const layer = activeLayer();
      layer.opacity = args.opacity;
      return { ...compactLayer(layer), opacity: Number(layer.opacity) };
    }
    case "layer.kind_inspect": {
      const layer = activeLayer();
      requireMember(layer, "kind", "Layer.kind");
      const kinds = constants.LayerKind;
      if (!kinds || typeof kinds !== "object") throw new PluginError("UNVERIFIED", "LayerKind constants are unavailable in this Photoshop runtime");
      const kindName = Object.keys(kinds).find((name) => kinds[name] === layer.kind) || null;
      const adjustmentKinds = new Set(["BLACKANDWHITE", "BRIGHTNESSCONTRAST", "CHANNELMIXER", "CLARITY", "COLORBALANCE", "COLORLOOKUP", "CURVES", "EXPOSURE", "GRAIN", "GRADIENTMAP", "HUESATURATION", "INVERSION", "LEVELS", "PHOTOFILTER", "POSTERIZE", "SELECTIVECOLOR", "THRESHOLD", "VIBRANCE"]);
      const fillKinds = new Set(["GRADIENTFILL", "PATTERNFILL", "SOLIDFILL"]);
      const classification = kindName === "SMARTOBJECT" ? "smart_object" : fillKinds.has(kindName) ? "fill" : adjustmentKinds.has(kindName) ? "adjustment" : "other";
      return { ...compactLayer(layer), kindName, classification };
    }
    case "mask.properties_get": {
      const layer = activeLayer();
      for (const [member, label] of [["layerMaskDensity", "Layer.layerMaskDensity"], ["layerMaskFeather", "Layer.layerMaskFeather"], ["vectorMaskDensity", "Layer.vectorMaskDensity"], ["vectorMaskFeather", "Layer.vectorMaskFeather"]]) requireMember(layer, member, label);
      return { ...compactLayer(layer), layerMaskDensity: Number(layer.layerMaskDensity), layerMaskFeather: Number(layer.layerMaskFeather), vectorMaskDensity: Number(layer.vectorMaskDensity), vectorMaskFeather: Number(layer.vectorMaskFeather) };
    }
    case "mask.properties_set": {
      const layer = activeLayer();
      const propertyMap = { layer_mask_density: "layerMaskDensity", layer_mask_feather: "layerMaskFeather", vector_mask_density: "vectorMaskDensity", vector_mask_feather: "vectorMaskFeather" };
      await withTemporarilyUnlockedLayer(layer, async () => {
        for (const [argument, member] of Object.entries(propertyMap)) {
          if (args[argument] === undefined) continue;
          requireMember(layer, member, `Layer.${member}`);
          layer[member] = args[argument];
        }
      });
      return { ...compactLayer(layer), applied: { ...args } };
    }
    case "layer.translate": {
      const layer = activeLayer();
      const unit = args.unit || "pixels";
      const horizontal = unit === "percent" ? { _unit: "percentUnit", _value: args.horizontal } : args.horizontal;
      const vertical = unit === "percent" ? { _unit: "percentUnit", _value: args.vertical } : args.vertical;
      await withTemporarilyUnlockedLayer(layer, () => requireMethod(layer, "translate", "Layer.translate")(horizontal, vertical));
      return { ...compactLayer(layer), horizontal: args.horizontal, vertical: args.vertical, unit };
    }
    case "layer.scale": {
      const layer = activeLayer();
      const anchor = requireMappedConstant("AnchorPosition", CANVAS_ANCHORS, args.anchor || "middle_center");
      const interpolation = requireMappedConstant("InterpolationMethod", INTERPOLATION_METHODS, args.interpolation || "automatic");
      await withTemporarilyUnlockedLayer(layer, () => requireMethod(layer, "scale", "Layer.scale")(args.width_percent, args.height_percent, anchor, { interpolation }));
      return { ...compactLayer(layer), widthPercent: args.width_percent, heightPercent: args.height_percent, anchor: args.anchor || "middle_center", interpolation: args.interpolation || "automatic" };
    }
    case "layer.rotate": {
      const layer = activeLayer();
      const anchor = requireMappedConstant("AnchorPosition", CANVAS_ANCHORS, args.anchor || "middle_center");
      const interpolation = requireMappedConstant("InterpolationMethod", INTERPOLATION_METHODS, args.interpolation || "automatic");
      await withTemporarilyUnlockedLayer(layer, () => requireMethod(layer, "rotate", "Layer.rotate")(args.angle, anchor, { interpolation }));
      return { ...compactLayer(layer), angle: args.angle, anchor: args.anchor || "middle_center", interpolation: args.interpolation || "automatic" };
    }
    case "layer.clipping_set": {
      const layer = activeLayer();
      if (!probeMember(layer, "isClippingMask")) throw new PluginError("UNVERIFIED", "Layer.isClippingMask is unavailable in this Photoshop runtime");
      layer.isClippingMask = args.clipping;
      return { ...compactLayer(layer), clipping: Boolean(layer.isClippingMask) };
    }
    case "layer.blend_mode_set": {
      const layer = activeLayer();
      const constantName = BLEND_MODES[args.blend_mode];
      const blendMode = constants.BlendMode && constants.BlendMode[constantName];
      if (blendMode === undefined) throw new PluginError("UNVERIFIED", `BlendMode.${constantName} is unavailable in this Photoshop runtime`);
      if (!probeMember(layer, "blendMode")) throw new PluginError("UNVERIFIED", "Layer.blendMode is unavailable in this Photoshop runtime");
      layer.blendMode = blendMode;
      return { ...compactLayer(layer), blendMode: args.blend_mode };
    }
    case "layer.fill_opacity_set": {
      const layer = activeLayer();
      if (!probeMember(layer, "fillOpacity")) throw new PluginError("UNVERIFIED", "Layer.fillOpacity is unavailable in this Photoshop runtime");
      layer.fillOpacity = args.fill_opacity;
      return { ...compactLayer(layer), fillOpacity: Number(layer.fillOpacity) };
    }
    case "layer.locked_set": {
      const layer = activeLayer();
      if (!probeMember(layer, "allLocked")) throw new PluginError("UNVERIFIED", "Layer.allLocked is unavailable in this Photoshop runtime");
      layer.allLocked = args.locked;
      return { ...compactLayer(layer), allLocked: Boolean(layer.allLocked) };
    }
    case "selection.select_all": {
      const selection = activeDocument().selection;
      await requireMethod(selection, "selectAll", "Selection.selectAll")();
      return { selected: true, bounds: selection.bounds || null };
    }
    case "selection.deselect": {
      const selection = activeDocument().selection;
      await requireMethod(selection, "deselect", "Selection.deselect")();
      return { selected: false, bounds: selection.bounds || null };
    }
    case "selection.invert": {
      const selection = activeDocument().selection;
      await requireMethod(selection, "inverse", "Selection.inverse")();
      return { inverted: true };
    }
    case "selection.rectangle": {
      const selection = activeDocument().selection;
      if (!constants.SelectionType || constants.SelectionType.REPLACE === undefined) throw new PluginError("UNVERIFIED", "SelectionType.REPLACE is unavailable in this Photoshop runtime");
      await requireMethod(selection, "selectRectangle", "Selection.selectRectangle")(
        { left: args.left, top: args.top, right: args.right, bottom: args.bottom },
        constants.SelectionType.REPLACE,
        args.feather || 0,
        args.anti_alias !== false
      );
      return { bounds: { left: args.left, top: args.top, right: args.right, bottom: args.bottom } };
    }
    case "selection.ellipse": {
      const selection = activeDocument().selection;
      if (!constants.SelectionType || constants.SelectionType.REPLACE === undefined) throw new PluginError("UNVERIFIED", "SelectionType.REPLACE is unavailable in this Photoshop runtime");
      await requireMethod(selection, "selectEllipse", "Selection.selectEllipse")(
        { left: args.left, top: args.top, right: args.right, bottom: args.bottom },
        constants.SelectionType.REPLACE,
        args.feather || 0,
        args.anti_alias !== false
      );
      return { bounds: { left: args.left, top: args.top, right: args.right, bottom: args.bottom } };
    }
    case "selection.expand": {
      await requireMethod(activeDocument().selection, "expand", "Selection.expand")(args.by, args.apply_at_canvas_bounds === true);
      return { expandedBy: args.by, applyAtCanvasBounds: args.apply_at_canvas_bounds === true };
    }
    case "selection.contract": {
      await requireMethod(activeDocument().selection, "contract", "Selection.contract")(args.by, args.apply_at_canvas_bounds === true);
      return { contractedBy: args.by, applyAtCanvasBounds: args.apply_at_canvas_bounds === true };
    }
    case "selection.feather": {
      await requireMethod(activeDocument().selection, "feather", "Selection.feather")(args.by, args.apply_at_canvas_bounds === true);
      return { featheredBy: args.by, applyAtCanvasBounds: args.apply_at_canvas_bounds === true };
    }
    case "selection.border": {
      await requireMethod(activeDocument().selection, "selectBorder", "Selection.selectBorder")(args.width);
      return { borderWidth: args.width };
    }
    case "selection.polygon": {
      const selection = activeDocument().selection;
      if (!constants.SelectionType || constants.SelectionType.REPLACE === undefined) throw new PluginError("UNVERIFIED", "SelectionType.REPLACE is unavailable in this Photoshop runtime");
      await requireMethod(selection, "selectPolygon", "Selection.selectPolygon")(args.points, constants.SelectionType.REPLACE, args.feather || 0, args.anti_alias !== false);
      return { pointCount: args.points.length };
    }
    case "selection.grow": {
      await requireMethod(activeDocument().selection, "grow", "Selection.grow")(args.tolerance, args.anti_alias !== false);
      return { tolerance: args.tolerance, antiAlias: args.anti_alias !== false };
    }
    case "selection.smooth": {
      await requireMethod(activeDocument().selection, "smooth", "Selection.smooth")(args.radius, args.apply_at_canvas_bounds === true);
      return { radius: args.radius, applyAtCanvasBounds: args.apply_at_canvas_bounds === true };
    }
    case "filter.gaussian_blur": {
      const layer = activeLayer();
      await requireMethod(layer, "applyGaussianBlur", "Layer.applyGaussianBlur")(args.radius);
      return { ...compactLayer(layer), radius: args.radius };
    }
    case "filter.sharpen": {
      const layer = activeLayer();
      await requireMethod(layer, "applySharpen", "Layer.applySharpen")();
      return compactLayer(layer);
    }
    case "filter.add_noise": {
      const layer = activeLayer();
      const constantName = NOISE_DISTRIBUTIONS[args.distribution];
      const distribution = constants.NoiseDistribution && constants.NoiseDistribution[constantName];
      if (distribution === undefined) throw new PluginError("UNVERIFIED", `NoiseDistribution.${constantName} is unavailable in this Photoshop runtime`);
      await requireMethod(layer, "applyAddNoise", "Layer.applyAddNoise")(args.amount, distribution, args.monochromatic);
      return { ...compactLayer(layer), amount: args.amount, distribution: args.distribution, monochromatic: args.monochromatic };
    }
    case "filter.pinch": {
      const layer = activeLayer();
      await requireMethod(layer, "applyPinch", "Layer.applyPinch")(args.amount);
      return { ...compactLayer(layer), amount: args.amount };
    }
    case "filter.polar_coordinates": {
      const layer = activeLayer();
      await requireMethod(layer, "applyPolarCoordinates", "Layer.applyPolarCoordinates")(requireMappedConstant("PolarConversionType", POLAR_CONVERSIONS, args.conversion));
      return { ...compactLayer(layer), conversion: args.conversion };
    }
    case "filter.ripple": {
      const layer = activeLayer();
      await requireMethod(layer, "applyRipple", "Layer.applyRipple")(args.amount, requireMappedConstant("RippleSize", RIPPLE_SIZES, args.size));
      return { ...compactLayer(layer), amount: args.amount, size: args.size };
    }
    case "filter.spherize": {
      const layer = activeLayer();
      await requireMethod(layer, "applySpherize", "Layer.applySpherize")(args.amount, requireMappedConstant("SpherizeMode", SPHERIZE_MODES, args.mode));
      return { ...compactLayer(layer), amount: args.amount, mode: args.mode };
    }
    case "filter.twirl": {
      const layer = activeLayer();
      await requireMethod(layer, "applyTwirl", "Layer.applyTwirl")(args.angle);
      return { ...compactLayer(layer), angle: args.angle };
    }
    case "filter.zigzag": {
      const layer = activeLayer();
      await requireMethod(layer, "applyZigZag", "Layer.applyZigZag")(args.amount, args.ridges, requireMappedConstant("ZigZagType", ZIGZAG_STYLES, args.style));
      return { ...compactLayer(layer), amount: args.amount, ridges: args.ridges, style: args.style };
    }
    case "filter.ocean_ripple": {
      const layer = activeLayer();
      await requireMethod(layer, "applyOceanRipple", "Layer.applyOceanRipple")(args.size, args.magnitude);
      return { ...compactLayer(layer), size: args.size, magnitude: args.magnitude };
    }
    case "filter.diffuse_glow": {
      const layer = activeLayer();
      await requireMethod(layer, "applyDiffuseGlow", "Layer.applyDiffuseGlow")(args.graininess, args.glow_amount, args.clear_amount);
      return { ...compactLayer(layer), graininess: args.graininess, glowAmount: args.glow_amount, clearAmount: args.clear_amount };
    }
    case "filter.clouds": {
      const layer = activeLayer();
      await requireMethod(layer, "applyClouds", "Layer.applyClouds")();
      return compactLayer(layer);
    }
    case "filter.difference_clouds": {
      const layer = activeLayer();
      await requireMethod(layer, "applyDifferenceClouds", "Layer.applyDifferenceClouds")();
      return compactLayer(layer);
    }
    case "channel.list": {
      const channels = activeDocument().channels;
      if (!channels || typeof channels.length !== "number") throw new PluginError("UNVERIFIED", "Document.channels is unavailable in this Photoshop runtime");
      return { channels: Array.from(channels).map(compactChannel) };
    }
    case "channel.create": {
      const channels = activeDocument().channels;
      const channel = await requireMethod(channels, "add", "Channels.add")();
      if (args.name) channel.name = args.name;
      return compactChannel(channel);
    }
    case "channel.duplicate": {
      const doc = activeDocument();
      const channel = namedCollectionItem(doc.channels, args.name, "Channels");
      const beforeCount = Number(doc.channels.length);
      await requireMethod(channel, "duplicate", "Channel.duplicate")();
      return { source: compactChannel(channel), channelCountBefore: beforeCount, channelCountAfter: Number(doc.channels.length) };
    }
    case "channel.delete": {
      const doc = activeDocument();
      const channel = namedCollectionItem(doc.channels, args.name, "Channels");
      if (!doc.componentChannels || typeof doc.componentChannels.length !== "number") throw new PluginError("UNVERIFIED", "Document.componentChannels is unavailable; component-channel deletion cannot be guarded");
      if (Array.from(doc.componentChannels).some((candidate) => candidate === channel || String(candidate.name) === String(channel.name))) {
        throw new PluginError("PRECONDITION_FAILED", "Component channels cannot be deleted");
      }
      const removed = compactChannel(channel);
      await requireMethod(channel, "remove", "Channel.remove")();
      return { removed };
    }
    case "channel.calculations_new": {
      const doc = activeDocument();
      const layers = doc.activeLayers;
      if (!layers || layers.length !== 1) throw new PluginError("PRECONDITION_FAILED", "Document.calculations requires exactly one active layer in this Photoshop version");
      const layer = layers[0];
      if (!constants.LayerKind || constants.LayerKind.NORMAL === undefined || layer.kind !== constants.LayerKind.NORMAL) throw new PluginError("PRECONDITION_FAILED", "Document.calculations requires an active pixel layer");
      const blendName = CHANNEL_CALCULATION_BLEND_MODES[args.blending || "multiply"];
      const blending = constants.CalculationsBlendMode && constants.CalculationsBlendMode[blendName];
      const gray = constants.CalculationsChannel && constants.CalculationsChannel.GRAY;
      const merged = constants.CalculationsLayer && constants.CalculationsLayer.MERGED;
      const newChannel = constants.CalculationsResult && constants.CalculationsResult.NEWCHANNEL;
      if ([blending, gray, merged, newChannel].some((value) => value === undefined)) throw new PluginError("UNVERIFIED", "Required Calculations constants are unavailable in this Photoshop runtime");
      return withTemporarilyUnlockedLayer(layer, async () => {
        const result = await requireMethod(doc, "calculations", "Document.calculations")({
          source1: { document: doc, layer: merged, channel: gray, invert: args.source1_invert === true },
          source2: { document: doc, layer: merged, channel: gray, invert: args.source2_invert === true },
          blending,
          opacity: args.opacity === undefined ? 100 : args.opacity,
          result: newChannel
        });
        return { created: result ? compactChannel(result) : null, channelCount: Number(doc.channels.length) };
      });
    }
    case "layer.apply_image": {
      const doc = activeDocument();
      const layer = activeLayer();
      if (!constants.LayerKind || constants.LayerKind.NORMAL === undefined || layer.kind !== constants.LayerKind.NORMAL) throw new PluginError("PRECONDITION_FAILED", "Layer.applyImage requires an active pixel layer");
      const blendName = CHANNEL_CALCULATION_BLEND_MODES[args.blending || "normal"];
      const blending = constants.ApplyImageBlendMode && constants.ApplyImageBlendMode[blendName];
      const merged = constants.ApplyImageLayer && constants.ApplyImageLayer.MERGED;
      const rgb = constants.ApplyImageChannel && constants.ApplyImageChannel.RGB;
      if ([blending, merged, rgb].some((value) => value === undefined)) throw new PluginError("UNVERIFIED", "Required Apply Image constants are unavailable in this Photoshop runtime");
      return withTemporarilyUnlockedLayer(layer, async () => {
        await requireMethod(layer, "applyImage", "Layer.applyImage")({
          source: { document: doc, layer: merged, channel: rgb, invert: args.invert_source === true },
          blending,
          opacity: args.opacity === undefined ? 100 : args.opacity,
          preserveTransparency: args.preserve_transparency === true
        });
        return { layer: compactLayer(layer), blending: args.blending || "normal", opacity: args.opacity === undefined ? 100 : args.opacity };
      });
    }
    case "path.list": {
      const paths = activeDocument().pathItems;
      if (!paths || typeof paths.length !== "number") throw new PluginError("UNVERIFIED", "Document.pathItems is unavailable in this Photoshop runtime");
      return { paths: Array.from(paths).map(compactPath) };
    }
    case "path.create": {
      const doc = activeDocument();
      const paths = doc.pathItems;
      if (!paths || typeof paths !== "object") throw new PluginError("UNVERIFIED", "Document.pathItems is unavailable in this Photoshop runtime");
      if (typeof app.PathPointInfo !== "function" || typeof app.SubPathInfo !== "function") throw new PluginError("UNVERIFIED", "PathPointInfo or SubPathInfo is unavailable in this Photoshop runtime");
      const subpathInfos = args.subpaths.map((subpath) => {
        const info = new app.SubPathInfo();
        info.closed = subpath.closed;
        info.operation = requireMappedConstant("ShapeOperation", PATH_SHAPE_OPERATIONS, subpath.shape_operation);
        info.entireSubPath = subpath.points.map((point) => {
          const pointInfo = new app.PathPointInfo();
          pointInfo.anchor = [...point.anchor];
          pointInfo.leftDirection = [...point.left_direction];
          pointInfo.rightDirection = [...point.right_direction];
          pointInfo.kind = requireMappedConstant("PointKind", PATH_POINT_KINDS, point.kind);
          return pointInfo;
        });
        return info;
      });
      const created = await requireMethod(paths, "add", "PathItems.add")(args.name, subpathInfos);
      return { ...compactPath(created), pointCount: args.subpaths.reduce((sum, subpath) => sum + subpath.points.length, 0) };
    }
    case "path.geometry_get": {
      const pathItem = namedCollectionItem(activeDocument().pathItems, args.name, "PathItems");
      requireMember(pathItem, "subPathItems", "PathItem.subPathItems");
      const subpaths = Array.from(pathItem.subPathItems).map((subpath) => {
        requireMember(subpath, "closed", "SubPathItem.closed");
        requireMember(subpath, "operation", "SubPathItem.operation");
        requireMember(subpath, "pathPoints", "SubPathItem.pathPoints");
        const points = Array.from(subpath.pathPoints).map((point) => {
          for (const property of ["anchor", "leftDirection", "rightDirection", "kind"]) requireMember(point, property, `PathPoint.${property}`);
          return {
            anchor: [Number(point.anchor[0]), Number(point.anchor[1])],
            leftDirection: [Number(point.leftDirection[0]), Number(point.leftDirection[1])],
            rightDirection: [Number(point.rightDirection[0]), Number(point.rightDirection[1])],
            kind: String(point.kind)
          };
        });
        return { closed: Boolean(subpath.closed), operation: String(subpath.operation), points };
      });
      return { path: compactPath(pathItem), subpaths };
    }
    case "path.create_from_selection": {
      const selection = activeDocument().selection;
      const pathItem = await requireMethod(selection, "makeWorkPath", "Selection.makeWorkPath")(args.tolerance === undefined ? 2 : args.tolerance);
      pathItem.name = args.name;
      return compactPath(pathItem);
    }
    case "path.select": {
      const pathItem = namedCollectionItem(activeDocument().pathItems, args.name, "PathItems");
      await requireMethod(pathItem, "select", "PathItem.select")();
      return compactPath(pathItem);
    }
    case "path.duplicate": {
      const pathItem = namedCollectionItem(activeDocument().pathItems, args.name, "PathItems");
      return compactPath(await requireMethod(pathItem, "duplicate", "PathItem.duplicate")(args.new_name));
    }
    case "path.delete": {
      const pathItem = namedCollectionItem(activeDocument().pathItems, args.name, "PathItems");
      const removed = compactPath(pathItem);
      await requireMethod(pathItem, "remove", "PathItem.remove")();
      return { removed };
    }
    case "path.make_selection": {
      const pathItem = namedCollectionItem(activeDocument().pathItems, args.name, "PathItems");
      if (!constants.SelectionType || constants.SelectionType.REPLACE === undefined) throw new PluginError("UNVERIFIED", "SelectionType.REPLACE is unavailable in this Photoshop runtime");
      await requireMethod(pathItem, "makeSelection", "PathItem.makeSelection")(args.feather || 0, args.anti_alias !== false, constants.SelectionType.REPLACE);
      return { sourcePath: compactPath(pathItem), feather: args.feather || 0, antiAlias: args.anti_alias !== false };
    }
    case "action.list": {
      if (!probeMember(app, "actionTree")) throw new PluginError("UNVERIFIED", "Photoshop.actionTree is unavailable in this runtime");
      if (!Array.isArray(app.actionTree)) throw new PluginError("UNVERIFIED", "Photoshop.actionTree did not return an array");
      return { actionSets: compactActionTree(app.actionTree) };
    }
    case "action.play": {
      if (!probeMember(app, "actionTree")) throw new PluginError("UNVERIFIED", "Photoshop.actionTree is unavailable in this runtime");
      const { set, item } = namedAction(args.set_name, args.action_name);
      await requireMethod(item, "play", "Action.play")();
      return { actionSet: { id: Number(set.id), name: String(set.name) }, action: { id: Number(item.id), name: String(item.name) } };
    }
    case "layer_comp.list": {
      const collection = activeDocument().layerComps;
      if (!collection || typeof collection.length !== "number") throw new PluginError("UNVERIFIED", "Document.layerComps is unavailable in this Photoshop runtime");
      return { layerComps: Array.from(collection).map(compactLayerComp) };
    }
    case "layer_comp.create": {
      const collection = activeDocument().layerComps;
      const add = requireMethod(collection, "add", "LayerComps.add");
      const comp = await add({
        name: args.name,
        comment: args.comment || "",
        visibility: args.visibility !== false,
        position: args.position === true,
        appearance: args.appearance === true,
        childComp: args.child_comp === true
      });
      return compactLayerComp(comp);
    }
    case "layer_comp.apply": {
      const comp = namedLayerComp(args.name);
      await requireMethod(comp, "apply", "LayerComp.apply")();
      return compactLayerComp(comp);
    }
    case "layer_comp.duplicate": {
      const copy = await requireMethod(namedLayerComp(args.name), "duplicate", "LayerComp.duplicate")();
      copy.name = args.new_name;
      return compactLayerComp(copy);
    }
    case "layer_comp.recapture": {
      const comp = namedLayerComp(args.name);
      await requireMethod(comp, "recapture", "LayerComp.recapture")();
      return compactLayerComp(comp);
    }
    case "layer_comp.reset": {
      const comp = namedLayerComp(args.name);
      await requireMethod(comp, "resetLayerComp", "LayerComp.resetLayerComp")();
      return compactLayerComp(comp);
    }
    case "layer_comp.delete": {
      const comp = namedLayerComp(args.name);
      const removed = compactLayerComp(comp);
      await requireMethod(comp, "remove", "LayerComp.remove")();
      return { removed };
    }
    case "generative.upscale": {
      const doc = activeDocument();
      const model = constants.GenerativeUpscaleModel && constants.GenerativeUpscaleModel.FIREFLY;
      if (model === undefined) throw new PluginError("UNSUPPORTED", "GenerativeUpscaleModel.FIREFLY is unavailable in this Photoshop runtime");
      const output = await requireMethod(doc, "generativeUpscale", "Document.generativeUpscale")(model, { scale: args.scale });
      return compactDocument(output);
    }
    case "text.create": {
      const doc = activeDocument();
      const layer = await requireMethod(doc, "createTextLayer", "Document.createTextLayer")({ name: args.name || "MCP Text", contents: args.content });
      return compactLayer(layer);
    }
    case "text.content_set": {
      const layer = activeLayer();
      if (!layer.textItem || typeof layer.textItem !== "object") throw new PluginError("PRECONDITION_FAILED", "The active layer is not a text layer");
      layer.textItem.contents = args.content;
      return { ...compactLayer(layer), contents: layer.textItem.contents };
    }
    case "text.character_style_set": {
      const { layer, textItem } = activeTextItem();
      requireMember(textItem, "characterStyle", "TextItem.characterStyle");
      const style = textItem.characterStyle;
      const properties = {
        size: "size", leading: "leading", tracking: "tracking", faux_bold: "fauxBold",
        faux_italic: "fauxItalic", horizontal_scale: "horizontalScale", vertical_scale: "verticalScale",
        use_auto_leading: "useAutoLeading"
      };
      for (const [argument, property] of Object.entries(properties)) {
        if (args[argument] === undefined) continue;
        requireMember(style, property, `CharacterStyle.${property}`);
        style[property] = args[argument];
      }
      return { ...compactLayer(layer), applied: { ...args } };
    }
    case "text.paragraph_style_set": {
      const { layer, textItem } = activeTextItem();
      requireMember(textItem, "paragraphStyle", "TextItem.paragraphStyle");
      const style = textItem.paragraphStyle;
      const scalarProperties = {
        hyphenation: "hyphenation", first_line_indent: "firstLineIndent", left_indent: "leftIndent",
        right_indent: "rightIndent", space_before: "spaceBefore", space_after: "spaceAfter"
      };
      if (args.justification !== undefined) {
        requireMember(style, "justification", "ParagraphStyle.justification");
        style.justification = requireMappedConstant("Justification", TEXT_JUSTIFICATIONS, args.justification);
      }
      for (const [argument, property] of Object.entries(scalarProperties)) {
        if (args[argument] === undefined) continue;
        requireMember(style, property, `ParagraphStyle.${property}`);
        style[property] = args[argument];
      }
      return { ...compactLayer(layer), applied: { ...args } };
    }
    case "text.warp_style_set": {
      const { layer, textItem } = activeTextItem();
      requireMember(textItem, "warpStyle", "TextItem.warpStyle");
      const style = textItem.warpStyle;
      if (args.style !== undefined) {
        requireMember(style, "style", "WarpStyle.style");
        style.style = requireMappedConstant("WarpStyle", TEXT_WARP_STYLES, args.style);
      }
      if (args.direction !== undefined) {
        requireMember(style, "direction", "WarpStyle.direction");
        style.direction = requireMappedConstant("Direction", TEXT_WARP_DIRECTIONS, args.direction);
      }
      const distortions = { bend: "bend", horizontal_distortion: "horizontalDistortion", vertical_distortion: "verticalDistortion" };
      for (const [argument, property] of Object.entries(distortions)) {
        if (args[argument] === undefined) continue;
        requireMember(style, property, `WarpStyle.${property}`);
        style[property] = args[argument];
      }
      return { ...compactLayer(layer), applied: { ...args } };
    }
    case "text.convert": {
      const { layer, textItem } = activeTextItem();
      if (args.operation === "point_to_paragraph") {
        requireMember(textItem, "isPointText", "TextItem.isPointText");
        if (textItem.isPointText !== true) throw new PluginError("PRECONDITION_FAILED", "The active text layer is not point text");
        await requireMethod(textItem, "convertToParagraphText", "TextItem.convertToParagraphText")();
      } else if (args.operation === "paragraph_to_point") {
        requireMember(textItem, "isParagraphText", "TextItem.isParagraphText");
        if (textItem.isParagraphText !== true) throw new PluginError("PRECONDITION_FAILED", "The active text layer is not paragraph text");
        await requireMethod(textItem, "convertToPointText", "TextItem.convertToPointText")();
      } else if (args.operation === "to_shape") {
        await requireMethod(textItem, "convertToShape", "TextItem.convertToShape")();
      } else {
        await requireMethod(textItem, "createWorkPath", "TextItem.createWorkPath")();
      }
      return { ...compactLayer(activeLayer()), previousLayerId: layer.id, operation: args.operation };
    }
    case "history.undo": {
      const doc = activeDocument();
      const states = Array.from(doc.historyStates || []);
      const current = doc.activeHistoryState;
      const index = states.findIndex((state) => state === current || (state && current && Number(state.id) === Number(current.id)));
      if (index <= 0) throw new PluginError("PRECONDITION_FAILED", "No previous Photoshop history state is available");
      doc.activeHistoryState = states[index - 1];
      return { from: { id: current.id, name: current.name }, to: { id: states[index - 1].id, name: states[index - 1].name } };
    }
    case "history.state_list": {
      const doc = activeDocument();
      requireMember(doc, "historyStates", "Document.historyStates");
      requireMember(doc, "activeHistoryState", "Document.activeHistoryState");
      const active = doc.activeHistoryState;
      return { documentId: Number(doc.id), states: Array.from(doc.historyStates || []).map((state, index) => ({ index, name: String(state.name), snapshot: Boolean(state.snapshot), active: state === active })) };
    }
    case "history.state_activate": {
      const doc = activeDocument();
      requireMember(doc, "historyStates", "Document.historyStates");
      requireMember(doc, "activeHistoryState", "Document.activeHistoryState");
      const states = Array.from(doc.historyStates || []);
      const target = args.index !== undefined ? states[args.index] : states.find((state) => String(state.name) === args.name);
      if (!target) throw new PluginError("PRECONDITION_FAILED", "Requested history state was not found");
      const previous = doc.activeHistoryState;
      doc.activeHistoryState = target;
      return { from: { name: String(previous.name), snapshot: Boolean(previous.snapshot) }, to: { index: states.indexOf(target), name: String(target.name), snapshot: Boolean(target.snapshot) } };
    }
    case "history.redo": {
      const doc = activeDocument();
      const states = Array.from(doc.historyStates || []);
      const current = doc.activeHistoryState;
      const index = states.findIndex((state) => state === current || (state && current && Number(state.id) === Number(current.id)));
      if (index < 0 || index >= states.length - 1) throw new PluginError("PRECONDITION_FAILED", "No next Photoshop history state is available");
      doc.activeHistoryState = states[index + 1];
      return { from: { id: current.id, name: current.name }, to: { id: states[index + 1].id, name: states[index + 1].name } };
    }
    case "image.resize": {
      const doc = activeDocument();
      const width = Number(args.width);
      const height = Number(args.height);
      if (!(width > 0) && !(height > 0)) throw new PluginError("PRECONDITION_FAILED", "width or height must be greater than zero");
      await doc.resizeImage(width > 0 ? width : undefined, height > 0 ? height : undefined, Number(args.resolution || doc.resolution), constants.ResampleMethod.BICUBIC);
      return compactDocument(doc);
    }
    case "verified.batchplay": {
      const factory = VERIFIED_ACTIONS[args.verification_id];
      if (!factory) throw new PluginError("UNVERIFIED", `Unknown verification_id: ${args.verification_id || "(missing)"}`);
      return batchPlay(factory(args), args.dialog_policy === "display" ? "display" : "dontDisplay");
    }
    default: throw new PluginError("UNSUPPORTED", `Unsupported stable command_id: ${commandId}`);
  }
}

async function inModal(commandId, fn, suspendHistory = true, context = {}, target) {
  let entered = false;
  const [major, minor] = String(app.version || "0.0").split(".").map(Number);
  const options = { commandName: `Photoshop MCP: ${commandId}`, interactive: false };
  if (major > 25 || (major === 25 && minor >= 10)) options.timeOut = 5;
  try {
    return await core.executeAsModal(async (executionContext) => {
      entered = true;
      if (context.bindModal) context.bindModal(executionContext);
      if (context.throwIfCancelled) context.throwIfCancelled();
      return targets.withTarget(target, async (resolved) => {
        let suspension = null, committed = false, result;
        const beforeHistoryId = resolved.document && resolved.document.activeHistoryState && resolved.document.activeHistoryState.id;
        if (suspendHistory && resolved.document && executionContext.hostControl && typeof executionContext.hostControl.suspendHistory === "function") {
          suspension = await executionContext.hostControl.suspendHistory({ documentID: resolved.document.id, name: `MCP: ${commandId}` });
        }
        try {
          result = await fn(executionContext);
          committed = true;
          return result;
        } catch (error) {
          if (suspension) {
            try {
              await executionContext.hostControl.resumeHistory(suspension, false);
              suspension = null;
              if (!error.details || error.details.effect !== "not_applied") {
                error.details = { ...(error.details || {}), effect: "rolled_back" };
                if (context.markEffect) context.markEffect("rolled_back");
              }
            } catch (rollbackError) {
              error.details = { ...(error.details || {}), effect: "unknown", rollbackError: String(rollbackError) };
              suspension = null;
            }
          }
          throw error;
        } finally {
          if (suspension) {
            await executionContext.hostControl.resumeHistory(suspension, committed);
            if (result && typeof result === "object" && committed) {
              const afterHistoryId = resolved.document.activeHistoryState && resolved.document.activeHistoryState.id;
              result.undo = typeof beforeHistoryId === "number" && typeof afterHistoryId === "number" && beforeHistoryId !== afterHistoryId
                ? { available: true, historyStates: 1, documentId: resolved.document.id } : { available: false };
            }
          }
        }
      });
    }, options);
  } catch (error) {
    // Retry is never allowed after the callback began: a later modal-looking
    // exception can follow a real edit. Acquisition is the only no-effect case.
    if (!entered) error.details = { ...(error.details || {}), effect: "not_applied" };
    throw error;
  }
}

function enqueueUserJob(payload, context, kind, instruction) {
  if (!payload.jobId) throw new PluginError("REQUIRES_USER", `${payload.commandId || payload.command_id} requires a jobId for user-assisted execution`);
  const commandId = payload.commandId || payload.command_id;
  const job = {
    jobId: payload.jobId,
    commandId,
    label: payload.label || commandId,
    risk: payload.risk || (kind === "approval" ? "destructive" : "edit"),
    kind,
    instruction,
    consequence: payload.consequence || null,
    scopeDigest: payload.scopeDigest || null,
    status: "awaiting_user",
    serverPort: context.serverPort || null,
    serverId: context.serverId || null,
    createdAt: new Date().toISOString()
  };
  jobs.set(job.jobId, job);
  for (const listener of approvalListeners) listener({ ...job });
  return { awaitingUser: true, jobId: job.jobId, commandId: job.commandId };
}

async function commandExecute(payload = {}, context = {}) {
  const commandId = payload.commandId || payload.command_id;
  if (!commandId || typeof commandId !== "string") throw new PluginError("PRECONDITION_FAILED", "command_id is required");
  if (USER_ASSISTED_COMMANDS.has(commandId)) {
    validateUserAssistedArgs(commandId, payload.args || {});
    if (!payload.jobId) throw new PluginError("REQUIRES_USER", `${commandId} requires payload.jobId for the panel-assisted workflow`);
    return enqueueUserJob({ ...payload, commandId }, context, "user_assisted", USER_ASSISTED_INSTRUCTIONS[commandId]);
  }
  validateCoreArgs(commandId, payload.args || {});
  if (payload.minHostVersion) {
    const actual = String(app.version || "0").split(".").map(Number), minimum = String(payload.minHostVersion).split(".").map(Number);
    for (let index = 0; index < 3; index++) {
      if ((actual[index] || 0) > (minimum[index] || 0)) break;
      if ((actual[index] || 0) < (minimum[index] || 0)) throw new PluginError("CAPABILITY_UNAVAILABLE", `Command requires Photoshop ${payload.minHostVersion} or later`, { effect: "not_applied" });
    }
  }
  const mode = payload.verification || "state";
  if (!["state", "preview", "none"].includes(mode)) throw new PluginError("PRECONDITION_FAILED", "Unknown verification mode");
  const mutating = MUTATING_COMMANDS.has(commandId);
  const needsDocument = payload.prerequisites === undefined ? !["document.create", "document.open_default"].includes(commandId) : payload.prerequisites.some(item => ["document", "layer", "selection", "channel", "path", "text_layer"].includes(item));
  const target = payload.target || (needsDocument ? targets.captureTarget(context.serverId) : undefined);
  const execute = async () => {
    if (context.throwIfCancelled) context.throwIfCancelled();
    const needState = mode !== "none" || (payload.prerequisites || []).length > 0;
    const before = needState ? await stateGet({ ...(target ? { target } : {}), allowMissing: !target }) : undefined;
    for (const prerequisite of payload.prerequisites || []) {
      if (prerequisite === "document" && !before.hasDocument) throw new PluginError("NO_DOCUMENT", "Document prerequisite failed", { effect: "not_applied" });
      if (prerequisite === "layer" && !before.activeLayer) throw new PluginError("PRECONDITION_FAILED", "Layer prerequisite failed", { effect: "not_applied" });
      if (prerequisite === "selection" && !before.hasSelection) throw new PluginError("PRECONDITION_FAILED", "Selection prerequisite failed", { effect: "not_applied" });
      if (prerequisite === "text_layer" && (!before.activeLayer || typeof before.activeLayer.text !== "string")) throw new PluginError("PRECONDITION_FAILED", "Text layer prerequisite failed", { effect: "not_applied" });
      if (prerequisite === "channel" && !before.channelCount) throw new PluginError("PRECONDITION_FAILED", "Channel prerequisite failed", { effect: "not_applied" });
      if (prerequisite === "path" && !before.pathCount) throw new PluginError("PRECONDITION_FAILED", "Path prerequisite failed", { effect: "not_applied" });
      if (["online", "entitlement", "model"].includes(prerequisite)) throw new PluginError("ENTITLEMENT_UNAVAILABLE", `Cannot prove required runtime ${prerequisite}`, { effect: "not_applied" });
    }
    if (payload.expectedBefore) await verification.assertExpected(payload.expectedBefore, verification.projection(target));
    if (mutating && context.markEffect) context.markEffect("partial");
    const result = await executeStable(commandId, payload.args || {}, context);
    if (mutating && context.markEffect) context.markEffect("applied");
    const afterTarget = ["document.create", "document.open_default", "document.duplicate"].includes(commandId) && result && result.id ? { documentId: result.id } : commandId === "layer.delete" && target ? { documentId: target.documentId } : target;
    const after = mode !== "none" ? await stateGet({ ...(afterTarget ? { target: afterTarget } : {}), allowMissing: commandId === "document.close" }) : undefined;
    const checks = mode === "none" ? [] : verification.commandAssertions(commandId, payload.args || {}, before, after, result);
    if (checks.some((check) => check.status === "fail")) throw new PluginError("VERIFICATION_FAILED", "Command postcondition failed", { checks, effect: mutating ? "applied" : "not_applied" });
    const evidence = mode === "preview" && commandId !== "document.close" ? [await evidenceImaging.capture({ target: afterTarget, maxEdge: 1024, format: "png" })] : [];
    return { commandId, result, ...(mode === "none" ? {} : { before, after }),
      verification: { mode, checks, visualJudgment: "not_performed" }, ...(evidence.length ? { evidence } : {}), undo: { available: false } };
  };
  // Read-only commands still bind explicit document/layer IDs. Imaging runs
  // modally without a history suspension.
  return mutating || mode === "preview"
    ? inModal(commandId, execute, mutating && HISTORY_SUSPEND_COMMANDS.has(commandId), context, target)
    : targets.withTarget(target, execute, false);
}

async function approvalRequest(payload = {}, context = {}) {
  if (!payload.jobId || !payload.commandId) throw new PluginError("PRECONDITION_FAILED", "approval.request requires jobId and commandId");
  if (typeof payload.consequence !== "string" || !payload.consequence.trim()) {
    throw new PluginError("PRECONDITION_FAILED", "approval.request requires a non-empty consequence");
  }
  if (typeof payload.scopeDigest !== "string" || payload.scopeDigest.trim().length < 16) {
    throw new PluginError("PRECONDITION_FAILED", "approval.request requires a scopeDigest of at least 16 characters");
  }
  return enqueueUserJob(payload, context, "approval", "이 명령의 위험도와 내용을 확인한 뒤 승인 또는 거부하세요.");
}

function onApprovalRequest(listener) {
  approvalListeners.add(listener);
  return () => approvalListeners.delete(listener);
}

function markApprovalJob(jobId, status) {
  const job = jobs.get(jobId);
  if (job && !["completed", "cancelled", "failed"].includes(job.status)) {
    job.status = status;
    job.updatedAt = new Date().toISOString();
  }
}

function validateAdvancedPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PluginError("APPROVAL_REQUIRED", "Advanced payload must be an object");
  }
  if (payload.dialog_policy !== undefined && payload.dialog_policy !== "silent" && payload.dialog_policy !== "dontDisplay") {
    throw new PluginError("APPROVAL_REQUIRED", "Advanced execution cannot display native dialogs");
  }
  const descriptors = payload.descriptors;
  if (!Array.isArray(descriptors) || descriptors.length === 0 || descriptors.length > 100) {
    throw new PluginError("PRECONDITION_FAILED", "Advanced payload must contain 1-100 descriptors");
  }
  let serialized;
  try { serialized = JSON.stringify(descriptors); } catch (_) { throw new PluginError("APPROVAL_REQUIRED", "Advanced descriptors must be serializable"); }
  if (typeof serialized !== "string" || serialized.length > 1024 * 1024) {
    throw new PluginError("APPROVAL_REQUIRED", "Advanced payload exceeds the 1 MiB limit");
  }
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
      throw new PluginError("APPROVAL_REQUIRED", "Advanced descriptor must be an object");
    }
    const objectName = descriptor._obj;
    if (objectName !== "deselect" && objectName !== "invert") {
      throw new PluginError("APPROVAL_REQUIRED", `Advanced descriptor is not allowlisted: ${String(objectName || "missing _obj")}`);
    }
    if (Object.keys(descriptor).some((key) => key !== "_obj" && key !== "_options")) {
      throw new PluginError("APPROVAL_REQUIRED", `Advanced ${objectName} descriptor contains unreviewed keys`);
    }
    if (descriptor._options !== undefined) {
      const options = descriptor._options;
      if (!options || typeof options !== "object" || Array.isArray(options)) {
        throw new PluginError("APPROVAL_REQUIRED", "Advanced descriptor _options must be an object");
      }
      const entries = Object.entries(options);
      if (entries.length !== 1 || entries[0][0] !== "dialogOptions" || entries[0][1] !== "dontDisplay") {
        throw new PluginError("APPROVAL_REQUIRED", "Advanced descriptors may only use dialogOptions=dontDisplay");
      }
    }
  }
  return descriptors;
}

async function advancedBatchPlay(payload = {}, context = {}) {
  const descriptors = validateAdvancedPayload(payload);
  const target = payload.target || targets.captureTarget(context.serverId);
  return inModal("advanced.batchplay", async () => { if (context.markEffect) context.markEffect("partial"); const result = await batchPlay(descriptors, "dontDisplay"); if (context.markEffect) context.markEffect("applied"); return { result }; }, true, context, target);
}

async function jobResume(payload = {}) {
  const jobId = payload.jobId || payload.job_id;
  const job = jobs.get(jobId);
  if (!job) throw new PluginError("PRECONDITION_FAILED", `Unknown job: ${jobId || "(missing)"}`);
  if (job.kind === "approval") {
    throw new PluginError("APPROVAL_REQUIRED", "approval jobs can only be completed by an explicit panel decision");
  }
  if (job.kind === "user_assisted") {
    throw new PluginError("REQUIRES_USER", "user_assisted jobs can only be completed by an explicit panel decision");
  }
  if (job.kind !== "runtime") throw new PluginError("PRECONDITION_FAILED", `Job type is not remotely resumable: ${job.kind || "unknown"}`);
  if (job.status !== "awaiting_user") throw new PluginError("PRECONDITION_FAILED", `Job is ${job.status}`);
  job.status = "completed";
  job.completedAt = new Date().toISOString();
  return job;
}

async function jobCancel(payload = {}) {
  const jobId = payload.jobId || payload.job_id;
  const job = jobs.get(jobId);
  if (!job) throw new PluginError("PRECONDITION_FAILED", `Unknown job: ${jobId || "(missing)"}`);
  if (["completed", "failed", "cancelled"].includes(job.status)) return job;
  job.status = "cancelled";
  job.cancelledAt = new Date().toISOString();
  return job;
}

async function dispatch(kind, payload, context) {
  switch (kind) {
    case "host.describe": return hostDescribe();
    case "state.get": return stateGet(payload);
    case "target.capture": return targets.captureTarget(context && context.serverId);
    case "target.inspect": return inModal("target.inspect", async () => verification.projection(payload.target), false, context, payload.target);
    // Photoshop 25+ requires imaging.getPixels/encodeImageData to run inside
    // a modal scope even though this route is read-only. Do not suspend
    // history: preview generation must not create an undo entry.
    case "preview.get": return inModal("preview.get", () => previewGet(payload), false, context, payload.target);
    case "command.execute": return commandExecute(payload, context);
    case "advanced.batchplay": return advancedBatchPlay(payload, context);
    case "approval.request": return approvalRequest(payload, context);
    case "job.resume": return jobResume(payload);
    case "job.cancel": return jobCancel(payload);
    case "automation.capabilities": return require("./automation").capabilities();
    case "automation.execute": return require("./automation").execute(payload, context, { inModal, batchPlay, executeStable });
    case "operation.verify": return inModal("operation.verify", async () => verification.evaluate(payload.assertions || [], verification.projection(payload.target)), false, context, payload.target);
    default: throw new PluginError("UNSUPPORTED", `Unsupported request kind: ${kind}`);
  }
}

module.exports = { dispatch, hostDescribe, stateGet, previewGet, commandExecute, advancedBatchPlay, validateAdvancedPayload, onApprovalRequest, markApprovalJob, validateCoreArgs, batchPlay, inModal };
