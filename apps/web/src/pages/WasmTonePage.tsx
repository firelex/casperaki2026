import { useEffect, useRef, useState } from 'react';

/**
 * Phase 0 (docs/60) spike page — proves the in-browser render pipeline the
 * WASM engine port will use, end to end and *for real*:
 *
 *   bespoke C DSP  →  emcc (standalone WASM, zero JS/WASI imports)
 *                  →  fetched as bytes, handed to an AudioWorkletProcessor
 *                  →  the WebAudio render thread PULLS blocks (no main-thread
 *                     work, no offline busy-loop — the 57f-safe structure).
 *
 * It also surfaces `crossOriginIsolated`, which is true only when the dev
 * server sends COOP/COEP — the precondition for SharedArrayBuffer + WASM
 * threads later (Phase 3). The tone itself is throwaway; the *path* is the
 * deliverable.
 *
 * Dev-only route: /wasm-tone
 */
export function WasmTonePage() {
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [message, setMessage] = useState<string>('');
  const [isolated, setIsolated] = useState<boolean | null>(null);

  useEffect(() => {
    setIsolated(typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : null);
  }, []);

  async function start() {
    if (status === 'playing' || status === 'loading') return;
    setStatus('loading');
    setMessage('creating AudioContext + loading worklet…');
    try {
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule('/worklets/engine-tone-worklet.js');

      const wasmBytes = await fetch('/wasm/engine-tone.wasm').then((r) => {
        if (!r.ok) throw new Error(`fetch wasm: ${r.status}`);
        return r.arrayBuffer();
      });

      const node = new AudioWorkletNode(ctx, 'engine-tone-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { wasmBytes, freq: 440 },
      });
      node.port.onmessage = (ev) => {
        if (ev.data?.type === 'error') {
          setStatus('error');
          setMessage(`worklet: ${ev.data.message}`);
        }
      };
      node.connect(ctx.destination);
      nodeRef.current = node;

      await ctx.resume();
      setStatus('playing');
      setMessage(`playing 440 Hz · ctx ${ctx.sampleRate} Hz · pull-based AudioWorklet`);
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

  return (
    <div style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: '1.4rem', marginBottom: '0.25rem' }}>WASM render spike — pull-based tone</h1>
      <p style={{ opacity: 0.7, marginTop: 0 }}>
        docs/60 Phase 0 · bespoke C → emcc standalone WASM → AudioWorklet pulls blocks
      </p>

      <div style={{ display: 'flex', gap: '0.75rem', margin: '1.5rem 0' }}>
        <button onClick={start} disabled={status === 'playing' || status === 'loading'}>
          ▶ Play tone
        </button>
        <button onClick={stop} disabled={status !== 'playing'}>
          ■ Stop
        </button>
      </div>

      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.4rem 1rem', fontSize: '0.9rem' }}>
        <dt style={{ opacity: 0.6 }}>status</dt>
        <dd style={{ margin: 0 }}>{status}</dd>
        <dt style={{ opacity: 0.6 }}>crossOriginIsolated</dt>
        <dd style={{ margin: 0 }}>
          {isolated === null ? 'unknown' : String(isolated)}
          {isolated === false && ' — COOP/COEP not active (SharedArrayBuffer/threads unavailable)'}
          {isolated === true && ' — COOP/COEP active ✓ (threads-ready)'}
        </dd>
        <dt style={{ opacity: 0.6 }}>detail</dt>
        <dd style={{ margin: 0 }}>{message || '—'}</dd>
      </dl>
    </div>
  );
}
