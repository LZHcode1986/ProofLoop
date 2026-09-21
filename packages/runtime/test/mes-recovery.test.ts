/**
 * MES planning-fact recovery & replay tests (S02-C-T01 / S02-C-T02).
 *
 * # PO: PO-S02-C-01, PO-S02-C-02
 *
 * Exercises the NORMAL Planning durable-fact recovery closure on top of the
 * S01 atomic snapshot store and the S02-A Map-entry seam:
 *   - planning_verification_result / plan_acceptance facts written through one
 *     store instance are deterministically rehydrated by a NEW store instance
 *     (restart) with binding intact, and the verified Map entry is rebuilt from
 *     the durable planning fact + the candidate Plan's `project_stage_map_ref`
 *     + `git_basis.head` via the S02-A seam (resolveStageMapEntry) — a failed
 *     rebuild surfaces as a typed StageMapResolutionError carrying contracts §7
 *     `PLAN_GAP` semantics and never falls back to MES status / any other
 *     projection (PO-S02-C-01; FR-009 / HP-004 / STATIC-08);
 *   - same fact/binding/payload replay is idempotent (the acceptance fact is
 *     never duplicated), a different payload under the same fact_id is rejected
 *     no-write (contracts §7 `RESULT_INVALID` typology), a binding that cannot
 *     close never writes, Agent narrative / Link metadata / pane state are not
 *     fact content, and no second result store / Receipt / Manifest is created
 *     (PO-S02-C-02; FR-014 / STATIC-08 / STATIC-14).
 *
 * Recovery inputs come ONLY from durable facts: the MES snapshot plus the
 * Git-tracked candidate Plan + Map read at the fact's own `git_basis.head`
 * (same candidate Git basis). No hidden session / Agent metadata / narrative
 * is consulted. All tests use only temporary Git fixtures (helpers.ts) and
 * never touch the work clone's Git state. Imports the compiled runtime dist
 * (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  MesSnapshotStore,
  createMesSnapshotStore,
  MesSnapshotStoreError,
  MES_SNAPSHOT_REL,
} from '../dist/mes/store';
import {
  resolveStageMapEntry,
  StageMapResolutionError,
  CANONICAL_PROJECT_STAGE_MAP_PATH,
} from '../dist/vnext/stage-map';
import type { StageMapEntry } from '../dist/vnext/stage-map';
import { readGitHead } from '../dist/git-source';
import { verifyAcceptedStageReviewResultSupport } from '../dist/mes/binding';
import { canonicalStringify } from '../dist/cli/proofloop-common';
import { makeFixture, commitAll } from './helpers';
import type { Fixture } from './helpers';
import type { MesFactEnvelope } from '../dist/mes/store';

const PLAN_REF = 'delivery/stages/S02/plan.md';
const MAP_REF = `${CANONICAL_PROJECT_STAGE_MAP_PATH}#S02`;
const VERIFICATION_REF = 'mes:verification:S02:1';
const PLANNING_WORK_ID = 'mes:work:S02:planning:1';
const ACTION_TOKEN = 'a3723162-97d8-4a91-8625-faea5c0d82b9';
const DIGEST = 'c'.repeat(64);
const CYCLE = 'cycle-d4c1e9a7f6b3c8d2e5f4a1b9c7d3e8f6a2';

/** The Git-tracked candidate Thin Plan at git_basis.head (fixture content). */
const PLAN_MARKDOWN = `# S02 Candidate Thin Plan — NORMAL Planning durable 支撑

- stage: \`S02\`
- project_stage_map_ref: \`${MAP_REF}\`
`;

const MAP_HEADER = '| Stage | depends_on | 目标（独立交付 outcome） | entry criteria | Authority refs |';
const MAP_SEPARATOR = '|---|---|---|---|---|';

/** A canonical Map fixture mirroring the real artifact's machine shape (§4.0). */
function mapMarkdown(goalOverride?: string): string {
  return `# Project Stage Map — ProofLoop v2（公共 Rolling-Wave Planning artifact）

> Map 只保存计划事实（Stage id / depends_on / goal / entry criteria / Authority refs），
> 不缓存 operational readiness（STATIC-22）。

${MAP_HEADER}
${MAP_SEPARATOR}
| S01 | \`PROPOSE_READY\` + clean Git baseline | MES durable facts 基础 | \`PROPOSE_READY\` 已确认 | PRD#FR-003/004/005/009/011 |
| S02 | S01 \`STAGE_ACCEPTED\`（MES seed 完成） | ${goalOverride ?? 'NORMAL Rolling-Wave Planning 支撑：Map-entry 重建 seam + planning durable facts'} | S01 已 \`STAGE_ACCEPTED\`；build + 现有测试基线 green | PRD#FR-003/004/005/009/011/013/014；contracts#2.2.2、4.0/4.1/4.2、5.1、6.0、7 |
`;
}

function candidateBinding(verdict: 'PLAN_READY' | 'FINDINGS' | 'BLOCKED' = 'PLAN_READY') {
  return {
    binding_stage: 'candidate' as const,
    candidate_plan_ref: PLAN_REF,
    accepted_plan_ref: null,
    verdict,
    plan_digest: DIGEST,
  };
}

function acceptedBinding() {
  return {
    binding_stage: 'accepted' as const,
    accepted_plan_ref: PLAN_REF,
    source_candidate_plan_ref: PLAN_REF,
    verification_result_ref: VERIFICATION_REF,
    plan_digest: DIGEST,
  };
}

