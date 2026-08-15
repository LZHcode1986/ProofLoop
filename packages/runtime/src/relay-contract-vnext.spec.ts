import { describe, expect, it } from 'vitest';
import {
  assertAdmissionRequest,
  SchemaValidationError,
  validateVNextWorkerResultEnvelope,
  validateWorkerResultEnvelope,
} from '@proofloop/runtime';
import type {
  VNextWorkerResultEnvelope,
  WorkerResultEnvelope,
} from '@proofloop/runtime';

const SHA256 = 'a'.repeat(64);
const SNAPSHOT = 'b'.repeat(40);

const VALID_V1: WorkerResultEnvelope = {
  schemaVersion: 1,
  actionToken: 'v1-action',
  stageId: 'S08',
  sliceId: 'S08-A',
  mode: 'implement-task',
  outcome: 'completed',
  evidenceRef: 'delivery/stages/S08/evidence/S08-A.md',
  changedFiles: ['packages/runtime/src/relay-contract.ts'],
  verificationRuns: [{ commandId: 'tsc', exitCode: 0, logRef: 'temp-log' }],
  summary: 'legacy fixture',
};

const VALID_V2: VNextWorkerResultEnvelope = {
  schemaVersion: 2,
  actionToken: 'v2-action',
  stageId: 'S08',
  sliceId: 'S08-A',
  taskId: 'S08-A-T01',
  mode: 'implement-task',
  outcome: 'completed',
  evidenceRef: 'delivery/stages/S08/evidence/S08-A.md',
  changedFiles: ['packages/runtime/src/relay-contract.ts'],
  verificationRuns: [{ commandId: 'tsc', exitCode: 0, logRef: 'temp-log' }],
  summary: 'vNext fixture',
  manifestDigest: SHA256,
  planDigest: SHA256,
  proofIndexDigest: SHA256,
  snapshotDigest: SNAPSHOT,
  contextRef: `.proofloop/context/${SHA256}.json`,
  contextDigest: SHA256,
};

function failure(fn: () => unknown): SchemaValidationError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(SchemaValidationError);
  return thrown as SchemaValidationError;
}

describe('R1 Worker result contract matrix', () => {
  it('accepts the closed v2 envelope and the v1/v2 AdmissionRequest discriminator', () => {
    expect(validateVNextWorkerResultEnvelope(VALID_V2)).toBe(VALID_V2);
    expect(() => assertAdmissionRequest({ type: 'worker_result', envelope: VALID_V2 })).not.toThrow();
    expect(Object.keys(VALID_V2).sort()).toEqual([
      'actionToken',
      'changedFiles',
      'contextDigest',
      'contextRef',
      'evidenceRef',
      'manifestDigest',
      'mode',
      'outcome',
      'planDigest',
      'proofIndexDigest',
      'schemaVersion',
      'sliceId',
      'snapshotDigest',
      'stageId',
      'summary',
      'taskId',
      'verificationRuns',
    ]);
  });

  it('rejects unknown v2 fields at both contract and request boundaries', () => {
    const envelope = { ...VALID_V2, unknownField: true };
    expect(failure(() => validateVNextWorkerResultEnvelope(envelope)).fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'unknownField' })]),
    );
    expect(failure(() => assertAdmissionRequest({ type: 'worker_result', envelope })).fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'envelope.unknownField' })]),
    );
  });

  it('rejects a missing v2 binding without defaulting or inferring it', () => {
    const { contextDigest: _contextDigest, ...missingBinding } = VALID_V2;
    const error = failure(() => validateVNextWorkerResultEnvelope(missingBinding));
    expect(error.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'contextDigest' })]),
    );
  });

  it('rejects malformed digest lengths and duplicate changed paths', () => {
    const digestError = failure(() =>
      validateVNextWorkerResultEnvelope({ ...VALID_V2, manifestDigest: 'a'.repeat(63) }),
    );
    expect(digestError.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'manifestDigest' })]),
    );

    const duplicatePath = 'packages/runtime/src/relay-contract.ts';
    const duplicateError = failure(() =>
      validateVNextWorkerResultEnvelope({
        ...VALID_V2,
        changedFiles: [duplicatePath, duplicatePath],
      }),
    );
    expect(duplicateError.fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'changedFiles' })]),
    );
  });

  it.each([
    ['stageId', { stageId: '../S08' }],
    ['sliceId', { sliceId: 'S08/A' }],
    ['taskId', { taskId: 'S08 A-T01' }],
    ['mode', { mode: 'legacy-mode' }],
    ['outcome', { outcome: 'success' }],
    ['verificationRuns', { verificationRuns: [{ commandId: 'tsc' }] }],
  ])('rejects an invalid v2 %s', (_field, override) => {
    const error = failure(() =>
      validateVNextWorkerResultEnvelope({ ...VALID_V2, ...override }),
    );
    expect(error.fieldErrors.length).toBeGreaterThan(0);
  });

  it('preserves the v1 optional taskId contract and never widens v1 into v2', () => {
    expect(validateWorkerResultEnvelope(VALID_V1)).toBe(VALID_V1);
    expect(() => assertAdmissionRequest({ type: 'worker_result', envelope: VALID_V1 })).not.toThrow();

    const v1WithV2Fields = { ...VALID_V1, manifestDigest: SHA256 };
    expect(() => validateWorkerResultEnvelope(v1WithV2Fields)).toThrow(SchemaValidationError);
    expect(failure(() => assertAdmissionRequest({
      type: 'worker_result',
      envelope: { ...VALID_V2, schemaVersion: 3 },
    })).fieldErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'envelope.schemaVersion' })]),
    );
  });
});
