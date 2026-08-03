/**
 * @proofloop/opencode-plugin — authority `runtime.lock` read, explicit
 * whitelist normalization and version compatibility (S01-B-T03 / AWI-002,
 * PO-S01-B-03).
 *
 * Implements the `LockValidator` seam injected by `detectProject` (T02):
 * `validateRuntimeLockAt(lockPath)` reads the checked-in `.proofloop/
 * runtime.lock` under the canonical trust root and returns a fail-closed
 * verdict with canonical kernel Findings.
 *
 * The authority lock (§3 runtime.lock) uses `plugin_package` /
 * `plugin_version`, while the kernel `validateRuntimeLock` seam
 * (packages/kernel/src/validators.ts RUNTIME_LOCK_KNOWN_FIELDS) only accepts
 * `extension_package` / `extension_version`. This adapter performs the ONLY
 * allowed explicit mapping — plugin_package → extension_package and
 * plugin_version → extension_version — and rejects every other shape:
 * unknown fields, unknown aliases, missing fields and wrong types are all
 * structured Findings that fail closed. The kernel is never modified.
 *
 * After the kernel seam validates the normalized object, compatibility is
 * compared against the ACTUAL package versions (read live from package.json)
 * and the declared host/schema baseline:
 *   - runtime version  → lock runtime_version vs @proofloop/runtime version
 *                        (RUNTIME.VERSION_MISMATCH)
 *   - plugin version   → lock plugin_package+plugin_version vs this plugin
 *                        (RUNTIME.VERSION_MISMATCH)
 *   - schema version   → lock domain_schema_version vs declared baseline
 *                        (RUNTIME.SCHEMA_MISMATCH)
 *   - host adapter     → lock host_adapter == 'opencode'
 *                        (HOST.PROJECT_NOT_TRUSTED)
 * Every incompatible branch returns a structured Finding and NEVER activates.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateRuntimeLock, SchemaValidationError } from '@proofloop/runtime';
import type { Finding } from '@proofloop/kernel';
import type { LockValidationResult } from './project-detection.js';

const require = createRequire(import.meta.url);

/** Authority runtime.lock field whitelist (§3 runtime.lock, contract-state-matrix). */
export const AUTHORITY_LOCK_KNOWN_FIELDS: readonly string[] = [
  'runtime_version',
  'domain_schema_version',
  'risk_policy_version',
  'capability_policy_version',
  'host_adapter',
  'plugin_package',
  'plugin_version',
];

const AUTHORITY_LOCK_KNOWN_FIELDS_SET = new Set(AUTHORITY_LOCK_KNOWN_FIELDS);

/** Canonical host adapter supported by this plugin (host-compatibility). */
export const EXPECTED_HOST_ADAPTER = 'opencode';

/** Declared supported domain schema version (authority lock §3 baseline). */
export const EXPECTED_SCHEMA_VERSION = 1;

/** Canonical plugin package name (S01-A package identity). */
export const PLUGIN_PACKAGE_NAME = '@proofloop/opencode-plugin';

/**
 * Result of reading a package version from its package.json metadata.
 * `ok: false` distinguishes a metadata READ FAILURE from a successful read
 * of a (possibly mismatched) version — the two must fail closed differently:
 * a read failure means compatibility CANNOT be verified, so it is a schema
 * Finding, never a skipped check.
 */
export type PackageVersionRead =
  | { ok: true; version: string }
  | { ok: false; reason: string };

/** Expected lock facts used for the compatibility comparison. */
export interface RuntimeLockMetadata {
  pluginPackage: string;
  pluginVersion: PackageVersionRead;
  runtimeVersion: PackageVersionRead;
  schemaVersion: number;
  hostAdapter: string;
}

