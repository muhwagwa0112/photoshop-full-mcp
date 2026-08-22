"use strict";

const assert = require("assert");
const Module = require("module");
const path = require("path");

const originalLoad = Module._load;
const originalFetch = global.fetch;
const calls = [];
let fetchHandler;
const temporaryEntries = [];

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return body === undefined || body === null ? "" : JSON.stringify(body); },
    async json() { return body; },
    async arrayBuffer() {
      if (body instanceof ArrayBuffer) return body;
      if (ArrayBuffer.isView(body)) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      return new TextEncoder().encode(String(body || "")).buffer;
    }
  };
}

Module._load = function load(request, parent, isMain) {
  if (request === "uxp" && parent && parent.filename.endsWith(`${path.sep}lib${path.sep}storage.js`)) {
    return {
      storage: {
        secureStorage: { async getItem() { return null; }, async setItem() {}, async removeItem() {} },
        localFileSystem: {
          async getTemporaryFolder() {
            return {
              async createFile(name, options) {
                const entry = {
                  name,
                  options,
                  writes: [],
                  deleted: false,
                  async write(binary, writeOptions) { this.writes.push({ binary, writeOptions }); },
                  async delete() { this.deleted = true; }
                };
                temporaryEntries.push(entry);
                return entry;
              }
            };
          }
        },
        formats: { binary: "binary" }
      }
    };
  }
  if (request === "./storage" && parent && parent.filename.endsWith(`${path.sep}lib${path.sep}bridge.js`)) {
    return {
      async getToken() { return "test-token"; },
      async setToken() {},
      getServer() { return { serverId: "shared-server", port: 38452 }; },
      setServer() {},
      getPluginInstanceId() { return "test-plugin"; }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

global.fetch = async (url, options) => {
  calls.push({ url, options });
  return fetchHandler(url, options);
};

(async () => {
  try {
    const bridge = require("../lib/bridge.js");

    fetchHandler = async (url) => {
      const port = Number(new URL(url).port);
      if (port === 38452 || port === 38453) return response(200, { serverId: "shared-server", protocol: bridge.PROTOCOL, port, pairingRequired: false });
      if (port === 38454) return response(200, { serverId: "other-server", protocol: bridge.PROTOCOL, port, pairingRequired: false });
      return response(404);
    };
    const servers = await bridge.discoverAll("test-token");
    assert.deepStrictEqual(servers.map((server) => server.port), [38452, 38453], "all matching servers should be discovered");

    const contexts = [];
    const client = new bridge.BridgeClient(async (kind, payload, context) => {
      contexts.push({ kind, payload, context });
      return { accepted: true };
    });
    client.running = true;
    client.servers = servers;
    client.server = servers[0];

    calls.length = 0;
    fetchHandler = async (url) => {
      const parsed = new URL(url);
      const port = Number(parsed.port);
      if (parsed.pathname === "/v1/discovery") {
        if (port === 38452 || port === 38453) return response(200, { serverId: "shared-server", protocol: bridge.PROTOCOL, port, pairingRequired: false });
        return response(404);
      }
      if (parsed.pathname === "/v1/unpair") return response(200, { ok: true });
      return response(404);
    };
    const unpaired = await client.unpairAll();
    assert.deepStrictEqual(unpaired.ports, [38452, 38453], "unpair must rotate every authenticated matching bridge");
    assert.deepStrictEqual(calls.filter((call) => call.url.endsWith("/v1/unpair")).map((call) => Number(new URL(call.url).port)), [38452, 38453]);

    const workerStarts = [];
    const originalPollWorker = client.pollWorker.bind(client);
    client.pollWorker = async (server) => { workerStarts.push(server.port); };
    client.syncWorkers("test-token");
    await Promise.resolve();
    assert.deepStrictEqual(workerStarts, [38452, 38453], "each matching server should receive an independent fair poll worker");
    client.pollWorker = originalPollWorker;
    client.workers.clear();

    calls.length = 0;
    fetchHandler = async () => response(200, {});
    await client.postResult(servers[1], "test-token", { requestId: "r-result", nonce: "n-result" }, { ok: true, data: {} });
    assert(calls[0].url.startsWith("http://localhost:38453/v1/result"), "result must return to the issuing port");

    calls.length = 0;
    fetchHandler = async () => response(201, { ok: true, result: { name: "sample.png", bytes: 3 } });
    const upload = await client.uploadExport(
      servers[1],
      "test-token",
      { requestId: "r-export", nonce: "n-export" },
      new Uint8Array([1, 2, 3]).buffer,
      { name: "sample.png", format: "png", overwriteApproved: true }
    );
    assert.deepStrictEqual(upload, { name: "sample.png", bytes: 3 });
    assert(calls[0].url.startsWith("http://localhost:38453/v1/export?"), "default export must return to the issuing port");
    assert.strictEqual(calls[0].options.headers["X-Request-Nonce"], "n-export");
    assert.strictEqual(calls[0].options.headers["X-Overwrite-Approved"], "true");

    calls.length = 0;
    const importBytes = new Uint8Array([56, 66, 80, 83]).buffer;
    fetchHandler = async () => response(200, importBytes);
    const downloaded = await client.downloadImport(
      servers[1],
      "test-token",
      { requestId: "r-import", nonce: "n-import" },
      "sample.psd"
    );
    assert.deepStrictEqual(Array.from(new Uint8Array(downloaded)), [56, 66, 80, 83]);
    const importUrl = new URL(calls[0].url);
    assert.strictEqual(importUrl.pathname, "/v1/import");
    assert.strictEqual(importUrl.searchParams.get("request_id"), "r-import");
    assert.strictEqual(importUrl.searchParams.get("nonce"), "n-import");
    assert.strictEqual(importUrl.searchParams.get("file_name"), "sample.psd");
    assert.strictEqual(calls[0].options.headers.Authorization, "Bearer test-token");
    assert.strictEqual(calls[0].options.headers["X-Plugin-Instance"], "test-plugin");

    calls.length = 0;
    await client.resumeJob("job-1", 38453);
    assert(calls[0].url.startsWith("http://localhost:38453/v1/jobs/job-1/resume"), "approval must return to the issuing port");

    calls.length = 0;
    fetchHandler = async (url) => {
      if (url.endsWith("/v1/poll")) return response(200, {
        requestId: "r-poll",
        nonce: "n-poll",
        deadline: Date.now() + 10_000,
        kind: "host.describe",
        payload: {}
      });
      return response(200, {});
    };
    await client.pollOnce(servers[0], "test-token", client.generation);
    assert.strictEqual(contexts[0].context.serverPort, 38452, "dispatch must retain issuing port context");
    assert.strictEqual(typeof contexts[0].context.downloadImport, "function", "dispatch context must expose request-bound import download transport");
    assert(calls.some((call) => call.url.startsWith("http://localhost:38452/v1/result")), "polled request result must use issuing port");

    const dispatched = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const queueClient = new bridge.BridgeClient(async (kind, payload, context) => {
      dispatched.push({ kind, context });
      if (kind === "first") await firstGate;
      return { done: kind };
    });
    const first = queueClient.enqueueDispatch("first", {}, servers[0], "test-token", { requestId: "first", nonce: "first-nonce" }, Date.now() + 5_000);
    const expiring = queueClient.enqueueDispatch("expires-in-queue", {}, servers[1], "test-token", { requestId: "expiring", nonce: "expiring-nonce" }, Date.now() + 20);
    await new Promise((resolve) => setTimeout(resolve, 35));
    releaseFirst();
    await first;
    await assert.rejects(expiring, (error) => error && error.code === "TIMEOUT", "queued request must fail after its deadline");
    assert.deepStrictEqual(dispatched.map((item) => item.kind), ["first"], "expired request must not reach dispatch");

    const storage = require("../lib/storage.js");
    const importBinary = new Uint8Array([1, 2, 3, 4]).buffer;
    const temporaryImport = await storage.materializeTemporaryImportFile("fixture.psd", importBinary);
    assert.strictEqual(temporaryEntries.length, 1, "import materialization must create one temporary FileEntry");
    assert(temporaryImport.name.endsWith("-fixture.psd"), "temporary import must retain the safe source extension");
    assert.strictEqual(temporaryImport.options.overwrite, false, "temporary import must not overwrite an existing entry");
    assert.strictEqual(temporaryImport.writes[0].binary, importBinary);
    assert.strictEqual(temporaryImport.writes[0].writeOptions.format, "binary");
    await storage.deleteEntry(temporaryImport);
    assert.strictEqual(temporaryImport.deleted, true, "temporary import cleanup must delete the FileEntry");
    await assert.rejects(storage.materializeTemporaryImportFile("../escape.psd", importBinary), /Invalid temporary import file name/);

    console.log("UXP multi-bridge checks passed (discovery, dispatch context, routing and queued expiry)." );
  } finally {
    Module._load = originalLoad;
    global.fetch = originalFetch;
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
