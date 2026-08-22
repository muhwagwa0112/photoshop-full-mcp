import { randomUUID } from "node:crypto";
import type { JobStatus } from "../packages/contracts/src/index.js";
import { PhotoshopMcpError } from "./errors.js";

export interface JobRecord {
  id: string;
  commandId: string;
  kind: "operation" | "user_assisted" | "approval";
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  message?: string;
  resumeToken?: string;
  result?: unknown;
  error?: unknown;
}

export interface JobStoreOptions {
  maxEntries?: number;
  terminalTtlMs?: number;
  activeTtlMs?: number;
  now?: () => number;
}

const TERMINAL_STATUSES = new Set<JobStatus>(["completed", "failed", "cancelled"]);

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly options: JobStoreOptions = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private prune(): void {
    const now = this.now();
    const terminalTtl = this.options.terminalTtlMs ?? 10 * 60_000;
    const activeTtl = this.options.activeTtlMs ?? 24 * 60 * 60_000;
    for (const [id, job] of this.jobs) {
      const updatedAt = Date.parse(job.updatedAt);
      const ttl = TERMINAL_STATUSES.has(job.status) ? terminalTtl : activeTtl;
      if (!Number.isFinite(updatedAt) || now - updatedAt >= ttl) this.jobs.delete(id);
    }
  }

  create(commandId: string, status: JobStatus = "queued", extras: Partial<JobRecord> = {}): JobRecord {
    this.prune();
    const maxEntries = this.options.maxEntries ?? 1_024;
    if (this.jobs.size >= maxEntries) {
      throw new PhotoshopMcpError("MODAL_BUSY", "Too many active jobs; complete or cancel existing work before creating another job");
    }
    const now = new Date(this.now()).toISOString();
    const job: JobRecord = {
      id: randomUUID(),
      commandId,
      kind: "operation",
      status,
      createdAt: now,
      updatedAt: now,
      ...extras,
    };
    this.jobs.set(job.id, job);
    return structuredClone(job);
  }

  get(id: string): JobRecord {
    this.prune();
    const job = this.jobs.get(id);
    if (!job) throw new PhotoshopMcpError("PRECONDITION_FAILED", `Unknown job: ${id}`);
    return structuredClone(job);
  }

  update(id: string, patch: Partial<Omit<JobRecord, "id" | "commandId" | "kind" | "createdAt">>): JobRecord {
    this.prune();
    const current = this.jobs.get(id);
    if (!current) throw new PhotoshopMcpError("PRECONDITION_FAILED", `Unknown job: ${id}`);
    const updated = { ...current, ...patch, updatedAt: new Date(this.now()).toISOString() };
    this.jobs.set(id, updated);
    return structuredClone(updated);
  }

  cancel(id: string): JobRecord {
    const current = this.get(id);
    if (["completed", "failed", "cancelled"].includes(current.status)) return current;
    return this.update(id, { status: "cancelled", message: "Cancelled by MCP client" });
  }

  list(): JobRecord[] {
    this.prune();
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }
}
