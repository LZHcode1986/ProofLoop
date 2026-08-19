/**
 * @proofloop/kernel — vNext Contract Foundation public surface (S0-A).
 *
 * Aggregates the closed, versioned vNext contracts: Canonical Plan model,
 * Reference Index, Proof Index, and vNext Manifest.
 */

export {
  VNEXT_SCHEMA_VERSION,
  VNEXT_REFERENCE_KINDS,
  VNEXT_PLAN_KINDS,
  VNEXT_EXECUTION_SCOPE_KINDS,
  VNEXT_BINDING_SCHEMA_VERSION,
  VNEXT_BINDING_MODES,
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
  VNextStageNodeProjection,
  VNextBindingSchemaVersion,
  VNextBindingMode,
  VNextManifestBinding,
  VNextReferenceBinding,
  VNextDependencyBinding,
  VNextExecutionBindingInput,
  VNextStageContractProjection,
  VNextSliceContractProjection,
  VNextExecutionBindingProjection,
  VNextRuntimeProofSection,
  VNextManifestSlice,
  VNextManifest,
  VNextSpvPassReceipt,
  VNextStagePlanReceipt,
} from './types';

export { canonicalJson, sha256Hex, computeDigest, isSha256Hex } from './canonical';

export {
  canonicalizePlanProjection,
  computePlanDigest,
  findStageNode,
  canonicalizeStageNodeProjection,
  validateVNextPlan,
} from './plan';

export {
  validateVNextReferenceDescriptor,
  validateVNextReferenceIndex,
} from './reference';

export { validateVNextProofIndex } from './proof-index';

export { validateVNextManifest, VNEXT_REF_GRAMMAR_RE } from './manifest';

export {
  validateBindingSchemaVersion,
  validateBindingMode,
  validateReferenceBinding,
  validateDependencyBinding,
  validateStageContractProjection,
  validateSliceContractProjection,
  validateExecutionBindingProjection,
  computeStageContractDigest,
  computeSliceContractDigest,
  computeExecutionBindingDigest,
} from './bindings';

export {
  validateVNextSpvPassReceipt,
  validateVNextStagePlanReceipt,
  computeVNextSpvPassReceiptDigest,
  computeVNextStagePlanReceiptDigest,
} from './admission';
