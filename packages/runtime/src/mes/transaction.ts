/**
 * @proofloop/runtime — MES operational transaction layer (S06-R-A-T01).
 *
 * The ONLY normal durable operational-state mutator (contracts.md §2.1.2 /
 * architecture #/entities/mes-operational-transaction-boundary / acceptance
 * E2E-25 / STATIC-32). Brain/Host submits a BOUNDED semantic event (facts +
 * current binding), never a full snapshot / retention list / caller-assembled
 * `submitted ∪ retained` state; the layer:
 *
 *   1. validates the event shape and binding (NORMAL mode only) — unknown
 *      keys, non-NORMAL execution modes and malformed authority refs fail
 *      closed (the caller can never act as a raw full-snapshot writer);
 *   2. validates every submitted fact envelope (schema fail-closed);
 *   3. reads the current root-bound snapshot through the internal
 *      MesSnapshotStore (an unreadable / corrupt snapshot is never treated
 *      as an empty store — PO-S05-B-04 no-write);
 *   4. materializes the event into the resulting fact set, PRESERVING every
 *      unrelated durable fact ID by default (a partial submission can never
 *      delete durable facts — the Sep-10/12 partial-replace incidents);
 *      a byte-identical replay collapses idempotently, a changed payload
 *      under an immutable durable fact_id (planning / terminal / recovery)
 *      fails closed as a conflict, and a changed payload under a mutable
 *      durable fact_id is a legal in-place update; the same durable fact_id
 *      may never change its fact_kind / git_subkind (semantic identity);
 *   5. resolves binding-critical identity from the current durable relation
 *      (plan_acceptance → durable PLAN_READY PVR by EXACT result_ref,
 *      finding_disposition → unique durable finding, project_ready planned-
 *      set closure + terminal succession) via `resolveTransactionBindingError`
 *      — the call point S06-R-B-T01 deepens in binding.ts; typo / stale /
 *      missing / ambiguous refs are atomic no-write; every SUBMITTED fact
 *      carrying an accepted plan_binding must additionally exact-resolve to
 *      ONE matching durable plan_acceptance relation via
 *      `exactMatchBindingCriticalIdentityError` (contracts §2.1.3 — caller
 *      never copies/assembles canonical identity: missing PA / wrong/old
 *      accepted Plan / missing support / ambiguous relation / typo / old ref /
 *      approximate ref / cross-cycle are all atomic fail-closed no-write);
 *   6. validates the COMPLETE resulting fact set (schema, relation closure,
 *      idempotency, conflict) and persists it ONCE atomically through the
 *      internal MesSnapshotStore (temp + fsync + atomic rename).
 *
 * Any validation / binding / relation / permission / conflict / persistence
 * failure is no-write with the last valid snapshot byte-stable, and there is
 * NEVER an automatic retry (contracts §2.1.2). The result reports only
 * materialized fact/relation refs and Git/basis facts — no next action, no
 * route, no dispatch, no reasoning. MES_MAINTENANCE / PRE_MES_BOOTSTRAP
 * never write MES and are rejected at the event boundary.
 */
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MesSnapshotStore,
  MesSnapshotStoreError,
} from './store';
import { SchemaValidationError, validateMesFactEnvelope } from './validate';
import { isCanonicalAuthorityRef, verifyPlanAcceptanceSupport, exactMatchBindingCriticalIdentityError, verifyPlanAcceptanceSuccessionGraphError } from './binding';
import {
  resolveFindingDispositionRefError,
  verifyProjectReadySupportError,
  verifyProjectReadySuccessionGraphError,
  isDurableAcceptedStageSupport,
  duplicateAcceptedStageSupportError,
} from './terminal';
import {
  IntegrationStateError,
  validateCandidateFact,
  validateCleanupFact,
  validateIntegrationFact,
} from '../execute/integration-state';
import { canonicalStringify } from '../cli/proofloop-common';
import { MES_SCHEMA_VERSION } from './types';
import type { MesFactEnvelope, MesFactKind, MesGitBasis } from './types';

