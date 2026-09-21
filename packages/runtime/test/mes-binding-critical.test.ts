/**
 * Binding-critical identity resolution + exact-match no-write tests
 * (S06-R-B-T01).
 *
 * # PO: contracts.md #/entities/mes-binding-critical-identity / §2.1.3,
 * acceptance E2E-24 / E2E-25
 *
 * Exercises the binding-critical resolution/exact-match seam of
 * packages/runtime/src/mes/binding.ts (resolveCanonicalAcceptanceRelation /
 * exactMatchBindingCriticalIdentityError) on ISOLATED fixture roots only:
 *
 *   - canonical vs typo `verification_result_ref` exact regression: the
 *     incident pair `mes:result:S06:planning-verification-1` (canonical,
 *     dash) vs `mes:result:S06:planning-verification:1` (typo, colon) — a
 *     submitted accepted binding carrying the typo is fail-closed, the
 *     canonical binding closes;
 *   - byte-stable no-write: a rejected binding never touches the durable
 *     fixture snapshot (pre/post digest identical), and restart (a fresh
 *     store instance re-reading the same fixture) yields the SAME
 *     classification;
 *   - negative fixtures: typo / old ref / approximate ref / cross-cycle /
 *     missing / ambiguous relations are all rejected atomic/no-write, and
 *     wrong equality (ref, plan_digest) and wrong version are rejected;
 *   - retained (already-persisted) binding-critical history stays
 *     readable/auditable and is classified non-authorizing after restart.
 *
 * All tests use only temporary fixture roots (helpers.ts#makeFixture) and
 * never the real `.proofloop/mes` (the frozen S06 snapshot stays byte-stable
 * under quarantine). Imports the compiled runtime dist (built by
 * `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  resolveCanonicalAcceptanceRelation,
  exactMatchBindingCriticalIdentityError,
} from '../dist/mes/binding';
import { MesSnapshotStore, MES_SNAPSHOT_REL } from '../dist/mes/store';
import {
  createMesTransactionLayer,
  MesTransactionError,
} from '../dist/mes/transaction';
import type { MesSemanticEvent, MesTransactionBinding } from '../dist/mes/transaction';
import type { MesFactEnvelope, MesGitBasis } from '../dist/mes/types';
import { makeFixture } from './helpers';

// ---- Incident-bound fixture constants (Sep-13 binding-mismatch-001) ----
const PLAN_REF = 'delivery/stages/S06/plan.md';
const PLAN_DIGEST = '13c41263c750b2df8ebf7b8269bcec31f7b37b770d4f50db543bf061ea6fb90e';
const CYCLE = 'cycle-208cbbe8d8e946479bb746f318b56178';
const CYCLE_OTHER = 'cycle-1111111111111111111111111111111111111111';
// Canonical ref: dash between "verification" and "1" (the accepted-Plan relation).
const CANONICAL_REF = 'mes:result:S06:planning-verification-1';
// Typo ref: colon instead of dash — what the 7 misbound S06-D facts carried.
const TYPO_REF = 'mes:result:S06:planning-verification:1';
const BASIS: MesGitBasis = {
  head: 'c69731511a71628d75b9b881d1e24dc9cb680e9e',
  branch: 'v2-subagent',
  worktree: '.',
};

function snapshotDigest(dir: string): string | null {
  const abs = path.join(dir, MES_SNAPSHOT_REL);
  if (!fs.existsSync(abs)) return null;
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/** Durable PLAN_READY planning_verification_result supporting an accepted Plan. */
function pvr(tag: string, ref: string, digest = PLAN_DIGEST, cycle = CYCLE): MesFactEnvelope {
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
      plan_digest: digest,
      delivery_cycle_id: cycle,
    },
    git_basis: BASIS,
  };
}

/** Durable plan_acceptance promoting the same candidate. */
function pa(tag: string, ref: string, digest = PLAN_DIGEST, cycle = CYCLE): MesFactEnvelope {
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
      plan_digest: digest,
      delivery_cycle_id: cycle,
    },
    git_basis: BASIS,
  };
}

