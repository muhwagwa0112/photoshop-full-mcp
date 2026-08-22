import { captureLiveEvidence } from "./evidence-record.mjs";

const cases = [
  ["filter.pinch", { amount: 50 }],
  ["filter.polar_coordinates", { conversion: "rectangular_to_polar" }],
  ["filter.ripple", { amount: 200, size: "medium" }],
  ["filter.spherize", { amount: 60, mode: "normal" }],
  ["filter.twirl", { angle: 180 }],
  ["filter.zigzag", { amount: 50, ridges: 8, style: "pond_ripples" }],
  ["filter.ocean_ripple", { size: 6, magnitude: 8 }],
  ["filter.diffuse_glow", { graininess: 4, glow_amount: 8, clear_amount: 10 }],
  ["filter.clouds", {}],
  ["filter.difference_clouds", {}]
];

const results = [];
for (const [commandId, commandArgs] of cases) {
  try {
    const result = await captureLiveEvidence({ commandId, commandArgs, timeoutMs: 30_000 });
    results.push({ commandId, ok: true, output: result.output });
  } catch (error) {
    results.push({ commandId, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
  process.stdout.write(`${JSON.stringify(results.at(-1))}\n`);
}

if (results.some((result) => !result.ok)) process.exitCode = 1;