/** Closed transaction failure codes (fail closed, never partial). */
export type MesTransactionErrorCode =
  | 'invalid-event' // event/binding shape invalid (unknown keys, non-NORMAL mode, bad refs)
  | 'invalid-fact' // a submitted fact fails envelope validation
  | 'conflict' // same fact_id, different payload (within event or vs immutable durable fact)
  | 'binding-mismatch' // binding-critical identity resolution failed (typo/stale/missing/ambiguous)
  | 'unreadable' // current snapshot unreadable / corrupt → no-write
  | 'persist-failed' // atomic persist failed
  | 'escape'; // root escapes the trust boundary

/** Bounded transaction error raised on any fail-closed condition. */
export class MesTransactionError extends Error {
  public readonly code: MesTransactionErrorCode;

  constructor(code: MesTransactionErrorCode, message: string) {
    super(message);
    this.name = 'MesTransactionError';
    this.code = code;
  }
}

function txFail(code: MesTransactionErrorCode, message: string): never {
  throw new MesTransactionError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Closed git-basis shape check (head / branch / worktree non-empty). */
function gitBasisShapeError(basis: unknown): string | undefined {
  if (!isRecord(basis)) return 'git_basis must be an object';
  for (const key of ['head', 'branch', 'worktree'] as const) {
    if (typeof basis[key] !== 'string' || (basis[key] as string).length === 0) {
      return `git_basis.${key} must be a non-empty string`;
    }
  }
  return undefined;
}

/**
 * Immutable-durable fact kinds: a changed payload under one of these fact_ids
 * across submissions is a cross-write conflict (mirror of the store's
 * immutable-durable rule: planning / terminal / recovery facts).
 */
function isImmutableDurableKind(kind: MesFactKind): boolean {
  return (
    kind === 'planning_verification_result' ||
    kind === 'plan_acceptance' ||
    kind === 'project_ready' ||
    kind === 'recovery_baseline'
  );
}

function sha256Utf8(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

// ============================================================
// (CONCURRENCY-001) Per-root cross-process transaction lock.
//
// The read→materialize→full-validate→atomic-persist critical section is
// serialized per canonical root so concurrent semantic events' distinct
// deltas are BOTH preserved: the store retention merge only re-adds
// retained-kind facts, so a persist computed from a stale base read would
// silently drop the other writer's work/result/project delta (lost-update).
// The lock is a tmpdir O_EXCL lock file keyed by the canonical root digest
// (NEVER inside .proofloop/mes — the frozen snapshot / quarantine stays
// byte-stable and untouchable). Acquisition is a bounded wait; a stale lock
// (owner process dead or lock older than TX_LOCK_STALE_MS) is broken and
// retried; on timeout the commit fails closed no-write (never auto-retry,
// contracts §2.1.2).
// ============================================================
const TX_LOCK_STALE_MS = 10_000;
const TX_LOCK_RETRY_MS = 10;
const TX_LOCK_MAX_ATTEMPTS = 500; // bounded wait ≈ 5s
const TX_LOCK_PREFIX = 'proofloop-mes-tx-';

function transactionLockPath(root: string): string {
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), `${TX_LOCK_PREFIX}${digest}.lock`);
}

function acquireTransactionLock(root: string): () => void {
  const lockPath = transactionLockPath(root);
  const deadline = Date.now() + TX_LOCK_RETRY_MS * TX_LOCK_MAX_ATTEMPTS;
  for (let attempt = 0; attempt < TX_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n${Date.now()}\n`, 'utf8');
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          /* ignore */
        }
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        txFail('persist-failed', `cannot acquire MES transaction lock: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Stale lock: owner dead or lock older than the stale window.
      let stale = false;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > TX_LOCK_STALE_MS) {
          stale = true;
        } else {
          const pid = Number(fs.readFileSync(lockPath, 'utf8').split('\n')[0]);
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch {
              stale = true;
            }
          }
        }
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          /* ignore */
        }
        continue;
      }
      if (Date.now() >= deadline) {
        txFail('conflict', `cannot acquire MES transaction lock within the bounded wait — another transaction is in flight（契约 §2.1.2：并发写冲突 no-write，无自动 retry）`);
      }
      // Bounded wait before the next attempt (never auto-retry the commit).
      const waitUntil = Date.now() + TX_LOCK_RETRY_MS;
      while (Date.now() < waitUntil) {
        /* spin */
      }
    }
  }
  txFail('conflict', `cannot acquire MES transaction lock within the bounded wait — another transaction is in flight（契约 §2.1.2：并发写冲突 no-write，无自动 retry）`);
}

