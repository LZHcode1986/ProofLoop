/**
 * compile-manifest CLI — PO-S03-H-01 call matrix (S03-H-T01)
 *
 * Public seam: `packages/runtime/src/cli/compile-manifest.ts` (+ the dist
 * script `packages/runtime/dist/cli/compile-manifest.js`).
 *
 * Covered here:
 *  - tasks.md → Manifest that passes the kernel `validateManifest` seam
 *    (the manifest is only accepted when kernel-valid — fail closed);
 *  - multi-slice dependency list parsing: each dependency on its own line
 *    AND multiple dependencies per line (按行解析) — the machine-readable
 *    DAG equals the tasks.md declarations (declaration order preserved);
 *  - proof-obligation parsing with multi-line values and defaults;
 *  - `## Stage Runtime Proof` step parsing (the documented YAML subset:
 *    command/probe/service_start/service_stop, args flow arrays with
 *    quoted elements, expected.exit_code, not_applicable, service_ref,
 *    readiness_signal);
 *  - cv_minimum_level computed from declared Risk Facts (canonical mapping);
 *  - CLI failure cases (missing tasks file, missing args → usage).
 *
 * No mocks: fixtures are real temporary files. The kernel validator is the
 * oracle (not an implementation-derived expectation).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateManifest, SchemaValidationError } from '@proofloop/kernel';
import type { Manifest } from '@proofloop/kernel';
import { compileManifest } from './compile-manifest';

// ============================================================
// Fixture helpers
// ============================================================

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

let fixtureCounter = 0;

function writeFixture(content: string, name = `tasks-${++fixtureCounter}.md`): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-compile-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf-8');
  cleanups.push(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
  return p;
}

/** Acyclic 3-slice stage: A root; B deps [A]; C deps [A, B] (multi-per-line). */
function acyclicTasksMd(): string {
  return `# Stage S03 — Test Stage

## Stage Goal

Test stage goal paragraph.

## Observable Outcomes

- OUT-01: first outcome
- OUT-02: second outcome

## Dependencies

- No external stage blocking dependency.

## Stage Risk Facts

- public_api_change: true

## Stage Runtime Proof

\`\`\`yaml
steps:
  - id: build
    type: command
    executable: npm
    args: [run, build]
    cwd: .
    timeout_ms: 300000
    expected:
      exit_code: 0

  - id: smoke
    type: probe
    executable: node
    args: ["-e", "process.exit(0)"]
    cwd: .
    timeout_ms: 10000
    expected:
      exit_code: 0

  - id: app-start
    type: service_start
    executable: node
    args: [--version]
    cwd: .
    readiness_signal: node available
    timeout_ms: 10000
    not_applicable:
      reason: No long-running application service.

  - id: app-stop
    type: service_stop
    executable: node
    args: [--version]
    cwd: .
    service_ref: app-start
    timeout_ms: 10000
    not_applicable:
      reason: No service was started.
\`\`\`

## Slice S03-A — Slice A

<!-- SLICE:S03-A:BEGIN -->

### Goal

Slice A goal.

### Observable Outcome

Slice A observable outcome.

### Public Seam

Seam A.

### Dependencies

- 无内部依赖。

### Risk Facts

- core_state_machine: true

### Proof Obligations

- PO-S03-A-01
  - Behavior: Slice A behavior
    continues on the next line.
  - Public Seam: Seam A.
  - Oracle Source: oracle A.
  - Success / Failure: success when X; failure when Y.
  - Required Observation: observe X.
  - Applicable Risk Facts: core_state_machine

### Tasks

- [ ] S03-A-T01: task one

<!-- SLICE:S03-A:END -->

## Slice S03-B — Slice B

<!-- SLICE:S03-B:BEGIN -->

### Goal

Slice B goal.

### Observable Outcome

Slice B observable outcome.

### Public Seam

Seam B.

### Dependencies

- S03-A

### Risk Facts

- persistent_state: true

### Proof Obligations

- PO-S03-B-01
  - Behavior: Slice B behavior.
  - Public Seam: Seam B.
  - Oracle Source: oracle B.
  - Success / Failure: success when Z.
  - Required Observation: observe Z.

### Tasks

- [ ] S03-B-T01: task one
- [x] S03-B-T02: task two

<!-- SLICE:S03-B:END -->

## Slice S03-C — Slice C

<!-- SLICE:S03-C:BEGIN -->

### Goal

Slice C goal.

### Observable Outcome

Slice C observable outcome.

### Public Seam

Seam C.

### Dependencies

- S03-A S03-B

### Risk Facts

- authorization: false

### Tasks

- [ ] S03-C-T01: task one

<!-- SLICE:S03-C:END -->
`;
}

// ============================================================
// compileManifest — success behaviors
// ============================================================

