import type { Song } from '@casperaki/song-schema';

/**
 * What the detail window plays: one track's pattern in one section, as a
 * song of its own — only that track, no fills, transitions or other parts.
 * With `bars`, only the section's first `bars` bars (drums: the one bar the
 * engine repeats). Small, so the brain lowers it and the engine builds it
 * fast enough to hear an edit again within about a second.
 */
export function patternSong(
  song: Song,
  sectionName: string,
  track: string,
  opts: { bars?: number; overrideBars?: NonNullable<Song['arrangement'][string]['overrides'][string]['bars']> } = {},
): Song {
  const { bars } = opts;
  const seg = song.songStructure.find((s) => s.name === sectionName);
  if (!seg) throw new Error(`Section "${sectionName}" is not in the song.`);
  const payload = song.arrangement[sectionName];
  if (!payload) throw new Error(`Section "${sectionName}" has no arrangement.`);
  const override = payload.overrides?.[track];
  if (!override) throw new Error(`${track} does not play in ${sectionName}.`);
  const def = song.instrumentDefinitions.find((d) => d.name === track);
  if (!def) throw new Error(`${track} has no instrument definition.`);
  const length = bars ?? seg.lengthInBars ?? seg.bars.length;
  const { lengthInBars: _drop, ...segRest } = seg;
  const processors = payload.signalProcessors?.[track];
  return {
    ...song,
    songStructure: [{ ...segRest, bars: seg.bars.slice(0, length), ...(seg.lengthInBars !== undefined ? { lengthInBars: length } : {}) }],
    arrangement: {
      [sectionName]: {
        ...payload,
        instruments: { [track]: true },
        overrides: {
          [track]: {
            ...override,
            ...(opts.overrideBars ? { bars: opts.overrideBars } : override.bars ? { bars: override.bars.slice(0, length) } : {}),
          },
        },
        fills: {},
        mutes: {},
        transitions: {},
        signalProcessors: processors ? { [track]: processors } : {},
      },
    },
    instrumentDefinitions: [def],
    aiArtifacts: [],
  };
}

type SongBar = NonNullable<Song['arrangement'][string]['overrides'][string]['bars']>[number];

/** One drum bar (32nd steps per kit piece) as a song bar. The brain validates
 *  the song it is sent (parseSong), so the schema's brands are asserted here. */
export function drumBarNotes(pattern: ReadonlyMap<number, ReadonlySet<number>>): SongBar {
  const notes: Record<string, { note: number; type: 'note' }[]> = {};
  for (const [pitch, steps] of pattern) {
    for (const step of steps) {
      const beat = step / 8;
      const key = Number.isInteger(beat) ? beat.toFixed(1) : String(beat);
      (notes[key] ??= []).push({ note: pitch, type: 'note' });
    }
  }
  return { notes } as unknown as SongBar;
}

/**
 * One track across the whole song, as a song of its own (every section, only
 * that track, no fills or transitions): for the whole-track view, which asks
 * the engine for the notes it plays.
 */
export function trackSong(song: Song, track: string): Song {
  const def = song.instrumentDefinitions.find((d) => d.name === track);
  if (!def) throw new Error(`${track} has no instrument definition.`);
  const arrangement: Song['arrangement'] = {};
  for (const [name, payload] of Object.entries(song.arrangement)) {
    const override = payload.overrides?.[track];
    const processors = payload.signalProcessors?.[track];
    arrangement[name] = {
      ...payload,
      instruments: { [track]: payload.instruments?.[track] ?? false },
      overrides: override ? { [track]: override } : {},
      fills: {},
      mutes: {},
      transitions: {},
      signalProcessors: processors ? { [track]: processors } : {},
    };
  }
  return { ...song, arrangement, instrumentDefinitions: [def], aiArtifacts: [] };
}
