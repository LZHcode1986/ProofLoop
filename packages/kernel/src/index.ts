/**
 * @proofloop/kernel — Neutral schema / digest core.
 *
 * This package has zero workspace dependencies. After the neutral cutover it
 * provides only the mechanical contract surface still consumed by
 * @proofloop/runtime and downstream host-adapter packages:
 * - the RuntimeLock artifact contract (`.proofloop/runtime.lock`);
 * - the shared SchemaValidationError and canonical Stage ID guard;
 * - the single canonicalJson / digest utilities;
 * - the neutral vNext Plan / Reference / Proof / ExecutionScope contracts.
 *
 * The old Receipt / Manifest / Finding / RuntimeProof / NextAction and
 * Stage-Slice-CV-Project state machine surface was removed with the
 * business stack.
 */

// RuntimeLock artifact contract (§4 File / Artifact Contracts)
export type { RuntimeLock } from './contracts';

// Shared validation machinery: SchemaValidationError, RuntimeLock
// validator, and the canonical Stage ID guard (S09-C-T03).
export {
  SchemaValidationError,
  validateRuntimeLock,
} from './validators';
export type { ValidatedRuntimeLock } from './validators';

// Canonical Stage ID guard (S09-C-T03) — the SINGLE shared `^S\d+$` rule.
// The retired candidate parser / compiler / admission consumers are gone;
// the guard now serves the surviving neutral vNext surfaces.
export {
  CANONICAL_STAGE_ID_RE,
  isCanonicalStageId,
  assertCanonicalStageId,
} from './validators';
export type { CanonicalStageId } from './validators';

/** Minimal type for workspace import chain demonstration. */
export type PackageName = string;

/** Canonical package name for @proofloop/kernel. */
export const KERNEL_NAME: PackageName = '@proofloop/kernel';

// ============================================================
// vNext Contract Foundation — neutral machine surface.
// Closed, versioned contracts for Canonical Plan, Reference Index,
// Proof Index, and canonicalization / digest utilities.
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
} from './vnext';

// vNext canonicalization / digest utilities
export {
  canonicalJson,
  sha256Hex,
  computeDigest,
  SHA256_HEX_RE,
  isSha256Hex,
} from './vnext';

// vNext Canonical Plan model
export {
  canonicalizePlanProjection,
  computePlanDigest,
  validateVNextPlan,
} from './vnext';

// vNext Reference Index
export {
  validateVNextReferenceDescriptor,
  validateVNextReferenceIndex,
} from './vnext';

// vNext Proof Index
export { validateVNextProofIndex } from './vnext';