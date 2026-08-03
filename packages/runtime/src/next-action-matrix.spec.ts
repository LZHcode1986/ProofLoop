/**
 * @proofloop/runtime — S02-D-T03 fixture derivation matrix
 * (PO-S02-D-01 / PO-S02-D-02 / PO-S02-D-03 / PO-S02-D-05)
 *
 * Real-fixture independent proofs of the S02-D priority table over the full
 * NextActionService pipeline (reconcile → validate chain → deterministic
 * persisted extras → pure derive → proofloop_next wrap). Every fixture is a
 * REAL temp project: real git repo + canonical `.proofloop` layout + kernel
 * ReceiptWriter-produced receipts. No mocks, no cached state files (HP-003).
 *
 * This file fills the real-fixture matrix gaps of S02-D-T01 (pure-function
 * synthetic-state rows) and S02-D-T02 (pipeline: rows 0/3/4/10a/10c/12 +
 * determinism + structure) with a real-fixture assertion for EVERY priority
 * row 0–13, including the mandated counterexample states:
 *
 *   Row 0  — error-level inconsistency → VALIDATE (GATE_FAIL variant here;
 *            unknown-slice / tampered-chain in next-action-service.spec.ts;
 *            kitchen-sink reusing the S02-C inconsistency constructions)
 *   Row 1  — stage UNINITIALIZED (no STAGE_PLAN) → VALIDATE fallback
 *   Row 2  — stage PLANNING → ADMIT_SPV_RESULT (beats slice dispatch)
 *   Row 3a — COMPLETED + manifest repartition_requested=true → REPARTITION
 *   Row 3b — COMPLETED without repartition request → COMPILE_ACCEPTANCE
 *   Row 4  — pending worker result envelope → ADMIT_WORKER_RESULT
 *            (counterexample: beats implementing the next unchecked task)
 *   Row 5  — pending CV result envelope → ADMIT_CV_RESULT
 *            (counterexample: never RUN_CV; S02 never guesses the S03 CV
 *            envelope schema — pipeline fail-closed pinned too)
 *   Row 6  — CV_REPAIR branch: 6c repair / 6d diagnose / 6b recheck / 6e
 *            UNRESOLVED_CV_FAILURE fallback (all four real fixtures)
 *   Row 7  — READY_FOR_CV without CV receipt → RUN_CV (initial)
 *   Row 8  — slice CV_PASSED without SLICE_COMMIT → ADMIT_SLICE_COMMIT
 *   Row 9  — slice committed without INTEGRATION_PASS → ADMIT_INTEGRATION
 *   Row 10 — per-slice execution: 10a INITIALIZE_EVIDENCE / 10b recover-task
 *            (with warn finding) / 10c implement-task / 10d finalize-slice;
 *            dependency-blocked slice skipped, first runnable slice wins
 *   Row 11 — all slices integrated without GATE_PASS → RUN_GATE
 *   Row 12 — UNDER_REVIEW + GATE_PASS without STAGE_REVIEW_PASS →
 *            FINALIZE_STAGE_REVIEW (counterexample: no RUN_GATE /
 *            PREPARE_STAGE_REVIEW loop)
 *   Row 13 — all rows missed (mutually dependency-blocked) → VALIDATE with
 *            the blocking DOMAIN.INVALID_TRANSITION finding
 *
 * PO-S02-D-03: restart determinism on additional fixtures (fresh service
 * instances deep-equal).
 * PO-S02-D-05: every fixture output is checked against the proofloop_next
 * structure contract (action ∈ 15-value closed set, non-empty action_detail,
 * responsible_role ∈ 10-value RoleType closed set, boolean
 * receipt_chain_valid, findings ≤ 20, exactly the 5 contract keys).
 *
 * Matrix coverage completeness: rows 0–13 each have at least one real
 * fixture assertion in this file; the rows additionally proven in
 * next-action-service.spec.ts (0/3/4/10a/10c/12) are re-proven here with
 * distinct fixtures/assertions so the matrix stands alone.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeReceipt } from '@proofloop/kernel';
import type { Manifest, ManifestSlice, NextAction, RoleType } from '@proofloop/kernel';
import {
  NextActionService,
  reconcileStage,
  deriveNextAction,
  receiptCategoryDir,
  type DerivedNextAction,
  type NextActionOutput,
  type ReceiptContentCategory,
} from '@proofloop/runtime';

// ============================================================
// Closed value sets (kernel §5 — independent literals)
// ============================================================

const NEXT_ACTION_CLOSED_SET: readonly NextAction[] = [
  'DISPATCH_WORKER',
  'RUN_CV',
  'RUN_GATE',
  'ADMIT_WORKER_RESULT',
  'ADMIT_CV_RESULT',
  'ADMIT_SLICE_COMMIT',
  'ADMIT_INTEGRATION',
  'PREPARE_STAGE_REVIEW',
  'FINALIZE_STAGE_REVIEW',
  'COMPILE_ACCEPTANCE',
  'RUN_E2E',
  'INITIALIZE_EVIDENCE',
  'VALIDATE',
  'ADMIT_SPV_RESULT',
  'REPARTITION',
];

const ROLE_CLOSED_SET: readonly RoleType[] = [
  'brain',
  'planner',
  'executor',
  'worker',
  'code-verifier',
  'stage-reviewer',
  'researcher',
  'prototype',
  'committer',
  'general',
];

/** Executing-action prefix — VALIDATE outputs must never match it. */
const EXECUTION_PREFIX = /DISPATCH|RUN_|ADMIT_|COMPILE|INITIALIZE/;

// ============================================================
// Fixture helpers (real temp dir + real git repo + real files)
// ============================================================

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    fn?.();
  }
});

const TASKS_A = ['S02-A-T01', 'S02-A-T02', 'S02-A-T03'];
const TASKS_B = ['S02-B-T01', 'S02-B-T02', 'S02-B-T03'];

