import assert from "node:assert/strict";
import { createHmac, randomUUID, webcrypto } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import { inflateSync } from "node:zlib";
import { BridgeServer } from "../src/bridge.js";
import { JobStore } from "../src/jobs.js";
import type { ServerConfig } from "../src/config.js";
import { HostOperationJournal, type HostOperationRecord } from "../src/runtime-journal.js";
import { PhotoshopAutomationAdapter } from "../src/adobe-automation-adapter.js";
import { AssetStore } from "../src/automation/assets.js";
import { digest } from "../src/automation/canonical.js";
import type { OperationRequest } from "../src/automation/contracts.js";
import { encodePng } from "../src/png.js";
import { readPhotoshopFileMetadata } from "../src/image-metadata.js";
import { startRuntimeOwner } from "../src/runtime-owner.js";
import { RuntimeClient } from "../src/runtime-client.js";
import { runtimeIdentity } from "../src/runtime-version.js";

async function settings(): Promise<ServerConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "ps-owner-direct-"));
  return { dataDir, exportDir: join(dataDir, "exports"), portStart: 51331, portEnd: 51351, commandTimeoutMs: 1000, approvalMode: "auto", advancedProfile: "safe", allowedRoots: [dataDir], serverId: "test-installation", bridgeToken: "test-token-abcdefghijklmnopqrstuvwxyz123456789", pairedPluginInstanceId: "test-plugin" };
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("owner retains one dispatch across concurrent retries, caller timeout, late ACK, and restart", async () => {
  const config = await settings(); let bridge = new BridgeServer(config, new JobStore());
  try {
    const port = await bridge.start();
    const headers = { Authorization: `Bearer ${config.bridgeToken}`, "X-Plugin-Instance": "test-plugin", "X-Host-Epoch": "host-test-epoch" };
    let pollSettled = false;
    const poll = fetch(`http://127.0.0.1:${port}/v1/poll`, { headers }).then(response => { pollSettled = true; return response.json(); });
    for (let attempt = 0; attempt < 100 && !bridge.status().connected; attempt++) await sleep(5);
    assert.equal(bridge.status().connected, true);
    assert.equal(pollSettled, false, "an idle long poll remains pending");
    const operationId = randomUUID(); const requestDigest = digest({ edit: "same" });
    const short = bridge.dispatch("command.execute", { commandId: "layer.rename", args: { name: "Edited" } }, 25, { operationId, requestDigest });
    const timedOut = assert.rejects(short, (error: any) => error.code === "OUTCOME_UNKNOWN");
    const duplicate = bridge.dispatch("command.execute", { ignoredTransportPayload: true }, 1000, { operationId, requestDigest });
    const command = await poll;
    await assert.rejects(bridge.dispatch("command.execute", {}, 100, { operationId, requestDigest: digest("different") }), (error: any) => error.code === "IDEMPOTENCY_CONFLICT");
    await timedOut;
    assert.equal(bridge.operation(operationId)?.command.requestId, command.requestId);
    assert.equal(bridge.hasActiveOperations(), true);
    const body = { requestId: command.requestId, nonce: command.nonce, operationId, hostEpoch: "host-test-epoch", ok: true, effect: "applied", data: { renamed: true } };
    const post = () => fetch(`http://127.0.0.1:${port}/v1/result`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post()).status, 202);
    assert.deepEqual((await duplicate).data, { renamed: true });
    assert.equal((await post()).status, 202, "lost ACK retries acknowledge the same durable result");
    await bridge.stop(); bridge = new BridgeServer(config, new JobStore()); await bridge.start();
    const retained = await bridge.dispatch("command.execute", {}, 100, { operationId, requestDigest });
    assert.deepEqual(retained.data, { renamed: true });
    assert.equal(bridge.status().queuedCommands, 0, "restarting cannot replay an acknowledged edit");
  } finally { await bridge.stop(); await rm(config.dataDir, { recursive: true, force: true }); }
});

test("cancelled terminal jobs cannot revive from a late completed result", () => {
  const store = new JobStore(); const job = store.create("edit", "running");
  assert.equal(store.cancel(job.id).status, "cancel_requested");
  store.update(job.id, { status: "cancelled" });
  assert.equal(store.update(job.id, { status: "completed", result: { late: true } }).status, "cancelled");
});

