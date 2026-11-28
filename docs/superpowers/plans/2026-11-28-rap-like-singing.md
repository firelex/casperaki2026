# Rap like singing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write rap lyrics → Rap (ACE repaint) → "Rap" track, with section choice for Sing and Rap and sung takes muted
under rap (right-click to unmute).

**Architecture:** Song model first (packages: song-schema `muted` on takes and the "Rap" track name; arrangement edits
for rap lyrics, rap clips, mutes; engine-adapter leaves muted clips out), then the brain (writeRapLyrics task, Sing
sections, Rap words from options, track edits), then svc-ace (repaint), then the web (menus, dialogs, clip mute).

**Tech Stack:** TypeScript (zod, vitest), Python (svc-ace adapter, pytest), React.

**Spec:** docs/superpowers/specs/2026-11-28-rap-like-singing-design.md

## Global Constraints

- No fallbacks: missing words, sections or tracks throw with a clear message.
- LLM prompts in plain English (rapWords.ts brief is reused as is).
- Rap track name: `Rap` (exactly). Old "ACE Rap" tracks keep working (aceInstrumentOfTrack still maps them to rap).
- Rap lines: one per `RAP_BARS_PER_LINE` (2) bars, `rapLineCount(bars)`.
- Rap default sections: verses when the song has sung takes, otherwise every section. Sing default: every section
  with a melody. Rap dialog default: sections that have rap words.
- Muted under rap: sung takes (SUNG_TAKE_KINDS) of every track in a section that has a Rap clip — set when the rap
  lands (all sung takes there) and when a Sing lands (its new takes there).
- svc-ace rap: repaint, base model, window = section ± 4 bars (clipped to the song), `chunk_mask_mode="explicit"`,
  caption `"<genre> song with <style>, rap verse over the beat, <bpm> bpm, <key>"`, the section's own lines once
  under `[Verse]`; 4 takes/round up to 12, MIN_RAP_RECALL 0.4 as today.
- Web ships only via deploy/datigator/deploy.sh; svc-ace restarted after the adapter change.

## Review Focus

- A song rapped with the old "ACE Rap" track, then rapped again: the new clips go to "Rap"; nothing throws.
- Rap a section, unmute its lead, Sing a different section: the unmuted lead stays unmuted (only new takes in rap
  sections are muted).
- Sing with only some sections ticked: the unticked sections keep their takes (partial apply).
- A muted clip is absent from render and live playback (engine-adapter) but still shown (greyed) in the editor.
- Rap with a ticked section that has no words: refused by the brain (422), not silently skipped.

---

### Task 1: Song model — mute, Rap track, rap lyrics, rap clips per section, mute under rap

**Files:**
- Modify: `packages/song-schema/src/schemas/ai-artifact.ts` (add `muted: z.boolean().optional()`)
- Modify: `packages/song-schema/src/ace-layer.ts` (`RAP_TRACK = 'Rap'`; `aceInstrumentOfTrack('Rap')` → 'rap')
- Create: `packages/arrangement/src/edits/rap.ts`; export from `packages/arrangement/src/index.ts`
- Modify: `packages/arrangement/src/edits/ace-layer.ts` (rap results: per-section replace on "Rap", then mute)
- Modify: `packages/arrangement/src/edits/vocal-edits.ts` (applySungVocals: new takes in rap sections muted)
- Modify: `packages/engine-adapter/src/audio-clips.ts` (leave out `muted` takes)
- Test: `packages/arrangement/test/rap.spec.ts`, `packages/engine-adapter/test/audio-clips*.spec.ts`

**Interfaces (produces):**
- `RAP_LYRICS_PARAM = 'rapLyrics'`; `rapLyricsOf(song): Record<string, string[]>`;
  `applyRapLyrics(song, lyrics: Record<string, readonly string[]>): Song` (merges, per section; unknown section throws)
