// The song assistant's tools: everything the Song tab lets a user do, run on
// the brain's working copy of the open song. Edits reuse the editor's own code
// (arrangement editTrack / addSection / setTransition and the @casperaki/song-edit
// reducer), so the assistant can change exactly what the user can, no more.
// Playback and page actions (play, mute, save, undo …) come back as a
// ClientAction the page carries out.

import { addSection, editTrack, InstrumentFamilySchema, SECTION_TYPES, setTransition, trackOptions, TRANSITION_TYPES } from '@casperaki/arrangement';
import { applyCommand, initEditState, type EditCommand } from '@casperaki/song-edit';
import type { Song } from '@casperaki/song-schema';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { drumKitView, transitionState } from '../routes/tracks.js';
import { searchSounds, soundCatalog } from '../sounds/soundCatalog.js';
import { songSummary } from './summary.js';

/** What the page does for a tool that is not a song edit. */
export type ClientAction =
  | { kind: 'play'; fromSection?: string }
  | { kind: 'stop' }
  | { kind: 'loop'; section: string }
  | { kind: 'mute' | 'unmute' | 'solo' | 'unsolo'; track: string }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'save' }
  | { kind: 'renameSong'; title: string }
  | { kind: 'export' }
  | { kind: 'openTab'; tab: 'sound' | 'timeline' | 'video' };

/** Every tool result: what happened in plain words, the full new song when it changed, or a page action. */
export interface ToolResult {
  readonly summary: string;
  readonly song?: Song;
  readonly action?: ClientAction;
}

/** A tool's refusal (unknown section, wrong sound …): sent to the model as a tool error it can recover from. */
export class ToolError extends Error {}

interface ToolContext {
  song: Song;
  readonly title: string;
}

interface ToolDef<S extends z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly params: S;
  run(args: z.infer<S>, ctx: ToolContext): ToolResult;
}

const tool = <S extends z.ZodTypeAny>(def: ToolDef<S>) => def;

// Engine drum parts → General MIDI notes, as the engine adapter maps them (the pedal hi-hat is not played).
const DRUM_PITCH: Readonly<Record<string, number>> = {
  bassDrum1: 36, bassDrum2: 35, snareDrum1: 38, snareDrum2: 40, clap: 39, snap: 31,
  hiHatClosed1: 42, hiHatClosed2: 44, hiHatOpen: 46, ride: 51, crash1: 49, crash2: 57,
  shaker: 70, tom1: 50, tom2: 47, tom3: 43,
};

/** A sound's public name for the model's summaries ("Blasting Stomp"), from the library the search uses. */
const soundName = (id: string) => {
  const item = soundCatalog().byId.get(id);
  if (!item) throw new Error(`sound ${id} was accepted by the edit but is not in the sound library`);
  return `"${item.name}"`;
};

const sectionNames = (song: Song) => song.songStructure.map((s) => s.name);
const requireSection = (song: Song, name: string) => {
  if (!sectionNames(song).includes(name)) throw new ToolError(`The song has no section "${name}". Sections: ${sectionNames(song).join(', ')}.`);
};
const requireTrack = (song: Song, name: string) => {
  if (!song.instrumentDefinitions.some((d) => d.name === name)) {
    throw new ToolError(`The song has no track "${name}". Tracks: ${song.instrumentDefinitions.map((d) => d.name).join(', ')}.`);
  }
};

/** Run a @casperaki/song-edit command on the song; its refusal becomes a ToolError. */
function songEdit(song: Song, command: EditCommand): Song {
  const next = applyCommand(initEditState(song), command);
  if (next.lastError) throw new ToolError(next.lastError);
  return next.working;
}

/** Run an arrangement edit; its TrackEditError (a refusal with a reason) becomes a ToolError. */
function arrangementEdit<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && err.name === 'TrackEditError') throw new ToolError(err.message);
    throw err;
  }
}

const edited = (ctx: ToolContext, song: Song, summary: string): ToolResult => {
  ctx.song = song;
  return { summary, song };
};

const Placement = z.enum(['beginningOfSegment', 'midSegment', 'endOfSegment']).describe('Where in the section: its start, middle or end.');

