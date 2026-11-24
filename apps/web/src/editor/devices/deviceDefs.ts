/**
 * What each plugin in the mix is, and its controls in its own units (the
 * Airwindows sources' getParameterName / getParameterDisplay / Label, and
 * our own FreqShiftEcho and SimpleSide rebuilds). Values come from the mix
 * config as 0..1 knob positions.
 */

export type DeviceKind = 'compressor' | 'eq' | 'reverb' | 'delay' | 'chorus' | 'saturation' | 'clipper' | 'console' | 'pump' | 'texture';

export interface DeviceParam {
  readonly name: string;
  /** The value as the plugin shows it. */
  display(v: number): string;
}

export interface DeviceDef {
  readonly title: string;
  readonly maker: string;
  readonly kind: DeviceKind;
  /** One line on what it does in this mix. */
  readonly role: string;
  readonly params: readonly DeviceParam[];
}

const fixed = (digits: number, unit = '') => (x: number) => `${x.toFixed(digits)}${unit}`;
const signedDb = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(1)} dB`;
const amount = (v: number) => v.toFixed(2);
const p = (name: string, display: (v: number) => string): DeviceParam => ({ name, display });

const console8 = (title: string, role: string, withFader: boolean): DeviceDef => ({
  title,
  maker: 'Airwindows',
  kind: 'console',
  role,
  params: withFader ? [p('Fader', amount)] : [],
});

export const DEVICES: Readonly<Record<string, DeviceDef>> = {
  makeEQ: {
    title: 'EQ',
    maker: 'Airwindows',
    kind: 'eq',
    role: 'Three-band tone shaping with low and high cuts.',
    params: [
      p('Treble', (v) => signedDb(v * 24 - 12)),
      p('Mid', (v) => signedDb(v * 24 - 12)),
      p('Bass', (v) => signedDb(v * 24 - 12)),
      p('Lowpass', (v) => fixed(1, ' kHz')(v * v * 15 + 1)),
      p('Treble freq', (v) => fixed(1, ' kHz')(v * v * 15 + 1)),
      p('Bass freq', (v) => fixed(0, ' Hz')(v * v * 1570 + 30)),
      p('Hipass', (v) => fixed(0, ' Hz')(v * v * 1570 + 30)),
      p('Out gain', (v) => signedDb(v * 36 - 18)),
    ],
  },
  makeThunder: {
    title: 'Thunder',
    maker: 'Airwindows',
    kind: 'compressor',
    role: 'Low-end compressor that keeps kicks big and controlled.',
    params: [p('Thunder', amount), p('Output trim', (v) => signedDb(v > 0 ? 20 * Math.log10(v) : -120))],
  },
  makePyewacket: {
    title: 'Pyewacket',
    maker: 'Airwindows',
    kind: 'compressor',
    role: 'Fast, clean compressor that evens out peaks.',
    params: [p('Input gain', (v) => signedDb(v * 24 - 12)), p('Release', amount), p('Output gain', (v) => signedDb(v * 24 - 12))],
  },
  makeDeEss: {
    title: 'DeEss',
    maker: 'Airwindows',
    kind: 'compressor',
    role: 'De-esser: turns down harsh "s" and "t" sounds in the vocal.',
    params: [p('Intense', amount), p('Max DS', (v) => signedDb((v - 1) * 48)), p('Frequency', amount)],
  },
  makeAir2: {
    title: 'Air2',
    maker: 'Airwindows',
    kind: 'eq',
    role: 'Adds air and sheen to the top of the vocal.',
    params: [p('Hiss', (v) => (v * 2 - 1).toFixed(2)), p('Glitter', (v) => (v * 2 - 1).toFixed(2)), p('Air', (v) => (v * 2 - 1).toFixed(2)), p('Silk', amount), p('Dry/wet', amount)],
  },
  makeTexturizeMS: {
    title: 'TexturizeMS',
    maker: 'Airwindows',
    kind: 'texture',
    role: 'Adds brightness and punch, separately to the middle and the sides.',
    params: [p('Bright (mid)', amount), p('Punchy (mid)', amount), p('Dry/wet (mid)', amount), p('Bright (side)', amount), p('Punchy (side)', amount), p('Dry/wet (side)', amount)],
  },
  makeHuge: {
    title: 'Huge',
    maker: 'Airwindows',
    kind: 'saturation',
    role: 'Saturation that makes the bass fatter and louder.',
    params: [p('Huge', amount), p('Nasty', amount)],
  },
  makeKPlateA: {
    title: 'kPlate A',
    maker: 'Airwindows',
    kind: 'reverb',
    role: 'Plate reverb (the orchestral bus).',
    params: [p('Input pad', amount), p('Damping', fixed(2)), p('Low cut', fixed(2)), p('Predelay', (v) => fixed(0, ' ms')(v * v * 0.5 * 1000)), p('Wetness', amount)],
  },
  makeKPlateD: {
    title: 'kPlate D',
    maker: 'Airwindows',
    kind: 'reverb',
    role: 'Plate reverb on the reverb return.',
    params: [p('Input pad', amount), p('Damping', fixed(2)), p('Low cut', fixed(2)), p('Predelay', (v) => fixed(0, ' ms')(v * v * 0.5 * 1000)), p('Wetness', amount)],
  },
  makeStereoChorus: {
    title: 'Stereo Chorus',
    maker: 'Airwindows',
    kind: 'chorus',
    role: 'Chorus on the chorus return: width and movement.',
    params: [p('Speed', amount), p('Depth', amount)],
  },
  makeADClip7: {
    title: 'ADClip7',
    maker: 'Airwindows',
    kind: 'clipper',
    role: 'The final clipper on the master: catches peaks for loudness.',
    params: [
      p('Boost', (v) => fixed(1, ' dB')(v * 18)),
      p('Soften', amount),
      p('Enhance', amount),
      p('Mode', (v) => ['Normal', 'Atten', 'Clips'][Math.min(2, Math.floor(v * 2.999))]!),
    ],
  },
  makeFreqShiftEcho: {
    title: 'Freq Shift Echo',
    maker: 'Casperaki',
    kind: 'delay',
    role: 'Tempo-synced echo with a slight frequency shift on the repeats.',
    params: [
      p('Mix', amount),
      p('Shift', (v) => `${((v - 0.5) * 20 >= 0 ? '+' : '')}${((v - 0.5) * 20).toFixed(1)} Hz`),
      p('Feedback', amount),
      p('Sync', (v) => `${(0.5 + v * 7).toFixed(2)} beats`),
      p('Low cut', (v) => fixed(0, ' Hz')(20 * Math.pow(2000 / 20, v))),
      p('High cut', (v) => fixed(0, ' Hz')(200 * Math.pow(18000 / 200, v))),
    ],
  },
  makeSimpleSide: {
    title: 'Simple Side',
    maker: 'Casperaki',
    kind: 'pump',
    role: 'Tempo-synced volume pump (a sidechain feel without a sidechain).',
    params: [p('Mix', amount), p('Rate', (v) => `${Math.pow(2, v).toFixed(2)} beats`)],
  },
  makeConsole8BussIn: console8('Console8 Buss In', 'Console modelling, input of the master buss.', false),
  makeConsole8BussOut: console8('Console8 Buss Out', 'Console modelling, output of the master buss.', true),
  makeConsole8SubIn: console8('Console8 Sub In', 'Console modelling, input of this submix.', false),
  makeConsole8SubOut: console8('Console8 Sub Out', 'Console modelling, output of this submix.', true),
};
