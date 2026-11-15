import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactReceipt, ArtifactSpec, AssetRef, EditPlan, EvidenceReceipt, HostRef, Json, JsonObject, OperationReceipt, PlanStep, PrClipTarget, PsDocumentTarget, PsLayerTarget, ResourceOutput } from '../src/automation/contracts.js';
import { buildReviewProjection } from '../src/automation/review-projections.js';

const sha = 'a'.repeat(64);
const host: HostRef = { app: 'photoshop', installationId: 'installation', hostEpoch: 'epoch' };
const asset = (id: string, kind: AssetRef['media']['kind'] = 'image'): AssetRef => ({ assetId: id, rootId: 'workspace', relativePath: id, sha256: sha, sizeBytes: '10', media: { kind, mimeType: kind === 'image' ? 'image/png' : 'application/octet-stream' } });
const step = (stepKey: string, operation: string, args: JsonObject = {}): PlanStep => ({ stepKey, operation, args, dependsOn: [], effect: { kind: 'read_only' }, assertions: [], failureStrategy: 'stop' });
function receipt(id: string, dataSchemaId = 'query.inventory.v1', data: JsonObject = {}, resources: Record<string, ResourceOutput> = {}): OperationReceipt {
  return { operationId: id, requestDigest: sha, host, status: 'SUCCEEDED', effect: 'not_applied', dataState: 'complete', dataSchemaId, data, resources, verification: [], evidence: [], artifacts: [], recovery: { authorityId: 'owner', authorityGeneration: 'generation', savedThroughOperationIds: [], effectEvidence: 'host_receipt' }, cancelRequested: false, timestamps: { accepted: '2026-01-01T00:00:00Z' } };
}
function plan(steps: PlanStep[], assertionIds: string[], evidenceKeys: string[] = [], outputs: ArtifactSpec[] = []): EditPlan {
  return { contractVersion: '1.0', requestId: 'request', workflowHome: { app: 'photoshop', installationId: 'installation', namespaceId: 'namespace' }, jobId: 'job', revisionId: 'revision-current', brief: 'projection fixture', inputs: {}, steps, materializationGroups: [], delivery: { outputs, preserveNativeEditing: true, allowedFallbacks: ['native_equivalent'], verifyMode: 'metadata_and_changed_regions' }, resources: { maxHostMutations: 1, maxWorkerJobs: 1, maxCpuThreads: 1, maxTemporaryBytes: '1000000', maxRemoteBytes: '0', maxPaidCredits: 0, remoteTransferAllowed: false }, review: { enabled: true, requirements: [{ id: 'review', description: 'Only actual observations', importance: 'required', evaluator: evidenceKeys.length ? 'both' : 'assertion', assertionIds, evidenceKeys, passRule: { allAssertionsPass: true } }], maxRepairs: 0, maxReviewSeconds: 10 }, controller: { mode: 'client_agent', waitDeadline: '2026-01-01T00:10:00Z', modelBudget: { maxRequests: 1, maxInputTokens: 1000, maxOutputTokens: 1000, maxImagePixels: '100000', maxElapsedSeconds: 10, maxCostMinor: '0', currency: 'USD', enforcement: 'client_reported' } } };
}
const doc: PsDocumentTarget = { kind: 'ps_document', host, documentId: 1, workingAssetId: 'working:doc' };
const layer: PsLayerTarget = { ...doc, kind: 'ps_layer', layerIds: [7] };
function layerResources(projection: JsonObject): Record<string, ResourceOutput> {
  return { document: { kind: 'single', resourceKind: 'document', item: { itemKey: 'document', value: doc } }, layers: { kind: 'collection', resourceKind: 'layer', complete: true, items: [{ itemKey: 'layer:7', value: layer, projection }] } };
}
function visual(evidenceKey: string): EvidenceReceipt {
  return { kind: 'composite', evidenceKey, operationId: evidenceKey, sourceAssetIds: [], snapshotDigest: sha, capturedAt: '2026-01-01T00:00:00Z', artifact: asset(evidenceKey), target: doc, sourceBounds: { x: 0, y: 0, width: 100, height: 100 }, width: 100, height: 100, color: { bitDepth: 8, range: 'full', alpha: 'straight' }, evidenceToSource: [1, 0, 0, 1, 0, 0] };
}
const ticks = (start: string, end: string) => ({ start: { ticks: start }, end: { ticks: end } });
function clip(clipKey: string, sourceAssetId: string, mediaType: 'video' | 'audio', start = '0', end = '100'): PrClipTarget {
  return { kind: 'pr_clip', host: { ...host, app: 'premiere' }, projectGuid: 'project', sequenceGuid: 'sequence', workingAssetId: 'working:project', mediaType, trackIndex: 0, trackFingerprint: sha, clipKey, cepNodeId: clipKey, sourceAssetId, sourceRange: ticks('0', '100'), timelineRange: ticks(start, end), structuralFingerprint: sha };
}
function clipResources(values: PrClipTarget[]): Record<string, ResourceOutput> {
  return { clips: { kind: 'collection', resourceKind: 'clip', complete: true, items: values.map(value => ({ itemKey: value.clipKey, value })) } };
}
function published(id: string, media: AssetRef['media']): ArtifactReceipt {
  return { kind: 'artifact', asset: { ...asset(id), media }, operationId: id, sourceAssets: [], recipeDigest: sha, published: true, verification: [] };
}
function exported(spec: ArtifactSpec, item: ArtifactReceipt): OperationReceipt {
  const result = receipt(spec.outputKey, 'export.completed.v1', { outputKeys: [spec.outputKey], artifactIds: [item.asset.assetId], published: true, verificationScope: 'metadata_and_changed_regions' });
  result.artifacts = [item]; return result;
}
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

