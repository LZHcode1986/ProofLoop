/**
 * vNext Worker dispatch contract types.
 *
 * The Worker Context carries both implementation scope and the narrowly
 * mutable Plan projection. The latter is an allowed file path for the
 * checkbox/Worker-Status projection only; it is never part of the code scope.
 */
import type {
  VNextExecutionScope,
  VNextSpvPassReceipt,
  VNextStagePlanReceipt,
} from '@proofloop/kernel';
import type { WorkerStepMode } from '../relay-contract';

/** Closed action vocabulary owned by the vNext next/context consumer. */
export const VNEXT_NEXT_ACTIONS = ['DISPATCH_WORKER', 'RUN_CV', 'VALIDATE'] as const;
export type VNextNextAction = (typeof VNEXT_NEXT_ACTIONS)[number];

/** Closed roles emitted by the vNext next/context consumer. */
export type VNextResponsibleRole = 'worker' | 'code-verifier' | 'executor';

/**
 * Closed completion-mode vocabulary for admissible vNext Worker facts
 * (S08-E-T07 §Recovery).
 *
 * `implement-task` is the initial implementation of a Task;
 * `recover-task` is the persisted/admissible discriminator of a consistency
 * recheck over already-produced implementation evidence (checkbox + evidence
 * + code diff) whose TASK_COMPLETE was never admitted — it never re-implements
 * the Task and is never consumed as a CV verdict. The mode is bound into the
 * digest-addressed Worker Context and the TASK_COMPLETE payload, so a Worker
 * cannot replace a recover-task binding with the implement-task narrative.
 */
export const VNEXT_WORKER_COMPLETION_MODES = ['implement-task', 'recover-task'] as const;
export type VNextWorkerCompletionMode = (typeof VNEXT_WORKER_COMPLETION_MODES)[number];

export interface VNextAdmissionAuthority {
  readonly stagePlan: VNextStagePlanReceipt;
  readonly spv: VNextSpvPassReceipt;
}

export interface VNextWorkerScope {
  readonly allowed_paths: readonly string[];
  readonly mutable_projection_paths: readonly string[];
  readonly forbidden_paths: readonly string[];
}

export interface VNextWorkerContext {
  readonly schema_version: 2;
  readonly root_path: string;
  readonly root_digest: string;
  readonly stage_id: string;
  readonly slice_id: string;
  readonly task_id: string;
  readonly task_ref: string;
  readonly slice_goal_ref: string;
  /**
   * The persisted dispatch-mode binding of this Context. Admission requires
   * the Worker result mode to equal this value, so a recover-task Context can
   * never be admitted under the implement-task narrative (S08-E-T07 §Recovery).
   */
  readonly mode: VNextWorkerCompletionMode;
  readonly proof_index: {
    readonly goal_ref: string;
    readonly task_refs: readonly string[];
    readonly acceptance_refs: readonly string[];
    readonly seam_refs: readonly string[];
    readonly oracle_refs: readonly string[];
    readonly risk_refs: readonly string[];
  };
  readonly required_skills: readonly string[];
  readonly evidence_path: string;
  /** Root-bound Manifest.plan.ref; only its mutable projection is editable. */
  readonly plan_projection_path: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly proof_index_digest: string;
  readonly snapshot_digest: string;
  /** Exactly the admitted code_paths and test_paths; never Plan/Evidence paths. */
  readonly allowed_code_scope: readonly string[];
  readonly context_digest: string;
  readonly execution_scope: VNextExecutionScope;
  readonly scope: VNextWorkerScope;
}

export interface VNextWorkerDispatch {
  readonly action: 'DISPATCH_WORKER';
  readonly responsible_role: 'worker';
  readonly stage_id: string;
  readonly slice_id: string;
  readonly task_id: string;
  readonly mode: VNextWorkerCompletionMode;
  readonly context_ref: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly proof_index_digest: string;
  readonly snapshot_digest: string;
  readonly receipt_chain_valid: true;
  readonly findings: readonly [];
  readonly context: VNextWorkerContext;
}

