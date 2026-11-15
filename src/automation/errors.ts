export class AutomationError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'AutomationError';
  }
}
export function requireCondition(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AutomationError(code, message);
}
export function asAutomationError(error: unknown): AutomationError {
  return error instanceof AutomationError ? error : new AutomationError('AUTOMATION_ERROR', error instanceof Error ? error.message : String(error));
}
