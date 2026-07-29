import { buildRepairPacket, type CvFailureReceipt, type PersistedSliceState } from '../src/recovery-packet.js';

const state: PersistedSliceState = {
  completed_task_ids: ['S01-A-T01'],
  task_evidence_refs: { 'S01-A-T01': 'evidence/tasks/S01-A-T01.md' },
  current_slice_evidence_ref: 'evidence/S01-A.md',
  failed_po_ids: ['PO-S01-A-01'],
  counterexamples: ['counterexample-1'],
  required_recheck_scope: ['PO-S01-A-01'],
};
const failure: CvFailureReceipt = {
  receipt_ref: 'cv/repair-001.json',
  verdict: 'REPAIR',
  failed_criterion: 'PO-S01-A-01 failed',
  failure_signature: 'sha256:failure-001',
  failed_po_ids: ['PO-S01-A-01'],
  counterexamples: ['counterexample-1'],
  required_recheck_scope: ['PO-S01-A-01'],
};

describe('fresh repair packet', () => {
  test('is fail-closed when any persisted field is missing', () => {
    const missing = { ...state } as Partial<PersistedSliceState>;
    delete missing.current_slice_evidence_ref;
    expect(() => buildRepairPacket(missing as PersistedSliceState, failure)).toThrow(/current_slice_evidence_ref/);

    const noReceipt = { ...failure } as Partial<CvFailureReceipt>;
    expect(() => buildRepairPacket(state, undefined as unknown as CvFailureReceipt)).toThrow(/cv_failure_receipt/);
  });

  test('contains all persisted facts and preserves the failure receipt and bounded scope', () => {
    const packet = buildRepairPacket(state, failure);
    expect(packet).toEqual({ mode: 'repair', ...state, cv_failure_receipt: failure });
    expect(packet.cv_failure_receipt).toBe(failure);
    expect(packet.required_recheck_scope).toEqual(['PO-S01-A-01']);
    expect('session_id' in packet).toBe(false);
  });

  test.each([
    ['missing receipt reference', { receipt_ref: undefined }],
    ['empty receipt reference', { receipt_ref: '' }],
    ['missing verdict', { verdict: undefined }],
    ['PASS verdict', { verdict: 'PASS' }],
    ['missing failed criterion', { failed_criterion: undefined }],
    ['empty failed criterion', { failed_criterion: ' ' }],
    ['missing failure signature', { failure_signature: undefined }],
    ['empty failure signature', { failure_signature: '' }],
  ])('rejects %s in the immutable failure receipt', (_label, changes) => {
    const malformed = { ...failure, ...changes } as CvFailureReceipt;
    expect(() => buildRepairPacket(state, malformed)).toThrow(/cv_failure_receipt/);
  });

  test('accepts a receipt ID when no receipt reference is present', () => {
    const withId = { ...failure, receipt_ref: undefined, receipt_id: 'cv-repair-001' };
    const packet = buildRepairPacket(state, withId);
    expect(packet.cv_failure_receipt).toBe(withId);
  });

  test('accepts an empty completed task list with exactly empty evidence refs', () => {
    const packet = buildRepairPacket({ ...state, completed_task_ids: [], task_evidence_refs: {} }, failure);
    expect(packet.completed_task_ids).toEqual([]);
    expect(packet.task_evidence_refs).toEqual({});
  });

  test.each([
    ['missing completed task IDs', { completed_task_ids: undefined }],
    ['non-array completed task IDs', { completed_task_ids: 'not-an-array' }],
    ['blank completed task ID', { completed_task_ids: [''] }],
    ['duplicate completed task IDs', { completed_task_ids: ['S01-A-T01', 'S01-A-T01'] }],
  ])('rejects %s', (_label, changes) => {
    expect(() => buildRepairPacket({ ...state, ...changes } as PersistedSliceState, failure))
      .toThrow(/completed_task_ids/);
  });

  test.each([
    ['missing task evidence ref', { task_evidence_refs: {} }],
    ['empty task evidence ref', { task_evidence_refs: { 'S01-A-T01': ' ' } }],
    ['extra task evidence ref', { task_evidence_refs: { 'S01-A-T01': 'task.md', extra: 'extra.md' } }],
  ])('rejects %s', (_label, changes) => {
    expect(() => buildRepairPacket({ ...state, ...changes } as PersistedSliceState, failure))
      .toThrow(/task_evidence_refs/);
  });

  test('rejects an empty current slice evidence reference', () => {
    expect(() => buildRepairPacket({ ...state, current_slice_evidence_ref: ' ' }, failure))
      .toThrow(/current_slice_evidence_ref/);
  });

  test.each([
    ['required recheck scope', { required_recheck_scope: ['unrelated'] }, /scope differs/],
    ['failed proof obligations', { failed_po_ids: ['PO-OTHER'] }, /scope differs/],
    ['counterexamples', { counterexamples: ['different-counterexample'] }, /counterexamples differ/],
  ])('rejects %s that would differ from the immutable failure receipt', (_label, changes, message) => {
    expect(() => buildRepairPacket({ ...state, ...changes } as PersistedSliceState, failure)).toThrow(message);
  });
});
