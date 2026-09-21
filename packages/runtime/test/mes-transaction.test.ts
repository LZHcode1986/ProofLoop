/**
 * MES operational transaction layer tests (S06-R-A-T01).
 *
 * # PO: contracts.md §2.1.2 MES operational transaction boundary; acceptance
 * E2E-25 / STATIC-32
 *
 * Exercises the semantic-event → durable materialization seam on isolated
 * fixture roots only (never the real `.proofloop/mes` — the frozen S06
 * snapshot stays byte-stable under quarantine):
 *   - preserve-by-default: a caller submitting ONLY the new facts never
 *     deletes unrelated durable fact IDs (Sep 10 partial-replace / Sep 12
 *     result-write partial-replace incident regression); byte-identical
 *     replay collapses idempotently and stays byte-stable;
 *   - atomic no-write: every failure path (invalid event shape, invalid
 *     fact, within-event duplicate with different payload, immutable durable
 *     payload change, binding-critical identity mismatch, unreadable /
 *     corrupt current snapshot) leaves the last valid snapshot byte-stable;
 *   - restart: a NEW store / transaction-layer instance re-reads the same
 *     resulting fact set and digest (same canonical container);
 *   - raw full-snapshot writer negative path: the caller cannot submit a
 *     full snapshot / retention list / caller-assembled `submitted ∪
 *     retained` state, and non-NORMAL execution modes (PRE_MES_BOOTSTRAP /
 *     MES_MAINTENANCE) are rejected — the transaction layer is the NORMAL
 *     durable mutator, the maintenance lane never writes MES.
 *
 * All tests use only temporary Git fixtures (helpers.ts#makeFixture) and
 * never the work clone's Git/MES state. Imports the compiled runtime dist
 * (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  createMesTransactionLayer,
  MesTransactionError,
  resolveTransactionBindingError,
  materializeTransactionDelta,
} from '../dist/mes/transaction';
import { projectIntegrationState } from '../dist/execute/integration-state';
import { classifyInvalidHistory } from '../dist/mes/history-oracle';
import { projectCycleFilteredStatus, MesStatusError } from '../dist/mes/status';
import { duplicateAcceptedStageSupportError } from '../dist/mes/terminal';
import type { MesSemanticEvent, MesTransactionBinding } from '../dist/mes/transaction';
import { MesSnapshotStore, MES_SNAPSHOT_REL } from '../dist/mes/store';
import type { MesFactEnvelope, MesGitBasis, MesPlanBinding } from '../dist/mes/types';
import { makeFixture, sha } from './helpers';
import { observeCanonicalProjectMes } from './fixtures/e2e25';
import type { CanonicalProjectMesObservation } from './fixtures/e2e25';

/**
 * (PO-S08-A-04) Pre-run canonical project MES observation, captured at module
 * load — before this file's first isolated fixture executes. Safety is
 * expressed as in-run pre/post invariance of the OBSERVED canonical MES (bytes
 * + fact identity); an unobservable canonical MES fails closed in the test
 * below, never silently skipped.
 */
const CANONICAL_PROJECT_MES_PRE:
  | { ok: true; observation: CanonicalProjectMesObservation }
  | { ok: false; error: string } = (() => {
  try {
    return { ok: true as const, observation: observeCanonicalProjectMes() };
  } catch (error) {
    return { ok: false as const, error: (error as Error).message };
  }
})();

const PLAN_REF = 'delivery/stages/S06/plan.md';
const DIGEST = sha('s06-transaction-plan-v1');
const CYCLE = 'cycle-208cbbe8d8e946479bb746f318b56178';
// Canonical S01 work-plan relation: ONE durable plan_acceptance + PVR with a
// single canonical verification_result_ref that every accepted-bound work
// fact under the S01 plan must EXACTLY carry (contracts §2.1.3 — the caller
// never assembles per-fact canonical identity).
const WORK_PLAN_REF = 'delivery/stages/S01/plan.md';
const WORK_CANONICAL_REF = 'mes:verification:S01:plan';
const BASIS: MesGitBasis = { head: 'a'.repeat(40), branch: 'v2-herdr', worktree: '.' };

function snapshotDigest(dir: string): string | null {
  const abs = path.join(dir, MES_SNAPSHOT_REL);
  if (!fs.existsSync(abs)) return null;
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

function normalBinding(): MesTransactionBinding {
  return {
    execution_mode: 'NORMAL',
    authority_refs: ['tech-spec/contracts.md#2.1.2'],
    git_basis: BASIS,
  };
}

function event(facts: readonly MesFactEnvelope[]): MesSemanticEvent {
  return { facts: [...facts], binding: normalBinding() };
}

function projectFact(id: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:project:${id}`,
    fact_kind: 'project',
    created_by: 'brain',
    authority_refs: ['PRD.md#FR-003'],
  };
}

function workFact(id: string, planRef = WORK_PLAN_REF): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:work:${id}`,
    fact_kind: 'work',
    created_by: 'brain',
    authority_refs: ['PRD.md#FR-003'],
    scope: { stage_id: 'S01', slice_id: 'S01-A', task_id: 'S01-A-T01' },
    work_id: `mes:work:${id}`,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: planRef,
      source_candidate_plan_ref: planRef,
      verification_result_ref: WORK_CANONICAL_REF,
      plan_digest: DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
  };
}

