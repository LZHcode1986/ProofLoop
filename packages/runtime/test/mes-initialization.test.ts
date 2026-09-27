/**
 * MES initialization / Authority presence observation tests
 * (mes-planning-entry execution plan Phase 7).
 *
 * Exercises packages/runtime/src/mes/bootstrap.ts Phase 4/5 seams:
 *   - `initializeMes` / `readMesInitRecord` / `isMesInitialized` — MES
 *     infrastructure initialization that is root-bound, idempotent,
 *     re-readable and fail-closed, writes ONLY minimal `.proofloop/mes/init.json`
 *     closed metadata, produces no operational facts, treats an existing
 *     valid seed-backed store as initialized without rewriting it, and never
 *     backfills project history;
 *   - `observeAuthorityPaths` / `observeAuthorityPathBuckets` — read-only,
 *     deterministic presence observation of the four canonical Authority
 *     paths (present / missing / unreadable), no MES mutation, no
 *     `PROPOSE_READY` / route semantics.
 *
 * All tests use only temporary Git fixtures (helpers.ts#makeFixture) and
 * never the work clone's real `.proofloop/mes/**`. Imports the compiled
 * runtime dist (built by `npx tsc -b --force`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import {
  initializeMes,
  readMesInitRecord,
  isMesInitialized,
  MES_INIT_REL,
  MES_INITIALIZATION_VERSION,
  MesBootstrapError,
  readMesSnapshotFacts,
  seedMesBootstrap,
  readMesSeedRecord,
  MES_SEED_REL,
  observeAuthorityPaths,
  observeAuthorityPathBuckets,
  MES_AUTHORITY_PATHS,
} from '../dist/mes/bootstrap';
import type { MesBootstrapSeedInput, MesInitRecord } from '../dist/mes/bootstrap';
import { MesSnapshotStore, MES_SNAPSHOT_REL } from '../dist/mes/store';
import { createMesTransactionLayer } from '../dist/mes/transaction';
import type { MesFactEnvelope, MesGitBasis } from '../dist/mes/types';
import { runStatusDomain } from '../dist/cli/proofloop';
import { makeFixture, commitAll, sha } from './helpers';

const PLAN_REF = 'delivery/stages/S01/plan.md';
const DIGEST = sha('init-plan-v1');
const CYCLE = 'cycle-208cbbe8d8e946479bb746f318b56178';
const BASIS: MesGitBasis = { head: 'ee9518854895a9338d3610c0b8e7384988bd7c70', branch: 'v2-herdr', worktree: '.' };

function seedInput(overrides: Partial<MesBootstrapSeedInput> = {}): MesBootstrapSeedInput {
  return {
    authority_refs: ['PRD.md#FR-003', 'tech-spec/contracts.md#2.2.1'],
    accepted_plan_ref: PLAN_REF,
    plan_digest: DIGEST,
    git_basis: BASIS,
    status: {
      scope: 'S01',
      phase: 'EXECUTE',
      required_skill: 'proofloop-execute',
    },
    ...overrides,
  };
}

function fixtureRoot(): { dir: string; cleanup(): void; head: string; branch: string; write(relative: string, content: string): string; run(args: readonly string[]): string } {
  const fixture = makeFixture();
  const commit = commitAll(fixture, 'baseline');
  return { dir: fixture.dir, head: commit, branch: 'master', cleanup: fixture.cleanup, write: fixture.write, run: fixture.run };
}

function initAbs(root: string): string {
  return path.join(root, MES_INIT_REL);
}
function seedAbs(root: string): string {
  return path.join(root, MES_SEED_REL);
}
function snapshotAbs(root: string): string {
  return path.join(root, MES_SNAPSHOT_REL);
}
function sha256Bytes(abs: string): string | null {
  if (!fs.existsSync(abs)) return null;
  return createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
}

describe('MES initialization (Phase 7.1)', () => {
  test('1. empty fixture can initialize', () => {
    const fixture = fixtureRoot();
    try {
      const record = initializeMes(fixture.dir);
      assert.ok(record !== null, 'empty fixture initialization must create init.json');
      assert.equal(record.schema_version, 2);
      assert.equal(record.initialization_version, MES_INITIALIZATION_VERSION);
      assert.equal(fs.existsSync(initAbs(fixture.dir)), true);
    } finally {
      fixture.cleanup();
    }
  });

  test('2. initialization metadata is re-readable after initialization', () => {
    const fixture = fixtureRoot();
    try {
      const record = initializeMes(fixture.dir);
      assert.ok(record !== null);
      const reread = readMesInitRecord(fixture.dir);
      assert.deepEqual(reread, record);
      assert.equal(isMesInitialized(fixture.dir), true);
    } finally {
      fixture.cleanup();
    }
  });

  test('3. after initialization snapshot fact count = 0', () => {
    const fixture = fixtureRoot();
    try {
      initializeMes(fixture.dir);
      const facts = readMesSnapshotFacts(fixture.dir);
      assert.equal(facts.length, 0, 'initialization must not create operational facts');
    } finally {
      fixture.cleanup();
    }
  });

  test('4. repeated initialization is idempotent', () => {
    const fixture = fixtureRoot();
    try {
      const first = initializeMes(fixture.dir);
      assert.ok(first !== null);
      const before = sha256Bytes(initAbs(fixture.dir));
      const second = initializeMes(fixture.dir);
      assert.deepEqual(second, first);
      assert.equal(sha256Bytes(initAbs(fixture.dir)), before, 'idempotent init must not rewrite init.json');
    } finally {
      fixture.cleanup();
    }
  });

  test('5. corrupt init metadata fails closed', () => {
    const fixture = fixtureRoot();
    try {
      fs.mkdirSync(path.dirname(initAbs(fixture.dir)), { recursive: true });
      fs.writeFileSync(initAbs(fixture.dir), '{not json', 'utf8');
      assert.throws(
        () => readMesInitRecord(fixture.dir),
        (err: unknown) => err instanceof MesBootstrapError && err.code === 'corrupt-init',
      );
      assert.throws(
        () => isMesInitialized(fixture.dir),
        (err: unknown) => err instanceof MesBootstrapError && err.code === 'corrupt-init',
      );
      // initializeMes must not silently rewrite a corrupt record.
      assert.throws(
        () => initializeMes(fixture.dir),
        (err: unknown) => err instanceof MesBootstrapError && err.code === 'corrupt-init',
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('6. init path / intermediate symlink escape fails closed', () => {
    const fixture = fixtureRoot();
    try {
      // Final-component symlink: a symlinked init is never a valid record.
      fs.mkdirSync(path.dirname(initAbs(fixture.dir)), { recursive: true });
      const escapeTarget = path.join(fixture.dir, 'escape-target.json');
      fs.writeFileSync(escapeTarget, '{}', 'utf8');
      fs.symlinkSync(escapeTarget, initAbs(fixture.dir));
      assert.throws(
        () => readMesInitRecord(fixture.dir),
        (err: unknown) => err instanceof MesBootstrapError && (err.code === 'escape' || err.code === 'unreadable'),
        'readMesInitRecord must fail closed on a symlinked init path',
      );
      assert.throws(
        () => initializeMes(fixture.dir),
        (err: unknown) => err instanceof MesBootstrapError && (err.code === 'escape' || err.code === 'unreadable'),
        'initializeMes must fail closed on a symlinked init path',
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('7. existing valid seed-backed fixture is recognized as initialized', () => {
    const fixture = fixtureRoot();
    try {
      seedMesBootstrap(fixture.dir, seedInput({ git_basis: { ...BASIS, head: fixture.head } }));
      assert.equal(isMesInitialized(fixture.dir), true, 'seed-backed store must be initialized');
      assert.equal(fs.existsSync(initAbs(fixture.dir)), false, 'seed-backed store must not need init.json');
    } finally {
      fixture.cleanup();
    }
  });

  test('8. initializeMes on a seed-backed fixture does not modify seed/snapshot bytes', () => {
    const fixture = fixtureRoot();
    try {
      seedMesBootstrap(fixture.dir, seedInput({ git_basis: { ...BASIS, head: fixture.head } }));
      const seedBefore = sha256Bytes(seedAbs(fixture.dir));
      const snapshotBefore = sha256Bytes(snapshotAbs(fixture.dir));
      assert.ok(seedBefore !== null && snapshotBefore !== null);

      const result = initializeMes(fixture.dir);
      assert.equal(result, null, 'seed-backed store: initializeMes must not create init.json');
      assert.equal(sha256Bytes(seedAbs(fixture.dir)), seedBefore, 'seed bytes must be unchanged');
      assert.equal(sha256Bytes(snapshotAbs(fixture.dir)), snapshotBefore, 'snapshot bytes must be unchanged');
      assert.equal(fs.existsSync(initAbs(fixture.dir)), false, 'no init.json created for seed-backed store');
    } finally {
      fixture.cleanup();
    }
  });

  test('9. historical-code fixture: initialization preserves HEAD/tracked tree/commits and writes only init metadata', () => {
    const fixture = makeFixture();
    try {
      fixture.write('src/a.ts', 'export const a = 1;\n');
      commitAll(fixture, 'first commit');
      fixture.write('src/b.ts', 'export const b = 2;\n');
      commitAll(fixture, 'second commit');
      const headBefore = fixture.head();
      const logBefore = fixture.run(['log', '--oneline']).trim();
      const trackedBefore = fixture.run(['ls-files']).trim();

      const record = initializeMes(fixture.dir);
      assert.ok(record !== null);

      // Git history / tracked tree untouched.
      assert.equal(fixture.head(), headBefore, 'HEAD must not change');
      assert.equal(fixture.run(['log', '--oneline']).trim(), logBefore, 'commit history must not change');
      assert.equal(fixture.run(['ls-files']).trim(), trackedBefore, 'tracked tree must not change');
      // Only initialization metadata added; no operational facts.
      assert.equal(fs.existsSync(initAbs(fixture.dir)), true);
      assert.equal(fs.existsSync(snapshotAbs(fixture.dir)), false, 'no snapshot facts created');
      assert.equal(readMesSnapshotFacts(fixture.dir).length, 0);
      // .proofloop is gitignored (helpers.ts mirrors the root .gitignore).
      assert.equal(fixture.run(['status', '--porcelain=v1', '--untracked-files=all']).trim(), '');
    } finally {
      fixture.cleanup();
    }
  });

  test('10. broken seed-backed store (seed record present, snapshot facts missing) is NOT initialized', () => {
    const fixture = fixtureRoot();
    try {
      seedMesBootstrap(fixture.dir, seedInput({ git_basis: { ...BASIS, head: fixture.head } }));
      assert.equal(isMesInitialized(fixture.dir), true, 'intact seed-backed store is initialized');
      // Wipe the expected seed-owned snapshot facts, keep the seed record.
      new MesSnapshotStore(fixture.dir).write([]);
      assert.throws(
        () => isMesInitialized(fixture.dir),
        (err: unknown) => err instanceof MesBootstrapError && err.code === 'corrupt-seed',
        'broken seed-backed store must fail closed, not be initialized',
      );
      assert.throws(
        () => initializeMes(fixture.dir),
        (err: unknown) => err instanceof MesBootstrapError && err.code === 'corrupt-seed',
        'initializeMes must fail closed on a broken seed-backed store',
      );
      assert.equal(fs.existsSync(initAbs(fixture.dir)), false, 'init.json must never legalize a broken seed-backed store');
    } finally {
      fixture.cleanup();
    }
  });

  test('11. intermediate symlink in the init path fails closed (escape)', () => {
    const fixture = fixtureRoot();
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-mes-init-intermediate-'));
    try {
      // `.proofloop` is itself a symlink (intermediate component) pointing
      // outside the project root; the init record must never be read through
      // it and never written through it.
      const mesDir = path.join(outsideRoot, 'mes');
      fs.mkdirSync(mesDir, { recursive: true });
      fs.writeFileSync(path.join(mesDir, 'init.json'), JSON.stringify({ schema_version: 2, initialization_version: 1 }), 'utf8');
      fs.symlinkSync(outsideRoot, path.join(fixture.dir, '.proofloop'), 'dir');
      assert.throws(
        () => readMesInitRecord(fixture.dir),
        (err: unknown) => err instanceof MesBootstrapError && (err.code === 'escape' || err.code === 'unreadable'),
        'readMesInitRecord must fail closed on an intermediate init symlink',
      );
      assert.throws(
        () => initializeMes(fixture.dir),
        (err: unknown) => err instanceof MesBootstrapError && (err.code === 'escape' || err.code === 'unreadable'),
        'initializeMes must fail closed on an intermediate init symlink',
      );
      // The intermediate symlink must remain intact (never followed, never
      // replaced by a real directory through the failed init)
      assert.equal(
        fs.lstatSync(path.join(fixture.dir, '.proofloop')).isSymbolicLink(),
        true,
        '.proofloop symlink must remain intact',
      );
    } finally {
      fixture.cleanup();
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

describe('Authority path presence observation (Phase 7.2)', () => {
  const AUTH = [...MES_AUTHORITY_PATHS] as readonly string[];

  test('1. all four paths missing', () => {
    const fixture = fixtureRoot();
    try {
      const observations = observeAuthorityPaths(fixture.dir);
      assert.equal(observations.length, 4);
      for (const obs of observations) {
        assert.equal(obs.presence, 'missing');
      }
      const buckets = observeAuthorityPathBuckets(fixture.dir);
      assert.deepEqual(buckets.missing, [...AUTH]);
      assert.deepEqual(buckets.present, []);
      assert.deepEqual(buckets.unreadable, []);
    } finally {
      fixture.cleanup();
    }
  });

  test('2. partial presence', () => {
    const fixture = fixtureRoot();
    try {
      fixture.write('PRD.md', '# PRD\n');
      const observations = observeAuthorityPaths(fixture.dir);
      const byPath = new Map(observations.map((o) => [o.path, o.presence]));
      assert.equal(byPath.get('PRD.md'), 'present');
      assert.equal(byPath.get('tech-spec/architecture.md'), 'missing');
      assert.equal(byPath.get('tech-spec/contracts.md'), 'missing');
      assert.equal(byPath.get('tech-spec/acceptance.md'), 'missing');
    } finally {
      fixture.cleanup();
    }
  });

  test('3. all four paths present', () => {
    const fixture = fixtureRoot();
    try {
      fixture.write('PRD.md', '# PRD\n');
      fixture.write('tech-spec/architecture.md', '# Arch\n');
      fixture.write('tech-spec/contracts.md', '# Contracts\n');
      fixture.write('tech-spec/acceptance.md', '# Acceptance\n');
      const buckets = observeAuthorityPathBuckets(fixture.dir);
      assert.deepEqual(buckets.present, [...AUTH]);
      assert.deepEqual(buckets.missing, []);
      assert.deepEqual(buckets.unreadable, []);
    } finally {
      fixture.cleanup();
    }
  });

  test('4. empty files still count as present', () => {
    const fixture = fixtureRoot();
    try {
      fixture.write('PRD.md', '');
      fixture.write('tech-spec/architecture.md', '');
      fixture.write('tech-spec/contracts.md', '');
      fixture.write('tech-spec/acceptance.md', '');
      const buckets = observeAuthorityPathBuckets(fixture.dir);
      assert.deepEqual(buckets.present, [...AUTH], 'empty files are present (presence != readiness)');
    } finally {
      fixture.cleanup();
    }
  });

  test('5. unreadable / unsafe path classified unreadable (fail closed)', () => {
    const fixture = fixtureRoot();
    try {
      // A symlinked authority file is never followed → unreadable.
      const target = path.join(fixture.dir, 'real-prd.md');
      fs.writeFileSync(target, '# PRD\n', 'utf8');
      fs.symlinkSync(target, path.join(fixture.dir, 'PRD.md'));
      // A non-file component (directory) at the final position → unreadable.
      fixture.write('tech-spec/architecture.md', '# Arch\n');
      const dirOverride = path.join(fixture.dir, 'tech-spec', 'contracts.md');
      fs.mkdirSync(dirOverride, { recursive: true });
      // Missing stays missing.
      const buckets = observeAuthorityPathBuckets(fixture.dir);
      assert.deepEqual(buckets.unreadable, ['PRD.md', 'tech-spec/contracts.md']);
      assert.deepEqual(buckets.present, ['tech-spec/architecture.md']);
      assert.deepEqual(buckets.missing, ['tech-spec/acceptance.md']);
    } finally {
      fixture.cleanup();
    }
  });

  test('6. observation does not change MES bytes', () => {
    const fixture = fixtureRoot();
    try {
      initializeMes(fixture.dir);
      const initBefore = sha256Bytes(initAbs(fixture.dir));
      const seedBefore = sha256Bytes(seedAbs(fixture.dir));
      const snapshotBefore = sha256Bytes(snapshotAbs(fixture.dir));
      observeAuthorityPaths(fixture.dir);
      assert.equal(sha256Bytes(initAbs(fixture.dir)), initBefore);
      assert.equal(sha256Bytes(seedAbs(fixture.dir)), seedBefore);
      assert.equal(sha256Bytes(snapshotAbs(fixture.dir)), snapshotBefore);
      // presence observation must not produce facts.
      assert.equal(readMesSnapshotFacts(fixture.dir).length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  test('7. mode-000 regular file is unreadable (readability probe, not lstat-only)', () => {
    const fixture = fixtureRoot();
    try {
      fixture.write('PRD.md', '# PRD\n');
      fs.chmodSync(path.join(fixture.dir, 'PRD.md'), 0o000);
      const observation = observeAuthorityPaths(fixture.dir);
      const prd = observation.find((o) => o.path === 'PRD.md');
      assert.ok(prd !== undefined);
      assert.equal(prd.presence, 'unreadable', 'an unreadable regular file must be unreadable');
    } finally {
      // restore permissions so cleanup can remove the fixture file
      try {
        fs.chmodSync(path.join(fixture.dir, 'PRD.md'), 0o644);
      } catch {
        /* ignore */
      }
      fixture.cleanup();
    }
  });
});

