#!/usr/bin/env node
// Phase 2 spike — minimal HTTP server that satisfies the engine's sample
// fetcher (SamplesDownloadTask::iterativeRun in casperaki_engine).
//
// The engine builds URLs like:
//   <baseURL>/playSample/<id>?format=ogg
// and writes the response bytes to a temp .ogg file. This server answers any
// id with a pre-generated OGG tone, mapped by id where possible.
//
// Usage:
//   node sample-stub-server.mjs [--port 8080] [--samples ../samples]
//
// IDs we know about (from emit-minimal-drums.mjs) get a specific tone:
//   bassDrum1 → kick.ogg, snareDrum1 → snare.ogg, hiHatClosed1 → hat.ogg.
// Anything else falls back to tone.ogg.

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, v, i, arr) => {
    if (v.startsWith('--')) acc.push([v.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const PORT = Number(args.port ?? 8080);
const SAMPLES = resolve(__dirname, args.samples ?? '../samples');

// id-keyed mapping. Trim-script logs the IDs you need to stage.
const ID_MAP = new Map([
  ['26949', 'kick.ogg'],   // bassDrum1 (web-tester fixture)
  ['27350', 'hat.ogg'],    // hiHatClosed1
  ['27175', 'snare.ogg'],  // snareDrum1
]);

function pickFile(id) {
  const named = ID_MAP.get(id);
  if (named && existsSync(resolve(SAMPLES, named))) return resolve(SAMPLES, named);
  return resolve(SAMPLES, 'tone.ogg');
}

const sentLog = new Map();

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    // GET /playSample/<id>?format=ogg
    const m = url.pathname.match(/^\/playSample\/(\d+)\/?$/);
    if (req.method === 'GET' && m) {
      const id = m[1];
      const file = pickFile(id);
      const bytes = readFileSync(file);
      res.writeHead(200, {
        'content-type': 'audio/ogg',
        'content-length': bytes.length,
      });
      res.end(bytes);
      const k = `${id}→${file.split('/').pop()}`;
      sentLog.set(k, (sentLog.get(k) ?? 0) + 1);
      console.log(`[stub] 200 GET /playSample/${id} → ${file.split('/').pop()} (${bytes.length} bytes)`);
      return;
    }
    // POST /vstSample/load/ — bass/synth ZIP-batch path (out of scope for
    // this proof; respond with empty zip so the engine doesn't hang).
    if (req.method === 'POST' && url.pathname.startsWith('/vstSample/load')) {
      // Minimal empty ZIP: PK\x05\x06 + 18 zero bytes
      const emptyZip = Buffer.from([
        0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': emptyZip.length,
      });
      res.end(emptyZip);
      console.log(`[stub] 200 POST ${url.pathname} → empty.zip`);
      return;
    }
    res.writeHead(404).end(`stub: no handler for ${req.method} ${url.pathname}`);
    console.log(`[stub] 404 ${req.method} ${url.pathname}`);
  } catch (err) {
    res.writeHead(500).end(String(err));
    console.error(`[stub] 500: ${err}`);
  }
});

process.on('SIGINT', () => {
  console.log('\n[stub] summary:');
  for (const [k, v] of [...sentLog.entries()].sort()) console.log(`  ${v}× ${k}`);
  server.close(() => process.exit(0));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stub] listening on http://127.0.0.1:${PORT}, samples=${SAMPLES}`);
});
