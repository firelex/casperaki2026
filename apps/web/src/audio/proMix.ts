// Pro mode: the track view's editable mixer. Holds the open song's mix changes
// (fader trims, sends, bus plugin parameters), plays every change at once
// (livePlayer.proMix) and saves them with the song shortly after (PUT
// /api/songs/:id/mix), so playback, export and renders all use them. Reset goes
// back to the standard mix: it saves "no changes" and reloads the song.

import { useSyncExternalStore } from 'react';

import type { LaneMixOverride, MixOverrides } from '@casperaki/song-schema/schemas';

import type { PlaybackPayload } from '../api/playback';

import { songsApi } from '../api/songs';
import { livePlayer } from './livePlayer';

export interface ProMixState {
  /** The project (saved song) the changes belong to. */
  readonly songId: string | undefined;
  /** Pro mode on: the mixer's faders, sends and plugin controls are editable. */
  readonly pro: boolean;
  readonly mix: MixOverrides;
  readonly saving: boolean;
  readonly error: string | undefined;
  /** Bumped when the mix went back to standard (the view reads the mix again). */
  readonly version: number;
}

const EMPTY_MIX_OVERRIDES: MixOverrides = { lanes: {}, buses: {} };
const SAVE_DELAY_MS = 600;
const SENDS = { reverb: 0, delay: 1, chorus: 2 } as const;

let state: ProMixState = { songId: undefined, pro: false, mix: EMPTY_MIX_OVERRIDES, saving: false, error: undefined, version: 0 };
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function set(patch: Partial<ProMixState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useProMix(): ProMixState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** The open song's Pro-mode changes, for playing a working copy with unsaved edits. */
export function currentProMix(): MixOverrides | undefined {
  return state.songId && (Object.keys(state.mix.lanes).length || Object.keys(state.mix.buses).length) ? state.mix : undefined;
}

/** A song was opened (or saved under a new id): take its saved mix. */
export function openProMix(songId: string, saved: MixOverrides | null): void {
  if (state.songId === songId) return;
  flushSave();
  set({ songId, mix: saved ?? EMPTY_MIX_OVERRIDES, saving: false, error: undefined });
}

export function setPro(on: boolean): void {
  set({ pro: on });
}

/**
 * Route a track to another group bus (undefined: back to its standard bus). The
 * engine builds its buses when a song loads, so this saves at once and, if the
 * song is playing, swaps in a version with the new routing at the same position.
 */
export async function changeLaneRoute(
  liveKey: string | undefined,
  fetchPayload: ((signal: AbortSignal) => Promise<PlaybackPayload>) | undefined,
  lane: string,
  fxGroup: string | undefined,
): Promise<void> {
  const prev: LaneMixOverride = { ...(state.mix.lanes[lane] ?? {}) } as LaneMixOverride;
  const next: Record<string, unknown> = { ...prev };
  if (fxGroup === undefined) delete next.fxGroup;
  else next.fxGroup = fxGroup;
  const lanes = { ...state.mix.lanes };
  if (Object.keys(next).length) lanes[lane] = next as LaneMixOverride;
  else delete lanes[lane];
  set({ mix: { ...state.mix, lanes } });
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  await save();
  if (state.error) return;
  // The mixer view reads the resolved mix again (the lane's bus changed).
  set({ version: state.version + 1 });
  if (!liveKey || !fetchPayload) return;
  const live = livePlayer.getState();
  if (live.key === liveKey && live.status === 'playing') await livePlayer.play(liveKey, fetchPayload, { seamless: true, reload: true });
}

/**
 * Change a fader trim (dB, 0 = standard) or one send (dB) on `lanes`: the tracks
 * of one instrument type, which share one setting (the standard mix has one level
 * and one set of sends per type and genre, and Pro mode edits those). `liveKey`:
 * what the player plays.
 */
export function changeLane(liveKey: string | undefined, lanes: readonly string[], patch: Partial<Record<Exclude<keyof LaneMixOverride, 'fxGroup'>, number | undefined>>): void {
  if (!lanes.length) throw new Error('changeLane: no tracks to change');
  const next = { ...state.mix.lanes };
  for (const lane of lanes) {
    const prev: Record<string, number | string | undefined> = { ...(next[lane] ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || (k === 'volumeDb' && v === 0)) delete prev[k];
      else prev[k] = v;
    }
    const cleaned = Object.fromEntries(Object.entries(prev).filter(([, v]) => v !== undefined)) as LaneMixOverride;
    if (Object.keys(cleaned).length) next[lane] = cleaned;
    else delete next[lane];
  }
  set({ mix: { ...state.mix, lanes: next } });
  if (liveKey) {
    for (const lane of lanes) {
      if ('volumeDb' in patch) livePlayer.proMix(liveKey, { laneTrim: { lane, db: patch.volumeDb ?? 0 } });
      for (const k of ['reverb', 'delay', 'chorus'] as const) {
        const v = patch[k];
        if (v !== undefined) livePlayer.proMix(liveKey, { laneSend: { lane, bus: SENDS[k], db: v } });
      }
    }
  }
  scheduleSave();
}

/** Change one parameter of the plugin at `slot` of `bus`; `all` are its current parameters. */
export function changeBusParam(liveKey: string | undefined, bus: string, slot: number, all: readonly number[], index: number, value: number): void {
  const params = [...all];
  params[index] = value;
  const buses = { ...state.mix.buses, [bus]: { ...(state.mix.buses[bus] ?? {}), [String(slot)]: params } };
  set({ mix: { ...state.mix, buses } });
  if (liveKey) livePlayer.proMix(liveKey, { busParam: { bus, slot, index, value } });
  scheduleSave();
}

/** Back to the standard mix: save no changes, then reload what is playing with the standard config. */
export async function resetProMix(liveKey: string | undefined, fetchPayload: ((signal: AbortSignal) => Promise<PlaybackPayload>) | undefined): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  set({ mix: EMPTY_MIX_OVERRIDES });
  await save();
  if (state.error) return;
  set({ version: state.version + 1 });
  if (!liveKey || !fetchPayload) return;
  const live = livePlayer.getState();
  if (live.key !== liveKey) return;
  if (live.status === 'playing') await livePlayer.play(liveKey, fetchPayload, { seamless: true, reload: true });
  else livePlayer.stop();
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void save();
  }, SAVE_DELAY_MS);
}

function flushSave(): void {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = undefined;
  void save();
}

async function save(): Promise<void> {
  const { songId, mix } = state;
  if (!songId) return;
  set({ saving: true, error: undefined });
  try {
    const empty = !Object.keys(mix.lanes).length && !Object.keys(mix.buses).length;
    await songsApi.saveMix(songId, empty ? null : mix);
    // Everything cached was lowered with the previous mix config.
    livePlayer.forgetMixes();
    set({ saving: false });
  } catch (err) {
    set({ saving: false, error: `The mix could not be saved: ${err instanceof Error ? err.message : String(err)}` });
  }
}
