import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@teamsuzie/ui';

import { dawExportApi, dawExportLabel, type DawExportStatus, type DawFormat } from '../api/dawExport';
import { renderInFlight, renderLabel } from '../api/songs';
import { livePlayer, type ResolvedMix } from '../audio/livePlayer';
import { useLiveTransport } from '../audio/useLiveTransport';
import { colorHex } from '../editor/sequencer/layout';
import { buildSequencerModel, trackColor } from '../editor/sequencerModel';
import { useSession } from '../state/session';
import { useRenderStatus, useSaveSong, useStartRender } from '../state/useSongActions';
import { downloadBytes, fileStem, songMidiParts, toBase64 } from './exportMidi';

type Format = 'mix' | 'midi' | DawFormat;

const FORMATS: readonly { id: Format; name: string; detail: string }[] = [
  { id: 'mix', name: 'Mix', detail: 'The finished song as WAV and MP3.' },
  { id: 'stems', name: 'Stems', detail: 'One 24-bit WAV per track, with effects, adding up to the mix.' },
  { id: 'midi', name: 'MIDI', detail: 'The parts as played, tempo, key and sections as markers.' },
  { id: 'reaper', name: 'REAPER project', detail: 'Stems on tracks, sections as regions, the MIDI in a muted folder.' },
  { id: 'logic', name: 'Logic Pro', detail: 'Stems from bar 1 plus a MIDI file with tempo and markers, and how to import them.' },
];

/**
 * The song's exports in one place: the mix (WAV / MP3), stems, MIDI, a
 * REAPER project and a Logic bundle, with the tracks to include. Stems and
 * the DAW bundles are rendered on the server from the saved song (unsaved
 * edits are saved first); MIDI is made here from the version on screen.
 */
