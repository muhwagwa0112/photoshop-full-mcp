# Live Photoshop evidence

`live/commands/*.json` and `live/features/*.json` are machine-audited evidence records. Do not create them from file presence alone.

A command record is accepted only when it is bound to the catalog contract digest and records:

- a connected Photoshop host identity at capture time;
- an isolated `PS_MCP_VALIDATION_*` document;
- successful execution and state verification;
- an actual one-step undo round trip for history-backed commands;
- visual preview verification when the catalog requires it;
- closure of the temporary validation document.

The recorder copies only this metadata. It does not persist document names, pixels, prompts, bridge tokens, request payloads, or Photoshop result data.

Evidence alone does not edit the catalog. Promotion is a separate reviewed change and `npm run check` rejects any `supported` entry whose fixture is missing, stale, or incomplete.
