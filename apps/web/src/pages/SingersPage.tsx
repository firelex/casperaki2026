import { useEffect, useRef, useState } from 'react';
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
  type SingerVoice,
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
  // A singer task finished since the list was loaded (a new singer, its speaking voice): load the list again. Add a
  // singer lists the singer before it makes its speaking voice, so a singer already listed may have changed too.
  const finished = singerTasksFinished(tasks ?? []);
  const seen = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (seen.current !== undefined && seen.current !== finished) void queryClient.invalidateQueries({ queryKey: singersQueryKey });
    seen.current = finished;
  }, [finished, queryClient]);

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
          {singers.data ? <SingerList singers={singers.data.singers} /> : null}
          {adding.map((t) => (
            <AddingCard key={t.id} task={t} />
          ))}
          <AddSingerPanel />
        </div>
      </main>
    </div>
  );
}

export type SingerShow = 'all' | 'yours' | 'builtIn';

/** The singers to list: by name, those whose name or description holds the search (any case), yours or the built-in
 *  ones only when asked. */
export function shownSingers(singers: readonly SingerInfo[], search: string, show: SingerShow): SingerInfo[] {
  const q = search.trim().toLowerCase();
  return singers
    .filter((s) => (show === 'all' ? true : show === 'yours' ? s.own : !s.own))
    .filter((s) => q === '' || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** The singer list with a search box, All / Yours / Built-in and a jump to Add a singer (owner 2026-11-28: "a bit more
 *  navigable if there are more singers"). */
function SingerList({ singers }: { singers: readonly SingerInfo[] }) {
  const [search, setSearch] = useState('');
  const [show, setShow] = useState<SingerShow>('all');
  const shown = shownSingers(singers, search, show);
  const chip = (v: SingerShow, label: string) => (
    <button
      type="button"
      aria-pressed={show === v}
      className={`rounded-full border px-3 py-1 text-[13px] ${show === v ? 'border-white bg-white text-black' : 'border-white/30 text-white/80 hover:border-white/60'}`}
      onClick={() => setShow(v)}
    >
      {label}
    </button>
  );
  return (
    <>
      <div className="sticky top-[-32px] z-10 -mx-2 flex flex-wrap items-center gap-2 rounded-[12px] bg-[#1b1c1f]/95 px-2 py-3 backdrop-blur">
        <input
          type="search"
          value={search}
          placeholder="Find a singer"
          aria-label="Find a singer by name or description"
          className="min-w-[200px] flex-1 rounded-full border border-line bg-[#141518] px-4 py-1.5 text-[14px] text-white outline-none focus:border-white/40"
          onChange={(e) => setSearch(e.target.value)}
        />
        {chip('all', 'All')}
        {chip('yours', 'Yours')}
        {chip('builtIn', 'Built-in')}
        <span className="text-[12px] text-white/50">
          {shown.length} of {singers.length}
        </span>
        <button
          type="button"
          className="rounded-full bg-white px-3 py-1 text-[13px] font-medium text-black"
          onClick={() => document.getElementById('add-a-singer')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          Add a singer
        </button>
      </div>
      {shown.length === 0 ? <p className="text-[14px] text-white/55">No singer matches.</p> : null}
      {shown.map((s) => (
        <SingerCard key={s.id} singer={s} />
      ))}
    </>
  );
}

/** The recording the singer's voice is copied from, and how it was chosen. */
function VoiceReference({ singer: s }: { singer: SingerInfo }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-white/55">
        Voice reference{s.reference ? ` · ${referenceText(s.reference)}` : ''}
        {s.transcription ? ` · ${s.transcription === 'la' ? 'sung as "la la la"' : 'sung with words'}` : ''}
      </span>
      <audio controls preload="none" src={s.previewUrl} className="w-full" aria-label={`${s.name}: voice reference`} />
    </div>
  );
}

/** One singer: its name, description, test line (a built-in singer, which has none: its voice reference), Rename and
 *  Delete (a built-in singer for this user only); under Details its voice reference, speaking voice and source. */
export function SingerCard({ singer: s, open: initiallyOpen = false }: { singer: SingerInfo; open?: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [open, setOpen] = useState(initiallyOpen);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(s.name);
  const [error, setError] = useState<string | undefined>(undefined);
  const nameProblem = newName.trim() === '' ? 'Give the singer a name' : newName.trim().length > 60 ? 'At most 60 characters' : undefined;
  // The description, edited on the card (owner 2026-11-28); the user's own singers only.
  const [describing, setDescribing] = useState(false);
  const [newDescription, setNewDescription] = useState(s.description);
  const descriptionProblem = newDescription.trim() === '' ? 'Describe the voice' : newDescription.trim().length > 300 ? 'At most 300 characters' : undefined;
  const describe = async () => {
    setError(undefined);
    try {
      await singersApi.describe(s.id, newDescription);
      await queryClient.invalidateQueries({ queryKey: singersQueryKey });
      setDescribing(false);
    } catch (err) {
      setError(`Could not change ${s.name}'s description: ${message(err)}`);
    }
  };
  const rename = async () => {
    setError(undefined);
    try {
      await singersApi.rename(s.id, newName.trim());
      await queryClient.invalidateQueries({ queryKey: singersQueryKey });
      setRenaming(false);
    } catch (err) {
      setError(`Could not rename ${s.name}: ${message(err)}`);
    }
  };
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
          {renaming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!nameProblem) void rename();
              }}
            >
              <input
                autoFocus
                type="text"
                maxLength={60}
                value={newName}
                aria-label={`New name for ${s.name}`}
                className="min-w-0 flex-1 rounded-[8px] border border-line bg-[#141518] px-3 py-1 text-[15px] text-white outline-none focus:border-white/40"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setRenaming(false);
                    setNewName(s.name);
                  }
                }}
              />
              <button type="submit" disabled={nameProblem !== undefined} title={nameProblem} className="rounded-full bg-white px-3 py-1 text-[13px] font-medium text-black disabled:opacity-40">
                Save
              </button>
              <button
                type="button"
                className="rounded-full border border-white/30 px-3 py-1 text-[13px] text-white/80 hover:border-white/60"
                onClick={() => {
                  setRenaming(false);
                  setNewName(s.name);
                }}
              >
                Cancel
              </button>
            </form>
          ) : (
            <h2 className="text-[17px] font-semibold">
              {s.name}
              {s.own ? <span className="ml-2 rounded-full border border-white/20 px-2 py-0.5 align-middle text-[11px] font-normal text-white/60">yours</span> : null}
            </h2>
          )}
          {describing ? (
            <form
              className="mt-2 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!descriptionProblem) void describe();
              }}
            >
              <textarea
                autoFocus
                rows={2}
                maxLength={300}
                value={newDescription}
                aria-label={`Description of ${s.name}`}
                className="rounded-[8px] border border-line bg-[#141518] px-3 py-2 text-[14px] text-white outline-none focus:border-white/40"
                onChange={(e) => setNewDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setDescribing(false);
                    setNewDescription(s.description);
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (!descriptionProblem) void describe();
                  }
                }}
              />
              <span className="flex gap-2">
                <button type="submit" disabled={descriptionProblem !== undefined} title={descriptionProblem} className="rounded-full bg-white px-3 py-1 text-[13px] font-medium text-black disabled:opacity-40">
                  Save
                </button>
                <button
                  type="button"
                  className="rounded-full border border-white/30 px-3 py-1 text-[13px] text-white/80 hover:border-white/60"
                  onClick={() => {
                    setDescribing(false);
                    setNewDescription(s.description);
                  }}
                >
                  Cancel
                </button>
              </span>
            </form>
          ) : (
            <p className="mt-1 text-[14px] text-white/75">
              {s.description}
              {s.own ? (
                <button
                  type="button"
                  className="ml-2 text-[12px] text-white/50 underline-offset-2 hover:text-white hover:underline"
                  onClick={() => {
                    setNewDescription(s.description);
                    setDescribing(true);
                  }}
                >
                  Edit description
                </button>
              ) : null}
            </p>
          )}
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
          ) : renaming ? null : (
            <span className="flex shrink-0 gap-2">
              <button
                type="button"
                className="rounded-full border border-white/30 px-3 py-1 text-[13px] text-white/80 hover:border-white/60"
                onClick={() => {
                  setNewName(s.name);
                  setRenaming(true);
                }}
              >
                Rename
              </button>
              <button type="button" className="rounded-full border border-white/30 px-3 py-1 text-[13px] text-white/80 hover:border-white/60" onClick={() => setConfirming(true)}>
                Delete
              </button>
            </span>
          )}
      </div>
      {/* The test line is what the singer sounds like singing (owner 2026-11-28: the main player); a built-in singer
          has none, so its card plays its voice reference. */}
      {s.testLineUrl ? (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] text-white/55">Test line, sung in this voice</span>
          <audio controls preload="none" src={s.testLineUrl} className="w-full" aria-label={`${s.name}: test line`} />
        </div>
      ) : (
        <VoiceReference singer={s} />
      )}
      <button type="button" aria-expanded={open} className="self-start text-[13px] text-white/60 hover:text-white" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Details
      </button>
      {open ? (
        <>
          {s.testLineUrl ? <VoiceReference singer={s} /> : null}
          <SpeakingVoiceSection singer={s} />
          <p className="text-[12px] text-white/45">{s.source}</p>
        </>
      ) : null}
      {error ? (
        <p className="text-[13px] text-err" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** The Add a singer and speaking voice tasks that have finished, as one key: it changes when another finishes. */
export function singerTasksFinished(tasks: readonly BackgroundTask[]): string {
  return tasks
    .filter((t) => (t.kind === 'addSinger' || t.kind === 'speakingVoice') && t.state === 'done')
    .map((t) => `${t.id}:${t.finishedAt ?? ''}`)
    .sort()
    .join(',');
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

const EMPTY: AddSingerForm = { file: undefined, voice: undefined, rightToUse: false, fullSong: false, reference: 'best' };

/** The Add a singer form: a recording, female or male (the brain names the singer after it, "Female singer 3"; owner
 *  2026-11-28), how the voice reference is chosen ("The best stretch" preselected), whether it is a full song, and the
 *  required consent box. The description is edited on the singer's card. */
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
    <section id="add-a-singer" className="flex scroll-mt-4 flex-col gap-4 rounded-[12px] border border-line bg-panel p-5" aria-label="Add a singer">
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
      <fieldset className="flex flex-col gap-2 text-[13px] text-white/75">
        <legend className="mb-1">Voice</legend>
        <div className="flex gap-4">
          {(['female', 'male'] as const).map((v: SingerVoice) => (
            <label key={v} className="flex items-center gap-2">
              <input type="radio" name="voice" checked={form.voice === v} onChange={() => set({ voice: v })} />
              <span>{v === 'female' ? 'Female' : 'Male'}</span>
            </label>
          ))}
        </div>
        <span className="text-white/50">The singer is named after it (Female singer 1, 2, 3 …); rename it and describe the voice on its card.</span>
      </fieldset>
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
