// Per-segment mutes — currently a stub.
//
// The legacy `drums.js#getArrangement` mute branch is gated by
// `if ( muteInAnySegmentUsedAlready === undefined )`, but the same
// variable is initialised to `false` a few lines earlier, so the legacy
// branch is dead code: no segment ever receives a `mutes.Drums` entry in
// practice. The brain port preserves that observable behaviour and
// records the legacy intent here so a future PR can either fix the legacy
// bug forward (intentional pick) or import a corrected per-genre table.
//
// `generateMutes` therefore returns no entries today. The fork salt is
// still claimed so a future implementation can sample without shifting
// any other family's stream (per the determinism contract in 53k).

import type { SongStructure, MuteEntry } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import type { SelectionResult } from '../selection/types.js';

export interface ArrangementMutes {
  /** segment name → display-name → MuteEntry */
  readonly bySegment: Readonly<Record<string, Readonly<Record<string, MuteEntry>>>>;
}

export function generateMutes(
  ctx: GeneratorContext,
  _structure: SongStructure,
  _selection: SelectionResult,
): ArrangementMutes {
  // Claim the fork salt up-front so adding mute logic later cannot shift
  // any sibling family's stream.
  ctx.rng.fork('mutes');
  return { bySegment: {} };
}
