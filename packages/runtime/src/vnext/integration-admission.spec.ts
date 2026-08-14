import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  admitIntegration,
  admitVNextCVResult,
  admitVNextIntegration,
  admitVNextStagePlan,
  admitVNextWorkerResult,
  computeVNextSpvPassReceiptDigest,
  defaultReceiptWriter,
  resolveVNextReference,
  VNextNextActionService,
} from '@proofloop/runtime';
import type { ReceiptWriterPort, VNextSpvPassReceipt } from '@proofloop/runtime';
import { computeDigest } from '@proofloop/kernel';
import { admitVNextSliceCommit } from './commit-admission';
import { validateVNextIntegrationRequest } from './integration-admission';
import { admitRequest } from '../cli/admit';

const repo = path.resolve(__dirname, '../../../..');
const roots: string[] = [];

/**
 * Directory-level test scope with 14 code/test files: the Worker fact declares
 * 16 files (Evidence + Plan projection + these 14), mirroring the scale of a
 * real Slice such as S08-E so the REPAIR-extra-file admission path is
 * exercised against a committed superset rather than a trivial 3-file diff.
 */
const DECLARED_WIDE_SCOPE_TEST_FILES = Array.from(
  { length: 14 },
  (_, index) => `packages/worker-file-${String(index + 1).padStart(2, '0')}.ts`,
);

/** REPAIR-only files: modified by the Worker repair, never declared by a Worker fact. */
const REPAIR_EXTRA_FILES = [
  'packages/types.ts',
  'packages/gate-admission.ts',
  'packages/gate-admission.spec.ts',
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function copyFixture(root: string, relative: string): void {
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(repo, relative), destination);
}

interface IntegrationFixture {
  readonly root: string;
  readonly snapshotDigest: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly contextRef: string;
  readonly contextDigest: string;
  readonly workerReceiptDigest: string;
  readonly cvReceiptDigest: string;
  readonly sliceCommitReceiptDigest: string;
  readonly commitSha: string;
}

