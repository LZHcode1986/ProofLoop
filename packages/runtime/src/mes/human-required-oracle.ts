/**
 * HUMAN_REQUIRED condition oracle (A4 / contracts.md §2.2.4).
 *
 * Pure projection predicate — NO durable open fact is created. The durable
 * basis of a HUMAN_REQUIRED condition is the Brain arbitration event: an
 * ACCEPTED `USER_DECISION_REQUIRED` finding_disposition whose `finding_ref`
 * exact-resolves a durable finding. The condition lives independently of the
 * source disposition's generic M1/M2 currentness (generation / Work
 * succession may make the disposition non-authorizing execution evidence
 * WITHOUT closing the condition); the ONLY durable close is a Finding-level
 * `human_required_resolution` relation (REPLAN / RESUME).
 *
 * `resolveHumanRequiredConditions(facts, { currentCycleId })` returns the
 * OPEN conditions whose origin belongs to the current relevant delivery
 * cycle. Consumers:
 *   - status L1 `human_required` counter = distinct OPEN Finding count
 *     (deriveStageAnomalyCounters);
 *   - status L2 affected-work projection (semantic_owner / waiting_for);
 *   - PROJECT_READY terminal guard (no open HUMAN_REQUIRED condition in the
 *     cycle being terminated → materialize; otherwise no-write).
 *
 * The origin validation is the own-generation historical-origin predicate
 * (Authority F2): it is rebuilt purely from durable facts on restart — never
 * from "the write used to pass" session memory, and never by treating the
 * generic `classifyInvalidHistory` superseded answer as an origin-validity
 * oracle (the generic classifier can only prove currentness, not the absence
 * of relation defects).
 */

import type { MesFactEnvelope, MesPlanBinding } from './types';
import { verifyPlanAcceptanceSupport, verifyPlanAcceptanceSuccessionGraphError } from './binding';

/** One open HUMAN_REQUIRED condition. */
export interface HumanRequiredOpenCondition {
  readonly finding: MesFactEnvelope;
  /**
   * Canonical-sorted qualifying disposition refs that opened the condition
   * (Reviewer Finding 4: same-route duplicates are COLLAPSED into the set —
   * never one insertion-order "winner"; H7/H9 permutation invariant).
   */
  readonly qualifyingDispositionRefs: readonly string[];
  /** Origin delivery cycle (D.plan_binding.delivery_cycle_id). */
  readonly originCycle: string | undefined;
}

function acceptedBindingIdentityOf(
  fact: MesFactEnvelope,
): {
  acceptedPlanRef: string | undefined;
  sourceCandidatePlanRef: string | undefined;
  verificationResultRef: string | undefined;
  planDigest: string | undefined;
  deliveryCycleId: string | undefined;
} | undefined {
  const pb = fact.plan_binding as MesPlanBinding | undefined;
  if (pb === undefined || pb.binding_stage !== 'accepted') return undefined;
  return {
    acceptedPlanRef: pb.accepted_plan_ref,
    sourceCandidatePlanRef: pb.source_candidate_plan_ref,
    verificationResultRef: pb.verification_result_ref,
    planDigest: pb.plan_digest,
    deliveryCycleId: pb.delivery_cycle_id,
  };
}

