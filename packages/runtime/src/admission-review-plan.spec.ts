/**
 * admission-review-plan.spec.ts — S02-E-T04 (PO-S02-E-05 / PO-S02-E-06 /
 * PO-S02-E-07)
 *
 * Public seam: `@proofloop/runtime` — `admitStageReview`, `admitProjectReview`
 * and `admitStagePlan` (the stage-level review / project review / stage-plan
 * admit methods wired onto the unified S02-E-T01 pipeline). Filesystem
 * integration: real temp git repos with the canonical `.proofloop` layout,
 * kernel `writeReceipt`-produced receipts, `verifyReceiptChain` per category
 * chain, and fresh `reconcileStage` readback as the oracle (AWI-006 — every
 * successful admit is chain-verified and read back as the corresponding
 * fact; every refusal produces NO Receipt).
 *
 * Covered in this task (PO-S02-E-05 / PO-S02-E-06 / PO-S02-E-07):
 *  - admitStageReview: ACCEPTED (stage derived UNDER_REVIEW → STAGE_REVIEW_PASS
 *    receipt to `review/<stage>/` + reducer COMPLETE → COMPLETED, chain
 *    valid, fresh reconcile readback COMPLETED), REPAIR (legal branch — NO
 *    receipt, reducer REOPEN → EXECUTING, warn Finding, accepted result with
 *    null receipt_ref), wrong precondition (stage not UNDER_REVIEW → refused).
 *  - admitProjectReview: ACCEPTED (project derived UNDER_REVIEW by reconcile
 *    — stage COMPLETED with no PROJECT_REVIEW_PASS receipt — then reducer
 *    COMPLETE → PROJECT_REVIEW_PASS receipt to `project/`, chain valid,
 *    readback COMPLETED), REPAIR (legal branch — NO receipt, reducer REOPEN →
 *    IN_PROGRESS, warn Finding), wrong precondition (project NOT derived
 *    UNDER_REVIEW — IN_PROGRESS default or already COMPLETED — refused via
 *    the real reconcile-derived gate, no synthetic dispatch).
 *  - admitStagePlan: success (request manifest digest === canonical digest of
 *    `.proofloop/manifests/<stage>.json`, stage UNINITIALIZED →
 *    STAGE_PLAN receipt to `plan/<stage>/` + reducer PLAN → PLANNING, chain
 *    valid, readback PLANNING), digest mismatch refused, duplicate admit
 *    (STAGE_PLAN receipt already exists → stage not UNINITIALIZED) refused.
 *  - canonicalManifestDigest / manifestFileDigest helper sanity: deterministic,
 *    key-order independent (canonical JSON), content-addressed.
 *
 * Expected values are known-good literals from the authority excerpts
 * (kernel §6 Stage/Project transition tables UNDER_REVIEW → COMPLETED |
 * EXECUTING / IN_PROGRESS, UNINITIALIZED → PLANNING; AWI-006;
 * PO-S02-E-05/06/07; §4 Manifest lifecycle digest binding) — not derived
 * from the implementation under test.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeReceipt, verifyReceiptChain, StageState, ProjectState } from '@proofloop/kernel';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import {
  reconcileStage,
  receiptCategoryDir,
  admitStageReview,
  admitProjectReview,
  admitStagePlan,
  manifestFileDigest,
  canonicalManifestDigest,
  reduceRuntimeAction,
  type AdmissionDeps,
  type AdmitReduceFn,
  type ReconcileStageResult,
  type RuntimeAction,
  type StageReviewAdmissionRequest,
  type ProjectReviewAdmissionRequest,
  type StagePlanAdmissionRequest,
  type ReceiptContentCategory,
} from '@proofloop/runtime';

// ============================================================
// Known-good literals (authority excerpts — never derived)
// ============================================================

const STAGE_ID = 'S02';
const SLICE_ID = 'S02-E';
const TASKS: readonly string[] = ['S02-E-T01', 'S02-E-T02', 'S02-E-T03'];

function makeStageReviewRequest(
  overrides: Partial<StageReviewAdmissionRequest> = {},
): StageReviewAdmissionRequest {
  return {
    type: 'stage_review',
    stageId: STAGE_ID,
    verdict: 'ACCEPTED',
    summary: 'stage review verdict',
    ...overrides,
  };
}

function makeProjectReviewRequest(
  overrides: Partial<ProjectReviewAdmissionRequest> = {},
): ProjectReviewAdmissionRequest {
  return {
    type: 'project_review',
    stageId: STAGE_ID,
    verdict: 'ACCEPTED',
    summary: 'project review verdict',
    ...overrides,
  };
}

function makeStagePlanRequest(
  overrides: Partial<StagePlanAdmissionRequest> = {},
): StagePlanAdmissionRequest {
  return {
    type: 'stage_plan',
    stageId: STAGE_ID,
    manifestDigest: 'e'.repeat(64),
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-review-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'review@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Review Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);

  const sliceDef = (sid: string, taskIds: readonly string[]): ManifestSlice => ({
    slice_id: sid,
    goal: 'AdmissionService stage-level admit 操作',
    observable_outcome: 'stage review / project review / stage plan admits',
    public_seam: '@proofloop/runtime AdmissionService',
    dependencies: ['S02-A'],
    proof_obligations: [
      {
        po_id: 'PO-S02-E-05',
        behavior: 'admitStageReview all cases',
        public_seam: 'admitStageReview',
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
            `|---|---|---|---|---|\n| PO-S02-E-05 | admission-review-plan.spec.ts | yes | yes | pass |\n\n` +
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

/** Manifest + all tasks checked + evidence finalized (no commits yet). */
function fxBase(): AdmitFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  return fx;
}

