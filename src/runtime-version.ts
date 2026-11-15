import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const RUNTIME_PROTOCOL = "ps-mcp-runtime/1";
let cached: { runtimeProtocol: typeof RUNTIME_PROTOCOL; version: string; buildId: string } | undefined;
export function runtimeIdentity(): { runtimeProtocol: typeof RUNTIME_PROTOCOL; version: string; buildId: string } {
  if (cached) return cached;
  let version: string | undefined;
  for (const location of ["../package.json", "../../package.json"]) {
    try { const manifest = JSON.parse(readFileSync(new URL(location, import.meta.url), "utf8")) as { name?: string; version?: string }; if (manifest.name === "photoshop-full-mcp" && manifest.version) { version = manifest.version; break; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!version) throw new Error("Photoshop runtime package identity is missing");
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const hash = createHash("sha256").update(RUNTIME_PROTOCOL).update(version);
  // A same-version installation update must not silently keep an older owner.
  for (const file of ["runtime-owner", "runtime-journal", "bridge", "server", "adobe-automation-adapter", "automation/service", "automation/registry", "automation/mcp"]) hash.update(readFileSync(new URL(`./${file}.${extension}`, import.meta.url)));
  for (const file of ["recipe-request.schema.json", "recipe-parameters.schema.json", "operation-results.schema.json"]) hash.update(readFileSync(new URL(`./automation/${file}`, import.meta.url)));
  cached = { runtimeProtocol: RUNTIME_PROTOCOL, version, buildId: hash.digest("hex") }; return cached;
}
