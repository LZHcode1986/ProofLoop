/**
 * S08-E-T01 — planning clean boundary vs execution dirty boundary, and
 * next Task / RUN_CV projection from persisted TASK_COMPLETE facts.
 * Task Ref: REF-S08-E-T01
 *
 * POs (AWI-022 / REF-S08-E-ACCEPTANCE, REF-S08-E-SEAM, REF-S08-E-ORACLE,
 * REF-S08-E-RISK):
 *   - planning clean boundary: before any Worker fact, next requires a clean
 *     worktree (assertStableGitBoundary semantics); execution-state dirty is
 *     not admissible without a persisted recover binding;
 *   - execution dirty boundary: after admitted TASK_COMPLETE facts, next
 *     projects the next Task or RUN_CV from persisted facts and permits only
 *     scope-bound dirty paths — the planning clean gate is never re-applied;
 *   - Slice Commit advances HEAD to a Git descendant, which next treats as a
 *     legal execution boundary and advances past the committed Slice;
 *   - a persisted CV REPAIR fact keeps next on RUN_CV (recheck pending);
 *     after CV PASS + Slice Commit next never repeats RUN_CV.
 *
 * Every assertion runs through the public vNext next seam
 * (VNextNextActionService) against the REAL S08 candidate fixture (real
 * Manifest/Plan/authority admission, real persisted Receipts, real Git
 * worktree), not internal functions or mocks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  computeDigest,
  computeVNextSpvPassReceiptDigest,
  writeReceipt,
} from '@proofloop/kernel';
import { admitVNextStagePlan, resolveVNextReference, VNextNextActionService } from './index';
import type { VNextNextActionOutput } from './index';

const repoRoot = path.resolve(__dirname, '../../../..');
const cleanups: string[] = [];
afterEach(() => {
  for (const root of cleanups.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const S08_EVIDENCE_PATH = 'delivery/stages/S08/evidence/S08-A.md';
const S08_PLAN_PATH = 'delivery/stages/S08/tasks.md';

/** Real S08 entity files mirrored from the repo (same list as the CLI spec). */
const S08_REAL_FILES: readonly string[] = [
  'delivery/stages/S08/tasks.md',
  '.proofloop/manifests/S08.json',
  'delivery/stages/S08/evidence/S08-A.md',
  'delivery/stages/S08/evidence/S08-B.md',
  'delivery/stages/S08/evidence/S08-C.md',
  'delivery/stages/S08/evidence/S08-D.md',
  'delivery/stages/S08/evidence/S08-E.md',
  'delivery/stages/S0-A/tasks.md',
  'tech-spec/task-acceptance-matrix.md',
  'tech-spec/contract-state-matrix.md',
  'tech-spec/ai-coding-architecture.md',
  'tech-spec/hard-parts-register.md',
];

/** One scope file per completed task of the S08-A execution chain. */
const S08_A_SCOPE_FILE_BY_TASK: Record<string, string> = {
  'S08-A-T01': 'packages/opencode-plugin/src/tools/plan-status.ts',
  'S08-A-T02': 'packages/runtime/src/vnext/next.ts',
  'S08-A-T03': 'packages/opencode-plugin/src/tools/review.ts',
};

const S08_A_TEST_FILE_BY_TASK: Record<string, string> = {
  'S08-A-T01': 'packages/opencode-plugin/src/tools/plan-vnext.spec.ts',
  'S08-A-T02': 'packages/runtime/src/vnext/dispatch.spec.ts',
  'S08-A-T03': 'packages/opencode-plugin/src/tools/review-wiring.spec.ts',
};

interface S08Fixture {
  readonly root: string;
  readonly manifest: Record<string, any>;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly snapshotDigest: string;
  readonly evidencePath: string;
  readonly planPath: string;
}

/**
 * Real S08 candidate fixture with a clean committed boundary. `freshPlanning`
 * unchecks the S08-A task checkboxes so the fixture represents a fresh
 * planning state (no Worker fact, no recover binding); the default keeps the
 * real planning projection (checkbox already checked), which is the persisted
 * recover binding shape used by the recovery test.
 */
/**
 * Rebind every Manifest reference to the fixture's copied authority files.
 * The archived S08 Manifest records compile-time (2026-08-05) file/section
 * digests, but the fixture mirrors the CURRENT repo files (with local
 * checkbox resets), so admission would fail closed on digest mismatch.
 * Recompute both digests per reference against the fixture root with the
 * same resolver the compiler uses — the fixture keeps its "real S08
 * candidate shape" while staying self-consistent (the archived repo
 * Manifest is never touched).
 */
function rebindS08ReferenceDigests(root: string): void {
  const manifestPath = path.join(root, '.proofloop/manifests/S08.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, any>;
  for (const descriptor of Object.values(manifest.reference_index as Record<string, any>)) {
    const resolved = resolveVNextReference({ root, ref: descriptor.ref, expectedKind: descriptor.kind });
    descriptor.file_digest = resolved.fileDigest;
    descriptor.section_digest = resolved.sectionDigest;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

function s08Fixture(options: { freshPlanning?: boolean } = {}): S08Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vnext-exec-state-'));
  cleanups.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'exec-state@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'vNext Execution State Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, '.gitignore'), '.proofloop/\n', 'utf8');
  for (const relative of S08_REAL_FILES) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, relative), target);
  }
  const tasksPath = path.join(root, S08_PLAN_PATH);
  if (options.freshPlanning === true) {
    fs.writeFileSync(
      tasksPath,
      fs
        .readFileSync(tasksPath, 'utf8')
        .replace('- [x] S08-A-T01', '- [ ] S08-A-T01')
        .replace('- [x] S08-A-T02', '- [ ] S08-A-T02')
        .replace('- [x] S08-A-T03', '- [ ] S08-A-T03'),
      'utf8',
    );
  }
  for (const relative of [
    ...Object.values(S08_A_SCOPE_FILE_BY_TASK),
    ...Object.values(S08_A_TEST_FILE_BY_TASK),
  ]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `// execution-state fixture placeholder: ${relative}\n`, 'utf8');
  }
  rebindS08ReferenceDigests(root);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'S08 execution-state candidate boundary']);
  const snapshotDigest = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, '.proofloop/manifests/S08.json'), 'utf8'),
  ) as Record<string, any>;
  return {
    root,
    manifest,
    manifestDigest: computeDigest(manifest),
    planDigest: manifest.plan.plan_digest as string,
    snapshotDigest,
    evidencePath: S08_EVIDENCE_PATH,
    planPath: S08_PLAN_PATH,
  };
}

