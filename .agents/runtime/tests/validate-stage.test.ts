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

## Slice S1 — First Slice
<!-- SLICE:S1:BEGIN -->

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

### Proof Plan

Oracle source: integration test
PO-S01-A-01: verify behavior via test oracle

### Tasks

- [ ] S1-T1 Do the first task
- [ ] S1-T2 Do the second task

### Task → Slice Closure

All tasks complete the slice goal.

### Worker Status

- Status: planned

<!-- SLICE:S1:END -->

---

## Slice S2 — Second Slice
<!-- SLICE:S2:BEGIN -->

### Goal

Second slice goal

### Observable Outcome

OUT-02 realized

### Public Seam

Test seam

### Risk Facts

- RF-03 Third risk

### Dependencies

- S1

### Proof Plan

Oracle source: snapshot comparison
PO-S01-A-02: verify behavior via test oracle

### Tasks

- [ ] S2-T1 Do the third task

### Task → Slice Closure

Task completes the slice goal.

### Worker Status

- Status: planned

<!-- SLICE:S2:END -->

---

## Slice → Stage Closure
`;
}

function tasksMdMissingPo(): string {
  return `# Stage S02 — Missing PO

## Stage Goal

Stage with a slice that has PO IDs but no Proof Plan section

## Observable Outcomes

- OUT-01 Outcome

## Dependencies

---

## Slice S1 — Missing Proof Plan
<!-- SLICE:S1:BEGIN -->

### Goal

Solo goal

### Observable Outcome

OUT-01 realized

### Public Seam

Test seam

### Risk Facts

- RF-01 Risk fact

### Dependencies

### Tasks

- [ ] S1-T1 Do something (PO-S02-A-01 should be defined but Proof Plan is missing)

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S1:END -->
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

## Slice S1 — First
<!-- SLICE:S1:BEGIN -->

### Goal

First

### Observable Outcome

OUT-01

### Public Seam

Test

### Risk Facts

- RF-01 Risk

### Dependencies

### Proof Plan

Oracle: system behavior check
PO-S03-A-01: verify via oracle

### Tasks

- [ ] S1-T1 Task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S1:END -->

---

## Slice S1 — Second (duplicate ID)
<!-- SLICE:S1:BEGIN -->

### Goal

Second (should not exist)

### Observable Outcome

OUT-01

### Public Seam

Test

### Risk Facts

- RF-02 Risk

### Dependencies

### Proof Plan

Oracle: system behavior check
PO-S03-A-02: verify via oracle

### Tasks

- [ ] S1-T2 Another task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S1:END -->
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

## Slice S1 — Depends on S2
<!-- SLICE:S1:BEGIN -->

### Goal

First

### Observable Outcome

OUT-01

### Public Seam

Test

### Risk Facts

- RF-01 Risk

### Dependencies

- S2

### Proof Plan

Oracle: behavior check
PO-S04-A-01: verify via oracle

### Tasks

- [ ] S1-T1 Task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S1:END -->

---

## Slice S2 — Depends on S1 (cycle)
<!-- SLICE:S2:BEGIN -->

### Goal

Second

### Observable Outcome

OUT-01

### Public Seam

Test

### Risk Facts

- RF-02 Risk

### Dependencies

- S1

### Proof Plan

Oracle: behavior check
PO-S04-A-02: verify via oracle

### Tasks

- [ ] S2-T1 Task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S2:END -->
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

  test('detects missing PO (no Proof Plan section when POs are referenced)', () => {
    const tasksPath = writeFixture('tasks.md', tasksMdMissingPo());
    const result = validateStage(tasksPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'MISSING_ORACLE_SOURCE')).toBe(true);
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
    const md = validTasksMd().replace('<!-- SLICE:S2:END -->', '');
    const tasksPath = writeFixture('tasks.md', md);
    const result = validateStage(tasksPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.type === 'UNCLOSED_SLICE')).toBe(true);
  });
});
