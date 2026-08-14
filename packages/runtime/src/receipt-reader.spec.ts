/**
 * readReceiptCategory — PO-S02-C-05 (misplacement), PO-S02-C-03 (chain),
 * PO-S02-C-01 (reader determinism)
 *
 * Verifies the runtime receipt reader seam against REAL filesystem fixtures
 * (temp directory + canonical `.proofloop` layout) — no mocks, no cached
 * state files. Receipt files are produced by the kernel ReceiptWriter
 * (`writeReceipt`), the canonical writer, so every fixture receipt carries a
 * correct content digest and chain linkage.
 *
 * Behaviors under test:
 *   - type/category mismatch (e.g. CV_PASS in the integration dir) →
 *     RUNTIME.SCHEMA_MISMATCH misplacement condition; the misplaced receipt is
 *     never used as a fact.
 *   - tampered chained receipt → chain invalid with RUNTIME.RECEIPT_CHAIN_BROKEN
 *     condition; the tampered file is excluded from facts (fact blocking).
 *   - `.tmp/`, non-json files and directories are never read as receipts.
 *   - deterministic (timestamp, digest) ordering; latest = newest; identical
 *     input produces deep-equal output on repeated reads.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeReceipt, computeReceiptDigest } from '@proofloop/kernel';
import {
  readReceiptCategory,
  readAllReceiptCategories,
  RECEIPT_CONTENT_CATEGORIES,
  planReceiptDir,
  tasksReceiptDir,
  cvReceiptDir,
  committerReceiptDir,
  integrationReceiptDir,
  stageGateReceiptDir,
  reviewReceiptDir,
  projectReceiptDir,
  tmpReceiptDir,
  type ReceiptCategoryReadResult,
} from '@proofloop/runtime';
// P-11: `stageCloseReceiptDir` is not part of the package index (the vNext
// stage-close seam is not a legacy layout export) — import it from the source
// module directly.
import { stageCloseReceiptDir } from './receipt-layout';

// ============================================================
// Fixture helpers (real temp dirs, real files)
// ============================================================

interface Fixture {
  root: string;
  stageId: string;
  sliceId: string;
  cleanup(): void;
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

function makeFixture(stageId = 'S02', sliceId = 'S02-C'): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-reader-'));
  const fx: Fixture = {
    root,
    stageId,
    sliceId,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

/**
 * Write a schema-valid receipt into a category directory via the kernel
 * ReceiptWriter (canonical writer — computes the content digest and enforces
 * chain preconditions). Returns the write result { path, digest }.
 */
function writeReceiptFile(
  dir: string,
  overrides: Record<string, unknown> = {},
): { path: string; digest: string } {
  fs.mkdirSync(dir, { recursive: true });
  return writeReceipt(
    {
      version: 1,
      type: 'TASK_COMPLETE',
      stage_id: 'S02',
      timestamp: '2025-01-01T00:00:00.000Z',
      payload: {},
      ...overrides,
    },
    { receiptDir: dir, tempDir: dir },
  );
}

/**
 * P-11 fixture seam: write a schema-closed v2 STAGE_CLOSE_PASS envelope into
 * the stage-close category directory. The envelope is vNext-owned — its type
 * is deliberately NOT a kernel `ReceiptType` (the kernel 16-type union stays
 * closed), so the kernel ReceiptWriter must not be used; the self-digest is
 * computed the same way the vNext admission writer does
 * (`computeReceiptDigest` over the content without `digest`).
 */
