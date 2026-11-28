// Single-key shortcuts of the track view. Owner 2026-11-28: "Can we make the F key a toggle for follow the song?"

/** The parts of a key press a shortcut looks at. */
export interface KeyPress {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
  /** Where the key was pressed: typing in a field is never a shortcut. */
  readonly target: { readonly tagName?: string; readonly isContentEditable?: boolean } | null;
}

/** Whether the key press toggles "Follow playhead": F alone (Shift allowed), not held down, not while typing. */
export function togglesFollow(e: KeyPress): boolean {
  if (e.code !== 'KeyF' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return false;
  const t = e.target;
  if (t && (t.isContentEditable || /^(input|textarea|select)$/iu.test(t.tagName ?? ''))) return false;
  return true;
}