function prepareFixture(options: {
  readonly cvHistory?: 'PASS' | 'REPAIR_RECHECK';
  /** Directory-level test scope whose committed boundary carries REPAIR-only extra files. */
  readonly repairFiles?: boolean;
} = {}): IntegrationFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-integration-admission-')));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-integration@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Integration Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');

  for (const relative of [
    'delivery/stages/S04/tasks.md',
    '.proofloop/manifests/S04.json',
    'delivery/stages/S04/evidence/S04-A.md',
    'delivery/stages/S0-A/tasks.md',
  ]) copyFixture(root, relative);

  const tasksPath = path.join(root, 'delivery/stages/S04/tasks.md');
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace(
      '- Worker Status: `NOT_STARTED`',
      '- Worker Status: `planned`',
    ),
    'utf8',
  );

  const manifestPath = path.join(root, '.proofloop/manifests/S04.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  manifest.task_scopes = {
    'S04-A-T01': {
      task_ref: 'delivery/stages/S04/tasks.md#/entities/S04-A-T01',
      execution_scope: {
        kind: 'implementation',
        code_paths: ['delivery/stages/S04/tasks.md'],
        test_paths: options.repairFiles ? ['packages'] : ['packages/worker-test.ts'],
        forbidden_paths: ['.proofloop/receipts', '.git'],
      },
    },
  };
  fs.mkdirSync(path.join(root, 'packages'), { recursive: true });
  for (const relative of options.repairFiles ? DECLARED_WIDE_SCOPE_TEST_FILES : ['packages/worker-test.ts']) {
    fs.writeFileSync(path.join(root, relative), 'export const fixture = true;\n', 'utf8');
  }
  for (const descriptor of Object.values(manifest.reference_index as Record<string, any>)) {
    const resolved = resolveVNextReference({ root, ref: descriptor.ref, expectedKind: descriptor.kind });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'vNext integration planning boundary']);

  const snapshotDigest = git(root, ['rev-parse', 'HEAD']);
  const manifestDigest = computeDigest(manifest);
  const planDigest = manifest.plan.plan_digest as string;
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: 'S04',
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
  };
  const spv: VNextSpvPassReceipt = {
    ...spvContent,
    digest: computeVNextSpvPassReceiptDigest(spvContent),
  };
  expect(admitVNextStagePlan({
    version: 2,
    schema_version: 2,
    type: 'STAGE_PLAN_ADMISSION',
    project_root: root,
    manifest_path: '.proofloop/manifests/S04.json',
    stage_id: 'S04',
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
    spv,
  }).accepted).toBe(true);

  const next = new VNextNextActionService().nextAction({
    projectRoot: root,
    stageId: 'S04',
    snapshotDigest,
    persistContext: true,
  });
  const context = JSON.parse(fs.readFileSync(path.join(root, next.context_ref as string), 'utf8')) as {
    context_digest: string;
  };

  const evidencePath = path.join(root, 'delivery/stages/S04/evidence/S04-A.md');
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8')
      .replace('- [ ] S04-A-T01', '- [x] S04-A-T01')
      .replace('- Worker Status: `planned`', '- Worker Status: `executing`'),
    'utf8',
  );
  fs.writeFileSync(
    evidencePath,
    fs.readFileSync(evidencePath, 'utf8').replace(
      '## Task Evidence\n\n*Not yet captured.*',
      [
        '## Task Evidence',
        '',
        '### S04-A-T01',
        '',
        '- Task Goal: integration fixture',
        '- Relevant PO IDs: PO-FIXTURE',
        '- Source Snapshot: fixture-source',
        '- Current Snapshot: fixture-current',
        '- Changed Files:',
        '  - delivery/stages/S04/evidence/S04-A.md',
        '  - delivery/stages/S04/tasks.md',
        '  - packages/worker-test.ts',
        '- RED Receipt:',
        '  - Test ID: integration-red',
        '  - Command: integration-red-command',
        '  - Failure Output: integration-red-output',
        '  - Expected Failure: integration-red-expected',
        '  - Snapshot: integration-red-snapshot',
        '- GREEN Receipt:',
        '  - Test ID: integration-green',
        '  - Command: integration-green-command',
        '  - Pass Output: integration-green-output',
        '  - Snapshot: integration-green-snapshot',
        '- Status: COMPLETE',
      ].join('\n'),
    ),
    'utf8',
  );
  for (const relative of options.repairFiles ? DECLARED_WIDE_SCOPE_TEST_FILES : ['packages/worker-test.ts']) {
    fs.appendFileSync(path.join(root, relative), 'export const workerChanged = true;\n');
  }

  const proofIndex = (manifest.slices as Array<Record<string, any>>)[0].proof_index as Record<string, any>;
  const worker = admitVNextWorkerResult({
    schemaVersion: 2,
    actionToken: 'integration-worker-1',
    stageId: 'S04',
    sliceId: 'S04-A',
    taskId: 'S04-A-T01',
    mode: 'implement-task',
    outcome: 'completed',
    evidenceRef: 'delivery/stages/S04/evidence/S04-A.md',
    changedFiles: options.repairFiles
      ? [
          'delivery/stages/S04/evidence/S04-A.md',
          'delivery/stages/S04/tasks.md',
          ...DECLARED_WIDE_SCOPE_TEST_FILES,
        ]
      : [
          'delivery/stages/S04/evidence/S04-A.md',
          'delivery/stages/S04/tasks.md',
          'packages/worker-test.ts',
        ],
    verificationRuns: [],
    summary: 'integration Worker completed',
    manifestDigest: manifestDigest,
    planDigest,
    proofIndexDigest: next.proof_index_digest,
    snapshotDigest,
    contextRef: next.context_ref,
    contextDigest: context.context_digest,
  }, { projectRoot: root });
  expect(worker.accepted).toBe(true);

  const cvInput: Record<string, unknown> = {
    schema_version: 2,
    type: 'CV_RESULT',
    stage_id: 'S04',
    slice_id: 'S04-A',
    worker_receipt_digest: worker.receipt_ref,
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    proof_index_digest: next.proof_index_digest,
    context_ref: next.context_ref,
    context_digest: context.context_digest,
    snapshot_digest: snapshotDigest,
    acceptance_refs_checked: [...proofIndex.acceptance_refs],
    seam_refs_checked: [...proofIndex.seam_refs],
    oracle_refs_checked: [...proofIndex.oracle_refs],
    risk_refs_considered: (proofIndex.risk_refs as Array<Record<string, string>>).map((risk) => ({
      ref_id: risk.ref_id,
      applicability: 'APPLICABLE',
      reason: 'integration fixture binding',
    })),
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
  };
  let cv: ReturnType<typeof admitVNextCVResult>;
  if (options.cvHistory === 'REPAIR_RECHECK') {
    // A Worker repair does not produce a new Worker Receipt, so the recheck
    // PASS binds the SAME Worker tip as the preceding CV_REPAIR. The CV
    // history [REPAIR → recheck PASS] is a legal tail sequence and must not
    // be mistaken for a duplicate Worker Receipt reuse downstream.
    const repair = admitVNextCVResult({
      ...cvInput,
      verification_type: 'initial',
      verdict: 'REPAIR',
      summary: 'integration CV repair required',
      failed_acceptance_refs: [...proofIndex.acceptance_refs],
      counterexamples: ['integration fixture counterexample'],
      failed_criterion: 'integration fixture criterion',
      failure_signature: 'integration-failure-signature',
      required_recheck_scope: ['packages/worker-test.ts'],
    }, { projectRoot: root });
    expect(repair.accepted).toBe(true);
    // The Worker repair modifies files without producing a new Worker fact:
    // the REPAIR-requested files below are committed with the Slice boundary
    // even though no Worker receipt declared them.
    if (options.repairFiles === true) {
      for (const relative of REPAIR_EXTRA_FILES) {
        fs.writeFileSync(path.join(root, relative), 'export const repaired = true;\n', 'utf8');
      }
    }
    cv = admitVNextCVResult({
      ...cvInput,
      verification_type: 'recheck',
      verdict: 'PASS',
      summary: 'integration CV recheck passed',
      previous_failure_signature: 'integration-failure-signature',
      repair_diff_digest: 'd'.repeat(64),
    }, { projectRoot: root });
    expect(cv.accepted).toBe(true);
  } else {
    cv = admitVNextCVResult({
      ...cvInput,
      verification_type: 'initial',
      verdict: 'PASS',
      summary: 'integration CV passed',
    }, { projectRoot: root });
    expect(cv.accepted).toBe(true);
  }

  execFileSync('git', [
    '-C', root,
    'add',
    'delivery/stages/S04/tasks.md',
    'delivery/stages/S04/evidence/S04-A.md',
    ...(options.repairFiles ? [...DECLARED_WIDE_SCOPE_TEST_FILES, ...REPAIR_EXTRA_FILES] : ['packages/worker-test.ts']),
  ]);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'slice-output: S04-S04-A']);
  const commitSha = git(root, ['rev-parse', 'HEAD']);
  const sliceCommit = admitVNextSliceCommit({
    type: 'slice_commit',
    stageId: 'S04',
    sliceId: 'S04-A',
    commitSha,
    cvReceiptDigest: cv.receipt_ref as string,
  }, { projectRoot: root });
  expect(sliceCommit.accepted).toBe(true);

  const committerFiles = fs.readdirSync(path.join(root, '.proofloop/receipts/committer/S04/S04-A'))
    .filter((name) => name.endsWith('.json'));
  return {
    root,
    snapshotDigest,
    manifestDigest,
    planDigest,
    proofIndexDigest: next.proof_index_digest as string,
    contextRef: next.context_ref as string,
    contextDigest: context.context_digest,
    workerReceiptDigest: worker.receipt_ref as string,
    cvReceiptDigest: cv.receipt_ref as string,
    sliceCommitReceiptDigest: path.basename(committerFiles[0] ?? '').replace('.json', ''),
    commitSha,
  };
}

