/**
 * @proofloop/runtime — MES terminal / Review relation closure helpers
 * (S04-B-T01).
 *
 * Machine-closed predicates and pure relational-closure functions for the
 * S04 terminal machinery, consumed by the ONLY durable write boundary
 * (MesSnapshotStore.write):
 *
 *   - `isDurableAcceptedStageSupport(fact)` — exact field-presence predicate
 *     deciding whether a `stage` fact is a durable accepted-stage support:
 *     kind=="stage" + canonical Stage scope + accepted plan_binding +
 *     complete closed per-fact git_basis (head 40-hex / branch non-empty /
 *     worktree canonical root-relative, the trust-root `.` legal) +
 *     non-empty result_ref + created_by: brain. No label / heuristic —
 *     every field is decided by exact machine closure.
 *   - `verifyProjectReadySupportError(projectReady, resultingFacts)` — the
 *     closed `planned_stage_ids` set (ascending canonical form) must EXACTLY
 *     equal the durable accepted-stage support set (ascending canonical
 *     form) in the SAME persisted result set (submitted ∪ retained facts):
 *     missing / duplicate / unsorted / extra / mismatch return a fail-closed
 *     message. Per-fact git_basis values are NEVER compared across facts —
 *     each durable fact carries its own verified basis (different heads are
 *     legal, as the existing S01/S02/S03 accepted stage supports show) and
 *     the terminal relation binds by planned-set equality only (closure
 *     item 1 / item 4, contracts.md §2.1.1 / §5.1).
 *   - `resolveFindingDispositionRefError(disposition, resultingFacts)` — the
 *     disposition's `finding_ref` must resolve by EXACT fact_id to exactly
 *     one durable `finding` fact in the SAME persisted result set (which
 *     includes the retained durable `finding` / `finding_disposition`
 *     relation facts); missing / ambiguous / non-finding resolution returns
 *     a fail-closed message (STATIC-29 Review→Finding unique mapping).
 *
 * The helpers are pure functions over validated MES fact envelopes: they
 * never read the store, the Project Stage Map, MES status, or any
 * transport/session state (E2E-06 / STATIC-29 / contracts.md §2.1.1 §5.1
 * §7). MES never reads or generates the Map — the planned set is expressed
 * through the fact payload by Brain.
 */
import { CANONICAL_STAGE_ID_RE } from '@proofloop/kernel';
import { projectReadyClosedGitBasisError } from './binding';
import { classifyInvalidHistory } from './history-oracle';
import type { MesFactEnvelope } from './types';

/**
 * Machine-closed durable accepted-stage support predicate (S04-B-T01).
 *
 * A `stage` fact is a durable accepted-stage support exactly when it carries
 * the complete accepted shape (contracts.md §2.1.1 / acceptance E2E-06,
 * S04-A-T01 shape closure on top of which the per-fact git_basis must be
 * the COMPLETE closed set — presence alone is not a closed shape):
 *
 *   kind=="stage" + canonical scope.stage_id (/^S\d+$/) + accepted
 *   plan_binding (binding_stage=="accepted") + complete closed per-fact
 *   git_basis (head 40-hex / branch non-empty / worktree canonical
 *   root-relative, `.` legal) + non-empty result_ref + created_by: brain.
 *
 * No cross-fact basis comparison is ever made: every support fact keeps its
 * own verified basis and different heads are legal.
 *
 * @returns `true` when the fact is a durable accepted-stage support.
 */
export function isDurableAcceptedStageSupport(fact: MesFactEnvelope): boolean {
  if (fact.fact_kind !== 'stage') return false;
  if (fact.created_by !== 'brain') return false;
  const scope = fact.scope;
  if (scope === undefined || typeof scope.stage_id !== 'string' || !CANONICAL_STAGE_ID_RE.test(scope.stage_id)) {
    return false;
  }
  if (fact.plan_binding?.binding_stage !== 'accepted') return false;
  if (typeof fact.result_ref !== 'string' || fact.result_ref.length === 0) return false;
  // The per-fact git_basis must be the complete closed shape (head/branch/
  // worktree full set, head 40-hex, worktree canonical root-relative with
  // the trust-root `.` legal) — reuse the single shared shape validator
  // (S04-A-T01) instead of duplicating the closed-basis rule.
  if (projectReadyClosedGitBasisError(fact.git_basis) !== undefined) return false;
  return true;
}