function admitS08(fx: S08Fixture): void {
  const spvContent = {
    version: 2 as const,
    schema_version: 2 as const,
    type: 'SPV_PASS' as const,
    stage_id: 'S08',
    manifest_digest: fx.manifestDigest,
    plan_digest: fx.planDigest,
    snapshot_digest: fx.snapshotDigest,
  };
  const result = admitVNextStagePlan({
    version: 2,
    schema_version: 2,
    type: 'STAGE_PLAN_ADMISSION',
    project_root: fx.root,
    manifest_path: '.proofloop/manifests/S08.json',
    stage_id: 'S08',
    manifest_digest: fx.manifestDigest,
    plan_digest: fx.planDigest,
    snapshot_digest: fx.snapshotDigest,
    spv: { ...spvContent, digest: computeVNextSpvPassReceiptDigest(spvContent) },
  });
  if (!result.accepted) throw new Error(result.findings[0].message);
}

function nextAction(
  fx: S08Fixture,
  options: { persistContext?: boolean } = {},
): VNextNextActionOutput {
  return new VNextNextActionService().nextAction({
    projectRoot: fx.root,
    stageId: 'S08',
    snapshotDigest: fx.snapshotDigest,
    persistContext: options.persistContext,
  });
}

function s08ASliceProofIndexDigest(fx: S08Fixture): string {
  const slice = fx.manifest.slices.find(
    (candidate: Record<string, any>) => candidate.slice_id === 'S08-A',
  );
  if (slice === undefined) throw new Error('S08-A Slice is unavailable in the fixture');
  return computeDigest(slice.proof_index);
}

/**
 * Read the persisted Context binding of one completed task of the S08-A
 * Worker chain. Receipt file names are digest-addressed, so directory order
 * is NOT task order: the binding must be located by the payload task_id
 * (S08-REVIEW-007 binds the CV to the FINAL completed Worker Context).
 */
function taskContext(
  fx: S08Fixture,
  taskId: string,
): { context_ref: string; context_digest: string } {
  const tasksDir = path.join(fx.root, '.proofloop/receipts/tasks/S08/S08-A');
  const names = fs.readdirSync(tasksDir).filter((name) => name.endsWith('.json'));
  for (const name of names) {
    const receipt = JSON.parse(fs.readFileSync(path.join(tasksDir, name), 'utf8')) as {
      payload: { task_id: string; context_ref: string; context_digest: string };
    };
    if (receipt.payload.task_id === taskId) {
      return {
        context_ref: receipt.payload.context_ref,
        context_digest: receipt.payload.context_digest,
      };
    }
  }
  throw new Error(`Worker fact for task ${taskId} is missing in the fixture`);
}

/** Append scope-bound dirty files and persist a TASK_COMPLETE fact for one task. */
function completeTask(  fx: S08Fixture,
  options: { taskId: string; actionToken: string; timestamp: string },
): string {
  const dispatch = nextAction(fx, { persistContext: true });
  expect(dispatch.action).toBe('DISPATCH_WORKER');
  expect(dispatch.slice_id).toBe('S08-A');
  expect(dispatch.task_id).toBe(options.taskId);
  expect(dispatch.context_ref).toBeDefined();
  const contextRef = dispatch.context_ref as string;
  const context = JSON.parse(
    fs.readFileSync(path.join(fx.root, contextRef), 'utf8'),
  ) as { context_digest: string };
  const changedFiles: string[] = [];
  // The declared changed_files must be REAL file modifications: the Git diff
  // cross-validation of SLICE_COMMIT (S08-REVIEW-005) compares the actual
  // parent..commit file set against the declared set. The Evidence file is
  // appended like the scope files; the Plan projection is modified by
  // checking the Task checkbox — a content change the entity resolver
  // normalizes away, so the admitted Manifest file/section digests stay
  // stable (checkbox state is execution state, not entity content).
  for (const relative of [
    S08_A_SCOPE_FILE_BY_TASK[options.taskId],
    S08_A_TEST_FILE_BY_TASK[options.taskId],
    fx.evidencePath,
  ]) {
    fs.appendFileSync(path.join(fx.root, relative), `// worker change for ${options.taskId}\n`, 'utf8');
    changedFiles.push(relative);
  }
  const planPath = path.join(fx.root, fx.planPath);
  const planText = fs.readFileSync(planPath, 'utf8');
  if (planText.includes(`- [ ] ${options.taskId}`)) {
    fs.writeFileSync(planPath, planText.replace(`- [ ] ${options.taskId}`, `- [x] ${options.taskId}`), 'utf8');
  }
  changedFiles.push(fx.planPath);
  const receiptDir = path.join(fx.root, '.proofloop/receipts/tasks/S08/S08-A');
  fs.mkdirSync(receiptDir, { recursive: true });
  const written = writeReceipt(
    {
      version: 1,
      type: 'TASK_COMPLETE',
      stage_id: 'S08',
      slice_id: 'S08-A',
      timestamp: options.timestamp,
      payload: {
        schema_version: 2,
        action_token: options.actionToken,
        mode: 'implement-task',
        outcome: 'completed',
        task_id: options.taskId,
        evidence_ref: fx.evidencePath,
        changed_files: changedFiles,
        verification_runs: [],
        summary: 'execution-state fixture task',
        manifest_digest: fx.manifestDigest,
        plan_digest: fx.planDigest,
        proof_index_digest: s08ASliceProofIndexDigest(fx),
        snapshot_digest: fx.snapshotDigest,
        context_ref: contextRef,
        context_digest: context.context_digest,
      },
    },
    { receiptDir, tempDir: receiptDir },
  );
  return written.digest;
}

