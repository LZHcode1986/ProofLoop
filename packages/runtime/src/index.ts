/**
 * @proofloop/runtime — Application services (reconcile, reducer, admission).
 *
 * Depends on @proofloop/kernel for domain types and state machines.
 * Re-exports kernel public types and validators so consumers have a single
 * import path.  The validators are the canonical validation seam for all
 * artifact contract payloads (§4 File / Artifact Contracts).
 */

import { type PackageName, KERNEL_NAME } from '@proofloop/kernel';
export { type PackageName, KERNEL_NAME };

// Re-export contract validators — canonical validation seam (§4, §7)
// Downstream consumers should import validation functions through this package.
export {
  validateReceipt,
  validateManifest,
  validateRuntimeLock,
  validateFinding,
  SchemaValidationError,
} from '@proofloop/kernel';

// Re-export validated type aliases for type-safe consumption
export type {
  ValidatedReceipt,
  ValidatedManifest,
  ValidatedRuntimeLock,
  ValidatedFinding,
} from '@proofloop/kernel';

// Normalized state model & closed-set RuntimeAction (PO-S02-A-01)
// Downstream consumers (Reconcile S02-C, NextAction S02-D, Admission S02-E)
// construct states and apply actions only through this entrypoint.
export { RUNTIME_ACTION_ENTITIES } from './state-model';
export type {
  RuntimeActionEntity,
  RuntimeAction,
  ReconciledTaskState,
  ReconciledSliceState,
  ReconciledStageState,
} from './state-model';

// Pure-function reducer & closed-set action validation (PO-S02-A-02/03)
// reduceRuntimeAction: normalized state + RuntimeAction → new state; illegal
// actions throw InvalidTransitionError (entityId/fromState/toState); unknown
// actions are rejected at the schema layer via assertRuntimeAction.
export { reduceRuntimeAction, assertRuntimeAction, RUNTIME_ACTION_EVENTS } from './reducer';

// Deterministic stage state derivation (PO-S02-A-05)
// deriveStageState: slice aggregate facts + stage-boundary receipt presence
// summary → unique kernel StageState; contradictory fact combinations throw
// StageStateDerivationError (canonical §7 code DOMAIN.INVALID_TRANSITION)
// carrying the conflicting facts — never a silent choice.
export { deriveStageState, StageStateDerivationError } from './stage-state';
export type { StageReceiptSummary, DeriveStageStateInput } from './stage-state';

// WorkerRelayPort contract & WorkerResultEnvelope validator (PO-S02-B-01 / PO-S02-B-04)
// The abstract relay seam (AWI-021): runtime executes worker steps ONLY through
// this port; host implementations (S03 pi-subagents) satisfy it without the
// runtime importing anything host-specific (ADR-012 / AWI-024). The envelope
// validator is the fail-closed validation seam reused by Admission (S02-E).
export {
  validateWorkerResultEnvelope,
  WORKER_STEP_MODES,
  WORKER_CONTINUATIONS,
  WORKER_EXECUTIONS,
  WORKER_RELAY_KINDS,
  WORKER_OUTCOMES,
  WORKER_RELAY_TERMINALS,
} from './relay-contract';
export type {
  WorkerStepMode,
  WorkerContinuation,
  WorkerExecution,
  WorkerRelayKind,
  WorkerOutcome,
  WorkerTerminal,
  WorkerDispatchPacket,
  WorkerRelayStepInput,
  WorkerRelayDiagnostics,
  WorkerRelayAttention,
  WorkerRelayStepResult,
  WorkerSliceInvalidation,
  WorkerRelayPort,
  WorkerResultEnvelope,
} from './relay-contract';

// WorkerStepService — the runtime's worker step execution seam (PO-S02-B-02 / PO-S02-B-03)
// The Executor dispatches a worker step ONLY through the injected WorkerRelayPort:
// executeStep builds the protocolVersion-1 WorkerDispatchPacket and calls the port
// exactly once (signal passthrough); invalidateSlice is forwarded verbatim. The
// service imports no host code and never touches relay internals (ADR-012 / AWI-024).
export { WorkerStepService } from './worker-step-service';
export type { WorkerStepDispatchInput } from './worker-step-service';

// Canonical receipt category directory layout policy (PO-S02-C-05)
// Runtime-owned Artifact Path Policy: every persisted receipt lives in one of
// 8 canonical content category directories under `.proofloop/receipts/`
// (plan/tasks/cv/committer/integration/stage-gate/review/project) plus a
// `.tmp/` scratch dir that is never read as receipts. Reconcile (S02-C-T03)
// reads ONLY this layout; kernel ReceiptWriter writes into it.
export {
  RECEIPT_CATEGORIES,
  RECEIPT_CONTENT_CATEGORIES,
  RECEIPT_TYPE_CATEGORY,
  RECEIPT_TYPES_BY_CATEGORY,
  receiptsRoot,
  receiptLayout,
  receiptCategoryDir,
  planReceiptDir,
  tasksReceiptDir,
  cvReceiptDir,
  committerReceiptDir,
  integrationReceiptDir,
  stageGateReceiptDir,
  reviewReceiptDir,
  projectReceiptDir,
  tmpReceiptDir,
} from './receipt-layout';
export type {
  ReceiptCategory,
  ReceiptContentCategory,
  ReceiptLayout,
} from './receipt-layout';

