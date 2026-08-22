import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { copyFile, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { BridgeCommand, BridgeResult } from "../packages/contracts/src/index.js";
import type { ServerConfig } from "./config.js";
import { persistBridgePairing, refreshBridgeSecret, rotateBridgeSecret, writeEndpointFile } from "./config.js";
import { PhotoshopMcpError } from "./errors.js";
import type { JobStore } from "./jobs.js";

interface PendingRequest {
  command: BridgeCommand;
  resolve: (result: BridgeResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

async function readJson(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Request body exceeds limit");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PhotoshopMcpError("PRECONDITION_FAILED", "JSON object required");
  }
  return value as Record<string, unknown>;
}

export interface BridgeStatus {
  protocol: "ps-mcp-bridge/2";
  serverId: string;
  port?: number;
  paired: boolean;
  connected: boolean;
  pluginInstanceId?: string;
  lastSeenAt?: string;
  pairingCode?: string;
  queuedCommands: number;
}

export class BridgeServer {
  private servers: Server[] = [];
  private port: number | undefined;
  private pairingCode = this.newPairingCode();
  private pairingCodeExpiresAt = Date.now() + 5 * 60_000;
  private paired = false;
  private pluginInstanceId: string | undefined;
  private lastSeenAt: number | undefined;
  private readonly queue: BridgeCommand[] = [];
  private readonly pending = new Map<string, PendingRequest>();
  private readonly consumedNonces = new Set<string>();
  private readonly uploadedExportNonces = new Set<string>();
  private readonly downloadedImportNonces = new Set<string>();
  private pairingFailures: number[] = [];

  constructor(private readonly config: ServerConfig, private readonly jobs: JobStore) {
    this.paired = Boolean(config.pairedPluginInstanceId);
    this.pluginInstanceId = config.pairedPluginInstanceId;
  }

  async start(): Promise<number> {
    if (this.port) return this.port;
    for (let candidate = this.config.portStart; candidate <= this.config.portEnd; candidate += 1) {
      const candidateServers: Server[] = [];
      try {
        const listen = async (host: "127.0.0.1" | "::1"): Promise<Server> => {
          const server = createServer((req, res) => void this.handle(req, res));
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen({ port: candidate, host, ...(host === "::1" ? { ipv6Only: true } : {}) }, () => resolve());
          });
          candidateServers.push(server);
          return server;
        };
        const ipv4Server = await listen("127.0.0.1");
        await listen("::1");
        this.servers = candidateServers;
        const port = (ipv4Server.address() as AddressInfo).port;
        this.port = port;
        await writeEndpointFile(this.config, port);
        return port;
      } catch (error) {
        await Promise.all(candidateServers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    throw new Error(`No bridge port available in ${this.config.portStart}-${this.config.portEnd}`);
  }

  async stop(): Promise<void> {
    this.rejectPending("Bridge stopped");
    if (!this.servers.length) return;
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    this.servers = [];
    this.port = undefined;
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new PhotoshopMcpError("CANCELLED", message));
    }
    this.pending.clear();
    this.queue.length = 0;
  }

  status(includePairingCode = false): BridgeStatus {
    this.refreshPairingCode();
    const connected = typeof this.lastSeenAt === "number" && Date.now() - this.lastSeenAt < 3_000;
    return {
      protocol: "ps-mcp-bridge/2",
      serverId: this.config.serverId,
      ...(this.port !== undefined ? { port: this.port } : {}),
      paired: this.paired,
      connected,
      ...(this.pluginInstanceId ? { pluginInstanceId: this.pluginInstanceId } : {}),
      ...(this.lastSeenAt ? { lastSeenAt: new Date(this.lastSeenAt).toISOString() } : {}),
      ...(includePairingCode && !this.paired ? { pairingCode: this.pairingCode } : {}),
      queuedCommands: this.queue.length,
    };
  }

  async showPairingDialog(): Promise<void> {
    if (process.platform !== "win32") throw new PhotoshopMcpError("REQUIRES_USER", "Pairing code display currently requires Windows");
    this.refreshPairingCode();
    const code = this.pairingCode;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-STA", "-Command", "-"], {
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.once("error", reject);
      child.once("exit", (exitCode) => exitCode === 0 ? resolve() : reject(new Error(`Pairing dialog exited with code ${exitCode}`)));
      child.stdin.end([
        "Add-Type -AssemblyName PresentationFramework",
        `[System.Windows.MessageBox]::Show('Photoshop MCP v2 pairing code: ${code}` + "`nEnter this code in the Photoshop panel before closing this dialog.', 'Photoshop MCP v2 Pairing') | Out-Null",
      ].join("\n"));
    });
  }

  async dispatch(kind: string, payload: Record<string, unknown>, timeoutMs = this.config.commandTimeoutMs): Promise<BridgeResult> {
    if (!this.status().connected) {
      throw new PhotoshopMcpError("HOST_ERROR", "Photoshop UXP bridge is not connected; open the Photoshop MCP v2 panel");
    }
    const requestId = randomUUID();
    const command: BridgeCommand = {
      requestId,
      nonce: randomUUID(),
      deadline: Date.now() + timeoutMs,
      kind,
      payload,
    };
    return new Promise<BridgeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        const index = this.queue.findIndex((item) => item.requestId === requestId);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new PhotoshopMcpError("TIMEOUT", `Photoshop command timed out: ${kind}`));
      }, timeoutMs);
      this.pending.set(requestId, { command, resolve, reject, timer });
      this.queue.push(command);
    });
  }

  private newPairingCode(): string {
    if (process.env.NODE_ENV === "test" && /^\d{6}$/.test(process.env.PS_MCP_TEST_PAIRING_CODE ?? "")) {
      return process.env.PS_MCP_TEST_PAIRING_CODE as string;
    }
    return String(randomInt(0, 1_000_000)).padStart(6, "0");
  }

  private refreshPairingCode(): void {
    if (Date.now() < this.pairingCodeExpiresAt) return;
    this.pairingCode = this.newPairingCode();
    this.pairingCodeExpiresAt = Date.now() + 5 * 60_000;
  }

  private authenticated(req: IncomingMessage): boolean {
    const instance = req.headers["x-plugin-instance"];
    if (!this.config.pairedPluginInstanceId || typeof instance !== "string" || instance !== this.config.pairedPluginInstanceId) return false;
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return false;
    const supplied = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.config.bridgeToken);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private markSeen(req: IncomingMessage): void {
    this.lastSeenAt = Date.now();
    this.paired = true;
    this.pluginInstanceId = this.config.pairedPluginInstanceId;
  }

  private syncPersistentPairing(): void {
    this.paired = Boolean(this.config.pairedPluginInstanceId);
    this.pluginInstanceId = this.config.pairedPluginInstanceId;
  }

  private async receiveExport(req: IncomingMessage, url: URL): Promise<Record<string, unknown>> {
    const requestId = req.headers["x-request-id"];
    const nonce = req.headers["x-request-nonce"];
    if (typeof requestId !== "string" || typeof nonce !== "string") {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", "Export upload requires request and nonce headers");
    }
    const pending = this.pending.get(requestId);
    const commandId = pending?.command.payload.commandId ?? pending?.command.payload.command_id;
    if (!pending || pending.command.nonce !== nonce || pending.command.kind !== "command.execute" || commandId !== "document.export") {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", "Export upload is not bound to the pending document.export request");
    }
    if (pending.command.deadline <= Date.now()) throw new PhotoshopMcpError("TIMEOUT", "Export upload request expired");
    if (this.uploadedExportNonces.has(nonce)) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Export upload nonce was already consumed");

    const format = String(url.searchParams.get("format") ?? "").toLowerCase();
    const name = String(url.searchParams.get("name") ?? "");
    if (!["png", "jpg", "psd"].includes(format)) throw new PhotoshopMcpError("UNSUPPORTED", `Unsupported export format: ${format}`);
    if (!name || name.length > 255 || basename(name) !== name || /[\\/:*?"<>|\x00-\x1f]/.test(name)) {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", "Invalid export file name");
    }
    if (extname(name).toLowerCase() !== `.${format}`) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Export file extension does not match its format");

    const maximumBytes = Math.max(1024, Number(process.env.PS_MCP_MAX_EXPORT_BYTES ?? 512 * 1024 * 1024));
    const declaredLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", `Export exceeds the ${maximumBytes}-byte limit`);
    }

    await mkdir(this.config.exportDir, { recursive: true });
    const target = join(this.config.exportDir, name);
    const temporary = join(this.config.exportDir, `.${name}.${randomUUID()}.upload`);
    const digest = createHash("sha256");
    let size = 0;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maximumBytes) throw new PhotoshopMcpError("PRECONDITION_FAILED", `Export exceeds the ${maximumBytes}-byte limit`);
        digest.update(buffer);
        await handle.write(buffer);
      }
      await handle.close();
      handle = undefined;
      if (size === 0) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Export upload body is empty");
      const overwriteApproved = req.headers["x-overwrite-approved"] === "true";
      try {
        await copyFile(temporary, target, overwriteApproved ? 0 : fsConstants.COPYFILE_EXCL);
      } catch (error) {
        if (!overwriteApproved && (error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new PhotoshopMcpError("APPROVAL_REQUIRED", `File already exists: ${name}`);
        }
        throw error;
      }
      this.uploadedExportNonces.add(nonce);
      if (this.uploadedExportNonces.size > 10_000) this.uploadedExportNonces.clear();
      return { name, format, path: target, bytes: size, sha256: digest.digest("hex"), overwritten: overwriteApproved };
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async sendImport(res: ServerResponse, url: URL): Promise<void> {
    const requestId = String(url.searchParams.get("request_id") ?? "");
    const nonce = String(url.searchParams.get("nonce") ?? "");
    const fileName = String(url.searchParams.get("file_name") ?? "");
    if (!requestId || !nonce || !fileName) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Import download requires request_id, nonce and file_name");
    const pending = this.pending.get(requestId);
    const commandId = pending?.command.payload.commandId ?? pending?.command.payload.command_id;
    const args = pending?.command.payload.args;
    const requestedName = args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>).file_name
      : undefined;
    if (!pending || pending.command.nonce !== nonce || pending.command.kind !== "command.execute" || commandId !== "document.open_default" || requestedName !== fileName) {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", "Import download is not bound to the pending document.open_default request");
    }
    if (pending.command.deadline <= Date.now()) throw new PhotoshopMcpError("TIMEOUT", "Import download request expired");
    if (this.downloadedImportNonces.has(nonce)) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Import download nonce was already consumed");
    if (fileName.length > 255 || basename(fileName) !== fileName || /[\\/:*?"<>|\x00-\x1f]/.test(fileName)) {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", "Invalid import file name");
    }
    const extension = extname(fileName).toLowerCase();
    if (![".psd", ".psb", ".png", ".jpg", ".jpeg", ".tif", ".tiff"].includes(extension)) {
      throw new PhotoshopMcpError("UNSUPPORTED", `Unsupported import extension: ${extension || "(none)"}`);
    }

    const root = await realpath(this.config.exportDir).catch(() => null);
    if (!root) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Default export folder is unavailable");
    const target = await realpath(join(root, fileName)).catch(() => null);
    if (!target || dirname(target) !== root) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Import file is outside the default export folder or does not exist");
    const fileStat = await stat(target);
    if (!fileStat.isFile()) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Import target is not a regular file");
    const maximumBytes = Math.max(1024, Number(process.env.PS_MCP_MAX_IMPORT_BYTES ?? 512 * 1024 * 1024));
    if (!Number.isFinite(maximumBytes) || fileStat.size <= 0 || fileStat.size > maximumBytes) {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", `Import must contain 1 to ${maximumBytes} bytes`);
    }

    if (this.downloadedImportNonces.has(nonce)) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Import download nonce was already consumed");
    this.downloadedImportNonces.add(nonce);
    if (this.downloadedImportNonces.size > 10_000) this.downloadedImportNonces.clear();
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": fileStat.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    await pipeline(createReadStream(target), res);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port ?? this.config.portStart}`);
      if (req.method === "GET" && url.pathname === "/v1/discovery") {
        await refreshBridgeSecret(this.config);
        this.syncPersistentPairing();
        json(res, 200, {
          protocol: "ps-mcp-bridge/2",
          serverId: this.config.serverId,
          port: this.port,
          pairingRequired: !this.paired,
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/pair") {
        await refreshBridgeSecret(this.config);
        this.syncPersistentPairing();
        this.refreshPairingCode();
        const cutoff = Date.now() - 60_000;
        this.pairingFailures = this.pairingFailures.filter((attempt) => attempt >= cutoff);
        if (this.pairingFailures.length >= 5) {
          json(res, 429, { ok: false, error: "pairing_rate_limited", retryAfterSeconds: 60 });
          return;
        }
        const body = await readJson(req, 16 * 1024);
        const code = typeof body.code === "string" ? body.code : "";
        const supplied = Buffer.from(code);
        const expected = Buffer.from(this.pairingCode);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          this.pairingFailures.push(Date.now());
          json(res, 401, { ok: false, error: "invalid_pairing_code" });
          return;
        }
        this.paired = true;
        this.pairingFailures = [];
        const pluginInstanceId = typeof body.pluginInstanceId === "string" ? body.pluginInstanceId : "";
        if (!/^[A-Za-z0-9_-]{8,200}$/.test(pluginInstanceId)) {
          json(res, 400, { ok: false, error: "invalid_plugin_instance" });
          return;
        }
        await persistBridgePairing(this.config, pluginInstanceId);
        this.syncPersistentPairing();
        this.lastSeenAt = Date.now();
        this.pairingCode = this.newPairingCode();
        this.pairingCodeExpiresAt = Date.now() + 5 * 60_000;
        json(res, 200, { token: this.config.bridgeToken, serverId: this.config.serverId });
        return;
      }
      const isUnpair = req.method === "POST" && url.pathname === "/v1/unpair";
      if (!isUnpair) {
        await refreshBridgeSecret(this.config);
        this.syncPersistentPairing();
      }
      if (!this.authenticated(req)) {
        json(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      this.markSeen(req);
      if (req.method === "POST" && url.pathname === "/v1/unpair") {
        this.rejectPending("Bridge pairing was revoked");
        await rotateBridgeSecret(this.config);
        this.syncPersistentPairing();
        this.lastSeenAt = undefined;
        this.consumedNonces.clear();
        this.uploadedExportNonces.clear();
        this.downloadedImportNonces.clear();
        this.pairingCode = this.newPairingCode();
        this.pairingCodeExpiresAt = Date.now() + 5 * 60_000;
        json(res, 200, { ok: true, unpaired: true });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/export") {
        try {
          const result = await this.receiveExport(req, url);
          json(res, 201, { ok: true, result });
        } catch (error) {
          const known = error instanceof PhotoshopMcpError;
          json(res, known && error.code === "APPROVAL_REQUIRED" ? 409 : 400, {
            ok: false,
            error: {
              code: known ? error.code : "HOST_ERROR",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/import") {
        try {
          await this.sendImport(res, url);
        } catch (error) {
          const known = error instanceof PhotoshopMcpError;
          if (res.headersSent) res.destroy(error instanceof Error ? error : undefined);
          else {
            json(res, 400, {
              ok: false,
              error: {
                code: known ? error.code : "HOST_ERROR",
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
        }
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/poll") {
        const command = this.queue.shift();
        if (!command) {
          res.writeHead(204, { "Cache-Control": "no-store" });
          res.end();
          return;
        }
        json(res, 200, command);
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/result") {
        const body = await readJson(req);
        const result = body as unknown as BridgeResult;
        const pending = this.pending.get(result.requestId);
        if (!pending || pending.command.nonce !== result.nonce || this.consumedNonces.has(result.nonce)) {
          json(res, 409, { ok: false, error: "unknown_or_replayed_result" });
          return;
        }
        this.consumedNonces.add(result.nonce);
        if (this.consumedNonces.size > 10_000) this.consumedNonces.clear();
        clearTimeout(pending.timer);
        this.pending.delete(result.requestId);
        pending.resolve(result);
        json(res, 202, { ok: true });
        return;
      }
      const jobMatch = /^\/v1\/jobs\/([^/]+)\/(resume|cancel)$/.exec(url.pathname);
      if (req.method === "POST" && jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1] ?? "");
        if (jobMatch[2] === "cancel") {
          json(res, 200, this.jobs.cancel(jobId));
        } else {
          const body = await readJson(req);
          json(res, 200, this.jobs.update(jobId, {
            status: body.ok === false ? "failed" : "completed",
            ...(body.result !== undefined ? { result: body.result } : {}),
            ...(body.error !== undefined ? { error: body.error } : {}),
          }));
        }
        return;
      }
      json(res, 404, { ok: false, error: "not_found" });
    } catch (error) {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
