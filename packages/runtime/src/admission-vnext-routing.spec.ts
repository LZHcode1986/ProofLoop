import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CVStatus, ProjectState, SliceState, StageState } from '@proofloop/kernel';
import type { Manifest, ReceiptWriterOptions } from '@proofloop/kernel';
import { admitWorkerResult } from './admission';
import type { AdmissionDeps } from './admission';
import type { AdmitResult, ReceiptWriterPort } from './admit-pipeline';
import type { ReconcileStageResult } from './reconcile';
import type { VNextWorkerResultEnvelope, WorkerResultEnvelope } from './relay-contract';

const vNextAdmission = vi.hoisted(() => vi.fn());

vi.mock('./vnext/worker-admission', () => ({
  admitVNextWorkerResult: vNextAdmission,
}));

const STAGE_ID = 'S01';
const SLICE_ID = 'S01-A';
const DIGEST_64 = 'a'.repeat(64);

const VALID_LEGACY_MANIFEST: Manifest = {
  stage_id: STAGE_ID,
  source_path: `delivery/stages/${STAGE_ID}/tasks.md`,
  source_digest: DIGEST_64,
  stage_goal: 'legacy v1 fixture',
  outcomes: ['worker admission'],
  slices: [{
    slice_id: SLICE_ID,
    goal: 'legacy v1 slice',
    observable_outcome: 'legacy worker admitted',
    public_seam: '@proofloop/runtime admitWorkerResult',
    dependencies: [],
    proof_obligations: [],
    tasks: ['S01-A-T01'],
    risk_facts: [],
    evidence_path: `delivery/stages/${STAGE_ID}/evidence/${SLICE_ID}.md`,
    cv_minimum_level: 'standard',
  }],
  dependencies: [],
  risk_facts: [],
};

const V2_MANIFEST = {
  version: 2,
  stage_id: STAGE_ID,
  plan: {
    ref: `delivery/stages/${STAGE_ID}/tasks.md`,
    plan_digest: DIGEST_64,
    schema_version: 2,
  },
};

const VALID_V1: WorkerResultEnvelope = {
  schemaVersion: 1,
  actionToken: 'v1-action',
  stageId: STAGE_ID,
  sliceId: SLICE_ID,
  taskId: 'S01-A-T01',
  mode: 'implement-task',
  outcome: 'completed',
  evidenceRef: 'delivery/stages/S01/evidence/S01-A.md',
  changedFiles: ['packages/runtime/src/admission.ts'],
  verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-v1' }],
  summary: 'v1 worker result',
};

const VALID_V2: VNextWorkerResultEnvelope = {
  schemaVersion: 2,
  actionToken: 'v2-action',
  stageId: STAGE_ID,
  sliceId: SLICE_ID,
  taskId: 'S01-A-T01',
  mode: 'implement-task',
  outcome: 'completed',
  evidenceRef: 'delivery/stages/S01/evidence/S01-A.md',
  changedFiles: ['packages/runtime/src/admission.ts'],
  verificationRuns: [{ commandId: 'test', exitCode: 0, logRef: 'log-v2' }],
  summary: 'v2 worker result',
  manifestDigest: DIGEST_64,
  planDigest: 'b'.repeat(64),
  proofIndexDigest: 'c'.repeat(64),
  snapshotDigest: 'd'.repeat(40),
  contextRef: `.proofloop/context/${'e'.repeat(64)}.json`,
  contextDigest: 'e'.repeat(64),
};

const TEMP_ROOTS: string[] = [];

