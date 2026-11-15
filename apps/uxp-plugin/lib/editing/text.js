"use strict";
const { app, constants } = require("photoshop");
const targets = require("../targets");
const { PluginError } = require("../errors");
function item(layer) {
  let value; try { value = layer.textItem; } catch (_) {}
  if (!value || !value.characterStyle) throw new PluginError("PRECONDITION_FAILED", "A native text layer is required");
  return value;
}
function resolveFont(postScriptName, fallbacks = []) {
  for (const name of [postScriptName, ...fallbacks]) {
    if (typeof name !== "string" || !name) continue;
    const matches = Array.from(app.fonts || []).filter((font) => font.postScriptName === name);
    if (matches.length === 1) return matches[0].postScriptName;
    if (matches.length > 1) throw new PluginError("PRECONDITION_FAILED", `Font identity is ambiguous: ${name}`);
  }
  throw new PluginError("CAPABILITY_UNAVAILABLE", `Requested PostScript font is not installed: ${postScriptName}`);
}
async function set(layer, args) {
  const text = item(layer);
  const font = args.fontPostScriptName ? resolveFont(args.fontPostScriptName) : undefined;
  if (typeof args.text !== "string") throw new PluginError("PRECONDITION_FAILED", "Exact text is required");
  text.contents = args.text;
  if (font) text.characterStyle.font = font;
  if (args.sizePx !== undefined) text.characterStyle.size = args.sizePx;
  if (text.contents !== args.text || font && text.characterStyle.font !== font) throw new PluginError("VERIFICATION_FAILED", "Native text/font postcondition did not match");
  return layer;
}
async function fit(layer, args, context, paragraphProvider) {
  let text = item(layer);
  const policy = args.font, box = args.box;
  if (!policy || !box || typeof args.text !== "string" || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) throw new PluginError("PRECONDITION_FAILED", "Exact text, a font policy and a finite target box are required");
  const minimum = policy.minimumSizePx === undefined ? 24 : policy.minimumSizePx, maximum = policy.maximumSizePx === undefined ? 160 : policy.maximumSizePx;
  const maxLines = policy.maxLines === undefined ? 3 : policy.maxLines, leadingRatio = policy.lineHeightRatio === undefined ? 1.15 : policy.lineHeightRatio;
  if (!(minimum > 0 && maximum >= minimum && Number.isFinite(maximum) && Number.isInteger(maxLines) && maxLines > 0 && leadingRatio > 0)) throw new PluginError("PRECONDITION_FAILED", "Invalid font bounds or line policy");
  const font = resolveFont(policy.postScriptName, policy.fallbackPostScriptNames || []);
  const justification = { left: "LEFT", center: "CENTER", right: "RIGHT" }[policy.alignment || "left"];
  if (!text.paragraphStyle || !constants.Justification || constants.Justification[justification] === undefined || typeof layer.translate !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", "Native text style/translation is unavailable");
  const explicitLines = args.text.split(/\r\n|[\r\n\u2028\u2029]/).length;
  if (explicitLines > maxLines) throw new PluginError("PRECONDITION_FAILED", "Text has more explicit lines than the declared maximum");
  let paragraph = text.isParagraphText === true, provider;
  if (!paragraph && text.isPointText !== true) throw new PluginError("CAPABILITY_UNAVAILABLE", "Native text kind must be observable before fitting");
  const loadProvider = async () => {
    if (typeof paragraphProvider !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", "Paragraph fitting requires a qualified native box and rendered-line observation profile", { setup: "ps.text.layout" });
    return paragraphProvider();
  };
  // A paragraph can wrap/overflow even when its visible glyph bounds fit. Do
  // not mutate it or infer rendered lines from contents without this provider.
  if (paragraph) provider = await loadProvider();
  text.contents = args.text; text.characterStyle.font = font;
  text.paragraphStyle.justification = constants.Justification[justification];
  const setSize = (size) => {
    text.characterStyle.size = size;
    text.characterStyle.useAutoLeading = false;
    text.characterStyle.leading = size * leadingRatio;
  };
  const validateStyle = (size) => {
    if (text.contents !== args.text || text.characterStyle.font !== font || Math.abs(Number(text.characterStyle.size) - size) > 0.01 || text.characterStyle.useAutoLeading !== false || Math.abs(Number(text.characterStyle.leading) - size * leadingRatio) > 0.01 || text.paragraphStyle.justification !== constants.Justification[justification]) throw new PluginError("VERIFICATION_FAILED", "Native text contents/font/style changed during layout", { effect: "applied" });
  };
  const inside = (bounds) => [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width >= 0 && bounds.height >= 0 && bounds.x >= box.x - 0.5 && bounds.y >= box.y - 0.5 && bounds.x + bounds.width <= box.x + box.width + 0.5 && bounds.y + bounds.height <= box.y + box.height + 0.5;
  const observe = async () => {
    if (!paragraph) {
      if (text.isPointText !== true || text.isParagraphText === true) throw new PluginError("VERIFICATION_FAILED", "Text changed from observed point text during fitting", { effect: "applied" });
      // Point text has no automatic wrapping. Count only after native type and
      // exact native contents have been read back; this never handles paragraphs.
      return { lineCount: text.contents.split(/\r\n|[\r\n\u2028\u2029]/).length, overset: false, method: "native_point_text_type_and_contents" };
    }
    if (text.isParagraphText !== true) throw new PluginError("VERIFICATION_FAILED", "The text-layout recording did not preserve native paragraph text", { effect: "applied" });
    const actual = await provider.observe();
    if (!actual || !Number.isInteger(actual.lineCount) || actual.lineCount < 1 || typeof actual.overset !== "boolean" || !actual.box || !["x", "y", "width", "height"].every(key => Number.isFinite(actual.box[key]) && Math.abs(actual.box[key] - box[key]) <= 0.5)) throw new PluginError("VERIFICATION_FAILED", "Native paragraph frame/line observation is incomplete or mismatched", { effect: "applied" });
    return actual;
  };
  const search = async () => {
    let low = minimum, high = maximum, best = null;
    const attempts = policy.overflow === "error" ? 1 : 12;
    for (let attempt = 0; attempt < attempts; attempt++) {
      context.throwIfCancelled();
      const size = attempt === 0 ? maximum : attempt === 1 ? minimum : (low + high) / 2;
      setSize(size); validateStyle(size);
      const actual = await observe(), bounds = targets.boundsOf(layer);
      const fits = actual.lineCount <= maxLines && !actual.overset && (paragraph ? inside(bounds) : Number.isFinite(bounds.width) && Number.isFinite(bounds.height) && bounds.width <= box.width && bounds.height <= box.height);
      if (fits) { best = size; low = size; if (attempt === 0) break; }
      else { high = size; if (attempt === 1) break; }
    }
    return best;
  };
  if (paragraph) await provider.apply();
  let best = await search();
  if (best === null && !paragraph && policy.overflow !== "error") {
    provider = await loadProvider();
    if (typeof text.convertToParagraphText !== "function") throw new PluginError("CAPABILITY_UNAVAILABLE", "Native point-to-paragraph conversion is unavailable");
    context.throwIfCancelled(); await text.convertToParagraphText(); text = item(layer); paragraph = true;
    if (text.contents !== args.text || text.isParagraphText !== true) throw new PluginError("VERIFICATION_FAILED", "Native paragraph conversion changed exact text", { effect: "applied" });
    await provider.apply(); best = await search();
  }
  if (best === null) throw new PluginError("PRECONDITION_FAILED", "Exact text cannot fit the requested box, font bounds and rendered-line limit", { maxLines, effect: "applied" });
  setSize(best); validateStyle(best);
  if (!paragraph) {
    const current = targets.boundsOf(layer);
    const x = policy.alignment === "center" ? box.x + (box.width - current.width) / 2 : policy.alignment === "right" ? box.x + box.width - current.width : box.x;
    await layer.translate(x - current.x, box.y - current.y);
  }
  const actual = await observe(); validateStyle(best);
  const finalBounds = targets.boundsOf(layer);
  if (!inside(finalBounds) || actual.lineCount > maxLines || actual.overset) throw new PluginError("VERIFICATION_FAILED", "Final native text bounds, rendered lines or overflow do not match the layout", { effect: "applied" });
  return { layer, verification: [{ assertionId: "text.renderedLineCount", status: "pass", expected: { maximum: maxLines, overset: false }, actual: { lineCount: actual.lineCount, overset: actual.overset, kind: paragraph ? "paragraph" : "point", ...(actual.qualification ? { qualification: actual.qualification } : {}) }, method: actual.method }] };
}
module.exports = { set, fit, resolveFont };
