/**
 * MES Execute fact kinds closed-set schema tests (S03-A-T01).
 *
 * # PO: PO-S03-A-01, PO-S03-A-02, PO-S04-B-04
 *
 * Exercises the S03-A-T01 extension of the MES fact envelope closed set
 * (packages/runtime/src/mes/types.ts / validate.ts / binding.ts / store.ts
 *  / execute/plan-task-graph.ts):
 *   - `task` / `finding` / `finding_disposition` join MES_FACT_KINDS with
 *     closed per-kind payloads (task_status per §5.1, verifier verdict +
 *     claimed_route_code per §2.2.3, finding disposition closed fields);
 *   - task dependency/blocked validation binds a NON-self-declared,
 *     cryptographically-bound, single-producer `accepted_plan_task_graph`
 *     (opaque capability minted only by plan-task-graph.ts carrying the
 *     PLAN_TASK_GRAPH_BRAND symbol): ref + plan_digest equality, graph_digest
 *     recomputation, exact dependency edge-set equality, blocked_by inside
 *     the dependency edge set, phantom task ids and plain-JSON graphs fail
 *     closed;
 *   - the ONLY durable write boundary for `task` facts is
 *     MesSnapshotStore.write with a brand-validated graph (missing graph or
 *     invalid graph → no-write, previous snapshot byte-stable);
 *   - `result` facts carry the closed result_id + result_payload_digest pair
 *     (64-hex) with the machine-closed legacy S01 predicate
 *     (is_legacy_s01_result) exempting the 8 existing S01 result facts; any
 *     non-S01 result (especially S03) lacking both fields fails closed, and
 *     partial pairs (mixed state) fail closed in both directions;
 *   - `git` facts carry the closed execute payload (git_subkind ∈
 *     candidate/integration/cleanup + candidate_ref / candidate_base_ref /
 *     commit_sha / changed_files) validated whenever present;
 *   - transport / session metadata (`next_task_id` / `next_action` / route /
 *     reasoning fields, Agent Name / pane / Link metadata / `sent` / `idle` /
 *     `done`) is never accepted as fact content (STATIC-08 / FR-014).
 *
 * All store tests use only temporary Git fixtures (helpers.ts#makeFixture)
 * and never the work clone's Git state. Imports the compiled runtime dist
 * (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {
  validateMesFactEnvelope,
  SchemaValidationError,
  isLegacyS01Result,
  isExecuteResult,
} from '../dist/mes/validate';
import {
  MES_FACT_KINDS,
  MES_TASK_STATUSES,
  MES_VERIFIER_VERDICTS,
  MES_FINDING_DISPOSITIONS,
  MES_ROUTE_CODES,
  MES_RESUME_TARGETS,
  MES_GIT_SUBKINDS,
} from '../dist/mes/types';
import type { MesFactEnvelope } from '../dist/mes/types';
import { MesSnapshotStore, MesSnapshotStoreError, createMesSnapshotStore } from '../dist/mes/store';
import {
  buildAcceptedPlanTaskGraph,
  computeGraphDigest,
  isAcceptedPlanTaskGraph,
} from '../dist/execute/plan-task-graph';
import type { AcceptedPlanTaskGraph } from '../dist/execute/plan-task-graph';
import { makeFixture, commitAll, sha } from './helpers';

const PLAN_REF = 'delivery/stages/S03/plan.md';
const PLAN_DIGEST = sha('s03-plan-v1');
const GIT_BASIS = { head: 'a'.repeat(40), branch: 'proofloop-s03-a', worktree: '.' };

function acceptedBinding(planRef: string = PLAN_REF, planDigest: string = PLAN_DIGEST) {
  return {
    binding_stage: 'accepted' as const,
    accepted_plan_ref: planRef,
    source_candidate_plan_ref: planRef,
    verification_result_ref: 'mes:result:S03:planning-verification-1',
    plan_digest: planDigest,
  };
}

/** A minimal accepted Thin Plan object in the current §4.1 shape. */
function planFixture(): Record<string, unknown> {
  return {
    stage: 'S03',
    project_stage_map_ref: 'delivery/project-stage-map.md#S03',
    slices: [
      {
        slice: 'S03-A',
        goal: 'execute fact kinds',
        depends_on: [],
        tasks: [
          { task: 'S03-A-T01', goal: 'fact kinds', dependencies: [] },
          { task: 'S03-A-T02', goal: 'l2 projection', dependencies: ['S03-A-T01'] },
        ],
      },
      {
        slice: 'S03-B',
        goal: 'ack barrier',
        depends_on: ['S03-A'],
        tasks: [{ task: 'S03-B-T01', goal: 'envelope', dependencies: ['S03-A-T02'] }],
      },
    ],
  };
}

