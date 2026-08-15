/**
 * admission.spec.ts — S02-E-T01 (PO-S02-E-01 skeleton part)
 *
 * Public seam: `@proofloop/runtime` — the 7-member `AdmissionRequest`
 * discriminated union + the unified admit pipeline `runAdmitPipeline` (the
 * AWI-006 pipeline: request schema validation → reconcile current state →
 * reducer precheck → canonical Receipt construction → kernel `writeReceipt`
 * → post-write chain verification → `{ accepted, receipt_ref, new_state,
 * findings }`).
 *
 * Covered in this task:
 *  1. Schema validation of all 7 request types — valid passes, invalid
 *     variants fail closed with `SchemaValidationError`
 *     (RUNTIME.SCHEMA_MISMATCH) carrying per-field errors; the
 *     `worker_result` envelope reuses the canonical S02-B
 *     `validateWorkerResultEnvelope` seam.
 *  2. The pipeline fails closed on invalid input — a structured rejection
 *     (accepted=false, receipt_ref=null, SCHEMA_MISMATCH finding) and the
 *     writer is never invoked.
 *  3. The pipeline persists receipts ONLY through the injected
 *     `ReceiptWriterPort` (kernel ReceiptWriter by default): a fake writer
 *     proves every write goes through the port, and a static source scan of
 *     `admit-pipeline.ts` proves the module contains no direct file-write
 *     API (mkdir scaffolding and chain-tip reads are the only fs access).
 *  4. Pipeline skeleton behavior: precheck rejection (no Receipt), broken
 *     category chain refusal (RUNTIME.RECEIPT_CHAIN_BROKEN), all-7-types
 *     pipeline runs mapping to the canonical receipt type/category, and
 *     `previous_digest` chain-tip linkage against a REAL fixture directory
 *     written through the kernel ReceiptWriter.
 *
 * Expected values below are known-good literals taken from the authority
 * excerpts (kernel §4/§5/§6/§7, AWI-006) — not derived from the
 * implementation under test.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeReceipt, verifyReceiptChain } from '@proofloop/kernel';
import { StageState, ProjectState } from '@proofloop/kernel';
import type {
  ReceiptType,
  ReceiptWriterOptions,
  WriteReceiptResult,
  ChainVerificationResult,
} from '@proofloop/kernel';
import {
  assertAdmissionRequest,
  runAdmitPipeline,
  ADMISSION_REQUEST_TYPES,
  CV_VERDICTS,
  REVIEW_VERDICTS,
  defaultReceiptWriter,
  admissionRequestStageId,
  admissionRequestSliceId,
  SchemaValidationError,
  type AdmissionRequest,
  type WorkerResultEnvelope,
  type ReconcileStageResult,
  type ReceiptWriterPort,
  type AdmitPipelineSteps,
  type AdmitResult,
} from '@proofloop/runtime';

// ============================================================
// Known-good literals (authority excerpts — never derived)
// ============================================================

const STAGE_ID = 'S02';
const SLICE_ID = 'S02-E';
const FIXED_TIMESTAMP = '2025-01-01T00:00:00.000Z';
const COMMIT_SHA = 'c'.repeat(40);
const CV_RECEIPT_DIGEST = 'd'.repeat(64);
const MANIFEST_DIGEST = 'e'.repeat(64);

const VALID_ENVELOPE: WorkerResultEnvelope = {
  schemaVersion: 1,
  actionToken: 'tok-1',
  stageId: STAGE_ID,
  sliceId: SLICE_ID,
  taskId: 'S02-E-T01',
  mode: 'implement-task',
  outcome: 'completed',
  evidenceRef: 'delivery/stages/S02/evidence/S02-E.md',
  changedFiles: ['packages/runtime/src/admission-request.ts'],
  verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-1' }],
  summary: 'skeleton done',
};

/** One valid request per union member — the 7 AdmissionRequest types. */
function validRequests(): AdmissionRequest[] {
  return [
    { type: 'worker_result', envelope: VALID_ENVELOPE },
    {
      type: 'cv_result',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      verdict: 'PASS',
      snapshotDigest: COMMIT_SHA,
      summary: 'cv pass',
    },
    {
      type: 'slice_commit',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      commitSha: COMMIT_SHA,
      cvReceiptDigest: CV_RECEIPT_DIGEST,
    },
    {
      type: 'integration',
      stageId: STAGE_ID,
      sliceId: SLICE_ID,
      commitSha: COMMIT_SHA,
    },
    { type: 'stage_review', stageId: STAGE_ID, verdict: 'ACCEPTED', summary: 'ok' },
    { type: 'project_review', stageId: STAGE_ID, verdict: 'REPAIR', summary: 'fix' },
    { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST },
  ];
}