interface Fx {
  readonly root: string;
  readonly stageId: string;
  write(rel: string, content: string): void;
  writeManifest(slices: ManifestSlice[], overrides?: Partial<Manifest>): void;
  writeTasksMd(content: string): void;
  writeEvidence(sliceId: string, content: string): void;
  writeReceipt(
    category: ReceiptContentCategory,
    sliceId: string | undefined,
    overrides: Record<string, unknown>,
  ): { path: string; digest: string };
  commitAll(message?: string): string;
  head(): string;
  cleanup(): void;
}

function makeFx(stageId = 'S02'): Fx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-nextaction-matrix-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'matrix@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Matrix Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  const fx: Fx = {
    root,
    stageId,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    writeManifest: (slices, overrides = {}) => {
      const manifest: Manifest = {
        stage_id: stageId,
        source_path: `delivery/stages/${stageId}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'Runtime core application services',
        outcomes: ['deterministic next action', 'finding not guessing'],
        slices,
        dependencies: [],
        risk_facts: [],
        ...overrides,
      };
      fx.write(`.proofloop/manifests/${stageId}.json`, JSON.stringify(manifest, null, 2));
    },
    writeTasksMd: (content) => fx.write(`delivery/stages/${stageId}/tasks.md`, content),
    writeEvidence: (sliceId, content) =>
      fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, content),
    writeReceipt: (category, sliceId, overrides) => {
      const dir =
        sliceId !== undefined
          ? receiptCategoryDir(root, category, stageId, sliceId)
          : receiptCategoryDir(root, category, stageId);
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
      return fx.head();
    },
    head: () =>
      execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
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

/** Schema-valid manifest slice (known-good literals, independent of impl). */
function sliceDef(
  sliceId: string,
  taskIds: readonly string[],
  dependencies: readonly string[] = [],
): ManifestSlice {
  return {
    slice_id: sliceId,
    goal: 'next action matrix',
    observable_outcome: 'unique canonical next action from real project state',
    public_seam: '@proofloop/runtime NextActionService',
    dependencies: [...dependencies],
    proof_obligations: [
      {
        po_id: 'PO-S02-D-01',
        behavior: 'priority table rows map to the unique canonical action',
        public_seam: 'NextActionService + deriveNextAction',
        oracle_source: 'real fixture project',
        success_criteria: 'one canonical action per fixture',
        required_observation: 'fixture oracle',
        applicable_risk_facts: ['core_state_machine'],
      },
    ],
    tasks: [...taskIds],
    risk_facts: ['core_state_machine'],
    evidence_path: `delivery/stages/${sliceId.slice(0, 3)}/evidence/${sliceId}.md`,
    cv_minimum_level: 'enhanced',
  };
}

interface TaskEntry {
  id: string;
  checked: boolean;
}

/** Canonical tasks.md with per-slice region markers and checkboxes. */
function makeTasksMd(
  stageId: string,
  slices: ReadonlyArray<{ sliceId: string; entries: readonly TaskEntry[] }>,
): string {
  const out: string[] = [`# Stage ${stageId} — Runtime Core`];
  for (const s of slices) {
    out.push(`<!-- SLICE:${s.sliceId}:BEGIN -->`, `## Slice ${s.sliceId} — NextAction`);
    for (const t of s.entries) {
      out.push(`- [${t.checked ? 'x' : ' '}] ${t.id}: task`);
    }
    out.push(`<!-- SLICE:${s.sliceId}:END -->`, ``);
  }
  return out.join('\n');
}

/** Canonical evidence file: per-task sections + PO matrix (finalized option). */
function makeEvidence(
  sliceId: string,
  writtenTasks: readonly string[],
  finalized = false,
): string {
  const out: string[] = [`# Slice ${sliceId} Evidence`, ``, `## Task Evidence`, ``];
  for (const t of writtenTasks) {
    out.push(`### ${t}`, ``, `- Task Goal: next action`, `- Status: COMPLETE`, ``);
  }
  out.push(
    `## Current Slice Evidence`,
    ``,
    `### Proof Obligation Coverage`,
    ``,
    `| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |`,
    `|---|---|---|---|---|`,
  );
  if (finalized) {
    out.push(`| PO-S02-D-01 | integration | r1 | g1 | PASS |`);
  } else {
    out.push(`| *None* | | | | |`);
  }
  out.push(``, `## Current CV Status`, ``, `- Status: NOT_RUN`, ``);
  return out.join('\n');
}

const allChecked: TaskEntry[] = TASKS_A.map((id) => ({ id, checked: true }));
const allUnchecked: TaskEntry[] = TASKS_A.map((id) => ({ id, checked: false }));
const firstUnchecked: TaskEntry[] = TASKS_A.map((id, i) => ({ id, checked: i > 0 }));

/** Write the standard single-slice (S02-A) manifest + all-checked tasks.md + finalized evidence. */
function writeBaseProject(fx: Fx, stageId: string): void {
  fx.writeManifest([sliceDef('S02-A', TASKS_A)]);
  fx.writeTasksMd(makeTasksMd(stageId, [{ sliceId: 'S02-A', entries: allChecked }]));
  fx.writeEvidence('S02-A', makeEvidence('S02-A', TASKS_A, true));
}

/** Row 1 fixture: valid project, NO receipts at all → stage UNINITIALIZED. */
function baseFx(stageId = 'S02'): { fx: Fx; head: string } {
  const fx = makeFx(stageId);
  writeBaseProject(fx, stageId);
  const head = fx.commitAll();
  return { fx, head };
}

/** Stage-boundary receipts: STAGE_PLAN + SPV_PASS → stage EXECUTING. */
function writePlanReceipts(fx: Fx, stageId: string): void {
  fx.writeReceipt('plan', undefined, {
    type: 'STAGE_PLAN',
    stage_id: stageId,
    timestamp: '2025-01-01T00:00:00.000Z',
  });
  fx.writeReceipt('plan', undefined, {
    type: 'SPV_PASS',
    stage_id: stageId,
    timestamp: '2025-01-02T00:00:00.000Z',
  });
}

/** Base + EXECUTING stage (STAGE_PLAN + SPV_PASS). */
function planFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = baseFx(stageId);
  writePlanReceipts(fx, stageId);
  return { fx, head };
}

