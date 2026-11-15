import type { AssetRef, ControllerResponse, EvidenceReceipt, JsonObject, OperationReceipt, OperationRequest, ResourceItem, ResourceOutput, ResourceKind, TargetRef } from './contracts.js';
import { AssetStore } from './assets.js';
import { ContractValidator } from './validation.js';
import { digest, parseStrictJson } from './canonical.js';
import { requireCondition, AutomationError } from './errors.js';
import type { WorkerExecution } from './worker.js';

export interface RoleRequirement { role: string; ownerInputKey: string; kind: string; layerKind?: string }
export interface RoleCandidate { candidateKey: string; ownerInputKey: string; item: ResourceItem }
export interface RoleObservation { observationId: string; candidates: RoleCandidate[]; requirements: RoleRequirement[]; evidence: EvidenceReceipt[] }
export type RoleDecision = (observation: RoleObservation) => Promise<ControllerResponse>;

export function observeRoles(req: OperationRequest, receipts: Map<string, OperationReceipt>): RoleObservation {
  const candidates: RoleCandidate[] = []; const seen = new Set<string>(); const evidence: EvidenceReceipt[] = [];
  for (const owner of req.args.owners as unknown as { inputKey: string; inspectStepKey: string }[]) {
    const receipt = receipts.get(owner.inspectStepKey); requireCondition(receipt?.status === 'SUCCEEDED', 'ROLE_INVENTORY_MISSING', 'Role preparation needs a completed exact inventory.');
    evidence.push(...receipt.evidence);
    for (const slot of Object.values(receipt.resources)) {
      requireCondition(slot.kind !== 'collection' || slot.complete, 'BINDING_INCOMPLETE', 'Role inventory is incomplete.');
      for (const item of slot.kind === 'single' ? [slot.item] : slot.items) {
        if (item.value.kind === 'artifact') continue;
        const identity = digest({ owner: owner.inputKey, target: item.value }); if (seen.has(identity)) continue;
        seen.add(identity); candidates.push({ candidateKey: `candidate-${identity}`, ownerInputKey: owner.inputKey, item });
      }
    }
  }
  const requirements = req.args.roles as unknown as RoleRequirement[];
  return { observationId: digest({ candidates, requirements }), candidates, requirements, evidence };
}
function matchKind(candidate: RoleCandidate, requirement: RoleRequirement): boolean {
  return candidate.ownerInputKey === requirement.ownerInputKey && candidate.item.value.kind === requirement.kind && (!requirement.layerKind || candidate.item.projection?.layerKind === requirement.layerKind);
}
function matchesSelector(candidate: RoleCandidate, selector: JsonObject, inputs: Record<string, AssetRef>, selected: Map<string, RoleCandidate>, scope: string): boolean {
  const target = candidate.item.value; if (target.kind === 'artifact' || target.kind !== selector.kind) return false;
  const projection = candidate.item.projection;
  if (target.kind === 'ps_layer') {
    requireCondition(projection && candidate.item.structuralFingerprint && Array.isArray(projection.ancestorFingerprints), 'ROLE_SELECTOR_UNSUPPORTED', 'Layer kind/ancestor projection is unavailable.');
    const fingerprint = scope === 'observed_projection' ? candidate.item.structuralFingerprint : projection.contentFingerprint;
    requireCondition(typeof fingerprint === 'string', 'ROLE_SELECTOR_UNSUPPORTED', 'This adapter did not observe a full layer content fingerprint.');
    return projection.layerKind === selector.layerKind && fingerprint === selector.contentFingerprint && digest(projection.ancestorFingerprints) === digest(selector.ancestorFingerprints) && (!selector.logicalTag || projection.logicalTag === selector.logicalTag);
  }
  if (target.kind === 'pr_sequence') return target.sequenceGuid === selector.sequenceGuid && candidate.item.structuralFingerprint === selector.structuralFingerprint;
  if (target.kind === 'pr_track' || target.kind === 'pr_clip') {
    const sequence = selected.get(String(selector.sequenceRole))?.item.value;
    if (!sequence || sequence.kind !== 'pr_sequence' || sequence.sequenceGuid !== target.sequenceGuid || target.mediaType !== selector.mediaType || target.trackFingerprint !== selector.trackFingerprint) return false;
    if (target.kind === 'pr_track') return true;
    const input = inputs[String(selector.sourceInputKey)];
    return !!input && input.sha256 === selector.sourceSha256 && target.sourceAssetId === input.assetId && target.sourceRange.start.ticks === selector.sourceInTicks && target.sourceRange.end.ticks === selector.sourceOutTicks && target.timelineRange.start.ticks === selector.timelineStartTicks && target.timelineRange.end.ticks === selector.timelineEndTicks && target.structuralFingerprint === selector.structuralFingerprint;
  }
  return false;
}
function durableSelector(candidate: RoleCandidate, roleByCandidate: Map<string, string>, all: RoleCandidate[], inputs: Record<string, AssetRef>): JsonObject {
  const target = candidate.item.value; requireCondition(target.kind !== 'artifact', 'ROLE_TYPE_MISMATCH', 'Roles cannot target artifacts.');
  if (target.kind === 'ps_layer') {
    requireCondition(candidate.item.projection && typeof candidate.item.projection.layerKind === 'string' && candidate.item.structuralFingerprint && Array.isArray(candidate.item.projection.ancestorFingerprints), 'ROLE_SELECTOR_UNSUPPORTED', 'Observed layer kind/ancestor projection is required.');
    return { kind: 'ps_layer', layerKind: candidate.item.projection.layerKind, contentFingerprint: candidate.item.structuralFingerprint, ancestorFingerprints: candidate.item.projection.ancestorFingerprints, ...(typeof candidate.item.projection.logicalTag === 'string' ? { logicalTag: candidate.item.projection.logicalTag } : {}) };
  }
  if (target.kind === 'pr_sequence') { requireCondition(candidate.item.structuralFingerprint, 'ROLE_SELECTOR_UNSUPPORTED', 'Sequence fingerprint is missing.'); return { kind: target.kind, sequenceGuid: target.sequenceGuid, structuralFingerprint: candidate.item.structuralFingerprint }; }
  if (target.kind === 'pr_track' || target.kind === 'pr_clip') {
    const sequence = all.find(item => item.ownerInputKey === candidate.ownerInputKey && item.item.value.kind === 'pr_sequence' && item.item.value.sequenceGuid === target.sequenceGuid && roleByCandidate.has(item.candidateKey));
    requireCondition(sequence, 'ROLE_SEQUENCE_MISSING', 'A track/clip role requires its exact sequence role.');
    const selector: JsonObject = { kind: target.kind, sequenceRole: roleByCandidate.get(sequence.candidateKey)!, mediaType: target.mediaType, trackFingerprint: target.trackFingerprint };
    if (target.kind === 'pr_clip') {
      const input = Object.entries(inputs).find(([, asset]) => asset.assetId === target.sourceAssetId);
      requireCondition(input, 'ROLE_SOURCE_INPUT_MISSING', 'The clip source must resolve through an authorized source asset.');
      Object.assign(selector, { sourceInputKey: input[0], sourceSha256: input[1].sha256, sourceInTicks: target.sourceRange.start.ticks, sourceOutTicks: target.sourceRange.end.ticks, timelineStartTicks: target.timelineRange.start.ticks, timelineEndTicks: target.timelineRange.end.ticks, structuralFingerprint: target.structuralFingerprint });
    }
    return selector;
  }
  throw new AutomationError('ROLE_SELECTOR_UNSUPPORTED', `Unsupported role target ${target.kind}.`);
}
export async function prepareRoles(req: OperationRequest, inputs: Record<string, AssetRef>, receipts: Map<string, OperationReceipt>, assets: AssetStore, validator: ContractValidator, decide: RoleDecision, extraEvidence: EvidenceReceipt[] = []): Promise<WorkerExecution> {
  const observation = observeRoles(req, receipts); observation.evidence.push(...extraEvidence);
  const selected = new Map<string, RoleCandidate>(); let manifest: { schemaVersion: string; roles: Record<string, JsonObject> };
  if (req.assets.manifest) {
    manifest = parseStrictJson(await assets.readJson(req.assets.manifest)) as typeof manifest;
    validator.validate({ $ref: 'https://adobe-mcp.local/contracts/recipe-parameters.schema.json#/$defs/RoleManifest' }, manifest, 'ROLE_MANIFEST_INVALID');
    const resolving = new Set<string>();
    const resolve = (role: string): RoleCandidate => {
      if (selected.has(role)) return selected.get(role)!;
      requireCondition(!resolving.has(role), 'ROLE_CYCLE', 'Role sequence references contain a cycle.'); resolving.add(role);
      const binding = manifest.roles[role]; requireCondition(binding, 'ROLE_MISSING', `Missing role ${role}.`);
      const owner = inputs[String(binding.ownerInputKey)]; requireCondition(owner?.sha256 === binding.ownerSha256, 'ROLE_MANIFEST_STALE', `Role ${role} belongs to different source bytes.`);
      const selector = binding.selector as JsonObject; if (typeof selector.sequenceRole === 'string') resolve(selector.sequenceRole);
      const matches = observation.candidates.filter(candidate => candidate.ownerInputKey === binding.ownerInputKey && matchesSelector(candidate, selector, inputs, selected, String(binding.fingerprintScope ?? 'full_content')));
      requireCondition(matches.length === 1, matches.length ? 'AMBIGUOUS_TARGET' : 'ROLE_MISSING', `Role ${role} did not uniquely resolve.`);
      selected.set(role, matches[0]!); resolving.delete(role); return matches[0]!;
    };
    for (const requirement of observation.requirements) requireCondition(matchKind(resolve(requirement.role), requirement), 'ROLE_TYPE_MISMATCH', `Role ${requirement.role} has the wrong target kind.`);
  } else {
    for (const requirement of observation.requirements) {
      const tagged = observation.candidates.filter(candidate => matchKind(candidate, requirement) && candidate.item.logicalRole === requirement.role);
      if (tagged.length === 1) selected.set(requirement.role, tagged[0]!);
      else requireCondition(tagged.length === 0, 'AMBIGUOUS_TARGET', `Role ${requirement.role} has duplicate stored tags.`);
    }
    if (selected.size !== observation.requirements.length) {
      const response = await decide(observation);
      const bindingStep = response.initialPlan?.steps.find(step => step.operation === 'workflow.roles.bind');
      requireCondition(bindingStep && response.initialPlan!.steps.length === 1 && bindingStep.args.observationId === observation.observationId, 'ROLE_PROPOSAL_INVALID', 'Role response must bind this exact observation.');
      const bindings = bindingStep.args.bindings as unknown as { role: string; ownerInputKey: string; candidateKey: string }[];
      requireCondition(new Set(bindings.map(binding => binding.role)).size === bindings.length, 'DUPLICATE_ROLE', 'Role proposals must be unique.');
      for (const binding of bindings) {
        const requirement = observation.requirements.find(item => item.role === binding.role);
        const candidate = observation.candidates.find(item => item.candidateKey === binding.candidateKey && item.ownerInputKey === binding.ownerInputKey);
        requireCondition(requirement && candidate && matchKind(candidate, requirement), 'ROLE_PROPOSAL_INVALID', 'Role proposal refers to an unobserved or incompatible candidate.');
        selected.set(binding.role, candidate);
      }
    }
    requireCondition(observation.requirements.every(requirement => selected.has(requirement.role)), 'ROLE_UNCERTAIN', 'Not every required role has an exact candidate.');
    const roleByCandidate = new Map([...selected.entries()].map(([role, candidate]) => [candidate.candidateKey, role]));
    manifest = { schemaVersion: '1.0', roles: {} };
    for (const [role, candidate] of selected) {
      const owner = inputs[candidate.ownerInputKey]; requireCondition(owner, 'ROLE_OWNER_MISSING', 'Role owner input is missing.');
      requireCondition(candidate.item.structuralFingerprint, 'ROLE_SELECTOR_UNSUPPORTED', 'Role candidate lacks an observed structural fingerprint.');
      const duplicates = observation.candidates.filter(other => other.ownerInputKey === candidate.ownerInputKey && other.item.value.kind === candidate.item.value.kind && other.item.structuralFingerprint === candidate.item.structuralFingerprint);
      requireCondition(duplicates.length === 1, 'AMBIGUOUS_TARGET', `Role ${role} has indistinguishable observed projections.`);
      manifest.roles[role] = { ownerInputKey: candidate.ownerInputKey, ownerSha256: owner.sha256, fingerprintScope: 'observed_projection', selector: durableSelector(candidate, roleByCandidate, observation.candidates, inputs) };
    }
    validator.validate({ $ref: 'https://adobe-mcp.local/contracts/recipe-parameters.schema.json#/$defs/RoleManifest' }, manifest, 'ROLE_MANIFEST_INVALID');
  }
  const asset = await assets.writeJson(req.jobId, req.revisionId, `${req.operationId}-roles.json`, manifest);
  const receipt = { kind: 'artifact' as const, asset, operationId: req.operationId, sourceAssets: Object.values(inputs).map(input => input.assetId), recipeDigest: digest(manifest), published: false, verification: [] };
  const resources: Record<string, ResourceOutput> = { manifest: { kind: 'single', resourceKind: 'artifact', item: { itemKey: 'manifest', value: receipt } } };
  const kinds: Record<string, ResourceKind> = { ps_document: 'document', ps_layer: 'layer', pr_project: 'project', pr_sequence: 'sequence', pr_track: 'track', pr_clip: 'clip', pr_project_item: 'project_item' };
  for (const [role, candidate] of selected) resources[`role:${role}`] = { kind: 'single', resourceKind: kinds[candidate.item.value.kind]!, item: { ...candidate.item, itemKey: role, logicalRole: role } };
  const data: JsonObject = { manifestAssetId: asset.assetId, roleKeys: [...selected.keys()], bindingDigest: digest(manifest.roles) };
  return { data, resources, artifacts: [receipt], evidence: [{ kind: 'metadata', dataSchemaId: 'roles.manifest.v1', data, clock: 'document', complete: true, evidenceKey: `${req.stepKey}.bindings`, operationId: req.operationId, sourceAssetIds: receipt.sourceAssets, snapshotDigest: digest(data), capturedAt: new Date().toISOString(), artifact: asset }], verification: [] };
}
