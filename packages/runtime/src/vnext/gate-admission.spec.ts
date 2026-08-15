/**
 * vNext Stage Gate admission — downstream consumer tests.
 *
 * The fixture drives a complete S04 vNext prefix (Stage Plan + SPV authority,
 * Worker → CV → Slice Commit, Integration) and then exercises the Gate
 * consumer against the integrated boundary.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  admitGateResult,
  admitVNextCVResult,
  admitVNextIntegration,
  admitVNextStagePlan,
  admitVNextWorkerResult,
  computeVNextSpvPassReceiptDigest,
  computeVNextStagePlanReceiptDigest,
  defaultReceiptWriter,
  resolveVNextReference,
  VNextNextActionService,
} from '@proofloop/runtime';
import type { ReceiptWriterPort, VNextSpvPassReceipt } from '@proofloop/runtime';
import { computeDigest, computeReceiptDigest } from '@proofloop/kernel';
import { admitVNextSliceCommit } from './commit-admission';
import { admitRequest } from '../cli/admit';
import { admitVNextGateResult, validateVNextGateResultRequest } from './gate-admission';
import { admitVNextStageReview } from './review-admission';

const repo = path.resolve(__dirname, '../../../..');
const roots: string[] = [];

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

/**
 * Declared Worker-fact test files: Evidence + Plan projection + these 14,
 * mirroring the scale of a real Slice such as S08-E so the REPAIR-extra-file
 * admission path is exercised against a committed superset rather than a
 * trivial 3-file diff.
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

interface GateFixture {
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
  readonly integrationReceiptDigest: string;
  readonly commitSha: string;
}

/**
 * Gate fixture stage.  `S04` carries a canonical executable proof step (the
 * default shape after S09-REVIEW-001: an all-not_applicable proof is only
 * legal for the S09 restricted bootstrap).  `S09` carries the real S09
 * all-not_applicable restricted bootstrap Manifest/Slice so the Gate can be
 * exercised against the restricted boundary.
 */
type GateFixtureStage = 'S04' | 'S09';

