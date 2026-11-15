import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

const argumentsMap = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1];
  if (!['--endpoint', '--output'].includes(key) || !value) throw new Error('Usage: node scripts/record-controller-profile.mjs --output <absolute-new-file> [--endpoint http://127.0.0.1:11434]');
  argumentsMap.set(key, value);
}
const output = argumentsMap.get('--output');
if (!output || !isAbsolute(output)) throw new Error('--output must name a new absolute file');
const endpoint = new URL(argumentsMap.get('--endpoint') ?? 'http://127.0.0.1:11434');
if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || !['', '/'].includes(endpoint.pathname) || endpoint.search || endpoint.hash) throw new Error('Only a numeric loopback HTTP endpoint is allowed');
const modelTag = 'gemma3:4b';
async function json(path, body) {
  const response = await fetch(new URL(path, endpoint), { method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}), redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}
const [tags, show, version] = await Promise.all([json('/api/tags'), json('/api/show', { model: modelTag }), json('/api/version')]);
const model = tags.models?.find(item => item.name === modelTag);
if (!model || !/^(?:sha256:)?[a-f0-9]{64}$/.test(model.digest)) throw new Error('Install the selected local model before recording its profile; this command never downloads it');
if (model.remote_host || model.remote_model || show.remote_host || show.remote_model) throw new Error('Remote/cloud model routing is not permitted by this provider');
if (!Array.isArray(show.capabilities) || !show.capabilities.includes('vision')) throw new Error('The installed model does not advertise vision input');
if (typeof version.version !== 'string' || !version.version) throw new Error('Ollama did not return its runtime version');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Provider metadata contains a nonfinite number');
  return JSON.stringify(value);
}
const snapshot = { template: show.template ?? null, parameters: show.parameters ?? null, modelInfo: show.model_info ?? null, projectorInfo: show.projector_info ?? null, capabilities: show.capabilities ?? [] };
const controller = { providerId: 'local-vision-gemma3-4b', endpoint: endpoint.origin, modelTag, modelDigest: model.digest, templateDigest: createHash('sha256').update(canonical(snapshot)).digest('hex'), runtimeVersion: version.version, numCtx: null, maxOutputTokensPerCall: null, inputTokenUpperBound: null, inputBoundQualified: false, inputLimits: { maxUtf8TextBytes: null, maxImages: null, maxImagePixels: null } };
await mkdir(dirname(output), { recursive: true });
const handle = await open(output, 'wx', 0o600);
try { await handle.writeFile(JSON.stringify({ controller, observedSnapshot: snapshot, qualification: 'not_run' }, null, 2) + '\n'); await handle.sync(); }
finally { await handle.close(); }
process.stdout.write(`Recorded ${output}. Input budget fields remain unqualified; no inference or model download was performed.\n`);
