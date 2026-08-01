"use strict";
/**
 * ReceiptWriter — RED/GREEN tests for the append-only receipt writer contract.
 *
 * PO: PO-S01-D-02, PO-S01-D-03
 *
 * Tests the public functions for digest computation, file digest verification,
 * and chain verification.
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
const vitest_1 = require("vitest");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const crypto = __importStar(require("node:crypto"));
const node_child_process_1 = require("node:child_process");
const receipt_writer_1 = require("./receipt-writer");
const errors_1 = require("./errors");
// ══════════════════════════════════════════════════════════════════
// Test helper: independent canonical JSON + SHA-256 (digest oracle)
// ══════════════════════════════════════════════════════════════════
/**
 * Canonical JSON serializer with sorted keys — independent replica of the
 * private `canonicalJson` used inside receipt-writer.  Kept as a pure test
 * helper so the digest oracle does not rely on `computeReceiptDigest`.
 */
function canonicalSortStringify(value) {
    if (value === null || value === undefined)
        return 'null';
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (Array.isArray(value)) {
        return `[${value.map(canonicalSortStringify).join(',')}]`;
    }
    if (typeof value === 'object') {
        const obj = value;
        const keys = Object.keys(obj).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalSortStringify(obj[k])}`).join(',')}}`;
    }
    throw new TypeError(`Cannot canonicalize ${typeof value}`);
}
/**
 * Compute SHA-256 digest of an object using independent canonical JSON.
 * This is the "independent digest oracle" — does NOT call
 * `computeReceiptDigest`.
 */