/**
 * Stage UNINITIALIZED (no stage-boundary receipts) + project IN_PROGRESS:
 * the admitStagePlan success / admitProjectReview success / wrong-precondition
 * fixtures.
 */
function fxUninitialized(): AdmitFx {
  const fx = fxBase();
  fx.commitAll();
  return fx;
}

/**
 * All slices integrated with the full stage-boundary receipt precondition
 * (STAGE_PLAN + SPV_PASS in `plan/<stage>/`, SLICE_COMMIT + INTEGRATION_PASS
 * bound to a real committed baseline SHA) and no STAGE_REVIEW_PASS → the
 * stage derives UNDER_REVIEW (PO-S02-C-04 / deriveStageState R2→R3→R4).
 */
function fxUnderReview(): { fx: AdmitFx; baselineSha: string } {
  const fx = fxBase();
  const baselineSha = fx.commitAll();
  // Stage-boundary receipts: STAGE_PLAN → SPV_PASS (plan/<stage>/ chain).
  fx.seedReceipt('plan', {
    type: 'STAGE_PLAN',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: { status: 'planned' },
  });
  fx.seedReceipt('plan', {
    type: 'SPV_PASS',
    timestamp: '2025-01-01T00:00:01.000Z',
    payload: { verdict: 'PASS' },
  });
  const cv = fx.seedReceipt('cv', {
    type: 'CV_PASS',
    slice_id: SLICE_ID,
    timestamp: '2025-01-02T00:00:00.000Z',
    payload: { verdict: 'PASS', snapshot_digest: 's1', summary: 'seed pass' },
  });
  fx.seedReceipt('committer', {
    type: 'SLICE_COMMIT',
    slice_id: SLICE_ID,
    timestamp: '2025-01-02T00:00:01.000Z',
    payload: {
      status: 'committed',
      slice_commit_sha: baselineSha,
      cv_receipt_digest: cv.digest,
    },
  });
  fx.seedReceipt('integration', {
    type: 'INTEGRATION_PASS',
    slice_id: SLICE_ID,
    timestamp: '2025-01-03T00:00:00.000Z',
    payload: {
      status: 'integrated',
      slice_commit_sha: baselineSha,
    },
  });
  fx.commitAll();
  return { fx, baselineSha };
}

/**
 * Stage COMPLETED with no PROJECT_REVIEW_PASS receipt → the project derives
 * UNDER_REVIEW (F-1: the project-level review is the gate AFTER the stage
 * completed its stage review — stage COMPLETED ⇒ project UNDER_REVIEW).
 * Extends fxUnderReview (stage UNDER_REVIEW) by seeding STAGE_REVIEW_PASS
 * into `review/<stage>/`, which advances the stage to COMPLETED.
 */
function fxProjectUnderReview(): AdmitFx {
  const { fx } = fxUnderReview();
  fx.seedReceipt('review', {
    type: 'STAGE_REVIEW_PASS',
    timestamp: '2025-01-03T01:00:00.000Z',
    payload: { verdict: 'ACCEPTED', summary: 'seed stage review pass' },
  });
  fx.commitAll();
  return fx;
}