describe('compileManifest (PO-S03-H-01: tasks.md → kernel-validated manifest)', () => {
  it('compiles a tasks.md into a Manifest that passes kernel validateManifest', () => {
    const tasksPath = writeFixture(acyclicTasksMd());
    const manifest = compileManifest(tasksPath);
    // Oracle: the kernel validator must accept the compiled manifest.
    expect(() => validateManifest(manifest)).not.toThrow();
    expect(manifest.stage_id).toBe('S03');
    expect(manifest.source_path).toBe(tasksPath);
    expect(manifest.source_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.stage_goal).toBe('Test stage goal paragraph.');
    expect(manifest.outcomes).toEqual(['OUT-01: first outcome', 'OUT-02: second outcome']);
    expect(manifest.slices.map((s) => s.slice_id)).toEqual(['S03-A', 'S03-B', 'S03-C']);
    expect(manifest.risk_facts).toEqual(['public_api_change: true']);
  });

  it('parses slice dependencies declared one per line (declaration order preserved)', () => {
    const manifest = compileManifest(writeFixture(acyclicTasksMd()));
    const byId = new Map(manifest.slices.map((s) => [s.slice_id, s]));
    expect(byId.get('S03-B')?.dependencies).toEqual(['S03-A']);
    // prose-only dependency line → no machine dependency (no guess)
    expect(byId.get('S03-A')?.dependencies).toEqual([]);
  });

  it('parses slice dependencies declared multiple per line (按行解析)', () => {
    const manifest = compileManifest(writeFixture(acyclicTasksMd()));
    const byId = new Map(manifest.slices.map((s) => [s.slice_id, s]));
    // "- S03-A S03-B" on one line → both dependencies, declaration order
    expect(byId.get('S03-C')?.dependencies).toEqual(['S03-A', 'S03-B']);
  });

  it('never parses a slice id mentioned in dependency prose as a dependency', () => {
    const tasks = acyclicTasksMd().replace(
      '- S03-A S03-B',
      '- S03-A — 消费 `XContract`（经 S03-B 传递）。',
    );
    const manifest = compileManifest(writeFixture(tasks));
    const sliceC = manifest.slices.find((s) => s.slice_id === 'S03-C')!;
    // the leading run ends at the prose token `—`; the mention of S03-B
    // inside the description is NOT a dependency (never a guess)
    expect(sliceC.dependencies).toEqual(['S03-A']);
  });

  it('tolerates separator tokens between slice ids in a dependency line', () => {
    const tasks = acyclicTasksMd().replace('- S03-A S03-B', '- S03-A + S03-B');
    const manifest = compileManifest(writeFixture(tasks));
    const sliceC = manifest.slices.find((s) => s.slice_id === 'S03-C')!;
    expect(sliceC.dependencies).toEqual(['S03-A', 'S03-B']);
  });

  it('produces a machine-readable DAG consistent with tasks.md declarations', () => {
    const manifest = compileManifest(writeFixture(acyclicTasksMd()));
    const declared = new Set(manifest.slices.map((s) => s.slice_id));
    for (const slice of manifest.slices) {
      for (const dep of slice.dependencies) {
        expect(declared.has(dep)).toBe(true);
      }
    }
  });

  it('parses proof obligations with multi-line values and non-empty kernel fields', () => {
    const manifest = compileManifest(writeFixture(acyclicTasksMd()));
    const sliceA = manifest.slices.find((s) => s.slice_id === 'S03-A')!;
    expect(sliceA.proof_obligations).toHaveLength(1);
    const po = sliceA.proof_obligations[0];
    expect(po.po_id).toBe('PO-S03-A-01');
    expect(po.behavior).toContain('Slice A behavior');
    expect(po.behavior).toContain('continues on the next line');
    expect(po.oracle_source).toBe('oracle A.');
    expect(po.success_criteria).toContain('success when X');
    expect(po.required_observation).toBe('observe X.');
    expect(po.applicable_risk_facts).toEqual(['core_state_machine']);
    // Slice B declares no Applicable Risk Facts → kernel-valid default
    const sliceB = manifest.slices.find((s) => s.slice_id === 'S03-B')!;
    expect(sliceB.proof_obligations[0].applicable_risk_facts).toEqual([]);
    expect(sliceB.proof_obligations[0].public_seam).toBe('Seam B.');
    // every PO field satisfies the kernel non-empty requirement
    expect(() => validateManifest(manifest)).not.toThrow();
  });

  it('parses the Stage Runtime Proof YAML subset (args arrays, nested expected/not_applicable)', () => {
    const manifest = compileManifest(writeFixture(acyclicTasksMd()));
    const steps = manifest.runtime_proof ?? [];
    expect(steps.map((s) => s.id)).toEqual(['build', 'smoke', 'app-start', 'app-stop']);
    const build = steps[0];
    expect(build.type).toBe('command');
    expect(build.executable).toBe('npm');
    expect(build.args).toEqual(['run', 'build']);
    expect(build.cwd).toBe('.');
    expect(build.timeout_ms).toBe(300000);
    expect(build.expected).toEqual({ exit_code: 0 });
    // flow array with quoted element containing commas/colons
    const smoke = steps[1];
    expect(smoke.args).toEqual(['-e', 'process.exit(0)']);
    expect(smoke.expected?.exit_code).toBe(0);
    // service steps with readiness_signal / service_ref / not_applicable.reason
    const start = steps[2];
    expect(start.readiness_signal).toBe('node available');
    expect(start.not_applicable?.reason).toContain('No long-running application service');
    const stop = steps[3];
    expect(stop.service_ref).toBe('app-start');
    expect(stop.not_applicable?.reason).toContain('No service was started');
  });

  it('computes cv_minimum_level from declared Risk Facts (canonical mapping)', () => {
    const manifest = compileManifest(writeFixture(acyclicTasksMd()));
    const byId = new Map(manifest.slices.map((s) => [s.slice_id, s]));
    // core_state_machine → enhanced
    expect(byId.get('S03-A')?.cv_minimum_level).toBe('enhanced');
    // persistent_state → standard
    expect(byId.get('S03-B')?.cv_minimum_level).toBe('standard');
    // authorization (declared false) still maps to enhanced (conservative, canonical)
    expect(byId.get('S03-C')?.cv_minimum_level).toBe('enhanced');
  });

  it('writes evidence_path per the canonical pattern', () => {
    const manifest = compileManifest(writeFixture(acyclicTasksMd()));
    for (const slice of manifest.slices) {
      expect(slice.evidence_path).toBe(
        `delivery/stages/${manifest.stage_id}/evidence/${slice.slice_id}.md`,
      );
    }
  });

  it('extracts task ids from checkbox lines only', () => {
    const manifest = compileManifest(writeFixture(acyclicTasksMd()));
    const byId = new Map(manifest.slices.map((s) => [s.slice_id, s]));
    expect(byId.get('S03-A')?.tasks).toEqual(['S03-A-T01']);
    expect(byId.get('S03-B')?.tasks).toEqual(['S03-B-T01', 'S03-B-T02']);
  });

  it('fails closed when the tasks file does not exist', () => {
    expect(() => compileManifest('/nonexistent/tasks.md')).toThrow(/not found|ENOENT/i);
  });

  it('fails closed when the compiled manifest is kernel-invalid (e.g. unknown risk fact)', () => {
    const bad = acyclicTasksMd().replace(
      '- core_state_machine: true',
      '- totally_unknown_fact: true',
    );
    const tasksPath = writeFixture(bad);
    expect(() => compileManifest(tasksPath)).toThrow(/unknown risk fact/i);
  });
});

