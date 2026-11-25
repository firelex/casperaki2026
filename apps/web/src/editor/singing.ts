import type { Song } from '@casperaki/song-schema';
import { SUNG_TAKE_KINDS, vocalTakeCanonical } from '@casperaki/song-schema/vocal-take-input';

import type { BackgroundTask } from '../api/tasks';

/** Whether the song has written lyrics (generator params: section → lines), as Sing needs them. */
export function lyricsWritten(song: { readonly generator?: { readonly params?: unknown } }): boolean {
  const lyrics = (song.generator?.params as { params?: { lyrics?: Record<string, readonly unknown[] | undefined> } } | undefined)?.params?.lyrics;
  return lyrics !== undefined && Object.values(lyrics).some((lines) => (lines?.length ?? 0) > 0);
}

/** The song's sung takes: artifacts of a sung kind attached to a section and an instrument. */
export function sungTakes(song: Pick<Song, 'aiArtifacts'>) {
  return song.aiArtifacts.filter(
    (a) => (SUNG_TAKE_KINDS as readonly string[]).includes(a.kind) && a.attachedTo.scope === 'segment' && a.attachedTo.instrument !== undefined,
  );
}

/** The key a take is looked up by: its instrument and section. */
export const takeKey = (instrument: string, segment: string): string => `${instrument}\u0000${segment}`;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The takes that were sung over something that has since changed (tempo, the section's chords, the track's notes
 * there): `takeKey(instrument, section)` of each. Same test as isTakeFresh in @casperaki/song-schema, hashed in the browser.
 */
export async function staleTakes(song: Song): Promise<Set<string>> {
  const stale = new Set<string>();
  for (const a of sungTakes(song)) {
    const at = a.attachedTo;
    if (at.scope !== 'segment' || at.instrument === undefined) throw new Error(`staleTakes: take "${a.id}" is not attached to a section and instrument`);
    const stored = a.conditioning?.hashes?.[0];
    if (stored === undefined) throw new Error(`staleTakes: take "${a.id}" has no conditioning.hashes[0] fingerprint`);
    if (stored !== (await sha256Hex(vocalTakeCanonical(song, at.segment, at.instrument)))) stale.add(takeKey(at.instrument, at.segment));
  }
  return stale;
}

export interface VocalMenuInput {
  /** Whether the vocal tracks show their melody. */
  readonly melodyShown: boolean;
  readonly lyricsWritten: boolean;
  readonly hasSungTakes: boolean;
  /** The song's sing task while it runs. */
  readonly singTask: BackgroundTask | undefined;
  /** The song's Write lyrics task while it runs or waits to go in. */
  readonly lyricsTask: BackgroundTask | undefined;
  /** The song's Transcribe melody task while it runs or waits to go in. */
  readonly transcribeTask: BackgroundTask | undefined;
}

export interface MenuState {
  readonly disabled: boolean;
  readonly hint: string;
}

export interface VocalMenu {
  readonly writeMelody: MenuState;
  readonly writeLyrics: MenuState;
  readonly sing: MenuState & { readonly label: 'Sing' | 'Sing again' };
  /** A recording the user brings of one section, back into the Vocal lane. */
  readonly transcribe: MenuState;
}

const ALREADY_SINGING = 'Already singing';

/** What the lead vocal's menu offers now, and why an item cannot be used. */
export function vocalMenu(i: VocalMenuInput): VocalMenu {
  const singing = i.singTask !== undefined;
  const writeMelody: MenuState = singing
    ? { disabled: true, hint: ALREADY_SINGING }
    : i.melodyShown
      ? { disabled: true, hint: 'written' }
      : { disabled: false, hint: '' };
  const writeLyrics: MenuState = singing
    ? { disabled: true, hint: ALREADY_SINGING }
    : !i.melodyShown
      ? { disabled: true, hint: 'write a melody first' }
      : i.lyricsTask?.state === 'running'
        ? { disabled: true, hint: 'already writing' }
        : i.lyricsTask?.state === 'ready'
          ? { disabled: true, hint: 'ready · goes in when you stop' }
          : { disabled: false, hint: 'in the background' };
  const label = i.hasSungTakes ? 'Sing again' : 'Sing';
  const sing: VocalMenu['sing'] = singing
    ? { label, disabled: true, hint: ALREADY_SINGING }
    : !i.melodyShown
      ? { label, disabled: true, hint: 'write a melody first' }
      : !i.lyricsWritten
        ? { label, disabled: true, hint: 'Write lyrics first' }
        : { label, disabled: false, hint: 'in the background' };
  const transcribe: MenuState = singing
    ? { disabled: true, hint: ALREADY_SINGING }
    : !i.melodyShown
      ? { disabled: true, hint: 'write a melody first' }
      : i.transcribeTask?.state === 'running'
        ? { disabled: true, hint: 'already transcribing' }
        : i.transcribeTask?.state === 'ready'
          ? { disabled: true, hint: 'ready · goes in when you stop' }
          : { disabled: false, hint: 'from a recording' };
  return { writeMelody, writeLyrics, sing, transcribe };
}

/** The sections a recording can be transcribed into: those with notes in the Vocal lane, in song order. */
export function transcribeSections(song: Pick<Song, 'songStructure' | 'arrangement'>): string[] {
  return song.songStructure
    .map((s) => s.name)
    .filter((name) =>
      (song.arrangement[name]?.overrides?.['Vocal']?.bars ?? []).some((b) =>
        Object.values(b.notes ?? {}).some((evs) => (evs ?? []).some((e) => (e as { type?: string }).type === 'vocalNote')),
      ),
    );
}

/** Bytes as base64 (a recording's upload body), in chunks so a large file does not overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) text += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(text);
}
