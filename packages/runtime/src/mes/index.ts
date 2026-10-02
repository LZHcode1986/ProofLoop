/**
 * @proofloop/runtime — MES seam public surface (S01-C-T02).
 *
 * Assembles the MES seam public surface for Runtime consumers: the versioned
 * fact envelope + validation (types/validate), the fact-kind binding
 * (binding), the atomic root-bound snapshot store (store), the one-time
 * bootstrap seed (bootstrap), the pure status/detail projections (status) and
 * the NORMAL Brain-facing semantic-event seam (semantic-event / materialize).
 *
 * Every name is re-exported EXACTLY ONCE with an explicit list (no
 * `export *`) so consumers cannot bypass the fail-closed validators or
 * accidentally shadow a canonical declaration. The low-level fact-delta
 * transaction construction API is deliberately absent here (STATIC-41): it
 * stays on the internal module path `mes/transaction`. `proofloop mes
 * materialize` (tech-spec/contracts.md §1.1 / §1.2) is the shared public
 * adapter for this seam; `proofloop status` remains a top-level read-only
 * observation entry handled by the public dispatcher.
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
  MES_RESOLUTION_KINDS,
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
  MesResolutionKind,
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
  verifyWorkLineageGraphError,
  resolveWorkLineageTips,
  isCycleBearingWork,
  workLineageKeyOf,
} from './binding';
export type {
  MesExecutionMode,
  PlanReadyPromotionInput,
  MesFactBindRecord,
} from './binding';

// MES semantic-event materializer — the ONE NORMAL Brain-facing durable
// mutation seam (ADR-026 / E2E-33 / STATIC-41). Brain/Host submit a
// high-level semantic event; the materializer resolves the current durable
// relation and composes the internal fact-delta transaction engine. The
// low-level transaction construction API (`MesTransactionLayer` /
// `createMesTransactionLayer` / the fact-delta input) is deliberately NOT
// re-exported here: it stays importable from the internal module path
// `mes/transaction` for the materializer, Runtime-internal consumers, tests
// and explicit recovery tooling, but it is no longer the normal application
// seam. The raw full-snapshot store stays internal too (STATIC-32).
export {
  MesSemanticEventMaterializer,
  createMesSemanticEventMaterializer,
  MesMaterializationError,
} from './materialize';
export type {
  MesMaterializationErrorCode,
  MesMaterializationResult,
  MesMaterializedRef,
} from './materialize';

// The ONE mechanical semantic-event catalog + the closed Brain-facing event
// schema (the machine mapping owner; no second Authority, no router, no
// next-action source).
export {
  MES_SEMANTIC_EVENT_CATALOG,
  MES_FORBIDDEN_CALLER_FIELDS,
  MES_SEMANTIC_EVENT_KEYS,
  MES_SEMANTIC_EVENT_BINDING_KEYS,
  MES_SEMANTIC_EVENT_OUTPUT_MUTABILITIES,
} from './semantic-event';
export type {
  MesSemanticEvent,
  MesSemanticEventBinding,
  MesSemanticEventCatalog,
  MesSemanticEventCatalogEntry,
  MesSemanticEventHandler,
  MesSemanticEventMaterialization,
  MesSemanticEventMaterializationContext,
  MesSemanticEventOutput,
  MesSemanticEventOutputMutability,
} from './semantic-event';

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

// MES infrastructure initialization (independent of Stage / Map / Plan).
export {
  MES_INIT_REL,
  MES_INITIALIZATION_VERSION,
  readMesInitRecord,
  isMesInitialized,
  initializeMes,
} from './bootstrap';
export type { MesInitRecord } from './bootstrap';

// Authority path presence observation (read-only, deterministic; no MES writes).
export {
  MES_AUTHORITY_PATHS,
  observeAuthorityPaths,
  observeAuthorityPathBuckets,
} from './bootstrap';
export type {
  MesAuthorityPath,
  MesAuthorityPresence,
  MesAuthorityObservation,
} from './bootstrap';

// S04-B terminal / Review relation closure helpers (write-through predicates).
export {
  isDurableAcceptedStageSupport,
  verifyProjectReadySupportError,
  resolveFindingDispositionRefError,
  resolveHumanRequiredResolutionError,
} from './terminal';

// A4 HUMAN_REQUIRED condition oracle (pure projection, no durable open fact).
export {
  resolveHumanRequiredConditions,
  countOpenHumanRequiredFindings,
  isHistoricallyValidHumanRequiredOrigin,
  uniqueFindingClassification,
} from './human-required-oracle';
export type { HumanRequiredOpenCondition } from './human-required-oracle';

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