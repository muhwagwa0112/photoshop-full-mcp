import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { copyFile, link, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, isAbsolute, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import type { BridgeCommand, BridgeResult } from "../packages/contracts/src/index.js";
import type { ServerConfig } from "./config.js";
import { persistBridgePairing, refreshBridgeSecret, rotateBridgeSecret, writeEndpointFile } from "./config.js";
import { PhotoshopMcpError } from "./errors.js";
import type { JobStore } from "./jobs.js";
import { HostOperationJournal, type HostOperationRecord, type AdapterPublication } from "./runtime-journal.js";
import { digest } from "./automation/canonical.js";
import type { OperationReceipt } from "./automation/contracts.js";

interface PendingRequest {
  command: BridgeCommand;
  record: HostOperationRecord;
  promise: Promise<BridgeResult>;
  resolve: (result: BridgeResult) => void;
}
interface PollWaiter { res: ServerResponse; timer: NodeJS.Timeout }
export interface BridgeDispatchOptions {
  operationId?: string;
  requestDigest?: string;
  executionDeadline?: number;
  hostEpoch?: string;
  control?: boolean;
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
  protocol: "ps-mcp-bridge/3";
  serverId: string;
  port?: number;
  paired: boolean;
  connected: boolean;
  pluginInstanceId?: string;
  lastSeenAt?: string;
  pairingCode?: string;
  queuedCommands: number;
  hostEpoch?: string;
  ownerGeneration: string;
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
  readonly ownerGeneration = randomUUID();
  private dispatchSequence = 0;
  private hostEpoch: string | undefined;
  private readonly journal: HostOperationJournal;
  private readonly controlQueue: BridgeCommand[] = [];
  private readonly pollWaiters = new Set<PollWaiter>();
  private readonly controlWaiters = new Set<PollWaiter>();
  private enqueueTail: Promise<void> = Promise.resolve();
  private claimTail: Promise<void> = Promise.resolve();
  private readonly consumedNonces = new Set<string>();
  private readonly uploadedExportNonces = new Set<string>();
  private readonly downloadedImportNonces = new Set<string>();
  private pairingFailures: number[] = [];

  constructor(private readonly config: ServerConfig, private readonly jobs: JobStore) {
    this.journal = new HostOperationJournal(join(config.dataDir, "host-operations.ndjson"));
    this.paired = Boolean(config.pairedPluginInstanceId);
    this.pluginInstanceId = config.pairedPluginInstanceId;
  }

  async start(): Promise<number> {
    if (this.port) return this.port;
    await this.journal.load();
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
    for (const waiter of [...this.pollWaiters, ...this.controlWaiters]) {
      clearTimeout(waiter.timer); waiter.res.writeHead(204); waiter.res.end();
    }
    this.pollWaiters.clear(); this.controlWaiters.clear();
    await this.journal.flush();
    if (!this.servers.length) return;
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    this.servers = [];
    this.port = undefined;
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      pending.resolve({ requestId: pending.command.requestId, nonce: pending.command.nonce,
        ...(pending.command.operationId ? { operationId: pending.command.operationId } : {}), ok: false, effect: "unknown",
        error: { code: "OUTCOME_UNKNOWN", message } });
    }
    // Durable records remain for reconciliation. Neither shutdown nor a lost
    // frontend connection proves that Photoshop stopped executing.
    this.pending.clear();
    this.queue.length = 0;
    this.controlQueue.length = 0;
  }

  status(includePairingCode = false): BridgeStatus {
    this.refreshPairingCode();
    const connected = typeof this.lastSeenAt === "number" && Date.now() - this.lastSeenAt < 60_000;
    return {
      protocol: "ps-mcp-bridge/3",
      serverId: this.config.serverId,
      ...(this.port !== undefined ? { port: this.port } : {}),
      paired: this.paired,
      connected,
      ...(this.pluginInstanceId ? { pluginInstanceId: this.pluginInstanceId } : {}),
      ...(this.lastSeenAt ? { lastSeenAt: new Date(this.lastSeenAt).toISOString() } : {}),
      ...(includePairingCode && !this.paired ? { pairingCode: this.pairingCode } : {}),
      queuedCommands: this.queue.length,
      ownerGeneration: this.ownerGeneration,
      ...(this.hostEpoch ? { hostEpoch: this.hostEpoch } : {}),
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
        `[System.Windows.MessageBox]::Show('Photoshop MCP v3 pairing code: ${this.port}-${code}` + "`nEnter the complete port-code value in the Photoshop panel before closing this dialog.', 'Photoshop MCP v3 Pairing') | Out-Null",
      ].join("\n"));
    });
  }

  async dispatch(kind: string, payload: Record<string, unknown>, timeoutMs = this.config.commandTimeoutMs, options: BridgeDispatchOptions = {}): Promise<BridgeResult> {
    await this.journal.load();
    const operationId = options.operationId ?? randomUUID();
    const requestDigest = options.requestDigest ?? digest({ kind, payload });
    let existing: HostOperationRecord | undefined;
    let claimed: PendingRequest | undefined;
    const claim = this.claimTail.then(async () => {
      existing = this.journal.records.get(operationId);
      if (existing) {
        if (existing.command.requestDigest !== requestDigest) throw new PhotoshopMcpError("IDEMPOTENCY_CONFLICT", "Operation key is already bound to different arguments", { operationId });
        claimed = this.pending.get(existing.command.requestId);
        return;
      }
      if (!this.status().connected) throw new PhotoshopMcpError("HOST_ERROR", "Photoshop UXP bridge is not connected; open the Photoshop MCP panel");
      if (!this.hostEpoch) throw new PhotoshopMcpError("CAPABILITY_UNAVAILABLE", "The connected UXP panel does not expose an execution epoch; update the panel before dispatching commands");
      const expectedHostEpoch = options.hostEpoch ?? this.hostEpoch;
      const command: BridgeCommand = {
        executionProtocol: "ps-mcp-executor/1",
        operationId, requestDigest, ownerGeneration: this.ownerGeneration,
        dispatchSequence: ++this.dispatchSequence,
        requestId: randomUUID(), nonce: randomUUID(),
        deadline: options.executionDeadline ?? Date.now() + Math.max(timeoutMs, 180_000),
        kind, payload,
        ...(expectedHostEpoch ? { hostEpoch: expectedHostEpoch } : {}),
      };
      const record: HostOperationRecord = { command, durable: Boolean(options.operationId) || ["command.execute", "advanced.batchplay", "automation.execute"].includes(kind), acceptedAt: new Date().toISOString() };
      let resolve!: (result: BridgeResult) => void;
      const promise = new Promise<BridgeResult>((done) => { resolve = done; });
      claimed = { command, record, promise, resolve };
      // Claim is fsynced before it can enter the host dispatch queue.
      await this.journal.write(record);
      this.pending.set(command.requestId, claimed);
      const pending = claimed;
      const enqueue = async () => {
        if (!this.pending.has(command.requestId)) return;
        if (command.deadline <= Date.now()) {
          await this.acceptResult({ requestId: command.requestId, nonce: command.nonce, operationId,
            ok: false, effect: "not_applied", error: { code: "TIMEOUT", message: "Execution deadline elapsed before dispatch" } });
          return;
        }
        (options.control ? this.controlQueue : this.queue).push(command);
        await this.wakePoller(Boolean(options.control));
        await pending.promise;
      };
      if (options.control) void enqueue().catch((error) => pending.resolve({ requestId: command.requestId, nonce: command.nonce, ok: false, effect: "unknown", error: { code: "HOST_ERROR", message: String(error) } }));
      else this.enqueueTail = this.enqueueTail.catch(() => {}).then(enqueue);
    });
    this.claimTail = claim.catch(() => {});
    await claim;
    if (existing?.result) return structuredClone(existing.result);
    if (!claimed) throw new PhotoshopMcpError("OUTCOME_UNKNOWN", "Previous dispatch has no confirmed receipt; query it before any retry", { operationId, requestDigest });
    const pending = claimed as PendingRequest;
    return new Promise<BridgeResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PhotoshopMcpError("OUTCOME_UNKNOWN", `Caller wait ended; Photoshop outcome remains pending: ${kind}`, { operationId, requestDigest })), Math.max(1, timeoutMs));
      pending.promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }

  operation(operationId: string): HostOperationRecord | undefined {
    const record = this.journal.records.get(operationId);
    return record ? structuredClone(record) : undefined;
  }

  hasActiveOperations(): boolean {
    return this.pending.size > 0 || [...this.journal.records.values()].some(record => record.durable && record.dispatchedAt && !record.result && (!this.hostEpoch || record.command.hostEpoch === this.hostEpoch));
  }

  async recordAdapterState(operationId: string, patch: { adapterReceipt?: OperationReceipt; publication?: AdapterPublication }): Promise<void> {
    const record = this.operation(operationId);
    if (!record) throw new PhotoshopMcpError("PRECONDITION_FAILED", `Unknown operation: ${operationId}`);
    await this.journal.write({ ...record, ...patch });
  }

  async requestCancel(operationId: string): Promise<{ requested: boolean; stopped: boolean }> {
    const record = this.journal.records.get(operationId);
    if (!record) throw new PhotoshopMcpError("PRECONDITION_FAILED", `Unknown operation: ${operationId}`);
    if (record.result) return { requested: false, stopped: record.result.effect === "not_applied" || record.result.effect === "rolled_back" };
    record.cancelRequested = true;
    await this.journal.write(record);
    if (!record.dispatchedAt) {
      const index = this.queue.findIndex((entry) => entry.operationId === operationId);
      if (index >= 0) this.queue.splice(index, 1);
      await this.acceptResult({ requestId: record.command.requestId, nonce: record.command.nonce, operationId, ok: false, effect: "not_applied", cancelRequested: true, error: { code: "CANCELLED", message: "Cancelled before dispatch" } });
      return { requested: true, stopped: true };
    }
    const response = await this.dispatch("operation.cancel", { operationId }, 5_000, { control: true });
    return { requested: response.ok, stopped: Boolean((response.data as { stopped?: boolean } | undefined)?.stopped) };
  }

  async reconcile(operationId: string): Promise<HostOperationRecord | undefined> {
    const record = this.journal.records.get(operationId);
    if (!record || record.result || !this.status().connected) return record;
    const response = await this.dispatch("operation.receipt", { operationId, requestDigest: record.command.requestDigest }, 5_000, { control: true });
    const retained = response.data as { result?: BridgeResult } | undefined;
    if (response.ok && retained?.result) await this.acceptResult({ ...retained.result, requestId: record.command.requestId, nonce: record.command.nonce });
    return this.operation(operationId);
  }

  private async acceptResult(result: BridgeResult): Promise<boolean> {
    const pending = this.pending.get(result.requestId);
    const record = (pending?.command.operationId ? this.journal.records.get(pending.command.operationId) : undefined)
      ?? [...this.journal.records.values()].find((entry) => entry.command.requestId === result.requestId);
    if (!record || record.command.nonce !== result.nonce || !record.command.operationId) return false;
    const normalized = { ...result, operationId: record.command.operationId };
    if (record.expired) return record.expired.nativeResultDigest === digest(normalized);
    if (record.result) return digest(record.result) === digest(normalized);
    if (record.command.hostEpoch && result.hostEpoch && record.command.hostEpoch !== result.hostEpoch) return false;
    await this.journal.write({ ...record, result: normalized, finalizedAt: new Date().toISOString() });
    this.pending.delete(result.requestId);
    pending?.resolve(normalized);
    return true;
  }

  private async wakePoller(control: boolean): Promise<void> {
    const waiters = control ? this.controlWaiters : this.pollWaiters;
    const queue = control ? this.controlQueue : this.queue;
    const waiter = waiters.values().next().value as PollWaiter | undefined;
    const command = queue[0];
    if (!waiter || !command) return;
    waiters.delete(waiter); clearTimeout(waiter.timer); queue.shift();
    const pending = this.pending.get(command.requestId);
    if (!pending) { waiter.res.writeHead(204); waiter.res.end(); return; }
    pending.record.dispatchedAt = new Date().toISOString();
    await this.journal.write(pending.record);
    json(waiter.res, 200, command);
  }

  private async poll(res: ServerResponse, control: boolean): Promise<void> {
    const waiters = control ? this.controlWaiters : this.pollWaiters;
    const timer = setTimeout(() => { waiters.delete(waiter); if (!res.writableEnded) { res.writeHead(204, { "Cache-Control": "no-store" }); res.end(); } }, 20_000);
    const waiter: PollWaiter = { res, timer };
    waiters.add(waiter);
    res.once("close", () => { clearTimeout(timer); waiters.delete(waiter); });
    await this.wakePoller(control);
  }

  private newPairingCode(): string {
    if (process.env.NODE_ENV === "test" && /^[A-Za-z0-9_-]{16,128}$/.test(process.env.PS_MCP_TEST_PAIRING_CODE ?? "")) {
      return process.env.PS_MCP_TEST_PAIRING_CODE as string;
    }
    return randomBytes(16).toString("base64url");
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
    const epoch = req.headers["x-host-epoch"];
    if (typeof epoch === "string" && /^[A-Za-z0-9_.:-]{8,200}$/.test(epoch)) this.hostEpoch = epoch;
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
    const automationExport = pending?.command.kind === "automation.execute" && ["ps.document.save", "ps.document.export"].includes(String(pending.command.payload.operation));
    if (!pending || pending.command.nonce !== nonce || (!automationExport && (pending.command.kind !== "command.execute" || commandId !== "document.export"))) {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", "Export upload is not bound to the pending document.export request");
    }
    // Caller wait expiry does not invalidate an already executing export.
    // The host receipt reports whether the cooperative execution deadline was reached.
    if (this.uploadedExportNonces.has(nonce)) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Export upload nonce was already consumed");

    const format = String(url.searchParams.get("format") ?? "").toLowerCase();
    const name = String(url.searchParams.get("name") ?? "");
    if (!["png", "jpg", "psd", "psb"].includes(format)) throw new PhotoshopMcpError("UNSUPPORTED", `Unsupported export format: ${format}`);
    if (!name || name.length > 255 || basename(name) !== name || /[\\/:*?"<>|\x00-\x1f]/.test(name)) {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", "Invalid export file name");
    }
    if (extname(name).toLowerCase() !== `.${format}`) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Export file extension does not match its format");

    const maximumBytes = Math.max(1024, Number(process.env.PS_MCP_MAX_EXPORT_BYTES ?? 512 * 1024 * 1024));
    const declaredLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", `Export exceeds the ${maximumBytes}-byte limit`);
    }

    const requestedDestination = automationExport ? String(pending.command.payload.exportDestination || "") : join(this.config.exportDir, name);
    if (!requestedDestination || basename(requestedDestination) !== name) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Export filename does not match its reserved operation destination");
    await mkdir(dirname(requestedDestination), { recursive: true });
    const parent = await realpath(dirname(requestedDestination));
    const roots = automationExport ? [this.config.dataDir] : [this.config.exportDir];
    let allowed = false;
    for (const root of roots) {
      const base = await realpath(root); const delta = relative(base, parent);
      if (delta === "" || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))) allowed = true;
    }
    if (!allowed) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Export destination escaped the owner's output roots");
    let target = join(parent, name);
    const temporary = join(parent, `.${name}.${randomUUID()}.upload`);
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
        await handle.writeFile(buffer);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (size === 0) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Export upload body is empty");
      const args = pending.command.payload.args as Record<string, unknown> | undefined;
      const onConflict = automationExport ? "error" : String(args?.on_conflict || "error");
      if (!["error", "version", "overwrite"].includes(onConflict)) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Invalid export collision policy");
      let overwritten = false;
      if (onConflict === "overwrite") {
        try {
          const current = await open(target, "r");
          try {
            overwritten = true;
            if (typeof args?.expected_existing_sha256 === "string") {
              const hash = createHash("sha256"); for await (const chunk of current.createReadStream({ autoClose: false })) hash.update(chunk);
              if (hash.digest("hex") !== args.expected_existing_sha256) throw new PhotoshopMcpError("OUTPUT_CONFLICT", "Existing output SHA-256 changed");
            }
          } finally { await current.close(); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await rename(temporary, target);
      } else {
        const stem = name.slice(0, -extname(name).length);
        for (let version = 0; ; version++) {
          if (version > 10000) throw new PhotoshopMcpError("OUTPUT_CONFLICT", "No available versioned output name");
          target = join(parent, version ? `${stem}-v${version}.${format}` : name);
          try { await link(temporary, target); break; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (onConflict === "error") throw new PhotoshopMcpError("OUTPUT_CONFLICT", `File already exists: ${name}`);
          }
        }
      }
      this.uploadedExportNonces.add(nonce);
      if (this.uploadedExportNonces.size > 10_000) this.uploadedExportNonces.clear();
      return { name: basename(target), format, path: target, bytes: size, sha256: digest.digest("hex"), overwritten };
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  private async sendImport(res: ServerResponse, url: URL): Promise<void> {
    const requestId = String(url.searchParams.get("request_id") ?? "");
    const nonce = String(url.searchParams.get("nonce") ?? "");
    const fileName = String(url.searchParams.get("file_name") ?? "");
    const assetKey = url.searchParams.get("asset_key");
    const pending = this.pending.get(requestId);
    if (!pending || pending.command.nonce !== nonce) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Import is not bound to an executing operation");
    const commandId = pending.command.payload.commandId ?? pending.command.payload.command_id;
    const args = pending.command.payload.args as Record<string, unknown> | undefined;
    let file: string;
    let expectedSha256: string | undefined;
    if (assetKey && pending.command.kind === "automation.execute") {
      const entries = pending.command.payload.assetTransfers as Record<string, { path: string; name: string; sha256: string }> | undefined;
      const asset = entries?.[assetKey];
      if (!asset || asset.name !== fileName) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Asset slot/filename does not match the operation");
      file = await realpath(asset.path); expectedSha256 = asset.sha256;
    } else {
      if (pending.command.kind !== "command.execute" || commandId !== "document.open_default" || args?.file_name !== fileName) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Import is not bound to document.open_default");
      if (!fileName || basename(fileName) !== fileName || /[\\/:*?"<>|\x00-\x1f]/.test(fileName)) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Invalid import file name");
      file = await realpath(join(this.config.exportDir, fileName));
      const relativeName = relative(await realpath(this.config.exportDir), file);
      if (relativeName.startsWith("..") || isAbsolute(relativeName)) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Import symlink escaped the export folder");
    }
    const info = await stat(file);
    const limit = Number(process.env.PS_MCP_MAX_IMPORT_BYTES ?? 512 * 1024 * 1024);
    if (!info.isFile() || info.size <= 0 || info.size > limit) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Import is not a supported nonempty bounded file");
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-store", ...(expectedSha256 ? { "X-Asset-Sha256": expectedSha256 } : {}) });
    await pipeline(createReadStream(file), res);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port ?? this.config.portStart}`);
      if (req.method === "GET" && url.pathname === "/v1/discovery") {
        await refreshBridgeSecret(this.config);
        this.syncPersistentPairing();
        const challenge = url.searchParams.get("challenge");
        if (challenge !== null && !/^[A-Za-z0-9_-]{32,128}$/.test(challenge)) {
          json(res, 400, { ok: false, error: "invalid_discovery_challenge" });
          return;
        }
        const secretGeneration = this.config.secretGeneration ?? 0;
        const proofPayload = challenge === null
          ? undefined
          : ["ps-mcp-bridge/4", this.config.serverId, String(this.port), String(secretGeneration), challenge, this.ownerGeneration, "ps-mcp-executor/1"].join("\n");
        json(res, 200, {
          protocol: "ps-mcp-bridge/4",
          executionProtocol: "ps-mcp-executor/1",
          serverId: this.config.serverId,
          port: this.port,
          secretGeneration,
          pairingRequired: !this.paired,
          ownerGeneration: this.ownerGeneration,
          ...(proofPayload ? { proof: createHmac("sha256", this.config.bridgeToken).update(proofPayload).digest("base64url") } : {}),
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/pair") {
        await refreshBridgeSecret(this.config);
        this.syncPersistentPairing();
        this.refreshPairingCode();
        const body = await readJson(req, 16 * 1024);
        const code = typeof body.code === "string" ? body.code : "";
        const supplied = Buffer.from(code);
        const expected = Buffer.from(this.pairingCode);
        const validCode = supplied.length === expected.length && timingSafeEqual(supplied, expected);
        const cutoff = Date.now() - 60_000;
        this.pairingFailures = this.pairingFailures.filter((attempt) => attempt >= cutoff);
        if (!validCode && this.pairingFailures.length >= 5) {
          json(res, 429, { ok: false, error: "pairing_rate_limited", retryAfterSeconds: 60 });
          return;
        }
        if (!validCode) {
          this.pairingFailures.push(Date.now());
          json(res, 401, { ok: false, error: "invalid_pairing_code" });
          return;
        }
        const pluginInstanceId = typeof body.pluginInstanceId === "string" ? body.pluginInstanceId : "";
        if (!/^[A-Za-z0-9_-]{8,200}$/.test(pluginInstanceId)) {
          json(res, 400, { ok: false, error: "invalid_plugin_instance" });
          return;
        }
        await persistBridgePairing(this.config, pluginInstanceId);
        this.syncPersistentPairing();
        this.pairingFailures = [];
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
      if (req.method === "GET" && ["/v1/poll", "/v1/control"].includes(url.pathname)) {
        await this.poll(res, url.pathname === "/v1/control");
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/result") {
        const body = await readJson(req, 64 * 1024 * 1024);
        const result = body as unknown as BridgeResult;
        if (typeof result.ok !== "boolean" || !await this.acceptResult(result)) {
          json(res, 409, { ok: false, error: "unknown_or_conflicting_result" });
          return;
        }
        json(res, 202, { ok: true, retained: true });
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
