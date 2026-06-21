<script setup>
import Module from "@wasm/libcasperaki_engine_staticlib.js";
import song from '@/assets/songs/1/song.json';
import song2 from '@/assets/songs/2/song.json';
import inst1 from '@/assets/songs/1/inst-1.json';
import inst2 from '@/assets/songs/1/inst-2.json';
import inst3 from '@/assets/songs/1/inst-3.json';
import inst4 from '@/assets/songs/1/inst-4.json';
import inst5 from '@/assets/songs/1/inst-5.json';
import inst6 from '@/assets/songs/1/inst-6.json';
import inst7 from '@/assets/songs/1/inst-7.json';
import inst8 from '@/assets/songs/1/inst-8.json';
import inst9 from '@/assets/songs/1/inst-9.json';
import inst10 from '@/assets/songs/1/inst-10.json';
import inst12 from '@/assets/songs/1/inst-12.json';
import inst13 from '@/assets/songs/1/inst-13.json';
import inst14 from '@/assets/songs/1/inst-14.json';
import inst15 from '@/assets/songs/1/inst-15.json';

import { computed, ref } from "vue";

console.log(Module);

let caspEngineModule;
let casperakiEngine;

let currentState = ref({
  bar: 0,
  beat: 0,
  step: 0,
  position: 0,
});

const initalised = computed(() => {
  return !!casperakiEngine;
});

async function initSoundSystem() {

  window.casperakiEngineCallback = (controlState) => {
    // console.log(`casperakiEngineCallback bar: ${controlState.bar}, beat: ${controlState.beat}, step: ${controlState.step}, pos: ${controlState.position}`);

    currentState.value = {
      bar: controlState.bar,
      beat: controlState.beat,
      step: controlState.step,
      position: controlState.position,
    };
  };


  caspEngineModule = await Module({
    locateFile: (fileName) => window.location.origin + "/wasm/" + fileName,
  });


  caspEngineModule.setControlStateCallback();

  // caspEngineModule.FS.mkdir('/tempdata');

  console.log("Here");
  try {
    caspEngineModule.FS.mount(caspEngineModule.IDBFS, {}, '/tempdata');
    console.log("IDBFS mounted", caspEngineModule.IDBFS);
  } catch (e) {
    console.error(e);
  }

  caspEngineModule.FS.syncfs(true, function (err) {
    console.error("syncfs", err);
  });

  casperakiEngine = caspEngineModule.getCasperakiEngine();

}

async function play() {
  console.log("SONG!", song);
  casperakiEngine.play();
}

async function pause() {
  casperakiEngine.pause();
}

async function loadSong() {
  const instrumentalGenerator = caspEngineModule.getInstrumentalGenerator();

  instrumentalGenerator.loadSongDataStr(JSON.stringify(song2));
}

function getEditFileContent() {
  let filename = casperakiEngine.createZipFile();

  console.log('created zip file: ' + filename);
  let content = caspEngineModule.FS.readFile(filename);

  const mime = 'application/octet-stream';


  var a = document.createElement('a');
  a.download = 'casperaki.zip';
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.style.display = 'none';

  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    // targetButton.removeAttribute ( 'disabled' );
  }, 2000);
}

