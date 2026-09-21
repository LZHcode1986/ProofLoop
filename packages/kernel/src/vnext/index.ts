/**
 * @proofloop/kernel — vNext Contract Foundation public surface.
 *
 * Aggregates the neutral, closed vNext machine contracts: Canonical Plan
 * model, Reference Index, Proof Index, and the canonicalization / digest
 * utilities. Manifest / Receipt / admission / binding credential exports
 * were removed with the old business stack.
 */
export {
  VNEXT_SCHEMA_VERSION,
  VNEXT_REFERENCE_KINDS,
  VNEXT_PLAN_KINDS,
  VNEXT_EXECUTION_SCOPE_KINDS,
} from './types';
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
} from './types';

export {
  canonicalJson,
  sha256Hex,
  computeDigest,
  isSha256Hex,
  VNEXT_REF_GRAMMAR_RE,
} from './canonical';
export { SHA256_HEX_RE } from './canonical';

export {
  canonicalizePlanProjection,
  computePlanDigest,
  validateVNextPlan,
} from './plan';

export {
  validateVNextReferenceDescriptor,
  validateVNextReferenceIndex,
} from './reference';

export { validateVNextProofIndex } from './proof-index';