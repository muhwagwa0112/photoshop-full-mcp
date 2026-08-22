import { createHash, verify as verifySignature } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VALID_STATUSES = new Set(["supported", "experimental", "requires_user", "unavailable", "unverified"]);
const EXECUTABLE_STATUSES = new Set(["supported", "experimental", "requires_user"]);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function catalogContractDigest(definition) {
  const contract = {
    id: definition.id,
    engine: definition.engine,
    minHostVersion: definition.minHostVersion,
    risk: definition.risk,
    approval: definition.approval,
    prerequisites: definition.prerequisites,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    verification: definition.verification,
    rollback: definition.rollback
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(contract))).digest("hex");
}

export function evidenceReceiptPayload(fixture) {
  const provenance = fixture?.provenance || {};
  return canonicalize({
    schemaVersion: fixture?.schemaVersion,
    kind: fixture?.kind,
    commandId: fixture?.commandId,
    featureId: fixture?.featureId,
    catalogContractSha256: fixture?.catalogContractSha256,
    capturedAt: fixture?.capturedAt,
    host: fixture?.host,
    fixture: fixture?.fixture,
    result: fixture?.result,
    provenance: {
      version: provenance.version,
      method: provenance.method,
      transactionId: provenance.transactionId,
      requestId: provenance.requestId,
      serverId: provenance.serverId,
      steps: provenance.steps
    }
  });
}

export function verifyEvidenceSignature(fixture, trustedPublicKey) {
  if (typeof trustedPublicKey !== "string" || !trustedPublicKey.includes("BEGIN PUBLIC KEY")) return false;
  if (!fixture?.provenance || fixture.provenance.method !== "live-mcp-stdio-v1" || typeof fixture.provenance.signature !== "string") return false;
  try {
    return verifySignature(null, Buffer.from(JSON.stringify(evidenceReceiptPayload(fixture))), trustedPublicKey, Buffer.from(fixture.provenance.signature, "base64"));
  } catch (_) {
    return false;
  }
}

function unwrapHostReport(input) {
  let value = input;
  if (value && typeof value === "object" && value.structuredContent) value = value.structuredContent;
  if (value && typeof value === "object" && value.result && typeof value.result === "object") value = value.result;
  return value && typeof value === "object" ? value : {};
}

export function normalizeLiveHostReport(input) {
  const value = unwrapHostReport(input);
  const runtime = value.runtime && typeof value.runtime === "object" ? value.runtime : {};
  const bridge = value.bridge && typeof value.bridge === "object" ? value.bridge : {};
  return {
    connected: bridge.connected === true,
    serverId: bridge.serverId,
    app: runtime.app,
    appVersion: runtime.appVersion,
    locale: runtime.locale ?? null,
    pluginVersion: runtime.pluginVersion,
    protocol: runtime.protocol
  };
}

function handlerPresence(command, source) {
  const escaped = command.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const explicitCase = source.includes(`case "${command.id}"`) || source.includes(`case '${command.id}'`);
  const assistedSet = new RegExp(`USER_ASSISTED_COMMANDS[\\s\\S]*?["']${escaped}["']`).test(source);
  const assistedInstruction = new RegExp(`USER_ASSISTED_INSTRUCTIONS[\\s\\S]*?["']${escaped}["']`).test(source);
  const verifiedAction = source.includes(`"${command.id}.v1"`) || source.includes(`'${command.id}.v1'`);
  return {
    present: explicitCase || verifiedAction || (command.engine === "user_assisted" && assistedSet && assistedInstruction),
    explicitCase,
    verifiedAction,
    userAssisted: assistedSet && assistedInstruction
  };
}

