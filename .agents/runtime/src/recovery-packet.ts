/** Pure construction of a fresh, fail-closed repair packet from persisted facts. */

export interface CvFailureReceipt {
  /** Stable persisted receipt reference or identifier. */
  receipt_ref?: string;
  receipt_id?: string;
  verdict?: string;
  /** Failure context required to resume the repair flow. */
  failed_criterion?: string;
  failure_signature?: string;
  [key: string]: unknown;
}

export interface PersistedSliceState {
  completed_task_ids: readonly string[];
  task_evidence_refs: Readonly<Record<string, string>>;
  current_slice_evidence_ref: string;
  failed_po_ids: readonly string[];
  counterexamples: readonly string[];
  required_recheck_scope: readonly string[];
  affected_task_ids: readonly string[];
}

export interface RepairDispatchPacket {
  mode: 'repair';
  completed_task_ids: string[];
  task_evidence_refs: Record<string, string>;
  current_slice_evidence_ref: string;
  cv_failure_receipt: CvFailureReceipt;
  failed_po_ids: string[];
  counterexamples: string[];
  required_recheck_scope: string[];
  affected_task_ids: string[];
}

/**
 * Fresh recover-task dispatch packet that occurs before any CV-failure
 * receipt exists.  Contains exactly one current task and a code snapshot
 * instead of a CV failure receipt and repair scope.
 */
export interface RecoveryDispatchPacket {
  mode: 'recover-task';
  completed_task_ids: readonly string[];
  task_evidence_refs: Readonly<Record<string, string>>;
  current_slice_evidence_ref: string;
  current_task: string;
  current_code_snapshot: string;
}

function fail(field: string): never {
  throw new TypeError(`Cannot construct repair packet: missing persisted field "${field}"`);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return fail(field);
  return value;
}

function failRecover(field: string): never {
  throw new TypeError(`Cannot construct recovery packet: missing or invalid field "${field}"`);
}

function nonEmptyRecover(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) return failRecover(field);
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return fail(field);
  return [...value];
}

function completedTaskIds(value: unknown): string[] {
  const result = stringList(value, 'completed_task_ids');
  if (result.some(taskId => taskId.trim().length === 0) || new Set(result).size !== result.length) {
    return fail('completed_task_ids');
  }
  return result;
}

function evidenceRefs(value: unknown, completed: readonly string[]): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('task_evidence_refs');
  const source = value as Record<string, unknown>;
  const completedSet = new Set(completed);
  const result: Record<string, string> = {};
  for (const [taskId, ref] of Object.entries(source)) {
    if (!completedSet.has(taskId) || typeof ref !== 'string' || ref.trim().length === 0) {
      return fail('task_evidence_refs');
    }
    // Define rather than assign so an unusual task ID cannot mutate the result prototype.
    Object.defineProperty(result, taskId, { value: ref, enumerable: true, writable: true, configurable: true });
  }
  for (const taskId of completed) {
    if (!Object.prototype.hasOwnProperty.call(source, taskId)) return fail('task_evidence_refs');
  }
  return result;
}

function receipt(value: unknown): CvFailureReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('cv_failure_receipt');
  const facts = value as Record<string, unknown>;
  const hasReceiptRef = facts.receipt_ref !== undefined;
  const hasReceiptId = facts.receipt_id !== undefined;
  if (hasReceiptRef && (typeof facts.receipt_ref !== 'string' || facts.receipt_ref.trim().length === 0)) {
    return fail('cv_failure_receipt.receipt_ref');
  }
  if (hasReceiptId && (typeof facts.receipt_id !== 'string' || facts.receipt_id.trim().length === 0)) {
    return fail('cv_failure_receipt.receipt_id');
  }
  if (!hasReceiptRef && !hasReceiptId) return fail('cv_failure_receipt.receipt_ref');
  if (typeof facts.verdict !== 'string' || facts.verdict.trim().length === 0 || facts.verdict.trim().toUpperCase() === 'PASS') {
    return fail('cv_failure_receipt.verdict');
  }
  if (typeof facts.failed_criterion !== 'string' || facts.failed_criterion.trim().length === 0) {
    return fail('cv_failure_receipt.failed_criterion');
  }
  if (typeof facts.failure_signature !== 'string' || facts.failure_signature.trim().length === 0) {
    return fail('cv_failure_receipt.failure_signature');
  }
  // fail-closed: affected_task_ids must be present and array-valued
  if (!Array.isArray(facts.affected_task_ids) || facts.affected_task_ids.some((id: unknown) => typeof id !== 'string')) {
    return fail('cv_failure_receipt.affected_task_ids');
  }
  return value as CvFailureReceipt;
}

