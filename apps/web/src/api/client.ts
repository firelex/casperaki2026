/**
 * Tiny typed fetch wrapper for the brain.
 *
 * Kept dependency-free so it can be unit-tested with a mocked `fetch`
 * (see `test/api.test.ts`). Real brain endpoints live in `./songs.ts`.
 */

export interface BrainErrorBody {
  readonly error: string;
  readonly message?: string;
  readonly issues?: ReadonlyArray<{ readonly path: string; readonly message: string }>;
  readonly id?: string;
}

export class BrainError extends Error {
  readonly status: number;
  readonly body: BrainErrorBody | undefined;
  constructor(status: number, body: BrainErrorBody | undefined, message: string) {
    super(message);
    this.name = 'BrainError';
    this.status = status;
    this.body = body;
  }
}

export interface BrainClientOptions {
  /** Override fetch (tests). Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Base URL. Defaults to `''` so paths resolve against the Vite dev proxy. */
  readonly baseUrl?: string;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

export class BrainClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(opts: BrainClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = opts.baseUrl ?? '';
  }

  async get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, undefined, opts);
  }

  async post<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, body, opts);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    opts: RequestOptions,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      signal: opts.signal,
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    const parsed: unknown = text ? safeJson(text) : undefined;

    if (!res.ok) {
      const errBody =
        parsed && typeof parsed === 'object' ? (parsed as BrainErrorBody) : undefined;
      throw new BrainError(
        res.status,
        errBody,
        errBody?.message ?? errBody?.error ?? `Brain ${method} ${path} failed (${res.status})`,
      );
    }
    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export const defaultBrainClient = new BrainClient();
