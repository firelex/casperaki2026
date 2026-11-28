import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Checkbox } from '@teamsuzie/ui';

import {
  addSingerProblem,
  MAX_RECORDING_MINUTES,
  REFERENCE_HINTS,
  REFERENCE_LABELS,
  referenceText,
  singersApi,
  singersQueryKey,
  speakingDescriptionProblem,
  type AddSingerForm,
  type ReferenceChoice,
  type SingerInfo,
} from '../api/singers';
import { tasksApi, tasksQueryKey, type BackgroundTask } from '../api/tasks';
import { AppHeader } from '../layout/AppHeader';
import { duration, TaskSteps } from '../layout/TaskSteps';
import { useElapsed, useTasks } from '../state/tasks';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The singers: the voices Sing sings in, each with what it sounds like, where the voice came from, and its voice
 * reference to listen to; the user's own singers (added from a recording: only they see them) also with how their
 * voice reference was chosen and a test line sung in the new voice, and a Delete button. "Add a singer" makes a new
 * one from a recording in the background (its steps show here while it runs).
 */
export function SingersPage() {
  const singers = useQuery({ queryKey: singersQueryKey, queryFn: ({ signal }) => singersApi.list(signal), staleTime: 60_000 });
  const { data: tasks } = useTasks();
  const queryClient = useQueryClient();
  const adding = (tasks ?? []).filter((t) => t.kind === 'addSinger' && (t.state === 'running' || t.state === 'failed'));
  // A singer made since the list was loaded: load it again.
  const listed = new Set((singers.data?.singers ?? []).map((s) => s.id));
  const made = (tasks ?? []).some((t) => t.kind === 'addSinger' && t.state === 'done' && t.singerId !== undefined && !listed.has(t.singerId));
  useEffect(() => {
    if (made && singers.data) void queryClient.invalidateQueries({ queryKey: singersQueryKey });
  }, [made, singers.data, queryClient]);
  // A speaking voice made since: load the singers again.
  const spoken = (tasks ?? []).filter((t) => t.kind === 'speakingVoice' && t.state === 'done').map((t) => t.id).join();
  useEffect(() => {
    if (spoken) void queryClient.invalidateQueries({ queryKey: singersQueryKey });
  }, [spoken, queryClient]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-white">
      <AppHeader />
      <main className="min-h-0 flex-1 overflow-y-auto bg-[#1b1c1f] px-6 py-8">
        <div className="mx-auto flex max-w-[760px] flex-col gap-6">
          <div>
            <h1 className="text-[22px] font-semibold">Singers</h1>
            <p className="mt-1 text-[14px] text-white/55">The voices Sing sings in. The singers you add are yours alone.</p>
          </div>
          {singers.isPending ? <p className="text-[14px] text-white/55">Loading the singers…</p> : null}
          {singers.isError ? (
            <p className="text-[14px] text-err" role="alert">
              The singers could not be loaded: {message(singers.error)}
            </p>
          ) : null}
          {singers.data?.singers.map((s) => (
            <SingerCard key={s.id} singer={s} />
          ))}
          {adding.map((t) => (
            <AddingCard key={t.id} task={t} />
          ))}
          <AddSingerPanel />
        </div>
      </main>
    </div>
  );
}

/** One singer: its name, description, voice reference, Delete (a built-in singer for this user only), and for the
 *  user's own: how it was chosen and the test line. */
