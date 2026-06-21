import { useEffect, useRef, useState } from 'react';

/**
 * docs/60 Phase 1 step 6 — the in-browser streaming render, end to end:
 *
 *   song.json + inst-N.json + 5 decoded stub oggs
 *        → engine-render.wasm (Resolver + streaming Mixer, built in the worklet)
 *        → AudioWorklet PULLS one 128-frame quantum per process()
 *        → audible playback on the WebAudio render thread.
 *
 * This is the real-time sibling of the native casperaki_render WAV: the SAME
 * mixer core (audio/Mixer.h) compiled to WASM, fed PCM decoded by the browser's
 * decodeAudioData instead of the native stb_vorbis adapter. Parity with native is
 * locked headlessly by scripts/validate-wasm-parity.mjs; this page is the one
 * manual, non-headless check (listen) — same caveat as /wasm-tone.
 *
 * Fixtures are served by the dev-only /render-demo middleware (vite.config.ts),
 * which reads the engine-spike genre envelopes directly (no files copied into
 * public/). Dev-only route: /wasm-render.
 */
type Index = { genres: Record<string, string[]>; samples: string[]; library?: boolean };
type SamplePlan = {
  assets: string[];
  tonal: { key: string; asset: number; sliceStart: number; sliceEnd: number }[];
  drums: { key: string; asset: number }[];
  waves: { key: string; asset: number }[];
  frets?: { key: string; asset: number; index: number; count: number }[];
  strums?: { key: string; asset: number }[];
};
type RealSample = { key: string; ch0: Float32Array; ch1: Float32Array | null; sampleRate: number };

const SAMPLE_ROLES = ['kick.ogg', 'snare.ogg', 'hat.ogg', 'tone.ogg', 'bass-c2.ogg'];

function applyTracktionSamplerFade(ch0: Float32Array, ch1: Float32Array | null) {
  if (ch0.length === 0) return;
  if (Math.abs(ch0[0]) <= 0.01 && (!ch1 || Math.abs(ch1[0]) <= 0.01)) return;

  const fadeLen = Math.min(30, ch0.length);
  const step = (Math.PI / 2) / fadeLen;
  for (let i = 0; i < fadeLen; i += 1) {
    const gain = 1 - Math.cos(i * step);
    ch0[i] *= gain;
    if (ch1) ch1[i] *= gain;
  }
}

// Fetch the genre's real-sample plan, fetch + decode each unique asset once, then
// build the id-keyed PCM the worklet stages: tonal slots sliced [start,end] from
// their preset, drum one-shots + loops/transitions whole. decodeAudioData
// resamples to ctx.sampleRate, the same rate the mixer runs at.
async function loadRealSamples(ctx: AudioContext, genre: string): Promise<RealSample[]> {
  const plan: SamplePlan = await fetch(`/render-demo/plan/${genre}`).then((r) => r.json());
  const decoded = await Promise.all(
    plan.assets.map((_, i) =>
      fetch(`/render-demo/asset/${genre}/${i}`)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b)),
    ),
  );
  const out: RealSample[] = [];
  const chans = (ab: AudioBuffer, from: number, to: number): [Float32Array, Float32Array | null] => [
    ab.getChannelData(0).slice(from, to),
    ab.numberOfChannels > 1 ? ab.getChannelData(1).slice(from, to) : null,
  ];
  const pushSamplerSample = (key: string, ab: AudioBuffer, from: number, to: number) => {
    const [ch0, ch1] = chans(ab, from, to);
    applyTracktionSamplerFade(ch0, ch1);
    out.push({ key, ch0, ch1, sampleRate: ab.sampleRate });
  };
  const pushWaveSample = (key: string, ab: AudioBuffer) => {
    const [ch0, ch1] = chans(ab, 0, ab.length);
    out.push({ key, ch0, ch1, sampleRate: ab.sampleRate });
  };
  for (const t of plan.tonal) {
    const ab = decoded[t.asset];
    if (!ab) continue;
    const from = Math.max(0, Math.round(t.sliceStart * ab.sampleRate));
    const to = Math.min(ab.length, Math.round(t.sliceEnd * ab.sampleRate));
    if (to <= from) continue;
    pushSamplerSample(t.key, ab, from, to);
  }
  for (const w of plan.drums) {
    const ab = decoded[w.asset];
    if (!ab) continue;
    pushSamplerSample(w.key, ab, 0, ab.length);
  }
  for (const w of plan.waves) {
    const ab = decoded[w.asset];
    if (!ab) continue;
    pushWaveSample(w.key, ab);
  }
  // Guitar fret-noises: N equal slices of the Default FX sibling (sliced here
  // since the plan can't know the file duration).
  for (const f of plan.frets ?? []) {
    const ab = decoded[f.asset];
    if (!ab || f.count <= 0) continue;
    const from = Math.max(0, Math.round((f.index / f.count) * ab.length));
    const to = Math.min(ab.length, Math.round(((f.index + 1) / f.count) * ab.length));
    if (to <= from) continue;
    pushSamplerSample(f.key, ab, from, to);
  }
  // Guitar strums: one whole pre-sliced chord/fx mp3 per pool entry.
  for (const s of plan.strums ?? []) {
    const ab = decoded[s.asset];
    if (!ab) continue;
    pushSamplerSample(s.key, ab, 0, ab.length);
  }
  return out;
}

