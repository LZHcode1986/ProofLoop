/**
 * @proofloop/runtime — Unified admit pipeline (AWI-006 / PO-S02-E-01)
 *
 * The single Receipt-creation path for the Stage's 7 admit operations
 * (S02-E-T02..T04 wire each admit method onto this pipeline):
 *
 *   request schema validation (fail closed) → reconcile current state →
 *   reducer precheck / state advance (per-admit steps) → canonical Receipt
 *   construction (type/stage/slice/payload binding + previous_digest chain
 *   linkage) → persistence through the injected `ReceiptWriterPort`
 *   (legacy kernel `writeReceipt` by default) → post-write chain verification →
 *   `{ accepted, receipt_ref, new_state, findings }`.
 *
 * Fail-closed contract (AWI-006 forbidden shortcuts):
 *   - invalid input or an unreconcilable state → structured rejection with a
 *     canonical Finding and NO Receipt;
 *   - a broken target category chain blocks the admit
 *     (RUNTIME.RECEIPT_CHAIN_BROKEN);
 *   - legacy persistence is ONLY through the writer port; the active vNext
 *     branch uses K2/K1 for directory/Receipt writes and performs only
 *     fd-bound readback, chain verification, and rollback revalidation;
 *   - when the post-write chain verification fails AFTER the receipt was
 *     persisted, the just-written receipt is ROLLED BACK — bound to the
 *     verified category directory inode (S03-A dirfd precedent, no parent
 *     swap can redirect the unlink) and only when it is STILL the category
 *     chain tip, re-confirmed THROUGH THE SAME BOUND DIRFD immediately before
 *     the unlink (round-3 last-moment re-validation) so a successor appended
 *     between the checks is never orphaned; a failed/skipped rollback is
 *     honestly declared in the reject findings (S3-REVIEW-002 / OUT-S3-04).
 *
 * The `AdmissionRequest` union is open for S03/S04/S05 extension (SPV /
 * GATE / GATE_INTERRUPTED / SLICE_PLAN kinds); the pipeline accepts any
 * member unchanged.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  writeReceipt,
  writeReceiptBounded,
  ensureBoundedReceiptDirectory,
  computeReceiptDigest,
  computeDigest,
  verifyReceiptChain,
  verifyReceiptDigest,
  validateReceipt,
  ReceiptChainError,
  SchemaValidationError,
  StageState,
  InvalidTransitionError,
} from '@proofloop/kernel';
import type {
  Finding,
  ReceiptType,
  ReceiptWriterOptions,
  WriteReceiptResult,
  ReceiptDirectoryBinding,
  ReceiptFileBinding,
  BoundedWriteReceiptResult,
  ChainVerificationResult,
} from '@proofloop/kernel';
import type { ReconcileStageResult } from './reconcile';
import type { VNextWorkerAdmissionState } from './vnext/types';
import { reconcileStage } from './reconcile';
import { reduceRuntimeAction } from './reducer';
import type { ReconciledStageState, RuntimeAction } from './state-model';
import {
  cvReceiptDir,
  committerReceiptDir,
  integrationReceiptDir,
  planReceiptDir,
  RECEIPT_TYPE_CATEGORY,
  reviewReceiptDir,
  stageGateReceiptDir,
  tasksReceiptDir,
} from './receipt-layout';
import { manifestFileDigest } from './manifest-source';
import { detectPlanManifestRoute } from './plan-services';
import { admitVNextGateResult } from './vnext/gate-admission';
import { assertAdmissionRequest, admissionRequestStageId } from './admission-request';
import type {
  AdmissionRequest,
  SpvResultAdmissionRequest,
  GateResultAdmissionRequest,
  GateInterruptedAdmissionRequest,
} from './admission-request';
import { canonicalPathWithinRoot } from './path-guard';

// ============================================================
// Receipt persistence seam — the ONLY write path (AWI-006)
// ============================================================

/**
 * Persistence port through which the pipeline writes receipts.
 *
 * The default implementation delegates to the kernel ReceiptWriter seams
 * (`writeReceipt` / `verifyReceiptChain`); tests inject a fake port to prove
 * the legacy pipeline never touches the filesystem for persistence on its own.
 * The active vNext `runReceiptAdmission` branch is separate and uses K2
 * `ensureBoundedReceiptDirectory` plus K1 `writeReceiptBounded` when no test
 * port is injected.
 */
export interface ReceiptWriterPort {
  write(data: object, options: ReceiptWriterOptions): WriteReceiptResult;
  verifyChain(receiptDir: string): ChainVerificationResult;
}

/** Default port — kernel ReceiptWriter (temp → fsync → rename → digest verify → chain + lock). */
export const defaultReceiptWriter: ReceiptWriterPort = {
  write: (data, options) => writeReceipt(data, options),
  verifyChain: (receiptDir) => verifyReceiptChain(receiptDir),
};

// ============================================================
// Per-admit steps (wired by S02-E-T02..T04)
// ============================================================

/**
 * Reducer precheck result: accepted → the pipeline proceeds to write the
 * Receipt (nextState is the advanced post-admit state); refused → the
 * pipeline returns the structured rejection WITHOUT writing anything.
 *
 * Accepted variants may additionally carry:
 *   - `findings` — canonical Findings returned alongside the success result
 *     (empty when absent);
 *   - `writeReceipt: false` — a legal branch that advances the state but
 *     MUST NOT write a Receipt (review REPAIR, PO-S02-E-05/06): the
 *     pipeline returns `{ accepted: true, receipt_ref: null }` with the
 *     findings BEFORE any chain access or write.
 */
export type AdmitPrecheckResult =
  | {
      readonly accepted: true;
      readonly nextState: ReconcileStageResult;
      /** Canonical Findings of an accepted admit (empty when absent). */
      readonly findings?: readonly Finding[];
      /** Set to false for legal branches that must NOT write a Receipt. */
      readonly writeReceipt?: boolean;
    }
  | { readonly accepted: false; readonly findings: readonly Finding[] };

/**
 * Canonical Receipt body built by the admit step (version, digest and
 * previous_digest are pipeline/writer-owned: the writer computes the
 * content-addressed digest; the pipeline binds previous_digest to the
 * target category chain tip).
 */
export interface ReceiptBuild {
  /** Kernel canonical 16-type literal — never an open string. */
  readonly type: ReceiptType;
  readonly stage_id: string;
  readonly slice_id?: string;
  readonly timestamp: string;
  readonly payload: Record<string, unknown>;
}

/** Admit-specific steps — the per-operation part of the unified pipeline. */
export interface AdmitPipelineSteps {
  /** Reducer precheck / state advance (T02–T04 fill; refuse → no Receipt). */
  precheck(state: ReconcileStageResult): AdmitPrecheckResult;
  /** Construct the canonical Receipt body bound to type/stage/slice/payload. */
  buildReceipt(state: ReconcileStageResult): ReceiptBuild;
  /** Canonical category directory the receipt is appended to. */
  targetDir(state: ReconcileStageResult): string;
}

// ============================================================
// Pipeline input / output
// ============================================================

export interface AdmitPipelineInput {
  /** Request to admit (schema-validated inside the pipeline — fail closed). */
  readonly request: AdmissionRequest;
  /** Deterministic current-state source (reconcileStage for real callers). */
  readonly reconcile: (stageId: string) => ReconcileStageResult;
  /** Per-admit steps (precheck / receipt build / target directory). */
  readonly steps: AdmitPipelineSteps;
  /** Persistence port — defaults to the kernel ReceiptWriter. */
  readonly writer?: ReceiptWriterPort;
  /**
   * Canonical project root (S3-REVIEW-002). When supplied, the post-write
   * rollback re-verifies the just-written receipt file's canonical path
   * against THIS trust boundary (the stronger S03-A boundary). When absent,
   * the rollback falls back to the category directory the pipeline wrote
   * into (`steps.targetDir`) as the containment boundary.
   */
  readonly projectRoot?: string;
}

/**
 * Unified admit result (AWI-006): accepted flag, the written receipt digest
 * (null when refused), the post-admit state and the canonical Findings.
 *
 * `new_state` is null only when the request was rejected BEFORE
 * reconciliation (schema failure) — for every post-reconcile result it is
 * the current (or advanced) state.
 */
export interface AdmitResult<TVNextState extends object = VNextWorkerAdmissionState> {
  readonly accepted: boolean;
  readonly receipt_ref: string | null;
  /** Legacy reconcile projection; vNext admissions use `vnext_state`. */
  readonly new_state: ReconcileStageResult | null;
  /** Additive vNext fact projection; never interpreted as legacy state. */
  readonly vnext_state?: TVNextState;
  readonly findings: readonly Finding[];
}

// ============================================================
// Unified admit pipeline
// ============================================================

/** Structured rejection builder — canonical Finding + no Receipt ref. */
function reject(
  code: Finding['code'],
  message: string,
  newState: ReconcileStageResult | null,
): AdmitResult {
  return {
    accepted: false,
    receipt_ref: null,
    new_state: newState,
    findings: [{ code, severity: 'error', message }],
  };
}

/** Rejection helper for the additive vNext state projection. */
function rejectVNext<TVNextState extends object = VNextWorkerAdmissionState>(
  code: Finding['code'],
  message: string,
): AdmitResult<TVNextState> {
  return reject(code, message, null) as AdmitResult<TVNextState>;
}

/** Human-readable chain failure detail from a kernel verification result. */
function chainFailureDetail(result: ChainVerificationResult): string {
  if (result.brokenLink) {
    return (
      `broken link at index ${result.brokenLink.index}: ` +
      `expected ${result.brokenLink.expected}, got ${result.brokenLink.actual}`
    );
  }
  if (result.duplicateDigests && result.duplicateDigests.length > 0) {
    return `duplicate digests: ${result.duplicateDigests.map((d) => d.digest).join(', ')}`;
  }
  return 'chain verification failed';
}

// ============================================================
// Post-write rollback (S3-REVIEW-002 / OUT-S3-04)
// ============================================================

/**
 * Outcome of a post-write rollback attempt.
 *
 * `ok: true` — the just-written receipt was deleted (or was already gone);
 * the reject below is then semantically equivalent to "no Receipt written".
 * `ok: false` — the rollback did NOT complete; `reason` explains why
 * (path-escape / digest-identity mismatch / category swap / successor
 * reference / IO failure). The reject MUST then honestly declare the
 * residual persisted receipt.
 */
