/**
 * validate-stage CLI — PO-S03-H-01 call matrix (S03-H-T01)
 *
 * Public seam: `packages/runtime/src/cli/validate-stage.ts` (+ dist script).
 * Planner mechanical gatekeeper over a Stage tasks.md (and optionally a
 * previously compiled manifest + an evidence directory), old-CLI contract:
 *
 *   node packages/runtime/dist/cli/validate-stage.js <tasks.md> <manifest.json> [evidence-dir]
 *
 * Gatekeeper checks:
 *  - the tasks.md compiles into a kernel-`validateManifest`-valid Manifest;
 *  - SLICE:BEGIN/END marker structure (unclosed / orphaned regions);
 *  - id uniqueness (slice / PO / task);
 *  - dependency DAG: no cycles AND every declared dependency exists in the
 *    Stage closure (Referencing Slices appear in the Stage Closure);
 *  - PO fields declared-but-empty (Behavior / Oracle Source / Success /
 *    Failure / Required Observation);
 *  - every task id occurrence belongs to a slice Tasks section;
 *  - optional compiled-manifest cross-check (stage_id, slice set, evidence
 *    paths) and optional evidence-dir existence checks.
 *
 * Output: JSON `{ valid, stage_id, errors: [{ type, message, sliceId? }] }`
 * on stdout; exit 0 valid / 1 invalid.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Manifest } from '@proofloop/kernel';
import { validateStage, type ValidateStageResult } from './validate-stage';

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

interface TasksFx {
  readonly dir: string;
  writeTasks(content: string, name?: string): string;
  writeManifest(manifest: Manifest, name?: string): string;
  writeEvidence(sliceId: string, name?: string): string;
  cleanup(): void;
}

function makeFx(): TasksFx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-validate-'));
  const fx: TasksFx = {
    dir,
    writeTasks: (content, name = `tasks-${++fixtureCounter}.md`) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, content, 'utf-8');
      return p;
    },
    writeManifest: (manifest, name = 'manifest.json') => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, JSON.stringify(manifest, null, 2), 'utf-8');
      return p;
    },
    writeEvidence: (sliceId, name) => {
      const p = path.join(dir, name ?? `${sliceId}.md`);
      fs.writeFileSync(p, `# Slice ${sliceId} Evidence\n`, 'utf-8');
      return p;
    },
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

/** Acyclic 2-slice stage: A root; B deps [A]. */
function validTasksMd(): string {
  return `# Stage S03 — Test Stage

## Stage Goal

Test stage goal paragraph.

## Observable Outcomes

- OUT-01: first outcome

## Dependencies

- No external stage blocking dependency.

## Stage Risk Facts

- public_api_change: true

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
  - Behavior: Slice A behavior.
  - Public Seam: Seam A.
  - Oracle Source: oracle A.
  - Success / Failure: success when X; failure when Y.
  - Required Observation: observe X.

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
`;
}

function compiledManifest(): Manifest {
  return {
    stage_id: 'S03',
    source_path: 'delivery/stages/S03/tasks.md',
    source_digest: 'a'.repeat(64),
    stage_goal: 'Test stage goal paragraph.',
    outcomes: ['OUT-01: first outcome'],
    slices: [
      {
        slice_id: 'S03-A',
        goal: 'Slice A goal.',
        observable_outcome: 'Slice A observable outcome.',
        public_seam: 'Seam A.',
        dependencies: [],
        proof_obligations: [
          {
            po_id: 'PO-S03-A-01',
            behavior: 'Slice A behavior.',
            public_seam: 'Seam A.',
            oracle_source: 'oracle A.',
            success_criteria: 'success when X; failure when Y.',
            required_observation: 'observe X.',
            applicable_risk_facts: [],
          },
        ],
        tasks: ['S03-A-T01'],
        risk_facts: ['core_state_machine: true'],
        evidence_path: 'delivery/stages/S03/evidence/S03-A.md',
        cv_minimum_level: 'enhanced',
      },
      {
        slice_id: 'S03-B',
        goal: 'Slice B goal.',
        observable_outcome: 'Slice B observable outcome.',
        public_seam: 'Seam B.',
        dependencies: ['S03-A'],
        proof_obligations: [
          {
            po_id: 'PO-S03-B-01',
            behavior: 'Slice B behavior.',
            public_seam: 'Seam B.',
            oracle_source: 'oracle B.',
            success_criteria: 'success when Z.',
            required_observation: 'observe Z.',
            applicable_risk_facts: [],
          },
        ],
        tasks: ['S03-B-T01', 'S03-B-T02'],
        risk_facts: ['persistent_state: true'],
        evidence_path: 'delivery/stages/S03/evidence/S03-B.md',
        cv_minimum_level: 'standard',
      },
    ],
    dependencies: [],
    risk_facts: ['public_api_change: true'],
  };
}