/** Canonical S01 plan_acceptance support so accepted-bound work facts resolve. */
function pvrWork(tag = '1'): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:planning_verification_result:S01:${tag}`,
    fact_kind: 'planning_verification_result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.2'],
    scope: { stage_id: 'S01' },
    work_id: `mes:work:S01:planning:${tag}`,
    result_ref: WORK_CANONICAL_REF,
    verifier_role: 'stage-plan-verifier',
    action_token: `s01-spv-${tag}`,
    plan_binding: {
      binding_stage: 'candidate',
      candidate_plan_ref: WORK_PLAN_REF,
      accepted_plan_ref: null,
      verdict: 'PLAN_READY',
      plan_digest: DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
  };
}

function paWork(tag = '1'): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:plan_acceptance:S01:${tag}`,
    fact_kind: 'plan_acceptance',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.2'],
    scope: { stage_id: 'S01' },
    supersedes_plan_acceptance_ref: null,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: WORK_PLAN_REF,
      source_candidate_plan_ref: WORK_PLAN_REF,
      verification_result_ref: WORK_CANONICAL_REF,
      plan_digest: DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
  };
}

function pvr(tag: string, ref: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:planning_verification_result:S06:${tag}`,
    fact_kind: 'planning_verification_result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.2'],
    scope: { stage_id: 'S06' },
    work_id: `mes:work:S06:planning:${tag}`,
    result_ref: ref,
    verifier_role: 'stage-plan-verifier',
    action_token: `s06-spv-${tag}`,
    plan_binding: {
      binding_stage: 'candidate',
      candidate_plan_ref: PLAN_REF,
      accepted_plan_ref: null,
      verdict: 'PLAN_READY',
      plan_digest: DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
  };
}

function pa(tag: string, ref: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:plan_acceptance:S06:${tag}`,
    fact_kind: 'plan_acceptance',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.2'],
    scope: { stage_id: 'S06' },
    supersedes_plan_acceptance_ref: null,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: PLAN_REF,
      source_candidate_plan_ref: PLAN_REF,
      verification_result_ref: ref,
      plan_digest: DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
  };
}

// ============================================================
// S08-A-T01 fixtures (PO-S08-A-01): canonical workspace git-fact domain
// composition. Isolated mkdtemp fixture roots only.
// ============================================================
const S08_STAGE = 'S08';
const S08_SLICE = 'S08-A';
const S08_PLAN_REF = 'delivery/stages/S08/plan.md';
const S08_CANONICAL_REF = 'mes:result:S08:planning-verification-1';
const S08_DIGEST = sha('s08-transaction-plan-v1');

/** Canonical S08 PLAN_READY verification evidence for the current cycle. */
function s08Pvr(): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:planning_verification_result:S08:1',
    fact_kind: 'planning_verification_result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.2'],
    scope: { stage_id: S08_STAGE },
    work_id: 'mes:work:S08:planning:1',
    result_ref: S08_CANONICAL_REF,
    verifier_role: 'stage-plan-verifier',
    action_token: 's08-spv-1',
    plan_binding: {
      binding_stage: 'candidate',
      candidate_plan_ref: S08_PLAN_REF,
      accepted_plan_ref: null,
      verdict: 'PLAN_READY',
      plan_digest: S08_DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
  };
}

/** Canonical S08 accepted-Plan generation closing the candidate above. */
function s08Pa(): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:plan_acceptance:S08:1',
    fact_kind: 'plan_acceptance',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.2'],
    scope: { stage_id: S08_STAGE },
    supersedes_plan_acceptance_ref: null,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: S08_PLAN_REF,
      source_candidate_plan_ref: S08_PLAN_REF,
      verification_result_ref: S08_CANONICAL_REF,
      plan_digest: S08_DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
  };
}

