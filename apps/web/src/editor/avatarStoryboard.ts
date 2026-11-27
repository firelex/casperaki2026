// The dance floor video's storyboard (docs/superpowers/specs/2026-11-27-avatar-scenes-storyboard-design.md): per
// section of the song, where it happens, which of the video's avatars are in it, and how it is filmed. Starts as
// today's video (club, everyone, automatic camera); follows the avatars chosen for the video.

export interface StoryboardEntry {
  readonly scene: string;
  readonly avatarIds: readonly string[];
  readonly camera: string;
}

export const DEFAULT_SCENE = 'club';
export const DEFAULT_CAMERA = 'auto';

/** A section's name for people, as the brain writes it ("preChorus2" -> "Pre-chorus 2"). */
export function sectionLabel(name: string): string {
  const m = /^([A-Za-z]+?)(\d*)$/u.exec(name);
  if (!m) return name;
  const words = m[1]!.replace(/([a-z])([A-Z])/gu, '$1-$2').toLowerCase();
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  return m[2] ? `${label} ${m[2]}` : label;
}

/** The storyboard for `sections` sections and the chosen avatars: the edited entries where there are some (their
 *  avatars kept to the chosen ones, everyone when none would be left), the default elsewhere. */
export function storyboardFor(edited: readonly StoryboardEntry[] | undefined, sections: number, chosen: readonly string[]): StoryboardEntry[] {
  return Array.from({ length: sections }, (_, i) => {
    const e = edited?.[i];
    if (!e) return { scene: DEFAULT_SCENE, avatarIds: [...chosen], camera: DEFAULT_CAMERA };
    const kept = e.avatarIds.filter((id) => chosen.includes(id));
    return { scene: e.scene, camera: e.camera, avatarIds: kept.length > 0 ? kept : [...chosen] };
  });
}

/** Sets one section's choice. */
export function setEntry(board: readonly StoryboardEntry[], i: number, change: Partial<StoryboardEntry>): StoryboardEntry[] {
  return board.map((e, k) => (k === i ? { ...e, ...change } : e));
}

/** Turns an avatar on or off in one section (the last one can't be turned off: a section needs someone). */
export function toggleAvatar(board: readonly StoryboardEntry[], i: number, id: string): StoryboardEntry[] {
  const e = board[i];
  if (!e) throw new Error(`the storyboard has no section ${i + 1}`);
  const on = e.avatarIds.includes(id);
  if (on && e.avatarIds.length === 1) return [...board];
  return setEntry(board, i, { avatarIds: on ? e.avatarIds.filter((x) => x !== id) : [...e.avatarIds, id] });
}

/** Uses section i's choices for every section. */
export function useForAll(board: readonly StoryboardEntry[], i: number): StoryboardEntry[] {
  const e = board[i];
  if (!e) throw new Error(`the storyboard has no section ${i + 1}`);
  return board.map(() => ({ scene: e.scene, camera: e.camera, avatarIds: [...e.avatarIds] }));
}