// ============================================================
// Shared helpers
// ============================================================

function depsFor(fx: AdmitFx, extra?: Partial<AdmissionDeps>): AdmissionDeps {
  return { projectRoot: fx.root, ...extra };
}

/** Spy reducer — records the RuntimeAction call sequence (PO-S02-E-05/06/07). */
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

function reviewDir(fx: AdmitFx): string {
  return path.join(fx.root, '.proofloop', 'receipts', 'review', fx.stageId);
}

function projectDir(fx: AdmitFx): string {
  return path.join(fx.root, '.proofloop', 'receipts', 'project');
}

function planDir(fx: AdmitFx): string {
  return path.join(fx.root, '.proofloop', 'receipts', 'plan', fx.stageId);
}

// ============================================================
// admitStageReview (PO-S02-E-05)
// ============================================================

describe('admitStageReview (PO-S02-E-05)', () => {
  it('ACCEPTED from UNDER_REVIEW: STAGE_REVIEW_PASS receipt to review/<stage>/, reducer COMPLETE, stage COMPLETED, chain valid, readback', () => {
    const { fx } = fxUnderReview();
    const { calls, reduce } = spyReduce();
    const result = admitStageReview(
      makeStageReviewRequest({ verdict: 'ACCEPTED', summary: 'stage accepted' }),
      depsFor(fx, { reduce }),
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(result.findings).toEqual([]);
    // Reducer COMPLETE advances UNDER_REVIEW → COMPLETED (PO-S02-E-05).
    expect(calls).toEqual([{ entity: 'stage', event: 'COMPLETE' }]);
    expect(result.new_state?.stage_state).toBe('COMPLETED');

    // Receipt payload binds the verdict + summary.
    const receipt = readReceiptFile(reviewDir(fx), result.receipt_ref as string);
    expect(receipt.type).toBe('STAGE_REVIEW_PASS');
    expect(receipt.stage_id).toBe(STAGE_ID);
    expect(receipt.slice_id).toBeUndefined();
    expect(receipt.payload).toMatchObject({
      verdict: 'ACCEPTED',
      summary: 'stage accepted',
    });

    // Chain verification + fresh reconcile readback (AWI-006 / PO-S02-E-01).
    const chain = verifyReceiptChain(reviewDir(fx));
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toHaveLength(1);
    const reread = fx.reconcile();
    expect(reread.stage_state).toBe('COMPLETED');
    expect(reread.receipt_chain).toContain(result.receipt_ref);
  });

  it('REPAIR: legal branch — NO Receipt, reducer REOPEN → EXECUTING, warn Finding, accepted result with null receipt_ref', () => {
    const { fx } = fxUnderReview();
    const { calls, reduce } = spyReduce();
    const result = admitStageReview(
      makeStageReviewRequest({ verdict: 'REPAIR', summary: 'needs fixes' }),
      depsFor(fx, { reduce }),
    );

    // REPAIR is a legal branch but NOT a success-Receipt branch (PO-S02-E-05).
    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toBeNull();
    expect(calls).toEqual([{ entity: 'stage', event: 'REOPEN' }]);
    expect(result.new_state?.stage_state).toBe('EXECUTING');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('warn');

    // No receipt was written anywhere.
    expect(fs.existsSync(reviewDir(fx))).toBe(false);

    // Persisted facts unchanged — fresh reconcile still derives UNDER_REVIEW
    // (no STAGE_REVIEW_PASS receipt; all slices still integrated).
    const reread = fx.reconcile();
    expect(reread.stage_state).toBe('UNDER_REVIEW');
  });

  it('wrong precondition (stage not UNDER_REVIEW) refused — no Receipt', () => {
    const fx = fxUninitialized();
    const result = admitStageReview(
      makeStageReviewRequest({ verdict: 'ACCEPTED' }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0].message).toContain('UNDER_REVIEW');
    expect(fs.existsSync(reviewDir(fx))).toBe(false);
  });
});

// ============================================================
// admitProjectReview (PO-S02-E-06)
// ============================================================

describe('admitProjectReview (PO-S02-E-06)', () => {
  it('ACCEPTED: stage COMPLETED → project derived UNDER_REVIEW → reducer COMPLETE; PROJECT_REVIEW_PASS receipt to project/, chain valid, readback', () => {
    const fx = fxProjectUnderReview();
    const { calls, reduce } = spyReduce();
    const result = admitProjectReview(
      makeProjectReviewRequest({ verdict: 'ACCEPTED', summary: 'project accepted' }),
      depsFor(fx, { reduce }),
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(result.findings).toEqual([]);
    // The project is derived UNDER_REVIEW by reconcile (stage COMPLETED, no
    // PROJECT_REVIEW_PASS receipt) — NO synthetic SUBMIT_FOR_REVIEW dispatch
    // runs; only the verdict advance executes (F-1 real gate).
    expect(calls).toEqual([{ entity: 'project', event: 'COMPLETE' }]);
    expect(result.new_state?.project_state).toBe('COMPLETED');

    const receipt = readReceiptFile(projectDir(fx), result.receipt_ref as string);
    expect(receipt.type).toBe('PROJECT_REVIEW_PASS');
    expect(receipt.stage_id).toBe(STAGE_ID);
    expect(receipt.slice_id).toBeUndefined();
    expect(receipt.payload).toMatchObject({
      verdict: 'ACCEPTED',
      summary: 'project accepted',
    });

    const chain = verifyReceiptChain(projectDir(fx));
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toHaveLength(1);

    // Fresh reconcile reads the receipt back via the receipt chain and
    // derives the project COMPLETED from the PROJECT_REVIEW_PASS receipt.
    const reread = fx.reconcile();
    expect(reread.project_state).toBe('COMPLETED');
    expect(reread.receipt_chain).toContain(result.receipt_ref);
  });

  it('REPAIR: legal branch — NO Receipt, reducer REOPEN → IN_PROGRESS, warn Finding, accepted result with null receipt_ref', () => {
    const fx = fxProjectUnderReview();
    const { calls, reduce } = spyReduce();
    const result = admitProjectReview(
      makeProjectReviewRequest({ verdict: 'REPAIR', summary: 'fix before accept' }),
      depsFor(fx, { reduce }),
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toBeNull();
    expect(calls).toEqual([{ entity: 'project', event: 'REOPEN' }]);
    expect(result.new_state?.project_state).toBe('IN_PROGRESS');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe('warn');

    // No receipt was written anywhere.
    expect(fs.existsSync(projectDir(fx))).toBe(false);

    // Persisted facts unchanged — fresh reconcile still derives project
    // UNDER_REVIEW (no PROJECT_REVIEW_PASS receipt; stage still COMPLETED).
    const reread = fx.reconcile();
    expect(reread.project_state).toBe('UNDER_REVIEW');
  });

  it('real-seam refusal: project IN_PROGRESS (no STAGE_REVIEW_PASS) → ACCEPTED refused — no Receipt', () => {
    const fx = fxUninitialized();
    const result = admitProjectReview(
      makeProjectReviewRequest({ verdict: 'ACCEPTED' }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0].message).toContain('UNDER_REVIEW');
    expect(fs.existsSync(projectDir(fx))).toBe(false);
  });

  it('real-seam refusal: project COMPLETED (PROJECT_REVIEW_PASS receipt exists) → ACCEPTED refused — no Receipt', () => {
    const fx = fxProjectUnderReview();
    fx.seedReceipt('project', {
      type: 'PROJECT_REVIEW_PASS',
      timestamp: '2025-01-04T00:00:00.000Z',
      payload: { verdict: 'ACCEPTED', summary: 'already accepted' },
    });
    fx.commitAll();
    const result = admitProjectReview(
      makeProjectReviewRequest({ verdict: 'ACCEPTED' }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0].message).toContain('COMPLETED');
    // Nothing new was written — the seeded receipt is the only one.
    const chain = verifyReceiptChain(projectDir(fx));
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toHaveLength(1);
  });

  it('path-traversal stageId "../../evil" refused at the schema layer (RUNTIME.SCHEMA_MISMATCH) — no receipt, no project/ file', () => {
    const fx = fxProjectUnderReview();
    const result = admitProjectReview(
      makeProjectReviewRequest({ stageId: '../../evil', verdict: 'ACCEPTED' }),
      depsFor(fx),
    );

    // The charset gate (F-2) rejects the traversal BEFORE reconcile — the
    // shared project/ chain can never be polluted by a synthetic receipt.
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.new_state).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(fs.existsSync(projectDir(fx))).toBe(false);
  });

  it('legal-charset stageId absent from the manifest (S99) refused (DOMAIN.STAGE_NOT_FOUND) — no Receipt', () => {
    const fx = fxProjectUnderReview();
    const result = admitProjectReview(
      makeProjectReviewRequest({ stageId: 'S99', verdict: 'ACCEPTED' }),
      depsFor(fx),
    );

    // Schema-valid but not declared in any manifest — the pipeline
    // existence gate refuses before any state advance or write (F-2).
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.STAGE_NOT_FOUND');
    expect(fs.existsSync(projectDir(fx))).toBe(false);
  });
});

// ============================================================
// admitStagePlan (PO-S02-E-07)
// ============================================================

describe('admitStagePlan (PO-S02-E-07)', () => {
  it('success with matching manifest digest: STAGE_PLAN receipt to plan/<stage>/, reducer PLAN, stage PLANNING, chain valid, readback', () => {
    const fx = fxUninitialized();
    const canonicalDigest = manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID });
    const { calls, reduce } = spyReduce();
    const result = admitStagePlan(
      makeStagePlanRequest({ manifestDigest: canonicalDigest }),
      depsFor(fx, { reduce }),
    );

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).not.toBeNull();
    expect(result.findings).toEqual([]);
    // Reducer PLAN advances UNINITIALIZED → PLANNING (PO-S02-E-07).
    expect(calls).toEqual([{ entity: 'stage', event: 'PLAN' }]);
    expect(result.new_state?.stage_state).toBe('PLANNING');

    // Receipt payload binds the manifest digest (Manifest lifecycle binding).
    const receipt = readReceiptFile(planDir(fx), result.receipt_ref as string);
    expect(receipt.type).toBe('STAGE_PLAN');
    expect(receipt.stage_id).toBe(STAGE_ID);
    expect(receipt.slice_id).toBeUndefined();
    expect(receipt.payload).toMatchObject({ manifest_digest: canonicalDigest });

    const chain = verifyReceiptChain(planDir(fx));
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toHaveLength(1);

    // Fresh reconcile derives PLANNING from the STAGE_PLAN receipt.
    const reread = fx.reconcile();
    expect(reread.stage_state).toBe('PLANNING');
    expect(reread.receipt_chain).toContain(result.receipt_ref);
  });

  it('digest mismatch refused (request digest ≠ canonical manifest digest) — no Receipt', () => {
    const fx = fxUninitialized();
    const result = admitStagePlan(
      makeStagePlanRequest({ manifestDigest: 'a'.repeat(64) }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0].message).toContain('manifest digest');
    expect(fs.existsSync(planDir(fx))).toBe(false);
  });

  it('duplicate admit refused (STAGE_PLAN receipt already exists → stage not UNINITIALIZED) — no Receipt', () => {
    const fx = fxBase();
    fx.seedReceipt('plan', {
      type: 'STAGE_PLAN',
      timestamp: '2025-01-01T00:00:00.000Z',
      payload: { seeded: true },
    });
    fx.commitAll();
    const canonicalDigest = manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID });

    const result = admitStagePlan(
      makeStagePlanRequest({ manifestDigest: canonicalDigest }),
      depsFor(fx),
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    // Only the seed receipt exists — nothing new was written.
    const chain = verifyReceiptChain(planDir(fx));
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toHaveLength(1);
  });
});

// ============================================================
// Canonical manifest digest helper (PO-S02-E-07 binding source)
// ============================================================

describe('canonical manifest digest (PO-S02-E-07 binding)', () => {
  it('is deterministic, key-order independent (canonical JSON) and content-addressed', () => {
    const fx = fxUninitialized();
    const manifestPath = path.join(fx.root, '.proofloop', 'manifests', `${STAGE_ID}.json`);

    const d1 = manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID });
    const d2 = manifestFileDigest({ projectRoot: fx.root, stageId: STAGE_ID });
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);

    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    // Reordering object keys must NOT change the digest (canonical JSON).
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(raw).sort().reverse()) {
      reordered[key] = raw[key];
    }
    expect(canonicalManifestDigest(reordered)).toBe(canonicalManifestDigest(raw));
    // Changing content MUST change the digest (content addressing).
    expect(canonicalManifestDigest({ ...raw, stage_goal: 'different goal' })).not.toBe(
      canonicalManifestDigest(raw),
    );
  });
});