/** Row 2 fixture: STAGE_PLAN only, NO SPV_PASS → stage PLANNING. */
function planOnlyFx(stageId = 'S02'): { fx: Fx; head: string } {
  const fx = makeFx(stageId);
  writeBaseProject(fx, stageId);
  const head = fx.commitAll();
  fx.writeReceipt('plan', undefined, {
    type: 'STAGE_PLAN',
    stage_id: stageId,
    timestamp: '2025-01-01T00:00:00.000Z',
  });
  return { fx, head };
}

/** Rows 7/8/9/11/12/3 fixture chain base: EXECUTING + all checked + finalized + finalize-slice receipt. */
function readyForCvFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = planFx(stageId);
  fx.writeReceipt('tasks', 'S02-A', {
    type: 'TASK_COMPLETE',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-03T00:00:00.000Z',
    payload: { mode: 'finalize-slice' },
  });
  return { fx, head };
}

/** Row 8 fixture: + CV_PASS → slice CV_PASSED, not committed. */
function cvPassedFx(stageId = 'S02'): { fx: Fx; head: string; cvDigest: string } {
  const { fx, head } = readyForCvFx(stageId);
  const cv = fx.writeReceipt('cv', 'S02-A', {
    type: 'CV_PASS',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-04T00:00:00.000Z',
  });
  return { fx, head, cvDigest: cv.digest };
}

/** Row 9 fixture: + bound SLICE_COMMIT → slice INTEGRATING, not integrated. */
function committedFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head, cvDigest } = cvPassedFx(stageId);
  fx.writeReceipt('committer', 'S02-A', {
    type: 'SLICE_COMMIT',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-05T00:00:00.000Z',
    payload: { slice_commit_sha: head, status: 'committed', cv_receipt_digest: cvDigest },
  });
  return { fx, head };
}

/** Row 11 fixture: + bound INTEGRATION_PASS → slice INTEGRATED/complete, no gate. */
function integratedFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = committedFx(stageId);
  fx.writeReceipt('integration', 'S02-A', {
    type: 'INTEGRATION_PASS',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-06T00:00:00.000Z',
    payload: { status: 'integrated', slice_commit_sha: head },
  });
  return { fx, head };
}

/** Row 12 fixture: + GATE_PASS, no STAGE_REVIEW_PASS → stage UNDER_REVIEW. */
function gateFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = integratedFx(stageId);
  fx.writeReceipt('stage-gate', undefined, {
    type: 'GATE_PASS',
    stage_id: stageId,
    timestamp: '2025-01-07T00:00:00.000Z',
  });
  return { fx, head };
}

/** Row 3 fixture: + STAGE_REVIEW_PASS → stage COMPLETED. */
function fullFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = gateFx(stageId);
  fx.writeReceipt('review', undefined, {
    type: 'STAGE_REVIEW_PASS',
    stage_id: stageId,
    timestamp: '2025-01-08T00:00:00.000Z',
  });
  return { fx, head };
}

/** Row 4 fixture: partial project + a pending worker result envelope. */
function envelopeFx(stageId = 'S02'): { fx: Fx; head: string } {
  const fx = makeFx(stageId);
  fx.writeManifest([sliceDef('S02-A', TASKS_A)]);
  fx.writeTasksMd(makeTasksMd(stageId, [{ sliceId: 'S02-A', entries: firstUnchecked }]));
  fx.writeEvidence('S02-A', makeEvidence('S02-A', ['S02-A-T02', 'S02-A-T03'], false));
  const head = fx.commitAll();
  writePlanReceipts(fx, stageId);
  const dir = path.join(fx.root, '.pi', 'proofloop-runtime', 'results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tok-1.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        actionToken: 'tok-1',
        stageId,
        sliceId: 'S02-A',
        taskId: 'S02-A-T01',
        mode: 'implement-task',
        outcome: 'completed',
        evidenceRef: 'delivery/stages/S02/evidence/S02-A.md',
        changedFiles: [],
        verificationRuns: [],
        summary: 'done',
      },
      null,
      2,
    ),
    'utf-8',
  );
  return { fx, head };
}

/** Row 10c fixture: first task unchecked → implement-task. */
function partialFx(stageId = 'S02'): { fx: Fx; head: string } {
  const fx = makeFx(stageId);
  fx.writeManifest([sliceDef('S02-A', TASKS_A)]);
  fx.writeTasksMd(makeTasksMd(stageId, [{ sliceId: 'S02-A', entries: firstUnchecked }]));
  fx.writeEvidence('S02-A', makeEvidence('S02-A', ['S02-A-T02', 'S02-A-T03'], false));
  const head = fx.commitAll();
  writePlanReceipts(fx, stageId);
  return { fx, head };
}

/** Row 10a fixture: nothing started + evidence file missing. */
function initFx(stageId = 'S02'): { fx: Fx; head: string } {
  const fx = makeFx(stageId);
  fx.writeManifest([sliceDef('S02-A', TASKS_A)]);
  fx.writeTasksMd(makeTasksMd(stageId, [{ sliceId: 'S02-A', entries: allUnchecked }]));
  // NOTE: no evidence file is written.
  const head = fx.commitAll();
  writePlanReceipts(fx, stageId);
  return { fx, head };
}

