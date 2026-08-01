/**
 * admit-extension.spec.ts — PO-S03-H-02 (S03-H-T02)
 *
 * Public seam: `@proofloop/runtime` — the extended `AdmissionRequest` union
 * (SPV/GATE members) and the new admit methods `admitSpvResult` /
 * `admitGateResult`, all wired onto the unified admit pipeline
 * (validate → reconcile → precheck → kernel `writeReceipt` → chain
 * verification, AWI-006). Filesystem integration: real temp git repos with
 * the canonical `.proofloop` layout and kernel `writeReceipt`-produced
 * receipts; fresh `reconcileStage` readback is the oracle.
 *
 * Covered:
 *  - union extension: spv_result / gate_result join the closed request-type
 *    set (S02's 7 preserved); gate verdicts {PASS, FAIL}; schema validation
 *    success + refusal cases;
 *  - admitSpvResult: SPV_PASS → plan/<stage>/, precondition stage derived
 *    PLANNING + manifest-digest binding; refusal cases (not PLANNING,
 *    digest mismatch, already approved); chain verification + reconcile
 *    readback;
 *  - admitGateResult: GATE_PASS / GATE_FAIL → stage-gate/<stage>/,
 *    preconditions git clean + all slices integrated + manifest-digest
 *    binding + HEAD binding; refusal cases (not integrated, dirty tree,
 *    HEAD mismatch, digest mismatch, stage already reviewed); chain
 *    verification + reconcile readback;
 *  - SLICE_PLAN creation-path decision record: S03 does NOT create
 *    SLICE_PLAN receipts — no `slice_plan` request member, and a
 *    worker-result admit for an undeclared slice is refused without
 *    creating any receipt (the creation path is closed; S04 plugs into the
 *    same extension point).
 *
 * Forbidden shortcuts proven absent: prechecks run on real fixtures (no
 * mocked preconditions); persistence goes only through the injected
 * ReceiptWriterPort (one writer-spy proof).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeReceipt, verifyReceiptChain, StageState, SliceState, CVStatus } from '@proofloop/kernel';
import type { Manifest, ManifestSlice } from '@proofloop/kernel';
import {
  reconcileStage,
  receiptCategoryDir,
  planReceiptDir,
  stageGateReceiptDir,
  manifestFileDigest,
  readReceiptCategory,
  ADMISSION_REQUEST_TYPES,
  GATE_VERDICTS,
  GATE_INTERRUPTED_REASONS,
  assertAdmissionRequest,
  admitSpvResult,
  admitGateResult,
  admitGateInterrupted,
  admitWorkerResult,
  NextActionService,
  type SpvResultAdmissionRequest,
  type GateResultAdmissionRequest,
  type GateInterruptedAdmissionRequest,
  type AdmissionDeps,
  type ReconcileStageResult,
  type ReceiptContentCategory,
} from '@proofloop/runtime';

// ============================================================
// Known-good literals (authority excerpts — never derived)
// ============================================================

const STAGE_ID = 'S03';
const SLICE_ID = 'S03-H';
const TASKS: readonly string[] = ['S03-H-T01', 'S03-H-T02'];
const FAKE_SHA = 'a'.repeat(40);

function makeSpvRequest(
  overrides: Partial<SpvResultAdmissionRequest> = {},
): SpvResultAdmissionRequest {
  return {
    type: 'spv_result',
    stageId: STAGE_ID,
    manifestDigest: FAKE_SHA,
    summary: 'stage plan approved',
    ...overrides,
  };
}

function makeGateRequest(
  overrides: Partial<GateResultAdmissionRequest> = {},
): GateResultAdmissionRequest {
  return {
    type: 'gate_result',
    stageId: STAGE_ID,
    verdict: 'PASS',
    manifestDigest: FAKE_SHA,
    snapshotDigest: FAKE_SHA,
    summary: 'stage gate passed',
    ...overrides,
  };
}

function makeGateInterruptedRequest(
  overrides: Partial<GateInterruptedAdmissionRequest> = {},
): GateInterruptedAdmissionRequest {
  return {
    type: 'gate_interrupted',
    stageId: STAGE_ID,
    reason: 'cancelled',
    durationMs: 12000,
    manifestDigest: FAKE_SHA,
    snapshotDigest: FAKE_SHA,
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
  head(): string;
  dirty(): void;
  reconcile(): ReconcileStageResult;
  manifestDigest(): string;
  cleanup(): void;
}

function makeFx(stageId = STAGE_ID, sliceId = SLICE_ID): AdmitFx {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-spv-gate-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'spvgate@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'SpvGate Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);

  const sliceDef = (sid: string, taskIds: readonly string[]): ManifestSlice => ({
    slice_id: sid,
    goal: 'SPV/GATE admit extension',
    observable_outcome: 'SPV_PASS/GATE_PASS/GATE_FAIL receipts via the unified pipeline',
    public_seam: '@proofloop/runtime admitSpvResult/admitGateResult',
    dependencies: [],
    proof_obligations: [
      {
        po_id: 'PO-S03-H-02',
        behavior: 'SPV/GATE admits through the unified pipeline',
        public_seam: 'admitSpvResult/admitGateResult',
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
        stage_goal: 'SPV/GATE pipeline extension',
        outcomes: ['SPV/GATE admits'],
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
        `|---|---|---|---|---|\n| PO-S03-H-02 | admit-extension.spec.ts | yes | yes | pass |\n\n` +
        `### Changed Files\n\n### Verification Commands\n\n### Actual Observations\n\n### Limitations\n`;
      fx.write(`delivery/stages/${stageId}/evidence/${sliceId}.md`, finalized ? finalizedContent : partial);
    },
    seedReceipt: (category, overrides) => {
      const dir =
        category === 'plan' || category === 'stage-gate' || category === 'review'
          ? receiptCategoryDir(root, category, stageId)
          : receiptCategoryDir(root, category, stageId, sliceId);
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
      return fx.head();
    },
    head: () =>
      execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim(),
    dirty: () => fx.write('uncommitted.txt', 'dirty'),
    reconcile: () => reconcileStage({ projectRoot: root, stageId }),
    manifestDigest: () => manifestFileDigest({ projectRoot: root, stageId }),
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

/** Stage derived PLANNING: manifest + STAGE_PLAN receipt, nothing else. */
function fxPlanning(): AdmitFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([]);
  fx.writeEvidence(false);
  fx.seedReceipt('plan', {
    type: 'STAGE_PLAN',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: { status: 'planned', manifest_digest: fx.manifestDigest() },
  });
  fx.commitAll();
  return fx;
}

