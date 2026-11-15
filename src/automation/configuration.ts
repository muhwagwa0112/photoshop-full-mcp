import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { AssetRoots } from './assets.js';
import type { AssetLocator } from './contracts.js';
import type { OllamaProfile } from './controller.js';

export interface AutomationConfiguration {
  roots: AssetRoots;
  presets: Record<string, AssetLocator>;
  sequencePresets: Record<string, AssetLocator>;
  controller?: OllamaProfile;
  setupIssues: string[];
}
export interface AutomationConfigurationOptions {
  dataDirectory: string;
  legacyRoots?: readonly string[];
  defaultRoots?: AssetRoots;
  defaultOutputDirectory?: string;
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${name} field: ${key}`);
}
function positive(value: unknown, name: string, maximum = 1_000_000_000): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new Error(`${name} must be a bounded positive integer`);
  return Number(value);
}
function rootValues(value: unknown): AssetRoots {
  const result: AssetRoots = {};
  for (const [id, raw] of Object.entries(object(value, 'roots'))) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(id)) throw new Error(`Invalid asset root ID: ${id}`);
    const root = typeof raw === 'string' ? { path: raw } : object(raw, `roots.${id}`);
    keys(root, ['path', 'readOnly'], `roots.${id}`);
    if (typeof root.path !== 'string' || !isAbsolute(root.path)) throw new Error(`roots.${id}.path must be absolute`);
    if (root.readOnly !== undefined && typeof root.readOnly !== 'boolean') throw new Error(`roots.${id}.readOnly must be boolean`);
    result[id] = { path: resolve(root.path), ...(root.readOnly === undefined ? {} : { readOnly: root.readOnly }) };
  }
  return result;
}
function presets(value: unknown, roots: AssetRoots, name: string): Record<string, AssetLocator> {
  if (value === undefined) return {};
  const result: Record<string, AssetLocator> = {};
  for (const [id, raw] of Object.entries(object(value, name))) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(id)) throw new Error(`Invalid preset ID: ${id}`);
    const locator = object(raw, `${name}.${id}`);
    keys(locator, ['rootId', 'relativePath'], `${name}.${id}`);
    if (typeof locator.rootId !== 'string' || !roots[locator.rootId] || typeof locator.relativePath !== 'string' || !locator.relativePath || isAbsolute(locator.relativePath) || locator.relativePath.replaceAll('\\', '/').split('/').includes('..')) throw new Error(`${name}.${id} must reference a file under a declared root`);
    result[id] = { rootId: locator.rootId, relativePath: locator.relativePath };
  }
  return result;
}
/** Load installation configuration only. Request payloads cannot expand roots or providers. */
export async function loadAutomationConfiguration(options: AutomationConfigurationOptions): Promise<AutomationConfiguration> {
  const path = resolve(process.env.ADOBE_MCP_AUTOMATION_CONFIG ?? resolve(options.dataDirectory, 'profiles/automation.json'));
  const defaults: AssetRoots = { ...(options.defaultRoots ?? {}) };
  for (const [index, directory] of (options.legacyRoots ?? []).entries()) defaults[`legacy_${index + 1}`] = { path: resolve(directory) };
  if (options.defaultOutputDirectory) defaults.output = { path: resolve(options.defaultOutputDirectory) };
  let raw: Record<string, unknown>;
  try {
    if ((await stat(path)).size > 1_048_576) throw new Error('Automation configuration exceeds 1 MiB');
    raw = object(JSON.parse(await readFile(path, 'utf8')), 'configuration');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !process.env.ADOBE_MCP_AUTOMATION_CONFIG) return { roots: defaults, presets: {}, sequencePresets: {}, setupIssues: ['Local model provider and presets are not configured; client_agent workflows remain available.'] };
    throw error;
  }
  keys(raw, ['schemaVersion', 'roots', 'presets', 'sequencePresets', 'controller'], 'configuration');
  if (raw.schemaVersion !== 1) throw new Error('Automation configuration requires schemaVersion=1');
  // An explicit root map replaces legacy defaults; it never silently broadens them.
  const roots = raw.roots === undefined ? defaults : rootValues(raw.roots);
  const result: AutomationConfiguration = { roots, presets: presets(raw.presets, roots, 'presets'), sequencePresets: presets(raw.sequencePresets, roots, 'sequencePresets'), setupIssues: [] };
  if (raw.controller !== undefined) {
    const value = object(raw.controller, 'controller');
    keys(value, ['providerId', 'endpoint', 'modelTag', 'modelDigest', 'templateDigest', 'numCtx', 'maxOutputTokensPerCall', 'inputTokenUpperBound', 'inputBoundQualified', 'inputLimits', 'maxPayloadBytes', 'runtimeVersion'], 'controller');
    for (const name of ['providerId', 'endpoint', 'modelTag', 'modelDigest']) if (typeof value[name] !== 'string' || !value[name]) throw new Error(`controller.${name} is required`);
    const endpoint = new URL(String(value.endpoint));
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || !['', '/'].includes(endpoint.pathname) || endpoint.search || endpoint.hash) throw new Error('Controller endpoint must be numeric loopback HTTP');
    if (value.inputBoundQualified !== true) {
      result.setupIssues.push('The local controller profile is recorded but its input-budget bounds are not qualified.');
      return result;
    }
    if (value.inputLimits === undefined || typeof value.templateDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.templateDigest)) {
      result.setupIssues.push('Configured provider needs qualified input-token bounds, explicit text/image limits and the actual template snapshot digest.');
      return result;
    }
    const limits = object(value.inputLimits, 'controller.inputLimits');
    keys(limits, ['maxUtf8TextBytes', 'maxImages', 'maxImagePixels'], 'controller.inputLimits');
    if (typeof limits.maxImagePixels !== 'string' || !/^[1-9][0-9]*$/.test(limits.maxImagePixels)) throw new Error('controller.inputLimits.maxImagePixels must be a positive decimal integer string');
    const profile: OllamaProfile = {
      providerId: String(value.providerId), endpoint: String(value.endpoint), modelTag: String(value.modelTag), modelDigest: String(value.modelDigest), templateDigest: value.templateDigest,
      numCtx: positive(value.numCtx, 'controller.numCtx'), maxOutputTokensPerCall: positive(value.maxOutputTokensPerCall, 'controller.maxOutputTokensPerCall'),
      inputTokenUpperBound: positive(value.inputTokenUpperBound, 'controller.inputTokenUpperBound'), inputBoundQualified: value.inputBoundQualified === true,
      inputLimits: { maxUtf8TextBytes: positive(limits.maxUtf8TextBytes, 'controller.inputLimits.maxUtf8TextBytes'), maxImages: positive(limits.maxImages, 'controller.inputLimits.maxImages', 1024), maxImagePixels: limits.maxImagePixels },
    };
    if (value.maxPayloadBytes !== undefined) profile.maxPayloadBytes = positive(value.maxPayloadBytes, 'controller.maxPayloadBytes');
    if (value.runtimeVersion !== undefined) { if (typeof value.runtimeVersion !== 'string' || !value.runtimeVersion) throw new Error('controller.runtimeVersion must be a nonempty string'); profile.runtimeVersion = value.runtimeVersion; }
    if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(profile.modelDigest) || !profile.inputBoundQualified) result.setupIssues.push('Configured provider needs the installed full model digest and a qualified input-token upper bound with explicit text/image limits.');
    else {
      if (profile.inputTokenUpperBound + profile.maxOutputTokensPerCall > profile.numCtx) throw new Error('Controller input/output bounds exceed numCtx');
      result.controller = profile;
    }
  } else result.setupIssues.push('No local controller configured; use client_agent or configure the local provider.');
  return result;
}
