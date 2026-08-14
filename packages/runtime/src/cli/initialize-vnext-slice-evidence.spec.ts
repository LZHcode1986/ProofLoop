import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compileVNextManifestCli } from './compile-vnext-manifest';
import {
  initializeVNextSliceEvidence,
  initializeVNextSliceEvidenceCli,
} from './initialize-vnext-slice-evidence';
import type { CompileVNextManifestInput } from '../vnext';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeFixture(): { root: string; manifest: string; evidence: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-vnext-init-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const refs = [
    '<!-- proofloop:entity id="goal" kind="goal" -->', 'goal',
     '<!-- proofloop:entity id="S04-A-T01" kind="task" -->', 'task',
    '<!-- proofloop:entity id="accept" kind="acceptance" -->', 'acceptance',
    '<!-- proofloop:entity id="seam" kind="seam" -->', 'seam',
    '<!-- proofloop:entity id="oracle" kind="oracle" -->', 'oracle',
    '<!-- proofloop:entity id="risk" kind="risk" -->', 'risk',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'refs.md'), refs, 'utf8');
  const tasks = path.join(root, 'delivery', 'stages', 'S04', 'tasks.md');
  fs.mkdirSync(path.dirname(tasks), { recursive: true });
  fs.writeFileSync(tasks, 'not parsed\n', 'utf8');
  const input: CompileVNextManifestInput = {
    root,
    stage_id: 'S04',
    plan_path: 'delivery/stages/S04/tasks.md',
    plan: {
      schema_version: 2,
       items: [{
         id: 'S04-A-T01',
         kind: 'task',
         goal: 'goal',
         refs: ['T'],
         dependencies: [],
         required_skills: [],
         execution_scope: {
           kind: 'implementation',
           code_paths: ['packages/runtime/src/cli/initialize-vnext-slice-evidence.ts'],
           test_paths: ['packages/runtime/src/cli/initialize-vnext-slice-evidence.spec.ts'],
           forbidden_paths: ['.proofloop/receipts'],
         },
       }],
    },
    refs: [
      { ref_id: 'G', kind: 'goal', ref: 'refs.md#/entities/goal' },
       { ref_id: 'T', kind: 'task', ref: 'refs.md#/entities/S04-A-T01' },
      { ref_id: 'A', kind: 'acceptance', ref: 'refs.md#/entities/accept' },
      { ref_id: 'S', kind: 'seam', ref: 'refs.md#/entities/seam' },
      { ref_id: 'O', kind: 'oracle', ref: 'refs.md#/entities/oracle' },
      { ref_id: 'R', kind: 'risk', ref: 'refs.md#/entities/risk' },
    ],
    authority_ref_ids: ['A', 'S', 'O'],
    slices: [{
      slice_id: 'S04-A',
      proof_index: {
        slice_id: 'S04-A', goal_ref: 'G', task_refs: ['T'], acceptance_refs: ['A'],
        seam_refs: ['S'], oracle_refs: ['O'], risk_refs: [{ ref_id: 'R', applies_to_acceptance_refs: ['A'], applies_to_seam_refs: ['S'] }],
      },
      required_skills: [],
      depends_on: [],
      evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
    }],
  };
  const request = path.join(root, 'request.json');
  fs.writeFileSync(request, JSON.stringify(input), 'utf8');
  const manifest = path.join(root, 'delivery', 'stages', 'S04', 'manifest.json');
  expect(compileVNextManifestCli([request, manifest, root])).toBe(0);
  return { root, manifest, evidence: path.join(root, 'delivery', 'stages', 'S04', 'evidence') };
}