/** Row 10b fixture: T01 checked but its evidence section missing. */
function recoverFx(stageId = 'S02'): { fx: Fx; head: string } {
  const fx = makeFx(stageId);
  fx.writeManifest([sliceDef('S02-A', TASKS_A)]);
  fx.writeTasksMd(
    makeTasksMd(stageId, [
      {
        sliceId: 'S02-A',
        entries: [
          { id: 'S02-A-T01', checked: true },
          { id: 'S02-A-T02', checked: false },
          { id: 'S02-A-T03', checked: false },
        ],
      },
    ]),
  );
  fx.writeEvidence('S02-A', makeEvidence('S02-A', ['S02-A-T02'], false));
  const head = fx.commitAll();
  writePlanReceipts(fx, stageId);
  return { fx, head };
}

/** Row 10d fixture: all checked + finalized evidence, NO finalize-slice receipt. */
function finalizeFx(stageId = 'S02'): { fx: Fx; head: string } {
  return planFx(stageId);
}

/** Row 6c fixture: EXECUTING + CV_REPAIR (count 1) → repair. */
function repairFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = planFx(stageId);
  fx.writeReceipt('cv', 'S02-A', {
    type: 'CV_REPAIR',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-03T00:00:00.000Z',
  });
  return { fx, head };
}

/** Row 6d fixture: EXECUTING + CV_REPAIR×2 (count 2) → diagnose. */
function diagnoseFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = planFx(stageId);
  const r1 = fx.writeReceipt('cv', 'S02-A', {
    type: 'CV_REPAIR',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-03T00:00:00.000Z',
  });
  fx.writeReceipt('cv', 'S02-A', {
    type: 'CV_REPAIR',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-04T00:00:00.000Z',
    previous_digest: r1.digest,
  });
  return { fx, head };
}

/** Row 6e fixture: EXECUTING + CV_REPAIR×3 (count ≥ 3) → VALIDATE fallback. */
function unresolvedFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = planFx(stageId);
  const r1 = fx.writeReceipt('cv', 'S02-A', {
    type: 'CV_REPAIR',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-03T00:00:00.000Z',
  });
  const r2 = fx.writeReceipt('cv', 'S02-A', {
    type: 'CV_REPAIR',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-04T00:00:00.000Z',
    previous_digest: r1.digest,
  });
  fx.writeReceipt('cv', 'S02-A', {
    type: 'CV_REPAIR',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-05T00:00:00.000Z',
    previous_digest: r2.digest,
  });
  return { fx, head };
}

/** Row 6b fixture: CV_REPAIR + repair-mode TASK_COMPLETE after it → PENDING_RECHECK. */
function recheckFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = planFx(stageId);
  fx.writeReceipt('cv', 'S02-A', {
    type: 'CV_REPAIR',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-03T00:00:00.000Z',
  });
  fx.writeReceipt('tasks', 'S02-A', {
    type: 'TASK_COMPLETE',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-04T00:00:00.000Z',
    payload: { mode: 'repair' },
  });
  return { fx, head };
}

/** Row 0 (GATE_FAIL) fixture: EXECUTING + GATE_FAIL receipt. */
function gateFailFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = planFx(stageId);
  fx.writeReceipt('stage-gate', undefined, {
    type: 'GATE_FAIL',
    stage_id: stageId,
    timestamp: '2025-01-03T00:00:00.000Z',
  });
  return { fx, head };
}

/** Row 0 (kitchen sink) fixture: reuses the S02-C inconsistency constructions. */
function kitchenSinkFx(stageId = 'S02'): { fx: Fx } {
  const fx = makeFx(stageId);
  // T01 checked without evidence (evidence file missing entirely) → warn.
  fx.writeManifest([sliceDef('S02-A', ['S02-A-T01', 'S02-A-T02'])]);
  fx.writeTasksMd(
    makeTasksMd(stageId, [
      {
        sliceId: 'S02-A',
        entries: [
          { id: 'S02-A-T01', checked: true },
          { id: 'S02-A-T02', checked: false },
        ],
      },
    ]),
  );
  // Unknown slice directory → DOMAIN.STAGE_NOT_FOUND.
  fx.writeReceipt('cv', 'S02-Z', {
    type: 'CV_PASS',
    stage_id: stageId,
    slice_id: 'S02-Z',
    timestamp: '2025-01-02T00:00:00.000Z',
  });
  // Write the valid chained receipts FIRST (the kernel writer verifies the
  // directory chain before writing — an invalid file would block the write).
  const r1 = fx.writeReceipt('cv', 'S02-A', {
    type: 'CV_PASS',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-01T00:00:00.000Z',
  });
  const r2 = fx.writeReceipt('cv', 'S02-A', {
    type: 'CV_PASS',
    stage_id: stageId,
    slice_id: 'S02-A',
    timestamp: '2025-01-02T00:00:00.000Z',
    previous_digest: r1.digest,
  });
  // THEN drop an invalid JSON file and tamper with r2's content.
  const cvDir = receiptCategoryDir(fx.root, 'cv', stageId, 'S02-A');
  fs.mkdirSync(cvDir, { recursive: true });
  fs.writeFileSync(path.join(cvDir, 'bad.json'), '{ nope', 'utf-8');
  const raw = JSON.parse(fs.readFileSync(r2.path, 'utf-8')) as {
    payload: Record<string, unknown>;
  };
  raw.payload = { tampered: true };
  fs.writeFileSync(r2.path, JSON.stringify(raw));
  // Commit everything (S02-C kitchen-sink style) so the Git source is
  // available — the checked-without-evidence warn Finding only fires when
  // the per-task git facts are actually known (never guessed).
  fx.commitAll();
  return { fx };
}

