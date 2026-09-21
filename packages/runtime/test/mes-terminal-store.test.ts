/**
 * MES terminal store write-through tests (S04-B-T01).
 *
 * # PO: PO-S04-B-01, PO-S04-B-02, PO-S04-B-03
 *
 * Exercises the S04-B-T01 durable store write-through closures over the
 * S04-A terminal fact kinds (packages/runtime/src/mes/terminal.ts +
 * packages/runtime/src/mes/store.ts):
 *   - `project_ready` durable write-through relational closure
 *     (PO-S04-B-01 / contracts.md §5.1 / acceptance E2E-06): the closed
 *     `planned_stage_ids` set must EXACTLY equal the set of durable
 *     accepted-stage supports (kind=="stage" + canonical scope + accepted
 *     plan_binding + closed per-fact git_basis + result_ref + created_by:
 *     brain; machine-closed predicate `isDurableAcceptedStageSupport`) in
 *     the SAME persisted result set (submitted ∪ retained facts) — missing
 *     / duplicate / unsorted / extra / mismatch fail closed no-write
 *     (RESULT_INVALID / RESULT_BINDING_MISMATCH, contracts §7; MES never
 *     reads the Map). A persisted `project_ready` is immutable: identical
 *     replay collapses byte-stable, a conflicting payload across
 *     submissions is no-write (mirrors the planning-fact retention rule);
 *   - terminal / accepted-stage support / review→finding relation fact
 *     retention and restart rebuild (PO-S04-B-02, E2E-06 / STATIC-29 /
 *     contracts §2.1.1): unresubmitted `project_ready` facts, accepted-stage
 *     support facts and durable `finding` / `finding_disposition` relation
 *     facts survive snapshot replacement — each fact keeps its OWN git_basis
 *     (different heads allowed; cross-fact basis equality is NOT required),
 *     and re-reading the same durable facts rebuilds the same closure
 *     conclusions after restart; non-support facts keep replace-all
 *     semantics;
 *   - `finding_disposition.finding_ref` durable unique resolution
 *     (PO-S04-B-03 / STATIC-29): the ref resolves by EXACT fact_id to a
 *     durable `finding` fact in the same persisted result set; missing /
 *     ambiguous / non-finding resolution fail closed no-write; partial
 *     terminal/support writes never drop the relation supports and restart
 *     rebuilds the same unique mapping (existing-snapshot dispositions all
 *     resolve — regression).
 *
 * All store tests use only temporary Git fixtures (helpers.ts#makeFixture)
 * and never the work clone's Git state. Imports the compiled runtime dist
 * (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MesSnapshotStore, createMesSnapshotStore, MesSnapshotStoreError, MES_SNAPSHOT_REL } from '../dist/mes/store';
import {
  isDurableAcceptedStageSupport,
  verifyProjectReadySupportError,
  resolveFindingDispositionRefError,
} from '../dist/mes/terminal';
import { verifyAcceptedStageReviewResultSupport, verifyPlanAcceptanceSupport } from '../dist/mes/binding';
import type { MesFactEnvelope } from '../dist/mes/store';
import { makeFixture, type Fixture } from './helpers';
import { canonicalStringify } from '../dist/cli/proofloop-common';

const DIGEST = 'c'.repeat(64);
const HEAD_A = '1'.repeat(40);
const HEAD_B = '2'.repeat(40);
const HEAD_C = '3'.repeat(40);
const HEAD_D = '4'.repeat(40);

function snapshotBytes(fixture: Fixture): Buffer {
  return fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL));
}

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
    git_basis: { head, branch: 'v2-herdr', worktree: '.' },
    result_ref: `mes:result:${stage}:stage-review-${head.slice(0, 10)}`,
  };
}

/** A pure scope-only stage fact — NOT an accepted-stage support (existing fixture shape). */
function scopeOnlyStageSupport(stage: string): MesFactEnvelope {
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
    git_basis: { head: HEAD_D, branch: 'v2-herdr', worktree: '.' },
    ...extra,
    ...(typeof extra.delivery_cycle_id === 'string' &&
      extra.delivery_cycle_id.length > 0 &&
      !('supersedes_project_ready_ref' in extra)
      ? { supersedes_project_ready_ref: null }
      : {}),
  };
}

/** A durable `finding` fact (contracts.md §2.2.3 verifier closed verdict). */
function findingFact(id: string, overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:finding:${id}`,
    fact_kind: 'finding',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.3'],
    scope: { stage_id: 'S03', slice_id: 'S03-A' },
    work_id: 'mes:work:S03:S03-A:1',
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: 'delivery/stages/S03/plan.md',
      source_candidate_plan_ref: 'delivery/stages/S03/plan.md',
      verification_result_ref: 'mes:result:S03:planning-verification-1',
      plan_digest: DIGEST,
    },
    git_basis: { head: HEAD_A, branch: 'v2-herdr', worktree: '.' },
    verifier_verdict: 'FINDINGS',
    claimed_route_code: 'IMPLEMENTATION_DEFECT',
    finding_evidence_refs: [`mes:result:S03:${id}`],
    ...overrides,
  };
}

/** A Brain-owned `finding_disposition` fact referencing a durable finding by exact fact_id. */
function dispositionFact(id: string, overrides: Record<string, unknown> = {}): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:finding_disposition:${id}`,
    fact_kind: 'finding_disposition',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.3'],
    scope: { stage_id: 'S03', slice_id: 'S03-A' },
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: 'delivery/stages/S03/plan.md',
      source_candidate_plan_ref: 'delivery/stages/S03/plan.md',
      verification_result_ref: 'mes:result:S03:planning-verification-1',
      plan_digest: DIGEST,
    },
    git_basis: { head: HEAD_A, branch: 'v2-herdr', worktree: '.' },
    disposition_ref: `mes:disposition:S03:${id}`,
    finding_ref: `mes:fact:finding:${id}`,
    finding_disposition: 'ACCEPTED',
    claimed_route_code: 'IMPLEMENTATION_DEFECT',
    accepted_route_code: 'IMPLEMENTATION_DEFECT',
    basis_refs: ['tech-spec/contracts.md#2.2.3'],
    reason: 'finding supported by plan and scope',
    resume_target: 'producer',
    ...overrides,
  };
}

