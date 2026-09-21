/**
 * @proofloop/runtime — MES invalid immutable history oracle (S06-R-C-T01).
 *
 * Read-only classification seam for durable, immutable, readable, auditable
 * facts whose binding-critical identity is relation-invalid (contracts.md
 * §2.1.4 / architecture.md #/entities/mes-invalid-history-oracle, acceptance
 * E2E-24 / E2E-25 / STATIC-32).
 *
 * Semantics (single fact source of truth = the same canonical relation
 * machinery the transaction layer already uses — binding.ts is consumed
 * READ-ONLY here, never modified):
 *
 *   - A fact with an accepted plan_binding is `relation-invalid` when the
 *     canonical relation for its accepted_plan_ref RESOLVES uniquely from
 *     the durable set AND the fact's own binding-critical identity deviates
 *     from that canonical relation (typo / old ref / approximate ref /
 *     cross-cycle / wrong digest). The 7 retained S06-D facts of the
 *     Sep-13 binding-mismatch-001 incident are exactly this class: the
 *     canonical S06 PVR/PA relation exists (`mes:result:S06:planning-
 *     verification-1`) while the facts carry the typo
 *     (`mes:result:S06:planning-verification:1`).
 *   - A fact whose canonical relation CANNOT be uniquely resolved from the
 *     set (no plan_acceptance, ambiguous dual plan_acceptance, missing PVR
 *     support) is `relation-unverifiable` — readable/auditable fail-closed
 *     history, distinct from the incident's misbound set and never counted
 *     as `relation-invalid`.
 *   - A fact with a candidate binding or no plan_binding is
 *     `not-binding-critical` (its own kind rules apply elsewhere).
 *   - A fact whose identity exactly matches the resolved canonical relation
 *     is `relation-valid`.
 *
 * The classification is a PURE function of the fact set: restart/rehydrate
 * of the same durable bytes yields the identical classification, and the
 * result never depends on insertion order, ref spelling, timestamps, Git
 * recency, newest-wins or a second pointer/store. This seam NEVER mutates
 * facts and offers NO delete/rewrite/silent-correct/backfill path — the
 * retained misbound history stays byte-stable and non-authorizing.
 */
import type { MesFactEnvelope, MesFactKind } from './types';
import { MES_FACT_KINDS } from './types';
import { resolveCanonicalAcceptanceRelation, resolvePlanAcceptanceGenerationTips, isCycleBearingPlanAcceptanceGeneration } from './binding';
/** Closed relation-validity status of one durable fact. */
export type MesRelationValidity =
  | 'relation-valid'
  | 'relation-invalid'
  | 'relation-unverifiable'
  | 'not-binding-critical';

/** Per-fact classification entry (deterministic order by fact_id). */
export interface MesInvalidHistoryFact {
  readonly fact_id: string;
  readonly fact_kind: MesFactKind;
  readonly status: MesRelationValidity;
  /** Non-empty fail-closed reason for relation-invalid / relation-unverifiable. */
  readonly reason?: string;
}

/** Set-level invalid immutable history classification. */
export interface MesInvalidHistoryClassification {
  /** Every classified fact, ascending by fact_id (stable across restart). */
  readonly facts: readonly MesInvalidHistoryFact[];
  /** Ascending fact_ids classified relation-invalid (the misbound set). */
  readonly invalidFactIds: readonly string[];
  /** Ascending fact_ids classified relation-unverifiable. */
  readonly unverifiableFactIds: readonly string[];
  /**
   * Ascending fact_ids bound to a NON-CURRENT (superseded) accepted-Plan
   * generation of their own (stage, cycle) — a subset of `invalidFactIds`.
   * These facts are PROVABLY not the current generation, so they are excluded
   * from ambiguity detection (duplicate-cohort membership) while remaining
   * non-authorizing for every closure surface (contracts §2.2.2 / §2.1.4 /
   * architecture #/entities/planning-acceptance-succession).
   */
  readonly supersededFactIds: readonly string[];
  /** True iff at least one relation-invalid fact exists. */
  readonly hasInvalidHistory: boolean;
}

/** The superseded-generation relation of one accepted-bound fact. */
interface MesSupersededGenerationBinding {
  /** The unique current (chain tip) generation fact_id of the own (stage, cycle) group. */
  readonly tipFactId: string;
  /** The NON-CURRENT generation whose binding-critical identity the fact exactly matches. */
  readonly boundGenerationFactId: string;
}

/**
 * (S06 post-recovery Authority update) The SINGLE canonical superseded-generation
 * predicate: a fact bound to a NON-CURRENT accepted generation of its OWN
 * (stage, delivery cycle) is superseded — it stays readable / auditable but is
 * permanently non-authorizing (contracts §2.2.2 / §2.1.4 /
 * architecture #/entities/planning-acceptance-succession). It must never
 * support Task/Slice completion, Integration, STAGE_ACCEPTED, terminal support
 * closure, duplicate-cohort membership or continuation.
 *
 * The current generation is the unique chain tip of the fact's own (stage,
 * cycle) group (never a (ref, digest) / fingerprint / order heuristic). A fact
 * is bound to a generation G when its whole binding-critical identity matches
 * G's (accepted ref / source candidate ref / verification_result_ref / cycle);
 * matching a NON-tip G means the fact belongs to a superseded generation. A
 * fact that matches NO generation (typo / old / approximate verification ref)
 * is NOT superseded — it falls through to the canonical relation comparison
 * and keeps its own relation-invalid reason.
 *
 * `classifyOne` and the exported classification both consume this predicate,
 * so there is exactly one superseded-generation inference in the runtime.
 */
