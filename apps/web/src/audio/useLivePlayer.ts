import { useEffect, useState, useSyncExternalStore } from 'react';

import { livePlayer, type LivePlayer, type LiveState } from './livePlayer';

/** The live player's state (status, loaded song, duration, loading step). */
export function useLiveState(player: LivePlayer = livePlayer): LiveState {
  return useSyncExternalStore(
    (fn) => player.subscribe(fn),
    () => player.getState(),
  );
}

/** Playback position in seconds, refreshed every animation frame while playing. */
export function useLivePosition(active: boolean, player: LivePlayer = livePlayer): number {
  const [pos, setPos] = useState(() => player.position());
  useEffect(() => player.onPositionJump(() => setPos(player.position())), [player]);
  useEffect(() => {
    setPos(player.position());
    if (!active) return;
    let raf = 0;
    const tick = () => {
      setPos(player.position());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, player]);
  return pos;
}
