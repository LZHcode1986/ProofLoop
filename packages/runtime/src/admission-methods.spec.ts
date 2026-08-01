/**
 * admission-methods.spec.ts — S02-E-T02 (PO-S02-E-02 / PO-S02-E-03)
 *
 * Public seam: `@proofloop/runtime` — `admitWorkerResult` and
 * `admitCVResult` (the slice-boundary admit methods wired onto the unified
 * S02-E-T01 pipeline). Filesystem integration: real temp git repos with the
 * canonical `.proofloop` layout, kernel `writeReceipt`-produced receipts,
 * `verifyReceiptChain` per category chain, and fresh `reconcileStage`
 * readback as the oracle (AWI-006 — every successful admit is chain-verified
 * and read back as the corresponding fact; every refusal produces NO
 * Receipt).
 *
 * Covered in this task:
 *  - admitWorkerResult (PO-S02-E-02): completed in the three modes
 *    implement / recover / finalize (evidence-finalized advance to
 *    READY_FOR_CV), repair / diagnose with the CV-REPAIR binding (cv
 *    FIX → PENDING_RECHECK), outcome blocked / needs-decision / failed
 *    refusal, wrong-state refusal (incl. repair without a CV_REPAIR
 *    binding), schema-invalid envelope refusal.
 *  - admitCVResult (PO-S02-E-03): PASS and REPAIR with the READY_FOR_CV
 *    precondition (composite transition sequence + reducer call sequence
 *    asserted via an injected spy), the CV_IN_PROGRESS runtime intermediate
 *    (dispatched step skipped), the PENDING_RECHECK recheck flow, wrong
 *    precondition refusal (incl. cv-REPAIR slice before repair), invalid
 *    payload refusal at the schema layer.
 *
 * Expected values are known-good literals from the authority excerpts
 * (kernel §6 tables, AWI-006, PO-S02-E-02/03) — not derived from the
 * implementation under test.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeReceipt, verifyReceiptChain, StageState, ProjectState } from '@proofloop/kernel';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import { SliceState, CVStatus } from '@proofloop/kernel';
import {
  reconcileStage,
  receiptCategoryDir,
  admitWorkerResult,
  admitCVResult,
  reduceRuntimeAction,
  type AdmissionDeps,
  type AdmitReduceFn,
  type ReconcileStageResult,
  type RuntimeAction,
  type WorkerResultEnvelope,
  type CVResultAdmissionRequest,
  type WorkerResultAdmissionRequest,
  type ReceiptContentCategory,
} from '@proofloop/runtime';

// ============================================================
// Known-good literals (authority excerpts — never derived)
// ============================================================

const STAGE_ID = 'S02';
const SLICE_ID = 'S02-E';
const TASKS: readonly string[] = ['S02-E-T01', 'S02-E-T02'];
const COMMIT_SHA = 'a'.repeat(40);
const EVIDENCE_REF = 'delivery/stages/S02/evidence/S02-E.md';

function makeEnvelope(overrides: Partial<WorkerResultEnvelope> = {}): WorkerResultEnvelope {
  return {
    schemaVersion: 1,
    actionToken: 'tok-1',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: 'S02-E-T01',
    mode: 'implement-task',
    outcome: 'completed',
    evidenceRef: EVIDENCE_REF,
    changedFiles: ['packages/runtime/src/admission.ts'],
    verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
    summary: 'implemented admitWorkerResult',
    ...overrides,
  };
}

function makeWorkerRequest(
  overrides: Partial<WorkerResultEnvelope> = {},
): WorkerResultAdmissionRequest {
  return { type: 'worker_result', envelope: makeEnvelope(overrides) };
}

function makeCvRequest(
  overrides: Partial<CVResultAdmissionRequest> = {},
): CVResultAdmissionRequest {
  return {
    type: 'cv_result',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    verdict: 'PASS',
    snapshotDigest: COMMIT_SHA,
    summary: 'cv pass',
    ...overrides,
  };
}

// ============================================================
// Fixture helpers (real temp dir + real git repo + canonical layout)
// ============================================================

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

interface AdmitFx {
  readonly root: string;
  readonly stageId: string;
  readonly sliceId: string;
  write(rel: string, content: string): void;
  writeManifest(): void;
  writeTasksMd(checkedTasks: readonly string[]): void;
  writeEvidence(finalized: boolean, evidenceTasks?: readonly string[]): void;
  seedReceipt(
    category: ReceiptContentCategory,
    overrides: Record<string, unknown>,
  ): { path: string; digest: string };
  commitAll(message?: string): string;
  reconcile(): ReconcileStageResult;
  cleanup(): void;
}

function makeFx(stageId = STAGE_ID, sliceId = SLICE_ID): AdmitFx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-admit-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'admit@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Admit Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);

  const sliceDef = (sid: string, taskIds: readonly string[]): ManifestSlice => ({
    slice_id: sid,
    goal: 'AdmissionService 7 类 admit 操作',
    observable_outcome: 'deterministic admits with chain-verified receipts',
    public_seam: '@proofloop/runtime AdmissionService',
    dependencies: ['S02-A'],
    proof_obligations: [
      {
        po_id: 'PO-S02-E-02',
        behavior: 'admitWorkerResult all cases',
        public_seam: 'admitWorkerResult',
        oracle_source: 'real fixture project',
        success_criteria: 'receipt chain valid + reconcile readback',
        required_observation: 'fixture oracle',
        applicable_risk_facts: ['persistent_state', 'core_state_machine'],
      },
    ],
    tasks: [...taskIds],
    risk_facts: ['persistent_state'],
    evidence_path: `delivery/stages/${stageId}/evidence/${sid}.md`,
    cv_minimum_level: 'enhanced',
  });

  const fx: AdmitFx = {
    root,
    stageId,
    sliceId,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    writeManifest: () => {
      const manifest: Manifest = {
        stage_id: stageId,
        source_path: `delivery/stages/${stageId}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'Runtime core application services',
        outcomes: ['deterministic admits'],
        slices: [sliceDef(sliceId, TASKS)],
        dependencies: [],
        risk_facts: [],
      };
      fx.write(`.proofloop/manifests/${stageId}.json`, JSON.stringify(manifest, null, 2));
    },
    writeTasksMd: (checkedTasks) => {
      const lines = TASKS.map(
        (t) => `- [${checkedTasks.includes(t) ? 'x' : ' '}] ${t}: task ${t}`,
      );
      const content =
        `# Stage ${stageId} — Runtime Core\n\n` +
        `## Slice ${sliceId}\n` +
        `<!-- SLICE:${sliceId}:BEGIN -->\n\n` +
        `### Tasks\n\n${lines.join('\n')}\n\n` +
        `<!-- SLICE:${sliceId}:END -->\n`;
      fx.write(`delivery/stages/${stageId}/tasks.md`, content);
    },
    writeEvidence: (finalized, evidenceTasks = TASKS) => {
      const partial =
        `# Slice ${sliceId} Evidence\n\n` +
        `## Task Evidence\n\n### ${TASKS[0]}\n\n- Status: COMPLETE\n\n` +
        `## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
        `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
        `|---|---|---|---|---|\n| *None* | | | | |\n`;
      const finalizedContent =
        `# Slice ${sliceId} Evidence\n\n` +
        `## Task Evidence\n\n${evidenceTasks.map(
          (t) => `### ${t}\n\n- Status: COMPLETE\n`,
        ).join('\n')}` +
        `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n` +
        `### Proof Obligation Coverage\n\n` +
        `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
        `|---|---|---|---|---|\n| PO-S02-E-02 | admission-methods.spec.ts | yes | yes | pass |\n\n` +
        `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`;
      fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, finalized ? finalizedContent : partial);
    },
    seedReceipt: (category, overrides) => {
      const dir = receiptCategoryDir(root, category, stageId, sliceId);
      fs.mkdirSync(dir, { recursive: true });
      return writeReceipt(
        {
          version: 1,
          type: 'TASK_COMPLETE',
          stage_id: stageId,
          slice_id: sliceId,
          timestamp: '2025-01-01T00:00:00.000Z',
          payload: {},
          ...overrides,
        },
        { receiptDir: dir, tempDir: dir },
      );
    },
    commitAll: (message = 'fixture') => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', message]);
      return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf-8',
      }).trim();
    },
    reconcile: () => reconcileStage({ projectRoot: root, stageId }),
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

// ============================================================
// Fixture state builders (derived slice states)
// ============================================================

/** IN_PROGRESS: some tasks checked, evidence written but not finalized. */
function fxInProgress(): AdmitFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([TASKS[0]]);
  fx.writeEvidence(false);
  fx.commitAll();
  return fx;
}

