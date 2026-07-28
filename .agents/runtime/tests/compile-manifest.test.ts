import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

function minimalTasksMd(sliceId: string, riskFacts: string[] = ['none']): string {
  return `# Stage S01 — Test

## Stage Goal

Test stage.

## Observable Outcomes

- OUT-01 First outcome

## Dependencies

---

## Slice ${sliceId} — Test Slice
<!-- SLICE:${sliceId}:BEGIN -->

### Goal

Test slice goal.

### Observable Outcome

OUT-01 realized.

### Public Seam

Test seam.

### Risk Facts

${riskFacts.map(r => `- ${r}`).join('\n')}

### Dependencies

### Proof Obligations

- PO-${sliceId}-01
  - Behavior: verified
  - Public Seam: Test seam
  - Oracle Source: integration test
  - Success / Failure: exit 0
  - Required Observation: N/A
  - Applicable Risk Facts:

### Proof Plan

| PO ID | Test Level | Seam | Required Test |
|---|---|---|---|
| PO-${sliceId}-01 | unit | Test seam | verify behavior |

### Tasks

- [ ] ${sliceId}-T01 Do the task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:${sliceId}:END -->
`;
}

// ── Helpers for Runtime Proof tests ──

function minimalTasksMdWithYamlSteps(yamlSteps: string): string {
  return `# Stage S10 — Runtime Proof Validation

## Stage Goal

Validate runtime proof constraints.

## Observable Outcomes

- OUT-01 Outcome

## Dependencies

---

## Slice S10-A — Test
<!-- SLICE:S10-A:BEGIN -->

### Goal

Test.

### Observable Outcome

OUT-01.

### Public Seam

Test.

### Risk Facts

- none

### Dependencies

### Proof Obligations

- PO-S10-A-01
  - Behavior: verified
  - Public Seam: Test
  - Oracle Source: unit test
  - Success / Failure: exit 0
  - Required Observation:

### Proof Plan

| PO ID | Test Level | Seam | Required Test |
|---|---|---|---|
| PO-S10-A-01 | unit | Test | verify |

### Tasks

- [ ] S10-A-T01 Task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S10-A:END -->

---

## Stage Runtime Proof

\`\`\`yaml
${yamlSteps}
\`\`\`
`;
}

// ── Tests ──

