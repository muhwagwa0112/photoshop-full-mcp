import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP diagnostics remain available when every configured bridge port is occupied", async () => {
  const occupied = createServer();
  await new Promise<void>((resolveListen, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = occupied.address();
  assert(address && typeof address === "object");
  const dataDir = await mkdtemp(join(tmpdir(), "ps-mcp-exhausted-port-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", resolve("src/index.ts")],
    env: {
      ...process.env,
      PS_MCP_DATA_DIR: dataDir,
      PS_MCP_PORT_START: String(address.port),
      PS_MCP_PORT_END: String(address.port),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "port-exhaustion-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert(tools.tools.some((tool) => tool.name === "photoshop_host_describe"));
    const host = await client.callTool({ name: "photoshop_host_describe", arguments: {} });
    assert.equal(host.isError, undefined);
    const bridge = (host.structuredContent as { bridge?: { connected?: boolean; unavailableReason?: string } })?.bridge;
    assert.equal(bridge?.connected, false);
    assert.match(bridge?.unavailableReason ?? "", /No bridge port available/);

    const pairing = await client.callTool({ name: "photoshop_pairing_begin", arguments: {} });
    assert.equal(pairing.isError, true);
    assert.equal((pairing.structuredContent as { error?: { code?: string } })?.error?.code, "HOST_ERROR");
  } finally {
    await client.close();
    await new Promise<void>((resolveClose, reject) => occupied.close((error) => error ? reject(error) : resolveClose()));
  }
});
