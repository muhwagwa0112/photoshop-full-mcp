import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type WorkerOperation = "media.inspect" | "media.frames" | "media.conform" | "media.transcribe" | "audio.analyze" | "audio.render" | "audio.sync" | "image.segment" | "image.inpaint" | "artifact.verify";
export interface WorkerRequest {
  workerRequestId: string;
  operation: WorkerOperation;
  inputs: Record<string, { path: string; sha256?: string }>;
  options: Record<string, unknown>;
  outputDirectory: string;
  limits: { maxCpuThreads: number; maxTemporaryBytes: string; maxOutputBytes: number; timeoutMs: number };
  providerIdentity?: WorkerIdentity;
}
export interface WorkerArtifact {
  path: string; sha256: string; sizeBytes: string; kind: string; mimeType: string;
  metadata?: Record<string, unknown>;
}
export interface WorkerResult {
  workerRequestId: string; operation: WorkerOperation; ok: boolean;
  data: Record<string, unknown>; artifacts: WorkerArtifact[];
  cancelled?: boolean;
  error?: { code: string; message: string; retrySafe: boolean };
}
export interface WorkerAvailability { state: "available" | "requires_setup"; reason?: string; }
export interface WorkerIdentity { profileDigest: string; implementationDigest: string; }
export interface WorkerClient { run(request: WorkerRequest): Promise<WorkerResult>; cancel(workerRequestId: string): Promise<{ requested: boolean; stopped: boolean }>; identity?(): WorkerIdentity | Promise<WorkerIdentity>; availability?(operation: string, args?: Record<string, unknown>): WorkerAvailability; }
export interface LocalWorkerOptions {
  pythonExecutable: string;
  workerScript: string;
  profilePath?: string;
  profileContentSha256?: string;
  allowedRoots: string[];
  writableRoots?: string[];
  maxParallelJobs?: number;
  launcher?: { executable: string; args: string[] };
  pathMappings?: { hostRoot: string; workerRoot: string }[];
  operationAvailability?: Partial<Record<WorkerOperation, WorkerAvailability>>;
  imageEncodingAvailable?: boolean;
}
const OPERATIONS = new Set<WorkerOperation>(["media.inspect", "media.frames", "media.conform", "media.transcribe", "audio.analyze", "audio.render", "audio.sync", "image.segment", "image.inpaint", "artifact.verify"]);
const inside = (root: string, file: string): boolean => {
  const p = relative(root, file);
  return p === "" || (!isAbsolute(p) && p !== ".." && !p.startsWith(`..${sep}`));
};
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") { const encoded = JSON.stringify(value); if (encoded === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new Error("Worker arguments must be finite JSON values"); return encoded; }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
function failure(req: WorkerRequest, code: string, message: string, retrySafe = false): WorkerResult {
  return { workerRequestId: req.workerRequestId, operation: req.operation, ok: false, data: {}, artifacts: [], error: { code, message, retrySafe } };
}
/** Local, bounded worker transport. The workflow journal remains the durable authority. */
export class LocalWorkerClient implements WorkerClient {
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly requests = new Map<string, { digest: string; promise: Promise<WorkerResult> }>();
  private readonly cancelled = new Set<string>();
  private readonly settled = new Set<string>();
  private readonly waiters: (() => void)[] = [];
  private running = 0;
  private closed = false;
  private providerIdentity: WorkerIdentity | undefined;
  constructor(private readonly config: LocalWorkerOptions) {}

