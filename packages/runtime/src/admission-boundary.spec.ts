/**
 * admission-boundary.spec.ts — S02-E-T03 (PO-S02-E-04)
 *
 * Public seam: `@proofloop/runtime` — `admitSliceCommit` and
 * `admitIntegration` (the slice-boundary committer/integration admit
 * methods wired onto the unified S02-E-T01 pipeline). Filesystem
 * integration: real temp git repos with the canonical `.proofloop` layout,
 * kernel `writeReceipt`-produced receipts, `verifyReceiptChain` per
 * category chain, and fresh `reconcileStage` readback as the oracle
 * (AWI-006 — every successful admit is chain-verified and read back as the
 * corresponding committed/integrated fact; every refusal produces NO
 * Receipt).
 *
 * Covered in this task (PO-S02-E-04):
 *  - admitSliceCommit: precondition slice derived CV_PASSED (reconcile
 *    fact) + cv receipt digest binding valid (request digest === the latest
 *    CV_PASS receipt digest) + non-empty commit SHA → SLICE_COMMIT Receipt
 *    to `committer/<stage>/<slice>/` + reducer INTEGRATE advance
 *    CV_PASSED → INTEGRATING; wrong state / invalid digest binding /
 *    unknown slice / schema-invalid request → structured rejection, no
 *    Receipt.
 *  - admitIntegration: precondition slice derived INTEGRATING (reconcile
 *    fact) + SLICE_COMMIT receipt existing and binding the SAME commit SHA
 *    → INTEGRATION_PASS Receipt to `integration/<stage>/<slice>/` +
 *    reducer FINISH_INTEGRATION advance INTEGRATING → INTEGRATED; SHA
 *    mismatch / commit binding missing / wrong state / unknown slice /
 *    schema-invalid request → structured rejection, no Receipt.
 *
 * Expected values are known-good literals from the authority excerpts
 * (kernel §6 transition table CV_PASSED → INTEGRATING → INTEGRATED,
 * AWI-006, PO-S02-E-04, and the S02-C-T04 canonical payload contract:
 * SLICE_COMMIT payload.status === 'committed' + slice_commit_sha +
 * cv_receipt_digest === latest CV_PASS digest; INTEGRATION_PASS
 * payload.status === 'integrated' + slice_commit_sha === the committed
 * SHA) — not derived from the implementation under test.
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
  admitSliceCommit,
  admitIntegration,
  reduceRuntimeAction,
  type AdmissionDeps,
  type AdmitReduceFn,
  type ReconcileStageResult,
  type RuntimeAction,
  type SliceCommitAdmissionRequest,
  type IntegrationAdmissionRequest,
  type ReceiptContentCategory,
} from '@proofloop/runtime';

// ============================================================
// Known-good literals (authority excerpts — never derived)
// ============================================================

const STAGE_ID = 'S02';
const SLICE_ID = 'S02-E';
const TASKS: readonly string[] = ['S02-E-T01', 'S02-E-T02', 'S02-E-T03'];

function makeCommitRequest(
  overrides: Partial<SliceCommitAdmissionRequest> = {},
): SliceCommitAdmissionRequest {
  return {
    type: 'slice_commit',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    commitSha: 'a'.repeat(40),
    cvReceiptDigest: 'd'.repeat(64),
    ...overrides,
  };
}

function makeIntegrationRequest(
  overrides: Partial<IntegrationAdmissionRequest> = {},
): IntegrationAdmissionRequest {
  return {
    type: 'integration',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    commitSha: 'a'.repeat(40),
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
  writeEvidence(finalized: boolean): void;
  seedReceipt(
    category: ReceiptContentCategory,
    overrides: Record<string, unknown>,
  ): { path: string; digest: string };
  commitAll(message?: string): string;
  reconcile(): ReconcileStageResult;
  cleanup(): void;
}

function makeFx(stageId = STAGE_ID, sliceId = SLICE_ID): AdmitFx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-boundary-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'boundary@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Boundary Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);

  const sliceDef = (sid: string, taskIds: readonly string[]): ManifestSlice => ({
    slice_id: sid,
    goal: 'AdmissionService slice-boundary admit 操作',
    observable_outcome: 'commit/integration admits with chain-verified receipts',
    public_seam: '@proofloop/runtime AdmissionService',
    dependencies: ['S02-A'],
    proof_obligations: [
      {
        po_id: 'PO-S02-E-04',
        behavior: 'admitSliceCommit / admitIntegration all cases',
        public_seam: 'admitSliceCommit / admitIntegration',
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
    writeEvidence: (finalized) => {
      const content =
        `# Slice ${sliceId} Evidence\n\n` +
        `## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        (finalized
          ? `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n` +
            `### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| PO-S02-E-04 | admission-boundary.spec.ts | yes | yes | pass |\n\n` +
            `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`
          : `\n## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
            `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
            `|---|---|---|---|---|\n| *None* | | | | |\n`);
      fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, content);
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

/** Manifest + all tasks checked + evidence finalized (no receipts yet). */
function fxBase(): AdmitFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  return fx;
}

