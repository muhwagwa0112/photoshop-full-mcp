import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import type { BridgeResult } from "../packages/contracts/src/index.js";
import type { ServerConfig } from "./config.js";
import { BridgeServer } from "./bridge.js";
import type { HostOperationRecord, AdapterPublication } from "./runtime-journal.js";
import { encodePng } from "./png.js";
import { readPhotoshopFileMetadata } from "./image-metadata.js";
import type { ArtifactReceipt, ArtifactSpec, AssetRef, Capability, ColorSpec, EvidenceReceipt, HostAdapter, HostRef, Json, JsonObject, MediaInfo, OperationReceipt, OperationRequest, PsDocumentTarget, PsLayerTarget, ResourceOutput, VerificationResult, VisualEvidenceReceipt } from "./automation/contracts.js";
import { AssetStore } from "./automation/assets.js";
import { digest } from "./automation/canonical.js";
import { AutomationError, requireCondition } from "./automation/errors.js";
import { OperationRegistry } from "./automation/registry.js";
import type { WorkerClient } from "./automation/worker.js";

type PsTarget = PsDocumentTarget | PsLayerTarget;
interface NativeDocument { documentId: number; workingAssetId: string; width: number; height: number; bitDepth: number; iccProfile: string | null; layerCount: number; [key: string]: unknown }
interface NativeLayer { id: number; name: string; projection: JsonObject }
interface NativeEvidence {
  kind: VisualEvidenceReceipt["kind"]; width: number; height: number; components: number; componentSize: number;
  rawPixels?: string; base64?: string; mimeType: string; colorProfile: string | null; alpha: "none" | "straight";
  sourceBounds: { x: number; y: number; width: number; height: number };
  evidenceToSource: [number, number, number, number, number, number];
}
interface NativeExecution {
  dataSchemaId: string; data: JsonObject | null; document: NativeDocument | null; layers: NativeLayer[]; layerId?: number;
  verification: VerificationResult[]; evidence: NativeEvidence[]; snapshot: JsonObject;
  exported?: { path: string; sha256: string; sizeBytes?: number | string; reopened?: { width: number; height: number; colorProfile: string | null; layerCount: number } };
}
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const INTERNAL_ARGS = new Set(["path", "outputPath", "sourceAssets", "executionResources", "verifyMode"]);
const CREATE_OPERATIONS = new Set(["ps.document.open", "ps.document.create", "ps.document.duplicate", "ps.artboard.duplicate"]);
const READ_OPERATIONS = new Set(["ps.document.inspect", "ps.evidence.capture", "ps.raster.capture"]);

/** All calls, including Premiere peers, pass through this owner's durable bridge. */
export class PhotoshopAutomationAdapter implements HostAdapter {
  private readonly registry = new OperationRegistry();
  private readonly finishing = new Map<string, Promise<OperationReceipt>>();
  private readonly prepared = new Map<string, string>();
  constructor(private readonly config: ServerConfig, private readonly bridge: BridgeServer, private readonly assets: AssetStore, private readonly worker?: WorkerClient) {}