afterEach(() => {
  vNextAdmission.mockReset();
  for (const root of TEMP_ROOTS.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-vnext-routing-'));
  TEMP_ROOTS.push(root);
  return root;
}

function writeDefaultManifest(root: string, content: unknown | string): void {
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${STAGE_ID}.json`);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    typeof content === 'string' ? content : JSON.stringify(content),
    'utf8',
  );
}

function reconciledState(): ReconcileStageResult {
  return {
    stage_id: STAGE_ID,
    slices: [{
      slice_id: SLICE_ID,
      dependencies: [],
      tasks: [],
      slice_state: SliceState.IN_PROGRESS,
      cv_status: CVStatus.NOT_STARTED,
      slice_evidence_finalized: false,
      repair_attempt: 0,
      scope_check_passed: false,
      committed: false,
      integrated: false,
      complete: false,
      latest_cv_receipt: null,
      latest_commit_receipt: null,
    }],
    stage_state: StageState.EXECUTING,
    project_state: ProjectState.IN_PROGRESS,
    receipt_chain: [],
    findings: [],
    receipt_chain_valid: true,
    receipt_categories: [],
  };
}

function fakeDeps(root: string): {
  readonly deps: AdmissionDeps;
  readonly reconcile: ReturnType<typeof vi.fn>;
  readonly writer: ReceiptWriterPort;
  readonly writes: Array<{ data: object; options: ReceiptWriterOptions }>;
  readonly verifies: string[];
} {
  const writes: Array<{ data: object; options: ReceiptWriterOptions }> = [];
  const verifies: string[] = [];
  const writer: ReceiptWriterPort = {
    write(data, options) {
      writes.push({ data, options });
      return { path: path.join(root, 'fake-receipt.json'), digest: DIGEST_64 };
    },
    verifyChain(receiptDir) {
      verifies.push(receiptDir);
      return { valid: true, receipts: [] };
    },
  };
  const reconcile = vi.fn(() => reconciledState());
  writeDefaultManifest(root, VALID_LEGACY_MANIFEST);
  return {
    deps: { projectRoot: root, reconcile, writer },
    reconcile,
    writer,
    writes,
    verifies,
  };
}

function expectSchemaRejection(
  request: unknown,
  fixture: ReturnType<typeof fakeDeps>,
): void {
  let result: AdmitResult | undefined;
  expect(() => {
    result = admitWorkerResult(request as never, fixture.deps);
  }).not.toThrow();
  expect(result).toMatchObject({
    accepted: false,
    receipt_ref: null,
    new_state: null,
  });
  expect(result?.findings[0]).toMatchObject({
    code: 'RUNTIME.SCHEMA_MISMATCH',
    severity: 'error',
  });
  expect(fixture.reconcile).not.toHaveBeenCalled();
  expect(fixture.writes).toHaveLength(0);
  expect(fixture.verifies).toHaveLength(0);
  expect(vNextAdmission).not.toHaveBeenCalled();
}

describe('admitWorkerResult closed validation and explicit vNext routing', () => {
  it('rejects a wrong outer type even when the nested envelope is valid v2', () => {
    const fixture = fakeDeps(tempRoot());

    expectSchemaRejection({ type: 'cv_result', envelope: VALID_V2 }, fixture);
  });

  it.each([
    ['missing envelope', { type: 'worker_result' }],
    ['null envelope', { type: 'worker_result', envelope: null }],
  ])('returns a structured rejection for %s instead of throwing TypeError', (_label, request) => {
    const fixture = fakeDeps(tempRoot());

    expectSchemaRejection(request, fixture);
  });

  it('rejects unknown outer fields before a valid v2 envelope can be routed', () => {
    const fixture = fakeDeps(tempRoot());

    expectSchemaRejection({ type: 'worker_result', envelope: VALID_V2, unexpected: true }, fixture);
  });

  it('rejects an unknown schemaVersion without falling through to v1 or v2', () => {
    const fixture = fakeDeps(tempRoot());

    expectSchemaRejection({
      type: 'worker_result',
      envelope: { ...VALID_V2, schemaVersion: 3 },
    }, fixture);
  });

  it('routes a valid v1 request to the legacy pipeline after validation', () => {
    const fixture = fakeDeps(tempRoot());

    const result = admitWorkerResult({ type: 'worker_result', envelope: VALID_V1 }, fixture.deps);

    expect(result.accepted).toBe(true);
    expect(result.receipt_ref).toBe(DIGEST_64);
    expect(fixture.reconcile).toHaveBeenCalledWith(STAGE_ID);
    expect(fixture.writes).toHaveLength(1);
    expect(vNextAdmission).not.toHaveBeenCalled();
  });

  it.each([
    ['schema-v2', JSON.stringify(V2_MANIFEST)],
    ['unknown', JSON.stringify({ version: 99, stage_id: STAGE_ID })],
    ['malformed', '{"stage_id":'],
  ])('rejects a v1 envelope when the canonical default Manifest is %s', (_label, manifest) => {
    const fixture = fakeDeps(tempRoot());
    writeDefaultManifest(fixture.deps.projectRoot, manifest);

    expectSchemaRejection({ type: 'worker_result', envelope: VALID_V1 }, fixture);
  });

  it('routes a valid v2 request to the vNext consumer after validation', () => {
    const fixture = fakeDeps(tempRoot());
    const routed: AdmitResult = {
      accepted: true,
      receipt_ref: DIGEST_64,
      new_state: null,
      findings: [],
    };
    vNextAdmission.mockReturnValue(routed);

    const result = admitWorkerResult({ type: 'worker_result', envelope: VALID_V2 }, fixture.deps);

    expect(result).toBe(routed);
    expect(vNextAdmission).toHaveBeenCalledWith(VALID_V2, {
      projectRoot: fixture.deps.projectRoot,
      writer: fixture.writer,
    });
    expect(fixture.reconcile).not.toHaveBeenCalled();
    expect(fixture.writes).toHaveLength(0);
  });
});
