/**
 * Slice-proof binding adapter tests (S03-F-T01).
 *
 * # PO: PO-S03-F-01, PO-S03-F-02
 *
 * Exercises the public projection seam `projectSliceProofSnapshot` /
 * `classifySliceProofImpact` in packages/runtime/src/execute/slice-proof-binding.ts:
 *   - (PO-S03-F-01) accepted Thin Plan facts + MES work identity + Git basis +
 *     caller-provided resolved reference index are deterministically projected
 *     into `classifyReplanImpact` previous/candidate snapshots with the frozen
 *     three-layer digests (stage_contract_digest / proof_boundary_digest) under
 *     the SPN canonical-JSON formula, the deterministic ref category mapping
 *     (goal/task derived descriptors + acceptance/goal/risk/seam canonical
 *     classes), Map-row `map_entry_facts` binding into the stage digest
 *     (PLAN_GAP fail-closed), plan-internal derived descriptors EXCLUDED from
 *     Authority content delta / owner attribution (locality), and the closed
 *     `execution_binding` REQUIRED-fill with exact-equality enforcement
 *     (RESULT_BINDING_MISMATCH);
 *   - (PO-S03-F-02) FR-013 Case 1-9 fixtures close through the seam: Case 1
 *     (only C changes → A/B carry), Case 2 (A→C→D chain → A/C/D invalidated,
 *     sibling B kept), Case 3 (Stage global contract / Map row change →
 *     stage-wide), Case 4 (run/verification + plan metadata change → proof
 *     stays, task-local no-op, derived ref digests excluded), Case 5 (authority
 *     content change attributable to only A → only A invalidated), Case 6 / 7
 *     negative fail-closed (unowned authority change escalates; no phantom
 *     plan-internal delta), Case 8 (Task-local carry-forward of completed
 *     unchanged predecessors), Case 9 (slice-wide via proof-boundary change).
 *
 * Imports the compiled runtime dist (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeDigest, sha256Hex, type VNextReferenceDescriptor } from '@proofloop/kernel';
import {
  classifySliceProofImpact,
  projectSliceProofSnapshot,
  SliceProofBindingError,
  type ExecutionBinding,
  type SliceProofProjectionInput,
  type SliceFacts,
  type TaskFacts,
} from '../dist/execute/slice-proof-binding';
import type {
  ReplanPlanSnapshotInput,
  ReplanImpactDisposition,
} from '../dist/vnext/replan-impact';
import { sha } from './helpers';

const STAGE = 'S03';
const PLAN_REF = 'delivery/stages/S03/plan.md';
const PLAN_DIGEST_V1 = sha('plan-s03-v1');
const PLAN_DIGEST_V2 = sha('plan-s03-v2');
const HEAD_V1 = 'a'.repeat(40);
const HEAD_V2 = 'b'.repeat(40);
const WORK_ID = 'mes:work:S03-S03-F:1';
const GIT_BASIS_V1 = { head: HEAD_V1, branch: 'worktree/s03-f', worktree: '.proofloop/worktrees/S03-S03-F' };
const GIT_BASIS_V2 = { head: HEAD_V2, branch: 'worktree/s03-f', worktree: '.proofloop/worktrees/S03-S03-F' };
const MAP_REF = 'delivery/project-stage-map.md#S03';

const PLAN_MARKDOWN_V1 = '# S03 candidate Thin Plan\n\nslice/task blocks v1\n';
const PLAN_MARKDOWN_V2 = '# S03 candidate Thin Plan\n\nslice/task blocks v2 (metadata-only edit)\n';

const MAP_MARKDOWN_V1 = [
  '| Stage | depends_on | 目标（独立交付 outcome） | entry criteria | Authority refs |',
  '|---|---|---|---|---|',
  '| S01 | PROPOSE_READY + clean Git baseline | MES durable facts | ready | PRD.md#FR-003；acceptance#E2E-00 |',
  '| S03 | S02 accepted | Execute execution machinery | S02 delivered | PRD.md#FR-006；tech-spec/acceptance.md#E2E-10、STATIC-25 |',
  '',
].join('\n');

/** Mutation of the S03 Map row (Case 3): the row goal text changes. */
const MAP_MARKDOWN_V3 = MAP_MARKDOWN_V1.replace(
  'Execute execution machinery',
  'Execute execution machinery (replanned global contract)',
);