/**
 * Ready-for-finalize: all tasks checked + evidence finalized, NO receipts
 * → reconcile derives IN_PROGRESS (the finalize-slice TASK_COMPLETE receipt
 * is what advances the slice to READY_FOR_CV).
 */
function fxReadyForFinalize(): AdmitFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  fx.commitAll();
  return fx;
}

/**
 * READY_FOR_CV initial (no CV receipts): all tasks checked + evidence
 * finalized + a mode=finalize-slice TASK_COMPLETE receipt.
 */
function fxReadyForCvInitial(): AdmitFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  fx.seedReceipt('tasks', { payload: { mode: 'finalize-slice' } });
  fx.commitAll();
  return fx;
}

/** READY_FOR_CV + cv REPAIR: a CV_REPAIR receipt, no repair admitted yet. */
function fxCvRepair(): { fx: AdmitFx; cvRepairDigest: string } {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  const seeded = fx.seedReceipt('cv', {
    type: 'CV_REPAIR',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: { verdict: 'REPAIR', snapshot_digest: 's1', summary: 'seed repair' },
  });
  fx.commitAll();
  return { fx, cvRepairDigest: seeded.digest };
}

/**
 * READY_FOR_CV + cv PENDING_RECHECK: CV_REPAIR plus a deterministically later
 * repair-mode TASK_COMPLETE (S02-C-T04 PENDING_RECHECK derivation).
 */
