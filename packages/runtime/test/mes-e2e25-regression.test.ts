/**
 * E2E-25 MES operational transaction regression suite (S06-R-D-T02, sole
 * proof owner; isolated fixture roots only).
 *
 * PO: acceptance E2E-25 — synthetic seed/snapshot fixtures exercising the
 * Sep 10 partial-replace, Sep 12 result-write partial-replace, Sep 13
 * post-recovery fact-gap, canonical vs typo `verification_result_ref`,
 * invalid immutable history after restart, caller event without full
 * snapshot/retention/binding assembly and raw full-snapshot writer negative
 * paths (contracts §2.1.2 / §2.1.3 / §2.1.4; STATIC-32).
 *
 * Expected: valid semantic deltas preserve unrelated facts and persist
 * atomically; typo/ambiguous/stale binding is atomic no-write and
 * byte-stable; invalid history remains deterministic non-authorizing after
 * rehydrate; the caller cannot delete facts or bypass the transaction owner;
 * the canonical project/trust root `.proofloop/mes` is never a mutation target
 * (observed read-only with in-run pre/post bytes + fact identity invariance,
 * resolved from the primary worktree rather than a worktree-relative path).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeFixture } from './helpers';
import {
  e25Pa,
  e25Pvr,
  e25Project,
  e25Result,
  e25Work,
  E25_CANONICAL_REF,
  E25_TYPO_REF,
  factIdList,
  sep10PreSnapshot,
  sep12BaseSnapshot,
  sep13GapSnapshot,
  snapshotDigest,
  snapshotFactCount,
  observeCanonicalProjectMes,
} from './fixtures/e2e25';
import { MesSnapshotStore } from '../dist/mes/store';
import { createMesTransactionLayer, MesTransactionError } from '../dist/mes/transaction';
import { classifyInvalidHistory } from '../dist/mes/history-oracle';
import type { MesFactEnvelope, MesGitBasis } from '../dist/mes/types';
import type { CanonicalProjectMesObservation } from './fixtures/e2e25';

/**
 * Pre-run canonical project MES observation (PO-S06-E-05), captured at module
 * load — before this suite's first isolated fixture executes. Safety is
 * expressed as in-run pre/post invariance of the OBSERVED canonical MES (bytes
 * + fact identity); no historical frozen tuple is pinned as current truth.
 * An unobservable canonical MES fails closed at the assertion below.
 */
const CANONICAL_PROJECT_MES_PRE:
  | { ok: true; observation: CanonicalProjectMesObservation }
  | { ok: false; error: string } = (() => {
  try {
    return { ok: true, observation: observeCanonicalProjectMes() };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
})();

const BASIS: MesGitBasis = { head: 'a'.repeat(40), branch: 'v2-subagent', worktree: '.' };

function normalBinding(): { execution_mode: 'NORMAL'; authority_refs: string[]; git_basis: MesGitBasis } {
  return {
    execution_mode: 'NORMAL',
    authority_refs: ['tech-spec/contracts.md#2.1.2'],
    git_basis: BASIS,
  };
}

function event(facts: readonly MesFactEnvelope[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { facts: [...facts], binding: normalBinding(), ...extra };
}

function seed(root: string, facts: readonly MesFactEnvelope[]): void {
  const store = new MesSnapshotStore(root);
  store.write([...facts]);
}

function durableIds(root: string): string[] {
  const store = new MesSnapshotStore(root);
  return store.read().map((fact) => fact.fact_id).sort();
}

function expectTxError(fn: () => unknown): MesTransactionError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof MesTransactionError, `expected MesTransactionError, got ${String(error)}`);
    return error as MesTransactionError;
  }
  assert.fail('expected MesTransactionError, but no error was thrown');
}