export function SingerCard({ singer: s }: { singer: SingerInfo }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const remove = async () => {
    setError(undefined);
    try {
      await singersApi.remove(s.id);
      await queryClient.invalidateQueries({ queryKey: singersQueryKey });
    } catch (err) {
      setError(`Could not delete ${s.name}: ${message(err)}`);
      setConfirming(false);
    }
  };
  return (
    <section className="flex flex-col gap-3 rounded-[12px] border border-line bg-panel p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold">
            {s.name}
            {s.own ? <span className="ml-2 rounded-full border border-white/20 px-2 py-0.5 align-middle text-[11px] font-normal text-white/60">yours</span> : null}
          </h2>
          <p className="mt-1 text-[14px] text-white/75">{s.description}</p>
        </div>
        {confirming ? (
            <span className="flex shrink-0 items-center gap-2 text-[13px]">
              {s.own ? `Delete ${s.name}?` : `Delete ${s.name} from your singers?`}
              <button type="button" className="rounded-full border border-err/60 px-3 py-1 text-err hover:border-err" onClick={() => void remove()}>
                Delete
              </button>
              <button type="button" className="rounded-full border border-white/30 px-3 py-1 text-white/80 hover:border-white/60" onClick={() => setConfirming(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button type="button" className="shrink-0 rounded-full border border-white/30 px-3 py-1 text-[13px] text-white/80 hover:border-white/60" onClick={() => setConfirming(true)}>
              Delete
            </button>
          )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[12px] text-white/55">
          Voice reference{s.reference ? ` · ${referenceText(s.reference)}` : ''}
          {s.transcription ? ` · ${s.transcription === 'la' ? 'sung as "la la la"' : 'sung with words'}` : ''}
        </span>
        <audio controls preload="none" src={s.previewUrl} className="w-full" aria-label={`${s.name}: voice reference`} />
      </div>
      {s.testLineUrl ? (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] text-white/55">Test line, sung in this voice</span>
          <audio controls preload="none" src={s.testLineUrl} className="w-full" aria-label={`${s.name}: test line`} />
        </div>
      ) : null}
      <SpeakingVoiceSection singer={s} />
      <p className="text-[12px] text-white/45">{s.source}</p>
      {error ? (
        <p className="text-[13px] text-err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** Whether a speaking voice is being made for the singer (a speakingVoice task, or Add a singer, whose last steps make
 *  the new singer's voice), and its last failed speakingVoice task. */
export function speakingTaskState(tasks: readonly BackgroundTask[], singerId: string): { making: boolean; failed: BackgroundTask | undefined } {
  const mine = tasks.filter((t) => (t.kind === 'speakingVoice' || t.kind === 'addSinger') && t.singerId === singerId);
  return { making: mine.some((t) => t.state === 'running'), failed: mine.find((t) => t.kind === 'speakingVoice' && t.state === 'failed') };
}

/** The voice the singer speaks in (casting videos): listen to it, try another of its candidate voices, describe it
 *  yourself, or make it (again) from the singing. */
export function SpeakingVoiceSection({ singer: s }: { singer: SingerInfo }) {
  const queryClient = useQueryClient();
  const { data: tasks } = useTasks();
  const [panel, setPanel] = useState<'none' | 'others' | 'describe'>('none');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const { making, failed } = speakingTaskState(tasks ?? [], s.id);
  const v = s.speaking;

  const make = async (own?: string) => {
    setError(undefined);
    try {
      await singersApi.makeSpeakingVoice(s.id, own);
      await queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      setPanel('none');
      setDescription('');
    } catch (err) {
      setError(`Could not make the speaking voice: ${message(err)}`);
    }
  };
  const choose = async (seed: number) => {
    setError(undefined);
    try {
      await singersApi.chooseSpeakingVoice(s.id, seed);
      await queryClient.invalidateQueries({ queryKey: singersQueryKey });
    } catch (err) {
      setError(`Could not change the speaking voice: ${message(err)}`);
    }
  };
  const button = 'rounded-full border border-white/30 px-3 py-1 text-[13px] text-white/80 hover:border-white/60 disabled:opacity-40';
  const problem = speakingDescriptionProblem(description);

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-white/10 p-3">
      <span className="text-[12px] text-white/55">
        Speaking voice
        {v ? ` · ${v.madeBy === 'matched' ? 'matched to the singing' : 'from your description'}: ${v.description}` : ''}
      </span>
      {v ? <audio controls preload="none" src={v.sampleUrl} className="w-full" aria-label={`${s.name}: speaking voice`} /> : null}
      {making ? <p className="text-[13px] text-white/70">Making the speaking voice…</p> : null}
      {!making && failed && !v ? (
        <p className="text-[13px] text-err" role="alert">
          The speaking voice could not be made: {failed.message ?? 'no reason given'}
        </p>
      ) : null}
      {!making ? (
        <div className="flex flex-wrap gap-2">
          {v ? (
            v.candidates.length > 1 ? (
              <button type="button" className={button} onClick={() => setPanel(panel === 'others' ? 'none' : 'others')}>
                Try another voice
              </button>
            ) : null
          ) : (
            <button type="button" className={button} onClick={() => void make()}>
              Make a speaking voice
            </button>
          )}
          <button type="button" className={button} onClick={() => setPanel(panel === 'describe' ? 'none' : 'describe')}>
            Describe it yourself
          </button>
          {v ? (
            <button type="button" className={button} onClick={() => void make()}>
              Make it again from the singing
            </button>
          ) : null}
        </div>
      ) : null}
      {panel === 'others' && v ? (
        <ul className="flex flex-col gap-2">
          {v.candidates.map((c) => (
            <li key={c.seed} className="flex items-center gap-2">
              <audio controls preload="none" src={c.url} className="min-w-0 flex-1" aria-label={`${s.name}: voice ${c.seed}`} />
              <span className="w-[64px] text-[12px] text-white/55">{c.score === null ? '' : `${Math.round(c.score * 100)}% alike`}</span>
              <button type="button" className={button} disabled={c.seed === v.seed} onClick={() => void choose(c.seed)}>
                {c.seed === v.seed ? 'In use' : 'Use this one'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {panel === 'describe' ? (
        <div className="flex flex-col gap-2">
          <textarea
            className="min-h-[64px] rounded-[8px] border border-white/20 bg-transparent p-2 text-[14px]"
            placeholder="For example: a woman in her thirties, warm and slightly husky, relaxed"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-label={`${s.name}: describe the speaking voice`}
          />
          <div>
            <button type="button" className={button} disabled={problem !== undefined} title={problem} onClick={() => void make(description)}>
              Save
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="text-[13px] text-err" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A singer being made (or whose making failed): its steps, Cancel while it runs, Retry when it failed. */
export function AddingCard({ task }: { task: BackgroundTask }) {
  const queryClient = useQueryClient();
  const elapsed = useElapsed(task.startedAt, task.state === 'running');
  const [error, setError] = useState<string | undefined>(undefined);
  const act = async (what: 'cancel' | 'retry') => {
    setError(undefined);
    try {
      await (what === 'cancel' ? tasksApi.cancel(task.id) : tasksApi.retry(task.id));
      await queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    } catch (err) {
      setError(`Could not ${what === 'cancel' ? 'cancel it' : 'start it again'}: ${message(err)}`);
    }
  };
  return (
    <section className="flex flex-col gap-2 rounded-[12px] border border-dashed border-line bg-panel p-5">
      <h2 className="text-[17px] font-semibold">{task.title}</h2>
      <p className={`text-[13px] ${task.state === 'failed' ? 'text-err' : 'text-white/60'}`}>
        {task.state === 'running' ? `● Making the singer · ${duration(elapsed)}` : `✕ Could not make the singer: ${task.message ?? 'no reason given'}`}
        {task.state === 'failed' ? (
          <button type="button" className="ml-3 rounded-full border border-white/30 px-2 py-0.5 text-[12px] text-white hover:border-white/60" onClick={() => void act('retry')}>
            Retry
          </button>
        ) : null}
      </p>
      <TaskSteps task={task} now={Date.now()} onCancel={() => void act('cancel')} />
      {error ? (
        <p className="text-[13px] text-err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

const EMPTY: AddSingerForm = { file: undefined, name: '', description: '', rightToUse: false, fullSong: false, reference: 'best' };

/** The Add a singer form: a recording, a name and description, how the voice reference is chosen ("The best stretch"
 *  preselected), whether it is a full song, and the required consent box. */
export function AddSingerPanel({ initial = EMPTY }: { initial?: AddSingerForm }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AddSingerForm>(initial);
  const [fileKey, setFileKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const problem = addSingerProblem(form);
  const set = (patch: Partial<AddSingerForm>) => setForm((f) => ({ ...f, ...patch }));
  const submit = async () => {
    setError(undefined);
    setSending(true);
    try {
      await singersApi.add(form);
      setForm(EMPTY);
      setFileKey((k) => k + 1);
      await queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    } catch (err) {
      setError(message(err));
    } finally {
      setSending(false);
    }
  };
  const field = 'rounded-[8px] border border-line bg-[#141518] px-3 py-2 text-[14px] text-white outline-none focus:border-white/40';
  return (
    <section className="flex flex-col gap-4 rounded-[12px] border border-line bg-panel p-5" aria-label="Add a singer">
      <div>
        <h2 className="text-[17px] font-semibold">Add a singer</h2>
        <p className="mt-1 text-[13px] text-white/55">
          From a recording of up to {MAX_RECORDING_MINUTES} minutes, sung in English or as "la la la". The voice is cleaned up, its
          silences cut, and about 10 seconds of it become the new singer's voice reference; a test line is sung in it so you can hear
          the result.
        </p>
      </div>
      <label className="flex flex-col gap-1 text-[13px] text-white/75">
        Recording
        <input key={fileKey} type="file" accept="audio/*,video/*" className="text-[13px] text-white/80" onChange={(e) => set({ file: e.target.files?.[0] })} />
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-white/75">
        Name
        <input type="text" maxLength={60} value={form.name} className={field} onChange={(e) => set({ name: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-white/75">
        Description
        <textarea maxLength={300} rows={2} value={form.description} className={field} placeholder="What the voice sounds like" onChange={(e) => set({ description: e.target.value })} />
      </label>
      <fieldset className="flex flex-col gap-2 text-[13px] text-white/75">
        <legend className="mb-1">Voice reference</legend>
        {(['best', 'beginning'] as const).map((c: ReferenceChoice) => (
          <label key={c} className="flex items-start gap-2">
            <input type="radio" name="reference" className="mt-0.5" checked={form.reference === c} onChange={() => set({ reference: c })} />
            <span>
              {REFERENCE_LABELS[c]} <span className="text-white/50">— {REFERENCE_HINTS[c]}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="flex items-center gap-2 text-[13px] text-white/75">
        <Checkbox checked={form.fullSong} onChange={(e) => set({ fullSong: e.target.checked })} />
        This is a full song: separate the vocals first
      </label>
      <label className="flex items-center gap-2 text-[13px] text-white/75">
        <Checkbox checked={form.rightToUse} onChange={(e) => set({ rightToUse: e.target.checked })} required />I have the right to use this voice
      </label>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={problem !== undefined || sending}
          className="rounded-full bg-white px-4 py-1.5 text-[14px] font-medium text-black disabled:opacity-40"
          onClick={() => void submit()}
        >
          {sending ? 'Sending…' : 'Add the singer'}
        </button>
        {problem && !sending ? <span className="text-[12px] text-white/50">{problem}</span> : null}
      </div>
      {error ? (
        <p className="text-[13px] text-err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