export function WasmRenderPage() {
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const [index, setIndex] = useState<Index | null>(null);
  const [genre, setGenre] = useState<string>('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'ended' | 'error'>('idle');
  const [message, setMessage] = useState<string>('');
  const [useReal, setUseReal] = useState<boolean>(false);

  useEffect(() => {
    fetch('/render-demo/index.json')
      .then((r) => r.json())
      .then((idx: Index) => {
        setIndex(idx);
        const first = Object.keys(idx.genres)[0] ?? '';
        setGenre(first);
        setUseReal(!!idx.library); // default to real samples when the library is mounted
      })
      .catch((e) => { setStatus('error'); setMessage(`index: ${e}`); });
  }, []);

  async function start() {
    if (status === 'playing' || status === 'loading') return;
    if (!index || !genre) return;
    setStatus('loading');
    setMessage('loading wasm + fixtures, decoding samples…');
    try {
      const ctx = new AudioContext();
      ctxRef.current = ctx;

      // Fetch everything in parallel: the wasm, the genre envelope, the stub oggs.
      const instNames = index.genres[genre];
      const [wasmBytes, song, insts, sampleBuffers] = await Promise.all([
        fetch('/wasm/engine-render.wasm').then((r) => r.arrayBuffer()),
        fetch(`/render-demo/file/${genre}/song.json`).then((r) => r.text()),
        Promise.all(instNames.map((n) => fetch(`/render-demo/file/${genre}/${n}`).then((r) => r.text()))),
        Promise.all(SAMPLE_ROLES.map((n) => fetch(`/render-demo/sample/${n}`).then((r) => r.arrayBuffer()))),
      ]);

      // Decode the 5 stub oggs to mono PCM at the context rate (decodeAudioData
      // resamples to ctx.sampleRate — the mixer runs at that same rate, so the
      // playback ratios stay consistent).
      const samples = await Promise.all(
        sampleBuffers.map(async (buf) => {
          const ab = await ctx.decodeAudioData(buf.slice(0));
          return ab.getChannelData(0).slice(); // copy out of the AudioBuffer
        }),
      );

      // Real multisample library (the timbre-faithful path). Stubs are still
      // staged as the per-key fallback for any sample the library doesn't cover.
      const wantReal = useReal && !!index.library;
      const realSamples = wantReal ? await loadRealSamples(ctx, genre) : [];

      await ctx.audioWorklet.addModule('/worklets/casperaki-render-worklet.js');

      const node = new AudioWorkletNode(ctx, 'casperaki-render-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          wasmBytes,
          sampleRate: ctx.sampleRate,
          masterGain: 0.15,
          song,
          insts,
          samples,
          realSamples,
        },
      });
      node.port.onmessage = (ev) => {
        const d = ev.data;
        if (d?.type === 'error') { setStatus('error'); setMessage(`worklet: ${d.message}`); }
        else if (d?.type === 'ready') {
          const secs = (d.totalFrames / d.sampleRate).toFixed(1);
          const timbre = d.realCount ? `${d.realCount} real samples` : 'stub samples';
          setStatus('playing');
          setMessage(`playing ${genre} · ${secs}s · ${d.sampleRate} Hz · ${timbre} · pull-based WASM mixer`);
        } else if (d?.type === 'ended') {
          setStatus('ended');
          setMessage(`${genre} finished`);
        }
      };
      node.connect(ctx.destination);
      nodeRef.current = node;
      await ctx.resume();
    } catch (err) {
      setStatus('error');
      setMessage(String(err));
    }
  }

  async function stop() {
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    await ctxRef.current?.close();
    ctxRef.current = null;
    setStatus('idle');
    setMessage('stopped');
  }

  const genres = index ? Object.keys(index.genres) : [];

  return (
    <div style={{ maxWidth: 680, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '0.25rem' }}>WASM streaming render — live playback</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        docs/60 Phase 1 · song.json → engine-render.wasm (Resolver + Mixer) → AudioWorklet pulls blocks
      </p>

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', margin: '1.5rem 0' }}>
        <label>
          genre&nbsp;
          <select
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            disabled={status === 'playing' || status === 'loading'}
          >
            {genres.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
        <button onClick={start} disabled={!genre || status === 'playing' || status === 'loading'}>
          ▶ Play
        </button>
        <button onClick={stop} disabled={status !== 'playing' && status !== 'ended'}>
          ■ Stop
        </button>
        <label title={index?.library ? 'Play the real multisample library' : 'Library not mounted (set CASPERAKI_SAMPLE_LIBRARY_ROOT)'}>
          <input
            type="checkbox"
            checked={useReal}
            disabled={!index?.library || status === 'playing' || status === 'loading'}
            onChange={(e) => setUseReal(e.target.checked)}
          />
          &nbsp;real samples
        </label>
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.4rem 1rem', fontSize: '0.9rem' }}>
        <dt style={{ opacity: 0.6 }}>status</dt>
        <dd style={{ margin: 0 }}>{status}</dd>
        <dt style={{ opacity: 0.6 }}>genres</dt>
        <dd style={{ margin: 0 }}>{genres.length ? genres.join(', ') : '—'}</dd>
        <dt style={{ opacity: 0.6 }}>detail</dt>
        <dd style={{ margin: 0 }}>{message || '—'}</dd>
      </dl>

      <p style={{ opacity: 0.55, fontSize: '0.8rem', marginTop: '2rem' }}>
        No-FX render. With <strong>real samples</strong> on, the engine plays the actual multisample
        library — tonal lanes sliced per slot, real drum one-shots, real loops/transitions (any
        un-resolved key falls back to a stub). With it off it's the stub-sampled render (drums by role,
        bass→bass, tonal→tone): timing and relative pitch faithful, timbres placeholder. The library
        path needs <code>CASPERAKI_SAMPLE_LIBRARY_ROOT</code> set in <code>apps/engine-spike/.env</code>;
        build the module first: <code>apps/web/wasm/engine/build-wasm.sh</code>.
      </p>
    </div>
  );
}
