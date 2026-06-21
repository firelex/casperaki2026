// Artificial public instrument names ("aliases").
//
// The catalog records the real sampler/library/preset behind every sound
// (`library`, `preset`, `addPlugins`). Those name the commercial plugins
// the sounds were rendered from — we do NOT want to reveal them publicly.
// The alias layer assigns every catalogued sound a stable, brandable
// codename that leaks none of that provenance.
//
// Design goals:
//   - Deterministic — an alias is a pure function of a stable per-sound
//     key (the resolved disk path when known, else the catalog id). Same
//     sound → same name on every export, so the xlsx round-trips and the
//     registry diff stays clean.
//   - Decoupled from the hashed catalog — aliases live in their own
//     registry (`data/instrument-aliases.json`) keyed by catalog id, so
//     generating or editing a name never perturbs the catalog
//     `contentHash`.
//   - Pinned + human-overridable — once a name is in the registry it is
//     authoritative and never regenerated; only ids absent from the
//     registry get a fresh generated name. The xlsx importer writes
//     human edits straight back into the registry.
//   - Public-safe — the only real-world word in a name is the instrument
//     *class* (Bass, Lead, Kick…), i.e. the musical role, never the
//     plugin. The codename itself is a synthetic pseudo-word.

import { createHash } from 'node:crypto';

import type { InstrumentEntry, InstrumentSheetFamily } from './types.js';

/** Persisted alias registry: stable sound-identity → public display name.
 *  Committed to `data/instrument-aliases.json`. */
export interface AliasRegistry {
  readonly $description: string;
  readonly generator: string;
  /** soundIdentity → public name. Insertion order is identity-sorted for a
   *  stable diff. */
  readonly aliases: Record<string, string>;
}

export const ALIAS_REGISTRY_DESCRIPTION =
  'Public-facing artificial instrument names, keyed by a style-free SOUND ' +
  'IDENTITY = sha256(family|lowLevel|library|preset|bpm|key)[:16]. Identity ' +
  'deliberately excludes style/addStyles (taste-based classification that ' +
  'changes over time) so a name never moves when a sound is re-tagged. ' +
  'Names are deterministic and pinned: an entry here always wins over ' +
  'regeneration, so hand edits (or xlsx-imported edits) persist. None of ' +
  'these names reveal the underlying sampler/plugin.';

export const ALIAS_GENERATOR_ID =
  'catalog/alias.ts@v3 (real-word adjective+noun, probed; style-free sound identity)';