/** Persist a vNext CV_RESULT receipt in the real cv category vocabulary. */
function writeCvReceipt(
  fx: S08Fixture,
  options: {
    verdict: 'PASS' | 'REPAIR';
    workerReceiptDigest: string;
    contextRef: string;
    contextDigest: string;
    timestamp: string;
    verificationType?: 'initial' | 'recheck';
    previousFailureSignature?: string;
    previousDigest?: string;
    /**
     * Payload overrides applied after the closed v2 CV_RESULT shape has been
     * assembled (S08-REVIEW-005 tamper injection). An explicit `undefined`
     * value drops the field entirely during JSON serialization, so callers
     * can remove a required discriminator (e.g. schema_version) instead of
     * only corrupting it.
     */
    payloadOverrides?: Record<string, unknown>;
  },
): string {
  const slice = fx.manifest.slices.find(
    (candidate: Record<string, any>) => candidate.slice_id === 'S08-A',
  );
  const proofIndex = slice.proof_index as {
    acceptance_refs: string[];
    seam_refs: string[];
    oracle_refs: string[];
    risk_refs: Array<{ ref_id: string }>;
  };
  const cvInput: Record<string, unknown> = {
    schema_version: 2,
    type: 'CV_RESULT',
    stage_id: 'S08',
    slice_id: 'S08-A',
    worker_receipt_digest: options.workerReceiptDigest,
    manifest_digest: fx.manifestDigest,
    plan_digest: fx.planDigest,
    proof_index_digest: s08ASliceProofIndexDigest(fx),
    context_ref: options.contextRef,
    context_digest: options.contextDigest,
    snapshot_digest: fx.snapshotDigest,
    verification_type: options.verificationType ?? 'initial',
    verdict: options.verdict,
    summary: 'execution-state CV fixture',
    acceptance_refs_checked: [...proofIndex.acceptance_refs],
    seam_refs_checked: [...proofIndex.seam_refs],
    oracle_refs_checked: [...proofIndex.oracle_refs],
    risk_refs_considered: proofIndex.risk_refs.map((risk) => ({
      ref_id: risk.ref_id,
      applicability: 'APPLICABLE',
      reason: 'fixture binding',
    })),
    failed_acceptance_refs: [],
    invalid_tests: [],
    counterexamples: [],
    scope_violations: [],
    forbidden_substitutions: [],
    regression_failures: [],
  };
  if (options.verdict === 'REPAIR') {
    cvInput.failed_criterion = 'fixture criterion';
    cvInput.failure_signature = 'fixture failure signature';
    cvInput.required_recheck_scope = ['packages/opencode-plugin/src/tools/plan-status.ts'];
  }
  if (options.verificationType === 'recheck') {
    cvInput.previous_failure_signature =
      options.previousFailureSignature ?? 'fixture failure signature';
    // S08-REVIEW-006: the closed recheck branch requires the repair diff
    // digest that proves the repair was a real, digest-addressed change.
    cvInput.repair_diff_digest = 'ab'.repeat(32);
  }
  const receiptDir = path.join(fx.root, '.proofloop/receipts/cv/S08/S08-A');
  fs.mkdirSync(receiptDir, { recursive: true });
  const written = writeReceipt(
    {
      version: 1,
      type: options.verdict === 'PASS' ? 'CV_PASS' : 'CV_REPAIR',
      stage_id: 'S08',
      slice_id: 'S08-A',
      timestamp: options.timestamp,
      ...(options.previousDigest !== undefined ? { previous_digest: options.previousDigest } : {}),
      payload: { ...cvInput, ...options.payloadOverrides },
    },
    { receiptDir, tempDir: receiptDir },
  );
  return written.digest;
}

/** Persist a vNext SLICE_COMMIT fact bound to the current committed boundary. */
function writeSliceCommit(
  fx: S08Fixture,
  options: { commitSha: string; cvReceiptDigest: string; changedFiles: string[]; timestamp: string },
): void {
  const receiptDir = path.join(fx.root, '.proofloop/receipts/committer/S08/S08-A');
  fs.mkdirSync(receiptDir, { recursive: true });
  writeReceipt(
    {
      version: 1,
      type: 'SLICE_COMMIT',
      stage_id: 'S08',
      slice_id: 'S08-A',
      timestamp: options.timestamp,
      payload: {
        schema_version: 2,
        type: 'SLICE_COMMIT_RESULT',
        action: 'SLICE_COMMIT',
        stage_id: 'S08',
        slice_id: 'S08-A',
        manifest_digest: fx.manifestDigest,
        plan_digest: fx.planDigest,
        proof_index_digest: s08ASliceProofIndexDigest(fx),
        snapshot_digest: options.commitSha,
        commit_sha: options.commitSha,
        cv_receipt_digest: options.cvReceiptDigest,
        changed_files: options.changedFiles,
        receipt_chain_valid: true,
      },
    },
    { receiptDir, tempDir: receiptDir },
  );
}

