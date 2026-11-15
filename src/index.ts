#!/usr/bin/env node
import { CommandCatalog } from "./catalog.js";
import { loadConfig } from "./config.js";
import { PhotoshopFullMcpServer } from "./server.js";
import { startRuntimeOwner } from "./runtime-owner.js";
import { RuntimeClient } from "./runtime-client.js";

const config = await loadConfig();
if (process.argv.includes("--stop-runtime-owner")) {
  const stopped = await new RuntimeClient(config).stopIfRunning();
  process.stdout.write(`${JSON.stringify(stopped)}\n`);
  process.exit(0);
}
const catalog = await CommandCatalog.load();
const isOwner = process.argv.includes("--runtime-owner");
const server = await PhotoshopFullMcpServer.create(config, catalog, { runtimeOwner: isOwner });
const ownerEndpoint = isOwner ? await startRuntimeOwner(config, server) : null;
if (isOwner && !ownerEndpoint) process.exit(0);

const shutdown = async () => {
  try {
    if (isOwner) {
      await server.stopRuntime();
      await new Promise<void>((resolve) => ownerEndpoint?.close(() => resolve()));
    } else await server.stop();
  } finally {
    process.exit(0);
  }
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

if (!isOwner) await server.start();