// Receipt reader over the canonical category layout (PO-S02-C-01 reader
// determinism / PO-S02-C-03 chain verification / PO-S02-C-05 misplacement)
export {
  readReceiptCategory,
  readAllReceiptCategories,
  compareReceiptsByTimestampDigest,
} from './receipt-reader';
export type {
  ReadReceiptResult,
  InvalidReceiptFile,
  MisplacedReceiptFile,
  ChainBrokenCondition,
  ReceiptCategoryReadResult,
  ReadReceiptCategoryOptions,
  ReadAllReceiptsOptions,
  ReceiptCategoryResults,
} from './receipt-reader';

// Git source reader (PO-S02-C-01 data-source part / PO-S02-C-02 source-error
// part): git HEAD, tasks.md checkbox facts and evidence-file facts from the
// real work tree of a real git repo. Non-git root / unborn HEAD / missing
// tasks.md → GitSourceError (RUNTIME.SCHEMA_MISMATCH — Git source
// unavailable); a missing evidence file is reported as
// `evidence_file_present: false` with every evidence fact false.
export {
  gitSource,
  parseTaskCheckboxes,
  parseEvidenceFacts,
  hasTaskEvidenceWritten,
  isSliceEvidenceFinalized,
  defaultTasksMdPath,
  GitSourceError,
} from './git-source';
export type {
  GitSourceInput,
  GitSourceResult,
  GitTaskCheckboxState,
  GitEvidenceTaskFacts,
  EvidenceParsedFacts,
} from './git-source';

// Manifest source reader (PO-S02-C-01 data-source part / PO-S02-C-02
// source-error part): reads `.proofloop/manifests/<stage>.json` and validates
// it through the kernel `validateManifest` seam. Missing / parse-failed /
// schema-invalid / stage_id-mismatched manifest → ManifestSourceError
// (DOMAIN.STAGE_NOT_FOUND). The canonical manifest digest helpers
// (canonicalManifestDigest / manifestFileDigest) are the PO-S02-E-07
// manifest lifecycle binding source: sha256 over the canonical (sorted-key)
// JSON of `.proofloop/manifests/<stage>.json`.
export {
  manifestSource,
  defaultManifestPath,
  canonicalManifestJson,
  canonicalManifestDigest,
  manifestFileDigest,
  ManifestSourceError,
} from './manifest-source';
export type {
  ManifestSourceInput,
  ManifestSourceResult,
} from './manifest-source';

// Deterministic next-action derivation (PO-S02-D-01 / PO-S02-D-02 pure-function side)
// deriveNextAction: explicitly ordered S02-D priority table (rows 0–13) over the
// reconciled persisted facts → exactly one canonical NextAction from the 15-value
// closed set + readable action_detail + responsible_role + findings. Optional
// persisted facts (manifest repartition_requested, GATE_PASS/GATE_FAIL receipt
// existence, per-slice evidence-file presence, pending worker/CV result
// envelopes) are accepted as NextActionExtras; plain ReconciledStageState
// (Reconcile output) is a valid input.
export { deriveNextAction } from './derive-next-action';
export type {
  DeriveNextActionInput,
  DerivedNextAction,
  NextActionExtras,
  PendingCvResultEnvelope,
} from './derive-next-action';

// NextActionService — the full Reconcile → Validate → Reduce → Action pipeline
// (PO-S02-D-02 pipeline side / PO-S02-D-04 / PO-S02-D-05, S02-D-T02): composes
// reconcileStage with the pure deriveNextAction priority table and wraps the
// result into the proofloop_next contract shape (action ∈ 15-value closed set,
// non-empty action_detail, responsible_role ∈ RoleType closed set, boolean
// receipt_chain_valid, findings ≤ 20). Every extra fact
// (repartition_requested / gate receipts / evidence-file presence / pending
// worker result envelopes) is a deterministic persisted read; the service is
// stateless, so a fresh instance reconciles from scratch (HP-003 restart
// determinism).
export { NextActionService } from './next-action-service';
export type { NextActionServiceInput, NextActionOutput } from './next-action-service';

// ReconcileService — three-source merge (PO-S02-C-02 finding semantics /
// PO-S02-C-03 chain integrity + fact blocking / PO-S02-C-01 determinism):
// merges the Manifest + Git + Receipts sources into a deterministic normalized
// ReconciledStageState; every source disagreement yields a canonical Finding
// (error-level never guesses; the checked↔evidence mismatch is a recoverable
// warn). `receipt_chain_valid` is false when any scanned category chain is
// broken, and no fact is derived from a broken chain. `sortFindings`/
// `compareFindings` expose the deterministic (code, severity, message) order.
export { reconcileStage, compareFindings, sortFindings } from './reconcile';
export type {
  ReconcileStageInput,
  ReconcileStageResult,
  CategoryChainState,
} from './reconcile';

