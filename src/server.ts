import { randomUUID } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import { digest } from "./automation/canonical.js";
import { RuntimeClient } from "./runtime-client.js";
import { encodePng } from "./png.js";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { WorkflowService } from "./automation/service.js";
import { loadAutomationConfiguration } from "./automation/configuration.js";
import { registerAutomationTools } from "./automation/mcp.js";
import type { HostRef, OperationRequest } from "./automation/contracts.js";
import { createConfiguredWorker } from "./workers/configured-client.js";
import { PhotoshopAutomationAdapter } from "./adobe-automation-adapter.js";
import { runtimeIdentity } from "./runtime-version.js";
import { commandRuntimeAvailability } from "./runtime-capabilities.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { ERROR_CODES, type CapabilityStatus, type CommandDefinition, type ErrorCode, type McpEnvelope } from "../packages/contracts/src/index.js";
import { BridgeServer } from "./bridge.js";
import { CommandCatalog } from "./catalog.js";
import type { ServerConfig } from "./config.js";
import { failureEnvelope, PhotoshopMcpError } from "./errors.js";
import { discoverInstalledPhotoshop } from "./host.js";
import { JobStore } from "./jobs.js";
import { approvalScopeDigest, PolicyEngine } from "./policy.js";

type JsonObject = Record<string, unknown>;
type ToolResult = { content: Array<Record<string, unknown>>; structuredContent?: JsonObject; isError?: boolean };
const CONFINED_EXTERNAL_VALIDATION_COMMANDS = new Set(["document.export", "document.open_default"]);
const VALIDATION_DOCUMENT_CREATORS = new Set(["document.create", "document.open_default"]);

export function validationProfileAllowsRisk(command: Pick<CommandDefinition, "id" | "risk">): boolean {
  if (command.risk === "credit") return false;
  return command.risk !== "external" || CONFINED_EXTERNAL_VALIDATION_COMMANDS.has(command.id);
}

export function validationRequiresTemporaryDocument(commandId: string): boolean {
  return !VALIDATION_DOCUMENT_CREATORS.has(commandId);
}

function bridgeErrorCode(code: unknown): ErrorCode {
  return typeof code === "string" && (ERROR_CODES as readonly string[]).includes(code) ? code as ErrorCode : "HOST_ERROR";
}