/**
 * Bounded state projection returned by vNext Worker-result admission.
 *
 * This is deliberately not a `ReconcileStageResult`: vNext admission facts are
 * not interpreted through the legacy state machine.
 */
export interface VNextWorkerAdmissionState {
  readonly schema_version: 2;
  readonly action: 'TASK_COMPLETE';
  readonly stage_id: string;
  readonly slice_id: string;
  readonly task_id: string;
  readonly mode: WorkerStepMode;
  readonly outcome: 'completed';
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly proof_index_digest: string;
  readonly snapshot_digest: string;
  readonly context_ref: string;
  readonly context_digest: string;
  readonly changed_files: readonly string[];
  readonly receipt_chain_valid: true;
}

// ---------------------------------------------------------------------------
// vNext Slice Commit admission contract
// ---------------------------------------------------------------------------

/** The only schema version admitted by the vNext Slice Commit consumer. */
export const VNEXT_SLICE_COMMIT_SCHEMA_VERSION = 2 as const;
export type VNextSliceCommitSchemaVersion = typeof VNEXT_SLICE_COMMIT_SCHEMA_VERSION;

/** Explicit payload discriminator; this is never a legacy SLICE_COMMIT fact. */
export const VNEXT_SLICE_COMMIT_RESULT_TYPE = 'SLICE_COMMIT_RESULT' as const;
export type VNextSliceCommitResultType = typeof VNEXT_SLICE_COMMIT_RESULT_TYPE;

/** Closed action discriminator owned by the vNext Slice Commit consumer. */
export const VNEXT_SLICE_COMMIT_ACTION = 'SLICE_COMMIT' as const;
export type VNextSliceCommitAction = typeof VNEXT_SLICE_COMMIT_ACTION;

/**
 * Additive state returned after a vNext Slice Commit Receipt is admitted.
 * This is intentionally not a legacy `ReconcileStageResult`; commit admission
 * does not synthesize or advance legacy state.
 */
export interface VNextSliceCommitAdmissionState {
  readonly schema_version: VNextSliceCommitSchemaVersion;
  readonly type: VNextSliceCommitResultType;
  readonly action: VNextSliceCommitAction;
  readonly stage_id: string;
  readonly slice_id: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly proof_index_digest: string;
  readonly snapshot_digest: string;
  readonly commit_sha: string;
  readonly cv_receipt_digest: string;
  readonly changed_files: readonly string[];
  readonly receipt_chain_valid: true;
}

/** Payload/state-compatible alias for callers that name the result directly. */
export type VNextSliceCommitResult = VNextSliceCommitAdmissionState;

// ---------------------------------------------------------------------------
// vNext Integration admission contract
// ---------------------------------------------------------------------------

/** The only schema version admitted by the vNext Integration consumer. */
export const VNEXT_INTEGRATION_SCHEMA_VERSION = 2 as const;
export type VNextIntegrationSchemaVersion = typeof VNEXT_INTEGRATION_SCHEMA_VERSION;

/** Explicit payload discriminator; this is never a legacy integration fact. */
export const VNEXT_INTEGRATION_RESULT_TYPE = 'INTEGRATION_RESULT' as const;
export type VNextIntegrationResultType = typeof VNEXT_INTEGRATION_RESULT_TYPE;

/** Closed action discriminator owned by the vNext Integration consumer. */
export const VNEXT_INTEGRATION_ACTION = 'INTEGRATION' as const;
export type VNextIntegrationAction = typeof VNEXT_INTEGRATION_ACTION;

/**
 * Additive state returned after a vNext Integration Receipt is admitted.
 * This state carries the complete predecessor tip binding without claiming
 * Stage Gate or Stage Review completion.
 */
