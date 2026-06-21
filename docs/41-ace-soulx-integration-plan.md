# 41 — ACE-Step 1.5 & SoulX-Singer integration plan

> How the generative music model (**ACE-Step 1.5**) and the singing-synthesis model
> (**SoulX-Singer**) plug into the rebuilt four-layer architecture from
> [`50-engineering-plan.md`](50-engineering-plan.md), with the **canonical `song.json`** from
> [`20-song-data-format.md`](20-song-data-format.md) as the contract that ties
> deterministic generation, AI augmentation, and rendering together.

## Guiding principle: deterministic first, AI second

The brain emits canonical `song.json` and the engine renders deterministic
guide audio + stems. **Only then** are AI models invoked, and they are
**conditioned on Casperaki's own render** so they inherit harmony, tempo, structure,
and groove rather than inventing parallel music.

```
brain ──song.json──▶ engine (WASM/native) ──guide-render + stems──▶
                                                                    ├──▶ ACE-Step ── stylized music stem(s)
                                                                    └──▶ SoulX-Singer ── sung vocal stem(s)
                                                                                              │
                                            (AI artifacts attached back to song.json) ◀──────┘
```

This keeps the system **reproducible** (the deterministic skeleton survives any AI
re-roll), **debuggable** (every artifact has full provenance), and **layered** (AI is
an additive embellishment, not the source of truth).

## 1. AI artifact model on `song.json`

Add an optional top-level `aiArtifacts` array on the canonical schema. Keep
`schemaVersion: "1"` unless/until we introduce a breaking schema change; `aiArtifacts`
is an optional canonical field that legacy engine adapters strip before calling the
current C++ engine.
Artifacts are **append-only references** — never inlined audio. Inline audio bloats
fixtures and breaks diff-ability. Storage goes to the object store (§5); the
artifact entry is the metadata pointer + provenance.

```jsonc
// song.json (top level — new optional field)
"aiArtifacts": [
  {
    "id": "art_01HZ8…",                 // ULID
    "kind": "ace-step.music",           // see "kinds" below
    "scope": { "type": "song" },        // or { type: "segment", segment: "chorus" }
                                        // or { type: "instrument", instrument: "Vocals" }
    "createdAt": "2026-06-06T14:21:08Z",
    "supersedes": "art_01HZ7…",         // optional — re-roll chain
    "active": true,                     // only one active per (kind, scope)

    "audio": {
      "artifactUri": "artifact://song_42/art_01HZ8",
      "resolvedUri": "file://./var/artifacts/song_42/art_01HZ8.flac",
      "format":  "flac", "sampleRate": 48000, "channels": 2,
      "lufs":   -14.1, "durationSec": 187.4,
      "sha256":  "8b1d…",
      "timeline": {
        "suggestedStartSec": 62.4,
        "userOffsetSec": 0.0,
        "snapToGrid": true
      }
    },

    "provenance": { /* see §2 */ },

    "conditioning": { /* see §3 / §4 — kind-specific */ },

    "human": {                          // optional UX metadata
      "label":  "Chorus — warmer pads",
      "rating": 4,                      // 0–5 from the user
      "notes":  "Keep — better than take 2"
    }
  }
]
```

**Artifact kinds (canonical v1 optional field):**

| `kind` | Producer | Typical `scope` | Notes |
|---|---|---|---|
| `ace-step.music` | ACE-Step 1.5 | song / segment | Full music stem conditioned on guide render |
| `ace-step.stem` | ACE-Step 1.5 | instrument | Single-instrument stem (e.g. "warm pad layer") |
| `soulx.vocal` | SoulX-Singer | song / segment | Sung lead conditioned on melody+lyrics |
| `soulx.vocal.harmony` | SoulX-Singer | segment | Harmony / double-track variant |
| `matchering.master` | Matchering | song | Final master (existing, retro-fit into this model) |
| `sam-audio.stem` | SAM-Audio | instrument | Extracted stem (used as conditioning, also stored) |

**Selection semantics.** The web app's mixer reads `aiArtifacts` and, for each
(kind, scope) pair, plays the selected artifact (or falls back to the deterministic
engine render). Re-rolls chain via `supersedes`, giving a non-destructive history.
For single-user/local workflows `active: true` can live on the artifact; if/when
collaboration or mix variants matter, active selections should move to a separate
mix/session state so the artifact list stays append-only.

