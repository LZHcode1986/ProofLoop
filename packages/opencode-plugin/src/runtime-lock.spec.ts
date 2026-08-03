/**
 * @proofloop/opencode-plugin — authority runtime.lock normalization &
 * compatibility spec (PO-S01-B-03)
 *
 * PO: PO-S01-B-03
 *
 * Behavior: the authority lock's `plugin_package` / `plugin_version` naming
 * and the kernel validator's `extension_package` / `extension_version` code
 * reality must be bridged through an explicit, closed adapter conversion.
 * Any missing field, unknown alias, wrong type or incompatible version
 * returns a schema/version Finding and NEVER activates — the kernel is never
 * modified and unknown lock shapes are never silently accepted.
 *
 * Public Seam: checked-in `.proofloop/runtime.lock` loading plus the
 * `validateRuntimeLock` adapter boundary — `validateRuntimeLockAt(lockPath)`
 * (the `LockValidator` seam consumed by `detectProject`, T02), with
 * `normalizeAuthorityRuntimeLock` exposing the explicit mapping.
 *
 * The REAL kernel validator (`@proofloop/runtime` re-export) is used as the
 * independent oracle: the spec proves the kernel seam rejects the raw
 * authority shape (so normalization is required and the kernel is
 * unmodified), accepts the normalized shape on the success path, and is
 * compared against the adapter's verdict on every mutation.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  validateRuntimeLock,
  SchemaValidationError,
  type ValidatedRuntimeLock,
} from '@proofloop/runtime';
import type { Finding } from '@proofloop/kernel';
import { detectProject } from './project-detection.js';
import {
  AUTHORITY_LOCK_KNOWN_FIELDS,
  normalizeAuthorityRuntimeLock,
  validateRuntimeLockAt,
  type NormalizedRuntimeLock,
  type RuntimeLockMetadata,
} from './runtime-lock.js';

/** Path of the real checked-in authority lock under the workspace root. */
function checkedInLockPath(): string {
  return path.join(process.cwd(), '.proofloop', 'runtime.lock');
}

function readCheckedInLock(): string {
  return readFileSync(checkedInLockPath(), 'utf8');
}

/** A well-formed authority lock payload (matches the checked-in shape). */
const VALID_AUTHORITY_LOCK = {
  runtime_version: '0.1.0',
  domain_schema_version: 1,
  risk_policy_version: 1,
  capability_policy_version: 1,
  host_adapter: 'opencode',
  plugin_package: '@proofloop/opencode-plugin',
  plugin_version: '0.1.0',
};

/**
 * Deterministic metadata baseline for the metadata-failure repair tests.
 * Independent of the live repo package.json values so the tests are stable
 * across dependency bumps: the failure cases override only the field under
 * test, and the version-mismatch guard verifies the repair did NOT turn real
 * mismatches into schema Findings.
 */
const BASE_TEST_METADATA: RuntimeLockMetadata = {
  pluginPackage: '@proofloop/opencode-plugin',
  pluginVersion: { ok: true, version: '0.1.0' },
  runtimeVersion: { ok: true, version: '0.1.0' },
  schemaVersion: 1,
  hostAdapter: 'opencode',
};

function metadataWith(
  overrides: Partial<RuntimeLockMetadata>,
): RuntimeLockMetadata {
  return { ...BASE_TEST_METADATA, ...overrides };
}

let base: string;
let fixtureId = 0;

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 's01-b-t03-'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Create a fixture project root with the given lock content (or none). */
function fixtureProject(lock: Record<string, unknown> | string | null): string {
  const root = path.join(base, `proj-${fixtureId++}`);
  mkdirSync(path.join(root, '.proofloop'), { recursive: true });
  if (lock !== null) {
    const content =
      typeof lock === 'string'
        ? lock
        : JSON.stringify(lock, null, 2);
    writeFileSync(path.join(root, '.proofloop', 'runtime.lock'), content);
  }
  return root;
}