/** Row 10-dependency-jump fixture: S02-A depends on S02-B (not complete) → S02-B dispatched. */
function depJumpFx(stageId = 'S02'): { fx: Fx; head: string } {
  const fx = makeFx(stageId);
  fx.writeManifest([
    sliceDef('S02-A', TASKS_A, ['S02-B']),
    sliceDef('S02-B', TASKS_B),
  ]);
  fx.writeTasksMd(
    makeTasksMd(stageId, [
      { sliceId: 'S02-A', entries: TASKS_A.map((id) => ({ id, checked: false })) },
      { sliceId: 'S02-B', entries: TASKS_B.map((id) => ({ id, checked: false })) },
    ]),
  );
  fx.writeEvidence('S02-A', makeEvidence('S02-A', [], false));
  fx.writeEvidence('S02-B', makeEvidence('S02-B', [], false));
  const head = fx.commitAll();
  writePlanReceipts(fx, stageId);
  return { fx, head };
}

/** Row 13 fixture: mutually dependency-blocked slices → all blocked → VALIDATE. */
function allBlockedFx(stageId = 'S02'): { fx: Fx; head: string } {
  const fx = makeFx(stageId);
  fx.writeManifest([
    sliceDef('S02-A', TASKS_A, ['S02-B']),
    sliceDef('S02-B', TASKS_B, ['S02-A']),
  ]);
  fx.writeTasksMd(
    makeTasksMd(stageId, [
      { sliceId: 'S02-A', entries: TASKS_A.map((id) => ({ id, checked: false })) },
      { sliceId: 'S02-B', entries: TASKS_B.map((id) => ({ id, checked: false })) },
    ]),
  );
  fx.writeEvidence('S02-A', makeEvidence('S02-A', [], false));
  fx.writeEvidence('S02-B', makeEvidence('S02-B', [], false));
  const head = fx.commitAll();
  writePlanReceipts(fx, stageId);
  return { fx, head };
}

// ============================================================
// Contract helpers
// ============================================================

/** Contract-field view of a DerivedNextAction (drops slice/task/mode context). */
function contractOf(derived: DerivedNextAction): NextActionOutput {
  return {
    action: derived.action,
    action_detail: derived.action_detail,
    responsible_role: derived.responsible_role,
    receipt_chain_valid: derived.receipt_chain_valid,
    findings: [...derived.findings],
  };
}

/** proofloop_next structure contract (PO-S02-D-05). */
function expectContract(out: NextActionOutput): void {
  expect(NEXT_ACTION_CLOSED_SET).toContain(out.action);
  expect(typeof out.action_detail).toBe('string');
  expect(out.action_detail.length).toBeGreaterThan(0);
  expect(ROLE_CLOSED_SET).toContain(out.responsible_role);
  expect(typeof out.receipt_chain_valid).toBe('boolean');
  expect(Array.isArray(out.findings)).toBe(true);
  expect(out.findings.length).toBeLessThanOrEqual(20);
  expect(Object.keys(out).sort()).toEqual([
    'action',
    'action_detail',
    'findings',
    'receipt_chain_valid',
    'responsible_role',
  ]);
}

/** Run the full pipeline on a fixture and assert the proofloop_next contract. */
function pipeline(fx: Fx, stageId: string): NextActionOutput {
  const out = new NextActionService().nextAction({
    projectRoot: fx.root,
    stageId,
  });
  expectContract(out);
  return out;
}

// ============================================================
// Row 0 — error-level inconsistency → VALIDATE with all findings
// ============================================================

describe('row 0: error-level inconsistency → VALIDATE (real fixtures)', () => {
  it('GATE_FAIL receipt on a valid chain → VALIDATE with the GATE_FAIL blocking finding, chain stays truthful', () => {
    const { fx } = gateFailFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('VALIDATE');
    expect(out.action).not.toMatch(EXECUTION_PREFIX);
    // The gate chain itself is intact — the chain validity stays truthful.
    expect(out.receipt_chain_valid).toBe(true);
    expect(out.findings.some((f) => /GATE_FAIL/.test(f.message))).toBe(true);
    expect(
      out.findings.some((f) => f.code === 'DOMAIN.INVALID_TRANSITION' && f.severity === 'error'),
    ).toBe(true);
  });

  it('GATE_FAIL + GATE_PASS both present → NOT VALIDATE (GATE_PASS post-supplants GATE_FAIL)', () => {
    const { fx } = integratedFx();
    fx.writeReceipt('stage-gate', undefined, {
      type: 'GATE_FAIL',
      stage_id: fx.stageId,
      timestamp: '2025-01-07T00:00:00.000Z',
      payload: { verdict: 'FAIL' },
    });
    fx.writeReceipt('stage-gate', undefined, {
      type: 'GATE_PASS',
      stage_id: fx.stageId,
      timestamp: '2025-01-08T00:00:00.000Z',
    });
    const out = pipeline(fx, fx.stageId);
    // GATE_PASS post-supplants GATE_FAIL — no longer blocking.
    expect(out.action).not.toBe('VALIDATE');
    expect(out.action).toBe('FINALIZE_STAGE_REVIEW');
    expect(out.findings.some((f) => /GATE_FAIL/.test(f.message))).toBe(false);
  });

  it('kitchen-sink inconsistency (reusing S02-C constructions) → VALIDATE, all findings, no execution action', () => {
    // Reuses the S02-C inconsistency fixture kinds on the S02-A slice:
    // unknown-slice dir, invalid JSON, tampered chain, checked-without-evidence warn.
    const { fx } = kitchenSinkFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('VALIDATE');
    expect(out.action).not.toMatch(EXECUTION_PREFIX);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.receipt_chain_valid).toBe(false);
    // Every error kind surfaces as its canonical finding.
    expect(out.findings.some((f) => f.code === 'DOMAIN.STAGE_NOT_FOUND')).toBe(true);
    expect(out.findings.some((f) => f.code === 'RUNTIME.RECEIPT_CHAIN_BROKEN')).toBe(true);
    expect(
      out.findings.some(
        (f) => f.code === 'RUNTIME.SCHEMA_MISMATCH' && f.severity === 'error',
      ),
    ).toBe(true);
    // The recoverable warn finding is returned alongside the errors.
    expect(
      out.findings.some(
        (f) => f.code === 'RUNTIME.SCHEMA_MISMATCH' && f.severity === 'warn',
      ),
    ).toBe(true);
  });
});

