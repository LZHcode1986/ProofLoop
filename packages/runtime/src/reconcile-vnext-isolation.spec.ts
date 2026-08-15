import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { writeReceipt } from '@proofloop/kernel';
import type { Manifest, ManifestSlice, ReceiptWriterOptions } from '@proofloop/kernel';
import {
  admitWorkerResult,
  reconcileStage,
  readReceiptCategory,
  tasksReceiptDir,
} from '@proofloop/runtime';
import type {
  AdmitResult,
  ReceiptWriterPort,
  ReconcileStageResult,
} from '@proofloop/runtime';

const STAGE_ID = 'S02';
const SLICE_ID = 'S02-C';
const TASK_ID = 'S02-C-T01';
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function makeSlice(): ManifestSlice {
  return {
    slice_id: SLICE_ID,
    goal: 'v1/vNext receipt isolation',
    observable_outcome: 'legacy reconcile does not consume vNext receipts',
    public_seam: '@proofloop/runtime reconcileStage',
    dependencies: [],
    proof_obligations: [],
    tasks: [TASK_ID],
    risk_facts: ['persistent_state'],
    evidence_path: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    cv_minimum_level: 'standard',
  };
}

function makeFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proofloop-reconcile-vnext-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'reconcile-vnext@test.local']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Reconcile vNext Test']);
  execFileSync('git', ['-C', root, 'config', 'commit.gpgsign', 'false']);

  const manifest: Manifest = {
    stage_id: STAGE_ID,
    source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
    source_digest: 'a'.repeat(64),
    stage_goal: 'receipt isolation',
    outcomes: ['legacy and vNext consumers remain isolated'],
    slices: [makeSlice()],
    dependencies: [],
    risk_facts: ['persistent_state'],
  };
  writeFile(root, `.proofloop/manifests/${STAGE_ID}.json`, JSON.stringify(manifest));
  writeFile(
    root,
    `delivery/stages/${STAGE_ID}/tasks.md`,
    [
      `# Stage ${STAGE_ID}`,
      `<!-- SLICE:${SLICE_ID}:BEGIN -->`,
      `## Slice ${SLICE_ID}`,
      `- [x] ${TASK_ID}: isolation fixture`,
      `<!-- SLICE:${SLICE_ID}:END -->`,
      '',
    ].join('\n'),
  );
  writeFile(
    root,
    `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    [
      `# Slice ${SLICE_ID} Evidence`,
      '',
      '## Task Evidence',
      '',
      `### ${TASK_ID}`,
      '',
      '- Status: COMPLETE',
      '',
      '## Current Slice Evidence',
      '',
      '### Proof Obligation Coverage',
      '',
      '| PO ID | Result |',
      '|---|---|',
      '| fixture | PASS |',
      '',
    ].join('\n'),
  );
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'vnext isolation fixture']);
  return root;
}

function writeFile(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeTaskReceipt(
  root: string,
  payload: Record<string, unknown>,
  previousDigest?: string,
): { path: string; digest: string } {
  const dir = tasksReceiptDir(root, STAGE_ID, SLICE_ID);
  fs.mkdirSync(dir, { recursive: true });
  return writeReceipt(
    {
      version: 1,
      type: 'TASK_COMPLETE',
      stage_id: STAGE_ID,
      slice_id: SLICE_ID,
      timestamp: `2026-08-06T00:00:0${previousDigest === undefined ? '1' : '2'}.000Z`,
      payload,
      ...(previousDigest === undefined ? {} : { previous_digest: previousDigest }),
    },
    { receiptDir: dir, tempDir: dir },
  );
}

function reconcile(root: string): ReconcileStageResult {
  return reconcileStage({ projectRoot: root, stageId: STAGE_ID });
}

function stateProjection(result: ReconcileStageResult): unknown {
  return {
    slices: result.slices,
    stage_state: result.stage_state,
    project_state: result.project_state,
  };
}

function expectCompatibilityFinding(result: ReconcileStageResult): void {
  expect(
    result.findings.some(
      (finding) =>
        finding.code === 'RUNTIME.SCHEMA_MISMATCH' &&
        finding.severity === 'error' &&
        /schema_version|vNext|compatib/i.test(finding.message),
    ),
  ).toBe(true);
}

function legacyWorkerEnvelope(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    actionToken: 'legacy-new-action',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    taskId: TASK_ID,
    mode: 'implement-task',
    outcome: 'completed',
    evidenceRef: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    changedFiles: ['packages/runtime/src/reconcile.ts'],
    verificationRuns: [{ commandId: 'runtime-test', exitCode: 0, logRef: 'fixture-log' }],
    summary: 'legacy admission isolation fixture',
  };
}

