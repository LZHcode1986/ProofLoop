/**
 * Current Operational Basis convergence regression (Change B / D / E).
 *
 * Covers:
 *   12.1 Permutation invariance — a representative valid snapshot (the frozen
 *        live 389-fact corpus) and synthetic generation fixtures all yield
 *        byte-equivalent `projectCycleFilteredStatus` / `projectExecuteDetail`
 *        under 100 deterministic pseudo-random array permutations.
 *   12.2 Generation isolation — superseded-generation facts (old-gen stage-only
 *      Review, old-gen candidate/integration/cleanup) never drive the current
 *      phase / Slice completion.
 *   12.3 Live Rolling-Wave Between-Stage Regression — the frozen real corpus
 *        (S01..S04+S15 all accepted, no unique in-flight Stage, open cycle)
 *        MUST project the legal project-level between-Stage observation
 *        (`project_terminal.state=PRE_TERMINAL` + accepted ids), NOT
 *        `AUTHORITY_GAP`, and MES must not select a next Stage.
 *
 * The frozen corpus is a read-only exact copy of the live ShortVideoGrowth MES
 * snapshot (PROVENANCE in .docs/evidence/mes-live-rolling-wave-20260928).
 * All permutations are deterministic (seeded PRNG).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectCycleFilteredStatus, projectCycleFilteredDetail, projectExecuteDetail, MesStatusError } from '../dist/mes/status';
import { classifyInvalidHistory } from '../dist/mes/history-oracle';
import { resolveWorkLineageTips } from '../dist/mes/binding';
import { validateMesFactEnvelope } from '../dist/mes/validate';
import type { MesFactEnvelope } from '../dist/mes/types';
import { sha, makeFixture, commitAll } from './helpers';
import { proofloopCli } from '../dist/cli/proofloop';
import { CLI_EXIT } from '../dist/index';
import { seedMesBootstrap, isMesSeeded } from '../dist/mes/bootstrap';
import { MesSnapshotStore } from '../dist/mes/store';
import { buildAcceptedPlanTaskGraph } from '../dist/execute/plan-task-graph';

/** Deterministic PRNG (mulberry32) so permutation runs are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(arr: readonly T[], rnd: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** @returns the frozen corpus facts, or `null` when the evidence dir is absent in this environment. */
function loadFrozenCorpus(): MesFactEnvelope[] | null {
  const root = path.resolve(__dirname, '..', '..', '..');
  const p = path.join(root, '.docs', 'evidence', 'mes-live-rolling-wave-20260928', 'snapshot.json');
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { facts: unknown[] };
  assert.ok(Array.isArray(raw.facts) && raw.facts.length === 389, `expected 389-fact corpus, got ${raw.facts.length}`);
  return raw.facts as MesFactEnvelope[];
}

// ── synthetic reusable planning fixtures ──────────────────────────────────
const PLAN = 'delivery/stages/S03/plan.md';
const DIGEST = sha('s03-d');
const GB = { head: 'a'.repeat(40), branch: 'proofloop-s03-a', worktree: '.' };
const CYCLE = 'cycle-regress';
const V1 = 'mes:result:S03:verification-1';
const V2 = 'mes:result:S03:verification-2';

