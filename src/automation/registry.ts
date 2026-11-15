import type { AppId, PlanStep, ResourceSlotSpec, ResourceKind, OperationReceipt } from './contracts.js';
import { ContractValidator, objectSchema, stringSchema as str, rectSchema, rationalSchema, decimalSchema, parameterDefinitions, type Schema } from './validation.js';
import { requireCondition } from './errors.js';

export interface OperationSpec {
  id: string;
  route: 'host' | 'worker' | 'internal';
  app?: AppId;
  argsSchema: Schema;
  resultSchemaId: string;
  effect: 'read_only' | 'immutable_artifact' | 'mutable_host';
  resourceSlots: ResourceSlotSpec[];
  requiredAssets?: string[];
  targetKinds?: string[];
  capabilityId?: string;
}
const n = { type: 'number' }; const i = { type: 'integer', minimum: 1 }; const b = { type: 'boolean' };
const choice = (...values: string[]): Schema => ({ enum: values });
const array = (items: Schema, minItems = 0): Schema => ({ type: 'array', items, minItems, maxItems: 10000 });
const ref = (name: string): Schema => ({ $ref: `https://adobe-mcp.local/contracts/recipe-parameters.schema.json#/$defs/${name}` });
const output = { $ref: 'https://adobe-mcp.local/contracts/recipe-request.schema.json#/$defs/artifact' };
const tickRange = objectSchema({ start: objectSchema({ ticks: decimalSchema }), end: objectSchema({ ticks: decimalSchema }) });
const slot = (name: string, kind: ResourceKind, collection = false, minItems = 1): ResourceSlotSpec => ({ slot: name, resourceKind: kind, cardinality: collection ? 'collection' : 'single', minItems });

export class OperationRegistry {
  private readonly specs = new Map<string, OperationSpec>();
  constructor(public readonly validator = new ContractValidator()) { for (const spec of defaultOperations()) this.register(spec); }
  register(spec: OperationSpec): void {
    requireCondition(!this.specs.has(spec.id), 'DUPLICATE_OPERATION', `Operation ${spec.id} is already registered.`);
    this.validator.ajv.compile(spec.argsSchema); this.specs.set(spec.id, spec);
  }
  get(id: string): OperationSpec { const spec = this.specs.get(id); requireCondition(spec, 'UNKNOWN_OPERATION', `Unregistered operation: ${id}`); return spec; }
  list(): OperationSpec[] { return [...this.specs.values()]; }
  validateStep(step: PlanStep): void {
    const spec = this.get(step.operation); this.validator.validate(spec.argsSchema, step.args, 'OPERATION_ARGS_INVALID');
    requireCondition(step.effect.kind === spec.effect, 'OPERATION_EFFECT_MISMATCH', `Effect mismatch for ${spec.id}.`);
    for (const key of spec.requiredAssets ?? []) requireCondition(step.assets?.[key], 'OPERATION_ASSET_REQUIRED', `${spec.id} requires asset ${key}.`);
    if (spec.targetKinds?.length) requireCondition(step.target, 'OPERATION_TARGET_REQUIRED', `${spec.id} requires an exact target.`);
  }
  validateReceipt(id: string, receipt: OperationReceipt): void {
    const spec = this.get(id); this.validator.validateReceipt(receipt, spec.resultSchemaId);
    if (receipt.status !== 'SUCCEEDED') return;
    for (const expected of spec.resourceSlots) {
      const resource = receipt.resources[expected.slot];
      requireCondition(resource, 'RESULT_RESOURCE_MISSING', `Missing output slot ${expected.slot}.`);
      requireCondition(resource.resourceKind === expected.resourceKind && resource.kind === expected.cardinality, 'RESULT_RESOURCE_TYPE', `Wrong output type for ${expected.slot}.`);
      const count = resource.kind === 'single' ? 1 : resource.items.length;
      requireCondition(count >= expected.minItems && (expected.maxItems === undefined || count <= expected.maxItems), 'RESULT_RESOURCE_COUNT', `Invalid item count in ${expected.slot}.`);
    }
  }
}

