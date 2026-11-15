"use strict";
const { app, imaging, constants } = require("photoshop");
const targets = require("./targets");
const files = require("./files");
const layers = require("./editing/layers");
const masks = require("./editing/masks");
const text = require("./editing/text");
const templates = require("./action-templates");
const evidence = require("./imaging");
const verify = require("./verification");
const { PluginError } = require("./errors");

const OPERATIONS = ["ps.document.open", "ps.document.create", "ps.document.duplicate", "ps.document.inspect", "ps.document.resize", "ps.document.convertProfile", "ps.layer.create", "ps.layer.place", "ps.layer.replacePixels", "ps.layer.transform", "ps.layer.fill", "ps.layer.mask", "ps.layer.patch", "ps.text.set", "ps.text.fit", "ps.adjustment.create", "ps.smartobject.replace", "ps.artboard.create", "ps.artboard.duplicate", "ps.document.save", "ps.document.export", "ps.evidence.capture", "ps.raster.capture"];
const TEMPLATE_OPERATIONS = new Set(["ps.adjustment.create", "ps.smartobject.replace", "ps.artboard.create", "ps.artboard.duplicate"]);
const READ_OPERATIONS = new Set(["ps.document.inspect", "ps.evidence.capture", "ps.raster.capture"]);
const LIFECYCLE_OPERATIONS = new Set(["ps.document.open", "ps.document.create", "ps.document.duplicate", "ps.artboard.duplicate", "ps.document.save", "ps.document.export"]);
function atLeast(version) {
  const actual = String(app.version || "0").split(".").map(Number), wanted = version.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((actual[i] || 0) > (wanted[i] || 0)) return true; if ((actual[i] || 0) < (wanted[i] || 0)) return false; }
  return true;
}
async function capabilities() {
  const recorded = await templates.list();
  const paragraphLayout = recorded.some(template => template.operation === "ps.text.layout" && !template.variant);
  const imagingAvailable = imaging && ["getPixels", "putPixels", "createImageDataFromBuffer"].every((key) => typeof imaging[key] === "function");
  const observed = OPERATIONS.map((id) => {
    let available = atLeast("24.2");
    let reason = "Documented DOM route; exact method and preconditions are checked on the bound document";
    if (id === "ps.document.open") available = typeof app.open === "function";
    if (id === "ps.document.create") available = typeof app.createDocument === "function" || app.documents && typeof app.documents.add === "function";
    if (["ps.layer.place", "ps.layer.replacePixels", "ps.layer.fill", "ps.layer.patch", "ps.evidence.capture", "ps.raster.capture"].includes(id)) available = available && imagingAvailable;
    if (id === "ps.layer.mask") available = available && imagingAvailable && typeof imaging.putLayerMask === "function";
    if (id.startsWith("ps.text.")) available = available && Boolean(app.fonts);
    if (id === "ps.text.fit") {
      available = available && paragraphLayout;
      reason = paragraphLayout ? "Qualified native paragraph box and rendered-line readback profile is installed; exact type/font/style are checked on the target" : "Full paragraph fitting requires a qualified ps.text.layout box and rendered-line readback profile; point-only fitting is a separate capability";
    }
    if (TEMPLATE_OPERATIONS.has(id)) {
      available = recorded.some((template) => template.operation === id);
      reason = available ? "Qualified recorded action template is installed for this exact host build" : "No qualified recorded action template is installed for this exact host build";
    }
    return { id, contractVersion: "1.0", state: available ? "available" : TEMPLATE_OPERATIONS.has(id) || id === "ps.text.fit" ? "requires_setup" : "unsupported", route: "uxp", hostVersion: String(app.version), preservesNativeEditing: true, reason };
  });
  observed.push({ id: "ps.text.fit:point", contractVersion: "1.0", state: atLeast("24.2") && Boolean(app.fonts) ? "available" : "unsupported", route: "uxp", hostVersion: String(app.version), preservesNativeEditing: true, reason: "Conditional point-only route; prepare and execution require observed isPointText, exact contents/style and native bounds. Automatic paragraph wrapping requires ps.text.layout." });
  for (const template of recorded) if (template.variant) observed.push({ id: `${template.operation}:${template.variant}`, contractVersion: "1.0", state: "available", route: "uxp", hostVersion: String(app.version), preservesNativeEditing: true, qualification: template.qualification, reason: "Exact recorded operation variant" });
  return observed;
}
function documentMode(doc) {
  const names = { RGB: "RGB", CMYK: "CMYK", LAB: "Lab", GRAYSCALE: "Grayscale", BITMAP: "Bitmap", INDEXEDCOLOR: "Indexed", MULTICHANNEL: "Multichannel", DUOTONE: "Duotone" };
  for (const [key, label] of Object.entries(names)) if (constants.DocumentMode && doc.mode === constants.DocumentMode[key]) return label;
  throw new PluginError("CAPABILITY_UNAVAILABLE", `Unknown native document mode: ${doc.mode}`);
}
function bitDepth(doc) {
  for (const [key, depth] of Object.entries({ ONE: 1, EIGHT: 8, SIXTEEN: 16, THIRTYTWO: 32 })) if (constants.BitsPerChannelType && doc.bitsPerChannel === constants.BitsPerChannelType[key]) return depth;
  if ([1, 8, 16, 32].includes(Number(doc.bitsPerChannel))) return Number(doc.bitsPerChannel);
  throw new PluginError("CAPABILITY_UNAVAILABLE", "Unknown native document bit depth");
}
function layerKind(layer, doc) {
  const kind = constants.LayerKind || {};
  if (doc.artboards && Array.from(doc.artboards).some((board) => board.id === layer.id)) return "artboard";
  if (layer.kind === kind.NORMAL) return "pixel";
  if (layer.kind === kind.TEXT) return "text";
  if (layer.kind === kind.SMARTOBJECT) return "smart_object";
  if (layer.kind === kind.GROUP) return "group";
  if (layer.kind === kind.SOLIDFILL) return "shape";
  const adjustments = ["BLACKANDWHITE", "BRIGHTNESSCONTRAST", "CHANNELMIXER", "COLORBALANCE", "COLORLOOKUP", "CURVES", "EXPOSURE", "GRADIENTMAP", "HUESATURATION", "INVERSION", "LEVELS", "PHOTOFILTER", "POSTERIZE", "SELECTIVECOLOR", "THRESHOLD", "VIBRANCE"];
  if (adjustments.some((name) => kind[name] !== undefined && layer.kind === kind[name])) return "adjustment";
  return "unknown";
}
async function inventory(doc, subtreeId) {
  const tree = targets.allLayers(doc), projections = new Map(), baseDigests = new Map();
  for (const entry of tree) {
    const layer = entry.layer;
    const projection = { layerKind: layerKind(layer, doc), bounds: targets.boundsOf(layer), visible: Boolean(layer.visible), opacity: Number(layer.opacity), blendMode: String(layer.blendMode) };
    const sourcePlacement = layers.sourcePlacement(doc, layer);
    if (sourcePlacement) projection.sourcePlacement = sourcePlacement;
    if (projection.layerKind === "text") {
      projection.text = layer.textItem.contents; projection.fontPostScriptName = layer.textItem.characterStyle.font; projection.fontSize = Number(layer.textItem.characterStyle.size);
    }
    projections.set(layer.id, projection); baseDigests.set(layer.id, await verify.digest(projection));
  }
  return tree.filter(({ layer, parents }) => subtreeId === undefined || layer.id === subtreeId || parents.includes(subtreeId)).map(({ layer, parents }) => ({ id: layer.id, name: layer.name,
    projection: { ...projections.get(layer.id), ancestorFingerprints: parents.map((id) => baseDigests.get(id)) } }));
}
function documentData(doc) {
  return { documentId: doc.id, width: Number(doc.width), height: Number(doc.height), mode: documentMode(doc), bitDepth: bitDepth(doc), resolutionPpi: Number(doc.resolution), iccProfile: doc.colorProfileName && doc.colorProfileName !== "None" ? doc.colorProfileName : null, layerCount: targets.allLayers(doc).length, workingAssetId: targets.workingAssetId(doc) };
}
async function execute(payload, context, helpers) {
  const operation = payload.operation, args = payload.args || {};
  if (!OPERATIONS.includes(operation)) throw new PluginError("CAPABILITY_UNAVAILABLE", `Unknown Photoshop operation: ${operation}`);
  if (TEMPLATE_OPERATIONS.has(operation)) await templates.get(operation, args.kind);
  let capabilityId = operation;
  if (operation === "ps.text.fit") {
    const bound = targets.resolveTarget(payload.target).layers;
    if (bound.length === 1 && bound[0].textItem && bound[0].textItem.isPointText === true && bound[0].textItem.isParagraphText !== true) capabilityId = "ps.text.fit:point";
  }
  const capability = (await capabilities()).find((item) => item.id === capabilityId);
  if (!capability || capability.state !== "available") throw new PluginError("CAPABILITY_UNAVAILABLE", capability && capability.reason || "Native capability unavailable", { effect: "not_applied" });
  const run = async () => {
    context.throwIfCancelled();
    if (payload.expectedBefore) await verify.assertExpected(payload.expectedBefore, verify.projection(payload.target));
    let doc = payload.target ? targets.currentDocument() : null, layer = null, data, dataSchemaId, exported = null, captured = [], textChecks = [];
    if (!READ_OPERATIONS.has(operation)) context.markEffect("partial");
    switch (operation) {
      case "ps.document.open": doc = await files.openWorking(payload, context); break;
      case "ps.document.create": {
        const create = app.documents && typeof app.documents.add === "function" ? app.documents.add.bind(app.documents) : app.createDocument.bind(app);
        doc = await create({ width: args.width, height: args.height, name: args.name || "MCP Working Document", resolution: args.resolution || 72,
          depth: args.bitDepth || 8, mode: constants.NewDocumentMode.RGB, fill: constants.DocumentFill.TRANSPARENT,
          ...(args.colorProfile ? { profile: args.colorProfile } : {}) });
        targets.bindWorkingAsset(doc, payload.workingAssetId); break;
      }
      case "ps.document.duplicate": doc = await doc.duplicate(args.name || "MCP Working Copy", false); targets.bindWorkingAsset(doc, payload.workingAssetId); break;
      case "ps.document.inspect": break;
      case "ps.document.resize": {
        const ratio = (args.fit === "cover" ? Math.max : Math.min)(args.width / Number(doc.width), args.height / Number(doc.height));
        await doc.resizeImage(Math.max(1, Math.round(doc.width * ratio)), Math.max(1, Math.round(doc.height * ratio)), Number(doc.resolution), constants.InterpolationMethod.AUTOMATIC);
        context.throwIfCancelled(); await doc.resizeCanvas(args.width, args.height, constants.AnchorPosition.MIDDLECENTER); break;
      }
      case "ps.document.convertProfile": {
        if (typeof doc.convertProfile !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", "Document.convertProfile is unavailable");
        const intent = constants.Intent && constants.Intent.RELATIVECOLORIMETRIC;
        if (intent === undefined) throw new PluginError("CAPABILITY_UNAVAILABLE", "Relative colorimetric profile conversion is unavailable");
        await doc.convertProfile(args.iccProfile, intent, true, true); break;
      }
      case "ps.layer.create": layer = await layers.create(doc, args.name); break;
      case "ps.layer.place": layer = await layers.place(payload, context); break;
      case "ps.layer.replacePixels": layer = await layers.place(payload, context, true); break;
      case "ps.layer.fill": layer = await layers.fill(doc, args.color, args.name, context, args.placement); break;
      case "ps.layer.transform": layer = await layers.transform(targets.currentLayer(), args, context); break;
      case "ps.layer.mask": layer = await masks.apply(payload, context); break;
      case "ps.layer.patch": layer = await layers.patch(payload, context); break;
      case "ps.text.set": layer = await text.set(targets.currentLayer(), args); break;
      case "ps.text.fit": {
        const fitted = await text.fit(targets.currentLayer(), args, context, () => templates.textLayout(payload, context, helpers.batchPlay));
        layer = fitted.layer; textChecks = fitted.verification; break;
      }
      case "ps.adjustment.create": case "ps.smartobject.replace": case "ps.artboard.create": layer = await templates.execute(payload, context, helpers.batchPlay); break;
      case "ps.artboard.duplicate": {
        const created = await templates.execute(payload, context, helpers.batchPlay);
        doc = created.document; layer = created.layer; targets.bindWorkingAsset(doc, payload.workingAssetId); break;
      }
      case "ps.document.save": case "ps.document.export": exported = await files.exportDocument(doc, payload, context); break;
      case "ps.evidence.capture": captured = [await evidence.capture({ ...args, target: payload.target, format: "png" })]; break;
      case "ps.raster.capture": captured = [await evidence.capture({ ...args, kind: args.region ? "roi" : "composite", target: payload.target, format: "png", fullResolution: true, maxRasterBytes: args.executionResources && args.executionResources.maxTemporaryBytes })]; break;
      default: throw new PluginError("CAPABILITY_UNAVAILABLE", `No handler for ${operation}`);
    }
    if (!READ_OPERATIONS.has(operation)) context.markEffect("applied");
    const info = doc ? documentData(doc) : null;
    const subtreeId = operation === "ps.artboard.duplicate" ? layer.id : operation === "ps.document.inspect" && payload.target && payload.target.kind === "ps_layer" ? payload.target.layerIds[0] : undefined;
    const observedLayers = doc ? await inventory(doc, subtreeId) : [];
    if (operation === "ps.document.inspect") { dataSchemaId = "query.inventory.v1"; data = { resourceSlot: "layers", totalReturned: observedLayers.length, complete: true }; }
    else if (operation === "ps.artboard.duplicate") { dataSchemaId = "ps.document_info.v1"; data = info; }
    else if (layer) {
      const changeKind = operation.startsWith("ps.text.") ? "text" : operation === "ps.layer.transform" ? "transform" : operation === "ps.layer.mask" ? "mask" : operation === "ps.adjustment.create" ? "adjustment" : operation === "ps.smartobject.replace" ? "smart_object" : operation.startsWith("ps.artboard.") ? "group" : operation === "ps.layer.create" || operation === "ps.layer.place" ? "create" : "pixels";
      dataSchemaId = "ps.layer_change.v1";
      data = { affectedLayerIds: [layer.id], changed: true, changeKind, bounds: targets.boundsOf(layer), finalName: layer.name, ...(operation.startsWith("ps.text.") ? { finalText: layer.textItem.contents } : {}) };
    } else if (exported) { dataSchemaId = "export.completed.v1"; data = null; }
    else if (["ps.evidence.capture", "ps.raster.capture"].includes(operation)) { dataSchemaId = "evidence.capture.v1"; data = null; }
    else { dataSchemaId = "ps.document_info.v1"; data = info; }
    const afterTarget = layer ? { documentId: doc.id, layerIds: [layer.id] } : doc ? { documentId: doc.id } : payload.target;
    const observed = verify.projection(afterTarget, data);
    const checks = [...verify.evaluate(payload.assertions || [], observed), ...textChecks];
    if (checks.some((check) => check.status === "fail")) throw new PluginError("VERIFICATION_FAILED", "Native operation postcondition failed", { checks, effect: READ_OPERATIONS.has(operation) ? "not_applied" : "applied" });
    for (const specification of payload.evidence || []) {
      if (!["composite", "layer", "roi", "mask"].includes(specification.kind)) throw new PluginError("CAPABILITY_UNAVAILABLE", `Unsupported Photoshop evidence kind: ${specification.kind}`);
      captured.push(await evidence.capture({ ...specification, target: afterTarget, format: "png" }));
    }
    return { dataSchemaId, data, document: info, layers: observedLayers, ...(layer ? { layerId: layer.id } : {}),
      verification: checks, evidence: captured, ...(exported ? { exported } : {}), snapshot: observed };
  };
  return helpers.inModal(operation, run, !READ_OPERATIONS.has(operation) && !LIFECYCLE_OPERATIONS.has(operation), context, payload.target);
}
module.exports = { capabilities, execute, inventory, documentData, layerKind };
