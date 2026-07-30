import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  updateCurrentCvStatus,
  updateCvStatusPass,
  updateCvStatusRepair,
  updateCvStatusPendingRecheck,
  updateCvStatusReadyForCv,
} from '../src/update-current-cv-status.js';

let tmpDir: string;
let deliveryRoot: string;

// ── Helper to create canonical evidence path ──
function canonicalEvidencePath(stageId = 'S01', sliceId = 'S01-A'): string {
  return path.join('delivery', 'stages', stageId, 'evidence', `${sliceId}.md`);
}

// ── Helper to create a valid CV receipt path (under .proofloop/receipts/cv/<stage>/<slice>/) ──
function canonicalReceiptPath(stageId = 'S01', sliceId = 'S01-A', filename = 'initial-001.json'): string {
  const isRepair = /^(repair|r)/i.test(filename);
  const normalized = /^(initial|recheck)-\d{3}\.json$/.test(filename)
    ? filename
    : `${isRepair ? 'recheck' : 'initial'}-${filename === 'pass-001.json' ? '001' : '001'}.json`;
  const absolute = path.join(tmpDir, '.proofloop', 'receipts', 'cv', stageId, sliceId, normalized);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, JSON.stringify({
    slice_id: sliceId, stage_id: stageId, snapshot: 'a1b2c3d4e5f6a7b8',
    cv_level: /pass/i.test(filename) ? 'enhanced' : 'standard',
    verification_type: normalized.startsWith('recheck') ? 'recheck' : 'initial',
    verdict: isRepair ? 'REPAIR' : 'PASS',
    failed_po_ids: isRepair ? ['PO-S01-A-01'] : [],
    affected_task_ids: [],
    invalid_tests: [], counterexamples: [], scope_violations: [],
    required_recheck_scope: isRepair ? ['full'] : [],
    failed_criterion: isRepair ? 'output mismatch' : undefined,
    failure_signature: isRepair ? 'abc123' : undefined,
    timestamp: new Date().toISOString(),
  }), 'utf8');
  return path.relative(tmpDir, absolute);
}

// ── Helper to create a receipt file at the canonical path ──
function createReceipt(stageId = 'S01', sliceId = 'S01-A', filename = 'initial-001.json', verdict = 'PASS'): string {
  const receiptDir = path.join(tmpDir, '.proofloop', 'receipts', 'cv', stageId, sliceId);
  fs.mkdirSync(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, filename);
  const receiptContent = JSON.stringify({
    slice_id: sliceId,
    stage_id: stageId,
    snapshot: 'a1b2c3d4e5f6a7b8',
    cv_level: 'standard',
    verification_type: 'initial',
    verdict,
    failed_po_ids: verdict === 'REPAIR' ? ['PO-S01-A-01'] : [],
    affected_task_ids: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    required_recheck_scope: verdict === 'REPAIR' ? ['full'] : [],
    failed_criterion: verdict === 'REPAIR' ? 'output mismatch' : undefined,
    failure_signature: verdict === 'REPAIR' ? 'abc123' : undefined,
    timestamp: new Date().toISOString(),
  });
  fs.writeFileSync(receiptPath, receiptContent, 'utf-8');
  return receiptPath;
}

// ── Evidence skeleton with Current CV Status section ──

const EVIDENCE_WITH_CV_SECTION = `# Slice S01-A Evidence

## Slice Context

- Slice ID: S01-A
- Stage ID: S01

## Task Evidence

*No tasks have been executed yet.*

## Current Slice Evidence

### Snapshot

*Not yet captured.*

### Proof Obligation Coverage

| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |
|---|---|---|---|---|

### Changed Files

*No changes yet.*

### Verification Commands

*Not yet run.*

### Actual Observations

*Not yet observed.*

### Limitations

*None identified.*

## Current CV Status

- Status: NOT_RUN
- Level: *Not yet determined*
- Latest CV Receipt: *None*
- Open Finding: *None*

## Another Section

This should be preserved.
`;

