/**
 * Invalid immutable history → status completion consumer tests (S06-R-C-T02).
 *
 * # PO: contracts.md #/entities/mes-invalid-history-oracle / §2.1.4,
 * architecture.md #/entities/mes-invalid-history-oracle, acceptance
 * E2E-24 / E2E-25 / STATIC-32
 *
 * Exercises packages/runtime/src/mes/status.ts (projectExecuteDetail +
 * projectCycleFilteredStatus) consuming the invalid immutable history oracle
 * (history-oracle.ts) on ISOLATED fixture roots only — never the real
 * `.proofloop/mes` (the frozen S06 snapshot stays byte-stable under
 * quarantine). The fixture mirrors the Sep-13 binding-mismatch-001 incident
 * context: the canonical S06 PVR/PA relation exists
 * (`mes:result:S06:planning-verification-1`) while the 7 retained S06-D
 * facts carry the typo ref (`mes:result:S06:planning-verification:1`).
 *
 * Covered:
 *   - projectExecuteDetail: the S06-D slice driven ONLY by the 7 misbound
 *     facts never projects INTEGRATED / CLEANED / READY_TO_INTEGRATE /
 *     SLICE_CANDIDATE_READY (it falls to EXECUTING); the durable refs stay
 *     readable/auditable; a positive control with the SAME facts on the
 *     canonical ref closes CLEANED (the gate is invalid-history-specific);
 *   - restart/re-hydrate: a fresh store instance re-reading the same bytes
 *     and repeated calls yield the IDENTICAL non-authorizing output, with no
 *     writes;
 *   - projectCycleFilteredStatus: the frozen-context fixture observes the
 *     in-flight EXECUTE phase (never STAGE_ACCEPTED), and an accepted-stage
 *     support that is itself misbound cannot drive STAGE_ACCEPTED (negative
 *     fixture), while the canonical support closes STAGE_ACCEPTED;
 *   - status stays a read-only projection: input is never mutated and the
 *     output never carries next_action / route / reasoning fields.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  projectExecuteDetail,
  projectCycleFilteredStatus,
  projectTerminalDetail,
  projectTerminalAdjunct,
  MesStatusError,
} from '../dist/mes/status';
import type { MesExecuteDetail } from '../dist/mes/status';
import { MesSnapshotStore, MES_SNAPSHOT_REL } from '../dist/mes/store';
import type { MesFactEnvelope, MesGitBasis } from '../dist/mes/types';
import { makeFixture } from './helpers';

// ---- Incident-bound fixture constants (Sep-13 binding-mismatch-001) ----
const PLAN_REF = 'delivery/stages/S06/plan.md';
const PLAN_DIGEST = '13c41263c750b2df8ebf7b8269bcec31f7b37b770d4f50db543bf061ea6fb90e';
const CYCLE = 'cycle-208cbbe8d8e946479bb746f318b56178';
const CANONICAL_REF = 'mes:result:S06:planning-verification-1';
const TYPO_REF = 'mes:result:S06:planning-verification:1';
const BASIS: MesGitBasis = {
  head: '57183b195fca7a7f7b899164a1d50b08e03f7e60',
  branch: 'HEAD',
  worktree: '.proofloop/worktrees/S06-S06-D-post-recovery-1',
};

const FORBIDDEN_STATES = ['INTEGRATED', 'CLEANED', 'READY_TO_INTEGRATE', 'SLICE_CANDIDATE_READY'];

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

/** The SAME 7 S06-D facts on the canonical ref (positive control). */
function canonicalS06dFacts(): MesFactEnvelope[] {
  return misboundFacts().map((fact) => {
    const { plan_binding: binding, ...rest } = fact;
    return {
      ...rest,
      plan_binding: { ...binding!, verification_result_ref: CANONICAL_REF },
    };
  });
}

/** Stage-only Review work fact (S06-bound, accepted). */
function reviewWorkFact(): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:work:S06:stage-review:1',
    fact_kind: 'work',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.2'],
    scope: { stage_id: 'S06' },
    work_id: 'mes:work:S06:review:1',
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: PLAN_REF,
      source_candidate_plan_ref: PLAN_REF,
      verification_result_ref: CANONICAL_REF,
      plan_digest: PLAN_DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
  };
}