// ---------------------------------------------------------------------------
// Stable sound identity. The hash a name is keyed on. INTRINSIC fields only:
// where the sound comes from (library/preset), its structural bucket
// (family/lowLevel), and the render-defining variant axes (bpm/key). It
// EXCLUDES mainStyle/addStyles on purpose — those are classification that
// gets re-tuned as a matter of taste, and we don't want names to churn when
// they do. Two catalog rows that differ only by style therefore resolve to
// the same identity and share a name (they are the same patch, filed under
// two style folders). Distinct from the catalog row `id`, which keeps style
// in its hash so style re-listings can coexist as separate rows.
// ---------------------------------------------------------------------------
export function deriveSoundIdentity(entry: {
  family: string;
  lowLevel: string;
  library: string | null;
  preset: string | null;
  bpm: number | null;
  key: string | null;
}): string {
  return createHash('sha256')
    .update(
      `${entry.family}|${entry.lowLevel}|${entry.library ?? ''}|` +
      `${entry.preset ?? ''}|${entry.bpm === null ? '' : entry.bpm}|${entry.key ?? ''}`,
    )
    .digest('hex')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Public instrument-class words. These describe the musical role only — safe
// to expose. Every family maps to exactly one class word.
// ---------------------------------------------------------------------------
const FAMILY_CLASS: Record<InstrumentSheetFamily, string> = {
  fx: 'Texture',
  drumKits: 'Kit',
  kickDrums: 'Kick',
  snareDrums: 'Snare',
  clapsSnaps: 'Clap',
  hiHatsClosed: 'Hat',
  hiHatsOpen: 'Hat',
  toms: 'Tom',
  cymbals: 'Cymbal',
  shakers: 'Shaker',
  percussionBreaks: 'Break',
  percussionLoops: 'Groove',
  percussionMisc: 'Perc',
  basses: 'Bass',
  keys: 'Keys',
  synths: 'Synth',
  leadSynths: 'Lead',
  orchestral: 'Strings',
  popBrass: 'Brass',
  popStrings: 'Strings',
  acousticGuitars: 'Guitar',
  electricGuitars: 'Guitar',
  vocals: 'Voice',
};

/** Public class word for a family (the role, never the plugin). */
export function familyClassWord(family: InstrumentSheetFamily): string {
  return FAMILY_CLASS[family] ?? 'Sound';
}

// ---------------------------------------------------------------------------
// Real-word codename generator. A name is an `<Adjective> <Noun>` pair drawn
// from curated, public-safe word pools, chosen deterministically from a
// 32-bit FNV-1a hash of the sound identity.
//
// Pools are FAMILY-THEMED so a name evokes the instrument: drums get punchy
// rhythm/impact words, bass deep/low words, synths neon/electric words, keys
// elegant/classic words, etc. Each family maps to a `Pool`; a sound's name
// is generated from its family's pool, falling back to the GENERIC pool only
// if the themed pool is exhausted (it never is in practice — every pool's
// adj·noun space far exceeds its sound count).
//
// adj·noun forms each pool's name space; the dominant percussion pool is
// sized so its ~11k sounds load it under ~0.5, so deterministic open
// addressing (probe to the next free pair on collision — see resolveAliases)
// keeps every name a clean two-word pair with NO numeric suffixes.
//
// Public-safe: none of these words is a sampler/plugin/brand name, so a name
// can never leak provenance. The instrument *role* (Bass, Lead…) is carried
// separately by `familyClassWord`, not baked into the name.
// ---------------------------------------------------------------------------
export interface Pool {
  readonly adjectives: readonly string[];
  readonly nouns: readonly string[];
}

// Generic fallback — evocative but family-neutral (colours, materials, moods,
// nature, celestial). Big enough to absorb any themed-pool overflow.
const GENERIC: Pool = {
  adjectives: [
    'Crimson', 'Scarlet', 'Ruby', 'Amber', 'Golden', 'Honeyed', 'Copper', 'Bronze',
    'Rust', 'Ember', 'Coral', 'Blush', 'Rose', 'Cherry', 'Sienna', 'Ochre',
    'Saffron', 'Citrine', 'Lemon', 'Lime', 'Olive', 'Fern', 'Emerald', 'Jade',
    'Mint', 'Sage', 'Viridian', 'Teal', 'Cyan', 'Azure', 'Cobalt', 'Sapphire',
    'Indigo', 'Navy', 'Slate', 'Violet', 'Amethyst', 'Lilac', 'Lavender', 'Plum',
    'Magenta', 'Orchid', 'Mauve', 'Ivory', 'Pearl', 'Alabaster', 'Snowy', 'Frosted',
    'Silver', 'Platinum', 'Pewter', 'Ashen', 'Charcoal', 'Onyx', 'Obsidian', 'Ebony',
    'Midnight', 'Dusky', 'Shadowed', 'Hazy', 'Misty', 'Cloudy', 'Stormy', 'Electric',
    'Neon', 'Glowing', 'Radiant', 'Luminous', 'Gilded', 'Glassy', 'Crystal', 'Marbled',
    'Velvet', 'Satin', 'Silken', 'Mossy', 'Dewy', 'Frozen', 'Glacial', 'Arctic',
    'Wintry', 'Molten', 'Blazing', 'Smoldering', 'Fiery', 'Solar', 'Lunar', 'Stellar',
    'Cosmic', 'Astral', 'Nebular', 'Twilit', 'Dawning', 'Distant', 'Hollow', 'Deep',
    'Vast', 'Boundless', 'Drifting', 'Roaming', 'Restless', 'Gentle', 'Mellow', 'Tender',
    'Dreamy', 'Lush', 'Opulent', 'Regal', 'Noble', 'Ancient', 'Timeless', 'Secret',
    'Hidden', 'Quiet', 'Silent', 'Whispered', 'Soft', 'Faint', 'Brisk', 'Swift',
    'Nimble', 'Bold', 'Fierce', 'Wild', 'Feral', 'Rugged', 'Weathered', 'Rustic',
    'Humble', 'Sacred', 'Divine', 'Mystic', 'Arcane', 'Runic', 'Lofty', 'Towering',
    'Sunken', 'Tidal', 'Coastal', 'Verdant', 'Blooming', 'Wandering', 'Errant', 'Vagrant',
    'Hushed', 'Brave', 'Lucid', 'Vivid', 'Stark', 'Pure', 'Prime', 'Keen',
    'Grand', 'Royal', 'Velveteen', 'Sable', 'Russet', 'Maroon', 'Aqua', 'Cerulean',
  ],
  nouns: [
    'Harbor', 'Meadow', 'Canyon', 'Valley', 'Summit', 'Ridge', 'Crest', 'Peak',
    'Slope', 'Cliff', 'Bluff', 'Mesa', 'Plateau', 'Basin', 'Glen', 'Grove',
    'Thicket', 'Woodland', 'Forest', 'Glade', 'Fen', 'Moor', 'Heath', 'Prairie',
    'Savanna', 'Steppe', 'Tundra', 'Dune', 'Desert', 'Oasis', 'Delta', 'Estuary',
    'Lagoon', 'Bay', 'Cove', 'Inlet', 'Fjord', 'Strait', 'Channel', 'Reef',
    'Atoll', 'Shoal', 'Shore', 'Coast', 'Cape', 'Isle', 'Island', 'River',
    'Brook', 'Creek', 'Stream', 'Rapids', 'Cascade', 'Falls', 'Spring', 'Pond',
    'Lake', 'Mere', 'Tarn', 'Marsh', 'Bog', 'Wetland', 'Glacier', 'Iceberg',
    'Drift', 'Avalanche', 'Gorge', 'Ravine', 'Chasm', 'Cavern', 'Grotto', 'Quarry',
    'Ledge', 'Terrace', 'Plain', 'Field', 'Pasture', 'Orchard', 'Vineyard', 'Garden',
    'Arbor', 'Bower', 'Hedge', 'Willow', 'Cedar', 'Aspen', 'Birch', 'Maple',
    'Alder', 'Elm', 'Oak', 'Pine', 'Spruce', 'Redwood', 'Sequoia', 'Juniper',
    'Cypress', 'Palm', 'Ivy', 'Clover', 'Heather', 'Thistle', 'Bramble', 'Reed',
    'Lily', 'Lotus', 'Iris', 'Aster', 'Dahlia', 'Poppy', 'Daisy', 'Comet',
    'Meteor', 'Nova', 'Nebula', 'Galaxy', 'Cosmos', 'Orbit', 'Eclipse', 'Aurora',
    'Zenith', 'Apex', 'Halo', 'Corona', 'Prism', 'Spectrum', 'Beacon', 'Lantern',
    'Cinder', 'Spark', 'Flame', 'Blaze', 'Glow', 'Shimmer', 'Glimmer', 'Mirage',
    'Echo', 'Pulse', 'Ripple', 'Wave', 'Tide', 'Current', 'Eddy', 'Vortex',
    'Gust', 'Breeze', 'Zephyr', 'Gale', 'Squall', 'Tempest', 'Monsoon', 'Thunder',
    'Storm', 'Cloud', 'Mist', 'Haze', 'Frost', 'Dew', 'Rime', 'Drizzle',
    'Quartz', 'Granite', 'Basalt', 'Flint', 'Agate', 'Opal', 'Garnet', 'Topaz',
    'Beryl', 'Peridot', 'Malachite', 'Geode', 'Monolith', 'Obelisk', 'Spire', 'Citadel',
    'Bastion', 'Rampart', 'Tower', 'Voyager', 'Drifter', 'Nomad', 'Pilgrim', 'Ranger',
    'Sentinel', 'Warden', 'Herald', 'Oracle', 'Cipher', 'Lighthouse', 'Wayfarer', 'Compass',
  ],
};

// Percussion / drums / loops — punchy, kinetic, mechanical, stormy. The big
// pool (~11k sounds): ~140·~170 ≈ 23k pairs.
const PERCUSSION: Pool = {
  adjectives: [
    'Pounding', 'Driving', 'Relentless', 'Booming', 'Thumping', 'Pumping', 'Churning', 'Rolling',
    'Galloping', 'Kinetic', 'Frenzied', 'Surging', 'Gritty', 'Heavy', 'Punchy', 'Tight',
    'Snappy', 'Funky', 'Greasy', 'Swinging', 'Bouncing', 'Hypnotic', 'Pulsing', 'Throbbing',
    'Steady', 'Rapid', 'Breakneck', 'Thundering', 'Crashing', 'Slamming', 'Stomping', 'Marching',
    'Hammering', 'Grinding', 'Roaring', 'Blasting', 'Banging', 'Knocking', 'Rattling', 'Clanking',
    'Sizzling', 'Crackling', 'Popping', 'Snapping', 'Ticking', 'Tapping', 'Shuffling', 'Strutting',
    'Prowling', 'Charging', 'Raging', 'Restless', 'Frantic', 'Savage', 'Brutal', 'Fierce',
    'Mighty', 'Massive', 'Colossal', 'Titanic', 'Hulking', 'Burly', 'Rugged', 'Rowdy',
    'Reckless', 'Ruthless', 'Rampant', 'Turbo', 'Nitro', 'Hyper', 'Manic', 'Jittery',
    'Twitchy', 'Electric', 'Magnetic', 'Atomic', 'Seismic', 'Volcanic', 'Molten', 'Blazing',
    'Scorching', 'Searing', 'Burning', 'Fiery', 'Sparking', 'Stormy', 'Thunderous', 'Torrential',
    'Howling', 'Whirling', 'Cyclonic', 'Choppy', 'Jagged', 'Spiky', 'Coarse', 'Rough',
    'Dusty', 'Murky', 'Grimy', 'Grungy', 'Crusty', 'Crunchy', 'Brittle', 'Dense',
    'Solid', 'Compact', 'Leaden', 'Iron', 'Steely', 'Concrete', 'Stony', 'Flinty',
    'Brassy', 'Tinny', 'Metallic', 'Mechanical', 'Robotic', 'Glitchy', 'Stuttering', 'Skittering',
    'Clattering', 'Bristling', 'Feral', 'Bold', 'Brisk', 'Swift', 'Nimble', 'Sharp',
    'Hardy', 'Dirty', 'Filthy', 'Nasty', 'Slick', 'Sweaty', 'Smoking', 'Live',
    'Amped', 'Wired', 'Rumbling', 'Pounded',
  ],
  nouns: [
    'Thunder', 'Boom', 'Slam', 'Crack', 'Smash', 'Bang', 'Knock', 'Thud',
    'Clap', 'Snap', 'Crash', 'Blast', 'Burst', 'Jolt', 'Punch', 'Stomp',
    'Stamp', 'Strut', 'Shuffle', 'Bounce', 'Swing', 'Groove', 'Pocket', 'Pulse',
    'Beat', 'Throb', 'Roll', 'Fill', 'Break', 'Hustle', 'Riot', 'Frenzy',
    'Rumble', 'Tremor', 'Quake', 'Rupture', 'Surge', 'Torrent', 'Cascade', 'Avalanche',
    'Stampede', 'Gallop', 'Charge', 'Sprint', 'Dash', 'Rush', 'Drive', 'Motor',
    'Engine', 'Piston', 'Turbine', 'Dynamo', 'Reactor', 'Furnace', 'Forge', 'Anvil',
    'Hammer', 'Mallet', 'Sledge', 'Gear', 'Cog', 'Crank', 'Bolt', 'Rivet',
    'Cylinder', 'Boiler', 'Generator', 'Throttle', 'Cyclone', 'Tornado', 'Monsoon', 'Tempest',
    'Squall', 'Maelstrom', 'Vortex', 'Whirlwind', 'Hurricane', 'Typhoon', 'Inferno', 'Blaze',
    'Ember', 'Cinder', 'Spark', 'Flare', 'Volt', 'Circuit', 'Coil', 'Pylon',
    'Block', 'Yard', 'Alley', 'Subway', 'Junction', 'Depot', 'Garage', 'Warehouse',
    'Foundry', 'Factory', 'Mill', 'Quarry', 'Pit', 'Den', 'Cellar', 'Rooftop',
    'Stallion', 'Mustang', 'Bronco', 'Cheetah', 'Jaguar', 'Panther', 'Cobra', 'Viper',
    'Rhino', 'Bison', 'Buffalo', 'Bull', 'Ram', 'Boar', 'Wolf', 'Hawk',
    'Falcon', 'Raven', 'Barrel', 'Keg', 'Crate', 'Kettle', 'Cannon', 'Mortar',
    'Jackhammer', 'Bulldozer', 'Locomotive', 'Freight', 'Diesel', 'Tractor', 'Thresher', 'Grinder',
    'Crusher', 'Pendulum', 'Metronome', 'Clockwork', 'Ratchet', 'Hatchet', 'Cleaver', 'Gavel',
    'Conga', 'Bongo', 'Timbale', 'Cowbell', 'Tambourine', 'Woodblock', 'Clave', 'Rimshot',
    'Backbeat', 'Downbeat', 'Offbeat', 'Stomper', 'Banger', 'Slapper', 'Knocker', 'Quarrel',
  ],
};

// Bass — deep, low, weighty, subterranean.
const BASS: Pool = {
  adjectives: [
    'Deep', 'Low', 'Sub', 'Fat', 'Round', 'Warm', 'Thick', 'Heavy',
    'Dark', 'Dubby', 'Woody', 'Rubbery', 'Plump', 'Mellow', 'Smooth', 'Molten',
    'Boomy', 'Velvet', 'Murky', 'Cavernous', 'Rolling', 'Throbbing', 'Pulsing', 'Earthy',
    'Muddy', 'Grounded', 'Solid', 'Dense', 'Gravelly', 'Bottomless', 'Subsonic', 'Seismic',
    'Brooding', 'Sultry', 'Greasy', 'Funky', 'Slinky', 'Liquid', 'Plush', 'Sunken',
  ],
  nouns: [
    'Fathom', 'Trench', 'Abyss', 'Depth', 'Bedrock', 'Undertow', 'Cavern', 'Cellar',
    'Basement', 'Trough', 'Hollow', 'Mire', 'Magma', 'Mantle', 'Crater', 'Canyon',
    'Gorge', 'Ravine', 'Pit', 'Well', 'Vault', 'Tremor', 'Rumble', 'Quake',
    'Tide', 'Current', 'Drift', 'Whale', 'Leviathan', 'Mammoth', 'Walrus', 'Bison',
    'Boulder', 'Anchor', 'Keel', 'Ballast', 'Foghorn', 'Tuba', 'Drone', 'Lowland',
  ],
};

// Keys / piano — elegant, classic, wistful, candlelit.
const KEYS: Pool = {
  adjectives: [
    'Mellow', 'Bright', 'Grand', 'Velvet', 'Crystal', 'Glassy', 'Pearly', 'Silken',
    'Warm', 'Tender', 'Wistful', 'Dreamy', 'Hazy', 'Misty', 'Moonlit', 'Candlelit',
    'Sepia', 'Vintage', 'Antique', 'Classic', 'Elegant', 'Gilded', 'Ivory', 'Lush',
    'Gentle', 'Delicate', 'Plaintive', 'Nostalgic', 'Romantic', 'Twilit', 'Amber', 'Golden',
    'Faded', 'Rainy', 'Autumnal', 'Hushed', 'Lyric', 'Wandering', 'Quiet', 'Soulful',
  ],
  nouns: [
    'Nocturne', 'Sonata', 'Cadence', 'Prelude', 'Chapel', 'Salon', 'Parlor', 'Recital',
    'Ballad', 'Lullaby', 'Reverie', 'Serenade', 'Etude', 'Refrain', 'Chorale', 'Hymn',
    'Vesper', 'Aria', 'Ivory', 'Felt', 'Octave', 'Keystone', 'Candle', 'Mantel',
    'Window', 'Rainfall', 'Snowfall', 'Meadow', 'Willow', 'Garden', 'Veranda', 'Attic',
    'Fireside', 'Hearth', 'Lamplight', 'Dusk', 'Dawn', 'Memory', 'Letter', 'Locket',
  ],
};

// Synth / lead — neon, electric, cosmic, futuristic.
const SYNTH: Pool = {
  adjectives: [
    'Neon', 'Electric', 'Voltaic', 'Hyper', 'Digital', 'Chrome', 'Laser', 'Cosmic',
    'Astral', 'Stellar', 'Solar', 'Lunar', 'Quantum', 'Atomic', 'Plasma', 'Holographic',
    'Glowing', 'Radiant', 'Luminous', 'Iridescent', 'Prismatic', 'Cyber', 'Retro', 'Vapor',
    'Synthetic', 'Analog', 'Pulsing', 'Shimmering', 'Glitchy', 'Crystalline', 'Galactic', 'Nebular',
    'Ionic', 'Magnetic', 'Phantom', 'Spectral', 'Ultra', 'Turbo', 'Photonic', 'Lucid',
  ],
  nouns: [
    'Neon', 'Circuit', 'Voltage', 'Laser', 'Photon', 'Hologram', 'Matrix', 'Grid',
    'Vector', 'Pixel', 'Prism', 'Spectrum', 'Comet', 'Nova', 'Nebula', 'Quasar',
    'Pulsar', 'Galaxy', 'Orbit', 'Satellite', 'Module', 'Oscillator', 'Synapse', 'Neuron',
    'Cortex', 'Android', 'Cyborg', 'Drone', 'Beacon', 'Halo', 'Aurora', 'Plasma',
    'Reactor', 'Dynamo', 'Vapor', 'Mirage', 'Glimmer', 'Flux', 'Surge', 'Signal',
  ],
};

// Orchestral / brass / strings — cinematic, regal, sweeping.
const ORCHESTRAL: Pool = {
  adjectives: [
    'Grand', 'Majestic', 'Regal', 'Noble', 'Sweeping', 'Soaring', 'Lush', 'Cinematic',
    'Epic', 'Heroic', 'Triumphant', 'Solemn', 'Stately', 'Lofty', 'Towering', 'Radiant',
    'Golden', 'Crimson', 'Velvet', 'Opulent', 'Ornate', 'Baroque', 'Imperial', 'Glorious',
    'Hallowed', 'Sacred', 'Celestial', 'Luminous', 'Vast', 'Boundless', 'Windswept', 'Storied',
    'Timeless', 'Ancient', 'Gilded', 'Valiant', 'Verdant', 'Resplendent', 'Sublime', 'Stirring',
  ],
  nouns: [
    'Cathedral', 'Citadel', 'Palace', 'Colosseum', 'Rotunda', 'Basilica', 'Vista', 'Summit',
    'Horizon', 'Crescendo', 'Overture', 'Fanfare', 'Anthem', 'Requiem', 'Symphony', 'Movement',
    'Tapestry', 'Banner', 'Crest', 'Crown', 'Scepter', 'Throne', 'Empire', 'Dynasty',
    'Legion', 'Vanguard', 'Cavalry', 'Aurora', 'Meridian', 'Zenith', 'Pinnacle', 'Spire',
    'Colonnade', 'Gallery', 'Atrium', 'Forum', 'Highland', 'Glade', 'Cascade', 'Procession',
  ],
};

// Guitars — organic, dusty, road-and-frontier.
const GUITAR: Pool = {
  adjectives: [
    'Dusty', 'Rustic', 'Twangy', 'Jangly', 'Smoky', 'Whiskey', 'Worn', 'Weathered',
    'Sunbaked', 'Roadworn', 'Lonesome', 'Drifting', 'Wandering', 'Restless', 'Gritty', 'Mellow',
    'Warm', 'Woody', 'Amber', 'Golden', 'Crimson', 'Velvet', 'Hazy', 'Rolling',
    'Open', 'Backwoods', 'Highland', 'Lowland', 'Bluesy', 'Soulful', 'Easy', 'Lazy',
    'Breezy', 'Sunlit', 'Moonlit', 'Vintage', 'Frontier', 'Wild', 'Rambling', 'Brassy',
  ],
  nouns: [
    'Canyon', 'Mesa', 'Prairie', 'Saloon', 'Outpost', 'Frontier', 'Trail', 'Highway',
    'Backroad', 'Crossroad', 'Junction', 'Dustbowl', 'Badlands', 'Ridge', 'Bluff', 'Gulch',
    'Ranch', 'Homestead', 'Bonfire', 'Campfire', 'Hearth', 'Porch', 'Veranda', 'Holler',
    'Hollow', 'Creek', 'River', 'Delta', 'Bayou', 'Levee', 'Willow', 'Cedar',
    'Sagebrush', 'Tumbleweed', 'Cactus', 'Coyote', 'Mustang', 'Drifter', 'Rambler', 'Sunset',
  ],
};

// FX / texture — ethereal, atmospheric, abstract.
const FX: Pool = {
  adjectives: [
    'Ethereal', 'Ghostly', 'Spectral', 'Phantom', 'Vapor', 'Misty', 'Hazy', 'Foggy',
    'Smoky', 'Drifting', 'Floating', 'Hovering', 'Shimmering', 'Glistening', 'Iridescent', 'Prismatic',
    'Glassy', 'Crystalline', 'Hollow', 'Distant', 'Faint', 'Echoing', 'Cavernous', 'Submerged',
    'Liquid', 'Frozen', 'Glacial', 'Astral', 'Cosmic', 'Nebular', 'Celestial', 'Auroral',
    'Twilit', 'Dreamy', 'Surreal', 'Alien', 'Eerie', 'Haunting', 'Whispering', 'Veiled',
  ],
  nouns: [
    'Mist', 'Haze', 'Fog', 'Vapor', 'Aether', 'Ether', 'Nebula', 'Aurora',
    'Halo', 'Veil', 'Shroud', 'Phantom', 'Specter', 'Wraith', 'Echo', 'Reverb',
    'Drone', 'Whisper', 'Murmur', 'Breath', 'Sigh', 'Pulse', 'Ripple', 'Mirage',
    'Apparition', 'Glimmer', 'Shimmer', 'Gleam', 'Flicker', 'Aura', 'Ambience', 'Horizon',
    'Abyss', 'Void', 'Expanse', 'Chasm', 'Cavern', 'Dream', 'Trance', 'Vision',
  ],
};

// Vocals — airy, choral, human.
const VOCAL: Pool = {
  adjectives: [
    'Airy', 'Breathy', 'Angelic', 'Celestial', 'Choral', 'Soulful', 'Heavenly', 'Velvet',
    'Silken', 'Tender', 'Gentle', 'Lilting', 'Honeyed', 'Golden', 'Radiant', 'Luminous',
    'Ethereal', 'Hushed', 'Whispered', 'Sighing', 'Soaring', 'Floating', 'Dreamy', 'Wistful',
    'Warm', 'Sweet', 'Sublime', 'Sacred', 'Hymnal', 'Resonant', 'Echoing', 'Lyric',
    'Mellow', 'Crystal', 'Pure', 'Glowing', 'Serene', 'Tranquil', 'Wandering', 'Bright',
  ],
  nouns: [
    'Choir', 'Aria', 'Halo', 'Hymn', 'Vesper', 'Chorale', 'Chant', 'Refrain',
    'Anthem', 'Lullaby', 'Serenade', 'Carol', 'Psalm', 'Cantata', 'Descant', 'Harmony',
    'Melody', 'Cadence', 'Echo', 'Breath', 'Sigh', 'Whisper', 'Murmur', 'Spirit',
    'Angel', 'Seraph', 'Muse', 'Siren', 'Nightingale', 'Lark', 'Dove', 'Aurora',
    'Dawn', 'Cathedral', 'Chapel', 'Sanctuary', 'Reverie', 'Veil', 'Bloom', 'Grace',
  ],
};

/** Family → themed pool. Families absent here use {@link GENERIC}. */
const FAMILY_POOL: Record<InstrumentSheetFamily, Pool> = {
  fx: FX,
  drumKits: PERCUSSION,
  kickDrums: PERCUSSION,
  snareDrums: PERCUSSION,
  clapsSnaps: PERCUSSION,
  hiHatsClosed: PERCUSSION,
  hiHatsOpen: PERCUSSION,
  toms: PERCUSSION,
  cymbals: PERCUSSION,
  shakers: PERCUSSION,
  percussionBreaks: PERCUSSION,
  percussionLoops: PERCUSSION,
  percussionMisc: PERCUSSION,
  basses: BASS,
  keys: KEYS,
  synths: SYNTH,
  leadSynths: SYNTH,
  orchestral: ORCHESTRAL,
  popBrass: ORCHESTRAL,
  popStrings: ORCHESTRAL,
  acousticGuitars: GUITAR,
  electricGuitars: GUITAR,
  vocals: VOCAL,
};

/** The themed word pool a family draws its name from. */
export function poolForFamily(family: InstrumentSheetFamily): Pool {
  return FAMILY_POOL[family] ?? GENERIC;
}

function poolSize(pool: Pool): number {
  return pool.adjectives.length * pool.nouns.length;
}

/** Total distinct pairs in the generic fallback pool (back-compat helper). */
export function nameSpaceSize(): number {
  return poolSize(GENERIC);
}

function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned range without BigInt.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** The `<Adjective> <Noun>` pair at a flat index into a pool's name space. */
function pairIn(pool: Pool, index: number): string {
  const n = poolSize(pool);
  const i = ((index % n) + n) % n;
  const adj = pool.adjectives[i % pool.adjectives.length]!;
  const noun = pool.nouns[Math.floor(i / pool.adjectives.length) % pool.nouns.length]!;
  return `${adj} ${noun}`;
}

/** The generic-pool pair at a flat index (back-compat for {@link baseNameFor}). */
function pairAt(index: number): string {
  return pairIn(GENERIC, index);
}

/** Deterministic *base* (pre-collision-probe) real-word name for a key. */
export function baseNameFor(key: string): string {
  return pairAt(fnv1a32(key));
}

export interface ResolveAliasesInput {
  readonly entries: readonly InstrumentEntry[];
  /** Existing registry aliases (soundIdentity → name). Pinned: never
   *  regenerated, never renamed, and reserved so generated names can't
   *  collide with them. */
  readonly existing?: Record<string, string>;
}

export interface ResolveAliasesResult {
  /** catalog id → final public name (every input entry; rows sharing a
   *  sound identity share a name). For filling the per-row name cell. */
  readonly byId: Map<string, string>;
  /** soundIdentity → final public name. The registry's keyspace. */
  readonly byIdentity: Map<string, string>;
  /** catalog id → its soundIdentity. */
  readonly identityById: Map<string, string>;
  /** Distinct sound identities kept from the existing registry. */
  readonly kept: number;
  /** Distinct sound identities freshly generated. */
  readonly generated: number;
  /** Generated names whose first-choice pair was taken and were probed to
   *  a later free pair. Still a clean two-word name — never suffixed. */
  readonly probed: number;
}

/**
 * Resolve a public real-word name for every sound identity.
 *
 * Names are keyed on the style-free {@link deriveSoundIdentity}, so catalog
 * rows that differ only by style/key-listing share a name and a name never
 * changes when a sound is re-tagged. Pinned-existing-wins; the rest are
 * generated by deterministic open addressing over the `<Adjective> <Noun>`
 * name space: hash the identity to a starting pair, then linear-probe to the
 * next free pair if taken. The name space (~28k pairs) far exceeds the
 * identity count (~12k), so every generated name stays a clean two-word pair
 * with no numeric suffix. Identities are processed sorted so assignment is
 * reproducible.
 */
export function resolveAliases(input: ResolveAliasesInput): ResolveAliasesResult {
  const existing = input.existing ?? {};
  const byId = new Map<string, string>();
  const byIdentity = new Map<string, string>();
  const identityById = new Map<string, string>();
  const familyByIdentity = new Map<string, InstrumentSheetFamily>();
  const used = new Set<string>();

  let kept = 0;
  let generated = 0;
  let probed = 0;

  // Map every entry to its sound identity (+ family); collect distinct ids.
  for (const e of input.entries) {
    const identity = deriveSoundIdentity(e);
    identityById.set(e.id, identity);
    if (!familyByIdentity.has(identity)) familyByIdentity.set(identity, e.family);
  }
  const identities = [...new Set(identityById.values())].sort();

  // Probe a pool for the first free `<Adjective> <Noun>` pair from `start`.
  const pickFree = (pool: Pool, start: number): { name: string; step: number } | null => {
    const size = poolSize(pool);
    for (let step = 0; step < size; step++) {
      const name = pairIn(pool, start + step);
      if (!used.has(name)) return { name, step };
    }
    return null;
  };

  // Pass 1: reserve all pinned names so generation never collides with them.
  for (const identity of identities) {
    const pinned = existing[identity];
    if (pinned !== undefined) used.add(pinned);
  }

  // Pass 2: assign one name per identity. Pinned identities keep their name;
  // the rest draw from their FAMILY's themed pool (drums get drummy names,
  // bass deep ones, etc.), probing to the next free pair on collision and
  // falling back to the generic pool only if the themed one is exhausted.
  for (const identity of identities) {
    const pinned = existing[identity];
    if (pinned !== undefined) {
      byIdentity.set(identity, pinned);
      kept++;
      continue;
    }
    const family = familyByIdentity.get(identity);
    const themed = family ? poolForFamily(family) : GENERIC;
    const start = fnv1a32(identity);

    let name: string;
    const themedPick = pickFree(themed, start);
    const pick = themedPick ?? pickFree(GENERIC, start);
    if (pick) {
      name = pick.name;
      if (pick.step > 0 || themedPick === null) probed++; // probed or fell back
    } else {
      // Both pools full (would need tens of thousands of names). Fall back to
      // a numeric suffix so we still return a unique name.
      const base = pairIn(GENERIC, start);
      let n = 2;
      while (used.has(`${base} ${n}`)) n++;
      name = `${base} ${n}`;
      probed++;
    }
    used.add(name);
    byIdentity.set(identity, name);
    generated++;
  }

  // Fan the per-identity names back out to every catalog id.
  for (const [id, identity] of identityById) byId.set(id, byIdentity.get(identity)!);

  return { byId, byIdentity, identityById, kept, generated, probed };
}

/** Build a committed registry object from a resolved identity→name map,
 *  with keys identity-sorted for a stable on-disk diff. */
export function buildAliasRegistry(byIdentity: ReadonlyMap<string, string>): AliasRegistry {
  const aliases: Record<string, string> = {};
  for (const identity of [...byIdentity.keys()].sort()) aliases[identity] = byIdentity.get(identity)!;
  return {
    $description: ALIAS_REGISTRY_DESCRIPTION,
    generator: ALIAS_GENERATOR_ID,
    aliases,
  };
}
