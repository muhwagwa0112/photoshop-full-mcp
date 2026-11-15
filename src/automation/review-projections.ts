import type { ArtifactReceipt, ArtifactSpec, AssetBinding, AssetRef, EditPlan, EvidenceReceipt, Json, JsonObject, OperationReceipt, PlanStep, PrClipTarget, Rect, RequirementSpec, ResourceItem, TargetBinding, TargetRef, VerificationResult } from './contracts.js';
import { digest } from './canonical.js';
import { frameTicks } from './timeline.js';

export interface ReviewProjection {
  assertions: VerificationResult[];
  requirements: RequirementSpec[];
  evidenceBindings: Record<string, string[]>;
}
type Entry = { step: PlanStep; receipt: OperationReceipt | undefined };
type Check = { key: string; pass?: boolean; expected?: Json; actual?: Json; reason?: string };
const object = (value: unknown): JsonObject | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
const array = (value: unknown): Json[] => Array.isArray(value) ? value as Json[] : [];
const integer = (value: unknown): bigint | undefined => typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : undefined;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const equal = (a: unknown, b: unknown): boolean => a !== undefined && b !== undefined && digest(a) === digest(b);
const succeeded = (receipt: OperationReceipt | undefined): receipt is OperationReceipt & { dataState: 'complete'; data: JsonObject } => receipt?.status === 'SUCCEEDED' && receipt.dataState === 'complete';
const data = (entry: Entry | undefined, schema: string): JsonObject | undefined => succeeded(entry?.receipt) && entry.receipt.dataSchemaId === schema ? entry.receipt.data : undefined;
const items = (receipt: OperationReceipt | undefined): ResourceItem[] => succeeded(receipt) ? Object.values(receipt.resources).flatMap(slot => slot.kind === 'single' ? [slot.item] : slot.complete ? slot.items : []) : [];
const rect = (value: unknown): Rect | undefined => { const v = object(value); return v && [v.x, v.y, v.width, v.height].every(finite) && Number(v.width) >= 0 && Number(v.height) >= 0 ? v as unknown as Rect : undefined; };
const inside = (a: Rect, b: Rect): boolean => a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;
const tickRange = (value: unknown): { start: bigint; end: bigint } | undefined => {
  const v = object(value), start = integer(object(v?.start)?.ticks), end = integer(object(v?.end)?.ticks);
  return start !== undefined && end !== undefined && start < end ? { start, end } : undefined;
};
function aggregate(assertionId: string, checks: Check[], method: string): VerificationResult {
  const status = checks.some(check => check.pass === false) ? 'fail' : checks.length > 0 && checks.every(check => check.pass === true) ? 'pass' : 'not_run';
  return { assertionId, status, method, actual: checks.map(check => ({ key: check.key, status: check.pass === undefined ? 'not_run' : check.pass ? 'pass' : 'fail', ...(check.actual !== undefined ? { actual: check.actual } : {}), ...(check.expected !== undefined ? { expected: check.expected } : {}), ...(check.reason ? { reason: check.reason } : {}) })) };
}
function ownerKey(target: TargetRef): string {
  return digest({ host: target.host, workingAssetId: target.workingAssetId, ...(target.kind.startsWith('ps_') && 'documentId' in target ? { documentId: target.documentId } : 'projectGuid' in target ? { projectGuid: target.projectGuid } : {}) });
}
function sameClip(a: PrClipTarget, b: PrClipTarget): boolean {
  return ownerKey(a) === ownerKey(b) && a.sequenceGuid === b.sequenceGuid && (a.clipKey === b.clipKey || Boolean(a.cepNodeId && a.cepNodeId === b.cepNodeId) || Boolean(a.uxpHandleId && a.uxpHandleId === b.uxpHandleId));
}
function boundItem(binding: TargetBinding | AssetBinding | undefined, receipts: Map<string, OperationReceipt>): ResourceItem | undefined {
  if (binding?.kind !== 'step_output') return undefined;
  const receipt = receipts.get(binding.stepKey); if (!succeeded(receipt)) return undefined;
  const slot = receipt.resources[binding.slot];
  if (!slot) return undefined;
  if (slot.kind === 'single') return !binding.itemKey || slot.item.itemKey === binding.itemKey ? slot.item : undefined;
  if (!slot.complete || !binding.itemKey) return undefined;
  const matches = slot.items.filter(item => item.itemKey === binding.itemKey); return matches.length === 1 ? matches[0] : undefined;
}
function targetOf(step: PlanStep, receipts: Map<string, OperationReceipt>): TargetRef | undefined {
  if (step.target?.kind === 'live') return step.target.target;
  const value = boundItem(step.target, receipts)?.value; return value?.kind !== 'artifact' ? value : undefined;
}
function sourceOf(binding: AssetBinding | undefined, receipts: Map<string, OperationReceipt>, inputs: Record<string, AssetRef>): AssetRef | undefined {
  if (binding?.kind === 'input') return inputs[binding.inputKey];
  const value = boundItem(binding, receipts)?.value; return value?.kind === 'artifact' ? value.asset : undefined;
}
function observedLayer(entries: Entry[], target: TargetRef | undefined): ResourceItem | undefined {
  if (target?.kind !== 'ps_layer' || target.layerIds.length !== 1) return undefined;
  for (const entry of [...entries].reverse()) {
    const slot = succeeded(entry.receipt) ? entry.receipt.resources.layers : undefined;
    const doc = items(entry.receipt).find(item => item.value.kind === 'ps_document' && ownerKey(item.value) === ownerKey(target));
    if (!slot || slot.kind !== 'collection' || !slot.complete || !doc) continue;
    return slot.items.find(item => item.value.kind === 'ps_layer' && item.value.layerIds.length === 1 && item.value.layerIds[0] === target.layerIds[0]);
  }
  return undefined;
}
function documentBounds(entries: Entry[], target: TargetRef | undefined): Rect | undefined {
  if (!target) return undefined;
  for (const entry of [...entries].reverse()) {
    if (!succeeded(entry.receipt)) continue;
    const doc = items(entry.receipt).find(item => item.value.kind === 'ps_document' && ownerKey(item.value) === ownerKey(target));
    if (!doc) continue;
    if (entry.receipt.dataSchemaId === 'ps.document_info.v1' && finite(entry.receipt.data.width) && finite(entry.receipt.data.height)) return { x: 0, y: 0, width: entry.receipt.data.width, height: entry.receipt.data.height };
    const image = entry.receipt.evidence.find(evidence => evidence.kind === 'composite' && evidence.target?.kind === 'ps_document' && ownerKey(evidence.target) === ownerKey(target));
    if (image && 'sourceBounds' in image) return image.sourceBounds;
  }
  return undefined;
}
function nativeClips(entry: Entry | undefined): PrClipTarget[] | undefined {
  const receipt = entry?.receipt;
  if (!succeeded(receipt)) return undefined;
  const slot = receipt.resources.clips;
  if (!slot || slot.kind !== 'collection' || !slot.complete) return undefined;
  return slot.items.flatMap(item => item.value.kind === 'pr_clip' ? [item.value] : []);
}
function outputArtifact(entries: Entry[], spec: ArtifactSpec): { entry: Entry; artifact: ArtifactReceipt } | undefined {
  for (const entry of [...entries].reverse()) {
    const result = data(entry, 'export.completed.v1');
    if (!result || object(entry.step.args.output)?.outputKey !== spec.outputKey || !array(result.outputKeys).includes(spec.outputKey) || result.published !== true) continue;
    const ids = array(result.artifactIds);
    const matches = entry.receipt!.artifacts.filter(item => item.published && ids.includes(item.asset.assetId));
    const exact = items(entry.receipt).find(item => item.itemKey === spec.outputKey && item.value.kind === 'artifact');
    const artifact = exact?.value.kind === 'artifact' ? exact.value : matches.length === 1 ? matches[0] : undefined;
    const size = integer(artifact?.asset.sizeBytes);
    if (artifact && artifact.published && ids.includes(artifact.asset.assetId) && size !== undefined && size > 0n) return { entry, artifact };
  }
  return undefined;
}