function taskFact(taskId: string, dependsOn: string[], overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:task:${taskId}`,
    fact_kind: 'task',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#5.1'],
    scope: { stage_id: 'S03', slice_id: taskId.replace(/^S(\d+)-([A-Z]+)-T\d+$/, 'S$1-$2'), task_id: taskId },
    work_id: 'mes:work:S03:S03-A:1',
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    task_status: 'PLANNED',
    depends_on_task_ids: dependsOn,
    ...overrides,
  };
}


const S04_REF = 'delivery/stages/S04/plan.md';
const S04_DIGEST = sha('s04-plan-v1');

/** A minimal accepted Thin Plan object for the S04 stage (mixed-stage retention). */
function s04PlanFixture(): Record<string, unknown> {
  return {
    stage: 'S04',
    project_stage_map_ref: 'delivery/project-stage-map.md#S04',
    slices: [
      {
        slice: 'S04-A',
        goal: 'mixed-stage durable retention',
        depends_on: [],
        tasks: [
          { task: 'S04-A-T01', goal: 'retention new fact', dependencies: [] },
          { task: 'S04-A-T02', goal: 'retention successor', dependencies: ['S04-A-T01'] },
        ],
      },
    ],
  };
}

/** An S04-bound task fact (accepted S04 Plan binding + S04 stage/slice scope). */
function s04TaskFact(taskId: string, dependsOn: string[], overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return taskFact(taskId, dependsOn, {
    scope: {
      stage_id: 'S04',
      slice_id: taskId.replace(/^S(\d+)-([A-Z]+)-T\d+$/, 'S$1-$2'),
      task_id: taskId,
    },
    work_id: 'mes:work:S04:S04-A:1',
    plan_binding: acceptedBinding(S04_REF, S04_DIGEST),
    ...overrides,
  });
}
function findingFact(overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:finding:S03:cv-1',
    fact_kind: 'finding',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.3'],
    scope: { stage_id: 'S03', slice_id: 'S03-A' },
    work_id: 'mes:work:S03:S03-A:1',
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    verifier_verdict: 'FINDINGS',
    claimed_route_code: 'IMPLEMENTATION_DEFECT',
    finding_evidence_refs: ['mes:result:S03:cv-1'],
    ...overrides,
  };
}

function dispositionFact(overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:disposition:S03:1',
    fact_kind: 'finding_disposition',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.3'],
    scope: { stage_id: 'S03', slice_id: 'S03-A' },
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    disposition_ref: 'mes:disposition:S03:1',
    finding_ref: 'mes:fact:finding:S03:cv-1',
    finding_disposition: 'ACCEPTED',
    claimed_route_code: 'IMPLEMENTATION_DEFECT',
    accepted_route_code: 'IMPLEMENTATION_DEFECT',
    basis_refs: ['tech-spec/contracts.md#2.2.3'],
    reason: 'finding supported by plan and scope',
    resume_target: 'producer',
    ...overrides,
  };
}

function resultFact(id: string, overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:result:${id}`,
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#4.3'],
    scope: { stage_id: 'S03', slice_id: 'S03-A', task_id: 'S03-A-T01' },
    work_id: 'mes:work:S03:S03-A:1',
    result_ref: `mes:result:S03:${id}`,
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    result_id: `attempt-${id}`,
    result_payload_digest: crypto.createHash('sha256').update(id).digest('hex'),
    ...overrides,
  };
}

/** One of the 8 pre-existing S01 result facts (legacy predicate input). */
function legacyS01ResultFact(): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:result:S01-A-review-repair-r1',
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: ['PRD.md#FR-003'],
    scope: { stage_id: 'S01', slice_id: 'S01-A' },
    work_id: 'mes:work:S01:review',
    result_ref: 'mes:result:S01-A-review-repair-r1',
    plan_binding: acceptedBinding('delivery/stages/S01/plan.md', sha('s01-plan')),
    git_basis: { head: 'b'.repeat(40), branch: 'v2-subagent', worktree: '.' },
  };
}

function gitFact(overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:git:S03:candidate',
    fact_kind: 'git',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#5.3'],
    scope: { stage_id: 'S03', slice_id: 'S03-A' },
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    git_subkind: 'candidate',
    candidate_ref: 'proofloop-s03-a',
    candidate_base_ref: 'a'.repeat(40),
    commit_sha: 'c'.repeat(40),
    changed_files: ['packages/runtime/src/mes/types.ts'],
    ...overrides,
  };
}