/** Accepted-bound S08-A durable git fact (candidate / integration / cleanup). */
function s08GitFact(
  subkind: 'candidate' | 'integration' | 'cleanup',
  overrides: Record<string, unknown> = {},
): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:git:S08:S08-A:${subkind}`,
    fact_kind: 'git',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.3'],
    scope: { stage_id: S08_STAGE, slice_id: S08_SLICE },
    work_id: 'mes:work:S08:S08-A:1',
    plan_binding: s08Pa().plan_binding,
    git_basis: BASIS,
    git_subkind: subkind,
    candidate_ref: 'proofloop-s08-a',
    candidate_base_ref: 'b'.repeat(40),
    commit_sha: 'c'.repeat(40),
    changed_files: ['packages/runtime/src/mes/transaction.ts'],
    ...overrides,
  } as MesFactEnvelope;
}

// ============================================================
// S08-A-T01 fixtures (PO-S08-A-02): accepted-stage support cohorts.
// ============================================================
const OTHER_CYCLE = 'cycle-4b853c8dcf5c48e7ac5325e9fbfbf95e';
const S06_STAGE = 'S06';

/** Durable accepted-stage support for S06 bound to one accepted generation. */
function stageSupport(factId: string, verificationResultRef: string, cycle: string = CYCLE): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: factId,
    fact_kind: 'stage',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.1'],
    scope: { stage_id: S06_STAGE },
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: PLAN_REF,
      source_candidate_plan_ref: PLAN_REF,
      verification_result_ref: verificationResultRef,
      plan_digest: DIGEST,
      delivery_cycle_id: cycle,
    },
    git_basis: BASIS,
    result_ref: `${factId}:review`,
  };
}

/** Review-owned stage-only result closing one accepted-stage support. */
function stageReviewResult(
  factId: string,
  verificationResultRef: string,
  stageResultRef: string,
  cycle: string = CYCLE,
): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: factId,
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.1'],
    scope: { stage_id: S06_STAGE },
    work_id: `mes:work:S06:review:${factId}`,
    result_ref: stageResultRef,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: PLAN_REF,
      source_candidate_plan_ref: PLAN_REF,
      verification_result_ref: verificationResultRef,
      plan_digest: DIGEST,
      delivery_cycle_id: cycle,
    },
    git_basis: BASIS,
    result_id: `review:${factId}`,
    result_payload_digest: sha(`review-payload:${factId}`),
  };
}

/** Legacy no-cycle accepted-stage support (history-only cohort member). */
function legacyStageSupport(factId: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: factId,
    fact_kind: 'stage',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.1'],
    scope: { stage_id: S06_STAGE },
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: PLAN_REF,
      source_candidate_plan_ref: PLAN_REF,
      verification_result_ref: 'mes:result:S06:planning-verification-1',
      plan_digest: DIGEST,
    },
    git_basis: BASIS,
    result_ref: `${factId}:review`,
  };
}

/** Rebind an existing fixture fact's plan_binding to an explicit cycle. */
function inCycle(fact: MesFactEnvelope, cycle: string): MesFactEnvelope {
  const binding = { ...(fact.plan_binding as MesPlanBinding), delivery_cycle_id: cycle } as MesPlanBinding;
  return { ...fact, plan_binding: binding };
}

/** Cycle-scoped cohort member A: one support + its Review result. */
function cohortA(): { support: MesFactEnvelope; review: MesFactEnvelope } {
  const support = stageSupport('mes:fact:stage:S06:a', 'mes:result:pv-1');
  return { support, review: stageReviewResult('mes:fact:result:S06:review-a', 'mes:result:pv-1', support.result_ref as string) };
}

/** Cycle-scoped cohort member B: a SECOND support for the SAME Stage. */
function cohortB(): { support: MesFactEnvelope; review: MesFactEnvelope } {
  const support = stageSupport('mes:fact:stage:S06:b', 'mes:result:pv-1');
  return { support, review: stageReviewResult('mes:fact:result:S06:review-b', 'mes:result:pv-1', support.result_ref as string) };
}

describe('MES operational transaction layer (S06-R-A-T01)', () => {
  test('preserves unrelated durable fact IDs by default and atomically persists the delta (E2E-25 / PO-S06-R-A-T01)', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      const seed = [pvrWork('1'), paWork('1'), projectFact('p1'), workFact('w1'), workFact('w2')];
      store.write(seed);
      const preDigest = snapshotDigest(fixture.dir);
      assert.ok(preDigest !== null, 'seed snapshot must exist');

      // The caller submits ONLY the new fact — never the full snapshot.
      const layer = createMesTransactionLayer(fixture.dir);
      const result = layer.commit(event([workFact('w3')]));

      // unrelated durable fact IDs are preserved by default.
      assert.deepEqual(result.preservedFactIds, [
        'mes:fact:planning_verification_result:S01:1',
        'mes:fact:plan_acceptance:S01:1',
        'mes:fact:project:p1',
        'mes:fact:work:w1',
        'mes:fact:work:w2',
      ]);
      assert.deepEqual(result.materializedFactIds, ['mes:fact:work:w3']);
      assert.deepEqual(result.resultingFactIds, [
        'mes:fact:planning_verification_result:S01:1',
        'mes:fact:plan_acceptance:S01:1',
        'mes:fact:project:p1',
        'mes:fact:work:w1',
        'mes:fact:work:w2',
        'mes:fact:work:w3',
      ]);

      const durable = store.read();
      assert.equal(durable.length, 6);
      assert.deepEqual(
        durable.map((f) => f.fact_id),
        [
          'mes:fact:planning_verification_result:S01:1',
          'mes:fact:plan_acceptance:S01:1',
          'mes:fact:project:p1',
          'mes:fact:work:w1',
          'mes:fact:work:w2',
          'mes:fact:work:w3',
        ],
      );
      // The old facts are byte-identical (only the delta was appended).
      assert.deepEqual(durable[0], seed[0]);
      assert.deepEqual(durable[1], seed[1]);
      assert.deepEqual(durable[2], seed[2]);

      const postDigest = snapshotDigest(fixture.dir);
      assert.ok(postDigest !== null);
      assert.notEqual(postDigest, preDigest, 'the delta must change the snapshot');
      assert.equal(result.snapshotSha256, postDigest, 'reported digest must equal the persisted container');
    } finally {
      fixture.cleanup();
    }
  });

  test('under-submitting old facts never deletes unrelated durable IDs (partial-replace regression)', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      store.write([pvrWork('1'), paWork('1'), projectFact('p1'), projectFact('p2'), workFact('w1')]);
      const layer = createMesTransactionLayer(fixture.dir);
      // The delta carries only ONE new work fact — the caller does NOT
      // resubmit p1/p2/w1 (this is exactly the Sep-10/12 partial-replace
      // incident pattern). The transaction layer must preserve them.
      layer.commit(event([workFact('w2')]));
      const durable = store.read();
      assert.deepEqual(
        durable.map((f) => f.fact_id),
        [
          'mes:fact:planning_verification_result:S01:1',
          'mes:fact:plan_acceptance:S01:1',
          'mes:fact:project:p1',
          'mes:fact:project:p2',
          'mes:fact:work:w1',
          'mes:fact:work:w2',
        ],
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('byte-identical replay collapses idempotently and stays byte-stable (restart)', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      // Canonical S01 relation seeded with the same event so the accepted-bound
      // work facts exact-resolve (missing PA must not be bypassed).
      const canonicalEvent = [pvrWork('1'), paWork('1'), projectFact('p1'), workFact('w1')];
      const first = layer.commit(event(canonicalEvent));
      const digestAfterFirst = snapshotDigest(fixture.dir);

      // A NEW layer (fresh "process") replays the SAME event: nothing new is
      // materialized, the durable set and digest stay byte-identical.
      const layer2 = createMesTransactionLayer(fixture.dir);
      const replay = layer2.commit(event(canonicalEvent));
      assert.deepEqual(replay.materializedFactIds, [], 'byte-identical replay must materialize nothing');
      assert.deepEqual(replay.resultingFactIds, first.resultingFactIds);
      assert.equal(snapshotDigest(fixture.dir), digestAfterFirst, 'replay must be byte-stable');
      assert.equal(replay.snapshotSha256, first.snapshotSha256);

      // And a NEW store instance re-reads the same resulting set (restart).
      const fresh = new MesSnapshotStore(fixture.dir).read();
      assert.equal(fresh.length, 4);
      assert.deepEqual(
        fresh.map((f) => f.fact_id),
        [
          'mes:fact:planning_verification_result:S01:1',
          'mes:fact:plan_acceptance:S01:1',
          'mes:fact:project:p1',
          'mes:fact:work:w1',
        ],
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('invalid event shape fails closed no-write (raw full-snapshot writer negative path)', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      store.write([projectFact('p1')]);
      const preDigest = snapshotDigest(fixture.dir);
      const layer = createMesTransactionLayer(fixture.dir);

      // Caller assembling a full snapshot container / retention state is
      // rejected: the event schema is closed (facts + binding +
      // acceptedPlanTaskGraph only).
      const fullSnapshot = {
        schema_version: 2,
        facts: [projectFact('p1')],
        retention: [],
      };
      assert.throws(
        () => layer.commit(fullSnapshot as unknown as MesSemanticEvent),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'invalid-event',
      );

      // A retention-list key is equally rejected.
      assert.throws(
        () =>
          layer.commit({
            facts: [workFact('w2')],
            binding: normalBinding(),
            submitted: ['mes:fact:project:p1'],
          } as unknown as MesSemanticEvent),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'invalid-event',
      );

      // Empty facts array — a semantic event with no delta is meaningless.
      assert.throws(
        () => layer.commit(event([])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'invalid-event',
      );

      // Non-NORMAL execution modes never write MES: PRE_MES_BOOTSTRAP and
      // MES_MAINTENANCE are rejected by the NORMAL durable mutator.
      for (const mode of ['PRE_MES_BOOTSTRAP', 'MES_MAINTENANCE']) {
        assert.throws(
          () =>
            layer.commit({
              facts: [workFact('w2')],
              binding: { ...normalBinding(), execution_mode: mode } as MesTransactionBinding,
            }),
          (err: unknown) => err instanceof MesTransactionError && err.code === 'invalid-event',
        );
      }

      // Invalid binding: authority_refs must be canonical non-empty refs.
      assert.throws(
        () =>
          layer.commit({
            facts: [workFact('w2')],
            binding: { execution_mode: 'NORMAL', authority_refs: ['relative-no-hash'] },
          }),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'invalid-event',
      );

      // Every refusal is no-write byte-stable.
      assert.equal(snapshotDigest(fixture.dir), preDigest, 'invalid events must not touch the snapshot');
      assert.deepEqual(
        store.read().map((f) => f.fact_id),
        ['mes:fact:project:p1'],
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('invalid submitted fact fails closed no-write byte-stable', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      store.write([projectFact('p1')]);
      const preDigest = snapshotDigest(fixture.dir);
      const layer = createMesTransactionLayer(fixture.dir);

      const bad = {
        schema_version: 2,
        fact_id: 'mes:fact:evil',
        fact_kind: 'does-not-exist',
        created_by: 'agent',
        authority_refs: ['PRD.md#FR-003'],
      };
      assert.throws(
        () => layer.commit(event([bad as unknown as MesFactEnvelope])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'invalid-fact',
      );
      assert.equal(snapshotDigest(fixture.dir), preDigest, 'invalid fact must be no-write');
    } finally {
      fixture.cleanup();
    }
  });

  test('within-event duplicate fact_id with different payload fails closed no-write', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      store.write([projectFact('p1')]);
      const preDigest = snapshotDigest(fixture.dir);
      const layer = createMesTransactionLayer(fixture.dir);

      const w2a = workFact('w2');
      const w2b: MesFactEnvelope = { ...w2a, work_id: 'mes:work:different' };
      assert.throws(
        () => layer.commit(event([w2a, w2b])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'conflict',
      );
      assert.equal(snapshotDigest(fixture.dir), preDigest, 'conflicting duplicate must be no-write');
    } finally {
      fixture.cleanup();
    }
  });

  test('immutable durable fact payload change fails closed no-write; byte-identical replay stays legal', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      const canonicalRef = 'mes:result:S06:planning-verification-1';
      layer.commit(event([pvr('1', canonicalRef)]));
      const preDigest = snapshotDigest(fixture.dir);

      // A DIFFERENT payload under the same durable planning fact_id is
      // immutable → conflict no-write (only byte-identical replay is legal).
      const changed: MesFactEnvelope = { ...pvr('1', canonicalRef), result_ref: 'mes:result:S06:other' };
      assert.throws(
        () => layer.commit(event([changed])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'conflict',
      );
      assert.equal(snapshotDigest(fixture.dir), preDigest, 'immutable change must be no-write');

      // Byte-identical replay of the PVR stays legal and byte-stable.
      const replay = layer.commit(event([pvr('1', canonicalRef)]));
      assert.deepEqual(replay.materializedFactIds, []);
      assert.equal(snapshotDigest(fixture.dir), preDigest, 'replay must be byte-stable');
    } finally {
      fixture.cleanup();
    }
  });

  test('binding-critical identity: canonical vs typo verification_result_ref (S06 binding-mismatch regression)', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      const canonicalRef = 'mes:result:S06:planning-verification-1';
      const typoRef = 'mes:result:S06:planning-verification:1'; // colon vs dash

      // The typo ref must fail closed atomically: no snapshot is created.
      assert.throws(
        () => layer.commit(event([pvr('1', canonicalRef), pa('1', typoRef)])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'binding-mismatch',
      );
      assert.equal(snapshotDigest(fixture.dir), null, 'typo binding must be no-write (no snapshot created)');
      assert.equal(new MesSnapshotStore(fixture.dir).read().length, 0);

      // The canonical event materializes; a NEW layer re-reads the same set.
      const result = layer.commit(event([pvr('1', canonicalRef), pa('1', canonicalRef)]));
      assert.deepEqual(result.resultingFactIds, [
        'mes:fact:planning_verification_result:S06:1',
        'mes:fact:plan_acceptance:S06:1',
      ]);
      const fresh = new MesSnapshotStore(fixture.dir).read();
      assert.equal(fresh.length, 2);
      assert.equal(snapshotDigest(fixture.dir), result.snapshotSha256);

      // The resolution seam is also directly observable (call point for the
      // binding-critical exact-match seam).
      // The resolution seam is also directly observable (call point for the
      // binding-critical exact-match seam): the typo pair yields a fail-closed
      // message, the canonical pair closes with undefined.
      const seamTypo = resolveTransactionBindingError([pvr('1', canonicalRef), pa('1', typoRef)]);
      assert.ok(typeof seamTypo === 'string' && seamTypo.length > 0, 'the seam must reject the typo ref with a message');
      assert.equal(resolveTransactionBindingError([pvr('1', canonicalRef), pa('1', canonicalRef)]), undefined, 'the canonical pair must close');
    } finally {
      fixture.cleanup();
    }
  });

  test('corrupt / unreadable current snapshot fails closed no-write (never treated as empty store)', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      store.write([projectFact('p1')]);
      const preDigest = snapshotDigest(fixture.dir);
      assert.ok(preDigest !== null);

      // Corrupt the durable snapshot on disk.
      fs.writeFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), '{ not json', 'utf8');

      const layer = createMesTransactionLayer(fixture.dir);
      assert.throws(
        () => layer.commit(event([workFact('w1')])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'unreadable',
      );

      // The corrupt bytes stay untouched (never rewritten as an empty store).
      assert.equal(
        fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'),
        '{ not json',
        'corrupt snapshot must stay byte-identical',
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('mutable fact update under the same fact_id is a legal delta (append/update only, no delete)', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      // Seed the canonical S01 relation so the accepted-bound work fact
      // exact-resolves (missing PA must not be bypassed).
      layer.commit(event([pvrWork('1'), paWork('1'), workFact('w1')]));
      const pre = new MesSnapshotStore(fixture.dir).read();

      // Same fact_id, changed payload (mutable kind): update in place while
      // unrelated durable facts are preserved.
      const w1 = pre.find((f) => f.fact_id === 'mes:fact:work:w1')!;
      const updated: MesFactEnvelope = { ...w1, work_id: 'mes:work:updated' };
      const result = layer.commit(event([updated]));
      assert.deepEqual(result.materializedFactIds, ['mes:fact:work:w1']);
      const durable = new MesSnapshotStore(fixture.dir).read();
      assert.equal(durable.length, 3, 'update replaces, never duplicates');
      const updatedWork = durable.find((f) => f.fact_id === 'mes:fact:work:w1')!;
      assert.equal(updatedWork.work_id, 'mes:work:updated');
      assert.equal(updatedWork.fact_id, 'mes:fact:work:w1');
    } finally {
      fixture.cleanup();
    }
  });

  test('CONCURRENCY-001 seam: re-materializing a delta onto a FRESH snapshot preserves a concurrent delta (no lost-update)', () => {
    // Base read in the transaction saw [p1]; a concurrent writer then landed
    // wA into the snapshot BEFORE our persist; the conflict re-read at 6b
    // re-materializes the submitted delta (wB) onto the FRESH snapshot —
    // the concurrent wA is preserved, never silently dropped.
    const fresh = [projectFact('p1'), workFact('wA')];
    const submitted = [workFact('wB')];
    const { resulting, materialized } = materializeTransactionDelta(submitted, fresh);
    const ids = resulting.map((f) => f.fact_id);
    assert.deepEqual(ids, ['mes:fact:project:p1', 'mes:fact:work:wA', 'mes:fact:work:wB']);
    assert.deepEqual(materialized, ['mes:fact:work:wB']);
    assert.deepEqual(resulting[1], workFact('wA'), 'concurrent delta kept byte-identical');
    assert.deepEqual(resulting[2], workFact('wB'), 'submitted delta materialized on top');
  });

  test('CONCURRENCY-001: concurrent commits on the same root preserve BOTH distinct deltas (worker race on one fixture root)', async () => {
    // Two worker threads race on the SAME root: each has its OWN distinct
    // delta. The per-root lock + current-snapshot re-read must guarantee both
    // deltas are durable — a persist computed from a stale base read would
    // otherwise silently drop the other writer's work fact (lost-update).
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      layer.commit(event([pvrWork('1'), paWork('1'), projectFact('p1')])); // seed base + canonical S01 relation
      const layerPath = require.resolve('../dist/mes/transaction');

      const ready = new Int32Array(new SharedArrayBuffer(4));
      const go = new Int32Array(new SharedArrayBuffer(4));

      const spawnWorker = (evt: MesSemanticEvent, tag: string): Promise<void> =>
        new Promise((resolve, reject) => {
          const worker = new Worker(
            [
              "const { parentPort, workerData } = require('node:worker_threads');",
              'const { createMesTransactionLayer } = require(workerData.layerPath);',
              'Atomics.add(workerData.ready, 0, 1);',
              'Atomics.wait(workerData.go, 0, 0);',
              'const layer = createMesTransactionLayer(workerData.dir);',
              'const result = layer.commit(workerData.event);',
              'parentPort.postMessage({ tag: workerData.tag, materialized: result.materializedFactIds });',
            ].join('\n'),
            {
              eval: true,
              workerData: { layerPath, dir: fixture.dir, event: evt, tag, ready, go },
            },
          );
          worker.once('message', (msg) => {
            void msg;
          });
          worker.once('error', reject);
          worker.once('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`worker ${tag} exited with code ${code}`)),
          );
        });

      const doneA = spawnWorker(event([workFact('wA')]), 'A');
      const doneB = spawnWorker(event([workFact('wB')]), 'B');
      // Both workers signal ready, then commit simultaneously.
      while (Atomics.load(ready, 0) < 2) {
        Atomics.wait(ready, 0, Atomics.load(ready, 0), 50);
      }
      Atomics.store(go, 0, 1);
      Atomics.notify(go, 0, 2);
      await Promise.all([doneA, doneB]);

      const durable = new MesSnapshotStore(fixture.dir).read();
      const ids = durable.map((f) => f.fact_id);
      assert.ok(ids.includes('mes:fact:work:wA'), `wA must be durable, got: ${ids.join(', ')}`);
      assert.ok(ids.includes('mes:fact:work:wB'), `wB must be durable, got: ${ids.join(', ')}`);
      assert.ok(ids.includes('mes:fact:project:p1'), 'seed fact must survive');
    } finally {
      fixture.cleanup();
    }
  });

  // ==========================================================
  // S08-A-T01 — pre-persist admission composition
  // (PO-S08-A-01/02/03/04)
  // ==========================================================

  test('composes the canonical git-fact domain validator before persist (PO-S08-A-01)', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      layer.commit(event([s08Pvr(), s08Pa()]));

      // Canonical candidate / integration / cleanup facts all commit and the
      // EXISTING git-fact domain validator (integration-state) exact-projects
      // them — admission composes the validator instead of re-implementing it.
      const candidate = s08GitFact('candidate');
      const integration = s08GitFact('integration', { fact_id: 'mes:fact:git:S08:S08-A:integration:1' });
      const cleanup = {
        ...integration,
        fact_id: 'mes:fact:git:S08:S08-A:cleanup:1',
        git_subkind: 'cleanup' as const,
      };
      const result = layer.commit(event([candidate, integration, cleanup]));
      assert.deepEqual(result.materializedFactIds, [
        'mes:fact:git:S08:S08-A:candidate',
        'mes:fact:git:S08:S08-A:integration:1',
        'mes:fact:git:S08:S08-A:cleanup:1',
      ]);
      assert.equal(projectIntegrationState(new MesSnapshotStore(fixture.dir).read()), 'CLEANED');

      // A byte-identical replay of the canonical git facts collapses
      // idempotently and stays byte-stable (contracts §2.1.2 idempotency):
      // composing the domain validator never breaks legal replay.
      const digestAfterCommit = snapshotDigest(fixture.dir);
      const replay = layer.commit(event([candidate, integration, cleanup]));
      assert.deepEqual(replay.materializedFactIds, []);
      assert.equal(snapshotDigest(fixture.dir), digestAfterCommit);
    } finally {
      fixture.cleanup();
    }
  });

  test('non-canonical candidate_ref is atomic no-write byte-stable (PO-S08-A-01)', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      layer.commit(event([s08Pvr(), s08Pa()]));
      const before = snapshotDigest(fixture.dir);
      const beforeIds = new MesSnapshotStore(fixture.dir).read().map((f) => f.fact_id);
      const beforeClassification = classifyInvalidHistory(new MesSnapshotStore(fixture.dir).read());

      // scope S08-A but a candidate_ref that is NOT the canonical proofloop-s08-a.
      assert.throws(
        () => layer.commit(event([s08GitFact('candidate', { candidate_ref: 'proofloop-wrong' })])),
        (err: unknown) =>
          err instanceof MesTransactionError && (err.code === 'invalid-fact' || err.code === 'binding-mismatch'),
      );
      assert.equal(snapshotDigest(fixture.dir), before, 'domain rejection must be no-write byte-stable');
      assert.deepEqual(
        new MesSnapshotStore(fixture.dir).read().map((f) => f.fact_id),
        beforeIds,
        'unrelated durable fact IDs must be unchanged',
      );
      // Restart classification of the same durable bytes is unchanged.
      assert.deepEqual(classifyInvalidHistory(new MesSnapshotStore(fixture.dir).read()), beforeClassification);

      // The canonical fact is still admissible afterwards (no wedge / no partial write).
      layer.commit(event([s08GitFact('candidate')]));
      assert.equal(projectIntegrationState(new MesSnapshotStore(fixture.dir).read()), 'READY_TO_INTEGRATE');
    } finally {
      fixture.cleanup();
    }
  });

  test('cleanup payload inconsistent with the preceding integration fact is atomic no-write byte-stable (PO-S08-A-01)', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      const integration = s08GitFact('integration', { fact_id: 'mes:fact:git:S08:S08-A:integration:1' });
      layer.commit(event([s08Pvr(), s08Pa(), s08GitFact('candidate'), integration]));
      const before = snapshotDigest(fixture.dir);
      const beforeIds = new MesSnapshotStore(fixture.dir).read().map((f) => f.fact_id);

      // The cleanup payload must equal the preceding integration apply result.
      const inconsistent = {
        ...integration,
        fact_id: 'mes:fact:git:S08:S08-A:cleanup:1',
        git_subkind: 'cleanup' as const,
        commit_sha: 'd'.repeat(40),
      };
      assert.throws(
        () => layer.commit(event([inconsistent])),
        (err: unknown) =>
          err instanceof MesTransactionError && (err.code === 'invalid-fact' || err.code === 'binding-mismatch'),
      );
      assert.equal(snapshotDigest(fixture.dir), before, 'cleanup mismatch must be no-write byte-stable');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read().map((f) => f.fact_id), beforeIds);
    } finally {
      fixture.cleanup();
    }
  });

  test('duplicate same-cycle accepted-stage support is atomic no-write byte-stable (PO-S08-A-02)', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      const a = cohortA();
      layer.commit(event([pvr('1', 'mes:result:pv-1'), pa('1', 'mes:result:pv-1'), a.support, a.review]));
      const before = snapshotDigest(fixture.dir);
      const beforeIds = new MesSnapshotStore(fixture.dir).read().map((f) => f.fact_id);
      const beforeClassification = classifyInvalidHistory(new MesSnapshotStore(fixture.dir).read());

      // A SECOND authorizing support for the SAME Stage in the SAME cycle (both
      // bound to the current accepted generation) makes the cohort ambiguous.
      const b = cohortB();
      assert.throws(
        () => layer.commit(event([b.support, b.review])),
        (err: unknown) =>
          err instanceof MesTransactionError &&
          err.code === 'binding-mismatch' &&
          /duplicate accepted-stage support/.test(err.message),
        'a duplicate same-cycle authorizing support must be atomic no-write',
      );
      assert.equal(snapshotDigest(fixture.dir), before, 'the duplicate cohort write must be byte-stable no-write');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read().map((f) => f.fact_id), beforeIds);
      assert.deepEqual(classifyInvalidHistory(new MesSnapshotStore(fixture.dir).read()), beforeClassification);

      // A retained raw-store ambiguous cohort stays READ-ONLY auditable: the
      // status projection still fails closed typed AUTHORITY_GAP instead of
      // any projection silently deduping it or any write rewriting it.
      const raw = makeFixture();
      try {
        new MesSnapshotStore(raw.dir).write([
          pvr('1', 'mes:result:pv-1'),
          pa('1', 'mes:result:pv-1'),
          a.support,
          a.review,
          b.support,
          b.review,
        ]);
        assert.throws(
          () => projectCycleFilteredStatus(new MesSnapshotStore(raw.dir).read()),
          (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
        );
      } finally {
        raw.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('distinct cycles and legacy cohorts stay writable (PO-S08-A-02)', () => {
    // (a) A single current-cycle support cohort keeps writing.
    const single = makeFixture();
    try {
      const layer = createMesTransactionLayer(single.dir);
      const a = cohortA();
      layer.commit(event([pvr('1', 'mes:result:pv-1'), pa('1', 'mes:result:pv-1'), a.support, a.review]));
      assert.ok(new MesSnapshotStore(single.dir).read().some((f) => f.fact_id === a.support.fact_id));
    } finally {
      single.cleanup();
    }

    // (b) A DIFFERENT cycle's cohort is admitted in its own root: the rule is
    // per (stage, delivery_cycle_id) cohort, never a global one-per-stage ban.
    const other = makeFixture();
    try {
      const layer = createMesTransactionLayer(other.dir);
      const support = stageSupport('mes:fact:stage:S06:a', 'mes:result:pv-1', OTHER_CYCLE);
      const review = stageReviewResult(
        'mes:fact:result:S06:review-a',
        'mes:result:pv-1',
        support.result_ref as string,
        OTHER_CYCLE,
      );
      layer.commit(
        event([
          inCycle(pvr('1', 'mes:result:pv-1'), OTHER_CYCLE),
          inCycle(pa('1', 'mes:result:pv-1'), OTHER_CYCLE),
          support,
          review,
        ]),
      );
      assert.ok(new MesSnapshotStore(other.dir).read().some((f) => f.fact_id === support.fact_id));
    } finally {
      other.cleanup();
    }

    // (c) A retained LEGACY no-cycle cohort stays a legal cohort: an unrelated
    // delta is admitted (the ambiguity rule is not a blanket write ban).
    const legacy = makeFixture();
    try {
      new MesSnapshotStore(legacy.dir).write([legacyStageSupport('mes:fact:stage:S06:legacy-a')]);
      const before = snapshotDigest(legacy.dir);
      const result = createMesTransactionLayer(legacy.dir).commit(event([projectFact('p-legacy')]));
      assert.ok(result.materializedFactIds.includes('mes:fact:project:p-legacy'));
      assert.notEqual(snapshotDigest(legacy.dir), before);
    } finally {
      legacy.cleanup();
    }

    // (d) The SAME single-source rule closes the legacy (cycle === undefined)
    // cohort too: a duplicate no-cycle support is atomic no-write.
    const legacyDuplicate = makeFixture();
    try {
      new MesSnapshotStore(legacyDuplicate.dir).write([
        legacyStageSupport('mes:fact:stage:S06:legacy-a'),
        legacyStageSupport('mes:fact:stage:S06:legacy-b'),
      ]);
      const before = snapshotDigest(legacyDuplicate.dir);
      assert.throws(
        () => createMesTransactionLayer(legacyDuplicate.dir).commit(event([projectFact('p-legacy')])),
        (err: unknown) =>
          err instanceof MesTransactionError &&
          err.code === 'binding-mismatch' &&
          /duplicate accepted-stage support/.test(err.message),
      );
      assert.equal(snapshotDigest(legacyDuplicate.dir), before);
    } finally {
      legacyDuplicate.cleanup();
    }
  });

  test('write admission and read projection share one ambiguity rule (PO-S08-A-02)', () => {
    const fixture = makeFixture();
    try {
      const a = cohortA();
      const b = cohortB();
      new MesSnapshotStore(fixture.dir).write([
        pvr('1', 'mes:result:pv-1'),
        pa('1', 'mes:result:pv-1'),
        a.support,
        a.review,
        b.support,
        b.review,
      ]);
      const facts = new MesSnapshotStore(fixture.dir).read();

      // ONE shared rule decides the ambiguity verdict (the single source).
      const sharedMessage = duplicateAcceptedStageSupportError(facts, CYCLE);
      assert.equal(typeof sharedMessage, 'string', 'the shared rule must classify the cohort as ambiguous');
      if (typeof sharedMessage !== 'string') return;

      // Read projection: typed AUTHORITY_GAP carrying the shared verdict.
      assert.throws(
        () => projectCycleFilteredStatus(facts),
        (err: unknown) =>
          err instanceof MesStatusError && err.code === 'authority-gap' && err.message.includes(sharedMessage),
      );

      // Write admission over the SAME retained cohort: the same verdict decides.
      const before = snapshotDigest(fixture.dir);
      assert.throws(
        () => createMesTransactionLayer(fixture.dir).commit(event([projectFact('p-ambiguity')])),
        (err: unknown) =>
          err instanceof MesTransactionError &&
          err.code === 'binding-mismatch' &&
          err.message.includes(sharedMessage),
      );
      assert.equal(snapshotDigest(fixture.dir), before);
    } finally {
      fixture.cleanup();
    }
  });

  test('same fact_id may not change fact_kind or git_subkind (PO-S08-A-03)', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      layer.commit(event([s08Pvr(), s08Pa()]));
      const candidate = s08GitFact('candidate');
      layer.commit(event([candidate]));
      const before = snapshotDigest(fixture.dir);
      const beforeIds = new MesSnapshotStore(fixture.dir).read().map((f) => f.fact_id);
      const beforeClassification = classifyInvalidHistory(new MesSnapshotStore(fixture.dir).read());

      // (a) A durable fact_id may not be reused for a DIFFERENT fact_kind: the
      // semantic identity of a durable fact is (fact_id, fact_kind).
      const kindChanged: MesFactEnvelope = {
        schema_version: 2,
        fact_id: candidate.fact_id,
        fact_kind: 'project',
        created_by: 'brain',
        authority_refs: ['PRD.md#FR-003'],
      };
      assert.throws(
        () => layer.commit(event([kindChanged])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'conflict',
        'a durable fact_id may not change fact_kind',
      );
      assert.equal(snapshotDigest(fixture.dir), before, 'a fact_kind change must be byte-stable no-write');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read().map((f) => f.fact_id), beforeIds);

      // (b) A durable git fact_id may not change git_subkind either: a cleanup
      // payload may never be hung onto the candidate/integration fact_id.
      const subkindChanged = { ...candidate, git_subkind: 'integration' as const };
      assert.throws(
        () => layer.commit(event([subkindChanged])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'conflict',
        'a durable git fact_id may not change git_subkind',
      );
      assert.equal(snapshotDigest(fixture.dir), before, 'a git_subkind change must be byte-stable no-write');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read().map((f) => f.fact_id), beforeIds);
      assert.deepEqual(classifyInvalidHistory(new MesSnapshotStore(fixture.dir).read()), beforeClassification);

      // The original identity stays intact and re-readable after the refusals.
      const durable = new MesSnapshotStore(fixture.dir).read();
      const retained = durable.find((f) => f.fact_id === candidate.fact_id);
      assert.equal(retained?.fact_kind, 'git');
      assert.equal(retained?.git_subkind, 'candidate');
    } finally {
      fixture.cleanup();
    }
  });

  test('legal mutable payload update still commits (PO-S08-A-03)', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      layer.commit(event([s08Pvr(), s08Pa()]));
      const candidate = s08GitFact('candidate');
      layer.commit(event([candidate]));

      // SAME fact_id, SAME fact_kind / git_subkind, changed mutable payload:
      // the legal in-place update still commits (the guard only protects the
      // semantic identity, never legitimate Git-payload progress).
      const updated = { ...candidate, commit_sha: 'e'.repeat(40) };
      const result = layer.commit(event([updated]));
      assert.deepEqual(result.materializedFactIds, [candidate.fact_id]);
      const durable = new MesSnapshotStore(fixture.dir).read();
      assert.equal(durable.filter((f) => f.fact_id === candidate.fact_id).length, 1, 'update replaces, never duplicates');
      assert.equal(durable.find((f) => f.fact_id === candidate.fact_id)?.commit_sha, 'e'.repeat(40));
      assert.equal(projectIntegrationState(durable), 'READY_TO_INTEGRATE');
    } finally {
      fixture.cleanup();
    }
  });

  test('mutations stay in isolated fixture roots and the canonical project MES is byte-invariant in-run (PO-S08-A-04)', () => {
    // (a) Every mutation of this Task's seams is root-bound to the isolated
    //     mkdtemp fixture; no fixture may resolve to the real project tree.
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      layer.commit(event([s08Pvr(), s08Pa(), s08GitFact('candidate')]));
      assert.equal(layer.root, fixture.dir, 'the transaction layer is root-bound to the isolated fixture');
      const fixtureSnapshot = path.join(fixture.dir, '.proofloop', 'mes', 'snapshot.json');
      assert.ok(fs.existsSync(fixtureSnapshot), 'the fixture mutation must persist inside the fixture root');
      assert.ok(!fixtureSnapshot.includes('proofloopv2-wsl-herdr'), 'no fixture may resolve to the real project tree');
    } finally {
      fixture.cleanup();
    }

    // (b) The canonical project/trust root is resolved through the common `.git`
    //     directory (effective from a Slice worktree) and its bytes + fact
    //     identity are unchanged by this run.
    const pre = CANONICAL_PROJECT_MES_PRE;
    assert.equal(pre.ok, true, pre.ok ? undefined : `canonical project MES observation failed: ${pre.error}`);
    if (!pre.ok) return;
    const before = pre.observation;
    const after = observeCanonicalProjectMes();
    assert.equal(after.root, before.root, 'the canonical project/trust root must be stable across the run');
    assert.equal(fs.statSync(path.join(after.root, '.git')).isDirectory(), true, 'the canonical root must own the common .git directory');
    assert.equal(after.sha256, before.sha256, 'the canonical project MES bytes must be unchanged by this run');
    assert.equal(after.factCount, before.factCount, 'the canonical project MES fact count must be unchanged by this run');
    assert.deepEqual(after.factIds, before.factIds, 'the canonical project MES fact identity must be unchanged by this run');
  });
});
