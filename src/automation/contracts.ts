/** Shared versioned automation contracts. Host handles remain scoped to their epoch. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type AppId = "photoshop" | "premiere";
export type DecimalInteger = string; // validator: /^-?(0|[1-9][0-9]*)$/
export type Sha256 = string;         // validator: exactly 64 lowercase hex chars
export type OperationId = string;    // UUID persisted before submission

export interface HostRef {
  app: AppId;
  installationId: string;
  hostEpoch: string;
}
export interface AssetLocator {
  rootId: string;
  relativePath: string;
}
export interface AssetRef extends AssetLocator {
  assetId: string;
  sha256: Sha256;
  sizeBytes: DecimalInteger;
  media: MediaInfo;
}
export interface MediaInfo {
  kind: "image" | "video" | "audio" | "project" | "subtitle" | "metadata";
  mimeType: string;
  width?: number;
  height?: number;
  frameRate?: Rational;
  durationTicks?: DecimalInteger;
  sampleRate?: number;
  channels?: number;
  color?: ColorSpec;
}
export interface Rational { num: number; den: number } // integers, den > 0
export interface TickTime { ticks: DecimalInteger }
export interface FrameTime { frame: DecimalInteger; rate: Rational }
export interface TickRange { start: TickTime; end: TickTime } // end exclusive
export interface ColorSpec {
  iccProfile?: string;
  primaries?: string;
  transfer?: string;
  matrix?: string;
  bitDepth: 8 | 10 | 12 | 16 | 32;
  range: "full" | "limited";
  alpha: "none" | "straight" | "premultiplied";
}
export interface Rect { x: number; y: number; width: number; height: number }
export interface ExpectedState {
  projectionVersion: 1;
  fields: JsonObject; // only registry-declared fields, not arbitrary code
  digest: Sha256;
}
export interface PsDocumentTarget {
  kind: "ps_document";
  host: HostRef;
  documentId: number;
  workingAssetId: string;
}
export interface PsLayerTarget {
  kind: "ps_layer";
  host: HostRef;
  documentId: number;
  workingAssetId: string;
  layerIds: number[];
}
export interface PrProjectTarget {
  kind: "pr_project";
  host: HostRef;
  projectGuid: string;
  workingAssetId: string;
}
export interface PrSequenceTarget {
  kind: "pr_sequence";
  host: HostRef;
  projectGuid: string;
  sequenceGuid: string;
  workingAssetId: string;
}
export interface PrProjectItemTarget {
  kind: "pr_project_item";
  host: HostRef;
  projectGuid: string;
  workingAssetId: string;
  projectItemId: string;
  sourceAssetId: string;
  uxpHandleId?: string;
}
export interface PrTrackTarget extends Omit<PrSequenceTarget, "kind"> {
  kind: "pr_track";
  mediaType: "video" | "audio" | "caption";
  trackIndex: number;
  trackFingerprint: Sha256;
}
export interface PrClipTarget extends Omit<PrTrackTarget, "kind" | "mediaType"> {
  kind: "pr_clip";
  mediaType: "video" | "audio";
  clipKey: string; // logical workflow key, not clip display name
  sourceAssetId: string;
  cepNodeId?: string;
  uxpHandleId?: string; // opaque, valid only in hostEpoch; never persist as live after restart
  sourceRange: TickRange;
  timelineRange: TickRange;
  structuralFingerprint: Sha256;
}
export type TargetRef =
  | PsDocumentTarget | PsLayerTarget
  | PrProjectTarget | PrProjectItemTarget | PrSequenceTarget | PrTrackTarget | PrClipTarget;
export type ResourceKind = "document" | "layer" | "project" | "project_item" | "sequence" | "track" | "clip" | "artifact";
export type TargetBinding =
  | { kind: "live"; target: TargetRef }
  | { kind: "step_output"; stepKey: string; slot: string; itemKey?: string };
export type AssetBinding =
  | { kind: "input"; inputKey: string }
  | { kind: "step_output"; stepKey: string; slot: string; itemKey?: string };
export interface ResourceItem {
  itemKey: string; // stable logical key; not array offset or display name
  logicalRole?: string;
  value: TargetRef | ArtifactReceipt;
  projection?: JsonObject;
  projectionVersion?: 1;
  structuralFingerprint?: Sha256;
}
export type ResourceOutput =
  | { kind: "single"; resourceKind: ResourceKind; item: ResourceItem }
  | { kind: "collection"; resourceKind: ResourceKind; items: ResourceItem[];
      complete: boolean; nextCursor?: string };
export interface ResourceSlotSpec {
  slot: string;
  resourceKind: ResourceKind;
  cardinality: "single" | "collection";
  minItems: number;
  maxItems?: number;
}

export interface WorkflowHome {
  app: AppId; // Photoshop-only -> Photoshop; Premiere or CROSS -> Premiere
  installationId: string;
  namespaceId: string; // durable installation/journal namespace, not hostEpoch
}
export interface SubmissionReceipt {
  requestId: string;
  requestDigest: Sha256;
  workflowHome: WorkflowHome;
  jobId: string;
  revisionId: string;
  resultRetention: "available" | "expired"; // expired never means safe to execute again
}

export interface OutputPolicy {
  onConflict: "error" | "version" | "overwrite";
  expectedExistingSha256?: Sha256;
  preserveSource: true; // in-place original editing requires a distinct explicit operation
}
export interface ArtifactSpec {
  outputKey: string;
  variantKey?: string;
  rootId: string;
  relativeDirectory: string;
  basename: string;
  format: string;
  color?: ColorSpec;
  width?: number;
  height?: number;
  frameRate?: Rational;
  pixelAspect?: Rational;
  range?: { kind: "whole_sequence" } | { kind: "timeline_range"; value: TickRange };
  encoding: EncodingSpec;
  audio?: { sampleRate: number; channels: number; channelLayout: string;
    integratedLufs?: number; maxTruePeakDbtp?: number };
  collision: OutputPolicy;
}
export type EncodingSpec =
  | { kind: "native_project"; preserveLayersOrTimeline: true }
  | { kind: "image"; compression: "lossless" | "jpeg"; jpegQuality?: number; // Photoshop scale 0..12
      embedIcc: boolean }
  | { kind: "video"; encoderPresetId: string;
      videoCodec: string; pixelFormat: string; fieldOrder: "progressive" | "top_first" | "bottom_first";
      audioCodec?: string; rateControl: "preset"; allowPresetOverrides: false }
  | { kind: "subtitle"; charset: "utf-8"; lineEnding: "LF" | "CRLF" };
export interface ResolvedEncoding {
  spec: EncodingSpec;
  presetAsset?: AssetRef; // resolve presetId before mutation; exact .epr bytes/hash
  normalizedMedia: MediaInfo;
  normalizedRange?: TickRange;
  expectedPixelAspect?: Rational;
}
export interface AssertionSpec {
  id: string;
  operator: string; // enumerated by registry: equals, target_absent, interval_equals, etc.
  subject: string;  // registry-declared result field or target projection
  expected: Json;
  tolerance?: number;
  units?: "pixel" | "tick" | "frame" | "sample" | "dB" | "LU" | "byte";
}
export interface EvidenceSpec {
  kind: "composite" | "layer" | "roi" | "mask" | "frame" | "contact_sheet" | "audio_measurement";
  region?: Rect;
  timeRange?: TickRange;
  maxEdge?: number;
}
export interface ResourcePolicy {
  maxHostMutations: 1;
  maxWorkerJobs: number;
  maxCpuThreads: number;
  maxTemporaryBytes: DecimalInteger;
  maxRemoteBytes: DecimalInteger;
  maxPaidCredits: number;
  remoteTransferAllowed: boolean;
}
export interface ModelBudget {
  maxRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxImagePixels: DecimalInteger;
  maxElapsedSeconds: number;
  maxCostMinor: DecimalInteger;
  currency: string; // ISO currency for configured paid provider, e.g. USD
  enforcement: "server_enforced" | "client_reported";
}
export interface ControllerPolicy {
  mode: "client_agent" | "configured_provider";
  providerId?: string; // required for configured_provider
  waitDeadline: string;
  modelBudget: ModelBudget;
}
export interface DeliverySpec {
  outputs: ArtifactSpec[];
  preserveNativeEditing: boolean;
  allowedFallbacks: ("native_equivalent" | "rendered_asset" | "verified_ui")[];
  verifyMode: "metadata_and_changed_regions" | "full_decode";
}
export interface ReviewPolicy {
  enabled: boolean;
  requirements: RequirementSpec[];
  maxRepairs: number;
  maxReviewSeconds: number;
}
export interface RequirementSpec {
  id: string;
  description: string;
  importance: "required" | "preference";
  evaluator: "assertion" | "semantic" | "both";
  assertionIds: string[];
  evidenceKeys: string[];
  passRule: { allAssertionsPass: true; minConfidence?: number };
}
export type StepEffect =
  | { kind: "read_only" }
  | { kind: "immutable_artifact" }
  | { kind: "mutable_host"; materializationGroupId: string };
export interface PlanStep {
  stepKey: string;
  operation: string; // closed registry key; no eval and no arbitrary raw Adobe method
  dependsOn: string[];
  target?: TargetBinding;
  assets?: Record<string, AssetBinding>;
  args: JsonObject; // strict operation-specific schema, not an any-object public tool
  effect: StepEffect;
  assertions: AssertionSpec[];
  evidence?: EvidenceSpec[];
  failureStrategy: "stop" | "reconcile" | "restore_owned_checkpoint";
}
export interface LogicalResourceBinding {
  role: string;
  resourceKind: ResourceKind;
  sourceAssetId?: string;
  structuralFingerprint: Sha256;
  sourceRange?: TickRange;
  timelineRange?: TickRange;
  persistentHostKey?: string; // qualified saved identity, never an epoch-only UXP handle
}
export interface MaterializationGroup {
  groupId: string;
  app: AppId;
  rootResourceRole: string;
  base: AssetBinding;
  mutationOrder: string[]; // compiler inserts state dependency edges in this order
  checkpointPolicy: "before_repair_and_publish" | "each_declared_boundary";
}
export interface CheckpointRecord {
  checkpointId: string;
  jobId: string;
  revisionId: string;
  materializationGroupId: string;
  artifact: ArtifactRef;
  savedThrough: { stepKey: string; operationId: OperationId; postStateDigest: Sha256 }[];
  logicalBindings: LogicalResourceBinding[];
  createdAt: string;
}
export type ArtifactRef = AssetRef;
export interface EditPlan {
  contractVersion: "1.0";
  requestId: string;
  workflowHome: WorkflowHome;
  jobId: string;
  revisionId: string;
  parentRevisionId?: string;
  brief: string;
  inputs: Record<string, AssetLocator>;
  steps: PlanStep[];
  materializationGroups: MaterializationGroup[];
  delivery: DeliverySpec;
  resources: ResourcePolicy;
  review: ReviewPolicy;
  controller: ControllerPolicy;
}
export interface OperationRequest {
  contractVersion: "1.0";
  jobId: string;
  revisionId: string;
  stepKey: string;
  operationId: OperationId;
  executionNamespaceId: string;
  operation: string;
  host: HostRef;
  target?: TargetRef;
  args: JsonObject; // already validated by operation registry
  assets: Record<string, AssetRef>;
  expectedBefore?: ExpectedState;
  assertions: AssertionSpec[];
  evidence?: EvidenceSpec[];
  waitTimeoutMs: number; // caller waiting limit, not proof of host cancellation
  executionDeadline: string;
}
export type OperationStatus =
  | "QUEUED" | "PREPARED" | "DISPATCH_INTENT" | "RUNNING"
  | "APPLIED_UNVERIFIED" | "SUCCEEDED" | "FAILED_NO_EFFECT" | "FAILED_WITH_EFFECT"
  | "OUTCOME_UNKNOWN" | "CANCEL_REQUESTED" | "CANCELLED_NO_EFFECT" | "CANCELLED_WITH_EFFECT";
export type EffectState = "not_applied" | "applied" | "rolled_back" | "partial" | "unknown";
export interface VerificationResult {
  assertionId: string;
  status: "pass" | "fail" | "not_run";
  expected?: Json;
  actual?: Json;
  method: string;
}
export interface ArtifactReceipt {
  kind: "artifact";
  asset: AssetRef;
  operationId: OperationId;
  sourceAssets: string[];
  recipeDigest: Sha256;
  published: boolean;
  verification: VerificationResult[];
  resolvedEncoding?: ResolvedEncoding;
}
export interface EvidenceBase {
  evidenceKey: string;
  operationId: OperationId;
  sourceAssetIds: string[];
  snapshotDigest: Sha256;
  capturedAt: string;
  artifact: AssetRef;
}
export interface VisualEvidenceReceipt extends EvidenceBase {
  kind: "composite" | "layer" | "roi" | "mask" | "frame" | "contact_sheet";
  target?: TargetRef;
  sourceBounds: Rect;
  width: number;
  height: number;
  color: ColorSpec;
  evidenceToSource: [number, number, number, number, number, number]; // affine a,b,c,d,e,f
  temporal?: {
    requested: TickTime; resolved: TickTime; sequenceGuid?: string;
    isProxy: boolean; sourceTimeMappingAssetId?: string;
  };
  tiles?: { boundsInEvidence: Rect; requested: TickTime; resolved: TickTime }[];
}
export interface AudioEvidenceReceipt extends EvidenceBase {
  kind: "audio_measurement";
  timeRange: TickRange;
  sampleRate: number;
  channels: number;
  integratedLufs?: number;
  truePeakDbtp?: number;
  residualSyncOffsetSamples?: DecimalInteger;
  method: string;
}
export interface StructuredEvidenceReceipt extends EvidenceBase {
  kind: "transcript" | "cut_map" | "metadata";
  dataSchemaId: string;
  data: JsonObject; // same strict domain result schemas; bounded excerpt if large
  clock: "source" | "timeline" | "document";
  timeRange?: TickRange;
  complete: boolean;
}
export type EvidenceReceipt = VisualEvidenceReceipt | AudioEvidenceReceipt | StructuredEvidenceReceipt;
export interface RecoveryEvidence {
  authorityId: string;
  authorityGeneration: string;
  hostReceiptId?: string;
  beforeDigest?: Sha256;
  afterDigest?: Sha256;
  afterState?: ExpectedState;
  checkpointId?: string;
  savedThroughOperationIds: OperationId[];
  undoScope?: { ownedWorkingAssetId: string; scopeId: string; rollbackVerified: boolean };
  effectEvidence: "host_receipt" | "postcondition" | "owned_checkpoint" | "none";
}
export interface OperationError {
  code: string;
  message: string;
  retrySafe: boolean;
  nextAction: "none" | "query_receipt" | "read_postcondition" | "restore_owned_checkpoint" | "new_plan";
}
export type CompleteOperationData = {
  dataState: "complete";
  dataSchemaId: string;
  data: JsonObject;
};
export type OperationDataPayload = CompleteOperationData
  | { dataState: "unavailable"; dataSchemaId: null; data: null;
      dataReason: "not_started" | "not_observed" | "not_produced" }
  | { dataState: "partial"; dataSchemaId: string; data: JsonObject;
      missingResultFields: string[] }; // registered partial schema, never Partial<success>
export interface OperationReceiptBase {
  operationId: OperationId;
  requestDigest: Sha256;
  host: HostRef;
  effect: EffectState;
  targetBefore?: TargetRef;
  targetAfter?: TargetRef;
  resources: Record<string, ResourceOutput>;
  verification: VerificationResult[];
  evidence: EvidenceReceipt[];
  recovery: RecoveryEvidence;
  artifacts: ArtifactReceipt[];
  error?: OperationError;
  cancelRequested: boolean;
  timestamps: { accepted: string; dispatched?: string; applied?: string; finalized?: string };
}
export type OperationReceipt = OperationReceiptBase & (
  | ({ status: "SUCCEEDED" } & CompleteOperationData)
  | ({ status: Exclude<OperationStatus, "SUCCEEDED"> } & OperationDataPayload)
);
export type JobStatus =
  | "ACCEPTED" | "RUNNING" | "WAIT_HOST" | "WAIT_PROVIDER" | "RECONCILING"
  | "COMPLETED" | "CANCELLED" | "BLOCKED_CAPABILITY"
  | "FAILED_REQUIREMENTS" | "FAILED_ENVIRONMENT" | "FAILED";
export interface JobReceipt {
  jobId: string;
  revisionId: string;
  status: JobStatus;
  operations: { stepKey: string; operationId: OperationId; status: OperationStatus }[];
  artifacts: ArtifactReceipt[];
  requirementResults: RequirementVerdict[];
  checkpoints: CheckpointRecord[];
  modelUsage: ModelUsage[];
  unresolved: OperationError[];
}
export interface RequirementVerdict {
  requirementId: string;
  verdict: "pass" | "fail" | "uncertain";
  confidence?: number;
  assertionIds: string[];
  evidenceKeys: string[];
  reason: string;
}
export interface SemanticPatch {
  kind: "initial_plan" | "repair";
  steps: PlanStep[]; // closed registry; compiler still validates policies/capabilities
  replacesStepKeys: string[];
  reasonRequirementIds: string[];
}
export interface ControllerRequest {
  requestId: string;
  requestDigest: Sha256;
  jobId: string;
  revisionId: string;
  purpose: "plan" | "review" | "repair";
  brief: string;
  requirements: RequirementSpec[];
  evidence: EvidenceReceipt[];
  verifiedAssertions: VerificationResult[];
  allowedOperationIds: string[];
  remainingBudget: ModelBudget;
  expiresAt: string;
}
export interface ControllerResponse {
  requestId: string;
  requestDigest: Sha256;
  providerId: string;
  verdicts: RequirementVerdict[];
  issues: { issueId: string; requirementId: string; evidenceKeys: string[];
    region?: Rect; timeRange?: TickRange; proposedPatch?: SemanticPatch }[];
  initialPlan?: SemanticPatch;
  usage: ModelUsage;
}
export interface ModelUsage {
  requestId: string;
  providerId: string;
  state: "reserved" | "consumed" | "unknown";
  inputTokens: number;
  outputTokens: number;
  imagePixels: DecimalInteger;
  costMinor: DecimalInteger;
  currency: string;
  enforcement: "server_enforced" | "client_reported";
  accounting: "provider_reported" | "reserved_upper_bound" | "client_reported";
}
export interface AutomationController {
  request(input: ControllerRequest): Promise<ControllerResponse>;
  cancel(requestId: string): Promise<{ requested: boolean; stopped: boolean }>;
}
export interface Capability {
  id: string;
  contractVersion: string;
  state: "available" | "unsupported" | "unknown" | "requires_setup";
  route?: "uxp" | "cep" | "local_worker" | "verified_ui";
  hostVersion: string;
  observedSymbol?: string;
  preservesNativeEditing: boolean;
  qualification?: { fixtureId: string; hostBuild: string; resultDigest: Sha256 };
  reason?: string;
}
export interface HostAdapter {
  describeCapabilities(host: HostRef): Promise<Capability[]>;
  prepare(req: OperationRequest): Promise<OperationRequest>;
  dispatch(req: OperationRequest): Promise<OperationReceipt>;
  getReceipt(operationId: OperationId): Promise<OperationReceipt | null>;
  readPostcondition(req: OperationRequest): Promise<VerificationResult[]>;
  requestCancel(operationId: OperationId): Promise<{ requested: boolean; stopped: boolean }>;
}
export interface RecipeRequest {
  contractVersion: "1.0";
  requestId: string; // caller persists UUID before first submit
  workflowHome: WorkflowHome;
  revisionOf?: { jobId: string; revisionId: string };
  recipeId: string;
  brief: string;
  inputs: Record<string, AssetLocator>;
  parameters: JsonObject; // exact schema in recipe-parameters.schema.json
  delivery: DeliverySpec;
  resources: ResourcePolicy;
  review: ReviewPolicy;
  controller: ControllerPolicy;
}
