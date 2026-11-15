"use strict";

const { app, constants } = require("photoshop");
const { PluginError } = require("./errors");
const { hostEpoch } = require("./operations");
const workingAssets = new Map();
let scopedTarget = null;

function allLayers(doc) {
  const entries = [];
  const visit = (layers, parents) => {
    for (const layer of Array.from(layers || [])) {
      entries.push({ layer, parents });
      if (layer.layers) visit(layer.layers, [...parents, layer.id]);
    }
  };
  visit(doc.layers, []);
  return entries;
}
function findDocument(id) { return Array.from(app.documents || []).find((doc) => doc.id === id); }
function resolveTarget(target, optional = false) {
  if (target && target.host && target.host.hostEpoch !== hostEpoch) throw new PluginError("STALE_TARGET", "Target belongs to a previous Photoshop host epoch", { effect: "not_applied" });
  const id = target && target.documentId;
  const doc = id === undefined ? app.activeDocument : findDocument(id);
  if (!doc) {
    if (optional && !target) return { document: null, layers: [] };
    throw new PluginError("NO_DOCUMENT", id === undefined ? "Photoshop has no active document" : `Document ${id} is no longer open`, { effect: "not_applied" });
  }
  if (target && target.workingAssetId && workingAssetId(doc) !== target.workingAssetId) throw new PluginError("STALE_TARGET", "Document working asset identity changed", { effect: "not_applied" });
  const ids = target && target.layerIds;
  let layers;
  if (ids) {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw new PluginError("PRECONDITION_FAILED", "layerIds must be unique non-empty IDs");
    const tree = allLayers(doc);
    layers = ids.map((layerId) => {
      const found = tree.filter((entry) => entry.layer.id === layerId);
      if (found.length !== 1) throw new PluginError("STALE_TARGET", `Layer ${layerId} is not uniquely present in document ${doc.id}`, { effect: "not_applied" });
      return found[0].layer;
    });
  } else layers = Array.from(doc.activeLayers || []);
  return { document: doc, layers };
}
function currentDocument() { return scopedTarget ? resolveTarget(scopedTarget).document : resolveTarget(null).document; }
function currentLayer() {
  const resolved = resolveTarget(scopedTarget);
  if (resolved.layers.length !== 1) throw new PluginError("PRECONDITION_FAILED", "This operation requires exactly one explicit layer", { effect: "not_applied" });
  return resolved.layers[0];
}
function captureTarget(installationId) {
  const { document, layers } = resolveTarget(null);
  return { kind: layers.length ? "ps_layer" : "ps_document", documentId: document.id,
    ...(layers.length ? { layerIds: layers.map((layer) => layer.id) } : {}),
    workingAssetId: workingAssets.get(document.id) || `unmanaged:${document.id}`,
    host: { app: "photoshop", installationId: installationId || "local", hostEpoch } };
}
function bindWorkingAsset(doc, assetId) {
  if (typeof assetId !== "string" || !assetId) throw new PluginError("PRECONDITION_FAILED", "A working asset ID is required");
  workingAssets.set(doc.id, assetId);
}
function workingAssetId(doc) { return workingAssets.get(doc.id) || `unmanaged:${doc.id}`; }
async function withTarget(target, fn, activate = true) {
  const previous = scopedTarget;
  const original = app.activeDocument;
  const originalIds = original ? Array.from(original.activeLayers || []).map((layer) => layer.id) : [];
  const resolved = resolveTarget(target, true);
  scopedTarget = target || (resolved.document ? captureTarget() : null);
  try {
    if (activate && resolved.document) {
      if (!app.activeDocument || app.activeDocument.id !== resolved.document.id) app.activeDocument = resolved.document;
      if (target && target.layerIds) resolved.document.activeLayers = resolved.layers;
    }
    return await fn(resolved);
  } finally {
    scopedTarget = previous;
    if (activate && original && findDocument(original.id)) {
      try {
        app.activeDocument = original;
        const byId = new Map(allLayers(original).map((entry) => [entry.layer.id, entry.layer]));
        const survivors = originalIds.map((id) => byId.get(id)).filter(Boolean);
        if (survivors.length) original.activeLayers = survivors;
      } catch (_) { /* Restore is best effort after the original layer was deleted. */ }
    }
  }
}
function boundsOf(layer) {
  const bounds = layer.boundsNoEffects || layer.bounds;
  return { x: Number(bounds.left), y: Number(bounds.top), width: Number(bounds.right) - Number(bounds.left), height: Number(bounds.bottom) - Number(bounds.top) };
}
function layerProjection(layer, parents) {
  const projection = { id: layer.id, kind: String(layer.kind), name: layer.name, parents,
    visible: Boolean(layer.visible), opacity: Number(layer.opacity), bounds: boundsOf(layer) };
  try {
    if (layer.textItem) {
      projection.text = layer.textItem.contents;
      if (typeof layer.textItem.isPointText === "boolean") projection.isPointText = layer.textItem.isPointText;
      if (typeof layer.textItem.isParagraphText === "boolean") projection.isParagraphText = layer.textItem.isParagraphText;
      if (layer.textItem.characterStyle) {
        projection.fontPostScriptName = layer.textItem.characterStyle.font;
        projection.fontSize = Number(layer.textItem.characterStyle.size);
      }
    }
  } catch (_) { /* Non-text layers do not expose TextItem. */ }
  return projection;
}
function inspectDocument(target) {
  const doc = resolveTarget(target).document;
  const depths = { ONE: 1, EIGHT: 8, SIXTEEN: 16, THIRTYTWO: 32 };
  const depth = Object.entries(depths).find(([key]) => constants.BitsPerChannelType && constants.BitsPerChannelType[key] === doc.bitsPerChannel);
  return { documentId: doc.id, workingAssetId: workingAssetId(doc), width: Number(doc.width), height: Number(doc.height),
    mode: String(doc.mode), bitDepth: depth ? depth[1] : null, resolutionPpi: Number(doc.resolution),
    ...(doc.activeHistoryState && typeof doc.activeHistoryState.id === "number" ? { historyStateId: doc.activeHistoryState.id } : {}),
    iccProfile: doc.colorProfileName || null,
    layers: allLayers(doc).map(({ layer, parents }) => layerProjection(layer, parents)) };
}
module.exports = { allLayers, findDocument, resolveTarget, currentDocument, currentLayer, captureTarget, withTarget, bindWorkingAsset, workingAssetId, boundsOf, layerProjection, inspectDocument, hostEpoch };
