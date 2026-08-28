/**
 * @proofloop/runtime — vNext Runtime seam public surface (S0-A bootstrap, task 2).
 *
 * Aggregates the read-only entity resolver and the vNext Manifest compiler
 * for Planner / Executor consumption, plus re-exports the kernel vNext
 * validators so downstream consumers keep a single import path.
 */

export {
  resolveVNextReference,
  parseEntityRef,
  parseEntityMarkers,
  normalizeEntityText,
  normalizePlanExecutionProjection,
  readRootBoundFile,
  extractJsonEntity,
  assertFileUnchanged,
  VNextEntityResolutionError,
} from './entity-resolver';
export type {
  EntityDigestBinding,
  ParsedEntityRef,
  MarkedEntity,
  ResolvedEntity,
  ResolveEntityOptions,
  ReadRootBoundResult,
} from './entity-resolver';

export {
  compileVNextManifest,
  writeVNextManifest,
  VNextCompileError,
} from './compiler';
export type {
  CompileVNextManifestInput,
  CompileVNextManifestResult,
  VNextManifestWriteOps,
  VNextReferenceSeed,
  VNextSliceSeed,
} from './compiler';

export {
  adaptCandidateInputToCompileVNextManifestInput,
  candidateInputToCompileVNextManifestInput,
  isActiveCandidateInput,
  readActiveCandidateInput,
  CandidateInputError,
} from './candidate-input';
export type {
  ActiveCandidateInput,
  ActiveCandidateReference,
  ActiveCandidateRiskBinding,
  ActiveCandidateProofIndex,
  ActiveCandidateTask,
  ActiveCandidateSlice,
  CandidateInputErrorCode,
} from './candidate-input';

// A1 step 2 — deterministic Plan Materializer pipeline ported from the
// active helper (.mjs) into Runtime TypeScript.  `materializeCandidatePlan`
// is the single entry the CLI `plan materialize` seam consumes: it validates
// the closed candidate input, renders the candidate tasks.md byte-identically
// to the helper, and either writes it (CANDIDATE_READY) or rechecks it
// read-only (CANDIDATE_CHECKED).  The .mjs stays untouched as the comparison
// baseline until the byte-consistency verification retires it.
export {
  materializeCandidatePlan,
  validateInput,
  renderCandidatePlan,
  validateRenderedDocument,
  MaterializerError,
} from './plan-materializer';
export type {
  MaterializerPlan,
  MaterializerSlice,
  MaterializerTask,
  MaterializerStageGoal,
  MaterializerExecutionScope,
  MaterializerReferenceDescriptor,
  MaterializerRiskBinding,
  MaterializerProofIndex,
  MaterializeOptions,
  MaterializeResult,
  MaterializeSuccessPayload,
  MaterializeFailurePayload,
} from './plan-materializer';

// S09-C-T03 — shared canonical Stage ID guard.  Every Runtime consumer
// (candidate parser, compiler, Mechanical Validator, plan/stage/review status
// and every admission seam) applies the SAME `^S\d+$` grammar; legacy parked
// labels such as S08B0/S08B fail closed before any Runtime read/write.
export {
  CANONICAL_STAGE_ID_RE,
  isCanonicalStageId,
  assertCanonicalStageId,
  VNextStageIdError,
} from './stage-id';

// S09-D-T01 — pre-admission pristine Evidence refresh service.  The refresh
// transaction (journal + per-file compare-and-swap, rollback and restart
// recovery) is the ONLY rebind path after a Manifest digest changes; it is
// strictly pre-admission (no plan/execution Receipts) and every declared
// skeleton must still be pristine and bound to the expected previous digest.
export {
  refreshVNextSliceEvidence,
  REFRESH_JOURNAL_FILE,
} from './evidence-refresh';
export type {
  RefreshVNextSliceEvidenceRequest,
  RefreshVNextSliceEvidenceResult,
  RefreshVNextMode,
} from './evidence-refresh';

// Kernel vNext validators — single import path (validators are the canonical
// schema seam for all artifact contract payloads, including vNext).
export {
  validateVNextPlan,
  validateVNextManifest,
  validateVNextReferenceDescriptor,
  validateVNextReferenceIndex,
  validateVNextProofIndex,
  VNEXT_SCHEMA_VERSION,
  VNEXT_REFERENCE_KINDS,
  VNEXT_PLAN_KINDS,
  VNEXT_REF_GRAMMAR_RE,
  computeVNextSpvPassReceiptDigest,
  computeVNextStagePlanReceiptDigest,
} from '@proofloop/kernel';

export {
  projectVNextWorkerDispatch,
  readVNextManifest,
  assertVNextManifestReferenceBindings,
  VNextHandoffError,
} from './dispatch';

export {
  VNextNextActionService,
  readVNextAdmissionAuthority,
  persistVNextWorkerContext,
  detectVNextManifestDiscriminator,
} from './next';
export type {
  VNextNextActionInput,
  VNextNextActionOutput,
} from './next';

