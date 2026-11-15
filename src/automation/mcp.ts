import type { ControllerResponse } from './contracts.js';
import type { WorkflowServiceApi } from './service.js';
import { OperationRegistry } from './registry.js';
import { objectSchema, requestSchema, stringSchema as str, type Schema, parameterDefinitions } from './validation.js';
import { planStepSchema } from './controller.js';
import { asAutomationError } from './errors.js';
import { dereferenceSchema } from './schema-bundle.js';

export interface AutomationToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
export interface AutomationToolDefinition {
  name: string; description: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}
export interface AutomationTool { definition: AutomationToolDefinition; handler: (args: Record<string, unknown>) => Promise<AutomationToolResult> }
export interface AutomationToolOptions { service: WorkflowServiceApi; prefix?: string }
export interface AutomationToolRegistrar {
  register(name: string, description: string, inputSchema: Record<string, unknown>, handler: (args: Record<string, unknown>) => Promise<AutomationToolResult>, annotations: AutomationToolDefinition['annotations']): void;
}
function publicRequestSchema(): Schema {
  const request = structuredClone(requestSchema); const definitions = { ...(request.$defs as Record<string, unknown>) };
  const rewrite = (value: unknown, parameter: boolean): unknown => {
    if (Array.isArray(value)) return value.map(item => rewrite(item, parameter));
    if (!value || typeof value !== 'object') return value;
    const object = value as Record<string, unknown>; const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(object)) {
      if (key === '$id' || key === '$schema' || key === '$defs') continue;
      if (key === '$ref' && typeof child === 'string') {
        result[key] = child.startsWith('recipe-parameters.schema.json#/$defs/') ? child.replace('recipe-parameters.schema.json#/$defs/', '#/$defs/parameter_') : parameter && child.startsWith('#/$defs/') ? child.replace('#/$defs/', '#/$defs/parameter_') : child;
      } else result[key] = rewrite(child, parameter);
    }
    return result;
  };
  const result = rewrite(request, false) as Schema;
  result.$defs = Object.fromEntries([...Object.entries(definitions).map(([key, value]) => [key, rewrite(value, false)]), ...Object.entries(parameterDefinitions).map(([key, value]) => [`parameter_${key}`, rewrite(value, true)])]);
  return result;
}
function responseSchema(registry: OperationRegistry): Schema {
  const strings = { type: 'array', items: str, uniqueItems: true };
  const patch = objectSchema({ kind: { enum: ['initial_plan', 'repair'] }, steps: { type: 'array', items: planStepSchema(registry), minItems: 1, maxItems: 128 }, replacesStepKeys: strings, reasonRequirementIds: strings });
  const verdict = objectSchema({ requirementId: str, verdict: { enum: ['pass', 'fail', 'uncertain'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, assertionIds: strings, evidenceKeys: strings, reason: { type: 'string' } }, ['requirementId', 'verdict', 'assertionIds', 'evidenceKeys', 'reason']);
  const usage = objectSchema({ requestId: str, providerId: str, state: { enum: ['reserved', 'consumed', 'unknown'] }, inputTokens: { type: 'integer', minimum: 0 }, outputTokens: { type: 'integer', minimum: 0 }, imagePixels: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' }, costMinor: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' }, currency: str, enforcement: { enum: ['server_enforced', 'client_reported'] }, accounting: { enum: ['provider_reported', 'reserved_upper_bound', 'client_reported'] } });
  return objectSchema({ requestId: str, requestDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' }, providerId: str, verdicts: { type: 'array', items: verdict }, issues: { type: 'array', items: objectSchema({ issueId: str, requirementId: str, evidenceKeys: strings, proposedPatch: patch, region: objectSchema({ x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number', minimum: 0 }, height: { type: 'number', minimum: 0 } }), timeRange: objectSchema({ start: objectSchema({ ticks: { type: 'string', pattern: '^-?(0|[1-9][0-9]*)$' } }), end: objectSchema({ ticks: { type: 'string', pattern: '^-?(0|[1-9][0-9]*)$' } }) }) }, ['issueId', 'requirementId', 'evidenceKeys']) }, initialPlan: patch, usage }, ['requestId', 'requestDigest', 'providerId', 'verdicts', 'issues', 'usage']);
}
function toolResult(value: unknown): AutomationToolResult {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value };
  const { images, ...structuredContent } = object;
  const content: AutomationToolResult['content'] = [{ type: 'text', text: JSON.stringify(structuredContent) }];
  if (Array.isArray(images)) for (const image of images as { evidenceKey: string; data: string; mimeType: string }[]) { content.push({ type: 'text', text: `Evidence: ${image.evidenceKey}` }, { type: 'image', data: image.data, mimeType: image.mimeType }); }
  return { content, structuredContent };
}
export function createAutomationTools(options: AutomationToolOptions): AutomationTool[] {
  const registry = new OperationRegistry(); const { service } = options; const prefix = options.prefix ? options.prefix.replace(/_$/, '') + '_' : '';
  const tools: AutomationTool[] = [];
  const add = (name: string, description: string, schema: Schema, readOnly: boolean, handler: (args: Record<string, unknown>) => Promise<unknown>): void => {
    tools.push({ definition: { name: prefix + name, description, inputSchema: schema as AutomationToolDefinition['inputSchema'], annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, handler: async args => {
      try { registry.validator.validate(schema, args, 'TOOL_ARGUMENTS_INVALID'); return toolResult(await handler(args)); }
      catch (error) { const failure = asAutomationError(error); return { ...toolResult({ error: { code: failure.code, message: failure.message } }), isError: true }; }
    } });
  };
  add('workflow_describe', 'Read the owner workflowHome, registered root IDs, preset IDs, configured provider/worker availability, and current host capabilities without running a model or edit.', objectSchema({}), true, () => service.describe());
  add('workflow_submit', 'Persist and run one of seven typed Adobe edit recipes. Reuse the same requestId to retrieve the same acceptance; source assets are preserved. Long operations continue under the configured workflow owner.', publicRequestSchema(), false, args => service.submit(args));
  add('workflow_status', 'Read durable workflow state by jobId or original requestId, including a pending controller request. This does not submit another edit.', { ...objectSchema({ jobId: str, requestId: str, workflowHome: objectSchema({ app: { enum: ['photoshop', 'premiere'] }, installationId: str, namespaceId: str }) }, []), anyOf: [{ required: ['jobId'] }, { required: ['requestId'] }] }, true, args => service.status(args as Parameters<WorkflowServiceApi['status']>[0]));
  add('workflow_cancel', 'Persist job cancellation and request native/worker cancellation. A late host result remains recorded and cannot resurrect the cancelled job.', objectSchema({ jobId: str }), false, args => service.cancel(String(args.jobId)));
  add('workflow_outputs', 'Read workflow artifact references and publication state. Only observed files and receipts are returned.', objectSchema({ jobId: str }), true, args => service.outputs(String(args.jobId)));
  add('operation_status', 'Read a durable operation receipt; UNKNOWN does not authorize repeating the edit. Expired identities retain their tombstones.', objectSchema({ operationId: str }), true, args => service.operationStatus(String(args.operationId)));
  add('workflow_controller_request', 'Read the pending typed plan/review/repair request and bounded visual evidence for an active MCP client agent.', objectSchema({ jobId: str }), true, args => service.controllerRequest(String(args.jobId)));
  add('workflow_controller_respond', 'Submit one requirement/evidence-linked controller response. Only typed allowed operations may be proposed; repeated identical responses are accepted once.', objectSchema({ response: dereferenceSchema(responseSchema(registry)) }), false, args => service.controllerRespond(args.response as ControllerResponse));
  add('workflow_recipe_describe', 'Read the strict argument schema for one named recipe, or list the seven available recipe IDs.', objectSchema({ recipeId: { type: 'string', enum: Object.keys(parameterDefinitions).filter(key => /^(ps|pr|cross)\./.test(key)) } }, []), true, async args => args.recipeId ? { recipeId: args.recipeId, parameterSchema: dereferenceSchema(parameterDefinitions[String(args.recipeId)]!, 'parameters') } : { recipeIds: Object.keys(parameterDefinitions).filter(key => /^(ps|pr|cross)\./.test(key)) });
  return tools;
}
export function registerAutomationTools(server: AutomationToolRegistrar, options: AutomationToolOptions): AutomationTool[] {
  const tools = createAutomationTools(options);
  for (const tool of tools) server.register(tool.definition.name, tool.definition.description, tool.definition.inputSchema, tool.handler, tool.definition.annotations);
  return tools;
}
