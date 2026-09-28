import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { projectCycleFilteredStatus } from '../dist/mes/status';
import { validateMesFactEnvelope } from '../dist/mes/validate';
import type { MesFactEnvelope } from '../dist/mes/types';
import { sha } from './helpers';

// ── synthetic reusable planning fixtures (mirrors mes-currentness-regression) ──
const PLAN = 'delivery/stages/S03/plan.md';
const DIGEST = sha('s03-l1');
const GB = { head: 'a'.repeat(40), branch: 'proofloop-s03-l1', worktree: '.' };
const CYCLE = 'cycle-l1';
const V1 = 'mes:result:S03:verification-1';
const V2 = 'mes:result:S03:verification-2';

function candidateBinding(verif: string) {
  return { binding_stage: 'candidate' as const, candidate_plan_ref: PLAN, accepted_plan_ref: null, verdict: 'PLAN_READY' as const, plan_digest: DIGEST, delivery_cycle_id: CYCLE };
}
function acceptedBinding(verif: string) {
  return { binding_stage: 'accepted' as const, accepted_plan_ref: PLAN, source_candidate_plan_ref: PLAN, verification_result_ref: verif, plan_digest: DIGEST, delivery_cycle_id: CYCLE };
}
function pvr(fid: string, verif: string): MesFactEnvelope {
  return { schema_version: 2, fact_id: `mes:fact:planning_verification_result:S03:${fid}`, fact_kind: 'planning_verification_result', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2'], scope: { stage_id: 'S03' }, work_id: 'w-plan', result_ref: verif, verifier_role: 'stage-plan-verifier', action_token: 's03-l1-1', plan_binding: candidateBinding(verif), git_basis: GB } as MesFactEnvelope;
}
function pa(fid: string, verif: string, pred: string | null | undefined): MesFactEnvelope {
  return validateMesFactEnvelope({ schema_version: 2, fact_id: `mes:fact:plan_acceptance:S03:${fid}`, fact_kind: 'plan_acceptance', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2'], scope: { stage_id: 'S03' }, supersedes_plan_acceptance_ref: pred, plan_binding: acceptedBinding(verif), git_basis: GB });
}
function workFact(fid: string, sliceId: string, verif: string, pred?: string | null): MesFactEnvelope {
  return validateMesFactEnvelope({ schema_version: 2, fact_id: `mes:fact:work:${sliceId}:${fid}`, fact_kind: 'work', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2'], scope: { stage_id: 'S03', slice_id: sliceId }, work_id: `mes:work:${sliceId}:${fid}`, supersedes_work_ref: pred, plan_binding: acceptedBinding(verif), git_basis: GB });
}
function taskFact(taskId: string, sliceId: string, verif: string, workId: string, status = 'TASK_COMPLETE', blockedBy?: string): MesFactEnvelope {
  const tag = workId.split(':').pop() ?? taskId;
  return validateMesFactEnvelope({
    schema_version: 2, fact_id: `mes:fact:task:${taskId}:${tag}:${status}`, fact_kind: 'task', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2'], scope: { stage_id: 'S03', slice_id: sliceId, task_id: taskId }, work_id: workId, task_status: status, depends_on_task_ids: [], ...(blockedBy !== undefined ? { blocked_by_task_id: blockedBy } : {}), plan_binding: acceptedBinding(verif), git_basis: GB,
  });
}
function gitFact(fid: string, sliceId: string, verif: string, subkind: string, workId: string): MesFactEnvelope {
  return validateMesFactEnvelope({ schema_version: 2, fact_id: `mes:fact:git:${sliceId}:${fid}`, fact_kind: 'git', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2'], scope: { stage_id: 'S03', slice_id: sliceId }, work_id: workId, git_subkind: subkind, candidate_ref: `cand-${fid}`, candidate_base_ref: 'base', commit_sha: 'b'.repeat(40), changed_files: ['x'], plan_binding: acceptedBinding(verif), git_basis: GB });
}
function findingFact(fid: string, sliceId: string, verif: string, verdict: 'PASS' | 'FINDINGS' | 'BLOCKED', workId: string): MesFactEnvelope {
  return validateMesFactEnvelope({ schema_version: 2, fact_id: fid, fact_kind: 'finding', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2.3'], scope: { stage_id: 'S03', slice_id: sliceId }, work_id: workId, verifier_verdict: verdict, claimed_route_code: 'IMPLEMENTATION_DEFECT', plan_binding: acceptedBinding(verif), git_basis: GB });
}
function dispositionFact(fid: string, sliceId: string, verif: string, findingRef: string, route: string): MesFactEnvelope {
  return validateMesFactEnvelope({ schema_version: 2, fact_id: fid, fact_kind: 'finding_disposition', created_by: 'brain', authority_refs: ['tech-spec/contracts.md#2.2.3'], scope: { stage_id: 'S03', slice_id: sliceId }, disposition_ref: `mes:disposition:${sliceId}:${fid}`, finding_ref: findingRef, finding_disposition: 'ACCEPTED', claimed_route_code: route, accepted_route_code: route, basis_refs: ['tech-spec/contracts.md#2.2.3'], reason: 'arbitration', resume_target: 'planner', plan_binding: acceptedBinding(verif), git_basis: GB });
}

function statusOf(facts: MesFactEnvelope[]) {
  return projectCycleFilteredStatus(facts);
}
function countersOf(facts: MesFactEnvelope[]) {
  return statusOf(facts).counters;
}
const base = () => [pvr('1', V1), pa('1', V1, null), workFact('w', 'S03-A', V1, null), taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:w')];

describe('M2-1B — derived L1 anomaly counters (Change F / E2E-30)', () => {
  test('baseline stage with no anomaly projects no counters (sparse)', () => {
    const s = statusOf(base());
    assert.equal(s.observation, undefined, 'stage-scoped default');
    assert.equal(s.scope, 'S03');
    assert.equal(s.phase, 'EXECUTE');
    assert.equal(s.counters, undefined, 'no anomaly → counters omitted entirely');
  });

  test('finding counter opens on an actionable FINDINGS without durable disposition and closes on the disposition edge', () => {
    const open = countersOf([...base(), findingFact('mes:fact:finding:S03-A:f1', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:w')]);
    assert.deepEqual(open, { finding: 1 }, 'one pending-arbitration finding opens finding=1');

    const closed = countersOf([...base(), findingFact('mes:fact:finding:S03-A:f1', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:w'), dispositionFact('mes:fact:disposition:S03-A:f1', 'S03-A', V1, 'mes:fact:finding:S03-A:f1', 'PLAN_GAP')]);
    assert.equal(closed?.finding, undefined, 'durable disposition edge closes the finding backlog');
  });

  test('finding counter counts independent open findings and is ID-order independent', () => {
    const two = countersOf([...base(), findingFact('mes:fact:finding:S03-A:f1', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:w'), findingFact('mes:fact:finding:S03-A:f2', 'S03-A', V1, 'BLOCKED', 'mes:work:S03-A:w')]);
    assert.deepEqual(two, { finding: 2 }, 'FINDINGS + BLOCKED both count as actionable backlog');
    const reversed = countersOf([...base(), findingFact('mes:fact:finding:S03-A:f2', 'S03-A', V1, 'BLOCKED', 'mes:work:S03-A:w'), findingFact('mes:fact:finding:S03-A:f1', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:w')]);
    assert.deepEqual(reversed, { finding: 2 }, 'count is permutation-invariant');
  });

  test('a PASS finding never opens the finding counter', () => {
    const pass = countersOf([...base(), findingFact('mes:fact:finding:S03-A:f1', 'S03-A', V1, 'PASS', 'mes:work:S03-A:w')]);
    assert.equal(pass, undefined, 'PASS is not actionable backlog');
  });

  test('replan counter opens on a current accepted PLAN_GAP disposition', () => {
    const replan = countersOf([...base(), findingFact('mes:fact:finding:S03-A:f1', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:w'), dispositionFact('mes:fact:disposition:S03-A:f1', 'S03-A', V1, 'mes:fact:finding:S03-A:f1', 'PLAN_GAP')]);
    assert.deepEqual(replan, { replan: 1 }, 'PLAN_GAP disposition → replan=1 (finding backlog already closed by the durable edge)');
  });

  test('replan closes when the disposition is superseded by a successor accepted generation', () => {
    const gen1 = [...base(), findingFact('mes:fact:finding:S03-A:f1', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:w'), dispositionFact('mes:fact:disposition:S03-A:f1', 'S03-A', V1, 'mes:fact:finding:S03-A:f1', 'PLAN_GAP')];
    assert.deepEqual(countersOf(gen1), { replan: 1 });

    // New accepted generation g2 supersedes g1: the g1 disposition becomes
    // non-current (generation currentness), so replan must close.
    const gen2 = [...gen1, pvr('2', V2), pa('g2', V2, 'mes:fact:plan_acceptance:S03:1')];
    const s2 = countersOf(gen2);
    assert.equal(s2?.replan, undefined, 'superseded-generation disposition no longer projects replan');
  });

  test('blocked counter counts Slices once (dependency chain descendants are not double-counted)', () => {
    // S03-A: task T1 blocked by a dependency; S03-B independent and runnable.
    const facts = [
      ...base(),
      taskFact('S03-B-T1', 'S03-B', V1, 'mes:work:S03-B:w'),
      workFact('w2', 'S03-B', V1, null),
      taskFact('S03-A-T2', 'S03-A', V1, 'mes:work:S03-A:w', 'IN_PROGRESS', 'S03-A-T1'),
    ];
    // S03-B is a second slice in the same stage; both slices belong to S03.
    const s = statusOf(facts);
    assert.equal(s.counters?.blocked, 1, 'one blocked Slice counts once regardless of chain length');
  });

  test('blocked counter opens and closes with the blocker', () => {
    const blocked = countersOf([...base(), taskFact('S03-A-T2', 'S03-A', V1, 'mes:work:S03-A:w', 'IN_PROGRESS', 'S03-A-T1')]);
    assert.deepEqual(blocked, { blocked: 1 });
    // Blocker resolved durably: the blocked task drops its blocking edge.
    const resolved = countersOf([...base(), taskFact('S03-A-T2', 'S03-A', V1, 'mes:work:S03-A:w', 'IN_PROGRESS')]);
    assert.equal(resolved?.blocked, undefined, 'blocker resolved → blocked closes');
  });

  test('cleanup counter opens on integration-without-cleanup and closes on the cleanup git fact', () => {
    const open = countersOf([...base(), gitFact('int-1', 'S03-A', V1, 'integration', 'mes:work:S03-A:w')]);
    assert.deepEqual(open, { cleanup: 1 });
    const closed = countersOf([...base(), gitFact('int-1', 'S03-A', V1, 'integration', 'mes:work:S03-A:w'), gitFact('cln-1', 'S03-A', V1, 'cleanup', 'mes:work:S03-A:w')]);
    assert.equal(closed?.cleanup, undefined, 'cleanup fact closes the obligation');
  });

  test('repair / human_required / recovery are never projected even when conditions look open', () => {
    // An IMPLEMENTATION_DEFECT disposition opens the repair CONDITION, but
    // repair has no closed durable close predicate — the key must NOT appear.
    const repairLike = countersOf([...base(), findingFact('mes:fact:finding:S03-A:f1', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:w'), dispositionFact('mes:fact:disposition:S03-A:f1', 'S03-A', V1, 'mes:fact:finding:S03-A:f1', 'IMPLEMENTATION_DEFECT')]);
    assert.equal(repairLike?.repair, undefined, 'missing repair key = no authorized projection, NOT zero');
    assert.equal(repairLike?.human_required, undefined, 'human_required never projected');
    assert.equal(repairLike?.recovery, undefined, 'recovery never projected');
  });

  test('counters survive restart: byte-rehydrated facts project identical output', () => {
    const facts = [...base(), findingFact('mes:fact:finding:S03-A:f1', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:w'), findingFact('mes:fact:finding:S03-A:f2', 'S03-A', V1, 'BLOCKED', 'mes:work:S03-A:w'), gitFact('int-1', 'S03-A', V1, 'integration', 'mes:work:S03-A:w')];
    const first = projectCycleFilteredStatus(facts);
    const rehydrated = JSON.parse(JSON.stringify(facts)) as MesFactEnvelope[];
    const second = projectCycleFilteredStatus(rehydrated);
    assert.deepEqual(second, first, 'rehydrate is byte-stable');
    assert.deepEqual(second.counters, { finding: 2, cleanup: 1 }, 'finding + cleanup co-project');
  });

  test('a superseded Work attempt does not inflate current counters', () => {
    // Old attempt Work A (task complete) superseded by Work B (current); the
    // old attempt's FINDINGS finding must not add to the current backlog.
    const oldAttempt = [pvr('1', V1), pa('1', V1, null), workFact('A', 'S03-A', V1, null), taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:A'), findingFact('mes:fact:finding:S03-A:fA', 'S03-A', V1, 'FINDINGS', 'mes:work:S03-A:A')];
    const restarted = [...oldAttempt, workFact('B', 'S03-A', V1, 'mes:fact:work:S03-A:A'), taskFact('S03-A-T1', 'S03-A', V1, 'mes:work:S03-A:B')];
    const s = statusOf(restarted);
    assert.equal(s.counters, undefined, 'old attempt FINDINGS is history; current attempt has no actionable finding');
  });

  test('M2-F1: a superseded-generation disposition does NOT close the current finding backlog (current Finding + old disposition → finding=1)', () => {
    // Gen1 carries the disposition referencing finding F; Gen2 (current)
    // carries the SAME finding F = FINDINGS. The oracle classifies the
    // old disposition relation-invalid (superseded generation) — it must
    // NEVER close the current backlog: only a current/authorizing Brain
    // arbitration edge closes `finding` (contracts §2.3).
    const gen1 = [pvr('1', V1), pa('g1', V1, null)];
    const gen2 = [pvr('2', V2), pa('g2', V2, 'mes:fact:plan_acceptance:S03:g1')];
    const wCur = workFact('wCur', 'S03-A', V2, null);
    const tCur = taskFact('S03-A-T1', 'S03-A', V2, 'mes:work:S03-A:wCur');
    const fCur = findingFact('mes:fact:finding:S03-A:F', 'S03-A', V2, 'FINDINGS', 'mes:work:S03-A:wCur');
    // Old-generation disposition referencing the current finding (misbound
    // across generations): relation-invalid, non-authorizing.
    const dOld = dispositionFact('mes:fact:disposition:S03-A:dOld', 'S03-A', V1, 'mes:fact:finding:S03-A:F', 'PLAN_GAP');
    const s = statusOf([...gen1, ...gen2, wCur, tCur, fCur, dOld]);
    assert.deepEqual(s.counters, { finding: 1 }, 'old disposition cannot close the current finding backlog');
  });
});