/** Canonical container digest of a fact set (the exact persisted bytes). */
function canonicalContainer(facts: readonly MesFactEnvelope[]): string {
  return canonicalStringify({ schema_version: MES_SCHEMA_VERSION, facts });
}

/**
 * (S08-A-T01 / PO-S08-A-01) PRE-PERSIST composition of the EXISTING workspace
 * git-fact domain validator (`execute/integration-state.ts`, S03-E-T02): a
 * SUBMITTED `git` fact whose payload the canonical domain validator rejects (a
 * `candidate_ref` that is not the canonical identity of its own scope, a
 * cleanup payload that does not equal the preceding integration apply result,
 * ...) is a typed atomic no-write BEFORE any persist.
 *
 * The rule is never re-implemented here — the transaction layer composes the
 * single existing validator source, so the write boundary and the
 * `projectIntegrationState` read projection cannot disagree about what a
 * canonical git fact is. Retained (non-submitted) git facts are never
 * re-validated: immutable history stays readable and is never silently
 * corrected (contracts §2.1.4). A `git` fact without any execute payload
 * (legacy rehydrate shape) carries no domain payload to validate.
 */
function validateSubmittedGitFactDomains(
  submitted: readonly MesFactEnvelope[],
  resulting: readonly MesFactEnvelope[],
): void {
  for (const fact of submitted) {
    if (fact.fact_kind !== 'git') continue;
    const subkind = fact.git_subkind;
    if (subkind === undefined) continue;
    try {
      if (subkind === 'candidate') {
        validateCandidateFact(fact);
      } else if (subkind === 'integration') {
        validateIntegrationFact(fact);
      } else {
        // A cleanup payload is only meaningful against the EXACT preceding
        // integration fact of the same scope: resolve it from the resulting
        // set (submitted ∪ retained) and require a unique match — never guess
        // between competing integration facts.
        const scopeKey = canonicalStringify(fact.scope ?? null);
        const integrations = resulting.filter(
          (candidate) =>
            candidate.fact_kind === 'git' &&
            candidate.git_subkind === 'integration' &&
            canonicalStringify(candidate.scope ?? null) === scopeKey,
        );
        if (integrations.length !== 1) {
          txFail(
            'invalid-fact',
            `submitted cleanup git fact ${JSON.stringify(fact.fact_id)} requires exactly ONE durable integration git fact for scope ${scopeKey} in the resulting set (found ${integrations.length})（domain validator composition，no-write）`,
          );
        }
        validateCleanupFact(fact, integrations[0]);
      }
    } catch (err) {
      if (err instanceof MesTransactionError) throw err;
      if (err instanceof IntegrationStateError) {
        txFail(
          err.code === 'RESULT_BINDING_MISMATCH' ? 'binding-mismatch' : 'invalid-fact',
          `submitted git fact ${JSON.stringify(fact.fact_id)} is rejected by the canonical git-fact domain validator: ${err.message}（契约 §2.1.2/§2.1.3：domain-invalid git fact atomic no-write，snapshot bytes unchanged）`,
        );
      }
      throw err;
    }
  }
}

