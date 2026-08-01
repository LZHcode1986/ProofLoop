"use strict";
/**
 * @proofloop/runtime — Application services (reconcile, reducer, admission).
 *
 * Depends on @proofloop/kernel for domain types and state machines.
 * Re-exports kernel public types and validators so consumers have a single
 * import path.  The validators are the canonical validation seam for all
 * artifact contract payloads (§4 File / Artifact Contracts).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.canonicalManifestDigest = exports.canonicalManifestJson = exports.defaultManifestPath = exports.manifestSource = exports.GitSourceError = exports.defaultTasksMdPath = exports.isSliceEvidenceFinalized = exports.hasTaskEvidenceWritten = exports.parseEvidenceFacts = exports.parseTaskCheckboxes = exports.gitSource = exports.compareReceiptsByTimestampDigest = exports.readAllReceiptCategories = exports.readReceiptCategory = exports.tmpReceiptDir = exports.projectReceiptDir = exports.reviewReceiptDir = exports.stageGateReceiptDir = exports.integrationReceiptDir = exports.committerReceiptDir = exports.cvReceiptDir = exports.tasksReceiptDir = exports.planReceiptDir = exports.receiptCategoryDir = exports.receiptLayout = exports.receiptsRoot = exports.RECEIPT_TYPES_BY_CATEGORY = exports.RECEIPT_TYPE_CATEGORY = exports.RECEIPT_CONTENT_CATEGORIES = exports.RECEIPT_CATEGORIES = exports.WorkerStepService = exports.WORKER_RELAY_TERMINALS = exports.WORKER_OUTCOMES = exports.WORKER_RELAY_KINDS = exports.WORKER_EXECUTIONS = exports.WORKER_CONTINUATIONS = exports.WORKER_STEP_MODES = exports.validateWorkerResultEnvelope = exports.StageStateDerivationError = exports.deriveStageState = exports.RUNTIME_ACTION_EVENTS = exports.assertRuntimeAction = exports.reduceRuntimeAction = exports.RUNTIME_ACTION_ENTITIES = exports.SchemaValidationError = exports.validateFinding = exports.validateRuntimeLock = exports.validateManifest = exports.validateReceipt = exports.KERNEL_NAME = void 0;
exports.RUNTIME_NAME = exports.admitStagePlan = exports.admitProjectReview = exports.admitStageReview = exports.admitIntegration = exports.admitSliceCommit = exports.admitCVResult = exports.admitWorkerResult = exports.admitGateInterrupted = exports.admitGateResult = exports.admitSpvResult = exports.defaultReceiptWriter = exports.runAdmitPipeline = exports.admissionRequestSliceId = exports.admissionRequestStageId = exports.assertAdmissionRequest = exports.GATE_INTERRUPTED_REASONS = exports.GATE_VERDICTS = exports.REVIEW_VERDICTS = exports.CV_VERDICTS = exports.ADMISSION_REQUEST_TYPES = exports.sortFindings = exports.compareFindings = exports.reconcileStage = exports.NextActionService = exports.deriveNextAction = exports.ManifestSourceError = exports.manifestFileDigest = void 0;
const kernel_1 = require("@proofloop/kernel");
Object.defineProperty(exports, "KERNEL_NAME", { enumerable: true, get: function () { return kernel_1.KERNEL_NAME; } });
// Re-export contract validators — canonical validation seam (§4, §7)
// Downstream consumers should import validation functions through this package.
var kernel_2 = require("@proofloop/kernel");
Object.defineProperty(exports, "validateReceipt", { enumerable: true, get: function () { return kernel_2.validateReceipt; } });
Object.defineProperty(exports, "validateManifest", { enumerable: true, get: function () { return kernel_2.validateManifest; } });
Object.defineProperty(exports, "validateRuntimeLock", { enumerable: true, get: function () { return kernel_2.validateRuntimeLock; } });
Object.defineProperty(exports, "validateFinding", { enumerable: true, get: function () { return kernel_2.validateFinding; } });
Object.defineProperty(exports, "SchemaValidationError", { enumerable: true, get: function () { return kernel_2.SchemaValidationError; } });
// Normalized state model & closed-set RuntimeAction (PO-S02-A-01)
// Downstream consumers (Reconcile S02-C, NextAction S02-D, Admission S02-E)
// construct states and apply actions only through this entrypoint.
var state_model_1 = require("./state-model");
Object.defineProperty(exports, "RUNTIME_ACTION_ENTITIES", { enumerable: true, get: function () { return state_model_1.RUNTIME_ACTION_ENTITIES; } });
// Pure-function reducer & closed-set action validation (PO-S02-A-02/03)
// reduceRuntimeAction: normalized state + RuntimeAction → new state; illegal
// actions throw InvalidTransitionError (entityId/fromState/toState); unknown
// actions are rejected at the schema layer via assertRuntimeAction.
var reducer_1 = require("./reducer");
Object.defineProperty(exports, "reduceRuntimeAction", { enumerable: true, get: function () { return reducer_1.reduceRuntimeAction; } });
Object.defineProperty(exports, "assertRuntimeAction", { enumerable: true, get: function () { return reducer_1.assertRuntimeAction; } });
Object.defineProperty(exports, "RUNTIME_ACTION_EVENTS", { enumerable: true, get: function () { return reducer_1.RUNTIME_ACTION_EVENTS; } });
// Deterministic stage state derivation (PO-S02-A-05)
// deriveStageState: slice aggregate facts + stage-boundary receipt presence
// summary → unique kernel StageState; contradictory fact combinations throw
// StageStateDerivationError (canonical §7 code DOMAIN.INVALID_TRANSITION)
// carrying the conflicting facts — never a silent choice.
var stage_state_1 = require("./stage-state");
Object.defineProperty(exports, "deriveStageState", { enumerable: true, get: function () { return stage_state_1.deriveStageState; } });
Object.defineProperty(exports, "StageStateDerivationError", { enumerable: true, get: function () { return stage_state_1.StageStateDerivationError; } });
// WorkerRelayPort contract & WorkerResultEnvelope validator (PO-S02-B-01 / PO-S02-B-04)
// The abstract relay seam (AWI-021): runtime executes worker steps ONLY through
// this port; host implementations (S03 pi-subagents) satisfy it without the
// runtime importing anything host-specific (ADR-012 / AWI-024). The envelope
// validator is the fail-closed validation seam reused by Admission (S02-E).
var relay_contract_1 = require("./relay-contract");
Object.defineProperty(exports, "validateWorkerResultEnvelope", { enumerable: true, get: function () { return relay_contract_1.validateWorkerResultEnvelope; } });
Object.defineProperty(exports, "WORKER_STEP_MODES", { enumerable: true, get: function () { return relay_contract_1.WORKER_STEP_MODES; } });
Object.defineProperty(exports, "WORKER_CONTINUATIONS", { enumerable: true, get: function () { return relay_contract_1.WORKER_CONTINUATIONS; } });
Object.defineProperty(exports, "WORKER_EXECUTIONS", { enumerable: true, get: function () { return relay_contract_1.WORKER_EXECUTIONS; } });
Object.defineProperty(exports, "WORKER_RELAY_KINDS", { enumerable: true, get: function () { return relay_contract_1.WORKER_RELAY_KINDS; } });
Object.defineProperty(exports, "WORKER_OUTCOMES", { enumerable: true, get: function () { return relay_contract_1.WORKER_OUTCOMES; } });
Object.defineProperty(exports, "WORKER_RELAY_TERMINALS", { enumerable: true, get: function () { return relay_contract_1.WORKER_RELAY_TERMINALS; } });
// WorkerStepService — the runtime's worker step execution seam (PO-S02-B-02 / PO-S02-B-03)
// The Executor dispatches a worker step ONLY through the injected WorkerRelayPort:
// executeStep builds the protocolVersion-1 WorkerDispatchPacket and calls the port
// exactly once (signal passthrough); invalidateSlice is forwarded verbatim. The
// service imports no host code and never touches relay internals (ADR-012 / AWI-024).
var worker_step_service_1 = require("./worker-step-service");
Object.defineProperty(exports, "WorkerStepService", { enumerable: true, get: function () { return worker_step_service_1.WorkerStepService; } });
// Canonical receipt category directory layout policy (PO-S02-C-05)
// Runtime-owned Artifact Path Policy: every persisted receipt lives in one of
// 8 canonical content category directories under `.proofloop/receipts/`
// (plan/tasks/cv/committer/integration/stage-gate/review/project) plus a
// `.tmp/` scratch dir that is never read as receipts. Reconcile (S02-C-T03)
// reads ONLY this layout; kernel ReceiptWriter writes into it.
var receipt_layout_1 = require("./receipt-layout");
Object.defineProperty(exports, "RECEIPT_CATEGORIES", { enumerable: true, get: function () { return receipt_layout_1.RECEIPT_CATEGORIES; } });
Object.defineProperty(exports, "RECEIPT_CONTENT_CATEGORIES", { enumerable: true, get: function () { return receipt_layout_1.RECEIPT_CONTENT_CATEGORIES; } });
Object.defineProperty(exports, "RECEIPT_TYPE_CATEGORY", { enumerable: true, get: function () { return receipt_layout_1.RECEIPT_TYPE_CATEGORY; } });
Object.defineProperty(exports, "RECEIPT_TYPES_BY_CATEGORY", { enumerable: true, get: function () { return receipt_layout_1.RECEIPT_TYPES_BY_CATEGORY; } });
Object.defineProperty(exports, "receiptsRoot", { enumerable: true, get: function () { return receipt_layout_1.receiptsRoot; } });
Object.defineProperty(exports, "receiptLayout", { enumerable: true, get: function () { return receipt_layout_1.receiptLayout; } });
Object.defineProperty(exports, "receiptCategoryDir", { enumerable: true, get: function () { return receipt_layout_1.receiptCategoryDir; } });
Object.defineProperty(exports, "planReceiptDir", { enumerable: true, get: function () { return receipt_layout_1.planReceiptDir; } });
Object.defineProperty(exports, "tasksReceiptDir", { enumerable: true, get: function () { return receipt_layout_1.tasksReceiptDir; } });
Object.defineProperty(exports, "cvReceiptDir", { enumerable: true, get: function () { return receipt_layout_1.cvReceiptDir; } });
Object.defineProperty(exports, "committerReceiptDir", { enumerable: true, get: function () { return receipt_layout_1.committerReceiptDir; } });
Object.defineProperty(exports, "integrationReceiptDir", { enumerable: true, get: function () { return receipt_layout_1.integrationReceiptDir; } });
Object.defineProperty(exports, "stageGateReceiptDir", { enumerable: true, get: function () { return receipt_layout_1.stageGateReceiptDir; } });
Object.defineProperty(exports, "reviewReceiptDir", { enumerable: true, get: function () { return receipt_layout_1.reviewReceiptDir; } });
Object.defineProperty(exports, "projectReceiptDir", { enumerable: true, get: function () { return receipt_layout_1.projectReceiptDir; } });
Object.defineProperty(exports, "tmpReceiptDir", { enumerable: true, get: function () { return receipt_layout_1.tmpReceiptDir; } });
// Receipt reader over the canonical category layout (PO-S02-C-01 reader
// determinism / PO-S02-C-03 chain verification / PO-S02-C-05 misplacement)
var receipt_reader_1 = require("./receipt-reader");
Object.defineProperty(exports, "readReceiptCategory", { enumerable: true, get: function () { return receipt_reader_1.readReceiptCategory; } });
Object.defineProperty(exports, "readAllReceiptCategories", { enumerable: true, get: function () { return receipt_reader_1.readAllReceiptCategories; } });
Object.defineProperty(exports, "compareReceiptsByTimestampDigest", { enumerable: true, get: function () { return receipt_reader_1.compareReceiptsByTimestampDigest; } });
// Git source reader (PO-S02-C-01 data-source part / PO-S02-C-02 source-error
// part): git HEAD, tasks.md checkbox facts and evidence-file facts from the
// real work tree of a real git repo. Non-git root / unborn HEAD / missing
// tasks.md → GitSourceError (RUNTIME.SCHEMA_MISMATCH — Git source
// unavailable); a missing evidence file is reported as
// `evidence_file_present: false` with every evidence fact false.
var git_source_1 = require("./git-source");
Object.defineProperty(exports, "gitSource", { enumerable: true, get: function () { return git_source_1.gitSource; } });
Object.defineProperty(exports, "parseTaskCheckboxes", { enumerable: true, get: function () { return git_source_1.parseTaskCheckboxes; } });
Object.defineProperty(exports, "parseEvidenceFacts", { enumerable: true, get: function () { return git_source_1.parseEvidenceFacts; } });
Object.defineProperty(exports, "hasTaskEvidenceWritten", { enumerable: true, get: function () { return git_source_1.hasTaskEvidenceWritten; } });
Object.defineProperty(exports, "isSliceEvidenceFinalized", { enumerable: true, get: function () { return git_source_1.isSliceEvidenceFinalized; } });
Object.defineProperty(exports, "defaultTasksMdPath", { enumerable: true, get: function () { return git_source_1.defaultTasksMdPath; } });
Object.defineProperty(exports, "GitSourceError", { enumerable: true, get: function () { return git_source_1.GitSourceError; } });
// Manifest source reader (PO-S02-C-01 data-source part / PO-S02-C-02
// source-error part): reads `.proofloop/manifests/<stage>.json` and validates
// it through the kernel `validateManifest` seam. Missing / parse-failed /
// schema-invalid / stage_id-mismatched manifest → ManifestSourceError
// (DOMAIN.STAGE_NOT_FOUND). The canonical manifest digest helpers
// (canonicalManifestDigest / manifestFileDigest) are the PO-S02-E-07
// manifest lifecycle binding source: sha256 over the canonical (sorted-key)
// JSON of `.proofloop/manifests/<stage>.json`.
var manifest_source_1 = require("./manifest-source");
Object.defineProperty(exports, "manifestSource", { enumerable: true, get: function () { return manifest_source_1.manifestSource; } });
Object.defineProperty(exports, "defaultManifestPath", { enumerable: true, get: function () { return manifest_source_1.defaultManifestPath; } });
Object.defineProperty(exports, "canonicalManifestJson", { enumerable: true, get: function () { return manifest_source_1.canonicalManifestJson; } });
Object.defineProperty(exports, "canonicalManifestDigest", { enumerable: true, get: function () { return manifest_source_1.canonicalManifestDigest; } });
Object.defineProperty(exports, "manifestFileDigest", { enumerable: true, get: function () { return manifest_source_1.manifestFileDigest; } });
Object.defineProperty(exports, "ManifestSourceError", { enumerable: true, get: function () { return manifest_source_1.ManifestSourceError; } });
// Deterministic next-action derivation (PO-S02-D-01 / PO-S02-D-02 pure-function side)
// deriveNextAction: explicitly ordered S02-D priority table (rows 0–13) over the
// reconciled persisted facts → exactly one canonical NextAction from the 15-value
// closed set + readable action_detail + responsible_role + findings. Optional
// persisted facts (manifest repartition_requested, GATE_PASS/GATE_FAIL receipt
// existence, per-slice evidence-file presence, pending worker/CV result
// envelopes) are accepted as NextActionExtras; plain ReconciledStageState
// (Reconcile output) is a valid input.
var derive_next_action_1 = require("./derive-next-action");
Object.defineProperty(exports, "deriveNextAction", { enumerable: true, get: function () { return derive_next_action_1.deriveNextAction; } });
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
var next_action_service_1 = require("./next-action-service");
Object.defineProperty(exports, "NextActionService", { enumerable: true, get: function () { return next_action_service_1.NextActionService; } });
// ReconcileService — three-source merge (PO-S02-C-02 finding semantics /
// PO-S02-C-03 chain integrity + fact blocking / PO-S02-C-01 determinism):
// merges the Manifest + Git + Receipts sources into a deterministic normalized
// ReconciledStageState; every source disagreement yields a canonical Finding
// (error-level never guesses; the checked↔evidence mismatch is a recoverable
// warn). `receipt_chain_valid` is false when any scanned category chain is
// broken, and no fact is derived from a broken chain. `sortFindings`/
// `compareFindings` expose the deterministic (code, severity, message) order.
var reconcile_1 = require("./reconcile");
Object.defineProperty(exports, "reconcileStage", { enumerable: true, get: function () { return reconcile_1.reconcileStage; } });
Object.defineProperty(exports, "compareFindings", { enumerable: true, get: function () { return reconcile_1.compareFindings; } });
Object.defineProperty(exports, "sortFindings", { enumerable: true, get: function () { return reconcile_1.sortFindings; } });
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
var admission_request_1 = require("./admission-request");
Object.defineProperty(exports, "ADMISSION_REQUEST_TYPES", { enumerable: true, get: function () { return admission_request_1.ADMISSION_REQUEST_TYPES; } });
Object.defineProperty(exports, "CV_VERDICTS", { enumerable: true, get: function () { return admission_request_1.CV_VERDICTS; } });
Object.defineProperty(exports, "REVIEW_VERDICTS", { enumerable: true, get: function () { return admission_request_1.REVIEW_VERDICTS; } });
Object.defineProperty(exports, "GATE_VERDICTS", { enumerable: true, get: function () { return admission_request_1.GATE_VERDICTS; } });
Object.defineProperty(exports, "GATE_INTERRUPTED_REASONS", { enumerable: true, get: function () { return admission_request_1.GATE_INTERRUPTED_REASONS; } });
Object.defineProperty(exports, "assertAdmissionRequest", { enumerable: true, get: function () { return admission_request_1.assertAdmissionRequest; } });
Object.defineProperty(exports, "admissionRequestStageId", { enumerable: true, get: function () { return admission_request_1.admissionRequestStageId; } });
Object.defineProperty(exports, "admissionRequestSliceId", { enumerable: true, get: function () { return admission_request_1.admissionRequestSliceId; } });
var admit_pipeline_1 = require("./admit-pipeline");
Object.defineProperty(exports, "runAdmitPipeline", { enumerable: true, get: function () { return admit_pipeline_1.runAdmitPipeline; } });
Object.defineProperty(exports, "defaultReceiptWriter", { enumerable: true, get: function () { return admit_pipeline_1.defaultReceiptWriter; } });
Object.defineProperty(exports, "admitSpvResult", { enumerable: true, get: function () { return admit_pipeline_1.admitSpvResult; } });
Object.defineProperty(exports, "admitGateResult", { enumerable: true, get: function () { return admit_pipeline_1.admitGateResult; } });
Object.defineProperty(exports, "admitGateInterrupted", { enumerable: true, get: function () { return admit_pipeline_1.admitGateInterrupted; } });
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
var admission_1 = require("./admission");
Object.defineProperty(exports, "admitWorkerResult", { enumerable: true, get: function () { return admission_1.admitWorkerResult; } });
Object.defineProperty(exports, "admitCVResult", { enumerable: true, get: function () { return admission_1.admitCVResult; } });
Object.defineProperty(exports, "admitSliceCommit", { enumerable: true, get: function () { return admission_1.admitSliceCommit; } });
Object.defineProperty(exports, "admitIntegration", { enumerable: true, get: function () { return admission_1.admitIntegration; } });
Object.defineProperty(exports, "admitStageReview", { enumerable: true, get: function () { return admission_1.admitStageReview; } });
Object.defineProperty(exports, "admitProjectReview", { enumerable: true, get: function () { return admission_1.admitProjectReview; } });
Object.defineProperty(exports, "admitStagePlan", { enumerable: true, get: function () { return admission_1.admitStagePlan; } });
/** Canonical package name for @proofloop/runtime. */
exports.RUNTIME_NAME = '@proofloop/runtime';
//# sourceMappingURL=index.js.map