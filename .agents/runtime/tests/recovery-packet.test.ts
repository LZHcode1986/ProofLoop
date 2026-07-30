import { buildRepairPacket, buildRecoveryPacket, type CvFailureReceipt, type PersistedSliceState } from '../src/recovery-packet.js';

const state: PersistedSliceState = {
  completed_task_ids: ['S01-A-T01'],
  task_evidence_refs: { 'S01-A-T01': 'evidence/tasks/S01-A-T01.md' },
  current_slice_evidence_ref: 'evidence/S01-A.md',
  failed_po_ids: ['PO-S01-A-01'],
  counterexamples: ['counterexample-1'],
  required_recheck_scope: ['PO-S01-A-01'],
  affected_task_ids: ['S01-A-T01'],
};
const failure: CvFailureReceipt = {
  receipt_ref: 'cv/repair-001.json',
  verdict: 'REPAIR',
  failed_criterion: 'PO-S01-A-01 failed',
  failure_signature: 'sha256:failure-001',
  failed_po_ids: ['PO-S01-A-01'],
  counterexamples: ['counterexample-1'],
  required_recheck_scope: ['PO-S01-A-01'],
  affected_task_ids: ['S01-A-T01'],
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

  test('propagates affected_task_ids from persisted state into the repair packet', () => {
    const packet = buildRepairPacket(state, failure);
    expect(packet.affected_task_ids).toEqual(['S01-A-T01']);
  });

  test('rejects affected_task_ids mismatch when CV receipt contains conflicting order or values', () => {
    const mismatchChanges = {
      stateAffected: ['S01-A-T02'],
      receiptAffected: ['S01-A-T01'],
    };
    expect(() =>
      buildRepairPacket(
        { ...state, affected_task_ids: mismatchChanges.stateAffected } as PersistedSliceState,
        { ...failure, affected_task_ids: mismatchChanges.receiptAffected } as CvFailureReceipt,
      ),
    ).toThrow(/affected_task_ids differ/);
  });

  test('rejects CV receipt without affected_task_ids', () => {
    const { affected_task_ids: _, ...receiptWithoutAffected } = failure as unknown as Record<string, unknown>;
    expect(() =>
      buildRepairPacket(
        { ...state, affected_task_ids: ['S01-A-T02', 'S01-A-T03'] } as PersistedSliceState,
        receiptWithoutAffected as CvFailureReceipt,
      ),
    ).toThrow(/cv_failure_receipt/);
  });

  test('rejects non-array affected_task_ids in persisted state', () => {
    expect(() =>
      buildRepairPacket(
        { ...state, affected_task_ids: 'not-an-array' as unknown as readonly string[] },
        failure,
      ),
    ).toThrow(/affected_task_ids/);
  });

  test('rejects empty CV receipt affected_task_ids that mismatch non-empty persisted state', () => {
    expect(() =>
      buildRepairPacket(
        { ...state, affected_task_ids: ['S01-A-T01'] },
        { ...failure, affected_task_ids: [] } as CvFailureReceipt,
      ),
    ).toThrow(/affected_task_ids differ/);
  });

  test('rejects non-string element in affected_task_ids in persisted state', () => {
    expect(() =>
      buildRepairPacket(
        { ...state, affected_task_ids: [42] as unknown as readonly string[] },
        failure,
      ),
    ).toThrow(/affected_task_ids/);
  });

  test('rejects non-array affected_task_ids in CV receipt', () => {
    expect(() =>
      buildRepairPacket(state, { ...failure, affected_task_ids: 'not-an-array' } as unknown as CvFailureReceipt),
    ).toThrow(/cv_failure_receipt/);
  });

  test('rejects non-string element in CV receipt affected_task_ids', () => {
    expect(() =>
      buildRepairPacket(state, { ...failure, affected_task_ids: [42] } as unknown as CvFailureReceipt),
    ).toThrow(/cv_failure_receipt/);
  });

  test('accepts matching empty affected_task_ids in both state and receipt', () => {
    const packet = buildRepairPacket(
      { ...state, affected_task_ids: [] },
      { ...failure, affected_task_ids: [] } as CvFailureReceipt,
    );
    expect(packet.affected_task_ids).toEqual([]);
  });

  test('accepts receipt affected_task_ids that are order-equal to persisted state', () => {
    const packet = buildRepairPacket(
      { ...state, affected_task_ids: ['S01-A-T02', 'S01-A-T03'] },
      { ...failure, affected_task_ids: ['S01-A-T02', 'S01-A-T03'] } as CvFailureReceipt,
    );
    expect(packet.affected_task_ids).toEqual(['S01-A-T02', 'S01-A-T03']);
  });
});

