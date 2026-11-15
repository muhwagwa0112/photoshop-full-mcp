import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WorkflowService } from '../src/automation/service.js';
import { digest } from '../src/automation/canonical.js';
import { mapPixelCenter, photoRectToDocument, rasterPoint } from '../src/automation/coordinates.js';
import { runSync, type WorkerClient } from '../src/automation/worker.js';
import type { ArtifactReceipt, AssetRef, ControllerRequest, EditPlan, ExpectedState, HostRef, JobReceipt, OperationReceipt, OperationRequest, RecipeRequest, SubmissionReceipt, VisualEvidenceReceipt } from '../src/automation/contracts.js';

const sha = 'a'.repeat(64);
const host: HostRef = { app: 'photoshop', installationId: 'fixture', hostEpoch: 'epoch' };
const code = (expected: string) => (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === expected;
const asset: AssetRef = { assetId: 'source', rootId: 'input', relativePath: 'source.png', sha256: sha, sizeBytes: '10', media: { kind: 'image', mimeType: 'image/png' } };
const budget = { maxRequests: 3, maxInputTokens: 1000, maxOutputTokens: 1000, maxImagePixels: '1000000', maxElapsedSeconds: 60, maxCostMinor: '0', currency: 'USD', enforcement: 'client_reported' as const };
function plan(): EditPlan {
  return { contractVersion: '1.0', requestId: randomUUID(), workflowHome: { app: 'photoshop', installationId: 'fixture', namespaceId: randomUUID() }, jobId: randomUUID(), revisionId: randomUUID(), brief: 'Focused runtime boundary fixture', inputs: {}, steps: [], materializationGroups: [], delivery: { outputs: [], preserveNativeEditing: true, allowedFallbacks: [], verifyMode: 'metadata_and_changed_regions' }, resources: { maxHostMutations: 1, maxWorkerJobs: 1, maxCpuThreads: 1, maxTemporaryBytes: '10000000', maxRemoteBytes: '0', maxPaidCredits: 0, remoteTransferAllowed: false }, review: { enabled: false, requirements: [{ id: 'required', description: 'Actual mandatory observation', importance: 'required', evaluator: 'assertion', assertionIds: ['required.assertion'], evidenceKeys: [], passRule: { allAssertionsPass: true } }], maxRepairs: 0, maxReviewSeconds: 30 }, controller: { mode: 'client_agent', waitDeadline: new Date(Date.now() + 60_000).toISOString(), modelBudget: budget } };
}
interface FixtureJob {
  submission: SubmissionReceipt; request: RecipeRequest; plan: EditPlan; receipt: JobReceipt; inputs: Record<string, AssetRef>; stepOperations: Record<string, string>; retainedReceipts: Record<string, OperationReceipt>; repairs: number; revisionCount: number; createdAt: string; pendingControllerId?: string;
}
function job(p: EditPlan): FixtureJob {
  return { submission: { requestId: p.requestId, requestDigest: digest(p), workflowHome: p.workflowHome, jobId: p.jobId, revisionId: p.revisionId, resultRetention: 'available' }, request: { contractVersion: '1.0', requestId: p.requestId, workflowHome: p.workflowHome, recipeId: 'ps.photo_composite.v1', brief: p.brief, inputs: {}, parameters: {}, delivery: p.delivery, resources: p.resources, review: p.review, controller: p.controller }, plan: p, receipt: { jobId: p.jobId, revisionId: p.revisionId, status: 'RUNNING', operations: [], artifacts: [], requirementResults: [], checkpoints: [], modelUsage: [], unresolved: [] }, inputs: {}, stepOperations: {}, retainedReceipts: {}, repairs: 0, revisionCount: 0, createdAt: new Date().toISOString() };
}
function invoke<Args extends unknown[], Result = void>(service: WorkflowService, method: string, ...args: Args): Promise<Result> {
  // Direct component access avoids exporting test-only production APIs or substituting the runtime logic.
  return (Reflect.get(service, method) as (...values: Args) => Promise<Result>).apply(service, args);
}
async function setup(p = plan()): Promise<{ service: WorkflowService; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'automation-runtime-'));
  const service = new WorkflowService({ workflowHome: p.workflowHome, dataDirectory: directory, roots: { input: directory } }); await service.start(); return { service, directory };
}
function observed(operationId: string): OperationReceipt {
  return { operationId, requestDigest: sha, host, status: 'SUCCEEDED', effect: 'applied', dataState: 'complete', dataSchemaId: 'query.inventory.v1', data: { resourceSlot: 'items', totalReturned: 0, complete: true }, resources: {}, artifacts: [], evidence: [], verification: [], cancelRequested: false, recovery: { authorityId: 'fixture', authorityGeneration: 'epoch', savedThroughOperationIds: [], effectEvidence: 'host_receipt' }, timestamps: { accepted: new Date().toISOString() } };
}
function request(p: EditPlan, operation: string): OperationRequest {
  return { contractVersion: '1.0', jobId: p.jobId, revisionId: p.revisionId, stepKey: operation, operationId: randomUUID(), executionNamespaceId: p.workflowHome.namespaceId, operation, host, args: {}, assets: {}, assertions: [], waitTimeoutMs: 30_000, executionDeadline: new Date(Date.now() + 30_000).toISOString() };
}
test('pixel centers and original-photo regions preserve observed affine and reject cropped source regions', () => {
  const full: VisualEvidenceReceipt = { kind: 'roi', evidenceKey: 'full', operationId: 'capture', sourceAssetIds: ['source'], snapshotDigest: sha, capturedAt: new Date().toISOString(), artifact: asset, width: 1000, height: 500, color: { bitDepth: 8, range: 'full', alpha: 'none' }, sourceBounds: { x: 10, y: 20, width: 1000, height: 500 }, evidenceToSource: [1, 0, 0, 1, 10, 20] };
  const preview = { ...full, width: 100, height: 50, evidenceToSource: [10, 0, 0, 10, 10, 20] as [number, number, number, number, number, number] };
  assert.deepEqual(mapPixelCenter(preview, full, 0, 0), { x: 4.5, y: 4.5 });
  assert.throws(() => rasterPoint({ ...full, evidenceToSource: [0, 0, 0, 0, 0, 0] }, 1, 2), code('RASTER_TRANSFORM_INVALID'));
  const placement = { sourceWidth: 200, sourceHeight: 100, sourceAssetId: 'source', sourceSha256: sha, sourceToDocument: [2, 0, 0, 2, -50, 10] as [number, number, number, number, number, number], visibleBounds: { x: 0, y: 10, width: 300, height: 200 } };
  assert.deepEqual(photoRectToDocument({ x: 30, y: 5, width: 10, height: 10 }, placement).pixels, { x: 10, y: 20, width: 20, height: 20 });
  assert.throws(() => photoRectToDocument({ x: 0, y: 5, width: 10, height: 10 }, placement), code('PHOTO_REGION_CROPPED'));
});

