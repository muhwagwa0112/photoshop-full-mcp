import { createHash, randomUUID, sign } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/config.ts";
import { catalogContractDigest, evidenceReceiptPayload, normalizeLiveHostReport } from "./inventory-evidence-audit.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const featureId = "documents.lifecycle";

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
  return value;
}

async function execute(client, commandId, args = {}) {
  const value = await call(client, "photoshop_command_execute", { command_id: commandId, args }, 180_000);
  if (value.ok !== true || value.status !== "completed" || typeof value.requestId !== "string") throw new Error(`${commandId} did not complete`);
  return value;
}

async function waitForHost(client) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const host = await call(client, "photoshop_host_describe");
    const normalized = normalizeLiveHostReport(host);
    if (normalized.connected) return normalized;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("LIVE_HOST_DISCONNECTED: Photoshop did not connect within 45 seconds");
}

async function state(client) {
  return call(client, "photoshop_state_get");
}

async function previewDigest(client) {
  const raw = await client.callTool({ name: "photoshop_preview_get", arguments: { max_edge: 256 } });
  if (raw?.isError) throw new Error("photoshop_preview_get failed");
  const image = raw?.content?.find((entry) => entry.type === "image");
  if (!image || typeof image.data !== "string") throw new Error("photoshop_preview_get returned no image");
  return sha256(Buffer.from(image.data, "base64"));
}

function documentId(value) {
  const id = value?.activeDocument?.id;
  return typeof id === "number" ? id : null;
}

function assertState(value, expectedCount, expectedId, label) {
  if (value.documentCount !== expectedCount) throw new Error(`${label} document count mismatch: expected ${expectedCount}, got ${value.documentCount}`);
  if (expectedId !== undefined && documentId(value) !== expectedId) throw new Error(`${label} active document mismatch: expected ${expectedId}, got ${documentId(value)}`);
}

const features = JSON.parse(await readFile(join(repoRoot, "catalog", "features.json"), "utf8"));
const definition = features.find((entry) => entry.id === featureId);
if (!definition) throw new Error(`Unknown feature: ${featureId}`);
const config = await loadConfig();
const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const sourceName = `PS_MCP_LIFECYCLE_${suffix}`;
const duplicateName = `${sourceName}_COPY`;
const seedFileName = `${sourceName}.psd`;
const seedPath = resolve(config.exportDir, seedFileName);
if (dirname(seedPath) !== resolve(config.exportDir)) throw new Error("Lifecycle seed escaped the configured default export directory");

const privateKeyPath = join(process.env.LOCALAPPDATA || process.env.HOME || repoRoot, "PS_MCP", "evidence-signing-private.pem");
const privateKey = await readFile(privateKeyPath, "utf8");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repoRoot, "dist", "src", "index.js")],
  cwd: repoRoot,
  env: { ...process.env, PS_MCP_APPROVAL_MODE: "auto" },
  stderr: "pipe",
});
const client = new Client({ name: "photoshop-lifecycle-evidence", version: "2.0.1" });
const ownedDocumentIds = new Set();
let connected = false;
let seedCreated = false;

