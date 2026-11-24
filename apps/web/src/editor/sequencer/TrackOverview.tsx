import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@teamsuzie/ui';

import { BEATS_PER_BAR, type SeqNote, type SeqSection, type SeqTrack } from '../sequencerModel';
import { KEY_ROW_BASE, PianoRoll, Segmented, SmallButton } from './ClipDetail';
import { resolveColor } from './layout';
import type { BarRange } from './rangeDrag';
import { notesToAbc } from './notation';
import { Score } from './Score';
import { downloadScorePdf } from './scorePdf';
import { ExportMenu, type ExportItem } from '../../export/ExportMenu';

const GRIDS = [4, 8, 16, 32] as const;
type Grid = (typeof GRIDS)[number];
const LABEL_W = 104;

/**
 * One track across the whole song, read-only: the notes the engine plays
 * (resolved for this track alone) as a piano roll or a score with the
 * sections marked. The score can be downloaded as a PDF.
 */
export function TrackOverview({
  track,
  sections,
  totalBars,
  songTitle,
  soundName,
  songKey,
  bpm,
  notes,
  playheadBeat,
  onClose,
  exportItems,
}: {
  track: SeqTrack;
  sections: readonly SeqSection[];
  totalBars: number;
  songTitle: string;
  soundName: string | undefined;
  songKey: string;
  bpm: number;
  /** The engine's notes for the track (beats from the song start), or why they could not be read. */
  notes: { notes: SeqNote[] } | { error: string } | undefined;
  /** The song's playhead, in beats, while it plays. */
  playheadBeat: number | undefined;
  onClose(): void;
  /** Export this track (MIDI, audio); the score PDF is added here. */
  exportItems: readonly ExportItem[];
}) {
  const [view, setView] = useState<'roll' | 'score'>('score');
  const [grid, setGrid] = useState<Grid>(16);
  // Open with the whole song across the window.
  const [pxPerBeat, setPxPerBeat] = useState(() => Math.max(2, Math.min(240, (Math.min(1240, window.innerWidth - 32) - LABEL_W - 40) / (totalBars * BEATS_PER_BAR))));
  const [sel, setSel] = useState<BarRange | undefined>(undefined);
  const [vZoom, setVZoom] = useState(1);
  const [pdf, setPdf] = useState<'idle' | 'making' | { error: string }>('idle');
  const beats = totalBars * BEATS_PER_BAR;
  const marks = useMemo(() => new Map(sections.map((s) => [s.startBar, s.name])), [sections]);
  const scoreNotes = useMemo(
    // Sung parts carry their syllables (the lyrics go under the score).
    () => (notes && 'notes' in notes ? notes.notes.map((n) => ({ pitch: n.pitch!, start: n.start, length: n.length, ...(track.isVocal && n.label ? { lyric: n.label } : {}) })) : []),
    [notes, track.isVocal],
  );

  const exportPdf = async () => {
    setPdf('making');
    try {
      const abc = notesToAbc(scoreNotes, { beats, key: songKey, bpm, marks, barNumbers: true });
      await downloadScorePdf(abc, {
        fileName: `${safeName(songTitle)}-${safeName(track.name)}.pdf`,
        songTitle,
        part: soundName ? `${track.name} (${soundName})` : track.name,
        details: `${bpm} BPM · key ${songKey} · ${totalBars} bars`,
      });
      setPdf('idle');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A page loaded before an update asks for code files the new build renamed.
      setPdf({
        error: /dynamically imported module|Importing a module script failed/u.test(message)
          ? 'Casperaki was updated since this page was opened. Reload the page and export again.'
          : message,
      });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-h-[92vh] w-[min(1240px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none">
        <div className="flex flex-wrap items-center gap-3 border-b border-line/60 px-5 py-4 pr-12">
          <span className="h-3 w-3 rounded-full" style={{ background: track.color }} aria-hidden="true" />
          <div className="min-w-0">
            <DialogTitle className="text-[17px] font-semibold text-white">{track.name} · whole song</DialogTitle>
            <DialogDescription className="text-[12px] text-white/50">
              {soundName ? `${soundName} · ` : ''}
              {totalBars} bars{notes && 'notes' in notes ? ` · ${notes.notes.length} notes as played` : ''} · read-only
            </DialogDescription>
          </div>
          <div className="ml-auto">
            <ExportMenu
              items={[
                {
                  label: 'Score as PDF',
                  hint: 'A4, with bar numbers',
                  run: async () => {
                    if (scoreNotes.length === 0) throw new Error('No notes to print yet.');
                    await exportPdf();
                  },
                },
                ...exportItems,
              ]}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line/60 px-5 py-2.5 text-[13px]">
          <Segmented<'roll' | 'score'>
            label="View"
            value={view}
            options={[
              { value: 'roll', label: 'Piano roll' },
              { value: 'score', label: 'Score' },
            ]}
            onChange={setView}
          />
          {view === 'roll' ? (
            <>
              <Segmented<Grid> label="Grid" value={grid} options={GRIDS.map((g) => ({ value: g, label: `1/${g}` }))} onChange={setGrid} />
              <span className="flex items-center gap-1">
                <span className="mr-1 text-white/55">Zoom</span>
                <SmallButton label="Zoom out" onClick={() => setPxPerBeat((z) => Math.max(2, z / 1.4))}>−</SmallButton>
                <SmallButton label="Zoom in" onClick={() => setPxPerBeat((z) => Math.min(240, z * 1.4))}>+</SmallButton>
                <span className="ml-2 mr-1 text-white/55">Height</span>
                <SmallButton label="Rows smaller" onClick={() => setVZoom((z) => Math.max(0.5, z / 1.25))}>−</SmallButton>
                <SmallButton label="Rows taller" onClick={() => setVZoom((z) => Math.min(3, z * 1.25))}>+</SmallButton>
              </span>
            </>
          ) : null}
          {typeof pdf === 'object' ? <span className="text-[12px] text-err">The PDF could not be made: {pdf.error}</span> : null}
        </div>

        <div className="max-h-[calc(92vh-150px)] overflow-auto bg-[#1a1b1e]">
          {notes === undefined ? (
            <p className="px-5 py-10 text-[14px] text-white/55">Reading the notes the engine plays…</p>
          ) : 'error' in notes ? (
            <p className="px-5 py-10 text-[14px] text-err">{notes.error}</p>
          ) : notes.notes.length === 0 ? (
            <p className="px-5 py-10 text-[14px] text-white/55">The engine plays no notes for this track.</p>
          ) : view === 'score' ? (
            <Score notes={scoreNotes} beats={beats} songKey={songKey} bpm={bpm} beat={playheadBeat} marks={marks}
              barNumbers
              title={songTitle}
              subtitle={`Part: ${soundName ? `${track.name} (${soundName})` : track.name}`}
            />
          ) : (
            <div className="relative">
              <SectionStrip sections={sections} pxPerBeat={pxPerBeat} />
              <PianoRoll
                notes={notes.notes}
                beats={beats}
                grid={grid}
                pxPerBeat={pxPerBeat}
                color={resolveColor(track.color)}
                head={playheadBeat}
                keyH={Math.round(KEY_ROW_BASE * vZoom)}
                sel={sel}
                onSel={setSel}
                looping={false}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Section names over the piano roll. */
function SectionStrip({ sections, pxPerBeat }: { sections: readonly SeqSection[]; pxPerBeat: number }) {
  return (
    <div className="relative h-5 bg-[#202124]" style={{ marginLeft: LABEL_W }}>
      {sections.map((s) => (
        <span
          key={s.name}
          className="absolute top-0 h-full truncate border-l-2 px-1 text-[10px] font-semibold leading-5 text-white"
          style={{ left: s.startBar * BEATS_PER_BAR * pxPerBeat, width: s.bars * BEATS_PER_BAR * pxPerBeat, borderColor: s.color, background: `color-mix(in srgb, ${s.color} 25%, transparent)` }}
        >
          {s.name}
        </span>
      ))}
    </div>
  );
}

function safeName(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/gu, '') || 'score';
}
