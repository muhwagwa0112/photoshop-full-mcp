import type { AssetRef, ControllerRequest, ControllerResponse, EditPlan, EvidenceReceipt, JsonObject, OperationReceipt, OperationRequest, PlanStep, RequirementSpec, ResourceItem, TargetRef, TickRange } from './contracts.js';
import type { WorkerExecution } from './worker.js';
import { requireCondition } from './errors.js';
import { resourceItems } from './materialization.js';
import { remapRange, TICKS_PER_SECOND, type CutSegment, type Word } from './timeline.js';
import { digest } from './canonical.js';
import { evaluateRequirements } from './controller.js';

export interface NativeBatchContext {
  request: OperationRequest; plan: EditPlan; inputs: Record<string, AssetRef>; receipts: Map<string, OperationReceipt>;
  execute(step: PlanStep): Promise<OperationReceipt>;
  ask(purpose: ControllerRequest['purpose'], context: unknown, requirements: RequirementSpec[], evidence: EvidenceReceipt[], operations: string[]): Promise<ControllerResponse>;
}
const clipItems = (receipt: OperationReceipt | undefined): ResourceItem[] => receipt ? resourceItems(receipt).filter(item => item.value.kind === 'pr_clip') : [];
function data(ctx: NativeBatchContext, key: string): JsonObject { const receipt = ctx.receipts.get(key); requireCondition(receipt?.dataState === 'complete', 'BATCH_INPUT_MISSING', `Batch input ${key} is incomplete.`); return receipt.data; }

