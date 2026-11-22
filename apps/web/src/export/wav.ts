/**
 * Stereo float PCM → 24-bit WAV, peak-normalised to 0.9 (as the server's
 * renders are), so a downloaded pattern or track never clips.
 */
export function encodeWav24(left: Float32Array, right: Float32Array, sampleRate: number): Uint8Array {
  if (left.length !== right.length) throw new Error('encodeWav24: channel lengths differ');
  let peak = 0;
  for (let i = 0; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
  const gain = peak > 0 ? 0.9 / peak : 1;
  const frames = left.length;
  const dataBytes = frames * 2 * 3;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const text = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 2, true); // stereo
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2 * 3, true);
  v.setUint16(32, 6, true);
  v.setUint16(34, 24, true);
  text(36, 'data');
  v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of [left, right]) {
      const s = Math.max(-1, Math.min(1, ch[i]! * gain));
      const x = Math.round(s * 8388607);
      v.setUint8(o, x & 0xff);
      v.setUint8(o + 1, (x >> 8) & 0xff);
      v.setUint8(o + 2, (x >> 16) & 0xff);
      o += 3;
    }
  }
  return new Uint8Array(buf);
}
