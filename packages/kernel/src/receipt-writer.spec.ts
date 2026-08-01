/**
 * ReceiptWriter — RED/GREEN tests for the append-only receipt writer contract.
 *
 * PO: PO-S01-D-02, PO-S01-D-03
 *
 * Tests the public functions for digest computation, file digest verification,
 * and chain verification.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  computeReceiptDigest,
  verifyReceiptDigest,
  verifyReceiptChain,
  writeReceipt,
  assertValidReceiptChain,
  DEFAULT_LOCK_TIMEOUT_MS,
  type WriteReceiptResult,
  type ChainVerificationResult,
  type ReceiptWriterOptions,
} from './receipt-writer';
import { ReceiptChainError } from './errors';

// ══════════════════════════════════════════════════════════════════
// Test helper: independent canonical JSON + SHA-256 (digest oracle)
// ══════════════════════════════════════════════════════════════════

/**
 * Canonical JSON serializer with sorted keys — independent replica of the
 * private `canonicalJson` used inside receipt-writer.  Kept as a pure test
 * helper so the digest oracle does not rely on `computeReceiptDigest`.
 */
function canonicalSortStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSortStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
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
function independentDigest(data: object): string {
  const json = canonicalSortStringify(data);
  return crypto.createHash('sha256').update(json, 'utf-8').digest('hex');
}

// ══════════════════════════════════════════════════════════════════
// Minimal valid receipt factory
// ══════════════════════════════════════════════════════════════════

function validReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

