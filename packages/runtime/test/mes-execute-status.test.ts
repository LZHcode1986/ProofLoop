/**
 * MES Execute L2 detail projection tests (S03-A-T02).
 *
 * # PO: PO-S03-A-03, PO-S03-A-04
 *
 * Exercises the read-only L2 detail projection on
 * packages/runtime/src/mes/status.ts (projectExecuteDetail +
 * MES_SLICE_EXECUTE_STATES) and the assembled mes/index.ts public surface:
 *   - Slice / Task execution state is deterministically derived from DURABLE
 *     facts only (task facts' closed payload fields from S03-A-T01 —
 *     depends_on_task_ids / blocked_by_task_id / task_status — plus git
 *     kind execute payload, finding / finding_disposition facts): slice
 *     states come from the closed set EXECUTING / SLICE_CANDIDATE_READY /
 *     CV_PASSED / READY_TO_INTEGRATE / INTEGRATED / CLEANUP_PENDING /
 *     CLEANED / REPLAN / BLOCKED_BY (§2.4 / §5.1), task states from the
 *     §5.1 closed set; blocked_by propagates along the real
 *     depends_on_task_ids edges and is never swallowed; no field is
 *     invented when the facts do not carry it; no next action / route /
 *     reasoning is ever emitted (HP-001 / STATIC-05 / HP-007);
 *   - the projection is Plan-independent (never parses Plan text), read-only,
 *     deterministic and fail-closed (non-array input / unknown fact kinds
 *     rejected with MesStatusError);
 *   - L1 stays untouched: projectSparseStatus keeps scope / phase /
 *     required_skill plus the non-zero sparse anomaly counters only
 *     (MES_ANOMALY_COUNTERS closed set, E2E-16);
 *   - parallel-state fixture (E2E-16 / HP-009): one slice blocked never
 *     blocks an independent slice; blocked_by propagates to real dependency
 *     descendants and is not swallowed; L1 shows sparse counts only.
 *
 * Task facts used here are exactly the S03-A-T01-validated closed payload
 * shapes (written through MesSnapshotStore with the brand-bound
 * accepted_plan_task_graph where the store boundary is exercised). All store
 * tests use only temporary Git fixtures (helpers.ts#makeFixture). Imports
 * the compiled runtime dist (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {
  projectExecuteDetail,
  MES_SLICE_EXECUTE_STATES,
  MesStatusError,
  projectSparseStatus,
} from '../dist/mes/status';
import type { MesExecuteDetail } from '../dist/mes/status';
import {
  projectExecuteDetail as projectExecuteDetailFromIndex,
  MES_SLICE_EXECUTE_STATES as INDEX_SLICE_STATES,
  projectSparseStatus as sparseFromIndex,
} from '../dist/mes/index';
import { buildAcceptedPlanTaskGraph } from '../dist/execute/plan-task-graph';
import { createMesSnapshotStore } from '../dist/mes/store';
import type { MesFactEnvelope } from '../dist/mes/types';
import { makeFixture, commitAll, sha } from './helpers';

const PLAN_REF = 'delivery/stages/S03/plan.md';
const PLAN_DIGEST = sha('s03-plan-v1');
const GIT_BASIS = { head: 'a'.repeat(40), branch: 'proofloop-s03-a', worktree: '.' };

function acceptedBinding() {
  return {
    binding_stage: 'accepted' as const,
    accepted_plan_ref: PLAN_REF,
    source_candidate_plan_ref: PLAN_REF,
    verification_result_ref: 'mes:result:S03:planning-verification-1',
    plan_digest: PLAN_DIGEST,
  };
}

/** Minimal accepted Thin Plan (§4.1 shape) covering every slice used below. */
function planFixture(): Record<string, unknown> {
  return {
    stage: 'S03',
    project_stage_map_ref: 'delivery/project-stage-map.md#S03',
    slices: [
      {
        slice: 'S03-A',
        goal: 'fact kinds',
        depends_on: [],
        tasks: [
          { task: 'S03-A-T01', goal: 'g', dependencies: [] },
          { task: 'S03-A-T02', goal: 'g', dependencies: ['S03-A-T01'] },
        ],
      },
      {
        slice: 'S03-B',
        goal: 'ack',
        depends_on: [],
        tasks: [{ task: 'S03-B-T01', goal: 'g', dependencies: [] }],
      },
      {
        slice: 'S03-G',
        goal: 'blocked',
        depends_on: [],
        tasks: [
          { task: 'S03-G-T00', goal: 'g', dependencies: [] },
          { task: 'S03-G-T01', goal: 'g', dependencies: ['S03-G-T00'] },
        ],
      },
      {
        slice: 'S03-H',
        goal: 'transitive',
        depends_on: [],
        tasks: [
          { task: 'S03-H-T00', goal: 'g', dependencies: ['S03-H-T03'] },
          { task: 'S03-H-T03', goal: 'g', dependencies: [] },
          { task: 'S03-H-T01', goal: 'g', dependencies: ['S03-H-T00'] },
        ],
      },
    ],
  };
}

