import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@teamsuzie/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { TASK_LABELS, tasksApi, tasksQueryKey, type BackgroundTask } from '../api/tasks';
import { duration, TaskSteps } from './TaskSteps';
import { tryApplyAgain, useApplying, useElapsed, useTasks } from '../state/tasks';

/** What a running task is doing, in a word. */
const RUNNING_WORDS: Readonly<Record<BackgroundTask['kind'], string>> = { writeLyrics: 'writing', sing: 'singing', transcribe: 'transcribing' };

/**
 * The Tasks item of the top bar: the user's background tasks across their songs (running, ready to go in when playback
 * stops, done, failed with why and a Retry), with the count of those not finished. Clicking a task opens its song.
 * Hidden while the user has no tasks.
 */
export function TasksMenu() {
  const { data: tasks } = useTasks();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  if (!tasks || tasks.length === 0) return null;
  const pending = tasks.filter((t) => t.state === 'running' || t.state === 'ready').length;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[14px] text-white/70 outline-none ring-white/60 hover:text-white focus-visible:ring-2"
        aria-label={`Tasks: ${pending} not finished`}
      >
        <span aria-hidden className={pending > 0 ? 'animate-pulse' : ''}>
          ⧗
        </span>
        Tasks{pending > 0 ? ` (${pending})` : ''}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="z-50 max-h-[80vh] w-[420px] overflow-y-auto rounded-[10px] border border-line bg-panel p-1 text-white shadow-2xl">
        <DropdownMenuLabel className="px-3 py-2 text-[13px] font-normal text-white/60">Background tasks</DropdownMenuLabel>
        <DropdownMenuSeparator className="my-1 h-px bg-line" />
        {tasks.map((t) => (
          <TaskItem key={t.id} task={t} ticking={open} onOpen={() => navigate(`/editor/${t.songId}/timeline`)} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskItem({ task, ticking, onOpen }: { task: BackgroundTask; ticking: boolean; onOpen(): void }) {
  const queryClient = useQueryClient();
  const { failed } = useApplying();
  const elapsed = useElapsed(task.startedAt, ticking && task.state === 'running');
  const [retryError, setRetryError] = useState<string | undefined>(undefined);
  const notApplied = failed[task.id];
  const cancel = async () => {
    setRetryError(undefined);
    try {
      await tasksApi.cancel(task.id);
      await queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    } catch (err) {
      setRetryError(`Could not cancel it: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const retry = async () => {
    setRetryError(undefined);
    try {
      await tasksApi.retry(task.id);
      await queryClient.invalidateQueries({ queryKey: tasksQueryKey });
    } catch (err) {
      setRetryError(`Could not start it again: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const status =
    task.state === 'running'
      ? `● ${RUNNING_WORDS[task.kind]} · ${duration(elapsed)}`
      : task.state === 'ready'
        ? notApplied
          ? `✕ ${notApplied}`
          : '✓ ready · goes in when playback stops'
        : task.state === 'done'
          ? '✓ done'
          : `✕ failed: ${task.message ?? 'no reason given'}`;
  return (
    <DropdownMenuItem
      className="flex cursor-pointer flex-col items-stretch gap-0.5 rounded-[6px] px-3 py-2 outline-none data-[highlighted]:bg-white/10"
      onSelect={onOpen}
    >
      <span className="truncate text-[14px]">
        {task.title} · {TASK_LABELS[task.kind]}
      </span>
      <span className={`flex items-start gap-2 text-[12px] ${task.state === 'failed' || notApplied ? 'text-err' : 'text-white/55'}`}>
        <span className="line-clamp-3 min-w-0 flex-1 whitespace-pre-line">{retryError ?? status}</span>
        {task.state === 'failed' || notApplied ? (
          <button
            type="button"
            className="shrink-0 rounded-full border border-white/30 px-2 py-0.5 text-[12px] text-white hover:border-white/60"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (notApplied) tryApplyAgain(task.id);
              else void retry();
            }}
          >
            {notApplied ? 'Try again' : 'Retry'}
          </button>
        ) : null}
      </span>
      <TaskSteps
        task={task}
        now={Date.now()}
        onCancel={() => void cancel()}
      />
    </DropdownMenuItem>
  );
}
