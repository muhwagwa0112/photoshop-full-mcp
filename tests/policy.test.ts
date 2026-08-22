import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ServerConfig } from "../src/config.js";
import { PhotoshopMcpError } from "../src/errors.js";
import { PolicyEngine } from "../src/policy.js";

async function testConfig(): Promise<ServerConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "ps-mcp-policy-"));
  const exportDir = join(dataDir, "exports");
  return {
    dataDir,
    exportDir,
    portStart: 41000,
    portEnd: 41010,
    commandTimeoutMs: 500,
    approvalMode: "auto",
    advancedProfile: "confirm",
    allowedRoots: [exportDir],
    serverId: "test-server",
    bridgeToken: "a".repeat(43),
  };
}

test("approval tokens are command-and-arguments-bound and one-time", async () => {
  const policy = new PolicyEngine(await testConfig());
  const scope = { args: {} };
  const approval = policy.issueApproval("layer.delete", scope, 10_000);
  policy.consumeApproval("layer.delete", scope, approval.token);
  assert.throws(
    () => policy.consumeApproval("layer.delete", scope, approval.token),
    (error) => error instanceof PhotoshopMcpError && error.code === "APPROVAL_REQUIRED",
  );
});

test("approval tokens reject changed destructive arguments", async () => {
  const policy = new PolicyEngine(await testConfig());
  const approval = policy.issueApproval("document.close", { args: { save: true } }, 10_000);
  assert.throws(
    () => policy.consumeApproval("document.close", { args: { save: false } }, approval.token),
    (error) => error instanceof PhotoshopMcpError && error.code === "APPROVAL_REQUIRED",
  );
});

test("path policy rejects escapes and relative paths", async () => {
  const config = await testConfig();
  const policy = new PolicyEngine(config);
  assert.equal(policy.assertAllowedPath(join(config.exportDir, "image.png")), join(config.exportDir, "image.png"));
  assert.throws(() => policy.assertAllowedPath("relative.png"), PhotoshopMcpError);
  assert.throws(() => policy.assertAllowedPath(join(config.dataDir, "..", "outside.png")), PhotoshopMcpError);
});

test("advanced payloads reject shallow allowlist bypasses before Photoshop dispatch", async () => {
  const policy = new PolicyEngine(await testConfig());
  assert.doesNotThrow(() => policy.assertAdvancedPayload([{ _obj: "deselect" }]));
  assert.doesNotThrow(() => policy.assertAdvancedPayload([{ _obj: "invert", _options: { dialogOptions: "dontDisplay" } }]));
  assert.throws(
    () => policy.assertAdvancedPayload([{ _obj: "set", _target: [{ _ref: "notARealTarget" }], value: 1 }]),
    (error) => error instanceof PhotoshopMcpError && error.code === "APPROVAL_REQUIRED",
  );
  assert.throws(
    () => policy.assertAdvancedPayload([{ _obj: "deselect", _target: [{ _ref: "notARealTarget" }] }]),
    (error) => error instanceof PhotoshopMcpError && error.code === "APPROVAL_REQUIRED",
  );
  assert.throws(
    () => policy.assertAdvancedPayload([{ _obj: "invert", _options: { dialogOptions: "display" } }]),
    (error) => error instanceof PhotoshopMcpError && error.code === "APPROVAL_REQUIRED",
  );
});