**Timeline alignment.** AI audio is allowed to arrive slightly early/late. The artifact
stores a suggested start position and a user offset; the graphical editor lets the
user drag/nudge the generated waveform over the deterministic backing track until the
phrasing sits perfectly. Alignment is therefore both machine-suggested and musically
editable, just like audio in a DAW.

## 2. Provenance fields (reproducibility contract)

Every artifact carries enough to re-run it byte-for-byte (modulo model-internal
nondeterminism, which we also record). Reproducibility is the load-bearing reason
to deterministic-first — without it the AI passes become unauditable noise.

```jsonc
"provenance": {
  "model":      "ace-step",            // adapter id from services/_serving/adapters/
  "modelVersion": "1.5.0",
  "modelHash":  "sha256:…",            // weights digest at run time
  "adapterCommit": "casperaki@a1b2c3d",// commit of the harness/adapter code

  "songSchemaVersion": "1",
  "songHash":   "sha256:…",            // hash of the canonical song.json at gen time
  "engineCommit": "casperaki_engine@e4f5g6h",  // for the guide render that fed it
  "guideRenderHash": "sha256:…",       // hash of the conditioning audio/stems

  "params": {                          // ALL inference knobs, verbatim
    "seed": 1234567890,
    "steps": 30,
    "cfg": 7.0,
    "prompt": "warm analog synthwave, midnight drive",
    "negativePrompt": "lo-fi crackle"
    // … kind-specific keys
  },

  "deterministic": false,              // true ⇒ same inputs ⇒ same bytes
  "runtime": { "device": "cuda:0", "torch": "2.6.0+cu128", "duration_ms": 18420 }
}
```

**Why these specific fields:**

- `songHash` + `guideRenderHash` + `params` + `modelHash` is the minimal tuple
  that allows "re-run this exact artifact" on demand.
- `supersedes` (in the artifact) plus `provenance.seed` lets a user inspect a re-roll
  chain and pin a take.
- `deterministic: false` is honest: we record the seed but acknowledge ACE-Step is
  not bitwise reproducible across hardware. The hash chain is still useful for
  *audit*, even when bitwise reproduction fails.

## 3. ACE-Step conditioning workflow

ACE-Step 1.5 is **not** invoked from a free-text prompt alone. The brain composes a
**conditioning bundle** derived from the canonical song, and the adapter feeds
audio + structured musical context as guidance.

### 3.1 Flow

```
brain                       engine                       models/ace-step
─────                       ──────                       ───────────────
generate song.json   ─────▶
                            render guide audio
                            render per-instrument stems
                            export tempo/beat grid
                            ─────────────────────────▶
                                                        condition on guide audio
                                                        + structured musical ctx
                                                        + style prompt
                                                        ▼
                                                        sample music stem
                            ◀──── artifact (uri) ──────
attach to song.json ◀──
```

### 3.2 Conditioning bundle (per call)

The brain assembles, the adapter receives:

```jsonc
// POST /api/services/ace-step/generate
{
  "scope": { "type": "segment", "segment": "chorus" },
  "guideAudio": "artifact://song_42/guide-chorus",      // engine render of THIS segment
  "stems": {                                            // optional — for stem-targeted gen
    "drums":  "artifact://song_42/guide-chorus-drums",
    "bass":   "artifact://song_42/guide-chorus-bass"
  },
  "musical": {
    "bpm": 134, "key": "Fm", "timeSignature": "4/4",
    "barCount": 16,
    "chordProgression": ["Fm", "Db", "Ab", "Eb"],       // resolved from arrangement
    "downbeats": [0.0, 1.79, 3.58, … ]                  // seconds, for beat-aware sampling
  },
  "style": {
    "prompt": "warm analog synthwave chorus, big stereo pads, midnight drive",
    "negativePrompt": "lo-fi crackle, vinyl noise",
    "genre": "edm"                                      // pass-through from song.json
  },
  "params": { "seed": 1234567890, "steps": 30, "cfg": 7.0,
              "conditioningStrength": 0.85 }            // 1.0 = strict, 0.0 = ignore guide
}
```

The adapter must:

1. Resample the guide to ACE-Step's working sample rate.
2. Encode it into the model's conditioning input (audio2audio path or VAE latents).
3. Sample with the requested seed/params.
4. Tag the resulting audio with the `provenance` bundle from §2 and upload to the
   object store.
5. Return the artifact JSON for the brain to attach to `song.json`.

### 3.3 Modes

- **Whole-song stylize** — `scope: song`. ACE-Step re-imagines the full deterministic
  render in a target style. Cheap mix replacement.