function taskFact(taskId: string, status: string, dependsOn: string[], extra: Record<string, unknown> = {}): MesFactEnvelope {
  const sliceId = taskId.replace(/^S(\d+)-([A-Z]+)-T\d+$/, 'S$1-$2');
  return {
    schema_version: 2,
    fact_id: `mes:fact:task:${taskId}`,
    fact_kind: 'task',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#5.1'],
    scope: { stage_id: 'S03', slice_id: sliceId, task_id: taskId },
    work_id: `mes:work:S03:${sliceId}:1`,
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    task_status: status as never,
    depends_on_task_ids: dependsOn,
    ...extra,
  };
}

function gitFact(sliceId: string, subkind: string, overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:git:S03:${sliceId}:${subkind}`,
    fact_kind: 'git',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#5.3'],
    scope: { stage_id: 'S03', slice_id: sliceId },
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    git_subkind: subkind as never,
    candidate_ref: `proofloop-s03-${sliceId.slice(-1).toLowerCase()}`,
    candidate_base_ref: 'a'.repeat(40),
    commit_sha: 'c'.repeat(40),
    changed_files: ['packages/runtime/src/mes/status.ts'],
    ...overrides,
  };
}

function findingFact(sliceId: string, verdict: string, overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:finding:S03:${sliceId}:cv-1`,
    fact_kind: 'finding',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.3'],
    scope: { stage_id: 'S03', slice_id: sliceId },
    work_id: `mes:work:S03:${sliceId}:cv`,
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    verifier_verdict: verdict as never,
    claimed_route_code: 'IMPLEMENTATION_DEFECT',
    finding_evidence_refs: [`mes:result:S03:${sliceId}:cv`],
    ...overrides,
  };
}

