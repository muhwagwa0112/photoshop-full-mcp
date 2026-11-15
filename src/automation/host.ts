import type { AssetRef, CheckpointRecord, HostAdapter, HostRef, MaterializationGroup, ResourceOutput, TargetRef } from './contracts.js';
export type { HostAdapter, HostRef, OperationRequest, OperationReceipt, Capability } from './contracts.js';

export interface CheckpointContext {
  jobId: string;
  revisionId: string;
  group: MaterializationGroup;
  target: TargetRef;
  destination: AssetRef;
  savedThrough: CheckpointRecord['savedThrough'];
}
export interface RestoreContext {
  jobId: string;
  revisionId: string;
  group: MaterializationGroup;
  workingCopy: AssetRef;
  checkpoint?: CheckpointRecord;
}
/** Optional native save/rebind hooks. Without them the runner replays from a fresh source copy. */
export interface MaterializingHostAdapter extends HostAdapter {
  checkpoint?(context: CheckpointContext): Promise<CheckpointRecord>;
  restoreCheckpoint?(context: RestoreContext): Promise<{
    host: HostRef;
    resources: Record<string, ResourceOutput>;
    roles: Record<string, TargetRef>;
  }>;
}
export interface HostRegistration {
  adapter: MaterializingHostAdapter;
  resolveHost: () => Promise<HostRef>;
}
