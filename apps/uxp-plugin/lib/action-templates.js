"use strict";
const { app } = require("photoshop");
const { storage } = require("uxp");
const { PluginError } = require("./errors");
const verification = require("./verification");
const targets = require("./targets");
const files = require("./files");
let loaded;
function getPath(value, path) {
  for (const key of path) { if (["__proto__", "constructor", "prototype"].includes(String(key)) || value === null || typeof value !== "object") throw new PluginError("PRECONDITION_FAILED", "Invalid template binding path"); value = value[key]; }
  return value;
}
function setPath(value, path, data) {
  if (!path.length) throw new PluginError("PRECONDITION_FAILED", "Empty descriptor binding path");
  const parent = getPath(value, path.slice(0, -1)), key = path[path.length - 1];
  if (["__proto__", "constructor", "prototype"].includes(String(key)) || !Object.prototype.hasOwnProperty.call(parent, key)) throw new PluginError("PRECONDITION_FAILED", "Descriptor placeholder must already exist");
  parent[key] = data;
}
function validateTextLayout(template) {
  const observation = template.observation;
  if (template.resultScope !== "existing_layer" || !observation || !Array.isArray(observation.descriptors) || !observation.descriptors.length || observation.descriptors.some(descriptor => !descriptor || descriptor._obj !== "get") || !Array.isArray(observation.bindings)) throw new PluginError("PRECONDITION_FAILED", "Text layout requires an existing-layer recording and separate native get observations");
  for (const field of ["documentId", "layerId", "contents", "lineCount", "overset", "boxX", "boxY", "boxWidth", "boxHeight"]) {
    const mapping = observation.fields && observation.fields[field];
    if (!mapping || !Array.isArray(mapping.resultPath) || !mapping.resultPath.length || (mapping.transform !== undefined && !(field === "lineCount" && mapping.transform === "array_length"))) throw new PluginError("PRECONDITION_FAILED", `Text layout requires native readback mapping for ${field}`);
  }
}
async function list() {
  if (loaded) return loaded;
  const folder = await storage.localFileSystem.getPluginFolder();
  const index = JSON.parse(await (await folder.getEntry("lib/action-templates/index.json")).read());
  if (index.schemaVersion !== 1 || !Array.isArray(index.templates)) throw new PluginError("PRECONDITION_FAILED", "Invalid recorded-template index");
  loaded = [];
  for (const entry of index.templates) {
    if (!entry || typeof entry.file !== "string" || !/^[a-z0-9_.-]+\.json$/i.test(entry.file)) throw new PluginError("PRECONDITION_FAILED", "Invalid recorded-template filename");
    const template = JSON.parse(await (await folder.getEntry(`lib/action-templates/${entry.file}`)).read());
    if (template.source !== "action_recording" || !template.qualification || typeof template.qualification.fixtureId !== "string" || !template.qualification.fixtureId || template.qualification.hostBuild !== String(app.version) || !/^[0-9a-f]{64}$/.test(template.qualification.resultDigest || "")) continue;
    if (!Array.isArray(template.descriptors) || !template.descriptors.length || !Array.isArray(template.bindings) || !Array.isArray(template.postconditions) || !template.postconditions.length) throw new PluginError("PRECONDITION_FAILED", "Recorded template requires descriptors, bindings and exact postconditions");
    if (template.operation === "ps.artboard.duplicate" && template.resultScope !== "new_document") throw new PluginError("PRECONDITION_FAILED", "Artboard variant templates must produce an isolated new document");
    if (template.operation === "ps.text.layout") validateTextLayout(template);
    loaded.push(template);
  }
  return loaded;
}
function bindDescriptors(descriptors, bindings, values) {
  const bound = JSON.parse(JSON.stringify(descriptors));
  for (const binding of bindings) {
    if (!Array.isArray(binding.path) || !Array.isArray(binding.source)) throw new PluginError("PRECONDITION_FAILED", "Template bindings must use typed path arrays");
    const value = getPath(values, binding.source);
    if (value === undefined || value === null) throw new PluginError("PRECONDITION_FAILED", "Required template binding is missing");
    setPath(bound, binding.path, value);
  }
  return bound;
}
// The provider contains only recorded ActionJSON plus paths into native get
// results. No line-count property name or paragraph-box descriptor is invented.
async function textLayout(payload, context, batchPlay) {
  const template = await get("ps.text.layout");
  const resolved = targets.resolveTarget(payload.target), doc = resolved.document;
  if (resolved.layers.length !== 1) throw new PluginError("PRECONDITION_FAILED", "Text layout requires one exact layer");
  const layer = resolved.layers[0];
  const values = { args: payload.args, target: { documentId: doc.id, layerId: layer.id } };
  const beforeIds = targets.allLayers(doc).map(entry => entry.layer.id).sort((a, b) => a - b);
  const beforeDocuments = Array.from(app.documents).map(item => item.id).sort((a, b) => a - b);
  const sameTarget = () => {
    const current = targets.resolveTarget(payload.target);
    if (current.document.id !== doc.id || current.layers.length !== 1 || current.layers[0].id !== layer.id || verification.canonical(beforeIds) !== verification.canonical(targets.allLayers(doc).map(entry => entry.layer.id).sort((a, b) => a - b)) || verification.canonical(beforeDocuments) !== verification.canonical(Array.from(app.documents).map(item => item.id).sort((a, b) => a - b))) throw new PluginError("VERIFICATION_FAILED", "Text layout changed document/layer identities", { effect: "partial" });
  };
  return {
    qualification: template.qualification,
    async apply() {
      context.throwIfCancelled(); sameTarget();
      const results = await batchPlay(bindDescriptors(template.descriptors, template.bindings, values));
      for (const check of template.postconditions) {
        const actual = getPath(results, check.resultPath), expected = check.source ? getPath(values, check.source) : check.expected;
        if (verification.canonical(actual) !== verification.canonical(expected)) throw new PluginError("VERIFICATION_FAILED", "Recorded text-layout postcondition failed", { effect: "applied" });
      }
      sameTarget();
    },
    async observe() {
      context.throwIfCancelled(); sameTarget();
      const results = await batchPlay(bindDescriptors(template.observation.descriptors, template.observation.bindings, values));
      const actual = {};
      for (const [field, mapping] of Object.entries(template.observation.fields)) {
        let value = getPath(results, mapping.resultPath);
        if (mapping.transform === "array_length") {
          if (!Array.isArray(value)) throw new PluginError("VERIFICATION_FAILED", "Rendered-line readback is not an array", { effect: "applied" });
          value = value.length;
        }
        actual[field] = value;
      }
      sameTarget();
      if (actual.documentId !== doc.id || actual.layerId !== layer.id || actual.contents !== payload.args.text || !Number.isInteger(actual.lineCount) || actual.lineCount < 1 || typeof actual.overset !== "boolean" || !["boxX", "boxY", "boxWidth", "boxHeight"].every(key => typeof actual[key] === "number" && Number.isFinite(actual[key]))) throw new PluginError("VERIFICATION_FAILED", "Incomplete or mismatched native paragraph layout observation", { effect: "applied" });
      return { lineCount: actual.lineCount, overset: actual.overset, box: { x: actual.boxX, y: actual.boxY, width: actual.boxWidth, height: actual.boxHeight }, method: "qualified_native_paragraph_readback", qualification: template.qualification };
    }
  };
}
async function get(operation, variant) {
  const matches = (await list()).filter((item) => item.operation === operation && (item.variant || null) === (variant || null));
  if (matches.length !== 1) throw new PluginError("CAPABILITY_UNAVAILABLE", `No uniquely qualified recorded template for ${operation}${variant ? `:${variant}` : ""} on Photoshop ${app.version}`, { effect: "not_applied" });
  return matches[0];
}
async function execute(payload, context, batchPlay) {
  const template = await get(payload.operation, payload.args.kind);
  const doc = targets.currentDocument();
  const selected = targets.resolveTarget(payload.target).layers;
  if (payload.operation === "ps.artboard.duplicate" && (selected.length !== 1 || !Array.from(doc.artboards || []).some(board => board.id === selected[0].id))) throw new PluginError("PRECONDITION_FAILED", "Artboard duplication requires one exact observed source artboard");
  let entry;
  try {
    if (payload.assetTransfers && payload.assetTransfers.source) entry = await files.materializeAsset("source", payload, context);
    const values = { args: payload.args, target: { documentId: doc.id, layerId: selected.length === 1 ? selected[0].id : null }, source: { fileToken: entry ? storage.localFileSystem.createSessionToken(entry) : null } };
    const descriptors = JSON.parse(JSON.stringify(template.descriptors));
    for (const binding of template.bindings) {
      if (!Array.isArray(binding.path) || !Array.isArray(binding.source)) throw new PluginError("PRECONDITION_FAILED", "Template bindings must use typed path arrays");
      const value = getPath(values, binding.source);
      if (value === undefined || value === null) throw new PluginError("PRECONDITION_FAILED", "Required template binding is missing");
      setPath(descriptors, binding.path, value);
    }
    context.throwIfCancelled();
    const beforeIds = new Set(targets.allLayers(doc).map((item) => item.layer.id));
    const beforeDocumentIds = new Set(Array.from(app.documents).map(item => item.id));
    const results = await batchPlay(descriptors);
    for (const check of template.postconditions) {
      const actual = getPath(results, check.resultPath);
      const expected = check.source ? getPath(values, check.source) : check.expected;
      if (verification.canonical(actual) !== verification.canonical(expected)) throw new PluginError("VERIFICATION_FAILED", "Recorded template postcondition failed", { resultPath: check.resultPath, actual, expected, effect: "applied" });
    }
    if (payload.operation === "ps.artboard.duplicate") {
      const createdDocuments = Array.from(app.documents).filter(item => !beforeDocumentIds.has(item.id));
      if (createdDocuments.length !== 1) throw new PluginError("VERIFICATION_FAILED", "Artboard template must produce exactly one isolated document", { effect: "partial" });
      const outputDocument = createdDocuments[0], boards = Array.from(outputDocument.artboards || []), roots = Array.from(outputDocument.layers || []);
      if (boards.length !== 1 || roots.length !== 1 || roots[0].id !== boards[0].id) throw new PluginError("VERIFICATION_FAILED", "Artboard variant contains ambiguous boards or unrelated root layers", { effect: "partial" });
      const box = payload.args.box;
      if (box.x !== 0 || box.y !== 0 || Number(outputDocument.width) !== box.width || Number(outputDocument.height) !== box.height) throw new PluginError("VERIFICATION_FAILED", "Artboard variant dimensions/origin do not match the declared box", { effect: "partial" });
      boards[0].name = payload.args.name;
      return { document: outputDocument, layer: boards[0] };
    }
    const created = targets.allLayers(doc).filter((item) => !beforeIds.has(item.layer.id));
    if (payload.operation === "ps.smartobject.replace") return targets.currentLayer();
    if (created.length !== 1) throw new PluginError("VERIFICATION_FAILED", "Native template did not create exactly one layer", { effect: "applied" });
    return created[0].layer;
  } finally { if (entry) await require("./storage").deleteEntry(entry); }
}
module.exports = { list, get, execute, textLayout };
