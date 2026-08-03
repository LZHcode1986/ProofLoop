/**
 * manifestSource — S02-C-T02 (PO-S02-C-01 data-source part / PO-S02-C-02 source-error part)
 *
 * Verifies the runtime Manifest source seam against REAL filesystem fixtures
 * (temp directory + real `.proofloop/manifests/<stage>.json` file). The
 * manifest is validated through the kernel `validateManifest` seam (S01).
 *
 * Behaviors under test:
 *   - the canonical manifest path is `<projectRoot>/.proofloop/manifests/<stage>.json`
 *     (custom `manifestPath` also honored);
 *   - a valid manifest is kernel-validated and returned with its slices;
 *   - missing manifest / invalid JSON / schema-invalid payload / stage_id
 *     mismatch → structured `ManifestSourceError` with the canonical code
 *     `DOMAIN.STAGE_NOT_FOUND` (PO-S02-C-02 — manifest stage_id mismatch /
 *     missing manifest);
 *   - determinism (HP-003): two reads of the same fixture are deep-equal.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  manifestSource,
  ManifestSourceError,
  manifestFileDigest,
  defaultManifestPath,
  type ManifestSourceResult,
} from '@proofloop/runtime';
import type { Manifest } from '@proofloop/kernel';

// ============================================================
// Fixture helpers (real temp dirs, real files)
// ============================================================

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

interface ManifestFixture {
  readonly root: string;
  readonly stageId: string;
  write(rel: string, content: string): void;
  cleanup(): void;
}

function makeFixture(stageId = 'S02'): ManifestFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-manifest-'));
  const fx: ManifestFixture = {
    root,
    stageId,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

/**
 * Build a schema-valid Manifest fixture (structure mirrors the real
 * `.proofloop/manifests/S02.json` — known-good literals, independent of the
 * implementation).
 */
function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    stage_id: 'S02',
    source_path: 'delivery/stages/S02/tasks.md',
    source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
    stage_goal: 'Runtime core application services',
    outcomes: ['deterministic reconcile', 'pure reducer'],
    slices: [
      {
        slice_id: 'S02-C',
        goal: 'reconcile three sources',
        observable_outcome: 'deterministic normalized stage state',
        public_seam: '@proofloop/runtime reconcileStage',
        dependencies: ['S02-A'],
        proof_obligations: [
          {
            po_id: 'PO-S02-C-01',
            behavior: 'three-source merge into normalized state',
            public_seam: 'reconcileStage',
            oracle_source: 'real fixture project',
            success_criteria: 'two reconciles deep-equal',
            required_observation: 'fixture oracle',
            applicable_risk_facts: ['persistent_state', 'core_state_machine'],
          },
        ],
        tasks: ['S02-C-T01', 'S02-C-T02', 'S02-C-T03'],
        risk_facts: ['persistent_state'],
        evidence_path: 'delivery/stages/S02/evidence/S02-C.md',
        cv_minimum_level: 'enhanced',
      },
    ],
    dependencies: [],
    risk_facts: [],
    ...overrides,
  };
}

/** Write the manifest to the canonical path and read it back. */
function readCanonical(fx: ManifestFixture): ManifestSourceResult {
  return manifestSource({ projectRoot: fx.root, stageId: fx.stageId });
}

// ============================================================
// Happy path (PO-S02-C-01 data source)
// ============================================================

