/**
 * Pure reducer for client-side song structure editing.
 *
 * The editor session holds the **original** generated Song (what the
 * brain returned, immutable) and a **working** Song that diverges as the
 * user applies edits. Every mutation:
 *
 *   1. produces a *candidate* Song via a pure transform,
 *   2. re-parses the candidate through `parseSong` so an edit that
 *      would invalidate the schema is rejected and reported, and
 *   3. pushes the previous `working` onto the undo stack on success.
 *
 * No backend persistence in this slice — the working Song lives entirely
 * in the editor session (see docs/54f-ui-structure-editing.md for the
 * deferred items). The reducer is the seam where a future
 * `POST /api/songs/:id/draft` endpoint hangs.
 */

// `parseSong` from the dedicated `/parse` subpath rather than the
// package barrel — the barrel re-exports `contentHash` from
// `canonical/hash`, which pulls in `node:crypto`. Vite then refuses to
// bundle the package for the browser even though parseSong itself is
// pure Zod. The subpath is declared in @casperaki/song-schema's
// `exports` field, so this is a supported entry point.
import { parseSong } from '@casperaki/song-schema/parse';
import type {
  Arrangement,
  Segment,
  SegmentPayload,
  Song,
  SongStructure,
} from '@casperaki/song-schema';

const MAX_UNDO = 100;

/** All UI-driven song mutations + the undo/redo/revert controls. */
export type EditCommand =
  | { kind: 'duplicateSegment'; segmentName: string }
  | { kind: 'deleteSegment'; segmentName: string }
  | {
      kind: 'reorderSegment';
      segmentName: string;
      direction: 'left' | 'right';
    }
  | {
      /** Drag/drop reorder — move `segmentName` to absolute index
       *  `targetIndex` in `songStructure`. Indices outside [0, length)
       *  are clamped; a no-op move (target === current) is rejected so
       *  the dispatch path stays observable. */
      kind: 'moveSegment';
      segmentName: string;
      targetIndex: number;
    }
  | { kind: 'changeBarCount'; segmentName: string; delta: number; min?: number }
  | { kind: 'setBarCount'; segmentName: string; bars: number; min?: number }
  | { kind: 'renameSegment'; segmentName: string; newName: string }
  /** Take a track out of every section and drop its instrument. */
  | { kind: 'removeTrack'; track: string }
  /** A whole new working song, e.g. the brain's answer to a track edit
   *  (new sound, new pattern, added track). Undoable like any edit. */
  | { kind: 'replaceSong'; song: Song }
  | { kind: 'revertToOriginal' }
  | { kind: 'undo' }
  | { kind: 'redo' };

export type ValidationStatus =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface EditState {
  readonly original: Song;
  readonly working: Song;
  /** Snapshots of `working` BEFORE each successful mutation, most recent
   *  last. `undo` pops from this stack. */
  readonly undoStack: readonly Song[];
  /** Snapshots produced by undo, ready to be re-applied via redo. */
  readonly redoStack: readonly Song[];
  /** True iff `working` canonicalises to different bytes than `original`. */
  readonly dirty: boolean;
  /** Schema validation of the current `working`. Mutations that would
   *  invalidate the song are rejected; this never reflects an
   *  invalid `working` — it's the *last* validation outcome. */
  readonly validation: ValidationStatus;
  /** True when any local render artifact no longer matches the working
   *  Song. The brain has no render-by-Song endpoint yet, so today this
   *  collapses to `dirty`: the moment the user edits, the rendered WAV
   *  is stale by definition. */
  readonly renderStale: boolean;
  /** Last command error (validation failure, out-of-bounds, …) — used
   *  by the UI to surface a toast/banner. Cleared on the next
   *  successful command. */
  readonly lastError: string | undefined;
}

export function initEditState(song: Song): EditState {
  return {
    original: song,
    working: song,
    undoStack: [],
    redoStack: [],
    dirty: false,
    validation: { ok: true },
    renderStale: false,
    lastError: undefined,
  };
}

export function canUndo(state: EditState): boolean {
  return state.undoStack.length > 0;
}

export function canRedo(state: EditState): boolean {
  return state.redoStack.length > 0;
}

export function applyCommand(state: EditState, command: EditCommand): EditState {
  switch (command.kind) {
    case 'undo':
      return undo(state);
    case 'redo':
      return redo(state);
    case 'revertToOriginal':
      return revertToOriginal(state);
    default:
      return applyMutation(state, command);
  }
}

function applyMutation(state: EditState, command: EditCommand): EditState {
  let candidate: Song;
  try {
    candidate = mutate(state.working, command);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...state, lastError: message };
  }
  const validation = validate(candidate);
  if (!validation.ok) {
    return { ...state, validation, lastError: validation.error };
  }
  const dirty = !sameSong(candidate, state.original);
  return {
    ...state,
    working: candidate,
    undoStack: pushBounded(state.undoStack, state.working),
    redoStack: [],
    dirty,
    validation: { ok: true },
    renderStale: dirty,
    lastError: undefined,
  };
}

