import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeDigest, validateVNextManifest, type VNextManifest } from '@proofloop/kernel';
import type { CompileVNextManifestInput } from '../vnext';
import { compileVNextManifestCli } from './compile-vnext-manifest';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function rootFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-vnext-cli-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root: string, relative: string, content: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

function input(root: string): CompileVNextManifestInput {
  write(
    root,
    'refs.md',
    [
      '<!-- proofloop:entity id="S04-goal" kind="goal" -->',
      'goal',
       '<!-- proofloop:entity id="S04-A-T01" kind="task" -->',
      'task',
      '<!-- proofloop:entity id="S04-accept" kind="acceptance" -->',
      'acceptance',
      '<!-- proofloop:entity id="S04-seam" kind="seam" -->',
      'seam',
      '<!-- proofloop:entity id="S04-oracle" kind="oracle" -->',
      'oracle',
      '<!-- proofloop:entity id="S04-risk" kind="risk" -->',
      'risk',
    ].join('\n'),
  );
  return {
    root,
    stage_id: 'S04',
    plan_path: 'delivery/stages/S04/tasks.md',
    plan: {
      schema_version: 2,
      items: [
        {
          id: 'S04-A-T01',
          kind: 'task',
          goal: 'compile a vNext plan',
          refs: ['REF-T'],
          dependencies: [],
          required_skills: ['testing'],
          execution_scope: {
            kind: 'implementation',
            code_paths: ['packages/runtime/src/vnext/compiler.ts'],
            test_paths: ['packages/runtime/src/cli/compile-vnext-manifest.spec.ts'],
            forbidden_paths: ['.proofloop/receipts'],
          },
          checkbox: false,
          status: 'pending',
          cv_status: 'NOT_STARTED',
        },
      ],
    },
    refs: [
      { ref_id: 'REF-G', kind: 'goal', ref: 'refs.md#/entities/S04-goal' },
       { ref_id: 'REF-T', kind: 'task', ref: 'refs.md#/entities/S04-A-T01' },
      { ref_id: 'REF-A', kind: 'acceptance', ref: 'refs.md#/entities/S04-accept' },
      { ref_id: 'REF-S', kind: 'seam', ref: 'refs.md#/entities/S04-seam' },
      { ref_id: 'REF-O', kind: 'oracle', ref: 'refs.md#/entities/S04-oracle' },
      { ref_id: 'REF-R', kind: 'risk', ref: 'refs.md#/entities/S04-risk' },
    ],
    authority_ref_ids: ['REF-A', 'REF-S', 'REF-O'],
    slices: [
      {
        slice_id: 'S04-A',
        proof_index: {
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
        },
        required_skills: ['testing'],
        depends_on: [],
        evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
      },
    ],
  };
}

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const distCompile = path.join(repoRoot, 'packages', 'runtime', 'dist', 'cli', 'compile-vnext-manifest.js');

describe('compile-vnext-manifest explicit JSON seam', () => {
  it('writes only a version-2 Manifest and emits bounded JSON', () => {
    const root = rootFixture();
    const requestPath = write(root, 'request.json', JSON.stringify(input(root)));
    const outputPath = path.join(root, 'delivery', 'stages', 'S04', 'manifest.json');
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (line?: unknown) => lines.push(String(line));
    try {
      expect(compileVNextManifestCli([requestPath, outputPath, root])).toBe(0);
    } finally {
      console.log = originalLog;
    }
    const result = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.manifest_path).toBe(outputPath);
    expect(result.manifest_digest).toBe(computeDigest(JSON.parse(fs.readFileSync(outputPath, 'utf8'))));
    const manifest = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as VNextManifest;
    expect(manifest.version).toBe(2);
    expect((manifest as unknown as Record<string, unknown>).root).toBeUndefined();
    expect((manifest as unknown as Record<string, unknown>).plan).toEqual({
      ref: 'delivery/stages/S04/tasks.md',
      plan_digest: expect.any(String),
      schema_version: 2,
    });
    expect(() => validateVNextManifest(manifest)).not.toThrow();
  });

  it('rejects v1-shaped / unknown-version input before any output is created', () => {
    const root = rootFixture();
    const request = input(root) as unknown as Record<string, unknown>;
    request.version = 1;
    const requestPath = write(root, 'request.json', JSON.stringify(request));
    const outputPath = path.join(root, 'manifest.json');
    const code = compileVNextManifestCli([requestPath, outputPath, root]);
    expect(code).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it('rejects a root escape without creating a half-product', () => {
    const root = rootFixture();
    const invalid = input(root) as unknown as Record<string, unknown>;
    invalid.plan_path = '../outside/tasks.md';
    const requestPath = write(root, 'request.json', JSON.stringify(invalid));
    const outputPath = path.join(root, 'manifest.json');
    expect(compileVNextManifestCli([requestPath, outputPath, root])).toBe(1);
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it('dist entry is callable and keeps stdout to one JSON result', () => {
    expect(fs.existsSync(distCompile)).toBe(true);
    const root = rootFixture();
    const requestPath = write(root, 'request.json', JSON.stringify(input(root)));
    const outputPath = path.join(root, 'manifest.json');
    const result = spawnSync(process.execPath, [distCompile, requestPath, outputPath, root], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as { success: boolean; stage_id: string };
    expect(parsed).toMatchObject({ success: true, stage_id: 'S04' });
  });
});
