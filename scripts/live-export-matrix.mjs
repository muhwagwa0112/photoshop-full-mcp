import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function structured(result, name) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result?.content?.find((entry) => entry.type === "text")?.text;
  if (typeof text === "string") return JSON.parse(text);
  throw new Error(`${name} returned no structured content`);
}

async function call(client, name, args = {}, timeout = 30_000) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout, maxTotalTimeout: timeout + 10_000 });
  const value = structured(result, name);
  if (result?.isError || value?.ok === false) throw new Error(`${name} failed: ${JSON.stringify(value?.error ?? value)}`);
  return value;
}

async function waitForBridge(client) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const host = await call(client, "photoshop_host_describe");
    if (host.bridge?.connected === true) return host;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("LIVE_HOST_DISCONNECTED: Photoshop did not connect within 45 seconds");
}

const expectedSignatures = {
  png: "89504e470d0a1a0a",
  jpg: "ffd8ff",
  psd: "38425053",
};
const suffix = Date.now().toString(36);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/src/index.js")],
  cwd: resolve("."),
  env: { ...process.env, PS_MCP_APPROVAL_MODE: "auto" },
  stderr: "pipe",
});
const client = new Client({ name: "photoshop-live-export-matrix", version: "2.0.0" });
let created = false;
const exports = [];
let initialState;
try {
  await client.connect(transport);
  const host = await waitForBridge(client);
  initialState = await call(client, "photoshop_state_get");
  await call(client, "photoshop_document_create", {
    width: 64,
    height: 64,
    resolution: 72,
    name: `PS_MCP_VALIDATION_export_matrix_${suffix}`,
  });
  created = true;

  for (const format of ["png", "jpg", "psd"]) {
    const fileName = `PS_MCP_VALIDATION_export_matrix_${suffix}.${format}`;
    const executed = await call(client, "photoshop_document_export", { format, file_name: fileName, quality: 10 }, 120_000);
    const result = executed?.result?.result ?? executed?.result;
    if (!result || typeof result.path !== "string") throw new Error(`${format} export returned no server path`);
    const bytes = await readFile(result.path);
    const signature = bytes.subarray(0, expectedSignatures[format].length / 2).toString("hex");
    if (signature !== expectedSignatures[format]) throw new Error(`${format} signature mismatch: ${signature}`);
    exports.push({
      format,
      path: result.path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      signature,
    });
  }

  await call(client, "photoshop_command_execute", { command_id: "document.close", args: { save: false } });
  created = false;
  const finalState = await call(client, "photoshop_state_get");
  if (finalState.documentCount !== initialState.documentCount) {
    throw new Error(`temporary document cleanup mismatch: ${initialState.documentCount} -> ${finalState.documentCount}`);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    hostVersion: host.runtime?.appVersion ?? null,
    locale: host.runtime?.locale ?? null,
    initialDocumentCount: initialState.documentCount,
    finalDocumentCount: finalState.documentCount,
    exports,
  })}\n`);
} finally {
  if (created) {
    await call(client, "photoshop_command_execute", { command_id: "document.close", args: { save: false } }).catch(() => {});
  }
  await client.close().catch(() => {});
}
