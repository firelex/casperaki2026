// Decode a JUCE MemoryBlock base64 AirWindows state chunk -> float params.
// Format: "<decimalSize>.<base64>"; alphabet = '.' A-Z a-z 0-9 '+' (JUCE's
// MemoryBlock::toBase64Encoding). Bit packing is LSB-first (JUCE getBitRange/
// setBitRange: low bits of each byte first, low byte first). The decoded bytes
// are an FXB-wrapped chunk: a 160-byte header then N little-endian float32
// params (N = plugin param count; sizes 160/164/168/180/184/192 = 160 + 4*N).
const ALPHABET = '.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+';
const REV = (() => { const m = new Int16Array(128).fill(-1); for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET.charCodeAt(i)] = i; return m; })();

export function decodeJuceMemoryBlock(s) {
  const dot = s.indexOf('.');
  const size = parseInt(s.slice(0, dot), 10);
  const enc = s.slice(dot + 1);
  const out = Buffer.alloc(size);
  // Mirror JUCE MemoryBlock::setBitRange: write each 6-bit value LSB-first into
  // the byte stream (low bits of each byte first, advancing low byte first).
  let bitPos = 0;
  const writeBits = (value, numBits) => {
    while (numBits > 0) {
      const byte = bitPos >> 3, off = bitPos & 7;
      if (byte >= size) return;
      const bitsThisTime = Math.min(numBits, 8 - off);
      const mask = (1 << bitsThisTime) - 1;
      out[byte] |= (value & mask) << off;
      value >>>= bitsThisTime;
      bitPos += bitsThisTime;
      numBits -= bitsThisTime;
    }
  };
  for (const ch of enc) {
    const v = REV[ch.charCodeAt(0)];
    if (v < 0) throw new Error(`bad base64 char '${ch}'`);
    writeBits(v, 6);
  }
  return out;
}

export function decodeParams(stateStr, headerBytes = 160) {
  const buf = decodeJuceMemoryBlock(stateStr);
  const n = Math.floor((buf.length - headerBytes) / 4);
  const params = [];
  for (let i = 0; i < n; i++) params.push(buf.readFloatLE(headerBytes + i * 4));
  return { totalBytes: buf.length, headerBytes, n, params };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cases = {
    'Console8SubIn(0p)': '160.CMlaKA....fQBMDZ....ALFNykF...P.....................................................................................................................................................................................',
    'TexturizeMS(6p)':   '184.CMlaKA....fQBMDZ....APWY3UG...P.....................................................................................................................................................................................X....7C...3O....+....9C...vO....+.',
    'Console8SubOut(1p)':'164.CMlaKA....fQBMDZ....ALFNy8F...P.....................................................................................................................................................................................D....7C',
    'EQ(8p,keys)':       '192.CMlaKA....fQBMDZ....ATVbkEG...P.....................................................................................................................................................................................f.UiW7iaRLvO....+....9ScShwOMyLy9.AUo5C...vO',
    'Huge(2p,bass)':     '168.CMlaKA....fQBMDZ....AfVcmUF...P.....................................................................................................................................................................................HzLyL8ybnTkO',
  };
  for (const [name, st] of Object.entries(cases)) {
    const r = decodeParams(st);
    console.log(`${name.padEnd(20)} total=${r.totalBytes} n=${r.n} params=[${r.params.map(p => p.toFixed(4)).join(', ')}]`);
  }
}