function fxPendingRecheck(): { fx: AdmitFx; cvRepairDigest: string } {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  const seeded = fx.seedReceipt('cv', {
    type: 'CV_REPAIR',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: { verdict: 'REPAIR', snapshot_digest: 's1', summary: 'seed repair' },
  });
  fx.seedReceipt('tasks', {
    timestamp: '2025-01-02T00:00:00.000Z',
    payload: { mode: 'repair', cv_receipt_digest: seeded.digest },
  });
  fx.commitAll();
  return { fx, cvRepairDigest: seeded.digest };
}

/** CV_PASSED (negative precondition fixture): a CV_PASS receipt exists. */
function fxCvPassed(): AdmitFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  fx.seedReceipt('cv', {
    type: 'CV_PASS',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: { verdict: 'PASS', snapshot_digest: 's1', summary: 'seed pass' },
  });
  fx.commitAll();
  return fx;
}

/** Runtime intermediate state: slice CV_IN_PROGRESS + cv IN_PROGRESS. */
function cvInProgressState(): ReconcileStageResult {
  return {
    stage_id: STAGE_ID,
    slices: [
      {
        slice_id: SLICE_ID,
        dependencies: [],
        tasks: [],
        slice_state: SliceState.CV_IN_PROGRESS,
        cv_status: CVStatus.IN_PROGRESS,
        slice_evidence_finalized: true,
        repair_attempt: 0,
        scope_check_passed: false,
        committed: false,
        integrated: false,
        complete: false,
        latest_cv_receipt: null,
        latest_commit_receipt: null,
      },
    ],
    stage_state: StageState.EXECUTING,
    project_state: ProjectState.IN_PROGRESS,
    receipt_chain: [],
    findings: [],
    receipt_chain_valid: true,
    receipt_categories: [],
  };
}

