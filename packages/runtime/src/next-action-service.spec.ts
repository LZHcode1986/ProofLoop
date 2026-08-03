/**
 * NextActionService — proofloop_next pipeline tests (S02-D-T02)
 *
 * Real-fixture integration tests over the full pipeline
 * (reconcile → validate chain → deterministic persisted extras → pure derive
 * → proofloop_next wrap), covering the pipeline side of:
 *
 *   PO-S02-D-02 (pipeline side): any error-level inconsistency → the unique
 *     action VALIDATE with all findings returned, receipt_chain_valid
 *     truthfully reflecting the chain state — never a guessed execution
 *     action.
 *   PO-S02-D-04: the full pipeline (path → reconcile → validate → derive)
 *     output equals the pure `deriveNextAction` on the same reconcile output
 *     for fixtures whose extra facts are neutral; the extras-only behaviors
 *     (gate / repartition / evidence / envelope) are each proven by a
 *     pipeline-vs-pure divergence on the SAME fixture.
 *   PO-S02-D-05: every pipeline output satisfies the proofloop_next structure
 *     contract (action ∈ 15-value closed set, non-empty action_detail,
 *     responsible_role ∈ 10-value RoleType closed set, findings ≤ 20,
 *     receipt_chain_valid boolean, exactly the 5 contract keys).
 *   PO-S02-D-03 (pipeline side): restart determinism — two fresh service
 *     instances over the same fixture deep-equal (HP-003).
 *
 * Fixtures are REAL filesystem projects (temp dir + real git repo + canonical
 * `.proofloop` layout + kernel ReceiptWriter-produced receipts). No mocks, no
 * cached state files (HP-003).
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

const TASKS = ['S02-C-T01', 'S02-C-T02', 'S02-C-T03'];

interface Fx {
  readonly root: string;
  readonly stageId: string;
  write(rel: string, content: string): void;
  writeManifest(overrides?: Partial<Manifest>): void;
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-nextaction-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'nextaction@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'NextAction Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);
  const fx: Fx = {
    root,
    stageId,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, 'utf-8');
    },
    writeManifest: (overrides = {}) => {
      const manifest: Manifest = {
        stage_id: stageId,
        source_path: `delivery/stages/${stageId}/tasks.md`,
        source_digest: '40b9d92c4fd4891850d81583d12aabd9ab7e44c07ee66a371093ae4e8ffafdf9',
        stage_goal: 'Runtime core application services',
        outcomes: ['deterministic next action', 'finding not guessing'],
        slices: [makeSliceDef('S02-C', TASKS)],
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
function makeSliceDef(sliceId: string, taskIds: readonly string[]): ManifestSlice {
  return {
    slice_id: sliceId,
    goal: 'next action pipeline',
    observable_outcome: 'unique canonical next action from real project state',
    public_seam: '@proofloop/runtime NextActionService',
    dependencies: [],
    proof_obligations: [
      {
        po_id: 'PO-S02-D-04',
        behavior: 'pipeline output equals the pure derivation on the reconcile output',
        public_seam: 'NextActionService + deriveNextAction',
        oracle_source: 'real fixture project',
        success_criteria: 'pipeline vs pure deep-equal',
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

function makeTasksMd(stageId: string, entries: readonly TaskEntry[]): string {
  const out: string[] = [`# Stage ${stageId} — Runtime Core`];
  out.push(`<!-- SLICE:S02-C:BEGIN -->`, `## Slice S02-C`);
  for (const t of entries) {
    out.push(`- [${t.checked ? 'x' : ' '}] ${t.id}: task`);
  }
  out.push(`<!-- SLICE:S02-C:END -->`);
  return out.join('\n');
}

/** Canonical evidence file: per-task sections + PO matrix (finalized option). */
function makeEvidence(sliceId: string, writtenTasks: readonly string[], finalized = false): string {
  const out: string[] = [
    `# Slice ${sliceId} Evidence`,
    ``,
    `## Task Evidence`,
    ``,
  ];
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
    out.push(`| PO-S02-D-04 | integration | r1 | g1 | PASS |`);
  } else {
    out.push(`| *None* | | | | |`);
  }
  out.push(``, `## Current CV Status`, ``, `- Status: NOT_RUN`, ``);
  return out.join('\n');
}

