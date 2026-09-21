/**
 * MES snapshot store tests (S01-A-T02).
 *
 * # PO: PO-S01-A-03, PO-S01-A-04
 *
 * Exercises the atomic MES snapshot read/write inside `.proofloop` over the
 * existing root/path/TOCTOU primitives:
 *   - facts written through one store instance are deterministically
 *     rehydrated by a NEW store instance (restart) — PO-S01-A-03;
 *   - corrupted / half-written / symlink / out-of-root states never replace
 *     the last valid snapshot and fail closed — PO-S01-A-04.
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
import {
  MesSnapshotStore,
  createMesSnapshotStore,
  MesSnapshotStoreError,
  MES_SNAPSHOT_REL,
} from '../dist/mes/store';
import type { MesFactEnvelope } from '../dist/mes/store';
import { verifyAcceptedStageReviewResultSupport } from '../dist/mes/binding';
import { buildAcceptedPlanTaskGraph } from '../dist/execute/plan-task-graph';
import { canonicalStringify } from '../dist/cli/proofloop-common';
import { makeFixture, sha } from './helpers';

const PLAN_REF = 'delivery/stages/S01/plan.md';
const DIGEST = 'b'.repeat(64);

function acceptedBinding() {
  return {
    binding_stage: 'accepted' as const,
    accepted_plan_ref: PLAN_REF,
    source_candidate_plan_ref: PLAN_REF,
    verification_result_ref: 'mes:verification:S01:1',
    plan_digest: DIGEST,
  };
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

function stageFact(): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: 'mes:fact:stage:S01',
    fact_kind: 'stage',
    created_by: 'brain',
    authority_refs: ['PRD.md#FR-003'],
    scope: { stage_id: 'S01' },
  };
}

function workFact(id: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:work:${id}`,
    fact_kind: 'work',
    created_by: 'brain',
    authority_refs: ['PRD.md#FR-003'],
    scope: { stage_id: 'S01', slice_id: 'S01-A', task_id: 'S01-A-T01' },
    work_id: `mes:work:${id}`,
    plan_binding: acceptedBinding(),
    git_basis: { head: '42091fc', branch: 'proofloop-s01-a', worktree: '.' },
  };
}

function writeCorruptSnapshot(root: string): void {
  const abs = path.join(root, MES_SNAPSHOT_REL);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '{"schema_version": 2, "facts": [}', 'utf8');
}

describe('MES snapshot store (S01-A-T02)', () => {
  test('rehydrates the same fact set after restart', () => {
    const fixture = makeFixture();
    try {
      const facts: MesFactEnvelope[] = [
        projectFact('p1'),
        stageFact(),
        workFact('w1'),
        workFact('w2'),
      ];
      const writer = createMesSnapshotStore(fixture.dir);
      writer.write(facts);

      // A NEW store instance (fresh "process") re-reads the same validated set.
      const reader = new MesSnapshotStore(fixture.dir);
      const rehydrated = reader.read();
      assert.equal(rehydrated.length, facts.length);
      assert.deepEqual(rehydrated, facts);

      // Deterministic: repeated reads are identical and order-stable.
      assert.deepEqual(reader.read(), rehydrated);
    } finally {
      fixture.cleanup();
    }
  });

  test('fails closed without losing the last valid snapshot', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const v1: MesFactEnvelope[] = [projectFact('v1'), stageFact(), workFact('v1')];
      store.write(v1);
      assert.deepEqual(store.read(), v1);

      // Sparse input arrays must be rejected before they can serialize a hole as null.
      const sparseFacts = new Array<MesFactEnvelope>(1);
      assert.equal(0 in sparseFacts, false, 'fixture must contain a real sparse hole');
      assert.throws(() => store.write(sparseFacts), MesSnapshotStoreError);
      assert.deepEqual(store.read(), v1, 'sparse write must not clobber last valid snapshot');

      // A non-array object is not a valid fact-set container. It must fail
      // before Array.from can coerce it to an empty list and replace v1.
      assert.throws(
        () => store.write({} as unknown as MesFactEnvelope[]),
        MesSnapshotStoreError,
        'non-array fact input must fail closed',
      );
      assert.deepEqual(store.read(), v1, 'non-array write must not clobber last valid snapshot');

      // 1) Invalid fact (binding-inconsistent work) fails closed and does NOT
      //    replace the valid snapshot.
      const invalid: MesFactEnvelope[] = [
        projectFact('bad'),
        {
          schema_version: 2,
          fact_id: 'mes:fact:work:bad',
          fact_kind: 'work',
          created_by: 'brain',
          authority_refs: ['PRD.md#FR-003'],
          work_id: 'mes:work:bad',
          plan_binding: {
            binding_stage: 'candidate' as const,
            candidate_plan_ref: PLAN_REF,
            accepted_plan_ref: null,
            verdict: 'PLAN_READY' as const,
          },
        },
      ];
      assert.throws(() => store.write(invalid), MesSnapshotStoreError);
      assert.deepEqual(store.read(), v1, 'invalid write must not clobber last valid snapshot');

      // 1a) The store enforces the SAME closed envelope contract on write:
      //     canonical-ref root-escape and incomplete-NORMAL-work facts are
      //     rejected before any file is touched (CV-S01-A-F001).
      const traversalFact = {
        schema_version: 2,
        fact_id: 'mes:fact:project:traversal',
        fact_kind: 'project',
        created_by: 'brain',
        authority_refs: ['../outside.md#FR-003'],
      };
      const incompleteWork = {
        schema_version: 2,
        fact_id: 'mes:fact:work:incomplete',
        fact_kind: 'work',
        created_by: 'brain',
        authority_refs: ['PRD.md#FR-003'],
        scope: { stage_id: 'S01' },
        plan_binding: acceptedBinding(),
      };
      for (const bad of [traversalFact, incompleteWork]) {
        assert.throws(
          () => store.write([...v1, bad as unknown as MesFactEnvelope]),
          MesSnapshotStoreError,
        );
      }
      assert.deepEqual(
        store.read(),
        v1,
        'invalid facts must never clobber the last valid snapshot',
      );

      // 1b) A hand-crafted snapshot on disk whose facts bypass the store but
      //     violate the closed envelope contract fails closed on READ — the
      //     store never yields partial or invalid facts.
      const snapAbs = path.join(fixture.dir, MES_SNAPSHOT_REL);
      fs.mkdirSync(path.dirname(snapAbs), { recursive: true });
      fs.writeFileSync(
        snapAbs,
        JSON.stringify({
          schema_version: 2,
          facts: [projectFact('ok'), incompleteWork],
        }),
        'utf8',
      );
      assert.throws(() => store.read(), MesSnapshotStoreError);

      // 2) Corrupted snapshot on disk fails closed (no partial read).
      writeCorruptSnapshot(fixture.dir);
      assert.throws(() => store.read(), MesSnapshotStoreError);
      const corruptBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');

      // 3) (PO-S05-B-04) An ORDINARY delta write over a corrupt current
      //    snapshot is no-write: the retained facts are invisible to the
      //    retention merge, so a rewrite would silently discard them. Only a
      //    disaster recovery baseline (exact-source seam) may rewrite an
      //    unrecoverable snapshot.
      const v2: MesFactEnvelope[] = [projectFact('v2'), stageFact()];
      assert.throws(() => store.write(v2), MesSnapshotStoreError);
      assert.equal(
        fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'),
        corruptBytes,
        'an ordinary write must never replace a corrupt snapshot (retained facts never silently discarded)',
      );
      assert.throws(() => store.read(), MesSnapshotStoreError, 'the corrupt state stays fail-closed unreadable');

      // 4) A symlink at the snapshot path is rejected on read (no-follow).
      const abs = path.join(fixture.dir, MES_SNAPSHOT_REL);
      fs.rmSync(abs);
      const outside = path.join(fixture.dir, 'outside.json');
      fs.writeFileSync(outside, '{"schema_version": 2, "facts": []}', 'utf8');
      fs.symlinkSync(outside, abs);
      assert.throws(() => store.read(), MesSnapshotStoreError);
      // 5) An INTERMEDIATE symlink escape (root/.proofloop -> outside empty
      //    dir) must fail closed even when the escaped target has no snapshot.
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-mes-outside-'));
      try {
        const proofloopAbs = path.join(fixture.dir, '.proofloop');
        fs.rmSync(proofloopAbs, { recursive: true, force: true });
        fs.symlinkSync(outsideDir, proofloopAbs, 'dir');
        assert.throws(() => store.read(), MesSnapshotStoreError);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects unknown top-level container fields fail-closed on read (CV S01-STAGE-REVIEW-F001)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const valid: MesFactEnvelope[] = [projectFact('p1'), stageFact()];
      store.write(valid);
      assert.deepEqual(store.read(), valid);

      // Hand-craft a snapshot whose container carries an injected unknown
      // top-level field alongside a VALID facts array. The store must reject
      // the whole container before returning any facts — never accept the
      // extras silently.
      const snapAbs = path.join(fixture.dir, MES_SNAPSHOT_REL);
      const injectedVariants: unknown[] = [
        { schema_version: 2, facts: valid as unknown[], injected: 'payload' },
        { schema_version: 2, facts: valid as unknown[], ['x-extra']: { nested: true } },
      ];
      for (const variant of injectedVariants) {
        fs.writeFileSync(snapAbs, JSON.stringify(variant), 'utf8');
        assert.throws(() => store.read(), MesSnapshotStoreError, 'unknown top-level container field must fail closed');
      }

      // (PO-S05-B-04) An ordinary rewrite over the injected corrupt container
      // is no-write — the unknown-field snapshot stays fail-closed untouched
      // (a rewrite would silently discard the retained facts).
      const injectedBytes = fs.readFileSync(snapAbs, 'utf8');
      assert.throws(() => store.write(valid), MesSnapshotStoreError);
      assert.equal(
        fs.readFileSync(snapAbs, 'utf8'),
        injectedBytes,
        'an ordinary write must never replace an injected corrupt container',
      );
      assert.throws(() => store.read(), MesSnapshotStoreError, 'the injected corrupt container stays fail-closed');
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects broken final and intermediate symlinks instead of treating them as an empty store (CV S01-STAGE-REVIEW-F001)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);

      // Preserve pre-seed semantics: a truly absent snapshot is an empty store.
      assert.deepEqual(store.read(), [], 'fresh store with no .proofloop must be an empty pre-seed store');

      // Seed a valid snapshot so the symlink cases below replace a REAL store.
      const valid: MesFactEnvelope[] = [projectFact('p1'), stageFact()];
      store.write(valid);
      assert.deepEqual(store.read(), valid);

      const snapAbs = path.join(fixture.dir, MES_SNAPSHOT_REL);

      // 1) BROKEN FINAL symlink — target inside root but non-existent. The
      //    whole-path lstat reports ENOENT exactly like a missing snapshot;
      //    the store must NOT misclassify it as an empty pre-seed store.
      fs.rmSync(snapAbs);
      fs.symlinkSync(path.join(fixture.dir, 'nowhere.json'), snapAbs);
      assert.throws(
        () => store.read(),
        MesSnapshotStoreError,
        'broken final symlink (inside-root target) must fail closed',
      );

      // 2) BROKEN FINAL symlink with an outside-root dangling target.
      fs.rmSync(snapAbs);
      fs.symlinkSync(path.join(os.tmpdir(), 'pl-absent-target', 'final.json'), snapAbs);
      assert.throws(
        () => store.read(),
        MesSnapshotStoreError,
        'broken final symlink (outside-root target) must fail closed',
      );

      // 3) BROKEN INTERMEDIATE symlink (.proofloop) — inside-root non-existent
      //    target. The store must reject rather than report an empty store.
      const proofloopAbs = path.join(fixture.dir, '.proofloop');
      fs.rmSync(proofloopAbs, { recursive: true, force: true });
      fs.symlinkSync(path.join(fixture.dir, 'missing-dir'), proofloopAbs);
      assert.throws(
        () => store.read(),
        MesSnapshotStoreError,
        'broken intermediate symlink (inside-root target) must fail closed',
      );

      // 4) BROKEN INTERMEDIATE symlink with an outside-root dangling target.
      fs.rmSync(proofloopAbs);
      fs.symlinkSync(path.join(os.tmpdir(), 'pl-absent-root', 'outside'), proofloopAbs);
      assert.throws(
        () => store.read(),
        MesSnapshotStoreError,
        'broken intermediate symlink (outside-root target) must fail closed',
      );

      // 5) After a legitimate rewrite the store is readable again.
      fs.rmSync(proofloopAbs);
      store.write(valid);
      assert.deepEqual(
        store.read(),
        valid,
        'valid write must restore a readable snapshot after corrupted symlink states',
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects a NEW fully legacy-shaped PVR/PA no-write while retained legacy replay stays byte-stable (S05-A-T01 prerequisite mixed fixture)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const GIT_BASIS = { head: 'b'.repeat(40), branch: 'proofloop-s05', worktree: '.' };

      // Seed the snapshot with the S02-era durable legacy PVR (no scope/cycle,
      // the retained legacy shape): write the current valid snapshot file
      // directly, exactly as the production snapshot carries retained facts.
      const legacyPvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S02:1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['PRD.md#FR-005'],
        work_id: 'mes:work:S02:planning:1',
        result_ref: 'mes:verification:S02:1',
        verifier_role: 'stage-plan-verifier',
        action_token: 'e790c08d',
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: 'delivery/stages/S02/plan.md',
          accepted_plan_ref: null,
          verdict: 'PLAN_READY',
          plan_digest: 'c'.repeat(64),
        },
        git_basis: GIT_BASIS,
      };
      const cyclePvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:3',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['PRD.md#FR-005'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:1',
        result_ref: 'mes:verification:S05:3',
        verifier_role: 'stage-plan-verifier',
        action_token: 's05-spv-3',
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: 'delivery/stages/S05/plan.md',
          accepted_plan_ref: null,
          verdict: 'FINDINGS',
          plan_digest: 'd'.repeat(64),
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
      };

      const snapAbs = path.join(fixture.dir, MES_SNAPSHOT_REL);
      fs.mkdirSync(path.dirname(snapAbs), { recursive: true });
      fs.writeFileSync(snapAbs, canonicalStringify({ schema_version: 2, facts: [legacyPvr] }), 'utf8');
      const seededBytes = fs.readFileSync(snapAbs, 'utf8');

      // A NEW legacy-shaped PVR/PA (no scope.stage_id, no delivery_cycle_id)
      // is a current NORMAL planning fact lacking scope/cycle and fails closed
      // no-write; the byte-identical replay of the RETAINED legacy fact stays
      // lawful and byte-stable (history-only, no upgrade).
      const newLegacyPvr: MesFactEnvelope = {
        ...legacyPvr,
        fact_id: 'mes:fact:planning_verification_result:S05:new-legacy',
        result_ref: 'mes:verification:S05:new-legacy',
      };
      assert.throws(
        () => store.write([newLegacyPvr]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('legacy'),
        'a NEW legacy-shaped PVR must fail closed no-write',
      );
      assert.equal(fs.readFileSync(snapAbs, 'utf8'), seededBytes, 'the rejected write must leave the snapshot byte-identical');

      const newLegacyPa: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S05:new-legacy',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['PRD.md#FR-005'],
        plan_binding: {
          binding_stage: 'accepted' as const,
          accepted_plan_ref: 'delivery/stages/S02/plan.md',
          source_candidate_plan_ref: 'delivery/stages/S02/plan.md',
          verification_result_ref: 'mes:verification:S02:1',
          plan_digest: 'c'.repeat(64),
        },
        git_basis: GIT_BASIS,
      };
      assert.throws(
        () => store.write([newLegacyPa]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('legacy'),
        'a NEW legacy-shaped plan_acceptance must fail closed no-write',
      );
      assert.equal(fs.readFileSync(snapAbs, 'utf8'), seededBytes, 'the rejected write must leave the snapshot byte-identical');

      // A changed payload under the retained legacy fact_id is a changed
      // current NORMAL planning fact and also fails closed no-write.
      const changedLegacy: MesFactEnvelope = {
        ...legacyPvr,
        plan_binding: {
          binding_stage: 'candidate' as const,
          candidate_plan_ref: 'delivery/stages/S02/plan.md',
          accepted_plan_ref: null,
          verdict: 'PLAN_READY' as const,
          plan_digest: 'e'.repeat(64),
        },
      };
      assert.throws(
        () => store.write([changedLegacy]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a changed payload under the retained legacy fact_id must fail closed no-write',
      );
      assert.equal(fs.readFileSync(snapAbs, 'utf8'), seededBytes, 'the rejected write must leave the snapshot byte-identical');

      // Byte-identical replay of the RETAINED legacy fact stays lawful and
      // byte-stable (history-only, no upgrade).
      store.write([legacyPvr]);
      assert.equal(fs.readFileSync(snapAbs, 'utf8'), seededBytes, 'an identical replay of the retained legacy PVR must be byte-stable');

      // The mixed submission (retained legacy replay + new cycle fact) is
      // written canonically and stays byte-stable on identical replay.
      store.write([legacyPvr, cyclePvr]);
      const snapBefore = fs.readFileSync(snapAbs, 'utf8');
      store.write([legacyPvr, cyclePvr]);
      assert.equal(
        fs.readFileSync(snapAbs, 'utf8'),
        snapBefore,
        'identical replay must be byte-stable',
      );
      const rehydrated = store.read();
      assert.equal(rehydrated.filter((f) => f.fact_id === cyclePvr.fact_id).length, 1, 'the new cycle fact must appear exactly once');
      const legacyStored = rehydrated.find((f) => f.fact_id === legacyPvr.fact_id)!;
      assert.equal(
        (legacyStored.plan_binding as { delivery_cycle_id?: string }).delivery_cycle_id,
        undefined,
        'legacy retained fact must not be upgraded with a cycle',
      );
      const cycleStored = rehydrated.find((f) => f.fact_id === cyclePvr.fact_id)!;
      assert.equal(cycleStored.scope?.stage_id, 'S05');
      assert.equal((cycleStored.plan_binding as { delivery_cycle_id?: string }).delivery_cycle_id, CYCLE);
    } finally {
      fixture.cleanup();
    }
  });

  test('any ordinary write over an unreadable snapshot is no-write (S05-B-T01 / PO-S05-B-04)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      writeCorruptSnapshot(fixture.dir);
      assert.throws(() => store.read(), MesSnapshotStoreError);
      const corruptBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');

      const cyclePvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:4',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['PRD.md#FR-005'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:1',
        result_ref: 'mes:verification:S05:4',
        verifier_role: 'stage-plan-verifier',
        action_token: 's05-spv-4',
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: 'delivery/stages/S05/plan.md',
          accepted_plan_ref: null,
          verdict: 'PLAN_READY',
          plan_digest: 'e'.repeat(64),
          delivery_cycle_id: CYCLE,
        },
        git_basis: { head: 'f'.repeat(40), branch: 'proofloop-s05', worktree: '.' },
      };
      // Even a fully valid cycle-scoped PVR must not rewrite an unreadable
      // current snapshot: the durable retained planning facts are invisible to
      // the retention merge, so the write is no-write and the corrupt state
      // is never silently treated as an empty store.
      assert.throws(() => store.write([cyclePvr]), (err: unknown) =>
        err instanceof MesSnapshotStoreError && err.code === 'corrupt-snapshot' && err.message.includes('no-write'),
      );
      assert.equal(
        fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'),
        corruptBytes,
        'an unreadable snapshot must never be replaced by a planning-transaction write',
      );

      // (PO-S05-B-04) The no-write boundary covers EVERY ordinary delta — a
      // non-planning write over the same corrupt snapshot must also fail
      // closed (never treated as an empty store, retained facts never
      // silently discarded). Only a disaster recovery baseline (exact-source
      // seam) may rewrite an unrecoverable snapshot.
      assert.throws(() => store.write([projectFact('repair')]), (err: unknown) =>
        err instanceof MesSnapshotStoreError && err.code === 'corrupt-snapshot' && err.message.includes('no-write'),
      );
      assert.equal(
        fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'),
        corruptBytes,
        'the corrupt snapshot stays byte-stable after every ordinary no-write',
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('corrupt ordinary write no-write: execute-owned deltas never replace an unreadable/corrupt/path-invalid current snapshot, retained facts are never silently discarded (PO-S05-B-04)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      // A REAL durable snapshot with retained facts of multiple ordinary kinds.
      const retained: MesFactEnvelope[] = [
        projectFact('retained-1'),
        stageFact(),
        workFact('retained-w1'),
        workFact('retained-w2'),
      ];
      store.write(retained);
      assert.deepEqual(store.read(), retained);

      // Corrupt the current snapshot: read fails closed, so the retained
      // facts are invisible to any rewrite.
      writeCorruptSnapshot(fixture.dir);
      const corruptBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');
      assert.throws(() => store.read(), MesSnapshotStoreError);

      // EVERY ordinary delta kind must fail closed no-write and leave the
      // corrupt bytes byte-identical — a rewrite would silently discard the
      // retained work/result/planning/terminal facts.
      const deltas: MesFactEnvelope[][] = [
        [workFact('delta-w3')],
        [projectFact('delta-p')],
        [workFact('delta-w4'), stageFact()],
      ];
      for (const delta of deltas) {
        assert.throws(() => store.write(delta), (err: unknown) =>
          err instanceof MesSnapshotStoreError && err.code === 'corrupt-snapshot' && err.message.includes('no-write'),
        );
        assert.equal(
          fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'),
          corruptBytes,
          `ordinary delta [${delta.map((f) => f.fact_kind).join(', ')}] must be byte-stable no-write`,
        );
      }

      // PATH-INVALID current snapshot (a symlinked snapshot path): an
      // ordinary delta must also fail closed no-write — a symlinked snapshot
      // is never a missing pre-seed store (ordinary read failure never treats
      // existingFacts as empty).
      const abs = path.join(fixture.dir, MES_SNAPSHOT_REL);
      fs.rmSync(abs);
      const outside = path.join(fixture.dir, 'outside.json');
      fs.writeFileSync(outside, '{"schema_version": 2, "facts": []}', 'utf8');
      fs.symlinkSync(outside, abs);
      assert.throws(() => store.read(), MesSnapshotStoreError);
      assert.throws(() => store.write([workFact('delta-w5')]), (err: unknown) =>
        err instanceof MesSnapshotStoreError && err.message.includes('no-write'),
      );
      assert.ok(fs.lstatSync(abs).isSymbolicLink(), 'the symlinked snapshot path stays untouched');
    } finally {
      fixture.cleanup();
    }
  });

  test('enforces cross-fact cycle equality over submitted ∪ retained facts: new/changed plan-bound facts must carry exactly the unique current planning binding cycle, accepted stage + same-cycle Review result same ID (S05-B-T01 / PO-S05-B-01)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const S05_PLAN = 'delivery/stages/S05/plan.md';
      const S05_DIGEST = sha('s05-plan-v1');
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s05-b', worktree: '.' };
      const PVR_RESULT_REF = 'mes:result:S05:planning-verification-1';
      const STAGE_RESULT_REF = 'mes:result:S05:stage-review-1';

      const pvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:1',
        result_ref: PVR_RESULT_REF,
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
        git_basis: GIT_BASIS,
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
          verification_result_ref: PVR_RESULT_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      // Seed the unique current candidate/accepted planning binding with the cycle.
      store.write([pvr, pa]);
      assert.equal(store.read().length, 2);

      // A NEW plan-bound fact carrying exactly CYCLE persists; restart rehydrates the same set.
      const work: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:work:S05:S05-B:1',
        fact_kind: 'work',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05', slice_id: 'S05-B' },
        work_id: 'mes:work:S05:S05-B:1',
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: PVR_RESULT_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      store.write([work]);
      const withWork = store.read();
      assert.equal(withWork.length, 3);
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), withWork);

      // 缺失: a NEW plan-bound fact without the cycle while a current cycle exists → no-write.
      const missingCycleWork: MesFactEnvelope = {
        ...work,
        fact_id: 'mes:fact:work:S05:S05-B:missing-cycle',
        plan_binding: { ...work.plan_binding!, delivery_cycle_id: undefined as unknown as string },
      };
      const goodBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');
      assert.throws(
        () => store.write([missingCycleWork]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a NEW plan-bound fact missing the cycle must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), goodBytes, 'missing-cycle write must be byte-stable no-write');

      // 跨 cycle: a NEW plan-bound fact with a DIFFERENT cycle → no-write.
      const crossCycleWork: MesFactEnvelope = {
        ...work,
        fact_id: 'mes:fact:work:S05:S05-B:cross-cycle',
        plan_binding: { ...work.plan_binding!, delivery_cycle_id: 'cycle-other' },
      };
      assert.throws(
        () => store.write([crossCycleWork]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a NEW plan-bound fact with a different cycle must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), goodBytes, 'cross-cycle write must be byte-stable no-write');

      // Ambiguous: two distinct cycles among planning bindings in the resulting set → no-write.
      const crossPvr: MesFactEnvelope = {
        ...pvr,
        fact_id: 'mes:fact:planning_verification_result:S05:cross',
        result_ref: 'mes:result:S05:planning-verification-cross',
        plan_binding: { ...pvr.plan_binding!, delivery_cycle_id: 'cycle-other' },
      };
      assert.throws(
        () => store.write([crossPvr]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'two distinct cycles among planning bindings in the resulting set must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), goodBytes, 'ambiguous write must be byte-stable no-write');

      // Accepted stage + same-cycle Review result same ID: the stage closes its
      // verification ref → durable PLAN_READY PVR and result_ref → Review-owned
      // stage-only result in the SAME submitted set (order-independent).
      const stage: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S05:accepted',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: PVR_RESULT_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
        result_ref: STAGE_RESULT_REF,
      };
      const reviewResult: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S05:stage-review-1',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:review:1',
        result_ref: STAGE_RESULT_REF,
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: PVR_RESULT_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
        result_id: 'stage-review-1',
        result_payload_digest: DIGEST,
      };
      store.write([stage, reviewResult]);
      const persisted = store.read();
      // work is replace-all (not a retained kind): the partial write keeps the
      // planning binding + the newly closed accepted stage and its Review result.
      assert.equal(persisted.length, 4);
      assert.ok(persisted.some((f) => f.fact_id === stage.fact_id));
      assert.ok(persisted.some((f) => f.fact_id === reviewResult.fact_id));
      assert.ok(persisted.some((f) => f.fact_id === pvr.fact_id));
      assert.ok(persisted.some((f) => f.fact_id === pa.fact_id));
      assert.equal(
        verifyAcceptedStageReviewResultSupport(
          persisted.find((f) => f.fact_id === stage.fact_id)!,
          persisted.find((f) => f.fact_id === reviewResult.fact_id)!,
        ),
        undefined,
        'accepted stage + same-cycle Review result must close',
      );
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), persisted, 'restart rebuilds the same closed set');

      // Accepted stage + DIFFERENT-cycle Review result → no-write (cross-cycle review).
      const crossReview: MesFactEnvelope = {
        ...reviewResult,
        fact_id: 'mes:fact:result:S05:stage-review-cross',
        result_ref: 'mes:result:S05:stage-review-cross',
        plan_binding: { ...reviewResult.plan_binding!, delivery_cycle_id: 'cycle-other' },
      };
      const crossStage: MesFactEnvelope = {
        ...stage,
        fact_id: 'mes:fact:stage:S05:accepted-cross',
        result_ref: 'mes:result:S05:stage-review-cross',
      };
      const goodBytes2 = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');
      assert.throws(
        () => store.write([crossStage, crossReview]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'accepted stage + cross-cycle Review result must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), goodBytes2, 'cross-cycle stage write must be byte-stable no-write');
    } finally {
      fixture.cleanup();
    }
  });

  test('whole-resulting-set delta persistence: existing Work/Task/Result/Git/planning/review/terminal facts survive canonical-equivalent under a new PVR/Result/Finding delta, restart rebuilds the same set (S05-B-T01 / PO-S05-B-04)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const S05_PLAN = 'delivery/stages/S05/plan.md';
      const S05_DIGEST = sha('s05-plan-v1');
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s05-b', worktree: '.' };
      const PVR_RESULT_REF = 'mes:result:S05:planning-verification-1';
      const STAGE_RESULT_REF = 'mes:result:S05:stage-review-1';

      const acceptedBinding = () => ({
        binding_stage: 'accepted' as const,
        accepted_plan_ref: S05_PLAN,
        source_candidate_plan_ref: S05_PLAN,
        verification_result_ref: PVR_RESULT_REF,
        plan_digest: S05_DIGEST,
        delivery_cycle_id: CYCLE,
      });

      const pvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:1',
        result_ref: PVR_RESULT_REF,
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
        git_basis: GIT_BASIS,
      };
      const pa: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S05:1',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        supersedes_plan_acceptance_ref: null,
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
      };
      const work: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:work:S05:S05-B:1',
        fact_kind: 'work',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05', slice_id: 'S05-B' },
        work_id: 'mes:work:S05:S05-B:1',
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
      };

      // Task fact: the brand-bound accepted-plan graph capability is required.
      const planGraph = buildAcceptedPlanTaskGraph(
        {
          stage: 'S05',
          project_stage_map_ref: 'delivery/project-stage-map.md#S05',
          slices: [
            {
              slice: 'S05-B',
              goal: 'whole-resulting-set delta',
              depends_on: [],
              tasks: [
                { task: 'S05-B-T01', goal: 'store delta', dependencies: [] },
                { task: 'S05-B-T02', goal: 'terminal delta', dependencies: ['S05-B-T01'] },
              ],
            },
          ],
        },
        S05_PLAN,
        S05_DIGEST,
      );
      const task: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:task:S05-B-T01',
        fact_kind: 'task',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#5.1'],
        scope: { stage_id: 'S05', slice_id: 'S05-B', task_id: 'S05-B-T01' },
        work_id: 'mes:work:S05:S05-B:1',
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
        task_status: 'TASK_COMPLETE',
        depends_on_task_ids: [],
      };
      const result: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S05:S05-B-T01:1',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#4.3'],
        scope: { stage_id: 'S05', slice_id: 'S05-B', task_id: 'S05-B-T01' },
        work_id: 'mes:work:S05:S05-B:1',
        result_ref: 'mes:result:S05:S05-B-T01:1',
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
        result_id: 'attempt-s05-b-t01',
        result_payload_digest: DIGEST,
      };
      const gitCandidate: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:git:S05:S05-B:candidate:1',
        fact_kind: 'git',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#5.3'],
        scope: { stage_id: 'S05', slice_id: 'S05-B' },
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
        git_subkind: 'candidate',
        candidate_ref: 'proofloop-s05-b',
        candidate_base_ref: '1'.repeat(40),
        commit_sha: '2'.repeat(40),
        changed_files: ['packages/runtime/src/mes/store.ts'],
      };
      const gitIntegration: MesFactEnvelope = {
        ...gitCandidate,
        fact_id: 'mes:fact:git:S05:S05-B:integration:1',
        git_subkind: 'integration',
        commit_sha: '3'.repeat(40),
      };
      const finding: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:finding:S05:S05-B:cv-1',
        fact_kind: 'finding',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.3'],
        scope: { stage_id: 'S05', slice_id: 'S05-B' },
        work_id: 'mes:work:S05:S05-B:1',
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
        verifier_verdict: 'FINDINGS',
        claimed_route_code: 'IMPLEMENTATION_DEFECT',
        finding_evidence_refs: ['mes:result:S05:S05-B-T01:1'],
      };
      const disposition: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:finding_disposition:S05:S05-B:cv-1',
        fact_kind: 'finding_disposition',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.3'],
        scope: { stage_id: 'S05', slice_id: 'S05-B' },
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
        disposition_ref: 'mes:disposition:S05:S05-B:cv-1',
        finding_ref: finding.fact_id,
        finding_disposition: 'ACCEPTED',
        claimed_route_code: 'IMPLEMENTATION_DEFECT',
        accepted_route_code: 'IMPLEMENTATION_DEFECT',
        basis_refs: ['tech-spec/contracts.md#2.2.3'],
        reason: 'finding supported by plan and scope',
        resume_target: 'producer',
      };
      const reviewResult: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S05:stage-review-1',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:review:1',
        result_ref: STAGE_RESULT_REF,
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
        result_id: 'stage-review-1',
        result_payload_digest: DIGEST,
      };
      const stage: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S05:accepted',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
        result_ref: STAGE_RESULT_REF,
      };
      const projectReady: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:project_ready:1',
        fact_kind: 'project_ready',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
        planned_stage_ids: ['S05'],
        delivery_cycle_id: CYCLE,
        supersedes_project_ready_ref: null,
        git_basis: GIT_BASIS,
      };

      // gen1 opens and executes the CYCLE WITHOUT the terminal: the closing
      // PROJECT_READY terminal is written LAST (real flow), because once the
      // terminal is retained the cycle is CLOSED / history-only and accepts no
      // further same-cycle write-through.
      const gen1 = [pvr, pa, work, task, result, gitCandidate, gitIntegration, finding, disposition, reviewResult, stage];
      store.write(gen1, { acceptedPlanTaskGraph: planGraph });
      const persisted1 = store.read();
      assert.equal(persisted1.length, gen1.length, 'gen1 persists the full resulting set exactly once');
      assert.deepEqual(persisted1, gen1);

      // Delta: a new Result + a new Finding appended to the SAME whole
      // resulting set (replace-all resubmission of Work/Task/Result/Git) stay
      // legal; a second PVR for the SAME stage/cycle/plan identity is a
      // duplicate planning binding and fails closed no-write byte-stable
      // (CV-S06-D-cv-2 / E2E-23 / STATIC-30: same-stage/cycle/plan PVR
      // uniqueness — a distinct fact_id even with a different result_ref is
      // still one identity's second verification anchor).
      const deltaPvr: MesFactEnvelope = {
        ...pvr,
        fact_id: 'mes:fact:planning_verification_result:S05:2',
        result_ref: 'mes:result:S05:planning-verification-2',
      };
      const deltaResult: MesFactEnvelope = {
        ...result,
        fact_id: 'mes:fact:result:S05:S05-B-T02:1',
        result_ref: 'mes:result:S05:S05-B-T02:1',
        result_id: 'attempt-s05-b-t02',
      };
      const deltaFinding: MesFactEnvelope = {
        ...finding,
        fact_id: 'mes:fact:finding:S05:S05-B:cv-2',
        finding_evidence_refs: ['mes:result:S05:S05-B-T02:1'],
      };
      const gen2 = [...gen1, deltaResult, deltaFinding];
      store.write(gen2, { acceptedPlanTaskGraph: planGraph });
      const persisted2 = store.read();
      assert.equal(persisted2.length, gen2.length, 'delta write persists every fact exactly once');
      // Every gen1 fact survives canonical-equivalent under the delta.
      for (const fact of gen1) {
        const again = persisted2.find((f) => f.fact_id === fact.fact_id);
        assert.ok(again, `gen1 fact ${fact.fact_id} must survive the delta`);
        assert.equal(canonicalStringify(again), canonicalStringify(fact), `gen1 fact ${fact.fact_id} must stay canonical-equivalent`);
      }
      // New facts appear exactly once.
      for (const fact of [deltaResult, deltaFinding]) {
        assert.equal(persisted2.filter((f) => f.fact_id === fact.fact_id).length, 1, `${fact.fact_id} exactly once`);
      }
      // Restart rebuilds the same resulting set.
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), persisted2, 'restart rebuilds the same set');
      // (S06 post-recovery Authority update; supersedes CV-S06-D-cv-2) The
      // SAME-identity second PVR (deltaPvr) is now LEGAL verification evidence
      // — candidate PVRs never determine accepted-generation currentness and no
      // same-identity PVR uniqueness closure exists (contracts §2.2.2 /
      // architecture #/entities/planning-acceptance-succession). It persists as
      // an additional durable evidence fact while every earlier fact stays
      // canonical-equivalent. Two PVRs sharing ONE `result_ref` remain ambiguous
      // (the exact-resolution closure), and a cross-cycle delta PVR stays no-write.
      store.write([...gen2, deltaPvr]);
      const persistedWithEvidence = store.read();
      assert.ok(persistedWithEvidence.some((f) => f.fact_id === deltaPvr.fact_id), 'a same-identity second PVR is legal verification evidence and persists');
      for (const fact of persisted2) {
        const again = persistedWithEvidence.find((f) => f.fact_id === fact.fact_id);
        assert.ok(again, `fact ${fact.fact_id} must survive the same-identity PVR delta`);
        assert.equal(canonicalStringify(again), canonicalStringify(fact), `fact ${fact.fact_id} must stay canonical-equivalent under the same-identity PVR delta`);
      }
      // Two PVR facts sharing one durable result_ref remain ambiguous no-write.
      const duplicateRefPvr: MesFactEnvelope = {
        ...deltaPvr,
        fact_id: 'mes:fact:planning_verification_result:S05:dup-ref',
        result_ref: pvr.result_ref,
      };
      const beforeAmbiguous = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');
      assert.throws(
        () => store.write([...persistedWithEvidence, duplicateRefPvr]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('ambiguous'),
        'two PVRs sharing one result_ref must be ambiguous no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), beforeAmbiguous, 'ambiguous result_ref write must be byte-stable no-write');
      const crossCyclePvr: MesFactEnvelope = {
        ...pvr,
        fact_id: 'mes:fact:planning_verification_result:S05:3',
        result_ref: 'mes:result:S05:planning-verification-3',
        plan_binding: { ...pvr.plan_binding!, delivery_cycle_id: 'cycle-other' },
      };
      const goodBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');
      assert.throws(
        () => store.write([...gen2, crossCyclePvr]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a cross-cycle delta PVR must be no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), goodBytes, 'cross-cycle delta must be byte-stable no-write');

      // (S06 runtime-unblock) The closing PROJECT_READY terminal is written
      // LAST (real flow): once retained, CYCLE is CLOSED / history-only — its
      // PVR/PA no longer count as a distinct current planning binding, so a
      // NEW unique OPEN cycle's PVR/PA writes atomically next to it while the
      // closed cycle's facts stay byte-equivalent.
      store.write([...gen2, projectReady]);
      const withTerminal = store.read();
      assert.equal(withTerminal.length, gen2.length + 2, 'the closing terminal and the legal same-identity PVR evidence both persist');
      const newCyclePvr: MesFactEnvelope = {
        ...pvr,
        fact_id: 'mes:fact:planning_verification_result:S05:new-cycle',
        result_ref: 'mes:result:S05:planning-verification-new-cycle',
        plan_binding: { ...pvr.plan_binding!, delivery_cycle_id: 'cycle-other' },
      };
      const newCyclePa: MesFactEnvelope = {
        ...pa,
        fact_id: 'mes:fact:plan_acceptance:S05:new-cycle',
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: 'mes:result:S05:planning-verification-new-cycle',
          plan_digest: S05_DIGEST,
          delivery_cycle_id: 'cycle-other',
        },
      };
      store.write([...withTerminal, newCyclePvr, newCyclePa]);
      const unblocked = store.read();
      assert.equal(unblocked.length, gen2.length + 4, 'the new unique open cycle PVR/PA plus the legal same-identity PVR evidence write atomically next to the closed cycle');
      for (const fact of [...gen2, projectReady]) {
        const again = unblocked.find((f) => f.fact_id === fact.fact_id);
        assert.ok(again, `existing fact ${fact.fact_id} must survive the new-cycle write`);
        assert.equal(canonicalStringify(again), canonicalStringify(fact), `existing fact ${fact.fact_id} must stay canonical-equivalent`);
      }
      assert.equal(unblocked.filter((f) => f.fact_id === newCyclePvr.fact_id).length, 1, 'new-cycle PVR exactly once');
      assert.equal(unblocked.filter((f) => f.fact_id === newCyclePa.fact_id).length, 1, 'new-cycle PA exactly once');
      assert.equal(
        (unblocked.find((f) => f.fact_id === newCyclePvr.fact_id)!.plan_binding as { delivery_cycle_id?: string }).delivery_cycle_id,
        'cycle-other',
        'the unique OPEN cycle is the current planning binding',
      );
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), unblocked, 'restart rebuilds the same set');
    } finally {
      fixture.cleanup();
    }
  });

  test('CE-S05-B-01: a new/changed cycle-bearing NORMAL plan-bound fact fails closed when no unique current candidate/accepted planning binding (PVR/PA anchor) exists; old retained legacy history stays readable (CV repair)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const S05_PLAN = 'delivery/stages/S05/plan.md';
      const S05_DIGEST = sha('s05-plan-v1');
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s05-b', worktree: '.' };

      // Legacy store: a no-cycle Work fact (history-only) persists fine — no
      // PVR/PA anchor exists, so no NORMAL cycle can be claimed yet.
      const legacyWork: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:work:S05:S05-B:legacy',
        fact_kind: 'work',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05', slice_id: 'S05-B' },
        work_id: 'mes:work:S05:S05-B:legacy',
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: 'mes:verification:S05:legacy',
          plan_digest: S05_DIGEST,
        },
        git_basis: GIT_BASIS,
      };
      store.write([legacyWork]);
      const legacyBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');

      // A NEW cycle-bearing plan-bound Work fact while NO PVR/PA anchor exists:
      // the cycle identity is orphaned, so the write must fail closed no-write
      // (contracts §7 RESULT_INVALID).
      const orphanCycleWork: MesFactEnvelope = {
        ...legacyWork,
        fact_id: 'mes:fact:work:S05:S05-B:orphan-cycle',
        work_id: 'mes:work:S05:S05-B:orphan-cycle',
        plan_binding: {
          ...legacyWork.plan_binding!,
          delivery_cycle_id: CYCLE,
        },
      };
      assert.throws(
        () => store.write([orphanCycleWork]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID') &&
          err.message.includes('PVR/PA anchor'),
        'a cycle-bearing plan-bound fact without a unique PVR/PA anchor must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), legacyBytes, 'orphan-cycle write must be byte-stable no-write');

      // The retained legacy history stays readable after the rejected write.
      const rehydrated = new MesSnapshotStore(fixture.dir).read();
      assert.deepEqual(rehydrated, [legacyWork], 'legacy history remains readable and unchanged');
    } finally {
      fixture.cleanup();
    }
  });

  test('CE-S05-B-05-PVR: duplicate distinct PLAN_READY planning_verification_result facts resolving to the same result_ref are ambiguous and no-write (CV repair)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const S05_PLAN = 'delivery/stages/S05/plan.md';
      const S05_DIGEST = sha('s05-plan-v1');
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s05-b', worktree: '.' };
      const PVR_RESULT_REF = 'mes:result:S05:planning-verification-1';

      const pvr = (factId: string): MesFactEnvelope => ({
        schema_version: 2,
        fact_id: factId,
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:1',
        result_ref: PVR_RESULT_REF,
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
        git_basis: GIT_BASIS,
      });
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
          verification_result_ref: PVR_RESULT_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      store.write([pvr('mes:fact:planning_verification_result:S05:1'), pa]);
      const goodBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');

      // A second DISTINCT PLAN_READY PVR resolving to the SAME result_ref makes
      // the verification anchor ambiguous — no accepted stage could exact-resolve
      // to exactly one durable PLAN_READY verification, so no-write.
      const duplicatePvr = pvr('mes:fact:planning_verification_result:S05:dup');
      assert.throws(
        () => store.write([duplicatePvr]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID') &&
          err.message.includes('ambiguous'),
        'duplicate distinct PLAN_READY PVR facts for one result_ref must be no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), goodBytes, 'duplicate-PVR write must be byte-stable no-write');
    } finally {
      fixture.cleanup();
    }
  });

  test('CE-S05-B-05-RETAINED: accepted-stage relation closure re-validates every retained cycle-bearing stage across submitted ∪ retained — a submitted execute/generic result masquerade drifting a retained stage result_ref is no-write (CV repair)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const S05_PLAN = 'delivery/stages/S05/plan.md';
      const S05_DIGEST = sha('s05-plan-v1');
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s05-b', worktree: '.' };
      const PVR_RESULT_REF = 'mes:result:S05:planning-verification-1';
      const STAGE_RESULT_REF = 'mes:result:S05:stage-review-1';

      const acceptedBinding = (): MesFactEnvelope['plan_binding'] => ({
        binding_stage: 'accepted' as const,
        accepted_plan_ref: S05_PLAN,
        source_candidate_plan_ref: S05_PLAN,
        verification_result_ref: PVR_RESULT_REF,
        plan_digest: S05_DIGEST,
        delivery_cycle_id: CYCLE,
      });
      const pvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:1',
        result_ref: PVR_RESULT_REF,
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
        git_basis: GIT_BASIS,
      };
      const pa: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S05:1',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        supersedes_plan_acceptance_ref: null,
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
      };
      const stage: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S05:accepted',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
        result_ref: STAGE_RESULT_REF,
      };
      const reviewResult: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S05:stage-review-1',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:review:1',
        result_ref: STAGE_RESULT_REF,
        plan_binding: acceptedBinding(),
        git_basis: GIT_BASIS,
        result_id: 'stage-review-1',
        result_payload_digest: DIGEST,
      };
      // Seed the closed NORMAL cohort: PVR/PA anchor + accepted stage whose
      // result_ref resolves to the durable Review-owned stage-only result.
      store.write([pvr, pa, stage, reviewResult]);
      const goodBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');
      const persisted = store.read();
      assert.equal(persisted.length, 4);

      // A submitted result REPLACEMENT that masquerades as the stage result
      // (execute-owned scope with slice/task ids) drifts the retained stage's
      // result_ref: the accepted-stage relation closure over submitted ∪
      // retained must re-validate the RETAINED stage and fail closed no-write.
      const masqueradeResult: MesFactEnvelope = {
        ...reviewResult,
        fact_id: 'mes:fact:result:S05:stage-review-masquerade',
        work_id: 'mes:work:S05:S05-B:1',
        scope: { stage_id: 'S05', slice_id: 'S05-B', task_id: 'S05-B-T01' },
        result_id: 'attempt-s05-b-t01',
      };
      assert.throws(
        () => store.write([masqueradeResult]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a submitted execute/generic result masquerade drifting a retained stage result_ref must be no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), goodBytes, 'masquerade write must be byte-stable no-write');

      // Restart still rebuilds the exact seeded cohort.
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), persisted, 'restart rebuilds the same closed cohort');
    } finally {
      fixture.cleanup();
    }
  });

  test('CE-S05-B-01-STAGE: a NEW cycle-bearing accepted stage on a legacy store with no PVR/PA anchor, no same-cycle cycle-bearing PROJECT_READY and no Review result is no-write byte-stable while legacy history stays readable (CV recheck-1 repair)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const S05_PLAN = 'delivery/stages/S05/plan.md';
      const S05_DIGEST = sha('s05-plan-v1');
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s05-b', worktree: '.' };

      // Legacy cohort: a no-cycle accepted stage (history-only) persists fine —
      // a fully legacy store has no planning binding and no cycle anchor.
      const legacyStage: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S05:accepted:legacy',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: 'mes:result:S05:planning-verification-legacy',
          plan_digest: S05_DIGEST,
        },
        git_basis: GIT_BASIS,
        result_ref: 'mes:result:S05:stage-review-legacy',
      };
      store.write([legacyStage]);
      const legacyBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');

      // A NEW cycle-bearing accepted stage with NO anchor in the resulting set:
      // no PVR/PA planning binding, no same-cycle cycle-bearing PROJECT_READY
      // terminal, and no resolvable Review result — the cycle identity is
      // orphaned, so the write must fail closed no-write (contracts §7
      // RESULT_INVALID).
      const orphanCycleStage: MesFactEnvelope = {
        ...legacyStage,
        fact_id: 'mes:fact:stage:S05:accepted:orphan-cycle',
        plan_binding: {
          ...legacyStage.plan_binding!,
          delivery_cycle_id: CYCLE,
        },
        result_ref: 'mes:result:S05:stage-review-orphan-cycle',
      };
      assert.throws(
        () => store.write([orphanCycleStage]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID') &&
          err.message.includes('legacy-coexistence'),
        'a cycle-bearing accepted stage without a PVR/PA anchor or a legacy-coexistence same-cycle PROJECT_READY relation must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), legacyBytes, 'orphan-cycle stage write must be byte-stable no-write');

      // The retained legacy history stays readable after the rejected write.
      const rehydrated = new MesSnapshotStore(fixture.dir).read();
      assert.deepEqual(rehydrated, [legacyStage], 'legacy history remains readable and unchanged');
    } finally {
      fixture.cleanup();
    }
  });

  test('CE-S05-B-01-STAGE-TERMINAL: a same-cycle cycle-bearing PROJECT_READY terminal alone must NOT anchor a new cycle-bearing accepted stage when PVR/PA and Review result are absent and no legacy-coexistence cohort exists — no-write byte-stable (CV recheck-2 repair)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const S05_PLAN = 'delivery/stages/S05/plan.md';
      const S05_DIGEST = sha('s05-plan-v1');
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s05-b', worktree: '.' };

      // A single cycle-bearing accepted stage + a same-cycle cycle-bearing
      // PROJECT_READY terminal, with NO legacy (no-cycle) support cohort and
      // NO PVR/PA and NO Review result: the bare terminal must not authorize
      // the stage (CE-S05-B-01-STAGE-TERMINAL) — the terminal cycle can only
      // be validated after the accepted stage has its authoritative
      // PVR/PA/Review closure.
      const soleCycleStage: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S05:accepted:bare-cycle',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: 'mes:result:S05:planning-verification-bare',
          plan_digest: S05_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
        result_ref: 'mes:result:S05:stage-review-bare',
      };
      const bareTerminal: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:project_ready:1',
        fact_kind: 'project_ready',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
        planned_stage_ids: ['S05'],
        delivery_cycle_id: CYCLE,
        supersedes_project_ready_ref: null,
        git_basis: GIT_BASIS,
      };
      assert.throws(
        () => store.write([soleCycleStage, bareTerminal]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID') &&
          err.message.includes('legacy-coexistence'),
        'a bare same-cycle PROJECT_READY terminal must not anchor a cycle-bearing accepted stage without PVR/PA/Review and legacy coexistence',
      );
      assert.equal(
        fs.existsSync(path.join(fixture.dir, MES_SNAPSHOT_REL)),
        false,
        'the rejected write must leave the snapshot untouched (no snapshot was ever written)',
      );

      // The store stays empty TypeError-free: a fresh read yields an empty set.
      assert.equal(new MesSnapshotStore(fixture.dir).read().length, 0, 'nothing was persisted');
    } finally {
      fixture.cleanup();
    }
  });

  test('post-S05 new planning cycle unblock: a retained older cycle closed by a legal matching cycle-bearing PROJECT_READY terminal is history-only — a NEW unique OPEN cycle\'s PVR/PA writes atomically while old facts stay byte-equivalent; two distinct OPEN cycles / missing / cross-cycle / ambiguous new bindings still fail closed no-write (S06 runtime-unblock)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const OLD_CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const NEW_CYCLE = 'cycle-9f8ac4b2d1e64a01b27c3d4e5f607182';
      const S05_PLAN = 'delivery/stages/S05/plan.md';
      const S06_PLAN = 'delivery/stages/S06/plan.md';
      const S05_DIGEST = sha('s05-plan-v1');
      const S06_DIGEST = sha('s06-plan-v1');
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s05-b', worktree: '.' };
      const OLD_PVR_REF = 'mes:result:S05:planning-verification-1';
      const OLD_STAGE_REF = 'mes:result:S05:stage-review-1';
      const NEW_PVR_REF = 'mes:result:S06:planning-verification-1';

      // Seed the RETAINED older (closed) cycle exactly like the post-S05
      // snapshot: PVR/PA + durable accepted-stage support + Review result, then
      // its legal matching cycle-bearing PROJECT_READY terminal.
      const oldPvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:1',
        result_ref: OLD_PVR_REF,
        verifier_role: 'stage-plan-verifier',
        action_token: 's05-spv-1',
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: S05_PLAN,
          accepted_plan_ref: null,
          verdict: 'PLAN_READY',
          plan_digest: S05_DIGEST,
          delivery_cycle_id: OLD_CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      const oldPa: MesFactEnvelope = {
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
          verification_result_ref: OLD_PVR_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: OLD_CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      const oldStage: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S05:accepted',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: OLD_PVR_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: OLD_CYCLE,
        },
        git_basis: GIT_BASIS,
        result_ref: OLD_STAGE_REF,
      };
      const oldReviewResult: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S05:stage-review-1',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:review:1',
        result_ref: OLD_STAGE_REF,
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S05_PLAN,
          source_candidate_plan_ref: S05_PLAN,
          verification_result_ref: OLD_PVR_REF,
          plan_digest: S05_DIGEST,
          delivery_cycle_id: OLD_CYCLE,
        },
        git_basis: GIT_BASIS,
        result_id: 'stage-review-1',
        result_payload_digest: DIGEST,
      };
      const oldTerminal: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:project_ready:2',
        fact_kind: 'project_ready',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
        planned_stage_ids: ['S05'],
        delivery_cycle_id: OLD_CYCLE,
        supersedes_project_ready_ref: null,
        git_basis: GIT_BASIS,
      };
      // The retained older cycle is seeded the way the real post-S05 flow
      // wrote it: PVR/PA first (cycle open), then accepted-stage + Review
      // result, then the closing PROJECT_READY terminal as the LAST write.
      store.write([oldPvr, oldPa]);
      store.write([oldPvr, oldPa, oldStage, oldReviewResult]);
      store.write([oldPvr, oldPa, oldStage, oldReviewResult, oldTerminal]);
      const closedSet = store.read();
      assert.equal(closedSet.length, 5, 'the retained older closed cycle persists');

      // The NEW planning cycle\'s pre-accept PVR + PA (a fresh OPEN cycle) must
      // write atomically over the retained closed cycle: the closed cycle is
      // history-only and does NOT count toward distinct-cycle ambiguity.
      const newPvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S06:1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S06' },
        work_id: 'mes:work:S06:planning:1',
        result_ref: NEW_PVR_REF,
        verifier_role: 'stage-plan-verifier',
        action_token: 's06-spv-1',
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: S06_PLAN,
          accepted_plan_ref: null,
          verdict: 'PLAN_READY',
          plan_digest: S06_DIGEST,
          delivery_cycle_id: NEW_CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      const newPa: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S06:1',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S06' },
        supersedes_plan_acceptance_ref: null,
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S06_PLAN,
          source_candidate_plan_ref: S06_PLAN,
          verification_result_ref: NEW_PVR_REF,
          plan_digest: S06_DIGEST,
          delivery_cycle_id: NEW_CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      store.write([...closedSet, newPvr, newPa]);
      const persisted = store.read();
      assert.equal(persisted.length, 7, 'the new open cycle PVR/PA is durably written next to the retained closed cycle');
      for (const fact of closedSet) {
        const again = persisted.find((f) => f.fact_id === fact.fact_id);
        assert.ok(again, `retained fact ${fact.fact_id} must survive the new-cycle write`);
        assert.equal(canonicalStringify(again), canonicalStringify(fact), `retained fact ${fact.fact_id} stays byte-equivalent`);
      }
      assert.equal(persisted.filter((f) => f.fact_id === newPvr.fact_id).length, 1, 'new PVR exactly once');
      assert.equal(persisted.filter((f) => f.fact_id === newPa.fact_id).length, 1, 'new PA exactly once');
      assert.equal(
        (persisted.find((f) => f.fact_id === newPvr.fact_id)!.plan_binding as { delivery_cycle_id?: string }).delivery_cycle_id,
        NEW_CYCLE,
        'the unique OPEN cycle is the current planning binding',
      );
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), persisted, 'restart rebuilds the same set');

      // The unique open cycle anchors NEW same-cycle facts.
      const newWork: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:work:S06:S06-A:1',
        fact_kind: 'work',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S06', slice_id: 'S06-A' },
        work_id: 'mes:work:S06:S06-A:1',
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S06_PLAN,
          source_candidate_plan_ref: S06_PLAN,
          verification_result_ref: NEW_PVR_REF,
          plan_digest: S06_DIGEST,
          delivery_cycle_id: NEW_CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      store.write([...persisted, newWork]);
      const afterWork = store.read();
      assert.equal(afterWork.filter((f) => f.fact_id === newWork.fact_id).length, 1, 'a NEW fact carrying the unique open cycle persists');
      const openBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');

      // Two distinct OPEN planning cycles are still ambiguous no-write.
      const thirdPvr: MesFactEnvelope = {
        ...newPvr,
        fact_id: 'mes:fact:planning_verification_result:S06:third-open',
        result_ref: 'mes:result:S06:planning-verification-third',
        plan_binding: { ...newPvr.plan_binding!, delivery_cycle_id: 'cycle-other-open' },
      };
      assert.throws(
        () => store.write([...afterWork, thirdPvr]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID') &&
          err.message.includes('ambiguous'),
        'two distinct OPEN planning cycles must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), openBytes, 'ambiguous write must be byte-stable no-write');

      // 缺失: a NEW plan-bound fact missing the cycle while the unique open
      // cycle exists fails closed no-write.
      const missingCycleWork: MesFactEnvelope = {
        ...newWork,
        fact_id: 'mes:fact:work:S06:S06-A:missing-cycle',
        plan_binding: { ...newWork.plan_binding!, delivery_cycle_id: undefined as unknown as string },
      };
      assert.throws(
        () => store.write([...afterWork, missingCycleWork]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a NEW plan-bound fact missing the current cycle must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), openBytes, 'missing-cycle write must be byte-stable no-write');

      // 跨 cycle: a NEW plan-bound fact claiming the CLOSED older cycle fails
      // closed no-write — history-only cycles never accept new write-through.
      const crossIntoClosed: MesFactEnvelope = {
        ...newWork,
        fact_id: 'mes:fact:work:S06:S06-A:cross-into-closed',
        plan_binding: { ...newWork.plan_binding!, delivery_cycle_id: OLD_CYCLE },
      };
      assert.throws(
        () => store.write([...afterWork, crossIntoClosed]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a NEW plan-bound fact claiming the closed cycle must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), openBytes, 'cross-into-closed write must be byte-stable no-write');
    } finally {
      fixture.cleanup();
    }
  });

  test('open-cycle invariant: a cycle whose accepted-stage supports ALL exist but has NO legal matching PROJECT_READY terminal stays OPEN — a NEW same-cycle fact writes; full supports never auto-close the cycle (S06-D-T01 / PO-S06-D-01)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-208cbbe8d8e946479bb746f318b56178';
      const S06_PLAN = 'delivery/stages/S06/plan.md';
      const S06_DIGEST = sha('s06-plan-v1');
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s06-b', worktree: '.' };
      const PVR_REF = 'mes:result:S06:planning-verification-1';
      const STAGE_RESULT_REF = 'mes:result:S06:stage-review-1';

      const accepted = {
        binding_stage: 'accepted' as const,
        accepted_plan_ref: S06_PLAN,
        source_candidate_plan_ref: S06_PLAN,
        verification_result_ref: PVR_REF,
        plan_digest: S06_DIGEST,
        delivery_cycle_id: CYCLE,
      };
      const pvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S06:1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S06' },
        work_id: 'mes:work:S06:planning:1',
        result_ref: PVR_REF,
        verifier_role: 'stage-plan-verifier',
        action_token: 's06-spv-1',
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: S06_PLAN,
          accepted_plan_ref: null,
          verdict: 'PLAN_READY',
          plan_digest: S06_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      const pa: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S06:1',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S06' },
        supersedes_plan_acceptance_ref: null,
        plan_binding: accepted,
        git_basis: GIT_BASIS,
      };
      const stage: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S06:accepted',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S06' },
        plan_binding: accepted,
        git_basis: GIT_BASIS,
        result_ref: STAGE_RESULT_REF,
      };
      const review: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S06:stage-review-1',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S06' },
        work_id: 'mes:work:S06:review:1',
        result_ref: STAGE_RESULT_REF,
        plan_binding: accepted,
        git_basis: GIT_BASIS,
        result_id: 'stage-review-1',
        result_payload_digest: DIGEST,
      };
      // The FULL accepted-stage support cohort persists WITHOUT any terminal.
      store.write([pvr, pa, stage, review]);
      const persisted = store.read();
      assert.equal(persisted.length, 4, 'PVR/PA + stage + review persist');

      // The cycle stays OPEN (no legal matching terminal): its PVR/PA remain the
      // unique current planning binding (open = no legal matching terminal, even
      // when every accepted-stage support already exists). A NEW same-cycle fact
      // writes; supports alone never auto-close a cycle.
      const sameCycleWork: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:work:S06:S06-A:1',
        fact_kind: 'work',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S06', slice_id: 'S06-A' },
        work_id: 'mes:work:S06:S06-A:1',
        plan_binding: accepted,
        git_basis: GIT_BASIS,
      };
      store.write([...persisted, sameCycleWork]);
      const afterWork = store.read();
      assert.equal(afterWork.filter((f) => f.fact_id === sameCycleWork.fact_id).length, 1, 'a NEW fact carrying the unique OPEN cycle persists while all accepted-stage supports already exist');
      assert.equal(afterWork.filter((f) => f.fact_kind === 'project_ready').length, 0, 'no terminal was written — the cycle stays OPEN');
      const openBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');

      // A SECOND distinct OPEN cycle (no terminal) is still ambiguous no-write
      // byte-stable — the full-support cohort alone never closes a cycle.
      const secondOpenPvr: MesFactEnvelope = {
        ...pvr,
        fact_id: 'mes:fact:planning_verification_result:S06:second-open',
        result_ref: 'mes:result:S06:planning-verification-second',
        plan_binding: { ...pvr.plan_binding!, delivery_cycle_id: 'cycle-other-open' },
      };
      assert.throws(
        () => store.write([...afterWork, secondOpenPvr]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID') &&
          err.message.includes('ambiguous'),
        'two distinct OPEN planning cycles must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), openBytes, 'ambiguous write must be byte-stable no-write');
      // Restart rebuilds the same set (no terminal ever persisted).
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), afterWork, 'restart rebuilds the same open-cohort set');
    } finally {
      fixture.cleanup();
    }
  });

  test('terminal succession graph atomic no-write: a submitted project_ready whose supersedes_project_ready_ref would break the submitted ∪ retained successor chain (missing target / duplicate target branch) is no-write byte-stable, a valid append chain persists with the same unique tip after restart (S06-D-T01 / PO-S06-D-02)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const OLD_CYCLE = 'cycle-066ab3fd6cfb4470ddbd68d39cacf383';
      const NEW_CYCLE = 'cycle-208cbbe8d8e946479bb746f318b56178';
      const NEW2_CYCLE = 'cycle-9f8ac4b2d1e64a01b27c3d4e5f607182';
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s06-b', worktree: '.' };
      const oldAcceptor = {
        binding_stage: 'accepted' as const,
        accepted_plan_ref: 'delivery/stages/S05/plan.md',
        source_candidate_plan_ref: 'delivery/stages/S05/plan.md',
        verification_result_ref: 'mes:result:S05:planning-verification-1',
        plan_digest: sha('s05-plan-v1'),
        delivery_cycle_id: OLD_CYCLE,
      };
      const oldPvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S05:1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:planning:1',
        result_ref: 'mes:result:S05:planning-verification-1',
        verifier_role: 'stage-plan-verifier',
        action_token: 's05-spv-1',
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: 'delivery/stages/S05/plan.md',
          accepted_plan_ref: null,
          verdict: 'PLAN_READY',
          plan_digest: sha('s05-plan-v1'),
          delivery_cycle_id: OLD_CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      const oldPa: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S05:1',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S05' },
        supersedes_plan_acceptance_ref: null,
        plan_binding: oldAcceptor,
        git_basis: GIT_BASIS,
      };
      const oldStage: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S05:accepted',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        plan_binding: oldAcceptor,
        git_basis: GIT_BASIS,
        result_ref: 'mes:result:S05:stage-review-1',
      };
      const oldReview: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S05:stage-review-1',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S05' },
        work_id: 'mes:work:S05:review:1',
        result_ref: 'mes:result:S05:stage-review-1',
        plan_binding: oldAcceptor,
        git_basis: GIT_BASIS,
        result_id: 'stage-review-1',
        result_payload_digest: DIGEST,
      };
      const oldTerminal: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:project_ready:2',
        fact_kind: 'project_ready',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
        planned_stage_ids: ['S05'],
        delivery_cycle_id: OLD_CYCLE,
        supersedes_project_ready_ref: null,
        git_basis: GIT_BASIS,
      };
      store.write([oldPvr, oldPa, oldStage, oldReview, oldTerminal]);
      const goodBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');

      // A NEW cycle cohort builder: its own PVR/PA + S06 accepted-stage
      // support + Review result, so a NEW terminal\'s planned-set support
      // closure passes and ONLY the succession graph check can fail.
      const newCohort = (cycle: string, tag: string) => {
        const pvrRef = `mes:result:${tag}:planning-verification-1`;
        const stageRef = `mes:result:${tag}:stage-review-1`;
        const accept = {
          binding_stage: 'accepted' as const,
          accepted_plan_ref: 'delivery/stages/S06/plan.md',
          source_candidate_plan_ref: 'delivery/stages/S06/plan.md',
          verification_result_ref: pvrRef,
          plan_digest: sha('s06-plan-' + tag),
          delivery_cycle_id: cycle,
        };
        const pvr: MesFactEnvelope = {
          schema_version: 2,
          fact_id: `mes:fact:planning_verification_result:S06:${tag}`,
          fact_kind: 'planning_verification_result',
          created_by: 'brain',
          authority_refs: ['tech-spec/contracts.md#2.2.2'],
          scope: { stage_id: 'S06' },
          work_id: `mes:work:S06:planning:${tag}`,
          result_ref: pvrRef,
          verifier_role: 'stage-plan-verifier',
          action_token: `s06-spv-${tag}`,
          plan_binding: {
            binding_stage: 'candidate',
            candidate_plan_ref: 'delivery/stages/S06/plan.md',
            accepted_plan_ref: null,
            verdict: 'PLAN_READY',
            plan_digest: sha('s06-plan-' + tag),
            delivery_cycle_id: cycle,
          },
          git_basis: GIT_BASIS,
        };
        const pa: MesFactEnvelope = {
          schema_version: 2,
          fact_id: `mes:fact:plan_acceptance:S06:${tag}`,
          fact_kind: 'plan_acceptance',
          created_by: 'brain',
          authority_refs: ['tech-spec/contracts.md#2.2.2'],
          scope: { stage_id: 'S06' },
          supersedes_plan_acceptance_ref: null,
          plan_binding: accept,
          git_basis: GIT_BASIS,
        };
        const stage: MesFactEnvelope = {
          schema_version: 2,
          fact_id: `mes:fact:stage:S06:accepted:${tag}`,
          fact_kind: 'stage',
          created_by: 'brain',
          authority_refs: ['tech-spec/contracts.md#2.1.1'],
          scope: { stage_id: 'S06' },
          plan_binding: accept,
          git_basis: GIT_BASIS,
          result_ref: stageRef,
        };
        const review: MesFactEnvelope = {
          schema_version: 2,
          fact_id: `mes:fact:result:S06:stage-review-${tag}`,
          fact_kind: 'result',
          created_by: 'brain',
          authority_refs: ['tech-spec/contracts.md#2.1.1'],
          scope: { stage_id: 'S06' },
          work_id: `mes:work:S06:review:${tag}`,
          result_ref: stageRef,
          plan_binding: accept,
          git_basis: GIT_BASIS,
          result_id: `stage-review-${tag}`,
          result_payload_digest: DIGEST,
        };
        const terminal = (factId: string, supersedes: string | null): MesFactEnvelope => ({
          schema_version: 2,
          fact_id: factId,
          fact_kind: 'project_ready',
          created_by: 'brain',
          authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
          planned_stage_ids: ['S06'],
          delivery_cycle_id: cycle,
          supersedes_project_ready_ref: supersedes,
          git_basis: GIT_BASIS,
        });
        return { pvr, pa, stage, review, terminal };
      };

      // NEGATIVE 1: missing target — a NEW terminal supersedes a non-existent
      // fact_id. Support closure passes (same-cycle S06 support exists); the
      // succession graph check fires (missing target) → no-write byte-stable.
      const missCohort = newCohort(NEW_CYCLE, 'miss');
      const missingTarget = [
        missCohort.pvr,
        missCohort.pa,
        missCohort.stage,
        missCohort.review,
        missCohort.terminal('mes:fact:project_ready:miss', 'mes:fact:project_ready:ghost'),
      ];
      assert.throws(
        () => store.write([...store.read(), ...missingTarget]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a successor with a missing supersedes target must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), goodBytes, 'missing-target write must be byte-stable no-write');

      // NEGATIVE 2: duplicate target (branch) — two successors supersede the
      // SAME retained chain tip oldTerminal; the graph check rejects the branch.
      const b1 = newCohort(NEW_CYCLE, 'b1');
      const b2 = newCohort(NEW2_CYCLE, 'b2');
      const branch = [
        b1.pvr, b1.pa, b1.stage, b1.review,
        b1.terminal('mes:fact:project_ready:b1', oldTerminal.fact_id),
        b2.pvr, b2.pa, b2.stage, b2.review,
        b2.terminal('mes:fact:project_ready:b2', oldTerminal.fact_id),
      ];
      assert.throws(
        () => store.write([...store.read(), ...branch]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'two successors referencing one predecessor (branch) must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), goodBytes, 'branch write must be byte-stable no-write');

      // POSITIVE: a VALID append — one successor chaining onto the retained
      // tip oldTerminal. The chain [oldTerminal → newTip] closes atomically and
      // restart rebuilds the SAME set and tip.
      const ok = newCohort(NEW_CYCLE, 'ok');
      const newTip = ok.terminal('mes:fact:project_ready:ok', oldTerminal.fact_id);
      store.write([...store.read(), ok.pvr, ok.pa, ok.stage, ok.review, newTip]);
      const persisted = store.read();
      assert.equal(persisted.find((f) => f.fact_id === newTip.fact_id)?.supersedes_project_ready_ref, oldTerminal.fact_id, 'the successor edge persists exactly');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), persisted, 'restart rebuilds the same set and edge values');
    } finally {
      fixture.cleanup();
    }
  });


  test('CV-S06-D-cv-1 repair: two distinct PVR facts resolving to the SAME result_ref (mixed verdicts — FINDINGS + PLAN_READY, either order) fail closed no-write byte-stable; byte-identical replay stays legal and restart rebuilds the same set; a distinct result_ref in the same stage/cycle/plan identity stays a legal delta', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-208cbbe8d8e946479bb746f318b56178';
      const S06_PLAN = 'delivery/stages/S06/plan.md';
      const S06_DIGEST = sha('s06-plan-v1');
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s06-b', worktree: '.' };
      const pvr = (factId: string, resultRef: string, verdict: string, actionToken: string): MesFactEnvelope => ({
        schema_version: 2,
        fact_id: factId,
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S06' },
        work_id: 'mes:work:S06:planning:1',
        result_ref: resultRef,
        verifier_role: 'stage-plan-verifier',
        action_token: actionToken,
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: S06_PLAN,
          accepted_plan_ref: null,
          verdict: verdict as 'PLAN_READY' | 'FINDINGS',
          plan_digest: S06_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
      });

      // 1) valid: the FIRST PVR (PLAN_READY) for result_ref pv-1 persists.
      store.write([pvr('mes:fact:planning_verification_result:S06:1', 'mes:result:S06:pv-1', 'PLAN_READY', 's06-spv-1')]);
      const goodBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');

      // 2) counterexample: a second DISTINCT PVR fact resolving to the SAME
      //    result_ref with a FINDINGS verdict is still a duplicate planning
      //    binding anchor — the accepted stage could not exact-resolve to
      //    exactly one durable verification, so the write fails closed no-write
      //    (existing pvrPlanReadyByResultRef only catches both-PLAN_READY).
      assert.throws(
        () => store.write([pvr('mes:fact:planning_verification_result:S06:findings', 'mes:result:S06:pv-1', 'FINDINGS', 's06-spv-2')]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID') &&
          err.message.includes('ambiguous'),
        'a second distinct PVR for one result_ref (FINDINGS after PLAN_READY) must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), goodBytes, 'duplicate result_ref write must be byte-stable no-write');

      // 3) reversed order in ONE atomic write also fails closed (whole
      //    resulting set closure): FINDINGS first, then PLAN_READY.
      assert.throws(
        () =>
          store.write([
            pvr('mes:fact:planning_verification_result:S06:f2', 'mes:result:S06:pv-2', 'FINDINGS', 's06-spv-3'),
            pvr('mes:fact:planning_verification_result:S06:p2', 'mes:result:S06:pv-2', 'PLAN_READY', 's06-spv-4'),
          ]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID') &&
          err.message.includes('ambiguous'),
        'FINDINGS + PLAN_READY resolving to one result_ref in one atomic write must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), goodBytes, 'mixed-verdict duplicate write must be byte-stable no-write');

      // 4) byte-identical replay of the retained PVR stays legal and restart
      //    rebuilds the SAME set (no second verification source).
      store.write([pvr('mes:fact:planning_verification_result:S06:1', 'mes:result:S06:pv-1', 'PLAN_READY', 's06-spv-1')]);
      assert.equal(store.read().filter((f) => f.fact_kind === 'planning_verification_result').length, 1, 'byte-identical replay keeps one durable PVR');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), store.read(), 'restart rebuilds the same set');

      // 5) (S06 post-recovery Authority update; supersedes CV-S06-D-cv-2) A
      //    DISTINCT result_ref for the same (stage, cycle, plan ref, digest)
      //    identity is now LEGAL verification evidence — candidate PVRs are
      //    evidence only, do not participate in accepted-generation currentness,
      //    and the same-identity PVR uniqueness closure no longer exists
      //    (contracts §2.2.2 / architecture
      //    #/entities/planning-acceptance-succession). It persists as a second
      //    durable evidence fact; only two PVRs sharing ONE `result_ref` remain
      //    ambiguous (cases 2 and 3 above).
      store.write([pvr('mes:fact:planning_verification_result:S06:2', 'mes:result:S06:pv-2', 'PLAN_READY', 's06-spv-5')]);
      const persisted = store.read();
      assert.ok(persisted.some((f) => f.fact_id === 'mes:fact:planning_verification_result:S06:2'), 'a distinct result_ref PVR for the same identity is legal evidence and persists');
      assert.equal(persisted.filter((f) => f.fact_kind === 'planning_verification_result').length, 2, 'both distinct verification evidence facts stay durable');
      for (const fact of (JSON.parse(goodBytes) as { facts: MesFactEnvelope[] }).facts) {
        const again = persisted.find((f) => f.fact_id === fact.fact_id);
        assert.ok(again, `retained fact ${fact.fact_id} must survive the second PVR delta`);
        assert.equal(canonicalStringify(again), canonicalStringify(fact), `retained fact ${fact.fact_id} must stay canonical-equivalent`);
      }
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), persisted, 'restart rebuilds the same set after the legal second PVR');
    } finally {
      fixture.cleanup();
    }
  });



  test('CV-S06-D-cv-2 (superseded by the planning-acceptance-succession Authority update): a second accepted generation for the SAME (stage, cycle) is LEGAL when it is an append-only successor of the retained chain tip with a fresh PLAN_READY PVR (even with the same accepted ref / digest); a half-new generation (no predecessor edge), a stale predecessor, a branch, and an unresolvable verification_result_ref all fail closed no-write byte-stable; byte-identical replay stays legal; a different-cycle PA stays a legal new planning binding', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-208cbbe8d8e946479bb746f318b56178';
      const S06_PLAN = 'delivery/stages/S06/plan.md';
      const S06_DIGEST = sha('s06-plan-v1');
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s06-b', worktree: '.' };
      const pvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S06:1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S06' },
        work_id: 'mes:work:S06:planning:1',
        result_ref: 'mes:result:S06:pv-1',
        verifier_role: 'stage-plan-verifier',
        action_token: 's06-spv-1',
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: S06_PLAN,
          accepted_plan_ref: null,
          verdict: 'PLAN_READY',
          plan_digest: S06_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      const pa = (factId: string, verificationResultRef: string, cycle: string, predecessor: string | null = null): MesFactEnvelope => ({
        schema_version: 2,
        fact_id: factId,
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S06' },
        supersedes_plan_acceptance_ref: predecessor,
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S06_PLAN,
          source_candidate_plan_ref: S06_PLAN,
          verification_result_ref: verificationResultRef,
          plan_digest: S06_DIGEST,
          delivery_cycle_id: cycle,
        },
        git_basis: GIT_BASIS,
      });

      // 1) valid: ONE PVR + ONE PA for the identity persists.
      store.write([pvr, pa('mes:fact:plan_acceptance:S06:1', 'mes:result:S06:pv-1', CYCLE)]);
      const goodBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');

      // 2) (S06 post-recovery Authority update; supersedes the CV-S06-D-cv-2
      //    same-identity PA uniqueness closure) A second accepted generation for
      //    the SAME (stage, cycle) is LEGAL when it is an append-only successor
      //    of the retained chain tip and binds a FRESH PLAN_READY PVR — even
      //    with the SAME accepted_plan_ref and plan_digest. The chain tip
      //    becomes the current accepted generation.
      const pvr2: MesFactEnvelope = {
        ...pvr,
        fact_id: 'mes:fact:planning_verification_result:S06:2',
        result_ref: 'mes:result:S06:pv-2',
      };
      store.write([pvr2, pa('mes:fact:plan_acceptance:S06:2', 'mes:result:S06:pv-2', CYCLE, 'mes:fact:plan_acceptance:S06:1')]);
      const generations = store.read().filter((f) => f.fact_kind === 'plan_acceptance');
      assert.equal(generations.length, 2, 'both accepted generations stay durable (immutable history)');
      const tip = generations.find((f) => f.fact_id === 'mes:fact:plan_acceptance:S06:2');
      assert.ok(tip, 'the successor generation is durable');
      assert.equal(tip.supersedes_plan_acceptance_ref, 'mes:fact:plan_acceptance:S06:1', 'the successor points at the retained chain tip');
      const afterGenerations = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');

      // 2a) half-new shape: a NEW generation WITHOUT the predecessor edge is a
      //     half-new NORMAL shape and fails closed no-write (new writes must
      //     carry the top-level predecessor edge; null only when no other
      //     generation exists).
      assert.throws(
        () => store.write([{ ...pa('mes:fact:plan_acceptance:S06:half-new', 'mes:result:S06:pv-2', CYCLE), supersedes_plan_acceptance_ref: undefined }]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID') &&
          err.message.includes('half-new'),
        'a new cycle-bearing generation without the predecessor edge must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), afterGenerations, 'half-new generation write must be byte-stable no-write');

      // 2b) stale predecessor: an edge that does not point at the RETAINED chain
      //     tip (here the superseded S06:1) is no-write.
      assert.throws(
        () => store.write([pa('mes:fact:plan_acceptance:S06:stale', 'mes:result:S06:pv-2', CYCLE, 'mes:fact:plan_acceptance:S06:1')]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID') &&
          err.message.includes('stale predecessor'),
        'a stale predecessor edge must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), afterGenerations, 'stale-predecessor write must be byte-stable no-write');

      // 2c) branch: two generations referencing the same predecessor in one
      //     write are a duplicate target / branch and fail closed.
      assert.throws(
        () =>
          store.write([
            { ...pa('mes:fact:plan_acceptance:S06:branch-a', 'mes:result:S06:pv-2', CYCLE, 'mes:fact:plan_acceptance:S06:2') },
            { ...pa('mes:fact:plan_acceptance:S06:branch-b', 'mes:result:S06:pv-2', CYCLE, 'mes:fact:plan_acceptance:S06:2') },
          ]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID') &&
          err.message.includes('branch'),
        'a branched generation chain must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), afterGenerations, 'branched write must be byte-stable no-write');

      // 3) a generation whose verification_result_ref does NOT resolve to any
      //    durable PLAN_READY PVR is no-write (relational binding fails closed) —
      //    byte-stable.
      assert.throws(
        () => store.write([pa('mes:fact:plan_acceptance:S06:3', 'mes:result:S06:pv-missing', CYCLE, 'mes:fact:plan_acceptance:S06:2')]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a PA with an unresolvable verification_result_ref must be no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), afterGenerations, 'unresolvable-verif-ref PA must be byte-stable no-write');

      // 4) byte-identical replay of a retained generation stays legal and
      //    restart rebuilds the SAME set (both generations preserved).
      store.write([pa('mes:fact:plan_acceptance:S06:2', 'mes:result:S06:pv-2', CYCLE, 'mes:fact:plan_acceptance:S06:1')]);
      assert.equal(store.read().filter((f) => f.fact_kind === 'plan_acceptance').length, 2, 'byte-identical replay keeps both durable generations');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), store.read(), 'restart rebuilds the same set');
      // 5) a DIFFERENT cycle PA is a legal NEW planning binding (runtime-
      //    unblock: the old cycle is closed by a terminal first, then the new
      //    unique OPEN cycle gets its own PVR/PA next to the closed cycle).
      const OLD_TERMINAL: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:project_ready:2',
        fact_kind: 'project_ready',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
        planned_stage_ids: ['S06'],
        delivery_cycle_id: CYCLE,
        supersedes_project_ready_ref: null,
        git_basis: GIT_BASIS,
      };
      const stage: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S06:accepted',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S06' },
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S06_PLAN,
          source_candidate_plan_ref: S06_PLAN,
          verification_result_ref: 'mes:result:S06:pv-2',
          plan_digest: S06_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
        result_ref: 'mes:result:S06:stage-review-1',
      };
      const review: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S06:stage-review-1',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S06' },
        work_id: 'mes:work:S06:review:1',
        result_ref: 'mes:result:S06:stage-review-1',
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S06_PLAN,
          source_candidate_plan_ref: S06_PLAN,
          verification_result_ref: 'mes:result:S06:pv-2',
          plan_digest: S06_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
        result_id: 'stage-review-1',
        result_payload_digest: DIGEST,
      };
      store.write([...store.read(), stage, review, OLD_TERMINAL]);
      const newPvr: MesFactEnvelope = {
        ...pvr,
        fact_id: 'mes:fact:planning_verification_result:S06:new',
        result_ref: 'mes:result:S06:pv-new',
        plan_binding: { ...pvr.plan_binding!, delivery_cycle_id: 'cycle-other' },
      };
      store.write([...store.read(), newPvr, pa('mes:fact:plan_acceptance:S06:new', 'mes:result:S06:pv-new', 'cycle-other')]);
      const afterNew = store.read();
      assert.equal(afterNew.filter((f) => f.fact_kind === 'plan_acceptance').length, 3, 'the new-cycle PA persists next to both closed-cycle accepted generations');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), afterNew, 'restart rebuilds the same set with the new-cycle PA');
    } finally {
      fixture.cleanup();
    }
  });


  test('closed-cycle planning write: a NEW/CHANGED NORMAL PVR or PA claiming a delivery_cycle_id already CLOSED by a legal matching cycle-bearing PROJECT_READY terminal fails closed no-write byte-stable — closed-cycle planning facts are history-only; byte-identical replay of the retained PVR/PA stays legal (S06-D recovery-cv-1 / PO-S06-D-01)', () => {
    const fixture = makeFixture();
    try {
      const store = createMesSnapshotStore(fixture.dir);
      const CYCLE = 'cycle-208cbbe8d8e946479bb746f318b56178';
      const S06_PLAN = 'delivery/stages/S06/plan.md';
      const S06_DIGEST = sha('s06-plan-v1');
      const GIT_BASIS = { head: '1'.repeat(40), branch: 'proofloop-s06-b', worktree: '.' };
      const PVR_REF = 'mes:result:S06:planning-verification-1';
      const STAGE_REF = 'mes:result:S06:stage-review-1';

      const pvr: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:planning_verification_result:S06:1',
        fact_kind: 'planning_verification_result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S06' },
        work_id: 'mes:work:S06:planning:1',
        result_ref: PVR_REF,
        verifier_role: 'stage-plan-verifier',
        action_token: 's06-spv-1',
        plan_binding: {
          binding_stage: 'candidate',
          candidate_plan_ref: S06_PLAN,
          accepted_plan_ref: null,
          verdict: 'PLAN_READY',
          plan_digest: S06_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      const pa: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:plan_acceptance:S06:1',
        fact_kind: 'plan_acceptance',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        scope: { stage_id: 'S06' },
        supersedes_plan_acceptance_ref: null,
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S06_PLAN,
          source_candidate_plan_ref: S06_PLAN,
          verification_result_ref: PVR_REF,
          plan_digest: S06_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
      };
      const stage: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:stage:S06:accepted',
        fact_kind: 'stage',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S06' },
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S06_PLAN,
          source_candidate_plan_ref: S06_PLAN,
          verification_result_ref: PVR_REF,
          plan_digest: S06_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
        result_ref: STAGE_REF,
      };
      const review: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:result:S06:stage-review-1',
        fact_kind: 'result',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#2.1.1'],
        scope: { stage_id: 'S06' },
        work_id: 'mes:work:S06:review:1',
        result_ref: STAGE_REF,
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S06_PLAN,
          source_candidate_plan_ref: S06_PLAN,
          verification_result_ref: PVR_REF,
          plan_digest: S06_DIGEST,
          delivery_cycle_id: CYCLE,
        },
        git_basis: GIT_BASIS,
        result_id: 'stage-review-1',
        result_payload_digest: DIGEST,
      };
      const terminal: MesFactEnvelope = {
        schema_version: 2,
        fact_id: 'mes:fact:project_ready:2',
        fact_kind: 'project_ready',
        created_by: 'brain',
        authority_refs: ['tech-spec/contracts.md#5.1', 'tech-spec/acceptance.md#E2E-06'],
        planned_stage_ids: ['S06'],
        delivery_cycle_id: CYCLE,
        supersedes_project_ready_ref: null,
        git_basis: GIT_BASIS,
      };

      // Seed the legal closed S06 cycle exactly like the real flow: PVR/PA,
      // then accepted-stage + Review result, then the closing PROJECT_READY
      // terminal as the LAST write.
      store.write([pvr, pa]);
      store.write([pvr, pa, stage, review]);
      store.write([pvr, pa, stage, review, terminal]);
      const closedSet = store.read();
      assert.equal(closedSet.length, 5, 'the legal closed S06 cycle persists (PVR/PA + stage + review + terminal)');
      const closedBytes = fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8');

      // CV counterexample: a NEW PVR under the SAME closed delivery_cycle_id
      // (new fact_id / result_ref / plan_digest) must fail closed no-write —
      // closed-cycle planning facts are history-only and never reopen.
      const reopenedPvr: MesFactEnvelope = {
        ...pvr,
        fact_id: 'mes:fact:planning_verification_result:S06:reopen',
        result_ref: 'mes:result:S06:planning-verification-reopen',
        plan_binding: { ...pvr.plan_binding!, plan_digest: sha('s06-plan-reopen'), delivery_cycle_id: CYCLE },
      };
      assert.throws(
        () => store.write([...closedSet, reopenedPvr]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a NEW PVR claiming the closed cycle must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), closedBytes, 'closed-cycle PVR write must be byte-stable no-write');

      // A matching NEW PVR+PA under the closed cycle is also no-write.
      const reopenedPa: MesFactEnvelope = {
        ...pa,
        fact_id: 'mes:fact:plan_acceptance:S06:reopen',
        plan_binding: {
          binding_stage: 'accepted',
          accepted_plan_ref: S06_PLAN,
          source_candidate_plan_ref: S06_PLAN,
          verification_result_ref: 'mes:result:S06:planning-verification-reopen',
          plan_digest: sha('s06-plan-reopen'),
          delivery_cycle_id: CYCLE,
        },
      };
      assert.throws(
        () => store.write([...closedSet, reopenedPvr, reopenedPa]),
        (err: unknown) =>
          err instanceof MesSnapshotStoreError &&
          err.code === 'invalid-fact' &&
          err.message.includes('RESULT_INVALID'),
        'a matching NEW PVR+PA claiming the closed cycle must fail closed no-write',
      );
      assert.equal(fs.readFileSync(path.join(fixture.dir, MES_SNAPSHOT_REL), 'utf8'), closedBytes, 'closed-cycle PVR+PA write must be byte-stable no-write');

      // Byte-identical replay of the FULL retained closed set stays legal
      // (history-only rehydration) and restart rebuilds the same set.
      store.write([...closedSet]);
      assert.deepEqual(store.read(), closedSet, 'byte-identical replay keeps the closed set unchanged');
      assert.deepEqual(new MesSnapshotStore(fixture.dir).read(), closedSet, 'restart rebuilds the same closed set');
    } finally {
      fixture.cleanup();
    }
  });
});
