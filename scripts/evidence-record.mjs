import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { catalogContractDigest, evidenceReceiptPayload, normalizeLiveHostReport } from "./inventory-evidence-audit.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const values = { timeoutMs: 120_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--command", "--args", "--output", "--timeout-ms"].includes(key)) throw new Error(`Unknown argument: ${key}. Evidence input files are not trusted; this command captures a live MCP transaction directly.`);
    const value = argv[++index];
    if (!value) throw new Error(`${key} requires a value`);
    if (key === "--timeout-ms") values.timeoutMs = Number(value);
    else values[key.slice(2)] = value;
  }
  if (!values.command) throw new Error("Missing --command");
  if (!Number.isInteger(values.timeoutMs) || values.timeoutMs < 5_000 || values.timeoutMs > 600_000) throw new Error("--timeout-ms must be an integer from 5000 to 600000");
  return values;
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : (typeof value === "string" ? value : JSON.stringify(value));
  return createHash("sha256").update(bytes).digest("hex");
}

function structured(result, toolName) {
  if (result?.isError) {
    const message = result.content?.find((entry) => entry.type === "text")?.text || `${toolName} failed`;
    throw new Error(message);
  }
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result?.content?.find((entry) => entry.type === "text")?.text;
  if (typeof text === "string") {
    try { return JSON.parse(text); } catch (_) {}
  }
  throw new Error(`${toolName} returned no structured result`);
}

async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

function previewDigest(result) {
  if (result?.isError) throw new Error(result.content?.find((entry) => entry.type === "text")?.text || "photoshop_preview_get failed");
  const image = result?.content?.find((entry) => entry.type === "image");
  if (!image || typeof image.data !== "string") throw new Error("photoshop_preview_get returned no image; provenance requires a live preview");
  return sha256(Buffer.from(image.data, "base64"));
}

