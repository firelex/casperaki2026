import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * A locally available model. Unlike a single-file GGUF, a CUDA / transformers
 * model is a *directory* holding sharded `*.safetensors` (or `*.bin`) weights
 * plus `config.json`, tokenizer files, etc. We therefore treat a model as the
 * directory that contains a `config.json`.
 */
export interface LocalModel {
  /** Stable id — the absolute directory path. */
  id: string;
  /** Human label, e.g. `Qwen/Qwen2.5-7B-Instruct` when we can recover it. */
  name: string;
  /** Absolute path to the model directory. */
  path: string;
  /** Which scanned root this was found under. */
  root: string;
  /** Path of the directory relative to its root. */
  relativePath: string;
  /** Sum of the sizes of the files in the directory. */
  sizeBytes: number;
  /** Number of files in the directory. */
  fileCount: number;
  /** Weight format detected in the directory. */
  format: 'safetensors' | 'pytorch' | 'gguf' | 'other';
  /** ISO timestamp of the most recently modified file in the directory. */
  modified: string;
}

/** A single file in a Hugging Face repo that we could download. */
export interface HuggingFaceFile {
  path: string;
  sizeBytes: number;
  downloadUrl: string;
  /** True for the weight files that make a model usable on CUDA. */
  isWeight: boolean;
}

export interface HuggingFaceModel {
  repoId: string;
  /** Folder name we'd download into, e.g. `Qwen__Qwen2.5-7B-Instruct`. */
  folder: string;
  files: HuggingFaceFile[];
  totalBytes: number;
  /** True if the repo only ships GGUF quants (nothing to download here). */
  ggufOnly: boolean;
}

export interface ModelLibraryConfig {
  roots: string[];
  downloadDir: string;
}

const DEFAULT_ROOTS = [
  '~/models',
  '~/Models',
  '~/.cache/huggingface/hub',
];

/** Extensions we download from HF (the "proper CUDA files"). */
const WEIGHT_EXT = ['.safetensors', '.bin', '.pt', '.pth'];
/** Broader set used only when detecting *already-downloaded* local models. */
const LOCAL_WEIGHT_EXT = ['.safetensors', '.bin', '.pt', '.pth', '.ckpt'];
/** Files that mark a directory as a model root even without a top-level weight. */
const MANIFEST_NAMES = ['config.json', 'model_index.json'];
/** Companion files that make a checkout runnable. We always grab these. */
const CONFIG_NAMES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'tokenizer.model',
  'special_tokens_map.json',
  'vocab.json',
  'merges.txt',
  'preprocessor_config.json',
  'model.safetensors.index.json',
  'pytorch_model.bin.index.json',
];

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function normalizePath(input: string): string {
  return resolve(expandHome(input.trim()));
}

/** Hugging Face hub cache directories, honoring HF_HOME / HUGGINGFACE_HUB_CACHE. */
function hfCacheRoots(): string[] {
  const roots: string[] = [];
  if (process.env.HUGGINGFACE_HUB_CACHE) roots.push(process.env.HUGGINGFACE_HUB_CACHE);
  if (process.env.HF_HOME) roots.push(join(expandHome(process.env.HF_HOME), 'hub'));
  return roots;
}

function configuredRoots(): string[] {
  const raw = process.env.CASPERAKI_MODEL_DIRS ?? '';
  const explicit = raw.split(',').map((v) => v.trim()).filter(Boolean);
  const base = explicit.length > 0 ? explicit : DEFAULT_ROOTS;
  // Always include the HF caches on top of the base list — they're where most
  // already-downloaded models live, and HF_HOME may relocate them off ~/.
  return [...base, ...hfCacheRoots()];
}

function unique(paths: string[]): string[] {
  return [...new Set(paths.map(normalizePath))];
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function canonicalRoots(paths: string[]): Promise<string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const canonical = await canonicalPath(path);
    const key = canonical.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(canonical);
  }
  return roots;
}

export function modelLibraryConfig(): ModelLibraryConfig {
  const downloadDir = normalizePath(process.env.CASPERAKI_DOWNLOAD_DIR ?? '~/models');
  const roots = unique([downloadDir, ...configuredRoots()]);
  return { roots, downloadDir };
}

function isWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!!rel && !rel.startsWith('..') && !rel.startsWith(sep) && !rel.includes(`..${sep}`));
}

/**
 * Guard for any path we're about to mutate (delete). Must resolve inside one
 * of the configured roots so a stray request can't `rm -rf` arbitrary paths.
 */
export function assertManagedModelPath(path: string, roots = modelLibraryConfig().roots): string {
  const resolved = normalizePath(path);
  if (!roots.some((root) => isWithinRoot(resolved, root))) {
    throw Object.assign(new Error('model is outside configured model directories'), { status: 400 });
  }
  return resolved;
}

function ext(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function detectFormat(filenames: string[]): LocalModel['format'] {
  const lower = filenames.map((n) => n.toLowerCase());
  if (lower.some((n) => n.endsWith('.safetensors'))) return 'safetensors';
  if (lower.some((n) => ['.bin', '.pt', '.pth', '.ckpt'].includes(ext(n)))) return 'pytorch';
  if (lower.some((n) => n.endsWith('.gguf'))) return 'gguf';
  return 'other';
}

/**
 * Recover a `owner/name` label from a model path. Handles our own
 * `owner__name` download folders and the HF cache layout, where the config
 * lives at `…/models--owner--name/snapshots/<commit>/` — so we walk up the
 * path for the `models--…` segment rather than using the leaf (a commit hash).
 */
function labelFromPath(fullPath: string): string {
  const parts = fullPath.split(sep).filter(Boolean);
  const hf = [...parts].reverse().find((p) => p.startsWith('models--'));
  if (hf) return hf.replace(/^models--/, '').replace(/--/g, '/');
  const leaf = parts[parts.length - 1] ?? fullPath;
  if (leaf.includes('__')) return leaf.replace(/__/g, '/');
  return leaf;
}

interface DirSummary {
  sizeBytes: number;
  fileCount: number;
  modifiedMs: number;
  names: string[];
}

/**
 * Recursively sum the files under a model directory. Composite models (e.g.
 * diffusion pipelines) keep their weights in subdirectories — `unet/`, `vae/`,
 * sub-models — so a non-recursive sum would under-report or miss them entirely.
 * Follows symlinks (the HF cache uses them); skips `.cache`/`blobs`/hidden dirs
 * and in-progress `.part` files.
 */
async function summarizeModelTree(root: string): Promise<DirSummary> {
  let sizeBytes = 0;
  let fileCount = 0;
  let modifiedMs = 0;
  const names: string[] = [];
  let dirs = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (dirs++ > 3000 || depth > 6) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === '.cache' || entry.name === 'blobs' || entry.name.startsWith('.')) continue;
        await walk(join(dir, entry.name), depth + 1);
        continue;
      }
      if (entry.name.endsWith('.part')) continue; // still downloading
      try {
        const info = await stat(join(dir, entry.name)); // follows symlinks
        if (!info.isFile()) continue;
        sizeBytes += info.size;
        fileCount += 1;
        modifiedMs = Math.max(modifiedMs, info.mtimeMs);
        names.push(entry.name);
      } catch {
        /* dangling symlink etc. — skip */
      }
    }
  }

  await walk(root, 0);
  return { sizeBytes, fileCount, modifiedMs, names };
}

/**
 * Scan the configured roots for model *directories*. A directory is a model
 * when it directly contains a `config.json` (the transformers convention).
 * Once we identify one we don't descend into it. The Hugging Face hub cache
 * keeps weights under `models--owner--name/snapshots/<commit>/`, which this
 * naturally finds.
 */
