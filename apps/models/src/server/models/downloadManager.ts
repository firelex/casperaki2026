import { randomUUID } from 'node:crypto';
import {
  downloadModelSnapshot,
  modelLibraryConfig,
  type LocalModel,
} from './modelLibrary.ts';

export type DownloadState = 'active' | 'done' | 'error' | 'canceled';

/**
 * A model-snapshot download. One job pulls every weight/config file of a
 * Hugging Face repo into a single model directory, so progress is tracked in
 * aggregate (bytes across all files) plus a file-level counter.
 */
export interface DownloadJob {
  id: string;
  repoId: string;
  /** File currently transferring, relative to the model dir. */
  currentFile: string | null;
  filesDone: number;
  filesTotal: number;
  bytesDownloaded: number;
  totalBytes: number | null;
  state: DownloadState;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  model: LocalModel | null;
}

const jobs = new Map<string, DownloadJob>();
const COMPLETED_TTL_MS = 10 * 60_000;

function prune(): void {
  const cutoff = Date.now() - COMPLETED_TTL_MS;
  for (const job of jobs.values()) {
    if (job.state === 'active') continue;
    if (job.completedAt && Date.parse(job.completedAt) < cutoff) jobs.delete(job.id);
  }
}

export function listDownloads(): DownloadJob[] {
  prune();
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Start (or resume) a snapshot download for a repo. Clicking download twice
 * while a transfer is live is a no-op — we return the in-flight job rather
 * than racing a second transfer on the same `.part` files.
 */
export function startModelDownload(repoId: string): DownloadJob {
  prune();
  for (const existing of jobs.values()) {
    if (existing.state === 'active' && existing.repoId === repoId) return existing;
  }

  const config = modelLibraryConfig();
  const job: DownloadJob = {
    id: randomUUID(),
    repoId,
    currentFile: null,
    filesDone: 0,
    filesTotal: 0,
    bytesDownloaded: 0,
    totalBytes: null,
    state: 'active',
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    model: null,
  };
  jobs.set(job.id, job);

  void (async () => {
    try {
      const model = await downloadModelSnapshot(repoId, (p) => {
        job.currentFile = p.currentFile;
        job.filesDone = p.filesDone;
        job.filesTotal = p.filesTotal;
        job.bytesDownloaded = p.bytesDownloaded;
        job.totalBytes = p.totalBytes;
      }, config);
      job.model = model;
      job.currentFile = null;
      job.filesDone = job.filesTotal;
      job.bytesDownloaded = model.sizeBytes;
      job.totalBytes = model.sizeBytes;
      job.state = 'done';
      job.completedAt = new Date().toISOString();
    } catch (err: any) {
      job.state = 'error';
      job.error = String(err?.message ?? err);
      job.completedAt = new Date().toISOString();
    }
  })();

  return job;
}
