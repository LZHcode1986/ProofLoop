/**
 * @proofloop/runtime — mechanical catalog family: PROJECT_READY terminal
 * (R5-B / G6, ADR-026 / E2E-33 / STATIC-41, tech-spec/contracts.md §5.1 /
 * §2.2.2, architecture #/entities/mes-operational-transaction-boundary /
 * delivery-cycle-semantics).
 *
 * Brain owns the `PROJECT_READY` authorization and the canonical planned
 * Stage-ID set from the active Project Stage Map; Runtime derives the current
 * delivery-cycle identity (when uniquely recoverable), the exact
 * same-cycle accepted-stage support closure, the current terminal chain tip
 * (`supersedes_project_ready_ref` — never caller-supplied) and the open
 * HUMAN_REQUIRED condition check. MES never reads the Project Stage Map and
 * never chooses the planned set.
 *
 * ONE high-level semantic event `project.ready` makes the materializer:
 *
 *   - validate the caller's `planned_stage_ids` (canonical /^S\d+$/,
 *     non-empty, de-duplicated, ascending stable);
 *   - resolve the unique current open delivery cycle over the planning
 *     bindings (ambiguous / missing → typed no-write);
 *   - fail closed when the current cycle has an open legal HUMAN_REQUIRED
 *     condition (resolveHumanRequiredConditions) — a terminal never closes a
 *     cycle with an unresolved user-decision pause (contracts §5.1);
 *   - resolve the current terminal chain tip (the unique non-referenced
 *     cycle-bearing `project_ready` terminal in the current durable set) and
 *     derive `supersedes_project_ready_ref` (null for a new chain root; the
 *     exact tip fact_id otherwise);
 *   - construct the deterministic terminal fact
 *     (`mes:fact:project_ready:<cycle>`) and PRE-VALIDATE its exact
 *     cycle-scoped accepted-stage support closure with the SAME oracle the
 *     store write boundary uses (verifyProjectReadySupportError over
 *     current ∪ submitted) — a missing/extra/unsorted planned set and a
 *     duplicate accepted-stage support are typed no-writes here, before the
 *     store re-checks them atomically.
 *
 * Replay is idempotent (byte-identical terminal collapses); a different
 * payload under the same deterministic terminal fact_id is a typed conflict.
 */
import {
  isCycleBearingPlanAcceptanceGeneration,
  resolvePlanAcceptanceGenerationTips,
} from './binding';
import { verifyProjectReadySupportError } from './terminal';
import { resolveHumanRequiredConditions } from './human-required-oracle';
import { canonicalStringify } from '../cli/proofloop-common';
import { materializeFail } from './materialization-error';
import type {
  MesSemanticEvent,
  MesSemanticEventCatalogEntry,
  MesSemanticEventHandler,
  MesSemanticEventMaterialization,
} from './semantic-event';
import type { MesFactEnvelope, MesGitBasis } from './types';

/** The one PROJECT_READY event kind. */
export const PROJECT_READY_EVENT_KIND = 'project.ready';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCycleAnchoredPlanningFact(fact: MesFactEnvelope): boolean {
  if (fact.fact_kind !== 'planning_verification_result' && fact.fact_kind !== 'plan_acceptance') return false;
  return isNonEmptyString(fact.plan_binding?.delivery_cycle_id);
}