function findBoundAcceptedGeneration(
  fact: MesFactEnvelope,
  facts: readonly MesFactEnvelope[],
): { acceptance: MesFactEnvelope; pvr: MesFactEnvelope } | undefined {
  const binding = acceptedBindingIdentityOf(fact);
  if (binding === undefined || binding.acceptedPlanRef === undefined || binding.verificationResultRef === undefined) {
    return undefined;
  }
  const factStage = fact.scope?.stage_id;
  const factCycle = binding.deliveryCycleId;
  // The bound accepted generation must EXIST in the durable set with the SAME
  // binding identity (accepted_plan_ref / source_candidate_plan_ref /
  // verification_result_ref / plan_digest / delivery_cycle_id) — matched by
  // identity, never by treating accepted_plan_ref as a fact_id. A superseded
  // historical generation stays durable and still closes its own PVR/PA
  // closure; currentness supersession is NOT an origin defect (H1/H3).
  const acceptances = facts.filter((f) => {
    if (f.fact_kind !== 'plan_acceptance' || f.plan_binding === undefined) return false;
    const pb = f.plan_binding as MesPlanBinding;
    if (pb.binding_stage !== 'accepted') return false;
    return (
      pb.accepted_plan_ref === binding.acceptedPlanRef &&
      pb.source_candidate_plan_ref === binding.sourceCandidatePlanRef &&
      pb.verification_result_ref === binding.verificationResultRef &&
      (pb.plan_digest ?? undefined) === (binding.planDigest ?? undefined) &&
      (pb.delivery_cycle_id ?? undefined) === (binding.deliveryCycleId ?? undefined)
    );
  });
  if (acceptances.length !== 1) return undefined; // missing / ambiguous → no legal origin
  const acceptance = acceptances[0];
  // (Reviewer Finding 2 / Authority F2) The bound accepted generation must
  // live in the SAME Stage as F/D: a cross-Stage PA with an identical binding
  // identity is relation-defective and cannot be the origin's generation.
  if (typeof acceptance.scope?.stage_id !== 'string' || acceptance.scope.stage_id !== factStage) return undefined;
  // PVR support carrying the SAME verification_result_ref with a candidate
  // PLAN_READY binding, in the SAME Stage (PVR→PA stage closure):
  const pvrs = facts.filter((f) => {
    if (f.fact_kind !== 'planning_verification_result' || f.result_ref !== binding.verificationResultRef) return false;
    if (f.scope?.stage_id !== factStage) return false;
    const pb = f.plan_binding as
      | { binding_stage?: string; verdict?: string; candidate_plan_ref?: string }
      | undefined;
    return pb !== undefined && pb.binding_stage === 'candidate' && pb.verdict === 'PLAN_READY';
  });
  if (pvrs.length !== 1) return undefined;
  const pvr = pvrs[0];
  // Reuse the canonical PVR→PA closure check (binding.ts) for the full
  // relation: verified candidate basis equality, cycle equality, digest, git
  // basis head.
  if (verifyPlanAcceptanceSupport(acceptance, pvr) !== undefined) return undefined;
  // (Reviewer Finding 2 / Authority F2) The bound PA must be a REAL node of a
  // LEGAL (stage, cycle) succession chain: reuse the existing generation
  // relation validator over the bound PA's own (stage, cycle) group so a
  // broken chain (missing target / cross-stage-cycle predecessor / branch /
  // directed cycle / ambiguous tips) can never authorize an origin. This is
  // the SAME machinery the write boundary and status projections consume —
  // no third generation validator.
  const groupNodes = facts.filter((f) => {
    if (f.fact_kind !== 'plan_acceptance') return false;
    if (f.scope?.stage_id !== factStage) return false;
    const pb = f.plan_binding as MesPlanBinding | undefined;
    return (pb?.delivery_cycle_id ?? undefined) === (factCycle ?? undefined);
  });
  if (verifyPlanAcceptanceSuccessionGraphError(groupNodes) !== undefined) return undefined;
  return { acceptance, pvr };
}

/**
 * own-generation historical-origin predicate (Authority F2, six conditions).
 *
 * 1. D.finding_disposition = ACCEPTED
 * 2. D.accepted_route_code = USER_DECISION_REQUIRED
 * 3. D.finding_ref exact-resolves Finding F (durable finding fact)
 * 4. F/D canonical binding identity self-consistent
 *    (accepted_plan_ref / source_candidate_plan_ref / verification_result_ref
 *     / plan_digest / delivery_cycle_id agree)
 * 5. F/D bound accepted generation EXISTS in the durable set with a legal
 *    PVR/PA closure
 * 6. stage / cycle exact-match (scope.stage_id equal; delivery_cycle_id equal)
 *
 * A disposition that is merely provably superseded history (canonical
 * generation / Work succession) still satisfies the predicate — currentness
 * supersession is the ONLY permitted divergence. typo / misbound / ambiguous /
 * relation-unverifiable / never-valid history do NOT form an origin.
 */
