import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import recipeRequestSchema from './recipe-request.schema.json' with { type: 'json' };
import recipeParameterSchema from './recipe-parameters.schema.json' with { type: 'json' };
import operationResultSchema from './operation-results.schema.json' with { type: 'json' };
import type { OperationReceipt, RecipeRequest, JsonObject, PlanStep } from './contracts.js';
import { AutomationError, requireCondition } from './errors.js';
import { digest } from './canonical.js';
import { validateResourceOutput } from './bindings.js';
import { receiptSchema } from './wire-schemas.js';

export type Schema = Record<string, unknown>;
export const objectSchema = (properties: Record<string, unknown>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
export const stringSchema: Schema = { type: 'string', minLength: 1 };
export const decimalSchema: Schema = { type: 'string', pattern: '^-?(0|[1-9][0-9]*)$' };
export const rectSchema = objectSchema({ x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } });
export const rationalSchema = objectSchema({ num: { type: 'integer', minimum: 1 }, den: { type: 'integer', minimum: 1 } });
export const locatorSchema = objectSchema({ rootId: stringSchema, relativePath: stringSchema });
const parameterId = 'https://adobe-mcp.local/contracts/recipe-parameters.schema.json';
export const requestSchema = recipeRequestSchema as Schema;
export const parameterDefinitions = recipeParameterSchema.$defs as Record<string, Schema>;
export const resultDefinitions = operationResultSchema.$defs as Record<string, Schema>;
export const recipeIds = Object.keys(parameterDefinitions).filter(key => /^(ps|pr|cross)\..*\.v1$/.test(key));

