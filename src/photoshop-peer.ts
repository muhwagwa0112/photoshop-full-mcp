import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Capability, HostAdapter, HostRef, OperationReceipt, OperationRequest, VerificationResult } from "./automation/contracts.js";

/** Shared with the Premiere peer; this never creates a Photoshop workflow scheduler. */
export function resolvePhotoshopDataDirectory(override?: string): string {
  return resolve(override || process.env.PS_MCP_DATA_DIR || join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "PS_MCP"));
}

export function photoshopOwnerEndpoint(dataDirectory: string): string {
  const directory = realpathSync.native(resolve(dataDirectory));
  const scope = createHash("sha256").update(process.platform === "win32" ? directory.toLowerCase() : directory).digest("hex").slice(0, 24);
  return process.platform === "win32" ? `\\\\.\\pipe\\photoshop-mcp-${scope}` : join(directory, `owner-${scope}.sock`);
}

export class RemotePhotoshopAdapter implements HostAdapter {
  readonly dataDirectory: string;
  private readonly timeoutMs: number;
  private readonly sourceStagingRootId: string;
  private readonly remoteStagingRootId: string;
  private readonly rootAliases: Record<string, string>;
  constructor(options: { dataDirectory?: string; timeoutMs?: number; sourceStagingRootId?: string; remoteStagingRootId?: string; rootAliases?: Record<string, string> } = {}) {
    this.dataDirectory = resolvePhotoshopDataDirectory(options.dataDirectory);
    this.timeoutMs = options.timeoutMs ?? 660_000;
    this.sourceStagingRootId = options.sourceStagingRootId ?? "premiere_staging";
    this.remoteStagingRootId = options.remoteStagingRootId ?? "photoshop_staging";
    this.rootAliases = options.rootAliases ?? { workspace: "premiere_workspace", output: "premiere_output" };
  }
  private async call<T>(method: string, args: unknown): Promise<T> {
    const secret = JSON.parse(await readFile(join(this.dataDirectory, "bridge-secret.json"), "utf8")) as { bridgeToken?: string };
    if (typeof secret.bridgeToken !== "string" || secret.bridgeToken.length < 32) throw new Error("Photoshop runtime authentication is not configured");
    const body = JSON.stringify({ method: `host.${method}`, args });
    return new Promise<T>((resolveResult, reject) => {
      const req = request({ socketPath: photoshopOwnerEndpoint(this.dataDirectory), path: "/rpc", method: "POST",
        headers: { Authorization: `Bearer ${secret.bridgeToken}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => {
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 64 * 1024 * 1024) res.destroy(new Error("Photoshop peer response exceeds limit")); else chunks.push(chunk); });
        res.once("error", reject);
        res.once("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { result?: T; error?: string; code?: string };
            if (res.statusCode !== 200 || value.error) {
              const error = Object.assign(new Error(value.error ?? `Photoshop runtime returned ${res.statusCode}`), { code: value.code ?? "PHOTOSHOP_PEER_ERROR" }); reject(error);
            } else resolveResult(value.result as T);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(Object.assign(new Error("Photoshop peer wait ended; query the same operation receipt before retrying"), { code: "OUTCOME_UNKNOWN" })));
      req.once("error", reject); req.end(body);
    });
  }
  resolveHost(): Promise<HostRef> { return this.call("resolveHost", {}); }
  describeCapabilities(host: HostRef): Promise<Capability[]> { return this.call("describeCapabilities", { host }); }
  prepare(request: OperationRequest): Promise<OperationRequest> {
    const prepared = structuredClone(request);
    const rebind = (asset: { rootId: string }): void => { asset.rootId = asset.rootId === "__automation" ? this.sourceStagingRootId : this.rootAliases[asset.rootId] ?? asset.rootId; };
    for (const asset of Object.values(prepared.assets)) rebind(asset);
    if (Array.isArray(prepared.args.sourceAssets)) for (const asset of prepared.args.sourceAssets) if (asset && typeof asset === "object" && !Array.isArray(asset) && typeof asset.rootId === "string") rebind(asset as { rootId: string });
    if (prepared.args.output && typeof prepared.args.output === "object" && !Array.isArray(prepared.args.output) && typeof prepared.args.output.rootId === "string") rebind(prepared.args.output as { rootId: string });
    return this.call("prepare", { request: prepared });
  }
  private mapReceipt<T extends OperationReceipt | null>(receipt: T): T {
    // Only AssetRef locators are translated; operation IDs, digests, byte hashes,
    // live targets, and native receipts retain the Photoshop owner's identity.
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const item of value) walk(item); return; }
      const object = value as Record<string, unknown>;
      if (typeof object.assetId === "string" && typeof object.sha256 === "string" && typeof object.relativePath === "string") {
        if (object.rootId === "__automation") object.rootId = this.remoteStagingRootId;
        else for (const [local, remote] of Object.entries(this.rootAliases)) if (object.rootId === remote) { object.rootId = local; break; }
      }
      for (const nested of Object.values(object)) walk(nested);
    };
    const copy = structuredClone(receipt); walk(copy); return copy;
  }
  async dispatch(request: OperationRequest): Promise<OperationReceipt> { return this.mapReceipt(await this.call<OperationReceipt>("dispatch", { request })); }
  async getReceipt(operationId: string): Promise<OperationReceipt | null> { return this.mapReceipt(await this.call<OperationReceipt | null>("getReceipt", { operationId })); }
  readPostcondition(request: OperationRequest): Promise<VerificationResult[]> { return this.call("readPostcondition", { request }); }
  requestCancel(operationId: string): Promise<{ requested: boolean; stopped: boolean }> { return this.call("requestCancel", { operationId }); }
}