/**
 * Stage derived UNDER_REVIEW with all slices integrated and a clean tree:
 * STAGE_PLAN + SPV_PASS + CV_PASS + SLICE_COMMIT + INTEGRATION_PASS.
 */
function fxExecuted(): AdmitFx {
  const fx = makeFx();
  fx.writeManifest();
  fx.writeTasksMd([...TASKS]);
  fx.writeEvidence(true);
  fx.seedReceipt('plan', {
    type: 'STAGE_PLAN',
    timestamp: '2025-01-01T00:00:00.000Z',
    payload: { status: 'planned', manifest_digest: fx.manifestDigest() },
  });
  fx.seedReceipt('plan', {
    type: 'SPV_PASS',
    timestamp: '2025-01-02T00:00:00.000Z',
    payload: { status: 'approved', manifest_digest: fx.manifestDigest() },
  });
  const cv = fx.seedReceipt('cv', {
    type: 'CV_PASS',
    timestamp: '2025-01-03T00:00:00.000Z',
    payload: { verdict: 'PASS', snapshot_digest: FAKE_SHA, summary: 'pass' },
  });
  const commit = fx.seedReceipt('committer', {
    type: 'SLICE_COMMIT',
    timestamp: '2025-01-04T00:00:00.000Z',
    payload: { status: 'committed', slice_commit_sha: FAKE_SHA, cv_receipt_digest: cv.digest },
  });
  fx.seedReceipt('integration', {
    type: 'INTEGRATION_PASS',
    timestamp: '2025-01-05T00:00:00.000Z',
    payload: { status: 'integrated', slice_commit_sha: FAKE_SHA },
  });
  void commit;
  fx.commitAll();
  return fx;
}

// ============================================================
// 1. Union extension + schema validation
// ============================================================

