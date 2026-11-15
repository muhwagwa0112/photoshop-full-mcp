import type { AssetBinding, AssetRef, ArtifactReceipt, OperationReceipt, ResourceItem, ResourceKind, ResourceOutput, TargetBinding, TargetRef } from './contracts.js';
import { requireCondition } from './errors.js';

export function selectResource(output: ResourceOutput | undefined, itemKey?: string, expectedKind?: ResourceKind): ResourceItem {
  requireCondition(output, 'BINDING_NOT_FOUND', 'The requested resource slot is missing.');
  requireCondition(!expectedKind || output.resourceKind === expectedKind, 'BINDING_TYPE_MISMATCH', `Expected ${expectedKind}, received ${output.resourceKind}.`);
  if (output.kind === 'single') {
    requireCondition(!itemKey || itemKey === output.item.itemKey, 'BINDING_NOT_FOUND', 'The requested single itemKey does not match.'); return output.item;
  }
  requireCondition(output.complete && !output.nextCursor, 'BINDING_INCOMPLETE', 'A paginated or incomplete result cannot be a mutation target.');
  requireCondition(itemKey, 'BINDING_ITEM_KEY_REQUIRED', 'Collection bindings require a stable itemKey.');
  const matches = output.items.filter(item => item.itemKey === itemKey);
  requireCondition(matches.length <= 1, 'BINDING_NOT_UNIQUE', 'The collection contains duplicate itemKeys.');
  requireCondition(matches.length === 1, 'BINDING_NOT_FOUND', `Missing itemKey ${itemKey}.`);
  return matches[0]!;
}
export function resolveTarget(binding: TargetBinding, receipts: Map<string, OperationReceipt>, expectedKind?: ResourceKind): TargetRef {
  if (binding.kind === 'live') return binding.target;
  const receipt = receipts.get(binding.stepKey);
  requireCondition(receipt?.status === 'SUCCEEDED', 'BINDING_PRODUCER_NOT_COMPLETE', `Producer ${binding.stepKey} has not succeeded.`);
  const value = selectResource(receipt.resources[binding.slot], binding.itemKey, expectedKind).value;
  requireCondition(value.kind !== 'artifact', 'BINDING_TYPE_MISMATCH', 'An artifact is not a host target.');
  return value;
}
export function resolveAsset(binding: AssetBinding, inputs: Record<string, AssetRef>, receipts: Map<string, OperationReceipt>): AssetRef {
  if (binding.kind === 'input') {
    const input = inputs[binding.inputKey]; requireCondition(input, 'RECIPE_INPUT_MISSING', `Missing input ${binding.inputKey}.`); return input;
  }
  const receipt = receipts.get(binding.stepKey);
  requireCondition(receipt?.status === 'SUCCEEDED', 'BINDING_PRODUCER_NOT_COMPLETE', `Producer ${binding.stepKey} has not succeeded.`);
  const value = selectResource(receipt.resources[binding.slot], binding.itemKey, 'artifact').value;
  requireCondition(value.kind === 'artifact', 'BINDING_TYPE_MISMATCH', 'This binding must refer to an artifact.');
  return (value as ArtifactReceipt).asset;
}
export function validateResourceOutput(output: ResourceOutput): void {
  const items = output.kind === 'single' ? [output.item] : output.items;
  const kinds: Record<ResourceKind, string[]> = { document: ['ps_document'], layer: ['ps_layer'], project: ['pr_project'], project_item: ['pr_project_item'], sequence: ['pr_sequence'], track: ['pr_track'], clip: ['pr_clip'], artifact: ['artifact'] };
  requireCondition(items.every(item => kinds[output.resourceKind]?.includes(item.value.kind)), 'BINDING_TYPE_MISMATCH', 'Resource values do not match the slot kind.');
  requireCondition(new Set(items.map(item => item.itemKey)).size === items.length, 'BINDING_NOT_UNIQUE', 'Resource itemKeys must be unique.');
  if (output.kind === 'collection') requireCondition(!output.complete || !output.nextCursor, 'BINDING_INCOMPLETE', 'Complete collections cannot also have a next cursor.');
}
