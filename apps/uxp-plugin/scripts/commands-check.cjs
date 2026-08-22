"use strict";

const assert = require("assert");
const Module = require("module");
const path = require("path");
const fs = require("fs");

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "photoshop") {
    return { app: {}, action: {}, core: {}, imaging: {}, constants: {} };
  }
  if (request === "./storage" && parent && parent.filename.endsWith(`${path.sep}lib${path.sep}commands.js`)) {
    return {
      async getExportFolder() { return null; },
      async resolvePersistentEntry() { return null; },
      async materializeTemporaryImportFile() { return null; },
      async deleteEntry() {}
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    const commands = require("../lib/commands.js");
    const shown = [];
    commands.onApprovalRequest((job) => shown.push(job));
    const context = { serverPort: 38452, serverId: "shared-server" };

    const approval = await commands.dispatch("approval.request", {
      jobId: "approval-job",
      commandId: "advanced.batchplay",
      label: "Advanced action",
      risk: "destructive",
      consequence: "The active document pixels may be changed.",
      scopeDigest: "0123456789abcdef0123456789abcdef"
    }, context);
    assert.strictEqual(approval.awaitingUser, true);
    assert.strictEqual(shown[0].consequence, "The active document pixels may be changed.");
    assert.strictEqual(shown[0].scopeDigest, "0123456789abcdef0123456789abcdef");
    await assert.rejects(
      commands.dispatch("job.resume", { jobId: "approval-job" }, context),
      (error) => error && error.code === "APPROVAL_REQUIRED",
      "generic resume must not complete an approval job"
    );

    const assisted = await commands.dispatch("command.execute", {
      jobId: "assisted-job",
      commandId: "ui.camera_raw_filter"
    }, context);
    assert.strictEqual(assisted.awaitingUser, true);
    await assert.rejects(
      commands.dispatch("job.resume", { jobId: "assisted-job" }, context),
      (error) => error && error.code === "REQUIRES_USER",
      "generic resume must not attest completion of a user-assisted job"
    );

    const dialogIds = [
      "selection.color_range_dialog", "selection.select_and_mask_dialog",
      "filter.liquify_dialog", "filter.vanishing_point_dialog",
      "automation.batch_dialog", "output.print_dialog",
      "application.preferences_dialog", "application.workspace_dialog",
      "action.record_dialog"
    ];
    for (const [index, id] of dialogIds.entries()) {
      await assert.rejects(
        commands.dispatch("command.execute", { commandId: id }, context),
        (error) => error && error.code === "REQUIRES_USER",
        `${id} must fail closed when jobId is absent`
      );
      await assert.rejects(
        commands.dispatch("command.execute", { jobId: `invalid-dialog-job-${index}`, commandId: id, args: { automate_dialog: true } }, context),
        (error) => error && error.code === "PRECONDITION_FAILED",
        `${id} must reject undeclared automation arguments before creating a job`
      );
      const pending = await commands.dispatch("command.execute", { jobId: `dialog-job-${index}`, commandId: id }, context);
      assert.strictEqual(pending.awaitingUser, true, `${id} must enter awaiting_user`);
      const shownJob = shown[shown.length - 1];
      assert.strictEqual(shownJob.commandId, id);
      assert.strictEqual(shownJob.kind, "user_assisted");
      assert(/직접/.test(shownJob.instruction), `${id} must clearly instruct manual Photoshop interaction`);
      assert(/완료/.test(shownJob.instruction) && /취소/.test(shownJob.instruction), `${id} must explain both completion and cancellation`);
    }

    await assert.rejects(
      commands.dispatch("approval.request", {
        jobId: "short-digest",
        commandId: "advanced.batchplay",
        consequence: "Changes pixels",
        scopeDigest: "short"
      }, context),
      (error) => error && error.code === "PRECONDITION_FAILED",
      "short scope digests must fail closed"
    );

    const expandedIds = [
      "document.open_default", "document.duplicate", "document.resize_canvas", "document.rotate",
      "layer.group_create", "layer.visibility_set", "layer.opacity_set",
      "selection.invert", "selection.rectangle", "text.create", "text.content_set",
      "document.color_mode_set", "document.bits_per_channel_set", "document.profile_convert", "document.metadata_summary_get"
    ];
    const secondDomIds = [
      "selection.ellipse", "selection.expand", "selection.contract",
      "selection.feather", "selection.border", "layer.clipping_set",
      "layer.blend_mode_set", "layer.fill_opacity_set", "layer.locked_set",
      "filter.gaussian_blur", "filter.sharpen", "filter.add_noise"
    ];
    const distortRenderIds = [
      "filter.pinch", "filter.polar_coordinates", "filter.ripple", "filter.spherize",
      "filter.twirl", "filter.zigzag", "filter.ocean_ripple", "filter.diffuse_glow",
      "filter.clouds", "filter.difference_clouds"
    ];
    const textDomIds = [
      "text.character_style_set", "text.paragraph_style_set", "text.warp_style_set", "text.convert"
    ];
    const channelPathIds = [
      "channel.list", "channel.create", "channel.duplicate", "channel.delete",
      "channel.calculations_new", "layer.apply_image",
      "path.list", "path.select", "path.duplicate", "path.delete"
    ];
    const thirdDomIds = [
      "selection.polygon", "selection.grow", "selection.smooth",
      "path.create_from_selection", "path.make_selection", "action.list"
    ];
    const layerCompIds = [
      "layer_comp.list", "layer_comp.create", "layer_comp.apply", "layer_comp.duplicate",
      "layer_comp.recapture", "layer_comp.reset", "layer_comp.delete"
    ];
    const actionIds = ["action.play"];
    const layerTransformIds = ["layer.translate", "layer.scale", "layer.rotate"];
    const publicControlIds = ["document.artboard_list", "layer.kind_inspect", "mask.properties_get", "mask.properties_set", "history.state_list", "history.state_activate"];
    const catalog = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../catalog/commands.json"), "utf8"));
    const commandSource = fs.readFileSync(path.resolve(__dirname, "../lib/commands.js"), "utf8");
    assert(commandSource.includes("attempt < 3"), "modal execution must retry bounded transient contention");
    assert(commandSource.includes("timeOut: 5"), "modal execution must wait up to five seconds for Photoshop to release short-lived modal scopes");
    assert(commandSource.includes('modalBehavior: "execute"'), "batchPlay inside executeAsModal must execute within the owned modal scope");
    assert(commandSource.includes("doc.activeHistoryState = states[index - 1]"), "undo must use the documented writable Document.activeHistoryState DOM property");
    assert(commandSource.includes("doc.activeHistoryState = states[index + 1]"), "redo must use the documented writable Document.activeHistoryState DOM property");
    assert(commandSource.includes('requireMethod(selection, "selectAll", "Selection.selectAll")'), "select all must use the documented Selection.selectAll DOM method");
    assert(commandSource.includes('requireMethod(selection, "deselect", "Selection.deselect")'), "deselect must use the documented Selection.deselect DOM method");
    assert(commandSource.includes('requireMethod(selection, "inverse", "Selection.inverse")'), "invert must use the documented Selection.inverse DOM method");
    assert(commandSource.includes('requireMethod(doc, "rotate", "Document.rotate")'), "document rotation must use the current documented Document.rotate DOM method");
    assert(commandSource.includes('requireMethod(doc, "changeMode", "Document.changeMode")'), "color mode changes must use the documented Document.changeMode DOM method");
    assert(commandSource.includes('probeMember(doc, "bitsPerChannel")'), "bit-depth changes must presence-guard the documented Document.bitsPerChannel property");
    assert(commandSource.includes('requireMethod(doc, "convertProfile", "Document.convertProfile")'), "profile conversion must use the documented Document.convertProfile DOM method");
    assert(commandSource.includes('requireMethod(app, "open", "Photoshop.open")'), "default-folder open must use the documented Photoshop.open DOM method");
    assert(commandSource.includes("context.downloadImport(args.file_name)"), "default-folder open must use the authenticated request-bound import transport");
    assert(commandSource.includes("materializeTemporaryImportFile(args.file_name, binary)"), "default-folder open must materialize bytes as a temporary UXP FileEntry");
    assert(commandSource.includes("if (temporary) await deleteEntry(temporary).catch(() => {})"), "default-folder open must best-effort delete the temporary import entry after Photoshop opens it");
    assert(commandSource.includes('commandId === "document.open_default"\n    ? { available: true, action: "close_without_save" }'), "default-folder open must describe lifecycle rollback instead of claiming a history undo");
    for (const member of ["Document.artboards", "Layer.kind", "Layer.layerMaskDensity", "Layer.layerMaskFeather", "Layer.vectorMaskDensity", "Layer.vectorMaskFeather", "Document.historyStates", "Document.activeHistoryState"]) {
      assert(commandSource.includes(`"${member}"`), `${member} must fail closed behind a runtime member guard`);
    }
    assert(commandSource.includes('xmpPacket: { status: "unavailable"'), "metadata summary must not imply active-document XMP packet access");
    assert(commandSource.includes("const safe = (read)"), "channel reads must tolerate properties that component channels do not expose");
    for (const id of [...expandedIds, ...secondDomIds, ...distortRenderIds, ...textDomIds, ...channelPathIds, ...thirdDomIds, ...layerCompIds, ...actionIds, ...layerTransformIds, ...publicControlIds]) {
      const definition = catalog.find((entry) => entry.id === id);
      assert(definition, `catalog must contain ${id}`);
      const hasFixture = fs.existsSync(path.resolve(__dirname, `../../../evidence/live/commands/${id}.json`));
      assert.strictEqual(definition.status, hasFixture ? "supported" : "unverified", `${id} status must match signed live evidence presence`);
      assert.strictEqual(definition.engine, "uxp_dom", `${id} must use the documented DOM engine`);
      assert(definition.inputSchema && definition.inputSchema.additionalProperties === false, `${id} must fail closed on unknown arguments`);
      if (hasFixture) {
        assert(typeof definition.evidence === "string" && definition.evidence.length > 0, `${id} must retain an evidence note`);
      } else {
        assert(/live Photoshop 27\.9 validation pending/.test(definition.evidence), `${id} must record pending live evidence`);
      }
    }
    for (const id of dialogIds) {
      const definition = catalog.find((entry) => entry.id === id);
      assert(definition, `catalog must contain ${id}`);
      assert.strictEqual(definition.status, "requires_user", `${id} must be requires_user`);
      assert.strictEqual(definition.engine, "user_assisted", `${id} must use user_assisted routing`);
      assert.strictEqual(definition.inputSchema.additionalProperties, false, `${id} must reject undeclared arguments`);
      assert(!commandSource.includes(`case "${id}"`), `${id} must not open or automate a native dialog`);
    }
    for (const id of secondDomIds) {
      assert(commandSource.includes(`case "${id}"`), `${id} must have an explicit UXP dispatch case before catalog exposure`);
    }
    for (const id of distortRenderIds) {
      assert(commandSource.includes(`case "${id}"`), `${id} must have an explicit UXP dispatch case before catalog exposure`);
    }
    for (const id of textDomIds) {
      assert(commandSource.includes(`case "${id}"`), `${id} must have an explicit UXP dispatch case before catalog exposure`);
    }
    for (const id of channelPathIds) {
      assert(commandSource.includes(`case "${id}"`), `${id} must have an explicit UXP dispatch case before catalog exposure`);
    }
    for (const id of thirdDomIds) {
      assert(commandSource.includes(`case "${id}"`), `${id} must have an explicit UXP dispatch case before catalog exposure`);
    }
    for (const method of ["Selection.selectPolygon", "Selection.grow", "Selection.smooth", "Selection.makeWorkPath", "PathItem.makeSelection"]) {
      assert(commandSource.includes(`"${method}"`), `${method} must fail closed behind a runtime method guard`);
    }
    assert(commandSource.includes('probeMember(app, "actionTree")'), "action.list must presence-probe Photoshop.actionTree without invoking actions");
    for (const method of ["Channels.add", "Channel.duplicate", "Channel.remove", "PathItem.select", "PathItem.duplicate", "PathItem.remove"]) {
      assert(commandSource.includes(`requireMethod(`) && commandSource.includes(`"${method}"`), `${method} must fail closed behind a runtime method guard`);
    }
    assert(commandSource.includes('requireMethod(doc, "calculations", "Document.calculations")'), "channel calculations must use the documented Document.calculations DOM method");
    assert(commandSource.includes('requireMethod(layer, "applyImage", "Layer.applyImage")'), "apply image must use the documented Layer.applyImage DOM method");
    assert(commandSource.includes('probeMember(doc.pathItems, "add", "function")'), "PathItems.add must be presence-probed without invocation");
    assert(commandSource.includes('requireMethod(paths, "add", "PathItems.add")'), "path.create must use the documented PathItems.add DOM method behind a runtime guard");
    assert(commandSource.includes("new app.PathPointInfo()") && commandSource.includes("new app.SubPathInfo()"), "path.create must construct documented PathPointInfo and SubPathInfo inputs");
    assert(!commandSource.includes("point.anchor =") && !commandSource.includes("point.leftDirection =") && !commandSource.includes("point.rightDirection ="), "existing read-only PathPoint geometry must never be assigned");
    for (const method of ["Layer.translate", "Layer.scale", "Layer.rotate"]) {
      assert(commandSource.includes(`requireMethod(layer, "${method.split(".")[1]}", "${method}")`), `${method} must fail closed behind a runtime method guard`);
    }
    assert(commandSource.includes("Document.componentChannels is unavailable; component-channel deletion cannot be guarded"), "channel deletion must fail closed if component channels cannot be identified");
    for (const method of ["selectEllipse", "expand", "contract", "feather", "selectBorder", "applyGaussianBlur", "applySharpen", "applyAddNoise"]) {
      assert(commandSource.includes(`probeMember(selection, "${method}"`) || commandSource.includes(`probeMember(layer, "${method}"`), `${method} must be presence-probed without invocation`);
      assert(commandSource.includes(`requireMethod(selection, "${method}"`) || commandSource.includes(`requireMethod(activeDocument().selection, "${method}"`) || commandSource.includes(`requireMethod(layer, "${method}"`), `${method} must fail closed behind a runtime method guard`);
    }
    for (const method of ["applyPinch", "applyPolarCoordinates", "applyRipple", "applySpherize", "applyTwirl", "applyZigZag", "applyOceanRipple", "applyDiffuseGlow", "applyClouds", "applyDifferenceClouds"]) {
      assert(commandSource.includes(`probeMember(layer, "${method}"`), `${method} must be presence-probed without invocation`);
      assert(commandSource.includes(`requireMethod(layer, "${method}"`), `${method} must fail closed behind a runtime method guard`);
    }
    for (const method of ["convertToParagraphText", "convertToPointText", "convertToShape", "createWorkPath"]) {
      assert(commandSource.includes(`probeMember(textItem, "${method}"`), `${method} must be presence-probed without invocation`);
      assert(commandSource.includes(`requireMethod(textItem, "${method}"`), `${method} must fail closed behind a runtime method guard`);
    }
    for (const property of ["size", "leading", "tracking", "fauxBold", "fauxItalic"]) {
      assert(commandSource.includes(`probeMember(characterStyle, "${property}")`), `CharacterStyle.${property} must be presence-probed without assignment`);
    }
    for (const property of ["justification", "hyphenation", "firstLineIndent", "leftIndent", "rightIndent", "spaceBefore", "spaceAfter"]) {
      assert(commandSource.includes(`probeMember(paragraphStyle, "${property}")`), `ParagraphStyle.${property} must be presence-probed without assignment`);
    }
    for (const property of ["style", "bend", "direction", "horizontalDistortion", "verticalDistortion"]) {
      assert(commandSource.includes(`probeMember(warpStyle, "${property}")`), `WarpStyle.${property} must be presence-probed without assignment`);
    }
    assert(commandSource.includes("requireMember(style, property"), "style property assignments must fail closed behind runtime member guards");
    for (const property of ["isClippingMask", "blendMode", "fillOpacity", "allLocked"]) {
      assert(commandSource.includes(`probeMember(layer, "${property}"`), `${property} must be presence-probed and fail closed before assignment`);
    }

    const invalidCases = [
      ["document.open_default", {}],
      ["document.open_default", { file_name: "../escape.psd" }],
      ["document.open_default", { file_name: "folder/file.psd" }],
      ["document.open_default", { file_name: "fixture.exe" }],
      ["document.open_default", { file_name: "fixture.psd", unexpected: true }],
      ["document.duplicate", { name: "" }],
      ["document.resize_canvas", { width: 0, height: 100 }],
      ["document.resize_canvas", { width: 100.5, height: 100 }],
      ["document.resize_canvas", { width: 100, height: 100, anchor: "outside" }],
      ["document.rotate", { angle: 0 }],
      ["document.color_mode_set", { mode: "indexed" }],
      ["document.bits_per_channel_set", { bits: 1 }],
      ["document.bits_per_channel_set", { bits: "16" }],
      ["document.profile_convert", { destination_profile: "", intent: "relative_colorimetric" }],
      ["document.profile_convert", { destination_profile: "Working RGB\n", intent: "relative_colorimetric" }],
      ["document.profile_convert", { destination_profile: "Working RGB", intent: "relative" }],
      ["document.profile_convert", { destination_profile: "Working RGB", intent: "perceptual", black_point_compensation: 1 }],
      ["document.profile_convert", { destination_profile: "Working RGB", intent: "perceptual", dither: "false" }],
      ["document.artboard_list", { include_layers: true }],
      ["layer.kind_inspect", { content: true }],
      ["mask.properties_get", { pixels: true }],
      ["mask.properties_set", {}],
      ["mask.properties_set", { layer_mask_density: 101 }],
      ["mask.properties_set", { layer_mask_feather: 1001 }],
      ["mask.properties_set", { vector_mask_density: -1 }],
      ["mask.properties_set", { vector_mask_feather: Infinity }],
      ["history.state_list", { snapshots_only: true }],
      ["history.state_activate", {}],
      ["history.state_activate", { index: 0, name: "New" }],
      ["history.state_activate", { index: -1 }],
      ["history.state_activate", { name: "" }],
      ["document.metadata_summary_get", { xmp: true }],
      ["layer.visibility_set", { visible: "yes" }],
      ["layer.opacity_set", { opacity: 101 }],
      ["layer.translate", { horizontal: Infinity, vertical: 0, unit: "pixels" }],
      ["layer.translate", { horizontal: 1, vertical: 1, unit: "points" }],
      ["layer.scale", { width_percent: 0, height_percent: 100 }],
      ["layer.scale", { width_percent: 100, height_percent: 100, anchor: "center" }],
      ["layer.scale", { width_percent: 100, height_percent: 100, interpolation: "lanczos" }],
      ["layer.rotate", { angle: 0 }],
      ["layer.rotate", { angle: 15, interpolation: "lanczos" }],
      ["selection.rectangle", { left: 50, top: 0, right: 20, bottom: 100 }],
      ["selection.rectangle", { left: 0, top: 0, right: Infinity, bottom: 100 }],
      ["selection.invert", { unexpected: true }],
      ["text.create", { content: "" }],
      ["text.content_set", { content: 42 }],
      ["text.character_style_set", {}],
      ["text.character_style_set", { size: 0 }],
      ["text.character_style_set", { tracking: 1001 }],
      ["text.character_style_set", { faux_bold: "true" }],
      ["text.paragraph_style_set", {}],
      ["text.paragraph_style_set", { justification: "middle" }],
      ["text.paragraph_style_set", { left_indent: 1297 }],
      ["text.warp_style_set", {}],
      ["text.warp_style_set", { style: "custom" }],
      ["text.warp_style_set", { bend: 101 }],
      ["text.convert", { operation: "rasterize" }],
      ["selection.ellipse", { left: 0, top: 0, right: 0, bottom: 10 }],
      ["selection.expand", { by: 0 }],
      ["selection.expand", { by: 1.5 }],
      ["selection.contract", { by: 501 }],
      ["selection.feather", { by: 0 }],
      ["selection.border", { width: 1.5 }],
      ["layer.clipping_set", { clipping: "true" }],
      ["layer.blend_mode_set", { blend_mode: "unknown" }],
      ["layer.fill_opacity_set", { fill_opacity: -1 }],
      ["layer.locked_set", { locked: 1 }],
      ["filter.gaussian_blur", { radius: Infinity }],
      ["filter.sharpen", { amount: 1 }],
      ["filter.add_noise", { amount: 10, distribution: "poisson", monochromatic: false }],
      ["filter.add_noise", { amount: 10, distribution: "uniform", monochromatic: "false" }],
      ["filter.pinch", { amount: 101 }],
      ["filter.polar_coordinates", { conversion: "cylindrical" }],
      ["filter.ripple", { amount: 1, size: "huge" }],
      ["filter.spherize", { amount: -101, mode: "normal" }],
      ["filter.twirl", { angle: Infinity }],
      ["filter.zigzag", { amount: 10, ridges: 2.5, style: "pond_ripples" }],
      ["filter.ocean_ripple", { size: 0, magnitude: 10 }],
      ["filter.diffuse_glow", { graininess: 1, glow_amount: 21, clear_amount: 1 }],
      ["filter.clouds", { seed: 1 }],
      ["filter.difference_clouds", { seed: 1 }],
      ["channel.list", { histogram: true }],
      ["channel.create", { name: "" }],
      ["channel.duplicate", { name: 12 }],
      ["channel.delete", {}],
      ["channel.calculations_new", { blending: "dissolve" }],
      ["channel.calculations_new", { opacity: 101 }],
      ["layer.apply_image", { invert_source: "true" }],
      ["layer.apply_image", { preserve_transparency: 1 }],
      ["path.list", { points: true }],
      ["path.create", { name: "Path", subpaths: [] }],
      ["path.create", { name: "Path", subpaths: [{ closed: true, shape_operation: "add", points: [{ anchor: [0, 0], left_direction: [0, 0], right_direction: [0, 0], kind: "corner" }, { anchor: [10, 10], left_direction: [10, 10], right_direction: [10, 10], kind: "corner" }] }] }],
      ["path.create", { name: "Path", subpaths: [{ closed: false, shape_operation: "merge", points: [{ anchor: [0, 0], left_direction: [0, 0], right_direction: [0, 0], kind: "corner" }, { anchor: [10, 10], left_direction: [10, 10], right_direction: [10, 10], kind: "corner" }] }] }],
      ["path.create", { name: "Path", subpaths: [{ closed: false, shape_operation: "add", points: [{ anchor: [0, Infinity], left_direction: [0, 0], right_direction: [0, 0], kind: "corner" }, { anchor: [10, 10], left_direction: [10, 10], right_direction: [10, 10], kind: "corner" }] }] }],
      ["path.geometry_get", { name: "" }],
      ["path.select", { name: "" }],
      ["path.duplicate", { name: "Work Path", new_name: "" }],
      ["path.delete", { name: null }],
      ["selection.polygon", { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
      ["selection.polygon", { points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] }],
      ["selection.polygon", { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: Infinity, y: 2 }] }],
      ["selection.grow", { tolerance: 1.5 }],
      ["selection.grow", { tolerance: 256 }],
      ["selection.smooth", { radius: 0 }],
      ["selection.smooth", { radius: 1, apply_at_canvas_bounds: "yes" }],
      ["path.make_selection", { name: "Work Path", feather: 251 }],
      ["action.list", { play: true }]
    ];
    for (const [id, args] of invalidCases) {
      assert.throws(
        () => commands.validateCoreArgs(id, args),
        (error) => error && error.code === "PRECONDITION_FAILED",
        `${id} must reject invalid values before Photoshop dispatch`
      );
    }
    commands.validateCoreArgs("document.open_default", { file_name: "PS_MCP_fixture.PSD" });
    commands.validateCoreArgs("document.open_default", { file_name: "PS_MCP_fixture.tiff" });
    commands.validateCoreArgs("selection.rectangle", { left: 0, top: 0, right: 100, bottom: 100, feather: 0, anti_alias: true });
    commands.validateCoreArgs("text.content_set", { content: "" });
    commands.validateCoreArgs("text.character_style_set", { size: 24, leading: 30, tracking: 20, faux_bold: true, faux_italic: false, horizontal_scale: 100, vertical_scale: 100, use_auto_leading: false });
    commands.validateCoreArgs("text.paragraph_style_set", { justification: "center", hyphenation: false, first_line_indent: 8, left_indent: 4, right_indent: 4, space_before: 2, space_after: 6 });
    commands.validateCoreArgs("text.warp_style_set", { style: "arc", bend: 25, direction: "horizontal", horizontal_distortion: 0, vertical_distortion: 0 });
    commands.validateCoreArgs("text.convert", { operation: "point_to_paragraph" });
    commands.validateCoreArgs("document.color_mode_set", { mode: "grayscale" });
    commands.validateCoreArgs("document.bits_per_channel_set", { bits: 16 });
    commands.validateCoreArgs("document.profile_convert", { destination_profile: "Adobe RGB (1998)", intent: "relative_colorimetric", black_point_compensation: true, dither: false });
    commands.validateCoreArgs("document.artboard_list", {});
    commands.validateCoreArgs("layer.kind_inspect", {});
    commands.validateCoreArgs("mask.properties_get", {});
    commands.validateCoreArgs("mask.properties_set", { layer_mask_density: 80, layer_mask_feather: 2, vector_mask_density: 90, vector_mask_feather: 4 });
    commands.validateCoreArgs("history.state_list", {});
    commands.validateCoreArgs("history.state_activate", { index: 0 });
    commands.validateCoreArgs("history.state_activate", { name: "New" });
    commands.validateCoreArgs("document.metadata_summary_get", {});
    commands.validateCoreArgs("selection.ellipse", { left: 0, top: 0, right: 100, bottom: 100, feather: 0, anti_alias: true });
    commands.validateCoreArgs("selection.expand", { by: 1, apply_at_canvas_bounds: false });
    commands.validateCoreArgs("selection.contract", { by: 500, apply_at_canvas_bounds: true });
    commands.validateCoreArgs("selection.feather", { by: 0.1 });
    commands.validateCoreArgs("selection.border", { width: 200 });
    commands.validateCoreArgs("layer.clipping_set", { clipping: true });
    commands.validateCoreArgs("layer.blend_mode_set", { blend_mode: "multiply" });
    commands.validateCoreArgs("layer.fill_opacity_set", { fill_opacity: 0 });
    commands.validateCoreArgs("layer.locked_set", { locked: false });
    commands.validateCoreArgs("layer.translate", { horizontal: -25, vertical: 10, unit: "percent" });
    commands.validateCoreArgs("layer.scale", { width_percent: 80, height_percent: 75, anchor: "middle_center", interpolation: "bicubic" });
    commands.validateCoreArgs("layer.rotate", { angle: 15, anchor: "top_left", interpolation: "bilinear" });
    commands.validateCoreArgs("filter.gaussian_blur", { radius: 0.1 });
    commands.validateCoreArgs("filter.sharpen", {});
    commands.validateCoreArgs("filter.add_noise", { amount: 400, distribution: "gaussian", monochromatic: true });
    commands.validateCoreArgs("filter.pinch", { amount: -100 });
    commands.validateCoreArgs("filter.polar_coordinates", { conversion: "rectangular_to_polar" });
    commands.validateCoreArgs("filter.ripple", { amount: 999, size: "large" });
    commands.validateCoreArgs("filter.spherize", { amount: 100, mode: "horizontal" });
    commands.validateCoreArgs("filter.twirl", { angle: -999 });
    commands.validateCoreArgs("filter.zigzag", { amount: 100, ridges: 20, style: "around_center" });
    commands.validateCoreArgs("filter.ocean_ripple", { size: 15, magnitude: 20 });
    commands.validateCoreArgs("filter.diffuse_glow", { graininess: 10, glow_amount: 20, clear_amount: 20 });
    commands.validateCoreArgs("filter.clouds", {});
    commands.validateCoreArgs("filter.difference_clouds", {});
    commands.validateCoreArgs("channel.list", {});
    commands.validateCoreArgs("channel.create", { name: "MCP Alpha" });
    commands.validateCoreArgs("channel.duplicate", { name: "MCP Alpha" });
    commands.validateCoreArgs("channel.delete", { name: "MCP Alpha" });
    commands.validateCoreArgs("channel.calculations_new", { blending: "multiply", opacity: 100, source1_invert: false, source2_invert: true });
    commands.validateCoreArgs("layer.apply_image", { blending: "normal", opacity: 100, invert_source: true, preserve_transparency: false });
    commands.validateCoreArgs("path.list", {});
    commands.validateCoreArgs("path.create", { name: "MCP Geometry", subpaths: [{ closed: true, shape_operation: "add", points: [{ anchor: [32, 32], left_direction: [32, 32], right_direction: [32, 32], kind: "corner" }, { anchor: [192, 32], left_direction: [192, 32], right_direction: [192, 32], kind: "corner" }, { anchor: [112, 144], left_direction: [72, 144], right_direction: [152, 144], kind: "smooth" }] }] });
    commands.validateCoreArgs("path.geometry_get", { name: "MCP Geometry" });
    commands.validateCoreArgs("path.select", { name: "Work Path" });
    commands.validateCoreArgs("path.duplicate", { name: "Work Path", new_name: "Work Path copy" });
    commands.validateCoreArgs("path.delete", { name: "Work Path copy" });
    commands.validateCoreArgs("selection.polygon", { points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }], feather: 0, anti_alias: true });
    commands.validateCoreArgs("selection.grow", { tolerance: 0, anti_alias: false });
    commands.validateCoreArgs("selection.smooth", { radius: 500, apply_at_canvas_bounds: true });
    commands.validateCoreArgs("path.make_selection", { name: "Work Path", feather: 250, anti_alias: false });
    commands.validateCoreArgs("action.list", {});
    commands.validateCoreArgs("action.play", { set_name: "안내선", action_name: "중심선" });
    commands.validateCoreArgs("layer_comp.list", {});
    commands.validateCoreArgs("layer_comp.create", { name: "Comp", comment: "Fixture", visibility: true, position: true, appearance: true, child_comp: false });
    commands.validateCoreArgs("layer_comp.apply", { name: "Comp" });
    commands.validateCoreArgs("layer_comp.duplicate", { name: "Comp", new_name: "Comp copy" });
    commands.validateCoreArgs("layer_comp.recapture", { name: "Comp" });
    commands.validateCoreArgs("layer_comp.reset", { name: "Comp" });
    commands.validateCoreArgs("layer_comp.delete", { name: "Comp" });
    commands.validateCoreArgs("generative.upscale", { scale: 2 });
    assert.throws(
      () => commands.validateCoreArgs("generative.upscale", { scale: 3 }),
      /scale must be 2 or 4/
    );

    const host = await commands.hostDescribe();
    assert.strictEqual(host.runtimeProbes.app.open, false);
    assert.strictEqual(host.runtimeProbes.selection.probed, false);
    assert.strictEqual(host.runtimeProbes.selection.selectEllipse, null);
    assert.strictEqual(host.runtimeProbes.layer.probed, false);
    assert.strictEqual(host.runtimeProbes.layer.applyGaussianBlur, null);
    assert.strictEqual(host.runtimeProbes.channels.probed, false);
    assert.strictEqual(host.runtimeProbes.channels.collection, null);
    assert.strictEqual(host.runtimeProbes.paths.probed, false);
    assert.strictEqual(host.runtimeProbes.selection.selectPolygon, null);
    assert.strictEqual(host.runtimeProbes.selection.grow, null);
    assert.strictEqual(host.runtimeProbes.selection.smooth, null);
    assert.strictEqual(host.runtimeProbes.actions.actionTree, false);
    assert.strictEqual(host.runtimeProbes.layerComps.probed, false);
    assert.strictEqual(host.runtimeProbes.layerComps.collection, null);
    assert.strictEqual(host.runtimeProbes.layerComps.add, null);
    assert.strictEqual(host.runtimeProbes.imaging.createLayerMask, false);
    assert.strictEqual(host.runtimeProbes.imaging.deleteLayerMask, false);
    assert.strictEqual(host.runtimeProbes.document.generativeUpscale, null);
    assert.strictEqual(host.gatedCapabilities.generative.fill.status, "unavailable");
    assert.strictEqual(host.gatedCapabilities.neuralFilters.status, "unavailable");
    assert.strictEqual(host.gatedCapabilities.entitlement.status, "not_publicly_probeable");
    for (const stateField of ["hasSelection", "activeChannels", "channelCount", "pathCount", "exportFolderConfigured"]) {
      assert(commandSource.includes(stateField), `state.get must expose positive ${stateField} prerequisite evidence`);
    }

    console.log("UXP command contract checks passed (jobs, 9 manual dialogs, catalogued DOM commands, presence-only probes and fail-closed validation)." );
  } finally {
    Module._load = originalLoad;
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