/**
 * (S08-A-T01 / PO-S08-A-02) The SINGLE cohort-ambiguity rule.
 *
 * Two schema-valid durable accepted-stage supports for ONE Stage inside the
 * SAME cohort make the cohort ambiguous: the durable set can no longer
 * identify which accepted-Plan generation authorizes the Stage. Runtime:
 * cohort = durable accepted-stage supports whose `plan_binding`
 * `delivery_cycle_id` equals `cycle` (`undefined` = the legacy no-cycle
 * cohort) MINUS the facts PROVABLY bound to a superseded generation
 * (`classifyInvalidHistory(...).supersededFactIds`); a misbound support is NOT
 * provably superseded and stays an ambiguity member.
 *
 * This ONE function serves BOTH the write admission (`transaction.ts`
 * pre-persist gate) and every read projection
 * (`status.ts#assertUnambiguousCycleSupport` and the terminal closure in
 * `verifyProjectReadySupportError`) so no projection can invent a parallel
 * cohort rule and the write boundary / read projections can never disagree.
 *
 * @returns `undefined` when the cohort carries no duplicate Stage ID, or the
 *   fail-closed message (the caller turns it into its own typed error).
 */
export function duplicateAcceptedStageSupportError(
  facts: readonly MesFactEnvelope[],
  cycle: string | undefined,
): string | undefined {
  const superseded = new Set<string>(classifyInvalidHistory(facts).supersededFactIds);
  const seen = new Set<string>();
  for (const fact of facts) {
    if (!isDurableAcceptedStageSupport(fact)) continue;
    // A superseded (non-current generation) support is provably not the
    // current one and never joins the ambiguity cohort; a misbound support is
    // NOT provably superseded and stays an ambiguity member.
    if (superseded.has(fact.fact_id)) continue;
    if ((fact.plan_binding?.delivery_cycle_id ?? undefined) !== (cycle ?? undefined)) continue;
    const stageId = fact.scope!.stage_id;
    if (seen.has(stageId)) {
      return `duplicate accepted-stage support for stage ${JSON.stringify(stageId)} in the persisted result set`;
    }
    seen.add(stageId);
  }
  return undefined;
}

/**
 * Relational closure for a durable `project_ready` terminal fact
 * (S04-B-T01 / PO-S04-B-01, contracts.md §5.1 / acceptance E2E-06 / §7;
 * S05-D-T01 / PO-S05-D-01 cycle equality, contracts.md §5.1 /
 * architecture delivery-cycle-semantics / STATIC-30 / E2E-23).
 *
 * The closed `planned_stage_ids` set must EXACTLY equal the set of durable
 * accepted-stage supports present in the SAME persisted result set
 * (`resultingFacts` = submitted ∪ retained facts): every planned Stage ID
 * has a durable accepted-stage support and the support set has no
 * missing / duplicate / extra / unsorted Stage ID. Per-fact git_basis
 * values are never compared — the terminal relation binds by planned-set
 * equality only.
 *
 * (S05-D repair / CV S05-D-cv-1) Each PROJECT_READY terminal resolves its
 * OWN accepted-stage support relation, scoped by cycle identity (E2E-23 /
 * STATIC-30 / architecture delivery-cycle-semantics "Cross-fact cycle
 * equality is a write invariant"): a current NORMAL terminal (top-level
 * `delivery_cycle_id` present) binds ONLY the durable accepted-stage
 * supports carrying the SAME cycle in their own `plan_binding`; a legacy
 * terminal (no cycle field) binds ONLY the durable accepted-stage supports
 * WITHOUT a cycle field (legacy history-only, no backfill). Legacy and
 * current terminals with the SAME planned Stage IDs therefore coexist and
 * rehydrate independently in one persisted result set — a support
 * belonging to another cycle's relation never counts (and never fails)
 * this terminal. Missing / empty / non-string / mismatched support cycles
 * never join a current terminal's relation (no-write fail closed);
 * planned-set exact equality is enforced over the terminal's own
 * cycle-scoped support set (STATIC-30 / E2E-23).
 *
 * (S06 post-recovery Authority update) Generation currentness is authoritative
 * for this closure exactly as it is for the read projections: a durable
 * accepted-stage support bound to a NON-CURRENT (superseded) accepted-Plan
 * generation of its own (stage, cycle) is readable/auditable immutable history
 * but PERMANENTLY NON-AUTHORIZING (contracts §2.2.2 / architecture
 * #/entities/planning-acceptance-succession) — it can never back a terminal
 * (`STAGE_ACCEPTED` / support closure). The filter reuses the SINGLE canonical
 * classification source (`history-oracle.ts`) instead of a second currentness
 * inference, so the write boundary and the read projection can never
 * disagree. A GENUINE duplicate (two supports for one Stage in the current
 * cycle that both bind the CURRENT generation) still fails closed.
 *
 * MES never reads the Project Stage Map: the planned set is expressed
 * through the fact payload by Brain (the Map is not a MES input).
 *
 * @returns `undefined` when the closure holds, or a fail-closed message.
 */
