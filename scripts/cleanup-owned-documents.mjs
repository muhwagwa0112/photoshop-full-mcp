import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeLiveHostReport } from "./inventory-evidence-audit.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");
const ownedTitle = /^(?:PS_MCP_(?:VALIDATION|FEATURE|OPEN|OPEN_DEFAULT|LIFECYCLE|FRESH|FINAL)(?:_|\b)|import_[A-Za-z0-9-]+-PS_MCP_)/i;

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
  return value;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repoRoot, "dist", "src", "index.js")],
  cwd: repoRoot,
  env: { ...process.env, PS_MCP_APPROVAL_MODE: "auto" },
  stderr: "pipe",
});
const client = new Client({ name: "photoshop-owned-document-cleanup", version: "2.0.1" });
const closed = [];

try {
  await client.connect(transport);
  const deadline = Date.now() + 45_000;
  let host;
  do {
    host = normalizeLiveHostReport(await call(client, "photoshop_host_describe"));
    if (host.connected === true) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  } while (Date.now() < deadline);
  if (host?.connected !== true) throw new Error("LIVE_HOST_DISCONNECTED");

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await call(client, "photoshop_state_get");
    const title = state?.activeDocument?.title;
    if (!state?.hasDocument || typeof title !== "string") {
      process.stdout.write(`${JSON.stringify({ ok: true, apply, closed, finalDocumentCount: state?.documentCount ?? 0 })}\n`);
      break;
    }
    if (!ownedTitle.test(title)) {
      process.stdout.write(`${JSON.stringify({ ok: true, apply, closed, stoppedAtUserDocument: title, finalDocumentCount: state.documentCount })}\n`);
      break;
    }
    if (!apply) {
      process.stdout.write(`${JSON.stringify({ ok: true, apply, wouldClose: title, documentCount: state.documentCount })}\n`);
      break;
    }
    await call(client, "photoshop_command_execute", {
      command_id: "document.close",
      args: { save: false },
      idempotency_key: `cleanup-owned-${state.activeDocument.id}`,
    }, 180_000);
    closed.push({ id: state.activeDocument.id, title });
  }
} finally {
  await client.close().catch(() => {});
}
