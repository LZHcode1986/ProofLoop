import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeDigest } from '@proofloop/kernel';
import { compileVNextManifestCli } from './compile-vnext-manifest';
import { initializeVNextSliceEvidence } from './initialize-vnext-slice-evidence';
import { validateVNextStage, validateVNextStageCli } from './validate-vnext-stage';
import { refreshVNextSliceEvidence, REFRESH_JOURNAL_FILE } from '../vnext/evidence-refresh';
import { type CompileVNextManifestInput } from '../vnext';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function fixture(): { root: string; input: CompileVNextManifestInput; request: string; manifest: string; tasks: string; evidence: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-vnext-validate-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const refs = [
    '<!-- proofloop:entity id="goal" kind="goal" -->',
    'goal',
     '<!-- proofloop:entity id="S04-A-T01" kind="task" -->',
    'task',
    '<!-- proofloop:entity id="accept" kind="acceptance" -->',
    'acceptance',
    '<!-- proofloop:entity id="seam" kind="seam" -->',
    'seam',
    '<!-- proofloop:entity id="oracle" kind="oracle" -->',
    'oracle',
    '<!-- proofloop:entity id="risk" kind="risk" -->',
    'risk',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'refs.md'), refs, 'utf8');
  const tasks = path.join(root, 'delivery', 'stages', 'S04', 'tasks.md');
  fs.mkdirSync(path.dirname(tasks), { recursive: true });
  fs.writeFileSync(tasks, '# This body is not parsed by the vNext validator\n', 'utf8');
  const evidence = path.join(root, 'delivery', 'stages', 'S04', 'evidence');
  const input: CompileVNextManifestInput = {
    root,
    stage_id: 'S04',
    plan_path: 'delivery/stages/S04/tasks.md',
    plan: {
      schema_version: 2,
      items: [
        {
          id: 'S04-A-T01',
          kind: 'task',
          goal: 'vNext validate',
          refs: ['REF-T'],
          dependencies: [],
          required_skills: ['testing'],
          execution_scope: {
            kind: 'implementation',
            code_paths: ['packages/runtime/src/cli/validate-vnext-stage.ts'],
            test_paths: ['packages/runtime/src/cli/validate-vnext-stage.spec.ts'],
            forbidden_paths: ['.proofloop/receipts'],
          },
        },
      ],
    },
    refs: [
      { ref_id: 'REF-G', kind: 'goal', ref: 'refs.md#/entities/goal' },
       { ref_id: 'REF-T', kind: 'task', ref: 'refs.md#/entities/S04-A-T01' },
      { ref_id: 'REF-A', kind: 'acceptance', ref: 'refs.md#/entities/accept' },
      { ref_id: 'REF-S', kind: 'seam', ref: 'refs.md#/entities/seam' },
      { ref_id: 'REF-O', kind: 'oracle', ref: 'refs.md#/entities/oracle' },
      { ref_id: 'REF-R', kind: 'risk', ref: 'refs.md#/entities/risk' },
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
  const request = path.join(root, 'request.json');
  fs.writeFileSync(request, JSON.stringify(input), 'utf8');
  const manifest = path.join(root, 'delivery', 'stages', 'S04', 'manifest.json');
  expect(compileVNextManifestCli([request, manifest, root])).toBe(0);
  expect(initializeVNextSliceEvidence(manifest, evidence, root).success).toBe(true);
  return { root, input, request, manifest, tasks, evidence };
}

describe('validate-vnext-stage read-only mechanical gate', () => {
  it('accepts a compiled vNext manifest and existing declared evidence', () => {
    const fx = fixture();
    const before = fs.readFileSync(path.join(fx.evidence, 'S04-A.md'), 'utf8');
    const result = validateVNextStage(fx.tasks, fx.manifest, fx.evidence, fx.root);
    expect(result).toEqual({
      valid: true,
      stage_id: 'S04',
      schema_version: 2,
      errors: [],
    });
    expect(fs.readFileSync(path.join(fx.evidence, 'S04-A.md'), 'utf8')).toBe(before);
  });

  it('does not infer a stage plan from Markdown and binds plan.ref to the source path', () => {
    const fx = fixture();
    fs.writeFileSync(fx.tasks, '# Stage S99\n## Goal\nA misleading body\n', 'utf8');
    const result = validateVNextStage(fx.tasks, fx.manifest, fx.evidence, fx.root);
    // The only stage source is the root-relative path; the Markdown body is
    // not parsed and therefore cannot change the vNext identity.
    expect(result.valid).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(fx.manifest, 'utf8')) as Record<string, unknown>;
    (manifest.plan as Record<string, unknown>).ref = 'other/tasks.md';
    fs.writeFileSync(fx.manifest, JSON.stringify(manifest), 'utf8');
    const mismatch = validateVNextStage(fx.tasks, fx.manifest, fx.evidence, fx.root);
    expect(mismatch.valid).toBe(false);
    expect(mismatch.errors.some((error) => error.type === 'PLAN_REF_MISMATCH')).toBe(true);
  });

  it('rejects missing and orphan evidence without writing anything', () => {
    const fx = fixture();
    const declared = path.join(fx.evidence, 'S04-A.md');
    fs.unlinkSync(declared);
    fs.writeFileSync(path.join(fx.evidence, 'ORPHAN.md'), 'orphan', 'utf8');
    const result = validateVNextStage(fx.tasks, fx.manifest, fx.evidence, fx.root);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.type === 'MISSING_EVIDENCE_FILE')).toBe(true);
    expect(result.errors.some((error) => error.type === 'ORPHANED_EVIDENCE')).toBe(true);
    expect(fs.readFileSync(path.join(fx.evidence, 'ORPHAN.md'), 'utf8')).toBe('orphan');
  });

  it('rejects a valid-shaped but incorrect reference digest and a v1 manifest', () => {
    const fx = fixture();
    const manifest = JSON.parse(fs.readFileSync(fx.manifest, 'utf8')) as Record<string, unknown>;
    const index = manifest.reference_index as Record<string, Record<string, unknown>>;
    index['REF-T'].file_digest = 'f'.repeat(64);
    fs.writeFileSync(fx.manifest, JSON.stringify(manifest), 'utf8');
    const digestResult = validateVNextStage(fx.tasks, fx.manifest, fx.evidence, fx.root);
    expect(digestResult.valid).toBe(false);
    expect(digestResult.errors.some((error) => error.type === 'FILE_DIGEST_MISMATCH')).toBe(true);

    delete manifest.version;
    fs.writeFileSync(fx.manifest, JSON.stringify(manifest), 'utf8');
    const v1Result = validateVNextStage(fx.tasks, fx.manifest, fx.evidence, fx.root);
    expect(v1Result.valid).toBe(false);
    expect(v1Result.schema_version).toBe(2);
    expect(v1Result.errors[0]?.type).toBe('SCHEMA_INVALID');
  });

  it('dist entry emits the explicit vNext schema result and exit code', () => {
    const fx = fixture();
    const dist = path.join(path.resolve(__dirname, '..', '..', '..', '..'), 'packages', 'runtime', 'dist', 'cli', 'validate-vnext-stage.js');
    const result = spawnSync(process.execPath, [dist, fx.tasks, fx.manifest, fx.evidence, fx.root], {
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ valid: true, stage_id: 'S04', schema_version: 2 });
  });

  it('usage is a JSON failure, not a v1 PASS', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (value?: unknown) => lines.push(String(value));
    try {
      expect(validateVNextStageCli([])).toBe(1);
    } finally {
      console.log = original;
    }
    expect(JSON.parse(lines[0])).toMatchObject({ valid: false, schema_version: 2 });
  });
});

