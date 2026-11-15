"use strict";
const { imaging, constants } = require("photoshop");
const targets = require("../targets");
const files = require("../files");
const { PluginError } = require("../errors");
const { finiteRect, toBounds } = require("../imaging");
const placements = new Map();
const placementKey = (doc, layer) => `${doc.id}:${layer.id}`;
function sourcePlacement(doc, layer) {
  const value = placements.get(placementKey(doc, layer));
  return value ? { ...value, sourceToDocument: value.sourceToDocument.slice(), visibleBounds: targets.boundsOf(layer) } : null;
}

function pixelLayer(layer) {
  if (!constants.LayerKind || layer.kind !== constants.LayerKind.NORMAL) throw new PluginError("PRECONDITION_FAILED", "This operation requires a pixel layer");
}
function componentSize(doc) {
  for (const [name, size] of Object.entries({ EIGHT: 8, SIXTEEN: 16, THIRTYTWO: 32 })) if (constants.BitsPerChannelType && doc.bitsPerChannel === constants.BitsPerChannelType[name]) return size;
  throw new PluginError("CAPABILITY_UNAVAILABLE", "Pixel editing requires an observed 8, 16, or 32-bit document");
}
function rasterBudget(width, height, depth, args) {
  const declared = args.executionResources && Number(args.executionResources.maxTemporaryBytes);
  const limit = Math.min(512 * 1024 * 1024, Number.isFinite(declared) ? declared : 512 * 1024 * 1024);
  if (width * height * 4 * (depth / 8) > limit) throw new PluginError("RESOURCE_BUDGET_EXCEEDED", "Native pixel buffer exceeds the operation byte budget");
}
async function create(doc, name) {
  if (typeof doc.createPixelLayer !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", "Document.createPixelLayer requires a supported host");
  return doc.createPixelLayer({ name: name || "MCP Layer" });
}
function fitBounds(sourceWidth, sourceHeight, box, fit) {
  finiteRect(box);
  const scale = (fit === "cover" ? Math.max : Math.min)(box.width / sourceWidth, box.height / sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale));
  return { width, height, left: Math.round(box.x + (box.width - width) / 2), top: Math.round(box.y + (box.height - height) / 2) };
}
async function imageIntoLayer(doc, layer, source, box, fit, context, args, sourceProvenance) {
  const dest = fitBounds(Number(source.width), Number(source.height), box, fit);
  const depth = componentSize(doc); rasterBudget(dest.width, dest.height, depth, args);
  const profile = doc.mode === constants.DocumentMode.RGB && doc.colorProfileName && doc.colorProfileName !== "None" ? doc.colorProfileName : "sRGB IEC61966-2.1";
  const image = await imaging.getPixels({ documentID: source.id, targetSize: { width: dest.width, height: dest.height }, componentSize: depth, colorSpace: "RGB", colorProfile: profile, applyAlpha: false });
  let clipped = null;
  let placement;
  try {
    context.throwIfCancelled();
    // getPixels can trim transparent borders. Map its actual source bounds,
    // including pyramid scale, back into the requested destination.
    const levelScale = Math.pow(2, image.level || 0), sourceBounds = image.sourceBounds;
    if (!sourceBounds || ![sourceBounds.left, sourceBounds.top, sourceBounds.right, sourceBounds.bottom].every(Number.isFinite) || sourceBounds.right <= sourceBounds.left || sourceBounds.bottom <= sourceBounds.top) throw new PluginError("VERIFICATION_FAILED", "Source placement requires actual raster bounds");
    const actualX = sourceBounds.left * levelScale;
    const actualY = sourceBounds.top * levelScale;
    const sourceScaleX = dest.width / Number(source.width), sourceScaleY = dest.height / Number(source.height);
    let left = dest.left + Math.round(actualX * sourceScaleX), top = dest.top + Math.round(actualY * sourceScaleY);
    let data = image.imageData;
    const actualScaleX = Number(data.width) / ((sourceBounds.right - sourceBounds.left) * levelScale);
    const actualScaleY = Number(data.height) / ((sourceBounds.bottom - sourceBounds.top) * levelScale);
    if (![actualScaleX, actualScaleY].every(value => Number.isFinite(value) && value > 0)) throw new PluginError("VERIFICATION_FAILED", "Source placement returned an invalid raster scale");
    placement = { ...sourceProvenance, sourceWidth: Number(source.width), sourceHeight: Number(source.height), sourceToDocument: [actualScaleX, 0, 0, actualScaleY, left - actualX * actualScaleX, top - actualY * actualScaleY] };
    if (fit === "cover") {
      const x0 = Math.max(0, Math.round(box.x - left)), y0 = Math.max(0, Math.round(box.y - top));
      const width = Math.min(Number(data.width) - x0, Math.round(box.x + box.width - (left + x0))), height = Math.min(Number(data.height) - y0, Math.round(box.y + box.height - (top + y0)));
      if (width < 1 || height < 1) throw new PluginError("PRECONDITION_FAILED", "Cover crop has no source pixels");
      const bytes = await data.getData({ chunky: true }), components = Number(data.components);
      const cropped = new bytes.constructor(width * height * components);
      for (let row = 0; row < height; row++) cropped.set(bytes.subarray(((row + y0) * data.width + x0) * components, ((row + y0) * data.width + x0 + width) * components), row * width * components);
      clipped = await imaging.createImageDataFromBuffer(cropped, { width, height, components, colorSpace: "RGB", colorProfile: data.colorProfile });
      data = clipped; left += x0; top += y0;
    }
    await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: data, replace: true, targetBounds: { left, top }, commandName: "MCP place image" });
    placements.set(placementKey(doc, layer), placement);
    // Receipt projections preserve provenance; this host-side cache is bounded
    // and never invents placement for reopened/external native layers.
    while (placements.size > 4096) placements.delete(placements.keys().next().value);
  } finally { if (clipped) clipped.dispose(); image.imageData.dispose(); }
  return layer;
}
async function place(payload, context, replace = false) {
  const doc = targets.currentDocument(), args = payload.args;
  const transfer = payload.assetTransfers && payload.assetTransfers.source;
  if (!transfer || typeof transfer.assetId !== "string" || !transfer.assetId || !/^[0-9a-f]{64}$/.test(transfer.sha256)) throw new PluginError("PRECONDITION_FAILED", "Image placement requires an authenticated source asset identity and digest");
  let layer;
  if (replace) {
    layer = targets.currentLayer(); pixelLayer(layer);
    if (typeof layer.duplicate !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", "Pixel replacement requires a native backup duplicate");
    const backup = await layer.duplicate(); backup.visible = false; backup.name = `${layer.name} — original`;
  } else layer = await create(doc, args.name);
  const box = args.box || (replace ? targets.boundsOf(layer) : { x: 0, y: 0, width: Number(doc.width), height: Number(doc.height) });
  // withAssetDocument verifies the downloaded bytes against this digest before
  // opening the source, so this provenance names the actual placed raster.
  return files.withAssetDocument("source", payload, context, (source) => imageIntoLayer(doc, layer, source, box, args.fit || "contain", context, args, { sourceAssetId: transfer.assetId, sourceSha256: transfer.sha256 }));
}
async function fill(doc, color, name, context, placement = "front") {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new PluginError("PRECONDITION_FAILED", "Fill color must be #RRGGBB");
  const layer = await create(doc, name || "Background");
  const rgb = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16));
  const width = Number(doc.width), height = Number(doc.height), tileWidth = Math.min(2048, width), tileHeight = 128;
  for (let y = 0; y < height; y += tileHeight) for (let x = 0; x < width; x += tileWidth) {
    context.throwIfCancelled();
    const w = Math.min(tileWidth, width - x), h = Math.min(tileHeight, height - y);
    const bytes = new Uint8Array(w * h * 3);
    for (let index = 0; index < bytes.length; index += 3) bytes.set(rgb, index);
    const data = await imaging.createImageDataFromBuffer(bytes, { width: w, height: h, components: 3, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
    try { await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: data, replace: x === 0 && y === 0, targetBounds: { left: x, top: y } }); }
    finally { data.dispose(); }
  }
  const others = Array.from(doc.layers || []).filter(item => item.id !== layer.id);
  if (others.length) {
    const anchor = placement === "back" ? others[others.length - 1] : others[0];
    const aboveBackground = placement === "back" && anchor.isBackgroundLayer === true;
    const insertLocation = placement === "front" || aboveBackground ? constants.ElementPlacement.PLACEBEFORE : constants.ElementPlacement.PLACEAFTER;
    if (typeof layer.move !== "function" || insertLocation === undefined) throw new PluginError("CAPABILITY_UNAVAILABLE", "Native layer placement is unavailable");
    context.throwIfCancelled(); await layer.move(anchor, insertLocation);
    const roots = Array.from(doc.layers || []);
    const expected = placement === "front" ? 0 : roots.length - (aboveBackground ? 2 : 1);
    if (!roots[expected] || roots[expected].id !== layer.id) throw new PluginError("VERIFICATION_FAILED", "Fill layer was not placed at the requested document stack position");
  }
  return layer;
}
async function transform(layer, args, context) {
  placements.delete(placementKey(targets.currentDocument(), layer));
  if (args.widthPercent !== undefined || args.heightPercent !== undefined) {
    context.throwIfCancelled(); await layer.scale(args.widthPercent === undefined ? 100 : args.widthPercent, args.heightPercent === undefined ? 100 : args.heightPercent, constants.AnchorPosition.MIDDLECENTER);
  }
  if (args.angle !== undefined) { context.throwIfCancelled(); await layer.rotate(args.angle, constants.AnchorPosition.MIDDLECENTER); }
  if (args.x !== undefined || args.y !== undefined) {
    context.throwIfCancelled(); const b = targets.boundsOf(layer); await layer.translate(args.x === undefined ? 0 : args.x - b.x, args.y === undefined ? 0 : args.y - b.y);
  }
  return layer;
}
async function patch(payload, context) {
  const doc = targets.currentDocument(), args = payload.args, region = finiteRect(args.region);
  if (![region.x, region.y, region.width, region.height].every(Number.isInteger)) throw new PluginError("PRECONDITION_FAILED", "Patch bounds must use integer pixels");
  if (region.x < 0 || region.y < 0 || region.x + region.width > doc.width || region.y + region.height > doc.height) throw new PluginError("PRECONDITION_FAILED", "Patch bounds exceed the document");
  const depth = componentSize(doc); rasterBudget(region.width, region.height, depth, args);
  const layer = await create(doc, args.name || "Retouch patch");
  const sourceSlot = payload.assetTransfers.patch ? "patch" : payload.assetTransfers.source ? "source" : null;
  const copy = async (source) => {
    const sourceRegion = args.sourceRegion || { x: 0, y: 0, width: Number(source.width), height: Number(source.height) };
    finiteRect(sourceRegion);
    if (![sourceRegion.x, sourceRegion.y, sourceRegion.width, sourceRegion.height].every(Number.isInteger) || sourceRegion.x < 0 || sourceRegion.y < 0 || sourceRegion.x + sourceRegion.width > Number(source.width) || sourceRegion.y + sourceRegion.height > Number(source.height)) throw new PluginError("PRECONDITION_FAILED", "Clone source bounds must be whole pixels inside the source document");
    if (args.sourceRegion && (sourceRegion.width !== region.width || sourceRegion.height !== region.height)) throw new PluginError("PRECONDITION_FAILED", "Clone source and destination sizes must match");
    const profile = doc.mode === constants.DocumentMode.RGB && doc.colorProfileName && doc.colorProfileName !== "None" ? doc.colorProfileName : "sRGB IEC61966-2.1";
    const pixels = await imaging.getPixels({ documentID: source.id, sourceBounds: toBounds(sourceRegion), targetSize: { width: region.width, height: region.height }, componentSize: depth, colorSpace: "RGB", colorProfile: profile, applyAlpha: false });
    try {
      context.throwIfCancelled();
      const actual = pixels.sourceBounds || toBounds(sourceRegion), factor = Math.pow(2, pixels.level || 0);
      const left = region.x + Math.round((actual.left * factor - sourceRegion.x) * region.width / sourceRegion.width);
      const top = region.y + Math.round((actual.top * factor - sourceRegion.y) * region.height / sourceRegion.height);
      await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: pixels.imageData, replace: true, targetBounds: { left, top } });
    } finally { pixels.imageData.dispose(); }
  };
  if (sourceSlot) await files.withAssetDocument(sourceSlot, payload, context, copy); else await copy(doc);
  layer.opacity = args.opacityPercent === undefined ? 100 : args.opacityPercent;
  const feather = Number(args.featherPx || 0);
  if (feather > 0) {
    const bytes = new Uint8Array(region.width * region.height);
    for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) bytes[y * region.width + x] = Math.round(255 * Math.min(1, Math.min(x + 0.5, y + 0.5, region.width - x - 0.5, region.height - y - 0.5) / feather));
    const data = await imaging.createImageDataFromBuffer(bytes, { width: region.width, height: region.height, components: 1, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2" });
    try { await imaging.putLayerMask({ documentID: doc.id, layerID: layer.id, imageData: data, replace: true, targetBounds: { left: region.x, top: region.y } }); }
    finally { data.dispose(); }
  }
  return layer;
}
module.exports = { create, place, fill, transform, patch, pixelLayer, fitBounds, sourcePlacement };
