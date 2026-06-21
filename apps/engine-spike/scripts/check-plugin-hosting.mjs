#!/usr/bin/env node
// docs/57b — Plugin-hosting smoke driver.
//
// Runs the casperaki_plugin_smoke binary built by
// apps/engine-spike/native/CMakeLists.txt, parses its JSON output, and
// reports a human summary on stderr. Used by
// test/plugin-hosting-smoke.spec.ts to pin behaviour.
//
// Exit code: forwards the binary's exit code (0 = pass), 2 if the
// binary itself isn't built yet.
//
// Run:
//   node apps/engine-spike/scripts/check-plugin-hosting.mjs
//   CASPERAKI_PLUGIN_SMOKE_BIN=/abs/path node ... check-plugin-hosting.mjs

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const ARTEFACT_ROOT = resolve(
  REPO_ROOT,
  'apps/engine-spike/native/build/casperaki_plugin_smoke_artefacts',
);
// JUCE places the binary under <artefacts>/<CONFIG>/<TARGET>. The CMake
// generator defaults to Debug here; Release builds land alongside it.
const DEFAULT_BIN_CANDIDATES = [
  resolve(ARTEFACT_ROOT, 'Debug/casperaki_plugin_smoke'),
  resolve(ARTEFACT_ROOT, 'Release/casperaki_plugin_smoke'),
  resolve(ARTEFACT_ROOT, 'casperaki_plugin_smoke'),
];

const BIN =
  process.env.CASPERAKI_PLUGIN_SMOKE_BIN ??
  DEFAULT_BIN_CANDIDATES.find((p) => existsSync(p));

if (!BIN || !existsSync(BIN)) {
  console.error(
    `[plugin-smoke] binary not found. Tried:\n` +
      DEFAULT_BIN_CANDIDATES.map((p) => `  ${p}`).join('\n') +
      `\nBuild it with:\n` +
      `  cmake --build apps/engine-spike/native/build --target casperaki_plugin_smoke\n`,
  );
  process.exit(2);
}

const result = spawnSync(BIN, [], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});

if (result.stderr) process.stderr.write(result.stderr);

let json;
try {
  json = JSON.parse(result.stdout);
} catch (err) {
  console.error('[plugin-smoke] failed to parse JSON output:');
  console.error(result.stdout);
  process.exit(result.status ?? 1);
}

console.log(JSON.stringify(json, null, 2));
process.exit(result.status ?? 0);
