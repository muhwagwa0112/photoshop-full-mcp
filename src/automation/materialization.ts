import type { CheckpointRecord, OperationReceipt, ResourceItem, TargetRef } from './contracts.js';
import { digest } from './canonical.js';
import { requireCondition } from './errors.js';

export function targetIdentity(target: TargetRef): string {
  let identity: unknown;
  switch (target.kind) {
    case 'ps_document': identity = target.documentId; break;
    case 'ps_layer': identity = [target.documentId, target.layerIds]; break;
    case 'pr_project': identity = target.projectGuid; break;
    case 'pr_project_item': identity = [target.projectGuid, target.projectItemId]; break;
    case 'pr_sequence': identity = [target.projectGuid, target.sequenceGuid]; break;
    case 'pr_track': identity = [target.projectGuid, target.sequenceGuid, target.mediaType, target.trackIndex]; break;
    case 'pr_clip': identity = [target.projectGuid, target.sequenceGuid, target.clipKey]; break;
  }
  return digest({ kind: target.kind, workingAssetId: target.workingAssetId, host: target.host, identity });
}
export function resourceItems(receipt: OperationReceipt): ResourceItem[] {
  return Object.values(receipt.resources).flatMap(slot => slot.kind === 'single' ? [slot.item] : slot.items);
}
/** Every rebound target is supported by the newly opened checkpoint inventory. */
export function rebindCheckpointReceipt(receipt: OperationReceipt, checkpoint: CheckpointRecord, oldRoot: TargetRef, newRoot: TargetRef, savedInventory: ResourceItem[], currentInventory: ResourceItem[]): OperationReceipt {
  const current = [...new Map(currentInventory.filter(item => item.value.kind !== 'artifact').map(item => [targetIdentity(item.value as TargetRef), item])).values()];
  function rebound(old: TargetRef): ResourceItem {
    if (old.kind === oldRoot.kind && targetIdentity(old) === targetIdentity(oldRoot)) return { itemKey: 'root', value: newRoot };
    const observed = savedInventory.find(item => item.value.kind !== 'artifact' && targetIdentity(item.value) === targetIdentity(old));
    requireCondition(observed?.structuralFingerprint, 'CHECKPOINT_BINDING_UNAVAILABLE', `Checkpoint has no observed fingerprint for ${old.kind}.`);
    const candidates = current.filter(item => item.value.kind === old.kind && item.structuralFingerprint === observed.structuralFingerprint);
    requireCondition(candidates.length === 1, 'CHECKPOINT_BINDING_AMBIGUOUS', `Checkpoint ${old.kind} fingerprint has ${candidates.length} current matches.`);
    return candidates[0]!;
  }
  const result = structuredClone(receipt);
  for (const slot of Object.values(result.resources)) for (const item of slot.kind === 'single' ? [slot.item] : slot.items) {
    if (item.value.kind === 'artifact' || item.value.workingAssetId !== oldRoot.workingAssetId) continue;
    const observed = rebound(item.value); item.value = observed.value;
    if (observed.projection) item.projection = observed.projection;
    if (observed.structuralFingerprint) item.structuralFingerprint = observed.structuralFingerprint;
  }
  if (result.targetBefore?.workingAssetId === oldRoot.workingAssetId) result.targetBefore = rebound(result.targetBefore).value as TargetRef;
  if (result.targetAfter?.workingAssetId === oldRoot.workingAssetId) result.targetAfter = rebound(result.targetAfter).value as TargetRef;
  result.host = newRoot.host;
  result.evidence = []; // Old pixels and assertions are not current live-state evidence.
  result.verification = [];
  delete result.recovery.afterState;
  result.recovery = { ...result.recovery, authorityGeneration: newRoot.host.hostEpoch, checkpointId: checkpoint.checkpointId, savedThroughOperationIds: checkpoint.savedThrough.map(item => item.operationId), effectEvidence: 'owned_checkpoint' };
  return result;
}