/** Invalid variants — one or more per union member (fail-closed matrix). */
const INVALID_VARIANTS: ReadonlyArray<readonly [string, unknown]> = [
  ['worker_result — envelope outcome outside the closed set', {
    type: 'worker_result',
    envelope: { ...VALID_ENVELOPE, outcome: 'bogus' },
  }],
  ['worker_result — envelope stageId violates the identifier charset (path safety)', {
    type: 'worker_result',
    envelope: { ...VALID_ENVELOPE, stageId: '../../evil' },
  }],
  ['worker_result — envelope sliceId violates the identifier charset (path safety)', {
    type: 'worker_result',
    envelope: { ...VALID_ENVELOPE, sliceId: '../S02-E' },
  }],
  ['cv_result — stageId violates the identifier charset (path safety)', {
    type: 'cv_result',
    stageId: '../../evil',
    sliceId: SLICE_ID,
    verdict: 'PASS',
    snapshotDigest: COMMIT_SHA,
    summary: 's',
  }],
  ['cv_result — sliceId violates the identifier charset (path safety)', {
    type: 'cv_result',
    stageId: STAGE_ID,
    sliceId: 'S02/../x',
    verdict: 'PASS',
    snapshotDigest: COMMIT_SHA,
    summary: 's',
  }],
  ['slice_commit — sliceId violates the identifier charset (path safety)', {
    type: 'slice_commit',
    stageId: STAGE_ID,
    sliceId: 'S02..\\evil',
    commitSha: COMMIT_SHA,
    cvReceiptDigest: CV_RECEIPT_DIGEST,
  }],
  ['stage_review — stageId violates the identifier charset (path safety)', {
    type: 'stage_review',
    stageId: '../S02',
    verdict: 'ACCEPTED',
    summary: 's',
  }],
  ['project_review — stageId violates the identifier charset (path safety)', {
    type: 'project_review',
    stageId: 'S 02',
    verdict: 'ACCEPTED',
    summary: 's',
  }],
  ['stage_plan — stageId violates the identifier charset (path safety)', {
    type: 'stage_plan',
    stageId: '../../evil',
    manifestDigest: MANIFEST_DIGEST,
  }],
  ['worker_result — envelope missing entirely', { type: 'worker_result' }],
  ['worker_result — envelope carries an unknown field', {
    type: 'worker_result',
    envelope: { ...VALID_ENVELOPE, extra: 1 },
  }],
  ['worker_result — top-level unknown field', {
    type: 'worker_result',
    envelope: VALID_ENVELOPE,
    stageId: STAGE_ID,
  }],
  ['cv_result — verdict outside {PASS, REPAIR}', {
    type: 'cv_result',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    verdict: 'CONFIRMED',
    snapshotDigest: COMMIT_SHA,
    summary: 's',
  }],
  ['cv_result — snapshot binding missing', {
    type: 'cv_result',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    verdict: 'PASS',
    summary: 's',
  }],
  ['cv_result — unknown field', {
    type: 'cv_result',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    verdict: 'PASS',
    snapshotDigest: COMMIT_SHA,
    summary: 's',
    extra: true,
  }],
  ['slice_commit — commitSha missing', {
    type: 'slice_commit',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    cvReceiptDigest: CV_RECEIPT_DIGEST,
  }],
  ['slice_commit — cvReceiptDigest missing', {
    type: 'slice_commit',
    stageId: STAGE_ID,
    sliceId: SLICE_ID,
    commitSha: COMMIT_SHA,
  }],
  ['integration — sliceId missing', {
    type: 'integration',
    stageId: STAGE_ID,
    commitSha: COMMIT_SHA,
  }],
  ['stage_review — verdict outside {ACCEPTED, REPAIR}', {
    type: 'stage_review',
    stageId: STAGE_ID,
    verdict: 'REJECTED',
    summary: 's',
  }],
  ['project_review — summary missing', {
    type: 'project_review',
    stageId: STAGE_ID,
    verdict: 'ACCEPTED',
  }],
  ['stage_plan — manifestDigest missing', { type: 'stage_plan', stageId: STAGE_ID }],
  ['unknown type discriminant', { type: 'spv_pass', stageId: STAGE_ID }],
  ['non-object input', 'nope'],
  ['null input', null],
];

