import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function value(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const id = value("--id");
const category = value("--category");
const labelEn = value("--en");
const labelKo = value("--ko");
const file = value("--file");
if (!id || !category || !labelEn || !labelKo || !file || !/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/.test(id)) {
  process.stderr.write("Usage: node scripts/import-action-recording.mjs --id category.command --category category --en label --ko label --file recording.json\n");
  process.exit(2);
}

const source = await readFile(file, "utf8");
const descriptors = JSON.parse(source);
if (!Array.isArray(descriptors) || descriptors.length === 0 || descriptors.length > 100) {
  throw new Error("Recording must be a non-empty JSON array with at most 100 descriptors");
}
const forbidden = new Set(["quit", "deleteFile", "move", "copy"]);
for (const descriptor of descriptors) {
  if (!descriptor || typeof descriptor !== "object" || typeof descriptor._obj !== "string") {
    throw new Error("Each descriptor must be an object with a string _obj");
  }
  if (forbidden.has(descriptor._obj)) throw new Error(`Forbidden descriptor in importer: ${descriptor._obj}`);
}
const digest = createHash("sha256").update(JSON.stringify(descriptors)).digest("hex");
const definition = {
  id,
  category,
  labels: { en: labelEn, ko: labelKo },
  description: `Imported ActionJSON recording for ${labelEn}.`,
  status: "unverified",
  engine: "batchplay",
  minHostVersion: "27.9.0",
  risk: "edit",
  approval: "none",
  prerequisites: ["document"],
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: { type: "object" },
  verification: "preview",
  rollback: "history",
  evidence: `actionJSON sha256:${digest}`,
  unavailableReason: "Imported recordings remain blocked until an isolated Photoshop integration fixture passes"
};
process.stdout.write(`${JSON.stringify({ definition, descriptors }, null, 2)}\n`);
