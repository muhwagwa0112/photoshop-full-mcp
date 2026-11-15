"use strict";

const { imaging, constants } = require("photoshop");
const { PluginError } = require("./errors");
const targets = require("./targets");

function encodeBytes(bytes) {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
  return btoa(binary);
}
function toBounds(region) { return { left: region.x, top: region.y, right: region.x + region.width, bottom: region.y + region.height }; }
function finiteRect(region) {
  if (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.width <= 0 || region.height <= 0) throw new PluginError("PRECONDITION_FAILED", "A finite positive image region is required");
  return region;
}
async function capture(payload = {}) {
  const { document: doc, layers } = targets.resolveTarget(payload.target);
  const kind = payload.kind || "composite";
  const layer = ["layer", "mask"].includes(kind) ? layers[0] : null;
  if (["layer", "mask"].includes(kind) && layers.length !== 1) throw new PluginError("PRECONDITION_FAILED", "Layer/mask evidence requires one layer ID");
  const region = finiteRect(payload.region || (layer ? targets.boundsOf(layer) : { x: 0, y: 0, width: Number(doc.width), height: Number(doc.height) }));
  const fullResolution = payload.fullResolution === true;
  const requestedMaxEdge = fullResolution ? Math.max(region.width, region.height) : Number(payload.maxEdge || payload.max_edge || 1024);
  if (!fullResolution && (!Number.isFinite(requestedMaxEdge) || requestedMaxEdge < 64 || requestedMaxEdge > 2048)) throw new PluginError("PRECONDITION_FAILED", "Preview maxEdge must be between 64 and 2048");
  if (fullResolution) {
    if (doc.mode !== constants.DocumentMode.RGB || doc.bitsPerChannel !== constants.BitsPerChannelType.EIGHT) throw new PluginError("CAPABILITY_UNAVAILABLE", "Worker raster capture currently requires an RGB 8-bit document; precision/color conversion must be explicit");
    if (![region.x, region.y, region.width, region.height].every(Number.isInteger) || region.x < 0 || region.y < 0 || region.x + region.width > Number(doc.width) || region.y + region.height > Number(doc.height)) throw new PluginError("PRECONDITION_FAILED", "Full-resolution raster bounds must be whole pixels inside the document");
    const limit = Math.min(32 * 1024 * 1024, Number(payload.maxRasterBytes || 32 * 1024 * 1024));
    if (region.width * region.height * 4 > limit) throw new PluginError("RESOURCE_BUDGET_EXCEEDED", "Full-resolution raster exceeds the operation byte budget; use an explicit bounded ROI");
  }
  const scale = fullResolution ? 1 : Math.min(1, requestedMaxEdge / Math.max(region.width, region.height));
  const options = { documentID: doc.id, sourceBounds: toBounds(region), targetSize: { width: Math.max(1, Math.round(region.width * scale)), height: Math.max(1, Math.round(region.height * scale)) } };
  const format = payload.format || "png";
  let pixels;
  if (kind === "mask") {
    if (typeof imaging.getLayerMask !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", "imaging.getLayerMask is unavailable");
    pixels = await imaging.getLayerMask({ ...options, layerID: layer.id, kind: "user" });
  } else {
    if (typeof imaging.getPixels !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", "imaging.getPixels is unavailable");
    pixels = await imaging.getPixels({ ...options, ...(layer ? { layerID: layer.id } : {}), componentSize: 8, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1", applyAlpha: format === "jpeg" });
  }
  let converted = null;
  try {
    const imageData = pixels.imageData;
    const factor = Math.pow(2, Number(pixels.level || 0));
    const b = pixels.sourceBounds || toBounds(region);
    const sourceBounds = { x: b.left * factor, y: b.top * factor,
      width: (b.right === undefined ? b.width : b.right - b.left) * factor,
      height: (b.bottom === undefined ? b.height : b.bottom - b.top) * factor };
    const width = Number(imageData.width), height = Number(imageData.height);
    if (fullResolution && (width !== region.width || height !== region.height || sourceBounds.x !== region.x || sourceBounds.y !== region.y || sourceBounds.width !== region.width || sourceBounds.height !== region.height)) throw new PluginError("VERIFICATION_FAILED", "Host returned a resized or trimmed working raster");
    if (Number(imageData.componentSize) !== 8) throw new PluginError("CAPABILITY_UNAVAILABLE", "Evidence capture requires an 8-bit buffer; this host returned another depth");
    const metadata = { documentId: doc.id, ...(layer ? { layerId: layer.id } : {}), kind, requestedMaxEdge,
      requestedSourceBounds: region, sourceBounds, width, height, components: Number(imageData.components), componentSize: 8,
      colorProfile: imageData.colorProfile || null, alpha: imageData.hasAlpha ? "straight" : "none",
      evidenceToSource: [sourceBounds.width / width, 0, 0, sourceBounds.height / height, sourceBounds.x, sourceBounds.y],
      pyramidLevel: Number(pixels.level || 0), ...(format === "jpeg" ? { matte: "white" } : {}) };
    if (format === "jpeg") {
      if (typeof imaging.encodeImageData !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", "imaging.encodeImageData is unavailable");
      let rgb = imageData;
      if (Number(imageData.components) === 1) {
        const gray = await imageData.getData({ chunky: true });
        const data = new Uint8Array(width * height * 3);
        for (let index = 0; index < gray.length; index++) data.fill(gray[index], index * 3, index * 3 + 3);
        converted = await imaging.createImageDataFromBuffer(data, { width, height, components: 3, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" }); rgb = converted;
      }
      return { ...metadata, mimeType: "image/jpeg", base64: await imaging.encodeImageData({ imageData: rgb, base64: true }) };
    }
    const bytes = await imageData.getData({ chunky: true });
    return { ...metadata, mimeType: "image/png", rawPixels: encodeBytes(bytes) };
  } finally {
    if (converted) converted.dispose();
    if (pixels && pixels.imageData) pixels.imageData.dispose();
  }
}
module.exports = { capture, encodeBytes, finiteRect, toBounds };
