# Automated image and video workflows

The new workflow runtime compiles typed editing requests into host and local-worker operations. A persistent owner executes the work, records receipts, resolves exact targets, produces artifacts and evaluates the declared requirements. Photoshop-only work belongs to the Photoshop owner. Premiere and cross-application work belongs to the existing Premiere daemon; cross-application Photoshop edits are sent to its authenticated peer owner.

Implementation and live-device qualification are separate. The source changes do not certify any Photoshop/Premiere build, encoder preset, model, font or GPU. Unsupported APIs and missing profiles return an explicit setup/capability state. A successful transport reply, an encoder queue acknowledgement or an existing output path is insufficient to declare a completed edit.

## Install the matching source and plugins

Use Node **20.19 or later**. Install the repository dependencies and build the selected repository on the target machine. The build copies JSON contracts and Python worker files into the runtime. Deploy the updated UXP/CEP plugin together with the owner/daemon code; a running old plugin cannot acquire new handlers by updating the Node package alone. Existing pairing credentials, user documents, output directories and previous workflow receipts remain installation data.

The Photoshop stdio entry now connects to a persistent local owner. Closing an MCP client does not terminate an accepted job. `node dist/src/index.js --stop-runtime-owner` requests an authenticated, graceful owner stop; an active job must finish or be cancelled first. The installer uses this operation before replacing runtime files. It does not terminate Adobe applications or arbitrary Node processes. Premiere continues to use its existing daemon installation and restart commands.

The updated Photoshop plugin requires authenticated `ps-mcp-bridge/4` discovery and `ps-mcp-executor/1` execution metadata. Every native command carries its operation ID, request digest, owner generation, dispatch sequence and host epoch. Update the plugin and runtime together. If an authenticated legacy standalone bridge is still running, startup/installation returns `LEGACY_BRIDGE_ACTIVE`; close that old MCP process after its work settles, then retry. A new owner cannot safely drain the old process through a protocol it did not implement.

No model downloads or Adobe host execution are part of source installation. Configure the optional worker as described in [workers/README.md](../workers/README.md). Actual device tests should exercise the changed operation/recipe on the intended profile; no new full-suite hook or recurrent audit is installed by this change.

## Configure roots, presets and the controller

Set `ADOBE_MCP_AUTOMATION_CONFIG` in the **owner/daemon** environment to an absolute JSON path, or use `<workflow-data-directory>/profiles/automation.json`. An explicit `roots` map replaces the legacy fallback map. Inputs and deliveries refer to stable root IDs plus relative paths. Do not use broad writable roots when a job only needs a source directory and a delivery directory.

Start with [config.windows.example.json](../examples/automation/config.windows.example.json). Change every example directory to an existing directory on the actual machine. Source roots can be read-only. The runtime creates owned working copies under its internal `assets` directory; source files are never the default edit/save destination. Register actual Premiere `.epr` encoder presets and sequence preset files, then reference their IDs in the request. Preset IDs are installation mappings, not names inferred from the user's filesystem.

The loader accepts:

```ts
interface InstallationConfiguration {
  schemaVersion: 1;
  roots: Record<string, { path: string; readOnly?: boolean }>;
  presets?: Record<string, { rootId: string; relativePath: string }>;
  sequencePresets?: Record<string, { rootId: string; relativePath: string }>;
  controller?: {
    providerId: string;
    endpoint: string;              // numeric loopback HTTP, e.g. http://127.0.0.1:11434
    modelTag: string;              // an already installed vision model
    modelDigest: string;           // the actual full installed SHA-256 digest
    templateDigest: string;        // actual /api/show template/model/vision snapshot digest
    runtimeVersion?: string;
    numCtx: number;
    maxOutputTokensPerCall: number;
    inputTokenUpperBound: number;
    inputBoundQualified: boolean;  // true only for an actually qualified bound
    inputLimits: { maxUtf8TextBytes: number; maxImages: number; maxImagePixels: string };
    maxPayloadBytes?: number;
  };
}
```