function gitBasis(head: string) {
  return { head, branch: 'proofloop-s02-c', worktree: '.' };
}

/** A durable `planning_verification_result` fact (Brain accepts an SPV reply). */
function verificationFact(head: string, verdict: 'PLAN_READY' | 'FINDINGS' | 'BLOCKED' = 'PLAN_READY'): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:planning_verification_result:S02:1',
    fact_kind: 'planning_verification_result',
    created_by: 'brain',
    authority_refs: ['PRD.md#FR-005'],
    scope: { stage_id: 'S02' },
    work_id: PLANNING_WORK_ID,
    result_ref: VERIFICATION_REF,
    verifier_role: 'stage-plan-verifier',
    action_token: ACTION_TOKEN,
    plan_binding: { ...candidateBinding(verdict), delivery_cycle_id: CYCLE },
    git_basis: gitBasis(head),
  };
}

/** The promoted durable `plan_acceptance` fact (only after a PLAN_READY reply). */
function acceptanceFact(head: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:plan_acceptance:S02:1',
    fact_kind: 'plan_acceptance',
    created_by: 'brain',
    authority_refs: ['PRD.md#FR-005'],
    scope: { stage_id: 'S02' },
    supersedes_plan_acceptance_ref: null,
    plan_binding: { ...acceptedBinding(), delivery_cycle_id: CYCLE },
    git_basis: gitBasis(head),
  };
}

/**
 * A `planning_verification_result` fact with a caller-chosen id + durable
 * result ref (used to probe FINDINGS/BLOCKED support without reusing the
 * canonical fact ids of other tests).
 */
function verificationVariant(
  head: string,
  factId: string,
  resultRef: string,
  verdict: 'PLAN_READY' | 'FINDINGS' | 'BLOCKED' = 'PLAN_READY',
): MesFactEnvelope {
  return {
    ...verificationFact(head, verdict),
    fact_id: factId,
    result_ref: resultRef,
  };
}

/** A `plan_acceptance` fact with a caller-chosen id referencing a durable ref. */
function acceptanceRef(head: string, factId: string, verificationRef: string): MesFactEnvelope {
  return {
    ...acceptanceFact(head),
    fact_id: factId,
    plan_binding: { ...acceptedBinding(), verification_result_ref: verificationRef, delivery_cycle_id: CYCLE },
  };
}

/**
 * A `plan_acceptance` fact with a caller-chosen id and mutated binding/basis,
 * so relation probes never collide with an existing fact_id (which would
 * trigger the cross-submission conflict gate instead of the relation gate).
 */
function planAcceptanceWith(
  head: string,
  factId: string,
  mutate: (binding: ReturnType<typeof acceptedBinding>) => ReturnType<typeof acceptedBinding> = (b) => b,
  basis: ReturnType<typeof gitBasis> | undefined = undefined,
): MesFactEnvelope {
  return {
    ...acceptanceFact(head),
    fact_id: factId,
    plan_binding: { ...mutate(acceptedBinding()), delivery_cycle_id: CYCLE },
    git_basis: basis ?? gitBasis(head),
  };
}

/** A non-planning seed-owned fact (bootstrap seed shape), e.g. plan_binding. */
function seedPlanBindingFact(digest: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:plan_binding:S01',
    fact_kind: 'plan_binding',
    created_by: 'brain',
    authority_refs: ['PRD.md#FR-005'],
    plan_binding: { ...acceptedBinding(), plan_digest: digest },
  };
}

/** Raw bytes of the durable snapshot (byte-stability / no-write probes). */
function snapshotBytes(fixture: Fixture): string {
  return fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');
}


/** Read a Git-tracked file's blob at an exact commit (same candidate Git basis). */
function readAtHead(fixture: Fixture, head: string, rel: string): string {
  return fixture.run(['show', `${head}:${rel}`]);
}

/** Extract the candidate Plan's `project_stage_map_ref` (fixture grammar). */
function extractMapRef(planMarkdown: string): string {
  const match = planMarkdown.match(/- project_stage_map_ref: `([^`]+)`/);
  assert.ok(match, 'fixture plan must carry a project_stage_map_ref line');
  return match![1];
}

/**
 * Recovery composition (PO-S02-C-01 / CV F1): rebuild the verified Map entry
 * from the durable planning fact alone. The read basis is DERIVED from the
 * fact's own `git_basis.head` — never from a caller-supplied basis or the
 * current worktree — and the Git-tracked Plan + Map texts are read at that
 * same head. This mirrors what Brain/SPV do after restart; no MES status /
 * projection is consulted.
 */
function rebuildMapEntry(fact: MesFactEnvelope, fixture: Fixture): StageMapEntry {
  const binding = fact.plan_binding!;
  const planRef =
    binding.binding_stage === 'candidate' ? binding.candidate_plan_ref : binding.accepted_plan_ref;
  const head = fact.git_basis!.head; // read basis comes ONLY from the durable fact
  const planMarkdown = readAtHead(fixture, head, planRef);
  const mapRef = extractMapRef(planMarkdown);
  const mapMarkdown = readAtHead(fixture, head, CANONICAL_PROJECT_STAGE_MAP_PATH);
  return resolveStageMapEntry(mapMarkdown, mapRef);
}

/** List every file under a fixture's `.proofloop` (STATIC-14 probe). */
function proofloopFiles(root: string): string[] {
  const base = path.join(root, '.proofloop');
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`.replace(/^\//, '');
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(base, '');
  return out.sort();
}

