// Shared helper — extract the canonical segment-type prefix from a segment
// name. Mirrors the legacy `segment.match( /[A-Za-z]+/ )[ 0 ]` idiom used
// across `services/classes/arrangements/instruments/{drums,transitions}.js`
// and the brain's own selection layer (see selection/index.ts).

export type SegmentType =
  | 'intro'
  | 'verse'
  | 'preChorus'
  | 'chorus'
  | 'bridge'
  | 'break'
  | 'outro';

export function segmentType(name: string): string {
  if (name === 'intro' || name.startsWith('intro')) return 'intro';
  if (name === 'outro' || name.startsWith('outro')) return 'outro';
  if (name.startsWith('preChorus')) return 'preChorus';
  if (name.startsWith('chorus')) return 'chorus';
  if (name.startsWith('verse')) return 'verse';
  if (name.startsWith('bridge')) return 'bridge';
  if (name.startsWith('break')) return 'break';
  return name;
}

/** Legacy `transitions.js` selection rule: only the first instance of each
 * segment-type (the one whose name contains '1') plus the head + tail get
 * a transition placement. Brain-port preserves this. */
export function isTransitionAnchorSegment(name: string): boolean {
  return name === 'intro' || name === 'outro' || name.includes('1');
}