test('review uses latest native text and preserves authoritative failures without borrowing orphan receipts', () => {
  const text = step('title', 'ps.text.set', { text: 'Requested' }); text.target = { kind: 'live', target: layer };
  const capture = step('final', 'ps.evidence.capture');
  const first = receipt('text', 'ps.layer_change.v1', { finalText: 'Requested' }, layerResources({ text: 'Requested' })); first.targetAfter = layer;
  const last = receipt('capture', 'evidence.capture.v1', {}, layerResources({ text: 'Actually different' }));
  const orphan = receipt('old'); orphan.verification = [{ assertionId: 'title.motion_unchanged', status: 'pass', method: 'old revision' }];
  const map = new Map([['title', first], ['final', last], ['previous-revision-only', orphan]]);
  const projected = buildReviewProjection(plan([text, capture], ['text.exact_content', 'title.motion_unchanged']), map, {});
  assert.deepEqual(projected.assertions.map(value => value.status), ['fail', 'not_run']);
  const exact = { assertionId: 'text.exact_content', status: 'not_run' as const, method: 'native readback unavailable' }; last.verification = [exact];
  assert.strictEqual(buildReviewProjection(plan([text, capture], ['text.exact_content']), map, {}).assertions[0], exact);
});

test('partial visual groups retain an unresolved alias and never claim a stitched contact sheet', () => {
  const a = step('variant.a.evidence', 'ps.evidence.capture', { evidenceKey: 'variant.a.final' });
  const b = step('variant.b.evidence', 'ps.evidence.capture', { evidenceKey: 'variant.b.final' });
  const observed = receipt('a', 'evidence.capture.v1'); observed.evidence = [visual('variant.a.final')];
  const projected = buildReviewProjection(plan([a, b], [], ['product.variants.contact_sheet', 'title.before']), new Map([[a.stepKey, observed]]), {});
  assert.deepEqual(projected.evidenceBindings['product.variants.contact_sheet'], ['variant.a.final']);
  assert.deepEqual(projected.requirements[0]!.evidenceKeys, ['variant.a.final', 'product.variants.contact_sheet', 'title.before']);
  assert.match(projected.requirements[0]!.description, /separate captured images\/frames, not a stitched contact sheet/);
});

test('published image dimensions are matched by output key and missing outputs cannot pass', () => {
  const spec: ArtifactSpec = { outputKey: 'image', rootId: 'output', relativeDirectory: '', basename: 'image', format: 'png', width: 100, height: 200, encoding: { kind: 'image', compression: 'lossless', embedIcc: false }, collision: { onConflict: 'error', preserveSource: true } };
  const output = step('output.image', 'ps.document.export', { output: json(spec) });
  const artifact = published('actual-image', { kind: 'image', mimeType: 'image/png', width: 100, height: 200 });
  const map = new Map([[output.stepKey, exported(spec, artifact)]]);
  assert.equal(buildReviewProjection(plan([output], ['outputs.image_dimensions'], [], [spec]), map, {}).assertions[0]!.status, 'pass');
  const wrong = { ...spec, outputKey: 'different-output' };
  assert.equal(buildReviewProjection(plan([output], ['outputs.image_dimensions'], [], [wrong]), map, {}).assertions[0]!.status, 'not_run');
});

