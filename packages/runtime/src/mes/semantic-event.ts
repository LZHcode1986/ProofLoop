/**
 * @proofloop/runtime — MES high-level semantic-event seam.
 *
 * Ownership (tech-spec/contracts.md §2.1.2 / architecture
 * #/entities/mes-operational-transaction-boundary; ADR-026 / E2E-33 /
 * STATIC-41): Brain/Host expresses only WHAT semantic outcome it accepted or
 * authorized, plus the evidence/basis that cannot be derived from current
 * durable state. Durable output schema, fact/ref identities, current-relation
 * resolution, predecessor/generation/Work-lineage/plan-binding derivation,
 * preservation and transaction plumbing belong to the Runtime MES
 * materializer (`mes/materialize.ts`), which composes the existing
 * transaction layer.
 *
 * This module owns exactly two things:
 *
 *   1. the closed machine schema of the Brain-facing semantic event
 *      (`MesSemanticEvent`); and
 *   2. the ONE mechanical semantic-event catalog — the unique machine owner of
 *      `event_kind -> { caller-owned fields, Runtime-derived fields, durable
 *      outputs, reused oracle, rejected caller fields, typed failure codes,
 *      replay identity, canonicalization }`.
 *
 * The catalog is tracked Runtime code plus table-driven tests. It is NOT a
 * second Authority document, NOT a router, and it never chooses route, repair,
 * Replan, next Task, next Stage or next action. Normative semantics stay in
 * `tech-spec/**` and the active Brain/MES Contracts.
 */
import type { MesFactEnvelope, MesFactKind, MesGitBasis } from './types';
import {
  LANE_START_ENTRY,
  LANE_START_EVENT_KIND,
  laneStartHandler,
} from './semantic-event-lane';
import {
  TASK_RESULT_ACCEPT_ENTRY,
  TASK_RESULT_ACCEPT_EVENT_KIND,
  taskResultAcceptHandler,
} from './semantic-event-task-result';
import {
  TASK_START_ENTRY,
  TASK_START_EVENT_KIND,
  taskStartHandler,
} from './semantic-event-task-start';
import {
  CV_RESULT_ENTRY,
  CV_RESULT_EVENT_KIND,
  cvResultHandler,
} from './semantic-event-cv';
import {
  FINDING_DISPOSITION_ENTRY,
  FINDING_DISPOSITION_EVENT_KIND,
  findingDispositionHandler,
} from './semantic-event-finding';
import {
  GIT_CANDIDATE_ENTRY,
  GIT_CANDIDATE_EVENT_KIND,
  gitCandidateHandler,
  GIT_INTEGRATION_ENTRY,
  GIT_INTEGRATION_EVENT_KIND,
  gitIntegrationHandler,
  GIT_CLEANUP_ENTRY,
  GIT_CLEANUP_EVENT_KIND,
  gitCleanupHandler,
} from './semantic-event-git';
import {
  STAGE_REVIEW_ENTRY,
  STAGE_REVIEW_EVENT_KIND,
  stageReviewHandler,
} from './semantic-event-review';
import {
  PROJECT_READY_ENTRY,
  PROJECT_READY_EVENT_KIND,
  projectReadyHandler,
} from './semantic-event-terminal';
import {
  PLANNING_ACCEPTANCE_ENTRY,
  PLANNING_ACCEPTANCE_EVENT_KIND,
  planningAcceptanceHandler,
} from './semantic-event-planning';
import {
  HUMAN_REQUIRED_RESOLUTION_ENTRY,
  HUMAN_REQUIRED_RESOLUTION_EVENT_KIND,
  humanRequiredResolutionHandler,
} from './semantic-event-human-required';

/**
 * Caller payload fields that are NEVER legal in a Brain-facing semantic event,
 * regardless of event family: the low-level durable fact delta itself and the
 * retention/snapshot plumbing it implies (ADR-026 / STATIC-41). A family may
 * declare ADDITIONAL forbidden caller fields; it may never permit these.
 */
export const MES_FORBIDDEN_CALLER_FIELDS: readonly string[] = [
  'facts',
  'fact_id',
  'fact_ids',
  'mes_fact_envelopes',
  'retained_facts',
  'retained',
  'preserved_fact_ids',
  'resulting_fact_ids',
  'snapshot_sha256',
  'snapshot_fact_count',
];

