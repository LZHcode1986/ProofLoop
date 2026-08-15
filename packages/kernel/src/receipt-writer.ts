/**
 * @proofloop/kernel — Append-only ReceiptWriter: digest & chain verification.
 *
 * Kernel-owned ReceiptWriter module providing content-addressed digest
 * computation, file-level digest verification, and receipt chain verification
 * over a real filesystem directory.
 *
 * §4 File / Artifact Contracts: Receipt is immutable, content-addressed,
 * linked by previous_digest.
 *
 * HP-002: write-to-temp + fsync + rename + digest verify
 * AWI-004: atomic write, boundary tests, digest/chain validation
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateReceipt, SchemaValidationError } from './validators';
import { ReceiptChainError } from './errors';

// ============================================================
// Interface Definitions
// ============================================================

/**
 * Configuration options for the ReceiptWriter.
 *
 * @property receiptDir - Directory where receipts are stored.
 * @property tempDir - Directory for temporary files during atomic writes.
 */
export interface ReceiptWriterOptions {
  receiptDir: string;
  tempDir: string;
}

/**
 * Options for the root-bound receipt writer seam.
 *
 * `tempDir` is retained for additive compatibility with the v1 writer shape,
 * but it must resolve to the same physical directory as `receiptDir`.  The
 * bounded writer never uses either raw path as an operation base after the
 * directory fds are opened; temp files, locks, receipts, reads, no-replace
 * installs, and fsync all use the verified root-fd plus the root-relative
 * target path.
 */
export interface BoundedReceiptWriterOptions extends ReceiptWriterOptions {
  /** Canonical trust root that must contain `receiptDir`. */
  projectRoot: string;
}

/**
 * Options for securely creating a root-bound Receipt directory.
 *
 * `targetDir` may be an absolute path or a path relative to `projectRoot`.
 * Missing components are created one at a time through an already-open
 * directory fd; the caller must still pass the returned canonical path to
 * `writeReceiptBounded` explicitly.
 */
export interface EnsureBoundedReceiptDirectoryOptions {
  /** Canonical trust root that must contain `targetDir`. */
  projectRoot: string;
  /** Absolute target path, or a path relative to `projectRoot`. */
  targetDir: string;
}

/**
 * Stable directory binding returned with a bounded write result.
 *
 * The fd used by the write is deliberately closed before the function
 * returns, so no `/proc/self/fd/<fd>` path is exposed.  Consumers doing later
 * readback or rollback can use this canonical path together with the device
 * and inode identity for their own bound open/re-verification.
 */
export interface ReceiptDirectoryBinding {
  /** Canonical project root used for the binding. */
  rootPath: string;
  /** Canonical physical receipt directory path, never a proc-fd path. */
  path: string;
  /** Device identity captured from the opened directory fd. */
  dev: number;
  /** Inode identity captured from the opened directory fd. */
  ino: number;
}

/**
 * Writer-time identity of the final Receipt directory entry.
 *
 * This is a closed binding: it contains no fd and no redirectable path.  The
 * bounded writer captures it immediately after the no-replace install has
 * completed, before any post-install readback or durability verification.
 * A later consumer must compare this snapshot before attempting a rollback;
 * it must not substitute a later `lstat` result for this identity.
 */
export interface ReceiptFileBinding {
  /** Final directory-entry name, e.g. `<digest>.json`. */
  readonly name: string;
  /** Device identity captured at writer time. */
  readonly dev: number;
  /** Inode identity captured at writer time. */
  readonly ino: number;
  /** Link count captured at writer time. */
  readonly nlink: number;
  /**
   * Optional byte size for consumers that need an additional identity check.
   * The bounded writer does not require size because dev/ino/nlink plus the
   * digest binding are sufficient for its cleanup guard.
   */
  readonly size?: number;
}

/** Result of the additive root-bound receipt writer seam. */
export interface BoundedWriteReceiptResult extends WriteReceiptResult {
  /** Binding metadata for safe later readback/rollback re-verification. */
  boundDirectory: ReceiptDirectoryBinding;
  /** Receipt entry identity captured by the Kernel writer, not by readback. */
  receiptFile: ReceiptFileBinding;
}

/**
 * Fallback lock timeout in milliseconds.
 *
 * Used only when a lock directory carries no readable `owner.pid` (legacy
 * format or incomplete acquisition): if the lock directory is older than
 * this, it is considered stale and removed.  When `owner.pid` is present,
 * liveness is decided by probing the owning PID instead of mtime, so a live
 * writer whose fsync outlives this timeout is never evicted (see
 * S01-RR-005: mtime-based eviction could silently fork the receipt chain).
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

/**
 * Name of the file inside the lock directory that records the lock owner's
 * PID (plus an approximate process start timestamp) — used for PID-liveness
 * based stale-lock recovery.
 */
const LOCK_OWNER_FILENAME = 'owner.pid';

/**
 * Name of the diagnostic timestamp file written into the lock directory
 * when the lock is acquired.
 */
const LOCK_CREATED_AT_FILENAME = 'created-at';

/**
 * Result of a successful receipt write operation.
 *
 * @property path - Absolute path of the written receipt file.
 * @property digest - Content-addressed digest (SHA-256 hex) of the receipt.
 */
export interface WriteReceiptResult {
  path: string;
  digest: string;
}

/**
 * Configuration options for receipt chain verification.
 *
 * Future extension point for filtering or ordering options.
 */
export interface VerifyReceiptChainOptions {
  /** Optional: restrict verification to receipts matching a specific stage_id. */
  stageId?: string;
  /** Optional: restrict verification to receipts matching a specific slice_id. */
  sliceId?: string;
}

/**
 * Result of receipt chain verification.
 *
 * @property valid - True if the entire chain is intact (no broken links, no
 *   tampered digests, no duplicates).
 * @property receipts - Ordered list of receipt file paths that form the chain.
 * @property brokenLink - Details of the first broken link, if any.
 * @property duplicateDigests - List of digests that appear under multiple
 *   filenames (same content, different names). Each entry contains the
 *   duplicate digest and the file paths that share it.
 */
export interface ChainVerificationResult {
  valid: boolean;
  receipts: string[];
  brokenLink?: {
    index: number;
    expected: string;
    actual: string;
  };
  duplicateDigests?: Array<{
    digest: string;
    paths: string[];
  }>;
}

// ============================================================
// Canonical JSON Serialization (deterministic key ordering)
// ============================================================

/**
 * Serializes a value to canonical JSON with deterministically sorted keys.
 *
 * Uses a recursive approach: objects are serialized with their keys sorted
 * lexicographically to ensure the same logical data always produces the same
 * string representation. This is essential for content-addressed digests.
 *
 * @param value - The value to serialize.
 * @returns Canonical JSON string.
 *
 * Exported for reuse by the vNext contract layer (S0-A): all v1 and vNext
 * digests share this single canonicalization rule.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    // NaN and Infinity are not valid JSON values — reject them early
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `Cannot canonicalize non-finite number: ${value}`,
      );
    }
    return String(value);
  }

  if (typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJson(item));
    return `[${items.join(',')}]`;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
    return `{${pairs.join(',')}}`;
  }

  // Fallback for any other type (symbol, bigint, function, etc.)
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Check whether a given digest is the tip of its chain.
 *
 * A digest is the chain tip if no other receipt in the directory has its
 * `previous_digest` set to this digest.  This is a topology-based check
 * that avoids the timestamp-resolution pitfalls of mtime comparison.
 *
 * Used for fork detection: ensures a new linked receipt appends to the
 * actual chain tip rather than an arbitrary predecessor.
 *
 * @returns `true` if the digest is the tip (or no receipts exist);
 *          `false` if another receipt already points to this digest.
 */
function isChainTipWithReader(
  receiptDir: string,
  expectedPreviousDigest: string,
  readText: (filePath: string) => string,
): boolean {
  let files: string[];
  try {
    files = fs.readdirSync(receiptDir);
  } catch {
    return true;
  }

  for (const file of files) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    try {
      const content = JSON.parse(readText(path.join(receiptDir, file))) as Record<string, unknown>;
      // If another receipt's previous_digest points to our digest, it is not
      // the tip.  Exclude self-references (receipt pointing to itself).
      if (
        content.previous_digest === expectedPreviousDigest &&
        content.digest !== expectedPreviousDigest
      ) {
        return false;
      }
    } catch {
      // skip unreadable files
    }
  }

  return true;
}

function isChainTip(receiptDir: string, expectedPreviousDigest: string): boolean {
  return isChainTipWithReader(
    receiptDir,
    expectedPreviousDigest,
    (filePath) => fs.readFileSync(filePath, 'utf-8'),
  );
}

/**
 * Write the lock owner metadata into a freshly acquired lock directory.
 *
 * `owner.pid` records the owning process's PID plus an approximate process
 * start timestamp (epoch ms) so a recycled PID can be distinguished during
 * diagnostics (PID reuse is far less likely to cause a misjudgment than the
 * old mtime heuristic, and the start timestamp reduces that risk further).
 * `startTimeTicks` (F2, PO-S03-I-04) additionally records the owner's
 * `/proc/<pid>/stat` start-time (field 22, clock ticks since boot) so a
 * reused PID can be positively detected at stale judgement: a live PID whose
 * start-time differs from the recorded one was reused since the lock was
 * acquired → the original owner is gone → the lock is stale.  Best-effort:
 * when `/proc` is unavailable (non-Linux), `startTimeTicks` is omitted and
 * judgement falls back to PID-only liveness (current behaviour).
 * `created-at` records when the lock was acquired.
 *
 * @param lockDir - Path of the lock directory just created by this process.
 */
function writeLockOwnerMetadata(lockDir: string): void {
  const owner: { pid: number; startedAt: number; startTimeTicks?: number } = {
    pid: process.pid,
    startedAt: Date.now() - Math.round(process.uptime() * 1000),
  };
  const startTimeTicks = readProcStartTimeTicks(process.pid);
  if (startTimeTicks !== undefined) {
    owner.startTimeTicks = startTimeTicks;
  }
  fs.writeFileSync(
    path.join(lockDir, LOCK_OWNER_FILENAME),
    `${JSON.stringify(owner)}\n`,
    'utf-8',
  );
  fs.writeFileSync(
    path.join(lockDir, LOCK_CREATED_AT_FILENAME),
    `${new Date().toISOString()}\n`,
    'utf-8',
  );
}

/**
 * Read a process's start-time (field 22 of `/proc/<pid>/stat`, clock ticks
 * since boot) — best-effort, F2 (PO-S03-I-04).
 *
 * Returns `undefined` when `/proc` is unavailable (non-Linux), the pid has
 * no `/proc` entry (dead / raced), or the entry is unparseable — callers
 * then fall back to PID-only liveness judgement (current behaviour).
 *
 * @param pid - PID whose start-time to read.
 * @returns The start-time in ticks since boot, or `undefined`.
 */
function readProcStartTimeTicks(pid: number): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  } catch {
    return undefined;
  }
  // Format: "pid (comm) state ppid ... starttime ...".  The comm may itself
  // contain spaces/parentheses, so parse from the LAST ')' and index field 22
  // (starttime) relative to the post-comm fields (state = field 3 → index 0).
  const closeParen = raw.lastIndexOf(')');
  if (closeParen < 0) return undefined;
  const after = raw.slice(closeParen + 1).trim().split(/\s+/);
  const starttimeRaw = after[19]; // field 22 overall (22 - 3)
  const ticks = Number(starttimeRaw);
  return Number.isFinite(ticks) && ticks >= 0 ? ticks : undefined;
}

/**
 * Parsed lock owner metadata (`owner.pid`).
 *
 * `pid` is the owner PID (undefined → legacy/no metadata → mtime fallback).
 * `startTimeTicks` (F2, PO-S03-I-04) is the recorded `/proc/<pid>/stat`
 * start-time (ticks since boot) written at acquisition — undefined for
 * legacy metadata or non-Linux acquisitions (graceful PID-only fallback).
 */
interface LockOwnerMetadata {
  readonly pid?: number;
  readonly startTimeTicks?: number;
}

/**
 * Read the lock owner metadata from a lock directory's `owner.pid` file.
 *
 * Supports the current JSON format (`{"pid": <number>, "startedAt": <number>,
 * "startTimeTicks": <number>}`) as well as a legacy bare-integer format
 * (PID only, no start-time → PID-only judgement fallback).
 */