/** Assert a fail-closed mutation: seam verdict + composed detection decision. */
function expectFailClosedMutation(
  root: string,
  expectedCodes: Finding['code'][],
): void {
  const lockPath = path.join(root, '.proofloop', 'runtime.lock');

  // Seam verdict (LockValidator consumed by detectProject).
  const verdict = validateRuntimeLockAt(lockPath);
  expect(verdict.valid).toBe(false);
  expect(verdict.findings.map((f) => f.code)).toEqual(expectedCodes);
  for (const finding of verdict.findings) {
    expect(finding.severity).toMatch(/^(error|warn)$/);
    expect(typeof finding.message).toBe('string');
  }

  // Composed fail-closed registration decision (never active).
  const decision = detectProject(root, validateRuntimeLockAt);
  expect(decision.lockPresent).toBe(true);
  expect(decision.projectDetected).toBe(true);
  expect(decision.active).toBe(false);
  expect(decision.registerNonDoctorCapabilities).toBe(false);
  expect(decision.findings.map((f) => f.code)).toEqual(expectedCodes);
}

describe('authority runtime.lock normalization (PO-S01-B-03)', () => {
  it('defines the authority whitelist with exactly the §3 runtime.lock fields', () => {
    expect([...AUTHORITY_LOCK_KNOWN_FIELDS].sort()).toEqual(
      [
        'runtime_version',
        'domain_schema_version',
        'risk_policy_version',
        'capability_policy_version',
        'host_adapter',
        'plugin_package',
        'plugin_version',
      ].sort(),
    );
  });

  it('kernel seam rejects the RAW authority lock, proving normalization is required (kernel unmodified)', () => {
    // Independent oracle: the kernel only knows extension_package /
    // extension_version (RUNTIME_LOCK_KNOWN_FIELDS), so the raw authority
    // shape (plugin_package / plugin_version) must fail — this is exactly why
    // the adapter normalization is required and why the kernel was not changed.
    const raw = JSON.parse(readCheckedInLock());
    expect(() => validateRuntimeLock(raw)).toThrow(SchemaValidationError);
  });

  it('normalizes the checked-in authority lock via the explicit mapping', () => {
    const raw = JSON.parse(readCheckedInLock()) as Record<string, unknown>;
    const result = normalizeAuthorityRuntimeLock(raw);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const normalized = result.normalized;

    // Explicit whitelist mapping: plugin_* → extension_*.
    expect(normalized.extension_package).toBe('@proofloop/opencode-plugin');
    expect(normalized.extension_version).toBe('0.1.0');
    expect(normalized.extension_package).toBe(raw.plugin_package);
    expect(normalized.extension_version).toBe(raw.plugin_version);
    // Pass-through fields are preserved.
    expect(normalized.runtime_version).toBe(raw.runtime_version);
    expect(normalized.domain_schema_version).toBe(raw.domain_schema_version);
    expect(normalized.host_adapter).toBe(raw.host_adapter);

    // Independent oracle: the real kernel validator accepts the normalized shape.
    const validated: ValidatedRuntimeLock = validateRuntimeLock(normalized);
    expect(validated.extension_package).toBe('@proofloop/opencode-plugin');
    expect(validated.extension_version).toBe('0.1.0');
  });

  it('accepts the current checked-in runtime.lock via the public seam (valid, no findings)', () => {
    const verdict = validateRuntimeLockAt(checkedInLockPath());
    expect(verdict.valid).toBe(true);
    expect(verdict.findings).toEqual([]);
  });

  it('composes with detectProject: the real repo lock yields an active decision', () => {
    const decision = detectProject(process.cwd(), validateRuntimeLockAt);
    expect(decision.lockPresent).toBe(true);
    expect(decision.active).toBe(true);
    expect(decision.registerNonDoctorCapabilities).toBe(true);
    expect(decision.findings).toEqual([]);
  });

  it('accepts a well-formed authority lock fixture (mapping + kernel oracle agree)', () => {
    const root = fixtureProject(VALID_AUTHORITY_LOCK);
    const verdict = validateRuntimeLockAt(
      path.join(root, '.proofloop', 'runtime.lock'),
    );
    expect(verdict).toEqual({ valid: true, findings: [] });
  });

  it('fails closed on a missing required field (no runtime_version)', () => {
    const root = fixtureProject({
      domain_schema_version: 1,
      risk_policy_version: 1,
      capability_policy_version: 1,
      host_adapter: 'opencode',
      plugin_package: '@proofloop/opencode-plugin',
      plugin_version: '0.1.0',
    });
    expectFailClosedMutation(root, ['RUNTIME.SCHEMA_MISMATCH']);
  });

  it('fails closed on an unknown field (bogus_field)', () => {
    const root = fixtureProject({ ...VALID_AUTHORITY_LOCK, bogus_field: 1 });
    expectFailClosedMutation(root, ['RUNTIME.SCHEMA_MISMATCH']);
  });

  it('fails closed on an unknown alias (plugin_name instead of plugin_package)', () => {
    const root = fixtureProject({
      runtime_version: '0.1.0',
      domain_schema_version: 1,
      risk_policy_version: 1,
      capability_policy_version: 1,
      host_adapter: 'opencode',
      plugin_name: '@proofloop/opencode-plugin',
      plugin_version: '0.1.0',
    });
    expectFailClosedMutation(root, ['RUNTIME.SCHEMA_MISMATCH']);
  });

  it('fails closed on a wrong field type (plugin_version as number)', () => {
    const root = fixtureProject({
      ...VALID_AUTHORITY_LOCK,
      plugin_version: 0.1,
    });
    expectFailClosedMutation(root, ['RUNTIME.SCHEMA_MISMATCH']);
  });

  it('fails closed on a wrong field type (runtime_version as number)', () => {
    const root = fixtureProject({
      ...VALID_AUTHORITY_LOCK,
      runtime_version: 123,
    });
    expectFailClosedMutation(root, ['RUNTIME.SCHEMA_MISMATCH']);
  });

  it('fails closed on a runtime version mismatch', () => {
    const root = fixtureProject({
      ...VALID_AUTHORITY_LOCK,
      runtime_version: '0.2.0',
    });
    expectFailClosedMutation(root, ['RUNTIME.VERSION_MISMATCH']);
  });

  it('fails closed on a plugin version mismatch', () => {
    const root = fixtureProject({
      ...VALID_AUTHORITY_LOCK,
      plugin_version: '9.9.9',
    });
    expectFailClosedMutation(root, ['RUNTIME.VERSION_MISMATCH']);
  });

  it('fails closed on a plugin package name mismatch', () => {
    const root = fixtureProject({
      ...VALID_AUTHORITY_LOCK,
      plugin_package: 'some-other-plugin',
    });
    expectFailClosedMutation(root, ['RUNTIME.VERSION_MISMATCH']);
  });

  it('fails closed on a domain schema version mismatch', () => {
    const root = fixtureProject({
      ...VALID_AUTHORITY_LOCK,
      domain_schema_version: 999,
    });
    expectFailClosedMutation(root, ['RUNTIME.SCHEMA_MISMATCH']);
  });

  it('fails closed on an unsupported host adapter', () => {
    const root = fixtureProject({
      ...VALID_AUTHORITY_LOCK,
      host_adapter: 'pi-extension',
    });
    expectFailClosedMutation(root, ['HOST.PROJECT_NOT_TRUSTED']);
  });

  it('fails closed on non-JSON lock content', () => {
    const root = fixtureProject('{ this is not json');
    expectFailClosedMutation(root, ['RUNTIME.SCHEMA_MISMATCH']);
  });

  it('fails closed on a missing lock file at the seam (schema/read problem)', () => {
    const root = fixtureProject(null);
    const lockPath = path.join(root, '.proofloop', 'runtime.lock');
    const verdict = validateRuntimeLockAt(lockPath);
    expect(verdict.valid).toBe(false);
    expect(verdict.findings.map((f) => f.code)).toEqual([
      'RUNTIME.SCHEMA_MISMATCH',
    ]);
  });
});