// ============================================================
// Shared helpers
// ============================================================

function depsFor(fx: AdmitFx, extra?: Partial<AdmissionDeps>): AdmissionDeps {
  return { projectRoot: fx.root, ...extra };
}

/** Spy reducer — records the RuntimeAction call sequence (PO-S02-E-03). */
function spyReduce(): { calls: RuntimeAction[]; reduce: AdmitReduceFn } {
  const calls: RuntimeAction[] = [];
  const reduce: AdmitReduceFn = (state, action) => {
    calls.push(action);
    return reduceRuntimeAction(state, action);
  };
  return { calls, reduce };
}

/** Read a written receipt file back from its category directory. */
function readReceiptFile(dir: string, digest: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(dir, `${digest}.json`), 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function readTasksDir(fx: AdmitFx): string {
  return path.join(fx.root, '.proofloop', 'receipts', 'tasks', fx.stageId, fx.sliceId);
}

function readCvDir(fx: AdmitFx): string {
  return path.join(fx.root, '.proofloop', 'receipts', 'cv', fx.stageId, fx.sliceId);
}

// ============================================================
// admitWorkerResult (PO-S02-E-02)
// ============================================================

describe('admitWorkerResult (PO-S02-E-02)', () => {
  it('completed implement-task: TASK_COMPLETE receipt, slice stays IN_PROGRESS, chain valid, reconcile readback', () => {
    const fx = fxInProgress();
    const result = admitWorkerResult(makeWorkerRequest({ mode: 'implement-task' }), depsFor(fx));

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(result.findings).toEqual([]);
    expect(result.new_state?.slices[0]?.slice_state).toBe('IN_PROGRESS');

    // Receipt payload binds the envelope facts (PO-S02-E-02 binding).
    const receipt = readReceiptFile(readTasksDir(fx), result.receipt_ref as string);
    expect(receipt.type).toBe('TASK_COMPLETE');
    expect(receipt.stage_id).toBe(STAGE_ID);
    expect(receipt.slice_id).toBe(SLICE_ID);
    expect(receipt.payload).toMatchObject({
      action_token: 'tok-1',
      mode: 'implement-task',
      evidence_ref: EVIDENCE_REF,
      changed_files: ['packages/runtime/src/admission.ts'],
      verification_runs: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
      summary: 'implemented admitWorkerResult',
    });

    // Chain verification + fresh reconcile readback (AWI-006 / PO-S02-E-01).
    const chain = verifyReceiptChain(readTasksDir(fx));
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toHaveLength(1);
    const reread = fx.reconcile();
    expect(reread.slices[0]?.slice_state).toBe('IN_PROGRESS');
    expect(reread.receipt_chain).toContain(result.receipt_ref);
  });

  it('duplicate admit of the same actionToken refused (F-3 dedup) — chain keeps a single TASK_COMPLETE receipt', () => {
    const fx = fxInProgress();
    const envelope = makeEnvelope({ mode: 'implement-task' });

    const first = admitWorkerResult({ type: 'worker_result', envelope }, depsFor(fx));
    expect(first.accepted).toBe(true);
    expect(first.receipt_ref).not.toBeNull();

    // Receipts are immutable — the same actionToken envelope must never be
    // admitted twice: the second admit is refused before any write (F-3).
    const second = admitWorkerResult({ type: 'worker_result', envelope }, depsFor(fx));
    expect(second.accepted).toBe(false);
    expect(second.receipt_ref).toBeNull();
    expect(second.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(second.findings[0].message).toContain(envelope.actionToken);

    // The tasks/<stage>/<slice>/ chain still holds exactly ONE receipt.
    const chain = verifyReceiptChain(readTasksDir(fx));
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toHaveLength(1);
  });

  it('completed recover-task: TASK_COMPLETE receipt, slice stays IN_PROGRESS', () => {
    const fx = fxInProgress();
    const result = admitWorkerResult(makeWorkerRequest({ mode: 'recover-task' }), depsFor(fx));

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    const receipt = readReceiptFile(readTasksDir(fx), result.receipt_ref as string);
    expect(receipt.payload).toMatchObject({ mode: 'recover-task' });
    expect(verifyReceiptChain(readTasksDir(fx)).valid).toBe(true);
    expect(result.new_state?.slices[0]?.slice_state).toBe('IN_PROGRESS');
  });

  it('completed finalize-slice: IN_PROGRESS + evidence finalized → READY_FOR_CV, readback READY_FOR_CV', () => {
    const fx = fxReadyForFinalize();
    const result = admitWorkerResult(
      makeWorkerRequest({ mode: 'finalize-slice' }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    // Reducer FINISH_TASKS composite advanced the slice.
    expect(result.new_state?.slices[0]?.slice_state).toBe('READY_FOR_CV');
    expect(result.new_state?.slices[0]?.cv_status).toBe('READY_FOR_CV');

    const receipt = readReceiptFile(readTasksDir(fx), result.receipt_ref as string);
    expect(receipt.payload).toMatchObject({ mode: 'finalize-slice' });
    expect(verifyReceiptChain(readTasksDir(fx)).valid).toBe(true);

    // Fresh reconcile derives READY_FOR_CV (all checked + evidence finalized
    // + mode=finalize-slice TASK_COMPLETE receipt).
    const reread = fx.reconcile();
    expect(reread.slices[0]?.slice_state).toBe('READY_FOR_CV');
    expect(reread.slices[0]?.cv_status).toBe('NOT_STARTED');
    expect(reread.receipt_chain).toContain(result.receipt_ref);
  });

  it('finalize-slice refused when evidence is not finalized — no Receipt', () => {
    const fx = fxInProgress();
    const result = admitWorkerResult(
      makeWorkerRequest({ mode: 'finalize-slice', taskId: TASKS[1] }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.new_state?.slices[0]?.slice_state).toBe('IN_PROGRESS');
    // No receipt written.
    expect(fs.existsSync(readTasksDir(fx))).toBe(false);
  });

  it('completed repair: CV-REPAIR binding → TASK_COMPLETE (mode=repair + cv_receipt_digest), cv FIX → PENDING_RECHECK, readback PENDING_RECHECK', () => {
    const { fx, cvRepairDigest } = fxCvRepair();
    const result = admitWorkerResult(
      makeWorkerRequest({ mode: 'repair', taskId: TASKS[1], summary: 'repair done' }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    // Slice stays READY_FOR_CV; cv REPAIR → FIX → PENDING_RECHECK.
    expect(result.new_state?.slices[0]?.slice_state).toBe('READY_FOR_CV');
    expect(result.new_state?.slices[0]?.cv_status).toBe('PENDING_RECHECK');

    const receipt = readReceiptFile(readTasksDir(fx), result.receipt_ref as string);
    expect(receipt.payload).toMatchObject({
      mode: 'repair',
      cv_receipt_digest: cvRepairDigest,
    });

    expect(verifyReceiptChain(readTasksDir(fx)).valid).toBe(true);

    // Fresh reconcile derives PENDING_RECHECK (repair TASK_COMPLETE after CV_REPAIR).
    const reread = fx.reconcile();
    expect(reread.slices[0]?.slice_state).toBe('READY_FOR_CV');
    expect(reread.slices[0]?.cv_status).toBe('PENDING_RECHECK');
  });

  it('completed diagnose: CV-REPAIR binding → TASK_COMPLETE (mode=diagnose + cv_receipt_digest), cv FIX → PENDING_RECHECK', () => {
    const { fx, cvRepairDigest } = fxCvRepair();
    const result = admitWorkerResult(
      makeWorkerRequest({ mode: 'diagnose', taskId: TASKS[1], summary: 'diagnosed' }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(true);
    expect(result.new_state?.slices[0]?.cv_status).toBe('PENDING_RECHECK');
    const receipt = readReceiptFile(readTasksDir(fx), result.receipt_ref as string);
    expect(receipt.payload).toMatchObject({ mode: 'diagnose', cv_receipt_digest: cvRepairDigest });
    expect(verifyReceiptChain(readTasksDir(fx)).valid).toBe(true);
    expect(fx.reconcile().slices[0]?.cv_status).toBe('PENDING_RECHECK');
  });

  it('repair refused without a CV_REPAIR receipt binding (READY_FOR_CV, no cv receipt) — no Receipt', () => {
    const fx = fxReadyForCvInitial();
    const result = admitWorkerResult(
      makeWorkerRequest({ mode: 'repair', taskId: TASKS[1] }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0].message).toContain('CV_REPAIR');
    // No new receipt in the tasks dir (the finalize-slice seed is untouched).
    expect(verifyReceiptChain(readTasksDir(fx)).valid).toBe(true);
  });

  it('repair refused when the slice is not READY_FOR_CV — no Receipt', () => {
    const fx = fxInProgress();
    const result = admitWorkerResult(
      makeWorkerRequest({ mode: 'repair', taskId: TASKS[1] }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
  });

  it('outcome failed refused — no success Receipt (AWI-006 forbidden shortcut)', () => {
    const fx = fxInProgress();
    const result = admitWorkerResult(
      makeWorkerRequest({ outcome: 'failed', summary: 'worker crashed' }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0].message).toContain('failed');
    expect(fs.existsSync(readTasksDir(fx))).toBe(false);
  });

  it('outcome blocked refused — no Receipt', () => {
    const fx = fxInProgress();
    const result = admitWorkerResult(
      makeWorkerRequest({ outcome: 'blocked', summary: 'cannot proceed' }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(fs.existsSync(readTasksDir(fx))).toBe(false);
  });

  it('outcome needs-decision refused — no Receipt', () => {
    const fx = fxInProgress();
    const result = admitWorkerResult(
      makeWorkerRequest({ outcome: 'needs-decision', summary: 'ask the user' }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(fs.existsSync(readTasksDir(fx))).toBe(false);
  });

  it('implement refused when the slice is not IN_PROGRESS (READY_FOR_CV) — no Receipt', () => {
    const fx = fxReadyForCvInitial();
    const result = admitWorkerResult(makeWorkerRequest({ mode: 'implement-task' }), depsFor(fx));

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
  });

  it('schema-invalid envelope refused fail-closed (RUNTIME.SCHEMA_MISMATCH) — no write', () => {
    const fx = fxInProgress();
    const result = admitWorkerResult(
      makeWorkerRequest({ outcome: 'bogus' as WorkerResultEnvelope['outcome'] }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.new_state).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(fs.existsSync(readTasksDir(fx))).toBe(false);
  });
});

// ============================================================
// admitCVResult (PO-S02-E-03)
// ============================================================

describe('admitCVResult (PO-S02-E-03)', () => {
  it('PASS from READY_FOR_CV: reducer sequence RUN_CV → PASS_CV, CV_PASS receipt, readback CV_PASSED/PASS', () => {
    const fx = fxReadyForCvInitial();
    const { calls, reduce } = spyReduce();
    const result = admitCVResult(makeCvRequest({ verdict: 'PASS' }), depsFor(fx, { reduce }));

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(result.findings).toEqual([]);
    // cv_dispatched composite + verdict application (PO-S02-E-03 sequence).
    expect(calls).toEqual([
      { entity: 'slice', event: 'RUN_CV' },
      { entity: 'slice', event: 'PASS_CV' },
    ]);
    expect(result.new_state?.slices[0]?.slice_state).toBe('CV_PASSED');
    expect(result.new_state?.slices[0]?.cv_status).toBe('PASS');

    const receipt = readReceiptFile(readCvDir(fx), result.receipt_ref as string);
    expect(receipt.type).toBe('CV_PASS');
    expect(receipt.stage_id).toBe(STAGE_ID);
    expect(receipt.slice_id).toBe(SLICE_ID);
    expect(receipt.payload).toMatchObject({
      verdict: 'PASS',
      snapshot_digest: COMMIT_SHA,
      summary: 'cv pass',
    });

    expect(verifyReceiptChain(readCvDir(fx)).valid).toBe(true);

    // Fresh reconcile derives CV_PASSED / PASS from the CV_PASS receipt.
    const reread = fx.reconcile();
    expect(reread.slices[0]?.slice_state).toBe('CV_PASSED');
    expect(reread.slices[0]?.cv_status).toBe('PASS');
    expect(reread.receipt_chain).toContain(result.receipt_ref);
  });

  it('REPAIR from READY_FOR_CV: reducer sequence RUN_CV → REVISE, CV_REPAIR receipt, readback READY_FOR_CV/REPAIR', () => {
    const fx = fxReadyForCvInitial();
    const { calls, reduce } = spyReduce();
    const result = admitCVResult(makeCvRequest({ verdict: 'REPAIR', summary: 'needs fixes' }), depsFor(fx, { reduce }));

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(calls).toEqual([
      { entity: 'slice', event: 'RUN_CV' },
      { entity: 'slice', event: 'REVISE' },
    ]);
    expect(result.new_state?.slices[0]?.slice_state).toBe('READY_FOR_CV');
    expect(result.new_state?.slices[0]?.cv_status).toBe('REPAIR');

    const receipt = readReceiptFile(readCvDir(fx), result.receipt_ref as string);
    expect(receipt.type).toBe('CV_REPAIR');
    expect(receipt.payload).toMatchObject({
      verdict: 'REPAIR',
      snapshot_digest: COMMIT_SHA,
    });

    expect(verifyReceiptChain(readCvDir(fx)).valid).toBe(true);

    const reread = fx.reconcile();
    expect(reread.slices[0]?.slice_state).toBe('READY_FOR_CV');
    expect(reread.slices[0]?.cv_status).toBe('REPAIR');
  });

  it('PASS from CV_IN_PROGRESS (runtime intermediate): dispatched step skipped — only PASS_CV', () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.commitAll();
    const { calls, reduce } = spyReduce();
    const result = admitCVResult(
      makeCvRequest({ verdict: 'PASS' }),
      depsFor(fx, { reconcile: () => cvInProgressState(), reduce }),
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(calls).toEqual([{ entity: 'slice', event: 'PASS_CV' }]);
    expect(result.new_state?.slices[0]?.slice_state).toBe('CV_PASSED');
    expect(result.new_state?.slices[0]?.cv_status).toBe('PASS');
    expect(verifyReceiptChain(readCvDir(fx)).valid).toBe(true);
  });

  it('REPAIR from CV_IN_PROGRESS (runtime intermediate): only REVISE, CV_REPAIR receipt', () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.commitAll();
    const { calls, reduce } = spyReduce();
    const result = admitCVResult(
      makeCvRequest({ verdict: 'REPAIR' }),
      depsFor(fx, { reconcile: () => cvInProgressState(), reduce }),
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(calls).toEqual([{ entity: 'slice', event: 'REVISE' }]);
    expect(result.new_state?.slices[0]?.slice_state).toBe('READY_FOR_CV');
    expect(result.new_state?.slices[0]?.cv_status).toBe('REPAIR');
    const receipt = readReceiptFile(readCvDir(fx), result.receipt_ref as string);
    expect(receipt.type).toBe('CV_REPAIR');
    expect(verifyReceiptChain(readCvDir(fx)).valid).toBe(true);
  });

  it('recheck flow: READY_FOR_CV + PENDING_RECHECK → RECHECK then PASS_CV; CV_PASS chained to CV_REPAIR', () => {
    const { fx, cvRepairDigest } = fxPendingRecheck();
    const { calls, reduce } = spyReduce();
    const result = admitCVResult(
      makeCvRequest({ verdict: 'PASS', summary: 'recheck pass' }),
      depsFor(fx, { reduce }),
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    // cv_dispatched via RECHECK (recheck branch), then verdict application.
    expect(calls).toEqual([
      { entity: 'slice', event: 'RUN_CV' },
      { entity: 'slice', event: 'PASS_CV' },
    ]);
    expect(result.new_state?.slices[0]?.slice_state).toBe('CV_PASSED');
    expect(result.new_state?.slices[0]?.cv_status).toBe('PASS');

    // The new CV_PASS receipt links to the CV_REPAIR genesis (previous_digest).
    const receipt = readReceiptFile(readCvDir(fx), result.receipt_ref as string);
    expect(receipt.previous_digest).toBe(cvRepairDigest);
    const chain = verifyReceiptChain(readCvDir(fx));
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toHaveLength(2);

    const reread = fx.reconcile();
    expect(reread.slices[0]?.slice_state).toBe('CV_PASSED');
    expect(reread.slices[0]?.cv_status).toBe('PASS');
  });

  it('wrong precondition (IN_PROGRESS) refused — no Receipt', () => {
    const fx = fxInProgress();
    const result = admitCVResult(makeCvRequest({ verdict: 'PASS' }), depsFor(fx));

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(fs.existsSync(readCvDir(fx))).toBe(false);
  });

  it('wrong precondition (CV_PASSED) refused — no Receipt', () => {
    const fx = fxCvPassed();
    const result = admitCVResult(makeCvRequest({ verdict: 'PASS' }), depsFor(fx));

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(verifyReceiptChain(readCvDir(fx)).valid).toBe(true);
    expect(verifyReceiptChain(readCvDir(fx)).receipts).toHaveLength(1);
  });

  it('READY_FOR_CV + cv REPAIR (no repair TASK_COMPLETE) refused — cv_dispatched composite illegal, no Receipt', () => {
    const { fx } = fxCvRepair();
    const result = admitCVResult(makeCvRequest({ verdict: 'PASS' }), depsFor(fx));

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    // Only the seed CV_REPAIR exists — no CV_PASS was written.
    const chain = verifyReceiptChain(readCvDir(fx));
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toHaveLength(1);
  });

  it('invalid verdict refused at the schema layer — no Receipt', () => {
    const fx = fxReadyForCvInitial();
    const result = admitCVResult(
      makeCvRequest({ verdict: 'CONFIRMED' as CVResultAdmissionRequest['verdict'] }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.new_state).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(fs.existsSync(readCvDir(fx))).toBe(false);
  });

  it('missing snapshot binding refused at the schema layer — no Receipt', () => {
    const fx = fxReadyForCvInitial();
    const result = admitCVResult(
      { type: 'cv_result', stageId: STAGE_ID, sliceId: SLICE_ID, verdict: 'PASS', summary: 's' } as unknown as CVResultAdmissionRequest,
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.new_state).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(fs.existsSync(readCvDir(fx))).toBe(false);
  });

  it('unknown slice refused (DOMAIN.STAGE_NOT_FOUND) — no Receipt', () => {
    const fx = fxReadyForCvInitial();
    const result = admitCVResult(
      makeCvRequest({ sliceId: 'S02-XX' }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.STAGE_NOT_FOUND');
    expect(fs.existsSync(readCvDir(fx))).toBe(false);
  });
});
