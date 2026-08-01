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
export { validateReceipt, validateManifest, validateRuntimeLock, validateFinding, SchemaValidationError, } from '@proofloop/kernel';
export type { ValidatedReceipt, ValidatedManifest, ValidatedRuntimeLock, ValidatedFinding, } from '@proofloop/kernel';
export { RUNTIME_ACTION_ENTITIES } from './state-model';
export type { RuntimeActionEntity, RuntimeAction, ReconciledTaskState, ReconciledSliceState, ReconciledStageState, } from './state-model';
export { reduceRuntimeAction, assertRuntimeAction, RUNTIME_ACTION_EVENTS } from './reducer';
export { deriveStageState, StageStateDerivationError } from './stage-state';
export type { StageReceiptSummary, DeriveStageStateInput } from './stage-state';
export { validateWorkerResultEnvelope, WORKER_STEP_MODES, WORKER_CONTINUATIONS, WORKER_EXECUTIONS, WORKER_RELAY_KINDS, WORKER_OUTCOMES, WORKER_RELAY_TERMINALS, } from './relay-contract';
export type { WorkerStepMode, WorkerContinuation, WorkerExecution, WorkerRelayKind, WorkerOutcome, WorkerTerminal, WorkerDispatchPacket, WorkerRelayStepInput, WorkerRelayDiagnostics, WorkerRelayAttention, WorkerRelayStepResult, WorkerSliceInvalidation, WorkerRelayPort, WorkerResultEnvelope, } from './relay-contract';
export { WorkerStepService } from './worker-step-service';
export type { WorkerStepDispatchInput } from './worker-step-service';
export { RECEIPT_CATEGORIES, RECEIPT_CONTENT_CATEGORIES, RECEIPT_TYPE_CATEGORY, RECEIPT_TYPES_BY_CATEGORY, receiptsRoot, receiptLayout, receiptCategoryDir, planReceiptDir, tasksReceiptDir, cvReceiptDir, committerReceiptDir, integrationReceiptDir, stageGateReceiptDir, reviewReceiptDir, projectReceiptDir, tmpReceiptDir, } from './receipt-layout';
export type { ReceiptCategory, ReceiptContentCategory, ReceiptLayout, } from './receipt-layout';
export { readReceiptCategory, readAllReceiptCategories, compareReceiptsByTimestampDigest, } from './receipt-reader';
export type { ReadReceiptResult, InvalidReceiptFile, MisplacedReceiptFile, ChainBrokenCondition, ReceiptCategoryReadResult, ReadReceiptCategoryOptions, ReadAllReceiptsOptions, ReceiptCategoryResults, } from './receipt-reader';
export { gitSource, parseTaskCheckboxes, parseEvidenceFacts, hasTaskEvidenceWritten, isSliceEvidenceFinalized, defaultTasksMdPath, GitSourceError, } from './git-source';
export type { GitSourceInput, GitSourceResult, GitTaskCheckboxState, GitEvidenceTaskFacts, EvidenceParsedFacts, } from './git-source';
export { manifestSource, defaultManifestPath, canonicalManifestJson, canonicalManifestDigest, manifestFileDigest, ManifestSourceError, } from './manifest-source';
export type { ManifestSourceInput, ManifestSourceResult, } from './manifest-source';
export { deriveNextAction } from './derive-next-action';
export type { DeriveNextActionInput, DerivedNextAction, NextActionExtras, PendingCvResultEnvelope, } from './derive-next-action';
export { NextActionService } from './next-action-service';
export type { NextActionServiceInput, NextActionOutput } from './next-action-service';
export { reconcileStage, compareFindings, sortFindings } from './reconcile';
export type { ReconcileStageInput, ReconcileStageResult, CategoryChainState, } from './reconcile';
export { ADMISSION_REQUEST_TYPES, CV_VERDICTS, REVIEW_VERDICTS, GATE_VERDICTS, GATE_INTERRUPTED_REASONS, assertAdmissionRequest, admissionRequestStageId, admissionRequestSliceId, } from './admission-request';
export type { AdmissionRequestType, CvVerdict, ReviewVerdict, GateVerdict, GateInterruptedReason, WorkerResultAdmissionRequest, CVResultAdmissionRequest, SliceCommitAdmissionRequest, IntegrationAdmissionRequest, StageReviewAdmissionRequest, ProjectReviewAdmissionRequest, StagePlanAdmissionRequest, SpvResultAdmissionRequest, GateResultAdmissionRequest, GateInterruptedAdmissionRequest, AdmissionRequest, } from './admission-request';
export { runAdmitPipeline, defaultReceiptWriter, admitSpvResult, admitGateResult, admitGateInterrupted, } from './admit-pipeline';
export type { ReceiptWriterPort, AdmitPipelineSteps, AdmitPrecheckResult, ReceiptBuild, AdmitPipelineInput, AdmitResult, SpvGateAdmissionDeps, SpvGateReduceFn, } from './admit-pipeline';
export { admitWorkerResult, admitCVResult, admitSliceCommit, admitIntegration, admitStageReview, admitProjectReview, admitStagePlan, } from './admission';
export type { AdmissionDeps, AdmitReduceFn } from './admission';
/** Canonical package name for @proofloop/runtime. */
export declare const RUNTIME_NAME: PackageName;
//# sourceMappingURL=index.d.ts.map