function result(value: unknown, isError = false): ToolResult {
  const structured = (value && typeof value === "object" && !Array.isArray(value) ? value : { value }) as JsonObject;
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

function objectSchema(properties: JsonObject = {}, required: string[] = []): JsonObject {
  return { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}

const TARGET_SCHEMA = objectSchema({
  kind: { type: "string", enum: ["ps_document", "ps_layer"] },
  documentId: { type: "integer", minimum: 1 },
  layerIds: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, uniqueItems: true },
  workingAssetId: { type: "string", minLength: 1 },
  host: objectSchema({ app: { const: "photoshop" }, installationId: { type: "string", minLength: 1 }, hostEpoch: { type: "string", minLength: 1 } }, ["app", "installationId", "hostEpoch"]),
}, ["kind", "documentId", "host"]);

interface RegisteredTool {
  definition: Tool;
  handler: (args: JsonObject) => Promise<ToolResult>;
  validate?: ValidateFunction;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function nestedRecord(value: unknown, key: string): UnknownRecord | undefined {
  return asRecord(asRecord(value)?.[key]);
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function capabilityAvailable(value: unknown): boolean {
  if (value === true) return true;
  const record = asRecord(value);
  if (!record) return false;
  if (record.available === true || record.enabled === true) return true;
  return ["available", "supported", "ready"].includes(String(record.status ?? "").toLowerCase());
}

export function assertCommandPrerequisites(command: CommandDefinition, state: unknown, host?: unknown): void {
  const root = asRecord(state);
  const document = nestedRecord(state, "activeDocument");
  const activeLayer = asRecord(root?.activeLayer) ?? asRecord(document?.activeLayer);
  const hostRoot = asRecord(host);
  const runtimeProbes = nestedRecord(host, "runtimeProbes");
  const gated = nestedRecord(host, "gatedCapabilities");

  for (const prerequisite of command.prerequisites) {
    switch (prerequisite) {
      case "document":
        if (root?.hasDocument !== true) throw new PhotoshopMcpError("NO_DOCUMENT", `${command.id} requires an active document`);
        break;
      case "layer":
        if (!activeLayer) throw new PhotoshopMcpError("PRECONDITION_FAILED", `${command.id} requires an active layer`);
        break;
      case "selection": {
        const selection = asRecord(root?.selection) ?? asRecord(root?.activeSelection) ?? asRecord(document?.selection);
        const hasSelection = root?.hasSelection === true || document?.hasSelection === true || Boolean(selection?.bounds);
        if (!hasSelection) throw new PhotoshopMcpError("PRECONDITION_FAILED", `${command.id} requires a verified active selection`);
        break;
      }
      case "channel": {
        const hasChannel = Boolean(root?.activeChannel)
          || nonEmptyArray(root?.activeChannels)
          || nonEmptyArray(document?.activeChannels)
          || (typeof root?.channelCount === "number" && root.channelCount > 0)
          || (typeof document?.channelCount === "number" && document.channelCount > 0);
        if (!hasChannel) throw new PhotoshopMcpError("PRECONDITION_FAILED", `${command.id} requires a verified channel`);
        break;
      }
      case "path": {
        const hasPath = Boolean(root?.activePath)
          || nonEmptyArray(root?.paths)
          || nonEmptyArray(document?.paths)
          || (typeof root?.pathCount === "number" && root.pathCount > 0)
          || (typeof document?.pathCount === "number" && document.pathCount > 0);
        if (!hasPath) throw new PhotoshopMcpError("PRECONDITION_FAILED", `${command.id} requires a verified path`);
        break;
      }
      case "text_layer": {
        const kind = String(activeLayer?.kind ?? "").toLowerCase();
        if (!activeLayer || (!kind.includes("text") && !asRecord(activeLayer.textItem))) {
          throw new PhotoshopMcpError("PRECONDITION_FAILED", `${command.id} requires an active text layer`);
        }
        break;
      }
      case "export_folder": {
        const storage = asRecord(runtimeProbes?.storage);
        const exportFolder = asRecord(root?.exportFolder);
        const configured = root?.exportFolderConfigured === true
          || exportFolder?.configured === true
          || storage?.exportFolderConfigured === true;
        if (!configured) throw new PhotoshopMcpError("PRECONDITION_FAILED", `${command.id} requires a verified user-selected export folder`);
        break;
      }
      case "online": {
        const network = asRecord(runtimeProbes?.network);
        if (!(hostRoot?.online === true || network?.online === true || capabilityAvailable(gated?.online))) {
          throw new PhotoshopMcpError("PRECONDITION_FAILED", `${command.id} requires verified online connectivity`);
        }
        break;
      }
      case "entitlement":
        if (!capabilityAvailable(gated?.entitlement) && !capabilityAvailable(hostRoot?.entitlement)) {
          throw new PhotoshopMcpError("ENTITLEMENT_UNAVAILABLE", `${command.id} requires a verified Photoshop entitlement`);
        }
        break;
      case "model":
        if (!capabilityAvailable(gated?.model) && !capabilityAvailable(gated?.neuralFilters) && !capabilityAvailable(hostRoot?.model)) {
          throw new PhotoshopMcpError("ENTITLEMENT_UNAVAILABLE", `${command.id} requires a verified local or account model`);
        }
        break;
      default:
        throw new PhotoshopMcpError("PRECONDITION_FAILED", `${command.id} declares an unsupported prerequisite: ${prerequisite}`);
    }
  }
}

function needsHostPrerequisiteState(command: CommandDefinition): boolean {
  return command.prerequisites.some((item) => ["export_folder", "online", "entitlement", "model"].includes(item));
}

export class PhotoshopFullMcpServer {
  private readonly server: Server;
  private readonly jobs = new JobStore();
  private readonly policy: PolicyEngine;
  private readonly bridge: BridgeServer;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly commandCalls = new Map<string, { digest: string; promise: Promise<ToolResult> }>();
  private readonly ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
  private readonly runtimeClient: RuntimeClient;
  private readonly approvalJobs = new Map<string, { commandId: string; scope: unknown }>();
  private bridgeStartError?: string;
  private automation: WorkflowService | undefined;
  private automationAdapter: PhotoshopAutomationAdapter | undefined;
  private setupIssues: string[] = [];

  private constructor(private readonly config: ServerConfig, private readonly catalog: CommandCatalog, private readonly isRuntimeOwner = false) {
    this.runtimeClient = new RuntimeClient(config);
    this.policy = new PolicyEngine(config);
    this.bridge = new BridgeServer(config, this.jobs);
    this.server = new Server(
      { name: "photoshop-full-mcp", version: "2.0.1" },
      {
        capabilities: { tools: {} },
        instructions:
          "Photoshop MCP v2. Inspect photoshop_host_describe and photoshop_capability_list before editing. " +
          "Use command_search/describe before command_execute. Never claim unverified or unavailable commands are supported. " +
          (config.approvalMode === "auto"
            ? "Local approvals are automatic; bound one-time tokens, replay protection, path limits, and advanced allowlists remain enforced."
            : "Destructive, credit, validation, and advanced commands require a one-time approval from the Photoshop panel."),
      },
    );
    this.registerTools();
    this.setupHandlers();
  }

  static async create(config: ServerConfig, catalog: CommandCatalog, options: { runtimeOwner?: boolean } = {}): Promise<PhotoshopFullMcpServer> {
    return new PhotoshopFullMcpServer(config, catalog, options.runtimeOwner === true);
  }

  async start(): Promise<void> {
    if (this.isRuntimeOwner) throw new Error("Runtime owners do not use the stdio transport");
    await this.runtimeClient.ensureStarted();
    await this.server.connect(new StdioServerTransport());
  }

  async startRuntime(): Promise<void> {
    const port = await this.bridge.start();
    const configuration = await loadAutomationConfiguration({ dataDirectory: this.config.dataDir, legacyRoots: this.config.allowedRoots, defaultOutputDirectory: this.config.exportDir });
    const premiereDirectory = process.env.PREMIERE_MCP_AUTOMATION_DATA_DIR || join(process.env.LOCALAPPDATA || tmpdir(), "PremiereMCP", "automation");
    const peerStaging = join(premiereDirectory, "assets");
    const peerWorkspace = process.env.PREMIERE_AUTOMATION_ROOT || join(premiereDirectory, "workspace");
    await mkdir(peerStaging, { recursive: true });
    await mkdir(peerWorkspace, { recursive: true });
    configuration.roots.premiere_staging ??= { path: peerStaging, readOnly: true };
    configuration.roots.premiere_workspace ??= { path: peerWorkspace, readOnly: true };
    configuration.roots.premiere_output ??= { path: peerWorkspace, readOnly: false };
    const worker = await createConfiguredWorker({ dataDirectory: this.config.dataDir, roots: configuration.roots });
    this.setupIssues = configuration.setupIssues;
    this.automation = new WorkflowService({ workflowHome: { app: "photoshop", installationId: this.config.serverId, namespaceId: `photoshop:${this.config.serverId}` }, dataDirectory: this.config.dataDir, roots: configuration.roots,
      presets: configuration.presets, sequencePresets: configuration.sequencePresets, ...(worker ? { worker } : {}) });
    this.automationAdapter = new PhotoshopAutomationAdapter(this.config, this.bridge, this.automation.assets, worker);
    this.automation.registerHost("photoshop", this.automationAdapter, () => this.automationAdapter!.resolveHost());
    if (configuration.controller) this.automation.configureOllama(configuration.controller);
    registerAutomationTools({ register: (name, description, inputSchema, handler, annotations) => {
      // The common handler owns strict Draft 2020-12 validation, including its
      // registered cross-schema references; do not reinterpret it as Draft 7.
      this.tools.set(name, { definition: { name, description, inputSchema: inputSchema as Tool["inputSchema"], annotations }, handler });
    } }, { service: this.automation, prefix: "photoshop" });
    await this.automation.start();
    process.stderr.write(`[photoshop-full-mcp] runtime owner bridge listening on 127.0.0.1:${port}\n`);
  }

  async stopRuntime(): Promise<void> { await this.automation?.close(); await this.bridge.stop(); }
  async stop(): Promise<void> { await this.server.close(); }
  canStopRuntime(): boolean { return !this.bridge.hasActiveOperations() && !this.automation?.hasActiveWork() && !this.jobs.list().some(job => ["running", "cancel_requested", "awaiting_user"].includes(job.status)); }
  runtimeStatus(): unknown { return { ...this.bridge.status(), ...runtimeIdentity(), workflowHome: { app: "photoshop", installationId: this.config.serverId, namespaceId: `photoshop:${this.config.serverId}` }, setupIssues: this.setupIssues }; }
  listToolDefinitions(): Tool[] { return [...this.tools.values()].map((tool) => tool.definition); }

  async callHost(method: string, args: JsonObject): Promise<unknown> {
    const adapter = this.automationAdapter;
    if (!adapter) throw new Error("Photoshop automation adapter is not ready");
    if (method === "resolveHost") return adapter.resolveHost();
    if (method === "describeCapabilities") return adapter.describeCapabilities(args.host as HostRef);
    if (["prepare", "dispatch", "readPostcondition"].includes(method)) {
      if (!args.request || typeof args.request !== "object" || Array.isArray(args.request)) throw new Error("A canonical OperationRequest is required");
      const request = args.request as unknown as OperationRequest;
      if (method === "prepare") return adapter.prepare(request);
      if (method === "dispatch") return adapter.dispatch(request);
      return adapter.readPostcondition(request);
    }
    if (typeof args.operationId !== "string" || !args.operationId) throw new Error("An operationId is required");
    if (method === "getReceipt") return adapter.getReceipt(args.operationId);
    if (method === "requestCancel") return adapter.requestCancel(args.operationId);
    throw new Error("Unsupported host adapter method");
  }

  async callTool(name: string, args: JsonObject): Promise<ToolResult> {
    const registered = this.tools.get(name);
    if (!registered) throw new Error(`Tool not found: ${name}`);
    try {
      const input = structuredClone(args);
      if (registered.validate && !registered.validate(input)) throw new PhotoshopMcpError("PRECONDITION_FAILED", `Invalid arguments for ${name}`, registered.validate.errors);
      return await registered.handler(input);
    } catch (error) { return result(failureEnvelope(name, randomUUID(), error), true); }
  }

  private register(name: string, description: string, inputSchema: JsonObject, handler: RegisteredTool["handler"], annotations?: Tool["annotations"]): void {
    this.tools.set(name, {
      definition: {
        name,
        description,
        inputSchema: inputSchema as Tool["inputSchema"],
        outputSchema: { type: "object", additionalProperties: true },
        ...(annotations ? { annotations } : {}),
      },
      handler,
      validate: this.ajv.compile(inputSchema),
    });
  }

  private registerTools(): void {
    this.register(
      "photoshop_host_describe",
      "Describe the installed Photoshop host, live UXP bridge, exact runtime API versions, and pairing state. Side effects: none.",
      objectSchema(),
      async () => this.hostDescribe(),
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    );
    this.register(
      "photoshop_pairing_begin",
      "Display the short-lived port-bound bridge pairing code in a trusted local Windows dialog. The value is never returned to the MCP client.",
      objectSchema(),
      async () => {
        this.assertBridgeAvailable();
        await this.bridge.showPairingDialog();
        return result({ displayed: true, paired: this.bridge.status().paired, note: "The local pairing dialog was closed" });
      },
      { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    );
    this.register(
      "photoshop_capability_list",
      "List catalog implementation status separately from connected-host method/target availability. Unverified and unavailable catalog commands are not executed.",
      objectSchema({
        status: { type: "string", enum: ["supported", "experimental", "requires_user", "unavailable", "unverified"] },
        category: { type: "string" },
        query: { type: "string", maxLength: 200 },
        summary_only: { type: "boolean", default: false },
      }),
      async (args) => {
        const filters = args as { status?: CapabilityStatus; category?: string; query?: string; summary_only?: boolean };
        const commands = this.catalog.list(filters);
        const inventory = this.catalog.listFeatures(filters);
        const summarize = (entries: Array<{ status: CapabilityStatus }>) => ({
          total: entries.length,
          byStatus: Object.fromEntries(["supported", "experimental", "requires_user", "unavailable", "unverified"].map((status) => [status, entries.filter((entry) => entry.status === status).length])),
        });
        let runtime: unknown;
        if (this.bridge.status().connected) {
          try { const probe = await this.bridge.dispatch("host.describe", {}); runtime = probe.ok ? probe.data : { probeError: probe.error }; }
          catch (error) { runtime = { probeError: error instanceof Error ? error.message : String(error) }; }
        }
        return result({
          summary: { commands: summarize(commands), inventory: summarize(inventory) },
          ...(filters.summary_only ? {} : { commands: commands.map(command => ({ ...command, runtimeAvailability: commandRuntimeAvailability(command, runtime) })), inventory }),
          runtime: runtime ?? { bridgeConnected: false, note: "Runtime probes are available after the UXP panel is paired" },
        });
      },
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    );
    this.register(
      "photoshop_state_get",
      "Return live document, active layer, selection, and history state from the UXP plugin. Side effects: none.",
      objectSchema({ target: TARGET_SCHEMA }),
      async (args) => this.bridgeTool("state.get", args),
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    );
    this.register(
      "photoshop_preview_get",
      "Return document/layer/ROI/mask evidence with actual source bounds, dimensions, profile and alpha metadata.",
      objectSchema({ max_edge: { type: "integer", minimum: 64, maximum: 2048, default: 1024 }, target: TARGET_SCHEMA,
        kind: { type: "string", enum: ["composite", "layer", "roi", "mask"], default: "composite" },
        region: objectSchema({ x: { type: "number" }, y: { type: "number" }, width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 } }, ["x", "y", "width", "height"]),
        format: { type: "string", enum: ["png", "jpeg"], default: "png" } }),
      async (args) => this.preview(args),
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    );
    this.register(
      "photoshop_command_search",
      "Search locale-independent Photoshop command IDs using English, Korean, category, or description text.",
      objectSchema({ query: { type: "string", minLength: 1, maxLength: 200 }, category: { type: "string" } }, ["query"]),
      async (args) => result({ commands: this.catalog.list({ query: String(args.query), ...(args.category ? { category: String(args.category) } : {}) }) }),
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    );
    this.register(
      "photoshop_command_describe",
      "Describe one command's schemas, prerequisites, risk, approval, verification, and rollback contract.",
      objectSchema({ command_id: { type: "string" } }, ["command_id"]),
      async (args) => result(this.catalog.get(String(args.command_id))),
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    );
    this.register(
      "photoshop_command_execute",
      "Execute a catalog command after schema, capability, prerequisite, risk, approval, modal, and verification checks.",
      objectSchema({
        command_id: { type: "string" },
        args: { type: "object" },
        target: TARGET_SCHEMA,
        idempotency_key: { type: "string", minLength: 8, maxLength: 200 },
        approval_token: { type: "string" },
        dialog_mode: { type: "string", enum: ["silent", "display"] },
        verification: { type: "string", enum: ["state", "preview", "none"] },
      }, ["command_id"]),
      async (args) => this.executeCommand(args),
      { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    );
    this.register(
      "photoshop_approval_request",
      this.config.approvalMode === "auto"
        ? "Create an automatically completed, scope-bound approval job for compatibility. Direct execution normally does not need this tool."
        : "Ask the user to approve one destructive, credit-consuming, or advanced command in the Photoshop panel. Returns an awaiting_user job.",
      objectSchema({
        command_id: { type: "string" },
        args: { type: "object" },
        engine: { type: "string", enum: ["batchplay"] },
        payload: { type: "array", minItems: 1, maxItems: 100 },
        justification: { type: "string", minLength: 8, maxLength: 500 },
      }, ["command_id"]),
      async (args) => this.requestApproval(args),
      { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    );
    this.register(
      "photoshop_job_get",
      "Get an asynchronous or user-assisted job. Completed approval jobs return a one-time approval token.",
      objectSchema({ job_id: { type: "string" } }, ["job_id"]),
      async (args) => this.getJob(String(args.job_id)),
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    );
    this.register(
      "photoshop_job_cancel",
      "Cancel a queued, running, or awaiting-user Photoshop job.",
      objectSchema({ job_id: { type: "string" } }, ["job_id"]),
      async (args) => {
        const job = this.jobs.cancel(String(args.job_id));
        if (job.operationId) await this.bridge.requestCancel(job.operationId);
        if (job.kind !== "operation" && this.bridge.status().connected) {
          await this.dispatchBridge("job.cancel", { jobId: job.id });
        }
        return result(job);
      },
      { destructiveHint: false, idempotentHint: true, openWorldHint: false },
    );
    this.register(
      "photoshop_job_resume",
      "Resume a user-assisted Photoshop job after the user completes the native UI step.",
      objectSchema({ job_id: { type: "string" } }, ["job_id"]),
      async (args) => this.resumeJob(String(args.job_id)),
      { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    );
    if (this.config.advancedProfile === "confirm") {
      this.register(
        "photoshop_advanced_execute",
        this.config.approvalMode === "auto"
          ? "Execute allowlisted raw batchPlay descriptors with automatic scope-bound approval. Disabled unless PS_MCP_ADVANCED=confirm."
          : "Execute allowlisted raw batchPlay descriptors only after a one-time local panel approval. Disabled unless PS_MCP_ADVANCED=confirm.",
        objectSchema({
          engine: { type: "string", enum: ["batchplay"] },
          payload: { type: "array", minItems: 1, maxItems: 100 },
          justification: { type: "string", minLength: 8, maxLength: 500 },
          approval_token: { type: "string" },
        }, ["engine", "payload", "justification"]),
        async (args) => this.advancedExecute(args),
        { destructiveHint: true, idempotentHint: false, openWorldHint: false },
      );
    }
    if (this.config.validationProfile === "confirm") {
      this.register(
        "photoshop_validation_request",
        this.config.approvalMode === "auto"
          ? "Create an automatically completed approval job to test one unverified command on an active PS_MCP_VALIDATION_ temporary document."
          : "Request local panel approval to test one unverified UXP DOM command on an active PS_MCP_VALIDATION_ temporary document.",
        objectSchema({ command_id: { type: "string" }, args: { type: "object" } }, ["command_id"]),
        async (args) => this.requestValidationApproval(args),
        { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      );
      this.register(
        "photoshop_command_validate",
        "Execute one approved unverified UXP DOM command only on an active PS_MCP_VALIDATION_ temporary document. This never promotes the catalog automatically.",
        objectSchema({
          command_id: { type: "string" },
          args: { type: "object" },
          approval_token: { type: "string" },
        }, ["command_id"]),
        async (args) => this.validateUnverifiedCommand(args),
        { destructiveHint: true, idempotentHint: false, openWorldHint: false },
      );
    }
    this.register("photoshop_operation_get", "Query a retained host operation, including a late result after a caller timeout.",
      objectSchema({ operation_id: { type: "string", minLength: 1, maxLength: 256 } }, ["operation_id"]),
      async (args) => result(await this.bridge.reconcile(String(args.operation_id)) ?? { found: false }),
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false });
    this.register("photoshop_operation_cancel", "Request cooperative host cancellation; returns whether stopping is confirmed.",
      objectSchema({ operation_id: { type: "string", minLength: 1, maxLength: 256 } }, ["operation_id"]),
      async (args) => result(await this.bridge.requestCancel(String(args.operation_id))),
      { readOnlyHint: false, idempotentHint: true, openWorldHint: false });
    this.registerTypedConvenienceTools();
  }

  private registerTypedConvenienceTools(): void {
    const mappings: Array<[string, string, JsonObject]> = [
      ["photoshop_document_create", "document.create", this.catalog.get("document.create").inputSchema],
      ["photoshop_layer_create", "layer.create", this.catalog.get("layer.create").inputSchema],
      ["photoshop_layer_rename", "layer.rename", this.catalog.get("layer.rename").inputSchema],
      ["photoshop_selection_select_all", "selection.select_all", this.catalog.get("selection.select_all").inputSchema],
      ["photoshop_selection_deselect", "selection.deselect", this.catalog.get("selection.deselect").inputSchema],
      ["photoshop_history_undo", "history.undo", this.catalog.get("history.undo").inputSchema],
      ["photoshop_image_resize", "image.resize", this.catalog.get("image.resize").inputSchema],
      ["photoshop_document_export", "document.export", this.catalog.get("document.export").inputSchema],
    ];
    for (const [toolName, commandId, schema] of mappings) {
      this.register(
        toolName,
        `Typed convenience tool for ${commandId}. Uses the same catalog policy and verification pipeline.`,
        { ...schema, properties: { ...asRecord(schema.properties), target: TARGET_SCHEMA, idempotency_key: { type: "string", minLength: 8, maxLength: 200 } } },
        async (args) => { const { target, idempotency_key, ...commandArgs } = args; return this.executeCommand({ command_id: commandId, args: commandArgs, ...(target ? { target } : {}), ...(idempotency_key ? { idempotency_key } : {}) }); },
        { readOnlyHint: this.catalog.get(commandId).risk === "read", destructiveHint: ["destructive", "external", "credit"].includes(this.catalog.get(commandId).risk), idempotentHint: this.catalog.get(commandId).risk === "read", openWorldHint: false },
      );
    }
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.isRuntimeOwner ? this.listToolDefinitions() : await this.runtimeClient.call<Tool[]>("listTools", {}) }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => this.isRuntimeOwner
      ? this.callTool(request.params.name, (request.params.arguments ?? {}) as JsonObject)
      : this.runtimeClient.call<ToolResult>("callTool", { name: request.params.name, arguments: request.params.arguments ?? {} }));
  }

  private async hostDescribe(): Promise<ToolResult> {
    const status = this.bridge.status(false);
    const bridge = this.bridgeStartError ? { ...status, unavailableReason: this.bridgeStartError } : status;
    const installed = await discoverInstalledPhotoshop();
    let runtime: unknown;
    if (bridge.connected) {
      const live = await this.bridge.dispatch("host.describe", {});
      runtime = live.ok ? live.data : live.error;
    }
    return result({ serverVersion: "2.0.1", approvalMode: this.config.approvalMode, bridge, installed, ...(runtime !== undefined ? { runtime } : {}) });
  }

  private assertBridgeAvailable(): void {
    if (this.bridgeStartError) {
      throw new PhotoshopMcpError("HOST_ERROR", `Photoshop bridge listener is unavailable: ${this.bridgeStartError}`);
    }
  }

  private async dispatchBridge(kind: string, payload: JsonObject, timeoutMs?: number) {
    this.assertBridgeAvailable();
    return this.bridge.dispatch(kind, payload, timeoutMs);
  }

  private async bridgeTool(kind: string, payload: JsonObject): Promise<ToolResult> {
    const response = await this.dispatchBridge(kind, payload);
    if (!response.ok) throw new PhotoshopMcpError("HOST_ERROR", response.error?.message ?? `${kind} failed`, response.error);
    return result(response.data ?? { ok: true });
  }

  private async preview(args: JsonObject): Promise<ToolResult> {
    const response = await this.dispatchBridge("preview.get", { ...args, maxEdge: args.max_edge ?? 1024 });
    if (!response.ok) throw new PhotoshopMcpError("HOST_ERROR", response.error?.message ?? "Preview failed", response.error);
    const data = response.data as { base64?: string; mimeType?: string; preview?: { base64?: string; mimeType?: string; rawPixels?: string; width?: number; height?: number; components?: number }; [key: string]: unknown } | undefined;
    const preview = data?.preview ?? data;
    if (preview && "rawPixels" in preview && typeof preview.rawPixels === "string") {
      const encoded = encodePng(Buffer.from(preview.rawPixels, "base64"), Number(preview.width), Number(preview.height), Number(preview.components));
      preview.base64 = encoded.toString("base64"); preview.mimeType = "image/png";
      delete preview.rawPixels;
    }
    if (preview?.base64) {
      return {
        content: [{ type: "image", data: preview.base64, mimeType: preview.mimeType ?? "image/jpeg" }],
        structuredContent: { ...data, preview: { ...(data?.preview ?? {}), base64: "[omitted from structuredContent]" }, base64: "[omitted from structuredContent]" },
      };
    }
    return result(data ?? {});
  }

  private async executeCommand(input: JsonObject): Promise<ToolResult> {
    const commandId = String(input.command_id);
    const command = this.catalog.get(commandId);
    const args = this.catalog.validate(commandId, input.args ?? {});
    const operationId = typeof input.idempotency_key === "string" ? `legacy:${input.idempotency_key}` : randomUUID();
    const requestDigest = digest({ commandId, args, target: input.target ?? null, dialogMode: input.dialog_mode ?? "silent", verification: input.verification ?? command.verification });
    const prior = this.commandCalls.get(operationId);
    if (prior) {
      if (prior.digest !== requestDigest) throw new PhotoshopMcpError("IDEMPOTENCY_CONFLICT", "The operation key is bound to different arguments", { operationId });
      return prior.promise;
    }
    const promise = (async (): Promise<ToolResult> => {
      try {
        const retained = this.bridge.operation(operationId);
        if (retained && retained.command.requestDigest !== requestDigest) throw new PhotoshopMcpError("IDEMPOTENCY_CONFLICT", "The operation key is bound to different arguments", { operationId });
        let raw;
        if (retained) raw = await this.bridge.dispatch("command.execute", retained.command.payload, this.config.commandTimeoutMs, { operationId, requestDigest });
        else {
          const approvalToken = this.approvalToken(command.id, { args }, input.approval_token, command.approval !== "none");
          this.policy.authorize(command, args, approvalToken);
          if (command.engine === "user_assisted") {
            const before = await this.requireBridgeData("state.get", {});
            const host = needsHostPrerequisiteState(command) ? await this.requireBridgeData("host.describe", {}) : undefined;
            assertCommandPrerequisites(command, before, host);
            return this.startUserAssisted(command, args, operationId, requestDigest);
          }
          const target = input.target ?? (command.prerequisites.includes("document") ? await this.requireBridgeData("target.capture", {}) : undefined);
          raw = await this.bridge.dispatch("command.execute", {
            commandId, args: this.dispatchArgs(commandId, args),
            ...(target ? { target } : {}), prerequisites: command.prerequisites, minHostVersion: command.minHostVersion,
            dialogMode: input.dialog_mode ?? "silent", verification: input.verification ?? command.verification,
          }, command.risk === "credit" ? 180_000 : this.config.commandTimeoutMs, { operationId, requestDigest });
        }
        if (!raw.ok) throw new PhotoshopMcpError(bridgeErrorCode(raw.error?.code), raw.error?.message ?? `${commandId} failed`, { ...raw.error, effect: raw.effect, operationId });
        const data = asRecord(raw.data) ?? {};
        if (data.awaitingUser === true && typeof data.jobId === "string") return result({ ok: true, requestId: operationId, commandId, status: "awaiting_user", summary: "Photoshop에서 사용자 입력을 기다리는 중입니다", result: { jobId: data.jobId }, warnings: ["The Photoshop dialog must be completed or cancelled by the user"] });
        const envelope: McpEnvelope = {
          ok: true, requestId: operationId, commandId, status: "completed", summary: `${command.labels.ko} 완료`,
          result: data.result ?? raw.data,
          warnings: command.status === "experimental" ? ["Experimental command; inspect the returned evidence"] : [],
          ...(data.before !== undefined ? { before: data.before } : {}),
          ...(data.after !== undefined ? { after: data.after } : {}),
          ...(data.undo !== undefined ? { undo: data.undo as NonNullable<McpEnvelope["undo"]> } : {}),
        };
        return result({ ...envelope, ...(data.verification ? { verification: data.verification } : {}), ...(data.evidence ? { evidence: data.evidence } : {}) });
      } catch (error) { return result(failureEnvelope(commandId, operationId, error), true); }
    })();
    this.commandCalls.set(operationId, { digest: requestDigest, promise });
    // This is only an in-flight waiter cache. The owner journal is authoritative.
    void promise.finally(() => this.commandCalls.delete(operationId));
    return promise;
  }

  private async requireBridgeData(kind: string, payload: JsonObject): Promise<unknown> {
    const response = await this.dispatchBridge(kind, payload);
    if (!response.ok) throw new PhotoshopMcpError("HOST_ERROR", response.error?.message ?? `${kind} failed`, response.error);
    return response.data;
  }

  private approvalToken(commandId: string, scope: unknown, provided: unknown, required = true): unknown {
    if (!required || provided !== undefined || this.config.approvalMode !== "auto") return provided;
    return this.policy.issueApproval(commandId, scope).token;
  }

  private dispatchArgs(_commandId: string, args: JsonObject): JsonObject {
    return args;
  }

  private async startUserAssisted(command: CommandDefinition, args: JsonObject, requestId: string, requestDigest: string): Promise<ToolResult> {
    const job = this.jobs.create(command.id, "queued", { kind: "user_assisted", message: "Waiting for the Photoshop panel" });
    const response = await this.bridge.dispatch("command.execute", { commandId: command.id, args, jobId: job.id, dialogMode: "display" }, this.config.commandTimeoutMs, { operationId: requestId, requestDigest });
    if (!response.ok) {
      this.jobs.update(job.id, { status: "failed", error: response.error });
      throw new PhotoshopMcpError("HOST_ERROR", response.error?.message ?? `${command.id} failed`, response.error);
    }
    this.jobs.update(job.id, { status: "awaiting_user", message: "Complete or cancel the native Photoshop dialog" });
    return result({
      ok: true,
      requestId,
      commandId: command.id,
      status: "awaiting_user",
      summary: "Photoshop에서 사용자 입력을 기다리는 중입니다",
      result: { jobId: job.id },
      warnings: ["The Photoshop dialog must be completed or cancelled by the user"],
    });
  }

  private async requestApproval(input: JsonObject): Promise<ToolResult> {
    const commandId = String(input.command_id);
    if (commandId === "advanced.execute") this.policy.assertAdvancedEnabled();
    const command = commandId === "advanced.execute"
      ? ({ id: commandId, labels: { en: "Advanced execution", ko: "고급 실행" }, risk: "destructive" } as Pick<CommandDefinition, "id" | "labels" | "risk">)
      : this.catalog.get(commandId);
    if (commandId !== "advanced.execute" && this.catalog.get(commandId).status === "unavailable") {
      throw new PhotoshopMcpError("UNSUPPORTED", this.catalog.get(commandId).unavailableReason ?? `${commandId} is unavailable`);
    }
    if (commandId !== "advanced.execute" && this.catalog.get(commandId).status === "unverified") {
      throw new PhotoshopMcpError("UNVERIFIED", `${commandId} must be validated before an ordinary execution approval can be issued`);
    }
    if (commandId !== "advanced.execute" && this.catalog.get(commandId).approval === "none") {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", `${commandId} does not require approval`);
    }
    let scope: unknown;
    let consequence: string;
    if (commandId === "advanced.execute") {
      if (input.engine !== "batchplay" || typeof input.justification !== "string" || input.justification.length < 8) {
        throw new PhotoshopMcpError("PRECONDITION_FAILED", "Advanced approval requires engine, payload, and justification");
      }
      this.policy.assertAdvancedPayload(input.payload);
      scope = { engine: input.engine, payload: input.payload, justification: input.justification };
      const objectNames = (input.payload as Array<Record<string, unknown>>).map((entry) => String(entry._obj)).join(", ");
      consequence = `Raw batchPlay: ${objectNames}; reason: ${input.justification}`;
    } else {
      const validatedArgs = this.catalog.validate(commandId, input.args ?? {});
      scope = { args: validatedArgs };
      consequence = commandId === "document.close"
        ? (validatedArgs.save === true ? "Close the active document after saving" : "Close the active document and discard unsaved changes")
        : `${command.labels.ko}; arguments are bound to this approval`;
    }
    const scopeDigest = approvalScopeDigest(scope);
    const job = this.jobs.create(`approval:${commandId}`, "queued", {
      kind: "approval",
      message: this.config.approvalMode === "auto" ? "Approved automatically by local policy" : "Waiting for explicit approval in Photoshop",
    });
    this.approvalJobs.set(job.id, { commandId, scope });
    if (this.config.approvalMode === "auto") {
      this.jobs.update(job.id, { status: "completed", message: `Automatically approved locally; scope ${scopeDigest}` });
      return result(this.jobs.get(job.id));
    }
    const response = await this.dispatchBridge("approval.request", {
      jobId: job.id,
      commandId,
      label: command.labels.ko,
      risk: command.risk,
      scopeDigest,
      consequence,
    });
    if (!response.ok) {
      this.jobs.update(job.id, { status: "failed", error: response.error });
      throw new PhotoshopMcpError("HOST_ERROR", response.error?.message ?? "Approval request failed", response.error);
    }
    this.jobs.update(job.id, { status: "awaiting_user", message: "Approve or reject in the Photoshop MCP v2 panel" });
    return result(this.jobs.get(job.id));
  }

  private async getJob(jobId: string): Promise<ToolResult> {
    const job = this.jobs.get(jobId);
    const approvalContext = this.approvalJobs.get(jobId);
    if (approvalContext && job.status === "completed") {
      this.approvalJobs.delete(jobId);
      const approval = this.policy.issueApproval(approvalContext.commandId, approvalContext.scope);
      return result({ ...job, approvalToken: approval.token, approvalExpiresAt: approval.expiresAt });
    }
    return result(job);
  }

  private async resumeJob(jobId: string): Promise<ToolResult> {
    const job = this.jobs.get(jobId);
    if (job.kind === "approval" || this.approvalJobs.has(jobId)) {
      throw new PhotoshopMcpError("APPROVAL_REQUIRED", "Approval jobs can only be completed by an authenticated Photoshop panel decision");
    }
    if (job.kind === "user_assisted") {
      throw new PhotoshopMcpError("REQUIRES_USER", "User-assisted jobs can only be completed or cancelled with the buttons in the authenticated Photoshop panel");
    }
    throw new PhotoshopMcpError("PRECONDITION_FAILED", `Job ${jobId} is not remotely resumable`);
  }

  private async advancedExecute(args: JsonObject): Promise<ToolResult> {
    this.policy.assertAdvancedEnabled();
    this.policy.assertAdvancedPayload(args.payload);
    const scope = { engine: args.engine, payload: args.payload, justification: args.justification };
    const approvalToken = this.approvalToken("advanced.execute", scope, args.approval_token);
    this.policy.consumeApproval("advanced.execute", scope, approvalToken);
    const serialized = JSON.stringify(args.payload);
    if (Buffer.byteLength(serialized) > 1_000_000) throw new PhotoshopMcpError("PRECONDITION_FAILED", "Advanced payload exceeds 1 MB");
    const response = await this.dispatchBridge("advanced.batchplay", {
      descriptors: args.payload,
      justification: args.justification,
    });
    if (!response.ok) throw new PhotoshopMcpError(bridgeErrorCode(response.error?.code), response.error?.message ?? "Advanced execution failed", response.error);
    return result({ ok: true, requestId: randomUUID(), commandId: "advanced.execute", status: "completed", summary: "Advanced batchPlay completed", result: response.data, warnings: [this.config.approvalMode === "auto" ? "Raw descriptor execution was automatically approved by local policy" : "Raw descriptor execution was explicitly approved"] });
  }

  private assertValidationCandidate(command: CommandDefinition): void {
    if (this.config.validationProfile !== "confirm") throw new PhotoshopMcpError("APPROVAL_REQUIRED", "Validation profile is disabled");
    if (command.status !== "unverified") throw new PhotoshopMcpError("PRECONDITION_FAILED", `${command.id} is not an unverified validation candidate`);
    if (command.engine !== "uxp_dom") {
      throw new PhotoshopMcpError("UNVERIFIED", "Validation permits documented UXP DOM commands only");
    }
    if (!validationProfileAllowsRisk(command)) {
      throw new PhotoshopMcpError("APPROVAL_REQUIRED", "Credit and unrestricted external commands are excluded from the validation profile");
    }
  }

  private async requireValidationDocument(commandId: string): Promise<unknown> {
    const state = await this.requireBridgeData("state.get", {});
    const title = (state as { activeDocument?: { title?: unknown } } | undefined)?.activeDocument?.title;
    if (typeof title !== "string" || !title.startsWith("PS_MCP_VALIDATION_")) {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", `${commandId} validation requires an active temporary document named PS_MCP_VALIDATION_*`);
    }
    return state;
  }

  private async requestValidationApproval(input: JsonObject): Promise<ToolResult> {
    const command = this.catalog.get(String(input.command_id));
    this.assertValidationCandidate(command);
    const args = this.catalog.validate(command.id, input.args ?? {});
    let state: unknown;
    if (command.id === "document.create" && (typeof args.name !== "string" || !args.name.startsWith("PS_MCP_VALIDATION_"))) {
      throw new PhotoshopMcpError("PRECONDITION_FAILED", "Validation document.create requires a name beginning with PS_MCP_VALIDATION_");
    }
    if (!validationRequiresTemporaryDocument(command.id)) {
      state = await this.requireBridgeData("state.get", {});
    } else {
      state = await this.requireValidationDocument(command.id);
    }
    const host = needsHostPrerequisiteState(command) ? await this.requireBridgeData("host.describe", {}) : undefined;
    assertCommandPrerequisites(command, state, host);
    const scope = { args };
    const approvalCommandId = `validation:${command.id}`;
    const job = this.jobs.create(`approval:${approvalCommandId}`, "queued", {
      kind: "approval",
      message: this.config.approvalMode === "auto" ? "Validation approved automatically by local policy" : "Waiting for validation approval in Photoshop",
    });
    this.approvalJobs.set(job.id, { commandId: approvalCommandId, scope });
    if (this.config.approvalMode === "auto") {
      this.jobs.update(job.id, { status: "completed", message: `Validation approved automatically; scope ${approvalScopeDigest(scope)}` });
      return result(this.jobs.get(job.id));
    }
    const response = await this.dispatchBridge("approval.request", {
      jobId: job.id,
      commandId: approvalCommandId,
      label: `검증: ${command.labels.ko}`,
      risk: command.risk,
      scopeDigest: approvalScopeDigest(scope),
      consequence: `Run unverified UXP DOM command ${command.id} on the active PS_MCP_VALIDATION_ temporary document`,
    });
    if (!response.ok) {
      this.jobs.update(job.id, { status: "failed", error: response.error });
      throw new PhotoshopMcpError("HOST_ERROR", response.error?.message ?? "Validation approval request failed", response.error);
    }
    this.jobs.update(job.id, { status: "awaiting_user", message: "Approve or reject validation in the Photoshop panel" });
    return result(this.jobs.get(job.id));
  }

  private async validateUnverifiedCommand(input: JsonObject): Promise<ToolResult> {
    const command = this.catalog.get(String(input.command_id));
    this.assertValidationCandidate(command);
    const args = this.catalog.validate(command.id, input.args ?? {});
    const before = !validationRequiresTemporaryDocument(command.id)
      ? await this.requireBridgeData("state.get", {})
      : await this.requireValidationDocument(command.id);
    const host = needsHostPrerequisiteState(command) ? await this.requireBridgeData("host.describe", {}) : undefined;
    assertCommandPrerequisites(command, before, host);
    const approvalCommandId = `validation:${command.id}`;
    const approvalToken = this.approvalToken(approvalCommandId, { args }, input.approval_token);
    this.policy.consumeApproval(approvalCommandId, { args }, approvalToken);
    const raw = await this.dispatchBridge("command.execute", {
      commandId: command.id,
      args: this.dispatchArgs(command.id, args),
      dialogMode: "silent",
      verification: command.verification,
    });
    if (!raw.ok) throw new PhotoshopMcpError(bridgeErrorCode(raw.error?.code), raw.error?.message ?? `${command.id} validation failed`, raw.error);
    const after = command.id === "document.close" || !validationRequiresTemporaryDocument(command.id)
      ? await this.requireBridgeData("state.get", {})
      : await this.requireValidationDocument(command.id);
    if (command.id === "document.close") {
      const beforeId = (before as { activeDocument?: { id?: unknown } } | undefined)?.activeDocument?.id;
      const afterId = (after as { activeDocument?: { id?: unknown } } | undefined)?.activeDocument?.id;
      if (beforeId !== undefined && beforeId === afterId) throw new PhotoshopMcpError("VERIFICATION_FAILED", "Validation document remained active after close");
    }
    if (command.id === "document.open_default") {
      const beforeId = (before as { activeDocument?: { id?: unknown } } | undefined)?.activeDocument?.id;
      const afterId = (after as { activeDocument?: { id?: unknown } } | undefined)?.activeDocument?.id;
      if (afterId === undefined || beforeId === afterId) throw new PhotoshopMcpError("VERIFICATION_FAILED", "Default-folder validation did not activate a newly opened document");
    }
    return result({
      ok: true,
      requestId: randomUUID(),
      commandId: command.id,
      status: "completed",
      summary: `${command.id} completed in validation profile; catalog remains unverified until fixture evidence is recorded`,
      result: raw.data,
      warnings: ["Validation profile execution does not automatically promote capability status"],
      before,
      after,
      undo: { available: command.rollback === "history", ...(command.rollback === "history" ? { historyStates: 1 } : {}) },
    });
  }
}