// S10-B-T02 — role Context projection seam and CV Evidence read gate.  The
// CLI `context` domain consumes ONLY this seam; role is part of the Context
// digest, cross-role reuse fails closed, and the initial CV Evidence read
// gate is bound to digest-addressed refutation observations.
export {
  VNEXT_CONTEXT_ROLES,
  isVNextContextRole,
  projectVNextRoleContext,
  persistVNextRoleContext,
  projectVNextRefutationObservation,
  persistVNextRefutationObservation,
  verifyVNextRefutationObservationBinding,
} from './next';
export type {
  VNextContextRole,
  VNextRoleContextProjectionInput,
  VNextRoleContext,
  VNextRoleContextProjection,
  VNextRoleFacts,
  VNextRefutationObservationInput,
  VNextRefutationObservation,
  VNextRefutationObservationProjection,
  VNextRefutationObservationBinding,
} from './next';
export type {
  VNextAdmissionAuthority,
  VNextWorkerContext,
  VNextWorkerDispatch,
  ProjectVNextWorkerDispatchInput,
} from './dispatch';
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
} from '@proofloop/kernel';

export {
  VNEXT_NEXT_ACTIONS,
  VNEXT_WORKER_COMPLETION_MODES,
  VNEXT_WORKER_DISPATCH_MODES,
} from './types';
export type {
  VNextNextAction,
  VNextResponsibleRole,
  VNextWorkerCompletionMode,
  VNextWorkerDispatchMode,
  VNextTaskWorkerContext,
  VNextFinalizeWorkerContext,
  VNextRepairWorkerContext,
} from './types';

// vNext Code Verifier schema and admission seam.  The consumer is isolated
// from legacy reconcile/reducer admission and writes only through the bounded
// Runtime Receipt seam.
export {
  validateVNextCvResultEnvelope,
  validateVNextCVResultEnvelope,
  validateVNextCvResult,
  validateVNextCVResult,
  admitVNextCVResult,
  admitVNextCvResult,
} from './cv-admission';
export type {
  VNextCvAdmissionDependencies,
  VNextCVAdmissionDependencies,
  VNextCvAdmissionState,
} from './cv-admission';
export {
  VNEXT_CV_SCHEMA_VERSION,
  VNEXT_CV_RESULT_TYPE,
  VNEXT_CV_VERIFICATION_TYPES,
  VNEXT_CV_VERDICTS,
  VNEXT_CV_RISK_APPLICABILITIES,
} from './types';
export type {
  VNextCvSchemaVersion,
  VNextCvResultType,
  VNextCvVerificationType,
  VNextCvVerdict,
  VNextCvRiskApplicability,
  VNextCvRiskReference,
  VNextCvResultEnvelopeBase,
  VNextCvPassInitialResult,
  VNextCvPassRecheckResult,
  VNextCvRepairInitialResult,
  VNextCvRepairRecheckResult,
  VNextCvResultEnvelope,
  VNextCVResultEnvelope,
  VNextCvResult,
} from './types';

export { admitVNextStagePlan, validateVNextStagePlanAdmissionRequest, VNextStagePlanAdmissionError } from './admission';
export type { VNextStagePlanAdmissionRequest, VNextStagePlanAdmissionSuccess, VNextStagePlanAdmissionFailure, VNextStagePlanAdmissionResult } from './admission';

export { admitVNextWorkerResult } from './worker-admission';
export type { VNextWorkerAdmissionDependencies } from './worker-admission';
export type { VNextWorkerAdmissionState } from './types';

// vNext Slice Commit admission.  This consumer revalidates the current
// Worker/CV chains and committed Git boundary, then writes only the additive
// vNext SLICE_COMMIT Receipt through the bounded Runtime seam.
export {
  admitVNextSliceCommit,
  admitVNextSliceCommitResult,
  validateVNextSliceCommitRequest,
} from './commit-admission';
export type { VNextSliceCommitAdmissionDependencies } from './commit-admission';
export { loadVNextSliceCommitPolicyFacts } from './commit-admission';
export type { VNextSliceCommitPolicyInput } from './commit-admission';
export {
  loadSliceCommitPolicy,
  validateSliceCommitChangedFiles,
  validateSliceCommitCvBinding,
  SliceCommitPolicyError,
} from './slice-commit-policy';
export type {
  SliceCommitPolicyFacts,
  SliceCommitPolicy,
  SliceCommitChangedFilesOptions,
} from './slice-commit-policy';
export {
  VNEXT_SLICE_COMMIT_SCHEMA_VERSION,
  VNEXT_SLICE_COMMIT_RESULT_TYPE,
  VNEXT_SLICE_COMMIT_ACTION,
} from './types';
export type {
  VNextSliceCommitSchemaVersion,
  VNextSliceCommitResultType,
  VNextSliceCommitAction,
  VNextSliceCommitAdmissionState,
  VNextSliceCommitResult,
} from './types';