async function waitForApproval(client, jobId, deadline) {
  while (Date.now() < deadline) {
    const job = structured(await call(client, "photoshop_job_get", { job_id: jobId }), "photoshop_job_get");
    if (job.status === "completed") {
      if (typeof job.approvalToken !== "string") throw new Error("Completed approval job did not return a one-time token");
      return job.approvalToken;
    }
    if (["failed", "cancelled"].includes(job.status)) throw new Error(`Approval job ${job.status}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error("Timed out waiting for approval completion");
}

async function approvedValidation(client, commandId, args, deadline) {
  const requested = structured(await call(client, "photoshop_validation_request", { command_id: commandId, args }), "photoshop_validation_request");
  if (typeof requested.id !== "string") throw new Error("Validation approval did not return a job id");
  const token = await waitForApproval(client, requested.id, deadline);
  const validated = structured(await call(client, "photoshop_command_validate", { command_id: commandId, args, approval_token: token }), "photoshop_command_validate");
  if (validated.ok !== true || validated.status !== "completed" || validated.commandId !== commandId || typeof validated.requestId !== "string") throw new Error(`Live validation did not complete for ${commandId}`);
  return validated;
}

async function executeEvidenceCommand(client, commandId, args, deadline, catalogById) {
  const definition = catalogById.get(commandId);
  if (!definition) throw new Error(`Evidence setup references unknown command: ${commandId}`);
  if (definition.status === "supported" || definition.status === "experimental") {
    const executed = structured(await call(client, "photoshop_command_execute", { command_id: commandId, args }), "photoshop_command_execute");
    if (executed.ok !== true || executed.status !== "completed" || executed.commandId !== commandId) throw new Error(`Catalog execution did not complete for ${commandId}`);
    return executed;
  }
  return approvedValidation(client, commandId, args, deadline);
}

async function waitForConnectedHost(client, deadline) {
  let lastResult;
  while (Date.now() < deadline) {
    lastResult = structured(await call(client, "photoshop_host_describe"), "photoshop_host_describe");
    const normalized = normalizeLiveHostReport(lastResult);
    if (normalized.connected) return { result: lastResult, normalized };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`LIVE_HOST_DISCONNECTED: the UXP plugin did not connect before the validation deadline${lastResult ? "" : " (no host response)"}`);
}

function stateIdentity(state) {
  const doc = state?.activeDocument;
  return { hasDocument: state?.hasDocument === true, id: doc?.id ?? null, title: doc?.title ?? null };
}

const EVIDENCE_SETUP_STEPS = Object.freeze({
  "layer.rename": [{ commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } }],
  "layer.delete": [{ commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } }],
  "layer.visibility_set": [{ commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } }],
  "layer.opacity_set": [{ commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } }],
  "layer.clipping_set": [{ commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } }],
  "layer.blend_mode_set": [{ commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } }],
  "layer.fill_opacity_set": [{ commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } }],
  "layer.locked_set": [{ commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } }],
  "mask.properties_get": [{ commandId: "layer.create", args: { name: "PS_MCP_Mask_Property_Layer" } }],
  "mask.properties_set": [
    { commandId: "text.create", args: { name: "PS_MCP_Vector_Mask_Property_Layer", content: "Mask fixture" } },
    { commandId: "text.convert", args: { operation: "to_shape" } }
  ],
  "history.state_list": [{ commandId: "layer.create", args: { name: "PS_MCP_History_State" } }],
  "history.state_activate": [{ commandId: "layer.create", args: { name: "PS_MCP_History_State" } }],
  "layer.translate": [
    { commandId: "text.create", args: { name: "PS_MCP_Transform_Layer", content: "PS MCP transform fixture" } }
  ],
  "layer.scale": [
    { commandId: "text.create", args: { name: "PS_MCP_Transform_Layer", content: "PS MCP transform fixture" } }
  ],
  "layer.rotate": [
    { commandId: "text.create", args: { name: "PS_MCP_Transform_Layer", content: "PS MCP transform fixture" } }
  ],
  "text.content_set": [{ commandId: "text.create", args: { name: "PS_MCP_Setup_Text", content: "setup" } }],
  "text.character_style_set": [{ commandId: "text.create", args: { name: "PS_MCP_Character_Style", content: "Typography fixture" } }],
  "text.paragraph_style_set": [{ commandId: "text.create", args: { name: "PS_MCP_Paragraph_Style", content: "Paragraph fixture\nSecond line" } }],
  "text.warp_style_set": [{ commandId: "text.create", args: { name: "PS_MCP_Warp_Style", content: "Warp fixture" } }],
  "text.convert": [{ commandId: "text.create", args: { name: "PS_MCP_Convert_Text", content: "Convert fixture" } }],
  "history.undo": [{ commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } }],
  "history.redo": [
    { commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } },
    { commandId: "history.undo", args: {} }
  ],
  "selection.deselect": [{ commandId: "selection.select_all", args: {} }],
  "selection.invert": [{ commandId: "selection.rectangle", args: { left: 48, top: 48, right: 160, bottom: 128, feather: 0, anti_alias: true } }],
  "selection.expand": [{ commandId: "selection.rectangle", args: { left: 48, top: 48, right: 160, bottom: 128, feather: 0, anti_alias: true } }],
  "selection.contract": [{ commandId: "selection.rectangle", args: { left: 24, top: 24, right: 220, bottom: 180, feather: 0, anti_alias: true } }],
  "selection.feather": [{ commandId: "selection.rectangle", args: { left: 48, top: 48, right: 160, bottom: 128, feather: 0, anti_alias: true } }],
  "selection.border": [{ commandId: "selection.rectangle", args: { left: 48, top: 48, right: 160, bottom: 128, feather: 0, anti_alias: true } }],
  "selection.grow": [{ commandId: "selection.rectangle", args: { left: 48, top: 48, right: 160, bottom: 128, feather: 0, anti_alias: true } }],
  "selection.smooth": [{ commandId: "selection.rectangle", args: { left: 48, top: 48, right: 160, bottom: 128, feather: 0, anti_alias: true } }],
  "filter.gaussian_blur": [{ commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } }],
  "filter.sharpen": [{ commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } }],
  "filter.pinch": [{ commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } }],
  "filter.polar_coordinates": [{ commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } }],
  "filter.ripple": [{ commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } }],
  "filter.spherize": [{ commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } }],
  "filter.twirl": [{ commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } }],
  "filter.zigzag": [{ commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } }],
  "filter.ocean_ripple": [{ commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } }],
  "filter.diffuse_glow": [{ commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } }],
  "filter.clouds": [{ commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } }],
  "filter.difference_clouds": [{ commandId: "filter.add_noise", args: { amount: 12, distribution: "uniform", monochromatic: true } }],
  "channel.duplicate": [{ commandId: "channel.create", args: { name: "PS_MCP_Setup_Channel" } }],
  "channel.delete": [{ commandId: "channel.create", args: { name: "PS_MCP_Setup_Channel" } }],
  "path.create_from_selection": [
    { commandId: "selection.rectangle", args: { left: 48, top: 48, right: 192, bottom: 160, feather: 0, anti_alias: true } }
  ],
  "path.geometry_get": [
    { commandId: "path.create", args: { name: "PS_MCP_Geometry_Source", subpaths: [{ closed: true, shape_operation: "add", points: [{ anchor: [40, 40], left_direction: [40, 40], right_direction: [40, 40], kind: "corner" }, { anchor: [220, 40], left_direction: [220, 40], right_direction: [220, 40], kind: "corner" }, { anchor: [130, 160], left_direction: [85, 160], right_direction: [175, 160], kind: "smooth" }] }] } }
  ],
  "path.select": [
    { commandId: "selection.rectangle", args: { left: 48, top: 48, right: 192, bottom: 160, feather: 0, anti_alias: true } },
    { commandId: "path.create_from_selection", args: { name: "PS_MCP_Setup_Path", tolerance: 2 } }
  ],
  "path.duplicate": [
    { commandId: "selection.rectangle", args: { left: 48, top: 48, right: 192, bottom: 160, feather: 0, anti_alias: true } },
    { commandId: "path.create_from_selection", args: { name: "PS_MCP_Setup_Path", tolerance: 2 } }
  ],
  "path.delete": [
    { commandId: "selection.rectangle", args: { left: 48, top: 48, right: 192, bottom: 160, feather: 0, anti_alias: true } },
    { commandId: "path.create_from_selection", args: { name: "PS_MCP_Setup_Path", tolerance: 2 } }
  ],
  "path.make_selection": [
    { commandId: "selection.rectangle", args: { left: 48, top: 48, right: 192, bottom: 160, feather: 0, anti_alias: true } },
    { commandId: "path.create_from_selection", args: { name: "PS_MCP_Setup_Path", tolerance: 2 } }
  ],
  "layer_comp.create": [
    { commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } }
  ],
  "layer_comp.apply": [
    { commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } },
    { commandId: "layer_comp.create", args: { name: "PS_MCP_Setup_Comp", visibility: true, position: true, appearance: true } }
  ],
  "layer_comp.duplicate": [
    { commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } },
    { commandId: "layer_comp.create", args: { name: "PS_MCP_Setup_Comp", visibility: true, position: true, appearance: true } }
  ],
  "layer_comp.recapture": [
    { commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } },
    { commandId: "layer_comp.create", args: { name: "PS_MCP_Setup_Comp", visibility: true, position: true, appearance: true } }
  ],
  "layer_comp.reset": [
    { commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } },
    { commandId: "layer_comp.create", args: { name: "PS_MCP_Setup_Comp", visibility: true, position: true, appearance: true } }
  ],
  "layer_comp.delete": [
    { commandId: "layer.create", args: { name: "PS_MCP_Setup_Layer" } },
    { commandId: "layer_comp.create", args: { name: "PS_MCP_Setup_Comp", visibility: true, position: true, appearance: true } }
  ]
});

async function securePrivateKey(path) {
  if (process.platform !== "win32") {
    await chmod(path, 0o600);
    return;
  }
  if (!process.env.USERNAME) throw new Error("Cannot secure evidence signing key: USERNAME is unavailable");
  const identity = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  await execFileAsync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${identity}:(F)`], { windowsHide: true, timeout: 5_000 });
}

