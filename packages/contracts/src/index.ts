export const CAPABILITY_STATUSES = [
  "supported",
  "experimental",
  "requires_user",
  "unavailable",
  "unverified",
] as const;

export const RISK_LEVELS = ["read", "edit", "destructive", "external", "credit"] as const;
export const JOB_STATUSES = ["queued", "running", "cancel_requested", "awaiting_user", "completed", "failed", "cancelled"] as const;
export const ERROR_CODES = [
  "NO_DOCUMENT",
  "PRECONDITION_FAILED",
  "UNSUPPORTED",
  "UNVERIFIED",
  "REQUIRES_USER",
  "APPROVAL_REQUIRED",
  "MODAL_BUSY",
  "TIMEOUT",
  "CANCELLED",
  "ENTITLEMENT_UNAVAILABLE",
  "CREDITS_EXHAUSTED",
  "HOST_ERROR",
  "VERIFICATION_FAILED",
  "OUTCOME_UNKNOWN",
  "RESULT_EXPIRED",
  "IDEMPOTENCY_CONFLICT",
  "STALE_TARGET",
  "OUTPUT_CONFLICT",
  "CAPABILITY_UNAVAILABLE",
] as const;

export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];
export type CommandEngine = "uxp_dom" | "batchplay" | "user_assisted" | "legacy_jsx";

export interface CommandDefinition {
  id: string;
  category: string;
  labels: { en: string; ko: string };
  description: string;
  status: CapabilityStatus;
  engine: CommandEngine;
  minHostVersion: string;
  risk: RiskLevel;
  approval: "none" | "destructive" | "credit" | "advanced";
  prerequisites: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  verification: "state" | "preview" | "user" | "none";
  rollback: "history" | "close_without_save" | "none";
  evidence?: string;
  unavailableReason?: string;
}

export interface FeatureDefinition {
  id: string;
  category: string;
  labelKo: string;
  status: CapabilityStatus;
  route: string;
  reason?: string;
}

export interface BridgeCommand {
  executionProtocol?: "ps-mcp-executor/1";
  operationId?: string;
  requestDigest?: string;
  ownerGeneration?: string;
  dispatchSequence?: number;
  hostEpoch?: string;
  requestId: string;
  nonce: string;
  deadline: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface BridgeResult {
  requestId: string;
  nonce: string;
  ok: boolean;
  operationId?: string;
  hostEpoch?: string;
  effect?: "not_applied" | "applied" | "rolled_back" | "partial" | "unknown";
  cancelRequested?: boolean;
  data?: unknown;
  error?: { code?: string; message: string; details?: unknown };
}

export interface McpEnvelope<T = unknown> {
  ok: boolean;
  requestId: string;
  commandId: string;
  status: "completed" | "queued" | "awaiting_user" | "failed" | "cancelled" | "outcome_unknown";
  summary: string;
  result?: T;
  warnings: string[];
  before?: unknown;
  after?: unknown;
  undo?: { available: boolean; historyStates?: number };
  error?: { code: ErrorCode; message: string; details?: unknown };
}