const EVIDENCE_WITHOUT_CV_SECTION = `# Slice S01-A Evidence

## Slice Context

- Slice ID: S01-A

## Task Evidence

*No tasks yet.*

## Current Slice Evidence

### Snapshot

Nothing here.

## Another Section

No CV status here.
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-status-test-'));
  deliveryRoot = tmpDir;
  // Create the canonical directory structure
  fs.mkdirSync(path.join(tmpDir, 'delivery', 'stages', 'S01', 'evidence'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('updateCurrentCvStatus', () => {

  test('rejects file when CV Status section is missing', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITHOUT_CV_SECTION, 'utf-8');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'PASS',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
      cvLevel: 'standard',
      latestReceiptPath: path.join(tmpDir, canonicalReceiptPath()),
    });

    expect(result.success).toBe(false);
    expect(result.modified).toBe(false);
    expect(result.error).toContain('missing');
  });

  test('rejects non-existent file in canonical path', () => {
    // Use a canonical path that doesn't exist
    const canonicalPath = path.join(tmpDir, canonicalEvidencePath());
    const result = updateCurrentCvStatus({
      evidencePath: canonicalPath,
      status: 'READY_FOR_CV',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
    });

    expect(result.success).toBe(false);
    expect(result.modified).toBe(false);
    expect(result.error).toContain('Cannot read');
  });

  test('rejects non-canonical evidence path', () => {
    // Create file outside the canonical evidence directory
    const filePath = path.join(tmpDir, 'S01-A.md');
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'PASS',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
      cvLevel: 'standard',
      latestReceiptPath: path.join(tmpDir, canonicalReceiptPath()),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not match the canonical');
  });

  test('rejects PASS without cvLevel', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'PASS',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('cvLevel');
  });

  test('rejects invalid status', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'INVALID_STATUS' as any,
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid CV status');
  });

  test.each(['REPLAN', 'BLOCKED', 'ESCALATION_REQUIRED'])('rejects legacy routed status %s', (status) => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: status as any,
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot,
    });

    expect(result.success).toBe(false);
    expect(result.modified).toBe(false);
    expect(result.error).toContain('Invalid CV status');
  });

  test('updates status field only', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'READY_FOR_CV',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
    });

    expect(result.success).toBe(true);
    expect(result.modified).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('- Status: READY_FOR_CV');
    expect(content).toContain('- Level: *Not yet determined*'); // unchanged
    expect(content).toContain('- Latest CV Receipt: *None*');   // unchanged
    expect(content).toContain('- Open Finding: *None*');        // unchanged
    expect(content).toContain('## Another Section');            // preserved
  });

  test('updates multiple fields simultaneously', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'PASS',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
      cvLevel: 'standard',
      latestReceiptPath: path.join(tmpDir, canonicalReceiptPath()),
      openFinding: '',
    });

    expect(result.success).toBe(true);
    expect(result.modified).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('- Status: PASS');
    expect(content).toContain('- Level: standard');
    expect(content).toContain('- Latest CV Receipt: ');
    expect(content).toContain('initial-001.json');
    expect(content).toContain('.proofloop');
    expect(content).toContain('- Open Finding: *None*');
  });

  test('returns modified=false when no change needed', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    const receiptPath = path.join(tmpDir, canonicalReceiptPath());

    // First update
    updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'PASS',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
      cvLevel: 'standard',
      latestReceiptPath: receiptPath,
    });

    // Second update with same status
    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'PASS',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
      cvLevel: 'standard',
      latestReceiptPath: receiptPath,
    });

    expect(result.success).toBe(true);
    expect(result.modified).toBe(false);
  });

  test('sets open finding for REPAIR status', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'REPAIR',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
      cvLevel: 'standard',
      latestReceiptPath: path.join(tmpDir, canonicalReceiptPath('S01', 'S01-A', 'repair-001.json')),
      openFinding: 'PO-S01-A-01 failed: output mismatch',
    });

    expect(result.success).toBe(true);
    expect(result.modified).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('- Status: REPAIR');
    expect(content).toContain('- Open Finding: PO-S01-A-01 failed: output mismatch');
  });

  test('clears open finding for PASS', () => {
    const modifiedEvidence = EVIDENCE_WITH_CV_SECTION.replace(
      '- Open Finding: *None*',
      '- Open Finding: PO-S01-A-01 failed',
    );

    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, modifiedEvidence, 'utf-8');

    const result = updateCvStatusPass(
      filePath,
      'S01',
      'S01-A',
      deliveryRoot,
      'standard',
      path.join(tmpDir, canonicalReceiptPath('S01', 'S01-A', 'initial-002.json')),
    );

    expect(result.success).toBe(true);
    expect(result.modified).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('- Status: PASS');
    expect(content).toContain('- Latest CV Receipt: ');
    expect(content).toContain('initial-002.json');
    expect(content).toContain('.proofloop');
    // Finding should be cleared
    expect(content).toContain('- Open Finding: *None*');
  });

  test('preserves all other sections unchanged', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'PASS',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
      cvLevel: 'enhanced',
      latestReceiptPath: path.join(tmpDir, canonicalReceiptPath()),
    });

    const content = fs.readFileSync(filePath, 'utf-8');

    // Other sections preserved
    expect(content).toContain('# Slice S01-A Evidence');
    expect(content).toContain('## Task Evidence');
    expect(content).toContain('## Current Slice Evidence');
    expect(content).toContain('### Snapshot');
    expect(content).toContain('*Not yet captured.*');
    expect(content).toContain('## Another Section');
    expect(content).toContain('This should be preserved.');
  });

  test('canonical CV lifecycle status requires matching immutable verdict', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');
    const receiptPath = createReceipt('S01', 'S01-A', 'initial-001.json', 'REPLAN');
    const result = updateCurrentCvStatus({
      evidencePath: filePath, status: 'CV_REPLAN_REQUIRED', stageId: 'S01', sliceId: 'S01-A',
      deliveryRoot, cvLevel: 'standard', latestReceiptPath: receiptPath,
    });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(filePath, 'utf8')).toContain('- Status: CV_REPLAN_REQUIRED');
  });

  test('canonical routed status without receipt is rejected', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');
    const result = updateCurrentCvStatus({
      evidencePath: filePath, status: 'CV_BLOCKED', stageId: 'S01', sliceId: 'S01-A',
      deliveryRoot, cvLevel: 'standard',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/latestReceiptPath/i);
  });

  test('rejects a receipt whose verdict does not authorize the requested status', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');
    const receiptPath = createReceipt('S01', 'S01-A', 'initial-001.json', 'REPAIR');
    const result = updateCurrentCvStatus({
      evidencePath: filePath, status: 'PASS', stageId: 'S01', sliceId: 'S01-A',
      deliveryRoot, cvLevel: 'standard', latestReceiptPath: receiptPath,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('does not authorize');
  });

  test('rejects a symlinked receipt even when its target is valid', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');
    const target = createReceipt('S01', 'S01-A', 'initial-001.json', 'PASS');
    const link = path.join(tmpDir, '.proofloop', 'receipts', 'cv', 'S01', 'S01-A', 'initial-002.json');
    try { fs.symlinkSync(target, link, 'file'); } catch { return; }
    const result = updateCurrentCvStatus({
      evidencePath: filePath, status: 'PASS', stageId: 'S01', sliceId: 'S01-A',
      deliveryRoot, cvLevel: 'standard', latestReceiptPath: link,
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/symlink|immutable/i);
  });

  // ── Symlinked deliveryRoot alias (macOS /var -> /private/var) ────────

  test('accepts symlinked deliveryRoot alias for evidence path', () => {
    // Create a symlink alias to the real tmpDir and use it as deliveryRoot.
    // This simulates macOS /var -> /private/var where the caller supplies a
    // deliveryRoot that resolves through a system symlink.
    const aliasDir = path.join(path.dirname(tmpDir), 'cv-test-symlink-' + path.basename(tmpDir));
    let aliasCleanup: (() => void) | null = null;
    try {
      try { fs.rmSync(aliasDir, { recursive: true, force: true }); } catch { /* ok */ }
      fs.symlinkSync(tmpDir, aliasDir, 'dir');
      aliasCleanup = () => { try { fs.rmSync(aliasDir, { recursive: true, force: true }); } catch { /* ok */ } };
    } catch {
      // Symlinks unsupported on this platform — skip
      return;
    }

    try {
      // Evidence file lives at the REAL tmpDir's canonical path
      const filePath = path.join(tmpDir, canonicalEvidencePath());
      fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

      // But deliveryRoot is the symlink alias
      const result = updateCurrentCvStatus({
        evidencePath: filePath,
        status: 'READY_FOR_CV',
        stageId: 'S01',
        sliceId: 'S01-A',
        deliveryRoot: aliasDir,
      });

      expect(result.success).toBe(true);
      expect(result.modified).toBe(true);
    } finally {
      if (aliasCleanup) aliasCleanup();
    }
  });

  test('accepts symlinked deliveryRoot alias for receipt path', () => {
    const aliasDir = path.join(path.dirname(tmpDir), 'cv-test-symlink-r-' + path.basename(tmpDir));
    let aliasCleanup: (() => void) | null = null;
    try {
      try { fs.rmSync(aliasDir, { recursive: true, force: true }); } catch { /* ok */ }
      fs.symlinkSync(tmpDir, aliasDir, 'dir');
      aliasCleanup = () => { try { fs.rmSync(aliasDir, { recursive: true, force: true }); } catch { /* ok */ } };
    } catch {
      return;
    }

    try {
      const filePath = path.join(tmpDir, canonicalEvidencePath());
      fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');
      const receiptPath = createReceipt('S01', 'S01-A', 'initial-001.json', 'PASS');

      // deliveryRoot is the symlink alias; receipt path uses REAL tmpDir
      const result = updateCurrentCvStatus({
        evidencePath: filePath,
        status: 'PASS',
        stageId: 'S01',
        sliceId: 'S01-A',
        deliveryRoot: aliasDir,
        cvLevel: 'standard',
        latestReceiptPath: receiptPath,
      });

      expect(result.success).toBe(true);
      expect(result.modified).toBe(true);
    } finally {
      if (aliasCleanup) aliasCleanup();
    }
  });

  test('rejects canonical evidence path when delivery/ component itself is a symlink below deliveryRoot', () => {
    // Create a real directory inside tmpDir to hold the evidence file
    // at a genuine sub-path: stages/S01/evidence/S01-A.md
    const realContentDir = path.join(tmpDir, 'real-content');
    fs.mkdirSync(path.join(realContentDir, 'stages', 'S01', 'evidence'), { recursive: true });
    const realEvidenceFile = path.join(realContentDir, 'stages', 'S01', 'evidence', 'S01-A.md');
    fs.writeFileSync(realEvidenceFile, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    // Create symlink at deliveryRoot/delivery → real-content (inside deliveryRoot)
    const deliveryLink = path.join(tmpDir, 'delivery');
    try { fs.symlinkSync(realContentDir, deliveryLink, 'dir'); } catch { return; }

    // The canonical lexical evidence path goes through the symlink
    const canonicalPath = path.join(tmpDir, 'delivery', 'stages', 'S01', 'evidence', 'S01-A.md');

    const result = updateCurrentCvStatus({
      evidencePath: canonicalPath,
      status: 'READY_FOR_CV',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: tmpDir,
    });

    // Should reject because delivery/ is a symlink below deliveryRoot
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/symlink/i);
  });

  test('rejects receipt when .proofloop component is a symlink below deliveryRoot', () => {
    // Create a genuine canonical lexical receipt path where the .proofloop
    // component itself is a symlink below deliveryRoot. This proves that
    // updateCurrentCvStatus rejects the internal symlink via the ancestor
    // walk (lines 249-257), rather than failing on the earlier lexical
    // canonical-root directory check (line 237).
    const realProofloopTarget = path.join(tmpDir, 'proofloop-real');
    const receiptDir = path.join(realProofloopTarget, 'receipts', 'cv', 'S01', 'S01-A');
    fs.mkdirSync(receiptDir, { recursive: true });
    const realReceipt = path.join(receiptDir, 'initial-001.json');
    fs.writeFileSync(realReceipt, JSON.stringify({
      slice_id: 'S01-A', stage_id: 'S01', snapshot: 'x',
      cv_level: 'standard', verification_type: 'initial',
      verdict: 'PASS', failed_po_ids: [], affected_task_ids: [],
      invalid_tests: [], counterexamples: [], scope_violations: [],
      required_recheck_scope: [], timestamp: new Date().toISOString(),
    }), 'utf-8');

    // Symlink .proofloop -> proofloop-real (both strictly below deliveryRoot)
    const proofloopLink = path.join(tmpDir, '.proofloop');
    try { fs.symlinkSync(realProofloopTarget, proofloopLink, 'dir'); } catch { return; }

    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    // The receipt path is now lexically canonical:
    //   <tmpDir>/.proofloop/receipts/cv/S01/S01-A/initial-001.json
    // The directory check (line 237) passes because receiptDir matches
    // expectedReceiptDir lexically. The symlink walk then catches
    // .proofloop as a symlink below deliveryRoot.
    const canonicalReceiptPath = path.join(tmpDir, '.proofloop', 'receipts', 'cv', 'S01', 'S01-A', 'initial-001.json');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'PASS',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: tmpDir,
      cvLevel: 'standard',
      latestReceiptPath: canonicalReceiptPath,
    });

    expect(result.success).toBe(false);
    // Must be rejected for the symlink, not for a lexical directory mismatch
    expect(result.error).toMatch(/symlink|immutable/i);
  });
});

describe('convenience functions', () => {

  test('updateCvStatusPass sets PASS with cleared finding', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    const result = updateCvStatusPass(filePath, 'S01', 'S01-A', deliveryRoot, 'enhanced', path.join(tmpDir, canonicalReceiptPath('S01', 'S01-A', 'pass-001.json')));
    expect(result.success).toBe(true);
    expect(result.modified).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('- Status: PASS');
    expect(content).toContain('- Level: enhanced');
    expect(content).toContain('- Latest CV Receipt: ');
    expect(content).toContain('initial-001.json');
    expect(content).toContain('.proofloop');
    expect(content).toContain('- Open Finding: *None*');
  });

  test('updateCvStatusRepair sets REPAIR with open finding', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    const result = updateCvStatusRepair(
      filePath,
      'S01',
      'S01-A',
      deliveryRoot,
      'standard',
      path.join(tmpDir, canonicalReceiptPath('S01', 'S01-A', 'repair-001.json')),
      'PO-S01-A-01 failed',
    );
    expect(result.success).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('- Status: REPAIR');
    expect(content).toContain('- Open Finding: PO-S01-A-01 failed');
  });

  test('updateCvStatusPendingRecheck sets PENDING_RECHECK with cleared finding', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    // First set REPAIR
    updateCvStatusRepair(filePath, 'S01', 'S01-A', deliveryRoot, 'standard', path.join(tmpDir, canonicalReceiptPath('S01', 'S01-A', 'r1.json')), 'Some finding');

    // Then set PENDING_RECHECK
    const result = updateCvStatusPendingRecheck(filePath, 'S01', 'S01-A', deliveryRoot, 'standard', path.join(tmpDir, canonicalReceiptPath('S01', 'S01-A', 'r2.json')));
    expect(result.success).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('- Status: PENDING_RECHECK');
    expect(content).toContain('- Open Finding: *None*'); // cleared
  });

  test('updateCvStatusReadyForCv sets READY_FOR_CV', () => {
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, EVIDENCE_WITH_CV_SECTION, 'utf-8');

    const result = updateCvStatusReadyForCv(filePath, 'S01', 'S01-A', deliveryRoot);
    expect(result.success).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('- Status: READY_FOR_CV');
  });

  // ── Fail-closed on missing required lines ──

  test('fails closed when - Status: line is missing from section', () => {
    const brokenSection = EVIDENCE_WITH_CV_SECTION.replace(
      '- Status: NOT_RUN\n',
      '',
    );
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, brokenSection, 'utf-8');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'READY_FOR_CV',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('- Status:');
    expect(result.modified).toBe(false);
  });

  test('fails closed when - Level: line is missing but cvLevel provided', () => {
    const brokenSection = EVIDENCE_WITH_CV_SECTION.replace(
      '- Level: *Not yet determined*\n',
      '',
    );
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, brokenSection, 'utf-8');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'PASS',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
      cvLevel: 'standard',
      latestReceiptPath: path.join(tmpDir, canonicalReceiptPath()),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('- Level:');
    expect(result.modified).toBe(false);
  });

  test('fails closed when - Latest CV Receipt: line is missing but receiptPath provided', () => {
    const brokenSection = EVIDENCE_WITH_CV_SECTION.replace(
      '- Latest CV Receipt: *None*\n',
      '',
    );
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, brokenSection, 'utf-8');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'PASS',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
      cvLevel: 'standard',
      latestReceiptPath: path.join(tmpDir, canonicalReceiptPath()),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('- Latest CV Receipt:');
    expect(result.modified).toBe(false);
  });

  test('fails closed when - Open Finding: line is missing but openFinding provided', () => {
    const brokenSection = EVIDENCE_WITH_CV_SECTION.replace(
      '- Open Finding: *None*\n',
      '',
    );
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, brokenSection, 'utf-8');

    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'REPAIR',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
      cvLevel: 'standard',
      latestReceiptPath: path.join(tmpDir, canonicalReceiptPath('S01', 'S01-A', 'repair-001.json')),
      openFinding: 'Some finding',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('- Open Finding:');
    expect(result.modified).toBe(false);
  });

  test('status-only update succeeds even when other standard lines are missing', () => {
    // Only - Status: line in the section; no - Level:/ - Latest CV Receipt:/ - Open Finding:
    const minimalSection = `## Current CV Status

