/**
 * @proofloop/opencode-plugin — ProofLoop project detection spec (PO-S01-B-02)
 *
 * PO: PO-S01-B-02
 *
 * Behavior: only a valid ProofLoop identity and a compatible lock may produce
 * an active project decision; detection must fail closed. Missing lock,
 * JSON/schema errors, runtime/plugin/schema/host mismatch or an untrusted
 * root produce a structured error and close non-doctor registration.
 *
 * Public Seam: plugin initialization registration decision —
 * `detectProject(projectRoot, lockValidator)`.
 *
 * The six required fixture classes are covered:
 *   1. valid            — lock present + auxiliary facts → active
 *   2. missing lock     — `.proofloop/` exists, no runtime.lock → inactive
 *   3. invalid JSON lock — lock content is not JSON → inactive (T03 seam)
 *   4. unknown field    — lock carries a non-whitelisted field → inactive (T03 seam)
 *   5. version mismatch — lock plugin_version incompatible → inactive (T03 seam)
 *   6. non-ProofLoop    — no `.proofloop` at the trust root → inactive
 *
 * T03 seam integration (S01-B-T03): content-class fixtures 3–5 run through the
 * REAL `validateRuntimeLockAt` seam (runtime-lock.ts), not a test-side stub.
 * Detection still never substitutes directory/file existence for lock
 * validation semantics — the seam is always invoked when the lock file is
 * present, and the real seam produces the canonical Finding codes.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Finding } from '@proofloop/kernel';
import {
  detectProject,
  DELIVERY_DIR,
  MANIFESTS_DIR,
  PROOFLOOP_DIR,
  RUNTIME_LOCK_FILE,
  type ProjectDetectionDecision,
} from './project-detection.js';
import { validateRuntimeLockAt } from './runtime-lock.js';

/** A well-formed authority lock payload (plugin_package / plugin_version names). */
const VALID_LOCK = JSON.stringify({
  runtime_version: '0.1.0',
  domain_schema_version: 1,
  risk_policy_version: 1,
  capability_policy_version: 1,
  host_adapter: 'opencode',
  plugin_package: '@proofloop/opencode-plugin',
  plugin_version: '0.1.0',
});

/** Assert the invariant that the fail-closed capability gate mirrors `active`. */
function expectFailClosedDecision(
  decision: ProjectDetectionDecision,
  expected: {
    active: boolean;
    lockPresent: boolean;
    projectDetected: boolean;
    findingCodes: Finding['code'][];
  },
): void {
  expect(decision.lockPresent).toBe(expected.lockPresent);
  expect(decision.projectDetected).toBe(expected.projectDetected);
  expect(decision.active).toBe(expected.active);
  expect(decision.registerNonDoctorCapabilities).toBe(expected.active);
  expect(decision.findings.map((f) => f.code)).toEqual(expected.findingCodes);
  for (const finding of decision.findings) {
    expect(finding.severity).toMatch(/^(error|warn)$/);
    expect(typeof finding.message).toBe('string');
  }
}

