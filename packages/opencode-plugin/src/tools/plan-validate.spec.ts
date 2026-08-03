/**
 * @proofloop/opencode-plugin — proofloop_plan(validate) contract spec
 * (S02-B-T01).
 *
 * PO: PO-S02-B-01 (path boundary + operation contract), PO-S02-B-02 (canonical
 * payload preservation), PO-S02-B-03 (Finding projection / ToolResult honesty).
 *
 * S02-B-T01 delivers the runtime public seam (validateStage re-exported from
 * `@proofloop/runtime`), the path-boundary resolution for the three canonical
 * validate inputs, and the canonical payload + Finding projection that T02
 * wires into the real `Hooks.tool.proofloop_plan` definition. This slice
 * deliberately does NOT register the plan tool or implement execute (T02):
 *
 *   - runtime seam: `validateStage` must be importable from `@proofloop/runtime`
 *     (the runtime index re-export) and callable IN-PROCESS on real fixture
 *     files — never through a CLI subprocess and never by copying the parser.
 *   - path-boundary: `tasks_path` / `manifest_path` / optional `evidence_dir`
 *     resolve relative to the canonical trust root; absolute paths must stay
 *     inside the root; out-of-bounds → HOST.PATH_OUTSIDE_PROJECT; missing /
 *     malformed required inputs → RUNTIME.SCHEMA_MISMATCH (fail-closed).
 *   - canonical payload: the ToolResult `data` preserves the CLI
 *     `ValidateStageResult` fields `valid` / `stage_id` / `errors` verbatim
 *     (exact field names, exact error `{ type, message, sliceId? }` shape,
 *     original order) for S02-D parity deep-equal against the CLI JSON.
 *   - Finding projection: every validate error maps to a canonical kernel
 *     Finding (RUNTIME.SCHEMA_MISMATCH, severity error, message preserved,
 *     order preserved); valid → ok:true with EMPTY findings (never a fake
 *     PASS); invalid → ok:false with non-empty findings; refs stay empty
 *     (validate is read-only, no Receipt refs are ever produced).
 */

import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateStage } from '@proofloop/runtime';
import type { ValidateStageResult } from '@proofloop/runtime';
import type { Manifest } from '@proofloop/kernel';
import {
  buildValidateToolResult,
  projectValidateData,
  projectValidateFindings,
  resolveValidatePaths,
  reverifyResolvedPaths,
  runPlanValidate,
} from './plan-validate.js';

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

interface PlanFx {
  readonly dir: string;
  writeTasks(content: string, name?: string): string;
  writeManifest(manifest: Manifest, name?: string): string;
  writeEvidence(sliceId: string, name?: string): string;
  cleanup(): void;
}

function makeFx(): PlanFx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-plan-validate-'));
  const fx: PlanFx = {
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

/** Acyclic 2-slice stage: A root; B deps [A]. Mirrors the CLI fixture. */
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

/** Validate input args with absolute in-root paths (the canonical form). */
function absoluteArgs(
  fx: PlanFx,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const tasksPath = fx.writeTasks(validTasksMd());
  const manifestPath = fx.writeManifest(compiledManifest());
  return {
    operation: 'validate',
    tasks_path: tasksPath,
    manifest_path: manifestPath,
    ...overrides,
  };
}

// ============================================================
// Runtime public seam — validateStage re-export availability
// ============================================================

describe('runtime public seam (PO-S02-B-01/02)', () => {
  it('re-exports validateStage from @proofloop/runtime as a callable function', () => {
    expect(typeof validateStage).toBe('function');
  });

  it('consumes the runtime library IN-PROCESS on a real valid fixture', () => {
    const fx = makeFx();
    const tasksPath = fx.writeTasks(validTasksMd());
    const manifestPath = fx.writeManifest(compiledManifest());
    const result = validateStage(tasksPath, manifestPath);
    expect(result.valid).toBe(true);
    expect(result.stage_id).toBe('S03');
    expect(result.errors).toEqual([]);
  });

  it('reports structural errors through the same in-process library', () => {
    const fx = makeFx();
    const bad = validTasksMd().replace('<!-- SLICE:S03-A:END -->', '');
    const tasksPath = fx.writeTasks(bad);
    const manifestPath = fx.writeManifest(compiledManifest());
    const result = validateStage(tasksPath, manifestPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === 'UNCLOSED_SLICE')).toBe(true);
  });
});