export async function listLocalModels(config = modelLibraryConfig()): Promise<{ roots: string[]; downloadDir: string; models: LocalModel[] }> {
  const models: LocalModel[] = [];
  const seen = new Set<string>();
  const roots = await canonicalRoots(config.roots);
  const downloadDir = await canonicalPath(config.downloadDir);
  let visitedDirs = 0;
  const maxDirs = Number(process.env.CASPERAKI_SCAN_MAX_DIRS ?? 12000);

  async function scanDir(dir: string, root: string, depth: number): Promise<void> {
    if (visitedDirs++ > maxDirs || depth > 8) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // A directory is a model root when it directly holds a manifest
    // (`config.json`/`model_index.json`/`*.index.json`) OR a weight file.
    // Match on name + "not a directory" rather than `isFile()` because the HF
    // hub cache stores these as symlinks (for which `isFile()` is false).
    const isModelRoot = entries.some((e) => {
      if (e.isDirectory()) return false;
      return (
        MANIFEST_NAMES.includes(e.name) ||
        e.name.endsWith('.index.json') ||
        LOCAL_WEIGHT_EXT.includes(ext(e.name))
      );
    });
    if (isModelRoot) {
      const canonical = await canonicalPath(dir);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      const summary = await summarizeModelTree(dir);
      // Skip metadata-only dirs (manifest/tokenizer but no weights anywhere).
      const hasWeights = summary.names.some((n) => LOCAL_WEIGHT_EXT.includes(ext(n)));
      if (hasWeights) {
        models.push({
          id: canonical,
          name: labelFromPath(canonical),
          path: canonical,
          root,
          relativePath: relative(root, canonical) || '.',
          sizeBytes: summary.sizeBytes,
          fileCount: summary.fileCount,
          format: detectFormat(summary.names),
          modified: new Date(summary.modifiedMs || Date.now()).toISOString(),
        });
      }
      return; // don't descend into a model directory
    }

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      if (entry.name === 'blobs' || entry.name.startsWith('.')) return;
      await scanDir(join(dir, entry.name), root, depth + 1);
    }));
  }

  for (const root of roots) {
    await scanDir(root, root, 0);
  }
  models.sort((a, b) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name));
  return { roots, downloadDir, models };
}

/**
 * For a model that lives in the HF hub cache, the listed path is the snapshot
 * directory (`…/models--owner--name/snapshots/<commit>`). Deleting just that
 * leaves the (huge) `blobs/` behind, so map it up to the `models--owner--name`
 * repo root, which removes blobs + refs + snapshots together. Returns null for
 * our own flat download folders (delete those as-is).
 */
function hfRepoRootFor(modelPath: string): string | null {
  const parts = modelPath.split(sep);
  const idx = parts.findIndex((p) => p.startsWith('models--'));
  if (idx >= 0 && parts[idx + 1] === 'snapshots') {
    return parts.slice(0, idx + 1).join(sep);
  }
  return null;
}

export async function deleteModel(path: string, config = modelLibraryConfig()): Promise<void> {
  const resolved = await canonicalPath(assertManagedModelPath(path, config.roots));
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw Object.assign(new Error('model path is not a directory'), { status: 400 });
  }
  // Delete the whole repo dir for cache models (blobs included), else the dir.
  const target = hfRepoRootFor(resolved) ?? resolved;
  // Re-validate the resolved target is inside a managed root.
  assertManagedModelPath(target, config.roots);
  // Refuse to delete a configured root itself.
  if (config.roots.some((r) => normalizePath(r) === target)) {
    throw Object.assign(new Error('refusing to delete a model root directory'), { status: 400 });
  }
  await rm(target, { recursive: true, force: true });
}

function repoFolder(repoId: string): string {
  return repoId.replace(/\//g, '__');
}

function normalizeRepoId(repoId: string): string {
  const id = repoId.trim().replace(/^https:\/\/huggingface\.co\//, '').replace(/\/+$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(id)) {
    throw Object.assign(new Error('use a Hugging Face repo id like owner/model'), { status: 400 });
  }
  return id;
}

let cachedFileToken: string | null | undefined;

/**
 * Token written by `huggingface-cli login` (default `~/.cache/huggingface/token`,
 * relocatable via HF_TOKEN_PATH or $HF_HOME/token). Read once and memoized — a
 * fresh login takes effect on the next server start, same as an env var.
 */
function hfTokenFromFile(): string | null {
  if (cachedFileToken !== undefined) return cachedFileToken;
  const candidates = [
    process.env.HF_TOKEN_PATH,
    process.env.HF_HOME ? join(expandHome(process.env.HF_HOME), 'token') : undefined,
    join(homedir(), '.cache', 'huggingface', 'token'),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      const t = readFileSync(p, 'utf8').trim();
      if (t) return (cachedFileToken = t);
    } catch { /* not present — try the next candidate */ }
  }
  return (cachedFileToken = null);
}