  async resolveHost(): Promise<HostRef> {
    const status = this.bridge.status();
    requireCondition(status.connected && status.hostEpoch, "WAIT_HOST", "Photoshop's paired UXP panel is not connected.");
    return { app: "photoshop", installationId: this.config.serverId, hostEpoch: status.hostEpoch };
  }
  private async checkHost(host: HostRef): Promise<void> {
    const actual = await this.resolveHost();
    requireCondition(digest(actual) === digest(host), "STALE_TARGET", "Photoshop host identity or epoch changed; rebind from the owned working asset.");
  }
  async describeCapabilities(host: HostRef): Promise<Capability[]> {
    await this.checkHost(host);
    const response = await this.bridge.dispatch("automation.capabilities", {}, 15_000, { hostEpoch: host.hostEpoch });
    requireCondition(response.ok && Array.isArray(response.data), "CAPABILITY_QUERY_FAILED", response.error?.message ?? "Photoshop did not return its actual capabilities.");
    return response.data as Capability[];
  }
  async prepare(req: OperationRequest): Promise<OperationRequest> {
    const request = structuredClone(req);
    requireCondition(request.contractVersion === "1.0" && typeof request.operationId === "string" && request.operationId.length > 0, "INVALID_OPERATION_REQUEST", "A versioned operation identity is required.");
    await this.checkHost(request.host);
    const specification = this.registry.get(request.operation);
    requireCondition(specification.app === "photoshop" && specification.route === "host", "UNKNOWN_OPERATION", "The Photoshop adapter accepts only registered Photoshop operations.");
    const publicArgs = Object.fromEntries(Object.entries(request.args).filter(([key]) => !INTERNAL_ARGS.has(key)));
    this.registry.validator.validate(specification.argsSchema, publicArgs, "OPERATION_ARGS_INVALID");
    for (const key of specification.requiredAssets ?? []) requireCondition(request.assets[key], "OPERATION_ASSET_REQUIRED", `Missing asset slot: ${key}`);
    if (specification.targetKinds?.length) requireCondition(request.target && specification.targetKinds.includes(request.target.kind), "OPERATION_TARGET_REQUIRED", "This operation requires an exact Photoshop target.");
    if (request.target) {
      requireCondition(request.target.kind === "ps_document" || request.target.kind === "ps_layer", "INVALID_TARGET", "A Photoshop target is required.");
      requireCondition(digest(request.target.host) === digest(request.host), "STALE_TARGET", "Target is bound to another host/epoch.");
      requireCondition(Number.isInteger(request.target.documentId) && request.target.documentId > 0, "INVALID_TARGET", "Document identity is invalid.");
      if (request.target.kind === "ps_layer") requireCondition(request.target.layerIds.length === 1 && Number.isInteger(request.target.layerIds[0]) && request.target.layerIds[0]! > 0, "INVALID_TARGET", "This operation requires exactly one layer ID.");
      if (!READ_OPERATIONS.has(request.operation)) requireCondition(request.target.workingAssetId.startsWith("working:"), "SOURCE_MUTATION_FORBIDDEN", "Automated mutations require a job-owned working copy.");
    }
    for (const asset of Object.values(request.assets)) await this.assets.pathFor(asset);
    if (request.operation === "ps.document.open") requireCondition(request.assets.source!.assetId.startsWith("working:"), "SOURCE_MUTATION_FORBIDDEN", "Open requires a staged working asset; native editing never opens the original file in place.");
    if (request.operation === "ps.artboard.duplicate") {
      const box = request.args.box as JsonObject;
      requireCondition(box.x === 0 && box.y === 0, "BLOCKED_CAPABILITY", "Artboard variants are isolated working documents with an origin of zero.");
    }
    let requestedCapability = request.operation === "ps.adjustment.create" ? `${request.operation}:${String(request.args.kind)}` : request.operation;
    if (request.operation === "ps.text.fit") {
      const observed = await this.bridge.dispatch("target.inspect", { target: request.target }, 15_000, { hostEpoch: request.host.hostEpoch });
      const projection = observed.data as { layer?: { id?: number; isPointText?: boolean; isParagraphText?: boolean } } | undefined;
      requireCondition(observed.ok && projection?.layer?.id === (request.target as PsLayerTarget).layerIds[0], "PRECONDITION_OBSERVATION_UNAVAILABLE", "Text fitting requires the exact target's observed native text kind.");
      if (projection?.layer?.isPointText === true && projection.layer.isParagraphText !== true) requestedCapability = "ps.text.fit:point";
    }
    const capability = (await this.describeCapabilities(request.host)).find(item => item.id === requestedCapability);
    requireCondition(capability?.state === "available", "BLOCKED_CAPABILITY", capability?.reason ?? "The native operation is unavailable on this host.");
    if (request.target && (request.expectedBefore || !READ_OPERATIONS.has(request.operation) || request.operation === "ps.raster.capture")) {
      const observed = await this.bridge.dispatch("target.inspect", { target: request.target }, 15_000, { hostEpoch: request.host.hostEpoch });
      const projection = observed.data as { document?: { documentId?: number; historyStateId?: number; workingAssetId?: string } } | undefined;
      requireCondition(observed.ok && typeof projection?.document?.historyStateId === "number", "PRECONDITION_OBSERVATION_UNAVAILABLE", "The host did not expose the bound document's current history identity.");
      const fields: JsonObject = { "document.documentId": request.target.documentId, "document.workingAssetId": request.target.workingAssetId, "document.historyStateId": projection.document.historyStateId };
      if (request.expectedBefore) {
        requireCondition(request.expectedBefore.projectionVersion === 1 && digest(request.expectedBefore.fields) === request.expectedBefore.digest, "PRECONDITION_FAILED", "The captured source-state projection digest/version is invalid.");
        for (const [path, expected] of Object.entries(request.expectedBefore.fields)) {
          requireCondition(/^(document|layer)(\.[A-Za-z0-9_]+)*$/.test(path) && !path.split(".").some(key => ["__proto__", "prototype", "constructor"].includes(key)), "PRECONDITION_FAILED", "The expected source-state field is invalid.");
          let actual: unknown = observed.data;
          for (const key of path.split(".")) actual = actual !== null && typeof actual === "object" && Object.prototype.hasOwnProperty.call(actual, key) ? (actual as Record<string, unknown>)[key] : undefined;
          requireCondition(actual !== undefined && digest(actual) === digest(expected), "PRECONDITION_FAILED", `The source state changed after capture: ${path}. Capture a new raster before applying generated pixels/masks.`);
        }
      } else request.expectedBefore = { projectionVersion: 1, fields, digest: digest(fields) };
    }
    if (request.operation === "ps.layer.mask") {
      requireCondition(request.args.source !== "native_subject", "BLOCKED_CAPABILITY", "Native subject selection needs a qualified recorded template; use a prepared local-worker mask.");
      if (request.args.source === "input_mask") requireCondition(request.assets.mask, "OPERATION_ASSET_REQUIRED", "An input mask asset is required.");
      requireCondition(request.args.contractPx === undefined || Number.isInteger(request.args.contractPx), "MASK_CONTRACT_INTEGER_REQUIRED", "Mask contraction is measured in whole source pixels.");
    }
    if (request.args.output) {
      const output = request.args.output as unknown as ArtifactSpec;
      requireCondition(["png", "jpg", "psd", "psb"].includes(output.format.toLowerCase()), "BLOCKED_CAPABILITY", "This Photoshop route supports PNG, JPG, PSD, and PSB.");
      requireCondition(output.collision.preserveSource === true && ["error", "version", "overwrite"].includes(output.collision.onConflict), "INVALID_OUTPUT_POLICY", "An explicit source-preserving collision policy is required.");
      requireCondition(output.encoding.kind === "native_project" ? ["psd", "psb"].includes(output.format.toLowerCase()) : output.encoding.kind === "image" && ["png", "jpg"].includes(output.format.toLowerCase()), "OUTPUT_ENCODING_MISMATCH", "Output format and encoding disagree.");
      if (request.args.verifyMode === "full_decode") requireCondition(this.worker && output.encoding.kind === "image", "BLOCKED_CAPABILITY", "Full image decode verification requires the configured local worker; native project verification uses reopened native state.");
      if (output.color?.alpha === "premultiplied") throw new AutomationError("BLOCKED_CAPABILITY", "This native save route does not expose a qualified premultiplied-alpha output.");
      request.args.outputPath = await this.assets.allocate(request.jobId, request.revisionId, `${request.operationId}.${output.format.toLowerCase()}`);
    }
    if (request.operation === "ps.document.open") request.args.path = await this.assets.pathFor(request.assets.source!);
    requireCondition(Number.isFinite(Date.parse(request.executionDeadline)) && request.waitTimeoutMs > 0, "INVALID_OPERATION_DEADLINE", "Operation deadline and caller wait limit are required.");
    this.prepared.set(request.operationId, digest(request));
    if (this.prepared.size > 1024) this.prepared.delete(this.prepared.keys().next().value!);
    return request;
  }

