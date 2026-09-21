/**
 * Replan impact classifier regression tests (Plan/MES/Git-basis binding).
 *
 * Exercises the pure classifier over accepted-Thin-Plan snapshot inputs:
 *   - Case 1: only Slice C changes → A/B completed facts carry forward;
 *   - Case 2: A→C→D dependency chain — A changes invalidates A/C/D, sibling B
 *     stays valid;
 *   - Case 3: Stage global contract change → every Slice fact invalidated
 *     (stage-wide, nothing carries);
 *   - Case 4: Plan metadata-only change (plan_ref/plan_digest/Git snapshot)
 *     → Slice execution proof stays valid (task-local no-op);
 *   - Case 5: Authority ref used only by A → A invalidated, B unaffected;
 *   - closed-field validation rejects unknown root/snapshot/nested keys
 *     fail-closed (schema_version 2 closed-field validation);
 *   - malformed/unprovable dependency closure → unresolved CLOSURE_UNPROVABLE;
 *   - STAGE_MISMATCH → unresolved;
 *   - Task-local completed-predecessor carry-forward (Case 8) and proof-boundary
 *     → slice-wide escalation (Case 9);
 *   - determinism / order-independence of the disposition.
 *
 * Imports the compiled runtime dist (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyReplanImpact,
  ReplanImpactError,
  type ReplanPlanSnapshotInput,
  type ReplanTaskContractInput,
  type ReplanSliceContractInput,
  type ReplanImpactDisposition,
} from '../dist/vnext/replan-impact'; // internal compiled module (raw engine is not a runtime public index export; F-T02 removes the vnext/index re-export)
import { sha } from './helpers';

// ---------------------------------------------------------------------------
// Fixture builders (deterministic snapshot pairs over accepted-Plan facts).
// ---------------------------------------------------------------------------

interface SliceCfg {
  readonly id: string;
  readonly tasks: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly goalRef?: string;
  readonly sliceContractDigest?: string;
}

interface TaskCfg {
  readonly id: string;
  readonly slice: string;
  readonly goal?: string;
  readonly refs?: readonly string[];
  readonly dependencies?: readonly string[];
  readonly skills?: readonly string[];
}

interface SnapshotCfg {
  readonly stageId?: string;
  readonly planRef?: string;
  readonly planDigest?: string;
  readonly stageContractDigest?: string;
  readonly snapshotDigest?: string;
  readonly authorityRefIds?: readonly string[];
  readonly slices: readonly SliceCfg[];
  readonly tasks: readonly TaskCfg[];
}

const STAGE = 'S01';
const PLAN_REF = 'plan:S01:v1';
const PLAN_DIGEST = sha('plan-digest-v1');
const STAGE_CONTRACT_DIGEST = sha('stage-contract-v1');
const SNAPSHOT_DIGEST = 'a'.repeat(64);

function buildSnapshot(cfg: SnapshotCfg): ReplanPlanSnapshotInput {
  const slices: ReplanSliceContractInput[] = cfg.slices.map((s) => {
    const goalRef = s.goalRef ?? `goal:${s.id}`;
    return {
      slice_id: s.id,
      slice_contract_digest: s.sliceContractDigest ?? sha(`slice-contract:${s.id}`),
      depends_on: [...(s.dependsOn ?? [])],
      required_skills: ['execute'],
      evidence_path: `delivery/stages/${STAGE}/evidence/${s.id}.md`,
      proof_index: {
        slice_id: s.id,
        goal_ref: goalRef,
        task_refs: [],
        acceptance_refs: [],
        seam_refs: [],
        oracle_refs: [],
        risk_refs: [],
      },
      task_ids: [...s.tasks],
    };
  });

  const tasks: ReplanTaskContractInput[] = cfg.tasks.map((t) => ({
    task_id: t.id,
    slice_id: t.slice,
    goal: t.goal ?? `Goal ${t.id}`,
    refs: [...(t.refs ?? [])],
    dependencies: [...(t.dependencies ?? [])],
    required_skills: [...(t.skills ?? ['execute'])],
    execution_scope: {
      kind: 'implementation',
      code_paths: [`packages/runtime/src/vnext/${t.id}.ts`],
      test_paths: [`packages/runtime/test/${t.id}.test.ts`],
      forbidden_paths: ['.proofloop', '.git'],
    },
  }));

  // Auto-build the reference index from every referenced ref id so all
  // descriptors resolve (deterministic per ref id).
  const referencedRefIds = new Set<string>();
  for (const s of slices) {
    referencedRefIds.add(s.proof_index.goal_ref);
    for (const ref of s.proof_index.task_refs) referencedRefIds.add(ref);
    for (const ref of s.proof_index.acceptance_refs) referencedRefIds.add(ref);
    for (const ref of s.proof_index.seam_refs) referencedRefIds.add(ref);
    for (const ref of s.proof_index.oracle_refs) referencedRefIds.add(ref);
    for (const r of s.proof_index.risk_refs) referencedRefIds.add(r.ref_id);
  }
  for (const t of tasks) {
    for (const ref of t.refs) referencedRefIds.add(ref);
  }
  const referenceIndex: Record<string, { kind: string; ref: string; file_digest: string; section_digest: string }> = {};
  for (const refId of referencedRefIds) {
    referenceIndex[refId] = {
      kind: refId.startsWith('goal:') ? 'goal' : 'task',
      ref: `tech-spec/#/entities/${refId}`,
      file_digest: sha(`file:${refId}`),
      section_digest: sha(`section:${refId}`),
    };
  }

  return {
    stage_id: cfg.stageId ?? STAGE,
    plan_ref: cfg.planRef ?? PLAN_REF,
    plan_digest: cfg.planDigest ?? PLAN_DIGEST,
    stage_contract_digest: cfg.stageContractDigest ?? STAGE_CONTRACT_DIGEST,
    snapshot_digest: cfg.snapshotDigest ?? SNAPSHOT_DIGEST,
    authority_ref_ids: [...(cfg.authorityRefIds ?? [])],
    reference_index: referenceIndex,
    slices,
    tasks,
  };
}

const EMPTY_SNAPSHOT: SnapshotCfg = { slices: [], tasks: [] };

/** Base plan: A(A1,A2) + independent B(B1). */
function basePlan(): { prev: ReplanPlanSnapshotInput; cand: ReplanPlanSnapshotInput } {
  const base: SnapshotCfg = {
    slices: [
      { id: 'A', tasks: ['A1', 'A2'] },
      { id: 'B', tasks: ['B1'] },
    ],
    tasks: [
      { id: 'A1', slice: 'A' },
      { id: 'A2', slice: 'A' },
      { id: 'B1', slice: 'B' },
    ],
  };
  return { prev: buildSnapshot(base), cand: buildSnapshot(base) };
}

