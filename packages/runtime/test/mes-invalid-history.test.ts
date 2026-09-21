/**
 * Invalid immutable history oracle tests (S06-R-C-T01).
 *
 * # PO: contracts.md #/entities/mes-invalid-history-oracle / §2.1.4,
 * architecture.md #/entities/mes-invalid-history-oracle, acceptance
 * E2E-24 / E2E-25 / STATIC-32
 *
 * Exercises packages/runtime/src/mes/history-oracle.ts
 * (classifyInvalidHistory) on ISOLATED fixture roots only — never the real
 * `.proofloop/mes` (the frozen S06 snapshot stays byte-stable under
 * quarantine). The fixture mirrors the Sep-13 binding-mismatch-001 incident
 * context: the canonical S06 PVR/PA relation (verification_result_ref
 * `mes:result:S06:planning-verification-1`) coexists with the 7 retained
 * misbound S06-D facts that carry the typo ref
 * (`mes:result:S06:planning-verification:1`).
 *
 * Covered:
 *   - restart/rehydrate determinism: the same durable facts classify
 *     identically across a fresh store instance (byte re-read) and across
 *     repeated calls / reordered input (pure set function, no insertion
 *     order / newest-wins);
 *   - exactly the 7 misbound facts classify `relation-invalid`
 *     (non-authorizing) with a reason naming BOTH refs; the canonical
 *     relation facts classify relation-valid; facts under a missing /
 *     ambiguous canonical relation (legacy bootstrap stage, dual plan
 *     acceptance) classify `relation-unverifiable` — readable/auditable
 *     history, never authorizing, distinct from the incident's misbound set;
 *   - byte-stable no-write: classifying never mutates the durable fixture
 *     (snapshot digest unchanged), and retained misbound history is never
 *     deleted / rewritten / silently corrected / backfilled by the seam
 *     (a transaction-layer write attempt of the typo binding is atomic
 *     no-write; an appended "correction" fact does not reclassify the
 *     retained misbound facts).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyInvalidHistory } from '../dist/mes/history-oracle';
import type { MesInvalidHistoryClassification } from '../dist/mes/history-oracle';
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
// Canonical ref: dash between "verification" and "1" (the accepted-Plan relation).
const CANONICAL_REF = 'mes:result:S06:planning-verification-1';
// Typo ref: colon instead of dash — what the 7 misbound S06-D facts carried.
const TYPO_REF = 'mes:result:S06:planning-verification:1';
const BASIS: MesGitBasis = {
  head: '57183b195fca7a7f7b899164a1d50b08e03f7e60',
  branch: 'HEAD',
  worktree: '.proofloop/worktrees/S06-S06-D-post-recovery-1',
};
const BASIS_GIT: MesGitBasis = {
  head: '57183b195fca7a7f7b899164a1d50b08e03f7e60',
  branch: 'v2-herdr',
  worktree: '.',
};

const MISBOUND_FACT_IDS = [
  'mes:fact:work:S06:S06-D:post-fact-recovery-1',
  'mes:fact:task:S06-D-T01:post-fact-recovery-1',
  'mes:fact:result:S06:S06-D-T01:post-fact-recovery-1',
  'mes:fact:result:S06:S06-D:slice-ready:post-fact-recovery-1',
  'mes:fact:git:S06:S06-D:integration:post-fact-recovery-1',
  'mes:fact:git:S06:S06-D:cleanup:post-fact-recovery-1',
  'mes:fact:finding:S06:S06-D:post-fact-recovery-cv-1',
] as const;

function snapshotDigest(dir: string): string | null {
  const abs = path.join(dir, MES_SNAPSHOT_REL);
  if (!fs.existsSync(abs)) return null;
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/** Durable PLAN_READY planning_verification_result supporting an accepted Plan. */
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
      plan_digest: PLAN_DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
  };
}

/** Durable plan_acceptance promoting the same candidate. */
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
      plan_digest: PLAN_DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
  };
}

/** Accepted-bound S06-D execution fact with the given verification ref. */
function s06dFact(
  fact_id: string,
  fact_kind: MesFactEnvelope['fact_kind'],
  ref: string,
  extra: Record<string, unknown> = {},
): MesFactEnvelope {
  const task = fact_kind === 'task';
  return {
    schema_version: 2,
    fact_id,
    fact_kind,
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.3'],
    scope: {
      stage_id: 'S06',
      slice_id: 'S06-D',
      ...(task ? { task_id: 'S06-D-T01' } : {}),
    },
    work_id: 'mes:work:S06:S06-D:post-fact-recovery-1',
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: PLAN_REF,
      source_candidate_plan_ref: PLAN_REF,
      verification_result_ref: ref,
      plan_digest: PLAN_DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
    ...(task ? { task_status: 'TASK_COMPLETE', depends_on_task_ids: [] } : {}),
    ...extra,
  };
}

