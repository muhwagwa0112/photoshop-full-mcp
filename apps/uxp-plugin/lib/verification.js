"use strict";

const { PluginError } = require("./errors");
const targets = require("./targets");
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
async function digest(value) {
  const bytes = new TextEncoder().encode(canonical(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function readField(object, path) {
  if (typeof path !== "string" || !/^(document|layer|data|result|state)(\.[A-Za-z0-9_]+)*$/.test(path)) return undefined;
  let value = object;
  for (const key of path.split(".")) {
    if (["__proto__", "prototype", "constructor"].includes(key) || !value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
function evaluate(assertions, projection) {
  return (assertions || []).map((assertion) => {
    const actual = readField(projection, assertion.subject);
    const expected = assertion.expected;
    let pass, method = "typed_state_postcondition";
    switch (assertion.operator) {
      case "equals": case "interval_equals": pass = actual !== undefined && canonical(actual) === canonical(expected); break;
      case "not_equals": pass = actual !== undefined && canonical(actual) !== canonical(expected); break;
      case "exists": pass = actual !== undefined && actual !== null; break;
      case "absent": case "target_absent": pass = actual === undefined || actual === null; break;
      case "within": pass = typeof actual === "number" && typeof expected === "number" && Math.abs(actual - expected) <= Number(assertion.tolerance || 0); break;
      case "gte": pass = typeof actual === "number" && typeof expected === "number" && actual >= expected; break;
      case "lte": pass = typeof actual === "number" && typeof expected === "number" && actual <= expected; break;
      default: return { assertionId: assertion.id, status: "not_run", method: "unsupported_assertion_operator" };
    }
    return { assertionId: assertion.id, status: pass ? "pass" : "fail", expected, ...(actual === undefined ? {} : { actual }), method };
  });
}
function projection(target, result, state) {
  let document = null, layer = null;
  try {
    const resolved = targets.resolveTarget(target);
    document = targets.inspectDocument({ documentId: resolved.document.id });
    if (resolved.layers.length === 1) layer = targets.layerProjection(resolved.layers[0], targets.allLayers(resolved.document).find((entry) => entry.layer.id === resolved.layers[0].id).parents);
  } catch (error) { if (!["NO_DOCUMENT", "STALE_TARGET"].includes(error.code)) throw error; }
  return { document, layer, data: result === undefined ? null : result, result: result === undefined ? null : result, state: state || null };
}
async function assertExpected(expected, observed) {
  if (!expected) return;
  if (expected.projectionVersion !== 1 || await digest(expected.fields) !== expected.digest) throw new PluginError("PRECONDITION_FAILED", "Expected state digest/version is invalid", { effect: "not_applied" });
  for (const [path, value] of Object.entries(expected.fields)) {
    if (canonical(readField(observed, path)) !== canonical(value)) throw new PluginError("PRECONDITION_FAILED", `Target precondition changed: ${path}`, { effect: "not_applied" });
  }
}
function commandAssertions(commandId, args, before, after, result) {
  const checks = [];
  const add = (id, expected, actual) => checks.push({ assertionId: id, status: canonical(expected) === canonical(actual) ? "pass" : "fail", expected, actual: actual === undefined ? null : actual, method: "command_postcondition" });
  const layer = after && after.activeLayer;
  switch (commandId) {
    case "layer.rename": add("layer.name", args.name, layer && layer.name); break;
    case "layer.opacity_set": add("layer.opacity", args.opacity, layer && layer.opacity); break;
    case "layer.visibility_set": add("layer.visible", args.visible, layer && layer.visible); break;
    case "text.content_set": add("text.contents", args.content, layer && layer.text); break;
    case "image.resize": add("document.width", args.width, after.activeDocument && after.activeDocument.width); if (args.height !== undefined) add("document.height", args.height, after.activeDocument && after.activeDocument.height); break;
    case "document.resize_canvas": add("canvas.width", args.width, after.activeDocument && after.activeDocument.width); add("canvas.height", args.height, after.activeDocument && after.activeDocument.height); break;
    case "document.close": add("document.closed", false, Boolean(after && after.hasDocument && after.activeDocument && before.activeDocument && after.activeDocument.id === before.activeDocument.id)); break;
    case "document.create": add("document.created", true, Boolean(result && result.id && result.width === args.width && result.height === args.height)); break;
    case "selection.deselect": add("selection.empty", false, after.hasSelection); break;
    default: checks.push({ assertionId: `${commandId}.state`, status: "not_run", method: "state_snapshot_only_no_registered_postcondition" });
  }
  return checks;
}
module.exports = { digest, canonical, evaluate, projection, assertExpected, commandAssertions };
