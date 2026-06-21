// Signal processors — two legacy sources:
//
// 1. Per-segment Drums SP (legacy `drums.js#getArrangement` break/bridge
//    branch): picks one of `lowPassFilter*` tags per break / bridge segment.
//
// 2. Song-wide signal-effect rolls (legacy `ArrangementsClass.js:525-611`):
//    per-song `introEffect` / `verseEffect` / `preChorusEffect` / `outroEffect`
//    (fadeIn / fadeOut / lowPassFilter sweeps), genre-gated and segment-length
//    aware, applied across ALL (non-vocal) instruments of the matching segment
//    (legacy application loop `:856-944`).
//
// In both cases the legacy code hands the chosen tag to
// `EffectsClass.getEffect(...)` which expands it into per-32nd-note automation
// points. The brain-port stops at recording the legacy *tag* — the automation
// expansion is engine-bridge work (see docs/53k). The schema accepts a
// SignalProcessorBlock with just `type`; we emit that.

import type { SongStructure, SignalProcessorBlock } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import type { Rng } from '@casperaki/music-theory';
import type { SelectionResult } from '../selection/types.js';
import { loadArrangementRules, type SignalProcessorChoice } from './data.js';
import { segmentType } from './segment-type.js';

const DRUMS_DISPLAY_NAME = 'Drums';

// Genre gates for the song-wide rolls (legacy ArrangementsClass.js:525-611).
const FADE_GENRES = new Set(['ballad', 'latin', 'brightPop', 'organicVibes']);
const INTRO_LOWPASS_GENRES = new Set([
  'edm', 'latin', 'brightPop', 'organicVibes', 'schlager', 'urban',
]);
const VERSE_PRECHORUS_GENRES = new Set([
  'edm', 'latin', 'brightPop', 'organicVibes', 'rock', 'schlager', 'urban',
]);

interface SongEffects {
  intro?: string;
  verse?: string;
  preChorus?: string;
  outro?: string;
}

export interface ArrangementSignalProcessors {
  /** segment name → display-name → SignalProcessorBlock */
  readonly bySegment: Readonly<
    Record<string, Readonly<Record<string, SignalProcessorBlock>>>
  >;
}

export function generateSignalProcessors(
  ctx: GeneratorContext,
  structure: SongStructure,
  selection: SelectionResult,
): ArrangementSignalProcessors {
  const rules = loadArrangementRules();
  const rng = ctx.rng.fork('signalProcessors');

  const bySegment: Record<string, Record<string, SignalProcessorBlock>> = {};

  // (1) Drums break/bridge SP. Kept first so its RNG draws stay byte-stable.
  for (const segment of structure) {
    const type = segmentType(segment.name);
    const pool = rules.signalProcessors[type];
    if (!pool || pool.length === 0) continue;
    const choice = pickWeighted(rng, pool);
    if (!choice) continue;
    bySegment[segment.name] = {
      [DRUMS_DISPLAY_NAME]: { type: choice.type } as SignalProcessorBlock,
    };
  }

  // (2) Per-song signal-effect rolls + cross-instrument application.
  const effects = rollSongEffects(rng, ctx.params.genre, structure);
  applySongEffects(effects, structure, selection, bySegment);

  return { bySegment };
}

/** Length-in-bars of the first segment of a given type (legacy
 *  `Tools.getSegmentLengthInBars(...)[1]`). */
function segmentLengthInBars(structure: SongStructure, type: string): number | undefined {
  const seg = structure.find((s) => segmentType(s.name) === type);
  return seg ? seg.bars.length : undefined;
}

