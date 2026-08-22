import { createHash, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { catalogContractDigest, evidenceReceiptPayload, normalizeLiveHostReport } from "./inventory-evidence-audit.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const featureId = process.argv[2];
if (!featureId) throw new Error("Usage: node scripts/feature-evidence-record.mjs <feature-id>");

const FEATURE_STEPS = Object.freeze({
  "documents.export": [
    { id: "document.export", args: { format: "png", file_name: "FEATURE_SUFFIX.png", quality: 10 }, signature: "89504e470d0a1a0a" },
    { id: "document.export", args: { format: "jpg", file_name: "FEATURE_SUFFIX.jpg", quality: 10 }, signature: "ffd8ff" },
    { id: "document.export", args: { format: "psd", file_name: "FEATURE_SUFFIX.psd" }, signature: "38425053" },
  ],
  "documents.canvas_image": [
    { id: "document.resize_canvas", args: { width: 300, height: 220, anchor: "middle_center" } },
    { id: "image.resize", args: { width: 240, height: 176 } },
    { id: "document.rotate", args: { angle: 90 } },
  ],
  "documents.artboards": [
    { id: "document.artboard_list", args: {} },
  ],
  "documents.color_mode": [
    { id: "document.color_mode_set", args: { mode: "grayscale" } },
    { id: "document.bits_per_channel_set", args: { bits: 16 } },
    { id: "document.profile_convert", args: { destination_profile: "Working Gray", intent: "relative_colorimetric", black_point_compensation: true, dither: false } },
  ],
  "documents.metadata": [
    { id: "document.metadata_summary_get", args: {} },
  ],
  "layers.pixel_group": [
    { id: "layer.create", args: { name: "PS_MCP_Feature_Pixel" } },
    { id: "layer.rename", args: { name: "PS_MCP_Feature_Pixel_Renamed" } },
    { id: "layer.delete", args: {} },
    { id: "layer.group_create", args: { name: "PS_MCP_Feature_Group" } },
  ],
  "layers.comps": [
    { id: "layer.create", args: { name: "PS_MCP_Feature_Comp_Layer" } },
    { id: "layer_comp.create", args: { name: "PS_MCP_Feature_Comp", comment: "Feature validation", visibility: true, position: true, appearance: true, child_comp: false } },
    { id: "layer.visibility_set", args: { visible: false } },
    { id: "layer_comp.apply", args: { name: "PS_MCP_Feature_Comp" } },
    { id: "layer_comp.duplicate", args: { name: "PS_MCP_Feature_Comp", new_name: "PS_MCP_Feature_Comp_Copy" } },
    { id: "layer_comp.recapture", args: { name: "PS_MCP_Feature_Comp" } },
    { id: "layer_comp.reset", args: { name: "PS_MCP_Feature_Comp" } },
    { id: "layer_comp.delete", args: { name: "PS_MCP_Feature_Comp_Copy" } },
    { id: "layer_comp.list", args: {} },
  ],
  "layers.transform": [
    { id: "layer.translate", args: { horizontal: 24, vertical: 16, unit: "pixels" } },
    { id: "layer.scale", args: { width_percent: 80, height_percent: 75, anchor: "middle_center", interpolation: "bicubic" } },
    { id: "layer.rotate", args: { angle: 15, anchor: "middle_center", interpolation: "bicubic" } },
  ],
  "layers.styles_blending": [
    { id: "layer.create", args: { name: "PS_MCP_Feature_Blend_Properties" } },
    { id: "layer.blend_mode_set", args: { blend_mode: "multiply" } },
    { id: "layer.fill_opacity_set", args: { fill_opacity: 72 } },
    { id: "layer.locked_set", args: { locked: true } },
  ],
  "selections.basic": [
    { id: "selection.select_all", args: {} },
    { id: "selection.deselect", args: {} },
    { id: "selection.rectangle", args: { left: 32, top: 24, right: 180, bottom: 140, feather: 0, anti_alias: true } },
    { id: "selection.invert", args: {} },
  ],
  "selections.geometric": [
    { id: "selection.rectangle", args: { left: 32, top: 24, right: 220, bottom: 160, feather: 0, anti_alias: true } },
    { id: "selection.ellipse", args: { left: 48, top: 32, right: 208, bottom: 152, feather: 0, anti_alias: true } },
    { id: "selection.polygon", args: { points: [{ x: 64, y: 144 }, { x: 128, y: 32 }, { x: 208, y: 144 }], feather: 0, anti_alias: true } },
    { id: "selection.expand", args: { by: 2, apply_at_canvas_bounds: false } },
    { id: "selection.contract", args: { by: 1, apply_at_canvas_bounds: false } },
    { id: "selection.feather", args: { by: 1, apply_at_canvas_bounds: false } },
    { id: "selection.border", args: { width: 2 } },
    { id: "selection.grow", args: { tolerance: 8, anti_alias: true } },
    { id: "selection.smooth", args: { radius: 2, apply_at_canvas_bounds: false } },
  ],
  "masks.clipping": [
    { id: "layer.create", args: { name: "PS_MCP_Feature_Lower" } },
    { id: "layer.create", args: { name: "PS_MCP_Feature_Upper" } },
    { id: "layer.clipping_set", args: { clipping: true } },
  ],
  "masks.pixel_vector": [
    { id: "text.create", args: { name: "PS_MCP_Feature_Mask_Properties", content: "Mask fixture" } },
    { id: "text.convert", args: { operation: "to_shape" } },
    { id: "mask.properties_get", args: {} },
    { id: "mask.properties_set", args: { vector_mask_density: 90, vector_mask_feather: 4 } },
  ],
  "history.snapshots": [
    { id: "layer.create", args: { name: "PS_MCP_Feature_History_State" } },
    { id: "history.state_list", args: {} },
    { id: "history.state_activate", args: { index: 0 } },
  ],
  "channels.operations": [
    { id: "layer.create", args: { name: "PS_MCP_Feature_Channel_Pixel" } },
    { id: "channel.list", args: {} },
    { id: "channel.create", args: { name: "PS_MCP_Feature_Alpha" } },
    { id: "channel.duplicate", args: { name: "PS_MCP_Feature_Alpha" } },
    { id: "channel.delete", args: { name: "PS_MCP_Feature_Alpha" } },
    { id: "channel.calculations_new", args: { blending: "multiply", opacity: 100, source1_invert: false, source2_invert: false } },
    { id: "layer.apply_image", args: { blending: "normal", opacity: 100, invert_source: false, preserve_transparency: false } },
  ],
  "filters.blur_sharpen_noise": [
    { id: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } },
    { id: "filter.gaussian_blur", args: { radius: 1.5 } },
    { id: "filter.sharpen", args: {} },
  ],
  "filters.distort_stylize": [
    { id: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } },
    { id: "filter.pinch", args: { amount: 50 } },
    { id: "filter.polar_coordinates", args: { conversion: "rectangular_to_polar" } },
    { id: "filter.ripple", args: { amount: 200, size: "medium" } },
    { id: "filter.spherize", args: { amount: 60, mode: "normal" } },
    { id: "filter.twirl", args: { angle: 180 } },
    { id: "filter.zigzag", args: { amount: 50, ridges: 8, style: "pond_ripples" } },
    { id: "filter.ocean_ripple", args: { size: 6, magnitude: 8 } },
    { id: "filter.diffuse_glow", args: { graininess: 4, glow_amount: 8, clear_amount: 10 } },
    { id: "filter.clouds", args: {} },
    { id: "filter.difference_clouds", args: {} },
  ],
  "text.typography": [
    { id: "text.create", args: { name: "PS_MCP_Feature_Typography", content: "Typography fixture\nSecond line" } },
    { id: "text.character_style_set", args: { size: 30, leading: 36, tracking: 60, faux_bold: true, faux_italic: false, horizontal_scale: 105, vertical_scale: 100, use_auto_leading: false } },
    { id: "text.convert", args: { operation: "point_to_paragraph" } },
    { id: "text.paragraph_style_set", args: { justification: "center", hyphenation: false, first_line_indent: 8, left_indent: 6, right_indent: 6, space_before: 4, space_after: 10 } },
    { id: "text.convert", args: { operation: "paragraph_to_point" } },
    { id: "text.warp_style_set", args: { style: "arc", bend: 25, direction: "horizontal", horizontal_distortion: 5, vertical_distortion: 0 } },
  ],
  "layers.text_shape": [
    { id: "text.create", args: { name: "PS_MCP_Feature_Text_Shape", content: "Text shape fixture" } },
    { id: "text.convert", args: { operation: "create_work_path" } },
    { id: "text.convert", args: { operation: "to_shape" } },
  ],
  "paths.operations": [
    { id: "path.create", args: { name: "PS_MCP_Feature_Geometry", subpaths: [{ closed: true, shape_operation: "add", points: [{ anchor: [40, 40], left_direction: [40, 40], right_direction: [40, 40], kind: "corner" }, { anchor: [220, 40], left_direction: [220, 40], right_direction: [220, 40], kind: "corner" }, { anchor: [130, 160], left_direction: [85, 160], right_direction: [175, 160], kind: "smooth" }] }] } },
    { id: "path.geometry_get", args: { name: "PS_MCP_Feature_Geometry" } },
    { id: "path.select", args: { name: "PS_MCP_Feature_Geometry" } },
    { id: "path.duplicate", args: { name: "PS_MCP_Feature_Geometry", new_name: "PS_MCP_Feature_Geometry_Copy" } },
    { id: "path.make_selection", args: { name: "PS_MCP_Feature_Geometry", feather: 0, anti_alias: true } },
    { id: "path.create_from_selection", args: { name: "PS_MCP_Feature_From_Selection", tolerance: 2 } },
    { id: "path.list", args: {} },
    { id: "path.delete", args: { name: "PS_MCP_Feature_Geometry_Copy" } },
    { id: "path.delete", args: { name: "PS_MCP_Feature_From_Selection" } },
  ],
});