describe('manifestSource — happy path on a real fixture', () => {
  it('reads and kernel-validates the manifest at the canonical .proofloop/manifests/<stage>.json path', () => {
    const fx = makeFixture();
    fx.write(`.proofloop/manifests/S02.json`, JSON.stringify(makeManifest(), null, 2));

    const result = readCanonical(fx);

    expect(result.manifest_path).toBe(
      path.join(fx.root, '.proofloop', 'manifests', 'S02.json'),
    );
    expect(result.manifest.stage_id).toBe('S02');
    expect(result.manifest.slices).toHaveLength(1);
    expect(result.manifest.slices[0].slice_id).toBe('S02-C');
    expect(result.manifest.slices[0].tasks).toEqual(['S02-C-T01', 'S02-C-T02', 'S02-C-T03']);
    expect(result.manifest.slices[0].evidence_path).toBe('delivery/stages/S02/evidence/S02-C.md');
  });

  it('honors an explicit custom manifestPath', () => {
    const fx = makeFixture();
    fx.write(`custom/manifest.json`, JSON.stringify(makeManifest(), null, 2));

    const result = manifestSource({
      projectRoot: fx.root,
      stageId: 'S02',
      manifestPath: path.join(fx.root, 'custom', 'manifest.json'),
    });

    expect(result.manifest_path).toBe(path.join(fx.root, 'custom', 'manifest.json'));
    expect(result.manifest.stage_id).toBe('S02');
  });

  it('is deterministic: two reads of the same fixture are deep-equal (HP-003)', () => {
    const fx = makeFixture();
    fx.write(`.proofloop/manifests/S02.json`, JSON.stringify(makeManifest(), null, 2));

    const first = readCanonical(fx);
    const second = readCanonical(fx);

    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// ============================================================
// Manifest source errors — DOMAIN.STAGE_NOT_FOUND (PO-S02-C-02)
// ============================================================

describe('manifestSource — structured errors (PO-S02-C-02)', () => {
  function expectStageNotFound(fn: () => ManifestSourceResult, messagePattern: RegExp): void {
    let thrown: unknown;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ManifestSourceError);
    const err = thrown as ManifestSourceError;
    expect(err.code).toBe('DOMAIN.STAGE_NOT_FOUND');
    expect(err.source).toBe('manifest');
    expect(err.message).toMatch(messagePattern);
  }

  it('missing manifest at the canonical path → DOMAIN.STAGE_NOT_FOUND', () => {
    const fx = makeFixture();
    expectStageNotFound(() => readCanonical(fx), /not found|manifest/);
  });

  it('invalid JSON → DOMAIN.STAGE_NOT_FOUND', () => {
    const fx = makeFixture();
    fx.write(`.proofloop/manifests/S02.json`, `{ this is not json`);
    expectStageNotFound(() => readCanonical(fx), /JSON/);
  });

  it('schema-invalid manifest → DOMAIN.STAGE_NOT_FOUND (kernel validateManifest rejection)', () => {
    const fx = makeFixture();
    const invalid = { ...makeManifest() } as Partial<Manifest> & Record<string, unknown>;
    delete invalid.stage_goal; // required field — schema invalid
    fx.write(`.proofloop/manifests/S02.json`, JSON.stringify(invalid));
    expectStageNotFound(() => readCanonical(fx), /schema/i);
  });

  it('manifest stage_id mismatch with the input stage → DOMAIN.STAGE_NOT_FOUND', () => {
    const fx = makeFixture();
    fx.write(
      `.proofloop/manifests/S02.json`,
      JSON.stringify(makeManifest({ stage_id: 'S99' }), null, 2),
    );
    expectStageNotFound(() => readCanonical(fx), /stage_id/);
  });
});

// ============================================================
// Trust-root boundary (S2-F-003) — symlink / absolute escapes fail closed
// ============================================================

describe('manifestSource — trust-root boundary (S2-F-003)', () => {
  function expectTrustBoundaryError(fn: () => ManifestSourceResult): void {
    let thrown: unknown;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ManifestSourceError);
    const err = thrown as ManifestSourceError;
    expect(err.code).toBe('DOMAIN.STAGE_NOT_FOUND');
    expect(err.source).toBe('manifest');
    expect(err.message).toMatch(/trust boundary/);
  }

  it('fails closed when the default manifest path is a symlink to an outside file', () => {
    const fx = makeFixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-manifest-out-'));
    cleanups.push(() => {
      try {
        fs.rmSync(external, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });
    const outsideManifest = path.join(external, 'S02.json');
    fs.writeFileSync(outsideManifest, JSON.stringify(makeManifest(), null, 2), 'utf-8');
    // Replace the manifest FILE with a symlink pointing outside the root.
    const manifestPath = path.join(fx.root, '.proofloop', 'manifests', 'S02.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.symlinkSync(outsideManifest, manifestPath);

    expectTrustBoundaryError(() => readCanonical(fx));
  });

  it('fails closed when a custom manifestPath escapes the trust root', () => {
    const fx = makeFixture();
    const outsideManifest = path.join(
      path.dirname(fx.root),
      `escape-${path.basename(fx.root)}.json`,
    );
    fs.writeFileSync(outsideManifest, JSON.stringify(makeManifest(), null, 2), 'utf-8');
    cleanups.push(() => {
      try {
        fs.rmSync(outsideManifest, { force: true });
      } catch {
        // best-effort cleanup
      }
    });

    expectTrustBoundaryError(() =>
      manifestSource({ projectRoot: fx.root, stageId: 'S02', manifestPath: outsideManifest }),
    );
  });

  it('manifestFileDigest fails closed on a trust-root escape', () => {
    const fx = makeFixture();
    const outsideManifest = path.join(
      path.dirname(fx.root),
      `escape-digest-${path.basename(fx.root)}.json`,
    );
    fs.writeFileSync(outsideManifest, JSON.stringify(makeManifest(), null, 2), 'utf-8');
    cleanups.push(() => {
      try {
        fs.rmSync(outsideManifest, { force: true });
      } catch {
        // best-effort cleanup
      }
    });

    let thrown: unknown;
    try {
      manifestFileDigest({
        projectRoot: fx.root,
        stageId: 'S02',
        manifestPath: outsideManifest,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ManifestSourceError);
    expect((thrown as ManifestSourceError).code).toBe('DOMAIN.STAGE_NOT_FOUND');
    expect((thrown as ManifestSourceError).message).toMatch(/trust boundary/);
  });

  it('legal default and custom paths remain fully functional', () => {
    const fx = makeFixture();
    fx.write(`.proofloop/manifests/S02.json`, JSON.stringify(makeManifest(), null, 2));
    expect(readCanonical(fx).manifest.stage_id).toBe('S02');
    expect(manifestFileDigest({ projectRoot: fx.root, stageId: 'S02' })).toMatch(/^[0-9a-f]{64}$/);

    const fx2 = makeFixture();
    fx2.write(`custom/manifest.json`, JSON.stringify(makeManifest(), null, 2));
    expect(
      manifestSource({
        projectRoot: fx2.root,
        stageId: 'S02',
        manifestPath: path.join(fx2.root, 'custom', 'manifest.json'),
      }).manifest.stage_id,
    ).toBe('S02');
  });
});

// ============================================================
// Path resolution helper
// ============================================================

describe('defaultManifestPath', () => {
  it('resolves the canonical .proofloop/manifests/<stage>.json path', () => {
    expect(defaultManifestPath('/project', 'S02')).toBe(
      path.join('/project', '.proofloop', 'manifests', 'S02.json'),
    );
  });
});