const allChecked: TaskEntry[] = TASKS.map((id) => ({ id, checked: true }));
const firstUnchecked: TaskEntry[] = TASKS.map((id, i) => ({ id, checked: i > 0 }));
const allUnchecked: TaskEntry[] = TASKS.map((id) => ({ id, checked: false }));

/** Base fixture: valid manifest + tasks.md all checked + evidence finalized, no receipts. */
function baseFx(stageId = 'S02'): { fx: Fx; head: string } {
  const fx = makeFx(stageId);
  fx.writeManifest();
  fx.writeTasksMd(makeTasksMd(stageId, allChecked));
  fx.writeEvidence('S02-C', makeEvidence('S02-C', TASKS, true));
  const head = fx.commitAll();
  return { fx, head };
}

/** Stage boundary receipts: STAGE_PLAN + SPV_PASS → stage EXECUTING. */
function planFx(stageId = 'S02'): { fx: Fx; head: string } {
  const fx = makeFx(stageId);
  fx.writeManifest();
  fx.writeTasksMd(makeTasksMd(stageId, allChecked));
  fx.writeEvidence('S02-C', makeEvidence('S02-C', TASKS, true));
  const head = fx.commitAll();
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
  return { fx, head };
}

/** Fully consistent fixture: base + every category receipt aligned with git → stage COMPLETED. */
function fullFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = planFx(stageId);
  const cv = fx.writeReceipt('cv', 'S02-C', {
    type: 'CV_PASS',
    stage_id: stageId,
    slice_id: 'S02-C',
    timestamp: '2025-01-03T00:00:00.000Z',
  });
  fx.writeReceipt('committer', 'S02-C', {
    type: 'SLICE_COMMIT',
    stage_id: stageId,
    slice_id: 'S02-C',
    timestamp: '2025-01-04T00:00:00.000Z',
    payload: { slice_commit_sha: head, status: 'committed', cv_receipt_digest: cv.digest },
  });
  fx.writeReceipt('integration', 'S02-C', {
    type: 'INTEGRATION_PASS',
    stage_id: stageId,
    slice_id: 'S02-C',
    timestamp: '2025-01-05T00:00:00.000Z',
    payload: { status: 'integrated', slice_commit_sha: head },
  });
  fx.writeReceipt('review', undefined, {
    type: 'STAGE_REVIEW_PASS',
    stage_id: stageId,
    timestamp: '2025-01-06T00:00:00.000Z',
  });
  return { fx, head };
}

/** Partial fixture: T01 unchecked (no evidence section) + T02/T03 checked → implement-task row. */
function partialFx(stageId = 'S02'): { fx: Fx; head: string } {
  const fx = makeFx(stageId);
  fx.writeManifest();
  fx.writeTasksMd(makeTasksMd(stageId, firstUnchecked));
  fx.writeEvidence('S02-C', makeEvidence('S02-C', ['S02-C-T02', 'S02-C-T03'], false));
  const head = fx.commitAll();
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
  return { fx, head };
}

/** INITIALIZE_EVIDENCE fixture: nothing started + evidence file missing + stage EXECUTING. */
function initializeFx(stageId = 'S02'): { fx: Fx; head: string } {
  const fx = makeFx(stageId);
  fx.writeManifest();
  fx.writeTasksMd(makeTasksMd(stageId, allUnchecked));
  // NOTE: no evidence file is written.
  const head = fx.commitAll();
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
  return { fx, head };
}

/** Envelope fixture: partial + a pending worker result envelope in the results dir. */
function envelopeFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = partialFx(stageId);
  const dir = path.join(fx.root, '.pi', 'proofloop-runtime', 'results');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tok-1.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        actionToken: 'tok-1',
        stageId,
        sliceId: 'S02-C',
        taskId: 'S02-C-T01',
        mode: 'implement-task',
        outcome: 'completed',
        evidenceRef: 'delivery/stages/S02/evidence/S02-C.md',
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