function resolveSupersededGenerationBinding(
  facts: readonly MesFactEnvelope[],
  fact: MesFactEnvelope,
): MesSupersededGenerationBinding | undefined {
  const binding = fact.plan_binding;
  if (binding === undefined || binding.binding_stage !== 'accepted') return undefined;
  const factStageId = fact.scope?.stage_id;
  const factCycle = binding.delivery_cycle_id;
  if (typeof factStageId !== 'string' || typeof factCycle !== 'string' || factCycle.length === 0) return undefined;
  const ownGenerations = facts.filter(
    (candidate) =>
      isCycleBearingPlanAcceptanceGeneration(candidate) &&
      candidate.scope?.stage_id === factStageId &&
      candidate.plan_binding?.delivery_cycle_id === factCycle,
  );
  const tipResolution = resolvePlanAcceptanceGenerationTips(ownGenerations);
  if (!tipResolution.ok || tipResolution.tips.length !== 1) return undefined;
  const tip = tipResolution.tips[0];
  const boundGeneration = ownGenerations.find((generation) => {
    const generationBinding = generation.plan_binding;
    if (generationBinding === undefined || generationBinding.binding_stage !== 'accepted') return false;
    return (
      generationBinding.accepted_plan_ref === binding.accepted_plan_ref &&
      generationBinding.source_candidate_plan_ref === binding.source_candidate_plan_ref &&
      generationBinding.verification_result_ref === binding.verification_result_ref &&
      generationBinding.delivery_cycle_id === binding.delivery_cycle_id
    );
  });
  if (boundGeneration === undefined || boundGeneration.fact_id === tip.fact_id) return undefined;
  return { tipFactId: tip.fact_id, boundGenerationFactId: boundGeneration.fact_id };
}

function classifyOne(
  facts: readonly MesFactEnvelope[],
  fact: MesFactEnvelope,
): MesInvalidHistoryFact {
  const binding = fact.plan_binding;
  if (!binding || binding.binding_stage !== 'accepted') {
    return { fact_id: fact.fact_id, fact_kind: fact.fact_kind, status: 'not-binding-critical' };
  }
  // Non-current (superseded) accepted generation → non-authorizing history.
  const superseded = resolveSupersededGenerationBinding(facts, fact);
  if (superseded !== undefined) {
    return {
      fact_id: fact.fact_id,
      fact_kind: fact.fact_kind,
      status: 'relation-invalid',
      reason: `fact ${JSON.stringify(fact.fact_id)} is bound to a NON-CURRENT accepted generation ${JSON.stringify(superseded.boundGenerationFactId)} of (stage ${JSON.stringify(fact.scope?.stage_id)}, cycle ${JSON.stringify(binding.delivery_cycle_id)}) — the current chain tip is ${JSON.stringify(superseded.tipFactId)}（superseded generation → non-authorizing history，no-write）`,
    };
  }
  // The canonical relation must RESOLVE uniquely from the durable set. A
  // missing / ambiguous / unsupported relation is unverifiable history —
  // readable/auditable fail-closed, never counted as misbound.
  const resolution = resolveCanonicalAcceptanceRelation(facts, binding.accepted_plan_ref);
  if (!resolution.ok) {
    return {
      fact_id: fact.fact_id,
      fact_kind: fact.fact_kind,
      status: 'relation-unverifiable',
      reason: resolution.error,
    };
  }
  // The canonical relation resolves: compare the fact's OWN binding-critical
  // identity against the resolved canonical relation. Relation-invalid is the
  // misbound class — deviations in the canonical identity refs (accepted
  // plan ref / source candidate plan ref / verification_result_ref /
  // delivery_cycle_id). A plan_digest-only drift between a retained support
  // and its canonical acceptance (legacy fixture/durable drift) stays
  // relation-valid for the authorization surface while the transaction
  // layer's exact-match no-write gate still rejects new submissions
  // (binding.ts is consumed read-only here; the two surfaces differ in the
  // digest check by design — retained history never loses authorizing refs
  // it already carried).
  const canonical = resolution.canonical;
  const identity = binding;
  if (identity.accepted_plan_ref !== canonical.accepted_plan_ref) {
    return {
      fact_id: fact.fact_id,
      fact_kind: fact.fact_kind,
      status: 'relation-invalid',
      reason: `fact ${JSON.stringify(fact.fact_id)} accepted_plan_ref ${JSON.stringify(identity.accepted_plan_ref)} deviates from the canonical accepted_plan_ref ${JSON.stringify(canonical.accepted_plan_ref)}（misbound，no-write）`,
    };
  }
  if ((identity.source_candidate_plan_ref ?? undefined) !== (canonical.source_candidate_plan_ref ?? undefined)) {
    return {
      fact_id: fact.fact_id,
      fact_kind: fact.fact_kind,
      status: 'relation-invalid',
      reason: `fact ${JSON.stringify(fact.fact_id)} source_candidate_plan_ref deviates from the resolved canonical relation（misbound，no-write）`,
    };
  }
  if ((identity.verification_result_ref ?? undefined) !== (canonical.verification_result_ref ?? undefined)) {
    return {
      fact_id: fact.fact_id,
      fact_kind: fact.fact_kind,
      status: 'relation-invalid',
      reason: `fact ${JSON.stringify(fact.fact_id)} verification_result_ref ${JSON.stringify(identity.verification_result_ref ?? null)} must EXACTLY equal the canonical verification_result_ref ${JSON.stringify(canonical.verification_result_ref ?? null)} resolved from the current durable relation（typo / old ref / approximate ref → misbound，no-write）`,
    };
  }
  if ((identity.delivery_cycle_id ?? undefined) !== (canonical.delivery_cycle_id ?? undefined)) {
    return {
      fact_id: fact.fact_id,
      fact_kind: fact.fact_kind,
      status: 'relation-invalid',
      reason: `fact ${JSON.stringify(fact.fact_id)} delivery_cycle_id ${JSON.stringify(identity.delivery_cycle_id ?? null)} deviates from the canonical delivery_cycle_id ${JSON.stringify(canonical.delivery_cycle_id ?? null)}（cross-cycle → misbound，no-write）`,
    };
  }
  return { fact_id: fact.fact_id, fact_kind: fact.fact_kind, status: 'relation-valid' };
}

