import type { ZodError, ZodIssue } from 'zod';

export class SchemaValidationError extends Error {
  public readonly issues: readonly ZodIssue[];
  constructor(message: string, issues: readonly ZodIssue[]) {
    super(message);
    this.name = 'SchemaValidationError';
    this.issues = issues;
  }
  static fromZod(err: ZodError, prefix = 'song-schema validation failed'): SchemaValidationError {
    const first = err.issues[0];
    const where = first ? ` at ${formatPath(first.path)}: ${first.message}` : '';
    return new SchemaValidationError(`${prefix}${where}`, err.issues);
  }
}

export class AdapterError extends Error {
  public readonly path?: string;
  constructor(message: string, path?: string) {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'AdapterError';
    this.path = path;
  }
}

export type DiagnosticSeverity = 'info' | 'warning';
export type DiagnosticAction = 'kept' | 'normalized' | 'dropped';

export interface AdapterDiagnostic {
  severity: DiagnosticSeverity;
  path: string;
  message: string;
  action: DiagnosticAction;
}

export type AdapterDiagnostics = AdapterDiagnostic[];

function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return '<root>';
  return path
    .map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`))
    .join('')
    .replace(/^\./, '');
}
