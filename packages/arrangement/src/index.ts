// Public barrel for @casperaki/arrangement.
//
// Phase 3 step 2 — skeleton + shared types. Concrete generators land in
// subsequent steps (structure, chords, patterns, vocals, orchestrate).

export type { GenerateParams, GeneratorContext, Seeded } from './context.js';
export { DataAssetError } from './data/loader.js';
export type { DataAssetMeta } from './data/loader.js';
export { generateSongStructure, SECTION_TYPES } from './structure/index.js';
export { generateChords } from './chords/index.js';
export {
  loadChordBank,
  filterBankByRole,
  selectBankEntry,
  resolveBankEntry,
  type BankEntry,
  type BankRole,
} from './chords/bank.js';
export {
  loadInstrumentCatalogSnapshot,
  loadEffectiveCatalogSnapshot,
} from './catalog/snapshot.js';
export {
  buildUnionCatalog,
  parseDiskFilename,
  isVariantRender,
  type UnionBuildInput,
  type UnionBuildResult,
  type ParsedDiskFields,
} from './catalog/build-union.js';
export {
  loadValidatedCatalog,
  ValidatedCatalogEntrySchema,
  type ValidatedCatalog,
  type ValidatedCatalogEntry,
} from './catalog/validated-catalog.js';
export {
  AssetResolutionSchema,
  AssetResolutionProvenanceSchema,
  MatchKindSchema,
  ResolvedAssetSchema,
  UnresolvedAssetSchema,
  UnresolvedAssetDiagnosticsSchema,
  buildAssetResolver,
  getDefaultAssetResolver,
  resolveAssetPath,
  type AssetResolution,
  type AssetResolutionProvenance,
  type AssetResolver,
  type AssetResolverInput,
  type MatchKind,
  type ResolvedAsset,
  type UnresolvedAsset,
  type UnresolvedAssetDiagnostics,
} from './catalog/asset-resolver.js';
export {
  auditSampleLibrary,
  expectedRelativePaths,
  preferredExpectedPath,
  SampleLibraryAuditReportSchema,
  type SampleLibraryAuditReport,
  type DiskIndex,
  type AuditProvenance,
  type AuditSummary,
  type LowLevelAlias,
  type MatchedRow,
  type MissingRow,
  type AmbiguousRow,
  type DuplicateCandidate,
  type UnmatchedFile,
  type FamilySummary,
} from './catalog/audit-sample-library.js';
export {
  buildInstrumentCatalogSnapshot,
  recomputeContentHash,
  type BuildSnapshotInput,
  type SheetRows,
} from './catalog/build-snapshot.js';
export { loadPublicNames, publicNameOf } from './catalog/public-names.js';
export {
  loadPatternProposals,
  previewParamsFor,
  PatternProposalSchema,
  PROPOSALS_DIR,
  DRUM_BANK_DIR,
  BASS_BANK_DIR,
  authoredStyleName,
  type PatternProposal,
} from './patterns/proposals.js';
export { AUTHORED_DRUM_ALGOS } from './patterns/drums-authored.js';
export { AUTHORED_BANK_DIR, authoredStyleNames } from './patterns/authored-bank.js';
export {
  CHORD_TONE_FAMILIES,
  resolveChordTone,
  sectionEnergy,
  type ChordTonePattern,
  type GuitarPickPattern,
} from './patterns/chord-tones.js';
export {
  resolveAliases,
  buildAliasRegistry,
  deriveSoundIdentity,
  baseNameFor,
  nameSpaceSize,
  poolForFamily,
  familyClassWord,
  type Pool,
  ALIAS_REGISTRY_DESCRIPTION,
  ALIAS_GENERATOR_ID,
  type AliasRegistry,
  type ResolveAliasesInput,
  type ResolveAliasesResult,
} from './catalog/alias.js';
export {
  catalogToWorkbook,
  workbookToCatalog,
  META_SHEET_NAME,
  ALIAS_HEADER,
  ROLE_CLASS_HEADER,
  DISK_PATH_HEADER,
  ON_DISK_HEADER,
  SOUND_IDENTITY_HEADER,
  type Cell,
  type WorkbookModel,
  type WorkbookSheetRows,
  type CatalogToWorkbookOptions,
  type WorkbookToCatalogResult,
} from './catalog/xlsx-roundtrip.js';
export {
  InstrumentCatalogSnapshotSchema,
  InstrumentEntrySchema,
  InstrumentSheetFamilySchema,
  MainStyleSchema,
  AddStyleSchema,
  VocabularySchema,
  LegacyProvenanceSchema,
  UnionProvenanceSchema,
  type AddStyle,
  type InstrumentCatalogSnapshot,
  type InstrumentEntry,
  type InstrumentSheetFamily,
  type LegacyProvenance,
  type MainStyle,
  type UnionProvenance,
  type Vocabulary,
} from './catalog/types.js';
export { selectInstruments } from './selection/index.js';
export {
  generatePatterns,
  generateDrumPattern,
  generateBassPattern,
  generateKeysPattern,
  generatePadPattern,
} from './patterns/index.js';
export {
  describeDrumBank,
  selectDrumBlueprint,
  type DrumBlueprint,
  type DrumBankSelection,
  type DrumStyleBank,
} from './patterns/drums-bank.js';
export {
  describeBassBank,
  selectBassPattern,
  type BassHit,
  type BassPattern as BassBankPattern,
  type BassBankSelection,
  type BassStyleBank,
} from './patterns/bass-bank.js';
export {
  describeKeysBank,
  resolveKeysStyle,
  selectKeysPattern,
  selectChordsStraightPattern,
  selectEdmHousePianoPattern,
  type EdmHouseChordSlot,
  type EdmHousePianoSelection,
  type KeysBankSelection,
  type KeysHitGroup,
  type KeysLengthCategory,
  type KeysLengthDurations,
  type KeysPattern as KeysBankPattern,
  type KeysStyleBank,
  type KeysStyleKind,
  type ResolvedKeysStyle,
} from './patterns/keys-bank.js';
export {
  generateKeysAlgoBlueprint,
  isKeysAlgoStyleName,
  KEYS_ALGO_STYLE_NAMES,
  type KeysAlgoBlueprint,
  type KeysAlgoEvent,
  type KeysAlgoStyleName,
} from './patterns/keys-algo.js';
export {
  describePadBank,
  selectPadStyle,
  type PadBankSelection,
  type PadChordVoicing,
  type PadStyle,
} from './patterns/pad-bank.js';
export {
  generateFills,
  generateMutes,
  generateTransitions,
  generateSignalProcessors,
  applyArrangementOverrides,
  decideDrumOverrides,
  decideBassOverrides,
  synthesizeBassOverrideForSegment,
  loadArrangementRules,
  loadFillBank,
  _resetArrangementPolishCache,
  segmentType,
  isTransitionAnchorSegment,
  type DrumOverrideDecision,
  type DrumMaskType,
  type BassOverrideType,
  type ArrangementFills,
  type ArrangementMutes,
  type ArrangementSignalProcessors,
  type ArrangementTransitions,
  type ArrangementRules,
  type FillBank,
  type FillCategory,
  type FillVariant,
  type FillSegmentRule,
  type TransitionSegmentRule,
  type SignalProcessorChoice,
  type SegmentType,
} from './arrangement-polish/index.js';
export { generateVocalMelody, writeVocals } from './vocals/index.js';
export {
  buildVocalScaffolding,
  type NoteScaffolding,
  type SegmentScaffolding,
  type SyllableType,
  type VocalScaffolding,
} from './vocals/scaffolding.js';
export {
  applyLyricsToSegments,
  loadSyllableBank,
  splitWordToSyllables,
  syllabifyPhrase,
  type AlignmentReport,
  type AttachResult,
  type PhrasePlan,
  type PhrasePlanLine,
  type SyllableBank,
  type SyllableEntry,
  type SyllableToken,
} from './vocals/syllabify.js';
export {
  loadSeedPhrasesBank,
  selectSeedPhrasePlan,
  selectSeedPhrasePlanWithReport,
  type RhymeLineReport,
  type RhymeReport,
  type SeedPhrase,
  type SeedPhrasePlanResult,
  type SeedPhrasesBank,
} from './vocals/lyrics-source/seed.js';
export {
  RhymeIndex,
  getRhymeIndex,
  loadDirtyRhymesBank,
  type DirtyRhymesBank,
} from './vocals/rhyme.js';
export {
  DISPLAY_NAMES,
  ORCHESTRATOR_NAME,
  ORCHESTRATOR_VERSION,
  lowerToSong,
  orchestrate,
  type LowerInputs,
  instrumentDefinitionFromCatalog,
} from './orchestrate/index.js';
export {
  VocalBarSchema,
  VocalResultSchema,
  VocalSegmentSchema,
  type VocalBar,
  type VocalResult,
  type VocalSegment,
} from './vocals/types.js';
export {
  BarPatternSchema,
  FamilyPatternSchema,
  PatternResultSchema,
  SegmentPatternsSchema,
  type BarPattern,
  type FamilyPattern,
  type PatternResult,
  type SegmentPatterns,
} from './patterns/types.js';
export {
  InstrumentFamilySchema,
  SegmentActivitySchema,
  SelectedInstrumentSchema,
  SelectedLoopSchema,
  SelectionResultSchema,
  type InstrumentFamily,
  type SegmentActivity,
  type SelectedInstrument,
  type SelectedLoop,
  type SelectionResult,
} from './selection/types.js';
export { LOOP_DISPLAY_NAME, LOOP_GENRES } from './selection/index.js';
export { familySoundPool, laneFamilyOf, LANE_BASE_NAMES, userSoundFamily, userSoundFor } from './selection/index.js';
export {
  applyTrackEditsToSelection,
  recordedTrackEdits,
  RecordedTrackEditSchema,
  TRACK_EDITS_PARAM,
  type RecordedTrackEdit,
} from './edits/recorded.js';
export {
  editTrack,
  FAMILY_LABELS,
  generatorParams,
  spliceTrack,
  TrackEditError,
  TrackEditRequestSchema,
  trackOptions,
  type TrackEditRequest,
  type TrackOptions,
} from './edits/track-edits.js';
export { addSection, nextSectionName } from './edits/add-section.js';
export { previewPiano, vocalAsPiano } from './edits/vocal-piano.js';
export {
  finalChordRootForSegment,
  isSwappableTransition,
  isTransitionSoundFor,
  pickTransitionSound,
  resolveTransitionSound,
  transitionPackKey,
  transitionSoundChoices,
  TRANSITION_SOUND_LANES,
  PREVIEW_ONLY_TRANSITION_TAGS,
  type PickedTransitionSound,
  type TransitionSoundContext,
  type TransitionSoundLane,
} from './transitions/sound.js';
export { setTransition, TRANSITION_TYPES, type SetTransitionRequest, type TransitionPlacement as UserTransitionPlacement } from './edits/transitions.js';
export {
  DRUM_ROLE_FAMILIES,
  DRUM_ROLE_LABELS,
  DRUM_ROLES,
  DRUM_SOUNDS_DETAIL,
  defaultDrumEntry,
  drumKit,
  drumRolesForFamily,
  drumSoundEntry,
  isDrumRole,
  songDrumSounds,
  type DrumKitSlot,
  type DrumRole,
} from './drums/kit.js';
