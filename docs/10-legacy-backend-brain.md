# 10 — Legacy backend "brain": `casperaki2-engine-js`

> Origin: `firelex/casperaki2` · Node/Express · ~433 JS files · last active 2024-04.
> This is **the generation engine** — the most valuable legacy code. Everything
> about *what* the music plays is decided here.

## Stack

- **Runtime/framework:** Node.js + Express (`server.js`, ~399 lines). Router mounted
  at `/`, body limit 10 MB, CORS, Passport sessions.
- **DB/ORM:** **Sequelize 5** over **PostgreSQL** (`helpers/sequelize-connect.js`).
  Env: `POSTGRES_HOST/PORT/DB/USER/PWD`. Pool min 1 / max 20. Default db `casperaki`.
- **Auth:** Passport local (email/password) + sessions; some controllers accept a
  JWT bearer (`director.js`).
- **Async jobs:** **Bull** queue over **Redis** (`redis://localhost:6379`) for audio
  rendering, processed by a separate `RenderProcess.js` worker.
- **Migrations:** Umzug, auto-run on boot (`migrations/`, ~19 files).
- **Config:** `config/app.json` + per-env overrides in `config/custom/{NODE_ENV}.json`,
  merged by `services/config.js`.

## API surface (`api/v1.0/routes/*`)

~30 route groups / 20 controllers. Highlights (★ = triggers generation):

| Resource | Purpose |
|---|---|
| ★ `arrangements` | `/getArrangement`, `/getArrangementFull` — generate instrument patterns per segment |
| ★ `chords` | add harmonic progressions to a song |
| ★ `songStructures` | generate verse/chorus/bridge/outro segment forms |
| ★ `patterns` | retrieve/generate drum/bass/melody patterns |
| ★ `notator` | `/print` — arrangement → ABC notation → PDF (via `abcm2ps`) |
| ★ `renderer` | `/render1`, `/renderjob/:id` — song → REAPER `.rpp` → WAV/MP3 (Bull/Redis) |
| ★ `vocals` | `/getMelody`, `/getBackingVocals`, `/getStressPattern`, `/extractMelody` |
| ★ `lyrics`, `lyricsSnippets`, `lyricsSnippetsBlueprints` | lyric DB query + snippet generation |
| ★ `director` | `/createLyricVideo*` — ffmpeg lyric-overlay video |
| `importExport` | import MIDI/JSON; export REAPER `.rpp` |
| `songs` | CRUD; song JSON persisted in Postgres `details` JSONB |
| `instruments`, `drumKits`, `vstSamples`, `virtualGuitaristSamples` | sample/VST catalog |
| `effects`, `fx` | FX chain assignment |
| `transitions` | fills / transitions between sections |
| `auth`, `users`, `permissions`, `config`, `metadata`, `core`, `precedents`, `webAudioSettings` | platform/support |

## The generation pipeline

Core classes under `api/v1.0/services/classes/`:

### 1. Song structure & chords
- `SongStructureClass` — produces the segment list (Intro/Verse/Chorus/…) with bar
  counts per genre.
- `chords/ChordsClass.js` (+ `chords.json`, `precedents.json`) — assigns chord
  progressions per segment, optionally guided by genre "precedents" (reference songs).

### 2. Arrangement — `arrangements/ArrangementsClass.js` (~30 KB, the orchestrator)
Input: a `song` object with `genre`, `tempo`, `key`, `songStructure`, and a core
`patterns[0].pattern` (drums/bass/guitars). Process:
1. Reset arrangement per segment; classify instruments into groups
   (`instrumentGroups.json`: bass, drums, pads, synths, keys, strings, brass, vocals…).
2. For each instrument, select a concrete instrument from the Postgres `Instruments`
   table filtered by `lowLevelType` + genre tags (random, dedup).
3. Run the matching **pattern generator** to produce bars→notes:
   - `patterns/bassPatterns/*` (EDM, HipHop, Library, Simple, SM variants)
   - `GuitarPatternGenerator`, `PadPatternGenerator`, `PianoPatternGenerator`,
     `StringPatternGenerator`, `SynthPatternGenerator`, `BrassPatternGenerator`
   - drums via `drums.js` rules + huge pattern banks
