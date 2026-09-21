/**
 * MES bootstrap seed tests (S01-B-T02).
 *
 * # PO: PO-S01-B-03, PO-S01-B-04, PO-S01-B-05
 *
 * Exercises the one-time bootstrap seed operation on
 * packages/runtime/src/mes/bootstrap.ts:
 *   - an empty pre-seed store accepts the first valid seed from a legal
 *     Git/Authority/Plan basis without pre-seed MES status/work identity or
 *     resultRef (PO-S01-B-03);
 *   - the same seed is idempotent, a conflicting seed and a second bootstrap
 *     fail closed, and no extra durable store/Receipt/Manifest/Gate is
 *     created (PO-S01-B-04);
 *   - the seed explicitly persists the Brain-supplied first-NORMAL status
 *     tuple (`scope`/`phase`/`required_skill` and applicable non-zero anomaly
 *     counters) durably re-readable for the next NORMAL READ STATUS
 *     (PO-S01-B-05).
 *
 * All tests use only temporary Git fixtures (helpers.ts#makeFixture) and
 * never the work clone's Git state. Imports the compiled runtime dist
 * (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import {
  seedMesBootstrap,
  readMesSeedRecord,
  isMesSeeded,
  MesBootstrapError,
  MES_SEED_REL,
  readMesSnapshotFacts,
} from '../dist/mes/bootstrap';
import type { MesBootstrapSeedInput } from '../dist/mes/bootstrap';
import { MesSnapshotStore } from '../dist/mes/store';
import { runStatusDomain } from '../dist/cli/proofloop';
import { makeFixture, commitAll, sha } from './helpers';


/** Live node:fs module (writable) for injected write-failure tests. */
const realFs = createRequire(__filename)('node:fs') as typeof fs;
const PLAN_REF = 'delivery/stages/S01/plan.md';
const DIGEST = sha('plan-v1');

function seedInput(overrides: Partial<MesBootstrapSeedInput> = {}): MesBootstrapSeedInput {
  return {
    authority_refs: ['PRD.md#FR-003', 'tech-spec/contracts.md#2.2.1'],
    accepted_plan_ref: PLAN_REF,
    plan_digest: DIGEST,
    git_basis: {
      head: 'ee9518854895a9338d3610c0b8e7384988bd7c70',
      branch: 'proofloop-s01-b',
      worktree: '.',
    },
    status: {
      scope: 'S01',
      phase: 'EXECUTE',
      required_skill: 'proofloop-execute',
    },
    ...overrides,
  };
}

function fixtureRoot(): { dir: string; cleanup(): void; head: string; branch: string } {
  const fixture = makeFixture();
  const commit = commitAll(fixture, 'seed baseline');
  return {
    dir: fixture.dir,
    head: commit,
    branch: 'master',
    cleanup: fixture.cleanup,
  };
}