/** Gate fixture: all slices integrated + GATE_PASS, NO STAGE_REVIEW_PASS → stage UNDER_REVIEW. */
function gateFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = planFx(stageId);
  const cv = fx.writeReceipt('cv', 'S02-C', {
    type: 'CV_PASS',
    stage_id: stageId,
    slice_id: 'S02-C',
    timestamp: '2025-01-03T00:00:00.000Z',
  });
  fx.writeReceipt('committer', 'S02-C', {
    type: 'SLICE_COMMIT',
    stage_id: stageId,
    slice_id: 'S02-C',
    timestamp: '2025-01-04T00:00:00.000Z',
    payload: { slice_commit_sha: head, status: 'committed', cv_receipt_digest: cv.digest },
  });
  fx.writeReceipt('integration', 'S02-C', {
    type: 'INTEGRATION_PASS',
    stage_id: stageId,
    slice_id: 'S02-C',
    timestamp: '2025-01-05T00:00:00.000Z',
    payload: { status: 'integrated', slice_commit_sha: head },
  });
  fx.writeReceipt('stage-gate', undefined, {
    type: 'GATE_PASS',
    stage_id: stageId,
    timestamp: '2025-01-06T00:00:00.000Z',
  });
  return { fx, head };
}

/** Gate-interrupted fixture: all slices integrated + GATE_INTERRUPTED only (S05-A-T05). */
function gateInterruptedFx(stageId = 'S02'): { fx: Fx; head: string } {
  const { fx, head } = planFx(stageId);
  const cv = fx.writeReceipt('cv', 'S02-C', {
    type: 'CV_PASS',
    stage_id: stageId,
    slice_id: 'S02-C',
    timestamp: '2025-01-03T00:00:00.000Z',
  });
  fx.writeReceipt('committer', 'S02-C', {
    type: 'SLICE_COMMIT',
    stage_id: stageId,
    slice_id: 'S02-C',
    timestamp: '2025-01-04T00:00:00.000Z',
    payload: { slice_commit_sha: head, status: 'committed', cv_receipt_digest: cv.digest },
  });
  fx.writeReceipt('integration', 'S02-C', {
    type: 'INTEGRATION_PASS',
    stage_id: stageId,
    slice_id: 'S02-C',
    timestamp: '2025-01-05T00:00:00.000Z',
    payload: { status: 'integrated', slice_commit_sha: head },
  });
  fx.writeReceipt('stage-gate', undefined, {
    type: 'GATE_INTERRUPTED',
    stage_id: stageId,
    timestamp: '2025-01-06T00:00:00.000Z',
    payload: { reason: 'timeout', duration_ms: 300000 },
  });
  return { fx, head };
}

// ============================================================
// Helpers
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

// ============================================================
// Input validation
// ============================================================

describe('NextActionService — input validation', () => {
  it('missing projectRoot → TypeError', () => {
    const service = new NextActionService();
    expect(() => service.nextAction({ projectRoot: '', stageId: 'S02' })).toThrow(TypeError);
    expect(() => service.nextAction({ projectRoot: '', stageId: 'S02' })).toThrow(
      /projectRoot is required/,
    );
  });

  it('missing stageId → TypeError', () => {
    const service = new NextActionService();
    expect(() => service.nextAction({ projectRoot: '/tmp', stageId: '' })).toThrow(TypeError);
    expect(() => service.nextAction({ projectRoot: '/tmp', stageId: '' })).toThrow(
      /stageId is required/,
    );
  });
});

// ============================================================
// PO-S02-D-02 (pipeline side) — error-level inconsistency → VALIDATE
// ============================================================

