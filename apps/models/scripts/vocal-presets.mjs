// Genre presets for the ACE vocal-pipeline smoke test.
//
// Each preset drives a `layer`-mode generation (ACE-Step `lego` task): ACE adds
// a single vocal track locked to that genre's Casperaki backing track — same
// tempo/key/structure — then SAM-Audio isolates the vocal stem. The recipe
// (lego + low cover-strength + high CFG + tags-with-BPM + structured lyrics with
// a blank [intro]) follows the ACE-Step audio-to-audio layering workflow.

const RENDER_ROOT =
  '/home/roli79/apps/casperaki/apps/engine-spike/out/all-genre-render-smoke';

export const PRESETS = {
  edm: {
    referencePath: `${RENDER_ROOT}/edm/out.wav`,
    referenceMode: 'layer',
    trackName: 'vocals',
    prompt:
      'female vocals, lead vocal, clean, catchy pop vocal hook, upbeat ' +
      'electronic dance pop, EDM, 128 BPM, key C',
    lyrics: [
      '[intro]',
      '',
      '[verse]',
      'City lights are calling out my name',
      'Nothing here will ever feel the same',
      'Hold me closer, never let me go',
      'We are the only ones who know',
      '',
      '[chorus]',
      'We come alive tonight',
      'Dancing in the neon light',
      'Hands up, feel the bass go higher',
      'We come alive tonight',
    ].join('\n'),
    styleStrength: 0.3,
    guidanceScale: 24,
    bpm: 128,
    keyScale: 'C',
  },

  urban: {
    referencePath: `${RENDER_ROOT}/urban/out.wav`,
    referenceMode: 'layer',
    trackName: 'vocals',
    prompt:
      'male vocals, male rapper, hip hop, rap, urban, rhythmic confident rap ' +
      'flow, clean, modern trap production, 90 BPM, key C',
    lyrics: [
      '[intro]',
      '',
      '[verse]',
      "Yeah, came up from the bottom now I'm standing tall",
      'City on my back and I can hear it call',
      'Every single night grinding, no days off',
      "Had a dream in the dark, now I'm taking it all",
      '',
      '[chorus]',
      "We don't stop, we don't quit",
      'Light it up, every bit',
      "We don't stop, we don't quit",
      'This the moment, this the hit',
      '',
      '[verse]',
      'Look, paper chasing, never lose my focus',
      'Out the mud, watch the whole world notice',
      'Stack it up, keep my circle closest',
      'Made a way, now they wonder how I got it',
    ].join('\n'),
    styleStrength: 0.3,
    guidanceScale: 24,
    bpm: 90,
    keyScale: 'C',
  },
};
