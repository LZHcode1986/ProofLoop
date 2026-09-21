/**
 * MES terminal read-only status consumer tests (S04-C-T01).
 *
 * # PO: PO-S04-C-01
 *
 * Exercises the pure terminal projection on
 * packages/runtime/src/mes/status.ts (projectTerminalDetail), the read-only
 * status consumer of the S04-A/B terminal machinery:
 *   - the projection deterministically derives the terminal view from the
 *     SAME validated durable MES facts as projectExecuteDetail: whether a
 *     durable `project_ready` terminal fact exists, its `planned_stage_ids`
 *     (ascending stable), the durable accepted-stage support set (ascending
 *     stable, machine-closed predicate isDurableAcceptedStageSupport reused
 *     from terminal.ts — never re-implemented) and whether the two exactly
 *     close (E2E-06 / contracts.md §5.1);
 *   - it NEVER fabricates a completion state: a broken closure (missing /
 *     extra / mismatched / duplicate support, a malformed or conflicting
 *     terminal fact, unknown fact kinds, malformed shapes) fails closed
 *     with a typed MesStatusError, and a durable set WITHOUT a terminal
 *     fact projects project_ready=false with the honest support set
 *     (STATIC-10 / HP-007);
 *   - the same durable facts re-read after restart (JSON round-trip) produce
 *     the identical view — no hidden state, no cache — and the output never
 *     contains next action / route / reasoning / Stage graph fields
 *     (HP-001 / STATIC-05 / STATIC-20 / HP-007);
 *   - L1 sparse / L2 detail views are untouched (regression is covered by
 *     the existing mes-status / mes-execute-status fixtures; E2E-16 remains
 *     green — PO-S04-C-02).
 *
 * All tests use only pure fact arrays (the same validated shape the store
 * write-through produces) and never the work clone's Git state. Imports the
 * compiled runtime dist (built by `npm run build`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { projectTerminalDetail, projectSparseStatus, MesStatusError, projectTerminalAdjunct, formatProjectTerminalAdjunct } from '../dist/mes/status';
import type { MesTerminalDetail, MesProjectTerminalAdjunct } from '../dist/mes/status';
import type { MesFactEnvelope } from '../dist/mes/types';

const DIGEST = 'd'.repeat(64);
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
const HEAD_D = 'd'.repeat(40);

/** A fully-shaped accepted `stage` support fact (S01/S02/S03 snapshot shape). */
function acceptedStageSupport(stage: string, head: string = HEAD_A): MesFactEnvelope {
  const planRef = `delivery/stages/${stage}/plan.md`;
  return {
    schema_version: 2,
    fact_id: `mes:fact:stage:${stage}:accepted`,
    fact_kind: 'stage',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.1'],
    scope: { stage_id: stage },
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: planRef,
      source_candidate_plan_ref: planRef,
      verification_result_ref: `mes:result:${stage}:planning-verification-1`,
      plan_digest: DIGEST,
    },
    git_basis: { head, branch: 'v2-subagent', worktree: '.' },
    result_ref: `mes:result:${stage}:stage-review-${head.slice(0, 10)}`,
  };
}