// vNext Integration admission.  This downstream consumer revalidates the
// complete Worker/CV/Slice Commit prefix and writes only the additive
// INTEGRATION_PASS fact through the bounded Runtime seam; it never enters the
// legacy reconcile/reducer Integration consumer.
export {
  admitVNextIntegration,
  admitVNextIntegrationResult,
  validateVNextIntegrationRequest,
} from './integration-admission';
export type { VNextIntegrationAdmissionDependencies } from './integration-admission';
export {
  VNEXT_INTEGRATION_SCHEMA_VERSION,
  VNEXT_INTEGRATION_RESULT_TYPE,
  VNEXT_INTEGRATION_ACTION,
} from './types';
export type {
  VNextIntegrationSchemaVersion,
  VNextIntegrationResultType,
  VNextIntegrationAction,
  VNextIntegrationAdmissionState,
  VNextIntegrationResult,
} from './types';

// vNext Stage Gate admission.  This downstream consumer revalidates the
// complete integrated prefix (Stage Plan/SPV authority, every Slice's
// Integration chain, the current Git boundary) plus the executed Runtime
// Proof digest, then writes only the additive GATE_PASS/GATE_FAIL fact
// through the bounded Runtime seam.
export {
  admitVNextGateResult,
  admitVNextGate,
  validateVNextGateResultRequest,
} from './gate-admission';
export type {
  VNextGateAdmissionDependencies,
  VNextGateResultAdmissionRequest,
} from './gate-admission';
export {
  VNEXT_GATE_SCHEMA_VERSION,
  VNEXT_GATE_RESULT_TYPE,
  VNEXT_GATE_ACTION,
  VNEXT_GATE_VERDICTS,
} from './types';
export type {
  VNextGateSchemaVersion,
  VNextGateResultType,
  VNextGateAction,
  VNextGateVerdict,
  VNextGateSliceIntegration,
  VNextGateAdmissionState,
  VNextGateResult,
} from './types';

// vNext Stage Review admission.  This terminal downstream consumer
// revalidates the Stage Plan/SPV authority, the executed Runtime Proof
// digest, the Stage Gate PASS fact that preceded the review, and the current
// Git boundary, then writes only the additive STAGE_REVIEW_PASS fact
// (verdict ACCEPTED | REPAIR) through the bounded Runtime seam.
export {
  admitVNextStageReview,
  assembleVNextStageReviewRequest,
  validateVNextStageReviewRequest,
  readVNextStageReviewStatus,
} from './review-admission';
export type {
  VNextReviewAdmissionDependencies,
  VNextStageReviewAdmissionRequest,
  VNextStageReviewStatusReport,
} from './review-admission';
export {
  VNEXT_REVIEW_SCHEMA_VERSION,
  VNEXT_REVIEW_RESULT_TYPE,
  VNEXT_REVIEW_ACTION,
  VNEXT_REVIEW_VERDICTS,
} from './types';
export type {
  VNextReviewSchemaVersion,
  VNextReviewResultType,
  VNextReviewAction,
  VNextReviewVerdict,
  VNextReviewAdmissionState,
  VNextReviewResult,
} from './types';

// vNext Stage Close admission (P-11).  This downstream consumer revalidates
// the Stage Plan/SPV authority tuple and the current Git boundary, then
// writes ONLY the additive write-once STAGE_CLOSE_PASS fact (v2 envelope,
// `stage-close/<stage>/<digest>.json`) through this module's bounded
// write-once seam — the machine authority that a Stage is closed (restricted
// closes included), consumed by stage-state derivation as COMPLETED.
export {
  admitVNextStageClose,
  admitVNextStageCloseResult,
  validateVNextStageCloseRequest,
  VNEXT_STAGE_CLOSE_PASS_TYPE,
} from './stage-close-admission';
export type {
  VNextStageCloseAdmissionDependencies,
  VNextStageCloseAdmissionRequest,
  VNextStageClosePassType,
} from './stage-close-admission';
export {
  VNEXT_STAGE_CLOSE_SCHEMA_VERSION,
  VNEXT_STAGE_CLOSE_RESULT_TYPE,
  VNEXT_STAGE_CLOSE_ACTION,
  VNEXT_STAGE_CLOSE_TYPES,
} from './types';
export type {
  VNextStageCloseSchemaVersion,
  VNextStageCloseResultType,
  VNextStageCloseAction,
  VNextStageCloseType,
  VNextStageCloseAdmissionState,
  VNextStageCloseResult,
} from './types';
// D2/P0-2: vNext Stage Review preparation facts（digest-addressed，非 Receipt、
// 不入 chain；主线 Row-12 PREPARE/FINALIZE 分裂的读侧消费点）。
export {
  persistVNextStageReviewPreparation,
  readVNextStageReviewPreparedFacts,
  VNEXT_STAGE_REVIEW_PREPARATION_SCHEMA_VERSION,
} from './review-preparation';
export type {
  VNextStageReviewPreparation,
  VNextStageReviewPreparedBinding,
} from './review-preparation';
