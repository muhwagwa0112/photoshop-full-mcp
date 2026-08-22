import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("automatic approval is the default for destructive and advanced execution", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ps-mcp-auto-approval-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve("src/index.ts")],
    env: {
      ...process.env,
      PS_MCP_DATA_DIR: dataDir,
      PS_MCP_PORT_START: "41340",
      PS_MCP_PORT_END: "41350",
      PS_MCP_COMMAND_TIMEOUT_MS: "3000",
      PS_MCP_ADVANCED: "confirm",
      PS_MCP_APPROVAL_MODE: "auto",
      PS_MCP_TEST_PAIRING_CODE: "testPairingCode_765432",
      NODE_ENV: "test",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "auto-approval-contract", version: "1.0.0" });
  try {
    await client.connect(transport);
    const described = await client.callTool({ name: "photoshop_host_describe", arguments: {} });
    const host = described.structuredContent as { approvalMode: string; bridge: { port: number } };
    assert.equal(host.approvalMode, "auto");
    const base = `http://127.0.0.1:${host.bridge.port}`;
    const paired = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "testPairingCode_765432", pluginInstanceId: "mock-auto-uxp" }),
    });
    const pairData = await paired.json() as { token: string };
    assert.equal(paired.status, 200);
    const headers = { Authorization: `Bearer ${pairData.token}`, "X-Plugin-Instance": "mock-auto-uxp" };

    const respond = async (expectedKind: string, data: unknown) => {
      let response: Response;
      do {
        response = await fetch(`${base}/v1/poll`, { headers });
        if (response.status === 204) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      } while (response.status === 204);
      const command = await response.json() as { requestId: string; nonce: string; kind: string };
      assert.equal(command.kind, expectedKind);
      const posted = await fetch(`${base}/v1/result`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: command.requestId, nonce: command.nonce, ok: true, data }),
      });
      assert.equal(posted.status, 202);
    };

    const request = client.callTool({
      name: "photoshop_approval_request",
      arguments: { command_id: "layer.delete", args: {} },
    });
    const requested = (await request).structuredContent as { id: string; status: string };
    assert.equal(requested.status, "completed");
    const approval = await client.callTool({ name: "photoshop_job_get", arguments: { job_id: requested.id } });
    assert.match(String((approval.structuredContent as { approvalToken: string }).approvalToken), /\./);

    const destructive = client.callTool({
      name: "photoshop_command_execute",
      arguments: { command_id: "layer.delete", args: {} },
    });
    const validationState = { hasDocument: true, activeDocument: { id: 51, title: "PS_MCP_VALIDATION_Auto" }, activeLayer: { id: 9, name: "Temporary layer" } };
    await respond("state.get", validationState);
    await respond("command.execute", { deletedLayerId: 9 });
    await respond("state.get", { ...validationState, activeLayer: { id: 8, name: "Background" } });
    const destructiveResult = await destructive;
    assert.equal(destructiveResult.isError, undefined);

    const advanced = client.callTool({
      name: "photoshop_advanced_execute",
      arguments: { engine: "batchplay", payload: [{ _obj: "deselect" }], justification: "local automated test" },
    });
    await respond("advanced.batchplay", { descriptors: 1 });
    const advancedResult = await advanced;
    assert.equal(advancedResult.isError, undefined);
    assert.match(JSON.stringify(advancedResult.structuredContent), /automatically approved/i);

    const malformedAdvanced = await client.callTool({
      name: "photoshop_advanced_execute",
      arguments: {
        engine: "batchplay",
        payload: [{ _obj: "set", _target: [{ _ref: "notARealTarget" }], value: 1 }],
        justification: "unknown command regression",
      },
    });
    assert.equal(malformedAdvanced.isError, true);
    assert.match(JSON.stringify(malformedAdvanced.structuredContent), /APPROVAL_REQUIRED/);
    const postRejectPoll = await fetch(`${base}/v1/poll`, { headers });
    assert.equal(postRejectPoll.status, 204, "rejected raw descriptors must never be queued for Photoshop");

    const unavailableApproval = await client.callTool({
      name: "photoshop_approval_request",
      arguments: { command_id: "generative.fill", args: { prompt: "test" } },
    });
    assert.equal(unavailableApproval.isError, true);
    assert.match(JSON.stringify(unavailableApproval.structuredContent), /UNSUPPORTED/);
  } finally {
    await client.close();
  }
});