test("canonical Photoshop receipt preserves exact layer target and observed projection", async () => {
  const config = await settings(); const assets = new AssetStore({ output: config.dataDir }, config.dataDir); await assets.initialize();
  const operationId = randomUUID(); const host = { app: "photoshop" as const, installationId: config.serverId, hostEpoch: "host-unit-epoch" };
  const req: OperationRequest = { contractVersion: "1.0", jobId: randomUUID(), revisionId: randomUUID(), stepKey: "transform", operationId, executionNamespaceId: "unit", operation: "ps.layer.transform", host, target: { kind: "ps_layer", host, documentId: 71, workingAssetId: "working:unit", layerIds: [11] }, args: { x: 4 }, assets: {}, assertions: [], waitTimeoutMs: 100, executionDeadline: new Date(Date.now() + 10000).toISOString() };
  const projection = { layerKind: "pixel", bounds: { x: 4, y: 0, width: 10, height: 10 }, ancestorFingerprints: [], visible: true, opacity: 100, blendMode: "normal" };
  const journal = new HostOperationJournal(join(config.dataDir, "host-operations.ndjson")); await journal.load();
  const nativeId = randomUUID();
  await journal.write({ durable: true, acceptedAt: new Date().toISOString(), dispatchedAt: new Date().toISOString(), finalizedAt: new Date().toISOString(), command: { operationId, requestDigest: digest(req), ownerGeneration: "previous-owner", dispatchSequence: 1, requestId: nativeId, nonce: "nonce", deadline: Date.now() + 10000, kind: "automation.execute", payload: { canonicalRequest: req } }, result: { requestId: nativeId, nonce: "nonce", operationId, ok: true, hostEpoch: host.hostEpoch, effect: "applied", data: { dataSchemaId: "ps.layer_change.v1", data: { affectedLayerIds: [11], changed: true, changeKind: "transform", bounds: projection.bounds }, document: { documentId: 71, workingAssetId: "working:unit", width: 32, height: 32, bitDepth: 8, iccProfile: "sRGB IEC61966-2.1", layerCount: 1 }, layers: [{ id: 11, name: "duplicate display name", projection }], layerId: 11, verification: [], evidence: [], snapshot: { document: { documentId: 71, workingAssetId: "working:unit", historyStateId: 5 } } } } });
  const bridge = new BridgeServer(config, new JobStore());
  try {
    await bridge.start(); const adapter = new PhotoshopAutomationAdapter(config, bridge, assets);
    const receipt = await adapter.getReceipt(operationId);
    assert.equal(receipt?.status, "SUCCEEDED", JSON.stringify(receipt));
    const resource = receipt!.resources.layer;
    assert.equal(resource?.kind, "single");
    if (resource?.kind !== "single") throw new Error("Missing layer resource");
    assert.equal(resource.item.value.kind, "ps_layer");
    assert.equal(resource.item.structuralFingerprint, digest(projection));
    assert.deepEqual(receipt?.targetAfter, req.target);
    const fields = { "document.documentId": 71, "document.workingAssetId": "working:unit", "document.historyStateId": 5 };
    assert.deepEqual(receipt?.recovery.afterState, { projectionVersion: 1, fields, digest: digest(fields) });
    assert.deepEqual(await adapter.getReceipt(operationId), receipt);
    assert.equal(bridge.operation(operationId)?.adapterReceipt?.status, "SUCCEEDED");
  } finally { await bridge.stop(); await rm(config.dataDir, { recursive: true, force: true }); }
});