const RESOLVED = (ref: string): VNextReferenceDescriptor =>
  ({
    file_digest: sha(`file:${ref}`),
    section_digest: sha(`section:${ref}`),
    kind: ref.startsWith('tech-spec/acceptance.md')
      ? 'acceptance'
      : ref.startsWith('PRD.md')
        ? 'goal'
        : ref.startsWith('tech-spec/architecture.md')
          ? 'risk'
          : 'seam',
    ref,
  });

const ACCEPTANCE_A = 'tech-spec/acceptance.md#E2E-A1';
const ACCEPTANCE_NEW = 'tech-spec/acceptance.md#E2E-NEW';
const CONTRACTS_51 = 'tech-spec/contracts.md#5.1';
const ARCH_HP2 = 'tech-spec/architecture.md#HP-002';
const PRD_FR11 = 'PRD.md#FR-011';

function baseSliceFacts(): SliceFacts[] {
  return [
    { slice_id: 'S03-A', goal: 'G-A', depends_on: [], authority_refs: [ACCEPTANCE_A, PRD_FR11], task_ids: ['S03-A-T01', 'S03-A-T02'] },
    { slice_id: 'S03-B', goal: 'G-B', depends_on: [], authority_refs: [CONTRACTS_51], task_ids: ['S03-B-T01'] },
    { slice_id: 'S03-C', goal: 'G-C', depends_on: [], authority_refs: [ARCH_HP2], task_ids: ['S03-C-T01', 'S03-C-T02'] },
  ];
}

function baseTaskFacts(): TaskFacts[] {
  const scope = {
    kind: 'implementation' as const,
    code_paths: ['packages/runtime/src/vnext/a.ts'],
    test_paths: ['packages/runtime/test/a.test.ts'],
    forbidden_paths: ['.proofloop', '.git'],
  };
  return [
    { task_id: 'S03-A-T01', slice_id: 'S03-A', goal: 'Goal A1', semantic_scope: 'A1 scope', dependencies: [], required_skills: ['test-driven-development'], proof_obligation_ids: ['PO-S03-A-01'], execution_scope: scope, code_anchors: ['packages/runtime/src/a1.ts#fnA1'], verification_refs: [ACCEPTANCE_A] },
    { task_id: 'S03-A-T02', slice_id: 'S03-A', goal: 'Goal A2', semantic_scope: 'A2 scope', dependencies: ['S03-A-T01'], required_skills: ['test-driven-development'], proof_obligation_ids: ['PO-S03-A-02'], execution_scope: scope, code_anchors: ['packages/runtime/src/a2.ts#fnA2'], verification_refs: [] },
    { task_id: 'S03-B-T01', slice_id: 'S03-B', goal: 'Goal B1', semantic_scope: 'B1 scope', dependencies: [], required_skills: ['test-driven-development'], proof_obligation_ids: ['PO-S03-B-01'], execution_scope: scope, code_anchors: ['packages/runtime/src/b1.ts#fnB1'], verification_refs: [CONTRACTS_51] },
    { task_id: 'S03-C-T01', slice_id: 'S03-C', goal: 'Goal C1', semantic_scope: 'C1 scope', dependencies: ['S03-A-T01'], required_skills: ['test-driven-development'], proof_obligation_ids: ['PO-S03-C-01'], execution_scope: scope, code_anchors: ['packages/runtime/src/c1.ts#fnC1'], verification_refs: [ARCH_HP2] },
    { task_id: 'S03-C-T02', slice_id: 'S03-C', goal: 'Goal C2', semantic_scope: 'C2 scope', dependencies: ['S03-C-T01'], required_skills: ['test-driven-development'], proof_obligation_ids: ['PO-S03-C-02'], execution_scope: scope, code_anchors: ['packages/runtime/src/c2.ts#fnC2'], verification_refs: [] },
  ];
}