function independentDigest(data) {
    const json = canonicalSortStringify(data);
    return crypto.createHash('sha256').update(json, 'utf-8').digest('hex');
}
// ══════════════════════════════════════════════════════════════════
// Minimal valid receipt factory
// ══════════════════════════════════════════════════════════════════
function validReceipt(overrides = {}) {
    return {
        version: 1,
        type: 'TASK_COMPLETE',
        stage_id: 'S01',
        timestamp: '2025-01-01T00:00:00.000Z',
        payload: {},
        ...overrides,
    };
}
// ============================================================
// computeReceiptDigest
// ============================================================
(0, vitest_1.describe)('computeReceiptDigest', () => {
    (0, vitest_1.it)('returns a 64-character hex string (SHA-256)', () => {
        const digest = (0, receipt_writer_1.computeReceiptDigest)({ hello: 'world' });
        (0, vitest_1.expect)(digest).toMatch(/^[0-9a-f]{64}$/);
    });
    (0, vitest_1.it)('returns the same digest for identical data with sorted keys', () => {
        const a = (0, receipt_writer_1.computeReceiptDigest)({ b: 1, a: 2 });
        const b = (0, receipt_writer_1.computeReceiptDigest)({ a: 2, b: 1 });
        (0, vitest_1.expect)(a).toBe(b);
    });
    (0, vitest_1.it)('returns different digests for different data', () => {
        const a = (0, receipt_writer_1.computeReceiptDigest)({ value: 1 });
        const b = (0, receipt_writer_1.computeReceiptDigest)({ value: 2 });
        (0, vitest_1.expect)(a).not.toBe(b);
    });
    (0, vitest_1.it)('handles nested objects deterministically', () => {
        const a = (0, receipt_writer_1.computeReceiptDigest)({ nested: { z: 1, a: 2 } });
        const b = (0, receipt_writer_1.computeReceiptDigest)({ nested: { a: 2, z: 1 } });
        (0, vitest_1.expect)(a).toBe(b);
    });
    (0, vitest_1.it)('produces a known SHA-256 hex digest for a simple payload', () => {
        // SHA-256 of canonical JSON '{"hello":"world"}'
        const digest = (0, receipt_writer_1.computeReceiptDigest)({ hello: 'world' });
        // Known hash: sha256('{"hello":"world"}')
        (0, vitest_1.expect)(digest).toBe('93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588');
    });
    (0, vitest_1.it)('rejects non-object input gracefully', () => {
        (0, vitest_1.expect)(() => receipt_writer_1.computeReceiptDigest(null)).toThrow();
        (0, vitest_1.expect)(() => receipt_writer_1.computeReceiptDigest(undefined)).toThrow();
        (0, vitest_1.expect)(() => receipt_writer_1.computeReceiptDigest('string')).toThrow();
    });
    (0, vitest_1.it)('rejects NaN values in payload with a descriptive TypeError', () => {
        (0, vitest_1.expect)(() => (0, receipt_writer_1.computeReceiptDigest)({ value: NaN })).toThrow(TypeError);
        (0, vitest_1.expect)(() => (0, receipt_writer_1.computeReceiptDigest)({ value: NaN })).toThrow(/non-finite/);
    });
    (0, vitest_1.it)('rejects Infinity values in payload with a descriptive TypeError', () => {
        (0, vitest_1.expect)(() => (0, receipt_writer_1.computeReceiptDigest)({ value: Infinity })).toThrow(TypeError);
        (0, vitest_1.expect)(() => (0, receipt_writer_1.computeReceiptDigest)({ value: Infinity })).toThrow(/non-finite/);
    });
    (0, vitest_1.it)('rejects -Infinity values in payload with a descriptive TypeError', () => {
        (0, vitest_1.expect)(() => (0, receipt_writer_1.computeReceiptDigest)({ value: -Infinity })).toThrow(TypeError);
        (0, vitest_1.expect)(() => (0, receipt_writer_1.computeReceiptDigest)({ value: -Infinity })).toThrow(/non-finite/);
    });
    (0, vitest_1.it)('rejects NaN in nested objects', () => {
        (0, vitest_1.expect)(() => (0, receipt_writer_1.computeReceiptDigest)({ nested: { score: NaN } })).toThrow(TypeError);
    });
    (0, vitest_1.it)('accepts valid finite numbers including zero, negative, and fractional', () => {
        const a = (0, receipt_writer_1.computeReceiptDigest)({ value: 0 });
        const b = (0, receipt_writer_1.computeReceiptDigest)({ value: -1 });
        const c = (0, receipt_writer_1.computeReceiptDigest)({ value: 3.14 });
        (0, vitest_1.expect)(a).toMatch(/^[0-9a-f]{64}$/);
        (0, vitest_1.expect)(b).toMatch(/^[0-9a-f]{64}$/);
        (0, vitest_1.expect)(c).toMatch(/^[0-9a-f]{64}$/);
    });
});
// ============================================================
// verifyReceiptDigest — file-based
// ============================================================
(0, vitest_1.describe)('verifyReceiptDigest', () => {
    let tmpDir;
    (0, vitest_1.beforeAll)(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-writer-test-'));
    });
    (0, vitest_1.afterAll)(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('returns true when file digest matches content', () => {
        const receipt = validReceipt({
            slice_id: 'S01-D',
            payload: {},
        });
        const digest = (0, receipt_writer_1.computeReceiptDigest)(receipt);
        const data = { ...receipt, digest };
        const filePath = path.join(tmpDir, 'valid-receipt.json');
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(filePath)).toBe(true);
    });
    (0, vitest_1.it)('returns false when file digest does not match content', () => {
        const data = { ...validReceipt(), digest: '0000000000000000000000000000000000000000000000000000000000000000' };
        const filePath = path.join(tmpDir, 'tampered-receipt.json');
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(filePath)).toBe(false);
    });
    (0, vitest_1.it)('returns false for non-existent file', () => {
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(path.join(tmpDir, 'nonexistent.json'))).toBe(false);
    });
    (0, vitest_1.it)('returns false for malformed JSON', () => {
        const filePath = path.join(tmpDir, 'bad-json.json');
        fs.writeFileSync(filePath, 'not json', 'utf-8');
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(filePath)).toBe(false);
    });
    (0, vitest_1.it)('returns false when digest field is missing', () => {
        const data = validReceipt();
        const filePath = path.join(tmpDir, 'no-digest.json');
        fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(filePath)).toBe(false);
    });
    (0, vitest_1.it)('handles receipts with previous_digest field', () => {
        const receipt = validReceipt({
            type: 'SLICE_PLAN',
            previous_digest: 'abc',
        });
        const digest = (0, receipt_writer_1.computeReceiptDigest)(receipt);
        const data = { ...receipt, digest };
        const filePath = path.join(tmpDir, 'with-previous-digest.json');
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(filePath)).toBe(true);
    });
    (0, vitest_1.it)('returns false when file is a directory', () => {
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(tmpDir)).toBe(false);
    });
});
// ============================================================
// writeReceipt
// ============================================================
(0, vitest_1.describe)('writeReceipt', () => {
    let tmpDir;
    (0, vitest_1.beforeEach)(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-write-test-'));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('writes a receipt file that passes verifyReceiptDigest and returns path+digest', () => {
        const receipt = validReceipt({
            slice_id: 'S01-D',
            payload: { task: 'T02' },
        });
        const result = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir });
        // Result shape
        (0, vitest_1.expect)(result).toHaveProperty('path');
        (0, vitest_1.expect)(result).toHaveProperty('digest');
        (0, vitest_1.expect)(result.digest).toMatch(/^[0-9a-f]{64}$/);
        // File exists at returned path
        (0, vitest_1.expect)(fs.existsSync(result.path)).toBe(true);
        // File passes digest verification
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(result.path)).toBe(true);
        // Stored digest matches returned digest
        const fileContent = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
        (0, vitest_1.expect)(fileContent.digest).toBe(result.digest);
        // File is in receiptDir
        (0, vitest_1.expect)(path.dirname(result.path)).toBe(tmpDir);
    });
    (0, vitest_1.it)('cleans up temp files after successful write', () => {
        const receipt = validReceipt({
            slice_id: 'S01-D',
            timestamp: '2025-01-02T00:00:00.000Z',
            payload: { task: 'T02-cleanup' },
        });
        (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir });
        // No .tmp. files should remain
        const files = fs.readdirSync(tmpDir);
        const tmpFiles = files.filter(f => f.includes('.tmp.'));
        (0, vitest_1.expect)(tmpFiles).toHaveLength(0);
    });
    (0, vitest_1.it)('throws TypeError for non-object data', () => {
        (0, vitest_1.expect)(() => receipt_writer_1.writeReceipt(null, { receiptDir: tmpDir, tempDir: tmpDir })).toThrow(TypeError);
        (0, vitest_1.expect)(() => receipt_writer_1.writeReceipt('string', { receiptDir: tmpDir, tempDir: tmpDir })).toThrow(TypeError);
    });
    (0, vitest_1.it)('throws descriptive error when receiptDir does not exist', () => {
        const nonExistentDir = path.join(os.tmpdir(), 'does-not-exist-99999');
        // Use valid receipt data so schema validation passes
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(validReceipt(), { receiptDir: nonExistentDir, tempDir: tmpDir })).toThrow();
    });
    (0, vitest_1.it)('rejects duplicate receipt writes', () => {
        const receipt = validReceipt({
            timestamp: '2025-01-01T00:00:00.000Z',
            payload: { msg: 'hello' },
        });
        const a = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir });
        // Same content => same digest => second write must throw duplicate
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir }))
            .toThrow(errors_1.ReceiptChainError);
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir }))
            .toThrow(/duplicate receipt/i);
        // First result unchanged
        (0, vitest_1.expect)(fs.existsSync(a.path)).toBe(true);
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(a.path)).toBe(true);
    });
    (0, vitest_1.it)('allows different receipts with same fields but different values', () => {
        const receiptA = validReceipt({
            timestamp: '2025-01-01T00:00:00.000Z',
            payload: { id: 'a' },
        });
        const receiptB = validReceipt({
            timestamp: '2025-01-01T00:00:00.000Z',
            payload: { id: 'b' },
        });
        const a = (0, receipt_writer_1.writeReceipt)(receiptA, { receiptDir: tmpDir, tempDir: tmpDir });
        const b = (0, receipt_writer_1.writeReceipt)(receiptB, { receiptDir: tmpDir, tempDir: tmpDir });
        // Different content => different digests => both should succeed
        (0, vitest_1.expect)(a.digest).not.toBe(b.digest);
        (0, vitest_1.expect)(a.path).not.toBe(b.path);
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(a.path)).toBe(true);
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(b.path)).toBe(true);
    });
    (0, vitest_1.it)('validates predecessor exists for linked receipts', () => {
        // Write genesis receipt
        const genesis = validReceipt({
            type: 'SLICE_PLAN',
            timestamp: '2025-01-01T00:00:00.000Z',
        });
        const genesisResult = (0, receipt_writer_1.writeReceipt)(genesis, { receiptDir: tmpDir, tempDir: tmpDir });
        // Write a linked receipt with valid previous_digest
        const linked = validReceipt({
            type: 'TASK_COMPLETE',
            slice_id: 'S01-D',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: genesisResult.digest,
            payload: { task: 'T03' },
        });
        const linkedResult = (0, receipt_writer_1.writeReceipt)(linked, { receiptDir: tmpDir, tempDir: tmpDir });
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(linkedResult.path)).toBe(true);
        const content = JSON.parse(fs.readFileSync(linkedResult.path, 'utf-8'));
        (0, vitest_1.expect)(content.previous_digest).toBe(genesisResult.digest);
    });
    (0, vitest_1.it)('throws when previous_digest references non-existent receipt', () => {
        // Use a clean sub-directory so fork detection does not mistake this
        // for a fork (the non-existent digest is trivially the "chain tip"
        // since nothing points to it, so fork detection passes).
        const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-clean-'));
        try {
            const receipt = validReceipt({
                timestamp: '2025-01-03T00:00:00.000Z',
                previous_digest: '0000000000000000000000000000000000000000000000000000000000000000',
            });
            // Fork detection: `isChainTip` checks if any receipt points to
            // 0000... — there are no receipts, so it's trivially the tip. OK.
            // Predecessor validation then fails because the file doesn't exist.
            (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: cleanDir, tempDir: cleanDir })).toThrow(errors_1.ReceiptChainError);
            (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: cleanDir, tempDir: cleanDir })).toThrow(/previous receipt|predecessor/i);
        }
        finally {
            fs.rmSync(cleanDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('throws when predecessor receipt has invalid digest', () => {
        // Manually create a receipt file with a bad digest
        const badDigest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const badData = {
            ...validReceipt({ type: 'SLICE_PLAN' }),
            digest: badDigest,
        };
        const badPath = path.join(tmpDir, `${badDigest}.json`);
        fs.writeFileSync(badPath, JSON.stringify(badData), 'utf-8');
        // Try to write a receipt that references this bad predecessor
        const receipt = validReceipt({
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: badDigest,
        });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir })).toThrow(errors_1.ReceiptChainError);
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir })).toThrow(/invalid digest|predecessor|chain integrity check/i);
    });
    (0, vitest_1.it)('acquires and releases a lock directory during write', () => {
        const receipt = validReceipt({
            timestamp: '2025-01-10T00:00:00.000Z',
            payload: { test: 'lock' },
        });
        (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir });
        // Lock directory should be cleaned up
        const lockDir = path.join(tmpDir, '.receipt-lock');
        (0, vitest_1.expect)(fs.existsSync(lockDir)).toBe(false);
    });
    (0, vitest_1.it)('rejects lock contention with ReceiptChainError when another write holds the lock', () => {
        const lockDir = path.join(tmpDir, '.receipt-lock');
        fs.mkdirSync(lockDir);
        const receipt = validReceipt({ type: 'SLICE_PLAN' });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir })).toThrow(errors_1.ReceiptChainError);
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir })).toThrow(/lock/i);
        // Lock directory still exists (held by the fake lock)
        (0, vitest_1.expect)(fs.existsSync(lockDir)).toBe(true);
        // No temp files were left
        const files = fs.readdirSync(tmpDir).filter(f => f !== '.receipt-lock');
        const tmpFiles = files.filter(f => f.includes('.tmp.'));
        (0, vitest_1.expect)(tmpFiles).toHaveLength(0);
        // Clean up
        fs.rmdirSync(lockDir);
    });
    (0, vitest_1.it)('recovers from a stale lock directory older than DEFAULT_LOCK_TIMEOUT_MS', () => {
        const lockDir = path.join(tmpDir, '.receipt-lock');
        fs.mkdirSync(lockDir);
        // Set mtime to the past (older than timeout)
        const oldTime = new Date(Date.now() - receipt_writer_1.DEFAULT_LOCK_TIMEOUT_MS - 1000);
        fs.utimesSync(lockDir, oldTime, oldTime);
        // Use a unique payload so the digest does not clash with previously written receipts
        const receipt = validReceipt({
            type: 'SLICE_PLAN',
            payload: { stale_lock_recovery: true, ts: Date.now() },
        });
        const result = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir });
        // Write should succeed (stale lock was recovered)
        (0, vitest_1.expect)(result).toBeDefined();
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(result.path)).toBe(true);
        // Lock directory should be cleaned up
        (0, vitest_1.expect)(fs.existsSync(lockDir)).toBe(false);
    });
    (0, vitest_1.it)('throws ReceiptChainError for a fresh lock (not yet stale)', () => {
        const lockDir = path.join(tmpDir, '.receipt-lock');
        fs.mkdirSync(lockDir);
        // Set mtime to now (fresh lock)
        const now = new Date();
        fs.utimesSync(lockDir, now, now);
        const receipt = validReceipt({ type: 'SLICE_PLAN' });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir })).toThrow(errors_1.ReceiptChainError);
        // Lock directory still exists
        (0, vitest_1.expect)(fs.existsSync(lockDir)).toBe(true);
        // Clean up
        fs.rmdirSync(lockDir);
    });
    (0, vitest_1.it)('rejects a lock whose owner.pid points to a live process — never deletes an active lock (S01-RR-005)', () => {
        const lockDir = path.join(tmpDir, '.receipt-lock');
        fs.mkdirSync(lockDir);
        // Simulate a lock held by a live writer: this test process itself.
        // This also covers the same-process / nested-acquisition edge case — an
        // owner.pid equal to our own PID must never be treated as stale (a
        // nested acquisition must throw, not delete the outer holder's lock).
        fs.writeFileSync(path.join(lockDir, 'owner.pid'), `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`, 'utf-8');
        const receipt = validReceipt({
            type: 'SLICE_PLAN',
            payload: { s01rr005_active_owner: true, ts: Date.now() },
        });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir })).toThrow(errors_1.ReceiptChainError);
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir })).toThrow(/lock/i);
        // The lock must NOT be deleted — its owner is alive regardless of age.
        (0, vitest_1.expect)(fs.existsSync(lockDir)).toBe(true);
        (0, vitest_1.expect)(fs.existsSync(path.join(lockDir, 'owner.pid'))).toBe(true);
        // No temp files were left
        const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.includes('.tmp.'));
        (0, vitest_1.expect)(tmpFiles).toHaveLength(0);
        // Clean up
        fs.rmSync(lockDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('recovers from a lock whose owner.pid points to a dead process — even with a fresh mtime (S01-RR-005)', () => {
        const lockDir = path.join(tmpDir, '.receipt-lock');
        fs.mkdirSync(lockDir);
        // Obtain a PID that is guaranteed to be dead: spawn a child that exits
        // immediately; spawnSync waits for it, so the PID is free afterwards.
        const child = (0, node_child_process_1.spawnSync)(process.execPath, ['-e', ''], { timeout: 10_000 });
        (0, vitest_1.expect)(child.status).toBe(0);
        (0, vitest_1.expect)(child.pid).toBeGreaterThan(0);
        const deadPid = child.pid;
        fs.writeFileSync(path.join(lockDir, 'owner.pid'), `${JSON.stringify({ pid: deadPid, startedAt: Date.now() })}\n`, 'utf-8');
        // The lock directory mtime is fresh — the old mtime heuristic would
        // have treated this as an active lock.  PID liveness must recover it.
        const receipt = validReceipt({
            type: 'SLICE_PLAN',
            payload: { s01rr005_dead_owner: true, ts: Date.now() },
        });
        const result = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir });
        // Write should succeed (stale lock recovered via dead PID)
        (0, vitest_1.expect)(result).toBeDefined();
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(result.path)).toBe(true);
        // Lock directory should be cleaned up
        (0, vitest_1.expect)(fs.existsSync(lockDir)).toBe(false);
    });
    (0, vitest_1.it)('treats EPERM from process.kill as an alive owner (Windows compatibility)', () => {
        const lockDir = path.join(tmpDir, '.receipt-lock');
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, 'owner.pid'), `${JSON.stringify({ pid: 999_999_999, startedAt: Date.now() })}\n`, 'utf-8');
        // On Windows, probing a process owned by another user throws EPERM
        // instead of succeeding — that must be treated as "alive", not stale.
        const killSpy = vitest_1.vi.spyOn(process, 'kill').mockImplementation((() => {
            const e = new Error('EPERM');
            e.code = 'EPERM';
            throw e;
        }));
        try {
            const receipt = validReceipt({
                type: 'SLICE_PLAN',
                payload: { s01rr005_eperm: true, ts: Date.now() },
            });
            (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tmpDir, tempDir: tmpDir })).toThrow(errors_1.ReceiptChainError);
            // Lock must still exist (owner treated as alive)
            (0, vitest_1.expect)(fs.existsSync(lockDir)).toBe(true);
        }
        finally {
            killSpy.mockRestore();
            fs.rmSync(lockDir, { recursive: true, force: true });
        }
    });
});
// ============================================================
// verifyReceiptChain
// ============================================================
(0, vitest_1.describe)('verifyReceiptChain', () => {
    let tmpDir;
    (0, vitest_1.beforeAll)(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-chain-test-'));
    });
    (0, vitest_1.afterAll)(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    function writeReceipt(data, name) {
        const digest = (0, receipt_writer_1.computeReceiptDigest)(data);
        const full = { ...data, digest };
        const filePath = path.join(tmpDir, name);
        fs.writeFileSync(filePath, JSON.stringify(full, null, 2), 'utf-8');
        return digest;
    }
    (0, vitest_1.it)('returns valid for a single receipt with no previous_digest (genesis)', () => {
        writeReceipt(validReceipt({ type: 'SLICE_PLAN' }), 'genesis.json');
        const result = (0, receipt_writer_1.verifyReceiptChain)(tmpDir);
        (0, vitest_1.expect)(result.valid).toBe(true);
        (0, vitest_1.expect)(result.receipts).toHaveLength(1);
        (0, vitest_1.expect)(result.brokenLink).toBeUndefined();
    });
    (0, vitest_1.it)('returns valid for a linked chain of receipts', () => {
        const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-valid-'));
        try {
            // Genesis: no previous_digest
            const genesisDigest = writeReceiptIn(chainDir, validReceipt({ type: 'SLICE_PLAN' }), '001-genesis.json');
            // Second receipt: links to genesis
            const secondDigest = writeReceiptIn(chainDir, validReceipt({
                type: 'TASK_COMPLETE',
                slice_id: 'S01-D',
                timestamp: '2025-01-02T00:00:00.000Z',
                previous_digest: genesisDigest,
                payload: { task: 'T01' },
            }), '002-task.json');
            // Third receipt: links to second
            writeReceiptIn(chainDir, validReceipt({
                type: 'TASK_COMPLETE',
                slice_id: 'S01-D',
                timestamp: '2025-01-03T00:00:00.000Z',
                previous_digest: secondDigest,
                payload: { task: 'T02' },
            }), '003-task.json');
            const result = (0, receipt_writer_1.verifyReceiptChain)(chainDir);
            (0, vitest_1.expect)(result.valid).toBe(true);
            (0, vitest_1.expect)(result.receipts).toHaveLength(3);
            (0, vitest_1.expect)(result.brokenLink).toBeUndefined();
        }
        finally {
            fs.rmSync(chainDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('detects a broken link (wrong previous_digest)', () => {
        const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-broken-'));
        try {
            // Genesis
            const genesisDigest = writeReceiptIn(chainDir, validReceipt({ type: 'SLICE_PLAN' }), '001-genesis.json');
            // Second receipt: wrong previous_digest
            writeReceiptIn(chainDir, validReceipt({
                type: 'TASK_COMPLETE',
                timestamp: '2025-01-02T00:00:00.000Z',
                previous_digest: 'BAD_DIGEST_DOES_NOT_MATCH',
            }), '002-bad-link.json');
            const result = (0, receipt_writer_1.verifyReceiptChain)(chainDir);
            (0, vitest_1.expect)(result.valid).toBe(false);
            (0, vitest_1.expect)(result.brokenLink).toBeDefined();
            if (result.brokenLink) {
                (0, vitest_1.expect)(result.brokenLink.expected).toBe('BAD_DIGEST_DOES_NOT_MATCH');
            }
        }
        finally {
            fs.rmSync(chainDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('detects a receipt with broken self-digest within a chain', () => {
        const chainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-self-broken-'));
        try {
            // Write a genesis with valid digest
            const genesisDigest = writeReceiptIn(chainDir, validReceipt({ type: 'SLICE_PLAN' }), '001-genesis.json');
            // Write a receipt with bad self-digest
            const receiptData = validReceipt({
                type: 'TASK_COMPLETE',
                timestamp: '2025-01-02T00:00:00.000Z',
                previous_digest: genesisDigest,
            });
            const computedDigest = (0, receipt_writer_1.computeReceiptDigest)(receiptData);
            // Write with a wrong digest
            const badData = { ...receiptData, digest: '0000000000000000000000000000000000000000000000000000000000000000' };
            fs.writeFileSync(path.join(chainDir, '002-tampered.json'), JSON.stringify(badData, null, 2), 'utf-8');
            const result = (0, receipt_writer_1.verifyReceiptChain)(chainDir);
            // Chain should detect the broken self-digest and be invalid
            (0, vitest_1.expect)(result.valid).toBe(false);
        }
        finally {
            fs.rmSync(chainDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('handles empty directory', () => {
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-empty-'));
        try {
            const result = (0, receipt_writer_1.verifyReceiptChain)(emptyDir);
            (0, vitest_1.expect)(result.valid).toBe(true);
            (0, vitest_1.expect)(result.receipts).toEqual([]);
        }
        finally {
            fs.rmSync(emptyDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('handles non-existent directory', () => {
        const result = (0, receipt_writer_1.verifyReceiptChain)(path.join(tmpDir, 'nonexistent'));
        (0, vitest_1.expect)(result.valid).toBe(true);
        (0, vitest_1.expect)(result.receipts).toEqual([]);
    });
    (0, vitest_1.it)('handles directory with non-JSON files', () => {
        const mixedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-mixed-'));
        try {
            fs.writeFileSync(path.join(mixedDir, 'readme.txt'), 'hello', 'utf-8');
            writeReceiptIn(mixedDir, validReceipt({ type: 'SLICE_PLAN' }), 'receipt.json');
            const result = (0, receipt_writer_1.verifyReceiptChain)(mixedDir);
            (0, vitest_1.expect)(result.valid).toBe(true);
            (0, vitest_1.expect)(result.receipts).toHaveLength(1);
        }
        finally {
            fs.rmSync(mixedDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('handles multiple unlinked receipts (no previous_digest) treating each as a separate chain root', () => {
        const multiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-multi-'));
        try {
            // Two receipts, neither with previous_digest — each is a valid 1-receipt chain
            writeReceiptIn(multiDir, validReceipt({
                type: 'SLICE_PLAN',
                payload: { chain: 'a' },
            }), 'chain-a.json');
            writeReceiptIn(multiDir, validReceipt({
                type: 'SLICE_PLAN',
                payload: { chain: 'b' },
            }), 'chain-b.json');
            const result = (0, receipt_writer_1.verifyReceiptChain)(multiDir);
            // Each is a valid chain of length 1, but they are listed in receipt order
            (0, vitest_1.expect)(result.valid).toBe(true);
            (0, vitest_1.expect)(result.receipts).toHaveLength(2);
        }
        finally {
            fs.rmSync(multiDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('detects duplicate digests (same digest under different filenames)', () => {
        const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-dup-digest-'));
        try {
            // Write the same receipt content to two different filenames
            const receiptData = validReceipt({ type: 'SLICE_PLAN' });
            const digest = (0, receipt_writer_1.computeReceiptDigest)(receiptData);
            const fullData = { ...receiptData, digest };
            // Same digest, different filenames
            fs.writeFileSync(path.join(dupDir, 'dup-a.json'), JSON.stringify(fullData, null, 2), 'utf-8');
            fs.writeFileSync(path.join(dupDir, 'dup-b.json'), JSON.stringify(fullData, null, 2), 'utf-8');
            const result = (0, receipt_writer_1.verifyReceiptChain)(dupDir);
            (0, vitest_1.expect)(result.valid).toBe(false);
            (0, vitest_1.expect)(result.duplicateDigests).toBeDefined();
            (0, vitest_1.expect)(result.duplicateDigests).toHaveLength(1);
            if (result.duplicateDigests) {
                (0, vitest_1.expect)(result.duplicateDigests[0].digest).toBe(digest);
                (0, vitest_1.expect)(result.duplicateDigests[0].paths).toHaveLength(2);
            }
        }
        finally {
            fs.rmSync(dupDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('detects multiple duplicate digest groups', () => {
        const multiDupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-multi-dup-'));
        try {
            // Create two distinct receipts, each duplicated
            const r1 = validReceipt({ type: 'SLICE_PLAN', payload: { id: 'a' } });
            const d1 = (0, receipt_writer_1.computeReceiptDigest)(r1);
            const f1 = { ...r1, digest: d1 };
            const r2 = validReceipt({ type: 'TASK_COMPLETE', payload: { id: 'b' } });
            const d2 = (0, receipt_writer_1.computeReceiptDigest)(r2);
            const f2 = { ...r2, digest: d2 };
            // Each digest appears twice
            fs.writeFileSync(path.join(multiDupDir, 'a1.json'), JSON.stringify(f1, null, 2), 'utf-8');
            fs.writeFileSync(path.join(multiDupDir, 'a2.json'), JSON.stringify(f1, null, 2), 'utf-8');
            fs.writeFileSync(path.join(multiDupDir, 'b1.json'), JSON.stringify(f2, null, 2), 'utf-8');
            fs.writeFileSync(path.join(multiDupDir, 'b2.json'), JSON.stringify(f2, null, 2), 'utf-8');
            const result = (0, receipt_writer_1.verifyReceiptChain)(multiDupDir);
            (0, vitest_1.expect)(result.valid).toBe(false);
            (0, vitest_1.expect)(result.duplicateDigests).toBeDefined();
            (0, vitest_1.expect)(result.duplicateDigests).toHaveLength(2);
        }
        finally {
            fs.rmSync(multiDupDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('does not report duplicate when same digest appears once', () => {
        const singleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-single-'));
        try {
            writeReceiptIn(singleDir, validReceipt({ type: 'SLICE_PLAN' }), 'receipt.json');
            const result = (0, receipt_writer_1.verifyReceiptChain)(singleDir);
            (0, vitest_1.expect)(result.valid).toBe(true);
            (0, vitest_1.expect)(result.duplicateDigests).toBeUndefined();
        }
        finally {
            fs.rmSync(singleDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('assertValidReceiptChain throws ReceiptChainError for duplicate digests', () => {
        const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-assert-dup-'));
        try {
            const receiptData = validReceipt({ type: 'SLICE_PLAN' });
            const digest = (0, receipt_writer_1.computeReceiptDigest)(receiptData);
            const fullData = { ...receiptData, digest };
            fs.writeFileSync(path.join(dupDir, 'a.json'), JSON.stringify(fullData, null, 2), 'utf-8');
            fs.writeFileSync(path.join(dupDir, 'b.json'), JSON.stringify(fullData, null, 2), 'utf-8');
            (0, vitest_1.expect)(() => (0, receipt_writer_1.assertValidReceiptChain)(dupDir)).toThrow(errors_1.ReceiptChainError);
        }
        finally {
            fs.rmSync(dupDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('assertValidReceiptChain throws ReceiptChainError for broken links', () => {
        const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-assert-broken-'));
        try {
            writeReceiptIn(brokenDir, validReceipt({
                type: 'TASK_COMPLETE',
                timestamp: '2025-01-02T00:00:00.000Z',
                previous_digest: '0000000000000000000000000000000000000000000000000000000000000000',
            }), 'bad.json');
            (0, vitest_1.expect)(() => (0, receipt_writer_1.assertValidReceiptChain)(brokenDir)).toThrow(errors_1.ReceiptChainError);
        }
        finally {
            fs.rmSync(brokenDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('assertValidReceiptChain does not throw for a valid chain', () => {
        const validDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-assert-valid-'));
        try {
            writeReceiptIn(validDir, validReceipt({ type: 'SLICE_PLAN' }), 'genesis.json');
            (0, vitest_1.expect)(() => (0, receipt_writer_1.assertValidReceiptChain)(validDir)).not.toThrow();
        }
        finally {
            fs.rmSync(validDir, { recursive: true, force: true });
        }
    });
});
// ============================================================
// Real filesystem integration tests (comprehensive)
// ============================================================
(0, vitest_1.describe)('ReceiptWriter — Real filesystem integration', () => {
    let chainDir;
    (0, vitest_1.beforeAll)(() => {
        chainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-real-fs-'));
    });
    (0, vitest_1.afterAll)(() => {
        fs.rmSync(chainDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('writes a chain of linked receipts, all files exist and digests match', () => {
        const genesis = validReceipt({ type: 'SLICE_PLAN' });
        const gResult = (0, receipt_writer_1.writeReceipt)(genesis, { receiptDir: chainDir, tempDir: chainDir });
        // File exists at returned path
        (0, vitest_1.expect)(fs.existsSync(gResult.path)).toBe(true);
        // File name contains the digest
        (0, vitest_1.expect)(path.basename(gResult.path)).toBe(`${gResult.digest}.json`);
        // Digest matches recomputation
        (0, vitest_1.expect)(gResult.digest).toBe((0, receipt_writer_1.computeReceiptDigest)(genesis));
        // Self-verification passes
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(gResult.path)).toBe(true);
        // Write a second receipt linked to genesis
        const second = validReceipt({
            type: 'TASK_COMPLETE',
            slice_id: 'S01-D',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: gResult.digest,
            payload: { step: 2 },
        });
        const sResult = (0, receipt_writer_1.writeReceipt)(second, { receiptDir: chainDir, tempDir: chainDir });
        (0, vitest_1.expect)(fs.existsSync(sResult.path)).toBe(true);
        (0, vitest_1.expect)(path.basename(sResult.path)).toBe(`${sResult.digest}.json`);
        (0, vitest_1.expect)(sResult.digest).toBe((0, receipt_writer_1.computeReceiptDigest)(second));
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(sResult.path)).toBe(true);
        // Write third receipt linked to second
        const third = validReceipt({
            type: 'TASK_COMPLETE',
            slice_id: 'S01-D',
            timestamp: '2025-01-03T00:00:00.000Z',
            previous_digest: sResult.digest,
            payload: { step: 3 },
        });
        const tResult = (0, receipt_writer_1.writeReceipt)(third, { receiptDir: chainDir, tempDir: chainDir });
        (0, vitest_1.expect)(fs.existsSync(tResult.path)).toBe(true);
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(tResult.path)).toBe(true);
        // All files are in receiptDir
        const files = fs.readdirSync(chainDir);
        (0, vitest_1.expect)(files).toContain(`${gResult.digest}.json`);
        (0, vitest_1.expect)(files).toContain(`${sResult.digest}.json`);
        (0, vitest_1.expect)(files).toContain(`${tResult.digest}.json`);
    });
    (0, vitest_1.it)('chain verification passes for the linked chain', () => {
        const result = (0, receipt_writer_1.verifyReceiptChain)(chainDir);
        (0, vitest_1.expect)(result.valid).toBe(true);
        (0, vitest_1.expect)(result.receipts).toHaveLength(3);
        (0, vitest_1.expect)(result.brokenLink).toBeUndefined();
    });
    (0, vitest_1.it)('no temp files remain after chain writes', () => {
        const files = fs.readdirSync(chainDir);
        const tmpFiles = files.filter(f => f.includes('.tmp.'));
        (0, vitest_1.expect)(tmpFiles).toHaveLength(0);
    });
    (0, vitest_1.it)('writes receipts with correct content-addressable filenames', () => {
        const singleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-ca-'));
        try {
            const data = validReceipt({ type: 'TASK_COMPLETE', payload: { test: 'content-addressable' } });
            const result = (0, receipt_writer_1.writeReceipt)(data, { receiptDir: singleDir, tempDir: singleDir });
            // The filename IS the digest
            (0, vitest_1.expect)(path.basename(result.path)).toBe(`${result.digest}.json`);
            // Content at that path has matching digest field
            const raw = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
            (0, vitest_1.expect)(raw.digest).toBe(result.digest);
        }
        finally {
            fs.rmSync(singleDir, { recursive: true, force: true });
        }
    });
});
// ============================================================
// Fault injection tests (real filesystem)
// ============================================================
(0, vitest_1.describe)('ReceiptWriter — Fault injection', () => {
    let faultDir;
    (0, vitest_1.beforeEach)(() => {
        faultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-fault-'));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(faultDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('handles lock contention — another write in progress', () => {
        const lockDir = path.join(faultDir, '.receipt-lock');
        fs.mkdirSync(lockDir);
        const receipt = validReceipt({ type: 'SLICE_PLAN' });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: faultDir, tempDir: faultDir })).toThrow(/lock/i);
    });
    (0, vitest_1.it)('handles non-existent directory gracefully', () => {
        const badDir = path.join(os.tmpdir(), 'does-not-exist-' + Date.now());
        const receipt = validReceipt({ type: 'SLICE_PLAN' });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: badDir, tempDir: faultDir })).toThrow();
        // No temp files should remain in faultDir
        const files = fs.readdirSync(faultDir);
        const tmpFiles = files.filter(f => f.includes('.tmp.'));
        (0, vitest_1.expect)(tmpFiles).toHaveLength(0);
    });
    (0, vitest_1.it)('receiptDir with restricted permissions causes descriptive error', () => {
        // Make the dir read-only
        fs.chmodSync(faultDir, 0o444);
        const receipt = validReceipt({ type: 'SLICE_PLAN' });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: faultDir, tempDir: faultDir })).toThrow();
        // Restore permissions for cleanup
        fs.chmodSync(faultDir, 0o755);
    });
    (0, vitest_1.it)('cleans up temp and lock when write fails mid-operation', () => {
        // Create a situation where write fails: set directory read-only
        // After mkdir for lock fails, we know lock cleanup works.
        // For a deeper test, manually acquire lock then change permissions.
        const lockDir = path.join(faultDir, '.receipt-lock');
        fs.mkdirSync(lockDir);
        fs.rmdirSync(lockDir);
        // Now make the directory read-only so the lock creation re-creates it
        // but the temp file write will fail.
        fs.chmodSync(faultDir, 0o444);
        const receipt = validReceipt({ type: 'SLICE_PLAN' });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: faultDir, tempDir: faultDir })).toThrow();
        fs.chmodSync(faultDir, 0o755);
        // Lock should not exist after cleanup attempt
        (0, vitest_1.expect)(fs.existsSync(lockDir)).toBe(false);
        // No temp files
        const files = fs.readdirSync(faultDir);
        (0, vitest_1.expect)(files.filter(f => f.includes('.tmp.'))).toHaveLength(0);
    });
});
// ============================================================
// Tamper detection tests
// ============================================================
(0, vitest_1.describe)('ReceiptWriter — Tamper detection', () => {
    let tamperDir;
    (0, vitest_1.beforeEach)(() => {
        tamperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-tamper-'));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(tamperDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('verifyReceiptDigest catches tampered content on disk', () => {
        // Write a receipt via writeReceipt
        const receipt = validReceipt({
            slice_id: 'S01-D',
            payload: { task: 'tamper-test' },
        });
        const result = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: tamperDir, tempDir: tamperDir });
        // Verify it passes before tampering
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(result.path)).toBe(true);
        // Tamper with the file content
        const originalContent = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
        originalContent.payload = { task: 'EVIL_TAMPERED' };
        // Keep the old digest (which no longer matches content)
        fs.writeFileSync(result.path, JSON.stringify(originalContent, null, 2), 'utf-8');
        // Now verification must fail
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(result.path)).toBe(false);
    });
    (0, vitest_1.it)('verifyReceiptChain catches a tampered receipt in a chain', () => {
        // Write a chain of 2 linked receipts
        const genesis = validReceipt({ type: 'SLICE_PLAN' });
        const gResult = (0, receipt_writer_1.writeReceipt)(genesis, { receiptDir: tamperDir, tempDir: tamperDir });
        const second = validReceipt({
            type: 'TASK_COMPLETE',
            slice_id: 'S01-D',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: gResult.digest,
            payload: { task: 'second' },
        });
        const sResult = (0, receipt_writer_1.writeReceipt)(second, { receiptDir: tamperDir, tempDir: tamperDir });
        // Chain is valid before tampering
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptChain)(tamperDir).valid).toBe(true);
        // Tamper with genesis file: change its payload but keep old digest
        const genesisContent = JSON.parse(fs.readFileSync(gResult.path, 'utf-8'));
        genesisContent.payload = { tampered: true };
        fs.writeFileSync(gResult.path, JSON.stringify(genesisContent, null, 2), 'utf-8');
        // Chain must detect the broken self-digest
        const chainResult = (0, receipt_writer_1.verifyReceiptChain)(tamperDir);
        (0, vitest_1.expect)(chainResult.valid).toBe(false);
    });
    (0, vitest_1.it)('verifyReceiptChain catches a broken previous_digest link after tampering', () => {
        // Write 3 linked receipts
        const r1 = validReceipt({ type: 'SLICE_PLAN' });
        const r1Result = (0, receipt_writer_1.writeReceipt)(r1, { receiptDir: tamperDir, tempDir: tamperDir });
        const r2 = validReceipt({
            type: 'TASK_COMPLETE',
            slice_id: 'S01-D',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: r1Result.digest,
        });
        const r2Result = (0, receipt_writer_1.writeReceipt)(r2, { receiptDir: tamperDir, tempDir: tamperDir });
        const r3 = validReceipt({
            type: 'TASK_COMPLETE',
            slice_id: 'S01-D',
            timestamp: '2025-01-03T00:00:00.000Z',
            previous_digest: r2Result.digest,
        });
        (0, receipt_writer_1.writeReceipt)(r3, { receiptDir: tamperDir, tempDir: tamperDir });
        // Tamper with r2: change its previous_digest to point to a non-existent digest
        const r2Content = JSON.parse(fs.readFileSync(r2Result.path, 'utf-8'));
        r2Content.previous_digest = '0000000000000000000000000000000000000000000000000000000000000000';
        // Since changing previous_digest changes the content, the digest no longer matches.
        // Recompute digest without the digest field
        const { digest: _oldDigest, ...r2WithoutDigest } = r2Content;
        const newDigest = (0, receipt_writer_1.computeReceiptDigest)(r2WithoutDigest);
        r2Content.digest = newDigest;
        fs.writeFileSync(r2Result.path, JSON.stringify(r2Content, null, 2), 'utf-8');
        // The chain should detect the broken link — either r2's previous_digest is
        // not found or r3's previous_digest (original r2 digest) is not found since
        // r2's file now has a different digest.
        const chainResult = (0, receipt_writer_1.verifyReceiptChain)(tamperDir);
        (0, vitest_1.expect)(chainResult.valid).toBe(false);
        (0, vitest_1.expect)(chainResult.brokenLink).toBeDefined();
    });
});
// ============================================================
// Concurrent append tests (real concurrent via Promise.all)
// ============================================================
(0, vitest_1.describe)('ReceiptWriter — Concurrent appends', () => {
    let concurDir;
    (0, vitest_1.beforeEach)(() => {
        concurDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-concur-'));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(concurDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('handles concurrent writes to the same directory via Promise.all', async () => {
        const receipts = [
            validReceipt({ timestamp: '2025-01-01T00:00:00.000Z', payload: { seq: 1 } }),
            validReceipt({ timestamp: '2025-01-02T00:00:00.000Z', payload: { seq: 2 } }),
            validReceipt({ timestamp: '2025-01-03T00:00:00.000Z', payload: { seq: 3 } }),
            validReceipt({ timestamp: '2025-01-04T00:00:00.000Z', payload: { seq: 4 } }),
            validReceipt({ timestamp: '2025-01-05T00:00:00.000Z', payload: { seq: 5 } }),
        ];
        // Launch all 5 writes concurrently with Promise.allSettled
        const outcomes = await Promise.allSettled(receipts.map(r => new Promise((resolve, reject) => {
            try {
                resolve((0, receipt_writer_1.writeReceipt)(r, { receiptDir: concurDir, tempDir: concurDir }));
            }
            catch (e) {
                reject(e);
            }
        })));
        const succeeded = outcomes.filter(o => o.status === 'fulfilled');
        const failed = outcomes.filter(o => o.status === 'rejected');
        // At least 1 should succeed (they all have different content, so no duplicates)
        (0, vitest_1.expect)(succeeded.length).toBeGreaterThanOrEqual(1);
        // Verify no temp files remain
        const files = fs.readdirSync(concurDir);
        const tmpFiles = files.filter(f => f.includes('.tmp.'));
        (0, vitest_1.expect)(tmpFiles).toHaveLength(0);
        // Lock directory should be cleaned up
        const lockDir = path.join(concurDir, '.receipt-lock');
        (0, vitest_1.expect)(fs.existsSync(lockDir)).toBe(false);
        // Chain verification passes for whatever was written
        const chainResult = (0, receipt_writer_1.verifyReceiptChain)(concurDir);
        if (chainResult.receipts.length > 0) {
            for (const receiptPath of chainResult.receipts) {
                (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(receiptPath)).toBe(true);
            }
        }
    });
    (0, vitest_1.it)('concurrent writes do not leave partial or corrupted files', async () => {
        const receipts = [
            validReceipt({ timestamp: '2025-01-01T00:00:00.000Z', payload: { id: 'concur-a' } }),
            validReceipt({ timestamp: '2025-01-02T00:00:00.000Z', payload: { id: 'concur-b' } }),
            validReceipt({ timestamp: '2025-01-03T00:00:00.000Z', payload: { id: 'concur-c' } }),
        ];
        // Launch 3 concurrent writes
        const outcomes = await Promise.allSettled(receipts.map(r => new Promise((resolve, reject) => {
            try {
                resolve((0, receipt_writer_1.writeReceipt)(r, { receiptDir: concurDir, tempDir: concurDir }));
            }
            catch (e) {
                reject(e);
            }
        })));
        // List all .json receipts (not temp files, not lock)
        const allFiles = fs.readdirSync(concurDir);
        const jsonFiles = allFiles.filter(f => f.endsWith('.json') && !f.startsWith('.'));
        const tmpFiles = allFiles.filter(f => f.includes('.tmp.'));
        // No temp files
        (0, vitest_1.expect)(tmpFiles).toHaveLength(0);
        // Each JSON file must be valid JSON and pass digest verification
        for (const file of jsonFiles) {
            const filePath = path.join(concurDir, file);
            (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(filePath)).toBe(true);
        }
        // No partial writes — each JSON file must be parseable and contain expected fields
        for (const file of jsonFiles) {
            const raw = fs.readFileSync(path.join(concurDir, file), 'utf-8');
            (0, vitest_1.expect)(() => JSON.parse(raw)).not.toThrow();
            const parsed = JSON.parse(raw);
            (0, vitest_1.expect)(parsed.digest).toBeDefined();
            (0, vitest_1.expect)(typeof parsed.digest).toBe('string');
            (0, vitest_1.expect)(parsed.version).toBe(1);
            (0, vitest_1.expect)(parsed.type).toBe('TASK_COMPLETE');
        }
    });
    (0, vitest_1.it)('simple lock test — concurrent writes serialized by per-directory lock', async () => {
        // The lock mechanism ensures at most one write succeeds at a time.
        // Launch 10 concurrent writes with unique content and verify that
        // the lock directory is always cleaned up afterwards.
        const count = 10;
        const outcomes = await Promise.allSettled(Array.from({ length: count }, (_, i) => new Promise((resolve, reject) => {
            try {
                resolve((0, receipt_writer_1.writeReceipt)(validReceipt({ timestamp: `2025-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, payload: { idx: i } }), { receiptDir: concurDir, tempDir: concurDir }));
            }
            catch (e) {
                reject(e);
            }
        })));
        const succeeded = outcomes.filter(o => o.status === 'fulfilled');
        (0, vitest_1.expect)(succeeded.length).toBeGreaterThanOrEqual(1);
        // Lock is always released
        const lockDir = path.join(concurDir, '.receipt-lock');
        (0, vitest_1.expect)(fs.existsSync(lockDir)).toBe(false);
        // All written receipts pass digest check
        for (const file of fs.readdirSync(concurDir).filter(f => f.endsWith('.json') && !f.startsWith('.'))) {
            (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(path.join(concurDir, file))).toBe(true);
        }
    });
    (0, vitest_1.it)('concurrent same-chain writes produce a linear chain', async () => {
        // Use a clean directory for this test
        const sameChainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'same-chain-concur-'));
        try {
            // First, establish a genesis receipt
            const genesis = validReceipt({ type: 'SLICE_PLAN' });
            const genesisResult = (0, receipt_writer_1.writeReceipt)(genesis, { receiptDir: sameChainDir, tempDir: sameChainDir });
            // Now launch 5 concurrent writes, each attempting to append to the chain
            // with different payloads but the same previous_digest targeting the genesis
            // Since each write tries to be the first child of genesis, only the one that
            // acquires the lock first will succeed. The rest should fail with fork detection.
            const writers = Array.from({ length: 5 }, (_, i) => {
                const payload = { concurrent_seq: i };
                return validReceipt({
                    type: 'TASK_COMPLETE',
                    slice_id: 'S01-D',
                    timestamp: `2025-01-${String(i + 2).padStart(2, '0')}T00:00:00.000Z`,
                    previous_digest: genesisResult.digest,
                    payload,
                });
            });
            // Launch all 5 concurrently via Promise.allSettled
            const outcomes = await Promise.allSettled(writers.map(r => new Promise((resolve, reject) => {
                try {
                    resolve((0, receipt_writer_1.writeReceipt)(r, { receiptDir: sameChainDir, tempDir: sameChainDir }));
                }
                catch (e) {
                    reject(e);
                }
            })));
            const succeeded = outcomes.filter(o => o.status === 'fulfilled');
            const failed = outcomes.filter(o => o.status === 'rejected');
            // Exactly 1 must succeed (the one that got the lock first)
            (0, vitest_1.expect)(succeeded.length).toBe(1);
            // The rest should fail with fork detection
            (0, vitest_1.expect)(failed.length).toBe(4);
            // Chain verification should pass (all written receipts form a valid chain)
            const chainResult = (0, receipt_writer_1.verifyReceiptChain)(sameChainDir);
            (0, vitest_1.expect)(chainResult.valid).toBe(true);
            // No temp files remain
            const files = fs.readdirSync(sameChainDir);
            const tmpFiles = files.filter(f => f.includes('.tmp.'));
            (0, vitest_1.expect)(tmpFiles).toHaveLength(0);
            // Lock is released
            const lockDir = path.join(sameChainDir, '.receipt-lock');
            (0, vitest_1.expect)(fs.existsSync(lockDir)).toBe(false);
        }
        finally {
            fs.rmSync(sameChainDir, { recursive: true, force: true });
        }
    });
    (0, vitest_1.it)('linear chain of 3 receipts with concurrent writers at each step', async () => {
        const linearDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-chain-concur-'));
        try {
            // Step 1: Genesis
            const gResult = (0, receipt_writer_1.writeReceipt)(validReceipt({ type: 'SLICE_PLAN' }), { receiptDir: linearDir, tempDir: linearDir });
            // Step 2: 3 concurrent writers all trying to append to genesis
            const step2writers = Array.from({ length: 3 }, (_, i) => validReceipt({
                type: 'TASK_COMPLETE',
                slice_id: 'S01-D',
                timestamp: `2025-01-0${i + 2}T00:00:00.000Z`,
                previous_digest: gResult.digest,
                payload: { step: 2, writer: i },
            }));
            const step2outcomes = await Promise.allSettled(step2writers.map(r => new Promise((resolve, reject) => {
                try {
                    resolve((0, receipt_writer_1.writeReceipt)(r, { receiptDir: linearDir, tempDir: linearDir }));
                }
                catch (e) {
                    reject(e);
                }
            })));
            const step2succeeded = step2outcomes.filter(o => o.status === 'fulfilled');
            (0, vitest_1.expect)(step2succeeded.length).toBe(1);
            const step2Result = step2succeeded[0].value;
            // Step 3: 3 concurrent writers all trying to append to step 2
            const step3writers = Array.from({ length: 3 }, (_, i) => validReceipt({
                type: 'TASK_COMPLETE',
                slice_id: 'S01-D',
                timestamp: `2025-01-0${i + 5}T00:00:00.000Z`,
                previous_digest: step2Result.digest,
                payload: { step: 3, writer: i },
            }));
            const step3outcomes = await Promise.allSettled(step3writers.map(r => new Promise((resolve, reject) => {
                try {
                    resolve((0, receipt_writer_1.writeReceipt)(r, { receiptDir: linearDir, tempDir: linearDir }));
                }
                catch (e) {
                    reject(e);
                }
            })));
            const step3succeeded = step3outcomes.filter(o => o.status === 'fulfilled');
            (0, vitest_1.expect)(step3succeeded.length).toBe(1);
            // Final chain: genesis → step2 → step3 (3 receipts)
            const finalResult = (0, receipt_writer_1.verifyReceiptChain)(linearDir);
            (0, vitest_1.expect)(finalResult.valid).toBe(true);
            (0, vitest_1.expect)(finalResult.receipts).toHaveLength(3);
            // No temp files
            const files = fs.readdirSync(linearDir);
            (0, vitest_1.expect)(files.filter(f => f.includes('.tmp.'))).toHaveLength(0);
        }
        finally {
            fs.rmSync(linearDir, { recursive: true, force: true });
        }
    });
});
// ============================================================
// Additional duplicate rejection edge cases
// ============================================================
(0, vitest_1.describe)('writeReceipt — Duplicate rejection edge cases', () => {
    let edgeDir;
    (0, vitest_1.beforeEach)(() => {
        edgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-edge-'));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(edgeDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('rejects exact same data written twice', () => {
        const receipt = validReceipt({
            slice_id: 'S01-D',
            payload: { hello: 'world' },
        });
        const first = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: edgeDir, tempDir: edgeDir });
        (0, vitest_1.expect)(first).toBeDefined();
        // Second write with identical data must throw ReceiptChainError
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: edgeDir, tempDir: edgeDir }))
            .toThrow(errors_1.ReceiptChainError);
    });
    (0, vitest_1.it)('rejects write when the receipt file already exists from a previous session', () => {
        // Manually create a receipt file (simulating a previous session's receipt)
        // Must use valid receipt data so schema validation passes
        const receiptData = validReceipt({ type: 'SLICE_PLAN' });
        const digest = (0, receipt_writer_1.computeReceiptDigest)(receiptData);
        const filePath = path.join(edgeDir, `${digest}.json`);
        const data = { ...receiptData, digest };
        fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
        // Try to write this receipt — should be rejected with ReceiptChainError
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receiptData, { receiptDir: edgeDir, tempDir: edgeDir })).toThrow(errors_1.ReceiptChainError);
    });
});
// ============================================================
// Additional predecessor chain validation edge cases
// ============================================================
(0, vitest_1.describe)('writeReceipt — Predecessor chain validation edge cases', () => {
    let chainDir;
    (0, vitest_1.beforeEach)(() => {
        chainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-chain-edge-'));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(chainDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('treats empty previous_digest as genesis (no predecessor validation)', () => {
        const receipt = validReceipt({
            slice_id: 'S01-D',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: '',
        });
        // Empty previous_digest should be treated as no predecessor (like genesis)
        const result = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: chainDir, tempDir: chainDir });
        (0, vitest_1.expect)(result).toBeDefined();
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(result.path)).toBe(true);
        // The written receipt should have no previous_digest (empty string normalized
        // to undefined before validation — genesis semantics)
        const content = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
        (0, vitest_1.expect)(content.previous_digest).toBeUndefined();
    });
    (0, vitest_1.it)('rejects chain where predecessor has been tampered', () => {
        // Write genesis
        const genesis = validReceipt({ type: 'SLICE_PLAN' });
        const gResult = (0, receipt_writer_1.writeReceipt)(genesis, { receiptDir: chainDir, tempDir: chainDir });
        // Tamper with genesis (keep old digest — so digest no longer matches)
        const gContent = JSON.parse(fs.readFileSync(gResult.path, 'utf-8'));
        gContent.payload = { tampered: true };
        fs.writeFileSync(gResult.path, JSON.stringify(gContent, null, 2), 'utf-8');
        // Now try to write a receipt that references the tampered genesis
        const second = validReceipt({
            slice_id: 'S01-D',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: gResult.digest,
            payload: { task: 'after-tamper' },
        });
        // The predecessor validation should detect the tampered digest
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(second, { receiptDir: chainDir, tempDir: chainDir })).toThrow(errors_1.ReceiptChainError);
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(second, { receiptDir: chainDir, tempDir: chainDir })).toThrow(/invalid digest|predecessor|chain integrity check/i);
    });
});
// ============================================================
// Caller-supplied digest rejection tests
// ============================================================
(0, vitest_1.describe)('writeReceipt — Caller-supplied digest rejection', () => {
    let digestDir;
    (0, vitest_1.beforeEach)(() => {
        digestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-digest-reject-'));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(digestDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('throws when caller-supplied digest does not match computed digest', () => {
        const receipt = validReceipt({
            digest: '0000000000000000000000000000000000000000000000000000000000000000',
        });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: digestDir, tempDir: digestDir })).toThrow(/caller-supplied digest.*does not match/i);
    });
    (0, vitest_1.it)('accepts caller-supplied digest when it matches computed digest', () => {
        const receiptContent = validReceipt();
        const computed = (0, receipt_writer_1.computeReceiptDigest)(receiptContent);
        const receipt = { ...receiptContent, digest: computed };
        const result = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: digestDir, tempDir: digestDir });
        (0, vitest_1.expect)(result).toBeDefined();
        (0, vitest_1.expect)(result.digest).toBe(computed);
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(result.path)).toBe(true);
    });
});
// ============================================================
// Fork detection tests
// ============================================================
(0, vitest_1.describe)('writeReceipt — Fork detection', () => {
    let forkDir;
    (0, vitest_1.beforeEach)(() => {
        forkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-fork-'));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(forkDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('allows writing a genesis receipt when no receipts exist', () => {
        const receipt = validReceipt({ type: 'SLICE_PLAN' });
        const result = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: forkDir, tempDir: forkDir });
        (0, vitest_1.expect)(result).toBeDefined();
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(result.path)).toBe(true);
    });
    (0, vitest_1.it)('allows appending to the latest receipt in the chain', () => {
        const genesis = validReceipt({ type: 'SLICE_PLAN' });
        const gResult = (0, receipt_writer_1.writeReceipt)(genesis, { receiptDir: forkDir, tempDir: forkDir });
        // Append to genesis (which is the latest)
        const second = validReceipt({
            type: 'TASK_COMPLETE',
            slice_id: 'S01-D',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: gResult.digest,
        });
        const sResult = (0, receipt_writer_1.writeReceipt)(second, { receiptDir: forkDir, tempDir: forkDir });
        (0, vitest_1.expect)(sResult).toBeDefined();
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(sResult.path)).toBe(true);
    });
    (0, vitest_1.it)('rejects a receipt whose previous_digest does not match the latest receipt', () => {
        // Write genesis
        const genesis = validReceipt({ type: 'SLICE_PLAN' });
        const gResult = (0, receipt_writer_1.writeReceipt)(genesis, { receiptDir: forkDir, tempDir: forkDir });
        // Write second receipt (now latest)
        const second = validReceipt({
            type: 'TASK_COMPLETE',
            slice_id: 'S01-D',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: gResult.digest,
        });
        (0, receipt_writer_1.writeReceipt)(second, { receiptDir: forkDir, tempDir: forkDir });
        // Try to write another receipt that points to genesis (not the latest)
        const forkAttempt = validReceipt({
            type: 'TASK_COMPLETE',
            slice_id: 'S01-D',
            timestamp: '2025-01-03T00:00:00.000Z',
            previous_digest: gResult.digest, // points to genesis, NOT the latest (second)
            payload: { fork: true },
        });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(forkAttempt, { receiptDir: forkDir, tempDir: forkDir })).toThrow(errors_1.ReceiptChainError);
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(forkAttempt, { receiptDir: forkDir, tempDir: forkDir })).toThrow(/fork detected/i);
    });
    (0, vitest_1.it)('allows writing a genesis receipt when other receipts exist (separate chain)', () => {
        // Write a normal chain
        const genesis = validReceipt({ type: 'SLICE_PLAN' });
        const gResult = (0, receipt_writer_1.writeReceipt)(genesis, { receiptDir: forkDir, tempDir: forkDir });
        const second = validReceipt({
            type: 'TASK_COMPLETE',
            timestamp: '2025-01-02T00:00:00.000Z',
            previous_digest: gResult.digest,
        });
        (0, receipt_writer_1.writeReceipt)(second, { receiptDir: forkDir, tempDir: forkDir });
        // Writing a genesis (no previous_digest) should be allowed even though
        // other receipts exist — fork detection only applies when previous_digest
        // is specified.
        const newChain = validReceipt({
            type: 'SLICE_PLAN',
            timestamp: '2025-01-01T00:00:00.000Z',
            payload: { separate: true },
        });
        const newResult = (0, receipt_writer_1.writeReceipt)(newChain, { receiptDir: forkDir, tempDir: forkDir });
        (0, vitest_1.expect)(newResult).toBeDefined();
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(newResult.path)).toBe(true);
    });
});
// ============================================================
// Schema validation integration tests
// ============================================================
(0, vitest_1.describe)('writeReceipt — Schema validation', () => {
    let schemaDir;
    (0, vitest_1.beforeEach)(() => {
        schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-schema-'));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(schemaDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('accepts valid receipt data and writes it successfully', () => {
        const receipt = validReceipt({ type: 'SLICE_PLAN' });
        const result = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: schemaDir, tempDir: schemaDir });
        (0, vitest_1.expect)(result).toBeDefined();
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(result.path)).toBe(true);
    });
    (0, vitest_1.it)('throws a descriptive error for receipt data that fails schema validation', () => {
        // Missing required fields like 'type'
        const badReceipt = { version: 1, stage_id: 'S01', timestamp: '2025-01-01T00:00:00.000Z', payload: {} };
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(badReceipt, { receiptDir: schemaDir, tempDir: schemaDir })).toThrow(/receipt validation failed/i);
    });
    (0, vitest_1.it)('throws schema error for invalid receipt type', () => {
        const badReceipt = validReceipt({ type: 'INVALID_TYPE' });
        (0, vitest_1.expect)(() => (0, receipt_writer_1.writeReceipt)(badReceipt, { receiptDir: schemaDir, tempDir: schemaDir })).toThrow(/receipt validation failed/i);
    });
});
// ============================================================
// Independent digest oracle tests
// ============================================================
(0, vitest_1.describe)('ReceiptWriter — Independent digest oracle', () => {
    let oracleDir;
    (0, vitest_1.beforeEach)(() => {
        oracleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-oracle-'));
    });
    (0, vitest_1.afterEach)(() => {
        fs.rmSync(oracleDir, { recursive: true, force: true });
    });
    (0, vitest_1.it)('stored digest matches independently computed SHA-256 from disk', () => {
        const receipt = validReceipt({
            slice_id: 'S01-D',
            payload: { oracle: true },
        });
        const result = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: oracleDir, tempDir: oracleDir });
        // Read the file from disk
        const raw = fs.readFileSync(result.path, 'utf-8');
        const parsed = JSON.parse(raw);
        const storedDigest = parsed.digest;
        // Independently compute expected digest:
        // 1. Strip 'digest' from the parsed data
        const { digest: _ignore, ...contentFromDisk } = parsed;
        // 2. Serialize with independent canonical JSON (not computeReceiptDigest)
        const expectedDigest = independentDigest(contentFromDisk);
        (0, vitest_1.expect)(storedDigest).toBe(expectedDigest);
    });
    (0, vitest_1.it)('digest in returned result matches independent computation', () => {
        const receipt = validReceipt({
            slice_id: 'S01-D',
            payload: { check: 'return' },
        });
        const result = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: oracleDir, tempDir: oracleDir });
        const expected = independentDigest(receipt);
        (0, vitest_1.expect)(result.digest).toBe(expected);
    });
    (0, vitest_1.it)('verifyReceiptDigest passes against independently verified content', () => {
        const receipt = validReceipt({
            slice_id: 'S01-D',
            payload: { verify: 'oracle' },
        });
        const result = (0, receipt_writer_1.writeReceipt)(receipt, { receiptDir: oracleDir, tempDir: oracleDir });
        // Read from disk and independently verify
        const raw = fs.readFileSync(result.path, 'utf-8');
        const parsed = JSON.parse(raw);
        const { digest: storedDigest, ...contentFromDisk } = parsed;
        const independent = independentDigest(contentFromDisk);
        (0, vitest_1.expect)(storedDigest).toBe(independent);
        // Also confirm the public verifier agrees
        (0, vitest_1.expect)((0, receipt_writer_1.verifyReceiptDigest)(result.path)).toBe(true);
    });
});
// ============================================================
// Helper to write a receipt in a specific directory and return its digest
// ============================================================
function writeReceiptIn(dir, data, name) {
    const digest = (0, receipt_writer_1.computeReceiptDigest)(data);
    const full = { ...data, digest };
    fs.writeFileSync(path.join(dir, name), JSON.stringify(full, null, 2), 'utf-8');
    return digest;
}
//# sourceMappingURL=receipt-writer.spec.js.map