const EXPECTED_DISPOSITION_KEYS = [
  'schema_version',
  'stage_id',
  'impact_scope',
  'changed_task_ids',
  'carry_forward_task_ids',
  'invalidated_task_ids',
  'previous_plan_ref',
  'plan_ref',
  'previous_plan_digest',
  'plan_digest',
  'snapshot_digest',
].sort();
/** Assert a schema_version-2 disposition with exactly the documented fields,
 *  plus at most the optional unresolved_reason key. */
function expectV2Shape(disp: ReplanImpactDisposition): void {
  assert.equal(disp.schema_version, 2);
  const keys = Object.keys(disp).sort();
  for (const required of EXPECTED_DISPOSITION_KEYS) {
    assert.ok(keys.includes(required), `missing disposition field ${required}`);
  }
  const extras = keys.filter((k) => !EXPECTED_DISPOSITION_KEYS.includes(k));
  assert.ok(
    extras.length === 0 || (extras.length === 1 && extras[0] === 'unresolved_reason'),
    `unexpected disposition fields: ${extras.join(',')}`,
  );
}

// ---------------------------------------------------------------------------
// Case 1 — only C changes: A/B completed facts carry forward.
// ---------------------------------------------------------------------------

describe('Case 1: only C changes leaves A/B carry-forward', () => {
  test('A/B completed tasks carry forward; only C invalidates', () => {
    const base: SnapshotCfg = {
      slices: [
        { id: 'A', tasks: ['A1', 'A2'] },
        { id: 'B', tasks: ['B1'] },
        { id: 'C', tasks: ['C1', 'C2'] },
      ],
      tasks: [
        { id: 'A1', slice: 'A' },
        { id: 'A2', slice: 'A' },
        { id: 'B1', slice: 'B' },
        { id: 'C1', slice: 'C' },
        { id: 'C2', slice: 'C' },
      ],
    };
    const cand: SnapshotCfg = {
      ...base,
      tasks: [...base.tasks.slice(0, 3), { id: 'C1', slice: 'C', goal: 'Goal C1 replanned' }, { id: 'C2', slice: 'C' }],
    };
    const disp = classifyReplanImpact({
      previous: buildSnapshot(base),
      candidate: buildSnapshot(cand),
      completed_task_ids: ['A1', 'A2', 'B1'],
    });
    expectV2Shape(disp);
    assert.equal(disp.impact_scope, 'task-local');
    assert.deepEqual(disp.changed_task_ids, ['C1']);
    assert.deepEqual(disp.invalidated_task_ids, ['C1', 'C2']);
    assert.deepEqual(disp.carry_forward_task_ids, ['A1', 'A2', 'B1']);
  });
});