describe('reconcileStage — v1/vNext TASK_COMPLETE isolation', () => {
  it('does not derive legacy state from a v2 payload and reports a compatibility Finding', () => {
    const root = makeFixture();
    const before = reconcile(root);

    writeTaskReceipt(root, {
      schema_version: 2,
      action_token: 'vnext-finalize',
      mode: 'finalize-slice',
    });

    const after = reconcile(root);

    expect(stateProjection(after)).toEqual(stateProjection(before));
    expectCompatibilityFinding(after);
    expect(after.receipt_chain_valid).toBe(true);
    expect(
      after.receipt_categories.find(
        (category) => category.category === 'tasks' && category.slice_id === SLICE_ID,
      )?.receipt_chain_valid,
    ).toBe(true);
  });

  it('continues to consume a pure v1 TASK_COMPLETE payload', () => {
    const root = makeFixture();
    writeTaskReceipt(root, { mode: 'finalize-slice' });

    const result = reconcile(root);

    expect(result.findings).toEqual([]);
    expect(result.slices[0]?.slice_state).toBe('READY_FOR_CV');
  });

  it('fails closed for a mixed v1/vNext task chain instead of using either version as legacy state', () => {
    const root = makeFixture();
    const before = reconcile(root);
    const v1 = writeTaskReceipt(root, { mode: 'finalize-slice' });
    writeTaskReceipt(
      root,
      {
        schema_version: 2,
        action_token: 'vnext-after-v1',
        mode: 'implement-task',
      },
      v1.digest,
    );

    const result = reconcile(root);

    expect(stateProjection(result)).toEqual(stateProjection(before));
    expectCompatibilityFinding(result);
    expect(result.receipt_chain_valid).toBe(true);
    expect(
      result.receipt_categories.find(
        (category) => category.category === 'tasks' && category.slice_id === SLICE_ID,
      )?.receipt_chain_valid,
    ).toBe(true);
  });

  it.each([3, '2', null])('fails closed for an unknown discriminator %p', (schemaVersion) => {
    const root = makeFixture();
    const before = reconcile(root);
    writeTaskReceipt(root, { schema_version: schemaVersion, mode: 'finalize-slice' });

    const result = reconcile(root);

    expect(stateProjection(result)).toEqual(stateProjection(before));
    expectCompatibilityFinding(result);
  });

  it('keeps the default reader chain intact for multiple v2 action tokens', () => {
    const root = makeFixture();
    const first = writeTaskReceipt(root, {
      schema_version: 2,
      action_token: 'vnext-first',
      mode: 'implement-task',
    });
    writeTaskReceipt(
      root,
      {
        schema_version: 2,
        action_token: 'vnext-second',
        mode: 'implement-task',
      },
      first.digest,
    );

    const readback = readReceiptCategory({
      projectRoot: root,
      category: 'tasks',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
    });

    expect(readback.chainValid).toBe(true);
    expect(readback.receipts).toHaveLength(2);
    expect(readback.receipts.map((entry) => entry.receipt.payload['action_token'])).toEqual([
      'vnext-first',
      'vnext-second',
    ]);
  });

  it('does not let legacy admission write after reconcile sees a v2 TASK_COMPLETE', () => {
    const root = makeFixture();
    writeTaskReceipt(root, {
      schema_version: 2,
      action_token: 'vnext-existing',
      mode: 'implement-task',
    });

    const writes: Array<{ data: object; options: ReceiptWriterOptions }> = [];
    const writer: ReceiptWriterPort = {
      verifyChain: () => ({ valid: true, receipts: [] }),
      write: (data, options) => {
        writes.push({ data, options });
        return { path: path.join(root, 'fake-receipt.json'), digest: 'b'.repeat(64) };
      },
    };

    const result: AdmitResult = admitWorkerResult(
      { type: 'worker_result', envelope: legacyWorkerEnvelope() } as never,
      { projectRoot: root, writer },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(writes).toHaveLength(0);
    expect(result.findings.some((finding) => finding.code === 'RUNTIME.SCHEMA_MISMATCH')).toBe(true);
  });

  it('does not let legacy admission write after a mixed v1/vNext TASK_COMPLETE chain', () => {
    const root = makeFixture();
    const v1 = writeTaskReceipt(root, { mode: 'finalize-slice' });
    writeTaskReceipt(
      root,
      {
        schema_version: 2,
        action_token: 'vnext-after-v1',
        mode: 'implement-task',
      },
      v1.digest,
    );

    const writes: Array<{ data: object; options: ReceiptWriterOptions }> = [];
    const writer: ReceiptWriterPort = {
      verifyChain: () => ({ valid: true, receipts: [] }),
      write: (data, options) => {
        writes.push({ data, options });
        return { path: path.join(root, 'fake-receipt.json'), digest: 'b'.repeat(64) };
      },
    };

    const result: AdmitResult = admitWorkerResult(
      { type: 'worker_result', envelope: legacyWorkerEnvelope() } as never,
      { projectRoot: root, writer },
    );

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(writes).toHaveLength(0);
    expect(result.findings.some((finding) => finding.code === 'RUNTIME.SCHEMA_MISMATCH')).toBe(true);
  });

  it('returns a reconcile error Finding before legacy reducer or persistence', () => {
    const root = makeFixture();
    writeTaskReceipt(root, {
      schema_version: 2,
      action_token: 'vnext-existing',
      mode: 'implement-task',
    });

    const reconciled = reconcile(root);
    const reconcileError = {
      code: 'RUNTIME.SCHEMA_MISMATCH' as const,
      severity: 'error' as const,
      message: 'legacy reconcile rejected TASK_COMPLETE payload schema_version=2',
    };
    const stateWithError: ReconcileStageResult = { ...reconciled, findings: [reconcileError] };
    const writes: Array<{ data: object; options: ReceiptWriterOptions }> = [];
    const writer: ReceiptWriterPort = {
      verifyChain: () => ({ valid: true, receipts: [] }),
      write: (data, options) => {
        writes.push({ data, options });
        return { path: path.join(root, 'fake-receipt.json'), digest: 'b'.repeat(64) };
      },
    };

    const result: AdmitResult = admitWorkerResult(
      {
        type: 'worker_result',
        envelope: { ...legacyWorkerEnvelope(), mode: 'finalize-slice' },
      } as never,
      {
        projectRoot: root,
        reconcile: () => stateWithError,
        reduce: () => {
          throw new Error('reducer must not run after reconcile error');
        },
        writer,
      },
    );

    expect(result).toMatchObject({ accepted: false, receipt_ref: null, new_state: stateWithError });
    expect(result.findings).toEqual([reconcileError]);
    expect(result.findings[0]?.code).not.toBe('DOMAIN.STAGE_NOT_FOUND');
    expect(writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// S08-E-T07 — legacy consumer isolation for every v2 Receipt type. A v2
// payload (TASK_COMPLETE/CV/SLICE_COMMIT/INTEGRATION/GATE/STAGE_REVIEW/plan
// authority) must never enter the legacy reconcile fact derivation, and a
// Slice Receipt chain must never mix v1/v2 facts.
// ---------------------------------------------------------------------------

describe('reconcileStage — every v2 Receipt type stays out of the legacy fact derivation', () => {
  function writeReceiptType(
    root: string,
    category: 'cv' | 'committer' | 'integration' | 'stage-gate' | 'review' | 'plan',
    type: string,
    payload: Record<string, unknown>,
    timestamp = '2026-08-06T00:00:03.000Z',
  ): void {
    const dir =
      category === 'plan'
        ? path.join(root, '.proofloop', 'receipts', category, STAGE_ID)
        : category === 'stage-gate' || category === 'review'
          ? path.join(root, '.proofloop', 'receipts', category, STAGE_ID)
          : path.join(root, '.proofloop', 'receipts', category, STAGE_ID, SLICE_ID);
    fs.mkdirSync(dir, { recursive: true });
    writeReceipt(
      {
        version: 1,
        type: type as never,
        stage_id: STAGE_ID,
        ...(category === 'plan' || category === 'stage-gate' || category === 'review'
          ? {}
          : { slice_id: SLICE_ID }),
        timestamp,
        payload,
      },
      { receiptDir: dir, tempDir: dir },
    );
  }

  it.each([
    ['CV_PASS', 'cv', 'CV_PASS', { schema_version: 2, verdict: 'PASS', summary: 'vnext cv pass' }],
    ['CV_REPAIR', 'cv', 'CV_REPAIR', { schema_version: 2, verdict: 'REPAIR', summary: 'vnext cv repair' }],
    ['SLICE_COMMIT', 'committer', 'SLICE_COMMIT', { schema_version: 2, status: 'committed' }],
    ['INTEGRATION_PASS', 'integration', 'INTEGRATION_PASS', { schema_version: 2, status: 'integrated' }],
    ['GATE_PASS', 'stage-gate', 'GATE_PASS', { schema_version: 2, verdict: 'PASS' }],
    ['STAGE_REVIEW_PASS', 'review', 'STAGE_REVIEW_PASS', { schema_version: 2, verdict: 'ACCEPTED' }],
    ['STAGE_PLAN', 'plan', 'STAGE_PLAN', { schema_version: 2, stage_id: STAGE_ID }],
    ['SPV_PASS', 'plan', 'SPV_PASS', { schema_version: 2, stage_id: STAGE_ID }],
  ] as const)('keeps a v2 %s Receipt out of the legacy fact derivation', (_label, category, type, payload) => {
    const root = makeFixture();
    const before = reconcile(root);
    writeReceiptType(root, category, type, { ...payload });

    const after = reconcile(root);

    expect(stateProjection(after)).toEqual(stateProjection(before));
    expectCompatibilityFinding(after);
    expect(after.receipt_chain_valid).toBe(true);
    const isStageLevel = category === 'plan' || category === 'stage-gate' || category === 'review';
    expect(
      after.receipt_categories.find(
        (entry) => entry.category === category && entry.slice_id === (isStageLevel ? null : SLICE_ID),
      )?.receipt_chain_valid,
    ).toBe(true);
  });

  it('does not derive cv_status from a v2 CV_PASS Receipt', () => {
    const root = makeFixture();
    writeReceiptType(root, 'cv', 'CV_PASS', { schema_version: 2, verdict: 'PASS', summary: 'vnext' });

    const result = reconcile(root);

    expect(result.slices[0]?.cv_status).toBe('NOT_STARTED');
    expect(result.slices[0]?.slice_state).not.toBe('CV_PASSED');
    expectCompatibilityFinding(result);
  });

  it('does not derive committed/integrated facts from v2 SLICE_COMMIT/INTEGRATION_PASS Receipts', () => {
    const root = makeFixture();
    writeReceiptType(root, 'committer', 'SLICE_COMMIT', { schema_version: 2, status: 'committed' });
    writeReceiptType(root, 'integration', 'INTEGRATION_PASS', { schema_version: 2, status: 'integrated' });

    const result = reconcile(root);

    expect(result.slices[0]?.committed).toBe(false);
    expect(result.slices[0]?.integrated).toBe(false);
    expect(result.slices[0]?.slice_state).not.toBe('INTEGRATING');
    expectCompatibilityFinding(result);
  });

  it('does not advance stage_state from a v2 STAGE_PLAN/SPV_PASS authority pair', () => {
    const root = makeFixture();
    const before = reconcile(root);
    writeReceiptType(root, 'plan', 'STAGE_PLAN', { schema_version: 2, stage_id: STAGE_ID });
    writeReceiptType(root, 'plan', 'SPV_PASS', { schema_version: 2, stage_id: STAGE_ID });

    const after = reconcile(root);

    expect(after.stage_state).toBe(before.stage_state);
    expectCompatibilityFinding(after);
  });
});
