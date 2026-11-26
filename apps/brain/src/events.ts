// Events for the signed-in user's open pages: GET /api/events is a server-sent event stream (text/event-stream). An
// event goes to every stream its owner has open. A comment line every HEARTBEAT_MS keeps the stream alive through the
// Cloudflare tunnel in front of casperaki.com, which closes a connection idle for 100 seconds.
//
// Events are not stored: a page that was closed when one happened reads the state from the song again
// (GET /api/songs/:id), which carries it too.

import { Router, type Request } from 'express';

const HEARTBEAT_MS = 25_000;

export type BrainEvent =
  /** The song's artwork was drawn (GET /api/songs/:songId/artwork), or drawing it failed. */
  | { readonly type: 'artwork'; readonly state: 'done'; readonly songId: string }
  | { readonly type: 'artwork'; readonly state: 'failed'; readonly songId: string; readonly message: string }
  /** A background task started, has its result ready, was applied (a new version of the song), or failed
   *  (GET /api/tasks has the details). */
  | { readonly type: 'task'; readonly taskId: string; readonly songId: string | null; readonly state: 'running' | 'ready' | 'done' | 'failed' };

export class EventHub {
  private readonly streams = new Map<string, Set<(event: BrainEvent) => void>>();

  publish(owner: string, event: BrainEvent): void {
    for (const send of this.streams.get(owner) ?? []) send(event);
  }

  router(ownerOf: (req: Request) => string): Router {
    const router = Router();
    router.get('/api/events', (req, res) => {
      const owner = ownerOf(req);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(': connected\n\n');
      const send = (event: BrainEvent) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      const set = this.streams.get(owner) ?? new Set();
      set.add(send);
      this.streams.set(owner, set);
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS);
      heartbeat.unref();
      req.on('close', () => {
        clearInterval(heartbeat);
        set.delete(send);
        if (set.size === 0) this.streams.delete(owner);
      });
    });
    return router;
  }
}
