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
  validateVNextWorkerResultEnvelope,
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
  VNextWorkerResultEnvelope,
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
  runReceiptAdmission,
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
  ReceiptAdmissionInput,
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
// receipt, per-mode state advance incl. the CV-REPAIR repair
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

// Process Runner & platform adaptation (B1a, blueprint §11) — process
// execution seam with zero host deps (Node built-ins only):
//   - runProcess: one-shot spawn → bounded output (stdout ≤ 1 MiB, stderr ≤
//     512 KiB) → timeout (SIGTERM → GRACE_PERIOD_MS → SIGKILL tree kill) →
//     structured ProcessResult; shell executables / shell operators are
//     REJECTED (SpawnValidationError before spawning); optional AbortSignal
//     cancellation (blueprint §10 cancellationSignal) surfaced via
//     `canceled`;
//   - service lifecycle: spawnService (immediate ServiceHandle) /
//     registerService / getRegisteredService / stopService (name | handle,
//     tree kill + registry removal) / stopRegisteredService / cleanupServices
//     (stops all registered services, then clears the registry);
//   - waitForReadiness: readiness-signal primitive over accumulated
//     stdout+stderr with process-exit fast-fail;
//   - platform adaptation re-exported for host adapters / run-gate (B1b):
//     getPlatformInfo / killProcessTree / isProcessAlive / isPortInUse /
//     waitForPortFree / normalizePath / resolvePath / isShellExecutable /
//     containsShellOperator.
export {
  validateSpawnOptions,
  SpawnValidationError,
  runProcess,
  spawnService,
  registerService,
  getRegisteredService,
  stopService,
  stopRegisteredService,
  waitForReadiness,
  cleanupServices,
  cleanupProcesses,
  checkPortsFree,
  MAX_STDOUT_BYTES,
  MAX_STDERR_BYTES,
  GRACE_PERIOD_MS,
  DEFAULT_TIMEOUT_MS,
} from './process-runner';
export type {
  ProcessResult,
  SpawnOptions,
  SpawnValidation,
  ServiceHandle,
  ReadinessResult,
  ServiceCleanupResult,
  CleanupResult,
  StopServicePlatform,
} from './process-runner';
export {
  getPlatformInfo,
  killProcessTree,
  isProcessAlive,
  normalizePath,
  resolvePath,
  isShellExecutable,
  containsShellOperator,
  isPortInUse,
  waitForPortFree,
} from './platform-adapter';
export type { Platform, PlatformInfo } from './platform-adapter';

