/** Pure Worker packet validation and persisted-task reconciliation. */

export interface WorkerDispatchPacket {
  mode?: string;
  slice_id?: string;
  /** The one task the Worker is being asked to execute. */
  current_task_id?: string;
  current_task_content?: string;
  /** Deliberately distinct from slice_task_ids (which may contain all IDs). */
  current_task_ids?: readonly string[];
  /** Compatibility input for callers that represent current tasks as objects. */
  current_tasks?: readonly { task_id: string }[];
  /** A malformed packet may expose the current tasks under this generic name. */
  tasks?: readonly { task_id: string }[];
  /** Ordered IDs are context, not current task content. */
  slice_task_ids?: readonly string[];
}

export type DispatchMismatchSubtype =
  | 'MULTIPLE_TASKS_SUPPLIED'
  | 'TASK_ORDER_MISMATCH';

export interface DispatchMismatch {
  result: 'DISPATCH_MISMATCH';
  subtype: DispatchMismatchSubtype;
  slice_id?: string;
  received_task_ids?: string[];
  expected?: 'exactly_one_current_task';
  expected_task_id?: string;
  received_task_id?: string;
  resume_action: 'redispatch_first_unchecked_task' | 'reconcile_and_redispatch';
}

export interface AcceptedDispatch {
  result: 'ACCEPTED';
  task_id: string;
}

export type WorkerDispatchValidation = DispatchMismatch | AcceptedDispatch;

/**
 * Return every representation, rather than selecting one by precedence.  A
 * repeated equivalent representation is harmless, but a representation with
 * multiple IDs or a disagreement between representations is not.
 */
function currentTaskRepresentations(packet: WorkerDispatchPacket): string[][] {
  const representations: string[][] = [];
  if (packet.current_task_id !== undefined) representations.push([packet.current_task_id]);
  if (packet.current_task_ids !== undefined) representations.push([...packet.current_task_ids]);
  if (packet.current_tasks !== undefined) representations.push(packet.current_tasks.map(task => task.task_id));
  if (packet.tasks !== undefined) representations.push(packet.tasks.map(task => task.task_id));
  return representations;
}

function uniqueIds(representations: readonly (readonly string[])[]): string[] {
  return [...new Set(representations.flat())];
}

export interface PersistedTaskState {
  task_id: string;
  checked: boolean;
}

export interface FirstUncheckedTask {
  action: 'redispatch_first_unchecked_task';
  task_id: string;
}

/**
 * Reconciles persisted declaration-ordered state. No task after the first
 * unchecked task can be selected, even if it appears unchecked too.
 */
export function redispatchFirstUncheckedTask(
  tasks: readonly PersistedTaskState[],
): FirstUncheckedTask | null {
  const first = tasks.find(task => !task.checked);
  return first ? { action: 'redispatch_first_unchecked_task', task_id: first.task_id } : null;
}

/** The Executor's persisted-state seam for deriving its one redispatch target. */
export const reconcileFirstUncheckedTask = redispatchFirstUncheckedTask;

type DispatchOrderExpectation =
  | string
  | readonly PersistedTaskState[]
  | FirstUncheckedTask
  | null
  | undefined;

function expectedTaskId(expectation: DispatchOrderExpectation): string | undefined {
  if (typeof expectation === 'string') return expectation;
  if (Array.isArray(expectation)) {
    return redispatchFirstUncheckedTask(expectation as readonly PersistedTaskState[])?.task_id;
  }
  if (expectation !== null && expectation !== undefined && typeof expectation === 'object') {
    return (expectation as FirstUncheckedTask).task_id;
  }
  return undefined;
}

/**
 * Rejects a Worker packet that carries more than one current Task and, when
 * persisted state is supplied, verifies that it is the first unchecked Task.
 * The state overload keeps order validation tied to the Executor's persisted
 * declaration order instead of allowing callers to choose a later task.
 */
export function validateWorkerDispatch(
  packet: WorkerDispatchPacket,
  expected?: DispatchOrderExpectation,
): WorkerDispatchValidation {
  const representations = currentTaskRepresentations(packet);
  const ids = uniqueIds(representations);
  const hasMultipleOrConflictingTasks =
    representations.length === 0 ||
    representations.some(representation => representation.length !== 1) ||
    ids.length > 1;

  if (hasMultipleOrConflictingTasks) {
    return {
      result: 'DISPATCH_MISMATCH',
      subtype: 'MULTIPLE_TASKS_SUPPLIED',
      ...(packet.slice_id ? { slice_id: packet.slice_id } : {}),
      received_task_ids: ids,
      expected: 'exactly_one_current_task',
      resume_action: 'redispatch_first_unchecked_task',
    };
  }

  const taskId = ids[0];
  const expectedId = expectedTaskId(expected);
  if (expectedId !== undefined && taskId !== expectedId) {
    return {
      result: 'DISPATCH_MISMATCH',
      subtype: 'TASK_ORDER_MISMATCH',
      ...(packet.slice_id ? { slice_id: packet.slice_id } : {}),
      expected_task_id: expectedId,
      received_task_id: taskId,
      resume_action: 'reconcile_and_redispatch',
    };
  }

  return { result: 'ACCEPTED', task_id: taskId };
}
