import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { BridgeServer } from "../src/bridge.js";
import type { ServerConfig } from "../src/config.js";
import { JobStore } from "../src/jobs.js";

async function config(): Promise<ServerConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "ps-mcp-bridge-"));
  return {
    dataDir,
    exportDir: join(dataDir, "exports"),
    portStart: 41100,
    portEnd: 41120,
    commandTimeoutMs: 2_000,
    approvalMode: "auto",
    advancedProfile: "safe",
    allowedRoots: [dataDir],
    serverId: "bridge-test-server",
    bridgeToken: "test-bridge-token-abcdefghijklmnopqrstuvwxyz",
  };
}

test("bridge pairs, authenticates, dispatches, and rejects replay", async () => {
  const settings = await config();
  const bridge = new BridgeServer(settings, new JobStore());
  const port = await bridge.start();
  try {
    const discovery = await fetch(`http://127.0.0.1:${port}/v1/discovery`).then((r) => r.json()) as { serverId: string };
    const localhostDiscovery = await fetch(`http://localhost:${port}/v1/discovery`).then((r) => r.json()) as { serverId: string };
    assert.equal(localhostDiscovery.serverId, discovery.serverId, "UXP localhost origin must reach the same loopback bridge over IPv6 or IPv4");
    assert.equal(discovery.serverId, settings.serverId);
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/poll`);
    assert.equal(unauthorized.status, 401);

    const code = bridge.status(true).pairingCode;
    const pair = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, pluginInstanceId: "test-plugin" }),
    });
    assert.equal(pair.status, 200);

    const pending = bridge.dispatch("state.get", {});
    const headers = { Authorization: `Bearer ${settings.bridgeToken}`, "X-Plugin-Instance": "test-plugin" };
    const poll = await fetch(`http://127.0.0.1:${port}/v1/poll`, { headers });
    const command = await poll.json() as { requestId: string; nonce: string };
    const responseBody = { requestId: command.requestId, nonce: command.nonce, ok: true, data: { hasDocument: false } };
    const accepted = await fetch(`http://127.0.0.1:${port}/v1/result`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(responseBody),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual((await pending).data, { hasDocument: false });

    const replay = await fetch(`http://127.0.0.1:${port}/v1/result`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(responseBody),
    });
    assert.equal(replay.status, 409);
  } finally {
    await bridge.stop();
  }
});

test("default export upload is authenticated, request-bound, replay-safe, and confined to exportDir", async () => {
  const settings = await config();
  const bridge = new BridgeServer(settings, new JobStore());
  const port = await bridge.start();
  const instance = "export-plugin-instance";
  try {
    await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: bridge.status(true).pairingCode, pluginInstanceId: instance }),
    });
    const auth = { Authorization: `Bearer ${settings.bridgeToken}`, "X-Plugin-Instance": instance };
    const pending = bridge.dispatch("command.execute", { commandId: "document.export", args: { format: "png", file_name: "fixture.png" } });
    const polled = await fetch(`http://127.0.0.1:${port}/v1/poll`, { headers: auth });
    const command = await polled.json() as { requestId: string; nonce: string };
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const uploadHeaders = {
      ...auth,
      "X-Request-Id": command.requestId,
      "X-Request-Nonce": command.nonce,
      "X-Overwrite-Approved": "false",
      "Content-Type": "application/octet-stream",
    };
    const upload = await fetch(`http://127.0.0.1:${port}/v1/export?name=fixture.png&format=png`, {
      method: "POST",
      headers: uploadHeaders,
      body: bytes,
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json() as { result: { path: string; bytes: number; sha256: string } };
    assert.equal(uploaded.result.path, join(settings.exportDir, "fixture.png"));
    assert.equal(uploaded.result.bytes, bytes.length);
    assert.deepEqual(await readFile(uploaded.result.path), bytes);

    const replay = await fetch(`http://127.0.0.1:${port}/v1/export?name=fixture.png&format=png`, {
      method: "POST",
      headers: uploadHeaders,
      body: bytes,
    });
    assert.equal(replay.status, 400);

    const resultResponse = await fetch(`http://127.0.0.1:${port}/v1/result`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: command.requestId, nonce: command.nonce, ok: true, data: { exported: true } }),
    });
    assert.equal(resultResponse.status, 202);
    assert.deepEqual((await pending).data, { exported: true });

    const escape = await fetch(`http://127.0.0.1:${port}/v1/export?name=..%2Fescape.png&format=png`, {
      method: "POST",
      headers: { ...uploadHeaders, "X-Request-Nonce": "different" },
      body: bytes,
    });
    assert.equal(escape.status, 400);
  } finally {
    await bridge.stop();
  }
});

