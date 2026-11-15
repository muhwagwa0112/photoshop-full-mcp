import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AssetRef, ArtifactReceipt, EvidenceReceipt, Json, JsonObject, MediaInfo, OperationRequest, ResourceOutput, ResourcePolicy, VerificationResult } from './contracts.js';
import type { AssetStore } from './assets.js';
import { requireCondition, AutomationError } from './errors.js';
import { digest } from './canonical.js';
import { range } from './timeline.js';

export interface WorkerRequest {
  workerRequestId: string;
  operation: 'media.inspect' | 'media.frames' | 'media.conform' | 'media.transcribe' | 'audio.analyze' | 'audio.render' | 'audio.sync' | 'image.segment' | 'image.inpaint' | 'artifact.verify';
  inputs: Record<string, { path: string; sha256?: string }>;
  options: Record<string, unknown>;
  outputDirectory: string;
  limits: { maxCpuThreads: number; maxTemporaryBytes: string; maxOutputBytes: number; timeoutMs: number };
}
export interface WorkerResult {
  workerRequestId: string; operation: string; ok: boolean; data: Record<string, unknown>;
  artifacts: { path: string; sha256: string; sizeBytes: string; kind: string; mimeType: string; metadata?: Record<string, unknown> }[];
  cancelled?: boolean; error?: { code: string; message: string; retrySafe: boolean };
}
export interface WorkerClient { run(request: WorkerRequest): Promise<WorkerResult>; cancel(workerRequestId: string): Promise<{ requested: boolean; stopped: boolean }>; identity?(): { profileDigest: string; implementationDigest: string } | Promise<{ profileDigest: string; implementationDigest: string }>; availability?(operation: WorkerRequest['operation'], options?: Record<string, unknown>): { state: 'available' | 'requires_setup'; reason?: string } | Promise<{ state: 'available' | 'requires_setup'; reason?: string }>; close?(): Promise<void> | void }
export interface WorkerExecution {
  data: JsonObject; artifacts: ArtifactReceipt[]; resources: Record<string, ResourceOutput>; evidence: EvidenceReceipt[]; verification: VerificationResult[];
}
/** An identified worker returned a definitive failure; transport uncertainty is a different outcome. */
export class WorkerResultError extends AutomationError {}
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
function mediaFor(kind: string, mimeType: string, metadata: Record<string, unknown> = {}): MediaInfo {
  const supported: MediaInfo['kind'][] = ['image', 'video', 'audio', 'project', 'subtitle', 'metadata'];
  const inferred = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : 'metadata';
  const media: MediaInfo = { kind: supported.includes(kind as MediaInfo['kind']) ? kind as MediaInfo['kind'] : inferred, mimeType };
  for (const key of ['width', 'height', 'sampleRate', 'channels'] as const) if (typeof metadata[key] === 'number') media[key] = metadata[key];
  if (metadata.frameRate && typeof metadata.frameRate === 'object') media.frameRate = metadata.frameRate as MediaInfo['frameRate'] & {};
  if (typeof metadata.durationTicks === 'string') media.durationTicks = metadata.durationTicks;
  if (metadata.color && typeof metadata.color === 'object') media.color = metadata.color as MediaInfo['color'] & {};
  return media;
}
export async function runWorker(req: OperationRequest, worker: WorkerClient, assets: AssetStore, policy: ResourcePolicy): Promise<WorkerExecution> {
  const inputs: WorkerRequest['inputs'] = {};
  for (const [key, asset] of Object.entries(req.assets)) inputs[key] = { path: await assets.pathFor(asset), sha256: asset.sha256 };
  const outputDirectory = await assets.allocate(req.jobId, req.revisionId, `worker-${req.operationId}`); await mkdir(outputDirectory, { recursive: true });
  const options: Record<string, unknown> = { ...req.args };
  if (req.operation === 'media.frames') { options.times = (req.args.ticks as string[]).map(ticks => ({ ticks })); delete options.ticks; }
  if (req.operation === 'media.conform') { if (req.args.frameRate) options.fps = req.args.frameRate; if (req.args.sampleRate) options.audioSampleRate = req.args.sampleRate; if (!options.videoCodec) options.videoCodec = 'prores'; delete options.frameRate; delete options.sampleRate; }
  if (req.operation === 'media.transcribe') { options.wordTimestamps = true; if (req.args.providerId) options.modelId = req.args.providerId; }
  if (req.operation === 'audio.analyze') { if (req.args.thresholdDb !== undefined) options.silenceThresholdDb = req.args.thresholdDb; if (req.args.minimumSilenceMs !== undefined) options.minimumSilenceSeconds = Number(req.args.minimumSilenceMs) / 1000; }
  if (req.operation === 'audio.render') { if (req.args.integratedLufs !== undefined) options.targetLufs = req.args.integratedLufs; if (req.args.maxTruePeakDbtp !== undefined) options.truePeakDb = req.args.maxTruePeakDbtp; }
  if (req.operation === 'image.segment') {
    if (req.args.box) { const box = req.args.box as JsonObject; options.box = { left: box.x, top: box.y, right: Number(box.x) + Number(box.width), bottom: Number(box.y) + Number(box.height) }; }
    if (req.args.providerId) options.modelId = req.args.providerId;
  }
  if (req.operation === 'image.inpaint') { options.bounds = req.args.region; options.radius = req.args.radiusPx; options.method = req.args.method === 'navier-stokes' ? 'ns' : 'telea'; options.maxRepairFraction = 0.02; }
  if (req.operation === 'artifact.verify') {
    const output = req.args.output as JsonObject;
    options.output = output; options.width = output.width; options.height = output.height;
  }
  const remainingMs = Date.parse(req.executionDeadline) - Date.now(); requireCondition(remainingMs > 0, 'OPERATION_DEADLINE_EXCEEDED', 'Worker deadline has expired.');
  const raw = await worker.run({ workerRequestId: req.operationId, operation: req.operation as WorkerRequest['operation'], inputs, options, outputDirectory, limits: { maxCpuThreads: policy.maxCpuThreads, maxTemporaryBytes: policy.maxTemporaryBytes, maxOutputBytes: Number(BigInt(policy.maxTemporaryBytes) > 8_000_000n ? 8_000_000n : BigInt(policy.maxTemporaryBytes)), timeoutMs: remainingMs } });
  requireCondition(raw.workerRequestId === req.operationId && raw.operation === req.operation, 'WORKER_RESPONSE_MISMATCH', 'Worker response identity does not match the request.');
  if (!raw.ok) throw new WorkerResultError(raw.error?.code ?? (raw.cancelled ? 'WORKER_CANCELLED' : 'WORKER_FAILED'), raw.error?.message ?? 'Worker did not complete.');
  const recipeDigest = digest({ operation: req.operation, args: req.args, inputs: Object.values(req.assets).map(item => item.sha256), worker: worker.identity ? await worker.identity() : { unqualifiedExecution: req.operationId } });
  const artifacts: ArtifactReceipt[] = [];
  for (const produced of raw.artifacts) {
    const asset = await assets.registerGenerated(produced.path, mediaFor(produced.kind, produced.mimeType, produced.metadata));
    requireCondition(asset.sha256 === produced.sha256 && asset.sizeBytes === produced.sizeBytes, 'WORKER_ARTIFACT_HASH_MISMATCH', 'Worker artifact does not match its receipt.');
    requireCondition(path.resolve(produced.path).startsWith(path.resolve(outputDirectory) + path.sep), 'WORKER_OUTPUT_ESCAPE', 'Worker output is outside its job directory.');
    artifacts.push({ kind: 'artifact', asset, operationId: req.operationId, sourceAssets: Object.values(req.assets).map(item => item.assetId), recipeDigest, published: false, verification: [] });
  }
  const metadata = await assets.writeJson(req.jobId, req.revisionId, `${req.operationId}-worker-result.json`, raw.data);
  const metadataReceipt: ArtifactReceipt = { kind: 'artifact', asset: metadata, operationId: req.operationId, sourceAssets: Object.values(req.assets).map(item => item.assetId), recipeDigest, published: false, verification: [] };
  if (!artifacts.length) artifacts.push(metadataReceipt);
  const d = raw.data;
  if (req.operation === 'image.inpaint') { requireCondition(Number.isInteger(d.artifactIndex) && artifacts[Number(d.artifactIndex)], 'PATCH_ARTIFACT_MISSING', 'Inpaint worker did not identify its RGBA patch artifact.'); const patch = artifacts.splice(Number(d.artifactIndex), 1)[0]!; artifacts.unshift(patch); }
  const first = artifacts[0]!; const source = req.assets.source; let data: JsonObject;
  switch (req.operation) {
    case 'media.inspect': {
      requireCondition(typeof d.durationTicks === 'string' || source?.media.kind === 'image' || source?.media.kind === 'project', 'MEDIA_DURATION_UNAVAILABLE', 'Worker did not report a media duration.');
      data = { sourceAssetId: source!.assetId, durationTicks: typeof d.durationTicks === 'string' ? d.durationTicks : '0', hasVideo: d.hasVideo === true, hasAudio: d.hasAudio === true, metadataArtifactId: metadata.assetId };
      for (const key of ['width', 'height', 'frameRate', 'isVfr']) if (d[key] !== undefined && d[key] !== null) data[key] = json(d[key]);
      const audio = d.audio as Record<string, unknown> | undefined; for (const key of ['sampleRate', 'channels']) if (audio?.[key] !== undefined) data[key] = json(audio[key]);
      break;
    }
    case 'media.transcribe': data = { sourceAssetId: source!.assetId, language: String(d.language), clock: 'source', words: json(((d.words ?? []) as Record<string, unknown>[]).map(word => ({ word: String(word.word), range: range(String(word.startTicks), String(word.endTicks)), ...(typeof word.confidence === 'number' ? { confidence: word.confidence } : {}) }))), transcriptArtifactId: metadata.assetId }; break;
    case 'audio.analyze': data = { sourceAssetId: source!.assetId, durationTicks: String(d.durationTicks), silenceIntervals: json(((d.silenceIntervals ?? []) as { startTicks: string; endTicks: string }[]).map(item => range(item.startTicks, item.endTicks))), metadataArtifactId: metadata.assetId, ...(typeof d.integratedLufs === 'number' ? { integratedLufs: d.integratedLufs } : {}), ...(typeof d.maxTruePeakDbtp === 'number' ? { maxTruePeakDbtp: d.maxTruePeakDbtp } : {}) }; break;
    case 'audio.render': data = { sourceAssetIds: Object.values(req.assets).map(item => item.assetId), artifactId: first.asset.assetId, ...(typeof d.sampleRate === 'number' ? { sampleRate: d.sampleRate } : {}), ...(typeof d.channels === 'number' ? { channels: d.channels } : {}) }; break;
    case 'image.segment': {
      const masks = d.masks as { artifactIndex: number; score: number; pointPromptsSatisfied?: boolean }[]; requireCondition(Array.isArray(masks) && masks.length > 0, 'MASK_RESULT_MISSING', 'Segmenter returned no mask candidates.');
      const ordered = masks.filter(mask => mask.pointPromptsSatisfied === true).sort((a, z) => z.score - a.score); requireCondition(ordered.length > 0, 'MASK_PROMPTS_UNSATISFIED', 'No mask satisfies all point prompts.');
      const chosen = artifacts[ordered[0]!.artifactIndex]; requireCondition(chosen, 'MASK_ARTIFACT_MISSING', 'Segmenter mask index is invalid.');
      data = { sourceRasterSha256: String(d.sourceRasterSha256), sourceRegion: json(d.sourceRegion), width: Number(d.width), height: Number(d.height), maskArtifactId: chosen.asset.assetId, candidateScores: masks.map(item => item.score) };
      const at = artifacts.indexOf(chosen); artifacts.splice(at, 1); artifacts.unshift(chosen); break;
    }
    case 'image.inpaint': data = { sourceRasterSha256: String(d.sourceRasterSha256), sourceRegion: json(d.sourceRegion), width: Number(d.width), height: Number(d.height), patchArtifactId: first.asset.assetId, alphaRule: json(d.alphaRule), changesSourceAlpha: json(d.changesSourceAlpha) }; break;
    case 'media.frames': data = { sourceAssetId: source!.assetId, artifactIds: artifacts.map(item => item.asset.assetId), frames: json((d.frames as Record<string, unknown>[]).map(frame => ({ artifactId: artifacts[Number(frame.artifactIndex)]!.asset.assetId, requestedTicks: frame.requestedTicks, resolvedTicks: frame.resolvedTicks, width: frame.width, height: frame.height, ...(frame.statistics ? { statistics: frame.statistics } : {}) }))) }; break;
    case 'media.conform': data = { sourceAssetId: source!.assetId, artifactId: first.asset.assetId, ...(typeof d.timeMappingArtifactId === 'string' ? { timeMappingArtifactId: d.timeMappingArtifactId } : {}) }; break;
    case 'artifact.verify': {
      requireCondition(Array.isArray(d.checks) && typeof d.verified === 'boolean', 'VERIFY_RESULT_MISSING', 'Verifier must report explicit checks and a verified result.');
      requireCondition(d.verified === true && d.checks.length > 0 && (d.checks as { status?: string }[]).every(check => check.status === 'pass'), 'ARTIFACT_VERIFICATION_FAILED', 'One or more required artifact checks did not pass.');
      data = { assetId: source!.assetId, verified: d.verified, checks: json(d.checks) }; break;
    }
    default: throw new AutomationError('WORKER_RESULT_UNSUPPORTED', `No domain mapping for ${req.operation}.`);
  }
  const resource: ResourceOutput = { kind: 'single', resourceKind: 'artifact', item: { itemKey: 'artifact', value: artifacts[0]! } };
  const resources: Record<string, ResourceOutput> = { artifact: resource, artifacts: { kind: 'collection', resourceKind: 'artifact', complete: true, items: artifacts.map((value, index) => ({ itemKey: `artifact-${index}`, value })) } };
  const schemas: Record<string, string> = { 'media.transcribe': 'transcript.words.v1', 'audio.analyze': 'audio.analysis.v1', 'image.segment': 'image.mask.v1', 'image.inpaint': 'image.patch.v1', 'artifact.verify': 'artifact.verified.v1' };
  const evidence: EvidenceReceipt[] = [{ kind: req.operation === 'media.transcribe' ? 'transcript' : 'metadata', dataSchemaId: schemas[req.operation] ?? `${req.operation}.v1`, data, clock: req.operation.startsWith('image.') ? 'document' : 'source', complete: true, evidenceKey: `${req.stepKey}.data`, operationId: req.operationId, sourceAssetIds: Object.values(req.assets).map(item => item.assetId), snapshotDigest: digest(data), capturedAt: new Date().toISOString(), artifact: metadata }];
  if (req.operation === 'media.frames') for (const frame of d.frames as Record<string, unknown>[]) {
    const asset = artifacts[Number(frame.artifactIndex)]?.asset; const color = asset?.media.color;
    requireCondition(asset && color && Number(frame.width) > 0 && Number(frame.height) > 0 && Number(frame.sourceWidth) > 0 && Number(frame.sourceHeight) > 0, 'FRAME_EVIDENCE_INCOMPLETE', 'Actual source/raster dimensions and output color interpretation are required.');
    const width = Number(frame.width), height = Number(frame.height), sourceWidth = Number(frame.sourceWidth), sourceHeight = Number(frame.sourceHeight);
    evidence.push({ kind: 'frame', artifact: asset, evidenceKey: `${req.stepKey}.frame.${frame.artifactIndex}`, operationId: req.operationId, sourceAssetIds: [source!.assetId], snapshotDigest: asset.sha256, capturedAt: new Date().toISOString(), width, height, color, sourceBounds: { x: 0, y: 0, width: sourceWidth, height: sourceHeight }, evidenceToSource: [sourceWidth / width, 0, 0, sourceHeight / height, 0, 0], temporal: { requested: { ticks: String(frame.requestedTicks) }, resolved: { ticks: String(frame.resolvedTicks) }, isProxy: frame.isProxy === true } });
  }
  return { data, artifacts, resources, evidence, verification: [] };
}