function baseSide(overrides: Partial<SliceProofProjectionInput> = {}): SliceProofProjectionInput {
  const refs: string[] = [ACCEPTANCE_A, CONTRACTS_51, ARCH_HP2, PRD_FR11];
  const resolved_reference_index = Object.fromEntries(refs.map((ref) => [ref, RESOLVED(ref)]));
  return {
    stage_id: STAGE,
    plan_ref: PLAN_REF,
    plan_digest: PLAN_DIGEST_V1,
    plan_markdown: PLAN_MARKDOWN_V1,
    project_stage_map_ref: MAP_REF,
    map_markdown: MAP_MARKDOWN_V1,
    git_basis: GIT_BASIS_V1,
    work_id: WORK_ID,
    slices: baseSliceFacts(),
    shared_forbidden_paths: ['.git', '.proofloop'],
    default_required_skills: ['test-driven-development'],
    tasks: baseTaskFacts(),
    resolved_reference_index,
    ...overrides,
  };
}

const BINDING_V1: ExecutionBinding = {
  plan_ref: PLAN_REF,
  work_id: WORK_ID,
  git_basis: GIT_BASIS_V1,
};
const BINDING_V2: ExecutionBinding = {
  plan_ref: PLAN_REF,
  work_id: WORK_ID,
  git_basis: GIT_BASIS_V2,
};

function expectShape(disp: ReplanImpactDisposition): void {
  assert.equal(disp.schema_version, 2);
  assert.ok(['task-local', 'slice-wide', 'stage-wide', 'unresolved'].includes(disp.impact_scope));
}