if (!FEATURE_STEPS[featureId]) throw new Error(`No reviewed feature scenario exists for ${featureId}`);

function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
}

function structured(result, name) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result?.content?.find((entry) => entry.type === "text")?.text;
  if (typeof text === "string") return JSON.parse(text);
  throw new Error(`${name} returned no structured content`);
}

async function call(client, name, args = {}, timeout = 60_000) {
  const raw = await client.callTool({ name, arguments: args }, undefined, { timeout, maxTotalTimeout: timeout + 10_000 });
  const value = structured(raw, name);
  if (raw?.isError || value?.ok === false) throw new Error(`${name} failed: ${JSON.stringify(value?.error ?? value)}`);
  return { raw, value };
}

async function previewDigest(client) {
  const raw = await client.callTool({ name: "photoshop_preview_get", arguments: { max_edge: 256 } });
  if (raw?.isError) throw new Error("photoshop_preview_get failed");
  const image = raw?.content?.find((entry) => entry.type === "image");
  if (!image || typeof image.data !== "string") throw new Error("photoshop_preview_get returned no image");
  return sha256(Buffer.from(image.data, "base64"));
}

async function waitForHost(client) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const host = (await call(client, "photoshop_host_describe")).value;
    const normalized = normalizeLiveHostReport(host);
    if (normalized.connected) return { host, normalized };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("LIVE_HOST_DISCONNECTED: Photoshop did not connect within 45 seconds");
}

