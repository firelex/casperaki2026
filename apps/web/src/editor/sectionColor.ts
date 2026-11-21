/** Colour token for a song section, from its type tag or name
 *  (intro / verse / pre-chorus / chorus / break / bridge / outro). */
export function sectionColor(kind: string): string {
  const k = kind.toLowerCase();
  if (k.includes('pre')) return 'var(--color-seg-prechorus)';
  if (k.includes('verse')) return 'var(--color-seg-verse)';
  if (k.includes('break')) return 'var(--color-seg-break)';
  if (k.includes('chorus')) return 'var(--color-seg-chorus)';
  if (k.includes('bridge')) return 'var(--color-seg-bridge)';
  if (k.includes('intro')) return 'var(--color-seg-intro)';
  if (k.includes('outro')) return 'var(--color-seg-outro)';
  return 'var(--color-seg-bridge)';
}