  async dispatch(req: OperationRequest): Promise<OperationReceipt> {
    const requestDigest = digest(req);
    const existing = this.bridge.operation(req.operationId);
    if (existing) {
      requireCondition(existing.command.requestDigest === requestDigest, "IDEMPOTENCY_CONFLICT", "Operation ID is already bound to different arguments.");
      requireCondition(!existing.expired, "RESULT_EXPIRED", "The settled result body expired; its operation ID remains reserved and cannot execute again.");
      if (existing.adapterReceipt) return existing.adapterReceipt;
      if (existing.result) return this.finishOnce(req, existing);
    }
    try {
      if (this.prepared.get(req.operationId) !== requestDigest) {
        const prepared = await this.prepare(req);
        requireCondition(digest(prepared) === requestDigest, "REQUEST_NOT_PREPARED", "Resolve this request with host.prepare before dispatching its bound operation identity.");
      }
      await this.checkHost(req.host);
      const assetTransfers: Record<string, { path: string; name: string; assetId: string; sha256: string }> = {};
      for (const [slot, asset] of Object.entries(req.assets)) {
        const path = await this.assets.pathFor(asset);
        assetTransfers[slot] = { path, name: `${slot}-${asset.sha256.slice(0, 12)}${extname(path)}`, assetId: asset.assetId, sha256: asset.sha256 };
      }
      const workingAssetId = CREATE_OPERATIONS.has(req.operation) ? req.operation === "ps.document.open" ? req.assets.source!.assetId : `working:${req.jobId}:${req.operationId}` : req.target?.workingAssetId;
      const outputPath = typeof req.args.outputPath === "string" ? req.args.outputPath : undefined;
      const payload = { operation: req.operation, args: req.args, target: req.target, expectedBefore: req.expectedBefore, assertions: req.assertions, evidence: req.evidence ?? [], assetTransfers, workingAssetId,
        canonicalRequest: req, ...(outputPath ? { exportDestination: outputPath, exportFileName: basename(outputPath) } : {}) };
      await this.bridge.dispatch("automation.execute", payload, req.waitTimeoutMs, { operationId: req.operationId, requestDigest, executionDeadline: Date.parse(req.executionDeadline), hostEpoch: req.host.hostEpoch });
      const record = this.bridge.operation(req.operationId);
      requireCondition(record, "OPERATION_RECEIPT_MISSING", "The native receipt was not persisted.");
      return this.finishOnce(req, record);
    } catch (error) {
      const record = this.bridge.operation(req.operationId);
      if (record?.result) return this.finishOnce(req, record);
      const code = error instanceof Error && "code" in error ? String(error.code) : "HOST_ERROR";
      return this.unavailable(req, record, record ? "OUTCOME_UNKNOWN" : "FAILED_NO_EFFECT", code, error instanceof Error ? error.message : String(error));
    }
  }
  async getReceipt(operationId: string): Promise<OperationReceipt | null> {
    let record = this.bridge.operation(operationId);
    if (!record) return null;
    requireCondition(!record.expired, "RESULT_EXPIRED", "The settled result body expired; its operation ID remains reserved and cannot execute again.");
    if (record.adapterReceipt) return record.adapterReceipt;
    if (!record.result) { try { record = await this.bridge.reconcile(operationId) ?? record; } catch { /* The unresolved durable intent remains authoritative. */ } }
    const req = record.command.payload.canonicalRequest as OperationRequest | undefined;
    if (!req) return null;
    return record.result ? this.finishOnce(req, record) : this.unavailable(req, record, "OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN", "The host has not supplied a settled operation receipt.");
  }
  async readPostcondition(req: OperationRequest): Promise<VerificationResult[]> {
    await this.checkHost(req.host);
    const response = await this.bridge.dispatch("operation.verify", { target: req.target, assertions: req.assertions }, Math.min(req.waitTimeoutMs, 15_000), { hostEpoch: req.host.hostEpoch });
    requireCondition(response.ok && Array.isArray(response.data), "POSTCONDITION_UNAVAILABLE", response.error?.message ?? "No postcondition observation is available.");
    return response.data as VerificationResult[];
  }
  requestCancel(operationId: string): Promise<{ requested: boolean; stopped: boolean }> { return this.bridge.requestCancel(operationId); }

