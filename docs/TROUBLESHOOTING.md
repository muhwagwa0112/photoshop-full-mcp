# Troubleshooting

Start with the built-in diagnostic:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PS_MCP\app\tools\Doctor.ps1" -Live
```

Doctor returns one structured result and exits non-zero when a required check fails. It checks Node.js, the installed runtime, UXP package/manifest, Codex registration, Photoshop discovery, and—when `-Live` is used—the local bridge endpoint.

## `node-version` fails

Install Node.js 20 or later, close all PowerShell and Codex windows, and run the installer again. Confirm with `node --version`.

## `codex-registration` fails

Confirm Codex is installed and available with `codex --version`. Re-run `Install.ps1`; it backs up and restores Codex configuration if registration fails. The correct registration name is `photoshop_full_mcp`, not the older `photoshop_mcp`.

## Plugin is not visible or remains “Not loaded”

Restart Photoshop after installing the CCX. If it is still absent, use the manifest fallback reported by Doctor:

1. Open Adobe UXP Developer Tools.
2. Select **Add Plugin** and choose the reported `manifest.json`.
3. Click **Load** or **Load & Watch**.
4. Open **Plugins > Photoshop Full MCP Bridge** in Photoshop.

## Bridge is disconnected

- Keep the Photoshop panel open.
- Check that no firewall or security product blocks loopback traffic on ports `38452–38462`.
- Restart Codex, then reopen the panel.
- Pair again with `photoshop_pairing_begin` if the plugin storage was reset.
- Do not copy or edit the token files under `%LOCALAPPDATA%\PS_MCP`.

The bridge binds only to `127.0.0.1`; it is not a LAN service.

## “Unknown command” / `<알 수 없음> 명령`

Do not retry the same raw descriptor. Use `photoshop_command_search` to find a locale-independent catalog command ID, inspect it with `photoshop_command_describe`, and execute that ID. Unverified and unavailable commands are rejected before reaching Photoshop so they cannot open the native unknown-command dialog.

## Approval buttons appear for every command

Automatic approval is the default. Remove a stale `PS_MCP_APPROVAL_MODE=panel` environment override and restart Codex. Automatic mode still enforces capability gates, path confinement, replay protection, and the advanced descriptor allowlist.

## Update signature or digest verification fails

Delete the downloaded ZIP, signed manifest, and signature, then run Update again. Do not bypass signature, size, or digest validation. A failure means the metadata is not signed by the trusted release key, or the archive is incomplete or is not the exact asset described by the signed manifest.

## Reinstall without deleting exports

Run Uninstall without `-RemoveUserData`, then install again. `%LOCALAPPDATA%\PS_MCP\exports` and pairing-related user data remain in place.