export function ExportDialog({ onClose }: { onClose(): void }) {
  const { activeSong, viewSong, editorDirty } = useSession();
  const { liveKey, fetchPayload } = useLiveTransport();
  const save = useSaveSong();
  const renderStatus = useRenderStatus(activeSong?.id);
  const startRender = useStartRender();
  const [format, setFormat] = useState<Format>('stems');
  const [mix, setMix] = useState<ResolvedMix | { error: string } | undefined>(undefined);
  const [chosen, setChosen] = useState<Set<string> | undefined>(undefined);
  const [job, setJob] = useState<DawExportStatus | { error: string } | 'saving' | 'midi' | undefined>(undefined);

  const model = useMemo(() => (viewSong ? buildSequencerModel(viewSong) : undefined), [viewSong]);
  // The tracks the engine plays (stems are per engine lane), in the song's order.
  const lanes = useMemo(() => {
    if (!mix || 'error' in mix || !model) return [];
    const engine = [...new Set(mix.lanes.map((l) => l.lane))];
    const order = model.tracks.map((t) => t.name);
    return [...order.filter((n) => engine.includes(n)), ...engine.filter((n) => !order.includes(n))];
  }, [mix, model]);
  const selected = chosen ?? new Set(lanes);

  useEffect(() => {
    if (!liveKey) return;
    let cancelled = false;
    livePlayer.mixOf(liveKey, fetchPayload).then(
      (m) => !cancelled && setMix(m),
      (err: unknown) => !cancelled && setMix({ error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [liveKey, fetchPayload]);

  // Follow a server export until it is done, then download it.
  const running = job && typeof job === 'object' && 'state' in job && job.state !== 'done' && job.state !== 'failed' ? job : undefined;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      dawExportApi.status(running.id).then(
        (s) => {
          setJob(s);
          if (s.state === 'done' && s.downloadUrl) window.location.assign(s.downloadUrl);
        },
        (err: unknown) => setJob({ error: err instanceof Error ? err.message : String(err) }),
      );
    }, 1000);
    return () => clearInterval(t);
  }, [running]);

  if (!activeSong || !viewSong || !model) return null;
  const title = activeSong.project.title;
  const tracksUsed = format !== 'mix';
  const choice = lanes.filter((l) => selected.has(l));

  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setChosen(next);
  };

  const exportMidi = async () => {
    if (!liveKey) throw new Error('Nothing to export yet.');
    setJob('midi');
    try {
      const parts = await songMidiParts(viewSong, title, liveKey, fetchPayload, choice);
      downloadBytes(parts.song, `${fileStem(title)}.mid`, 'audio/midi');
      setJob(undefined);
    } catch (err) {
      setJob({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  const exportDaw = async (f: DawFormat) => {
    if (!liveKey) throw new Error('Nothing to export yet.');
    try {
      let songId = activeSong.id;
      if (editorDirty) {
        setJob('saving');
        songId = (await save.mutateAsync()).id;
      }
      setJob('midi');
      const parts = f === 'stems' ? undefined : await songMidiParts(viewSong, title, liveKey, fetchPayload, choice);
      const colors: Record<string, string> = {};
      for (const name of choice) colors[name] = colorHex(trackColor(name));
      const s = await dawExportApi.start(songId, {
        format: f,
        tracks: choice.length === lanes.length ? [] : choice,
        ...(parts
          ? { midi: { song: toBase64(parts.song), tracks: Object.fromEntries(Object.entries(parts.tracks).map(([k, v]) => [k, toBase64(v)])) } }
          : {}),
        colors,
      });
      setJob(s);
    } catch (err) {
      setJob({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  const render = renderStatus.data;
  const busy = job === 'saving' || job === 'midi' || Boolean(running);
  const statusText =
    job === 'saving'
      ? 'Saving your edits…'
      : job === 'midi'
        ? 'Making the MIDI…'
        : job && typeof job === 'object'
          ? 'error' in job
            ? `Export failed: ${job.error}`
            : dawExportLabel(job)
          : undefined;

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="w-[min(860px,calc(100vw-2rem))] max-w-none gap-0 rounded-[12px] border border-line bg-panel p-0 text-white sm:max-w-none">
        <div className="border-b border-line/60 px-6 py-4 pr-12">
          <DialogTitle className="text-[18px] font-semibold text-white">Export</DialogTitle>
          <DialogDescription className="mt-0.5 text-[13px] text-white/55">
            {title}
            {editorDirty ? ' · unsaved edits are saved first for audio exports' : ''}
          </DialogDescription>
        </div>
        <div className="grid min-h-[360px] grid-cols-[260px_1fr]">
          <div className="flex flex-col gap-1 border-r border-line/60 p-3" role="radiogroup" aria-label="What to export">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={format === f.id}
                onClick={() => setFormat(f.id)}
                className={`rounded-[8px] px-3 py-2.5 text-left ${format === f.id ? 'bg-white/12 ring-1 ring-white/40' : 'hover:bg-white/6'}`}
              >
                <div className="text-[14px] font-semibold text-white">{f.name}</div>
                <div className="mt-0.5 text-[12px] leading-snug text-white/55">{f.detail}</div>
              </button>
            ))}
          </div>

          <div className="flex flex-col p-5">
            {format === 'mix' ? (
              <div className="flex flex-col gap-3 text-[14px]">
                {render?.state === 'done' && !editorDirty ? (
                  <>
                    <p className="text-white/75">The mix of the saved song is ready.</p>
                    <div className="flex gap-2">
                      <a className="h-10 rounded-full bg-white px-5 text-[14px] font-semibold leading-10 text-black hover:bg-white/85" href={`${render.mp3Url}?download=1`}>
                        Download MP3
                      </a>
                      <a className="h-10 rounded-full border border-white/40 px-5 text-[14px] font-semibold leading-10 text-white hover:border-white" href={`${render.wavUrl}?download=1`}>
                        Download WAV
                      </a>
                    </div>
                  </>
                ) : renderInFlight(render) || startRender.isPending ? (
                  <p className="text-white/75">Rendering: {renderLabel(render)}</p>
                ) : (
                  <>
                    <p className="text-white/75">
                      {render?.state === 'failed' ? `The last render failed: ${render.error}` : 'Render the mix on the server (about half a minute).'}
                    </p>
                    <button
                      type="button"
                      onClick={async () => {
                        const id = editorDirty ? (await save.mutateAsync()).id : activeSong.id;
                        startRender.mutate(id);
                      }}
                      className="h-10 w-fit rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000]"
                    >
                      {editorDirty ? 'Save and render WAV + MP3' : 'Render WAV + MP3'}
                    </button>
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between text-[13px] text-white/60">
                  <span>Tracks</span>
                  <span className="flex gap-3">
                    <button type="button" className="hover:text-white" onClick={() => setChosen(new Set(lanes))}>
                      All
                    </button>
                    <button type="button" className="hover:text-white" onClick={() => setChosen(new Set())}>
                      None
                    </button>
                  </span>
                </div>
                {mix === undefined ? (
                  <p className="text-[13px] text-white/55">Reading the tracks…</p>
                ) : 'error' in mix ? (
                  <p className="text-[13px] text-err">{mix.error}</p>
                ) : (
                  <div className="grid max-h-[230px] grid-cols-2 gap-1 overflow-auto">
                    {lanes.map((name) => (
                      <label key={name} className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[13px] hover:bg-white/6">
                        <input type="checkbox" checked={selected.has(name)} onChange={() => toggle(name)} className="accent-[#ff0000]" />
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: trackColor(name) }} aria-hidden="true" />
                        <span className="truncate">{name}</span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="mt-auto flex items-center gap-3 pt-4">
                  <button
                    type="button"
                    disabled={!tracksUsed || choice.length === 0 || busy || !liveKey}
                    onClick={() => void (format === 'midi' ? exportMidi() : exportDaw(format as DawFormat))}
                    className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000] disabled:opacity-40"
                  >
                    {format === 'midi' ? 'Download MIDI' : editorDirty ? 'Save and export' : 'Export'}
                  </button>
                  {statusText ? (
                    <span className={`text-[13px] ${job && typeof job === 'object' && ('error' in job || job.state === 'failed') ? 'text-err' : 'text-white/70'}`} role="status">
                      {statusText}
                    </span>
                  ) : format !== 'midi' ? (
                    <span className="text-[12px] text-white/45">Rendered on the server: about half a minute per track, several at once.</span>
                  ) : null}
                </div>
                {job && typeof job === 'object' && 'state' in job && job.state === 'done' && job.downloadUrl ? (
                  <a className="mt-2 text-[13px] text-white underline" href={job.downloadUrl}>
                    Download {job.fileName} again
                  </a>
                ) : null}
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