/** Deterministic reconciled stage state used as the fake reconcile output. */
function fakeReconciledState(stageId: string = STAGE_ID): ReconcileStageResult {
  return {
    stage_id: stageId,
    slices: [],
    stage_state: StageState.EXECUTING,
    project_state: ProjectState.IN_PROGRESS,
    receipt_chain: [],
    findings: [],
    receipt_chain_valid: true,
    receipt_categories: [],
  };
}

// ============================================================
// Fake writer — proves the pipeline persists only through the port
// ============================================================

interface FakeWriterState {
  writeCalls: Array<{ data: Record<string, unknown>; options: ReceiptWriterOptions }>;
  verifyChainCalls: string[];
}

function makeFakeWriter(chainValid = true): { writer: ReceiptWriterPort; state: FakeWriterState } {
  const state: FakeWriterState = { writeCalls: [], verifyChainCalls: [] };
  const writer: ReceiptWriterPort = {
    write(data, options) {
      state.writeCalls.push({ data: data as Record<string, unknown>, options });
      return { path: '/fake/receipts/abc.json', digest: 'fake-digest-64-hex' };
    },
    verifyChain(receiptDir) {
      state.verifyChainCalls.push(receiptDir);
      if (!chainValid) {
        return {
          valid: false,
          receipts: [],
          brokenLink: { index: 0, expected: '(genesis)', actual: '(tampered digest)' },
        };
      }
      return { valid: true, receipts: [] };
    },
  };
  return { writer, state };
}

/** Per-request-type step wiring (receipt type + canonical category dir). */
const SLICE_BOUND_TYPES: ReadonlySet<AdmissionRequest['type']> = new Set([
  'worker_result',
  'cv_result',
  'slice_commit',
  'integration',
]);

const RECEIPT_TYPE_BY_REQUEST: Readonly<Record<AdmissionRequest['type'], ReceiptType>> = {
  worker_result: 'TASK_COMPLETE',
  cv_result: 'CV_PASS',
  slice_commit: 'SLICE_COMMIT',
  integration: 'INTEGRATION_PASS',
  stage_review: 'STAGE_REVIEW_PASS',
  project_review: 'PROJECT_REVIEW_PASS',
  stage_plan: 'STAGE_PLAN',
  spv_result: 'SPV_PASS',
  gate_result: 'GATE_PASS',
  gate_interrupted: 'GATE_INTERRUPTED',
};

function targetDirFor(root: string, type: AdmissionRequest['type']): string {
  switch (type) {
    case 'worker_result': return path.join(root, 'tasks', STAGE_ID, SLICE_ID);
    case 'cv_result': return path.join(root, 'cv', STAGE_ID, SLICE_ID);
    case 'slice_commit': return path.join(root, 'committer', STAGE_ID, SLICE_ID);
    case 'integration': return path.join(root, 'integration', STAGE_ID, SLICE_ID);
    case 'stage_review': return path.join(root, 'review', STAGE_ID);
    case 'project_review': return path.join(root, 'project');
    case 'stage_plan': return path.join(root, 'plan', STAGE_ID);
    case 'spv_result': return path.join(root, 'plan', STAGE_ID);
    case 'gate_result': return path.join(root, 'stage-gate', STAGE_ID);
    case 'gate_interrupted': return path.join(root, 'stage-gate', STAGE_ID);
  }
}

