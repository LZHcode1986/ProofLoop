/**
 * MES index public-surface convergence tests (S06-R-A-T02).
 *
 * # PO: acceptance STATIC-32 (MES transaction ownership / binding closure),
 * architecture #/entities/mes-operational-transaction-boundary
 *
 * After the S06-R-A-T02 surface convergence, the Runtime MES public index
 * (`mes/index` and the runtime root `index`) exposes ONLY:
 *   - the MES operational transaction seam (`MesTransactionLayer` /
 *     createMesTransactionLayer / MesTransactionError /
 *     resolveTransactionBindingError) — the single normal durable write
 *     entry;
 *   - the read-only projections / validators / bootstrap seed helpers
 *     (status, validate, binding, bootstrap, terminal) — unchanged;
 * and NO raw full-snapshot writer:
 *   - `MesSnapshotStore` / `createMesSnapshotStore` / `MesSnapshotStoreError`
 *     / `MES_SNAPSHOT_REL` are NOT exported from the public index — the raw
 *     full-snapshot writer is internal-only (STATIC-32 single normal mutator,
 *     "MesSnapshotStore is internal");
 *   - a caller that tries to reach the raw writer through the public surface
 *     fails closed (the name is absent; invoking it throws), while the store
 *     stays importable from the internal module path `mes/store` for
 *     Runtime-internal consumers.
 *
 * The migration owner for the existing `mes-public-surface.test.ts` is also
 * T02: its `MesSnapshotStore` / `MES_SNAPSHOT_REL` fixture imports moved from
 * `../dist/index` to the internal `../dist/mes/store` path with every
 * assertion traced and kept semantically identical (that file must stay
 * green — verified separately by running it).
 *
 * All tests use only temporary Git fixtures (helpers.ts#makeFixture) and
 * never the work clone's Git/MES state. Imports the compiled runtime dist
 * (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../dist/index';
import * as mes from '../dist/mes';
import * as storeModule from '../dist/mes/store';
import { makeFixture } from './helpers';

describe('MES public index surface convergence (S06-R-A-T02)', () => {
  test('the raw full-snapshot writer is NOT exported from the public index (STATIC-32 internal ownership)', () => {
    // The public index (runtime root AND mes index) must not expose the raw
    // full-snapshot writer as a Brain-facing API.
    for (const [label, surface] of [
      ['runtime root index', runtime],
      ['mes index', mes],
    ] as const) {
      assert.equal('MesSnapshotStore' in surface, false, `${label} must not export MesSnapshotStore`);
      assert.equal('createMesSnapshotStore' in surface, false, `${label} must not export createMesSnapshotStore`);
      assert.equal('MesSnapshotStoreError' in surface, false, `${label} must not export MesSnapshotStoreError`);
      assert.equal('MES_SNAPSHOT_REL' in surface, false, `${label} must not export MES_SNAPSHOT_REL`);
    }
  });

  test('the transaction seam is the only normal write entry and IS exported', () => {
    for (const [label, surface] of [
      ['runtime root index', runtime],
      ['mes index', mes],
    ] as const) {
      assert.equal(typeof (surface as typeof mes).MesTransactionLayer, 'function', `${label} must export MesTransactionLayer`);
      assert.equal(typeof (surface as typeof mes).createMesTransactionLayer, 'function', `${label} must export createMesTransactionLayer`);
      assert.equal(typeof (surface as typeof mes).MesTransactionError, 'function', `${label} must export MesTransactionError`);
      assert.equal(typeof (surface as typeof mes).resolveTransactionBindingError, 'function', `${label} must export resolveTransactionBindingError (binding-critical resolution call point)`);
    }
  });

  test('read-only projections / validators / bootstrap helpers stay exported (surface convergence does not break the read seam)', () => {
    assert.equal(typeof mes.projectSparseStatus, 'function');
    assert.equal(typeof mes.projectDetailStatus, 'function');
    assert.equal(typeof mes.projectCycleFilteredStatus, 'function');
    assert.equal(typeof mes.validateMesFactEnvelope, 'function');
    assert.equal(typeof mes.seedMesBootstrap, 'function');
    assert.equal(typeof mes.isMesSeeded, 'function');
    assert.equal(typeof mes.readMesSeedRecord, 'function');
    assert.equal(typeof mes.projectTerminalDetail, 'function');
    assert.ok(mes.MES_FACT_KINDS.includes('plan_acceptance'));
  });

  test('negative fixture: calling the raw writer through the public surface fails closed', () => {
    // The public surface has no raw-writer constructor: attempting to
    // instantiate / invoke it through the index must throw (undefined is not
    // a constructor / not a function).
    // Read via the Record index so TS keeps the value as `unknown` (an
    // `assert.equal` on the narrowed value would otherwise prove it undefined
    // and block the casts).
    const surface = runtime as unknown as Record<string, unknown>;
    const rawWriter: unknown = surface['MesSnapshotStore'];
    assert.equal(rawWriter, undefined, 'raw writer must be absent from the public surface');
    assert.throws(
      () => new (rawWriter as unknown as { new (): unknown })(),
      TypeError,
      'instantiating the absent raw writer through the public surface must throw',
    );
    assert.throws(
      () => (rawWriter as unknown as () => unknown)(),
      TypeError,
      'calling the absent raw writer through the public surface must throw',
    );
  });

  test('the store stays importable from the internal module path only (Runtime-internal fixture helper)', () => {
    // STATIC-32: "MesSnapshotStore is internal". Runtime-internal consumers
    // (the migrated mes-public-surface fixture helper, bootstrap, status,
    // transaction) still import it from the internal module path.
    const fixture = makeFixture();
    try {
      assert.equal(typeof storeModule.MesSnapshotStore, 'function');
      assert.equal(typeof storeModule.createMesSnapshotStore, 'function');
      assert.equal(typeof storeModule.MesSnapshotStoreError, 'function');
      assert.equal(typeof storeModule.MES_SNAPSHOT_REL, 'string');
      // The internal store still works on an isolated fixture root.
      const store = storeModule.createMesSnapshotStore(fixture.dir);
      assert.deepEqual(store.read(), []);
    } finally {
      fixture.cleanup();
    }
  });
});
