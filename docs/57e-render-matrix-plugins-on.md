# 57e — Per-genre render-compare matrix (plugins on)

Extends the 57d brightPop proof to all 8 canonical genres. The 56d
matrix driver gains a `--plugins-on` mode that does two renders per
genre — first dry (strip on), then again with `SPIKE_KEEP_PLUGINS=1`
so the master / submix / send rack chains fire — and records the RMS
delta and any `Failed to create plugin` lines from the plugins-on
stderr.

## TL;DR

`node apps/engine-spike/scripts/render-all-genres.mjs --plugins-on`
finished 8/8 pass in 612.89 s. Zero `Failed to create plugin` errors
on any genre. Every genre cleared the 0.05 dB `|Δrms|` floor, with
deltas ranging from −5.65 dB (rock) to +6.64 dB (edm).

| genre | status | dry rms (dB) | plugins rms (dB) | Δrms (dB) | plugins peak (dB) | plugin errs |
| --- | --- | --- | --- | --- | --- | --- |
| `ballad` | pass | -19.596 | -16.965 | +2.631 | -2.695 | 0 |
| `brightPop` | pass | -20.471 | -20.736 | -0.265 | -0.658 | 0 |
| `edm` | pass | -21.465 | -14.824 | +6.641 | -4.225 | 0 |
| `latin` | pass | -22.274 | -18.924 | +3.350 | -3.164 | 0 |
| `organicVibes` | pass | -23.568 | -20.779 | +2.788 | -4.772 | 0 |
| `rock` | pass | -19.575 | -25.224 | -5.648 | -3.923 | 0 |
| `schlager` | pass | -25.184 | -23.721 | +1.463 | 0.000 | 0 |
| `urban` | pass | -27.445 | -21.528 | +5.917 | -7.884 | 0 |

Acceptance (from 57e brief):
- ✅ Every genre renders plugins-on without `Failed to create plugin`.
- ✅ Every genre shows a non-zero RMS delta vs the dry baseline.

## Files changed

- `apps/engine-spike/scripts/render-all-genres.mjs` — new
  `--plugins-on` flag (also `PLUGINS_ON=1`). When set, each genre
  renders twice: dry → `out.wav` (unchanged path), plugins-on →
  `out-plugins.wav`. Per-row record gains a `pluginsOn` block with
  `rmsDb / peakDb / deltaRmsDb / deltaPeakDb / pluginErrors /
  renderError`. The verdict gate adds three plugins-on checks (render
  rc==0, zero `Failed to create plugin` lines, `|Δrms| ≥ 0.05 dB`).
  A focused `57e-matrix.json` is written alongside `summary.json`.

No engine-side changes — 57e is plumbing only on top of the 57d
hosting.

## Observations worth flagging (out of scope for 57e)

- **Sign of Δrms varies by genre.** edm / urban / ballad / latin /
  organicVibes / schlager get *louder* with plugins on (+1.5 to
  +6.6 dB), while rock loses 5.6 dB and brightPop dips 0.27 dB.
  The 57d brightPop reference posted −2.48 dB; the present run
  shows −0.27 dB on the same seed. The brightPop difference is
  small but the rock outlier is large and worth a per-rack bisect
  before any tuning work treats these deltas as ground truth.
- **schlager plugins-on peaks at 0.0 dB.** Every other plugins-on
  render shows the ADClip 7 ceiling biting (−0.66 to −7.88 dB
  peak). schlager not getting limited suggests its master rack is
  routed differently — or that the schlager renderer happens to
  never push the ADClip threshold. Worth confirming.
- **edm and urban get +5–7 dB louder** — likely Console8 Buss
  In/Out summing gain stacking ahead of a quiet dry mix. Not a
  failure, but again calls for per-rack accounting (the 57d
  "still owed" list already names this).

## How to reproduce

```sh
# stub server must be on 8080
node apps/engine-spike/scripts/sample-stub-server.mjs --port 8080 &

# spike binary at apps/engine-spike/native/build/.../casperaki_spike
cmake --build apps/engine-spike/native/build --target casperaki_spike -j 6

# all 8 genres, dual render
node apps/engine-spike/scripts/render-all-genres.mjs --plugins-on

# single genre
GENRES=urban node apps/engine-spike/scripts/render-all-genres.mjs --plugins-on
```

Outputs (per genre):
- `apps/engine-spike/out/all-genre-render-smoke/<genre>/out.wav` — dry
- `apps/engine-spike/out/all-genre-render-smoke/<genre>/out-plugins.wav` — chains on
- `apps/engine-spike/out/all-genre-render-smoke/<genre>/render.log` —
  both renders' stdout+stderr with section headers

Aggregates:
- `apps/engine-spike/out/all-genre-render-smoke/summary.json` —
  full 56d shape plus the new `pluginsOn` block per row
- `apps/engine-spike/out/all-genre-render-smoke/57e-matrix.json` —
  trimmed dry/plugins/delta-only view (the table this doc was
  generated from)

## What's still owed

Carried forward from the 57d "still owed" list — 57e closes only the
per-genre coverage line:

- **Per-rack bisect.** rock −5.6 dB vs edm +6.6 dB is too wide a
  spread to chalk up to programme material. Bisecting which rack
  (master vs each submix vs each send) drives each delta needs
  N+1 renders per genre.
- **Schlager peak ceiling not biting.** Confirm the master chain
  is actually inserted on the schlager render — possibly a
  PresetManager routing edge case.
- **Airwindows Consolidated state-blob fidelity.** Still defaulting
  to 0.5 awp_N values; legacy XMLs had non-defaults.
- **yabridge cold-start latency.** Plugins-on adds ~75 s vs ~25 s
  dry per genre, dominated by Wine warmup on Valhalla. Tolerable
  offline; cache exploration is the next step if live ever wants
  these chains.
- **Strip refinement** and **FXPluginRemap unit tests** also still
  open.