describe('vNext execution-state boundary separation (S08-E-T01)', () => {
  it('planning clean boundary: a clean worktree with no Worker facts dispatches the first Task as implement-task', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const next = nextAction(fx);
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.slice_id).toBe('S08-A');
    expect(next.task_id).toBe('S08-A-T01');
    expect(next.mode).toBe('implement-task');
  });

  it('planning clean boundary: scope-bound dirty without Worker facts and without a recover binding fails closed', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    // A scope-bound edit with NO admitted Worker fact and NO checked Task
    // checkbox (no persisted recover binding) is execution-state dirty; the
    // planning clean gate must reject it instead of dispatching into a dirty
    // worktree.
    fs.appendFileSync(
      path.join(fx.root, 'packages/opencode-plugin/src/tools/plan-status.ts'),
      '// untracked worker edit\n',
      'utf8',
    );
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/planning clean boundary|clean worktree|recover binding/);
    expect(next.context_ref).toBeUndefined();
  });

  it('planning clean boundary: out-of-scope dirty without Worker facts fails closed', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const scratch = path.join(fx.root, 'scratch/session.json');
    fs.mkdirSync(path.dirname(scratch), { recursive: true });
    fs.writeFileSync(scratch, JSON.stringify({ task: 'S08-A-T01' }), 'utf8');
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/execution dirty path|outside the admitted/i);
  });

  it('planning clean boundary: a checked Task checkbox admits scope-bound dirty as the persisted recover binding (recover-task, not a fresh implement)', () => {
    const fx = s08Fixture();
    admitS08(fx);
    // The real planning projection already carries the checked S08-A-T01 box:
    // dirty scope-bound evidence without an admitted fact is the persisted
    // recover binding, so next re-dispatches recover-task instead of failing
    // the planning clean gate or re-implementing.
    fs.appendFileSync(
      path.join(fx.root, 'packages/opencode-plugin/src/tools/plan-status.ts'),
      '// worker evidence before session loss\n',
      'utf8',
    );
    const next = nextAction(fx);
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.slice_id).toBe('S08-A');
    expect(next.task_id).toBe('S08-A-T01');
    expect(next.mode).toBe('recover-task');
  });

  it('execution dirty boundary: a persisted TASK_COMPLETE fact projects the next Task without re-applying the planning clean gate', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    completeTask(fx, {
      taskId: 'S08-A-T01',
      actionToken: 'exec-state-t01',
      timestamp: '2026-08-07T00:00:01.000Z',
    });
    // The worktree is dirty with scope-bound paths and a Worker fact exists:
    // next must NOT run the planning clean gate again — it projects the next
    // Task from the persisted fact.
    const next = nextAction(fx);
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.slice_id).toBe('S08-A');
    expect(next.task_id).toBe('S08-A-T02');
    expect(next.mode).toBe('implement-task');
  });

  it('execution dirty boundary: out-of-scope dirty after a Worker fact still fails closed', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    completeTask(fx, {
      taskId: 'S08-A-T01',
      actionToken: 'exec-state-t01b',
      timestamp: '2026-08-07T00:00:02.000Z',
    });
    const scratch = path.join(fx.root, 'scratch/session.json');
    fs.mkdirSync(path.dirname(scratch), { recursive: true });
    fs.writeFileSync(scratch, JSON.stringify({ task: 'S08-A-T02' }), 'utf8');
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/execution dirty path|outside the admitted/i);
  });

  it('projects RUN_CV from persisted TASK_COMPLETE facts once every Slice task is complete', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    completeTask(fx, {
      taskId: 'S08-A-T01',
      actionToken: 'exec-state-t01c',
      timestamp: '2026-08-07T00:00:03.000Z',
    });
    completeTask(fx, {
      taskId: 'S08-A-T02',
      actionToken: 'exec-state-t02',
      timestamp: '2026-08-07T00:00:04.000Z',
    });
    completeTask(fx, {
      taskId: 'S08-A-T03',
      actionToken: 'exec-state-t03',
      timestamp: '2026-08-07T00:00:05.000Z',
    });
    const next = nextAction(fx);
    expect(next.action).toBe('RUN_CV');
    expect(next.slice_id).toBe('S08-A');
    expect(next.task_id).toBeUndefined();
    expect(next.responsible_role).toBe('code-verifier');
    expect(next.receipt_chain_valid).toBe(true);
    expect(next).not.toHaveProperty('cv_verdict');
  });

  it('keeps projecting RUN_CV after a persisted CV REPAIR fact (recheck verdict pending)', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const t01 = completeTask(fx, {
      taskId: 'S08-A-T01',
      actionToken: 'exec-state-t01d',
      timestamp: '2026-08-07T00:00:06.000Z',
    });
    completeTask(fx, {
      taskId: 'S08-A-T02',
      actionToken: 'exec-state-t02b',
      timestamp: '2026-08-07T00:00:07.000Z',
    });
    const t03 = completeTask(fx, {
      taskId: 'S08-A-T03',
      actionToken: 'exec-state-t03b',
      timestamp: '2026-08-07T00:00:08.000Z',
    });
    const lastContextRef = taskContext(fx, 'S08-A-T03');
    writeCvReceipt(fx, {
      verdict: 'REPAIR',
      workerReceiptDigest: t03,
      contextRef: lastContextRef.context_ref,
      contextDigest: lastContextRef.context_digest,
      timestamp: '2026-08-07T00:00:09.000Z',
    });
    void t01;
    // A REPAIR verdict does not close the execution chain: next stays on
    // RUN_CV and waits for the bounded recheck verdict.
    const next = nextAction(fx);
    expect(next.action).toBe('RUN_CV');
    expect(next.slice_id).toBe('S08-A');
  });

  it('fails closed to VALIDATE instead of RUN_CV when a persisted CV_REPAIR history binds an earlier Context', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    completeTask(fx, {
      taskId: 'S08-A-T01',
      actionToken: 'exec-state-t01f',
      timestamp: '2026-08-07T00:00:15.000Z',
    });
    completeTask(fx, {
      taskId: 'S08-A-T02',
      actionToken: 'exec-state-t02d',
      timestamp: '2026-08-07T00:00:16.000Z',
    });
    const t03 = completeTask(fx, {
      taskId: 'S08-A-T03',
      actionToken: 'exec-state-t03d',
      timestamp: '2026-08-07T00:00:17.000Z',
    });
    // 历史 CV_REPAIR 使用当前 Worker tip，但绑定较早 Task（T01）的 Context：
    // schema/digest/tuple/Proof Index/failure_signature 全部合法，只有最终
    // Worker Context digest 绑定缺失。next 的恢复/Commit 读取（expectedContextDigest
    // 绑定）拒绝该链，RUN_CV 投影也必须与恢复路径同强度拒绝，
    // 而不是继续返回 RUN_CV（S08-REVIEW-009 对称绑定）。
    const earlyContext = taskContext(fx, 'S08-A-T01');
    writeCvReceipt(fx, {
      verdict: 'REPAIR',
      workerReceiptDigest: t03,
      contextRef: earlyContext.context_ref,
      contextDigest: earlyContext.context_digest,
      timestamp: '2026-08-07T00:00:18.000Z',
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/final Worker Context/);
  });

  it('does not repeat RUN_CV after CV PASS + Slice Commit; it advances past the committed Slice on a descendant HEAD', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    completeTask(fx, {
      taskId: 'S08-A-T01',
      actionToken: 'exec-state-t01e',
      timestamp: '2026-08-07T00:00:10.000Z',
    });
    completeTask(fx, {
      taskId: 'S08-A-T02',
      actionToken: 'exec-state-t02c',
      timestamp: '2026-08-07T00:00:11.000Z',
    });
    const t03 = completeTask(fx, {
      taskId: 'S08-A-T03',
      actionToken: 'exec-state-t03c',
      timestamp: '2026-08-07T00:00:12.000Z',
    });
    const lastTaskReceipt = taskContext(fx, 'S08-A-T03');
    const cvPass = writeCvReceipt(fx, {
      verdict: 'PASS',
      workerReceiptDigest: t03,
      contextRef: lastTaskReceipt.context_ref,
      contextDigest: lastTaskReceipt.context_digest,
      timestamp: '2026-08-07T00:00:13.000Z',
    });
    // Slice Commit is a normal execution Git boundary: HEAD advances to a
    // descendant of the admission snapshot and the SLICE_COMMIT fact binds it.
    execFileSync('git', ['-C', fx.root, 'add', '-A']);
    execFileSync('git', ['-C', fx.root, 'commit', '-q', '-m', 'slice-output: S08-S08-A']);
    const committedHead = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    writeSliceCommit(fx, {
      commitSha: committedHead,
      cvReceiptDigest: cvPass,
      changedFiles: [
        fx.evidencePath,
        fx.planPath,
        ...Object.values(S08_A_SCOPE_FILE_BY_TASK),
        ...Object.values(S08_A_TEST_FILE_BY_TASK),
      ],
      timestamp: '2026-08-07T00:00:14.000Z',
    });

    // CV PASS + Slice Commit close the S08-A execution chain: next must never
    // re-project RUN_CV for the committed Slice and must advance to the next
    // dependency-ready Slice while keeping the admitted snapshot binding.
    const next = nextAction(fx);
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.slice_id).toBe('S08-B');
    expect(next.task_id).toBe('S08-B-T01');
    expect(next.snapshot_digest).toBe(fx.snapshotDigest);
  });
});

// ---------------------------------------------------------------------------
// S08-REVIEW-004 — the next consumer must fail closed on a semantically
// incomplete SLICE_COMMIT record. readVNextCommittedSliceIds used to verify
// only the generic Receipt fields (self-digest, stage/slice, schema/type/
// action, Manifest/Plan digest, snapshot chain); a self-digest-correct but
// semantically incomplete SLICE_COMMIT (wrong/missing semantic bindings) must
// never project the Slice as committed and dispatch its dependent Slice.
// ---------------------------------------------------------------------------

