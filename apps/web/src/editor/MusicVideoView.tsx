import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { avatarsApi, avatarsQueryKey } from '../api/avatars';
import { ofStyle, stylesOf, type AvatarStyle } from '../avatars/realisticDesign';
import { playbackApi } from '../api/playback';
import { videoApi, videoQueryKeys, type VideoFormat, type VideoJobs, type VideoOrientation, type VideoQuality, type VideoStatus } from '../api/video';
import { livePlayer } from '../audio/livePlayer';
import { useSession } from '../state/session';
import { LEAD_VOCAL_NAME } from '../types/song';
import { buildMeasuredLevels, measureTracks } from './trackLevels';
import { AvatarStoryboardEditor } from './AvatarStoryboardEditor';
import { sectionLabel, storyboardFor, type StoryboardEntry } from './avatarStoryboard';
import { BEATS_PER_BAR, buildSequencerModel } from './sequencerModel';

/** How many avatars a dance floor video shows. */
const MAX_AVATARS = 5;

const ORIENTATIONS: readonly { id: VideoOrientation; label: string; hint: string }[] = [
  { id: 'landscape', label: 'Wide', hint: '1920 × 1080, for YouTube' },
  { id: 'portrait', label: 'Tall', hint: '1080 × 1920, for TikTok, Reels and Shorts' },
];

/** The song's video job for a format (none yet: undefined). */
export function jobFor(jobs: VideoJobs | undefined, format: VideoFormat): VideoStatus | undefined {
  return jobs?.jobs.avatars[format];
}

/**
 * Music Video tab: the 3D avatar video of the saved song, wide or tall, rendered in the background from the song's mix
 * (exported first if needed): the user's avatars perform in 3D scenes, planned section by section in the storyboard.
 * The tab first measures each track's level through the in-browser engine (the lead vocal's drive the singer's mouth)
 * and sends them for the version that is saved.
 */