export function isHistoricallyValidDisposition(
  disposition: MesFactEnvelope,
  finding: MesFactEnvelope,
  facts: readonly MesFactEnvelope[],
): boolean {
  // 1: ACCEPTED disposition (route-agnostic — the shared classification
  // predicate must see ALL historically-valid ACCEPTED dispositions,
  // including non-USER_DECISION_REQUIRED ones, to detect ambiguity).
  if (disposition.finding_disposition !== 'ACCEPTED') {
    return false;
  }
  // 3: exact finding_ref resolution.
  if (typeof disposition.finding_ref !== 'string' || disposition.finding_ref !== finding.fact_id || finding.fact_kind !== 'finding') {
    return false;
  }
  // 6: stage / cycle exact-match between F and D.
  if (finding.scope?.stage_id !== disposition.scope?.stage_id) return false;
  const fCycle = finding.plan_binding !== undefined ? (finding.plan_binding as MesPlanBinding).delivery_cycle_id : undefined;
  const dCycle = disposition.plan_binding !== undefined ? (disposition.plan_binding as MesPlanBinding).delivery_cycle_id : undefined;
  if (fCycle !== dCycle) return false;
  // 4: canonical binding identity self-consistent across F/D.
  const fBinding = acceptedBindingIdentityOf(finding);
  const dBinding = acceptedBindingIdentityOf(disposition);
  if (fBinding === undefined || dBinding === undefined) return false;
  if (
    fBinding.acceptedPlanRef !== dBinding.acceptedPlanRef ||
    fBinding.sourceCandidatePlanRef !== dBinding.sourceCandidatePlanRef ||
    fBinding.verificationResultRef !== dBinding.verificationResultRef ||
    fBinding.planDigest !== dBinding.planDigest ||
    fBinding.deliveryCycleId !== dBinding.deliveryCycleId
  ) {
    return false;
  }
  // 5: the bound accepted generation exists with a legal PVR/PA closure.
  return findBoundAcceptedGeneration(disposition, facts) !== undefined;
}

/**
 * HUMAN_REQUIRED origin predicate = historically-valid ACCEPTED disposition
 * (conditions 1,3,4,5,6 via isHistoricallyValidDisposition) + condition 2:
 * accepted_route_code = USER_DECISION_REQUIRED. This is the OPEN basis of a
 * HUMAN_REQUIRED condition; generic currentness supersession does NOT revoke
 * it (only a Finding-level resolution closes the condition).
 */
export function isHistoricallyValidHumanRequiredOrigin(
  disposition: MesFactEnvelope,
  finding: MesFactEnvelope,
  facts: readonly MesFactEnvelope[],
): boolean {
  if (!isHistoricallyValidDisposition(disposition, finding, facts)) return false;
  return disposition.accepted_route_code === 'USER_DECISION_REQUIRED';
}

/**
 * Finding classification set semantics (Authority F1): over ALL historically
 * valid ACCEPTED dispositions of a finding, distinct accepted_route_code == 1
 * → classification usable; duplicate same-route dispositions collapse;
 * distinct > 1 → classification ambiguity, fail closed (never pick one, never
 * newest-wins). Returns the single usable route or undefined on ambiguity.
 */
export function uniqueFindingClassification(
  finding: MesFactEnvelope,
  dispositions: readonly MesFactEnvelope[],
  facts: readonly MesFactEnvelope[],
): string | undefined {
  // ALL historically-valid ACCEPTED dispositions (route-agnostic): the
  // classification set must include non-USER_DECISION_REQUIRED routes so
  // that a USER_DECISION_REQUIRED + PLAN_GAP pair is detected as ambiguity
  // (Authority F1; H8). Same-route duplicates collapse; distinct > 1 →
  // ambiguity, fail closed (never pick one, never newest-wins).
  const accepted = dispositions.filter(
    (d) =>
      d.fact_kind === 'finding_disposition' &&
      d.finding_ref === finding.fact_id &&
      isHistoricallyValidDisposition(d, finding, facts),
  );
  if (accepted.length === 0) return undefined;
  const distinct = new Set<string>();
  for (const d of accepted) {
    if (typeof d.accepted_route_code === 'string') distinct.add(d.accepted_route_code);
  }
  if (distinct.size > 1) return undefined; // classification ambiguity → fail closed
  return [...distinct][0];
}

/**
 * Resolve the OPEN HUMAN_REQUIRED conditions over a durable fact set.
 *
 * Condition(F) is OPEN iff:
 *   1. F has at least one historically-valid ACCEPTED USER_DECISION_REQUIRED
 *      disposition (origin), and the F1 set semantics yield the single
 *      USER_DECISION_REQUIRED classification (no ambiguity);
 *   2. origin delivery_cycle_id == current relevant cycle (when
 *      `currentCycleId` is supplied; conditions from other cycles are
 *      historical / auditable and never pollute the current counter);
 *   3. no valid Finding-level `human_required_resolution` closes F.
 */