function committedS08A(
  fx: S08Fixture,
  options: {
    tokenPrefix?: string;
    cvHistory?: Array<'PASS' | 'REPAIR'>;
    repairFile?: string;
    /**
     * S08-REVIEW-005: inject a non-closed CV_RESULT payload while the Receipt
     * self-digest and chain stay valid (writeReceipt recomputes the digest).
     */
    cvPayloadOverrides?: Record<string, unknown>;
    /**
     * S08-REVIEW-005: only complete the first N Manifest tasks of S08-A, so
     * the Worker chain covers a strict subset of the declared task_refs.
     */
    completeTasks?: 1 | 2 | 3;
    /**
     * S08-REVIEW-005: a real Git path committed as part of the Slice boundary
     * but intentionally NOT declared in SLICE_COMMIT.changed_files (the
     * Receipt still matches the Worker fact union, so only a Git diff
     * cross-check can catch it).
     */
    extraCommittedFile?: string;
    /**
     * S08-REVIEW-005: restore these scope files to their pre-execution content
     * before the Slice Commit boundary, so the real commit diff is missing
     * files that every Worker fact (and the SLICE_COMMIT) still declares.
     */
    revertFilesBeforeCommit?: string[];
    /**
     * S08-REVIEW-006: override the recheck member's previous_failure_signature
     * so it can diverge from the failure_signature of the preceding CV_REPAIR
     * fact (a legal chain requires an exact match).
     */
    cvPreviousFailureSignature?: string;
    /**
     * S08-REVIEW-007: per-member payload overrides, applied by chain index
     * (a `undefined` member falls back to `cvPayloadOverrides`). Used to
     * tamper only ONE fact of a REPAIR → recheck chain (e.g. inject a
     * duplicate failure-detail entry into the REPAIR fact without breaking
     * the closed PASS branch of the recheck fact).
     */
    cvPayloadOverridesAt?: Array<Record<string, unknown> | undefined>;
  } = {},
): {
  committedHead: string;
  cvPassDigest: string;
  workerChangedFiles: string[];
} {
  const tokenPrefix = options.tokenPrefix ?? 'semantic';
  const timeBase = '2026-08-08T00:00:';
  const completeCount = options.completeTasks ?? 3;
  const taskOrder = ['S08-A-T01', 'S08-A-T02', 'S08-A-T03'] as const;
  let workerTipDigest = '';
  for (const [index, taskId] of taskOrder.entries()) {
    if (index >= completeCount) break;
    workerTipDigest = completeTask(fx, {
      taskId,
      actionToken: `${tokenPrefix}-t${String(index + 1).padStart(2, '0')}`,
      timestamp: `${timeBase}${String(index + 1).padStart(2, '0')}.000Z`,
    });
  }
  const lastTaskReceipt = taskContext(fx, taskOrder[completeCount - 1] as string);
  const cvHistory = options.cvHistory ?? ['PASS'];
  let cvTipDigest = '';
  let previousVerdict: 'PASS' | 'REPAIR' | undefined;
  // A tampered CV payload re-digests the Receipt file; the old file must not
  // survive as a second chain genesis.
  if (options.cvPayloadOverrides !== undefined) {
    fs.rmSync(path.join(fx.root, '.proofloop/receipts/cv/S08/S08-A'), {
      recursive: true,
      force: true,
    });
  }
  for (const [index, verdict] of cvHistory.entries()) {
    cvTipDigest = writeCvReceipt(fx, {
      verdict,
      workerReceiptDigest: workerTipDigest,
      contextRef: lastTaskReceipt.context_ref,
      contextDigest: lastTaskReceipt.context_digest,
      timestamp: `${timeBase}${String(4 + index).padStart(2, '0')}.000Z`,
      verificationType: previousVerdict === 'REPAIR' ? 'recheck' : 'initial',
      previousFailureSignature: options.cvPreviousFailureSignature,
      // A real CV chain is a single linked Receipt chain (admission contract).
      previousDigest: index === 0 ? undefined : cvTipDigest,
      payloadOverrides: options.cvPayloadOverridesAt?.[index] ?? options.cvPayloadOverrides,
    });
    previousVerdict = verdict;
  }
  if (options.repairFile !== undefined) {
    // A Worker repair produces files no Worker fact declared; they are part
    // of the committed Slice boundary (S08-E shape).
    const repairPath = path.join(fx.root, options.repairFile);
    fs.mkdirSync(path.dirname(repairPath), { recursive: true });
    fs.writeFileSync(repairPath, '// repair-only change\n', 'utf8');
  }
  if (options.extraCommittedFile !== undefined) {
    // A real file committed into the Slice boundary but absent from the
    // declared changed_files (and absent from every Worker fact).
    const extraPath = path.join(fx.root, options.extraCommittedFile);
    fs.mkdirSync(path.dirname(extraPath), { recursive: true });
    fs.writeFileSync(extraPath, '// extra committed file\n', 'utf8');
  }
  if (options.revertFilesBeforeCommit !== undefined) {
    // HEAD is still the pre-execution boundary, so restoring the working tree
    // file removes the Worker change from the upcoming Slice Commit diff while
    // every Worker fact still declares it.
    for (const relative of options.revertFilesBeforeCommit) {
      execFileSync('git', ['-C', fx.root, 'checkout', '--', relative], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    }
  }
  execFileSync('git', ['-C', fx.root, 'add', '-A']);
  execFileSync('git', ['-C', fx.root, 'commit', '-q', '-m', `slice-output: S08-S08-A (${tokenPrefix})`]);
  const committedHead = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const workerChangedFiles = [...new Set([
    fx.evidencePath,
    fx.planPath,
    ...taskOrder.slice(0, completeCount).flatMap((taskId) => [
      S08_A_SCOPE_FILE_BY_TASK[taskId],
      S08_A_TEST_FILE_BY_TASK[taskId],
    ]),
  ])].sort();
  return { committedHead, cvPassDigest: cvTipDigest, workerChangedFiles };
}

function writeSliceCommitWith(
  fx: S08Fixture,
  base: { commitSha: string; cvReceiptDigest: string; changedFiles: string[] },
  overrides: Record<string, unknown> = {},
): void {
  const receiptDir = path.join(fx.root, '.proofloop/receipts/committer/S08/S08-A');
  fs.mkdirSync(receiptDir, { recursive: true });
  writeReceipt(
    {
      version: 1,
      type: 'SLICE_COMMIT',
      stage_id: 'S08',
      slice_id: 'S08-A',
      timestamp: '2026-08-08T00:00:20.000Z',
      payload: {
        schema_version: 2,
        type: 'SLICE_COMMIT_RESULT',
        action: 'SLICE_COMMIT',
        stage_id: 'S08',
        slice_id: 'S08-A',
        manifest_digest: fx.manifestDigest,
        plan_digest: fx.planDigest,
        proof_index_digest: s08ASliceProofIndexDigest(fx),
        snapshot_digest: base.commitSha,
        commit_sha: base.commitSha,
        cv_receipt_digest: base.cvReceiptDigest,
        changed_files: base.changedFiles,
        receipt_chain_valid: true,
        ...overrides,
      },
    },
    { receiptDir, tempDir: receiptDir },
  );
}

describe('vNext committed Slice semantic bindings fail closed (S08-REVIEW-004)', () => {
  it('fails closed when SLICE_COMMIT changed_files do not match the Worker fact union', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, { tokenPrefix: 'semantic-changed' });
    // Tamper: drop the T03 test file from the declared changed_files while
    // the Receipt self-digest stays correct (writeReceipt recomputes it).
    const tampered = chain.workerChangedFiles.filter(
      (file) => file !== 'packages/opencode-plugin/src/tools/review-wiring.spec.ts',
    );
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: tampered,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/changed_files|Worker fact/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when SLICE_COMMIT cv_receipt_digest does not bind the latest CV_PASS tip', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, { tokenPrefix: 'semantic-cv' });
    // A CV_PASS chain exists, but the Receipt points at a foreign digest.
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: 'c'.repeat(64),
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/cv_receipt_digest|CV_PASS/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when no CV chain backs the SLICE_COMMIT cv_receipt_digest', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, { tokenPrefix: 'semantic-nocv', cvHistory: [] });
    // The Receipt claims a CV_PASS binding but no CV fact was ever persisted.
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: 'c'.repeat(64),
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/cv_receipt_digest|CV_PASS|CV Receipt/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when SLICE_COMMIT commit_sha is not on the admitted Git execution chain', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, { tokenPrefix: 'semantic-sha' });
    // A format-valid but foreign/non-existent commit SHA is not a descendant
    // of the admitted snapshot; the Git boundary check must fail closed.
    writeSliceCommitWith(fx, {
      commitSha: 'a'.repeat(40),
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/SLICE_COMMIT\.commit_sha|admitted snapshot|Git/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when SLICE_COMMIT proof_index_digest does not equal the current Proof Index digest', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, { tokenPrefix: 'semantic-proof' });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    }, { proof_index_digest: 'a'.repeat(64) });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/proof_index_digest|Proof Index/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when SLICE_COMMIT receipt_chain_valid is not asserted', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, { tokenPrefix: 'semantic-chain' });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    }, { receipt_chain_valid: false });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/receipt_chain_valid|Receipt chain/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('still advances past a committed Slice when REPAIR history legitimizes repair-only changed_files', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, {
      tokenPrefix: 'semantic-repair',
      cvHistory: ['REPAIR', 'PASS'],
      repairFile: 'packages/opencode-plugin/src/tools/plan.ts',
    });
    // REPAIR → recheck PASS: the committed boundary may contain repair-only
    // files no Worker fact declared; the Receipt must still cover every
    // declared Worker fact file and stay inside the Manifest Slice scope.
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: [...chain.workerChangedFiles, 'packages/opencode-plugin/src/tools/plan.ts'],
    });
    const next = nextAction(fx);
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.slice_id).toBe('S08-B');
    expect(next.task_id).toBe('S08-B-T01');
  });
});