test('sync requires actual residual and final native source placements, not manual offsets', () => {
  const sync = step('sync', 'audio.sync', { inputKeys: ['camera', 'voice'], sync: { maxResidualOffsetMs: 20 } });
  const cut = step('cut', 'pr.cut_map.build');
  const assembled = step('assembly', 'pr.timeline.assemble', { audioInput: 'voice', cameraInputs: ['camera'] });
  const final = step('final', 'pr.timeline.inspect');
  const inputs = { camera: asset('camera', 'video'), voice: asset('voice', 'audio') };
  const camera = clip('camera-clip', 'camera', 'video'), voice = clip('voice-clip', 'voice', 'audio');
  const segment = (sourceAssetId: string) => ({ segmentKey: sourceAssetId, sourceAssetId, sourceRange: ticks('0', '100'), timelineRange: ticks('0', '100'), speedNumerator: 1, speedDenominator: 1, reverse: false });
  const syncReceipt = receipt('sync', 'audio.sync.v1', { referenceInput: 'voice', offsets: [{ inputKey: 'camera', offsetTicks: '0', method: 'manual' }, { inputKey: 'voice', offsetTicks: '0', method: 'manual' }] });
  const map = new Map([['sync', syncReceipt], ['cut', receipt('cut', 'pr.cut_map.v1', { segments: [segment('camera'), segment('voice')] })], ['final', receipt('final', 'query.inventory.v1', {}, clipResources([camera, voice]))]]);
  const p = plan([sync, cut, assembled, final], ['sync.residual_offset']);
  assert.equal(buildReviewProjection(p, map, inputs).assertions[0]!.status, 'not_run');
  syncReceipt.data = { referenceInput: 'voice', offsets: [{ inputKey: 'camera', offsetTicks: '0', method: 'waveform', residualOffsetSamples: '480', sampleRate: 48000 }, { inputKey: 'voice', offsetTicks: '0', method: 'manual' }] };
  assert.equal(buildReviewProjection(p, map, inputs).assertions[0]!.status, 'pass');
  map.set('final', receipt('moved', 'query.inventory.v1', {}, clipResources([clip('camera-clip', 'camera', 'video', '1', '101'), voice])));
  assert.equal(buildReviewProjection(p, map, inputs).assertions[0]!.status, 'not_run');
});

test('ordinary multicam retains every imported camera but requires clips only for cameras used in the cut map', () => {
  const inputs = { cameraA: asset('cameraA', 'video'), cameraB: asset('cameraB', 'video'), audio: asset('audio', 'audio') };
  const imported = step('import', 'pr.media.import');
  const cut = step('cut', 'pr.cut_map.build', { parameters: { cameraInputs: ['cameraA', 'cameraB'], nativeMulticamRequired: false, ordinaryEditableTrackFallbackAllowed: true } });
  const assembly = step('assembly', 'pr.timeline.assemble', { cameraInputs: ['cameraA', 'cameraB'], audioInput: 'audio' });
  const final = step('final', 'pr.timeline.inspect');
  const segment = (segmentKey: string, sourceAssetId: string) => ({ segmentKey, sourceAssetId, sourceRange: ticks('0', '100'), timelineRange: ticks('0', '100'), speedNumerator: 1, speedDenominator: 1, reverse: false });
  const importResources = (keys: string[]): Record<string, ResourceOutput> => ({ items: { kind: 'collection', resourceKind: 'project_item', complete: true, items: keys.map(key => ({ itemKey: key, value: { kind: 'pr_project_item', host: { ...host, app: 'premiere' }, projectGuid: 'project', workingAssetId: 'working:project', projectItemId: `item:${key}`, sourceAssetId: key } })) } });
  const map = new Map([
    ['import', receipt('import', 'media.import.v1', {}, importResources(['cameraA', 'cameraB', 'audio']))],
    ['cut', receipt('cut', 'pr.cut_map.v1', { segments: [segment('angle-0', 'cameraA'), segment('reference-audio', 'audio')] })],
    ['final', receipt('final', 'query.inventory.v1', {}, clipResources([clip('angle-A', 'cameraA', 'video'), clip('reference-audio', 'audio', 'audio')]))],
  ]);
  const p = plan([imported, cut, assembly, final], ['multicam.native_structure']);
  assert.equal(buildReviewProjection(p, map, inputs).assertions[0]!.status, 'pass');
  map.set('import', receipt('missing-B', 'media.import.v1', {}, importResources(['cameraA', 'audio'])));
  assert.equal(buildReviewProjection(p, map, inputs).assertions[0]!.status, 'fail');
  map.set('import', receipt('import', 'media.import.v1', {}, importResources(['cameraA', 'cameraB', 'audio'])));
  map.set('final', receipt('missing-A-clip', 'query.inventory.v1', {}, clipResources([clip('reference-audio', 'audio', 'audio')])));
  assert.notEqual(buildReviewProjection(p, map, inputs).assertions[0]!.status, 'pass');
});