function readLockOwnerMetadata(lockDir: string): LockOwnerMetadata {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(lockDir, LOCK_OWNER_FILENAME), 'utf-8');
  } catch {
    return {};
  }

  return parseLockOwnerMetadata(raw);
}

function parseLockOwnerMetadata(raw: string): LockOwnerMetadata {

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return {};
  }

  // Current format: {"pid": <number>, "startedAt": <number>, "startTimeTicks": <number>}
  try {
    const parsed = JSON.parse(trimmed) as { pid?: unknown; startTimeTicks?: unknown };
    if (typeof parsed === 'object' && parsed !== null) {
      const pid =
        typeof parsed.pid === 'number' &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0
          ? parsed.pid
          : undefined;
      const startTimeTicks =
        typeof parsed.startTimeTicks === 'number' &&
        Number.isFinite(parsed.startTimeTicks) &&
        parsed.startTimeTicks >= 0
          ? parsed.startTimeTicks
          : undefined;
      if (pid !== undefined || startTimeTicks !== undefined) {
        return { pid, startTimeTicks };
      }
      return {};
    }
    return {};
  } catch {
    // Not JSON — try the legacy plain-PID format below.
  }

  // Legacy format: a bare positive integer PID (no start-time).
  if (/^[1-9][0-9]*$/.test(trimmed)) {
    const pid = Number(trimmed);
    if (Number.isSafeInteger(pid) && pid > 0) {
      return { pid };
    }
  }
  return {};
}

/**
 * Detect whether the lock owner metadata changed between the stale decision
 * and the pre-deletion re-check (F1∩F2 hardening, PO-S03-I-03).
 *
 * The decision snapshot `decision` is compared field-by-field against the
 * re-read `current` metadata:
 *   - decision had NO pid (mtime-fallback path): any newly present owner
 *     metadata means a writer acquired the lock → changed;
 *   - decision pid present, no startTimeTicks (legacy metadata / non-Linux
 *     acquisition): PID-only comparison fallback (as before F2);
 *   - decision pid + startTimeTicks present (F2 metadata): BOTH fields must
 *     match — a winner re-acquiring under the numerically-same recycled PID
 *     with a different start-time is a CHANGE (PID reuse must not hide the
 *     replacement);
 *   - current pid undefined while the lock directory still exists
 *     (unreadable/absent metadata) → changed (fail-closed: never delete an
 *     unknown-owner lock).
 */
function lockMetadataChanged(current: LockOwnerMetadata, decision: LockOwnerMetadata): boolean {
  if (decision.pid === undefined) {
    return current.pid !== undefined;
  }
  if (current.pid !== decision.pid) {
    return true;
  }
  if (decision.startTimeTicks === undefined) {
    return false; // legacy metadata — PID-only comparison fallback
  }
  return current.startTimeTicks !== decision.startTimeTicks;
}

/**
 * Read the owning PID from a lock directory's `owner.pid` file.
 *
 * Convenience wrapper over `readLockOwnerMetadata` (kept for the F1
 * ownership checks, which compare PID identity only).
 *
 * @returns The owner PID, or `undefined` when the file is missing, empty, or
 *   does not contain a valid positive integer PID (legacy format / incomplete
 *   write).  Callers fall back to the mtime heuristic in that case.
 */
function readLockOwnerPid(lockDir: string): number | undefined {
  return readLockOwnerMetadata(lockDir).pid;
}

/**
 * Check whether a process with the given PID is alive, using signal 0.
 *
 * `process.kill(pid, 0)` sends no signal; it only probes for existence:
 * - No throw → the process exists → alive.
 * - `ESRCH` → no such process → dead.
 * - `EPERM` → the process exists but is owned by another user (common on
 *   Windows) → treated as alive.
 * - Any other error (`EINVAL`, …) → liveness cannot be proven → treated as
 *   alive (fail closed: never delete a lock we cannot prove is stale).
 *
 * @param pid - PID to probe.
 * @returns `true` if the process is (or may be) alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

// ============================================================
// Public Functions
// ============================================================

/**
 * Write a receipt to disk using an atomic write sequence:
 * acquire lock → temp file (wx) → fsync → rename (atomic) →
 * post-rename verification.
 *
 * The function computes a SHA-256 digest of the input data (excluding any
 * existing `digest` field), adds it to the data, serializes to canonical JSON,
 * acquires a per-directory lock, checks for duplicate, validates predecessor
 * chain integrity, and performs fork detection.
 *
 * Changes vs the previous linkSync-based implementation:
 * - Uses `renameSync` (the POSIX-guaranteed atomic operation) instead of
 *   `linkSync` + `unlinkSync`.  Exclusive-create semantics are preserved by
 *   the per-directory lock + pre-check.
 * - Calls `validateReceipt` on the full data before writing.
 * - Rejects caller-supplied `digest` when it does not match the computed digest.
 * - Detects forks: a linked receipt must append to the most recent chain tip.
 *
 * @param data - Receipt data object. Must not be null, undefined, array, or
 *   primitive. Any existing `digest` field is validated against the computed
 *   digest (mismatch throws), then stripped and recomputed.
 * @param options - Writer options including receiptDir and tempDir.
 * @returns `{ path, digest }` where path is the absolute path of the written
 *   receipt file and digest is the 64-character hex SHA-256 digest.
 * @throws {TypeError} If data is not a plain object.
 * @throws {Error} If duplicate, invalid predecessor, fork detected, or write
 *   failure.
 * @throws {SchemaValidationError} If the data (with computed digest) fails
 *   receipt schema validation.
 */