export interface VNextIntegrationAdmissionState {
  readonly schema_version: VNextIntegrationSchemaVersion;
  readonly type: VNextIntegrationResultType;
  readonly action: VNextIntegrationAction;
  readonly stage_id: string;
  readonly slice_id: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly proof_index_digest: string;
  /** The planning/admitted execution snapshot, not the integrated boundary. */
  readonly snapshot_digest: string;
  /** The current committed boundary that has been integrated. */
  readonly commit_sha: string;
  readonly slice_commit_receipt_digest: string;
  readonly worker_receipt_digest: string;
  readonly cv_receipt_digest: string;
  readonly changed_files: readonly string[];
  readonly receipt_chain_valid: true;
}

/** Payload/state-compatible alias for callers that name the result directly. */
export type VNextIntegrationResult = VNextIntegrationAdmissionState;

// ---------------------------------------------------------------------------
// vNext Stage Gate result contract
// ---------------------------------------------------------------------------

/** The only schema version admitted by the vNext Stage Gate consumer. */
export const VNEXT_GATE_SCHEMA_VERSION = 2 as const;
export type VNextGateSchemaVersion = typeof VNEXT_GATE_SCHEMA_VERSION;

/** Explicit payload discriminator; this is never a legacy v1 GATE_PASS/GATE_FAIL fact. */
export const VNEXT_GATE_RESULT_TYPE = 'GATE_RESULT' as const;
export type VNextGateResultType = typeof VNEXT_GATE_RESULT_TYPE;

/** Closed action discriminator owned by the vNext Stage Gate consumer. */
export const VNEXT_GATE_ACTION = 'GATE' as const;
export type VNextGateAction = typeof VNEXT_GATE_ACTION;

/** Closed verdict vocabulary that can reach the vNext Gate consumer. */
export const VNEXT_GATE_VERDICTS = ['PASS', 'FAIL'] as const;
export type VNextGateVerdict = (typeof VNEXT_GATE_VERDICTS)[number];

/** One Slice integration binding asserted by the Gate (its Integration Receipt tip). */
export interface VNextGateSliceIntegration {
  readonly slice_id: string;
  readonly integration_receipt_digest: string;
  readonly commit_sha: string;
}

/**
 * Additive state returned after a vNext Stage Gate Receipt is admitted.
 * The Gate binds the Manifest, the Stage Plan/SPV admission authority, every
 * integrated Slice's Integration Receipt tip, and the current integrated
 * snapshot digest. Both GATE_PASS and GATE_FAIL receipts carry this state;
 * only the verdict differs.
 */
export interface VNextGateAdmissionState {
  readonly schema_version: VNextGateSchemaVersion;
  readonly type: VNextGateResultType;
  readonly action: VNextGateAction;
  readonly stage_id: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly stage_plan_receipt_digest: string;
  readonly spv_receipt_digest: string;
  /** The integrated snapshot the Gate run was bound to (current Git HEAD). */
  readonly snapshot_digest: string;
  readonly verdict: VNextGateVerdict;
  readonly integrated_slices: readonly VNextGateSliceIntegration[];
  readonly summary: string;
  /**
   * S09-REVIEW-001: legacy one-time restricted bootstrap marker.  Present
   * (true) only on the archived S09 all-not_applicable Gate Receipt; new
   * Gates never emit it (the Runtime Proof it marked was deleted).
   */
  readonly restricted_bootstrap?: true;
  /**
   * Verification path that produced this Gate fact.  `receipts` (default
   * when the request carries no explicit declaration): every Manifest
   * Slice's INTEGRATION_PASS Receipt chain was present and bound to the
   * current tuple.  `git_facts`: the explicit fail-closed fallback verified
   * each Slice's integration commit (slice-output marker in the HEAD
   * ancestor chain), complete Task Evidence (`Status: COMPLETE`) and fully
   * checked tasks.md checkboxes from Git history.  Absent on pre-decision
   * Receipts — old Receipts stay closed-valid (backward compatible).
   */
  readonly verification_source?: 'receipts' | 'git_facts';
  readonly receipt_chain_valid: true;
}

/** Payload/state-compatible alias for callers that name the result directly. */
export type VNextGateResult = VNextGateAdmissionState;

