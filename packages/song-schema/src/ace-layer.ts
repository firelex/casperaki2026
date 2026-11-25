// ACE layers (docs/superpowers/specs/2026-11-25-ace-layer-design.md): one extra instrument part that ACE-Step's
// "lego" task plays over the song as it is, stored per section like sung takes and played on an audio-only track
// named "ACE <Instrument>" ("ACE Guitar", a second one "ACE Guitar 2"). No node imports: browsers import this file.

/** The AI artifact kind of an ACE layer's section clip. */
export const ACE_LAYER_KIND = 'ace-step-conditioned';

/** The parts ACE lego can add (its track names; percussion and drums copy the song's own drums, bass and vocals
 *  are the song's own lanes). */
export const ACE_INSTRUMENTS = ['guitar', 'strings', 'brass', 'woodwinds', 'keyboard', 'synth', 'fx', 'backing_vocals', 'adlibs'] as const;
export type AceInstrument = (typeof ACE_INSTRUMENTS)[number];

export const ACE_INSTRUMENT_LABELS: Readonly<Record<AceInstrument, string>> = {
  guitar: 'Guitar',
  strings: 'Strings',
  brass: 'Brass',
  woodwinds: 'Woodwinds',
  keyboard: 'Keys',
  synth: 'Synth',
  fx: 'Effects',
  backing_vocals: 'Backing Vocals',
  adlibs: 'Ad-libs',
};

/** The plain description ACE is given for each part (the user's style words are added to it). */
export const ACE_INSTRUMENT_CAPTIONS: Readonly<Record<AceInstrument, string>> = {
  guitar: 'acoustic guitar',
  strings: 'warm string section',
  brass: 'brass section',
  woodwinds: 'woodwinds',
  keyboard: 'piano and keys',
  synth: 'synthesizer',
  fx: 'atmospheric sound effects',
  backing_vocals: 'backing vocals',
  adlibs: 'vocal ad-libs and runs answering the lead singer',
};

/** The engine instrument type an ACE layer's clips are mixed as (its level and effect sends in mix-config.json). */
export const ACE_MIX_TYPES: Readonly<Record<AceInstrument, string>> = {
  guitar: 'acousticGuitarsSteelStereo',
  strings: 'popHighStringsLegato',
  brass: 'popBrassBrightBrassSectionLegato',
  woodwinds: 'orchestralWoodwindsLegato',
  keyboard: 'keysAcousticPiano',
  synth: 'leadSynthsSoft',
  fx: 'fxAtmosphere',
  backing_vocals: 'vocalsLaSinger',
  adlibs: 'vocalsLaSinger',
};

/** Ad-libs (owner, 2026-11-25): sung by ACE on one of its singing tracks, with the user's words under every chorus,
 *  kept only in the song's final chorus(es). */
export const ACE_ADLIB_VOICES = ['backing_vocals', 'vocals'] as const;
export type AceAdlibVoice = (typeof ACE_ADLIB_VOICES)[number];
export const ACE_ADLIB_DEFAULT_WORDS = '(oh yeah)\n(ooh, ooh)\n(hey!)\n(come on)';
export const ACE_ADLIB_DEFAULT_STYLE = 'female soulful pop ad-libs, call and response';

/** The ACE track that plays a part: the instrument's own, except ad-libs (sung on the chosen voice's track). */
export function aceTrackOf(instrument: AceInstrument, voice: AceAdlibVoice | undefined): string {
  if (instrument === 'adlibs') {
    if (!voice) throw new Error('aceTrackOf: ad-libs need a voice (backing_vocals or vocals)');
    return voice;
  }
  if (voice) throw new Error(`aceTrackOf: only ad-libs take a voice, not ${instrument}`);
  return instrument;
}

/** The song's final chorus(es): the run of chorus sections at the end of the song (after the last section of another
 *  kind, intros and outros aside). Names, in order; empty when the song ends in no chorus. */
export function finalChoruses(sections: readonly string[]): string[] {
  const kind = (n: string) => (/^[A-Za-z]+/u.exec(n)?.[0] ?? n);
  const out: string[] = [];
  for (let i = sections.length - 1; i >= 0; i--) {
    const k = kind(sections[i]!);
    if (k === 'outro' && out.length === 0) continue;
    if (k !== 'chorus') break;
    out.unshift(sections[i]!);
  }
  return out;
}

/** The name a new ACE layer track takes: "ACE <Instrument>", numbered after the first when the name is taken. */
export function aceTrackName(instrument: AceInstrument, taken: readonly string[]): string {
  const base = `ACE ${ACE_INSTRUMENT_LABELS[instrument]}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} ${n}`)) return `${base} ${n}`;
}

/** The instrument of an ACE layer track ("ACE Guitar 2" → guitar), or undefined for any other track. */
export function aceInstrumentOfTrack(track: string): AceInstrument | undefined {
  const m = /^ACE (.+?)(?: \d+)?$/u.exec(track);
  if (!m) return undefined;
  return ACE_INSTRUMENTS.find((i) => ACE_INSTRUMENT_LABELS[i] === m[1]);
}