let base: string;
let nextFixture = 0;

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 's01-b-t02-'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Create an isolated fixture project directory and return its trust root. */
function makeFixture(): string {
  const root = path.join(base, `fixture-${nextFixture++}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeLock(root: string, content: string): void {
  mkdirSync(path.join(root, PROOFLOOP_DIR), { recursive: true });
  writeFileSync(path.join(root, PROOFLOOP_DIR, RUNTIME_LOCK_FILE), content);
}

describe('detectProject (PO-S01-B-02)', () => {
  it('activates a ProofLoop project with a valid lock and auxiliary facts', () => {
    const root = makeFixture();
    writeLock(root, VALID_LOCK);
    mkdirSync(path.join(root, PROOFLOOP_DIR, MANIFESTS_DIR), { recursive: true });
    mkdirSync(path.join(root, DELIVERY_DIR), { recursive: true });

    const decision = detectProject(root, validateRuntimeLockAt);

    expectFailClosedDecision(decision, {
      active: true,
      lockPresent: true,
      projectDetected: true,
      findingCodes: [],
    });
    expect(decision.facts).toEqual({
      manifestsDirPresent: true,
      deliveryDirPresent: true,
    });
  });

  it('fails closed when .proofloop exists but runtime.lock is missing', () => {
    const root = makeFixture();
    mkdirSync(path.join(root, PROOFLOOP_DIR), { recursive: true });
    mkdirSync(path.join(root, PROOFLOOP_DIR, MANIFESTS_DIR), { recursive: true });
    mkdirSync(path.join(root, DELIVERY_DIR), { recursive: true });
    // No runtime.lock file.

    const decision = detectProject(root, validateRuntimeLockAt);

    expectFailClosedDecision(decision, {
      active: false,
      lockPresent: false,
      projectDetected: false,
      findingCodes: ['HOST.PROJECT_NOT_TRUSTED'],
    });
    // Auxiliary facts are still observable even though the identity is absent.
    expect(decision.facts).toEqual({
      manifestsDirPresent: true,
      deliveryDirPresent: true,
    });
  });

  it('fails closed on an invalid-JSON runtime.lock (T03 seam: RUNTIME.SCHEMA_MISMATCH)', () => {
    const root = makeFixture();
    writeLock(root, '{ this is not json');

    const decision = detectProject(root, validateRuntimeLockAt);

    expectFailClosedDecision(decision, {
      active: false,
      lockPresent: true,
      projectDetected: true,
      findingCodes: ['RUNTIME.SCHEMA_MISMATCH'],
    });
  });

  it('fails closed on unknown lock fields (T03 seam: RUNTIME.SCHEMA_MISMATCH)', () => {
    const root = makeFixture();
    writeLock(
      root,
      JSON.stringify({
        plugin_package: '@proofloop/opencode-plugin',
        plugin_version: '0.1.0',
        bogus_field: 1,
      }),
    );

    const decision = detectProject(root, validateRuntimeLockAt);

    expectFailClosedDecision(decision, {
      active: false,
      lockPresent: true,
      projectDetected: true,
      findingCodes: ['RUNTIME.SCHEMA_MISMATCH'],
    });
  });

  it('fails closed on an incompatible plugin version (T03 seam: RUNTIME.VERSION_MISMATCH)', () => {
    const root = makeFixture();
    writeLock(
      root,
      JSON.stringify({
        runtime_version: '0.1.0',
        domain_schema_version: 1,
        risk_policy_version: 1,
        capability_policy_version: 1,
        host_adapter: 'opencode',
        plugin_package: '@proofloop/opencode-plugin',
        plugin_version: '9.9.9',
      }),
    );

    const decision = detectProject(root, validateRuntimeLockAt);

    expectFailClosedDecision(decision, {
      active: false,
      lockPresent: true,
      projectDetected: true,
      findingCodes: ['RUNTIME.VERSION_MISMATCH'],
    });
  });

  it('does not detect a non-ProofLoop directory and does not scan unrelated content', () => {
    const root = makeFixture();
    // Unrelated repository content only — no `.proofloop` at the trust root.
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');
    writeFileSync(path.join(root, 'README.md'), '# ordinary project\n');
    // A nested fake `.proofloop/runtime.lock` must NOT be picked up: detection
    // is anchored at the canonical trust root, not a repo-wide scan.
    const nested = path.join(root, 'vendor', 'example', PROOFLOOP_DIR);
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, RUNTIME_LOCK_FILE), VALID_LOCK);

    const decision = detectProject(root, validateRuntimeLockAt);

    expectFailClosedDecision(decision, {
      active: false,
      lockPresent: false,
      projectDetected: false,
      findingCodes: ['HOST.PROJECT_NOT_TRUSTED'],
    });
    expect(decision.facts).toEqual({
      manifestsDirPresent: false,
      deliveryDirPresent: false,
    });
  });

  it('never enables non-doctor capabilities unless the project is active', () => {
    const fixtures: Array<() => string> = [
      // Recreate every failure fixture and assert the capability gate closes.
      () => {
        const root = makeFixture();
        mkdirSync(path.join(root, PROOFLOOP_DIR), { recursive: true });
        return root;
      },
      () => {
        const root = makeFixture();
        writeLock(root, '{ bad json');
        return root;
      },
      () => {
        const root = makeFixture();
        writeLock(root, JSON.stringify({ plugin_version: '0.1.0', plugin_package: 'x', extra: 1 }));
        return root;
      },
      () => {
        const root = makeFixture();
        writeLock(root, JSON.stringify({ plugin_package: '@proofloop/opencode-plugin', plugin_version: '3.0.0' }));
        return root;
      },
      () => {
        const root = makeFixture();
        writeFileSync(path.join(root, 'package.json'), '{}\n');
        return root;
      },
    ];

    for (const build of fixtures) {
      const decision = detectProject(build(), validateRuntimeLockAt);
      expect(decision.active).toBe(false);
      expect(decision.registerNonDoctorCapabilities).toBe(false);
    }
  });
});