describe('NextActionService — error-level inconsistency → VALIDATE (PO-S02-D-02)', () => {
  it('unknown-slice receipt → VALIDATE with findings, receipt_chain_valid stays truthful (true)', () => {
    const { fx } = baseFx();
    // Receipts exist for a slice the manifest does not declare.
    fx.writeReceipt('cv', 'S02-Z', {
      type: 'CV_PASS',
      stage_id: fx.stageId,
      slice_id: 'S02-Z',
      timestamp: '2025-01-02T00:00:00.000Z',
    });

    const out = new NextActionService().nextAction({
      projectRoot: fx.root,
      stageId: fx.stageId,
    });
    expectContract(out);
    expect(out.action).toBe('VALIDATE');
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.findings.some((f) => f.code === 'DOMAIN.STAGE_NOT_FOUND')).toBe(true);
    // The scanned category chains are intact — chain validity truthfully stays true.
    expect(out.receipt_chain_valid).toBe(true);
    // Never a guessed execution action.
    expect(out.action).not.toMatch(/DISPATCH|RUN_|ADMIT_|COMPILE|INITIALIZE/);
  });

  it('tampered receipt chain → VALIDATE with receipt_chain_valid=false (truthful chain state)', () => {
    const { fx } = baseFx();
    const r1 = fx.writeReceipt('cv', 'S02-C', {
      type: 'CV_PASS',
      stage_id: fx.stageId,
      slice_id: 'S02-C',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    const r2 = fx.writeReceipt('cv', 'S02-C', {
      type: 'CV_PASS',
      stage_id: fx.stageId,
      slice_id: 'S02-C',
      timestamp: '2025-01-02T00:00:00.000Z',
      previous_digest: r1.digest,
    });

    // Tamper with r2's content WITHOUT recomputing its digest.
    const raw = JSON.parse(fs.readFileSync(r2.path, 'utf-8')) as {
      payload: Record<string, unknown>;
    };
    raw.payload = { tampered: true };
    fs.writeFileSync(r2.path, JSON.stringify(raw));

    const out = new NextActionService().nextAction({
      projectRoot: fx.root,
      stageId: fx.stageId,
    });
    expectContract(out);
    expect(out.action).toBe('VALIDATE');
    expect(out.receipt_chain_valid).toBe(false);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.findings.some((f) => f.code === 'RUNTIME.RECEIPT_CHAIN_BROKEN')).toBe(true);
    expect(out.findings.every((f) => f.severity === 'error')).toBe(true);
  });
});

// ============================================================
// PO-S02-D-04 — pipeline composition equals the pure derivation
// ============================================================

describe('NextActionService — pipeline vs pure function composition (PO-S02-D-04)', () => {
  it('fully consistent fixture: pipeline output === pure deriveNextAction on the same reconcile output', () => {
    const { fx } = fullFx();
    const input = { projectRoot: fx.root, stageId: fx.stageId };

    const serviceOut = new NextActionService().nextAction(input);
    const pureOut = contractOf(deriveNextAction(reconcileStage(input)));

    expectContract(serviceOut);
    expect(serviceOut).toEqual(pureOut);
    expect(serviceOut.action).toBe('COMPILE_ACCEPTANCE');
    expect(serviceOut.receipt_chain_valid).toBe(true);
    expect(serviceOut.findings).toEqual([]);
  });

  it('partial fixture: pipeline output === pure deriveNextAction; DISPATCH_WORKER implement-task', () => {
    const { fx } = partialFx();
    const input = { projectRoot: fx.root, stageId: fx.stageId };

    const serviceOut = new NextActionService().nextAction(input);
    const pureOut = contractOf(deriveNextAction(reconcileStage(input)));

    expectContract(serviceOut);
    expect(serviceOut).toEqual(pureOut);
    expect(serviceOut.action).toBe('DISPATCH_WORKER');
    expect(serviceOut.action_detail).toContain('implement-task');
    expect(serviceOut.action_detail).toContain('S02-C-T01');
  });

  it('inconsistent fixture: both pipeline and pure path yield VALIDATE (chain-invalid branch)', () => {
    const { fx } = baseFx();
    const r1 = fx.writeReceipt('cv', 'S02-C', {
      type: 'CV_PASS',
      stage_id: fx.stageId,
      slice_id: 'S02-C',
      timestamp: '2025-01-01T00:00:00.000Z',
    });
    const r2 = fx.writeReceipt('cv', 'S02-C', {
      type: 'CV_PASS',
      stage_id: fx.stageId,
      slice_id: 'S02-C',
      timestamp: '2025-01-02T00:00:00.000Z',
      previous_digest: r1.digest,
    });
    const raw = JSON.parse(fs.readFileSync(r2.path, 'utf-8')) as {
      payload: Record<string, unknown>;
    };
    raw.payload = { tampered: true };
    fs.writeFileSync(r2.path, JSON.stringify(raw));

    const input = { projectRoot: fx.root, stageId: fx.stageId };
    const serviceOut = new NextActionService().nextAction(input);
    const pureOut = contractOf(deriveNextAction(reconcileStage(input)));

    expectContract(serviceOut);
    expect(serviceOut).toEqual(pureOut);
    expect(serviceOut.action).toBe('VALIDATE');
    expect(serviceOut.receipt_chain_valid).toBe(false);
  });
});

