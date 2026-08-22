import { captureLiveEvidence } from "./evidence-record.mjs";

const geometry = {
  name: "PS_MCP_Geometry_Fixture",
  subpaths: [{
    closed: true,
    shape_operation: "add",
    points: [
      { anchor: [40, 40], left_direction: [40, 40], right_direction: [40, 40], kind: "corner" },
      { anchor: [220, 40], left_direction: [220, 40], right_direction: [220, 40], kind: "corner" },
      { anchor: [130, 160], left_direction: [85, 160], right_direction: [175, 160], kind: "smooth" }
    ]
  }]
};

const cases = [
  ["path.create", geometry],
  ["path.geometry_get", { name: "PS_MCP_Geometry_Source" }]
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