/** Closed top-level keys of a Brain-facing semantic event. */
export const MES_SEMANTIC_EVENT_KEYS: readonly string[] = ['event_kind', 'payload', 'binding'];

/** Closed keys of the semantic-event binding (the NORMAL execution binding). */
export const MES_SEMANTIC_EVENT_BINDING_KEYS: readonly string[] = [
  'execution_mode',
  'authority_refs',
  'git_basis',
];

/** The event-level execution binding: NORMAL only (MES_MAINTENANCE never writes MES). */
export interface MesSemanticEventBinding {
  readonly execution_mode: 'NORMAL';
  readonly authority_refs: readonly string[];
  readonly git_basis?: MesGitBasis;
}

/**
 * One high-level semantic event.
 *
 * `payload` is closed to the selected catalog entry's caller-owned fields; the
 * materializer rejects unknown fields, Runtime-derived identity/relation fields
 * and the global durable-plumbing fields before any state is read.
 */
export interface MesSemanticEvent {
  readonly event_kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly binding: MesSemanticEventBinding;
}

/** Whether a durable output kind is immutable history or a legal in-place update. */
export const MES_SEMANTIC_EVENT_OUTPUT_MUTABILITIES = ['immutable', 'mutable'] as const;
export type MesSemanticEventOutputMutability = (typeof MES_SEMANTIC_EVENT_OUTPUT_MUTABILITIES)[number];

/** One durable output of an event family (a fact kind it is allowed to materialize). */
export interface MesSemanticEventOutput {
  readonly fact_kind: MesFactKind;
  readonly mutability: MesSemanticEventOutputMutability;
}

/**
 * The mechanical catalog entry of one event family. Every field is machine
 * data consumed by the materializer, the adapter and the table-driven tests.
 */
export interface MesSemanticEventCatalogEntry {
  readonly event_kind: string;
  /** Closed caller-owned payload fields (everything else is rejected). */
  readonly caller_fields: readonly string[];
  /** Caller-owned fields that MUST be present. */
  readonly required_caller_fields: readonly string[];
  /** Durable identity/relation fields Runtime derives (never caller-supplied). */
  readonly runtime_derived_fields: readonly string[];
  /** Durable outputs this family is allowed to materialize. */
  readonly durable_outputs: readonly MesSemanticEventOutput[];
  /** Reused Runtime oracles / builders (composition, not re-implementation). */
  readonly reused_oracles: readonly string[];
  /** Additional family-specific caller fields that MUST be rejected. */
  readonly forbidden_caller_fields: readonly string[];
  /** Typed no-write failure codes this family can raise. */
  readonly failure_codes: readonly string[];
  /** Stable semantic source identity used to reconstruct the same durable output on replay. */
  readonly replay_identity: readonly string[];
  /** Deterministic field canonicalization rules applied before materialization. */
  readonly canonicalization: readonly string[];
}

/** The durable fact delta one handler derives from the event + current state. */
export interface MesSemanticEventMaterialization {
  readonly facts: readonly MesFactEnvelope[];
  /** Forwarded to the transaction for new/changed `task` facts (store write-through). */
  readonly acceptedPlanTaskGraph?: unknown;
  /**
   * Optional family-produced non-durable control envelope (e.g. the closed
   * TASK_RESULT_ACK). Brain never supplies raw durableFacts; the handler
   * builds it over the durable facts it derived. Returned verbatim in the
   * narrow materialization result.
   */
  readonly ack?: unknown;
}

/** Read-only context handed to a family handler (the single current-state read). */
export interface MesSemanticEventMaterializationContext {
  readonly current: readonly MesFactEnvelope[];
  /**
   * Canonical project root of the runtime. Families that read the accepted
   * Plan blob at a durable Git basis (lane start) need this to locate the
   * repo; families that never touch Git ignore it.
   */
  readonly root?: string;
}

/**
 * One family handler: derives the durable fact delta from the accepted event and
 * the current root-bound durable state. It must not select route/next action,
 * must not persist anything itself, and must reject an unresolvable current
 * relation as a typed no-write.
 */
export type MesSemanticEventHandler = (
  event: MesSemanticEvent,
  context: MesSemanticEventMaterializationContext,
) => MesSemanticEventMaterialization;

/** The ONE catalog shape: entries and handlers are in 1:1 correspondence. */
export interface MesSemanticEventCatalog {
  readonly entries: ReadonlyMap<string, MesSemanticEventCatalogEntry>;
  readonly handlers: ReadonlyMap<string, MesSemanticEventHandler>;
  readonly eventKinds: readonly string[];
}

