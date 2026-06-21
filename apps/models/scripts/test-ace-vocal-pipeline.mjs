#!/usr/bin/env node
// Smoke test for the ACE vocal pipeline, one genre at a time.
//
//   node scripts/test-ace-vocal-pipeline.mjs <genre>
//   pnpm pipeline:ace-vocals:edm     # genre = edm
//   pnpm pipeline:ace-vocals:urban   # genre = urban
//
// Generates a vocal layer locked to the genre's backing track (ACE `lego`),
// isolates the vocal with SAM-Audio, and writes full.mp3 + vocals.wav under
// services/_serving/vocal-pipelines/<genre>-ace-smoke.
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PRESETS } from './vocal-presets.mjs';

const API = process.env.CASPERAKI_API ?? 'http://localhost:16400/api';
const genre = (process.argv[2] ?? 'edm').toLowerCase();
const preset = PRESETS[genre];
if (!preset) {
  console.error(`unknown genre '${genre}'. known: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}
const outDir = resolve(
  process.argv[3] ?? `services/_serving/vocal-pipelines/${genre}-ace-smoke`,
);

async function json(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.text();
  const parsed = body ? JSON.parse(body) : {};
  if (!res.ok) throw new Error(`${res.status} ${parsed.error ?? body}`);
  return parsed;
}

async function download(url, path) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  await mkdir(outDir, { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
}

console.log(`[${genre}] reference: ${preset.referencePath}`);
const started = await json('/vocal-generations/ace', {
  method: 'POST',
  body: JSON.stringify({ ...preset, separateVocals: true }),
});

console.log(`started ${started.id}`);
let job = started;
while (job.state === 'running') {
  await new Promise((r) => setTimeout(r, 5000));
  job = await json(`/vocal-generations/${started.id}`);
  console.log(`${new Date().toISOString()} ${job.state}`);
}
if (job.state !== 'done') throw new Error(job.error ?? 'pipeline failed');

for (const kind of ['full', 'vocals', 'no_vocals']) {
  if (!job.files?.[kind]) continue;
  const ext = kind === 'full' ? '.mp3' : '.wav';
  const target = join(outDir, `${kind}${ext}`);
  await download(`${API}/vocal-generations/${job.id}/file?kind=${kind}`, target);
  console.log(`${kind}: ${target}`);
}

console.log(`done: ${genre}-ace-smoke`);