function isClosedCycle(context: readonly MesFactEnvelope[], cycle: string, eventKind: string): boolean {
  const terminal = context.find(
    (fact) => fact.fact_kind === 'project_ready' && fact.delivery_cycle_id === cycle,
  );
  if (terminal === undefined) return false;
  if (!Array.isArray(terminal.planned_stage_ids) || terminal.planned_stage_ids.length === 0) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} legal terminal closure is not re-readable — no-write`, eventKind);
  }
  return true;
}

/** Resolve the unique current open delivery cycle (fail closed). */
function resolveCurrentOpenCycle(eventKind: string, current: readonly MesFactEnvelope[]): string {
  const openCycles = new Set<string>();
  for (const fact of current) {
    if (!isCycleAnchoredPlanningFact(fact)) continue;
    const cycle = fact.plan_binding?.delivery_cycle_id;
    if (isNonEmptyString(cycle) && !isClosedCycle(current, cycle, eventKind)) openCycles.add(cycle);
  }
  if (openCycles.size > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} cannot resolve a unique current open delivery cycle（multiple open cycles: ${[...openCycles].sort().join(', ')}）— no-write`,
      eventKind,
    );
  }
  if (openCycles.size === 1) return [...openCycles][0];
  materializeFail(
    'binding-mismatch',
    `semantic event ${eventKind} has no open delivery cycle — PROJECT_READY requires an accepted Plan generation, no-write`,
    eventKind,
  );
}

/** The unique current accepted generation of one (stage, cycle) cohort. */
function resolveCurrentAcceptedGeneration(
  eventKind: string,
  current: readonly MesFactEnvelope[],
  stageId: string,
  cycle: string,
): MesFactEnvelope | undefined {
  const resolved = resolvePlanAcceptanceGenerationTips(current);
  if (!resolved.ok) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} cannot resolve accepted-generation tips: ${resolved.error}`, eventKind);
  }
  const cohort = resolved.tips.filter(
    (fact) =>
      fact.scope?.stage_id === stageId &&
      fact.plan_binding?.binding_stage === 'accepted' &&
      fact.plan_binding.delivery_cycle_id === cycle &&
      isCycleBearingPlanAcceptanceGeneration(fact),
  );
  if (cohort.length > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds ${cohort.length} accepted generations for stage ${JSON.stringify(stageId)} cycle ${JSON.stringify(cycle)} — no-write`,
      eventKind,
    );
  }
  return cohort.length === 1 ? cohort[0] : undefined;
}

/** The terminal's git basis from the event binding (closed shape). */
function terminalGitBasis(event: MesSemanticEvent, eventKind: string): MesGitBasis {
  const basis = event.binding.git_basis;
  if (basis === undefined || typeof basis !== 'object' || basis === null) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a git_basis (integrated snapshot basis) — no-write`, eventKind);
  }
  const record = basis as unknown as Record<string, unknown>;
  const head = record.head;
  const branch = record.branch;
  const worktree = record.worktree;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) {
    materializeFail('invalid-field', `semantic event ${eventKind} git_basis.head must be a 40-char lowercase Git SHA — no-write`, eventKind);
  }
  if (!isNonEmptyString(branch)) {
    materializeFail('invalid-field', `semantic event ${eventKind} git_basis.branch must be a non-empty string — no-write`, eventKind);
  }
  if (!isNonEmptyString(worktree) || worktree.startsWith('/') || worktree.startsWith('./') || worktree.includes('../') || worktree.includes('\\')) {
    materializeFail('invalid-field', `semantic event ${eventKind} git_basis.worktree must be a canonical root-relative path — no-write`, eventKind);
  }
  return { head, branch, worktree };
}

/** Validate the caller's planned Stage-ID set (closed canonical form). */
function canonicalPlannedStageIds(event: MesSemanticEvent, eventKind: string): string[] {
  const raw = event.payload.planned_stage_ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a non-empty planned_stage_ids array — no-write`, eventKind);
  }
  const seen = new Set<string>();
  const planned: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !/^S\d+$/.test(id)) {
      materializeFail('invalid-field', `semantic event ${eventKind} planned_stage_ids entry ${JSON.stringify(id)} is not a canonical Stage ID (/^S\\d+$/) — no-write`, eventKind);
    }
    if (seen.has(id)) {
      materializeFail('invalid-field', `semantic event ${eventKind} planned_stage_ids contains duplicate ${JSON.stringify(id)} — no-write`, eventKind);
    }
    seen.add(id);
    planned.push(id);
  }
  for (let i = 1; i < planned.length; i++) {
    if (planned[i] <= planned[i - 1]) {
      materializeFail('invalid-field', `semantic event ${eventKind} planned_stage_ids must be ascending stable without duplicates — no-write`, eventKind);
    }
  }
  return planned;
}