describe('initialize-vnext-slice-evidence explicit vNext seam', () => {
  it('creates a minimal vNext skeleton and binds its manifest digest', () => {
    const fx = makeFixture();
    const result = initializeVNextSliceEvidence(fx.manifest, fx.evidence, fx.root);
    expect(result).toMatchObject({ success: true, stage_id: 'S04', skipped: [], errors: [] });
    expect(result.initialized).toHaveLength(1);
    const target = path.join(fx.evidence, 'S04-A.md');
    const content = fs.readFileSync(target, 'utf8');
    expect(content).toContain('Stage ID: S04');
    expect(content).toContain('Slice ID: S04-A');
    expect(content).toContain('Plan Ref: delivery/stages/S04/tasks.md');
    expect(content).toContain('Plan Digest:');
    expect(content).toContain('Manifest Digest:');
    expect(content).toContain('Goal Ref ID: G');
    expect(content).toContain('## Authority References');
    expect(content).toContain('Ref IDs: A, S, O');
    expect(content).toContain('## Task Evidence');
    expect(content).toContain('## Current Slice Evidence');
    expect(content).toContain('## Current CV Status');
    expect(content).not.toContain('cv_minimum_level');
    expect(content).not.toContain('Proof Profile');
  });

  it('never overwrites a non-empty existing file and rejects an empty one', () => {
    const fx = makeFixture();
    fs.mkdirSync(fx.evidence, { recursive: true });
    const target = path.join(fx.evidence, 'S04-A.md');
    fs.writeFileSync(target, 'precious', 'utf8');
    const skipped = initializeVNextSliceEvidence(fx.manifest, fx.evidence, fx.root);
    expect(skipped.success).toBe(true);
    expect(skipped.initialized).toEqual([]);
    expect(skipped.skipped).toEqual([target]);
    expect(fs.readFileSync(target, 'utf8')).toBe('precious');

    fs.writeFileSync(target, '', 'utf8');
    const empty = initializeVNextSliceEvidence(fx.manifest, fx.evidence, fx.root);
    expect(empty.success).toBe(false);
    expect(empty.errors.some((error) => error.type === 'EVIDENCE_WRITE_FAILED')).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('');
  });

  it('fails closed for duplicate/out-of-root manifest paths before creating evidence', () => {
    const fx = makeFixture();
    const manifest = JSON.parse(fs.readFileSync(fx.manifest, 'utf8')) as Record<string, unknown>;
    const slices = manifest.slices as Array<Record<string, unknown>>;
    slices[0].evidence_path = '../outside.md';
    fs.writeFileSync(fx.manifest, JSON.stringify(manifest), 'utf8');
    const result = initializeVNextSliceEvidence(fx.manifest, fx.evidence, fx.root);
    expect(result.success).toBe(false);
    expect(result.initialized).toEqual([]);
    expect(fs.existsSync(fx.evidence)).toBe(false);
  });

  it('rejects a v1 manifest and an evidence-dir escape without writes', () => {
    const fx = makeFixture();
    const manifest = JSON.parse(fs.readFileSync(fx.manifest, 'utf8')) as Record<string, unknown>;
    delete manifest.version;
    fs.writeFileSync(fx.manifest, JSON.stringify(manifest), 'utf8');
    const old = initializeVNextSliceEvidence(fx.manifest, fx.evidence, fx.root);
    expect(old.success).toBe(false);
    expect(old.stage_id).toBe('S04');
    expect(old.initialized).toEqual([]);

    const fresh = makeFixture();
    const escape = initializeVNextSliceEvidence(fresh.manifest, path.join(fresh.root, '..'), fresh.root);
    expect(escape.success).toBe(false);
    expect(escape.initialized).toEqual([]);
    expect(fs.existsSync(fresh.evidence)).toBe(false);
  });

  it('dist entry emits bounded JSON and is callable after build', () => {
    const fx = makeFixture();
    const dist = path.join(path.resolve(__dirname, '..', '..', '..', '..'), 'packages', 'runtime', 'dist', 'cli', 'initialize-vnext-slice-evidence.js');
    const result = spawnSync(process.execPath, [dist, fx.manifest, fx.evidence, fx.root], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ success: true, stage_id: 'S04' });
  });

  it('usage is a bounded JSON failure', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (value?: unknown) => lines.push(String(value));
    try {
      expect(initializeVNextSliceEvidenceCli([])).toBe(1);
    } finally {
      console.log = original;
    }
    expect(JSON.parse(lines[0])).toMatchObject({ success: false, stage_id: 'unknown' });
  });
});