function undo(state: EditState): EditState {
  if (state.undoStack.length === 0) return state;
  const previous = state.undoStack[state.undoStack.length - 1]!;
  const dirty = !sameSong(previous, state.original);
  return {
    ...state,
    working: previous,
    undoStack: state.undoStack.slice(0, -1),
    redoStack: [...state.redoStack, state.working],
    dirty,
    validation: { ok: true },
    renderStale: dirty,
    lastError: undefined,
  };
}

function redo(state: EditState): EditState {
  if (state.redoStack.length === 0) return state;
  const next = state.redoStack[state.redoStack.length - 1]!;
  const dirty = !sameSong(next, state.original);
  return {
    ...state,
    working: next,
    undoStack: pushBounded(state.undoStack, state.working),
    redoStack: state.redoStack.slice(0, -1),
    dirty,
    validation: { ok: true },
    renderStale: dirty,
    lastError: undefined,
  };
}

function revertToOriginal(state: EditState): EditState {
  if (sameSong(state.working, state.original)) return state;
  return {
    ...state,
    working: state.original,
    undoStack: pushBounded(state.undoStack, state.working),
    redoStack: [],
    dirty: false,
    validation: { ok: true },
    renderStale: false,
    lastError: undefined,
  };
}

function pushBounded(stack: readonly Song[], value: Song): readonly Song[] {
  const next = [...stack, value];
  return next.length > MAX_UNDO ? next.slice(next.length - MAX_UNDO) : next;
}