/**
 * SHARED resolution legality predicate (Reviewer Finding 1).
 *
 * A `human_required_resolution` can close a condition ONLY when it is
 * legal: the referenced Finding and qualifying disposition exact-resolve,
 * the disposition is historically-valid AND opens the SAME condition the
 * resolution claims to close (F1-B: a ghost-bound or cross-Finding
 * disposition must NOT be accepted), the shared classification yields
 * USER_DECISION_REQUIRED (F1/H8 ambiguity fail-closed), and no other
 * resolution already closes this Finding (one outcome).
 *
 * Consumed by BOTH the write boundary (terminal.ts via the transaction layer)
 * and the read projections (resolveHumanRequiredConditions /
 * countOpenHumanRequiredFindings) so a malformed resolution can never
 * silently close an open condition (F1-A).
 *
 * @returns `undefined` when the resolution is legal, or a fail-closed message.
 */
export function resolveHumanRequiredResolutionLegalityError(
  resolution: MesFactEnvelope,
  facts: readonly MesFactEnvelope[],
): string | undefined {
  const fRef = resolution.source_finding_ref;
  if (typeof fRef !== 'string' || fRef.length === 0) {
    return 'human_required_resolution requires a non-empty source_finding_ref';
  }
  const fMatches = facts.filter((fact) => fact.fact_id === fRef);
  if (fMatches.length === 0) {
    return `source_finding_ref ${JSON.stringify(fRef)} does not resolve to a durable finding fact in the persisted result set (missing support)`;
  }
  if (fMatches.length > 1) {
    return `source_finding_ref ${JSON.stringify(fRef)} is ambiguous: ${fMatches.length} facts share the fact_id (unique resolution required)`;
  }
  const finding = fMatches[0];
  if (finding.fact_kind !== 'finding') {
    return `source_finding_ref ${JSON.stringify(fRef)} resolves to fact ${JSON.stringify(finding.fact_id)} with kind ${JSON.stringify(finding.fact_kind)} — expected a durable finding fact`;
  }
  const dRef = resolution.source_disposition_ref;
  if (typeof dRef !== 'string' || dRef.length === 0) {
    return 'human_required_resolution requires a non-empty source_disposition_ref';
  }
  const dMatches = facts.filter((fact) => fact.fact_id === dRef);
  if (dMatches.length === 0) {
    return `source_disposition_ref ${JSON.stringify(dRef)} does not resolve to a durable finding_disposition fact in the persisted result set (missing support)`;
  }
  if (dMatches.length > 1) {
    return `source_disposition_ref ${JSON.stringify(dRef)} is ambiguous: ${dMatches.length} facts share the fact_id (unique resolution required)`;
  }
  const disposition = dMatches[0];
  if (disposition.fact_kind !== 'finding_disposition') {
    return `source_disposition_ref ${JSON.stringify(dRef)} resolves to fact ${JSON.stringify(disposition.fact_id)} with kind ${JSON.stringify(disposition.fact_kind)} — expected a durable finding_disposition fact`;
  }
  // (F1-B) The disposition must be historically-valid (own-generation
  // binding closure) — a ghost-bound or otherwise relation-defective
  // disposition can never be the qualifying origin of the condition this
  // resolution claims to close.
  if (!isHistoricallyValidDisposition(disposition, finding, facts)) {
    return `source_disposition_ref ${JSON.stringify(dRef)} resolves to disposition ${JSON.stringify(disposition.fact_id)} that is NOT historically-valid (binding identity / PVR-PA closure / stage-cycle match failed) — a resolution must reference the qualifying origin disposition that actually opened the condition`;
  }
  if (disposition.finding_disposition !== 'ACCEPTED' || disposition.accepted_route_code !== 'USER_DECISION_REQUIRED') {
    return `source_disposition_ref ${JSON.stringify(dRef)} must exact-resolve to a qualifying disposition (ACCEPTED + accepted_route_code USER_DECISION_REQUIRED) that opened the HUMAN_REQUIRED condition`;
  }
  // (F1/H8) Shared classification must still yield USER_DECISION_REQUIRED —
  // an ambiguous Finding (e.g. USER_DECISION_REQUIRED + PLAN_GAP) cannot be
  // resolved either (the condition itself never opened cleanly).
  if (uniqueFindingClassification(finding, facts, facts) !== 'USER_DECISION_REQUIRED') {
    return `finding ${JSON.stringify(fRef)} classification is not uniquely USER_DECISION_REQUIRED (ambiguity / other route) — eligibility of the condition is not established`;
  }
  // (Reviewer Finding 1 / A4) The resolution's OWN causal binding must
  // match the source condition: Stage and cycle identity, and the exact
  // generation the resolution claims to bind.
  const resStage = resolution.scope?.stage_id;
  const sourceStage = disposition.scope?.stage_id;
  if (typeof resStage !== 'string' || resStage !== sourceStage) {
    return `resolution ${JSON.stringify(resolution.fact_id)} scope.stage_id ${JSON.stringify(resStage)} does not match the source condition Stage ${JSON.stringify(sourceStage)} — a resolution must bind the SAME Stage as its source Finding/disposition (cross-Stage resolution no-write)`;
  }
  const resCycle = resolution.plan_binding !== undefined ? (resolution.plan_binding as MesPlanBinding).delivery_cycle_id : undefined;
  const sourceCycle = disposition.plan_binding !== undefined ? (disposition.plan_binding as MesPlanBinding).delivery_cycle_id : undefined;
  if ((resCycle ?? undefined) !== (sourceCycle ?? undefined)) {
    return `resolution ${JSON.stringify(resolution.fact_id)} delivery_cycle_id ${JSON.stringify(resCycle)} does not match the source condition cycle ${JSON.stringify(sourceCycle)} — a resolution must bind the SAME cycle as its source disposition (cross-cycle resolution no-write)`;
  }
  const resBinding = acceptedBindingIdentityOf(resolution);
  const kind = resolution.resolution_kind;
  if (kind === 'RESUME') {
    // RESUME: the resolution itself is the closure evidence — it must bind
    // the EXACT origin generation of the source disposition (no new Plan
    // target, no rebind to a successor generation).
    const originBinding = acceptedBindingIdentityOf(disposition);
    if (
      resBinding === undefined ||
      originBinding === undefined ||
      resBinding.acceptedPlanRef !== originBinding.acceptedPlanRef ||
      resBinding.sourceCandidatePlanRef !== originBinding.sourceCandidatePlanRef ||
      resBinding.verificationResultRef !== originBinding.verificationResultRef ||
      resBinding.planDigest !== originBinding.planDigest ||
      resBinding.deliveryCycleId !== originBinding.deliveryCycleId
    ) {
      return `RESUME resolution ${JSON.stringify(resolution.fact_id)} binds a different accepted generation than the source disposition's origin — a RESUME must bind the origin generation of the condition it closes`;
    }
  } else if (kind === 'REPLAN') {
    // REPLAN: the resolution must exact-resolve its target PA and bind the
    // target's accepted generation; the target must live in the SAME
    // Stage/cycle and be structurally legal (PVR/PA closure + legal
    // succession chain). Read-side legality mirrors the write-side atomic
    // same-event freshness (which stays at the transaction boundary).
    const targetRef = resolution.resolution_plan_acceptance_ref;
    if (typeof targetRef !== 'string' || targetRef.length === 0) {
      return `REPLAN resolution ${JSON.stringify(resolution.fact_id)} requires a resolution_plan_acceptance_ref targeting the fresh PA it closes against`;
    }
    const targetMatches = facts.filter((f) => f.fact_id === targetRef);
    if (targetMatches.length !== 1 || targetMatches[0].fact_kind !== 'plan_acceptance') {
      return `REPLAN resolution ${JSON.stringify(resolution.fact_id)} target ${JSON.stringify(targetRef)} does not exact-resolve to exactly one durable plan_acceptance fact (missing / ambiguous / wrong kind)`;
    }
    const target = targetMatches[0];
    const targetBinding = acceptedBindingIdentityOf(target);
    if (
      resBinding === undefined ||
      targetBinding === undefined ||
      resBinding.acceptedPlanRef !== targetBinding.acceptedPlanRef ||
      resBinding.sourceCandidatePlanRef !== targetBinding.sourceCandidatePlanRef ||
      resBinding.verificationResultRef !== targetBinding.verificationResultRef ||
      resBinding.planDigest !== targetBinding.planDigest ||
      resBinding.deliveryCycleId !== targetBinding.deliveryCycleId
    ) {
      return `REPLAN resolution ${JSON.stringify(resolution.fact_id)} binds a different accepted generation than its target PA ${JSON.stringify(targetRef)} — the resolution must bind the target generation it closes against`;
    }
    const targetStage = target.scope?.stage_id;
    if (typeof targetStage !== 'string' || targetStage !== sourceStage) {
      return `REPLAN resolution ${JSON.stringify(resolution.fact_id)} target PA ${JSON.stringify(targetRef)} is in Stage ${JSON.stringify(targetStage)} but the source condition is in Stage ${JSON.stringify(sourceStage)} — REPLAN target must be same-Stage`;
    }
    // Target structural legality: bound generation exists with a legal PVR/PA
    // closure and a legal succession chain (reuses the origin machinery).
    if (findBoundAcceptedGeneration(target, facts) === undefined) {
      return `REPLAN resolution ${JSON.stringify(resolution.fact_id)} target PA ${JSON.stringify(targetRef)} has no legal PVR/PA closure or a broken succession chain — a structurally defective target can never close a condition`;
    }
  } else {
    return `resolution ${JSON.stringify(resolution.fact_id)} carries unknown resolution_kind ${JSON.stringify(kind)} (closed enum: REPLAN | RESUME)`;
  }
  // A Finding has at most ONE valid resolution outcome.
  const conflicting = facts.filter(
    (fact) => fact.fact_kind === 'human_required_resolution' && fact.source_finding_ref === fRef && fact.fact_id !== resolution.fact_id,
  );
  if (conflicting.length > 0) {
    return `finding ${JSON.stringify(fRef)} already has resolution ${JSON.stringify(conflicting[0].fact_id)} — a Finding has at most one valid resolution outcome (conflict resolution fails closed)`;
  }
  return undefined;
}