test("default import download is authenticated, pending-command-bound, one-time, size-limited, and confined to exportDir", async () => {
  const settings = await config();
  await mkdir(settings.exportDir, { recursive: true });
  const fixture = Buffer.from([56, 66, 80, 83, 0, 1, 2, 3]);
  await writeFile(join(settings.exportDir, "fixture.psd"), fixture);
  await writeFile(join(settings.exportDir, "oversize.psd"), Buffer.alloc(1025, 7));
  const bridge = new BridgeServer(settings, new JobStore());
  const port = await bridge.start();
  const instance = "import-plugin-instance";
  const previousLimit = process.env.PS_MCP_MAX_IMPORT_BYTES;
  process.env.PS_MCP_MAX_IMPORT_BYTES = "1024";
  try {
    await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: bridge.status(true).pairingCode, pluginInstanceId: instance }),
    });
    const auth = { Authorization: `Bearer ${settings.bridgeToken}`, "X-Plugin-Instance": instance };
    const pollCommand = async (fileName: string) => {
      const pending = bridge.dispatch("command.execute", { commandId: "document.open_default", args: { file_name: fileName } });
      const command = await fetch(`http://127.0.0.1:${port}/v1/poll`, { headers: auth }).then((response) => response.json()) as { requestId: string; nonce: string };
      return { pending, command };
    };
    const finish = async (pending: Promise<unknown>, command: { requestId: string; nonce: string }) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/result`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: command.requestId, nonce: command.nonce, ok: true, data: { completed: true } }),
      });
      assert.equal(response.status, 202);
      await pending;
    };

    const valid = await pollCommand("fixture.psd");
    const validQuery = `request_id=${encodeURIComponent(valid.command.requestId)}&nonce=${encodeURIComponent(valid.command.nonce)}&file_name=fixture.psd`;
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/import?${validQuery}`)).status, 401, "import bytes require paired authentication");
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/import?request_id=wrong&nonce=${encodeURIComponent(valid.command.nonce)}&file_name=fixture.psd`, { headers: auth })).status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/import?request_id=${encodeURIComponent(valid.command.requestId)}&nonce=wrong&file_name=fixture.psd`, { headers: auth })).status, 400);
    const concurrentDownloads = await Promise.all([
      fetch(`http://127.0.0.1:${port}/v1/import?${validQuery}`, { headers: auth }),
      fetch(`http://127.0.0.1:${port}/v1/import?${validQuery}`, { headers: auth }),
    ]);
    assert.deepEqual(concurrentDownloads.map((response) => response.status).sort(), [200, 400], "concurrent replay must yield exactly one download");
    const downloaded = concurrentDownloads.find((response) => response.status === 200);
    assert(downloaded);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), fixture);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/import?${validQuery}`, { headers: auth })).status, 400, "import nonce must be one-time");
    await finish(valid.pending, valid.command);

    const traversal = await pollCommand("../escape.psd");
    const traversalQuery = `request_id=${encodeURIComponent(traversal.command.requestId)}&nonce=${encodeURIComponent(traversal.command.nonce)}&file_name=${encodeURIComponent("../escape.psd")}`;
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/import?${traversalQuery}`, { headers: auth })).status, 400);
    await finish(traversal.pending, traversal.command);

    const oversized = await pollCommand("oversize.psd");
    const oversizedQuery = `request_id=${encodeURIComponent(oversized.command.requestId)}&nonce=${encodeURIComponent(oversized.command.nonce)}&file_name=oversize.psd`;
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/import?${oversizedQuery}`, { headers: auth })).status, 400);
    await finish(oversized.pending, oversized.command);

    const unsupported = await pollCommand("fixture.exe");
    const unsupportedQuery = `request_id=${encodeURIComponent(unsupported.command.requestId)}&nonce=${encodeURIComponent(unsupported.command.nonce)}&file_name=fixture.exe`;
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/import?${unsupportedQuery}`, { headers: auth })).status, 400);
    await finish(unsupported.pending, unsupported.command);

    const wrongCommandPending = bridge.dispatch("command.execute", { commandId: "document.export", args: { file_name: "fixture.psd" } });
    const wrongCommand = await fetch(`http://127.0.0.1:${port}/v1/poll`, { headers: auth }).then((response) => response.json()) as { requestId: string; nonce: string };
    const wrongCommandQuery = `request_id=${encodeURIComponent(wrongCommand.requestId)}&nonce=${encodeURIComponent(wrongCommand.nonce)}&file_name=fixture.psd`;
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/import?${wrongCommandQuery}`, { headers: auth })).status, 400, "import transport must bind to document.open_default only");
    await finish(wrongCommandPending, wrongCommand);
  } finally {
    if (previousLimit === undefined) delete process.env.PS_MCP_MAX_IMPORT_BYTES;
    else process.env.PS_MCP_MAX_IMPORT_BYTES = previousLimit;
    await bridge.stop();
  }
});

test("bridge advances within the configured range when the first port is busy", async () => {
  const settings = await config();
  const occupied = createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => occupied.listen(settings.portStart, "127.0.0.1", resolve));
  const bridge = new BridgeServer(settings, new JobStore());
  try {
    assert.equal(await bridge.start(), settings.portStart + 1);
  } finally {
    await bridge.stop();
    await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
  }
});

test("authenticated panel decisions update awaiting-user jobs", async () => {
  const settings = await config();
  const jobs = new JobStore();
  const job = jobs.create("approval:layer.delete", "awaiting_user");
  const bridge = new BridgeServer(settings, jobs);
  const port = await bridge.start();
  try {
    const code = bridge.status(true).pairingCode;
    await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, pluginInstanceId: "panel-instance" }),
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/jobs/${job.id}/resume`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.bridgeToken}`,
        "X-Plugin-Instance": "panel-instance",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ok: true, result: { approved: true } }),
    });
    assert.equal(response.status, 200);
    assert.equal(jobs.get(job.id).status, "completed");
  } finally {
    await bridge.stop();
  }
});

test("pairing endpoint rate limits repeated invalid codes", async () => {
  const settings = await config();
  const bridge = new BridgeServer(settings, new JobStore());
  const port = await bridge.start();
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "invalid", pluginInstanceId: "attacker" }),
      });
      assert.equal(response.status, 401);
    }
    const limited = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: bridge.status(true).pairingCode, pluginInstanceId: "attacker" }),
    });
    assert.equal(limited.status, 429);
  } finally {
    await bridge.stop();
  }
});

test("unpair rotates the bearer and rejects the revoked token", async () => {
  const settings = await config();
  const bridge = new BridgeServer(settings, new JobStore());
  const port = await bridge.start();
  const instance = "stable-plugin-instance";
  try {
    const firstPair = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: bridge.status(true).pairingCode, pluginInstanceId: instance }),
    });
    const first = await firstPair.json() as { token: string };
    const headers = { Authorization: `Bearer ${first.token}`, "X-Plugin-Instance": instance };
    const unpaired = await fetch(`http://127.0.0.1:${port}/v1/unpair`, { method: "POST", headers });
    assert.equal(unpaired.status, 200);
    assert.equal(bridge.status().paired, false);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/poll`, { headers })).status, 401);

    const secondPair = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: bridge.status(true).pairingCode, pluginInstanceId: instance }),
    });
    const second = await secondPair.json() as { token: string };
    assert.notEqual(second.token, first.token);
  } finally {
    await bridge.stop();
  }
});

test("concurrent bridges converge on one token generation after unpair and re-pair", async () => {
  const settingsA = await config();
  const settingsB: ServerConfig = { ...settingsA };
  const bridgeA = new BridgeServer(settingsA, new JobStore());
  const bridgeB = new BridgeServer(settingsB, new JobStore());
  const portA = await bridgeA.start();
  const portB = await bridgeB.start();
  const instance = "multi-bridge-plugin";
  try {
    const pairResponse = await fetch(`http://127.0.0.1:${portA}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: bridgeA.status(true).pairingCode, pluginInstanceId: instance }),
    });
    const paired = await pairResponse.json() as { token: string };
    const oldHeaders = { Authorization: `Bearer ${paired.token}`, "X-Plugin-Instance": instance };
    assert.equal((await fetch(`http://127.0.0.1:${portB}/v1/poll`, { headers: oldHeaders })).status, 204);

    const revoked = await Promise.all([
      fetch(`http://127.0.0.1:${portA}/v1/unpair`, { method: "POST", headers: oldHeaders }),
      fetch(`http://127.0.0.1:${portB}/v1/unpair`, { method: "POST", headers: oldHeaders }),
    ]);
    assert.deepEqual(revoked.map((response) => response.status), [200, 200]);
    assert.equal(settingsA.bridgeToken, settingsB.bridgeToken, "both processes must adopt one rotated generation");

    const repairedResponse = await fetch(`http://127.0.0.1:${portA}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: bridgeA.status(true).pairingCode, pluginInstanceId: instance }),
    });
    const repaired = await repairedResponse.json() as { token: string };
    const newHeaders = { Authorization: `Bearer ${repaired.token}`, "X-Plugin-Instance": instance };
    assert.equal((await fetch(`http://127.0.0.1:${portA}/v1/poll`, { headers: newHeaders })).status, 204);
    assert.equal((await fetch(`http://127.0.0.1:${portB}/v1/poll`, { headers: newHeaders })).status, 204);
  } finally {
    await bridgeA.stop();
    await bridgeB.stop();
  }
});