export async function runNativeBatch(ctx: NativeBatchContext): Promise<WorkerExecution> {
  const { request: req, plan } = ctx; const parent = plan.steps.find(step => step.stepKey === req.stepKey);
  requireCondition(parent?.effect.kind === 'mutable_host', 'MATERIALIZATION_GROUP_REQUIRED', 'Native batch requires its owned group.');
  const operations: OperationReceipt[] = []; const results = new Map<string, ResourceItem>();
  const run = async (key: string, operation: string, args: JsonObject, target?: TargetRef, inputKey?: string): Promise<OperationReceipt> => {
    const immutable = operation === 'media.frames'; const readOnly = operation === 'pr.frame.capture';
    const step: PlanStep = { stepKey: `${req.stepKey}.${key}`, operation, args, dependsOn: [], effect: immutable ? { kind: 'immutable_artifact' } : readOnly ? { kind: 'read_only' } : parent.effect, assertions: [], failureStrategy: 'reconcile', ...(target ? { target: { kind: 'live', target } } : {}), ...(inputKey ? { assets: { source: { kind: 'input', inputKey } } } : {}) };
    const receipt = await ctx.execute(step); requireCondition(receipt.status === 'SUCCEEDED', ['OUTCOME_UNKNOWN', 'RUNNING', 'DISPATCH_INTENT', 'APPLIED_UNVERIFIED'].includes(receipt.status) ? 'NATIVE_BATCH_UNSETTLED' : 'NATIVE_BATCH_FAILED', `Native child ${step.stepKey} is ${receipt.status}.`);
    operations.push(receipt); for (const item of clipItems(receipt)) results.set(item.value.kind === 'pr_clip' ? item.value.clipKey : item.itemKey, item); return receipt;
  };
  const assembled = ctx.receipts.get(String(req.args.assemblyStepKey)); requireCondition(assembled?.status === 'SUCCEEDED', 'ASSEMBLY_REQUIRED', 'Batch requires observed assembled clip targets.');
  const clips = clipItems(assembled);
  if (req.operation === 'pr.audio.mix') {
    const audioKey = String(req.args.audioInput); const analysis = data(ctx, String(req.args.analysisStepKey));
    let gain = 0;
    if (typeof req.args.integratedLufs === 'number') { requireCondition(typeof analysis.integratedLufs === 'number', 'LOUDNESS_UNOBSERVED', 'A loudness target requires an actual finite measurement.'); gain = req.args.integratedLufs - analysis.integratedLufs; }
    if (typeof req.args.maxTruePeakDbtp === 'number') { requireCondition(typeof analysis.maxTruePeakDbtp === 'number', 'TRUE_PEAK_UNOBSERVED', 'A true-peak limit requires an actual measurement.'); gain = Math.min(gain, req.args.maxTruePeakDbtp - analysis.maxTruePeakDbtp); }
    requireCondition(gain >= -96 && gain <= 24, 'AUDIO_GAIN_UNSUPPORTED', 'The measured normalization needs gain outside the native profile range.');
    const voice = clips.filter(item => item.value.kind === 'pr_clip' && item.value.mediaType === 'audio' && item.value.sourceAssetId === ctx.inputs[audioKey]!.assetId);
    requireCondition(voice.length > 0, 'VOICE_CLIPS_MISSING', 'No exact imported voice clips were observed.');
    for (let i = 0; i < voice.length; i++) await run(`voice.${i}`, 'pr.audio.gain', { db: gain }, voice[i]!.value as TargetRef);
    if (req.args.ducking) {
      const settings = req.args.ducking as JsonObject; const transcript = data(ctx, String(req.args.transcriptStepKey));
      const cutMap = data(ctx, String(req.args.cutMapStepKey)); const segments = cutMap.segments as unknown as CutSegment[];
      const words = transcript.words as unknown as Word[]; requireCondition(Array.isArray(words), 'DUCKING_SPEECH_UNOBSERVED', 'Editable ducking needs actual mapped speech intervals.');
      const attack = BigInt(Number(settings.attackMs)) * TICKS_PER_SECOND / 1000n; const release = BigInt(Number(settings.releaseMs)) * TICKS_PER_SECOND / 1000n;
      const spans = words.flatMap(word => remapRange(word.range, segments, ctx.inputs[audioKey]!.assetId)).sort((a, b) => BigInt(a.start.ticks) < BigInt(b.start.ticks) ? -1 : 1);
      const merged: TickRange[] = [];
      for (const span of spans) { const last = merged.at(-1); if (last && BigInt(span.start.ticks) <= BigInt(last.end.ticks) + attack + release) { if (BigInt(span.end.ticks) > BigInt(last.end.ticks)) last.end = span.end; } else merged.push(structuredClone(span)); }
      const normal = Number(settings.musicGainDb), ducked = normal + Number(settings.speechDuckDb);
      requireCondition(normal >= -96 && normal <= 24 && ducked >= -96 && ducked <= 24, 'AUDIO_GAIN_UNSUPPORTED', 'Requested music envelope exceeds the native gain range.');
      const music = clips.filter(item => item.value.kind === 'pr_clip' && item.value.mediaType === 'audio' && item.value.sourceAssetId === ctx.inputs.music?.assetId);
      requireCondition(music.length > 0, 'MUSIC_CLIPS_MISSING', 'No exact music clip was observed.');
      for (let i = 0; i < music.length; i++) {
        const target = music[i]!.value; requireCondition(target.kind === 'pr_clip', 'MUSIC_TARGET_INVALID', 'Music target is not a clip.');
        const start = BigInt(target.timelineRange.start.ticks), end = BigInt(target.timelineRange.end.ticks); const knots = new Map<bigint, number>([[start, normal], [end - 1n, normal]]);
        const set = (ticks: bigint, db: number): void => { if (ticks >= start && ticks < end) knots.set(ticks, db); };
        for (const span of merged) {
          const from = BigInt(span.start.ticks), to = BigInt(span.end.ticks); if (to <= start || from >= end) continue;
          set(from - attack, normal); set(from > start ? from : start, ducked); set(to < end ? to : end - 1n, ducked); set(to + release, normal);
        }
        const keyframes = [...knots].sort(([a], [b]) => a < b ? -1 : 1).map(([ticks, db]) => ({ ticks: String(ticks), db }));
        await run(`music.${i}`, 'pr.audio.gain', { db: normal, keyframes }, target);
      }
    }
  } else {
    const settings = req.args.settings as JsonObject; const referenceKey = String(settings.referenceAngle);
    const sync = data(ctx, String(req.args.syncStepKey)); const offsets = new Map((sync.offsets as JsonObject[]).map(item => [String(item.inputKey), BigInt(String(item.offsetTicks))]));
    for (const angle of req.args.cameraInputs as string[]) {
      if (angle === referenceKey) continue;
      const targets = clips.filter(item => item.value.kind === 'pr_clip' && item.value.mediaType === 'video' && item.value.sourceAssetId === ctx.inputs[angle]!.assetId);
      if (!targets.length) continue;
      let effect: JsonObject | undefined = settings.method === 'manual_values' ? { name: 'lumetri_basic', ...((settings.manualByAngle as JsonObject)[angle] as JsonObject) } : undefined;
      requireCondition(settings.method !== 'manual_values' || (settings.manualByAngle as JsonObject)[angle], 'COLOR_VALUES_MISSING', `No explicit color values exist for ${angle}.`);
      const first = targets[0]!.value; requireCondition(first.kind === 'pr_clip', 'COLOR_TARGET_INVALID', 'Color target is not an observed clip.');
      const sourceTicks = (BigInt(first.sourceRange.start.ticks) + BigInt(first.sourceRange.end.ticks)) / 2n;
      const timelineTicks = BigInt(first.timelineRange.start.ticks) + sourceTicks - BigInt(first.sourceRange.start.ticks);
      let evidence: EvidenceReceipt[] = [];
      const requirement: RequirementSpec = { id: `color:${angle}`, description: `Match ${angle} to the observed ${referenceKey} frame using bounded Lumetri basic corrections. Statistics are encoded RGB8 measurements, not linear-light or calibrated colorimetry. Judge only supplied frames, and return uncertain if the sample cannot establish a useful match.`, importance: 'required', evaluator: 'semantic', assertionIds: [], evidenceKeys: [], passRule: { allAssertionsPass: true } };
      if (!effect) {
        requireCondition(offsets.has(angle) && offsets.has(referenceKey), 'COLOR_SYNC_MISSING', 'Color samples require observed synchronization offsets.');
        const referenceTicks = sourceTicks + offsets.get(angle)! - offsets.get(referenceKey)!;
        requireCondition(referenceTicks >= 0n, 'COLOR_REFERENCE_OUT_OF_RANGE', 'Synchronized reference sample is before the source.');
        const a = await run(`${angle}.sample`, 'media.frames', { ticks: [String(sourceTicks)], maxEdge: 1280, statistics: true }, undefined, angle);
        const b = await run(`${angle}.reference`, 'media.frames', { ticks: [String(referenceTicks)], maxEdge: 1280, statistics: true }, undefined, referenceKey);
        evidence = [...a.evidence, ...b.evidence]; requirement.evidenceKeys = evidence.map(item => item.evidenceKey);
      }
      const maximum = effect ? 0 : Math.min(2, plan.review.maxRepairs);
      let matched = Boolean(effect);
      for (let attempt = 0; attempt <= maximum; attempt++) {
        if (!effect) {
          const template: PlanStep = { stepKey: `${req.stepKey}.${angle}.proposed`, operation: 'pr.effect.apply', args: { effect: { name: 'lumetri_basic' }, existingEffectPolicy: 'update_unique' }, target: { kind: 'step_output', stepKey: String(req.args.assemblyStepKey), slot: 'clips', itemKey: targets[0]!.itemKey }, dependsOn: [String(req.args.assemblyStepKey)], effect: parent.effect, assertions: [], failureStrategy: 'reconcile' };
          const planRequirement: RequirementSpec = { ...requirement, description: `Propose one bounded Lumetri basic correction for ${angle}, supported by the supplied ${referenceKey} and current-angle frames. A pass means the correction is justified by these samples; actual matching is evaluated after applying it. Return uncertain if no supported correction can be determined.` };
          const response = await ctx.ask('plan', { task: 'camera-color-match', angle, referenceKey, attempt, targets: targets.map(item => item.value), proposalTemplate: template, evidenceScope: 'one synchronized sample per angle', allowedEffect: 'lumetri_basic' }, [planRequirement], evidence, ['pr.effect.apply']);
          requireCondition(evaluateRequirements([planRequirement], response.verdicts, [], new Set(evidence.map(item => item.evidenceKey))).every(item => item.verdict === 'pass'), 'COLOR_PLAN_UNCERTAIN', 'A color correction requires a supported pass citing the actual source and reference samples.');
          requireCondition(response.initialPlan?.steps.length === 1 && response.initialPlan.steps[0]?.operation === 'pr.effect.apply', 'COLOR_PLAN_UNCERTAIN', 'Color plan must propose one bounded basic Lumetri setting.');
          requireCondition(digest(response.initialPlan.steps[0]!.target) === digest(template.target), 'COLOR_PLAN_TARGET_CHANGED', 'Color provider cannot change the observed angle scope.');
          effect = response.initialPlan.steps[0]!.args.effect as JsonObject; requireCondition(effect?.name === 'lumetri_basic', 'COLOR_PLAN_UNSUPPORTED', 'Camera matching only permits Lumetri basic controls.');
        }
        for (let i = 0; i < targets.length; i++) await run(`${angle}.grade.${attempt}.${i}`, 'pr.effect.apply', { effect, existingEffectPolicy: 'update_unique' }, targets[i]!.value as TargetRef);
        if (settings.method === 'manual_values') break;
        requireCondition(req.target?.kind === 'pr_sequence', 'COLOR_SEQUENCE_REQUIRED', 'Color readback requires an exact sequence.');
        const after = await run(`${angle}.after.${attempt}`, 'pr.frame.capture', { ticks: String(timelineTicks), maxEdge: 1280, evidenceKey: `${req.stepKey}.${angle}.after.${attempt}` }, req.target);
        const reference = evidence.filter(item => item.evidenceKey.includes('.reference.')); evidence = [...reference, ...after.evidence]; requirement.evidenceKeys = evidence.map(item => item.evidenceKey);
        const review = await ctx.ask('review', { task: 'camera-color-match-review', angle, referenceKey, attempt, appliedEffect: effect, scope: 'supplied reference and resulting sequence frame only' }, [requirement], evidence, []);
        matched = evaluateRequirements([requirement], review.verdicts, after.verification, new Set(evidence.map(item => item.evidenceKey)))[0]?.verdict === 'pass'; if (matched) break; effect = undefined;
      }
      requireCondition(matched, 'COLOR_MATCH_UNCERTAIN', `The bounded observed color match for ${angle} did not pass.`);
    }
  }
  return { data: { operationIds: operations.map(item => item.operationId), kind: req.operation === 'pr.audio.mix' ? 'audio_mix' : 'color_match', complete: true }, artifacts: [], resources: { clips: { kind: 'collection', resourceKind: 'clip', complete: true, items: [...results.values()] } }, evidence: operations.flatMap(item => item.evidence), verification: operations.flatMap(item => item.verification) };
}