function defaultOperations(): OperationSpec[] {
  const specs: OperationSpec[] = [];
  function add(id: string, props: Record<string, unknown>, required: string[], result: string, effect: OperationSpec['effect'], slots: ResourceSlotSpec[] = [], extra: Partial<OperationSpec> = {}): void {
    const app = id.startsWith('ps.') ? 'photoshop' : id.startsWith('pr.') && !id.startsWith('pr.cut') && !id.startsWith('pr.captions.build') ? 'premiere' : undefined;
    specs.push({ id, route: app ? 'host' : 'internal', ...(app ? { app } : {}), argsSchema: objectSchema(props, required), resultSchemaId: result, effect, resourceSlots: slots, ...extra });
  }
  const doc = [slot('document', 'document')]; const layer = [slot('layer', 'layer')]; const artifact = [slot('artifact', 'artifact')];
  const documentTarget = { targetKinds: ['ps_document', 'ps_layer'] };
  add('ps.document.open', { name: str }, [], 'ps.document_info.v1', 'mutable_host', doc, { requiredAssets: ['source'] });
  add('ps.document.create', { width: i, height: i, name: str, resolution: n, colorProfile: str, bitDepth: { enum: [8, 16, 32] }, sourceInfoStepKey: str, preserveSourceColor: b }, ['width', 'height'], 'ps.document_info.v1', 'mutable_host', doc);
  add('ps.document.duplicate', { name: str }, [], 'ps.document_info.v1', 'mutable_host', doc, documentTarget);
  add('ps.document.inspect', {}, [], 'query.inventory.v1', 'read_only', [slot('document', 'document'), slot('layers', 'layer', true, 0)], documentTarget);
  add('ps.document.resize', { width: i, height: i, fit: choice('contain', 'cover') }, ['width', 'height', 'fit'], 'ps.document_info.v1', 'mutable_host', doc, documentTarget);
  add('ps.document.convertProfile', { iccProfile: str }, ['iccProfile'], 'ps.document_info.v1', 'mutable_host', doc, documentTarget);
  add('ps.layer.create', { name: str }, ['name'], 'ps.layer_change.v1', 'mutable_host', layer, documentTarget);
  add('ps.layer.fill', { color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' }, name: str, placement: choice('back', 'front') }, ['color'], 'ps.layer_change.v1', 'mutable_host', layer, documentTarget);
  add('ps.layer.place', { name: str, box: rectSchema, fit: choice('contain', 'cover') }, ['box', 'fit'], 'ps.layer_change.v1', 'mutable_host', layer, { ...documentTarget, requiredAssets: ['source'] });
  add('ps.layer.transform', { x: n, y: n, widthPercent: { type: 'number', exclusiveMinimum: 0 }, heightPercent: { type: 'number', exclusiveMinimum: 0 }, angle: n }, [], 'ps.layer_change.v1', 'mutable_host', layer, { targetKinds: ['ps_layer'] });
  add('ps.layer.mask', { source: choice('input_mask', 'input_alpha', 'native_subject'), featherPx: { type: 'number', minimum: 0 }, contractPx: n }, ['source'], 'ps.layer_change.v1', 'mutable_host', layer, { targetKinds: ['ps_layer'] });
  const photoGeometry = objectSchema({ sourceInfoStepKey: str, placedStepKey: str });
  add('ps.layer.patch', { region: rectSchema, sourceRegion: rectSchema, photoGeometry, featherPx: { type: 'number', minimum: 0 }, opacityPercent: { type: 'number', minimum: 0, maximum: 100 } }, ['region'], 'ps.layer_change.v1', 'mutable_host', layer, documentTarget);
  add('ps.text.set', { text: { type: 'string' }, fontPostScriptName: str, sizePx: { type: 'number', exclusiveMinimum: 0 } }, ['text'], 'ps.layer_change.v1', 'mutable_host', layer, { targetKinds: ['ps_layer'] });
  add('ps.text.fit', { text: { type: 'string' }, box: rectSchema, font: ref('FontPolicy') }, ['text', 'box', 'font'], 'ps.layer_change.v1', 'mutable_host', layer, { targetKinds: ['ps_layer'] });
  const adjustmentVariants = (parameterDefinitions.PhotoAdjustment!.oneOf as Schema[]).map(branch => {
    const props = branch.properties as Record<string, Schema>;
    return objectSchema({ kind: props.kind!, values: objectSchema(Object.fromEntries(Object.entries(props).filter(([key]) => key !== 'kind' && key !== 'target')), ((branch.required as string[]) ?? []).filter(key => key !== 'kind' && key !== 'target')), name: str }, ['kind', 'values']);
  });
  specs.push({ id: 'ps.adjustment.create', app: 'photoshop', route: 'host', argsSchema: { oneOf: adjustmentVariants }, resultSchemaId: 'ps.layer_change.v1', effect: 'mutable_host', resourceSlots: layer, ...documentTarget });
  add('ps.smartobject.replace', {}, [], 'ps.layer_change.v1', 'mutable_host', layer, { targetKinds: ['ps_layer'], requiredAssets: ['source'] });
  add('ps.layer.replacePixels', { box: rectSchema, fit: choice('contain', 'cover') }, [], 'ps.layer_change.v1', 'mutable_host', layer, { targetKinds: ['ps_layer'], requiredAssets: ['source'] });
  add('ps.placeholder.replace', { fit: choice('contain', 'cover'), box: rectSchema, roleStepKey: str, role: str }, ['fit', 'roleStepKey', 'role'], 'ps.layer_change.v1', 'mutable_host', layer, { targetKinds: ['ps_layer'], requiredAssets: ['source'], capabilityId: 'ps.layer.replacePixels' });
  add('ps.artboard.create', { name: str, box: rectSchema }, ['name', 'box'], 'ps.layer_change.v1', 'mutable_host', layer, documentTarget);
  add('ps.artboard.duplicate', { name: str, box: rectSchema }, ['name', 'box'], 'ps.document_info.v1', 'mutable_host', [...doc, ...layer, slot('layers', 'layer', true)], { targetKinds: ['ps_layer'] });
  for (const id of ['ps.document.save', 'ps.document.export']) add(id, { output }, ['output'], 'export.completed.v1', 'immutable_artifact', artifact, documentTarget);
  add('ps.evidence.capture', { kind: choice('composite', 'layer', 'roi', 'mask'), region: rectSchema, maxEdge: { type: 'integer', minimum: 64, maximum: 2048 }, evidenceKey: str }, ['kind'], 'evidence.capture.v1', 'read_only', artifact, documentTarget);
  add('ps.raster.capture', { region: rectSchema, evidenceKey: str }, [], 'evidence.capture.v1', 'read_only', artifact, documentTarget);
  const project = [slot('project', 'project')]; const sequence = [slot('sequence', 'sequence')];
  add('pr.project.open', { name: str }, [], 'query.inventory.v1', 'mutable_host', project, { requiredAssets: ['source'] });
  add('pr.project.create', { name: str, presetId: str }, ['name'], 'query.inventory.v1', 'mutable_host', project);
  add('pr.project.save', { output }, ['output'], 'export.completed.v1', 'immutable_artifact', artifact, { targetKinds: ['pr_project', 'pr_sequence'] });
  add('pr.sequence.create', { name: str, width: i, height: i, frameRate: rationalSchema, presetId: str }, ['name', 'width', 'height', 'frameRate'], 'query.inventory.v1', 'mutable_host', sequence, { targetKinds: ['pr_project'] });
  add('pr.media.import', { items: array(objectSchema({ itemKey: str, inputKey: str })) }, ['items'], 'media.import.v1', 'mutable_host', [slot('items', 'project_item', true)], { targetKinds: ['pr_project', 'pr_sequence'] });
  add('pr.timeline.inspect', {}, [], 'query.inventory.v1', 'read_only', [slot('clips', 'clip', true, 0)], { targetKinds: ['pr_project', 'pr_sequence'] });
  const segment = objectSchema({ itemKey: str, projectItemId: str, sourceInTicks: decimalSchema, sourceOutTicks: decimalSchema, timelineStartTicks: decimalSchema, videoTrackIndex: { type: 'integer', minimum: -1 }, audioTrackIndex: { type: 'integer', minimum: -1 } });
  add('pr.timeline.edit', { segments: array(segment, 1), mode: choice('insert', 'overwrite') }, ['segments', 'mode'], 'pr.timeline_edit.v1', 'mutable_host', [slot('clips', 'clip', true)], { targetKinds: ['pr_sequence'] });
  add('pr.timeline.assemble', { cutMapStepKey: str, importStepKey: str, cameraInputs: array(str, 1), audioInput: str }, ['cutMapStepKey', 'importStepKey', 'cameraInputs', 'audioInput'], 'pr.timeline_edit.v1', 'mutable_host', [slot('clips', 'clip', true)], { targetKinds: ['pr_sequence'], capabilityId: 'pr.timeline.edit' });
  add('pr.clip.move', { timelineStartTicks: decimalSchema, trackIndex: { type: 'integer', minimum: 0 }, targetTrackRole: str, roleStepKey: str, collision: choice('reject', 'insert', 'overwrite'), linkedPolicy: choice('preserve', 'explicit_unlinked') }, ['timelineStartTicks', 'collision', 'linkedPolicy'], 'pr.timeline_edit.v1', 'mutable_host', [slot('clips', 'clip', true, 0)], { targetKinds: ['pr_clip'] });
  add('pr.clip.trim', { sourceInTicks: decimalSchema, sourceOutTicks: decimalSchema, anchor: choice('sequence_start', 'sequence_end'), linkedPolicy: choice('preserve', 'explicit_unlinked') }, ['anchor', 'linkedPolicy'], 'pr.timeline_edit.v1', 'mutable_host', [slot('clips', 'clip', true, 0)], { targetKinds: ['pr_clip'] });
  add('pr.clip.duration', { durationTicks: decimalSchema, linkedPolicy: choice('preserve', 'explicit_unlinked') }, ['durationTicks', 'linkedPolicy'], 'pr.timeline_edit.v1', 'mutable_host', [slot('clips', 'clip', true, 0)], { targetKinds: ['pr_clip'], capabilityId: 'pr.clip.trim' });
  add('pr.clip.remove', { ripple: b, linkedPolicy: choice('preserve', 'explicit_unlinked') }, ['ripple', 'linkedPolicy'], 'pr.timeline_edit.v1', 'mutable_host', [slot('clips', 'clip', true, 0)], { targetKinds: ['pr_clip'] });
  add('pr.clip.replaceSource', { preserveAnimation: b, preserveSourceRange: b, replacementScope: { const: 'selected_instance' } }, ['preserveAnimation', 'preserveSourceRange', 'replacementScope'], 'pr.timeline_edit.v1', 'mutable_host', [slot('clips', 'clip', true)], { targetKinds: ['pr_clip'], requiredAssets: ['source'] });
  add('pr.title.setText', { text: { type: 'string' }, preserveAnimation: b }, ['text', 'preserveAnimation'], 'pr.parameter_change.v1', 'mutable_host', [slot('clip', 'clip')], { targetKinds: ['pr_clip'] });
  add('pr.audio.gain', { db: { type: 'number', minimum: -96, maximum: 24 }, keyframes: array(objectSchema({ ticks: decimalSchema, db: { type: 'number', minimum: -96, maximum: 24 } })), encodingProfile: str }, ['db'], 'pr.parameter_change.v1', 'mutable_host', [slot('clip', 'clip')], { targetKinds: ['pr_clip'] });
  add('pr.effect.apply', { effect: { oneOf: ((parameterDefinitions.RevisionChange!.oneOf as Schema[]).find(branch => (branch.properties as Record<string, Schema>).kind?.const === 'effect_set')!.properties as Record<string, Schema>).effect!.oneOf }, existingEffectPolicy: choice('update_unique', 'create_if_absent') }, ['effect', 'existingEffectPolicy'], 'pr.parameter_change.v1', 'mutable_host', [slot('clip', 'clip')], { targetKinds: ['pr_clip'] });
  add('pr.motion.set', { property: choice('positionXNormalized', 'positionYNormalized', 'scalePercent', 'rotationDegrees', 'opacityPercent'), mode: choice('static', 'replace_keyframes'), value: n, keyframes: array(objectSchema({ ticks: decimalSchema, value: n, interpolation: choice('linear', 'hold') })) }, ['property', 'mode'], 'pr.parameter_change.v1', 'mutable_host', [slot('clip', 'clip')], { targetKinds: ['pr_clip'] });
  add('pr.transition.apply', { rightRole: str, transition: choice('cross_dissolve', 'dip_to_black', 'constant_power', 'constant_gain'), durationTicks: decimalSchema, insufficientHandles: choice('error', 'shorten') }, ['rightRole', 'transition', 'durationTicks', 'insufficientHandles'], 'pr.timeline_edit.v1', 'mutable_host', [slot('clips', 'clip', true)], { targetKinds: ['pr_clip'] });
  add('pr.captions.import', { cues: array(objectSchema({ id: str, startTicks: decimalSchema, endTicks: decimalSchema, text: { type: 'string' } })), stylePresetId: str, nativeEditable: b }, ['cues', 'stylePresetId', 'nativeEditable'], 'pr.captions.v1', 'mutable_host', [], { targetKinds: ['pr_sequence'] });
  add('pr.captions.apply', { captionsStepKey: str, stylePresetId: str, nativeEditable: b }, ['captionsStepKey', 'stylePresetId', 'nativeEditable'], 'pr.captions.v1', 'mutable_host', [], { targetKinds: ['pr_sequence'], capabilityId: 'pr.captions.import' });
  add('pr.export', { output }, ['output'], 'export.completed.v1', 'immutable_artifact', artifact, { targetKinds: ['pr_sequence'] });
  add('pr.frame.capture', { ticks: decimalSchema, maxEdge: { type: 'integer', minimum: 1, maximum: 4096 }, evidenceKey: str }, ['ticks'], 'evidence.capture.v1', 'read_only', artifact, { targetKinds: ['pr_sequence'] });
  add('workflow.roles.prepare', { owners: array(objectSchema({ inputKey: str, inspectStepKey: str }), 1), roles: array(objectSchema({ role: str, ownerInputKey: str, kind: choice('ps_layer', 'pr_sequence', 'pr_track', 'pr_clip'), layerKind: str }, ['role', 'ownerInputKey', 'kind']), 1), manifestInputKey: str }, ['owners', 'roles'], 'roles.manifest.v1', 'read_only', [slot('manifest', 'artifact')]);
  add('workflow.roles.bind', { observationId: str, bindings: array(objectSchema({ role: str, ownerInputKey: str, candidateKey: str }), 1) }, ['observationId', 'bindings'], 'roles.manifest.v1', 'immutable_artifact', [slot('manifest', 'artifact')]);
  const options = { route: 'worker' as const };
  add('media.inspect', {}, [], 'media.inspect.v1', 'read_only', artifact, { ...options, requiredAssets: ['source'] });
  add('media.transcribe', { language: str, providerId: str }, ['language'], 'transcript.words.v1', 'immutable_artifact', artifact, { ...options, requiredAssets: ['source'] });
  add('audio.sync', { sync: ref('Sync'), inputKeys: array(str, 2) }, ['sync', 'inputKeys'], 'audio.sync.v1', 'immutable_artifact', artifact, options);
  add('audio.analyze', { thresholdDb: n, minimumSilenceMs: n }, [], 'audio.analysis.v1', 'read_only', artifact, { ...options, requiredAssets: ['source'] });
  add('audio.render', { integratedLufs: n, maxTruePeakDbtp: n, gainDb: n, envelope: array(objectSchema({ ticks: decimalSchema, gainDb: n })), sampleRate: i, channels: i }, [], 'audio.render.v1', 'immutable_artifact', artifact, options);
  add('image.segment', { points: array(objectSchema({ x: n, y: n, label: { enum: [0, 1] } })), box: rectSchema, providerId: str, candidates: { enum: [1, 3] }, sourceRegion: rectSchema }, [], 'image.mask.v1', 'immutable_artifact', artifact, { ...options, requiredAssets: ['source'] });
  add('image.inpaint', { region: rectSchema, photoGeometry, method: choice('telea', 'navier-stokes'), radiusPx: { type: 'number', exclusiveMinimum: 0 }, providerId: str, featherPx: { type: 'number', minimum: 0 } }, ['region', 'method', 'radiusPx'], 'image.patch.v1', 'immutable_artifact', artifact, { ...options, requiredAssets: ['source'] });
  add('media.frames', { ticks: array(decimalSchema, 1), maxEdge: { type: 'integer', minimum: 16, maximum: 4096 }, statistics: b }, ['ticks'], 'media.frames.v1', 'immutable_artifact', [slot('artifacts', 'artifact', true)], { ...options, requiredAssets: ['source'] });
  const colorSettings = ref('pr.multicam_edit.v1/properties/colorMatch');
  add('pr.color.match', { settings: colorSettings, cameraInputs: array(str, 1), assemblyStepKey: str, syncStepKey: str }, ['settings', 'cameraInputs', 'assemblyStepKey', 'syncStepKey'], 'native.batch.v1', 'mutable_host', [slot('clips', 'clip', true, 0)], { route: 'internal', targetKinds: ['pr_sequence'], capabilityId: 'pr.effect.apply' });
  add('pr.audio.mix', { audioInput: str, assemblyStepKey: str, cutMapStepKey: str, analysisStepKey: str, transcriptStepKey: str, ducking: ref('Ducking'), integratedLufs: n, maxTruePeakDbtp: n }, ['audioInput', 'assemblyStepKey', 'cutMapStepKey', 'analysisStepKey'], 'native.batch.v1', 'mutable_host', [slot('clips', 'clip', true, 0)], { route: 'internal', targetKinds: ['pr_sequence'], capabilityId: 'pr.audio.gain' });
  add('media.conform', { frameRate: rationalSchema, pixelAspect: rationalSchema, sampleRate: i, width: i, height: i, outputFormat: choice('png', 'jpg', 'mp4', 'mov'), fit: choice('contain', 'cover', 'stretch'), burnSubtitles: b, pixelFormat: str, embedIcc: b, jpegQuality: { type: 'integer', minimum: 0, maximum: 12 }, videoCodec: choice('prores', 'h264') }, [], 'media.conform.v1', 'immutable_artifact', artifact, { ...options, requiredAssets: ['source'] });
  add('pr.cut_map.build', { recipeId: choice('pr.interview_captioned.v1', 'pr.multicam_edit.v1'), parameters: { oneOf: [ref('pr.interview_captioned.v1'), ref('pr.multicam_edit.v1')] }, syncStepKey: str, transcriptStepKey: str, analysisStepKey: str }, ['recipeId', 'parameters', 'syncStepKey'], 'pr.cut_map.v1', 'immutable_artifact', artifact, { route: 'internal' });
  add('pr.captions.build', { settings: ref('CaptionSettings'), transcriptStepKey: str, cutMapStepKey: str }, ['settings', 'cutMapStepKey'], 'pr.captions.v1', 'immutable_artifact', [slot('artifact', 'artifact')], { route: 'internal' });
  add('artifact.publish', { output }, ['output'], 'export.completed.v1', 'immutable_artifact', artifact, { requiredAssets: ['source'] });
  add('artifact.verify', { output }, ['output'], 'artifact.verified.v1', 'read_only', [], { ...options, requiredAssets: ['source'] });
  return specs;
}
