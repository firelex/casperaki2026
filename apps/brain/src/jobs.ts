// Long requests as jobs. casperaki.com reaches the brain through a Cloudflare tunnel, which ends any request that
// has not been answered within 100 seconds; writing lyrics takes up to a few minutes. A client that sends
// `Prefer: respond-async` (RFC 7240) to a job route gets 202 { jobId } at once, and polls GET /api/jobs/:id until it
// answers { done: true, status, body }: the status and body the route would have answered directly. Without the
// header a route answers as usual.
//
// Jobs live in memory, belong to the owner who started them, and are forgotten KEEP_MS after they finish.

import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

const KEEP_MS = 15 * 60_000;

interface Job {
  readonly owner: string;
  result?: { status: number; body: unknown };
}

export interface Jobs {
  /** Middleware for a route that may run as a job. */
  readonly asJob: RequestHandler;
  /** GET /api/jobs/:id */
  readonly router: Router;
}

export function createJobs(ownerOf: (req: Request) => string): Jobs {
  const jobs = new Map<string, Job>();

  const asJob: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (!/\brespond-async\b/iu.test(req.get('prefer') ?? '')) return next();
    const id = randomUUID();
    const job: Job = { owner: ownerOf(req) };
    jobs.set(id, job);
    res.status(202).json({ jobId: id });
    // The route answers into the job from here on: status() and json() are caught, nothing more is sent.
    let status = 200;
    const finish = (body: unknown) => {
      job.result = { status, body };
      setTimeout(() => jobs.delete(id), KEEP_MS).unref();
      return res;
    };
    res.status = ((code: number) => {
      status = code;
      return res;
    }) as Response['status'];
    res.json = finish as Response['json'];
    res.send = finish as Response['send'];
    res.end = (() => {
      if (!job.result) finish(undefined);
      return res;
    }) as Response['end'];
    next();
  };

  const router = Router();
  router.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.owner !== ownerOf(req)) return res.status(404).json({ error: 'not_found', message: 'No such job (it may have finished long ago).' });
    if (!job.result) return res.json({ done: false });
    return res.json({ done: true, status: job.result.status, body: job.result.body });
  });

  return { asJob, router };
}