try {
  await client.connect(transport);
  connected = true;
  const host = await waitForHost(client);
  const initial = await state(client);
  const initialCount = initial.documentCount;
  const initialActiveId = documentId(initial);
  const requests = {};

  const created = await execute(client, "document.create", { width: 96, height: 72, resolution: 72, name: sourceName });
  requests.create = created.requestId;
  const afterCreate = await state(client);
  const sourceId = documentId(afterCreate);
  if (sourceId === null || sourceId === initialActiveId) throw new Error("Document creation did not activate a new isolated source document");
  ownedDocumentIds.add(sourceId);
  assertState(afterCreate, initialCount + 1, sourceId, "create");

  const duplicated = await execute(client, "document.duplicate", { name: duplicateName, merge_layers_only: false });
  requests.duplicate = duplicated.requestId;
  const afterDuplicate = await state(client);
  const duplicateId = documentId(afterDuplicate);
  if (duplicateId === null || duplicateId === sourceId) throw new Error("Document duplication did not activate a distinct duplicate");
  ownedDocumentIds.add(duplicateId);
  assertState(afterDuplicate, initialCount + 2, duplicateId, "duplicate");

  const closedDuplicate = await execute(client, "document.close", { save: false });
  requests.closeDuplicate = closedDuplicate.requestId;
  ownedDocumentIds.delete(duplicateId);
  const afterDuplicateClose = await state(client);
  assertState(afterDuplicateClose, initialCount + 1, sourceId, "duplicate close");
  const sourcePreviewSha256 = await previewDigest(client);

  const exported = await execute(client, "document.export", { format: "psd", file_name: seedFileName });
  requests.exportSeed = exported.requestId;
  const exportResult = exported?.result?.result ?? exported?.result;
  if (!exportResult || typeof exportResult.path !== "string" || resolve(exportResult.path) !== seedPath) throw new Error("Lifecycle seed export returned an unexpected path");
  seedCreated = true;
  const seedBytes = await readFile(seedPath);
  if (seedBytes.subarray(0, 4).toString("hex") !== "38425053") throw new Error("Lifecycle PSD seed signature mismatch");

  const opened = await execute(client, "document.open_default", { file_name: seedFileName });
  requests.openDefault = opened.requestId;
  const afterOpen = await state(client);
  const importedId = documentId(afterOpen);
  if (importedId === null || importedId === sourceId || importedId === initialActiveId) throw new Error("Default-folder open did not activate a distinct imported document");
  ownedDocumentIds.add(importedId);
  assertState(afterOpen, initialCount + 2, importedId, "open_default");
  const importedPreviewSha256 = await previewDigest(client);
  if (importedPreviewSha256 !== sourcePreviewSha256) throw new Error("Imported lifecycle seed preview does not match the exported source");

  const closedImported = await execute(client, "document.close", { save: false });
  requests.closeImported = closedImported.requestId;
  ownedDocumentIds.delete(importedId);
  const afterImportedClose = await state(client);
  assertState(afterImportedClose, initialCount + 1, sourceId, "import close");

  const closedSource = await execute(client, "document.close", { save: false });
  requests.closeSource = closedSource.requestId;
  ownedDocumentIds.delete(sourceId);
  const finalState = await state(client);
  assertState(finalState, initialCount, initialActiveId, "final restore");

  await rm(seedPath, { force: true });
  seedCreated = false;
  const fixture = {
    schemaVersion: 1,
    kind: "feature",
    featureId,
    catalogContractSha256: catalogContractDigest(definition),
    capturedAt: new Date().toISOString(),
    host: { application: host.app, appVersion: host.appVersion, locale: host.locale, pluginVersion: host.pluginVersion, protocol: host.protocol, connectedAtCapture: host.connected },
    fixture: { isolatedDocument: true, temporaryDocumentClosed: true, executionPassed: true, stateVerified: true, undoRoundTripVerified: null, previewVerified: true },
    result: "passed",
    provenance: {
      version: 1,
      method: "live-mcp-stdio-v1",
      transactionId: randomUUID(),
      requestId: requests.create,
      serverId: host.serverId,
      steps: {
        hostDescribe: true,
        validation: true,
        preview: true,
        tempDocumentClose: true,
        commandRequestIds: Object.values(requests),
        initialDocumentCount: initialCount,
        afterCreateDocumentCount: afterCreate.documentCount,
        afterDuplicateDocumentCount: afterDuplicate.documentCount,
        afterDuplicateCloseDocumentCount: afterDuplicateClose.documentCount,
        afterOpenDocumentCount: afterOpen.documentCount,
        afterImportedCloseDocumentCount: afterImportedClose.documentCount,
        finalDocumentCount: finalState.documentCount,
        initialActiveDocumentId: initialActiveId,
        sourceDocumentId: sourceId,
        duplicateDocumentId: duplicateId,
        importedDocumentId: importedId,
        finalActiveDocumentId: documentId(finalState),
        sourcePreviewSha256,
        importedPreviewSha256,
        seed: { fileName: seedFileName, bytes: seedBytes.length, sha256: sha256(seedBytes), signature: "38425053", cleanedUp: true },
        initialStateSha256: sha256(initial),
        finalStateSha256: sha256(finalState),
      },
    },
  };
  fixture.provenance.signature = sign(null, Buffer.from(JSON.stringify(evidenceReceiptPayload(fixture))), privateKey).toString("base64");
  const output = join(repoRoot, "evidence", "live", "features", `${featureId}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, featureId, output, initialDocumentCount: initialCount, finalDocumentCount: finalState.documentCount, seedCleanedUp: true })}\n`);
} finally {
  if (connected) {
    for (let attempt = 0; attempt < 3 && ownedDocumentIds.size; attempt += 1) {
      const current = await state(client).catch(() => null);
      const activeId = documentId(current);
      if (activeId === null || !ownedDocumentIds.has(activeId)) break;
      await execute(client, "document.close", { save: false }).catch(() => null);
      ownedDocumentIds.delete(activeId);
    }
    await client.close().catch(() => {});
  }
  if (seedCreated) await rm(seedPath, { force: true });
}
