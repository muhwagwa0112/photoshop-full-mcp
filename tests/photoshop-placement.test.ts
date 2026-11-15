import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

test("photo placement retains the source affine through transparent trimming and a cover crop", async () => {
  const layer = { id: 7, bounds: { x: 0, y: 0, width: 0, height: 0 } };
  const doc = { id: 1, width: 100, height: 100, mode: "RGB", bitsPerChannel: 8, colorProfileName: "sRGB", createPixelLayer: async () => layer };
  const source = { id: 2, width: 200, height: 100 };
  const constants = { DocumentMode: { RGB: "RGB" }, BitsPerChannelType: { EIGHT: 8 } };
  const imaging = {
    getPixels: async () => ({ level: 1, sourceBounds: { left: 10, top: 5, right: 90, bottom: 45 }, imageData: { width: 160, height: 80, components: 4, colorProfile: "sRGB", getData: async () => new Uint8Array(160 * 80 * 4), dispose() {} } }),
    createImageDataFromBuffer: async (_bytes: Uint8Array, options: { width: number; height: number }) => ({ ...options, dispose() {} }),
    putPixels: async (options: { targetBounds: { left: number; top: number }; imageData: { width: number; height: number } }) => { layer.bounds = { x: options.targetBounds.left, y: options.targetBounds.top, width: options.imageData.width, height: options.imageData.height }; },
  };
  const module = { exports: {} as any };
  const require = (name: string) => {
    if (name === "photoshop") return { imaging, constants };
    if (name === "../targets") return { currentDocument: () => doc, boundsOf: (item: typeof layer) => ({ ...item.bounds }) };
    if (name === "../files") return { withAssetDocument: async (_slot: string, _payload: unknown, _context: unknown, fn: (value: typeof source) => unknown) => fn(source) };
    if (name === "../errors") return { PluginError: Error };
    if (name === "../imaging") return { finiteRect: (value: unknown) => value, toBounds: (value: unknown) => value };
    throw new Error(name);
  };
  vm.runInNewContext(`(function(require,module,exports){${readFileSync("apps/uxp-plugin/lib/editing/layers.js", "utf8")}\n})`, { Uint8Array, Map })(require, module, module.exports);
  await module.exports.place({ assetTransfers: { source: { assetId: "asset:source", sha256: "a".repeat(64) } }, args: { name: "Subject", box: { x: 0, y: 0, width: 100, height: 100 }, fit: "cover" } }, { throwIfCancelled() {} });
  const observed = JSON.parse(JSON.stringify(module.exports.sourcePlacement(doc, layer)));
  assert.deepEqual(observed, { sourceAssetId: "asset:source", sourceSha256: "a".repeat(64), sourceWidth: 200, sourceHeight: 100, sourceToDocument: [1, 0, 0, 1, -50, 0], visibleBounds: { x: 0, y: 10, width: 100, height: 80 } });
});
