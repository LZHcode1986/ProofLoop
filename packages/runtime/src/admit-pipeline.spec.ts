/**
 * admit-pipeline.spec.ts — PO-S03-H-05 (S03-H-T03)
 *
 * Existence-gate message precision of `runAdmitPipeline` (the unified admit
 * pipeline, AWI-006). The gate refuses ANY error-level
 * `DOMAIN.STAGE_NOT_FOUND` reconcile finding (fail closed — the refusal
 * condition is unchanged), but the rejection message must now carry precise
 * attribution distinguishing two branches:
 *
 *   Branch A — "stage not declared in the manifest" (manifest missing /
 *              stage_id mismatch): message explicitly attributes the refusal
 *              to the missing manifest declaration and carries the original
 *              reconcile finding content.
 *   Branch B — other DOMAIN.STAGE_NOT_FOUND sources (unknown slice
 *              directories, receipts referencing unknown stage/slice):
 *              message explicitly attributes the refusal to the concrete
 *              source (with the original finding content) and must NOT use
 *              the branch-A "not declared in the manifest" wording.
 *
 * Both branches refuse with no Receipt (no widening of the release
 * surface). A legal declared-stage admit must be unaffected (regression).
 *
 * Public seam: `@proofloop/runtime` — `runAdmitPipeline` gate behavior via
 * the real admit methods (admitCVResult / admitWorkerResult) over real
 * fixture projects. The gate itself is never mocked.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeReceipt, verifyReceiptChain, SliceState } from '@proofloop/kernel';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import {
  reconcileStage,
  receiptCategoryDir,
  planReceiptDir,
  cvReceiptDir,
  admitCVResult,
  admitWorkerResult,
  type ReconcileStageResult,
  type ReceiptContentCategory,
} from '@proofloop/runtime';

// ============================================================
// Known-good literals
// ============================================================

const STAGE_ID = 'S02';
const SLICE_ID = 'S02-A';
const TASKS: readonly string[] = ['S02-A-T01', 'S02-A-T02'];

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

interface GateFx {
  readonly root: string;
  readonly stageId: string;
  readonly sliceId: string;
  write(rel: string, content: string): void;
  writeManifest(): void;
  writeTasksMd(checkedTasks: readonly string[]): void;
  writeEvidence(finalized: boolean): void;
  seedReceipt(
    category: ReceiptContentCategory,
    sliceId: string | undefined,
    overrides: Record<string, unknown>,
  ): { path: string; digest: string };
  commitAll(): string;
  reconcile(): ReconcileStageResult;
  cleanup(): void;
}

function makeFx(stageId = STAGE_ID, sliceId = SLICE_ID): GateFx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-gate-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'gate@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Gate Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);

  const sliceDef = (sid: string, taskIds: readonly string[]): ManifestSlice => ({
    slice_id: sid,
    goal: 'existence gate precision',
    observable_outcome: 'precise STAGE_NOT_FOUND attribution, fail-closed kept',
    public_seam: '@proofloop/runtime runAdmitPipeline gate',
    dependencies: [],
    proof_obligations: [
      {
        po_id: 'PO-S03-H-05',
        behavior: 'gate message distinguishes manifest-declaration vs other sources',
        public_seam: 'runAdmitPipeline gate',
        oracle_source: 'real fixture project',
        success_criteria: 'two-branch messages precise + regression',
        required_observation: 'fixture oracle',
        applicable_risk_facts: ['persistent_state'],
      },
    ],
    tasks: [...taskIds],
    risk_facts: ['persistent_state'],
    evidence_path: `delivery/stages/${stageId}/evidence/${sid}.md`,
    cv_minimum_level: 'enhanced',
  });

  const fx: GateFx = {
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
        stage_goal: 'existence gate precision',
        outcomes: ['precise attribution'],
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
        `# Stage ${stageId} — Runtime\n\n` +
        `## Slice ${sliceId}\n` +
        `<!-- SLICE:${sliceId}:BEGIN -->\n\n` +
        `### Tasks\n\n${lines.join('\n')}\n\n` +
        `<!-- SLICE:${sliceId}:END -->\n`;
      fx.write(`delivery/stages/${stageId}/tasks.md`, content);
    },
    writeEvidence: (finalized) => {
      const partial =
        `# Slice ${sliceId} Evidence\n\n` +
        `## Task Evidence\n\n### ${TASKS[0]}\n\n- Status: COMPLETE\n\n` +
        `## Current Slice Evidence\n\n### Proof Obligation Coverage\n\n` +
        `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
        `|---|---|---|---|---|\n| *None* | | | | |\n`;
      const finalizedContent =
        `# Slice ${sliceId} Evidence\n\n` +
        `## Task Evidence\n\n${TASKS.map((t) => `### ${t}\n\n- Status: COMPLETE\n`).join('\n')}` +
        `\n## Current Slice Evidence\n\n### Snapshot\n\n- git HEAD fixture\n\n` +
        `### Proof Obligation Coverage\n\n` +
        `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |\n` +
        `|---|---|---|---|---|\n| PO-S03-H-05 | admit-pipeline.spec.ts | yes | yes | pass |\n\n` +
        `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`;
      fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, finalized ? finalizedContent : partial);
    },
    seedReceipt: (category, sliceIdForDir, overrides) => {
      const dir =
        sliceIdForDir !== undefined
          ? receiptCategoryDir(root, category, stageId, sliceIdForDir)
          : receiptCategoryDir(root, category, stageId);
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
    commitAll: () => {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'fixture']);
      return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf-8',
      }).trim();
    },
    reconcile: () => reconcileStage({ projectRoot: root, stageId }),
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
  cleanups.push(fx.cleanup);
  return fx;
}

/** IN_PROGRESS slice (legal declared stage): manifest + tasks + evidence. */
function fxInProgress(): GateFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([TASKS[0]]);
  fx.writeEvidence(false);
  fx.commitAll();
  return fx;
}