function makeSteps(
  request: AdmissionRequest,
  root: string,
  nextState: ReconcileStageResult = fakeReconciledState(),
): AdmitPipelineSteps {
  return {
    precheck: () => ({ accepted: true, nextState }),
    buildReceipt: () => ({
      type: RECEIPT_TYPE_BY_REQUEST[request.type],
      stage_id: STAGE_ID,
      ...(SLICE_BOUND_TYPES.has(request.type) ? { slice_id: SLICE_ID } : {}),
      timestamp: FIXED_TIMESTAMP,
      payload: { request_type: request.type },
    }),
    targetDir: () => targetDirFor(root, request.type),
  };
}

// ============================================================
// Temp fixture helper
// ============================================================

const TEMP_ROOTS: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-s02e-'));
  TEMP_ROOTS.push(root);
  return root;
}

afterAll(() => {
  for (const root of TEMP_ROOTS) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ============================================================
// 1. Schema validation — the 7 AdmissionRequest types
// ============================================================

describe('AdmissionRequest schema validation (PO-S02-E-01 skeleton)', () => {
  it('closed discriminant set: the 10 canonical request types (7 S02 + SPV/GATE S03 + gate_interrupted S05)', () => {
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
  });

  it('closed verdict sets: CV {PASS, REPAIR} and review {ACCEPTED, REPAIR}', () => {
    expect(CV_VERDICTS).toEqual(['PASS', 'REPAIR']);
    expect(REVIEW_VERDICTS).toEqual(['ACCEPTED', 'REPAIR']);
  });

  it('all 7 valid request types pass assertAdmissionRequest', () => {
    for (const request of validRequests()) {
      expect(() => assertAdmissionRequest(request), `valid ${request.type}`).not.toThrow();
    }
  });

  it('all 7 request types carry a stageId binding readable via admissionRequestStageId', () => {
    for (const request of validRequests()) {
      expect(admissionRequestStageId(request)).toBe(STAGE_ID);
    }
  });

  it('slice-bound request types expose their sliceId; stage-level types return null', () => {
    for (const request of validRequests()) {
      const expected = SLICE_BOUND_TYPES.has(request.type) ? SLICE_ID : null;
      expect(admissionRequestSliceId(request), request.type).toBe(expected);
    }
  });

  it.each(INVALID_VARIANTS)('invalid variant rejected fail-closed: %s', (_label, value) => {
    expect(() => assertAdmissionRequest(value)).toThrow(SchemaValidationError);
    let thrown: unknown;
    try { assertAdmissionRequest(value); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(SchemaValidationError);
    const err = thrown as SchemaValidationError;
    expect(err.code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(err.fieldErrors.length).toBeGreaterThan(0);
    expect(err.message.length).toBeGreaterThan(0);
  });

  it('worker_result reuses the S02-B envelope validator with envelope-prefixed field errors', () => {
    let thrown: unknown;
    try {
      assertAdmissionRequest({
        type: 'worker_result',
        envelope: { ...VALID_ENVELOPE, outcome: 'bogus' },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SchemaValidationError);
    const err = thrown as SchemaValidationError;
    expect(err.fieldErrors.some((fe) => fe.path === 'envelope.outcome')).toBe(true);
  });
});

// ============================================================
// 2. Unified admit pipeline — fail-closed + port-only persistence
// ============================================================

describe('runAdmitPipeline (PO-S02-E-01 pipeline skeleton)', () => {
  it('accepts a valid request: one receipt written through the port, structured result', () => {
    const root = makeTempRoot();
    const { writer, state } = makeFakeWriter();
    const nextState = fakeReconciledState();
    const request: AdmissionRequest = { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST };

    const result = runAdmitPipeline({ request, reconcile: () => fakeReconciledState(), steps: makeSteps(request, root, nextState), writer });

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toBe('fake-digest-64-hex');
    expect(result.new_state).toEqual(nextState);
    expect(result.findings).toEqual([]);
    // Exactly one persistence call, through the port.
    expect(state.writeCalls).toHaveLength(1);
    const data = state.writeCalls[0].data;
    expect(data.version).toBe(1);
    expect(data.type).toBe('STAGE_PLAN');
    expect(data.stage_id).toBe(STAGE_ID);
    expect(data.timestamp).toBe(FIXED_TIMESTAMP);
    expect(data.payload).toEqual({ request_type: 'stage_plan' });
    // The pipeline hands the writer a digest-free receipt — the kernel
    // ReceiptWriter computes the content-addressed digest itself.
    expect(data.digest).toBeUndefined();
    // Empty chain → no previous_digest (genesis linkage).
    expect(data.previous_digest).toBeUndefined();
  });

  it('fails closed on invalid input: structured rejection, no reconcile, no write', () => {
    const { writer, state } = makeFakeWriter();
    let reconcileCalled = false;

    const result = runAdmitPipeline({
      request: { type: 'spv_pass', stageId: STAGE_ID } as unknown as AdmissionRequest,
      reconcile: () => { reconcileCalled = true; return fakeReconciledState(); },
      steps: makeSteps({ type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST }, makeTempRoot()),
      writer,
    });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.new_state).toBeNull();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(result.findings[0].severity).toBe('error');
    expect(reconcileCalled).toBe(false);
    expect(state.writeCalls).toHaveLength(0);
    expect(state.verifyChainCalls).toHaveLength(0);
  });

  it('rejects when the reducer precheck refuses the transition — no Receipt is written', () => {
    const root = makeTempRoot();
    const { writer, state } = makeFakeWriter();
    const state0 = fakeReconciledState();
    const steps: AdmitPipelineSteps = {
      ...makeSteps({ type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST }, root, state0),
      precheck: () => ({
        accepted: false,
        findings: [{
          code: 'DOMAIN.INVALID_TRANSITION',
          severity: 'error',
          message: 'stage S02 is not UNINITIALIZED — STAGE_PLAN admit refused',
        }],
      }),
    };

    const result = runAdmitPipeline({
      request: { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST },
      reconcile: () => state0,
      steps,
      writer,
    });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.new_state).toEqual(state0);
    expect(result.findings[0].code).toBe('DOMAIN.INVALID_TRANSITION');
    // Refused before any chain check or write.
    expect(state.writeCalls).toHaveLength(0);
    expect(state.verifyChainCalls).toHaveLength(0);
  });

  it('refuses to append to a broken category chain (RUNTIME.RECEIPT_CHAIN_BROKEN)', () => {
    const root = makeTempRoot();
    const { writer, state } = makeFakeWriter(false);

    const result = runAdmitPipeline({
      request: { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST },
      reconcile: () => fakeReconciledState(),
      steps: makeSteps({ type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST }, root),
      writer,
    });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.RECEIPT_CHAIN_BROKEN');
    expect(state.verifyChainCalls).toHaveLength(1);
    expect(state.writeCalls).toHaveLength(0);
  });

  it('returns a structured rejection when reconcile fails', () => {
    const { writer, state } = makeFakeWriter();
    const result = runAdmitPipeline({
      request: { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST },
      reconcile: () => { throw new Error('fixture reconcile failure'); },
      steps: makeSteps({ type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST }, makeTempRoot()),
      writer,
    });

    expect(result.accepted).toBe(false);
    expect(result.receipt_ref).toBeNull();
    expect(result.new_state).toBeNull();
    expect(result.findings[0].code).toBe('RUNTIME.SCHEMA_MISMATCH');
    expect(state.writeCalls).toHaveLength(0);
  });

  it('runs the full pipeline for all 7 request types with the canonical receipt binding', () => {
    for (const request of validRequests()) {
      const root = makeTempRoot();
      const { writer, state } = makeFakeWriter();
      const result = runAdmitPipeline({
        request,
        reconcile: () => fakeReconciledState(),
        steps: makeSteps(request, root),
        writer,
      });

      expect(result.accepted, request.type).toBe(true);
      expect(result.receipt_ref, request.type).toBe('fake-digest-64-hex');
      expect(result.findings, request.type).toEqual([]);
      expect(state.writeCalls).toHaveLength(1);
      const data = state.writeCalls[0].data;
      expect(data.type, request.type).toBe(RECEIPT_TYPE_BY_REQUEST[request.type]);
      expect(data.stage_id, request.type).toBe(STAGE_ID);
      const expectedSlice = SLICE_BOUND_TYPES.has(request.type) ? SLICE_ID : undefined;
      expect(data.slice_id, request.type).toBe(expectedSlice);
      // The write lands in the canonical category directory of the receipt type.
      expect(state.verifyChainCalls).toContain(targetDirFor(root, request.type));
    }
  });
});

// ============================================================
// 3. previous_digest linkage against a REAL fixture directory
// ============================================================

describe('previous_digest chain linkage (real fixture directory)', () => {
  it('links the new receipt to the existing category chain tip via the kernel writer', () => {
    const root = makeTempRoot();
    const targetDir = path.join(root, 'plan', STAGE_ID);
    fs.mkdirSync(targetDir, { recursive: true });

    // Seed a genesis STAGE_PLAN receipt through the kernel ReceiptWriter.
    const seeded = writeReceipt(
      {
        version: 1,
        type: 'STAGE_PLAN',
        stage_id: STAGE_ID,
        timestamp: '2024-12-01T00:00:00.000Z',
        payload: { seeded: true },
      },
      { receiptDir: targetDir, tempDir: targetDir },
    );

    const request: AdmissionRequest = { type: 'stage_plan', stageId: STAGE_ID, manifestDigest: MANIFEST_DIGEST };
    const result = runAdmitPipeline({
      request,
      reconcile: () => fakeReconciledState(),
      steps: {
        precheck: () => ({ accepted: true, nextState: fakeReconciledState() }),
        buildReceipt: () => ({
          type: 'STAGE_PLAN',
          stage_id: STAGE_ID,
          timestamp: FIXED_TIMESTAMP,
          payload: { manifest_digest: MANIFEST_DIGEST },
        }),
        targetDir: () => targetDir,
      },
      // Default port = kernel ReceiptWriter + verifyReceiptChain.
    });

    expect(result.accepted).toBe(true);
    // The new receipt is content-addressed — distinct payload ⇒ distinct digest.
    expect(result.receipt_ref).not.toBe(seeded.digest);

    // The full chain is intact and both receipts are linked.
    const chain = verifyReceiptChain(targetDir);
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toHaveLength(2);

    // The new receipt's previous_digest points at the seeded genesis digest.
    const files = fs.readdirSync(targetDir).filter((f) => f.endsWith('.json')).sort();
    const newReceiptRaw = files
      .map((f) => JSON.parse(fs.readFileSync(path.join(targetDir, f), 'utf-8')) as Record<string, unknown>)
      .find((r) => r.digest === result.receipt_ref);
    expect(newReceiptRaw).toBeDefined();
    expect(newReceiptRaw?.previous_digest).toBe(seeded.digest);
    expect(newReceiptRaw?.type).toBe('STAGE_PLAN');
  });
});

// ============================================================
// 4. Port-only persistence — source-level guard + default port
// ============================================================

describe('no direct file writes outside the ReceiptWriterPort (AWI-006)', () => {
  it('admit-pipeline.ts contains no direct file-write API', () => {
    const src = fs.readFileSync(path.join(__dirname, 'admit-pipeline.ts'), 'utf8');
    const banned: ReadonlyArray<readonly [string, string]> = [
      ['writeFileSync', 'writeFileSync'],
      ['writeFile(', 'writeFile('],
      ['appendFileSync', 'appendFileSync'],
      ['appendFile(', 'appendFile('],
      ['createWriteStream', 'createWriteStream'],
      ['copyFileSync', 'copyFileSync'],
      ['renameSync', 'renameSync'],
    ];
    for (const [label, token] of banned) {
      expect(src.includes(token), `admit-pipeline.ts must not call ${label}`).toBe(false);
    }
    // Directory scaffolding (mkdir) and read-only chain-tip resolution are
    // the ONLY fs access — persistence always goes through the port.
    expect(src.includes('mkdirSync')).toBe(true);
  });

  it('admission.ts (the 7 admit methods) contains no direct file-write API', () => {
    // PO-S02-E-01 — the service (admission.ts) must not bypass the unified
    // pipeline with a direct filesystem write. The pipeline source scan
    // alone does not prove the METHODS are clean; the methods themselves are
    // scanned here (S02-E-T05 matrix completion).
    const src = fs.readFileSync(path.join(__dirname, 'admission.ts'), 'utf8');
    const banned: ReadonlyArray<readonly [string, string]> = [
      ['writeFileSync', 'writeFileSync'],
      ['writeFile(', 'writeFile('],
      ['appendFileSync', 'appendFileSync'],
      ['appendFile(', 'appendFile('],
      ['createWriteStream', 'createWriteStream'],
      ['copyFileSync', 'copyFileSync'],
      ['renameSync', 'renameSync'],
    ];
    for (const [label, token] of banned) {
      expect(src.includes(token), `admission.ts must not call ${label}`).toBe(false);
    }
  });

  it('all 7 admit methods route persistence through runAdmitPipeline (single creation path)', () => {
    // PO-S02-E-01 — the unified pipeline is the ONLY Receipt-creation path
    // for the 7 admit methods: every method body is a `return
    // runAdmitPipeline({...})` delegation, and the module contains exactly
    // one such call per method (no other write path exists).
    const src = fs.readFileSync(path.join(__dirname, 'admission.ts'), 'utf8');
    const methodNames = [
      'admitWorkerResult',
      'admitCVResult',
      'admitSliceCommit',
      'admitIntegration',
      'admitStageReview',
      'admitProjectReview',
      'admitStagePlan',
    ];
    for (const name of methodNames) {
      expect(src.includes(`export function ${name}(`), `admission.ts exports ${name}`).toBe(true);
    }
    // Exactly one pipeline invocation per admit method (7 total) — the
    // single creation path is exhaustive for the Stage's 7 admit kinds.
    const pipelineCalls = src.split('runAdmitPipeline({').length - 1;
    expect(pipelineCalls).toBe(7);
  });

  it('every admit method propagates projectRoot to the pipeline (S3-REVIEW-003 rollback containment root)', () => {
    // S3-REVIEW-003: `AdmitPipelineInput.projectRoot` must be passed on EVERY
    // admit call chain (not just SPV/GATE) so the post-write rollback
    // containment always uses the caller's projectRoot as the trust root —
    // never a targetDir substitute. Each of the 7 `runAdmitPipeline({` blocks
    // must contain the standalone `projectRoot: deps.projectRoot,` member.
    const src = fs.readFileSync(path.join(__dirname, 'admission.ts'), 'utf8');
    const blocks = src.split('runAdmitPipeline({').slice(1);
    expect(blocks).toHaveLength(7);
    for (const block of blocks) {
      const member = block.slice(0, block.indexOf('}'));
      expect(
        member.includes('projectRoot: deps.projectRoot,'),
        `every admit method must propagate projectRoot; missing in: ${member.split('\n')[0]}`,
      ).toBe(true);
    }
  });

  it('defaultReceiptWriter delegates to the kernel ReceiptWriter seam (real write + chain verify)', () => {
    const root = makeTempRoot();
    const dir = path.join(root, 'plan', STAGE_ID);
    fs.mkdirSync(dir, { recursive: true });

    const written: WriteReceiptResult = defaultReceiptWriter.write(
      {
        version: 1,
        type: 'STAGE_PLAN',
        stage_id: STAGE_ID,
        timestamp: FIXED_TIMESTAMP,
        payload: { manifest_digest: MANIFEST_DIGEST },
      },
      { receiptDir: dir, tempDir: dir },
    );

    expect(fs.existsSync(written.path)).toBe(true);
    const chain: ChainVerificationResult = defaultReceiptWriter.verifyChain(dir);
    expect(chain.valid).toBe(true);
    expect(chain.receipts).toContain(written.path);
  });
});
