"use strict";
const { app } = require("photoshop");
const storage = require("./storage");
const targets = require("./targets");
const { PluginError } = require("./errors");
const openedEntries = new Map();
function savedLayerStructure(doc) {
  const root = targets.allLayers(doc); const indexes = new Map(root.map((entry, index) => [entry.layer.id, index]));
  return root.map(({ layer, parents }) => {
    const projection = targets.layerProjection(layer, parents);
    const { id, ...properties } = projection;
    return { ...properties, parents: parents.map(parentId => indexes.get(parentId)) };
  });
}

async function materializeAsset(slot, payload, context) {
  const transfer = payload.assetTransfers && payload.assetTransfers[slot];
  if (!transfer || typeof context.downloadImport !== "function") throw new PluginError("PRECONDITION_FAILED", `No authenticated asset in slot ${slot}`);
  const bytes = await context.downloadImport(transfer.name, slot);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== transfer.sha256) throw new PluginError("PRECONDITION_FAILED", `Asset bytes changed for slot ${slot}`, { effect: "not_applied" });
  return storage.materializeTemporaryImportFile(transfer.name, bytes);
}
async function openWorking(payload, context) {
  const entry = await materializeAsset("source", payload, context);
  try {
    context.throwIfCancelled();
    const doc = await app.open(entry);
    targets.bindWorkingAsset(doc, payload.workingAssetId);
    openedEntries.set(doc.id, entry);
    return doc;
  } catch (error) { await storage.deleteEntry(entry).catch(() => {}); throw error; }
}
async function withAssetDocument(slot, payload, context, fn) {
  const entry = await materializeAsset(slot, payload, context);
  let doc;
  try { context.throwIfCancelled(); doc = await app.open(entry); return await fn(doc); }
  finally {
    if (doc) await doc.closeWithoutSaving();
    await storage.deleteEntry(entry);
  }
}
async function exportDocument(doc, payload, context) {
  const output = payload.args && payload.args.output;
  if (!output || !payload.exportFileName || typeof context.uploadExport !== "function") throw new PluginError("PRECONDITION_FAILED", "A reserved export output is required");
  const format = String(output.format).toLowerCase().replace("jpeg", "jpg");
  if (!["png", "jpg", "psd", "psb"].includes(format) || !doc.saveAs || typeof doc.saveAs[format] !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", `Native save format is unavailable: ${format}`);
  if (output.width && output.width !== Number(doc.width) || output.height && output.height !== Number(doc.height)) throw new PluginError("PRECONDITION_FAILED", "Export dimensions differ from the prepared document");
  if (output.color && output.color.iccProfile && output.color.iccProfile !== doc.colorProfileName) throw new PluginError("PRECONDITION_FAILED", "Export profile differs from the prepared document; run explicit profile conversion first");
  if (output.color && output.color.alpha === "premultiplied") throw new PluginError("CAPABILITY_UNAVAILABLE", "Native export has no qualified premultiplied-alpha route");
  const entry = await storage.createTemporaryExportFile(payload.exportFileName);
  try {
    context.throwIfCancelled();
    const options = format === "jpg" ? { quality: Number(output.encoding.jpegQuality === undefined ? 10 : output.encoding.jpegQuality), embedColorProfile: output.encoding.embedIcc === true }
      : ["psd", "psb"].includes(format) ? { layers: true, alphaChannels: true, embedColorProfile: true, maximizeCompatibility: true } : {};
    await doc.saveAs[format](entry, options, true);
    context.throwIfCancelled();
    let reopened, observed;
    try {
      reopened = await app.open(entry);
      observed = { width: Number(reopened.width), height: Number(reopened.height), colorProfile: reopened.colorProfileName || null,
        layerCount: targets.allLayers(reopened).length, mode: String(reopened.mode), bitDepth: String(reopened.bitsPerChannel) };
      if (observed.width !== Number(doc.width) || observed.height !== Number(doc.height)) throw new PluginError("VERIFICATION_FAILED", "Reopened export dimensions differ from the working document");
      if (["psd", "psb"].includes(format) && observed.layerCount !== targets.allLayers(doc).length) throw new PluginError("VERIFICATION_FAILED", "Reopened native project did not preserve the layer tree count");
      if (["psd", "psb"].includes(format) && JSON.stringify(savedLayerStructure(doc)) !== JSON.stringify(savedLayerStructure(reopened))) throw new PluginError("VERIFICATION_FAILED", "Reopened native project changed observed layer kinds, text, bounds, or hierarchy");
      if (output.color && output.color.iccProfile && observed.colorProfile !== output.color.iccProfile) throw new PluginError("VERIFICATION_FAILED", "Reopened export profile differs from the requested profile");
    } finally { if (reopened) await reopened.closeWithoutSaving(); }
    const uploaded = await context.uploadExport(await storage.readEntryBinary(entry), { name: payload.exportFileName, format, onConflict: "error" });
    return { ...uploaded, width: Number(doc.width), height: Number(doc.height), layerCount: targets.allLayers(doc).length,
      bitDepth: Number(doc.bitsPerChannel), colorProfile: doc.colorProfileName || null, outputKey: output.outputKey,
      reopened: observed, ...(format === "jpg" ? { nativeJpegQuality: options.quality } : {}) };
  } finally { await storage.deleteEntry(entry); }
}
module.exports = { materializeAsset, openWorking, withAssetDocument, exportDocument };