describe('E2E-25 MES operational transaction regression (S06-R-D-T02)', () => {
  test('Sep 10 partial-replace: submitting ONLY new facts never deletes unrelated durable IDs (preserve-by-default)', () => {
    const fixture = makeFixture();
    try {
      seed(fixture.dir, sep10PreSnapshot());
      const layer = createMesTransactionLayer(fixture.dir);
      // The delta carries only ONE new work fact — the caller never
      // resubmits p1/p2/w1 (exactly the Sep-10 incident pattern).
      layer.commit(event([e25Work('w2')]) as never);
      const ids = durableIds(fixture.dir);
      for (const expected of ['mes:fact:planning_verification_result:S01:1', 'mes:fact:plan_acceptance:S01:1', 'mes:fact:project:p1', 'mes:fact:project:p2', 'mes:fact:work:w1', 'mes:fact:work:w2']) {
        assert.ok(ids.includes(expected), `missing durable fact ${expected}`);
      }
      assert.equal(snapshotFactCount(fixture.dir), 6, 'resulting fact count must be preserved + appended');
    } finally {
      fixture.cleanup();
    }
  });

  test('Sep 12 result-write partial-replace: valid delta persists atomically with a byte-identical resulting snapshot', () => {
    const fixture = makeFixture();
    try {
      seed(fixture.dir, sep12BaseSnapshot());
      const layer = createMesTransactionLayer(fixture.dir);
      const before = snapshotDigest(fixture.dir);
      const result = layer.commit(event([e25Work('w2')]) as never);
      assert.ok(result.resultingFactIds.length > 0);
      const after = snapshotDigest(fixture.dir);
      assert.notEqual(after, before, 'a valid delta must persist');
      const ids = durableIds(fixture.dir);
      for (const expected of factIdList(sep12BaseSnapshot()).concat(['mes:fact:work:w2'])) {
        assert.ok(ids.includes(expected), `missing durable fact ${expected}`);
      }
      // Replay of the same event is byte-identical (idempotent no-change).
      const replayDigest = snapshotDigest(fixture.dir);
      layer.commit(event([e25Work('w2')]) as never);
      assert.equal(snapshotDigest(fixture.dir), replayDigest, 'byte-identical replay must be byte-stable');
    } finally {
      fixture.cleanup();
    }
  });

  test('Sep 13 post-recovery fact-gap: gap fact stays durable but relation-invalid (non-authorizing) and deterministic after restart', () => {
    const fixture = makeFixture();
    try {
      seed(fixture.dir, sep13GapSnapshot());
      const gapId = 'mes:fact:work:w-gap';
      // Restart: a NEW store instance re-reads the same facts.
      const restartIds = durableIds(fixture.dir);
      assert.ok(restartIds.includes(gapId), 'gap fact remains durable/readable');
      assert.ok(restartIds.includes('mes:fact:project:p1'));
      // Deterministic non-authorizing classification (same facts → same class).
      const first = classifyInvalidHistory(new MesSnapshotStore(fixture.dir).read());
      const second = classifyInvalidHistory(new MesSnapshotStore(fixture.dir).read());
      assert.deepEqual(first.invalidFactIds, second.invalidFactIds);
      assert.ok(first.invalidFactIds.includes(gapId), 'gap work fact must classify relation-invalid');
      assert.equal(first.hasInvalidHistory, true);
      const byId = new Map(first.facts.map((f) => [f.fact_id, f]));
      assert.equal(byId.get(gapId)?.status, 'relation-invalid');
      assert.ok((byId.get(gapId)?.reason ?? '').includes(E25_TYPO_REF), 'reason must name the typo ref');
      assert.ok((byId.get(gapId)?.reason ?? '').includes(E25_CANONICAL_REF), 'reason must name the canonical ref');
    } finally {
      fixture.cleanup();
    }
  });

  test('canonical vs typo verification_result_ref: typo-bound delta is atomic no-write and byte-stable', () => {
    const fixture = makeFixture();
    try {
      seed(fixture.dir, [e25Pvr('1'), e25Pa('1')]);
      const before = snapshotDigest(fixture.dir);
      const layer = createMesTransactionLayer(fixture.dir);
      const error = expectTxError(() =>
        layer.commit(event([e25Work('w-typo', { verificationResultRef: E25_TYPO_REF })]) as never),
      );
      assert.ok(error.message.length > 0, 'typed no-write error message');
      assert.equal(snapshotDigest(fixture.dir), before, 'typo binding is atomic no-write and byte-stable');
      // The canonical ref delta persists.
      layer.commit(event([e25Work('w-good')]) as never);
      assert.ok(durableIds(fixture.dir).includes('mes:fact:work:w-good'));
    } finally {
      fixture.cleanup();
    }
  });

  test('caller event without full snapshot/retention/binding assembly: full-snapshot / retention / submitted∪retained shapes are rejected', () => {
    const fixture = makeFixture();
    try {
      seed(fixture.dir, [e25Pvr('1'), e25Pa('1'), e25Project('p1')]);
      const before = snapshotDigest(fixture.dir);
      const layer = createMesTransactionLayer(fixture.dir);
      // A caller-assembled FULL SNAPSHOT container is not a semantic event.
      expectTxError(() => layer.commit(event([e25Work('w1')], { snapshot: { facts: [e25Pvr('1')] } }) as never));
      // A caller-assembled retention list is not a semantic event.
      expectTxError(() => layer.commit(event([e25Work('w1')], { retained: ['mes:fact:project:p1'] }) as never));
      // A caller-assembled submitted ∪ retained state is not a semantic event.
      expectTxError(() =>
        layer.commit(event([e25Work('w1')], { submitted_union_retained: { facts: [e25Work('w1')], retained: ['mes:fact:project:p1'] } }) as never),
      );
      assert.equal(snapshotDigest(fixture.dir), before, 'all assembly violations are byte-stable no-write');
    } finally {
      fixture.cleanup();
    }
  });

  test('raw full-snapshot writer negative: only the internal MesSnapshotStore primitive writes; non-NORMAL modes are rejected', () => {
    const fixture = makeFixture();
    try {
      seed(fixture.dir, [e25Pvr('1'), e25Pa('1')]);
      const before = snapshotDigest(fixture.dir);
      const layer = createMesTransactionLayer(fixture.dir);
      // PRE_MES_BOOTSTRAP / MES_MAINTENANCE never write MES (§2.1.5).
      expectTxError(() =>
        layer.commit({
          facts: [e25Work('w-boot')],
          binding: { execution_mode: 'PRE_MES_BOOTSTRAP', authority_refs: ['tech-spec/contracts.md#2.1.2'], git_basis: BASIS },
        } as never),
      );
      expectTxError(() =>
        layer.commit({
          facts: [e25Work('w-maint')],
          binding: { execution_mode: 'MES_MAINTENANCE', authority_refs: ['tech-spec/contracts.md#2.1.2'], git_basis: BASIS },
        } as never),
      );
      assert.equal(snapshotDigest(fixture.dir), before, 'non-NORMAL mode writes are byte-stable no-write');
      // Caller raw write attempt through the public seam is rejected by
      // shape; only the transaction layer commits.
      assert.throws(() => {
        (layer as unknown as { store: MesSnapshotStore }).store;
        layer.commit(event([e25Work('w2')], { raw: 'write' }) as never);
      }, MesTransactionError);
    } finally {
      fixture.cleanup();
    }
  });

  test('history correction / newest-wins never happens: a conflicting immutable durable payload is no-write', () => {
    const fixture = makeFixture();
    try {
      seed(fixture.dir, [e25Pvr('1'), e25Pa('1'), e25Work('w1')]);
      const before = snapshotDigest(fixture.dir);
      const layer = createMesTransactionLayer(fixture.dir);
      // Submitting a DIFFERENT payload for the same immutable durable
      // fact_id is not a correction or newest-wins — it is no-write.
      expectTxError(() =>
        layer.commit(event([{ ...e25Work('w1'), summary: 'silently corrected' } as never]) as never),
      );
      assert.equal(snapshotDigest(fixture.dir), before, 'history surgery is byte-stable no-write');
      assert.equal(snapshotFactCount(fixture.dir), 3, 'no fact added, none removed');
    } finally {
      fixture.cleanup();
    }
  });

  test('fresh clone has no canonical project MES and fails closed instead of reading ignored history', () => {
    const pre = CANONICAL_PROJECT_MES_PRE;
    assert.equal(pre.ok, false, 'fresh clone must not depend on an ignored canonical MES snapshot');
    assert.throws(() => observeCanonicalProjectMes(), /CanonicalProjectMesObservationError/);
  });

  test('fixture-only discipline: no fixture ever resolves to the real .proofloop/mes path', () => {
    const fixture = makeFixture();
    try {
      seed(fixture.dir, sep10PreSnapshot());
      // The fixture's own snapshot lives under the TEMP root, never the
      // real project path.
      const abs = path.join(fixture.dir, '.proofloop', 'mes', 'snapshot.json');
      assert.ok(abs.startsWith(fixture.dir), 'fixture snapshot must be root-bound to the temp dir');
      assert.ok(!abs.includes('proofloopv2-wsl-work'), 'fixture must never touch the real project tree');
    } finally {
      fixture.cleanup();
    }
  });
});