function validateFixture(definition, fixture, kind, trustedPublicKey, transactionCounts) {
  const problems = [];
  if (!fixture || typeof fixture !== "object") return { valid: false, problems: ["fixture missing"] };
  if (fixture.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  if (fixture.kind !== kind) problems.push(`kind must be ${kind}`);
  const expectedId = definition.id;
  if (fixture[`${kind}Id`] !== expectedId) problems.push(`${kind}Id mismatch`);
  if (fixture.catalogContractSha256 !== catalogContractDigest(definition)) problems.push("catalog contract digest mismatch");
  if (fixture.result !== "passed") problems.push("result must be passed");
  if (!fixture.host || fixture.host.connectedAtCapture !== true || fixture.host.application !== "Photoshop" || typeof fixture.host.appVersion !== "string") {
    problems.push("live Photoshop host identity is incomplete");
  }
  if (!fixture.fixture || fixture.fixture.isolatedDocument !== true || fixture.fixture.executionPassed !== true || fixture.fixture.stateVerified !== true) {
    problems.push("isolated execution/state checks are incomplete");
  }
  if (definition.rollback === "history" && fixture.fixture.undoRoundTripVerified !== true) problems.push("history undo round-trip is not verified");
  if (definition.verification === "preview" && fixture.fixture.previewVerified !== true) problems.push("preview is not verified");
  if (!fixture.provenance || fixture.provenance.version !== 1 || fixture.provenance.method !== "live-mcp-stdio-v1") problems.push("live MCP provenance is missing");
  if (typeof fixture.provenance?.transactionId !== "string" || typeof fixture.provenance?.requestId !== "string" || typeof fixture.provenance?.serverId !== "string") problems.push("provenance transaction identity is incomplete");
  if (!fixture.provenance?.steps || fixture.provenance.steps.hostDescribe !== true || fixture.provenance.steps.validation !== true || fixture.provenance.steps.preview !== true || fixture.provenance.steps.tempDocumentClose !== true) problems.push("live MCP transaction steps are incomplete");
  if (transactionCounts?.get(fixture.provenance?.transactionId) > 1) problems.push("provenance transaction was reused");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const digest = /^[0-9a-f]{64}$/i;
  if (!uuid.test(fixture.provenance?.transactionId || "") || !uuid.test(fixture.provenance?.requestId || "") || !uuid.test(fixture.provenance?.serverId || "")) problems.push("provenance ids must be UUIDs issued in the live transaction");
  if (kind === "command") {
    const steps = fixture.provenance?.steps || {};
    if (steps.targetRequestId !== fixture.provenance?.requestId) problems.push("target requestId is not bound to provenance");
    if (!digest.test(steps.beforeStateSha256 || "") || !digest.test(steps.afterStateSha256 || "") || !digest.test(steps.finalStateSha256 || "")) problems.push("state digests are incomplete");
    if (!uuid.test(steps.closeRequestId || "")) problems.push("temporary document close requestId is missing");
    if (definition.rollback === "history" && !uuid.test(steps.undoRequestId || "")) problems.push("undo requestId is missing");
    if (definition.verification === "preview" && (!digest.test(steps.previewBeforeSha256 || "") || !digest.test(steps.previewAfterSha256 || "") || !digest.test(steps.previewAfterUndoSha256 || ""))) problems.push("preview digests are incomplete");
  }
  if (!verifyEvidenceSignature(fixture, trustedPublicKey)) problems.push("evidence signature is invalid or trust key is missing");
  return { valid: problems.length === 0, problems };
}

function duplicateIds(entries) {
  const seen = new Set();
  const duplicates = new Set();
  for (const entry of entries) {
    if (seen.has(entry.id)) duplicates.add(entry.id);
    seen.add(entry.id);
  }
  return [...duplicates];
}

export function auditInventoryData({ commands, features, handlerSource, commandFixtures = {}, featureFixtures = {}, liveHostReport = null, trustedPublicKey = null }) {
  const issues = [];
  const addIssue = (severity, code, itemType, id, message) => issues.push({ severity, code, itemType, id, message });
  for (const id of duplicateIds(commands)) addIssue("error", "DUPLICATE_COMMAND_ID", "command", id, "Command id is duplicated");
  for (const id of duplicateIds(features)) addIssue("error", "DUPLICATE_FEATURE_ID", "feature", id, "Feature id is duplicated");

  const allFixtures = [...Object.values(commandFixtures), ...Object.values(featureFixtures)];
  const transactionCounts = new Map();
  for (const fixture of allFixtures) {
    const transactionId = fixture?.provenance?.transactionId;
    if (typeof transactionId === "string") transactionCounts.set(transactionId, (transactionCounts.get(transactionId) || 0) + 1);
  }

  const commandRows = commands.map((command) => {
    const handler = handlerPresence(command, handlerSource);
    const fixture = commandFixtures[command.id];
    const evidence = validateFixture(command, fixture, "command", trustedPublicKey, transactionCounts);
    if (!VALID_STATUSES.has(command.status)) addIssue("error", "INVALID_STATUS", "command", command.id, `Unknown status: ${command.status}`);
    if (!command.inputSchema || command.inputSchema.additionalProperties !== false) addIssue("error", "OPEN_INPUT_SCHEMA", "command", command.id, "Input schema must reject undeclared properties");
    if (EXECUTABLE_STATUSES.has(command.status) && !handler.present) addIssue("error", "EXECUTABLE_HANDLER_MISSING", "command", command.id, "Executable status requires a handler");
    if (command.status === "requires_user" && command.engine !== "user_assisted") addIssue("error", "USER_ASSISTED_ENGINE_MISMATCH", "command", command.id, "requires_user must use user_assisted engine");
    if (command.engine === "user_assisted" && command.status !== "requires_user") addIssue("error", "USER_ASSISTED_STATUS_MISMATCH", "command", command.id, "user_assisted engine must use requires_user status");
    if (command.status === "supported" && !evidence.valid) addIssue("error", "SUPPORTED_LIVE_EVIDENCE_MISSING", "command", command.id, evidence.problems.join("; "));
    if (command.status === "unavailable" && !command.unavailableReason) addIssue("warning", "UNAVAILABLE_REASON_MISSING", "command", command.id, "Unavailable command should explain why");
    return { id: command.id, status: command.status, engine: command.engine, handler, fixture: { present: Boolean(fixture), ...evidence, provenance: fixture?.provenance ? { transactionId: fixture.provenance.transactionId, serverId: fixture.provenance.serverId } : null } };
  });

  const commandsById = new Map(commands.map((entry) => [entry.id, entry]));
  const featureRows = features.map((feature) => {
    const fixture = featureFixtures[feature.id];
    const evidence = validateFixture(feature, fixture, "feature", trustedPublicKey, transactionCounts);
    if (!VALID_STATUSES.has(feature.status)) addIssue("error", "INVALID_STATUS", "feature", feature.id, `Unknown status: ${feature.status}`);
    if (typeof feature.route !== "string" || !feature.route.trim()) addIssue("error", "FEATURE_ROUTE_MISSING", "feature", feature.id, "Feature route is required");
    if (feature.status === "supported" && !evidence.valid) addIssue("error", "SUPPORTED_LIVE_EVIDENCE_MISSING", "feature", feature.id, evidence.problems.join("; "));
    if (feature.status === "requires_user") {
      const routeIds = String(feature.route || "").split("|").filter((id) => id.includes("."));
      if (!routeIds.length || routeIds.some((id) => commandsById.get(id)?.status !== "requires_user")) {
        addIssue("error", "FEATURE_USER_ROUTE_MISMATCH", "feature", feature.id, "requires_user feature must route only to requires_user commands");
      }
    }
    if (feature.status === "unavailable" && !feature.reason) addIssue("warning", "UNAVAILABLE_REASON_MISSING", "feature", feature.id, "Unavailable feature should explain why");
    return { id: feature.id, status: feature.status, route: feature.route, fixture: { present: Boolean(fixture), ...evidence } };
  });

  const liveHost = normalizeLiveHostReport(liveHostReport);
  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    generatedAt: new Date().toISOString(),
    liveHost,
    summary: {
      commands: commandRows.length,
      features: featureRows.length,
      handlersPresent: commandRows.filter((row) => row.handler.present).length,
      commandFixturesValid: commandRows.filter((row) => row.fixture.valid).length,
      featureFixturesValid: featureRows.filter((row) => row.fixture.valid).length,
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length
    },
    commands: commandRows,
    features: featureRows,
    issues
  };
}