/** The caller supplies only receipts valid for this revision's materialization.
 * Rebound checkpoint receipts may supply observed resources, never stale assertions
 * or images. This function neither invents evidence nor treats requested args as
 * observed host values. Step keys absent from this plan are deliberately ignored. */
export function buildReviewProjection(plan: EditPlan, receipts: Map<string, OperationReceipt>, inputs: Record<string, AssetRef>): ReviewProjection {
  const entries: Entry[] = plan.steps.map(step => ({ step, receipt: receipts.get(step.stepKey) }));
  const requested = [...new Set(plan.review.requirements.flatMap(requirement => requirement.assertionIds))];
  const original = entries.flatMap(entry => entry.receipt ? [...entry.receipt.verification, ...entry.receipt.artifacts.flatMap(artifact => artifact.verification)] : []);
  const evidence = entries.flatMap(entry => succeeded(entry.receipt) ? entry.receipt.evidence : []);
  const evidenceBindings: Record<string, string[]> = {};
  const unique = (values: string[]): string[] => [...new Set(values)];
  const visual = (item: EvidenceReceipt): boolean => 'width' in item && item.width > 0 && item.height > 0;
  const keys = (predicate: (item: EvidenceReceipt) => boolean): string[] => unique(evidence.filter(predicate).map(item => item.evidenceKey));
  const aliases: Record<string, () => string[]> = {
    'template.before': () => keys(item => visual(item) && /^variant\..+\.roles\.template\.visual$/.test(item.evidenceKey)),
    'product.variants.contact_sheet': () => keys(item => item.kind === 'composite' && /^variant\..+\.final$/.test(item.evidenceKey)),
    'product.mask.roi': () => keys(item => visual(item) && /^variant\..+\.mask\.result$/.test(item.evidenceKey)),
    'interview.broll.frames': () => keys(item => item.kind === 'frame' && /^interview\.broll\.frames\.\d+$/.test(item.evidenceKey)),
    'interview.transcript': () => keys(item => item.kind === 'transcript' && item.complete && item.dataSchemaId === 'transcript.words.v1' && (!inputs.voice || item.data.sourceAssetId === inputs.voice.assetId)),
    'multicam.angle_contact_sheet': () => keys(item => item.kind === 'frame' && /^multicam\.angle\.frames\.\d+$/.test(item.evidenceKey)),
    'title.before': () => keys(item => visual(item) && item.evidenceKey === 'project.roles.titleMaster.visual'),
    'title.after': () => keys(item => item.kind === 'composite' && item.evidenceKey === 'title.final'),
    'title.sequence_frame': () => keys(item => item.kind === 'frame' && item.evidenceKey === 'timeline.final'),
  };
  const expectedAliasKeys = (alias: string): string[] => {
    const ownerInput = alias === 'template.before' ? 'template' : alias === 'title.before' ? 'titleMaster' : undefined;
    if (ownerInput) return entries.filter(entry => entry.step.operation === 'workflow.roles.prepare' && array(entry.step.args.owners).some(owner => object(owner)?.inputKey === ownerInput)).map(entry => `${entry.step.stepKey}.${ownerInput}.visual`);
    const matches: Record<string, RegExp> = {
      'product.variants.contact_sheet': /^variant\..+\.final$/,
      'product.mask.roi': /^variant\..+\.mask\.result$/,
      'interview.broll.frames': /^interview\.broll\.frames\.\d+$/,
      'multicam.angle_contact_sheet': /^multicam\.angle\.frames\.\d+$/,
      'title.after': /^title\.final$/,
      'title.sequence_frame': /^timeline\.final$/,
    };
    const pattern = matches[alias];
    return pattern ? entries.flatMap(entry => typeof entry.step.args.evidenceKey === 'string' && pattern.test(entry.step.args.evidenceKey) ? [entry.step.args.evidenceKey] : []) : [];
  };
  const requirements = plan.review.requirements.map(requirement => {
    const expanded = requirement.evidenceKeys.flatMap(key => {
      const bound = aliases[key]?.() ?? keys(item => item.evidenceKey === key); evidenceBindings[key] = bound;
      // Retain an unresolved logical key so the evaluator cannot mistake an
      // empty expansion for a requirement needing no visual evidence.
      const incomplete = expectedAliasKeys(key).some(expected => !bound.includes(expected));
      return bound.length ? [...bound, ...(incomplete ? [key] : [])] : [key];
    });
    const separate = requirement.evidenceKeys.some(key => key === 'product.variants.contact_sheet' || key === 'multicam.angle_contact_sheet');
    const maskPreview = requirement.evidenceKeys.includes('product.mask.roi');
    return { ...requirement, assertionIds: [...requirement.assertionIds], evidenceKeys: unique(expanded), passRule: { ...requirement.passRule }, description: requirement.description + (separate ? ' Evidence is a group of separate captured images/frames, not a stitched contact sheet.' : '') + (maskPreview ? ' The mask result is a captured layer preview; it is not a mask-channel-only or cropped-ROI measurement.' : '') };
  });
  const finalInventory = [...entries].reverse().find(entry => entry.step.operation === 'pr.timeline.inspect');
  const clips = nativeClips(finalInventory);
  const cutEntry = entries.find(entry => entry.step.operation === 'pr.cut_map.build');
  const cut = data(cutEntry, 'pr.cut_map.v1');
  const segments = array(cut?.segments).map(object).filter((value): value is JsonObject => Boolean(value));
  const assembly = entries.find(entry => entry.step.operation === 'pr.timeline.assemble');
  const audioInput = typeof assembly?.step.args.audioInput === 'string' ? assembly.step.args.audioInput : undefined;
  const assemblyChecks = (): Check[] => !segments.length ? [] : segments.map(segment => {
    const source = Object.values(inputs).find(asset => asset.assetId === segment.sourceAssetId);
    const mediaType = segment.sourceAssetId === inputs[audioInput ?? '']?.assetId || segment.sourceAssetId === inputs.music?.assetId || source?.media.kind === 'audio' ? 'audio' : source?.media.kind === 'video' || source?.media.kind === 'image' ? 'video' : undefined;
    const matches = mediaType ? clips?.filter(clip => clip.mediaType === mediaType && clip.sourceAssetId === segment.sourceAssetId && equal(clip.sourceRange, segment.sourceRange) && equal(clip.timelineRange, segment.timelineRange)) : undefined;
    return { key: String(segment.segmentKey), ...(matches ? { pass: matches.length > 0 } : {}), expected: { sourceAssetId: segment.sourceAssetId!, sourceRange: segment.sourceRange!, timelineRange: segment.timelineRange!, ...(mediaType ? { mediaType } : {}) }, ...(matches ? { actual: matches.map(clip => clip.clipKey) } : { reason: 'Complete final native timeline inventory or the source media type is unavailable.' }) };
  });
  const hasAssembly = (): boolean => { const checks = assemblyChecks(); return checks.length > 0 && checks.every(check => check.pass === true); };
  const textEntries = entries.filter(entry => ['ps.text.set', 'ps.text.fit'].includes(entry.step.operation));
  const imageOutputs = plan.delivery.outputs.filter(spec => spec.encoding.kind === 'image');
  const nativeOutputs = plan.delivery.outputs.filter(spec => spec.encoding.kind === 'native_project');
  const transcriptEntry = entries.find(entry => entry.step.operation === 'media.transcribe');
  const transcript = data(transcriptEntry, 'transcript.words.v1');
  const observations = (entry: Entry): ResourceItem | undefined => observedLayer(entries, entry.receipt?.targetAfter ?? targetOf(entry.step, receipts));

  function project(id: string): VerificationResult {
    if (id === 'text.exact_content') return aggregate(id, textEntries.map(entry => {
      const actual = observations(entry)?.projection?.text;
      return { key: entry.step.stepKey, ...(typeof actual === 'string' && typeof entry.step.args.text === 'string' ? { pass: actual === entry.step.args.text, actual, expected: entry.step.args.text } : { reason: 'Final exact-layer text was not read back.' }) };
    }), 'Exact text in the latest complete native layer inventory; no text normalization.');
    if (id === 'text.no_overflow') return aggregate(id, textEntries.map(entry => {
      const observed = observations(entry), bounds = rect(observed?.projection?.bounds), box = rect(entry.step.args.box);
      const checked = entry.receipt?.verification.find(check => check.assertionId === 'text.renderedLineCount');
      const actual = object(checked?.actual), expected = object(checked?.expected);
      if (!bounds || !box || !actual || !finite(actual.lineCount) || typeof actual.overset !== 'boolean' || !finite(expected?.maximum) || !equal(observed?.projection?.text, entry.step.args.text)) return { key: entry.step.stepKey, reason: 'Rendered-line/overset readback and final exact-layer bounds are required; bounds alone do not prove paragraph fit.' };
      return { key: entry.step.stepKey, pass: checked!.status === 'pass' && actual.overset === false && actual.lineCount <= expected.maximum && inside(bounds, box), actual: { bounds: bounds as unknown as Json, ...actual }, expected: { box: box as unknown as Json, maximumLines: expected.maximum, overset: false } };
    }), 'Actual native rendered-line/overset observation plus final bounds inside the requested box.');
    if (id === 'roles.asset_bindings') return aggregate(id, entries.filter(entry => entry.step.operation === 'ps.placeholder.replace').map(entry => {
      const source = sourceOf(entry.step.assets?.source, receipts, inputs), actual = object(observations(entry)?.projection?.sourcePlacement);
      const roleTarget = targetOf(entry.step, receipts), after = entry.receipt?.targetAfter;
      const exact = roleTarget?.kind === 'ps_layer' && after?.kind === 'ps_layer' && ownerKey(roleTarget) === ownerKey(after) && equal(roleTarget.layerIds, after.layerIds);
      return { key: entry.step.stepKey, ...(source && actual && typeof actual.sourceSha256 === 'string' ? { pass: exact && actual.sourceSha256 === source.sha256 && (actual.sourceAssetId === undefined || actual.sourceAssetId === source.assetId), expected: { sha256: source.sha256, assetId: source.assetId }, actual } : { reason: 'The final bound layer lacks observed source-byte provenance.' }) };
    }), 'Exact role target and source-byte provenance retained in the final native layer projection.');
    if (id === 'product.bounds_inside_canvas') return aggregate(id, entries.filter(entry => entry.step.operation === 'ps.placeholder.replace' && entry.step.assets?.source?.kind === 'input' && entry.step.assets.source.inputKey === 'product').map(entry => {
      const target = entry.receipt?.targetAfter ?? targetOf(entry.step, receipts), placement = object(observations(entry)?.projection?.sourcePlacement), canvas = documentBounds(entries, target);
      const matrix = array(placement?.sourceToDocument), width = placement?.sourceWidth, height = placement?.sourceHeight;
      if (!canvas || !finite(width) || !finite(height) || width <= 0 || height <= 0 || matrix.length !== 6 || !matrix.every(finite)) return { key: entry.step.stepKey, reason: 'Actual source-to-document transform and current canvas bounds are required.' };
      const m = matrix as number[]; const points = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => ({ x: m[0]! * x! + m[2]! * y! + m[4]!, y: m[1]! * x! + m[3]! * y! + m[5]! }));
      const bounds = { x: Math.min(...points.map(p => p.x)), y: Math.min(...points.map(p => p.y)), width: Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)), height: Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)) };
      return { key: entry.step.stepKey, pass: inside(bounds, canvas), actual: bounds, expected: canvas as unknown as Json };
    }), 'All four full-source corners transformed by the observed placement affine; visible/clipped bounds alone are insufficient.');
    if (id === 'outputs.image_dimensions') return aggregate(id, imageOutputs.map(spec => {
      const output = outputArtifact(entries, spec), actual = output?.artifact.asset.media;
      return { key: spec.outputKey, ...(actual && finite(actual.width) && finite(actual.height) && finite(spec.width) && finite(spec.height) ? { pass: actual.width === spec.width && actual.height === spec.height, actual: { width: actual.width, height: actual.height }, expected: { width: spec.width, height: spec.height } } : { reason: 'Published output or explicit requested/observed dimensions are unavailable.' }) };
    }), 'Actual published artifact dimensions, matched by outputKey rather than output array position.');
    if (id === 'overlay.alpha') return aggregate(id, imageOutputs.filter(spec => spec.color?.alpha && spec.color.alpha !== 'none').map(spec => {
      const output = outputArtifact(entries, spec), alpha = output?.artifact.asset.media.color?.alpha;
      return { key: spec.outputKey, ...(alpha ? { pass: alpha === spec.color!.alpha, expected: spec.color!.alpha, actual: alpha } : { reason: 'Published output alpha metadata was not observed.' }) };
    }), 'Observed output-file alpha representation; does not assert that every pixel is transparent.');
    if (id === 'outputs.native_project' || id === 'outputs.srt') {
      const outputs = id === 'outputs.native_project' ? nativeOutputs : plan.delivery.outputs.filter(spec => spec.encoding.kind === 'subtitle' && spec.format.toLowerCase() === 'srt');
      return aggregate(id, outputs.map(spec => { const output = outputArtifact(entries, spec); return { key: spec.outputKey, ...(output ? { pass: output.artifact.asset.media.kind === (id === 'outputs.srt' ? 'subtitle' : 'project'), actual: { assetId: output.artifact.asset.assetId, sha256: output.artifact.asset.sha256, kind: output.artifact.asset.media.kind } } : { reason: 'A nonempty published artifact for this exact outputKey is absent.' }) }; }), 'Nonempty immutable published artifact receipt for each requested output; content structure is evaluated separately.');
    }
    if (id === 'native.layer_structure') return aggregate(id, nativeOutputs.filter(spec => ['psd', 'psb'].includes(spec.format.toLowerCase())).map(spec => {
      const output = outputArtifact(entries, spec), check = output?.artifact.verification.find(item => item.assertionId.endsWith('.export.layerCount'));
      const layers = output?.entry.receipt?.resources.layers;
      if (!check || !finite(check.actual) || !finite(check.expected) || !layers || layers.kind !== 'collection' || !layers.complete || !layers.items.every(item => typeof item.projection?.layerKind === 'string')) return { key: spec.outputKey, reason: 'Saved-file reopen layer count and a complete native layer inventory are required.' };
      return { key: spec.outputKey, pass: check.status === 'pass' && check.actual === check.expected && check.actual === layers.items.length && check.actual > 0, actual: { reopenedLayerCount: check.actual, layerKinds: layers.items.map(item => item.projection!.layerKind!) }, expected: { layerCount: check.expected } };
    }), 'Saved PSD/PSB reopened native layer count compared with the complete native layer inventory; does not prove pixel or style equality.');
    if (id === 'native.timeline_structure') return aggregate(id, assemblyChecks(), 'Complete final native clip inventory matched to every source/timeline range in the declared cut map; no rendered-replacement equivalence is inferred.');
    if (id === 'sync.residual_offset') {
      const syncEntry = entries.find(entry => entry.step.operation === 'audio.sync'), sync = data(syncEntry, 'audio.sync.v1');
      const limit = object(syncEntry?.step.args.sync)?.maxResidualOffsetMs, rows = array(sync?.offsets).map(object).filter((v): v is JsonObject => Boolean(v));
      const expectedKeys = array(syncEntry?.step.args.inputKeys).filter((key): key is string => typeof key === 'string' && key !== sync?.referenceInput);
      return aggregate(id, expectedKeys.map(key => {
        const candidates = rows.filter(row => row.inputKey === key), row = candidates.length === 1 ? candidates[0] : undefined, samples = integer(row?.residualOffsetSamples), rate = row?.sampleRate;
        if (!row || samples === undefined || !finite(rate) || rate <= 0 || !finite(limit)) return { key, reason: 'An observed residual/sample rate is required; manual or timecode offsets do not measure residual error.' };
        const ms = Number(samples < 0n ? -samples : samples) * 1000 / rate;
        return { key, ...(hasAssembly() ? { pass: Number.isFinite(ms) && ms <= limit } : {}), actual: { residualOffsetSamples: String(samples), sampleRate: rate, residualOffsetMs: ms }, expected: { maximumResidualMs: limit }, ...(!hasAssembly() ? { reason: 'Final native source/timeline placements have not been matched to the synchronized cut map.' } : {}) };
      }), 'Measured absolute waveform residual (samples × 1000 / sample rate), plus final native cut-map placement readback.');
    }
    if (id === 'cut_map.word_boundaries') {
      const words = array(transcript?.words).map(object).filter((v): v is JsonObject => Boolean(v));
      const spans = segments.filter(segment => segment.sourceAssetId === transcript?.sourceAssetId).map(segment => tickRange(segment.sourceRange));
      return aggregate(id, words.map((word, index) => {
        const time = tickRange(word.range);
        if (!time || !spans.length || spans.some(span => !span) || !hasAssembly()) return { key: `word:${index}`, reason: 'Observed words, complete source ranges and final native clip placement are required.' };
        const complete = spans.some(span => span!.start <= time.start && span!.end >= time.end);
        const split = spans.some(span => time.start < span!.start && span!.start < time.end || time.start < span!.end && span!.end < time.end);
        return { key: `word:${index}`, pass: complete && !split, actual: { word: word.word!, range: word.range! }, expected: { retainedWhole: true } };
      }), 'Every observed source-clock word is fully retained and no final source cut lies strictly inside its interval; transcript accuracy is outside this assertion.');
    }
    if (id === 'captions.cut_map_alignment') {
      const captionStep = entries.find(entry => entry.step.operation === 'pr.captions.build'), expected = data(captionStep, 'pr.captions.v1');
      const native = entries.filter(entry => ['pr.captions.apply', 'pr.captions.import'].includes(entry.step.operation));
      return aggregate(id, native.map(entry => {
        const actual = data(entry, 'pr.captions.v1');
        const cues = (value: Json | undefined): Json => array(value).map(cue => { const observed = object(cue); return { text: observed?.text ?? null, range: observed?.range ?? null }; });
        return { key: entry.step.stepKey, ...(expected && actual && hasAssembly() && actual.clock === 'timeline' && typeof actual.nativeTrackRole === 'string' ? { pass: equal(cues(actual.cues), cues(expected.cues)), expected: cues(expected.cues), actual: cues(actual.cues) } : { reason: 'Mapped captions plus actual native cue-text/range readback are required; created-track or sidecar-only success is insufficient.' }) };
      }), 'Actual timeline-clock native cue content/ranges compared with the produced cut-map captions.');
    }
    if (id === 'audio.final_loudness' || id === 'audio.true_peak') {
      const name = id === 'audio.final_loudness' ? 'audio.integratedLufs' : 'audio.maxTruePeakDbtp';
      return aggregate(id, plan.delivery.outputs.filter(spec => spec.encoding.kind === 'video' && (id === 'audio.final_loudness' ? spec.audio?.integratedLufs !== undefined : spec.audio?.maxTruePeakDbtp !== undefined)).map(spec => {
        const output = outputArtifact(entries, spec), expected = id === 'audio.final_loudness' ? spec.audio!.integratedLufs! : spec.audio!.maxTruePeakDbtp!;
        const verifications = output ? [...output.entry.receipt!.verification, ...output.artifact.verification] : [];
        const check = verifications.flatMap(item => { const actual = object(item.actual); return actual?.verified === true ? array(actual.checks).map(object).filter((v): v is JsonObject => Boolean(v)) : []; }).find(item => item.name === name && item.expected === expected);
        if (!check || !finite(check.actual)) return { key: spec.outputKey, reason: 'A final exported-file loudness/true-peak measurement for this exact target is absent; source analysis or requested gain is insufficient.' };
        const pass = check.status === 'pass' && (id === 'audio.final_loudness' ? Math.abs(check.actual - expected) <= 0.5 : check.actual <= expected + 0.1);
        return { key: spec.outputKey, pass, expected, actual: check.actual };
      }), 'Actual exported-file verifier measurements; integrated loudness tolerance 0.5 LU, true-peak ceiling tolerance 0.1 dBTP, matching the file verifier.');
    }
    if (id === 'multicam.angle_ranges') {
      const parameters = object(cutEntry?.step.args.parameters), rate = object(parameters?.frameRate), angles = array(parameters?.anglePlan).map(object).filter((v): v is JsonObject => Boolean(v));
      return aggregate(id, angles.map((angle, index) => {
        const source = inputs[String(angle.angle)];
        if (!source || !rate || !finite(rate.num) || !finite(rate.den) || integer(angle.fromFrame) === undefined || integer(angle.toFrame) === undefined || !clips) return { key: `angle:${index}`, reason: 'Exact angle source, rational frame rate and native final clip inventory are required.' };
        try {
          const expected = { start: { ticks: frameTicks(String(angle.fromFrame), { num: rate.num, den: rate.den }) }, end: { ticks: frameTicks(String(angle.toFrame), { num: rate.num, den: rate.den }) } };
          const matches = clips.filter(clip => clip.mediaType === 'video' && clip.sourceAssetId === source.assetId && equal(clip.timelineRange, expected));
          return { key: `angle:${index}`, pass: matches.length === 1, expected, actual: matches.map(clip => ({ clipKey: clip.clipKey, timelineRange: clip.timelineRange as unknown as Json })) };
        } catch { return { key: `angle:${index}`, reason: 'The declared frame range is not representable exactly in ticks.' }; }
      }), 'Exact source asset and observed video-clip timeline range at the declared rational frame rate.');
    }
    if (id === 'multicam.native_structure') {
      const parameters = object(cutEntry?.step.args.parameters), cameras = array(parameters?.cameraInputs).filter((v): v is string => typeof v === 'string');
      if (parameters?.nativeMulticamRequired !== false || parameters?.ordinaryEditableTrackFallbackAllowed !== true) return aggregate(id, [{ key: 'representation', reason: 'Native multicam structure was not observed; ordinary tracks cannot prove native multicam preservation.' }], 'Requires an explicit observed native multicam structure or the authorized ordinary editable-track representation.');
      const projectItems = entries.flatMap(entry => items(entry.receipt)).filter(item => item.value.kind === 'pr_project_item');
      return aggregate(id, cameras.map(key => {
        const source = inputs[key], imported = projectItems.some(item => item.value.kind === 'pr_project_item' && item.value.sourceAssetId === source?.assetId);
        const usedInCutMap = segments.some(segment => segment.sourceAssetId === source?.assetId);
        const observedTimelineClip = clips?.some(clip => clip.mediaType === 'video' && clip.sourceAssetId === source?.assetId) ?? false;
        return { key, ...(source && clips && hasAssembly() ? { pass: imported && (!usedInCutMap || observedTimelineClip), actual: { importedProjectItem: imported, usedInCutMap, observedTimelineClip, representation: 'ordinary_editable_tracks' }, expected: { sourceAssetId: source.assetId, importedProjectItem: true, timelineClipRequired: usedInCutMap, representation: 'ordinary_editable_tracks' } } : { reason: 'Native imported source items and final editable clip ranges are unavailable.' }) };
      }), 'Every original camera source is imported; cameras used in the cut map have observed editable clips matching the declared ranges. This is the authorized ordinary-track representation, not a native multicam-source object.');
    }
    if (id === 'title.timeline_range') {
      const move = entries.find(entry => entry.step.stepKey === 'title.place'), duration = entries.find(entry => entry.step.stepKey === 'title.duration'), target = move ? targetOf(move.step, receipts) : undefined;
      const start = integer(move?.step.args.timelineStartTicks), length = integer(duration?.step.args.durationTicks);
      const matches = target?.kind === 'pr_clip' ? clips?.filter(clip => sameClip(clip, target)) : undefined;
      if (start === undefined || length === undefined || length <= 0 || !matches) return aggregate(id, [{ key: 'title', reason: 'Exact planned title binding and final native placement readback are required.' }], 'Final exact title clip timeline start/end in integer ticks.');
      const expected = { start: { ticks: String(start) }, end: { ticks: String(start + length) } };
      return aggregate(id, [{ key: 'title', pass: matches.length === 1 && equal(matches[0]!.timelineRange, expected), expected, actual: matches.map(clip => clip.timelineRange as unknown as Json) }], 'Final exact title clip timeline start/end in integer ticks.');
    }
    if (id === 'timeline.protected_state') {
      const beforeEntry = entries.find(entry => entry.step.operation === 'pr.timeline.inspect' && entry !== finalInventory), before = nativeClips(beforeEntry);
      const changed = entries.filter(entry => entry.step.operation.startsWith('pr.clip.') && entry.step.effect.kind === 'mutable_host').map(entry => targetOf(entry.step, receipts));
      if (!before || !clips || changed.some(target => target?.kind !== 'pr_clip')) return aggregate(id, [{ key: 'protected', reason: 'Complete before/after inventory and every exact planned changed target are required.' }], 'Observed protected native clip state; excludes only exact planned target clips.');
      const scope = finalInventory ? targetOf(finalInventory.step, receipts) ?? finalInventory.receipt?.targetAfter ?? finalInventory.receipt?.targetBefore : undefined;
      const sequenceIds = new Set(scope && 'sequenceGuid' in scope ? [scope.sequenceGuid] : items(finalInventory?.receipt).flatMap(item => item.value.kind === 'pr_sequence' ? [item.value.sequenceGuid] : []));
      if (!sequenceIds.size) for (const clip of clips) sequenceIds.add(clip.sequenceGuid);
      if (!sequenceIds.size && scope?.kind !== 'pr_project') return aggregate(id, [{ key: 'protected', reason: 'The empty final inventory lacks an observed exact sequence/project scope.' }], 'An empty result is not proof that no protected clips existed.');
      const protectedBefore = before.filter(clip => (scope?.kind === 'pr_project' ? ownerKey(clip) === ownerKey(scope) : sequenceIds.has(clip.sequenceGuid)) && !changed.some(target => target?.kind === 'pr_clip' && sameClip(clip, target)));
      const protectedAfter = clips.filter(clip => !changed.some(target => target?.kind === 'pr_clip' && sameClip(clip, target)));
      const project = (clip: PrClipTarget, entry: Entry | undefined): JsonObject => {
        const observed = items(entry?.receipt).find(item => item.value.kind === 'pr_clip' && sameClip(item.value, clip));
        return { sourceAssetId: clip.sourceAssetId, sourceRange: clip.sourceRange as unknown as Json, timelineRange: clip.timelineRange as unknown as Json, mediaType: clip.mediaType, trackIndex: clip.trackIndex, ...(observed?.projection ? { observed: observed.projection } : {}) };
      };
      const checks: Check[] = protectedBefore.map(clip => { const matches = protectedAfter.filter(after => sameClip(clip, after)); return { key: clip.clipKey, pass: matches.length === 1 && equal(project(clip, beforeEntry), project(matches[0]!, finalInventory)), expected: project(clip, beforeEntry), actual: matches.map(after => project(after, finalInventory)) }; });
      checks.push({ key: 'protected_inventory_count', pass: protectedBefore.length === protectedAfter.length, expected: protectedBefore.length, actual: protectedAfter.length });
      return aggregate(id, checks, 'Actual source/range/track and available native inventory projections before/after; animation/component internals are evaluated separately.');
    }
    return aggregate(id, [{ key: id, reason: id === 'title.motion_unchanged' ? 'Exact effect/keyframe before-and-after readback is absent.' : id === 'audio.duck_envelope' ? 'Actual native keyframe times and values must be verified by the audio batch.' : 'No registered receipt projection establishes this assertion.' }], 'No inferred pass from a completed dispatch, requested value, filename or preview.');
  }

  const assertions = requested.map(id => {
    const existing = original.filter(check => check.assertionId === id);
    // Existing concrete failures/non-observations must not be overwritten by a
    // weaker aggregate projection. Return the actual result unchanged.
    const authoritative = existing.find(check => check.status === 'fail') ?? existing.find(check => check.status === 'not_run') ?? existing[0];
    return authoritative ?? project(id);
  });
  return { assertions, requirements, evidenceBindings };
}