test("PNG evidence preserves RGBA bytes and staged metadata detects alpha", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ps-png-direct-"));
  try {
    const rgba = Buffer.from([230, 17, 5, 0, 19, 31, 223, 128]); const png = encodePng(rgba, 2, 1, 4);
    const chunks: Buffer[] = [];
    for (let offset = 8; offset < png.length;) { const length = png.readUInt32BE(offset); if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length)); offset += length + 12; }
    assert.deepEqual(inflateSync(Buffer.concat(chunks)), Buffer.concat([Buffer.from([0]), rgba]));
    const path = join(directory, "alpha.png"); await writeFile(path, png);
    assert.deepEqual(await readPhotoshopFileMetadata(path), { format: "png", width: 2, height: 1, bitDepth: 8, alpha: "straight", embeddedIcc: false });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("versioned publication preserves an existing file and reconciles a durable publication intent without another version", async () => {
  const config = await settings(); const assets = new AssetStore({ output: config.dataDir }, config.dataDir); await assets.initialize();
  const operationId = randomUUID(), jobId = randomUUID(), revisionId = randomUUID();
  const stagedPath = await assets.allocate(jobId, revisionId, `${operationId}.png`);
  await writeFile(stagedPath, encodePng(Buffer.from([10, 20, 30, 128]), 1, 1, 4));
  await writeFile(join(config.dataDir, "product.png"), "original-output");
  const staged = await assets.registerGenerated(stagedPath);
  const host = { app: "photoshop" as const, installationId: config.serverId, hostEpoch: "host-export-unit" };
  const output = { outputKey: "image", rootId: "output", relativeDirectory: "", basename: "product", format: "png", width: 1, height: 1, color: { bitDepth: 8, range: "full", alpha: "straight" }, encoding: { kind: "image", compression: "lossless", embedIcc: false }, collision: { onConflict: "version", preserveSource: true } };
  const req: OperationRequest = { contractVersion: "1.0", jobId, revisionId, stepKey: "export", operationId, executionNamespaceId: "unit", operation: "ps.document.export", host, target: { kind: "ps_document", host, documentId: 71, workingAssetId: "working:unit" }, args: { output, outputPath: stagedPath, verifyMode: "metadata_and_changed_regions" }, assets: {}, assertions: [], waitTimeoutMs: 100, executionDeadline: new Date(Date.now() + 10000).toISOString() };
  const path = join(config.dataDir, "host-operations.ndjson"), journal = new HostOperationJournal(path); await journal.load();
  const nativeId = randomUUID();
  await journal.write({ durable: true, acceptedAt: new Date().toISOString(), dispatchedAt: new Date().toISOString(), finalizedAt: new Date().toISOString(), command: { operationId, requestDigest: digest(req), ownerGeneration: "owner", requestId: nativeId, nonce: "nonce", deadline: Date.now() + 10000, kind: "automation.execute", payload: { canonicalRequest: req } }, result: { requestId: nativeId, nonce: "nonce", operationId, ok: true, hostEpoch: host.hostEpoch, effect: "applied", data: { dataSchemaId: "export.completed.v1", data: null, document: { documentId: 71, workingAssetId: "working:unit", width: 1, height: 1, bitDepth: 8, iccProfile: null, layerCount: 1 }, layers: [], verification: [], evidence: [], snapshot: { document: { documentId: 71, workingAssetId: "working:unit", historyStateId: 5 } }, exported: { path: stagedPath, sha256: staged.sha256, reopened: { width: 1, height: 1, colorProfile: null, layerCount: 1 } } } } });
  let bridge = new BridgeServer(config, new JobStore());
  try {
    await bridge.start(); let adapter = new PhotoshopAutomationAdapter(config, bridge, assets);
    const first = await adapter.getReceipt(operationId); assert.equal(first?.status, "SUCCEEDED", JSON.stringify(first));
    assert.equal(await readFile(join(config.dataDir, "product.png"), "utf8"), "original-output");
    assert.equal(first?.artifacts[0]?.asset.relativePath, "product-1.png");
    // Model the exact crash boundary: file link exists, final receipt append did
    // not complete. The persisted destination intent is sufficient to reconcile.
    const intent = bridge.operation(operationId)!; delete intent.adapterReceipt; intent.publication!.state = "intent"; delete intent.publication!.asset;
    await bridge.stop(); await writeFile(path, `${JSON.stringify(intent)}\n`);
    bridge = new BridgeServer(config, new JobStore()); await bridge.start(); adapter = new PhotoshopAutomationAdapter(config, bridge, assets);
    const recovered = await adapter.getReceipt(operationId); assert.equal(recovered?.status, "SUCCEEDED", JSON.stringify(recovered));
    assert.equal(recovered?.artifacts[0]?.asset.relativePath, "product-1.png");
    assert.equal((await readdir(config.dataDir)).includes("product-2.png"), false);
  } finally { await bridge.stop(); await rm(config.dataDir, { recursive: true, force: true }); }
});