- Status: NOT_RUN
`;
    const evidence = EVIDENCE_WITH_CV_SECTION.replace(
      /## Current CV Status[\s\S]*?(?=\n## )/,
      minimalSection,
    );
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, evidence, 'utf-8');

    // status-only update should work
    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'READY_FOR_CV',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
    });

    expect(result.success).toBe(true);
    expect(result.modified).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('- Status: READY_FOR_CV');
  });

  test('status-only update succeeds when cvLevel/receipt/finding lines are missing (they are not being updated)', () => {
    const brokenSection = EVIDENCE_WITH_CV_SECTION
      .replace('- Level: *Not yet determined*\n', '')
      .replace('- Latest CV Receipt: *None*\n', '')
      .replace('- Open Finding: *None*\n', '');
    const filePath = path.join(tmpDir, canonicalEvidencePath());
    fs.writeFileSync(filePath, brokenSection, 'utf-8');

    // Only status change requested with READY_FOR_CV (no cvLevel/receipt required)
    const result = updateCurrentCvStatus({
      evidencePath: filePath,
      status: 'READY_FOR_CV',
      stageId: 'S01',
      sliceId: 'S01-A',
      deliveryRoot: deliveryRoot,
    });

    expect(result.success).toBe(true);
    expect(result.modified).toBe(true);

    const content = fs.readFileSync(filePath, 'utf-8');
    expect(content).toContain('- Status: READY_FOR_CV');
  });
});