The local provider uses Ollama `/api/chat` with schema-constrained image/text output. A full model digest and qualified input bound are required before enabling unattended calls. The runtime verifies the installed model identity, persists budget reservations and accounts for unknown outcomes conservatively. An HTTP abort does not prove that backend inference stopped. A missing or incomplete provider configuration leaves `client_agent` operation available and configured-provider work waiting for setup; it never fabricates a review.

`node scripts/record-controller-profile.mjs --output <absolute-new-file>` records the already-installed local `gemma3:4b` model digest, Ollama version and `/api/show` snapshot digest. It makes no inference request and downloads nothing. Copy the generated `controller` object into `automation.json`, complete the text/image/token limits from the intended profile's measured bound and mark the bound qualified only when that evidence exists. The generated `observedSnapshot` and `qualification` are supporting records, not top-level `automation.json` fields. Installed Photoshop runtimes also include the recorder under `dist/scripts/`.

For `client_agent`, retrieve the pending controller request, inspect its fixed observations/context and submit a response with the same request ID and digest. The owner validates all target bindings, operation IDs, parameters, requirements, evidence references and budgets before applying any proposal. The client does not gain permission to introduce new file roots or paid/remote/generative operations.

## Recipes and requests

The canonical request schemas are shipped under [src/automation](../src/automation/). Recipe-specific fields use closed schemas. These recipe request types are implemented by the compiler; each job still needs the capabilities required by its chosen steps:

| Recipe | Editing goal |
|---|---|
| `ps.product_variants.v1` | Product/template/brand placement and explicitly mapped output sizes. |
| `ps.photo_composite.v1` | Source preparation, selected subject/mask, composite and preserved native master. |
| `ps.social_layout.v1` | Template/role binding, text and image replacement, layout variants. |
| `pr.interview_captioned.v1` | Media analysis, dialogue/cut mapping, timeline construction, audio/captions and delivery. |
| `pr.multicam_edit.v1` | Source synchronization and explicit camera cuts, preserving the requested representation. |
| `pr.project_revision.v1` | Reopen a checkpointed project and apply a typed revision to bound resources. |
| `cross.ps_title_to_premiere.v1` | Produce a Photoshop title asset and apply the same revision in Premiere. |

Examples in [examples/automation](../examples/automation/) contain illustrative input paths, installation IDs, request IDs and deadlines. Before submitting, replace `workflowHome` with the actual owner identity, choose a **new persisted requestId**, set a future deadline, supply real assets and match preset/root IDs to the installation. Keep the same request ID when querying/retrying the same accepted request. Any semantic change, including brief, policy, output settings or revision, requires a new request ID.

The owner hashes the complete normalized semantic request before invoking a host/model. Identical IDs and payloads join/reuse the accepted result; changed payloads return an idempotency conflict. Full results can be retained separately from request identity tombstones. A caller timeout does not imply the native edit failed or is safe to repeat.

Role binding can use an explicit sidecar or `roleManifest: "auto"`. Automatic binding uses actual inventory candidates and visual observations, then validates the controller's candidate keys and records a pinned sidecar. A missing/ambiguous role fails; there is no “first matching name/layer/clip” fallback. An observed-projection fingerprint is labelled as such and is never described as a full pixel-content fingerprint.

Native raster placement records the authenticated source asset ID/hash, observed source dimensions, the source-to-document affine and current visible bounds. Transparent border trimming, pyramid scaling and cover cropping are included in that transform. Unknown/reopened placement provenance is not reconstructed from a layer's bounding box. Raster/mask restoration is also bound to the captured document history state; a stale raster cannot silently patch a subsequently edited document.

## Recorded native providers

