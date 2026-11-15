import { createHash } from 'node:crypto';
import { AutomationError } from './errors.js';

/** Object keys are ordered; arrays and Unicode code points are preserved. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  }
  throw new AutomationError('INVALID_JSON', 'Only finite JSON values are accepted.');
}
export function digest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function bytesDigest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Reject duplicate keys before JSON.parse can silently replace their values. */
export function parseStrictJson(text: string): unknown {
  let index = 0;
  function ws(): void { while (/\s/.test(text[index] ?? '') && index < text.length) index++; }
  function string(): string {
    const start = index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === '\\') index++;
      else if (char === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    throw new AutomationError('INVALID_JSON', 'Unterminated JSON string.');
  }
  function value(): void {
    ws(); const char = text[index];
    if (char === '{') {
      index++; ws(); const keys = new Set<string>();
      if (text[index] === '}') { index++; return; }
      for (;;) {
        ws(); if (text[index] !== '"') throw new AutomationError('INVALID_JSON', 'Expected object key.');
        const key = string();
        if (keys.has(key)) throw new AutomationError('DUPLICATE_JSON_KEY', `Duplicate JSON key: ${key}`);
        keys.add(key); ws(); if (text[index++] !== ':') throw new AutomationError('INVALID_JSON', 'Expected colon.');
        value(); ws(); const end = text[index++]; if (end === '}') return;
        if (end !== ',') throw new AutomationError('INVALID_JSON', 'Expected comma.');
      }
    }
    if (char === '[') {
      index++; ws(); if (text[index] === ']') { index++; return; }
      for (;;) { value(); ws(); const end = text[index++]; if (end === ']') return; if (end !== ',') throw new AutomationError('INVALID_JSON', 'Expected comma.'); }
    }
    if (char === '"') { string(); return; }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(index));
    if (!match) throw new AutomationError('INVALID_JSON', 'Invalid JSON value.');
    index += match[0].length;
  }
  value(); ws(); if (index !== text.length) throw new AutomationError('INVALID_JSON', 'Trailing JSON input.');
  const parsed: unknown = JSON.parse(text);
  canonicalJson(parsed);
  return parsed;
}
