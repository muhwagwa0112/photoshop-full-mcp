"use strict";

const { randomId } = require("./storage");
const { PluginError, normalizeError } = require("./errors");
const hostEpoch = randomId("host");
const EXECUTION_PROTOCOL = "ps-mcp-executor/1";
const records = new Map();
let ownerGeneration = null;
let lastDispatchSequence = 0;
let activeOperationId = null;

function operationError(code, message, effect = "not_applied") {
  return new PluginError(code, message, { effect });
}

function operationReceipt(operationId, requestDigest) {
  const entry = records.get(operationId);
  if (!entry) return { found: false, hostEpoch };
  if (requestDigest && requestDigest !== entry.requestDigest) throw operationError("IDEMPOTENCY_CONFLICT", "Operation digest differs from the retained host receipt");
  return { found: true, hostEpoch, state: entry.state, cancelRequested: entry.cancelRequested, ...(entry.result ? { result: entry.result } : {}) };
}

function requestCancel(operationId) {
  const entry = records.get(operationId);
  if (!entry) return { requested: false, stopped: false, hostEpoch, reason: "not_observed" };
  if (entry.result) return { requested: false, stopped: entry.result.effect === "not_applied" || entry.result.effect === "rolled_back", hostEpoch, reason: "already_final" };
  entry.cancelRequested = true;
  return { requested: true, stopped: false, hostEpoch };
}

function acknowledge(operationId) {
  const entry = records.get(operationId);
  if (entry) entry.acknowledged = true;
  // Never evict an unacknowledged receipt. A compact tombstone continues to
  // prohibit replay after the full result has been durably acknowledged.
  const completed = [...records.values()].filter((item) => item.acknowledged && item.result && item.state !== "expired");
  while (completed.length > 256) {
    const old = completed.shift();
    old.state = "expired";
    old.result = { ...old.result, ok: false, data: undefined, effect: old.result.effect,
      error: { code: "OUTCOME_UNKNOWN", message: "Host result payload expired after owner ACK; read the durable owner receipt" } };
    old.promise = Promise.resolve(old.result);
  }
}

function validateExecutionRequest(request, authority) {
  if (!request || request.executionProtocol !== EXECUTION_PROTOCOL || typeof request.operationId !== "string" || !request.operationId || !/^[0-9a-f]{64}$/.test(request.requestDigest || "") || !/^[A-Za-z0-9_.:-]{8,200}$/.test(request.ownerGeneration || "") || !Number.isSafeInteger(request.dispatchSequence) || request.dispatchSequence <= 0 || request.hostEpoch !== hostEpoch) throw operationError("PRECONDITION_FAILED", "A current owner protocol, operation identity, generation, dispatch sequence and host epoch are required; stop legacy bridges and update the runtime");
  if (authority && (authority.executionProtocol !== EXECUTION_PROTOCOL || authority.ownerGeneration !== request.ownerGeneration)) throw operationError("PRECONDITION_FAILED", "Execution authority differs from the authenticated discovery handshake");
}

function executeOperation(request, execute) {
  try { validateExecutionRequest(request); } catch (error) { return Promise.reject(error); }
  const operationId = request.operationId;
  const requestDigest = request.requestDigest;
  const existing = records.get(operationId);
  if (existing) {
    if (existing.requestDigest !== requestDigest) return Promise.reject(operationError("IDEMPOTENCY_CONFLICT", "Operation ID is bound to another request digest"));
    return existing.promise;
  }
  if (request.hostEpoch && request.hostEpoch !== hostEpoch) return Promise.reject(operationError("STALE_TARGET", "Photoshop host epoch changed; rebind targets from an owned checkpoint"));
  if (request.ownerGeneration) {
    if (ownerGeneration && request.ownerGeneration !== ownerGeneration && activeOperationId) return Promise.reject(operationError("OUTCOME_UNKNOWN", "Previous authority still has an active host operation", "unknown"));
    if (request.ownerGeneration !== ownerGeneration) { ownerGeneration = request.ownerGeneration; lastDispatchSequence = 0; }
    if (!Number.isSafeInteger(request.dispatchSequence) || request.dispatchSequence <= lastDispatchSequence) return Promise.reject(operationError("PRECONDITION_FAILED", "Owner dispatch sequence is stale"));
    lastDispatchSequence = request.dispatchSequence;
  }
  const entry = { operationId, requestDigest, state: "accepted", cancelRequested: false, acknowledged: false, result: null, promise: null };
  records.set(operationId, entry);
  entry.promise = (async () => {
    let effect = "not_applied";
    const context = {
      operationId, requestDigest, hostEpoch,
      get cancelRequested() { return entry.cancelRequested; },
      markEffect(value = "applied") { effect = value; },
      throwIfCancelled() {
        if (entry.cancelRequested) throw operationError("CANCELLED", "Operation cancellation requested", effect);
        const deadline = typeof request.deadline === "number" ? request.deadline : Date.parse(request.deadline);
        if (Date.now() >= deadline) throw operationError("TIMEOUT", "Execution deadline elapsed at a cooperative boundary", effect);
      },
      bindModal(executionContext) {
        const previous = executionContext.onCancel;
        executionContext.onCancel = () => { entry.cancelRequested = true; if (typeof previous === "function") previous(); };
        if (executionContext.isCancelled) entry.cancelRequested = true;
      }
    };
    try {
      context.throwIfCancelled();
      entry.state = "running"; activeOperationId = operationId;
      const data = await execute(context);
      entry.result = { requestId: request.requestId, nonce: request.nonce, operationId, hostEpoch,
        ok: true, data, effect, cancelRequested: entry.cancelRequested };
    } catch (error) {
      const normalized = normalizeError(error);
      entry.result = { requestId: request.requestId, nonce: request.nonce, operationId, hostEpoch,
        ok: false, error: normalized, effect: normalized.details && normalized.details.effect || effect,
        cancelRequested: entry.cancelRequested };
    } finally { if (activeOperationId === operationId) activeOperationId = null; }
    entry.state = "final";
    return entry.result;
  })();
  return entry.promise;
}

module.exports = { EXECUTION_PROTOCOL, hostEpoch, validateExecutionRequest, executeOperation, operationReceipt, requestCancel, acknowledge };
