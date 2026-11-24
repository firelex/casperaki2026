/**
 * A change to the song that should not stop it playing (the vocal controls: a track switched on or off, another
 * voice, Sing again): the control requests it before changing the song, and the transport, seeing the new version,
 * switches to it seamlessly at the same position instead of leaving the old version playing.
 */
let requested = false;
export const followOnChange = {
  request(): void {
    requested = true;
  },
  /** Whether a request is pending (and clears it). */
  take(): boolean {
    const r = requested;
    requested = false;
    return r;
  },
};
