// A fake avatar builder (apps/models/services/avatar-builder, harness contract) for the brain's tests: a build job's
// one step finishes on the first poll, listing person.vrm (VRM_BYTES) and build.json; `fail(message)` makes the next
// job fail.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export const VRM_BYTES = Buffer.from('glTF-fake-vrm-bytes');

interface Job { id: string; params: Record<string, unknown>; state: string; error: string | null; polled: number; failWith?: string }

export interface FakeAvatarBuilder {
  url: string;
  jobs: Job[];
  fail(message: string): void;
  stop(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}

const RESULT = { vrm: 'person.vrm', bytes: VRM_BYTES.length, images: [], probe: {}, credits: [{ name: 'Bootcut jeans', author: 'elvs', licence: 'CC-BY' }] };

export async function startFakeAvatarBuilder(): Promise<FakeAvatarBuilder> {
  const jobs: Job[] = [];
  let failNext: string | undefined;
  let n = 0;
  let server: Server;
  const svc: FakeAvatarBuilder = {
    url: '',
    jobs,
    fail: (m) => void (failNext = m),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const steps = (job: Job) =>
    job.polled === 0 ? [] : [{ id: 'build', label: 'Building the person', state: job.state === 'error' ? 'failed' : 'done', started: 1, finished: 2, text: '0.0 MB', numbers: {}, files: job.state === 'done' ? ['person.vrm', 'build.json'] : [] }];
  server = createServer((req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const job = jobs.find((j) => j.id === u.searchParams.get('job'));
      if (req.method === 'GET' && u.pathname === '/health') return send(200, { ready: true });
      if (req.method === 'POST' && u.pathname === '/generate') {
        const params = JSON.parse(await body(req)) as Record<string, unknown>;
        if (params['stage'] !== 'build') return send(400, { error: `unknown stage ${String(params['stage'])}` });
        const j: Job = { id: `build${++n}`, params, state: 'running', error: null, polled: 0, ...(failNext ? { failWith: failNext } : {}) };
        failNext = undefined;
        jobs.push(j);
        return send(202, { job_id: j.id });
      }
      if (req.method === 'GET' && u.pathname === '/result') {
        if (!job) return send(404, { error: 'unknown job' });
        if (job.state === 'running' && job.polled > 0) {
          job.state = job.failWith ? 'error' : 'done';
          job.error = job.failWith ?? null;
        }
        job.polled += 1;
        return send(200, { state: job.state, kind: job.state === 'done' ? 'json' : null, error: job.error, steps: steps(job) });
      }
      if (req.method === 'GET' && u.pathname === '/file') {
        const name = u.searchParams.get('name');
        if (!job) return send(404, { error: 'no file for job' });
        if (name === null) return job.state === 'done' ? send(200, RESULT) : send(404, { error: 'not done' });
        if (job.state !== 'done') return send(404, { error: 'not listed' });
        if (name === 'person.vrm') {
          res.writeHead(200, { 'content-type': 'model/gltf-binary' });
          return res.end(VRM_BYTES);
        }
        if (name === 'build.json') return send(200, RESULT);
        return send(404, { error: `file '${name}' was not listed` });
      }
      if (req.method === 'POST' && u.pathname === '/cancel') return send(200, { cancelled: true });
      return send(404, { error: 'not found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  svc.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return svc;
}