export function verifyProjectReadySupportError(
  projectReady: MesFactEnvelope,
  resultingFacts: readonly MesFactEnvelope[],
): string | undefined {
  const planned = projectReady.planned_stage_ids;
  if (!Array.isArray(planned) || planned.length === 0) {
    return 'project_ready requires a non-empty planned_stage_ids array';
  }
  const seen = new Set<string>();
  for (let i = 0; i < planned.length; i++) {
    const id = planned[i];
    if (typeof id !== 'string' || !CANONICAL_STAGE_ID_RE.test(id)) {
      return `planned_stage_ids[${i}] is not a canonical Stage ID (expected /^S\\d+$/)`;
    }
    if (seen.has(id)) {
      return `planned_stage_ids contains a duplicate Stage ID ${JSON.stringify(id)}`;
    }
    seen.add(id);
    if (i > 0 && planned[i] <= planned[i - 1]) {
      return 'planned_stage_ids must be in ascending canonical order without duplicates';
    }
  }

  // (S05-D repair / CV S05-D-cv-1) Each PROJECT_READY terminal resolves its
  // OWN accepted-stage support relation, scoped by cycle identity (E2E-23 /
  // STATIC-30 / architecture delivery-cycle-semantics "Cross-fact cycle
  // equality is a write invariant"):
  //   - current NORMAL terminal (top-level delivery_cycle_id present): only
  //     durable accepted-stage supports carrying the SAME cycle in their own
  //     plan_binding belong to its relation; missing / empty / non-string /
  //     mismatched support cycles never join it (a planned stage without a
  //     same-cycle support fails closed no-write);
  //   - legacy terminal (no cycle field): only durable accepted-stage
  //     supports WITHOUT a cycle field belong to its relation (legacy
  //     history-only, no backfill).
  // Legacy and current terminals with the SAME planned Stage IDs therefore
  // coexist and rehydrate independently in one persisted result set: each
  // terminal counts only its own cycle's supports (E2E-23 machine closure).
  const terminalCycle = projectReady.delivery_cycle_id;
  // (S06 post-recovery Authority update) Generation currentness is authoritative
  // here through the SINGLE canonical classification source (`history-oracle.ts`),
  // so the write boundary and the read projection can never disagree:
  //   - CLOSURE cohort (missing / extra): a relation-invalid support is bound to a
  //     superseded OR misbound accepted-Plan identity and can never join the
  //     terminal relation — the same exclusion the read projections apply;
  //     relation-unverifiable supports keep their frozen authorizing semantics
  //     (S04/S05-C/S06-A terminal contract: only the misbound class is
  //     non-authorizing);
  //   - AMBIGUITY cohort (duplicate): only a support PROVABLY bound to a
  //     NON-CURRENT (superseded) generation is excluded — a superseded support
  //     can never be the current one, so a legal successor generation is not a
  //     duplicate. A misbound support is NOT provably superseded and stays an
  //     ambiguity member (a genuine duplicate pair that both binds the CURRENT
  //     generation still fails closed).
  const oracle = classifyInvalidHistory(resultingFacts);
  const nonAuthorizing = new Set<string>(oracle.invalidFactIds);
  const cycleMatched = resultingFacts.filter(
    (fact) =>
      isDurableAcceptedStageSupport(fact) &&
      (fact.plan_binding?.delivery_cycle_id ?? undefined) === (terminalCycle ?? undefined),
  );
  const supports = cycleMatched.filter((fact) => !nonAuthorizing.has(fact.fact_id));
  const supportIds = supports.map((fact) => fact.scope!.stage_id);
  const supportSeen = new Set<string>();
  for (const id of supportIds) supportSeen.add(id);
  const duplicateSupportError = duplicateAcceptedStageSupportError(resultingFacts, terminalCycle);
  if (duplicateSupportError !== undefined) return duplicateSupportError;

  const missing = planned.filter((id) => !supportSeen.has(id));
  const extra = supportIds.filter((id) => !seen.has(id));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(`planned Stage ${missing.map((id) => JSON.stringify(id)).join(', ')} has no durable accepted-stage support in the persisted result set`);
    }
    if (extra.length > 0) {
      parts.push(`durable accepted-stage support ${extra.map((id) => JSON.stringify(id)).join(', ')} is not part of the planned set`);
    }
    return parts.join('; ');
  }
  // Cycle equality is enforced BY the scoped selection above: every
  // support in this terminal's relation carries exactly the terminal's
  // top-level delivery_cycle_id (or both carry none, for legacy history).
  return undefined;
}

