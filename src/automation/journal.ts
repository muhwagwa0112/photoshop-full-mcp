import { mkdir, open, readFile, unlink, truncate, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import { canonicalJson, digest, parseStrictJson } from './canonical.js';
import { AutomationError, requireCondition } from './errors.js';

export interface JournalEvent<T = unknown> {
  sequence: number; time: string; type: string; key: string; data: T; previousHash: string; hash: string;
}
export class DurableJournal {
  private handle: FileHandle | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private records: JournalEvent[] = [];
  private writeFailure: unknown;
  private ownsLock = false;
  private lockPath: string;
  private filePath: string;
  constructor(directory: string, public readonly namespaceId: string) {
    const home = path.join(directory, 'journals', digest(namespaceId));
    this.filePath = path.join(home, 'events.jsonl'); this.lockPath = path.join(home, 'owner.lock');
  }
  async initialize(): Promise<void> {
    if (this.handle) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const lock = await open(this.lockPath, 'wx');
        this.ownsLock = true;
        try { await lock.writeFile(JSON.stringify({ pid: process.pid, namespaceId: this.namespaceId })); await lock.sync(); } finally { await lock.close(); }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let owner: { pid?: number; namespaceId?: string };
        try { owner = JSON.parse(await readFile(this.lockPath, 'utf8')) as typeof owner; } catch { throw new AutomationError('OWNER_LOCK_UNREADABLE', 'Cannot establish whether the journal owner is alive.'); }
        requireCondition(owner.namespaceId === this.namespaceId && Number.isInteger(owner.pid), 'OWNER_LOCK_CONFLICT', 'Journal lock belongs to an unknown owner.');
        let alive = true;
        try { process.kill(owner.pid!, 0); } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        requireCondition(!alive, 'WORKFLOW_OWNER_ACTIVE', 'This namespace already has an active workflow writer.');
        await unlink(this.lockPath);
      }
    }
    try {
      let bytes: Buffer;
      try { bytes = await readFile(this.filePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; bytes = Buffer.alloc(0); }
      const finalNewline = bytes.lastIndexOf(10);
      const completeBytes = bytes.length === 0 ? 0 : finalNewline + 1;
      const lines = bytes.subarray(0, completeBytes).toString('utf8').split('\n').filter(Boolean);
      let previousHash = '0'.repeat(64);
      for (const line of lines) {
        const record = parseStrictJson(line) as JournalEvent;
        const { hash, ...body } = record;
        requireCondition(record.sequence === this.records.length + 1 && record.previousHash === previousHash && digest(body) === hash, 'JOURNAL_CORRUPT', 'Journal sequence or hash chain is invalid.');
        this.records.push(record); previousHash = hash;
      }
      // A torn last append was never acknowledged; retain every complete fsynced event.
      if (completeBytes !== bytes.length) await truncate(this.filePath, completeBytes);
      this.handle = await open(this.filePath, 'a');
    } catch (error) { await unlink(this.lockPath).catch(() => undefined); this.ownsLock = false; throw error; }
  }
  private async write<T>(type: string, key: string, data: T): Promise<JournalEvent<T>> {
    requireCondition(this.handle, 'JOURNAL_NOT_OPEN', 'Journal is not initialized.');
    const body = { sequence: this.records.length + 1, time: new Date().toISOString(), type, key, data: structuredClone(data), previousHash: this.records.at(-1)?.hash ?? '0'.repeat(64) };
    const record: JournalEvent<T> = { ...body, hash: digest(body) };
    const serialized = canonicalJson(record) + '\n';
    try { await this.handle.writeFile(serialized); await this.handle.sync(); }
    catch (error) { this.writeFailure = error; throw error; }
    this.records.push(record); return structuredClone(record);
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const checked = async (): Promise<T> => { requireCondition(!this.writeFailure, 'JOURNAL_WRITE_POISONED', 'A durable write failed; this owner cannot accept or dispatch more work before recovery.'); return fn(); };
    const next = this.tail.then(checked, checked); this.tail = next.then(() => undefined, () => undefined); return next;
  }
  append<T>(type: string, key: string, data: T): Promise<JournalEvent<T>> { return this.exclusive(() => this.write(type, key, data)); }
  latest<T>(type: string, key: string): T | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) { const event = this.records[i]!; if (event.type === type && event.key === key) return structuredClone(event.data) as T; }
    return undefined;
  }
  all<T = unknown>(type?: string): JournalEvent<T>[] { return structuredClone(this.records.filter(record => !type || record.type === type)) as JournalEvent<T>[]; }
  async acceptOnce<T>(kind: 'submission' | 'operation', key: string, requestDigest: string, create: () => T): Promise<{ existing: boolean; value: T }> {
    return this.exclusive(async () => {
      const previous = this.latest<{ requestDigest: string; value: T }>(`${kind}.accepted`, key);
      if (previous) {
        requireCondition(previous.requestDigest === requestDigest, 'IDEMPOTENCY_CONFLICT', `The ${kind} ID is already bound to a different request.`);
        return { existing: true, value: previous.value };
      }
      requireCondition(!this.latest('namespace.retired', this.namespaceId), 'NAMESPACE_RETIRED', 'This workflow namespace has been retired.');
      const value = create();
      await this.write(`${kind}.accepted`, key, { requestDigest, value });
      return { existing: false, value };
    });
  }
  async expireResult(kind: 'submission' | 'operation', key: string): Promise<void> {
    requireCondition(this.latest(`${kind}.accepted`, key), 'UNKNOWN_ID', 'Cannot expire an unknown identity.');
    await this.append(`${kind}.expired`, key, { expiredAt: new Date().toISOString() });
  }
  isExpired(kind: 'submission' | 'operation', key: string): boolean { return this.latest(`${kind}.expired`, key) !== undefined; }
  /** Rewrite only retained bodies while preserving every accepted identity tombstone. */
  compact(transform: (events: JournalEvent[]) => { type: string; key: string; data: unknown }[]): Promise<void> {
    return this.exclusive(async () => {
      requireCondition(this.handle, 'JOURNAL_NOT_OPEN', 'Journal is not initialized.');
      const retained = transform(structuredClone(this.records)); const rebuilt: JournalEvent[] = []; let previousHash = '0'.repeat(64);
      for (const item of retained) { const body = { sequence: rebuilt.length + 1, time: new Date().toISOString(), ...item, previousHash }; const record = { ...body, hash: digest(body) }; rebuilt.push(record); previousHash = record.hash; }
      const temporary = `${this.filePath}.${randomUUID()}.compacting`;
      try {
        const handle = await open(temporary, 'wx');
        try { for (const record of rebuilt) await handle.writeFile(canonicalJson(record) + '\n'); await handle.sync(); } finally { await handle.close(); }
        // Closing before rename is required by Windows; the exclusive lane prevents intervening appends.
        await this.handle.close(); this.handle = undefined;
        await rename(temporary, this.filePath);
        this.handle = await open(this.filePath, 'a');
        // POSIX directory fsync makes the rename durable; Windows does not expose this primitive.
        if (process.platform !== 'win32') { const directory = await open(path.dirname(this.filePath), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
        this.records = rebuilt;
      } catch (error) { this.writeFailure = error; await unlink(temporary).catch(() => undefined); throw error; }
    });
  }
  async close(): Promise<void> {
    await this.tail;
    if (this.handle) { await this.handle.close(); this.handle = undefined; }
    if (this.ownsLock) { await unlink(this.lockPath); this.ownsLock = false; }
  }
}
