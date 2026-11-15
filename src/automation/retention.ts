import type { JobReceipt, OperationReceipt, SubmissionReceipt } from './contracts.js';
import type { JournalEvent } from './journal.js';
import { canonicalJson } from './canonical.js';

interface State { receipt: JobReceipt; pendingControllerId?: string }
interface Owner { revisionId?: string; jobId?: string }
const terminal = new Set(['COMPLETED', 'CANCELLED', 'BLOCKED_CAPABILITY', 'FAILED_REQUIREMENTS', 'FAILED_ENVIRONMENT', 'FAILED']);
const unsettled = new Set(['OUTCOME_UNKNOWN', 'RUNNING', 'DISPATCH_INTENT', 'CANCEL_REQUESTED', 'APPLIED_UNVERIFIED']);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const ownerOf = (value: unknown): Owner => { const o = object(value); return { ...(typeof o.revisionId === 'string' ? { revisionId: o.revisionId } : {}), ...(typeof o.jobId === 'string' ? { jobId: o.jobId } : {}) }; };
export interface RetentionResult { entries: { type: string; key: string; data: unknown }[]; expiredRevisions: string[]; expiredJobs: string[]; retainedBodyBytes: number; protectedBodyBytes: number }

/** Bounded result bodies; identity tombstones and unresolved effects never expire. */
export function retainJournal(events: JournalEvent[], limits: { maxCompletedRevisions: number; maxRetainedBytes: number }): RetentionResult {
  const states = new Map<string, State>(); const current = new Map<string, string>(); const accepted = new Map<string, Owner>(); const controllers = new Map<string, Owner>(); const checkpointOwners = new Map<string, Owner>();
  const expiredBefore = new Set(events.filter(event => event.type === 'revision.expired').map(event => event.key));
  for (const event of events) {
    if (event.type === 'job.state') { const state = event.data as State; states.set(state.receipt.revisionId, state); current.set(state.receipt.jobId, state.receipt.revisionId); for (const cp of state.receipt.checkpoints) checkpointOwners.set(cp.checkpointId, { revisionId: cp.revisionId, jobId: cp.jobId }); }
    if (event.type === 'operation.accepted') accepted.set(event.key, ownerOf(object(event.data).value));
    if (event.type === 'controller.request') controllers.set(event.key, ownerOf(object(event.data).request));
  }
  const eventOwner = (event: JournalEvent): Owner => {
    if (event.type === 'job.state') return ownerOf((event.data as State).receipt);
    const d = object(event.data); const nested = object(d.value); const direct = ownerOf(d);
    if (direct.revisionId) return direct;
    if (event.type === 'submission.accepted') return ownerOf(nested.submission);
    if (event.type === 'image.geometry') return accepted.get(event.key.slice(0, event.key.lastIndexOf(':'))) ?? {};
    if (event.type.startsWith('operation.') || event.type === 'worker.identity' || event.type === 'image.source-state' || event.type === 'checkpoint.operation') return accepted.get(event.key) ?? {};
    if (event.type.startsWith('controller.') || event.type === 'model.usage') return controllers.get(typeof d.requestId === 'string' ? d.requestId : event.key) ?? (typeof d.jobId === 'string' ? { jobId: d.jobId } : {});
    if (event.type === 'checkpoint.snapshot') return checkpointOwners.get(event.key) ?? {};
    if (event.type === 'materialization.completed') return { revisionId: event.key.split(':')[0]! };
    return {};
  };
  const folded = new Map<string, JournalEvent>();
  for (const event of events) { const identity = event.type === 'job.state' ? `${event.type}:${(event.data as State).receipt.revisionId}` : `${event.type}:${event.key}`; folded.set(identity, event); }
  const latest = [...folded.values()].sort((a, b) => a.sequence - b.sequence);
  const protectedRevisions = new Set<string>(); const neededCheckpoints = new Set<string>(); const activeJobs = new Set<string>();
  for (const [revisionId, state] of states) {
    if (state.pendingControllerId || current.get(state.receipt.jobId) === revisionId && !terminal.has(state.receipt.status)) { protectedRevisions.add(revisionId); activeJobs.add(state.receipt.jobId); for (const cp of state.receipt.checkpoints) neededCheckpoints.add(cp.checkpointId); }
  }
  for (const event of latest) {
    const owner = eventOwner(event);
    if (event.type === 'operation.receipt' && unsettled.has((event.data as OperationReceipt).status) && owner.revisionId) { protectedRevisions.add(owner.revisionId); if (owner.jobId) activeJobs.add(owner.jobId); }
    if (event.type === 'model.usage' && ['unknown', 'reserved'].includes(String(object(object(event.data).usage).state)) && owner.revisionId) { protectedRevisions.add(owner.revisionId); if (owner.jobId) activeJobs.add(owner.jobId); }
  }
  const bytes = new Map<string, number>();
  for (const event of latest) { const owner = eventOwner(event); if (owner.revisionId && !expiredBefore.has(owner.revisionId)) bytes.set(owner.revisionId, (bytes.get(owner.revisionId) ?? 0) + Buffer.byteLength(canonicalJson(event.data))); }
  const candidates = [...states.keys()].filter(id => !protectedRevisions.has(id) && !expiredBefore.has(id));
  const expired = new Set(expiredBefore); let retainedBytes = [...bytes.values()].reduce((sum, value) => sum + value, 0); let count = candidates.length;
  for (const revision of candidates) {
    if (count <= limits.maxCompletedRevisions && retainedBytes <= limits.maxRetainedBytes) break;
    expired.add(revision); count--; retainedBytes -= bytes.get(revision) ?? 0;
  }
  const expiredJobs = [...current].filter(([, revision]) => expired.has(revision)).map(([jobId]) => jobId);
  const now = new Date().toISOString(); const entries: RetentionResult['entries'] = [];
  for (const event of latest) {
    if (event.type.endsWith('.expired') || event.type === 'namespace.retired') { entries.push({ type: event.type, key: event.key, data: event.data }); continue; }
    const owner = eventOwner(event); const removeBody = owner.revisionId !== undefined && expired.has(owner.revisionId);
    if (event.type === 'model.usage' && owner.jobId && expiredJobs.includes(owner.jobId) && !activeJobs.has(owner.jobId)) continue;
    if (!removeBody) { entries.push({ type: event.type, key: event.key, data: event.data }); continue; }
    if (event.type === 'submission.accepted') {
      const d = object(event.data); const value = object(d.value); entries.push({ type: event.type, key: event.key, data: { requestDigest: d.requestDigest, value: { submission: value.submission as SubmissionReceipt } } });
      entries.push({ type: 'submission.expired', key: event.key, data: { expiredAt: now } });
    } else if (event.type === 'operation.accepted') {
      const d = object(event.data); entries.push({ type: event.type, key: event.key, data: { requestDigest: d.requestDigest, value: { operationId: event.key, ...owner } } });
      entries.push({ type: 'operation.expired', key: event.key, data: { expiredAt: now } });
    } else if (event.type === 'checkpoint.snapshot' && neededCheckpoints.has(event.key) || event.type === 'model.usage' && owner.jobId && activeJobs.has(owner.jobId)) entries.push({ type: event.type, key: event.key, data: event.data });
  }
  for (const revisionId of expired) if (!expiredBefore.has(revisionId)) entries.push({ type: 'revision.expired', key: revisionId, data: { expiredAt: now } });
  for (const jobId of expiredJobs) entries.push({ type: 'job.expired', key: jobId, data: { revisionId: current.get(jobId), expiredAt: now } });
  const deduplicated = new Map(entries.map(entry => [entry.type === 'job.state' ? `${entry.type}:${(entry.data as State).receipt.revisionId}` : `${entry.type}:${entry.key}`, entry]));
  return { entries: [...deduplicated.values()], expiredRevisions: [...expired], expiredJobs, retainedBodyBytes: Math.max(0, retainedBytes), protectedBodyBytes: [...protectedRevisions].reduce((sum, id) => sum + (bytes.get(id) ?? 0), 0) };
}