/**
 * (S08-A-T01 / PO-S08-A-02) PRE-PERSIST cohort-ambiguity closure.
 *
 * A durable set must never become UNRECOVERABLY ambiguous: if the resulting
 * set (submitted ∪ retained) would carry a SECOND authorizing accepted-stage
 * support for one Stage inside the same (stage, delivery_cycle_id) cohort —
 * including the legacy no-cycle cohort — the write is a typed atomic no-write
 * with the last valid snapshot byte-stable.
 *
 * The verdict comes from the ONE shared rule
 * (`terminal.ts#duplicateAcceptedStageSupportError`), which the read
 * projections use too, so the write boundary and `status` can never disagree
 * about the same cohort (no second/parallel rule).
 */
function assertUnambiguousStageSupportCohorts(facts: readonly MesFactEnvelope[]): void {
  const cohorts = new Set<string | undefined>();
  for (const fact of facts) {
    if (!isDurableAcceptedStageSupport(fact)) continue;
    cohorts.add(fact.plan_binding?.delivery_cycle_id ?? undefined);
  }
  for (const cycle of cohorts) {
    const duplicateError = duplicateAcceptedStageSupportError(facts, cycle);
    if (duplicateError !== undefined) {
      txFail(
        'binding-mismatch',
        `cohort ambiguity admission failed: ${duplicateError}（契约 §2.1.3：同一 (stage, delivery_cycle_id) cohort 内的重复 authorizing accepted-stage support 是 binding-critical 歧义，atomic no-write，snapshot bytes 与 unrelated fact IDs 不变）`,
      );
    }
  }
}
/**
 * Materialize a submitted delta onto a base fact set (CONCURRENCY-001 seam).
 *
 * preserve-by-default: EVERY unrelated durable fact ID in the base is kept (a
 * partial submission never deletes unrelated durable facts); a byte-identical
 * replay collapses idempotently; a changed payload under an immutable durable
 * fact_id (planning / terminal / recovery) fails closed as a conflict; a
 * changed payload under a mutable durable fact_id is a legal in-place update;
 * a changed `fact_kind` / `git_subkind` under the same durable `fact_id` is a
 * semantic-identity conflict (PO-S08-A-03) even for a mutable kind.
 * This is the pure merge used BOTH for the initial materialization and for the
 * current-snapshot conflict re-materialization right before persist — the
 * rebase path that preserves a concurrent delta that landed between the
 * transaction's base read and its atomic persist.
 */
export function materializeTransactionDelta(
  submitted: readonly MesFactEnvelope[],
  base: readonly MesFactEnvelope[],
): { resulting: MesFactEnvelope[]; materialized: string[] } {
  const baseById = new Map<string, MesFactEnvelope>();
  for (const fact of base) baseById.set(fact.fact_id, fact);
  const resulting: MesFactEnvelope[] = [...base];
  const materialized: string[] = [];
  for (const fact of submitted) {
    const prior = baseById.get(fact.fact_id);
    if (prior === undefined) {
      resulting.push(fact);
      materialized.push(fact.fact_id);
      continue;
    }
    if (canonicalStringify(prior) === canonicalStringify(fact)) {
      continue; // byte-identical replay — idempotent collapse, no change
    }
    // (S08-A-T01 / PO-S08-A-03) Semantic identity is (fact_id, fact_kind,
    // git_subkind): a durable fact_id may never be re-pointed at a different
    // fact kind — a cleanup payload may not be hung onto an integration
    // fact_id, and a generic fact may not silently replace a durable Git fact.
    if (
      prior.fact_kind !== fact.fact_kind ||
      (prior.git_subkind ?? undefined) !== (fact.git_subkind ?? undefined)
    ) {
      txFail(
        'conflict',
        `fact_id ${JSON.stringify(fact.fact_id)} is a durable ${prior.fact_kind} fact — its fact_kind / git_subkind may not change across submissions (semantic identity is immutable, no-write)`,
      );
    }
    if (isImmutableDurableKind(fact.fact_kind)) {
      txFail('conflict', `fact_id ${JSON.stringify(fact.fact_id)} is an immutable durable ${fact.fact_kind} fact — a different payload across submissions is no-write (only byte-identical replay is legal)`);
    }
    const idx = resulting.findIndex((f) => f.fact_id === fact.fact_id);
    resulting[idx] = fact; // mutable update in place
    materialized.push(fact.fact_id);
  }
  return { resulting, materialized };
}

