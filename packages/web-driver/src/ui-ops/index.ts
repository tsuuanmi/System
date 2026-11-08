// Ported from System 1 (tsuuanmi/system @ f199a277): packages/ui-ops/src/index.ts. Changes: packages/web-driver/README.md.
/**
 * The UI engine for website drivers (ADR-0021, docs/design/ui-operations.md).
 * @module @tsuuanmi/system-ui-ops
 */
export { copiedMarkdown, linksIn, preWrapText } from './answers.ts'
export { type ActArgs, type AttachOutcome, type ActOptions, type CandidateMatches, type CopyRefusedEvent, type DriftEvent, type EngineOptions, type HealEvent, type ReadbackDiff, type Resolved, type StallEvent, UiEngine, readbackDiff } from './engine.ts'
export type { HealThresholds, Scored, SnapshotNode } from './heal.ts'
export { toLocator } from './locate.ts'
export { type ActionSpec, type Candidate, type Condition, type ElementSpec, type ErrorRule, type Fingerprint, type Localized, type NetworkPattern, type SideEffect, type SourcedCandidate, type UiAnswer, type UiAttach, type UiMap, type UiModes, type UiSettings, type UiSite, DEFAULT_SETTINGS, appendOverlay, attachBinding, loadUiMap, unverifiedEntries } from './map.ts'
export { NetworkObserver } from './network.ts'
export { deletionUnverified, inspectConversationMenu, pageIdle, shippedMapOf, shippedMapProblemOf } from './site.ts'
export { driftData,evidenceData, type EvidenceStore, type OutlineNode, outlineOf, type UiOutline } from './outline.ts'