describe('fresh recovery packet (no CV failure receipt)', () => {
  const recoverParams = {
    completed_task_ids: ['S01-A-T01'],
    task_evidence_refs: { 'S01-A-T01': 'evidence/tasks/S01-A-T01.md' },
    current_slice_evidence_ref: 'evidence/S01-A.md',
    current_task: 'S01-A-T02',
    current_code_snapshot: 'sha256:abc123def456',
  };

  test('builds a recovery packet with all fields populated', () => {
    const packet = buildRecoveryPacket(recoverParams);
    expect(packet.mode).toBe('recover-task');
    expect(packet.completed_task_ids).toEqual(['S01-A-T01']);
    expect(packet.task_evidence_refs).toEqual({ 'S01-A-T01': 'evidence/tasks/S01-A-T01.md' });
    expect(packet.current_slice_evidence_ref).toBe('evidence/S01-A.md');
    expect(packet.current_task).toBe('S01-A-T02');
    expect(packet.current_code_snapshot).toBe('sha256:abc123def456');
    expect('cv_failure_receipt' in packet).toBe(false);
  });

  test('permits empty completed task IDs and empty evidence refs initially', () => {
    const packet = buildRecoveryPacket({
      ...recoverParams,
      completed_task_ids: [],
      task_evidence_refs: {},
    });
    expect(packet.completed_task_ids).toEqual([]);
    expect(packet.task_evidence_refs).toEqual({});
  });

  test('fails for null/undefined params', () => {
    expect(() => buildRecoveryPacket(null as unknown as typeof recoverParams)).toThrow(/recovery packet/);
    expect(() => buildRecoveryPacket(undefined as unknown as typeof recoverParams)).toThrow(/recovery packet/);
  });

  test('fails for missing completed_task_ids', () => {
    const { completed_task_ids: _, ...rest } = recoverParams as unknown as Record<string, unknown>;
    expect(() => buildRecoveryPacket(rest as typeof recoverParams)).toThrow(/completed_task_ids/);
  });

  test('fails for non-array completed_task_ids', () => {
    expect(() => buildRecoveryPacket({ ...recoverParams, completed_task_ids: 'not-an-array' as unknown as readonly string[] }))
      .toThrow(/completed_task_ids/);
  });

  test('fails for blank completed task ID', () => {
    expect(() => buildRecoveryPacket({ ...recoverParams, completed_task_ids: [''] }))
      .toThrow(/completed_task_ids/);
  });

  test('fails for duplicate completed task IDs', () => {
    expect(() => buildRecoveryPacket({ ...recoverParams, completed_task_ids: ['S01-A-T01', 'S01-A-T01'] }))
      .toThrow(/completed_task_ids/);
  });

  test('fails for missing task_evidence_refs', () => {
    const { task_evidence_refs: _, ...rest } = recoverParams as unknown as Record<string, unknown>;
    expect(() => buildRecoveryPacket(rest as typeof recoverParams)).toThrow(/task_evidence_refs/);
  });

  test('fails for inconsistent evidence refs - missing ref for completed task', () => {
    expect(() => buildRecoveryPacket({ ...recoverParams, task_evidence_refs: {} }))
      .toThrow(/task_evidence_refs/);
  });

  test('fails for extra evidence ref not in completed task IDs', () => {
    expect(() => buildRecoveryPacket({ ...recoverParams, task_evidence_refs: { 'S01-A-T01': 'task.md', 'extra': 'extra.md' } }))
      .toThrow(/task_evidence_refs/);
  });

  test('fails for empty task evidence ref value', () => {
    expect(() => buildRecoveryPacket({ ...recoverParams, task_evidence_refs: { 'S01-A-T01': ' ' } }))
      .toThrow(/task_evidence_refs/);
  });

  test('fails for empty current_slice_evidence_ref', () => {
    expect(() => buildRecoveryPacket({ ...recoverParams, current_slice_evidence_ref: '' }))
      .toThrow(/current_slice_evidence_ref/);
    expect(() => buildRecoveryPacket({ ...recoverParams, current_slice_evidence_ref: ' ' }))
      .toThrow(/current_slice_evidence_ref/);
  });

  test('fails for missing/invalid current_task', () => {
    const { current_task: _, ...rest } = recoverParams as unknown as Record<string, unknown>;
    expect(() => buildRecoveryPacket(rest as typeof recoverParams)).toThrow(/current_task/);
    expect(() => buildRecoveryPacket({ ...recoverParams, current_task: '' })).toThrow(/current_task/);
    expect(() => buildRecoveryPacket({ ...recoverParams, current_task: ' ' })).toThrow(/current_task/);
  });

  test('fails for missing/invalid current_code_snapshot', () => {
    const { current_code_snapshot: _, ...rest } = recoverParams as unknown as Record<string, unknown>;
    expect(() => buildRecoveryPacket(rest as typeof recoverParams)).toThrow(/current_code_snapshot/);
    expect(() => buildRecoveryPacket({ ...recoverParams, current_code_snapshot: '' })).toThrow(/current_code_snapshot/);
    expect(() => buildRecoveryPacket({ ...recoverParams, current_code_snapshot: ' ' })).toThrow(/current_code_snapshot/);
  });
});