describe('MES bootstrap seed (S01-B-T02)', () => {
  test('seeds the first accepted bootstrap facts without MES prerequisites', () => {
    const fixture = fixtureRoot();
    try {
      const input = seedInput({
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
      });
      const record = seedMesBootstrap(fixture.dir, input);

      // Durable seed record is re-readable and keeps the Git/Plan basis +
      // Brain-supplied status tuple.
      assert.equal(record.accepted_plan_ref, PLAN_REF);
      assert.equal(record.git_basis.head, fixture.head);
      const reRead = readMesSeedRecord(fixture.dir);
      assert.ok(reRead, 'seed record must be durably re-readable');
      assert.equal(reRead!.accepted_plan_ref, PLAN_REF);
      assert.deepEqual(reRead!.status, input.status);

      // The accepted Plan bootstrap facts enter the MES store as validated
      // facts (no MES work identity / resultRef prerequisites).
      const store = new MesSnapshotStore(fixture.dir);
      const facts = store.read();
      assert.ok(facts.length >= 1, 'seed must persist at least one MES fact');
      assert.equal(isMesSeeded(fixture.dir), true);

      // No Receipt / Manifest / Gate / second state machine is created:
      // only the MES snapshot store + the root-bound seed record exist.
      const mesDir = path.join(fixture.dir, '.proofloop', 'mes');
      const entries = fs.existsSync(mesDir) ? fs.readdirSync(mesDir) : [];
      assert.ok(entries.includes(path.basename(MES_SEED_REL)), 'seed record file must exist');
      assert.ok(entries.includes('snapshot.json'), 'MES snapshot store must exist');
      for (const name of entries) {
        assert.ok(
          !/receipt|manifest|gate/i.test(name),
          `no Receipt/Manifest/Gate artifact: ${name}`,
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects conflicting or repeated bootstrap seed', () => {
    const fixture = fixtureRoot();
    try {
      const input = seedInput({
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
      });
      seedMesBootstrap(fixture.dir, input);

      // The SAME seed is idempotent: replaying it succeeds without changing
      // the durable record.
      const before = readMesSeedRecord(fixture.dir)!;
      const replayed = seedMesBootstrap(fixture.dir, input);
      assert.deepEqual(replayed, before, 'same seed must be idempotent');
      assert.deepEqual(readMesSeedRecord(fixture.dir), before);

      // A CONFLICTING seed (different accepted plan ref) fails closed.
      assert.throws(
        () =>
          seedMesBootstrap(fixture.dir, {
            ...input,
            accepted_plan_ref: 'delivery/stages/S01/other.md',
          }),
        MesBootstrapError,
      );
      // A conflicting status tuple (different phase) also fails closed.
      assert.throws(
        () =>
          seedMesBootstrap(fixture.dir, {
            ...input,
            status: { ...input.status, phase: 'REVIEW' },
          }),
        MesBootstrapError,
      );
      // Seed completion permanently flags the store as seeded: the branch
      // stays closed for later PRE_MES_BOOTSTRAP dispatches (Brain-side).
      assert.equal(isMesSeeded(fixture.dir), true);
      // The first record is untouched after every rejected attempt.
      assert.deepEqual(readMesSeedRecord(fixture.dir), before);
    } finally {
      fixture.cleanup();
    }
  });

  test('seeds explicit first-NORMAL status facts for READ STATUS', () => {
    const fixture = fixtureRoot();
    try {
      const input = seedInput({
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
        status: {
          scope: 'S01',
          phase: 'EXECUTE',
          required_skill: 'proofloop-execute',
          counters: { replan: 0, blocked: 1, finding: 2 },
        },
      });
      seedMesBootstrap(fixture.dir, input);

      const record = readMesSeedRecord(fixture.dir)!;
      // The Brain-supplied first-NORMAL status tuple is durably re-readable:
      // the next NORMAL READ STATUS needs no inference and no pre-seed facts.
      assert.equal(record.status.scope, 'S01');
      assert.equal(record.status.phase, 'EXECUTE');
      assert.equal(record.status.required_skill, 'proofloop-execute');
      assert.deepEqual(record.status.counters, { replan: 0, blocked: 1, finding: 2 });

      // A zero-only counter set is accepted (sparse projection hides zeros).
      const zeroInput = seedInput({
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
        status: { scope: 'S01', phase: 'PLANNING', required_skill: 'proofloop-plan' },
      });
      // a different status tuple would conflict; a fresh fixture accepts it.
      const fixture2 = fixtureRoot();
      try {
        seedMesBootstrap(fixture2.dir, zeroInput);
        assert.deepEqual(readMesSeedRecord(fixture2.dir)!.status.counters, undefined);
      } finally {
        fixture2.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects traversal plan refs and unknown fields (CV-S01-B-02/03)', () => {
    const fixture = fixtureRoot();
    try {
      const base = seedInput({
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
      });

      // CV-S01-B-02: traversal refs fail closed on the seed input.
      for (const bad of ['../../outside.md', '/abs/plan.md', 'a\\b.md', '..', 'x/../y.md', '']) {
        assert.throws(
          () => seedMesBootstrap(fixture.dir, { ...base, accepted_plan_ref: bad }),
          MesBootstrapError,
          `accepted_plan_ref must reject ${JSON.stringify(bad)}`,
        );
      }

      // CV-S01-B-03: unknown top-level input fields fail closed.
      assert.throws(
        () => seedMesBootstrap(fixture.dir, { ...base, next_action: 'run' }),
        MesBootstrapError,
      );
      assert.throws(
        () => seedMesBootstrap(fixture.dir, { ...base, git_basis: { ...base.git_basis, extra: 1 } }),
        MesBootstrapError,
      );
      assert.throws(
        () =>
          seedMesBootstrap(fixture.dir, {
            ...base,
            status: { ...base.status, reason: 'x' },
          }),
        MesBootstrapError,
      );

      // Nothing was written by any rejected attempt.
      assert.equal(readMesSeedRecord(fixture.dir), null);
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), []);
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects injected unknown persisted fields as corrupt seed (CV-S01-B-03)', () => {
    const fixture = fixtureRoot();
    try {
      const input = seedInput({
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
      });
      seedMesBootstrap(fixture.dir, input);

      // Inject an unknown persisted top-level field: read must fail closed
      // as corrupt-seed, never return a partial record.
      const seedAbs = path.join(fixture.dir, MES_SEED_REL);
      const rec = JSON.parse(fs.readFileSync(seedAbs, 'utf8'));
      rec.next_action = 'run';
      fs.writeFileSync(seedAbs, JSON.stringify(rec), 'utf8');
      assert.throws(() => readMesSeedRecord(fixture.dir), MesBootstrapError);
      // A corrupt record is trustworthy neither as seeded nor as unseeded:
      // isMesSeeded fail-closes with the same corrupt-seed error.
      assert.throws(() => isMesSeeded(fixture.dir), MesBootstrapError);

      // An unknown nested git_basis/status field is also corrupt.
      fs.writeFileSync(seedAbs, JSON.stringify({ ...rec, next_action: undefined, git_basis: { ...rec.git_basis, extra: 1 } }), 'utf8');
      assert.throws(() => readMesSeedRecord(fixture.dir), MesBootstrapError);
    } finally {
      fixture.cleanup();
    }
  });

  test('recovers cleanly from injected seed-write failures (CV-S01-B-04)', () => {
    const fixture = fixtureRoot();
    try {
      const input = seedInput({
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
      });
      const origRename = fs.renameSync;

      // Injected failure on the SEED RECORD rename (seed is written first):
      // the snapshot must stay untouched and the attempt fails closed.
      realFs.renameSync = (from: unknown, to: unknown) => {
        if (String(from).includes('.seed.')) {
          throw new Error('injected seed rename failure');
        }
        return origRename(from as string, to as string);
      };
      try {
        assert.throws(() => seedMesBootstrap(fixture.dir, input), MesBootstrapError);
        assert.equal(readMesSeedRecord(fixture.dir), null);
        assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), [], 'snapshot must be untouched');
      } finally {
        realFs.renameSync = origRename;
      }

      // Retry now succeeds cleanly — no partial bootstrap state survived.
      seedMesBootstrap(fixture.dir, input);
      assert.ok(readMesSeedRecord(fixture.dir));
      assert.equal(new MesSnapshotStore(fixture.dir).read().length, 2);

      // Injected failure on the SNAPSHOT rename after the seed record was
      // written: the seed record must be rolled back so the retry recovers.
      const fixture2 = fixtureRoot();
      try {
        realFs.renameSync = (from: unknown, to: unknown) => {
          if (String(from).includes('.snapshot.')) {
            throw new Error('injected snapshot rename failure');
          }
          return origRename(from as string, to as string);
        };
        try {
          assert.throws(() => seedMesBootstrap(fixture2.dir, input), MesBootstrapError);
          assert.equal(readMesSeedRecord(fixture2.dir), null, 'seed record must be rolled back');
          assert.deepEqual(new MesSnapshotStore(fixture2.dir).read(), []);
        } finally {
          realFs.renameSync = origRename;
        }
        // Recovery: a clean retry completes the seed.
        seedMesBootstrap(fixture2.dir, input);
        assert.ok(readMesSeedRecord(fixture2.dir));
        assert.equal(new MesSnapshotStore(fixture2.dir).read().length, 2);
      } finally {
        fixture2.cleanup();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects drive-relative authority refs and plan refs on the seed input (CV-S01-B-06)', () => {
    const fixture = fixtureRoot();
    try {
      const base = seedInput({
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
      });
      for (const bad of ['C:foo.md#FR-003', '/abs.md#FR-003', '../../x.md#FR-003']) {
        assert.throws(
          () => seedMesBootstrap(fixture.dir, { ...base, authority_refs: [bad] }),
          MesBootstrapError,
          `authority_refs must reject ${JSON.stringify(bad)}`,
        );
      }
      for (const bad of ['C:foo.md', '/abs.md', 'C:\\foo.md', 'C:']) {
        assert.throws(
          () => seedMesBootstrap(fixture.dir, { ...base, accepted_plan_ref: bad }),
          MesBootstrapError,
          `accepted_plan_ref must reject drive/absolute ${JSON.stringify(bad)}`,
        );
      }
      assert.equal(readMesSeedRecord(fixture.dir), null);
    } finally {
      fixture.cleanup();
    }
  });

  test('isMesSeeded requires durable matching snapshot facts (CV-S01-B-08)', () => {
    const fixture = fixtureRoot();
    try {
      const input = seedInput({
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
      });
      seedMesBootstrap(fixture.dir, input);
      assert.equal(isMesSeeded(fixture.dir), true);

      // Crash between the seed-record write and the snapshot write: the
      // seed record survives but the snapshot facts are missing. isMesSeeded
      // must NOT report the store as seeded, and a retry must recover.
      const seedAbs = path.join(fixture.dir, MES_SEED_REL);
      const snapshotAbs = path.join(fixture.dir, '.proofloop', 'mes', 'snapshot.json');
      assert.ok(fs.existsSync(seedAbs));
      fs.rmSync(snapshotAbs, { force: true });
      assert.equal(isMesSeeded(fixture.dir), false, 'missing snapshot must not count as seeded');

      // Recovery: a retry with the same seed completes idempotently and
      // re-writes the snapshot facts (the idempotent/repair path).
      seedMesBootstrap(fixture.dir, input);
      assert.equal(isMesSeeded(fixture.dir), true);
      assert.equal(new MesSnapshotStore(fixture.dir).read().length, 2);

      // A seed record that diverges from the snapshot facts (different
      // accepted_plan_ref) is also NOT a completed seed.
      const rec = JSON.parse(fs.readFileSync(seedAbs, 'utf8'));
      rec.accepted_plan_ref = 'delivery/stages/S01/other.md';
      fs.writeFileSync(seedAbs, JSON.stringify(rec), 'utf8');
      assert.equal(isMesSeeded(fixture.dir), false);
    } finally {
      fixture.cleanup();
    }
  });

  test('seed retry repairs partial/mismatched snapshots while retaining operational facts (CV-S01-B-09)', () => {
    const fixture = fixtureRoot();
    try {
      const input = seedInput({
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
      });
      seedMesBootstrap(fixture.dir, input);

      const snapshotAbs = path.join(fixture.dir, '.proofloop', 'mes', 'snapshot.json');
      const readFacts = () => JSON.parse(fs.readFileSync(snapshotAbs, 'utf8')).facts;
      const writeFacts = (facts: unknown[]) =>
        fs.writeFileSync(snapshotAbs, JSON.stringify({ schema_version: 2, facts }, null, 2), 'utf8');
      const projectFact = {
        schema_version: 2,
        fact_id: 'mes:fact:project:partial',
        fact_kind: 'project',
        created_by: 'brain',
        authority_refs: ['PRD.md#FR-003'],
      };
      const normalWorkFact = {
        schema_version: 2,
        fact_id: 'mes:fact:work:S01-B-T01',
        fact_kind: 'work',
        created_by: 'brain',
        authority_refs: input.authority_refs,
        scope: { stage_id: 'S01', slice_id: 'S01-B', task_id: 'S01-B-T01' },
        work_id: 'mes:work:S01-B-T01',
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: input.accepted_plan_ref,
          source_candidate_plan_ref: input.accepted_plan_ref,
          verification_result_ref: `bootstrap:verification:${input.git_basis.head}`,
          plan_digest: input.plan_digest,
        },
        git_basis: input.git_basis,
      };
      const hasFact = (factId: string) => readFacts().some((fact: { fact_id: string }) => fact.fact_id === factId);

      // 1) schema-valid project-only partial snapshot: not seeded, and a
      //    same-seed retry must REPAIR it (not skip because length > 0).
      writeFacts([projectFact]);
      assert.equal(isMesSeeded(fixture.dir), false, 'project-only partial snapshot must not be seeded');
      seedMesBootstrap(fixture.dir, input);
      assert.equal(isMesSeeded(fixture.dir), true);
      assert.equal(readFacts().length, 3, 'retry restores seed facts without deleting the project fact');
      assert.equal(hasFact('mes:fact:project:partial'), true);

      // A valid NORMAL work fact can be appended after bootstrap without
      // changing the seeded completion state, and survives an idempotent retry.
      writeFacts([...readFacts(), normalWorkFact]);
      assert.equal(isMesSeeded(fixture.dir), true);
      assert.equal(runStatusDomain(fixture.dir, { detail: false, jsonOutput: true }).ok, true);
      seedMesBootstrap(fixture.dir, input);
      assert.equal(isMesSeeded(fixture.dir), true);
      assert.equal(hasFact('mes:fact:work:S01-B-T01'), true);
      assert.equal(readFacts().length, 4);

      // 2) wrong accepted_plan_ref: same-seed retry repairs only the seed fact.
      const wrongPlan = JSON.parse(JSON.stringify(readFacts()[0]));
      wrongPlan.plan_binding.accepted_plan_ref = 'delivery/stages/S01/wrong.md';
      wrongPlan.plan_binding.source_candidate_plan_ref = 'delivery/stages/S01/wrong.md';
      writeFacts([wrongPlan, ...readFacts().slice(1)]);
      assert.equal(isMesSeeded(fixture.dir), false, 'wrong accepted_plan_ref must not be seeded');
      seedMesBootstrap(fixture.dir, input);
      assert.equal(isMesSeeded(fixture.dir), true);
      assert.equal(readFacts().length, 4, 'damaged seed fact repair preserves operational facts');

      // 3) same accepted_plan_ref but wrong authority_refs on the binding fact.
      const wrongAuth = JSON.parse(JSON.stringify(readFacts()[0]));
      wrongAuth.authority_refs = ['PRD.md#FR-999'];
      writeFacts([wrongAuth, ...readFacts().slice(1)]);
      assert.equal(isMesSeeded(fixture.dir), false, 'forged authority_refs must not be seeded');
      seedMesBootstrap(fixture.dir, input);
      assert.equal(isMesSeeded(fixture.dir), true);

      // 4) same accepted_plan_ref but wrong verification_result_ref.
      const wrongVerif = JSON.parse(JSON.stringify(readFacts()[0]));
      wrongVerif.plan_binding.verification_result_ref = 'mes:result:S01:evil';
      writeFacts([wrongVerif, ...readFacts().slice(1)]);
      assert.equal(isMesSeeded(fixture.dir), false, 'forged verification_result_ref must not be seeded');
      seedMesBootstrap(fixture.dir, input);
      assert.equal(isMesSeeded(fixture.dir), true);

      // 5) same accepted_plan_ref but wrong git_basis on the git fact.
      const wrongGit = JSON.parse(JSON.stringify(readFacts()[1]));
      wrongGit.git_basis.head = 'f'.repeat(40);
      writeFacts([readFacts()[0], wrongGit, ...readFacts().slice(2)]);
      assert.equal(isMesSeeded(fixture.dir), false, 'forged git_basis must not be seeded');
      seedMesBootstrap(fixture.dir, input);
      assert.equal(isMesSeeded(fixture.dir), true);

      // 6) extra valid facts are tolerated and retained by completion/repair.
      writeFacts([...readFacts(), projectFact]);
      assert.equal(isMesSeeded(fixture.dir), true, 'valid extra fact must not unset seeded state');
      seedMesBootstrap(fixture.dir, input);
      assert.equal(isMesSeeded(fixture.dir), true);
      assert.equal(readFacts().length, 5, 'extra operational facts survive seed repair');
      assert.equal(hasFact('mes:fact:project:partial'), true);

      // 7) conflicting seed stays rejected after any repair.
      assert.throws(
        () =>
          seedMesBootstrap(fixture.dir, {
            ...input,
            accepted_plan_ref: 'delivery/stages/S01/other.md',
          }),
        MesBootstrapError,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('fails closed on null/non-object git_basis and status (CV S01-STAGE-REVIEW-F001)', () => {
    const fixture = fixtureRoot();
    try {
      const base = seedInput({
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
      });

      // A null / non-object git_basis or status must fail closed with the
      // bounded MesBootstrapError, never a raw TypeError, and never write a
      // partial seed record.
      assert.throws(
        () => seedMesBootstrap(fixture.dir, { ...base, git_basis: null }),
        MesBootstrapError,
        'null git_basis must fail closed',
      );
      assert.throws(
        () => seedMesBootstrap(fixture.dir, { ...base, git_basis: 'S01' }),
        MesBootstrapError,
        'string git_basis must fail closed',
      );
      assert.throws(
        () => seedMesBootstrap(fixture.dir, { ...base, status: null }),
        MesBootstrapError,
        'null status must fail closed',
      );
      assert.throws(
        () => seedMesBootstrap(fixture.dir, { ...base, status: 'EXECUTE' }),
        MesBootstrapError,
        'string status must fail closed',
      );

      // Nothing was written by any rejected attempt.
      assert.equal(readMesSeedRecord(fixture.dir), null);
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), []);
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects broken final and intermediate seed symlinks as present-invalid (CV S01-STAGE-REVIEW-F001)', () => {
    const variants = [
      { name: 'final-inside', intermediate: false, outside: false },
      { name: 'final-outside', intermediate: false, outside: true },
      { name: 'intermediate-inside', intermediate: true, outside: false },
      { name: 'intermediate-outside', intermediate: true, outside: true },
    ] as const;

    for (const variant of variants) {
      const fixture = fixtureRoot();
      try {
        const proofloopAbs = path.join(fixture.dir, '.proofloop');
        const seedAbs = path.join(fixture.dir, MES_SEED_REL);
        const target = variant.outside
          ? path.join(os.tmpdir(), `pl-mes-missing-${path.basename(fixture.dir)}`, variant.name)
          : path.join(fixture.dir, `missing-${variant.name}`);

        if (variant.intermediate) {
          fs.symlinkSync(target, proofloopAbs, 'dir');
        } else {
          fs.mkdirSync(path.dirname(seedAbs), { recursive: true });
          fs.symlinkSync(target, seedAbs);
        }

        const input = seedInput({
          git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
        });
        assert.throws(
          () => readMesSeedRecord(fixture.dir),
          MesBootstrapError,
          `${variant.name}: read must reject a broken seed symlink`,
        );
        assert.throws(
          () => seedMesBootstrap(fixture.dir, input),
          MesBootstrapError,
          `${variant.name}: seed must reject a broken seed symlink`,
        );

        const link = variant.intermediate ? proofloopAbs : seedAbs;
        assert.equal(fs.lstatSync(link).isSymbolicLink(), true, `${variant.name}: link must remain intact`);
        assert.equal(fs.existsSync(target), false, `${variant.name}: seed must not create the dangling target`);
      } finally {
        fixture.cleanup();
      }
    }
  });

  test('reads snapshot facts root-bound without backfilling seed facts (S05-C-T02 / PO-S05-C-03)', () => {
    const fixture = fixtureRoot();
    try {
      // A missing pre-seed snapshot reads as an empty fact list — the
      // post-recovery status observation path must never fabricate facts.
      assert.deepEqual(readMesSnapshotFacts(fixture.dir), []);

      // After the one-time seed, the durable snapshot facts are re-readable
      // through the same read-only seam; the read never writes or backfills
      // anything (no seed reconstruction, no PRE_MES_BOOTSTRAP revival).
      const input = seedInput({
        git_basis: { head: fixture.head, branch: fixture.branch, worktree: '.' },
      });
      seedMesBootstrap(fixture.dir, input);
      const facts = readMesSnapshotFacts(fixture.dir);
      assert.equal(facts.length, 2, 'seed persists exactly the accepted binding + git facts');
      assert.deepEqual(facts, new MesSnapshotStore(fixture.dir).read(), 'the seam exposes the same durable facts as the store');
      assert.ok(fs.existsSync(path.join(fixture.dir, MES_SEED_REL)), 'seed record untouched by the read-only seam');
    } finally {
      fixture.cleanup();
    }
  });
});