function sameStrings(left: readonly string[], right: unknown): boolean {
  return Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Constructs only from complete persisted facts.  Failure metadata supplied by
 * the receipt, when present, must agree with persisted scope; this prevents a
 * fresh repair packet from broadening the immutable CV failure.
 */
export function buildRepairPacket(
  state: PersistedSliceState,
  cvFailure: CvFailureReceipt,
): RepairDispatchPacket {
  if (state === null || typeof state !== 'object') return fail('state');
  const completed = completedTaskIds(state.completed_task_ids);
  const refs = evidenceRefs(state.task_evidence_refs, completed);
  const sliceEvidence = nonEmptyString(state.current_slice_evidence_ref, 'current_slice_evidence_ref');
  const failedPoIds = stringList(state.failed_po_ids, 'failed_po_ids');
  const counterexamples = stringList(state.counterexamples, 'counterexamples');
  const scope = stringList(state.required_recheck_scope, 'required_recheck_scope');
  const affectedTaskIds = stringList(state.affected_task_ids, 'affected_task_ids');
  const preservedReceipt = receipt(cvFailure);

  const receiptWithFacts = preservedReceipt as Record<string, unknown>;
  if (receiptWithFacts.failed_po_ids !== undefined && !sameStrings(failedPoIds, receiptWithFacts.failed_po_ids)) {
    throw new TypeError('Cannot construct repair packet: required scope differs from immutable CV failure receipt');
  }
  if (receiptWithFacts.counterexamples !== undefined && !sameStrings(counterexamples, receiptWithFacts.counterexamples)) {
    throw new TypeError('Cannot construct repair packet: counterexamples differ from immutable CV failure receipt');
  }
  if (receiptWithFacts.required_recheck_scope !== undefined && !sameStrings(scope, receiptWithFacts.required_recheck_scope)) {
    throw new TypeError('Cannot construct repair packet: required recheck scope differs from immutable CV failure receipt');
  }
  if (!sameStrings(affectedTaskIds, receiptWithFacts.affected_task_ids)) {
    throw new TypeError('Cannot construct repair packet: affected_task_ids differ from immutable CV failure receipt');
  }

  return {
    mode: 'repair',
    completed_task_ids: completed,
    task_evidence_refs: refs,
    current_slice_evidence_ref: sliceEvidence,
    // Keep the persisted receipt object itself; callers can trace the exact
    // immutable failure receipt rather than a lossy reconstruction.
    cv_failure_receipt: preservedReceipt,
    failed_po_ids: failedPoIds,
    counterexamples,
    required_recheck_scope: scope,
    affected_task_ids: affectedTaskIds,
  };
}

/**
 * Constructs a fresh recovery dispatch packet for a recover-task that
 * occurs before any CV-failure receipt exists.  Requires a valid current
 * task and code snapshot; permits an initially empty completed-task set.
 */
export function buildRecoveryPacket(params: {
  completed_task_ids: readonly string[];
  task_evidence_refs: Readonly<Record<string, string>>;
  current_slice_evidence_ref: string;
  current_task: string;
  current_code_snapshot: string;
}): RecoveryDispatchPacket {
  if (params === null || typeof params !== 'object') return failRecover('params');

  const completed = completedTaskIds(params.completed_task_ids);
  const refs = evidenceRefs(params.task_evidence_refs, completed);
  const sliceEvidence = nonEmptyRecover(params.current_slice_evidence_ref, 'current_slice_evidence_ref');
  const currentTask = nonEmptyRecover(params.current_task, 'current_task');
  const codeSnapshot = nonEmptyRecover(params.current_code_snapshot, 'current_code_snapshot');

  return {
    mode: 'recover-task',
    completed_task_ids: completed,
    task_evidence_refs: refs,
    current_slice_evidence_ref: sliceEvidence,
    current_task: currentTask,
    current_code_snapshot: codeSnapshot,
  };
}
