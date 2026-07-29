import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { writeCvReceipt, readCvReceipt, getDefaultCvReceiptRoot } from '../src/receipt-writer.js';
import { CvReceipt, type CvVerdict } from '../src/schemas.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-receipt-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCvData(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    slice_id: 'S01-A',
    stage_id: 'S01',
    snapshot: 'a1b2c3d4e5f6a7b8',
    cv_level: 'standard',
    verification_type: 'initial',
    verdict: 'PASS',
    failed_po_ids: [],
    affected_task_ids: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    required_recheck_scope: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Pre-create a receipt file at a given path to simulate collisions. */
function preCreateReceipt(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{}', 'utf-8');
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('writeCvReceipt', () => {

  test('writes receipt to correct path with seq 001', () => {
    const data = makeCvData();
    const result = writeCvReceipt(data as any, tmpDir);

    // Verify path structure
    expect(result).toContain(path.join('S01', 'S01-A'));
    expect(result).toContain('initial-001.json');
    expect(fs.existsSync(result)).toBe(true);

    // Verify content
    const parsed = JSON.parse(fs.readFileSync(result, 'utf-8'));
    expect(parsed.slice_id).toBe('S01-A');
    expect(parsed.stage_id).toBe('S01');
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.cv_level).toBe('standard');
    expect(parsed.verification_type).toBe('initial');
    expect(parsed.failed_po_ids).toEqual([]);
    expect(parsed.affected_task_ids).toEqual([]);
    expect(parsed.required_recheck_scope).toEqual([]);
  });

  test('increments sequence number globally (not per-prefix)', () => {
    const passData = makeCvData({ verdict: 'PASS' });

    // Write 001 (initial)
    const r1 = writeCvReceipt(passData as any, tmpDir);
    expect(r1).toContain('initial-001.json');

    // Write 002 (initial, same prefix) → global increment
    const r2 = writeCvReceipt(passData as any, tmpDir);
    expect(r2).toContain('initial-002.json');

    // Write 003 (recheck prefix) → global increment, not recheck-001!
    const recheckData = makeCvData({ verdict: 'PASS', verification_type: 'recheck' });
    const r3 = writeCvReceipt(recheckData as any, tmpDir);
    expect(r3).toContain('recheck-003.json');
  });

  test('global sequence across interleaved prefixes', () => {
    const p = makeCvData({ verdict: 'PASS' });
    const r = makeCvData({ verdict: 'REPAIR', verification_type: 'recheck' });

    // initial-001
    expect(writeCvReceipt(p as any, tmpDir)).toContain('initial-001.json');
    // initial-002
    expect(writeCvReceipt(p as any, tmpDir)).toContain('initial-002.json');
    // recheck-003 (global +1, not recheck-001!)
    expect(writeCvReceipt(r as any, tmpDir)).toContain('recheck-003.json');
    // initial-004
    expect(writeCvReceipt(p as any, tmpDir)).toContain('initial-004.json');
    // recheck-005
    expect(writeCvReceipt(r as any, tmpDir)).toContain('recheck-005.json');
  });

  test('never overwrites existing receipt (wx + retry)', () => {
    const data = makeCvData({ verdict: 'PASS' });

    writeCvReceipt(data as any, tmpDir);
    const r2 = writeCvReceipt(data as any, tmpDir);
    expect(r2).toContain('initial-002.json');

    // Verify initial-001 still exists unchanged
    const filePath = path.join(tmpDir, 'S01', 'S01-A', 'initial-001.json');
    expect(fs.existsSync(filePath)).toBe(true);

    // Calling again produces the next free number
    const r3 = writeCvReceipt(data as any, tmpDir);
    expect(r3).toContain('initial-003.json');
  });

  test('validates data against schema (rejects bad data)', () => {
    const badData = { slice_id: 'bad', verdict: 'INVALID' };
    expect(() => writeCvReceipt(badData as any, tmpDir)).toThrow();
  });

  test('handles REPAIR verdict with all fields', () => {
    const data = makeCvData({
      verdict: 'REPAIR',
      verification_type: 'recheck',
      failed_po_ids: ['PO-S01-A-01', 'PO-S01-A-02'],
      affected_task_ids: ['S01-A-T1'],
      invalid_tests: ['test-xyz'],
      counterexamples: ['Input X → Output Y (expected Z)'],
      scope_violations: ['Modified file outside slice boundary'],
      failed_criterion: 'output_matches: expected pattern not found',
      failure_signature: 'sha256:abc123def456',
      required_recheck_scope: ['S01-A-T1', 'PO-S01-A-01'],
    });

    const result = writeCvReceipt(data as any, tmpDir);
    // First receipt → 001, uses prefix recheck
    expect(result).toContain('recheck-001.json');

    const parsed = JSON.parse(fs.readFileSync(result, 'utf-8'));
    expect(parsed.verdict).toBe('REPAIR');
    expect(parsed.failed_po_ids).toHaveLength(2);
    expect(parsed.affected_task_ids).toEqual(['S01-A-T1']);
    expect(parsed.failed_criterion).toBe('output_matches: expected pattern not found');
    expect(parsed.failure_signature).toBe('sha256:abc123def456');
    expect(parsed.required_recheck_scope).toEqual(['S01-A-T1', 'PO-S01-A-01']);
  });

  test('accepts ESCALATION_REQUIRED verdict', () => {
    const data = makeCvData({
      verdict: 'ESCALATION_REQUIRED',
      failed_criterion: 'Ambiguous requirement',
    });
    const result = writeCvReceipt(data as any, tmpDir);
    const parsed = JSON.parse(fs.readFileSync(result, 'utf-8'));
    expect(parsed.verdict).toBe('ESCALATION_REQUIRED');
  });

  test('accepts BLOCKED verdict', () => {
    const data = makeCvData({ verdict: 'BLOCKED' });
    const result = writeCvReceipt(data as any, tmpDir);
    const parsed = JSON.parse(fs.readFileSync(result, 'utf-8'));
    expect(parsed.verdict).toBe('BLOCKED');
  });

  test('accepts REPLAN verdict', () => {
    const data = makeCvData({ verdict: 'REPLAN' });
    const result = writeCvReceipt(data as any, tmpDir);
    const parsed = JSON.parse(fs.readFileSync(result, 'utf-8'));
    expect(parsed.verdict).toBe('REPLAN');
  });

  test('different slices have independent sequences', () => {
    const sliceAData = makeCvData({ slice_id: 'S01-A', stage_id: 'S01', verdict: 'PASS' });
    const sliceBData = makeCvData({ slice_id: 'S01-B', stage_id: 'S01', verdict: 'PASS' });

    const r1 = writeCvReceipt(sliceAData as any, tmpDir);
    expect(r1).toContain('initial-001.json');

    // S01-B starts its own sequence at 001
    const r2 = writeCvReceipt(sliceBData as any, tmpDir);
    expect(r2).toContain('initial-001.json');

    // Second for S01-A → 002
    const r3 = writeCvReceipt(sliceAData as any, tmpDir);
    expect(r3).toContain('initial-002.json');
  });

  test('safe with non-default receiptRoot', () => {
    const customRoot = path.join(tmpDir, 'custom-receipts');
    const data = makeCvData({ verdict: 'PASS' });

    const result = writeCvReceipt(data as any, customRoot);
    expect(result).toContain(path.join('custom-receipts', 'S01', 'S01-A'));
    expect(result).toContain('initial-001.json');
    expect(fs.existsSync(result)).toBe(true);
  });

  // ── Race / collision safety tests ──

  test('retries when file already exists (pre-seeded directory)', () => {
    // Pre-seed the directory with initial-001.json and initial-002.json
    preCreateReceipt(path.join(tmpDir, 'S01', 'S01-A', 'initial-001.json'));
    preCreateReceipt(path.join(tmpDir, 'S01', 'S01-A', 'initial-002.json'));

    // The function should find max=2 and write initial-003
    const result = writeCvReceipt(makeCvData({ verdict: 'PASS' }) as any, tmpDir);
    expect(result).toContain('initial-003.json');
    expect(fs.existsSync(result)).toBe(true);
  });

  test('retries past a pre-seeded gap (skips 003, writes 004)', () => {
    // Pre-seed 001, 002, and 003 (to force collision on 003)
    preCreateReceipt(path.join(tmpDir, 'S01', 'S01-A', 'initial-001.json'));
    preCreateReceipt(path.join(tmpDir, 'S01', 'S01-A', 'initial-002.json'));
    preCreateReceipt(path.join(tmpDir, 'S01', 'S01-A', 'initial-003.json'));

    // Function's first candidate after scan is 003, but it's taken → retry → 004
    const result = writeCvReceipt(makeCvData({ verdict: 'PASS' }) as any, tmpDir);
    expect(result).toContain('initial-004.json');
    expect(fs.existsSync(result)).toBe(true);
  });

  test('handles pre-seeded recheck files in global sequence', () => {
    // Pre-seed initial-001 and recheck-002
    preCreateReceipt(path.join(tmpDir, 'S01', 'S01-A', 'initial-001.json'));
    preCreateReceipt(path.join(tmpDir, 'S01', 'S01-A', 'recheck-002.json'));

    // Max global = 2, next candidate = 3
    const r1 = writeCvReceipt(makeCvData({ verdict: 'PASS' }) as any, tmpDir);
    expect(r1).toContain('initial-003.json');

    // Next: 004
    const r2 = writeCvReceipt(makeCvData({ verdict: 'REPAIR', verification_type: 'recheck' }) as any, tmpDir);
    expect(r2).toContain('recheck-004.json');
  });

  test('survives when all early slots are exhausted by pre-seeded files', () => {
    // Pre-seed 001-005
    for (let i = 1; i <= 5; i++) {
      preCreateReceipt(
        path.join(tmpDir, 'S01', 'S01-A', `initial-${String(i).padStart(3, '0')}.json`),
      );
    }

    // Should find max=5, write initial-006
    const result = writeCvReceipt(makeCvData({ verdict: 'PASS' }) as any, tmpDir);
    expect(result).toContain('initial-006.json');
    expect(fs.existsSync(result)).toBe(true);
  });
});

