import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppId, ArtifactReceipt, ArtifactSpec, AssetLocator, AssetRef, AutomationController, CheckpointRecord, ControllerRequest, ControllerResponse, EditPlan, EvidenceReceipt, ExpectedState, HostRef, JobReceipt, Json, JsonObject, ModelUsage, OperationReceipt, OperationRequest, PlanStep, RecipeRequest, Rect, RequirementSpec, ResourceItem, SemanticPatch, SubmissionReceipt, TargetRef, VerificationResult, VisualEvidenceReceipt, WorkflowHome } from './contracts.js';
import { AssetStore, type AssetRoots } from './assets.js';
import { DurableJournal } from './journal.js';
import { OperationRegistry } from './registry.js';
import { compileRecipe } from './compiler.js';
import { validateDag } from './validation.js';
import { resolveAsset, resolveTarget, selectResource } from './bindings.js';
import { digest, parseStrictJson } from './canonical.js';
import { AutomationError, asAutomationError, requireCondition } from './errors.js';
import type { HostRegistration, MaterializingHostAdapter } from './host.js';
import { runWorker, runSync, WorkerResultError, type WorkerClient, type WorkerExecution } from './worker.js';
import { prepareRoles, observeRoles, type RoleObservation } from './roles.js';
import { ControllerAttemptError, ModelBudgetLedger, OllamaLocalController, evaluateRequirements, validateControllerResponse, type ModelReservation, type OllamaProfile } from './controller.js';
import { buildInterviewCutMap, captionsFromWords, frameTicks, range, remapRange, serializeCaptions, TICKS_PER_SECOND, type Cue, type CutSegment, type Word } from './timeline.js';
import { rebindCheckpointReceipt, resourceItems } from './materialization.js';
import { mapPixelCenter, photoRectToDocument, rasterPoint, sourcePoint, transformRect, type SourcePlacement } from './coordinates.js';
import { runNativeBatch } from './native-batches.js';
import { retainJournal } from './retention.js';
import { buildReviewProjection } from './review-projections.js';

export interface WorkflowServiceOptions {
  workflowHome: WorkflowHome;
  dataDirectory: string;
  roots: AssetRoots;
  worker?: WorkerClient;
  controller?: AutomationController;
  presets?: Record<string, AssetLocator>;
  sequencePresets?: Record<string, AssetLocator>;
  operationTimeoutMs?: number;
  retention?: { maxCompletedRevisions?: number; maxRetainedBytes?: number };
  forwardSubmit?: (request: RecipeRequest) => Promise<unknown>;
}
export interface WorkflowServiceApi {
  describe(): Promise<unknown>;
  submit(request: unknown): Promise<unknown>;
  status(query: { jobId?: string; requestId?: string; workflowHome?: WorkflowHome }): Promise<unknown>;
  cancel(jobId: string): Promise<unknown>;
  outputs(jobId: string): Promise<unknown>;
  operationStatus(operationId: string): Promise<unknown>;
  controllerRequest(jobId: string): Promise<unknown>;
  controllerRespond(response: ControllerResponse): Promise<unknown>;
}
interface AcceptedJob { submission: SubmissionReceipt; request: RecipeRequest }
interface JobState {
  submission: SubmissionReceipt;
  request: RecipeRequest;
  plan?: EditPlan;
  receipt: JobReceipt;
  inputs: Record<string, AssetRef>;
  stepOperations: Record<string, string>;
  retainedReceipts: Record<string, OperationReceipt>;
  repairs: number;
  revisionCount: number;
  pendingControllerId?: string;
  createdAt: string;
  reviewStartedAt?: string;
  pendingMaterializations?: Record<string, { checkpointId?: string; reason: string }>;
  nativeStates?: Record<string, { host: HostRef; state: ExpectedState }>;
}
interface ControllerIntent { request: ControllerRequest; context: unknown; key: string; reservation: ModelReservation }
interface CheckpointSnapshot { root: TargetRef; observed: ResourceItem[]; receipts: Record<string, OperationReceipt> }
const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'BLOCKED_CAPABILITY', 'FAILED_REQUIREMENTS', 'FAILED_ENVIRONMENT', 'FAILED']);
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const missing = (req: OperationRequest, status: 'QUEUED' | 'PREPARED' | 'DISPATCH_INTENT' | 'RUNNING' | 'OUTCOME_UNKNOWN' | 'CANCEL_REQUESTED' | 'CANCELLED_NO_EFFECT' | 'FAILED_NO_EFFECT', error?: AutomationError): OperationReceipt => ({
  operationId: req.operationId, requestDigest: digest(req), host: req.host, status,
  effect: status === 'OUTCOME_UNKNOWN' || status === 'CANCEL_REQUESTED' || status === 'RUNNING' || status === 'DISPATCH_INTENT' ? 'unknown' : 'not_applied',
  dataState: 'unavailable', dataSchemaId: null, data: null, dataReason: status === 'QUEUED' || status === 'PREPARED' ? 'not_started' : 'not_observed',
  resources: {}, verification: [], evidence: [], artifacts: [], recovery: { authorityId: req.executionNamespaceId, authorityGeneration: req.host.hostEpoch, savedThroughOperationIds: [], effectEvidence: 'none' }, cancelRequested: status === 'CANCEL_REQUESTED' || status === 'CANCELLED_NO_EFFECT', timestamps: { accepted: new Date().toISOString() },
  ...(req.target ? { targetBefore: req.target } : {}), ...(error ? { error: { code: error.code, message: error.message, retrySafe: status === 'FAILED_NO_EFFECT', nextAction: status === 'OUTCOME_UNKNOWN' ? 'query_receipt' as const : 'none' as const } } : {})
});