describe('metadata read failure fails closed (repair: S01-B-METADATA-READ-FAIL-OPEN)', () => {
  it('fails closed when the plugin package.json is unreadable, even with correct lock versions', () => {
    const root = fixtureProject(VALID_AUTHORITY_LOCK);
    const lockPath = path.join(root, '.proofloop', 'runtime.lock');
    const metadata = metadataWith({
      pluginVersion: { ok: false, reason: 'injected: plugin package.json missing' },
    });

    const verdict = validateRuntimeLockAt(lockPath, metadata);
    expect(verdict.valid).toBe(false);
    expect(verdict.findings.map((f) => f.code)).toEqual([
      'RUNTIME.SCHEMA_MISMATCH',
    ]);
    expect(verdict.findings[0].severity).toBe('error');
    expect(typeof verdict.findings[0].message).toBe('string');

    // Composed fail-closed registration decision (never active).
    const decision = detectProject(root, (p) =>
      validateRuntimeLockAt(p, metadata),
    );
    expect(decision.lockPresent).toBe(true);
    expect(decision.active).toBe(false);
    expect(decision.registerNonDoctorCapabilities).toBe(false);
    expect(decision.findings.map((f) => f.code)).toEqual([
      'RUNTIME.SCHEMA_MISMATCH',
    ]);
  });

  it('fails closed when @proofloop/runtime package.json is unreadable', () => {
    const root = fixtureProject(VALID_AUTHORITY_LOCK);
    const lockPath = path.join(root, '.proofloop', 'runtime.lock');
    const metadata = metadataWith({
      runtimeVersion: {
        ok: false,
        reason: 'injected: @proofloop/runtime package.json unreadable',
      },
    });

    const verdict = validateRuntimeLockAt(lockPath, metadata);
    expect(verdict.valid).toBe(false);
    expect(verdict.findings.map((f) => f.code)).toEqual([
      'RUNTIME.SCHEMA_MISMATCH',
    ]);

    const decision = detectProject(root, (p) =>
      validateRuntimeLockAt(p, metadata),
    );
    expect(decision.active).toBe(false);
    expect(decision.registerNonDoctorCapabilities).toBe(false);
  });

  it('fails closed on corrupt plugin package.json JSON', () => {
    const root = fixtureProject(VALID_AUTHORITY_LOCK);
    const lockPath = path.join(root, '.proofloop', 'runtime.lock');
    const metadata = metadataWith({
      pluginVersion: {
        ok: false,
        reason: 'Cannot read plugin package.json: <corrupt JSON parse failure>',
      },
    });

    const verdict = validateRuntimeLockAt(lockPath, metadata);
    expect(verdict.valid).toBe(false);
    expect(verdict.findings.map((f) => f.code)).toEqual([
      'RUNTIME.SCHEMA_MISMATCH',
    ]);
  });

  it('fails closed when BOTH metadata reads fail, reporting each schema finding', () => {
    const root = fixtureProject(VALID_AUTHORITY_LOCK);
    const lockPath = path.join(root, '.proofloop', 'runtime.lock');
    const metadata = metadataWith({
      runtimeVersion: { ok: false, reason: 'runtime metadata missing' },
      pluginVersion: { ok: false, reason: 'plugin metadata missing' },
    });

    const verdict = validateRuntimeLockAt(lockPath, metadata);
    expect(verdict.valid).toBe(false);
    expect(verdict.findings.map((f) => f.code)).toEqual([
      'RUNTIME.SCHEMA_MISMATCH',
      'RUNTIME.SCHEMA_MISMATCH',
    ]);
  });

  it('keeps RUNTIME.VERSION_MISMATCH when metadata reads succeed but versions mismatch (repair did not change mismatch semantics)', () => {
    const root = fixtureProject({
      ...VALID_AUTHORITY_LOCK,
      plugin_version: '9.9.9',
    });
    const lockPath = path.join(root, '.proofloop', 'runtime.lock');
    const metadata = metadataWith({});

    const verdict = validateRuntimeLockAt(lockPath, metadata);
    expect(verdict.valid).toBe(false);
    expect(verdict.findings.map((f) => f.code)).toEqual([
      'RUNTIME.VERSION_MISMATCH',
    ]);

    const decision = detectProject(root, (p) =>
      validateRuntimeLockAt(p, metadata),
    );
    expect(decision.active).toBe(false);
    expect(decision.registerNonDoctorCapabilities).toBe(false);
  });
});
