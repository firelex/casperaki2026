import { renderInFlight, renderLabel, type RenderInfo } from '../api/songs';
import { useLiveTransport } from '../audio/useLiveTransport';
import { useSession } from '../state/session';
import { useRenderStatus } from '../state/useSongActions';

/**
 * The editor's status bar (bottom edge, as in a DAW): what the live player is
 * doing on the left, the export downloads on the right. The transport itself
 * is in the control bar (layout/Transport.tsx).
 */
export function StatusBar() {
  const { activeSong, editorDirty } = useSession();
  const { live, isThisSong } = useLiveTransport();
  const render = useRenderStatus(activeSong?.id).data;
  return (
    <LiveStatusStrip
      status={isThisSong ? live.status : 'idle'}
      step={live.step}
      error={isThisSong ? live.error : undefined}
      dirty={editorDirty}
      render={render}
    />
  );
}

interface LiveStatusStripProps {
  readonly status: string;
  readonly step: string;
  readonly error: string | undefined;
  readonly dirty: boolean;
  readonly render: RenderInfo | undefined;
}

/** Left: what the live player is doing. Right: the server render, which
 *  exists only for downloads. */
function LiveStatusStrip({ status, step, error, dirty, render }: LiveStatusStripProps) {
  const label =
    status === 'loading'
      ? step
      : status === 'error'
        ? `Playback failed: ${error ?? 'unknown error'}`
        : status === 'playing'
          ? `Playing live in your browser${dirty ? ' (your unsaved edits)' : ''}`
          : status === 'paused'
            ? 'Paused'
            : status === 'ended'
              ? 'Finished'
              : `Press play to hear ${dirty ? 'your edits' : 'this song'}. It plays straight away in your browser.`;
  const dotColor =
    status === 'error'
      ? 'bg-accent'
      : status === 'playing'
        ? 'bg-emerald-400'
        : status === 'loading'
          ? 'bg-white/40 animate-pulse'
          : 'bg-white/30';

  return (
    <div className="flex h-7 shrink-0 items-center justify-between gap-6 border-t border-black/70 bg-[#232428] px-4 text-[11px] text-[#9a9ba3]">
      <div className="flex items-center gap-3 min-w-0">
        <span className={`h-2 w-2 rounded-full shrink-0 ${dotColor}`} aria-hidden />
        <span className="truncate" title={error}>{label}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-[11px]">
        {renderInFlight(render) ? <span>Rendering the mix: {renderLabel(render)}</span> : <span className="text-dim/70">Mix, stems, MIDI, REAPER, Logic: Export… (top right)</span>}
      </div>
    </div>
  );
}

