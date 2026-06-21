import { Router } from 'express';
import { Readable } from 'node:stream';
import { serviceSpec, serviceSpecs } from '../services/registry.ts';
import {
  getServiceStatus,
  startService,
  stopService,
} from '../services/serviceManager.ts';

function statusFor(err: any): number {
  return typeof err?.status === 'number' ? err.status : 500;
}

/** Resolve a running, ready service's base URL or throw a friendly error. */
function readyUrl(id: string): string {
  const spec = serviceSpec(id);
  if (!spec) throw Object.assign(new Error(`unknown service: ${id}`), { status: 404 });
  const status = getServiceStatus(spec);
  if (status.readyState === 'stopped') {
    throw Object.assign(new Error(`${spec.label} is not running — start it first`), { status: 409 });
  }
  if (status.readyState !== 'ready') {
    throw Object.assign(new Error(`${spec.label} is ${status.readyState}`), { status: 503 });
  }
  return status.url;
}

export function servicesRouter(): Router {
  const r = Router();

  r.get('/services', (_req, res) => {
    res.json({ services: serviceSpecs().map(getServiceStatus) });
  });

  r.post('/services/:id/start', (req, res) => {
    try {
      const spec = serviceSpec(req.params.id);
      if (!spec) throw Object.assign(new Error('unknown service'), { status: 404 });
      // Apps have no weights; only models are gated on their files being present.
      if (spec.category === 'model' && !spec.modelPath) {
        throw Object.assign(new Error(`model files for ${spec.label} not found in any model directory`), { status: 400 });
      }
      res.json(startService(spec));
    } catch (err: any) {
      res.status(statusFor(err)).json({ error: String(err?.message ?? err) });
    }
  });

  r.post('/services/:id/stop', async (req, res) => {
    try {
      const spec = serviceSpec(req.params.id);
      if (!spec) throw Object.assign(new Error('unknown service'), { status: 404 });
      await stopService(spec.id);
      res.json(getServiceStatus(spec));
    } catch (err: any) {
      res.status(statusFor(err)).json({ error: String(err?.message ?? err) });
    }
  });

  // --- Uniform generation contract (proxied to the harness) ---

  r.post('/services/:id/generate', async (req, res) => {
    try {
      const url = readyUrl(req.params.id);
      const upstream = await fetch(`${url}/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.body ?? {}),
      });
      const json: any = await upstream.json().catch(() => ({}));
      if (!upstream.ok) throw Object.assign(new Error(json?.error ?? `upstream ${upstream.status}`), { status: 502 });
      res.status(202).json({ jobId: json.job_id });
    } catch (err: any) {
      res.status(statusFor(err)).json({ error: String(err?.message ?? err) });
    }
  });

  r.get('/services/:id/result', async (req, res) => {
    try {
      const url = readyUrl(req.params.id);
      const job = String(req.query.jobId ?? '');
      const upstream = await fetch(`${url}/result?job=${encodeURIComponent(job)}`);
      const json: any = await upstream.json().catch(() => ({}));
      if (!upstream.ok) throw Object.assign(new Error(json?.error ?? `upstream ${upstream.status}`), { status: 502 });
      res.json(json);
    } catch (err: any) {
      res.status(statusFor(err)).json({ error: String(err?.message ?? err) });
    }
  });

  // Stream the generated file back through our origin (keeps the model server
  // private, avoids CORS). The result `kind` drives how the UI renders it.
  r.get('/services/:id/file', async (req, res) => {
    try {
      const url = readyUrl(req.params.id);
      const job = String(req.query.jobId ?? '');
      const upstream = await fetch(`${url}/file?job=${encodeURIComponent(job)}`);
      if (!upstream.ok || !upstream.body) {
        throw Object.assign(new Error(`file fetch failed: ${upstream.status}`), { status: 502 });
      }
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream');
      const len = upstream.headers.get('content-length');
      if (len) res.setHeader('content-length', len);
      Readable.fromWeb(upstream.body as any).pipe(res);
    } catch (err: any) {
      res.status(statusFor(err)).json({ error: String(err?.message ?? err) });
    }
  });

  return r;
}