describe('computeReceiptDigest', () => {
  it('returns a 64-character hex string (SHA-256)', () => {
    const digest = computeReceiptDigest({ hello: 'world' });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the same digest for identical data with sorted keys', () => {
    const a = computeReceiptDigest({ b: 1, a: 2 });
    const b = computeReceiptDigest({ a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('returns different digests for different data', () => {
    const a = computeReceiptDigest({ value: 1 });
    const b = computeReceiptDigest({ value: 2 });
    expect(a).not.toBe(b);
  });

  it('handles nested objects deterministically', () => {
    const a = computeReceiptDigest({ nested: { z: 1, a: 2 } });
    const b = computeReceiptDigest({ nested: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('produces a known SHA-256 hex digest for a simple payload', () => {
    // SHA-256 of canonical JSON '{"hello":"world"}'
    const digest = computeReceiptDigest({ hello: 'world' });
    // Known hash: sha256('{"hello":"world"}')
    expect(digest).toBe('93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588');
  });

  it('rejects non-object input gracefully', () => {
    expect(() => (computeReceiptDigest as (d: unknown) => string)(null)).toThrow();
    expect(() => (computeReceiptDigest as (d: unknown) => string)(undefined)).toThrow();
    expect(() => (computeReceiptDigest as (d: unknown) => string)('string')).toThrow();
  });

  it('rejects NaN values in payload with a descriptive TypeError', () => {
    expect(() => computeReceiptDigest({ value: NaN })).toThrow(TypeError);
    expect(() => computeReceiptDigest({ value: NaN })).toThrow(/non-finite/);
  });

  it('rejects Infinity values in payload with a descriptive TypeError', () => {
    expect(() => computeReceiptDigest({ value: Infinity })).toThrow(TypeError);
    expect(() => computeReceiptDigest({ value: Infinity })).toThrow(/non-finite/);
  });

  it('rejects -Infinity values in payload with a descriptive TypeError', () => {
    expect(() => computeReceiptDigest({ value: -Infinity })).toThrow(TypeError);
    expect(() => computeReceiptDigest({ value: -Infinity })).toThrow(/non-finite/);
  });

  it('rejects NaN in nested objects', () => {
    expect(() => computeReceiptDigest({ nested: { score: NaN } })).toThrow(TypeError);
  });

  it('accepts valid finite numbers including zero, negative, and fractional', () => {
    const a = computeReceiptDigest({ value: 0 });
    const b = computeReceiptDigest({ value: -1 });
    const c = computeReceiptDigest({ value: 3.14 });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(c).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ============================================================
// verifyReceiptDigest — file-based
// ============================================================

describe('verifyReceiptDigest', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-writer-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when file digest matches content', () => {
    const receipt = validReceipt({
      slice_id: 'S01-D',
      payload: {},
    });
    const digest = computeReceiptDigest(receipt);
    const data = { ...receipt, digest };
    const filePath = path.join(tmpDir, 'valid-receipt.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    expect(verifyReceiptDigest(filePath)).toBe(true);
  });

  it('returns false when file digest does not match content', () => {
    const data = { ...validReceipt(), digest: '0000000000000000000000000000000000000000000000000000000000000000' };
    const filePath = path.join(tmpDir, 'tampered-receipt.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    expect(verifyReceiptDigest(filePath)).toBe(false);
  });

  it('returns false for non-existent file', () => {
    expect(verifyReceiptDigest(path.join(tmpDir, 'nonexistent.json'))).toBe(false);
  });

  it('returns false for malformed JSON', () => {
    const filePath = path.join(tmpDir, 'bad-json.json');
    fs.writeFileSync(filePath, 'not json', 'utf-8');
    expect(verifyReceiptDigest(filePath)).toBe(false);
  });

  it('returns false when digest field is missing', () => {
    const data = validReceipt();
    const filePath = path.join(tmpDir, 'no-digest.json');
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    expect(verifyReceiptDigest(filePath)).toBe(false);
  });

  it('handles receipts with previous_digest field', () => {
    const receipt = validReceipt({
      type: 'SLICE_PLAN',
      previous_digest: 'abc',
    });
    const digest = computeReceiptDigest(receipt);
    const data = { ...receipt, digest };
    const filePath = path.join(tmpDir, 'with-previous-digest.json');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    expect(verifyReceiptDigest(filePath)).toBe(true);
  });

  it('returns false when file is a directory', () => {
    expect(verifyReceiptDigest(tmpDir)).toBe(false);
  });
});

// ============================================================
// writeReceipt
// ============================================================

describe('writeReceipt', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-write-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes a receipt file that passes verifyReceiptDigest and returns path+digest', () => {
    const receipt = validReceipt({
      slice_id: 'S01-D',
      payload: { task: 'T02' },
    });

    const result = writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir });

    // Result shape
    expect(result).toHaveProperty('path');
    expect(result).toHaveProperty('digest');
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);

    // File exists at returned path
    expect(fs.existsSync(result.path)).toBe(true);

    // File passes digest verification
    expect(verifyReceiptDigest(result.path)).toBe(true);

    // Stored digest matches returned digest
    const fileContent = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
    expect(fileContent.digest).toBe(result.digest);

    // File is in receiptDir
    expect(path.dirname(result.path)).toBe(tmpDir);
  });

  it('cleans up temp files after successful write', () => {
    const receipt = validReceipt({
      slice_id: 'S01-D',
      timestamp: '2025-01-02T00:00:00.000Z',
      payload: { task: 'T02-cleanup' },
    });

    writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir });

    // No .tmp. files should remain
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('throws TypeError for non-object data', () => {
    expect(() =>
      (writeReceipt as (d: unknown, o: ReceiptWriterOptions) => WriteReceiptResult)(null, { receiptDir: tmpDir, tempDir: tmpDir }),
    ).toThrow(TypeError);

    expect(() =>
      (writeReceipt as (d: unknown, o: ReceiptWriterOptions) => WriteReceiptResult)('string', { receiptDir: tmpDir, tempDir: tmpDir }),
    ).toThrow(TypeError);
  });

  it('throws descriptive error when receiptDir does not exist', () => {
    const nonExistentDir = path.join(os.tmpdir(), 'does-not-exist-99999');
    // Use valid receipt data so schema validation passes
    expect(() =>
      writeReceipt(validReceipt(), { receiptDir: nonExistentDir, tempDir: tmpDir }),
    ).toThrow();
  });

  it('rejects duplicate receipt writes', () => {
    const receipt = validReceipt({
      timestamp: '2025-01-01T00:00:00.000Z',
      payload: { msg: 'hello' },
    });

    const a = writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir });

    // Same content => same digest => second write must throw duplicate
    expect(() => writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir }))
      .toThrow(ReceiptChainError);
    expect(() => writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir }))
      .toThrow(/duplicate receipt/i);

    // First result unchanged
    expect(fs.existsSync(a.path)).toBe(true);
    expect(verifyReceiptDigest(a.path)).toBe(true);
  });

  it('allows different receipts with same fields but different values', () => {
    const receiptA = validReceipt({
      timestamp: '2025-01-01T00:00:00.000Z',
      payload: { id: 'a' },
    });
    const receiptB = validReceipt({
      timestamp: '2025-01-01T00:00:00.000Z',
      payload: { id: 'b' },
    });

    const a = writeReceipt(receiptA, { receiptDir: tmpDir, tempDir: tmpDir });
    const b = writeReceipt(receiptB, { receiptDir: tmpDir, tempDir: tmpDir });

    // Different content => different digests => both should succeed
    expect(a.digest).not.toBe(b.digest);
    expect(a.path).not.toBe(b.path);
    expect(verifyReceiptDigest(a.path)).toBe(true);
    expect(verifyReceiptDigest(b.path)).toBe(true);
  });

  it('validates predecessor exists for linked receipts', () => {
    // Write genesis receipt
    const genesis = validReceipt({
      type: 'SLICE_PLAN',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    const genesisResult = writeReceipt(genesis, { receiptDir: tmpDir, tempDir: tmpDir });

    // Write a linked receipt with valid previous_digest
    const linked = validReceipt({
      type: 'TASK_COMPLETE',
      slice_id: 'S01-D',
      timestamp: '2025-01-02T00:00:00.000Z',
      previous_digest: genesisResult.digest,
      payload: { task: 'T03' },
    });
    const linkedResult = writeReceipt(linked, { receiptDir: tmpDir, tempDir: tmpDir });

    expect(verifyReceiptDigest(linkedResult.path)).toBe(true);
    const content = JSON.parse(fs.readFileSync(linkedResult.path, 'utf-8'));
    expect(content.previous_digest).toBe(genesisResult.digest);
  });

  it('throws when previous_digest references non-existent receipt', () => {
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
      expect(() =>
        writeReceipt(receipt, { receiptDir: cleanDir, tempDir: cleanDir }),
      ).toThrow(ReceiptChainError);
      expect(() =>
        writeReceipt(receipt, { receiptDir: cleanDir, tempDir: cleanDir }),
      ).toThrow(/previous receipt|predecessor/i);
    } finally {
      fs.rmSync(cleanDir, { recursive: true, force: true });
    }
  });

  it('throws when predecessor receipt has invalid digest', () => {
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

    expect(() =>
      writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir }),
    ).toThrow(ReceiptChainError);
    expect(() =>
      writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir }),
    ).toThrow(/invalid digest|predecessor|chain integrity check/i);
  });

  it('acquires and releases a lock directory during write', () => {
    const receipt = validReceipt({
      timestamp: '2025-01-10T00:00:00.000Z',
      payload: { test: 'lock' },
    });

    writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir });

    // Lock directory should be cleaned up
    const lockDir = path.join(tmpDir, '.receipt-lock');
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('rejects lock contention with ReceiptChainError when another write holds the lock', () => {
    const lockDir = path.join(tmpDir, '.receipt-lock');
    fs.mkdirSync(lockDir);

    const receipt = validReceipt({ type: 'SLICE_PLAN' });

    expect(() =>
      writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir }),
    ).toThrow(ReceiptChainError);
    expect(() =>
      writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir }),
    ).toThrow(/lock/i);

    // Lock directory still exists (held by the fake lock)
    expect(fs.existsSync(lockDir)).toBe(true);

    // No temp files were left
    const files = fs.readdirSync(tmpDir).filter(f => f !== '.receipt-lock');
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);

    // Clean up
    fs.rmdirSync(lockDir);
  });

  it('recovers from a stale lock directory older than DEFAULT_LOCK_TIMEOUT_MS', () => {
    const lockDir = path.join(tmpDir, '.receipt-lock');
    fs.mkdirSync(lockDir);

    // Set mtime to the past (older than timeout)
    const oldTime = new Date(Date.now() - DEFAULT_LOCK_TIMEOUT_MS - 1000);
    fs.utimesSync(lockDir, oldTime, oldTime);

    // Use a unique payload so the digest does not clash with previously written receipts
    const receipt = validReceipt({
      type: 'SLICE_PLAN',
      payload: { stale_lock_recovery: true, ts: Date.now() },
    });
    const result = writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir });

    // Write should succeed (stale lock was recovered)
    expect(result).toBeDefined();
    expect(verifyReceiptDigest(result.path)).toBe(true);

    // Lock directory should be cleaned up
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('throws ReceiptChainError for a fresh lock (not yet stale)', () => {
    const lockDir = path.join(tmpDir, '.receipt-lock');
    fs.mkdirSync(lockDir);

    // Set mtime to now (fresh lock)
    const now = new Date();
    fs.utimesSync(lockDir, now, now);

    const receipt = validReceipt({ type: 'SLICE_PLAN' });

    expect(() =>
      writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir }),
    ).toThrow(ReceiptChainError);

    // Lock directory still exists
    expect(fs.existsSync(lockDir)).toBe(true);

    // Clean up
    fs.rmdirSync(lockDir);
  });

  it('rejects a lock whose owner.pid points to a live process — never deletes an active lock (S01-RR-005)', () => {
    const lockDir = path.join(tmpDir, '.receipt-lock');
    fs.mkdirSync(lockDir);

    // Simulate a lock held by a live writer: this test process itself.
    // This also covers the same-process / nested-acquisition edge case — an
    // owner.pid equal to our own PID must never be treated as stale (a
    // nested acquisition must throw, not delete the outer holder's lock).
    fs.writeFileSync(
      path.join(lockDir, 'owner.pid'),
      `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
      'utf-8',
    );

    const receipt = validReceipt({
      type: 'SLICE_PLAN',
      payload: { s01rr005_active_owner: true, ts: Date.now() },
    });

    expect(() =>
      writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir }),
    ).toThrow(ReceiptChainError);
    expect(() =>
      writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir }),
    ).toThrow(/lock/i);

    // The lock must NOT be deleted — its owner is alive regardless of age.
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.existsSync(path.join(lockDir, 'owner.pid'))).toBe(true);

    // No temp files were left
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);

    // Clean up
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it('recovers from a lock whose owner.pid points to a dead process — even with a fresh mtime (S01-RR-005)', () => {
    const lockDir = path.join(tmpDir, '.receipt-lock');
    fs.mkdirSync(lockDir);

    // Obtain a PID that is guaranteed to be dead: spawn a child that exits
    // immediately; spawnSync waits for it, so the PID is free afterwards.
    const child = spawnSync(process.execPath, ['-e', ''], { timeout: 10_000 });
    expect(child.status).toBe(0);
    expect(child.pid).toBeGreaterThan(0);
    const deadPid = child.pid as number;

    fs.writeFileSync(
      path.join(lockDir, 'owner.pid'),
      `${JSON.stringify({ pid: deadPid, startedAt: Date.now() })}\n`,
      'utf-8',
    );

    // The lock directory mtime is fresh — the old mtime heuristic would
    // have treated this as an active lock.  PID liveness must recover it.
    const receipt = validReceipt({
      type: 'SLICE_PLAN',
      payload: { s01rr005_dead_owner: true, ts: Date.now() },
    });
    const result = writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir });

    // Write should succeed (stale lock recovered via dead PID)
    expect(result).toBeDefined();
    expect(verifyReceiptDigest(result.path)).toBe(true);

    // Lock directory should be cleaned up
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('treats EPERM from process.kill as an alive owner (Windows compatibility)', () => {
    const lockDir = path.join(tmpDir, '.receipt-lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.pid'),
      `${JSON.stringify({ pid: 999_999_999, startedAt: Date.now() })}\n`,
      'utf-8',
    );

    // On Windows, probing a process owned by another user throws EPERM
    // instead of succeeding — that must be treated as "alive", not stale.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => {
      const e = new Error('EPERM') as NodeJS.ErrnoException;
      e.code = 'EPERM';
      throw e;
    }) as (pid: number, signal?: string | number) => true);

    try {
      const receipt = validReceipt({
        type: 'SLICE_PLAN',
        payload: { s01rr005_eperm: true, ts: Date.now() },
      });
      expect(() =>
        writeReceipt(receipt, { receiptDir: tmpDir, tempDir: tmpDir }),
      ).toThrow(ReceiptChainError);

      // Lock must still exist (owner treated as alive)
      expect(fs.existsSync(lockDir)).toBe(true);
    } finally {
      killSpy.mockRestore();
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// verifyReceiptChain
// ============================================================

describe('verifyReceiptChain', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-chain-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeReceipt(data: Record<string, unknown>, name: string): string {
    const digest = computeReceiptDigest(data);
    const full = { ...data, digest };
    const filePath = path.join(tmpDir, name);
    fs.writeFileSync(filePath, JSON.stringify(full, null, 2), 'utf-8');
    return digest;
  }

  it('returns valid for a single receipt with no previous_digest (genesis)', () => {
    writeReceipt(validReceipt({ type: 'SLICE_PLAN' }), 'genesis.json');

    const result = verifyReceiptChain(tmpDir);
    expect(result.valid).toBe(true);
    expect(result.receipts).toHaveLength(1);
    expect(result.brokenLink).toBeUndefined();
  });

  it('returns valid for a linked chain of receipts', () => {
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

      const result = verifyReceiptChain(chainDir);
      expect(result.valid).toBe(true);
      expect(result.receipts).toHaveLength(3);
      expect(result.brokenLink).toBeUndefined();
    } finally {
      fs.rmSync(chainDir, { recursive: true, force: true });
    }
  });

  it('detects a broken link (wrong previous_digest)', () => {
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

      const result = verifyReceiptChain(chainDir);
      expect(result.valid).toBe(false);
      expect(result.brokenLink).toBeDefined();
      if (result.brokenLink) {
        expect(result.brokenLink.expected).toBe('BAD_DIGEST_DOES_NOT_MATCH');
      }
    } finally {
      fs.rmSync(chainDir, { recursive: true, force: true });
    }
  });

  it('detects a receipt with broken self-digest within a chain', () => {
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
      const computedDigest = computeReceiptDigest(receiptData);
      // Write with a wrong digest
      const badData = { ...receiptData, digest: '0000000000000000000000000000000000000000000000000000000000000000' };
      fs.writeFileSync(path.join(chainDir, '002-tampered.json'), JSON.stringify(badData, null, 2), 'utf-8');

      const result = verifyReceiptChain(chainDir);
      // Chain should detect the broken self-digest and be invalid
      expect(result.valid).toBe(false);
    } finally {
      fs.rmSync(chainDir, { recursive: true, force: true });
    }
  });

  it('handles empty directory', () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-empty-'));
    try {
      const result = verifyReceiptChain(emptyDir);
      expect(result.valid).toBe(true);
      expect(result.receipts).toEqual([]);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('handles non-existent directory', () => {
    const result = verifyReceiptChain(path.join(tmpDir, 'nonexistent'));
    expect(result.valid).toBe(true);
    expect(result.receipts).toEqual([]);
  });

  it('handles directory with non-JSON files', () => {
    const mixedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-mixed-'));
    try {
      fs.writeFileSync(path.join(mixedDir, 'readme.txt'), 'hello', 'utf-8');
      writeReceiptIn(mixedDir, validReceipt({ type: 'SLICE_PLAN' }), 'receipt.json');

      const result = verifyReceiptChain(mixedDir);
      expect(result.valid).toBe(true);
      expect(result.receipts).toHaveLength(1);
    } finally {
      fs.rmSync(mixedDir, { recursive: true, force: true });
    }
  });

  it('handles multiple unlinked receipts (no previous_digest) treating each as a separate chain root', () => {
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

      const result = verifyReceiptChain(multiDir);
      // Each is a valid chain of length 1, but they are listed in receipt order
      expect(result.valid).toBe(true);
      expect(result.receipts).toHaveLength(2);
    } finally {
      fs.rmSync(multiDir, { recursive: true, force: true });
    }
  });

  it('detects duplicate digests (same digest under different filenames)', () => {
    const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-dup-digest-'));
    try {
      // Write the same receipt content to two different filenames
      const receiptData = validReceipt({ type: 'SLICE_PLAN' });
      const digest = computeReceiptDigest(receiptData);
      const fullData = { ...receiptData, digest };

      // Same digest, different filenames
      fs.writeFileSync(path.join(dupDir, 'dup-a.json'), JSON.stringify(fullData, null, 2), 'utf-8');
      fs.writeFileSync(path.join(dupDir, 'dup-b.json'), JSON.stringify(fullData, null, 2), 'utf-8');

      const result = verifyReceiptChain(dupDir);
      expect(result.valid).toBe(false);
      expect(result.duplicateDigests).toBeDefined();
      expect(result.duplicateDigests).toHaveLength(1);
      if (result.duplicateDigests) {
        expect(result.duplicateDigests[0].digest).toBe(digest);
        expect(result.duplicateDigests[0].paths).toHaveLength(2);
      }
    } finally {
      fs.rmSync(dupDir, { recursive: true, force: true });
    }
  });

  it('detects multiple duplicate digest groups', () => {
    const multiDupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-multi-dup-'));
    try {
      // Create two distinct receipts, each duplicated
      const r1 = validReceipt({ type: 'SLICE_PLAN', payload: { id: 'a' } });
      const d1 = computeReceiptDigest(r1);
      const f1 = { ...r1, digest: d1 };

      const r2 = validReceipt({ type: 'TASK_COMPLETE', payload: { id: 'b' } });
      const d2 = computeReceiptDigest(r2);
      const f2 = { ...r2, digest: d2 };

      // Each digest appears twice
      fs.writeFileSync(path.join(multiDupDir, 'a1.json'), JSON.stringify(f1, null, 2), 'utf-8');
      fs.writeFileSync(path.join(multiDupDir, 'a2.json'), JSON.stringify(f1, null, 2), 'utf-8');
      fs.writeFileSync(path.join(multiDupDir, 'b1.json'), JSON.stringify(f2, null, 2), 'utf-8');
      fs.writeFileSync(path.join(multiDupDir, 'b2.json'), JSON.stringify(f2, null, 2), 'utf-8');

      const result = verifyReceiptChain(multiDupDir);
      expect(result.valid).toBe(false);
      expect(result.duplicateDigests).toBeDefined();
      expect(result.duplicateDigests).toHaveLength(2);
    } finally {
      fs.rmSync(multiDupDir, { recursive: true, force: true });
    }
  });

  it('does not report duplicate when same digest appears once', () => {
    const singleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-single-'));
    try {
      writeReceiptIn(singleDir, validReceipt({ type: 'SLICE_PLAN' }), 'receipt.json');

      const result = verifyReceiptChain(singleDir);
      expect(result.valid).toBe(true);
      expect(result.duplicateDigests).toBeUndefined();
    } finally {
      fs.rmSync(singleDir, { recursive: true, force: true });
    }
  });

  it('assertValidReceiptChain throws ReceiptChainError for duplicate digests', () => {
    const dupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-assert-dup-'));
    try {
      const receiptData = validReceipt({ type: 'SLICE_PLAN' });
      const digest = computeReceiptDigest(receiptData);
      const fullData = { ...receiptData, digest };

      fs.writeFileSync(path.join(dupDir, 'a.json'), JSON.stringify(fullData, null, 2), 'utf-8');
      fs.writeFileSync(path.join(dupDir, 'b.json'), JSON.stringify(fullData, null, 2), 'utf-8');

      expect(() => assertValidReceiptChain(dupDir)).toThrow(ReceiptChainError);
    } finally {
      fs.rmSync(dupDir, { recursive: true, force: true });
    }
  });

  it('assertValidReceiptChain throws ReceiptChainError for broken links', () => {
    const brokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-assert-broken-'));
    try {
      writeReceiptIn(brokenDir, validReceipt({
        type: 'TASK_COMPLETE',
        timestamp: '2025-01-02T00:00:00.000Z',
        previous_digest: '0000000000000000000000000000000000000000000000000000000000000000',
      }), 'bad.json');

      expect(() => assertValidReceiptChain(brokenDir)).toThrow(ReceiptChainError);
    } finally {
      fs.rmSync(brokenDir, { recursive: true, force: true });
    }
  });

  it('assertValidReceiptChain does not throw for a valid chain', () => {
    const validDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-assert-valid-'));
    try {
      writeReceiptIn(validDir, validReceipt({ type: 'SLICE_PLAN' }), 'genesis.json');

      expect(() => assertValidReceiptChain(validDir)).not.toThrow();
    } finally {
      fs.rmSync(validDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Real filesystem integration tests (comprehensive)
// ============================================================

describe('ReceiptWriter — Real filesystem integration', () => {
  let chainDir: string;

  beforeAll(() => {
    chainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-real-fs-'));
  });

  afterAll(() => {
    fs.rmSync(chainDir, { recursive: true, force: true });
  });

  it('writes a chain of linked receipts, all files exist and digests match', () => {
    const genesis = validReceipt({ type: 'SLICE_PLAN' });
    const gResult = writeReceipt(genesis, { receiptDir: chainDir, tempDir: chainDir });

    // File exists at returned path
    expect(fs.existsSync(gResult.path)).toBe(true);
    // File name contains the digest
    expect(path.basename(gResult.path)).toBe(`${gResult.digest}.json`);
    // Digest matches recomputation
    expect(gResult.digest).toBe(computeReceiptDigest(genesis));
    // Self-verification passes
    expect(verifyReceiptDigest(gResult.path)).toBe(true);

    // Write a second receipt linked to genesis
    const second = validReceipt({
      type: 'TASK_COMPLETE',
      slice_id: 'S01-D',
      timestamp: '2025-01-02T00:00:00.000Z',
      previous_digest: gResult.digest,
      payload: { step: 2 },
    });
    const sResult = writeReceipt(second, { receiptDir: chainDir, tempDir: chainDir });

    expect(fs.existsSync(sResult.path)).toBe(true);
    expect(path.basename(sResult.path)).toBe(`${sResult.digest}.json`);
    expect(sResult.digest).toBe(computeReceiptDigest(second));
    expect(verifyReceiptDigest(sResult.path)).toBe(true);

    // Write third receipt linked to second
    const third = validReceipt({
      type: 'TASK_COMPLETE',
      slice_id: 'S01-D',
      timestamp: '2025-01-03T00:00:00.000Z',
      previous_digest: sResult.digest,
      payload: { step: 3 },
    });
    const tResult = writeReceipt(third, { receiptDir: chainDir, tempDir: chainDir });

    expect(fs.existsSync(tResult.path)).toBe(true);
    expect(verifyReceiptDigest(tResult.path)).toBe(true);

    // All files are in receiptDir
    const files = fs.readdirSync(chainDir);
    expect(files).toContain(`${gResult.digest}.json`);
    expect(files).toContain(`${sResult.digest}.json`);
    expect(files).toContain(`${tResult.digest}.json`);
  });

  it('chain verification passes for the linked chain', () => {
    const result = verifyReceiptChain(chainDir);
    expect(result.valid).toBe(true);
    expect(result.receipts).toHaveLength(3);
    expect(result.brokenLink).toBeUndefined();
  });

  it('no temp files remain after chain writes', () => {
    const files = fs.readdirSync(chainDir);
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('writes receipts with correct content-addressable filenames', () => {
    const singleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-ca-'));
    try {
      const data = validReceipt({ type: 'TASK_COMPLETE', payload: { test: 'content-addressable' } });
      const result = writeReceipt(data, { receiptDir: singleDir, tempDir: singleDir });
      // The filename IS the digest
      expect(path.basename(result.path)).toBe(`${result.digest}.json`);
      // Content at that path has matching digest field
      const raw = JSON.parse(fs.readFileSync(result.path, 'utf-8')) as Record<string, unknown>;
      expect(raw.digest).toBe(result.digest);
    } finally {
      fs.rmSync(singleDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Fault injection tests (real filesystem)
// ============================================================

describe('ReceiptWriter — Fault injection', () => {
  let faultDir: string;

  beforeEach(() => {
    faultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-fault-'));
  });

  afterEach(() => {
    fs.rmSync(faultDir, { recursive: true, force: true });
  });

  it('handles lock contention — another write in progress', () => {
    const lockDir = path.join(faultDir, '.receipt-lock');
    fs.mkdirSync(lockDir);

    const receipt = validReceipt({ type: 'SLICE_PLAN' });

    expect(() =>
      writeReceipt(receipt, { receiptDir: faultDir, tempDir: faultDir }),
    ).toThrow(/lock/i);
  });

  it('handles non-existent directory gracefully', () => {
    const badDir = path.join(os.tmpdir(), 'does-not-exist-' + Date.now());
    const receipt = validReceipt({ type: 'SLICE_PLAN' });

    expect(() =>
      writeReceipt(receipt, { receiptDir: badDir, tempDir: faultDir }),
    ).toThrow();

    // No temp files should remain in faultDir
    const files = fs.readdirSync(faultDir);
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('receiptDir with restricted permissions causes descriptive error', () => {
    // Make the dir read-only
    fs.chmodSync(faultDir, 0o444);

    const receipt = validReceipt({ type: 'SLICE_PLAN' });

    expect(() =>
      writeReceipt(receipt, { receiptDir: faultDir, tempDir: faultDir }),
    ).toThrow();

    // Restore permissions for cleanup
    fs.chmodSync(faultDir, 0o755);
  });

  it('cleans up temp and lock when write fails mid-operation', () => {
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

    expect(() =>
      writeReceipt(receipt, { receiptDir: faultDir, tempDir: faultDir }),
    ).toThrow();

    fs.chmodSync(faultDir, 0o755);

    // Lock should not exist after cleanup attempt
    expect(fs.existsSync(lockDir)).toBe(false);
    // No temp files
    const files = fs.readdirSync(faultDir);
    expect(files.filter(f => f.includes('.tmp.'))).toHaveLength(0);
  });
});

// ============================================================
// Tamper detection tests
// ============================================================

describe('ReceiptWriter — Tamper detection', () => {
  let tamperDir: string;

  beforeEach(() => {
    tamperDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-tamper-'));
  });

  afterEach(() => {
    fs.rmSync(tamperDir, { recursive: true, force: true });
  });

  it('verifyReceiptDigest catches tampered content on disk', () => {
    // Write a receipt via writeReceipt
    const receipt = validReceipt({
      slice_id: 'S01-D',
      payload: { task: 'tamper-test' },
    });
    const result = writeReceipt(receipt, { receiptDir: tamperDir, tempDir: tamperDir });

    // Verify it passes before tampering
    expect(verifyReceiptDigest(result.path)).toBe(true);

    // Tamper with the file content
    const originalContent = JSON.parse(fs.readFileSync(result.path, 'utf-8'));
    originalContent.payload = { task: 'EVIL_TAMPERED' };
    // Keep the old digest (which no longer matches content)
    fs.writeFileSync(result.path, JSON.stringify(originalContent, null, 2), 'utf-8');

    // Now verification must fail
    expect(verifyReceiptDigest(result.path)).toBe(false);
  });

  it('verifyReceiptChain catches a tampered receipt in a chain', () => {
    // Write a chain of 2 linked receipts
    const genesis = validReceipt({ type: 'SLICE_PLAN' });
    const gResult = writeReceipt(genesis, { receiptDir: tamperDir, tempDir: tamperDir });

    const second = validReceipt({
      type: 'TASK_COMPLETE',
      slice_id: 'S01-D',
      timestamp: '2025-01-02T00:00:00.000Z',
      previous_digest: gResult.digest,
      payload: { task: 'second' },
    });
    const sResult = writeReceipt(second, { receiptDir: tamperDir, tempDir: tamperDir });

    // Chain is valid before tampering
    expect(verifyReceiptChain(tamperDir).valid).toBe(true);

    // Tamper with genesis file: change its payload but keep old digest
    const genesisContent = JSON.parse(fs.readFileSync(gResult.path, 'utf-8'));
    genesisContent.payload = { tampered: true };
    fs.writeFileSync(gResult.path, JSON.stringify(genesisContent, null, 2), 'utf-8');

    // Chain must detect the broken self-digest
    const chainResult = verifyReceiptChain(tamperDir);
    expect(chainResult.valid).toBe(false);
  });

  it('verifyReceiptChain catches a broken previous_digest link after tampering', () => {
    // Write 3 linked receipts
    const r1 = validReceipt({ type: 'SLICE_PLAN' });
    const r1Result = writeReceipt(r1, { receiptDir: tamperDir, tempDir: tamperDir });

    const r2 = validReceipt({
      type: 'TASK_COMPLETE',
      slice_id: 'S01-D',
      timestamp: '2025-01-02T00:00:00.000Z',
      previous_digest: r1Result.digest,
    });
    const r2Result = writeReceipt(r2, { receiptDir: tamperDir, tempDir: tamperDir });

    const r3 = validReceipt({
      type: 'TASK_COMPLETE',
      slice_id: 'S01-D',
      timestamp: '2025-01-03T00:00:00.000Z',
      previous_digest: r2Result.digest,
    });
    writeReceipt(r3, { receiptDir: tamperDir, tempDir: tamperDir });

    // Tamper with r2: change its previous_digest to point to a non-existent digest
    const r2Content = JSON.parse(fs.readFileSync(r2Result.path, 'utf-8'));
    r2Content.previous_digest = '0000000000000000000000000000000000000000000000000000000000000000';
    // Since changing previous_digest changes the content, the digest no longer matches.
    // Recompute digest without the digest field
    const { digest: _oldDigest, ...r2WithoutDigest } = r2Content;
    const newDigest = computeReceiptDigest(r2WithoutDigest);
    r2Content.digest = newDigest;
    fs.writeFileSync(r2Result.path, JSON.stringify(r2Content, null, 2), 'utf-8');

    // The chain should detect the broken link — either r2's previous_digest is
    // not found or r3's previous_digest (original r2 digest) is not found since
    // r2's file now has a different digest.
    const chainResult = verifyReceiptChain(tamperDir);
    expect(chainResult.valid).toBe(false);
    expect(chainResult.brokenLink).toBeDefined();
  });
});

// ============================================================
// Concurrent append tests (real concurrent via Promise.all)
// ============================================================

describe('ReceiptWriter — Concurrent appends', () => {
  let concurDir: string;

  beforeEach(() => {
    concurDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-concur-'));
  });

  afterEach(() => {
    fs.rmSync(concurDir, { recursive: true, force: true });
  });

  it('handles concurrent writes to the same directory via Promise.all', async () => {
    const receipts = [
      validReceipt({ timestamp: '2025-01-01T00:00:00.000Z', payload: { seq: 1 } }),
      validReceipt({ timestamp: '2025-01-02T00:00:00.000Z', payload: { seq: 2 } }),
      validReceipt({ timestamp: '2025-01-03T00:00:00.000Z', payload: { seq: 3 } }),
      validReceipt({ timestamp: '2025-01-04T00:00:00.000Z', payload: { seq: 4 } }),
      validReceipt({ timestamp: '2025-01-05T00:00:00.000Z', payload: { seq: 5 } }),
    ];

    // Launch all 5 writes concurrently with Promise.allSettled
    const outcomes = await Promise.allSettled(
      receipts.map(r =>
        new Promise<WriteReceiptResult>((resolve, reject) => {
          try {
            resolve(writeReceipt(r, { receiptDir: concurDir, tempDir: concurDir }));
          } catch (e) {
            reject(e);
          }
        })
      )
    );

    const succeeded = outcomes.filter(o => o.status === 'fulfilled');
    const failed = outcomes.filter(o => o.status === 'rejected');

    // At least 1 should succeed (they all have different content, so no duplicates)
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    // Verify no temp files remain
    const files = fs.readdirSync(concurDir);
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    expect(tmpFiles).toHaveLength(0);

    // Lock directory should be cleaned up
    const lockDir = path.join(concurDir, '.receipt-lock');
    expect(fs.existsSync(lockDir)).toBe(false);

    // Chain verification passes for whatever was written
    const chainResult = verifyReceiptChain(concurDir);
    if (chainResult.receipts.length > 0) {
      for (const receiptPath of chainResult.receipts) {
        expect(verifyReceiptDigest(receiptPath)).toBe(true);
      }
    }
  });

  it('concurrent writes do not leave partial or corrupted files', async () => {
    const receipts = [
      validReceipt({ timestamp: '2025-01-01T00:00:00.000Z', payload: { id: 'concur-a' } }),
      validReceipt({ timestamp: '2025-01-02T00:00:00.000Z', payload: { id: 'concur-b' } }),
      validReceipt({ timestamp: '2025-01-03T00:00:00.000Z', payload: { id: 'concur-c' } }),
    ];

    // Launch 3 concurrent writes
    const outcomes = await Promise.allSettled(
      receipts.map(r =>
        new Promise<WriteReceiptResult>((resolve, reject) => {
          try {
            resolve(writeReceipt(r, { receiptDir: concurDir, tempDir: concurDir }));
          } catch (e) {
            reject(e);
          }
        })
      )
    );

    // List all .json receipts (not temp files, not lock)
    const allFiles = fs.readdirSync(concurDir);
    const jsonFiles = allFiles.filter(f => f.endsWith('.json') && !f.startsWith('.'));
    const tmpFiles = allFiles.filter(f => f.includes('.tmp.'));

    // No temp files
    expect(tmpFiles).toHaveLength(0);

    // Each JSON file must be valid JSON and pass digest verification
    for (const file of jsonFiles) {
      const filePath = path.join(concurDir, file);
      expect(verifyReceiptDigest(filePath)).toBe(true);
    }

    // No partial writes — each JSON file must be parseable and contain expected fields
    for (const file of jsonFiles) {
      const raw = fs.readFileSync(path.join(concurDir, file), 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.digest).toBeDefined();
      expect(typeof parsed.digest).toBe('string');
      expect(parsed.version).toBe(1);
      expect(parsed.type).toBe('TASK_COMPLETE');
    }
  });

  it('simple lock test — concurrent writes serialized by per-directory lock', async () => {
    // The lock mechanism ensures at most one write succeeds at a time.
    // Launch 10 concurrent writes with unique content and verify that
    // the lock directory is always cleaned up afterwards.
    const count = 10;
    const outcomes = await Promise.allSettled(
      Array.from({ length: count }, (_, i) =>
        new Promise<WriteReceiptResult>((resolve, reject) => {
          try {
            resolve(
              writeReceipt(
                validReceipt({ timestamp: `2025-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, payload: { idx: i } }),
                { receiptDir: concurDir, tempDir: concurDir },
              ),
            );
          } catch (e) {
            reject(e);
          }
        })
      )
    );

    const succeeded = outcomes.filter(o => o.status === 'fulfilled');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    // Lock is always released
    const lockDir = path.join(concurDir, '.receipt-lock');
    expect(fs.existsSync(lockDir)).toBe(false);

    // All written receipts pass digest check
    for (const file of fs.readdirSync(concurDir).filter(f => f.endsWith('.json') && !f.startsWith('.'))) {
      expect(verifyReceiptDigest(path.join(concurDir, file))).toBe(true);
    }
  });

  it('concurrent same-chain writes produce a linear chain', async () => {
    // Use a clean directory for this test
    const sameChainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'same-chain-concur-'));
    try {
      // First, establish a genesis receipt
      const genesis = validReceipt({ type: 'SLICE_PLAN' });
      const genesisResult = writeReceipt(genesis, { receiptDir: sameChainDir, tempDir: sameChainDir });

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
      const outcomes = await Promise.allSettled(
        writers.map(r =>
          new Promise<WriteReceiptResult>((resolve, reject) => {
            try {
              resolve(writeReceipt(r, { receiptDir: sameChainDir, tempDir: sameChainDir }));
            } catch (e) {
              reject(e);
            }
          })
        )
      );

      const succeeded = outcomes.filter(o => o.status === 'fulfilled');
      const failed = outcomes.filter(o => o.status === 'rejected');

      // Exactly 1 must succeed (the one that got the lock first)
      expect(succeeded.length).toBe(1);

      // The rest should fail with fork detection
      expect(failed.length).toBe(4);

      // Chain verification should pass (all written receipts form a valid chain)
      const chainResult = verifyReceiptChain(sameChainDir);
      expect(chainResult.valid).toBe(true);

      // No temp files remain
      const files = fs.readdirSync(sameChainDir);
      const tmpFiles = files.filter(f => f.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);

      // Lock is released
      const lockDir = path.join(sameChainDir, '.receipt-lock');
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      fs.rmSync(sameChainDir, { recursive: true, force: true });
    }
  });

  it('linear chain of 3 receipts with concurrent writers at each step', async () => {
    const linearDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-chain-concur-'));
    try {
      // Step 1: Genesis
      const gResult = writeReceipt(
        validReceipt({ type: 'SLICE_PLAN' }),
        { receiptDir: linearDir, tempDir: linearDir },
      );

      // Step 2: 3 concurrent writers all trying to append to genesis
      const step2writers = Array.from({ length: 3 }, (_, i) =>
        validReceipt({
          type: 'TASK_COMPLETE',
          slice_id: 'S01-D',
          timestamp: `2025-01-0${i + 2}T00:00:00.000Z`,
          previous_digest: gResult.digest,
          payload: { step: 2, writer: i },
        })
      );

      const step2outcomes = await Promise.allSettled(
        step2writers.map(r =>
          new Promise<WriteReceiptResult>((resolve, reject) => {
            try {
              resolve(writeReceipt(r, { receiptDir: linearDir, tempDir: linearDir }));
            } catch (e) {
              reject(e);
            }
          })
        )
      );

      const step2succeeded = step2outcomes.filter(o => o.status === 'fulfilled');
      expect(step2succeeded.length).toBe(1);
      const step2Result = (step2succeeded[0] as PromiseFulfilledResult<WriteReceiptResult>).value;

      // Step 3: 3 concurrent writers all trying to append to step 2
      const step3writers = Array.from({ length: 3 }, (_, i) =>
        validReceipt({
          type: 'TASK_COMPLETE',
          slice_id: 'S01-D',
          timestamp: `2025-01-0${i + 5}T00:00:00.000Z`,
          previous_digest: step2Result.digest,
          payload: { step: 3, writer: i },
        })
      );

      const step3outcomes = await Promise.allSettled(
        step3writers.map(r =>
          new Promise<WriteReceiptResult>((resolve, reject) => {
            try {
              resolve(writeReceipt(r, { receiptDir: linearDir, tempDir: linearDir }));
            } catch (e) {
              reject(e);
            }
          })
        )
      );

      const step3succeeded = step3outcomes.filter(o => o.status === 'fulfilled');
      expect(step3succeeded.length).toBe(1);

      // Final chain: genesis → step2 → step3 (3 receipts)
      const finalResult = verifyReceiptChain(linearDir);
      expect(finalResult.valid).toBe(true);
      expect(finalResult.receipts).toHaveLength(3);

      // No temp files
      const files = fs.readdirSync(linearDir);
      expect(files.filter(f => f.includes('.tmp.'))).toHaveLength(0);
    } finally {
      fs.rmSync(linearDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Additional duplicate rejection edge cases
// ============================================================

describe('writeReceipt — Duplicate rejection edge cases', () => {
  let edgeDir: string;

  beforeEach(() => {
    edgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-edge-'));
  });

  afterEach(() => {
    fs.rmSync(edgeDir, { recursive: true, force: true });
  });

  it('rejects exact same data written twice', () => {
    const receipt = validReceipt({
      slice_id: 'S01-D',
      payload: { hello: 'world' },
    });

    const first = writeReceipt(receipt, { receiptDir: edgeDir, tempDir: edgeDir });
    expect(first).toBeDefined();

    // Second write with identical data must throw ReceiptChainError
    expect(() => writeReceipt(receipt, { receiptDir: edgeDir, tempDir: edgeDir }))
      .toThrow(ReceiptChainError);
  });

  it('rejects write when the receipt file already exists from a previous session', () => {
    // Manually create a receipt file (simulating a previous session's receipt)
    // Must use valid receipt data so schema validation passes
    const receiptData = validReceipt({ type: 'SLICE_PLAN' });
    const digest = computeReceiptDigest(receiptData);
    const filePath = path.join(edgeDir, `${digest}.json`);
    const data = { ...receiptData, digest };
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');

    // Try to write this receipt — should be rejected with ReceiptChainError
    expect(() =>
      writeReceipt(receiptData, { receiptDir: edgeDir, tempDir: edgeDir }),
    ).toThrow(ReceiptChainError);
  });
});

// ============================================================
// Additional predecessor chain validation edge cases
// ============================================================

describe('writeReceipt — Predecessor chain validation edge cases', () => {
  let chainDir: string;

  beforeEach(() => {
    chainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-chain-edge-'));
  });

  afterEach(() => {
    fs.rmSync(chainDir, { recursive: true, force: true });
  });

  it('treats empty previous_digest as genesis (no predecessor validation)', () => {
    const receipt = validReceipt({
      slice_id: 'S01-D',
      timestamp: '2025-01-02T00:00:00.000Z',
      previous_digest: '',
    });

    // Empty previous_digest should be treated as no predecessor (like genesis)
    const result = writeReceipt(receipt, { receiptDir: chainDir, tempDir: chainDir });
    expect(result).toBeDefined();
    expect(verifyReceiptDigest(result.path)).toBe(true);

    // The written receipt should have no previous_digest (empty string normalized
    // to undefined before validation — genesis semantics)
    const content = JSON.parse(fs.readFileSync(result.path, 'utf-8')) as Record<string, unknown>;
    expect(content.previous_digest).toBeUndefined();
  });

  it('rejects chain where predecessor has been tampered', () => {
    // Write genesis
    const genesis = validReceipt({ type: 'SLICE_PLAN' });
    const gResult = writeReceipt(genesis, { receiptDir: chainDir, tempDir: chainDir });

    // Tamper with genesis (keep old digest — so digest no longer matches)
    const gContent = JSON.parse(fs.readFileSync(gResult.path, 'utf-8')) as Record<string, unknown>;
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
    expect(() =>
      writeReceipt(second, { receiptDir: chainDir, tempDir: chainDir }),
    ).toThrow(ReceiptChainError);
    expect(() =>
      writeReceipt(second, { receiptDir: chainDir, tempDir: chainDir }),
    ).toThrow(/invalid digest|predecessor|chain integrity check/i);
  });
});

// ============================================================
// Caller-supplied digest rejection tests
// ============================================================

describe('writeReceipt — Caller-supplied digest rejection', () => {
  let digestDir: string;

  beforeEach(() => {
    digestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-digest-reject-'));
  });

  afterEach(() => {
    fs.rmSync(digestDir, { recursive: true, force: true });
  });

  it('throws when caller-supplied digest does not match computed digest', () => {
    const receipt = validReceipt({
      digest: '0000000000000000000000000000000000000000000000000000000000000000',
    });

    expect(() =>
      writeReceipt(receipt, { receiptDir: digestDir, tempDir: digestDir }),
    ).toThrow(/caller-supplied digest.*does not match/i);
  });

  it('accepts caller-supplied digest when it matches computed digest', () => {
    const receiptContent = validReceipt();
    const computed = computeReceiptDigest(receiptContent);
    const receipt = { ...receiptContent, digest: computed };

    const result = writeReceipt(receipt, { receiptDir: digestDir, tempDir: digestDir });
    expect(result).toBeDefined();
    expect(result.digest).toBe(computed);
    expect(verifyReceiptDigest(result.path)).toBe(true);
  });
});

// ============================================================
// Fork detection tests
// ============================================================

describe('writeReceipt — Fork detection', () => {
  let forkDir: string;

  beforeEach(() => {
    forkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-fork-'));
  });

  afterEach(() => {
    fs.rmSync(forkDir, { recursive: true, force: true });
  });

  it('allows writing a genesis receipt when no receipts exist', () => {
    const receipt = validReceipt({ type: 'SLICE_PLAN' });
    const result = writeReceipt(receipt, { receiptDir: forkDir, tempDir: forkDir });
    expect(result).toBeDefined();
    expect(verifyReceiptDigest(result.path)).toBe(true);
  });

  it('allows appending to the latest receipt in the chain', () => {
    const genesis = validReceipt({ type: 'SLICE_PLAN' });
    const gResult = writeReceipt(genesis, { receiptDir: forkDir, tempDir: forkDir });

    // Append to genesis (which is the latest)
    const second = validReceipt({
      type: 'TASK_COMPLETE',
      slice_id: 'S01-D',
      timestamp: '2025-01-02T00:00:00.000Z',
      previous_digest: gResult.digest,
    });
    const sResult = writeReceipt(second, { receiptDir: forkDir, tempDir: forkDir });
    expect(sResult).toBeDefined();
    expect(verifyReceiptDigest(sResult.path)).toBe(true);
  });

  it('rejects a receipt whose previous_digest does not match the latest receipt', () => {
    // Write genesis
    const genesis = validReceipt({ type: 'SLICE_PLAN' });
    const gResult = writeReceipt(genesis, { receiptDir: forkDir, tempDir: forkDir });

    // Write second receipt (now latest)
    const second = validReceipt({
      type: 'TASK_COMPLETE',
      slice_id: 'S01-D',
      timestamp: '2025-01-02T00:00:00.000Z',
      previous_digest: gResult.digest,
    });
    writeReceipt(second, { receiptDir: forkDir, tempDir: forkDir });

    // Try to write another receipt that points to genesis (not the latest)
    const forkAttempt = validReceipt({
      type: 'TASK_COMPLETE',
      slice_id: 'S01-D',
      timestamp: '2025-01-03T00:00:00.000Z',
      previous_digest: gResult.digest, // points to genesis, NOT the latest (second)
      payload: { fork: true },
    });

    expect(() =>
      writeReceipt(forkAttempt, { receiptDir: forkDir, tempDir: forkDir }),
    ).toThrow(ReceiptChainError);
    expect(() =>
      writeReceipt(forkAttempt, { receiptDir: forkDir, tempDir: forkDir }),
    ).toThrow(/fork detected/i);
  });

  it('allows writing a genesis receipt when other receipts exist (separate chain)', () => {
    // Write a normal chain
    const genesis = validReceipt({ type: 'SLICE_PLAN' });
    const gResult = writeReceipt(genesis, { receiptDir: forkDir, tempDir: forkDir });

    const second = validReceipt({
      type: 'TASK_COMPLETE',
      timestamp: '2025-01-02T00:00:00.000Z',
      previous_digest: gResult.digest,
    });
    writeReceipt(second, { receiptDir: forkDir, tempDir: forkDir });

    // Writing a genesis (no previous_digest) should be allowed even though
    // other receipts exist — fork detection only applies when previous_digest
    // is specified.
    const newChain = validReceipt({
      type: 'SLICE_PLAN',
      timestamp: '2025-01-01T00:00:00.000Z',
      payload: { separate: true },
    });
    const newResult = writeReceipt(newChain, { receiptDir: forkDir, tempDir: forkDir });
    expect(newResult).toBeDefined();
    expect(verifyReceiptDigest(newResult.path)).toBe(true);
  });
});

// ============================================================
// Schema validation integration tests
// ============================================================

describe('writeReceipt — Schema validation', () => {
  let schemaDir: string;

  beforeEach(() => {
    schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-schema-'));
  });

  afterEach(() => {
    fs.rmSync(schemaDir, { recursive: true, force: true });
  });

  it('accepts valid receipt data and writes it successfully', () => {
    const receipt = validReceipt({ type: 'SLICE_PLAN' });
    const result = writeReceipt(receipt, { receiptDir: schemaDir, tempDir: schemaDir });
    expect(result).toBeDefined();
    expect(verifyReceiptDigest(result.path)).toBe(true);
  });

  it('throws a descriptive error for receipt data that fails schema validation', () => {
    // Missing required fields like 'type'
    const badReceipt = { version: 1, stage_id: 'S01', timestamp: '2025-01-01T00:00:00.000Z', payload: {} };

    expect(() =>
      writeReceipt(badReceipt, { receiptDir: schemaDir, tempDir: schemaDir }),
    ).toThrow(/receipt validation failed/i);
  });

  it('throws schema error for invalid receipt type', () => {
    const badReceipt = validReceipt({ type: 'INVALID_TYPE' });

    expect(() =>
      writeReceipt(badReceipt, { receiptDir: schemaDir, tempDir: schemaDir }),
    ).toThrow(/receipt validation failed/i);
  });
});

// ============================================================
// Independent digest oracle tests
// ============================================================

describe('ReceiptWriter — Independent digest oracle', () => {
  let oracleDir: string;

  beforeEach(() => {
    oracleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-oracle-'));
  });

  afterEach(() => {
    fs.rmSync(oracleDir, { recursive: true, force: true });
  });

  it('stored digest matches independently computed SHA-256 from disk', () => {
    const receipt = validReceipt({
      slice_id: 'S01-D',
      payload: { oracle: true },
    });
    const result = writeReceipt(receipt, { receiptDir: oracleDir, tempDir: oracleDir });

    // Read the file from disk
    const raw = fs.readFileSync(result.path, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const storedDigest = parsed.digest as string;

    // Independently compute expected digest:
    // 1. Strip 'digest' from the parsed data
    const { digest: _ignore, ...contentFromDisk } = parsed;
    // 2. Serialize with independent canonical JSON (not computeReceiptDigest)
    const expectedDigest = independentDigest(contentFromDisk);

    expect(storedDigest).toBe(expectedDigest);
  });

  it('digest in returned result matches independent computation', () => {
    const receipt = validReceipt({
      slice_id: 'S01-D',
      payload: { check: 'return' },
    });
    const result = writeReceipt(receipt, { receiptDir: oracleDir, tempDir: oracleDir });

    const expected = independentDigest(receipt);
    expect(result.digest).toBe(expected);
  });

  it('verifyReceiptDigest passes against independently verified content', () => {
    const receipt = validReceipt({
      slice_id: 'S01-D',
      payload: { verify: 'oracle' },
    });
    const result = writeReceipt(receipt, { receiptDir: oracleDir, tempDir: oracleDir });

    // Read from disk and independently verify
    const raw = fs.readFileSync(result.path, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const { digest: storedDigest, ...contentFromDisk } = parsed;
    const independent = independentDigest(contentFromDisk);

    expect(storedDigest).toBe(independent);
    // Also confirm the public verifier agrees
    expect(verifyReceiptDigest(result.path)).toBe(true);
  });
});

// ============================================================
// Helper to write a receipt in a specific directory and return its digest
// ============================================================

function writeReceiptIn(dir: string, data: Record<string, unknown>, name: string): string {
  const digest = computeReceiptDigest(data);
  const full = { ...data, digest };
  fs.writeFileSync(path.join(dir, name), JSON.stringify(full, null, 2), 'utf-8');
  return digest;
}