// Admission contract — 7 AdmissionRequest types + unified admit pipeline
// (PO-S02-E-01 skeleton / S02-E-T01, AWI-006). The 7-member discriminated
// union `AdmissionRequest` binds only kernel canonical types / closed literal
// sets (ReceiptType, Finding, WorkerResultEnvelope, closed verdict sets);
// `assertAdmissionRequest` is the fail-closed schema seam
// (RUNTIME.SCHEMA_MISMATCH). `runAdmitPipeline` is the unified admit
// pipeline (validate → reconcile → reducer precheck → Receipt build →
// kernel writeReceipt via the injected ReceiptWriterPort → post-write chain
// verification → { accepted, receipt_ref, new_state, findings }); per-method
// wiring lands in S02-E-T02..T04 and S03-H-T02 (SPV/GATE kinds). SPV/GATE
// admit kinds (S03) extend the same pipeline through the union's type-level
// extension point; the SLICE_PLAN kind stays reserved for S04 (decision
// record, PO-S03-H-02 — S03 does not create SLICE_PLAN receipts).
export {
  ADMISSION_REQUEST_TYPES,
  CV_VERDICTS,
  REVIEW_VERDICTS,
  GATE_VERDICTS,
  GATE_INTERRUPTED_REASONS,
  assertAdmissionRequest,
  admissionRequestStageId,
  admissionRequestSliceId,
} from './admission-request';
export type {
  AdmissionRequestType,
  CvVerdict,
  ReviewVerdict,
  GateVerdict,
  GateInterruptedReason,
  WorkerResultAdmissionRequest,
  CVResultAdmissionRequest,
  SliceCommitAdmissionRequest,
  IntegrationAdmissionRequest,
  StageReviewAdmissionRequest,
  ProjectReviewAdmissionRequest,
  StagePlanAdmissionRequest,
  SpvResultAdmissionRequest,
  GateResultAdmissionRequest,
  GateInterruptedAdmissionRequest,
  AdmissionRequest,
} from './admission-request';
export {
  runAdmitPipeline,
  defaultReceiptWriter,
  admitSpvResult,
  admitGateResult,
  admitGateInterrupted,
} from './admit-pipeline';
export type {
  ReceiptWriterPort,
  AdmitPipelineSteps,
  AdmitPrecheckResult,
  ReceiptBuild,
  AdmitPipelineInput,
  AdmitResult,
  SpvGateAdmissionDeps,
  SpvGateReduceFn,
} from './admit-pipeline';

// S03 SPV/GATE admit methods (PO-S03-H-02, S03-H-T02): admitSpvResult
// (SPV_PASS receipt → plan/<stage>/, stage derived PLANNING + manifest
// digest binding) and admitGateResult (GATE_PASS/GATE_FAIL receipt →
// stage-gate/<stage>/, git clean + all slices integrated + manifest digest
// binding + HEAD binding) — both wired onto the S02-E-T01 unified pipeline
// (validate → reconcile → precheck → kernel writeReceipt → chain
// verification). SLICE_PLAN receipt creation stays reserved for S04
// (decision record — S03 creates no SLICE_PLAN receipts).

// AdmissionService slice-boundary admit methods (PO-S02-E-02 / PO-S02-E-03,
// S02-E-T02; PO-S02-E-04, S02-E-T03): admitWorkerResult (TASK_COMPLETE
// receipt, per-mode state advance incl. the CV-REPAIR repair/diagnose
// branch), admitCVResult (CV_PASS / CV_REPAIR receipt with the
// cv_dispatched composite + verdict application), admitSliceCommit
// (SLICE_COMMIT receipt, CV_PASSED → INTEGRATING) and admitIntegration
// (INTEGRATION_PASS receipt, INTEGRATING → INTEGRATED). Stage-level admit
// methods (PO-S02-E-05/06/07, S02-E-T04): admitStageReview
// (STAGE_REVIEW_PASS receipt, UNDER_REVIEW → COMPLETED; REPAIR is a legal
// no-Receipt branch returning a warn Finding), admitProjectReview
// (PROJECT_REVIEW_PASS receipt, project dispatch UNDER_REVIEW → COMPLETED /
// IN_PROGRESS) and admitStagePlan (STAGE_PLAN receipt bound to the canonical
// manifest digest, UNINITIALIZED → PLANNING). All wire the S02-E-T01
// unified pipeline; deps carry the reconcile / reduce / writer seams (kernel
// ReceiptWriter by default).
export {
  admitWorkerResult,
  admitCVResult,
  admitSliceCommit,
  admitIntegration,
  admitStageReview,
  admitProjectReview,
  admitStagePlan,
} from './admission';
export type { AdmissionDeps, AdmitReduceFn } from './admission';

/** Canonical package name for @proofloop/runtime. */
export const RUNTIME_NAME: PackageName = '@proofloop/runtime';