// ---------------------------------------------------------------------------
// Case 2 — A→C→D dependency chain: A changes invalidates A/C/D, not sibling B.
// ---------------------------------------------------------------------------

describe('Case 2: dependency chain A→C→D', () => {
  test('A change invalidates A/C/D; sibling B stays valid', () => {
    const prev: SnapshotCfg = {
      slices: [
        { id: 'A', tasks: ['A1'] },
        { id: 'B', tasks: ['B1'] },
        { id: 'C', tasks: ['C1'], dependsOn: ['A'] },
        { id: 'D', tasks: ['D1'], dependsOn: ['C'] },
      ],
      tasks: [
        { id: 'A1', slice: 'A' },
        { id: 'B1', slice: 'B' },
        { id: 'C1', slice: 'C', dependencies: ['A1'] },
        { id: 'D1', slice: 'D', dependencies: ['C1'] },
      ],
    };
    const cand: SnapshotCfg = {
      ...prev,
      tasks: prev.tasks.map((t) => (t.id === 'A1' ? { ...t, goal: 'Goal A1 replanned' } : t)),
    };
    const disp = classifyReplanImpact({
      previous: buildSnapshot(prev),
      candidate: buildSnapshot(cand),
      completed_task_ids: ['A1', 'B1', 'C1', 'D1'],
    });
    expectV2Shape(disp);
    assert.equal(disp.impact_scope, 'task-local');
    assert.deepEqual(disp.changed_task_ids, ['A1']);
    assert.deepEqual(disp.invalidated_task_ids, ['A1', 'C1', 'D1']);
    assert.deepEqual(disp.carry_forward_task_ids, ['B1']);
  });
});

// ---------------------------------------------------------------------------
// Case 3 — Stage global contract change invalidates everything.
// ---------------------------------------------------------------------------

describe('Case 3: stage global contract invalidates all', () => {
  test('stage_contract_digest change → stage-wide, nothing carries', () => {
    const { prev } = basePlan();
    const candChanged = buildSnapshot({
      slices: [
        { id: 'A', tasks: ['A1', 'A2'] },
        { id: 'B', tasks: ['B1'] },
      ],
      tasks: [
        { id: 'A1', slice: 'A' },
        { id: 'A2', slice: 'A' },
        { id: 'B1', slice: 'B', goal: 'Goal B1 replanned' },
      ],
      stageContractDigest: sha('stage-contract-v2'),
    });
    const disp = classifyReplanImpact({
      previous: prev,
      candidate: candChanged,
      completed_task_ids: ['A1', 'A2', 'B1'],
    });
    expectV2Shape(disp);
    assert.equal(disp.impact_scope, 'stage-wide');
    assert.deepEqual(disp.changed_task_ids, ['B1']);
    assert.deepEqual(disp.carry_forward_task_ids, []);
    assert.deepEqual(disp.invalidated_task_ids, ['A1', 'A2', 'B1']);
  });
});

// ---------------------------------------------------------------------------
// Case 4 — Plan metadata-only change keeps Slice execution proof valid.
// ---------------------------------------------------------------------------

