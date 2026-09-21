/**
 * @proofloop/runtime — MES seam public surface (S01-C-T02).
 *
 * Assembles the S01 MES persistence seam for Runtime consumers: the
 * versioned fact envelope + validation (types/validate), the fact-kind
 * binding (binding), the atomic root-bound snapshot store (store), the
 * one-time bootstrap seed (bootstrap) and the pure status/detail
 * projections (status).
 *
 * Every name is re-exported EXACTLY ONCE with an explicit list (no
 * `export *`) so consumers cannot bypass the fail-closed validators or
 * accidentally shadow a canonical declaration. This seam is NOT a CLI
 * domain and does not add anything to DOMAIN_REGISTRY / CANONICAL_DOMAINS
 * (tech-spec/contracts.md §1.1 / §1.2): `proofloop status` is a top-level
 * read-only observation entry handled by the public dispatcher.
 */
// Schema + fact envelope types — canonical declarations.
export {
  MES_SCHEMA_VERSION,
  MES_FACT_KINDS,
  MES_PLAN_BINDING_STAGES,
  MES_PLAN_VERDICTS,
  MES_CREATED_BY,
  MES_RECOVERY_PREIMAGE_STATUSES,
  MES_SLICE_ID_RE,
  MES_TASK_ID_RE,
  MES_TASK_STATUSES,
  MES_VERIFIER_VERDICTS,
  MES_FINDING_DISPOSITIONS,
  MES_ROUTE_CODES,
  MES_RESUME_TARGETS,
  MES_GIT_SUBKINDS,
} from './types';
export type {
  MesFactKind,
  MesPlanBindingStage,
  MesPlanVerdict,
  MesCreatedBy,
  MesRecoveryPreimageStatus,
  MesScope,
  MesGitBasis,
  MesPlanBinding,
  MesFactEnvelope,
  MesTaskStatus,
  MesVerifierVerdict,
  MesFindingDisposition,
  MesRouteCode,
  MesResumeTarget,
  MesGitSubkind,
} from './types';
// Envelope validator — fail-closed closed-set schema validation.
export { validateMesFactEnvelope, SchemaValidationError, isLegacyS01Result, isExecuteResult } from './validate';

// Fact-kind binding — candidate/accepted Plan binding + work/Git basis.
export {
  MES_EXECUTION_MODES,
  isCanonicalRootRelativeRef,
  isCanonicalAuthorityRef,
  validateMesFactBinding,
  promotePlanReadyToAccepted,
  validateTaskFactGraphBinding,
  acceptedStageSupportShapeError,
  projectReadyClosedGitBasisError,
} from './binding';
export type {
  MesExecutionMode,
  PlanReadyPromotionInput,
  MesFactBindRecord,
} from './binding';

// MES operational transaction layer (S06-R-A-T01) — the ONLY normal durable
// mutator. The raw full-snapshot store (MesSnapshotStore) is internal and
// NOT exposed as a Brain-facing API (STATIC-32 / architecture
// mes-operational-transaction-boundary): callers submit bounded semantic
// events through this seam only; the store stays importable from the
// internal module path for Runtime-internal consumers.
export {
  MesTransactionLayer,
  createMesTransactionLayer,
  MesTransactionError,
  resolveTransactionBindingError,
} from './transaction';
export type {
  MesTransactionErrorCode,
  MesTransactionBinding,
  MesSemanticEvent,
  MesTransactionResult,
} from './transaction';

// One-time bootstrap seed (Brain-supplied first-NORMAL status tuple).
export {
  MES_SEED_REL,
  MES_ANOMALY_COUNTERS,
  MES_STATUS_PHASES,
  MesBootstrapError,
  seedMesBootstrap,
  readMesSeedRecord,
  readMesSnapshotFacts,
  isMesSeeded,
} from './bootstrap';
export type {
  MesAnomalyCounterKey,
  MesStatusPhase,
  MesStatusTuple,
  MesBootstrapSeedInput,
  MesSeedRecord,
  MesBootstrapErrorCode,
} from './bootstrap';

// S04-B terminal / Review relation closure helpers (write-through predicates).
export {
  isDurableAcceptedStageSupport,
  verifyProjectReadySupportError,
  resolveFindingDispositionRefError,
} from './terminal';

// Pure status / bounded detail projections (read-only, no next action).
export {
  MesStatusError,
  projectSparseStatus,
  projectDetailStatus,
  formatSparseStatus,
  formatDetailStatus,
  MES_SLICE_EXECUTE_STATES,
  projectExecuteDetail,
  projectTerminalDetail,
  projectCycleFilteredStatus,
  projectCycleFilteredDetail,
} from './status';
export type {
  MesStatusErrorCode,
  MesSparseStatus,
  MesDetailStatus,
  MesSliceExecuteStateValue,
  MesTaskExecuteState,
  MesSliceExecuteState,
  MesExecuteDetail,
  MesTerminalDetail,
  MesCycleFilteredStatus,
} from './status';