// ============================================================
// Path-boundary resolution (PO-S02-B-01)
// ============================================================

describe('resolveValidatePaths — path boundary (PO-S02-B-01)', () => {
  it('resolves relative paths against the trust root', () => {
    const fx = makeFx();
    const rel = 'delivery/stages/S03/tasks.md';
    const resolved = resolveValidatePaths(fx.dir, {
      tasks_path: rel,
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.args.tasksPath).toBe(path.resolve(fx.dir, rel));
    expect(resolved.args.manifestPath).toBe(path.resolve(fx.dir, 'manifest.json'));
  });

  it('accepts absolute paths that stay inside the trust root', () => {
    const fx = makeFx();
    const tasksPath = fx.writeTasks(validTasksMd());
    const manifestPath = fx.writeManifest(compiledManifest());
    const resolved = resolveValidatePaths(fx.dir, {
      tasks_path: tasksPath,
      manifest_path: manifestPath,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.args.tasksPath).toBe(tasksPath);
    expect(resolved.args.manifestPath).toBe(manifestPath);
  });

  it('accepts an optional evidence_dir inside the trust root', () => {
    const fx = makeFx();
    fx.writeEvidence('S03-A');
    fx.writeEvidence('S03-B');
    const resolved = resolveValidatePaths(fx.dir, {
      tasks_path: 'tasks.md',
      manifest_path: 'manifest.json',
      evidence_dir: fx.dir,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.args.evidenceDir).toBe(fx.dir);
  });

  it('rejects an absolute path outside the trust root with HOST.PATH_OUTSIDE_PROJECT', () => {
    const fx = makeFx();
    const resolved = resolveValidatePaths(fx.dir, {
      tasks_path: '/etc/passwd',
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.ok).toBe(false);
    expect(resolved.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('rejects a traversal path escaping the root with HOST.PATH_OUTSIDE_PROJECT', () => {
    const fx = makeFx();
    const resolved = resolveValidatePaths(fx.dir, {
      tasks_path: '../outside.md',
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('rejects evidence_dir outside the root with HOST.PATH_OUTSIDE_PROJECT', () => {
    const fx = makeFx();
    const resolved = resolveValidatePaths(fx.dir, {
      tasks_path: 'tasks.md',
      manifest_path: 'manifest.json',
      evidence_dir: '/tmp',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('rejects a missing tasks_path with RUNTIME.SCHEMA_MISMATCH (fail-closed)', () => {
    const fx = makeFx();
    const resolved = resolveValidatePaths(fx.dir, { manifest_path: 'manifest.json' });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'RUNTIME.SCHEMA_MISMATCH')).toBe(true);
  });

  it('rejects a missing manifest_path with RUNTIME.SCHEMA_MISMATCH (fail-closed)', () => {
    const fx = makeFx();
    const resolved = resolveValidatePaths(fx.dir, { tasks_path: 'tasks.md' });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'RUNTIME.SCHEMA_MISMATCH')).toBe(true);
  });

  it('rejects non-string path values with RUNTIME.SCHEMA_MISMATCH', () => {
    const fx = makeFx();
    const resolved = resolveValidatePaths(fx.dir, {
      tasks_path: 42,
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'RUNTIME.SCHEMA_MISMATCH')).toBe(true);
  });

  it('rejects a non-object args payload with RUNTIME.SCHEMA_MISMATCH', () => {
    const resolved = resolveValidatePaths('/tmp', 'not-an-object');
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'RUNTIME.SCHEMA_MISMATCH')).toBe(true);
  });

  it('rejects a symlink PARENT that points outside the root even when the final target does not exist (PO-B-01)', () => {
    // Regression for CV S02-B-INITIAL-PO01-SYMLINK: a parent component that is
    // a symlink to a directory OUTSIDE the trust root must be rejected with
    // HOST.PATH_OUTSIDE_PROJECT even though the requested final target (the
    // file below the symlinked parent) does not exist yet. The old
    // resolveWithinRoot only realpath-checked the final target and accepted
    // the lexical path when realpathSync threw ENOENT.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-symlink-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-outside-'));
    cleanups.push(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    // `link` is a symlink to the OUTSIDE dir; `link/tasks.md` does not exist.
    fs.symlinkSync(outside, path.join(root, 'link'));
    const resolved = resolveValidatePaths(root, {
      tasks_path: path.join('link', 'tasks.md'),
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('rejects a symlink PARENT that points outside the root when the final target exists too (PO-B-01)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-symlink2-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-outside2-'));
    cleanups.push(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    fs.symlinkSync(outside, path.join(root, 'link'));
    // The file exists under the OUTSIDE dir — a real read would escape.
    fs.writeFileSync(path.join(outside, 'tasks.md'), '# outside\n', 'utf-8');
    const resolved = resolveValidatePaths(root, {
      tasks_path: path.join('link', 'tasks.md'),
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('rejects a symlink + .. mixed traversal that would escape the root (PO-B-01)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-symlink3-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-outside3-'));
    cleanups.push(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    fs.symlinkSync(outside, path.join(root, 'link'));
    // link/../tasks.md with `link` resolving OUTSIDE root: `..` applied to the
    // RESOLVED directory (the outside dir) escapes the root. The old lexical
    // path.resolve(root, 'link/../tasks.md') collapsed to root/tasks.md and
    // was accepted. The raw string must NOT be normalized by path.join here
    // (path.join collapses `..` lexically before the resolver sees it).
    fs.writeFileSync(path.join(outside, 'tasks.md'), '# outside\n', 'utf-8');
    const resolved = resolveValidatePaths(root, {
      tasks_path: 'link/../tasks.md',
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('rejects a MULTI-HOP broken-symlink chain that escapes the root even when the last target is missing (PO-B-01 recheck)', () => {
    // CV S02-B-RECHECK-PO01-BROKEN-SYMLINK: root-internal link A → root-internal
    // link B → outside target. B's target is MISSING, so realpathSync(root/A)
    // throws ENOENT and the old one-hop branch accepted root/A (it only looked
    // one readlink hop: A→B, both lexically inside root). The resolver must
    // follow the WHOLE chain and reject because B ultimately points outside.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-symlink4-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-outside4-'));
    cleanups.push(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    // A → B (relative, both inside root); B → outside absolute path that does
    // NOT exist yet (missing target).
    fs.symlinkSync('B', path.join(root, 'A'));
    fs.symlinkSync(path.join(outside, 'missing-dir'), path.join(root, 'B'));
    const resolved = resolveValidatePaths(root, {
      tasks_path: path.join('A', 'tasks.md'),
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('rejects a symlink CHAIN CYCLE with HOST.PATH_OUTSIDE_PROJECT (PO-B-01 recheck)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-symlink5-'));
    cleanups.push(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    fs.symlinkSync('B', path.join(root, 'A'));
    fs.symlinkSync('A', path.join(root, 'B'));
    const resolved = resolveValidatePaths(root, {
      tasks_path: path.join('A', 'tasks.md'),
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('returns the REALPATH (canonical) path for existing targets so a later symlink swap cannot redirect the open (TOCTOU mitigation)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-toctou-'));
    cleanups.push(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    fs.writeFileSync(path.join(root, 'real.md'), '# real\n', 'utf-8');
    fs.symlinkSync('real.md', path.join(root, 'link.md'));
    // A caller-supplied symlink path must resolve to the CANONICAL realpath so
    // the subsequent open targets the real file, not the swappable symlink.
    const resolved = resolveValidatePaths(root, {
      tasks_path: path.join('link.md'),
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.args.tasksPath).toBe(path.join(root, 'real.md'));
  });

  it('re-verifies resolved paths immediately before the runtime read (TOCTOU recheck)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-toctou2-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-outside5-'));
    cleanups.push(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    // First resolution succeeds (tasks.md is a plain missing file inside root).
    const first = resolveValidatePaths(root, {
      tasks_path: 'tasks.md',
      manifest_path: 'manifest.json',
    });
    expect(first.ok).toBe(true);
    // The attacker swaps tasks.md into a symlink pointing OUTSIDE the root
    // between the resolve and the read (TOCTOU window). The second pass must
    // fail closed.
    fs.symlinkSync(path.join(outside, 'evil.md'), path.join(root, 'tasks.md'));
    const second = resolveValidatePaths(root, {
      tasks_path: 'tasks.md',
      manifest_path: 'manifest.json',
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });
});

// ============================================================
// Canonical payload preservation (PO-S02-B-02)
// ============================================================

describe('canonical payload preservation (PO-S02-B-02)', () => {
  it('preserves valid/stage_id/errors verbatim for a valid result', () => {
    const fx = makeFx();
    const result: ValidateStageResult = {
      valid: true,
      stage_id: 'S03',
      errors: [],
    };
    const data = projectValidateData(result);
    expect(data).toEqual({
      valid: true,
      stage_id: 'S03',
      errors: [],
    });
    const tool = buildValidateToolResult(result);
    expect(tool.ok).toBe(true);
    expect(tool.data).toEqual({
      valid: true,
      stage_id: 'S03',
      errors: [],
    });
  });

  it('preserves error shape, order and sliceId in the canonical payload', () => {
    const result: ValidateStageResult = {
      valid: false,
      stage_id: 'S03',
      errors: [
        { type: 'UNCLOSED_SLICE', message: 'Slice S03-A has BEGIN but no END marker', sliceId: 'S03-A' },
        { type: 'DUPLICATE_ID', message: 'Duplicate Slice ID: S03-B' },
      ],
    };
    const data = projectValidateData(result);
    expect(data.valid).toBe(false);
    expect(data.stage_id).toBe('S03');
    expect(data.errors).toEqual([
      { type: 'UNCLOSED_SLICE', message: 'Slice S03-A has BEGIN but no END marker', sliceId: 'S03-A' },
      { type: 'DUPLICATE_ID', message: 'Duplicate Slice ID: S03-B' },
    ]);
    // Exact CLI error field names — never a renamed/shorthand projection.
    const first = (data.errors as Array<Record<string, unknown>>)[0];
    expect(Object.keys(first).sort()).toEqual(['message', 'sliceId', 'type']);
    const second = (data.errors as Array<Record<string, unknown>>)[1];
    expect(Object.keys(second).sort()).toEqual(['message', 'type']);
  });
});

// ============================================================
// Finding projection / ToolResult honesty (PO-S02-B-03)
// ============================================================

describe('Finding projection and ToolResult honesty (PO-S02-B-03)', () => {
  it('maps every invalid error to a canonical kernel Finding preserving order', () => {
    const result: ValidateStageResult = {
      valid: false,
      stage_id: 'S03',
      errors: [
        { type: 'UNCLOSED_SLICE', message: 'first message', sliceId: 'S03-A' },
        { type: 'DUPLICATE_ID', message: 'second message' },
      ],
    };
    const findings = projectValidateFindings(result);
    expect(findings).toEqual([
      { code: 'RUNTIME.SCHEMA_MISMATCH', severity: 'error', message: 'first message' },
      { code: 'RUNTIME.SCHEMA_MISMATCH', severity: 'error', message: 'second message' },
    ]);
  });

  it('builds ok:false with non-empty findings for an invalid result', () => {
    const result: ValidateStageResult = {
      valid: false,
      stage_id: 'S03',
      errors: [
        { type: 'UNCLOSED_SLICE', message: 'Slice S03-A has BEGIN but no END marker', sliceId: 'S03-A' },
      ],
    };
    const tool = buildValidateToolResult(result);
    expect(tool.ok).toBe(false);
    expect(tool.findings.length).toBeGreaterThan(0);
    expect(tool.findings.every((f) => f.severity === 'error')).toBe(true);
    expect(tool.findings[0].message).toBe('Slice S03-A has BEGIN but no END marker');
    // refs stay empty — validate never produces Receipt refs (read-only).
    expect(tool.refs).toEqual([]);
  });

  it('builds ok:true with EMPTY findings for a valid result (no fake PASS)', () => {
    const result: ValidateStageResult = {
      valid: true,
      stage_id: 'S03',
      errors: [],
    };
    const tool = buildValidateToolResult(result);
    expect(tool.ok).toBe(true);
    expect(tool.findings).toEqual([]);
    expect(tool.refs).toEqual([]);
  });

  it('never surfaces an empty findings list on an invalid result', () => {
    const tool = buildValidateToolResult({ valid: false, stage_id: 'S03', errors: [] });
    expect(tool.ok).toBe(false);
    expect(tool.findings.length).toBeGreaterThan(0);
  });

  it('caps ToolResult findings at FINDINGS_BUDGET while keeping ALL errors in data (PO-B-03 repair)', () => {
    // >20 structural errors → findings capped at 20 (FR-012), data.errors
    // stays COMPLETE (canonical payload + log traceability intact).
    const many = Array.from({ length: 25 }, (_, i) => ({
      type: 'DUPLICATE_ID',
      message: `Duplicate Slice ID: S03-A-${i}`,
    }));
    const result: ValidateStageResult = {
      valid: false,
      stage_id: 'S03',
      errors: many,
    };
    const tool = buildValidateToolResult(result);
    expect(tool.ok).toBe(false);
    expect(tool.findings.length).toBe(20);
    expect(tool.findings.every((f) => f.code === 'RUNTIME.SCHEMA_MISMATCH')).toBe(true);
    expect(tool.findings[0].message).toBe('Duplicate Slice ID: S03-A-0');
    const dataErrors = (tool.data as { errors?: unknown[] })?.errors ?? [];
    expect(dataErrors.length).toBe(25);
    // First and last errors preserved in the canonical payload (no truncation
    // of `data`).
    expect(dataErrors[0]).toEqual({ type: 'DUPLICATE_ID', message: 'Duplicate Slice ID: S03-A-0' });
    expect(dataErrors[24]).toEqual({ type: 'DUPLICATE_ID', message: 'Duplicate Slice ID: S03-A-24' });
  });
});

// ============================================================
// runPlanValidate — in-process adapter seam composition
// ============================================================

describe('runPlanValidate — in-process seam (PO-S02-B-01/02/03)', () => {
  it('validates a real valid fixture in-process and returns the canonical payload', () => {
    const fx = makeFx();
    const tool = runPlanValidate(fx.dir, absoluteArgs(fx));
    expect(tool.ok).toBe(true);
    expect(tool.data).toEqual({
      valid: true,
      stage_id: 'S03',
      errors: [],
    });
    expect(tool.findings).toEqual([]);
    expect(tool.refs).toEqual([]);
  });

  it('returns ok:false with canonical findings for a structurally invalid fixture', () => {
    const fx = makeFx();
    const bad = validTasksMd().replace('<!-- SLICE:S03-A:END -->', '');
    const tasksPath = fx.writeTasks(bad);
    const manifestPath = fx.writeManifest(compiledManifest());
    const tool = runPlanValidate(fx.dir, {
      operation: 'validate',
      tasks_path: tasksPath,
      manifest_path: manifestPath,
    });
    expect(tool.ok).toBe(false);
    expect(tool.data).toMatchObject({ valid: false, stage_id: 'S03' });
    expect(tool.findings.length).toBeGreaterThan(0);
    expect(tool.findings.every((f) => f.code === 'RUNTIME.SCHEMA_MISMATCH')).toBe(true);
  });

  it('fails closed on an out-of-bounds path without reading any file', () => {
    const fx = makeFx();
    const tool = runPlanValidate(fx.dir, {
      operation: 'validate',
      tasks_path: '/etc/passwd',
      manifest_path: 'manifest.json',
    });
    expect(tool.ok).toBe(false);
    expect(tool.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('fails closed on a missing required path without reading any file', () => {
    const fx = makeFx();
    const tool = runPlanValidate(fx.dir, {
      operation: 'validate',
      tasks_path: 'tasks.md',
    });
    expect(tool.ok).toBe(false);
    expect(tool.findings.some((f) => f.code === 'RUNTIME.SCHEMA_MISMATCH')).toBe(true);
  });

  it('re-verifies resolved paths immediately before the runtime read (TOCTOU narrowing)', () => {
    const fx = makeFx();
    const root = fx.dir;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-toctou3-'));
    cleanups.push(() => {
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    // First resolve sees a plain missing tasks.md inside root.
    const first = resolveValidatePaths(root, {
      tasks_path: 'tasks.md',
      manifest_path: 'manifest.json',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Attacker swaps tasks.md into a symlink pointing OUTSIDE the root between
    // the resolve and the read. The re-verify pass must fail closed.
    fs.symlinkSync(path.join(outside, 'evil.md'), path.join(root, 'tasks.md'));
    const reverified = reverifyResolvedPaths(root, first.args);
    expect(reverified).not.toBeNull();
    expect(reverified?.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
    // runPlanValidate itself also fails closed through the same pass.
    const tool = runPlanValidate(root, {
      operation: 'validate',
      tasks_path: 'tasks.md',
      manifest_path: 'manifest.json',
    });
    expect(tool.ok).toBe(false);
    expect(tool.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('rejects a MULTI-HOP broken-symlink tasks_path through the full seam (PO-B-01 recheck)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-symlink6-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t01-outside6-'));
    cleanups.push(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    fs.symlinkSync('B', path.join(root, 'A'));
    fs.symlinkSync(path.join(outside, 'missing-dir'), path.join(root, 'B'));
    const tool = runPlanValidate(root, {
      operation: 'validate',
      tasks_path: path.join('A', 'tasks.md'),
      manifest_path: 'manifest.json',
    });
    expect(tool.ok).toBe(false);
    expect(tool.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('rejects an IN-ROOT symlink redirect of the canonical tasks path (DIAGNOSE-2)', () => {
    // CV S02-B-RECHECK-PO01-INROOT-SYMLINK-REDIRECT: reverifyResolvedPaths must
    // reject a canonical path that re-resolves to a DIFFERENT path (even when
    // the alternate target is still inside the root). The old check only
    // asserted the second resolve was non-null, so a swapped in-root symlink
    // redirected the read to alternate.md while passing the boundary check.
    const fx = makeFx();
    const root = fx.dir;
    const tasksPath = fx.writeTasks(validTasksMd());
    const manifestPath = fx.writeManifest(compiledManifest());
    // First resolve captures the CANONICAL path of the real file.
    const first = resolveValidatePaths(root, {
      tasks_path: tasksPath,
      manifest_path: manifestPath,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.args.tasksPath).toBe(tasksPath);
    // Attacker swaps tasks.md into a symlink to an ALTERNATE in-root file.
    const alternatePath = path.join(root, 'alternate.md');
    writeFileSync(alternatePath, '# alternate, not the canonical tasks\n', 'utf-8');
    rmSync(tasksPath, { force: true });
    fs.symlinkSync('alternate.md', tasksPath);
    // Re-verify must fail closed: the re-resolved path differs from the
    // canonical first-resolve path.
    const reverified = reverifyResolvedPaths(root, first.args);
    expect(reverified).not.toBeNull();
    expect(reverified?.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
    expect(reverified?.findings.some((f) => f.message.includes('redirected'))).toBe(true);
  });

  it('rejects an IN-ROOT symlink redirect of the canonical manifest path (DIAGNOSE-2)', () => {
    const fx = makeFx();
    const root = fx.dir;
    const tasksPath = fx.writeTasks(validTasksMd());
    const manifestPath = fx.writeManifest(compiledManifest());
    const first = resolveValidatePaths(root, {
      tasks_path: tasksPath,
      manifest_path: manifestPath,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.args.manifestPath).toBe(manifestPath);
    const alternateManifest = path.join(root, 'alternate-manifest.json');
    writeFileSync(alternateManifest, '{"not":"the manifest"}', 'utf-8');
    rmSync(manifestPath, { force: true });
    fs.symlinkSync('alternate-manifest.json', manifestPath);
    const reverified = reverifyResolvedPaths(root, first.args);
    expect(reverified).not.toBeNull();
    expect(reverified?.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('rejects an IN-ROOT symlink redirect of the canonical evidence_dir path (DIAGNOSE-2)', () => {
    const fx = makeFx();
    const root = fx.dir;
    const tasksPath = fx.writeTasks(validTasksMd());
    const manifestPath = fx.writeManifest(compiledManifest());
    const evidenceDir = path.join(root, 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    const first = resolveValidatePaths(root, {
      tasks_path: tasksPath,
      manifest_path: manifestPath,
      evidence_dir: evidenceDir,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.args.evidenceDir).toBe(evidenceDir);
    const alternateDir = path.join(root, 'alternate-evidence');
    mkdirSync(alternateDir, { recursive: true });
    rmSync(evidenceDir, { recursive: true, force: true });
    fs.symlinkSync('alternate-evidence', evidenceDir);
    const reverified = reverifyResolvedPaths(root, first.args);
    expect(reverified).not.toBeNull();
    expect(reverified?.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('rejects a symlink TARGET containing a `..` that escapes through a symlink ancestor (DIAGNOSE-3)', () => {
    // CV S02-B-RECHECK-3: resolveSymlinkChain uses path.resolve + whole-path
    // lstat, which LEXICALIZES a `..` inside the target. root/A → 'B/../x'
    // where B is a symlink to an OUTSIDE dir: path.resolve(root,'B/../x')
    // collapses B/.. → root/x (inside root) and is accepted, but the real read
    // follows B (outside) then .. → outside/x (escapes).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t03-symlinkA-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t03-outsideA-'));
    cleanups.push(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    // B → outside (absolute); the final target outside/x does NOT exist so
    // realpathSync(root/A) throws and the broken-symlink branch runs.
    fs.symlinkSync(outside, path.join(root, 'B'));
    fs.symlinkSync('B/../x.md', path.join(root, 'A'));
    const resolved = resolveValidatePaths(root, {
      tasks_path: path.join('A'),
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('rejects a symlink TARGET whose intermediate component is a symlink to outside (DIAGNOSE-3)', () => {
    // root/A → 'B/x' where B is a symlink to an OUTSIDE dir and outside/x is
    // missing. path.resolve(root,'B/x') = root/B/x stays inside root lexically
    // and is accepted, but the real read follows B (outside) → outside/x.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t03-symlinkB-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t03-outsideB-'));
    cleanups.push(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      try {
        fs.rmSync(outside, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    fs.symlinkSync(outside, path.join(root, 'B'));
    fs.symlinkSync('B/x.md', path.join(root, 'A'));
    const resolved = resolveValidatePaths(root, {
      tasks_path: path.join('A'),
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.result.findings.some((f) => f.code === 'HOST.PATH_OUTSIDE_PROJECT')).toBe(true);
  });

  it('accepts a symlink TARGET that stays inside the root through a `..` (DIAGNOSE-3 control)', () => {
    // A control: root/sub/x.md exists and root/A → 'sub/../x.md' must be
    // accepted (in-root `..` through a real directory is legal).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-t03-symlinkC-'));
    cleanups.push(() => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'x.md'), '# x\n', 'utf-8');
    fs.symlinkSync('sub/../x.md', path.join(root, 'A'));
    const resolved = resolveValidatePaths(root, {
      tasks_path: path.join('A'),
      manifest_path: 'manifest.json',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.args.tasksPath).toBe(path.join(root, 'x.md'));
  });
});
