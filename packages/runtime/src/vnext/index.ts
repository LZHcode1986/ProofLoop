/**
 * @proofloop/runtime — vNext Runtime seam public surface.
 *
 * Post-cutover surface (bootstrap unlock): only mechanical primitives that
 * the new MES + Work Packet flow can call directly are exported.  Admission /
 * Receipt / Manifest / Context / Primary Next Action / old Gate exports were
 * removed with their owning modules; the redundant stable Git-boundary
 * wrapper (vnext/git-boundary.ts) was deleted — top-level git-boundary is the
 * sole stable Git transaction seam.
 */

// Root-bound / TOCTOU-safe read primitive (13.1 root & path safety).
export {
  readRootBoundFile,
  assertFileUnchanged,
  PathReadError,
  type ReadRootBoundResult,
} from '../path-guard';

// Shared canonical Stage ID guard (basic schema validation).
export {
  CANONICAL_STAGE_ID_RE,
  isCanonicalStageId,
  assertCanonicalStageId,
  VNextStageIdError,
} from './stage-id';


// Project Stage Map artifact parser + entry resolver (S02-A-T01).
export {
  CANONICAL_PROJECT_STAGE_MAP_PATH,
  parseStageMap,
  resolveStageMapEntry,
  StageMapResolutionError,
  STAGE_MAP_ENTRY_FIELDS,
} from './stage-map';
export type {
  StageMapEntry,
  StageMapEntryField,
  StageMapResolutionErrorCode,
} from './stage-map';
export {
  loadSliceCommitPolicy,
  validateSliceCommitChangedFiles,
  SliceCommitPolicyError,
} from './slice-commit-policy';
export type {
  SliceCommitPolicyFacts,
  SliceCommitPolicy,
  SliceCommitChangedFilesOptions,
} from './slice-commit-policy';


// Work-Packet protected-path boundary (Work Packet allowed scope + canonical roots).
export {
  assertProtectedScope,
  CANONICAL_PROTECTED_ROOTS,
  type ProtectedScopeInput,
} from './protected-paths';

// Neutral fail-closed error shared by validation seams.
export { VNextHandoffError } from './errors';

// Kernel vNext schema validators — single import path (canonical validation
// seam for artifact contract payloads).
export {
  validateVNextPlan,
  validateVNextReferenceDescriptor,
  validateVNextReferenceIndex,
  validateVNextProofIndex,
  VNEXT_SCHEMA_VERSION,
  VNEXT_REFERENCE_KINDS,
  VNEXT_PLAN_KINDS,
  VNEXT_REF_GRAMMAR_RE,
} from '@proofloop/kernel';
export type {
  VNextSchemaVersion,
  VNextReferenceKind,
  VNextReferenceDescriptor,
  VNextReferenceIndex,
  VNextRiskBinding,
  VNextProofIndex,
  VNextPlanKind,
  VNextExecutionScopeKind,
  VNextExecutionScope,
  VNextTaskScope,
  VNextPlanNode,
  VNextCanonicalPlan,
  VNextPlanProjection,
} from '@proofloop/kernel';