- `rapSections(song): string[]` (sections with a clip on a rap track)
- `muteUnderRap(song, sections: readonly string[]): Song` (sung takes in those sections that have rap → muted)
- `setTakesMuted(song, track: string, segment: string, muted: boolean): Song` (all takes of track×segment; none throws)
- `applyAceLayer` for `instrument === 'rap'`: `result.track` must be `RAP_TRACK`; replaces clips of the result's
  sections only; then `muteUnderRap(song, result sections)`.

- [ ] Tests (red): rapLyrics merge; rap clips replace only their sections; sung takes muted when rap lands; Sing's new
  takes in a rap section muted, an unmuted take elsewhere untouched; setTakesMuted toggles and removes the field;
  engine-adapter leaves out muted clips.
- [ ] Implement; build song-schema + arrangement dist; tests green; commit.

### Task 2: Brain — writeRapLyrics task, Sing sections, Rap words from options, track edits

**Files:**
- Modify: `apps/brain/src/store.ts` (TASK_KINDS + 'writeRapLyrics'), `apps/brain/src/tasks/tasks.ts`,
  `apps/brain/src/routes/tasks.ts`, `apps/brain/src/routes/tracks.ts`, `apps/brain/src/sing/plan.ts`,
  `apps/brain/src/sing/singTask.ts`, `apps/brain/src/ace/aceLayerTask.ts`
- Test: `apps/brain/test/*` (rap-words, ace-layer-task, tasks, sing plan)

**Interfaces:**
- POST /api/tasks `{kind:'writeRapLyrics', songId, song, style, sections}` → result `{rapLyrics: {section: lines}}`;
  resultInto → `applyRapLyrics`. Needs lyricModel (503 `no_lyric_model`).
- `{kind:'sing', …, singerId, sections?}`: planSinging only those sections; result applied `partial` when `sections`.
- aceLayer rap: `rapWords` required for every section (422 otherwise); no writing inside; track `RAP_TRACK`.
- tracks edits: `{kind:'setRapLyrics', lyrics}`, `{kind:'setTakesMuted', track, segment, muted}`.

- [ ] Tests (red) → implement → `pnpm -C apps/brain test` (only the known melodyLibrary failure) → commit.

### Task 3: svc-ace — rap by repaint

**Files:** `apps/models/services/_serving/adapters/ace-layer.py`, `apps/models/services/_serving/test_ace_layer_rap.py`

- `rap_window(start, end, total, bar) -> (ws, we)` = (max(0, start-4 bars), min(total, end+4 bars)), at least
  MIN_SECONDS; `_repaint(handle, p, src_wav, lyrics, seed, seconds, start, end)`; caption from `p["caption"]` (brain
  sends the full repaint caption); lyrics `[Verse]\n<lines>`.
- [ ] Tests (red) → implement → pytest green → restart svc-ace → live check on a 4-bar section → commit.

### Task 4: Web — menus, dialogs, clip mute

**Files:** `apps/web/src/editor/TimelineView.tsx`, `apps/web/src/editor/sequencer/RapDialog.tsx`,
`apps/web/src/editor/sequencer/WriteRapLyricsDialog.tsx` (new), SingerDialog, `apps/web/src/api/tasks.ts`,
`apps/web/src/api/tracks.ts`, `apps/web/src/state/tasks.tsx`, `apps/web/src/editor/sequencerModel.ts`

- Helpers (tested): `defaultRapSections(sections, hasSung)`, `defaultSingSections(sections)`, Rap dialog `canStart`.
- Clip menu: "Mute clip"/"Unmute clip" on a clip with takes; muted clips greyed (`SeqClip.muted`).
- [ ] Tests → implement → web tests green → commit.

### Task 5: Ship and check live

- [ ] Push; deploy.sh; restart svc-ace; live run on Electric Daydream: Write rap lyrics (verse1, bridge1) → Rap →
  sung takes muted there → unmute one → render. Report.