// Project Acceptance pipeline (B1c, blueprint §6.4 proofloop_project) — the
// project-level acceptance ported onto the new runtime with zero host deps:
//   - compileProjectAcceptance: COMPILE_ACCEPTANCE — build the
//     ProjectAcceptanceManifest from plain input JSON (git-based expected
//     snapshot + canonical manifest digest) and write it to the output path
//     (invalid manifests are never emitted);
//   - runProjectAcceptanceE2E: RUN_E2E — validate the manifest, execute the
//     e2e_steps through the B1a Process Runner (command/probe oracles,
//     service lifecycle, mandatory cleanup), derive the verdict (PASS/FAIL;
//     BLOCKED reserved by the schema) and persist the Project E2E Gate
//     Receipt (PROJECT_E2E_PASS / FAIL / BLOCKED) via kernel writeReceipt
//     into the canonical `project/` category;
//   - finalizeProjectReview: FINALIZE_PROJECT_REVIEW — cross-validate
//     Manifest + E2E gate + Reviewer result (chain consistency, per-stage
//     triple-binding, criteria one-to-one coverage) and persist the final
//     PROJECT_REVIEW_PASS receipt chained to the E2E gate receipt.
// All schemas are local pure-TypeScript validators (legacy zod behavior
// authority, .agents/runtime/src/schemas.ts); all receipts go through the
// kernel ReceiptWriter — no hand-written JSON.
export {
  compileProjectAcceptance,
  runProjectAcceptanceE2E,
  finalizeProjectReview,
  computeSnapshot,
  computeCanonicalJsonDigest,
  fileDigest16,
  validateE2ETopology,
  parseProjectAcceptanceManifest,
  parseProjectE2EReceipt,
  parseProjectReviewResult,
  PROJECT_E2E_TYPE_BY_VERDICT,
  PROJECT_E2E_TYPES,
  ProjectAcceptanceSchemaError,
} from './project-acceptance';
// vNext Runtime seam (S0-A bootstrap, task 2) — consumed by Planner /
// Executor to consume the kernel vNext contract surface.
//   - resolveVNextReference: READ-ONLY stable entity marker resolver
//     (root-bound, TOCTOU-safe; explicit `<!-- proofloop:entity -->` markers
//     only; JSON supports only explicit `entities` maps; no fuzzy search).
//   - compileVNextManifest: structured vNext input → kernel-validated vNext
//     Manifest (plan_digest + reference_index + Proof Index binding);
//     pure / read-only, never infers from arbitrary Markdown.
//   - writeVNextManifest: compile + FULL validate, then atomic write.
//   - kernel vNext validators re-exported for a single import path;
//     old v1 validators above remain unchanged and are never used to
//     interpret vNext artifacts.
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
  compileVNextManifest,
  writeVNextManifest,
  VNextCompileError,
  validateVNextPlan,
  validateVNextManifest,
  validateVNextReferenceDescriptor,
  validateVNextReferenceIndex,
  validateVNextProofIndex,
  VNEXT_SCHEMA_VERSION,
  VNEXT_REFERENCE_KINDS,
  VNEXT_PLAN_KINDS,
  VNEXT_REF_GRAMMAR_RE,
  projectVNextWorkerDispatch,
  assertVNextManifestReferenceBindings,
  readVNextManifest,
  VNextHandoffError,
  computeVNextSpvPassReceiptDigest,
  computeVNextStagePlanReceiptDigest,
  VNextNextActionService,
  detectVNextManifestDiscriminator,
  admitVNextStagePlan,
  validateVNextStagePlanAdmissionRequest,
  VNextStagePlanAdmissionError,
  readVNextAdmissionAuthority,
  persistVNextWorkerContext,
  admitVNextWorkerResult,
  validateVNextCvResultEnvelope,
  validateVNextCVResultEnvelope,
  validateVNextCvResult,
  validateVNextCVResult,
  admitVNextCVResult,
  admitVNextCvResult,
  validateVNextSliceCommitRequest,
  admitVNextSliceCommit,
  admitVNextIntegration,
  admitVNextIntegrationResult,
  validateVNextIntegrationRequest,
  admitVNextGateResult,
  admitVNextGate,
  validateVNextGateResultRequest,
  admitVNextStageReview,
  assembleVNextStageReviewRequest,
  validateVNextStageReviewRequest,
  VNEXT_CV_SCHEMA_VERSION,
  VNEXT_CV_RESULT_TYPE,
  VNEXT_CV_VERIFICATION_TYPES,
  VNEXT_CV_VERDICTS,
  VNEXT_CV_RISK_APPLICABILITIES,
  VNEXT_INTEGRATION_SCHEMA_VERSION,
  VNEXT_INTEGRATION_RESULT_TYPE,
  VNEXT_INTEGRATION_ACTION,
  VNEXT_GATE_SCHEMA_VERSION,
  VNEXT_GATE_RESULT_TYPE,
  VNEXT_GATE_ACTION,
  VNEXT_GATE_VERDICTS,
  VNEXT_REVIEW_SCHEMA_VERSION,
  VNEXT_REVIEW_RESULT_TYPE,
  VNEXT_REVIEW_ACTION,
  VNEXT_REVIEW_VERDICTS,
  validateVNextStageCloseRequest,
  admitVNextStageClose,
  // S09-C-T03 — shared canonical Stage ID guard (^S\d+$; legacy S08B0/S08B
  // labels fail closed before any Runtime read/write).
  CANONICAL_STAGE_ID_RE,
  isCanonicalStageId,
  assertCanonicalStageId,
  VNextStageIdError,
} from './vnext';
export type {
  EntityDigestBinding,
  ParsedEntityRef,
  MarkedEntity,
  ResolvedEntity,
  ResolveEntityOptions,
  ReadRootBoundResult,
  CompileVNextManifestInput,
  CompileVNextManifestResult,
  VNextManifestWriteOps,
  VNextReferenceSeed,
  VNextSliceSeed,
  VNextSchemaVersion,
  VNextReferenceKind,
  VNextReferenceDescriptor,
  VNextReferenceIndex,
  VNextRiskBinding,
  VNextProofIndex,
  VNextPlanKind,
  VNextPlanNode,
  VNextCanonicalPlan,
  VNextPlanProjection,
  VNextRuntimeProofSection,
  VNextManifestSlice,
  VNextManifest,
  VNextSpvPassReceipt,
  VNextStagePlanReceipt,
  VNextAdmissionAuthority,
  VNextWorkerContext,
  VNextWorkerDispatch,
  ProjectVNextWorkerDispatchInput,
  VNextWorkerAdmissionDependencies,
  VNextWorkerAdmissionState,
  VNextCvAdmissionDependencies,
  VNextCVAdmissionDependencies,
  VNextCvAdmissionState,
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
  VNextIntegrationAdmissionDependencies,
  VNextIntegrationSchemaVersion,
  VNextIntegrationResultType,
  VNextIntegrationAction,
  VNextIntegrationAdmissionState,
  VNextIntegrationResult,
  VNextGateAdmissionDependencies,
  VNextGateResultAdmissionRequest,
  VNextGateSchemaVersion,
  VNextGateResultType,
  VNextGateAction,
  VNextGateVerdict,
  VNextGateSliceIntegration,
  VNextGateAdmissionState,
  VNextGateResult,
  VNextReviewAdmissionDependencies,
  VNextStageReviewAdmissionRequest,
  VNextReviewSchemaVersion,
  VNextReviewResultType,
  VNextReviewAction,
  VNextReviewVerdict,
  VNextReviewAdmissionState,
  VNextReviewResult,
  VNextNextActionInput,
  VNextNextActionOutput,
  VNextStagePlanAdmissionRequest,
  VNextStagePlanAdmissionSuccess,
  VNextStagePlanAdmissionFailure,
  VNextStagePlanAdmissionResult,
} from './vnext';