// ============================================================
// Row 1 — stage UNINITIALIZED (no STAGE_PLAN) → VALIDATE fallback
// ============================================================

describe('row 1: stage UNINITIALIZED → VALIDATE fallback (real fixture)', () => {
  it('no STAGE_PLAN receipt → VALIDATE with the blocking stage-unplanned finding', () => {
    const { fx } = baseFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('VALIDATE');
    expect(out.action).not.toMatch(EXECUTION_PREFIX);
    expect(
      out.findings.some((f) => f.code === 'DOMAIN.INVALID_TRANSITION' && f.severity === 'error'),
    ).toBe(true);
    expect(out.action_detail).toMatch(/not planned|UNINITIALIZED/);
  });
});

// ============================================================
// Row 2 — stage PLANNING → ADMIT_SPV_RESULT (before slice dispatch)
// ============================================================

describe('row 2: stage PLANNING → ADMIT_SPV_RESULT (real fixture)', () => {
  it('STAGE_PLAN without SPV_PASS → ADMIT_SPV_RESULT, even with dispatchable slices (beats implement)', () => {
    const { fx } = planOnlyFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('ADMIT_SPV_RESULT');
    expect(out.responsible_role).toBe('planner');
    expect(out.action).not.toMatch(/DISPATCH|RUN_/);
  });
});

// ============================================================
// Row 3 — stage COMPLETED → REPARTITION (3a) / COMPILE_ACCEPTANCE (3b)
// ============================================================

describe('row 3: stage COMPLETED → REPARTITION / COMPILE_ACCEPTANCE (real fixtures)', () => {
  it('3b: STAGE_REVIEW_PASS without repartition request → COMPILE_ACCEPTANCE', () => {
    const { fx } = fullFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('COMPILE_ACCEPTANCE');
    expect(out.receipt_chain_valid).toBe(true);
    expect(out.findings).toEqual([]);
  });

  it('3a: manifest repartition_requested=true on COMPLETED → REPARTITION (counterexample)', () => {
    const { fx } = fullFx();
    // Overwrite the work-tree manifest with the canonical F-S02-08 fact.
    const manifestPath = path.join(
      fx.root,
      '.proofloop',
      'manifests',
      `${fx.stageId}.json`,
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    manifest.repartition_requested = true;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('REPARTITION');
    expect(out.responsible_role).toBe('planner');
    expect(out.action).not.toBe('COMPILE_ACCEPTANCE');
  });
});

// ============================================================
// Row 4 — pending worker result envelope → ADMIT_WORKER_RESULT
// ============================================================

describe('row 4: pending worker result envelope → ADMIT_WORKER_RESULT (real fixture)', () => {
  it('counterexample: envelope pending while the next task is unchecked → ADMIT_WORKER_RESULT, never implement', () => {
    const { fx } = envelopeFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('ADMIT_WORKER_RESULT');
    expect(out.action_detail).toContain('tok-1');
    expect(out.action).not.toMatch(/DISPATCH_WORKER/);
  });
});

// ============================================================
// Row 5 — pending CV result envelope → ADMIT_CV_RESULT (not RUN_CV)
// ============================================================

describe('row 5: pending CV result envelope → ADMIT_CV_RESULT (real fixture)', () => {
  it('counterexample: CV envelope pending for a READY_FOR_CV slice → ADMIT_CV_RESULT, never RUN_CV', () => {
    const { fx } = readyForCvFx();
    const input = { projectRoot: fx.root, stageId: fx.stageId };

    // Without the CV-envelope fact the pure derivation dispatches RUN_CV (initial).
    const reconciled = reconcileStage(input);
    expect(deriveNextAction(reconciled).action).toBe('RUN_CV');

    // With the documented persisted CV-envelope fact (existence + stage/slice
    // binding; the precise verdict-envelope schema is S03) the derivation
    // switches to ADMIT_CV_RESULT — the CV result is admitted, not re-run.
    const derived = contractOf(
      deriveNextAction({
        ...reconciled,
        pending_cv_result_envelopes: [{ stageId: fx.stageId, sliceId: 'S02-A' }],
      }),
    );
    expectContract(derived);
    expect(derived.action).toBe('ADMIT_CV_RESULT');
    expect(derived.action).not.toBe('RUN_CV');
    expect(derived.action).not.toMatch(/DISPATCH/);
  });

  it('pipeline never guesses a CV envelope (HP-003): a results-dir envelope surfaces as ADMIT_WORKER_RESULT', () => {
    const { fx } = readyForCvFx();
    // A schema-valid envelope in the contract results dir. S02 only knows the
    // WorkerResultEnvelope mechanism; the CV verdict envelope's precise schema
    // is S03 — S02 must never claim an envelope as a CV envelope (fail-closed,
    // never a guess), and must not re-run CV while an envelope is pending.
    const dir = path.join(fx.root, '.pi', 'proofloop-runtime', 'results');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cv-verdict.json'),
      JSON.stringify({
        schemaVersion: 1,
        actionToken: 'cv-tok',
        stageId: fx.stageId,
        sliceId: 'S02-A',
        mode: 'implement-task',
        outcome: 'completed',
        evidenceRef: 'delivery/stages/S02/evidence/S02-A.md',
        changedFiles: [],
        verificationRuns: [],
        summary: 'cv verdict envelope',
      }),
      'utf-8',
    );

    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('ADMIT_WORKER_RESULT');
    expect(out.action).not.toBe('RUN_CV');
    expect(out.action).not.toBe('ADMIT_CV_RESULT');
  });
});