/**
 * Durable unique resolution for a `finding_disposition.finding_ref`
 * (S04-B-T01 / PO-S04-B-03, STATIC-29 Review→Finding unique mapping,
 * contracts.md §2.1.1 / §2.2.3 / §7).
 *
 * The ref must resolve by EXACT fact_id to exactly one durable `finding`
 * fact in the SAME persisted result set (`resultingFacts` = submitted ∪
 * retained facts — retained durable `finding` / `finding_disposition`
 * relation facts are part of it). Missing (no fact with that fact_id),
 * ambiguous (more than one fact shares the fact_id) and non-finding
 * resolutions fail closed no-write; the mapping is deterministic and
 * restart-rebuildable from the same durable facts.
 *
 * @returns `undefined` when the mapping is unique and closed, or a
 *   fail-closed message.
 */
export function resolveFindingDispositionRefError(
  disposition: MesFactEnvelope,
  resultingFacts: readonly MesFactEnvelope[],
): string | undefined {
  const ref = disposition.finding_ref;
  if (typeof ref !== 'string' || ref.length === 0) {
    return 'finding_disposition requires a non-empty finding_ref';
  }
  const matches = resultingFacts.filter((fact) => fact.fact_id === ref);
  if (matches.length === 0) {
    return `finding_ref ${JSON.stringify(ref)} does not resolve to a durable finding fact in the persisted result set (missing support)`;
  }
  if (matches.length > 1) {
    return `finding_ref ${JSON.stringify(ref)} is ambiguous: ${matches.length} facts share the fact_id (unique resolution required)`;
  }
  const target = matches[0];
  if (target.fact_kind !== 'finding') {
    return `finding_ref ${JSON.stringify(ref)} resolves to fact ${JSON.stringify(target.fact_id)} with kind ${JSON.stringify(target.fact_kind)} — expected a durable finding fact`;
  }
  return undefined;
}

/**
 * Machine-closed terminal succession graph validation (S06-D-T01 /
 * PO-S06-D-02, contracts §5.1 / current-terminal-currentness-oracle /
 * delivery-cycle-semantics / STATIC-30 / E2E-06 / E2E-23).
 *
 * Over the WHOLE resulting set (submitted ∪ retained facts) every
 * cycle-bearing `project_ready` terminal (top-level `delivery_cycle_id`
 * present) must be joinable into ONE acyclic successor chain:
 *
 *   - repeated cycle: two DIFFERENT terminals never share a
 *     `delivery_cycle_id` (each cycle terminates exactly once);
 *   - each non-null `supersedes_project_ready_ref` resolves by EXACT
 *     fact_id to a legal cycle-bearing `project_ready` terminal with a
 *     DIFFERENT `delivery_cycle_id`; self-reference, missing target and
 *     non-terminal / no-cycle-legacy target fail closed;
 *   - duplicate target (branch): two terminals never reference the same
 *     predecessor fact_id;
 *   - directed cycle: following supersedes edges must terminate;
 *   - unique tip: exactly ONE cycle-bearing terminal is not referenced as
 *     a predecessor by any other terminal (the current chain tip); zero
 *     or multiple tips (disjoint chains) fail closed.
 *
 * A `legacy_cycle_anchor` (cycle-bearing, `supersedes_project_ready_ref`
 * omitted) is a read-only compatibility chain root; a newly written chain
 * root carries `null`. No-cycle legacy terminals are history-only and never
 * join the chain. The check is deterministic from the durable facts alone:
 * restart / rehydrate rebuilds the same chain and tip.
 *
 * @returns `undefined` when every discoverable relation closes, or a
 *   fail-closed message (the consuming write boundary wraps it into its
 *   typed no-write error before snapshot replacement).
 */