/** The event-level binding carried by a semantic event. */
export interface MesTransactionBinding {
  readonly execution_mode: 'NORMAL';
  readonly authority_refs: readonly string[];
  readonly git_basis?: MesGitBasis;
}

/** A bounded semantic event: the facts to materialize + current binding. */
export interface MesSemanticEvent {
  readonly facts: readonly MesFactEnvelope[];
  readonly binding: MesTransactionBinding;
  /** Forwarded for new/changed `task` facts (store durable write-through). */
  readonly acceptedPlanTaskGraph?: unknown;
}

/** Transaction result: only materialized refs + Git/basis facts. */
export interface MesTransactionResult {
  readonly materializedFactIds: readonly string[];
  readonly preservedFactIds: readonly string[];
  readonly resultingFactIds: readonly string[];
  readonly snapshotSha256: string;
  readonly gitBasis?: MesGitBasis;
}

/**
 * Binding-critical identity resolution over a durable fact set (the call
 * point S06-R-B-T01 deepens in binding.ts). Every binding-critical relation
 * is resolved from the set itself — never from insertion order, ref spelling,
 * timestamp, Git recency, status projection or newest-wins:
 *   - plan_acceptance.plan_binding.verification_result_ref must EXACTLY
 *     resolve to a unique durable PLAN_READY PVR (verifyPlanAcceptanceSupport);
 *   - finding_disposition.finding_ref must resolve to a unique durable
 *     finding (resolveFindingDispositionRefError);
 *   - every project_ready must close its planned-set support and the
 *     cycle-bearing terminals must form one acyclic successor chain
 *     (verifyProjectReadySupportError / verifyProjectReadySuccessionGraphError).
 *
 * @returns `undefined` when all binding-critical relations close, or a
 *   fail-closed message (the caller turns it into a typed no-write).
 */
export function resolveTransactionBindingError(
  facts: readonly MesFactEnvelope[],
): string | undefined {
  const pvrByResultRef = new Map<string, MesFactEnvelope>();
  for (const fact of facts) {
    if (fact.fact_kind !== 'planning_verification_result') continue;
    const ref = fact.result_ref;
    if (ref === undefined) continue;
    const prior = pvrByResultRef.get(ref);
    if (prior !== undefined && prior.fact_id !== fact.fact_id) {
      return `ambiguous planning_verification_result anchors for result_ref ${JSON.stringify(ref)}: ${JSON.stringify(prior.fact_id)} and ${JSON.stringify(fact.fact_id)} (exact unique resolution required)`;
    }
    pvrByResultRef.set(ref, fact);
  }
  for (const fact of facts) {
    if (fact.fact_kind !== 'plan_acceptance') continue;
    const binding = fact.plan_binding;
    if (!binding || binding.binding_stage !== 'accepted') {
      return `plan_acceptance ${JSON.stringify(fact.fact_id)} must bind an accepted Plan`;
    }
    const ref = binding.verification_result_ref;
    if (ref === undefined) {
      return `plan_acceptance ${JSON.stringify(fact.fact_id)} requires an accepted-binding verification_result_ref`;
    }
    const err = verifyPlanAcceptanceSupport(fact, pvrByResultRef.get(ref));
    if (err !== undefined) return err;
  }
  for (const fact of facts) {
    if (fact.fact_kind !== 'finding_disposition') continue;
    const err = resolveFindingDispositionRefError(fact, facts);
    if (err !== undefined) return err;
  }
  for (const fact of facts) {
    if (fact.fact_kind !== 'project_ready') continue;
    const err = verifyProjectReadySupportError(fact, facts);
    if (err !== undefined) return err;
  }
  const terminals = facts.filter((f) => f.fact_kind === 'project_ready');
  const terminalSuccessionError = verifyProjectReadySuccessionGraphError(terminals);
  if (terminalSuccessionError !== undefined) return terminalSuccessionError;
  // (S06 post-recovery Authority update) Accepted-Plan generation succession is
  // binding-critical identity too: the unique current accepted generation per
  // (stage, delivery cycle) chain must resolve from the durable relation alone.
  return verifyPlanAcceptanceSuccessionGraphError(facts);
}

