import { AVATAR_CAMERAS, AVATAR_SCENES } from '@casperaki/video/avatar';

import type { AvatarInfo } from '../api/avatars';
import { setEntry, toggleAvatar, useForAll, type StoryboardEntry } from './avatarStoryboard';

/**
 * The dance floor video's storyboard: one row per section of the song with where it happens (scene), who is in it
 * (the video's avatars) and how it is filmed (camera), and a shortcut to use a row's choices for every section.
 */
export function AvatarStoryboardEditor({
  sections,
  board,
  avatars,
  onChange,
}: {
  sections: readonly { label: string; seconds: string }[];
  board: readonly StoryboardEntry[];
  /** The avatars chosen for the video, in order. */
  avatars: readonly AvatarInfo[];
  onChange(board: StoryboardEntry[]): void;
}) {
  const select = 'h-8 rounded-[6px] border border-line bg-[#151619] px-2 text-[13px] text-white outline-none focus:border-white/50';
  return (
    <section className="mt-6" aria-label="Storyboard">
      <h2 className="text-[16px] font-semibold">Storyboard</h2>
      <p className="mt-1 text-[13px] text-white/55">Where each section happens, who is in it and how it is filmed.</p>
      <ol className="mt-3 flex flex-col gap-2">
        {sections.map((s, i) => {
          const e = board[i]!;
          return (
            <li key={i} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line px-3 py-2">
              <span className="w-[110px] shrink-0">
                <span className="block text-[13px] font-semibold">{s.label}</span>
                <span className="block text-[11px] text-white/45">{s.seconds}</span>
              </span>
              <label className="flex items-center gap-1 text-[12px] text-white/55">
                Scene
                <select className={select} value={e.scene} onChange={(ev) => onChange(setEntry(board, i, { scene: ev.target.value }))}>
                  {AVATAR_SCENES.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1 text-[12px] text-white/55">
                Camera
                <select className={select} value={e.camera} onChange={(ev) => onChange(setEntry(board, i, { camera: ev.target.value }))}>
                  {AVATAR_CAMERAS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="flex items-center gap-1" role="group" aria-label={`Who is in ${s.label}`}>
                {avatars.map((a) => {
                  const on = e.avatarIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      aria-pressed={on}
                      title={a.name}
                      onClick={() => onChange(toggleAvatar(board, i, a.id))}
                      className={`h-8 w-8 overflow-hidden rounded-full border ${on ? 'border-white' : 'border-line opacity-35 hover:opacity-70'}`}
                    >
                      <img src={a.portraitUrl} alt={a.name} className="h-full w-full object-cover" />
                    </button>
                  );
                })}
              </span>
              <button type="button" onClick={() => onChange(useForAll(board, i))} className="ml-auto text-[12px] text-white/55 underline hover:text-white">
                Use for every section
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
