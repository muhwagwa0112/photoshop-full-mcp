# Photoshop Full MCP v2

<p align="center">
  <strong>If Photoshop Full MCP saves you time, consider supporting its continued development, testing, and maintenance.</strong>
</p>

<p align="center">
  <a href="https://ko-fi.com/muhwagwa0112">
    <img src="docs/assets/kofi-support-red.png"
         alt="Support Muhwagwa0112 on Ko-fi"
         width="420">
  </a>
</p>

Photoshop Full MCP v2 is a local, capability-gated MCP server for Photoshop. It targets the installed Photoshop 2026 (27.9) while avoiding version and install-path assumptions.

## Quick Start for Windows

Prerequisites: Windows 10/11, Photoshop 24 or later, [Node.js 20 or later](https://nodejs.org/), and Codex Desktop or the Codex CLI. Photoshop 2026 (27.9) is the reference host.

1. Download `photoshop-full-mcp-v2.0.0-windows.zip` from the [latest release](https://github.com/muhwagwa0112/photoshop-full-mcp/releases/latest), then extract it. The adjacent signed manifest and signature authenticate future in-app updates; the `.sha256` file is an optional corruption check.
2. Open PowerShell in the extracted `photoshop-full-mcp-2.0.0` folder and run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
   ```

   The installer verifies the bundled runtime, installs it under `%LOCALAPPDATA%\PS_MCP`, and registers a separate `photoshop_full_mcp` server. The checkout/download folder is no longer needed afterward.
3. Double-click the included `photoshop-full-mcp-v2.0.0.ccx` to install the Photoshop plugin. If CCX installation is unavailable, use Adobe UXP Developer Tools and select the installed manifest shown by Doctor.
4. Restart Codex, open Photoshop, then choose **Plugins > Photoshop Full MCP Bridge**.
5. In Codex, call `photoshop_pairing_begin`, enter the complete `port-code` value shown by the trusted Windows dialog in the Photoshop panel, and call `photoshop_host_describe`. A response with `bridge.connected: true` is the first-success check.

Run Doctor at any time:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PS_MCP\app\tools\Doctor.ps1"
```

The default approval mode is automatic. Normal editing commands do not require one-by-one approval clicks. See the illustrated [Windows installation guide](docs/INSTALL.md) and [troubleshooting guide](docs/TROUBLESHOOTING.md) for update, removal, and recovery steps.

It does **not** claim that every Photoshop UI feature is scriptable. The catalog separates:

- `supported`: implemented and proven by a live Photoshop fixture on the target host
- `experimental`: entitlement, model, network, or credit dependent
- `requires_user`: creates a non-blocking job with explicit native-menu instructions that the user must complete; it does not automate OS clicks
- `unverified`: inventoried but blocked until a local fixture passes
- `unavailable`: no reliable desktop UXP contract is known

## Architecture

- MCP server: Node.js/TypeScript over stdio
- Photoshop bridge: UXP Manifest v5 panel over authenticated `127.0.0.1`
- Discovery: ports `38452` through `38462`
- Pairing: short-lived 128-bit `port-code` capability shown only in a trusted local Windows dialog opened by `photoshop_pairing_begin`
- Execution: schema validation, capability/risk policy, FIFO queue, `executeAsModal`, one-history grouping, and before/after state verification
- Approvals: automatic by default; scope-bound one-time tokens, replay protection, path limits, and advanced descriptor allowlists remain enforced
- Default file bridge: export and confined re-open use the server-owned `%LOCALAPPDATA%\PS_MCP\exports` folder without a picker; a user-selected persistent UXP folder remains optional
- Advanced raw batchPlay: hidden by default; set `PS_MCP_ADVANCED=confirm` to expose only the parameter-free `deselect` and `invert` descriptors. Other raw descriptors and all raw JSX are rejected before they reach Photoshop
- Telemetry: none

The broad feature inventory is in `catalog/features.json`. Executable contracts are in `catalog/commands.json`.

Current audited state: 101 command contracts (`87 supported`, `1 experimental`, `0 unverified`, `11 requires_user`, `2 unavailable`) and 52 feature groups (`21 supported`, `1 experimental`, `0 unverified`, `10 requires_user`, `20 unavailable`). A command or feature group is promoted to `supported` only after its signed live Photoshop 27.9 fixture passes. Invalid inherited Generative Fill and Neural Filter descriptors are explicitly unavailable, and malformed or unallowlisted raw descriptors are rejected server-side so they cannot open Photoshop's unknown-command dialog.

## Install from source

Release ZIP installation above is recommended. Contributors can instead clone the repository and run:

```powershell
npm ci --no-audit --no-fund
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Install-Local.ps1
```

The compatibility wrapper builds once, copies a self-contained production runtime to `%LOCALAPPDATA%\PS_MCP`, and registers that installed copy. Moving or deleting the source checkout afterward does not break the MCP server. The installer registers `photoshop_full_mcp` alongside an existing `photoshop_mcp`; it does not remove or edit the old package.

For the UXP plugin, run `npm run uxp:package` and install the generated CCX, or load the installed manifest reported by Doctor in Adobe UXP Developer Tools. Optionally choose an export folder in the panel. Without one, `document.export` uses the authenticated server-owned default export folder.

## Update and uninstall

```powershell
# Download, verify, and install the newest GitHub release
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PS_MCP\app\tools\Update.ps1"

# Remove the installed runtime and Codex registration; preserve pairing and exports
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PS_MCP\app\tools\Uninstall.ps1"

# Also remove pairing state and exports
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PS_MCP\app\tools\Uninstall.ps1" -RemoveUserData
```

## Safe usage sequence

1. `photoshop_host_describe`
2. `photoshop_capability_list`
3. `photoshop_state_get`
4. `photoshop_command_search` / `photoshop_command_describe`
5. `photoshop_command_execute`
6. `photoshop_preview_get` after visual changes

Destructive, validation, credit-consuming, and allowlisted advanced commands are approved automatically by the local server, so no Photoshop-panel approval click is needed. `photoshop_approval_request` remains as a compatibility API and immediately returns a completed scope-bound job. Set `PS_MCP_APPROVAL_MODE=panel` only if you intentionally want the former click-to-approve workflow. Path sandboxing, capability status gates, replay protection, and raw descriptor allowlists are not bypassed.

For local host validation, launch a temporary server with `PS_MCP_VALIDATION=confirm`. This exposes `photoshop_validation_request` and `photoshop_command_validate`. They accept only catalogued unverified UXP DOM commands, are automatically approved by default, and operate only on documents named `PS_MCP_VALIDATION_*`. Validation execution never promotes a capability automatically.

## Inventory and live evidence audit

`npm run check` includes a machine audit of every command and feature entry. The audit reports handler presence, live-fixture provenance, catalog-contract digest drift, and status/engine/route consistency. A `supported` command or feature fails the check unless a matching transaction-bound fixture exists under `evidence/live`, so an implementation or documentation string alone cannot promote support.

Generate the full read-only report with:

```powershell
npm run audit:inventory:json
```

Promotion review additionally requires a freshly captured `photoshop_host_describe` result whose bridge is currently connected. The live fixture itself must also carry a valid local evidence signature:

```powershell
npm run audit:promotion -- --promotion-command selection.ellipse --host-report .\host-describe.json
```

The command fails with `LIVE_HOST_DISCONNECTED` when the UXP bridge is not live, even if an older fixture exists. Evidence is no longer accepted from caller-authored host, result, or assertion JSON. The recorder starts a validation-profile MCP session itself, verifies the connected Photoshop identity, receives automatic scope-bound approval, executes the command in a `PS_MCP_VALIDATION_*` document, checks state and pixel-preview hashes, performs the undo round trip when required, closes the temporary document, and signs the transaction receipt:

```powershell
Set-Content .\validation-args.json '{"left":0,"top":0,"right":64,"bottom":64}'
npm run evidence:record -- --command selection.ellipse --args .\validation-args.json
```

The private evidence-signing key is stored under `%LOCALAPPDATA%\PS_MCP` with a user-only ACL; only the public verification key is stored in the repository. The recorder writes hashes and whitelisted host/verification metadata only. It does not copy pixels, document contents or names, prompts, bridge tokens, request arguments, or raw Photoshop results. Recording evidence does not edit `catalog/commands.json`; status promotion remains a separate reviewed change.

## Verification

```powershell
npm run check
npm test
npm --prefix apps\uxp-plugin run check
npm run build
npm run test:contract
```

Live generative tests are intentionally excluded. They must be explicitly approved because they may consume credits and depend on the signed-in Adobe account.

If a validation run is interrupted, inspect the active document before cleanup. The maintenance command is dry-run by default and stops as soon as the active title is not an owned `PS_MCP_*` validation title:

```powershell
npm run cleanup:owned-documents
npm run cleanup:owned-documents -- --apply
```

## Adding recorded ActionJSON

Capture a command with Photoshop's developer Action Recorder, then generate an unverified catalog entry:

```powershell
node .\scripts\import-action-recording.mjs --id filters.example --category filter --en "Example Filter" --ko "예제 필터" --file .\recording.json
```

The importer prints a catalog definition and a SHA-256 evidence digest. It never promotes the command to `supported`; promotion requires an isolated-document integration fixture.

## Data locations

- Pairing secret and endpoint metadata: `%LOCALAPPDATA%\PS_MCP`
- Default exports: `%LOCALAPPDATA%\PS_MCP\exports`
- UXP token: Photoshop UXP secure storage

Secrets and preview image data are never written to logs.