describe('Case 4: Plan metadata-only change leaves Slice proof valid', () => {
  test('only plan_ref/plan_digest/Git snapshot differ → task-local no-op', () => {
    const { prev } = basePlan();
    const cand = buildSnapshot({
      slices: [
        { id: 'A', tasks: ['A1', 'A2'] },
        { id: 'B', tasks: ['B1'] },
      ],
      tasks: [
        { id: 'A1', slice: 'A' },
        { id: 'A2', slice: 'A' },
        { id: 'B1', slice: 'B' },
      ],
      planRef: 'plan:S01:v2',
      planDigest: sha('plan-digest-v2'),
      snapshotDigest: 'b'.repeat(64),
    });
    const disp = classifyReplanImpact({
      previous: prev,
      candidate: cand,
      completed_task_ids: ['A1', 'A2', 'B1'],
    });
    expectV2Shape(disp);
    assert.equal(disp.impact_scope, 'task-local');
    assert.deepEqual(disp.changed_task_ids, []);
    assert.deepEqual(disp.invalidated_task_ids, []);
    assert.deepEqual(disp.carry_forward_task_ids, ['A1', 'A2', 'B1']);
    // Disposition binds the new accepted-Plan ref/digest + Git-basis snapshot.
    assert.equal(disp.previous_plan_ref, PLAN_REF);
    assert.equal(disp.plan_ref, 'plan:S01:v2');
    assert.equal(disp.previous_plan_digest, PLAN_DIGEST);
    assert.equal(disp.plan_digest, sha('plan-digest-v2'));
    assert.equal(disp.snapshot_digest, 'b'.repeat(64));
  });
});

// ---------------------------------------------------------------------------
// Case 5 — Authority ref used only by A invalidates A, not B.
// ---------------------------------------------------------------------------

describe('Case 5: authority ref used only by A', () => {
  test('authority ref set change attributable to A → slice-wide over A only', () => {
    const prev = buildSnapshot({
      slices: [
        { id: 'A', tasks: ['A1', 'A2'] },
        { id: 'B', tasks: ['B1'] },
      ],
      tasks: [
        { id: 'A1', slice: 'A', refs: ['auth:A'] },
        { id: 'A2', slice: 'A' },
        { id: 'B1', slice: 'B' },
      ],
      authorityRefIds: [],
    });
    const cand = buildSnapshot({
      slices: [
        { id: 'A', tasks: ['A1', 'A2'] },
        { id: 'B', tasks: ['B1'] },
      ],
      tasks: [
        { id: 'A1', slice: 'A', refs: ['auth:A'] },
        { id: 'A2', slice: 'A' },
        { id: 'B1', slice: 'B' },
      ],
      authorityRefIds: ['auth:A'],
    });
    const disp = classifyReplanImpact({
      previous: prev,
      candidate: cand,
      completed_task_ids: ['A1', 'A2', 'B1'],
    });
    expectV2Shape(disp);
    assert.equal(disp.impact_scope, 'slice-wide');
    assert.deepEqual(disp.changed_task_ids, []);
    assert.deepEqual(disp.invalidated_task_ids, ['A1', 'A2']);
    assert.deepEqual(disp.carry_forward_task_ids, ['B1']);
  });
});

// ---------------------------------------------------------------------------
// Closed-field validation rejects unknown keys fail-closed.
// ---------------------------------------------------------------------------