export const TOOLS = [
  // ---- reading ----
  tool({
    name: 'get_song',
    description: 'The open song as it is now: style, key, tempo, sections with chords, tracks with their sounds, transitions and the drum kit.',
    params: z.object({}).strict(),
    run: (_a, ctx) => ({ summary: songSummary(ctx.song, ctx.title) }),
  }),
  tool({
    name: 'get_track_options',
    description: 'Each track with its kind and whether its sound can be changed, and per kind the sounds this style offers (name and id).',
    params: z.object({}).strict(),
    run: (_a, ctx) => {
      const o = trackOptions(ctx.song);
      const tracks = Object.entries(o.tracks).map(([name, t]) => `${name}: ${t.family ?? 'not editable'}${t.editable ? '' : ' (fixed)'}`);
      const families = o.families.map((f) => `${f.family} (${f.label}): ${f.sounds.slice(0, 40).map((s) => `"${s.name}" [${s.id}]`).join(', ')}`);
      return { summary: `Tracks:\n${tracks.join('\n')}\nSounds offered per kind:\n${families.join('\n')}` };
    },
  }),
  tool({
    name: 'search_sounds',
    description:
      'Search the sound library by words (name, type, style). Give transition (a transition type) for transition sounds, useAs (a track kind such as keys, bass, pad, guitar, synths) to find sounds for a track, or family for drum hits (kickDrums, snareDrums, clapsSnaps, hiHatsClosed, hiHatsOpen, cymbals, toms, shakers, percussionMisc). Returns names with ids; always use an id from here.',
    params: z
      .object({
        query: z.string().optional().describe('Words to look for, e.g. "warm piano" or "808".'),
        useAs: InstrumentFamilySchema.optional(),
        family: z.string().optional(),
        transition: z.string().optional().describe('A transition type (e.g. riser, downlifter) to list the sounds that transition can play.'),
        style: z.string().optional().describe('A style such as brightPop, edm, latin, urban, ballad, rock.'),
        limit: z.number().int().min(1).max(30).default(12),
      })
      .strict(),
    run: (a) => {
      const found = searchSounds({
        ...(a.family ? { family: a.family } : {}),
        ...(a.useAs ? { useAs: a.useAs } : {}),
        ...(a.transition ? { transition: a.transition } : {}),
        ...(a.query ? { q: a.query } : {}),
        ...(a.style ? { style: a.style } : {}),
        cursor: 0,
        limit: a.limit,
      });
      if (found.items.length === 0) return { summary: 'No sound matches. Try fewer or other words.' };
      return {
        summary: `${found.total} sounds match; the first ${found.items.length}:\n${found.items
          .map((s) => `"${s.name}" [${s.id}] — ${s.familyLabel}, ${s.type}${s.styles.length ? `, ${s.styles.join('/')}` : ''}`)
          .join('\n')}`,
      };
    },
  }),
  tool({
    name: 'get_transitions',
    description: 'The transitions (risers, impacts, reverses, crashes, fills, snare rolls) of one section or all, with their sounds, and the transition types there are.',
    params: z.object({ section: z.string().optional() }).strict(),
    run: (a, ctx) => {
      if (a.section) requireSection(ctx.song, a.section);
      const st = transitionState(ctx.song);
      const secs = Object.entries(st.sections).filter(([name]) => !a.section || name === a.section);
      const types = st.types.map((t) => `${t.type} (${t.label}; ${t.placements.join('/')}${t.swappable ? '' : '; no sound choice'})`);
      return {
        summary: `${secs.map(([name, ts]) => `${name}: ${ts.length ? ts.map((t) => `${t.type} at ${t.placement}${t.soundName ? ` ("${t.soundName}" [${t.soundId ?? 'chosen when played'}])` : ''}`).join(', ') : 'none'}`).join('\n')}\nTypes: ${types.join('; ')}`,
      };
    },
  }),
  tool({
    name: 'get_drum_kit',
    description: 'The drum kit: each drum part (role, e.g. snareDrum1) and the sound it plays.',
    params: z.object({}).strict(),
    run: (_a, ctx) => ({
      summary: arrangementEdit(() => drumKitView(ctx.song))
        .map((k) => `${k.role} (${k.label}, family ${k.family}): ${k.name ? `"${k.name}" [${k.soundId}]` : 'no sound'}${k.overridden ? ' — replaced by the user' : ''}`)
        .join('\n'),
    }),
  }),

  // ---- tracks ----
  tool({
    name: 'change_sound',
    description: 'Give a track another sound of its kind (find the id with search_sounds, useAs = the track kind). The part keeps its notes.',
    params: z.object({ track: z.string(), soundId: z.string() }).strict(),
    run: (a, ctx) => {
      requireTrack(ctx.song, a.track);
      const { song } = arrangementEdit(() => editTrack(ctx.song, { kind: 'changeSound', track: a.track, soundId: a.soundId }));
      return edited(ctx, song, `${a.track} now plays ${soundName(a.soundId)}.`);
    },
  }),
  tool({
    name: 'new_pattern',
    description: 'Write a new part (pattern) for a track, in every section it plays.',
    params: z.object({ track: z.string() }).strict(),
    run: (a, ctx) => {
      requireTrack(ctx.song, a.track);
      const { song } = arrangementEdit(() => editTrack(ctx.song, { kind: 'newPattern', track: a.track }));
      return edited(ctx, song, `${a.track} has a new pattern.`);
    },
  }),
  tool({
    name: 'add_track',
    description: 'Add a track of a kind (keys, bass, pad, guitar, synths, pluckedSynths, popStrings, popBrass) playing in the sections given, optionally with a sound id.',
    params: z.object({ family: InstrumentFamilySchema, sections: z.array(z.string()).min(1), soundId: z.string().optional() }).strict(),
    run: (a, ctx) => {
      for (const s of a.sections) requireSection(ctx.song, s);
      const { song, track } = arrangementEdit(() =>
        editTrack(ctx.song, { kind: 'addTrack', family: a.family, segments: a.sections, ...(a.soundId ? { soundId: a.soundId } : {}) }),
      );
      return edited(ctx, song, `Added the track ${track}, playing in ${a.sections.join(', ')}.`);
    },
  }),
  tool({
    name: 'remove_track',
    description: 'Remove a track from the song.',
    params: z.object({ track: z.string() }).strict(),
    run: (a, ctx) => {
      requireTrack(ctx.song, a.track);
      return edited(ctx, songEdit(ctx.song, { kind: 'removeTrack', track: a.track }), `Removed the track ${a.track}.`);
    },
  }),

  // ---- sections ----
  tool({
    name: 'add_section',
    description: `Add a new section written in the song's style. type is one of ${SECTION_TYPES.join(', ')}. Place it with after or before (a section name) or index (0 = first).`,
    params: z
      .object({
        type: z.enum(SECTION_TYPES as unknown as [string, ...string[]]),
        after: z.string().optional(),
        before: z.string().optional(),
        index: z.number().int().min(0).optional(),
        bars: z.number().int().min(1).max(64).optional(),
      })
      .strict(),
    run: (a, ctx) => {
      const names = sectionNames(ctx.song);
      const given = [a.after, a.before, a.index].filter((x) => x !== undefined).length;
      if (given !== 1) throw new ToolError('Give exactly one of after, before or index.');
      let index: number;
      if (a.after !== undefined) {
        requireSection(ctx.song, a.after);
        index = names.indexOf(a.after) + 1;
      } else if (a.before !== undefined) {
        requireSection(ctx.song, a.before);
        index = names.indexOf(a.before);
      } else index = a.index!;
      const { song, name } = arrangementEdit(() => addSection(ctx.song, a.type, index, a.bars));
      return edited(ctx, song, `Added ${name} at position ${index + 1}.`);
    },
  }),
  tool({
    name: 'delete_section',
    description: 'Delete a section.',
    params: z.object({ name: z.string() }).strict(),
    run: (a, ctx) => {
      requireSection(ctx.song, a.name);
      return edited(ctx, songEdit(ctx.song, { kind: 'deleteSegment', segmentName: a.name }), `Deleted ${a.name}.`);
    },
  }),
  tool({
    name: 'rename_section',
    description: 'Rename a section (names must stay unique).',
    params: z.object({ name: z.string(), newName: z.string().min(1).max(40) }).strict(),
    run: (a, ctx) => {
      requireSection(ctx.song, a.name);
      return edited(ctx, songEdit(ctx.song, { kind: 'renameSegment', segmentName: a.name, newName: a.newName }), `Renamed ${a.name} to ${a.newName}.`);
    },
  }),
  tool({
    name: 'duplicate_section',
    description: 'Duplicate a section (the copy follows it).',
    params: z.object({ name: z.string() }).strict(),
    run: (a, ctx) => {
      requireSection(ctx.song, a.name);
      const before = new Set(sectionNames(ctx.song));
      const song = songEdit(ctx.song, { kind: 'duplicateSegment', segmentName: a.name });
      const copy = sectionNames(song).find((n) => !before.has(n));
      return edited(ctx, song, `Duplicated ${a.name}${copy ? ` as ${copy}` : ''}.`);
    },
  }),
  tool({
    name: 'move_section',
    description: 'Move a section to a new position (toIndex, 0 = first).',
    params: z.object({ name: z.string(), toIndex: z.number().int().min(0) }).strict(),
    run: (a, ctx) => {
      requireSection(ctx.song, a.name);
      return edited(ctx, songEdit(ctx.song, { kind: 'moveSegment', segmentName: a.name, targetIndex: a.toIndex }), `Moved ${a.name} to position ${a.toIndex + 1}.`);
    },
  }),
  tool({
    name: 'set_section_bars',
    description: 'Set how many bars a section has.',
    params: z.object({ name: z.string(), bars: z.number().int().min(1).max(64) }).strict(),
    run: (a, ctx) => {
      requireSection(ctx.song, a.name);
      return edited(ctx, songEdit(ctx.song, { kind: 'setBarCount', segmentName: a.name, bars: a.bars }), `${a.name} now has ${a.bars} bars.`);
    },
  }),

  // ---- transitions ----
  tool({
    name: 'set_transition',
    description: `Switch a transition on or off in sections, or give it another sound (soundId from search_sounds with transition set to this type). type is one of ${TRANSITION_TYPES.map((t) => t.type).join(', ')}.`,
    params: z.object({ sections: z.array(z.string()).min(1), type: z.string(), placement: Placement, on: z.boolean(), soundId: z.string().optional() }).strict(),
    run: (a, ctx) => {
      for (const s of a.sections) requireSection(ctx.song, s);
      const song = arrangementEdit(() =>
        setTransition(ctx.song, { segments: a.sections, type: a.type, placement: a.placement, on: a.on, ...(a.soundId ? { soundId: a.soundId } : {}) }),
      );
      return edited(ctx, song, `${a.on ? (a.soundId ? 'Set' : 'Added') : 'Removed'} the ${a.type} ${a.on ? 'in' : 'from'} ${a.sections.join(', ')}.`);
    },
  }),

  // ---- drums ----
  tool({
    name: 'set_drum_sound',
    description: 'Give one drum part (role from get_drum_kit, e.g. snareDrum1) another sound of its kind (id from search_sounds with the matching family), or null for the style\'s own sound.',
    params: z.object({ role: z.string(), soundId: z.string().nullable() }).strict(),
    run: (a, ctx) => {
      const { song } = arrangementEdit(() => editTrack(ctx.song, { kind: 'setDrumSound', role: a.role, soundId: a.soundId }));
      return edited(ctx, song, a.soundId ? `${a.role} now plays ${soundName(a.soundId)}.` : `${a.role} is back to the style's own sound.`);
    },
  }),
  tool({
    name: 'set_drum_hits',
    description: `Turn drum hits on or off in sections (the drums play one repeating bar per section). drum: a part name (${Object.keys(DRUM_PITCH).join(', ')}). steps: positions in 32nd notes from the start of the bar (0 = beat 1, 8 = beat 2, 16 = beat 3, 24 = beat 4).`,
    params: z.object({ sections: z.array(z.string()).min(1), drum: z.string(), steps: z.array(z.number().int().min(0).max(31)).min(1), on: z.boolean() }).strict(),
    run: (a, ctx) => {
      for (const s of a.sections) requireSection(ctx.song, s);
      const pitch = DRUM_PITCH[a.drum];
      if (pitch === undefined) throw new ToolError(`Unknown drum part "${a.drum}". Parts: ${Object.keys(DRUM_PITCH).join(', ')}.`);
      let song = ctx.song;
      for (const step of a.steps) song = songEdit(song, { kind: 'setDrumHit', segments: a.sections, pitch, step, on: a.on });
      return edited(ctx, song, `${a.on ? 'Added' : 'Removed'} ${a.drum} hits at steps ${a.steps.join(', ')} in ${a.sections.join(', ')}.`);
    },
  }),

  // ---- the page (playback, saving, undo …) ----
  tool({
    name: 'play',
    description: 'Play the song, from the start or from a section.',
    params: z.object({ fromSection: z.string().optional() }).strict(),
    run: (a, ctx) => {
      if (a.fromSection) requireSection(ctx.song, a.fromSection);
      return { summary: `Playing${a.fromSection ? ` from ${a.fromSection}` : ''}.`, action: { kind: 'play', ...(a.fromSection ? { fromSection: a.fromSection } : {}) } };
    },
  }),
  tool({ name: 'stop', description: 'Stop playback.', params: z.object({}).strict(), run: () => ({ summary: 'Stopped.', action: { kind: 'stop' } }) }),
  tool({
    name: 'loop_section',
    description: 'Loop one section while playing.',
    params: z.object({ section: z.string() }).strict(),
    run: (a, ctx) => {
      requireSection(ctx.song, a.section);
      return { summary: `Looping ${a.section}.`, action: { kind: 'loop', section: a.section } };
    },
  }),
  ...(['mute', 'unmute', 'solo', 'unsolo'] as const).map((kind) =>
    tool({
      name: `${kind}_track`,
      description: { mute: 'Mute a track.', unmute: 'Unmute a track.', solo: 'Solo a track (hear it alone).', unsolo: 'Take a track out of solo.' }[kind],
      params: z.object({ track: z.string() }).strict(),
      run: (a, ctx) => {
        requireTrack(ctx.song, a.track);
        return { summary: `${kind[0]!.toUpperCase()}${kind.slice(1)}d ${a.track}.`.replace('Unsolod', 'Unsoloed').replace('Solod', 'Soloed'), action: { kind, track: a.track } };
      },
    }),
  ),
  tool({ name: 'undo', description: 'Undo the last edit.', params: z.object({}).strict(), run: () => ({ summary: 'Undid the last edit.', action: { kind: 'undo' } }) }),
  tool({ name: 'redo', description: 'Redo the edit that was undone.', params: z.object({}).strict(), run: () => ({ summary: 'Redid the edit.', action: { kind: 'redo' } }) }),
  tool({ name: 'save', description: 'Save the song (the edits so far).', params: z.object({}).strict(), run: () => ({ summary: 'Saving the song.', action: { kind: 'save' } }) }),
  tool({
    name: 'rename_song',
    description: 'Give the song a new title.',
    params: z.object({ title: z.string().min(1).max(120) }).strict(),
    run: (a) => ({ summary: `Renaming the song to "${a.title}".`, action: { kind: 'renameSong', title: a.title } }),
  }),
  tool({ name: 'export_audio', description: 'Open the export window (WAV, MP3, stems, MIDI, DAW projects).', params: z.object({}).strict(), run: () => ({ summary: 'Opened the export window.', action: { kind: 'export' } }) }),
  tool({
    name: 'open_tab',
    description: 'Open another tab of the editor: sound (the sound library), timeline (the song) or video (the music video).',
    params: z.object({ tab: z.enum(['sound', 'timeline', 'video']) }).strict(),
    run: (a) => ({ summary: `Opened the ${a.tab} tab.`, action: { kind: 'openTab', tab: a.tab } }),
  }),
] as const;

/** The tools as OpenAI-style function definitions for the model. */
export function toolSpecs() {
  return TOOLS.map((t) => {
    const { $schema: _s, ...parameters } = zodToJsonSchema(t.params, { target: 'openApi3' }) as Record<string, unknown>;
    return { type: 'function' as const, function: { name: t.name, description: t.description, parameters } };
  });
}

/** Run one tool call on the working song: validated args, a ToolResult, or a ToolError for the model. */
export function runTool(name: string, rawArgs: unknown, ctx: ToolContext): ToolResult {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) throw new ToolError(`There is no tool "${name}".`);
  const parsed = (def.params as z.ZodTypeAny).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    throw new ToolError(`The arguments for ${name} are not valid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ')}`);
  }
  return (def as unknown as ToolDef<z.ZodTypeAny>).run(parsed.data, ctx);
}

export type { ToolContext };
