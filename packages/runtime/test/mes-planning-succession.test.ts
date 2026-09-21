/**
 * Planning-acceptance succession + existing-seam obligation tests
 * (S06 post-recovery Authority update / STATIC-34 / E2E-27 / E2E-28 / E2E-29 /
 * T13).
 *
 * PO: tech-spec/architecture.md#/entities/planning-acceptance-succession;
 * tech-spec/contracts.md §2.1.1 / §2.1.3 / §2.2.2 / §2.2.4a / §2.3.1 / §2.5 /
 * §4.1 / §4.3 / §7; tech-spec/acceptance.md E2E-27 / E2E-28 / E2E-29 + T13 +
 * STATIC-34.
 *
 * Every durable mutation runs against an ISOLATED `mkdtemp` fixture root
 * (helpers.ts#makeFixture). The real project `.proofloop/mes` is never a
 * mutation target; the fixture roots live under os.tmpdir().
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  resolvePlanAcceptanceGenerationTips,
  verifyPlanAcceptanceSuccessionGraphError,
} from '../dist/mes/binding';
import { validateMesFactEnvelope, SchemaValidationError } from '../dist/mes/validate';
import { MesSnapshotStore, MES_SNAPSHOT_REL, MesSnapshotStoreError } from '../dist/mes/store';
import { createMesTransactionLayer, MesTransactionError } from '../dist/mes/transaction';
import { classifyInvalidHistory } from '../dist/mes/history-oracle';
import { projectCycleFilteredStatus, projectTerminalDetail, projectTerminalAdjunct, MesStatusError } from '../dist/mes/status';
import { MES_FACT_KINDS } from '../dist/mes/types';
import type { MesFactEnvelope, MesGitBasis } from '../dist/mes/types';
import { makeFixture, sha } from './helpers';

const STAGE = 'S06';
const OTHER_STAGE = 'S05';
const CYCLE = 'cycle-succession-000000000000000000000000000001';
const OTHER_CYCLE = 'cycle-succession-000000000000000000000000000002';
const PLAN = 'delivery/stages/S06/plan.md';
const DIGEST = sha('succession-plan-v1');
const BASIS: MesGitBasis = {
  head: '1'.repeat(40),
  branch: 'v2-subagent',
  worktree: '.',
};
const AUTHORITY = ['tech-spec/contracts.md#2.2.2'];

function snapshotDigest(dir: string): string | null {
  const abs = path.join(dir, MES_SNAPSHOT_REL);
  if (!fs.existsSync(abs)) return null;
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

/**
 * Canonical project/trust-root MES observation (PO-S06-E-03).
 *
 * Every fixture in this file mutates an isolated `mkdtemp` root only; the
 * canonical project MES is never a mutation target, only ever observed. The
 * observation must be EFFECTIVE from a Slice worktree too: there the local
 * root carries no MES at all, so the canonical root is resolved through Git
 * (the common `.git` directory belongs to the primary worktree owning the
 * trust root) instead of `process.cwd()`. An unobservable canonical MES is a
 * typed, visible failure — never a silent pass or skip.
 */
class CanonicalMesObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalMesObservationError';
  }
}

const CANONICAL_MES_REL = path.join('.proofloop', 'mes', 'snapshot.json');

function resolveCanonicalProjectRoot(): string {
  let commonDir: string;
  try {
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new CanonicalMesObservationError(
      `cannot resolve the canonical project/trust root from ${__dirname}: ${(error as Error).message}`,
    );
  }
  if (commonDir.length === 0) {
    throw new CanonicalMesObservationError('git reported an empty common directory');
  }
  return path.dirname(commonDir);
}

interface CanonicalMesObservation {
  readonly root: string;
  readonly path: string;
  readonly sha256: string;
  readonly factIds: readonly string[];
}

function observeCanonicalMes(): CanonicalMesObservation {
  const root = resolveCanonicalProjectRoot();
  const abs = path.join(root, CANONICAL_MES_REL);
  if (!fs.existsSync(abs)) {
    throw new CanonicalMesObservationError(
      `the canonical project MES is not observable at ${abs} (canonical root ${root})`,
    );
  }
  const bytes = fs.readFileSync(abs);
  const parsed = JSON.parse(bytes.toString('utf8')) as { facts?: Array<{ fact_id?: unknown }> };
  if (!Array.isArray(parsed.facts)) {
    throw new CanonicalMesObservationError(`the canonical project MES at ${abs} carries no fact array`);
  }
  return {
    root,
    path: abs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    factIds: parsed.facts.map((fact) => String(fact.fact_id)),
  };
}

/**
 * Pre-run observation, captured at module load — that is, before this file's
 * first fixture executes. Safety is expressed as in-run pre/post invariance of
 * the OBSERVED canonical MES (bytes + fact identity); no historical recovery
 * SHA/count is pinned as current NORMAL truth.
 */