describe('compileManifest', () => {
  test('first PO appears in manifest slices', () => {
    const md = minimalTasksMd('S01-A', ['none']);
    const tasksPath = writeFixture('tasks.md', md);
    const manifest = compileManifest(tasksPath);

    expect(manifest.stage_id).toBe('S01');

    // Check the first (and only) slice
    expect(manifest.slices).toHaveLength(1);
    const slice = manifest.slices[0];
    expect(slice.slice_id).toBe('S01-A');

    // Check the first PO is present
    expect(slice.proof_obligations).toHaveLength(1);
    const po = slice.proof_obligations[0];
    expect(po.po_id).toBe('PO-S01-A-01');
    expect(po.behavior).toBe('verified');
    expect(po.oracle_source).toBe('integration test');
    expect(po.success_criteria).toBe('exit 0');
  });

  test('YAML Runtime Proof is parsed correctly with type and service_ref', () => {
    const md = `# Stage S02 — Runtime Proof

## Stage Goal

Stage with YAML runtime proof.

## Observable Outcomes

- OUT-01 Outcome

## Dependencies

---

## Slice S02-A — Test
<!-- SLICE:S02-A:BEGIN -->

### Goal

Goal.

### Observable Outcome

OUT-01.

### Public Seam

Test.

### Risk Facts

- none

### Dependencies

### Proof Obligations

- PO-S02-A-01
  - Behavior: verified
  - Public Seam: Test
  - Oracle Source: unit test
  - Success / Failure: exit 0
  - Required Observation:

### Proof Plan

| PO ID | Test Level | Seam | Required Test |
|---|---|---|---|
| PO-S02-A-01 | unit | Test | verify |

### Tasks

- [ ] S02-A-T01 Task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S02-A:END -->

---

## Stage Runtime Proof

\`\`\`yaml
steps:
  - id: start-server
    type: service_start
    executable: node
    args:
      - -e
      - "const http=require('http'); const s=http.createServer((_,res)=>{res.end('ok')}); s.listen(0,()=>{console.log('ready')})"
    timeout_ms: 10000
    readiness_signal: ready
  - id: probe-server
    type: probe
    executable: curl
    args:
      - http://localhost:0
    timeout_ms: 5000
    expected:
      exit_code: 0
  - id: stop-server
    type: service_stop
    executable: node
    args: []
    service_ref: start-server
    timeout_ms: 5000
\`\`\`
`;

    const tasksPath = writeFixture('tasks.md', md);
    const manifest = compileManifest(tasksPath);

    // Verify runtime proof steps
    expect(manifest.runtime_proof).toHaveLength(3);

    // Step 1: service_start with readiness_signal
    expect(manifest.runtime_proof[0].id).toBe('start-server');
    expect(manifest.runtime_proof[0].type).toBe('service_start');
    expect(manifest.runtime_proof[0].readiness_signal).toBe('ready');

    // Step 2: probe with expected
    expect(manifest.runtime_proof[1].id).toBe('probe-server');
    expect(manifest.runtime_proof[1].type).toBe('probe');
    expect(manifest.runtime_proof[1].expected?.exit_code).toBe(0);

    // Step 3: service_stop
    expect(manifest.runtime_proof[2].id).toBe('stop-server');
    expect(manifest.runtime_proof[2].type).toBe('service_stop');
  });

  test('invalid risk fact causes compilation error', () => {
    const md = minimalTasksMd('S01-A', ['bogus_invalid_risk']);
    const tasksPath = writeFixture('tasks.md', md);

    // computeScvLevel is called during compilation and throws on unknown risk facts
    expect(() => compileManifest(tasksPath)).toThrow(/Unknown risk fact/);
  });

  test('Stage Risk Facts are separate from Slice Risk Facts', () => {
    const md = `# Stage S03 — Separated Risk Facts

## Stage Goal

Stage with both stage-level and slice-level risk facts.

## Observable Outcomes

- OUT-01 Outcome

## Dependencies

## Stage Risk Facts

- STAGE_RF_global

---

## Slice S03-A — First
<!-- SLICE:S03-A:BEGIN -->

### Goal

First.

### Observable Outcome

OUT-01.

### Public Seam

Test.

### Risk Facts

- authorization

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

## Slice S03-B — Second
<!-- SLICE:S03-B:BEGIN -->

### Goal

Second.

### Observable Outcome

OUT-01.

### Public Seam

Test.

### Risk Facts

- persistent_state

### Dependencies

- S03-A

### Proof Obligations

- PO-S03-B-01
  - Behavior: verified
  - Public Seam: Test
  - Oracle Source: integration test
  - Success / Failure: exit 0
  - Required Observation:

### Proof Plan

| PO ID | Test Level | Seam | Required Test |
|---|---|---|---|
| PO-S03-B-01 | unit | Test | verify |

### Tasks

- [ ] S03-B-T01 Task

### Task → Slice Closure

Done.

### Worker Status

- Status: planned

<!-- SLICE:S03-B:END -->
`;
    const tasksPath = writeFixture('tasks.md', md);
    const manifest = compileManifest(tasksPath);

    // Stage-level risk facts
    expect(manifest.risk_facts).toHaveLength(1);
    expect(manifest.risk_facts[0]).toBe('STAGE_RF_global');

    // Slice-level risk facts
    const sliceA = manifest.slices.find(s => s.slice_id === 'S03-A')!;
    expect(sliceA.risk_facts).toEqual(['authorization']);

    const sliceB = manifest.slices.find(s => s.slice_id === 'S03-B')!;
    expect(sliceB.risk_facts).toEqual(['persistent_state']);

    // SCV levels derived from slice risk facts
    expect(sliceA.scv_minimum_level).toBe('enhanced');
    expect(sliceB.scv_minimum_level).toBe('standard');
  });

  // ── Runtime Proof validation ──

  test('duplicate Runtime Proof step IDs throw error', () => {
    const yaml = `
steps:
  - id: step-one
    executable: echo
    args: [hello]
  - id: step-one
    executable: echo
    args: [world]
`;
    const md = minimalTasksMdWithYamlSteps(yaml);
    const tasksPath = writeFixture('tasks.md', md);
    expect(() => compileManifest(tasksPath)).toThrow(/Duplicate step ID/);
  });

  test('service_start without matching service_stop throws error', () => {
    const yaml = `
steps:
  - id: start-svc
    type: service_start
    executable: node
    args: ['-e', 'setInterval(()=>{},60000)']
    timeout_ms: 5000
  - id: probe
    type: probe
    executable: echo
    args: [ok]
`;
    const md = minimalTasksMdWithYamlSteps(yaml);
    const tasksPath = writeFixture('tasks.md', md);
    expect(() => compileManifest(tasksPath)).toThrow(
      /service_start "start-svc" has no matching service_stop/,
    );
  });

  test('service_stop referencing non-existent service_start throws error', () => {
    const yaml = `
steps:
  - id: stop-svc
    type: service_stop
    executable: node
    args: []
    service_ref: no-such-service
`;
    const md = minimalTasksMdWithYamlSteps(yaml);
    const tasksPath = writeFixture('tasks.md', md);
    expect(() => compileManifest(tasksPath)).toThrow(
      /service_stop "stop-svc" references non-existent service_start "no-such-service"/,
    );
  });
});