/** Prefer an explicit env token; otherwise fall back to the CLI login token. */
function hfToken(): string | undefined {
  return process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN ?? hfTokenFromFile() ?? undefined;
}

function hfHeaders(): Record<string, string> {
  const token = hfToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function resolveUrl(repoId: string, path: string, revision = 'main'): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${repoId}/resolve/${revision}/${encoded}`;
}

/**
 * List the files of a Hugging Face model repo as full-precision CUDA assets.
 * GGUF quants are excluded — this app downloads the proper safetensors/PyTorch
 * weights plus their config/tokenizer companions.
 */
export async function listHuggingFaceModel(repoId: string): Promise<HuggingFaceModel> {
  const id = normalizeRepoId(repoId);
  const response = await fetch(`https://huggingface.co/api/models/${id}?blobs=true`, { headers: hfHeaders() });
  if (!response.ok) {
    throw Object.assign(new Error(`Hugging Face lookup failed: HTTP ${response.status}`), { status: response.status === 404 ? 404 : 400 });
  }
  const data: any = await response.json();
  const siblings: any[] = Array.isArray(data?.siblings) ? data.siblings : [];
  const revision: string = typeof data?.sha === 'string' ? data.sha : 'main';

  let sawGguf = false;
  const files: HuggingFaceFile[] = [];
  for (const sib of siblings) {
    const path = String(sib?.rfilename ?? '');
    if (!path) continue;
    const e = ext(path);
    if (e === '.gguf') { sawGguf = true; continue; }
    const base = path.split('/').pop() ?? path;
    const isWeight = WEIGHT_EXT.includes(e);
    const isConfig = CONFIG_NAMES.includes(base);
    // Keep weights, configs, and small text companions (README/license). Skip
    // images and other large non-essential blobs to keep downloads lean.
    const keep = isWeight || isConfig || ['.txt', '.md', '.json', '.model'].includes(e);
    if (!keep) continue;
    files.push({
      path,
      sizeBytes: Number(sib?.size ?? 0),
      downloadUrl: resolveUrl(id, path, revision),
      isWeight,
    });
  }
  // Prefer safetensors: if the repo publishes safetensors weights, drop the
  // *redundant* full PyTorch dumps (pytorch_model*.bin / model*.bin and their
  // index) so we don't download the same model twice. Crucially, keep
  // auxiliary tensors like `silence_latent.pt` — those are NOT duplicates of
  // the model and are required at inference time.
  const isRedundantPytorch = (path: string): boolean => {
    const base = (path.split('/').pop() ?? '').toLowerCase();
    return /^(pytorch_model|model)([.\-].*)?\.bin$/.test(base) || base === 'pytorch_model.bin.index.json';
  };
  const hasSafetensors = files.some((f) => f.isWeight && ext(f.path) === '.safetensors');
  const pruned = hasSafetensors ? files.filter((f) => !isRedundantPytorch(f.path)) : files;

  pruned.sort((a, b) => Number(b.isWeight) - Number(a.isWeight) || a.path.localeCompare(b.path));
  const totalBytes = pruned.reduce((sum, f) => sum + f.sizeBytes, 0);
  return {
    repoId: id,
    folder: repoFolder(id),
    files: pruned,
    totalBytes,
    ggufOnly: pruned.filter((f) => f.isWeight).length === 0 && sawGguf,
  };
}

export interface SnapshotProgress {
  /** Path of the file currently transferring, relative to the model dir. */
  currentFile: string;
  filesDone: number;
  filesTotal: number;
  bytesDownloaded: number;
  totalBytes: number | null;
}

async function partialSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 0;
    throw err;
  }
}

function totalFromContentRange(value: string | null): number | null {
  if (!value) return null;
  const m = /\/(\d+)/.exec(value);
  return m ? Number(m[1]) : null;
}