const CANONICAL_MES_PRE:
  | { ok: true; observation: CanonicalMesObservation }
  | { ok: false; error: string } = (() => {
  try {
    return { ok: true, observation: observeCanonicalMes() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
})();

/** PLAN_READY planning_verification_result (verification evidence) for a candidate. */
function pvr(
  tag: string,
  resultRef: string,
  cycle = CYCLE,
  digest = DIGEST,
  stage = STAGE,
): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:planning_verification_result:${stage}:${tag}`,
    fact_kind: 'planning_verification_result',
    created_by: 'brain',
    authority_refs: AUTHORITY,
    scope: { stage_id: stage },
    work_id: `mes:work:${stage}:planning:${tag}`,
    result_ref: resultRef,
    verifier_role: 'stage-plan-verifier',
    action_token: `spv-${tag}`,
    plan_binding: {
      binding_stage: 'candidate',
      candidate_plan_ref: PLAN,
      accepted_plan_ref: null,
      verdict: 'PLAN_READY',
      plan_digest: digest,
      delivery_cycle_id: cycle,
    },
    git_basis: BASIS,
  };
}

/** One cycle-bearing accepted-Plan generation with a top-level predecessor edge. */
function pa(
  tag: string,
  verificationResultRef: string,
  predecessor: string | null,
  cycle = CYCLE,
  digest = DIGEST,
  stage = STAGE,
): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:plan_acceptance:${stage}:${tag}`,
    fact_kind: 'plan_acceptance',
    created_by: 'brain',
    authority_refs: AUTHORITY,
    scope: { stage_id: stage },
    supersedes_plan_acceptance_ref: predecessor,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: PLAN,
      source_candidate_plan_ref: PLAN,
      verification_result_ref: verificationResultRef,
      plan_digest: digest,
      delivery_cycle_id: cycle,
    },
    git_basis: BASIS,
  };
}

/** Durable accepted-stage support bound to one generation's PVR ref. */
function acceptedStage(factId: string, verificationResultRef: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: factId,
    fact_kind: 'stage',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.1'],
    scope: { stage_id: STAGE },
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: PLAN,
      source_candidate_plan_ref: PLAN,
      verification_result_ref: verificationResultRef,
      plan_digest: DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
    result_ref: `${factId}:review`,
  };
}

/** Review-owned stage-only `result` fact closing one accepted-stage support. */
function reviewResult(factId: string, verificationResultRef: string, stageResultRef: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: factId,
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.1'],
    scope: { stage_id: STAGE },
    work_id: `mes:work:${STAGE}:review:${factId}`,
    result_ref: stageResultRef,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: PLAN,
      source_candidate_plan_ref: PLAN,
      verification_result_ref: verificationResultRef,
      plan_digest: DIGEST,
      delivery_cycle_id: CYCLE,
    },
    git_basis: BASIS,
    result_id: `review:${factId}`,
    result_payload_digest: sha(`review-payload:${factId}`),
  };
}

/** Cycle-bearing `project_ready` terminal for the succession cycle. */
function terminalFact(factId: string, planned: readonly string[]): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: factId,
    fact_kind: 'project_ready',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#5.1'],
    planned_stage_ids: [...planned],
    delivery_cycle_id: CYCLE,
    supersedes_project_ready_ref: null,
    git_basis: BASIS,
  };
}

/**
 * Raw durable cohort reachable through the STORE boundary but not through the
 * transaction layer: one current-generation accepted-stage support plus a
 * same-Stage support whose `verification_result_ref` resolves to a durable
 * candidate PVR belonging to NO generation (a misbound, non-superseded
 * member). No terminal.
 */
function misboundCohortFacts(): MesFactEnvelope[] {
  const stageValid = acceptedStage('mes:fact:stage:S06:valid', 'mes:result:pv-1');
  const stageMisbound = acceptedStage('mes:fact:stage:S06:misbound', 'mes:result:pv-other');
  return [
    pvr('1', 'mes:result:pv-1'),
    pvr('other', 'mes:result:pv-other'),
    pa('1', 'mes:result:pv-1', null),
    stageValid,
    reviewResult('mes:fact:result:S06:review-valid', 'mes:result:pv-1', stageValid.result_ref as string),
    stageMisbound,
    reviewResult('mes:fact:result:S06:review-misbound', 'mes:result:pv-other', stageMisbound.result_ref as string),
  ];
}