describe('MES status on initialized stores (Phase 7.3)', () => {
  function pvr(): MesFactEnvelope {
    const ref = 'mes:result:S01:planning-verification-1';
    return {
      schema_version: 2,
      fact_id: 'mes:fact:planning_verification_result:S01:1',
      fact_kind: 'planning_verification_result',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: 'S01' },
      work_id: 'mes:work:S01:planning:1',
      result_ref: ref,
      verifier_role: 'stage-plan-verifier',
      action_token: 's01-spv-1',
      plan_binding: {
        binding_stage: 'candidate',
        candidate_plan_ref: PLAN_REF,
        accepted_plan_ref: null,
        verdict: 'PLAN_READY',
        plan_digest: DIGEST,
        delivery_cycle_id: CYCLE,
      },
      git_basis: BASIS,
    };
  }

  function pa(): MesFactEnvelope {
    return {
      schema_version: 2,
      fact_id: 'mes:fact:plan_acceptance:S01:1',
      fact_kind: 'plan_acceptance',
      created_by: 'brain',
      authority_refs: ['tech-spec/contracts.md#2.2.2'],
      scope: { stage_id: 'S01' },
      supersedes_plan_acceptance_ref: null,
      plan_binding: {
        binding_stage: 'accepted',
        accepted_plan_ref: PLAN_REF,
        source_candidate_plan_ref: PLAN_REF,
        verification_result_ref: 'mes:result:S01:planning-verification-1',
        plan_digest: DIGEST,
        delivery_cycle_id: CYCLE,
      },
      git_basis: BASIS,
    };
  }

  function normalEvent(facts: readonly MesFactEnvelope[]) {
    return {
      facts: [...facts],
      binding: {
        execution_mode: 'NORMAL' as const,
        authority_refs: ['tech-spec/contracts.md#2.2.2'],
        git_basis: BASIS,
      },
    };
  }

  test('1. initialized + no facts: typed no-operational-state, does not demand seedMesBootstrap', () => {
    const fixture = fixtureRoot();
    try {
      initializeMes(fixture.dir);
      const envelope = runStatusDomain(fixture.dir, { detail: false, jsonOutput: true });
      assert.equal(envelope.ok, false, 'no operational state is a blocked observation');
      const message = JSON.stringify(envelope);
      assert.ok(
        !message.includes('seedMesBootstrap'),
        `error must not demand seedMesBootstrap first: ${message}`,
      );
      assert.ok(
        message.includes('no current operational state') || message.includes('not initialized'),
        `message should express initialized-but-no-state: ${message}`,
      );
    } finally {
      fixture.cleanup();
    }
  });

  test('2. initialized + legal first Planning facts: status projects from durable facts', () => {
    const fixture = fixtureRoot();
    try {
      initializeMes(fixture.dir);
      const layer = createMesTransactionLayer(fixture.dir);
      const result = layer.commit(normalEvent([pvr(), pa()]));
      assert.ok(result.materializedFactIds.length > 0);

      const envelope = runStatusDomain(fixture.dir, { detail: false, jsonOutput: true });
      assert.equal(envelope.ok, true, 'status must project from durable first Planning facts');
      const projected = JSON.stringify(envelope);
      assert.ok(projected.includes('S01'), `status must carry scope: ${projected}`);
      assert.ok(projected.includes('PLANNING') || projected.includes('EXECUTE'), `status must carry a phase: ${projected}`);
    } finally {
      fixture.cleanup();
    }
  });

  test('3. existing seed-backed fixture keeps existing behavior', () => {
    const fixture = fixtureRoot();
    try {
      seedMesBootstrap(fixture.dir, seedInput({ git_basis: { ...BASIS, head: fixture.head } }));
      const envelope = runStatusDomain(fixture.dir, { detail: false, jsonOutput: true });
      assert.equal(envelope.ok, true, 'seed-backed store status stays readable');
      assert.ok(JSON.stringify(envelope).includes('S01'));
      assert.equal(fs.existsSync(initAbs(fixture.dir)), false, 'seed-backed store unchanged');
    } finally {
      fixture.cleanup();
    }
  });

  test('4. corrupt initialization / invalid relations still fail closed', () => {
    const fixture = fixtureRoot();
    try {
      // Corrupt init metadata: status entry must not fall back to guessing.
      fs.mkdirSync(path.dirname(initAbs(fixture.dir)), { recursive: true });
      fs.writeFileSync(initAbs(fixture.dir), '{oops', 'utf8');
      const envelope = runStatusDomain(fixture.dir, { detail: false, jsonOutput: true });
      assert.equal(envelope.ok, false);
      const message = JSON.stringify(envelope);
      assert.ok(!message.includes('seedMesBootstrap'), `corrupt init must not demand seedMesBootstrap: ${message}`);
    } finally {
      fixture.cleanup();
    }
  });

  test('5. uninitialized store with normal PVR/PA facts: status must fail closed (no PLANNING projection)', () => {
    const fixture = fixtureRoot();
    try {
      assert.equal(isMesInitialized(fixture.dir), false, 'fresh fixture is not initialized');
      // Legal first Planning facts written into the NOT-initialized store (the
      // transaction layer does not gate on initialization — the status
      // projection boundary is the enforcing point for this invariant).
      const layer = createMesTransactionLayer(fixture.dir);
      const result = layer.commit(normalEvent([pvr(), pa()]));
      assert.ok(result.materializedFactIds.length > 0, 'facts materialized');
      const envelope = runStatusDomain(fixture.dir, { detail: false, jsonOutput: true });
      assert.equal(envelope.ok, false, 'uninitialized store must NOT project a normal PLANNING status');
      const message = JSON.stringify(envelope);
      assert.ok(message.includes('not initialized'), `must name the initialization gap: ${message}`);
    } finally {
      fixture.cleanup();
    }
  });
});