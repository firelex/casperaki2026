import type { AdapterDiagnostic, AdapterDiagnostics } from '../errors.js';

export class Diagnostics {
  private items: AdapterDiagnostic[] = [];

  push(item: AdapterDiagnostic): void {
    this.items.push(item);
  }

  info(path: string, message: string, action: AdapterDiagnostic['action'] = 'kept'): void {
    this.items.push({ severity: 'info', path, message, action });
  }

  warn(path: string, message: string, action: AdapterDiagnostic['action'] = 'kept'): void {
    this.items.push({ severity: 'warning', path, message, action });
  }

  list(): AdapterDiagnostics {
    return [...this.items];
  }
}