export type {
  SchemaIssue,
  RuntimeProofStep,
  StageReceiptEntry,
  ProjectAcceptanceManifest,
  E2EStepResult,
  ServiceCleanupResultShape,
  ProjectE2EReceipt,
  ProjectReviewResult,
  ProjectReviewReceipt,
  TopologyError,
  CompileProjectAcceptanceInput,
  CompileProjectAcceptanceResult,
  RunProjectAcceptanceE2EOptions,
  RunProjectAcceptanceE2EResult,
  FinalizeProjectReviewInput,
  FinalizeProjectReviewResult,
} from './project-acceptance';

// vNext plan handoff services.  These are additive to the legacy v1
// compile/validate/initialize seams above: explicit candidate input is adapted
// structurally, vNext validation preserves schema_version 2, and no service
// below performs SPV/admission/Receipt or Stage execution work.
export {
  adaptCandidateInputToCompileVNextManifestInput,
  candidateInputToCompileVNextManifestInput,
  isActiveCandidateInput,
  readActiveCandidateInput,
} from './vnext/candidate-input';
export type {
  ActiveCandidateInput,
  ActiveCandidateReference,
  ActiveCandidateRiskBinding,
  ActiveCandidateProofIndex,
  ActiveCandidateTask,
  ActiveCandidateSlice,
  CandidateInputErrorCode,
} from './vnext/candidate-input';
export { CandidateInputError } from './vnext/candidate-input';
export {
  detectPlanManifestRoute,
  compileVNextPlan,
  compileVNextPlanFromCandidate,
  validateVNextPlanStage,
  initializeVNextPlanEvidence,
} from './plan-services';
export type {
  PlanManifestRoute,
  CompileVNextPlanInput,
  CompileVNextPlanResult,
} from './plan-services';
export { validateVNextStage } from './cli/validate-vnext-stage';
export type { ValidateVNextStageResult } from './cli/validate-vnext-stage';
export { initializeVNextSliceEvidence } from './cli/initialize-vnext-slice-evidence';
export type { InitializeVNextSliceEvidenceResult } from './cli/initialize-vnext-slice-evidence';
export type { VNextCliError } from './cli/vnext-cli-support-vnext';
// S13-S17 remediation Phase 4 (§9.6): read-only Stage Composition Closure
// Audit — mechanically derivable chain proof callable by SPV before admission.
export {
  auditVNextStageComposition,
  auditRouteTableWiring,
  auditVersionClosure,
  VNEXT_COMPOSITION_BINDING_MODES,
  VNEXT_COMPOSITION_CLOSURES,
  VNEXT_SLICE_CREDENTIAL_CONTRACTS,
  VNEXT_STAGE_TAIL_CREDENTIAL_CONTRACTS,
} from './vnext/stage-composition-audit';
export {
  VNEXT_ROUTE_TABLE,
} from './cli/vnext-route-table';
export type {
  VNextRouteTableEntry,
} from './cli/vnext-route-table';
export {
  stageTailSchemaMismatch,
  VNEXT_STAGE_TAIL_PAYLOAD_SCHEMA_VERSIONS,
} from './vnext/types';
export type {
  VNextCredentialConsumerContract,
} from './vnext/stage-composition-audit';
export type {
  VNextCompositionBindingMode,
  VNextCompositionClosure,
  VNextCompositionChainStep,
  VNextCompositionGapFinding,
  VNextSliceCompositionAudit,
  VNextStageCompositionAuditResult,
} from './vnext/stage-composition-audit';

