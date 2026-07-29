/** Pure Worker packet validation and persisted-task reconciliation. */
/**
 * Return every representation, rather than selecting one by precedence.  A
 * repeated equivalent representation is harmless, but a representation with
 * multiple IDs or a disagreement between representations is not.
 */
function currentTaskRepresentations(packet) {
    const representations = [];
    if (packet.current_task_id !== undefined)
        representations.push([packet.current_task_id]);
    if (packet.current_task_ids !== undefined)
        representations.push([...packet.current_task_ids]);
    if (packet.current_tasks !== undefined)
        representations.push(packet.current_tasks.map(task => task.task_id));
    if (packet.tasks !== undefined)
        representations.push(packet.tasks.map(task => task.task_id));
    return representations;
}
function uniqueIds(representations) {
    return [...new Set(representations.flat())];
}
/**
 * Reconciles persisted declaration-ordered state. No task after the first
 * unchecked task can be selected, even if it appears unchecked too.
 */
export function redispatchFirstUncheckedTask(tasks) {
    const first = tasks.find(task => !task.checked);
    return first ? { action: 'redispatch_first_unchecked_task', task_id: first.task_id } : null;
}
/** The Executor's persisted-state seam for deriving its one redispatch target. */
export const reconcileFirstUncheckedTask = redispatchFirstUncheckedTask;
function expectedTaskId(expectation) {
    if (typeof expectation === 'string')
        return expectation;
    if (Array.isArray(expectation)) {
        return redispatchFirstUncheckedTask(expectation)?.task_id;
    }
    if (expectation !== null && expectation !== undefined && typeof expectation === 'object') {
        return expectation.task_id;
    }
    return undefined;
}
/**
 * Rejects a Worker packet that carries more than one current Task and, when
 * persisted state is supplied, verifies that it is the first unchecked Task.
 * The state overload keeps order validation tied to the Executor's persisted
 * declaration order instead of allowing callers to choose a later task.
 */
export function validateWorkerDispatch(packet, expected) {
    const representations = currentTaskRepresentations(packet);
    const ids = uniqueIds(representations);
    const hasMultipleOrConflictingTasks = representations.length === 0 ||
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
//# sourceMappingURL=dispatch-packets.js.map