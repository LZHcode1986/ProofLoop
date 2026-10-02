/**
 * @proofloop/runtime — MES semantic-event materializer.
 *
 * Ownership (tech-spec/contracts.md §2.1.2 / architecture
 * #/entities/mes-operational-transaction-boundary; ADR-026 / E2E-33 /
 * STATIC-41). This is the ONE NORMAL Brain-facing durable-mutation seam above
 * the existing transaction layer. For one high-level semantic event it:
 *
 *   1. validates the closed semantic-event input against the mechanical event
 *      catalog (unknown event kind / unknown field / Runtime-derived or
 *      durable-plumbing field / non-NORMAL execution mode all fail closed
 *      BEFORE any state is read);
 *   2. reads the current root-bound durable state ONCE;
 *   3. lets the family handler resolve the current cycle / accepted
 *      generation / Work lineage / source Finding / Git relation and derive the
 *      durable fact delta with the existing builders/validators;
 *   4. validates the derived envelopes and enforces that the family only
 *      materializes the durable outputs its catalog entry owns;
 *   5. invokes the existing `MesTransactionLayer` ONCE for the atomic write
 *      (preserve-by-default, complete-resulting-state validation, idempotency
 *      and conflict semantics all stay in the transaction layer);
 *   6. returns a NARROW materialization result (semantic refs + Git basis) or a
 *      typed no-write failure.
 *
 * It never selects route, repair, Replan, next Task, next Stage or next action;
 * it never retries automatically; the full transaction detail
 * (`preservedFactIds`, resulting set, snapshot SHA) stays inside the
 * transaction result and out of the Brain-facing payload.
 *
 * The materializer is Runtime-internal and reuses the low-level fact-delta
 * transaction API — which is exactly why that API is no longer the normal
 * Brain-facing application seam.
 */
import { MesSnapshotStore, MesSnapshotStoreError } from './store';
import { MesTransactionError, MesTransactionLayer, type MesTransactionBinding } from './transaction';
import { isCanonicalAuthorityRef } from './binding';
import { SchemaValidationError, validateMesFactEnvelope } from './validate';
import {
  MES_FORBIDDEN_CALLER_FIELDS,
  MES_SEMANTIC_EVENT_BINDING_KEYS,
  MES_SEMANTIC_EVENT_CATALOG,
  MES_SEMANTIC_EVENT_KEYS,
  type MesSemanticEvent,
  type MesSemanticEventCatalog,
  type MesSemanticEventCatalogEntry,
  type MesSemanticEventMaterialization,
} from './semantic-event';
import type { MesFactEnvelope, MesFactKind, MesGitBasis } from './types';

// The typed no-write failure vocabulary lives in its own module so the ONE
// mechanical event catalog and the per-family handlers can raise typed
// failures without importing this composing materializer (no module cycle).
import {
  MesMaterializationError,
  materializeFail,
  type MesMaterializationErrorCode,
} from './materialization-error';

export { MesMaterializationError, materializeFail } from './materialization-error';
export type { MesMaterializationErrorCode } from './materialization-error';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One materialized durable ref: enough for the flow to continue, nothing more. */
export interface MesMaterializedRef {
  readonly fact_kind: MesFactKind;
  readonly fact_id: string;
  readonly result_ref?: string;
}

/**
 * Narrow Brain-facing materialization result. Deliberately NOT the transaction
 * result: no preserved/resulting set, no snapshot SHA, and never a route,
 * next action or reasoning.
 */
export interface MesMaterializationResult {
  readonly event_kind: string;
  readonly materialized: readonly MesMaterializedRef[];
  readonly git_basis?: MesGitBasis;
  /**
   * Optional family-produced non-durable control envelope (e.g. the closed
   * TASK_RESULT_ACK). Never route / next action / reasoning; the handler
   * set it in the materialization and it is forwarded verbatim.
   */
  readonly ack?: unknown;
}

export interface MesSemanticEventMaterializerOptions {
  /**
   * Catalog override. Runtime-internal / test-facing only: the production
   * default is the ONE mechanical `MES_SEMANTIC_EVENT_CATALOG`, so a caller can
   * never register a second mapping owner through the public seam.
   */
  readonly catalog?: MesSemanticEventCatalog;
}

/** Root-bound MES semantic-event materializer. */
export class MesSemanticEventMaterializer {
  private readonly store: MesSnapshotStore;
  private readonly transaction: MesTransactionLayer;
  private readonly catalog: MesSemanticEventCatalog;

  constructor(root: string, options?: MesSemanticEventMaterializerOptions) {
    try {
      this.store = new MesSnapshotStore(root);
      this.transaction = new MesTransactionLayer(this.store.root);
    } catch (error) {
      if (error instanceof MesSnapshotStoreError && error.code === 'escape') {
        throw new MesMaterializationError('escape', error.message);
      }
      throw error;
    }
    this.catalog = options?.catalog ?? MES_SEMANTIC_EVENT_CATALOG;
  }

