import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP command pipeline interoperates with an authenticated mock UXP plugin", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ps-mcp-integration-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve("src/index.ts")],
    env: {
      ...process.env,
      PS_MCP_DATA_DIR: dataDir,
      PS_MCP_PORT_START: "41300",
      PS_MCP_PORT_END: "41310",
      PS_MCP_COMMAND_TIMEOUT_MS: "3000",
      PS_MCP_VALIDATION: "confirm",
      PS_MCP_APPROVAL_MODE: "panel",
      NODE_ENV: "test",
      PS_MCP_TEST_PAIRING_CODE: "testPairingCode_654321",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "mock-uxp-integration", version: "1.0.0" });
  try {
    await client.connect(transport);
    const described = await client.callTool({ name: "photoshop_host_describe", arguments: {} });
    const host = described.structuredContent as { bridge: { port: number; pairingCode?: string } };
    assert.equal(host.bridge.pairingCode, undefined, "pairing code must not be disclosed to MCP clients");
    const base = `http://127.0.0.1:${host.bridge.port}`;
    const paired = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "testPairingCode_654321", pluginInstanceId: "mock-uxp" }),
    });
    const pairData = await paired.json() as { token: string };
    assert.equal(paired.status, 200);
    const headers = { Authorization: `Bearer ${pairData.token}`, "X-Plugin-Instance": "mock-uxp" };

    const respond = async (expectedKind: string, data: unknown, expectedCommandId?: string) => {
      let response: Response;
      do {
        response = await fetch(`${base}/v1/poll`, { headers });
        if (response.status === 204) await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      } while (response.status === 204);
      const command = await response.json() as { requestId: string; nonce: string; kind: string; payload: Record<string, unknown> };
      assert.equal(command.kind, expectedKind);
      if (expectedCommandId) assert.equal(command.payload.commandId, expectedCommandId);
      const posted = await fetch(`${base}/v1/result`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: command.requestId, nonce: command.nonce, ok: true, data }),
      });
      assert.equal(posted.status, 202);
      return command;
    };

    const noDocumentAssistedCall = client.callTool({
      name: "photoshop_command_execute",
      arguments: { command_id: "ui.camera_raw_filter", args: {} },
    });
    await respond("state.get", { hasDocument: false, activeDocument: null, activeLayer: null });
    const noDocumentAssisted = await noDocumentAssistedCall;
    assert.equal(noDocumentAssisted.isError, true);
    assert.equal((noDocumentAssisted.structuredContent as { error: { code: string } }).error.code, "NO_DOCUMENT");

    const ordinaryCall = client.callTool({
      name: "photoshop_document_create",
      arguments: { width: 320, height: 200, name: "PS_MCP_VALIDATION_Mock" },
    });
    await respond("state.get", { hasDocument: false, activeDocument: null, activeLayer: null });
    await respond("command.execute", { document: { id: 42, title: "PS_MCP_VALIDATION_Mock", width: 320, height: 200 } }, "document.create");
    const validationState = {
      hasDocument: true,
      activeDocument: { id: 42, title: "PS_MCP_VALIDATION_Mock", width: 320, height: 200 },
      activeLayer: { id: 7, name: "Background" },
    };
    await respond("state.get", validationState);
    const ordinary = await ordinaryCall;
    assert.equal(ordinary.isError, undefined);

    const approvalCall = client.callTool({
      name: "photoshop_approval_request",
      arguments: { command_id: "layer.delete", args: {} },
    });
    const approvalCommand = await respond("approval.request", { displayed: true });
    assert.match(String(approvalCommand.payload.consequence), /layer\.delete|레이어 삭제/);
    assert.match(String(approvalCommand.payload.scopeDigest), /^[a-f0-9]{64}$/);
    const approvalJob = (await approvalCall).structuredContent as { id: string; kind: string; status: string };
    assert.equal(approvalJob.kind, "approval");
    assert.equal(approvalJob.status, "awaiting_user");

    const bypass = await client.callTool({ name: "photoshop_job_resume", arguments: { job_id: approvalJob.id } });
    assert.equal(bypass.isError, true);
    assert.equal((bypass.structuredContent as { error: { code: string } }).error.code, "APPROVAL_REQUIRED");

    const panelDecision = await fetch(`${base}/v1/jobs/${approvalJob.id}/resume`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, result: { approved: true } }),
    });
    assert.equal(panelDecision.status, 200);
    const approved = await client.callTool({ name: "photoshop_job_get", arguments: { job_id: approvalJob.id } });
    const approvalToken = String((approved.structuredContent as { approvalToken: string }).approvalToken);
    assert.ok(approvalToken.includes("."));

    const destructiveCall = client.callTool({
      name: "photoshop_command_execute",
      arguments: {
        command_id: "layer.delete",
        args: {},
        approval_token: approvalToken,
      },
    });
    await respond("state.get", validationState);
    await respond("command.execute", { deletedLayerId: 7 }, "layer.delete");
    await respond("state.get", {
      hasDocument: true,
      activeDocument: { id: 42, title: "PS_MCP_VALIDATION_Mock", width: 320, height: 200 },
      activeLayer: { id: 6, name: "Background" },
    });
    const completed = await destructiveCall;
    assert.equal(completed.isError, undefined);
    const envelope = completed.structuredContent as { ok: boolean; commandId: string; status: string };
    assert.equal(envelope.ok, true);
    assert.equal(envelope.commandId, "layer.delete");
    assert.equal(envelope.status, "completed");

    const assistedCall = client.callTool({
      name: "photoshop_command_execute",
      arguments: { command_id: "ui.camera_raw_filter", args: {} },
    });
    await respond("state.get", validationState);
    await respond("command.execute", { awaitingUser: true }, "ui.camera_raw_filter");
    const assistedEnvelope = (await assistedCall).structuredContent as { status: string; result: { jobId: string } };
    assert.equal(assistedEnvelope.status, "awaiting_user");
    const remoteResume = await client.callTool({ name: "photoshop_job_resume", arguments: { job_id: assistedEnvelope.result.jobId } });
    assert.equal(remoteResume.isError, true);
    assert.equal((remoteResume.structuredContent as { error: { code: string } }).error.code, "REQUIRES_USER");

    const userPanelCompletion = await fetch(`${base}/v1/jobs/${assistedEnvelope.result.jobId}/resume`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, result: { completedByUser: true } }),
    });
    assert.equal(userPanelCompletion.status, 200);
    const completedJob = await client.callTool({ name: "photoshop_job_get", arguments: { job_id: assistedEnvelope.result.jobId } });
    assert.equal((completedJob.structuredContent as { status: string }).status, "completed");
  } finally {
    await client.close();
  }
});
