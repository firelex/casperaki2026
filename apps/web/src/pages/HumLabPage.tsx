import { useEffect, useRef, useState } from 'react';

import { AppHeader } from '../layout/AppHeader';

/**
 * Hum lab: a test bench for "hum a song". Record a hum (or upload a
 * recording), and Beat This! — a beat tracker trained on full songs, used as
 * it is — finds its beats and bar starts. Play the hum back with a click on
 * every detected beat to hear whether it locked on; note the tempo you meant
 * and the table keeps score across tries.
 */

interface BeatResult {
  beats: number[];
  downbeats: number[];
  bpm: number | null;
  beatsPerBar: number | null;
  seconds: number;
  tookMs: number;
}

interface Attempt {
  id: number;
  name: string;
  meant: number | null;
  result: BeatResult;
}

/** `meant` set → the brain keeps the recording as test data for the hum beat tracker. */
async function trackBeats(blob: Blob, meant: number | null): Promise<BeatResult> {
  const headers: Record<string, string> = { 'content-type': blob.type || 'application/octet-stream' };
  if (meant !== null) headers['x-meant-bpm'] = String(meant);
  const res = await fetch('/api/lab/beats', { method: 'POST', body: blob, headers, credentials: 'include' });
  const body = (await res.json()) as BeatResult & { message?: string; error?: string };
  if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
  return body;
}

/** How the detected tempo relates to the one meant: right, half, double, or off by a share. */
function verdict(meant: number, bpm: number): { label: string; good: boolean } {
  const near = (x: number) => Math.abs(bpm - x) / x <= 0.04;
  if (near(meant)) return { label: 'right', good: true };
  if (near(meant / 2)) return { label: 'half the tempo', good: false };
  if (near(meant * 2)) return { label: 'double the tempo', good: false };
  if (near((meant * 2) / 3) || near((meant * 3) / 2)) return { label: 'a triplet feel off', good: false };
  return { label: `off by ${Math.round(((bpm - meant) / meant) * 100)}%`, good: false };
}