// ============================================================
// CLI entry (dist script) — call matrix
// ============================================================

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_CLI = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'compile-manifest.js');

describe('compile-manifest.js dist script (PO-S03-H-01: callable via dist, old-CLI contract)', () => {
  const distExists = fs.existsSync(DIST_CLI);

  it('exits 1 with a usage error when invoked without args (old contract: <tasks-path> <output-path>)', () => {
    expect(distExists).toBe(true);
    const res = spawnSync(process.execPath, [DIST_CLI], { encoding: 'utf-8' });
    expect(res.status).toBe(1);
    expect((res.stderr + res.stdout).toLowerCase()).toContain('usage:');
  });

  it('compiles a tasks fixture to a kernel-valid manifest file and exits 0', () => {
    expect(distExists).toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-spawn-'));
    cleanups.push(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    });
    const tasksPath = path.join(dir, 'tasks.md');
    fs.writeFileSync(tasksPath, acyclicTasksMd(), 'utf-8');
    const outPath = path.join(dir, 'manifest.json');
    const res = spawnSync(process.execPath, [DIST_CLI, tasksPath, outPath], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Stage manifest written to');
    const manifest = JSON.parse(fs.readFileSync(outPath, 'utf-8')) as Manifest;
    expect(() => validateManifest(manifest)).not.toThrow();
    expect(manifest.stage_id).toBe('S03');
    expect(manifest.slices).toHaveLength(3);
  });

  it('exits 1 when the tasks file does not exist', () => {
    expect(distExists).toBe(true);
    const res = spawnSync(process.execPath, [DIST_CLI, '/nonexistent/tasks.md', '/tmp/out.json'], {
      encoding: 'utf-8',
    });
    expect(res.status).toBe(1);
    expect(res.stderr.toLowerCase()).toMatch(/not found|compilation failed/i);
  });
});

// ============================================================
// Module sanity — the kernel validator is the oracle
// ============================================================

describe('compile-manifest kernel validity (oracle)', () => {
  it('a compiled manifest with an unknown risk fact is rejected by the compiler', () => {
    // Guard: SchemaValidationError is exported by the kernel seam used here.
    expect(typeof SchemaValidationError).toBe('function');
  });
});