export class ContractValidator {
  readonly ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false, allowUnionTypes: true, useDefaults: false, coerceTypes: false, removeAdditional: false });
  private readonly requestValidator: ValidateFunction;
  private readonly resultValidators = new Map<string, ValidateFunction>();
  constructor() {
    this.ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    this.ajv.addFormat('date-time', { type: 'string', validate: (value: string) => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) });
    this.ajv.addSchema({ ...recipeParameterSchema, $id: parameterId });
    this.ajv.addSchema(operationResultSchema);
    this.requestValidator = this.ajv.compile(recipeRequestSchema);
  }
  validate(schema: Schema, value: unknown, code = 'SCHEMA_VALIDATION_FAILED'): void {
    const validator = this.ajv.compile(schema);
    if (!validator(value)) throw new AutomationError(code, this.ajv.errorsText(validator.errors, { separator: '; ' }), validator.errors);
  }
  validateParameters(recipeId: string, value: unknown): void {
    requireCondition(recipeIds.includes(recipeId), 'UNKNOWN_RECIPE', `Unknown recipe: ${recipeId}`);
    this.validate({ $ref: `${parameterId}#/$defs/${recipeId}` }, value, 'RECIPE_PARAMETERS_INVALID');
  }
  normalizeRequest(input: unknown): RecipeRequest {
    if (!this.requestValidator(input)) throw new AutomationError('RECIPE_REQUEST_INVALID', this.ajv.errorsText(this.requestValidator.errors, { separator: '; ' }), this.requestValidator.errors);
    const request = structuredClone(input) as RecipeRequest;
    request.parameters = this.applyDefaults(parameterDefinitions[request.recipeId]!, request.parameters) as JsonObject;
    this.validateParameters(request.recipeId, request.parameters);
    if (!this.requestValidator(request)) throw new AutomationError('RECIPE_REQUEST_INVALID', this.ajv.errorsText(this.requestValidator.errors));
    validateRecipeSemantics(request);
    return request;
  }
  private applyDefaults(schema: Schema, value: unknown): unknown {
    if (value === undefined && schema.default !== undefined) value = structuredClone(schema.default);
    if (typeof schema.$ref === 'string') {
      const name = schema.$ref.split('/').at(-1)!;
      const target = parameterDefinitions[name];
      if (target) {
        value = this.applyDefaults(target, value);
        if (value !== undefined && name === 'NormalizedRect') { const box = value as { x: number; y: number; width: number; height: number }; requireCondition(box.x + box.width <= 1 && box.y + box.height <= 1, 'NORMALIZED_RECT_OUT_OF_BOUNDS', 'Normalized rectangle must lie entirely inside [0,1].'); }
        if (value !== undefined && name === 'FrameRate') normalizeFrameRate(value as { num: number; den: number });
        if (typeof value === 'string' && ['DecimalFrame', 'PositiveFrame'].includes(name)) requireCondition(BigInt(value) <= 9223372036854775807n, 'FRAME_OUT_OF_RANGE', 'Frame value exceeds the declared signed 64-bit profile.');
        if (name === 'SignedTicks') requireCondition(value !== '-0', 'NEGATIVE_ZERO_TICKS', 'Signed tick offsets cannot use negative zero.');
        return value;
      }
    }
    if (value === undefined) return undefined;
    if (Array.isArray(schema.oneOf)) {
      const choices = (schema.oneOf as Schema[]).filter(branch => this.ajv.compile({ ...branch, $defs: parameterDefinitions })(value));
      if (choices.length === 1) value = this.applyDefaults(choices[0]!, value);
    }
    if (Array.isArray(value) && schema.items && typeof schema.items === 'object') return value.map(item => this.applyDefaults(schema.items as Schema, item));
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const result = value as Record<string, unknown>;
      for (const [key, child] of Object.entries((schema.properties as Record<string, Schema> | undefined) ?? {})) {
        const normalized = this.applyDefaults(child, result[key]); if (normalized !== undefined) result[key] = normalized;
      }
      for (const [pattern, child] of Object.entries((schema.patternProperties as Record<string, Schema> | undefined) ?? {})) for (const key of Object.keys(result)) if (new RegExp(pattern).test(key)) result[key] = this.applyDefaults(child, result[key]);
      for (const clause of (schema.allOf as Schema[] | undefined) ?? []) {
        if (clause.if) {
          const matches = this.ajv.compile({ ...(clause.if as Schema), $defs: parameterDefinitions })(result);
          const branch = matches ? clause.then : clause.else; if (branch) this.applyDefaults(branch as Schema, result);
        } else this.applyDefaults(clause, result);
      }
    }
    return value;
  }
  validateResult(schemaId: string, data: unknown): void {
    let validator = this.resultValidators.get(schemaId);
    if (!validator) {
      requireCondition(resultDefinitions[schemaId], 'UNREGISTERED_RESULT_SCHEMA', `Unknown result schema: ${schemaId}`);
      validator = this.ajv.compile({ $ref: `${operationResultSchema.$id}#/$defs/${schemaId}` }); this.resultValidators.set(schemaId, validator);
    }
    if (!validator(data)) throw new AutomationError('OPERATION_RESULT_INVALID', this.ajv.errorsText(validator.errors, { separator: '; ' }), validator.errors);
  }
  validateReceipt(receipt: OperationReceipt, expectedSchemaId: string): void {
    this.validate(receiptSchema, receipt, 'OPERATION_RECEIPT_INVALID');
    requireCondition(receipt && typeof receipt === 'object', 'OPERATION_RECEIPT_INVALID', 'Missing operation receipt.');
    requireCondition(typeof receipt.operationId === 'string' && /^[0-9a-f]{64}$/.test(receipt.requestDigest), 'OPERATION_RECEIPT_INVALID', 'Invalid receipt identity.');
    const statuses = ['QUEUED', 'PREPARED', 'DISPATCH_INTENT', 'RUNNING', 'APPLIED_UNVERIFIED', 'SUCCEEDED', 'FAILED_NO_EFFECT', 'FAILED_WITH_EFFECT', 'OUTCOME_UNKNOWN', 'CANCEL_REQUESTED', 'CANCELLED_NO_EFFECT', 'CANCELLED_WITH_EFFECT'];
    requireCondition(statuses.includes(receipt.status), 'OPERATION_RECEIPT_INVALID', 'Unknown operation status.');
    requireCondition(receipt.status !== 'SUCCEEDED' || receipt.dataState === 'complete', 'OPERATION_RESULT_INCOMPLETE', 'SUCCEEDED requires complete domain data.');
    if (receipt.dataState === 'complete') {
      requireCondition(receipt.dataSchemaId === expectedSchemaId, 'RESULT_SCHEMA_MISMATCH', 'Operation returned a different domain schema.');
      this.validateResult(receipt.dataSchemaId, receipt.data);
    } else if (receipt.dataState === 'partial') {
      requireCondition(receipt.dataSchemaId === 'partial.operation.v1' && receipt.missingResultFields.length > 0, 'PARTIAL_SCHEMA_UNREGISTERED', 'Partial data requires the registered partial schema and missing fields.');
      this.validateResult(receipt.dataSchemaId, receipt.data);
    } else {
      requireCondition(receipt.dataState === 'unavailable' && receipt.data === null && receipt.dataSchemaId === null && ['not_started', 'not_observed', 'not_produced'].includes(receipt.dataReason), 'OPERATION_RESULT_INVALID', 'Invalid unavailable result payload.');
    }
    requireCondition(Array.isArray(receipt.verification) && Array.isArray(receipt.evidence) && Array.isArray(receipt.artifacts), 'OPERATION_RECEIPT_INVALID', 'Receipt collections are required.');
    for (const output of Object.values(receipt.resources)) {
      validateResourceOutput(output);
      for (const item of output.kind === 'single' ? [output.item] : output.items) {
        if (item.projection) requireCondition(item.projectionVersion === 1 && item.structuralFingerprint === digest(item.projection), 'RESOURCE_PROJECTION_INVALID', 'Resource projection does not match its fingerprint.');
      }
    }
    for (const evidence of receipt.evidence) if ('dataSchemaId' in evidence) this.validateResult(evidence.dataSchemaId, evidence.data);
    if (receipt.recovery.afterState) requireCondition(receipt.recovery.afterState.digest === digest(receipt.recovery.afterState.fields), 'NATIVE_STATE_DIGEST_MISMATCH', 'Native post-state fields do not match their digest.');
    if (receipt.status === 'SUCCEEDED') requireCondition(receipt.verification.every(result => result.status === 'pass'), 'POSTCONDITION_FAILED', 'A successful operation cannot contain failing/unobserved assertions.');
  }
}