// ---------------------------------------------------------------------------
// vNext Stage Review result contract
// ---------------------------------------------------------------------------

/** The only schema version admitted by the vNext Stage Review consumer. */
export const VNEXT_REVIEW_SCHEMA_VERSION = 2 as const;
export type VNextReviewSchemaVersion = typeof VNEXT_REVIEW_SCHEMA_VERSION;

/** Explicit payload discriminator; this is never a legacy v1 STAGE_REVIEW_PASS fact. */
export const VNEXT_REVIEW_RESULT_TYPE = 'STAGE_REVIEW_RESULT' as const;
export type VNextReviewResultType = typeof VNEXT_REVIEW_RESULT_TYPE;

/** Closed action discriminator owned by the vNext Stage Review consumer. */
export const VNEXT_REVIEW_ACTION = 'STAGE_REVIEW' as const;
export type VNextReviewAction = typeof VNEXT_REVIEW_ACTION;

/** Closed verdict vocabulary that can reach the vNext Stage Review consumer. */
export const VNEXT_REVIEW_VERDICTS = ['ACCEPTED', 'REPAIR'] as const;
export type VNextReviewVerdict = (typeof VNEXT_REVIEW_VERDICTS)[number];

/**
 * Additive state returned after a vNext Stage Review Receipt is admitted.
 * The Review binds the Manifest, the Stage Plan/SPV admission authority, the
 * Stage Gate PASS Receipt that preceded the review, and the current
 * integrated snapshot digest. Both ACCEPTED and REPAIR verdicts persist this
 * state; only the verdict and summary differ.
 */
export interface VNextReviewAdmissionState {
  readonly schema_version: VNextReviewSchemaVersion;
  readonly type: VNextReviewResultType;
  readonly action: VNextReviewAction;
  readonly stage_id: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly stage_plan_receipt_digest: string;
  readonly spv_receipt_digest: string;
  /** Stage Gate PASS Receipt digest bound as the review precondition fact. */
  readonly stage_gate_receipt_digest: string;
  /** The integrated snapshot the Review was bound to (current Git HEAD). */
  readonly snapshot_digest: string;
  readonly verdict: VNextReviewVerdict;
  readonly summary: string;
  readonly receipt_chain_valid: true;
}

/** Payload/state-compatible alias for callers that name the result directly. */
export type VNextReviewResult = VNextReviewAdmissionState;

export interface ProjectVNextWorkerDispatchInput {
  readonly root: string;
  readonly manifest: unknown;
  readonly manifestDigest: string;
  readonly snapshotDigest: string;
  readonly authority?: VNextAdmissionAuthority;
  /** Existing vNext TASK_COMPLETE facts; completed tasks are not dispatched again. */
  readonly completedTaskIds?: readonly string[];
  /**
   * Explicit dispatch completion mode. Defaults to `implement-task`; the
   * execution next consumer passes `recover-task` when the Task checkbox is
   * already checked in the worktree (already-produced implementation
   * evidence without an admitted TASK_COMPLETE fact).
   */
  readonly mode?: VNextWorkerCompletionMode;
  /** Explicit current Slice selected from persisted execution facts. */
  readonly sliceId?: string;
  /**
   * Slices whose execution chain is already closed by an admitted vNext
   * SLICE_COMMIT fact. A Slice whose declared dependencies are all in this
   * set is dependency-ready for dispatch because its dependencies are
   * provably complete. Without this execution fact the dispatch seam stays
   * fail-closed on any non-empty depends_on list.
   */
  readonly provenCompleteSlices?: ReadonlySet<string>;
  readonly allowedPaths?: readonly string[];
  readonly forbiddenPaths?: readonly string[];
  readonly verifyReferenceBindings?: boolean;
}

// ---------------------------------------------------------------------------
// vNext Code Verifier result contract
// ---------------------------------------------------------------------------