  get root(): string {
    return this.store.root;
  }

  /** Materialize one high-level semantic event durably (see module doc). */
  materialize(event: MesSemanticEvent): MesMaterializationResult {
    const { entry, binding } = this.validateEvent(event);
    const handler = this.catalog.handlers.get(entry.event_kind);
    if (handler === undefined) {
      materializeFail(
        'unsupported-event-kind',
        `semantic event kind ${JSON.stringify(entry.event_kind)} has no materialization handler`,
        entry.event_kind,
      );
    }

    // The ONE current-state read for this operation. The transaction layer
    // re-reads and re-validates against its own base + conflict re-read, so a
    // concurrent writer can never be silently dropped.
    const current = this.readCurrent(entry.event_kind);

    const materialization = handler(event, { current, root: this.store.root });
    const facts = this.validateDerivedFacts(entry, materialization);

    let materializedIds: readonly string[];
    try {
      const transactionResult = this.transaction.commit({
        facts,
        binding,
        ...(materialization.acceptedPlanTaskGraph !== undefined
          ? { acceptedPlanTaskGraph: materialization.acceptedPlanTaskGraph }
          : {}),
      });
      materializedIds = transactionResult.materializedFactIds;
    } catch (error) {
      throw translateTransactionError(error, entry.event_kind);
    }

    const materializedSet = new Set(materializedIds);
    const materialized: MesMaterializedRef[] = facts
      .filter((fact) => materializedSet.has(fact.fact_id))
      .map((fact) => ({
        fact_kind: fact.fact_kind,
        fact_id: fact.fact_id,
        ...(fact.result_ref !== undefined ? { result_ref: fact.result_ref } : {}),
      }));

    return {
      event_kind: entry.event_kind,
      materialized,
      ...(binding.git_basis !== undefined ? { git_basis: binding.git_basis } : {}),
      ...(materialization.ack !== undefined ? { ack: materialization.ack } : {}),
    };
  }

  /**
   * Closed event + binding validation against the mechanical catalog. Runs
   * BEFORE the current-state read: an illegal request never touches MES.
   */
  private validateEvent(event: MesSemanticEvent): {
    readonly entry: MesSemanticEventCatalogEntry;
    readonly binding: MesTransactionBinding;
  } {
    if (!isRecord(event)) {
      materializeFail('invalid-event', 'semantic event must be a closed object');
    }
    for (const key of Object.keys(event)) {
      if (!MES_SEMANTIC_EVENT_KEYS.includes(key)) {
        materializeFail(
          'invalid-event',
          `semantic event carries unknown field ${JSON.stringify(key)} (closed schema: ${MES_SEMANTIC_EVENT_KEYS.join(', ')})`,
        );
      }
    }
    const eventKind = event.event_kind;
    if (typeof eventKind !== 'string' || eventKind.length === 0) {
      materializeFail('invalid-event', 'semantic event requires a non-empty event_kind');
    }
    const entry = this.catalog.entries.get(eventKind);
    if (entry === undefined) {
      materializeFail(
        'unsupported-event-kind',
        `semantic event kind ${JSON.stringify(eventKind)} is not in the mechanical event catalog — the seam fails closed instead of guessing a durable mapping`,
        eventKind,
      );
    }
    if (!isRecord(event.payload)) {
      materializeFail('invalid-event', 'semantic event requires a closed payload object', eventKind);
    }
    this.validatePayload(entry, event.payload);
    const binding = this.validateBinding(event.binding, eventKind);
    return { entry, binding };
  }

  /** Closed caller-owned payload field set; Runtime-derived fields are rejected. */
  private validatePayload(entry: MesSemanticEventCatalogEntry, payload: Record<string, unknown>): void {
    const forbidden = new Set<string>([...MES_FORBIDDEN_CALLER_FIELDS, ...entry.forbidden_caller_fields]);
    for (const key of Object.keys(payload)) {
      if (forbidden.has(key)) {
        materializeFail(
          'invalid-field',
          `semantic event ${entry.event_kind} payload field ${JSON.stringify(key)} is a Runtime-derived / durable-output field and must not be caller-supplied`,
          entry.event_kind,
        );
      }
      if (!entry.caller_fields.includes(key)) {
        materializeFail(
          'invalid-field',
          `semantic event ${entry.event_kind} carries unknown payload field ${JSON.stringify(key)} (closed caller-owned set: ${entry.caller_fields.join(', ')})`,
          entry.event_kind,
        );
      }
    }
    for (const field of entry.required_caller_fields) {
      if (payload[field] === undefined) {
        materializeFail(
          'invalid-field',
          `semantic event ${entry.event_kind} requires caller-owned field ${JSON.stringify(field)}`,
          entry.event_kind,
        );
      }
    }
  }