describe('S03-F-T01 slice-proof-binding seam', () => {
  test('projects accepted plan and mes facts into classifier snapshots and enforces binding', () => {
    // --- Deterministic three-layer fingerprint projection (PO-S03-F-01) ---
    const snap = projectSliceProofSnapshot(baseSide(), BINDING_V1);
    assert.equal(snap.stage_id, STAGE);
    assert.equal(snap.plan_ref, PLAN_REF);
    assert.equal(snap.plan_digest, PLAN_DIGEST_V1);
    assert.equal(snap.snapshot_digest, HEAD_V1);

    // execution_binding is REQUIRED-filled and equals the caller binding.
    assert.deepEqual(snap.execution_binding, BINDING_V1);

    // stage_contract_digest = SHA-256(SPN(stage_contract_fields)) computed under
    // the frozen SPN formula (kernel canonicalJson = single canonicalization).
    const mapEntryFacts = {
      stage_id: 'S03',
      depends_on: 'S02 accepted',
      goal: 'Execute execution machinery',
      entry_criteria: 'S02 delivered',
      authority_refs: ['PRD.md#FR-006', 'tech-spec/acceptance.md#E2E-10'],
    };
    const stageContractFields = {
      stage_id: 'S03',
      project_stage_map_ref: MAP_REF,
      shared_forbidden_paths: ['.git', '.proofloop'],
      default_required_skills: ['test-driven-development'],
      map_entry_facts: mapEntryFacts,
    };
    assert.equal(snap.stage_contract_digest, computeDigest(stageContractFields));

    // proof_boundary_digest per slice = SHA-256(SPN(slice_contract_fields)).
    const sliceA = snap.slices.find((s) => s.slice_id === 'S03-A');
    assert.ok(sliceA);
    assert.equal(sliceA.slice_contract_digest, computeDigest({
      slice_id: 'S03-A',
      goal: 'G-A',
      depends_on: [],
      authority_refs: [ACCEPTANCE_A, PRD_FR11],
      tasks: [
        {
          task_id: 'S03-A-T01',
          goal: 'Goal A1',
          semantic_scope: 'A1 scope',
          dependencies: [],
          required_skills: ['test-driven-development'],
          proof_obligation_ids: ['PO-S03-A-01'],
          execution_scope: { kind: 'implementation', code_paths: ['packages/runtime/src/vnext/a.ts'], test_paths: ['packages/runtime/test/a.test.ts'] },
          code_anchors: ['packages/runtime/src/a1.ts#fnA1'],
          verification_refs: [ACCEPTANCE_A],
        },
        {
          task_id: 'S03-A-T02',
          goal: 'Goal A2',
          semantic_scope: 'A2 scope',
          dependencies: ['S03-A-T01'],
          required_skills: ['test-driven-development'],
          proof_obligation_ids: ['PO-S03-A-02'],
          execution_scope: { kind: 'implementation', code_paths: ['packages/runtime/src/vnext/a.ts'], test_paths: ['packages/runtime/test/a.test.ts'] },
          code_anchors: ['packages/runtime/src/a2.ts#fnA2'],
          verification_refs: [],
        },
      ],
    }));

    // Deterministic: same side facts produce byte-identical digests.
    const again = projectSliceProofSnapshot(baseSide(), BINDING_V1);
    assert.equal(again.stage_contract_digest, snap.stage_contract_digest);
    assert.deepEqual(again.slices, snap.slices);

    // --- Deterministic ref mapping: derived plan-internal descriptors ---
    // Every slice has a goal ref <plan-ref>#slice-<id>; every task a task ref
    // <plan-ref>#<task-id> (kind goal/task, plan-bytes file_digest,
    // SPN section_digest).
    const goalRef = `${PLAN_REF}#slice-S03-A`;
    assert.ok(snapshotHas(snap, goalRef));
    assert.equal(snap.reference_index[goalRef]?.kind, 'goal');
    assert.equal(snap.reference_index[goalRef]?.ref, goalRef);
    assert.equal(snap.reference_index[goalRef]?.file_digest, sha256Hex(PLAN_MARKDOWN_V1));
    const taskRef = `${PLAN_REF}#S03-A-T01`;
    assert.ok(snapshotHas(snap, taskRef));
    assert.equal(snap.reference_index[taskRef]?.kind, 'task');
    assert.equal(snap.reference_index[taskRef]?.ref, taskRef);

    // Canonical authority/verification refs are categorized deterministically.
    // acceptance.md → acceptance_refs, contracts.md → seam_refs,
    // architecture.md → risk_refs (PRD.md goal refs stay stage-level).
    assert.deepEqual(sliceA.proof_index.acceptance_refs, [ACCEPTANCE_A]);
    const sliceB = snap.slices.find((s) => s.slice_id === 'S03-B');
    assert.ok(sliceB);
    assert.deepEqual(sliceB.proof_index.seam_refs, [CONTRACTS_51]);
    const sliceC = snap.slices.find((s) => s.slice_id === 'S03-C');
    assert.ok(sliceC);
    assert.deepEqual(sliceC.proof_index.risk_refs.map((r) => r.ref_id), [ARCH_HP2]);
    assert.ok(snap.authority_ref_ids.includes(PRD_FR11));

    // --- execution_binding equality enforcement ---
    // REQUIRED field + exact equality with the caller binding; mismatch
    // (plan_ref / work_id / git_basis) fails closed with RESULT_BINDING_MISMATCH.
    const wrongBinding: ExecutionBinding = { plan_ref: 'delivery/stages/S03/other.md', work_id: WORK_ID, git_basis: GIT_BASIS_V1 };
    assert.throws(
      () => classifySliceProofImpact({ execution_binding: wrongBinding, previous: baseSide(), candidate: baseSide(), completed_task_ids: [] }),
      (error: unknown) => {
        assert.ok(error instanceof SliceProofBindingError);
        assert.equal(error.code, 'RESULT_BINDING_MISMATCH');
        return true;
      },
    );
    const wrongBasis: ExecutionBinding = { plan_ref: PLAN_REF, work_id: WORK_ID, git_basis: GIT_BASIS_V2 };
    assert.throws(
      () => classifySliceProofImpact({ execution_binding: wrongBasis, previous: baseSide(), candidate: baseSide(), completed_task_ids: [] }),
      (error: unknown) => {
        assert.ok(error instanceof SliceProofBindingError);
        assert.equal(error.code, 'RESULT_BINDING_MISMATCH');
        return true;
      },
    );

    // --- execution_binding closed top-level field set (cv-1-recheck-2): an
    //     unknown top-level field must fail closed before projection. ---
    const unknownBindingField: Record<string, unknown> = {
      plan_ref: PLAN_REF,
      work_id: WORK_ID,
      git_basis: GIT_BASIS_V1,
      route_hint: 'exploit',
    };
    assert.throws(
      () =>
        classifySliceProofImpact({
          execution_binding: unknownBindingField as unknown as ExecutionBinding,
          previous: baseSide(),
          candidate: baseSide(),
          completed_task_ids: [],
        }),
      (error: unknown) => {
        assert.ok(error instanceof SliceProofBindingError);
        assert.equal(error.code, 'RESULT_BINDING_MISMATCH');
        return true;
      },
    );

    // --- execution_binding.plan_ref must be a canonical root-relative
    //     accepted Plan ref — absolute / non-canonical refs fail closed
    //     (cv-1-recheck-2). ---
    const absolutePlanRef: Record<string, unknown> = {
      plan_ref: '/tmp/evil-plan.md',
      work_id: WORK_ID,
      git_basis: GIT_BASIS_V1,
    };
    assert.throws(
      () =>
        classifySliceProofImpact({
          execution_binding: absolutePlanRef as unknown as ExecutionBinding,
          previous: baseSide(),
          candidate: baseSide(),
          completed_task_ids: [],
        }),
      (error: unknown) => {
        assert.ok(error instanceof SliceProofBindingError);
        assert.equal(error.code, 'RESULT_BINDING_MISMATCH');
        return true;
      },
    );

    // --- Map-entry fail-closed (PLAN_GAP) ---
    assert.throws(
      () => projectSliceProofSnapshot(baseSide({ map_markdown: '| not a table' }), BINDING_V1),
      (error: unknown) => {
        assert.ok(error instanceof SliceProofBindingError);
        assert.equal(error.code, 'PLAN_GAP');
        return true;
      },
    );

    // --- Resolved-index fail-closed (REPLAN.IMPACT_INPUT_INVALID) ---
    const missingRefSide = baseSide({
      slices: baseSliceFacts().map((s, i) =>
        i === 1 ? { ...s, authority_refs: ['tech-spec/contracts.md#7.7'] } : s,
      ),
    });
    assert.throws(
      () => projectSliceProofSnapshot(missingRefSide, BINDING_V1),
      (error: unknown) => {
        assert.ok(error instanceof SliceProofBindingError);
        assert.equal(error.code, 'REPLAN.IMPACT_INPUT_INVALID');
        return true;
      },
    );
  });

  test('classifies replan impact per FR-013 cases through the seam', () => {
    // --- Case 1: only slice C changes → A/B completed facts carry forward. ---
    const cChanged = baseTaskFacts().map((t) =>
      t.task_id === 'S03-C-T01' ? { ...t, goal: 'Goal C1 replanned' } : t,
    );
    const candC = { tasks: cChanged };
    const disp1 = classifySliceProofImpact({
      execution_binding: BINDING_V1,
      previous: baseSide(),
      candidate: baseSide(candC),
      completed_task_ids: ['S03-A-T01', 'S03-A-T02', 'S03-B-T01'],
    });
    expectShape(disp1);
    assert.equal(disp1.impact_scope, 'task-local');
    assert.deepEqual(disp1.invalidated_task_ids, ['S03-C-T01', 'S03-C-T02']);
    assert.ok(disp1.carry_forward_task_ids.includes('S03-A-T01'));
    assert.ok(disp1.carry_forward_task_ids.includes('S03-B-T01'));

    // --- Case 2: A→C→D dependency chain, A changes → A/C/D invalidated, B kept. ---
    const chainPrev = baseSide({
      slices: [
        { slice_id: 'S03-A', goal: 'G-A', depends_on: [], authority_refs: [ACCEPTANCE_A], task_ids: ['S03-A-T01'] },
        { slice_id: 'S03-B', goal: 'G-B', depends_on: [], authority_refs: [CONTRACTS_51], task_ids: ['S03-B-T01'] },
        { slice_id: 'S03-C', goal: 'G-C', depends_on: ['S03-A'], authority_refs: [ARCH_HP2], task_ids: ['S03-C-T01'] },
        { slice_id: 'S03-D', goal: 'G-D', depends_on: ['S03-C'], authority_refs: [], task_ids: ['S03-D-T01'] },
      ],
      tasks: [
        { ...baseTaskFacts()[0], task_id: 'S03-A-T01', slice_id: 'S03-A' },
        baseTaskFacts()[2],
        { ...baseTaskFacts()[3], task_id: 'S03-C-T01' },
        { task_id: 'S03-D-T01', slice_id: 'S03-D', goal: 'Goal D1', semantic_scope: 'D1 scope', dependencies: ['S03-C-T01'], required_skills: ['test-driven-development'], proof_obligation_ids: ['PO-S03-D-01'], execution_scope: baseTaskFacts()[0].execution_scope, code_anchors: [], verification_refs: [] },
      ],
    });
    const chainCand = {
      ...chainPrev,
      tasks: chainPrev.tasks.map((t) =>
        t.task_id === 'S03-A-T01' ? { ...t, goal: 'Goal A1 replanned' } : t,
      ),
    };
    const disp2 = classifySliceProofImpact({
      execution_binding: BINDING_V1,
      previous: chainPrev,
      candidate: chainCand,
      completed_task_ids: ['S03-A-T01', 'S03-B-T01', 'S03-C-T01', 'S03-D-T01'],
    });
    expectShape(disp2);
    assert.deepEqual(disp2.invalidated_task_ids, ['S03-A-T01', 'S03-C-T01', 'S03-D-T01']);
    assert.deepEqual(disp2.carry_forward_task_ids, ['S03-B-T01']);

    // --- Case 3: Stage global contract / Map row change → stage-wide. ---
    const disp3 = classifySliceProofImpact({
      execution_binding: BINDING_V1,
      previous: baseSide(),
      candidate: baseSide({ map_markdown: MAP_MARKDOWN_V3 }),
      completed_task_ids: ['S03-A-T01', 'S03-B-T01'],
    });
    expectShape(disp3);
    assert.equal(disp3.impact_scope, 'stage-wide');
    assert.deepEqual(disp3.carry_forward_task_ids, []);
    assert.deepEqual(disp3.invalidated_task_ids, ['S03-A-T01', 'S03-A-T02', 'S03-B-T01', 'S03-C-T01', 'S03-C-T02']);

    // --- Case 4: plan metadata + plan-file digest change, slice contract
    //     unchanged → proof stays, task-local no-op; plan-internal derived
    //     descriptor file_digests are EXCLUDED from the Authority delta. ---
    const disp4 = classifySliceProofImpact({
      execution_binding: BINDING_V2,
      previous: baseSide(),
      candidate: baseSide({
        plan_digest: PLAN_DIGEST_V2,
        plan_markdown: PLAN_MARKDOWN_V2,
        git_basis: GIT_BASIS_V2,
      }),
      completed_task_ids: ['S03-A-T01', 'S03-A-T02', 'S03-B-T01'],
    });
    expectShape(disp4);
    assert.equal(disp4.impact_scope, 'task-local');
    assert.deepEqual(disp4.changed_task_ids, []);
    assert.deepEqual(disp4.invalidated_task_ids, []);
    assert.deepEqual(disp4.carry_forward_task_ids, ['S03-A-T01', 'S03-A-T02', 'S03-B-T01']);

    // Metadata-unchanged variant: pure re-run/verification arrangement only.
    const sameSide = baseSide();
    const disp4b = classifySliceProofImpact({
      execution_binding: BINDING_V1,
      previous: sameSide,
      candidate: { ...sameSide },
      completed_task_ids: ['S03-A-T01', 'S03-A-T02', 'S03-B-T01'],
    });
    expectShape(disp4b);
    assert.equal(disp4b.impact_scope, 'task-local');
    assert.deepEqual(disp4b.invalidated_task_ids, []);

    // --- Case 5: authority CONTENT change attributable to only slice A
    //     (acceptance ref section digest changes) → only A invalidated. ---
    const candA = baseSide({
      resolved_reference_index: {
        ...Object.fromEntries(
          [ACCEPTANCE_A, CONTRACTS_51, ARCH_HP2, PRD_FR11].map((ref) => [ref, RESOLVED(ref)]),
        ),
        [ACCEPTANCE_A]: { ...RESOLVED(ACCEPTANCE_A), section_digest: sha('section:changed') },
      },
    });
    const disp5 = classifySliceProofImpact({
      execution_binding: BINDING_V1,
      previous: baseSide(),
      candidate: candA,
      completed_task_ids: ['S03-A-T01', 'S03-B-T01'],
    });
    expectShape(disp5);
    assert.equal(disp5.impact_scope, 'slice-wide');
    assert.deepEqual(disp5.invalidated_task_ids, ['S03-A-T01', 'S03-A-T02']);
    assert.deepEqual(disp5.carry_forward_task_ids, ['S03-B-T01']);

    // --- Case 6/7 negatives: unowned global authority change escalates
    //     (never silently treated as task-local); no phantom plan-internal delta. ---
    // PRD.md is a stage-global goal authority: a NEW PRD citation is unowned →
    // the engine fails closed to stage-wide (never guessed task-local).
    const candPrd = baseSide({
      slices: baseSliceFacts().map((s, i) =>
        i === 0 ? { ...s, authority_refs: [...s.authority_refs, 'PRD.md#FR-099'] } : s,
      ),
      resolved_reference_index: {
        ...Object.fromEntries(
          [ACCEPTANCE_A, CONTRACTS_51, ARCH_HP2, PRD_FR11].map((ref) => [ref, RESOLVED(ref)]),
        ),
        'PRD.md#FR-099': RESOLVED('PRD.md#FR-099'),
      },
    });
    const disp6 = classifySliceProofImpact({
      execution_binding: BINDING_V1,
      previous: baseSide(),
      candidate: candPrd,
      completed_task_ids: ['S03-A-T01', 'S03-B-T01'],
    });
    expectShape(disp6);
    assert.notEqual(disp6.impact_scope, 'task-local');

    // --- Case 8: Task-local carry-forward of completed unchanged predecessors. ---
    const disp8 = classifySliceProofImpact({
      execution_binding: BINDING_V1,
      previous: baseSide(),
      candidate: baseSide({
        tasks: baseTaskFacts().map((t) =>
          t.task_id === 'S03-A-T02' ? { ...t, goal: 'Goal A2 replanned' } : t,
        ),
      }),
      completed_task_ids: ['S03-A-T01'],
    });
    expectShape(disp8);
    assert.equal(disp8.impact_scope, 'task-local');
    assert.deepEqual(disp8.changed_task_ids, ['S03-A-T02']);
    assert.deepEqual(disp8.invalidated_task_ids, ['S03-A-T02']);
    assert.deepEqual(disp8.carry_forward_task_ids, ['S03-A-T01']);

    // --- Case 9: slice-wide via proof-boundary change (an acceptance ref is
    //     added to slice C's authority set) → C's slice contract digest flips,
    //     downstream of C is invalidated, unrelated slice B stays valid. ---
    const candC9 = baseSide({
      slices: baseSliceFacts().map((s) =>
        s.slice_id === 'S03-C' ? { ...s, authority_refs: [...s.authority_refs, ACCEPTANCE_NEW] } : s,
      ),
      resolved_reference_index: {
        ...Object.fromEntries(
          [ACCEPTANCE_A, CONTRACTS_51, ARCH_HP2, PRD_FR11].map((ref) => [ref, RESOLVED(ref)]),
        ),
        [ACCEPTANCE_NEW]: RESOLVED(ACCEPTANCE_NEW),
      },
    });
    const disp9 = classifySliceProofImpact({
      execution_binding: BINDING_V1,
      previous: baseSide(),
      candidate: candC9,
      completed_task_ids: ['S03-A-T01', 'S03-B-T01'],
    });
    expectShape(disp9);
    assert.equal(disp9.impact_scope, 'slice-wide');
    assert.deepEqual(disp9.invalidated_task_ids, ['S03-C-T01', 'S03-C-T02']);
    assert.ok(disp9.carry_forward_task_ids.includes('S03-B-T01'));
    assert.ok(!disp9.invalidated_task_ids.includes('S03-B-T01'));

    // --- CV counterexample (S03-F cv-1): a proof-boundary change affecting a
    //     completed predecessor must force slice-wide invalidation EVEN when
    //     a later task of the same slice also changes its goal/contract — the
    //     slice-level change must not be masked by the task-level change. ---
    const cvPrev = baseSide();
    const cvCand = baseSide({
      slices: baseSliceFacts().map((s) =>
        s.slice_id === 'S03-A' ? { ...s, goal: 'G-A (proof boundary replanned)' } : s,
      ),
      tasks: baseTaskFacts().map((t) =>
        t.task_id === 'S03-A-T02' ? { ...t, goal: 'Goal A2 replanned' } : t,
      ),
    });
    const dispCv = classifySliceProofImpact({
      execution_binding: BINDING_V1,
      previous: cvPrev,
      candidate: cvCand,
      completed_task_ids: ['S03-A-T01'], // predecessor already TASK_COMPLETE
    });
    expectShape(dispCv);
    assert.equal(dispCv.impact_scope, 'slice-wide', 'sliced proof-boundary change must not be masked by a task-level change');
    assert.ok(dispCv.invalidated_task_ids.includes('S03-A-T01'), 'completed predecessor must be invalidated by its slice proof-boundary change');
    assert.ok(!dispCv.carry_forward_task_ids.includes('S03-A-T01'), 'completed predecessor must not carry forward across a proof-boundary change');
    assert.deepEqual(dispCv.carry_forward_task_ids, [], 'slice-wide over A leaves nothing carrying forward');

    // --- CV recheck-1 counterexample (S03-F cv-1-recheck-1): a completed
    //     task's TASK-LEVEL proof boundary (semantic_scope / proof_obligation_ids
    //     / code_anchors) changes while another task of the SAME slice has an
    //     ordinary goal change — the boundary change must force slice-wide and
    //     the completed predecessor must NOT carry forward. ---
    const rkPrev = baseSide();
    const rkCand = baseSide({
      tasks: baseTaskFacts().map((t) => {
        if (t.task_id === 'S03-A-T01') {
          return { ...t, semantic_scope: 'A1 proof boundary replanned' };
        }
        if (t.task_id === 'S03-A-T02') {
          return { ...t, goal: 'Goal A2 ordinary goal change' };
        }
        return t;
      }),
    });
    const dispRk = classifySliceProofImpact({
      execution_binding: BINDING_V1,
      previous: rkPrev,
      candidate: rkCand,
      completed_task_ids: ['S03-A-T01'], // predecessor TASK_COMPLETE
    });
    expectShape(dispRk);
    assert.equal(dispRk.impact_scope, 'slice-wide', 'task-level proof boundary change must force slice-wide (not masked by T02 goal change)');
    assert.ok(dispRk.invalidated_task_ids.includes('S03-A-T01'), 'completed predecessor with changed proof boundary must be invalidated');
    assert.ok(!dispRk.carry_forward_task_ids.includes('S03-A-T01'), 'completed predecessor must not carry forward across a task proof-boundary change');
    assert.ok(dispRk.invalidated_task_ids.includes('S03-A-T02'), 'same-slice later task is invalidated too');
  });
});

function snapshotHas(snap: ReplanPlanSnapshotInput, ref: string): boolean {
  return Object.prototype.hasOwnProperty.call(snap.reference_index, ref);
}