/** The schema version the vNext CV result consumer persists (v2 receipts). */
export const VNEXT_CV_SCHEMA_VERSION = 2 as const;
export type VNextCvSchemaVersion = typeof VNEXT_CV_SCHEMA_VERSION;

/**
 * Slice-local CV envelope schema version (3, §8.3). The shared closed
 * validator accepts a well-formed v3 envelope (binding fields required).
 * Per the S12-D REPLAN, schema_version 3 IS the slice-local credential
 * version: a v3 CV envelope in a slice-local Stage is the legal credential
 * of that Stage (binding fields validated and bound to the Manifest
 * contract digests), and v3 CV receipts are persisted in slice-local mode.
 */
export const VNEXT_CV_SCHEMA_VERSION_SLICE_LOCAL = 3 as const;

/** Closed schema_version vocabulary of the CV envelope seam (2 | 3). */
export type VNextCvEnvelopeSchemaVersion =
  | typeof VNEXT_CV_SCHEMA_VERSION
  | typeof VNEXT_CV_SCHEMA_VERSION_SLICE_LOCAL;

/** Explicit discriminator; this envelope is never a legacy CV request. */
export const VNEXT_CV_RESULT_TYPE = 'CV_RESULT' as const;
export type VNextCvResultType = typeof VNEXT_CV_RESULT_TYPE;

/** Closed verification invocation vocabulary. */
export const VNEXT_CV_VERIFICATION_TYPES = ['initial', 'recheck'] as const;
export type VNextCvVerificationType = (typeof VNEXT_CV_VERIFICATION_TYPES)[number];

/** Closed verdict vocabulary that can reach the vNext CV consumer. */
export const VNEXT_CV_VERDICTS = ['PASS', 'REPAIR'] as const;
export type VNextCvVerdict = (typeof VNEXT_CV_VERDICTS)[number];

/** Closed applicability value for every risk reference considered by CV. */
export const VNEXT_CV_RISK_APPLICABILITIES = ['APPLICABLE', 'NOT_APPLICABLE'] as const;
export type VNextCvRiskApplicability = (typeof VNEXT_CV_RISK_APPLICABILITIES)[number];

/** A risk reference and its explicit applicability decision. */
export interface VNextCvRiskReference {
  readonly ref_id: string;
  readonly applicability: VNextCvRiskApplicability;
  readonly reason: string;
}

/**
 * Fields shared by every accepted vNext CV result branch.
 *
 * Arrays are deliberately present in the type rather than defaulted by the
 * validator.  This keeps the wire contract closed: a producer must state
 * which references and result observations it actually supplied.
 */
export interface VNextCvResultEnvelopeBase {
  readonly schema_version: VNextCvEnvelopeSchemaVersion;
  readonly type: VNextCvResultType;
  readonly stage_id: string;
  readonly slice_id: string;
  /**
   * The digest of the Worker TASK_COMPLETE Receipt that this CV result
   * evaluates.  The closed validator and the Runtime admission consumer both
   * require this binding, so every envelope branch type requires it too
   * (T02 runtime/type binding); a CV result without a Worker Receipt binding
   * is not a closed vNext fact.
   */
  readonly worker_receipt_digest: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly proof_index_digest: string;
  readonly context_ref: string;
  readonly context_digest: string;
  readonly snapshot_digest: string;
  readonly verification_type: VNextCvVerificationType;
  readonly summary: string;
  readonly acceptance_refs_checked: readonly string[];
  readonly seam_refs_checked: readonly string[];
  readonly oracle_refs_checked: readonly string[];
  readonly risk_refs_considered: readonly VNextCvRiskReference[];
  readonly failed_acceptance_refs: readonly string[];
  readonly invalid_tests: readonly string[];
  readonly counterexamples: readonly string[];
  readonly scope_violations: readonly string[];
  readonly forbidden_substitutions: readonly string[];
  readonly regression_failures: readonly string[];
}

/** Initial PASS has no failure or recheck metadata. */
export interface VNextCvPassInitialResult extends VNextCvResultEnvelopeBase {
  readonly verification_type: 'initial';
  readonly verdict: 'PASS';
}