function walk(value: unknown, visit: (object: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) value.forEach(item => walk(item, visit));
  else if (value && typeof value === 'object') { visit(value as Record<string, unknown>); Object.values(value).forEach(item => walk(item, visit)); }
}
export function normalizeFrameRate(rate: { num: number; den: number }): void {
  requireCondition(Number.isSafeInteger(rate.num) && Number.isSafeInteger(rate.den) && rate.num > 0 && rate.den > 0 && rate.num >= rate.den && rate.num <= rate.den * 240, 'FRAME_RATE_OUT_OF_RANGE', 'Recipe frame rates must be positive rational values from 1 through 240 fps.');
  let a = rate.num, b = rate.den; while (b) { const remainder = a % b; a = b; b = remainder; } rate.num /= a; rate.den /= a;
}
export function validateRecipeSemantics(request: RecipeRequest): void {
  if (request.controller.mode === 'client_agent') requireCondition(request.controller.modelBudget.enforcement === 'client_reported', 'MODEL_BUDGET_ENFORCEMENT_UNAVAILABLE', 'An external MCP agent must report its own usage; owner-enforced model inference requires configured_provider mode.');
  const p = request.parameters as Record<string, unknown>;
  walk(p, obj => {
    if (typeof obj.inputKey === 'string') requireCondition(request.inputs[obj.inputKey], 'RECIPE_INPUT_MISSING', `Missing input ${obj.inputKey}.`);
    if (typeof obj.minimumSizePx === 'number' && typeof obj.maximumSizePx === 'number') requireCondition(obj.minimumSizePx <= obj.maximumSizePx, 'INVALID_FONT_RANGE', 'Minimum font size exceeds maximum.');
    if (typeof obj.minimumDurationMs === 'number' && typeof obj.maximumDurationMs === 'number') requireCondition(obj.minimumDurationMs <= obj.maximumDurationMs, 'INVALID_CAPTION_DURATION', 'Minimum cue duration exceeds maximum.');
    if (typeof obj.fromFrame === 'string' && typeof obj.toFrame === 'string') requireCondition(BigInt(obj.fromFrame) < BigInt(obj.toFrame), 'INVALID_FRAME_RANGE', 'Frame intervals must be nonempty and half-open.');
    if (typeof obj.sourceInTicks === 'string' && typeof obj.sourceOutTicks === 'string') requireCondition(BigInt(obj.sourceInTicks) < BigInt(obj.sourceOutTicks), 'INVALID_SOURCE_RANGE', 'Source in must be before source out.');
    if (typeof obj.inputBlack === 'number' && typeof obj.inputWhite === 'number') requireCondition(obj.inputBlack < obj.inputWhite, 'INVALID_LEVELS', 'Levels input black must be below input white.');
    if (typeof obj.outputBlack === 'number' && typeof obj.outputWhite === 'number') requireCondition(obj.outputBlack < obj.outputWhite, 'INVALID_LEVELS', 'Levels output black must be below output white.');
    if (obj.primary && obj.fallback && obj.fallback !== 'none') requireCondition(obj.primary !== obj.fallback, 'INVALID_SYNC_FALLBACK', 'Sync fallback must differ from its primary.');
    if (obj.enabled === true && typeof obj.minimumSilenceMs === 'number') requireCondition(Number(obj.keepHeadMs ?? 0) + Number(obj.keepTailMs ?? 0) < obj.minimumSilenceMs, 'INVALID_SILENCE_PADDING', 'Silence padding must be smaller than the cut threshold.');
    if (obj.kind === 'curves' && Array.isArray(obj.points)) {
      const points = obj.points as { input: number; output: number }[];
      requireCondition(points.every((point, i) => i === 0 || point.input > points[i - 1]!.input), 'INVALID_CURVE_ORDER', 'Curve input coordinates must be strictly increasing.');
      requireCondition(points[0]?.input === 0 && points.at(-1)?.input === 1, 'INVALID_CURVE_ENDPOINTS', 'Curve input endpoints must be exactly 0 and 1.');
    }
    if (obj.region && obj.source && typeof obj.source === 'object' && (obj.source as Record<string, unknown>).kind === 'clone') {
      const source = (obj.source as Record<string, unknown>).sourceRegion as { width: number; height: number } | undefined; const region = obj.region as { width: number; height: number };
      requireCondition(source && source.width === region.width && source.height === region.height, 'CLONE_REGION_SIZE_MISMATCH', 'Original-photo clone source and destination regions must have equal dimensions.');
    }
  });
  for (const key of ['variants', 'changes'] as const) {
    if (Array.isArray(p[key])) { const items = p[key] as Record<string, unknown>[]; const keys = items.map(item => item[key === 'variants' ? 'key' : 'changeKey']); requireCondition(new Set(keys).size === keys.length, 'DUPLICATE_RECIPE_KEY', `Duplicate ${key} key.`); }
  }
  if (p.imageByRole && typeof p.imageByRole === 'object') for (const key of Object.values(p.imageByRole as Record<string, string>)) requireCondition(request.inputs[key], 'RECIPE_INPUT_MISSING', `Missing input ${key}.`);
  if (Array.isArray(p.cameraInputs)) {
    const cameras = p.cameraInputs as string[]; requireCondition(!cameras.includes(String(p.audioInput)), 'DUPLICATE_SYNC_INPUT', 'Reference audio cannot also be a camera key.');
    for (const key of [...cameras, String(p.audioInput)]) requireCondition(request.inputs[key], 'RECIPE_INPUT_MISSING', `Missing input ${key}.`);
    const angles = (p.anglePlan as { fromFrame: string; toFrame: string; angle: string }[]).sort((a, b) => BigInt(a.fromFrame) < BigInt(b.fromFrame) ? -1 : BigInt(a.fromFrame) > BigInt(b.fromFrame) ? 1 : 0);
    let last = 0n;
    for (const angle of angles) { requireCondition(cameras.includes(angle.angle), 'UNKNOWN_CAMERA_ANGLE', 'Angle is not a configured camera.'); requireCondition(BigInt(angle.fromFrame) >= last, 'OVERLAPPING_ANGLE_PLAN', 'Angle intervals overlap or are out of order.'); if (p.gapPolicy === 'error') requireCondition(BigInt(angle.fromFrame) === last, 'ANGLE_PLAN_GAP', 'Angle plan contains an uncovered interval.'); last = BigInt(angle.toFrame); }
    requireCondition(last <= BigInt(String(p.durationFrames)), 'ANGLE_PLAN_OUT_OF_RANGE', 'Angle plan exceeds output duration.');
    if (p.gapPolicy === 'error') requireCondition(last === BigInt(String(p.durationFrames)), 'ANGLE_PLAN_GAP', 'Angle plan does not cover the output duration.');
    if (p.gapPolicy === 'hold_previous') {
      requireCondition(angles[0]?.fromFrame === '0', 'ANGLE_PLAN_INITIAL_GAP', 'hold_previous requires an explicit first angle at frame 0.');
      const filled: typeof angles = [];
      for (const angle of angles) { const previous = filled.at(-1); if (previous && BigInt(previous.toFrame) < BigInt(angle.fromFrame)) filled.push({ fromFrame: previous.toFrame, toFrame: angle.fromFrame, angle: previous.angle }); filled.push(angle); }
      const previous = filled.at(-1)!; if (BigInt(previous.toFrame) < BigInt(String(p.durationFrames))) filled.push({ fromFrame: previous.toFrame, toFrame: String(p.durationFrames), angle: previous.angle }); p.anglePlan = filled;
    }
    const color = p.colorMatch as Record<string, unknown> | undefined;
    if (color?.enabled === true) { requireCondition(cameras.includes(String(color.referenceAngle)), 'COLOR_REFERENCE_INVALID', 'Color reference must be a configured camera.'); if (color.method === 'manual_values') { const wanted = cameras.filter(key => key !== color.referenceAngle).sort(); requireCondition(digest(Object.keys(color.manualByAngle as object).sort()) === digest(wanted), 'COLOR_VALUES_INCOMPLETE', 'Manual color values must name every non-reference camera exactly once.'); } }
  }
  const sync = p.sync as Record<string, unknown> | undefined;
  if (sync) {
    if (!sync.referenceInput) sync.referenceInput = request.recipeId === 'pr.interview_captioned.v1' ? 'voice' : p.audioInput;
    requireCondition(typeof sync.referenceInput === 'string' && request.inputs[sync.referenceInput], 'RECIPE_INPUT_MISSING', 'Sync reference input is missing.');
    const keys = request.recipeId === 'pr.interview_captioned.v1' ? ['camera', 'voice'] : [...p.cameraInputs as string[], String(p.audioInput)];
    requireCondition(keys.includes(sync.referenceInput), 'SYNC_REFERENCE_INVALID', 'Sync reference must belong to the actual synchronized source set.');
    if (sync.primary === 'manual' || sync.fallback === 'manual') { const offsets = sync.manualOffsetsTicks as Record<string, string> | undefined; requireCondition(offsets && digest(Object.keys(offsets).sort()) === digest([...keys].sort()) && offsets[sync.referenceInput] === '0', 'SYNC_OFFSETS_INVALID', 'Manual offsets must cover the exact sync source set and keep the reference at zero.'); }
    else requireCondition(sync.manualOffsetsTicks === undefined, 'UNUSED_MANUAL_OFFSETS', 'Manual offsets require an explicit manual primary or fallback.');
  }
  const outputs = request.delivery.outputs;
  requireCondition(new Set(outputs.map(output => output.outputKey)).size === outputs.length, 'DUPLICATE_OUTPUT_KEY', 'Output keys must be unique.');
  for (const output of outputs) {
    if (output.frameRate) normalizeFrameRate(output.frameRate);
    if (output.range?.kind === 'timeline_range') requireCondition(BigInt(output.range.value.start.ticks) < BigInt(output.range.value.end.ticks), 'INVALID_EXPORT_RANGE', 'Export range is empty.');
    if (output.collision.onConflict === 'overwrite') requireCondition(output.collision.expectedExistingSha256, 'EXPECTED_OUTPUT_HASH_REQUIRED', 'Overwrite requires an expected hash.');
  }
  const formats = new Set(outputs.map(output => output.format.toLowerCase()));
  const imageRecipe = request.recipeId.startsWith('ps.');
  if (imageRecipe || request.recipeId.startsWith('cross.')) requireCondition(formats.has('psd') || formats.has('psb'), 'OUTPUT_COVERAGE_MISSING', 'An editable Photoshop master is required.');
  if (!imageRecipe) requireCondition(formats.has('prproj') && outputs.some(output => output.encoding.kind === 'video'), 'OUTPUT_COVERAGE_MISSING', 'An editable Premiere project and video output are required.');
  if (imageRecipe) requireCondition(outputs.some(output => output.encoding.kind === 'image'), 'OUTPUT_COVERAGE_MISSING', 'An image output is required.');
  if (Array.isArray(p.variants)) for (const variant of p.variants as { key: string; width: number; height: number }[]) requireCondition(outputs.some(output => output.variantKey === variant.key && output.width === variant.width && output.height === variant.height && output.encoding.kind === 'image'), 'OUTPUT_COVERAGE_MISSING', `Missing image output for variant ${variant.key}.`);
  const captions = p.captions as Record<string, unknown> | undefined;
  if (captions?.alsoExportSrt) requireCondition(formats.has('srt'), 'OUTPUT_COVERAGE_MISSING', 'SRT output is required.');
  if (captions?.alsoExportVtt) requireCondition(formats.has('vtt'), 'OUTPUT_COVERAGE_MISSING', 'VTT output is required.');
  if (request.recipeId.startsWith('cross.')) requireCondition(outputs.some(output => output.format.toLowerCase() === 'png' && output.color?.alpha !== 'none'), 'OUTPUT_COVERAGE_MISSING', 'Cross-app title delivery requires a PNG with explicit alpha.');
}

export function validateDag(steps: PlanStep[]): void {
  const byKey = new Map(steps.map(step => [step.stepKey, step]));
  requireCondition(byKey.size === steps.length, 'DUPLICATE_STEP_KEY', 'Plan step keys must be unique.');
  const visiting = new Set<string>(); const done = new Set<string>();
  function visit(key: string): void {
    requireCondition(!visiting.has(key), 'PLAN_CYCLE', 'Plan dependencies contain a cycle.');
    if (done.has(key)) return;
    const step = byKey.get(key); requireCondition(step, 'MISSING_DEPENDENCY', `Missing step ${key}.`);
    visiting.add(key);
    const refs = [step.target, ...Object.values(step.assets ?? {})].filter(binding => binding?.kind === 'step_output');
    for (const ref of refs) if (ref?.kind === 'step_output') requireCondition(step.dependsOn.includes(ref.stepKey), 'UNDECLARED_BINDING_DEPENDENCY', `Step ${key} must depend on ${ref.stepKey}.`);
    step.dependsOn.forEach(visit); visiting.delete(key); done.add(key);
  }
  steps.forEach(step => visit(step.stepKey));
}