export async function runSync(req: OperationRequest, worker: WorkerClient | undefined, assets: AssetStore, policy: ResourcePolicy, canDispatch: () => boolean = () => true): Promise<WorkerExecution> {
  const sync = req.args.sync as JsonObject; const referenceKey = String(sync.referenceInput); const reference = req.assets[referenceKey];
  requireCondition(reference, 'SYNC_REFERENCE_MISSING', 'Sync reference is missing.');
  const keys = req.args.inputKeys as string[]; const offsets: JsonObject[] = [];
  for (const key of keys) {
    requireCondition(canDispatch(), 'WORKFLOW_CANCELLED', 'Cancelled sync batches cannot dispatch another child.');
    const source = req.assets[key]; requireCondition(source, 'SYNC_INPUT_MISSING', `Missing sync input ${key}.`);
    if (key === referenceKey) { offsets.push({ inputKey: key, offsetTicks: '0', method: sync.primary === 'manual' ? 'manual' : sync.primary === 'timecode' ? 'timecode' : 'waveform' }); continue; }
    const manual = (): JsonObject => { const ticks = (sync.manualOffsetsTicks as JsonObject | undefined)?.[key]; requireCondition(typeof ticks === 'string', 'SYNC_OFFSET_MISSING', `Manual sync offset is missing for ${key}.`); return { inputKey: key, offsetTicks: ticks, method: 'manual' }; };
    if (sync.primary === 'manual') { offsets.push(manual()); continue; }
    const measure = async (method: 'timecode' | 'waveform'): Promise<JsonObject> => {
      requireCondition(canDispatch(), 'WORKFLOW_CANCELLED', 'Cancelled sync cannot dispatch a fallback worker.');
      requireCondition(worker, 'PROVIDER_NOT_CONFIGURED', 'Observed sync requires the local worker.');
      const outputDirectory = await assets.allocate(req.jobId, req.revisionId, `sync-${req.operationId}-${key}-${method}`); await mkdir(outputDirectory, { recursive: true });
      const result = await worker.run({ workerRequestId: `${req.operationId}-${key}-${method}`, operation: 'audio.sync', inputs: { source: { path: await assets.pathFor(source), sha256: source.sha256 }, reference: { path: await assets.pathFor(reference), sha256: reference.sha256 } }, options: { method }, outputDirectory, limits: { maxCpuThreads: policy.maxCpuThreads, maxTemporaryBytes: policy.maxTemporaryBytes, maxOutputBytes: 8_000_000, timeoutMs: Math.max(1, Date.parse(req.executionDeadline) - Date.now()) } });
      requireCondition(result.workerRequestId === `${req.operationId}-${key}-${method}` && result.operation === 'audio.sync', 'WORKER_RESPONSE_MISMATCH', 'Sync worker response identity does not match the dispatched child.');
      if (!result.ok) throw new WorkerResultError(result.error?.code ?? 'SYNC_FAILED', result.error?.message ?? 'Observed sync failed.');
      try {
      const d = result.data; requireCondition(typeof d.offsetTicks === 'string' && /^-?[0-9]+$/.test(d.offsetTicks), 'SYNC_RESULT_INCOMPLETE', 'Sync worker did not report an observed decimal offset.');
      await assets.writeJson(req.jobId, req.revisionId, `${req.operationId}-${key}-${method}-sync-evidence.json`, d);
      if (method === 'timecode') { requireCondition(d.method === 'timecode', 'SYNC_METHOD_MISMATCH', 'Timecode request returned another method.'); return { inputKey: key, offsetTicks: d.offsetTicks, method }; }
      const residual = typeof d.residualOffsetSamples === 'string' ? d.residualOffsetSamples : Number.isSafeInteger(d.residualOffsetSamples) ? String(d.residualOffsetSamples) : undefined;
      requireCondition(residual !== undefined && /^-?[0-9]+$/.test(residual) && typeof d.sampleRate === 'number' && d.sampleRate > 0, 'SYNC_RESULT_INCOMPLETE', 'Waveform sync requires an observed residual and sample rate.');
      const residualMs = Number(BigInt(residual) < 0n ? -BigInt(residual) : BigInt(residual)) * 1000 / d.sampleRate;
      requireCondition(residualMs <= Number(sync.maxResidualOffsetMs), 'SYNC_RESIDUAL_EXCEEDED', 'Observed synchronization residual exceeds the requested tolerance.');
      return { inputKey: key, offsetTicks: d.offsetTicks, residualOffsetSamples: residual, sampleRate: d.sampleRate, ...(typeof d.confidence === 'number' ? { confidence: d.confidence } : {}), method };
      } catch (error) { if (error instanceof AutomationError) throw new WorkerResultError(error.code, error.message); throw error; }
    };
    try { offsets.push(await measure(sync.primary === 'timecode' ? 'timecode' : 'waveform')); }
    catch (error) {
      requireCondition(canDispatch(), 'WORKFLOW_CANCELLED', 'Cancelled sync cannot apply fallback.');
      if (!(error instanceof WorkerResultError)) throw error;
      if (sync.fallback === 'manual') offsets.push(manual());
      else if (sync.primary === 'timecode' && sync.fallback === 'waveform') offsets.push(await measure('waveform'));
      else throw error;
    }
  }
  const artifact = await assets.writeJson(req.jobId, req.revisionId, `${req.operationId}-sync.json`, { referenceInput: referenceKey, offsets });
  const data: JsonObject = { referenceInput: referenceKey, offsets, mappingArtifactId: artifact.assetId };
  const receipt: ArtifactReceipt = { kind: 'artifact', asset: artifact, operationId: req.operationId, sourceAssets: Object.values(req.assets).map(value => value.assetId), recipeDigest: digest({ args: req.args, sourceHashes: Object.values(req.assets).map(value => value.sha256), worker: worker?.identity ? await worker.identity() : { unqualifiedExecution: req.operationId } }), published: false, verification: [] };
  return { data, artifacts: [receipt], resources: { artifact: { kind: 'single', resourceKind: 'artifact', item: { itemKey: 'artifact', value: receipt } } }, evidence: [{ kind: 'metadata', dataSchemaId: 'audio.sync.v1', data, clock: 'source', complete: true, evidenceKey: `${req.stepKey}.data`, operationId: req.operationId, sourceAssetIds: receipt.sourceAssets, snapshotDigest: digest(data), capturedAt: new Date().toISOString(), artifact }], verification: [] };
}
