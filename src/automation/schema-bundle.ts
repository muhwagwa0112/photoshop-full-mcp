import { requestSchema, parameterDefinitions, resultDefinitions, type Schema } from './validation.js';
import { AutomationError, requireCondition } from './errors.js';

/** External consumers (MCP clients and Ollama grammars) receive self-contained JSON schemas. */
export function dereferenceSchema(schema: Schema, family: 'request' | 'parameters' | 'results' = 'request'): Schema {
  const roots: Record<string, Record<string, unknown>> = { request: requestSchema, parameters: { $defs: parameterDefinitions }, results: { $defs: resultDefinitions } };
  function visit(value: unknown, owner: string, stack: string[]): unknown {
    if (Array.isArray(value)) return value.map(item => visit(item, owner, stack));
    if (!value || typeof value !== 'object') return value;
    const node = value as Record<string, unknown>; let result: Record<string, unknown> = {};
    if (typeof node.$ref === 'string') {
      const reference = node.$ref; let targetOwner = owner;
      if (reference.includes('recipe-parameters') || reference.startsWith('urn:fig-studio:adobe-mcp:recipe-parameters')) targetOwner = 'parameters';
      else if (reference.includes('recipe-request')) targetOwner = 'request';
      else if (reference.includes('operation-results')) targetOwner = 'results';
      else requireCondition(reference.startsWith('#/'), 'SCHEMA_REFERENCE_UNSUPPORTED', `Unsupported public schema reference: ${reference}`);
      const pointer = reference.slice(reference.indexOf('#') + 1); requireCondition(pointer.startsWith('/'), 'SCHEMA_REFERENCE_UNSUPPORTED', 'Only explicit local JSON pointers are supported.');
      const identity = `${targetOwner}#${pointer}`; requireCondition(!stack.includes(identity), 'RECURSIVE_PUBLIC_SCHEMA', 'Recursive public schemas require an explicit bounded representation.');
      let target: unknown = roots[targetOwner];
      for (const part of pointer.slice(1).split('/')) { const key = part.replaceAll('~1', '/').replaceAll('~0', '~'); requireCondition(target && typeof target === 'object' && Object.hasOwn(target, key), 'SCHEMA_REFERENCE_MISSING', `Missing schema pointer ${reference}.`); target = (target as Record<string, unknown>)[key]; }
      result = visit(target, targetOwner, [...stack, identity]) as Record<string, unknown>;
    }
    for (const [key, child] of Object.entries(node)) if (!['$ref', '$id', '$schema', '$defs'].includes(key)) result[key] = visit(child, owner, stack);
    return result;
  }
  return visit(schema, family, []) as Schema;
}