function validate(candidate: Song): ValidationStatus {
  try {
    parseSong(candidate);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

/** Reference-equality dirty check. Every mutation produces a new Song
 *  object; `undo`/`redo` restore the *exact* previous references, and
 *  `revertToOriginal` assigns `working = original` directly. So
 *  reference equality is correct in every reachable state — and it's
 *  free, which `canonicalStringifySong` (a `node:crypto` neighbour
 *  in the schema barrel) is not when bundled for the browser. */
function sameSong(a: Song, b: Song): boolean {
  return a === b;
}

// --- mutations ----------------------------------------------------------

function mutate(song: Song, command: EditCommand): Song {
  switch (command.kind) {
    case 'duplicateSegment':
      return duplicateSegment(song, command.segmentName);
    case 'deleteSegment':
      return deleteSegment(song, command.segmentName);
    case 'reorderSegment':
      return reorderSegment(song, command.segmentName, command.direction);
    case 'moveSegment':
      return moveSegment(song, command.segmentName, command.targetIndex);
    case 'changeBarCount':
      return changeBarCount(
        song,
        command.segmentName,
        command.delta,
        command.min ?? 1,
      );
    case 'setBarCount': {
      const idx = findSegmentIndex(song, command.segmentName);
      const current = song.songStructure[idx]!.bars.length;
      const delta = command.bars - current;
      if (delta === 0) {
        throw new Error('setBarCount: bar count is unchanged — no-op');
      }
      return changeBarCount(
        song,
        command.segmentName,
        delta,
        command.min ?? 1,
      );
    }
    case 'renameSegment':
      return renameSegment(song, command.segmentName, command.newName);
    case 'removeTrack':
      return removeTrack(song, command.track);
    case 'replaceSong':
      return command.song;
    default:
      throw new Error(`unreachable mutation kind ${(command as { kind: string }).kind}`);
  }
}

function findSegmentIndex(song: Song, name: string): number {
  const idx = song.songStructure.findIndex((s) => s.name === name);
  if (idx < 0) throw new Error(`segment '${name}' not found in songStructure`);
  return idx;
}

const TRACK_KEYED = ['instruments', 'overrides', 'fills', 'mutes', 'signalProcessors'] as const;

function removeTrack(song: Song, track: string): Song {
  let found = song.instrumentDefinitions.some((d) => d.name === track);
  const arrangement: Arrangement = {};
  for (const [seg, payload] of Object.entries(song.arrangement)) {
    const next: SegmentPayload = { ...payload };
    for (const field of TRACK_KEYED) {
      const map = payload[field] as Record<string, unknown> | undefined;
      if (map && track in map) {
        found = true;
        const copy = { ...map };
        delete copy[track];
        (next as Record<string, unknown>)[field] = copy;
      }
    }
    arrangement[seg] = next;
  }
  if (!found) throw new Error(`track '${track}' is not in this song`);
  return {
    ...song,
    arrangement,
    instrumentDefinitions: song.instrumentDefinitions.filter((d) => d.name !== track),
  };
}

function duplicateSegment(song: Song, name: string): Song {
  const idx = findSegmentIndex(song, name);
  const original = song.songStructure[idx]!;
  const taken = new Set(song.songStructure.map((s) => s.name));
  const newName = nextUniqueSegmentName(name, taken);
  const duplicate: Segment = {
    ...cloneDeep(original),
    name: newName,
  };
  const newStructure: SongStructure = [
    ...song.songStructure.slice(0, idx + 1),
    duplicate,
    ...song.songStructure.slice(idx + 1),
  ];
  const newArrangement: Arrangement = { ...song.arrangement };
  const payload = song.arrangement[name];
  if (payload) {
    newArrangement[newName] = cloneDeep(payload);
  }
  return { ...song, songStructure: newStructure, arrangement: newArrangement };
}

function deleteSegment(song: Song, name: string): Song {
  if (song.songStructure.length <= 1) {
    throw new Error('cannot delete the last remaining segment');
  }
  const idx = findSegmentIndex(song, name);
  const newStructure = song.songStructure.filter((_, i) => i !== idx);
  const newArrangement = { ...song.arrangement };
  delete newArrangement[name];
  const newAiArtifacts = (song.aiArtifacts ?? []).filter(
    (a) => a.attachedTo.scope !== 'segment' || a.attachedTo.segment !== name,
  );
  return {
    ...song,
    songStructure: newStructure,
    arrangement: newArrangement,
    aiArtifacts: newAiArtifacts,
  };
}

function reorderSegment(song: Song, name: string, direction: 'left' | 'right'): Song {
  const idx = findSegmentIndex(song, name);
  const target = direction === 'left' ? idx - 1 : idx + 1;
  if (target < 0 || target >= song.songStructure.length) {
    throw new Error(`cannot move segment '${name}' ${direction}: already at the boundary`);
  }
  const next = [...song.songStructure];
  const [moved] = next.splice(idx, 1);
  next.splice(target, 0, moved!);
  return { ...song, songStructure: next };
}

function moveSegment(song: Song, name: string, targetIndex: number): Song {
  const idx = findSegmentIndex(song, name);
  const length = song.songStructure.length;
  const clamped = Math.max(0, Math.min(length - 1, Math.floor(targetIndex)));
  if (clamped === idx) {
    throw new Error(`moveSegment: '${name}' is already at index ${clamped} — no-op`);
  }
  const next = [...song.songStructure];
  const [moved] = next.splice(idx, 1);
  next.splice(clamped, 0, moved!);
  return { ...song, songStructure: next };
}

function changeBarCount(song: Song, name: string, delta: number, min: number): Song {
  if (delta === 0) throw new Error('changeBarCount: delta is zero — no-op');
  const idx = findSegmentIndex(song, name);
  const segment = song.songStructure[idx]!;
  const currentBars = segment.bars.length;
  const nextBars = currentBars + delta;
  if (nextBars < min) {
    throw new Error(
      `cannot change bar count of '${name}' to ${nextBars} — minimum is ${min}`,
    );
  }
  let newBars = segment.bars;
  if (delta > 0) {
    // Pad by repeating the last bar so the chord progression keeps its
    // shape. If the segment is empty, fall back to an empty-chord bar
    // (still parseSong-valid: `chords: []` passes the structure schema).
    const template = segment.bars[currentBars - 1] ?? { chords: [] };
    const padding: SongStructure[number]['bars'] = [];
    for (let i = 0; i < delta; i++) padding.push(cloneDeep(template));
    newBars = [...segment.bars, ...padding];
  } else {
    newBars = segment.bars.slice(0, nextBars);
  }
  const newSegment: Segment = {
    ...segment,
    bars: newBars,
    ...(segment.lengthInBars !== undefined ? { lengthInBars: nextBars } : {}),
  };
  const newStructure = [...song.songStructure];
  newStructure[idx] = newSegment;
  return { ...song, songStructure: newStructure };
}

function renameSegment(song: Song, name: string, newName: string): Song {
  if (!newName.trim()) throw new Error('new segment name cannot be empty');
  if (newName === name) throw new Error('rename: new name is identical to the old name');
  if (song.songStructure.some((s) => s.name === newName)) {
    throw new Error(`segment '${newName}' already exists`);
  }
  const idx = findSegmentIndex(song, name);
  const newStructure = [...song.songStructure];
  newStructure[idx] = { ...newStructure[idx]!, name: newName };
  const newArrangement: Arrangement = {};
  for (const [key, value] of Object.entries(song.arrangement)) {
    newArrangement[key === name ? newName : key] = value as SegmentPayload;
  }
  // aiArtifacts may reference the segment by name (`attachedTo.segment`).
  // Update those refs in lockstep so semantic validation stays green.
  const newAiArtifacts = (song.aiArtifacts ?? []).map((a) => {
    if (a.attachedTo.scope === 'segment' && a.attachedTo.segment === name) {
      return { ...a, attachedTo: { ...a.attachedTo, segment: newName } };
    }
    return a;
  });
  return {
    ...song,
    songStructure: newStructure,
    arrangement: newArrangement,
    aiArtifacts: newAiArtifacts,
  };
}

/** Append the next available numeric suffix to produce a unique
 *  segment name. e.g. `chorus1` → `chorus2`, `intro` → `intro2`. */
export function nextUniqueSegmentName(base: string, taken: Set<string>): string {
  const match = base.match(/^(.+?)(\d+)$/u);
  const prefix = match ? match[1]! : base;
  const start = match ? parseInt(match[2]!, 10) + 1 : 2;
  for (let n = start; n < 10_000; n++) {
    const candidate = `${prefix}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not generate unique segment name based on '${base}'`);
}

function cloneDeep<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