function uxpModules(photoshop: Record<string, unknown>) {
  const cache = new Map<string, any>();
  const load = (path: string): any => {
    if (cache.has(path)) return cache.get(path).exports;
    const module = { exports: {} as any }; cache.set(path, module);
    const require = (name: string) => name === "photoshop" ? photoshop : name.endsWith("storage") ? { randomId: () => "host-unit-epoch" } : name.startsWith(".") ? load(resolve(dirname(path), `${name}.js`)) : (() => { throw new Error(`Unexpected native import: ${name}`); })();
    const wrapped = vm.runInNewContext(`(function(require,module,exports){${readFileSync(path, "utf8")}\n})`, { crypto: webcrypto, TextEncoder, Uint8Array, Int32Array, console, setTimeout, clearTimeout }, { filename: path });
    wrapped(require, module, module.exports); return module.exports;
  };
  return (name: string) => load(resolve(`apps/uxp-plugin/lib/${name}.js`));
}

test("UXP binds IDs across focus changes, rejects error descriptors, and reports cancel-too-late truthfully", async () => {
  const layer = (id: number) => ({ id, name: "same name", kind: "normal", visible: true, opacity: 100, bounds: { left: 0, top: 0, right: 10, bottom: 10 } });
  const firstLayer = layer(11), secondLayer = layer(22);
  const first = { id: 1, layers: [firstLayer], activeLayers: [firstLayer] }; const second = { id: 2, layers: [secondLayer], activeLayers: [secondLayer] };
  const app = { version: "27.9.0", documents: [first, second], activeDocument: second };
  const load = uxpModules({ app, constants: {}, action: { batchPlay: async () => [{ _obj: "error", result: -1, message: "native failure" }] }, core: { executeAsModal: async (callback: any) => callback({}) }, imaging: {} });
  const targets = load("targets"); targets.bindWorkingAsset(first, "working:first");
  await targets.withTarget({ documentId: 1, layerIds: [11], workingAssetId: "working:first" }, async () => { assert.equal(targets.currentLayer().id, 11); assert.equal(app.activeDocument.id, 1); });
  assert.equal(app.activeDocument.id, 2);
  assert.throws(() => targets.resolveTarget({ documentId: 2, workingAssetId: "working:forged" }), (error: any) => error.code === "STALE_TARGET");
  let documentSnapshotReads = 0;
  Object.defineProperty(first, "width", { get: () => { documentSnapshotReads++; return 10; } });
  const none = await load("commands").commandExecute({ commandId: "layer.rename", args: { name: "Changed" }, target: { documentId: 1, layerIds: [11], workingAssetId: "working:first" }, prerequisites: [], verification: "none" }, {});
  assert.equal(firstLayer.name, "Changed"); assert.equal(none.before, undefined); assert.equal(none.after, undefined); assert.equal(documentSnapshotReads, 0, "none does not read optional full-document snapshots");
  await assert.rejects(load("commands").batchPlay([{ _obj: "invert" }]), (error: any) => error.code === "HOST_ERROR");
  assert.equal(load("verification").evaluate([{ id: "unsupported", subject: "layer.name", operator: "invented", expected: "x" }], {})[0].status, "not_run");
  const operations = load("operations"); const id = randomUUID(); let executions = 0; let finish!: () => void;
  const barrier = new Promise<void>(resolve => { finish = resolve; });
  const request = { executionProtocol: operations.EXECUTION_PROTOCOL, operationId: id, requestId: id, nonce: "nonce", requestDigest: digest("one-edit"), ownerGeneration: "owner-unit-1", dispatchSequence: 1, hostEpoch: operations.hostEpoch, deadline: Date.now() + 10000 };
  const execute = async (context: any) => { executions++; context.markEffect("applied"); await barrier; return { actualEdit: true }; };
  const running = operations.executeOperation(request, execute); const duplicate = operations.executeOperation(request, execute);
  operations.requestCancel(id); finish(); const receipt = await running;
  assert.equal(receipt.ok, true); assert.equal(receipt.effect, "applied"); assert.equal(receipt.cancelRequested, true);
  assert.equal((await duplicate).operationId, id); assert.equal(executions, 1);
});

