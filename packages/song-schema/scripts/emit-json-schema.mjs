#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSongJsonSchema } from '../dist/json-schema/generate.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'dist', 'song.schema.json');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(generateSongJsonSchema(), null, 2) + '\n');
console.log(`[song-schema] wrote ${out}`);
