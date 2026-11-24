// Export pattern-lab approvals into the pattern library (the repo's bank files)
// by hand. The brain does this itself on every review decision and commits the
// result (routes/patterns.ts); this script is for checking or repairing it.
//
//   cd apps/brain && set -a && . ~/.config/casperaki/brain.env && set +a
//   node_modules/.bin/tsx scripts/export-approved-patterns.ts [--dry-run]
//
// See exportApprovedPatterns (packages/arrangement) for what it writes.

import { exportApprovedPatterns } from '@casperaki/arrangement';

import { openSongsStore } from '../src/store.js';

const dryRun = process.argv.includes('--dry-run');
const dbPath = process.env.BRAIN_SONGS_DB_PATH;
if (!dbPath) throw new Error('BRAIN_SONGS_DB_PATH is not set: source brain.env first.');

const store = openSongsStore({ path: dbPath });
const approved = new Set(store.listPatternReviews().filter((r) => r.status === 'approved').map((r) => r.proposalId));
store.close();
const changes = exportApprovedPatterns(approved, { dryRun });
console.log(`${dryRun ? '[dry run] ' : ''}${approved.size} approved; ${changes.length ? changes.join('\n') : 'library already up to date'}`);