export function HumLabPage() {
  const [recording, setRecording] = useState(false);
  const [audio, setAudio] = useState<{ blob: Blob; name: string } | undefined>(undefined);
  const [meant, setMeant] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [shown, setShown] = useState<Attempt | undefined>(undefined);
  const recorder = useRef<MediaRecorder | null>(null);
  const tries = useRef(0);

  const startRecording = async () => {
    setError(undefined);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      tries.current += 1;
      setAudio({ blob: new Blob(chunks, { type: rec.mimeType }), name: `Recording ${tries.current}` });
    };
    rec.start();
    recorder.current = rec;
    setRecording(true);
  };
  const stopRecording = () => {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  };

  const analyse = async () => {
    if (!audio) return;
    setBusy(true);
    setError(undefined);
    try {
      const m = Number(meant);
      const meantBpm = meant.trim() && Number.isFinite(m) && m > 0 ? m : null;
      const result = await trackBeats(audio.blob, meantBpm);
      const attempt: Attempt = { id: Date.now(), name: audio.name, meant: meantBpm, result };
      setAttempts((a) => [attempt, ...a]);
      setShown(attempt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const copyTable = () => {
    const lines = attempts.map((a) => `${a.name}\tmeant ${a.meant ?? '?'}\tfound ${a.result.bpm?.toFixed(1) ?? '–'}\t${a.result.beatsPerBar ?? '–'}/bar\t${a.result.seconds.toFixed(1)} s`);
    void navigator.clipboard.writeText(lines.join('\n'));
  };

  return (
    <div className="min-h-screen w-full bg-bg text-fg">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1000px] px-4 pb-24 pt-10 sm:px-8 sm:pt-14">
        <h1 className="app-heading text-[30px] leading-tight text-white sm:text-[36px]">Hum lab</h1>
        <p className="mt-2 max-w-[70ch] text-[15px] leading-relaxed text-white/60">
          Hum a tune, or upload a recording, and see whether the beat tracker finds its tempo and where its bars start. Play it back with clicks on the found beats
          to hear if they line up. The tracker (Beat This!) learned from full songs, not hums: this page is here to find out how far that gets us.
        </p>

        <section className="mt-8 rounded-[14px] border border-line bg-white/[0.03] p-5" aria-label="Recording">
          <div className="flex flex-wrap items-center gap-3">
            {recording ? (
              <button type="button" onClick={stopRecording} className="h-10 rounded-full bg-red-500 px-5 text-[14px] font-semibold text-white">
                ● Stop recording
              </button>
            ) : (
              <button type="button" onClick={() => void startRecording().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))} className="h-10 rounded-full bg-white px-5 text-[14px] font-semibold text-black">
                Record a hum
              </button>
            )}
            <label className="h-10 cursor-pointer rounded-full border border-line px-5 text-[14px] leading-10 text-white/80 hover:border-white/40">
              Upload a recording
              <input
                type="file"
                accept="audio/*,video/*"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setAudio({ blob: f, name: f.name });
                  e.target.value = '';
                }}
              />
            </label>
            <label className="flex items-center gap-2 text-[14px] text-white/70">
              Tempo you meant
              <input
                type="number"
                min={30}
                max={260}
                value={meant}
                onChange={(e) => setMeant(e.target.value)}
                placeholder="BPM"
                className="h-10 w-24 rounded-[10px] border border-line bg-transparent px-3 text-white"
              />
            </label>
          </div>
          {audio ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="text-[14px] text-white/80">{audio.name}</span>
              <audio controls src={URL.createObjectURL(audio.blob)} className="h-9" />
              <button type="button" onClick={() => void analyse()} disabled={busy} className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white disabled:opacity-50">
                {busy ? 'Finding the beat…' : 'Find the beat'}
              </button>
            </div>
          ) : (
            <p className="mt-4 text-[13px] text-white/45">Hum at least 8 bars, about 15 to 30 seconds. A phone recording works too.</p>
          )}
          <p className="mt-3 text-[12px] text-white/40">Recordings sent with a tempo you meant are kept on the server to test the beat tracker.</p>
          {error ? (
            <p className="mt-3 text-[13px] text-red-300" role="alert">
              {error}
            </p>
          ) : null}
        </section>

        {shown && audio ? <ResultView attempt={shown} blob={shown.name === audio.name ? audio.blob : undefined} /> : null}

        {attempts.length ? (
          <section className="mt-8" aria-label="Tries so far">
            <div className="flex items-center gap-3">
              <h2 className="text-[18px] font-semibold text-white">Tries so far</h2>
              <button type="button" onClick={copyTable} className="ml-auto h-8 rounded-full border border-line px-3 text-[12px] text-white/70 hover:text-white">
                Copy the table
              </button>
            </div>
            <table className="mt-3 w-full text-left text-[14px]">
              <thead className="text-[12px] text-white/50">
                <tr>
                  <th className="py-1 font-normal">Recording</th>
                  <th className="font-normal">Meant</th>
                  <th className="font-normal">Found</th>
                  <th className="font-normal">Verdict</th>
                  <th className="font-normal">Beats per bar</th>
                  <th className="font-normal">Length</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((a) => {
                  const v = a.meant && a.result.bpm ? verdict(a.meant, a.result.bpm) : undefined;
                  return (
                    <tr key={a.id} className="cursor-pointer border-t border-line hover:bg-white/[0.04]" onClick={() => setShown(a)}>
                      <td className="py-2">{a.name}</td>
                      <td>{a.meant ?? '–'}</td>
                      <td>{a.result.bpm ? a.result.bpm.toFixed(1) : 'no beat'}</td>
                      <td className={v ? (v.good ? 'text-emerald-300' : 'text-amber-300') : 'text-white/40'}>{v?.label ?? '–'}</td>
                      <td>{a.result.beatsPerBar ?? '–'}</td>
                      <td>{a.result.seconds.toFixed(1)} s</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        ) : null}
      </main>
    </div>
  );
}

/** One try: the numbers, the beats drawn over the waveform, and playback with clicks. */
function ResultView({ attempt, blob }: { attempt: Attempt; blob: Blob | undefined }) {
  const { result } = attempt;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [buffer, setBuffer] = useState<AudioBuffer | undefined>(undefined);
  const [playing, setPlaying] = useState<{ ctx: AudioContext; startedAt: number } | undefined>(undefined);
  const [clicksOnly, setClicksOnly] = useState(false);
  const [pos, setPos] = useState(0);

  useEffect(() => {
    setBuffer(undefined);
    if (!blob) return;
    const ctx = new AudioContext();
    void blob
      .arrayBuffer()
      .then((b) => ctx.decodeAudioData(b))
      .then(setBuffer)
      .finally(() => void ctx.close());
  }, [blob]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const g = c.getContext('2d');
    if (!g) return;
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = c.clientHeight * devicePixelRatio);
    g.clearRect(0, 0, w, h);
    if (buffer) {
      const data = buffer.getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / w));
      g.fillStyle = 'rgba(255,255,255,0.35)';
      for (let x = 0; x < w; x++) {
        let peak = 0;
        for (let i = x * step; i < Math.min(data.length, (x + 1) * step); i++) peak = Math.max(peak, Math.abs(data[i]!));
        g.fillRect(x, h / 2 - (peak * h) / 2, 1, peak * h);
      }
    }
    const xOf = (s: number) => (s / result.seconds) * w;
    for (const b of result.beats) {
      g.fillStyle = 'rgba(96,165,250,0.8)';
      g.fillRect(xOf(b), 0, devicePixelRatio, h);
    }
    for (const d of result.downbeats) {
      g.fillStyle = 'rgba(251,191,36,1)';
      g.fillRect(xOf(d) - devicePixelRatio, 0, 3 * devicePixelRatio, h);
    }
  }, [buffer, result]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const t = playing.ctx.currentTime - playing.startedAt;
      setPos(t);
      if (t > result.seconds + 0.5) stop();
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const stop = () => {
    if (playing) void playing.ctx.close();
    setPlaying(undefined);
    setPos(0);
  };
  const play = () => {
    stop();
    const ctx = new AudioContext();
    const startedAt = ctx.currentTime + 0.1;
    if (buffer && !clicksOnly) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.start(startedAt);
    }
    const down = new Set(result.downbeats.map((d) => d.toFixed(2)));
    for (const b of result.beats) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = down.has(b.toFixed(2)) ? 1760 : 1100;
      gain.gain.setValueAtTime(0.35, startedAt + b);
      gain.gain.exponentialRampToValueAtTime(0.001, startedAt + b + 0.05);
      osc.connect(gain).connect(ctx.destination);
      osc.start(startedAt + b);
      osc.stop(startedAt + b + 0.06);
    }
    setPlaying({ ctx, startedAt });
  };
  useEffect(() => () => stop(), [attempt.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = attempt.meant && result.bpm ? verdict(attempt.meant, result.bpm) : undefined;
  const bars = result.downbeats.length;

  return (
    <section className="mt-8 rounded-[14px] border border-line bg-white/[0.03] p-5" aria-label="Result">
      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
        <div>
          <span className="text-[40px] font-semibold text-white">{result.bpm ? result.bpm.toFixed(1) : '—'}</span>
          <span className="ml-2 text-[14px] text-white/55">BPM found</span>
        </div>
        {v ? <span className={`text-[15px] ${v.good ? 'text-emerald-300' : 'text-amber-300'}`}>You meant {attempt.meant}: {v.label}</span> : null}
        <span className="text-[14px] text-white/60">
          {result.beats.length} beats, {bars} bar starts{result.beatsPerBar ? `, ${result.beatsPerBar} beats per bar` : ''}
        </span>
        <span className="text-[13px] text-white/40">took {(result.tookMs / 1000).toFixed(1)} s</span>
      </div>
      <div className="relative mt-4 h-28 w-full overflow-hidden rounded-[10px] bg-black/30">
        <canvas ref={canvas} className="h-full w-full" />
        {playing ? <div className="absolute top-0 h-full w-px bg-white" style={{ left: `${Math.min(100, (pos / result.seconds) * 100)}%` }} /> : null}
      </div>
      <p className="mt-2 text-[12px] text-white/45">Blue: beats. Yellow: bar starts. Bar starts click higher on playback.</p>
      <div className="mt-3 flex items-center gap-3">
        {blob ? (
          <>
            <button type="button" onClick={playing ? stop : play} className="h-10 rounded-full bg-white px-5 text-[14px] font-semibold text-black">
              {playing ? 'Stop' : 'Play with clicks'}
            </button>
            <label className="flex items-center gap-2 text-[13px] text-white/60">
              <input type="checkbox" checked={clicksOnly} onChange={(e) => setClicksOnly(e.target.checked)} /> Clicks only
            </label>
          </>
        ) : (
          <span className="text-[13px] text-white/45">Playback is available for the current recording only.</span>
        )}
      </div>
    </section>
  );
}
