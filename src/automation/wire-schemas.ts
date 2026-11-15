import type { Schema } from './validation.js';
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const str: Schema = { type: 'string', minLength: 1 };
const decimal: Schema = { type: 'string', pattern: '^-?(0|[1-9][0-9]*)$' };
const rationalSchema = obj({ num: { type: 'integer', minimum: 1 }, den: { type: 'integer', minimum: 1 } });
const rectSchema = obj({ x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 } });
const strings = { type: 'array', items: str }; const sha = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const integer = { type: 'integer', minimum: 0 }; const positive = { type: 'integer', minimum: 1 }; const boolean = { type: 'boolean' };
const optional = (properties: Record<string, unknown>, required: string[] = []): Schema => obj(properties, required);
export const hostSchema = obj({ app: { enum: ['photoshop', 'premiere'] }, installationId: str, hostEpoch: str });
const time = obj({ ticks: decimal }); const range = obj({ start: time, end: time });
const color = optional({ iccProfile: str, primaries: str, transfer: str, matrix: str, bitDepth: { enum: [8, 10, 12, 16, 32] }, range: { enum: ['full', 'limited'] }, alpha: { enum: ['none', 'straight', 'premultiplied'] } }, ['bitDepth', 'range', 'alpha']);
const media = optional({ kind: { enum: ['image', 'video', 'audio', 'project', 'subtitle', 'metadata'] }, mimeType: str, width: positive, height: positive, frameRate: rationalSchema, durationTicks: decimal, sampleRate: positive, channels: positive, color }, ['kind', 'mimeType']);
export const assetSchema = obj({ rootId: str, relativePath: str, assetId: str, sha256: sha, sizeBytes: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' }, media });
const targetBase = { host: hostSchema, workingAssetId: str }; const project = { ...targetBase, projectGuid: str }; const sequence = { ...project, sequenceGuid: str };
const track = { ...sequence, mediaType: { enum: ['video', 'audio', 'caption'] }, trackIndex: integer, trackFingerprint: sha };
export const targetSchema: Schema = { oneOf: [
  obj({ kind: { const: 'ps_document' }, ...targetBase, documentId: positive }),
  obj({ kind: { const: 'ps_layer' }, ...targetBase, documentId: positive, layerIds: { type: 'array', items: positive, minItems: 1, uniqueItems: true } }),
  obj({ kind: { const: 'pr_project' }, ...project }),
  optional({ kind: { const: 'pr_project_item' }, ...project, projectItemId: str, sourceAssetId: str, uxpHandleId: str }, ['kind', 'host', 'workingAssetId', 'projectGuid', 'projectItemId', 'sourceAssetId']),
  obj({ kind: { const: 'pr_sequence' }, ...sequence }),
  obj({ kind: { const: 'pr_track' }, ...track }),
  optional({ kind: { const: 'pr_clip' }, ...track, mediaType: { enum: ['video', 'audio'] }, clipKey: str, sourceAssetId: str, cepNodeId: str, uxpHandleId: str, sourceRange: range, timelineRange: range, structuralFingerprint: sha }, ['kind', 'host', 'workingAssetId', 'projectGuid', 'sequenceGuid', 'mediaType', 'trackIndex', 'trackFingerprint', 'clipKey', 'sourceAssetId', 'sourceRange', 'timelineRange', 'structuralFingerprint'])
] };
const verification = optional({ assertionId: str, status: { enum: ['pass', 'fail', 'not_run'] }, expected: {}, actual: {}, method: str }, ['assertionId', 'status', 'method']);
const resolvedEncoding = optional({ spec: { $ref: 'https://adobe-mcp.local/contracts/recipe-request.schema.json#/$defs/encoding' }, presetAsset: assetSchema, normalizedMedia: media, normalizedRange: range, expectedPixelAspect: rationalSchema }, ['spec', 'normalizedMedia']);
const artifact = optional({ kind: { const: 'artifact' }, asset: assetSchema, operationId: str, sourceAssets: strings, recipeDigest: sha, published: boolean, verification: { type: 'array', items: verification }, resolvedEncoding }, ['kind', 'asset', 'operationId', 'sourceAssets', 'recipeDigest', 'published', 'verification']);
const item = optional({ itemKey: str, logicalRole: str, value: { oneOf: [targetSchema, artifact] }, projection: { type: 'object' }, projectionVersion: { const: 1 }, structuralFingerprint: sha }, ['itemKey', 'value']);
const resourceKind = { enum: ['document', 'layer', 'project', 'project_item', 'sequence', 'track', 'clip', 'artifact'] };
const resource = { oneOf: [obj({ kind: { const: 'single' }, resourceKind, item }), optional({ kind: { const: 'collection' }, resourceKind, items: { type: 'array', items: item }, complete: boolean, nextCursor: str }, ['kind', 'resourceKind', 'items', 'complete'])] };
const evidenceBase = { evidenceKey: str, operationId: str, sourceAssetIds: strings, snapshotDigest: sha, capturedAt: { type: 'string', format: 'date-time' }, artifact: assetSchema };
const evidence = { oneOf: [
  optional({ ...evidenceBase, kind: { enum: ['composite', 'layer', 'roi', 'mask', 'frame', 'contact_sheet'] }, target: targetSchema, sourceBounds: rectSchema, width: positive, height: positive, color, evidenceToSource: { type: 'array', items: { type: 'number' }, minItems: 6, maxItems: 6 }, temporal: optional({ requested: time, resolved: time, sequenceGuid: str, isProxy: boolean, sourceTimeMappingAssetId: str }, ['requested', 'resolved', 'isProxy']), tiles: { type: 'array', items: obj({ boundsInEvidence: rectSchema, requested: time, resolved: time }) } }, [...Object.keys(evidenceBase), 'kind', 'sourceBounds', 'width', 'height', 'color', 'evidenceToSource']),
  optional({ ...evidenceBase, kind: { const: 'audio_measurement' }, timeRange: range, sampleRate: positive, channels: positive, integratedLufs: { type: 'number' }, truePeakDbtp: { type: 'number' }, residualSyncOffsetSamples: decimal, method: str }, [...Object.keys(evidenceBase), 'kind', 'timeRange', 'sampleRate', 'channels', 'method']),
  optional({ ...evidenceBase, kind: { enum: ['transcript', 'cut_map', 'metadata'] }, dataSchemaId: str, data: { type: 'object' }, clock: { enum: ['source', 'timeline', 'document'] }, timeRange: range, complete: boolean }, [...Object.keys(evidenceBase), 'kind', 'dataSchemaId', 'data', 'clock', 'complete'])
] };
const recovery = optional({ authorityId: str, authorityGeneration: str, hostReceiptId: str, beforeDigest: sha, afterDigest: sha, afterState: obj({ projectionVersion: { const: 1 }, fields: { type: 'object' }, digest: sha }), checkpointId: str, savedThroughOperationIds: strings, undoScope: obj({ ownedWorkingAssetId: str, scopeId: str, rollbackVerified: boolean }), effectEvidence: { enum: ['host_receipt', 'postcondition', 'owned_checkpoint', 'none'] } }, ['authorityId', 'authorityGeneration', 'savedThroughOperationIds', 'effectEvidence']);
const error = obj({ code: str, message: { type: 'string' }, retrySafe: boolean, nextAction: { enum: ['none', 'query_receipt', 'read_postcondition', 'restore_owned_checkpoint', 'new_plan'] } });
export const receiptSchema: Schema = {
  ...optional({ operationId: str, requestDigest: sha, host: hostSchema, status: { enum: ['QUEUED', 'PREPARED', 'DISPATCH_INTENT', 'RUNNING', 'APPLIED_UNVERIFIED', 'SUCCEEDED', 'FAILED_NO_EFFECT', 'FAILED_WITH_EFFECT', 'OUTCOME_UNKNOWN', 'CANCEL_REQUESTED', 'CANCELLED_NO_EFFECT', 'CANCELLED_WITH_EFFECT'] }, effect: { enum: ['not_applied', 'applied', 'rolled_back', 'partial', 'unknown'] }, targetBefore: targetSchema, targetAfter: targetSchema, resources: { type: 'object', additionalProperties: resource }, verification: { type: 'array', items: verification }, evidence: { type: 'array', items: evidence }, recovery, artifacts: { type: 'array', items: artifact }, error, cancelRequested: boolean, timestamps: optional({ accepted: { type: 'string', format: 'date-time' }, dispatched: { type: 'string', format: 'date-time' }, applied: { type: 'string', format: 'date-time' }, finalized: { type: 'string', format: 'date-time' } }, ['accepted']), dataState: { enum: ['complete', 'partial', 'unavailable'] }, dataSchemaId: { type: ['string', 'null'] }, data: { type: ['object', 'null'] }, dataReason: { enum: ['not_started', 'not_observed', 'not_produced'] }, missingResultFields: { type: 'array', items: str, minItems: 1 } }, ['operationId', 'requestDigest', 'host', 'status', 'effect', 'resources', 'verification', 'evidence', 'recovery', 'artifacts', 'cancelRequested', 'timestamps', 'dataState', 'dataSchemaId', 'data']),
  allOf: [
    { if: { properties: { status: { const: 'SUCCEEDED' } } }, then: { properties: { dataState: { const: 'complete' } } } },
    { if: { properties: { dataState: { const: 'unavailable' } } }, then: { properties: { data: { type: 'null' }, dataSchemaId: { type: 'null' } }, required: ['dataReason'], not: { required: ['missingResultFields'] } }, else: { properties: { data: { type: 'object' }, dataSchemaId: str }, not: { required: ['dataReason'] } } },
    { if: { properties: { dataState: { const: 'partial' } } }, then: { required: ['missingResultFields'] }, else: { not: { required: ['missingResultFields'] } } }
  ]
};