describe('MES planning-fact recovery (S02-C-T01)', () => {
  test('rehydrates planning facts and reconstructs the map basis after restart', () => {
    const fixture = makeFixture();
    try {
      // Seed a candidate Plan + canonical Map at one Git basis (head H).
      fixture.write('delivery/stages/S02/plan.md', PLAN_MARKDOWN);
      fixture.write(CANONICAL_PROJECT_STAGE_MAP_PATH, mapMarkdown());
      const head = commitAll(fixture, 'candidate plan + active map');
      assert.equal(head, readGitHead(fixture.dir), 'fixture HEAD must be the recorded git basis');

      // Brain accepts the SPV reply: write the two durable planning facts.
      const facts: MesFactEnvelope[] = [verificationFact(head), acceptanceFact(head)];
      const writer = createMesSnapshotStore(fixture.dir);
      writer.write(facts);

      // Restart: a NEW store instance deterministically rehydrates the same
      // validated set with the typed bindings intact (PO-S02-C-01).
      const reader = new MesSnapshotStore(fixture.dir);
      const rehydrated = reader.read();
      assert.equal(rehydrated.length, 2);
      assert.deepEqual(rehydrated, facts, 'planning facts must round-trip with binding unchanged');

      const verification = rehydrated.find((f) => f.fact_kind === 'planning_verification_result')!;
      const acceptance = rehydrated.find((f) => f.fact_kind === 'plan_acceptance')!;
      assert.equal(verification.plan_binding!.binding_stage, 'candidate');
      assert.equal((verification.plan_binding! as { accepted_plan_ref: unknown }).accepted_plan_ref, null);
      assert.equal((verification.plan_binding! as { verdict: string }).verdict, 'PLAN_READY');
      assert.equal(verification.verifier_role, 'stage-plan-verifier');
      assert.equal(verification.git_basis!.head, head);
      assert.equal(acceptance.plan_binding!.binding_stage, 'accepted');
      assert.equal(acceptance.plan_binding!.accepted_plan_ref, PLAN_REF);
      assert.equal(acceptance.plan_binding!.source_candidate_plan_ref, PLAN_REF);

      // Deterministic: further fresh instances and repeated reads agree.
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), rehydrated);
      assert.deepEqual(reader.read(), rehydrated);

      // Rebuild the verified Map entry from the durable fact + the Map/Plan
      // text at the fact's own Git basis (no MES status / projection input).
      const entry = rebuildMapEntry(verification, fixture);
      assert.equal(entry.stage_id, 'S02', 'entry stage id must equal the referenced stage id');
      assert.ok(entry.depends_on.includes('STAGE_ACCEPTED'));
      assert.ok(entry.goal.includes('Map-entry 重建 seam'));

      // The rebuilt entry is stable across the re-read acceptance fact too.
      const viaAcceptance = rebuildMapEntry(acceptance, fixture);
      assert.deepEqual(viaAcceptance, entry);

      // Same-basis closure: after a LATER commit changes the Map (head H2),
      // rebuilding from the durable fact (bound to head H) still yields the
      // H-basis entry — recovery never uses the current worktree as authority.
      fixture.write(CANONICAL_PROJECT_STAGE_MAP_PATH, mapMarkdown('REVISED goal at a later basis'));
      const laterHead = commitAll(fixture, 'map revision at a later basis');
      assert.notEqual(laterHead, head);
      const fromFactBasis = rebuildMapEntry(verification, fixture);
      assert.deepEqual(fromFactBasis, entry, 'rebuild must stay bound to the fact git_basis.head');

      // MUTATION PROBE (TDD RED, CV F1): the recovery oracle must derive the
      // read basis from the durable fact's own git_basis.head — never from a
      // caller-supplied basis or the current worktree. Probe 1: a fact bound
      // to the LATER basis must rebuild the LATER Map entry; serving the
      // original basis must not defeat that. Probe 2: a fact whose
      // git_basis.head is an unresolvable commit must fail closed (the blob
      // cannot be read at that basis) — a rebuild that ignores the fact basis
      // would silently succeed.
      const factBoundToLater = {
        ...verification,
        git_basis: { ...verification.git_basis!, head: laterHead },
      } as MesFactEnvelope;
      const laterEntry = rebuildMapEntry(factBoundToLater, fixture);
      assert.ok(
        laterEntry.goal.includes('REVISED goal at a later basis'),
        'rebuild must read the Map at the fact git_basis.head, not the external basis',
      );

      const phantomFact = {
        ...verification,
        git_basis: { ...verification.git_basis!, head: 'f'.repeat(40) },
      } as MesFactEnvelope;
      assert.throws(
        () => rebuildMapEntry(phantomFact, fixture),
        Error,
        'rebuild must consult fact.git_basis.head: an unresolvable fact basis must fail closed',
      );

      // Failure closure (contracts §7): a fact bound to a basis whose Map has
      // no entry for the referenced stage returns a typed PLAN_GAP error — it
      // is never papered over with status or any other projection.
      const mapWithoutS02 = mapMarkdown().replace('| S02 |', '| S99 |');
      fixture.write(CANONICAL_PROJECT_STAGE_MAP_PATH, mapWithoutS02);
      const brokenHead = commitAll(fixture, 'map without S02 entry');
      const factAtBrokenBasis = {
        ...verification,
        git_basis: { ...verification.git_basis!, head: brokenHead },
      } as MesFactEnvelope;
      assert.throws(
        () => rebuildMapEntry(factAtBrokenBasis, fixture),
        (err: unknown) =>
          err instanceof StageMapResolutionError &&
          err.code === 'MAP_UNKNOWN_ENTRY' &&
          err.message.includes('PLAN_GAP'),
        'unknown stage entry at the fact basis must surface as a typed PLAN_GAP failure, not a status/projection fallback',
      );

      // Missing/empty Map text at the fact's basis also fails closed.
      fixture.write(CANONICAL_PROJECT_STAGE_MAP_PATH, '');
      const emptyHead = commitAll(fixture, 'map emptied');
      const factAtEmptyBasis = {
        ...verification,
        git_basis: { ...verification.git_basis!, head: emptyHead },
      } as MesFactEnvelope;
      assert.throws(
        () => rebuildMapEntry(factAtEmptyBasis, fixture),
        (err: unknown) => err instanceof StageMapResolutionError && err.code === 'MAP_MISSING',
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe('MES planning-fact replay & evidence discipline (S02-C-T02)', () => {
  test('replays idempotently and rejects conflicting planning facts without agent metadata', () => {
    const fixture = makeFixture();
    try {
      fixture.write('delivery/stages/S02/plan.md', PLAN_MARKDOWN);
      fixture.write(CANONICAL_PROJECT_STAGE_MAP_PATH, mapMarkdown());
      const head = commitAll(fixture, 'candidate plan + active map');

      const writer = createMesSnapshotStore(fixture.dir);
      const facts: MesFactEnvelope[] = [verificationFact(head), acceptanceFact(head)];

      // Seed the last valid snapshot.
      writer.write(facts);
      const seeded = new MesSnapshotStore(fixture.dir).read();
      assert.deepEqual(seeded, facts);

      // Idempotent replay: the SAME fact/binding/payload set submitted again
      // returns the same disposition (success) and must never duplicate the
      // completion/acceptance — the snapshot stays byte-identical.
      writer.write(facts);
      const afterReplay = new MesSnapshotStore(fixture.dir).read();
      assert.deepEqual(afterReplay, seeded, 'replay must yield the same fact set');
      assert.equal(
        afterReplay.filter((f) => f.fact_kind === 'plan_acceptance').length,
        1,
        'replay must not duplicate the acceptance fact',
      );

      // An identical duplicate entry inside one submission collapses to one
      // (same disposition, no duplicate acceptance written).
      writer.write([...facts, acceptanceFact(head)]);
      const afterDuplicateEntry = new MesSnapshotStore(fixture.dir).read();
      assert.equal(
        afterDuplicateEntry.length,
        facts.length,
        'identical duplicate fact entries must collapse (idempotent)',
      );
      assert.deepEqual(afterDuplicateEntry, facts);

      // Conflict no-write (contracts §7 RESULT_INVALID typology): one
      // submission carrying the same fact_id with a DIFFERENT payload
      // (conflicting verdict) is rejected before any file is touched — the
      // last valid snapshot stays intact.
      const conflicting: MesFactEnvelope[] = [
        verificationFact(head),
        verificationFact(head, 'FINDINGS'),
      ];
      assert.throws(
        () => writer.write(conflicting),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'conflicting planning fact payload must be rejected no-write',
      );
      assert.deepEqual(
        new MesSnapshotStore(fixture.dir).read(),
        facts,
        'conflict rejection must not clobber the last valid snapshot',
      );

      // Same fact_id, different payload via a mutated git basis also no-writes.
      const conflictedBasis = {
        ...verificationFact(head),
        git_basis: { head: 'f'.repeat(40), branch: 'other', worktree: '.' },
      };
      assert.throws(
        () => writer.write([verificationFact(head), conflictedBasis as MesFactEnvelope]),
        MesSnapshotStoreError,
      );
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), facts);

      // A binding that cannot close never writes: pre-accept verification
      // smuggling an accepted binding (or missing machinery) is rejected and
      // leaves the valid snapshot untouched.
      const badBinding: MesFactEnvelope = {
        ...verificationFact(head),
        plan_binding: {
          binding_stage: 'accepted' as const,
          accepted_plan_ref: PLAN_REF,
          source_candidate_plan_ref: PLAN_REF,
          verification_result_ref: VERIFICATION_REF,
        },
      };
      assert.throws(() => writer.write([badBinding]), MesSnapshotStoreError);
      const missingRole: MesFactEnvelope = {
        ...verificationFact(head),
        verifier_role: undefined as unknown as string,
      };
      assert.throws(() => writer.write([missingRole]), MesSnapshotStoreError);
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), facts);

      // Agent narrative / Link metadata / pane state are NOT fact content
      // (FR-014 / STATIC-08): any envelope carrying them fails closed at the
      // closed-field envelope boundary, so they can never be persisted.
      const smuggled: MesFactEnvelope = {
        ...verificationFact(head),
        agent_name: 'worker-3',
        link_message_id: 'hl_mto4ah38_1a3otrrr',
        pane_session: 'pane-7',
        checkbox: true,
      } as MesFactEnvelope;
      assert.throws(() => writer.write([smuggled]), MesSnapshotStoreError);
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), facts);

      // The rehydrated facts carry exactly the business binding — no transport
      // metadata keys survive.
      const rehydrated = new MesSnapshotStore(fixture.dir).read();
      for (const fact of rehydrated) {
        for (const key of Object.keys(fact)) {
          assert.ok(
            !/agent|link|pane|session|message|checkbox|dialogue/i.test(key),
            `recovered fact must not carry transport metadata key ${key}`,
          );
        }
      }

      // STATIC-14: the MES snapshot is the ONLY durable store — no Receipt /
      // Manifest / second result store is ever created under .proofloop.
      assert.deepEqual(
        proofloopFiles(fixture.dir),
        [MES_SNAPSHOT_REL.replace(/\\/g, '/').replace(/^\.proofloop\//, '')],
        'the snapshot must be the only file persisted under .proofloop (no Receipt/Manifest/second store)',
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe('MES planning-fact relational binding & cross-write replay integrity (S02-SR-F001 / PO-S02-C-02)', () => {
  const H1 = '1'.repeat(40);
  const H2 = '2'.repeat(40);

  test('rejects an acceptance whose verification ref is missing or not PLAN_READY (no-write)', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);

      // A durable plan_acceptance is accepted ONLY when its
      // verification_result_ref resolves to a durable PLAN_READY
      // planning_verification_result in the submitted set or current valid
      // snapshot — an unbacked acceptance on an empty store fails closed and
      // writes nothing (S02-SR-F001 / AC1).
      assert.throws(
        () => store.write([acceptanceFact(H1)]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'an acceptance without any durable PLAN_READY verification must be rejected no-write',
      );
      assert.deepEqual(store.read(), [], 'rejected acceptance must leave the store empty');

      // FINDINGS / BLOCKED support can never underpin an acceptance.
      for (const verdict of ['FINDINGS', 'BLOCKED'] as const) {
        assert.throws(
          () =>
            store.write([
              verificationVariant(H1, 'mes:fact:planning_verification_result:S02:findings', 'mes:verification:S02:findings', verdict),
              acceptanceRef(H1, 'mes:fact:plan_acceptance:S02:findings', 'mes:verification:S02:findings'),
            ]),
          (err: unknown) =>
            err instanceof MesSnapshotStoreError &&
            err.code === 'invalid-fact' &&
            err.message.includes('RESULT_INVALID'),
          `verdict ${verdict} must not underpin an acceptance (no-write)`,
        );
      }
      assert.deepEqual(store.read(), [], 'rejected FINDINGS/BLOCKED relations must not persist anything');
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects a mismatched relation/basis for a new acceptance (ref / digest / head)', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      store.write([verificationFact(H1)]);
      const seededBytes = snapshotBytes(fixture);

      // Each probe uses a NEW acceptance fact_id so only the relational gate
      // (never the cross-submission payload conflict gate) can reject it; the
      // previous snapshot must stay byte-for-byte unchanged.
      const probes: Array<{ label: string; acceptance: MesFactEnvelope }> = [
        {
          label: 'unbacked verification_result_ref',
          acceptance: acceptanceRef(H1, 'mes:fact:plan_acceptance:S02:u', 'mes:verification:S02:none'),
        },
        {
          label: 'accepted_plan_ref disagrees with the verified candidate_plan_ref',
          acceptance: planAcceptanceWith(H1, 'mes:fact:plan_acceptance:S02:p', (b) => ({
            ...b,
            accepted_plan_ref: 'delivery/stages/S03/plan.md',
            source_candidate_plan_ref: 'delivery/stages/S03/plan.md',
          })),
        },
        {
          label: 'plan_digest disagrees with the verification',
          acceptance: planAcceptanceWith(H1, 'mes:fact:plan_acceptance:S02:d', (b) => ({
            ...b,
            plan_digest: 'e'.repeat(64),
          })),
        },
        {
          label: 'git_basis.head disagrees (not the same verified basis)',
          acceptance: planAcceptanceWith(H1, 'mes:fact:plan_acceptance:S02:h', (b) => b, gitBasis(H2)),
        },
      ];
      for (const { label, acceptance } of probes) {
        assert.throws(
          () => store.write([acceptance]),
          (err: unknown) =>
            err instanceof MesSnapshotStoreError &&
            err.code === 'invalid-fact' &&
            err.message.includes('RESULT_INVALID'),
          label,
        );
        assert.equal(snapshotBytes(fixture), seededBytes, `${label} must not touch the previous snapshot`);
      }
      assert.deepEqual(store.read(), [verificationFact(H1)], 'only the seeded verification remains');
    } finally {
      fixture.cleanup();
    }
  });

  test('closes the relation order-independently within one submitted set', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      // The acceptance is submitted BEFORE its verification: relation lookup
      // is by result_ref over the whole union, so order never matters.
      store.write([acceptanceFact(H1), verificationFact(H1)]);
      const first = new MesSnapshotStore(fixture.dir).read();
      assert.deepEqual(first, [acceptanceFact(H1), verificationFact(H1)]);
      // Identical replay of the same (reordered) submission stays byte-stable.
      const bytes1 = snapshotBytes(fixture);
      store.write([acceptanceFact(H1), verificationFact(H1)]);
      assert.equal(snapshotBytes(fixture), bytes1, 'identical replay must be byte-stable');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), first);
    } finally {
      fixture.cleanup();
    }
  });

  test('resolves the verification from the current valid snapshot when only the acceptance is submitted', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      store.write([verificationFact(H1)]);

      // A partial write carrying ONLY the acceptance closes the relation
      // against the existing snapshot (AC3) AND preserves the verification in
      // the SAME durable snapshot — the acceptance never loses its durable
      // PLAN_READY support.
      store.write([acceptanceFact(H1)]);
      const rehydrated = new MesSnapshotStore(fixture.dir).read();
      assert.deepEqual(rehydrated, [acceptanceFact(H1), verificationFact(H1)]);

      // Replaying the partial write stays idempotent and byte-stable.
      const bytes1 = snapshotBytes(fixture);
      store.write([acceptanceFact(H1)]);
      assert.equal(snapshotBytes(fixture), bytes1, 'partial-write replay must be byte-stable');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), rehydrated);
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects cross-submission conflicting planning payloads no-write and keeps identical replay byte-stable', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      store.write([verificationFact(H1), acceptanceFact(H1)]);
      const seedBytes = snapshotBytes(fixture);
      const seeded = new MesSnapshotStore(fixture.dir).read();

      // Identical replay: accepted, deduplicated, byte-identical snapshot file.
      store.write([verificationFact(H1), acceptanceFact(H1)]);
      assert.equal(snapshotBytes(fixture), seedBytes, 'identical replay must be byte-stable');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), seeded);

      // Same fact_id, DIFFERENT canonical payload across submissions →
      // RESULT_INVALID no-write; the previous snapshot stays byte-for-byte
      // unchanged (S02-SR-F001 / AC4).
      const conflictingVerification: MesFactEnvelope = {
        ...verificationFact(H1),
        plan_binding: { ...candidateBinding('PLAN_READY'), delivery_cycle_id: CYCLE, plan_digest: 'f'.repeat(64) },
      };
      assert.throws(
        () => store.write([conflictingVerification, acceptanceFact(H1)]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a conflicting planning payload across submissions must be rejected no-write',
      );
      assert.equal(snapshotBytes(fixture), seedBytes, 'conflict must leave the snapshot byte-for-byte unchanged');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), seeded);

      // The acceptance fact_id is locked the same way.
      const conflictingAcceptance: MesFactEnvelope = {
        ...acceptanceFact(H1),
        plan_binding: { ...acceptedBinding(), delivery_cycle_id: CYCLE, plan_digest: 'f'.repeat(64) },
      };
      assert.throws(
        () => store.write([verificationFact(H1), conflictingAcceptance]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a conflicting acceptance payload across submissions must be rejected no-write',
      );
      assert.equal(snapshotBytes(fixture), seedBytes);
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), seeded);
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects non-planning kind switches for persisted planning fact ids without touching the snapshot', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);
      const persisted: MesFactEnvelope[] = [verificationFact(H1), acceptanceFact(H1)];
      store.write(persisted);
      const seededBytes = snapshotBytes(fixture);

      // A valid non-planning envelope must never replace either planning fact.
      // In particular, replacing the verification would otherwise remove the
      // durable PLAN_READY support that closes the acceptance relation.
      for (const planning of persisted) {
        const replacement: MesFactEnvelope = {
          schema_version: 2,
          fact_id: planning.fact_id,
          fact_kind: 'project',
          created_by: 'brain',
          authority_refs: ['PRD.md#FR-003'],
        };
        assert.throws(
          () => store.write([replacement]),
          (err: unknown) =>
            err instanceof MesSnapshotStoreError &&
            err.code === 'invalid-fact' &&
            err.message.includes('RESULT_INVALID'),
          `a project fact must not replace persisted ${planning.fact_kind}`,
        );
        assert.equal(
          snapshotBytes(fixture),
          seededBytes,
          `cross-kind replacement of ${planning.fact_kind} must be byte-for-byte no-write`,
        );
        assert.deepEqual(
          new MesSnapshotStore(fixture.dir).read(),
          persisted,
          `cross-kind replacement of ${planning.fact_kind} must preserve all planning facts`,
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('keeps S01 seed-repair rewrites legal for non-planning fact kinds and preserves planning facts', () => {
    const fixture = makeFixture();
    try {
      const store = new MesSnapshotStore(fixture.dir);

      // Non-planning seed-owned fact ids remain REWRITABLE across submissions
      // (bootstrap-repair semantics / CV-S01-B-09): replace-all stays, no
      // cross-submission conflict is invented for them.
      const seedV1 = seedPlanBindingFact(DIGEST);
      const seedV2 = seedPlanBindingFact('f'.repeat(64));
      store.write([seedV1]);
      store.write([seedV2]);
      assert.deepEqual(store.read(), [seedV2], 'non-planning fact rewrite must stay legal');

      // A partial NON-planning write must never drop the planning facts:
      // the PLAN_READY verification keeps supporting the acceptance in the
      // SAME durable snapshot while a new seed-owned fact is added.
      store.write([verificationFact(H1), acceptanceFact(H1)]);
      store.write([seedV2]);
      const rehydrated = new MesSnapshotStore(fixture.dir).read();
      assert.equal(rehydrated.filter((f) => f.fact_kind === 'planning_verification_result').length, 1);
      assert.equal(rehydrated.filter((f) => f.fact_kind === 'plan_acceptance').length, 1);
      assert.equal(rehydrated.filter((f) => f.fact_kind === 'plan_binding').length, 1);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('accepted NORMAL stage relation closure (S05-B-T01 / PO-S05-B-05)', () => {
  const H1 = '1'.repeat(40);
  const S05_PLAN = 'delivery/stages/S05/plan.md';
  const S05_DIGEST = 'd'.repeat(64);
  const S05_CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
  const PVR_REF = 'mes:result:S05:planning-verification-1';
  const STAGE_RESULT_REF = 'mes:result:S05:stage-review-1';

  const s05Pvr = (
    opts: {
      factId?: string;
      resultRef?: string;
      verdict?: 'PLAN_READY' | 'FINDINGS' | 'BLOCKED';
      planRef?: string;
      digest?: string;
      cycle?: string;
    } = {},
  ): MesFactEnvelope => ({
    schema_version: 2,
    fact_id: opts.factId ?? 'mes:fact:planning_verification_result:S05:1',
    fact_kind: 'planning_verification_result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.2'],
    scope: { stage_id: 'S05' },
    work_id: 'mes:work:S05:planning:1',
    result_ref: opts.resultRef ?? PVR_REF,
    verifier_role: 'stage-plan-verifier',
    action_token: 's05-spv-1',
    plan_binding: {
      binding_stage: 'candidate',
      candidate_plan_ref: opts.planRef ?? S05_PLAN,
      accepted_plan_ref: null,
      verdict: opts.verdict ?? 'PLAN_READY',
      plan_digest: opts.digest ?? S05_DIGEST,
      delivery_cycle_id: opts.cycle ?? S05_CYCLE,
    },
    git_basis: gitBasis(H1),
  });

  const s05Pa = (): MesFactEnvelope => ({
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
      delivery_cycle_id: S05_CYCLE,
    },
    git_basis: gitBasis(H1),
  });

  const acceptedStage = (
    opts: {
      factId?: string;
      verificationRef?: string;
      resultRef?: string;
      planRef?: string;
      digest?: string;
      cycle?: string | undefined;
    } = {},
  ): MesFactEnvelope => ({
    schema_version: 2,
    fact_id: opts.factId ?? 'mes:fact:stage:S05:accepted',
    fact_kind: 'stage',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.1'],
    scope: { stage_id: 'S05' },
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: opts.planRef ?? S05_PLAN,
      source_candidate_plan_ref: opts.planRef ?? S05_PLAN,
      verification_result_ref: opts.verificationRef ?? PVR_REF,
      plan_digest: opts.digest ?? S05_DIGEST,
      delivery_cycle_id: opts.cycle ?? S05_CYCLE,
    },
    git_basis: gitBasis(H1),
    result_ref: opts.resultRef ?? STAGE_RESULT_REF,
  });

  const reviewResult = (
    opts: {
      factId?: string;
      scope?: { stage_id: string; slice_id?: string; task_id?: string };
      resultRef?: string;
      cycle?: string | undefined;
      planRef?: string;
    } = {},
  ): MesFactEnvelope => ({
    schema_version: 2,
    fact_id: opts.factId ?? 'mes:fact:result:S05:stage-review-1',
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.1.1'],
    scope: opts.scope ?? { stage_id: 'S05' },
    work_id: 'mes:work:S05:review:1',
    result_ref: opts.resultRef ?? STAGE_RESULT_REF,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: opts.planRef ?? S05_PLAN,
      source_candidate_plan_ref: opts.planRef ?? S05_PLAN,
      verification_result_ref: PVR_REF,
      plan_digest: S05_DIGEST,
      delivery_cycle_id: opts.cycle ?? S05_CYCLE,
    },
    git_basis: gitBasis(H1),
    result_id: 'stage-review-1',
    result_payload_digest: DIGEST,
  });

  test('closes the full accepted NORMAL stage relation order-independently and rebuilds it after restart (PO-S05-B-05)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);

      // The current candidate/accepted planning binding (PVR PLAN_READY + PA) carries CYCLE.
      store.write([s05Pvr(), s05Pa()]);
      assert.equal(store.read().length, 2);

      // The accepted stage + its Review-owned stage-only result close in the SAME
      // submitted set, order-independent: verification_result_ref exact-resolves
      // to the durable PLAN_READY PVR and result_ref to the Review result.
      const stage = acceptedStage();
      const review = reviewResult();
      store.write([review, stage]);
      const persisted = store.read();
      assert.equal(persisted.length, 4);
      assert.equal(
        verifyAcceptedStageReviewResultSupport(
          persisted.find((f) => f.fact_id === stage.fact_id)!,
          persisted.find((f) => f.fact_id === review.fact_id)!,
        ),
        undefined,
        'accepted stage + same-cycle Review result must close',
      );
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), persisted, 'restart rebuilds the same closed set');
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects wrong/missing/ambiguous accepted-stage relations no-write byte-stable (PO-S05-B-05)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      store.write([s05Pvr(), s05Pa()]);
      const goodBytes = snapshotBytes(fixture);

      // Each probe carries a NEW stage/result fact_id so only the relational
      // closure (never the cross-submission conflict gate) can reject it.
      const probes: Array<{ label: string; facts: MesFactEnvelope[] }> = [
        {
          label: 'verification_result_ref unresolvable',
          facts: [acceptedStage({ factId: 'mes:fact:stage:S05:u', verificationRef: 'mes:result:S05:none' }), reviewResult()],
        },
        {
          label: 'verification ref resolves to a FINDINGS PVR (not PLAN_READY)',
          facts: [
            s05Pvr({
              factId: 'mes:fact:planning_verification_result:S05:findings',
              resultRef: 'mes:result:S05:planning-verification-findings',
              verdict: 'FINDINGS',
            }),
            acceptedStage({ factId: 'mes:fact:stage:S05:f', verificationRef: 'mes:result:S05:planning-verification-findings' }),
            reviewResult(),
          ],
        },
        {
          label: 'verification ref resolves to PVR with different candidate_plan_ref',
          facts: [
            s05Pvr({
              factId: 'mes:fact:planning_verification_result:S05:wrongplan',
              resultRef: 'mes:result:S05:planning-verification-wrongplan',
              planRef: 'delivery/stages/S04/plan.md',
            }),
            acceptedStage({ factId: 'mes:fact:stage:S05:p', verificationRef: 'mes:result:S05:planning-verification-wrongplan' }),
            reviewResult(),
          ],
        },
        {
          label: 'verification ref resolves to PVR with different plan_digest',
          facts: [
            s05Pvr({
              factId: 'mes:fact:planning_verification_result:S05:wrongdigest',
              resultRef: 'mes:result:S05:planning-verification-wrongdigest',
              digest: 'f'.repeat(64),
            }),
            acceptedStage({ factId: 'mes:fact:stage:S05:d', verificationRef: 'mes:result:S05:planning-verification-wrongdigest' }),
            reviewResult(),
          ],
        },
        {
          label: 'result_ref missing (no Review result carries the ref)',
          facts: [acceptedStage({ factId: 'mes:fact:stage:S05:m', resultRef: 'mes:result:S05:missing' }), reviewResult()],
        },
        {
          label: 'execute-owned result masquerading as the Review result',
          facts: [
            acceptedStage({ factId: 'mes:fact:stage:S05:e' }),
            reviewResult({
              factId: 'mes:fact:result:S05:execute-owned',
              scope: { stage_id: 'S05', slice_id: 'S05-A', task_id: 'S05-A-T01' },
            }),
          ],
        },
        {
          label: 'ambiguous result_ref (two result facts share the ref)',
          facts: [
            acceptedStage({ factId: 'mes:fact:stage:S05:a' }),
            reviewResult({ factId: 'mes:fact:result:S05:stage-review-1' }),
            reviewResult({ factId: 'mes:fact:result:S05:stage-review-1b' }),
          ],
        },
        {
          label: 'review result with a different cycle',
          facts: [
            acceptedStage({ factId: 'mes:fact:stage:S05:c' }),
            reviewResult({ factId: 'mes:fact:result:S05:stage-review-cross', cycle: 'cycle-other' }),
          ],
        },
      ];
      for (const { label, facts } of probes) {
        assert.throws(
          () => store.write(facts),
          (err: unknown) =>
            err instanceof MesSnapshotStoreError &&
            err.code === 'invalid-fact' &&
            err.message.includes('RESULT_INVALID'),
          `${label} must be no-write`,
        );
        assert.equal(snapshotBytes(fixture), goodBytes, `${label} must leave the snapshot byte-identical`);
        assert.deepEqual(store.read(), [s05Pvr(), s05Pa()], `${label} must persist nothing new`);
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('keeps retained historical accepted stages legacy-compatible while the current cycle closes its own relation (PO-S05-B-05)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);

      // A legacy-shaped accepted stage (no cycle, unresolvable refs) written
      // BEFORE any planning binding exists is legal: no current cycle anchor,
      // no NORMAL closure.
      const legacyStage = acceptedStage({
        factId: 'mes:fact:stage:S01:accepted',
        verificationRef: 'mes:result:S01:planning-verification-1',
        resultRef: 'mes:result:S01:stage-review-1111111111',
      });
      // Explicitly strip the cycle so the fact is genuinely legacy-shaped (no
      // cycle field at all), even though the helper defaults to the current cycle.
      delete (legacyStage.plan_binding as { delivery_cycle_id?: string }).delivery_cycle_id;
      const legacyScoped: MesFactEnvelope = {
        ...legacyStage,
        scope: { stage_id: 'S01' },
      };
      store.write([legacyScoped]);
      const legacyBytes = snapshotBytes(fixture);
      assert.equal(store.read().length, 1);

      // The current cycle cohort (PVR/PA + cycle-bearing accepted stage + Review
      // result) coexists; the retained historical stage stays byte-identical
      // (history-only, never re-validated, never backfilled).
      const stage = acceptedStage();
      const review = reviewResult();
      store.write([s05Pvr(), s05Pa(), stage, review]);
      const cohortBytes = snapshotBytes(fixture);
      const persisted = store.read();
      assert.equal(persisted.length, 5);
      const legacyAgain = persisted.find((f) => f.fact_id === legacyScoped.fact_id)!;
      assert.equal(canonicalStringify(legacyAgain), canonicalStringify(legacyScoped), 'retained historical stage stays byte-identical');
      assert.equal(
        verifyAcceptedStageReviewResultSupport(
          persisted.find((f) => f.fact_id === stage.fact_id)!,
          persisted.find((f) => f.fact_id === review.fact_id)!,
        ),
        undefined,
        'the current cycle accepted stage + Review result still close',
      );
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), persisted, 'restart rebuilds history + current cohort');

      // A NEW legacy-shaped accepted stage while a current cycle exists is
      // rejected (缺失 cycle → per-fact cycle equality no-write).
      const lateLegacy: MesFactEnvelope = {
        ...legacyScoped,
        fact_id: 'mes:fact:stage:S01:accepted-late',
      };
      assert.throws(
        () => store.write([lateLegacy]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a NEW legacy-shaped accepted stage under a current cycle must be no-write',
      );
      assert.equal(snapshotBytes(fixture), cohortBytes, 'the late legacy-shaped write must leave the cohort snapshot byte-identical');
    } finally {
      fixture.cleanup();
    }
  });
});