/** The 7 retained misbound S06-D facts (incident-exact ids + typo ref). */
function misboundFacts(): MesFactEnvelope[] {
  return [
    s06dFact('mes:fact:work:S06:S06-D:post-fact-recovery-1', 'work', TYPO_REF),
    s06dFact('mes:fact:task:S06-D-T01:post-fact-recovery-1', 'task', TYPO_REF),
    s06dFact('mes:fact:result:S06:S06-D-T01:post-fact-recovery-1', 'result', TYPO_REF, {
      result_id: 'mes:result:S06:S06-D-T01:recheck-28fbd02d8c9f4d9caa909d93ff7db240',
      result_payload_digest: 'a4d9e9d50979a26bd4bf9d3f7b71db861d81dc222d99045644b9e8a9115f8bf9',
      result_ref: 'mes:result:S06:S06-D-T01:post-fact-recovery-1',
    }),
    s06dFact('mes:fact:result:S06:S06-D:slice-ready:post-fact-recovery-1', 'result', TYPO_REF, {
      result_id: 'mes:result:S06:S06-D:slice-ready:28fbd02d8c9f4d9caa909d93ff7db240',
      result_payload_digest: 'ea518bed241001f3ba158f0f4fe42898f67f080bcfadeb50ca859f4550cc8388',
      result_ref: 'mes:result:S06:S06-D:slice-ready:post-fact-recovery-1',
    }),
    s06dFact('mes:fact:git:S06:S06-D:integration:post-fact-recovery-1', 'git', TYPO_REF, {
      git_subkind: 'integration',
      candidate_ref: 'proofloop-s06-d',
      candidate_base_ref: 'c69731511a71628d75b9b881d1e24dc9cb680e9e',
      commit_sha: 'cf7807e11f8011206d0b9618171307c2185b6b4a',
      changed_files: ['packages/runtime/src/mes/store.ts'],
    }),
    s06dFact('mes:fact:git:S06:S06-D:cleanup:post-fact-recovery-1', 'git', TYPO_REF, {
      git_subkind: 'cleanup',
      candidate_ref: 'proofloop-s06-d',
      candidate_base_ref: 'c69731511a71628d75b9b881d1e24dc9cb680e9e',
      commit_sha: 'cf7807e11f8011206d0b9618171307c2185b6b4a',
      changed_files: ['packages/runtime/src/mes/store.ts'],
    }),
    s06dFact('mes:fact:finding:S06:S06-D:post-fact-recovery-cv-1', 'finding', TYPO_REF, {
      verifier_verdict: 'PASS',
      claimed_route_code: 'IMPLEMENTATION_DEFECT',
      finding_evidence_refs: ['mes:result:S06:S06-D:post-fact-recovery-cv-1'],
      result_ref: 'mes:result:S06:S06-D:post-fact-recovery-cv-1',
    }),
  ];
}

/** Frozen-context fixture: canonical S06 PVR/PA + the 7 retained misbound facts. */
function frozenContextFixture(): MesFactEnvelope[] {
  return [pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF), ...misboundFacts()];
}

/** A relation-valid accepted-bound S06 fact (canonical ref) for control. */
function canonicalS06dWork(): MesFactEnvelope {
  return s06dFact('mes:fact:work:S06:S06-D:canonical-control', 'work', CANONICAL_REF);
}

/** Legacy bootstrap-stage support with NO plan_acceptance in the set (unverifiable). */
function legacyStageSupport(): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:stage:S01:accepted',
    fact_kind: 'stage',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.1'],
    scope: { stage_id: 'S01' },
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: 'delivery/stages/S01/plan.md',
      source_candidate_plan_ref: 'delivery/stages/S01/plan.md',
      verification_result_ref: 'bootstrap:verification:78db05a18866e0d5d165a1a27a16eb195d5c9ed9',
    },
    git_basis: BASIS,
    result_ref: 'mes:result:S01:accepted',
  };
}