- **Per-segment stylize** — `scope: segment`. Re-roll just the chorus, keep the verse.
  Cuts cost ~5–10× and is what users will actually want.
- **Stem augment** — `scope: instrument`. Generate a single layer (e.g. "thicker pad
  under the existing arrangement"). Output mixes additively in the web mixer.

### 3.4 Why condition on Casperaki's render (not just text)

Free-text ACE-Step ignores Casperaki's structure entirely — different key, tempo
drift, chorus where you expected a verse. Conditioning on the guide audio anchors
the AI output to **our** harmonic plan, **our** tempo grid, **our** form. The text
prompt only steers *timbre and style*, not *content*.

## 4. SoulX-Singer vocal workflow

SoulX-Singer takes **deterministic lyric+melody+score data** straight from
`song.json` (vocal notes already carry `fullWord`, MIDI pitch, duration, and
`endOfPhrase` per [`20-song-data-format.md`](20-song-data-format.md)) and produces a
sung vocal stem. Unlike ACE-Step, SoulX is primarily **score-driven**: the score is
authoritative, while a backing/karaoke render is optional context for phrasing and
timing.

### 4.1 Flow

```
brain                              engine                        models/soulx-singer
─────                              ──────                        ───────────────────
song.json has Vocals override ▶
(lyrics + MIDI melody per bar)
                                   render karaoke backing track  (guide minus vocals)
                                   export vocal melody as MIDI
                                   export lyric/phoneme timeline
                                   ─────────────────────────────▶
                                                                 align lyrics → melody
                                                                 sample sung performance
                                                                 ▼
                                   ◀──── artifact (uri) ─────────
attach to song.json ◀──
```

### 4.2 Score bundle (per call)

```jsonc
// POST /api/services/soulx-singer/generate
{
  "scope": { "type": "song" },                          // or per-segment
  "voice": {
    "voiceId": "soulx-en-soprano-01",                   // catalog entry
    "stylePrompt": "warm intimate pop delivery, slight rasp"
  },
  "score": {                                            // derived from song.json vocal notes
    "tempoMap": [ { "atSec": 0, "bpm": 134 } ],
    "notes": [
      { "atSec": 0.000, "durationSec": 0.45, "midi": 60, "syllable": "Hel",
        "phonemes": ["h","e"], "tieToNext": true },
      { "atSec": 0.450, "durationSec": 0.55, "midi": 60, "syllable": "lo",
        "phonemes": ["l","oʊ"], "endOfPhrase": true }
    ]
  },
  "backingTrack": "artifact://song_42/backing",         // for timing/phrasing reference
  "params": { "seed": 987654321, "expressiveness": 0.6, "vibratoDepth": 0.3 }
}
```

The vocal-notes shape in §20 already carries `fullWord`/`vocaloidPhonemes`/
`endOfPhrase` — those map almost 1:1 onto SoulX's score input. The brain owns the
syllable splitting and phoneme expansion; SoulX owns the acoustic performance.
If the generated vocal lands slightly ahead/behind the backing, the UI exposes it as
an audio clip with waveform, snap, and nudge controls so the user can align it by ear.

### 4.3 Modes

- **Lead vocal** — full song or per-segment. The dominant case.
- **Harmony layer** — same score, transposed +3/+5 semitones, different seed.
  Stored as `soulx.vocal.harmony` artifacts.
- **Ad-libs** — sparse-note score for a chorus tail. Same path, different `scope`.

### 4.4 Why score-driven (not prompt-driven)

A free-text "sing a chorus about midnight drives" gives a *different song*. SoulX
must respect the deterministic melody — that's the whole point of the brain
generating notes with pitch/duration/lyrics in the first place. The style prompt
only steers *timbre and expression*.

## 5. Caching & storage strategy

Audio artifacts are large and AI inference is expensive. The store is **content-
addressed** and the cache is keyed by the **conditioning bundle hash**, not by song
id — so re-rolling the same chorus with the same seed returns the cached take
instantly.

### 5.1 Object store layout

```
artifact-store://
  songs/<songId>/                       # per-song scratch
    guide/<songHash>/full.flac
    guide/<songHash>/stems/<inst>.flac
    artifacts/<artifactId>.flac
  cas/<sha256-prefix>/<sha256>.flac     # content-addressed dedup pool
```

Guide renders live under `songs/<songId>/guide/<songHash>/` — keyed by the canonical
song hash so editing the song invalidates them automatically. AI artifacts also dedup
into `cas/` so two takes that happen to be bitwise identical share storage.

### 5.2 Cache key

```
cacheKey = sha256(
  modelHash + adapterCommit +
  conditioningBundle (canonical-JSON)   # bundle from §3.2 / §4.2
)
```

A cache hit returns the existing artifact id; no inference runs. This makes
re-opening yesterday's project free even if it has 30 takes.

### 5.3 Eviction

- **Songs**: retain the deterministic guide render indefinitely (cheap to re-render
  anyway). Retain `active` AI artifacts indefinitely.
- **Superseded artifacts**: retain for 30 days, then move to cold storage, then drop
  at 180 days. The provenance is enough to re-generate.
- **CAS pool**: GC anything with zero references after 7 days.

### 5.4 Local dev fallback

`apps/models` already runs locally. Default the artifact store to
`./var/artifacts/` on disk; switch to S3-compatible (R2 / MinIO / S3) via env in
production. Canonical song data should keep provider-neutral `artifact://...` IDs;
the server resolves those to `file://`, signed HTTPS, S3/R2, or MinIO URLs as needed.

## 6. UI implications

The web editor needs to surface AI artifacts as **first-class layers** sitting
*alongside* deterministic engine output, not replacing it.

### 6.1 Mixer

- New track strips per active artifact: "🎹 ACE-Step — Chorus stylize",
  "🎤 SoulX — Lead vocal", with mute/solo/level the same as any other track.
- A toggle per (kind, scope) flips active artifact ↔ deterministic engine render
  ("A/B against the guide").
- The transport plays a mix of engine-rendered deterministic tracks **plus** selected
  AI artifacts. The playback layer sums them; whether that mixer lives in WASM, Web
  Audio, or a render service is an engine/frontend decision.
- AI artifacts appear as timeline audio clips with waveform, grid snap, drag, and
  fine nudge controls. The generated clip starts at `suggestedStartSec + userOffsetSec`;
  users can move it over the backing track until groove, syllables, and transients match.

### 6.2 Generation panel

- Per-segment "Stylize with ACE-Step" and "Sing with SoulX" buttons.
- Each opens a small param sheet (prompt, seed, conditioning strength).
- Submitting enqueues a job against `/api/services/<adapter>/generate`; UI shows
  job progress (the harness already exposes a job lifecycle).
- On completion the artifact appears in a **Takes** drawer scoped to that
  (kind, scope), with rating + supersedes chain. Click to make active.

### 6.3 Takes history

A side panel listing every artifact ever generated for the song, grouped by scope,
with re-roll chains collapsed. Each entry shows model version, seed, prompt,
duration, rating. Clicking "Reproduce" re-runs from `provenance` — useful when
weights or adapters change and you want to refresh a take.

### 6.4 Reproducibility surface

A small badge on each artifact: green ✓ if the current `songHash` matches the
artifact's `provenance.songHash` (i.e. the song hasn't drifted since the artifact
was generated), amber ⚠ if it has. Drift doesn't auto-invalidate — sometimes the
user wants to keep a stale take — but it warns.

