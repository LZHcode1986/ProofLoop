import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { validateStage, validateStageWithManifest } from '../src/validate-stage.js';
import { compileManifest } from '../src/compile-manifest.js';

let tmpDir: string;

function writeFixture(name: string, content: string): string {
  const filePath = path.join(tmpDir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Fixture helpers ──

function validTasksMd(): string {
  return `# Stage S01 — Test Stage

## Stage Goal

This is a test stage.

## Observable Outcomes

- OUT-01 First outcome
- OUT-02 Second outcome

## Dependencies

## Constraints

## Out of Scope

---

## Slice Graph

---

## Slice S01-A — First Slice
<!-- SLICE:S01-A:BEGIN -->

### Goal

First slice goal

### Observable Outcome

OUT-01 realized

### Public Seam

Test seam

### Risk Facts

- persistent_state
- external_side_effect

### Dependencies

### Proof Obligations

- PO-S01-A-01
  - Behavior: verified
  - Public Seam: Test seam
  - Oracle Source: integration test
  - Success / Failure: exit 0
  - Required Observation: N/A
  - Applicable Risk Facts:

### Proof Plan

| PO ID | Test Level | Seam | Required Test |
|---|---|---|---|
| PO-S01-A-01 | unit | Test seam | verify behavior |

### Tasks

- [ ] S01-A-T01 Do the first task
- [ ] S01-A-T02 Do the second task

### Task → Slice Closure

All tasks complete the slice goal.

### Worker Status

- Status: planned

<!-- SLICE:S01-A:END -->

---

## Slice S01-B — Second Slice
<!-- SLICE:S01-B:BEGIN -->

### Goal

Second slice goal

### Observable Outcome

OUT-02 realized

### Public Seam

Test seam

### Risk Facts

- none

### Dependencies

- S01-A

### Proof Obligations

- PO-S01-B-01
  - Behavior: verified
  - Public Seam: Test seam
  - Oracle Source: snapshot comparison
  - Success / Failure: exit 0
  - Required Observation: N/A
  - Applicable Risk Facts:

### Proof Plan

| PO ID | Test Level | Seam | Required Test |
|---|---|---|---|
| PO-S01-B-01 | integration | Test seam | verify behavior |

### Tasks

- [ ] S01-B-T01 Do the third task

### Task → Slice Closure

Task completes the slice goal.

### Worker Status

- Status: planned

<!-- SLICE:S01-B:END -->

---

## Slice → Stage Closure
`;
}

function tasksMdMissingOracleSource(): string {
  return `# Stage S02 — Missing Oracle Source

## Stage Goal

Stage with a slice that has PO IDs but no Oracle Source field

## Observable Outcomes

- OUT-01 Outcome

## Dependencies

---

## Slice S02-A — Missing Oracle Source
<!-- SLICE:S02-A:BEGIN -->

### Goal

Solo goal

### Observable Outcome

OUT-01 realized

### Public Seam

Test seam

### Risk Facts

- none

### Dependencies

### Proof Obligations

- PO-S02-A-01
  - Behavior: verified
  - Public Seam: Test seam
  - Success / Failure: exit 0
  - Required Observation: N/A

### Proof Plan

| PO ID | Test Level | Seam | Required Test |
|---|---|---|---|
| PO-S02-A-01 | unit | Test seam | verify behavior |

### Tasks

- [ ] S02-A-T01 Do something (PO-S02-A-01 has no Oracle Source)

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S02-A:END -->
`;
}

function tasksMdDuplicateId(): string {
  return `# Stage S03 — Duplicate IDs

## Stage Goal

Stage with duplicate slice IDs

## Observable Outcomes

- OUT-01 Outcome

## Dependencies

---

## Slice S03-A — First
<!-- SLICE:S03-A:BEGIN -->

### Goal

First

### Observable Outcome

OUT-01

### Public Seam

Test

### Risk Facts

- none

### Dependencies

### Proof Obligations

- PO-S03-A-01
  - Behavior: verified
  - Public Seam: Test
  - Oracle Source: integration test
  - Success / Failure: exit 0
  - Required Observation:

### Proof Plan

| PO ID | Test Level | Seam | Required Test |
|---|---|---|---|
| PO-S03-A-01 | unit | Test | verify |

### Tasks

- [ ] S03-A-T01 Task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S03-A:END -->

---

## Slice S03-A — Second (duplicate ID)
<!-- SLICE:S03-A:BEGIN -->

### Goal

Second (should not exist)

### Observable Outcome

OUT-01

### Public Seam

Test

### Risk Facts

- none

### Dependencies

### Proof Obligations

- PO-S03-A-02
  - Behavior: verified
  - Public Seam: Test
  - Oracle Source: integration test
  - Success / Failure: exit 0
  - Required Observation:

### Proof Plan

| PO ID | Test Level | Seam | Required Test |
|---|---|---|---|
| PO-S03-A-02 | unit | Test | verify |

### Tasks

- [ ] S03-A-T02 Another task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S03-A:END -->
`;
}

function tasksMdCyclicDag(): string {
  return `# Stage S04 — Cyclic DAG

## Stage Goal

Stage with cyclic dependencies

## Observable Outcomes

- OUT-01 Outcome

## Dependencies

---

## Slice S04-A — Depends on S04-B
<!-- SLICE:S04-A:BEGIN -->

### Goal

First

### Observable Outcome

OUT-01

### Public Seam

Test

### Risk Facts

- none

### Dependencies

- S04-B

### Proof Obligations

- PO-S04-A-01
  - Behavior: verified
  - Public Seam: Test
  - Oracle Source: integration test
  - Success / Failure: exit 0
  - Required Observation:

### Proof Plan

| PO ID | Test Level | Seam | Required Test |
|---|---|---|---|
| PO-S04-A-01 | unit | Test | verify |

### Tasks

- [ ] S04-A-T01 Task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S04-A:END -->

---

## Slice S04-B — Depends on S04-A (cycle)
<!-- SLICE:S04-B:BEGIN -->

### Goal

Second

### Observable Outcome

OUT-01

### Public Seam

Test

### Risk Facts

- none

### Dependencies

- S04-A

### Proof Obligations

- PO-S04-B-01
  - Behavior: verified
  - Public Seam: Test
  - Oracle Source: integration test
  - Success / Failure: exit 0
  - Required Observation:

### Proof Plan

| PO ID | Test Level | Seam | Required Test |
|---|---|---|---|
| PO-S04-B-01 | unit | Test | verify |

### Tasks

- [ ] S04-B-T01 Task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S04-B:END -->
`;
}

// ── Tests ──

describe('validateStage', () => {
  test('passes a valid stage file', () => {
    const tasksPath = writeFixture('tasks.md', validTasksMd());
    const result = validateStage(tasksPath);
    expect(result.valid).toBe(true);
    expect(result.stageId).toBe('S01');
    expect(result.errors).toHaveLength(0);
  });

  test('reports errors when file does not exist', () => {
    const result = validateStage('/nonexistent/tasks.md');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'FILE_ERROR')).toBe(true);
  });

  test('detects missing Oracle Source in Proof Obligations section', () => {
    const tasksPath = writeFixture('tasks.md', tasksMdMissingOracleSource());
    const result = validateStage(tasksPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'MISSING_ORACLE_VALUE')).toBe(true);
  });

  test('detects missing Risk Facts', () => {
    const md = validTasksMd().replace(/- persistent_state\n- external_side_effect\n/, '');
    const tasksPath = writeFixture('tasks.md', md);
    const result = validateStage(tasksPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'MISSING_RISK_FACTS')).toBe(true);
  });

  test('detects duplicate slice IDs', () => {
    const tasksPath = writeFixture('tasks.md', tasksMdDuplicateId());
    const result = validateStage(tasksPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'DUPLICATE_ID')).toBe(true);
  });

  test('detects DAG cycles', () => {
    const tasksPath = writeFixture('tasks.md', tasksMdCyclicDag());
    const result = validateStage(tasksPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'CYCLE_DETECTED')).toBe(true);
  });

  test('detects unclosed slice markers', () => {
    const md = validTasksMd().replace('<!-- SLICE:S01-B:END -->', '');
    const tasksPath = writeFixture('tasks.md', md);
    const result = validateStage(tasksPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'UNCLOSED_SLICE')).toBe(true);
  });

  // ── Risk Facts format validation ──

  test('rejects unknown (non-canonical) Risk Fact values', () => {
    const md = validTasksMd().replace('- persistent_state', '- unknown_bogus_risk');
    const tasksPath = writeFixture('tasks.md', md);
    const result = validateStage(tasksPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'UNKNOWN_RISK_FACT')).toBe(true);
  });

  test('rejects "none" combined with other Risk Facts', () => {
    // S01-B has "- none" — add another risk fact alongside it
    const md = validTasksMd().replace('- none', '- none\n- persistent_state');
    const tasksPath = writeFixture('tasks.md', md);
    const result = validateStage(tasksPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'RISK_FACT_NONE_WITH_OTHERS')).toBe(true);
  });

  test('rejects wrong list marker format (asterisk instead of hyphen) as MISSING_RISK_FACTS', () => {
    // Create a slice using * instead of - for risk facts; extractListItems won't parse them
    const md = validTasksMd()
      .replace('- persistent_state\n- external_side_effect', '* persistent_state\n* external_side_effect');
    const tasksPath = writeFixture('tasks.md', md);
    const result = validateStage(tasksPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'MISSING_RISK_FACTS')).toBe(true);
  });

  // ── Evidence file validation ──

  test('detects missing evidence directory', () => {
    const tasksPath = writeFixture('tasks.md', validTasksMd());
    const result = validateStage(tasksPath, '/nonexistent/evidence-dir');
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'EVIDENCE_DIR_NOT_FOUND')).toBe(true);
  });

  test('detects missing evidence files for slices', () => {
    const tasksPath = writeFixture('tasks.md', validTasksMd());
    // Create an evidence directory with no files
    const evidenceDir = path.join(tmpDir, 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });

    const result = validateStage(tasksPath, evidenceDir);
    expect(result.valid).toBe(false);

    // Both slices should have missing evidence files
    const missingErrors = result.errors.filter(e => e.type === 'MISSING_EVIDENCE_FILE');
    expect(missingErrors.length).toBeGreaterThanOrEqual(2);
    expect(missingErrors.some(e => e.sliceId === 'S01-A')).toBe(true);
    expect(missingErrors.some(e => e.sliceId === 'S01-B')).toBe(true);
  });

  test('detects orphaned evidence files (no matching slice)', () => {
    const tasksPath = writeFixture('tasks.md', validTasksMd());
    const evidenceDir = path.join(tmpDir, 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });

    // Create valid evidence files
    fs.writeFileSync(path.join(evidenceDir, 'S01-A.md'), '# S01-A Evidence', 'utf-8');
    fs.writeFileSync(path.join(evidenceDir, 'S01-B.md'), '# S01-B Evidence', 'utf-8');

    // Create an orphaned file with no matching slice
    fs.writeFileSync(path.join(evidenceDir, 'ORPHAN-X.md'), '# Orphan', 'utf-8');

    const result = validateStage(tasksPath, evidenceDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'ORPHANED_EVIDENCE_FILE')).toBe(true);
    expect(result.errors.some(e => e.sliceId === 'ORPHAN-X')).toBe(true);
  });

  test('passes with all evidence files present', () => {
    const tasksPath = writeFixture('tasks.md', validTasksMd());
    const evidenceDir = path.join(tmpDir, 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });

    // Create all required evidence files
    fs.writeFileSync(path.join(evidenceDir, 'S01-A.md'), '# S01-A Evidence', 'utf-8');
    fs.writeFileSync(path.join(evidenceDir, 'S01-B.md'), '# S01-B Evidence', 'utf-8');

    const result = validateStage(tasksPath, evidenceDir);
    // Should have no evidence-related errors
    const evidenceErrors = result.errors.filter(e =>
      ['MISSING_EVIDENCE_FILE', 'ORPHANED_EVIDENCE_FILE', 'EVIDENCE_DIR_NOT_FOUND',
       'EVIDENCE_DIR_NOT_DIRECTORY'].includes(e.type)
    );
    expect(evidenceErrors).toHaveLength(0);
  });

  test('reports error when evidence path is a file instead of directory', () => {
    const tasksPath = writeFixture('tasks.md', validTasksMd());
    const evidenceFile = path.join(tmpDir, 'evidence-file.md');
    fs.writeFileSync(evidenceFile, '# Not a dir', 'utf-8');

    const result = validateStage(tasksPath, evidenceFile);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'EVIDENCE_DIR_NOT_DIRECTORY')).toBe(true);
  });
});