describe('closed-field validation rejects unknown keys fail-closed', () => {
  test('snapshot with an unknown field is rejected', () => {
    const { prev, cand } = basePlan();
    const snapWithUnknown = {
      ...cand,
      unknown_snapshot_field: sha('unknown-snapshot'),
    } as unknown as ReplanPlanSnapshotInput;
    assert.throws(
      () =>
        classifyReplanImpact({
          previous: prev,
          candidate: snapWithUnknown,
          completed_task_ids: [],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ReplanImpactError, `expected ReplanImpactError, got ${String(error)}`);
        assert.match(error.message, /unknown field unknown_snapshot_field/);
        return true;
      },
    );
  });

  test('root input with an unknown field is rejected', () => {
    const { prev, cand } = basePlan();
    const rootWithUnknown = {
      previous: prev,
      candidate: cand,
      completed_task_ids: [],
      unknown_root_field: sha('unknown-root'),
    } as unknown as Parameters<typeof classifyReplanImpact>[0];
    assert.throws(
      () => classifyReplanImpact(rootWithUnknown),
      (error: unknown) => {
        assert.ok(error instanceof ReplanImpactError, `expected ReplanImpactError, got ${String(error)}`);
        assert.match(error.message, /unknown field unknown_root_field/);
        return true;
      },
    );
  });


  test('unknown nested field in a Slice contract is rejected', () => {
    const { prev, cand } = basePlan();
    const sliced = {
      ...cand,
      slices: cand.slices.map((s, i) =>
        i === 0 ? ({ ...s, unknown_nested_field: 'x' } as unknown as ReplanSliceContractInput) : s,
      ),
    };
    assert.throws(
      () =>
        classifyReplanImpact({
          previous: prev,
          candidate: sliced,
          completed_task_ids: [],
        }),
      (error: unknown) => {
        assert.ok(error instanceof ReplanImpactError, `expected ReplanImpactError, got ${String(error)}`);
        assert.match(error.message, /unknown field unknown_nested_field/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Unresolved fail-closed cases.
// ---------------------------------------------------------------------------

describe('unresolved fail-closed', () => {
  test('STAGE_MISMATCH → unresolved with STAGE_MISMATCH reason', () => {
    const prev = buildSnapshot({ ...EMPTY_SNAPSHOT, slices: [{ id: 'A', tasks: ['A1'] }], tasks: [{ id: 'A1', slice: 'A' }] });
    const cand = buildSnapshot({
      stageId: 'S02',
      slices: [{ id: 'A', tasks: ['A1'] }],
      tasks: [{ id: 'A1', slice: 'A' }],
    });
    const disp = classifyReplanImpact({ previous: prev, candidate: cand, completed_task_ids: [] });
    expectV2Shape(disp);
    assert.equal(disp.impact_scope, 'unresolved');
    assert.equal(disp.unresolved_reason, 'STAGE_MISMATCH');
  });

  test('unknown dependency target → unresolved CLOSURE_UNPROVABLE', () => {
    const { prev } = basePlan();
    const cand = buildSnapshot({
      slices: [
        { id: 'A', tasks: ['A1', 'A2'] },
        { id: 'B', tasks: ['B1'] },
      ],
      tasks: [
        { id: 'A1', slice: 'A', goal: 'Goal A1 replanned', dependencies: ['ghost'] },
        { id: 'A2', slice: 'A' },
        { id: 'B1', slice: 'B' },
      ],
    });
    const disp = classifyReplanImpact({ previous: prev, candidate: cand, completed_task_ids: [] });
    expectV2Shape(disp);
    assert.equal(disp.impact_scope, 'unresolved');
    assert.equal(disp.unresolved_reason, 'CLOSURE_UNPROVABLE');
  });
});

// ---------------------------------------------------------------------------
// Task-local completed-predecessor carry-forward (Case 8) and proof-boundary
// → slice-wide escalation (Case 9).
// ---------------------------------------------------------------------------

describe('Task-local predecessor carry-forward and slice-wide escalation', () => {
  test('Case 8: completed predecessor strictly before the changed Task carries forward', () => {
    const prev = buildSnapshot({
      slices: [{ id: 'A', tasks: ['A1', 'A2'] }],
      tasks: [
        { id: 'A1', slice: 'A' },
        { id: 'A2', slice: 'A' },
      ],
    });
    const cand = buildSnapshot({
      slices: [{ id: 'A', tasks: ['A1', 'A2'] }],
      tasks: [
        { id: 'A1', slice: 'A' },
        { id: 'A2', slice: 'A', goal: 'Goal A2 replanned' },
      ],
    });
    const disp = classifyReplanImpact({ previous: prev, candidate: cand, completed_task_ids: ['A1'] });
    expectV2Shape(disp);
    assert.equal(disp.impact_scope, 'task-local');
    assert.deepEqual(disp.changed_task_ids, ['A2']);
    assert.deepEqual(disp.invalidated_task_ids, ['A2']);
    assert.deepEqual(disp.carry_forward_task_ids, ['A1']);
  });

  test('Case 9: proof-boundary change escalates to slice-wide, never silent task-local', () => {
    const prev = buildSnapshot({
      slices: [
        { id: 'A', tasks: ['A1', 'A2'], goalRef: 'goal:A' },
        { id: 'B', tasks: ['B1'] },
      ],
      tasks: [
        { id: 'A1', slice: 'A' },
        { id: 'A2', slice: 'A' },
        { id: 'B1', slice: 'B' },
      ],
    });
    const cand = buildSnapshot({
      slices: [
        { id: 'A', tasks: ['A1', 'A2'], goalRef: 'goal:A2' },
        { id: 'B', tasks: ['B1'] },
      ],
      tasks: [
        { id: 'A1', slice: 'A' },
        { id: 'A2', slice: 'A' },
        { id: 'B1', slice: 'B' },
      ],
    });
    const disp = classifyReplanImpact({ previous: prev, candidate: cand, completed_task_ids: ['A1', 'A2', 'B1'] });
    expectV2Shape(disp);
    assert.equal(disp.impact_scope, 'slice-wide');
    assert.deepEqual(disp.invalidated_task_ids, ['A1', 'A2']);
    assert.deepEqual(disp.carry_forward_task_ids, ['B1']);
  });
});

// ---------------------------------------------------------------------------
// Determinism / order-independence.
// ---------------------------------------------------------------------------

describe('determinism', () => {
  test('shuffling slice and task array order yields the same disposition', () => {
    const buildOrdered = (): { prev: ReplanPlanSnapshotInput; cand: ReplanPlanSnapshotInput } => {
      const prev = buildSnapshot({
        slices: [
          { id: 'A', tasks: ['A1', 'A2'] },
          { id: 'B', tasks: ['B1'] },
          { id: 'C', tasks: ['C1', 'C2'] },
        ],
        tasks: [
          { id: 'A1', slice: 'A' },
          { id: 'A2', slice: 'A' },
          { id: 'B1', slice: 'B' },
          { id: 'C1', slice: 'C' },
          { id: 'C2', slice: 'C' },
        ],
      });
      const cand = buildSnapshot({
        slices: [
          { id: 'A', tasks: ['A1', 'A2'] },
          { id: 'B', tasks: ['B1'] },
          { id: 'C', tasks: ['C1', 'C2'] },
        ],
        tasks: [
          { id: 'A1', slice: 'A' },
          { id: 'A2', slice: 'A' },
          { id: 'B1', slice: 'B' },
          { id: 'C1', slice: 'C', goal: 'Goal C1 replanned' },
          { id: 'C2', slice: 'C' },
        ],
      });
      return { prev, cand };
    };

    const completed = ['A1', 'A2', 'B1'];
    const ordered = buildOrdered();
    const dispOrdered = classifyReplanImpact({
      previous: ordered.prev,
      candidate: ordered.cand,
      completed_task_ids: completed,
    });

    // Rebuild the same logical plan with a different slice/task array order.
    const prevShuffled = buildSnapshot({
      slices: [
        { id: 'C', tasks: ['C1', 'C2'] },
        { id: 'A', tasks: ['A1', 'A2'] },
        { id: 'B', tasks: ['B1'] },
      ],
      tasks: [
        { id: 'B1', slice: 'B' },
        { id: 'C2', slice: 'C' },
        { id: 'A2', slice: 'A' },
        { id: 'A1', slice: 'A' },
        { id: 'C1', slice: 'C' },
      ],
    });
    const candShuffled = buildSnapshot({
      slices: [
        { id: 'B', tasks: ['B1'] },
        { id: 'C', tasks: ['C1', 'C2'] },
        { id: 'A', tasks: ['A1', 'A2'] },
      ],
      tasks: [
        { id: 'C1', slice: 'C', goal: 'Goal C1 replanned' },
        { id: 'A1', slice: 'A' },
        { id: 'B1', slice: 'B' },
        { id: 'C2', slice: 'C' },
        { id: 'A2', slice: 'A' },
      ],
    });
    const dispShuffled = classifyReplanImpact({
      previous: prevShuffled,
      candidate: candShuffled,
      completed_task_ids: [...completed].reverse(),
    });

    assert.deepEqual(dispShuffled, dispOrdered);
  });
});