export class WorkflowService implements WorkflowServiceApi {
  readonly assets: AssetStore;
  readonly registry = new OperationRegistry();
  readonly journal: DurableJournal;
  readonly budget: ModelBudgetLedger;
  private readonly hosts = new Map<AppId, HostRegistration>();
  private readonly jobs = new Map<string, JobState>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly pendingResumes = new Set<string>();
  private readonly nativeWaits = new Map<string, () => void>();
  private readonly workerChildren = new Map<string, Set<string>>();
  private readonly controllerTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly hostLanes = new Map<AppId, Promise<unknown>>();
  private submissionLane: Promise<unknown> = Promise.resolve();
  private retentionLane: Promise<void> = Promise.resolve();
  private worker: WorkerClient | undefined;
  private controller: AutomationController | undefined;
  private initialization: Promise<void> | undefined;
  private closing = false;
  constructor(public readonly options: WorkflowServiceOptions) {
    this.assets = new AssetStore(options.roots, options.dataDirectory);
    this.journal = new DurableJournal(options.dataDirectory, options.workflowHome.namespaceId);
    this.budget = new ModelBudgetLedger(this.journal); this.worker = options.worker; this.controller = options.controller;
  }
  registerHost(app: AppId, adapter: MaterializingHostAdapter, resolveHost: () => Promise<HostRef>): void { this.hosts.set(app, { adapter, resolveHost }); }
  registerWorker(worker: WorkerClient): void { this.worker = worker; }
  registerController(controller: AutomationController): void { this.controller = controller; }
  configureOllama(profile: OllamaProfile): void { this.controller = new OllamaLocalController(profile, this.assets, this.registry, request => this.contextForController(request)); }
  async describe(): Promise<unknown> {
    await this.start(); const hosts: Record<string, unknown> = {};
    for (const [app, registration] of this.hosts) {
      try { const host = await registration.resolveHost(); hosts[app] = { host, capabilities: await registration.adapter.describeCapabilities(host) }; }
      catch (error) { hosts[app] = { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }; }
    }
    const workers: Record<string, unknown> = {};
    for (const spec of this.registry.list().filter(spec => spec.route === 'worker')) workers[spec.id] = this.worker?.availability ? await this.worker.availability(spec.id as Parameters<NonNullable<WorkerClient['availability']>>[0]) : { state: this.worker ? 'unknown' : 'requires_setup', reason: this.worker ? 'This worker does not expose provider inspection.' : 'No local worker is configured.' };
    const controller = this.controller instanceof OllamaLocalController ? await this.controller.describe() : { state: this.controller ? 'unknown' : 'requires_setup', reason: this.controller ? 'A controller is registered without an inspection method.' : 'No configured local controller is available; client_agent mode can use the pending request protocol.' };
    return { contractVersion: '1.0', workflowHome: this.options.workflowHome, roots: this.assets.rootDescriptions(), presetIds: Object.keys(this.options.presets ?? {}), sequencePresetIds: Object.keys(this.options.sequencePresets ?? {}), controller, workers, hosts, recipeIds: ['ps.product_variants.v1', 'ps.photo_composite.v1', 'ps.social_layout.v1', 'pr.interview_captioned.v1', 'pr.multicam_edit.v1', 'pr.project_revision.v1', 'cross.ps_title_to_premiere.v1'] };
  }
  async contextForController(request: ControllerRequest): Promise<unknown> { await this.start(); const intent = this.journal.latest<ControllerIntent>('controller.request', request.requestId); requireCondition(intent && intent.request.requestDigest === request.requestDigest, 'CONTROLLER_REQUEST_UNKNOWN', 'Controller context is not registered.'); return intent.context; }
  async start(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      await this.assets.initialize(); await this.journal.initialize();
      for (const event of this.journal.all<JobState>('job.state')) if (!this.journal.latest('job.expired', event.key)) this.jobs.set(event.key, event.data);
      for (const event of this.journal.all<{ requestDigest: string; value: AcceptedJob }>('submission.accepted')) {
        if (this.journal.isExpired('submission', event.key)) continue;
        const accepted = event.data.value;
        const known = this.journal.all<JobState>('job.state').some(state => state.data.receipt.revisionId === accepted.submission.revisionId);
        if (!known) await this.createJob(accepted);
      }
      // A receipt can be durable when the following job snapshot was interrupted.
      // Restore the last observed native baseline from that receipt, never by sampling a changed live document.
      for (const job of this.jobs.values()) {
        const savedSequence = this.journal.all<JobState>('job.state').filter(event => event.data.receipt.revisionId === job.receipt.revisionId).at(-1)?.sequence ?? 0;
        let changed = false;
        for (const event of this.journal.all<OperationReceipt>('operation.receipt').filter(event => event.sequence > savedSequence)) {
          const accepted = this.journal.latest<{ value: OperationRequest }>('operation.accepted', event.key);
          if (!accepted || accepted.value.jobId !== job.receipt.jobId || accepted.value.revisionId !== job.receipt.revisionId) continue;
          const observed = this.nativeState(event.data); if (observed) { job.nativeStates ??= {}; job.nativeStates[observed.workingAssetId] = { host: event.data.host, state: observed.state }; }
          job.stepOperations[accepted.value.stepKey] = event.key;
          const entry = job.receipt.operations.find(item => item.operationId === event.key);
          if (entry) entry.status = event.data.status; else job.receipt.operations.push({ stepKey: accepted.value.stepKey, operationId: event.key, status: event.data.status });
          for (const artifact of event.data.artifacts) if (!job.receipt.artifacts.some(item => item.asset.assetId === artifact.asset.assetId)) job.receipt.artifacts.push(artifact);
          changed = true;
        }
        if (changed) await this.saveJob(job);
      }
      for (const job of this.jobs.values()) if (!TERMINAL.has(job.receipt.status)) this.schedule(job.submission.jobId);
    })(); return this.initialization;
  }
  private async saveJob(job: JobState): Promise<void> { await this.journal.append('job.state', job.submission.jobId, job); this.jobs.set(job.submission.jobId, job); }
  private async createJob(accepted: AcceptedJob): Promise<JobState> {
    const job: JobState = { ...accepted, receipt: { jobId: accepted.submission.jobId, revisionId: accepted.submission.revisionId, status: 'ACCEPTED', operations: [], artifacts: [], requirementResults: [], checkpoints: [], modelUsage: [], unresolved: [] }, inputs: {}, stepOperations: {}, retainedReceipts: {}, repairs: 0, revisionCount: 0, createdAt: new Date().toISOString() };
    try { job.plan = compileRecipe(accepted.request, accepted.submission.jobId, accepted.submission.revisionId, this.registry); }
    catch (error) { const failure = asAutomationError(error); job.receipt.status = failure.code === 'BLOCKED_CAPABILITY' ? 'BLOCKED_CAPABILITY' : 'FAILED'; job.receipt.unresolved = [{ code: failure.code, message: failure.message, retrySafe: false, nextAction: 'new_plan' }]; }
    await this.saveJob(job); return job;
  }
  async submit(input: unknown): Promise<unknown> {
    const request = this.registry.validator.normalizeRequest(typeof input === 'string' ? parseStrictJson(input) : input);
    if (digest(request.workflowHome) !== digest(this.options.workflowHome)) {
      if (this.options.forwardSubmit) return this.options.forwardSubmit(request);
      throw new AutomationError('WORKFLOW_OWNER_UNAVAILABLE', 'Submit this workflow to its single configured owner.');
    }
    await this.start();
    const pending = this.submissionLane.then(() => this.acceptSubmission(request)); this.submissionLane = pending.then(() => undefined, () => undefined); return pending;
  }
  private async acceptSubmission(request: RecipeRequest): Promise<unknown> {
    const { requestId, ...semanticRequest } = request; const requestDigest = digest({ submissionKind: 'recipe', ...semanticRequest });
    const accepted = await this.journal.acceptOnce('submission', requestId, requestDigest, (): AcceptedJob => {
      if (request.revisionOf) { const parent = this.jobs.get(request.revisionOf.jobId); requireCondition(parent && parent.receipt.revisionId === request.revisionOf.revisionId && !this.running.has(parent.receipt.jobId) && !parent.pendingControllerId && !parent.receipt.operations.some(item => ['DISPATCH_INTENT', 'RUNNING', 'OUTCOME_UNKNOWN', 'CANCEL_REQUESTED', 'APPLIED_UNVERIFIED'].includes(item.status)), 'REVISION_CONFLICT', 'Parent revision is missing, changed, waiting for a controller, or has unsettled work.'); }
      return { request, submission: { requestId, requestDigest, workflowHome: request.workflowHome, jobId: request.revisionOf?.jobId ?? randomUUID(), revisionId: randomUUID(), resultRetention: 'available' } };
    });
    if (this.journal.isExpired('submission', requestId)) return { submission: { ...accepted.value.submission, resultRetention: 'expired' }, error: { code: 'RESULT_EXPIRED', message: 'This identity remains reserved; use a new request ID for an intentional new execution.' } };
    let job = this.jobs.get(accepted.value.submission.jobId);
    if (request.revisionOf && !accepted.existing) {
      job = await this.createJob(accepted.value);
    } else if (!job) job = await this.createJob(accepted.value);
    if (!TERMINAL.has(job.receipt.status)) this.schedule(job.receipt.jobId);
    await this.enforceRetention();
    const historical = job.receipt.revisionId === accepted.value.submission.revisionId ? job : this.revisionState(accepted.value.submission.revisionId);
    return { submission: accepted.value.submission, job: historical?.receipt ?? null };
  }
  private revisionState(revisionId: string): JobState | undefined { return this.journal.all<JobState>('job.state').reverse().find(event => event.data.receipt.revisionId === revisionId)?.data; }
  private getJob(jobId: string): JobState { const job = this.jobs.get(jobId); requireCondition(job, this.journal.latest('job.expired', jobId) ? 'RESULT_EXPIRED' : 'WORKFLOW_NOT_FOUND', `Workflow ${jobId} has no retained result body.`); return job; }
  async status(query: { jobId?: string; requestId?: string; workflowHome?: WorkflowHome }): Promise<unknown> {
    await this.start();
    for (const job of this.jobs.values()) if (job.pendingControllerId) await this.expireControllerWait(job.receipt.jobId, job.pendingControllerId);
    if (query.workflowHome) requireCondition(digest(query.workflowHome) === digest(this.options.workflowHome), 'WORKFLOW_OWNER_UNAVAILABLE', 'Status must be requested from the workflow owner.');
    let jobId = query.jobId;
    if (query.requestId) {
      const accepted = this.journal.latest<{ value: AcceptedJob }>('submission.accepted', query.requestId); requireCondition(accepted, 'WORKFLOW_NOT_FOUND', 'Submission ID is not registered.'); jobId = accepted.value.submission.jobId;
      if (this.journal.isExpired('submission', query.requestId)) return { submission: { ...accepted.value.submission, resultRetention: 'expired' }, error: { code: 'RESULT_EXPIRED' } };
      const revision = this.revisionState(accepted.value.submission.revisionId); requireCondition(revision, 'WORKFLOW_REVISION_UNAVAILABLE', 'The accepted revision has no durable state yet.');
      return { submission: accepted.value.submission, job: revision.receipt, ...(revision.pendingControllerId ? { pendingController: this.journal.latest<ControllerIntent>('controller.request', revision.pendingControllerId)?.request } : {}) };
    }
    requireCondition(jobId, 'WORKFLOW_ID_REQUIRED', 'Provide jobId or requestId.'); const job = this.getJob(jobId);
    return { submission: job.submission, job: job.receipt, ...(job.pendingControllerId ? { pendingController: this.journal.latest<ControllerIntent>('controller.request', job.pendingControllerId)?.request } : {}) };
  }
  async outputs(jobId: string): Promise<unknown> { await this.start(); const job = this.getJob(jobId); return { jobId, revisionId: job.receipt.revisionId, status: job.receipt.status, artifacts: job.receipt.artifacts }; }
  async operationStatus(operationId: string): Promise<unknown> {
    await this.start(); const accepted = this.journal.latest<{ requestDigest: string; value: OperationRequest }>('operation.accepted', operationId); requireCondition(accepted, 'OPERATION_NOT_FOUND', 'Operation ID is unknown.');
    if (this.journal.isExpired('operation', operationId)) return { operationId, requestDigest: accepted.requestDigest, error: { code: 'RESULT_EXPIRED' } };
    return this.journal.latest<OperationReceipt>('operation.receipt', operationId) ?? missing(accepted.value, 'QUEUED');
  }
  async cancel(jobId: string): Promise<unknown> {
    await this.start(); const job = this.getJob(jobId); if (TERMINAL.has(job.receipt.status)) return job.receipt;
    job.receipt.status = 'CANCELLED'; await this.saveJob(job);
    if (job.pendingControllerId) await this.controller?.cancel(job.pendingControllerId);
    for (const entry of job.receipt.operations) {
      if (!['QUEUED', 'PREPARED', 'DISPATCH_INTENT', 'RUNNING', 'OUTCOME_UNKNOWN', 'CANCEL_REQUESTED'].includes(entry.status)) continue;
      const accepted = this.journal.latest<{ value: OperationRequest }>('operation.accepted', entry.operationId); if (!accepted) continue;
      const req = accepted.value; const previous = this.journal.latest<OperationReceipt>('operation.receipt', entry.operationId);
      if (entry.status === 'QUEUED' || entry.status === 'PREPARED') { await this.recordOperation(job, req.stepKey, missing(req, 'CANCELLED_NO_EFFECT')); continue; }
      await this.recordOperation(job, req.stepKey, { ...(previous ?? missing(req, 'CANCEL_REQUESTED')), status: 'CANCEL_REQUESTED', cancelRequested: true } as OperationReceipt);
      const spec = this.registry.get(req.operation);
      if (spec.route === 'worker') { await this.worker?.cancel(req.operationId); for (const childId of this.workerChildren.get(req.operationId) ?? []) await this.worker?.cancel(childId); }
      else if (spec.app) await this.hosts.get(spec.app)?.adapter.requestCancel(req.operationId);
    }
    return job.receipt;
  }
  async controllerRequest(jobId: string): Promise<unknown> {
    await this.start(); const job = this.getJob(jobId); const request = job.pendingControllerId ? this.journal.latest<ControllerIntent>('controller.request', job.pendingControllerId)?.request : undefined;
    if (!request) return { request: null, images: [] };
    const images: { evidenceKey: string; mimeType: string; data: string }[] = []; let bytes = 0;
    for (const evidence of request.evidence) if ('width' in evidence) {
      const content = await readFile(await this.assets.pathFor(evidence.artifact)); bytes += content.length;
      requireCondition(bytes <= 16_000_000, 'EVIDENCE_PAYLOAD_TOO_LARGE', 'MCP evidence must be captured at a smaller bounded preview size.');
      images.push({ evidenceKey: evidence.evidenceKey, mimeType: evidence.artifact.media.mimeType, data: content.toString('base64') });
    }
    return { request, images };
  }
  async controllerRespond(response: ControllerResponse): Promise<unknown> {
    await this.start(); const intent = this.journal.latest<ControllerIntent>('controller.request', response.requestId); requireCondition(intent, 'CONTROLLER_REQUEST_UNKNOWN', 'No pending controller request has this ID.');
    validateControllerResponse(intent.request, response, this.registry);
    const previous = this.journal.latest<ControllerResponse>('controller.response', response.requestId); if (previous) { requireCondition(digest(previous) === digest(response), 'IDEMPOTENCY_CONFLICT', 'Controller response already has a different result.'); return { accepted: true, requestId: response.requestId }; }
    const job = this.getJob(intent.request.jobId);
    await this.expireControllerWait(job.receipt.jobId, response.requestId);
    requireCondition(Date.now() < Date.parse(intent.request.expiresAt), 'CONTROLLER_DEADLINE_EXCEEDED', 'Late controller evidence cannot complete this request.');
    requireCondition(!TERMINAL.has(job.receipt.status) && job.receipt.revisionId === intent.request.revisionId && job.pendingControllerId === response.requestId, 'CONTROLLER_REQUEST_STALE', 'The response does not match the current pending revision.');
    await this.budget.settle(intent.reservation, response.usage); await this.journal.append('controller.response', response.requestId, response);
    this.clearControllerTimer(response.requestId);
    if (!TERMINAL.has(job.receipt.status) && intent.request.revisionId === job.receipt.revisionId) { delete job.pendingControllerId; job.receipt.status = 'RUNNING'; await this.saveJob(job); this.schedule(job.receipt.jobId); }
    return { accepted: true, requestId: response.requestId };
  }
  async resume(jobId: string): Promise<void> { await this.start(); const job = this.getJob(jobId); requireCondition(!TERMINAL.has(job.receipt.status), 'WORKFLOW_TERMINAL', 'A terminal job cannot be resumed.'); this.schedule(jobId); }
  async waitForIdle(jobId: string): Promise<void> { await this.start(); await this.running.get(jobId); }
  private schedule(jobId: string): void {
    if (this.closing) return;
    if (this.running.has(jobId)) { this.pendingResumes.add(jobId); return; }
    const running = Promise.resolve().then(() => this.runJob(this.getJob(jobId))).catch(async error => {
      if (this.closing) return; const job = this.getJob(jobId); if (!this.isCancelled(job)) { const failure = asAutomationError(error); job.receipt.status = 'FAILED'; job.receipt.unresolved.push({ code: failure.code, message: failure.message, retrySafe: false, nextAction: 'none' }); await this.saveJob(job); }
    }).finally(async () => { this.running.delete(jobId); if (this.pendingResumes.delete(jobId) && !TERMINAL.has(this.getJob(jobId).receipt.status)) this.schedule(jobId); await this.enforceRetention(); });
    this.running.set(jobId, running);
  }
  private receipts(job: JobState): Map<string, OperationReceipt> {
    const receipts = new Map(Object.entries(job.retainedReceipts));
    for (const [step, operationId] of Object.entries(job.stepOperations)) { const receipt = this.journal.latest<OperationReceipt>('operation.receipt', operationId); if (receipt) receipts.set(step, receipt); }
    return receipts;
  }
  private refreshTarget(initial: TargetRef, completed: Map<string, OperationReceipt>): TargetRef {
    const same = (a: TargetRef, b: TargetRef): boolean => {
      if (a.kind !== b.kind || a.workingAssetId !== b.workingAssetId || digest(a.host) !== digest(b.host)) return false;
      if (a.kind === 'ps_document' && b.kind === 'ps_document') return a.documentId === b.documentId;
      if (a.kind === 'ps_layer' && b.kind === 'ps_layer') return a.documentId === b.documentId && digest(a.layerIds) === digest(b.layerIds);
      if (a.kind === 'pr_project' && b.kind === 'pr_project') return a.projectGuid === b.projectGuid;
      if (a.kind === 'pr_sequence' && b.kind === 'pr_sequence') return a.projectGuid === b.projectGuid && a.sequenceGuid === b.sequenceGuid;
      if (a.kind === 'pr_project_item' && b.kind === 'pr_project_item') return a.projectGuid === b.projectGuid && a.projectItemId === b.projectItemId;
      if (a.kind === 'pr_track' && b.kind === 'pr_track') return a.projectGuid === b.projectGuid && a.sequenceGuid === b.sequenceGuid && a.mediaType === b.mediaType && a.trackIndex === b.trackIndex;
      if (a.kind === 'pr_clip' && b.kind === 'pr_clip') return a.projectGuid === b.projectGuid && a.sequenceGuid === b.sequenceGuid && (a.clipKey === b.clipKey || !!a.uxpHandleId && a.uxpHandleId === b.uxpHandleId || !!a.cepNodeId && a.cepNodeId === b.cepNodeId);
      return false;
    };
    let current = initial;
    for (const receipt of completed.values()) {
      if (receipt.status !== 'SUCCEEDED') continue;
      if (receipt.targetBefore && receipt.targetAfter && receipt.targetAfter.kind === current.kind && same(current, receipt.targetBefore)) current = receipt.targetAfter;
      for (const resource of Object.values(receipt.resources)) for (const item of resource.kind === 'single' ? [resource.item] : resource.items) if (item.value.kind !== 'artifact' && same(current, item.value)) current = item.value;
    }
    return current;
  }
  private nativeState(receipt: OperationReceipt): { workingAssetId: string; state: ExpectedState } | undefined {
    if (receipt.status === 'SUCCEEDED' && receipt.host.app === 'photoshop' && receipt.recovery.afterState) {
      const state = receipt.recovery.afterState; const workingAssetId = state.fields['document.workingAssetId'];
      requireCondition(state.digest === digest(state.fields), 'NATIVE_STATE_DIGEST_MISMATCH', 'Observed native state digest is inconsistent.');
      requireCondition(typeof workingAssetId === 'string' && typeof state.fields['document.documentId'] === 'number' && typeof state.fields['document.historyStateId'] === 'number', 'NATIVE_STATE_INCOMPLETE', 'Photoshop post-state must identify the actual document, working asset and history state.');
      const targets = [...resourceItems(receipt).flatMap(item => item.value.kind === 'artifact' ? [] : [item.value]), ...(receipt.targetAfter ? [receipt.targetAfter] : []), ...(receipt.targetBefore ? [receipt.targetBefore] : [])];
      requireCondition(targets.some(target => target.workingAssetId === workingAssetId && 'documentId' in target && target.documentId === state.fields['document.documentId']), 'NATIVE_STATE_SCOPE_MISMATCH', 'Post-state does not belong to an observed owned target.');
      return { workingAssetId, state };
    }
    return undefined;
  }
  private async recordOperation(job: JobState, stepKey: string, receipt: OperationReceipt): Promise<void> {
    if (this.closing) return;
    const observed = this.nativeState(receipt);
    await this.journal.append('operation.receipt', receipt.operationId, receipt);
    if (observed) { job.nativeStates ??= {}; job.nativeStates[observed.workingAssetId] = { host: receipt.host, state: observed.state }; }
    const entry = job.receipt.operations.find(item => item.operationId === receipt.operationId);
    if (entry) entry.status = receipt.status; else job.receipt.operations.push({ stepKey, operationId: receipt.operationId, status: receipt.status });
    for (const artifact of receipt.artifacts) if (!job.receipt.artifacts.some(item => item.asset.rootId === artifact.asset.rootId && item.asset.relativePath === artifact.asset.relativePath && item.asset.sha256 === artifact.asset.sha256)) job.receipt.artifacts.push(artifact);
    await this.saveJob(job);
  }
  private async preflight(job: JobState): Promise<void> {
    const plan = job.plan!; const checked = new Map<AppId, Set<string>>();
    for (const step of plan.steps) {
      this.registry.validateStep(step); const spec = this.registry.get(step.operation);
      if (step.operation === 'pr.color.match' && (step.args.settings as JsonObject).method === 'shot_statistics') { requireCondition(this.worker, 'PROVIDER_NOT_CONFIGURED', 'Observed color matching requires the configured local frame worker.'); if (this.worker.availability) { const state = await this.worker.availability('media.frames', { statistics: true }); requireCondition(state.state === 'available', 'PROVIDER_NOT_CONFIGURED', state.reason ?? 'Frame statistics provider requires setup.'); } }
      if (spec.route === 'worker') {
        const manualSync = step.operation === 'audio.sync' && (step.args.sync as JsonObject).primary === 'manual';
        requireCondition(this.worker || manualSync, 'PROVIDER_NOT_CONFIGURED', 'The recipe requires its configured local worker.');
        if (!manualSync && this.worker?.availability) { const availability = await this.worker.availability(step.operation as Parameters<NonNullable<WorkerClient['availability']>>[0], step.args); requireCondition(availability.state === 'available', 'PROVIDER_NOT_CONFIGURED', availability.reason ?? `Worker provider ${step.operation} requires setup.`); }
      }
      if (!spec.app) continue;
      if (step.operation === 'pr.sequence.create') { const presetId = String(step.args.presetId ?? 'default'); const preset = this.options.sequencePresets?.[presetId]; requireCondition(preset, 'SEQUENCE_PRESET_NOT_CONFIGURED', `Missing exact sequence preset ${presetId}.`); await this.assets.resolve(preset); }
      const registration = this.hosts.get(spec.app); requireCondition(registration, 'WAIT_HOST', `No ${spec.app} adapter is connected to this owner.`);
      if (!checked.has(spec.app)) { const host = await registration.resolveHost(); const capabilities = await registration.adapter.describeCapabilities(host); checked.set(spec.app, new Set(capabilities.filter(item => item.state === 'available').map(item => item.id))); }
      const available = checked.get(spec.app)!;
      if (step.operation === 'ps.placeholder.replace') requireCondition(available.has('ps.layer.replacePixels') || available.has('ps.smartobject.replace'), 'BLOCKED_CAPABILITY', 'No qualified placeholder replacement route is available.');
      else if (step.operation === 'ps.text.fit') requireCondition(available.has('ps.text.fit') || available.has('ps.text.fit:point'), 'BLOCKED_CAPABILITY', 'No exact text fitting route is available.');
      else requireCondition(available.has(spec.capabilityId ?? spec.id), 'BLOCKED_CAPABILITY', `Host capability is unavailable: ${spec.capabilityId ?? spec.id}`);
    }
    for (const spec of plan.delivery.outputs) if (spec.encoding.kind === 'video') { const preset = this.options.presets?.[spec.encoding.encoderPresetId]; requireCondition(preset, 'ENCODER_PRESET_NOT_CONFIGURED', `Missing exact encoder preset ${spec.encoding.encoderPresetId}.`); await this.assets.resolve(preset); }
  }
  private async runJob(job: JobState): Promise<void> {
    if (!job.plan || TERMINAL.has(job.receipt.status) || this.closing) return;
    try {
      if (!Object.keys(job.inputs).length) { for (const [key, locator] of Object.entries(job.plan.inputs)) job.inputs[key] = await this.assets.resolve(locator); await this.saveJob(job); }
      for (const input of Object.values(job.inputs)) await this.assets.protectSource(input);
      await this.preflight(job); if (this.isCancelled(job) || this.closing) return; job.receipt.status = 'RUNNING'; job.receipt.unresolved = []; await this.saveJob(job);
      await this.detectHostEpochChange(job); await this.materializePending(job);
      for (;;) {
        if (this.isCancelled(job) || this.closing) return;
        const completed = this.receipts(job); const remaining = job.plan.steps.filter(step => completed.get(step.stepKey)?.status !== 'SUCCEEDED');
        if (!remaining.length) break;
        const ready = remaining.find(step => step.dependsOn.every(key => completed.get(key)?.status === 'SUCCEEDED'));
        requireCondition(ready, 'WORKFLOW_BLOCKED_DEPENDENCY', 'No remaining step has satisfied dependencies.');
        const receipt = await this.executeStep(job, ready, completed);
        if (receipt.status !== 'SUCCEEDED') {
          if (this.isCancelled(job)) return;
          if (['OUTCOME_UNKNOWN', 'RUNNING', 'DISPATCH_INTENT', 'CANCEL_REQUESTED', 'APPLIED_UNVERIFIED'].includes(receipt.status)) job.receipt.status = 'RECONCILING';
          else job.receipt.status = 'FAILED';
          if (receipt.error) job.receipt.unresolved.push(receipt.error); await this.saveJob(job); return;
        }
      }
      if (!this.isCancelled(job)) await this.reviewJob(job);
    } catch (error) {
      if (this.isCancelled(job) || this.closing) return;
      const failure = asAutomationError(error);
      if (failure.code === 'WAIT_PROVIDER' || failure.code === 'PROVIDER_NOT_CONFIGURED' || failure.code === 'CONTROLLER_OUTCOME_UNKNOWN') job.receipt.status = Date.now() > Date.parse(job.plan.controller.waitDeadline) ? 'FAILED_ENVIRONMENT' : 'WAIT_PROVIDER';
      else if (failure.code === 'WAIT_HOST' || failure.code === 'HOST_DISCONNECTED' || failure.code === 'BRIDGE_UNAVAILABLE') job.receipt.status = 'WAIT_HOST';
      else if (failure.code === 'CONTROLLER_DEADLINE_EXCEEDED') job.receipt.status = 'FAILED_ENVIRONMENT';
      else if (failure.code === 'CHECKPOINT_RESTORE_UNSETTLED' || failure.code === 'HOST_EPOCH_UNSETTLED') job.receipt.status = 'RECONCILING';
      else if (failure.code === 'BLOCKED_CAPABILITY' || failure.code.includes('UNSUPPORTED') || failure.code === 'ENCODER_PRESET_NOT_CONFIGURED') job.receipt.status = 'BLOCKED_CAPABILITY';
      else if (failure.code === 'MODEL_BUDGET_EXHAUSTED' || failure.code === 'ROLE_UNCERTAIN') job.receipt.status = 'FAILED_REQUIREMENTS';
      else job.receipt.status = 'FAILED';
      job.receipt.unresolved = [{ code: failure.code, message: failure.message, retrySafe: false, nextAction: job.receipt.status === 'WAIT_PROVIDER' || job.receipt.status === 'WAIT_HOST' ? 'none' : 'new_plan' }]; await this.saveJob(job);
    }
  }

  // Native dispatch and internal/worker execution share the same durable operation identity.
  private async executeStep(job: JobState, step: PlanStep, completed: Map<string, OperationReceipt>): Promise<OperationReceipt> {
    const spec = this.registry.get(step.operation); let request: OperationRequest;
    const savedId = job.stepOperations[step.stepKey];
    if (savedId) {
      const accepted = this.journal.latest<{ value: OperationRequest }>('operation.accepted', savedId); requireCondition(accepted, 'OPERATION_INTENT_MISSING', 'Saved step has no durable operation intent.'); request = accepted.value;
      const receipt = this.journal.latest<OperationReceipt>('operation.receipt', savedId);
      if (receipt?.status === 'SUCCEEDED') return receipt;
      if (receipt && !['QUEUED', 'PREPARED'].includes(receipt.status)) return this.reconcile(job, step, request, receipt);
    } else {
      const registration = spec.app ? this.hosts.get(spec.app) : undefined;
      const host = registration ? await registration.resolveHost() : { app: this.options.workflowHome.app, installationId: this.options.workflowHome.installationId, hostEpoch: `worker:${this.options.workflowHome.namespaceId}` };
      const resolvedAssets: Record<string, AssetRef> = {};
      for (const [key, binding] of Object.entries(step.assets ?? {})) resolvedAssets[key] = resolveAsset(binding, job.inputs, completed);
      if (step.operation === 'ps.document.open' || step.operation === 'pr.project.open') resolvedAssets.source = await this.assets.stageCopy(resolvedAssets.source!, job.receipt.jobId, job.receipt.revisionId);
      const exactTarget = step.target ? this.refreshTarget(resolveTarget(step.target, completed), completed) : undefined;
      if (exactTarget) requireCondition(exactTarget.host.app === host.app && exactTarget.host.installationId === host.installationId && exactTarget.host.hostEpoch === host.hostEpoch, 'STALE_TARGET', 'A live target belongs to another host/epoch.');
      if (exactTarget && spec.targetKinds?.length) requireCondition(spec.targetKinds.includes(exactTarget.kind), 'BINDING_TYPE_MISMATCH', `Operation ${spec.id} cannot use target kind ${exactTarget.kind}.`);
      const operationId = randomUUID(); const deadline = new Date(Date.now() + (this.options.operationTimeoutMs ?? 600_000)).toISOString();
      request = { contractVersion: '1.0', jobId: job.receipt.jobId, revisionId: job.receipt.revisionId, stepKey: step.stepKey, operationId, executionNamespaceId: this.options.workflowHome.namespaceId, operation: step.operation, host, args: step.args, assets: resolvedAssets, assertions: step.assertions, waitTimeoutMs: this.options.operationTimeoutMs ?? 600_000, executionDeadline: deadline, ...(exactTarget ? { target: exactTarget } : {}), ...(step.evidence ? { evidence: step.evidence } : {}) };
      await this.journal.acceptOnce('operation', operationId, digest(request), () => request); job.stepOperations[step.stepKey] = operationId;
      await this.recordOperation(job, step.stepKey, missing(request, 'QUEUED'));
    }
    if (this.isCancelled(job)) return missing(request, 'CANCELLED_NO_EFFECT');
    try {
      if (spec.route !== 'host') {
        if (spec.route === 'worker' && request.operation !== 'image.segment') await this.recordOperation(job, step.stepKey, missing(request, 'DISPATCH_INTENT'));
        if (request.operation === 'audio.sync') this.workerChildren.set(request.operationId, new Set((request.args.inputKeys as string[]).flatMap(key => ['timecode', 'waveform'].map(method => `${request.operationId}-${key}-${method}`))));
        if (spec.route === 'worker' && this.worker?.identity) await this.journal.append('worker.identity', request.operationId, await this.worker.identity());
        const execution = spec.route === 'worker' ? request.operation === 'audio.sync' ? await runSync(request, this.worker, this.assets, job.plan!.resources, () => !this.isCancelled(job) && !this.closing) : await this.executeWorker(job, request) : await this.executeInternal(job, request, completed);
        this.workerChildren.delete(request.operationId);
        const receipt = this.completeReceipt(request, spec.resultSchemaId, execution); this.registry.validateReceipt(step.operation, receipt); await this.recordOperation(job, step.stepKey, receipt); return receipt;
      }
      const registration = this.hosts.get(spec.app!)!;
      let prepared = await this.prepareHostRequest(job, request, completed); prepared = await registration.adapter.prepare(prepared);
      requireCondition(prepared.operationId === request.operationId && prepared.jobId === request.jobId && prepared.revisionId === request.revisionId, 'PREPARED_REQUEST_ID_CHANGED', 'Adapter prepare cannot change operation identity.');
      await this.journal.append('operation.prepared', request.operationId, prepared);
      await this.recordOperation(job, step.stepKey, missing(request, 'PREPARED'));
      const previousLane = this.hostLanes.get(spec.app!) ?? Promise.resolve();
      const execution = previousLane.catch(() => undefined).then(async () => {
        if (this.isCancelled(job)) return missing(request, 'CANCELLED_NO_EFFECT');
        await this.recordOperation(job, step.stepKey, missing(request, 'DISPATCH_INTENT'));
        const receipt = await registration.adapter.dispatch(prepared);
        // Authority receipt digest may bind the prepared request; the workflow records both intents.
        requireCondition(receipt.operationId === request.operationId, 'OPERATION_RESPONSE_MISMATCH', 'Host returned another operation identity.');
        requireCondition(receipt.requestDigest === digest(prepared) || receipt.requestDigest === digest(request), 'OPERATION_RESPONSE_MISMATCH', 'Host receipt digest does not match a persisted request.');
        this.registry.validateReceipt(step.operation, receipt);
        const verified = this.verifyAssertions(request, this.verifyAssertions(prepared, receipt)); await this.recordOperation(job, step.stepKey, verified); return verified;
      });
      this.hostLanes.set(spec.app!, execution.then(() => undefined, () => undefined));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<OperationReceipt>(resolve => { const finish = (): void => resolve(missing(request, 'OUTCOME_UNKNOWN', new AutomationError('HOST_OUTCOME_UNKNOWN', 'Host response wait ended; execution may still be running.'))); this.nativeWaits.set(request.operationId, finish); timer = setTimeout(finish, Math.max(1, Date.parse(request.executionDeadline) - Date.now())); });
      const receipt = await Promise.race([execution, timeout]); if (timer) clearTimeout(timer); this.nativeWaits.delete(request.operationId);
      if (receipt.status === 'OUTCOME_UNKNOWN') { await this.recordOperation(job, step.stepKey, receipt); void execution.then(() => { if (!TERMINAL.has(job.receipt.status) && !this.closing) this.schedule(job.receipt.jobId); }).catch(() => undefined); }
      else await this.captureCheckpoint(job, step, receipt);
      return receipt;
    } catch (error) {
      const failure = asAutomationError(error);
      if (['WAIT_PROVIDER', 'PROVIDER_NOT_CONFIGURED', 'CONTROLLER_OUTCOME_UNKNOWN'].includes(failure.code)) throw failure;
      const latest = this.journal.latest<OperationReceipt>('operation.receipt', request.operationId);
      const dispatched = !(error instanceof WorkerResultError) && latest && ['DISPATCH_INTENT', 'RUNNING', 'OUTCOME_UNKNOWN'].includes(latest.status);
      const children = job.receipt.operations.filter(item => item.stepKey.startsWith(`${step.stepKey}.`));
      const childUnknown = children.some(item => ['OUTCOME_UNKNOWN', 'RUNNING', 'DISPATCH_INTENT', 'APPLIED_UNVERIFIED'].includes(item.status));
      let receipt = missing(request, dispatched || childUnknown ? 'OUTCOME_UNKNOWN' : 'FAILED_NO_EFFECT', failure);
      const childApplied = children.some(item => { const child = this.journal.latest<OperationReceipt>('operation.receipt', item.operationId); const accepted = this.journal.latest<{ value: OperationRequest }>('operation.accepted', item.operationId); return ['FAILED_WITH_EFFECT', 'CANCELLED_WITH_EFFECT'].includes(item.status) || child && accepted && this.registry.get(accepted.value.operation).effect === 'mutable_host' && ['applied', 'partial'].includes(child.effect); });
      if (!dispatched && !childUnknown && childApplied) receipt = { ...receipt, status: 'FAILED_WITH_EFFECT', effect: 'partial' };
      await this.recordOperation(job, step.stepKey, receipt); return receipt;
    }
  }

  private completeReceipt(request: OperationRequest, schemaId: string, execution: WorkerExecution): OperationReceipt {
    const receipt: OperationReceipt = { ...missing(request, 'QUEUED'), status: 'SUCCEEDED', effect: 'applied', dataState: 'complete', dataSchemaId: schemaId, data: execution.data, resources: execution.resources, verification: execution.verification, evidence: execution.evidence, artifacts: execution.artifacts, recovery: { authorityId: request.executionNamespaceId, authorityGeneration: request.host.hostEpoch, savedThroughOperationIds: [request.operationId], afterDigest: digest(execution.data), effectEvidence: 'postcondition' }, timestamps: { accepted: new Date().toISOString(), applied: new Date().toISOString(), finalized: new Date().toISOString() } };
    delete (receipt as OperationReceipt & { dataReason?: string }).dataReason;
    return this.verifyAssertions(request, receipt);
  }
  private verifyAssertions(request: OperationRequest, receipt: OperationReceipt): OperationReceipt {
    if (receipt.status !== 'SUCCEEDED') return receipt;
    const results = new Map(receipt.verification.map(item => [item.assertionId, item]));
    if (request.operation === 'pr.clip.duration') {
      const after = receipt.targetAfter?.kind === 'pr_clip' ? receipt.targetAfter.timelineRange : (receipt.data.after as unknown as { clipKey: string; timelineRange: { start: { ticks: string }; end: { ticks: string } } }[] | undefined)?.find(item => request.target?.kind === 'pr_clip' && item.clipKey === request.target.clipKey)?.timelineRange;
      const actual = after ? String(BigInt(after.end.ticks) - BigInt(after.start.ticks)) : undefined;
      results.set(`${request.stepKey}.duration`, { assertionId: `${request.stepKey}.duration`, status: actual === request.args.durationTicks ? 'pass' : 'fail', expected: request.args.durationTicks!, ...(actual ? { actual } : {}), method: 'observed-timeline-range' });
    }
    for (const assertion of request.assertions) {
      if (results.has(assertion.id)) continue;
      const pathParts = assertion.subject.replace(/^data\./, '').split('.'); let value: unknown = receipt.data;
      for (const key of pathParts) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) { value = undefined; break; } value = (value as Record<string, unknown>)[key]; }
      let pass = false;
      if (assertion.operator === 'equals' || assertion.operator === 'interval_equals') pass = value !== undefined && digest(value) === digest(assertion.expected);
      else if (assertion.operator === 'not_equals') pass = value !== undefined && digest(value) !== digest(assertion.expected);
      else if (assertion.operator === 'exists') pass = value !== undefined;
      else if (assertion.operator === 'absent' || assertion.operator === 'target_absent') pass = value === undefined || value === null;
      else if (assertion.operator === 'within' && typeof value === 'number' && typeof assertion.expected === 'number') pass = Math.abs(value - assertion.expected) <= (assertion.tolerance ?? 0);
      results.set(assertion.id, { assertionId: assertion.id, status: pass ? 'pass' : 'fail', expected: assertion.expected, ...(value !== undefined ? { actual: json(value) } : {}), method: 'closed-result-projection' });
    }
    const verification = [...results.values()];
    if (verification.some(item => item.status !== 'pass')) return { ...receipt, status: 'FAILED_WITH_EFFECT', verification, error: { code: 'POSTCONDITION_FAILED', message: 'A declared operation assertion was not satisfied.', retrySafe: false, nextAction: 'new_plan' } };
    return { ...receipt, verification };
  }
  private async reconcile(job: JobState, step: PlanStep, request: OperationRequest, previous: OperationReceipt): Promise<OperationReceipt> {
    if (['FAILED_NO_EFFECT', 'FAILED_WITH_EFFECT', 'CANCELLED_NO_EFFECT', 'CANCELLED_WITH_EFFECT'].includes(previous.status)) return previous;
    const spec = this.registry.get(step.operation);
    if (spec.route !== 'host' || !spec.app) return { ...previous, status: 'OUTCOME_UNKNOWN', error: { code: 'WORKER_OUTCOME_UNKNOWN', message: 'The previous worker attempt has no settled receipt; it will not be automatically repeated.', retrySafe: false, nextAction: 'query_receipt' } } as OperationReceipt;
    const registration = this.hosts.get(spec.app); requireCondition(registration, 'WAIT_HOST', 'The execution host is unavailable.');
    const observed = await registration.adapter.getReceipt(request.operationId);
    if (observed) { this.registry.validateReceipt(step.operation, observed); const verified = this.verifyAssertions(request, observed); await this.recordOperation(job, step.stepKey, verified); return verified; }
    const prepared = this.journal.latest<OperationRequest>('operation.prepared', request.operationId) ?? request;
    const verification = await registration.adapter.readPostcondition(prepared);
    const receipt = { ...previous, status: 'OUTCOME_UNKNOWN' as const, verification, error: { code: 'HOST_OUTCOME_UNKNOWN', message: 'No complete host receipt is available. Postconditions alone cannot fabricate missing domain results or created target IDs.', retrySafe: false, nextAction: 'query_receipt' as const } } as OperationReceipt;
    await this.recordOperation(job, step.stepKey, receipt); return receipt;
  }
  private async prepareHostRequest(job: JobState, request: OperationRequest, completed: Map<string, OperationReceipt>): Promise<OperationRequest> {
    const req = structuredClone(request); req.args.executionResources = json({ ...job.plan!.resources, timeoutMs: Math.max(1, Date.parse(req.executionDeadline) - Date.now()) }); req.args.verifyMode = job.plan!.delivery.verifyMode; req.args.sourceAssets = json(Object.values(job.inputs));
    if (req.host.app === 'photoshop' && req.target) {
      const previous = job.nativeStates?.[req.target.workingAssetId];
      requireCondition(previous && digest(previous.host) === digest(req.host), 'NATIVE_STATE_BASELINE_UNAVAILABLE', 'No durable post-state baseline exists for this Photoshop document/epoch.');
      req.expectedBefore = previous.state;
    }
    if ((req.operation === 'ps.layer.patch' && req.assets.patch) || (req.operation === 'ps.layer.mask' && req.assets.mask)) {
      const asset = req.assets.patch ?? req.assets.mask!;
      const producer = [...completed.values()].find(receipt => receipt.status === 'SUCCEEDED' && ['image.mask.v1', 'image.patch.v1'].includes(receipt.dataSchemaId) && receipt.artifacts.some(artifact => artifact.asset.sha256 === asset.sha256));
      if (producer) {
        const sourceState = this.journal.latest<{ captureOperationId: string; sourceRasterSha256: string }>('image.source-state', producer.operationId);
        requireCondition(sourceState, 'IMAGE_SOURCE_STATE_UNAVAILABLE', 'Generated mask/patch has no durable captured native source state.');
        const captured = this.journal.latest<OperationRequest>('operation.prepared', sourceState.captureOperationId);
        requireCondition(captured?.expectedBefore && captured.target && req.target && captured.target.workingAssetId === req.target.workingAssetId && digest(captured.host) === digest(req.host), 'IMAGE_SOURCE_STATE_MISMATCH', 'Generated image and current native target do not share the captured document/epoch.');
        requireCondition(producer.dataState === 'complete' && producer.data.sourceRasterSha256 === sourceState.sourceRasterSha256, 'IMAGE_SOURCE_STATE_MISMATCH', 'Image receipt does not match its captured source hash.');
        requireCondition(!req.expectedBefore || req.expectedBefore.digest === captured.expectedBefore.digest, 'IMAGE_SOURCE_STATE_MISMATCH', 'The working document changed after this raster was captured.'); req.expectedBefore = captured.expectedBefore;
      }
    }
    if (req.operation === 'ps.document.open' || req.operation === 'pr.project.open') req.args.path = await this.assets.pathFor(req.assets.source!);
    if (req.operation === 'pr.project.create') req.args.projectPath = await this.assets.allocate(req.jobId, req.revisionId, `${req.operationId}.prproj`);
    if (req.operation === 'ps.document.create' && typeof req.args.sourceInfoStepKey === 'string') {
      const source = this.dataFrom(completed, req.args.sourceInfoStepKey);
      requireCondition([8, 16, 32].includes(Number(source.bitDepth)), 'SOURCE_DEPTH_UNSUPPORTED', 'Source bit depth has no exact native RGB working-document route.'); req.args.bitDepth = source.bitDepth!;
      if (req.args.preserveSourceColor === true) { requireCondition(source.mode === 'RGB' && typeof source.iccProfile === 'string' && source.iccProfile.length > 0, 'SOURCE_COLOR_PROFILE_UNAVAILABLE', 'preserve_input requires the observed RGB input profile; an unprofiled or non-RGB source cannot be assigned a guessed profile.'); req.args.colorProfile = source.iccProfile; }
      const restores = ((job.request.parameters.retouch as JsonObject[] | undefined) ?? []).some(step => (step.source as JsonObject).kind === 'local_restore');
      if (restores) requireCondition(req.args.bitDepth === 8 && req.args.colorProfile === 'sRGB IEC61966-2.1', 'INPAINT_SOURCE_PRECISION_UNSUPPORTED', 'This recipe authorizes deterministic local restoration only in an observed RGB8 sRGB working document; no implicit precision/gamut conversion is permitted.');
      req.assertions = [...req.assertions, { id: `${req.stepKey}.source-depth`, operator: 'equals', subject: 'data.bitDepth', expected: req.args.bitDepth! }, ...(typeof req.args.colorProfile === 'string' ? [{ id: `${req.stepKey}.source-profile`, operator: 'equals' as const, subject: 'data.iccProfile', expected: req.args.colorProfile }] : [])];
      delete req.args.sourceInfoStepKey; delete req.args.preserveSourceColor;
    }
    if (req.operation === 'ps.layer.patch' && req.args.photoGeometry) {
      req.args.region = json(await this.mapPhotoRegion(req, req.args.region as unknown as Rect, completed));
      if (req.args.sourceRegion) { const source = await this.mapPhotoRegion(req, req.args.sourceRegion as unknown as Rect, completed); const destination = req.args.region as JsonObject; requireCondition(source.width === destination.width && source.height === destination.height, 'PHOTO_CLONE_PIXEL_ALIGNMENT_UNSUPPORTED', 'Mapped clone regions must have the same actual pixel extent; fractional placement cannot silently stretch a native source region.'); req.args.sourceRegion = json(source); }
      delete req.args.photoGeometry;
    }
    if (req.operation === 'ps.layer.patch' && req.assets.patch) {
      const produced = [...completed.values()].find(receipt => receipt.dataState === 'complete' && receipt.dataSchemaId === 'image.patch.v1' && receipt.data.patchArtifactId === req.assets.patch!.assetId);
      if (produced?.dataState === 'complete') { req.args.region = produced.data.sourceRegion!; req.args.featherPx = 0; }
    }
    if (req.operation === 'pr.sequence.create') {
      const presetId = typeof req.args.presetId === 'string' ? req.args.presetId : 'default'; const preset = this.options.sequencePresets?.[presetId];
      requireCondition(preset, 'SEQUENCE_PRESET_NOT_CONFIGURED', `Missing sequence preset ${presetId}.`);
      req.assets.sequencePreset = await this.assets.resolve(preset); req.args.presetPath = await this.assets.pathFor(req.assets.sequencePreset);
    }
    if (req.operation === 'pr.media.import') req.args.items = await Promise.all((req.args.items as unknown as { itemKey: string; inputKey: string }[]).map(async item => {
      const asset = req.assets[item.inputKey]; requireCondition(asset, 'IMPORT_ASSET_MISSING', `Missing import asset ${item.inputKey}.`);
      return { ...item, path: await this.assets.pathFor(asset), sourceAssetId: asset.assetId };
    })) as unknown as Json;
    if (req.operation === 'ps.placeholder.replace') {
      const roleReceipt = completed.get(String(req.args.roleStepKey)); requireCondition(roleReceipt, 'ROLE_BINDING_MISSING', 'Placeholder role binding is missing.');
      const item = selectResource(roleReceipt.resources[`role:${String(req.args.role)}`] ?? roleReceipt.resources.roles, String(req.args.role));
      const kind = item.projection?.layerKind;
      if (kind === 'smart_object') { req.operation = 'ps.smartobject.replace'; delete req.args.box; delete req.args.fit; }
      else { requireCondition(kind === 'pixel', 'PLACEHOLDER_KIND_UNSUPPORTED', 'Placeholder replacement requires a pixel layer or native smart-object route.'); req.operation = 'ps.layer.replacePixels'; }
      delete req.args.roleStepKey; delete req.args.role;
      const registration = this.hosts.get('photoshop')!; const capabilities = await registration.adapter.describeCapabilities(req.host);
      requireCondition(capabilities.some(item => item.id === req.operation && item.state === 'available'), 'BLOCKED_CAPABILITY', `The exact placeholder route ${req.operation} is unavailable.`);
    }
    if (req.operation === 'pr.timeline.assemble') {
      const cutMap = completed.get(String(req.args.cutMapStepKey)); const imported = completed.get(String(req.args.importStepKey));
      requireCondition(cutMap?.dataState === 'complete' && imported?.status === 'SUCCEEDED', 'TIMELINE_INPUTS_MISSING', 'Timeline assembly needs a complete cut map and media import.');
      const sourceItems = imported.resources.items; requireCondition(sourceItems?.kind === 'collection' && sourceItems.complete, 'BINDING_INCOMPLETE', 'Imported project items are incomplete.');
      const cameras = req.args.cameraInputs as string[]; const audioKey = String(req.args.audioInput);
      const segments = (cutMap.data.segments as unknown as CutSegment[]).map(segment => {
        const resource = sourceItems.items.find(item => item.value.kind === 'pr_project_item' && item.value.sourceAssetId === segment.sourceAssetId);
        requireCondition(resource?.value.kind === 'pr_project_item', 'PROJECT_ITEM_BINDING_MISSING', 'Cut map source does not have an exact imported project item.');
        requireCondition(!segment.reverse && segment.speedNumerator === 1 && segment.speedDenominator === 1, 'TIME_MAP_UNSUPPORTED', 'This native assembly route requires speed-one forward segments.');
        const isAudio = resource.itemKey === audioKey || resource.itemKey === 'music'; const videoTrackIndex = isAudio ? -1 : cameras.includes(resource.itemKey) ? 0 : 1;
        return { itemKey: segment.segmentKey, projectItemId: resource.value.projectItemId, sourceInTicks: segment.sourceRange.start.ticks, sourceOutTicks: segment.sourceRange.end.ticks, timelineStartTicks: segment.timelineRange.start.ticks, videoTrackIndex, audioTrackIndex: isAudio ? resource.itemKey === 'music' ? 1 : 0 : -1 };
      });
      req.operation = 'pr.timeline.edit'; req.args = { segments: json(segments), mode: 'overwrite', executionResources: req.args.executionResources!, verifyMode: req.args.verifyMode! };
    }
    if (req.operation === 'pr.captions.apply') {
      const captions = completed.get(String(req.args.captionsStepKey)); requireCondition(captions?.dataState === 'complete', 'CAPTION_DATA_MISSING', 'Caption cues are not available.');
      const cues = captions.data.cues as unknown as Cue[];
      const file = await this.assets.allocate(req.jobId, req.revisionId, `${req.operationId}-captions.srt`); const handle = await open(file, 'wx'); try { await handle.writeFile(serializeCaptions(cues, 'srt')); await handle.sync(); } finally { await handle.close(); }
      req.assets.subtitles = await this.assets.registerGenerated(file, { kind: 'subtitle', mimeType: 'application/x-subrip' });
      req.operation = 'pr.captions.import'; req.args = { cues: cues.map(cue => ({ id: cue.cueKey, startTicks: cue.range.start.ticks, endTicks: cue.range.end.ticks, text: cue.text })), stylePresetId: req.args.stylePresetId!, nativeEditable: req.args.nativeEditable!, srtPath: file, executionResources: req.args.executionResources!, verifyMode: req.args.verifyMode! };
      if (req.target?.kind === 'pr_sequence') req.args.sequenceGuid = req.target.sequenceGuid;
    }
    if (req.operation === 'pr.clip.replaceSource' && req.assets.source) req.args.path = await this.assets.pathFor(req.assets.source);
    if (req.operation === 'pr.clip.move' && req.args.targetTrackRole) {
      const roles = completed.get(String(req.args.roleStepKey)); requireCondition(roles, 'ROLE_BINDING_MISSING', 'Move track role binding is missing.');
      const track = selectResource(roles.resources[`role:${String(req.args.targetTrackRole)}`]).value;
      requireCondition(track.kind === 'pr_track' && req.target?.kind === 'pr_clip' && track.projectGuid === req.target.projectGuid && track.sequenceGuid === req.target.sequenceGuid && track.mediaType === req.target.mediaType, 'BINDING_TYPE_MISMATCH', 'Move track must belong to the same project, sequence, and media type.');
      req.args.trackIndex = track.trackIndex; delete req.args.targetTrackRole; delete req.args.roleStepKey;
    }
    if (req.operation === 'pr.clip.duration') {
      requireCondition(req.target?.kind === 'pr_clip', 'BINDING_TYPE_MISMATCH', 'Duration edits require an exact clip.');
      const sourceDuration = BigInt(req.target.sourceRange.end.ticks) - BigInt(req.target.sourceRange.start.ticks); const timelineDuration = BigInt(req.target.timelineRange.end.ticks) - BigInt(req.target.timelineRange.start.ticks);
      requireCondition(sourceDuration === timelineDuration, 'DURATION_TIME_MAP_UNSUPPORTED', 'Duration changes on retimed clips require an explicit qualified time mapping.');
      req.operation = 'pr.clip.trim'; req.args = { sourceOutTicks: String(BigInt(req.target.sourceRange.start.ticks) + BigInt(String(req.args.durationTicks))), anchor: 'sequence_start', linkedPolicy: req.args.linkedPolicy!, executionResources: req.args.executionResources!, verifyMode: req.args.verifyMode! };
    }
    if (req.operation === 'pr.frame.capture') { req.args.outputPath = await this.assets.allocate(req.jobId, req.revisionId, `${req.operationId}.png`); if (req.target?.kind === 'pr_sequence') req.args.sequenceGuid = req.target.sequenceGuid; }
    if (req.args.output) {
      const output = req.args.output as unknown as ArtifactSpec; req.args.outputPath = await this.assets.allocate(req.jobId, req.revisionId, `${req.operationId}.${output.format.toLowerCase()}`);
      if (output.encoding.kind === 'video') {
        const locator = this.options.presets?.[output.encoding.encoderPresetId]; requireCondition(locator, 'ENCODER_PRESET_NOT_CONFIGURED', 'The output encoder preset is not configured.');
        req.assets.encoderPreset = await this.assets.resolve(locator); req.args.presetPath = await this.assets.pathFor(req.assets.encoderPreset);
        req.args.resolvedEncoding = json({ spec: output.encoding, presetAsset: req.assets.encoderPreset, normalizedMedia: { kind: 'video', mimeType: output.format === 'mov' ? 'video/quicktime' : 'video/mp4', ...(output.width ? { width: output.width } : {}), ...(output.height ? { height: output.height } : {}), ...(output.frameRate ? { frameRate: output.frameRate } : {}) }, ...(output.range?.kind === 'timeline_range' ? { normalizedRange: output.range.value } : {}), ...(output.pixelAspect ? { expectedPixelAspect: output.pixelAspect } : {}) });
      }
      if (req.operation === 'pr.project.save') req.args.path = req.args.outputPath;
      if (req.target?.kind === 'pr_sequence') req.args.sequenceGuid = req.target.sequenceGuid;
    }
    return req;
  }
  private async executeWorker(job: JobState, req: OperationRequest): Promise<WorkerExecution> {
    requireCondition(this.worker, 'PROVIDER_NOT_CONFIGURED', 'The local worker is not configured.');
    let request = structuredClone(req);
    if (req.operation === 'image.inpaint' && req.args.photoGeometry) request.args.region = json(await this.mapPhotoRegion(req, req.args.region as unknown as Rect, this.receipts(job)));
    const raster = req.operation.startsWith('image.') ? [...this.receipts(job).values()].flatMap(receipt => receipt.evidence).find((item): item is VisualEvidenceReceipt => item.artifact.sha256 === req.assets.source?.sha256 && 'width' in item) : undefined;
    if (raster) { request.args.sourceRegion = json(raster.sourceBounds); request.args.sourceStateDigest = raster.snapshotDigest; request.args.sourceColor = json(raster.color); await this.journal.append('image.source-state', req.operationId, { captureOperationId: raster.operationId, sourceRasterSha256: req.assets.source!.sha256 }); }
    if (req.operation === 'image.inpaint' && raster) request.args.region = json(transformRect(request.args.region as unknown as Rect, (x, y) => rasterPoint(raster, x, y)));
    if (req.operation === 'image.segment' && !(req.args.points as Json[] | undefined)?.length && !req.args.box) {
      const source = req.assets.source!; let related = raster;
      requireCondition(related && 'width' in related, 'SEGMENTATION_EVIDENCE_MISSING', 'Subject prompts require an observed source raster with coordinates.');
      if (related.target && Math.max(related.width, related.height) > 1600) {
        const preview = await this.executeStep(job, { stepKey: `${req.stepKey}.prompt-preview`, operation: 'ps.evidence.capture', args: { kind: 'roi', region: json(related.sourceBounds), maxEdge: 1600, evidenceKey: `${req.stepKey}.prompt-preview` }, target: { kind: 'live', target: related.target }, dependsOn: [], effect: { kind: 'read_only' }, assertions: [], failureStrategy: 'stop' }, this.receipts(job));
        const observed = preview.evidence.find((item): item is VisualEvidenceReceipt => 'width' in item); requireCondition(preview.status === 'SUCCEEDED' && observed, 'SEGMENTATION_EVIDENCE_MISSING', 'A bounded prompt preview could not be observed.'); related = observed;
      }
      const requirement: RequirementSpec = { id: 'subject-prompt', description: 'Locate the subject requested by the brief. Point x/y are zero-based pixel-center indices in this exact preview; box x/y/width/height are pixel-edge coordinates. Use positive/background points or a box. Do not guess invisible content.', importance: 'required', evaluator: 'semantic', assertionIds: [], evidenceKeys: [related.evidenceKey], passRule: { allAssertionsPass: true } };
      const response = await this.askController(job, 'plan', { task: 'subject-prompt', operationId: req.operationId, raster: related, allowedSource: source, args: req.args, proposalTemplate: job.plan!.steps.find(step => step.stepKey === req.stepKey) }, [requirement], [related], ['image.segment']);
      requireCondition(evaluateRequirements([requirement], response.verdicts, [], new Set([related.evidenceKey])).every(item => item.verdict === 'pass'), 'SUBJECT_PROMPT_UNCERTAIN', 'Subject selection requires a supported pass citing the exact preview.');
      const prompt = response.initialPlan?.steps.find(step => step.operation === 'image.segment'); requireCondition(prompt && response.initialPlan!.steps.length === 1 && (Array.isArray(prompt.args.points) && prompt.args.points.length > 0 || prompt.args.box), 'SUBJECT_PROMPT_UNCERTAIN', 'Controller did not provide supported point/box prompts.');
      requireCondition(!this.isCancelled(job) && !this.closing, 'WORKFLOW_CANCELLED', 'Cancelled workflows do not start a new worker request.');
      const toRaster = (x: number, y: number): { x: number; y: number } => { const point = sourcePoint(related!, x, y); return rasterPoint(raster!, point.x, point.y); };
      if (prompt.args.points) request.args.points = (prompt.args.points as JsonObject[]).map(point => ({ ...mapPixelCenter(related!, raster!, Number(point.x), Number(point.y)), label: point.label! }));
      if (prompt.args.box) request.args.box = json(transformRect(prompt.args.box as unknown as Rect, toRaster));
      await this.journal.append('operation.prepared', req.operationId, request);
    }
    if (req.operation === 'image.segment') await this.recordOperation(job, req.stepKey, missing(req, 'DISPATCH_INTENT'));
    const result = await runWorker(request, this.worker, this.assets, job.plan!.resources);
    if (req.operation.startsWith('image.')) requireCondition(result.data.sourceRasterSha256 === req.assets.source!.sha256, 'IMAGE_SOURCE_STATE_MISMATCH', 'Image result does not match the exact source raster bytes.');
    return result;
  }
  private async mapPhotoRegion(req: OperationRequest, region: Rect, completed: Map<string, OperationReceipt>): Promise<Rect> {
    const geometry = req.args.photoGeometry as JsonObject; const source = this.dataFrom(completed, String(geometry.sourceInfoStepKey)); const placed = completed.get(String(geometry.placedStepKey));
    requireCondition(placed?.status === 'SUCCEEDED', 'PHOTO_PLACEMENT_UNAVAILABLE', 'Retouch requires the actual placed-photo receipt.');
    const item = selectResource(placed.resources.layer); const placement = item.projection?.sourcePlacement as unknown as SourcePlacement | undefined;
    requireCondition(placement && Array.isArray(placement.sourceToDocument) && placement.sourceToDocument.length === 6 && placement.sourceWidth === source.width && placement.sourceHeight === source.height, 'PHOTO_PLACEMENT_UNAVAILABLE', 'Native source dimensions and original-photo placement affine must be observed.');
    const placedRequest = this.journal.latest<{ value: OperationRequest }>('operation.accepted', placed.operationId)?.value;
    const sourceReceipt = completed.get(String(geometry.sourceInfoStepKey)); const sourceRequest = sourceReceipt ? this.journal.latest<{ value: OperationRequest }>('operation.accepted', sourceReceipt.operationId)?.value : undefined;
    requireCondition(placedRequest?.assets.source && sourceRequest?.assets.source && placement.sourceAssetId === placedRequest.assets.source.assetId && placement.sourceSha256 === placedRequest.assets.source.sha256 && placement.sourceSha256 === sourceRequest.assets.source.sha256, 'PHOTO_SOURCE_HASH_MISMATCH', 'Placement affine must be bound to the exact original photo bytes.');
    let afterPlacement = false;
    for (const receipt of completed.values()) {
      if (receipt.operationId === placed.operationId) { afterPlacement = true; continue; }
      if (!afterPlacement || receipt.status !== 'SUCCEEDED') continue;
      const operation = this.journal.latest<{ value: OperationRequest }>('operation.accepted', receipt.operationId)?.value;
      if (!operation?.target || item.value.kind !== 'ps_layer' || operation.target.workingAssetId !== item.value.workingAssetId) continue;
      const changesGeometry = operation.operation === 'ps.document.resize' || ['ps.layer.transform', 'ps.layer.replacePixels', 'ps.smartobject.replace'].includes(operation.operation) && operation.target.kind === 'ps_layer' && operation.target.layerIds.some(id => item.value.kind === 'ps_layer' && item.value.layerIds.includes(id));
      requireCondition(!changesGeometry, 'PHOTO_PLACEMENT_CHANGED_UNSUPPORTED', 'Retouch requires a newly observed original-photo affine after any planned geometry/source replacement.');
    }
    const mapped = photoRectToDocument(region, placement);
    await this.journal.append('image.geometry', `${req.operationId}:${digest(region)}`, { sourceRegion: region, placement, exactDocumentRegion: mapped.exact, documentRegion: mapped.pixels, quantization: 'outward_pixel_edges' });
    return mapped.pixels;
  }

  private async executeInternal(job: JobState, req: OperationRequest, completed: Map<string, OperationReceipt>): Promise<WorkerExecution> {
    if (req.operation === 'pr.audio.mix' || req.operation === 'pr.color.match') return runNativeBatch({ request: req, plan: job.plan!, inputs: job.inputs, receipts: completed, execute: async step => { this.registry.validateStep(step); requireCondition(!this.isCancelled(job) && !this.closing, 'WORKFLOW_CANCELLED', 'Cancelled batches cannot dispatch another child.'); return this.executeStep(job, step, this.receipts(job)); }, ask: (purpose, context, requirements, evidence, operations) => this.askController(job, purpose, context, requirements, evidence, operations) });
    if (req.operation === 'workflow.roles.prepare') {
      const observation = observeRoles(req, completed); const extraEvidence: EvidenceReceipt[] = [];
      for (const owner of req.args.owners as unknown as { inputKey: string; inspectStepKey: string }[]) {
        const inventory = completed.get(owner.inspectStepKey)!; const root = Object.values(inventory.resources).flatMap(slot => slot.kind === 'single' ? [slot.item] : slot.items).find(item => item.value.kind === 'ps_document');
        if (root?.value.kind === 'ps_document') {
          const evidenceStep: PlanStep = { stepKey: `${req.stepKey}.evidence.${owner.inputKey}`, operation: 'ps.evidence.capture', args: { kind: 'composite', maxEdge: 1600, evidenceKey: `${req.stepKey}.${owner.inputKey}.visual` }, target: { kind: 'live', target: root.value }, dependsOn: [], effect: { kind: 'read_only' }, assertions: [], failureStrategy: 'stop' };
          const evidence = await this.executeStep(job, evidenceStep, completed); requireCondition(evidence.status === 'SUCCEEDED', 'ROLE_EVIDENCE_FAILED', 'Cannot observe the role source.'); extraEvidence.push(...evidence.evidence);
        }
      }
      // Discover only exact inspected sources under configured roots, never filename guesses.
      for (const candidate of observation.candidates) if (candidate.item.value.kind === 'pr_clip' && !Object.values(job.inputs).some(asset => asset.assetId === (candidate.item.value as Extract<TargetRef, { kind: 'pr_clip' }>).sourceAssetId)) {
        const sourcePath = candidate.item.projection?.sourcePath;
        requireCondition(typeof sourcePath === 'string', 'ROLE_SOURCE_INPUT_MISSING', 'Inspected clip has no authorized source binding.');
        const asset = await this.assets.resolve(await this.assets.locate(sourcePath)); requireCondition(asset.assetId === candidate.item.value.sourceAssetId, 'ROLE_SOURCE_HASH_MISMATCH', 'Inspected source identity differs from actual bytes.');
        const key = `autoSource_${asset.sha256.slice(0, 48)}`; requireCondition(!job.inputs[key] || job.inputs[key]!.sha256 === asset.sha256, 'SOURCE_BINDING_COLLISION', 'Prepared source key collision.'); job.inputs[key] = asset;
      }
      await this.saveJob(job);
      return prepareRoles(req, job.inputs, completed, this.assets, this.registry.validator, async observed => {
        const requirements: RequirementSpec[] = observed.requirements.map(item => ({ id: `role:${item.role}`, description: `Bind role ${item.role} to exactly one observed ${item.kind}${item.layerKind ? ' of kind ' + item.layerKind : ''} in ${item.ownerInputKey}.`, importance: 'required', evaluator: 'semantic', assertionIds: [], evidenceKeys: observed.evidence.map(item => item.evidenceKey), passRule: { allAssertionsPass: true } }));
        const response = await this.askController(job, 'plan', { task: 'role-binding', observation: observed }, requirements, observed.evidence, ['workflow.roles.bind']);
        requireCondition(evaluateRequirements(requirements, response.verdicts, [], new Set(observed.evidence.map(item => item.evidenceKey))).every(item => item.verdict === 'pass'), 'ROLE_UNCERTAIN', 'Automatic role selection requires a supported pass for every required role.');
        return response;
      }, extraEvidence);
    }
    if (req.operation === 'pr.cut_map.build') return this.buildCutMap(job, req, completed);
    if (req.operation === 'pr.captions.build') return this.buildCaptions(job, req, completed);
    if (req.operation === 'artifact.publish') {
      const spec = req.args.output as unknown as ArtifactSpec; let staged = req.assets.source!;
      if (spec.encoding.kind === 'subtitle' && staged.media.mimeType === 'application/json') {
        const captions = parseStrictJson(await this.assets.readJson(staged)) as { cues: Cue[] };
        const file = await this.assets.allocate(req.jobId, req.revisionId, `${req.operationId}.${spec.format}`); const handle = await open(file, 'wx');
        try { await handle.writeFile(serializeCaptions(captions.cues, spec.format as 'srt' | 'vtt', spec.encoding.lineEnding)); await handle.sync(); } finally { await handle.close(); }
        staged = await this.assets.registerGenerated(file, { kind: 'subtitle', mimeType: spec.format === 'vtt' ? 'text/vtt' : 'application/x-subrip' });
      }
      const published = await this.assets.publish(staged, spec, Object.values(job.inputs), req.operationId);
      const artifact: ArtifactReceipt = { kind: 'artifact', asset: published, operationId: req.operationId, sourceAssets: [req.assets.source!.assetId], recipeDigest: digest(spec), published: true, verification: [] };
      return { data: { outputKeys: [spec.outputKey], artifactIds: [published.assetId], published: true, verificationScope: job.plan!.delivery.verifyMode }, resources: { artifact: { kind: 'single', resourceKind: 'artifact', item: { itemKey: spec.outputKey, value: artifact } } }, artifacts: [artifact], evidence: [], verification: [] };
    }
    throw new AutomationError('UNKNOWN_INTERNAL_OPERATION', `No executor for ${req.operation}.`);
  }

  private dataFrom(completed: Map<string, OperationReceipt>, stepKey: string): JsonObject {
    const receipt = completed.get(stepKey); requireCondition(receipt?.status === 'SUCCEEDED' && receipt.dataState === 'complete', 'DEPENDENCY_DATA_UNAVAILABLE', `No complete domain data from ${stepKey}.`); return receipt.data;
  }
  private async metadataExecution(req: OperationRequest, data: JsonObject, schemaId: string, evidenceKind: 'cut_map' | 'transcript' | 'metadata' = 'metadata', clock: 'source' | 'timeline' | 'document' = 'source'): Promise<WorkerExecution> {
    const asset = await this.assets.writeJson(req.jobId, req.revisionId, `${req.operationId}-data.json`, data);
    const receipt: ArtifactReceipt = { kind: 'artifact', asset, operationId: req.operationId, sourceAssets: Object.values(req.assets).map(item => item.assetId), recipeDigest: digest({ operation: req.operation, args: req.args }), published: false, verification: [] };
    return { data, resources: { artifact: { kind: 'single', resourceKind: 'artifact', item: { itemKey: 'artifact', value: receipt } } }, artifacts: [receipt], evidence: [{ kind: evidenceKind, dataSchemaId: schemaId, data, clock, complete: true, evidenceKey: `${req.stepKey}.data`, operationId: req.operationId, sourceAssetIds: receipt.sourceAssets, snapshotDigest: digest(data), capturedAt: new Date().toISOString(), artifact: asset }], verification: [] };
  }
  private async buildCutMap(job: JobState, req: OperationRequest, completed: Map<string, OperationReceipt>): Promise<WorkerExecution> {
    const parameters = req.args.parameters as JsonObject; const interview = req.args.recipeId === 'pr.interview_captioned.v1';
    const cameras = interview ? ['camera'] : parameters.cameraInputs as string[]; const audioKey = interview ? 'voice' : String(parameters.audioInput);
    const sync = this.dataFrom(completed, String(req.args.syncStepKey)); const offsets = new Map((sync.offsets as unknown as { inputKey: string; offsetTicks: string }[]).map(item => [item.inputKey, BigInt(item.offsetTicks)]));
    const durations = new Map<string, bigint>();
    for (const key of [...cameras, audioKey, ...((parameters.brollPlan as JsonObject[]) ?? []).map(item => String(item.inputKey)), ...(parameters.ducking ? ['music'] : [])]) {
      const info = this.dataFrom(completed, `media.${key}.inspect`); requireCondition(typeof info.durationTicks === 'string' && BigInt(info.durationTicks) > 0n, 'MEDIA_DURATION_UNAVAILABLE', `No usable duration for ${key}.`); durations.set(key, BigInt(info.durationTicks));
    }
    const sourceKeys = [...cameras, audioKey];
    for (const key of sourceKeys) requireCondition(offsets.has(key), 'SYNC_OFFSET_MISSING', `No sync offset for ${key}.`);
    const start = sourceKeys.reduce((max, key) => offsets.get(key)! > max ? offsets.get(key)! : max, offsets.get(sourceKeys[0]!)!);
    const end = sourceKeys.reduce((min, key) => offsets.get(key)! + durations.get(key)! < min ? offsets.get(key)! + durations.get(key)! : min, offsets.get(sourceKeys[0]!)! + durations.get(sourceKeys[0]!)!);
    requireCondition(end > start, 'SYNC_NO_COMMON_COVERAGE', 'Synchronized sources have no common coverage.');
    const origin = (parameters.sync as JsonObject).origin === 'reference_start' ? 0n : start;
    const segments: CutSegment[] = [];
    const append = (segmentKey: string, key: string, referenceStart: bigint, referenceEnd: bigint, timelineStart: bigint): void => {
      const offset = offsets.get(key) ?? 0n; const sourceStart = referenceStart - offset, sourceEnd = referenceEnd - offset;
      requireCondition(sourceStart >= 0n && sourceEnd <= durations.get(key)! && sourceEnd > sourceStart, 'SOURCE_COVERAGE_MISSING', `The requested edit exceeds source coverage for ${key}.`);
      segments.push({ segmentKey, sourceAssetId: job.inputs[key]!.assetId, sourceRange: range(sourceStart, sourceEnd), timelineRange: range(timelineStart, timelineStart + referenceEnd - referenceStart), speedNumerator: 1, speedDenominator: 1, reverse: false });
    };
    if (interview) {
      const transcript = req.args.transcriptStepKey ? this.dataFrom(completed, String(req.args.transcriptStepKey)) : undefined; const words = (transcript?.words ?? []) as unknown as Word[];
      const analysis = this.dataFrom(completed, String(req.args.analysisStepKey)); const edit = parameters.editIntent as JsonObject; const silence = edit.silenceCuts as JsonObject;
      const map = buildInterviewCutMap({ sourceAssetId: job.inputs[audioKey]!.assetId, durationTicks: String(durations.get(audioKey)!), words, silence: analysis.silenceIntervals as unknown as { start: { ticks: string }; end: { ticks: string } }[], enabled: silence.enabled === true, minimumSilenceMs: Number(silence.minimumSilenceMs), keepHeadMs: Number(silence.keepHeadMs), keepTailMs: Number(silence.keepTailMs), ...(Array.isArray(edit.keepRanges) ? { keepRanges: (edit.keepRanges as JsonObject[]).map(item => range(String(item.fromTicks), String(item.toTicks))) } : {}) });
      let timeline = 0n;
      for (const kept of map) {
        const referenceStart = BigInt(kept.sourceRange.start.ticks) + offsets.get(audioKey)!; const referenceEnd = BigInt(kept.sourceRange.end.ticks) + offsets.get(audioKey)!;
        requireCondition(referenceStart >= origin && referenceEnd <= end, 'SOURCE_COVERAGE_MISSING', 'The speech-preserving edit is not covered by the synchronized camera.');
        append(`camera-${kept.segmentKey}`, cameras[0]!, referenceStart, referenceEnd, timeline);
        append(`voice-${kept.segmentKey}`, audioKey, referenceStart, referenceEnd, timeline); timeline += referenceEnd - referenceStart;
      }
      const broll = (parameters.brollPlan as JsonObject[]) ?? []; let previousEnd = 0n;
      for (let index = 0; index < broll.length; index++) {
        const item = broll[index]!; const rate = parameters.sequenceRate as unknown as { num: number; den: number }; const from = BigInt(frameTicks(String(item.fromFrame), rate)); const to = BigInt(frameTicks(String(item.toFrame), rate)); const sourceIn = BigInt(String(item.sourceInTicks)); const key = String(item.inputKey);
        requireCondition(from >= previousEnd && to <= timeline && sourceIn + to - from <= durations.get(key)!, 'BROLL_COVERAGE_INVALID', 'B-roll overlaps or exceeds timeline/source coverage.'); previousEnd = to;
        segments.push({ segmentKey: `broll-${index}`, sourceAssetId: job.inputs[key]!.assetId, sourceRange: range(sourceIn, sourceIn + to - from), timelineRange: range(from, to), speedNumerator: 1, speedDenominator: 1, reverse: false });
      }
      if (parameters.ducking) { requireCondition(durations.get('music')! >= timeline, 'MUSIC_COVERAGE_MISSING', 'Music does not cover the requested timeline; implicit looping is not authorized.'); segments.push({ segmentKey: 'music', sourceAssetId: job.inputs.music!.assetId, sourceRange: range(0n, timeline), timelineRange: range(0n, timeline), speedNumerator: 1, speedDenominator: 1, reverse: false }); }
    } else {
      const rate = parameters.frameRate as unknown as { num: number; den: number }; const duration = BigInt(frameTicks(String(parameters.durationFrames), rate)); requireCondition(origin >= start && origin + duration <= end, 'SOURCE_COVERAGE_MISSING', 'Multicam duration exceeds the common synchronized coverage.');
      for (const [index, raw] of (parameters.anglePlan as JsonObject[]).entries()) { const from = BigInt(frameTicks(String(raw.fromFrame), rate)), to = BigInt(frameTicks(String(raw.toFrame), rate)); append(`angle-${index}`, String(raw.angle), origin + from, origin + to, from); }
      append('reference-audio', audioKey, origin, origin + duration, 0n);
    }
    const asset = await this.assets.writeJson(req.jobId, req.revisionId, `${req.operationId}-cut-map.json`, { segments });
    const data: JsonObject = { segments: json(segments), mappingArtifactId: asset.assetId };
    const receipt: ArtifactReceipt = { kind: 'artifact', asset, operationId: req.operationId, sourceAssets: [...new Set(segments.map(item => item.sourceAssetId))], recipeDigest: digest(req.args), published: false, verification: [] };
    return { data, resources: { artifact: { kind: 'single', resourceKind: 'artifact', item: { itemKey: 'artifact', value: receipt } } }, artifacts: [receipt], evidence: [{ kind: 'cut_map', dataSchemaId: 'pr.cut_map.v1', data, clock: 'timeline', complete: true, evidenceKey: `${req.stepKey}.data`, operationId: req.operationId, sourceAssetIds: receipt.sourceAssets, snapshotDigest: digest(data), capturedAt: new Date().toISOString(), artifact: asset }], verification: [] };
  }
  private async buildCaptions(job: JobState, req: OperationRequest, completed: Map<string, OperationReceipt>): Promise<WorkerExecution> {
    const settings = req.args.settings as JsonObject; const map = this.dataFrom(completed, String(req.args.cutMapStepKey)); const segments = map.segments as unknown as CutSegment[]; let cues: Cue[];
    if (settings.source === 'local_asr') {
      const transcript = this.dataFrom(completed, String(req.args.transcriptStepKey)); cues = captionsFromWords(transcript.words as unknown as Word[], segments, String(transcript.sourceAssetId), settings as unknown as Parameters<typeof captionsFromWords>[3]);
    } else {
      requireCondition(req.assets.source, 'CAPTION_SOURCE_MISSING', 'Supplied subtitle source is missing.');
      const text = await readFile(await this.assets.pathFor(req.assets.source), 'utf8'); const sourceCues = this.parseSubtitle(text, settings.source === 'input_vtt');
      const voice = job.inputs.voice; requireCondition(voice, 'CAPTION_CLOCK_SOURCE_MISSING', 'Input captions require the exact reference voice source.');
      cues = sourceCues.flatMap(cue => remapRange(cue.range, segments, voice.assetId).map((mapped, index) => ({ cueKey: `${cue.cueKey}-${index}`, text: cue.text, range: mapped })));
    }
    const asset = await this.assets.writeJson(req.jobId, req.revisionId, `${req.operationId}-captions.json`, { cues });
    const data: JsonObject = { clock: 'timeline', cues: json(cues), sidecarArtifactIds: [asset.assetId] };
    const receipt: ArtifactReceipt = { kind: 'artifact', asset, operationId: req.operationId, sourceAssets: [], recipeDigest: digest(req.args), published: false, verification: [] };
    return { data, resources: { artifact: { kind: 'single', resourceKind: 'artifact', item: { itemKey: 'artifact', value: receipt } } }, artifacts: [receipt], evidence: [{ kind: 'metadata', dataSchemaId: 'pr.captions.v1', data, clock: 'timeline', complete: true, evidenceKey: `${req.stepKey}.data`, operationId: req.operationId, sourceAssetIds: [], snapshotDigest: digest(data), capturedAt: new Date().toISOString(), artifact: asset }], verification: [] };
  }
  private parseSubtitle(text: string, vtt: boolean): Cue[] {
    const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n'); if (vtt) requireCondition(lines[0]?.startsWith('WEBVTT'), 'SUBTITLE_FORMAT_INVALID', 'VTT must start with its header.');
    const parseTime = (time: string): string => { const match = /^(?:(\d+):)?(\d{2}):(\d{2})[,.](\d{3})$/.exec(time); requireCondition(match, 'SUBTITLE_TIME_INVALID', 'Unsupported subtitle timestamp.'); const milliseconds = BigInt(match[1] ?? 0) * 3_600_000n + BigInt(match[2]!) * 60_000n + BigInt(match[3]!) * 1000n + BigInt(match[4]!); return String(milliseconds * TICKS_PER_SECOND / 1000n); };
    const cues: Cue[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!; if (!line.includes('-->')) continue;
      const match = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(line); requireCondition(match, 'SUBTITLE_FORMAT_INVALID', 'Invalid subtitle timing line.'); const start = parseTime(match[1]!), end = parseTime(match[2]!); requireCondition(BigInt(start) < BigInt(end), 'SUBTITLE_TIME_INVALID', 'Subtitle ranges must be nonempty.');
      const body: string[] = []; while (index + 1 < lines.length && lines[index + 1]!.trim()) body.push(lines[++index]!);
      requireCondition(cues.length === 0 || BigInt(start) >= BigInt(cues.at(-1)!.range.end.ticks), 'SUBTITLE_OVERLAP', 'Supplied subtitles overlap.'); cues.push({ cueKey: `source-cue-${cues.length + 1}`, text: body.join('\n'), range: range(start, end) });
    }
    requireCondition(cues.length > 0, 'SUBTITLE_EMPTY', 'No valid subtitle cues were found.'); return cues;
  }
  private async captureCheckpoint(job: JobState, step: PlanStep, receipt: OperationReceipt): Promise<void> {
    if (receipt.status !== 'SUCCEEDED' || !['ps.document.save', 'pr.project.save'].includes(step.operation)) return;
    if (this.journal.latest('checkpoint.operation', receipt.operationId)) return;
    const artifact = receipt.artifacts.find(item => item.asset.media.kind === 'project'); if (!artifact) return;
    await this.assets.pathFor(artifact.asset);
    const target = receipt.targetAfter ?? receipt.targetBefore; if (!target) return;
    const group = job.plan!.materializationGroups.find(item => item.app === target.host.app && item.mutationOrder.some(key => this.receipts(job).get(key)?.resources && Object.values(this.receipts(job).get(key)!.resources).some(slot => (slot.kind === 'single' ? [slot.item] : slot.items).some(item => item.value.kind !== 'artifact' && item.value.workingAssetId === target.workingAssetId))));
    if (!group) return;
    const root: TargetRef = target.kind === 'ps_layer' ? { kind: 'ps_document', host: target.host, documentId: target.documentId, workingAssetId: target.workingAssetId } : 'projectGuid' in target ? { kind: 'pr_project', host: target.host, projectGuid: target.projectGuid, workingAssetId: target.workingAssetId } : target;
    const observed = await this.executeStep(job, { stepKey: `__checkpoint.${receipt.operationId}.inspect`, operation: root.host.app === 'photoshop' ? 'ps.document.inspect' : 'pr.timeline.inspect', args: {}, target: { kind: 'live', target: root }, effect: { kind: 'read_only' }, assertions: [], dependsOn: [], failureStrategy: 'stop' }, this.receipts(job));
    if (observed.status !== 'SUCCEEDED') { await this.journal.append('checkpoint.unavailable', receipt.operationId, { reason: 'Saved file exists, but its current inventory could not be observed.' }); return; }
    const completed = this.receipts(job); const savedThrough = group.mutationOrder.flatMap(key => { const operation = completed.get(key); return operation?.status === 'SUCCEEDED' ? [{ stepKey: key, operationId: operation.operationId, postStateDigest: operation.recovery.afterDigest ?? digest(operation.data) }] : []; });
    const logicalBindings = [...completed.values()].flatMap(operation => Object.values(operation.resources).flatMap(slot => (slot.kind === 'single' ? [slot.item] : slot.items).filter(item => item.logicalRole && item.structuralFingerprint && item.value.kind !== 'artifact' && item.value.workingAssetId === target.workingAssetId).map(item => ({ role: item.logicalRole!, resourceKind: slot.resourceKind, structuralFingerprint: item.structuralFingerprint! }))));
    const checkpoint: CheckpointRecord = { checkpointId: randomUUID(), jobId: job.receipt.jobId, revisionId: job.receipt.revisionId, materializationGroupId: group.groupId, artifact: artifact.asset, savedThrough, logicalBindings, createdAt: new Date().toISOString() };
    await this.journal.append('checkpoint.snapshot', checkpoint.checkpointId, { root, observed: resourceItems(observed), receipts: Object.fromEntries(completed) } satisfies CheckpointSnapshot);
    await this.journal.append('checkpoint.operation', receipt.operationId, { checkpointId: checkpoint.checkpointId });
    job.receipt.checkpoints.push(checkpoint); await this.saveJob(job);
  }
  private invalidateDependents(job: JobState, seeds: Set<string>): Set<string> {
    let changed = true;
    while (changed) { changed = false; for (const step of job.plan!.steps) if (!seeds.has(step.stepKey) && step.dependsOn.some(key => seeds.has(key))) { seeds.add(step.stepKey); changed = true; } }
    return seeds;
  }
  private async detectHostEpochChange(job: JobState): Promise<void> {
    if (job.pendingMaterializations) return;
    const receipts = this.receipts(job); const changed: Record<string, { checkpointId?: string; reason: string }> = {};
    for (const group of job.plan!.materializationGroups) {
      const registration = this.hosts.get(group.app); if (!registration) continue;
      const current = await registration.resolveHost();
      if (!group.mutationOrder.some(key => { const previous = receipts.get(key); return previous?.status === 'SUCCEEDED' && digest(previous.host) !== digest(current); })) continue;
      requireCondition(![...receipts.values()].some(receipt => receipt.host.app === group.app && ['RUNNING', 'DISPATCH_INTENT', 'OUTCOME_UNKNOWN', 'CANCEL_REQUESTED', 'APPLIED_UNVERIFIED'].includes(receipt.status)), 'HOST_EPOCH_UNSETTLED', 'Host changed while an effect is unsettled; reconcile its authoritative receipt before materialization.');
      const checkpoint = [...job.receipt.checkpoints].reverse().find(item => item.materializationGroupId === group.groupId);
      changed[group.groupId] = { ...(checkpoint ? { checkpointId: checkpoint.checkpointId } : {}), reason: 'host_epoch_changed' };
    }
    if (Object.keys(changed).length) { job.pendingMaterializations = changed; await this.saveJob(job); }
  }
  private async materializePending(job: JobState): Promise<void> {
    if (!job.pendingMaterializations) return;
    for (const [groupId, intent] of Object.entries(job.pendingMaterializations)) {
      const group = job.plan!.materializationGroups.find(item => item.groupId === groupId)!;
      const checkpoint = job.receipt.checkpoints.find(item => item.checkpointId === intent.checkpointId);
      let restored: Record<string, OperationReceipt> | undefined; let fallbackReason = intent.reason;
      if (checkpoint) {
        const snapshot = this.journal.latest<CheckpointSnapshot>('checkpoint.snapshot', checkpoint.checkpointId);
        if (snapshot) {
          const inputKey = `__checkpoint_${checkpoint.checkpointId}`; job.inputs[inputKey] = checkpoint.artifact;
          const prefix = `__restore.${groupId}.${checkpoint.checkpointId}.${job.receipt.revisionId}`;
          const openStep: PlanStep = { stepKey: `${prefix}.open`, operation: group.app === 'photoshop' ? 'ps.document.open' : 'pr.project.open', assets: { source: { kind: 'input', inputKey } }, args: {}, effect: { kind: 'mutable_host', materializationGroupId: groupId }, dependsOn: [], assertions: [], failureStrategy: 'reconcile' };
          const opened = await this.executeStep(job, openStep, this.receipts(job));
          requireCondition(opened.status === 'SUCCEEDED', 'CHECKPOINT_RESTORE_UNSETTLED', 'Checkpoint open must settle before any fallback or replay.');
          const slot = group.app === 'photoshop' ? 'document' : 'project'; const root = selectResource(opened.resources[slot]).value;
          requireCondition(root.kind !== 'artifact', 'CHECKPOINT_ROOT_MISSING', 'Checkpoint open did not return its owned root.');
          const inspected = await this.executeStep(job, { stepKey: `${prefix}.inspect`, operation: group.app === 'photoshop' ? 'ps.document.inspect' : 'pr.timeline.inspect', target: { kind: 'live', target: root }, args: {}, effect: { kind: 'read_only' }, dependsOn: [], assertions: [], failureStrategy: 'reconcile' }, this.receipts(job));
          requireCondition(inspected.status === 'SUCCEEDED', 'CHECKPOINT_RESTORE_UNSETTLED', 'Checkpoint inventory must settle before replay.');
          try {
            restored = {};
            for (const [key, receipt] of Object.entries(snapshot.receipts)) {
              const step = job.plan!.steps.find(item => item.stepKey === key); if (!step || receipt.status !== 'SUCCEEDED') continue;
              const saved = checkpoint.savedThrough.some(item => item.stepKey === key);
              if (step.effect.kind === 'mutable_host' && !saved) continue;
              if (!saved && !resourceItems(receipt).some(item => item.value.kind !== 'artifact' && item.value.workingAssetId === snapshot.root.workingAssetId)) continue;
              restored[key] = rebindCheckpointReceipt(receipt, checkpoint, snapshot.root, root, snapshot.observed, [...resourceItems(opened), ...resourceItems(inspected)]);
            }
          } catch (error) { restored = undefined; fallbackReason = asAutomationError(error).code; }
        } else fallbackReason = 'checkpoint_snapshot_missing';
      }
      const invalidated = this.invalidateDependents(job, new Set(group.mutationOrder.filter(key => !restored?.[key])));
      // Rebound prefix resources are valid; every unsaved native effect is executed again.
      for (const key of invalidated) { delete job.stepOperations[key]; delete job.retainedReceipts[key]; }
      if (restored) for (const [key, receipt] of Object.entries(restored)) if (!invalidated.has(key)) { delete job.stepOperations[key]; job.retainedReceipts[key] = receipt; }
      await this.journal.append('materialization.completed', `${job.receipt.revisionId}:${groupId}`, { groupId, mode: restored ? 'saved_checkpoint' : 'source_base', checkpointId: restored ? checkpoint!.checkpointId : null, savedThrough: restored ? checkpoint!.savedThrough : [], reason: fallbackReason, replay: [...invalidated] });
      delete job.pendingMaterializations[groupId]; await this.saveJob(job);
    }
    delete job.pendingMaterializations; await this.saveJob(job);
  }
  private async askController(job: JobState, purpose: ControllerRequest['purpose'], context: unknown, requirements: RequirementSpec[], evidence: EvidenceReceipt[], allowedOperationIds: string[], verifiedAssertions?: VerificationResult[]): Promise<ControllerResponse> {
    const plan = job.plan!; const contextSnapshot = { context, ...(purpose === 'repair' ? { plan } : { planIdentity: { jobId: plan.jobId, revisionId: plan.revisionId } }), inputs: job.inputs, ...(purpose === 'review' ? {} : { allowedOperations: allowedOperationIds.map(id => ({ id, argsSchema: this.registry.get(id).argsSchema })) }) };
    const assertions = verifiedAssertions ?? [...this.receipts(job).values()].flatMap(receipt => [...receipt.verification, ...receipt.artifacts.flatMap(artifact => artifact.verification)]);
    const key = digest({ jobId: job.receipt.jobId, revisionId: job.receipt.revisionId, purpose, context: contextSnapshot, requirements, evidence, assertions });
    const existingId = this.journal.latest<{ requestId: string }>('controller.key', key)?.requestId;
    let intent = existingId ? this.journal.latest<ControllerIntent>('controller.request', existingId) : undefined;
    if (intent) {
      requireCondition(Date.now() < Date.parse(intent.request.expiresAt), 'CONTROLLER_DEADLINE_EXCEEDED', 'The persisted controller request has expired.');
      const response = this.journal.latest<ControllerResponse>('controller.response', intent.request.requestId); if (response) return response;
      const failure = this.journal.latest<{ code: string; message: string }>('controller.failed', intent.request.requestId); if (failure) throw new AutomationError(failure.code, failure.message);
      const usage = this.budget.records(job.receipt.jobId).find(item => item.requestId === intent!.request.requestId);
      if (usage?.usage.state === 'unknown') throw new AutomationError('CONTROLLER_OUTCOME_UNKNOWN', 'A previous controller call has an unknown outcome and will not be automatically repeated.');
      if (this.journal.latest('controller.dispatched', intent.request.requestId)) { await this.budget.unknown(intent.reservation); throw new AutomationError('CONTROLLER_OUTCOME_UNKNOWN', 'An interrupted dispatched controller call cannot be repeated automatically.'); }
    } else {
      const remaining = this.budget.remaining(job.receipt.jobId, plan.controller.modelBudget); const requestId = randomUUID();
      const expiresAt = new Date(Math.min(Date.parse(plan.controller.waitDeadline), Date.now() + Math.max(0, remaining.maxElapsedSeconds) * 1000)).toISOString();
      const body = { requestId, jobId: job.receipt.jobId, revisionId: job.receipt.revisionId, purpose, brief: job.plan!.brief, requirements, evidence, verifiedAssertions: assertions, allowedOperationIds, remainingBudget: remaining, expiresAt };
      const request: ControllerRequest = { ...body, requestDigest: digest({ ...body, context: contextSnapshot }) };
      const profile = this.controller instanceof OllamaLocalController ? this.controller.profile : undefined;
      const pixels = evidence.reduce((sum, item) => 'width' in item ? sum + BigInt(item.width) * BigInt(item.height) : sum, 0n);
      const inputBound = profile?.inputTokenUpperBound ?? 0; const outputBound = profile ? Math.min(profile.maxOutputTokensPerCall, remaining.maxOutputTokens, profile.numCtx - profile.inputTokenUpperBound) : 0;
      const reservation = await this.budget.reserve(job.receipt.jobId, request, plan.controller.providerId ?? 'client-agent', inputBound, outputBound, String(pixels));
      intent = { request, context: contextSnapshot, key, reservation }; await this.journal.append('controller.request', requestId, intent); await this.journal.append('controller.key', key, { requestId });
    }
    job.pendingControllerId = intent.request.requestId; await this.saveJob(job);
    requireCondition(Date.now() < Date.parse(intent.request.expiresAt), 'CONTROLLER_DEADLINE_EXCEEDED', 'Controller request expired.');
    this.armControllerTimer(job.receipt.jobId, intent);
    if (plan.controller.mode === 'client_agent' || !this.controller) throw new AutomationError('WAIT_PROVIDER', plan.controller.mode === 'client_agent' ? 'An active MCP agent must answer the pending typed request.' : 'The configured local controller is not available.');
    requireCondition(Date.now() < Date.parse(intent.request.expiresAt), 'CONTROLLER_DEADLINE_EXCEEDED', 'Controller request expired.');
    await this.journal.append('controller.dispatched', intent.request.requestId, { startedAt: new Date().toISOString() });
    try {
      const response = await this.controller.request(intent.request); validateControllerResponse(intent.request, response, this.registry);
      if (Date.now() >= Date.parse(intent.request.expiresAt)) throw new ControllerAttemptError('CONTROLLER_DEADLINE_EXCEEDED', 'The completed model response arrived after the request deadline.', response.usage);
      requireCondition(job.receipt.revisionId === intent.request.revisionId && job.pendingControllerId === intent.request.requestId && !TERMINAL.has(job.receipt.status), 'CONTROLLER_REQUEST_STALE', 'The controller response is no longer current.');
      await this.budget.settle(intent.reservation, response.usage); await this.journal.append('controller.response', response.requestId, response); this.clearControllerTimer(response.requestId);
      delete job.pendingControllerId; job.receipt.modelUsage = this.budget.records(job.receipt.jobId).map(record => record.usage); await this.saveJob(job); return response;
    } catch (error) {
      if (error instanceof ControllerAttemptError) { await this.budget.settle(intent.reservation, error.usage); await this.journal.append('controller.failed', intent.request.requestId, { code: error.code, message: error.message }); }
      else await this.budget.unknown(intent.reservation);
      throw error;
    }
  }
  private clearControllerTimer(requestId: string): void { const timer = this.controllerTimers.get(requestId); if (timer) clearTimeout(timer); this.controllerTimers.delete(requestId); }
  private armControllerTimer(jobId: string, intent: ControllerIntent): void {
    if (this.controllerTimers.has(intent.request.requestId)) return;
    const delay = Math.max(1, Math.min(2_147_000_000, Date.parse(intent.request.expiresAt) - Date.now()));
    const timer = setTimeout(() => { this.controllerTimers.delete(intent.request.requestId); if (Date.now() < Date.parse(intent.request.expiresAt)) this.armControllerTimer(jobId, intent); else void this.expireControllerWait(jobId, intent.request.requestId).catch(() => undefined); }, delay); timer.unref?.(); this.controllerTimers.set(intent.request.requestId, timer);
  }
  private async expireControllerWait(jobId: string, requestId: string): Promise<void> {
    const job = this.jobs.get(jobId); const intent = this.journal.latest<ControllerIntent>('controller.request', requestId);
    if (!job || !intent || job.pendingControllerId !== requestId || job.receipt.revisionId !== intent.request.revisionId || TERMINAL.has(job.receipt.status) || Date.now() < Date.parse(intent.request.expiresAt)) return;
    this.clearControllerTimer(requestId); job.receipt.status = 'FAILED_ENVIRONMENT'; delete job.pendingControllerId;
    job.receipt.unresolved = [{ code: 'CONTROLLER_DEADLINE_EXCEEDED', message: 'The provider wait deadline expired; late evidence will not be accepted.', retrySafe: false, nextAction: 'new_plan' }];
    await this.saveJob(job); await this.controller?.cancel(requestId);
    if (!this.journal.latest('controller.response', requestId)) await this.budget.unknown(intent.reservation);
  }
  private async reviewJob(job: JobState): Promise<void> {
    if (this.isCancelled(job) || this.closing) return;
    const plan = job.plan!; const completed = this.receipts(job); const projection = buildReviewProjection(plan, completed, job.inputs); const assertions = projection.assertions; const evidence = [...completed.values()].flatMap(receipt => receipt.evidence);
    const requirements = projection.requirements;
    await this.journal.append('review.projection', job.receipt.revisionId, { jobId: job.receipt.jobId, revisionId: job.receipt.revisionId, assertions, evidenceBindings: projection.evidenceBindings });
    if (!job.reviewStartedAt) { job.reviewStartedAt = new Date().toISOString(); await this.saveJob(job); }
    const semanticRequired = plan.review.enabled && requirements.some(requirement => requirement.evaluator !== 'assertion'); let response: ControllerResponse | undefined;
    if (semanticRequired) response = await this.askController(job, 'review', { task: 'final-review', operations: job.receipt.operations, evidenceBindings: projection.evidenceBindings }, requirements, evidence, [], assertions);
    if (this.isCancelled(job) || this.closing) return;
    job.receipt.requirementResults = evaluateRequirements(requirements, response?.verdicts ?? [], assertions, new Set(evidence.map(item => item.evidenceKey)));
    const missingOutputs = plan.delivery.outputs.filter(output => ![...completed.values()].some(receipt => receipt.status === 'SUCCEEDED' && receipt.dataSchemaId === 'export.completed.v1' && receipt.data.published === true && Array.isArray(receipt.data.outputKeys) && receipt.data.outputKeys.includes(output.outputKey) && receipt.artifacts.some(artifact => artifact.published && Array.isArray(receipt.data.artifactIds) && receipt.data.artifactIds.includes(artifact.asset.assetId))));
    if (missingOutputs.length) { job.receipt.status = 'FAILED_REQUIREMENTS'; job.receipt.unresolved = [{ code: 'REQUIRED_OUTPUT_MISSING', message: `No observed published result exists for: ${missingOutputs.map(item => item.outputKey).join(', ')}.`, retrySafe: false, nextAction: 'new_plan' }]; await this.saveJob(job); return; }
    if (job.receipt.requirementResults.every(result => result.verdict === 'pass' || requirements.find(requirement => requirement.id === result.requirementId)?.importance !== 'required')) { job.receipt.status = 'COMPLETED'; await this.saveJob(job); return; }
    if (!plan.review.enabled || job.repairs >= plan.review.maxRepairs || (Date.now() - Date.parse(job.reviewStartedAt)) / 1000 > plan.review.maxReviewSeconds) { job.receipt.status = 'FAILED_REQUIREMENTS'; await this.saveJob(job); return; }
    const scopes = new Set(plan.materializationGroups.map(group => group.app));
    const repairIds = new Set(plan.steps.map(step => step.operation));
    for (const id of ['ps.text.set', 'ps.text.fit', 'ps.layer.transform', 'ps.layer.mask', 'ps.document.resize', 'ps.layer.replacePixels', 'ps.adjustment.create', 'pr.clip.move', 'pr.clip.trim', 'pr.audio.gain', 'pr.motion.set', 'pr.effect.apply']) { const spec = this.registry.get(id); if (spec.app && scopes.has(spec.app)) repairIds.add(id); }
    const repair = await this.askController(job, 'repair', { task: 'repair', verdicts: job.receipt.requirementResults, issues: response?.issues ?? [], evidenceBindings: projection.evidenceBindings }, requirements, evidence, [...repairIds], assertions);
    const patches = [...new Map(repair.issues.flatMap(issue => issue.proposedPatch ? [issue.proposedPatch] : []).map(patch => [digest(patch), patch])).values()];
    requireCondition(patches.length === 1, 'REPAIR_UNCERTAIN', 'Controller must return one coherent bounded repair patch.'); await this.applyRepair(job, patches[0]!); await this.runJob(job);
  }
  private async applyRepair(job: JobState, patch: SemanticPatch): Promise<void> {
    if (this.isCancelled(job) || this.closing) return;
    requireCondition(patch.kind === 'repair' && patch.replacesStepKeys.length > 0, 'REPAIR_PATCH_INVALID', 'A repair must identify the existing steps it replaces.');
    const plan = job.plan!; const byKey = new Map(plan.steps.map(step => [step.stepKey, step]));
    requireCondition(patch.replacesStepKeys.every(key => byKey.has(key)), 'REPAIR_PATCH_INVALID', 'Repair refers to a nonexistent base step.');
    requireCondition(patch.reasonRequirementIds.length > 0 && patch.reasonRequirementIds.every(id => plan.review.requirements.some(requirement => requirement.id === id)), 'REPAIR_REQUIREMENT_INVALID', 'Repair must be tied to existing requirements.');
    const patchDigest = digest(patch); requireCondition(!this.journal.latest('repair.applied', `${job.receipt.jobId}:${patchDigest}`), 'REPEATED_REPAIR', 'The same issue/patch will not be applied again.');
    for (const operation of job.receipt.operations) requireCondition(!['DISPATCH_INTENT', 'RUNNING', 'OUTCOME_UNKNOWN', 'CANCEL_REQUESTED', 'APPLIED_UNVERIFIED'].includes(operation.status), 'REPAIR_WAIT_SETTLEMENT', 'Unknown/running effects must settle before replaying a working copy.');
    const replacements = new Map(patch.steps.map(step => [step.stepKey, step])); const next: PlanStep[] = [];
    for (const step of plan.steps) {
      if (!patch.replacesStepKeys.includes(step.stepKey)) { requireCondition(!replacements.has(step.stepKey), 'REPAIR_STEP_COLLISION', 'New repair step collides with an unchanged step.'); next.push(step); }
      else if (replacements.has(step.stepKey)) { next.push(replacements.get(step.stepKey)!); replacements.delete(step.stepKey); }
    }
    next.push(...replacements.values()); next.forEach(step => this.registry.validateStep(step)); validateDag(next);
    const invalidated = new Set(patch.replacesStepKeys); const changedGroups = new Set<string>();
    const oldReceipts = this.receipts(job); const workerIdentity = this.worker?.identity ? await this.worker.identity() : undefined;
    for (const step of next) if (this.registry.get(step.operation).route === 'worker') {
      const receipt = oldReceipts.get(step.stepKey); const previousIdentity = receipt ? this.journal.latest('worker.identity', receipt.operationId) : undefined;
      if (receipt?.status === 'SUCCEEDED' && (!workerIdentity || !previousIdentity || digest(workerIdentity) !== digest(previousIdentity))) invalidated.add(step.stepKey);
    }
    for (const key of patch.replacesStepKeys) { const effect = byKey.get(key)!.effect; if (effect.kind === 'mutable_host') changedGroups.add(effect.materializationGroupId); }
    for (const step of patch.steps) if (step.effect.kind === 'mutable_host') { const groupId = step.effect.materializationGroupId; requireCondition(plan.materializationGroups.some(group => group.groupId === groupId), 'REPAIR_NEW_GROUP_FORBIDDEN', 'Repair cannot add a new unowned materialization group.'); changedGroups.add(step.effect.materializationGroupId); }
    let logicalChanged = true; while (logicalChanged) { logicalChanged = false; for (const step of next) if (!invalidated.has(step.stepKey) && step.dependsOn.some(key => invalidated.has(key))) { invalidated.add(step.stepKey); logicalChanged = true; } }
    for (const step of next) if (invalidated.has(step.stepKey) && step.effect.kind === 'mutable_host') changedGroups.add(step.effect.materializationGroupId);
    const pending: NonNullable<JobState['pendingMaterializations']> = {};
    for (const groupId of changedGroups) {
      const checkpoint = [...job.receipt.checkpoints].reverse().find(item => item.materializationGroupId === groupId && item.savedThrough.length > 0 && item.savedThrough.every(saved => !invalidated.has(saved.stepKey) && byKey.has(saved.stepKey) && next.some(step => step.stepKey === saved.stepKey && digest(step) === digest(byKey.get(saved.stepKey)))));
      pending[groupId] = { ...(checkpoint ? { checkpointId: checkpoint.checkpointId } : {}), reason: checkpoint ? 'saved_prefix_before_changed_effect' : 'no_eligible_saved_prefix' };
    }
    // Historical success is not live state: restore an observed prefix or replay the immutable source base.
    for (const step of next) if (step.effect.kind === 'mutable_host' && changedGroups.has(step.effect.materializationGroupId)) invalidated.add(step.stepKey);
    let changed = true; while (changed) { changed = false; for (const step of next) if (!invalidated.has(step.stepKey) && step.dependsOn.some(key => invalidated.has(key))) { invalidated.add(step.stepKey); changed = true; } }
    const retained: Record<string, OperationReceipt> = {};
    for (const step of next) { const receipt = oldReceipts.get(step.stepKey); if (!invalidated.has(step.stepKey) && receipt?.status === 'SUCCEEDED' && byKey.has(step.stepKey) && digest(byKey.get(step.stepKey)) === digest(step)) retained[step.stepKey] = receipt; }
    const revisionId = randomUUID(); const previousRevision = plan.revisionId; const groups = structuredClone(plan.materializationGroups);
    for (const group of groups) group.mutationOrder = next.filter(step => step.effect.kind === 'mutable_host' && step.effect.materializationGroupId === group.groupId).map(step => step.stepKey);
    job.plan = { ...plan, revisionId, parentRevisionId: previousRevision, steps: next, materializationGroups: groups };
    job.receipt.revisionId = revisionId; job.receipt.status = 'RUNNING'; job.receipt.requirementResults = []; job.stepOperations = {}; job.retainedReceipts = retained; job.repairs++; job.revisionCount++;
    job.receipt.operations = Object.entries(retained).map(([stepKey, receipt]) => ({ stepKey, operationId: receipt.operationId, status: receipt.status })); job.receipt.artifacts = Object.values(retained).flatMap(receipt => receipt.artifacts);
    job.pendingMaterializations = pending;
    await this.journal.append('repair.applied', `${job.receipt.jobId}:${patchDigest}`, { parentRevisionId: previousRevision, revisionId, patch, invalidated: [...invalidated], materializations: pending }); await this.saveJob(job);
  }
  private isCancelled(job: JobState): boolean { return job.receipt.status === 'CANCELLED'; }
  private enforceRetention(): Promise<void> {
    const next = this.retentionLane.then(async () => {
      if (this.closing) return;
      const limits = { maxCompletedRevisions: this.options.retention?.maxCompletedRevisions ?? 64, maxRetainedBytes: this.options.retention?.maxRetainedBytes ?? 64 * 1024 * 1024 };
      requireCondition(Number.isSafeInteger(limits.maxCompletedRevisions) && limits.maxCompletedRevisions >= 1 && Number.isSafeInteger(limits.maxRetainedBytes) && limits.maxRetainedBytes >= 1024, 'RETENTION_POLICY_INVALID', 'Retention limits must be positive bounded integers.');
      const before = this.journal.all(); const projection = retainJournal(before, limits);
      const compact = projection.expiredRevisions.some(id => !this.journal.latest('revision.expired', id)) || before.length > projection.entries.length * 2 + 256;
      if (!compact) return;
      let expiredJobs = projection.expiredJobs;
      await this.journal.compact(events => { const retained = retainJournal(events, limits); expiredJobs = retained.expiredJobs; return retained.entries; });
      for (const jobId of expiredJobs) if (!this.running.has(jobId)) this.jobs.delete(jobId);
    });
    this.retentionLane = next.catch(() => undefined); return next;
  }
  hasActiveWork(): boolean { return this.running.size > 0 || [...this.jobs.values()].some(job => ['RUNNING', 'RECONCILING'].includes(job.receipt.status)); }
  async close(): Promise<void> {
    this.closing = true;
    for (const requestId of this.controllerTimers.keys()) this.clearControllerTimer(requestId);
    for (const job of this.jobs.values()) if (!TERMINAL.has(job.receipt.status)) { job.receipt.status = 'RECONCILING'; await this.saveJob(job); }
    for (const job of this.jobs.values()) if (job.pendingControllerId) await this.controller?.cancel(job.pendingControllerId);
    for (const finish of this.nativeWaits.values()) finish();
    await this.worker?.close?.(); await Promise.allSettled([...this.running.values()]); await this.retentionLane; await this.journal.close();
  }
}