// ---------------------------------------------------------------------------
// S08-REVIEW-005 — the next consumer must fail closed on the remaining closed
// integrity gaps of a committed Slice:
//   1. the CV tip payload must be a closed v2 CV_RESULT (schema/type/verdict/
//      verification_type vocabulary + Manifest/Plan/Proof Index/snapshot
//      bindings + worker_receipt_digest equal to the Slice Worker chain tip);
//   2. a committed Slice must be backed by a TASK_COMPLETE fact for EVERY
//      Manifest task (a strict subset of task_refs must never be committed);
//   3. the SLICE_COMMIT commit_sha Git boundary must be cross-validated: the
//      actual parent..commit file set must exactly equal the declared
//      changed_files.
// A self-digest-correct Receipt chain that violates any of these must project
// VALIDATE and never dispatch the dependent Slice.
// ---------------------------------------------------------------------------

describe('vNext committed Slice closed-chain integrity fails closed (S08-REVIEW-005)', () => {
  it('fails closed when the CV_PASS tip payload is not a closed v2 CV_RESULT (schema_version missing)', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-schema',
      // Drop the v2 discriminator; the Receipt self-digest and chain stay
      // valid because writeReceipt recomputes both.
      cvPayloadOverrides: { schema_version: undefined },
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/schema_version|closed v2 CV_RESULT/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when the CV_PASS tip payload verdict is outside the closed vocabulary', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-verdict',
      cvPayloadOverrides: { verdict: 'INDETERMINATE' },
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/verdict/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when the CV_PASS tip payload manifest_digest does not bind the active Manifest', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-manifest',
      cvPayloadOverrides: { manifest_digest: 'b'.repeat(64) },
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/manifest_digest|bound/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when a SLICE_COMMIT is not backed by a TASK_COMPLETE fact for every Manifest task', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    // Only S08-A-T01/T02 are completed; the T03 Worker fact is missing while
    // the CV chain, commit and declared changed_files all look consistent for
    // the completed subset.
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-partial-tasks',
      completeTasks: 2,
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/every Manifest task|missing|TASK_COMPLETE/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when the commit diff contains files the SLICE_COMMIT did not declare', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    // The committed boundary contains an extra real file no Worker fact and no
    // SLICE_COMMIT.changed_files entry declared; only the Git diff
    // cross-validation of the real commit_sha can catch it.
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-commit-extra',
      extraCommittedFile: 'packages/opencode-plugin/src/tools/plan.ts',
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/commit diff|changed_files/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when the commit diff is missing files the SLICE_COMMIT declared', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    // The T03 scope files are restored before the Slice Commit boundary, so
    // the real commit diff no longer contains them while the SLICE_COMMIT
    // (matching the Worker facts) still declares them.
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-commit-missing',
      revertFilesBeforeCommit: [
        'packages/opencode-plugin/src/tools/review.ts',
        'packages/opencode-plugin/src/tools/review-wiring.spec.ts',
      ],
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/commit diff|changed_files/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('still advances past a fully-closed Slice (all tasks + closed CV_PASS + exact commit diff)', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, { tokenPrefix: 'closed-happy' });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    // The complete closed chain (every Manifest task, closed CV_PASS tip, and
    // an exact Git diff match) must keep the pre-005 behavior: skip the
    // committed Slice and dispatch the next dependency-ready Slice.
    const next = nextAction(fx);
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.slice_id).toBe('S08-B');
    expect(next.task_id).toBe('S08-B-T01');
    expect(next.snapshot_digest).toBe(fx.snapshotDigest);
  });
});

// ---------------------------------------------------------------------------
// S08-REVIEW-006 — the next consumer must apply the SAME closed CV validation
// strength as CV admission, instead of a hand-written "equivalent" subset:
//   1. the closed v2 CV_RESULT payload check must cover the FULL field set
//      (context_ref/context_digest, summary, the Proof Index reference arrays,
//      and the PASS/REPAIR + initial/recheck branch fields), not only the
//      vocabulary and tuple bindings;
//   2. the outer Receipt type and the payload verdict must agree (CV_PASS ↔
//      PASS, CV_REPAIR ↔ REPAIR);
//   3. the persisted CV chain must be a legal initial → REPAIR → recheck
//      sequence (a second initial, a recheck without a preceding REPAIR, a
//      recheck whose previous_failure_signature diverges from the preceding
//      CV_REPAIR, or any continuation after a CV_PASS fails closed);
//   4. SLICE_COMMIT.commit_sha must lie on the CURRENT Git HEAD ancestry
//      (equal to HEAD or an ancestor of it), like Integration admission — a
//      side-branch commit with a correct diff but not on the current
//      execution branch must fail closed.
// A self-digest-correct CV chain / SLICE_COMMIT that violates any of these
// must project VALIDATE and never dispatch the dependent Slice.
// ---------------------------------------------------------------------------