/**
 * Root-bound MES operational transaction layer.
 *
 * `root` is canonicalized through the internal `MesSnapshotStore`, so a
 * symlinked or non-canonical root cannot redirect reads/writes outside the
 * trust boundary.
 */
export class MesTransactionLayer {
  private readonly store: MesSnapshotStore;

  constructor(root: string) {
    try {
      this.store = new MesSnapshotStore(root);
    } catch (err) {
      if (err instanceof MesSnapshotStoreError && err.code === 'escape') {
        throw new MesTransactionError('escape', err.message);
      }
      throw err;
    }
  }

  get root(): string {
    return this.store.root;
  }

  /**
   * Materialize a bounded semantic event durably (see module doc for the
   * full order). Any failure is no-write byte-stable with no auto retry.
   */
  commit(event: MesSemanticEvent): MesTransactionResult {
    // 1) Closed event shape: a semantic event carries facts + binding only
    //    (plus the forwarded task graph). Unknown keys — a full snapshot
    //    container, a retention list, a caller-assembled submitted∪retained
    //    state — fail closed (raw full-snapshot writer negative path).
    if (!isRecord(event)) {
      txFail('invalid-event', 'semantic event must be an object (facts + binding)');
    }
    const eventKeys = new Set(Object.keys(event));
    for (const key of eventKeys) {
      if (key !== 'facts' && key !== 'binding' && key !== 'acceptedPlanTaskGraph') {
        txFail('invalid-event', `semantic event carries unknown field ${JSON.stringify(key)} — the caller must not assemble a full snapshot / retention state`);
      }
    }
    if (!Array.isArray(event.facts) || event.facts.length === 0) {
      txFail('invalid-event', 'semantic event facts must be a non-empty array');
    }

    // 2) Binding: NORMAL mode only (PRE_MES_BOOTSTRAP / MES_MAINTENANCE never
    //    write MES), canonical authority refs, optional git basis shape.
    const binding = event.binding;
    if (!isRecord(binding)) {
      txFail('invalid-event', 'semantic event requires a binding record');
    }
    const bindingKeys = new Set(Object.keys(binding));
    for (const key of bindingKeys) {
      if (key !== 'execution_mode' && key !== 'authority_refs' && key !== 'git_basis') {
        txFail('invalid-event', `event binding carries unknown field ${JSON.stringify(key)}`);
      }
    }
    if (binding.execution_mode !== 'NORMAL') {
      txFail('invalid-event', `the MES operational transaction layer is the NORMAL durable mutator — execution_mode must be NORMAL, got ${JSON.stringify(binding.execution_mode)} (PRE_MES_BOOTSTRAP / MES_MAINTENANCE never write MES)`);
    }
    const authorityRefs = binding.authority_refs;
    if (!Array.isArray(authorityRefs) || authorityRefs.length === 0) {
      txFail('invalid-event', 'event binding authority_refs must be a non-empty array');
    }
    for (const ref of authorityRefs) {
      if (!isCanonicalAuthorityRef(ref)) {
        txFail('invalid-event', `event binding authority_refs entry ${JSON.stringify(ref)} is not a canonical authority ref`);
      }
    }
    if (binding.git_basis !== undefined) {
      const basisError = gitBasisShapeError(binding.git_basis);
      if (basisError !== undefined) {
        txFail('invalid-event', `event binding ${basisError}`);
      }
    }

    // 3) Envelope validation of every submitted fact (schema fail-closed).
    const submitted: MesFactEnvelope[] = [];
    const submittedById = new Map<string, MesFactEnvelope>();
    for (const raw of event.facts) {
      let fact: MesFactEnvelope;
      try {
        fact = validateMesFactEnvelope(raw);
      } catch (err) {
        const detail =
          err instanceof SchemaValidationError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        txFail('invalid-fact', `submitted fact fails envelope validation: ${detail}`);
      }
      const seen = submittedById.get(fact.fact_id);
      if (seen !== undefined) {
        if (canonicalStringify(seen) !== canonicalStringify(fact)) {
          txFail('conflict', `semantic event carries fact_id ${JSON.stringify(fact.fact_id)} twice with different payloads (contracts §7 RESULT_INVALID)`);
        }
        continue; // identical duplicate within one event — collapse
      }
      submittedById.set(fact.fact_id, fact);
      submitted.push(fact);
    }

    // 4) (CONCURRENCY-001) Serialize the read→materialize→full-validate→
    //    atomic-persist critical section per canonical root: a persist
    //    computed from a stale base read would silently drop a concurrent
    //    delta (the store retention merge only re-adds retained-kind facts).
    //    Bounded wait; timeout → typed conflict no-write; never auto-retry.
    const releaseTransactionLock = acquireTransactionLock(this.store.root);
    try {
      // 4a) Read the current root-bound snapshot. An unreadable / corrupt
      //     snapshot is NEVER an empty store: the durable retained facts
      //     would be invisible to the merge, so a rewrite would silently
      //     drop them — fail closed no-write (PO-S05-B-04).
      let current: MesFactEnvelope[];
      try {
        current = this.store.read();
      } catch (err) {
        if (err instanceof MesSnapshotStoreError && err.code === 'escape') {
          throw new MesTransactionError('escape', err.message);
        }
        txFail('unreadable', `current MES snapshot is not re-readable (${err instanceof Error ? err.message : String(err)}) — no-write, never treated as an empty store`);
      }

      // 5) Materialize: preserve EVERY unrelated durable fact ID by default;
      //    identical replay collapses; changed immutable payload → conflict;
      //    changed mutable payload → in-place update.
      let { resulting, materialized } = materializeTransactionDelta(submitted, current);

      // 6) Binding-critical identity resolution from the CURRENT durable
      //    relation (resulting set = current ∪ materialized). Typo / stale /
      //    missing / ambiguous refs are atomic no-write.
      const resolveBinding = (): void => {
        const relationError = resolveTransactionBindingError(resulting);
        if (relationError !== undefined) {
          txFail('binding-mismatch', `binding-critical identity resolution failed: ${relationError}（契约 §2.1.3：typo/旧 ref/近似 ref/缺失/歧义 atomic no-write）`);
        }
        // (S06-R-B-T01 EXACT_MATCH_GATE) Every SUBMITTED fact carrying an
        // accepted plan_binding must exact-resolve to ONE matching durable
        // plan_acceptance relation and EXACTLY equal the canonical binding-
        // critical identity resolved from that relation (contracts.md §2.1.3 /
        // E2E-25): missing plan_acceptance, wrong/old accepted Plan, missing
        // support, ambiguous relation, typo / old ref / approximate ref /
        // cross-cycle submitted identities are ALL atomic fail-closed no-write
        // (snapshot bytes and fact identities unchanged). Facts WITHOUT an
        // accepted plan_binding (legacy unbound / candidate-bound facts) carry
        // no binding-critical identity to compare and pass (their own
        // kind/binding rules still apply).
        for (const fact of submitted) {
          const planBinding = fact.plan_binding;
          if (!planBinding || planBinding.binding_stage !== 'accepted') continue;
          const exactMatchError = exactMatchBindingCriticalIdentityError(resulting, fact);
          if (exactMatchError !== undefined) {
            txFail('binding-mismatch', `binding-critical exact-match gate rejected submitted fact ${JSON.stringify(fact.fact_id)}: ${exactMatchError}（契约 §2.1.3：缺失 PA/旧或错误 accepted Plan/缺失 support/歧义/typo/旧 ref/近似 ref/跨 cycle 均 atomic no-write，snapshot bytes unchanged）`);
          }
        }
      };
      // (S08-A-T01) Every pre-persist admission rule is re-evaluated against
      // the resulting set (submitted ∪ retained) at BOTH call points: after
      // the initial materialization and after the CONCURRENCY-001 conflict
      // re-materialization onto a fresh snapshot.
      const validateResultingSet = (): void => {
        validateSubmittedGitFactDomains(submitted, resulting);
        assertUnambiguousStageSupportCohorts(resulting);
        resolveBinding();
      };
      validateResultingSet();

      // 6b) (CONCURRENCY-001) Current-snapshot conflict protection: right
      //     before the atomic persist, RE-READ the CURRENT snapshot. If a
      //     bypass writer (e.g. another process that does not take the
      //     transaction lock) changed it since our base read,
      //     RE-MATERIALIZE the submitted delta onto the FRESH snapshot and
      //     re-validate — the concurrent delta is preserved, never silently
      //     dropped (lost-update impossible through this seam).
      let fresh: MesFactEnvelope[];
      try {
        fresh = this.store.read();
      } catch (err) {
        if (err instanceof MesSnapshotStoreError && err.code === 'escape') {
          throw new MesTransactionError('escape', err.message);
        }
        txFail('unreadable', `current MES snapshot is not re-readable at conflict check (${err instanceof Error ? err.message : String(err)}) — no-write, never treated as an empty store`);
      }
      if (canonicalContainer(fresh) !== canonicalContainer(current)) {
        ({ resulting, materialized } = materializeTransactionDelta(submitted, fresh));
        current = fresh;
        validateResultingSet();
      }

      // 7) Validate the COMPLETE resulting fact set (schema, relation
      //    closure, idempotency, conflict) and persist ONCE atomically
      //    through the internal MesSnapshotStore. Any store failure is
      //    no-write and keeps the last valid snapshot byte-stable; never
      //    auto-retry.
      try {
        this.store.write(
          resulting,
          event.acceptedPlanTaskGraph !== undefined
            ? { acceptedPlanTaskGraph: event.acceptedPlanTaskGraph }
            : undefined,
        );
      } catch (err) {
        if (err instanceof MesSnapshotStoreError) {
          switch (err.code) {
            case 'escape':
              throw new MesTransactionError('escape', err.message);
            case 'corrupt-snapshot':
            case 'unreadable':
              throw new MesTransactionError('unreadable', `MES snapshot is not re-readable at persist (${err.message}) — no-write`);
            case 'invalid-fact':
              throw new MesTransactionError('invalid-fact', `complete resulting fact set failed store validation: ${err.message}`);
            case 'write-failed':
              throw new MesTransactionError('persist-failed', `atomic persist failed: ${err.message}`);
          }
        }
        throw new MesTransactionError('persist-failed', `cannot persist MES snapshot: ${err instanceof Error ? err.message : String(err)}`);
      }

      // 8) Report: materialized / preserved / resulting ids + canonical
      //    container digest (exact persisted bytes) + Git/basis facts.
      const preserved: string[] = [];
      for (const fact of current) {
        if (!materialized.includes(fact.fact_id)) preserved.push(fact.fact_id);
      }
      const container = {
        schema_version: MES_SCHEMA_VERSION,
        facts: resulting,
      };
      return {
        materializedFactIds: materialized,
        preservedFactIds: preserved,
        resultingFactIds: resulting.map((f) => f.fact_id),
        snapshotSha256: sha256Utf8(canonicalStringify(container)),
        gitBasis: binding.git_basis,
      };
    } finally {
      releaseTransactionLock();
    }
  }
}

/** Convenience factory for a root-bound transaction layer. */
export function createMesTransactionLayer(root: string): MesTransactionLayer {
  return new MesTransactionLayer(root);
}