async function loadOrCreateSigner() {
  const dataRoot = process.env.PS_MCP_DATA_DIR || join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "PS_MCP");
  const privatePath = join(dataRoot, "evidence-signing-private.pem");
  const publicPath = join(repoRoot, "evidence", "evidence-signing-public.pem");
  if (existsSync(privatePath) !== existsSync(publicPath)) throw new Error("Evidence signing trust pair is incomplete; refusing to replace either half");
  if (!existsSync(privatePath)) {
    const pair = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
    await mkdir(dirname(privatePath), { recursive: true });
    await mkdir(dirname(publicPath), { recursive: true });
    await writeFile(privatePath, pair.privateKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await securePrivateKey(privatePath);
    await writeFile(publicPath, pair.publicKey, { encoding: "utf8", flag: "wx" });
  }
  const [privateKey, publicKey] = await Promise.all([readFile(privatePath, "utf8"), readFile(publicPath, "utf8")]);
  const challenge = Buffer.from("photoshop-mcp-evidence-key-check");
  if (!verify(null, challenge, publicKey, sign(null, challenge, privateKey))) throw new Error("Evidence signing private key does not match the repository trust key");
  return { privateKey, publicKey };
}

export async function captureLiveEvidence({ commandId, commandArgs = {}, outputPath, timeoutMs = 120_000, clientFactory } = {}) {
  const commands = JSON.parse(await readFile(join(repoRoot, "catalog", "commands.json"), "utf8"));
  const catalogById = new Map(commands.map((entry) => [entry.id, entry]));
  const command = commands.find((entry) => entry.id === commandId);
  if (!command) throw new Error(`Unknown catalog command: ${commandId}`);
  if (command.status !== "unverified") throw new Error(`Evidence recording requires an unverified command, got ${command.status}`);
  const deadline = Date.now() + timeoutMs;

  let client;
  let transport;
  let ownedDocumentId = null;
  if (clientFactory) ({ client, transport } = await clientFactory());
  else {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", join(repoRoot, "src", "index.ts")],
      cwd: repoRoot,
      env: { ...process.env, PS_MCP_VALIDATION: "confirm" },
      stderr: "pipe"
    });
    client = new Client({ name: "photoshop-evidence-recorder", version: "2.0.1" });
    await client.connect(transport);
  }

  try {
    const liveHost = await waitForConnectedHost(client, deadline);
    const hostResult = liveHost.result;
    const host = liveHost.normalized;
    if (!host.connected || host.app !== "Photoshop" || typeof host.appVersion !== "string") throw new Error("LIVE_HOST_DISCONNECTED: the UXP plugin must be loaded and paired for direct evidence capture");
    const serverId = hostResult.bridge?.serverId;
    if (typeof serverId !== "string") throw new Error("Live host report omitted the authenticated bridge serverId");

    const initialState = structured(await call(client, "photoshop_state_get"), "photoshop_state_get");
    const initialIdentity = stateIdentity(initialState);
    const setup = [];
    if (command.id !== "document.create" && command.id !== "document.open_default") {
      const suffix = randomUUID().slice(0, 8);
      const bootstrap = await executeEvidenceCommand(client, "document.create", {
        width: 320,
        height: 240,
        resolution: 72,
        name: `PS_MCP_VALIDATION_${command.id.replace(/[^a-z0-9]+/gi, "_")}_${suffix}`
      }, deadline, catalogById);
      setup.push(bootstrap);
      ownedDocumentId = bootstrap.after?.activeDocument?.id ?? null;
      if (ownedDocumentId === null) throw new Error("Validation bootstrap did not return the temporary document id");
      for (const step of EVIDENCE_SETUP_STEPS[command.id] || []) {
        setup.push(await executeEvidenceCommand(client, step.commandId, step.args, deadline, catalogById));
      }
    }
    const previewBefore = command.id === "document.create" || command.id === "document.open_default" ? null : previewDigest(await call(client, "photoshop_preview_get", { max_edge: 512 }));
    const target = await approvedValidation(client, command.id, commandArgs, deadline);
    if (command.id === "document.create" || command.id === "document.open_default") ownedDocumentId = target.after?.activeDocument?.id ?? null;
    if (ownedDocumentId === null && command.id === "document.open_default") throw new Error("Default-folder import did not activate a newly opened document");
    const previewAfter = command.id === "document.close" ? null : previewDigest(await call(client, "photoshop_preview_get", { max_edge: 512 }));

    let undo = null;
    let previewAfterUndo = null;
    if (command.rollback === "history") {
      undo = await executeEvidenceCommand(client, "history.undo", {}, deadline, catalogById);
      previewAfterUndo = previewDigest(await call(client, "photoshop_preview_get", { max_edge: 512 }));
      if (command.verification === "preview" && (previewBefore === previewAfter || previewAfterUndo !== previewBefore)) {
        throw new Error(`Preview verification failed (changed=${previewBefore !== previewAfter}, undoRestored=${previewAfterUndo === previewBefore})`);
      }
    }

    const closes = [];
    if (command.id !== "document.close") {
      closes.push(await executeEvidenceCommand(client, "document.close", { save: false }, deadline, catalogById));
      if (command.id === "document.duplicate") {
        const sourceState = structured(await call(client, "photoshop_state_get"), "photoshop_state_get");
        if (stateIdentity(sourceState).id !== ownedDocumentId) throw new Error("Closing the newly created document did not restore the isolated source document");
        closes.push(await executeEvidenceCommand(client, "document.close", { save: false }, deadline, catalogById));
      }
    }
    const finalState = structured(await call(client, "photoshop_state_get"), "photoshop_state_get");
    const finalIdentity = stateIdentity(finalState);
    if (ownedDocumentId !== null && finalIdentity.id === ownedDocumentId) throw new Error("Temporary validation document remained active after close");
    if (initialIdentity.hasDocument && finalIdentity.id !== initialIdentity.id) throw new Error("Evidence capture did not restore the document that was active before the isolated transaction");

    const fixture = {
      schemaVersion: 1,
      kind: "command",
      commandId: command.id,
      catalogContractSha256: catalogContractDigest(command),
      capturedAt: new Date().toISOString(),
      host: { application: "Photoshop", appVersion: host.appVersion, locale: host.locale, pluginVersion: host.pluginVersion, protocol: host.protocol, connectedAtCapture: true },
      fixture: {
        isolatedDocument: true,
        temporaryDocumentClosed: true,
        executionPassed: true,
        stateVerified: Boolean(target.before && target.after),
        undoRoundTripVerified: command.rollback === "history" ? Boolean(undo) : null,
        previewVerified: command.verification === "preview" ? previewBefore !== previewAfter && previewAfterUndo === previewBefore : true
      },
      result: "passed",
      provenance: {
        version: 1,
        method: "live-mcp-stdio-v1",
        transactionId: randomUUID(),
        requestId: target.requestId,
        serverId,
        steps: {
          hostDescribe: true,
          validation: true,
          preview: true,
          undo: command.rollback === "history" ? true : null,
          tempDocumentClose: true,
          bootstrapRequestId: setup[0]?.requestId ?? null,
          setupRequestIds: setup.slice(1).map((entry) => entry.requestId),
          targetRequestId: target.requestId,
          undoRequestId: undo?.requestId ?? null,
          closeRequestId: closes.at(-1)?.requestId ?? (command.id === "document.close" ? target.requestId : null),
          closeRequestIds: closes.map((entry) => entry.requestId),
          beforeStateSha256: sha256(target.before),
          afterStateSha256: sha256(target.after),
          finalStateSha256: sha256(finalState),
          previewBeforeSha256: previewBefore,
          previewAfterSha256: previewAfter,
          previewAfterUndoSha256: previewAfterUndo
        }
      }
    };
    const signer = await loadOrCreateSigner();
    fixture.provenance.signature = sign(null, Buffer.from(JSON.stringify(evidenceReceiptPayload(fixture))), signer.privateKey).toString("base64");
    if (!verify(null, Buffer.from(JSON.stringify(evidenceReceiptPayload(fixture))), signer.publicKey, Buffer.from(fixture.provenance.signature, "base64"))) throw new Error("Evidence signature self-check failed");

    const output = resolve(outputPath || join(repoRoot, "evidence", "live", "commands", `${command.id}.json`));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { ok: true, commandId: command.id, output, catalogContractSha256: fixture.catalogContractSha256, transactionId: fixture.provenance.transactionId };
  } catch (error) {
    if (ownedDocumentId !== null && client) {
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const state = structured(await call(client, "photoshop_state_get"), "photoshop_state_get");
          const identity = stateIdentity(state);
          if (identity.id !== ownedDocumentId && !(typeof identity.title === "string" && identity.title.startsWith("PS_MCP_VALIDATION_"))) break;
          await executeEvidenceCommand(client, "document.close", { save: false }, deadline, catalogById);
        }
      } catch (_) {}
    }
    throw error;
  } finally {
    if (client && typeof client.close === "function") await client.close().catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const commandArgs = args.args ? JSON.parse(await readFile(resolve(args.args), "utf8")) : {};
  const result = await captureLiveEvidence({ commandId: args.command, commandArgs, outputPath: args.output, timeoutMs: args.timeoutMs });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