/** Port of the per-song effect rolls (legacy ArrangementsClass.js:525-611). */
function rollSongEffects(rng: Rng, genre: string, structure: SongStructure): SongEffects {
  const out: SongEffects = {};

  // introEffect — 1-in-4.
  if (rng.pick([false, false, false, true])) {
    const effects: string[] = [];
    if (FADE_GENRES.has(genre)) effects.push('fadeIn');
    if (INTRO_LOWPASS_GENRES.has(genre)) {
      effects.push('lowPassFilter700SweepUp', 'lowPassFilter1000SweepUp');
      const introLen = segmentLengthInBars(structure, 'intro');
      if (introLen !== undefined && introLen <= 4) {
        effects.push('lowPassFilter100SweepUp', 'lowPassFilter300SweepUp');
      }
    }
    if (effects.length > 0) out.intro = rng.pick(effects);
  }

  // verseEffect / preChorusEffect (mutually exclusive, legacy if/else-if). The
  // `&&` short-circuit matters: roll1 is only drawn when the intro isn't
  // already a lowPass sweep — faithfully replicated here.
  if (VERSE_PRECHORUS_GENRES.has(genre)) {
    const introIsLowPass = out.intro !== undefined && out.intro.includes('lowPass');
    if (!introIsLowPass && rng.pick([false, false, false, false, true])) {
      const effects = ['lowPassFilter700SweepUp', 'lowPassFilter1000SweepUp'];
      const verseLen = segmentLengthInBars(structure, 'verse');
      if (verseLen !== undefined && verseLen <= 4) {
        effects.push('lowPassFilter100SweepUp', 'lowPassFilter300SweepUp');
      }
      out.verse = rng.pick(effects);
    } else if (rng.pick([false, false, false, false, true])) {
      out.preChorus = rng.pick([
        'lowPassFilterSweepUp',
        'lowPassFilter100SweepUp',
        'lowPassFilter300SweepUp',
        'lowPassFilter700SweepUp',
        'lowPassFilter1000SweepUp',
      ]);
    }
  }

  // outroEffect — 1-in-4.
  if (FADE_GENRES.has(genre) && rng.pick([false, false, false, true])) {
    out.outro = 'fadeOut';
  }

  return out;
}

/**
 * Apply the rolled song-wide effect to every (non-vocal) active lane of the
 * matching segment (legacy `:856-944`): introEffect → all `intro` segments,
 * verseEffect → `verse1` only, preChorusEffect → all `preChorus`, outroEffect
 * → all `outro`. Vocal lanes are emitted by a separate generator and are not
 * in `activeLanes`, so they're naturally excluded (legacy skips the vocal
 * names explicitly).
 */
function applySongEffects(
  effects: SongEffects,
  structure: SongStructure,
  selection: SelectionResult,
  bySegment: Record<string, Record<string, SignalProcessorBlock>>,
): void {
  const activeByName = new Map(
    selection.segments.map((s) => [s.segmentName, s.activeLanes]),
  );
  for (const segment of structure) {
    const type = segmentType(segment.name);
    let effect: string | undefined;
    if (type === 'intro') effect = effects.intro;
    else if (segment.name === 'verse1') effect = effects.verse;
    else if (type === 'preChorus') effect = effects.preChorus;
    else if (type === 'outro') effect = effects.outro;
    if (!effect) continue;

    const target = (bySegment[segment.name] ??= {});
    for (const lane of activeByName.get(segment.name) ?? []) {
      target[lane] = { type: effect } as SignalProcessorBlock;
    }
  }
}

function pickWeighted(
  rng: Rng,
  pool: readonly SignalProcessorChoice[],
): SignalProcessorChoice | undefined {
  // Expand the weighted choices into a flat pool; same semantic as the
  // legacy `Tools.selectRandomly([ 'lowPassFilter', 'lowPassFilter',
  // 'lowPassFilter', 'lowPassFilterSweepUp', ... ])` arrays.
  const flat: SignalProcessorChoice[] = [];
  for (const choice of pool) {
    for (let i = 0; i < choice.weight; i++) flat.push(choice);
  }
  if (flat.length === 0) return undefined;
  return flat[rng.int(0, flat.length - 1)];
}
