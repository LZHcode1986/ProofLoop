/**
 * vNext Manifest compiler seam — S0-A bootstrap, task 2 tests.
 *
 * Real-filesystem fixtures. Proves:
 *   - valid structured vNext input compiles through the Kernel validators;
 *   - plan_digest stays stable across checkbox / Worker Status / CV Status
 *     changes and changes across immutable goal/ref/dependency edits;
 *   - unknown fields / wrong version / unregistered refs / bad digest /
 *     slice mismatch / stage-slice prefix mismatch are rejected;
 *   - the resume writer is atomic and zero-writes on any compile failure
 *     (interrupt/failure path leaves no half-written artifact);
 *   - the old v1 compile/validate library still works (no regression).
 *     (The v1 compile CLI was retired with the OpenCode plugin; the v1
 *     parity property is asserted directly against the kernel validator.)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateManifest } from '@proofloop/kernel';
import type { Manifest } from '@proofloop/kernel';
import {
  compileVNextManifest,
  writeVNextManifest,
  validateVNextManifest,
  VNextCompileError,
} from './compiler';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: any[]) => {
      const attack = (globalThis as any).__vnextOpenAttack as undefined | ((filePath: string) => void);
      if (attack) attack(String(args[0]));
      return (actual.openSync as any)(...args);
    },
  };
});

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

function makeTempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-compile-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root: string, rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

const REFS_MD = [
  '<!-- proofloop:entity id="S04-goal" kind="goal" -->',
  'stage goal body',
  '',
  '<!-- proofloop:entity id="S04-A-T01" kind="task" -->',
  'task body',
  '',
  '<!-- proofloop:entity id="S04-A-accept" kind="acceptance" -->',
  'acceptance body',
  '',
  '<!-- proofloop:entity id="S04-A-seam" kind="seam" -->',
  'seam body',
  '',
  '<!-- proofloop:entity id="S04-A-oracle" kind="oracle" -->',
  'oracle body',
  '',
  '<!-- proofloop:entity id="S04-A-risk" kind="risk" -->',
  'risk body',
  '',
].join('\n');

function makePlan(overrides: Record<string, unknown> = {}): any {
  return {
    schema_version: 2,
    items: [
      {
        id: 'S04-A-T01',
        kind: 'task',
        goal: 'Implement plugin load',
        refs: ['REF-T'],
        dependencies: [],
        required_skills: ['test-driven-development'],
        execution_scope: {
          kind: 'implementation',
          code_paths: ['packages/runtime/src/vnext/compiler.ts'],
          test_paths: ['packages/runtime/src/vnext/compiler.spec.ts'],
          forbidden_paths: ['.proofloop/receipts'],
        },
        checkbox: false,
        status: 'pending',
        cv_status: 'NOT_STARTED',
      },
    ],
    ...overrides,
  };
}

function makeProofIndex(overrides: Record<string, unknown> = {}): any {
  return {
    slice_id: 'S04-A',
    goal_ref: 'REF-G',
    task_refs: ['REF-T'],
    acceptance_refs: ['REF-A'],
    seam_refs: ['REF-S'],
    oracle_refs: ['REF-O'],
    risk_refs: [
      {
        ref_id: 'REF-R',
        applies_to_acceptance_refs: ['REF-A'],
        applies_to_seam_refs: ['REF-S'],
      },
    ],
    ...overrides,
  };
}

type VReferenceSeed = {
  ref_id: string;
  kind: 'goal' | 'task' | 'acceptance' | 'seam' | 'oracle' | 'risk' | 'proof_spec';
  ref: string;
};

function refSeed(refId: string, kind: string): VReferenceSeed {
  const idByKind: Record<string, string> = {
    goal: 'S04-goal',
    task: 'S04-A-T01',
    acceptance: 'S04-A-accept',
    seam: 'S04-A-seam',
    oracle: 'S04-A-oracle',
    risk: 'S04-A-risk',
    proof_spec: 'S04-A-T01',
  };
  return {
    ref_id: refId,
    kind: kind as VReferenceSeed['kind'],
    ref: `refs.md#/entities/${idByKind[kind]}`,
  };
}

function refs(): VReferenceSeed[] {
  return [
    refSeed('REF-G', 'goal'),
    refSeed('REF-T', 'task'),
    refSeed('REF-A', 'acceptance'),
    refSeed('REF-S', 'seam'),
    refSeed('REF-O', 'oracle'),
    refSeed('REF-R', 'risk'),
  ];
}

function baseInput(root: string, overrides: Record<string, unknown> = {}) {
  const input = {
    root,
    stage_id: 'S04',
    plan_path: 'delivery/stages/S04/tasks.md',
    plan: makePlan(),
    refs: refs(),
    slices: [
      {
        slice_id: 'S04-A',
        proof_index: makeProofIndex(),
        required_skills: ['test-driven-development'],
        depends_on: [],
        evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
      },
    ],
  };
  return { ...input, ...overrides } as any;
}

describe('compileVNextManifest — valid path', () => {
  it('compiles a valid structured input into a kernel-valid vNext Manifest', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const result = compileVNextManifest(baseInput(root));
    expect(result.manifest.version).toBe(2);
    expect(result.manifest.stage_id).toBe('S04');
    expect(Object.keys(result.manifest.reference_index)).toHaveLength(6);
    expect(result.manifest.task_scopes['S04-A-T01']).toEqual({
      task_ref: 'refs.md#/entities/S04-A-T01',
      execution_scope: {
        kind: 'implementation',
        code_paths: ['packages/runtime/src/vnext/compiler.ts'],
        test_paths: ['packages/runtime/src/vnext/compiler.spec.ts'],
        forbidden_paths: ['.proofloop/receipts'],
      },
    });
    expect(result.plan_digest).toMatch(/^[a-f0-9]{64}$/);
    // Every bound digest is a 64-char lowercase SHA-256.
    for (const d of Object.values(result.manifest.reference_index)) {
      expect(d.file_digest).toMatch(/^[a-f0-9]{64}$/);
      expect(d.section_digest).toMatch(/^[a-f0-9]{64}$/);
    }
    for (const fd of Object.values(result.file_digests)) expect(fd).toMatch(/^[a-f0-9]{64}$/);
    for (const sd of Object.values(result.section_digests)) expect(sd).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is idempotent: compiling twice yields identical results', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const a = compileVNextManifest(baseInput(root));
    const b = compileVNextManifest(baseInput(root));
    expect(a.manifest).toEqual(b.manifest);
    expect(a.plan_digest).toBe(b.plan_digest);
  });

  it('the seam never writes anything (pure compile)', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    compileVNextManifest(baseInput(root));
    const entries = fs.readdirSync(root);
    // Only the fixture refs.md exists — nothing was created by the compiler.
    expect(entries).toEqual(['refs.md']);
  });
});

describe('plan_digest invariants through the runtime seam', () => {
  const compile = (root: string, ...overrides: any[]) => {
    write(root, 'refs.md', REFS_MD);
    return compileVNextManifest(baseInput(root, ...overrides));
  };

  it('checkbox change keeps plan_digest stable', () => {
    const root = makeTempRoot();
    const base = compile(root);
    const toggled = compile(root, {
      plan: {
        ...makePlan(),
        items: [{ ...makePlan().items[0], checkbox: true }],
      },
    });
    expect(toggled.plan_digest).toBe(base.plan_digest);
  });

  it('Worker Status / CV Status changes keep plan_digest stable', () => {
    const root = makeTempRoot();
    const base = compile(root);
    const changed = compile(root, {
      plan: {
        ...makePlan(),
        items: [
          {
            ...makePlan().items[0],
            status: 'in_progress',
            cv_status: 'PASS',
          },
        ],
      },
    });
    expect(changed.plan_digest).toBe(base.plan_digest);
  });

  it('an immutable goal change changes plan_digest', () => {
    const root = makeTempRoot();
    const base = compile(root);
    const changed = compile(root, {
      plan: { ...makePlan(), items: [{ ...makePlan().items[0], goal: 'Implement teardown' }] },
    });
    expect(changed.plan_digest).not.toBe(base.plan_digest);
  });

  it('an execution_scope change changes plan_digest while mutable projections do not', () => {
    const root = makeTempRoot();
    const base = compile(root);
    const changed = compile(root, {
      plan: {
        ...makePlan(),
        items: [{
          ...makePlan().items[0],
          execution_scope: {
            ...makePlan().items[0].execution_scope,
            code_paths: ['packages/runtime/src/vnext/dispatch.ts'],
          },
        }],
      },
    });
    expect(changed.plan_digest).not.toBe(base.plan_digest);
  });
});

describe('compileVNextManifest — fail-closed', () => {
  it('rejects duplicate ref_id seeds instead of overwriting the first descriptor', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const input = baseInput(root);
    input.refs = [...input.refs, { ...input.refs[0] }];

    expect(() => compileVNextManifest(input)).toThrowError(VNextCompileError);
    expect(() => compileVNextManifest(input)).toThrowError(/Duplicate ref_id "REF-G"/);
  });

  it('rejects a non-array refs input with a structured compile error', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const input = baseInput(root, { refs: null });

    expect(() => compileVNextManifest(input)).toThrowError(VNextCompileError);
    expect(() => compileVNextManifest(input)).not.toThrowError(TypeError);
  });

  it('rejects a non-array slices input with a structured compile error', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const input = baseInput(root, { slices: {} });

    expect(() => compileVNextManifest(input)).toThrowError(VNextCompileError);
    expect(() => compileVNextManifest(input)).not.toThrowError(TypeError);
  });

  it('rejects empty slices with a structured compile error', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const input = baseInput(root, { slices: [] });

    expect(() => compileVNextManifest(input)).toThrowError(VNextCompileError);
    expect(() => compileVNextManifest(input)).toThrowError(/at least one slice/);
  });

  it('rejects an unknown field in the plan', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    expect(() =>
      compileVNextManifest(
        baseInput(root, {
          plan: { ...makePlan(), items: [{ ...makePlan().items[0], extra: 'nope' }] },
        }),
      ),
    ).toThrowError(VNextCompileError);
  });

  it('rejects a missing execution_scope instead of inferring an Evidence-only scope', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const task = { ...makePlan().items[0] };
    delete task.execution_scope;
    expect(() => compileVNextManifest(baseInput(root, {
      plan: { ...makePlan(), items: [task] },
    }))).toThrowError(/execution_scope/);
  });

  it('rejects a wrong plan schema_version (not vNext)', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    expect(() =>
      compileVNextManifest(baseInput(root, { plan: makePlan({ schema_version: 3 }) })),
    ).toThrowError(VNextCompileError);
  });

  it('rejects an unregistered proof ref (not in seeds)', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const input = baseInput(root);
    input.slices[0].proof_index.goal_ref = 'REF-NOPE';
    expect(() => compileVNextManifest(input)).toThrowError(VNextCompileError);
  });

  it('rejects a ref whose resolved kind mismatches the declared kind', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const input = baseInput(root);
    // REF-G is declared goal but points at the task-named entity marker (id mismatched) —
    // better: point a seed at the goal marker but declare kind "task".
    input.refs[0] = { ref_id: 'REF-G', kind: 'task', ref: 'refs.md#/entities/S04-goal' };
    expect(() => compileVNextManifest(input)).toThrowError(VNextCompileError);
  });

  it('rejects a slice/proof_index slice_id mismatch', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const input = baseInput(root);
    input.slices[0].proof_index.slice_id = 'S04-B';
    expect(() => compileVNextManifest(input)).toThrowError(/must equal slice\.slice_id/);
  });

  it('rejects a slice not prefixed by the stage_id', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const input = baseInput(root);
    input.slices[0].slice_id = 'S01-A';
    expect(() => compileVNextManifest(input)).toThrowError(/must be prefixed by stage_id/);
  });

  it('kernel validation rejects a fabricated bad digest (authored later, not via compiler)', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const result = compileVNextManifest(baseInput(root));
    const manifest = JSON.parse(JSON.stringify(result.manifest)) as any;
    manifest.reference_index['REF-T'].file_digest = 'fakeshort';
    expect(() => validateVNextManifest(manifest)).toThrowError(/SchemaValidationError|Expected 64-char/);
  });
});

describe('v1 parity — v1-shaped manifests still pass the old kernel validator', () => {
  it('a v1-shaped manifest (the retired compile-manifest output shape) passes the old kernel validateManifest', () => {
    // The v1 compile-manifest CLI was retired with the OpenCode plugin
    // (2026-08-14 ruling); the parity property it guarded — a v1-shaped
    // manifest still validates through the kernel `validateManifest` seam —
    // is asserted directly on the shape the old compiler produced for this
    // fixture.
    const manifest: Manifest = {
      stage_id: 'S04',
      source_path: 'v1.md',
      source_digest: 'dummy-source-digest',
      stage_goal: '(not declared)',
      outcomes: [],
      slices: [
        {
          slice_id: 'S04-A',
          goal: 'Do the thing',
          observable_outcome: '(not declared)',
          public_seam: '(not declared)',
          dependencies: ['S04-B'],
          proof_obligations: [],
          tasks: [],
          risk_facts: [],
          evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
          cv_minimum_level: 'lite',
        },
      ],
      dependencies: [],
      risk_facts: [],
    };
    expect(() => validateManifest(manifest)).not.toThrow();
    expect(manifest.stage_id).toContain('S04');
    expect(manifest.slices.length).toBeGreaterThan(0);
  });

  it('kernel rejects a v1-style (version 1 / no version) manifest as NOT vNext', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const result = compileVNextManifest(baseInput(root));
    const manifest = JSON.parse(JSON.stringify(result.manifest)) as any;
    manifest.version = 1;
    expect(() => validateVNextManifest(manifest)).toThrowError(/must not be interpreted as vNext/);
    const { version: _v, ...noVersion } = manifest;
    void _v;
    expect(() => validateVNextManifest(noVersion)).toThrowError();
  });
});

describe('writeVNextManifest — atomic write, zero-write on failure', () => {
  it('writes the manifest after successful compile (atomic, valid JSON)', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const target = 'delivery/stages/S04/vnext-manifest.json';
    const result = writeVNextManifest(baseInput(root), target);
    const abs = path.join(root, target);
    expect(fs.existsSync(abs)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    expect(parsed.version).toBe(2);
    // No temp files left behind in the written target directory.
    const targetDir = path.join(root, 'delivery', 'stages', 'S04');
    const dirEntries = fs.readdirSync(targetDir);
    expect(dirEntries.some((e) => e.includes('.tmp'))).toBe(false);
    expect(result.manifest.version).toBe(2);
  });

  it('fails closed on compile failure — target and temp files are NOT created', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const target = path.join(root, 'delivery-probe/manifest.json');
    const bad = baseInput(root, { plan: makePlan({ schema_version: 3 }) });
    expect(() => writeVNextManifest(bad, target)).toThrowError(VNextCompileError);
    const dir = path.dirname(target);
    expect(fs.existsSync(dir)).toBe(false); // not even created before validation
    expect(fs.existsSync(target)).toBe(false);
  });

  it('cleans a partially written temp file and preserves an existing target on temp-write failure', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const target = path.join(root, 'delivery-probe/manifest.json');
    write(root, 'delivery-probe/manifest.json', 'original-target');
    const writeOps = {
      writeTemp: (tempPath: string, payload: string) => {
        fs.writeFileSync(tempPath, payload, 'utf-8');
        throw new Error('injected temp write failure');
      },
      renameTemp: (tempPath: string, targetPath: string) => fs.renameSync(tempPath, targetPath),
      removeTemp: (tempPath: string) => fs.unlinkSync(tempPath),
    };

    expect(() => writeVNextManifest(baseInput(root), target, writeOps)).toThrowError(
      /injected temp write failure/,
    );
    expect(fs.readFileSync(target, 'utf-8')).toBe('original-target');
    expect(fs.readdirSync(path.dirname(target)).some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  it('cleans the temp file and preserves an existing target on rename failure', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const target = path.join(root, 'delivery-probe/manifest.json');
    write(root, 'delivery-probe/manifest.json', 'original-target');
    const writeOps = {
      writeTemp: (tempPath: string, payload: string) => fs.writeFileSync(tempPath, payload, 'utf-8'),
      renameTemp: () => {
        throw new Error('injected rename failure');
      },
      removeTemp: (tempPath: string) => fs.unlinkSync(tempPath),
    };

    expect(() => writeVNextManifest(baseInput(root), target, writeOps)).toThrowError(
      /injected rename failure/,
    );
    expect(fs.readFileSync(target, 'utf-8')).toBe('original-target');
    expect(fs.readdirSync(path.dirname(target)).some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  it.each(['symlink', 'hardlink'] as const)(
    'rejects a pre-created %s temp entry without modifying an external victim',
    (attack) => {
      const root = makeTempRoot();
      write(root, 'refs.md', REFS_MD);
      const outside = makeTempRoot();
      const victim = write(outside, 'victim.txt', 'external-victim-before');
      const target = path.join(root, 'delivery-probe/manifest.json');
      write(root, 'delivery-probe/manifest.json', 'original-target');
      const targetDir = path.dirname(target);
      let attacked = false;
      (globalThis as any).__vnextOpenAttack = (candidate: string) => {
        if (!attacked && candidate.startsWith(targetDir) && candidate.endsWith('.tmp')) {
          attacked = true;
          if (attack === 'symlink') {
            fs.symlinkSync(victim, candidate);
          } else {
            fs.linkSync(victim, candidate);
          }
        }
      };

      try {
        expect(() => writeVNextManifest(baseInput(root), target)).toThrow();
        expect(attacked).toBe(true);
        expect(fs.readFileSync(victim, 'utf-8')).toBe('external-victim-before');
        expect(fs.readFileSync(target, 'utf-8')).toBe('original-target');
        expect(fs.readdirSync(targetDir)).toEqual(['manifest.json']);
      } finally {
        delete (globalThis as any).__vnextOpenAttack;
      }
    },
  );

  it('does not report success when temp cleanup fails after rename', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const target = path.join(root, 'delivery-probe/manifest.json');
    const writeOps = {
      writeTemp: (tempPath: string, payload: string) => fs.writeFileSync(tempPath, payload, 'utf-8'),
      renameTemp: (tempPath: string, targetPath: string) => fs.renameSync(tempPath, targetPath),
      removeTemp: () => {
        throw new Error('injected cleanup failure');
      },
    };

    expect(() => writeVNextManifest(baseInput(root), target, writeOps)).toThrowError(
      /injected cleanup failure/,
    );
    expect(JSON.parse(fs.readFileSync(target, 'utf-8')).version).toBe(2);
  });
});

describe('S09-C-T03 — compiler rejects legacy stage labels before any read/write', () => {
  it('rejects a compile input whose stage_id is the parked S08B0 label', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const input = baseInput(root, { stage_id: 'S08B0' });
    expect(() => compileVNextManifest(input)).toThrowError(VNextCompileError);
    expect(() => compileVNextManifest(input)).toThrowError(/canonical Stage ID/);
  });

  it('rejects a compile input whose stage_id is the parked S08B label', () => {
    const root = makeTempRoot();
    write(root, 'refs.md', REFS_MD);
    const input = baseInput(root, { stage_id: 'S08B' });
    expect(() => compileVNextManifest(input)).toThrowError(/canonical Stage ID/);
  });
});