describe('AdmissionRequest union extension (PO-S03-H-02)', () => {
  it('adds spv_result, gate_result and gate_interrupted to the closed request-type set (S02 7 preserved)', () => {
    expect(ADMISSION_REQUEST_TYPES).toEqual([
      'worker_result',
      'cv_result',
      'slice_commit',
      'integration',
      'stage_review',
      'project_review',
      'stage_plan',
      'spv_result',
      'gate_result',
      'gate_interrupted',
    ]);
    expect(ADMISSION_REQUEST_TYPES).toHaveLength(10);
  });

  it('defines the closed gate verdict set {PASS, FAIL} — interruption is NOT a verdict', () => {
    expect(GATE_VERDICTS).toEqual(['PASS', 'FAIL']);
    expect(GATE_VERDICTS).not.toContain('INTERRUPTED');
    expect(GATE_INTERRUPTED_REASONS).toEqual(['cancelled', 'timeout']);
  });

  it('accepts valid spv_result and gate_result requests', () => {
    expect(() => assertAdmissionRequest(makeSpvRequest())).not.toThrow();
    expect(() => assertAdmissionRequest(makeGateRequest())).not.toThrow();
    expect(() =>
      assertAdmissionRequest(makeGateRequest({ verdict: 'FAIL' })),
    ).not.toThrow();
  });

  it('accepts valid gate_interrupted requests (cancelled / timeout, non-negative duration_ms)', () => {
    expect(() =>
      assertAdmissionRequest(makeGateInterruptedRequest({ reason: 'cancelled', durationMs: 0 })),
    ).not.toThrow();
    expect(() =>
      assertAdmissionRequest(makeGateInterruptedRequest({ reason: 'timeout', durationMs: 300000 })),
    ).not.toThrow();
    // interruption carries NO verdict — a verdict-like field is an unknown field
    expect(() =>
      assertAdmissionRequest({
        ...makeGateInterruptedRequest({ reason: 'cancelled', durationMs: 1 }),
        verdict: 'PASS',
      }),
    ).toThrow(/unknown field/i);
  });

  it('rejects schema-invalid spv_result / gate_result requests (fail closed)', () => {
    const invalid: Array<[string, unknown]> = [
      ['spv_result — verdict-like unknown field', { type: 'spv_result', stageId: STAGE_ID, manifestDigest: 'd', summary: 's', verdict: 'PASS' }],
      ['spv_result — missing manifestDigest', { type: 'spv_result', stageId: STAGE_ID, summary: 's' }],
      ['spv_result — missing summary', { type: 'spv_result', stageId: STAGE_ID, manifestDigest: 'd' }],
      ['spv_result — stageId charset violation', { type: 'spv_result', stageId: '../S03', manifestDigest: 'd', summary: 's' }],
      ['gate_result — verdict outside {PASS, FAIL}', { type: 'gate_result', stageId: STAGE_ID, verdict: 'CONFIRMED', manifestDigest: 'd', snapshotDigest: 'h', summary: 's' }],
      ['gate_result — missing snapshotDigest', { type: 'gate_result', stageId: STAGE_ID, verdict: 'PASS', manifestDigest: 'd', summary: 's' }],
      ['gate_result — missing manifestDigest', { type: 'gate_result', stageId: STAGE_ID, verdict: 'PASS', snapshotDigest: 'h', summary: 's' }],
      ['gate_result — unknown field', { type: 'gate_result', stageId: STAGE_ID, verdict: 'PASS', manifestDigest: 'd', snapshotDigest: 'h', summary: 's', extra: 1 }],
      ['gate_interrupted — reason outside {cancelled, timeout}', { type: 'gate_interrupted', stageId: STAGE_ID, reason: 'aborted', durationMs: 1, manifestDigest: 'd', snapshotDigest: 'h' }],
      ['gate_interrupted — negative durationMs', { type: 'gate_interrupted', stageId: STAGE_ID, reason: 'cancelled', durationMs: -1, manifestDigest: 'd', snapshotDigest: 'h' }],
      ['gate_interrupted — string durationMs', { type: 'gate_interrupted', stageId: STAGE_ID, reason: 'cancelled', durationMs: '1000', manifestDigest: 'd', snapshotDigest: 'h' }],
      ['gate_interrupted — missing snapshotDigest', { type: 'gate_interrupted', stageId: STAGE_ID, reason: 'timeout', durationMs: 1, manifestDigest: 'd' }],
      ['gate_interrupted — verdict-like unknown field', { type: 'gate_interrupted', stageId: STAGE_ID, reason: 'cancelled', durationMs: 1, manifestDigest: 'd', snapshotDigest: 'h', verdict: 'PASS' }],
    ];
    for (const [name, request] of invalid) {
      expect(() => assertAdmissionRequest(request), name).toThrow(/schema validation failed/i);
    }
  });

  it('SLICE_PLAN decision record: no slice_plan request member exists in S03 (no consumer)', () => {
    // PO-S03-H-02 decision: the kernel SLICE_PLAN literal is retained but S03
    // does NOT create SLICE_PLAN receipts — the creation path is closed and
    // the S04 tool flow plugs into the same extension point.
    expect(ADMISSION_REQUEST_TYPES).not.toContain('slice_plan');
    expect(() => assertAdmissionRequest({ type: 'slice_plan', stageId: STAGE_ID })).toThrow(
      /must be one of/i,
    );
  });
});