export type ReceiptRollbackResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Documented test-only hooks for the post-write rollback (round-2/3, following
 * the S03-A `beforeDirOpen` pattern). Production callers never pass them;
 * tests use them to deterministically inject a concurrent parent swap / a
 * concurrent successor at the exact TOCTOU windows:
 *
 *  - `beforeDirOpen`: called immediately AFTER the containment check + the
 *    expected category dev/ino capture and IMMEDIATELY BEFORE the category
 *    dirfd is opened — a parent swap injected here is caught by the dirfd
 *    dev/ino cross-check (the opened fd fstats to a different inode);
 *  - `beforeUnlink` (round-3): called immediately AFTER the first chain-tip
 *    check and IMMEDIATELY BEFORE the last-moment tip re-validation (which
 *    runs immediately before the unlink). A successor receipt appended here
 *    (referencing this run's receipt) must be caught by the last-moment
 *    re-validation → the rollback SKIPS the delete and the reject honestly
 *    declares the successor reference (never break a successor chain).
 */
export interface RollbackTestHooks {
  readonly beforeDirOpen?: () => void;
  readonly beforeUnlink?: () => void;
}

/** True when `/proc/self/fd/<dirfd>` is usable for fd-relative operations. */
function procSelfFdReachable(dirfd: number): boolean {
  try {
    fs.realpathSync(`/proc/self/fd/${dirfd}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Counterexample 2 (concurrent successor): only delete this run's receipt
 * when it is STILL the current category chain tip — i.e. no other receipt in
 * the category references it as `previous_digest`. Deleting a referenced
 * predecessor would break the successor's chain. Reads the category through
 * the bound dirfd (`/proc/self/fd/<fd>`) when available, else the lexical
 * category path. Returns false (fail closed — never delete) when the category
 * cannot be read or the receipt is referenced as a predecessor.
 */
function isStillChainTip(
  categoryPath: string,
  ourDigest: string,
  procAvailable: boolean,
): boolean {
  let entries: string[];
  try {
    entries = procAvailable
      ? fs.readdirSync(`${categoryPath}/`)
      : fs.readdirSync(categoryPath);
  } catch {
    return false;
  }
  const digests = new Set<string>();
  const referenced = new Set<string>();
  for (const file of entries.filter((f) => f.endsWith('.json')).sort()) {
    const p = procAvailable ? `${categoryPath}/${file}` : path.join(categoryPath, file);
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
        digest?: unknown;
        previous_digest?: unknown;
      };
      if (typeof parsed.digest === 'string' && parsed.digest.length > 0) {
        digests.add(parsed.digest);
      }
      if (typeof parsed.previous_digest === 'string' && parsed.previous_digest.length > 0) {
        referenced.add(parsed.previous_digest);
      }
    } catch {
      // Unreadable entries are the (failed) post-write verify's concern; the
      // tip decision only needs the readable graph.
    }
  }
  return digests.has(ourDigest) && !referenced.has(ourDigest);
}

/**
 * Round-3/4 last-moment tip + identity re-validation (counterexamples
 * S3-B-RECHECK-ROLLBACK-TIP-TOCTOU-001 and S3-REVIEW-004): a successor can be
 * appended AFTER `isStillChainTip()` returns true but BEFORE `fs.unlinkSync()`,
 * and the rollback target can be replaced by a symlink pointing at a
 * PRE-EXISTING, content-identical, SAME-DIGEST receipt elsewhere.
 *
 * Immediately before the unlink, re-confirm THROUGH THE SAME BOUND DIRFD that:
 *   (b) the file at our path still exists with our digest (a file swap /
 *       removal since the identity check → never delete a foreign file),
 *   (c) the file is the ORIGINAL inode THIS run wrote — its dev/ino still
 *       equals the identity captured right after `writer.write`, the entry
 *       basename equals the captured ORIGINAL basename (a post-capture rename
 *       plus same-inode replacement under a DIFFERENT basename is caught), and
 *       the link count is unchanged (a same-inode HARDLINK under a different
 *       basename increments nlink and is caught), and
 *   (a) this run's receipt is STILL the category chain tip (no successor
 *       references it).
 * If any changed → `ok:false` with the honest reason; the caller SKIPS the
 * delete (never break a successor chain, never delete a foreign, pre-existing,
 * or same-inode/different-basename receipt) and the reject honestly declares it.
 *
 * The double-check narrows the window to the microsecond between this
 * re-validation and the unlink itself. That remaining check-then-act window is
 * a Node/OS inherent limitation under a malicious-concurrency attacker model
 * (atomic compare-and-delete does not exist in Node; the kernel ReceiptWriter
 * lock is kernel-owned and out of scope) — recorded honestly as the residual
 * window (same convergence precedent as S03-A PO-S03-A-03).
 */
function revalidateRollbackTarget(
  categoryPath: string,
  opPath: string,
  ourDigest: string,
  procAvailable: boolean,
  writtenFileIdentity?: {
    dev: number;
    ino: number;
    name: string;
    nlink: number;
  } | null,
): ReceiptRollbackResult {
  // (b) the file at our path still exists with our digest.
  let storedDigest: string | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(opPath, 'utf-8')) as {
      digest?: unknown;
    };
    storedDigest = typeof parsed.digest === 'string' ? parsed.digest : null;
  } catch {
    storedDigest = null;
  }
  if (storedDigest !== ourDigest || !verifyReceiptDigest(opPath)) {
    return {
      ok: false,
      reason: `digest identity mismatch (file at ${opPath} is not this run's receipt)`,
    };
  }
  // (c) ORIGINAL-IDENTITY (S3-REVIEW-004 round-4/5): the entry at our path must
  //     STILL be the file THIS run wrote — same dev/ino (a symlink to a
  //     PRE-EXISTING same-digest receipt elsewhere has a different inode), the
  //     ORIGINAL basename (a post-capture rename + same-inode replacement under
  //     a DIFFERENT basename fails the canonical-path basename), and the same
  //     link count (a same-inode HARDLINK under a different basename
  //     increments nlink). ANY mismatch → never delete.
  if (writtenFileIdentity === null || writtenFileIdentity === undefined) {
    return {
      ok: false,
      reason:
        'rollback skipped: target identity mismatch — a pre-existing receipt may be present ' +
        '(write-time identity was not captured)',
    };
  }
  try {
    const st = fs.lstatSync(opPath);
    const entryBasename = path.basename(opPath);
    if (
      st.dev !== writtenFileIdentity.dev ||
      st.ino !== writtenFileIdentity.ino ||
      entryBasename !== writtenFileIdentity.name ||
      st.nlink !== writtenFileIdentity.nlink
    ) {
      return {
        ok: false,
        reason:
          'rollback skipped: target identity mismatch — a pre-existing receipt may be present',
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `rollback skipped: target identity cannot be verified before delete — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // (a) still the category chain tip.
  if (!isStillChainTip(categoryPath, ourDigest, procAvailable)) {
    return {
      ok: false,
      reason:
        'rollback skipped because a successor receipt now references the chain ' +
        '(receipt is no longer the category chain tip); the successor chain is preserved',
    };
  }
  return { ok: true };
}

/**
 * Roll back the receipt written by THIS run when the post-write chain
 * verification fails (S3-REVIEW-002: chain failure → 不写 Receipt — a reject
 * must not leave the just-written Receipt file on disk).
 *
 * Safety contract (round-3, closing the recheck counterexamples):
 *   1. CONTAINMENT — the file is deleted ONLY when its canonical realpath
 *      stays inside the trust boundary. `boundaryRoot` is the caller-supplied
 *      project root when provided (the stronger S03-A boundary), else the
 *      category directory this run wrote into. The S03-A component-wise
 *      realpath walk (`canonicalPathWithinRoot`) rejects a lexical escape.
 *   2. DIRFD BINDING (counterexample 1 — deletion TOCTOU): the deletion is
 *      bound to the VERIFIED category DIRECTORY inode (S03-A dirfd
 *      precedent): the category is opened as a dirfd
 *      (`O_RDONLY | O_DIRECTORY | O_NOFOLLOW`), its fstat dev/ino is
 *      cross-checked against the pre-captured identity (a parent swap between
 *      capture and open fails closed), and every read + the unlink go through
 *      `/proc/self/fd/<fd>/<name>` — a parent rename/swap AFTER the open
 *      cannot redirect the unlink (the fd keeps the inode binding). When
 *      `/proc/self/fd` is unavailable the rollback falls back to path-based
 *      operations plus a per-operation parent identity re-verification
 *      immediately before the unlink (honest residual window documented).
 *   3. IDENTITY — the file is deleted ONLY when it is a self-consistent
 *      receipt (`verifyReceiptDigest`) whose stored digest equals
 *      `writeResult.digest`. A missing file is treated as success (nothing to
 *      roll back); a present-but-unverifiable / digest-mismatched file is
 *      NEVER deleted (never remove someone else's receipt).
 *   4. TIP CHECK (counterexample 2 — concurrent successor): the file is
 *      deleted ONLY when this run's receipt is STILL the current category
 *      chain tip — no successor receipt references it as predecessor. If a
 *      successor exists, the rollback SKIPS the delete (never break a
 *      successor chain) and the reject honestly declares it.
 *   5. LAST-MOMENT RE-VALIDATION (round-3/4, counterexamples
 *      S3-B-RECHECK-ROLLBACK-TIP-TOCTOU-001 + S3-REVIEW-004): a successor can
 *      be appended between the first tip check and the unlink, and the target
 *      can be replaced by a symlink to a pre-existing same-digest receipt.
 *      Immediately before the unlink the digest, the ORIGINAL inode identity
 *      (dev/ino captured right after write) and the chain tip are re-confirmed
 *      THROUGH THE SAME BOUND DIRFD; if any changed the delete is SKIPPED with
 *      the honest declaration. This narrows the window to the microsecond
 *      between the re-validation and the unlink itself (Node/OS inherent
 *      check-then-act window under a malicious-concurrency attacker model).
 *   6. ORIGINAL-IDENTITY PRESERVATION (S3-REVIEW-004): the pipeline captures
 *      the just-written file's dev/ino, ORIGINAL basename and link count
 *      immediately after `writer.write` returns; the rollback never deletes an
 *      entry whose dev/ino, basename or nlink differ (a symlink-replaced
 *      pre-existing same-digest receipt, a renamed same-inode entry reached
 *      under a different basename, or a same-inode hardlink is never deleted).
 *   7. The rollback targets ONLY the digest-verified file from THIS run — no
 *      other receipt in the category directory is ever touched.
 */
function rollbackWrittenReceipt(
  writeResult: WriteReceiptResult,
  targetDir: string,
  projectRoot: string | undefined,
  testHooks?: RollbackTestHooks,
  writtenFileIdentity?: {
    dev: number;
    ino: number;
    name: string;
    nlink: number;
  } | null,
): ReceiptRollbackResult {
  const boundaryRoot = projectRoot ?? targetDir;
  const canonicalFile = canonicalPathWithinRoot(boundaryRoot, writeResult.path);
  if (canonicalFile === null) {
    return {
      ok: false,
      reason: `canonical path escapes the trust boundary: ${writeResult.path}`,
    };
  }
  const name = path.basename(canonicalFile);
  const canonicalParent = path.dirname(canonicalFile);

  // Expected identity of the category directory captured BEFORE the dirfd
  // open (S03-A precedent): the opened fd must fstat to this dev/ino — a
  // parent swap between capture and open is detected and fails closed.
  let expected: fs.Stats | null = null;
  try {
    expected = fs.statSync(canonicalParent);
  } catch (err) {
    return {
      ok: false,
      reason: `category directory unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Documented test-only seam: inject a parent swap here — the dirfd dev/ino
  // cross-check must catch it (fail closed, never delete outside).
  testHooks?.beforeDirOpen?.();

  let dirfd: number;
  try {
    dirfd = fs.openSync(
      canonicalParent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
  } catch (err) {
    return {
      ok: false,
      reason: `cannot open category directory for rollback: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    const st = fs.fstatSync(dirfd);
    if (st.dev !== expected.dev || st.ino !== expected.ino) {
      return {
        ok: false,
        reason:
          'category directory was swapped between verification and open (dev/ino mismatch); ' +
          'refusing to delete outside the trust boundary',
      };
    }

    // /proc/self/fd mechanism (Linux): all reads and the unlink bind to the
    // opened inode — a parent rename/swap AFTER the open cannot redirect any
    // operation (the fd keeps the inode binding). When /proc/self/fd is
    // unavailable the rollback falls back to path-based operations plus a
    // per-operation parent identity re-verification immediately before the
    // unlink (honest residual window documented).
    const procAvailable = procSelfFdReachable(dirfd);
    const opPath = procAvailable ? `/proc/self/fd/${dirfd}/${name}` : canonicalFile;
    const categoryPath = procAvailable ? `/proc/self/fd/${dirfd}` : targetDir;

    // Already gone → nothing to roll back (equivalent to "no receipt written").
    let present = true;
    try {
      fs.lstatSync(opPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') present = false;
    }
    if (!present) {
      return { ok: true };
    }

    // Identity: only delete the digest-verified file from THIS run.
    let storedDigest: string | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(opPath, 'utf-8')) as {
        digest?: unknown;
      };
      storedDigest = typeof parsed.digest === 'string' ? parsed.digest : null;
    } catch {
      storedDigest = null;
    }
    if (storedDigest !== writeResult.digest || !verifyReceiptDigest(opPath)) {
      return {
        ok: false,
        reason: `digest identity mismatch (file at ${opPath} is not this run's receipt)`,
      };
    }

    // Tip check (counterexample 2): never delete a receipt a successor now
    // references — that would break the successor's chain.
    if (!isStillChainTip(categoryPath, writeResult.digest, procAvailable)) {
      return {
        ok: false,
        reason:
          'rollback skipped because a successor receipt now references the chain ' +
          '(receipt is no longer the category chain tip); the successor chain is preserved',
      };
    }

    // Round-3 last-moment re-validation (counterexample
    // S3-B-RECHECK-ROLLBACK-TIP-TOCTOU-001): a successor can be appended
    // between the first tip check and the unlink. Re-confirm THROUGH THE SAME
    // BOUND DIRFD immediately before the unlink that (a) our receipt is still
    // the chain tip and (b) our file still exists with our digest. If the tip
    // or the file changed → SKIP the delete with the honest declaration (never
    // break a successor chain, never delete a foreign file).
    // Documented test-only seam: inject a successor here — the last-moment
    // re-validation must catch it (delete skipped, honest declaration present).
    testHooks?.beforeUnlink?.();
    const lastMoment = revalidateRollbackTarget(
      categoryPath,
      opPath,
      writeResult.digest,
      procAvailable,
      writtenFileIdentity,
    );
    if (!lastMoment.ok) {
      return lastMoment;
    }

    // Fallback path (no /proc/self/fd): re-verify the parent identity
    // immediately before the unlink (check-then-use residual window).
    if (!procAvailable) {
      try {
        const now = fs.statSync(canonicalParent);
        if (now.dev !== expected.dev || now.ino !== expected.ino) {
          return {
            ok: false,
            reason:
              'category directory identity changed before delete (dev/ino mismatch); ' +
              'refusing to delete outside the trust boundary',
          };
        }
      } catch (err) {
        return {
          ok: false,
          reason: `category directory unreadable before delete: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    try {
      fs.unlinkSync(opPath);
    } catch (err) {
      return {
        ok: false,
        reason: `delete failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } finally {
    try {
      fs.closeSync(dirfd);
    } catch {
      // best-effort
    }
  }
  return { ok: true };
}

/**
 * Existence-gate attribution (PO-S03-H-05).
 *
 * A `DOMAIN.STAGE_NOT_FOUND` finding is either the manifest-declaration
 * branch (reconcile emits `manifest source unavailable for stage "…"` when
 * the manifest is missing / unreadable / stage_id-mismatched) or a
 * non-manifest branch (receipts referencing an unknown stage / slice, or an
 * unknown slice directory). Each finding is attributed to its concrete
 * source and the ORIGINAL finding content is carried in the message — never
 * a blanket "not declared in the manifest" for a receipt-sourced failure.
 */
function stageNotFoundAttribution(
  stageId: string,
  findings: readonly Finding[],
): string {
  const lines: string[] = [];
  let manifestBranch = false;
  for (const f of findings) {
    if (f.message.startsWith('manifest source unavailable for stage')) {
      manifestBranch = true;
      lines.push(
        `stage "${stageId}" is not declared in the manifest (manifest missing or stage_id mismatch): ${f.message}`,
      );
      continue;
    }
    let source: string;
    if (f.message.includes('references unknown stage')) {
      source = 'receipt references an unknown stage';
    } else if (f.message.includes('references unknown slice')) {
      source = 'receipt references an unknown slice';
    } else if (f.message.startsWith('receipts reference unknown slice')) {
      source = 'receipts reference an unknown slice directory';
    } else {
      source = 'other DOMAIN.STAGE_NOT_FOUND source';
    }
    lines.push(`stage "${stageId}" admit refused — ${source}: ${f.message}`);
  }
  return lines.join('; ');
}

/**
 * Directory scaffolding only — ensures the canonical category directory
 * exists so the kernel ReceiptWriter can atomically write into it. This is
 * NOT a receipt-file write; persistence always goes through the port.
 */
function ensureReceiptDir(receiptDir: string): void {
  fs.mkdirSync(receiptDir, { recursive: true });
}

/**
 * Resolve the chain tip digest of a category directory (deterministic): the
 * unique digest no other receipt references as `previous_digest`. Empty or
 * unreadable directory → undefined (the new receipt becomes genesis); an
 * ambiguous multi-tip directory → undefined (the kernel writer's own
 * fork/tip validation still guards the append). Reads only — never writes.
 */
function resolveCategoryChainTip(receiptDir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(receiptDir);
  } catch {
    return undefined;
  }
  const files = entries.filter((f) => f.endsWith('.json')).sort();
  const digests = new Set<string>();
  const referenced = new Set<string>();
  for (const file of files) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(receiptDir, file), 'utf-8'),
      ) as { digest?: unknown; previous_digest?: unknown };
      if (typeof parsed.digest === 'string' && parsed.digest.length > 0) {
        digests.add(parsed.digest);
      }
      if (typeof parsed.previous_digest === 'string' && parsed.previous_digest.length > 0) {
        referenced.add(parsed.previous_digest);
      }
    } catch {
      // Unreadable / invalid files are caught by the pre-write chain check
      // (writer.verifyChain) — this tip scan skips them deterministically.
    }
  }
  const tips = [...digests].filter((d) => !referenced.has(d)).sort();
  return tips.length === 1 ? tips[0] : undefined;
}

interface RuntimeAdmissionLock {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly nlink: number;
}

/**
 * Runtime idempotency lock for receipt-only admissions.
 *
 * The kernel writer serializes writes, but its lock is intentionally private
 * to the writer call.  A vNext action-token duplicate check must cover the
 * read/check/build/write interval as one admission transaction; otherwise two
 * processes can both observe an empty chain and append two genesis receipts.
 * This lock is exclusive-create, fail-closed (including stale locks), and is
 * removed only when the original inode is still owned by this admission.
 */
function admissionLockPath(targetDir: string, admissionKey: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${targetDir}\u0000${admissionKey}`, 'utf8')
    .digest('hex');
  // Keep this ephemeral coordination file outside `.proofloop/receipts`; the
  // vNext changed-file/protected-path validator must never mistake it for a
  // candidate artifact or Receipt.
  return path.join(os.tmpdir(), `proofloop-runtime-admission-${digest}.lock`);
}

function removeAdmissionLockIfOwned(
  lockPath: string,
  identity: { readonly dev: number; readonly ino: number; readonly nlink: number } | null,
): void {
  if (identity === null) return;
  try {
    const current = fs.lstatSync(lockPath);
    if (
      current.dev === identity.dev &&
      current.ino === identity.ino &&
      current.nlink === identity.nlink
    ) {
      fs.rmdirSync(lockPath);
    }
  } catch {
    // Fail closed: an unreadable or replaced lock is left in place.
  }
}

/** Return null when another admission already owns this action key. */
function acquireRuntimeAdmissionLock(
  targetDir: string,
  admissionKey: string,
): RuntimeAdmissionLock | null {
  const lockPath = admissionLockPath(targetDir, admissionKey);
  try {
    fs.mkdirSync(lockPath, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }

  let identity: { dev: number; ino: number; nlink: number } | null = null;
  try {
    const stat = fs.lstatSync(lockPath);
    identity = { dev: stat.dev, ino: stat.ino, nlink: stat.nlink };
    return { path: lockPath, ...identity };
  } catch (error) {
    removeAdmissionLockIfOwned(lockPath, identity);
    throw error;
  }
}

function releaseRuntimeAdmissionLock(lock: RuntimeAdmissionLock): void {
  removeAdmissionLockIfOwned(lock.path, lock);
}

/**
 * The active vNext path is root-bound even when a caller bypasses the Worker
 * validator and invokes this Runtime seam directly.  K1 accepts a root alias
 * so it can canonicalize it for its own internal binding; this Runtime seam is
 * stricter and requires the authority supplied by the caller to already be the
 * canonical absolute path.
 */
function canonicalReceiptProjectRoot(projectRoot: string | undefined): string | null {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) return null;
  const lexical = path.resolve(projectRoot);
  try {
    const canonical = fs.realpathSync(lexical);
    const stat = fs.statSync(canonical);
    if (!stat.isDirectory() || canonical !== lexical) return null;
    return canonical;
  } catch {
    return null;
  }
}

interface BoundedReceiptDirectoryHandle {
  readonly binding: ReceiptDirectoryBinding;
  readonly dirfd: number;
  readonly procPath: string;
}

interface BoundedReceiptEntry {
  readonly name: string;
  readonly receipt: Record<string, unknown>;
  readonly stat: fs.Stats;
}

function isCanonicalPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Re-open a K1 directory binding and make the fd, canonical path, and inode
 * identity agree before any Runtime read or rollback operation.  The fd is
 * the authority for subsequent operations; the raw path is only the locator
 * that is re-verified against that fd and is never used as the delete/read
 * boundary by itself.
 */
function openBoundedReceiptDirectory(
  binding: ReceiptDirectoryBinding,
): BoundedReceiptDirectoryHandle {
  if (
    !path.isAbsolute(binding.rootPath) ||
    !path.isAbsolute(binding.path) ||
    path.resolve(binding.rootPath) !== binding.rootPath ||
    path.resolve(binding.path) !== binding.path
  ) {
    throw new Error('bounded Receipt binding is not canonical and absolute');
  }

  let rootCanonical: string;
  let targetCanonical: string;
  let expected: fs.Stats;
  try {
    rootCanonical = fs.realpathSync(binding.rootPath);
    targetCanonical = fs.realpathSync(binding.path);
    expected = fs.statSync(binding.path);
  } catch (error) {
    throw new Error(
      `bounded Receipt binding cannot be re-opened: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    rootCanonical !== binding.rootPath ||
    targetCanonical !== binding.path ||
    !isCanonicalPathWithinRoot(rootCanonical, targetCanonical) ||
    !expected.isDirectory() ||
    expected.dev !== binding.dev ||
    expected.ino !== binding.ino
  ) {
    throw new Error('bounded Receipt directory binding changed identity or escaped the project root');
  }

  const requiredFlags = [
    fs.constants.O_RDONLY,
    fs.constants.O_DIRECTORY,
    fs.constants.O_NOFOLLOW,
  ];
  if (requiredFlags.some((flag) => typeof flag !== 'number')) {
    throw new Error('bounded Receipt directory capability is unavailable');
  }

  const flags =
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let dirfd: number | undefined;
  try {
    dirfd = fs.openSync(binding.path, flags);
    const actual = fs.fstatSync(dirfd);
    const procPath = `/proc/self/fd/${dirfd}`;
    const procCanonical = fs.realpathSync(procPath);
    const procStat = fs.statSync(procPath);
    if (
      !actual.isDirectory() ||
      actual.dev !== binding.dev ||
      actual.ino !== binding.ino ||
      procCanonical !== binding.path ||
      !procStat.isDirectory() ||
      procStat.dev !== actual.dev ||
      procStat.ino !== actual.ino
    ) {
      throw new Error('bounded Receipt directory fd identity mismatch');
    }
    return { binding, dirfd, procPath };
  } catch (error) {
    if (dirfd !== undefined) {
      try { fs.closeSync(dirfd); } catch { /* best-effort */ }
    }
    throw error;
  }
}

function closeBoundedReceiptDirectory(directory: BoundedReceiptDirectoryHandle): void {
  try { fs.closeSync(directory.dirfd); } catch { /* best-effort */ }
}

/** Read one receipt entry through the already-bound directory fd. */
function readBoundedReceiptEntry(
  directory: BoundedReceiptDirectoryHandle,
  name: string,
): { readonly raw: string; readonly stat: fs.Stats } {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name !== path.basename(name) ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new Error(`unsafe bounded Receipt entry name: ${name}`);
  }

  const filePath = path.join(directory.procPath, name);
  const requiredFlags = [fs.constants.O_RDONLY, fs.constants.O_NOFOLLOW, fs.constants.O_NONBLOCK];
  if (requiredFlags.some((flag) => typeof flag !== 'number')) {
    throw new Error('bounded Receipt file-read capability is unavailable');
  }

  const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
  let filefd: number | undefined;
  try {
    filefd = fs.openSync(filePath, flags);
    const stat = fs.fstatSync(filefd);
    if (!stat.isFile()) {
      throw new Error(`bounded Receipt entry is not a regular file: ${name}`);
    }
    return { raw: fs.readFileSync(filefd, 'utf8'), stat };
  } finally {
    if (filefd !== undefined) {
      try { fs.closeSync(filefd); } catch { /* best-effort */ }
    }
  }
}

function parseBoundedReceipt(raw: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ReceiptChainError(
      `bounded Receipt ${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      'chain',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReceiptChainError(`bounded Receipt ${name} is not an object`, 'chain');
  }
  return parsed as Record<string, unknown>;
}

function boundedReceiptContentMatches(receipt: Record<string, unknown>, digest: string): boolean {
  if (receipt.digest !== digest) return false;
  const { digest: _storedDigest, ...content } = receipt;
  try {
    return computeReceiptDigest(content) === digest;
  } catch {
    return false;
  }
}

function boundedRawReceiptContentMatches(raw: string, digest: string, name: string): boolean {
  try {
    return boundedReceiptContentMatches(parseBoundedReceipt(raw, name), digest);
  } catch {
    return false;
  }
}

function readBoundedReceiptEntries(
  directory: BoundedReceiptDirectoryHandle,
): BoundedReceiptEntry[] {
  const names = fs
    .readdirSync(directory.procPath)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const entries: BoundedReceiptEntry[] = [];
  for (const name of names) {
    let entry: { readonly raw: string; readonly stat: fs.Stats };
    try {
      entry = readBoundedReceiptEntry(directory, name);
    } catch (error) {
      if (error instanceof ReceiptChainError) throw error;
      throw new ReceiptChainError(
        `bounded Receipt ${name} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        'chain',
      );
    }
    const receipt = parseBoundedReceipt(entry.raw, name);
    try {
      validateReceipt(receipt);
    } catch (error) {
      throw new ReceiptChainError(
        `bounded Receipt ${name} failed schema validation: ${error instanceof Error ? error.message : String(error)}`,
        'chain',
      );
    }
    const digest = receipt.digest;
    if (
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !boundedReceiptContentMatches(receipt, digest)
    ) {
      throw new ReceiptChainError(
        `bounded Receipt ${name} has an invalid self-digest`,
        'self_digest',
        typeof digest === 'string' ? digest : undefined,
      );
    }
    entries.push({ name, receipt, stat: entry.stat });
  }
  return entries;
}