describe('vNext CV chain closed validation fails closed (S08-REVIEW-006)', () => {
  it('fails closed when the outer CV_PASS Receipt type does not match the payload verdict (REPAIR)', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    // The outer Receipt discriminator stays CV_PASS (writeReceipt derives it
    // from the verdict option) while the payload verdict is overridden to
    // REPAIR — and the REPAIR branch fields (failed_criterion etc.) are
    // absent. Neither the type↔verdict agreement nor the branch field
    // completeness may survive.
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-type-verdict',
      cvPayloadOverrides: { verdict: 'REPAIR' },
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/CV_PASS|CV_REPAIR|verdict|REPAIR/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when the CV_PASS tip payload lacks context_ref/context_digest', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-context',
      cvPayloadOverrides: { context_ref: undefined, context_digest: undefined },
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/context_ref|context_digest/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when the CV_PASS tip payload lacks summary', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-summary',
      cvPayloadOverrides: { summary: undefined },
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/summary/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when the CV_PASS tip payload lacks the acceptance_refs_checked array', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-refs',
      cvPayloadOverrides: { acceptance_refs_checked: undefined },
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/acceptance_refs_checked|refs_checked/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when the CV chain sequence is illegal (a second initial verification after a CV_PASS genesis)', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    // cvHistory ['PASS', 'PASS']: the second member is derived as another
    // initial verification (the helper only derives recheck after a REPAIR),
    // so the persisted chain contains two initial CV facts — a sequence CV
    // admission would reject. The Receipt self-digests and the chain links
    // stay valid.
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-seq-initial',
      cvHistory: ['PASS', 'PASS'],
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/initial|recheck|sequence/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when a CV recheck previous_failure_signature does not match the preceding CV_REPAIR fact', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-seq-signature',
      cvHistory: ['REPAIR', 'PASS'],
      cvPreviousFailureSignature: 'diverged failure signature',
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/previous_failure_signature|CV_REPAIR/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when SLICE_COMMIT commit_sha is a side-branch commit not on the current HEAD ancestry', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, { tokenPrefix: 'closed-side-branch' });
    // Replay the exact same Slice boundary file set on a side branch created
    // from the ADMITTED SNAPSHOT: the resulting commit carries the exact
    // changed_files diff (so the diff cross-check passes) and is a Git
    // descendant of the admitted snapshot (so the snapshot-chain check
    // passes), but it is NOT the current branch HEAD nor an ancestor of it.
    // Only the Integration-style HEAD-ancestry binding can reject it.
    execFileSync('git', ['-C', fx.root, 'checkout', '-q', '-b', 'side-branch', fx.snapshotDigest]);
    for (const relative of [
      ...Object.values(S08_A_SCOPE_FILE_BY_TASK),
      ...Object.values(S08_A_TEST_FILE_BY_TASK),
      fx.evidencePath,
    ]) {
      fs.appendFileSync(path.join(fx.root, relative), '// side-branch worker change\n', 'utf8');
    }
    const sidePlanPath = path.join(fx.root, fx.planPath);
    fs.writeFileSync(
      sidePlanPath,
      fs
        .readFileSync(sidePlanPath, 'utf8')
        .replace('- [ ] S08-A-T01', '- [x] S08-A-T01')
        .replace('- [ ] S08-A-T02', '- [x] S08-A-T02')
        .replace('- [ ] S08-A-T03', '- [x] S08-A-T03'),
      'utf8',
    );
    execFileSync('git', ['-C', fx.root, 'add', '-A']);
    execFileSync('git', ['-C', fx.root, 'commit', '-q', '-m', 'slice-output: S08-S08-A (side branch)']);
    const sideCommit = execFileSync('git', ['-C', fx.root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    // Back to the current execution branch (HEAD is the real Slice Commit).
    execFileSync('git', ['-C', fx.root, 'checkout', '-q', '-']);
    writeSliceCommitWith(fx, {
      commitSha: sideCommit,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/commit_sha|HEAD|ancestor/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('still advances past a fully-closed Slice (closed CV chain + current-branch commit)', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-happy',
      cvHistory: ['REPAIR', 'PASS'],
      repairFile: 'packages/opencode-plugin/src/tools/plan.ts',
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: [...chain.workerChangedFiles, 'packages/opencode-plugin/src/tools/plan.ts'],
    });
    // The full REPAIR → recheck PASS chain with a matching failure signature
    // plus a current-branch commit keeps the legal path: skip the committed
    // Slice and dispatch the next dependency-ready Slice.
    const next = nextAction(fx);
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.slice_id).toBe('S08-B');
    expect(next.task_id).toBe('S08-B-T01');
    expect(next.snapshot_digest).toBe(fx.snapshotDigest);
  });
});

// ---------------------------------------------------------------------------
// S08-REVIEW-007 — the shared CV validation module (`cv-validation.ts`) must
// reach the FULL strength of cv-admission instead of a weaker subset. The next
// consumer binds it to the persisted facts, so a self-digest-correct CV chain
// must fail closed (project VALIDATE, never dispatch the dependent Slice) when:
//   1. a CV reference array is not EXACTLY the Manifest Slice Proof Index set
//      (extra / missing / swapped acceptance refs);
//   2. a REPAIR fact's failed_acceptance_refs contains a ref outside the
//      Manifest acceptance set;
//   3. the CV context_ref/context_digest is not bound to the FINAL Worker
//      Context (a nonexistent digest or an earlier task's Context);
//   4. a failure-detail array of a persisted CV fact contains duplicate
//      entries (cv-admission's uniqueStringArray rejects them);
//   5. two CV facts illegally reuse the same Worker tip (only the direct
//      REPAIR → recheck successor may rebind the tip).
// The closed positive path (exact refs + final Worker Context + unique
// failure arrays + legal REPAIR → recheck tip reuse) still advances.
// ---------------------------------------------------------------------------

describe('vNext shared CV validation reaches cv-admission strength (S08-REVIEW-007)', () => {
  it('fails closed when a CV reference array is not exactly the Manifest Proof Index set (extra/missing/swapped)', () => {
    const variants = [
      { name: 'extra', mutate: (refs: string[]) => [...refs, 'REF-FOREIGN-ACCEPTANCE'] },
      { name: 'missing', mutate: (refs: string[]) => refs.slice(1) },
      { name: 'swapped', mutate: (refs: string[]) => [refs[0], 'REF-SWAPPED-ACCEPTANCE'] },
    ];
    for (const variant of variants) {
      const fx = s08Fixture({ freshPlanning: true });
      admitS08(fx);
      const slice = fx.manifest.slices.find(
        (candidate: Record<string, any>) => candidate.slice_id === 'S08-A',
      ) as { proof_index: { acceptance_refs: string[] } };
      const chain = committedS08A(fx, {
        tokenPrefix: `closed-cv-refs-${variant.name}`,
        cvPayloadOverrides: {
          acceptance_refs_checked: variant.mutate([...slice.proof_index.acceptance_refs]),
        },
      });
      writeSliceCommitWith(fx, {
        commitSha: chain.committedHead,
        cvReceiptDigest: chain.cvPassDigest,
        changedFiles: chain.workerChangedFiles,
      });
      const next = nextAction(fx);
      expect(next.action, variant.name).toBe('VALIDATE');
      expect(next.findings[0]?.message, variant.name).toMatch(
        /acceptance_refs_checked|Proof Index/i,
      );
      expect(next.slice_id, variant.name).toBeUndefined();
    }
  });

  it('fails closed when a persisted REPAIR fact declares failed_acceptance_refs outside the Manifest acceptance set', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-failed-out-of-scope',
      cvHistory: ['REPAIR', 'PASS'],
      // Only the REPAIR fact carries the out-of-scope failure ref; the
      // recheck PASS fact keeps the closed PASS branch (empty failure arrays).
      cvPayloadOverridesAt: [{ failed_acceptance_refs: ['REF-FOREIGN-ACCEPTANCE'] }, undefined],
      repairFile: 'packages/opencode-plugin/src/tools/plan.ts',
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: [...chain.workerChangedFiles, 'packages/opencode-plugin/src/tools/plan.ts'],
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/failed_acceptance_refs|out-of-scope/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when the CV context_ref/context_digest is not bound to the final Worker Context', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    // Case A: the CV claims a Context that never existed (foreign digest).
    const foreignDigest = 'f'.repeat(64);
    const foreignCase = committedS08A(fx, {
      tokenPrefix: 'closed-cv-context-foreign',
      cvPayloadOverrides: {
        context_ref: `.proofloop/context/${foreignDigest}.json`,
        context_digest: foreignDigest,
      },
    });
    writeSliceCommitWith(fx, {
      commitSha: foreignCase.committedHead,
      cvReceiptDigest: foreignCase.cvPassDigest,
      changedFiles: foreignCase.workerChangedFiles,
    });
    const foreignNext = nextAction(fx);
    expect(foreignNext.action).toBe('VALIDATE');
    expect(foreignNext.findings[0]?.message).toMatch(/context_ref|context_digest|Context/i);
    expect(foreignNext.slice_id).toBeUndefined();
  });

  it('fails closed when the CV binds an earlier task Context instead of the final Worker Context', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    // Complete the chain, then rebind the CV to the FIRST task's Context
    // (self-digest-correct, but not the final completed Manifest task).
    const chain = committedS08A(fx, { tokenPrefix: 'closed-cv-context-stale' });
    const tasksDir = path.join(fx.root, '.proofloop/receipts/tasks/S08/S08-A');
    const taskReceipts = fs
      .readdirSync(tasksDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) =>
        JSON.parse(fs.readFileSync(path.join(tasksDir, name), 'utf8')) as {
          digest: string;
          payload: { task_id: string; context_ref: string; context_digest: string };
        },
      );
    const firstTask = taskReceipts.find((receipt) => receipt.payload.task_id === 'S08-A-T01');
    const workerTip = taskReceipts.find((receipt) => receipt.payload.task_id === 'S08-A-T03');
    if (firstTask === undefined || workerTip === undefined) {
      throw new Error('S08-A Worker chain is incomplete in the fixture');
    }
    const cvDir = path.join(fx.root, '.proofloop/receipts/cv/S08/S08-A');
    fs.rmSync(cvDir, { recursive: true, force: true });
    const cvTipDigest = writeCvReceipt(fx, {
      verdict: 'PASS',
      workerReceiptDigest: workerTip.digest,
      contextRef: firstTask.payload.context_ref,
      contextDigest: firstTask.payload.context_digest,
      timestamp: '2026-08-08T00:00:30.000Z',
    });
    // Rebind the SLICE_COMMIT to the rewritten CV_PASS tip.
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: cvTipDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/context_ref|context_digest|Context/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when a persisted CV failure-detail array contains duplicate entries', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-dup-failure',
      cvHistory: ['REPAIR', 'PASS'],
      // cv-admission's uniqueStringArray rejects duplicate failure details;
      // the shared validator must apply the same rule to the REPAIR fact.
      cvPayloadOverridesAt: [{ invalid_tests: ['duplicate', 'duplicate'] }, undefined],
      repairFile: 'packages/opencode-plugin/src/tools/plan.ts',
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: [...chain.workerChangedFiles, 'packages/opencode-plugin/src/tools/plan.ts'],
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/invalid_tests|duplicate/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('fails closed when two CV facts illegally reuse the same Worker tip (not a REPAIR→recheck pair)', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    // ['PASS', 'PASS']: both facts bind the SAME Worker tip, but the second
    // member is not the direct recheck successor of a CV_REPAIR — the reuse
    // is illegal (cv-admission's duplicatePredecessor rejects it).
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-tip-reuse',
      cvHistory: ['PASS', 'PASS'],
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: chain.workerChangedFiles,
    });
    const next = nextAction(fx);
    expect(next.action).toBe('VALIDATE');
    expect(next.findings[0]?.message).toMatch(/Worker Receipt tip|reuse/i);
    expect(next.slice_id).toBeUndefined();
  });

  it('still advances past a fully-closed Slice (exact refs + final Worker Context + unique failure arrays)', () => {
    const fx = s08Fixture({ freshPlanning: true });
    admitS08(fx);
    // The closed positive path under the full shared validation: exact
    // Proof Index refs, final Worker Context binding, unique failure arrays,
    // and the legal REPAIR → recheck rebinding of the same Worker tip.
    const chain = committedS08A(fx, {
      tokenPrefix: 'closed-cv-007-happy',
      cvHistory: ['REPAIR', 'PASS'],
      repairFile: 'packages/opencode-plugin/src/tools/plan.ts',
    });
    writeSliceCommitWith(fx, {
      commitSha: chain.committedHead,
      cvReceiptDigest: chain.cvPassDigest,
      changedFiles: [...chain.workerChangedFiles, 'packages/opencode-plugin/src/tools/plan.ts'],
    });
    const next = nextAction(fx);
    expect(next.action).toBe('DISPATCH_WORKER');
    expect(next.slice_id).toBe('S08-B');
    expect(next.task_id).toBe('S08-B-T01');
    expect(next.snapshot_digest).toBe(fx.snapshotDigest);
  });
});