// ============================================================
// PO-S02-D-05 — proofloop_next output structure contract
// ============================================================

describe('NextActionService — output structure contract (PO-S02-D-05)', () => {
  it('every fixture output satisfies action/action_detail/role/findings/chain domains', () => {
    const outputs: NextActionOutput[] = [
      // Consistent full-completion → COMPILE_ACCEPTANCE.
      new NextActionService().nextAction({
        projectRoot: fullFx().fx.root,
        stageId: 'S02',
      }),
      // Partial → DISPATCH_WORKER.
      new NextActionService().nextAction({
        projectRoot: partialFx().fx.root,
        stageId: 'S02',
      }),
      // Nothing started + missing evidence → INITIALIZE_EVIDENCE.
      new NextActionService().nextAction({
        projectRoot: initializeFx().fx.root,
        stageId: 'S02',
      }),
      // Pending envelope → ADMIT_WORKER_RESULT.
      new NextActionService().nextAction({
        projectRoot: envelopeFx().fx.root,
        stageId: 'S02',
      }),
      // GATE_PASS under review → FINALIZE_STAGE_REVIEW.
      new NextActionService().nextAction({
        projectRoot: gateFx().fx.root,
        stageId: 'S02',
      }),
    ];
    expect(outputs).toHaveLength(5);
    expect(new Set(outputs.map((o) => o.action)).size).toBe(outputs.length);
    for (const out of outputs) {
      expectContract(out);
    }
  });
});

// ============================================================
// PO-S02-D-03 (pipeline side) — restart determinism (HP-003)
// ============================================================

describe('NextActionService — determinism across fresh instances (HP-003)', () => {
  it('same fixture through two fresh service instances deep-equals', () => {
    const { fx } = fullFx();
    const input = { projectRoot: fx.root, stageId: fx.stageId };
    const first = new NextActionService().nextAction(input);
    const second = new NextActionService().nextAction(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.action).toBe('COMPILE_ACCEPTANCE');
  });

  it('deterministic with findings present (inconsistent fixture)', () => {
    const { fx } = baseFx();
    fx.writeReceipt('cv', 'S02-Z', {
      type: 'CV_PASS',
      stage_id: fx.stageId,
      slice_id: 'S02-Z',
      timestamp: '2025-01-02T00:00:00.000Z',
    });
    const input = { projectRoot: fx.root, stageId: fx.stageId };
    const first = new NextActionService().nextAction(input);
    const second = new NextActionService().nextAction(input);
    expect(second).toEqual(first);
    expect(first.findings.length).toBeGreaterThan(0);
  });
});

// ============================================================
// Extras — deterministic persisted facts (pipeline-specific behaviors)
// ============================================================

