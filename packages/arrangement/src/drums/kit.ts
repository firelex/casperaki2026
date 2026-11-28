// The drum kit the engine plays (its 17 drum roles), assembled from the
// per-component catalog families: one validated row per role, picked
// deterministically for the genre (mainStyle match, then addStyles, then any;
// lowest id wins), unless the song overrides a role with a sound the user
// chose. The lowering (engine-spike emit script) and the brain's drum-kit
// route both use this, so what the editor shows is what the engine plays.
//
// Per-song overrides live on the song's Drums instrument definition as
// `details.drumSounds` (role → catalog id), and are also recorded as
// `setDrumSound` track edits so a regenerated Drums track carries them.

import { genreRecipe, SongGenreSchema } from '@casperaki/song-schema';

import { loadValidatedCatalog, type ValidatedCatalogEntry } from '../catalog/validated-catalog.js';

/** Engine drum role → the catalog family its sound comes from (engine order). */
export const DRUM_ROLE_FAMILIES = {
  bassDrum1: 'kickDrums',
  bassDrum2: 'kickDrums',
  snareDrum1: 'snareDrums',
  snareDrum2: 'snareDrums',
  clap: 'clapsSnaps',
  snap: 'clapsSnaps',
  hiHatClosed1: 'hiHatsClosed',
  hiHatClosed2: 'hiHatsClosed',
  hiHatPedal: 'hiHatsClosed',
  hiHatOpen: 'hiHatsOpen',
  crash1: 'cymbals',
  crash2: 'cymbals',
  ride: 'cymbals',
  shaker: 'shakers',
  tom1: 'toms',
  tom2: 'toms',
  tom3: 'toms',
} as const;

export type DrumRole = keyof typeof DRUM_ROLE_FAMILIES;
export const DRUM_ROLES = Object.keys(DRUM_ROLE_FAMILIES) as DrumRole[];

export const DRUM_ROLE_LABELS: Readonly<Record<DrumRole, string>> = {
  bassDrum1: 'Kick 1',
  bassDrum2: 'Kick 2',
  snareDrum1: 'Snare 1',
  snareDrum2: 'Snare 2',
  clap: 'Clap',
  snap: 'Snap',
  hiHatClosed1: 'Closed hi-hat 1',
  hiHatClosed2: 'Closed hi-hat 2',
  hiHatPedal: 'Pedal hi-hat',
  hiHatOpen: 'Open hi-hat',
  crash1: 'Crash 1',
  crash2: 'Crash 2',
  ride: 'Ride',
  shaker: 'Shaker',
  tom1: 'Tom 1',
  tom2: 'Tom 2',
  tom3: 'Tom 3',
};

/** Where a song keeps its drum overrides: the Drums definition's details key. */
export const DRUM_SOUNDS_DETAIL = 'drumSounds';

export function isDrumRole(role: string): role is DrumRole {
  return Object.prototype.hasOwnProperty.call(DRUM_ROLE_FAMILIES, role);
}

/** Roles whose sounds come from catalog `family` (e.g. snareDrums → snareDrum1, snareDrum2). */
export function drumRolesForFamily(family: string): DrumRole[] {
  return DRUM_ROLES.filter((r) => DRUM_ROLE_FAMILIES[r] === family);
}

/** The genre's default sound for a family (the deterministic pick), or undefined when the family has no rows. A
 *  derived genre (genre recipe) picks as its base genre, from its own sample library for the families it names
 *  (Casperaki Pop: kick, snare and clap from drLuke). */
export function defaultDrumEntry(family: string, songGenre: string): ValidatedCatalogEntry | undefined {
  const recipe = SongGenreSchema.safeParse(songGenre).success ? genreRecipe(songGenre) : undefined;
  const genre = recipe?.base ?? songGenre;
  const all = loadValidatedCatalog().entries.filter((e) => e.family === family);
  const lib = recipe?.drumLibrary?.families.includes(family) ? recipe.drumLibrary.library : undefined;
  const candidates = lib === undefined ? all : all.filter((e) => e.library === lib);
  if (lib !== undefined && candidates.length === 0) throw new Error(`the ${songGenre} drums take ${family} from the "${lib}" library, which has none`);
  if (candidates.length === 0) return undefined;
  const primary = candidates.filter((e) => e.mainStyle === genre);
  const secondary = candidates.filter((e) => e.addStyles.includes(genre as never));
  const pool = primary.length > 0 ? primary : secondary.length > 0 ? secondary : candidates;
  return [...pool].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

/** The validated catalog entry for a user-chosen drum sound; throws when it is not a sound of that role's family. */
export function drumSoundEntry(role: string, soundId: string): ValidatedCatalogEntry {
  if (!isDrumRole(role)) throw new Error(`unknown drum role "${role}" (one of ${DRUM_ROLES.join(', ')})`);
  const entry = loadValidatedCatalog().byId.get(soundId);
  if (!entry) throw new Error(`drum sound ${soundId} is not a library sound with a file`);
  const family = DRUM_ROLE_FAMILIES[role];
  if (entry.family !== family) throw new Error(`drum sound ${soundId} is a ${entry.family} sound, but ${role} takes ${family}`);
  return entry;
}

export interface DrumKitSlot {
  readonly role: DrumRole;
  readonly family: string;
  /** Undefined when the library has no sound of the family at all. */
  readonly entry: ValidatedCatalogEntry | undefined;
  readonly overridden: boolean;
}

/** The kit for a genre with the song's overrides (role → catalog id) applied. */
export function drumKit(genre: string, overrides: Readonly<Record<string, string>> = {}): DrumKitSlot[] {
  for (const [role, id] of Object.entries(overrides)) drumSoundEntry(role, id);
  return DRUM_ROLES.map((role) => {
    const family = DRUM_ROLE_FAMILIES[role];
    const id = overrides[role];
    return id !== undefined
      ? { role, family, entry: drumSoundEntry(role, id), overridden: true }
      : { role, family, entry: defaultDrumEntry(family, genre), overridden: false };
  });
}

/** A song's drum overrides (role → catalog id) from its Drums definition; {} when it has none. */
export function songDrumSounds(song: { instrumentDefinitions: readonly { name: string; details?: Record<string, unknown> | undefined }[] }): Record<string, string> {
  const def = song.instrumentDefinitions.find((d) => d.name === 'Drums');
  const raw = def?.details?.[DRUM_SOUNDS_DETAIL];
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`Drums details.${DRUM_SOUNDS_DETAIL} is not an object`);
  const out: Record<string, string> = {};
  for (const [role, id] of Object.entries(raw)) {
    if (typeof id !== 'string') throw new Error(`Drums details.${DRUM_SOUNDS_DETAIL}.${role} is not a catalog id`);
    out[role] = id;
  }
  return out;
}
