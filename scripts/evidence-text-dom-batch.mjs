import { captureLiveEvidence } from "./evidence-record.mjs";

const cases = [
  ["text.character_style_set", { size: 32, leading: 38, tracking: 80, faux_bold: true, faux_italic: false, horizontal_scale: 110, vertical_scale: 100, use_auto_leading: false }],
  ["text.paragraph_style_set", { justification: "center", hyphenation: false, first_line_indent: 8, left_indent: 6, right_indent: 6, space_before: 4, space_after: 10 }],
  ["text.warp_style_set", { style: "arc", bend: 30, direction: "horizontal", horizontal_distortion: 5, vertical_distortion: 0 }],
  ["text.convert", { operation: "point_to_paragraph" }]
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