// ============================================================
// Row 6 — READY_FOR_CV + latest CV fact CV_REPAIR (repair/diagnose/recheck)
// ============================================================

describe('row 6: CV_REPAIR branch → repair / diagnose / recheck (real fixtures)', () => {
  it('6c: CV_REPAIR count 1 → DISPATCH_WORKER mode=repair', () => {
    const { fx } = repairFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('DISPATCH_WORKER');
    expect(out.action_detail).toContain('mode=repair');
    expect(out.action_detail).toContain('S02-A');
  });

  it('6d: CV_REPAIR count 2 → DISPATCH_WORKER mode=diagnose', () => {
    const { fx } = diagnoseFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('DISPATCH_WORKER');
    expect(out.action_detail).toContain('mode=diagnose');
  });

  it('6e: CV_REPAIR count ≥ 3 → VALIDATE fallback UNRESOLVED_CV_FAILURE', () => {
    const { fx } = unresolvedFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('VALIDATE');
    expect(out.action).not.toMatch(EXECUTION_PREFIX);
    expect(out.findings.some((f) => /UNRESOLVED_CV_FAILURE/.test(f.message))).toBe(true);
    expect(out.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it('6b: repair result admitted after the last CV_REPAIR → RUN_CV recheck', () => {
    const { fx } = recheckFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('RUN_CV');
    expect(out.action_detail).toContain('recheck');
    expect(out.responsible_role).toBe('code-verifier');
    expect(out.action).not.toMatch(/DISPATCH/);
  });
});

// ============================================================
// Row 7 — READY_FOR_CV with no CV receipt → RUN_CV (initial)
// ============================================================

describe('row 7: READY_FOR_CV without CV receipt → RUN_CV initial (real fixture)', () => {
  it('finalize-slice admitted, no CV receipt → RUN_CV with action_detail=initial', () => {
    const { fx } = readyForCvFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('RUN_CV');
    expect(out.action_detail).toContain('initial');
    expect(out.responsible_role).toBe('code-verifier');
    expect(out.action).not.toMatch(/DISPATCH/);
  });
});

// ============================================================
// Row 8 — slice CV_PASSED without SLICE_COMMIT → ADMIT_SLICE_COMMIT
// ============================================================

describe('row 8: slice CV_PASSED without commit → ADMIT_SLICE_COMMIT (real fixture)', () => {
  it('CV_PASS admitted, no SLICE_COMMIT → ADMIT_SLICE_COMMIT', () => {
    const { fx } = cvPassedFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('ADMIT_SLICE_COMMIT');
    expect(out.responsible_role).toBe('committer');
    expect(out.action_detail).toContain('S02-A');
  });
});

// ============================================================
// Row 9 — slice committed without INTEGRATION_PASS → ADMIT_INTEGRATION
// ============================================================

describe('row 9: slice committed without integration → ADMIT_INTEGRATION (real fixture)', () => {
  it('bound SLICE_COMMIT, no INTEGRATION_PASS → ADMIT_INTEGRATION', () => {
    const { fx } = committedFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('ADMIT_INTEGRATION');
    expect(out.action_detail).toContain('S02-A');
    expect(out.action).not.toMatch(/DISPATCH/);
  });
});

// ============================================================
// Row 10 — per-slice execution branch (manifest order, deps satisfied)
// ============================================================

describe('row 10a: unstarted slice with missing evidence file → INITIALIZE_EVIDENCE (real fixture)', () => {
  it('PLANNED slice + evidence file missing → INITIALIZE_EVIDENCE', () => {
    const { fx } = initFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('INITIALIZE_EVIDENCE');
    expect(out.action_detail).toContain('S02-A');
  });
});

describe('row 10b: checked ≠ evidence_written → DISPATCH_WORKER mode=recover-task (real fixture)', () => {
  it('checked task with missing evidence section → recover-task + warn finding', () => {
    const { fx } = recoverFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('DISPATCH_WORKER');
    expect(out.action_detail).toContain('mode=recover-task');
    expect(out.action_detail).toContain('S02-A-T01');
    // The recoverable warn finding travels with the output.
    expect(
      out.findings.some(
        (f) => f.code === 'RUNTIME.SCHEMA_MISMATCH' && f.severity === 'warn',
      ),
    ).toBe(true);
  });
});

describe('row 10c: first unchecked task → DISPATCH_WORKER mode=implement-task (real fixture)', () => {
  it('partial project → implement-task for the first unchecked task', () => {
    const { fx } = partialFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('DISPATCH_WORKER');
    expect(out.action_detail).toContain('mode=implement-task');
    expect(out.action_detail).toContain('S02-A-T01');
  });
});

describe('row 10d: all tasks checked but slice not READY_FOR_CV → finalize-slice (real fixture)', () => {
  it('all checked + finalized evidence, no finalize-slice TASK_COMPLETE → mode=finalize-slice', () => {
    const { fx } = finalizeFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('DISPATCH_WORKER');
    expect(out.action_detail).toContain('mode=finalize-slice');
    expect(out.action_detail).toContain('S02-A');
  });
});

describe('row 10 dependency handling: skip dependency-blocked slices, jump to the first runnable one (real fixture)', () => {
  it('first slice depends on the second (not complete) → the second slice is dispatched', () => {
    const { fx } = depJumpFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('DISPATCH_WORKER');
    expect(out.action_detail).toContain('mode=implement-task');
    expect(out.action_detail).toContain('S02-B');
    expect(out.action_detail).not.toContain('S02-A-T01');
  });
});

// ============================================================
// Row 11 — all slices integrated without GATE_PASS → RUN_GATE
// ============================================================

describe('row 11: all slices integrated without GATE_PASS → RUN_GATE (real fixture)', () => {
  it('bound commit + bound integration, no gate receipt → RUN_GATE', () => {
    const { fx } = integratedFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('RUN_GATE');
    expect(out.responsible_role).toBe('executor');
    expect(out.action).not.toMatch(/DISPATCH/);
  });
});

// ============================================================
// Row 12 — UNDER_REVIEW + GATE_PASS without STAGE_REVIEW_PASS
//           → FINALIZE_STAGE_REVIEW
// ============================================================

describe('row 12: UNDER_REVIEW + GATE_PASS → FINALIZE_STAGE_REVIEW (real fixture)', () => {
  it('counterexample: gate passed but review not finalized → FINALIZE_STAGE_REVIEW, no RUN_GATE loop', () => {
    const { fx } = gateFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('FINALIZE_STAGE_REVIEW');
    expect(out.responsible_role).toBe('stage-reviewer');
    expect(out.action).not.toBe('RUN_GATE');
    expect(out.action).not.toBe('PREPARE_STAGE_REVIEW');
  });
});

// ============================================================
// GATE_INTERRUPTED — additive 11th receipt type retry semantics (PO-S05-A-06)
// ============================================================

describe('GATE_INTERRUPTED: retryable gate, never GATE_FAIL/GATE_PASS (PO-S05-A-06)', () => {
  it('all slices integrated + GATE_INTERRUPTED only → RUN_GATE (retry), no VALIDATE block', () => {
    const { fx } = integratedFx();
    fx.writeReceipt('stage-gate', undefined, {
      type: 'GATE_INTERRUPTED',
      stage_id: fx.stageId,
      timestamp: '2025-01-07T00:00:00.000Z',
      payload: { reason: 'cancelled', duration_ms: 9000 },
    });
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('RUN_GATE');
    expect(out.responsible_role).toBe('executor');
    // interruption is NOT a gate-fail blocker
    expect(out.findings.some((f) => /GATE_FAIL/.test(f.message))).toBe(false);
  });

  it('GATE_INTERRUPTED is never derived as GATE_PASS: no FINALIZE_STAGE_REVIEW', () => {
    const { fx } = integratedFx();
    fx.writeReceipt('stage-gate', undefined, {
      type: 'GATE_INTERRUPTED',
      stage_id: fx.stageId,
      timestamp: '2025-01-07T00:00:00.000Z',
      payload: { reason: 'timeout', duration_ms: 300000 },
    });
    const out = pipeline(fx, fx.stageId);
    expect(out.action).not.toBe('FINALIZE_STAGE_REVIEW');
    expect(out.action).not.toBe('VALIDATE');
    expect(out.action).toBe('RUN_GATE');
  });

  it('GATE_INTERRUPTED + GATE_FAIL → VALIDATE with the GATE_FAIL blocking finding (GATE_FAIL still wins)', () => {
    const { fx } = integratedFx();
    fx.writeReceipt('stage-gate', undefined, {
      type: 'GATE_INTERRUPTED',
      stage_id: fx.stageId,
      timestamp: '2025-01-07T00:00:00.000Z',
      payload: { reason: 'cancelled', duration_ms: 9000 },
    });
    fx.writeReceipt('stage-gate', undefined, {
      type: 'GATE_FAIL',
      stage_id: fx.stageId,
      timestamp: '2025-01-08T00:00:00.000Z',
      payload: { verdict: 'FAIL' },
    });
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('VALIDATE');
    expect(out.findings.some((f) => /GATE_FAIL/.test(f.message))).toBe(true);
  });

  it('baseline receipts keep the derivation unchanged: GATE_PASS still → FINALIZE_STAGE_REVIEW', () => {
    const { fx } = gateFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('FINALIZE_STAGE_REVIEW');
  });
});

// ============================================================
// Row 13 — all rows missed (all blocked) → VALIDATE fallback
// ============================================================

describe('row 13: all rows missed (all blocked) → VALIDATE fallback (real fixture)', () => {
  it('mutually dependency-blocked slices → VALIDATE with the blocking DOMAIN.INVALID_TRANSITION finding', () => {
    const { fx } = allBlockedFx();
    const out = pipeline(fx, fx.stageId);
    expect(out.action).toBe('VALIDATE');
    expect(out.action).not.toMatch(EXECUTION_PREFIX);
    expect(
      out.findings.some((f) => f.code === 'DOMAIN.INVALID_TRANSITION' && f.severity === 'error'),
    ).toBe(true);
    expect(out.action_detail.length).toBeGreaterThan(0);
  });
});

// ============================================================
// PO-S02-D-03 — restart determinism (fresh service instances, HP-003)
// ============================================================

describe('PO-S02-D-03: restart determinism on additional fixtures (HP-003)', () => {
  it('CV_REPAIR (repair) fixture: two fresh service instances deep-equal', () => {
    const { fx } = repairFx();
    const input = { projectRoot: fx.root, stageId: fx.stageId };
    const first = new NextActionService().nextAction(input);
    const second = new NextActionService().nextAction(input);
    expectContract(first);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.action).toBe('DISPATCH_WORKER');
    expect(first.action_detail).toContain('mode=repair');
  });

  it('all-blocked fixture: two fresh service instances deep-equal, findings included', () => {
    const { fx } = allBlockedFx();
    const input = { projectRoot: fx.root, stageId: fx.stageId };
    const first = new NextActionService().nextAction(input);
    const second = new NextActionService().nextAction(input);
    expectContract(first);
    expect(second).toEqual(first);
    expect(first.action).toBe('VALIDATE');
    expect(first.findings.length).toBeGreaterThan(0);
  });
});