Operations whose required ActionJSON/native readback is not exposed by the stable DOM use [the recorded-template provider](../apps/uxp-plugin/lib/action-templates.js). Its `lib/action-templates/index.json` initially contains an empty `templates` array. Add an entry `{ "file": "recording-name.json" }` only for a recording qualified on the installed Photoshop build. A template supplies `source: "action_recording"`, `operation`, optional `variant`, `qualification: { fixtureId, hostBuild, resultDigest }`, actual `descriptors`, `bindings` and nonempty `postconditions`. Bindings use typed path arrays into existing descriptor placeholders. Qualification does not transfer automatically to another host build.

Paragraph text fitting additionally needs a `ps.text.layout` recording with `resultScope: "existing_layer"` and an independent `observation` block. All observation descriptors must be native `get` operations; `fields` map actual result paths for `documentId`, `layerId`, `contents`, `lineCount`, `overset`, `boxX`, `boxY`, `boxWidth` and `boxHeight`. Only `lineCount` permits `transform: "array_length"`. The provider checks exact target identity, text, paragraph frame, rendered line count and overset after fitting. Point text uses its separate observed capability. A missing paragraph provider does not become a guessed line-count pass. Artboard-variant recordings require `resultScope: "new_document"` and must produce exactly one isolated document with the requested dimensions.

## Completion, cancellation and revision

The runtime keeps source and timeline clocks separate and stores times as decimal integer tick strings. Frame rates are rational numbers. Host targets include the host epoch plus document/project/sequence and resource identity. Stale targets are re-resolved through recorded observations or rejected. Cross-track movement, native multicam and effect values are not approximated by changing their meaning.

Native mutations are serialized within their materialization group. A revision starts from the recorded saved checkpoint and reconstructs effects absent from that saved boundary. The presence of an old execution receipt alone does not prove that a PSD or Premiere project contains that effect. Immutable derived artifacts may be reused only with matching input/configuration hashes.

Cancellation uses a control lane separate from the native command queue. A late success receipt does not revive a cancelled job. `OUTCOME_UNKNOWN` requires receipt/postcondition/checkpoint reconciliation; automatic replay of a potentially applied mutation is forbidden. Workers kill only their owned subprocess group, preserve a durable claim and do not publish partial output as a successful result.

The Photoshop native journal retains up to 256 settled receipt bodies or 64 MiB, preserving compact identity tombstones when bodies expire. Pending/unknown outcomes, unresolved publication intents and incomplete canonical finalization remain protected. `RESULT_EXPIRED` means that the result body is no longer available; it never authorizes the same operation ID to execute again. Journal writes are serialized and synchronized before acknowledgement; an ambiguous append failure poisons the writer until restart/recovery. Successful canonical receipts include the actual post-operation document history projection so the workflow can reject unrelated edits between its own steps.

Exports go through a job-owned staging path, host completion observation, actual artifact checks and publication. Default collision policy creates a new version. Explicit overwrite requires the expected current hash and still cannot replace an original input. Premiere validation compares the requested dimensions, frame rate, pixel aspect, codecs, pixel format, field order and specified audio/color constraints against the generated file. Full decode is selected only when the request explicitly requires it. Image evidence records actual bounds, scaling, alpha and color information; a source video frame is never passed off as an edited-sequence preview.

Requirements remain fixed for the request. Required assertion/semantic conditions must pass; missing, stale, partial or uncertain evidence cannot become a pass. Semantic repair is bounded by the declared repair count, elapsed time and model budget. A model cannot erase a failing requirement or invent a host readback. Native caption text/style, complex cross-track preservation and native multicam require an actual implementing provider; a worker-rendered alternative is usable only when the delivery policy explicitly permits it.

## Device verification

The implementation review covers source correctness, integration, failure semantics and available focused tests. Later verification on the real installation must record its exact host/plugin/model/preset versions and the actual assertions/artifacts for the affected capability. Use owned temporary projects and representative input assets. Capture the concrete export, cancellation/reconnect or editing case relevant to the feature being qualified. The status remains `not_run` for operations that have not been executed on that profile.