function cvRequest(stageId: string, sliceId: string) {
  return {
    type: 'cv_result' as const,
    stageId,
    sliceId,
    verdict: 'PASS' as const,
    snapshotDigest: 'a'.repeat(40),
    summary: 'cv pass',
  };
}

// ============================================================
// Branch A — stage not declared in the manifest
// ============================================================

describe('existence gate branch A — stage not declared in the manifest (PO-S03-H-05)', () => {
  it('refuses with precise manifest-declaration attribution + original finding content', () => {
    // Plain temp dir with NO manifest for stage S99 → reconcile surfaces the
    // manifest-declaration STAGE_NOT_FOUND finding (emptyResult path).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-gate-no-manifest-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

    const result = admitCVResult(cvRequest('S99', 'S99-A'), { projectRoot: dir });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('DOMAIN.STAGE_NOT_FOUND');
    const message = result.findings[0]?.message ?? '';
    // precise attribution to the missing manifest declaration …
    expect(message).toContain('is not declared in the manifest');
    expect(message).toContain('manifest missing or stage_id mismatch');
    // … and the original reconcile finding content is carried
    expect(message).toContain('manifest source unavailable for stage "S99"');
  });

  it('stage_id mismatch against the manifest is attributed to the manifest declaration', () => {
    const fx = makeFx('S02', SLICE_ID);
    fx.writeManifest(); // manifest declares S02
    fx.writeTasksMd([]);
    fx.writeEvidence(false);
    fx.commitAll();
    // request for a stage the manifest does NOT declare → mismatch branch
    const result = admitCVResult(cvRequest('S99', SLICE_ID), { projectRoot: fx.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    const message = result.findings[0]?.message ?? '';
    expect(message).toContain('is not declared in the manifest');
    expect(message).toContain('manifest source unavailable for stage "S99"');
  });
});

// ============================================================
// Branch B — other DOMAIN.STAGE_NOT_FOUND sources
// ============================================================

describe('existence gate branch B — non-manifest STAGE_NOT_FOUND sources (PO-S03-H-05)', () => {
  it('unknown slice directory is attributed to the concrete source (not the manifest)', () => {
    const fx = fxInProgress();
    // stray receipts directory for a slice the manifest does not declare
    fx.seedReceipt('cv', 'S02-Z', {
      type: 'CV_PASS',
      timestamp: '2025-01-02T00:00:00.000Z',
      payload: { verdict: 'PASS', snapshot_digest: 'a'.repeat(40), summary: 'stray' },
    });
    fx.commitAll();
    const state = fx.reconcile();
    expect(
      state.findings.some(
        (f) => f.code === 'DOMAIN.STAGE_NOT_FOUND' && f.message.includes('unknown slice'),
      ),
    ).toBe(true);

    const result = admitCVResult(cvRequest(STAGE_ID, SLICE_ID), { projectRoot: fx.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('DOMAIN.STAGE_NOT_FOUND');
    const message = result.findings[0]?.message ?? '';
    // branch-B wording — must NOT use the manifest-declaration wording
    expect(message).not.toContain('is not declared in the manifest');
    // precise attribution to the unknown slice directory + original finding
    expect(message).toContain('receipts reference unknown slice "S02-Z"');
    expect(message).toContain('directory');
  });

  it('a receipt referencing an unknown stage is attributed to the receipt source', () => {
    const fx = fxInProgress();
    // valid receipt with a foreign stage_id inside a declared slice directory
    fx.seedReceipt('cv', SLICE_ID, {
      type: 'CV_PASS',
      stage_id: 'S99',
      timestamp: '2025-01-02T00:00:00.000Z',
      payload: { verdict: 'PASS', snapshot_digest: 'a'.repeat(40), summary: 'foreign' },
    });
    fx.commitAll();
    const state = fx.reconcile();
    expect(
      state.findings.some(
        (f) => f.code === 'DOMAIN.STAGE_NOT_FOUND' && f.message.includes('references unknown stage'),
      ),
    ).toBe(true);

    const result = admitCVResult(cvRequest(STAGE_ID, SLICE_ID), { projectRoot: fx.root });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    const message = result.findings[0]?.message ?? '';
    expect(message).not.toContain('is not declared in the manifest');
    expect(message).toContain('references unknown stage "S99"');
  });
});

// ============================================================
// Fail-closed scope + regression
// ============================================================

describe('existence gate fail-closed + regression (PO-S03-H-05)', () => {
  it('both branches refuse with no Receipt and no category directory write', () => {
    // Branch A: no manifest
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-gate-no-manifest2-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const a = admitCVResult(cvRequest('S99', 'S99-A'), { projectRoot: dir });
    expect(a.accepted).toBe(false);
    expect(a.receipt_ref).toBeNull();
    expect(fs.existsSync(planReceiptDir(dir, 'S99'))).toBe(false);

    // Branch B: unknown slice directory
    const fx = fxInProgress();
    fx.seedReceipt('cv', 'S02-Z', {
      type: 'CV_PASS',
      timestamp: '2025-01-02T00:00:00.000Z',
      payload: { verdict: 'PASS', snapshot_digest: 'a'.repeat(40), summary: 'stray' },
    });
    fx.commitAll();
    const b = admitCVResult(cvRequest(STAGE_ID, SLICE_ID), { projectRoot: fx.root });
    expect(b.accepted).toBe(false);
    expect(b.receipt_ref).toBeNull();
    // the refused admit wrote NO new receipt into the stray slice directory
    const strayDir = cvReceiptDir(fx.root, STAGE_ID, 'S02-Z');
    expect(fs.existsSync(strayDir)).toBe(true);
    const names = fs.readdirSync(strayDir).filter((f) => f.endsWith('.json'));
    expect(names).toHaveLength(1); // only the seeded stray receipt
    // and no receipt was created in the declared slice's cv directory either
    expect(fs.existsSync(cvReceiptDir(fx.root, STAGE_ID, SLICE_ID))).toBe(false);
  });

  it('the two branch messages are distinguishable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-gate-distinct-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const a = admitCVResult(cvRequest('S99', 'S99-A'), { projectRoot: dir });
    const aMsg = a.findings[0]?.message ?? '';

    const fx = fxInProgress();
    fx.seedReceipt('cv', 'S02-Z', {
      type: 'CV_PASS',
      timestamp: '2025-01-02T00:00:00.000Z',
      payload: { verdict: 'PASS', snapshot_digest: 'a'.repeat(40), summary: 'stray' },
    });
    fx.commitAll();
    const b = admitCVResult(cvRequest(STAGE_ID, SLICE_ID), { projectRoot: fx.root });
    const bMsg = b.findings[0]?.message ?? '';

    expect(aMsg).toContain('is not declared in the manifest');
    expect(bMsg).not.toContain('is not declared in the manifest');
    expect(aMsg).not.toBe(bMsg);
  });

  it('regression: a legal declared-stage admit is unaffected by the gate', () => {
    const fx = fxInProgress();
    const result = admitWorkerResult(
      {
        type: 'worker_result',
        envelope: {
          schemaVersion: 1,
          actionToken: 'tok-gate-regression',
          stageId: STAGE_ID,
          sliceId: SLICE_ID,
          taskId: TASKS[0],
          mode: 'implement-task',
          outcome: 'completed',
          evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
          changedFiles: ['packages/runtime/src/admit-pipeline.ts'],
          verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'l' }],
          summary: 'regression admit',
        },
      },
      { projectRoot: fx.root },
    );
    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toBeTruthy();
    // chain-validated + fresh reconcile readback: slice stays IN_PROGRESS
    const tasksDir = receiptCategoryDir(fx.root, 'tasks', STAGE_ID, SLICE_ID);
    expect(verifyReceiptChain(tasksDir).valid).toBe(true);
    const slice = fx.reconcile().slices.find((s) => s.slice_id === SLICE_ID);
    expect(slice?.slice_state).toBe(SliceState.IN_PROGRESS);
  });
});
