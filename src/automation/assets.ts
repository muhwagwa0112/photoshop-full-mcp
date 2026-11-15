import { createReadStream } from 'node:fs';
import { constants, copyFile, mkdir, open, realpath, stat, rename, unlink, link, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ArtifactSpec, AssetLocator, AssetRef, MediaInfo } from './contracts.js';
import { AutomationError, requireCondition } from './errors.js';
import { digest, parseStrictJson } from './canonical.js';

export interface AssetRoot { path: string; readOnly?: boolean }
export type AssetRoots = Record<string, string | AssetRoot>;
const MIME: Record<string, [MediaInfo['kind'], string]> = {
  '.psd': ['project', 'image/vnd.adobe.photoshop'], '.psb': ['project', 'image/vnd.adobe.photoshop'],
  '.prproj': ['project', 'application/vnd.adobe.premiere'], '.png': ['image', 'image/png'],
  '.jpg': ['image', 'image/jpeg'], '.jpeg': ['image', 'image/jpeg'], '.tif': ['image', 'image/tiff'], '.tiff': ['image', 'image/tiff'],
  '.webp': ['image', 'image/webp'], '.mp4': ['video', 'video/mp4'], '.mov': ['video', 'video/quicktime'],
  '.mxf': ['video', 'application/mxf'], '.wav': ['audio', 'audio/wav'], '.mp3': ['audio', 'audio/mpeg'],
  '.flac': ['audio', 'audio/flac'], '.m4a': ['audio', 'audio/mp4'], '.srt': ['subtitle', 'application/x-subrip'],
  '.vtt': ['subtitle', 'text/vtt'], '.json': ['metadata', 'application/json'], '.epr': ['metadata', 'application/xml']
};
export async function hashFile(file: string): Promise<{ sha256: string; sizeBytes: string }> {
  const hash = createHash('sha256'); let size = 0n;
  for await (const chunk of createReadStream(file)) { const bytes = chunk as Buffer; hash.update(bytes); size += BigInt(bytes.length); }
  return { sha256: hash.digest('hex'), sizeBytes: String(size) };
}
function inside(root: string, value: string): boolean {
  const rel = path.relative(root, value);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
function relative(value: string): string {
  requireCondition(typeof value === 'string' && value.length > 0 && !value.includes('\0'), 'INVALID_ASSET_PATH', 'A nonempty relative path is required.');
  const portable = value.replaceAll('\\', '/');
  requireCondition(!portable.startsWith('/') && !/^[a-zA-Z]:/.test(portable) && !portable.split('/').some(part => part === '..'), 'ASSET_ROOT_ESCAPE', 'Asset paths cannot escape their registered root.');
  return portable;
}
function safePart(value: string): string {
  requireCondition(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,160}$/.test(value) && value !== '..', 'INVALID_PATH_COMPONENT', `Invalid path component: ${value}`);
  return value;
}
export class AssetStore {
  private readonly roots = new Map<string, AssetRoot>();
  private readonly protectedSources = new Set<string>();
  constructor(roots: AssetRoots, public readonly dataDirectory: string) {
    for (const [id, value] of Object.entries(roots)) {
      requireCondition(id !== '__automation', 'RESERVED_ROOT', '__automation is an internal root.');
      this.roots.set(id, typeof value === 'string' ? { path: path.resolve(value) } : { ...value, path: path.resolve(value.path) });
    }
    this.roots.set('__automation', { path: path.resolve(dataDirectory, 'assets') });
  }
  async initialize(): Promise<void> { for (const root of this.roots.values()) if (!root.readOnly) await mkdir(root.path, { recursive: true }); }
  async protectSource(asset: AssetRef): Promise<void> { this.protectedSources.add(await this.pathFor(asset)); }
  rootPaths(): string[] { return [...this.roots.values()].map(root => root.path); }
  rootDescriptions(): { rootId: string; readOnly: boolean }[] { return [...this.roots].filter(([rootId]) => rootId !== '__automation').map(([rootId, root]) => ({ rootId, readOnly: root.readOnly === true })); }
  private async checkedPath(locator: AssetLocator, writable = false, existing = true): Promise<string> {
    const root = this.roots.get(locator.rootId);
    requireCondition(root, 'UNKNOWN_ASSET_ROOT', `Unregistered asset root: ${locator.rootId}`);
    requireCondition(!writable || !root.readOnly, 'READ_ONLY_ROOT', `Root ${locator.rootId} is read-only.`);
    const base = await realpath(root.path); const candidate = path.resolve(base, relative(locator.relativePath));
    requireCondition(inside(base, candidate), 'ASSET_ROOT_ESCAPE', 'Asset escapes registered root.');
    let check = candidate;
    if (!existing) {
      check = path.dirname(candidate);
      const missing: string[] = [];
      for (;;) {
        try { await stat(check); break; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          missing.push(path.basename(check)); check = path.dirname(check);
        }
      }
      requireCondition(inside(base, await realpath(check)), 'ASSET_SYMLINK_ESCAPE', 'Output parent escapes its root.');
      let parent = await realpath(check);
      for (const name of missing.reverse()) { parent = path.join(parent, name); await mkdir(parent).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }); requireCondition(inside(base, await realpath(parent)), 'ASSET_SYMLINK_ESCAPE', 'Output parent changed roots.'); }
      return candidate;
    }
    const actual = await realpath(check);
    requireCondition(inside(base, actual), 'ASSET_SYMLINK_ESCAPE', 'Asset symlink escapes its registered root.');
    requireCondition((await stat(actual)).isFile(), 'ASSET_NOT_FILE', 'Asset must be a regular file.');
    return actual;
  }
  async resolve(locator: AssetLocator, media?: MediaInfo): Promise<AssetRef> {
    const file = await this.checkedPath(locator); const fingerprint = await hashFile(file);
    const inferred = MIME[path.extname(file).toLowerCase()] ?? ['metadata', 'application/octet-stream'];
    return { rootId: locator.rootId, relativePath: relative(locator.relativePath), assetId: `sha256:${fingerprint.sha256}`, ...fingerprint,
      media: media ?? { kind: inferred[0], mimeType: inferred[1] } };
  }
  async pathFor(asset: AssetLocator | AssetRef): Promise<string> {
    const file = await this.checkedPath(asset);
    if ('sha256' in asset) {
      const current = await hashFile(file);
      requireCondition(current.sha256 === asset.sha256 && current.sizeBytes === asset.sizeBytes, 'ASSET_CHANGED', `Asset changed: ${asset.relativePath}`);
    }
    return file;
  }
  async locate(file: string): Promise<AssetLocator> {
    const actual = await realpath(file);
    const matches: { rootId: string; base: string }[] = [];
    for (const [rootId, root] of this.roots) {
      let base: string;
      try { base = await realpath(root.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (inside(base, actual)) matches.push({ rootId, base });
    }
    matches.sort((a, b) => b.base.length - a.base.length || (a.rootId === '__automation' ? -1 : b.rootId === '__automation' ? 1 : a.rootId.localeCompare(b.rootId)));
    if (matches[0]) return { rootId: matches[0].rootId, relativePath: path.relative(matches[0].base, actual).split(path.sep).join('/') };
    throw new AutomationError('ASSET_ROOT_ESCAPE', 'File is outside the registered roots.');
  }
  async registerGenerated(file: string, media?: MediaInfo): Promise<AssetRef> { return this.resolve(await this.locate(file), media); }
  async allocate(jobId: string, revisionId: string, filename: string): Promise<string> {
    return this.checkedPath({ rootId: '__automation', relativePath: `${safePart(jobId)}/${safePart(revisionId)}/${safePart(filename)}` }, true, false);
  }
  async stageCopy(asset: AssetRef, jobId: string, revisionId = 'working'): Promise<AssetRef> {
    const source = await this.pathFor(asset);
    const destination = await this.allocate(jobId, revisionId, `${randomUUID()}${path.extname(source)}`);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    const file = await open(destination, 'r+'); try { await file.sync(); } finally { await file.close(); }
    const staged = await this.registerGenerated(destination, asset.media);
    requireCondition(staged.sha256 === asset.sha256, 'COPY_HASH_MISMATCH', 'Working copy differs from its source.');
    // Working assets need a distinct identity even when their initial bytes match the source.
    return { ...staged, assetId: `working:${jobId}:${revisionId}:${randomUUID()}` };
  }
  async writeJson(jobId: string, revisionId: string, filename: string, value: unknown): Promise<AssetRef> {
    const destination = await this.allocate(jobId, revisionId, filename);
    const handle = await open(destination, 'wx');
    try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); } finally { await handle.close(); }
    return this.registerGenerated(destination, { kind: 'metadata', mimeType: 'application/json' });
  }
  async readJson(asset: AssetRef, maxBytes = 8_000_000): Promise<string> {
    requireCondition(BigInt(asset.sizeBytes) <= BigInt(maxBytes), 'ASSET_TOO_LARGE', 'Metadata exceeds its read limit.');
    return readFile(await this.pathFor(asset), 'utf8');
  }
  async publish(staged: AssetRef, spec: ArtifactSpec, sources: AssetRef[] = [], publicationId = `${staged.rootId}:${staged.relativePath}:${staged.sha256}`): Promise<AssetRef> {
    const intentDirectory = path.join(this.dataDirectory, 'publications'); await mkdir(intentDirectory, { recursive: true });
    const intentPath = path.join(intentDirectory, digest(publicationId) + '.json'); const requestDigest = digest({ staged, spec });
    let intent: { requestDigest: string; output: ArtifactSpec; sourceSha256: string };
    try { intent = parseStrictJson(await readFile(intentPath, 'utf8')) as typeof intent; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const ext = spec.format.toLowerCase().replace(/^\./, ''); const plain = spec.basename.toLowerCase().endsWith('.' + ext) ? spec.basename.slice(0, -(ext.length + 1)) : spec.basename;
      let chosen = spec;
      if (spec.collision.onConflict === 'error') {
        const locator = { rootId: spec.rootId, relativePath: `${spec.relativeDirectory ? spec.relativeDirectory.replace(/\/$/, '') + '/' : ''}${plain}.${ext}` };
        const destination = await this.checkedPath(locator, true, false);
        try { await stat(destination); throw new AutomationError('OUTPUT_CONFLICT', 'The requested output already exists.'); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
      }
      if (spec.collision.onConflict === 'version') {
        let found = false;
        for (let version = 0; version < 10000; version++) {
          const basename = version === 0 ? plain : `${plain}-${version}`;
          const locator = { rootId: spec.rootId, relativePath: `${spec.relativeDirectory ? spec.relativeDirectory.replace(/\/$/, '') + '/' : ''}${basename}.${ext}` };
          const candidate = await this.checkedPath(locator, true, false);
          try { await stat(candidate); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; chosen = { ...spec, basename, collision: { onConflict: 'error', preserveSource: true } }; found = true; break; }
        }
        requireCondition(found, 'OUTPUT_VERSION_LIMIT', 'No output version remains available.');
      }
      intent = { requestDigest, output: chosen, sourceSha256: staged.sha256 };
      try { const handle = await open(intentPath, 'wx'); try { await handle.writeFile(JSON.stringify(intent)); await handle.sync(); } finally { await handle.close(); } }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; intent = parseStrictJson(await readFile(intentPath, 'utf8')) as typeof intent; }
    }
    requireCondition(intent.requestDigest === requestDigest && intent.sourceSha256 === staged.sha256, 'IDEMPOTENCY_CONFLICT', 'Publication ID is already bound to different bytes or output semantics.');
    const output = intent.output; const ext = output.format.toLowerCase(); const filename = output.basename.toLowerCase().endsWith('.' + ext) ? output.basename : `${output.basename}.${ext}`;
    const locator = { rootId: output.rootId, relativePath: `${output.relativeDirectory ? output.relativeDirectory.replace(/\/$/, '') + '/' : ''}${filename}` };
    try {
      const actual = await this.resolve(locator, staged.media);
      const actualPath = await this.pathFor(actual);
      requireCondition(!this.protectedSources.has(actualPath) && !(await Promise.all(sources.map(source => this.pathFor(source)))).includes(actualPath), 'SOURCE_OVERWRITE_FORBIDDEN', 'An original source cannot be the publication destination.');
      if (actual.sha256 === staged.sha256) return actual;
      requireCondition(output.collision.onConflict === 'overwrite' && actual.sha256 === output.collision.expectedExistingSha256, 'OUTPUT_CONFLICT', 'The reserved publication destination contains different bytes.');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return this.publishOnce(staged, output, sources);
  }
  private async publishOnce(staged: AssetRef, spec: ArtifactSpec, sources: AssetRef[] = []): Promise<AssetRef> {
    requireCondition(spec.collision.preserveSource === true, 'SOURCE_PRESERVATION_REQUIRED', 'Publishing must preserve original inputs.');
    const source = await this.pathFor(staged);
    const basename = safePart(spec.basename); const ext = spec.format.toLowerCase().replace(/^\./, '');
    requireCondition(/^[a-z0-9]{1,12}$/.test(ext), 'INVALID_OUTPUT_FORMAT', 'Invalid output extension.');
    const filename = basename.toLowerCase().endsWith('.' + ext) ? basename : `${basename}.${ext}`;
    const dir = spec.relativeDirectory ? relative(spec.relativeDirectory).replace(/\/$/, '') + '/' : '';
    const sourcePaths = new Set([...this.protectedSources, ...await Promise.all(sources.map(asset => this.pathFor(asset)))]);
    for (let version = 0; version < 10_000; version++) {
      const name = version === 0 ? filename : `${filename.slice(0, -(ext.length + 1))}-${version}.${ext}`;
      const locator = { rootId: spec.rootId, relativePath: dir + name };
      const destination = await this.checkedPath(locator, true, false);
      requireCondition(!sourcePaths.has(destination), 'SOURCE_OVERWRITE_FORBIDDEN', 'An original source cannot be an output destination.');
      const temporary = `${destination}.${randomUUID()}.publishing`;
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      try {
        const checked = await hashFile(temporary); requireCondition(checked.sha256 === staged.sha256, 'PUBLISH_HASH_MISMATCH', 'Published bytes differ from staged output.');
        const handle = await open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
        if (spec.collision.onConflict === 'overwrite') {
          requireCondition(spec.collision.expectedExistingSha256, 'EXPECTED_OUTPUT_HASH_REQUIRED', 'Overwrite requires the expected existing output hash.');
          const existing = await this.checkedPath(locator);
          requireCondition(!sourcePaths.has(existing), 'SOURCE_OVERWRITE_FORBIDDEN', 'An original source cannot be overwritten.');
          requireCondition((await hashFile(existing)).sha256 === spec.collision.expectedExistingSha256, 'OUTPUT_CONFLICT', 'Existing output does not match the approved hash.');
          await rename(temporary, destination);
        } else {
          // Linking publishes atomically without replacing an existing destination.
          await link(temporary, destination); await unlink(temporary);
        }
        return this.resolve(locator, staged.media);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && spec.collision.onConflict === 'version') continue;
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AutomationError('OUTPUT_CONFLICT', `Output already exists: ${locator.relativePath}`);
        throw error;
      }
    }
    throw new AutomationError('OUTPUT_VERSION_LIMIT', 'No unused output filename found within the version limit.');
  }
}
