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

  async put<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', path, body, opts);
  }

  async patch<T>(path: string, body: unknown, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>('PATCH', path, body, opts);
  }

  async delete<T = void>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, undefined, opts);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    opts: RequestOptions,
  ): Promise<T> {
    const init: RequestInit = {
      method,
      // Routes that take minutes (writing lyrics) may answer as a job (202 { jobId }), which is then followed to its
      // result: casperaki.com's tunnel ends any request not answered within 100 seconds (brain src/jobs.ts).
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(method === 'POST' ? { prefer: 'respond-async' } : {}) },
      signal: opts.signal,
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    const text = await res.text();
    let parsed: unknown = text ? safeJson(text) : undefined;
    let status = res.status;

    if (status === 202 && parsed && typeof parsed === 'object' && typeof (parsed as { jobId?: unknown }).jobId === 'string') {
      const result = await this.followJob((parsed as { jobId: string }).jobId, opts);
      status = result.status;
      parsed = result.body;
    }

    if (status < 200 || status >= 300) {
      const errBody =
        parsed && typeof parsed === 'object' ? (parsed as BrainErrorBody) : undefined;
      throw new BrainError(
        status,
        errBody,
        errBody?.message ?? errBody?.error ?? `Brain ${method} ${path} failed (${status})`,
      );
    }
    return parsed as T;
  }

  /** Polls a job until it is done: the status and body its route answered. */
  private async followJob(jobId: string, opts: RequestOptions): Promise<{ status: number; body: unknown }> {
    for (;;) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, JOB_POLL_MS);
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(opts.signal!.reason);
        }, { once: true });
      });
      const job = await this.get<{ done: boolean; status?: number; body?: unknown }>(`/api/jobs/${encodeURIComponent(jobId)}`, opts);
      if (job.done) {
        if (typeof job.status !== 'number') throw new Error(`Brain job ${jobId} finished without a status`);
        return { status: job.status, body: job.body };
      }
    }
  }
}

const JOB_POLL_MS = 2000;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export const defaultBrainClient = new BrainClient();