/** A pure scope-only stage fact — NOT an accepted-stage support. */
function scopeOnlyStage(stage: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:stage:${stage}:scope-only`,
    fact_kind: 'stage',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.1'],
    scope: { stage_id: stage },
  };
}

/** A canonical tech-spec-ref-bearing `project_ready` terminal fact. */
function projectReady(planned: string[], extra: Record<string, unknown> = {}): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:project_ready:1',
    fact_kind: 'project_ready',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
    planned_stage_ids: planned,
    git_basis: { head: HEAD_D, branch: 'v2-subagent', worktree: '.' },
    ...extra,
  };
}

/** Recursively collect every object key of a projection output. */
function allKeys(value: unknown, root = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [
    root ? `${root}.${key}` : key,
    ...allKeys(entry, root ? `${root}.${key}` : key),
  ]);
}

describe('MES terminal read-only status consumer (S04-C-T01)', () => {
  test('projects terminal state from durable facts without inventing readiness or routing', () => {
    // Exact closure: planned set == durable accepted-stage support set (all
    // different per-fact heads — the closure is set equality, not basis
    // equality). Extra unrelated facts (scope-only stage, non-support kinds)
    // never participate in the projection.
    const facts: MesFactEnvelope[] = [
      acceptedStageSupport('S01', HEAD_A),
      acceptedStageSupport('S02', HEAD_B),
      acceptedStageSupport('S03', HEAD_C),
      projectReady(['S01', 'S02', 'S03']),
      scopeOnlyStage('S99'),
    ];
    const view: MesTerminalDetail = projectTerminalDetail(facts);
    assert.equal(view.project_ready, true);
    assert.deepEqual(view.planned_stage_ids, ['S01', 'S02', 'S03']);
    assert.deepEqual(view.accepted_stage_support_ids, ['S01', 'S02', 'S03']);
    assert.equal(view.exact_closure, true);

    // A single-Stage planned set is legal (canonical, ascending, non-empty).
    const single = projectTerminalDetail([acceptedStageSupport('S01'), projectReady(['S01'])]);
    assert.equal(single.project_ready, true);
    assert.deepEqual(single.planned_stage_ids, ['S01']);
    assert.deepEqual(single.accepted_stage_support_ids, ['S01']);
    assert.equal(single.exact_closure, true);

    // Deterministic across fact order: the support set is projected ascending
    // stable regardless of input order (facts order never leaks through).
    const shuffled = [facts[3], facts[1], facts[4], facts[0], facts[2]];
    assert.deepEqual(projectTerminalDetail(shuffled), view, 'the terminal view must be order-independent');

    // Restart re-read: the same durable facts (JSON round-trip) must produce
    // the identical view — deterministic, no hidden state, no cache.
    assert.deepEqual(projectTerminalDetail(JSON.parse(JSON.stringify(facts))), view);

    // Read-only: the projection never mutates its input.
    const snapshot = JSON.parse(JSON.stringify(facts));
    projectTerminalDetail(facts);
    assert.deepEqual(facts, snapshot, 'the projection must not mutate its input');

    // No routing / next-action / reasoning / Stage graph anywhere in output.
    const keys = allKeys(view);
    for (const forbidden of ['next_action', 'next_task_id', 'route', 'reasoning', 'accepted_route_code', 'stage_graph']) {
      assert.equal(keys.includes(forbidden), false, `terminal view must not contain "${forbidden}"`);
    }

    // A durable set WITHOUT a terminal fact is an honest pre-terminal state:
    // project_ready=false, planned empty, the durable accepted-stage support
    // set still projected (no invented readiness, no invented closure).
    const preTerminal = projectTerminalDetail([
      acceptedStageSupport('S01', HEAD_A),
      acceptedStageSupport('S02', HEAD_B),
      scopeOnlyStage('S99'),
    ]);
    assert.equal(preTerminal.project_ready, false);
    assert.deepEqual(preTerminal.planned_stage_ids, []);
    assert.deepEqual(preTerminal.accepted_stage_support_ids, ['S01', 'S02']);
    assert.equal(preTerminal.exact_closure, false);

    // L1 stays untouched: the sparse projection keeps scope / phase /
    // required_skill plus non-zero sparse anomaly counters only; the
    // terminal consumer adds no counter / no routing field to L1.
    const sparse = projectSparseStatus({
      scope: 'S04',
      phase: 'EXECUTE',
      required_skill: 'proofloop-execute',
      counters: { replan: 0, blocked: 1 },
    });
    assert.deepEqual(sparse, { scope: 'S04', phase: 'EXECUTE', required_skill: 'proofloop-execute', counters: { blocked: 1 } });
    assert.equal(allKeys(sparse).some((k) => k.includes('next_action') || k === 'route' || k === 'reasoning'), false);
  });

  test('fails closed on a broken terminal closure without fabricating a completion state', () => {
    const s1 = acceptedStageSupport('S01', HEAD_A);
    const s2 = acceptedStageSupport('S02', HEAD_B);
    const s3 = acceptedStageSupport('S03', HEAD_C);

    // Missing support: a planned Stage with no durable accepted-stage support.
    assert.throws(
      () => projectTerminalDetail([s1, s2, s3, projectReady(['S01', 'S02', 'S03', 'S04'])]),
      (err: unknown) => err instanceof MesStatusError && err.message.includes('no durable accepted-stage support'),
      'planned Stage without accepted-stage support must fail closed',
    );
    // Extra support: a durable accepted-stage support outside the planned set.
    assert.throws(
      () => projectTerminalDetail([s1, s2, s3, projectReady(['S01', 'S02'])]),
      (err: unknown) => err instanceof MesStatusError && err.message.includes('not part of the planned set'),
      'extra accepted-stage support must fail closed',
    );
    // Mismatch: planned S02 while the durable support set carries S03.
    assert.throws(
      () => projectTerminalDetail([s1, s3, projectReady(['S01', 'S02'])]),
      MesStatusError,
      'planned/support mismatch must fail closed',
    );
    // Duplicate support for the same Stage id in the durable set.
    assert.throws(
      () => projectTerminalDetail([acceptedStageSupport('S01', HEAD_A), acceptedStageSupport('S01', HEAD_B), projectReady(['S01'])]),
      MesStatusError,
      'duplicate accepted-stage support must fail closed',
    );
    // A scope-only stage fact is NOT a support (machine-closed predicate).
    assert.throws(
      () => projectTerminalDetail([scopeOnlyStage('S01'), projectReady(['S01'])]),
      MesStatusError,
      'scope-only stage must not count as an accepted-stage support',
    );
  });

  test('fails closed on unknown kinds, malformed shapes and conflicting terminal facts', () => {
    // Non-array / non-envelope input fails closed (typed error).
    assert.throws(() => projectTerminalDetail(null as never), MesStatusError);
    assert.throws(() => projectTerminalDetail({ facts: [] } as never), MesStatusError);
    assert.throws(() => projectTerminalDetail([{ nope: 1 } as never]), MesStatusError);

    // Unknown fact kind fails closed.
    assert.throws(
      () => projectTerminalDetail([{ ...acceptedStageSupport('S01'), fact_kind: 'project_acceptance' as never }]),
      MesStatusError,
      'unknown fact kind fails closed',
    );

    // Malformed project_ready payloads fail closed: missing / empty /
    // non-canonical / duplicate / unsorted planned sets (the SAME closed
    // shape the envelope validator and the store closure enforce).
    for (const bad of [
      { planned_stage_ids: undefined },
      { planned_stage_ids: [] },
      { planned_stage_ids: ['s01'] },
      { planned_stage_ids: ['S01', 'S01'] },
      { planned_stage_ids: ['S02', 'S01'] },
    ]) {
      assert.throws(
        () => projectTerminalDetail([acceptedStageSupport('S01'), projectReady(['S02'], bad)]),
        MesStatusError,
        `malformed project_ready ${JSON.stringify(bad)} must fail closed`,
      );
    }

    // Duplicate payload terminal facts with the same planned set are a single
    // deterministic terminal state (immutability/persistence allows identical
    // payloads under distinct fact ids); the projection does not invent a
    // conflict where the durable relation is exactly closed.
    const okDuplicate = projectTerminalDetail([
      s1(),
      s2(),
      s3(),
      projectReady(['S01', 'S02', 'S03']),
      projectReady(['S01', 'S02', 'S03'], { fact_id: 'mes:fact:project_ready:2' }),
    ]);
    assert.equal(okDuplicate.project_ready, true);
    assert.deepEqual(okDuplicate.planned_stage_ids, ['S01', 'S02', 'S03']);
    assert.equal(okDuplicate.exact_closure, true);

    // CONFLICTING terminal facts (two project_ready facts with DIFFERENT
    // planned sets) are inconsistent with exact closure — the projection
    // never picks one silently and fails closed instead.
    assert.throws(
      () =>
        projectTerminalDetail([
          s1(),
          s2(),
          s3(),
          projectReady(['S01', 'S02', 'S03']),
          projectReady(['S01', 'S02'], { fact_id: 'mes:fact:project_ready:2' }),
        ]),
      MesStatusError,
      'conflicting project_ready facts must fail closed',
    );
  });

  // CV repair (mes:fact:finding:S04:S04-C:cv-1, disposition ACCEPTED
  // IMPLEMENTATION_DEFECT): the projection must fail closed TYPED on any
  // fact the envelope validator would reject (unknown fields, inherited
  // binding fields on project_ready, malformed per-fact git_basis /
  // created_by / authority_refs, partial accepted stage shapes) instead
  // of projecting readiness from or deriving an untyped TypeError on
  // shapes outside the validated durable envelope (STATIC-10 / HP-007).
  test('fails closed on malformed or unknown-field inputs the envelope validator would reject (CV repair)', () => {
    const s1 = acceptedStageSupport('S01', HEAD_A);

    // Unknown fields (e.g. routing tokens) must fail closed typed, never
    // be ignored while a readiness view is projected.
    assert.throws(
      () => projectTerminalDetail([s1, { ...projectReady(['S01']), next_action: 'run' } as never]),
      MesStatusError,
      'unknown field on project_ready must fail closed',
    );

    // project_ready must not inherit Stage/Work/Result/Plan binding or
    // planning-verification metadata (E2E-06): every presence fails
    // closed even when the planned-set closure would otherwise hold.
    for (const inherited of [
      { scope: { stage_id: 'S01' } },
      { work_id: 'mes:work:S01:1' },
      { result_ref: 'mes:result:S01:1' },
      {
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: 'delivery/stages/S01/plan.md',
          source_candidate_plan_ref: 'delivery/stages/S01/plan.md',
          verification_result_ref: 'mes:result:S01:planning-verification-1',
        },
      },
      { verifier_role: 'stage-plan-verifier' },
      { action_token: 'tok' },
    ]) {
      assert.throws(
        () => projectTerminalDetail([s1, projectReady(['S01'], inherited)]),
        MesStatusError,
        `project_ready with ${Object.keys(inherited)[0]} must fail closed`,
      );
    }

    // Malformed per-fact binding shape fails closed: broken git_basis,
    // non-brain created_by, non-canonical authority_refs.
    for (const bad of [
      { git_basis: undefined },
      { git_basis: null },
      { git_basis: { branch: 'v2-subagent', worktree: '.' } }, // missing head
      { created_by: 'agent' },
      { authority_refs: ['PRD.md#FR-003'] },
    ]) {
      assert.throws(
        () => projectTerminalDetail([s1, projectReady(['S01'], bad)]),
        MesStatusError,
        `malformed project_ready ${JSON.stringify(bad)} must fail closed typed`,
      );
    }

    // Partial accepted-stage shapes (envelope-invalid all-or-nothing) fail
    // closed rather than being silently ignored or crashing untyped.
    assert.throws(
      () => projectTerminalDetail([{ ...acceptedStageSupport('S01'), result_ref: undefined } as never, projectReady(['S01'])]),
      MesStatusError,
      'partial accepted stage support must fail closed',
    );

    // The failure is ALWAYS the typed MesStatusError — never an untyped
    // TypeError leaking to the caller.
    assert.throws(
      () => projectTerminalDetail([{ ...projectReady(['S01']), scope: { stage_id: 'S01' } } as never, s1]),
      (err: unknown) => err instanceof MesStatusError && !(err instanceof TypeError),
    );
  });
});

function s1(): MesFactEnvelope {
  return acceptedStageSupport('S01', HEAD_A);
}
function s2(): MesFactEnvelope {
  return acceptedStageSupport('S02', HEAD_B);
}
function s3(): MesFactEnvelope {
  return acceptedStageSupport('S03', HEAD_C);
}

// ============================================================================
// S05-C-T01 / PO-S05-C-02 — terminal status current-cycle-only
// ============================================================================
describe('MES terminal status current-cycle-only projection (S05-C-T01)', () => {
  // PO-S05-C-02: the terminal status selects ONLY the current cycle — the
  // current PROJECT_READY accepts exactly the terminal matching the current
  // cycle ID; historical/legacy terminals (no cycle field) do not
  // participate in current phase/route and are attached as historical detail
  // only when no new cycle has started (mes.md / contracts §2.3 / §5.1,
  // architecture delivery-cycle-semantics, E2E-23 / STATIC-30). The
  // historical/current distinction NEVER depends on set containment, Git
  // HEAD recency or insertion order — the opaque cycle ID is the identity.
  const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';

  function cycleSupport(stage: string, head: string = HEAD_B): MesFactEnvelope {
    return {
      ...acceptedStageSupport(stage, head),
      fact_id: `mes:fact:stage:${stage}:accepted:cycle`,
      plan_binding: {
        ...acceptedStageSupport(stage, head).plan_binding!,
        delivery_cycle_id: CYCLE,
      },
    };
  }
  function cycleTerminal(planned: string[], factId = 'mes:fact:project_ready:cycle'): MesFactEnvelope {
    return projectReady(planned, { fact_id: factId, delivery_cycle_id: CYCLE });
  }

  // Current-cycle planning bindings (PVR candidate + PA accepted) — the
  // in-flight planning facts that RESOLVE the current cycle (EC-2: cycle
  // identity comes from PVR/PA first, never from historical cycle-bearing
  // accepted-stage / PROJECT_READY facts).
  const PLAN_REF = 'delivery/stages/S05/plan.md';
  const PLAN_DIGEST = 'c'.repeat(64);
  const BASIS = { head: HEAD_B, branch: 'v2-subagent', worktree: '.' };
  const CANDIDATE = {
    binding_stage: 'candidate' as const,
    candidate_plan_ref: PLAN_REF,
    accepted_plan_ref: null,
    verdict: 'PLAN_READY' as const,
    plan_digest: PLAN_DIGEST,
    delivery_cycle_id: CYCLE,
  };
  const ACCEPTED = {
    binding_stage: 'accepted' as const,
    accepted_plan_ref: PLAN_REF,
    source_candidate_plan_ref: PLAN_REF,
    verification_result_ref: 'mes:result:S05:planning-verification-1',
    plan_digest: PLAN_DIGEST,
    delivery_cycle_id: CYCLE,
  };
  function cyclePvr(): MesFactEnvelope {
    return {
      schema_version: 2,
      fact_id: 'mes:fact:planning_verification_result:S05:cycle-1',
      fact_kind: 'planning_verification_result',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: 'S05' },
      work_id: 'mes:work:S05:planning:1',
      result_ref: 'mes:result:S05:planning-verification-1',
      verifier_role: 'stage-plan-verifier',
      action_token: 's05-spv-1',
      plan_binding: CANDIDATE,
      git_basis: BASIS,
    };
  }
  function cyclePa(): MesFactEnvelope {
    return {
      schema_version: 2,
      fact_id: 'mes:fact:plan_acceptance:S05:cycle-1',
      fact_kind: 'plan_acceptance',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: 'S05' },
      plan_binding: ACCEPTED,
      git_basis: BASIS,
    };
  }
  test('projects ONLY the current-cycle terminal when legacy and current cohorts coexist', () => {
    // E2E-23 + EC-2: the LEGACY cohort (no cycle, planned [S01,S02]) and the
    // CURRENT cohort (cycle CYCLE via the in-flight PVR/PA planning
    // bindings, planned [S01,S02,S03]) coexist in one durable set. The
    // status layer resolves the current cycle from the PVR/PA planning
    // bindings FIRST and projects ONLY the current-cycle cohort — the
    // legacy terminal never participates (its planned set would differ),
    // historical cycle-bearing facts never poison selection.
    const facts: MesFactEnvelope[] = [
      acceptedStageSupport('S01', HEAD_A),
      acceptedStageSupport('S02', HEAD_B),
      projectReady(['S01', 'S02']), // legacy terminal — history only
      cyclePvr(),
      cyclePa(),
      cycleSupport('S01', HEAD_A),
      cycleSupport('S02', HEAD_B),
      cycleSupport('S03', HEAD_C),
      cycleTerminal(['S01', 'S02', 'S03']), // current terminal
    ];
    const view: MesTerminalDetail = projectTerminalDetail(facts);
    assert.equal(view.project_ready, true);
    assert.deepEqual(view.planned_stage_ids, ['S01', 'S02', 'S03'], 'current cohort wins, legacy planned set never participates');
    assert.deepEqual(view.accepted_stage_support_ids, ['S01', 'S02', 'S03']);
    assert.equal(view.exact_closure, true);

    // The caller may pin the current cycle explicitly — same view.
    assert.deepEqual(projectTerminalDetail(facts, { currentCycleId: CYCLE }), view);

    // Order-independent: insertion order never decides the current cohort.
    const shuffled = [facts[8], facts[3], facts[0], facts[4], facts[6], facts[1], facts[7], facts[2], facts[5]];
    assert.deepEqual(projectTerminalDetail(shuffled), view);

    // Restart re-read (JSON round-trip) is identical.
    assert.deepEqual(projectTerminalDetail(JSON.parse(JSON.stringify(facts))), view);

    // No routing / next-action / reasoning / Stage graph anywhere.
    const keys = allKeys(view);
    for (const forbidden of ['next_action', 'next_task_id', 'route', 'reasoning', 'accepted_route_code', 'stage_graph']) {
      assert.equal(keys.includes(forbidden), false, `terminal view must not contain "${forbidden}"`);
    }
  });

  test('attaches a legacy terminal as historical detail only when no new cycle has started', () => {
    // No cycle-carrying fact → legacy history-only cohort: the legacy
    // terminal still closes over the no-cycle supports (mes.md: 新 cycle 未开始
    // 时可暴露历史 ready detail).
    const legacy = [
      acceptedStageSupport('S01', HEAD_A),
      acceptedStageSupport('S02', HEAD_B),
      projectReady(['S01', 'S02']),
    ];
    const legacyView = projectTerminalDetail(legacy);
    assert.equal(legacyView.project_ready, true);
    assert.deepEqual(legacyView.planned_stage_ids, ['S01', 'S02']);
    assert.deepEqual(legacyView.accepted_stage_support_ids, ['S01', 'S02']);
    assert.equal(legacyView.exact_closure, true);

    // A current cycle has STARTED (PVR/PA planning bindings carry CYCLE)
    // but no current terminal yet: the legacy terminal must NOT
    // participate in current phase/route — the view is the honest
    // current-cycle pre-terminal state with the current-cycle support set
    // (no invented readiness).
    const view = projectTerminalDetail([
      acceptedStageSupport('S01', HEAD_A),
      projectReady(['S01']), // legacy terminal — history only
      cyclePvr(),
      cyclePa(),
      cycleSupport('S05', HEAD_D),
    ]);
    assert.equal(view.project_ready, false);
    assert.deepEqual(view.planned_stage_ids, []);
    assert.deepEqual(view.accepted_stage_support_ids, ['S05']);
    assert.equal(view.exact_closure, false);
  });

  test('fails closed on duplicate same-cycle terminals, conflicting terminals and cross-cycle planning ambiguity (EC-5 / CV S05-C-cv-1)', () => {
    // (EC-5) Duplicate CURRENT-cycle PROJECT_READY terminals are duplicate
    // terminal provenance — CONFLICTING or IDENTICAL payloads fail typed
    // AUTHORITY_GAP; the projection never picks one silently. The legal
    // current cohort is exactly ONE terminal fact.
    assert.throws(
      () =>
        projectTerminalDetail([
          cyclePvr(),
          cyclePa(),
          cycleSupport('S01', HEAD_A),
          cycleSupport('S02', HEAD_B),
          cycleTerminal(['S01', 'S02']),
          cycleTerminal(['S01'], 'mes:fact:project_ready:cycle-2'),
        ]),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'conflicting current-cycle terminals must fail typed AUTHORITY_GAP',
    );
    assert.throws(
      () =>
        projectTerminalDetail([
          cyclePvr(),
          cyclePa(),
          cycleSupport('S01', HEAD_A),
          cycleTerminal(['S01']),
          cycleTerminal(['S01'], 'mes:fact:project_ready:cycle-2'),
        ]),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'identical same-cycle terminal payloads under distinct fact ids are duplicate provenance (EC-5)',
    );

    // A single same-cycle terminal closes legally (legal current cohort).
    const legal = projectTerminalDetail([
      cyclePvr(),
      cyclePa(),
      cycleSupport('S01', HEAD_A),
      cycleTerminal(['S01']),
    ]);
    assert.equal(legal.project_ready, true);
    assert.deepEqual(legal.planned_stage_ids, ['S01']);
    assert.equal(legal.exact_closure, true);

    // Cross-cycle AMBIGUITY among the in-flight planning bindings (two
    // distinct delivery_cycle_id values in PVR/PA) — the status layer never
    // picks one silently (AUTHORITY_GAP).
    const crossPa = { ...cyclePa(), fact_id: 'mes:fact:plan_acceptance:S05:cycle-other', plan_binding: { ...ACCEPTED, delivery_cycle_id: 'cycle-other' } };
    assert.throws(
      () =>
        projectTerminalDetail([
          cyclePvr(),
          crossPa,
          cycleSupport('S01', HEAD_A),
          cycleTerminal(['S01', 'S02']),
        ]),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'cross-cycle planning bindings must fail closed AUTHORITY_GAP',
    );

    // A FOREIGN cycle in a historical accepted-stage support or a
    // historical terminal never poisons the current selection (EC-2):
    // the current cycle resolves from the PVR/PA bindings alone. (S06-A
    // cv-6 calibration, handoff §3) The pre-oracle fixture carried a
    // MALFORMED foreign-cycle terminal (planned [S01,S02] with only S01
    // support — its own relation non-closing) and expected it to be ignored
    // as history; under the currentness oracle “a malformed or half-new
    // submitted terminal is not treated as history” and a retained anchor
    // keeps “its own support closure valid” (contracts §2.3 / architecture
    // delivery-cycle-semantics). The fixture is rewritten to a LEGAL
    // retained/history relation: the foreign-cycle terminal's own support
    // cohort closes (planned [S01] == its cycle-other support [S01]) and it
    // is the chain ROOT the current terminal supersedes — one acyclic
    // chain, unique tip = current, and the foreign-cycle facts never poison
    // the current cohort selection.
    const foreignAnchor: MesFactEnvelope = {
      ...cycleTerminal(['S01'], 'mes:fact:project_ready:foreign'),
      delivery_cycle_id: 'cycle-other',
    };
    const poisonFree = projectTerminalDetail([
      cyclePvr(),
      cyclePa(),
      { ...cycleSupport('S01', HEAD_A), plan_binding: { ...cycleSupport('S01', HEAD_A).plan_binding!, delivery_cycle_id: 'cycle-other' } },
      foreignAnchor,
      cycleSupport('S05', HEAD_D),
      { ...cycleTerminal(['S05']), supersedes_project_ready_ref: foreignAnchor.fact_id },
    ]);
    assert.equal(poisonFree.project_ready, true);
    assert.deepEqual(poisonFree.planned_stage_ids, ['S05'], 'legal foreign-cycle retained history never poisons current cohort selection');
    assert.deepEqual(poisonFree.accepted_stage_support_ids, ['S05']);
    assert.equal(poisonFree.exact_closure, true);
  });
});

// ============================================================================
// S06-A-T01 / PO-S06-A-01 + PO-S06-A-02 — terminal currentness oracle +
// projection-only project_terminal adjunct (supersedes-chain tip /
// legacy_cycle_anchor root / open-cycle PRE_TERMINAL / CURRENT_PROJECT_READY /
// HISTORICAL_PROJECT_READY closed shape with exact identity + closure).
// ============================================================================
describe('MES terminal currentness oracle + project_terminal adjunct (S06-A-T01)', () => {
  const CYCLE_OLD = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
  const CYCLE_NEW = 'cycle-208cbbe8d8e946479bb746f318b56178';
  const PLAN_OLD = 'delivery/stages/S05/plan.md';
  const PLAN_NEW = 'delivery/stages/S06/plan.md';
  const DIGEST_NEW = 'c'.repeat(64);
  const BASIS = { head: HEAD_A, branch: 'v2-subagent', worktree: '.' };

  function pvr(cycle: string, stage: string, tag: string): MesFactEnvelope {
    const plan = stage === 'S05' ? PLAN_OLD : PLAN_NEW;
    return {
      schema_version: 2,
      fact_id: `mes:fact:planning_verification_result:${stage}:${tag}`,
      fact_kind: 'planning_verification_result',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: stage },
      work_id: `mes:work:${stage}:planning:${tag}`,
      result_ref: `mes:result:${stage}:planning-verification-${tag}`,
      verifier_role: 'stage-plan-verifier',
      action_token: `s06-spv-${tag}`,
      plan_binding: {
        binding_stage: 'candidate' as const,
        candidate_plan_ref: plan,
        accepted_plan_ref: null,
        verdict: 'PLAN_READY' as const,
        plan_digest: DIGEST_NEW,
        delivery_cycle_id: cycle,
      },
      git_basis: BASIS,
    };
  }
  function pa(cycle: string, stage: string, tag: string): MesFactEnvelope {
    const plan = stage === 'S05' ? PLAN_OLD : PLAN_NEW;
    return {
      schema_version: 2,
      fact_id: `mes:fact:plan_acceptance:${stage}:${tag}`,
      fact_kind: 'plan_acceptance',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: stage },
      supersedes_plan_acceptance_ref: null,
      plan_binding: {
        binding_stage: 'accepted' as const,
        accepted_plan_ref: plan,
        source_candidate_plan_ref: plan,
        verification_result_ref: `mes:result:${stage}:planning-verification-${tag}`,
        plan_digest: DIGEST_NEW,
        delivery_cycle_id: cycle,
      },
      git_basis: BASIS,
    };
  }
  function support(cycle: string, stage: string, tag: string): MesFactEnvelope {
    const plan = stage === 'S05' ? PLAN_OLD : PLAN_NEW;
    return {
      schema_version: 2,
      fact_id: `mes:fact:stage:${stage}:accepted:${tag}`,
      fact_kind: 'stage',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.1.1'],
      scope: { stage_id: stage },
      plan_binding: {
        binding_stage: 'accepted' as const,
        accepted_plan_ref: plan,
        source_candidate_plan_ref: plan,
        verification_result_ref: `mes:result:${stage}:planning-verification-${tag}`,
        plan_digest: DIGEST_NEW,
        delivery_cycle_id: cycle,
      },
      git_basis: BASIS,
      result_ref: `mes:result:${stage}:stage-review-${tag}`,
    };
  }
  function terminal(cycle: string, planned: string[], factId: string, supersedes?: string | null): MesFactEnvelope {
    const extra: Record<string, unknown> = {};
    if (supersedes !== undefined) extra.supersedes_project_ready_ref = supersedes;
    return {
      schema_version: 2,
      fact_id: factId,
      fact_kind: 'project_ready',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
      planned_stage_ids: planned,
      delivery_cycle_id: cycle,
      git_basis: BASIS,
      ...extra,
    };
  }

  test('supersedes-chain tip: projectTerminalDetail projects ONLY the validated chain-tip cohort', () => {
    // Two closed cycles forming one succession chain (OLD root supersedes null,
    // NEW tip supersedes the OLD fact_id): zero open cycles → the unique
    // validated tip (NEW) is the current legal PROJECT_READY cohort.
    const root = terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:old', null);
    const tip = terminal(CYCLE_NEW, ['S06'], 'mes:fact:project_ready:new', root.fact_id);
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_OLD, 'S05', 'a'), pa(CYCLE_OLD, 'S05', 'a'), support(CYCLE_OLD, 'S05', 'a'), root,
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'), support(CYCLE_NEW, 'S06', 'b'), tip,
    ];
    const view = projectTerminalDetail(facts);
    assert.equal(view.project_ready, true);
    assert.deepEqual(view.planned_stage_ids, ['S06'], 'tip cohort only');
    assert.deepEqual(view.accepted_stage_support_ids, ['S06']);
    assert.equal(view.exact_closure, true);
  });

  test('legacy_cycle_anchor root: a retained cycle-bearing terminal without supersedes is the chain root and current tip', () => {
    // Retained pre-update terminal shape: top-level delivery_cycle_id present,
    // supersedes_project_ready_ref OMITTED (legacy_cycle_anchor). It is both the
    // chain root and the unique tip → CURRENT_PROJECT_READY with its identity.
    const anchor = terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:2');
    assert.equal('supersedes_project_ready_ref' in anchor, false, 'legacy_cycle_anchor omits the predecessor field');
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_OLD, 'S05', 'a'), pa(CYCLE_OLD, 'S05', 'a'), support(CYCLE_OLD, 'S05', 'a'), anchor,
    ];
    const view = projectTerminalDetail(facts);
    assert.equal(view.project_ready, true);
    assert.deepEqual(view.planned_stage_ids, ['S05']);
    assert.equal(view.exact_closure, true);
    const adjunct = projectTerminalAdjunct(facts);
    assert.deepEqual(adjunct, {
      state: 'CURRENT_PROJECT_READY',
      project_ready: true,
      project_ready_ref: 'mes:fact:project_ready:2',
      delivery_cycle_id: CYCLE_OLD,
      planned_stage_ids: ['S05'],
      accepted_stage_support_ids: ['S05'],
      exact_closure: true,
    });
    assert.equal(formatProjectTerminalAdjunct(adjunct!), 'project_terminal=CURRENT_PROJECT_READY');
  });

  test('open-cycle PRE_TERMINAL: a unique open cycle projects PRE_TERMINAL even when all accepted-stage supports exist', () => {
    // Open determination depends ONLY on "no legal matching terminal", never on
    // accepted-stage support completeness — the cycle stays open (PRE_TERMINAL)
    // and projectTerminalDetail keeps the honest pre-terminal support set.
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'), support(CYCLE_NEW, 'S06', 'b'),
    ];
    const adjunct = projectTerminalAdjunct(facts);
    assert.deepEqual(adjunct, {
      state: 'PRE_TERMINAL',
      project_ready: false,
      delivery_cycle_id: CYCLE_NEW,
      planned_stage_ids: [],
      accepted_stage_support_ids: ['S06'],
      exact_closure: false,
    });
    assert.equal('project_ready_ref' in (adjunct as object), false, 'PRE_TERMINAL omits project_ready_ref');
    assert.equal(formatProjectTerminalAdjunct(adjunct!), 'project_terminal=PRE_TERMINAL');
    const view = projectTerminalDetail(facts);
    assert.equal(view.project_ready, false);
    assert.deepEqual(view.accepted_stage_support_ids, ['S06']);
    assert.equal(view.exact_closure, false);
  });

  test('CURRENT_PROJECT_READY adjunct shape fixture: exact terminal/cycle identity + exact closure', () => {
    const tip = terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:old', null);
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_OLD, 'S05', 'a'), pa(CYCLE_OLD, 'S05', 'a'), support(CYCLE_OLD, 'S05', 'a'), tip,
    ];
    const adjunct = projectTerminalAdjunct(facts);
    assert.deepEqual(adjunct, {
      state: 'CURRENT_PROJECT_READY',
      project_ready: true,
      project_ready_ref: 'mes:fact:project_ready:old',
      delivery_cycle_id: CYCLE_OLD,
      planned_stage_ids: ['S05'],
      accepted_stage_support_ids: ['S05'],
      exact_closure: true,
    });
    // JSON round-trip: the adjunct is a plain durable-fact projection.
    assert.deepEqual(JSON.parse(JSON.stringify(adjunct)), adjunct);
  });

  test('HISTORICAL_PROJECT_READY shape fixture: a valid no-cycle legacy terminal is historical detail only', () => {
    // No new cycle has started: a valid legacy (no-cycle) terminal is attached
    // as HISTORICAL detail with its exact identity/closure; delivery_cycle_id is
    // omitted for legacy HISTORICAL (no routing authority).
    const facts: MesFactEnvelope[] = [
      acceptedStageSupport('S01', HEAD_A),
      acceptedStageSupport('S02', HEAD_B),
      projectReady(['S01', 'S02']),
    ];
    const adjunct = projectTerminalAdjunct(facts);
    assert.deepEqual(adjunct, {
      state: 'HISTORICAL_PROJECT_READY',
      project_ready: true,
      project_ready_ref: 'mes:fact:project_ready:1',
      planned_stage_ids: ['S01', 'S02'],
      accepted_stage_support_ids: ['S01', 'S02'],
      exact_closure: true,
    });
    assert.equal('delivery_cycle_id' in (adjunct as object), false, 'legacy HISTORICAL omits delivery_cycle_id');
  });

  test('adjunct fails closed typed AUTHORITY_GAP on duplicate same-cycle terminals and broken chains', () => {
    // Duplicate current-cycle terminals (two same-cycle terminal facts) are
    // duplicate terminal provenance → AUTHORITY_GAP for the adjunct too.
    assert.throws(
      () =>
        projectTerminalAdjunct([
          pvr(CYCLE_OLD, 'S05', 'a'), pa(CYCLE_OLD, 'S05', 'a'), support(CYCLE_OLD, 'S05', 'a'),
          terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:old', null),
          terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:old-2', null),
        ]),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'two same-cycle terminals must fail closed AUTHORITY_GAP',
    );
    // A successor whose supersedes_project_ready_ref misses the retained target
    // is a broken chain → AUTHORITY_GAP (never guessed).
    assert.throws(
      () =>
        projectTerminalAdjunct([
          pvr(CYCLE_OLD, 'S05', 'a'), pa(CYCLE_OLD, 'S05', 'a'), support(CYCLE_OLD, 'S05', 'a'),
          terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:old', null),
          pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'), support(CYCLE_NEW, 'S06', 'b'),
          terminal(CYCLE_NEW, ['S06'], 'mes:fact:project_ready:new', 'mes:fact:project_ready:ghost'),
        ]),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'broken supersedes target must fail closed AUTHORITY_GAP',
    );
  });

  test('a legal chain tip / retained legacy_cycle_anchor whose cycle has NO PVR/PA planning binding in the store is still selected as current (repair CV S06-A-cv-1)', () => {
    // CV S06-A-cv-1 counterexample: the chain ROOT (retained legacy_cycle_anchor
    // carrying cycle CYCLE_OLD) has NO cycle-bearing PVR/PA binding for its
    // cycle in this store — only the tip's cycle (CYCLE_NEW) is planned. The
    // participating tip supersedes the anchor; whole-chain validation and tip
    // selection must still include the anchor so the legal tip is current.
    const anchor = terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:old'); // supersedes OMITTED → legacy_cycle_anchor
    const tip = terminal(CYCLE_NEW, ['S06'], 'mes:fact:project_ready:new', anchor.fact_id);
    const facts: MesFactEnvelope[] = [
      support(CYCLE_OLD, 'S05', 'a'),
      anchor,
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'), support(CYCLE_NEW, 'S06', 'b'),
      tip,
    ];
    const view = projectTerminalDetail(facts);
    assert.equal(view.project_ready, true);
    assert.deepEqual(view.planned_stage_ids, ['S06']);
    assert.deepEqual(view.accepted_stage_support_ids, ['S06']);
    assert.equal(view.exact_closure, true);
    const adjunct = projectTerminalAdjunct(facts);
    assert.deepEqual(adjunct, {
      state: 'CURRENT_PROJECT_READY',
      project_ready: true,
      project_ready_ref: 'mes:fact:project_ready:new',
      delivery_cycle_id: CYCLE_NEW,
      planned_stage_ids: ['S06'],
      accepted_stage_support_ids: ['S06'],
      exact_closure: true,
    });
  });

  test('a lone retained legacy_cycle_anchor with zero open cycles is the current legal PROJECT_READY (repair CV S06-A-cv-1)', () => {
    // No PVR/PA binding anywhere and no newer terminal: the retained
    // cycle-bearing anchor alone forms the validated single-node chain and
    // supplies current PROJECT_READY (oracle Completed-cycle selection).
    const anchor = terminal(CYCLE_OLD, ['S05'], 'mes:fact:project_ready:2'); // cycle-bearing, supersedes omitted
    const facts: MesFactEnvelope[] = [support(CYCLE_OLD, 'S05', 'a'), anchor];
    const view = projectTerminalDetail(facts);
    assert.equal(view.project_ready, true);
    assert.deepEqual(view.planned_stage_ids, ['S05']);
    assert.deepEqual(view.accepted_stage_support_ids, ['S05']);
    assert.equal(view.exact_closure, true);
    const adjunct = projectTerminalAdjunct(facts);
    assert.deepEqual(adjunct, {
      state: 'CURRENT_PROJECT_READY',
      project_ready: true,
      project_ready_ref: 'mes:fact:project_ready:2',
      delivery_cycle_id: CYCLE_OLD,
      planned_stage_ids: ['S05'],
      accepted_stage_support_ids: ['S05'],
      exact_closure: true,
    });
  });

  test('a malformed connected anchor inside the chain domain fails closed AUTHORITY_GAP (repair CV S06-A-cv-2)', () => {
    // cv-2 failure family: the anchor (cycle CYCLE_OLD, supersedes omitted) is
    // connected to the participating tip via supersedes, so it joins the chain
    // domain — but its OWN relation is malformed: planned ['S05','S06'] while
    // only S05 has a cycle-scoped accepted-stage support. Closure validation
    // must cover every terminal in the chain domain, not just participating.
    const anchor = terminal(CYCLE_OLD, ['S05', 'S06'], 'mes:fact:project_ready:old');
    const tip = terminal(CYCLE_NEW, ['S06'], 'mes:fact:project_ready:new', anchor.fact_id);
    const facts: MesFactEnvelope[] = [
      support(CYCLE_OLD, 'S05', 'a'),
      anchor,
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'), support(CYCLE_NEW, 'S06', 'b'),
      tip,
    ];
    assert.throws(
      () => projectTerminalDetail(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'a malformed connected anchor must fail closed AUTHORITY_GAP',
    );
    assert.throws(
      () => projectTerminalAdjunct(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'adjunct: a malformed connected anchor must fail closed AUTHORITY_GAP',
    );
  });

  test('a disconnected cycle-bearing terminal with malformed relation fails closed AUTHORITY_GAP when it is the only cycle-bearing terminal (repair CV S06-A-cv-2)', () => {
    // cv-2 failure family: zero participating terminals (no PVR/PA planning
    // binding for any cycle) → the whole cycle-bearing set becomes the chain
    // domain → its terminals must each close against their own cycle-scoped
    // supports. This fixture plans ['S05','S06'] but only S05 has a support.
    const broken = terminal(CYCLE_OLD, ['S05', 'S06'], 'mes:fact:project_ready:2');
    const facts: MesFactEnvelope[] = [support(CYCLE_OLD, 'S05', 'a'), broken];
    assert.throws(
      () => projectTerminalDetail(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'a malformed lone cycle-bearing terminal must fail closed AUTHORITY_GAP',
    );
    assert.throws(
      () => projectTerminalAdjunct(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'adjunct: a malformed lone cycle-bearing terminal must fail closed AUTHORITY_GAP',
    );
  });

  test('an independent LEGAL cycle-bearing terminal disjoint from the participating chain fails closed AUTHORITY_GAP on whole-graph validation (repair CV S06-A-cv-3)', () => {
    // cv-3 counterexample: a participating current terminal (cycle CYCLE_NEW,
    // supersedes null) exists AND an independent cycle-bearing terminal (cycle
    // CYCLE_OTHER with a LEGAL own relation, no supersedes edges in either
    // direction) coexists in the same durable set. Per oracle Succession
    // relation, ALL legal cycle-bearing terminals in the resulting durable set
    // must form one acyclic chain with a unique tip — a disjoint second chain
    // is multiple tips → fail closed AUTHORITY_GAP, never silently ignored.
    const participating = terminal(CYCLE_NEW, ['S06'], 'mes:fact:project_ready:new', null);
    const independent = terminal('cycle-other', ['S01'], 'mes:fact:project_ready:other');
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'), support(CYCLE_NEW, 'S06', 'b'),
      participating,
      support('cycle-other', 'S01', 'o'),
      independent,
    ];
    assert.throws(
      () => projectTerminalDetail(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'whole-graph validation must include an independent legal cycle-bearing terminal',
    );
    assert.throws(
      () => projectTerminalAdjunct(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'adjunct: whole-graph validation must include an independent legal cycle-bearing terminal',
    );
  });

  test('a malformed disconnected cycle-bearing terminal carrying an explicit supersedes ref is not silently filtered out of complete graph validation (repair CV S06-A-cv-4)', () => {
    // cv-4 counterexample: a participating current terminal (cycle CYCLE_NEW)
    // exists AND an independent cycle-bearing terminal (cycle 'cycle-other',
    // own relation BROKEN: planned ['S01','S02'] with only S01 support) carries
    // an explicit supersedes_project_ready_ref (null — a NORMAL/submitted
    // shape, NOT a retained legacy_cycle_anchor that omits the predecessor).
    // Per the oracle a half-new / malformed submitted terminal is NOT treated
    // as history: it must participate in the complete graph validation, so the
    // durable set never forms one acyclic chain (two roots → multiple tips)
    // → fail closed AUTHORITY_GAP, instead of being filtered out before the
    // graph is validated.
    const participating = terminal(CYCLE_NEW, ['S06'], 'mes:fact:project_ready:new', null);
    const malformed = terminal('cycle-other', ['S01', 'S02'], 'mes:fact:project_ready:other', null);
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'), support(CYCLE_NEW, 'S06', 'b'),
      participating,
      support('cycle-other', 'S01', 'o'),
      malformed,
    ];
    assert.throws(
      () => projectTerminalDetail(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'a malformed disconnected terminal with an explicit supersedes ref must fail closed AUTHORITY_GAP',
    );
    assert.throws(
      () => projectTerminalAdjunct(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'adjunct: a malformed disconnected terminal with an explicit supersedes ref must fail closed AUTHORITY_GAP',
    );
  });

  test('a malformed disconnected omitted-predecessor cycle-bearing terminal with no own-cycle support cohort fails closed AUTHORITY_GAP (repair CV S06-A-cv-5)', () => {
    // cv-5 counterexample: a participating current terminal (cycle CYCLE_NEW,
    // supersedes null) exists AND an independent cycle-bearing terminal (cycle
    // 'cycle-other', supersedes_project_ready_ref OMITTED — legacy anchor
    // SHAPE) is malformed: planned ['S01','S02'] but cycle-other has ZERO
    // cycle-scoped accepted-stage supports, so its own relation never closes.
    // Per the oracle “A malformed or half-new submitted terminal is not
    // treated as history” (contracts §2.3) and the legacy_cycle_anchor
    // definition “its own support closure remains valid” (architecture
    // delivery-cycle-semantics): unlike the poisonFree retained foreign-cycle
    // cohort that CARRIES its own historical accepted-stage support (EC-2 /
    // EC-5 exemption), a bare malformed omitted-predecessor terminal must
    // participate in complete graph validation — two disconnected roots →
    // multiple tips → fail closed AUTHORITY_GAP, instead of being filtered
    // out before the graph is validated.
    const participating = terminal(CYCLE_NEW, ['S06'], 'mes:fact:project_ready:new', null);
    const malformed = terminal('cycle-other', ['S01', 'S02'], 'mes:fact:project_ready:other');
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'), support(CYCLE_NEW, 'S06', 'b'),
      participating,
      malformed,
    ];
    assert.throws(
      () => projectTerminalDetail(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'a malformed omitted-predecessor terminal with no own-cycle support cohort must fail closed AUTHORITY_GAP',
    );
    assert.throws(
      () => projectTerminalAdjunct(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'adjunct: a malformed omitted-predecessor terminal with no own-cycle support cohort must fail closed AUTHORITY_GAP',
    );
  });

  test('a malformed disconnected omitted-predecessor cycle-bearing terminal with a NON-EMPTY but non-closing own-cycle support cohort fails closed AUTHORITY_GAP (repair CV S06-A-cv-6)', () => {
    // cv-6 counterexample: a participating current terminal (cycle CYCLE_NEW,
    // supersedes null) exists AND an independent cycle-bearing terminal (cycle
    // 'cycle-other', supersedes_project_ready_ref OMITTED — legacy anchor
    // SHAPE) is malformed with a NON-EMPTY own-cycle support cohort that does
    // NOT close: planned ['S01','S02'] while only S01 has a cycle-other
    // accepted-stage support. Unlike cv-5 (zero own-cycle support cohort), the
    // pre-repair history filter treated “has a non-empty support cohort” as
    // the retained foreign-cycle exemption and filtered this malformed
    // terminal BEFORE complete graph validation — it became invisible. Per the
    // oracle “A malformed or half-new submitted terminal is not treated as
    // history” (contracts §2.3) and the legacy_cycle_anchor rule “its own
    // support closure remains valid” (architecture
    // delivery-cycle-semantics), a malformed omitted-predecessor terminal must
    // participate in complete graph validation regardless of cohort size —
    // two disconnected roots → multiple tips → fail closed AUTHORITY_GAP,
    // instead of being filtered out before the graph is validated.
    const participating = terminal(CYCLE_NEW, ['S06'], 'mes:fact:project_ready:new', null);
    const malformed = terminal('cycle-other', ['S01', 'S02'], 'mes:fact:project_ready:other');
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'), support(CYCLE_NEW, 'S06', 'b'),
      participating,
      support('cycle-other', 'S01', 'o'),
      malformed,
    ];
    assert.throws(
      () => projectTerminalDetail(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'a malformed omitted-predecessor terminal with non-empty non-closing support must fail closed AUTHORITY_GAP',
    );
    assert.throws(
      () => projectTerminalAdjunct(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'adjunct: a malformed omitted-predecessor terminal with non-empty non-closing support must fail closed AUTHORITY_GAP',
    );
  });

  test('adjunct fails closed typed AUTHORITY_GAP on duplicate same-cycle accepted-stage supports (repair CV S06-A-restart-cv-1)', () => {
    // Two schema-valid accepted-stage support facts with the SAME stage_id in
    // the current open cycle: PRE_TERMINAL must NOT project duplicate support
    // Stage IDs — the ambiguous durable set fails closed typed AUTHORITY_GAP
    // before currentness selection (contracts §2.3; CV S06-A-restart-cv-1).
    const facts: MesFactEnvelope[] = [
      pvr(CYCLE_NEW, 'S06', 'b'), pa(CYCLE_NEW, 'S06', 'b'),
      support(CYCLE_NEW, 'S06', 'b'), support(CYCLE_NEW, 'S06', 'b-dup'),
    ];
    assert.throws(
      () => projectTerminalAdjunct(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'duplicate same-cycle supports must fail closed AUTHORITY_GAP in the adjunct',
    );
  });
});