/** A plan with TWO durable plan_acceptance facts (ambiguous canonical relation). */
/** S04-bound plan_acceptance (S04 has its own canonical plan). */
function s04Pa(tag: string, ref: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:plan_acceptance:S04:${tag}`,
    fact_kind: 'plan_acceptance',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.2'],
    scope: { stage_id: 'S04' },
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: 'delivery/stages/S04/plan.md',
      source_candidate_plan_ref: 'delivery/stages/S04/plan.md',
      verification_result_ref: ref,
    },
    git_basis: BASIS,
  };
}

/** A plan with TWO durable plan_acceptance facts (ambiguous canonical relation). */
function ambiguousDualPaFacts(): MesFactEnvelope[] {
  const s04Finding: MesFactEnvelope = {
    schema_version: 2,
    fact_id: 'mes:fact:finding:S04:S04-A:cv-1',
    fact_kind: 'finding',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.3'],
    scope: { stage_id: 'S04', slice_id: 'S04-A' },
    work_id: 'mes:work:S04:S04-A:cv',
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: 'delivery/stages/S04/plan.md',
      source_candidate_plan_ref: 'delivery/stages/S04/plan.md',
      verification_result_ref: 'mes:result:S04:planning-verification-7',
    },
    git_basis: BASIS,
    verifier_verdict: 'FINDINGS',
    claimed_route_code: 'IMPLEMENTATION_DEFECT',
    finding_evidence_refs: ['mes:result:S04:S04-A:cv'],
  };
  return [s04Pa('1', 'mes:result:S04:planning-verification-7'), s04Pa('2', 'mes:result:S04:planning-verification-9'), s04Finding];
}

describe('invalid immutable history oracle (S06-R-C-T01)', () => {
  test('frozen-context fixture classifies EXACTLY the 7 misbound facts relation-invalid; canonical facts relation-valid', () => {
    const fixture = frozenContextFixture();
    const classification = classifyInvalidHistory(fixture);
    assert.equal(classification.hasInvalidHistory, true);
    assert.deepEqual(classification.invalidFactIds, [...MISBOUND_FACT_IDS].sort());
    assert.equal(classification.invalidFactIds.length, 7);

    const byId = new Map(classification.facts.map((f) => [f.fact_id, f]));
    for (const id of MISBOUND_FACT_IDS) {
      const fact = byId.get(id);
      assert.ok(fact !== undefined, `misbound fact ${id} must be classified`);
      assert.equal(fact.status, 'relation-invalid', `${id} must be non-authorizing`);
      assert.ok(fact.reason !== undefined && fact.reason.includes(TYPO_REF), `reason must name the typo ref: ${fact.reason}`);
      assert.ok(fact.reason !== undefined && fact.reason.includes(CANONICAL_REF), `reason must name the canonical ref: ${fact.reason}`);
    }
    // The PA binds the accepted plan and exact-matches the canonical relation.
    assert.equal(byId.get('mes:fact:plan_acceptance:S06:1')?.status, 'relation-valid');
    // The PVR carries a CANDIDATE binding — it is the canonical relation's
    // support, not an accepted-bound consumer, so it is not binding-critical.
    assert.equal(byId.get('mes:fact:planning_verification_result:S06:1')?.status, 'not-binding-critical');
  });

  test('relation-valid accepted-bound fact coexists and stays authorizing', () => {
    const fixture = [...frozenContextFixture(), canonicalS06dWork()];
    const classification = classifyInvalidHistory(fixture);
    assert.deepEqual(classification.invalidFactIds, [...MISBOUND_FACT_IDS].sort());
    const control = classification.facts.find((f) => f.fact_id === 'mes:fact:work:S06:S06-D:canonical-control');
    assert.equal(control?.status, 'relation-valid');
  });

  test('restart/rehydrate determinism: fresh store re-read + repeated calls classify identically (E2E-25)', () => {
    // (a) Pure repeated calls over the same array.
    const fixture = frozenContextFixture();
    const first = classifyInvalidHistory(fixture);
    assert.deepEqual(classifyInvalidHistory(fixture), first, 'repeated classification must be identical');

    // (b) Byte rehydrate: the durable bytes re-parsed (fresh process re-read)
    //     must classify identically.
    const rehydrated = JSON.parse(JSON.stringify(fixture)) as MesFactEnvelope[];
    assert.deepEqual(classifyInvalidHistory(rehydrated), first, 'rehydrate must classify identically');

    // (c) Real restart: seed an isolated fixture root, then a FRESH store
    //     instance re-reads the same bytes and classifies identically. The
    //     `task` fact is excluded from the raw store seed (store.write
    //     requires an acceptedPlanTaskGraph for new task facts; the other
    //     kinds carry no such requirement and the frozen misbound facts are
    //     schema-valid retained history).
    const fixtureRoot = makeFixture();
    try {
      const store = new MesSnapshotStore(fixtureRoot.dir);
      const durable = fixture.filter((f) => f.fact_kind !== 'task');
      store.write(durable);
      const seededDigest = snapshotDigest(fixtureRoot.dir);
      assert.ok(seededDigest !== null);

      const fromFirstRead = classifyInvalidHistory(store.read());
      const fresh = new MesSnapshotStore(fixtureRoot.dir);
      const fromFreshRead = classifyInvalidHistory(fresh.read());
      assert.deepEqual(fromFreshRead, fromFirstRead, 'restart classification must be deterministic');

      // Classifying is read-only: durable bytes stay byte-stable.
      assert.equal(snapshotDigest(fixtureRoot.dir), seededDigest, 'classify must never write');
      assert.equal(fresh.read().length, durable.length, 'no fact may be materialized/dropped');
    } finally {
      fixtureRoot.cleanup();
    }
  });

  test('insertion-order independence: shuffled input classifies identically (no newest-wins)', () => {
    const fixture = frozenContextFixture();
    const expected = classifyInvalidHistory(fixture);
    const shuffled = [...fixture].reverse();
    assert.notDeepEqual(shuffled, fixture, 'shuffle must actually reorder');
    assert.deepEqual(classifyInvalidHistory(shuffled), expected, 'classification must be a pure set function');
  });

  test('CE5 regression: ambiguous dual plan_acceptance REASONS are deterministic under reversed/shuffled input (no input-order leak)', () => {
    // cv-s06-r-c2 CE5: the ambiguous-relation reason embeds the plan_acceptance
    // fact ids it saw; reversed input must not reorder them.
    const forward = classifyInvalidHistory(ambiguousDualPaFacts());
    const reversed = classifyInvalidHistory([...ambiguousDualPaFacts()].reverse());
    assert.notDeepEqual(ambiguousDualPaFacts(), [...ambiguousDualPaFacts()].reverse(), 'the shuffle must actually reorder');
    assert.deepEqual(reversed, forward, 'ambiguous dual plan_acceptance reasons must be input-order independent');
  });

  test('legacy facts under a MISSING or AMBIGUOUS canonical relation classify relation-unverifiable, not misbound', () => {
    const fixture = [
      ...frozenContextFixture(),
      legacyStageSupport(),           // S01: no plan_acceptance in the set
      ...ambiguousDualPaFacts(),      // S04: two plan_acceptance facts
    ];
    const classification = classifyInvalidHistory(fixture);
    // The incident's 7 stay the ONLY relation-invalid facts.
    assert.deepEqual(classification.invalidFactIds, [...MISBOUND_FACT_IDS].sort());
    for (const id of ['mes:fact:stage:S01:accepted', 'mes:fact:plan_acceptance:S04:1', 'mes:fact:plan_acceptance:S04:2']) {
      const fact = classification.facts.find((f) => f.fact_id === id);
      assert.equal(fact?.status, 'relation-unverifiable', `${id} must be unverifiable history`);
    }
    assert.ok(classification.unverifiableFactIds.length >= 3);
  });

  test('negative fixture: transaction-layer typo write attempt is atomic no-write byte-stable', () => {
    const fixtureRoot = makeFixture();
    try {
      // Seed ONLY the canonical relation through the real transaction layer.
      const layer = createMesTransactionLayer(fixtureRoot.dir);
      layer.commit(event([pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF)]));
      const seededDigest = snapshotDigest(fixtureRoot.dir);
      assert.ok(seededDigest !== null);

      // The typo submission (what the incident facts carried) is atomic
      // binding-mismatch: no-write, bytes stable, no fact materialized.
      const typoWork = s06dFact('mes:fact:work:S06:S06-D:post-fact-recovery-1', 'work', TYPO_REF);
      assert.throws(
        () => layer.commit(event([typoWork])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'binding-mismatch',
        'typo write attempt must fail closed as binding-mismatch',
      );
      assert.equal(snapshotDigest(fixtureRoot.dir), seededDigest, 'typo write must be no-write byte-stable');
      assert.equal(new MesSnapshotStore(fixtureRoot.dir).read().length, 2, 'no fact may be materialized');

      // Restart: a fresh layer classifies the typo identically (no retry).
      const fresh = createMesTransactionLayer(fixtureRoot.dir);
      assert.throws(
        () => fresh.commit(event([typoWork])),
        (err: unknown) => err instanceof MesTransactionError && err.code === 'binding-mismatch',
      );
      assert.equal(snapshotDigest(fixtureRoot.dir), seededDigest, 'restart attempt stays no-write byte-stable');
    } finally {
      fixtureRoot.cleanup();
    }
  });

  test('negative fixture: history surgery is rejected — retained misbound facts are never deleted, rewritten, silently corrected or reclassified by an appended correction fact', () => {
    const fixture = frozenContextFixture();
    const before = classifyInvalidHistory(fixture);
    assert.deepEqual(before.invalidFactIds, [...MISBOUND_FACT_IDS].sort());

    // (a) Silent-correct / correction-newest-wins: appending a "corrected"
    //     copy of a misbound fact (same fact_id, canonical ref) does NOT
    //     reclassify the retained misbound fact — each durable fact is
    //     classified by ITS OWN binding, never by "latest valid wins".
    // (a) Correction-newest-wins: appending a NEW corrected fact (distinct
    //     fact_id, canonical ref) must NOT reclassify the retained misbound
    //     fact — each durable fact is classified by ITS OWN binding, never
    //     by "latest valid wins".
    const correctedTwin = s06dFact('mes:fact:work:S06:S06-D:post-fact-recovery-1-corrected', 'work', CANONICAL_REF);
    const withCorrection = [...fixture, correctedTwin];
    const after = classifyInvalidHistory(withCorrection);
    const work = after.facts.find((f) => f.fact_id === 'mes:fact:work:S06:S06-D:post-fact-recovery-1');
    assert.equal(work?.status, 'relation-invalid', 'retained misbound fact stays non-authorizing');
    assert.equal(work?.reason?.includes(TYPO_REF), true, 'reason still names the retained typo ref');
    const twin = after.facts.find((f) => f.fact_id === correctedTwin.fact_id);
    assert.equal(twin?.status, 'relation-valid', 'the new corrected fact closes on its own binding');

    // (b) The retained misbound facts remain present and unmodified (never
    //     deleted / rewritten by the seam).
    const retained = new Map(frozenContextFixture().map((f) => [f.fact_id, f]));
    for (const id of MISBOUND_FACT_IDS) {
      const original = retained.get(id);
      const afterFact = after.facts.find((f) => f.fact_id === id);
      assert.ok(original !== undefined, 'retained fact must still be present in the durable set');
      assert.deepEqual(afterFact?.fact_id, original.fact_id);
      const retainedBinding = original.plan_binding;
      assert.ok(retainedBinding !== undefined && retainedBinding.binding_stage === 'accepted', 'retained fact carries an accepted binding');
      assert.equal(retainedBinding.verification_result_ref, TYPO_REF, 'retained binding is never rewritten');
    }

    // (c) Insertion order does not grant a later "valid" twin any authority:
    //     shuffling the appended-correction set keeps the SAME classification.
    assert.deepEqual(classifyInvalidHistory([...withCorrection].reverse()), after);
  });

  test('facts without an accepted plan_binding are not binding-critical and never classified invalid', () => {
    const scopeOnly: MesFactEnvelope = {
      schema_version: 2,
      fact_id: 'mes:fact:project:p1',
      fact_kind: 'project',
      created_by: 'brain',
      authority_refs: ['PRD.md#FR-003'],
      scope: { stage_id: 'S06' },
    };
    const classification = classifyInvalidHistory([...frozenContextFixture(), scopeOnly]);
    const project = classification.facts.find((f) => f.fact_id === 'mes:fact:project:p1');
    assert.equal(project?.status, 'not-binding-critical');
    assert.deepEqual(classification.invalidFactIds, [...MISBOUND_FACT_IDS].sort());
  });

  test('fail closed: non-array input is rejected', () => {
    assert.throws(() => classifyInvalidHistory(null as never), TypeError);
  });
});

function normalBinding(): MesTransactionBinding {
  return {
    execution_mode: 'NORMAL',
    authority_refs: ['tech-spec/contracts.md#2.1.3'],
    git_basis: BASIS_GIT,
  };
}

function event(facts: readonly MesFactEnvelope[]): MesSemanticEvent {
  return { facts: [...facts], binding: normalBinding() };
}