// S10-A-T01 — public proofloop CLI seam base: closed domain/operation
// registry、canonical JSON envelope、exit contract 与 canonical trust root
// assertion。CLI 不 import harness SDK；后续 Slice 通过同一 closed registry
// 注册各域 handler（T02 注册 doctor，S10-B..E 注册 authority/plan/...）。
export {
  CANONICAL_DOMAINS,
  DOMAIN_REGISTRY,
  CLI_EXIT,
  PROOFLOOP_CLI_SCHEMA_VERSION,
  PROOFLOOP_RUNTIME_VERSION,
  PROOFLOOP_ROOT_ENV,
  resolveTrustRoot,
  TrustRootError,
  isCanonicalDomain,
  isCanonicalOperation,
  okEnvelope,
  errorEnvelope,
  emitEnvelope,
  parseCliArgs,
} from './cli/proofloop-common';
export type {
  CanonicalDomain,
  DomainRegistryEntry,
  CliCommand,
  CliFinding,
  CliRef,
  CliEnvelope,
  TrustRootResolution,
  ParsedCliArgs,
} from './cli/proofloop-common';
export { VNEXT_WORKER_COMPLETION_MODES, VNEXT_NEXT_ACTIONS } from './vnext';
export type { VNextWorkerCompletionMode, VNextNextAction } from './vnext';
export { proofloopCli } from './cli/proofloop';
export type { ProofloopCliOptions } from './cli/proofloop';
export { runBoundaryDomain } from './cli/proofloop-boundary';
export { closeGitBoundary, BOUNDARY_TYPES, GitBoundaryError } from './git-boundary';
export type { BoundaryCloseRequest, BoundaryCloseResult, BoundaryType } from './git-boundary';
// S13-S17 remediation §7.3: the public next CLI route seam is part of the
// Runtime public surface so consumers and tests share one import path.
export { nextActionFromInput, nextActionCli } from './cli/next-action';
export {
  admitVNextSpvPass,
} from './cli/admit-vnext-stage-plan';