/** A closed non-legacy `result` fact (partial-write payload, no graph needed). */
function resultFact(id: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:result:${id}`,
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#4.3'],
    scope: { stage_id: 'S03', slice_id: 'S03-A', task_id: 'S03-A-T01' },
    work_id: 'mes:work:S03:S03-A:1',
    result_ref: `mes:result:S03:${id}`,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: 'delivery/stages/S03/plan.md',
      source_candidate_plan_ref: 'delivery/stages/S03/plan.md',
      verification_result_ref: 'mes:result:S03:planning-verification-1',
      plan_digest: DIGEST,
    },
    git_basis: { head: HEAD_A, branch: 'v2-herdr', worktree: '.' },
    result_id: `attempt-${id}`,
    result_payload_digest: DIGEST,
  };
}

describe('MES terminal store write-through (S04-B-T01)', () => {
  test('closes project_ready against exact accepted-stage support or fails closed no-write', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const s1 = acceptedStageSupport('S01', HEAD_A);
      const s2 = acceptedStageSupport('S02', HEAD_B);
      const s3 = acceptedStageSupport('S03', HEAD_C);
      const pr = projectReady(['S01', 'S02', 'S03']);

      // The terminal fact persists ONLY when the submitted ∪ retained result
      // set contains exact accepted-stage support for EVERY planned Stage ID
      // and nothing else (machine-closed predicate, no Map read).
      store.write([s1, s2, s3, pr]);
      const persisted = store.read();
      assert.equal(persisted.length, 4);
      assert.equal(verifyProjectReadySupportError(pr, persisted), undefined);

      // Planned set == support set exactly; per-fact git_basis values (all
      // different heads) are irrelevant to the closure.
      assert.equal(verifyProjectReadySupportError(pr, [s1, s2, s3, pr]), undefined);
      assert.equal(verifyProjectReadySupportError(projectReady(['S01']), [s1, pr]), undefined);

      // Missing / extra / mismatch / duplicate support → fail closed no-write:
      // a broken closure never replaces the last valid snapshot (RESULT_INVALID
      // / RESULT_BINDING_MISMATCH, contracts §7).
      const goodBytes = snapshotBytes(fixture);
      const closureFailures: Array<{ label: string; facts: MesFactEnvelope[] }> = [
        { label: 'missing S04 support', facts: [s1, s2, s3, projectReady(['S01', 'S02', 'S03', 'S04'])] },
        { label: 'extra S03 support', facts: [s1, s2, s3, projectReady(['S01', 'S02'])] },
        { label: 'mismatch (planned S02, support S03)', facts: [s1, s3, projectReady(['S01', 'S02'])] },
        {
          label: 'duplicate S01 support',
          facts: [
            acceptedStageSupport('S01', HEAD_A),
            acceptedStageSupport('S01', HEAD_B),
            projectReady(['S01']),
          ],
        },
        {
          label: 'scope-only stage is not a support',
          facts: [scopeOnlyStageSupport('S01'), projectReady(['S01'])],
        },
      ];
      for (const { label, facts } of closureFailures) {
        assert.throws(
          () => store.write(facts),
          (err: unknown) =>
            err instanceof MesSnapshotStoreError &&
            err.code === 'invalid-fact' &&
            err.message.includes('RESULT_INVALID'),
          `${label} must fail closed no-write`,
        );
        assert.deepEqual(snapshotBytes(fixture), goodBytes, `${label} must leave the snapshot byte-for-byte unchanged`);
      }
      assert.deepEqual(store.read(), persisted, 'failed closures must not touch the last valid snapshot');

      // A persisted project_ready is immutable (mirrors the planning-fact
      // retention rule): identical replay collapses byte-stable; a DIFFERENT
      // payload under the same fact_id across submissions fails closed
      // no-write and the previous snapshot stays byte-for-byte unchanged.
      store.write([s1, s2, s3, pr]);
      assert.deepEqual(snapshotBytes(fixture), goodBytes, 'identical project_ready replay must be byte-stable');
      const conflicting = projectReady(['S01', 'S02'], { planned_stage_ids: ['S01'] });
      assert.throws(
        () => store.write([s1, s2, s3, conflicting]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a conflicting project_ready payload across submissions must be rejected no-write',
      );
      assert.deepEqual(snapshotBytes(fixture), goodBytes, 'conflict must leave the snapshot byte-for-byte unchanged');

      // A partial write carrying ONLY the terminal fact keeps its durable
      // accepted-stage supports in the SAME snapshot (retention) and the
      // closure still holds after restart.
      store.write([pr]);
      const partialBytes = snapshotBytes(fixture);
      store.write([pr]);
      assert.deepEqual(snapshotBytes(fixture), partialBytes, 'partial-write replay must be byte-stable');
      const restarted = new MesSnapshotStore(fixture.dir).read();
      assert.equal(restarted.length, 4, 'retained accepted-stage supports must survive a partial terminal write');
      assert.equal(verifyProjectReadySupportError(restarted.find((f) => f.fact_kind === 'project_ready')!, restarted), undefined);
    } finally {
      fixture.cleanup();
    }
  });

  test('retains terminal, accepted-stage support and review-finding relation facts across replacement and rebuilds the relations after restart', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const s1 = acceptedStageSupport('S01', HEAD_A);
      const s2 = acceptedStageSupport('S02', HEAD_B);
      const s3 = acceptedStageSupport('S03', HEAD_C);
      const scopeOnly = scopeOnlyStageSupport('S99');
      const f1 = findingFact('S03:S03-A:cv-1');
      const d1 = dispositionFact('S03:S03-A:cv-1');
      const pr = projectReady(['S01', 'S02', 'S03']);

      // Generation 1: terminal + accepted-stage supports + review→finding
      // relation facts + one non-support stage fact, all durable.
      store.write([s1, s2, s3, scopeOnly, f1, d1, pr]);
      const gen1 = store.read();
      assert.equal(gen1.length, 7);

      // Generation 2: a PARTIAL replace-all submission (unrelated result
      // fact only). The unresubmitted terminal / accepted-stage support /
      // review→finding relation facts must be merged into the new snapshot
      // (E2E-06 / STATIC-29 / contracts §2.1.1), each with its OWN git_basis
      // (different heads) — while the scope-only stage fact keeps the S01
      // replace-all semantics and is dropped.
      const newResult = resultFact('s04-partial-1');
      store.write([newResult]);
      const gen2 = store.read();
      const kinds = gen2.map((f) => f.fact_kind);
      assert.ok(kinds.includes('project_ready'), 'terminal fact must be retained');
      assert.ok(kinds.includes('finding'), 'durable finding must be retained');
      assert.ok(kinds.includes('finding_disposition'), 'durable disposition must be retained');
      assert.ok(kinds.includes('result'), 'the newly submitted fact must be present');
      assert.equal(gen2.filter((f) => f.fact_kind === 'stage').length, 3, 'only the accepted-stage supports are retained');
      assert.equal(gen2.filter((f) => f.scope?.stage_id === 'S99').length, 0, 'scope-only stage fact must keep replace-all semantics');
      assert.equal(gen2.length, 7, '6 retained terminal/support/relation facts + the newly submitted result fact');
      for (const f of gen2) {
        const basis = f.git_basis;
        assert.ok(basis && /^[0-9a-f]{40}$/.test(basis.head), `retained fact ${f.fact_id} keeps its own closed git_basis`);
      }
      assert.equal(gen2.find((f) => f.fact_id === s1.fact_id)!.git_basis!.head, HEAD_A);
      assert.equal(gen2.find((f) => f.fact_id === s3.fact_id)!.git_basis!.head, HEAD_C);
      assert.equal(gen2.find((f) => f.fact_id === pr.fact_id)!.git_basis!.head, HEAD_D);

      // Restart rebuilds the relations from the SAME durable facts: planned
      // set == accepted-stage support set exactly (independent of per-fact
      // basis values), and the disposition still resolves uniquely.
      const restarted = new MesSnapshotStore(fixture.dir).read();
      assert.deepEqual(restarted, gen2);
      const prAgain = restarted.find((f) => f.fact_kind === 'project_ready')!;
      assert.equal(verifyProjectReadySupportError(prAgain, restarted), undefined);
      const dAgain = restarted.find((f) => f.fact_kind === 'finding_disposition')!;
      assert.equal(resolveFindingDispositionRefError(dAgain, restarted), undefined);

      // Fail-closed after retention: a NEW project_ready fact_id claiming a
      // planned Stage without durable accepted-stage support is no-write and
      // the previous snapshot stays byte-for-byte unchanged.
      const gen2Bytes = snapshotBytes(fixture);
      const prWithS04 = projectReady(['S01', 'S02', 'S03', 'S04'], { fact_id: 'mes:fact:project_ready:2' });
      assert.throws(
        () => store.write([prWithS04]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'project_ready without S04 accepted-stage support must fail closed no-write',
      );
      assert.deepEqual(snapshotBytes(fixture), gen2Bytes, 'failed terminal write must not touch the previous snapshot');
    } finally {
      fixture.cleanup();
    }
  });

  test('resolves finding_disposition finding_ref to a unique durable finding that survives partial replacement and restart', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const f1 = findingFact('S03:S03-A:cv-1');
      const d1 = dispositionFact('S03:S03-A:cv-1');
      const f2 = findingFact('S03:S03-D:cv-1');
      const d2 = dispositionFact('S03:S03-D:cv-1');

      // Generation 1: findings + dispositions durably coexist.
      store.write([f1, d1, f2, d2]);
      const gen1 = store.read();
      assert.equal(gen1.length, 4);
      assert.equal(resolveFindingDispositionRefError(d1, gen1), undefined);
      assert.equal(resolveFindingDispositionRefError(d2, gen1), undefined);

      // A partial replacement carrying only an unrelated fact must never drop
      // the review→finding relation supports: dispositions still resolve
      // through the retained durable findings in the SAME snapshot.
      store.write([resultFact('s04-partial-2')]);
      const gen2 = store.read();
      assert.equal(gen2.length, 5);
      const d1Retained = gen2.find((f) => f.fact_id === d1.fact_id)!;
      const d2Retained = gen2.find((f) => f.fact_id === d2.fact_id)!;
      assert.equal(resolveFindingDispositionRefError(d1Retained, gen2), undefined);
      assert.equal(resolveFindingDispositionRefError(d2Retained, gen2), undefined);

      // Restart re-reads the same durable facts and rebuilds the same unique
      // mapping (STATIC-29 Review→Finding unique and restartable).
      const restarted = new MesSnapshotStore(fixture.dir).read();
      assert.equal(restarted.length, 5);
      for (const d of restarted.filter((f) => f.fact_kind === 'finding_disposition')) {
        assert.equal(resolveFindingDispositionRefError(d, restarted), undefined);
      }

      // Fail-closed no-write: a disposition whose finding_ref resolves to
      // nothing, or to a non-finding fact, is rejected before any file op.
      const bytes2 = snapshotBytes(fixture);
      const missing = dispositionFact('S03:missing', { finding_ref: 'mes:fact:finding:S03:does-not-exist' });
      assert.throws(
        () => store.write([missing]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a disposition with an unresolvable finding_ref must fail closed no-write',
      );
      const resultTarget = resultFact('s04-target');
      const nonFinding = dispositionFact('S03:non-finding', { finding_ref: resultTarget.fact_id });
      assert.throws(
        () => store.write([resultTarget, nonFinding]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a disposition whose finding_ref resolves to a non-finding fact must fail closed no-write',
      );
      assert.deepEqual(snapshotBytes(fixture), bytes2, 'failed disposition writes must not touch the previous snapshot');

      // Ambiguity fails closed at the helper level: the ref must resolve to
      // exactly ONE durable finding (same fact_id twice in the result set is
      // ambiguous, never picked silently).
      const ambiguous = [f1, { ...f1 } as MesFactEnvelope];
      assert.ok(
        typeof resolveFindingDispositionRefError(d1, ambiguous) === 'string',
        'an ambiguous finding_ref resolution must fail closed',
      );
      assert.ok(
        typeof resolveFindingDispositionRefError(d1, []) === 'string',
        'a missing finding_ref resolution must fail closed',
      );

      // Regression mirror of the existing durable snapshot: every disposition
      // in a 13-finding/13-disposition set still resolves after replacement
      // and restart (re-read of the same durable facts → same mapping).
      const regression = makeFixture();
      try {
        const regStore = createMesSnapshotStore(regression.dir);
        const findings = Array.from({ length: 13 }, (_, i) => findingFact(`S03:cv-${i + 1}`));
        const dispositions = Array.from({ length: 13 }, (_, i) => dispositionFact(`S03:cv-${i + 1}`));
        regStore.write([...findings, ...dispositions]);
        regStore.write([resultFact('s04-regression-1')]);
        const regRestarted = new MesSnapshotStore(regression.dir).read();
        const regDispositions = regRestarted.filter((f) => f.fact_kind === 'finding_disposition');
        assert.equal(regDispositions.length, 13, 'all 13 dispositions must be retained');
        for (const d of regDispositions) {
          assert.equal(
            resolveFindingDispositionRefError(d, regRestarted),
            undefined,
            `disposition ${d.fact_id} must resolve after restart`,
          );
        }
      } finally {
        regression.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('machine-closed terminal predicates stay pure and basis-independent (helper contract)', () => {
    // isDurableAcceptedStageSupport is a machine-closed predicate: exact
    // field presence + shapes decide, no label / heuristic.
    const s1 = acceptedStageSupport('S01');
    assert.equal(isDurableAcceptedStageSupport(s1), true);
    assert.equal(isDurableAcceptedStageSupport(scopeOnlyStageSupport('S01')), false, 'scope-only stage is not a support');
    assert.equal(
      isDurableAcceptedStageSupport({ ...s1, created_by: 'agent' as never }),
      false,
      'created_by must be brain',
    );
    assert.equal(
      isDurableAcceptedStageSupport({ ...s1, result_ref: undefined }),
      false,
      'a support requires a non-empty result_ref',
    );
    assert.equal(
      isDurableAcceptedStageSupport({ ...s1, plan_binding: { ...s1.plan_binding!, binding_stage: 'candidate' as never } }),
      false,
      'a support requires an accepted plan binding',
    );
    assert.equal(
      isDurableAcceptedStageSupport({ ...s1, git_basis: { ...s1.git_basis!, head: 'short' } }),
      false,
      'a support requires the complete closed git_basis shape',
    );
    assert.equal(isDurableAcceptedStageSupport(resultFact('x')), false, 'a result fact is never a stage support');
    assert.equal(isDurableAcceptedStageSupport(projectReady(['S01'])), false, 'project_ready is not a stage support');

    // verifyProjectReadySupportError reports missing / extra / duplicate /
    // unsorted / mismatch with a fail-closed message and never compares
    // per-fact git_basis values across facts.
    const base = [s1, acceptedStageSupport('S02', HEAD_B), acceptedStageSupport('S03', HEAD_C)];
    assert.ok(
      typeof verifyProjectReadySupportError(projectReady(['S01', 'S02', 'S03', 'S04']), base) === 'string',
      'missing support must fail',
    );
    assert.ok(
      typeof verifyProjectReadySupportError(projectReady(['S01', 'S02']), base) === 'string',
      'extra support must fail',
    );
    assert.ok(
      typeof verifyProjectReadySupportError(projectReady(['S01', 'S02']), [s1, acceptedStageSupport('S03', HEAD_C)]) === 'string',
      'mismatch must fail',
    );
    const unsorted = projectReady(['S02', 'S01']) as unknown as MesFactEnvelope;
    assert.ok(
      typeof verifyProjectReadySupportError(unsorted, base) === 'string',
      'unsorted planned set must fail',
    );
    const dup = projectReady(['S01', 'S01']) as unknown as MesFactEnvelope;
    assert.ok(typeof verifyProjectReadySupportError(dup, base) === 'string', 'duplicate planned id must fail');
    // Exact closure across different per-fact heads (basis-independent).
    assert.equal(
      verifyProjectReadySupportError(projectReady(['S01', 'S02', 'S03']), base),
      undefined,
      'closure holds regardless of per-fact git_basis values',
    );
  });

  test('fails closed when a later write breaks the retained project_ready closure (retained-relation drift)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const s1 = acceptedStageSupport('S01', HEAD_A);
      const s2 = acceptedStageSupport('S02', HEAD_B);
      const s3 = acceptedStageSupport('S03', HEAD_C);
      const pr = projectReady(['S01', 'S02', 'S03']);

      // Generation 1: a durable exact terminal closure.
      store.write([s1, s2, s3, pr]);
      const goodBytes = snapshotBytes(fixture);

      // Generation 2: a write that adds a NEW accepted-stage support (S04)
      // WITHOUT resubmitting project_ready must fail closed: the retained
      // project_ready's planned set would no longer EXACTLY equal the durable
      // support set of the same persisted result set (extra S04 support) — the
      // terminal relation must stay exactly closed on EVERY write (PO-S04-B-01).
      const s4 = acceptedStageSupport('S04', HEAD_D);
      assert.throws(
        () => store.write([s4]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a support-only write that drifts the retained project_ready closure must fail closed no-write',
      );
      assert.deepEqual(snapshotBytes(fixture), goodBytes, 'the drifted write must not touch the previous snapshot');
      assert.deepEqual(store.read(), [s1, s2, s3, pr], 'the persisted set stays exactly closed');

      // Even a write that carries the S04 support TOGETHER with a new
      // project_ready (new fact_id) fails closed: the retained project_ready:1
      // (planned [S01,S02,S03]) would still drift in the resulting set (extra
      // S04 support) — exact closure semantics apply to the WHOLE persisted
      // result set on every write, retained facts included (PO-S04-B-01/B-02).
      const prWithS04 = projectReady(['S01', 'S02', 'S03', 'S04'], { fact_id: 'mes:fact:project_ready:2' });
      assert.throws(
        () => store.write([s4, prWithS04]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a write that drifts the retained project_ready closure must fail closed no-write',
      );
      assert.deepEqual(snapshotBytes(fixture), goodBytes, 'the drifted write must not touch the previous snapshot');
      assert.deepEqual(store.read(), [s1, s2, s3, pr], 'the persisted set stays exactly closed');
    } finally {
      fixture.cleanup();
    }
  });

  test('fails closed when a later write breaks a retained finding_disposition finding_ref (retained-relation drift)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const f1 = findingFact('S03:S03-A:cv-1');
      const d1 = dispositionFact('S03:S03-A:cv-1');

      // Generation 1: a durable unique Review→Finding mapping.
      store.write([f1, d1]);
      const goodBytes = snapshotBytes(fixture);
      assert.equal(resolveFindingDispositionRefError(d1, store.read()), undefined);

      // Generation 2: a write that shadows the durable `finding` fact with a
      // NON-finding fact carrying the SAME fact_id (replace-all semantics)
      // must fail closed: the retained disposition's finding_ref would no
      // longer resolve to a durable finding in the resulting set (STATIC-29).
      const shadow = { ...resultFact('shadow'), fact_id: f1.fact_id } as MesFactEnvelope;
      assert.throws(
        () => store.write([shadow]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a write that shadows the durable finding behind a retained disposition must fail closed no-write',
      );
      assert.deepEqual(snapshotBytes(fixture), goodBytes, 'the shadowing write must not touch the previous snapshot');
      assert.equal(resolveFindingDispositionRefError(d1, store.read()), undefined, 'the durable mapping stays unique and closed');

      // A disposition whose ref still resolves to a durable finding is legal;
      // replacing BOTH relation facts together in one write keeps it closed.
      const f2 = findingFact('S03:S03-B:cv-1');
      const d2 = dispositionFact('S03:S03-B:cv-1');
      store.write([f2, d2]);
      const advanced = store.read();
      assert.equal(resolveFindingDispositionRefError(d2, advanced), undefined);
      assert.equal(resolveFindingDispositionRefError(d1, advanced), undefined, 'the retained mapping survives a legal write');
    } finally {
      fixture.cleanup();
    }
  });

  test('coexists legacy and current PROJECT_READY terminals with the same planned Stage IDs through store write and restart, each resolving its own cycle-scoped support relation (S05-D repair / CV S05-D-cv-1 / E2E-23)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const planned = ['S01', 'S02', 'S03'];
      const legacySupports = planned.map((stage) => acceptedStageSupport(stage, HEAD_A));
      const currentSupports = planned.map((stage, i) => ({
        ...acceptedStageSupport(stage, HEAD_B),
        fact_id: `mes:fact:stage:${stage}:accepted:cycle`,
        plan_binding: {
          ...acceptedStageSupport(stage, HEAD_B).plan_binding!,
          delivery_cycle_id: CYCLE,
        },
      }));
      const legacyPr = projectReady(planned);
      const currentPr = projectReady(planned, { fact_id: 'mes:fact:project_ready:2', delivery_cycle_id: CYCLE });

      // One write persists BOTH terminals and BOTH support cohorts; each
      // terminal's relation closes over its OWN cycle-scoped supports
      // (E2E-23: historical and current terminals with the same planned set
      // coexist and rebuild independently).
      store.write([...legacySupports, ...currentSupports, legacyPr, currentPr]);
      const persisted = store.read();
      assert.equal(persisted.length, 8, '4 legacy supports + 4 current supports + 2 terminals');
      assert.equal(
        verifyProjectReadySupportError(persisted.find((f) => f.fact_id === legacyPr.fact_id)!, persisted),
        undefined,
        'legacy terminal closes over its own relation after store write',
      );
      assert.equal(
        verifyProjectReadySupportError(persisted.find((f) => f.fact_id === currentPr.fact_id)!, persisted),
        undefined,
        'current terminal closes over its own relation after store write',
      );

      // Restart rehydrates the same durable facts and BOTH terminals rebuild
      // their own relations independently.
      const restarted = new MesSnapshotStore(fixture.dir).read();
      assert.deepEqual(restarted, persisted);
      const legacyAgain = restarted.find((f) => f.fact_id === legacyPr.fact_id)!;
      const currentAgain = restarted.find((f) => f.fact_id === currentPr.fact_id)!;
      assert.equal(verifyProjectReadySupportError(legacyAgain, restarted), undefined, 'legacy terminal closes after restart');
      assert.equal(verifyProjectReadySupportError(currentAgain, restarted), undefined, 'current terminal closes after restart');

      // A current terminal whose planned stage's only support carries a
      // MISMATCHED cycle is no-write; the previous snapshot stays
      // byte-for-byte unchanged (RESULT_INVALID).
      const goodBytes = snapshotBytes(fixture);
      const mismatchPr = projectReady(['S04'], { fact_id: 'mes:fact:project_ready:3', delivery_cycle_id: CYCLE });
      const mismatchSupport = {
        ...acceptedStageSupport('S04', HEAD_C),
        plan_binding: {
          ...acceptedStageSupport('S04', HEAD_C).plan_binding!,
          delivery_cycle_id: 'cycle-other',
        },
      };
      assert.throws(
        () => store.write([mismatchSupport, mismatchPr]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a current terminal with a mismatched-cycle support must fail closed no-write',
      );
      assert.deepEqual(snapshotBytes(fixture), goodBytes, 'the mismatched-cycle write must not touch the previous snapshot');
    } finally {
      fixture.cleanup();
    }
  });

  test('E2E-23 machine closure: a new NORMAL cycle candidate/accepted binding through the same opaque delivery_cycle_id coexists with a historical PROJECT_READY (planned S01..S04, no cycle) and both terminals rebuild independently after restart (S05-B-T02 / PO-S05-B-03)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const S05_PLAN = 'delivery/stages/S05/plan.md';
      const S05_DIGEST = DIGEST;
      const PVR_REF = 'mes:result:S05:planning-verification-1';
      const planned = ['S01', 'S02', 'S03', 'S04'];

      // Generation 1: the HISTORICAL cohort — legacy accepted-stage supports
      // (no cycle) + legacy PROJECT_READY (planned S01..S04, no cycle). No
      // planning binding exists yet, so currentCycle is undefined and the
      // legacy-shaped supports are legal.
      const legacySupports = planned.map((stage) => acceptedStageSupport(stage, HEAD_A));
      const legacyPr = projectReady(planned);
      store.write([...legacySupports, legacyPr]);
      assert.equal(store.read().length, 5);

      // Generation 2: the CURRENT cycle cohort — candidate/accepted binding
      // (PVR PLAN_READY + PA) via the SAME opaque delivery_cycle_id, plus
      // cycle-bearing accepted-stage supports (verification ref → the durable
      // PVR, result ref → Review-owned stage-only results) and a current
      // PROJECT_READY with the SAME planned Stage IDs.
      const basis = { head: HEAD_D, branch: 'v2-herdr', worktree: '.' };
      const pvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:1',
        result_ref: PVR_REF,
        verifier_role: 'stage-plan-verifier',
        action_token: 's05-spv-1',
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: S05_PLAN,
          accepted_plan_ref: null,
          verdict: 'PLAN_READY',
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: basis,
      };
      const pa: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S05:1',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        supersedes_plan_acceptance_ref: null,
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: PVR_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: basis,
      };
      const currentSupports: MesFactEnvelope[] = planned.map((stage) => ({
        ...acceptedStageSupport(stage, HEAD_B),
        fact_id: `mes:fact:stage:${stage}:accepted:cycle`,
        plan_binding: {
          binding_stage: 'accepted' as const,
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: PVR_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        result_ref: `mes:result:${stage}:stage-review-cycle`,
      } as MesFactEnvelope));
      const reviewResults = planned.map((stage) => ({
        schema_version: 2,
        fact_id: `mes:fact:result:${stage}:stage-review-cycle`,
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: stage },
        work_id: `mes:work:${stage}:review:1`,
        result_ref: `mes:result:${stage}:stage-review-cycle`,
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: PVR_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: basis,
        result_id: `stage-review-${stage}-cycle`,
        result_payload_digest: DIGEST,
      } as MesFactEnvelope));
      const currentPr = projectReady(planned, { fact_id: 'mes:fact:project_ready:2', delivery_cycle_id: CYCLE });
      store.write([pvr, pa, ...currentSupports, ...reviewResults, currentPr]);
      const persisted = store.read();
      assert.equal(persisted.length, 5 + 2 + 4 + 4 + 1, 'history 5 + pvr/pa 2 + current supports 4 + review results 4 + current terminal 1');

      // Even with the SAME planned Stage IDs, each terminal closes over its
      // OWN cycle-scoped support relation (E2E-23 / STATIC-30).
      assert.equal(
        verifyProjectReadySupportError(persisted.find((f) => f.fact_id === legacyPr.fact_id)!, persisted),
        undefined,
        'the historical terminal must close over the no-cycle supports',
      );
      assert.equal(
        verifyProjectReadySupportError(persisted.find((f) => f.fact_id === currentPr.fact_id)!, persisted),
        undefined,
        'the current terminal must close over the cycle-scoped supports',
      );

      // Cross-fact cycle equality on submitted ∪ retained: every durable
      // plan-bound fact either carries the current cycle or is a retained
      // no-cycle legacy history fact (never backfilled).
      for (const f of persisted) {
        const cycle = f.plan_binding?.delivery_cycle_id;
        if (cycle !== undefined) assert.equal(cycle, CYCLE, `fact ${f.fact_id} must carry exactly the current cycle`);
      }

      // Restart rebuilds both terminals independently from the same facts.
      const restarted = new MesSnapshotStore(fixture.dir).read();
      assert.deepEqual(restarted, persisted);
      assert.equal(
        verifyProjectReadySupportError(restarted.find((f) => f.fact_id === legacyPr.fact_id)!, restarted),
        undefined,
        'historical terminal rebuilds after restart',
      );
      assert.equal(
        verifyProjectReadySupportError(restarted.find((f) => f.fact_id === currentPr.fact_id)!, restarted),
        undefined,
        'current terminal rebuilds after restart',
      );
      const currentStage = restarted.find((f) => f.fact_id === 'mes:fact:stage:S01:accepted:cycle')!;
      const currentReview = restarted.find((f) => f.fact_id === 'mes:fact:result:S01:stage-review-cycle')!;
      assert.equal(
        verifyAcceptedStageReviewResultSupport(currentStage, currentReview),
        undefined,
        'a current-cycle accepted stage + its Review result close after restart',
      );

      // Cross-fact cycle equality is a WRITE invariant: a NEW support with a
      // different cycle is no-write byte-stable.
      const goodBytes = snapshotBytes(fixture);
      const crossCycleSupport = {
        ...acceptedStageSupport('S01', HEAD_C),
        fact_id: 'mes:fact:stage:S01:accepted:cross',
        plan_binding: {
          ...acceptedStageSupport('S01', HEAD_C).plan_binding!,
          delivery_cycle_id: 'cycle-other',
        },
      };
      assert.throws(
        () => store.write([crossCycleSupport]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a cross-cycle support must fail closed no-write',
      );
      assert.deepEqual(snapshotBytes(fixture), goodBytes, 'the cross-cycle write must not touch the previous snapshot');
    } finally {
      fixture.cleanup();
    }
  });

  test('real NORMAL Slice lifecycle chain: Worker work/result → CV finding → candidate-freeze git → Integration git → Review result/finding_disposition → accepted stage → PROJECT_READY all durable in one snapshot with exact relation closures and restart rebuild (S05-B-T02 / PO-S05-B-06)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const S05_PLAN = 'delivery/stages/S05/plan.md';
      const S05_DIGEST = DIGEST;
      const PVR_REF = 'mes:result:S05:planning-verification-1';
      const STAGE_RESULT_REF = 'mes:result:S05:stage-review-1';
      const basis = { head: HEAD_D, branch: 'v2-herdr', worktree: '.' };
      const accepted = {
        binding_stage: 'accepted' as const,
        accepted_plan_ref: S05_PLAN,
        source_candidate_plan_ref: S05_PLAN,
        verification_result_ref: PVR_REF,
        plan_digest: S05_DIGEST,
        delivery_cycle_id: CYCLE,
      };

      // 1) planning: PVR (PLAN_READY) + PA via the same opaque cycle ID.
      const pvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:1',
        result_ref: PVR_REF,
        verifier_role: 'stage-plan-verifier',
        action_token: 's05-spv-1',
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: S05_PLAN,
          accepted_plan_ref: null,
          verdict: 'PLAN_READY',
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: basis,
      };
      const pa: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S05:1',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        supersedes_plan_acceptance_ref: null,
        plan_binding: accepted,
        git_basis: basis,
      };

      // 2) Worker: work + task-scoped result facts.
      const work: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:work:S05:S05-B:1',
        fact_kind: 'work',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05', slice_id: 'S05-B' },
        work_id: 'mes:work:S05:S05-B:1',
        plan_binding: accepted,
        git_basis: basis,
      };
      const workerResult: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S05:S05-B-T01:1',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#4.3'],
        scope: { stage_id: 'S05', slice_id: 'S05-B', task_id: 'S05-B-T01' },
        work_id: 'mes:work:S05:S05-B:1',
        result_ref: 'mes:result:S05:S05-B-T01:1',
        plan_binding: accepted,
        git_basis: basis,
        result_id: 'attempt-s05-b-t01',
        result_payload_digest: DIGEST,
      };

      // 3) CV: a durable finding citing the Worker result.
      const finding: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:finding:S05:S05-B:cv-1',
        fact_kind: 'finding',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.3'],
        scope: { stage_id: 'S05', slice_id: 'S05-B' },
        work_id: 'mes:work:S05:S05-B:1',
        plan_binding: accepted,
        git_basis: basis,
        verifier_verdict: 'FINDINGS',
        claimed_route_code: 'IMPLEMENTATION_DEFECT',
        finding_evidence_refs: ['mes:result:S05:S05-B-T01:1'],
      };

      // 4) candidate-freeze + Integration git facts.
      const gitCandidate: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:git:S05:S05-B:candidate:1',
        fact_kind: 'git',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#5.3'],
        scope: { stage_id: 'S05', slice_id: 'S05-B' },
        plan_binding: accepted,
        git_basis: basis,
        git_subkind: 'candidate',
        candidate_ref: 'proofloop-s05-b',
        candidate_base_ref: HEAD_A,
        commit_sha: HEAD_B,
        changed_files: ['packages/runtime/src/mes/store.ts'],
      };
      const gitIntegration: MesFactEnvelope = {
        ...gitCandidate,
        fact_id: 'mes:fact:git:S05:S05-B:integration:1',
        git_subkind: 'integration',
        commit_sha: HEAD_C,
      };

      // 5) Review: stage-only Review result + finding_disposition (exact
      // finding_ref → durable finding).
      const reviewResult: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S05:stage-review-1',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:review:1',
        result_ref: STAGE_RESULT_REF,
        plan_binding: accepted,
        git_basis: basis,
        result_id: 'stage-review-1',
        result_payload_digest: DIGEST,
      };
      const disposition: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:finding_disposition:S05:S05-B:cv-1',
        fact_kind: 'finding_disposition',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.3'],
        scope: { stage_id: 'S05', slice_id: 'S05-B' },
        plan_binding: accepted,
        git_basis: basis,
        disposition_ref: 'mes:disposition:S05:S05-B:cv-1',
        finding_ref: finding.fact_id,
        finding_disposition: 'ACCEPTED',
        claimed_route_code: 'IMPLEMENTATION_DEFECT',
        accepted_route_code: 'IMPLEMENTATION_DEFECT',
        basis_refs: ['tech-spec/contracts.md#2.2.3'],
        reason: 'finding supported by plan and scope',
        resume_target: 'producer',
      };

      // 6) accepted stage closing the verification ref → PLAN_READY PVR and
      //    result ref → the Review-owned stage-only result.
      const stage: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S05:accepted',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        plan_binding: accepted,
        git_basis: basis,
        result_ref: STAGE_RESULT_REF,
      };

      // 7) PROJECT_READY terminal (planned set == the S05 accepted stage).
      const prTerminal = projectReady(['S05'], { delivery_cycle_id: CYCLE });

      // The whole chain is written through the public store API in lifecycle
      // order (whole-resulting-set each step — work/result/git are replace-all).
      const chain = [pvr, pa, work, workerResult, finding, gitCandidate, gitIntegration, reviewResult, disposition, stage, prTerminal];
      store.write(chain);
      const persisted = store.read();
      assert.equal(persisted.length, chain.length, 'the full chain persists exactly once');

      // Every relation closes exactly over the durable set.
      const paAgain = persisted.find((f) => f.fact_id === pa.fact_id)!;
      const pvrAgain = persisted.find((f) => f.fact_id === pvr.fact_id)!;
      assert.equal(verifyPlanAcceptanceSupport(paAgain, pvrAgain), undefined, 'PA→PVR closes');
      const stageAgain = persisted.find((f) => f.fact_id === stage.fact_id)!;
      const reviewAgain = persisted.find((f) => f.fact_id === reviewResult.fact_id)!;
      assert.equal(verifyAcceptedStageReviewResultSupport(stageAgain, reviewAgain), undefined, 'accepted stage + Review result close');
      const dispositionAgain = persisted.find((f) => f.fact_id === disposition.fact_id)!;
      assert.equal(resolveFindingDispositionRefError(dispositionAgain, persisted), undefined, 'finding_disposition → finding closes');
      const prAgain = persisted.find((f) => f.fact_kind === 'project_ready')!;
      assert.equal(verifyProjectReadySupportError(prAgain, persisted), undefined, 'PROJECT_READY terminal closes');

      // Cross-fact cycle equality holds on every durable plan-bound fact.
      for (const f of persisted) {
        if (f.plan_binding !== undefined) {
          assert.equal(f.plan_binding.delivery_cycle_id, CYCLE, `chain fact ${f.fact_id} carries the cycle`);
        }
      }

      // Restart rebuilds the same set and the same exact closures.
      const restarted = new MesSnapshotStore(fixture.dir).read();
      assert.deepEqual(restarted, persisted, 'restart rebuilds the same durable chain');
      assert.equal(verifyPlanAcceptanceSupport(restarted.find((f) => f.fact_id === pa.fact_id)!, restarted.find((f) => f.fact_id === pvr.fact_id)!), undefined);
      assert.equal(
        verifyAcceptedStageReviewResultSupport(
          restarted.find((f) => f.fact_id === stage.fact_id)!,
          restarted.find((f) => f.fact_id === reviewResult.fact_id)!,
        ),
        undefined,
      );
      assert.equal(
        resolveFindingDispositionRefError(restarted.find((f) => f.fact_id === disposition.fact_id)!, restarted),
        undefined,
      );
      assert.equal(
        verifyProjectReadySupportError(restarted.find((f) => f.fact_kind === 'project_ready')!, restarted),
        undefined,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('live-shape cycle-bound terminal closure: a NEW cycle-bound PROJECT_READY (planned [S05], top-level cycle) closes over the same-cycle S05 accepted stage while retained legacy S01..S04 supports and the legacy terminal stay byte-equivalent; terminals whose relation would use cycle-less legacy supports fail closed no-write (S05 terminal-closure audit / E2E-23 / STATIC-30)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-s05-terminal-closure';
      const S05_PLAN = 'delivery/stages/S05/plan.md';
      const S05_DIGEST = DIGEST;
      const PVR_REF = 'mes:result:S05:planning-verification-terminal-closure';
      const STAGE_RESULT_REF = 'mes:result:S05:stage-review-terminal-closure';
      const basis = { head: HEAD_D, branch: 'v2-herdr', worktree: '.' };

      // Generation 1: the retained LEGACY cohort — historical S01..S04
      // accepted-stage supports (no cycle) + the historical PROJECT_READY
      // (planned S01..S04, no cycle). Mirrors the durable retained MES
      // snapshot (legacy history-only, never backfilled).
      const legacySupports = ['S01', 'S02', 'S03', 'S04'].map((stage) => acceptedStageSupport(stage, HEAD_A));
      const legacyPr = projectReady(['S01', 'S02', 'S03', 'S04']);
      store.write([...legacySupports, legacyPr]);
      const legacyBytesBefore: Record<string, string> = {};
      for (const f of [...legacySupports, legacyPr]) legacyBytesBefore[f.fact_id] = canonicalStringify(f);

      // Generation 2: the current NORMAL cycle cohort — PVR (PLAN_READY) +
      // PA anchored by the SAME opaque delivery_cycle_id, the cycle-bearing
      // S05 accepted stage (verification ref → PVR, result_ref → the
      // stage-only Review-owned result) and the stage-only Review result.
      const accepted = {
        binding_stage: 'accepted' as const,
        accepted_plan_ref: S05_PLAN,
        source_candidate_plan_ref: S05_PLAN,
        verification_result_ref: PVR_REF,
        plan_digest: S05_DIGEST,
        delivery_cycle_id: CYCLE,
      };
      const pvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:terminal-closure',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:terminal-closure',
        result_ref: PVR_REF,
        verifier_role: 'stage-plan-verifier',
        action_token: 's05-spv-terminal-closure',
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: S05_PLAN,
          accepted_plan_ref: null,
          verdict: 'PLAN_READY',
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: basis,
      };
      const pa: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S05:terminal-closure',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        supersedes_plan_acceptance_ref: null,
        plan_binding: accepted,
        git_basis: basis,
      };
      const reviewResult: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S05:stage-review-terminal-closure',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:review:terminal-closure',
        result_ref: STAGE_RESULT_REF,
        plan_binding: accepted,
        git_basis: basis,
        result_id: 'stage-review-terminal-closure',
        result_payload_digest: DIGEST,
      };
      const stageS05: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S05:accepted:terminal-closure',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        plan_binding: accepted,
        git_basis: basis,
        result_ref: STAGE_RESULT_REF,
      };
      store.write([pvr, pa, reviewResult, stageS05]);
      assert.equal(store.read().length, 9, '5 legacy + 4 current-cycle facts');

      // Generation 3: the POSITIVE closure — a NEW cycle-bound PROJECT_READY
      // with the current cycle's planned set [S05] (the current cycle's
      // active Map entry #S05) and the top-level delivery_cycle_id. The
      // terminal relation closes ONLY over the same-cycle S05 accepted
      // stage; the cycle-less legacy supports never join (E2E-23 / STATIC-30).
      const currentPr = projectReady(['S05'], { fact_id: 'mes:fact:project_ready:terminal-closure', delivery_cycle_id: CYCLE });
      store.write([...legacySupports, legacyPr, pvr, pa, reviewResult, stageS05, currentPr]);
      const persisted = store.read();
      assert.equal(persisted.length, 10, '5 legacy + 4 current-cycle + 1 new terminal');
      assert.equal(
        verifyProjectReadySupportError(persisted.find((f) => f.fact_id === currentPr.fact_id)!, persisted),
        undefined,
        'current cycle-bound terminal must close over the same-cycle S05 support',
      );
      assert.equal(
        verifyProjectReadySupportError(persisted.find((f) => f.fact_id === legacyPr.fact_id)!, persisted),
        undefined,
        'legacy terminal must still close over its legacy no-cycle supports',
      );
      // Retained legacy facts stay CANONICALLY BYTE-EQUIVALENT (never
      // backfilled with the cycle, never upgraded).
      for (const f of persisted) {
        if (legacyBytesBefore[f.fact_id] !== undefined) {
          assert.equal(
            canonicalStringify(f),
            legacyBytesBefore[f.fact_id],
            `retained legacy fact ${f.fact_id} must stay byte-equivalent`,
          );
        }
      }
      // Restart rebuilds both terminal relations independently.
      const restarted = new MesSnapshotStore(fixture.dir).read();
      assert.deepEqual(restarted, persisted);
      assert.equal(
        verifyProjectReadySupportError(restarted.find((f) => f.fact_id === currentPr.fact_id)!, restarted),
        undefined,
      );
      assert.equal(
        verifyProjectReadySupportError(restarted.find((f) => f.fact_id === legacyPr.fact_id)!, restarted),
        undefined,
      );

      // NEGATIVE: a current-cycle terminal whose relation would REQUIRE the
      // cycle-less legacy S01..S04 supports never closes — planned [S01..S05]
      // (missing same-cycle supports) and planned [S01..S04] (missing + extra
      // S05) both fail closed no-write; the last valid snapshot stays
      // byte-for-byte unchanged (RESULT_INVALID). The cycle-equality rule is
      // NOT relaxed (E2E-23 / STATIC-30).
      const goodBytes = snapshotBytes(fixture);
      const badPlanned: string[][] = [['S01', 'S02', 'S03', 'S04', 'S05'], ['S01', 'S02', 'S03', 'S04']];
      for (const planned of badPlanned) {
        const badPr = projectReady(planned, { fact_id: 'mes:fact:project_ready:bad', delivery_cycle_id: CYCLE });
        assert.notEqual(
          verifyProjectReadySupportError(badPr, [...persisted, badPr]),
          undefined,
          'the cycle-equality rule must not be relaxed',
        );
        assert.throws(
          () => store.write([...persisted, badPr]),
          (err: unknown) =>
            err instanceof MesSnapshotStoreError &&
            err.code === 'invalid-fact' &&
            err.message.includes('RESULT_INVALID'),
          'a current-cycle terminal requiring legacy supports must fail closed no-write',
        );
        assert.deepEqual(snapshotBytes(fixture), goodBytes, 'the failed terminal write must not touch the last valid snapshot');
      }
    } finally {
      fixture.cleanup();
    }
  });
});
