import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { CommandDefinition } from "../packages/contracts/src/index.js";
import type { ServerConfig } from "./config.js";
import { PhotoshopMcpError } from "./errors.js";

interface ApprovalRecord {
  tokenHash: Buffer;
  commandId: string;
  scopeDigest: string;
  expiresAt: number;
  used: boolean;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function approvalScopeDigest(scope: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(scope))).digest("hex");
}

export class PolicyEngine {
  private readonly approvals = new Map<string, ApprovalRecord>();

  constructor(private readonly config: ServerConfig) {}

  issueApproval(commandId: string, scope: unknown, ttlMs = 60_000): { token: string; expiresAt: number; scopeDigest: string } {
    const token = randomBytes(24).toString("base64url");
    const key = randomBytes(12).toString("hex");
    const expiresAt = Date.now() + ttlMs;
    this.approvals.set(key, {
      tokenHash: Buffer.from(token),
      commandId,
      scopeDigest: approvalScopeDigest(scope),
      expiresAt,
      used: false,
    });
    return { token: `${key}.${token}`, expiresAt, scopeDigest: approvalScopeDigest(scope) };
  }

  consumeApproval(commandId: string, scope: unknown, token: unknown): void {
    if (typeof token !== "string") throw new PhotoshopMcpError("APPROVAL_REQUIRED", `Approval is required for ${commandId}`);
    const [key, secret] = token.split(".", 2);
    const record = key ? this.approvals.get(key) : undefined;
    if (!record || !secret || record.used || record.expiresAt < Date.now() || record.commandId !== commandId || record.scopeDigest !== approvalScopeDigest(scope)) {
      throw new PhotoshopMcpError("APPROVAL_REQUIRED", "Approval token is invalid, expired, or already used");
    }
    const actual = Buffer.from(secret);
    if (actual.length !== record.tokenHash.length || !timingSafeEqual(actual, record.tokenHash)) {
      throw new PhotoshopMcpError("APPROVAL_REQUIRED", "Approval token is invalid");
    }
    record.used = true;
  }

  authorize(command: CommandDefinition, args: Record<string, unknown>, approvalToken?: unknown): void {
    if (command.status === "unavailable") {
      throw new PhotoshopMcpError("UNSUPPORTED", command.unavailableReason ?? `${command.id} is unavailable`);
    }
    if (command.status === "unverified") {
      throw new PhotoshopMcpError("UNVERIFIED", command.unavailableReason ?? `${command.id} has not been verified`);
    }
    if (command.approval !== "none") this.consumeApproval(command.id, { args }, approvalToken);
  }

  assertAdvancedEnabled(): void {
    if (this.config.advancedProfile !== "confirm") {
      throw new PhotoshopMcpError("APPROVAL_REQUIRED", "Advanced execution is disabled; set PS_MCP_ADVANCED=confirm and restart");
    }
  }

  assertAdvancedPayload(payload: unknown): void {
    if (!Array.isArray(payload) || payload.length === 0 || payload.length > 100) {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", "Advanced payload must contain 1-100 descriptors");
    }
    for (const descriptor of payload) {
      if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
        throw new PhotoshopMcpError("APPROVAL_REQUIRED", "Advanced descriptor must be an object");
      }
      const record = descriptor as Record<string, unknown>;
      const objectName = record._obj;
      // Raw ActionJSON is intentionally limited to reviewed, parameter-free
      // descriptors. A shallow `_obj` allowlist is not sufficient: malformed
      // `set`/`make` targets can otherwise reach Photoshop and trigger native
      // "unknown command" dialogs even though the public catalog is fail-closed.
      if (objectName !== "deselect" && objectName !== "invert") {
        throw new PhotoshopMcpError("APPROVAL_REQUIRED", `Advanced descriptor is not allowlisted: ${String(objectName ?? "missing _obj")}`);
      }
      const keys = Object.keys(record);
      if (keys.some((key) => key !== "_obj" && key !== "_options")) {
        throw new PhotoshopMcpError("APPROVAL_REQUIRED", `Advanced ${objectName} descriptor contains unreviewed keys`);
      }
      if (record._options !== undefined) {
        const options = record._options;
        if (!options || typeof options !== "object" || Array.isArray(options)) {
          throw new PhotoshopMcpError("APPROVAL_REQUIRED", "Advanced descriptor _options must be an object");
        }
        const optionEntries = Object.entries(options as Record<string, unknown>);
        if (optionEntries.length !== 1 || optionEntries[0]?.[0] !== "dialogOptions" || optionEntries[0]?.[1] !== "dontDisplay") {
          throw new PhotoshopMcpError("APPROVAL_REQUIRED", "Advanced descriptors may only use dialogOptions=dontDisplay");
        }
      }
    }
  }

  assertAllowedPath(path: string): string {
    if (!isAbsolute(path)) throw new PhotoshopMcpError("PRECONDITION_FAILED", "An absolute path is required");
    const resolved = resolve(path);
    const allowed = this.config.allowedRoots.some((root) => {
      const delta = relative(root, resolved);
      return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
    });
    if (!allowed) throw new PhotoshopMcpError("APPROVAL_REQUIRED", `Path is outside allowed roots: ${resolved}`);
    return resolved;
  }
}