test("legacy migration blocks unauthorised execution metadata and an authenticated standalone bridge", async () => {
  const load = uxpModules({ app: {}, constants: {} }), operations = load("operations");
  let nativeExecutions = 0;
  const legacy = { requestId: randomUUID(), nonce: "legacy-nonce", deadline: Date.now() + 10000, kind: "command.execute", payload: {} };
  await assert.rejects(operations.executeOperation(legacy, async () => { nativeExecutions++; }), (error: any) => error.code === "PRECONDITION_FAILED");
  assert.equal(nativeExecutions, 0);
  const request = { ...legacy, executionProtocol: operations.EXECUTION_PROTOCOL, operationId: randomUUID(), requestDigest: digest("migration-edit"), ownerGeneration: "owner-unit-current", dispatchSequence: 1, hostEpoch: operations.hostEpoch };
  const client = new (load("bridge").BridgeClient)(async () => {});
  assert.throws(() => client.validateRequest(request, { protocol: "ps-mcp-bridge/3" }), (error: any) => error.code === "CAPABILITY_UNAVAILABLE");
  const authority = { protocol: "ps-mcp-bridge/4", executionProtocol: operations.EXECUTION_PROTOCOL, ownerGeneration: request.ownerGeneration };
  assert.throws(() => client.validateRequest({ ...request, ownerGeneration: "owner-unit-other" }, authority), (error: any) => error.code === "PRECONDITION_FAILED");
  client.validateRequest(request, authority);
  assert.equal((await operations.executeOperation(request, async () => { nativeExecutions++; return {}; })).ok, true); assert.equal(nativeExecutions, 1);
  const config = await settings();
  const server = createServer((req, res) => {
    const challenge = new URL(req.url!, "http://localhost").searchParams.get("challenge")!;
    const proof = createHmac("sha256", config.bridgeToken).update(["ps-mcp-bridge/3", config.serverId, String(config.portStart), "0", challenge].join("\n")).digest("base64url");
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ protocol: "ps-mcp-bridge/3", serverId: config.serverId, port: config.portStart, secretGeneration: 0, proof }));
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    config.portStart = config.portEnd = (server.address() as { port: number }).port;
    await assert.rejects(new RuntimeClient(config).stopIfRunning(), (error: any) => error.code === "LEGACY_BRIDGE_ACTIVE");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(config.dataDir, { recursive: true, force: true }); }
});

test("terminal receipt retention compacts large bodies but preserves identity, unknown outcomes and unpublished native results", async () => {
  const config = await settings(), path = join(config.dataDir, "host-operations.ndjson");
  const journal = new HostOperationJournal(path, { completedRecords: 1, completedBytes: 4096 }); await journal.load();
  const make = (operationId: string, label: string, bytes = 400): HostOperationRecord => ({ durable: true, acceptedAt: "2026-01-01T00:00:00.000Z", finalizedAt: "2026-01-01T00:00:01.000Z",
    command: { operationId, requestDigest: digest(operationId), requestId: operationId, nonce: `nonce-${operationId}`, deadline: Date.now() + 10000, kind: "command.execute", payload: { label } },
    result: { requestId: operationId, nonce: `nonce-${operationId}`, operationId, ok: true, effect: "applied", data: { rawPixels: label + "x".repeat(bytes) } } });
  try {
    const pending = make("pending", "pending-body"); delete pending.result; delete pending.finalizedAt; await journal.write(pending);
    const unknown = make("unknown", "unknown-body"); unknown.result!.effect = "unknown"; await journal.write(unknown);
    const unfinished = make("unpublished", "unpublished-body"); unfinished.command.kind = "automation.execute"; await journal.write(unfinished);
    await journal.write(make("old", "expired-old-body")); await journal.write(make("recent", "expired-recent-body"));
    assert.equal(journal.records.get("old")?.result?.error?.code, "RESULT_EXPIRED"); assert.equal(journal.records.get("recent")?.expired, undefined);
    await journal.write(make("oversize", "expired-oversize-body", 8000));
    for (const id of ["old", "recent", "oversize"]) { assert(journal.records.get(id)?.expired); assert.deepEqual(journal.records.get(id)?.command.payload, {}); }
    for (const id of ["pending", "unknown", "unpublished"]) assert.equal(journal.records.get(id)?.expired, undefined);
    const compacted = await readFile(path, "utf8"); assert(!compacted.includes("expired-old-body")); assert(!compacted.includes("expired-oversize-body")); assert(compacted.includes("unpublished-body"));
    const replayed = new HostOperationJournal(path); await replayed.load(); assert.equal(replayed.records.size, 6); assert(replayed.records.get("old")?.expired);
    const bridge = new BridgeServer(config, new JobStore());
    const receipt = await bridge.dispatch("command.execute", {}, 50, { operationId: "old", requestDigest: digest("old") });
    assert.equal(receipt.error?.code, "RESULT_EXPIRED"); assert.equal(bridge.status().queuedCommands, 0);
    await assert.rejects(bridge.dispatch("command.execute", {}, 50, { operationId: "old", requestDigest: digest("changed") }), (error: any) => error.code === "IDEMPOTENCY_CONFLICT");
    await bridge.stop();
  } finally { await rm(config.dataDir, { recursive: true, force: true }); }
});

