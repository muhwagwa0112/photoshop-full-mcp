import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { captureLiveEvidence } from "./evidence-record.mjs";

// A valid, inert 1x1 RGBA PNG. The fixture is written only to the configured
// default export directory, then removed after the live transaction.
const SEED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const config = await loadConfig();
const fileName = `PS_MCP_OPEN_DEFAULT_${randomUUID().replace(/-/g, "")}.png`;
const seedPath = join(config.exportDir, fileName);

await writeFile(seedPath, SEED_PNG, { flag: "wx" });
try {
  const result = await captureLiveEvidence({
    commandId: "document.open_default",
    commandArgs: { file_name: fileName },
    timeoutMs: 120_000
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await rm(seedPath, { force: true });
}
