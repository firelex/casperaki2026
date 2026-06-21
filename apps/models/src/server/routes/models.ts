import { Router } from 'express';
import { z } from 'zod';
import {
  deleteModel,
  listHuggingFaceModel,
  listLocalModels,
  modelLibraryConfig,
} from '../models/modelLibrary.ts';
import { listDownloads, startModelDownload } from '../models/downloadManager.ts';

const DownloadInput = z.object({
  repoId: z.string().min(1),
});

const DeleteInput = z.object({
  path: z.string().min(1),
});

function statusFor(err: any): number {
  return typeof err?.status === 'number' ? err.status : 500;
}

export function modelsRouter(): Router {
  const r = Router();

  r.get('/models', async (_req, res) => {
    res.json(await listLocalModels());
  });

  r.get('/models/config', (_req, res) => {
    res.json(modelLibraryConfig());
  });

  // Inspect a Hugging Face repo: list the full-precision CUDA files we'd pull.
  r.get('/models/huggingface', async (req, res) => {
    try {
      const repo = z.string().min(1).parse(req.query.repo);
      res.json(await listHuggingFaceModel(repo));
    } catch (err: any) {
      res.status(statusFor(err)).json({ error: String(err?.message ?? err) });
    }
  });

  r.post('/models/download', (req, res) => {
    try {
      const input = DownloadInput.parse(req.body);
      const job = startModelDownload(input.repoId);
      res.status(202).json(job);
    } catch (err: any) {
      res.status(statusFor(err)).json({ error: String(err?.message ?? err) });
    }
  });

  r.get('/models/downloads', (_req, res) => {
    res.json({ downloads: listDownloads() });
  });

  r.delete('/models', async (req, res) => {
    try {
      const input = DeleteInput.parse(req.body);
      await deleteModel(input.path);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(statusFor(err)).json({ error: String(err?.message ?? err) });
    }
  });

  return r;
}
