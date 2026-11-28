// The vocals service (svc-vocals on the serving harness, apps/models/services/_serving/harness.py) as the Sing task
// talks to it: submit a stage's job, poll its state and steps, fetch the files its steps made and its result, cancel.
//
//   POST /generate {params}      -> 202 {job_id}
//   GET  /result?job=ID          -> {state: running|done|error, kind, error, steps: [ServiceStep]}; unknown job -> 404
//   GET  /file?job=ID            -> the job's result file
//   GET  /file?job=ID&name=F     -> a file one of its steps listed
//   POST /cancel?job=ID          -> 200, or 404 for an unknown job

/** A step as the harness reports it (times in seconds since the epoch). */
export interface ServiceStep {
  readonly id: string;
  readonly label: string;
  readonly state: 'running' | 'done' | 'failed';
  readonly started: number;
  readonly finished: number | null;
  readonly text: string;
  readonly numbers: Readonly<Record<string, number>>;
  readonly files: readonly string[];
}

export interface ServiceResult {
  readonly state: 'running' | 'done' | 'error';
  readonly error: string | null;
  readonly steps: readonly ServiceStep[];
}

/** The service no longer knows the job (it restarted, or dropped it). */
export class JobLostError extends Error {
  constructor(
    readonly job: string,
    service = 'vocal service',
    then = 'sing again',
  ) {
    super(`the ${service} lost the job: ${then}`);
    this.name = 'JobLostError';
  }
}

/** A model service on the serving harness (svc-vocals, svc-ace, svc-speech); `service` names it in messages. */
export class VocalsClient {
  constructor(
    private readonly baseUrl: string,
    private readonly service = 'vocal service',
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/u, '')}${path}`;
  }

  /** fetch, an unreachable service named with its address. */
  private async call(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(this.url(path), init);
    } catch (err) {
      throw new Error(`the ${this.service} at ${this.baseUrl} could not be reached: ${err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)}`);
    }
  }

  /** Starts a job: its id. */
  async submit(params: Record<string, unknown>): Promise<string> {
    const res = await this.call('/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
    if (res.status !== 202) throw new Error(`the ${this.service} refused the ${String(params['stage'])} job: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { job_id?: unknown };
    if (typeof body.job_id !== 'string') throw new Error(`the ${this.service} answered the ${String(params['stage'])} job without a job_id`);
    return body.job_id;
  }

  /** The job's state and steps (JobLostError for a job the service does not know). */
  async result(job: string): Promise<ServiceResult> {
    const res = await this.call(`/result?job=${encodeURIComponent(job)}`);
    if (res.status === 404) throw new JobLostError(job, this.service, this.service === 'vocal service' ? 'sing again' : 'start it again');
    if (!res.ok) throw new Error(`the ${this.service} answered ${res.status} for job ${job}: ${await res.text()}`);
    const body = (await res.json()) as Partial<ServiceResult>;
    if (body.state !== 'running' && body.state !== 'done' && body.state !== 'error') {
      throw new Error(`the ${this.service} reported job ${job} in an unknown state ${JSON.stringify(body.state)}`);
    }
    if (!Array.isArray(body.steps)) throw new Error(`the ${this.service} reported job ${job} without its steps`);
    return { state: body.state, error: body.error ?? null, steps: body.steps };
  }

  /** The job's result file (name undefined) or a file one of its steps listed. */
  async file(job: string, name?: string): Promise<Buffer> {
    const q = `job=${encodeURIComponent(job)}${name !== undefined ? `&name=${encodeURIComponent(name)}` : ''}`;
    const res = await this.call(`/file?${q}`);
    if (!res.ok) throw new Error(`the ${this.service} could not send ${name ?? 'the result'} of job ${job}: ${res.status} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Cancels a job: false when the service does not know it (nothing left to cancel). */
  async cancel(job: string): Promise<boolean> {
    const res = await this.call(`/cancel?job=${encodeURIComponent(job)}`, { method: 'POST' });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`the ${this.service} could not cancel job ${job}: ${res.status} ${await res.text()}`);
    return true;
  }
}