export function resolveHumanRequiredConditions(
  facts: readonly MesFactEnvelope[],
  opts: { currentCycleId?: string } = {},
): HumanRequiredOpenCondition[] {
  const findings = facts.filter((f) => f.fact_kind === 'finding');
  const dispositions = facts.filter((f) => f.fact_kind === 'finding_disposition');
  const resolutions = facts.filter((f) => f.fact_kind === 'human_required_resolution');
  const open: HumanRequiredOpenCondition[] = [];
  for (const finding of findings) {
    const classification = uniqueFindingClassification(finding, dispositions, facts);
    if (classification !== 'USER_DECISION_REQUIRED') continue; // no origin / ambiguity / other route
    // (Reviewer Finding 4) Qualifying dispositions are a SET (same-route
    // duplicates collapse): no insertion-order "winner" — canonical sorted
    // refs, permutation/restart invariant (H7/H9).
    const qualifying = dispositions
      .filter(
        (d) =>
          d.finding_ref === finding.fact_id &&
          d.finding_disposition === 'ACCEPTED' &&
          d.accepted_route_code === 'USER_DECISION_REQUIRED' &&
          isHistoricallyValidHumanRequiredOrigin(d, finding, facts),
      )
      .sort((a, b) => (a.fact_id < b.fact_id ? -1 : a.fact_id > b.fact_id ? 1 : 0));
    if (qualifying.length === 0) continue;
    const originCycle = qualifying[0].plan_binding !== undefined ? (qualifying[0].plan_binding as MesPlanBinding).delivery_cycle_id : undefined;
    if (opts.currentCycleId !== undefined && originCycle !== opts.currentCycleId) continue; // historical cycle
    const resolved = resolutions.some(
      (r) => r.source_finding_ref === finding.fact_id && resolveHumanRequiredResolutionLegalityError(r, facts) === undefined,
    );
    if (resolved) continue; // closed by a LEGAL resolution only (F1: a malformed resolution never closes)
    open.push({ finding, qualifyingDispositionRefs: qualifying.map((d) => d.fact_id), originCycle });
  }
  // (Reviewer Finding 3 / R16) Condition list is canonical-sorted by
  // finding.fact_id — never input-fact order — so projectExecuteDetail /
  // projectCycleFilteredDetail / human formatter / JSON all project the SAME
  // deterministic condition ordering under reversal/permutation.
  return open.sort((a, b) => (a.finding.fact_id < b.finding.fact_id ? -1 : a.finding.fact_id > b.finding.fact_id ? 1 : 0));
}

/** distinct OPEN Finding count for the L1 `human_required` counter. */
export function countOpenHumanRequiredFindings(
  facts: readonly MesFactEnvelope[],
  currentCycleId: string | undefined,
): number {
  return resolveHumanRequiredConditions(facts, { currentCycleId }).length;
}
