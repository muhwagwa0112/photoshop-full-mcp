import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validationProfileAllowsRisk, validationRequiresTemporaryDocument } from "../src/server.js";

test("validation risk policy permits only request-bound confined external commands", () => {
  assert.equal(validationProfileAllowsRisk({ id: "document.open_default", risk: "external" }), true);
  assert.equal(validationProfileAllowsRisk({ id: "document.export", risk: "external" }), true);
  assert.equal(validationProfileAllowsRisk({ id: "output.print_dialog", risk: "external" }), false);
  assert.equal(validationProfileAllowsRisk({ id: "generative.fill", risk: "credit" }), false);
  assert.equal(validationProfileAllowsRisk({ id: "layer.rename", risk: "edit" }), true);
  assert.equal(validationRequiresTemporaryDocument("document.create"), false);
  assert.equal(validationRequiresTemporaryDocument("document.open_default"), false);
  assert.equal(validationRequiresTemporaryDocument("layer.rename"), true);
});

test("validation tools are opt-in and advanced execution remains independently hidden", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ps-mcp-validation-profile-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve("src/index.ts")],
    env: {
      ...process.env,
      PS_MCP_DATA_DIR: dataDir,
      PS_MCP_PORT_START: "41320",
      PS_MCP_PORT_END: "41330",
      PS_MCP_VALIDATION: "confirm",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "validation-profile-contract", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = new Set(listed.tools.map((tool) => tool.name));
    assert.equal(names.has("photoshop_validation_request"), true);
    assert.equal(names.has("photoshop_command_validate"), true);
    assert.equal(names.has("photoshop_advanced_execute"), false);
  } finally {
    await client.close();
  }
});