export function MusicVideoView() {
  const { songId } = useParams<{ songId: string }>();
  if (!songId) throw new Error('MusicVideoView: no song id in the route');
  const { viewSong, editorDirty } = useSession();
  const queryClient = useQueryClient();
  const [orientation, setOrientation] = useState<VideoOrientation>('landscape');
  /** The share of the track levels measured so far (0..1) while measuring. */
  const [measuring, setMeasuring] = useState<number | undefined>(undefined);
  const [artist, setArtist] = useState('Casperaki');
  const [quality, setQuality] = useState<VideoQuality>('full');
  /** The avatars chosen to dance (undefined: the first MAX_AVATARS of the user's avatars). */
  const [picked, setPicked] = useState<readonly string[] | undefined>(undefined);
  const avatars = useQuery({ queryKey: avatarsQueryKey, queryFn: ({ signal }) => avatarsApi.list(signal) });
  // One style per video (anime and realistic side by side clash): the switch shows only when the user has both.
  const styles = stylesOf(avatars.data?.avatars ?? []);
  const [chosenStyle, setChosenStyle] = useState<AvatarStyle | undefined>(undefined);
  const style: AvatarStyle = chosenStyle ?? styles[0] ?? 'anime';
  const styleAvatars = ofStyle(avatars.data?.avatars ?? [], style);
  const avatarIds = picked ?? styleAvatars.slice(0, MAX_AVATARS).map((a) => a.id);
  const pickStyle = (s: AvatarStyle) => {
    setChosenStyle(s);
    setPicked(undefined);
    setEdited(undefined);
  };
  /** The storyboard as edited (undefined: today's video, club, everyone, automatic camera). */
  const [edited, setEdited] = useState<readonly StoryboardEntry[] | undefined>(undefined);
  const sections = storyboardSections(viewSong);
  const chosenAvatars = avatarIds.map((id) => avatars.data?.avatars.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => a !== undefined);
  const board = storyboardFor(edited, sections.length, avatarIds);
  const togglePick = (id: string) =>
    setPicked(avatarIds.includes(id) ? avatarIds.filter((x) => x !== id) : avatarIds.length >= MAX_AVATARS ? avatarIds : [...avatarIds, id]);
  const format: VideoFormat = quality === 'preview' ? `${orientation}-preview` : orientation;

  const jobs = useQuery({
    queryKey: videoQueryKeys.jobs(songId),
    queryFn: ({ signal }) => videoApi.jobs(songId, signal),
    refetchInterval: (q) =>
      Object.values(q.state.data?.jobs.avatars ?? {}).some((j) => j && (j.state === 'queued' || j.state === 'running'))
        ? 2000
        : false,
  });
  const start = useMutation({
    mutationFn: async () => {
      if (editorDirty) throw new Error('Save the song first: the video shows the saved version.');
      if (avatarIds.length === 0) throw new Error('Choose at least one avatar (make them on the Avatars page).');
      if (!viewSong) throw new Error('The song is not loaded yet.');
      setMeasuring(0);
      try {
        const meters = await measureTracks(livePlayer, songId, (signal) => playbackApi.forSaved(songId, signal), setMeasuring);
        const model = buildSequencerModel(viewSong);
        const levels = buildMeasuredLevels({ model, meters, leadVocal: model.tracks.some((t) => t.name === LEAD_VOCAL_NAME) ? LEAD_VOCAL_NAME : undefined });
        return await videoApi.start(songId, { orientation, quality, artist: artist.trim(), levels, avatarIds, storyboard: board });
      } finally {
        setMeasuring(undefined);
      }
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: videoQueryKeys.jobs(songId) }),
  });
  const job = jobFor(jobs.data, format);
  const busy = job?.state === 'queued' || job?.state === 'running';

  return (
    <div className="h-full overflow-y-auto bg-[#1b1c1f] text-white">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-6 px-6 py-8 lg:flex-row">
        <section className="w-full shrink-0 lg:w-[340px]" aria-label="Video settings">
          <h1 className="text-[22px] font-semibold">Music video</h1>
          <p className="mt-1 text-[14px] text-white/60">
            A video of {viewSong?.title ? <span className="text-white">{viewSong.title}</span> : 'this song'}: your avatars perform it in 3D
            scenes, dancing to the beat; the one whose voice sang the song sings the words.
          </p>

          <fieldset className="mt-6">
              <legend className="mb-2 text-[13px] text-white/60">Who dances (up to {MAX_AVATARS})</legend>
              {avatars.isPending ? <p className="text-[13px] text-white/55">Loading your avatars…</p> : null}
              {avatars.isError ? (
                <p className="text-[13px] text-err" role="alert">
                  {avatars.error.message}
                </p>
              ) : null}
              {avatars.data && avatars.data.avatars.length === 0 ? (
                <p className="text-[13px] text-white/70">
                  You have no avatars yet: make some on the{' '}
                  <a href="/avatars" className="underline">
                    Avatars page
                  </a>
                  .
                </p>
              ) : null}
              {styles.length > 1 ? (
                <div className="mb-2 flex gap-2" role="group" aria-label="Avatar style">
                  {styles.map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={s === style}
                      onClick={() => pickStyle(s)}
                      className={`rounded-full border px-3 py-1 text-[13px] ${s === style ? 'border-white bg-white/10' : 'border-line text-white/70 hover:border-white/40'}`}
                    >
                      {s === 'anime' ? 'Anime' : 'Realistic'}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {styleAvatars.map((a) => {
                  const on = avatarIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => togglePick(a.id)}
                      className={`flex w-[96px] flex-col items-center gap-1 rounded-[10px] border p-2 ${on ? 'border-white bg-white/10' : 'border-line opacity-60 hover:border-white/40'}`}
                    >
                      <img src={a.portraitUrl} alt="" className="h-16 w-16 rounded-full bg-black/30 object-cover" />
                      <span className="w-full truncate text-center text-[12px]">{a.name}</span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[12px] text-white/45">The avatar whose voice sang the song sings it; the others dance.</p>
            </fieldset>

          <fieldset className="mt-5">
            <legend className="mb-2 text-[13px] text-white/60">Format</legend>
            <div className="flex gap-2">
              {ORIENTATIONS.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  aria-pressed={orientation === o.id}
                  onClick={() => setOrientation(o.id)}
                  className={`flex-1 rounded-[10px] border px-3 py-2 text-left ${orientation === o.id ? 'border-white bg-white/10' : 'border-line hover:border-white/40'}`}
                >
                  <span className="block text-[14px] font-semibold">{o.label}</span>
                  <span className="block text-[12px] text-white/55">{o.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="mt-5">
            <legend className="mb-2 text-[13px] text-white/60">Quality</legend>
            <div className="flex gap-2">
              {(
                [
                  ['full', 'Full', 'Full size'],
                  ['preview', 'Quick preview', 'Half size; quicker, to check the shots'],
                ] as const
              ).map(([id, label, hint]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={quality === id}
                  onClick={() => setQuality(id)}
                  className={`flex-1 rounded-[10px] border px-3 py-2 text-left ${quality === id ? 'border-white bg-white/10' : 'border-line hover:border-white/40'}`}
                >
                  <span className="block text-[14px] font-semibold">{label}</span>
                  <span className="block text-[12px] text-white/55">{hint}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <label className="mt-5 block">
            <span className="mb-2 block text-[13px] text-white/60">Artist name (shown in the scenes)</span>
            <input
              value={artist}
              maxLength={60}
              onChange={(e) => setArtist(e.target.value)}
              className="h-10 w-full rounded-[8px] border border-line bg-[#151619] px-3 text-[14px] text-white outline-none focus:border-white/50"
            />
          </label>

          {editorDirty ? (
            <p className="mt-4 rounded-[8px] bg-amber-400/10 px-3 py-2 text-[13px] text-amber-200">
              Save the song first: this video shows the saved version, measured track by track.
            </p>
          ) : null}

          <button
            type="button"
            disabled={busy || start.isPending || !artist.trim() || editorDirty || avatarIds.length === 0}
            onClick={() => start.mutate()}
            className="mt-5 h-11 w-full rounded-full bg-accent text-[15px] font-semibold text-white hover:bg-[#e00000] disabled:opacity-50"
          >
            {measuring !== undefined
              ? `Measuring the tracks (${Math.round(measuring * 100)}%)…`
              : busy
                ? 'Making the video…'
                : job?.state === 'done'
                  ? 'Make it again'
                  : quality === 'preview'
                    ? 'Make a quick preview'
                    : 'Make video'}
          </button>
          {start.error ? (
            <p className="mt-3 text-[13px] text-err" role="alert">
              {start.error.message}
            </p>
          ) : null}
          <p className="mt-3 text-[12px] text-white/45">
            The tracks are measured here first (a moment), then the scenes are drawn on the server’s graphics card: about 1½× the
            song’s length.{' '}
            If the song has not been exported yet, its mix is made first.
          </p>
        </section>

        <section className="min-w-0 flex-1" aria-label="Video">
          {jobs.isError ? (
            <p className="text-[14px] text-err">{jobs.error.message}</p>
          ) : (
            <VideoPanel job={job} orientation={orientation} preview={quality === 'preview'} title={viewSong?.title ?? 'Music video'} />
          )}
          {chosenAvatars.length > 0 && sections.length > 0 ? (
            <AvatarStoryboardEditor sections={sections} board={board} avatars={chosenAvatars} onChange={setEdited} />
          ) : null}
        </section>
      </div>
    </div>
  );
}

function VideoPanel({
  job,
  orientation,
  preview,
  title,
}: {
  job: VideoStatus | undefined;
  orientation: VideoOrientation;
  preview: boolean;
  title: string;
}) {
  const frame = orientation === 'portrait' ? 'aspect-[9/16] max-h-[70vh] mx-auto' : 'aspect-video w-full';
  if (!job) {
    return (
      <div className={`${frame} flex items-center justify-center rounded-[12px] border border-dashed border-line text-[14px] text-white/45`}>
        No {orientation === 'portrait' ? 'tall' : 'wide'} {preview ? 'preview' : 'video'} yet. Make one on the left.
      </div>
    );
  }
  if (job.state === 'failed') {
    return (
      <div className={`${frame} flex flex-col items-center justify-center gap-2 rounded-[12px] border border-err/50 p-6 text-center`}>
        <p className="text-[15px] font-semibold text-err">The video could not be made</p>
        <p className="max-w-[520px] text-[13px] text-white/70">{job.error ?? 'No reason was given.'}</p>
      </div>
    );
  }
  if (job.state !== 'done' || !job.url) return <VideoProgress job={job} frame={frame} />;
  return (
    <div className="flex flex-col gap-3">
      <video key={job.url + (job.finishedAt ?? '')} src={job.url} controls className={`${frame} rounded-[12px] bg-black`} aria-label={`${title}: music video`} />
      <div className="flex items-center gap-3">
        <a href={`${job.url}?download=1`} className="h-10 rounded-full border border-white/30 px-4 text-[14px] leading-10 text-white hover:border-white/60">
          Download MP4{preview ? ' (preview)' : ''}
        </a>
        {job.finishedAt ? <span className="text-[12px] text-white/45">Made {new Date(job.finishedAt).toLocaleString('en-GB')}</span> : null}
      </div>
    </div>
  );
}

const STEPS: readonly { id: 'audio' | 'rendering'; label: string }[] = [
  { id: 'audio', label: 'Export the song’s mix' },
  { id: 'rendering', label: 'Render the video' },
];

/** The steps with the current one's detail, progress and a running timer, so the page never looks stuck. */
function VideoProgress({ job, frame }: { job: VideoStatus; frame: string }) {
  const now = useNow(1000);
  const steps = STEPS;
  const current = steps.findIndex((s) => s.id === job.step);
  const pct = typeof job.progress === 'number' ? Math.round(job.progress * 100) : undefined;
  const elapsed = (iso: string | undefined) => {
    if (!iso) return '';
    const sec = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  };
  return (
    <div className={`${frame} flex flex-col justify-center gap-5 rounded-[12px] border border-line bg-black/30 p-6`} role="status" aria-live="polite">
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => {
          const state = job.state === 'queued' ? 'todo' : i < current ? 'done' : i === current ? 'now' : 'todo';
          return (
            <li key={s.id} className="flex items-start gap-3">
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] ${
                  state === 'done' ? 'bg-emerald-400 text-black' : state === 'now' ? 'border-2 border-emerald-400 text-emerald-300' : 'border border-white/25 text-white/40'
                }`}
                aria-hidden="true"
              >
                {state === 'done' ? '✓' : state === 'now' ? <span className="h-2 w-2 animate-ping rounded-full bg-emerald-400" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className={`flex items-baseline gap-2 text-[15px] ${state === 'todo' ? 'text-white/45' : 'text-white'}`}>
                  {s.label}
                  {state === 'now' ? <span className="font-mono text-[12px] text-white/50">{elapsed(job.stepStartedAt)}</span> : null}
                </div>
                {state === 'now' ? (
                  <>
                    <p className="mt-0.5 text-[13px] text-white/60">{job.detail ?? 'working'}…</p>
                    {pct !== undefined ? (
                      <div className="mt-2 flex items-center gap-3">
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                          <div className="h-full bg-emerald-400 transition-all duration-700" style={{ width: `${Math.max(2, pct)}%` }} />
                        </div>
                        <span className="w-10 text-right font-mono text-[12px] text-white/55">{pct}%</span>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-[12px] text-white/40">
        {job.state === 'queued' ? 'Waiting to start.' : `Started ${elapsed(job.startedAt)} ago. Rendering draws every frame of the song, so it takes longest.`}
      </p>
    </div>
  );
}

/** The current time, updated every `ms` (for running timers). */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}


/** The saved song's sections with their times, as the storyboard lists them. */
function storyboardSections(song: { bpm: number; songStructure: readonly { name: string; lengthInBars?: number; bars: readonly unknown[] }[] } | undefined): { label: string; seconds: string }[] {
  if (!song) return [];
  const secPerBar = (BEATS_PER_BAR * 60) / song.bpm;
  const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
  let bar = 0;
  return song.songStructure.map((seg) => {
    const bars = seg.lengthInBars ?? seg.bars.length;
    const out = { label: sectionLabel(seg.name), seconds: `${clock(bar * secPerBar)}–${clock((bar + bars) * secPerBar)}` };
    bar += bars;
    return out;
  });
}
