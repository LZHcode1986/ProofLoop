"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_LOCK_TIMEOUT_MS = void 0;
exports.writeReceipt = writeReceipt;
exports.computeReceiptDigest = computeReceiptDigest;
exports.verifyReceiptDigest = verifyReceiptDigest;
exports.verifyReceiptChain = verifyReceiptChain;
exports.assertValidReceiptChain = assertValidReceiptChain;
const crypto = __importStar(require("node:crypto"));
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const validators_1 = require("./validators");
const errors_1 = require("./errors");
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
exports.DEFAULT_LOCK_TIMEOUT_MS = 10_000;
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
 */
function canonicalJson(value) {
    if (value === null || value === undefined) {
        return 'null';
    }
    if (typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        // NaN and Infinity are not valid JSON values — reject them early
        if (!Number.isFinite(value)) {
            throw new TypeError(`Cannot canonicalize non-finite number: ${value}`);
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
        const obj = value;
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
function isChainTip(receiptDir, expectedPreviousDigest) {
    let files;
    try {
        files = fs.readdirSync(receiptDir);
    }
    catch {
        return true;
    }
    for (const file of files) {
        if (!file.endsWith('.json') || file.startsWith('.'))
            continue;
        try {
            const content = JSON.parse(fs.readFileSync(path.join(receiptDir, file), 'utf-8'));
            // If another receipt's previous_digest points to our digest, it is not
            // the tip.  Exclude self-references (receipt pointing to itself).
            if (content.previous_digest === expectedPreviousDigest &&
                content.digest !== expectedPreviousDigest) {
                return false;
            }
        }
        catch {
            // skip unreadable files
        }
    }
    return true;
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
function writeLockOwnerMetadata(lockDir) {
    const owner = {
        pid: process.pid,
        startedAt: Date.now() - Math.round(process.uptime() * 1000),
    };
    const startTimeTicks = readProcStartTimeTicks(process.pid);
    if (startTimeTicks !== undefined) {
        owner.startTimeTicks = startTimeTicks;
    }
    fs.writeFileSync(path.join(lockDir, LOCK_OWNER_FILENAME), `${JSON.stringify(owner)}\n`, 'utf-8');
    fs.writeFileSync(path.join(lockDir, LOCK_CREATED_AT_FILENAME), `${new Date().toISOString()}\n`, 'utf-8');
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
function readProcStartTimeTicks(pid) {
    let raw;
    try {
        raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    }
    catch {
        return undefined;
    }
    // Format: "pid (comm) state ppid ... starttime ...".  The comm may itself
    // contain spaces/parentheses, so parse from the LAST ')' and index field 22
    // (starttime) relative to the post-comm fields (state = field 3 → index 0).
    const closeParen = raw.lastIndexOf(')');
    if (closeParen < 0)
        return undefined;
    const after = raw.slice(closeParen + 1).trim().split(/\s+/);
    const starttimeRaw = after[19]; // field 22 overall (22 - 3)
    const ticks = Number(starttimeRaw);
    return Number.isFinite(ticks) && ticks >= 0 ? ticks : undefined;
}
/**
 * Read the lock owner metadata from a lock directory's `owner.pid` file.
 *
 * Supports the current JSON format (`{"pid": <number>, "startedAt": <number>,
 * "startTimeTicks": <number>}`) as well as a legacy bare-integer format
 * (PID only, no start-time → PID-only judgement fallback).
 */
function readLockOwnerMetadata(lockDir) {
    let raw;
    try {
        raw = fs.readFileSync(path.join(lockDir, LOCK_OWNER_FILENAME), 'utf-8');
    }
    catch {
        return {};
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
        return {};
    }
    // Current format: {"pid": <number>, "startedAt": <number>, "startTimeTicks": <number>}
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === 'object' && parsed !== null) {
            const pid = typeof parsed.pid === 'number' &&
                Number.isInteger(parsed.pid) &&
                parsed.pid > 0
                ? parsed.pid
                : undefined;
            const startTimeTicks = typeof parsed.startTimeTicks === 'number' &&
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
    }
    catch {
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
function lockMetadataChanged(current, decision) {
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
function readLockOwnerPid(lockDir) {
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
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        const code = err?.code;
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
function writeReceipt(data, options) {
    // Validate data
    if (data === null || data === undefined || typeof data !== 'object' || Array.isArray(data)) {
        throw new TypeError('writeReceipt: data must be a non-null, non-array object');
    }
    const rawData = data;
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
            throw new Error(`writeReceipt: caller-supplied digest "${callerStr}" does not match ` +
                `computed digest "${digest}"`);
        }
    }
    // Build the full data with the computed digest
    const fullData = { ...content, digest };
    // ── Schema validation ──────────────────────────────────────────────
    // Call validateReceipt before writing to ensure the artifact conforms
    // to the canonical Receipt contract (§4 File / Artifact Contracts).
    try {
        (0, validators_1.validateReceipt)(fullData);
    }
    catch (err) {
        if (err instanceof validators_1.SchemaValidationError) {
            throw new Error(`writeReceipt: receipt validation failed: ${err.message}`);
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
        throw new errors_1.ReceiptChainError(`writeReceipt: chain integrity check failed before write — ${detail}`, 'chain', undefined, detail);
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
    }
    catch (err) {
        if (lockAcquired) {
            // mkdir succeeded but the owner metadata could not be written.
            // Remove the lock so we do not leak a lock that other writers can
            // only evaluate through the mtime fallback.  This is OUR own just-
            // created lock (owner.pid was never written, so the F1 ownership
            // guard cannot apply — the directory is milliseconds old and cannot
            // have been replaced by another kernel acquisition, which always
            // writes owner.pid).
            try {
                fs.rmSync(lockDir, { recursive: true, force: true });
            }
            catch { /* best-effort */ }
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
                let stale;
                let contentionDetail;
                if (ownerPid === undefined) {
                    const lockStat = fs.statSync(lockDir);
                    const age = Date.now() - lockStat.mtimeMs;
                    stale = age >= exports.DEFAULT_LOCK_TIMEOUT_MS;
                    contentionDetail =
                        `lock age ${Math.round(age)}ms < timeout ${exports.DEFAULT_LOCK_TIMEOUT_MS}ms ` +
                            `(no owner.pid — legacy lock format)`;
                }
                else {
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
                        if (currentStartTimeTicks !== undefined &&
                            currentStartTimeTicks !== ownerMeta.startTimeTicks) {
                            stale = true;
                            contentionDetail =
                                `lock owner pid ${ownerPid} reused (start-time ` +
                                    `${ownerMeta.startTimeTicks} → ${currentStartTimeTicks})`;
                        }
                        else if (currentStartTimeTicks === undefined) {
                            contentionDetail =
                                `lock owner pid ${ownerPid} is alive (no /proc start-time — PID-only fallback)`;
                        }
                        else {
                            contentionDetail = `lock owner pid ${ownerPid} is alive (start-time matched)`;
                        }
                    }
                    else {
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
                            throw new errors_1.ReceiptChainError(`writeReceipt: another write operation is in progress — lock directory exists at ${lockDir}`, 'predecessor', undefined, `lock owner metadata changed during stale recovery (decision pid ${String(ownerMeta.pid)} startTimeTicks ${String(ownerMeta.startTimeTicks)} → now pid ${String(currentMeta.pid)} startTimeTicks ${String(currentMeta.startTimeTicks)})`);
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
                        throw new errors_1.ReceiptChainError(`writeReceipt: stale lock removed but chain is corrupted`, 'chain', undefined, `Stale lock recovery revealed chain integrity failure`);
                    }
                }
                else {
                    throw new errors_1.ReceiptChainError(`writeReceipt: another write operation is in progress — lock directory exists at ${lockDir}`, 'predecessor', undefined, contentionDetail);
                }
            }
            catch (innerErr) {
                // If the stat, rmdir, or retry mkdir fails, propagate the
                // original lock-contention error unless the inner error is
                // already a ReceiptChainError we created above.
                if (innerErr instanceof errors_1.ReceiptChainError) {
                    throw innerErr;
                }
                throw new errors_1.ReceiptChainError(`writeReceipt: another write operation is in progress — lock directory exists at ${lockDir}`, 'predecessor');
            }
        }
        else {
            throw err;
        }
    }
    try {
        // ── Duplicate rejection ────────────────────────────────────────────
        if (fs.existsSync(finalPath)) {
            throw new errors_1.ReceiptChainError(`writeReceipt: duplicate receipt rejected — file already exists at ${finalPath} (digest: ${digest})`, 'duplicate', digest, `path: ${finalPath}`);
        }
        // ── Fork detection ─────────────────────────────────────────────────
        // Before writing, check that previous_digest (if any) points to the
        // tip of its chain.  No other receipt should already reference this
        // digest as its previous_digest (which would indicate a fork).
        const prevDigest = rawData.previous_digest;
        if (prevDigest !== undefined && prevDigest !== null && prevDigest !== '') {
            if (!isChainTip(options.receiptDir, String(prevDigest))) {
                throw new errors_1.ReceiptChainError(`writeReceipt: fork detected — digest "${String(prevDigest)}" ` +
                    `is not the chain tip (another receipt already points to it)`, 'fork', String(prevDigest));
            }
        }
        // ── Predecessor validation ─────────────────────────────────────────
        if (prevDigest !== undefined && prevDigest !== null && prevDigest !== '') {
            const prevStr = String(prevDigest);
            const prevFilename = `${prevStr}.json`;
            const prevPath = path.join(options.receiptDir, prevFilename);
            if (!fs.existsSync(prevPath)) {
                throw new errors_1.ReceiptChainError(`writeReceipt: predecessor validation failed — previous receipt not found at ${prevPath}`, 'predecessor', prevStr, `missing file: ${prevPath}`);
            }
            if (!verifyReceiptDigest(prevPath)) {
                throw new errors_1.ReceiptChainError(`writeReceipt: predecessor validation failed — previous receipt at ${prevPath} has an invalid digest`, 'predecessor', prevStr, `invalid digest at: ${prevPath}`);
            }
        }
        // ── Temp file write with 'wx' (exclusive create) ───────────────────
        let tmpFd;
        try {
            tmpFd = fs.openSync(tmpPath, 'wx');
            fs.writeSync(tmpFd, json, 0, 'utf-8');
            fs.fsyncSync(tmpFd);
            fs.closeSync(tmpFd);
            tmpFd = undefined;
        }
        catch (err) {
            // Cleanup on temp write failure
            if (tmpFd !== undefined) {
                try {
                    fs.closeSync(tmpFd);
                }
                catch { /* best-effort */ }
            }
            try {
                if (fs.existsSync(tmpPath))
                    fs.unlinkSync(tmpPath);
            }
            catch { /* best-effort */ }
            throw err;
        }
        // ── Atomic rename ────────────────────────────────────────────────
        // renameSync is the POSIX-guaranteed atomic operation on the same
        // filesystem.  Since we hold the exclusive lock and checked for
        // duplicate already, this is safe despite rename not being exclusive-
        // create.
        try {
            fs.renameSync(tmpPath, finalPath);
        }
        catch (err) {
            // Cleanup temp on rename failure
            try {
                fs.unlinkSync(tmpPath);
            }
            catch { /* best-effort */ }
            throw err;
        }
        // No need to unlink temp — renameSync removes the source.
        // ── Post-write digest verification ─────────────────────────────────
        const verifyOk = verifyReceiptDigest(finalPath);
        if (!verifyOk) {
            let storedDigest;
            try {
                const raw = fs.readFileSync(finalPath, 'utf-8');
                const parsed = JSON.parse(raw);
                storedDigest = typeof parsed.digest === 'string' ? parsed.digest : '(missing or invalid)';
            }
            catch {
                storedDigest = '(unreadable)';
            }
            throw new errors_1.ReceiptChainError(`writeReceipt: post-write digest verification failed for ${finalPath}. ` +
                `Stored digest: ${storedDigest}. Expected: ${digest}.`, 'self_digest', digest, `stored: ${storedDigest}`);
        }
        // ── Directory fsync (best-effort) ────────────────────────────────
        try {
            const dirFd = fs.openSync(options.receiptDir, 'r');
            try {
                fs.fsyncSync(dirFd);
            }
            finally {
                fs.closeSync(dirFd);
            }
        }
        catch {
            // Directory fsync may not be supported on all platforms
        }
        return { path: finalPath, digest };
    }
    finally {
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
function releaseLockIfOwned(lockDir) {
    try {
        const ownerPid = readLockOwnerPid(lockDir);
        if (ownerPid === undefined) {
            return; // absent or unreadable — nothing we can prove to own
        }
        if (ownerPid !== process.pid) {
            return; // another owner holds the lock — never touch it
        }
        fs.rmSync(lockDir, { recursive: true, force: true });
    }
    catch {
        // best-effort — a failed release leaves the lock for later stale recovery
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
function computeReceiptDigest(data) {
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
function verifyReceiptDigest(filePath) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf-8');
    }
    catch {
        return false;
    }
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
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
    let computedDigest;
    try {
        computedDigest = computeReceiptDigest(content);
    }
    catch {
        return false;
    }
    return computedDigest === storedDigest;
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
function verifyReceiptChain(receiptDir) {
    let filenames;
    try {
        filenames = fs.readdirSync(receiptDir);
    }
    catch {
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
    const allEntries = [];
    // Map from digest to first entry (used for chain walk)
    const byDigest = new Map();
    // Collect all filenames per digest for duplicate detection
    const filesByDigest = new Map();
    // Phase 1: Read, validate schema, and verify self-digests
    for (const filename of jsonFiles) {
        const filePath = path.join(receiptDir, filename);
        // Read file content
        let raw;
        try {
            raw = fs.readFileSync(filePath, 'utf-8');
        }
        catch {
            return {
                valid: false,
                receipts: [filePath],
                brokenLink: { index: 0, expected: '(read)', actual: 'cannot read receipt file' },
            };
        }
        // Parse JSON
        let receipt;
        try {
            receipt = JSON.parse(raw);
        }
        catch {
            return {
                valid: false,
                receipts: [filePath],
                brokenLink: { index: 0, expected: '(parse)', actual: 'invalid JSON in receipt file' },
            };
        }
        // Schema validation before digest check (Requirement 2)
        try {
            (0, validators_1.validateReceipt)(receipt);
        }
        catch (err) {
            if (err instanceof validators_1.SchemaValidationError) {
                return {
                    valid: false,
                    receipts: [filePath],
                    brokenLink: { index: 0, expected: '(schema)', actual: err.message },
                };
            }
            throw err;
        }
        // Self-digest verification
        if (!verifyReceiptDigest(filePath)) {
            return {
                valid: false,
                receipts: [filePath],
                brokenLink: { index: 0, expected: '(self-digest)', actual: 'stored digest does not match computed digest' },
            };
        }
        const digest = receipt.digest;
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
    const duplicateDigests = [];
    for (const [digest, filenames] of filesByDigest) {
        if (filenames.length > 1) {
            const paths = filenames.map(f => path.join(receiptDir, f));
            duplicateDigests.push({ digest, paths });
        }
    }
    // Phase 2: Verify previous_digest link integrity
    // For every non-genesis receipt, its previous_digest must exist in the directory
    let brokenLink;
    // Use the first entry per digest for link checking
    for (const [, { receipt }] of byDigest) {
        const prevDigest = receipt.previous_digest;
        if (prevDigest !== undefined && prevDigest !== null && prevDigest !== '') {
            if (!byDigest.has(prevDigest)) {
                // previous_digest references a digest not found in the directory
                const allDigests = Array.from(byDigest.keys());
                const idx = allDigests.indexOf(receipt.digest);
                brokenLink = {
                    index: brokenLink ? brokenLink.index : idx >= 0 ? idx : 0,
                    expected: prevDigest,
                    actual: '(not found in directory)',
                };
                break;
            }
        }
    }
    // Phase 3: Walk chains from genesis receipts (no previous_digest)
    const visited = new Set();
    const orderedReceipts = [];
    // Find all genesis digests (no previous_digest)
    const genesisDigests = [];
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
        if (visited.has(genesisDigest))
            continue;
        let currentDigest = genesisDigest;
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
            }
            else {
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
                const prevDigest = receipt.previous_digest;
                brokenLink = {
                    index: orderedReceipts.length - 1,
                    expected: prevDigest ?? '(genesis)',
                    actual: byDigest.has(prevDigest) ? '(orphan — not reachable from genesis)' : '(not found in directory)',
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
function assertValidReceiptChain(receiptDir) {
    const result = verifyReceiptChain(receiptDir);
    if (result.valid)
        return;
    if (result.brokenLink) {
        const expected = result.brokenLink.expected;
        const actual = result.brokenLink.actual;
        // Determine subtype based on the failure type encoded in expected
        let subtype = 'chain';
        if (expected === '(self-digest)') {
            subtype = 'self_digest';
        }
        else if (expected === '(schema)') {
            subtype = 'self_digest';
        }
        else if (expected === '(read)' || expected === '(parse)') {
            subtype = 'self_digest';
        }
        throw new errors_1.ReceiptChainError(`Receipt chain verification failed at index ${result.brokenLink.index}: ` +
            `expected ${expected}, got ${actual}`, subtype, expected.startsWith('(') ? undefined : expected, actual);
    }
    if (result.duplicateDigests && result.duplicateDigests.length > 0) {
        const first = result.duplicateDigests[0];
        throw new errors_1.ReceiptChainError(`Receipt chain verification failed: duplicate digest ${first.digest} found in ${first.paths.length} files`, 'duplicate', first.digest, `paths: ${first.paths.join(', ')}`);
    }
    // Fallback: valid=false with no brokenLink or duplicateDigests
    throw new errors_1.ReceiptChainError(`Receipt chain verification failed: ${result.receipts.length > 0 ? `invalid state for receipt at ${result.receipts[0]}` : 'unknown reason'}`, 'self_digest');
}
/**
 * Find receipts whose `previous_digest` field points to the given digest.
 *
 * @param byDigest - Map of digest to receipt entry.
 * @param targetDigest - The digest to search for.
 * @param exclude - Set of digests to exclude (already visited).
 * @returns Array of matching digests, sorted for determinism.
 */
function findReceiptsPointingTo(byDigest, targetDigest, exclude) {
    const results = [];
    for (const [digest, { receipt }] of byDigest) {
        if (exclude.has(digest))
            continue;
        const prev = receipt.previous_digest;
        if (prev === targetDigest) {
            results.push(digest);
        }
    }
    return results.sort();
}
//# sourceMappingURL=receipt-writer.js.map