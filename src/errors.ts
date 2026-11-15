import type { ErrorCode, McpEnvelope } from "../packages/contracts/src/index.js";

export class PhotoshopMcpError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PhotoshopMcpError";
  }
}

export function toErrorCode(value: unknown): ErrorCode {
  const text = value instanceof Error ? value.message : String(value);
  if (/no.?document/i.test(text)) return "NO_DOCUMENT";
  if (/modal|busy/i.test(text)) return "MODAL_BUSY";
  if (/cancel/i.test(text)) return "CANCELLED";
  if (/credit/i.test(text)) return "CREDITS_EXHAUSTED";
  if (/entitlement|sign.?in/i.test(text)) return "ENTITLEMENT_UNAVAILABLE";
  if (/timeout|deadline/i.test(text)) return "TIMEOUT";
  return "HOST_ERROR";
}

export function failureEnvelope(commandId: string, requestId: string, error: unknown): McpEnvelope {
  const known = error instanceof PhotoshopMcpError;
  return {
    ok: false,
    requestId,
    commandId,
    status: known && error.code === "OUTCOME_UNKNOWN" ? "outcome_unknown" : known && error.code === "CANCELLED" ? "cancelled" : "failed",
    summary: known ? error.message : "Photoshop command failed",
    warnings: [],
    error: {
      code: known ? error.code : toErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
  };
}
