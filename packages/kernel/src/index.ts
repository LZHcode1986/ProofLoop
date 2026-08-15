/**
 * @proofloop/kernel — Domain types, state machines, and contracts.
 *
 * This package has zero workspace dependencies and provides the foundational
 * type definitions and state machine logic consumed by @proofloop/runtime
 * and downstream host-adapter packages.
 */

// Canonical type surface (§5 Canonical Type Registry) — non-contract types
export type {
  StageID,
  SliceID,
  NextAction,
  RoleType,
} from './types';
export {
  StageState,
  SliceState,
  CVStatus,
  ProjectState,
} from './types';
export type {
  StageEvent,
  SliceEvent,
  CvEvent,
  ProjectEvent,
} from './types';

// Contract artifact types (§4 File / Artifact Contracts)
export type {
  FindingCode,
  Finding,
  ReceiptType,
  Receipt,
  ManifestSlice,
  Manifest,
  RuntimeLock,
  ProofObligation,
  RuntimeProofStep,
} from './contracts';

// Domain errors (§7 Error Contracts)
export { InvalidTransitionError, ReceiptChainError } from './errors';

// State machine transition functions (§6 State Machines)
export {
  transitionStage,
  transitionSlice,
  transitionCv,
  transitionProject,
} from './transitions';

// Contract validators (§4 File / Artifact Contracts, §7 Error Contracts)
export {
  validateReceipt,
  validateManifest,
  validateRuntimeLock,
  validateFinding,
  SchemaValidationError,
} from './validators';
export type {
  ValidatedReceipt,
  ValidatedManifest,
  ValidatedRuntimeLock,
  ValidatedFinding,
} from './validators';

// Canonical Stage ID guard (S09-C-T03) — the SINGLE shared `^S\d+$` rule for
// candidate parser, compiler, Mechanical Validator, plan/stage/review status
// and every admission seam. Legacy S08B0/S08B labels fail closed.
export {
  CANONICAL_STAGE_ID_RE,
  isCanonicalStageId,
  assertCanonicalStageId,
} from './validators';
export type { CanonicalStageId } from './contracts';

// ReceiptWriter — digest & chain verification (§4 File / Artifact Contracts).
// `writeReceipt` remains the v1 compatibility API; future Runtime admission
// must use the additive root-bound `writeReceiptBounded` seam instead.
export {
  computeReceiptDigest,
  verifyReceiptDigest,
  verifyReceiptChain,
  writeReceipt,
  writeReceiptBounded,
  ensureBoundedReceiptDirectory,
  assertValidReceiptChain,
  DEFAULT_LOCK_TIMEOUT_MS,
} from './receipt-writer';
export type {
  ReceiptWriterOptions,
  BoundedReceiptWriterOptions,
  EnsureBoundedReceiptDirectoryOptions,
  ReceiptDirectoryBinding,
  ReceiptFileBinding,
  BoundedWriteReceiptResult,
  WriteReceiptResult,
  VerifyReceiptChainOptions,
  ChainVerificationResult,
} from './receipt-writer';

/** Minimal type for workspace import chain demonstration. */
export type PackageName = string;

/** Canonical package name for @proofloop/kernel. */
export const KERNEL_NAME: PackageName = '@proofloop/kernel';

// ============================================================
// vNext Contract Foundation (S0-A bootstrap) — ADDITIVE surface.
// Closed, versioned contracts for Canonical Plan, Reference Index,
// Proof Index, and the vNext Manifest. v1 contracts above are unchanged.
// ============================================================

// vNext constants
export {
  VNEXT_SCHEMA_VERSION,
  VNEXT_REFERENCE_KINDS,
  VNEXT_PLAN_KINDS,
  VNEXT_EXECUTION_SCOPE_KINDS,
  VNEXT_REF_GRAMMAR_RE,
} from './vnext';

// vNext types
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
  VNextRuntimeProofSection,
  VNextManifestSlice,
  VNextManifest,
  VNextSpvPassReceipt,
  VNextStagePlanReceipt,
} from './vnext';

// vNext canonicalization / digest utilities
export {
  canonicalJson,
  sha256Hex,
  computeDigest,
  isSha256Hex,
} from './vnext';

// vNext Canonical Plan model (Slice 0.1)
export {
  canonicalizePlanProjection,
  computePlanDigest,
  validateVNextPlan,
} from './vnext';

// vNext Reference Index (Slice 0.2)
export {
  validateVNextReferenceDescriptor,
  validateVNextReferenceIndex,
} from './vnext';

// vNext Proof Index (Slice 0.2)
export { validateVNextProofIndex } from './vnext';

// vNext Manifest (Schema Cutover)
export { validateVNextManifest } from './vnext';
export {
  validateVNextSpvPassReceipt,
  validateVNextStagePlanReceipt,
  computeVNextSpvPassReceiptDigest,
  computeVNextStagePlanReceiptDigest,
} from './vnext';
