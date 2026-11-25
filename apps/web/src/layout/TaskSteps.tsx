import { useRef, useState } from 'react';

import { tasksApi, type BackgroundTask, type TaskStep } from '../api/tasks';

/** "1 min 10 s", "45 s". */
export function duration(sec: number): string {
  const m = Math.floor(sec / 60);
  return m > 0 ? `${m} min ${sec % 60} s` : `${sec} s`;
}

const MARK: Record<TaskStep['state'], string> = { waiting: '○', running: '●', done: '✓', failed: '✕' };
const AUDIO = /\.(wav|ogg|mp3|flac)$/iu;

function stepSeconds(step: TaskStep, now: number): number | undefined {
  if (!step.startedAt) return undefined;
  const end = step.finishedAt ? Date.parse(step.finishedAt) : step.state === 'running' ? now : undefined;
  return end === undefined ? undefined : Math.max(0, Math.round((end - Date.parse(step.startedAt)) / 1000));
}

/** One audio element for the whole list: playing a file stops the one before. */
let current: HTMLAudioElement | undefined;

function FileButton({ taskId, entry }: { taskId: string; entry: string }) {
  const name = entry.slice(entry.indexOf('/') + 1);
  const url = tasksApi.fileUrl(taskId, entry);
  const [error, setError] = useState<string | undefined>(undefined);
  const audio = useRef<HTMLAudioElement | undefined>(undefined);
  if (!AUDIO.test(name)) {
    return (
      <a className="rounded-full border border-white/20 px-2 py-0.5 text-[11px] text-white/70 hover:text-white" href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
        {name}
      </a>
    );
  }
  const play = (e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault();
    e.stopPropagation();
    setError(undefined);
    if (current && current !== audio.current) current.pause();
    audio.current ??= new Audio(url);
    current = audio.current;
    if (!audio.current.paused) {
      audio.current.pause();
      return;
    }
    audio.current.play().catch((err: unknown) => setError(`Could not play ${name}: ${err instanceof Error ? err.message : String(err)}`));
  };
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" aria-label={`Play ${name}`} className="rounded-full border border-white/20 px-2 py-0.5 text-[11px] text-white/80 hover:border-white/50 hover:text-white" onClick={play}>
        ▶ {name}
      </button>
      {error ? <span className="text-[11px] text-err">{error}</span> : null}
    </span>
  );
}

/** A task's steps, in order: label, state, running time, what it found, a play button per audio file; Cancel while running. */
export function TaskSteps({ task, now, onCancel }: { task: BackgroundTask; now: number; onCancel?: () => void }) {
  const steps = task.steps ?? [];
  if (steps.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      <ol className="flex flex-col gap-1">
        {steps.map((s) => {
          const sec = stepSeconds(s, now);
          return (
            <li key={s.id} data-state={s.state} className={`flex flex-col gap-0.5 text-[12px] ${s.state === 'failed' ? 'text-err' : s.state === 'waiting' ? 'text-white/35' : 'text-white/75'}`}>
              <span className="flex items-baseline gap-1.5">
                <span aria-hidden>{MARK[s.state]}</span>
                <span className="min-w-0 flex-1">{s.label}</span>
                {sec !== undefined ? <span className="shrink-0 text-white/45">{duration(sec)}</span> : null}
              </span>
              {s.text ? <span className="whitespace-pre-line pl-4 text-white/55">{s.text}</span> : null}
              {s.files && s.files.length > 0 ? (
                <span className="flex flex-wrap gap-1 pl-4">
                  {s.files.map((f) => (
                    <FileButton key={f} taskId={task.id} entry={f} />
                  ))}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
      {task.state === 'running' && onCancel ? (
        <button type="button" className="self-start rounded-full border border-white/30 px-2 py-0.5 text-[12px] text-white hover:border-white/60" onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }}
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}
