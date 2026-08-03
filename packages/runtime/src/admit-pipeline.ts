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
 *   (kernel `writeReceipt` by default) → post-write chain verification →
 *   `{ accepted, receipt_ref, new_state, findings }`.
 *
 * Fail-closed contract (AWI-006 forbidden shortcuts):
 *   - invalid input or an unreconcilable state → structured rejection with a
 *     canonical Finding and NO Receipt;
 *   - a broken target category chain blocks the admit
 *     (RUNTIME.RECEIPT_CHAIN_BROKEN);
 *   - persistence ONLY through the writer port — this module performs no
 *     direct file writes (directory scaffolding via mkdir, read-only
 *     chain-tip resolution, and the post-write ROLLBACK delete of a
 *     digest-verified receipt on chain failure are the only fs access);
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
import { execFileSync } from 'node:child_process';
import {
  writeReceipt,
  verifyReceiptChain,
  verifyReceiptDigest,
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
  ChainVerificationResult,
} from '@proofloop/kernel';
import type { ReconcileStageResult } from './reconcile';
import { reconcileStage } from './reconcile';
import { reduceRuntimeAction } from './reducer';
import type { ReconciledStageState, RuntimeAction } from './state-model';
import { planReceiptDir, stageGateReceiptDir } from './receipt-layout';
import { manifestFileDigest } from './manifest-source';
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
 * the pipeline never touches the filesystem for persistence on its own.
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
export interface AdmitResult {
  readonly accepted: boolean;
  readonly receipt_ref: string | null;
  readonly new_state: ReconcileStageResult | null;
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
