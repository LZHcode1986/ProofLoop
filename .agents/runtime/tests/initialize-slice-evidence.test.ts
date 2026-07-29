import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initializeSliceEvidence, validateEvidencePathPattern } from '../src/initialize-slice-evidence.js';
import type { Manifest } from '../src/schemas.js';

let tmpDir: string;

function makeManifest(overrides?: Partial<Manifest>): Manifest {
  const base: Manifest = {
    stage_id: 'S01',
    source_path: 'tasks.md',
    source_digest: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    stage_goal: 'Test stage',
    outcomes: ['Outcome 1'],
    slices: [
      {
        slice_id: 'S01-A',
        goal: 'Slice A goal',
        observable_outcome: 'Outcome A',
        public_seam: 'Seam A',
        dependencies: [],
        proof_obligations: [],
        tasks: [],
        risk_facts: ['none'],
        evidence_path: 'delivery/stages/S01/evidence/S01-A.md',
        cv_minimum_level: 'lite',
      },
      {
        slice_id: 'S01-B',
        goal: 'Slice B goal',
        observable_outcome: 'Outcome B',
        public_seam: 'Seam B',
        dependencies: ['S01-A'],
        proof_obligations: [],
        tasks: [],
        risk_facts: ['persistent_state'],
        evidence_path: 'delivery/stages/S01/evidence/S01-B.md',
        cv_minimum_level: 'standard',
      },
    ],
    dependencies: [],
    risk_facts: [],
    runtime_proof: [],
    compiled_at: new Date().toISOString(),
    compiled_by: 'test',
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-init-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('initializeSliceEvidence', () => {
  test('creates skeleton evidence files for all slices', () => {
    const manifest = makeManifest();
    const result = initializeSliceEvidence({ manifest, deliveryRoot: tmpDir });

    expect(result.errors).toHaveLength(0);
    expect(result.created).toHaveLength(2);

    const evidenceDir = path.join(tmpDir, 'delivery', 'stages', 'S01', 'evidence');
    expect(fs.existsSync(evidenceDir)).toBe(true);

    for (const slice of manifest.slices) {
      const filePath = path.join(evidenceDir, `${slice.slice_id}.md`);
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, 'utf-8');
      // Should contain the slice ID and manifest digest
      expect(content).toContain(`# Slice ${slice.slice_id} Evidence`);
      expect(content).toContain(`Slice Goal: ${slice.goal}`);
      expect(content).toContain(`Manifest Digest:`);
      // Should be a non-trivial digest (not the fallback)
      expect(content).toContain('- Manifest Digest: ');
      expect(content).not.toContain('0000000000000000');
    }

    expect(result.skipped).toHaveLength(0);
  });

  test('does not overwrite existing non-empty evidence files', () => {
    const manifest = makeManifest();
    const evidenceDir = path.join(tmpDir, 'delivery', 'stages', 'S01', 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });

    // Pre-create an evidence file with content
    const existingContent = '# Pre-existing evidence content\nThis should be preserved.';
    fs.writeFileSync(path.join(evidenceDir, 'S01-A.md'), existingContent, 'utf-8');

    const result = initializeSliceEvidence({ manifest, deliveryRoot: tmpDir });

    // S01-A should be skipped (non-empty), S01-B should be created
    expect(result.created).toHaveLength(1); // only S01-B
    expect(result.skipped).toHaveLength(1); // S01-A

    // Verify pre-existing content is unchanged
    const preservedContent = fs.readFileSync(path.join(evidenceDir, 'S01-A.md'), 'utf-8');
    expect(preservedContent).toBe(existingContent);

    // Verify S01-B was created with skeleton
    const newContent = fs.readFileSync(path.join(evidenceDir, 'S01-B.md'), 'utf-8');
    expect(newContent).toContain('# Slice S01-B Evidence');
  });

  test('overwrites empty existing evidence files', () => {
    const manifest = makeManifest();
    const evidenceDir = path.join(tmpDir, 'delivery', 'stages', 'S01', 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });

    // Pre-create an empty evidence file
    fs.writeFileSync(path.join(evidenceDir, 'S01-A.md'), '', 'utf-8');

    const result = initializeSliceEvidence({ manifest, deliveryRoot: tmpDir });

    // S01-A should be overwritten (empty file), so it counts as created
    expect(result.created).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);

    const content = fs.readFileSync(path.join(evidenceDir, 'S01-A.md'), 'utf-8');
    expect(content).toContain('# Slice S01-A Evidence');
  });

  // ── Path validation tests ──
  // The initializer has TWO layers of path defense:
  // 1. Pattern validation: evidence_path must match delivery/stages/<id>/evidence/<slice-id>.md
  // 2. Path resolution check: resolved dir must equal canonical evidence dir
  //
  // Since layer 1 (pattern) is intentionally strict, most traversal attempts
  // are caught there before reaching layer 2.

  test('rejects evidence_path that does not match canonical pattern', () => {
    const manifest = makeManifest({
      slices: [
        {
          slice_id: 'S01-A',
          goal: 'Bad pattern',
          observable_outcome: 'Should fail',
          public_seam: 'Seam',
          dependencies: [],
          proof_obligations: [],
          tasks: [],
          risk_facts: ['none'],
          evidence_path: '../../../etc/passwd',
          cv_minimum_level: 'lite',
        },
      ],
    });

    const result = initializeSliceEvidence({ manifest, deliveryRoot: tmpDir });

    expect(result.created).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('does not match expected pattern');
  });

  test('rejects evidence_path with wrong stage ID in path', () => {
    const manifest = makeManifest({
      slices: [
        {
          slice_id: 'S01-A',
          goal: 'Wrong stage',
          observable_outcome: 'Should fail',
          public_seam: 'Seam',
          dependencies: [],
          proof_obligations: [],
          tasks: [],
          risk_facts: ['none'],
          evidence_path: 'delivery/stages/S99/evidence/S01-A.md',
          cv_minimum_level: 'lite',
        },
      ],
    });

    const result = initializeSliceEvidence({ manifest, deliveryRoot: tmpDir });

    expect(result.created).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    // The pattern validator checks stage ID match
    expect(result.errors[0]).toContain('stage ID');
  });

  test('rejects evidence_path with wrong slice ID in path', () => {
    const manifest = makeManifest({
      slices: [
        {
          slice_id: 'S01-A',
          goal: 'Wrong slice',
          observable_outcome: 'Should fail',
          public_seam: 'Seam',
          dependencies: [],
          proof_obligations: [],
          tasks: [],
          risk_facts: ['none'],
          evidence_path: 'delivery/stages/S01/evidence/S99-Z.md',
          cv_minimum_level: 'lite',
        },
      ],
    });

    const result = initializeSliceEvidence({ manifest, deliveryRoot: tmpDir });

    expect(result.created).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('slice ID');
  });

  test('rejects evidence_path with path traversal components', () => {
    // Even if the filename after the last / is a valid slice ID, if the path
    // contains ".." components that would resolve outside the evidence dir,
    // the pattern check catches it because the regex requires the path to
    // start with exactly "delivery/stages/<stage-id>/evidence/<slice-id>.md"
    // with no ".." segments allowed.
    const manifest = makeManifest({
      slices: [
        {
          slice_id: 'S01-A',
          goal: 'Dot-dot traversal',
          observable_outcome: 'Should fail',
          public_seam: 'Seam',
          dependencies: [],
          proof_obligations: [],
          tasks: [],
          risk_facts: ['none'],
          evidence_path: 'delivery/stages/S01/evidence/../other/S01-A.md',
          cv_minimum_level: 'lite',
        },
      ],
    });

    const result = initializeSliceEvidence({ manifest, deliveryRoot: tmpDir });

    expect(result.created).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    // Should fail pattern because "other" is in the path
    expect(result.errors[0]).toContain('does not match expected pattern');
  });

  test('rejects evidence_path with absolute path', () => {
    const manifest = makeManifest({
      slices: [
        {
          slice_id: 'S01-A',
          goal: 'Absolute path',
          observable_outcome: 'Should fail',
          public_seam: 'Seam',
          dependencies: [],
          proof_obligations: [],
          tasks: [],
          risk_facts: ['none'],
          evidence_path: '/etc/passwd',
          cv_minimum_level: 'lite',
        },
      ],
    });

    const result = initializeSliceEvidence({ manifest, deliveryRoot: tmpDir });

    expect(result.created).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // ── Symlink rejection tests ──

  test('rejects symlinked evidence directory', () => {
    // Create a valid evidence directory structure
    const realDir = path.join(tmpDir, 'real-evidence');
    fs.mkdirSync(realDir, { recursive: true });

    // Create a symlink pointing to it
    const symlinkDir = path.join(tmpDir, 'delivery', 'stages', 'S01', 'evidence');
    fs.mkdirSync(path.dirname(symlinkDir), { recursive: true });
    try {
      fs.symlinkSync(realDir, symlinkDir, 'dir');
    } catch {
      // Skip test if symlinks are not supported (e.g. Windows without admin)
      return;
    }

    const manifest = makeManifest();
    const result = initializeSliceEvidence({ manifest, deliveryRoot: tmpDir });

    // Should reject because symlinked path
    expect(result.created).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('symlink');
  });

  // ── Exclusive create (TOCTOU) tests ──

  test('exclusive create does not overwrite existing files', () => {
    const manifest = makeManifest();
    const evidenceDir = path.join(tmpDir, 'delivery', 'stages', 'S01', 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });

    // Pre-create an evidence file (non-empty)
    const existingContent = '# Pre-existing evidence';
    fs.writeFileSync(path.join(evidenceDir, 'S01-A.md'), existingContent, 'utf-8');

    const result = initializeSliceEvidence({ manifest, deliveryRoot: tmpDir });

    // S01-A should be skipped (non-empty), S01-B created via exclusive create
    expect(result.skipped).toHaveLength(1);
    expect(result.created).toHaveLength(1);

    // Verify pre-existing content is unchanged
    const preserved = fs.readFileSync(path.join(evidenceDir, 'S01-A.md'), 'utf-8');
    expect(preserved).toBe(existingContent);

    // Verify S01-B was created
    expect(fs.existsSync(path.join(evidenceDir, 'S01-B.md'))).toBe(true);
  });

  test('exclusive create handles concurrent race gracefully', () => {
    const manifest = makeManifest();
    const evidenceDir = path.join(tmpDir, 'delivery', 'stages', 'S01', 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });

    // Simulate concurrent file creation by pre-creating S01-B.md
    // while S01-A.md does not exist yet
    const concurrentContent = '# Concurrent create';
    fs.writeFileSync(path.join(evidenceDir, 'S01-B.md'), concurrentContent, 'utf-8');

    const result = initializeSliceEvidence({ manifest, deliveryRoot: tmpDir });

    // S01-A should be created, S01-B should be skipped (concurrent non-empty)
    expect(result.created).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);

    // Verify concurrent content is unchanged
    const preserved = fs.readFileSync(path.join(evidenceDir, 'S01-B.md'), 'utf-8');
    expect(preserved).toBe(concurrentContent);
  });

  // ── Fail-closed: digest failure should return errors, not write skeletons ──

  test('fails closed when manifest schema validation fails (no fake digest, no skeleton)', () => {
    // Pass an invalid manifest object that will fail computeCanonicalJsonDigest
    // (e.g. missing required fields like slices)
    const badManifest = {
      stage_id: 'S01',
      // Missing slices, outcomes, etc.
    } as unknown as Manifest;

    const result = initializeSliceEvidence({ manifest: badManifest, deliveryRoot: tmpDir });

    // Should have errors, not created/skipped
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);

    // Error message should mention digest computation failure
    expect(result.errors[0]).toMatch(/digest computation failed/i);

    // No evidence directory should have been created
    const evidenceDir = path.join(tmpDir, 'delivery', 'stages', 'S01', 'evidence');
    expect(fs.existsSync(evidenceDir)).toBe(false);
  });

  // ── Digest distinctness ──

  test('different slice content produces different skeleton manifest digest', () => {
    // Create two manifests with different slice content
    const manifest1 = makeManifest();
    const manifest2 = makeManifest({
      slices: [
        {
          ...manifest1.slices[0],
          goal: 'Different goal content',
        },
        ...manifest1.slices.slice(1),
      ],
    });

    const result1 = initializeSliceEvidence({ manifest: manifest1, deliveryRoot: tmpDir });

    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-init-test-2-'));
    try {
      const result2 = initializeSliceEvidence({ manifest: manifest2, deliveryRoot: tmpDir2 });

      // Read the digests from the skeletons
      const evidenceDir1 = path.join(tmpDir, 'delivery', 'stages', 'S01', 'evidence');
      const evidenceDir2 = path.join(tmpDir2, 'delivery', 'stages', 'S01', 'evidence');

      const content1 = fs.readFileSync(path.join(evidenceDir1, 'S01-A.md'), 'utf-8');
      const content2 = fs.readFileSync(path.join(evidenceDir2, 'S01-A.md'), 'utf-8');

      const digestMatch1 = content1.match(/- Manifest Digest: ([a-f0-9]{16})/);
      const digestMatch2 = content2.match(/- Manifest Digest: ([a-f0-9]{16})/);

      expect(digestMatch1).not.toBeNull();
      expect(digestMatch2).not.toBeNull();
      // Different content should produce different digests
      expect(digestMatch1![1]).not.toBe(digestMatch2![1]);
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});

describe('validateEvidencePathPattern', () => {
  test('accepts valid path', () => {
    expect(validateEvidencePathPattern(
      'delivery/stages/S01/evidence/S01-A.md', 'S01', 'S01-A',
    )).toBeNull();
  });

  test('rejects path with wrong pattern', () => {
    const err = validateEvidencePathPattern(
      'evidence/S01-A.md', 'S01', 'S01-A',
    );
    expect(err).not.toBeNull();
    expect(err).toContain('does not match expected pattern');
  });

  test('rejects path with wrong stage ID', () => {
    const err = validateEvidencePathPattern(
      'delivery/stages/S99/evidence/S01-A.md', 'S01', 'S01-A',
    );
    expect(err).not.toBeNull();
    expect(err).toContain('stage ID');
  });

  test('rejects path with wrong slice ID', () => {
    const err = validateEvidencePathPattern(
      'delivery/stages/S01/evidence/S99-Z.md', 'S01', 'S01-A',
    );
    expect(err).not.toBeNull();
    expect(err).toContain('slice ID');
  });
});
