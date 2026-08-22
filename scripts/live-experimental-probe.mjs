import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const commandId = process.argv[2];
if (commandId !== "generative.upscale") {
  throw new Error("Usage: node scripts/live-experimental-probe.mjs generative.upscale");
}

function structured(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result?.content?.find((entry) => entry.type === "text")?.text;
  if (typeof text === "string") return JSON.parse(text);
  throw new Error("MCP tool returned no structured content");
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/src/index.js")],
  cwd: resolve("."),
  env: { ...process.env, PS_MCP_APPROVAL_MODE: "auto" },
  stderr: "pipe"
});
const client = new Client({ name: "photoshop-experimental-live-probe", version: "2.0.0" });
await client.connect(transport);

const connectionDeadline = Date.now() + 30_000;
let connected = false;
while (Date.now() < connectionDeadline) {
  const described = structured(await client.callTool({ name: "photoshop_host_describe", arguments: {} }));
  if (described?.bridge?.connected === true) {
    connected = true;
    break;
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
}
if (!connected) {
  await client.close().catch(() => {});
  throw new Error("LIVE_HOST_DISCONNECTED: Photoshop UXP did not connect to the experimental probe server");
}

let createResult = null;
let targetResult = null;
const closeResults = [];
try {
  const suffix = Date.now().toString(36);
  createResult = structured(await client.callTool({
    name: "photoshop_document_create",
    arguments: { width: 64, height: 64, resolution: 72, name: `PS_MCP_VALIDATION_${commandId.replace(/\W/g, "_")}_${suffix}` }
  }));
  if (createResult.ok !== true) throw new Error(`Temporary document creation failed: ${JSON.stringify(createResult)}`);
  try {
    targetResult = structured(await client.callTool({
      name: "photoshop_command_execute",
      arguments: {
        command_id: commandId,
        args: { scale: 2 }
      }
    }, undefined, { timeout: 200_000, maxTotalTimeout: 210_000 }));
  } catch (error) {
    targetResult = { ok: false, clientError: error?.message || String(error) };
  }
} finally {
  const closeCount = targetResult?.ok === true ? 2 : 1;
  for (let index = 0; index < closeCount; index += 1) {
    try {
      closeResults.push(structured(await client.callTool({
        name: "photoshop_command_execute",
        arguments: { command_id: "document.close", args: { save: false } }
      }, undefined, { timeout: 30_000 })));
    } catch (error) {
      closeResults.push({ ok: false, message: error?.message || String(error) });
      break;
    }
  }
  await client.close().catch(() => {});
}

process.stdout.write(`${JSON.stringify({ commandId, createResult, targetResult, closeResults })}\n`);
