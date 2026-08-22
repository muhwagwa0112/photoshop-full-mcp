#!/usr/bin/env node
import { CommandCatalog } from "./catalog.js";
import { loadConfig } from "./config.js";
import { PhotoshopFullMcpServer } from "./server.js";

const config = await loadConfig();
const catalog = await CommandCatalog.load();
const server = await PhotoshopFullMcpServer.create(config, catalog);

const shutdown = async () => {
  try {
    await server.stop();
  } finally {
    process.exit(0);
  }
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await server.start();