  private unavailable(req: OperationRequest, record: HostOperationRecord | undefined, status: Exclude<OperationReceipt["status"], "SUCCEEDED">, code: string, message: string): OperationReceipt {
    const native = record?.result;
    return { operationId: req.operationId, requestDigest: record?.command.requestDigest ?? digest(req), host: req.host, status,
      effect: native?.effect ?? (status === "FAILED_NO_EFFECT" ? "not_applied" : "unknown"), dataState: "unavailable", dataSchemaId: null, data: null, dataReason: record?.dispatchedAt ? "not_observed" : "not_started",
      ...(req.target ? { targetBefore: req.target } : {}), resources: {}, verification: [], evidence: [], artifacts: [], cancelRequested: native?.cancelRequested === true || record?.cancelRequested === true,
      recovery: { authorityId: this.config.serverId, authorityGeneration: record?.command.ownerGeneration ?? this.bridge.ownerGeneration, savedThroughOperationIds: [], effectEvidence: native ? "host_receipt" : "none" },
      timestamps: { accepted: record?.acceptedAt ?? new Date().toISOString(), ...(record?.dispatchedAt ? { dispatched: record.dispatchedAt } : {}), ...(record?.finalizedAt ? { finalized: record.finalizedAt } : {}) },
      error: { code, message, retrySafe: false, nextAction: status === "OUTCOME_UNKNOWN" || status === "APPLIED_UNVERIFIED" ? "query_receipt" : "new_plan" } };
  }
  private finishOnce(req: OperationRequest, record: HostOperationRecord): Promise<OperationReceipt> {
    const current = this.finishing.get(req.operationId); if (current) return current;
    const promise = this.finish(req, record).finally(() => { this.finishing.delete(req.operationId); }); this.finishing.set(req.operationId, promise); return promise;
  }
  private async finish(req: OperationRequest, input: HostOperationRecord): Promise<OperationReceipt> {
    const record = this.bridge.operation(req.operationId) ?? input;
    if (record.adapterReceipt) return record.adapterReceipt;
    const native = record.result;
    requireCondition(native, "OPERATION_RECEIPT_MISSING", "No native receipt is available.");
    if (!native.ok) {
      const noEffect = native.effect === "not_applied" || native.effect === "rolled_back";
      const cancelled = native.error?.code === "CANCELLED";
      const status = native.effect === "unknown" || native.error?.code === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : cancelled ? noEffect ? "CANCELLED_NO_EFFECT" : "CANCELLED_WITH_EFFECT" : noEffect ? "FAILED_NO_EFFECT" : "FAILED_WITH_EFFECT";
      const receipt = this.unavailable(req, record, status, native.error?.code ?? "HOST_ERROR", native.error?.message ?? "Photoshop operation failed.");
      await this.bridge.recordAdapterState(req.operationId, { adapterReceipt: receipt }); return receipt;
    }
    const response = native.data as NativeExecution;
    try {
      requireCondition(response && typeof response.dataSchemaId === "string" && Array.isArray(response.layers) && Array.isArray(response.evidence), "NATIVE_RESULT_INVALID", "Native result does not match the operation contract.");
      const document = response.document; const resources: Record<string, ResourceOutput> = {};
      let targetAfter: PsTarget | undefined;
      if (document) {
        const target: PsDocumentTarget = { kind: "ps_document", host: req.host, documentId: document.documentId, workingAssetId: document.workingAssetId };
        resources.document = { kind: "single", resourceKind: "document", item: { itemKey: "document", value: target } };
        resources.layers = { kind: "collection", resourceKind: "layer", complete: true, items: response.layers.map(item => ({ itemKey: `layer:${item.id}`, value: { ...target, kind: "ps_layer" as const, layerIds: [item.id] }, projection: item.projection, projectionVersion: 1, structuralFingerprint: digest(item.projection) })) };
        targetAfter = response.layerId ? { ...target, kind: "ps_layer", layerIds: [response.layerId] } : target;
        if (response.layerId) {
          const item = resources.layers.items.find(item => item.value.kind === "ps_layer" && item.value.layerIds[0] === response.layerId);
          requireCondition(item, "NATIVE_RESULT_INVALID", "Created/changed layer is absent from the actual inventory.");
          resources.layer = { kind: "single", resourceKind: "layer", item };
        }
      }
      const evidence = await this.materializeEvidence(req, response, targetAfter);
      const artifacts: ArtifactReceipt[] = [];
      const verification = [...response.verification]; let data = response.data;
      if (response.exported) {
        const artifact = await this.finishExport(req, response, record); artifacts.push(artifact); verification.push(...artifact.verification);
        resources.artifact = { kind: "single", resourceKind: "artifact", item: { itemKey: String((req.args.output as unknown as ArtifactSpec).outputKey), value: artifact } };
        data = { outputKeys: [(req.args.output as unknown as ArtifactSpec).outputKey], artifactIds: [artifact.asset.assetId], published: true, verificationScope: req.args.verifyMode === "full_decode" ? "full_decode" : "metadata_and_changed_regions" };
      } else if (["ps.evidence.capture", "ps.raster.capture"].includes(req.operation)) {
        requireCondition(evidence.length > 0, "EVIDENCE_MISSING", "Capture produced no actual evidence.");
        const first = evidence[0]!;
        const artifact: ArtifactReceipt = { kind: "artifact", asset: first.artifact, operationId: req.operationId, sourceAssets: first.sourceAssetIds, recipeDigest: digest(req), published: false, verification: [] };
        artifacts.push(artifact); resources.artifact = { kind: "single", resourceKind: "artifact", item: { itemKey: "artifact", value: artifact } };
        data = { evidenceKeys: evidence.map(item => item.evidenceKey), snapshotDigest: first.snapshotDigest };
      }
      requireCondition(data, "NATIVE_RESULT_INCOMPLETE", "Native operation did not produce complete typed result data.");
      const observedDocument = response.snapshot.document as JsonObject | undefined;
      requireCondition(document && observedDocument && observedDocument.documentId === document.documentId && observedDocument.workingAssetId === document.workingAssetId && Number.isInteger(observedDocument.historyStateId), "POSTCONDITION_STATE_UNAVAILABLE", "The native receipt must include the exact document identity and observed history state after the operation.");
      const afterFields: JsonObject = { "document.documentId": document.documentId, "document.workingAssetId": document.workingAssetId, "document.historyStateId": observedDocument.historyStateId! };
      const base = this.unavailable(req, record, "APPLIED_UNVERIFIED", "VERIFICATION_INCOMPLETE", "An operation assertion has not been observed.");
      const { dataReason: _reason, ...withoutReason } = base as typeof base & { dataReason?: string };
      const complete = { ...withoutReason, effect: native.effect ?? (READ_OPERATIONS.has(req.operation) ? "not_applied" : "applied"), dataState: "complete" as const, dataSchemaId: response.dataSchemaId, data, resources, verification, evidence, artifacts,
        ...(targetAfter ? { targetAfter } : {}), recovery: { ...base.recovery, effectEvidence: "host_receipt" as const, hostReceiptId: native.requestId, afterDigest: digest(response.snapshot), afterState: { projectionVersion: 1 as const, fields: afterFields, digest: digest(afterFields) }, savedThroughOperationIds: [] },
        timestamps: { ...base.timestamps, applied: record.finalizedAt ?? new Date().toISOString(), finalized: new Date().toISOString() } };
      const receipt: OperationReceipt = verification.some(item => item.status !== "pass")
        ? { ...complete, status: verification.some(item => item.status === "fail") ? "FAILED_WITH_EFFECT" : "APPLIED_UNVERIFIED" }
        : { ...complete, status: "SUCCEEDED" };
      if (receipt.status === "SUCCEEDED") delete receipt.error;
      this.registry.validateReceipt(req.operation, receipt);
      await this.bridge.recordAdapterState(req.operationId, { adapterReceipt: receipt }); return receipt;
    } catch (error) {
      // Never convert a confirmed host mutation plus a publication/verification
      // failure into a no-effect error or rerun the native action.
      const code = error instanceof Error && "code" in error ? String(error.code) : "RESULT_FINALIZATION_FAILED";
      const receipt = this.unavailable(req, record, "APPLIED_UNVERIFIED", code, error instanceof Error ? error.message : String(error));
      return receipt;
    }
  }