export function writeReceipt(data: object, options: ReceiptWriterOptions): WriteReceiptResult {
  // Validate data
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('writeReceipt: data must be a non-null, non-array object');
  }

  const rawData = data as Record<string, unknown>;

  // ── Reject caller-supplied digest mismatch ─────────────────────────
  // If the caller provided a `digest` field, it must match what we compute.
  const callerDigestRaw = rawData.digest;
  const { digest: _existingDigest, ...content } = rawData;

  // Normalize empty previous_digest to undefined so validateReceipt does
  // not reject it (empty string fails min-length check).  The rest of the
  // function also treats empty/undefined as "no predecessor".
  if (content.previous_digest === '') {
    delete content.previous_digest;
  }

  const digest = computeReceiptDigest(content);

  if (callerDigestRaw !== undefined && callerDigestRaw !== null) {
    const callerStr = String(callerDigestRaw);
    if (callerStr !== digest) {
      throw new Error(
        `writeReceipt: caller-supplied digest "${callerStr}" does not match ` +
        `computed digest "${digest}"`,
      );
    }
  }

  // Build the full data with the computed digest
  const fullData = { ...content, digest };

  // ── Schema validation ──────────────────────────────────────────────
  // Call validateReceipt before writing to ensure the artifact conforms
  // to the canonical Receipt contract (§4 File / Artifact Contracts).
  try {
    validateReceipt(fullData);
  } catch (err: any) {
    if (err instanceof SchemaValidationError) {
      throw new Error(
        `writeReceipt: receipt validation failed: ${err.message}`,
      );
    }
    throw err;
  }

  // ── Chain validity check before write (Requirement 3) ───────────
  // Verify the existing chain is intact before attempting to write.
  // An empty directory or a directory with only valid receipts allows
  // writes; a broken chain blocks them.
  const preChainResult = verifyReceiptChain(options.receiptDir);
  if (!preChainResult.valid) {
    const detail = preChainResult.brokenLink
      ? `broken link at index ${preChainResult.brokenLink.index}: expected ${preChainResult.brokenLink.expected}, got ${preChainResult.brokenLink.actual}`
      : preChainResult.duplicateDigests && preChainResult.duplicateDigests.length > 0
        ? `duplicate digests: ${preChainResult.duplicateDigests.map(d => d.digest).join(', ')}`
        : 'chain verification failed';
    throw new ReceiptChainError(
      `writeReceipt: chain integrity check failed before write — ${detail}`,
      'chain',
      undefined,
      detail,
    );
  }

  // Serialize to canonical JSON (deterministic key ordering)
  const json = canonicalJson(fullData);

  // Determine target and temp file paths (same directory for atomic rename)
  const filename = `${digest}.json`;
  const finalPath = path.join(options.receiptDir, filename);
  const tmpFilename = `.${filename}.tmp.${process.pid}`;
  const tmpPath = path.join(options.receiptDir, tmpFilename);

  // Lock directory for per-directory serialization
  const lockDir = path.join(options.receiptDir, '.receipt-lock');

  // Acquire per-directory lock via exclusive mkdir, then record the owner
  // PID inside the lock so other writers can distinguish an active lock
  // from a stale one (see S01-RR-005).
  let lockAcquired = false;
  try {
    fs.mkdirSync(lockDir, { recursive: false });
    lockAcquired = true;
    writeLockOwnerMetadata(lockDir);
  } catch (err: any) {
    if (lockAcquired) {
      // mkdir succeeded but the owner metadata could not be written.
      // Remove the lock so we do not leak a lock that other writers can
      // only evaluate through the mtime fallback.  This is OUR own just-
      // created lock (owner.pid was never written, so the F1 ownership
      // guard cannot apply — the directory is milliseconds old and cannot
      // have been replaced by another kernel acquisition, which always
      // writes owner.pid).
      try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      throw err;
    }
    if (err.code === 'EEXIST') {
      // ── Stale lock recovery ─────────────────────────────────────────
      // PID-liveness based recovery.  The previous mtime heuristic could
      // delete a lock held by a live writer whose fsync took longer than
      // DEFAULT_LOCK_TIMEOUT_MS, letting two writers append to the same
      // chain tip and silently fork the receipt chain.  Instead, read the
      // lock owner's PID and probe whether that process is still alive:
      // alive → the lock is active (throw, never remove); dead (ESRCH) →
      // the lock is stale (remove and retry once).  Locks without a
      // readable owner.pid (legacy format / incomplete acquisition) fall
      // back to the mtime heuristic.
      try {
        const ownerMeta = readLockOwnerMetadata(lockDir);
        const ownerPid = ownerMeta.pid;
        let stale: boolean;
        let contentionDetail: string;
        if (ownerPid === undefined) {
          const lockStat = fs.statSync(lockDir);
          const age = Date.now() - lockStat.mtimeMs;
          stale = age >= DEFAULT_LOCK_TIMEOUT_MS;
          contentionDetail =
            `lock age ${Math.round(age)}ms < timeout ${DEFAULT_LOCK_TIMEOUT_MS}ms ` +
            `(no owner.pid — legacy lock format)`;
        } else {
          stale = !isProcessAlive(ownerPid);
          if (!stale && ownerMeta.startTimeTicks !== undefined) {
            // F2 hardening (PO-S03-I-04): the PID is alive — cross-check its
            // recorded start-time against the process that CURRENTLY holds
            // that PID.  A mismatch means the OS reused the PID since the
            // lock was acquired (the original owner is gone) → stale,
            // recoverable.  A match (same owner still alive) keeps the lock
            // active — fail-closed, never delete.  An unreadable `/proc`
            // gracefully falls back to the PID-only judgement (alive).
            const currentStartTimeTicks = readProcStartTimeTicks(ownerPid);
            if (
              currentStartTimeTicks !== undefined &&
              currentStartTimeTicks !== ownerMeta.startTimeTicks
            ) {
              stale = true;
              contentionDetail =
                `lock owner pid ${ownerPid} reused (start-time ` +
                `${ownerMeta.startTimeTicks} → ${currentStartTimeTicks})`;
            } else if (currentStartTimeTicks === undefined) {
              contentionDetail =
                `lock owner pid ${ownerPid} is alive (no /proc start-time — PID-only fallback)`;
            } else {
              contentionDetail = `lock owner pid ${ownerPid} is alive (start-time matched)`;
            }
          } else {
            contentionDetail = `lock owner pid ${ownerPid} is alive`;
          }
        }

        if (stale) {
          // F1∩F2 hardening (PO-S03-I-03): re-verify the lock is still the
          // SAME stale lock (full owner-metadata identity) before removing
          // it.  Between the stale decision above and this removal, a
          // competing writer may have recovered the same stale lock and
          // re-acquired it — possibly under the NUMERICALLY-SAME recycled
          // PID (F2) with a matching start-time for that PID.  Deleting it
          // would destroy the winner's live lock and let two writers proceed
          // concurrently (chain fork).  The re-check therefore compares the
          // full decision-time metadata snapshot (pid AND startTimeTicks)
          // against the re-read metadata: ANY change, or unreadable/absent
          // metadata while the lock directory still exists, → contention
          // (do not delete, do not retry).  Only an unchanged snapshot (or a
          // lock directory that is already gone) may be removed.
          if (fs.existsSync(lockDir)) {
            const currentMeta = readLockOwnerMetadata(lockDir);
            if (lockMetadataChanged(currentMeta, ownerMeta)) {
              throw new ReceiptChainError(
                `writeReceipt: another write operation is in progress — lock directory exists at ${lockDir}`,
                'predecessor',
                undefined,
                `lock owner metadata changed during stale recovery (decision pid ${String(
                  ownerMeta.pid,
                )} startTimeTicks ${String(ownerMeta.startTimeTicks)} → now pid ${String(
                  currentMeta.pid,
                )} startTimeTicks ${String(currentMeta.startTimeTicks)})`,
              );
            }
          }
          fs.rmSync(lockDir, { recursive: true, force: true });
          // Retry once
          fs.mkdirSync(lockDir, { recursive: false });
          writeLockOwnerMetadata(lockDir);
          // After stale recovery, re-verify chain integrity
          const chainCheck = verifyReceiptChain(options.receiptDir);
          if (!chainCheck.valid) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            throw new ReceiptChainError(
              `writeReceipt: stale lock removed but chain is corrupted`,
              'chain',
              undefined,
              `Stale lock recovery revealed chain integrity failure`,
            );
          }
        } else {
          throw new ReceiptChainError(
            `writeReceipt: another write operation is in progress — lock directory exists at ${lockDir}`,
            'predecessor',
            undefined,
            contentionDetail,
          );
        }
      } catch (innerErr: any) {
        // If the stat, rmdir, or retry mkdir fails, propagate the
        // original lock-contention error unless the inner error is
        // already a ReceiptChainError we created above.
        if (innerErr instanceof ReceiptChainError) {
          throw innerErr;
        }
        throw new ReceiptChainError(
          `writeReceipt: another write operation is in progress — lock directory exists at ${lockDir}`,
          'predecessor',
        );
      }
    } else {
      throw err;
    }
  }

  try {
    // ── Duplicate rejection ────────────────────────────────────────────
    if (fs.existsSync(finalPath)) {
      throw new ReceiptChainError(
        `writeReceipt: duplicate receipt rejected — file already exists at ${finalPath} (digest: ${digest})`,
        'duplicate',
        digest,
        `path: ${finalPath}`,
      );
    }

    // ── Fork detection ─────────────────────────────────────────────────
    // Before writing, check that previous_digest (if any) points to the
    // tip of its chain.  No other receipt should already reference this
    // digest as its previous_digest (which would indicate a fork).
    const prevDigest = rawData.previous_digest;
    if (prevDigest !== undefined && prevDigest !== null && prevDigest !== '') {
      if (!isChainTip(options.receiptDir, String(prevDigest))) {
        throw new ReceiptChainError(
          `writeReceipt: fork detected — digest "${String(prevDigest)}" ` +
          `is not the chain tip (another receipt already points to it)`,
          'fork',
          String(prevDigest),
        );
      }
    }

    // ── Predecessor validation ─────────────────────────────────────────
    if (prevDigest !== undefined && prevDigest !== null && prevDigest !== '') {
      const prevStr = String(prevDigest);
      const prevFilename = `${prevStr}.json`;
      const prevPath = path.join(options.receiptDir, prevFilename);

      if (!fs.existsSync(prevPath)) {
        throw new ReceiptChainError(
          `writeReceipt: predecessor validation failed — previous receipt not found at ${prevPath}`,
          'predecessor',
          prevStr,
          `missing file: ${prevPath}`,
        );
      }

      if (!verifyReceiptDigest(prevPath)) {
        throw new ReceiptChainError(
          `writeReceipt: predecessor validation failed — previous receipt at ${prevPath} has an invalid digest`,
          'predecessor',
          prevStr,
          `invalid digest at: ${prevPath}`,
        );
      }
    }

    // ── Temp file write with 'wx' (exclusive create) ───────────────────
    let tmpFd: number | undefined;
    try {
      tmpFd = fs.openSync(tmpPath, 'wx');
      fs.writeSync(tmpFd, json, 0, 'utf-8' as any);
      fs.fsyncSync(tmpFd);
      fs.closeSync(tmpFd);
      tmpFd = undefined;
    } catch (err: any) {
      // Cleanup on temp write failure
      if (tmpFd !== undefined) {
        try { fs.closeSync(tmpFd); } catch { /* best-effort */ }
      }
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      throw err;
    }

    // ── Atomic rename ────────────────────────────────────────────────
    // renameSync is the POSIX-guaranteed atomic operation on the same
    // filesystem.  Since we hold the exclusive lock and checked for
    // duplicate already, this is safe despite rename not being exclusive-
    // create.
    try {
      fs.renameSync(tmpPath, finalPath);
    } catch (err: any) {
      // Cleanup temp on rename failure
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
      throw err;
    }

    // No need to unlink temp — renameSync removes the source.

    // ── Post-write digest verification ─────────────────────────────────
    const verifyOk = verifyReceiptDigest(finalPath);
    if (!verifyOk) {
      let storedDigest: string;
      try {
        const raw = fs.readFileSync(finalPath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        storedDigest = typeof parsed.digest === 'string' ? parsed.digest : '(missing or invalid)';
      } catch {
        storedDigest = '(unreadable)';
      }
      throw new ReceiptChainError(
        `writeReceipt: post-write digest verification failed for ${finalPath}. ` +
        `Stored digest: ${storedDigest}. Expected: ${digest}.`,
        'self_digest',
        digest,
        `stored: ${storedDigest}`,
      );
    }

    // ── Directory fsync (best-effort) ────────────────────────────────
    try {
      const dirFd = fs.openSync(options.receiptDir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch {
      // Directory fsync may not be supported on all platforms
    }

    return { path: finalPath, digest };
  } finally {
    // ── Release the per-directory lock (F1, PO-S03-I-03) ─────────────
    // Ownership-checked: only remove the lock when this process still owns
    // it (owner.pid === our PID).  A stale-recovery interleaving can replace
    // our lock with a live winner's lock while we are mid-write — an
    // unconditional removal would destroy the winner's lock and break
    // per-directory mutual exclusion (chain fork).
    releaseLockIfOwned(lockDir);
  }
}

/**
 * Write a receipt through the additive root-bound directory seam.
 *
 * Unlike the legacy `writeReceipt`, this function is the safe seam for future
 * Runtime admission wiring: it requires a canonical directory inside the
 * supplied project root, opens that directory with `O_DIRECTORY|O_NOFOLLOW`,
 * verifies the opened inode, and performs every subsequent chain, lock,
 * temp-file, no-replace install, readback, and fsync operation through paths rooted at
 * `/proc/self/fd/<rootfd>/<relative-target>`.  It never falls back to the raw
 * target path or to a path rooted only at the target fd.
 *
 * The returned `path` is the canonical absolute receipt path, not a proc-fd
 * path.  The fd is closed before return; `boundDirectory` carries the
 * canonical path and inode identity needed for a later Runtime readback or
 * rollback to re-open and re-verify the directory safely.
 *
 * The existing v1 `writeReceipt` API remains unchanged and is intentionally
 * not described as root-bound.  Callers requiring this boundary must use this
 * additive function explicitly.
 */
export function writeReceiptBounded(
  data: object,
  options: BoundedReceiptWriterOptions,
): BoundedWriteReceiptResult {
  const prepared = prepareBoundedReceipt(data);
  const directory = openBoundedReceiptDirectory(options);
  let boundLock: BoundedLockDirectoryHandle | undefined;
  let lockAcquired = false;
  let finalLinkInstalled = false;
  let receiptFile: ReceiptFileBinding | undefined;

  try {
    assertBoundedDirectoryStable(directory);
    boundLock = acquireBoundedLock(directory, () =>
      verifyReceiptChainWithReader(boundedTargetPath(directory), boundedReceiptReader()),
      () => assertBoundedDirectoryStable(directory),
    );
    lockAcquired = true;
    if (boundLock === undefined) {
      throw new Error('writeReceiptBounded: lock acquisition returned no bound lock');
    }
    const activeLock = boundLock;

    try {
      // Re-check the binding after lock acquisition.  A raw target swap must
      // never turn the later result path into an alias for another directory.
      assertBoundedLockStable(directory, activeLock);

      const preChainResult = verifyBoundedReceiptChain(directory, activeLock);
      assertBoundedChainValid(preChainResult, 'before write');

      const filename = `${prepared.digest}.json`;
      const finalPath = boundedEntryPath(directory, filename);
      const tmpFilename = `.${filename}.tmp.${process.pid}`;
      const tmpPath = boundedEntryPath(directory, tmpFilename);

      if (boundedEntryExists(finalPath)) {
        throw new ReceiptChainError(
          `writeReceiptBounded: duplicate receipt rejected — file already exists ` +
            `at ${path.join(directory.binding.path, filename)} (digest: ${prepared.digest})`,
          'duplicate',
          prepared.digest,
          `path: ${path.join(directory.binding.path, filename)}`,
        );
      }

      const previousDigest = prepared.rawData.previous_digest;
      if (previousDigest !== undefined && previousDigest !== null && previousDigest !== '') {
        const previous = String(previousDigest);
        if (!isReceiptDigestFilename(previous)) {
          throw new ReceiptChainError(
            `writeReceiptBounded: predecessor validation failed — invalid previous digest "${previous}"`,
            'predecessor',
            previous,
          );
        }
        assertBoundedLockStable(directory, activeLock);
        if (!isChainTipWithReader(boundedTargetPath(directory), previous, boundedReadReceiptText)) {
          assertBoundedLockStable(directory, activeLock);
          throw new ReceiptChainError(
            `writeReceiptBounded: fork detected — digest "${previous}" ` +
              'is not the chain tip (another receipt already points to it)',
            'fork',
            previous,
          );
        }

        const previousPath = boundedEntryPath(directory, `${previous}.json`);
        if (!boundedEntryExists(previousPath)) {
          throw new ReceiptChainError(
            `writeReceiptBounded: predecessor validation failed — previous receipt not found ` +
              `at ${path.join(directory.binding.path, `${previous}.json`)}`,
            'predecessor',
            previous,
            `missing file: ${path.join(directory.binding.path, `${previous}.json`)}`,
          );
        }
        if (!verifyBoundedReceiptDigest(previousPath)) {
          assertBoundedLockStable(directory, activeLock);
          throw new ReceiptChainError(
            `writeReceiptBounded: predecessor validation failed — previous receipt has an invalid digest`,
            'predecessor',
            previous,
          );
        }
      }

      assertBoundedLockStable(directory, activeLock);
      writeBoundedTempFile(
        tmpPath,
        canonicalJson(prepared.fullData),
        () => assertBoundedLockStable(directory, activeLock),
      );
      assertBoundedLockStable(directory, activeLock);

      try {
        // `renameSync` is replace semantics: a competitor inserted after the
        // duplicate pre-check (including a symlink) would be overwritten.
        // Linux hard-link creation is atomic no-replace for the destination;
        // unlinking the temporary name completes the install without ever
        // replacing an existing directory entry.
        fs.linkSync(tmpPath, finalPath);
        // From this point on the final entry exists even if removing the
        // temporary hard-link name fails.  The outer catch therefore treats
        // every later error as a post-install error and never silently leaves
        // the final Receipt behind.
        finalLinkInstalled = true;
        fs.unlinkSync(tmpPath);
      } catch (err) {
        try {
          assertBoundedLockStable(directory, activeLock);
          fs.unlinkSync(tmpPath);
        } catch { /* best-effort; never clean through an unstable target */ }
        throw err;
      }

      // Capture the final entry identity at writer time, immediately after
      // the link+unlink install and before any readback or directory fsync.
      // Runtime rollback must consume this closed binding rather than taking
      // a later path-based lstat snapshot.
      assertBoundedLockStable(directory, activeLock);
      receiptFile = captureBoundedReceiptFile(directory, activeLock, filename);

      // Readback is also a bounded operation: do not verify a path after the
      // target has been replaced by another directory or symlink.
      assertBoundedLockStable(directory, activeLock);
      if (!verifyBoundedReceiptDigest(finalPath)) {
        const storedDigest = readBoundedStoredDigest(finalPath);
        throw new ReceiptChainError(
          `writeReceiptBounded: post-write digest verification failed for ` +
            `${path.join(directory.binding.path, filename)}. Stored digest: ${storedDigest}. ` +
            `Expected: ${prepared.digest}.`,
          'self_digest',
          prepared.digest,
          `stored: ${storedDigest}`,
        );
      }
      assertBoundedLockStable(directory, activeLock);

      // Unlike v1, directory fsync is mandatory here.  Capability preflight
      // already exercised this fd before any write; a later failure is still
      // surfaced rather than silently claiming a durable bounded write.
      fsyncBoundedTarget(directory, activeLock);

      if (receiptFile === undefined) {
        throw new Error('writeReceiptBounded: writer-time Receipt identity was not captured');
      }
      return {
        path: path.join(directory.binding.path, filename),
        digest: prepared.digest,
        boundDirectory: directory.binding,
        receiptFile,
      };
    } catch (error) {
      if (!finalLinkInstalled || boundLock === undefined) {
        throw error;
      }

      const cleanup = receiptFile === undefined
        ? {
            ok: false,
            reason:
              'writer-time Receipt identity was not captured; ownership cannot be proven, so deletion was skipped',
          }
        : cleanupBoundedReceipt(directory, boundLock, receiptFile);
      throw withBoundedReceiptCleanupOutcome(error, cleanup);
    } finally {
      if (lockAcquired && boundLock !== undefined) {
        try {
          releaseBoundedLockIfOwned(directory, boundLock);
        } finally {
          closeBoundedLock(boundLock);
        }
      }
    }
  } finally {
    try {
      fs.closeSync(directory.dirfd);
    } catch {
      // best-effort close; no fd is returned to the caller
    }
    try {
      fs.closeSync(directory.rootfd);
    } catch {
      // best-effort close; no fd is returned to the caller
    }
  }
}

/**
 * Securely create and bind a root-contained Receipt directory.
 *
 * This is the additive scaffolding seam for callers that need to materialize
 * nested paths such as `.proofloop/receipts/<stage>`.  It never uses a raw
 * recursive mkdir.  After the canonical root is opened, every component is
 * created or opened through the root-fd-relative path
 * `/proc/self/fd/<rootfd>/<relative-prefix>` with `O_DIRECTORY|O_NOFOLLOW`,
 * and each opened identity is checked before the next component is touched.
 *
 * All file descriptors are closed before this function returns.  The result
 * therefore exposes only the canonical target path and stable device/inode
 * identity needed by a later bound writer; it never exposes a proc-fd path.
 */
export function ensureBoundedReceiptDirectory(
  options: EnsureBoundedReceiptDirectoryOptions,
): ReceiptDirectoryBinding {
  assertBoundedWriterCapabilities('ensureBoundedReceiptDirectory');

  const root = resolveBoundedDirectory(
    'projectRoot',
    options.projectRoot,
    true,
    'ensureBoundedReceiptDirectory',
  );
  const target = resolveBoundedReceiptTarget(root.path, options.targetDir);
  const directoryFlags =
    (boundedConstant('O_RDONLY') as number) |
    (boundedConstant('O_DIRECTORY') as number) |
    (boundedConstant('O_NOFOLLOW') as number);
  const openFds: number[] = [];

  try {
    let rootFd: number;
    try {
      rootFd = fs.openSync(root.path, directoryFlags);
    } catch (err) {
      throw new Error(
        `ensureBoundedReceiptDirectory: cannot open project root: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    openFds.push(rootFd);

    const rootDirectory: BoundedScaffoldDirectory = {
      fd: rootFd,
      procPath: `/proc/self/fd/${rootFd}`,
      path: root.path,
      stat: assertBoundedScaffoldDirectoryIdentity(
        rootFd,
        `/proc/self/fd/${rootFd}`,
        root.path,
        root.path,
        root.stat,
        'project root',
      ),
    };

    // This is both the directory-fsync capability preflight and the first
    // durability barrier.  It happens before any missing component can be
    // created, so unsupported directory fsync fails closed without a partial
    // Receipt tree.
    fs.fsyncSync(rootFd);

    let parent = rootDirectory;
    for (let index = 0; index < target.components.length; index += 1) {
      const expectedPath = path.join(
        root.path,
        ...target.components.slice(0, index + 1),
      );

      // Re-check both the root and the currently bound parent immediately
      // before any mkdir.  The mkdir/open path below is rebuilt from the
      // verified root fd and the relative component prefix, never from the
      // parent fd alone.
      assertBoundedScaffoldDirectoryIdentity(
        rootDirectory.fd,
        rootDirectory.procPath,
        rootDirectory.path,
        root.path,
        rootDirectory.stat,
        'project root before component creation',
      );
      assertBoundedScaffoldDirectoryIdentity(
        parent.fd,
        parent.procPath,
        parent.path,
        root.path,
        parent.stat,
        'bound parent before component creation',
      );

      const existing = inspectBoundedScaffoldDirectory(expectedPath, 'target component');
      const childProcPath = path.join(
        rootDirectory.procPath,
        ...target.components.slice(0, index + 1),
      );
      let created = false;
      if (existing === undefined) {
        try {
          // Deliberately non-recursive and rooted at the already-open root fd.
          // Never replace this with raw recursive path creation.
          fs.mkdirSync(childProcPath, { recursive: false, mode: 0o700 });
          created = true;
        } catch (err) {
          // A competing creator may win between lstat and mkdir.  Re-open it
          // with O_NOFOLLOW below; a symlink or non-directory still fails
          // closed rather than being followed.
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw new Error(
              `ensureBoundedReceiptDirectory: cannot create ${expectedPath}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }

      let childFd: number;
      try {
        childFd = fs.openSync(childProcPath, directoryFlags);
      } catch (err) {
        throw new Error(
          `ensureBoundedReceiptDirectory: cannot no-follow open ${expectedPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      openFds.push(childFd);

      if (created) {
        // Re-verify the parent after creation and persist the new directory
        // entry through the same bound fd before proceeding.
        assertBoundedScaffoldDirectoryIdentity(
          parent.fd,
          parent.procPath,
          parent.path,
          root.path,
          parent.stat,
          'bound parent after component creation',
        );
        fs.fsyncSync(parent.fd);
      }

      const childStat = assertBoundedScaffoldDirectoryIdentity(
        childFd,
        `/proc/self/fd/${childFd}`,
        expectedPath,
        root.path,
        existing,
        'created/opened target component',
      );
      if (existing !== undefined && !sameDirectoryIdentity(childStat, existing)) {
        throw new Error(
          `ensureBoundedReceiptDirectory: target component identity changed before open: ${expectedPath}`,
        );
      }

      parent = {
        fd: childFd,
        procPath: `/proc/self/fd/${childFd}`,
        path: expectedPath,
        stat: childStat,
      };
    }

    // Re-check the root and final component immediately before returning the
    // binding.  This is an identity gate, not an atomic-containment claim; the
    // later bounded writer repeats its root-relative fd/path checks before
    // every write phase.
    assertBoundedScaffoldDirectoryIdentity(
      rootDirectory.fd,
      rootDirectory.procPath,
      rootDirectory.path,
      root.path,
      rootDirectory.stat,
      'project root after scaffolding',
    );
    const targetStat = assertBoundedScaffoldDirectoryIdentity(
      parent.fd,
      parent.procPath,
      target.path,
      root.path,
      parent.stat,
      'final target after scaffolding',
    );
    fs.fsyncSync(parent.fd);

    return {
      rootPath: root.path,
      path: target.path,
      dev: targetStat.dev,
      ino: targetStat.ino,
    };
  } finally {
    for (let index = openFds.length - 1; index >= 0; index -= 1) {
      try { fs.closeSync(openFds[index]); } catch { /* best-effort */ }
    }
  }
}

/**
 * Remove the per-directory lock ONLY when this process still owns it.
 *
 * F1 hardening (PO-S03-I-03): the lock's `owner.pid` must equal this
 * process's PID before the directory is removed.  A stale-recovery
 * interleaving can replace our lock with another writer's live lock while
 * we are mid-write; deleting that lock would destroy the winner's lock and
 * break per-directory mutual exclusion (chain fork).  An ownerless lock
 * directory (no readable owner.pid) is never guessed — it is left in place
 * unless it is absent.  Best-effort: any failure to read or remove is
 * swallowed (the lock is left for a later stale recovery).
 *
 * @param lockDir - Path of the lock directory to conditionally release.
 */
function releaseLockIfOwned(lockDir: string): void {
  try {
    const ownerPid = readLockOwnerPid(lockDir);
    if (ownerPid === undefined) {
      return; // absent or unreadable — nothing we can prove to own
    }
    if (ownerPid !== process.pid) {
      return; // another owner holds the lock — never touch it
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // best-effort — a failed release leaves the lock for later stale recovery
  }
}

/**
 * Release a bounded lock only while the root fd and root-relative target still
 * identify the originally bound directory.  If the target was moved or
 * replaced, do not follow the moved inode (or a replacement symlink) during
 * cleanup; fail-closed cleanup is safer than deleting an outside artifact.
 */
function releaseBoundedLockIfOwned(
  directory: BoundedReceiptDirectoryHandle,
  lock: BoundedLockDirectoryHandle,
): void {
  try {
    assertBoundedLockStable(directory, lock);
    const ownerMeta = readBoundedLockOwnerMetadata(directory, lock);
    if (ownerMeta.pid !== process.pid) {
      return;
    }
    removeBoundedLock(directory, lock);
  } catch {
    // The write path already reports the binding failure.  Never use the raw
    // target path as a fallback cleanup route after that failure.
  }
}

function closeBoundedLock(lock: BoundedLockDirectoryHandle): void {
  try {
    fs.closeSync(lock.fd);
  } catch {
    // best-effort close; no fd is exposed to the caller
  }
}

interface PreparedBoundedReceipt {
  rawData: Record<string, unknown>;
  fullData: Record<string, unknown>;
  digest: string;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface BoundedReceiptDirectoryHandle {
  /** Verified canonical Trust Root directory fd. */
  rootfd: number;
  /** `/proc` path for the verified Trust Root fd. */
  rootProcPath: string;
  rootPath: string;
  rootDev: number;
  rootIno: number;
  /** Canonical path relative to the verified root fd. */
  rootRelativeTargetPath: string;
  /** Canonical target components, retained for anchored re-open checks. */
  targetComponents: string[];
  dirfd: number;
  binding: ReceiptDirectoryBinding;
}

/**
 * Identity-bound handle for the per-directory bounded lock.
 *
 * `entryPath` is only the root-anchored entry used for identity verification
 * and final directory removal.  All owner metadata and stale decisions use
 * `procPath`, which is rooted at this already-open lock fd.
 */
interface BoundedLockDirectoryHandle {
  entryPath: string;
  canonicalPath: string;
  procPath: string;
  fd: number;
  dev: number;
  ino: number;
}

interface CanonicalDirectoryInfo {
  path: string;
  stat: fs.Stats;
}

interface BoundedScaffoldDirectory {
  fd: number;
  procPath: string;
  path: string;
  stat: fs.Stats;
}

interface BoundedReceiptTargetPath {
  path: string;
  components: string[];
}

/**
 * Construct a bounded target path from the verified Trust Root fd.
 *
 * This is deliberately the only path base used by the bounded writer.  The
 * target directory fd is retained for identity/fsync checks, but it is never
 * used as the parent of a lock, receipt, temporary file, or readback path.
 */
function boundedTargetPath(directory: BoundedReceiptDirectoryHandle): string {
  return directory.rootRelativeTargetPath === ''
    ? directory.rootProcPath
    : path.join(directory.rootProcPath, directory.rootRelativeTargetPath);
}

function boundedEntryPath(
  directory: BoundedReceiptDirectoryHandle,
  entryName: string,
): string {
  if (
    entryName.length === 0 ||
    entryName === '.' ||
    entryName === '..' ||
    entryName !== path.basename(entryName) ||
    entryName.includes('/') ||
    entryName.includes('\\')
  ) {
    throw new Error(`writeReceiptBounded: unsafe bounded entry name: ${entryName}`);
  }
  return path.join(boundedTargetPath(directory), entryName);
}

function boundedLockFilePath(
  lock: BoundedLockDirectoryHandle,
  filename: string,
): string {
  if (
    filename.length === 0 ||
    filename === '.' ||
    filename === '..' ||
    filename !== path.basename(filename) ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    throw new Error(`writeReceiptBounded: unsafe lock metadata name: ${filename}`);
  }
  return path.join(lock.procPath, filename);
}

function openBoundedLock(
  directory: BoundedReceiptDirectoryHandle,
): BoundedLockDirectoryHandle {
  const entryPath = boundedEntryPath(directory, '.receipt-lock');
  const canonicalPath = path.join(directory.binding.path, '.receipt-lock');
  const directoryFlags =
    (boundedConstant('O_RDONLY') as number) |
    (boundedConstant('O_DIRECTORY') as number) |
    (boundedConstant('O_NOFOLLOW') as number);
  let fd: number;
  try {
    // This is deliberately the first operation after mkdir for a newly
    // created lock.  The root-fd anchor plus O_NOFOLLOW prevents a replaced
    // lock entry from being followed into another directory.
    fd = fs.openSync(entryPath, directoryFlags);
  } catch (err) {
    throw new Error(
      `writeReceiptBounded: cannot root-anchor open receipt lock: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const lock: BoundedLockDirectoryHandle = {
    entryPath,
    canonicalPath,
    procPath: `/proc/self/fd/${fd}`,
    fd,
    dev: 0,
    ino: 0,
  };

  try {
    const stat = fs.fstatSync(fd);
    lock.dev = stat.dev;
    lock.ino = stat.ino;
    // Verify the opened identity immediately, before owner metadata is
    // created or read.  The fstat/lstat comparison also catches a replacement
    // between the root-anchored open and this check.
    assertBoundedLockEntryIdentity(directory, lock);
    assertBoundedDirectoryStable(directory);
    assertBoundedLockEntryIdentity(directory, lock);
    return lock;
  } catch (err) {
    closeBoundedLock(lock);
    throw err;
  }
}

function assertBoundedLockEntryIdentity(
  directory: BoundedReceiptDirectoryHandle,
  lock: BoundedLockDirectoryHandle,
): void {
  const opened = fs.fstatSync(lock.fd);
  if (!opened.isDirectory() || opened.dev !== lock.dev || opened.ino !== lock.ino) {
    throw new Error('writeReceiptBounded: bound receipt lock fd identity changed');
  }

  const rawEntry = fs.lstatSync(lock.entryPath);
  if (
    rawEntry.isSymbolicLink() ||
    !rawEntry.isDirectory() ||
    rawEntry.dev !== lock.dev ||
    rawEntry.ino !== lock.ino
  ) {
    throw new Error(
      'writeReceiptBounded: receipt lock entry is a symlink, outside, or identity replacement',
    );
  }

  const procPhysical = fs.realpathSync(lock.procPath);
  if (
    procPhysical !== lock.canonicalPath ||
    !isPathWithinRoot(directory.rootPath, procPhysical)
  ) {
    throw new Error(
      `writeReceiptBounded: receipt lock fd escaped its bound path: ${procPhysical}`,
    );
  }

  const procStat = fs.statSync(lock.procPath);
  if (
    !procStat.isDirectory() ||
    procStat.dev !== lock.dev ||
    procStat.ino !== lock.ino
  ) {
    throw new Error('writeReceiptBounded: receipt lock proc-fd identity mismatch');
  }
}

function assertBoundedLockStable(
  directory: BoundedReceiptDirectoryHandle,
  lock: BoundedLockDirectoryHandle,
): void {
  assertBoundedDirectoryStable(directory);
  assertBoundedLockEntryIdentity(directory, lock);
}

function readBoundedLockOwnerMetadata(
  directory: BoundedReceiptDirectoryHandle,
  lock: BoundedLockDirectoryHandle,
): LockOwnerMetadata {
  assertBoundedLockStable(directory, lock);
  const flags =
    (boundedConstant('O_RDONLY') as number) |
    (boundedConstant('O_NOFOLLOW') as number) |
    (boundedConstant('O_NONBLOCK') as number);
  const ownerPath = boundedLockFilePath(lock, LOCK_OWNER_FILENAME);
  let fd: number | undefined;
  let raw: string;
  try {
    fd = fs.openSync(ownerPath, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('writeReceiptBounded: bounded lock owner metadata is not a regular file');
    }
    raw = fs.readFileSync(fd, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      assertBoundedLockStable(directory, lock);
      return {};
    }
    throw new Error(
      `writeReceiptBounded: cannot no-follow read bounded lock owner metadata: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
  assertBoundedLockStable(directory, lock);
  return parseLockOwnerMetadata(raw);
}

function removeBoundedLock(
  directory: BoundedReceiptDirectoryHandle,
  lock: BoundedLockDirectoryHandle,
): void {
  assertBoundedLockStable(directory, lock);
  for (const filename of fs.readdirSync(lock.procPath)) {
    const childPath = boundedLockFilePath(lock, filename);
    const child = fs.lstatSync(childPath);
    if (child.isDirectory() && !child.isSymbolicLink()) {
      throw new Error('writeReceiptBounded: refusing to recursively remove bounded lock content');
    }
    fs.unlinkSync(childPath);
    assertBoundedLockStable(directory, lock);
  }
  assertBoundedLockStable(directory, lock);
  // The entry remains identity-checked immediately before this removal.  No
  // raw options.receiptDir lock path is ever used.
  // The directory has been emptied through the bound lock fd above.  A
  // non-recursive rmdir cannot traverse a replacement directory or symlink;
  // identity is rechecked immediately before this call and no raw lock path
  // is used.
  fs.rmdirSync(lock.entryPath);
}

function prepareBoundedReceipt(data: object): PreparedBoundedReceipt {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('writeReceiptBounded: data must be a non-null, non-array object');
  }

  const rawData = data as Record<string, unknown>;
  const callerDigestRaw = rawData.digest;
  const { digest: _existingDigest, ...content } = rawData;
  if (content.previous_digest === '') {
    delete content.previous_digest;
  }

  const digest = computeReceiptDigest(content);
  if (callerDigestRaw !== undefined && callerDigestRaw !== null) {
    const callerDigest = String(callerDigestRaw);
    if (callerDigest !== digest) {
      throw new Error(
        `writeReceiptBounded: caller-supplied digest "${callerDigest}" does not match ` +
          `computed digest "${digest}"`,
      );
    }
  }

  const fullData = { ...content, digest };
  try {
    validateReceipt(fullData);
  } catch (err: unknown) {
    if (err instanceof SchemaValidationError) {
      throw new Error(`writeReceiptBounded: receipt validation failed: ${err.message}`);
    }
    throw err;
  }

  return { rawData, fullData, digest };
}

function boundedConstant(name: string): number | undefined {
  const value = (fs.constants as unknown as Record<string, unknown>)[name];
  return typeof value === 'number' ? value : undefined;
}

function assertBoundedWriterCapabilities(operation = 'writeReceiptBounded'): void {
  if (process.platform !== 'linux') {
    throw new Error(
      `${operation}: unsupported platform — safe directory-fd/proc-fd binding is unavailable`,
    );
  }

  const requiredConstants = [
    'O_RDONLY',
    'O_WRONLY',
    'O_CREAT',
    'O_EXCL',
    'O_DIRECTORY',
    'O_NOFOLLOW',
    'O_NONBLOCK',
  ];
  for (const name of requiredConstants) {
    if (boundedConstant(name) === undefined) {
      throw new Error(`${operation}: required filesystem capability ${name} is unavailable`);
    }
  }

  const requiredFunctions: Array<keyof typeof fs> = [
    'openSync',
    'closeSync',
    'fstatSync',
    'fsyncSync',
    'realpathSync',
    'statSync',
    'lstatSync',
    'readdirSync',
    'readFileSync',
    'writeFileSync',
    'writeSync',
    'linkSync',
    'unlinkSync',
    'rmdirSync',
    'mkdirSync',
    'rmSync',
    'existsSync',
  ];
  for (const name of requiredFunctions) {
    if (typeof fs[name] !== 'function') {
      throw new Error(`${operation}: required filesystem function ${String(name)} is unavailable`);
    }
  }
}

function resolveBoundedDirectory(
  label: string,
  value: string,
  allowRootAlias: boolean,
  operation = 'writeReceiptBounded',
): CanonicalDirectoryInfo {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${operation}: ${label} must be a non-empty path`);
  }

  const lexicalPath = path.resolve(value);
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(lexicalPath);
  } catch (err) {
    throw new Error(
      `${operation}: ${label} cannot be canonicalized: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Root aliases are canonicalized as the authority itself.  Receipt and
  // temp directories must already be expressed canonically: accepting a
  // symlink alias would make the later raw-path identity re-check ambiguous.
  if (!allowRootAlias && canonicalPath !== lexicalPath) {
    throw new Error(`${operation}: ${label} must be a canonical, symlink-free directory path`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonicalPath);
  } catch (err) {
    throw new Error(
      `${operation}: ${label} cannot be inspected: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`${operation}: ${label} is not a regular directory`);
  }
  return { path: canonicalPath, stat };
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveBoundedReceiptTarget(
  rootPath: string,
  targetDir: string,
): BoundedReceiptTargetPath {
  if (typeof targetDir !== 'string' || targetDir.length === 0) {
    throw new Error('ensureBoundedReceiptDirectory: targetDir must be a non-empty path');
  }

  const targetPath = path.isAbsolute(targetDir)
    ? path.resolve(targetDir)
    : path.resolve(rootPath, targetDir);
  if (!isPathWithinRoot(rootPath, targetPath)) {
    throw new Error(
      `ensureBoundedReceiptDirectory: targetDir "${targetPath}" escapes project root "${rootPath}"`,
    );
  }

  const relative = path.relative(rootPath, targetPath);
  const components = relative === '' ? [] : relative.split(path.sep);
  if (components.some((component) => component === '' || component === '.' || component === '..')) {
    throw new Error('ensureBoundedReceiptDirectory: targetDir contains an unsafe path component');
  }
  return { path: targetPath, components };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function inspectBoundedScaffoldDirectory(
  directoryPath: string,
  label: string,
): fs.Stats | undefined {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(directoryPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new Error(
      `ensureBoundedReceiptDirectory: cannot inspect ${label} ${directoryPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (entry.isSymbolicLink()) {
    throw new Error(
      `ensureBoundedReceiptDirectory: ${label} is a symlink; refusing to follow ${directoryPath}`,
    );
  }
  if (!entry.isDirectory()) {
    throw new Error(
      `ensureBoundedReceiptDirectory: ${label} is not a directory: ${directoryPath}`,
    );
  }
  return entry;
}

function assertBoundedScaffoldDirectoryIdentity(
  fd: number,
  procPath: string,
  expectedPath: string,
  rootPath: string,
  expectedIdentity: fs.Stats | undefined,
  label: string,
): fs.Stats {
  let actual: fs.Stats;
  try {
    actual = fs.fstatSync(fd);
  } catch (err) {
    throw new Error(
      `ensureBoundedReceiptDirectory: cannot inspect ${label} fd: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!actual.isDirectory()) {
    throw new Error(`ensureBoundedReceiptDirectory: ${label} is not a directory`);
  }
  if (expectedIdentity !== undefined && !sameDirectoryIdentity(actual, expectedIdentity)) {
    throw new Error(
      `ensureBoundedReceiptDirectory: ${label} identity mismatch at ${expectedPath}`,
    );
  }

  let procPhysical: string;
  try {
    procPhysical = fs.realpathSync(procPath);
  } catch (err) {
    throw new Error(
      `ensureBoundedReceiptDirectory: cannot resolve bound ${label} proc-fd: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (procPhysical !== expectedPath || !isPathWithinRoot(rootPath, procPhysical)) {
    throw new Error(
      `ensureBoundedReceiptDirectory: ${label} proc-fd escaped or changed identity: ${procPhysical}`,
    );
  }

  let procStat: fs.Stats;
  try {
    procStat = fs.statSync(procPath);
  } catch (err) {
    throw new Error(
      `ensureBoundedReceiptDirectory: cannot stat bound ${label} proc-fd: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!procStat.isDirectory() || !sameDirectoryIdentity(procStat, actual)) {
    throw new Error(
      `ensureBoundedReceiptDirectory: bound ${label} proc-fd identity mismatch`,
    );
  }

  const rawEntry = inspectBoundedScaffoldDirectory(expectedPath, label);
  if (rawEntry === undefined || !sameDirectoryIdentity(rawEntry, actual)) {
    throw new Error(
      `ensureBoundedReceiptDirectory: ${label} raw path identity mismatch at ${expectedPath}`,
    );
  }
  return actual;
}

function openBoundedReceiptDirectory(
  options: BoundedReceiptWriterOptions,
): BoundedReceiptDirectoryHandle {
  assertBoundedWriterCapabilities();

  const root = resolveBoundedDirectory('projectRoot', options.projectRoot, true);
  const receipt = resolveBoundedDirectory('receiptDir', options.receiptDir, false);
  const temp = resolveBoundedDirectory('tempDir', options.tempDir, false);

  if (!isPathWithinRoot(root.path, receipt.path)) {
    throw new Error(
      `writeReceiptBounded: receiptDir "${receipt.path}" escapes project root "${root.path}"`,
    );
  }
  if (temp.path !== receipt.path || temp.stat.dev !== receipt.stat.dev || temp.stat.ino !== receipt.stat.ino) {
    throw new Error(
      'writeReceiptBounded: tempDir must resolve to the same physical directory as receiptDir',
    );
  }

  const directoryFlags =
    (boundedConstant('O_RDONLY') as number) |
    (boundedConstant('O_DIRECTORY') as number) |
    (boundedConstant('O_NOFOLLOW') as number);
  const relativeTargetPath = path.relative(root.path, receipt.path);
  const targetComponents = relativeTargetPath === ''
    ? []
    : relativeTargetPath.split(path.sep);
  if (
    !isPathWithinRoot(root.path, receipt.path) ||
    targetComponents.some((component) =>
      component.length === 0 || component === '.' || component === '..',
    )
  ) {
    throw new Error(
      `writeReceiptBounded: receiptDir "${receipt.path}" is not a safe root-relative target`,
    );
  }

  let rootfd: number | undefined;
  let dirfd: number | undefined;
  try {
    try {
      rootfd = fs.openSync(root.path, directoryFlags);
    } catch (err) {
      throw new Error(
        `writeReceiptBounded: cannot open verified project root: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const rootProcPath = `/proc/self/fd/${rootfd}`;
    assertBoundedRootFd(rootfd, rootProcPath, root.path, root.stat, 'project root');

    const targetPath = relativeTargetPath === ''
      ? rootProcPath
      : path.join(rootProcPath, relativeTargetPath);
    try {
      // The target is opened through the verified root fd.  This path is the
      // locator only; every later child path is rebuilt from rootProcPath and
      // rootRelativeTargetPath rather than from this target fd.
      dirfd = fs.openSync(targetPath, directoryFlags);
    } catch (err) {
      throw new Error(
        `writeReceiptBounded: cannot no-follow open root-relative receipt directory: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const actual = fs.fstatSync(dirfd);
    if (!actual.isDirectory()) {
      throw new Error('writeReceiptBounded: opened receipt target is not a regular directory');
    }
    if (actual.dev !== receipt.stat.dev || actual.ino !== receipt.stat.ino) {
      throw new Error(
        'writeReceiptBounded: receipt directory identity changed between verification and open',
      );
    }
    assertBoundedOpenedTarget(
      dirfd,
      `/proc/self/fd/${dirfd}`,
      targetPath,
      root.path,
      receipt.path,
      actual,
      'opened receipt target',
    );

    // Exercise directory fsync before any temp, lock, or receipt write.  A
    // platform/filesystem that cannot fsync a directory is unsupported here;
    // the bounded writer never falls back to the legacy path writer.
    fs.fsyncSync(dirfd);

    const binding: ReceiptDirectoryBinding = {
      rootPath: root.path,
      path: receipt.path,
      dev: actual.dev,
      ino: actual.ino,
    };
    const handle: BoundedReceiptDirectoryHandle = {
      rootfd,
      rootProcPath,
      rootPath: root.path,
      rootDev: root.stat.dev,
      rootIno: root.stat.ino,
      rootRelativeTargetPath: relativeTargetPath,
      targetComponents,
      dirfd,
      binding,
    };

    assertBoundedDirectoryStable(handle);
    return handle;
  } catch (err) {
    if (dirfd !== undefined) {
      try { fs.closeSync(dirfd); } catch { /* best-effort */ }
    }
    if (rootfd !== undefined) {
      try { fs.closeSync(rootfd); } catch { /* best-effort */ }
    }
    throw err;
  }
}

function assertBoundedRootFd(
  rootfd: number,
  rootProcPath: string,
  rootPath: string,
  expected: DirectoryIdentity,
  label: string,
): void {
  const actual = fs.fstatSync(rootfd);
  if (!actual.isDirectory() || !sameDirectoryIdentity(actual, expected)) {
    throw new Error(`writeReceiptBounded: ${label} fd identity mismatch`);
  }

  const rawRoot = fs.lstatSync(rootPath);
  if (rawRoot.isSymbolicLink() || !rawRoot.isDirectory() || !sameDirectoryIdentity(rawRoot, actual)) {
    throw new Error(`writeReceiptBounded: ${label} path identity changed`);
  }

  const procPhysical = fs.realpathSync(rootProcPath);
  if (procPhysical !== rootPath || !isPathWithinRoot(rootPath, procPhysical)) {
    throw new Error(`writeReceiptBounded: ${label} fd moved or escaped its canonical path`);
  }
  const procStat = fs.statSync(rootProcPath);
  if (!procStat.isDirectory() || !sameDirectoryIdentity(procStat, actual)) {
    throw new Error(`writeReceiptBounded: ${label} proc-fd identity mismatch`);
  }
}

function assertBoundedOpenedTarget(
  fd: number,
  procPath: string,
  targetPath: string,
  rootPath: string,
  expectedPath: string,
  expected: DirectoryIdentity,
  label: string,
): void {
  const actual = fs.fstatSync(fd);
  if (!actual.isDirectory() || !sameDirectoryIdentity(actual, expected)) {
    throw new Error(`writeReceiptBounded: ${label} fd identity mismatch`);
  }

  const rawEntry = fs.lstatSync(expectedPath);
  if (rawEntry.isSymbolicLink() || !rawEntry.isDirectory() || !sameDirectoryIdentity(rawEntry, actual)) {
    throw new Error(`writeReceiptBounded: ${label} raw path identity changed`);
  }

  const targetEntry = fs.lstatSync(targetPath);
  // `/proc/self/fd/<rootfd>` is itself the expected proc symlink when the
  // receipt directory is the Trust Root.  For every child target, the final
  // component must still be a real directory and not a symlink.
  if (expectedPath !== rootPath && (targetEntry.isSymbolicLink() || !targetEntry.isDirectory())) {
    throw new Error(`writeReceiptBounded: ${label} root-relative target is not a directory`);
  }

  const procPhysical = fs.realpathSync(procPath);
  if (procPhysical !== expectedPath || !isPathWithinRoot(rootPath, procPhysical)) {
    throw new Error(`writeReceiptBounded: ${label} moved or escaped its root anchor`);
  }
  const procStat = fs.statSync(procPath);
  if (!procStat.isDirectory() || !sameDirectoryIdentity(procStat, actual)) {
    throw new Error(`writeReceiptBounded: ${label} proc-fd identity mismatch`);
  }
}

/**
 * Re-open every target component from the verified root anchor.  Checking the
 * final directory alone would allow a swapped intermediate parent symlink to
 * redirect a root-relative child path, so each component is opened with
 * `O_NOFOLLOW` and its `/proc` identity is compared with the canonical prefix.
 */
function assertBoundedTargetComponentsStable(
  directory: BoundedReceiptDirectoryHandle,
): void {
  for (let index = 0; index < directory.targetComponents.length; index += 1) {
    const prefixComponents = directory.targetComponents.slice(0, index + 1);
    const expectedPrefix = path.join(directory.rootPath, ...prefixComponents);
    const anchoredPrefix = path.join(directory.rootProcPath, ...prefixComponents);
    let componentFd: number | undefined;
    try {
      componentFd = fs.openSync(
        anchoredPrefix,
        (boundedConstant('O_RDONLY') as number) |
          (boundedConstant('O_DIRECTORY') as number) |
          (boundedConstant('O_NOFOLLOW') as number),
      );
      assertBoundedOpenedTarget(
        componentFd,
        `/proc/self/fd/${componentFd}`,
        anchoredPrefix,
        directory.rootPath,
        expectedPrefix,
        fs.fstatSync(componentFd),
        `root-relative target component ${index}`,
      );
    } finally {
      if (componentFd !== undefined) {
        try { fs.closeSync(componentFd); } catch { /* best-effort */ }
      }
    }
  }
}

function assertBoundedDirectoryStable(directory: BoundedReceiptDirectoryHandle): void {
  assertBoundedRootFd(
    directory.rootfd,
    directory.rootProcPath,
    directory.rootPath,
    { dev: directory.rootDev, ino: directory.rootIno },
    'project root',
  );
  assertBoundedTargetComponentsStable(directory);

  const targetPath = boundedTargetPath(directory);
  let checkedFd: number | undefined;
  try {
    checkedFd = fs.openSync(
      targetPath,
      (boundedConstant('O_RDONLY') as number) |
        (boundedConstant('O_DIRECTORY') as number) |
        (boundedConstant('O_NOFOLLOW') as number),
    );
    assertBoundedOpenedTarget(
      checkedFd,
      `/proc/self/fd/${checkedFd}`,
      targetPath,
      directory.rootPath,
      directory.binding.path,
      { dev: directory.binding.dev, ino: directory.binding.ino },
      'root-relative receipt target',
    );

    const boundFdStat = fs.fstatSync(directory.dirfd);
    if (
      !boundFdStat.isDirectory() ||
      !sameDirectoryIdentity(boundFdStat, {
        dev: directory.binding.dev,
        ino: directory.binding.ino,
      }) ||
      !sameDirectoryIdentity(boundFdStat, fs.fstatSync(checkedFd))
    ) {
      throw new Error('writeReceiptBounded: bound receipt directory fd identity changed');
    }
  } catch (err) {
    throw new Error(
      `writeReceiptBounded: bounded directory is not stable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    if (checkedFd !== undefined) {
      try { fs.closeSync(checkedFd); } catch { /* best-effort */ }
    }
  }
}

function fsyncBoundedTarget(
  directory: BoundedReceiptDirectoryHandle,
  lock: BoundedLockDirectoryHandle,
): void {
  assertBoundedLockStable(directory, lock);
  const targetPath = boundedTargetPath(directory);
  let targetFd: number | undefined;
  try {
    targetFd = fs.openSync(
      targetPath,
      (boundedConstant('O_RDONLY') as number) |
        (boundedConstant('O_DIRECTORY') as number) |
        (boundedConstant('O_NOFOLLOW') as number),
    );
    assertBoundedOpenedTarget(
      targetFd,
      `/proc/self/fd/${targetFd}`,
      targetPath,
      directory.rootPath,
      directory.binding.path,
      { dev: directory.binding.dev, ino: directory.binding.ino },
      'fsync receipt target',
    );
    fs.fsyncSync(targetFd);
    assertBoundedLockStable(directory, lock);
  } finally {
    if (targetFd !== undefined) {
      try { fs.closeSync(targetFd); } catch { /* best-effort */ }
    }
  }
}

function verifyBoundedReceiptChain(
  directory: BoundedReceiptDirectoryHandle,
  lock: BoundedLockDirectoryHandle,
): ChainVerificationResult {
  assertBoundedLockStable(directory, lock);
  const result = verifyReceiptChainWithReader(
    boundedTargetPath(directory),
    boundedReceiptReader(),
  );
  assertBoundedLockStable(directory, lock);
  return result;
}

function boundedReceiptReader(): ReceiptReadOperations {
  return {
    readText: boundedReadReceiptText,
    verifyDigest: verifyBoundedReceiptDigest,
  };
}

function boundedReadReceiptText(filePath: string): string {
  const readFlags =
    (boundedConstant('O_RDONLY') as number) |
    (boundedConstant('O_NOFOLLOW') as number) |
    (boundedConstant('O_NONBLOCK') as number);
  let fd: number;
  try {
    fd = fs.openSync(filePath, readFlags);
  } catch (err) {
    throw new Error(
      `writeReceiptBounded: cannot no-follow read receipt: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error('writeReceiptBounded: receipt entry is not a regular file');
    }
    return fs.readFileSync(fd, 'utf-8');
  } finally {
    try { fs.closeSync(fd); } catch { /* best-effort */ }
  }
}

function verifyBoundedReceiptDigest(filePath: string): boolean {
  try {
    return verifyReceiptDigestText(boundedReadReceiptText(filePath));
  } catch {
    return false;
  }
}

function readBoundedStoredDigest(filePath: string): string {
  try {
    const parsed = JSON.parse(boundedReadReceiptText(filePath)) as Record<string, unknown>;
    return typeof parsed.digest === 'string' ? parsed.digest : '(missing or invalid)';
  } catch {
    return '(unreadable)';
  }
}

function boundedEntryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

/**
 * Capture a Receipt entry identity while the bounded writer still owns the
 * directory lock.  The final path is a root-fd-relative path and the file is
 * opened with `O_NOFOLLOW`; the subsequent lstat/fstat comparison prevents a
 * replacement between the no-follow open and the identity snapshot from being
 * returned as the writer's Receipt.
 */
function captureBoundedReceiptFile(
  directory: BoundedReceiptDirectoryHandle,
  lock: BoundedLockDirectoryHandle,
  entryName: string,
): ReceiptFileBinding {
  assertBoundedLockStable(directory, lock);
  const filePath = boundedEntryPath(directory, entryName);
  const flags =
    (boundedConstant('O_RDONLY') as number) |
    (boundedConstant('O_NOFOLLOW') as number) |
    (boundedConstant('O_NONBLOCK') as number);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, flags);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error(
        `writeReceiptBounded: installed Receipt entry is not a regular file: ${entryName}`,
      );
    }

    const entry = fs.lstatSync(filePath);
    if (
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      entry.dev !== opened.dev ||
      entry.ino !== opened.ino ||
      entry.nlink !== opened.nlink ||
      entry.size !== opened.size
    ) {
      throw new Error(
        `writeReceiptBounded: installed Receipt entry identity changed while being captured: ${entryName}`,
      );
    }

    return {
      name: entryName,
      dev: opened.dev,
      ino: opened.ino,
      nlink: opened.nlink,
      size: opened.size,
    };
  } catch (err) {
    throw new Error(
      `writeReceiptBounded: cannot capture writer-time Receipt identity for ${entryName}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
  }
}

interface BoundedReceiptCleanupResult {
  ok: boolean;
  reason?: string;
}

function boundedReceiptIdentityMatches(
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
 * Delete only the Receipt entry whose writer-time identity was captured above.
 *
 * The operation is deliberately fail-closed: the parent is revalidated
 * through the already-open Trust Root and lock bindings, the final component
 * is lstat'ed without following symlinks, and any dev/ino/nlink/size mismatch
 * leaves the entry untouched.  No canonical raw target path is used as a
 * fallback when a bound check fails.
 */
function cleanupBoundedReceipt(
  directory: BoundedReceiptDirectoryHandle,
  lock: BoundedLockDirectoryHandle,
  receiptFile: ReceiptFileBinding,
): BoundedReceiptCleanupResult {
  let entryPath: string;
  try {
    assertBoundedLockStable(directory, lock);
    entryPath = boundedEntryPath(directory, receiptFile.name);

    let current: fs.Stats;
    try {
      current = fs.lstatSync(entryPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true };
      }
      throw err;
    }

    if (path.basename(entryPath) !== receiptFile.name) {
      return {
        ok: false,
        reason: 'cleanup skipped: Receipt entry name no longer matches the writer-time binding',
      };
    }
    if (!boundedReceiptIdentityMatches(current, receiptFile)) {
      return {
        ok: false,
        reason:
          'cleanup skipped: Receipt entry identity mismatch (dev/ino/nlink/size); ownership cannot be proven',
      };
    }

    // Repeat the bound-parent and entry checks immediately before unlink.  The
    // bound root/lock check prevents a moved or replacement directory from
    // becoming the cleanup target; the final component remains no-follow.
    assertBoundedLockStable(directory, lock);
    let last: fs.Stats;
    try {
      last = fs.lstatSync(entryPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: true };
      }
      throw err;
    }
    if (!boundedReceiptIdentityMatches(last, receiptFile)) {
      return {
        ok: false,
        reason:
          'cleanup skipped: Receipt entry changed before unlink; ownership cannot be proven',
      };
    }

    fs.unlinkSync(entryPath);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `cleanup failed closed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Preserve the original failure while honestly declaring an uncompleted cleanup. */
function withBoundedReceiptCleanupOutcome(
  error: unknown,
  cleanup: BoundedReceiptCleanupResult,
): Error {
  if (cleanup.ok) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const originalMessage = error instanceof Error ? error.message : String(error);
  const cleanupMessage =
    `writeReceiptBounded: Receipt persisted after install, but cleanup was not completed; ` +
    `${cleanup.reason ?? 'ownership could not be proven'}`;
  const message = `${originalMessage}; ${cleanupMessage}`;

  if (error instanceof ReceiptChainError) {
    const detail = [error.detail, cleanupMessage].filter(Boolean).join('; ');
    return new ReceiptChainError(message, error.subtype, error.digest, detail);
  }
  if (error instanceof Error) {
    // Keep the original Error class/name (and therefore existing callers'
    // classification) while making the residual Receipt state explicit.
    error.message = message;
    return error;
  }
  return new Error(message);
}

function writeBoundedTempFile(
  filePath: string,
  content: string,
  verifyStable: () => void,
): void {
  const flags =
    (boundedConstant('O_WRONLY') as number) |
    (boundedConstant('O_CREAT') as number) |
    (boundedConstant('O_EXCL') as number) |
    (boundedConstant('O_NOFOLLOW') as number);
  writeBoundedExclusiveFile(filePath, content, flags, 'receipt temp file', verifyStable);
}

function writeBoundedExclusiveFile(
  filePath: string,
  content: string,
  flags: number,
  artifactName: string,
  verifyStable?: () => void,
): void {
  let fd: number | undefined;
  let created = false;
  try {
    verifyStable?.();
    fd = fs.openSync(filePath, flags, 0o600);
    created = true;
    verifyStable?.();
    const bytes = Buffer.from(content, 'utf-8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) {
        throw new Error(`writeReceiptBounded: short write while creating ${artifactName}`);
      }
      offset += written;
    }
    fs.fsyncSync(fd);
    // A replacement can be injected while the file is being fsynced.  Check
    // the bound directory/fd once more before closing the metadata/temp fd;
    // callers then fail closed instead of moving on with an unstable entry.
    verifyStable?.();
    fs.closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
    if (created) {
      let safeToCleanup = true;
      if (verifyStable !== undefined) {
        try { verifyStable(); } catch { safeToCleanup = false; }
      }
      if (safeToCleanup) {
        try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      }
    }
    throw err;
  }
}

function isReceiptDigestFilename(digest: string): boolean {
  return /^[0-9a-f]{64}$/.test(digest);
}

function assertBoundedChainValid(result: ChainVerificationResult, phase: string): void {
  if (result.valid) return;
  const detail = result.brokenLink
    ? `broken link at index ${result.brokenLink.index}: expected ${result.brokenLink.expected}, got ${result.brokenLink.actual}`
    : result.duplicateDigests && result.duplicateDigests.length > 0
      ? `duplicate digests: ${result.duplicateDigests.map((entry) => entry.digest).join(', ')}`
      : 'chain verification failed';
  throw new ReceiptChainError(
    `writeReceiptBounded: chain integrity check failed ${phase} — ${detail}`,
    'chain',
    undefined,
    detail,
  );
}

function writeBoundedLockOwnerMetadata(
  directory: BoundedReceiptDirectoryHandle,
  lock: BoundedLockDirectoryHandle,
): void {
  const owner: { pid: number; startedAt: number; startTimeTicks?: number } = {
    pid: process.pid,
    startedAt: Date.now() - Math.round(process.uptime() * 1000),
  };
  const startTimeTicks = readProcStartTimeTicks(process.pid);
  if (startTimeTicks !== undefined) {
    owner.startTimeTicks = startTimeTicks;
  }

  const flags =
    (boundedConstant('O_WRONLY') as number) |
    (boundedConstant('O_CREAT') as number) |
    (boundedConstant('O_EXCL') as number) |
    (boundedConstant('O_NOFOLLOW') as number);
  const verifyLockStable = () => assertBoundedLockStable(directory, lock);
  writeBoundedExclusiveFile(
    boundedLockFilePath(lock, LOCK_OWNER_FILENAME),
    `${JSON.stringify(owner)}\n`,
    flags,
    'bounded lock owner metadata',
    verifyLockStable,
  );
  writeBoundedExclusiveFile(
    boundedLockFilePath(lock, LOCK_CREATED_AT_FILENAME),
    `${new Date().toISOString()}\n`,
    flags,
    'bounded lock creation metadata',
    verifyLockStable,
  );
}

function acquireBoundedLock(
  directory: BoundedReceiptDirectoryHandle,
  verifyChain: () => ChainVerificationResult,
  verifyStable: () => void,
): BoundedLockDirectoryHandle {
  const lockEntryPath = boundedEntryPath(directory, '.receipt-lock');
  let lock: BoundedLockDirectoryHandle | undefined;
  let created = false;
  try {
    verifyStable();
    try {
      fs.mkdirSync(lockEntryPath, { recursive: false });
      created = true;
      // Bind the lock immediately after creation.  No metadata operation is
      // allowed to use the root-relative entry until this no-follow fd has
      // passed its dev/ino and containment checks.
      lock = openBoundedLock(directory);
      writeBoundedLockOwnerMetadata(directory, lock);
      return lock;
    } catch (err) {
      if (created) {
        if (lock !== undefined) {
          closeBoundedLock(lock);
          lock = undefined;
        }
        throw err;
      }
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    }

    // An existing entry is opened and identity-checked before any stale
    // read.  A symlink or an outside replacement therefore fails closed and
    // cannot be followed by owner.pid or mtime logic.
    lock = openBoundedLock(directory);
    const ownerMeta = readBoundedLockOwnerMetadata(directory, lock);
    const ownerPid = ownerMeta.pid;
    let stale: boolean;
    let contentionDetail: string;
    if (ownerPid === undefined) {
      const lockStat = fs.fstatSync(lock.fd);
      const age = Date.now() - lockStat.mtimeMs;
      stale = age >= DEFAULT_LOCK_TIMEOUT_MS;
      contentionDetail =
        `lock age ${Math.round(age)}ms < timeout ${DEFAULT_LOCK_TIMEOUT_MS}ms ` +
        '(no owner.pid — legacy lock format)';
    } else {
      stale = !isProcessAlive(ownerPid);
      contentionDetail = `lock owner pid ${ownerPid} is alive`;
      if (!stale && ownerMeta.startTimeTicks !== undefined) {
        const currentStartTimeTicks = readProcStartTimeTicks(ownerPid);
        if (currentStartTimeTicks !== undefined && currentStartTimeTicks !== ownerMeta.startTimeTicks) {
          stale = true;
          contentionDetail =
            `lock owner pid ${ownerPid} reused (start-time ${ownerMeta.startTimeTicks} → ${currentStartTimeTicks})`;
        } else if (currentStartTimeTicks === undefined) {
          contentionDetail = `lock owner pid ${ownerPid} is alive (no /proc start-time — PID-only fallback)`;
        } else {
          contentionDetail = `lock owner pid ${ownerPid} is alive (start-time matched)`;
        }
      }
    }

    if (!stale) {
      throw new ReceiptChainError(
        `writeReceiptBounded: another write operation is in progress — lock directory exists at ${lockEntryPath}`,
        'predecessor',
        undefined,
        contentionDetail,
      );
    }

    const currentMeta = readBoundedLockOwnerMetadata(directory, lock);
    if (lockMetadataChanged(currentMeta, ownerMeta)) {
      throw new ReceiptChainError(
        'writeReceiptBounded: lock owner metadata changed during stale recovery',
        'predecessor',
      );
    }

    removeBoundedLock(directory, lock);
    closeBoundedLock(lock);
    lock = undefined;
    created = false;
    verifyStable();
    fs.mkdirSync(lockEntryPath, { recursive: false });
    created = true;
    lock = openBoundedLock(directory);
    writeBoundedLockOwnerMetadata(directory, lock);
    assertBoundedLockStable(directory, lock);
    const chain = verifyChain();
    assertBoundedLockStable(directory, lock);
    if (!chain.valid) {
      removeBoundedLock(directory, lock);
      closeBoundedLock(lock);
      lock = undefined;
      assertBoundedChainValid(chain, 'after stale lock recovery');
    }
    if (lock === undefined) {
      throw new Error('writeReceiptBounded: bounded lock disappeared during acquisition');
    }
    return lock;
  } catch (err) {
    if (lock !== undefined) {
      closeBoundedLock(lock);
    }
    if (err instanceof ReceiptChainError) {
      throw err;
    }
    if (created) {
      throw err;
    }
    throw new ReceiptChainError(
      `writeReceiptBounded: another write operation is in progress — lock directory exists at ${lockEntryPath}`,
      'predecessor',
    );
  }
}

/**
 * Compute the SHA-256 digest of a data object using canonical JSON.
 *
 * The digest is computed over the canonical JSON representation of the input
 * data with sorted keys. This ensures content-addressing: identical data
 * always produces the same digest.
 *
 * @param data - The data object to digest. Must be a plain object (not null,
 *   array, or primitive).
 * @returns 64-character hex SHA-256 digest string.
 * @throws {TypeError} If data is not a plain object.
 */
export function computeReceiptDigest(data: object): string {
  if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
    throw new TypeError('computeReceiptDigest: data must be a non-null, non-array object');
  }

  const json = canonicalJson(data);
  return crypto.createHash('sha256').update(json, 'utf-8').digest('hex');
}

/**
 * Verify that a receipt file's stored digest matches its content.
 *
 * Reads the JSON file, computes the expected digest from all fields except
 * `digest` itself (to avoid circular dependency), and compares it with the
 * stored `digest` field.
 *
 * @param filePath - Path to the receipt JSON file.
 * @returns True if the digest matches, false otherwise (file not found,
 *   malformed JSON, missing digest field, or digest mismatch).
 */
export function verifyReceiptDigest(filePath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return false;
  }

  return verifyReceiptDigestText(raw);
}

/** Verify a receipt digest from already-read text. */
function verifyReceiptDigestText(raw: string): boolean {

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return false;
  }

  const storedDigest = data.digest;
  if (typeof storedDigest !== 'string' || storedDigest.length === 0) {
    return false;
  }

  // Compute digest over all fields except 'digest'
  const { digest: _digest, ...content } = data;
  let computedDigest: string;
  try {
    computedDigest = computeReceiptDigest(content);
  } catch {
    return false;
  }

  return computedDigest === storedDigest;
}

interface ReceiptReadOperations {
  readText(filePath: string): string;
  verifyDigest(filePath: string): boolean;
}

/**
 * Walk all receipts in a directory, verifying the previous_digest chain.
 *
 * Reads every `.json` file in the given directory, verifies each receipt's
 * self-digest (using `verifyReceiptDigest`), and then checks that the
 * `previous_digest` links form a valid chain. The chain is walked by finding
 * receipts with no `previous_digest` (genesis receipts) and following links.
 *
 * Multiple chains can coexist in the same directory; each is independently
 * verified. The result reports all receipts found in order.
 *
 * @param receiptDir - Path to the directory containing receipt JSON files.
 * @returns ChainVerificationResult indicating validity and chain details.
 */
export function verifyReceiptChain(receiptDir: string): ChainVerificationResult {
  return verifyReceiptChainWithReader(receiptDir, {
    readText: (filePath) => fs.readFileSync(filePath, 'utf-8'),
    verifyDigest: verifyReceiptDigest,
  });
}

function verifyReceiptChainWithReader(
  receiptDir: string,
  reader: ReceiptReadOperations,
): ChainVerificationResult {
  let filenames: string[];
  try {
    filenames = fs.readdirSync(receiptDir);
  } catch {
    // Directory does not exist or cannot be read — treat as empty
    return { valid: true, receipts: [] };
  }

  // Filter to .json files, sorted for deterministic ordering
  const jsonFiles = filenames
    .filter((f) => f.endsWith('.json'))
    .sort();

  if (jsonFiles.length === 0) {
    return { valid: true, receipts: [] };
  }

  // Collect all entries (a digest may appear in multiple files)
  interface Entry {
    filePath: string;
    filename: string;
    receipt: Record<string, unknown>;
    digest: string;
  }
  const allEntries: Entry[] = [];
  // Map from digest to first entry (used for chain walk)
  const byDigest = new Map<string, Entry>();
  // Collect all filenames per digest for duplicate detection
  const filesByDigest = new Map<string, string[]>();

  // Phase 1: Read, validate schema, and verify self-digests
  for (const filename of jsonFiles) {
    const filePath = path.join(receiptDir, filename);

    // Read file content
    let raw: string;
    try {
      raw = reader.readText(filePath);
    } catch {
      return {
        valid: false,
        receipts: [filePath],
        brokenLink: { index: 0, expected: '(read)', actual: 'cannot read receipt file' },
      };
    }

    // Parse JSON
    let receipt: Record<string, unknown>;
    try {
      receipt = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {
        valid: false,
        receipts: [filePath],
        brokenLink: { index: 0, expected: '(parse)', actual: 'invalid JSON in receipt file' },
      };
    }

    // Schema validation before digest check (Requirement 2)
    try {
      validateReceipt(receipt);
    } catch (err: unknown) {
      if (err instanceof SchemaValidationError) {
        return {
          valid: false,
          receipts: [filePath],
          brokenLink: { index: 0, expected: '(schema)', actual: err.message },
        };
      }
      throw err;
    }

    // Self-digest verification
    if (!reader.verifyDigest(filePath)) {
      return {
        valid: false,
        receipts: [filePath],
        brokenLink: { index: 0, expected: '(self-digest)', actual: 'stored digest does not match computed digest' },
      };
    }

    const digest = receipt.digest as string;

    allEntries.push({ filePath, filename, receipt, digest });

    // Track files per digest (for duplicate detection)
    const existingFiles = filesByDigest.get(digest) ?? [];
    existingFiles.push(filename);
    filesByDigest.set(digest, existingFiles);

    // Only set byDigest on first encounter (keep first file for chain walk)
    if (!byDigest.has(digest)) {
      byDigest.set(digest, { filePath, filename, receipt, digest });
    }
  }

  // Phase 1b: Check for duplicate digests (same digest under different filenames)
  const duplicateDigests: Array<{ digest: string; paths: string[] }> = [];
  for (const [digest, filenames] of filesByDigest) {
    if (filenames.length > 1) {
      const paths = filenames.map(f => path.join(receiptDir, f));
      duplicateDigests.push({ digest, paths });
    }
  }

  // Phase 2: Verify previous_digest link integrity
  // For every non-genesis receipt, its previous_digest must exist in the directory
  let brokenLink: { index: number; expected: string; actual: string } | undefined;

  // Use the first entry per digest for link checking
  for (const [, { receipt }] of byDigest) {
    const prevDigest = receipt.previous_digest;
    if (prevDigest !== undefined && prevDigest !== null && prevDigest !== '') {
      if (!byDigest.has(prevDigest as string)) {
        // previous_digest references a digest not found in the directory
        const allDigests = Array.from(byDigest.keys());
        const idx = allDigests.indexOf((receipt as Record<string, unknown>).digest as string);
        brokenLink = {
          index: brokenLink ? brokenLink.index : idx >= 0 ? idx : 0,
          expected: prevDigest as string,
          actual: '(not found in directory)',
        };
        break;
      }
    }
  }

  // Phase 3: Walk chains from genesis receipts (no previous_digest)
  const visited = new Set<string>();
  const orderedReceipts: string[] = [];

  // Find all genesis digests (no previous_digest)
  const genesisDigests: string[] = [];
  for (const [digest, { receipt }] of byDigest) {
    const prevDigest = receipt.previous_digest;
    if (prevDigest === undefined || prevDigest === null || prevDigest === '') {
      genesisDigests.push(digest);
    }
  }

  // Sort genesis digests for determinism
  genesisDigests.sort();

  // Walk each chain starting from a genesis
  for (const genesisDigest of genesisDigests) {
    if (visited.has(genesisDigest)) continue;

    let currentDigest: string | undefined = genesisDigest;
    while (currentDigest !== undefined) {
      if (visited.has(currentDigest)) {
        // Circular reference — break
        if (!brokenLink) {
          brokenLink = {
            index: orderedReceipts.length,
            expected: currentDigest,
            actual: '(circular reference)',
          };
        }
        break;
      }

      const entry = byDigest.get(currentDigest);
      if (!entry) {
        break;
      }

      visited.add(currentDigest);
      orderedReceipts.push(entry.filePath);

      // Find receipts whose previous_digest points to this digest (forward link)
      const nextDigests = findReceiptsPointingTo(byDigest, currentDigest, visited);

      if (nextDigests.length === 0) {
        currentDigest = undefined; // End of chain
      } else {
        // Take the first (sorted for determinism)
        currentDigest = nextDigests[0];
      }
    }
  }

  // Phase 4: Check for any unvisited receipts (orphans — have previous_digest
  // but their parent was never found, or circular clusters not reachable from
  // a genesis)
  for (const [digest, { filePath, receipt }] of byDigest) {
    if (!visited.has(digest)) {
      orderedReceipts.push(filePath);
      if (!brokenLink) {
        const prevDigest = receipt.previous_digest as string | undefined;
        brokenLink = {
          index: orderedReceipts.length - 1,
          expected: prevDigest ?? '(genesis)',
          actual: byDigest.has(prevDigest as string) ? '(orphan — not reachable from genesis)' : '(not found in directory)',
        };
      }
    }
  }

  const hasFailure = brokenLink !== undefined || duplicateDigests.length > 0;

  return {
    valid: !hasFailure,
    receipts: orderedReceipts,
    brokenLink,
    duplicateDigests: duplicateDigests.length > 0 ? duplicateDigests : undefined,
  };
}

/**
 * Throw a ReceiptChainError if chain verification finds any failure.
 *
 * Convenience wrapper around verifyReceiptChain that throws on the first
 * detected failure instead of returning a result object.
 *
 * @param receiptDir - Path to the directory containing receipt JSON files.
 * @throws {ReceiptChainError} If the chain has broken links or duplicate digests.
 */
export function assertValidReceiptChain(receiptDir: string): void {
  const result = verifyReceiptChain(receiptDir);
  if (result.valid) return;

  if (result.brokenLink) {
    const expected = result.brokenLink.expected;
    const actual = result.brokenLink.actual;

    // Determine subtype based on the failure type encoded in expected
    let subtype: 'duplicate' | 'fork' | 'predecessor' | 'chain' | 'self_digest' = 'chain';
    if (expected === '(self-digest)') {
      subtype = 'self_digest';
    } else if (expected === '(schema)') {
      subtype = 'self_digest';
    } else if (expected === '(read)' || expected === '(parse)') {
      subtype = 'self_digest';
    }

    throw new ReceiptChainError(
      `Receipt chain verification failed at index ${result.brokenLink.index}: ` +
      `expected ${expected}, got ${actual}`,
      subtype,
      expected.startsWith('(') ? undefined : expected,
      actual,
    );
  }

  if (result.duplicateDigests && result.duplicateDigests.length > 0) {
    const first = result.duplicateDigests[0];
    throw new ReceiptChainError(
      `Receipt chain verification failed: duplicate digest ${first.digest} found in ${first.paths.length} files`,
      'duplicate',
      first.digest,
      `paths: ${first.paths.join(', ')}`,
    );
  }

  // Fallback: valid=false with no brokenLink or duplicateDigests
  throw new ReceiptChainError(
    `Receipt chain verification failed: ${result.receipts.length > 0 ? `invalid state for receipt at ${result.receipts[0]}` : 'unknown reason'}`,
    'self_digest',
  );
}

/**
 * Find receipts whose `previous_digest` field points to the given digest.
 *
 * @param byDigest - Map of digest to receipt entry.
 * @param targetDigest - The digest to search for.
 * @param exclude - Set of digests to exclude (already visited).
 * @returns Array of matching digests, sorted for determinism.
 */
function findReceiptsPointingTo(
  byDigest: Map<string, { filePath: string; receipt: Record<string, unknown> }>,
  targetDigest: string,
  exclude: Set<string>,
): string[] {
  const results: string[] = [];
  for (const [digest, { receipt }] of byDigest) {
    if (exclude.has(digest)) continue;
    const prev = receipt.previous_digest;
    if (prev === targetDigest) {
      results.push(digest);
    }
  }
  return results.sort();
}
