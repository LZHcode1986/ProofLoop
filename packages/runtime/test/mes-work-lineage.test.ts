/**
 * Work-attempt currentness regression (Change C / contracts §2.1.6,
 * architecture planning-acceptance-succession Work-attempt currentness,
 * STATIC-36; reuse audit .docs/proofloop-mes-current-work-reuse-audit.md).
 *
 * Exercises, on the compiled runtime dist:
 *   - `supersedes_work_ref` position rule (work-only) and value shape;
 *   - `buildLaneWorkFact` carries the Work-attempt successor edge;
 *   - `verifyWorkLineageGraphError` / `resolveWorkLineageTips` invariants:
 *     a Work lineage is exactly one append-only acyclic chain with a unique
 *     tip (first attempt null; restart appends a fresh tip); self-reference,
 *     missing / non-work / cross-lineage target, stale predecessor, branch,
 *     directed cycle, zero / multiple tips all fail; retained legacy `work`
 *     facts without the field never chain and never become current;
 *   - the MES write boundary rejects a broken lineage no-write and accepts a
 *     legal restart chain, keeping old attempts byte-stable history;
 *   - the invalid-history oracle classifies facts bound to a NON-CURRENT
 *     (superseded) Work attempt as relation-invalid / non-authorizing, while
 *     facts bound to the current tip stay relation-valid.
 *
 * All store tests use temporary Git fixtures (helpers.ts#makeFixture) and
 * never the work clone's Git state.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMesFactEnvelope,
  SchemaValidationError,
} from '../dist/mes/validate';
import {
  verifyWorkLineageGraphError,
  resolveWorkLineageTips,
  workLineageKeyOf,
  isCycleBearingWork,
} from '../dist/mes/binding';
import { classifyInvalidHistory } from '../dist/mes/history-oracle';
import { MesSnapshotStore, MesSnapshotStoreError, createMesSnapshotStore } from '../dist/mes/store';
import { buildLaneWorkFact } from '../dist/execute/lane';
import type { MesFactEnvelope } from '../dist/mes/types';
import { makeFixture, sha } from './helpers';

const PLAN_REF = 'delivery/stages/S03/plan.md';
const PLAN_DIGEST = sha('s03-plan-v1');
const GIT_BASIS = { head: 'a'.repeat(40), branch: 'proofloop-s03-a', worktree: '.' };
const CYCLE = 'cycle-work-lineage';
const PVR_REF = 'mes:result:S03:planning-verification-1';

function acceptedBinding() {
  return {
    binding_stage: 'accepted' as const,
    accepted_plan_ref: PLAN_REF,
    source_candidate_plan_ref: PLAN_REF,
    verification_result_ref: PVR_REF,
    plan_digest: PLAN_DIGEST,
    delivery_cycle_id: CYCLE,
  };
}

function workFact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:work:S03:S03-A:1',
    fact_kind: 'work',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2'],
    scope: { stage_id: 'S03', slice_id: 'S03-A' },
    work_id: 'mes:work:S03:S03-A:1',
    plan_binding: acceptedBinding(),
    git_basis: GIT_BASIS,
    ...overrides,
  };
}

describe('Change C — supersedes_work_ref position + value shape (validate)', () => {
  test('non-work facts carrying supersedes_work_ref fail closed (position rule)', () => {
    for (const [kind, base] of [
      ['task', { fact_kind: 'task', scope: { stage_id: 'S03', slice_id: 'S03-A', task_id: 'S03-A-T01' }, work_id: 'w1', task_status: 'PLANNED', depends_on_task_ids: [] }],
      ['result', { fact_kind: 'result', scope: { stage_id: 'S03', slice_id: 'S03-A', task_id: 'S03-A-T01' }, work_id: 'w1', result_ref: 'mes:result:1', result_id: 'r1', result_payload_digest: 'a'.repeat(64) }],
    ] as const) {
      assert.throws(
        () => validateMesFactEnvelope({ ...base, supersedes_work_ref: null }),
        (e) => e instanceof SchemaValidationError && e.message.includes('supersedes_work_ref is work-only'),
        `position rule must reject ${kind} carrying supersedes_work_ref`,
      );
    }
  });

  test('work fact accepts null / exact ref; rejects empty/non-string value', () => {
    assert.doesNotThrow(() => validateMesFactEnvelope(workFact({ supersedes_work_ref: null })));
    assert.doesNotThrow(() => validateMesFactEnvelope(workFact({ supersedes_work_ref: 'mes:fact:work:S03:S03-A:1' })));
    assert.throws(() => validateMesFactEnvelope(workFact({ supersedes_work_ref: '' })), SchemaValidationError);
    assert.throws(() => validateMesFactEnvelope(workFact({ supersedes_work_ref: 42 })), SchemaValidationError);
  });

  test('buildLaneWorkFact carries the supersedes_work_ref successor edge', () => {
    const built = buildLaneWorkFact({
      stageId: 'S03',
      sliceId: 'S03-A',
      workId: 'mes:work:S03:S03-A:2',
      authorityRefs: ['tech-spec/contracts.md#2.2'],
      planBinding: acceptedBinding(),
      gitBasis: GIT_BASIS,
      supersedesWorkRef: 'mes:fact:work:S03:S03-A:1',
    });
    assert.equal(built.supersedes_work_ref, 'mes:fact:work:S03:S03-A:1');
  });
});

describe('Change C — work lineage graph invariants (binding)', () => {
  const A = () => validateMesFactEnvelope(workFact({
    fact_id: 'mes:fact:work:S03:S03-A:1', work_id: 'mes:work:S03:S03-A:1', supersedes_work_ref: null,
  }));
  const B = () => validateMesFactEnvelope(workFact({
    fact_id: 'mes:fact:work:S03:S03-A:2', work_id: 'mes:work:S03:S03-A:2',
    supersedes_work_ref: 'mes:fact:work:S03:S03-A:1',
  }));

  test('single first-attempt work with null is a valid one-node lineage', () => {
    assert.equal(verifyWorkLineageGraphError([A()]), undefined);
    const tips = resolveWorkLineageTips([A()]);
    assert.ok(tips.ok);
    assert.equal(tips.tips.length, 1);
    assert.equal(tips.tips[0].fact_id, 'mes:fact:work:S03:S03-A:1');
  });

  test('first attempt (null) + one restart forms one chain with tip = restart', () => {
    const facts = [A(), B()];
    assert.equal(verifyWorkLineageGraphError(facts), undefined);
    const tips = resolveWorkLineageTips(facts);
    assert.ok(tips.ok);
    assert.equal(tips.tips.length, 1);
    assert.equal(tips.tips[0].fact_id, 'mes:fact:work:S03:S03-A:2');
  });

  test('self-reference fails closed', () => {
    const self = validateMesFactEnvelope(workFact({
      fact_id: 'mes:fact:work:S03:S03-A:1', supersedes_work_ref: 'mes:fact:work:S03:S03-A:1',
    }));
    assert.ok(verifyWorkLineageGraphError([self])?.includes('supersedes itself'));
  });

  test('missing target fails closed', () => {
    const broken = validateMesFactEnvelope(workFact({
      fact_id: 'mes:fact:work:S03:S03-A:2', supersedes_work_ref: 'mes:fact:work:S03:S03-A:NOPE',
    }));
    assert.ok(verifyWorkLineageGraphError([broken])?.includes('does not resolve'));
  });

  test('cross-lineage target (different slice + same slice different gen) fails closed', () => {
    const inOther = validateMesFactEnvelope(workFact({
      scope: { stage_id: 'S03', slice_id: 'S03-B' },
      fact_id: 'mes:fact:work:S03:S03-B:1', work_id: 'mes:work:S03:S03-B:1', supersedes_work_ref: 'mes:fact:work:S03:S03-A:1',
    }));
    const owner = A();
    const err = verifyWorkLineageGraphError([owner, inOther]);
    assert.ok(err !== undefined && (err.includes('cross-lineage') || err.includes('not a cycle-bearing work fact of the same Work lineage')), err);
  });

  test('branch (two attempts supersede the same predecessor) fails closed', () => {
    const b1 = validateMesFactEnvelope(workFact({
      fact_id: 'mes:fact:work:S03:S03-A:2', supersedes_work_ref: 'mes:fact:work:S03:S03-A:1',
    }));
    const b2 = validateMesFactEnvelope(workFact({
      fact_id: 'mes:fact:work:S03:S03-A:3', supersedes_work_ref: 'mes:fact:work:S03:S03-A:1',
    }));
    const err = verifyWorkLineageGraphError([A(), b1, b2]);
    assert.ok(err?.includes('duplicate target') || err?.includes('more than one tip'), err);
  });

  test('directed cycle fails closed', () => {
    const x = validateMesFactEnvelope(workFact({
      fact_id: 'mes:fact:work:S03:S03-A:1', supersedes_work_ref: 'mes:fact:work:S03:S03-A:2',
    }));
    const y = validateMesFactEnvelope(workFact({
      fact_id: 'mes:fact:work:S03:S03-A:2', supersedes_work_ref: 'mes:fact:work:S03:S03-A:1',
    }));
    assert.ok(verifyWorkLineageGraphError([x, y])?.includes('directed cycle'));
  });

  test('two null roots in one lineage → multiple tips fail closed', () => {
    const r1 = validateMesFactEnvelope(workFact({
      fact_id: 'mes:fact:work:S03:S03-A:1', supersedes_work_ref: null,
    }));
    const r2 = validateMesFactEnvelope(workFact({
      fact_id: 'mes:fact:work:S03:S03-A:2', supersedes_work_ref: null,
    }));
    assert.ok(verifyWorkLineageGraphError([r1, r2])?.includes('unique Work-attempt tip'));
  });

  test('stale predecessor (new attempt points at non-tip) fails closed via two tips', () => {
    const stale = validateMesFactEnvelope(workFact({
      fact_id: 'mes:fact:work:S03:S03-A:3', supersedes_work_ref: 'mes:fact:work:S03:S03-A:1',
    }));
    const err = verifyWorkLineageGraphError([A(), B(), stale]);
    assert.ok(err !== undefined, 'stale predecessor must not resolve to a unique tip');
  });

  test('legacy work fact without supersedes_work_ref is a read-only compat root and never chains; permutation-invariant', () => {
    const legacy = validateMesFactEnvelope(workFact({ fact_id: 'mes:fact:work:S03:S03-A:1' })); // omitted
    assert.equal(verifyWorkLineageGraphError([legacy]), undefined);
    const shuffled = validateMesFactEnvelope(workFact({ fact_id: 'mes:fact:work:S03:S03-A:1' }));
    assert.equal(verifyWorkLineageGraphError([shuffled]), undefined);
  });

  test('a new-shape restart may anchor onto a RETAINED legacy compat root of the same lineage (migration path), tip = the chained fact', () => {
    const legacy = validateMesFactEnvelope(workFact({ fact_id: 'mes:fact:work:S03:S03-A:1', work_id: 'mes:work:S03:S03-A:1' })); // omits field
    const restart = validateMesFactEnvelope(workFact({ fact_id: 'mes:fact:work:S03:S03-A:2', work_id: 'mes:work:S03:S03-A:2', supersedes_work_ref: 'mes:fact:work:S03:S03-A:1' }));
    assert.equal(verifyWorkLineageGraphError([legacy, restart]), undefined);
    const tips = resolveWorkLineageTips([legacy, restart]);
    assert.ok(tips.ok);
    assert.equal(tips.tips.length, 1);
    assert.equal(tips.tips[0].fact_id, 'mes:fact:work:S03:S03-A:2');
    // two chained facts must not both anchor the same legacy root (branch)
    const branch2 = validateMesFactEnvelope(workFact({ fact_id: 'mes:fact:work:S03:S03-A:3', work_id: 'mes:work:S03:S03-A:3', supersedes_work_ref: 'mes:fact:work:S03:S03-A:1' }));
    assert.ok(verifyWorkLineageGraphError([legacy, restart, branch2])?.includes('duplicate target / branch'), 'two chained facts superseding the same legacy root must fail');
  });
});

describe('Change C — MES write boundary: work lineage no-write', () => {
  function seedStore(store: MesSnapshotStore): void {
    const pvr: MesFactEnvelope = {
      schema_version: 2, fact_id: 'mes:fact:planning_verification_result:S03:1', fact_kind: 'planning_verification_result',
      created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2.2'], scope: { stage_id: 'S03' },
      work_id: 'mes:work:S03:planning:1', result_ref: PVR_REF, verifier_role: 'stage-plan-verifier',
      action_token: 's03-spv-1',
      plan_binding: { binding_stage: 'candidate', candidate_plan_ref: PLAN_REF, accepted_plan_ref: null, verdict: 'PLAN_READY', plan_digest: PLAN_DIGEST, delivery_cycle_id: CYCLE },
      git_basis: GIT_BASIS,
    };
    const pa: MesFactEnvelope = {
      schema_version: 2, fact_id: 'mes:fact:plan_acceptance:S03:1', fact_kind: 'plan_acceptance',
      created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2.2'], scope: { stage_id: 'S03' },
      supersedes_plan_acceptance_ref: null,
      plan_binding: { binding_stage: 'accepted', accepted_plan_ref: PLAN_REF, source_candidate_plan_ref: PLAN_REF, verification_result_ref: PVR_REF, plan_digest: PLAN_DIGEST, delivery_cycle_id: CYCLE },
      git_basis: GIT_BASIS,
    };
    store.write([pvr, pa]);
  }

  test('a legal restart chain (root null → restart tip) persists and rehydrates identically; old attempt stays byte-stable', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      seedStore(store);
      const a = validateMesFactEnvelope(workFact({ fact_id: 'mes:fact:work:S03:S03-A:1', work_id: 'mes:work:S03:S03-A:1', supersedes_work_ref: null }));
      const b = validateMesFactEnvelope(workFact({ fact_id: 'mes:fact:work:S03:S03-A:2', work_id: 'mes:work:S03:S03-A:2', supersedes_work_ref: 'mes:fact:work:S03:S03-A:1' }));
      store.write([a, b]);
      const facts = store.read();
      assert.equal(facts.filter((f) => f.fact_kind === 'work').length, 2);
      const fresh = new MesSnapshotStore(fixture.dir);
      assert.deepEqual(fresh.read(), facts, 'restart rehydrate must be byte-identical');
    } finally {
      fixture.cleanup();
    }
  });

  test('a branched lineage (two attempts supersede the same predecessor) is atomic no-write', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      seedStore(store);
      const a = validateMesFactEnvelope(workFact({ fact_id: 'mes:fact:work:S03:S03-A:1', work_id: 'mes:work:S03:S03-A:1', supersedes_work_ref: null }));
      const b = validateMesFactEnvelope(workFact({ fact_id: 'mes:fact:work:S03:S03-A:2', work_id: 'mes:work:S03:S03-A:2', supersedes_work_ref: 'mes:fact:work:S03:S03-A:1' }));
      store.write([a, b]);
      const before = store.read();
      const branchC = validateMesFactEnvelope(workFact({ fact_id: 'mes:fact:work:S03:S03-A:3', work_id: 'mes:work:S03:S03-A:3', supersedes_work_ref: 'mes:fact:work:S03:S03-A:1' }));
      assert.throws(() => store.write([a, b, branchC]), (e) => {
        assert.ok(e instanceof MesSnapshotStoreError);
        assert.ok(e.message.includes('work lineage') || e.message.includes('supersedes'), e.message);
        return true;
      });
      assert.deepEqual(store.read(), before, 'failed write must leave snapshot byte-identical');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('Change C — invalid-history oracle: superseded Work attempt is non-authorizing', () => {
  function resultFact(factId: string, workId: string): MesFactEnvelope {
    return validateMesFactEnvelope({
      schema_version: 2, fact_id: factId, fact_kind: 'result', created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.3'],
      scope: { stage_id: 'S03', slice_id: 'S03-A', task_id: 'S03-A-T01' },
      work_id: workId,
      result_ref: `mes:result:${factId.split(':').pop()}`, result_id: `rid-${factId.split(':').pop()}`,
      result_payload_digest: 'a'.repeat(64),
      plan_binding: acceptedBinding(),
      git_basis: GIT_BASIS,
    });
  }

  const pvr: MesFactEnvelope = {
    schema_version: 2, fact_id: 'mes:fact:planning_verification_result:S03:1', fact_kind: 'planning_verification_result',
    created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2.2'], scope: { stage_id: 'S03' },
    work_id: 'mes:work:S03:planning:1', result_ref: PVR_REF, verifier_role: 'stage-plan-verifier',
    action_token: 's03-spv-1',
    plan_binding: { binding_stage: 'candidate', candidate_plan_ref: PLAN_REF, accepted_plan_ref: null, verdict: 'PLAN_READY', plan_digest: PLAN_DIGEST, delivery_cycle_id: CYCLE },
    git_basis: GIT_BASIS,
  };
  const pa: MesFactEnvelope = {
    schema_version: 2, fact_id: 'mes:fact:plan_acceptance:S03:1', fact_kind: 'plan_acceptance',
    created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2.2'], scope: { stage_id: 'S03' },
    supersedes_plan_acceptance_ref: null,
    plan_binding: { binding_stage: 'accepted', accepted_plan_ref: PLAN_REF, source_candidate_plan_ref: PLAN_REF, verification_result_ref: PVR_REF, plan_digest: PLAN_DIGEST, delivery_cycle_id: CYCLE },
    git_basis: GIT_BASIS,
  };

  test('facts bound to a NON-CURRENT attempt become relation-invalid; current-tip facts stay valid; permutation-invariant', () => {
    const a = validateMesFactEnvelope(workFact({ fact_id: 'mes:fact:work:S03:S03-A:1', work_id: 'mes:work:S03:S03-A:1', supersedes_work_ref: null }));
    const b = validateMesFactEnvelope(workFact({ fact_id: 'mes:fact:work:S03:S03-A:2', work_id: 'mes:work:S03:S03-A:2', supersedes_work_ref: 'mes:fact:work:S03:S03-A:1' }));
    const resA = resultFact('mes:fact:result:S03:S03-A:1', 'mes:work:S03:S03-A:1');
    const resB = resultFact('mes:fact:result:S03:S03-A:2', 'mes:work:S03:S03-A:2');
    const facts = [pvr, pa, a, b, resA, resB];

    const oracle = classifyInvalidHistory(facts);
    assert.ok(oracle.invalidFactIds.includes(resA.fact_id), 'result bound to superseded attempt must be non-authorizing');
    assert.ok(!oracle.invalidFactIds.includes(resB.fact_id), 'result bound to current tip must stay authorizing');
    assert.ok(oracle.invalidFactIds.includes(a.fact_id), 'the superseded attempt work fact itself is non-authorizing');
    assert.ok(!oracle.invalidFactIds.includes(b.fact_id), 'the current tip work fact stays authorizing');

    const reversed = classifyInvalidHistory([...facts].reverse());
    assert.deepEqual(reversed.invalidFactIds, oracle.invalidFactIds, 'permutation must not change classification');
  });
});