  async identity(): Promise<WorkerIdentity> {
    const profileBytes = this.config.profilePath ? await readFile(this.config.profilePath) : Buffer.from(canonical({ pythonExecutable: this.config.pythonExecutable, launcher: this.config.launcher ?? null, pathMappings: this.config.pathMappings ?? [] }));
    const profileDigest = createHash("sha256").update(profileBytes).digest("hex");
    if (this.config.profileContentSha256 && this.config.profileContentSha256 !== profileDigest) throw new Error("PROVIDER_CHANGED: worker profile changed after its configuration was loaded");
    const directory = dirname(this.config.workerScript);
    const files = [this.config.workerScript, ...["common.py", "media_ops.py", "image_ops.py"].map(name => resolve(directory, name)), fileURLToPath(import.meta.url)];
    const hashes = await Promise.all(files.map(async path => createHash("sha256").update(await readFile(path)).digest("hex")));
    const identity = { profileDigest, implementationDigest: createHash("sha256").update(canonical(hashes)).digest("hex") };
    if (this.providerIdentity && canonical(this.providerIdentity) !== canonical(identity)) throw new Error("PROVIDER_CHANGED: worker implementation changed while this owner was running");
    this.providerIdentity ??= identity;
    return { ...identity };
  }

  availability(operation: string, args: Record<string, unknown> = {}): WorkerAvailability {
    if (!OPERATIONS.has(operation as WorkerOperation)) return { state: "requires_setup", reason: "Unknown worker operation" };
    if (operation === "audio.sync" && args.method === "timecode") return this.config.operationAvailability?.["media.inspect"] ?? { state: "available" };
    if (operation === "artifact.verify" && (args.output as { encoding?: { kind?: string } } | undefined)?.encoding?.kind === "subtitle") return { state: "available" };
    if (operation === "artifact.verify" && (args.output as { encoding?: { kind?: string } } | undefined)?.encoding?.kind === "image") return this.config.imageEncodingAvailable === false ? { state: "requires_setup", reason: "Pinned Pillow environment is required for image artifact verification" } : this.config.operationAvailability?.["artifact.verify"] ?? { state: "available" };
    if (operation === "media.conform" && ["png", "jpg", "jpeg"].includes(String(args.outputFormat))) return this.config.imageEncodingAvailable === false ? { state: "requires_setup", reason: "Pinned Pillow environment is missing" } : { state: "available" };
    if (operation === "media.frames" && args.statistics === true && this.config.imageEncodingAvailable === false) return { state: "requires_setup", reason: "Pinned Pillow environment is required for observed frame statistics" };
    return this.config.operationAvailability?.[operation as WorkerOperation] ?? { state: "available" };
  }

