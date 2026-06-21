const BASE = '/api';

export class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`${status} ${body}`);
    this.status = status;
    this.body = body;
  }
  /** Best-effort extraction of `{ error: "..." }`, falling back to raw body. */
  get serverMessage(): string {
    try {
      const j = JSON.parse(this.body);
      if (j && typeof j.error === 'string') return j.error;
    } catch { /* not json */ }
    return this.body || `HTTP ${this.status}`;
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json() as Promise<T>;
}

export interface LocalModel {
  id: string;
  name: string;
  path: string;
  root: string;
  relativePath: string;
  sizeBytes: number;
  fileCount: number;
  format: 'safetensors' | 'pytorch' | 'gguf' | 'other';
  modified: string;
}

export interface HuggingFaceFile {
  path: string;
  sizeBytes: number;
  downloadUrl: string;
  isWeight: boolean;
}

export interface HuggingFaceModel {
  repoId: string;
  folder: string;
  files: HuggingFaceFile[];
  totalBytes: number;
  ggufOnly: boolean;
}

export type DownloadState = 'active' | 'done' | 'error' | 'canceled';

export interface DownloadJob {
  id: string;
  repoId: string;
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

export interface ModelsResponse {
  roots: string[];
  downloadDir: string;
  models: LocalModel[];
}

export type ReadyState = 'stopped' | 'starting' | 'ready' | 'error';

export interface ServiceStatus {
  id: string;
  label: string;
  description: string;
  category: 'model' | 'app';
  port: number;
  url: string;
  modelPath: string | null;
  readyState: ReadyState;
  pid: number | null;
  startedAt: string | null;
  error: string | null;
  logTail: string[];
}

export interface JobResult {
  state: 'running' | 'done' | 'error';
  kind: 'audio' | 'video' | 'image' | 'file' | null;
  error: string | null;
}

export const api = {
  services: {
    list: () => req<{ services: ServiceStatus[] }>('/services'),
    start: (id: string) => req<ServiceStatus>(`/services/${id}/start`, { method: 'POST' }),
    stop: (id: string) => req<ServiceStatus>(`/services/${id}/stop`, { method: 'POST' }),
    generate: (id: string, params: Record<string, unknown>) =>
      req<{ jobId: string }>(`/services/${id}/generate`, { method: 'POST', body: JSON.stringify(params) }),
    result: (id: string, jobId: string) =>
      req<JobResult>(`/services/${id}/result?jobId=${encodeURIComponent(jobId)}`),
    /** Origin-proxied URL for a finished job's output file (usable in <audio>/<video>/<img>). */
    fileUrl: (id: string, jobId: string) => `/api/services/${id}/file?jobId=${encodeURIComponent(jobId)}`,
  },
  models: {
    list: () => req<ModelsResponse>('/models'),
    huggingFaceModel: (repo: string) =>
      req<HuggingFaceModel>(`/models/huggingface?repo=${encodeURIComponent(repo)}`),
    download: (repoId: string) =>
      req<DownloadJob>('/models/download', { method: 'POST', body: JSON.stringify({ repoId }) }),
    listDownloads: () => req<{ downloads: DownloadJob[] }>('/models/downloads'),
    delete: (path: string) =>
      req<{ ok: true }>('/models', { method: 'DELETE', body: JSON.stringify({ path }) }),
  },
};