  private async materializeEvidence(req: OperationRequest, response: NativeExecution, target?: PsTarget): Promise<EvidenceReceipt[]> {
    const sourceAssetIds = Object.values(req.assets).map(item => item.assetId);
    const captured: EvidenceReceipt[] = [];
    for (let index = 0; index < response.evidence.length; index++) {
      const value = response.evidence[index]!;
      requireCondition(value.componentSize === 8 && [1, 2, 3, 4].includes(value.components), "EVIDENCE_ENCODING_UNSUPPORTED", "Evidence must contain actual 8-bit native pixels.");
      const bytes = value.rawPixels ? encodePng(Buffer.from(value.rawPixels, "base64"), value.width, value.height, value.components) : Buffer.from(value.base64 ?? "", "base64");
      requireCondition(bytes.length > 0, "EVIDENCE_MISSING", "Evidence contains no image bytes.");
      const file = await this.assets.allocate(req.jobId, req.revisionId, `${req.operationId}-evidence-${index}.${value.rawPixels ? "png" : "jpg"}`);
      try { const handle = await open(file, "wx"); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; requireCondition((await readFile(file)).equals(bytes), "EVIDENCE_CONFLICT", "The operation's immutable evidence path contains different bytes."); }
      const color: ColorSpec = { bitDepth: 8, range: "full", alpha: value.alpha, ...(value.colorProfile ? { iccProfile: value.colorProfile } : {}) };
      const artifact = await this.assets.registerGenerated(file, { kind: "image", mimeType: value.rawPixels ? "image/png" : "image/jpeg", width: value.width, height: value.height, color });
      const bounds = value.sourceBounds;
      captured.push({ kind: value.kind, operationId: req.operationId, sourceAssetIds, snapshotDigest: digest(response.snapshot), capturedAt: this.bridge.operation(req.operationId)?.finalizedAt ?? new Date().toISOString(), artifact,
        evidenceKey: typeof req.args.evidenceKey === "string" && index === 0 ? req.args.evidenceKey : `${req.stepKey}.${value.kind}.${index}`, ...(target ? { target } : {}), sourceBounds: bounds, width: value.width, height: value.height, color, evidenceToSource: value.evidenceToSource });
    }
    return captured;
  }

