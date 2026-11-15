"use strict";
const { imaging, constants } = require("photoshop");
const targets = require("../targets");
const files = require("../files");
const layers = require("./layers");
const { PluginError } = require("../errors");

function morphLine(input, output, offset, stride, length, radius, minimum) {
  const deque = new Int32Array(length); let head = 0, tail = 0, next = 0;
  for (let index = 0; index < length; index++) {
    const right = Math.min(length - 1, index + radius);
    while (next <= right) {
      const value = input[offset + next * stride];
      while (tail > head && (minimum ? input[offset + deque[tail - 1] * stride] >= value : input[offset + deque[tail - 1] * stride] <= value)) tail--;
      deque[tail++] = next++;
    }
    while (head < tail && deque[head] < index - radius) head++;
    output[offset + index * stride] = input[offset + deque[head] * stride];
  }
}
function contractMask(bytes, width, height, amount) {
  if (!Number.isInteger(amount) || Math.abs(amount) > 500) throw new PluginError("PRECONDITION_FAILED", "Mask contraction uses integer pixels from -500 to 500");
  if (!amount) return bytes;
  const horizontal = new Uint8Array(bytes.length), output = new Uint8Array(bytes.length);
  for (let y = 0; y < height; y++) morphLine(bytes, horizontal, y * width, 1, width, Math.abs(amount), amount > 0);
  for (let x = 0; x < width; x++) morphLine(horizontal, output, x, width, height, Math.abs(amount), amount > 0);
  return output;
}
async function apply(payload, context) {
  const doc = targets.currentDocument(), layer = targets.currentLayer(), args = payload.args;
  if (args.source === "input_alpha" && doc.bitsPerChannel !== constants.BitsPerChannelType.EIGHT) throw new PluginError("CAPABILITY_UNAVAILABLE", "Alpha extraction currently requires an 8-bit document; it cannot silently reduce native pixel precision");
  let pixels, sourceDocument;
  const consume = async (source) => {
    sourceDocument = source;
    pixels = await imaging.getPixels({ documentID: source.id, ...(source === doc ? { layerID: layer.id } : {}), componentSize: 8,
      colorSpace: args.source === "input_mask" ? "Grayscale" : "RGB", ...(args.source === "input_mask" ? { colorProfile: "Gray Gamma 2.2" } : {}), applyAlpha: args.source === "input_mask" });
    const image = pixels.imageData;
    let gray, rgb = null, grayData = null;
    try {
      const width = Number(image.width), height = Number(image.height), components = Number(image.components);
      const bytes = await image.getData({ chunky: true });
      if (args.source === "input_alpha") {
        if (!image.hasAlpha || components !== 4) throw new PluginError("PRECONDITION_FAILED", "Source has no RGBA alpha to make a native mask");
        layers.pixelLayer(layer);
        if (Number(layer.opacity) !== 100) throw new PluginError("PRECONDITION_FAILED", "Extract alpha before changing layer opacity");
        gray = new Uint8Array(width * height); const rgbBytes = new Uint8Array(width * height * 3);
        for (let index = 0; index < gray.length; index++) { gray[index] = bytes[index * 4 + 3]; rgbBytes.set(bytes.subarray(index * 4, index * 4 + 3), index * 3); }
        rgb = await imaging.createImageDataFromBuffer(rgbBytes, { width, height, components: 3, colorSpace: "RGB", colorProfile: image.colorProfile });
        const backup = await layer.duplicate(); backup.visible = false; backup.name = `${layer.name} — original alpha`;
      } else {
        if (components !== 1) throw new PluginError("PRECONDITION_FAILED", "Input mask must resolve to one grayscale channel");
        gray = bytes;
      }
      const bounds = pixels.sourceBounds;
      const factor = Math.pow(2, pixels.level || 0);
      const targetBounds = source === doc ? { left: bounds.left * factor, top: bounds.top * factor } : { left: 0, top: 0 };
      if (args.source === "input_mask" && (width !== Number(doc.width) || height !== Number(doc.height))) throw new PluginError("PRECONDITION_FAILED", "Input mask dimensions must match the target document; use an explicit prepared mask transform");
      gray = contractMask(gray, width, height, Number(args.contractPx || 0));
      grayData = await imaging.createImageDataFromBuffer(gray, { width, height, components: 1, colorSpace: "Grayscale", colorProfile: "Gray Gamma 2.2" });
      context.throwIfCancelled();
      if (rgb) await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: rgb, replace: true, targetBounds });
      await imaging.putLayerMask({ documentID: doc.id, layerID: layer.id, imageData: grayData, replace: true, targetBounds });
      if (args.featherPx !== undefined) layer.layerMaskFeather = args.featherPx;
      return layer;
    } finally { if (rgb) rgb.dispose(); if (grayData) grayData.dispose(); image.dispose(); }
  };
  if (args.source === "input_mask") return files.withAssetDocument("mask", payload, context, consume);
  if (args.source === "input_alpha") return consume(doc);
  throw new PluginError("CAPABILITY_UNAVAILABLE", "Native mask operation accepts prepared input_mask or input_alpha only");
}
module.exports = { apply, contractMask };