function writeStageCloseReceiptFile(dir: string, stageId: string): string {
  const content = {
    version: 1,
    type: 'STAGE_CLOSE_PASS',
    stage_id: stageId,
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: {
      schema_version: 2,
      type: 'STAGE_CLOSE_RESULT',
      action: 'STAGE_CLOSE',
      stage_id: stageId,
      close_type: 'full',
      reason: 'stage closed (fixture)',
      manifest_digest: 'a'.repeat(64),
      plan_digest: 'b'.repeat(64),
      snapshot_digest: 'c'.repeat(40),
      stage_plan_receipt_digest: 'd'.repeat(64),
      spv_receipt_digest: 'e'.repeat(64),
      receipt_chain_valid: true,
    },
  };
  const digest = computeReceiptDigest(content);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${digest}.json`),
    JSON.stringify({ ...content, digest }, null, 2),
    'utf8',
  );
  return digest;
}

function readCategory(
  fx: Fixture,
  category: (typeof RECEIPT_CONTENT_CATEGORIES)[number],
): ReceiptCategoryReadResult {
  return readReceiptCategory({
    projectRoot: fx.root,
    category,
    stageId: fx.stageId,
    sliceId: fx.sliceId,
  });
}

// ============================================================
// Misplacement — type/category mismatch (PO-S02-C-05)
// ============================================================

describe('readReceiptCategory — misplaced receipt (PO-S02-C-05)', () => {
  it('detects CV_PASS inside the integration directory as RUNTIME.SCHEMA_MISMATCH and never uses it as a fact', () => {
    const fx = makeFixture();
    const cvDir = cvReceiptDir(fx.root, fx.stageId, fx.sliceId);
    const integrationDir = integrationReceiptDir(fx.root, fx.stageId, fx.sliceId);

    // A valid CV_PASS in its own directory.
    writeReceiptFile(cvDir, { type: 'CV_PASS', slice_id: fx.sliceId, timestamp: '2025-01-01T00:00:00.000Z' });
    // A schema-valid CV_PASS misplaced into the integration directory.
    writeReceiptFile(integrationDir, { type: 'CV_PASS', slice_id: fx.sliceId, timestamp: '2025-01-01T00:00:00.000Z' });

    const integration = readCategory(fx, 'integration');

    expect(integration.misplaced).toHaveLength(1);
    expect(integration.misplaced[0].receiptType).toBe('CV_PASS');
    expect(integration.misplaced[0].expectedCategory).toBe('cv');
    expect(integration.misplaced[0].foundInCategory).toBe('integration');
    expect(integration.misplaced[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    // The misplaced receipt must NOT be read as an integration fact.
    expect(integration.receipts).toHaveLength(0);
    expect(integration.latest).toBeNull();

    // The cv directory still reads its own receipt correctly.
    const cv = readCategory(fx, 'cv');
    expect(cv.misplaced).toHaveLength(0);
    expect(cv.invalidFiles).toHaveLength(0);
    expect(cv.receipts).toHaveLength(1);
    expect(cv.latest?.receipt.type).toBe('CV_PASS');
  });

  it('does not flag a correctly placed receipt as misplaced', () => {
    const fx = makeFixture();
    const stageGateDir = stageGateReceiptDir(fx.root, fx.stageId);
    writeReceiptFile(stageGateDir, { type: 'GATE_PASS', stage_id: fx.stageId });

    const gate = readCategory(fx, 'stage-gate');
    expect(gate.misplaced).toHaveLength(0);
    expect(gate.receipts).toHaveLength(1);
    expect(gate.latest?.receipt.type).toBe('GATE_PASS');
  });
});

// ============================================================
// Chain integrity (PO-S02-C-03)
// ============================================================

describe('readReceiptCategory — chain verification (PO-S02-C-03)', () => {
  it('reports a valid chain for intact chained receipts', () => {
    const fx = makeFixture();
    const dir = tasksReceiptDir(fx.root, fx.stageId, fx.sliceId);
    const r1 = writeReceiptFile(dir, { type: 'TASK_COMPLETE', slice_id: fx.sliceId, timestamp: '2025-01-01T00:00:00.000Z' });
    writeReceiptFile(dir, {
      type: 'TASK_COMPLETE',
      slice_id: fx.sliceId,
      timestamp: '2025-01-02T00:00:00.000Z',
      previous_digest: r1.digest,
    });

    const result = readCategory(fx, 'tasks');
    expect(result.chainValid).toBe(true);
    expect(result.chainCondition).toBeNull();
    expect(result.receipts).toHaveLength(2);
  });

  it('reports RUNTIME.RECEIPT_CHAIN_BROKEN when a chained receipt is tampered and blocks its facts', () => {
    const fx = makeFixture();
    const dir = tasksReceiptDir(fx.root, fx.stageId, fx.sliceId);
    const r1 = writeReceiptFile(dir, { type: 'TASK_COMPLETE', slice_id: fx.sliceId, timestamp: '2025-01-01T00:00:00.000Z' });
    const r2 = writeReceiptFile(dir, {
      type: 'TASK_COMPLETE',
      slice_id: fx.sliceId,
      timestamp: '2025-01-02T00:00:00.000Z',
      previous_digest: r1.digest,
    });

    // Tamper with r2's content WITHOUT recomputing its digest.
    const raw = JSON.parse(fs.readFileSync(r2.path, 'utf-8')) as { payload: Record<string, unknown> };
    raw.payload = { tampered: true };
    fs.writeFileSync(r2.path, JSON.stringify(raw));

    const result = readCategory(fx, 'tasks');

    expect(result.chainValid).toBe(false);
    expect(result.chainCondition).not.toBeNull();
    expect(result.chainCondition?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    // The tampered file is excluded from facts (fact blocking).
    expect(
      result.invalidFiles.some(
        (p) => p.filePath === r2.path && p.code === 'RUNTIME.RECEIPT_CHAIN_BROKEN',
      ),
    ).toBe(true);
    expect(result.receipts.every((r) => r.filePath !== r2.path)).toBe(true);
    expect(result.receipts.map((r) => r.filePath)).toEqual([r1.path]);
    expect(result.latest?.filePath).toBe(r1.path);
  });
});

// ============================================================
// Exclusion — .tmp / non-json / directories (PO-S02-C-05)
// ============================================================

describe('readReceiptCategory — never treats .tmp/non-json/directories as receipts (PO-S02-C-05)', () => {
  it('reads only regular .json receipt files in the category directory', () => {
    const fx = makeFixture();
    const cvDir = cvReceiptDir(fx.root, fx.stageId, fx.sliceId);
    const valid = writeReceiptFile(cvDir, { type: 'CV_PASS', slice_id: fx.sliceId, timestamp: '2025-01-01T00:00:00.000Z' });

    // Non-json files and kernel temp-style files inside the category dir.
    fs.writeFileSync(path.join(cvDir, 'readme.txt'), 'not a receipt');
    fs.writeFileSync(path.join(cvDir, 'notes.json.tmp'), '{"version":1}');
    // A valid receipt inside the .tmp scratch dir — must never be scanned.
    writeReceiptFile(tmpReceiptDir(fx.root), {
      type: 'CV_PASS',
      slice_id: fx.sliceId,
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    const result = readCategory(fx, 'cv');

    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0].filePath).toBe(valid.path);
    expect(result.latest?.receipt.type).toBe('CV_PASS');
    expect(result.invalidFiles).toHaveLength(0);
    expect(result.misplaced).toHaveLength(0);
    expect(result.chainValid).toBe(true);
  });

  it('returns an empty, valid result for a missing category directory', () => {
    const fx = makeFixture();
    const result = readCategory(fx, 'committer');
    expect(result.receipts).toHaveLength(0);
    expect(result.latest).toBeNull();
    expect(result.invalidFiles).toHaveLength(0);
    expect(result.misplaced).toHaveLength(0);
    expect(result.chainValid).toBe(true);
  });
});

// ============================================================
// Deterministic ordering (PO-S02-C-01 reader part)
// ============================================================

describe('readReceiptCategory — deterministic (timestamp, digest) ordering (PO-S02-C-01)', () => {
  it('orders receipts by timestamp then digest and picks the newest; repeated reads are deep-equal', () => {
    const fx = makeFixture();
    const dir = cvReceiptDir(fx.root, fx.stageId, fx.sliceId);

    const r1 = writeReceiptFile(dir, {
      type: 'CV_PASS',
      slice_id: fx.sliceId,
      timestamp: '2025-01-01T00:00:00.000Z',
      payload: { seq: 1 },
    });
    const r2a = writeReceiptFile(dir, {
      type: 'CV_PASS',
      slice_id: fx.sliceId,
      timestamp: '2025-01-02T00:00:00.000Z',
      payload: { seq: 2 },
    });
    // Same timestamp as r2a — the tie must be broken by digest (lexicographic).
    const r2b = writeReceiptFile(dir, {
      type: 'CV_PASS',
      slice_id: fx.sliceId,
      timestamp: '2025-01-02T00:00:00.000Z',
      payload: { seq: 3 },
    });
    const r3 = writeReceiptFile(dir, {
      type: 'CV_PASS',
      slice_id: fx.sliceId,
      timestamp: '2025-01-03T00:00:00.000Z',
      payload: { seq: 4 },
    });

    // Expected order: chronological by timestamp; same timestamp → digest
    // lexicographic (digests come from the kernel writer as the independent
    // content-addressing oracle).
    const sameTimestampSorted = [r2a, r2b].slice().sort((a, b) =>
      a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0,
    );
    const expectedDigests = [
      r1.digest,
      ...sameTimestampSorted.map((w) => w.digest),
      r3.digest,
    ];

    const result = readCategory(fx, 'cv');
    expect(result.receipts.map((r) => r.receipt.digest)).toEqual(expectedDigests);
    expect(result.latest?.receipt.digest).toBe(r3.digest);

    // Determinism (HP-003): same input, same output.
    const again = readCategory(fx, 'cv');
    expect(again).toEqual(result);
  });
});

// ============================================================
// Trust-root boundary (S2-F-003) — symlink escapes fail closed
// ============================================================

describe('readReceiptCategory — trust-root boundary (S2-F-003)', () => {
  /** Create a root whose canonical receipts root is replaced by a symlink to `external`. */
  function makeEscapeFixture(
    linkRel: string,
  ): { fx: Fixture; external: string } {
    const fx = makeFixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-outside-'));
    cleanups.push(() => {
      try {
        fs.rmSync(external, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });
    // A valid-looking external receipt that MUST never be read.
    const externalReceiptDir = path.join(external, 'cv', fx.stageId, fx.sliceId);
    fs.mkdirSync(externalReceiptDir, { recursive: true });
    writeReceiptFile(externalReceiptDir, {
      type: 'CV_PASS',
      stage_id: fx.stageId,
      slice_id: fx.sliceId,
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    // Replace the target dir (or an ancestor) with a symlink to the external dir.
    const target = path.join(fx.root, linkRel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    fs.symlinkSync(external, target, 'dir');
    return { fx, external };
  }

  it('fail-closed when the receipts root is a symlink to an external dir (chain broken, outside not read)', () => {
    const { fx } = makeEscapeFixture(path.join('.proofloop', 'receipts'));

    const result = readCategory(fx, 'cv');

    expect(result.chainValid).toBe(false);
    expect(result.chainCondition).not.toBeNull();
    expect(result.chainCondition?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(result.chainCondition?.reason).toMatch(/trust boundary/);
    // The external fake receipt must never become a fact.
    expect(result.receipts).toHaveLength(0);
    expect(result.latest).toBeNull();
    expect(result.invalidFiles).toHaveLength(0);
    expect(result.misplaced).toHaveLength(0);
  });

  it('fail-closed when a deeper category subdirectory is a symlink to an external dir', () => {
    const { fx } = makeEscapeFixture(path.join('.proofloop', 'receipts', 'cv'));

    const result = readCategory(fx, 'cv');

    expect(result.chainValid).toBe(false);
    expect(result.chainCondition?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(result.chainCondition?.reason).toMatch(/trust boundary/);
    expect(result.receipts).toHaveLength(0);
  });

  it('fail-closed at the stage-level when the stage-gate dir escapes (all stages guarded)', () => {
    const { fx } = makeEscapeFixture(path.join('.proofloop', 'receipts', 'stage-gate'));

    const result = readReceiptCategory({
      projectRoot: fx.root,
      category: 'stage-gate',
      stageId: fx.stageId,
    });

    expect(result.chainValid).toBe(false);
    expect(result.chainCondition?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(result.receipts).toHaveLength(0);
  });

  it('fail-closed when a single receipt file is a symlink to an external valid receipt (S2-F-003 round 2)', () => {
    const fx = makeFixture();
    // A valid-looking external receipt that MUST never be read as a fact.
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-file-out-'));
    cleanups.push(() => {
      try {
        fs.rmSync(external, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });
    const outside = writeReceiptFile(external, {
      type: 'CV_PASS',
      stage_id: fx.stageId,
      slice_id: fx.sliceId,
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    // Plant a `.json` symlink inside the (legal, in-root) category dir pointing
    // at the external valid receipt.
    const cvDir = cvReceiptDir(fx.root, fx.stageId, fx.sliceId);
    fs.mkdirSync(cvDir, { recursive: true });
    fs.symlinkSync(outside.path, path.join(cvDir, 'fake.json'));

    const result = readCategory(fx, 'cv');

    // The escaped file is reported invalid and NEVER read as a fact.
    expect(result.invalidFiles).toHaveLength(1);
    expect(result.invalidFiles[0].filePath.endsWith('fake.json')).toBe(true);
    expect(result.invalidFiles[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(result.invalidFiles[0].reason).toMatch(/trust boundary/);
    expect(result.receipts).toHaveLength(0);
    expect(result.latest).toBeNull();
  });

  it('a legal receipt next to an escaped symlink still reads normally (S2-F-003 round 2)', () => {
    const fx = makeFixture();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-file-out-'));
    cleanups.push(() => {
      try {
        fs.rmSync(external, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });
    const outside = writeReceiptFile(external, {
      type: 'CV_PASS',
      stage_id: fx.stageId,
      slice_id: fx.sliceId,
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    const cvDir = cvReceiptDir(fx.root, fx.stageId, fx.sliceId);
    const legal = writeReceiptFile(cvDir, {
      type: 'CV_PASS',
      slice_id: fx.sliceId,
      timestamp: '2025-01-02T00:00:00.000Z',
    });
    fs.symlinkSync(outside.path, path.join(cvDir, 'fake.json'));

    const result = readCategory(fx, 'cv');

    expect(result.receipts.map((r) => r.filePath)).toEqual([legal.path]);
    expect(result.latest?.receipt.type).toBe('CV_PASS');
    expect(
      result.invalidFiles.some(
        (f) => f.filePath.endsWith('fake.json') && /trust boundary/.test(f.reason),
      ),
    ).toBe(true);
  });

  it('fail-closed when a single receipt file is an IN-ROOT symlink (no-follow rejects any symlink final component, S2-F-003 round 3)', () => {
    const fx = makeFixture();
    const cvDir = cvReceiptDir(fx.root, fx.stageId, fx.sliceId);
    // A legal valid receipt.
    const legal = writeReceiptFile(cvDir, {
      type: 'CV_PASS',
      slice_id: fx.sliceId,
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    // An in-root symlink pointing at the legal receipt's file: the O_NOFOLLOW
    // open refuses it even though its target is inside the root (path
    // ownership of a symlink cannot be proven atomically).
    fs.symlinkSync(legal.path, path.join(cvDir, 'alias.json'));

    const result = readCategory(fx, 'cv');

    expect(
      result.invalidFiles.some(
        (f) =>
          f.filePath.endsWith('alias.json') && /trust boundary/.test(f.reason),
      ),
    ).toBe(true);
    // The legal real file is unaffected; the symlink never becomes a fact.
    expect(result.receipts.map((r) => r.filePath)).toEqual([legal.path]);
  });

  it('legal paths are unaffected: an in-root directory is read normally (no symlink)', () => {
    const fx = makeFixture();
    const dir = cvReceiptDir(fx.root, fx.stageId, fx.sliceId);
    const valid = writeReceiptFile(dir, {
      type: 'CV_PASS',
      slice_id: fx.sliceId,
      timestamp: '2025-01-01T00:00:00.000Z',
    });

    const result = readCategory(fx, 'cv');
    expect(result.chainValid).toBe(true);
    expect(result.chainCondition).toBeNull();
    expect(result.receipts.map((r) => r.filePath)).toEqual([valid.path]);
  });
});

// ============================================================
// All categories (PO-S02-C-03 — per category dir chain verification)
// ============================================================

describe('readAllReceiptCategories — every canonical category directory (PO-S02-C-03)', () => {
  it('reads one valid receipt per content category with intact chains', () => {
    const fx = makeFixture();
    const stage = fx.stageId;
    const slice = fx.sliceId;

    writeReceiptFile(planReceiptDir(fx.root, stage), { type: 'STAGE_PLAN', stage_id: stage });
    writeReceiptFile(tasksReceiptDir(fx.root, stage, slice), { type: 'TASK_COMPLETE', slice_id: slice });
    writeReceiptFile(cvReceiptDir(fx.root, stage, slice), { type: 'CV_PASS', slice_id: slice });
    writeReceiptFile(committerReceiptDir(fx.root, stage, slice), { type: 'SLICE_COMMIT', slice_id: slice });
    writeReceiptFile(integrationReceiptDir(fx.root, stage, slice), { type: 'INTEGRATION_PASS', slice_id: slice });
    writeReceiptFile(stageGateReceiptDir(fx.root, stage), { type: 'GATE_PASS', stage_id: stage });
    writeReceiptFile(reviewReceiptDir(fx.root, stage), { type: 'STAGE_REVIEW_PASS', stage_id: stage });
    writeReceiptFile(projectReceiptDir(fx.root), { type: 'PROJECT_REVIEW_PASS', stage_id: stage });
    writeStageCloseReceiptFile(stageCloseReceiptDir(fx.root, stage), stage);

    const all = readAllReceiptCategories({ projectRoot: fx.root, stageId: stage, sliceId: slice });

    expect(all.plan.latest?.receipt.type).toBe('STAGE_PLAN');
    expect(all.tasks.latest?.receipt.type).toBe('TASK_COMPLETE');
    expect(all.cv.latest?.receipt.type).toBe('CV_PASS');
    expect(all.committer.latest?.receipt.type).toBe('SLICE_COMMIT');
    expect(all.integration.latest?.receipt.type).toBe('INTEGRATION_PASS');
    expect(all['stage-gate'].latest?.receipt.type).toBe('GATE_PASS');
    expect(all.review.latest?.receipt.type).toBe('STAGE_REVIEW_PASS');
    expect(all.project.latest?.receipt.type).toBe('PROJECT_REVIEW_PASS');

    for (const category of RECEIPT_CONTENT_CATEGORIES) {
      if (category === 'stage-close') {
        // P-11: `stage-close` is the vNext-only content category. The persisted
        // STAGE_CLOSE_PASS envelope is deliberately NOT a kernel ReceiptType,
        // so the legacy reader seam fail-closes on it: the envelope is reported
        // as a schema-mismatch invalid file and never becomes a fact, and the
        // kernel chain verifier treats the vNext-only directory as not a valid
        // kernel chain. The directory is still scanned (per-category coverage);
        // the stage-close chain itself is read by the vNext chain reader
        // (vnext/stage-close-admission.ts), not by this legacy seam.
        expect(all[category].dir).toBe(stageCloseReceiptDir(fx.root, stage));
        expect(all[category].chainValid).toBe(false);
        expect(all[category].chainCondition?.code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
        expect(all[category].receipts).toHaveLength(0);
        expect(all[category].latest).toBeNull();
        expect(all[category].misplaced).toHaveLength(0);
        expect(all[category].invalidFiles).toHaveLength(1);
        expect(all[category].invalidFiles[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
        continue;
      }
      expect(all[category].chainValid).toBe(true);
      expect(all[category].chainCondition).toBeNull();
      expect(all[category].misplaced).toHaveLength(0);
      expect(all[category].invalidFiles).toHaveLength(0);
      expect(all[category].receipts).toHaveLength(1);
    }
  });
});
