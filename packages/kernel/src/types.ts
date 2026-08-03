/**
 * @proofloop/kernel — Canonical Domain Type Definitions
 *
 * This file defines the canonical type surface exported by @proofloop/kernel.
 * Every type name, enum value, union literal, and interface field is specified
 * in the Contract & State Matrix (tech-spec/contract-state-matrix.md).
 *
 * §5 Canonical Type Registry — exact type names and ownership.
 * §6 State Machines — exact state enum values.
 * §4 File / Artifact Contracts — Receipt and Manifest shapes.
 */

// ============================================================
// 5. Canonical Type Registry — Basic Identifiers
// ============================================================

/** Canonical Stage identifier. */
export type StageID = string;

/** Canonical Slice identifier. */
export type SliceID = string;

// ============================================================
// 6. State Machines — Stage State
// ============================================================

/**
 * Stage lifecycle states.
 * See §6 Stage State Machine.
 */
export enum StageState {
  UNINITIALIZED = 'UNINITIALIZED',
  PLANNING = 'PLANNING',
  READY = 'READY',
  EXECUTING = 'EXECUTING',
  UNDER_REVIEW = 'UNDER_REVIEW',
  COMPLETED = 'COMPLETED',
}

// ============================================================
// 6. State Machines — Slice State
// ============================================================

/**
 * Slice lifecycle states.
 * See §6 Slice State Machine.
 */
export enum SliceState {
  PLANNED = 'PLANNED',
  IN_PROGRESS = 'IN_PROGRESS',
  READY_FOR_CV = 'READY_FOR_CV',
  CV_IN_PROGRESS = 'CV_IN_PROGRESS',
  CV_PASSED = 'CV_PASSED',
  INTEGRATING = 'INTEGRATING',
  INTEGRATED = 'INTEGRATED',
}

// ============================================================
// 6. State Machines — CV Status
// ============================================================

/**
 * Code Verification lifecycle status.
 * See §6 CV Status.
 */
export enum CVStatus {
  NOT_STARTED = 'NOT_STARTED',
  READY_FOR_CV = 'READY_FOR_CV',
  IN_PROGRESS = 'IN_PROGRESS',
  PASS = 'PASS',
  REPAIR = 'REPAIR',
  PENDING_RECHECK = 'PENDING_RECHECK',
}

// ============================================================
// 5. Canonical Type Registry — NextAction
// ============================================================

/**
 * Canonical next-action type used by the NextActionService
 * and tool responses (proofloop_next, proofloop_status).
 *
 * See §5 Canonical Type Registry.
 */
export type NextAction =
  | 'DISPATCH_WORKER'
  | 'RUN_CV'
  | 'RUN_GATE'
  | 'ADMIT_WORKER_RESULT'
  | 'ADMIT_CV_RESULT'
  | 'ADMIT_SLICE_COMMIT'
  | 'ADMIT_INTEGRATION'
  | 'PREPARE_STAGE_REVIEW'
  | 'FINALIZE_STAGE_REVIEW'
  | 'COMPILE_ACCEPTANCE'
  | 'RUN_E2E'
  | 'INITIALIZE_EVIDENCE'
  | 'VALIDATE'
  | 'ADMIT_SPV_RESULT'
  | 'REPARTITION';

// ============================================================
// 5. Canonical Type Registry — RoleType
// ============================================================

/**
 * Canonical role type used by the process orchestration.
 * See §5 Canonical Type Registry.
 */
export type RoleType =
  | 'brain'
  | 'planner'
  | 'executor'
  | 'worker'
  | 'code-verifier'
  | 'stage-reviewer'
  | 'researcher'
  | 'prototype'
  | 'committer'
  | 'general';

// ============================================================
// 5. Canonical Type Registry — Finding
// ============================================================

/**
 * Structured status finding with a canonical error/warning code,
 * severity level, and human-readable message.
 *
 * Finding codes are enumerated in §7 Error Contracts.
 * Severity is restricted to 'error' | 'warn'.
 */