function errorTypes(result: ValidateStageResult): string[] {
  return result.errors.map((e) => e.type);
}

// ============================================================
// validateStage — success behaviors
// ============================================================

describe('validateStage (Planner mechanical gatekeeper, PO-S03-H-01)', () => {
  it('passes a structurally valid acyclic stage', () => {
    const fx = makeFx();
    const tasksPath = fx.writeTasks(validTasksMd());
    const result = validateStage(tasksPath);
    expect(result.valid).toBe(true);
    expect(result.stage_id).toBe('S03');
    expect(result.errors).toEqual([]);
  });

  it('passes when the provided compiled manifest is consistent with the tasks', () => {
    const fx = makeFx();
    const tasksPath = fx.writeTasks(validTasksMd());
    const manifestPath = fx.writeManifest(compiledManifest());
    const result = validateStage(tasksPath, manifestPath);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('reports a compile failure as an error (unclosed slice region)', () => {
    const fx = makeFx();
    const bad = validTasksMd().replace('<!-- SLICE:S03-A:END -->', '');
    const result = validateStage(fx.writeTasks(bad));
    expect(result.valid).toBe(false);
    expect(errorTypes(result)).toContain('UNCLOSED_SLICE');
  });

  it('rejects duplicate slice ids', () => {
    const fx = makeFx();
    const dup = validTasksMd() + `
## Slice S03-A — Duplicate Slice

<!-- SLICE:S03-A:BEGIN -->

### Goal

Duplicate A.

### Observable Outcome

Duplicate A outcome.

### Public Seam

Seam A.

### Risk Facts

- persistent_state: true

### Tasks

- [ ] S03-A-T99: dup task

<!-- SLICE:S03-A:END -->
`;
    const result = validateStage(fx.writeTasks(dup));
    expect(result.valid).toBe(false);
    expect(errorTypes(result)).toContain('DUPLICATE_ID');
  });

  it('rejects duplicate PO ids within PO sections', () => {
    const fx = makeFx();
    const dup = validTasksMd().replace(
      '- PO-S03-B-01\n  - Behavior: Slice B behavior.',
      '- PO-S03-B-01\n  - Behavior: Slice B behavior.\n  - Oracle Source: o2.\n- PO-S03-B-01\n  - Behavior: dup behavior.\n  - Oracle Source: o3.',
    );
    const result = validateStage(fx.writeTasks(dup));
    expect(result.valid).toBe(false);
    expect(errorTypes(result)).toContain('DUPLICATE_ID');
  });

  it('rejects a dependency cycle (CYCLE_DETECTED)', () => {
    const fx = makeFx();
    const cyclic = validTasksMd().replace(
      '### Dependencies\n\n- S03-A',
      '### Dependencies\n\n- S03-A',
    );
    // make B depend on A and A depend on B (introduce cycle via A section)
    const cyclic2 = cyclic.replace(
      '### Dependencies\n\n- 无内部依赖。',
      '### Dependencies\n\n- S03-B',
    );
    const result = validateStage(fx.writeTasks(cyclic2));
    expect(result.valid).toBe(false);
    expect(errorTypes(result)).toContain('CYCLE_DETECTED');
  });

  it('rejects a dependency on a slice absent from the Stage closure', () => {
    const fx = makeFx();
    const undeclared = validTasksMd().replace('- S03-A\n\n### Risk Facts', '- S03-Z\n\n### Risk Facts');
    const result = validateStage(fx.writeTasks(undeclared));
    expect(result.valid).toBe(false);
    expect(errorTypes(result)).toContain('UNDECLARED_DEPENDENCY');
  });

  it('rejects a PO whose Oracle Source is declared but empty', () => {
    const fx = makeFx();
    const emptyPo = validTasksMd().replace('- Oracle Source: oracle A.', '- Oracle Source:');
    const result = validateStage(fx.writeTasks(emptyPo));
    expect(result.valid).toBe(false);
    expect(errorTypes(result)).toContain('MISSING_ORACLE_VALUE');
  });

  it('rejects a task id mentioned outside any slice Tasks section', () => {
    const fx = makeFx();
    const stray = validTasksMd().replace(
      '## Slice S03-A — Slice A',
      '## Slice S03-A — Slice A\n\n(reference to S03-A-T99 outside the Tasks section)',
    );
    const result = validateStage(fx.writeTasks(stray));
    expect(result.valid).toBe(false);
    expect(errorTypes(result)).toContain('TASK_OUTSIDE_SLICE');
  });

  it('rejects a provided manifest whose stage_id mismatches the tasks.md', () => {
    const fx = makeFx();
    const manifest = compiledManifest();
    manifest.stage_id = 'S99';
    const result = validateStage(fx.writeTasks(validTasksMd()), fx.writeManifest(manifest));
    expect(result.valid).toBe(false);
    expect(errorTypes(result)).toContain('STAGE_ID_MISMATCH');
  });

  it('rejects a provided manifest whose slice set differs from the compiled one', () => {
    const fx = makeFx();
    const manifest = compiledManifest();
    manifest.slices = manifest.slices.slice(0, 1);
    const result = validateStage(fx.writeTasks(validTasksMd()), fx.writeManifest(manifest));
    expect(result.valid).toBe(false);
    expect(errorTypes(result)).toContain('SLICE_SET_MISMATCH');
  });

  it('reports missing / orphaned evidence files when an evidence dir is given', () => {
    const fx = makeFx();
    const evidenceDir = path.join(fx.dir, 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'S03-A.md'), '# S03-A evidence\n', 'utf-8');
    const result = validateStage(fx.writeTasks(validTasksMd()), undefined, evidenceDir);
    expect(result.valid).toBe(false);
    expect(errorTypes(result)).toContain('MISSING_EVIDENCE_FILE');
    // now add the second evidence file and an orphan
    fs.writeFileSync(path.join(evidenceDir, 'S03-B.md'), '# S03-B evidence\n', 'utf-8');
    fs.writeFileSync(path.join(evidenceDir, 'S03-ORPHAN.md'), '# orphan\n', 'utf-8');
    const result2 = validateStage(fx.writeTasks(validTasksMd()), undefined, evidenceDir);
    expect(result2.valid).toBe(false);
    expect(errorTypes(result2)).toContain('ORPHANED_EVIDENCE_FILE');
    // remove the orphan → valid
    fs.unlinkSync(path.join(evidenceDir, 'S03-ORPHAN.md'));
    const result3 = validateStage(fx.writeTasks(validTasksMd()), undefined, evidenceDir);
    expect(result3.valid).toBe(true);
  });

  it('reports a missing evidence directory', () => {
    const fx = makeFx();
    const result = validateStage(fx.writeTasks(validTasksMd()), undefined, '/nonexistent/evidence');
    expect(result.valid).toBe(false);
    expect(errorTypes(result)).toContain('EVIDENCE_DIR_NOT_FOUND');
  });

  it('fails closed when the tasks file is unreadable', () => {
    const result = validateStage('/nonexistent/tasks.md');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ============================================================
// CLI entry (dist script)
// ============================================================

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const DIST_CLI = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'validate-stage.js');

describe('validate-stage.js dist script (old-CLI contract)', () => {
  it('exits 1 with a usage error when invoked without args', () => {
    expect(fs.existsSync(DIST_CLI)).toBe(true);
    const res = spawnSync(process.execPath, [DIST_CLI], { encoding: 'utf-8' });
    expect(res.status).toBe(1);
    expect((res.stderr + res.stdout).toLowerCase()).toContain('usage:');
  });

  it('exits 0 with a JSON result for a valid stage', () => {
    expect(fs.existsSync(DIST_CLI)).toBe(true);
    const fx = makeFx();
    const tasksPath = fx.writeTasks(validTasksMd());
    const manifestPath = fx.writeManifest(compiledManifest());
    const res = spawnSync(process.execPath, [DIST_CLI, tasksPath, manifestPath], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as ValidateStageResult;
    expect(out.valid).toBe(true);
    expect(out.stage_id).toBe('S03');
  });

  it('exits 1 with a JSON result listing errors for an invalid stage', () => {
    expect(fs.existsSync(DIST_CLI)).toBe(true);
    const fx = makeFx();
    const bad = validTasksMd().replace('<!-- SLICE:S03-A:END -->', '');
    const tasksPath = fx.writeTasks(bad);
    const manifestPath = fx.writeManifest(compiledManifest());
    const res = spawnSync(process.execPath, [DIST_CLI, tasksPath, manifestPath], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    expect(res.status).toBe(1);
    const out = JSON.parse(res.stdout) as ValidateStageResult;
    expect(out.valid).toBe(false);
    expect(errorTypes(out)).toContain('UNCLOSED_SLICE');
  });
});
