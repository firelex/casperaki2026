// A compact, plain-English picture of the song open in the editor, for the
// assistant's system prompt (rebuilt after every edit). Public names only.

import { trackOptions } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

import { drumKitView, transitionState } from '../routes/tracks.js';
import { soundCatalog } from '../sounds/soundCatalog.js';

const PLACE: Record<string, string> = { beginningOfSegment: 'start', midSegment: 'middle', endOfSegment: 'end' };

/** The chords of a section, bar by bar, with repeats of a bar's chord folded: "C | C G | Am | F". */
function chordLine(bars: Song['songStructure'][number]['bars']): string {
  return bars
    .map((b) => b.chords.filter((c, i) => i === 0 || c !== b.chords[i - 1]).join(' '))
    .join(' | ');
}

export function songSummary(song: Song, title: string): string {
  const lines: string[] = [];
  lines.push(`Title: ${title}. Style: ${song.genre ?? 'none'}. Key: ${song.key}. Tempo: ${song.bpm} BPM. 4 beats per bar.`);
  lines.push('Sections in order (name, bars, chords per bar):');
  for (const seg of song.songStructure) lines.push(`- ${seg.name} (${seg.lengthInBars ?? seg.bars.length} bars): ${chordLine(seg.bars)}`);

  const options = trackOptions(song);
  const sounds = soundCatalog().byId;
  lines.push('Tracks (name, kind, sound, sections where it plays):');
  for (const def of song.instrumentDefinitions) {
    const t = options.tracks[def.name];
    const sound = typeof def.id === 'string' ? sounds.get(def.id)?.name : undefined;
    const playsIn = song.songStructure.filter((s) => song.arrangement[s.name]?.instruments?.[def.name]).map((s) => s.name);
    lines.push(
      `- ${def.name}: ${t?.family ?? 'not editable'}${sound ? `, sound "${sound}"` : ''}${t && !t.editable ? ' (sound cannot be changed)' : ''}; plays in ${playsIn.length ? playsIn.join(', ') : 'no section'}`,
    );
  }

  const tr = transitionState(song);
  const withTransitions = Object.entries(tr.sections).filter(([, ts]) => ts.length);
  lines.push(withTransitions.length ? 'Transitions per section:' : 'Transitions: none.');
  for (const [seg, ts] of withTransitions) {
    lines.push(`- ${seg}: ${ts.map((t) => `${t.type} at the ${PLACE[t.placement] ?? t.placement}${t.soundName ? ` ("${t.soundName}")` : ''}`).join(', ')}`);
  }

  if (song.instrumentDefinitions.some((d) => d.name === 'Drums') && song.genre) {
    const kit = drumKitView(song).filter((k) => k.name);
    lines.push(`Drum kit (part: sound): ${kit.map((k) => `${k.label} (${k.role}): "${k.name}"${k.overridden ? ' [replaced by the user]' : ''}`).join('; ')}`);
  }
  return lines.join('\n');
}