// ============================================================
// 2. admitSpvResult (PO-S03-H-02)
// ============================================================

describe('admitSpvResult (SPV_PASS → plan/<stage>/, stage PLANNING + digest binding)', () => {
  it('accepts a PLANNING stage with a bound manifest digest and writes a chain-verified SPV_PASS', () => {
    const fx = fxPlanning();
    // precondition oracle: fresh reconcile derives PLANNING
    expect(fx.reconcile().stage_state).toBe(StageState.PLANNING);
    const request = makeSpvRequest({ manifestDigest: fx.manifestDigest() });
    const result = admitSpvResult(request, { projectRoot: fx.root });
    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toBeTruthy();
    expect(result.new_state?.stage_state).toBe(StageState.READY);
    // receipt lands in plan/<stage>/ and the chain is valid
    const planDir = planReceiptDir(fx.root, STAGE_ID);
    expect(fs.existsSync(path.join(planDir, `${result.receipt_ref}.json`))).toBe(true);
    expect(verifyReceiptChain(planDir).valid).toBe(true);
    // fresh reconcile readback: SPV_PASS present → READY folds into EXECUTING
    const readback = fx.reconcile();
    expect(readback.stage_state).toBe(StageState.EXECUTING);
    const planRead = readReceiptCategory({
      projectRoot: fx.root,
      category: 'plan',
      stageId: STAGE_ID,
    });
    expect(planRead.receipts.map((r) => r.receipt.type)).toContain('SPV_PASS');
  });

  it('refuses when the stage is not derived PLANNING (no STAGE_PLAN receipt)', () => {
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([]);
    fx.writeEvidence(false);
    fx.commitAll();
    expect(fx.reconcile().stage_state).toBe(StageState.UNINITIALIZED);
    const result = admitSpvResult(makeSpvRequest({ manifestDigest: fx.manifestDigest() }), {
      projectRoot: fx.root,
    });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(verifyReceiptChain(planReceiptDir(fx.root, STAGE_ID)).valid).toBe(true);
  });

  it('refuses on a manifest-digest binding mismatch (no receipt written)', () => {
    const fx = fxPlanning();
    const result = admitSpvResult(makeSpvRequest({ manifestDigest: 'wrong-digest' }), {
      projectRoot: fx.root,
    });
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0]?.message).toMatch(/manifest digest binding mismatch/i);
    const planDir = planReceiptDir(fx.root, STAGE_ID);
    expect(fs.readdirSync(planDir).filter((f) => f.endsWith('.json'))).toHaveLength(1); // only STAGE_PLAN
  });

  it('refuses a second SPV admit (stage already approved → not PLANNING)', () => {
    const fx = fxPlanning();
    const first = admitSpvResult(makeSpvRequest({ manifestDigest: fx.manifestDigest() }), {
      projectRoot: fx.root,
    });
    expect(first.accepted).toBe(true);
    const second = admitSpvResult(makeSpvRequest({ manifestDigest: fx.manifestDigest() }), {
      projectRoot: fx.root,
    });
    expect(second.accepted).toBe(false);
    expect(second.receipt_ref).toBeNull();
  });

  it('persists only through the injected ReceiptWriterPort (unified pipeline)', () => {
    const fx = fxPlanning();
    const writes: Array<Record<string, unknown>> = [];
    const fakeWriter = {
      write: (data: object) => {
        writes.push(data as Record<string, unknown>);
        return { digest: 'fake-digest', path: '/fake/path.json' };
      },
      verifyChain: () => ({ valid: true, receipts: [] as string[] }),
    };
    const request = makeSpvRequest({ manifestDigest: fx.manifestDigest() });
    const result = admitSpvResult(request, {
      projectRoot: fx.root,
      reconcile: () => fx.reconcile(),
      writer: fakeWriter,
    });
    expect(result.accepted).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]['type']).toBe('SPV_PASS');
    expect(writes[0]['stage_id']).toBe(STAGE_ID);
  });
});

// ============================================================
// 3. admitGateResult (PO-S03-H-02)
// ============================================================