/** Resolve the current terminal chain tip (unique non-referenced cycle-bearing terminal). */
function resolveTerminalChainTip(eventKind: string, current: readonly MesFactEnvelope[]): string | null {
  const terminals = current.filter(
    (fact) => fact.fact_kind === 'project_ready' && isNonEmptyString(fact.delivery_cycle_id),
  );
  if (terminals.length === 0) return null;
  const referenced = new Set<string>();
  for (const terminal of terminals) {
    const ref = terminal.supersedes_project_ready_ref;
    if (typeof ref === 'string' && ref.length > 0) referenced.add(ref);
  }
  const tips = terminals.filter((terminal) => !referenced.has(terminal.fact_id));
  if (tips.length === 0) {
    // The existing chain is broken (directed cycle) — fail closed instead of
    // guessing a predecessor; the store would reject it identically.
    materializeFail('binding-mismatch', `semantic event ${eventKind} existing terminal chain has no tip (directed cycle) — no-write`, eventKind);
  }
  if (tips.length > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} existing terminal chain has ${tips.length} tips — unable to derive a unique predecessor, no-write`,
      eventKind,
    );
  }
  return tips[0].fact_id;
}

/**
 * The ONE mechanical PROJECT_READY family handler.
 */
export const projectReadyHandler: MesSemanticEventHandler = (event, context) => {
  const eventKind = event.event_kind;
  const planned = canonicalPlannedStageIds(event, eventKind);
  const gitBasis = terminalGitBasis(event, eventKind);

  // Resolve the TARGET cycle: every cycle carried by the cycle-anchored
  // planning bindings. Once a terminal exists for that cycle, the cycle is
  // closed, so replay/conflict detection must still reach the terminal even
  // though there is no OPEN cycle left.
  const allCycles = new Set<string>();
  for (const fact of context.current) {
    if (!isCycleAnchoredPlanningFact(fact)) continue;
    const cycle = fact.plan_binding?.delivery_cycle_id;
    if (isNonEmptyString(cycle)) allCycles.add(cycle);
  }
  if (allCycles.size === 0) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} has no open delivery cycle — PROJECT_READY requires an accepted Plan generation, no-write`,
      eventKind,
    );
  }
  const openCycles = new Set<string>();
  for (const cycle of allCycles) {
    if (!isClosedCycle(context.current, cycle, eventKind)) openCycles.add(cycle);
  }
  let cycle: string;
  if (allCycles.size === 1) {
    cycle = [...allCycles][0];
  } else if (openCycles.size === 1) {
    cycle = [...openCycles][0];
  } else {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} cannot resolve a unique current delivery cycle（cycles: ${[...allCycles].sort().join(', ')}）— no-write`,
      eventKind,
    );
  }

  // Replay / conflict gate over the deterministic terminal fact identity
  // (one terminal per cycle). Byte-identical replay collapses; a different
  // payload under the same terminal identity is a typed conflict no-write.
  const terminalFactId = `mes:fact:project_ready:${cycle}`;
  const existingTerminal = context.current.find(
    (fact) => fact.fact_kind === 'project_ready' && fact.fact_id === terminalFactId,
  );
  if (existingTerminal !== undefined) {
    const samePayload =
      existingTerminal.planned_stage_ids !== undefined &&
      existingTerminal.planned_stage_ids.join(',') === planned.join(',') &&
      existingTerminal.delivery_cycle_id === cycle &&
      existingTerminal.git_basis !== undefined &&
      canonicalStringify(existingTerminal.git_basis) === canonicalStringify(gitBasis);
    if (samePayload) return { facts: [existingTerminal] }; // byte-identical replay
    materializeFail(
      'conflict',
      `semantic event ${eventKind} durable project_ready terminal ${JSON.stringify(terminalFactId)} already exists with a different payload — same terminal identity, different planned set / basis, no-write`,
      eventKind,
    );
  }

  // Open HUMAN_REQUIRED condition of the CURRENT cycle blocks the terminal
  // (contracts §5.1: "open HUMAN_REQUIRED condition 存在时 terminal write
  // fail closed"). Historical-cycle conditions never count.
  const openConditions = resolveHumanRequiredConditions(context.current, { currentCycleId: cycle });
  if (openConditions.length > 0) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} delivery cycle ${JSON.stringify(cycle)} has ${openConditions.length} open HUMAN_REQUIRED condition(s) (e.g. ${JSON.stringify(openConditions[0].finding.fact_id)}) — terminal write fail closed, no-write`,
      eventKind,
    );
  }

  // Every planned Stage must carry a durable accepted-Plan generation of the
  // SAME cycle (the terminal's support cohort closes against these).
  for (const stageId of planned) {
    resolveCurrentAcceptedGeneration(eventKind, context.current, stageId, cycle);
  }

  // Derive the terminal predecessor from the current chain (never caller-
  // supplied).
  const supersedes = resolveTerminalChainTip(eventKind, context.current);

  const terminal: MesFactEnvelope = {
    schema_version: 2,
    fact_id: terminalFactId,
    fact_kind: 'project_ready',
    created_by: 'brain',
    authority_refs: [...event.binding.authority_refs],
    planned_stage_ids: planned,
    delivery_cycle_id: cycle,
    supersedes_project_ready_ref: supersedes,
    git_basis: gitBasis,
  } as MesFactEnvelope;

  // PRE-VALIDATE the exact cycle-scoped accepted-stage support closure with
  // the SAME oracle the store write boundary uses (over current ∪ submitted),
  // so a missing/extra/unsorted planned set and a duplicate support are
  // typed no-writes here before the store re-checks them atomically.
  const closureError = verifyProjectReadySupportError(terminal, [...context.current, terminal]);
  if (closureError !== undefined) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} PROJECT_READY support closure failed: ${closureError} — no-write`,
      eventKind,
    );
  }

  return { facts: [terminal] };
};

/**
 * The ONE mechanical catalog entry of the PROJECT_READY family.
 */
export const PROJECT_READY_ENTRY: MesSemanticEventCatalogEntry = {
  event_kind: PROJECT_READY_EVENT_KIND,
  caller_fields: ['planned_stage_ids'],
  required_caller_fields: ['planned_stage_ids'],
  runtime_derived_fields: [
    'fact_id',
    'delivery_cycle_id',
    'supersedes_project_ready_ref',
    'generation',
    'accepted_stage_support',
    'planned_set_closure',
    'open_human_required',
  ],
  durable_outputs: [{ fact_kind: 'project_ready', mutability: 'immutable' }],
  reused_oracles: [
    'resolvePlanAcceptanceGenerationTips',
    'isCycleBearingPlanAcceptanceGeneration',
    'verifyProjectReadySupportError',
    'resolveHumanRequiredConditions',
  ],
  forbidden_caller_fields: [
    'fact_id',
    'delivery_cycle_id',
    'supersedes_project_ready_ref',
    'generation',
    'accepted_stage_support',
    'planned_set_closure',
    'open_human_required',
    'facts',
    'route',
    'next_action',
  ],
  failure_codes: ['invalid-field', 'binding-mismatch', 'conflict', 'invalid-derived-fact', 'unreadable'],
  replay_identity: ['delivery_cycle_id', 'planned_stage_ids'],
  canonicalization: [
    'fact_id = mes:fact:project_ready:<cycle> (deterministic; one terminal per cycle)',
    'delivery_cycle_id = unique current open cycle resolved from planning bindings',
    'supersedes_project_ready_ref = current unique terminal chain tip or null (never caller-supplied)',
    'planned set EXACTLY equals the same-cycle accepted-stage support set (verifyProjectReadySupportError)',
    'open HUMAN_REQUIRED condition blocks terminal write (fail closed)',
  ],
};