function candidateBinding(verif: string) {
  return { binding_stage: 'candidate' as const, candidate_plan_ref: PLAN, accepted_plan_ref: null, verdict: 'PLAN_READY', plan_digest: DIGEST, delivery_cycle_id: CYCLE };
}
function acceptedBinding(verif: string) {
  return { binding_stage: 'accepted' as const, accepted_plan_ref: PLAN, source_candidate_plan_ref: PLAN, verification_result_ref: verif, plan_digest: DIGEST, delivery_cycle_id: CYCLE };
}
function pvr(fid: string, verif: string): MesFactEnvelope {
  return { schema_version: 2, fact_id: `mes:fact:planning_verification_result:S03:${fid}`, fact_kind: 'planning_verification_result', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2'], scope: { stage_id: 'S03' }, work_id: 'w-plan', result_ref: verif, verifier_role: 'stage-plan-verifier', action_token: 's03-spv-1', plan_binding: candidateBinding(verif), git_basis: GB } as MesFactEnvelope;
}
function pa(fid: string, verif: string, pred: string | null | undefined): MesFactEnvelope {
  return validateMesFactEnvelope({ schema_version: 2, fact_id: `mes:fact:plan_acceptance:S03:${fid}`, fact_kind: 'plan_acceptance', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2'], scope: { stage_id: 'S03' }, supersedes_plan_acceptance_ref: pred, plan_binding: acceptedBinding(verif), git_basis: GB });
}
function workFact(fid: string, sliceId: string, verif: string, pred?: string | null): MesFactEnvelope {
  return validateMesFactEnvelope({ schema_version: 2, fact_id: `mes:fact:work:${sliceId}:${fid}`, fact_kind: 'work', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2'], scope: { stage_id: 'S03', slice_id: sliceId }, work_id: `mes:work:${sliceId}:${fid}`, supersedes_work_ref: pred, plan_binding: acceptedBinding(verif), git_basis: GB });
}
function reviewResult(fid: string, verif: string): MesFactEnvelope {
  return validateMesFactEnvelope({ schema_version: 2, fact_id: `mes:fact:result:S03-stage:${fid}`, fact_kind: 'result', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2'], scope: { stage_id: 'S03' }, work_id: 'mes:work:S03:stage', result_ref: `mes:result:S03:stage:${fid}`, result_id: `rid-${fid}`, result_payload_digest: 'a'.repeat(64), plan_binding: acceptedBinding(verif), git_basis: GB });
}
function taskFact(taskId: string, sliceId: string, verif: string, workId: string, status = 'TASK_COMPLETE'): MesFactEnvelope {
  // (M1-F4) fact_id must be unique per attempt/restart (a task id + status
  // would collide across restarted attempts), so it is derived from work_id.
  const tag = workId.split(':').pop() ?? taskId;
  return validateMesFactEnvelope({ schema_version: 2, fact_id: `mes:fact:task:${taskId}:${tag}:${status}`, fact_kind: 'task', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2'], scope: { stage_id: 'S03', slice_id: sliceId, task_id: taskId }, work_id: workId, task_status: status, depends_on_task_ids: [], plan_binding: acceptedBinding(verif), git_basis: GB });
}
function gitFact(fid: string, sliceId: string, verif: string, subkind: string, workId: string): MesFactEnvelope {
  return validateMesFactEnvelope({ schema_version: 2, fact_id: `mes:fact:git:${sliceId}:${fid}`, fact_kind: 'git', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2'], scope: { stage_id: 'S03', slice_id: sliceId }, work_id: workId, git_subkind: subkind, candidate_ref: `cand-${fid}`, candidate_base_ref: 'base', commit_sha: 'b'.repeat(40), changed_files: ['x'], plan_binding: acceptedBinding(verif), git_basis: GB });
}
function findingFact(fid: string, sliceId: string, verif: string, verdict: 'PASS' | 'FINDINGS', workId: string): MesFactEnvelope {
  return validateMesFactEnvelope({ schema_version: 2, fact_id: fid, fact_kind: 'finding', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2.3'], scope: { stage_id: 'S03', slice_id: sliceId }, work_id: workId, verifier_verdict: verdict, claimed_route_code: 'IMPLEMENTATION_DEFECT', plan_binding: acceptedBinding(verif), git_basis: GB });
}
function dispositionFact(fid: string, sliceId: string, verif: string, findingRef: string, route: string): MesFactEnvelope {
  return validateMesFactEnvelope({ schema_version: 2, fact_id: fid, fact_kind: 'finding_disposition', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2.3'], scope: { stage_id: 'S03', slice_id: sliceId }, disposition_ref: `mes:disposition:${sliceId}:${fid}`, finding_ref: findingRef, finding_disposition: 'ACCEPTED', claimed_route_code: route, accepted_route_code: route, basis_refs: ['tech-spec/contracts.md#2.2.3'], reason: 'replan classification', resume_target: 'planner', plan_binding: acceptedBinding(verif), git_basis: GB });
}

describe('12.1 — permutation invariance', () => {
  test('frozen 389-fact corpus: status + execute detail byte-equivalent under 100 deterministic permutations', (t) => {
    const facts = loadFrozenCorpus();
    if (facts === null) return t.skip('frozen corpus not present in this environment (.docs/evidence absent)');
    const rnd = mulberry32(0x51);
    const baseStatus = projectCycleFilteredStatus(facts);
    const baseDetail = projectExecuteDetail(facts);
    for (let i = 0; i < 100; i += 1) {
      const perm: MesFactEnvelope[] = shuffled(facts, rnd);
      assert.deepEqual(projectCycleFilteredStatus(perm), baseStatus, `status permutation ${i}`);
      assert.deepEqual(projectExecuteDetail(perm), baseDetail, `execute detail permutation ${i}`);
    }
  });

  test('generation-filtered phase (old-gen Review + current-gen Execute) is permutation-invariant', () => {
    const g1 = pa('1', V1, null);
    const g2 = pa('2', V2, 'mes:fact:plan_acceptance:S03:1');
    const oldGenReview = reviewResult('old', V1);
    const curWork = workFact('cur', 'S03-A', V2);
    const curTask = taskFact('S03-A-T01', 'S03-A', V2, 'mes:work:S03-A:cur');
    const facts = [pvr('1', V1), g1, pvr('2', V2), g2, oldGenReview, curWork, curTask];
    const baseStatus = projectCycleFilteredStatus(facts);
    const baseDetail = projectExecuteDetail(facts);
    assert.equal(baseStatus.phase, 'EXECUTE');
    const rnd = mulberry32(0x77);
    for (let i = 0; i < 20; i += 1) {
      const perm = shuffled(facts, rnd);
      assert.deepEqual(projectCycleFilteredStatus(perm), baseStatus, `status permutation ${i}`);
      assert.deepEqual(projectExecuteDetail(perm), baseDetail, `execute detail permutation ${i}`);
    }
  });
});

describe('12.2 — generation isolation', () => {
  test('old-gen stage-only Review + current-gen Execute → phase EXECUTE (never REVIEW)', () => {
    const g1 = pa('1', V1, null);
    const g2 = pa('2', V2, 'mes:fact:plan_acceptance:S03:1');
    const oldGenReview = reviewResult('old', V1);
    const curWork = workFact('cur', 'S03-A', V2);
    const curTask = taskFact('S03-A-T01', 'S03-A', V2, 'mes:work:S03-A:cur');
    const status = projectCycleFilteredStatus([pvr('1', V1), g1, pvr('2', V2), g2, oldGenReview, curWork, curTask]);
    assert.equal(status.observation, undefined, 'stage-scoped');
    assert.equal(status.phase, 'EXECUTE', 'superseded-generation Review must not flip current phase to REVIEW');
  });

  test('old-gen candidate/integration/cleanup cannot authorize completion of a new-gen fresh work', () => {
    const g1 = pa('1', V1, null);
    const g2 = pa('2', V2, 'mes:fact:plan_acceptance:S03:1');
    const oldGenWork = workFact('old', 'S03-A', V1);
    const oldCandidate = gitFact('gc', 'S03-A', V1, 'candidate', 'mes:work:S03-A:old');
    const oldIntegration = gitFact('gi', 'S03-A', V1, 'integration', 'mes:work:S03-A:old');
    const oldCleanup = gitFact('gl', 'S03-A', V1, 'cleanup', 'mes:work:S03-A:old');
    const newGenWork = workFact('new', 'S03-A', V2);
    const newTask = taskFact('S03-A-T01', 'S03-A', V2, 'mes:work:S03-A:new', 'TASK_COMPLETE');
    const detail = projectExecuteDetail([pvr('1', V1), g1, pvr('2', V2), g2, oldGenWork, oldCandidate, oldIntegration, oldCleanup, newGenWork, newTask]);
    const slice = detail.slices.find((s) => s.slice_id === 'S03-A');
    assert.ok(slice !== undefined);
    assert.ok(
      !['CLEANED', 'INTEGRATED', 'READY_TO_INTEGRATE'].includes(slice!.state),
      `superseded-generation git facts must not authorize completion (got ${slice!.state})`,
    );
  });
});

describe('12.3 — Live Rolling-Wave Between-Stage regression (frozen 389-corpus)', () => {
  test('a legal between-Stage frontier is observed, NOT AUTHORITY_GAP; MES does not select a Stage', (t) => {
    const facts = loadFrozenCorpus();
    if (facts === null) return t.skip('frozen corpus not present in this environment (.docs/evidence absent)');
    const status = projectCycleFilteredStatus(facts);
    assert.equal(status.observation, 'between-stage', 'must be a project-level between-Stage observation');
    assert.equal(status.cycle_id, 'cycle-s01-project-adoption-2492b3a8-76fc-4462-8578-2a804aac9d93');
    assert.deepEqual(status.accepted_stage_support_ids, ['S01', 'S02', 'S03', 'S04', 'S15']);
    assert.equal(status.scope, undefined, 'no fabricated per-Stage scope');
    assert.equal(status.phase, undefined, 'no fabricated per-Stage phase');

    const detail = projectCycleFilteredDetail(facts);
    assert.equal(detail.project_terminal?.state, 'PRE_TERMINAL');
    assert.deepEqual(detail.accepted_stage_support_ids, ['S01', 'S02', 'S03', 'S04', 'S15']);
    assert.equal(detail.project_terminal?.exact_closure, false);
    // MES must not invent a next Stage nor emit any route / next-action.
    const serialized = JSON.stringify(detail);
    for (const forbidden of ['next_action', 'next_stage', 'route']) {
      assert.equal(serialized.includes(forbidden), false, `detail must not contain ${forbidden}`);
    }
    // MES must not select the next dependency-ready Stage (S05 role belongs to
    // Brain + Project Stage Map): the project-level detail never names it.
    assert.equal(serialized.includes('S05'), false, 'MES must not select the next Stage');
  });
});

describe('12.4 — M1-F4 counterexample regressions', () => {
  test('opaque-ID rename invariance: findings {PASS, FINDINGS} yield the SAME state regardless of fact_id naming', () => {
    // Counterexample #1: only the opaque finding fact_ids are permuted between
    // the two semantically-identical fact sets. Set-union CV (M1-F3) must make
    // the projection ID-rename invariant.
    const base = [pvr('1', V1), pa('1', V1, null)];
    const canonical = workFact('w', 'S03-A', V1, null);
    const setA = [...base, canonical,
      findingFact('mes:fact:finding:S03-A:zz-pass', 'S03-A', V1, 'PASS', 'mes:work:S03-A:w'),
      findingFact('mes:fact:finding:S03-A:aa-find', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:w'),
    ];
    const setB = [...base, canonical,
      findingFact('mes:fact:finding:S03-A:aa-pass', 'S03-A', V1, 'PASS', 'mes:work:S03-A:w'),
      findingFact('mes:fact:finding:S03-A:zz-find', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:w'),
    ];
    const a = projectExecuteDetail(setA).slices.find((s) => s.slice_id === 'S03-A')!;
    const b = projectExecuteDetail(setB).slices.find((s) => s.slice_id === 'S03-A')!;
    assert.equal(a.state, b.state, 'state must be invariant under opaque fact_id renaming');
    assert.notEqual(a.state, 'CV_PASSED', 'a coexisting FINDINGS must block CV_PASSED (set-union)');
    assert.deepEqual(a.finding_refs, ['mes:fact:finding:S03-A:aa-find', 'mes:fact:finding:S03-A:zz-pass'], 'bounded set, ascending fact_id, for multiple findings');
    assert.deepEqual(b.finding_refs, ['mes:fact:finding:S03-A:aa-pass', 'mes:fact:finding:S03-A:zz-find'], 'set order is fact_id-asc, not input order');
  });

  test('restart attempt isolation: completed current attempt → SLICE_CANDIDATE_READY, old attempt task never pollutes', () => {
    // Counterexample #2: work A (task complete), restart → work B supersedes A
    // (task complete). The slice must be current-attempt scoped so old A's task
    // cannot keep the completion predicate false.
    const base = [pvr('p1', V1), pa('p1', V1, null)];
    const wA = workFact('A', 'S03-A', V1, null);
    const tA = taskFact('S03-A-T01', 'S03-A', V1, 'mes:work:S03-A:A');
    const wB = workFact('B', 'S03-A', V1, 'mes:fact:work:S03-A:A');
    const tB = taskFact('S03-A-T01', 'S03-A', V1, 'mes:work:S03-A:B');
    const detail = projectExecuteDetail([...base, wA, tA, wB, tB]);
    const slice = detail.slices.find((s) => s.slice_id === 'S03-A')!;
    assert.equal(slice.state, 'SLICE_CANDIDATE_READY', 'current attempt tasks complete → not EXECUTING');
  });

  test('legacy-root → new Work migration: oracle supersedes the retained legacy root + downstream', () => {
    // Counterexample #3: a retained legacy compat root (supersedes_work_ref
    // omitted) anchored by a NEW-shape work. The lineage resolves tip=new, and
    // the oracle must classify the legacy root and its bound fact as superseded
    // (never current-authorizing).
    const base = [pvr('p1', V1), pa('p1', V1, null)];
    const legacyW = workFact('legacy', 'S03-A', V1); // omitted field (retained legacy)
    const legacyT = taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:legacy');
    const newW = workFact('new', 'S03-A', V1, 'mes:fact:work:S03-A:legacy');
    const newT = taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:new');
    const facts = [...base, legacyW, legacyT, newW, newT];
    const tips = resolveWorkLineageTips(facts);
    assert.equal(tips.ok, true);
    assert.equal(tips.ok ? tips.tips[0]?.fact_id : undefined, 'mes:fact:work:S03-A:new', 'new work is the lineage tip');
    const oracle = classifyInvalidHistory(facts);
    assert.equal(oracle.supersededFactIds.includes(legacyW.fact_id), true, 'retained legacy root must classify superseded');
    assert.equal(oracle.facts.find((f) => f.fact_id === legacyW.fact_id)?.status, 'relation-invalid');
  });

  test('same-subkind git facts in one attempt fail closed typed (no opaque-ID winner), while distinct subkinds project normally', () => {
    // The reviewer: "disposition / result / Git 也仍然存在相同模式". Two
    // candidate git facts in the current attempt have no relation-defined
    // winner — the projection must NOT pick one by opaque fact_id.
    const base = [pvr('p1', V1), pa('p1', V1, null), workFact('w', 'S03-A', V1, null)];
    const dup = [...base,
      gitFact('cand-1', 'S03-A', V1, 'candidate', 'mes:work:S03-A:w'),
      gitFact('cand-2', 'S03-A', V1, 'candidate', 'mes:work:S03-A:w'),
    ];
    assert.throws(() => projectExecuteDetail(dup), MesStatusError, 'two same-subkind git facts must fail closed typed');
    // Distinct subkinds (candidate + integration) are a legal progression.
    const ok = [...base,
      gitFact('cand-1', 'S03-A', V1, 'candidate', 'mes:work:S03-A:w'),
      gitFact('int-1', 'S03-A', V1, 'integration', 'mes:work:S03-A:w'),
    ];
    const detail = projectExecuteDetail(ok);
    const slice = detail.slices.find((s) => s.slice_id === 'S03-A')!;
    assert.equal(slice.candidate_ref, 'cand-cand-1');
    assert.equal(slice.integration_ref, 'cand-int-1');
  });


  test('composition A — generation × Work: an OLD generation\'s own Work tip must NOT pollute the current completion', () => {
    // Review Blocker 1: Gen1 Work is its own lineage tip (supersedes_work_ref
    // null) AND Gen2 (current accepted generation) Work is its own tip. The
    // attempt filter must compose generation currentness: only the relation-
    // valid (current-generation) tip is CURRENT, so the old task leaves the
    // current task set and completion is driven by the new task alone.
    const base = [
      pvr('p1', V1), pa('g1', V1, null),
      pvr('p2', V2), pa('g2', V2, 'mes:fact:plan_acceptance:S03:g1'),
    ];
    const wOld = workFact('wOld', 'S03-A', V1, null);
    const tOld = taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:wOld');
    const wNew = workFact('wNew', 'S03-A', V2, null);
    const tNew = taskFact('S03-A-T1', 'S03-A', V2, 'mes:work:S03-A:wNew');
    const facts = [...base, wOld, tOld, wNew, tNew];
    const detail = projectExecuteDetail(facts);
    const slice = detail.slices.find((s) => s.slice_id === 'S03-A')!;
    assert.equal(slice.state, 'SLICE_CANDIDATE_READY', 'old-generation task must not keep current completion in EXECUTING');
    // Permutation / reversal must not change the composed outcome.
    assert.deepEqual(projectExecuteDetail([...facts].reverse()), detail);
    const rnd = mulberry32(7);
    assert.deepEqual(projectExecuteDetail(shuffled(facts, rnd)), detail, 'permuted composition stays deterministic');
  });

  test('composition B — disposition inherits its Finding\'s Work attempt: stale PLAN_GAP cannot leak across restart', () => {
    // Review Blocker 2: finding_disposition has NO work_id, only finding_ref.
    // Its currentness must be inherited along disposition → finding → work, so
    // a superseded attempt\'s PLAN_GAP arbitration never projects REPLAN on the
    // restarted attempt.
    const base = [pvr('p1', V1), pa('p1', V1, null)];
    const wA = workFact('A', 'S03-A', V1, null);
    const fA = findingFact('mes:fact:finding:S03-A:A', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:A');
    const dA = dispositionFact('mes:fact:disposition:S03-A:A', 'S03-A', V1, 'mes:fact:finding:S03-A:A', 'PLAN_GAP');
    const wB = workFact('B', 'S03-A', V1, 'mes:fact:work:S03-A:A');
    const tB = taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:B');
    const facts = [...base, wA, fA, dA, wB, tB];
    const detail = projectExecuteDetail(facts);
    const slice = detail.slices.find((s) => s.slice_id === 'S03-A')!;
    assert.notEqual(slice.state, 'REPLAN', 'stale PLAN_GAP disposition must not leak through restart');
    assert.equal(slice.state, 'SLICE_CANDIDATE_READY', 'current attempt task complete → SLICE_CANDIDATE_READY');
    // The stale disposition and its finding are history: oracle must not
    // authorize the superseded attempt.
    const oracle = classifyInvalidHistory(facts);
    assert.equal(oracle.supersededFactIds.includes(fA.fact_id), true, 'finding of superseded attempt is history');
    assert.deepEqual(projectExecuteDetail([...facts].reverse()), detail, 'reversed composition stays deterministic');
  });

});

describe('12.5 — M2-2 L2 operational detail projection (Change G)', () => {
  test('slice detail projects current_work_ref + semantic owner/waiting-for per durable state (closed mapping)', () => {
    const base = [pvr('1', V1), pa('1', V1, null), workFact('w2', 'S03-A', V1, null), taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:w2')];
    const s = (f: MesFactEnvelope[]) => projectExecuteDetail(f).slices.find((x) => x.slice_id === 'S03-A')!;
    // SLICE_CANDIDATE_READY → code-verifier / verifier_result
    const ready = s(base);
    assert.equal(ready.state, 'SLICE_CANDIDATE_READY');
    assert.equal(ready.current_work_ref, 'mes:fact:work:S03-A:w2');
    assert.equal(ready.semantic_owner, 'code-verifier');
    assert.equal(ready.waiting_for, 'verifier_result');
    // CV_PASSED → brain / candidate_git
    const cvp = s([...base, findingFact('mes:fact:finding:S03-A:cv1', 'S03-A', V1, 'PASS', 'mes:work:S03-A:w2')]);
    assert.equal(cvp.state, 'CV_PASSED');
    assert.equal(cvp.semantic_owner, 'brain');
    assert.equal(cvp.waiting_for, 'candidate_git');
    // READY_TO_INTEGRATE → integrator / integration
    const rti = s([...base, findingFact('mes:fact:finding:S03-A:cv1', 'S03-A', V1, 'PASS', 'mes:work:S03-A:w2'), gitFact('cand-1', 'S03-A', V1, 'candidate', 'mes:work:S03-A:w2')]);
    assert.equal(rti.state, 'READY_TO_INTEGRATE');
    assert.equal(rti.semantic_owner, 'integrator');
    assert.equal(rti.waiting_for, 'integration');
    // INTEGRATED + no cleanup → integrator / cleanup (cleanup_pending)
    const intg = s([...base, gitFact('int-1', 'S03-A', V1, 'integration', 'mes:work:S03-A:w2')]);
    assert.equal(intg.state, 'INTEGRATED');
    assert.equal(intg.cleanup_pending, true);
    assert.equal(intg.semantic_owner, 'integrator');
    assert.equal(intg.waiting_for, 'cleanup');
    // (M2-F4) CLEANED declares NO owner/wait: a single CLEANED Slice does not
    // prove Stage-level Review readiness (E2E-05 requires ALL Slices
    // INTEGRATED) — never invent a Stage Reviewer from one Slice.
    const cln = s([...base, gitFact('int-1', 'S03-A', V1, 'integration', 'mes:work:S03-A:w2'), gitFact('cln-1', 'S03-A', V1, 'cleanup', 'mes:work:S03-A:w2')]);
    assert.equal(cln.state, 'CLEANED');
    assert.equal(cln.semantic_owner, undefined, 'CLEANED declares no owner until Stage-level readiness is provable');
    assert.equal(cln.waiting_for, undefined, 'CLEANED declares no wait');
  });

  test('L2 detail is a durable projection: byte-rehydrate + reversal produce the identical semantic owner / waiting-for', () => {
    const facts = [
      pvr('1', V1), pa('1', V1, null),
      workFact('wA', 'S03-A', V1, null),
      taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:wA'),
      findingFact('mes:fact:finding:S03-A:cv1', 'S03-A', V1, 'PASS', 'mes:work:S03-A:wA'),
      gitFact('int-1', 'S03-A', V1, 'integration', 'mes:work:S03-A:wA'),
    ];
    const first = projectExecuteDetail(facts);
    assert.deepEqual(projectExecuteDetail(JSON.parse(JSON.stringify(facts)) as MesFactEnvelope[]), first, 'rehydrate byte-stable');
    assert.deepEqual(projectExecuteDetail([...facts].reverse()), first, 'reversal byte-stable');
    const slice = first.slices.find((x) => x.slice_id === 'S03-A')!;
    assert.equal(slice.semantic_owner, 'integrator');
    assert.equal(slice.waiting_for, 'cleanup');
  });
});

describe('12.6 — M2-3 recovery-without-session acceptance (Change G / M2-F5)', () => {
  test('with a fully lost session, PUBLIC status + PUBLIC detail + returned refs + Plan/Git reconstruct the current frontier: restart + arbitrated finding + parallel blocker', () => {
    // A Brain session-loss scenario: durable facts ONLY (no hidden conversation,
    // no execution-plan cache, no filename/mtime guessing). The recovery entry
    // is the PUBLIC surface (status + --detail) — never a raw internal call.
    const facts: MesFactEnvelope[] = [
      // S03 accepted plan (Plan/Git basis lives here).
      pvr('1', V1), pa('1', V1, null),
      // Restart frontier: old attempt work A superseded by current work B.
      workFact('A', 'S03-A', V1, null),
      taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:A'),
      workFact('B', 'S03-A', V1, 'mes:fact:work:S03-A:A'),
      taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:B'),
      // Current finding + durable Brain disposition on the CURRENT attempt.
      findingFact('mes:fact:finding:S03-A:f1', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:B'),
      dispositionFact('mes:fact:disposition:S03-A:f1', 'S03-A', V1, 'mes:fact:finding:S03-A:f1', 'PLAN_GAP'),
      // Parallel blocker: S03-C blocked by an explicit dependency on S03-B's task.
      workFact('wC', 'S03-C', V1, null),
      taskFact('S03-C-T0', 'S03-C', V1, 'mes:work:S03-C:wC'),
      { ...taskFact('S03-C-T1', 'S03-C', V1, 'mes:work:S03-C:wC'), blocked_by_task_id: 'S03-C-T0' } as MesFactEnvelope,
    ];
    // L1: stage-scoped PUBLIC status with derived counters.
    const status = projectCycleFilteredStatus(facts);
    assert.equal(status.scope, 'S03');
    assert.equal(status.observation, undefined, 'stage-scoped');
    assert.equal(status.counters?.replan, 1, 'current PLAN_GAP disposition → replan=1');
    assert.equal(status.counters?.blocked, 1, 'S03-C blocked by real dependency → blocked=1');
    // L2: the PUBLIC detail carries the execute L2 (slices/tasks) — recovery
    // rebuilds the frontier from the returned slugs + refs alone, with NO
    // direct internal execute-detail call.
    const detail = projectCycleFilteredDetail(facts);
    assert.ok(detail.slices !== undefined && detail.slices.length === 2, 'public detail carries both slices');
    const a = detail.slices!.find((x) => x.slice_id === 'S03-A')!;
    assert.equal(a.current_work_ref, 'mes:fact:work:S03-A:B', 'current attempt tip is the recovered Work ref');
    assert.equal(a.state, 'REPLAN', 'current attempt disposition is the true frontier');
    assert.equal(a.semantic_owner, 'planner', 'semantic owner derived from durable state');
    assert.equal(a.waiting_for, 'plan_revision', 'wait condition derived from durable state');
    const c = detail.slices!.find((x) => x.slice_id === 'S03-C')!;
    assert.equal(c.state, 'BLOCKED_BY');
    assert.equal(c.blocked_by, 'S03-C-T0', 'exact blocking task id returned');
    assert.equal(c.semantic_owner, 'worker');
    assert.equal(c.waiting_for, 'S03-C-T0');
    // Binding refs (Plan/Git basis) are on the public detail for Brain+Map routing.
    assert.equal(detail.accepted_plan_ref, PLAN, 'accepted Plan ref is on the public detail');
    assert.ok(detail.git_basis !== undefined, 'Git basis is on the public detail');
    // No route / next-action / reasoning anywhere in the recovered frontier.
    const serialized = JSON.stringify(detail) + JSON.stringify(status);
    for (const forbidden of ['next_action', 'next_stage', 'route', 'reasoning']) {
      assert.equal(serialized.includes(forbidden), false, `recovered frontier must not contain ${forbidden}`);
    }
    // Deterministic across restart / permutation — same PUBLIC output.
    const rehydrated = JSON.parse(JSON.stringify(facts)) as MesFactEnvelope[];
    assert.deepEqual(projectCycleFilteredStatus(rehydrated), status, 'status rehydrate byte-stable');
    assert.deepEqual(projectCycleFilteredDetail(rehydrated), detail, 'public detail rehydrate byte-stable');
    assert.deepEqual(projectCycleFilteredDetail([...facts].reverse()), detail, 'public detail reversal byte-stable');
  });
});

describe('12.7 — M2-F3 current L2 refs never surface invalid history', () => {
  test('an old-generation integration git fact (current work_id, superseded binding) cannot fabricate integration_ref / cleanup_pending on a SLICE_CANDIDATE_READY slice', () => {
    // Blocker 3 repro: current generation has Work current + Task complete;
    // an OLD-generation integration git fact carries work_id = CURRENT work
    // but plan_binding = old generation → oracle relation-invalid. The slice
    // state must stay SLICE_CANDIDATE_READY with NO unlabeled current refs.
    const base = [pvr('1', V1), pa('1', V1, null), pvr('2', V2), pa('g2', V2, 'mes:fact:plan_acceptance:S03:1')];
    const wCur = workFact('wCur', 'S03-A', V2, null);
    const tCur = taskFact('S03-A-T1', 'S03-A', V2, 'mes:work:S03-A:wCur');
    const gOld = gitFact('intOld', 'S03-A', V1, 'integration', 'mes:work:S03-A:wCur');
    const facts = [...base, wCur, tCur, gOld];
    const detail = projectExecuteDetail(facts);
    const slice = detail.slices.find((s) => s.slice_id === 'S03-A')!;
    assert.equal(slice.state, 'SLICE_CANDIDATE_READY', 'old-gen integration cannot authorize INTEGRATED');
    assert.equal(slice.integration_ref, undefined, 'no unlabeled current integration_ref from invalid history');
    assert.equal(slice.cleanup_pending, undefined, 'no cleanup_pending fabricated from invalid history');
    // Permutation / reversal must not change the composed outcome.
    assert.deepEqual(projectExecuteDetail([...facts].reverse()), detail);
  });
});

describe('12.8 — M2-R2 Blocker 1 regression: old-generation invalid Tasks never enter the current task graph', () => {
  test('old-gen IN_PROGRESS/blocked Task reusing the current work_id cannot drive blocked counter / BLOCKED_BY / completion; reversal identical', () => {
    // Reviewer Blocker 1 repro: current generation carries Work current +
    // Task COMPLETE; an OLD-generation Task reuses the CURRENT work_id but
    // binds to the old generation → relation-invalid. It must NEVER enter
    // currentTaskFacts / taskById / effectiveBlocked: no blocked counter, no
    // BLOCKED_BY, completion driven by the current Task alone, and the
    // projection must be permutation-invariant (no input-order override of a
    // shared task_id).
    const gen1 = [pvr('1', V1), pa('g1', V1, null)];
    const gen2 = [pvr('2', V2), pa('g2', V2, 'mes:fact:plan_acceptance:S03:g1')];
    const wCur = workFact('wCur', 'S03-A', V2, null);
    const tCur = taskFact('S03-A-T1', 'S03-A', V2, 'mes:work:S03-A:wCur');
    const tOld = {
      ...taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:wCur'),
      // Distinct durable fact (old attempt) but reusing the CURRENT work_id:
      // the helper derives fact_id from work_id, so override it to avoid a
      // fact_id collision with the current Task.
      fact_id: 'mes:fact:task:S03-A-T1:wCur:OLD',
      task_status: 'IN_PROGRESS',
      blocked_by_task_id: 'S03-A-T0',
    } as MesFactEnvelope;
    const facts = [...gen1, ...gen2, wCur, tCur, tOld];
    const status = projectCycleFilteredStatus(facts);
    assert.equal(status.counters, undefined, 'old-gen blocked Task never opens the blocked counter');
    const detail = projectExecuteDetail(facts);
    const slice = detail.slices.find((s) => s.slice_id === 'S03-A')!;
    assert.equal(slice.state, 'SLICE_CANDIDATE_READY', 'completion driven by the current operational Task only');
    assert.equal(slice.blocked_by, undefined, 'old-gen blocker never propagates');
    assert.equal(detail.tasks.length, 1, 'L2 tasks list holds the current operational Task only');
    assert.deepEqual(projectCycleFilteredStatus([...facts].reverse()), status);
    assert.deepEqual(projectExecuteDetail([...facts].reverse()), detail);
  });
});

describe('12.9 — M2-R2 Blocker 2 regression: invalid old-generation git facts never fabricate current ambiguity', () => {
  test('valid current integration + invalid old-gen integration (same work_id, same subkind) → unique current integration, no ambiguity, reversal identical', () => {
    // Reviewer Blocker 2 repro: ambiguity was counted over ALL same-subkind
    // git facts BEFORE the currentness filter, so an old-generation invalid
    // integration fact fabricated a false current ambiguity. Only
    // current-operational git facts may participate in the ambiguity count.
    const base = [pvr('1', V1), pa('1', V1, null), pvr('2', V2), pa('g2', V2, 'mes:fact:plan_acceptance:S03:1')];
    const wCur = workFact('wCur', 'S03-A', V2, null);
    const tCur = taskFact('S03-A-T1', 'S03-A', V2, 'mes:work:S03-A:wCur');
    const gCur = gitFact('intCur', 'S03-A', V2, 'integration', 'mes:work:S03-A:wCur');
    const gOld = gitFact('intOld', 'S03-A', V1, 'integration', 'mes:work:S03-A:wCur');
    const facts = [...base, wCur, tCur, gCur, gOld];
    const detail = projectExecuteDetail(facts);
    const slice = detail.slices.find((s) => s.slice_id === 'S03-A')!;
    assert.equal(slice.state, 'INTEGRATED', 'the unique current integration authorizes INTEGRATED');
    assert.equal(slice.integration_ref, 'cand-intCur', 'current integration ref is the single winner');
    assert.equal(slice.cleanup_pending, true, 'integration without cleanup stays pending');
    assert.deepEqual(projectExecuteDetail([...facts].reverse()), detail, 'reversal must not flip the winner');
  });
});

describe('12.10 — M2-R2 Finding 5: CLI-level root-bound recovery (proofloop status --json / --json --detail)', () => {
  test('with a fully lost session, the REAL public CLI (seeded + durable temp store) rebuilds the current frontier: restart + arbitrated finding + parallel blocker', () => {
    // Reviewer F5: projection functions working is not the same as the public
    // product path working. This test goes through the REAL CLI entry
    // (proofloopCli → runStatusDomain) against a root-bound temp MES store:
    // seed record + durable current-cycle facts, then `status --json` and
    // `status --json --detail` reconstruct the frontier from the public
    // envelope alone (no direct internal execute-detail call).
    const fixture = makeFixture();
    const logs: string[] = [];
    const originalLog = console.log;
    try {
      commitAll(fixture, 'baseline');
      seedMesBootstrap(fixture.dir, {
        authority_refs: ['tech-spec/contracts.md#2.2'],
        accepted_plan_ref: PLAN,
        plan_digest: DIGEST,
        git_basis: GB,
        status: { scope: 'S03', phase: 'EXECUTE', required_skill: 'proofloop-execute' },
      });
      const store = new MesSnapshotStore(fixture.dir);
      const seededFacts = store.read();
      const graph = buildAcceptedPlanTaskGraph({
        stage: 'S03',
        project_stage_map_ref: 'delivery/project-stage-map.md#S03',
        slices: [
          { slice: 'S03-A', goal: 'g', depends_on: [], tasks: [{ task: 'S03-A-T1', goal: 'g', dependencies: [] }] },
          {
            slice: 'S03-C',
            goal: 'g',
            depends_on: [],
            tasks: [
              { task: 'S03-C-T0', goal: 'g', dependencies: [] },
              { task: 'S03-C-T1', goal: 'g', dependencies: ['S03-C-T0'] },
            ],
          },
        ],
      }, PLAN, DIGEST);
      const durable: MesFactEnvelope[] = [
        // Restart frontier: Work A superseded by current Work B.
        workFact('A', 'S03-A', V1, null),
        taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:A'),
        workFact('B', 'S03-A', V1, 'mes:fact:work:S03-A:A'),
        taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:B'),
        // Current finding + durable Brain disposition on the CURRENT attempt.
        findingFact('mes:fact:finding:S03-A:f1', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:B'),
        dispositionFact('mes:fact:disposition:S03-A:f1', 'S03-A', V1, 'mes:fact:finding:S03-A:f1', 'PLAN_GAP'),
        // Parallel blocker: S03-C blocked by an explicit dependency.
        workFact('wC', 'S03-C', V1, null),
        taskFact('S03-C-T0', 'S03-C', V1, 'mes:work:S03-C:wC'),
        {
          ...taskFact('S03-C-T1', 'S03-C', V1, 'mes:work:S03-C:wC'),
          depends_on_task_ids: ['S03-C-T0'],
          blocked_by_task_id: 'S03-C-T0',
        } as MesFactEnvelope,
      ];
      store.write([...seededFacts, pvr('1', V1), pa('1', V1, null), ...durable], { acceptedPlanTaskGraph: graph });
      assert.equal(isMesSeeded(fixture.dir), true, 'seed-owned facts stay durable byte-identically');

      // Snapshot BEFORE the CLI invocations (true before/after read-only check).
      const snapshotBefore = JSON.parse(JSON.stringify(new MesSnapshotStore(fixture.dir).read()));
      console.log = (...args: unknown[]) => {
        logs.push(args.map((arg) => String(arg)).join(' '));
      };
      const runJson = proofloopCli(['status', '--json'], { cwd: fixture.dir });
      assert.equal(runJson, CLI_EXIT.OK);
      const jsonEnvelope = JSON.parse(logs.pop() ?? '{}') as { ok: boolean; result?: Record<string, unknown> };
      assert.equal(jsonEnvelope.ok, true);
      const sparse = jsonEnvelope.result ?? {};
      assert.equal(sparse.scope, 'S03');
      assert.equal(sparse.phase, 'EXECUTE');
      assert.deepEqual(sparse.counters, { blocked: 1, replan: 1 }, 'L1 counters derived from durable facts via the public CLI');

      logs.length = 0;
      const runDetail = proofloopCli(['status', '--json', '--detail'], { cwd: fixture.dir });
      assert.equal(runDetail, CLI_EXIT.OK);
      const detailEnvelope = JSON.parse(logs.pop() ?? '{}') as { ok: boolean; result?: Record<string, unknown> };
      assert.equal(detailEnvelope.ok, true);
      const detail = detailEnvelope.result ?? {};
      assert.equal(detail.scope, 'S03');
      const slices = (detail.slices ?? []) as Array<Record<string, unknown>>;
      const a = slices.find((s) => s.slice_id === 'S03-A');
      assert.equal(a?.state, 'REPLAN', 'public detail carries the current REPLAN frontier');
      assert.equal(a?.current_work_ref, 'mes:fact:work:S03-A:B', 'current Work tip recovered via the public CLI');
      assert.equal(a?.semantic_owner, 'planner');
      assert.equal(a?.waiting_for, 'plan_revision');
      const c = slices.find((s) => s.slice_id === 'S03-C');
      assert.equal(c?.state, 'BLOCKED_BY');
      assert.equal(c?.blocked_by, 'S03-C-T0', 'exact blocking task id returned');
      assert.equal(c?.semantic_owner, 'worker');
      assert.equal(c?.waiting_for, 'S03-C-T0');
      assert.equal(detail.accepted_plan_ref, PLAN, 'Plan binding on the public detail');
      assert.ok(detail.git_basis !== undefined, 'Git basis on the public detail');
      // No route / next-action / reasoning anywhere in the public envelope.
      const serialized = JSON.stringify(detail) + JSON.stringify(sparse);
      for (const forbidden of ['next_action', 'next_stage', 'route', 'reasoning']) {
        assert.equal(serialized.includes(forbidden), false, `recovered frontier must not contain ${forbidden}`);
      }
      // Read-only: status never writes/backfills; snapshot facts byte-unchanged.
      // Read-only: status never writes/backfills — true before/after snapshot
      // comparison across every CLI status invocation.
      assert.deepEqual(JSON.parse(JSON.stringify(store.read())), JSON.parse(JSON.stringify(snapshotBefore)), 'snapshot facts byte-unchanged across the CLI status reads');
    } finally {
      console.log = originalLog;
      fixture.cleanup();
    }
  });
});