function integrationFiles(fixture: IntegrationFixture): string[] {
  const directory = path.join(fixture.root, '.proofloop/receipts/integration/S04/S04-A');
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json')) : [];
}

function injectedWriter(
  mutateAfterWrite: (fixture: IntegrationFixture, writtenPath: string) => void,
  fixture: IntegrationFixture,
): ReceiptWriterPort {
  return {
    verifyChain: (receiptDir) => defaultReceiptWriter.verifyChain(receiptDir),
    write: (data, options) => {
      const written = defaultReceiptWriter.write(data, options);
      mutateAfterWrite(fixture, written.path);
      return written;
    },
  };
}

describe('vNext Integration admission', () => {
  it('admits the persisted Worker → CV → Slice Commit prefix through the public consumer', () => {
    const fixture = prepareFixture();
    const result = admitVNextIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
    }, { projectRoot: fixture.root });

    expect(result).toMatchObject({ accepted: true, receipt_ref: expect.stringMatching(/^[a-f0-9]{64}$/), new_state: null });
    expect(result.vnext_state).toEqual({
      schema_version: 2,
      type: 'INTEGRATION_RESULT',
      action: 'INTEGRATION',
      stage_id: 'S04',
      slice_id: 'S04-A',
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      proof_index_digest: fixture.proofIndexDigest,
      snapshot_digest: fixture.snapshotDigest,
      commit_sha: fixture.commitSha,
      slice_commit_receipt_digest: fixture.sliceCommitReceiptDigest,
      worker_receipt_digest: fixture.workerReceiptDigest,
      cv_receipt_digest: fixture.cvReceiptDigest,
      changed_files: [
        'delivery/stages/S04/evidence/S04-A.md',
        'delivery/stages/S04/tasks.md',
        'packages/worker-test.ts',
      ],
      receipt_chain_valid: true,
    });
    expect(integrationFiles(fixture)).toHaveLength(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.root, '.proofloop/receipts/integration/S04/S04-A', `${result.receipt_ref}.json`),
      'utf8',
    )) as Record<string, unknown>;
    expect(receipt.type).toBe('INTEGRATION_PASS');
    expect(receipt.payload).toEqual(result.vnext_state);
  });

  it('admits Integration after a REPAIR → recheck PASS bound to the same Worker Receipt tip', () => {
    // A Worker repair does not produce a new Worker Receipt, so the recheck
    // PASS binds the SAME Worker tip as the preceding CV_REPAIR. The CV
    // history [REPAIR → recheck PASS] must flow through Slice Commit and
    // Integration without being mistaken for a duplicate Worker Receipt reuse.
    const fixture = prepareFixture({ cvHistory: 'REPAIR_RECHECK' });
    const result = admitVNextIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(result.vnext_state).toMatchObject({
      action: 'INTEGRATION',
      stage_id: 'S04',
      slice_id: 'S04-A',
      worker_receipt_digest: fixture.workerReceiptDigest,
      cv_receipt_digest: fixture.cvReceiptDigest,
      receipt_chain_valid: true,
    });
    expect(integrationFiles(fixture)).toHaveLength(1);
  });

  it('admits Integration when the committed boundary includes REPAIR-only files beyond the declared Worker facts', () => {
    // The REPAIR→recheck tail admits repair files that no Worker fact
    // declared (the S08-E shape: types.ts / gate-admission.ts /
    // gate-admission.spec.ts). Both the Slice Commit boundary and the
    // Integration boundary carry the committed superset while every path
    // stays inside the admitted scope.
    const fixture = prepareFixture({ cvHistory: 'REPAIR_RECHECK', repairFiles: true });
    const result = admitVNextIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(result.vnext_state?.changed_files).toHaveLength(
      DECLARED_WIDE_SCOPE_TEST_FILES.length + 2 + REPAIR_EXTRA_FILES.length,
    );
    expect(result.vnext_state?.changed_files).toEqual(expect.arrayContaining([...REPAIR_EXTRA_FILES]));
    expect(integrationFiles(fixture)).toHaveLength(1);
  });

  it('admits Integration when HEAD has advanced past the Slice commit boundary', () => {
    // In a multi-Slice chain Integration is admitted once per Slice after the
    // unified execution pass: by the time a Slice is integrated, HEAD may
    // already have advanced past that Slice's committed boundary (later Slice
    // commits or post-slice fix commits). The integrated commit must be an
    // ancestor of (or equal to) HEAD — the same contract the Gate applies to
    // each Slice's integrated commit (gate-admission.ts assertAncestor) — not
    // necessarily HEAD itself.
    const fixture = prepareFixture();
    fs.appendFileSync(path.join(fixture.root, 'packages/worker-test.ts'), 'export const laterFix = true;\n');
    git(fixture.root, ['add', 'packages/worker-test.ts']);
    git(fixture.root, ['commit', '-m', 'fix: post-slice fix commit']);
    expect(git(fixture.root, ['rev-parse', 'HEAD'])).not.toBe(fixture.commitSha);

    const result = admitVNextIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(result.vnext_state).toMatchObject({
      action: 'INTEGRATION',
      stage_id: 'S04',
      slice_id: 'S04-A',
      commit_sha: fixture.commitSha,
      receipt_chain_valid: true,
    });
    expect(integrationFiles(fixture)).toHaveLength(1);
  });

  it('rejects Integration when commit_sha is not an ancestor of the current HEAD', () => {
    // An unrelated (orphan) HEAD: the Slice commit is neither HEAD nor an
    // ancestor of it, so the integrated boundary must fail closed even though
    // every Receipt fact matches the Slice.
    const fixture = prepareFixture();
    const orphan = git(fixture.root, ['commit-tree', 'HEAD^{tree}', '-m', 'unrelated head']);
    git(fixture.root, ['reset', '--hard', orphan]);
    expect(git(fixture.root, ['rev-parse', 'HEAD'])).not.toBe(fixture.commitSha);

    const result = admitVNextIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
    }, { projectRoot: fixture.root });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(integrationFiles(fixture)).toHaveLength(0);
  });

  it('rejects duplicate, wrong boundary, dirty, and mismatched requests without a second Receipt', () => {
    const fixture = prepareFixture();
    const admitted = admitVNextIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
    }, { projectRoot: fixture.root });
    expect(admitted.accepted).toBe(true);

    const duplicate = admitVNextIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
    }, { projectRoot: fixture.root });
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.receipt_ref).toBeNull();
    expect(integrationFiles(fixture)).toHaveLength(1);

    const wrongCommit = admitVNextIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.snapshotDigest,
    }, { projectRoot: fixture.root });
    expect(wrongCommit.accepted).toBe(false);

    const dirtyRoot = prepareFixture();
    fs.writeFileSync(path.join(dirtyRoot.root, 'uncommitted.txt'), 'dirty\n', 'utf8');
    const dirty = admitVNextIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: dirtyRoot.commitSha,
    }, { projectRoot: dirtyRoot.root });
    expect(dirty.accepted).toBe(false);
    expect(integrationFiles(dirtyRoot)).toHaveLength(0);
  });

  it('routes the Runtime Integration seam to vNext and never calls legacy reconcile/reducer', () => {
    const fixture = prepareFixture();
    const result = admitIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
    }, {
      projectRoot: fixture.root,
      reconcile: () => { throw new Error('legacy reconcile must not run'); },
      reduce: () => { throw new Error('legacy reducer must not run'); },
      manifestRouteBinding: 'vnext',
    });
    expect(result.accepted).toBe(true);
    expect(result.new_state).toBeNull();
    expect(result.vnext_state).toMatchObject({ type: 'INTEGRATION_RESULT', action: 'INTEGRATION' });
  });

  it('routes the public Runtime CLI admit seam to the vNext Integration consumer', () => {
    const fixture = prepareFixture();
    const result = admitRequest({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
    }, fixture.root);
    expect(result.accepted).toBe(true);
    expect(result.new_state).toBeNull();
    expect(result.vnext_state).toMatchObject({
      schema_version: 2,
      type: 'INTEGRATION_RESULT',
      action: 'INTEGRATION',
      commit_sha: fixture.commitSha,
    });
    expect(integrationFiles(fixture)).toHaveLength(1);
  });

  it('rejects a v1 route instead of allowing a vNext Integration fact into the legacy consumer', () => {
    const fixture = prepareFixture();
    fs.writeFileSync(
      path.join(fixture.root, '.proofloop/manifests/S04.json'),
      JSON.stringify({ version: 1 }),
      'utf8',
    );
    let reconcileCalls = 0;
    const result = admitIntegration({
      type: 'integration',
      stageId: 'S04',
      sliceId: 'S04-A',
      commitSha: fixture.commitSha,
    }, {
      projectRoot: fixture.root,
      manifestRouteBinding: 'vnext',
      reconcile: () => { reconcileCalls += 1; throw new Error('must not reconcile'); },
    });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(reconcileCalls).toBe(0);
    expect(integrationFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Manifest route change made before the injected writer and preserves the competitor file', () => {
    const fixture = prepareFixture();
    const manifestPath = path.join(fixture.root, '.proofloop/manifests/S04.json');
    const competitorDir = path.join(fixture.root, '.proofloop/receipts/integration/S04/S04-A');
    const competitorPath = path.join(competitorDir, 'competitor.json');
    let verifyCalls = 0;
    let writeCalls = 0;
    const writer: ReceiptWriterPort = {
      verifyChain: (receiptDir) => {
        const result = defaultReceiptWriter.verifyChain(receiptDir);
        verifyCalls += 1;
        if (verifyCalls === 1) {
          fs.writeFileSync(manifestPath, JSON.stringify({ version: 1 }), 'utf8');
          fs.writeFileSync(competitorPath, 'competitor remains\n', 'utf8');
        }
        return result;
      },
      write: (data, options) => {
        writeCalls += 1;
        return defaultReceiptWriter.write(data, options);
      },
    };

    const result = admitVNextIntegration(
      {
        type: 'integration',
        stageId: 'S04',
        sliceId: 'S04-A',
        commitSha: fixture.commitSha,
      },
      { projectRoot: fixture.root, writer },
    );

    expect(result).toMatchObject({ accepted: false, receipt_ref: null });
    expect(writeCalls).toBe(0);
    expect(fs.readFileSync(competitorPath, 'utf8')).toBe('competitor remains\n');
    expect(integrationFiles(fixture)).toHaveLength(1);
  });

  it.each([
    ['Manifest route', (fixture: IntegrationFixture) => {
      fs.writeFileSync(
        path.join(fixture.root, '.proofloop/manifests/S04.json'),
        JSON.stringify({ version: 1 }),
        'utf8',
      );
    }],
    ['Git boundary', (fixture: IntegrationFixture) => {
      fs.writeFileSync(path.join(fixture.root, 'integration-dirty.txt'), 'dirty during write\n', 'utf8');
    }],
    ['Worker fact', (fixture: IntegrationFixture) => {
      const workerPath = path.join(
        fixture.root,
        '.proofloop/receipts/tasks/S04/S04-A',
        `${fixture.workerReceiptDigest}.json`,
      );
      const receipt = JSON.parse(fs.readFileSync(workerPath, 'utf8')) as Record<string, unknown>;
      receipt.payload = { ...(receipt.payload as Record<string, unknown>), summary: 'changed during write' };
      fs.writeFileSync(workerPath, JSON.stringify(receipt), 'utf8');
    }],
  ])('rejects an Integration fact changed during the injected write (%s) without a new Receipt', (_label, mutate) => {
    const fixture = prepareFixture();
    const writer = injectedWriter(mutate, fixture);

    const result = admitVNextIntegration(
      {
        type: 'integration',
        stageId: 'S04',
        sliceId: 'S04-A',
        commitSha: fixture.commitSha,
      },
      { projectRoot: fixture.root, writer },
    );

    expect(result).toMatchObject({ accepted: false, receipt_ref: null });
    expect(integrationFiles(fixture)).toHaveLength(0);
  });
});

describe('S09-C-T03 — Integration admission rejects legacy stage labels before any read/write', () => {
  it('rejects an Integration request whose stageId is the parked S08B0 label', () => {
    expect(() =>
      validateVNextIntegrationRequest({
        type: 'integration',
        stageId: 'S08B0',
        sliceId: 'S08-C',
        commitSha: 'a'.repeat(40),
      }),
    ).toThrowError(/canonical Stage ID/);
  });

  it('rejects an Integration request whose stageId is the parked S08B label', () => {
    expect(() =>
      validateVNextIntegrationRequest({
        type: 'integration',
        stageId: 'S08B',
        sliceId: 'S08-C',
        commitSha: 'a'.repeat(40),
      }),
    ).toThrowError(/canonical Stage ID/);
  });
});