/** Accepted-stage support fact (S06-bound) with the given verification ref. */
function acceptedStageSupport(ref: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:stage:S06:accepted',
    fact_kind: 'stage',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.1'],
    scope: { stage_id: 'S06' },
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: PLAN_REF,
      source_candidate_plan_ref: PLAN_REF,
      verification_result_ref: ref,
      plan_digest: PLAN_DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
    result_ref: 'mes:result:S06:stage-review-1',
  };
}

/** Current-cycle PROJECT_READY terminal fact (planned Stage set + cycle identity). */
function projectReadyTerminal(planned: string[], factId = 'mes:fact:project_ready:S06:cycle'): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: factId,
    fact_kind: 'project_ready',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
    planned_stage_ids: planned,
    delivery_cycle_id: CYCLE,
    git_basis: BASIS,
  };
}

function allKeys(value: unknown, root = ''): string[] {
  if (typeof value !== 'object' || value === null) return [];
  const out: string[] = [];
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const next = root ? `${root}.${key}` : key;
    out.push(next);
    out.push(...allKeys(val, next));
  }
  return out;
}

describe('invalid immutable history → status completion consumer (S06-R-C-T02)', () => {
  test('frozen-context fixture: S06-D slice NEVER projects INTEGRATED/CLEANED/READY_TO_INTEGRATE/SLICE_CANDIDATE_READY; falls to EXECUTING; durable refs stay readable', () => {
    const detail: MesExecuteDetail = projectExecuteDetail(frozenContextFixture());
    const slice = detail.slices.find((s) => s.slice_id === 'S06-D');
    assert.ok(slice !== undefined, 'S06-D slice must be projected');
    assert.equal(FORBIDDEN_STATES.includes(slice.state), false, `state must not be a completion state: ${slice.state}`);
    assert.equal(slice.state, 'EXECUTING', 'only the in-flight fallback may project');
    // Durable refs stay readable/auditable (the history is never hidden).
    assert.equal(slice.integration_ref, 'proofloop-s06-d', 'integration ref stays readable');
    assert.equal(slice.candidate_ref, undefined, 'no candidate git fact exists');
    assert.equal(slice.latest_finding_ref, 'mes:fact:finding:S06:S06-D:post-fact-recovery-cv-1');
    assert.equal(slice.latest_result_ref, 'mes:result:S06:S06-D:slice-ready:post-fact-recovery-1');
  });

  test('positive control: the SAME S06-D facts on the canonical ref close CLEANED (gate is invalid-history-specific)', () => {
    const facts = [pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF), ...canonicalS06dFacts()];
    const detail: MesExecuteDetail = projectExecuteDetail(facts);
    const slice = detail.slices.find((s) => s.slice_id === 'S06-D');
    assert.ok(slice !== undefined);
    assert.equal(slice.state, 'CLEANED', 'canonical cleanup fact must authorize CLEANED');
  });

  test('restart/rehydrate: fresh store re-read + repeated calls yield the SAME non-authorizing output; read-only no-write', () => {
    const fixture = frozenContextFixture();
    // (a) Pure repeated calls over the same array.
    const first = projectExecuteDetail(fixture);
    assert.deepEqual(projectExecuteDetail(fixture), first);

    // (b) Byte rehydrate (fresh process re-read of the same durable bytes).
    const rehydrated = JSON.parse(JSON.stringify(fixture)) as MesFactEnvelope[];
    assert.deepEqual(projectExecuteDetail(rehydrated), first);

    // (c) Real restart through a fresh store instance; the `task` fact is
    //     excluded from the raw store seed (store.write requires an
    //     acceptedPlanTaskGraph for new task facts).
    const fixtureRoot = makeFixture();
    try {
      const store = new MesSnapshotStore(fixtureRoot.dir);
      const durable = fixture.filter((f) => f.fact_kind !== 'task');
      store.write(durable);
      const seededDigest = snapshotDigest(fixtureRoot.dir);
      assert.ok(seededDigest !== null);

      const fromFirstRead = projectExecuteDetail(store.read());
      const fresh = new MesSnapshotStore(fixtureRoot.dir);
      const fromFreshRead = projectExecuteDetail(fresh.read());
      assert.deepEqual(fromFreshRead, fromFirstRead, 'restart projection must be deterministic');
      assert.equal(snapshotDigest(fixtureRoot.dir), seededDigest, 'projection must never write');
      assert.equal(fresh.read().length, durable.length, 'no fact may be materialized/dropped');
    } finally {
      fixtureRoot.cleanup();
    }
  });

  test('projectCycleFilteredStatus on the frozen-context fixture: in-flight EXECUTE phase, never STAGE_ACCEPTED; deterministic across restart', () => {
    const fixture = frozenContextFixture();
    const status = projectCycleFilteredStatus(fixture);
    assert.equal(status.cycle_id, CYCLE);
    assert.equal(status.scope, 'S06');
    assert.equal(status.phase, 'EXECUTE', 'misbound execution facts keep the stage in-flight');
    assert.equal(['STAGE_ACCEPTED'].includes(status.phase), false, 'invalid history must not project Stage completion');
    assert.equal(status.required_skill, 'proofloop-execute');

    // Restart determinism for the cycle-filtered projection.
    assert.deepEqual(projectCycleFilteredStatus(JSON.parse(JSON.stringify(fixture))), status);
    assert.deepEqual(projectCycleFilteredStatus([...fixture].reverse()), status);
  });

  test('negative fixture: an accepted-stage support that is ITSELF misbound cannot drive STAGE_ACCEPTED; the canonical support closes it', () => {
    // The SAME same-cycle cohort: canonical PVR/PA + stage-only review work +
    // an accepted-stage support. With the CANONICAL ref the stage closes
    // STAGE_ACCEPTED; with the TYPO ref the support is relation-invalid and
    // must not authorize Stage completion (the stage stays in-flight).
    const base = [pvr('1', CANONICAL_REF), pa('1', CANONICAL_REF), reviewWorkFact()];

    const canonical = projectCycleFilteredStatus([...base, acceptedStageSupport(CANONICAL_REF)]);
    assert.equal(canonical.phase, 'STAGE_ACCEPTED', 'canonical support must close STAGE_ACCEPTED');

    const misbound = projectCycleFilteredStatus([...base, acceptedStageSupport(TYPO_REF)]);
    assert.equal(misbound.phase !== 'STAGE_ACCEPTED', true, 'misbound support must not authorize Stage completion');
    assert.equal(misbound.phase, 'REVIEW', 'the stage stays in-flight on its remaining valid same-cycle facts');
    assert.equal(misbound.scope, 'S06');
  });

  test('status stays a read-only projection: input never mutated; output carries no next_action/route/reasoning', () => {
    const fixture = frozenContextFixture();
    const snapshot = JSON.parse(JSON.stringify(fixture));
    const detail = projectExecuteDetail(fixture);
    assert.deepEqual(JSON.parse(JSON.stringify(fixture)), snapshot, 'projection must not mutate its input');
    const keys = allKeys(detail);
    for (const forbidden of ['next_action', 'next_task_id', 'route', 'reasoning', 'accepted_route_code']) {
      assert.equal(keys.includes(forbidden), false, `output must not contain "${forbidden}"`);
    }
  });

  // ---- (cv-s06-r-c2) terminal completion consumers (CE3/CE4) ----

  test('negative fixture (CE3): projectTerminalDetail with canonical PVR/PA plus TYPO accepted-stage support fails closed — never project_ready=true/exact_closure=true', () => {
    // The typo support is relation-invalid (canonical PVR/PA resolve, the
    // support's binding-critical identity deviates), so it can NEVER
    // authorize terminal completion: the current-cycle terminal cannot close
    // against the authorizing support cohort and the projection fails closed
    // typed.
    const facts = [
      pvr('1', CANONICAL_REF),
      pa('1', CANONICAL_REF),
      acceptedStageSupport(TYPO_REF),
      projectReadyTerminal(['S06']),
    ];
    assert.throws(
      () => projectTerminalDetail(facts),
      (err: unknown) => err instanceof MesStatusError &&
        err.message.includes('has no durable accepted-stage support'),
      'a typo (relation-invalid) accepted-stage support must never close the terminal',
    );
  });

  test('positive control (CE3): the CANONICAL accepted-stage support closes project_ready=true/exact_closure=true', () => {
    const facts = [
      pvr('1', CANONICAL_REF),
      pa('1', CANONICAL_REF),
      acceptedStageSupport(CANONICAL_REF),
      projectReadyTerminal(['S06']),
    ];
    const view = projectTerminalDetail(facts);
    assert.equal(view.project_ready, true);
    assert.deepEqual(view.planned_stage_ids, ['S06']);
    assert.deepEqual(view.accepted_stage_support_ids, ['S06']);
    assert.equal(view.exact_closure, true);
  });

  test('negative fixture (CE4): projectTerminalAdjunct with a TYPO accepted-stage support fails closed — never CURRENT_PROJECT_READY', () => {
    // Same relation-invalid support: the adjunct currentness oracle cannot
    // validate the current-cycle terminal against authorizing supports.
    const facts = [
      pvr('1', CANONICAL_REF),
      pa('1', CANONICAL_REF),
      acceptedStageSupport(TYPO_REF),
      projectReadyTerminal(['S06']),
    ];
    assert.throws(
      () => projectTerminalAdjunct(facts),
      MesStatusError,
      'a typo support must never project CURRENT_PROJECT_READY',
    );
  });

  test('positive control (CE4): projectTerminalAdjunct projects CURRENT_PROJECT_READY on the canonical support', () => {
    const facts = [
      pvr('1', CANONICAL_REF),
      pa('1', CANONICAL_REF),
      acceptedStageSupport(CANONICAL_REF),
      projectReadyTerminal(['S06']),
    ];
    const adjunct = projectTerminalAdjunct(facts);
    assert.deepEqual(adjunct, {
      state: 'CURRENT_PROJECT_READY',
      project_ready: true,
      project_ready_ref: 'mes:fact:project_ready:S06:cycle',
      delivery_cycle_id: CYCLE,
      planned_stage_ids: ['S06'],
      accepted_stage_support_ids: ['S06'],
      exact_closure: true,
    });
  });

  // ---- (cv-s06-r-c2) missing / ambiguous plan_acceptance relations (CE1/CE2) ----

  test('negative fixture (CE1): accepted-bound execution facts with NO plan_acceptance are relation-unverifiable and never authorize Slice completion', () => {
    // Same accepted-bound S06-D facts but the canonical plan_acceptance is
    // absent from the durable set: every S06-D fact classifies
    // relation-unverifiable (the canonical relation cannot be resolved), so
    // no completion state may project.
    const facts = [
      ...canonicalS06dFacts(),
    ];
    const detail: MesExecuteDetail = projectExecuteDetail(facts);
    const slice = detail.slices.find((s) => s.slice_id === 'S06-D');
    assert.ok(slice !== undefined, 'S06-D slice must be projected');
    assert.equal(FORBIDDEN_STATES.includes(slice.state), false, `unverifiable history must not authorize completion: ${slice.state}`);
    assert.equal(slice.state, 'EXECUTING', 'only the in-flight fallback may project');
  });

  test('negative fixture (CE2): an accepted-stage support without any durable plan_acceptance is relation-unverifiable and cannot drive STAGE_ACCEPTED', () => {
    // A cycle-bearing PVR exists, but the accepted-stage support's plan has
    // NO plan_acceptance fact anywhere in the set: the canonical relation
    // cannot be resolved, so the support classifies relation-unverifiable
    // and must never authorize STAGE_ACCEPTED.
    const facts = [
      pvr('1', CANONICAL_REF),
      reviewWorkFact(),
      acceptedStageSupport(CANONICAL_REF),
    ];
    const status = projectCycleFilteredStatus(facts);
    assert.equal(status.phase !== 'STAGE_ACCEPTED', true, 'unverifiable support must not authorize Stage completion');
    assert.equal(status.phase, 'REVIEW', 'the stage stays in-flight on its remaining valid same-cycle facts');
  });

  test('negative fixture (ambiguous dual plan_acceptance): execution facts under an ambiguous canonical relation are relation-unverifiable and never authorize', () => {
    // Two plan_acceptance facts binding the same plan make the canonical
    // relation unresolvable → every accepted-bound execution fact is
    // relation-unverifiable → completion states never project.
    const facts = [
      pvr('1', CANONICAL_REF),
      pa('1', CANONICAL_REF),
      pa('2', 'mes:result:S06:planning-verification-9'),
      ...canonicalS06dFacts(),
    ];
    const detail: MesExecuteDetail = projectExecuteDetail(facts);
    const slice = detail.slices.find((s) => s.slice_id === 'S06-D');
    assert.ok(slice !== undefined);
    assert.equal(FORBIDDEN_STATES.includes(slice.state), false, `ambiguous plan_acceptance must never authorize completion: ${slice.state}`);
    assert.equal(slice.state, 'EXECUTING');
  });
});