/** Download one file with HTTP Range resume of a `.part` partial. */
async function downloadFile(
  url: string,
  destination: string,
  onBytes: (delta: number) => void,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const tmp = `${destination}.part`;
  const resumeFrom = await partialSize(tmp);

  const headers: Record<string, string> = { ...hfHeaders() };
  if (resumeFrom > 0) headers['Range'] = `bytes=${resumeFrom}-`;

  const response = await fetch(url, { redirect: 'follow', headers });

  if (response.status === 416 && resumeFrom > 0) {
    const total = totalFromContentRange(response.headers.get('content-range'));
    if (total !== null && total === resumeFrom) {
      await rename(tmp, destination);
      return;
    }
    await unlink(tmp).catch(() => {});
    return downloadFile(url, destination, onBytes);
  }

  if (!response.ok || !response.body) {
    throw Object.assign(new Error(`download failed: HTTP ${response.status}`), { status: 400 });
  }

  let appendMode = false;
  if (response.status === 206 && resumeFrom > 0) {
    appendMode = true;
    onBytes(resumeFrom);
  } else {
    await unlink(tmp).catch((err) => { if (err?.code !== 'ENOENT') throw err; });
  }

  const source = Readable.fromWeb(response.body as any);
  source.on('data', (chunk: Buffer) => onBytes(chunk.length));
  await pipeline(source, createWriteStream(tmp, { flags: appendMode ? 'a' : 'wx' }));
  await rename(tmp, destination);
}

/**
 * Download a full Hugging Face model snapshot (all weight + config files) into
 * `downloadDir/<owner>__<name>/`, preserving the repo's subdirectory layout.
 * Files transfer sequentially; per-file `.part` resume survives interruptions.
 */
export async function downloadModelSnapshot(
  repoId: string,
  onProgress: (p: SnapshotProgress) => void,
  config = modelLibraryConfig(),
): Promise<LocalModel> {
  const info = await listHuggingFaceModel(repoId);
  if (info.ggufOnly) {
    throw Object.assign(new Error(`${info.repoId} only ships GGUF quants — this app downloads full CUDA weights`), { status: 400 });
  }
  if (info.files.length === 0) {
    throw Object.assign(new Error(`no downloadable files found in ${info.repoId}`), { status: 400 });
  }

  const modelDir = assertManagedModelPath(join(config.downloadDir, info.folder), [config.downloadDir]);
  await mkdir(modelDir, { recursive: true });

  const totalBytes = info.totalBytes > 0 ? info.totalBytes : null;
  let bytesDownloaded = 0;
  let filesDone = 0;

  for (const file of info.files) {
    const destination = join(modelDir, ...file.path.split('/'));

    // Resume across interrupted snapshots: if this file already landed in full
    // (size matches what HF reported), skip it instead of re-downloading. Big
    // models are many shards — re-clicking a paused download must not re-pull
    // the gigabytes that already completed.
    if (file.sizeBytes > 0) {
      try {
        const existing = await stat(destination);
        if (existing.isFile() && existing.size === file.sizeBytes) {
          bytesDownloaded += file.sizeBytes;
          filesDone += 1;
          onProgress({ currentFile: file.path, filesDone, filesTotal: info.files.length, bytesDownloaded, totalBytes });
          continue;
        }
      } catch { /* not present yet — download it below */ }
    }

    onProgress({ currentFile: file.path, filesDone, filesTotal: info.files.length, bytesDownloaded, totalBytes });
    await downloadFile(file.downloadUrl, destination, (delta) => {
      bytesDownloaded += delta;
      onProgress({ currentFile: file.path, filesDone, filesTotal: info.files.length, bytesDownloaded, totalBytes });
    });
    filesDone += 1;
  }

  const summary = await summarizeModelTree(modelDir);
  return {
    id: modelDir,
    name: info.repoId,
    path: modelDir,
    root: config.downloadDir,
    relativePath: relative(config.downloadDir, modelDir) || '.',
    sizeBytes: summary.sizeBytes,
    fileCount: summary.fileCount,
    format: detectFormat(summary.names),
    modified: new Date(summary.modifiedMs || Date.now()).toISOString(),
  };
}
