import 'dotenv/config';
import 'express-async-errors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { modelsRouter } from './routes/models.ts';
import { servicesRouter } from './routes/services.ts';
import { vocalGenerationsRouter } from './routes/vocalGenerations.ts';
import { adoptExisting } from './services/serviceManager.ts';
import { serviceSpecs } from './services/registry.ts';

const PORT = Number(process.env.CASPERAKI_PORT ?? 16400);

function createApp() {
  const app = express();
  // 64mb: generation requests may carry a base64-encoded reference track.
  app.use(express.json({ limit: '64mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, name: 'casperaki', service: 'music-production-api' });
  });

  app.use('/api', modelsRouter());
  app.use('/api', servicesRouter());
  app.use('/api', vocalGenerationsRouter());

  // JSON error envelope so the web client always gets `{ error }`.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    if (status >= 500) console.error('[casperaki] unhandled error:', err);
    res.status(status).json({ error: String(err?.message ?? err) });
  });

  return app;
}

createApp().listen(PORT, () => {
  console.log(`[casperaki] API listening on http://localhost:${PORT}`);
  // Re-adopt any model server still running from a previous app process so a
  // web-app restart doesn't relaunch (and re-load) it.
  try {
    adoptExisting(serviceSpecs());
  } catch (err) {
    console.error('[casperaki] service adoption failed:', err);
  }
});