  private async finishExport(req: OperationRequest, response: NativeExecution, record: HostOperationRecord): Promise<ArtifactReceipt> {
    const exported = response.exported!; const output = req.args.output as unknown as ArtifactSpec;
    requireCondition(typeof req.args.outputPath === "string" && resolve(exported.path) === resolve(req.args.outputPath), "OUTPUT_PATH_MISMATCH", "Native export did not use its reserved staging path.");
    const observed = await readPhotoshopFileMetadata(exported.path);
    requireCondition(observed.format === output.format.toLowerCase(), "OUTPUT_FORMAT_MISMATCH", "Export bytes do not match the requested format.");
    const checks: VerificationResult[] = [];
    const compare = (key: string, expected: Json, actual: Json): void => { const pass = digest(expected) === digest(actual); checks.push({ assertionId: `${req.stepKey}.export.${key}`, status: pass ? "pass" : "fail", expected, actual, method: "staged_file_header_and_native_reopen" }); requireCondition(pass, "OUTPUT_VERIFICATION_FAILED", `Export ${key} does not match its requested value.`); };
    compare("width", output.width ?? response.document!.width, observed.width); compare("height", output.height ?? response.document!.height, observed.height);
    if (output.color) {
      compare("bitDepth", output.color.bitDepth, observed.bitDepth);
      if (output.color.alpha === "none" && output.encoding.kind === "image") compare("alpha", "none", observed.alpha);
      if (output.color.iccProfile) compare("iccProfile", output.color.iccProfile, exported.reopened?.colorProfile ?? null);
    }
    if (output.encoding.kind === "image" && output.encoding.embedIcc) compare("embeddedIcc", true, observed.embeddedIcc);
    if (output.encoding.kind === "native_project") compare("layerCount", response.document!.layerCount, exported.reopened?.layerCount ?? null);
    const bitDepth = observed.bitDepth;
    requireCondition([8, 16, 32].includes(bitDepth), "OUTPUT_DEPTH_UNSUPPORTED", "This output contract requires an 8, 16, or 32-bit image/project.");
    const media: MediaInfo = { kind: output.encoding.kind === "native_project" ? "project" : "image", mimeType: observed.format === "png" ? "image/png" : observed.format === "jpg" ? "image/jpeg" : "image/vnd.adobe.photoshop", width: observed.width, height: observed.height,
      color: { bitDepth: bitDepth as 8 | 16 | 32, range: "full", alpha: observed.alpha, ...(exported.reopened?.colorProfile ? { iccProfile: exported.reopened.colorProfile } : {}) } };
    const staged = await this.assets.registerGenerated(exported.path, media);
    compare("sha256", exported.sha256, staged.sha256);
    if (this.worker && output.encoding.kind === "image") {
      const resources = req.args.executionResources as JsonObject | undefined;
      const directory = await this.assets.allocate(req.jobId, req.revisionId, `${req.operationId}-verification`); await mkdir(directory, { recursive: true });
      const verified = await this.worker.run({ workerRequestId: `${req.operationId}-verify`, operation: "artifact.verify", inputs: { source: { path: exported.path, sha256: staged.sha256 } }, options: { output, verifyMode: req.args.verifyMode ?? "metadata_and_changed_regions" }, outputDirectory: directory,
        limits: { maxCpuThreads: Number(resources?.maxCpuThreads ?? 2), maxTemporaryBytes: String(resources?.maxTemporaryBytes ?? "536870912"), maxOutputBytes: 4_000_000, timeoutMs: Math.max(1, Date.parse(req.executionDeadline) - Date.now()) } });
      requireCondition(verified.ok && verified.data.verified === true && Array.isArray(verified.data.checks), "OUTPUT_VERIFICATION_FAILED", verified.error?.message ?? "The image verifier did not verify the staged output.");
      for (const [index, raw] of (verified.data.checks as Record<string, unknown>[]).entries()) checks.push({ assertionId: `${req.stepKey}.file.${index}`, status: raw.status === "pass" ? "pass" : "fail", expected: json(raw.expected ?? null), actual: json(raw.actual ?? null), method: req.args.verifyMode === "full_decode" ? "local_worker_full_decode" : "local_worker_file_metadata" });
    }
    const sources = Array.isArray(req.args.sourceAssets) ? req.args.sourceAssets as unknown as AssetRef[] : Object.values(req.assets);
    for (const source of sources) await this.assets.pathFor(source);
    const asset = await this.publishOnce(req, staged, output, sources, this.bridge.operation(req.operationId)?.publication ?? record.publication);
    return { kind: "artifact", asset, operationId: req.operationId, sourceAssets: sources.map(source => source.assetId), recipeDigest: digest(req), published: true, verification: checks, resolvedEncoding: { spec: output.encoding, normalizedMedia: media } };
  }
  private async publishOnce(req: OperationRequest, staged: AssetRef, requested: ArtifactSpec, sources: AssetRef[], saved?: AdapterPublication): Promise<AssetRef> {
    if (saved?.state === "committed" && saved.asset) { await this.assets.pathFor(saved.asset); return saved.asset; }
    let intent = saved;
    const ext = requested.format.toLowerCase(); const stem = requested.basename.toLowerCase().endsWith(`.${ext}`) ? requested.basename.slice(0, -(ext.length + 1)) : requested.basename;
    for (let version = intent?.version ?? 0; version < 10_000; version++) {
      const output = intent?.output ?? { ...requested, basename: version ? `${stem}-${version}` : stem, collision: { ...requested.collision, onConflict: requested.collision.onConflict === "version" ? "error" as const : requested.collision.onConflict } };
      const locator = { rootId: output.rootId, relativePath: `${output.relativeDirectory ? output.relativeDirectory.replace(/\/$/, "") + "/" : ""}${output.basename}.${ext}` };
      let existing: AssetRef | undefined;
      try { existing = await this.assets.resolve(locator, staged.media); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (intent && existing?.sha256 === staged.sha256 && existing.sizeBytes === staged.sizeBytes) {
        await this.bridge.recordAdapterState(req.operationId, { publication: { ...intent, state: "committed", asset: existing } }); return existing;
      }
      if (existing && requested.collision.onConflict === "version" && !intent) continue;
      if (intent && existing && requested.collision.onConflict !== "overwrite") throw new AutomationError("OUTPUT_CONFLICT", "The reserved publication destination contains different bytes; no new version is emitted during recovery.");
      intent = { state: "intent", staged, output, version };
      await this.bridge.recordAdapterState(req.operationId, { publication: intent });
      try {
        const asset = await this.assets.publish(staged, output, sources);
        await this.bridge.recordAdapterState(req.operationId, { publication: { ...intent, state: "committed", asset } }); return asset;
      } catch (error) {
        if (!saved && requested.collision.onConflict === "version" && error instanceof AutomationError && error.code === "OUTPUT_CONFLICT") { intent = undefined; continue; }
        throw error;
      }
    }
    throw new AutomationError("OUTPUT_VERSION_LIMIT", "No unused versioned output is available within the configured limit.");
  }
}