function prepareFixture(options: {
  readonly cvHistory?: 'PASS' | 'REPAIR_RECHECK';
  /** Directory-level test scope whose committed boundary carries REPAIR-only extra files. */
  readonly repairFiles?: boolean;
  readonly stage?: GateFixtureStage;
} = {}): GateFixture {
  const stage: GateFixtureStage = options.stage ?? 'S04';
  const sliceId = stage === 'S09' ? 'S09-C' : 'S04-A';
  const taskId = stage === 'S09' ? 'S09-C-T01' : 'S04-A-T01';
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-gate-admission-')));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'vnext-gate@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Gate Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');

  for (const relative of [
    `delivery/stages/${stage}/tasks.md`,
    `.proofloop/manifests/S04.json`,
    `delivery/stages/${stage}/evidence/${sliceId}.md`,
    'delivery/stages/S0-A/tasks.md',
  ]) {
    if (stage === 'S09' && relative === `delivery/stages/S09/evidence/S09-C.md`) {
      // The real S09 evidence file carries multiple Task Evidence sections +
      // Current CV Status, which the Worker admission refuses; the S09
      // variant derives its fixture skeleton from the S04-A template (same
      // textual rewrite as the Manifest).
      const skeleton = fs
        .readFileSync(path.join(repo, 'delivery/stages/S04/evidence/S04-A.md'), 'utf8')
        .split('S04-A')
        .join('S09-C')
        .split('S04')
        .join('S09');
      const destination = path.join(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, skeleton, 'utf8');
      continue;
    }
    copyFixture(root, relative);
  }

  const tasksPath = path.join(root, `delivery/stages/${stage}/tasks.md`);
  // The real S09 Plan projection is already checked+ready-for-cv; the fixture
  // resets the S09-C checkbox and Worker Status so the unified admission flow
  // projects implement-task again (the S09-D region stays untouched).  The
  // S09 file's TOP-LEVEL status row (`NOT_STARTED` outside any Slice) must
  // not be rewritten — only the Slice-local status row is projected.
  const fixtureTaskText = fs.readFileSync(tasksPath, 'utf8');
  // The S09 file's Slice region was updated (4ae35b6) from `ready-for-cv` to
  // `executing`; detect the SLICE-local status row so the reset lands on the
  // S09-C region and never on the file's top-level row.
  const sliceStatusMarker = fixtureTaskText.includes('- Worker Status: `ready-for-cv`')
    ? '- Worker Status: `ready-for-cv`'
    : fixtureTaskText.includes(`## Slice ${sliceId}`) && fixtureTaskText.includes('- Worker Status: `executing`')
      ? '- Worker Status: `executing`'
      : '- Worker Status: `NOT_STARTED`';
  fs.writeFileSync(
    tasksPath,
    fixtureTaskText
      .replace(`- [x] ${taskId}`, `- [ ] ${taskId}`)
      .replace(sliceStatusMarker, '- Worker Status: `planned`'),
    'utf8',
  );

  const manifestPath = path.join(root, `.proofloop/manifests/${stage}.json`);
  // S09 variant: rewrite the S04 fixture Manifest to the S09 tuple (stage /
  // slice / task / plan / evidence paths) by textual rewrite of the stage
  // labels, then bind every reference to the real S09 files below.
  if (stage === 'S09') {
    const rewritten = fs
      .readFileSync(path.join(root, '.proofloop/manifests/S04.json'), 'utf8')
      .split('S04-A')
      .join('S09-C')
      .split('S04')
      .join('S09');
    fs.writeFileSync(path.join(root, '.proofloop/manifests/S09.json'), rewritten, 'utf8');
    fs.rmSync(path.join(root, '.proofloop/manifests/S04.json'));
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  manifest.task_scopes = {
    [taskId]: {
      task_ref: `delivery/stages/${stage}/tasks.md#/entities/${taskId}`,
      execution_scope: {
        kind: 'implementation',
        code_paths: [`delivery/stages/${stage}/tasks.md`],
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
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'vNext gate planning boundary']);

  const snapshotDigest = git(root, ['rev-parse', 'HEAD']);
  const manifestDigest = computeDigest(manifest);
  const planDigest = manifest.plan.plan_digest as string;
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: stage,
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
    manifest_path: `.proofloop/manifests/${stage}.json`,
    stage_id: stage,
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
    spv,
  }).accepted).toBe(true);

  const next = new VNextNextActionService().nextAction({
    projectRoot: root,
    stageId: stage,
    snapshotDigest,
    persistContext: true,
  });
  const context = JSON.parse(fs.readFileSync(path.join(root, next.context_ref as string), 'utf8')) as {
    context_digest: string;
  };

  const evidencePath = path.join(root, `delivery/stages/${stage}/evidence/${sliceId}.md`);
  for (const relative of options.repairFiles ? DECLARED_WIDE_SCOPE_TEST_FILES : ['packages/worker-test.ts']) {
    fs.appendFileSync(path.join(root, relative), 'export const workerChanged = true;\n');
  }
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8')
      .replace(`- [ ] ${taskId}`, `- [x] ${taskId}`)
      .replace('- Worker Status: `planned`', '- Worker Status: `executing`'),
    'utf8',
  );
  const fixtureTaskEvidence = [
    '## Task Evidence',
    '',
    `### ${taskId}`,
    '',
    '- Task Goal: integration fixture',
    '- Relevant PO IDs: PO-FIXTURE',
    '- Source Snapshot: fixture-source',
    '- Current Snapshot: fixture-current',
    '- Changed Files:',
    `  - delivery/stages/${stage}/evidence/${sliceId}.md`,
    `  - delivery/stages/${stage}/tasks.md`,
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
  ].join('\n');
  // The S04 fixture skeleton carries the `*Not yet captured.*` placeholder;
  // the real S09 evidence file already carries exactly one `## Task Evidence`
  // section, so the S09 variant appends a fixture marker line instead — the
  // evidence change still lands in the Git worktree diff (worker admission
  // binds changed_files to the actual diff) without duplicating a section.
  const evidenceBefore = fs.readFileSync(evidencePath, 'utf8');
  const evidenceAfter = evidenceBefore.includes('## Task Evidence\n\n*Not yet captured.*')
    ? evidenceBefore.replace('## Task Evidence\n\n*Not yet captured.*', fixtureTaskEvidence)
    : `${evidenceBefore}\n<!-- vnext-gate fixture refresh marker -->\n`;
  fs.writeFileSync(evidencePath, evidenceAfter, 'utf8');

  const proofIndex = (manifest.slices as Array<Record<string, any>>)[0].proof_index as Record<string, any>;
  const worker = admitVNextWorkerResult({
    schemaVersion: 2,
    actionToken: 'integration-worker-1',
    stageId: stage,
    sliceId,
    taskId,
    mode: 'implement-task',
    outcome: 'completed',
    evidenceRef: `delivery/stages/${stage}/evidence/${sliceId}.md`,
    changedFiles: options.repairFiles
      ? [
          `delivery/stages/${stage}/evidence/${sliceId}.md`,
          `delivery/stages/${stage}/tasks.md`,
          ...DECLARED_WIDE_SCOPE_TEST_FILES,
        ]
      : [
          `delivery/stages/${stage}/evidence/${sliceId}.md`,
          `delivery/stages/${stage}/tasks.md`,
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
  if (!worker.accepted) {
    throw new Error('worker not accepted: ' + JSON.stringify(worker.findings));
  }

  const cvInput: Record<string, unknown> = {
    schema_version: 2,
    type: 'CV_RESULT',
    stage_id: stage,
    slice_id: sliceId,
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
      reason: 'gate fixture binding',
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
    // PASS binds the SAME Worker tip as the preceding CV_REPAIR. The Gate
    // revalidates the CV history through the shared prefix validator, which
    // must accept this legal REPAIR → recheck tail sequence.
    const repair = admitVNextCVResult({
      ...cvInput,
      verification_type: 'initial',
      verdict: 'REPAIR',
      summary: 'gate fixture CV repair required',
      failed_acceptance_refs: [...proofIndex.acceptance_refs],
      counterexamples: ['gate fixture counterexample'],
      failed_criterion: 'gate fixture criterion',
      failure_signature: 'gate-failure-signature',
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
      summary: 'gate fixture CV recheck passed',
      previous_failure_signature: 'gate-failure-signature',
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
    `delivery/stages/${stage}/tasks.md`,
    `delivery/stages/${stage}/evidence/${sliceId}.md`,
    ...(options.repairFiles ? [...DECLARED_WIDE_SCOPE_TEST_FILES, ...REPAIR_EXTRA_FILES] : ['packages/worker-test.ts']),
  ]);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', `slice-output: ${stage}-${sliceId}`]);
  const commitSha = git(root, ['rev-parse', 'HEAD']);
  const sliceCommit = admitVNextSliceCommit({
    type: 'slice_commit',
    stageId: stage,
    sliceId,
    commitSha,
    cvReceiptDigest: cv.receipt_ref as string,
  }, { projectRoot: root });
  expect(sliceCommit.accepted).toBe(true);

  const integration = admitVNextIntegration({
    type: 'integration',
    stageId: stage,
    sliceId,
    commitSha,
  }, { projectRoot: root });
  expect(integration.accepted).toBe(true);

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
    sliceCommitReceiptDigest: sliceCommit.receipt_ref as string,
    integrationReceiptDigest: integration.receipt_ref as string,
    commitSha,
  };
}

function gateFiles(fixture: GateFixture, stage: GateFixtureStage = 'S04'): string[] {
  const directory = path.join(fixture.root, `.proofloop/receipts/stage-gate/${stage}`);
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json')) : [];
}

function gateRequest(fixture: GateFixture, overrides: Record<string, unknown> = {}, stage: GateFixtureStage = 'S04'): Record<string, unknown> {
  return {
    type: 'gate_result',
    stageId: stage,
    verdict: 'PASS',
    manifestDigest: fixture.manifestDigest,
    snapshotDigest: fixture.commitSha,
    summary: 'gate fixture PASS',
    ...overrides,
  };
}

function injectedWriter(
  mutateAfterWrite: (fixture: GateFixture, writtenPath: string) => void,
  fixture: GateFixture,
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

describe('vNext Stage Gate admission', () => {
  it('admits a GATE_PASS after the full integrated prefix through the public consumer', () => {
    const fixture = prepareFixture();
    const result = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(result.new_state).toBeNull();
    expect(result.vnext_state).toEqual({
      schema_version: 2,
      type: 'GATE_RESULT',
      action: 'GATE',
      stage_id: 'S04',
      manifest_digest: fixture.manifestDigest,
      plan_digest: fixture.planDigest,
      stage_plan_receipt_digest: expect.any(String),
      spv_receipt_digest: expect.any(String),
      snapshot_digest: fixture.commitSha,
      verdict: 'PASS',
      integrated_slices: [
        {
          slice_id: 'S04-A',
          integration_receipt_digest: fixture.integrationReceiptDigest,
          commit_sha: fixture.commitSha,
        },
      ],
      summary: 'gate fixture PASS',
      verification_source: 'receipts',
      receipt_chain_valid: true,
    });
    expect(gateFiles(fixture)).toHaveLength(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.root, '.proofloop/receipts/stage-gate/S04', `${result.receipt_ref}.json`),
      'utf8',
    )) as Record<string, unknown>;
    expect(receipt.type).toBe('GATE_PASS');
    expect(receipt.payload).toEqual(result.vnext_state);
  });

  it('admits a GATE_PASS after a REPAIR → recheck PASS CV history bound to the same Worker Receipt tip', () => {
    // The reduced Gate verifies ONLY the Integration Receipt chains (the
    // Worker → CV prefix was proven by the Integration admission), so a
    // legal REPAIR → recheck tail sequence stays admissible.
    const fixture = prepareFixture({ cvHistory: 'REPAIR_RECHECK' });
    const result = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(gateFiles(fixture)).toHaveLength(1);
  });

  it('admits a GATE_PASS when REPAIR-only files committed with the Slice boundary exceed the Worker-fact union (S08-E shape)', () => {
    // The reduced Gate no longer cross-checks Slice Commit Receipts against
    // the Worker-fact changed-file union, so a legal REPAIR → recheck
    // boundary carrying repair-only files stays admissible.
    const fixture = prepareFixture({ cvHistory: 'REPAIR_RECHECK', repairFiles: true });
    const result = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(gateFiles(fixture)).toHaveLength(1);
  });

  it('rejects a Gate when a Manifest Slice has no vNext Integration Receipt', () => {
    const fixture = prepareFixture();
    fs.rmSync(path.join(fixture.root, '.proofloop/receipts/integration/S04/S04-A'), {
      recursive: true,
      force: true,
    });
    const result = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Gate when the request snap is not the current integrated HEAD', () => {
    const fixture = prepareFixture();
    const result = admitVNextGateResult(
      gateRequest(fixture, { snapshotDigest: fixture.snapshotDigest }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Gate on a dirty working tree', () => {
    const fixture = prepareFixture();
    fs.writeFileSync(path.join(fixture.root, 'gate-dirty.txt'), 'dirty\n', 'utf8');
    const result = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects a duplicate GATE_PASS instead of chaining a second Pass receipt', () => {
    const fixture = prepareFixture();
    const first = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(first.accepted).toBe(true);
    const duplicate = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.receipt_ref).toBeNull();
    expect(gateFiles(fixture)).toHaveLength(1);
  });

  it('records a GATE_FAIL and allows a later GATE_PASS retry on the same tuple', () => {
    const fixture = prepareFixture();
    const failed = admitVNextGateResult(
      gateRequest(fixture, { verdict: 'FAIL', summary: 'first gate failed' }),
      { projectRoot: fixture.root },
    );
    expect(failed.accepted).toBe(true);
    expect(failed.vnext_state).toMatchObject({ verdict: 'FAIL', action: 'GATE' });

    const retry = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(retry.accepted).toBe(true);
    expect(retry.vnext_state).toMatchObject({ verdict: 'PASS', action: 'GATE' });
    expect(gateFiles(fixture)).toHaveLength(2);
  });

  it('routes the public CLI admit seam to the vNext Gate consumer and rejects unknown routes', () => {
    const fixture = prepareFixture();
    const result = admitRequest(
      gateRequest(fixture) as unknown as Parameters<typeof admitRequest>[0],
      fixture.root,
    );
    expect(result.accepted).toBe(true);
    expect(result.vnext_state).toMatchObject({
      type: 'GATE_RESULT',
      action: 'GATE',
      snapshot_digest: fixture.commitSha,
    });
    expect(gateFiles(fixture)).toHaveLength(1);

    const dirty = prepareFixture();
    fs.writeFileSync(
      path.join(dirty.root, '.proofloop/manifests/S04.json'),
      JSON.stringify({ version: 1 }),
      'utf8',
    );
    const refused = admitRequest(
      gateRequest(dirty) as unknown as Parameters<typeof admitRequest>[0],
      dirty.root,
    );
    expect(refused.accepted).toBe(false);
    expect(refused.receipt_ref).toBeNull();
    expect(gateFiles(dirty)).toHaveLength(0);
  });

  it('refuses at the public admit seam when the Manifest route is not vnext (v1 route)', () => {
    const fixture = prepareFixture();
    fs.writeFileSync(
      path.join(fixture.root, '.proofloop/manifests/S04.json'),
      JSON.stringify({ version: 1 }),
      'utf8',
    );
    const result = admitGateResult(gateRequest(fixture) as never, { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Gate when a Manifest/fact changed during the injected write', () => {
    const fixture = prepareFixture();
    const writer = injectedWriter((f, writtenPath) => {
      const integrationPath = path.join(
        f.root,
        '.proofloop/receipts/integration/S04/S04-A',
        `${f.integrationReceiptDigest}.json`,
      );
      const receipt = JSON.parse(fs.readFileSync(integrationPath, 'utf8')) as Record<string, unknown>;
      receipt.payload = { ...(receipt.payload as Record<string, unknown>), summary: 'changed during write' };
      fs.writeFileSync(integrationPath, JSON.stringify(receipt), 'utf8');
    }, fixture);

    const result = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root, writer });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(gateFiles(fixture)).toHaveLength(0);
  });







  it('rejects a Gate when the Integration Receipt proof_index_digest does not equal the current Proof Index digest (T06 exact binding)', () => {
    // T06: the Gate must compare the Integration payload's
    // proof_index_digest with the current Proof Index digest exactly, not
    // merely accept any well-formed 64-hex digest. A format-valid but
    // foreign proof_index_digest (e.g. a sibling Slice's Proof Index) must
    // fail the Gate even though every other tuple binding is intact.
    const fixture = prepareFixture();
    const directory = path.join(fixture.root, '.proofloop/receipts/integration/S04/S04-A');
    const filePath = path.join(directory, `${fixture.integrationReceiptDigest}.json`);
    const receipt = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    receipt.payload = {
      ...(receipt.payload as Record<string, unknown>),
      proof_index_digest: 'e'.repeat(64),
    };
    const { digest: _oldDigest, ...content } = receipt;
    void _oldDigest;
    receipt.digest = computeReceiptDigest(content as never);
    fs.writeFileSync(path.join(directory, `${receipt.digest}.json`), JSON.stringify(receipt), 'utf8');
    fs.rmSync(filePath);

    const result = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(gateFiles(fixture)).toHaveLength(0);
  });



  it('rejects a Gate when the Integration Receipt snapshot_digest does not equal the SPV authority snapshot', () => {
    const fixture = prepareFixture();
    const directory = path.join(fixture.root, '.proofloop/receipts/integration/S04/S04-A');
    const filePath = path.join(directory, `${fixture.integrationReceiptDigest}.json`);
    const receipt = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    receipt.payload = {
      ...(receipt.payload as Record<string, unknown>),
      snapshot_digest: 'f'.repeat(40),
    };
    const { digest: _oldDigest, ...content } = receipt;
    void _oldDigest;
    receipt.digest = computeReceiptDigest(content as never);
    fs.writeFileSync(path.join(directory, `${receipt.digest}.json`), JSON.stringify(receipt), 'utf8');
    fs.rmSync(filePath);

    const result = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(gateFiles(fixture)).toHaveLength(0);
  });



  it('rejects a Gate when the SPV snapshot is not an ancestor of the integrated snapshot', () => {
    const fixture = prepareFixture();
    // Create an unrelated commit whose tree is the current boundary, then
    // restore the integrated commit as HEAD: the probe commit is not an
    // ancestor of the integrated snapshot.
    execFileSync('git', ['-C', fixture.root, 'commit', '--allow-empty', '-q', '-m', 'unrelated spv snapshot probe']);
    const probeCommit = git(fixture.root, ['rev-parse', 'HEAD']);
    execFileSync('git', ['-C', fixture.root, 'reset', '--hard', '-q', fixture.commitSha]);

    // Rewrite the SPV authority so its snapshot_digest points at the probe
    // commit, while keeping both authority files schema-valid (re-digest the
    // SPV receipt and rebind the Stage Plan spv_receipt_digest).
    const planDir = path.join(fixture.root, '.proofloop/receipts/plan/S04');
    const spvPath = path.join(planDir, 'vnext-spv-pass.json');
    const spv = JSON.parse(fs.readFileSync(spvPath, 'utf8')) as Record<string, unknown>;
    spv.snapshot_digest = probeCommit;
    const spvWithoutDigest = { ...spv };
    delete (spvWithoutDigest as { digest?: string }).digest;
    spv.digest = computeVNextSpvPassReceiptDigest(spvWithoutDigest as never);
    fs.writeFileSync(spvPath, JSON.stringify(spv), 'utf8');

    const stagePlanPath = path.join(planDir, 'vnext-stage-plan.json');
    const stagePlan = JSON.parse(fs.readFileSync(stagePlanPath, 'utf8')) as Record<string, unknown>;
    stagePlan.spv_receipt_digest = spv.digest;
    const stagePlanWithoutDigest = { ...stagePlan };
    delete (stagePlanWithoutDigest as { digest?: string }).digest;
    stagePlan.digest = computeVNextStagePlanReceiptDigest(stagePlanWithoutDigest as never);
    fs.writeFileSync(stagePlanPath, JSON.stringify(stagePlan), 'utf8');

    const result = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Gate when the Stage Plan snapshot_digest differs from the SPV snapshot_digest', () => {
    const fixture = prepareFixture();
    // Tamper ONLY the Stage Plan authority snapshot, then recompute its
    // digest: the forged authority prefix stays fully self-consistent (the
    // Stage Plan still binds the SPV receipt digest, and the SPV snapshot
    // remains a valid ancestor of the integrated boundary) except for the
    // missing Stage Plan/SPV snapshot equality.
    const planDir = path.join(fixture.root, '.proofloop/receipts/plan/S04');
    const stagePlanPath = path.join(planDir, 'vnext-stage-plan.json');
    const stagePlan = JSON.parse(fs.readFileSync(stagePlanPath, 'utf8')) as Record<string, unknown>;
    stagePlan.snapshot_digest = 'f'.repeat(40);
    const stagePlanWithoutDigest = { ...stagePlan };
    delete (stagePlanWithoutDigest as { digest?: string }).digest;
    stagePlan.digest = computeVNextStagePlanReceiptDigest(stagePlanWithoutDigest as never);
    fs.writeFileSync(stagePlanPath, JSON.stringify(stagePlan), 'utf8');

    const result = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(gateFiles(fixture)).toHaveLength(0);
  });
});

describe('P-09 — explicit re-gate after a REPAIR review (REPAIR-driven re-run)', () => {
  it('keeps the fail-closed duplicate rule: a Gate PASS tip without re_gate is still refused', () => {
    const fixture = prepareFixture();
    const first = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(first.accepted).toBe(true);
    const duplicate = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.receipt_ref).toBeNull();
    expect(duplicate.findings[0]?.code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(duplicate.findings[0]?.message).toMatch(/re_gate/);
    expect(gateFiles(fixture)).toHaveLength(1);
  });

  it('refuses a re-gate when the review chain has no REPAIR tip (empty review chain, fail-closed)', () => {
    const fixture = prepareFixture();
    const first = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(first.accepted).toBe(true);
    const result = admitVNextGateResult(
      gateRequest(fixture, { re_gate: true }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/REPAIR/);
    expect(gateFiles(fixture)).toHaveLength(1);
  });

  it('refuses a re-gate when the review chain tip is ACCEPTED, not REPAIR', () => {
    const fixture = prepareFixture();
    const first = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(first.accepted).toBe(true);
    const review = admitVNextStageReview(
      {
        type: 'stage_review',
        stageId: 'S04',
        verdict: 'ACCEPTED',
        manifestDigest: fixture.manifestDigest,
        snapshotDigest: fixture.commitSha,
        summary: 'accepted review',
      },
      { projectRoot: fixture.root },
    );
    expect(review.accepted).toBe(true);
    const result = admitVNextGateResult(
      gateRequest(fixture, { re_gate: true }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/REPAIR/);
    expect(gateFiles(fixture)).toHaveLength(1);
  });

  it('admits an explicit re-gate after a REPAIR review: new PASS appended as chain tip, old PASS kept as write-once history', () => {
    const fixture = prepareFixture();
    const first = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(first.accepted).toBe(true);
    // REPAIR review round at the integrated boundary.
    const review = admitVNextStageReview(
      {
        type: 'stage_review',
        stageId: 'S04',
        verdict: 'REPAIR',
        manifestDigest: fixture.manifestDigest,
        snapshotDigest: fixture.commitSha,
        summary: 'review requires repair',
      },
      { projectRoot: fixture.root },
    );
    expect(review.accepted).toBe(true);
    // The repair fix advances HEAD.
    fs.appendFileSync(path.join(fixture.root, 'packages/worker-test.ts'), 'export const repaired = true;\n');
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'repair fix after review REPAIR']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);

    const result = admitVNextGateResult(
      gateRequest(fixture, { snapshotDigest: head, re_gate: true }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(result.vnext_state).toMatchObject({ snapshot_digest: head, verdict: 'PASS' });
    expect(gateFiles(fixture)).toHaveLength(2);
    // The new receipt is the chain tip bound to the current HEAD; the old
    // PASS receipt is still in the chain (write-once history).
    const directory = path.join(fixture.root, '.proofloop/receipts/stage-gate/S04');
    const receipts = gateFiles(fixture).map((name) =>
      JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as Record<string, any>,
    );
    const tip = receipts.find((r) => r.digest === result.receipt_ref) as Record<string, any> | undefined;
    expect(tip).toBeDefined();
    expect((tip?.payload as Record<string, unknown>)?.snapshot_digest).toBe(head);
    expect(tip?.previous_digest).toBe(first.receipt_ref);
    expect(receipts.some((r) => r.digest === first.receipt_ref)).toBe(true);
  });

  it('rejects a non-boolean re_gate at the closed request schema (zero writes)', () => {
    const fixture = prepareFixture();
    const result = admitVNextGateResult(
      gateRequest(fixture, { re_gate: 'yes' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/re_gate/);
    expect(gateFiles(fixture)).toHaveLength(0);
  });
});

describe('S09-C-T03 — Gate admission rejects legacy stage labels before any read/write', () => {
  function gateRequest(stageId: string): Record<string, unknown> {
    return {
      type: 'gate_result',
      stageId,
      verdict: 'PASS',
      manifestDigest: 'a'.repeat(64),
      snapshotDigest: 'b'.repeat(40),
      summary: 'gate summary',
    };
  }

  it('rejects a Gate request whose stageId is the parked S08B0 label', () => {
    expect(() => validateVNextGateResultRequest(gateRequest('S08B0'))).toThrowError(/canonical Stage ID/);
  });

  it('rejects a Gate request whose stageId is the parked S08B label', () => {
    expect(() => validateVNextGateResultRequest(gateRequest('S08B'))).toThrowError(/canonical Stage ID/);
  });
});

describe('Dual-path SG — explicit git_facts fallback (S10 backfill decision)', () => {
  it('rejects a Gate without an explicit verification declaration when the integration receipts are missing (fail-closed, no silent fallback)', () => {
    // 缺显式声明 → 正常 receipts 路径；receipts 缺失即拒绝，绝不静默兜底。
    const fixture = prepareFixture();
    fs.rmSync(path.join(fixture.root, '.proofloop/receipts/integration/S04/S04-A'), {
      recursive: true,
      force: true,
    });
    const result = admitVNextGateResult(gateRequest(fixture), { projectRoot: fixture.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/no vNext Integration Receipt/);
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects a Gate whose request verification_source is not "receipts" | "git_facts"', () => {
    const fixture = prepareFixture();
    const result = admitVNextGateResult(
      gateRequest(fixture, { verification_source: 'bogus' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/verification_source/);
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects the git_facts fallback while Integration receipts exist (absence-gated fail-closed)', () => {
    // S10-SR-001-GIT-FACTS-FAIL-OPEN-001: git_facts 仅在全部 Slice 的
    // INTEGRATION_PASS receipts 缺失时可用。fixture 的 receipts 链完整存在
    // 时显式声明 git_facts 必须被拒绝 —— 完整的权威 receipts 链不能被显式
    // 声明绕过（fail-closed，要求走正常 receipts 路径）。
    const fixture = prepareFixture();
    const result = admitVNextGateResult(
      gateRequest(fixture, { verification_source: 'git_facts' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/git_facts.*Integration receipts|Integration receipts.*git_facts/i);
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects the git_facts fallback when a commit message only CONTAINS the slice-output marker as a substring (exact prefix required)', () => {
    // S10-SR-001-GIT-FACTS-FAIL-OPEN-001: 旧实现 `subject.includes(marker)`
    // 会把 `slice-output: S04-S04-A-repair` 这类仅包含 marker 子串的消息误认
    // 为集成提交。新实现要求消息精确以 marker 开头（词边界）或与 marker
    // 完全相等。本测试把 HEAD 移回 planning boundary，再以伪造消息重放全部
    // 集成事实（Evidence 完整 + checkbox 全勾）—— 唯一缺失的是真正的集成
    // 提交标记，兜底必须因此拒绝。
    const fixture = prepareFixture();
    for (const category of ['tasks', 'cv', 'committer', 'integration']) {
      fs.rmSync(path.join(fixture.root, '.proofloop/receipts', category, 'S04', 'S04-A'), {
        recursive: true,
        force: true,
      });
    }
    execFileSync('git', ['-C', fixture.root, 'branch', 'keep-integration', fixture.commitSha]);
    execFileSync('git', ['-C', fixture.root, 'reset', '--hard', '-q', fixture.snapshotDigest]);
    execFileSync('git', ['-C', fixture.root, 'checkout', fixture.commitSha, '--',
      'delivery/stages/S04/evidence/S04-A.md',
      'delivery/stages/S04/tasks.md',
    ]);
    fs.writeFileSync(path.join(fixture.root, 'packages/unrelated.txt'), 'unrelated\n', 'utf8');
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'slice-output: S04-S04-A-repair']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);
    // 伪造提交存在（作为子串包含 marker），但真实集成提交不在 HEAD 祖先链。
    expect(git(fixture.root, ['log', '--all', '--format=%s'])).toContain('slice-output: S04-S04-A-repair');

    const result = admitVNextGateResult(
      gateRequest(fixture, { snapshotDigest: head, verification_source: 'git_facts' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/no integration commit|slice-output/i);
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects the git_facts fallback when forged COMPLETE Evidence outside the Slice Task Evidence section masks an incomplete subsection', () => {
    // S10-SR-001-GIT-FACTS-FAIL-OPEN-001: 旧实现全文 `includes('- Status:
    // COMPLETE')`，任意位置的伪造文本都能满足。新实现把 `## Task Evidence`
    // 段内本 Slice 的 `### <task-id>` 子段作为唯一依据 —— 段外伪造的
    // COMPLETE 不能掩盖本 Slice 子段缺失 COMPLETE。
    const fixture = prepareFixture();
    for (const category of ['tasks', 'cv', 'committer', 'integration']) {
      fs.rmSync(path.join(fixture.root, '.proofloop/receipts', category, 'S04', 'S04-A'), {
        recursive: true,
        force: true,
      });
    }
    const evidencePath = path.join(fixture.root, 'delivery/stages/S04/evidence/S04-A.md');
    const forged = [
      '## Current Slice Evidence',
      '',
      '### S04-A-T01',
      '',
      '- Status: COMPLETE',
    ].join('\n');
    fs.writeFileSync(
      evidencePath,
      `${fs.readFileSync(evidencePath, 'utf8').split('- Status: COMPLETE').join('- Status: IN_PROGRESS')}\n${forged}\n`,
      'utf8',
    );
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '--amend', '-q', '--no-edit']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);
    // 伪造文本确实存在于历史（旧全文 includes 会误判通过）。
    expect(fs.readFileSync(evidencePath, 'utf8')).toContain('- Status: COMPLETE');

    const result = admitVNextGateResult(
      gateRequest(fixture, { snapshotDigest: head, verification_source: 'git_facts' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/Evidence.*not complete/i);
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects the git_facts fallback when a forged checked checkbox in another Slice region masks this Slice\'s missing checkbox', () => {
    // S10-SR-001-GIT-FACTS-FAIL-OPEN-001: 旧实现全文 `includes('- [x]
    // <task-id>')`，其它 Slice 区域的伪造勾选即可满足 —— 本 Slice 区域的
    // checkbox 被移除（缺失）时旧实现会误判通过。新实现只在
    // `<!-- SLICE:<slice>:BEGIN/END -->` 区域内校验本 Slice 的 checkbox。
    // tasks.md 被 Manifest reference 绑定（file_digest），不能改 HEAD/工作树
    // 内容；因此把伪造 tasks.md 写进一个重写的集成提交（历史内容自由），
    // 再在其上恢复 canonical 内容作为 HEAD（工作树 = HEAD = canonical）。
    const fixture = prepareFixture();
    for (const category of ['tasks', 'cv', 'committer', 'integration']) {
      fs.rmSync(path.join(fixture.root, '.proofloop/receipts', category, 'S04', 'S04-A'), {
        recursive: true,
        force: true,
      });
    }
    const tasksPath = path.join(fixture.root, 'delivery/stages/S04/tasks.md');
    const evidencePath = path.join(fixture.root, 'delivery/stages/S04/evidence/S04-A.md');
    const forgedRegion = [
      '',
      '## Slice S04-B — forged sibling region',
      '<!-- SLICE:S04-B:BEGIN -->',
      '',
      '- [x] S04-A-T01 — forged checkbox for the S04-A task outside its region',
      '',
      '<!-- SLICE:S04-B:END -->',
    ].join('\n');
    const forgedTasks = fs
      .readFileSync(tasksPath, 'utf8')
      .replace(/^- \[x\] S04-A-T01.*$/m, '')
      .concat(`\n${forgedRegion}\n`);
    expect(forgedTasks).not.toContain('- [ ] S04-A-T01');
    execFileSync('git', ['-C', fixture.root, 'checkout', '-q', '--detach', fixture.snapshotDigest]);
    fs.writeFileSync(tasksPath, forgedTasks, 'utf8');
    // 集成提交处 Evidence 仍完整 —— 唯一缺陷是本 Slice 区域缺失 checkbox。
    fs.writeFileSync(
      evidencePath,
      execFileSync('git', ['-C', fixture.root, 'show', `${fixture.commitSha}:delivery/stages/S04/evidence/S04-A.md`], { encoding: 'utf8' }),
      'utf8',
    );
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'slice-output: S04-S04-A']);
    // 在其上恢复 canonical 内容作为 HEAD（工作树 = HEAD = canonical）。
    execFileSync('git', ['-C', fixture.root, 'checkout', '-q', fixture.commitSha, '--', '.']);
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'restore canonical content']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);
    // 伪造集成提交确实在 HEAD 祖先链且携带完整 marker 消息；其 tasks.md 在
    // 区域外存在伪造勾选、本 Slice 区域缺失 checkbox（旧全文 includes 会
    // 误判通过）。
    expect(git(fixture.root, ['log', '--format=%s'])).toContain('slice-output: S04-S04-A');
    const forgedCommitTasks = execFileSync(
      'git',
      ['-C', fixture.root, 'show', `HEAD~1:delivery/stages/S04/tasks.md`],
      { encoding: 'utf8' },
    );
    expect(forgedCommitTasks).toContain('- [x] S04-A-T01');
    expect(forgedCommitTasks).not.toContain('- [ ] S04-A-T01');

    const result = admitVNextGateResult(
      gateRequest(fixture, { snapshotDigest: head, verification_source: 'git_facts' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/checkbox/i);
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects the git_facts fallback when the integration commit is not in the HEAD ancestor chain', () => {
    const fixture = prepareFixture();
    // S10-SR-001-GIT-FACTS-FAIL-OPEN-001: the fallback is absence-gated ——
    // git_facts is only reachable when the Integration receipts are missing;
    // remove them so this test exercises the ancestor-chain fact itself.
    for (const category of ['tasks', 'cv', 'committer', 'integration']) {
      fs.rmSync(path.join(fixture.root, '.proofloop/receipts', category, 'S04', 'S04-A'), {
        recursive: true,
        force: true,
      });
    }
    // 保留 slice-output 提交的引用（证明它存在），再把 HEAD 移到 planning
    // boundary 之上的新提交：集成提交不再是 HEAD 祖先 —— 兜底必须拒绝
    // （集成提交不在祖先链），即使其它 git 事实齐备。
    execFileSync('git', ['-C', fixture.root, 'branch', 'keep-slice-output', fixture.commitSha]);
    execFileSync('git', ['-C', fixture.root, 'reset', '--hard', '-q', fixture.snapshotDigest]);
    fs.writeFileSync(path.join(fixture.root, 'packages/unrelated.txt'), 'unrelated\n', 'utf8');
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'unrelated boundary after planning']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);
    expect(git(fixture.root, ['log', '--all', '--format=%s'])).toContain('slice-output: S04-S04-A');

    const result = admitVNextGateResult(
      gateRequest(fixture, { snapshotDigest: head, verification_source: 'git_facts' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/no integration commit|slice-output/i);
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects the git_facts fallback when the Slice Evidence is incomplete in Git history', () => {
    const fixture = prepareFixture();
    // 兜底路径不依赖 receipt 链：删除全部执行链 receipts，证明拒绝完全源于
    // git 事实（Evidence 不完整）。
    for (const category of ['tasks', 'cv', 'committer', 'integration']) {
      fs.rmSync(path.join(fixture.root, '.proofloop/receipts', category, 'S04', 'S04-A'), {
        recursive: true,
        force: true,
      });
    }
    const evidencePath = path.join(fixture.root, 'delivery/stages/S04/evidence/S04-A.md');
    fs.writeFileSync(
      evidencePath,
      fs.readFileSync(evidencePath, 'utf8').split('- Status: COMPLETE').join('- Status: IN_PROGRESS'),
      'utf8',
    );
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '--amend', '-q', '--no-edit']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);

    const result = admitVNextGateResult(
      gateRequest(fixture, { snapshotDigest: head, verification_source: 'git_facts' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/Evidence.*not complete/i);
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects the git_facts fallback when a tasks.md checkbox is unchecked at the integration commit', () => {
    const fixture = prepareFixture();
    for (const category of ['tasks', 'cv', 'committer', 'integration']) {
      fs.rmSync(path.join(fixture.root, '.proofloop/receipts', category, 'S04', 'S04-A'), {
        recursive: true,
        force: true,
      });
    }
    const tasksPath = path.join(fixture.root, 'delivery/stages/S04/tasks.md');
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [x] S04-A-T01', '- [ ] S04-A-T01'),
      'utf8',
    );
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '--amend', '-q', '--no-edit']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);

    const result = admitVNextGateResult(
      gateRequest(fixture, { snapshotDigest: head, verification_source: 'git_facts' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/checkbox/i);
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects the git_facts fallback when the current HEAD Evidence is reverted (integration commit intact)', () => {
    // S10-SR-001 反例：集成提交处 Evidence 完整，但集成提交之上的新提交把
    // Evidence 回退（无 Status: COMPLETE）—— 兜底必须验证当前 HEAD 内容，
    // 不能只信任集成提交处的事实。
    const fixture = prepareFixture();
    for (const category of ['tasks', 'cv', 'committer', 'integration']) {
      fs.rmSync(path.join(fixture.root, '.proofloop/receipts', category, 'S04', 'S04-A'), {
        recursive: true,
        force: true,
      });
    }
    const evidencePath = path.join(fixture.root, 'delivery/stages/S04/evidence/S04-A.md');
    fs.writeFileSync(
      evidencePath,
      fs.readFileSync(evidencePath, 'utf8').split('- Status: COMPLETE').join('- Status: IN_PROGRESS'),
      'utf8',
    );
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'revert evidence at HEAD']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);
    // 集成提交（slice-output 标记）仍在 HEAD 祖先链且事实完整
    expect(git(fixture.root, ['log', '--format=%s'])).toContain('slice-output: S04-S04-A');

    const result = admitVNextGateResult(
      gateRequest(fixture, { snapshotDigest: head, verification_source: 'git_facts' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/Evidence.*not complete/i);
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('rejects the git_facts fallback when a tasks.md checkbox is unchecked at the current HEAD (integration commit intact)', () => {
    // S10-SR-001 反例：集成提交处 checkbox 全勾，但集成提交之上的新提交把
    // checkbox 回退为未勾 —— 兜底必须拒绝（当前 HEAD 一致性）。
    const fixture = prepareFixture();
    for (const category of ['tasks', 'cv', 'committer', 'integration']) {
      fs.rmSync(path.join(fixture.root, '.proofloop/receipts', category, 'S04', 'S04-A'), {
        recursive: true,
        force: true,
      });
    }
    const tasksPath = path.join(fixture.root, 'delivery/stages/S04/tasks.md');
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [x] S04-A-T01', '- [ ] S04-A-T01'),
      'utf8',
    );
    execFileSync('git', ['-C', fixture.root, 'add', '-A']);
    execFileSync('git', ['-C', fixture.root, 'commit', '-q', '-m', 'revert checkbox at HEAD']);
    const head = git(fixture.root, ['rev-parse', 'HEAD']);

    const result = admitVNextGateResult(
      gateRequest(fixture, { snapshotDigest: head, verification_source: 'git_facts' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/checkbox.*current HEAD|checkbox/i);
    expect(gateFiles(fixture)).toHaveLength(0);
  });

  it('admits a GATE_PASS through the explicit git_facts fallback and marks the Receipt verification_source: "git_facts"', () => {
    const fixture = prepareFixture();
    // 兜底路径不依赖任何执行链 receipt：删除 tasks/cv/committer/integration
    // 全部 receipts，通过完全来自 git 事实（集成提交在 HEAD 祖先链 +
    // Evidence 完整 + checkbox 全勾）。当前 HEAD 即集成提交本身 ——
    // 集成提交处与当前 HEAD 两处条件同时满足（S10-SR-001）。
    for (const category of ['tasks', 'cv', 'committer', 'integration']) {
      fs.rmSync(path.join(fixture.root, '.proofloop/receipts', category, 'S04', 'S04-A'), {
        recursive: true,
        force: true,
      });
    }
    const result = admitVNextGateResult(
      gateRequest(fixture, { verification_source: 'git_facts' }),
      { projectRoot: fixture.root },
    );
    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toMatch(/^[a-f0-9]{64}$/);
    expect(result.vnext_state).toMatchObject({
      schema_version: 2,
      type: 'GATE_RESULT',
      action: 'GATE',
      stage_id: 'S04',
      verdict: 'PASS',
      verification_source: 'git_facts',
      integrated_slices: [
        {
          slice_id: 'S04-A',
          integration_receipt_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          commit_sha: fixture.commitSha,
        },
      ],
    });
    expect(gateFiles(fixture)).toHaveLength(1);
    const receipt = JSON.parse(fs.readFileSync(
      path.join(fixture.root, '.proofloop/receipts/stage-gate/S04', `${result.receipt_ref}.json`),
      'utf8',
    )) as Record<string, unknown>;
    expect(receipt.type).toBe('GATE_PASS');
    expect((receipt.payload as Record<string, unknown>).verification_source).toBe('git_facts');
  });
});
