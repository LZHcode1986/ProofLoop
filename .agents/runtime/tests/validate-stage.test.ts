import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateStage } from '../src/validate-stage.js';

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

- RF-01 First risk
- RF-02 Second risk

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

- RF-03 Third risk

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

- RF-01 Risk fact

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

- RF-01 Risk

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

- RF-02 Risk

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

- RF-01 Risk

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

- RF-02 Risk

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
    const md = validTasksMd().replace(/- RF-01 First risk\n- RF-02 Second risk\n/, '');
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
});
