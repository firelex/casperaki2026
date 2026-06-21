// Step 16 — arrangement polish (fills / mutes / transitions / signal
// processors). See docs/53aa-step16-arrangement-polish-import.md.

export {
  generateFills,
  type ArrangementFills,
} from './fills.js';
export {
  generateMutes,
  type ArrangementMutes,
} from './mutes.js';
export {
  generateTransitions,
  type ArrangementTransitions,
} from './transitions.js';
export {
  generateSignalProcessors,
  type ArrangementSignalProcessors,
} from './signal-processors.js';
export {
  loadFillBank,
  loadArrangementRules,
  _resetArrangementPolishCache,
  type FillBank,
  type FillCategory,
  type FillVariant,
  type ArrangementRules,
  type FillSegmentRule,
  type TransitionSegmentRule,
  type SignalProcessorChoice,
} from './data.js';
export {
  segmentType,
  isTransitionAnchorSegment,
  type SegmentType,
} from './segment-type.js';
export {
  applyArrangementOverrides,
  decideDrumOverrides,
  decideBassOverrides,
  synthesizeBassOverrideForSegment,
  applyDrumOverrideMask,
  synthesizeFloorPattern,
  bassOverrideNotes,
  _resetOverrideMidiMap,
  type DrumOverrideDecision,
  type DrumMaskType,
  type BassOverrideType,
  type OverrideScope,
} from './overrides.js';
