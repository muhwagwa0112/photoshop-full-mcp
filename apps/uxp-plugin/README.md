# Photoshop Full MCP UXP plugin

UXP-side bridge for Photoshop Full MCP v2. Load this folder through UXP Developer Tool, open **Plugins → Photoshop Full MCP**, call `photoshop_pairing_begin`, and enter the code shown in the trusted local Windows dialog. The MCP response never contains the code.

The manifest supports Photoshop 24 and later with DOM API v2; the reference runtime for this release is Photoshop 27.9.

The plugin only connects to `localhost` ports `38452–38462`, while every Node bridge binds exclusively to `127.0.0.1`. The hostname is required because UXP 9.3 discards IP-literal manifest origins. It discovers and fairly polls every running bridge with the paired server identity, allowing Codex Desktop and short-lived `codex exec` processes to coexist. Results and approval decisions are routed back to the exact port that issued them. Its bearer token is stored in UXP `secureStorage`; the non-secret server identity and persistent export-folder token are kept in plugin-local settings.

Panel unpair requests token rotation from every authenticated matching bridge through `POST /v1/unpair`. Local credentials are deleted only after all reachable matching bridges acknowledge the rotation.

## Supported request kinds

- `host.describe`
- `state.get`
- `preview.get`
- `command.execute`
- `advanced.batchplay` (dispatched only after the authenticated server validates the narrow descriptor allowlist and consumes a scope-bound one-time approval token)
- `approval.request` (used only when the optional `PS_MCP_APPROVAL_MODE=panel` mode is enabled)
- `job.resume` (wire-compatible only; public remote resume fails closed for approval and user-assisted jobs)
- `job.cancel`

The authoritative command surface is `../../catalog/commands.json`, not a duplicated list in this file. The repository checker requires every executable UXP handler to have a catalog contract and every executable catalog contract to have a handler. The current audited catalog contains 101 contracts, including 87 live-fixture-backed `supported` commands.

Raw descriptors are never accepted by `verified.batchplay`; the request must name a bundled `verification_id`. `advanced.batchplay` is hidden unless `PS_MCP_ADVANCED=confirm` and accepts only the parameter-free `deselect` and `invert` descriptors. In the default automatic-approval mode, the server issues and consumes the scope-bound token locally; panel approval is required only when the optional panel mode is selected. Other descriptors and raw JSX are rejected before bridge dispatch.

Every catalog command marked `requires_user` becomes an asynchronous user-assisted job when `jobId` is supplied. The panel shows command-specific manual instructions and posts completion or cancellation back to the exact issuing bridge without holding a native dialog open inside an MCP request.

In optional panel-approval mode, approval cards preserve and display the server-provided consequence and full scope digest as plain text. Generic MCP `job.resume` cannot complete approval or user-assisted jobs; only an authenticated panel completion/cancellation decision can finish a user-assisted job.

Run `npm run check` for manifest and JavaScript syntax checks. Runtime validation requires Photoshop and UXP Developer Tool.