/** A bounded recheck PASS carries the prior failure and repair diff binding. */
export interface VNextCvPassRecheckResult extends VNextCvResultEnvelopeBase {
  readonly verification_type: 'recheck';
  readonly verdict: 'PASS';
  readonly previous_failure_signature: string;
  readonly repair_diff_digest: string;
}

/** Initial REPAIR must identify the failure and its bounded recheck scope. */
export interface VNextCvRepairInitialResult extends VNextCvResultEnvelopeBase {
  readonly verification_type: 'initial';
  readonly verdict: 'REPAIR';
  readonly failed_criterion: string;
  readonly failure_signature: string;
  readonly required_recheck_scope: readonly string[];
}

/** A bounded recheck REPAIR retains both the prior failure and repair binding. */
export interface VNextCvRepairRecheckResult extends VNextCvResultEnvelopeBase {
  readonly verification_type: 'recheck';
  readonly verdict: 'REPAIR';
  readonly failed_criterion: string;
  readonly failure_signature: string;
  readonly required_recheck_scope: readonly string[];
  readonly previous_failure_signature: string;
  readonly repair_diff_digest: string;
}

/** Closed, verdict- and verification-type-discriminated vNext CV result. */
export type VNextCvResultEnvelope =
  | VNextCvPassInitialResult
  | VNextCvPassRecheckResult
  | VNextCvRepairInitialResult
  | VNextCvRepairRecheckResult;

/** Upper-case acronym alias for consumers that use `CV` in type names. */
export type VNextCVResultEnvelope = VNextCvResultEnvelope;
export type VNextCvResult = VNextCvResultEnvelope;

// ---------------------------------------------------------------------------
// Credential payload schema_version and binding vocabulary (S12-D-T04, §8.3)
// ---------------------------------------------------------------------------

/**
 * Closed schema_version vocabulary of every credential (Receipt) payload
 * (§8.3): 1 = legacy / 2 = current vNext / 3 = slice-local. Values > 3 are
 * unknown future schema versions and fail closed in every consumer.
 */
export const VNEXT_CREDENTIAL_SCHEMA_VERSIONS = [1, 2, 3] as const;
export type VNextCredentialSchemaVersion = (typeof VNEXT_CREDENTIAL_SCHEMA_VERSIONS)[number];

/** 1 = legacy credential (no binding fields; the legacy consumer blocks ≠ 1 whole-chain). */
export const VNEXT_CREDENTIAL_SCHEMA_VERSION_LEGACY = 1 as const;
/** 2 = current vNext credential (no binding fields; S12's own credential mode). */
export const VNEXT_CREDENTIAL_SCHEMA_VERSION_V2 = 2 as const;
/** 3 = slice-local credential; the three binding fields are required (§8.3). */
export const VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL = 3 as const;

/**
 * Closed slice-local binding field names carried by schema_version 3
 * credential payloads (§8.3): stage_contract_digest / slice_contract_digest /
 * execution_binding_digest, each a 64-hex digest. A v2 consumer that sees
 * these fields must fail closed (BINDING.SCHEMA_FUTURE / MODE_MIXED), never
 * silently ignore them; every v3-aware consumer validates them (64-hex,
 * Manifest contract digest consistency, recomputed execution binding).
 */
export const VNEXT_CREDENTIAL_BINDING_FIELDS = [
  'stage_contract_digest',
  'slice_contract_digest',
  'execution_binding_digest',
] as const;
export type VNextCredentialBindingField = (typeof VNEXT_CREDENTIAL_BINDING_FIELDS)[number];

export const VNEXT_BINDING_FIELD_STAGE_CONTRACT_DIGEST = 'stage_contract_digest' as const;
export const VNEXT_BINDING_FIELD_SLICE_CONTRACT_DIGEST = 'slice_contract_digest' as const;
export const VNEXT_BINDING_FIELD_EXECUTION_BINDING_DIGEST = 'execution_binding_digest' as const;