export function verifyProjectReadySuccessionGraphError(
  resultingFacts: readonly MesFactEnvelope[],
): string | undefined {
  const byId = new Map<string, MesFactEnvelope>();
  for (const fact of resultingFacts) byId.set(fact.fact_id, fact);
  const cycleBearer = (fact: MesFactEnvelope): boolean =>
    fact.fact_kind === 'project_ready' &&
    typeof fact.delivery_cycle_id === 'string' &&
    fact.delivery_cycle_id.length > 0;
  const terminals = resultingFacts.filter(cycleBearer);
  if (terminals.length === 0) return undefined; // no cycle-bearing terminal — nothing to chain

  // 1) Repeated cycle id: every cycle terminates exactly once.
  const cycleOwner = new Map<string, string>();
  for (const fact of terminals) {
    const cycle = fact.delivery_cycle_id!;
    const prior = cycleOwner.get(cycle);
    if (prior !== undefined && prior !== fact.fact_id) {
      return `repeated delivery_cycle_id ${JSON.stringify(cycle)} across project_ready terminals ${JSON.stringify(prior)} and ${JSON.stringify(fact.fact_id)}（RESULT_INVALID：每 cycle 只能有一个 terminal）`;
    }
    cycleOwner.set(cycle, fact.fact_id);
  }

  // 2) Successor edges: non-null supersedes refs resolve by exact fact_id to
  //    a legal cycle-bearing terminal with a DIFFERENT delivery_cycle_id; a
  //    predecessor is referenced at most once (no branch).
  const referencedPredecessors = new Map<string, string>();
  for (const fact of terminals) {
    const ref = fact.supersedes_project_ready_ref;
    if (ref === null || ref === undefined) continue; // chain root (null) / retained anchor (omitted)
    if (typeof ref !== 'string' || ref.length === 0) {
      return `project_ready terminal ${JSON.stringify(fact.fact_id)} carries a malformed supersedes_project_ready_ref（no-write）`;
    }
    if (ref === fact.fact_id) {
      return `project_ready terminal ${JSON.stringify(fact.fact_id)} supersedes itself（self-reference no-write）`;
    }
    const target = byId.get(ref);
    if (target === undefined) {
      return `project_ready terminal ${JSON.stringify(fact.fact_id)} supersedes_project_ready_ref ${JSON.stringify(ref)} does not resolve to a durable terminal in the resulting set（missing target no-write）`;
    }
    if (!cycleBearer(target)) {
      return `project_ready terminal ${JSON.stringify(fact.fact_id)} supersedes_project_ready_ref ${JSON.stringify(ref)} resolves to non-terminal / no-cycle legacy fact ${JSON.stringify(target.fact_id)}（non-terminal target no-write）`;
    }
    if (target.delivery_cycle_id === fact.delivery_cycle_id) {
      return `project_ready terminal ${JSON.stringify(fact.fact_id)} supersedes a same-cycle terminal ${JSON.stringify(target.fact_id)}（cross-cycle edge required，no-write）`;
    }
    const referrer = referencedPredecessors.get(ref);
    if (referrer !== undefined && referrer !== fact.fact_id) {
      return `project_ready terminals ${JSON.stringify(referrer)} and ${JSON.stringify(fact.fact_id)} both supersede ${JSON.stringify(ref)}（duplicate target / branch no-write）`;
    }
    referencedPredecessors.set(ref, fact.fact_id);
  }

  // 3) Directed cycle: following supersedes edges from any terminal must
  //    terminate (each terminal has at most one outgoing edge; a revisit
  //    means the successor relation loops).
  for (const start of terminals) {
    const seen = new Set<string>();
    let cursor = start;
    while (typeof cursor.supersedes_project_ready_ref === 'string') {
      if (seen.has(cursor.fact_id)) {
        return `project_ready succession contains a directed cycle through ${JSON.stringify(cursor.fact_id)}（directed cycle no-write）`;
      }
      seen.add(cursor.fact_id);
      const next = byId.get(cursor.supersedes_project_ready_ref);
      if (next === undefined) break; // missing target already reported above
      cursor = next;
    }
  }

  // 4) Unique chain tip: exactly one cycle-bearing terminal is not
  //    referenced as a predecessor by any other terminal. Zero tips (the
  //    directed-cycle case over the whole set) and multiple tips (disjoint
  //    chains) fail closed.
  const tips = terminals.filter((fact) => !referencedPredecessors.has(fact.fact_id));
  if (tips.length !== 1) {
    return `cycle-bearing project_ready terminals must form exactly one acyclic chain with a unique tip; found ${tips.length} tip(s)（zero/multiple tips no-write）`;
  }
  return undefined;
}
