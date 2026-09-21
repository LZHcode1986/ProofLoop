/**
 * @proofloop/runtime — mechanical primitives for the new MES + Work Packet
 * flow (bootstrap unlock).
 *
 * The legacy business-control stack (Admission / Receipt chain / Manifest
 * credential / Context credential / Primary Next Action / old Gate) was
 * removed together with its owning modules.  This surface exports only the
 * mechanical safety primitives that the new Brain/Skill/Work-Packet flow
 * consumes directly:
 *   - root / path safety (path-guard),
 *   - process execution + platform adaptation (process-runner /
 *     platform-adapter),
 *   - Git source facts + deterministic Git boundary closure (git-source /
 *     git-boundary),
 *   - vNext mechanical seams (stage-id, slice-commit-policy, replan-impact,
 *     protected-paths, errors, root-bound read).
 *
 * The retired Worker result envelope module (relay-contract) was removed
 * wholesale: neither the v1 nor the v2 envelope has a current Host/Skill
 * consumer and it is not replaced.
 */

import { type PackageName, KERNEL_NAME } from '@proofloop/kernel';
export { type PackageName, KERNEL_NAME };

/** Canonical package name for @proofloop/runtime. */
export const RUNTIME_NAME: PackageName = '@proofloop/runtime';

// Root / path safety (B1a / §13.1): canonical project root, component-wise
// symlink protection, root-bound path, openNoFollowRead, TOCTOU-safe read,
// stable relative path.
export {
  isWithinRoot,
  canonicalPathWithinRoot,
  PathEscapeError,
  assertCanonicalWithinRoot,
  openNoFollowRead,
  readRootBoundFile,
  assertFileUnchanged,
  PathReadError,
  type NoFollowOpenResult,
  type ReadRootBoundResult,
} from './path-guard';

// Git source facts (git-source): git root assertion + HEAD read. The
// retired tasks.md checkbox / slice-Evidence parsers and the composite
// slice reconcile reader have no Host/Skill consumer and were removed.
export {
  resolveGitRoot,
  readGitHead,
  GitSourceError,
} from './git-source';

// Deterministic Git boundary closure (git-boundary): mechanical status /
// index / scope / stage / commit / post-commit checks only.  Brain owns
// boundary selection and recovery; no Gate/Review/Manifest/CV-receipt
// prerequisite remains.
export {
  closeGitBoundary,
  BOUNDARY_TYPES,
  GitBoundaryError,
} from './git-boundary';
export type {
  BoundaryCloseRequest,
  BoundaryCloseResult,
  BoundaryType,
} from './git-boundary';

// Deterministic Git Integration transaction (git-integration): the dedicated
// mechanical adapter for `proofloop integration apply` (Integration contract).
// Brain owns the ready/recovery judgment; this seam owns only the Git facts.
export { applyIntegration, IntegrationError } from './git-integration';
export type {
  IntegrationRequest,
  IntegrationResult,
  IntegrationErrorCode,
} from './git-integration';

// Process Runner & platform adaptation (B1a, blueprint §11) — process
// execution seam with zero host deps (Node built-ins only).
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

// vNext mechanical seams (see vnext/index.ts for the module list). The vNext
// index keeps only its own mechanical primitives — the raw replan-impact
// classifier (classifyReplanImpact / ReplanImpactError) is intentionally NOT
// re-exported from it (removed by S03-F-T02): the S03-F-T01 slice-proof
// binding adapter below is the SOLE public classification entry.
export * from './vnext';

