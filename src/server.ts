import { randomUUID } from "node:crypto";
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

interface RegisteredTool {
  definition: Tool;
  handler: (args: JsonObject) => Promise<ToolResult>;
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
  private readonly idempotency = new Map<string, McpEnvelope>();
  private readonly approvalJobs = new Map<string, { commandId: string; scope: unknown }>();

  private constructor(private readonly config: ServerConfig, private readonly catalog: CommandCatalog) {
    this.policy = new PolicyEngine(config);
    this.bridge = new BridgeServer(config, this.jobs);
    this.server = new Server(
      { name: "photoshop-full-mcp", version: "2.0.0" },
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

  static async create(config: ServerConfig, catalog: CommandCatalog): Promise<PhotoshopFullMcpServer> {
    return new PhotoshopFullMcpServer(config, catalog);
  }

  async start(): Promise<void> {
    const port = await this.bridge.start();
    process.stderr.write(`[photoshop-full-mcp] bridge listening on 127.0.0.1:${port}\n`);
    await this.server.connect(new StdioServerTransport());
  }

  async stop(): Promise<void> {
    await this.bridge.stop();
    await this.server.close();
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
      "Display the short-lived bridge pairing code in a trusted local Windows dialog. The code is never returned to the MCP client.",
      objectSchema(),
      async () => {
        await this.bridge.showPairingDialog();
        return result({ displayed: true, paired: this.bridge.status().paired, note: "The local pairing dialog was closed" });
      },
      { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    );
    this.register(
      "photoshop_capability_list",
      "List the versioned command catalog. Supported means locally verified; unverified and unavailable are never executed.",
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
          const probe = await this.bridge.dispatch("host.describe", {});
          runtime = probe.ok ? probe.data : { probeError: probe.error };
        }
        return result({
          summary: { commands: summarize(commands), inventory: summarize(inventory) },
          ...(filters.summary_only ? {} : { commands, inventory }),
          runtime: runtime ?? { bridgeConnected: false, note: "Runtime probes are available after the UXP panel is paired" },
        });
      },
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    );
    this.register(
      "photoshop_state_get",
      "Return live document, active layer, selection, and history state from the UXP plugin. Side effects: none.",
      objectSchema(),
      async () => this.bridgeTool("state.get", {}),
      { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    );
    this.register(
      "photoshop_preview_get",
      "Return a low-resolution JPEG preview of the active Photoshop document. Side effects: temporary export only.",
      objectSchema({ max_edge: { type: "integer", minimum: 128, maximum: 2048, default: 1024 } }),
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
      async (args) => result(this.jobs.cancel(String(args.job_id))),
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
        schema,
        async (args) => this.executeCommand({ command_id: commandId, args }),
        { destructiveHint: false, idempotentHint: false, openWorldHint: false },
      );
    }
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...this.tools.values()].map((tool) => tool.definition) }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const registered = this.tools.get(request.params.name);
      if (!registered) throw new Error(`Tool not found: ${request.params.name}`);
      try {
        return await registered.handler((request.params.arguments ?? {}) as JsonObject);
      } catch (error) {
        return result(failureEnvelope(request.params.name, randomUUID(), error), true);
      }
    });
  }

  private async hostDescribe(): Promise<ToolResult> {
    const bridge = this.bridge.status(false);
    const installed = await discoverInstalledPhotoshop();
    let runtime: unknown;
    if (bridge.connected) {
      const live = await this.bridge.dispatch("host.describe", {});
      runtime = live.ok ? live.data : live.error;
    }
    return result({ serverVersion: "2.0.0", approvalMode: this.config.approvalMode, bridge, installed, ...(runtime !== undefined ? { runtime } : {}) });
  }

  private async bridgeTool(kind: string, payload: JsonObject): Promise<ToolResult> {
    const response = await this.bridge.dispatch(kind, payload);
    if (!response.ok) throw new PhotoshopMcpError("HOST_ERROR", response.error?.message ?? `${kind} failed`, response.error);
    return result(response.data ?? { ok: true });
  }

  private async preview(args: JsonObject): Promise<ToolResult> {
    const response = await this.bridge.dispatch("preview.get", { maxEdge: args.max_edge ?? 1024 });
    if (!response.ok) throw new PhotoshopMcpError("HOST_ERROR", response.error?.message ?? "Preview failed", response.error);
    const data = response.data as { base64?: string; mimeType?: string; preview?: { base64?: string; mimeType?: string }; [key: string]: unknown } | undefined;
    const preview = data?.preview ?? data;
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
    const requestId = randomUUID();
    const idempotencyKey = typeof input.idempotency_key === "string" ? input.idempotency_key : undefined;
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) return result(this.idempotency.get(idempotencyKey));
    try {
      const command = this.catalog.get(commandId);
      const args = this.catalog.validate(commandId, input.args ?? {});
      const approvalToken = this.approvalToken(command.id, { args }, input.approval_token, command.approval !== "none");
      this.policy.authorize(command, args, approvalToken);
      if (command.engine === "user_assisted") {
        const before = await this.requireBridgeData("state.get", {});
        const host = needsHostPrerequisiteState(command) ? await this.requireBridgeData("host.describe", {}) : undefined;
        assertCommandPrerequisites(command, before, host);
        return await this.startUserAssisted(command, args, requestId);
      }
      const prerequisiteState = command.verification !== "none" || command.prerequisites.length
        ? await this.requireBridgeData("state.get", {})
        : undefined;
      const before = command.verification !== "none" ? prerequisiteState : undefined;
      const host = needsHostPrerequisiteState(command) ? await this.requireBridgeData("host.describe", {}) : undefined;
      assertCommandPrerequisites(command, prerequisiteState, host);
      const raw = await this.bridge.dispatch("command.execute", {
        commandId,
        args: this.dispatchArgs(commandId, args),
        dialogMode: input.dialog_mode ?? "silent",
        verification: input.verification ?? command.verification,
      }, command.risk === "credit" ? 180_000 : this.config.commandTimeoutMs);
      if (!raw.ok) throw new PhotoshopMcpError(bridgeErrorCode(raw.error?.code), raw.error?.message ?? `${commandId} failed`, raw.error);
      const after = command.verification !== "none" ? await this.requireBridgeData("state.get", {}) : undefined;
      const envelope: McpEnvelope = {
        ok: true,
        requestId,
        commandId,
        status: "completed",
        summary: `${command.labels.ko} 완료`,
        result: raw.data,
        warnings: command.status === "experimental" ? ["Experimental command; inspect the preview before continuing"] : [],
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        undo: { available: command.rollback === "history", ...(command.rollback === "history" ? { historyStates: 1 } : {}) },
      };
      if (idempotencyKey) {
        this.idempotency.set(idempotencyKey, envelope);
        if (this.idempotency.size > 1_000) this.idempotency.delete(this.idempotency.keys().next().value as string);
      }
      return result(envelope);
    } catch (error) {
      return result(failureEnvelope(commandId, requestId, error), true);
    }
  }

  private async requireBridgeData(kind: string, payload: JsonObject): Promise<unknown> {
    const response = await this.bridge.dispatch(kind, payload);
    if (!response.ok) throw new PhotoshopMcpError("HOST_ERROR", response.error?.message ?? `${kind} failed`, response.error);
    return response.data;
  }

  private approvalToken(commandId: string, scope: unknown, provided: unknown, required = true): unknown {
    if (!required || provided !== undefined || this.config.approvalMode !== "auto") return provided;
    return this.policy.issueApproval(commandId, scope).token;
  }

  private dispatchArgs(commandId: string, args: JsonObject): JsonObject {
    return this.config.approvalMode === "auto" && commandId === "document.export"
      ? { ...args, overwrite_approved: true }
      : args;
  }

  private async startUserAssisted(command: CommandDefinition, args: JsonObject, requestId: string): Promise<ToolResult> {
    const job = this.jobs.create(command.id, "queued", { kind: "user_assisted", message: "Waiting for the Photoshop panel" });
    const response = await this.bridge.dispatch("command.execute", { commandId: command.id, args, jobId: job.id, dialogMode: "display" });
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
    const response = await this.bridge.dispatch("approval.request", {
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
    const response = await this.bridge.dispatch("advanced.batchplay", {
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
    const response = await this.bridge.dispatch("approval.request", {
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
    const raw = await this.bridge.dispatch("command.execute", {
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