describe('MES execute fact kinds closed-set schema (S03-A-T01)', () => {
  test('accepts execute fact kinds with closed per-kind payloads including legacy S01 result predicate', () => {
    // The closed set now includes the Execute kinds.
    for (const kind of ['task', 'finding', 'finding_disposition']) {
      assert.equal((MES_FACT_KINDS as readonly string[]).includes(kind), true, `${kind} must be in MES_FACT_KINDS`);
    }

    // task facts: the graph capability is minted by the single producer and
    // its digest is recomputable (cryptographic binding, not self-declared).
    const graph = buildAcceptedPlanTaskGraph(planFixture(), PLAN_REF, PLAN_DIGEST);
    assert.equal(isAcceptedPlanTaskGraph(graph), true, 'graph passes the brand-provenance predicate');
    // The brand symbol is NOT exported AND the identity registry is the
    // authority (S03-STAGE-REVIEW-F001): a JSON clone, a hand-built shape with
    // a matching digest, a SHALLOW spread clone, a structuredClone and a
    // symbol-copied clone are all DIFFERENT object identities that are never
    // in the WeakSet — copying symbols onto a clone can never forge the brand.
    assert.equal(isAcceptedPlanTaskGraph(JSON.parse(JSON.stringify(graph))), false, 'deserialized graph must fail brand provenance');
    assert.equal(isAcceptedPlanTaskGraph({ ...graph, source: 'forged' }), false, 'a shallow spread clone with re-attached brand content must fail provenance (no symbol smuggling)');
    assert.equal(isAcceptedPlanTaskGraph(structuredClone(graph)), false, 'a structured clone is a different identity and must fail provenance');
    assert.equal(isAcceptedPlanTaskGraph(({ ...graph }) as unknown), false, 'any shallow clone must fail provenance');
    // The minted capability and its nested task_ids / edges (and edge objects)
    // are deeply frozen: the genuine graph is immutable against caller
    // mutation (in-place mutation throws in strict mode).
    assert.equal(Object.isFrozen(graph), true, 'the minted capability must be frozen');
    assert.equal(Object.isFrozen(graph.task_ids), true, 'nested task_ids must be frozen');
    assert.equal(Object.isFrozen(graph.edges), true, 'nested edges must be frozen');
    assert.equal(Object.isFrozen(graph.edges[0]), true, 'edge objects must be frozen');
    assert.throws(
      () => {
        (graph as unknown as { task_ids: string[] }).task_ids = ['forged'];
      },
      TypeError,
      'reassigning task_ids on the genuine graph must throw (frozen)',
    );
    assert.throws(
      () => {
        (graph.edges as { from: string; to: string; kind: string }[]).push({ from: 'x', to: 'y', kind: 'dependency' });
      },
      TypeError,
      'pushing an edge onto the frozen edges array must throw',
    );
    assert.equal(
      graph.graph_digest,
      computeGraphDigest(graph.task_ids as readonly string[], graph.edges as readonly { from: string; to: string; kind: 'dependency' | 'blocked_by' }[]),
      'graph_digest must equal the recomputed SHA-256(SPN({task_ids ascending, edges serialized sorted}))',
    );
    assert.equal(graph.accepted_plan_ref, PLAN_REF);
    assert.equal(graph.accepted_plan_digest, PLAN_DIGEST);
    assert.deepEqual([...graph.task_ids].sort(), ['S03-A-T01', 'S03-A-T02', 'S03-B-T01']);

    // Edge closure (CV counterexample): a dangling dependency / blocked_by
    // edge — one whose target is not itself a task of the accepted plan —
    // fails closed at construction (no undeclared task can be smuggled
    // through the graph).
    const danglingDependencyPlan = {
      ...planFixture(),
      slices: [
        {
          slice: 'S03-A',
          goal: 'dangling',
          depends_on: [],
          tasks: [
            { task: 'S03-A-T01', goal: 'g', dependencies: ['S03-A-T99'] },
            { task: 'S03-A-T02', goal: 'g', dependencies: [] },
          ],
        },
      ],
    };
    assert.throws(
      () => buildAcceptedPlanTaskGraph(danglingDependencyPlan, PLAN_REF, PLAN_DIGEST),
      Error,
      'dangling dependency edge must fail closed',
    );
    const danglingBlockedPlan = {
      ...planFixture(),
      slices: [
        {
          slice: 'S03-A',
          goal: 'dangling',
          depends_on: [],
          tasks: [{ task: 'S03-A-T01', goal: 'g', dependencies: [], blocked_by: ['S03-A-T99'] }],
        },
      ],
    };
    assert.throws(
      () => buildAcceptedPlanTaskGraph(danglingBlockedPlan, PLAN_REF, PLAN_DIGEST),
      Error,
      'dangling blocked_by edge must fail closed',
    );

    // Blocked_by closure (CV-S03-A-R2): a blocked_by entry is only legal
    // when its target is a REAL accepted-plan dependency of the SAME task.
    // Declared-but-not-a-dependency targets fail closed at construction;
    // a valid dependency target builds normally.
    const nonDependencyBlockedPlan = {
      ...planFixture(),
      slices: [
        {
          slice: 'S03-A',
          goal: 'blocked-not-dep',
          depends_on: [],
          tasks: [
            { task: 'S03-A-T01', goal: 'g', dependencies: [], blocked_by: ['S03-A-T02'] },
            { task: 'S03-A-T02', goal: 'g', dependencies: [], blocked_by: [] },
          ],
        },
      ],
    };
    assert.throws(
      () => buildAcceptedPlanTaskGraph(nonDependencyBlockedPlan, PLAN_REF, PLAN_DIGEST),
      Error,
      'blocked_by to a declared but non-dependency task must fail closed',
    );
    const validDependencyBlockedPlan = {
      ...planFixture(),
      slices: [
        {
          slice: 'S03-A',
          goal: 'blocked-dep',
          depends_on: [],
          tasks: [
            { task: 'S03-A-T01', goal: 'g', dependencies: ['S03-A-T02'], blocked_by: ['S03-A-T02'] },
            { task: 'S03-A-T02', goal: 'g', dependencies: [], blocked_by: [] },
          ],
        },
      ],
    };
    const validBlockedGraph = buildAcceptedPlanTaskGraph(validDependencyBlockedPlan, PLAN_REF, PLAN_DIGEST);
    assert.equal(isAcceptedPlanTaskGraph(validBlockedGraph), true, 'valid-target blocked_by builds a brand-bound graph');
    assert.equal(
      validBlockedGraph.edges.some((e) => e.kind === 'blocked_by' && e.from === 'S03-A-T01' && e.to === 'S03-A-T02'),
      true,
      'blocked_by edge must bind the same task to its real dependency',
    );


    const taskA = taskFact('S03-A-T01', []);
    const taskB = taskFact('S03-A-T02', ['S03-A-T01']);
    const taskC = taskFact('S03-B-T01', ['S03-A-T02']);
    for (const fact of [taskA, taskB, taskC]) {
      const validated = validateMesFactEnvelope(fact);
      assert.equal(validated.fact_kind, 'task');
      assert.equal(validated.task_status, 'PLANNED');
      assert.deepEqual(validated.depends_on_task_ids, fact.depends_on_task_ids);
    }

    // Every non-transport field value is closed.
    assert.deepEqual(MES_TASK_STATUSES, ['PLANNED', 'IN_PROGRESS', 'TASK_RESULT_SUBMITTED', 'TASK_COMPLETE']);
    assert.deepEqual(MES_VERIFIER_VERDICTS, ['PASS', 'FINDINGS', 'BLOCKED']);
    assert.deepEqual(MES_FINDING_DISPOSITIONS, ['ACCEPTED', 'VERIFIER_OVERREACH']);
    assert.deepEqual(MES_ROUTE_CODES, [
      'IMPLEMENTATION_DEFECT',
      'PLAN_GAP',
      'AUTHORITY_GAP',
      'TECHNICAL_UNKNOWN',
      'RUNTIME_BLOCKER',
      'USER_DECISION_REQUIRED',
      'EVIDENCE_GAP',
    ]);
    assert.deepEqual(MES_RESUME_TARGETS, ['producer', 'planner', 'authority-owner', 'research', 'recovery', 'verifier-lane']);
    assert.deepEqual(MES_GIT_SUBKINDS, ['candidate', 'integration', 'cleanup']);

    // finding + finding_disposition round-trip with closed payloads.
    const finding = validateMesFactEnvelope(findingFact());
    assert.equal(finding.verifier_verdict, 'FINDINGS');
    assert.equal(finding.claimed_route_code, 'IMPLEMENTATION_DEFECT');
    const disposition = validateMesFactEnvelope(dispositionFact());
    assert.equal(disposition.finding_disposition, 'ACCEPTED');
    assert.equal(disposition.accepted_route_code, 'IMPLEMENTATION_DEFECT');
    const overreach = validateMesFactEnvelope(
      dispositionFact({ finding_disposition: 'VERIFIER_OVERREACH', accepted_route_code: null }),
    );
    assert.equal(overreach.accepted_route_code, null);

    // result facts carry the closed result_id + result_payload_digest pair.
    const result = validateMesFactEnvelope(resultFact('r1'));
    assert.equal(result.result_id, 'attempt-r1');
    assert.match(result.result_payload_digest!, /^[0-9a-f]{64}$/);

    // The 8 legacy S01 result facts keep flowing: the machine-closed predicate
    // exempts exactly them (both new fields omitted allowed, everything else
    // still closed-validated).
    const legacy = validateMesFactEnvelope(legacyS01ResultFact());
    assert.equal(legacy.result_id, undefined);
    assert.equal(legacy.result_payload_digest, undefined);
    assert.equal(isLegacyS01Result(legacy), true);
    assert.equal(isExecuteResult(legacy), false);
    assert.equal(isLegacyS01Result(result), false);
    assert.equal(isExecuteResult(result), true);

    // git facts carry the closed execute payload when present.
    const git = validateMesFactEnvelope(gitFact());
    assert.equal(git.git_subkind, 'candidate');
    assert.equal(git.candidate_ref, 'proofloop-s03-a');
    assert.equal(git.commit_sha, 'c'.repeat(40));
    assert.deepEqual(git.changed_files, ['packages/runtime/src/mes/types.ts']);
    // An existing-style git fact (no execute payload) still rehydrates.
    const plainGit = validateMesFactEnvelope({
      schema_version: 2,
      fact_id: 'mes:fact:git:S01',
      fact_kind: 'git',
      created_by: 'brain',
      authority_refs: ['PRD.md#FR-003'],
      scope: { stage_id: 'S01' },
      plan_binding: acceptedBinding('delivery/stages/S01/plan.md', sha('s01-plan')),
      git_basis: GIT_BASIS,
    });
    assert.equal(plainGit.git_subkind, undefined);

    // Durable write-through at the ONLY store boundary: a task fact set with
    // the brand-validated graph persists and rehydrates deterministically.
    const fixture = makeFixture();
    try {
      commitAll(fixture, 'baseline');
      const store = createMesSnapshotStore(fixture.dir);
      store.write([taskA, taskB, taskC, finding, disposition, result], { acceptedPlanTaskGraph: graph });
      const rehydrated = store.read();
      const taskIds = rehydrated.filter((f) => f.fact_kind === 'task').map((f) => f.fact_id).sort();
      assert.deepEqual(taskIds, ['mes:fact:task:S03-A-T01', 'mes:fact:task:S03-A-T02', 'mes:fact:task:S03-B-T01']);
      assert.deepEqual(rehydrated.filter((f) => f.fact_kind === 'finding')[0].claimed_route_code, 'IMPLEMENTATION_DEFECT');
      assert.deepEqual(rehydrated.filter((f) => f.fact_kind === 'result')[0].result_payload_digest, result.result_payload_digest);
      // A NEW store instance (restart) re-reads the same facts.
      const freshStore = new MesSnapshotStore(fixture.dir);
      assert.equal(freshStore.read().length, 6);
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects malformed execute facts, transport metadata, non-S01 results lacking both new fields, partial pairs and store-boundary graph omission', () => {
    // Unknown fact kind fails closed.
    assert.throws(
      () => validateMesFactEnvelope({ ...taskFact('S03-A-T01', []), fact_kind: 'task_progress' }),
      SchemaValidationError,
    );

    // Transport / session metadata and routing fields are never fact content
    // (STATIC-08 / FR-014 / §2.5).
    const metadataPayloads: Array<[string, Record<string, unknown>]> = [
      ['next_task_id', { next_task_id: 'S03-A-T02' }],
      ['next_action', { next_action: 'run' }],
      ['route', { route: 'somewhere' }],
      ['reasoning', { reasoning: 'because' }],
      ['agent name', { agent_name: 'subagent-worker-s03-a' }],
      ['pane', { pane: 'pane-1' }],
      ['link message id', { link_message_id: 'hl_mtot7fe8' }],
      ['sent', { sent: true }],
      ['idle', { idle: true }],
      ['done', { done: true }],
    ];
    for (const [label, extra] of metadataPayloads) {
      assert.throws(
        () => validateMesFactEnvelope({ ...taskFact('S03-A-T01', []), ...extra }),
        SchemaValidationError,
        `${label} must be rejected as unknown fact content`,
      );
    }

    // task payload violations: missing / non-closed task_status, non-canonical
    // or duplicate depends_on_task_ids, non-canonical blocked_by_task_id.
    const noStatus = { ...taskFact('S03-A-T01', []) } as Record<string, unknown>;
    delete noStatus.task_status;
    assert.throws(() => validateMesFactEnvelope(noStatus), SchemaValidationError, 'task fact requires task_status');
    assert.throws(
      () => validateMesFactEnvelope(taskFact('S03-A-T01', [], { task_status: 'DONE' })),
      SchemaValidationError,
      'unknown task_status fails closed',
    );
    assert.throws(
      () => validateMesFactEnvelope(taskFact('S03-A-T01', [], { depends_on_task_ids: ['S03-A-T01', 'S03-A-T01'] })),
      SchemaValidationError,
      'duplicate depends_on_task_ids fails closed',
    );
    assert.throws(
      () => validateMesFactEnvelope(taskFact('S03-A-T01', [], { depends_on_task_ids: ['not-a-task'] })),
      SchemaValidationError,
      'non-canonical depends_on_task_ids fails closed',
    );
    assert.throws(
      () => validateMesFactEnvelope(taskFact('S03-A-T01', [], { blocked_by_task_id: 'S03-A-T01/2' })),
      SchemaValidationError,
      'non-canonical blocked_by_task_id fails closed',
    );
    assert.throws(
      () => validateMesFactEnvelope({ ...taskFact('S03-A-T01', []), scope: { stage_id: 'S03' } }),
      SchemaValidationError,
      'task fact requires stage+slice+task scope',
    );

    // finding payload violations.
    assert.throws(
      () => validateMesFactEnvelope(findingFact({ verifier_verdict: 'MAYBE' })),
      SchemaValidationError,
      'unknown verifier verdict fails closed',
    );
    assert.throws(
      () => validateMesFactEnvelope(findingFact({ claimed_route_code: 'AUTO_ROUTE' })),
      SchemaValidationError,
      'unknown claimed_route_code fails closed',
    );

    // finding_disposition violations (§2.2.3): VERIFIER_OVERREACH forces
    // accepted_route_code null; ACCEPTED forces a legal route code.
    assert.throws(
      () =>
        validateMesFactEnvelope(
          dispositionFact({ finding_disposition: 'VERIFIER_OVERREACH', accepted_route_code: 'IMPLEMENTATION_DEFECT' }),
        ),
      SchemaValidationError,
      'VERIFIER_OVERREACH must null accepted_route_code',
    );
    assert.throws(
      () => validateMesFactEnvelope(dispositionFact({ finding_disposition: 'ACCEPTED', accepted_route_code: null })),
      SchemaValidationError,
      'ACCEPTED requires a legal accepted_route_code',
    );
    assert.throws(
      () => validateMesFactEnvelope(dispositionFact({ finding_disposition: 'SKIPPED' })),
      SchemaValidationError,
      'unknown finding_disposition fails closed',
    );
    assert.throws(
      () => validateMesFactEnvelope(dispositionFact({ resume_target: 'pm' })),
      SchemaValidationError,
      'unknown resume_target fails closed',
    );
    assert.throws(
      () => validateMesFactEnvelope(dispositionFact({ reason: '' })),
      SchemaValidationError,
      'empty reason fails closed',
    );

    // result payload violations: a NON-S01 (S03) result lacking both new
    // fields is rejected — not just the partial-pair case; partial pairs
    // (mixed state) fail closed in both directions; invalid digests and
    // control characters fail closed.
    const s03ResultMissing = { ...resultFact('r-missing') } as Record<string, unknown>;
    delete s03ResultMissing.result_id;
    delete s03ResultMissing.result_payload_digest;
    assert.throws(
      () => validateMesFactEnvelope(s03ResultMissing),
      SchemaValidationError,
      'non-S01 result with both new fields missing must be rejected',
    );
    assert.throws(
      () => validateMesFactEnvelope(resultFact('r-partial', { result_payload_digest: undefined })),
      SchemaValidationError,
      'partial pair (result_id only) fails closed',
    );
    const legacyPartial = legacyS01ResultFact() as unknown as Record<string, unknown>;
    legacyPartial.result_id = 'attempt-legacy';
    assert.throws(
      () => validateMesFactEnvelope(legacyPartial),
      SchemaValidationError,
      'legacy predicate true but only one field present (mixed state) fails closed',
    );
    assert.throws(
      () => validateMesFactEnvelope(resultFact('r-bad-digest', { result_payload_digest: 'not-hex' })),
      SchemaValidationError,
      'invalid result_payload_digest fails closed',
    );
    assert.throws(
      () => validateMesFactEnvelope(resultFact('r-ctrl', { result_id: 'bad\u0000id' })),
      SchemaValidationError,
      'control character in result_id fails closed',
    );

    // git payload violations.
    assert.throws(
      () => validateMesFactEnvelope(gitFact({ git_subkind: 'merge' })),
      SchemaValidationError,
      'unknown git_subkind fails closed',
    );
    assert.throws(
      () => validateMesFactEnvelope(gitFact({ commit_sha: 'abc' })),
      SchemaValidationError,
      'commit_sha must be 40-hex',
    );
    assert.throws(
      () => validateMesFactEnvelope(gitFact({ candidate_ref: '../escape' })),
      SchemaValidationError,
      'candidate_ref must be a canonical ref',
    );
    assert.throws(
      () => validateMesFactEnvelope(gitFact({ changed_files: ['../../etc/passwd'] })),
      SchemaValidationError,
      'changed_files must be canonical root-relative paths',
    );
    assert.throws(
      () => validateMesFactEnvelope({ ...gitFact(), candidate_ref: undefined } as unknown as Record<string, unknown>),
      SchemaValidationError,
      'partial git execute payload (missing candidate_ref) fails closed',
    );
    assert.throws(
      () => validateMesFactEnvelope({ ...gitFact(), changed_files: undefined } as unknown as Record<string, unknown>),
      SchemaValidationError,
      'partial git execute payload (missing changed_files) fails closed',
    );

    // Per-kind payload field closure: a cross-kind known payload field is
    // rejected even though the envelope validator knows the field name — the
    // kind binding owns the field (STATIC-08 / §2.2).
    const crossKindPayloads: Array<[string, Record<string, unknown>]> = [
      ['result_id on task fact', { ...taskFact('S03-A-T01', []), result_id: 'attempt-1' }],
      ['git_subkind on task fact', { ...taskFact('S03-A-T01', []), git_subkind: 'candidate' }],
      ['task_status on result fact', { ...resultFact('r-cross'), task_status: 'PLANNED' }],
      ['blocked_by_task_id on git fact', { ...gitFact({ fact_id: 'mes:fact:git:S03:cross' }), blocked_by_task_id: 'S03-A-T01' }],
      ['result_payload_digest on finding fact', { ...findingFact({ fact_id: 'mes:fact:finding:S03:cross' }), result_payload_digest: 'a'.repeat(64) }],
      ['depends_on_task_ids on disposition fact', { ...dispositionFact({ fact_id: 'mes:fact:disposition:S03:cross' }), depends_on_task_ids: ['S03-A-T01'] }],
      ['result_id on work fact', {
        schema_version: 2,
        fact_id: 'mes:fact:work:cross',
        fact_kind: 'work',
        created_by: 'brain',
        authority_refs: ['PRD.md#FR-003'],
        scope: { stage_id: 'S03' },
        work_id: 'mes:work:S03:cross',
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
        result_id: 'attempt-1',
      }],
      ['task_status on project fact', {
        schema_version: 2,
        fact_id: 'mes:fact:project:cross',
        fact_kind: 'project',
        created_by: 'brain',
        authority_refs: ['PRD.md#FR-003'],
        task_status: 'PLANNED',
      }],
    ];
    for (const [label, payload] of crossKindPayloads) {
      assert.throws(
        () => validateMesFactEnvelope(payload),
        SchemaValidationError,
        `${label} must fail closed`,
      );
    }


    // Store-boundary durable write-through: a task fact WITHOUT the graph is
    // no-write at the store boundary, and a task fact WITH an invalid graph
    // (plain JSON / brand missing / digest mismatch / edge mismatch /
    // phantom task / non-dependency blocked_by) is no-write — the previous
    // snapshot stays byte-for-byte intact.
    const fixture = makeFixture();
    try {
      commitAll(fixture, 'baseline');
      const store = createMesSnapshotStore(fixture.dir);
      store.write([taskFact('S03-A-T01', [])], { acceptedPlanTaskGraph: buildAcceptedPlanTaskGraph(planFixture(), PLAN_REF, PLAN_DIGEST) });
      const baseline = store.read();

      const graph = buildAcceptedPlanTaskGraph(planFixture(), PLAN_REF, PLAN_DIGEST);
      const graphAsRecord = graph as unknown as Record<string, unknown>;

      // 1) missing graph parameter → no-write.
      assert.throws(() => store.write([taskFact('S03-A-T02', ['S03-A-T01'])]), MesSnapshotStoreError);
      assert.deepEqual(store.read(), baseline, 'snapshot must stay unchanged after graph-omission no-write');

      // 2) plain JSON / deserialized shape with matching digest → brand
      //    missing → fail closed (provenance boundary).
      const phantomPlain = JSON.parse(JSON.stringify(graphAsRecord)) as AcceptedPlanTaskGraph;
      assert.throws(
        () => store.write([taskFact('S03-A-T02', ['S03-A-T01'])], { acceptedPlanTaskGraph: phantomPlain }),
        MesSnapshotStoreError,
        'plain JSON graph without the brand must fail closed',
      );
      assert.deepEqual(store.read(), baseline, 'snapshot must stay unchanged after phantom graph no-write');

      // 3) brand present but graph_digest tampered → recomputation mismatch.
      const tampered = {
        ...graphAsRecord,
        graph_digest: 'f'.repeat(64),
      } as unknown as AcceptedPlanTaskGraph;
      assert.throws(
        () => store.write([taskFact('S03-A-T02', ['S03-A-T01'])], { acceptedPlanTaskGraph: tampered }),
        MesSnapshotStoreError,
        'tampered graph_digest must fail closed',
      );

      // 4) accepted_plan_ref mismatch with the fact binding.
      const wrongRef = buildAcceptedPlanTaskGraph(planFixture(), 'delivery/stages/S03/other.md', PLAN_DIGEST);
      assert.throws(
        () => store.write([taskFact('S03-A-T02', ['S03-A-T01'])], { acceptedPlanTaskGraph: wrongRef }),
        MesSnapshotStoreError,
        'graph accepted_plan_ref must equal the fact plan binding',
      );

      // 5) accepted_plan_digest mismatch with the fact binding.
      const wrongDigest = buildAcceptedPlanTaskGraph(planFixture(), PLAN_REF, sha('other-plan'));
      assert.throws(
        () => store.write([taskFact('S03-A-T02', ['S03-A-T01'])], { acceptedPlanTaskGraph: wrongDigest }),
        MesSnapshotStoreError,
        'graph accepted_plan_digest must equal the fact plan_digest',
      );

      // 6) edge-set mismatch: fact declares a dependency the accepted plan
      //    does not contain (extra edge) — rejected.
      assert.throws(
        () => store.write([taskFact('S03-A-T02', ['S03-A-T01', 'S03-B-T01'])], { acceptedPlanTaskGraph: graph }),
        MesSnapshotStoreError,
        'extra depends_on edge must fail closed',
      );

      // 7) edge-set mismatch: fact omits a plan dependency (missing edge).
      assert.throws(
        () => store.write([taskFact('S03-B-T01', [])], { acceptedPlanTaskGraph: graph }),
        MesSnapshotStoreError,
        'missing depends_on edge must fail closed',
      );

      // 8) phantom task id: fact task is not part of the accepted plan graph.
      assert.throws(
        () => store.write([taskFact('S03-Z-T99', [])], { acceptedPlanTaskGraph: graph }),
        MesSnapshotStoreError,
        'phantom task id must fail closed',
      );

      // 9) blocked_by not inside the dependency edge set.
      assert.throws(
        () => store.write([taskFact('S03-A-T01', [], { blocked_by_task_id: 'S03-B-T01' })], { acceptedPlanTaskGraph: graph }),
        MesSnapshotStoreError,
        'blocked_by must be a real plan dependency of the task',
      );

      // 10) a valid blocked_by (real dependency) passes the store boundary.
      //     (The store has replace-all semantics for non-planning facts, so
      //     resubmit the baseline fact together with the new task fact.)
      store.write([taskFact('S03-A-T01', []), taskFact('S03-A-T02', ['S03-A-T01'], { blocked_by_task_id: 'S03-A-T01' })], { acceptedPlanTaskGraph: graph });
      const afterBlocked = store.read();
      assert.equal(afterBlocked.length, 2, 'both task facts must be durable after a valid blocked_by write');
      assert.equal(afterBlocked.find((f) => f.fact_kind === 'task' && f.scope?.task_id === 'S03-A-T02')?.blocked_by_task_id, 'S03-A-T01');
      // 11) non-task facts never require the graph.
      store.write([resultFact('r2')]);
      const afterResult = store.read();
      assert.equal(afterResult.length, 1, 'replace-all snapshot now carries only the result fact');
      assert.equal(afterResult[0].fact_kind, 'result');
      // 12) (S03-STAGE-REVIEW-F001) cross-stage/cross-slice task facts are
      //     rejected no-write: the task_id-derived stage/slice must equal the
      //     fact scope — an S03-B-T01 task id (canonically IN the accepted
      //     plan graph) scoped to a foreign stage/slice must never be
      //     durably written, and the previous snapshot stays intact.
      const crossStage = taskFact('S03-B-T01', ['S03-A-T02'], {
        scope: { stage_id: 'S02', slice_id: 'S02-B', task_id: 'S03-B-T01' },
        work_id: 'mes:work:S02:S02-B:1',
      });
      assert.throws(() => store.write([crossStage], { acceptedPlanTaskGraph: graph }), MesSnapshotStoreError, 'cross-stage task fact must fail closed no-write');
      const crossSlice = taskFact('S03-B-T01', ['S03-A-T02'], {
        scope: { stage_id: 'S03', slice_id: 'S03-A', task_id: 'S03-B-T01' },
        work_id: 'mes:work:S03:S03-A:1',
      });
      assert.throws(() => store.write([crossSlice], { acceptedPlanTaskGraph: graph }), MesSnapshotStoreError, 'cross-slice task fact must fail closed no-write');
      assert.deepEqual(store.read(), afterResult, 'snapshot must stay unchanged after cross-stage/slice no-write');
    } finally {
      fixture.cleanup();
    }
  });

  test('execute kinds carry delivery_cycle_id PLAN-BOUND inside plan_binding; a top-level cycle fails closed (S05-A-T01 per-kind position)', () => {
    const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
    // Plan-bound position (contracts §2.2.2 / architecture
    // delivery-cycle-semantics "Field placement is closed"): the opaque
    // cycle lives INSIDE plan_binding on every plan-bound execute kind.
    const planBound = taskFact('S03-A-T01', [], {
      plan_binding: { ...acceptedBinding(), delivery_cycle_id: CYCLE },
    });
    const withCycle = validateMesFactEnvelope(planBound);
    assert.equal(
      (withCycle.plan_binding as { delivery_cycle_id?: string }).delivery_cycle_id,
      CYCLE,
    );
    // Every plan-bound execute kind accepts the plan-bound cycle.
    const planBoundKinds: Array<() => MesFactEnvelope> = [
      () => taskFact('S03-A-T01', [], { plan_binding: { ...acceptedBinding(), delivery_cycle_id: CYCLE } }),
      () => resultFact('r1', { plan_binding: { ...acceptedBinding(), delivery_cycle_id: CYCLE } }),
      () => gitFact({ plan_binding: { ...acceptedBinding(), delivery_cycle_id: CYCLE } }),
      () => findingFact({ plan_binding: { ...acceptedBinding(), delivery_cycle_id: CYCLE } }),
    ];
    for (const make of planBoundKinds) {
      const fact = validateMesFactEnvelope(make());
      assert.equal(
        (fact.plan_binding as { delivery_cycle_id?: string }).delivery_cycle_id,
        CYCLE,
      );
    }
    // The TOP-LEVEL position is terminal-only: the same execute kinds
    // carrying the cycle at the envelope top level fail closed (per-kind
    // position rule, STATIC-08/STATIC-10).
    const topLevelKinds: Array<() => MesFactEnvelope> = [
      () => taskFact('S03-A-T01', [], { delivery_cycle_id: CYCLE }),
      () => resultFact('r1', { delivery_cycle_id: CYCLE }),
      () => gitFact({ delivery_cycle_id: CYCLE }),
      () => findingFact({ delivery_cycle_id: CYCLE }),
    ];
    for (const make of topLevelKinds) {
      assert.throws(
        () => validateMesFactEnvelope(make()),
        SchemaValidationError,
        'top-level delivery_cycle_id on an execute kind must fail closed (plan-bound position)',
      );
    }
  });
});

/**
 * Cross-Stage task-fact durable retention at the MesSnapshotStore write-through
 * boundary (S04 mixed-stage replace-all repair).
 *
 * # PO: PO-S03-A-01, PO-S03-A-02 (S03 store durable write-through boundary;
 *       repaired for legal mixed-stage retention when a replace-all submission
 *       carries already-durable historical task facts + the current Stage's new
 *       task facts)
 *
 * The store accepts exactly ONE `acceptedPlanTaskGraph` per write, bound to the
 * CURRENT Stage's accepted Plan. A replace-all submission that carries both
 * already-durable S03 task facts (byte-identical to the snapshot) and new S04
 * task facts must therefore:
 *   - retain the durable S03 facts WITHOUT re-validating them against the S04
 *     graph (they were graph-bound at their own durable write against the S03
 *     accepted Plan graph) — otherwise the S03 facts no-write the whole
 *     submission (accepted_plan_ref/digest/edge mismatch);
 *   - keep the S04 facts fully fail-closed against the S04 graph (missing
 *     graph / wrong graph / phantom task id / dependency edge mismatch /
 *     cross-stage or cross-slice scope mismatch → no-write, previous snapshot
 *     byte-identical);
 *   - grant retention ONLY on exact canonical byte-equivalence: a changed
 *     payload under an existing fact_id falls back to full graph validation and
 *     can never borrow retention to bypass it.
 */
describe('cross-Stage task-fact durable retention at the store boundary (mixed-stage replace-all)', () => {
  test('retained S03 task facts + new S04 task facts + S04 graph durably coexist and survive restart', () => {
    // RED baseline (before the retention fix): this mixed write throws
    // MesSnapshotStoreError — the retained S03 facts are re-validated against
    // the S04 graph (accepted_plan_ref/digest/edge mismatch) → stable no-write.
    const fixture = makeFixture();
    try {
      commitAll(fixture, 'baseline');
      const store = createMesSnapshotStore(fixture.dir);

      // Generation 1: S03 task facts durably bound to the S03 graph.
      const s03Graph = buildAcceptedPlanTaskGraph(planFixture(), PLAN_REF, PLAN_DIGEST);
      const s03TaskA = taskFact('S03-A-T01', []);
      const s03TaskB = taskFact('S03-A-T02', ['S03-A-T01']);
      store.write([s03TaskA, s03TaskB], { acceptedPlanTaskGraph: s03Graph });
      assert.equal(store.read().filter((f) => f.fact_kind === 'task').length, 2);

      // Generation 2: replace-all submission carrying the durable S03 facts
      // (byte-identical) PLUS new S04 task facts, bound to the S04 graph.
      const s04Graph = buildAcceptedPlanTaskGraph(s04PlanFixture(), S04_REF, S04_DIGEST);
      const s04TaskA = s04TaskFact('S04-A-T01', []);
      const s04TaskB = s04TaskFact('S04-A-T02', ['S04-A-T01']);
      store.write([s03TaskA, s03TaskB, s04TaskA, s04TaskB], { acceptedPlanTaskGraph: s04Graph });

      // Both generations must be durable in ONE snapshot.
      const rehydrated = store.read();
      const taskIds = rehydrated
        .filter((f) => f.fact_kind === 'task')
        .map((f) => f.scope?.task_id)
        .sort();
      assert.deepEqual(taskIds, ['S03-A-T01', 'S03-A-T02', 'S04-A-T01', 'S04-A-T02']);

      // Restart / re-read with a FRESH store instance (recovery evidence).
      const fresh = new MesSnapshotStore(fixture.dir);
      const restarted = fresh.read();
      assert.deepEqual(
        restarted.filter((f) => f.fact_kind === 'task').map((f) => f.scope?.task_id).sort(),
        ['S03-A-T01', 'S03-A-T02', 'S04-A-T01', 'S04-A-T02'],
      );
      assert.equal(restarted.length, 4);
    } finally {
      fixture.cleanup();
    }
  });

  test('new S04 task facts keep fail-closed graph binding inside a mixed-stage submission; snapshot stays byte-identical', () => {
    const fixture = makeFixture();
    try {
      commitAll(fixture, 'baseline');
      const store = createMesSnapshotStore(fixture.dir);
      const s03Graph = buildAcceptedPlanTaskGraph(planFixture(), PLAN_REF, PLAN_DIGEST);
      const s03TaskA = taskFact('S03-A-T01', []);
      const s03TaskB = taskFact('S03-A-T02', ['S03-A-T01']);
      store.write([s03TaskA, s03TaskB], { acceptedPlanTaskGraph: s03Graph });
      const durable = store.read();

      const s04Graph = buildAcceptedPlanTaskGraph(s04PlanFixture(), S04_REF, S04_DIGEST);
      const s04TaskA = s04TaskFact('S04-A-T01', []);

      // (a) new S04 task fact WITHOUT the graph → no-write.
      assert.throws(
        () => store.write([s03TaskA, s03TaskB, s04TaskA]),
        MesSnapshotStoreError,
        'new S04 task fact without the accepted_plan_task_graph must fail closed no-write',
      );
      assert.deepEqual(store.read(), durable, 'snapshot must stay byte-identical after missing-graph no-write');

      // (b) new S04 task fact bound against the WRONG (S03) graph → no-write.
      assert.throws(
        () => store.write([s03TaskA, s03TaskB, s04TaskA], { acceptedPlanTaskGraph: s03Graph }),
        MesSnapshotStoreError,
        'S04 task fact vs the S03 accepted plan graph must fail closed no-write',
      );
      assert.deepEqual(store.read(), durable, 'snapshot must stay byte-identical after wrong-graph no-write');

      // (c) phantom task id: S04 task not part of the S04 accepted plan graph.
      assert.throws(
        () => store.write([s03TaskA, s03TaskB, s04TaskFact('S04-Z-T99', [])], { acceptedPlanTaskGraph: s04Graph }),
        MesSnapshotStoreError,
        'phantom S04 task id must fail closed no-write',
      );
      assert.deepEqual(store.read(), durable, 'snapshot must stay byte-identical after phantom-task no-write');

      // (d) dependency edge mismatch: S04-A-T02 missing its S04-A-T01 dependency.
      assert.throws(
        () => store.write([s03TaskA, s03TaskB, s04TaskFact('S04-A-T02', [])], { acceptedPlanTaskGraph: s04Graph }),
        MesSnapshotStoreError,
        'missing dependency edge on a new S04 task fact must fail closed no-write',
      );
      assert.deepEqual(store.read(), durable, 'snapshot must stay byte-identical after edge-mismatch no-write');

      // (e) cross-stage scope mismatch on a new S04 task fact.
      const crossStage = s04TaskFact('S04-A-T01', [], {
        scope: { stage_id: 'S03', slice_id: 'S03-A', task_id: 'S04-A-T01' },
        work_id: 'mes:work:S03:S03-A:1',
      });
      assert.throws(
        () => store.write([s03TaskA, s03TaskB, crossStage], { acceptedPlanTaskGraph: s04Graph }),
        MesSnapshotStoreError,
        'cross-stage S04 task fact must fail closed no-write',
      );
      assert.deepEqual(store.read(), durable, 'snapshot must stay byte-identical after cross-stage no-write');
    } finally {
      fixture.cleanup();
    }
  });

  test('retention requires exact canonical byte-equivalence; a changed payload under an existing fact_id cannot bypass graph validation', () => {
    const fixture = makeFixture();
    try {
      commitAll(fixture, 'baseline');
      const store = createMesSnapshotStore(fixture.dir);
      const s03Graph = buildAcceptedPlanTaskGraph(planFixture(), PLAN_REF, PLAN_DIGEST);
      const s03TaskA = taskFact('S03-A-T01', []);
      const s03TaskB = taskFact('S03-A-T02', ['S03-A-T01']);
      store.write([s03TaskA, s03TaskB], { acceptedPlanTaskGraph: s03Graph });
      const durable = store.read();

      // Same fact_id, CHANGED canonical payload (task_status mutated), submitted
      // with the S04 graph → NOT retained; the changed fact must bind the
      // submitted graph and fails closed (S03 binding vs S04 graph).
      const s04Graph = buildAcceptedPlanTaskGraph(s04PlanFixture(), S04_REF, S04_DIGEST);
      const changedS03A = { ...s03TaskA, task_status: 'IN_PROGRESS' } as MesFactEnvelope;
      const s04TaskA = s04TaskFact('S04-A-T01', []);
      assert.throws(
        () => store.write([changedS03A, s04TaskA], { acceptedPlanTaskGraph: s04Graph }),
        MesSnapshotStoreError,
        'changed canonical payload under an existing fact_id must fail closed (no retention bypass)',
      );
      assert.deepEqual(store.read(), durable, 'snapshot must stay byte-identical after changed-payload no-write');

      // Positive control: the byte-identical S03 facts ARE retained and coexist
      // with the new S04 fact in the same submission.
      store.write([s03TaskA, s03TaskB, s04TaskA], { acceptedPlanTaskGraph: s04Graph });
      const rehydrated = store.read();
      assert.deepEqual(
        rehydrated.filter((f) => f.fact_kind === 'task').map((f) => f.scope?.task_id).sort(),
        ['S03-A-T01', 'S03-A-T02', 'S04-A-T01'],
      );
    } finally {
      fixture.cleanup();
    }
  });
});