4. Output: `song.arrangement[segment].instruments` with ids, patterns, volumes.

Genre-specific procedural generators also live under
`services/arrangements/{bass,drums,guitar,piano,pad,vocals,keshaSynth}/{hipHop,upTempo}/arrangement.js`
plus melody/rhythm pattern data (`_melodyNotesPatterns.js` 31 KB,
`_melodyRhythmPatterns.js` 25 KB).

### 3. Lyrics & vocals — `lyricsSnippets/LyricsSnippetsGeneratorClass.js`
- `getSyllables()` — words → stress pattern (stressed/unstressed) from `syllables.json` (21 MB).
- `getRelevantPhoneme()` — word → CMU phoneme; `cmuToVocaloid.json` maps CMU → Vocaloid
  phoneme set. Phonemes are embedded on each vocal note (`vocaloidPhonemes`) for a
  Vocaloid-style VST to sing. **Vocal *audio* synthesis is not done here** — only the
  phoneme/melody data is generated (actual singing happens in the render layer / external Vocaloid).
- Lyric DBs: `lyrics.json` (7.4 MB), `lyricLines.json` (15 MB), `dirtyRhymes.json`.

### 4. Notation — `notator/NotatorClass.js`
Extracts lead-vocal notes → ABC notation string → spawns `abcm2ps` → EPS → PDF
(sheet music).

### 5. Render (legacy path) — `renderer/RendererClass.js` + `RenderProcess.js`
- `_createTrackMap` / `_createGroupTracks` map song instruments to REAPER group tracks
  (Σ BASSES, Σ DRUMS, …) and emit a REAPER **`.rpp`** project (templates in
  `reaperClasses/`).
- A Bull job spawns `reaper.exe -renderproject casperaki.rpp` (Windows), transcodes
  WAV→MP3 with `lame.exe`, uploads to **S3 bucket `casperaki`**, updates `Jobs` table.

### 6. Director (video) — `director/DirectorClass.js`
Extracts vocal lyric timing, builds ffmpeg `drawtext` filter chains, composes an
`output.mp4` lyric video. Producer "styles": casperaki / sugarTunez / flowmaster /
albertEinstein.

## Song data model

Persisted in Postgres `songs.details` (JSONB). Shape (abridged):

```jsonc
{
  "genre": "pop", "tempo": 120, "key": "C", "producer": "casperaki",
  "songStructure": [ { "segment": "Verse1", "bars": 8, "type": "Verse",
                       "chords": [{ "bar": 0, "chord": "Cmaj7" }] } ],
  "patterns": [ { "pattern": [ { "instrumentType1": "drums", "instrumentId": 123,
                                 "bars": [ { "notes": { "0": [/*note*/] } } ] } ] } ],
  "arrangement": {
    "Verse1": {
      "instruments": { "Guitar 1": { "id": 789, "pattern": {/*…*/}, "volume": -3 } },
      "overrides":   { "Lead vocals": { "bars": [ { "notes": {
          "0": [{ "note": 60, "duration": 1, "fullWord": "Hello",
                  "vocaloidPhonemes": ["h","e"] }] } } ] } },
      "transitions": {}, "fills": {}, "mutes": {}, "signalProcessors": {}
    }
  }
}
```

See [`20-song-data-format.md`](20-song-data-format.md) for the engine-facing contract
(the same data, slightly different envelope, that the C++ engine consumes).

## External dependencies (the "ops" baggage to drop in the rebuild)

- **REAPER** (Windows CLI) for rendering — platform-bound, heavyweight.
- **LAME**, **ffmpeg**, **abcm2ps** binaries.
- **AWS S3** (⚠️ **credentials hardcoded** in `RenderProcess.js` — do not reuse).
- **Postgres** + **Redis**.
- Big static asset banks (3 GB clone): pattern JSONs (multi-MB) + `syllables.json` (21 MB).

## What to keep vs. drop

**Keep (port the logic):** the arrangement/pattern generators, chord/precedent data,
song structure logic, lyric/phoneme generation, and the **song JSON schema**.

**Drop / replace:** REAPER server render (→ use `casperaki_engine` WASM), hardcoded
S3 creds, Passport/session auth (→ teamsuzie auth), Sequelize-5 patterns, the
ffmpeg video director (nice-to-have, later).
