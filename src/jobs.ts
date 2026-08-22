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

export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();

  create(commandId: string, status: JobStatus = "queued", extras: Partial<JobRecord> = {}): JobRecord {
    const now = new Date().toISOString();
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
    const job = this.jobs.get(id);
    if (!job) throw new PhotoshopMcpError("PRECONDITION_FAILED", `Unknown job: ${id}`);
    return structuredClone(job);
  }

  update(id: string, patch: Partial<Omit<JobRecord, "id" | "commandId" | "kind" | "createdAt">>): JobRecord {
    const current = this.jobs.get(id);
    if (!current) throw new PhotoshopMcpError("PRECONDITION_FAILED", `Unknown job: ${id}`);
    const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
    this.jobs.set(id, updated);
    return structuredClone(updated);
  }

  cancel(id: string): JobRecord {
    const current = this.get(id);
    if (["completed", "failed", "cancelled"].includes(current.status)) return current;
    return this.update(id, { status: "cancelled", message: "Cancelled by MCP client" });
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }
}