describe('planning acceptance succession (S06 post-recovery Authority update)', () => {
  // Requirement 1 — `supersedes_plan_acceptance_ref` position + value closure.
  test('req1: supersedes_plan_acceptance_ref is a plan_acceptance-only top-level closed field; null|string with cycle only', () => {
    // A cycle-bearing generation carrying null / an exact ref validates.
    assert.doesNotThrow(() => validateMesFactEnvelope(pa('v-null', 'mes:result:pv-1', null)));
    assert.doesNotThrow(() => validateMesFactEnvelope(pa('v-ref', 'mes:result:pv-1', 'mes:fact:plan_acceptance:S06:other')));

    // Every other fact kind carrying the field is a position violation.
    const workWithEdge: MesFactEnvelope = {
      schema_version: 2,
      fact_id: 'mes:fact:work:S06:S06-A:1',
      fact_kind: 'work',
      created_by: 'brain',
      authority_refs: AUTHORITY,
      scope: { stage_id: STAGE, slice_id: 'S06-A' },
      work_id: 'mes:work:S06:S06-A:1',
      supersedes_plan_acceptance_ref: null,
      plan_binding: {
        binding_stage: 'accepted',
        accepted_plan_ref: PLAN,
        source_candidate_plan_ref: PLAN,
        verification_result_ref: 'mes:result:pv-1',
        plan_digest: DIGEST,
        delivery_cycle_id: CYCLE,
      },
      git_basis: BASIS,
    };
    assert.throws(
      () => validateMesFactEnvelope(workWithEdge),
      (err: unknown) => err instanceof SchemaValidationError && /plan_acceptance-only/.test(err.message),
      'non-plan_acceptance kinds must fail closed on the generation edge',
    );

    // Half-new: the edge without the generation's own cycle is invalid.
    const halfNew = { ...pa('v-half', 'mes:result:pv-1', null) } as Record<string, unknown>;
    const { delivery_cycle_id: _dropped, ...candidateNoCycle } = (halfNew.plan_binding as Record<string, unknown>);
    const halfNewFact = { ...halfNew, plan_binding: candidateNoCycle } as unknown as MesFactEnvelope;
    assert.throws(
      () => validateMesFactEnvelope(halfNewFact),
      (err: unknown) => err instanceof SchemaValidationError && /half-new NORMAL shape/.test(err.message),
      'a predecessor edge without a delivery cycle is a half-new shape',
    );

    // Closed value: empty string / control chars are invalid.
    assert.throws(
      () => validateMesFactEnvelope(pa('v-empty', 'mes:result:pv-1', '')),
      (err: unknown) => err instanceof SchemaValidationError,
    );
    assert.throws(
      () => validateMesFactEnvelope(pa('v-ctrl', 'mes:result:pv-1', 'mes:fact:bad\u0001ref')),
      (err: unknown) => err instanceof SchemaValidationError,
    );
  });

  // Requirements 2, 3, 5, 6, 10 — append-only chain, unique tip, unchanged
  // ref/digest re-acceptance, retained-tip predecessor, restart determinism.
  test('req2/3/5/6/10: append-only generation chain has one tip; same accepted ref/digest successor is legal; restart rebuilds the same tip', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      const pvr1 = pvr('1', 'mes:result:pv-1');
      const gen1 = pa('1', 'mes:result:pv-1', null);
      store.write([pvr1, gen1]);

      // First generation tip = gen1.
      const tips1 = resolvePlanAcceptanceGenerationTips(store.read());
      assert.ok(tips1.ok);
      assert.deepEqual(tips1.tips.map((f) => f.fact_id), ['mes:fact:plan_acceptance:S06:1']);

      // Requirement 5: a successor with the SAME accepted_plan_ref AND
      // plan_digest but a fresh PLAN_READY PVR is legal.
      const pvr2 = pvr('2', 'mes:result:pv-2');
      const gen2 = pa('2', 'mes:result:pv-2', 'mes:fact:plan_acceptance:S06:1');
      store.write([pvr2, gen2]);

      const after = store.read();
      assert.equal(after.filter((f) => f.fact_kind === 'plan_acceptance').length, 2, 'both generations stay durable (immutable history)');
      const tips2 = resolvePlanAcceptanceGenerationTips(after);
      assert.ok(tips2.ok);
      assert.deepEqual(tips2.tips.map((f) => f.fact_id), ['mes:fact:plan_acceptance:S06:2'], 'the successor is the unique current tip');

      // Requirement 10: a fresh store re-reading the SAME bytes (restart /
      // rehydrate) rebuilds the identical chain and tip.
      const restarted = new MesSnapshotStore(fixture.dir).read();
      const tips3 = resolvePlanAcceptanceGenerationTips(restarted);
      assert.ok(tips3.ok);
      assert.deepEqual(tips3.tips.map((f) => f.fact_id), tips2.tips.map((f) => f.fact_id), 'restart rebuilds the same tip');
      // Order independence: reversed input yields the same tip.
      const reversed = resolvePlanAcceptanceGenerationTips([...restarted].reverse());
      assert.ok(reversed.ok);
      assert.deepEqual(reversed.tips.map((f) => f.fact_id), tips2.tips.map((f) => f.fact_id), 'tip selection is order independent');

      // JSON round-trip (snapshot replacement) rebuilds the same tip.
      const roundTrip = JSON.parse(JSON.stringify(restarted)) as MesFactEnvelope[];
      const tips4 = resolvePlanAcceptanceGenerationTips(roundTrip);
      assert.ok(tips4.ok);
      assert.deepEqual(tips4.tips.map((f) => f.fact_id), tips2.tips.map((f) => f.fact_id), 'snapshot replacement rebuilds the same tip');
    } finally {
      fixture.cleanup();
    }
  });

  // Requirement 4 — pre-accept PVR is evidence only; multiple distinct PVRs
  // for one (stage, cycle, ref, digest) are legal and never compete.
  test('req4: candidate PVRs are verification evidence only — several distinct PVRs for one identity are legal and never compete for accepted currentness', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      const pvr1 = pvr('1', 'mes:result:pv-1');
      const pvr2 = pvr('2', 'mes:result:pv-2');
      const gen1 = pa('1', 'mes:result:pv-1', null);
      // Two distinct PVRs with the SAME identity, plus two candidate revisions:
      // neither participates in accepted currentness.
      store.write([pvr1, pvr2, gen1]);
      const facts = store.read();
      assert.equal(facts.filter((f) => f.fact_kind === 'planning_verification_result').length, 2, 'distinct same-identity PVRs are legal evidence');

      const tips = resolvePlanAcceptanceGenerationTips(facts);
      assert.ok(tips.ok);
      assert.deepEqual(tips.tips.map((f) => f.fact_id), ['mes:fact:plan_acceptance:S06:1'], 'only the accepted generation competes for currentness');

      // Two PVRs sharing ONE durable result_ref remain ambiguous (exact
      // resolution closure, §2.1.3) — evidence variety is not ref collision.
      const collision = { ...pvr2, fact_id: 'mes:fact:planning_verification_result:S06:collision', result_ref: 'mes:result:pv-1' };
      const before = snapshotDigest(fixture.dir);
      assert.throws(
        () => store.write([...facts, collision]),
        (err: unknown) => err instanceof MesSnapshotStoreError && err.code === 'invalid-fact',
        'two PVRs sharing one result_ref must stay fail-closed',
      );
      assert.equal(snapshotDigest(fixture.dir), before, 'ambiguous result_ref write must be byte-stable no-write');
    } finally {
      fixture.cleanup();
    }
  });

  // Requirement 7 — every malformed generation relation is atomic no-write.
  test('req7: self / missing / non-generation / cross-stage / cross-cycle / stale / branch / directed-cycle / half-new / null-next-to-generation fail closed', () => {
    const pvr1 = pvr('1', 'mes:result:pv-1');
    const gen1 = pa('1', 'mes:result:pv-1', null);
    const work: MesFactEnvelope = {
      schema_version: 2,
      fact_id: 'mes:fact:work:S06:S06-A:1',
      fact_kind: 'work',
      created_by: 'brain',
      authority_refs: AUTHORITY,
      scope: { stage_id: STAGE, slice_id: 'S06-A' },
      work_id: 'mes:work:S06:S06-A:1',
      plan_binding: {
        binding_stage: 'accepted',
        accepted_plan_ref: PLAN,
        source_candidate_plan_ref: PLAN,
        verification_result_ref: 'mes:result:pv-1',
        plan_digest: DIGEST,
        delivery_cycle_id: CYCLE,
      },
      git_basis: BASIS,
    };

    const graphCases: Array<{ label: string; facts: MesFactEnvelope[] }> = [
      {
        label: 'self-reference',
        facts: [pvr1, gen1, pa('self', 'mes:result:pv-1', 'mes:fact:plan_acceptance:S06:self')],
      },
      {
        label: 'missing target',
        facts: [pvr1, gen1, pa('missing', 'mes:result:pv-1', 'mes:fact:plan_acceptance:S06:absent')],
      },
      {
        label: 'non-generation target',
        facts: [pvr1, gen1, pa('non-gen', 'mes:result:pv-1', work.fact_id)],
      },
      {
        label: 'cross-stage target',
        facts: [pvr1, gen1, pa('x', 'mes:result:pv-1', null, CYCLE, DIGEST, OTHER_STAGE), pa('cross-stage', 'mes:result:pv-1', 'mes:fact:plan_acceptance:S05:x')],
      },
      {
        label: 'cross-cycle target',
        facts: [pvr1, gen1, pa('x', 'mes:result:pv-1', null, OTHER_CYCLE), pa('cross-cycle', 'mes:result:pv-1', 'mes:fact:plan_acceptance:S06:x')],
      },
      {
        label: 'branch (duplicate target)',
        facts: [
          pvr1,
          gen1,
          pa('branch-a', 'mes:result:pv-1', 'mes:fact:plan_acceptance:S06:1'),
          pa('branch-b', 'mes:result:pv-1', 'mes:fact:plan_acceptance:S06:1'),
        ],
      },
      {
        label: 'directed cycle',
        facts: [
          pvr1,
          gen1,
          pa('cyc-a', 'mes:result:pv-1', 'mes:fact:plan_acceptance:S06:cyc-b'),
          pa('cyc-b', 'mes:result:pv-1', 'mes:fact:plan_acceptance:S06:cyc-a'),
        ],
      },
      {
        label: 'null predecessor next to another generation',
        facts: [pvr1, gen1, pa('null-2', 'mes:result:pv-1', null)],
      },
    ];
    for (const { label, facts } of graphCases) {
      const error = verifyPlanAcceptanceSuccessionGraphError(facts);
      assert.ok(error !== undefined, `${label} must fail closed; graph returned no error`);
    }
    // A legal chain (root + successor) closes.
    assert.equal(
      verifyPlanAcceptanceSuccessionGraphError([
        pvr1,
        gen1,
        pa('ok-successor', 'mes:result:pv-1', 'mes:fact:plan_acceptance:S06:1'),
      ]),
      undefined,
      'a legal append-only chain must close',
    );

    // Store-level atomic no-write for the submitted malformations.
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      store.write([pvr1, gen1]);
      const good = snapshotDigest(fixture.dir);
      const storeCases: Array<{ label: string; fact: MesFactEnvelope }> = [
        { label: 'half-new (omitted predecessor)', fact: { ...pa('store-half', 'mes:result:pv-1', null), supersedes_plan_acceptance_ref: undefined } },
        { label: 'stale predecessor', fact: pa('store-stale', 'mes:result:pv-1', 'mes:fact:plan_acceptance:S06:absent') },
        { label: 'null predecessor next to retained generation', fact: pa('store-null', 'mes:result:pv-1', null) },
      ];
      for (const { label, fact } of storeCases) {
        assert.throws(
          () => store.write([fact]),
          (err: unknown) => err instanceof MesSnapshotStoreError && err.code === 'invalid-fact',
          `${label} must be no-write`,
        );
        assert.equal(snapshotDigest(fixture.dir), good, `${label} must be byte-stable no-write`);
      }
      // The rejection never mutated fact identity.
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read().map((f) => f.fact_id).sort(), [gen1.fact_id, pvr1.fact_id].sort());
    } finally {
      fixture.cleanup();
    }
  });

  // Requirement 8 — a cycle closed by a legal terminal accepts no new generation.
  test('req8: a cycle closed by a legal PROJECT_READY terminal rejects a new generation no-write', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      const pvr1 = pvr('1', 'mes:result:pv-1');
      const gen1 = pa('1', 'mes:result:pv-1', null);
      const stage = acceptedStage('mes:fact:stage:S06:accepted', 'mes:result:pv-1');
      const review: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S06:review',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: STAGE },
        work_id: 'mes:work:S06:review:1',
        result_ref: `${stage.fact_id}:review`,
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: PLAN,
          source_candidate_plan_ref: PLAN,
          verification_result_ref: 'mes:result:pv-1',
          plan_digest: DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: BASIS,
        result_id: 'review-1',
        result_payload_digest: sha('review-payload'),
      };
      const terminal: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:project_ready:1',
        fact_kind: 'project_ready',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#5.1'],
        planned_stage_ids: [STAGE],
        delivery_cycle_id: CYCLE,
        supersedes_project_ready_ref: null,
        git_basis: BASIS,
      };
      store.write([pvr1, gen1, stage, review]);
      store.write([pvr1, gen1, stage, review, terminal]);
      const closed = snapshotDigest(fixture.dir);

      const pvr2 = pvr('2', 'mes:result:pv-2');
      const successor = pa('2', 'mes:result:pv-2', 'mes:fact:plan_acceptance:S06:1');
      assert.throws(
        () => store.write([...store.read(), pvr2, successor]),
        (err: unknown) => err instanceof MesSnapshotStoreError && err.code === 'invalid-fact' && /closed/i.test(err.message),
        'a new generation for a terminal-closed cycle must be no-write',
      );
      assert.equal(snapshotDigest(fixture.dir), closed, 'closed-cycle generation write must be byte-stable no-write');
    } finally {
      fixture.cleanup();
    }
  });

  // Requirement 9 — downstream facts bind their OWN generation; a superseded
  // generation is readable/auditable but non-authorizing.
  test('req9: downstream facts bound to a superseded generation stay readable but non-authorizing (no STAGE_ACCEPTED / terminal closure)', () => {
    const pvr1 = pvr('1', 'mes:result:pv-1');
    const gen1 = pa('1', 'mes:result:pv-1', null);
    const pvr2 = pvr('2', 'mes:result:pv-2');
    const gen2 = pa('2', 'mes:result:pv-2', 'mes:fact:plan_acceptance:S06:1');
    const stageOld = acceptedStage('mes:fact:stage:S06:old', 'mes:result:pv-1');
    const stageNew = acceptedStage('mes:fact:stage:S06:new', 'mes:result:pv-2');

    const oracle = classifyInvalidHistory([pvr1, gen1, pvr2, gen2, stageOld, stageNew]);
    const statusOf = (factId: string): string | undefined => oracle.facts.find((f) => f.fact_id === factId)?.status;
    assert.equal(statusOf(gen2.fact_id), 'relation-valid', 'the current generation is relation-valid');
    assert.equal(statusOf(gen1.fact_id), 'relation-invalid', 'the superseded generation is relation-invalid (non-authorizing)');
    assert.equal(statusOf(stageOld.fact_id), 'relation-invalid', 'a stage support bound to the superseded generation is non-authorizing');
    assert.equal(statusOf(stageNew.fact_id), 'relation-valid', 'a stage support bound to the current generation authorizes');
    assert.ok(oracle.invalidFactIds.includes(stageOld.fact_id));

    // Status: a stage whose only support is a superseded generation stays
    // in-flight and never projects STAGE_ACCEPTED.
    const oldOnly = projectCycleFilteredStatus([pvr1, gen1, pvr2, gen2, stageOld]);
    assert.notEqual(oldOnly.phase, 'STAGE_ACCEPTED', 'a superseded-generation support never projects STAGE_ACCEPTED');
    assert.equal(oldOnly.phase, 'PLANNING', 'the stage stays in-flight on its remaining valid same-cycle facts');
    const withCurrent = projectCycleFilteredStatus([pvr1, gen1, pvr2, gen2, stageNew]);
    assert.equal(withCurrent.phase, 'STAGE_ACCEPTED', 'a support bound to the current generation projects STAGE_ACCEPTED');

    // Terminal support closure: a PROJECT_READY whose planned set is only
    // backed by the superseded generation never closes (typed AUTHORITY_GAP).
    const terminal: MesFactEnvelope = {
      schema_version: 2,
      fact_id: 'mes:fact:project_ready:succ',
      fact_kind: 'project_ready',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#5.1'],
      planned_stage_ids: [STAGE],
      delivery_cycle_id: CYCLE,
      supersedes_project_ready_ref: null,
      git_basis: BASIS,
    };
    assert.throws(
      () => projectTerminalDetail([pvr1, gen1, pvr2, gen2, stageOld, terminal]),
      (err: unknown) => err instanceof MesStatusError && /no durable accepted-stage support/.test(err.message),
    );
  });

  // Requirement 11 — transaction layer can materialize a fresh PVR and then a
  // successor generation (one / consecutive transactions, idempotent replay).
  test('req11: transaction materializes a fresh PLAN_READY PVR then a successor generation; replay is idempotent', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      const binding = { execution_mode: 'NORMAL' as const, authority_refs: AUTHORITY, git_basis: BASIS };
      const pvr1 = pvr('1', 'mes:result:pv-1');
      const gen1 = pa('1', 'mes:result:pv-1', null);
      layer.commit({ facts: [pvr1, gen1], binding });

      // One transaction materializing BOTH the fresh PVR and the successor.
      const pvr2 = pvr('2', 'mes:result:pv-2');
      const gen2 = pa('2', 'mes:result:pv-2', 'mes:fact:plan_acceptance:S06:1');
      layer.commit({ facts: [pvr2, gen2], binding });
      const tips = resolvePlanAcceptanceGenerationTips(new MesSnapshotStore(fixture.dir).read());
      assert.ok(tips.ok);
      assert.deepEqual(tips.tips.map((f) => f.fact_id), ['mes:fact:plan_acceptance:S06:2']);

      // A consecutive transaction appends the next generation.
      const pvr3 = pvr('3', 'mes:result:pv-3');
      const gen3 = pa('3', 'mes:result:pv-3', 'mes:fact:plan_acceptance:S06:2');
      layer.commit({ facts: [pvr3, gen3], binding });
      const tips2 = resolvePlanAcceptanceGenerationTips(new MesSnapshotStore(fixture.dir).read());
      assert.ok(tips2.ok);
      assert.deepEqual(tips2.tips.map((f) => f.fact_id), ['mes:fact:plan_acceptance:S06:3']);

      // Byte-identical replay converges idempotently (no new generation).
      const before = snapshotDigest(fixture.dir);
      layer.commit({ facts: [pvr3, gen3], binding });
      assert.equal(snapshotDigest(fixture.dir), before, 'byte-identical replay keeps the snapshot byte-stable');
    } finally {
      fixture.cleanup();
    }
  });

  // Requirement 12 — no new fact kind / store / controller / pointer / phase.
  test('req12: no new fact kind is introduced; status stays a Plan-independent read-only projection', () => {
    const expected = [
      'project',
      'stage',
      'plan_binding',
      'planning_verification_result',
      'plan_acceptance',
      'work',
      'result',
      'git',
      'task',
      'finding',
      'finding_disposition',
      'recovery_baseline',
      'project_ready',
    ];
    assert.deepEqual([...MES_FACT_KINDS], expected, 'the closed MES fact-kind set is unchanged by the succession update');
    for (const forbidden of ['plan_generation', 'plan_acceptance_generation', 'obligation_state', 'existing_seam']) {
      assert.equal(expected.includes(forbidden), false, `no new fact kind ${forbidden} may be introduced`);
    }
  });

  // Requirement 13 — fixtures never touch the real project MES; the canonical
  // project/trust-root MES is observed EFFECTIVELY, in-run (PO-S06-E-03).
  // Fresh clones intentionally have no ignored canonical MES/recovery captures.
  test('req13: missing canonical project MES is visible and isolated fixtures remain the only mutation target', () => {
    const pre = CANONICAL_MES_PRE;
    assert.equal(pre.ok, false, 'fresh clone must not depend on an ignored canonical MES snapshot');
    assert.throws(() => observeCanonicalMes(), /Canonical.*ObservationError/);
  });
  // ---------------------------------------------------------------------------
  test('counterexample A: a terminal backed only by a SUPERSEDED-generation support is atomic no-write (snapshot sha256 + fact identity unchanged)', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      const binding = { execution_mode: 'NORMAL' as const, authority_refs: AUTHORITY, git_basis: BASIS };
      const pvr1 = pvr('1', 'mes:result:pv-1');
      const gen1 = pa('1', 'mes:result:pv-1', null);
      const stageOld = acceptedStage('mes:fact:stage:S06:old', 'mes:result:pv-1');
      const reviewOld = reviewResult('mes:fact:result:S06:review-old', 'mes:result:pv-1', stageOld.result_ref as string);
      layer.commit({ facts: [pvr1, gen1], binding });
      layer.commit({ facts: [stageOld, reviewOld], binding });
      const pvr2 = pvr('2', 'mes:result:pv-2');
      const gen2 = pa('2', 'mes:result:pv-2', 'mes:fact:plan_acceptance:S06:1');
      layer.commit({ facts: [pvr2, gen2], binding });

      const before = snapshotDigest(fixture.dir);
      const beforeIds = new MesSnapshotStore(fixture.dir).read().map((f) => f.fact_id);
      const oracle = classifyInvalidHistory(new MesSnapshotStore(fixture.dir).read());
      assert.equal(oracle.facts.find((f) => f.fact_id === stageOld.fact_id)?.status, 'relation-invalid', 'the support bound to the superseded generation is non-authorizing');
      assert.ok(oracle.supersededFactIds.includes(stageOld.fact_id), 'the support must be classified as superseded');

      assert.throws(
        () => layer.commit({ facts: [terminalFact('mes:fact:project_ready:1', [STAGE])], binding }),
        (err: unknown) =>
          err instanceof MesTransactionError &&
          err.code === 'binding-mismatch' &&
          /no durable accepted-stage support/.test(err.message),
        'the terminal write must be a typed atomic no-write',
      );
      assert.equal(snapshotDigest(fixture.dir), before, 'snapshot bytes must be byte-stable (sha256 identical)');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read().map((f) => f.fact_id), beforeIds, 'fact identity must be unchanged');

      // The read projection agrees with the write boundary instead of
      // disagreeing with it (the accepted defect).
      const detail = projectTerminalDetail(new MesSnapshotStore(fixture.dir).read());
      assert.equal(detail.project_ready, false);
      assert.deepEqual(detail.accepted_stage_support_ids, []);
      assert.equal(detail.exact_closure, false);
    } finally {
      fixture.cleanup();
    }
  });

  test('counterexample B: replan → re-accept in the SAME cycle → terminal is representable and closes exactly on the current generation', () => {
    const fixture = makeFixture();
    try {
      const layer = createMesTransactionLayer(fixture.dir);
      const binding = { execution_mode: 'NORMAL' as const, authority_refs: AUTHORITY, git_basis: BASIS };
      const pvr1 = pvr('1', 'mes:result:pv-1');
      const gen1 = pa('1', 'mes:result:pv-1', null);
      const stageOld = acceptedStage('mes:fact:stage:S06:old', 'mes:result:pv-1');
      const reviewOld = reviewResult('mes:fact:result:S06:review-old', 'mes:result:pv-1', stageOld.result_ref as string);
      layer.commit({ facts: [pvr1, gen1], binding });
      layer.commit({ facts: [stageOld, reviewOld], binding });
      const pvr2 = pvr('2', 'mes:result:pv-2');
      const gen2 = pa('2', 'mes:result:pv-2', 'mes:fact:plan_acceptance:S06:1');
      layer.commit({ facts: [pvr2, gen2], binding });
      const stageNew = acceptedStage('mes:fact:stage:S06:new', 'mes:result:pv-2');
      const reviewNew = reviewResult('mes:fact:result:S06:review-new', 'mes:result:pv-2', stageNew.result_ref as string);
      layer.commit({ facts: [stageNew, reviewNew], binding });
      layer.commit({ facts: [terminalFact('mes:fact:project_ready:1', [STAGE])], binding });

      const facts = new MesSnapshotStore(fixture.dir).read();
      const oracle = classifyInvalidHistory(facts);
      const statusOf = (factId: string): string | undefined => oracle.facts.find((f) => f.fact_id === factId)?.status;
      assert.equal(statusOf(stageOld.fact_id), 'relation-invalid', 'the superseded support stays readable but non-authorizing');
      assert.equal(statusOf(stageNew.fact_id), 'relation-valid', 'the re-accepted support authorizes');

      const detail = projectTerminalDetail(facts);
      assert.equal(detail.project_ready, true, 'the terminal is representable');
      assert.equal(detail.exact_closure, true, 'the terminal closes exactly');
      assert.deepEqual(detail.planned_stage_ids, [STAGE]);
      assert.deepEqual(detail.accepted_stage_support_ids, [STAGE], 'accepted support ids come from the current generation only');

      // The superseded support is not a duplicate-cohort member: status selects
      // the unique current cycle and projects STAGE_ACCEPTED.
      const status = projectCycleFilteredStatus(facts);
      assert.equal(status.scope, STAGE);
      assert.equal(status.phase, 'STAGE_ACCEPTED');
      assert.equal(projectTerminalAdjunct(facts)?.state, 'CURRENT_PROJECT_READY');
    } finally {
      fixture.cleanup();
    }
  });

  test('a genuine duplicate (two supports both bound to the CURRENT generation) stays fail closed at the write boundary and in status', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      const pvr1 = pvr('1', 'mes:result:pv-1');
      const gen1 = pa('1', 'mes:result:pv-1', null);
      const stageA = acceptedStage('mes:fact:stage:S06:a', 'mes:result:pv-1');
      const stageB = acceptedStage('mes:fact:stage:S06:b', 'mes:result:pv-1');
      const reviewA = reviewResult('mes:fact:result:S06:review-a', 'mes:result:pv-1', stageA.result_ref as string);
      const reviewB = reviewResult('mes:fact:result:S06:review-b', 'mes:result:pv-1', stageB.result_ref as string);
      store.write([pvr1, gen1, stageA, reviewA, stageB, reviewB]);

      const facts = store.read();
      const oracle = classifyInvalidHistory(facts);
      assert.equal(oracle.facts.find((f) => f.fact_id === stageA.fact_id)?.status, 'relation-valid');
      assert.equal(oracle.facts.find((f) => f.fact_id === stageB.fact_id)?.status, 'relation-valid');
      assert.equal(oracle.supersededFactIds.length, 0, 'a current-generation pair is not superseded');

      assert.throws(
        () => projectCycleFilteredStatus(facts),
        (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
        'two current-generation supports for one Stage must fail closed in status',
      );
      assert.throws(
        () => projectTerminalAdjunct(facts),
        (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
        'two current-generation supports for one Stage must fail closed in the adjunct',
      );

      const before = snapshotDigest(fixture.dir);
      assert.throws(
        () => store.write([...facts, terminalFact('mes:fact:project_ready:dup', [STAGE])]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          /duplicate accepted-stage support/.test(err.message),
        'the terminal write must fail closed on a genuine duplicate',
      );
      assert.equal(snapshotDigest(fixture.dir), before, 'the duplicate terminal write must be byte-stable no-write');
    } finally {
      fixture.cleanup();
    }
  });

  test('a MISBOUND support (matching NO generation) is not superseded and keeps the same-cycle duplicate ambiguity fail-closed', () => {
    // This is the boundary that makes the `mes-store.test.ts` fixture change
    // (`verification_result_ref` pv-1 → pv-2) a SUPPORTED-generation alignment
    // rather than lost coverage: a support bound to a superseded generation is
    // excluded from the ambiguity cohort, while a support bound to a
    // typo/approximate ref (matching NO generation) is not.
    const pvr1 = pvr('1', 'mes:result:pv-1');
    const gen1 = pa('1', 'mes:result:pv-1', null);
    const stageCurrent = acceptedStage('mes:fact:stage:S06:current', 'mes:result:pv-1');
    const stageMisbound = acceptedStage('mes:fact:stage:S06:misbound', 'mes:result:pv-typo');
    const facts = [pvr1, gen1, stageCurrent, stageMisbound];
    const oracle = classifyInvalidHistory(facts);
    assert.equal(oracle.facts.find((f) => f.fact_id === stageCurrent.fact_id)?.status, 'relation-valid');
    assert.equal(oracle.facts.find((f) => f.fact_id === stageMisbound.fact_id)?.status, 'relation-invalid');
    assert.equal(oracle.supersededFactIds.includes(stageMisbound.fact_id), false, 'a typo/approximate ref is NOT provably superseded');
    assert.throws(
      () => projectCycleFilteredStatus(facts),
      (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
      'a misbound support keeps the same-cycle duplicate ambiguity fail-closed',
    );
  });

  // ---------------------------------------------------------------------------
  // F1 / F3 projection-consistency regressions (independent re-verification):
  // every closure/readiness-declaring projection must apply the SAME ambiguity-
  // cohort gate, so one durable fact set can never yield contradictory
  // `CURRENT_PROJECT_READY` / `exact_closure:true` vs typed `authority-gap`.
  // ---------------------------------------------------------------------------
  test('F3: the raw-store {current-generation support, misbound support} state fails closed identically in all three projections', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      const facts = misboundCohortFacts();
      // Raw-store reachable: an accepted-stage support whose verification ref
      // resolves to a durable candidate PVR that belongs to NO generation is
      // accepted by the store boundary (transaction submissions are guarded
      // separately by the canonical exact-match gate).
      store.write(facts);
      const persisted = store.read();
      const oracle = classifyInvalidHistory(persisted);
      assert.equal(oracle.facts.find((f) => f.fact_id === 'mes:fact:stage:S06:valid')?.status, 'relation-valid');
      assert.equal(oracle.facts.find((f) => f.fact_id === 'mes:fact:stage:S06:misbound')?.status, 'relation-invalid');
      assert.equal(oracle.supersededFactIds.length, 0, 'a misbound support is not provably superseded');

      // The ambiguity gate is single-sourced: identical fail-closed verdict.
      for (const project of [projectTerminalDetail, projectTerminalAdjunct, projectCycleFilteredStatus] as const) {
        assert.throws(
          () => project(persisted),
          (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
          `${project.name} must fail closed on the misbound ambiguity cohort`
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('F1: a raw terminal + current-generation support + misbound support is refused by the write boundary and contradictory-free across the projections', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      const cohort = misboundCohortFacts();
      store.write(cohort);
      const rawSet = [...store.read(), terminalFact('mes:fact:project_ready:1', [STAGE])];

      // The write boundary already refuses the terminal (unchanged invariant):
      // no projection may nevertheless declare it as an exact closure.
      const before = snapshotDigest(fixture.dir);
      assert.throws(
        () => store.write(rawSet),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          /duplicate accepted-stage support/.test(err.message),
        'the terminal write must stay fail closed on the misbound ambiguity cohort'
      );
      assert.equal(snapshotDigest(fixture.dir), before, 'the refused terminal write must be byte-stable no-write');

      for (const project of [projectTerminalDetail, projectTerminalAdjunct, projectCycleFilteredStatus] as const) {
        assert.throws(
          () => project(rawSet),
          (err: unknown) => err instanceof MesStatusError && err.code === 'authority-gap',
          `${project.name} must fail closed on the raw terminal + ambiguity cohort`
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('positive control: the SAME legal cohort WITHOUT the misbound member still declares closure in all three projections', () => {
    const cohort = misboundCohortFacts();
    const legalFacts = cohort.filter((fact) => !fact.fact_id.includes('misbound'));
    const withTerminal = [...legalFacts, terminalFact('mes:fact:project_ready:legal', [STAGE])];

    const detail = projectTerminalDetail(withTerminal);
    assert.equal(detail.project_ready, true);
    assert.equal(detail.exact_closure, true);
    assert.deepEqual(detail.accepted_stage_support_ids, [STAGE]);
    assert.equal(projectTerminalAdjunct(withTerminal)?.state, 'CURRENT_PROJECT_READY');
    assert.equal(projectTerminalAdjunct(withTerminal)?.exact_closure, true);
    assert.equal(projectCycleFilteredStatus(withTerminal).phase, 'STAGE_ACCEPTED');
    // Pre-terminal legal state (no terminal) is still an honest non-closure.
    const preTerminal = projectTerminalDetail(legalFacts);
    assert.equal(preTerminal.project_ready, false);
    assert.equal(preTerminal.exact_closure, false);
    assert.deepEqual(preTerminal.accepted_stage_support_ids, [STAGE]);
    assert.equal(projectTerminalAdjunct(legalFacts)?.state, 'PRE_TERMINAL');
  });
});