export interface Finding {
  /** Canonical error/warning code (e.g., "HOST.PROJECT_NOT_TRUSTED"). */
  code: string;
  /** Severity level. */
  severity: 'error' | 'warn';
  /** Human-readable description. */
  message: string;
}

// ============================================================
// 4. File / Artifact Contracts — Receipt
// ============================================================

/**
 * Legacy receipt artifact shape retained only for migration/reference code.
 *
 * @deprecated Use the canonical `Receipt` exported from `contracts.ts`.
 * The canonical type has a 16-value `ReceiptType` union, including the
 * PROJECT_E2E_* receipt types. This legacy shape is not exported by the public
 * kernel index and must not be used for new receipts.
 */
export interface LegacyReceipt {
  /** Schema version (must be 1). */
  version: 1;
  /** Legacy receipt type literal (13-value pre-project-E2E shape). */
  type:
    | 'SLICE_PLAN'
    | 'STAGE_PLAN'
    | 'SPV_PASS'
    | 'TASK_COMPLETE'
    | 'CV_PASS'
    | 'CV_REPAIR'
    | 'SLICE_COMMIT'
    | 'INTEGRATION_PASS'
    | 'GATE_PASS'
    | 'GATE_FAIL'
    | 'GATE_INTERRUPTED'
    | 'STAGE_REVIEW_PASS'
    | 'PROJECT_REVIEW_PASS';
  /** Owning stage identifier. */
  stage_id: string;
  /** Owning slice identifier (optional). */
  slice_id?: string;
  /** ISO 8601 timestamp of creation. */
  timestamp: string;
  /** Content-addressed digest. */
  digest: string;
  /** Previous receipt digest for chain linkage (optional). */
  previous_digest?: string;
  /** Arbitrary payload data. */
  payload: Record<string, unknown>;
  /** Future: content signing (optional). */
  signature?: string;
}

// ============================================================
// 4. File / Artifact Contracts — Manifest
// ============================================================

/**
 * Stage manifest artifact consumed by ReconcileService.
 *
 * See §4 File / Artifact Contracts — `.proofloop/manifests/*.json`.
 */
export interface Manifest {
  /** Stage identifier. */
  stage_id: string;
  /** Ordered list of slice identifiers belonging to this stage. */
  slices: string[];
  /** ISO 8601 timestamp of creation. */
  created_at: string;
  /** Content-addressed digest. */
  digest: string;
  /** Arbitrary metadata (optional). */
  metadata?: Record<string, unknown>;
}

// ============================================================
// 6. State Machines — Project State (not in §5 but required by §6)
// ============================================================

/**
 * Project lifecycle states.
 * See §6 Project State Machine.
 */
export enum ProjectState {
  IN_PROGRESS = 'IN_PROGRESS',
  UNDER_REVIEW = 'UNDER_REVIEW',
  COMPLETED = 'COMPLETED',
  DEFERRED = 'DEFERRED',
}

// ============================================================
// 6. State Machines — Transition Event/Action Types
// ============================================================

/**
 * Stage transition event literals.
 * See §6 Stage State Machine.
 */
export type StageEvent =
  | 'PLAN'
  | 'FINALIZE_PLAN'
  | 'START'
  | 'PROGRESS'
  | 'SUBMIT_FOR_REVIEW'
  | 'REOPEN'
  | 'COMPLETE'
  | 'REPARTITION';

/**
 * Slice transition event literals.
 * See §6 Slice State Machine.
 */
export type SliceEvent =
  | 'START'
  | 'FINISH_TASKS'
  | 'RUN_CV'
  | 'REVISE'
  | 'PASS_CV'
  | 'INTEGRATE'
  | 'FINISH_INTEGRATION';

/**
 * CV transition event literals.
 * See §6 CV Status State Machine.
 */
export type CvEvent =
  | 'MARK_READY'
  | 'START_CV'
  | 'PASS'
  | 'REQUEST_REPAIR'
  | 'FIX'
  | 'RECHECK';

/**
 * Project transition event literals.
 * See §6 Project State Machine.
 */
export type ProjectEvent =
  | 'SUBMIT_FOR_REVIEW'
  | 'REOPEN'
  | 'COMPLETE'
  | 'RESUME';
