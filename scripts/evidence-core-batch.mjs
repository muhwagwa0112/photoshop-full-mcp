import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { captureLiveEvidence } from "./evidence-record.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cases = [
  { commandId: "document.close", args: {} },
  { commandId: "layer.rename", args: { name: "PS_MCP_Renamed" } },
  { commandId: "layer.delete", args: {} },
  { commandId: "selection.select_all", args: {} },
  { commandId: "selection.deselect", args: {} },
  { commandId: "selection.rectangle", args: { left: 24, top: 24, right: 200, bottom: 160, feather: 0, anti_alias: true } },
  { commandId: "image.resize", args: { width: 200, height: 150 } },
  { commandId: "history.redo", args: {} },
  { commandId: "document.resize_canvas", args: { width: 360, height: 280, anchor: "middle_center" } },
  { commandId: "document.rotate", args: { angle: 90 } },
  { commandId: "layer.group_create", args: { name: "PS_MCP_Group" } },
  { commandId: "layer.visibility_set", args: { visible: false } },
  { commandId: "layer.opacity_set", args: { opacity: 42 } },
  { commandId: "layer.clipping_set", args: { clipping: true } },
  { commandId: "layer.blend_mode_set", args: { blend_mode: "multiply" } },
  { commandId: "layer.fill_opacity_set", args: { fill_opacity: 35 } },
  { commandId: "layer.locked_set", args: { locked: true } },
  { commandId: "selection.invert", args: {} },
  { commandId: "selection.ellipse", args: { left: 32, top: 24, right: 220, bottom: 180, feather: 0, anti_alias: true } },
  { commandId: "selection.expand", args: { by: 8, apply_at_canvas_bounds: false } },
  { commandId: "selection.contract", args: { by: 8, apply_at_canvas_bounds: false } },
  { commandId: "selection.feather", args: { by: 4, apply_at_canvas_bounds: false } },
  { commandId: "selection.border", args: { width: 6 } },
  { commandId: "selection.polygon", args: { points: [{ x: 40, y: 32 }, { x: 240, y: 48 }, { x: 140, y: 190 }], feather: 0, anti_alias: true } },
  { commandId: "selection.grow", args: { tolerance: 16, anti_alias: true } },
  { commandId: "selection.smooth", args: { radius: 4, apply_at_canvas_bounds: false } },
  { commandId: "text.create", args: { name: "PS_MCP_Text", content: "Photoshop MCP 27.9" } },
  { commandId: "text.content_set", args: { content: "Photoshop MCP content updated" } },
  { commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } },
  { commandId: "filter.gaussian_blur", args: { radius: 2 } },
  { commandId: "filter.sharpen", args: {} },
  { commandId: "channel.list", args: {} },
  { commandId: "channel.create", args: { name: "PS_MCP_Alpha" } },
  { commandId: "channel.duplicate", args: { name: "PS_MCP_Setup_Channel" } },
  { commandId: "channel.delete", args: { name: "PS_MCP_Setup_Channel" } },
  { commandId: "path.list", args: {} },
  { commandId: "path.create_from_selection", args: { name: "PS_MCP_Captured_Path", tolerance: 2 } },
  { commandId: "path.select", args: { name: "PS_MCP_Setup_Path" } },
  { commandId: "path.duplicate", args: { name: "PS_MCP_Setup_Path", new_name: "PS_MCP_Duplicate_Path" } },
  { commandId: "path.delete", args: { name: "PS_MCP_Setup_Path" } },
  { commandId: "path.make_selection", args: { name: "PS_MCP_Setup_Path", feather: 0, anti_alias: true } },
  { commandId: "document.duplicate", args: { name: "PS_MCP_VALIDATION_Duplicate_Document", merge_layers_only: false } },
  { commandId: "action.list", args: {} },
  { commandId: "document.export", args: { format: "png", file_name: "PS_MCP_Acceptance.png" } }
];

const results = [];
for (const entry of cases) {
  const output = join(repoRoot, "evidence", "live", "commands", `${entry.commandId}.json`);
  if (existsSync(output)) {
    results.push({ commandId: entry.commandId, status: "skipped", reason: "fixture exists" });
    continue;
  }
  try {
    const captured = await captureLiveEvidence({ commandId: entry.commandId, commandArgs: entry.args, outputPath: output, timeoutMs: 120_000 });
    results.push({ commandId: entry.commandId, status: "passed", transactionId: captured.transactionId });
  } catch (error) {
    results.push({ commandId: entry.commandId, status: "failed", error: error?.message || String(error) });
  }
}

const failed = results.filter((entry) => entry.status === "failed");
process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, results }, null, 2)}\n`);
if (failed.length) process.exitCode = 1;
