import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelLibraryConfig } from '../models/modelLibrary.ts';
import type { ServiceSpec } from './serviceManager.ts';

const PACKAGE_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const SERVICES_DIR = join(PACKAGE_ROOT, 'services');
const HARNESS = join(SERVICES_DIR, '_serving', 'harness.py');

/** Each servable model/app = one harness adapter. Add a row to register one. */
interface AdapterDef {
  id: string;
  label: string;
  description: string;
  kind: 'audio' | 'video' | 'image';
  /**
   * 'model' (default) serves downloaded weights — start is gated on the files
   * being present. 'app' is a tool with no weights (e.g. Matchering) — it has
   * no model folder and can always start.
   */
  category?: 'model' | 'app';
  /** Local model folder name (under a model root) this adapter serves. Apps omit it. */
  modelFolder?: string;
  /**
   * Filename inside `modelFolder` whose presence means the weights are on disk.
   * Defaults to `config.json` (the transformers convention), but some repos
   * ship bare checkpoints (just a weights file).
   */
  modelMarker?: string;
  port: number;
}

const ADAPTERS: AdapterDef[] = [
  {
    id: 'ace-step',
    label: 'ACE-Step 1.5',
    description: 'Text-to-music generation (prompt + optional lyrics → audio).',
    kind: 'audio',
    modelFolder: 'ACE-Step__Ace-Step1.5',
    // NB: the ACE adapter also runs its internal acestep-api on port+1 (16501),
    // so 16501 is reserved — keep other services off it.
    port: 16500,
  },
  {
    id: 'sam-audio',
    label: 'SAM-Audio',
    description: 'Sound separation — isolate any sound from a mix by text prompt.',
    kind: 'audio',
    modelFolder: 'facebook__sam-audio-large',
    // 16501 is taken by ACE's internal server; use 16505 so both can run at once.
    port: 16505,
  },
  {
    id: 'matchering',
    label: 'Matchering',
    description: 'Master a track to match a reference’s loudness, tone and dynamics.',
    kind: 'audio',
    category: 'app', // pure DSP, no weights to download
    port: 16503,
  },
  {
    id: 'hum',
    label: 'Hum transcription',
    description: 'Beats, key and notes from a hummed or sung recording (hum to song). POST /transcribe.',
    kind: 'audio',
    // Its weights are training runs on /mnt/d (hum-beats, hum-pitch), not a downloaded model folder.
    category: 'app',
    port: 16510,
  },
  {
    id: 'amt',
    label: 'Melody completion (AMT)',
    description: 'Fill the missing bars of a hummed melody over chords (Anticipatory Music Transformer). POST /complete.',
    kind: 'audio',
    modelFolder: 'stanford-crfm__music-medium-800k',
    port: 16511,
  },
];

function basePython(): string {
  return process.env.CASPERAKI_PYTHON ?? 'python3';
}

/** Find a model folder among the configured roots, keyed off a marker file. */
function findModelDir(folder: string, marker: string): { modelsRoot: string; path: string } | null {
  const { roots } = modelLibraryConfig();
  for (const root of roots) {
    if (existsSync(join(root, folder, marker))) return { modelsRoot: root, path: join(root, folder) };
  }
  return null;
}

function specFor(def: AdapterDef): ServiceSpec {
  const category = def.category ?? 'model';
  // Apps have no weights; models resolve their folder among the scan roots.
  const found = def.modelFolder ? findModelDir(def.modelFolder, def.modelMarker ?? 'config.json') : null;
  const modelsRoot = found?.modelsRoot ?? modelLibraryConfig().downloadDir;
  return {
    id: def.id,
    label: def.label,
    description: def.description,
    category,
    cwd: SERVICES_DIR,
    command: basePython(),
    args: [HARNESS, '--adapter', def.id, '--port', String(def.port), '--models-dir', modelsRoot],
    env: { HOME: homedir() },
    port: def.port,
    healthPath: '/health',
    // Apps are always startable; models report null until their files are found.
    modelPath: category === 'app' ? null : (found?.path ?? null),
  };
}

export function serviceSpecs(): ServiceSpec[] {
  return ADAPTERS.map(specFor);
}

export function serviceSpec(id: string): ServiceSpec | undefined {
  const def = ADAPTERS.find((a) => a.id === id);
  return def ? specFor(def) : undefined;
}
