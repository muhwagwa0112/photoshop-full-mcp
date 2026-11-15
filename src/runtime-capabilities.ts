import type { CommandDefinition } from "../packages/contracts/src/index.js";

const PROBES: Record<string, string[]> = {
  "selection.ellipse": ["selection.selectEllipse"], "selection.expand": ["selection.expand"], "selection.contract": ["selection.contract"],
  "selection.feather": ["selection.feather"], "selection.border": ["selection.selectBorder"], "selection.polygon": ["selection.selectPolygon"],
  "selection.grow": ["selection.grow"], "selection.smooth": ["selection.smooth"],
  "layer.clipping_set": ["layer.isClippingMask"], "layer.blend_mode_set": ["layer.blendMode"], "layer.fill_opacity_set": ["layer.fillOpacity"], "layer.locked_set": ["layer.allLocked"],
  "filter.gaussian_blur": ["layer.applyGaussianBlur"], "filter.sharpen": ["layer.applySharpen"], "filter.add_noise": ["layer.applyAddNoise"],
  "filter.pinch": ["layer.applyPinch"], "filter.polar_coordinates": ["layer.applyPolarCoordinates"], "filter.ripple": ["layer.applyRipple"],
  "filter.spherize": ["layer.applySpherize"], "filter.twirl": ["layer.applyTwirl"], "filter.zigzag": ["layer.applyZigZag"],
  "filter.ocean_ripple": ["layer.applyOceanRipple"], "filter.diffuse_glow": ["layer.applyDiffuseGlow"], "filter.clouds": ["layer.applyClouds"], "filter.difference_clouds": ["layer.applyDifferenceClouds"],
  "text.character_style_set": ["text.characterStyle.size", "text.characterStyle.leading", "text.characterStyle.tracking"],
  "text.paragraph_style_set": ["text.paragraphStyle.justification"], "text.warp_style_set": ["text.warpStyle.style", "text.warpStyle.bend"],
  "document.open_default": ["app.open"],
};
function read(value: unknown, path: string): unknown {
  for (const part of path.split(".")) { if (!value || typeof value !== "object") return undefined; value = (value as Record<string, unknown>)[part]; }
  return value;
}
export function commandRuntimeAvailability(command: CommandDefinition, runtime: unknown): Record<string, unknown> {
  const version = read(runtime, "appVersion");
  if (typeof version !== "string") return { state: "unknown", reason: "No connected host version/target observation", qualification: "not_observed" };
  const current = version.split(".").map(Number), minimum = command.minHostVersion.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if ((current[index] ?? 0) > (minimum[index] ?? 0)) break;
    if ((current[index] ?? 0) < (minimum[index] ?? 0)) return { state: "unsupported", hostVersion: version, reason: `Requires Photoshop ${command.minHostVersion} or later`, qualification: "version_check" };
  }
  const paths = PROBES[command.id];
  if (!paths) return { state: "unknown", hostVersion: version, reason: "No exact command/target probe is registered; catalog implementation status is separate", qualification: "not_observed" };
  const observed = paths.map(path => ({ symbol: path, exposed: read(runtime, `runtimeProbes.${path}`) }));
  const state = observed.some(item => item.exposed === false) ? "unsupported" : observed.every(item => item.exposed === true) ? "available" : "unknown";
  return { state, hostVersion: version, observed, qualification: "symbols_only", reason: "Method/property exposure is observed; document mode, arguments, entitlement, and result postconditions are checked at execution" };
}