/** Resolve the category tip without ever reading through the raw target path. */
function resolveBoundedCategoryChainTip(
  binding: ReceiptDirectoryBinding,
): string | undefined {
  const directory = openBoundedReceiptDirectory(binding);
  try {
    const entries = readBoundedReceiptEntries(directory);
    const digests = new Set<string>();
    const referenced = new Set<string>();
    for (const entry of entries) {
      const digest = entry.receipt.digest;
      if (typeof digest === 'string') digests.add(digest);
      const previous = entry.receipt.previous_digest;
      if (typeof previous === 'string' && previous.length > 0) referenced.add(previous);
    }
    const tips = [...digests].filter((digest) => !referenced.has(digest)).sort();
    return tips.length === 1 ? tips[0] : undefined;
  } finally {
    closeBoundedReceiptDirectory(directory);
  }
}

function boundedReceiptFileIdentityMatches(
  entry: fs.Stats,
  expected: ReceiptFileBinding,
): boolean {
  return (
    !entry.isSymbolicLink() &&
    entry.isFile() &&
    entry.dev === expected.dev &&
    entry.ino === expected.ino &&
    entry.nlink === expected.nlink &&
    (expected.size === undefined || entry.size === expected.size)
  );
}

/**
 * Read back the bounded writer result without creating a new ownership
 * snapshot.  `receiptFile` is captured by K1 immediately after install; the
 * current entry identity is only compared against that writer-time binding.
 */
function readBoundedReceiptResult(result: BoundedWriteReceiptResult): void {
  const binding = result.boundDirectory;
  if (!/^[a-f0-9]{64}$/.test(result.digest)) {
    throw new Error('bounded Receipt writer returned an invalid digest');
  }
  const name = `${result.digest}.json`;
  const receiptFile = result.receiptFile;
  if (
    receiptFile === undefined ||
    receiptFile.name !== name ||
    receiptFile.name !== path.basename(receiptFile.name)
  ) {
    throw new Error('bounded Receipt writer returned no matching writer-time Receipt identity');
  }
  const expectedPath = path.join(binding.path, name);
  if (result.path !== expectedPath) {
    throw new Error(
      `bounded Receipt writer returned a non-canonical path: ${result.path}`,
    );
  }

  const directory = openBoundedReceiptDirectory(binding);
  try {
    const entry = readBoundedReceiptEntry(directory, name);
    const receipt = parseBoundedReceipt(entry.raw, name);
    if (!boundedReceiptContentMatches(receipt, result.digest)) {
      throw new Error(`bounded Receipt readback digest mismatch: ${result.path}`);
    }
    if (!boundedReceiptFileIdentityMatches(entry.stat, receiptFile)) {
      throw new Error(
        `bounded Receipt readback entry identity differs from the writer-time binding: ${result.path}`,
      );
    }
  } finally {
    closeBoundedReceiptDirectory(directory);
  }
}

interface BoundedChainTipCheck {
  readonly present: boolean;
  readonly reason?: string;
}