// ============================================================
// Execute machinery seams (S03-F-T02 terminal fan-in, unique writer).
//
// Every Execute execution-machinery seam is aggregated here EXACTLY ONCE with
// explicit single-name re-exports (no `export *` added): task-result /
// task-result-ack / successor-barrier / work-packet / plan-task-graph / lane /
// cv-result / finding-disposition / git-worktree / integration-state /
// slice-proof-binding. modlap: each seam contributes its canonical (primary)
// public names — constants, validators, build/gate functions and the closed
// types that flow through the Brain/Skill acceptance barrier. The raw
// engine is not part of this surface.
// ============================================================
export {
  TASK_RESULT_MODES,
  TASK_RESULT_OUTCOMES,
  TaskResultValidationError,
  computeResultPayloadDigest,
  validateWorkerTaskResult,
  type TaskResultMode,
  type TaskResultOutcome,
  type TaskResultSubShape,
  type TaskResultValidationCode,
  type TaskResultFieldError,
  type WorkerTaskResultEnvelope,
  type ValidatedWorkerTaskResult,
} from './execute/task-result';
export {
  TASK_RESULT_ACK_KIND,
  ACK_RESULT_DISPOSITIONS,
  ACK_CONTINUATION_DISPOSITIONS,
  TaskResultAckError,
  buildTaskResultAck,
  type AckResultDisposition,
  type AckContinuationDisposition,
  type TaskResultAckCode,
  type TaskResultAckDecision,
  type TaskResultAckInput,
  type TaskResultAck,
} from './execute/task-result-ack';
export {
  SuccessorBarrierError,
  selectNextReadyTask,
  type SliceTaskOrderEntry,
  type SuccessorBarrierInput,
} from './execute/successor-barrier';
export {
  WORK_PACKET_EXECUTION_MODES,
  WorkPacketValidationError,
  validateSliceWorkPacket,
  validateJitReadSet,
  validateBoundedRepairWorkPacket,
  getWorkPacketShape,
  validateWorkPacket,
  type WorkPacketExecutionMode,
  type WorkPacketValidationCode,
  type WorkPacketFieldError,
  type WorkPacketGitBasis,
  type WorkPacketScope,
  type SliceWorkPacket,
  type JitReadSet,
  type BoundedRepairWorkPacket,
  type WorkPacketShape,
  type ValidatedWorkPacket,
} from './execute/work-packet';
export {
  isAcceptedPlanTaskGraph,
  serializeEdges,
  computeGraphDigest,
  buildAcceptedPlanTaskGraph,
  type PlanGraphEdgeKind,
  type PlanGraphEdge,
  type AcceptedPlanTaskGraph,
} from './execute/plan-task-graph';
export {
  LANE_MILESTONES,
  LANE_TASK_STATUSES,
  TASK_STATUS_TRANSITIONS,
  LaneProgressionError,
  validateLaneWorkFact,
  buildLaneWorkFact,
  validateTaskFact,
  buildTaskFact,
  hasAcceptedDurableResult,
  isLegalTaskTransition,
  assertTaskTransition,
  transitionTaskStatus,
  assertSliceCandidateReady,
  assertExecutionReadyForReview,
  type LaneMilestone,
  type LaneProgressionCode,
  type LaneFieldError,
  type LaneWorkFactInput,
  type TaskCompletionProof,
  type TaskTransitionInput,
  type SliceCandidateInput,
  type ExecutionReadyForReviewInput,
} from './execute/lane';
export {
  CV_VERDICTS,
  CV_REVIEW_RESET_SIGNAL,
  CV_VERIFICATION_TYPES,
  CV_EXECUTION_MODES,
  CV_GATE_STATES,
  validateCvResult,
  gateCvResult,
  isReadyToIntegrate,
  type CvVerdict,
  type CvVerificationType,
  type CvExecutionMode,
  type CvGitBasis,
  type CvResultEnvelope,
  type CvGateState,
} from './execute/cv-result';
export {
  MES_FINDING_DISPOSITION_FIELDS,
  FINDING_DISPOSITION_RESUME_TARGETS,
  validateFindingDisposition,
  buildFindingDisposition,
  effectiveRoute,
  type MesFindingDispositionField,
} from './execute/finding-disposition';
export {
  canonicalWorktreePath,
  listGitWorktrees,
  createGitWorktree,
  removeGitWorktree,
  GitWorktreeError,
  type GitWorktreeRequest,
  type GitWorktreeEntry,
  type GitWorktreeCreateResult,
  type GitWorktreeRemoveResult,
  type GitWorktreeErrorCode,
} from './git-worktree';
export {
  INTEGRATION_STATES,
  IntegrationStateError,
  buildCandidateFact,
  validateCandidateFact,
  buildIntegrationFact,
  validateIntegrationFact,
  buildCleanupFact,
  validateCleanupFact,
  isLegalIntegrationTransition,
  validateIntegrationTransition,
  projectIntegrationState,
  buildIntegrationFailureFinding,
  buildCleanupFailureFinding,
  buildCleanupFailureAnomaly,
  type IntegrationState,
  type IntegrationStateCode,
  type IntegrationStateFieldError,
  type IntegrationStateBinding,
  type IntegrationGitFacts,
  type IntegrationStateFactInput,
  type IntegrationTransitionInput,
  type CleanupFailureAnomaly,
} from './execute/integration-state';
export {
  SliceProofBindingError,
  projectSliceProofSnapshot,
  classifySliceProofImpact,
  type ExecutionBinding,
  type SliceProofExecutionScope,
  type TaskFacts,
  type SliceFacts,
  type SliceProofProjectionInput,
  type SliceProofBindingErrorCode,
  type ClassifySliceProofImpactInput,
} from './execute/slice-proof-binding';
// MES seam (S01-C-T02): versioned fact envelope + validation, fact-kind
// binding, atomic root-bound snapshot store, one-time bootstrap seed and
// the pure status/detail projections. Explicit single-name re-exports only
// (see mes/index.ts) — the seam is importable without bypassing the
// fail-closed validators and adds no CLI domain.
export * from './mes';
// Public proofloop CLI seam base (surviving mechanical dispatcher) and the
// mechanical Git boundary adapter.
export { proofloopCli, runStatusDomain } from './cli/proofloop';
export type { ProofloopCliOptions, StatusCliOptions } from './cli/proofloop';
export { runBoundaryDomain } from './cli/proofloop-boundary';
export { runIntegrationDomain } from './cli/proofloop-integration';
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
  resolveRequestInput,
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
  CliRequestInput,
  CliRequestValidation,
} from './cli/proofloop-common';
