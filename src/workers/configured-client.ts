import { access, mkdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetRoots } from "../automation/assets.js";
import { LocalWorkerClient, type LocalWorkerOptions, type WorkerAvailability, type WorkerOperation } from "./client.js";

export interface WorkerFactoryOptions { dataDirectory: string; roots: AssetRoots; }
/** Machine profiles are local installation data; jobs cannot choose executable paths. */
export async function createConfiguredWorker(options: WorkerFactoryOptions): Promise<LocalWorkerClient | undefined> {
  const profilePath = resolve(process.env.ADOBE_MCP_WORKER_PROFILE ?? resolve(options.dataDirectory, "profiles/local-worker-profile.json"));
  let raw: string;
  try {
    if ((await stat(profilePath)).size > 1024 * 1024) throw new Error("Worker profile exceeds 1 MiB");
    raw = await readFile(profilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.ADOBE_MCP_WORKER_PROFILE) return undefined;
    throw error;
  }
  const profile = JSON.parse(raw) as Record<string, unknown>;
  if (profile.schemaVersion !== 1 || typeof profile.pythonExecutable !== "string" || !profile.pythonExecutable.trim() || typeof profile.pythonSha256 !== "string" || !/^[a-f0-9]{64}$/.test(profile.pythonSha256)) throw new Error("Worker profile requires schemaVersion=1 and pinned pythonExecutable/pythonSha256");
  const staging = resolve(options.dataDirectory, "assets");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const roots = [...Object.values(options.roots).map(root => resolve(typeof root === "string" ? root : root.path)), staging];
  let workerScript: string | undefined;
  if (typeof profile.workerScript === "string") workerScript = resolve(profile.workerScript);
  else {
    for (const candidate of [new URL("../../workers/worker.py", import.meta.url), new URL("./worker.py", import.meta.url)]) {
      try { await access(candidate); workerScript = fileURLToPath(candidate); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  if (!workerScript) throw new Error("Packaged local worker is missing; run copy:assets on this installation");
  const config: LocalWorkerOptions = { pythonExecutable: profile.pythonExecutable, workerScript, profilePath, profileContentSha256: createHash("sha256").update(raw).digest("hex"), allowedRoots: roots, writableRoots: [staging] };
  const executables = (profile.executables ?? {}) as Record<string, { path?: string; sha256?: string }>;
  const models = (profile.models ?? {}) as Record<string, { path?: string; sha256?: string; configName?: string; configSha256?: string }>;
  const packages = (profile.packages ?? {}) as Record<string, string>;
  const pinned = (value: { path?: string; sha256?: string } | undefined): boolean => !!value?.path && /^[a-f0-9]{64}$/.test(value.sha256 ?? "");
  const check = (condition: boolean, reason: string): WorkerAvailability => condition ? { state: "available" } : { state: "requires_setup", reason };
  const av = pinned(executables.ffmpeg) && pinned(executables.ffprobe);
  const imaging = !!packages.numpy && (!!packages["opencv-python-headless"] || !!packages["opencv-python"]) && !!packages.Pillow;
  config.imageEncodingAvailable = !!packages.Pillow;
  const availability: Record<WorkerOperation, WorkerAvailability> = {
    "media.inspect": check(pinned(executables.ffprobe), "Pin local ffprobe in the worker profile"),
    "media.frames": check(av, "Pin local FFmpeg and ffprobe in the worker profile"),
    "media.conform": check(av, "Pin local FFmpeg and ffprobe in the worker profile"),
    "media.transcribe": check(av && pinned(models.whisper) && !!packages["faster-whisper"] && !!packages.ctranslate2, "Pin local FFmpeg/ffprobe, a faster-whisper model and its Python packages"),
    "audio.analyze": check(av, "Pin local FFmpeg and ffprobe in the worker profile"),
    "audio.render": check(av, "Pin local FFmpeg and ffprobe in the worker profile"),
    "audio.sync": check(av && !!packages.numpy, "Pin FFmpeg/ffprobe and numpy for waveform sync"),
    "image.segment": check(imaging && pinned(models.sam2) && !!models.sam2?.configName && /^[a-f0-9]{64}$/.test(models.sam2?.configSha256 ?? "") && !!packages.torch && !!packages.torchvision && (!!packages["SAM-2"] || !!packages.sam2), "Pin SAM2 checkpoint/config, torch/torchvision, OpenCV, numpy and Pillow"),
    "image.inpaint": check(imaging, "Pin OpenCV, numpy and Pillow for RGB8 inpainting"),
    "artifact.verify": check(pinned(executables.ffprobe), "Pin ffprobe to verify generated media"),
  };
  config.operationAvailability = availability;
  if (profile.maxParallelJobs !== undefined) {
    if (!Number.isInteger(profile.maxParallelJobs) || Number(profile.maxParallelJobs) < 1 || Number(profile.maxParallelJobs) > 32) throw new Error("Invalid worker maxParallelJobs");
    config.maxParallelJobs = Number(profile.maxParallelJobs);
  }
  if (profile.launcher !== undefined) {
    const value = profile.launcher as Record<string, unknown>;
    if (!value || typeof value.executable !== "string" || !Array.isArray(value.args) || !value.args.every(arg => typeof arg === "string")) throw new Error("Invalid fixed worker launcher");
    config.launcher = { executable: value.executable, args: value.args as string[] };
  }
  if (profile.pathMappings !== undefined) {
    if (!Array.isArray(profile.pathMappings)) throw new Error("Invalid worker pathMappings");
    config.pathMappings = profile.pathMappings.map((entry: unknown) => {
      const value = entry as Record<string, unknown>;
      if (!value || typeof value.hostRoot !== "string" || typeof value.workerRoot !== "string" || !value.workerRoot.startsWith("/")) throw new Error("Invalid worker path mapping");
      return { hostRoot: value.hostRoot, workerRoot: value.workerRoot };
    });
  }
  const client = new LocalWorkerClient(config);
  await client.identity();
  return client;
}