  /** Closed NORMAL execution binding (MES_MAINTENANCE never writes MES). */
  private validateBinding(binding: unknown, eventKind: string): MesTransactionBinding {
    if (!isRecord(binding)) {
      materializeFail('invalid-event', 'semantic event requires a binding record', eventKind);
    }
    for (const key of Object.keys(binding)) {
      if (!MES_SEMANTIC_EVENT_BINDING_KEYS.includes(key)) {
        materializeFail('invalid-event', `semantic event binding carries unknown field ${JSON.stringify(key)}`, eventKind);
      }
    }
    if (binding.execution_mode !== 'NORMAL') {
      materializeFail(
        'invalid-event',
        `semantic event execution_mode must be NORMAL, got ${JSON.stringify(binding.execution_mode)} (MES_MAINTENANCE never writes MES)`,
        eventKind,
      );
    }
    const authorityRefs = binding.authority_refs;
    if (!Array.isArray(authorityRefs) || authorityRefs.length === 0) {
      materializeFail('invalid-event', 'semantic event binding authority_refs must be a non-empty array', eventKind);
    }
    for (const ref of authorityRefs) {
      if (!isCanonicalAuthorityRef(ref)) {
        materializeFail(
          'invalid-event',
          `semantic event binding authority_refs entry ${JSON.stringify(ref)} is not a canonical authority ref`,
          eventKind,
        );
      }
    }
    if (binding.git_basis !== undefined && !isRecord(binding.git_basis)) {
      materializeFail('invalid-event', 'semantic event binding git_basis must be a closed object', eventKind);
    }
    return {
      execution_mode: 'NORMAL',
      authority_refs: authorityRefs as string[],
      ...(binding.git_basis !== undefined ? { git_basis: binding.git_basis as unknown as MesGitBasis } : {}),
    };
  }

  /** The ONE current-state read; an unreadable snapshot is never an empty store. */
  private readCurrent(eventKind: string): readonly MesFactEnvelope[] {
    try {
      return this.store.read();
    } catch (error) {
      if (error instanceof MesSnapshotStoreError && error.code === 'escape') {
        throw new MesMaterializationError('escape', error.message, eventKind);
      }
      materializeFail(
        'unreadable',
        `current MES snapshot is not re-readable (${error instanceof Error ? error.message : String(error)}) — no-write, never treated as an empty store`,
        eventKind,
      );
    }
  }

  /**
   * Validate the derived envelopes and enforce catalog output ownership: a
   * family may only materialize the durable fact kinds its entry declares.
   */
  private validateDerivedFacts(
    entry: MesSemanticEventCatalogEntry,
    materialization: MesSemanticEventMaterialization,
  ): MesFactEnvelope[] {
    if (!isRecord(materialization) || !Array.isArray(materialization.facts) || materialization.facts.length === 0) {
      materializeFail('invalid-event', `semantic event ${entry.event_kind} produced no durable facts`, entry.event_kind);
    }
    const facts: MesFactEnvelope[] = [];
    for (const raw of materialization.facts) {
      let fact: MesFactEnvelope;
      try {
        fact = validateMesFactEnvelope(raw);
      } catch (error) {
        const detail =
          error instanceof SchemaValidationError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        materializeFail(
          'invalid-derived-fact',
          `semantic event ${entry.event_kind} derived an invalid durable fact: ${detail}`,
          entry.event_kind,
        );
      }
      if (!entry.durable_outputs.some((output) => output.fact_kind === fact.fact_kind)) {
        materializeFail(
          'invalid-derived-fact',
          `semantic event ${entry.event_kind} is not the catalog owner of derived durable output ${fact.fact_kind}`,
          entry.event_kind,
        );
      }
      facts.push(fact);
    }
    return facts;
  }
}

/** Map the low-level transaction failure onto the typed materialization failure. */
function translateTransactionError(error: unknown, eventKind: string): MesMaterializationError {
  if (error instanceof MesMaterializationError) return error;
  if (error instanceof MesTransactionError) {
    const code: MesMaterializationErrorCode =
      error.code === 'invalid-fact'
        ? 'invalid-derived-fact'
        : (error.code as MesMaterializationErrorCode);
    return new MesMaterializationError(code, error.message, eventKind);
  }
  return new MesMaterializationError(
    'persist-failed',
    `MES transaction failed: ${error instanceof Error ? error.message : String(error)}`,
    eventKind,
  );
}

/** Convenience factory for a root-bound semantic-event materializer. */
export function createMesSemanticEventMaterializer(
  root: string,
  options?: MesSemanticEventMaterializerOptions,
): MesSemanticEventMaterializer {
  return new MesSemanticEventMaterializer(root, options);
}
