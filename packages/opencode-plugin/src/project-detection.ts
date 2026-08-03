/**
 * @proofloop/opencode-plugin — ProofLoop project detection & registration
 * decision (S01-B-T02 / AWI-002, PO-S01-B-02).
 *
 * Detection is keyed on the PRIMARY identity `.proofloop/runtime.lock` under
 * the canonical trust root (RuntimeContext.projectRoot, T01) and corroborated
 * by auxiliary facts (`.proofloop/manifests/`, `delivery/`). It never scans
 * unrelated repository content (FR-001). Lock CONTENT validation is delegated
 * to the injected `LockValidator` seam (T03 delivers the real implementation:
 * authority field normalization → kernel `validateRuntimeLock` → version
 * comparison). This task defines the decision shape and the detection fact
 * determination; the seam keeps the lock/schema/version fail-closed semantics.
 */

import { statSync } from 'node:fs';
import path from 'node:path';
import type { Finding } from '@proofloop/kernel';

/** ProofLoop project directory name inside the trust root. */
export const PROOFLOOP_DIR = '.proofloop';
/** Primary project identity file. */
export const RUNTIME_LOCK_FILE = 'runtime.lock';
/** Auxiliary fact: manifests directory under `.proofloop/`. */
export const MANIFESTS_DIR = 'manifests';
/** Auxiliary fact: delivery directory at the trust root. */
export const DELIVERY_DIR = 'delivery';

/** Structured result of lock content validation (T03 seam output). */
export interface LockValidationResult {
  valid: boolean;
  findings: Finding[];
}

/**
 * T03 seam: validates the runtime.lock file at `lockPath` (read → authority
 * field normalization → kernel validateRuntimeLock → version comparison) and
 * returns a fail-closed verdict with canonical Findings.
 */
export type LockValidator = (lockPath: string) => LockValidationResult;

/** Observable detection facts (auxiliary corroboration; no repo scan). */
export interface ProjectDetectionFacts {
  manifestsDirPresent: boolean;
  deliveryDirPresent: boolean;
}

/** Structured registration decision consumed by plugin init (S01-C). */
export interface ProjectDetectionDecision {
  /** Primary identity recognized: `.proofloop/runtime.lock` present. */
  projectDetected: boolean;
  /** `.proofloop/runtime.lock` file presence. */
  lockPresent: boolean;
  /**
   * Final registration gate: lock present AND lock content validation passed.
   * Only an active project may register non-doctor capabilities (fail-closed).
   */
  active: boolean;
  /** Canonical structured findings (kernel Finding shape). */
  findings: Finding[];
  /**
   * Fail-closed semantics: strictly `=== active`. When inactive, no
   * non-doctor capability may be registered (doctor-only, handled by S01-C).
   */
  registerNonDoctorCapabilities: boolean;
  /** Observable auxiliary facts. */
  facts: ProjectDetectionFacts;
}

/**
 * Assemble the ProofLoop project detection & registration decision for the
 * canonical trust root (RuntimeContext.projectRoot, T01).
 *
 * Detection is anchored at the trust root only: it reads `.proofloop/
 * runtime.lock`, `.proofloop/manifests/` and `delivery/` — it never scans
 * unrelated repository content (FR-001). The lock file is the PRIMARY
 * identity: when present, the project is *detected*; the lock CONTENT verdict
 * always comes from the injected `lockValidator` seam (T03), so directory or
 * file existence can never substitute for lock/schema/version validation.
 *
 * Fail-closed: a missing lock or a non-ProofLoop root yields
 * `HOST.PROJECT_NOT_TRUSTED` and `active = false`; an invalid/incompatible
 * lock yields the seam's canonical Finding and `active = false`. The decision
 * carries `registerNonDoctorCapabilities = active`, so no non-doctor
 * capability may register unless the project is fully active (doctor-only is
 * handled by S01-C registration).
 */
export function detectProject(
  projectRoot: string,
  lockValidator: LockValidator,
): ProjectDetectionDecision {
  const proofloopDir = path.join(projectRoot, PROOFLOOP_DIR);
  const lockPath = path.join(proofloopDir, RUNTIME_LOCK_FILE);

  const lockPresent = isFile(lockPath);
  const facts: ProjectDetectionFacts = {
    manifestsDirPresent: isDirectory(path.join(proofloopDir, MANIFESTS_DIR)),
    deliveryDirPresent: isDirectory(path.join(projectRoot, DELIVERY_DIR)),
  };

  const findings: Finding[] = [];
  let active = false;

  if (!lockPresent) {
    findings.push({
      code: 'HOST.PROJECT_NOT_TRUSTED',
      severity: 'error',
      message: `No ${PROOFLOOP_DIR}/${RUNTIME_LOCK_FILE} under trust root ${projectRoot}; not a ProofLoop project.`,
    });
  } else {
    const lockResult = lockValidator(lockPath);
    findings.push(...lockResult.findings);
    active = lockResult.valid;
  }

  return {
    projectDetected: lockPresent,
    lockPresent,
    active,
    findings,
    registerNonDoctorCapabilities: active,
    facts,
  };
}

/** True when `p` exists as a regular file. */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when `p` exists as a directory. */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
