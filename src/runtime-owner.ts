import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { ServerConfig } from "./config.js";
import { refreshBridgeSecret } from "./config.js";
import { runtimeEndpoint } from "./runtime-client.js";

export interface RuntimeToolHost {
  startRuntime(): Promise<void>;
  stopRuntime(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  listToolDefinitions(): unknown;
  runtimeStatus(): unknown;
  callHost(method: string, args: Record<string, unknown>): Promise<unknown>;
  canStopRuntime(): boolean;
}

async function removeDeadUnixEndpoint(path: string): Promise<void> {
  if (process.platform === "win32") return;
  let before;
  try { before = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!before.isSocket() || (process.getuid && before.uid !== process.getuid())) throw new Error("Runtime endpoint is not an owned socket");
  const alive = await new Promise<boolean>((resolve, reject) => {
    const probe = request({ socketPath: path, path: "/status", method: "GET" }, (res) => { res.resume(); resolve(true); });
    probe.setTimeout(1_000, () => { probe.destroy(); resolve(true); });
    probe.once("error", (error: NodeJS.ErrnoException) => { if (["ECONNREFUSED", "ENOENT"].includes(error.code ?? "")) resolve(false); else reject(error); });
    probe.end();
  });
  if (alive) return;
  try {
    const current = await lstat(path);
    if (current.ino === before.ino && current.dev === before.dev) await rm(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export async function startRuntimeOwner(config: ServerConfig, host: RuntimeToolHost): Promise<Server | null> {
  const endpoint = runtimeEndpoint(config);
  await removeDeadUnixEndpoint(endpoint);
  let ready = false;
  let stopping = false;
  let activeCalls = 0;
  const server = createServer((req, res) => void (async () => {
    try {
      await refreshBridgeSecret(config);
      const header = req.headers.authorization ?? "";
      const supplied = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
      const expected = Buffer.from(config.bridgeToken);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.writeHead(401); res.end(JSON.stringify({ error: "Runtime authentication required" })); return;
      }
      if (!ready || stopping) { res.writeHead(503); res.end(JSON.stringify({ error: stopping ? "Runtime stopping" : "Runtime initializing", code: stopping ? "RUNTIME_STOPPING" : "RUNTIME_INITIALIZING" })); return; }
      if (req.method !== "POST" || req.url !== "/rpc") { res.writeHead(404); res.end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length; if (size > 8 * 1024 * 1024) throw new Error("Runtime request exceeds limit"); chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method?: string; args?: Record<string, unknown> };
      let result: unknown;
      if (stopping) throw Object.assign(new Error("Runtime is draining"), { code: "RUNTIME_STOPPING" });
      if (body.method === "status") result = host.runtimeStatus();
      else if (body.method === "listTools") result = host.listToolDefinitions();
      else if (body.method === "shutdown") {
        if (activeCalls > 0 || !host.canStopRuntime()) throw Object.assign(new Error("Runtime shutdown refused while native operations or workflows are active; wait for their receipts or cancel the job before updating."), { code: "RUNTIME_BUSY" });
        stopping = true; result = { stopping: true };
        res.once("finish", () => { void (async () => {
          await host.stopRuntime();
          server.closeIdleConnections();
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        })().catch(error => { process.stderr.write(`[photoshop-full-mcp] Runtime shutdown failed: ${String(error)}\n`); }); });
      }
      else if (body.method === "callTool") {
        if (typeof body.args?.name !== "string") throw new Error("Tool name is required");
        const args = body.args.arguments ?? {};
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object");
        activeCalls++;
        try { result = await host.callTool(body.args.name, args as Record<string, unknown>); } finally { activeCalls--; }
      } else if (body.method?.startsWith("host.")) {
        activeCalls++;
        try { result = await host.callHost(body.method.slice(5), body.args ?? {}); } finally { activeCalls--; }
      } else throw new Error("Unsupported runtime method");
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ result }));
    } catch (error) {
      if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error), ...(error && typeof error === "object" && "code" in error ? { code: String(error.code) } : {}) }));
    }
  })());
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ path: endpoint, exclusive: true, readableAll: false, writableAll: false }, resolve); });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return null;
    throw error;
  }
  if (process.platform !== "win32") await chmod(endpoint, 0o600);
  try { await host.startRuntime(); ready = true; }
  catch (error) { await new Promise<void>((resolve) => server.close(() => resolve())); throw error; }
  // Lifetime is independent of frontend connections. No lease timer elects a
  // second owner; the OS-exclusive endpoint remains the ownership primitive.
  return server;
}
