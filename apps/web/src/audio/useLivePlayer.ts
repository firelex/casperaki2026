import { useEffect, useState, useSyncExternalStore } from 'react';

import { livePlayer, type LiveState } from './livePlayer';

/** The live player's state (status, loaded song, duration, loading step). */
export function useLiveState(): LiveState {
  return useSyncExternalStore(
    (fn) => livePlayer.subscribe(fn),
    () => livePlayer.getState(),
  );
}

/** Playback position in seconds, refreshed every animation frame while playing. */
export function useLivePosition(active: boolean): number {
  const [pos, setPos] = useState(() => livePlayer.position());
  useEffect(() => {
    setPos(livePlayer.position());
    if (!active) return;
    let raf = 0;
    const tick = () => {
      setPos(livePlayer.position());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return pos;
}