describe('NextActionService — persisted extras change the derivation only with positive facts', () => {
  it('manifest repartition_requested=true on COMPLETED → REPARTITION (pure path: COMPILE_ACCEPTANCE)', () => {
    const { fx } = fullFx();
    // Overwrite the work-tree manifest with the canonical F-S02-08 fact.
    const manifestPath = path.join(
      fx.root,
      '.proofloop',
      'manifests',
      `${fx.stageId}.json`,
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    manifest.repartition_requested = true;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    const input = { projectRoot: fx.root, stageId: fx.stageId };
    const serviceOut = new NextActionService().nextAction(input);
    expectContract(serviceOut);
    expect(serviceOut.action).toBe('REPARTITION');

    // The pure function over the raw reconcile output cannot see the manifest
    // fact → COMPILE_ACCEPTANCE. The pipeline's extras drive REPARTITION.
    expect(contractOf(deriveNextAction(reconcileStage(input))).action).toBe(
      'COMPILE_ACCEPTANCE',
    );
  });

  it('planned slice with missing evidence file → INITIALIZE_EVIDENCE (pure path: implement-task)', () => {
    const { fx } = initializeFx();
    const input = { projectRoot: fx.root, stageId: fx.stageId };
    const serviceOut = new NextActionService().nextAction(input);
    expectContract(serviceOut);
    expect(serviceOut.action).toBe('INITIALIZE_EVIDENCE');
    expect(serviceOut.action_detail).toContain('S02-C');

    // Without the evidence-file existence fact the raw pure path would guess
    // implement-task for the first unchecked task.
    expect(contractOf(deriveNextAction(reconcileStage(input))).action).toBe(
      'DISPATCH_WORKER',
    );
  });

  it('pending worker result envelope → ADMIT_WORKER_RESULT (pure path: implement-task)', () => {
    const { fx } = envelopeFx();
    const input = { projectRoot: fx.root, stageId: fx.stageId };
    const serviceOut = new NextActionService().nextAction(input);
    expectContract(serviceOut);
    expect(serviceOut.action).toBe('ADMIT_WORKER_RESULT');
    expect(serviceOut.action_detail).toContain('tok-1');

    // The envelope is the pipeline-only persisted fact — the raw pure path
    // would dispatch the next task.
    expect(contractOf(deriveNextAction(reconcileStage(input))).action).toBe(
      'DISPATCH_WORKER',
    );
  });

  it('GATE_PASS receipt present under review → FINALIZE_STAGE_REVIEW (pure path: RUN_GATE)', () => {
    const { fx } = gateFx();
    const input = { projectRoot: fx.root, stageId: fx.stageId };
    const serviceOut = new NextActionService().nextAction(input);
    expectContract(serviceOut);
    expect(serviceOut.action).toBe('FINALIZE_STAGE_REVIEW');

    // The gate presence is a pipeline-only persisted fact — without it the
    // raw pure path would emit RUN_GATE (all integrated, no GATE_PASS seen).
    expect(contractOf(deriveNextAction(reconcileStage(input))).action).toBe('RUN_GATE');
  });
});

// ============================================================
// Trust-root boundary (S2-F-003) — symlink escapes fail closed
// ============================================================

describe('NextActionService — trust-root boundary (S2-F-003)', () => {
  it('throws a structured error when the pending-results directory escapes the trust root via a symlink', () => {
    const { fx } = partialFx();
    // External dir containing a valid-looking envelope that MUST never be read.
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-pi-out-'));
    cleanups.push(() => {
      try {
        fs.rmSync(external, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });
    const resultsDir = path.join(external, 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(
      path.join(resultsDir, 'tok-ext.json'),
      JSON.stringify({
        schemaVersion: 1,
        actionToken: 'tok-ext',
        stageId: fx.stageId,
        sliceId: 'S02-C',
        taskId: 'S02-C-T01',
        mode: 'implement-task',
        outcome: 'completed',
        evidenceRef: 'delivery/stages/S02/evidence/S02-C.md',
        changedFiles: [],
        verificationRuns: [],
        summary: 'done',
      }),
      'utf-8',
    );
    // Replace .pi with a symlink to the external dir.
    const piDir = path.join(fx.root, '.pi');
    fs.rmSync(piDir, { recursive: true, force: true });
    fs.symlinkSync(external, piDir, 'dir');

    const service = new NextActionService();
    let thrown: unknown;
    try {
      service.nextAction({ projectRoot: fx.root, stageId: fx.stageId });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/escapes the project root trust boundary/);
  });

  it('skips a pending envelope file that is a symlink to an external file (S2-F-003 round 2)', () => {
    const { fx } = partialFx();
    // A valid-looking external envelope that MUST never become a pending fact.
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-pi-file-out-'));
    cleanups.push(() => {
      try {
        fs.rmSync(external, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });
    const externalEnvelope = path.join(external, 'tok-ext.json');
    fs.writeFileSync(
      externalEnvelope,
      JSON.stringify({
        schemaVersion: 1,
        actionToken: 'tok-ext',
        stageId: fx.stageId,
        sliceId: 'S02-C',
        taskId: 'S02-C-T01',
        mode: 'implement-task',
        outcome: 'completed',
        evidenceRef: 'delivery/stages/S02/evidence/S02-C.md',
        changedFiles: [],
        verificationRuns: [],
        summary: 'done',
      }),
      'utf-8',
    );
    // Plant a `.json` symlink inside the (legal, in-root) results dir pointing
    // at the external envelope.
    const resultsDir = path.join(fx.root, '.pi', 'proofloop-runtime', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.symlinkSync(externalEnvelope, path.join(resultsDir, 'tok-ext.json'));

    const service = new NextActionService();
    const out = service.nextAction({ projectRoot: fx.root, stageId: fx.stageId });

    // The escaped envelope is skipped (fail-closed, no throw) and never drives
    // ADMIT_WORKER_RESULT — the first unchecked task is dispatched instead.
    expectContract(out);
    expect(out.action).toBe('DISPATCH_WORKER');
    expect(out.action_detail).toContain('implement-task');
    expect(out.action_detail).not.toContain('tok-ext');
  });

  it('a legal envelope next to an escaped symlink still becomes a pending fact (S2-F-003 round 2)', () => {
    const { fx } = partialFx();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-runtime-pi-file-out-'));
    cleanups.push(() => {
      try {
        fs.rmSync(external, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    });
    const externalEnvelope = path.join(external, 'tok-ext.json');
    fs.writeFileSync(
      externalEnvelope,
      JSON.stringify({
        schemaVersion: 1,
        actionToken: 'tok-ext',
        stageId: fx.stageId,
        sliceId: 'S02-C',
        taskId: 'S02-C-T01',
        mode: 'implement-task',
        outcome: 'completed',
        evidenceRef: 'delivery/stages/S02/evidence/S02-C.md',
        changedFiles: [],
        verificationRuns: [],
        summary: 'done',
      }),
      'utf-8',
    );
    const resultsDir = path.join(fx.root, '.pi', 'proofloop-runtime', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    // Legal in-root envelope.
    fs.writeFileSync(
      path.join(resultsDir, 'tok-legal.json'),
      JSON.stringify({
        schemaVersion: 1,
        actionToken: 'tok-legal',
        stageId: fx.stageId,
        sliceId: 'S02-C',
        taskId: 'S02-C-T01',
        mode: 'implement-task',
        outcome: 'completed',
        evidenceRef: 'delivery/stages/S02/evidence/S02-C.md',
        changedFiles: [],
        verificationRuns: [],
        summary: 'done',
      }),
      'utf-8',
    );
    // Escaped symlink alongside the legal envelope.
    fs.symlinkSync(externalEnvelope, path.join(resultsDir, 'tok-ext.json'));

    const out = new NextActionService().nextAction({
      projectRoot: fx.root,
      stageId: fx.stageId,
    });

    // Only the legal in-root envelope becomes a pending fact.
    expectContract(out);
    expect(out.action).toBe('ADMIT_WORKER_RESULT');
    expect(out.action_detail).toContain('tok-legal');
    expect(out.action_detail).not.toContain('tok-ext');
  });

  it('skips an IN-ROOT symlinked envelope file too (no-follow rejects any symlink final component, S2-F-003 round 3)', () => {
    const { fx } = partialFx();
    const resultsDir = path.join(fx.root, '.pi', 'proofloop-runtime', 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    // A legal in-root envelope.
    const legalEnvelope = path.join(resultsDir, 'tok-legal.json');
    fs.writeFileSync(
      legalEnvelope,
      JSON.stringify({
        schemaVersion: 1,
        actionToken: 'tok-legal',
        stageId: fx.stageId,
        sliceId: 'S02-C',
        taskId: 'S02-C-T01',
        mode: 'implement-task',
        outcome: 'completed',
        evidenceRef: 'delivery/stages/S02/evidence/S02-C.md',
        changedFiles: [],
        verificationRuns: [],
        summary: 'done',
      }),
      'utf-8',
    );
    // An in-root symlink pointing at the legal envelope: O_NOFOLLOW skips it
    // even though its target is inside the root.
    fs.symlinkSync(legalEnvelope, path.join(resultsDir, 'tok-alias.json'));

    const out = new NextActionService().nextAction({
      projectRoot: fx.root,
      stageId: fx.stageId,
    });

    // Only the legal real file becomes a pending fact.
    expectContract(out);
    expect(out.action).toBe('ADMIT_WORKER_RESULT');
    expect(out.action_detail).toContain('tok-legal');
    expect(out.action_detail).not.toContain('tok-alias');
  });

  it('legal pending-results and evidence paths are unaffected', () => {
    const { fx } = envelopeFx();
    const out = new NextActionService().nextAction({
      projectRoot: fx.root,
      stageId: fx.stageId,
    });
    expectContract(out);
    expect(out.action).toBe('ADMIT_WORKER_RESULT');
  });
});

// ============================================================
// GATE_INTERRUPTED — retry semantics (PO-S05-A-06, HP-004/AWI-015)
// ============================================================

describe('NextActionService — GATE_INTERRUPTED is retryable, never GATE_FAIL/GATE_PASS (PO-S05-A-06)', () => {
  it('GATE_INTERRUPTED-only stage-gate category → RUN_GATE (gate retry), no GATE_FAIL finding, chain valid', () => {
    const { fx } = gateInterruptedFx();
    const input = { projectRoot: fx.root, stageId: fx.stageId };
    const out = new NextActionService().nextAction(input);
    expectContract(out);
    // gate_fail_present matches ONLY GATE_FAIL receipts and gate_pass_present
    // ONLY GATE_PASS receipts — an interruption is neither, so the gate is
    // still pending and retryable (row 11).
    expect(out.action).toBe('RUN_GATE');
    expect(out.receipt_chain_valid).toBe(true);
    expect(out.findings.some((f) => /GATE_FAIL/.test(f.message))).toBe(false);
  });

  it('GATE_INTERRUPTED + GATE_FAIL → VALIDATE with the GATE_FAIL blocking finding (GATE_FAIL still wins)', () => {
    const { fx } = gateInterruptedFx();
    fx.writeReceipt('stage-gate', undefined, {
      type: 'GATE_FAIL',
      stage_id: fx.stageId,
      timestamp: '2025-01-07T00:00:00.000Z',
      payload: { verdict: 'FAIL' },
    });
    const out = new NextActionService().nextAction({
      projectRoot: fx.root,
      stageId: fx.stageId,
    });
    expectContract(out);
    expect(out.action).toBe('VALIDATE');
    expect(out.findings.some((f) => /GATE_FAIL/.test(f.message))).toBe(true);
  });

  it('GATE_FAIL + GATE_PASS → not VALIDATE (GATE_PASS post-supplants GATE_FAIL)', () => {
    const { fx } = gateInterruptedFx();
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
    const out = new NextActionService().nextAction({
      projectRoot: fx.root,
      stageId: fx.stageId,
    });
    expectContract(out);
    // GATE_PASS post-supplants GATE_FAIL — no longer blocking.
    expect(out.action).not.toBe('VALIDATE');
    expect(out.findings.some((f) => /GATE_FAIL/.test(f.message))).toBe(false);
  });

  it('GATE_INTERRUPTED is never derived as GATE_PASS: no FINALIZE_STAGE_REVIEW without a real GATE_PASS', () => {
    const { fx } = gateInterruptedFx();
    const out = new NextActionService().nextAction({
      projectRoot: fx.root,
      stageId: fx.stageId,
    });
    expect(out.action).not.toBe('FINALIZE_STAGE_REVIEW');
    expect(out.action).not.toBe('VALIDATE');
    // the pure path agrees: the derive table sees no GATE_PASS/GATE_FAIL fact
    expect(
      contractOf(
        deriveNextAction(
          reconcileStage({ projectRoot: fx.root, stageId: fx.stageId }),
        ),
      ).action,
    ).toBe('RUN_GATE');
  });
});
