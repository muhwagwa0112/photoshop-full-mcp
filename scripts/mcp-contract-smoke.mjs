import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "ps-mcp-contract-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/src/index.js")],
  env: {
    ...process.env,
    PS_MCP_DATA_DIR: dataDir,
    PS_MCP_PORT_START: "41200",
    PS_MCP_PORT_END: "41220",
  },
  stderr: "pipe",
});
const client = new Client({ name: "photoshop-full-mcp-contract-test", version: "1.0.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const required of [
    "photoshop_host_describe",
    "photoshop_capability_list",
    "photoshop_command_search",
    "photoshop_command_execute",
    "photoshop_job_get",
  ]) {
    if (!names.has(required)) throw new Error(`Missing MCP tool: ${required}`);
  }
  if (names.has("photoshop_advanced_execute")) throw new Error("Advanced tool must be hidden in the safe profile");
  const capability = await client.callTool({ name: "photoshop_capability_list", arguments: { status: "supported" } });
  if (capability.isError) throw new Error("Capability list returned an error");
  const unknown = await client.callTool({ name: "photoshop_command_describe", arguments: { command_id: "does.not.exist" } });
  if (!unknown.isError) throw new Error("Unknown command must return isError");
  const blockedLegacyAi = {};
  for (const commandId of ["generative.fill", "neural.skin_smoothing"]) {
    const blocked = await client.callTool({
      name: "photoshop_command_execute",
      arguments: { command_id: commandId, args: {} },
    });
    const code = blocked.structuredContent?.error?.code;
    if (!blocked.isError || code !== "UNSUPPORTED") {
      throw new Error(`${commandId} must be blocked locally as UNSUPPORTED without bridge dispatch`);
    }
    blockedLegacyAi[commandId] = code;
  }
  process.stdout.write(JSON.stringify({ ok: true, toolCount: tools.tools.length, advancedHidden: true, blockedLegacyAi }) + "\n");
} finally {
  await client.close();
}