const features = JSON.parse(await readFile(join(repoRoot, "catalog", "features.json"), "utf8"));
const definition = features.find((entry) => entry.id === featureId);
if (!definition) throw new Error(`Unknown feature: ${featureId}`);
const privateKeyPath = join(process.env.LOCALAPPDATA || process.env.HOME || repoRoot, "PS_MCP", "evidence-signing-private.pem");
const privateKey = await readFile(privateKeyPath, "utf8");
const suffix = `PS_MCP_FEATURE_${featureId.replace(/\W/g, "_")}_${Date.now().toString(36)}`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repoRoot, "dist", "src", "index.js")],
  cwd: repoRoot,
  env: { ...process.env, PS_MCP_APPROVAL_MODE: "auto" },
  stderr: "pipe",
});
const client = new Client({ name: "photoshop-feature-evidence", version: "2.0.1" });
let created = false;
let closeRequestId = null;
try {
  await client.connect(transport);
  const { normalized } = await waitForHost(client);
  const before = (await call(client, "photoshop_state_get")).value;
  const createdEnvelope = (await call(client, "photoshop_document_create", {
    width: 256,
    height: 192,
    resolution: 72,
    name: suffix,
  })).value;
  if (createdEnvelope.ok !== true) throw new Error("Temporary document creation did not complete");
  created = true;
  const previewBeforeSha256 = await previewDigest(client);
  const requestIds = [];
  const exportChecks = [];
  for (const step of FEATURE_STEPS[featureId]) {
    const args = Object.fromEntries(Object.entries(step.args).map(([key, value]) => [key, typeof value === "string" ? value.replace("FEATURE_SUFFIX", suffix) : value]));
    const executed = (await call(client, "photoshop_command_execute", { command_id: step.id, args }, 180_000)).value;
    if (executed.ok !== true || typeof executed.requestId !== "string") throw new Error(`${step.id} did not complete`);
    requestIds.push(executed.requestId);
    if (step.signature) {
      const result = executed?.result?.result ?? executed?.result;
      if (!result || typeof result.path !== "string") throw new Error(`${step.id} returned no export path`);
      const bytes = await readFile(result.path);
      const signature = bytes.subarray(0, step.signature.length / 2).toString("hex");
      if (signature !== step.signature) throw new Error(`${step.id} file signature mismatch`);
      exportChecks.push({ format: result.format, bytes: bytes.length, sha256: sha256(bytes), signature });
    }
  }
  const after = (await call(client, "photoshop_state_get")).value;
  const previewAfterSha256 = await previewDigest(client);
  const closed = (await call(client, "photoshop_command_execute", { command_id: "document.close", args: { save: false } })).value;
  closeRequestId = closed.requestId;
  created = false;
  const finalState = (await call(client, "photoshop_state_get")).value;
  if (finalState.documentCount !== before.documentCount) throw new Error("Temporary feature document was not fully cleaned up");

  const fixture = {
    schemaVersion: 1,
    kind: "feature",
    featureId,
    catalogContractSha256: catalogContractDigest(definition),
    capturedAt: new Date().toISOString(),
    host: {
      application: normalized.app,
      appVersion: normalized.appVersion,
      locale: normalized.locale,
      pluginVersion: normalized.pluginVersion,
      protocol: normalized.protocol,
      connectedAtCapture: normalized.connected,
    },
    fixture: {
      isolatedDocument: true,
      temporaryDocumentClosed: true,
      executionPassed: true,
      stateVerified: true,
      undoRoundTripVerified: null,
      previewVerified: true,
    },
    result: "passed",
    provenance: {
      version: 1,
      method: "live-mcp-stdio-v1",
      transactionId: randomUUID(),
      requestId: requestIds[0],
      serverId: normalized.serverId,
      steps: {
        hostDescribe: true,
        validation: true,
        preview: true,
        tempDocumentClose: true,
        commandRequestIds: requestIds,
        closeRequestId,
        beforeStateSha256: sha256(before),
        afterStateSha256: sha256(after),
        finalStateSha256: sha256(finalState),
        previewBeforeSha256,
        previewAfterSha256,
        exportChecks,
      },
    },
  };
  fixture.provenance.signature = sign(null, Buffer.from(JSON.stringify(evidenceReceiptPayload(fixture))), privateKey).toString("base64");
  const output = join(repoRoot, "evidence", "live", "features", `${featureId}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, featureId, output, commandCount: requestIds.length, exportChecks })}\n`);
} finally {
  if (created) await call(client, "photoshop_command_execute", { command_id: "document.close", args: { save: false } }).catch(() => {});
  await client.close().catch(() => {});
}