test("raster source-state is captured once and stale generated patches cannot approve a newer history state", async () => {
  const config = await settings(), assets = new AssetStore({ output: config.dataDir }, config.dataDir); await assets.initialize();
  let historyStateId = 7;
  const host = { app: "photoshop" as const, installationId: config.serverId, hostEpoch: "host-source-unit" };
  const bridge = { status: () => ({ connected: true, hostEpoch: host.hostEpoch }), dispatch: async (kind: string) => ({ ok: true,
    data: kind === "automation.capabilities" ? ["ps.raster.capture", "ps.layer.patch"].map(id => ({ id, state: "available" })) : { document: { documentId: 71, workingAssetId: "working:unit", historyStateId } } }) } as unknown as BridgeServer;
  try {
    const sourcePath = await assets.allocate("unit-job", "unit-revision", "patch.png"); await writeFile(sourcePath, encodePng(Buffer.from([10, 20, 30, 255]), 1, 1, 4)); const source = await assets.registerGenerated(sourcePath);
    const adapter = new PhotoshopAutomationAdapter(config, bridge, assets);
    const capture: OperationRequest = { contractVersion: "1.0", jobId: randomUUID(), revisionId: randomUUID(), stepKey: "capture", operationId: randomUUID(), executionNamespaceId: "unit", operation: "ps.raster.capture", host, target: { kind: "ps_document", host, documentId: 71, workingAssetId: "working:unit" }, args: {}, assets: {}, assertions: [], waitTimeoutMs: 100, executionDeadline: new Date(Date.now() + 10000).toISOString() };
    const captured = await adapter.prepare(capture); assert.equal(captured.expectedBefore?.fields["document.historyStateId"], 7);
    const patch: OperationRequest = { ...capture, operationId: randomUUID(), operation: "ps.layer.patch", stepKey: "patch", target: { kind: "ps_layer", host, documentId: 71, workingAssetId: "working:unit", layerIds: [11] }, args: { region: { x: 0, y: 0, width: 1, height: 1 } }, assets: { source }, expectedBefore: captured.expectedBefore };
    historyStateId = 8;
    await assert.rejects(adapter.prepare(patch), (error: any) => error.code === "PRECONDITION_FAILED");
    assert.equal(patch.expectedBefore?.fields["document.historyStateId"], 7);
    await assert.rejects(uxpModules({}).call(null, "verification").assertExpected(captured.expectedBefore, { document: { documentId: 71, workingAssetId: "working:unit", historyStateId: 8 } }), (error: any) => error.code === "PRECONDITION_FAILED");
  } finally { await rm(config.dataDir, { recursive: true, force: true }); }
});

test("authenticated owner shutdown refuses active work and version mismatch never spawns a second owner", async () => {
  const config = await settings(); let active = true; let stopped = false;
  const identity = runtimeIdentity();
  const host = { startRuntime: async () => {}, stopRuntime: async () => { stopped = true; }, callTool: async () => ({}), listToolDefinitions: () => [], runtimeStatus: () => ({ ...identity, buildId: "other-build" }), canStopRuntime: () => !active, callHost: async () => ({}) };
  const server = await startRuntimeOwner(config, host);
  try {
    assert(server);
    assert.equal(await startRuntimeOwner(config, host), null, "the OS endpoint chooses a single owner");
    const client = new RuntimeClient(config);
    await assert.rejects(client.ensureStarted(), (error: any) => error.code === "RUNTIME_VERSION_MISMATCH");
    await assert.rejects(client.stopIfRunning(), (error: any) => error.code === "RUNTIME_BUSY");
    active = false; assert.deepEqual(await client.stopIfRunning(), { stopped: true, alreadyStopped: false }); assert.equal(stopped, true);
  } finally { if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve())); await rm(config.dataDir, { recursive: true, force: true }); }
});