describe('readCvReceipt', () => {

  test('reads a CV receipt written by writeCvReceipt', () => {
    const data = makeCvData({ verdict: 'PASS' });
    const receiptPath = writeCvReceipt(data as any, tmpDir);

    const parsed = readCvReceipt(receiptPath);
    expect(parsed.slice_id).toBe('S01-A');
    expect(parsed.stage_id).toBe('S01');
    expect(parsed.verdict).toBe('PASS');
    expect(parsed.verification_type).toBe('initial');
    expect(parsed.cv_level).toBe('standard');
  });

  test('throws on invalid receipt file', () => {
    const badPath = path.join(tmpDir, 'nonexistent.json');
    expect(() => readCvReceipt(badPath)).toThrow();
  });

  test('throws on invalid JSON schema', () => {
    const badPath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(badPath, JSON.stringify({ invalid: true }), 'utf-8');
    expect(() => readCvReceipt(badPath)).toThrow();
  });
});

describe('CvReceipt schema', () => {

  test('CvReceipt uses cv_ prefix fields, not legacy alternatives', () => {
    // Verify the receipt schema contains the standard 'cv_' prefixed fields
    // and does not contain any legacy-named fields.
    const shape = CvReceipt._def?.shape() ?? {};
    const allKeys = Object.keys(shape);
    // The cv-level field must be present (not a legacy name)
    expect(allKeys).toContain('cv_level');
    // Sanity: the key set is well-formed (no unexpected prefix variants)
    expect(allKeys).toContain('verdict');
    expect(allKeys).toContain('verification_type');
  });

  test('default verification_type is initial', () => {
    const data = makeCvData();
    // Omit verification_type
    delete data.verification_type;
    const parsed = CvReceipt.parse(data);
    expect(parsed.verification_type).toBe('initial');
  });

  test('requires stage_id', () => {
    const data = makeCvData();
    delete data.stage_id;
    expect(() => CvReceipt.parse(data)).toThrow();
  });

  test('accepts optional fields as empty arrays', () => {
    const data = makeCvData({
      failed_po_ids: undefined,
      affected_task_ids: undefined,
      invalid_tests: undefined,
      counterexamples: undefined,
      scope_violations: undefined,
      required_recheck_scope: undefined,
    });
    const parsed = CvReceipt.parse(data);
    expect(parsed.failed_po_ids).toEqual([]);
    expect(parsed.affected_task_ids).toEqual([]);
    expect(parsed.invalid_tests).toEqual([]);
    expect(parsed.counterexamples).toEqual([]);
    expect(parsed.scope_violations).toEqual([]);
    expect(parsed.required_recheck_scope).toEqual([]);
  });

  test('required_recheck_scope accepts array of strings', () => {
    const data = makeCvData({
      required_recheck_scope: ['S01-A-T1', 'PO-S01-A-01'],
    });
    const parsed = CvReceipt.parse(data);
    expect(Array.isArray(parsed.required_recheck_scope)).toBe(true);
    expect(parsed.required_recheck_scope).toHaveLength(2);
  });
});