/** READY_FOR_CV: all checked + finalized + mode=finalize-slice TASK_COMPLETE. */
function fxReadyForCv(): AdmitFx {
  const fx = fxBase();
  fx.seedReceipt('tasks', { payload: { mode: 'finalize-slice' } });
  fx.commitAll();
  return fx;
}

/**
 * CV_PASSED: a CV_PASS receipt exists (the commit precondition). The
 * baseline commit SHA is the real fixture HEAD — the value a real
 * committer would record as `slice_commit_sha`.
 */
function fxCvPassed(): { fx: AdmitFx; cvPassDigest: string; commitSha: string } {
  const fx = fxBase();
  const commitSha = fx.commitAll();
  const seeded = fx.seedReceipt('cv', {
    type: 'CV_PASS',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: { verdict: 'PASS', snapshot_digest: 's1', summary: 'seed pass' },
  });
  return { fx, cvPassDigest: seeded.digest, commitSha };
}

/**
 * INTEGRATING: CV_PASS + a SLICE_COMMIT receipt bound to the baseline
 * commit SHA and the latest CV_PASS digest (S02-C-T04 committed derivation).
 */
function fxIntegrating(): { fx: AdmitFx; cvPassDigest: string; commitSha: string } {
  const fx = fxBase();
  const commitSha = fx.commitAll();
  const cv = fx.seedReceipt('cv', {
    type: 'CV_PASS',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: { verdict: 'PASS', snapshot_digest: 's1', summary: 'seed pass' },
  });
  fx.seedReceipt('committer', {
    type: 'SLICE_COMMIT',
    timestamp: '2025-01-02T00:00:00.000Z',
    payload: {
      status: 'committed',
      slice_commit_sha: commitSha,
      cv_receipt_digest: cv.digest,
    },
  });
  return { fx, cvPassDigest: cv.digest, commitSha };
}

/**
 * CV_PASSED with an INVALID commit binding: a SLICE_COMMIT whose
 * cv_receipt_digest does not match the latest CV_PASS digest — the S02-C
 * committed derivation stays false (never a guess), so the slice derives
 * CV_PASSED, not INTEGRATING.
 */
function fxInvalidCommitBinding(): { fx: AdmitFx; commitSha: string } {
  const fx = fxBase();
  const commitSha = fx.commitAll();
  fx.seedReceipt('cv', {
    type: 'CV_PASS',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: { verdict: 'PASS', snapshot_digest: 's1', summary: 'seed pass' },
  });
  fx.seedReceipt('committer', {
    type: 'SLICE_COMMIT',
    timestamp: '2025-01-02T00:00:00.000Z',
    payload: {
      status: 'committed',
      slice_commit_sha: commitSha,
      cv_receipt_digest: 'f'.repeat(64),
    },
  });
  return { fx, commitSha };
}