/** Actual @proofloop/runtime package version (live from package.json). */
function readRuntimePackageVersion(): PackageVersionRead {
  try {
    const pkg = require('@proofloop/runtime/package.json') as {
      version?: unknown;
    };
    if (typeof pkg.version === 'string') {
      return { ok: true, version: pkg.version };
    }
    return {
      ok: false,
      reason: '@proofloop/runtime package.json has no string version',
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Cannot read @proofloop/runtime package.json: ${String(error)}`,
    };
  }
}

/** Actual plugin package version (live from this package's package.json). */
function readPluginPackageVersion(): PackageVersionRead {
  try {
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../package.json', import.meta.url)),
        'utf8',
      ),
    ) as { version?: unknown };
    if (typeof pkg.version === 'string') {
      return { ok: true, version: pkg.version };
    }
    return {
      ok: false,
      reason: 'plugin package.json has no string version',
    };
  } catch (error) {
    return {
      ok: false,
      reason: `Cannot read plugin package.json: ${String(error)}`,
    };
  }
}

/**
 * Expected lock facts, read live so the comparison uses the ACTUAL package
 * versions rather than re-derived constants. A failed read is carried as
 * `ok: false` so `validateRuntimeLockAt` can fail closed instead of skipping
 * the version comparison (CV failure signature S01-B-METADATA-READ-FAIL-OPEN).
 */
export const RUNTIME_LOCK_EXPECTATIONS: RuntimeLockMetadata = {
  pluginPackage: PLUGIN_PACKAGE_NAME,
  pluginVersion: readPluginPackageVersion(),
  runtimeVersion: readRuntimePackageVersion(),
  schemaVersion: EXPECTED_SCHEMA_VERSION,
  hostAdapter: EXPECTED_HOST_ADAPTER,
};

/** Normalized RuntimeLock shape accepted by the kernel `validateRuntimeLock` seam. */
export type NormalizedRuntimeLock = {
  runtime_version: string;
  domain_schema_version: number;
  risk_policy_version: number;
  capability_policy_version: number;
  host_adapter: string;
  extension_package: string;
  extension_version: string;
};

/** Result of the explicit whitelist normalization step. */
export type NormalizationResult =
  | { ok: true; normalized: NormalizedRuntimeLock }
  | { ok: false; findings: Finding[] };

/**
 * Explicit whitelist normalization of the authority lock object.
 *
 * Only the authority field names are accepted; `plugin_package` is mapped to
 * `extension_package` and `plugin_version` to `extension_version` (the only
 * names the kernel seam accepts). Any unknown field / alias, missing field or
 * wrong type returns a `RUNTIME.SCHEMA_MISMATCH` Finding (never silently
 * relaxed, never accepted as an arbitrary alias). Type errors on mapped
 * fields are left for the kernel validator to surface via the same Finding.
 */
export function normalizeAuthorityRuntimeLock(
  raw: unknown,
): NormalizationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      findings: [
        schemaFinding('runtime.lock is not a JSON object'),
      ],
    };
  }
  const lock = raw as Record<string, unknown>;

  const unknownKeys = Object.keys(lock).filter(
    (key) => !AUTHORITY_LOCK_KNOWN_FIELDS_SET.has(key),
  );
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      findings: [
        schemaFinding(
          `runtime.lock contains unknown or alias fields: ${unknownKeys.join(', ')}`,
        ),
      ],
    };
  }

  const normalized: NormalizedRuntimeLock = {
    // Field values are read as `unknown` here; the real kernel validator is
    // the type oracle and rejects wrong types with a SCHEMA_MISMATCH Finding.
    runtime_version: lock.runtime_version as string,
    domain_schema_version: lock.domain_schema_version as number,
    risk_policy_version: lock.risk_policy_version as number,
    capability_policy_version: lock.capability_policy_version as number,
    host_adapter: lock.host_adapter as string,
    // The ONLY allowed explicit mapping (authority → kernel seam names).
    extension_package: lock.plugin_package as string,
    extension_version: lock.plugin_version as string,
  };
  return { ok: true, normalized };
}

function schemaFinding(message: string): Finding {
  return { code: 'RUNTIME.SCHEMA_MISMATCH', severity: 'error', message };
}

function versionFinding(message: string): Finding {
  return { code: 'RUNTIME.VERSION_MISMATCH', severity: 'error', message };
}

function untrustedFinding(message: string): Finding {
  return { code: 'HOST.PROJECT_NOT_TRUSTED', severity: 'error', message };
}

/**
 * Read and validate the authority runtime.lock at `lockPath` — the
 * `LockValidator` seam consumed by `detectProject` (T02).
 *
 * Fail-closed ordering:
 *   1. read + JSON parse → RUNTIME.SCHEMA_MISMATCH on failure;
 *   2. explicit whitelist normalization → RUNTIME.SCHEMA_MISMATCH on any
 *      unknown field / alias / non-object;
 *   3. real kernel `validateRuntimeLock` on the normalized shape →
 *      RUNTIME.SCHEMA_MISMATCH on missing fields / wrong types (kernel is the
 *      unmodified oracle);
 *   4. compatibility comparison (runtime / plugin / schema / host) →
 *      RUNTIME.VERSION_MISMATCH / RUNTIME.SCHEMA_MISMATCH /
 *      HOST.PROJECT_NOT_TRUSTED.
 * Only a lock passing ALL steps returns `{ valid: true, findings: [] }`.
 */
export function validateRuntimeLockAt(
  lockPath: string,
  metadata: RuntimeLockMetadata = RUNTIME_LOCK_EXPECTATIONS,
): LockValidationResult {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return {
      valid: false,
      findings: [
        schemaFinding(`Cannot read ${lockPath}: ${lockPath} is missing or not a readable file`),
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      valid: false,
      findings: [schemaFinding(`${lockPath} is not valid JSON`)],
    };
  }

  const normalizedResult = normalizeAuthorityRuntimeLock(parsed);
  if (!normalizedResult.ok) {
    return { valid: false, findings: normalizedResult.findings };
  }
  const normalized = normalizedResult.normalized;

  // Real kernel seam on the normalized shape (unmodified validator).
  try {
    validateRuntimeLock(normalized);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      return {
        valid: false,
        findings: [schemaFinding(error.message)],
      };
    }
    return {
      valid: false,
      findings: [schemaFinding(`runtime.lock schema validation failed: ${String(error)}`)],
    };
  }

  // Compatibility comparison against actual versions and declared baseline.
  // A metadata READ FAILURE (`ok: false`) must fail closed with a schema
  // Finding — the version comparison is NEVER skipped (CV failure signature
  // S01-B-METADATA-READ-FAIL-OPEN). A successful read with a mismatch keeps
  // the RUNTIME.VERSION_MISMATCH fail-closed behavior.
  const findings: Finding[] = [];
  const expectations = metadata;

  if (!expectations.runtimeVersion.ok) {
    findings.push(
      schemaFinding(
        `Cannot determine actual @proofloop/runtime version (metadata read failed): ${expectations.runtimeVersion.reason}`,
      ),
    );
  } else if (
    normalized.runtime_version !== expectations.runtimeVersion.version
  ) {
    findings.push(
      versionFinding(
        `runtime_version ${normalized.runtime_version} does not match @proofloop/runtime ${expectations.runtimeVersion.version}`,
      ),
    );
  }

  if (!expectations.pluginVersion.ok) {
    findings.push(
      schemaFinding(
        `Cannot determine actual plugin version (metadata read failed): ${expectations.pluginVersion.reason}`,
      ),
    );
  } else if (
    normalized.extension_package !== expectations.pluginPackage ||
    normalized.extension_version !== expectations.pluginVersion.version
  ) {
    findings.push(
      versionFinding(
        `plugin ${normalized.extension_package}@${normalized.extension_version} does not match ${expectations.pluginPackage}@${expectations.pluginVersion.version}`,
      ),
    );
  }

  if (normalized.domain_schema_version !== expectations.schemaVersion) {
    findings.push(
      schemaFinding(
        `domain_schema_version ${normalized.domain_schema_version} does not match supported ${expectations.schemaVersion}`,
      ),
    );
  }

  if (normalized.host_adapter !== expectations.hostAdapter) {
    findings.push(
      untrustedFinding(
        `host_adapter ${normalized.host_adapter} is not supported; expected ${expectations.hostAdapter}`,
      ),
    );
  }

  return { valid: findings.length === 0, findings };
}