/**
 * Build a catalog from entries + handlers, enforcing the mechanical
 * invariants: unique event kinds, a handler for every entry and an entry for
 * every handler, and no caller field that collides with the global
 * durable-plumbing rejection set or the family's own forbidden set.
 */
export function buildMesSemanticEventCatalog(
  entries: readonly MesSemanticEventCatalogEntry[],
  handlers: ReadonlyMap<string, MesSemanticEventHandler>,
): MesSemanticEventCatalog {
  const byKind = new Map<string, MesSemanticEventCatalogEntry>();
  for (const entry of entries) {
    if (typeof entry.event_kind !== 'string' || entry.event_kind.length === 0) {
      throw new Error('semantic-event catalog entry must carry a non-empty event_kind');
    }
    if (byKind.has(entry.event_kind)) {
      throw new Error(`duplicate semantic-event catalog entry: ${entry.event_kind}`);
    }
    if (!handlers.has(entry.event_kind)) {
      throw new Error(`semantic-event catalog entry ${entry.event_kind} has no handler`);
    }
    for (const field of entry.caller_fields) {
      if (MES_FORBIDDEN_CALLER_FIELDS.includes(field) || entry.forbidden_caller_fields.includes(field)) {
        throw new Error(
          `semantic-event catalog entry ${entry.event_kind} declares caller field ${field} which is forbidden`,
        );
      }
    }
    byKind.set(entry.event_kind, entry);
  }
  for (const kind of handlers.keys()) {
    if (!byKind.has(kind)) {
      throw new Error(`semantic-event handler ${kind} has no catalog entry`);
    }
  }
  return { entries: byKind, handlers, eventKinds: [...byKind.keys()] };
}

/**
 * The ONE mechanical semantic-event catalog.
 *
 * Event families are added one bounded remediation commit at a time (each
 * family = one catalog entry + one handler + table-driven deterministic-replay
 * tests). Until a family is registered here, the shared adapter fails closed
 * with a typed `unsupported-event-kind` no-write instead of guessing a durable
 * mapping — the seam exists before the families, never the other way round.
 */
const MES_SEMANTIC_EVENT_CATALOG_ENTRIES: readonly MesSemanticEventCatalogEntry[] = [
  PLANNING_ACCEPTANCE_ENTRY,
  LANE_START_ENTRY,
  TASK_RESULT_ACCEPT_ENTRY,
  TASK_START_ENTRY,
  CV_RESULT_ENTRY,
  FINDING_DISPOSITION_ENTRY,
  GIT_CANDIDATE_ENTRY,
  GIT_INTEGRATION_ENTRY,
  GIT_CLEANUP_ENTRY,
  STAGE_REVIEW_ENTRY,
  PROJECT_READY_ENTRY,
  HUMAN_REQUIRED_RESOLUTION_ENTRY,
];

const MES_SEMANTIC_EVENT_HANDLERS: ReadonlyMap<string, MesSemanticEventHandler> = new Map<
  string,
  MesSemanticEventHandler
>([
  [PLANNING_ACCEPTANCE_EVENT_KIND, planningAcceptanceHandler],
  [LANE_START_EVENT_KIND, laneStartHandler],
  [TASK_RESULT_ACCEPT_EVENT_KIND, taskResultAcceptHandler],
  [TASK_START_EVENT_KIND, taskStartHandler],
  [CV_RESULT_EVENT_KIND, cvResultHandler],
  [FINDING_DISPOSITION_EVENT_KIND, findingDispositionHandler],
  [GIT_CANDIDATE_EVENT_KIND, gitCandidateHandler],
  [GIT_INTEGRATION_EVENT_KIND, gitIntegrationHandler],
  [GIT_CLEANUP_EVENT_KIND, gitCleanupHandler],
  [STAGE_REVIEW_EVENT_KIND, stageReviewHandler],
  [PROJECT_READY_EVENT_KIND, projectReadyHandler],
  [HUMAN_REQUIRED_RESOLUTION_EVENT_KIND, humanRequiredResolutionHandler],
]);

export const MES_SEMANTIC_EVENT_CATALOG: MesSemanticEventCatalog = buildMesSemanticEventCatalog(
  MES_SEMANTIC_EVENT_CATALOG_ENTRIES,
  MES_SEMANTIC_EVENT_HANDLERS,
);