/** Runtime intermediate: slice INTEGRATING but NO SLICE_COMMIT receipt. */
function integratingWithoutCommitState(): ReconcileStageResult {
  return {
    stage_id: STAGE_ID,
    slices: [
      {
        slice_id: SLICE_ID,
        dependencies: [],
        tasks: [],
        slice_state: SliceState.INTEGRATING,
        cv_status: CVStatus.PASS,
        slice_evidence_finalized: true,
        repair_attempt: 0,
        scope_check_passed: false,
        committed: true,
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

/** Spy reducer — records the RuntimeAction call sequence (PO-S02-E-04). */
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

function committerDir(fx: AdmitFx): string {
  return path.join(fx.root, '.proofloop', 'receipts', 'committer', fx.stageId, fx.sliceId);
}

function integrationDir(fx: AdmitFx): string {
  return path.join(fx.root, '.proofloop', 'receipts', 'integration', fx.stageId, fx.sliceId);
}

// ============================================================
// admitSliceCommit (PO-S02-E-04)
// ============================================================

describe('admitSliceCommit (PO-S02-E-04)', () => {
  it('accepted from CV_PASSED with valid cv digest + SHA: SLICE_COMMIT receipt, reducer INTEGRATE, readback INTEGRATING/committed', () => {
    const { fx, cvPassDigest, commitSha } = fxCvPassed();
    const { calls, reduce } = spyReduce();
    const result = admitSliceCommit(
      makeCommitRequest({ commitSha, cvReceiptDigest: cvPassDigest }),
      depsFor(fx, { reduce }),
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(result.findings).toEqual([]);
    // Reducer INTEGRATE advances CV_PASSED → INTEGRATING (PO-S02-E-04).
    expect(calls).toEqual([{ entity: 'slice', event: 'INTEGRATE' }]);
    expect(result.new_state?.slices[0]?.slice_state).toBe('INTEGRATING');
    expect(result.new_state?.slices[0]?.cv_status).toBe('PASS');

    // Receipt payload binds the committed SHA + cv receipt digest (S02-C-T04 contract).
    const receipt = readReceiptFile(committerDir(fx), result.receipt_ref as string);
    expect(receipt.type).toBe('SLICE_COMMIT');
    expect(receipt.stage_id).toBe(STAGE_ID);
    expect(receipt.slice_id).toBe(SLICE_ID);
    expect(receipt.payload).toMatchObject({
      status: 'committed',
      slice_commit_sha: commitSha,
      cv_receipt_digest: cvPassDigest,
    });

    // Chain verification + fresh reconcile readback (AWI-006 / PO-S02-E-01).
    const chain = verifyReceiptChain(committerDir(fx));
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toHaveLength(1);
    const reread = fx.reconcile();
    expect(reread.slices[0]?.slice_state).toBe('INTEGRATING');
    expect(reread.slices[0]?.committed).toBe(true);
    expect(reread.slices[0]?.integrated).toBe(false);
    expect(reread.receipt_chain).toContain(result.receipt_ref);
  });

  it('refused when the slice is not CV_PASSED (READY_FOR_CV) — no Receipt', () => {
    const fx = fxReadyForCv();
    const result = admitSliceCommit(makeCommitRequest(), depsFor(fx));

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0].message).toContain('CV_PASSED');
    expect(result.new_state?.slices[0]?.slice_state).toBe('READY_FOR_CV');
    expect(fs.existsSync(committerDir(fx))).toBe(false);
  });

  it('refused when the cv receipt digest binding is invalid (mismatched digest) — no Receipt', () => {
    const { fx, cvPassDigest } = fxCvPassed();
    const result = admitSliceCommit(
      makeCommitRequest({ cvReceiptDigest: 'f'.repeat(64) }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0].message).toContain('cv');
    // The valid digest still binds; the mismatch is what refused the admit.
    expect(cvPassDigest.length).toBe(64);
    expect(fs.existsSync(committerDir(fx))).toBe(false);
  });

  it('refused for an unknown slice (DOMAIN.STAGE_NOT_FOUND) — no Receipt', () => {
    const { fx } = fxCvPassed();
    const result = admitSliceCommit(
      makeCommitRequest({ sliceId: 'S02-XX' }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.STAGE_NOT_FOUND');
    expect(fs.existsSync(committerDir(fx))).toBe(false);
  });

  it('schema-invalid request (empty commit SHA) refused fail-closed — no write', () => {
    const { fx } = fxCvPassed();
    const result = admitSliceCommit(makeCommitRequest({ commitSha: '' }), depsFor(fx));

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.new_state).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(fs.existsSync(committerDir(fx))).toBe(false);
  });
});

// ============================================================
// admitIntegration (PO-S02-E-04)
// ============================================================

describe('admitIntegration (PO-S02-E-04)', () => {
  it('accepted from INTEGRATING with matching SHA: INTEGRATION_PASS receipt, reducer FINISH_INTEGRATION, readback INTEGRATED/integrated', () => {
    const { fx, commitSha } = fxIntegrating();
    const { calls, reduce } = spyReduce();
    const result = admitIntegration(
      makeIntegrationRequest({ commitSha }),
      depsFor(fx, { reduce }),
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(result.findings).toEqual([]);
    // Reducer FINISH_INTEGRATION advances INTEGRATING → INTEGRATED.
    expect(calls).toEqual([{ entity: 'slice', event: 'FINISH_INTEGRATION' }]);
    expect(result.new_state?.slices[0]?.slice_state).toBe('INTEGRATED');
    expect(result.new_state?.slices[0]?.cv_status).toBe('PASS');

    // Receipt payload binds the SAME commit SHA as the SLICE_COMMIT (S02-C-T04 contract).
    const receipt = readReceiptFile(integrationDir(fx), result.receipt_ref as string);
    expect(receipt.type).toBe('INTEGRATION_PASS');
    expect(receipt.stage_id).toBe(STAGE_ID);
    expect(receipt.slice_id).toBe(SLICE_ID);
    expect(receipt.payload).toMatchObject({
      status: 'integrated',
      slice_commit_sha: commitSha,
    });

    // Chain verification + fresh reconcile readback (AWI-006 / PO-S02-E-01).
    const chain = verifyReceiptChain(integrationDir(fx));
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toHaveLength(1);
    const reread = fx.reconcile();
    expect(reread.slices[0]?.slice_state).toBe('INTEGRATED');
    expect(reread.slices[0]?.committed).toBe(true);
    expect(reread.slices[0]?.integrated).toBe(true);
    expect(reread.receipt_chain).toContain(result.receipt_ref);
  });

  it('refused when the request SHA does not match the SLICE_COMMIT receipt — no Receipt', () => {
    const { fx } = fxIntegrating();
    const result = admitIntegration(
      makeIntegrationRequest({ commitSha: 'b'.repeat(40) }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0].message).toContain('SHA');
    expect(result.new_state?.slices[0]?.slice_state).toBe('INTEGRATING');
    expect(fs.existsSync(integrationDir(fx))).toBe(false);
  });

  it('refused when the slice is not INTEGRATING (CV_PASSED, no commit receipt) — no Receipt', () => {
    const { fx } = fxCvPassed();
    const result = admitIntegration(makeIntegrationRequest(), depsFor(fx));

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0].message).toContain('INTEGRATING');
    expect(result.new_state?.slices[0]?.slice_state).toBe('CV_PASSED');
    expect(fs.existsSync(integrationDir(fx))).toBe(false);
  });

  it('refused when the commit binding is invalid (SLICE_COMMIT cv digest mismatch → CV_PASSED) — no Receipt', () => {
    const { fx, commitSha } = fxInvalidCommitBinding();
    const result = admitIntegration(
      makeIntegrationRequest({ commitSha }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    // Even a SHA that matches the recorded SLICE_COMMIT cannot integrate an
    // uncommitted (CV_PASSED) slice.
    expect(result.new_state?.slices[0]?.slice_state).toBe('CV_PASSED');
    expect(fs.existsSync(integrationDir(fx))).toBe(false);
  });

  it('refused at the INTEGRATING runtime intermediate with no SLICE_COMMIT receipt binding — no Receipt', () => {
    const fx = fxBase();
    fx.commitAll();
    const result = admitIntegration(
      makeIntegrationRequest(),
      depsFor(fx, { reconcile: () => integratingWithoutCommitState() }),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0].message).toContain('SLICE_COMMIT');
    expect(fs.existsSync(integrationDir(fx))).toBe(false);
  });

  it('refused for an unknown slice (DOMAIN.STAGE_NOT_FOUND) — no Receipt', () => {
    const { fx } = fxIntegrating();
    const result = admitIntegration(
      makeIntegrationRequest({ sliceId: 'S02-XX' }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.STAGE_NOT_FOUND');
    expect(fs.existsSync(integrationDir(fx))).toBe(false);
  });

  it('schema-invalid request (empty commit SHA) refused fail-closed — no write', () => {
    const { fx } = fxIntegrating();
    const result = admitIntegration(makeIntegrationRequest({ commitSha: '' }), depsFor(fx));

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.new_state).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(fs.existsSync(integrationDir(fx))).toBe(false);
  });
});
