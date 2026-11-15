import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { BridgeCommand, BridgeResult } from "../packages/contracts/src/index.js";
import type { ArtifactSpec, AssetRef, OperationReceipt } from "./automation/contracts.js";
import { digest } from "./automation/canonical.js";

export interface AdapterPublication {
  state: "intent" | "committed";
  staged: AssetRef;
  output: ArtifactSpec;
  version: number;
  asset?: AssetRef;
}

export interface HostOperationRecord {
  command: BridgeCommand;
  durable: boolean;
  acceptedAt: string;
  dispatchedAt?: string;
  finalizedAt?: string;
  cancelRequested?: boolean;
  result?: BridgeResult;
  adapterReceipt?: OperationReceipt;
  publication?: AdapterPublication;
  expired?: { at: string; nativeResultDigest: string; terminalStatus: string };
}

interface RetentionLimits { completedRecords?: number; completedBytes?: number }
const TERMINAL_RECEIPTS = new Set(["SUCCEEDED", "FAILED_NO_EFFECT", "FAILED_WITH_EFFECT", "CANCELLED_NO_EFFECT", "CANCELLED_WITH_EFFECT"]);

/** Owned only by the process holding the exclusive runtime endpoint. */
export class HostOperationJournal {
  readonly records = new Map<string, HostOperationRecord>();
  private tail: Promise<void> = Promise.resolve();
  private loaded = false;
  private readonly transientCompleted: string[] = [];
  private readonly retainedBodies = new Map<string, number>();
  private retainedBytes = 0;
  private appendedBytes = 0;
  private appendedEntries = 0;
  private readonly maxCompletedRecords: number;
  private readonly maxCompletedBytes: number;