  run(request: WorkerRequest): Promise<WorkerResult> {
    if (this.closed) return Promise.resolve(failure(request, "WORKER_CLOSED", "Worker client is closed", true));
    const available = this.availability(request.operation, request.options);
    if (available.state !== "available") return Promise.resolve(failure(request, "WORKER_REQUIRES_SETUP", available.reason ?? "Local worker provider is not configured", true));
    const digest = createHash("sha256").update(canonical(request)).digest("hex");
    const previous = this.requests.get(request.workerRequestId);
    if (previous) return previous.digest === digest ? previous.promise : Promise.resolve(failure(request, "IDEMPOTENCY_CONFLICT", "Worker request ID has different arguments", true));
    const promise = this.execute(request).catch(error => failure(request, "WORKER_PREPARATION_FAILED", error instanceof Error ? error.message : String(error), true)).then(result => {
      this.settled.add(request.workerRequestId);
      // Durable receipts live in job staging; keep only a bounded in-memory transport cache.
      while (this.settled.size > 256) { const oldest = this.settled.values().next().value; if (oldest === undefined) break; this.settled.delete(oldest); this.requests.delete(oldest); this.cancelled.delete(oldest); }
      return result;
    });
    this.requests.set(request.workerRequestId, { digest, promise });
    return promise;
  }
  async cancel(workerRequestId: string): Promise<{ requested: boolean; stopped: boolean }> {
    if (!this.requests.has(workerRequestId) || this.settled.has(workerRequestId)) return { requested: false, stopped: false };
    this.cancelled.add(workerRequestId);
    const child = this.active.get(workerRequestId);
    if (child?.stdin.writable) child.stdin.write(`${JSON.stringify({ kind: "cancel", workerRequestId })}\n`);
    return { requested: true, stopped: !child };
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.active.keys()].map(id => this.cancel(id)));
    for (const wake of this.waiters.splice(0)) wake();
  }
  private async acquire(): Promise<void> {
    const maximum = this.config.maxParallelJobs ?? 2;
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 32) throw new Error("maxParallelJobs must be 1..32");
    while (this.running >= maximum && !this.closed) await new Promise<void>(done => this.waiters.push(done));
    if (this.closed) throw new Error("Worker client is closed");
    this.running++;
  }
  private release(): void { this.running--; this.waiters.shift()?.(); }
  private mapPath(path: string, direction: "to_worker" | "to_host"): string {
    const mappings = this.config.pathMappings ?? [];
    if (direction === "to_worker") {
      for (const mapping of mappings) {
        const host = resolve(mapping.hostRoot);
        if (inside(host, path)) return `${mapping.workerRoot.replace(/\/$/, "")}/${relative(host, path).split(sep).join("/")}`;
      }
      if (this.config.launcher && mappings.length) throw new Error(`No worker path mapping for ${path}`);
    } else {
      for (const mapping of mappings) {
        const root = mapping.workerRoot.replace(/\/$/, "");
        if (path === root || path.startsWith(`${root}/`)) return resolve(mapping.hostRoot, path.slice(root.length).replace(/^\//, ""));
      }
      if (this.config.launcher && mappings.length) throw new Error("Worker returned an unmapped artifact path");
    }
    return path;
  }
  private async prepare(req: WorkerRequest): Promise<WorkerRequest> {
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(req.workerRequestId) || !OPERATIONS.has(req.operation)) throw new Error("Invalid worker request identity or operation");
    const { maxCpuThreads, maxOutputBytes, timeoutMs, maxTemporaryBytes } = req.limits;
    if (!Number.isSafeInteger(maxCpuThreads) || maxCpuThreads < 1 || maxCpuThreads > 256 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 64 * 1024 * 1024 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000 || !/^[1-9][0-9]*$/.test(maxTemporaryBytes)) throw new Error("Invalid worker limits");
    const roots = await Promise.all(this.config.allowedRoots.map(root => realpath(root)));
    const writable = await Promise.all((this.config.writableRoots ?? this.config.allowedRoots).map(root => realpath(root)));
    const directory = resolve(req.outputDirectory);
    if (!writable.some(root => inside(root, directory))) throw new Error("Worker output is outside writable roots");
    // Resolve the nearest existing parent before creating any directories.
    let ancestor = directory;
    for (;;) {
      try { const actual = await realpath(ancestor); if (!writable.some(root => inside(root, actual))) throw new Error("Worker output traverses a link outside writable roots"); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; const parent = resolve(ancestor, ".."); if (parent === ancestor) throw error; ancestor = parent; }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const output = await realpath(directory);
    if (!writable.some(root => inside(root, output))) throw new Error("Worker output escaped writable roots");
    const inputs: WorkerRequest["inputs"] = {};
    for (const [key, input] of Object.entries(req.inputs)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(key)) throw new Error("Invalid input key");
      const path = await realpath(input.path);
      if (!roots.some(root => inside(root, path)) || !(await stat(path)).isFile()) throw new Error(`Input ${key} is not an allowed file`);
      if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("Invalid input hash");
      inputs[key] = { ...input, path: this.mapPath(path, "to_worker") };
    }
    return { ...req, inputs, outputDirectory: this.mapPath(output, "to_worker") };
  }
  private async execute(request: WorkerRequest): Promise<WorkerResult> {
    await this.acquire();
    try {
      if (this.cancelled.has(request.workerRequestId)) return { ...failure(request, "CANCELLED", "Cancelled before worker dispatch", true), cancelled: true };
      const providerIdentity = await this.identity();
      const prepared = await this.prepare({ ...request, providerIdentity });
      if (this.cancelled.has(request.workerRequestId)) return { ...failure(request, "CANCELLED", "Cancelled before worker dispatch", true), cancelled: true };
      const script = this.mapPath(await realpath(this.config.workerScript), "to_worker");
      const argv = ["-u", script, "--roots-json", JSON.stringify(this.config.allowedRoots.map(root => this.mapPath(resolve(root), "to_worker")))];
      if (this.config.profilePath) argv.push("--profile", this.mapPath(await realpath(this.config.profilePath), "to_worker"));
      const executable = this.config.launcher?.executable ?? this.config.pythonExecutable;
      const args = this.config.launcher ? [...this.config.launcher.args, this.config.pythonExecutable, ...argv] : argv;
      return await new Promise<WorkerResult>((done) => {
        const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", OMP_NUM_THREADS: String(request.limits.maxCpuThreads), OPENBLAS_NUM_THREADS: String(request.limits.maxCpuThreads), MKL_NUM_THREADS: String(request.limits.maxCpuThreads), NUMEXPR_NUM_THREADS: String(request.limits.maxCpuThreads) } });
        this.active.set(request.workerRequestId, child);
        let stdout = ""; let stderr = ""; let result: WorkerResult | undefined; let transportError: string | undefined; let ended = false;
        const timeout = setTimeout(() => { transportError = "Worker response deadline expired; execution outcome may be unknown"; void this.cancel(request.workerRequestId); }, request.limits.timeoutMs);
        const hardStop = setTimeout(() => { if (!ended) { transportError ??= "Worker did not stop after its deadline"; child.kill(); } }, request.limits.timeoutMs + 5000);
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
          if (Buffer.byteLength(stdout) > request.limits.maxOutputBytes) { transportError = "Worker response exceeds output limit"; child.kill(); return; }
          const newline = stdout.indexOf("\n");
          if (newline >= 0 && !result) {
            try {
              const value: unknown = JSON.parse(stdout.slice(0, newline));
              if (!value || typeof value !== "object") throw new Error("Invalid worker envelope");
              const candidate = value as WorkerResult;
              if (candidate.workerRequestId !== request.workerRequestId || candidate.operation !== request.operation || typeof candidate.ok !== "boolean" || !candidate.data || typeof candidate.data !== "object" || !Array.isArray(candidate.artifacts)) throw new Error("Worker result identity/schema mismatch");
              result = candidate;
            } catch (error) { transportError = error instanceof Error ? error.message : String(error); child.kill(); }
            child.stdin.end();
          }
        });
        child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-65536); });
        child.once("error", error => { transportError = error.message; });
        child.once("close", () => {
          ended = true; clearTimeout(timeout); clearTimeout(hardStop); this.active.delete(request.workerRequestId);
          if (transportError || !result) { done(failure(request, "WORKER_OUTCOME_UNKNOWN", transportError ?? (stderr.trim() || "Worker exited without a receipt"))); return; }
          const observed = result;
          void this.validateArtifacts(request, observed).then(() => done(observed)).catch(error => done(failure(request, "WORKER_ARTIFACT_INVALID", error instanceof Error ? error.message : String(error))));
        });
        child.stdin.on("error", () => { /* close/error above owns the final outcome */ });
        child.stdin.write(`${JSON.stringify(prepared)}\n`);
      });
    } finally { this.release(); }
  }
  private async validateArtifacts(request: WorkerRequest, result: WorkerResult): Promise<void> {
    const directory = await realpath(request.outputDirectory);
    let total = 0n;
    for (const artifact of result.artifacts) {
      if (typeof artifact.path !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !/^(0|[1-9][0-9]*)$/.test(artifact.sizeBytes)) throw new Error("Invalid artifact metadata");
      artifact.path = await realpath(this.mapPath(artifact.path, "to_host"));
      if (!inside(directory, artifact.path)) throw new Error("Artifact escaped job output directory");
      const info = await stat(artifact.path, { bigint: true });
      if (!info.isFile() || info.size !== BigInt(artifact.sizeBytes)) throw new Error("Artifact identity changed before receipt");
      const hash = createHash("sha256"); for await (const bytes of createReadStream(artifact.path)) hash.update(bytes);
      if (hash.digest("hex") !== artifact.sha256) throw new Error("Artifact hash changed before receipt");
      total += info.size;
    }
    if (total > BigInt(request.limits.maxTemporaryBytes)) throw new Error("Worker output exceeds temporary quota");
  }
}