test('full source affine detects cropping despite visible bounds being inside the canvas', () => {
  const dimensions = step('size', 'ps.document.resize');
  const replace = step('content', 'ps.placeholder.replace'); replace.target = { kind: 'live', target: layer }; replace.assets = { source: { kind: 'input', inputKey: 'product' } };
  const final = step('final', 'ps.evidence.capture');
  const placement = { sourceAssetId: 'product', sourceSha256: sha, sourceWidth: 200, sourceHeight: 100, sourceToDocument: [1, 0, 0, 1, -50, 0], visibleBounds: { x: 0, y: 0, width: 100, height: 100 } };
  const placed = receipt('content', 'ps.layer_change.v1', {}, layerResources({ sourcePlacement: placement })); placed.targetAfter = layer;
  const map = new Map([['size', receipt('size', 'ps.document_info.v1', { width: 100, height: 100 }, layerResources({}))], ['content', placed], ['final', receipt('final', 'evidence.capture.v1', {}, layerResources({ sourcePlacement: placement }))]]);
  const result = buildReviewProjection(plan([dimensions, replace, final], ['product.bounds_inside_canvas', 'roles.asset_bindings']), map, { product: asset('product') });
  assert.deepEqual(result.assertions.map(value => value.status), ['fail', 'pass']);
});

test('loudness requires actual exported-file measurements rather than source analysis or gain requests', () => {
  const spec: ArtifactSpec = { outputKey: 'video', rootId: 'output', relativeDirectory: '', basename: 'video', format: 'mp4', encoding: { kind: 'video', encoderPresetId: 'preset', videoCodec: 'h264', pixelFormat: 'yuv420p', fieldOrder: 'progressive', rateControl: 'preset', allowPresetOverrides: false }, audio: { sampleRate: 48000, channels: 2, channelLayout: 'stereo', integratedLufs: -16, maxTruePeakDbtp: -1 }, collision: { onConflict: 'error', preserveSource: true } };
  const output = step('output', 'pr.export', { output: json(spec) });
  const exportedReceipt = exported(spec, published('video', { kind: 'video', mimeType: 'video/mp4' }));
  const map = new Map([['output', exportedReceipt]]), p = plan([output], ['audio.final_loudness', 'audio.true_peak'], [], [spec]);
  assert.deepEqual(buildReviewProjection(p, map, {}).assertions.map(value => value.status), ['not_run', 'not_run']);
  exportedReceipt.verification = [{ assertionId: 'output:verify', status: 'pass', method: 'actual file probe', actual: { verified: true, checks: [{ name: 'audio.integratedLufs', status: 'pass', expected: -16, actual: -16.2 }, { name: 'audio.maxTruePeakDbtp', status: 'pass', expected: -1, actual: -1.1 }] } }];
  assert.deepEqual(buildReviewProjection(p, map, {}).assertions.map(value => value.status), ['pass', 'pass']);
});

test('protected state excludes only exact planned clips and detects another clip moving', () => {
  const intended = clip('title', 'title-image', 'video'), protectedClip = clip('unrelated', 'camera', 'video');
  const before = step('before', 'pr.timeline.inspect'), move = step('move', 'pr.clip.move', { timelineStartTicks: '10' }), after = step('after', 'pr.timeline.inspect');
  move.effect = { kind: 'mutable_host', materializationGroupId: 'project' }; move.target = { kind: 'live', target: intended };
  const map = new Map([['before', receipt('before', 'query.inventory.v1', {}, clipResources([intended, protectedClip]))], ['after', receipt('after', 'query.inventory.v1', {}, clipResources([clip('title', 'title-image', 'video', '10', '110'), clip('unrelated', 'camera', 'video', '20', '120')]))]]);
  assert.equal(buildReviewProjection(plan([before, move, after], ['timeline.protected_state']), map, {}).assertions[0]!.status, 'fail');
  after.target = { kind: 'live', target: { kind: 'pr_sequence', host: intended.host, projectGuid: intended.projectGuid, sequenceGuid: intended.sequenceGuid, workingAssetId: intended.workingAssetId } };
  map.set('after', receipt('empty-after', 'query.inventory.v1', {}, clipResources([])));
  assert.equal(buildReviewProjection(plan([before, move, after], ['timeline.protected_state']), map, {}).assertions[0]!.status, 'fail');
});
