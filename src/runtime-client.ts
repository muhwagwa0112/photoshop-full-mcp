import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config.js";
import { refreshBridgeSecret } from "./config.js";
import { photoshopOwnerEndpoint } from "./photoshop-peer.js";
import { runtimeIdentity } from "./runtime-version.js";

export function runtimeEndpoint(config: Pick<ServerConfig, "dataDir">): string {
  return photoshopOwnerEndpoint(config.dataDir);
}

/** Stdio frontends never hold a bridge port, journal, or native mutation queue. */
export class RuntimeClient {
  constructor(private readonly config: ServerConfig) {}

  async call<T>(method: string, args: unknown, waitMs = 240_000): Promise<T> {
    await refreshBridgeSecret(this.config, true);
    const body = JSON.stringify({ method, args });
    return new Promise<T>((resolve, reject) => {
      const req = request({ socketPath: runtimeEndpoint(this.config), path: "/rpc", method: "POST",
        headers: { Authorization: `Bearer ${this.config.bridgeToken}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024 * 1024) res.destroy(new Error("Runtime response exceeds limit")); else chunks.push(chunk); });
        res.once("error", reject);
        res.once("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { result?: T; error?: string; code?: string };
            if (res.statusCode !== 200 || value.error) reject(Object.assign(new Error(value.error ?? `Runtime returned ${res.statusCode}`), { code: value.code ?? (res.statusCode === 503 ? "RUNTIME_INITIALIZING" : "RUNTIME_RPC_ERROR") }));
            else resolve(value.result as T);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(waitMs, () => req.destroy(new Error("Runtime caller wait ended; query the operation/job receipt before retrying")));
      req.once("error", reject); req.end(body);
    });
  }

  async ensureStarted(): Promise<void> {
    try { this.assertCompatible(await this.call("status", {}, 2_000)); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !["ENOENT", "ECONNREFUSED", "EPIPE", "RUNTIME_INITIALIZING"].includes(code)) throw error;
    }
    await this.assertNoLegacyBridges();
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const entry = fileURLToPath(new URL(`./index.${extension}`, import.meta.url));
    const child = spawn(process.execPath, [...process.execArgv.filter((arg) => !arg.startsWith("--test")), entry, "--runtime-owner"], {
      detached: true, windowsHide: true, stdio: "ignore",
      env: { ...process.env, PS_MCP_DATA_DIR: this.config.dataDir, PS_MCP_EXPORT_DIR: this.config.exportDir },
    });
    child.unref();
    let spawnError: Error | undefined;
    child.once("error", (error) => { spawnError = error; });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { this.assertCompatible(await this.call("status", {}, 2_000)); return; }
      catch (error) { const code = (error as NodeJS.ErrnoException).code; if (!code || !["ENOENT", "ECONNREFUSED", "EPIPE", "RUNTIME_INITIALIZING"].includes(code)) throw error; }
    }
    throw new Error("Photoshop runtime owner did not start; no native command was dispatched");
  }

  private async assertNoLegacyBridges(): Promise<void> {
    await refreshBridgeSecret(this.config, true);
    const ports = Array.from({ length: this.config.portEnd - this.config.portStart + 1 }, (_, index) => this.config.portStart + index);
    const legacy = (await Promise.all(ports.map(async port => {
      const challenge = randomBytes(24).toString("base64url");
      let response: Response;
      try { response = await fetch(`http://127.0.0.1:${port}/v1/discovery?challenge=${challenge}`, { signal: AbortSignal.timeout(750) }); }
      catch { return null; } // An unused local port is expected during discovery.
      if (!response.ok) return null;
      const body = await response.text(); if (body.length > 16_384) return null;
      let data: Record<string, unknown>;
      try { data = JSON.parse(body) as Record<string, unknown>; } catch { return null; }
      if (data.protocol !== "ps-mcp-bridge/3" || data.port !== port || typeof data.serverId !== "string" || !Number.isInteger(data.secretGeneration) || typeof data.proof !== "string") return null;
      const expected = createHmac("sha256", this.config.bridgeToken).update([data.protocol, data.serverId, String(port), String(data.secretGeneration), challenge].join("\n")).digest("base64url");
      const supplied = Buffer.from(data.proof), wanted = Buffer.from(expected);
      return supplied.length === wanted.length && timingSafeEqual(supplied, wanted) ? port : null;
    }))).filter((port): port is number => port !== null);
    if (legacy.length) throw Object.assign(new Error(`Authenticated legacy Photoshop bridges are still running on ports ${legacy.join(", ")}. Close their standalone MCP processes before migration; the new owner endpoint cannot safely drain or terminate them.`), { code: "LEGACY_BRIDGE_ACTIVE" });
  }

  private assertCompatible(value: unknown): void {
    const status = value as Record<string, unknown>; const expected = runtimeIdentity();
    if (!status || status.runtimeProtocol !== expected.runtimeProtocol || status.version !== expected.version || status.buildId !== expected.buildId) {
      throw Object.assign(new Error("The running Photoshop owner belongs to another runtime build/protocol. Stop it with --stop-runtime-owner after its active operations settle, then restart this installation."), { code: "RUNTIME_VERSION_MISMATCH" });
    }
  }

  async stopIfRunning(): Promise<{ stopped: boolean; alreadyStopped: boolean }> {
    await this.assertNoLegacyBridges();
    try { await this.call("shutdown", {}, 10_000); }
    catch (error) {
      if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return { stopped: true, alreadyStopped: true };
      throw error;
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { await this.call("status", {}, 1_000); }
      catch (error) { if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) return { stopped: true, alreadyStopped: false }; }
    }
    throw new Error("Photoshop runtime acknowledged shutdown but has not drained; installation was not replaced.");
  }
}