/** Execute-bound accepted fact (S06-D post-fact-recovery pattern). */
function workFact(id: string, ref: string, cycle = CYCLE, digest = PLAN_DIGEST): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:work:${id}`,
    fact_kind: 'work',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.3'],
    scope: { stage_id: 'S06', slice_id: 'S06-D', task_id: 'S06-D-T01' },
    work_id: `mes:work:${id}`,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: PLAN_REF,
      source_candidate_plan_ref: PLAN_REF,
      verification_result_ref: ref,
      plan_digest: digest,
      delivery_cycle_id: cycle,
    },
    git_basis: BASIS,
  };
}

describe('binding-critical identity resolution + exact-match (S06-R-B-T01)', () => {
  test('canonical relation resolves uniquely from the durable set (no insertion-order dependence)', () => {
    const durable = [pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF)];
    // Shuffle the array: resolution must be deterministic over the fact SET,
    // never over insertion order / fact filename / newest-wins.
    const shuffled = [pa('1', CANONICAL_REF), pvr('1', CANONICAL_REF)];
    for (const facts of [durable, shuffled]) {
      const resolution = resolveCanonicalAcceptanceRelation(facts, PLAN_REF);
      assert.equal(resolution.ok, true, 'canonical relation must resolve');
      if (resolution.ok) {
        assert.equal(resolution.canonical.verification_result_ref, CANONICAL_REF);
        assert.equal(resolution.canonical.accepted_plan_ref, PLAN_REF);
        assert.equal(resolution.canonical.source_candidate_plan_ref, PLAN_REF);
        assert.equal(resolution.canonical.plan_digest, PLAN_DIGEST);
        assert.equal(resolution.canonical.delivery_cycle_id, CYCLE);
        assert.equal(resolution.canonical.acceptance_fact_id, 'mes:fact:plan_acceptance:S06:1');
        assert.equal(resolution.canonical.verification_fact_id, 'mes:fact:planning_verification_result:S06:1');
      }
    }
  });

  test('canonical vs typo verification_result_ref: canonical closes, typo is atomic fail-closed (incident regression)', () => {
    const durable = [pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF)];
    const resultingSet = [...durable, workFact('S06:S06-D:post-fact-recovery-1', CANONICAL_REF)];

    // The canonical binding closes (exact-match → undefined).
    const canonicalWork = workFact('S06:S06-D:post-fact-recovery-1', CANONICAL_REF);
    assert.equal(exactMatchBindingCriticalIdentityError(resultingSet, canonicalWork), undefined);

    // The typo binding (`:1` vs `-1` — what the 7 misbound facts carried) is
    // rejected with a fail-closed message naming BOTH refs.
    const typoWork = workFact('S06:S06-D:post-fact-recovery-1', TYPO_REF);
    const err = exactMatchBindingCriticalIdentityError([...durable, typoWork], typoWork);
    assert.ok(err !== undefined, 'typo ref must not close');
    assert.ok(err.includes(TYPO_REF), `message must name the submitted typo ref: ${err}`);
    assert.ok(err.includes(CANONICAL_REF), `message must name the canonical ref: ${err}`);
  });

  test('no-write byte-stable: a rejected binding leaves the durable fixture digest unchanged; restart classifies identically (E2E-25)', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      store.write([pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF)]);
      const preDigest = snapshotDigest(fixture.dir);
      assert.ok(preDigest !== null, 'seed snapshot must exist');
      const durable = store.read();
      assert.equal(durable.length, 2);

      // The misbound submission is classified ON the resulting set; the
      // rejected binding must not touch the durable fixture (no-write).
      const typoWork = workFact('S06:S06-D:post-fact-recovery-1', TYPO_REF);
      const err = exactMatchBindingCriticalIdentityError([...durable, typoWork], typoWork);
      assert.ok(err !== undefined, 'typo binding must be rejected');
      assert.equal(snapshotDigest(fixture.dir), preDigest, 'rejected binding must not change snapshot bytes');
      assert.equal(store.read().length, 2, 'no fact may be materialized');

      // restart: a FRESH store instance re-reads the same durable facts and
      // yields the SAME classification (canonical closes, typo rejected).
      const fresh = new MesSnapshotStore(fixture.dir).read();
      assert.equal(fresh.length, 2);
      assert.equal(
        exactMatchBindingCriticalIdentityError([...fresh, typoWork], typoWork),
        err,
        'restart must classify identically (same message)',
      );
      assert.equal(
        exactMatchBindingCriticalIdentityError([...fresh, canonicalWork()], canonicalWork()),
        undefined,
        'restart must still accept the canonical binding',
      );
      function canonicalWork(): MesFactEnvelope {
        return workFact('S06:S06-D:post-fact-recovery-1', CANONICAL_REF);
      }
      assert.equal(snapshotDigest(fixture.dir), preDigest, 'restart must not write either');
    } finally {
      fixture.cleanup();
    }
  });

  test('retained misbound history stays readable/auditable and non-authorizing after restart', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      // The incident retained the 7 misbound S06-D facts DURABLY (readable /
      // auditable) besides the canonical PVR/PA relation. The seam treats
      // them as non-authorizing without deleting / rewriting / correcting.
      store.write([pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF)]);
      const preDigest = snapshotDigest(fixture.dir);
      const durable = store.read();

      const misbound = workFact('S06:S06-D:post-fact-recovery-misbound-history', TYPO_REF);
      const err = exactMatchBindingCriticalIdentityError([...durable, misbound], misbound);
      assert.ok(err !== undefined, 'misbound history must be non-authorizing');
      assert.equal(snapshotDigest(fixture.dir), preDigest, 'classification must not rewrite retained history');
      // restart keeps the same durable facts byte-identical and the same
      // non-authorizing classification.
      const fresh = new MesSnapshotStore(fixture.dir).read();
      assert.equal(fresh.length, 2);
      assert.equal(
        exactMatchBindingCriticalIdentityError([...fresh, misbound], misbound),
        err,
        'restart classification must be deterministic',
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('negative fixture: missing verified support and missing plan acceptance both fail closed', () => {
    // No durable PVR resolves the referenced ref → missing support.
    const noPvr = [pa('1', CANONICAL_REF)];
    const missingSupport = resolveCanonicalAcceptanceRelation(noPvr, PLAN_REF);
    assert.equal(missingSupport.ok, false);
    if (!missingSupport.ok) assert.ok(missingSupport.error.includes('missing support'), missingSupport.error);

    // No plan_acceptance binds the accepted Plan at all.
    const noPa = [pvr('1', CANONICAL_REF)];
    const missingRelation = resolveCanonicalAcceptanceRelation(noPa, PLAN_REF);
    assert.equal(missingRelation.ok, false);
    if (!missingRelation.ok) assert.ok(missingRelation.error.includes('missing'), missingRelation.error);

    // A submitted fact under a plan with no durable acceptance is rejected.
    const typoWork = workFact('S06:S06-D:post-fact-recovery-1', CANONICAL_REF);
    const err = exactMatchBindingCriticalIdentityError([pvr('1', CANONICAL_REF), typoWork], typoWork);
    assert.ok(err !== undefined && err.includes('no durable plan_acceptance fact'), err ?? '');
  });

  test('negative fixture: ambiguous plan_acceptance / ambiguous verification support fail closed', () => {
    const durable = [pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF)];
    // A second plan_acceptance fact binds the SAME accepted Plan → ambiguous.
    const twoPa = [pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF), pa('2', CANONICAL_REF)];
    const ambiguousPa = resolveCanonicalAcceptanceRelation(twoPa, PLAN_REF);
    assert.equal(ambiguousPa.ok, false);
    if (!ambiguousPa.ok) assert.ok(ambiguousPa.error.includes('ambiguous'), ambiguousPa.error);

    // Two PVR facts sharing the SAME result_ref → ambiguous support.
    const twoPvr = [pvr('1', CANONICAL_REF), pvr('2', CANONICAL_REF), pa('1', CANONICAL_REF)];
    const ambiguousSupport = resolveCanonicalAcceptanceRelation(twoPvr, PLAN_REF);
    assert.equal(ambiguousSupport.ok, false);
    if (!ambiguousSupport.ok) assert.ok(ambiguousSupport.error.includes('ambiguous'), ambiguousSupport.error);

    // Both must stay disconnected from the submitted binding (no-write).
    const work = workFact('S06:S06-D:post-fact-recovery-1', CANONICAL_REF);
    const submittedErr = exactMatchBindingCriticalIdentityError([...twoPvr, work], work);
    assert.ok(submittedErr !== undefined && submittedErr.includes('ambiguous'), submittedErr ?? '');
  });

  test('negative fixture: old ref / approximate ref / wrong version / wrong equality are all rejected', () => {
    const durable = [pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF)];
    // Old ref (a different canonical value) — rejected.
    const oldRef = workFact('S06:S06-D:post-old-ref', `mes:result:S05:planning-verification-1`);
    const oldErr = exactMatchBindingCriticalIdentityError([...durable, oldRef], oldRef);
    assert.ok(oldErr !== undefined && oldErr.includes('EXACTLY'), oldErr ?? '');
    // Approximate ref (close but not byte-equal: double dash / trailing char) — rejected.
    for (const approx of [
      'mes:result:S06:planning-verification--1',
      'mes:result:S06:planning-verification-11',
      'mes:result:S06:planning-verification:1 ',
    ]) {
      const f = workFact('S06:S06-D:post-approx', approx);
      const e = exactMatchBindingCriticalIdentityError([...durable, f], f);
      assert.ok(e !== undefined, `approx ref ${approx} must be rejected`);
    }
    // Wrong version: same ref but a different plan_digest → rejected.
    const wrongDigest = workFact('S06:S06-D:post-wrong-version', CANONICAL_REF, CYCLE, 'f'.repeat(64));
    const wrongVersionErr = exactMatchBindingCriticalIdentityError([...durable, wrongDigest], wrongDigest);
    assert.ok(wrongVersionErr !== undefined && wrongVersionErr.includes('plan_digest'), wrongVersionErr ?? '');
  });

  test('negative fixture: cross-cycle delivery_cycle_id is rejected atomic no-write', () => {
    const durable = [pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF)];
    const crossCycle = workFact('S06:S06-D:post-cross-cycle', CANONICAL_REF, CYCLE_OTHER);
    const err = exactMatchBindingCriticalIdentityError([...durable, crossCycle], crossCycle);
    assert.ok(err !== undefined, 'cross-cycle binding must be rejected');
    assert.ok(err.includes('delivery_cycle_id'), err);
    assert.ok(err.includes(CYCLE_OTHER) && err.includes(CYCLE), 'message must name both cycles');
  });

  test('facts without an accepted plan_binding pass the exact-match gate (their own kind rules still apply)', () => {
    const durable = [pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF)];
    const scopeOnly: MesFactEnvelope = {
      schema_version: 2,
      fact_id: 'mes:fact:project:p1',
      fact_kind: 'project',
      created_by: 'brain',
      authority_refs: ['PRD.md#FR-003'],
      scope: { stage_id: 'S06' },
    };
    assert.equal(exactMatchBindingCriticalIdentityError([...durable, scopeOnly], scopeOnly), undefined);
  });
});

describe('combined A+B transaction seam: exact-match gate at the canonical durable boundary (EXACT_MATCH_GATE_UNWIRED repair)', () => {
  function normalBinding(): MesTransactionBinding {
    return {
      execution_mode: 'NORMAL',
      authority_refs: ['tech-spec/contracts.md#2.1.3'],
      git_basis: BASIS,
    };
  }

  function event(facts: readonly MesFactEnvelope[]): MesSemanticEvent {
    return { facts: [...facts], binding: normalBinding() };
  }

  test('real transaction write attempt: canonical accepted-bound work commits; typo verification_result_ref is atomic binding-mismatch no-write byte-stable (incident regression)', () => {
    const fixture = makeFixture();
    try {
      // Seed the canonical PVR/PA relation through the REAL transaction layer.
      const layer = createMesTransactionLayer(fixture.dir);
      layer.commit(event([pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF)]));
      const seededDigest = snapshotDigest(fixture.dir);
      assert.ok(seededDigest !== null, 'canonical seed must be durable');

      // The canonical accepted-bound work fact exact-matches and materializes.
      const canonicalWork = workFact('S06:S06-D:post-fact-recovery-1', CANONICAL_REF);
      const ok = layer.commit(event([canonicalWork]));
      assert.deepEqual(ok.materializedFactIds, ['mes:fact:work:S06:S06-D:post-fact-recovery-1']);
      const canonicalDigest = snapshotDigest(fixture.dir);

      // The typo write attempt (`:1` vs `-1` — what the 7 misbound S06-D facts
      // carried) is atomic binding-mismatch: no-write, snapshot bytes stable.
      const typoWork = workFact('S06:S06-D:post-fact-recovery-1', TYPO_REF);
      assert.throws(
        () => layer.commit(event([typoWork])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'binding-mismatch',
        'typo write attempt must fail closed as binding-mismatch',
      );
      assert.equal(snapshotDigest(fixture.dir), canonicalDigest, 'typo write must be no-write byte-stable');
      assert.equal(new MesSnapshotStore(fixture.dir).read().length, 3, 'no fact may be materialized');

      // Restart: a FRESH layer re-reads the same durable set and classifies
      // identically (canonical closes, typo rejected) with no writes.
      const fresh = createMesTransactionLayer(fixture.dir);
      assert.throws(
        () => fresh.commit(event([typoWork])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'binding-mismatch',
        'restart must classify the typo identically',
      );
      assert.equal(snapshotDigest(fixture.dir), canonicalDigest, 'restart attempt stays no-write byte-stable');
    } finally {
      fixture.cleanup();
    }
  });

  test('real transaction write attempts: old / approximate / cross-cycle / missing / ambiguous bindings all fail closed atomic no-write', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      layer.commit(event([pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF)]));
      const preDigest = snapshotDigest(fixture.dir);

      const bad: MesFactEnvelope[] = [
        // Old ref (a different canonical value) — rejected.
        workFact('S06:S06-D:post-old-ref', 'mes:result:S05:planning-verification-1'),
        // Approximate ref (close but not byte-equal) — rejected.
        workFact('S06:S06-D:post-approx', 'mes:result:S06:planning-verification--1'),
        // Cross-cycle delivery_cycle_id — rejected.
        workFact('S06:S06-D:post-cross-cycle', CANONICAL_REF, CYCLE_OTHER),
        // Missing support: ref that resolves to no durable PVR — rejected.
        workFact('S06:S06-D:post-missing', 'mes:result:S06:no-such-pvr'),
        // Ambiguous: a SECOND plan_acceptance binds the same accepted Plan —
        // unique canonical resolution required, rejected.
        pa('2', CANONICAL_REF),
      ];
      for (const fact of bad) {
        assert.throws(
          () => layer.commit(event([fact])),
          (err: unknown) => err instanceof MesTransactionError && err.code === 'binding-mismatch',
          `submitted ${fact.fact_id} must fail closed as binding-mismatch`,
        );
        assert.equal(snapshotDigest(fixture.dir), preDigest, `rejected ${fact.fact_id} must be no-write byte-stable`);
      }
      assert.equal(new MesSnapshotStore(fixture.dir).read().length, 2, 'no rejected fact may be materialized');

      // Restart: a fresh layer re-reads the same durable facts and yields the
      // same non-authorizing classification for every rejected identity.
      const fresh = createMesTransactionLayer(fixture.dir);
      for (const fact of bad) {
        assert.throws(
          () => fresh.commit(event([fact])),
          (err: unknown) => err instanceof MesTransactionError && err.code === 'binding-mismatch',
          `restart must keep rejecting ${fact.fact_id}`,
        );
        assert.equal(snapshotDigest(fixture.dir), preDigest, 'restart classification must stay no-write byte-stable');
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('real transaction write attempt: MISSING plan_acceptance (unique current-cycle PVR, no PA) is atomic binding-mismatch no-write byte-stable (EXACT_MATCH_GATE_BYPASS_MISSING_OR_WRONG_PLAN counterexample)', () => {
    const fixture = makeFixture();
    try {
      // A unique current-cycle PVR exists but NO plan_acceptance binds the plan.
      const layer = createMesTransactionLayer(fixture.dir);
      layer.commit(event([pvr('1', CANONICAL_REF)]));
      const pvrOnlyDigest = snapshotDigest(fixture.dir);
      assert.ok(pvrOnlyDigest !== null, 'PVR-only seed must be durable');

      // The accepted-bound work fact must NOT be persisted without a matching
      // durable plan_acceptance: exact resolution finds zero acceptances →
      // binding-mismatch no-write (the round-1 guard skipped this case).
      const canonicalWork = workFact('S06:S06-D:post-fact-recovery-1', CANONICAL_REF);
      assert.throws(
        () => layer.commit(event([canonicalWork])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'binding-mismatch',
        'missing-PA write attempt must fail closed as binding-mismatch',
      );
      assert.equal(snapshotDigest(fixture.dir), pvrOnlyDigest, 'missing-PA write must be no-write byte-stable');
      assert.equal(new MesSnapshotStore(fixture.dir).read().length, 1, 'no fact may be materialized');

      // Restart: a fresh layer re-reads the same durable set and classifies identically.
      const fresh = createMesTransactionLayer(fixture.dir);
      assert.throws(
        () => fresh.commit(event([canonicalWork])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'binding-mismatch',
        'restart must classify the missing-PA write identically',
      );
      assert.equal(snapshotDigest(fixture.dir), pvrOnlyDigest, 'restart stays no-write byte-stable');
    } finally {
      fixture.cleanup();
    }
  });

  test('real transaction write attempt: WRONG/OLD accepted Plan (accepted_plan_ref points at old S05 while durable canonical binds S06) is atomic binding-mismatch no-write byte-stable (EXACT_MATCH_GATE_BYPASS_MISSING_OR_WRONG_PLAN counterexample)', () => {
    const fixture = makeFixture();
    try {
      // Canonical S06 PVR+PA relation is durable.
      const layer = createMesTransactionLayer(fixture.dir);
      layer.commit(event([pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF)]));
      const canonicalDigest = snapshotDigest(fixture.dir);
      assert.ok(canonicalDigest !== null, 'canonical seed must be durable');

      // The submitted accepted-bound fact claims the OLD S05 Plan: exact
      // resolution for that accepted_plan_ref finds no matching durable PA →
      // binding-mismatch no-write (the round-1 guard skipped this case).
      const oldPlanWork: MesFactEnvelope = {
        ...workFact('S06:S06-D:post-old-plan', CANONICAL_REF),
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: 'delivery/stages/S05/plan.md',
          source_candidate_plan_ref: 'delivery/stages/S05/plan.md',
          verification_result_ref: CANONICAL_REF,
          plan_digest: PLAN_DIGEST,
          delivery_cycle_id: CYCLE,
        },
      };
      assert.throws(
        () => layer.commit(event([oldPlanWork])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'binding-mismatch',
        'wrong/old accepted Plan write attempt must fail closed as binding-mismatch',
      );
      assert.equal(snapshotDigest(fixture.dir), canonicalDigest, 'wrong-old-Plan write must be no-write byte-stable');
      assert.equal(new MesSnapshotStore(fixture.dir).read().length, 2, 'no fact may be materialized');

      // Restart: a fresh layer re-reads the same durable set and classifies identically.
      const fresh = createMesTransactionLayer(fixture.dir);
      assert.throws(
        () => fresh.commit(event([oldPlanWork])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'binding-mismatch',
        'restart must classify the wrong-old-Plan write identically',
      );
      assert.equal(snapshotDigest(fixture.dir), canonicalDigest, 'restart stays no-write byte-stable');
    } finally {
      fixture.cleanup();
    }
  });
});