export function evaluatePromotion(report, commandId) {
  const row = report.commands.find((entry) => entry.id === commandId);
  const blockers = [];
  if (!row) blockers.push({ code: "UNKNOWN_COMMAND", message: `Unknown command: ${commandId}` });
  if (!report.liveHost.connected) blockers.push({ code: "LIVE_HOST_DISCONNECTED", message: "A currently connected Photoshop UXP host report is required" });
  if (report.liveHost.app !== "Photoshop" || typeof report.liveHost.appVersion !== "string") blockers.push({ code: "LIVE_HOST_IDENTITY_INVALID", message: "Live host identity is incomplete" });
  if (row && !row.handler.present) blockers.push({ code: "HANDLER_MISSING", message: "Command handler is missing" });
  if (row && !row.fixture.valid) blockers.push({ code: "LIVE_FIXTURE_INVALID", message: row.fixture.problems.join("; ") });
  if (row?.fixture.valid && report.liveHost.serverId !== row.fixture.provenance?.serverId) blockers.push({ code: "LIVE_HOST_PROVENANCE_MISMATCH", message: "Current bridge identity does not match the signed evidence origin" });
  return { ok: blockers.length === 0, commandId, blockers };
}

async function readFixtures(directory) {
  const fixtures = {};
  let names = [];
  try { names = await readdir(directory); } catch (error) {
    if (error.code === "ENOENT") return fixtures;
    throw error;
  }
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const fixture = JSON.parse(await readFile(join(directory, name), "utf8"));
    const id = fixture.commandId || fixture.featureId;
    if (typeof id === "string") fixtures[id] = fixture;
  }
  return fixtures;
}