describe('admitGateResult (GATE_PASS/GATE_FAIL → stage-gate/<stage>/)', () => {
  it('accepts PASS on a clean all-integrated stage with bound digest + HEAD and writes GATE_PASS', () => {
    const fx = fxExecuted();
    const head = fx.head();
    expect(fx.reconcile().stage_state).toBe(StageState.UNDER_REVIEW);
    const request = makeGateRequest({
      manifestDigest: fx.manifestDigest(),
      snapshotDigest: head,
    });
    const result = admitGateResult(request, { projectRoot: fx.root });
    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toBeTruthy();
    // receipt lands in stage-gate/<stage>/ and the chain is valid
    const gateDir = stageGateReceiptDir(fx.root, STAGE_ID);
    expect(fs.existsSync(path.join(gateDir, `${result.receipt_ref}.json`))).toBe(true);
    expect(verifyReceiptChain(gateDir).valid).toBe(true);
    // fresh reconcile readback: GATE_PASS present in the stage-gate category
    const readback = fx.reconcile();
    expect(readback.stage_state).toBe(StageState.UNDER_REVIEW);
    const gateRead = readReceiptCategory({
      projectRoot: fx.root,
      category: 'stage-gate',
      stageId: STAGE_ID,
    });
    expect(gateRead.receipts.map((r) => r.receipt.type)).toContain('GATE_PASS');
  });

  it('accepts FAIL and writes a GATE_FAIL receipt without advancing the stage', () => {
    const fx = fxExecuted();
    const request = makeGateRequest({
      verdict: 'FAIL',
      manifestDigest: fx.manifestDigest(),
      snapshotDigest: fx.head(),
      summary: 'gate failed: step boom',
    });
    const result = admitGateResult(request, { projectRoot: fx.root });
    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toBeTruthy();
    const gateDir = stageGateReceiptDir(fx.root, STAGE_ID);
    expect(verifyReceiptChain(gateDir).valid).toBe(true);
    const written = JSON.parse(
      fs.readFileSync(path.join(gateDir, `${result.receipt_ref}.json`), 'utf-8'),
    ) as { type: string; payload: Record<string, unknown> };
    expect(written.type).toBe('GATE_FAIL');
    expect(written.payload['summary']).toBe('gate failed: step boom');
  });

  it('refuses when not every slice is integrated', () => {
    const fx = fxPlanning(); // STAGE_PLAN only → PLANNING, no integration
    const result = admitGateResult(
      makeGateRequest({
        manifestDigest: fx.manifestDigest(),
        snapshotDigest: fx.head(),
      }),
      { projectRoot: fx.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0]?.message).toMatch(/integrated/i);
  });

  it('refuses when the working tree is dirty (git clean precondition)', () => {
    const fx = fxExecuted();
    fx.dirty();
    const result = admitGateResult(
      makeGateRequest({
        manifestDigest: fx.manifestDigest(),
        snapshotDigest: fx.head(),
      }),
      { projectRoot: fx.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/clean/i);
  });

  it('refuses when the request HEAD binding does not match the current HEAD', () => {
    const fx = fxExecuted();
    const result = admitGateResult(
      makeGateRequest({
        manifestDigest: fx.manifestDigest(),
        snapshotDigest: 'b'.repeat(40),
      }),
      { projectRoot: fx.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/HEAD/i);
  });

  it('refuses on a manifest-digest binding mismatch', () => {
    const fx = fxExecuted();
    const result = admitGateResult(
      makeGateRequest({
        manifestDigest: 'wrong-digest',
        snapshotDigest: fx.head(),
      }),
      { projectRoot: fx.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/manifest digest binding mismatch/i);
  });

  it('refuses when the stage was already reviewed (COMPLETED)', () => {
    const fx = fxExecuted();
    fx.seedReceipt('review', {
      type: 'STAGE_REVIEW_PASS',
      timestamp: '2025-01-06T00:00:00.000Z',
      payload: { verdict: 'ACCEPTED', summary: 'reviewed' },
    });
    fx.commitAll();
    expect(fx.reconcile().stage_state).toBe(StageState.COMPLETED);
    const result = admitGateResult(
      makeGateRequest({
        manifestDigest: fx.manifestDigest(),
        snapshotDigest: fx.head(),
      }),
      { projectRoot: fx.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/UNDER_REVIEW/i);
  });
});

// ============================================================
// 4. admitGateInterrupted (S05-A-T05, HP-004/AWI-015)
// ============================================================

describe('admitGateInterrupted (GATE_INTERRUPTED → stage-gate/<stage>/, no verdict receipt)', () => {
  it('accepts a cancelled run with bound digest + HEAD and writes a chain-valid GATE_INTERRUPTED (no GATE_PASS/GATE_FAIL)', () => {
    const fx = fxExecuted();
    expect(fx.reconcile().stage_state).toBe(StageState.UNDER_REVIEW);
    const request = makeGateInterruptedRequest({
      reason: 'cancelled',
      durationMs: 12000,
      manifestDigest: fx.manifestDigest(),
      snapshotDigest: fx.head(),
    });
    const result = admitGateInterrupted(request, { projectRoot: fx.root });
    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toBeTruthy();
    // the receipt lands in stage-gate/<stage>/ and the category chain stays valid
    const gateDir = stageGateReceiptDir(fx.root, STAGE_ID);
    expect(fs.existsSync(path.join(gateDir, `${result.receipt_ref}.json`))).toBe(true);
    expect(verifyReceiptChain(gateDir).valid).toBe(true);
    const written = JSON.parse(
      fs.readFileSync(path.join(gateDir, `${result.receipt_ref}.json`), 'utf-8'),
    ) as { type: string; payload: Record<string, unknown> };
    expect(written.type).toBe('GATE_INTERRUPTED');
    expect(written.payload['reason']).toBe('cancelled');
    expect(written.payload['duration_ms']).toBe(12000);
    // interruption is NOT a verdict — no PASS/FAIL receipt is ever written
    const gateRead = readReceiptCategory({
      projectRoot: fx.root,
      category: 'stage-gate',
      stageId: STAGE_ID,
    });
    const types = gateRead.receipts.map((r) => r.receipt.type);
    expect(types).toContain('GATE_INTERRUPTED');
    expect(types).not.toContain('GATE_PASS');
    expect(types).not.toContain('GATE_FAIL');
  });

  it('accepts a timeout run with the bounded duration_ms payload', () => {
    const fx = fxExecuted();
    const request = makeGateInterruptedRequest({
      reason: 'timeout',
      durationMs: 300000,
      manifestDigest: fx.manifestDigest(),
      snapshotDigest: fx.head(),
    });
    const result = admitGateInterrupted(request, { projectRoot: fx.root });
    expect(result.accepted).toBe(true);
    const gateDir = stageGateReceiptDir(fx.root, STAGE_ID);
    const written = JSON.parse(
      fs.readFileSync(path.join(gateDir, `${result.receipt_ref}.json`), 'utf-8'),
    ) as { type: string; payload: Record<string, unknown> };
    expect(written.type).toBe('GATE_INTERRUPTED');
    expect(written.payload['reason']).toBe('timeout');
    expect(written.payload['duration_ms']).toBe(300000);
  });

  it('is retryable: after a GATE_INTERRUPTED receipt the next action is RUN_GATE (never VALIDATE, never FINALIZE_STAGE_REVIEW)', () => {
    // Clean fixture: commit the project FIRST, then seed the integration
    // receipts bound to the actual HEAD (a fake SHA would trip reconcile's
    // SLICE_COMMIT-ancestor check and mask the retry derivation).
    const fx = makeFx();
    fx.writeManifest();
    fx.writeTasksMd([...TASKS]);
    fx.writeEvidence(true);
    fx.seedReceipt('plan', {
      type: 'STAGE_PLAN',
      timestamp: '2025-01-01T00:00:00.000Z',
      payload: { status: 'planned', manifest_digest: fx.manifestDigest() },
    });
    fx.seedReceipt('plan', {
      type: 'SPV_PASS',
      timestamp: '2025-01-02T00:00:00.000Z',
      payload: { status: 'approved', manifest_digest: fx.manifestDigest() },
    });
    const cv = fx.seedReceipt('cv', {
      type: 'CV_PASS',
      timestamp: '2025-01-03T00:00:00.000Z',
      payload: { verdict: 'PASS', snapshot_digest: FAKE_SHA, summary: 'pass' },
    });
    const head = fx.commitAll();
    const commit = fx.seedReceipt('committer', {
      type: 'SLICE_COMMIT',
      timestamp: '2025-01-04T00:00:00.000Z',
      payload: { status: 'committed', slice_commit_sha: head, cv_receipt_digest: cv.digest },
    });
    fx.seedReceipt('integration', {
      type: 'INTEGRATION_PASS',
      timestamp: '2025-01-05T00:00:00.000Z',
      payload: { status: 'integrated', slice_commit_sha: head },
    });
    void commit;
    expect(fx.reconcile().stage_state).toBe(StageState.UNDER_REVIEW);

    const result = admitGateInterrupted(
      makeGateInterruptedRequest({
        reason: 'timeout',
        durationMs: 300000,
        manifestDigest: fx.manifestDigest(),
        snapshotDigest: head,
      }),
      { projectRoot: fx.root },
    );
    expect(result.accepted).toBe(true);

    const out = new NextActionService().nextAction({ projectRoot: fx.root, stageId: STAGE_ID });
    // gate_fail_present matches only GATE_FAIL and gate_pass_present only
    // GATE_PASS — an interruption is neither, so the gate is retryable.
    expect(out.action).toBe('RUN_GATE');
    expect(out.findings.some((f) => /GATE_FAIL/.test(f.message))).toBe(false);
  });

  it('refuses when not every slice is integrated', () => {
    const fx = fxPlanning(); // STAGE_PLAN only → PLANNING, no integration
    const result = admitGateInterrupted(
      makeGateInterruptedRequest({
        manifestDigest: fx.manifestDigest(),
        snapshotDigest: fx.head(),
      }),
      { projectRoot: fx.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.code).toBe('DOMAIN.INVALID_TRANSITION');
    expect(result.findings[0]?.message).toMatch(/integrated/i);
  });

  it('refuses when the request HEAD binding does not match the current HEAD', () => {
    const fx = fxExecuted();
    const result = admitGateInterrupted(
      makeGateInterruptedRequest({
        manifestDigest: fx.manifestDigest(),
        snapshotDigest: 'b'.repeat(40),
      }),
      { projectRoot: fx.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/HEAD/i);
  });

  it('refuses on a manifest-digest binding mismatch', () => {
    const fx = fxExecuted();
    const result = admitGateInterrupted(
      makeGateInterruptedRequest({
        manifestDigest: 'wrong-digest',
        snapshotDigest: fx.head(),
      }),
      { projectRoot: fx.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/manifest digest binding mismatch/i);
  });

  it('refuses when the stage was already reviewed (COMPLETED)', () => {
    const fx = fxExecuted();
    fx.seedReceipt('review', {
      type: 'STAGE_REVIEW_PASS',
      timestamp: '2025-01-06T00:00:00.000Z',
      payload: { verdict: 'ACCEPTED', summary: 'reviewed' },
    });
    fx.commitAll();
    expect(fx.reconcile().stage_state).toBe(StageState.COMPLETED);
    const result = admitGateInterrupted(
      makeGateInterruptedRequest({
        manifestDigest: fx.manifestDigest(),
        snapshotDigest: fx.head(),
      }),
      { projectRoot: fx.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0]?.message).toMatch(/UNDER_REVIEW/i);
  });
});

// ============================================================
// 5. CLI wiring — admit.js spv-result / gate-result (observable outcome)
// ============================================================

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST_ADMIT = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'admit.js');

function runCli(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [DIST_ADMIT, ...args], {
    encoding: 'utf-8',
    timeout: 30000,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Request files live OUTSIDE the fixture git repo (a dirty tree fails the gate). */
function reqDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-cli-req-'));
  cleanups.push(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });
  return dir;
}

describe('admit.js spv-result / gate-result (PO-S03-H-02 observable outcome)', () => {
  it('admit.js spv-result writes an SPV_PASS receipt via the unified pipeline', () => {
    expect(fs.existsSync(DIST_ADMIT)).toBe(true);
    const fx = fxPlanning();
    const requestPath = path.join(reqDir(), 'spv-request.json');
    fs.writeFileSync(
      requestPath,
      JSON.stringify({
        stageId: STAGE_ID,
        manifestDigest: fx.manifestDigest(),
        summary: 'cli spv admit',
      }),
      'utf-8',
    );
    const res = runCli(['spv-result', requestPath, fx.root]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { accepted: boolean; receipt_ref: string | null };
    expect(out.accepted).toBe(true);
    expect(out.receipt_ref).toBeTruthy();
    const planDir = planReceiptDir(fx.root, STAGE_ID);
    expect(verifyReceiptChain(planDir).valid).toBe(true);
    const planRead = readReceiptCategory({
      projectRoot: fx.root,
      category: 'plan',
      stageId: STAGE_ID,
    });
    expect(planRead.receipts.map((r) => r.receipt.type)).toContain('SPV_PASS');
  });

  it('admit.js gate-result writes a GATE_PASS receipt via the unified pipeline', () => {
    expect(fs.existsSync(DIST_ADMIT)).toBe(true);
    const fx = fxExecuted();
    const requestPath = path.join(reqDir(), 'gate-request.json');
    fs.writeFileSync(
      requestPath,
      JSON.stringify({
        stageId: STAGE_ID,
        verdict: 'PASS',
        manifestDigest: fx.manifestDigest(),
        snapshotDigest: fx.head(),
        summary: 'cli gate admit',
      }),
      'utf-8',
    );
    const res = runCli(['gate-result', requestPath, fx.root]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { accepted: boolean; receipt_ref: string | null };
    expect(out.accepted).toBe(true);
    expect(out.receipt_ref).toBeTruthy();
    const gateDir = stageGateReceiptDir(fx.root, STAGE_ID);
    expect(verifyReceiptChain(gateDir).valid).toBe(true);
    const gateRead = readReceiptCategory({
      projectRoot: fx.root,
      category: 'stage-gate',
      stageId: STAGE_ID,
    });
    expect(gateRead.receipts.map((r) => r.receipt.type)).toContain('GATE_PASS');
  });

  it('admit.js gate-result with verdict FAIL writes a GATE_FAIL receipt (exit 0)', () => {
    expect(fs.existsSync(DIST_ADMIT)).toBe(true);
    const fx = fxExecuted();
    const requestPath = path.join(reqDir(), 'gate-fail.json');
    fs.writeFileSync(
      requestPath,
      JSON.stringify({
        stageId: STAGE_ID,
        verdict: 'FAIL',
        manifestDigest: fx.manifestDigest(),
        snapshotDigest: fx.head(),
        summary: 'cli gate fail',
      }),
      'utf-8',
    );
    const res = runCli(['gate-result', requestPath, fx.root]);
    expect(res.status).toBe(0);
    const gateRead = readReceiptCategory({
      projectRoot: fx.root,
      category: 'stage-gate',
      stageId: STAGE_ID,
    });
    expect(gateRead.receipts.map((r) => r.receipt.type)).toContain('GATE_FAIL');
  });

  it('admit.js gate-interrupted writes a GATE_INTERRUPTED receipt via the unified pipeline', () => {
    expect(fs.existsSync(DIST_ADMIT)).toBe(true);
    const fx = fxExecuted();
    const requestPath = path.join(reqDir(), 'gate-interrupted.json');
    fs.writeFileSync(
      requestPath,
      JSON.stringify({
        stageId: STAGE_ID,
        reason: 'cancelled',
        durationMs: 5000,
        manifestDigest: fx.manifestDigest(),
        snapshotDigest: fx.head(),
      }),
      'utf-8',
    );
    const res = runCli(['gate-interrupted', requestPath, fx.root]);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout) as { accepted: boolean; receipt_ref: string | null };
    expect(out.accepted).toBe(true);
    expect(out.receipt_ref).toBeTruthy();
    const gateDir = stageGateReceiptDir(fx.root, STAGE_ID);
    expect(verifyReceiptChain(gateDir).valid).toBe(true);
    const gateRead = readReceiptCategory({
      projectRoot: fx.root,
      category: 'stage-gate',
      stageId: STAGE_ID,
    });
    const types = gateRead.receipts.map((r) => r.receipt.type);
    expect(types).toContain('GATE_INTERRUPTED');
    expect(types).not.toContain('GATE_PASS');
    expect(types).not.toContain('GATE_FAIL');
  });

  it('rejects a subcommand that conflicts with the explicit request type', () => {
    expect(fs.existsSync(DIST_ADMIT)).toBe(true);
    const fx = fxPlanning();
    const requestPath = path.join(reqDir(), 'conflict.json');
    fs.writeFileSync(
      requestPath,
      JSON.stringify({ type: 'gate_result', stageId: STAGE_ID }),
      'utf-8',
    );
    const res = runCli(['spv-result', requestPath, fx.root]);
    expect(res.status).toBe(1);
    expect((res.stderr + res.stdout).toLowerCase()).toContain('conflict');
  });
});

// ============================================================
// 4. SLICE_PLAN creation-path decision (PO-S03-H-02)
// ============================================================

describe('SLICE_PLAN creation-path decision record (PO-S03-H-02)', () => {
  it('worker-result admit for an undeclared slice is refused and creates NO SLICE_PLAN receipt', () => {
    const fx = makeFx();
    fx.writeManifest(); // declares S03-H only
    fx.writeTasksMd([]);
    fx.writeEvidence(false);
    fx.commitAll();
    const result = admitWorkerResult(
      {
        type: 'worker_result',
        envelope: {
          schemaVersion: 1,
          actionToken: 'tok-undeclared',
          stageId: STAGE_ID,
          sliceId: 'S03-Z',
          taskId: 'S03-Z-T01',
          mode: 'implement-task',
          outcome: 'completed',
          evidenceRef: `delivery/stages/${STAGE_ID}/evidence/S03-Z.md`,
          changedFiles: ['x.ts'],
          verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'l' }],
          summary: 'undeclared slice',
        },
      },
      { projectRoot: fx.root },
    );
    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    // the creation path is closed in S03: no receipt of ANY type (in
    // particular no SLICE_PLAN) is written for a slice that does not exist
    const planDir = planReceiptDir(fx.root, STAGE_ID);
    expect(fs.existsSync(planDir)).toBe(false);
  });
});