  constructor(private readonly path: string, limits: RetentionLimits = {}) {
    this.maxCompletedRecords = limits.completedRecords ?? 256;
    this.maxCompletedBytes = limits.completedBytes ?? 64 * 1024 * 1024;
    if (!Number.isInteger(this.maxCompletedRecords) || this.maxCompletedRecords < 0 || !Number.isSafeInteger(this.maxCompletedBytes) || this.maxCompletedBytes < 0) throw new Error("Invalid operation receipt retention limits");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(dirname(this.path), { recursive: true });
    let changed = false;
    try {
      // Stream replay keeps historical large image bodies out of one giant
      // readFile/split allocation; only unresolved and bounded retained bodies
      // remain resident. Permanent identity tombstones are intentionally kept.
      const stream = createReadStream(this.path, { encoding: "utf8" });
      let lastCharacter = "";
      stream.on("data", chunk => { if (chunk.length) lastCharacter = String(chunk).slice(-1); });
      const input = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of input) {
        if (!line) continue;
        this.appendedEntries++; this.appendedBytes += Buffer.byteLength(line) + 1;
        const decoded = JSON.parse(line) as HostOperationRecord | { recordKind: "patch"; operationId: string; patch: Partial<HostOperationRecord> };
        if ("recordKind" in decoded) {
          if (decoded.recordKind !== "patch" || !this.records.has(decoded.operationId)) throw new Error("Operation journal patch has no accepted identity");
          const previous = this.records.get(decoded.operationId)!;
          if (!previous.expired) this.records.set(decoded.operationId, { ...previous, ...decoded.patch });
        } else {
          const entry = decoded;
          if (!entry.command?.operationId || !entry.command.requestDigest) throw new Error("Invalid operation journal entry");
          const previous = this.records.get(entry.command.operationId);
          if (previous && previous.command.requestDigest !== entry.command.requestDigest) throw new Error("Operation journal identity cannot change");
          if (!previous?.expired) this.records.set(entry.command.operationId, entry);
        }
        const operationId = "recordKind" in decoded ? decoded.operationId : decoded.command.operationId!;
        this.trackBody(operationId);
        changed = this.expireBodies() || changed;
      }
      if (lastCharacter && lastCharacter !== "\n") throw new Error("Operation journal ended before its durable line boundary");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Invalid or incomplete Photoshop operation journal; recover it before dispatch", { cause: error });
    }
    if (changed || this.appendedEntries >= 1024 || this.appendedBytes >= Math.max(this.maxCompletedBytes, 1024 * 1024)) await this.compact();
    this.loaded = true;
  }

  private trackBody(operationId: string): void {
    const previousSize = this.retainedBodies.get(operationId);
    if (previousSize !== undefined) { this.retainedBytes -= previousSize; this.retainedBodies.delete(operationId); }
    const record = this.records.get(operationId)!;
    // An automation native result is not settled until artifact publication
    // and the canonical adapter receipt finish. UNKNOWN/partial verification
    // remains queryable regardless of the retention limit. Shared checkpoint
    // snapshots copy required receipts independently; asset files are untouched.
    if (!record.durable || record.expired || !record.result || record.result.effect === "unknown" || record.result.error?.code === "OUTCOME_UNKNOWN" || record.publication?.state === "intent" || (record.command.kind === "automation.execute" && (!record.adapterReceipt || !TERMINAL_RECEIPTS.has(record.adapterReceipt.status)))) return;
    const bytes = Buffer.byteLength(JSON.stringify(record));
    this.retainedBodies.set(operationId, bytes); this.retainedBytes += bytes;
  }

  private expireBodies(): boolean {
    let changed = false;
    while (this.retainedBodies.size > this.maxCompletedRecords || this.retainedBytes > this.maxCompletedBytes) {
      const oldest = this.retainedBodies.entries().next().value as [string, number] | undefined;
      if (!oldest) break;
      const [operationId, size] = oldest, record = this.records.get(operationId)!;
      this.retainedBodies.delete(operationId); this.retainedBytes -= size;
      const result = record.result!;
      this.records.set(operationId, {
        command: { ...record.command, payload: {} }, durable: true, acceptedAt: record.acceptedAt,
        ...(record.dispatchedAt ? { dispatchedAt: record.dispatchedAt } : {}), ...(record.finalizedAt ? { finalizedAt: record.finalizedAt } : {}),
        ...(record.cancelRequested ? { cancelRequested: true } : {}),
        expired: { at: new Date().toISOString(), nativeResultDigest: digest(result), terminalStatus: record.adapterReceipt?.status ?? (result.ok ? "SUCCEEDED" : "FAILED") },
        result: { requestId: result.requestId, nonce: result.nonce, operationId, ...(result.hostEpoch ? { hostEpoch: result.hostEpoch } : {}), ok: false, ...(result.effect ? { effect: result.effect } : {}),
          error: { code: "RESULT_EXPIRED", message: "The settled result body expired; this operation identity remains reserved and cannot execute again" } }
      });
      changed = true;
    }
    return changed;
  }

  private async compact(): Promise<void> {
    const temporary = `${this.path}.compact-${randomUUID()}`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        for (const record of this.records.values()) if (record.durable) await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, this.path);
      // Windows does not expose directory fsync through Node. The new file is
      // flushed before the same-directory atomic replacement on every platform.
      if (process.platform !== "win32") { const directory = await open(dirname(this.path), "r"); try { await directory.sync(); } finally { await directory.close(); } }
      this.appendedBytes = 0; this.appendedEntries = 0;
    } finally { await rm(temporary, { force: true }); }
  }

  async write(record: HostOperationRecord): Promise<void> {
    const operationId = record.command.operationId;
    if (!operationId) throw new Error("Operation journal requires an operationId");
    const snapshot = structuredClone(record);
    const persist = async () => {
      // Result delivery, cancellation, and artifact publication may finish on
      // different callbacks. Never erase a newer durable field with a stale
      // pending-request snapshot that did not contain that field.
      const previous = this.records.get(operationId);
      if (previous && previous.command.requestDigest !== snapshot.command.requestDigest) throw new Error("Operation journal identity cannot change");
      if (previous?.expired) throw Object.assign(new Error("The settled result body expired; its operation identity cannot be reused"), { code: "RESULT_EXPIRED" });
      const merged = { ...previous, ...snapshot };
      if (merged.durable) {
        // Immutable command/result payloads (which may include image bytes) are
        // appended once. Later ACK/publication records only append state fields.
        const patch: Partial<HostOperationRecord> = { ...snapshot };
        if (previous) delete patch.command;
        if (previous?.result) delete patch.result;
        const entry = previous ? { recordKind: "patch", operationId, patch } : merged;
        const serialized = `${JSON.stringify(entry)}\n`;
        const handle = await open(this.path, "a", 0o600);
        try {
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
        } finally { await handle.close(); }
        this.appendedBytes += Buffer.byteLength(serialized); this.appendedEntries++;
      }
      this.records.set(operationId, merged);
      if (!merged.durable && merged.result && !previous?.result) this.transientCompleted.push(operationId);
      while (this.transientCompleted.length > 256) this.records.delete(this.transientCompleted.shift()!);
      this.trackBody(operationId);
      const expired = this.expireBodies();
      if (expired || this.appendedEntries >= 1024 || this.appendedBytes >= Math.max(this.maxCompletedBytes, 1024 * 1024)) await this.compact();
    };
    const pending = this.tail.then(persist);
    // A failed durable append poisons the writer; dispatch must stop rather
    // than continue with an in-memory-only ownership claim.
    this.tail = pending;
    await pending;
  }

  async flush(): Promise<void> { await this.tail; }
}