## 7. Risks

| Risk | Mitigation |
|---|---|
| **Tempo / pitch drift** in ACE-Step output despite conditioning. | Validate output: re-detect BPM/key from artifact, flag drift > 1 BPM / non-matching key in the UI. Tune `conditioningStrength` up if persistent. |
| **SoulX mispronunciation / dropped syllables** on phoneme edges. | Audit pass: align rendered vocal back to the score; surface syllable-level diff. Keep the phoneme pipeline (already in song schema) as the authoritative input — don't fall back to grapheme-only. |
| **Latency**: ACE-Step at 30 steps + SoulX vocal can run minutes per chorus. | Aggressive cache (§5). Always render the deterministic guide first so the user has *something* to hear immediately; AI runs in the background and slots in when ready. |
| **GPU contention** between adapters on a single workstation. | Serialize via the existing `serviceManager` — only one heavy adapter loaded at a time. Document in the per-model adapter that they share `cuda:0`. |
| **Storage blow-up** from many takes. | Content-addressed dedup + 30-day cold tier + UI nudge to delete unrated takes. |
| **Provenance lies** if the adapter forgets a field. | `provenance` is required by the schema and validated by Zod when an artifact is attached. Adapters that omit fields fail to attach. |
| **Non-determinism erodes audit value.** | We record `deterministic: false` honestly. Hash chain still tracks lineage even when bitwise reproduction fails. |
| **License / model weights drift**: ACE-Step or SoulX changes a major version mid-project. | `provenance.modelVersion` + `modelHash` make this auditable; UI badge flags artifacts generated under a now-superseded model. |
| **Schema bloat** if `aiArtifacts` grows huge in `song.details` JSONB. | Cap inline artifacts at ~50/song; older ones spill to a sibling `song_artifacts` table referenced by id. (Later storage concern; not part of the first artifact proof.) |
| **Vocal lyrics out of sync** with deterministic notes if the brain re-generates lyrics after artifacts exist. | UI drift badge (§6.4); keep the artifact as a movable clip with its saved offset, but warn that the source score changed and let the user re-align, disable, or regenerate it. |