function dispositionFact(sliceId: string, acceptedRouteCode: string, overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:disposition:S03:${sliceId}:1`,
    fact_kind: 'finding_disposition',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.3'],
    scope: { stage_id: 'S03', slice_id: sliceId },
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    disposition_ref: `mes:disposition:S03:${sliceId}:1`,
    finding_ref: `mes:finding:S03:${sliceId}:cv-1`,
    finding_disposition: 'ACCEPTED',
    claimed_route_code: acceptedRouteCode as never,
    accepted_route_code: acceptedRouteCode as never,
    basis_refs: ['tech-spec/contracts.md#2.2.3'],
    reason: 'replan classification',
    resume_target: 'planner',
    ...overrides,
  };
}

function resultFact(sliceId: string, refSuffix: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:result:S03:${sliceId}:${refSuffix}`,
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#4.3'],
    scope: { stage_id: 'S03', slice_id: sliceId },
    work_id: `mes:work:S03:${sliceId}:1`,
    result_ref: `mes:result:S03:${sliceId}:${refSuffix}`,
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    result_id: `attempt-${sliceId}-${refSuffix}`,
    result_payload_digest: crypto.createHash('sha256').update(`${sliceId}-${refSuffix}`).digest('hex'),
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

describe('MES execute L2 detail projection (S03-A-T02)', () => {
  test('projects execute L2 state without inventing fields or routing', () => {
    // The closed slice-state set (§2.4 / §5.1) is exact.
    assert.deepEqual(MES_SLICE_EXECUTE_STATES, [
      'EXECUTING',
      'SLICE_CANDIDATE_READY',
      'CV_PASSED',
      'READY_TO_INTEGRATE',
      'INTEGRATED',
      'CLEANUP_PENDING',
      'CLEANED',
      'REPLAN',
      'BLOCKED_BY',
    ]);

    // Durable facts for one slice per derivable state + a transitive-block
    // slice. latest Result/Finding refs and candidate/integration Git refs
    // come from the facts themselves — never invented.
    const facts: MesFactEnvelope[] = [
      // S03-A: both tasks complete → SLICE_CANDIDATE_READY (+ result/finding refs).
      taskFact('S03-A-T01', 'TASK_COMPLETE', []),
      taskFact('S03-A-T02', 'TASK_COMPLETE', ['S03-A-T01']),
      resultFact('S03-A', 'r1'),
      findingFact('S03-A', 'FINDINGS'),
      // S03-B: CV PASS + candidate ref → READY_TO_INTEGRATE.
      taskFact('S03-B-T01', 'TASK_COMPLETE', []),
      findingFact('S03-B', 'PASS'),
      gitFact('S03-B', 'candidate'),
      // S03-C: CV PASS only → CV_PASSED.
      taskFact('S03-C-T01', 'TASK_COMPLETE', []),
      findingFact('S03-C', 'PASS'),
      // S03-D: integration git fact → INTEGRATED + cleanup pending.
      taskFact('S03-D-T01', 'TASK_COMPLETE', []),
      gitFact('S03-D', 'integration'),
      // S03-E: cleanup git fact → CLEANED.
      taskFact('S03-E-T01', 'TASK_COMPLETE', []),
      gitFact('S03-E', 'integration'),
      gitFact('S03-E', 'cleanup'),
      // S03-F: Brain disposition PLAN_GAP → REPLAN.
      taskFact('S03-F-T01', 'TASK_RESULT_SUBMITTED', []),
      dispositionFact('S03-F', 'PLAN_GAP'),
      // S03-G: task blocked (real dependency) → BLOCKED_BY with blocker.
      taskFact('S03-G-T00', 'TASK_COMPLETE', []),
      taskFact('S03-G-T01', 'TASK_COMPLETE', ['S03-G-T00'], { blocked_by_task_id: 'S03-G-T00' }),
      // S03-H: transitive — H-T00 blocked, H-T01 depends on H-T00 → H-T01
    // (S06-R-C-T02 explicit migration, recovery-plan-r3 existing-verification-impact)
    // The canonical S03 planning relation (candidate PVR + accepted PA) makes
    // the accepted-bound S03 facts below relation-valid, so the completion-
    // state assertions retain their original intent under the status
    // fail-closed gate for binding-critical identity (cv-s06-r-c2: accepted-
    // bound facts without a resolvable canonical relation are non-
    // authorizing).
    {
      schema_version: 2,
      fact_id: 'mes:fact:planning_verification_result:S03:1',
      fact_kind: 'planning_verification_result',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: 'S03' },
      work_id: 'mes:work:S03:planning:1',
      result_ref: 'mes:result:S03:planning-verification-1',
      verifier_role: 'stage-plan-verifier',
      action_token: 's03-spv-1',
      plan_binding: {
        binding_stage: 'candidate',
        candidate_plan_ref: PLAN_REF,
        accepted_plan_ref: null,
        verdict: 'PLAN_READY',
        plan_digest: PLAN_DIGEST,
      },
      git_basis: GIT_BASIS,
    },
    {
      schema_version: 2,
      fact_id: 'mes:fact:plan_acceptance:S03:1',
      fact_kind: 'plan_acceptance',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: 'S03' },
      plan_binding: {
        binding_stage: 'accepted',
        accepted_plan_ref: PLAN_REF,
        source_candidate_plan_ref: PLAN_REF,
        verification_result_ref: 'mes:result:S03:planning-verification-1',
        plan_digest: PLAN_DIGEST,
      },
      git_basis: GIT_BASIS,
    },
      // effective blocked_by propagates and is not swallowed.
      taskFact('S03-H-T03', 'TASK_COMPLETE', []),
      taskFact('S03-H-T00', 'IN_PROGRESS', ['S03-H-T03'], { blocked_by_task_id: 'S03-H-T03' }),
      taskFact('S03-H-T01', 'IN_PROGRESS', ['S03-H-T00']),
      // S03-I: mixed status → EXECUTING.
      taskFact('S03-I-T01', 'IN_PROGRESS', []),
      // S03-J: latest finding is FINDINGS (historical PASS first) → NOT
      // CV_PASSED; tasks complete → SLICE_CANDIDATE_READY (CV counterexample: a
      // historical PASS must not override the later FINDINGS).
      taskFact('S03-J-T01', 'TASK_COMPLETE', []),
      findingFact('S03-J', 'PASS'),
      { ...findingFact('S03-J', 'FINDINGS'), fact_id: 'mes:fact:finding:S03:S03-J:cv-2' },
      // S03-K: latest finding is PASS (after an earlier FINDINGS) → CV_PASSED.
      taskFact('S03-K-T01', 'TASK_COMPLETE', []),
      findingFact('S03-K', 'FINDINGS'),
      { ...findingFact('S03-K', 'PASS'), fact_id: 'mes:fact:finding:S03:S03-K:cv-2' },
      // S03-L: latest disposition is NON-PLAN_GAP (earlier PLAN_GAP first) →
      // NOT REPLAN (CV-S03-A-R2: latest disposition wins). Tasks complete →
      // SLICE_CANDIDATE_READY.
      taskFact('S03-L-T01', 'TASK_COMPLETE', []),
      dispositionFact('S03-L', 'PLAN_GAP'),
      { ...dispositionFact('S03-L', 'IMPLEMENTATION_DEFECT'), fact_id: 'mes:fact:disposition:S03:S03-L:2' },
      // S03-M: latest disposition IS PLAN_GAP (after an earlier non-PLAN_GAP)
      // → REPLAN.
      taskFact('S03-M-T01', 'TASK_COMPLETE', []),
      dispositionFact('S03-M', 'IMPLEMENTATION_DEFECT'),
      { ...dispositionFact('S03-M', 'PLAN_GAP'), fact_id: 'mes:fact:disposition:S03:S03-M:2' },
    ];
    const snapshot = JSON.parse(JSON.stringify(facts));

    const detail: MesExecuteDetail = projectExecuteDetail(facts);
    const stateOf = (sliceId: string): string => detail.slices.find((s) => s.slice_id === sliceId)!.state;

    assert.equal(stateOf('S03-A'), 'SLICE_CANDIDATE_READY');
    assert.equal(stateOf('S03-B'), 'READY_TO_INTEGRATE');
    assert.equal(stateOf('S03-C'), 'CV_PASSED');
    assert.equal(stateOf('S03-D'), 'INTEGRATED');
    assert.equal(stateOf('S03-E'), 'CLEANED');
    assert.equal(stateOf('S03-F'), 'REPLAN');
    assert.equal(stateOf('S03-G'), 'BLOCKED_BY');
    assert.equal(stateOf('S03-H'), 'BLOCKED_BY');
    assert.equal(stateOf('S03-I'), 'EXECUTING');
    assert.equal(stateOf('S03-J'), 'SLICE_CANDIDATE_READY', 'latest FINDINGS overrides historical PASS');
    assert.equal(stateOf('S03-K'), 'CV_PASSED', 'latest PASS restores CV_PASSED after an earlier FINDINGS');
    const jSlice = detail.slices.find((s) => s.slice_id === 'S03-J')!;
    assert.equal(jSlice.latest_finding_ref, 'mes:fact:finding:S03:S03-J:cv-2', 'latest_finding_ref points at the newest finding');
    assert.equal(stateOf('S03-L'), 'SLICE_CANDIDATE_READY', 'latest non-PLAN_GAP disposition overrides earlier PLAN_GAP');
    assert.equal(stateOf('S03-M'), 'REPLAN', 'latest PLAN_GAP disposition projects REPLAN');



    // L2 fields come from the facts only.
    const b = detail.slices.find((s) => s.slice_id === 'S03-B')!;
    assert.equal(b.candidate_ref, 'proofloop-s03-b');
    assert.equal(b.integration_ref, undefined, 'no integration ref invented for READY_TO_INTEGRATE');
    const d = detail.slices.find((s) => s.slice_id === 'S03-D')!;
    assert.equal(d.integration_ref, 'proofloop-s03-d');
    assert.equal(d.cleanup_pending, true, 'integration without cleanup keeps cleanup pending visible');
    const e = detail.slices.find((s) => s.slice_id === 'S03-E')!;
    assert.equal(e.cleanup_pending, undefined, 'cleaned slice has no pending cleanup');
    const a = detail.slices.find((s) => s.slice_id === 'S03-A')!;
    assert.equal(a.latest_result_ref, 'mes:result:S03:S03-A:r1');
    assert.equal(a.latest_finding_ref, 'mes:fact:finding:S03:S03-A:cv-1');

    // Blocked_by: direct on the blocked task, propagated along real
    // depends_on_task_ids edges for descendants (never swallowed).
    const h00 = detail.tasks.find((t) => t.task_id === 'S03-H-T00')!;
    assert.equal(h00.blocked_by, 'S03-H-T03');
    const h01 = detail.tasks.find((t) => t.task_id === 'S03-H-T01')!;
    assert.equal(h01.blocked_by, 'S03-H-T03', 'blocked_by must propagate to dependency descendants');
    const g00 = detail.tasks.find((t) => t.task_id === 'S03-G-T00')!;
    assert.equal(g00.blocked_by, undefined, 'unblocked task has no blocked_by field');
    const i01 = detail.tasks.find((t) => t.task_id === 'S03-I-T01')!;
    assert.equal(i01.task_status, 'IN_PROGRESS');
    assert.deepEqual(i01.depends_on_task_ids, []);
    const hSlice = detail.slices.find((s) => s.slice_id === 'S03-H')!;
    assert.equal(hSlice.blocked_by, 'S03-H-T03', 'slice blocked_by carries the propagated blocker');

    // Read-only + deterministic: input never mutated; same input → same output.
    assert.deepEqual(JSON.parse(JSON.stringify(facts)), snapshot, 'projection must not mutate its input');
    assert.deepEqual(projectExecuteDetail(facts), detail, 'projection must be deterministic');

    // No routing / next-action / reasoning anywhere in the output.
    const keys = allKeys(detail);
    for (const forbidden of ['next_action', 'next_task_id', 'route', 'reasoning', 'accepted_route_code']) {
      assert.equal(keys.includes(forbidden), false, `L2 output must not contain "${forbidden}"`);
    }

    // Fail closed: non-array input and unknown fact kinds are rejected.
    assert.throws(() => projectExecuteDetail(null as never), MesStatusError);
    assert.throws(() => projectExecuteDetail({ facts: [] } as never), MesStatusError);
    assert.throws(
      () => projectExecuteDetail([{ ...taskFact('S03-A-T01', 'TASK_COMPLETE', []), fact_kind: 'task_progress' }] as unknown as MesFactEnvelope[]),
      'unknown fact kind fails closed',
    );


    // Fail closed on malformed KNOWN task facts: the projection never
    // derives from a shape the envelope validator would reject.
    assert.throws(
      () =>
        projectExecuteDetail([{ ...taskFact('S03-A-T01', 'TASK_COMPLETE', []), task_status: 'DONE' } as unknown as MesFactEnvelope]),
      MesStatusError,
      'non-closed task_status fails closed',
    );
    assert.throws(
      () =>
        projectExecuteDetail([{ ...taskFact('S03-A-T01', 'TASK_COMPLETE', []), depends_on_task_ids: ['not-a-task'] } as unknown as MesFactEnvelope]),
      MesStatusError,
      'non-canonical depends_on_task_ids fails closed',
    );
    assert.throws(
      () => projectExecuteDetail([taskFact('S03-A-T01', 'TASK_COMPLETE', [], { blocked_by_task_id: 'X!' }) as unknown as MesFactEnvelope]),
      MesStatusError,
      'non-canonical blocked_by_task_id fails closed',
    );
    assert.throws(
      () =>
        projectExecuteDetail([{ ...taskFact('S03-A-T01', 'TASK_COMPLETE', []), scope: { stage_id: 'S03' } } as unknown as MesFactEnvelope]),
      MesStatusError,
      'missing canonical task_id scope fails closed',
    );

    // Fail closed on malformed KNOWN finding / finding_disposition / git
    // execute facts (CV-S03-A-R2): the projection never derives from a shape
    // the envelope validator would reject.
    assert.throws(
      () => projectExecuteDetail([{ ...findingFact('S03-X', 'PASS'), verifier_verdict: undefined } as unknown as MesFactEnvelope]),
      MesStatusError,
      'finding missing verifier_verdict fails closed',
    );
    assert.throws(
      () => projectExecuteDetail([{ ...findingFact('S03-X', 'PASS'), claimed_route_code: undefined } as unknown as MesFactEnvelope]),
      MesStatusError,
      'finding missing claimed_route_code fails closed',
    );
    assert.throws(
      () => projectExecuteDetail([{ ...findingFact('S03-X', 'MAYBE') } as unknown as MesFactEnvelope]),
      MesStatusError,
      'finding with non-closed verifier_verdict fails closed',
    );
    assert.throws(
      () => projectExecuteDetail([{ ...dispositionFact('S03-X', 'PLAN_GAP'), disposition_ref: undefined } as unknown as MesFactEnvelope]),
      MesStatusError,
      'finding_disposition missing disposition_ref fails closed',
    );
    assert.throws(
      () => projectExecuteDetail([{ ...dispositionFact('S03-X', 'PLAN_GAP'), basis_refs: undefined } as unknown as MesFactEnvelope]),
      MesStatusError,
      'finding_disposition missing basis_refs fails closed',
    );
    assert.throws(
      () => projectExecuteDetail([{ ...gitFact('S03-X', 'candidate'), commit_sha: undefined } as unknown as MesFactEnvelope]),
      MesStatusError,
      'partial git execute payload in projection input fails closed',
    );


    // L1 stays untouched: sparse projection keeps scope/phase/required_skill
    // plus non-zero sparse anomaly counters only.
    const sparse = projectSparseStatus({
      scope: 'S03',
      phase: 'EXECUTE',
      required_skill: 'proofloop-execute',
      counters: { replan: 0, blocked: 1, finding: 2 },
    });
    assert.deepEqual(sparse, { scope: 'S03', phase: 'EXECUTE', required_skill: 'proofloop-execute', counters: { blocked: 1, finding: 2 } });
    assert.equal(Object.hasOwn(sparse.counters ?? {}, 'replan'), false, 'zero counters stay hidden at L1');

    // The assembled mes/index.ts public surface aggregates the same seam.
    assert.deepEqual(INDEX_SLICE_STATES, MES_SLICE_EXECUTE_STATES);
    assert.equal(projectExecuteDetailFromIndex, projectExecuteDetail);
    assert.equal(sparseFromIndex, projectSparseStatus);

    // Store-boundary round trip (S03-A-T01-validated facts): task facts
    // written through MesSnapshotStore with the brand-bound graph re-project
    // identically — the L2 blocked_by input contract is the validated
    // task-fact closed payload.
    const fixture = makeFixture();
    try {
      commitAll(fixture, 'baseline');
      const graph = buildAcceptedPlanTaskGraph(planFixture(), PLAN_REF, PLAN_DIGEST);
      const store = createMesSnapshotStore(fixture.dir);
      store.write(
        [taskFact('S03-G-T00', 'TASK_COMPLETE', []), taskFact('S03-G-T01', 'TASK_COMPLETE', ['S03-G-T00'], { blocked_by_task_id: 'S03-G-T00' })],
        { acceptedPlanTaskGraph: graph },
      );
      const rehydrated = store.read();
      const projected = projectExecuteDetail(rehydrated);
      const g = projected.slices.find((s) => s.slice_id === 'S03-G')!;
      assert.equal(g.state, 'BLOCKED_BY');
      assert.equal(g.blocked_by, 'S03-G-T00');
    } finally {
      fixture.cleanup();
    }
  });

  test('keeps an independent slice runnable while another slice is blocked', () => {
    // Parallel-state fixture (E2E-16 / HP-009): S03-A is blocked (direct +
    // propagated), S03-B has no blocker at all and must stay runnable.
    const facts: MesFactEnvelope[] = [
      taskFact('S03-A-T00', 'TASK_COMPLETE', []),
      taskFact('S03-A-T01', 'TASK_COMPLETE', ['S03-A-T00'], { blocked_by_task_id: 'S03-A-T00' }),
      taskFact('S03-A-T02', 'IN_PROGRESS', ['S03-A-T01']),
      taskFact('S03-B-T01', 'IN_PROGRESS', []),
      taskFact('S03-B-T02', 'PLANNED', ['S03-B-T01']),
    ];
    const detail = projectExecuteDetail(facts);

    const sliceA = detail.slices.find((s) => s.slice_id === 'S03-A')!;
    const sliceB = detail.slices.find((s) => s.slice_id === 'S03-B')!;
    assert.equal(sliceA.state, 'BLOCKED_BY', 'S03-A must be BLOCKED_BY');
    assert.equal(sliceB.state, 'EXECUTING', 'S03-B must stay runnable while S03-A is blocked');

    // blocked_by propagates along the real dependency edge and is not
    // swallowed: A-T02 (depends on blocked A-T01) is transitively blocked
    // with the propagated blocker.
    const a02 = detail.tasks.find((t) => t.task_id === 'S03-A-T02')!;
    assert.equal(a02.blocked_by, 'S03-A-T00', 'transitive blocked_by must propagate and not be swallowed');
    const a01 = detail.tasks.find((t) => t.task_id === 'S03-A-T01')!;
    assert.equal(a01.blocked_by, 'S03-A-T00');

    // S03-B tasks carry no blocked_by field at all (nothing invented).
    for (const t of detail.tasks.filter((t) => t.task_id.startsWith('S03-B'))) {
      assert.equal(t.blocked_by, undefined, 'independent slice tasks must have no blocked_by');
    }

    // L1 shows sparse counts only — never a full blocked dump.
    const sparse = projectSparseStatus({
      scope: 'S03',
      phase: 'EXECUTE',
      required_skill: 'proofloop-execute',
      counters: { replan: 0, blocked: 1, finding: 0, repair: 0 },
    });
    assert.deepEqual(sparse.counters, { blocked: 1 });
    assert.equal(allKeys(sparse).some((k) => k.includes('next_action') || k === 'route' || k === 'reasoning'), false);
  });
});