describe('validateStageWithManifest', () => {
  function makeAndCompile(tasksMd: string): { tasksPath: string; manifest: ReturnType<typeof compileManifest> } {
    const tasksPath = path.join(tmpDir, 'tasks.md');
    fs.writeFileSync(tasksPath, tasksMd, 'utf-8');
    const manifest = compileManifest(tasksPath);
    return { tasksPath, manifest };
  }

  test('passes with valid manifest and matching tasks', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    const result = validateStageWithManifest(manifest, tasksPath);
    // Should pass structural checks; manifest source_path/digest are auto-computed
    // Note: source_path will be the absolute path since compileManifest resolves
    // We check that errors don't contain MANIFEST-specific failures
    const manifestErrors = result.errors.filter(e =>
      ['MANIFEST_SOURCE_PATH_MISMATCH', 'MANIFEST_SOURCE_DIGEST_MISMATCH',
       'SLICE_IN_MANIFEST_NOT_IN_TASKS', 'SLICE_IN_TASKS_NOT_IN_MANIFEST',
       'MISSING_EVIDENCE_PATH', 'INVALID_EVIDENCE_PATH_PATTERN',
       'EVIDENCE_PATH_STAGE_ID_MISMATCH', 'EVIDENCE_PATH_SLICE_ID_MISMATCH',
      ].includes(e.type)
    );
    expect(manifestErrors).toHaveLength(0);
  });

  test('detects manifest source_path mismatch', () => {
    const { manifest } = makeAndCompile(validTasksMd());
    // Override the source_path in the manifest to create a mismatch
    const tampered = { ...manifest, source_path: 'different-tasks.md' };
    const result = validateStageWithManifest(tampered, path.join(tmpDir, 'tasks.md'));
    expect(result.errors.some(e => e.type === 'MANIFEST_SOURCE_PATH_MISMATCH')).toBe(true);
  });

  test('detects manifest source_digest mismatch', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    const tampered = { ...manifest, source_digest: '0000000000000000000000000000000000000000000000000000000000000000' };
    const result = validateStageWithManifest(tampered, tasksPath);
    expect(result.errors.some(e => e.type === 'MANIFEST_SOURCE_DIGEST_MISMATCH')).toBe(true);
  });

  test('detects slice in manifest but not in tasks', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    // Add an extra slice to the manifest that doesn't exist in tasks
    const tampered = {
      ...manifest,
      slices: [
        ...manifest.slices,
        {
          slice_id: 'S01-Z',
          goal: 'Fake slice',
          observable_outcome: 'Fake',
          public_seam: 'Fake',
          dependencies: [],
          proof_obligations: [],
          tasks: [],
          risk_facts: ['none'],
          evidence_path: 'delivery/stages/S01/evidence/S01-Z.md',
          cv_minimum_level: 'lite',
        },
      ],
    };
    const result = validateStageWithManifest(tampered, tasksPath);
    expect(result.errors.some(e => e.type === 'SLICE_IN_MANIFEST_NOT_IN_TASKS')).toBe(true);
  });

  test('detects slice in tasks but not in manifest', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    const tampered = { ...manifest, slices: manifest.slices.slice(0, 1) }; // Remove S01-B
    const result = validateStageWithManifest(tampered, tasksPath);
    expect(result.errors.some(e => e.type === 'SLICE_IN_TASKS_NOT_IN_MANIFEST')).toBe(true);
  });

  test('detects invalid evidence_path pattern', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    const tampered = {
      ...manifest,
      slices: manifest.slices.map((s, i) =>
        i === 0 ? { ...s, evidence_path: 'wrong/path.md' } : s,
      ),
    };
    const result = validateStageWithManifest(tampered, tasksPath);
    expect(result.errors.some(e => e.type === 'INVALID_EVIDENCE_PATH_PATTERN')).toBe(true);
  });

  test('detects evidence_path stage ID mismatch', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    const tampered = {
      ...manifest,
      slices: manifest.slices.map((s, i) =>
        i === 0 ? { ...s, evidence_path: 'delivery/stages/S99/evidence/S01-A.md' } : s,
      ),
    };
    const result = validateStageWithManifest(tampered, tasksPath);
    expect(result.errors.some(e => e.type === 'EVIDENCE_PATH_STAGE_ID_MISMATCH')).toBe(true);
  });

  test('detects evidence_path slice ID mismatch', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    const tampered = {
      ...manifest,
      slices: manifest.slices.map((s, i) =>
        i === 0 ? { ...s, evidence_path: 'delivery/stages/S01/evidence/S99-Z.md' } : s,
      ),
    };
    const result = validateStageWithManifest(tampered, tasksPath);
    expect(result.errors.some(e => e.type === 'EVIDENCE_PATH_SLICE_ID_MISMATCH')).toBe(true);
  });

  // ── Helper to create canonical evidence directory structure ──
  function makeCanonicalEvidenceDir(stageId: string): string {
    const dir = path.join(tmpDir, 'delivery', 'stages', stageId, 'evidence');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  test('detects missing evidence files against manifest evidence_path', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    const evidenceDir = makeCanonicalEvidenceDir(manifest.stage_id);

    // Don't create any evidence files
    const result = validateStageWithManifest(manifest, tasksPath, evidenceDir);
    expect(result.valid).toBe(false);
    const missingErrors = result.errors.filter(e => e.type === 'MISSING_EVIDENCE_FILE');
    // Should report missing files for all manifest slices
    expect(missingErrors.length).toBe(manifest.slices.length);
  });

  test('detects orphaned evidence files against manifest evidence_path', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    const evidenceDir = makeCanonicalEvidenceDir(manifest.stage_id);

    // Create all required evidence files plus an orphan
    for (const slice of manifest.slices) {
      const fileName = path.basename(slice.evidence_path);
      fs.writeFileSync(path.join(evidenceDir, fileName), `# ${slice.slice_id} Evidence`, 'utf-8');
    }
    fs.writeFileSync(path.join(evidenceDir, 'ORPHAN-X.md'), '# Orphan', 'utf-8');

    const result = validateStageWithManifest(manifest, tasksPath, evidenceDir);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'ORPHANED_EVIDENCE_FILE')).toBe(true);
  });

  test('passes with all evidence files present', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    const evidenceDir = makeCanonicalEvidenceDir(manifest.stage_id);

    // Create all required evidence files
    for (const slice of manifest.slices) {
      const fileName = path.basename(slice.evidence_path);
      fs.writeFileSync(path.join(evidenceDir, fileName), `# ${slice.slice_id} Evidence`, 'utf-8');
    }

    const result = validateStageWithManifest(manifest, tasksPath, evidenceDir);
    const evidenceErrors = result.errors.filter(e =>
      ['MISSING_EVIDENCE_FILE', 'ORPHANED_EVIDENCE_FILE', 'EVIDENCE_DIR_NOT_FOUND',
       'EVIDENCE_DIR_NOT_DIRECTORY', 'INVALID_EVIDENCE_PATH_PATTERN',
       'EVIDENCE_PATH_STAGE_ID_MISMATCH', 'EVIDENCE_PATH_SLICE_ID_MISMATCH',
       'MISSING_EVIDENCE_PATH',
      ].includes(e.type)
    );
    expect(evidenceErrors).toHaveLength(0);
  });

  // ── EVIDENCE_DIR_MISMATCH tests ──

  test('detects when evidence-dir does not match canonical stage evidence directory', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    // Use an evidence directory that doesn't match the canonical location
    const nonCanonicalDir = path.join(tmpDir, 'wrong-evidence');
    fs.mkdirSync(nonCanonicalDir, { recursive: true });

    const result = validateStageWithManifest(manifest, tasksPath, nonCanonicalDir);
    expect(result.errors.some(e => e.type === 'EVIDENCE_DIR_MISMATCH')).toBe(true);
  });

  test('passes with canonical evidence directory', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    // Use the canonical evidence directory structure
    const canonicalDir = makeCanonicalEvidenceDir(manifest.stage_id);

    // Create required evidence files
    for (const slice of manifest.slices) {
      const fileName = path.basename(slice.evidence_path);
      fs.writeFileSync(path.join(canonicalDir, fileName), `# ${slice.slice_id} Evidence`, 'utf-8');
    }

    const result = validateStageWithManifest(manifest, tasksPath, canonicalDir);
    const evidenceErrors = result.errors.filter(e =>
      ['MISSING_EVIDENCE_FILE', 'ORPHANED_EVIDENCE_FILE', 'EVIDENCE_DIR_NOT_FOUND',
       'EVIDENCE_DIR_NOT_DIRECTORY', 'EVIDENCE_DIR_MISMATCH',
       'INVALID_EVIDENCE_PATH_PATTERN',
      ].includes(e.type)
    );
    expect(evidenceErrors).toHaveLength(0);
  });

  // ── Round-trip test: compile → validate matches itself ──
  test('compiled manifest validates against its own tasks file', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    const result = validateStageWithManifest(manifest, tasksPath);
    // The compileManifest function sets source_path to the exact path provided,
    // which should match what we pass. No MANIFEST_SOURCE_PATH_MISMATCH expected.
    expect(result.errors.some(e => e.type === 'MANIFEST_SOURCE_PATH_MISMATCH')).toBe(false);
    expect(result.errors.some(e => e.type === 'MANIFEST_SOURCE_DIGEST_MISMATCH')).toBe(false);
    expect(result.errors.some(e => e.type === 'SLICE_IN_MANIFEST_NOT_IN_TASKS')).toBe(false);
    expect(result.errors.some(e => e.type === 'SLICE_IN_TASKS_NOT_IN_MANIFEST')).toBe(false);
  });

  // ── Fail-closed checks ──

  test('detects manifest stage_id mismatch with tasks.md Stage ID', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    // Tamper with stage_id in manifest (S99 vs S01)
    const tampered = { ...manifest, stage_id: 'S99' };
    const result = validateStageWithManifest(tampered, tasksPath);
    expect(result.errors.some(e => e.type === 'STAGE_ID_MISMATCH')).toBe(true);
  });

  test('detects duplicate manifest slice_id', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    // Add a duplicate slice with the same slice_id
    const tampered = {
      ...manifest,
      slices: [
        ...manifest.slices,
        { ...manifest.slices[0] }, // duplicate S01-A
      ],
    };
    const result = validateStageWithManifest(tampered, tasksPath);
    expect(result.errors.some(e => e.type === 'DUPLICATE_MANIFEST_SLICE_ID')).toBe(true);
  });

  test('detects duplicate manifest evidence_path', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    // Add a slice with the same evidence_path
    const tampered = {
      ...manifest,
      slices: [
        ...manifest.slices,
        {
          slice_id: 'S01-Z',
          goal: 'Fake slice',
          observable_outcome: 'Fake',
          public_seam: 'Fake',
          dependencies: [],
          proof_obligations: [],
          tasks: [],
          risk_facts: ['none'],
          evidence_path: manifest.slices[0].evidence_path, // same as first slice
          cv_minimum_level: 'lite',
        },
      ],
    };
    const result = validateStageWithManifest(tampered, tasksPath);
    expect(result.errors.some(e => e.type === 'DUPLICATE_MANIFEST_EVIDENCE_PATH')).toBe(true);
  });

  test('detects both duplicate slice_id and evidence_path simultaneously', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    // Add two duplicates
    const tampered = {
      ...manifest,
      slices: [
        ...manifest.slices,
        { ...manifest.slices[0] }, // duplicate S01-A with same evidence_path
        { ...manifest.slices[manifest.slices.length - 1] }, // duplicate S01-B with same evidence_path
      ],
    };
    const result = validateStageWithManifest(tampered, tasksPath);
    expect(result.errors.some(e => e.type === 'DUPLICATE_MANIFEST_SLICE_ID')).toBe(true);
    expect(result.errors.some(e => e.type === 'DUPLICATE_MANIFEST_EVIDENCE_PATH')).toBe(true);
  });

  // ── Combined test: valid manifest still passes all new checks ──
  test('passes all fail-closed checks with a valid compiled manifest', () => {
    const { tasksPath, manifest } = makeAndCompile(validTasksMd());
    const result = validateStageWithManifest(manifest, tasksPath);
    // None of the fail-closed error types should appear
    const failClosedTypes = [
      'STAGE_ID_MISMATCH',
      'DUPLICATE_MANIFEST_SLICE_ID',
      'DUPLICATE_MANIFEST_EVIDENCE_PATH',
    ];
    for (const type of failClosedTypes) {
      expect(result.errors.some(e => e.type === type)).toBe(false);
    }
  });
});