/**
 * Classify every fact of a validated durable fact set into relation-valid /
 * relation-invalid / relation-unverifiable / not-binding-critical.
 *
 * Pure and deterministic: the output is a function of the fact SET only
 * (sorted ascending by fact_id), so restart/rehydrate of the same bytes and
 * any input ordering yield the identical classification. The oracle is
 * read-only — it never writes, deletes, rewrites, silently corrects or
 * backfills retained history.
 *
 * @throws {TypeError} on non-array input or non-envelope / unknown-kind
 *   entries (fail-closed, mirroring the status projections).
 */
export function classifyInvalidHistory(facts: readonly MesFactEnvelope[]): MesInvalidHistoryClassification {
  if (!Array.isArray(facts)) {
    throw new TypeError('invalid immutable history classification input must be an array of validated MES facts');
  }
  const kindSet = new Set<string>(MES_FACT_KINDS as readonly string[]);
  const classified: MesInvalidHistoryFact[] = [];
  for (const raw of facts) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError('invalid immutable history classification input facts must be envelope objects');
    }
    const fact = raw as MesFactEnvelope;
    if (typeof fact.fact_id !== 'string' || fact.fact_id.length === 0) {
      throw new TypeError('invalid immutable history classification input fact lacks a fact_id');
    }
    const kind = fact.fact_kind;
    if (typeof kind !== 'string' || !kindSet.has(kind)) {
      throw new TypeError(`invalid immutable history classification input fact has unknown fact_kind ${JSON.stringify(kind)}`);
    }
    // Validation pass only; classification happens against the canonical view below.
  }
  // (S06-R-C-T02 / CE5) Determinism is a property of the fact SET, not of
  // the input sequence: the classification of every fact and every reason
  // string must be identical under reversed / shuffled input. The canonical
  // binding-resolution helpers (binding.ts) iterate the array they receive,
  // so an ambiguous dual plan_acceptance reason embeds the fact_id order it
  // saw. Normalize to ascending fact_id BEFORE resolving anything, then
  // re-classify every fact against that canonical view.
  const ordered = [...facts].sort((a, b) => (a.fact_id < b.fact_id ? -1 : a.fact_id > b.fact_id ? 1 : 0));
  const canonical = ordered.map((fact) => classifyOne(ordered, fact));
  // Deterministic ordering: ascending fact_id — never insertion order.
  const sorted = [...canonical].sort((a, b) => (a.fact_id < b.fact_id ? -1 : a.fact_id > b.fact_id ? 1 : 0));
  const invalidFactIds = sorted.filter((f) => f.status === 'relation-invalid').map((f) => f.fact_id);
  const unverifiableFactIds = sorted.filter((f) => f.status === 'relation-unverifiable').map((f) => f.fact_id);
  // Superseded (non-current generation) subset, from the SAME canonical
  // predicate `classifyOne` used — never a second currentness inference.
  const supersededFactIds = ordered
    .filter((fact) => resolveSupersededGenerationBinding(ordered, fact) !== undefined)
    .map((fact) => fact.fact_id)
    .sort();
  return {
    facts: sorted,
    invalidFactIds,
    unverifiableFactIds,
    supersededFactIds,
    hasInvalidHistory: invalidFactIds.length > 0,
  };
}