test('disabling model review never exempts a missing mandatory assertion even when an output is published', async () => {
  const p = plan(); const output = { outputKey: 'image', rootId: 'input', relativeDirectory: '', basename: 'image', format: 'png', width: 10, height: 10, encoding: { kind: 'image' as const, compression: 'lossless' as const, embedIcc: false }, collision: { onConflict: 'error' as const, preserveSource: true as const } };
  p.delivery.outputs = [output]; p.steps = [{ stepKey: 'export', operation: 'ps.document.export', args: { output }, dependsOn: [], effect: { kind: 'read_only' }, assertions: [], failureStrategy: 'stop' }];
  const state = job(p); const receipt = observed(randomUUID()); const artifact: ArtifactReceipt = { kind: 'artifact', asset, operationId: receipt.operationId, sourceAssets: [], recipeDigest: sha, published: true, verification: [] };
  receipt.dataSchemaId = 'export.completed.v1'; receipt.data = { outputKeys: ['image'], artifactIds: [asset.assetId], published: true }; receipt.artifacts = [artifact]; state.retainedReceipts.export = receipt;
  const { service, directory } = await setup(p);
  try { await invoke(service, 'reviewJob', state); assert.equal(state.receipt.status, 'FAILED_REQUIREMENTS'); assert.equal(state.receipt.requirementResults[0]?.verdict, 'uncertain'); assert.equal(service.journal.all('controller.request').length, 0); }
  finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('late client controller evidence is rejected and owner-known image usage cannot be reduced or relabelled', async () => {
  const p = plan(), state = job(p); const { service, directory } = await setup(p);
  const id = randomUUID(); const controller: ControllerRequest = { requestId: id, requestDigest: sha, jobId: p.jobId, revisionId: p.revisionId, purpose: 'review', brief: 'Deadline boundary', requirements: [{ id: 'visual', description: 'Observed result', importance: 'required', evaluator: 'semantic', assertionIds: [], evidenceKeys: [], passRule: { allAssertionsPass: true } }], evidence: [], verifiedAssertions: [], allowedOperationIds: [], remainingBudget: budget, expiresAt: new Date(Date.now() - 1000).toISOString() };
  try {
    const reservation = await service.budget.reserve(p.jobId, controller, 'client-agent', 0, 0, '100');
    const usage = { requestId: id, providerId: 'client-agent', state: 'consumed' as const, inputTokens: 20, outputTokens: 10, imagePixels: '1', costMinor: '0', currency: 'USD', enforcement: 'client_reported' as const, accounting: 'client_reported' as const };
    await assert.rejects(service.budget.settle(reservation, { ...usage, enforcement: 'server_enforced', accounting: 'provider_reported' }), code('MODEL_USAGE_MISMATCH'));
    await service.budget.settle(reservation, usage); assert.equal(service.budget.records(p.jobId)[0]?.usage.imagePixels, '100');
    state.receipt.status = 'WAIT_PROVIDER'; state.pendingControllerId = id; await invoke(service, 'saveJob', state);
    await service.journal.append('controller.request', id, { request: controller, key: 'key', context: {}, reservation });
    await assert.rejects(service.controllerRespond({ requestId: id, requestDigest: sha, providerId: 'client-agent', verdicts: [{ requirementId: 'visual', verdict: 'pass', assertionIds: [], evidenceKeys: [], reason: 'Late result' }], issues: [], usage }), code('CONTROLLER_DEADLINE_EXCEEDED'));
    assert.equal(state.receipt.status, 'FAILED_ENVIRONMENT'); assert.equal(service.journal.latest('controller.response', id), undefined);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('native post-state survives a receipt-to-snapshot crash gap and is passed unchanged to the next native read', async () => {
  const p = plan(), state = job(p); state.receipt.status = 'FAILED'; let { service, directory } = await setup(p);
  const target = { kind: 'ps_document' as const, host, workingAssetId: 'working:photo', documentId: 7 };
  const after = (historyStateId: number): ExpectedState => { const fields = { 'document.documentId': 7, 'document.workingAssetId': 'working:photo', 'document.historyStateId': historyStateId }; return { projectionVersion: 1, fields, digest: digest(fields) }; };
  try {
    const first = observed(randomUUID()); first.resources.document = { kind: 'single', resourceKind: 'document', item: { itemKey: 'document', value: target } }; first.recovery.afterState = after(10);
    await invoke(service, 'recordOperation', state, 'open', first);
    const next = request(p, 'ps.document.inspect'); next.target = target;
    const prepared = await invoke<[FixtureJob, OperationRequest, Map<string, OperationReceipt>], OperationRequest>(service, 'prepareHostRequest', state, next, new Map()); assert.deepEqual(prepared.expectedBefore, after(10));
    const req = request(p, 'ps.text.set'); req.target = { ...target, kind: 'ps_layer', layerIds: [2] };
    await service.journal.acceptOnce('operation', req.operationId, digest(req), () => req);
    const last = { ...first, operationId: req.operationId, recovery: { ...first.recovery, afterState: after(11) } };
    await service.journal.append('operation.receipt', req.operationId, last); // Durable result; its job snapshot is intentionally absent.
    await service.close(); service = new WorkflowService({ workflowHome: p.workflowHome, dataDirectory: directory, roots: { input: directory } }); await service.start();
    const restored = service.journal.latest<FixtureJob>('job.state', p.jobId)!;
    const resumed = await invoke<[FixtureJob, OperationRequest, Map<string, OperationReceipt>], OperationRequest>(service, 'prepareHostRequest', restored, next, new Map()); assert.deepEqual(resumed.expectedBefore, after(11));
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test('timecode uses only an explicit fallback after a settled result and never repeats unknown worker transport', async () => {
  const p = plan(); const { service, directory } = await setup(p);
  try {
    await writeFile(path.join(directory, 'camera.bin'), 'camera'); await writeFile(path.join(directory, 'voice.bin'), 'voice');
    const req = request(p, 'audio.sync'); req.assets = { camera: await service.assets.resolve({ rootId: 'input', relativePath: 'camera.bin' }), voice: await service.assets.resolve({ rootId: 'input', relativePath: 'voice.bin' }) }; req.args = { inputKeys: ['camera', 'voice'], sync: { primary: 'timecode', fallback: 'waveform', referenceInput: 'voice', maxResidualOffsetMs: 20 } };
    const calls: string[] = []; let unknown = false;
    const worker: WorkerClient = { cancel: async () => ({ requested: true, stopped: true }), run: async input => { const method = String(input.options.method); calls.push(method); if (unknown) throw new Error('transport lost after dispatch'); return { workerRequestId: input.workerRequestId, operation: input.operation, ok: method === 'waveform', data: method === 'waveform' ? { offsetTicks: '100', residualOffsetSamples: '0', sampleRate: 48000 } : {}, artifacts: [], ...(method === 'timecode' ? { error: { code: 'TIMECODE_MISSING', message: 'No observed tag', retrySafe: true } } : {}) }; } };
    const result = await runSync(req, worker, service.assets, p.resources); assert.deepEqual(calls, ['timecode', 'waveform']); assert.equal((result.data.offsets as { method: string }[])[0]?.method, 'waveform');
    calls.length = 0; unknown = true; req.operationId = randomUUID(); await assert.rejects(runSync(req, worker, service.assets, p.resources), /transport lost/); assert.deepEqual(calls, ['timecode']);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
