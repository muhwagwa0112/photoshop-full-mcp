import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

function modules(paragraph: boolean, textValue = "Original") {
  const style = { font: "Test-Regular", size: 20, leading: 23, useAutoLeading: false };
  const text: any = { contents: textValue, characterStyle: style, paragraphStyle: {}, isPointText: !paragraph, isParagraphText: paragraph,
    convertToParagraphText: async () => { text.isPointText = false; text.isParagraphText = true; conversions++; } };
  let conversions = 0, applies = 0, observations = 0;
  const frame = { x: 0, y: 0, width: 100, height: 100 };
  const lineCount = () => Math.ceil(text.contents.length * style.size * 0.6 / frame.width);
  const layer = { id: 11, textItem: text, translate: async () => {}, get bounds() {
    return { x: 0, y: 0, width: text.isPointText ? text.contents.length * style.size * 0.6 : frame.width, height: text.isPointText ? style.size : lineCount() * style.leading };
  } };
  const doc = { id: 7 }, app = { version: "27.9.0", fonts: [{ postScriptName: "Test-Regular" }], documents: [doc] };
  const targetHelpers = { boundsOf: (value: typeof layer) => value.bounds, resolveTarget: () => ({ document: doc, layers: [layer] }), allLayers: () => [{ layer }] };
  const fields = Object.fromEntries(["documentId", "layerId", "contents", "lineCount", "overset", "boxX", "boxY", "boxWidth", "boxHeight"].map(key => [key, { resultPath: [0, key] }]));
  // This synthetic ActionJSON belongs only to the unit harness, never the
  // installed provider index. It exercises binding/readback, not Adobe APIs.
  const profile = { operation: "ps.text.layout", resultScope: "existing_layer", source: "action_recording",
    qualification: { fixtureId: "unit-only", hostBuild: app.version, resultDigest: "a".repeat(64) },
    descriptors: [{ _obj: "unit_recorded_box", box: null }], bindings: [{ path: [0, "box"], source: ["args", "box"] }],
    postconditions: [{ resultPath: [0, "layerId"], source: ["target", "layerId"] }],
    observation: { descriptors: [{ _obj: "get", _target: [{ _ref: "layer", _id: 0 }] }], bindings: [{ path: [0, "_target", 0, "_id"], source: ["target", "layerId"] }], fields } };
  const cache = new Map<string, any>();
  const load = (name: string): any => {
    if (cache.has(name)) return cache.get(name);
    const module = { exports: {} as any };
    const require = (dependency: string): any => {
      if (dependency === "photoshop") return { app, constants: { Justification: { LEFT: "left", CENTER: "center", RIGHT: "right" } } };
      if (dependency === "uxp") return { storage: { localFileSystem: { getPluginFolder: async () => ({ getEntry: async (path: string) => ({ read: async () => JSON.stringify(path.endsWith("index.json") ? { schemaVersion: 1, templates: [{ file: "text-unit.json" }] } : profile) }) }) } } };
      if (dependency.endsWith("targets")) return targetHelpers;
      if (dependency.endsWith("files")) return {};
      if (dependency.endsWith("errors")) return load("errors");
      if (dependency.endsWith("verification")) return load("verification");
      throw new Error(`Unexpected dependency ${dependency}`);
    };
    const path = resolve(`apps/uxp-plugin/lib/${name}.js`);
    vm.runInNewContext(`(function(require,module,exports){${readFileSync(path, "utf8")}\n})`, {}, { filename: path })(require, module, module.exports);
    cache.set(name, module.exports); return module.exports;
  };
  const batchPlay = async (descriptors: any[]) => {
    if (descriptors[0]._obj === "unit_recorded_box") { applies++; Object.assign(frame, descriptors[0].box); return [{ layerId: layer.id }]; }
    observations++; assert.equal(descriptors[0]._obj, "get"); assert.equal(descriptors[0]._target[0]._id, layer.id);
    return [{ documentId: doc.id, layerId: layer.id, contents: text.contents, lineCount: lineCount(), overset: lineCount() * style.leading > frame.height,
      boxX: frame.x, boxY: frame.y, boxWidth: frame.width, boxHeight: frame.height }];
  };
  return { load, layer, text, frame, batchPlay, counts: () => ({ conversions, applies, observations }) };
}
const context = { throwIfCancelled() {} };
const args = { text: "abcdefghijabcdefghijabcdefghijabcdefghij", box: { x: 0, y: 0, width: 100, height: 100 }, font: { postScriptName: "Test-Regular", minimumSizePx: 10, maximumSizePx: 20, maxLines: 3, lineHeightRatio: 1.15, overflow: "shrink_then_wrap" } };

test("paragraph fitting never treats explicit newline count or fitting visible bounds as rendered-line proof", async () => {
  const host = modules(true), fit = host.load("editing/text").fit;
  await assert.rejects(fit(host.layer, args, context), (error: any) => error.code === "CAPABILITY_UNAVAILABLE");
  assert.equal(host.text.contents, "Original", "missing paragraph profile fails before changing contents");
  const provider = { apply: async () => {}, observe: async () => ({ lineCount: 5, overset: false, box: args.box, method: "test_observation" }) };
  Object.defineProperty(host.layer, "bounds", { get: () => ({ x: 0, y: 0, width: 50, height: 50 }) });
  await assert.rejects(fit(host.layer, { ...args, font: { ...args.font, overflow: "error" } }, context, async () => provider), (error: any) => error.code === "PRECONDITION_FAILED");
  await assert.rejects(fit(host.layer, args, context, async () => ({ ...provider, observe: async () => ({ box: args.box, overset: false }) })), (error: any) => error.code === "VERIFICATION_FAILED");
});

test("point overflow converts to native paragraph and qualified box/readback fits actual lines without changing text", async () => {
  const host = modules(false), payload = { operation: "ps.text.fit", args, target: { documentId: 7, layerIds: [11] } };
  const result = await host.load("editing/text").fit(host.layer, args, context, () => host.load("action-templates").textLayout(payload, context, host.batchPlay));
  assert.equal(result.layer.id, 11); assert.equal(host.text.contents, args.text); assert.equal(host.text.isParagraphText, true);
  assert.equal(host.counts().conversions, 1); assert.equal(host.counts().applies, 1); assert(host.counts().observations > 2);
  const proof = result.verification[0]; assert.equal(proof.status, "pass"); assert.equal(proof.method, "qualified_native_paragraph_readback");
  assert(proof.actual.lineCount > 1 && proof.actual.lineCount <= 3); assert.equal(proof.actual.overset, false);
  assert(host.text.characterStyle.size >= 10 && host.text.characterStyle.size <= 20);
});