export async function auditInventory(options = {}) {
  const root = resolve(options.repoRoot || repoRoot);
  const [commands, features, handlerSource, commandFixtures, featureFixtures, trustedPublicKey] = await Promise.all([
    readFile(join(root, "catalog", "commands.json"), "utf8").then(JSON.parse),
    readFile(join(root, "catalog", "features.json"), "utf8").then(JSON.parse),
    readFile(join(root, "apps", "uxp-plugin", "lib", "commands.js"), "utf8"),
    readFixtures(resolve(options.evidenceDir || join(root, "evidence", "live", "commands"))),
    readFixtures(resolve(options.featureEvidenceDir || join(root, "evidence", "live", "features"))),
    readFile(resolve(options.publicKeyPath || join(root, "evidence", "evidence-signing-public.pem")), "utf8").catch((error) => error.code === "ENOENT" ? null : Promise.reject(error))
  ]);
  let liveHostReport = null;
  if (options.hostReportPath) liveHostReport = JSON.parse(await readFile(resolve(options.hostReportPath), "utf8"));
  return auditInventoryData({ commands, features, handlerSource, commandFixtures, featureFixtures, liveHostReport, trustedPublicKey });
}

function parseArgs(argv) {
  const options = { strict: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--strict") options.strict = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--host-report") options.hostReportPath = argv[++index];
    else if (arg === "--evidence-dir") options.evidenceDir = argv[++index];
    else if (arg === "--promotion-command") options.promotionCommand = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const report = await auditInventory(options);
  const promotion = options.promotionCommand ? evaluatePromotion(report, options.promotionCommand) : null;
  const output = { ...report, ...(promotion ? { promotion } : {}) };
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(`${JSON.stringify({ ok: report.ok && (!promotion || promotion.ok), ...report.summary, liveConnected: report.liveHost.connected, promotion }, null, 2)}\n`);
  if ((options.strict && !report.ok) || (promotion && !promotion.ok)) process.exitCode = 1;
}