async function loadPattern() {
  await casperakiEngine.addInstrument(JSON.stringify({
    id: 100,
    name: 'Drums',
    type: 'drums',
    lowLevelType: 'drums',
    shortName: 'drums',
    "ids": {
      bassDrum1: 27023,
      bassDrum2: 26993,
      tom2: 27561,
      snareDrum1: 27128,
      tom1: 27562,
      crash2: 27613,
      shaker: 27782,
      crash1: 27613,
      hiHatOpen: 27502,
      tom3: 27563,
      ride: 27668,
      snap: 27263,
      hiHatClosed2: 27406,
      clap: 27246,
      hiHatPedal: 27435,
      hiHatClosed1: 27433,
      snareDrum2: 27126
    },
    busyness: 3,
    patternStyle: 'edm',
    subInstruments: {
      bassDrum1: {
        id: 27023,
        type: 'kickDrums',
        lowLevelType: 'kickDrumsElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'kickDrums',
      },
      bassDrum2: {
        id: 26993,
        type: 'kickDrums',
        lowLevelType: 'kickDrumsElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'kickDrums',
      },
      snareDrum1: {
        id: 27128,
        type: 'snareDrums',
        lowLevelType: 'snareDrumsElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
      snareDrum2: {
        id: 27126,
        type: 'snareDrums',
        lowLevelType: 'snareDrumsElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
      hiHatClosed1: {
        id: 27433,
        type: 'hiHatsClosed',
        lowLevelType: 'hiHatsClosedElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
      hiHatClosed2: {
        id: 27406,
        type: 'hiHatsClosed',
        lowLevelType: 'hiHatsClosedElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
      hiHatPedal: {
        id: 19656,
        type: 'hiHatsClosed',
        lowLevelType: 'hiHatsClosedElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
      hiHatOpen: {
        id: 27494,
        type: 'hiHatsOpen',
        lowLevelType: 'hiHatsOpenElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
      tom1: {
        id: 27562,
        type: 'toms',
        lowLevelType: 'tomsElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
      tom3: {
        id: 33688,
        type: 'toms',
        lowLevelType: 'tomsElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
      tom2: {
        id: 27561,
        type: 'toms',
        lowLevelType: 'tomsElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
      crash2: {
        id: 27613,
        type: 'cymbals',
        lowLevelType: 'cymbalsCrashHit',
        details: {
          name: 'Big_Z_Crash_2.wav',
          climax: 0,
          duration: 4.838707,
        },
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
      crash1: {
        id: 27613,
        type: 'cymbals',
        lowLevelType: 'cymbalsCrashHit',
        details: {
          name: 'Big_Z_Crash_3.wav',
          climax: 0,
          duration: 2.419342,
        },
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
      ride: {
        id: 27668,
        type: 'cymbals',
        lowLevelType: 'cymbalsRideBell',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
      clap: {
        id: 27246,
        type: 'clapsSnaps',
        lowLevelType: 'clapsSnapsClapsElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'snareDrumsClapSnap',
      },
      snap: {
        id: 27263,
        type: 'clapsSnaps',
        lowLevelType: 'clapsSnapsClapsElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'snareDrumsClapSnap',
      },
      shaker: {
        id: 27782,
        type: 'shakers',
        lowLevelType: 'shakersElectronic',
        details: null,
        isVst: false,
        isSample: true,
        instrumentGroup: 'restOfDrumsAndLoops',
      },
    },
    instrumentGroup: 'restOfDrumsAndLoops',
    loaded: false,
  }));
  console.log('ADDED DRUMS!');

  await casperakiEngine.addInstrument(JSON.stringify({
    id: 1876,
    type: 'synths',
    lowLevelType: 'synthsBrightPad',
    details: {
      LUFS: '-24.0',
      vstPlugin: 'Serum - Broken bows pad (Serum preset)',
      octaveAdjustment: '-2',
    },
    isVst: true,
    isSample: false,
    name: 'Serum - Broken bows pad (Serum preset)',
    shortName: 'pad',
    instrumentGroup: 'pads',
    samples: [
      {
        id: 25670,
        vst: 1876,
        note: 'c2',
        type: 'longNote',
      },
      {
        id: 25671,
        vst: 1876,
        note: 'd#2',
        type: 'longNote',
      },
      {
        id: 25672,
        vst: 1876,
        note: 'f#2',
        type: 'longNote',
      },
      {
        id: 25673,
        vst: 1876,
        note: 'a2',
        type: 'longNote',
      },
      {
        id: 25674,
        vst: 1876,
        note: 'c3',
        type: 'longNote',
      },
      {
        id: 25675,
        vst: 1876,
        note: 'd#3',
        type: 'longNote',
      },
      {
        id: 25676,
        vst: 1876,
        note: 'f#3',
        type: 'longNote',
      },
      {
        id: 25677,
        vst: 1876,
        note: 'a3',
        type: 'longNote',
      },
      {
        id: 25678,
        vst: 1876,
        note: 'c4',
        type: 'longNote',
      },
      {
        id: 25679,
        vst: 1876,
        note: 'd#4',
        type: 'longNote',
      },
      {
        id: 25680,
        vst: 1876,
        note: 'f#4',
        type: 'longNote',
      },
      {
        id: 25681,
        vst: 1876,
        note: 'a4',
        type: 'longNote',
      },
      {
        id: 25682,
        vst: 1876,
        note: 'c5',
        type: 'longNote',
      },
      {
        id: 25683,
        vst: 1876,
        note: 'd#5',
        type: 'longNote',
      },
      {
        id: 25684,
        vst: 1876,
        note: 'f#5',
        type: 'longNote',
      },
      {
        id: 25685,
        vst: 1876,
        note: 'a5',
        type: 'longNote',
      },
      {
        id: 25686,
        vst: 1876,
        note: 'c6',
        type: 'longNote',
      },
    ],
    loaded: false,
  }));
  console.log('ADDED SYNTH!');

  await casperakiEngine.setSong(JSON.stringify({
    state: 'loaded',
    key: 'C',
    id: 118484,
    arrangement: {},
    structure: [
      {
        segment: 'default',
        bars: [
          {
            chords: ['C', 'C', 'C', 'C'],
          },
          {
            chords: ['C', 'C', 'C', 'C'],
          },
        ],
      },
    ],
    patterns: [
      {
        pattern: [
          {
            pattern: {
              bassDrum1: 'x0000000 x0000000 x0000000 x0000000|x0000000 x0000000 x0000000 x0000000',
              hiHatClosed1: '0000x000 x000x0x0 x0x0x0x0 x0x0x0x0|0000x000 x000x0x0 x0x0x0x0 x0x0x0x0',
              hiHatOpen: '0000x000 0000x000 0000x000 0000x000|0000x000 0000x000 0000x000 0000x000',
              hiHatClosed2: '00000000 xxxxxxxx 00000000 00000000|00000000 xxxxxxxx 00000000 00000000',
              snareDrum1: '00000000 x0000000 00000000 x0000000|00000000 x0000000 00000000 x0000000',
              clap: '00000000 00000000 00000000 x0000000|00000000 00000000 00000000 x0000000',
              shaker: '000000x0 00000000 00000000 00x00000|000000x0 00000000 00000000 00x00000',
            },
            "patternType": "drums",
            "instrumentIds": {
              bassDrum1: 27023,
              bassDrum2: 26993,
              tom2: 27561,
              snareDrum1: 27128,
              tom1: 27562,
              crash2: 27613,
              shaker: 27782,
              crash1: 27613,
              hiHatOpen: 27502,
              tom3: 27563,
              ride: 27668,
              snap: 27263,
              hiHatClosed2: 27406,
              clap: 27246,
              hiHatPedal: 27435,
              hiHatClosed1: 27433,
              snareDrum2: 27126
            },
            "instrumentName": "Drums",
            "instrumentType": "drums",
            "instrumentType1": "drums",
            "drumsBusyness": 3,
            "drumsPatternStyle": "brightPop",
            "instrumentId": 100,
          },
          {
            bars: [
              {
                notes: {
                  '0.0': [
                    {
                      type: 'note',
                      note: 'c2',
                      duration: 0.75,
                    },
                  ],
                  '0.75': [
                    {
                      type: 'note',
                      note: 'c2',
                      duration: 0.5,
                    },
                  ],
                  '1.5': [
                    {
                      type: 'note',
                      note: 'c2',
                      duration: 0.5,
                    },
                  ],
                  '2.25': [
                    {
                      type: 'note',
                      note: 'c2',
                      duration: 0.25,
                    },
                  ],
                  '2.5': [
                    {
                      type: 'note',
                      note: 'c2',
                      duration: 0.5,
                    },
                  ],
                  '3.0': [
                    {
                      type: 'note',
                      note: 'g1',
                      duration: 0.5,
                    },
                  ],
                  '3.5': [
                    {
                      type: 'note',
                      note: 'c2',
                      duration: 0.5,
                    },
                  ],
                },
              },
              {
                notes: {
                  '0.0': [
                    {
                      type: 'note',
                      note: 'c2',
                      duration: 0.75,
                    },
                  ],
                  '0.75': [
                    {
                      type: 'note',
                      note: 'c2',
                      duration: 0.5,
                    },
                  ],
                  '1.5': [
                    {
                      type: 'note',
                      note: 'c2',
                      duration: 0.5,
                    },
                  ],
                  '2.25': [
                    {
                      type: 'note',
                      note: 'c2',
                      duration: 0.25,
                    },
                  ],
                  '2.5': [
                    {
                      type: 'note',
                      note: 'c2',
                      duration: 0.5,
                    },
                  ],
                  '3.0': [
                    {
                      type: 'note',
                      note: 'c2',
                      duration: 1,
                    },
                  ],
                },
              },
            ],
            patternType: 'instrument',
            instrumentId: 26142,
            instrumentName: 'Bass',
            instrumentType: 'bass',
            instrumentType1: 'bass',
            bassPatternStyle: 'edmHardSM',
          },
          {
            bars: [
              {
                notes: {
                  '0.0': [
                    {
                      type: 'chord',
                      chord: 'C',
                      chordType: 'oneOctaveMid',
                      duration: 4,
                    },
                  ],
                },
              },
              {
                notes: {
                  '0.0': [
                    {
                      type: 'chord',
                      chord: 'C',
                      chordType: 'oneOctaveMid',
                      duration: 4,
                    },
                  ],
                },
              },
            ],
            patternType: 'instrument',
            instrumentId: 1876,
            instrumentName: 'Serum - Broken bows pad (Serum preset)',
            instrumentType: 'customInstrument',
            instrumentType1: 'synthsBrightPad',
          },
          {
            patternType: 'instrument',
            instrumentId: 28306,
            instrumentName: 'Loop',
            instrumentType: 'customInstrument',
            instrumentType1: 'percussionMiscLoop',
          },
          {
            bars: [
              {
                notes: {
                  '0.0': [
                    {
                      type: 'chord',
                      chord: 'C',
                      chordType: 'pianoRightHand',
                      duration: 0.5,
                    },
                  ],
                  '0.75': [
                    {
                      type: 'chord',
                      chord: 'C',
                      chordType: 'pianoRightHand',
                      duration: 0.5,
                    },
                  ],
                  '1.5': [
                    {
                      type: 'chord',
                      chord: 'C',
                      chordType: 'pianoRightHand',
                      duration: 0.5,
                    },
                  ],
                  '2.25': [
                    {
                      type: 'chord',
                      chord: 'C',
                      chordType: 'pianoRightHand',
                      duration: 0.5,
                    },
                  ],
                  '3.0': [
                    {
                      type: 'chord',
                      chord: 'C',
                      chordType: 'pianoRightHand',
                      duration: 0.5,
                    },
                  ],
                },
              },
              {
                notes: {
                  '0.0': [
                    {
                      type: 'chord',
                      chord: 'C',
                      chordType: 'pianoRightHand',
                      duration: 0.5,
                    },
                  ],
                  '0.75': [
                    {
                      type: 'chord',
                      chord: 'C',
                      chordType: 'pianoRightHand',
                      duration: 0.5,
                    },
                  ],
                  '1.5': [
                    {
                      type: 'chord',
                      chord: 'C',
                      chordType: 'pianoRightHand',
                      duration: 0.5,
                    },
                  ],
                  '2.25': [
                    {
                      type: 'chord',
                      chord: 'C',
                      chordType: 'pianoRightHand',
                      duration: 0.5,
                    },
                  ],
                  '3.0': [
                    {
                      type: 'chord',
                      chord: 'C',
                      chordType: 'pianoRightHand',
                      duration: 0.5,
                    },
                  ],
                },
              },
            ],
            patternType: 'instrument',
            instrumentId: 18558,
            instrumentName: 'M1 KORG - Pianos 1',
            instrumentType: 'customInstrument',
            instrumentType1: 'keysAcousticPiano',
          },
        ],
      },
    ],
    tempo: 121,
    genre: 'edm',
    default: true,
  }));
  console.log('SET SONG!');

  caspEngineModule.FS.syncfs(false, function (err) {
    console.error("syncfs", err);
  });

  return;





}
</script>

<template>
  <span class="block w-6 h-6 rounded-full" :class="{ 'bg-red-500': !initalised, 'bg-green-500': initalised }"></span>
  <button @click="initSoundSystem"
    class="w-full px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500">
    Init Sound System
  </button>
  <button
    class="w-full px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
    @click="loadPattern">
    Load pattern
  </button>
  <button
    class="w-full px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500"
    @click="loadSong">
    Load song
  </button>
  <button @click="play"
    class="w-full px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500">
    Play
  </button>
  <button @click="pause"
    class="w-full px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500">
    Pause
  </button>
  <button @click="getEditFileContent"
    class="w-full px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500">
    Get edit
  </button>
  <div class="w-full bg-gray-200">
    <pre>beat: {{ currentState.bar }}/{{ currentState.beat }}/{{ currentState.step }} pos: {{ currentState.position }}</pre>
  </div>
</template>