/**
 * Closed BINDING error-code vocabulary finalized at implementation time
 * (§8.4). The admission consumers use SCHEMA_FUTURE and MODE_MIXED; the
 * STALE codes belong to the slice currentness layer (S12-D-T01/T02).
 */
export const VNEXT_BINDING_ERROR_CODES = [
  'BINDING.STAGE_CONTRACT_STALE',
  'BINDING.SLICE_CONTRACT_STALE',
  'BINDING.EXECUTION_BINDING_STALE',
  'BINDING.MODE_MIXED',
  'BINDING.SCHEMA_FUTURE',
] as const;
export type VNextBindingErrorCode = (typeof VNEXT_BINDING_ERROR_CODES)[number];

/** The slice-local credential binding payload fields (schema_version 3, §8.3). */
export interface VNextCredentialBindingFields {
  readonly stage_contract_digest: string;
  readonly slice_contract_digest: string;
  readonly execution_binding_digest: string;
}

// ---------------------------------------------------------------------------
// vNext Stage Close result contract (P-11)
// ---------------------------------------------------------------------------

/** The only schema version admitted by the vNext Stage Close consumer. */
export const VNEXT_STAGE_CLOSE_SCHEMA_VERSION = 2 as const;
export type VNextStageCloseSchemaVersion = typeof VNEXT_STAGE_CLOSE_SCHEMA_VERSION;

/**
 * Explicit payload discriminator; STAGE_CLOSE is a vNext receipt and is never
 * a legacy v1 receipt type (the kernel 16-type `ReceiptType` union is
 * untouched — P-11 keeps the legacy union closed).
 */
export const VNEXT_STAGE_CLOSE_RESULT_TYPE = 'STAGE_CLOSE_RESULT' as const;
export type VNextStageCloseResultType = typeof VNEXT_STAGE_CLOSE_RESULT_TYPE;

/** Closed action discriminator owned by the vNext Stage Close consumer. */
export const VNEXT_STAGE_CLOSE_ACTION = 'STAGE_CLOSE' as const;
export type VNextStageCloseAction = typeof VNEXT_STAGE_CLOSE_ACTION;

/**
 * Closed close-type vocabulary of an admissible vNext Stage Close fact.
 *
 * `full` is the normal completion close; `restricted` is the user-adjudicated
 * close of a Stage that was never fully executed (e.g. the S10 restricted
 * close — no STAGE_REVIEW_PASS, possibly unintegrated Slices). Both are
 * machine-authoritative "Stage closed" markers that derive COMPLETED.
 */
export const VNEXT_STAGE_CLOSE_TYPES = ['full', 'restricted'] as const;
export type VNextStageCloseType = (typeof VNEXT_STAGE_CLOSE_TYPES)[number];

/**
 * Additive state returned after a vNext Stage Close Receipt is admitted.
 *
 * The Close binds the Manifest, the Stage Plan/SPV admission authority and
 * the current integrated snapshot (Git HEAD); it is the explicit machine
 * authority that a Stage is closed — a closed Stage derives COMPLETED even
 * without a STAGE_REVIEW_PASS (restricted closes). The Receipt payload is
 * exactly this closed field set.
 */
export interface VNextStageCloseAdmissionState {
  readonly schema_version: VNextStageCloseSchemaVersion;
  readonly type: VNextStageCloseResultType;
  readonly action: VNextStageCloseAction;
  readonly stage_id: string;
  readonly close_type: VNextStageCloseType;
  /** Non-empty human/machine reason of the close (required, fail-closed). */
  readonly reason: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  /** The Git HEAD snapshot the Close was bound to. */
  readonly snapshot_digest: string;
  readonly stage_plan_receipt_digest: string;
  readonly spv_receipt_digest: string;
  readonly receipt_chain_valid: true;
}

/** Payload/state-compatible alias for callers that name the result directly. */
export type VNextStageCloseResult = VNextStageCloseAdmissionState;