describe('S09-C-T03 — mechanical validator rejects legacy stage labels before any read/write', () => {
  it('rejects a compiled manifest whose stage_id is the parked S08B0 label', () => {
    const fx = fixture();
    const manifest = JSON.parse(fs.readFileSync(fx.manifest, 'utf8')) as Record<string, unknown>;
    manifest.stage_id = 'S08B0';
    fs.writeFileSync(fx.manifest, JSON.stringify(manifest), 'utf8');
    const result = validateVNextStage(fx.tasks, fx.manifest, fx.evidence, fx.root);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.type === 'STAGE_ID_INVALID')).toBe(true);
  });

  it('rejects a compiled manifest whose stage_id is the parked S08B label', () => {
    const fx = fixture();
    const manifest = JSON.parse(fs.readFileSync(fx.manifest, 'utf8')) as Record<string, unknown>;
    manifest.stage_id = 'S08B';
    fs.writeFileSync(fx.manifest, JSON.stringify(manifest), 'utf8');
    const result = validateVNextStage(fx.tasks, fx.manifest, fx.evidence, fx.root);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.type === 'STAGE_ID_INVALID')).toBe(true);
  });
});

describe('S09-D-T01 — final all-binding Validator rejects mixed Evidence bindings', () => {
  interface TwoSliceFixture {
    readonly root: string;
    readonly manifestV1: string;
    readonly manifestV2: string;
    readonly tasks: string;
    readonly evidenceDir: string;
    readonly evidenceA: string;
    readonly evidenceB: string;
    readonly digestV1: string;
    readonly digestV2: string;
  }

  function buildInput(root: string, versionMarker: string): CompileVNextManifestInput {
    const refs = [
      '<!-- proofloop:entity id="goal" kind="goal" -->',
      `goal ${versionMarker}`,
      '<!-- proofloop:entity id="S04-A-T01" kind="task" -->',
      `task A ${versionMarker}`,
      '<!-- proofloop:entity id="S04-B-T01" kind="task" -->',
      `task B ${versionMarker}`,
      '<!-- proofloop:entity id="accept" kind="acceptance" -->',
      'acceptance',
      '<!-- proofloop:entity id="seam" kind="seam" -->',
      'seam',
      '<!-- proofloop:entity id="oracle" kind="oracle" -->',
      'oracle',
      '<!-- proofloop:entity id="risk" kind="risk" -->',
      'risk',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'refs.md'), refs, 'utf8');
    const tasks = path.join(root, 'delivery', 'stages', 'S04', 'tasks.md');
    fs.mkdirSync(path.dirname(tasks), { recursive: true });
    fs.writeFileSync(tasks, '# This body is not parsed by the vNext validator\n', 'utf8');
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
            goal: `slice A goal ${versionMarker}`,
            refs: ['REF-TA'],
            dependencies: [],
            required_skills: [],
            execution_scope: {
              kind: 'implementation',
              code_paths: ['packages/runtime/src/vnext/evidence-refresh.ts'],
              test_paths: ['packages/runtime/src/cli/refresh-vnext-slice-evidence.spec.ts'],
              forbidden_paths: ['.proofloop/receipts'],
            },
          },
          {
            id: 'S04-B-T01',
            kind: 'task',
            goal: `slice B goal ${versionMarker}`,
            refs: ['REF-TB'],
            dependencies: [],
            required_skills: [],
            execution_scope: {
              kind: 'implementation',
              code_paths: ['packages/runtime/src/vnext/evidence-refresh.ts'],
              test_paths: ['packages/runtime/src/cli/refresh-vnext-slice-evidence.spec.ts'],
              forbidden_paths: ['.proofloop/receipts'],
            },
          },
        ],
      },
      refs: [
        { ref_id: 'REF-G', kind: 'goal', ref: 'refs.md#/entities/goal' },
        { ref_id: 'REF-TA', kind: 'task', ref: 'refs.md#/entities/S04-A-T01' },
        { ref_id: 'REF-TB', kind: 'task', ref: 'refs.md#/entities/S04-B-T01' },
        { ref_id: 'REF-A', kind: 'acceptance', ref: 'refs.md#/entities/accept' },
        { ref_id: 'REF-S', kind: 'seam', ref: 'refs.md#/entities/seam' },
        { ref_id: 'REF-O', kind: 'oracle', ref: 'refs.md#/entities/oracle' },
        { ref_id: 'REF-R', kind: 'risk', ref: 'refs.md#/entities/risk' },
      ],
      authority_ref_ids: ['REF-A', 'REF-S', 'REF-O'],
      slices: [
        {
          slice_id: 'S04-A',
          proof_index: {
            slice_id: 'S04-A',
            goal_ref: 'REF-G',
            task_refs: ['REF-TA'],
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
          required_skills: [],
          depends_on: [],
          evidence_path: 'delivery/stages/S04/evidence/S04-A.md',
        },
        {
          slice_id: 'S04-B',
          proof_index: {
            slice_id: 'S04-B',
            goal_ref: 'REF-G',
            task_refs: ['REF-TB'],
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
          required_skills: [],
          depends_on: [],
          evidence_path: 'delivery/stages/S04/evidence/S04-B.md',
        },
      ],
    };
  }

  function makeTwoSliceFixture(): TwoSliceFixture {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-vnext-validate-bind-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const manifestV1 = path.join(root, 'delivery', 'stages', 'S04', 'manifest-v1.json');
    const manifestV2 = path.join(root, 'delivery', 'stages', 'S04', 'manifest-v2.json');
    const tasks = path.join(root, 'delivery', 'stages', 'S04', 'tasks.md');
    const evidenceDir = path.join(root, 'delivery', 'stages', 'S04', 'evidence');
    const requestV1 = path.join(root, 'request-v1.json');
    fs.writeFileSync(requestV1, JSON.stringify(buildInput(root, 'v1')), 'utf8');
    expect(compileVNextManifestCli([requestV1, manifestV1, root])).toBe(0);
    expect(initializeVNextSliceEvidence(manifestV1, evidenceDir, root).success).toBe(true);
    const requestV2 = path.join(root, 'request-v2.json');
    fs.writeFileSync(requestV2, JSON.stringify(buildInput(root, 'v2')), 'utf8');
    expect(compileVNextManifestCli([requestV2, manifestV2, root])).toBe(0);
    return {
      root,
      manifestV1,
      manifestV2,
      tasks,
      evidenceDir,
      evidenceA: path.join(evidenceDir, 'S04-A.md'),
      evidenceB: path.join(evidenceDir, 'S04-B.md'),
      digestV1: computeDigest(JSON.parse(fs.readFileSync(manifestV1, 'utf8'))),
      digestV2: computeDigest(JSON.parse(fs.readFileSync(manifestV2, 'utf8'))),
    };
  }

  it('accepts a fully refreshed set where every evidence file binds to the current Manifest', () => {
    const fx = makeTwoSliceFixture();
    const refresh = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(refresh.success).toBe(true);
    const result = validateVNextStage(fx.tasks, fx.manifestV2, fx.evidenceDir, fx.root);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a mixed binding: one file on the previous Manifest digest next to one on the current digest', () => {
    const fx = makeTwoSliceFixture();
    // Refresh BOTH files to the V2 binding, then put file A back on the V1
    // binding — the exact mixed state a partial/never-run refresh leaves.
    const refresh = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(refresh.success).toBe(true);
    const refreshedA = fs.readFileSync(fx.evidenceA, 'utf8');
    expect(refreshedA).toContain(`Manifest Digest: ${fx.digestV2}`);
    fs.writeFileSync(fx.evidenceA, refreshedA.replace(`Manifest Digest: ${fx.digestV2}`, `Manifest Digest: ${fx.digestV1}`), 'utf8');
    expect(fs.readFileSync(fx.evidenceB, 'utf8')).toContain(`Manifest Digest: ${fx.digestV2}`);

    const result = validateVNextStage(fx.tasks, fx.manifestV2, fx.evidenceDir, fx.root);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.type === 'EVIDENCE_BINDING_MISMATCH')).toBe(true);
  });

  it('rejects an unrecovered refresh journal until the transaction is recovered or rolled back', () => {
    const fx = makeTwoSliceFixture();
    const identityOf = (file: string): string => {
      const stat = fs.lstatSync(file);
      return `${stat.dev}:${stat.ino}`;
    };
    const oldA = fs.readFileSync(fx.evidenceA, 'utf8');
    const oldB = fs.readFileSync(fx.evidenceB, 'utf8');
    const newA = oldA.replace(`Manifest Digest: ${fx.digestV1}`, `Manifest Digest: ${fx.digestV2}`);
    const journal = {
      version: 1,
      stage_id: 'S04',
      manifest_ref: 'delivery/stages/S04/tasks.md',
      previous_manifest_digest: fx.digestV1,
      manifest_digest: fx.digestV2,
      files: [
        { name: 'S04-A.md', old: oldA, new: newA, old_identity: identityOf(fx.evidenceA) },
        { name: 'S04-B.md', old: oldB, new: newA, old_identity: identityOf(fx.evidenceB) },
      ],
    };
    // Interrupted state: file A swapped, file B still old, journal retained.
    fs.writeFileSync(fx.evidenceA, newA, 'utf8');
    fs.writeFileSync(fx.evidenceB, oldB, 'utf8');
    fs.writeFileSync(path.join(fx.evidenceDir, REFRESH_JOURNAL_FILE), JSON.stringify(journal), 'utf8');

    const result = validateVNextStage(fx.tasks, fx.manifestV2, fx.evidenceDir, fx.root);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.type === 'UNRECOVERED_TRANSACTION')).toBe(true);
  });

  it('rejects duplicate Plan Digest / Manifest Digest binding lines as an invalid binding (S09-D-T01 repair)', () => {
    const fx = makeTwoSliceFixture();
    // Rebind both files to the current Manifest, then duplicate the Manifest
    // Digest line inside file A's Plan Binding section.
    const refresh = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(refresh.success).toBe(true);
    const refreshedA = fs.readFileSync(fx.evidenceA, 'utf8');
    fs.writeFileSync(
      fx.evidenceA,
      refreshedA.replace(
        `- Manifest Digest: ${fx.digestV2}`,
        `- Manifest Digest: ${fx.digestV2}\n- Manifest Digest: ${fx.digestV2}`,
      ),
      'utf8',
    );

    const result = validateVNextStage(fx.tasks, fx.manifestV2, fx.evidenceDir, fx.root);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.type === 'EVIDENCE_BINDING_MISMATCH')).toBe(true);
  });

  it('rejects a duplicated Plan Binding section in final validation (S09-D-T01 repair round 2)', () => {
    const fx = makeTwoSliceFixture();
    // Rebind both files to the current Manifest, then append a SECOND
    // `## Plan Binding` section to file A.
    const refresh = refreshVNextSliceEvidence({
      manifestPath: fx.manifestV2,
      previousManifestDigest: fx.digestV1,
      evidenceDir: fx.evidenceDir,
      projectRoot: fx.root,
    });
    expect(refresh.success).toBe(true);
    fs.appendFileSync(fx.evidenceA, '\n## Plan Binding\n\n- Stage ID: S04\n', 'utf8');

    const result = validateVNextStage(fx.tasks, fx.manifestV2, fx.evidenceDir, fx.root);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.type === 'EVIDENCE_BINDING_MISMATCH')).toBe(true);
  });
});
