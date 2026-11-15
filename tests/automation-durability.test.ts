import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DurableJournal } from '../src/automation/journal.js';
import { retainJournal } from '../src/automation/retention.js';
import { digest } from '../src/automation/canonical.js';
import type { JobReceipt, OperationReceipt, SubmissionReceipt } from '../src/automation/contracts.js';

const isCode = (code: string) => (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === code;

test('durable acceptance creates one result for simultaneous equal identities and rejects changed payloads after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-accept-'));
  let journal = new DurableJournal(directory, 'acceptance');
  try {
    await journal.initialize(); let creates = 0;
    const make = () => ({ id: ++creates });
    const results = await Promise.all([journal.acceptOnce('submission', 'request', digest('same'), make), journal.acceptOnce('submission', 'request', digest('same'), make)]);
    assert.equal(creates, 1); assert.deepEqual(results.map(item => item.existing), [false, true]);
    assert.deepEqual(results.map(item => item.value), [{ id: 1 }, { id: 1 }]);
    await assert.rejects(journal.acceptOnce('submission', 'request', digest('changed'), make), isCode('IDEMPOTENCY_CONFLICT'));
    await journal.close(); journal = new DurableJournal(directory, 'acceptance'); await journal.initialize();
    assert.deepEqual(await journal.acceptOnce('submission', 'request', digest('same'), make), { existing: true, value: { id: 1 } });
    assert.equal(creates, 1); assert.equal(journal.all('submission.accepted').length, 1);
  } finally { await journal.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const phase of ['append', 'sync'] as const) test(`an actual ${phase} I/O failure poisons later writes and acceptance`, async () => {
  const directory = await mkdtemp(join(tmpdir(), `automation-${phase}-failure-`));
  const journal = new DurableJournal(directory, phase);
  try {
    await journal.initialize(); await journal.append('seed', 'seed', { value: 1 });
    // Fault injection closes a real OS descriptor. The write/sync operation
    // still runs against the filesystem and must return its actual EBADF.
    const handle = (journal as unknown as { handle: FileHandle }).handle;
    if (phase === 'append') await handle.close();
    else {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { await handle.close(); await sync(); };
    }
    await assert.rejects(journal.append('operation.intent', 'attempt', { value: 2 }), isCode('EBADF'));
    assert.equal(journal.all().length, 1, 'failed durability cannot be acknowledged in memory');
    await assert.rejects(journal.append('operation.intent', 'later', { value: 3 }), isCode('JOURNAL_WRITE_POISONED'));
    let created = false;
    await assert.rejects(journal.acceptOnce('operation', 'later', digest('later'), () => { created = true; return {}; }), isCode('JOURNAL_WRITE_POISONED'));
    assert.equal(created, false);
  } finally { await journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('compaction expires terminal bodies while preserving identity tombstones and unknown or pending work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'automation-retention-')), namespace = 'retention';
  let journal = new DurableJournal(directory, namespace);
  const workflowHome = { app: 'photoshop' as const, installationId: 'test-installation', namespaceId: namespace };
  async function record(key: string, status: 'SUCCEEDED' | 'OUTCOME_UNKNOWN', pending = false): Promise<void> {
    const jobId = `job-${key}`, revisionId = `revision-${key}`, operationId = `operation-${key}`;
    const submission: SubmissionReceipt = { requestId: key, requestDigest: digest(key), workflowHome, jobId, revisionId, resultRetention: 'available' };
    await journal.acceptOnce('submission', key, digest(key), () => ({ submission, plan: { largeResult: `${key}-BODY-`.repeat(1024) } }));
    await journal.acceptOnce('operation', operationId, digest(operationId), () => ({ operationId, jobId, revisionId, args: { largeResult: `${key}-OPERATION-`.repeat(1024) } }));
    const receipt: JobReceipt = { jobId, revisionId, status: 'COMPLETED', operations: [{ stepKey: key, operationId, status }], artifacts: [], requirementResults: [], checkpoints: [], modelUsage: [], unresolved: [] };
    await journal.append('job.state', jobId, { receipt, ...(pending ? { pendingControllerId: `controller-${key}` } : {}) });
    const common = { operationId, requestDigest: digest(operationId), host: { app: 'photoshop' as const, installationId: 'test-installation', hostEpoch: 'epoch' }, effect: status === 'OUTCOME_UNKNOWN' ? 'unknown' as const : 'applied' as const, resources: {}, verification: [], evidence: [], artifacts: [], cancelRequested: false, recovery: { authorityId: namespace, authorityGeneration: 'generation', savedThroughOperationIds: [], effectEvidence: 'none' as const }, timestamps: { accepted: new Date().toISOString() } };
    const operation: OperationReceipt = status === 'SUCCEEDED'
      ? { ...common, status, dataState: 'complete', dataSchemaId: 'query.inventory.v1', data: { resourceSlot: 'items', totalReturned: 0, complete: true } }
      : { ...common, status, dataState: 'unavailable', dataSchemaId: null, data: null, dataReason: 'not_observed' };
    await journal.append('operation.receipt', operationId, operation);
    await journal.append('image.geometry', `${operationId}:${digest('region')}`, { sourceAssetId: `asset-${key}`, geometry: `${key}-GEOMETRY-`.repeat(256) });
    if (pending) await journal.append('controller.request', `controller-${key}`, { request: { requestId: `controller-${key}`, jobId, revisionId }, state: 'waiting' });
  }
  try {
    await journal.initialize();
    await record('old', 'SUCCEEDED'); await record('new', 'SUCCEEDED'); await record('unknown', 'OUTCOME_UNKNOWN'); await record('pending', 'SUCCEEDED', true);
    const limits = { maxCompletedRevisions: 1, maxRetainedBytes: 1_000_000 };
    const projection = retainJournal(journal.all(), limits);
    assert.deepEqual(projection.expiredRevisions, ['revision-old']);
    for (const key of ['new', 'unknown', 'pending']) assert.ok(projection.entries.some(event => event.type === 'operation.receipt' && event.key === `operation-${key}`));
    assert.ok(!projection.entries.some(event => event.type === 'operation.receipt' && event.key === 'operation-old'));
    assert.ok(!projection.entries.some(event => event.type === 'image.geometry' && event.key.startsWith('operation-old:')));
    assert.ok(projection.entries.some(event => event.type === 'image.geometry' && event.key.startsWith('operation-unknown:')));
    assert.ok(projection.entries.some(event => event.type === 'submission.expired' && event.key === 'old'));
    assert.ok(projection.entries.some(event => event.type === 'operation.expired' && event.key === 'operation-old'));
    assert.ok(projection.entries.some(event => event.type === 'controller.request' && event.key === 'controller-pending'));
    const byteLimited = retainJournal(journal.all(), { maxCompletedRevisions: 100, maxRetainedBytes: 1 });
    assert.deepEqual(byteLimited.expiredRevisions, ['revision-old', 'revision-new']);
    assert.ok(byteLimited.protectedBodyBytes > 1, 'unresolved work remains durable even when it exceeds the settled-body budget');
    await journal.compact(events => retainJournal(events, limits).entries);
    await journal.close(); journal = new DurableJournal(directory, namespace); await journal.initialize();
    assert.equal(journal.isExpired('submission', 'old'), true); assert.equal(journal.isExpired('operation', 'operation-old'), true);
    let creates = 0;
    const reused = await journal.acceptOnce('submission', 'old', digest('old'), () => { creates++; return {}; });
    assert.equal(reused.existing, true); assert.equal(creates, 0);
    await assert.rejects(journal.acceptOnce('submission', 'old', digest('different'), () => ({})), isCode('IDEMPOTENCY_CONFLICT'));
    assert.equal(journal.latest<OperationReceipt>('operation.receipt', 'operation-unknown')?.status, 'OUTCOME_UNKNOWN');
    const bytes = await readFile(join(directory, 'journals', digest(namespace), 'events.jsonl'), 'utf8');
    assert.ok(!bytes.includes('old-BODY-') && !bytes.includes('old-OPERATION-') && !bytes.includes('old-GEOMETRY-'));
    assert.ok(bytes.includes('unknown-BODY-') && bytes.includes('pending-BODY-') && bytes.includes('unknown-GEOMETRY-'));
  } finally { await journal.close(); await rm(directory, { recursive: true, force: true }); }
});