function boundedChainTipStillPresent(
  directory: BoundedReceiptDirectoryHandle,
  digest: string,
): BoundedChainTipCheck {
  try {
    const names = fs.readdirSync(directory.procPath);
    // A symlink anywhere in the bound category is an unsafe successor/entry,
    // even when it does not carry a `.json` suffix.  Do not let an lstat or
    // directory-entry race turn an unknown entry into a safe tip decision.
    for (const name of names) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(path.join(directory.procPath, name));
      } catch (error) {
        return {
          present: false,
          reason:
            `rollback skipped because bounded chain entry ${name} could not be safely inspected: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (stat.isSymbolicLink()) {
        return {
          present: false,
          reason:
            `rollback skipped because bounded chain entry ${name} is a symlink and its ownership cannot be safely verified`,
        };
      }
    }

    const entries = readBoundedReceiptEntries(directory);
    const digests = new Set(entries.map((entry) => entry.receipt.digest as string));
    const referenced = new Set(
      entries
        .map((entry) => entry.receipt.previous_digest)
        .filter((previous): previous is string => typeof previous === 'string' && previous.length > 0),
    );
    if (!digests.has(digest)) {
      return {
        present: false,
        reason: 'rollback skipped because the bounded Receipt is no longer present in the chain',
      };
    }
    if (referenced.has(digest)) {
      return {
        present: false,
        reason:
          'rollback skipped because a successor Receipt now references the bounded chain',
      };
    }
    return { present: true };
  } catch (error) {
    return {
      present: false,
      reason:
        'rollback skipped because bounded chain entries could not be safely read; ' +
        `the residual Receipt was retained: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Verify a category chain through one K1-bound fd, never through the raw path. */
function verifyBoundedReceiptChain(
  binding: ReceiptDirectoryBinding,
): ChainVerificationResult {
  let directory: BoundedReceiptDirectoryHandle;
  try {
    directory = openBoundedReceiptDirectory(binding);
  } catch (error) {
    return {
      valid: false,
      receipts: [],
      brokenLink: {
        index: 0,
        expected: '(bound-directory)',
        actual: error instanceof Error ? error.message : String(error),
      },
    };
  }

  try {
    let entries: BoundedReceiptEntry[];
    try {
      entries = readBoundedReceiptEntries(directory);
    } catch (error) {
      return {
        valid: false,
        receipts: [],
        brokenLink: {
          index: 0,
          expected: '(bound-receipt)',
          actual: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (entries.length === 0) return { valid: true, receipts: [] };

    const byDigest = new Map<string, BoundedReceiptEntry>();
    const filesByDigest = new Map<string, string[]>();
    for (const entry of entries) {
      const digest = entry.receipt.digest as string;
      const files = filesByDigest.get(digest) ?? [];
      files.push(entry.name);
      filesByDigest.set(digest, files);
      if (!byDigest.has(digest)) byDigest.set(digest, entry);
    }

    const duplicateDigests = [...filesByDigest.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([digest, names]) => ({
        digest,
        paths: names.map((name) => path.join(binding.path, name)),
      }));

    let brokenLink: { index: number; expected: string; actual: string } | undefined;
    for (const entry of byDigest.values()) {
      const previous = entry.receipt.previous_digest;
      if (
        previous !== undefined &&
        previous !== null &&
        previous !== '' &&
        !byDigest.has(String(previous))
      ) {
        brokenLink = {
          index: 0,
          expected: String(previous),
          actual: '(not found in directory)',
        };
        break;
      }
    }

    const visited = new Set<string>();
    const orderedReceipts: string[] = [];
    const genesis = [...byDigest.entries()]
      .filter(([, entry]) => {
        const previous = entry.receipt.previous_digest;
        return previous === undefined || previous === null || previous === '';
      })
      .map(([digest]) => digest)
      .sort();

    for (const genesisDigest of genesis) {
      if (visited.has(genesisDigest)) continue;
      let current: string | undefined = genesisDigest;
      while (current !== undefined) {
        if (visited.has(current)) {
          if (brokenLink === undefined) {
            brokenLink = {
              index: orderedReceipts.length,
              expected: current,
              actual: '(circular reference)',
            };
          }
          break;
        }
        const entry = byDigest.get(current);
        if (entry === undefined) break;
        visited.add(current);
        orderedReceipts.push(path.join(binding.path, entry.name));
        const next = [...byDigest.entries()]
          .filter(([digest, candidate]) => {
            if (visited.has(digest)) return false;
            return candidate.receipt.previous_digest === current;
          })
          .map(([digest]) => digest)
          .sort();
        current = next[0];
      }
    }

    for (const [digest, entry] of byDigest) {
      if (visited.has(digest)) continue;
      orderedReceipts.push(path.join(binding.path, entry.name));
      if (brokenLink === undefined) {
        const previous = entry.receipt.previous_digest;
        brokenLink = {
          index: orderedReceipts.length - 1,
          expected: typeof previous === 'string' ? previous : '(genesis)',
          actual: byDigest.has(String(previous))
            ? '(orphan — not reachable from genesis)'
            : '(not found in directory)',
        };
      }
    }

    return {
      valid: brokenLink === undefined && duplicateDigests.length === 0,
      receipts: orderedReceipts,
      brokenLink,
      duplicateDigests: duplicateDigests.length > 0 ? duplicateDigests : undefined,
    };
  } finally {
    closeBoundedReceiptDirectory(directory);
  }
}

/**
 * Roll back a bounded write through the returned directory binding only.  No
 * raw category path is used as the authority for the read, tip check, or
 * unlink.  A missing file is already equivalent to a successful rollback;
 * every present file must match the writer result and the original inode
 * identity before it can be removed.
 */
function rollbackBoundedReceipt(
  result: BoundedWriteReceiptResult,
  testHooks?: RollbackTestHooks,
): ReceiptRollbackResult {
  const binding = result.boundDirectory;
  const name = `${result.digest}.json`;
  const receiptFile = result.receiptFile;
  if (result.path !== path.join(binding.path, name)) {
    return { ok: false, reason: `bounded Receipt result path is not canonical: ${result.path}` };
  }
  if (
    receiptFile === undefined ||
    receiptFile.name !== name ||
    receiptFile.name !== path.basename(receiptFile.name)
  ) {
    return {
      ok: false,
      reason:
        'rollback skipped: bounded Receipt writer-time identity is missing or does not match the result path',
    };
  }

  testHooks?.beforeDirOpen?.();

  let directory: BoundedReceiptDirectoryHandle;
  try {
    directory = openBoundedReceiptDirectory(binding);
  } catch (error) {
    return {
      ok: false,
      reason: `bounded Receipt directory could not be re-opened: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    let first: { readonly raw: string; readonly stat: fs.Stats };
    try {
      first = readBoundedReceiptEntry(directory, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
      return {
        ok: false,
        reason: `bounded Receipt target cannot be opened for rollback: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!boundedRawReceiptContentMatches(first.raw, result.digest, name)) {
      return {
        ok: false,
        reason: 'rollback skipped: bounded Receipt digest identity mismatch',
      };
    }
    if (!boundedReceiptFileIdentityMatches(first.stat, receiptFile)) {
      return {
        ok: false,
        reason:
          'rollback skipped: bounded Receipt target identity differs from the writer-time binding',
      };
    }
    const firstTip = boundedChainTipStillPresent(directory, result.digest);
    if (!firstTip.present) {
      return { ok: false, reason: firstTip.reason ?? 'rollback skipped: bounded chain tip is not safe to verify' };
    }

    testHooks?.beforeUnlink?.();

    // Last-moment revalidation through the same bound fd.  A parent swap can
    // no longer redirect this path, and a final symlink is rejected by the
    // no-follow open before unlink is attempted.
    let last: { readonly raw: string; readonly stat: fs.Stats };
    try {
      last = readBoundedReceiptEntry(directory, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true };
      return {
        ok: false,
        reason: `rollback skipped: bounded Receipt target changed before unlink: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!boundedRawReceiptContentMatches(last.raw, result.digest, name)) {
      return {
        ok: false,
        reason: 'rollback skipped: bounded Receipt digest changed before unlink',
      };
    }
    if (!boundedReceiptFileIdentityMatches(last.stat, receiptFile)) {
      return {
        ok: false,
        reason:
          'rollback skipped: bounded Receipt target identity changed from the writer-time binding before unlink',
      };
    }
    const lastTip = boundedChainTipStillPresent(directory, result.digest);
    if (!lastTip.present) {
      return { ok: false, reason: lastTip.reason ?? 'rollback skipped: bounded chain tip is not safe to verify' };
    }

    try {
      fs.unlinkSync(path.join(directory.procPath, name));
    } catch (error) {
      return {
        ok: false,
        reason: `bounded Receipt delete failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { ok: true };
  } finally {
    closeBoundedReceiptDirectory(directory);
  }
}

interface WrittenReceiptIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly name: string;
  readonly nlink: number;
}

function captureWrittenReceiptIdentity(filePath: string): WrittenReceiptIdentity | null {
  try {
    const stat = fs.lstatSync(filePath);
    return {
      dev: stat.dev,
      ino: stat.ino,
      name: path.basename(filePath),
      nlink: stat.nlink,
    };
  } catch {
    return null;
  }
}

function receiptReadbackMatches(writeResult: WriteReceiptResult): boolean {
  if (!/^[a-f0-9]{64}$/.test(writeResult.digest)) return false;
  if (!verifyReceiptDigest(writeResult.path)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(writeResult.path, 'utf8')) as {
      digest?: unknown;
    };
    return parsed.digest === writeResult.digest;
  } catch {
    return false;
  }
}

function rejectAfterReceiptVerificationFailure<TVNextState extends object = VNextWorkerAdmissionState>(
  rejected: AdmitResult<TVNextState>,
  writeResult: WriteReceiptResult,
  targetDir: string,
  projectRoot: string | undefined,
  rollbackTestHooks: RollbackTestHooks | undefined,
  writtenFileIdentity?: WrittenReceiptIdentity | null,
): AdmitResult<TVNextState> {
  const rollback = rollbackWrittenReceipt(
    writeResult,
    targetDir,
    projectRoot,
    rollbackTestHooks,
    writtenFileIdentity === undefined
      ? captureWrittenReceiptIdentity(writeResult.path)
      : writtenFileIdentity,
  );
  if (rollback.ok) return rejected;
  return {
    ...rejected,
    findings: [
      ...rejected.findings,
      {
        code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
        severity: 'error',
        message:
          `receipt persisted but post-write verification failed and rollback incomplete: ` +
          `receipt digest ${writeResult.digest} at ${writeResult.path} remains on disk — ` +
          `rollback failed: ${rollback.reason}`,
      },
    ],
  };
}

function rejectAfterBoundedReceiptVerificationFailure<TVNextState extends object = VNextWorkerAdmissionState>(
  rejected: AdmitResult<TVNextState>,
  writeResult: BoundedWriteReceiptResult,
  rollbackTestHooks: RollbackTestHooks | undefined,
): AdmitResult<TVNextState> {
  const rollback = rollbackBoundedReceipt(
    writeResult,
    rollbackTestHooks,
  );
  if (rollback.ok) return rejected;
  return {
    ...rejected,
    findings: [
      ...rejected.findings,
      {
        code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
        severity: 'error',
        message:
          `receipt persisted but bounded post-write verification failed and rollback incomplete: ` +
          `receipt digest ${writeResult.digest} at ${writeResult.path} remains on disk — ` +
          `rollback failed: ${rollback.reason}`,
      },
    ],
  };
}

function canonicalReceiptTempDirectory(
  projectRoot: string,
  targetBinding: ReceiptDirectoryBinding,
  tempDir: string,
): string | null {
  if (typeof tempDir !== 'string' || tempDir.length === 0) return null;
  const lexical = path.isAbsolute(tempDir)
    ? path.resolve(tempDir)
    : path.resolve(projectRoot, tempDir);
  try {
    const canonical = fs.realpathSync(lexical);
    const stat = fs.statSync(canonical);
    if (
      canonical !== lexical ||
      !stat.isDirectory() ||
      !isCanonicalPathWithinRoot(projectRoot, canonical) ||
      stat.dev !== targetBinding.dev ||
      stat.ino !== targetBinding.ino
    ) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

function sameReceiptDirectoryBinding(
  left: ReceiptDirectoryBinding,
  right: ReceiptDirectoryBinding,
): boolean {
  return (
    left.rootPath === right.rootPath &&
    left.path === right.path &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

/**
 * Input for a receipt-only admission branch whose state is not represented by
 * the legacy `ReconcileStageResult` state machine.
 *
 * Validation and state derivation remain the responsibility of the caller; this
 * seam only shares the canonical chain/write/verify/rollback path with the
 * legacy admission pipeline.  In particular, it never fabricates a legacy
 * state in order to persist a vNext fact.
 */
export interface ReceiptAdmissionInput<TVNextState extends object = VNextWorkerAdmissionState> {
  readonly build: ReceiptBuild;
  readonly targetDir: string;
  /** Optional temp directory; bounded default requires it to be the same physical directory. */
  readonly tempDir?: string;
  readonly nextState: TVNextState;
  readonly writer?: ReceiptWriterPort;
  readonly projectRoot?: string;
  /** Exclusive idempotency key held across duplicate-check and writer call. */
  readonly admissionKey?: string;
  /** Final read-only binding check immediately before the writer call. */
  readonly beforeWrite?: () => void;
  /**
   * Final read-only consistency check after the Receipt is installed and its
   * chain is valid, but before the admission returns success. This callback is
   * used only by vNext consumers; a thrown error rolls back this run's Receipt
   * through the writer-time identity/safety seam.
   */
  readonly afterWrite?: (writeResult: WriteReceiptResult) => void;
}

type VNextReceiptAdmissionAction =
  | 'TASK_COMPLETE'
  | 'CV_PASS'
  | 'CV_REPAIR'
  | 'SLICE_COMMIT'
  | 'INTEGRATION'
  | 'GATE'
  | 'STAGE_REVIEW';

const VNEXT_SLICE_COMMIT_FIELDS = new Set([
  'schema_version',
  'type',
  'action',
  'stage_id',
  'slice_id',
  'manifest_digest',
  'plan_digest',
  'proof_index_digest',
  'snapshot_digest',
  'commit_sha',
  'cv_receipt_digest',
  'changed_files',
  'receipt_chain_valid',
]);

const VNEXT_INTEGRATION_FIELDS = new Set([
  'schema_version',
  'type',
  'action',
  'stage_id',
  'slice_id',
  'manifest_digest',
  'plan_digest',
  'proof_index_digest',
  'snapshot_digest',
  'commit_sha',
  'slice_commit_receipt_digest',
  'worker_receipt_digest',
  'cv_receipt_digest',
  'changed_files',
  'receipt_chain_valid',
]);

const VNEXT_GATE_FIELDS = new Set([
  'schema_version',
  'type',
  'action',
  'stage_id',
  'manifest_digest',
  'plan_digest',
  // Legacy field: only present on archived pre-decision Gate Receipts; new
  // Receipts never carry it (the Runtime Proof it bound was deleted).
  'runtime_proof_digest',
  'stage_plan_receipt_digest',
  'spv_receipt_digest',
  'snapshot_digest',
  'verdict',
  'integrated_slices',
  'summary',
  // S09-REVIEW-001: the one-time restricted bootstrap marker (optional; only
  // present on the S09 all-not_applicable Gate Receipt).
  'restricted_bootstrap',
  // S10 backfill (dual-path SG): explicit verification path marker
  // (optional; `receipts` | `git_facts`, absent on pre-decision Receipts).
  'verification_source',
  'receipt_chain_valid',
]);

const VNEXT_REVIEW_FIELDS = new Set([
  'schema_version',
  'type',
  'action',
  'stage_id',
  'manifest_digest',
  'plan_digest',
  // Legacy field: only present on archived pre-decision Review Receipts; new
  // Receipts never carry it (the Runtime Proof it bound was deleted).
  'runtime_proof_digest',
  'stage_plan_receipt_digest',
  'spv_receipt_digest',
  'stage_gate_receipt_digest',
  'snapshot_digest',
  'verdict',
  'summary',
  'receipt_chain_valid',
]);

const VNEXT_SHA256_RE = /^[a-f0-9]{64}$/;
const VNEXT_SNAPSHOT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const VNEXT_GIT_SHA_RE = /^[a-f0-9]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalReceiptSegment(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactClosedFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
  label: string,
): string | null {
  const unknown = Reflect.ownKeys(value).filter(
    (key) => typeof key !== 'string' || !fields.has(key),
  );
  if (unknown.length > 0) {
    return `${label} contains unknown field(s): ${unknown.map(String).join(', ')}`;
  }
  for (const field of fields) {
    if (!hasOwn(value, field)) return `${label}.${field} is required`;
  }
  return null;
}

function canonicalSliceCommitPath(
  projectRoot: string,
  value: unknown,
  label: string,
): string | null {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    path.isAbsolute(value) ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('\u0000')
  ) {
    return `${label} must be a canonical root-relative path string`;
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    return `${label} must be a canonical root-relative path string`;
  }
  const lexical = path.resolve(projectRoot, ...parts);
  const canonical = canonicalPathWithinRoot(projectRoot, lexical);
  if (canonical === null || canonical !== lexical) {
    return `${label} escapes or traverses the project root`;
  }
  return null;
}

function validateVNextSliceCommitRecord(
  value: Record<string, unknown>,
  label: string,
  projectRoot: string,
): string | null {
  const fieldsError = exactClosedFields(value, VNEXT_SLICE_COMMIT_FIELDS, label);
  if (fieldsError !== null) return fieldsError;
  if (value.schema_version !== 2) return `${label}.schema_version must be 2`;
  if (value.type !== 'SLICE_COMMIT_RESULT') {
    return `${label}.type must be SLICE_COMMIT_RESULT`;
  }
  if (value.action !== 'SLICE_COMMIT') return `${label}.action must be SLICE_COMMIT`;
  if (!isCanonicalReceiptSegment(value.stage_id)) {
    return `${label}.stage_id must be a canonical identifier`;
  }
  if (!isCanonicalReceiptSegment(value.slice_id)) {
    return `${label}.slice_id must be a canonical identifier`;
  }
  for (const field of ['manifest_digest', 'plan_digest', 'proof_index_digest', 'cv_receipt_digest']) {
    if (typeof value[field] !== 'string' || !VNEXT_SHA256_RE.test(value[field])) {
      return `${label}.${field} must be a lowercase SHA-256 digest`;
    }
  }
  if (typeof value.snapshot_digest !== 'string' || !VNEXT_SNAPSHOT_RE.test(value.snapshot_digest)) {
    return `${label}.snapshot_digest must be a Git snapshot digest`;
  }
  if (typeof value.commit_sha !== 'string' || !VNEXT_GIT_SHA_RE.test(value.commit_sha)) {
    return `${label}.commit_sha must be a full lowercase Git commit SHA`;
  }
  if (value.receipt_chain_valid !== true) {
    return `${label}.receipt_chain_valid must be true`;
  }
  if (!Array.isArray(value.changed_files)) {
    return `${label}.changed_files must be an array of unique root-relative strings`;
  }
  if (value.changed_files.length === 0) {
    return `${label}.changed_files must not be empty`;
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.changed_files.length; index += 1) {
    const changedFile = value.changed_files[index];
    const pathError = canonicalSliceCommitPath(
      projectRoot,
      changedFile,
      `${label}.changed_files[${index}]`,
    );
    if (pathError !== null) return pathError;
    if (typeof changedFile === 'string') {
      if (seen.has(changedFile)) {
        return `${label}.changed_files contains duplicate entries`;
      }
      seen.add(changedFile);
    }
  }
  return null;
}

function validateVNextIntegrationRecord(
  value: Record<string, unknown>,
  label: string,
  projectRoot: string,
): string | null {
  const fieldsError = exactClosedFields(value, VNEXT_INTEGRATION_FIELDS, label);
  if (fieldsError !== null) return fieldsError;
  if (value.schema_version !== 2) return `${label}.schema_version must be 2`;
  if (value.type !== 'INTEGRATION_RESULT') {
    return `${label}.type must be INTEGRATION_RESULT`;
  }
  if (value.action !== 'INTEGRATION') return `${label}.action must be INTEGRATION`;
  if (!isCanonicalReceiptSegment(value.stage_id)) {
    return `${label}.stage_id must be a canonical identifier`;
  }
  if (!isCanonicalReceiptSegment(value.slice_id)) {
    return `${label}.slice_id must be a canonical identifier`;
  }
  for (const field of [
    'manifest_digest',
    'plan_digest',
    'proof_index_digest',
    'slice_commit_receipt_digest',
    'worker_receipt_digest',
    'cv_receipt_digest',
  ]) {
    if (typeof value[field] !== 'string' || !VNEXT_SHA256_RE.test(value[field])) {
      return `${label}.${field} must be a lowercase SHA-256 digest`;
    }
  }
  if (typeof value.snapshot_digest !== 'string' || !VNEXT_SNAPSHOT_RE.test(value.snapshot_digest)) {
    return `${label}.snapshot_digest must be a Git snapshot digest`;
  }
  if (typeof value.commit_sha !== 'string' || !VNEXT_GIT_SHA_RE.test(value.commit_sha)) {
    return `${label}.commit_sha must be a full lowercase Git commit SHA`;
  }
  if (value.receipt_chain_valid !== true) {
    return `${label}.receipt_chain_valid must be true`;
  }
  if (!Array.isArray(value.changed_files)) {
    return `${label}.changed_files must be an array of unique root-relative strings`;
  }
  if (value.changed_files.length === 0) {
    return `${label}.changed_files must not be empty`;
  }
  const seen = new Set<string>();
  for (let index = 0; index < value.changed_files.length; index += 1) {
    const changedFile = value.changed_files[index];
    const pathError = canonicalSliceCommitPath(
      projectRoot,
      changedFile,
      `${label}.changed_files[${index}]`,
    );
    if (pathError !== null) return pathError;
    if (typeof changedFile === 'string') {
      if (seen.has(changedFile)) {
        return `${label}.changed_files contains duplicate entries`;
      }
      seen.add(changedFile);
    }
  }
  return null;
}

/**
 * Validate the closed Gate state/payload projection (stage-level: no
 * `slice_id` member).  `integrated_slices` must be a non-empty array of
 * closed { slice_id, integration_receipt_digest, commit_sha } entries in
 * deterministic order.
 */
function validateVNextGateRecord(
  value: Record<string, unknown>,
  label: string,
): string | null {
  // S09-REVIEW-001 + dual-path SG: `restricted_bootstrap` and
  // `verification_source` are OPTIONAL members of the closed Gate record;
  // `runtime_proof_digest` is a legacy field tolerated on archived
  // pre-decision Receipts only (the Runtime Proof it bound was deleted) —
  // the required members are checked individually so an executable proof
  // (no marker), the S09 restricted bootstrap (marker present), a
  // pre-decision Receipt (no verification_source) and a dual-path Receipt
  // (verification_source present) all stay closed-valid.
  const unknown = Reflect.ownKeys(value).filter(
    (key) => typeof key !== 'string' || !VNEXT_GATE_FIELDS.has(key),
  );
  if (unknown.length > 0) {
    return `${label} contains unknown field(s): ${unknown.map(String).join(', ')}`;
  }
  for (const field of VNEXT_GATE_FIELDS) {
    if (field === 'restricted_bootstrap') continue;
    if (field === 'verification_source') continue;
    if (field === 'runtime_proof_digest') continue;
    if (!hasOwn(value, field)) return `${label}.${field} is required`;
  }
  if (value.restricted_bootstrap !== undefined && value.restricted_bootstrap !== true) {
    return `${label}.restricted_bootstrap must be true when present`;
  }
  if (
    value.verification_source !== undefined &&
    value.verification_source !== 'receipts' &&
    value.verification_source !== 'git_facts'
  ) {
    return `${label}.verification_source must be "receipts" or "git_facts" when present`;
  }
  if (value.schema_version !== 2) return `${label}.schema_version must be 2`;
  if (value.type !== 'GATE_RESULT') return `${label}.type must be GATE_RESULT`;
  if (value.action !== 'GATE') return `${label}.action must be GATE`;
  if (!isCanonicalReceiptSegment(value.stage_id)) {
    return `${label}.stage_id must be a canonical identifier`;
  }
  for (const field of [
    'manifest_digest',
    'plan_digest',
    'stage_plan_receipt_digest',
    'spv_receipt_digest',
  ]) {
    if (typeof value[field] !== 'string' || !VNEXT_SHA256_RE.test(value[field])) {
      return `${label}.${field} must be a lowercase SHA-256 digest`;
    }
  }
  if (
    value.runtime_proof_digest !== undefined &&
    (typeof value.runtime_proof_digest !== 'string' || !VNEXT_SHA256_RE.test(value.runtime_proof_digest))
  ) {
    return `${label}.runtime_proof_digest must be a lowercase SHA-256 digest when present (legacy field)`;
  }
  if (typeof value.snapshot_digest !== 'string' || !VNEXT_SNAPSHOT_RE.test(value.snapshot_digest)) {
    return `${label}.snapshot_digest must be a Git snapshot digest`;
  }
  if (value.verdict !== 'PASS' && value.verdict !== 'FAIL') {
    return `${label}.verdict must be PASS or FAIL`;
  }
  if (typeof value.summary !== 'string' || value.summary.length === 0) {
    return `${label}.summary must be a non-empty string`;
  }
  if (value.receipt_chain_valid !== true) {
    return `${label}.receipt_chain_valid must be true`;
  }
  if (!Array.isArray(value.integrated_slices) || value.integrated_slices.length === 0) {
    return `${label}.integrated_slices must be a non-empty array of slice bindings`;
  }
  const seenSlices = new Set<string>();
  for (let index = 0; index < value.integrated_slices.length; index += 1) {
    const binding = value.integrated_slices[index];
    const entryLabel = `${label}.integrated_slices[${index}]`;
    if (!isRecord(binding)) return `${entryLabel} must be an object`;
    const bindingFields = new Set(['slice_id', 'integration_receipt_digest', 'commit_sha']);
    const unknownFields = Reflect.ownKeys(binding).filter(
      (key) => typeof key !== 'string' || !bindingFields.has(key),
    );
    if (unknownFields.length > 0) {
      return `${entryLabel} contains unknown field(s): ${unknownFields.map(String).join(', ')}`;
    }
    if (!isCanonicalReceiptSegment(binding.slice_id)) {
      return `${entryLabel}.slice_id must be a canonical identifier`;
    }
    if (seenSlices.has(binding.slice_id)) {
      return `${entryLabel}.slice_id is duplicated`;
    }
    seenSlices.add(binding.slice_id);
    if (typeof binding.integration_receipt_digest !== 'string' || !VNEXT_SHA256_RE.test(binding.integration_receipt_digest)) {
      return `${entryLabel}.integration_receipt_digest must be a lowercase SHA-256 digest`;
    }
    if (typeof binding.commit_sha !== 'string' || !VNEXT_GIT_SHA_RE.test(binding.commit_sha)) {
      return `${entryLabel}.commit_sha must be a full lowercase Git commit SHA`;
    }
  }
  return null;
}

function validateVNextReviewRecord(
  value: Record<string, unknown>,
  label: string,
): string | null {
  // `runtime_proof_digest` is a legacy field tolerated on archived
  // pre-decision Review Receipts only (the Runtime Proof it bound was
  // deleted); every other member is required.
  const unknown = Reflect.ownKeys(value).filter(
    (key) => typeof key !== 'string' || !VNEXT_REVIEW_FIELDS.has(key),
  );
  if (unknown.length > 0) {
    return `${label} contains unknown field(s): ${unknown.map(String).join(', ')}`;
  }
  for (const field of VNEXT_REVIEW_FIELDS) {
    if (field === 'runtime_proof_digest') continue;
    if (!hasOwn(value, field)) return `${label}.${field} is required`;
  }
  if (value.schema_version !== 2) return `${label}.schema_version must be 2`;
  if (value.type !== 'STAGE_REVIEW_RESULT') return `${label}.type must be STAGE_REVIEW_RESULT`;
  if (value.action !== 'STAGE_REVIEW') return `${label}.action must be STAGE_REVIEW`;
  if (!isCanonicalReceiptSegment(value.stage_id)) {
    return `${label}.stage_id must be a canonical identifier`;
  }
  for (const field of [
    'manifest_digest',
    'plan_digest',
    'stage_plan_receipt_digest',
    'spv_receipt_digest',
    'stage_gate_receipt_digest',
  ]) {
    if (typeof value[field] !== 'string' || !VNEXT_SHA256_RE.test(value[field])) {
      return `${label}.${field} must be a lowercase SHA-256 digest`;
    }
  }
  if (
    value.runtime_proof_digest !== undefined &&
    (typeof value.runtime_proof_digest !== 'string' || !VNEXT_SHA256_RE.test(value.runtime_proof_digest))
  ) {
    return `${label}.runtime_proof_digest must be a lowercase SHA-256 digest when present (legacy field)`;
  }
  if (typeof value.snapshot_digest !== 'string' || !VNEXT_SNAPSHOT_RE.test(value.snapshot_digest)) {
    return `${label}.snapshot_digest must be a Git snapshot digest`;
  }
  if (value.verdict !== 'ACCEPTED' && value.verdict !== 'REPAIR') {
    return `${label}.verdict must be ACCEPTED or REPAIR`;
  }
  if (typeof value.summary !== 'string' || value.summary.length === 0) {
    return `${label}.summary must be a non-empty string`;
  }
  if (value.receipt_chain_valid !== true) {
    return `${label}.receipt_chain_valid must be true`;
  }
  return null;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  try {
    return computeDigest(left) === computeDigest(right);
  } catch {
    return false;
  }
}

function bindPayloadField(
  payload: Record<string, unknown>,
  state: Record<string, unknown>,
  action: VNextReceiptAdmissionAction,
  field: string,
  required: boolean,
): string | null {
  const payloadHasField = hasOwn(payload, field);
  const stateHasField = hasOwn(state, field);
  if (!stateHasField) {
    if (required) {
      return `${action} state.${field} is required by the admission binding`;
    }
    return payloadHasField
      ? `${action} payload.${field} has no corresponding state binding`
      : null;
  }
  if (!payloadHasField) {
    return required ? `${action} payload.${field} is required by the state binding` : null;
  }
  if (!sameJsonValue(payload[field], state[field])) {
    return `${action} payload.${field} does not match the admitted state`;
  }
  return null;
}

/**
 * Bind the public vNext Receipt seam before K2 directory creation or any
 * injected writer call.  The generic type parameter is compile-time only, so
 * the runtime must bind the state discriminator, Receipt type, tuple, payload
 * version, and canonical category path as one closed contract.
 */
function vNextReceiptAdmissionBindingError(
  input: {
    readonly build: ReceiptBuild;
    readonly targetDir: string;
    readonly nextState: object;
  },
  projectRoot: string,
): string | null {
  if (!isRecord(input.nextState)) {
    return 'vNext Receipt admission state must be an object';
  }
  const state = input.nextState;
  if (state.schema_version !== 2) {
    return 'vNext Receipt admission state schema_version must be 2';
  }

  let action: VNextReceiptAdmissionAction;
  let receiptType: ReceiptType;
  let category: 'tasks' | 'cv' | 'committer' | 'integration' | 'stage-gate' | 'review';
  switch (state.action) {
    case 'TASK_COMPLETE':
      action = 'TASK_COMPLETE';
      receiptType = 'TASK_COMPLETE';
      category = 'tasks';
      if (Object.prototype.hasOwnProperty.call(state, 'type')) {
        return 'TASK_COMPLETE vNext state must not carry a different type discriminator';
      }
      break;
    case 'CV_PASS':
      action = 'CV_PASS';
      receiptType = 'CV_PASS';
      category = 'cv';
      if (state.type !== 'CV_RESULT' || state.verdict !== 'PASS') {
        return 'CV_PASS vNext state discriminator is not CV_RESULT/PASS';
      }
      break;
    case 'CV_REPAIR':
      action = 'CV_REPAIR';
      receiptType = 'CV_REPAIR';
      category = 'cv';
      if (state.type !== 'CV_RESULT' || state.verdict !== 'REPAIR') {
        return 'CV_REPAIR vNext state discriminator is not CV_RESULT/REPAIR';
      }
      break;
    case 'SLICE_COMMIT':
      action = 'SLICE_COMMIT';
      receiptType = 'SLICE_COMMIT';
      category = 'committer';
      if (state.type !== 'SLICE_COMMIT_RESULT' || state.action !== 'SLICE_COMMIT') {
        return 'SLICE_COMMIT vNext state discriminator is not SLICE_COMMIT_RESULT/SLICE_COMMIT';
      }
      break;
    case 'INTEGRATION':
      action = 'INTEGRATION';
      receiptType = 'INTEGRATION_PASS';
      category = 'integration';
      if (state.type !== 'INTEGRATION_RESULT' || state.action !== 'INTEGRATION') {
        return 'INTEGRATION vNext state discriminator is not INTEGRATION_RESULT/INTEGRATION';
      }
      break;
    case 'GATE':
      action = 'GATE';
      receiptType = state.verdict === 'PASS' ? 'GATE_PASS' : 'GATE_FAIL';
      category = 'stage-gate';
      if (state.type !== 'GATE_RESULT' || state.action !== 'GATE') {
        return 'GATE vNext state discriminator is not GATE_RESULT/GATE';
      }
      if (state.verdict !== 'PASS' && state.verdict !== 'FAIL') {
        return 'GATE vNext state verdict must be PASS or FAIL';
      }
      break;
    case 'STAGE_REVIEW':
      action = 'STAGE_REVIEW';
      receiptType = 'STAGE_REVIEW_PASS';
      category = 'review';
      if (state.type !== 'STAGE_REVIEW_RESULT' || state.action !== 'STAGE_REVIEW') {
        return 'STAGE_REVIEW vNext state discriminator is not STAGE_REVIEW_RESULT/STAGE_REVIEW';
      }
      if (state.verdict !== 'ACCEPTED' && state.verdict !== 'REPAIR') {
        return 'STAGE_REVIEW vNext state verdict must be ACCEPTED or REPAIR';
      }
      break;
    default:
      return `unsupported vNext Receipt admission state action: ${String(state.action)}`;
  }

  const stateStageId = state.stage_id;
  const stateSliceId = state.slice_id;
  if (!isCanonicalReceiptSegment(stateStageId)) {
    return 'vNext Receipt admission state stage_id must be a canonical identifier';
  }
  if (action === 'GATE' || action === 'STAGE_REVIEW') {
    if (stateSliceId !== undefined) {
      return `${action} vNext Receipt admission state must not carry a slice_id (stage-level ${action})`;
    }
  } else if (!isCanonicalReceiptSegment(stateSliceId)) {
    return 'vNext Receipt admission state slice_id must be a canonical identifier';
  }
  if (!isCanonicalReceiptSegment(input.build.stage_id)) {
    return 'vNext Receipt build stage_id must be a canonical identifier';
  }
  if (input.build.stage_id !== stateStageId) {
    return 'vNext Receipt state and build stage_id do not match';
  }
  if (action === 'GATE' || action === 'STAGE_REVIEW') {
    if (input.build.slice_id !== undefined) {
      return `${action} vNext Receipt build must not carry a slice_id (stage-level ${action})`;
    }
  } else {
    if (!isCanonicalReceiptSegment(input.build.slice_id) || input.build.slice_id !== stateSliceId) {
      return 'vNext Receipt state and build slice_id do not match';
    }
  }

  if (input.build.type !== receiptType) {
    return `${action} vNext state does not match Receipt type ${String(input.build.type)}`;
  }
  if (RECEIPT_TYPE_CATEGORY[input.build.type] !== category) {
    return `Receipt type ${input.build.type} is not canonical for category ${category}`;
  }
  if (!isRecord(input.build.payload) || input.build.payload.schema_version !== 2) {
    return 'vNext Receipt payload.schema_version must be 2';
  }

  const payload = input.build.payload;
  if (action === 'SLICE_COMMIT') {
    const stateError = validateVNextSliceCommitRecord(state, 'SLICE_COMMIT state', projectRoot);
    if (stateError !== null) return stateError;
    const payloadError = validateVNextSliceCommitRecord(
      payload,
      'SLICE_COMMIT payload',
      projectRoot,
    );
    if (payloadError !== null) return payloadError;
  }
  if (action === 'INTEGRATION') {
    const stateError = validateVNextIntegrationRecord(state, 'INTEGRATION state', projectRoot);
    if (stateError !== null) return stateError;
    const payloadError = validateVNextIntegrationRecord(
      payload,
      'INTEGRATION payload',
      projectRoot,
    );
    if (payloadError !== null) return payloadError;
  }
  if (action === 'GATE') {
    const stateError = validateVNextGateRecord(state, 'GATE state');
    if (stateError !== null) return stateError;
    const payloadError = validateVNextGateRecord(payload, 'GATE payload');
    if (payloadError !== null) return payloadError;
  }
  if (action === 'STAGE_REVIEW') {
    const stateError = validateVNextReviewRecord(state, 'STAGE_REVIEW state');
    if (stateError !== null) return stateError;
    const payloadError = validateVNextReviewRecord(payload, 'STAGE_REVIEW payload');
    if (payloadError !== null) return payloadError;
  }
  const payloadBindingFields: readonly { readonly field: string; readonly required: boolean }[] = action === 'TASK_COMPLETE'
    ? [
        { field: 'stage_id', required: false },
        { field: 'slice_id', required: false },
        { field: 'task_id', required: true },
        { field: 'mode', required: true },
        { field: 'outcome', required: true },
        { field: 'manifest_digest', required: true },
        { field: 'plan_digest', required: true },
        { field: 'proof_index_digest', required: true },
        { field: 'snapshot_digest', required: true },
        { field: 'context_ref', required: true },
        { field: 'context_digest', required: true },
        { field: 'changed_files', required: true },
      ]
    : action === 'SLICE_COMMIT'
      ? [
        { field: 'type', required: true },
        { field: 'action', required: true },
        { field: 'stage_id', required: true },
        { field: 'slice_id', required: true },
        { field: 'manifest_digest', required: true },
        { field: 'plan_digest', required: true },
        { field: 'proof_index_digest', required: true },
        { field: 'snapshot_digest', required: true },
        { field: 'commit_sha', required: true },
        { field: 'cv_receipt_digest', required: true },
        { field: 'changed_files', required: true },
        { field: 'receipt_chain_valid', required: true },
      ]
      : action === 'INTEGRATION'
        ? [
          { field: 'type', required: true },
          { field: 'stage_id', required: true },
          { field: 'slice_id', required: true },
          { field: 'manifest_digest', required: true },
          { field: 'plan_digest', required: true },
          { field: 'proof_index_digest', required: true },
          { field: 'snapshot_digest', required: true },
          { field: 'commit_sha', required: true },
          { field: 'slice_commit_receipt_digest', required: true },
          { field: 'worker_receipt_digest', required: true },
          { field: 'cv_receipt_digest', required: true },
          { field: 'changed_files', required: true },
          { field: 'receipt_chain_valid', required: true },
        ]
        : action === 'GATE'
          ? [
            { field: 'type', required: true },
            { field: 'stage_id', required: true },
            { field: 'manifest_digest', required: true },
            { field: 'plan_digest', required: true },
            { field: 'stage_plan_receipt_digest', required: true },
            { field: 'spv_receipt_digest', required: true },
            { field: 'snapshot_digest', required: true },
            { field: 'verdict', required: true },
            { field: 'integrated_slices', required: true },
            { field: 'summary', required: true },
            { field: 'receipt_chain_valid', required: true },
          ]
          : action === 'STAGE_REVIEW'
            ? [
              { field: 'type', required: true },
              { field: 'stage_id', required: true },
              { field: 'manifest_digest', required: true },
              { field: 'plan_digest', required: true },
              { field: 'stage_plan_receipt_digest', required: true },
              { field: 'spv_receipt_digest', required: true },
              { field: 'stage_gate_receipt_digest', required: true },
              { field: 'snapshot_digest', required: true },
              { field: 'verdict', required: true },
              { field: 'summary', required: true },
              { field: 'receipt_chain_valid', required: true },
            ]
      : [
        { field: 'type', required: true },
        { field: 'stage_id', required: true },
        { field: 'slice_id', required: true },
        { field: 'verdict', required: true },
        { field: 'verification_type', required: true },
        { field: 'manifest_digest', required: true },
        { field: 'plan_digest', required: true },
        { field: 'proof_index_digest', required: true },
        { field: 'context_ref', required: true },
        { field: 'context_digest', required: true },
        { field: 'snapshot_digest', required: true },
        { field: 'worker_receipt_digest', required: true },
      ];
  for (const { field, required } of payloadBindingFields) {
    const fieldError = bindPayloadField(
      payload,
      state,
      action,
      field,
      required,
    );
    if (fieldError !== null) return fieldError;
  }
  if (action === 'SLICE_COMMIT' && payload.type !== 'SLICE_COMMIT_RESULT') {
    return `${action} payload.type must be SLICE_COMMIT_RESULT`;
  }
  if (action === 'INTEGRATION' && payload.type !== 'INTEGRATION_RESULT') {
    return `${action} payload.type must be INTEGRATION_RESULT`;
  }
  if (action === 'GATE' && payload.type !== 'GATE_RESULT') {
    return `${action} payload.type must be GATE_RESULT`;
  }
  if (action === 'STAGE_REVIEW' && payload.type !== 'STAGE_REVIEW_RESULT') {
    return `${action} payload.type must be STAGE_REVIEW_RESULT`;
  }
  if (
    action !== 'TASK_COMPLETE' &&
    action !== 'SLICE_COMMIT' &&
    action !== 'INTEGRATION' &&
    action !== 'GATE' &&
    action !== 'STAGE_REVIEW' &&
    payload.type !== 'CV_RESULT'
  ) {
    return `${action} payload.type must be CV_RESULT`;
  }
  const actionFieldError = bindPayloadField(payload, state, action, 'action', action === 'SLICE_COMMIT');
  if (actionFieldError !== null) return actionFieldError;

  let expectedTargetDir: string;
  if (category === 'stage-gate') {
    expectedTargetDir = stageGateReceiptDir(projectRoot, stateStageId);
  } else if (category === 'review') {
    expectedTargetDir = reviewReceiptDir(projectRoot, stateStageId);
  } else {
    if (stateSliceId === undefined) {
      return `${action} Receipt slice_id is required for category ${category}`;
    }
    expectedTargetDir = category === 'tasks'
      ? tasksReceiptDir(projectRoot, stateStageId, stateSliceId)
      : category === 'cv'
        ? cvReceiptDir(projectRoot, stateStageId, stateSliceId)
        : category === 'committer'
          ? committerReceiptDir(projectRoot, stateStageId, stateSliceId)
          : integrationReceiptDir(projectRoot, stateStageId, stateSliceId);
  }
  if (
    typeof input.targetDir !== 'string' ||
    !path.isAbsolute(input.targetDir) ||
    path.resolve(input.targetDir) !== expectedTargetDir
  ) {
    return `${action} Receipt targetDir must be the canonical ${category}/${stateStageId}${stateSliceId !== undefined ? `/${stateSliceId}` : ''} directory`;
  }

  return null;
}

/**
 * Persist one already-validated non-legacy admission fact through the Runtime
 * ReceiptWriter seam.  Rejects before `writer.write` leave no Receipt.
 */
export function runReceiptAdmission<TVNextState extends object = VNextWorkerAdmissionState>(
  input: ReceiptAdmissionInput<TVNextState>,
  rollbackTestHooks?: RollbackTestHooks,
): AdmitResult<TVNextState> {
  const boundedDefault = input.writer === undefined;
  const writer = input.writer ?? defaultReceiptWriter;

  // The active vNext path has no safe meaning without the canonical trust
  // root.  This check deliberately runs before K2 scaffolding and before the
  // admission lock so a missing/aliased root cannot cause any filesystem write.
  const projectRoot = canonicalReceiptProjectRoot(input.projectRoot);
  if (projectRoot === null) {
    return rejectVNext<TVNextState>(
      'RUNTIME.SCHEMA_MISMATCH',
      'active vNext Receipt admission requires an existing canonical absolute projectRoot',
    );
  }

  const bindingError = vNextReceiptAdmissionBindingError(input, projectRoot);
  if (bindingError !== null) {
    return rejectVNext<TVNextState>('RUNTIME.SCHEMA_MISMATCH', bindingError);
  }

  // K2 is the only directory-materialization path for this active vNext
  // seam.  It is also deliberately applied when a test injects a fake writer:
  // the fake may replace persistence semantics, but it cannot bypass the
  // production root/target directory gate.
  let targetBinding: ReceiptDirectoryBinding;
  try {
    targetBinding = ensureBoundedReceiptDirectory({
      projectRoot,
      targetDir: input.targetDir,
    });
  } catch (error) {
    return rejectVNext<TVNextState>(
      'RUNTIME.SCHEMA_MISMATCH',
      `bounded Receipt directory admission failed for ${input.targetDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const targetDir = targetBinding.path;
  const requestedTempDir = input.tempDir ?? targetDir;
  const tempDir = canonicalReceiptTempDirectory(
    projectRoot,
    targetBinding,
    requestedTempDir,
  );
  if (tempDir === null) {
    return rejectVNext<TVNextState>(
      'RUNTIME.SCHEMA_MISMATCH',
      `bounded Receipt tempDir is outside, symlinked, or has a different directory identity: ${requestedTempDir}`,
    );
  }

  let admissionLock: RuntimeAdmissionLock | null = null;
  try {
    if (input.admissionKey !== undefined) {
      try {
        admissionLock = acquireRuntimeAdmissionLock(targetDir, input.admissionKey);
      } catch (error) {
        return rejectVNext<TVNextState>(
          'RUNTIME.SCHEMA_MISMATCH',
          `vNext admission lock could not be acquired for ${targetDir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (admissionLock === null) {
        return rejectVNext<TVNextState>(
          'DOMAIN.INVALID_TRANSITION',
          `admission key "${input.admissionKey}" is already in flight or has a stale lock; duplicate admission refused`,
        );
      }
    }

    let previousDigest: string | undefined;
    if (boundedDefault) {
      // Do not call the legacy path-based verifyChain or
      // resolveCategoryChainTip for the bounded default.  K1 performs its own
      // bound-fd chain verification immediately before writing; this read only
      // resolves the predecessor through the K2/K1 directory identity seam.
      try {
        previousDigest = resolveBoundedCategoryChainTip(targetBinding);
      } catch (error) {
        const code =
          error instanceof ReceiptChainError
            ? 'RUNTIME.RECEIPT_CHAIN_BROKEN'
            : 'RUNTIME.SCHEMA_MISMATCH';
        return rejectVNext<TVNextState>(
          code,
          `bounded Receipt chain could not be read in ${targetDir} before admit: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      // Explicit injected ReceiptWriterPort remains the legacy-compatible test
      // seam.  It is reached only after the K2 root/target/temp gate above.
      const preChain = writer.verifyChain(targetDir);
      if (!preChain.valid) {
        return rejectVNext<TVNextState>(
          'RUNTIME.RECEIPT_CHAIN_BROKEN',
          `receipt chain broken in ${targetDir} before admit: ${chainFailureDetail(preChain)}`,
        );
      }
      previousDigest = resolveCategoryChainTip(targetDir);
    }

    const receiptData: Record<string, unknown> = {
      version: 1,
      type: input.build.type,
      stage_id: input.build.stage_id,
      timestamp: input.build.timestamp,
      payload: input.build.payload,
    };
    if (input.build.slice_id !== undefined) receiptData.slice_id = input.build.slice_id;
    if (previousDigest !== undefined) receiptData.previous_digest = previousDigest;

    try {
      input.beforeWrite?.();
    } catch (error) {
      return rejectVNext<TVNextState>(
        'RUNTIME.SCHEMA_MISMATCH',
        `pre-write admission binding check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!boundedDefault) {
      // Keep the injected fake seam, but do not let its call happen after a
      // test-injected target/temp identity swap has invalidated the bounded
      // gate established above.
      try {
        const guard = openBoundedReceiptDirectory(targetBinding);
        closeBoundedReceiptDirectory(guard);
        if (
          canonicalReceiptTempDirectory(projectRoot, targetBinding, tempDir) === null
        ) {
          throw new Error('bounded Receipt tempDir identity changed before injected writer');
        }
      } catch (error) {
        return rejectVNext<TVNextState>(
          'RUNTIME.SCHEMA_MISMATCH',
          `bounded Receipt binding changed before injected writer: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (boundedDefault) {
      let boundedResult: BoundedWriteReceiptResult;
      try {
        boundedResult = writeReceiptBounded(receiptData, {
          projectRoot,
          receiptDir: targetDir,
          tempDir,
        });
      } catch (error) {
        const code =
          error instanceof ReceiptChainError
            ? 'RUNTIME.RECEIPT_CHAIN_BROKEN'
            : 'RUNTIME.SCHEMA_MISMATCH';
        const rejected = rejectVNext<TVNextState>(
          code,
          `writeReceiptBounded failed for ${targetDir}: ${error instanceof Error ? error.message : String(error)}`,
        );

        // K1 owns post-install cleanup.  A failure before a bounded result is
        // returned has no writer-time ReceiptFileBinding for Runtime to use;
        // do not guess a digest path or lstat a possible pre-existing entry.
        return rejected;
      }

      try {
        if (!sameReceiptDirectoryBinding(boundedResult.boundDirectory, targetBinding)) {
          throw new Error('bounded Receipt writer returned a different directory binding');
        }
        readBoundedReceiptResult(boundedResult);
      } catch (error) {
        return rejectAfterBoundedReceiptVerificationFailure<TVNextState>(
          rejectVNext<TVNextState>(
            'RUNTIME.RECEIPT_CHAIN_BROKEN',
            `bounded post-write Receipt readback verification failed for ${boundedResult.path}: ${error instanceof Error ? error.message : String(error)}`,
          ),
          boundedResult,
          rollbackTestHooks,
        );
      }

      // Preserve the legacy post-write chain guarantee without reopening the
      // redirectable category path: the verification below binds every read
      // to the canonical result's directory identity.
      const postChain = verifyBoundedReceiptChain(boundedResult.boundDirectory);
      if (!postChain.valid) {
        return rejectAfterBoundedReceiptVerificationFailure<TVNextState>(
          rejectVNext<TVNextState>(
            'RUNTIME.RECEIPT_CHAIN_BROKEN',
            `bounded Receipt chain broken in ${targetDir} after admit: ${chainFailureDetail(postChain)}`,
          ),
          boundedResult,
          rollbackTestHooks,
        );
      }

      try {
        input.afterWrite?.(boundedResult);
      } catch (error) {
        return rejectAfterBoundedReceiptVerificationFailure<TVNextState>(
          rejectVNext<TVNextState>(
            'RUNTIME.SCHEMA_MISMATCH',
            `post-install Receipt consistency check failed for ${targetDir}: ${error instanceof Error ? error.message : String(error)}`,
          ),
          boundedResult,
          rollbackTestHooks,
        );
      }

      return {
        accepted: true,
        receipt_ref: boundedResult.digest,
        new_state: null,
        vnext_state: input.nextState,
        findings: [],
      };
    }

    let writeResult: WriteReceiptResult;
    try {
      writeResult = writer.write(receiptData, {
        receiptDir: targetDir,
        tempDir,
      });
    } catch (error) {
      const code =
        error instanceof ReceiptChainError
          ? 'RUNTIME.RECEIPT_CHAIN_BROKEN'
          : 'RUNTIME.SCHEMA_MISMATCH';
      const rejected = rejectVNext<TVNextState>(
        code,
        `writeReceipt failed for ${targetDir}: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Kernel writeReceipt renames before a post-write self-digest check.  Its
      // ReceiptChainError carries the digest, so recover that exact path and
      // apply the same identity-bound rollback used by post-chain failure.
      if (
        error instanceof ReceiptChainError &&
        error.subtype === 'self_digest' &&
        error.digest !== undefined &&
        /^[a-f0-9]{64}$/.test(error.digest)
      ) {
        return rejectAfterReceiptVerificationFailure<TVNextState>(
          rejected,
          { path: path.join(targetDir, `${error.digest}.json`), digest: error.digest },
          targetDir,
          projectRoot,
          rollbackTestHooks,
        );
      }
      return rejected;
    }

    const writtenFileIdentity = captureWrittenReceiptIdentity(writeResult.path);

    // Verify both the writer's canonical result and the actual on-disk
    // self-digest before relying on the chain verdict or returning its digest.
    if (canonicalPathWithinRoot(projectRoot, writeResult.path) !== path.resolve(writeResult.path)) {
      return rejectAfterReceiptVerificationFailure<TVNextState>(
        rejectVNext<TVNextState>(
          'RUNTIME.SCHEMA_MISMATCH',
          `Receipt writer returned a path outside the project root: ${writeResult.path}`,
        ),
        writeResult,
        targetDir,
        projectRoot,
        rollbackTestHooks,
        writtenFileIdentity,
      );
    }
    if (!receiptReadbackMatches(writeResult)) {
      return rejectAfterReceiptVerificationFailure<TVNextState>(
        rejectVNext<TVNextState>(
          'RUNTIME.RECEIPT_CHAIN_BROKEN',
          `post-write Receipt readback verification failed for ${writeResult.path}`,
        ),
        writeResult,
        targetDir,
        projectRoot,
        rollbackTestHooks,
        writtenFileIdentity,
      );
    }

    let postChain: ChainVerificationResult;
    try {
      postChain = writer.verifyChain(targetDir);
    } catch (error) {
      return rejectAfterReceiptVerificationFailure<TVNextState>(
        rejectVNext<TVNextState>(
          'RUNTIME.RECEIPT_CHAIN_BROKEN',
          `receipt chain verification failed in ${targetDir} after admit: ${error instanceof Error ? error.message : String(error)}`,
        ),
        writeResult,
        targetDir,
        projectRoot,
        rollbackTestHooks,
        writtenFileIdentity,
      );
    }
    if (!postChain.valid) {
      return rejectAfterReceiptVerificationFailure<TVNextState>(
        rejectVNext<TVNextState>(
          'RUNTIME.RECEIPT_CHAIN_BROKEN',
          `receipt chain broken in ${targetDir} after admit: ${chainFailureDetail(postChain)}`,
        ),
        writeResult,
        targetDir,
        projectRoot,
        rollbackTestHooks,
        writtenFileIdentity,
      );
    }

    try {
      input.afterWrite?.(writeResult);
    } catch (error) {
      return rejectAfterReceiptVerificationFailure<TVNextState>(
        rejectVNext<TVNextState>(
          'RUNTIME.SCHEMA_MISMATCH',
          `post-install Receipt consistency check failed for ${targetDir}: ${error instanceof Error ? error.message : String(error)}`,
        ),
        writeResult,
        targetDir,
        projectRoot,
        rollbackTestHooks,
        writtenFileIdentity,
      );
    }

    return {
      accepted: true,
      receipt_ref: writeResult.digest,
      new_state: null,
      vnext_state: input.nextState,
      findings: [],
    };
  } finally {
    if (admissionLock !== null) releaseRuntimeAdmissionLock(admissionLock);
  }
}

/**
 * Run the unified admit pipeline (AWI-006) for one AdmissionRequest.
 *
 * Every rejection path returns a structured `AdmitResult` with
 * `accepted: false`, `receipt_ref: null` and a canonical Finding — no
 * Receipt is ever produced for an invalid input or an unsatisfied state.
 */
export function runAdmitPipeline(
  input: AdmitPipelineInput,
  rollbackTestHooks?: RollbackTestHooks,
): AdmitResult {
  const writer = input.writer ?? defaultReceiptWriter;

  // ── 1. Request schema validation — fail closed (AWI-006: 验证输入) ──
  let request: AdmissionRequest;
  try {
    assertAdmissionRequest(input.request);
    request = input.request;
  } catch (err) {
    if (err instanceof SchemaValidationError) {
      return reject(
        'RUNTIME.SCHEMA_MISMATCH',
        `admission request rejected: ${err.message}`,
        null,
      );
    }
    throw err;
  }

  // ── 2. Reconcile current state (AWI-006: 检查当前状态, HP-003) ──
  let state: ReconcileStageResult;
  try {
    state = input.reconcile(admissionRequestStageId(request));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return reject(
      'RUNTIME.SCHEMA_MISMATCH',
      `reconcile failed for stage "${admissionRequestStageId(request)}": ${reason}`,
      null,
    );
  }

  // ── 2b. Existence gate (F-2, PO-S03-H-05): a schema-legal stageId that is
  //        not backed by persisted facts surfaces an error-level
  //        DOMAIN.STAGE_NOT_FOUND reconcile finding — refuse before any state
  //        advance or write, so a format-legal but non-existent stage (e.g.
  //        'S99') is genuinely rejected and can never produce a Receipt or
  //        touch a category directory. The refusal condition is the same for
  //        EVERY STAGE_NOT_FOUND source (fail closed — the release surface is
  //        never widened); only the rejection MESSAGE differs, attributing the
  //        refusal precisely:
  //          Branch A — "stage not declared in the manifest" (manifest
  //            missing / stage_id mismatch): the message says so explicitly
  //            and carries the original manifest-source finding content;
  //          Branch B — other sources (unknown slice directories, receipts
  //            referencing unknown stage/slice): the message attributes the
  //            refusal to the concrete receipt/directory source and carries
  //            the original finding content (never the branch-A wording). ──
  const stageNotFound = state.findings.filter(
    (f) => f.code === 'DOMAIN.STAGE_NOT_FOUND' && f.severity === 'error',
  );
  if (stageNotFound.length > 0) {
    return reject(
      'DOMAIN.STAGE_NOT_FOUND',
      stageNotFoundAttribution(state.stage_id, stageNotFound),
      state,
    );
  }

  // Reconcile errors are already canonical Findings.  Preserve their exact
  // code/message and refuse before the reducer, precheck, target-directory
  // access, or Receipt writer.  The stage-not-found attribution above stays
  // first so that existing source-specific attribution is unchanged.
  //
  // Scope note (legacy v1 Integration regression): the git-source diagnostic
  // from `checkCommitReceiptHead` (a SLICE_COMMIT receipt recording a commit
  // that is not an ancestor of git HEAD) is an error-level
  // RUNTIME.RECEIPT_CHAIN_BROKEN Finding, but it does NOT put the receipt
  // chain itself in a broken state — `receipt_chain_valid` stays true, the
  // commit fact is still attributable, and the Finding exists to surface the
  // git/chain disagreement (PO-S02-C-02), not to refuse the admission.  The
  // legacy consumer has always tolerated that diagnostic Finding at this
  // gate (it refused only genuine chain breaks, where `receipt_chain_valid`
  // is false).  A genuinely broken / tampered chain keeps `receipt_chain_valid
  // === false` and is STILL refused below, together with every other
  // error-level Finding (incl. the legacy/vNext SCHEMA_MISMATCH isolation
  // gate — v2 Receipts must never flow into the legacy consumer).
  const reconcileErrors = state.findings.filter(
    (finding) =>
      finding.severity === 'error' &&
      !(
        finding.code === 'RUNTIME.RECEIPT_CHAIN_BROKEN' &&
        state.receipt_chain_valid === true
      ),
  );
  if (reconcileErrors.length > 0) {
    return {
      accepted: false,
      receipt_ref: null,
      new_state: state,
      findings: reconcileErrors,
    };
  }

  // ── 3. Reducer precheck / state advance (T02–T04 wire per admit method;
  //        refuse → structured rejection, no Receipt) ──
  const pre = input.steps.precheck(state);
  if (!pre.accepted) {
    return {
      accepted: false,
      receipt_ref: null,
      new_state: state,
      findings: pre.findings,
    };
  }

  // ── 3b. Legal no-Receipt branch (review REPAIR, PO-S02-E-05/06): the
  //        state was advanced but NO Receipt may be written — return the
  //        warn Finding with a null receipt ref before any chain access. ──
  if (pre.writeReceipt === false) {
    return {
      accepted: true,
      receipt_ref: null,
      new_state: pre.nextState,
      findings: pre.findings ?? [],
    };
  }

  // ── 4. Target category chain must be intact before appending ──
  //        (RUNTIME.RECEIPT_CHAIN_BROKEN — never append to a broken chain)
  const targetDir = input.steps.targetDir(state);
  const preChain = writer.verifyChain(targetDir);
  if (!preChain.valid) {
    return reject(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      `receipt chain broken in ${targetDir} before admit: ${chainFailureDetail(preChain)}`,
      pre.nextState,
    );
  }

  // ── 5. Canonical Receipt construction: type/stage/slice/payload binding + ──
  //        previous_digest chain-tip linkage (version/digest are writer-owned)
  const build = input.steps.buildReceipt(state);
  ensureReceiptDir(targetDir);
  const previousDigest = resolveCategoryChainTip(targetDir);
  const receiptData: Record<string, unknown> = {
    version: 1,
    type: build.type,
    stage_id: build.stage_id,
    timestamp: build.timestamp,
    payload: build.payload,
  };
  if (build.slice_id !== undefined) {
    receiptData.slice_id = build.slice_id;
  }
  if (previousDigest !== undefined) {
    receiptData.previous_digest = previousDigest;
  }

  // ── 6. Persist through the kernel ReceiptWriter port — the ONLY write ──
  //        path (AWI-006: 禁止服务内直接写文件绕过 ReceiptWriter)
  let writeResult: WriteReceiptResult;
  try {
    writeResult = writer.write(receiptData, { receiptDir: targetDir, tempDir: targetDir });
  } catch (err) {
    const code =
      err instanceof ReceiptChainError
        ? 'RUNTIME.RECEIPT_CHAIN_BROKEN'
        : 'RUNTIME.SCHEMA_MISMATCH';
    return reject(
      code,
      `writeReceipt failed for ${targetDir}: ${err instanceof Error ? err.message : String(err)}`,
      pre.nextState,
    );
  }

  // ── 6b. Capture the ORIGINAL identity of the just-written receipt ──
  //        (S3-REVIEW-004 round-4/5): the dev/ino, ORIGINAL basename and link
  //        count of the file THIS run wrote, captured immediately after
  //        `writer.write` returns and BEFORE any rollback can be triggered.
  //        The rollback re-verifies this identity through the bound dirfd
  //        immediately before the unlink:
  //          - dev/ino — a path replaced by a symlink pointing at a
  //            PRE-EXISTING, content-identical, SAME-DIGEST receipt elsewhere
  //            has a different inode (round-4);
  //          - basename — a post-capture rename plus symlink replacement to
  //            the SAME INODE under a DIFFERENT basename is caught by the
  //            canonical-path basename mismatch (round-5);
  //          - link count — a same-inode entry under a DIFFERENT basename via
  //            a HARDLINK increments nlink and is caught (round-5).
  //        A failed capture (unreadable path) fails closed in the rollback
  //        (identity unverifiable → never delete).
  let writtenFileIdentity: {
    dev: number;
    ino: number;
    name: string;
    nlink: number;
  } | null = null;
  try {
    const st = fs.lstatSync(writeResult.path);
    writtenFileIdentity = {
      dev: st.dev,
      ino: st.ino,
      name: path.basename(writeResult.path),
      nlink: st.nlink,
    };
  } catch {
    writtenFileIdentity = null;
  }

  // ── 7. Post-write chain verification + rollback (S3-REVIEW-002) ──
  //        A post-write verify failure MUST NOT leave the just-written
  //        Receipt on disk (OUT-S3-04 "chain failure → 不写 Receipt"): the
  //        digest-verified file from THIS run is rolled back first — bound to
  //        the verified category directory inode (S03-A dirfd precedent,
  //        counterexample 1) and only when it is STILL the category chain tip
  //        (counterexample 2). On rollback success the ORIGINAL reject is
  //        returned (equivalent to "no Receipt written"); on rollback failure
  //        the reject is still returned but the findings honestly declare the
  //        residual persisted receipt (digest + rollback failure reason) —
  //        fail-closed plus honest residual-window recording.
  const postChain = writer.verifyChain(targetDir);
  if (!postChain.valid) {
    const rejectResult = reject(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      `receipt chain broken in ${targetDir} after admit: ${chainFailureDetail(postChain)}`,
      pre.nextState,
    );
    const rollback = rollbackWrittenReceipt(
      writeResult,
      targetDir,
      input.projectRoot,
      rollbackTestHooks,
      writtenFileIdentity,
    );
    if (rollback.ok) {
      return rejectResult;
    }
    return {
      ...rejectResult,
      findings: [
        ...rejectResult.findings,
        {
          code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
          severity: 'error',
          message:
            `receipt persisted but chain verify failed and rollback incomplete: ` +
            `receipt digest ${writeResult.digest} at ${writeResult.path} remains on disk — ` +
            `rollback failed: ${rollback.reason}`,
        },
      ],
    };
  }

  // ── 8. Result ──
  return {
    accepted: true,
    receipt_ref: writeResult.digest,
    new_state: pre.nextState,
    findings: pre.findings ?? [],
  };
}

// ============================================================
// admitSpvResult / admitGateResult — S03 SPV/GATE admits (PO-S03-H-02)
// ============================================================
//
// SLICE_PLAN creation-path decision record (PO-S03-H-02): the kernel
// `SLICE_PLAN` receipt literal is retained but S03 does NOT create
// SLICE_PLAN receipts (no consumer today). In S03 a worker-result admit can
// never create a new slice — undeclared slices are refused by the worker
// precheck (DOMAIN.STAGE_NOT_FOUND) and no receipt of any type (in
// particular no SLICE_PLAN) is written for them. If a future flow
// (repartition / first-entry) creates a new slice, the S04 tool flow wires a
// `slice_plan` request member through THIS same unified pipeline extension
// point; the SPV/GATE methods below are the reference wiring.

/** Reducer seam signature for the SPV/GATE admits. */
export type SpvGateReduceFn = (
  state: ReconciledStageState,
  action: RuntimeAction,
) => ReconciledStageState;

/**
 * Dependencies of the SPV/GATE admit methods (PO-S03-H-02).
 *
 * `reconcile` defaults to `reconcileStage` over `projectRoot`, `reduce` to
 * `reduceRuntimeAction`, `writer` to the kernel ReceiptWriter, and
 * `readManifestDigest` to the canonical `.proofloop/manifests/<stage>.json`
 * digest — callers only override what they need (tests inject a fake writer).
 */
export interface SpvGateAdmissionDeps {
  /** Project root — canonical receipt category directories resolve under it. */
  readonly projectRoot: string;
  /** Deterministic current-state source. */
  readonly reconcile?: (stageId: string) => ReconcileStageResult;
  /** Reducer seam. */
  readonly reduce?: SpvGateReduceFn;
  /** Persistence port — kernel ReceiptWriter by default. */
  readonly writer?: ReceiptWriterPort;
  /**
   * Canonical manifest digest source (manifest lifecycle binding, same seam
   * as PO-S02-E-07). Defaults to reading
   * `<projectRoot>/.proofloop/manifests/<stage>.json` and computing the
   * runtime canonical digest.
   */
  readonly readManifestDigest?: (stageId: string) => string;
}

/** Structured precheck refusal — canonical Finding, no Receipt. */
function refusePrecheck(
  code: Finding['code'],
  message: string,
): AdmitPrecheckResult {
  return { accepted: false, findings: [{ code, severity: 'error', message }] };
}

/** Re-attach the Reconcile-only chain fields to a reducer-advanced state. */
function spvGateToStageResult(
  next: ReconciledStageState,
  source: ReconcileStageResult,
): ReconcileStageResult {
  return {
    ...next,
    receipt_chain_valid: source.receipt_chain_valid,
    receipt_categories: source.receipt_categories,
  };
}

/**
 * Advance the stage state through the reducer and verify the expected target
 * was reached. An illegal transition or a missed target refuses the admit
 * (DOMAIN.INVALID_TRANSITION) — never a guess, never a wrong advance.
 */
function advanceStageTo(
  state: ReconcileStageResult,
  action: RuntimeAction,
  reduce: SpvGateReduceFn,
  reached: (stage: StageState) => boolean,
): AdmitPrecheckResult {
  let next: ReconciledStageState;
  try {
    next = reduce(state, action);
  } catch (err) {
    if (err instanceof InvalidTransitionError) {
      return refusePrecheck(
        'DOMAIN.INVALID_TRANSITION',
        `state advance refused for stage "${state.stage_id}" via ${action.entity}.${action.event}: ${err.message}`,
      );
    }
    throw err;
  }
  if (!reached(next.stage_state)) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `state advance via ${action.entity}.${action.event} did not reach the expected target for stage "${state.stage_id}"`,
    );
  }
  return { accepted: true, nextState: spvGateToStageResult(next, state) };
}

/**
 * Manifest digest binding check (manifest lifecycle binding): the request
 * digest must equal the canonical digest of the stage manifest. Returns null
 * on mismatch/unavailability — callers map to a precise refusal.
 */
function boundManifestDigest(
  requestStageId: string,
  requestDigest: string,
  deps: SpvGateAdmissionDeps,
): string | null {
  const readDigest =
    deps.readManifestDigest ??
    ((stageId: string) => manifestFileDigest({ projectRoot: deps.projectRoot, stageId }));
  let canonical: string;
  try {
    canonical = readDigest(requestStageId);
  } catch {
    return null;
  }
  return requestDigest === canonical ? canonical : null;
}

// ── admitSpvResult (PO-S03-H-02) ─────────────────────────────────────────────

/**
 * Admit the SPV result of a planned stage: `SPV_PASS` Receipt to
 * `plan/<stage>/`. Preconditions (fail closed): the stage is derived PLANNING
 * and the request `manifestDigest` binds the canonical stage manifest digest.
 * On acceptance the reducer `FINALIZE_PLAN` advances PLANNING → READY (§6).
 *
 * @param request - `{ type: 'spv_result', stageId, manifestDigest, summary }`
 *        — schema-validated inside the pipeline.
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export function admitSpvResult(
  request: SpvResultAdmissionRequest,
  deps: SpvGateAdmissionDeps,
): AdmitResult {
  return runAdmitPipeline({
    request,
    reconcile:
      deps.reconcile ?? ((stageId) => reconcileStage({ projectRoot: deps.projectRoot, stageId })),
    projectRoot: deps.projectRoot,
    writer: deps.writer,
    steps: spvResultSteps(request, deps),
  });
}

/** Per-admit pipeline wiring for SPV-result admits. */
function spvResultSteps(
  request: SpvResultAdmissionRequest,
  deps: SpvGateAdmissionDeps,
): AdmitPipelineSteps {
  const reduce = deps.reduce ?? reduceRuntimeAction;
  return {
    precheck: (state) => spvResultPrecheck(state, request, deps, reduce),
    buildReceipt: () => ({
      type: 'SPV_PASS',
      stage_id: request.stageId,
      timestamp: new Date().toISOString(),
      payload: {
        status: 'approved',
        manifest_digest: request.manifestDigest,
        summary: request.summary,
      },
    }),
    targetDir: () => planReceiptDir(deps.projectRoot, request.stageId),
  };
}

/**
 * SPV precheck (PO-S03-H-02):
 *   - the stage must be derived PLANNING (STAGE_PLAN receipt present, no
 *     SPV_PASS yet — a stage that was already approved / never planned is
 *     refused, which also makes repeated SPV admits impossible);
 *   - the request manifest digest must bind the canonical stage manifest
 *     digest (missing manifest source → DOMAIN.STAGE_NOT_FOUND; mismatch →
 *     DOMAIN.INVALID_TRANSITION);
 *   - reducer FINALIZE_PLAN advances PLANNING → READY (§6).
 */
function spvResultPrecheck(
  state: ReconcileStageResult,
  request: SpvResultAdmissionRequest,
  deps: SpvGateAdmissionDeps,
  reduce: SpvGateReduceFn,
): AdmitPrecheckResult {
  if (state.stage_state !== StageState.PLANNING) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage "${state.stage_id}" is ${state.stage_state}, expected PLANNING for SPV admit`,
    );
  }
  const canonical = boundManifestDigest(request.stageId, request.manifestDigest, deps);
  if (canonical === null) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `manifest digest binding mismatch for stage "${state.stage_id}": request "${request.manifestDigest}" does not match the canonical digest (or the manifest is unavailable)`,
    );
  }
  return advanceStageTo(
    state,
    { entity: 'stage', event: 'FINALIZE_PLAN' },
    reduce,
    (s) => s === StageState.READY,
  );
}

// ── admitGateResult (PO-S03-H-02) ────────────────────────────────────────────

/**
 * Admit the result of a Stage Gate run: `GATE_PASS` / `GATE_FAIL` Receipt to
 * `stage-gate/<stage>/`. Preconditions (fail closed, all verified on real
 * fixtures): every slice is derived INTEGRATED, the working tree is git-clean,
 * the request `snapshotDigest` binds the current git HEAD, and the request
 * `manifestDigest` binds the canonical stage manifest digest. A stage already
 * reviewed (COMPLETED) is refused. On PASS the stage stays at its derived
 * UNDER_REVIEW state (receipts-only reconciliation already derives
 * UNDER_REVIEW from SPV_PASS + all-integrated, §6 READY/UNDER_REVIEW rules);
 * a FAIL writes the receipt without any state advance.
 *
 * @param request - `{ type: 'gate_result', stageId, verdict, manifestDigest,
 *        snapshotDigest, summary }` — schema-validated inside the pipeline.
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export function admitGateResult(
  request: GateResultAdmissionRequest,
  deps: SpvGateAdmissionDeps,
): AdmitResult {
  // vNext route guard: a Gate fact for a vNext Manifest never enters the
  // legacy reconcile/reducer path.  `unknown` routes are refused, never
  // silently degraded to the v1 reader (fail closed, §9.5).
  const projectRoot = path.resolve(deps.projectRoot);
  const manifestPath = path.join(projectRoot, '.proofloop', 'manifests', `${request.stageId}.json`);
  const route = detectPlanManifestRoute(projectRoot, manifestPath);
  if (route === 'vnext') {
    return admitVNextGateResult(request, { projectRoot, writer: deps.writer }) as unknown as AdmitResult;
  }
  if (route === 'unknown') {
    return {
      accepted: false,
      receipt_ref: null,
      new_state: null,
      findings: [{
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message: `stage gate refused: Manifest route is unknown for stage "${request.stageId}"`,
      }],
    };
  }
  return runAdmitPipeline({
    request,
    reconcile:
      deps.reconcile ?? ((stageId) => reconcileStage({ projectRoot: deps.projectRoot, stageId })),
    projectRoot: deps.projectRoot,
    writer: deps.writer,
    steps: gateResultSteps(request, deps),
  });
}

/** Per-admit pipeline wiring for gate-result admits. */
function gateResultSteps(
  request: GateResultAdmissionRequest,
  deps: SpvGateAdmissionDeps,
): AdmitPipelineSteps {
  const reduce = deps.reduce ?? reduceRuntimeAction;
  return {
    precheck: (state) => gateResultPrecheck(state, request, deps, reduce),
    buildReceipt: () => ({
      type: request.verdict === 'PASS' ? 'GATE_PASS' : 'GATE_FAIL',
      stage_id: request.stageId,
      timestamp: new Date().toISOString(),
      payload: {
        verdict: request.verdict,
        manifest_digest: request.manifestDigest,
        snapshot_digest: request.snapshotDigest,
        summary: request.summary,
      },
    }),
    targetDir: () => stageGateReceiptDir(deps.projectRoot, request.stageId),
  };
}

/**
 * Gate precheck (PO-S03-H-02), in deterministic order:
 *   1. every manifest slice must be derived INTEGRATED (reconcile fact);
 *   2. the stage must be derived UNDER_REVIEW (a COMPLETED / PLANNING /
 *      UNINITIALIZED stage is refused — the gate runs between execution and
 *      review);
 *   3. the working tree must be git-clean (`git status --porcelain` empty);
 *   4. the request HEAD binding must equal the current git HEAD;
 *   5. the request manifest digest must bind the canonical stage manifest
 *      digest.
 * No state advance: PASS/FAIL both keep the derived stage state (the receipt
 * is the fact; derive-next-action consumes GATE_PASS/GATE_FAIL presence).
 */
function gateResultPrecheck(
  state: ReconcileStageResult,
  request: GateResultAdmissionRequest,
  deps: SpvGateAdmissionDeps,
  _reduce: SpvGateReduceFn,
): AdmitPrecheckResult {
  // 1. all-integrated (a zero-slice stage carries no integration evidence).
  const notIntegrated = state.slices.filter((s) => !s.integrated);
  if (state.slices.length === 0 || notIntegrated.length > 0) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage gate refused: not every slice is integrated. ` +
        `Non-integrated slices: ${notIntegrated.map((s) => s.slice_id).join(', ')}`,
    );
  }
  // 2. stage must be derived UNDER_REVIEW (not yet reviewed, already executed).
  if (state.stage_state !== StageState.UNDER_REVIEW) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage "${state.stage_id}" is ${state.stage_state}, expected UNDER_REVIEW for gate admit`,
    );
  }
  // 3. git-clean working tree.
  let clean: boolean;
  try {
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: deps.projectRoot,
      encoding: 'utf-8',
    });
    clean = porcelain.trim().length === 0;
  } catch {
    clean = false;
  }
  if (!clean) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage gate refused: working tree is not clean in "${deps.projectRoot}" (git status --porcelain non-empty)`,
    );
  }
  // 4. HEAD binding — the gate run must be bound to the current HEAD.
  let head: string | null = null;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: deps.projectRoot,
      encoding: 'utf-8',
    }).trim();
  } catch {
    head = null;
  }
  if (head === null || request.snapshotDigest !== head) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage gate refused: request snapshotDigest "${request.snapshotDigest}" does not match the current git HEAD "${head ?? 'unresolvable'}"`,
    );
  }
  // 5. manifest digest binding.
  const canonical = boundManifestDigest(request.stageId, request.manifestDigest, deps);
  if (canonical === null) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `manifest digest binding mismatch for stage "${state.stage_id}": request "${request.manifestDigest}" does not match the canonical digest (or the manifest is unavailable)`,
    );
  }
  return { accepted: true, nextState: state };
}

// ── admitGateInterrupted (S05-A-T05, HP-004/AWI-015) ────────────────────────

/**
 * Admit an INTERRUPTED Stage Gate run: `GATE_INTERRUPTED` Receipt to
 * `stage-gate/<stage>/` (additive 11th ReceiptType). The gate run was
 * cancelled or timed out — this is NOT a verdict: no PASS/FAIL is ever
 * written, the payload carries `reason: 'cancelled' | 'timeout'` and
 * `duration_ms`, and the receipt never blocks the next action like
 * GATE_FAIL nor passes the gate like GATE_PASS — the interrupted gate is
 * retryable (derive-next-action Row 11 still derives RUN_GATE because
 * `gate_fail_present` matches only GATE_FAIL).
 *
 * Preconditions (fail closed, mirror the gate-result context):
 *   1. every manifest slice is derived INTEGRATED;
 *   2. the stage is derived UNDER_REVIEW (the gate runs between execution
 *      and review);
 *   3. the request HEAD binding must equal the current git HEAD;
 *   4. the request manifest digest must bind the canonical stage manifest
 *      digest.
 *
 * Unlike `admitGateResult`, the working-tree git-clean check is NOT a
 * precondition: an interrupted run may leave a dirty tree, and the
 * interruption fact must still be recorded so the gate can be retried.
 * No state advance — the receipt is the fact; derive-next-action consumes
 * gate receipt presence.
 *
 * @param request - `{ type: 'gate_interrupted', stageId, reason,
 *        durationMs, manifestDigest, snapshotDigest }` — schema-validated
 *        inside the pipeline (reason ∈ closed {cancelled, timeout}).
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export function admitGateInterrupted(
  request: GateInterruptedAdmissionRequest,
  deps: SpvGateAdmissionDeps,
): AdmitResult {
  return runAdmitPipeline({
    request,
    reconcile:
      deps.reconcile ?? ((stageId) => reconcileStage({ projectRoot: deps.projectRoot, stageId })),
    projectRoot: deps.projectRoot,
    writer: deps.writer,
    steps: gateInterruptedSteps(request, deps),
  });
}

/** Per-admit pipeline wiring for gate-interrupted admits. */
function gateInterruptedSteps(
  request: GateInterruptedAdmissionRequest,
  deps: SpvGateAdmissionDeps,
): AdmitPipelineSteps {
  const reduce = deps.reduce ?? reduceRuntimeAction;
  return {
    precheck: (state) => gateInterruptedPrecheck(state, request, deps, reduce),
    buildReceipt: () => ({
      type: 'GATE_INTERRUPTED',
      stage_id: request.stageId,
      timestamp: new Date().toISOString(),
      payload: {
        reason: request.reason,
        duration_ms: request.durationMs,
        manifest_digest: request.manifestDigest,
        snapshot_digest: request.snapshotDigest,
      },
    }),
    targetDir: () => stageGateReceiptDir(deps.projectRoot, request.stageId),
  };
}

/**
 * Gate-interrupted precheck, in deterministic order (mirror the gate-result
 * context minus the git-clean requirement):
 *   1. every manifest slice must be derived INTEGRATED;
 *   2. the stage must be derived UNDER_REVIEW;
 *   3. the request HEAD binding must equal the current git HEAD;
 *   4. the request manifest digest must bind the canonical stage manifest
 *      digest.
 * No state advance — the interruption receipt is the fact.
 */
function gateInterruptedPrecheck(
  state: ReconcileStageResult,
  request: GateInterruptedAdmissionRequest,
  deps: SpvGateAdmissionDeps,
  _reduce: SpvGateReduceFn,
): AdmitPrecheckResult {
  // 1. all-integrated (a zero-slice stage carries no integration evidence).
  const notIntegrated = state.slices.filter((s) => !s.integrated);
  if (state.slices.length === 0 || notIntegrated.length > 0) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage gate interruption refused: not every slice is integrated. ` +
        `Non-integrated slices: ${notIntegrated.map((s) => s.slice_id).join(', ')}`,
    );
  }
  // 2. stage must be derived UNDER_REVIEW (the gate runs between execution
  //    and review).
  if (state.stage_state !== StageState.UNDER_REVIEW) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage "${state.stage_id}" is ${state.stage_state}, expected UNDER_REVIEW for gate interruption admit`,
    );
  }
  // 3. HEAD binding — the interrupted run must be bound to the current HEAD.
  let head: string | null = null;
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: deps.projectRoot,
      encoding: 'utf-8',
    }).trim();
  } catch {
    head = null;
  }
  if (head === null || request.snapshotDigest !== head) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `stage gate interruption refused: request snapshotDigest "${request.snapshotDigest}" does not match the current git HEAD "${head ?? 'unresolvable'}"`,
    );
  }
  // 4. manifest digest binding.
  const canonical = boundManifestDigest(request.stageId, request.manifestDigest, deps);
  if (canonical === null) {
    return refusePrecheck(
      'DOMAIN.INVALID_TRANSITION',
      `manifest digest binding mismatch for stage "${state.stage_id}": request "${request.manifestDigest}" does not match the canonical digest (or the manifest is unavailable)`,
    );
  }
  return { accepted: true, nextState: state };
}