## 8. Acceptance criteria

Split acceptance into a first vertical proof and later quality gates. The first proof
should validate the architecture without pretending alignment/model quality is solved
forever.

### 8.1 First vertical proof

1. **Schema** - canonical `song.json` v1 includes optional `aiArtifacts`; Zod + JSON
   Schema in `packages/song-schema` validate ACE-Step and SoulX artifacts. Legacy engine
   adapters strip these fields.
2. **ACE conditioning** - calling `/api/services/ace-step/generate` with a song id and
   `scope: { type: "segment", segment: "chorus" }` returns an artifact conditioned on
   a Casperaki guide render/stem and attached to the song with full provenance.
3. **Score-driven SoulX** - calling `/api/services/soulx-singer/generate` with a song id
   returns a vocal artifact generated from deterministic score/lyrics/phonemes, with a
   suggested timeline start.
4. **Manual alignment** - the editor shows generated artifacts as waveform clips over
   the deterministic backing track; the user can drag, snap, and nudge `userOffsetSec`
   until the take matches musically.
5. **Provenance** - every artifact carries the provenance fields; a script can take any
   artifact id, fetch its provenance, and re-run the inference to produce a new artifact
   whose audio differs only by model-internal nondeterminism.
6. **Cache** - re-issuing an identical generate call returns the existing artifact id
   without invoking the adapter. Verified by adapter call counter.
7. **Determinism preserved** - disabling all AI artifacts in the UI yields a bounce
   bit-identical to the pure deterministic engine render. AI is strictly additive.
8. **Local dev** - full ACE-Step + SoulX round trip runs against the local
   `./var/artifacts/` store on a single workstation, no S3 dependency.

### 8.2 Later quality gates

For the integration to be considered mature:

1. **Schema** — canonical `song.json` v1 includes optional `aiArtifacts`; Zod + JSON Schema in
   `packages/song-schema` validate ACE-Step and SoulX artifacts. Fixtures exist.
2. **Conditioning** — calling `/api/services/ace-step/generate` with a song id and
   `scope: { type: "segment", segment: "chorus" }` returns an artifact whose
   detected BPM and key match the source song within tolerance (≤1 BPM, exact key)
   for 9/10 representative fixtures.
3. **Score-driven vocal** — calling `/api/services/soulx-singer/generate` with a
   song id produces a vocal artifact whose onsets align with the score's note onsets
   within ±50 ms median across the song; lyrics in the rendered audio match the
   score syllables for ≥95% of phrases on a 10-song eval set.
4. **Provenance** — every artifact carries the §2 fields; a script can take any
   artifact id, fetch its provenance, and re-run the inference to produce a new
   artifact whose audio differs only by model-internal nondeterminism.
5. **Cache** — re-issuing an identical generate call returns the existing artifact
   id without invoking the adapter. Verified by adapter call counter.
6. **UI** — the editor shows AI artifacts as separate, toggleable tracks; A/B
   between deterministic and AI takes plays back from the engine without restart;
   a Takes drawer lists every artifact with provenance and ratings.
7. **Determinism preserved** — disabling all AI artifacts in the UI yields a bounce
   bit-identical to the pure deterministic engine render. AI is strictly additive.
8. **Local dev** — full ACE-Step + SoulX round trip runs against the local
   `./var/artifacts/` provider on a single workstation, no S3 dependency.

## See also

- [`13-models-layer.md`](13-models-layer.md) — current adapters, harness, services
- [`20-song-data-format.md`](20-song-data-format.md) — canonical song schema this
  plan extends
- [`50-engineering-plan.md`](50-engineering-plan.md) — the four-layer rebuild this slots
  into (Phase 6: AI performance layer)
- [`30-reference-architecture.md`](30-reference-architecture.md) — `open_teamsuzie`
  serving conventions the adapters follow
