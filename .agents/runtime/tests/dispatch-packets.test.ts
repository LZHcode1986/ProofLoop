import {
  reconcileFirstUncheckedTask,
  redispatchFirstUncheckedTask,
  validateWorkerDispatch,
  type PersistedTaskState,
} from '../src/dispatch-packets.js';

describe('Worker dispatch packets', () => {
  test('rejects multiple current tasks with the contract result and subtype', () => {
    const result = validateWorkerDispatch({
      mode: 'implement-task',
      slice_id: 'S02-A',
      current_task_ids: ['S02-A-T01', 'S02-A-T02'],
    });
    expect(result).toMatchObject({
      result: 'DISPATCH_MISMATCH',
      subtype: 'MULTIPLE_TASKS_SUPPLIED',
      received_task_ids: ['S02-A-T01', 'S02-A-T02'],
      resume_action: 'redispatch_first_unchecked_task',
    });
  });

  test('cross-checks all populated current-task representations', () => {
    expect(validateWorkerDispatch({
      current_task_id: 'S02-A-T01',
      current_task_ids: ['S02-A-T02'],
      current_tasks: [{ task_id: 'S02-A-T01' }],
      tasks: [{ task_id: 'S02-A-T01' }],
      slice_id: 'S02-A',
    })).toEqual({
      result: 'DISPATCH_MISMATCH',
      subtype: 'MULTIPLE_TASKS_SUPPLIED',
      slice_id: 'S02-A',
      received_task_ids: ['S02-A-T01', 'S02-A-T02'],
      expected: 'exactly_one_current_task',
      resume_action: 'redispatch_first_unchecked_task',
    });
  });

  test('accepts one task when equivalent representations agree', () => {
    expect(validateWorkerDispatch({
      current_task_id: 'S02-A-T01',
      current_task_ids: ['S02-A-T01'],
      current_tasks: [{ task_id: 'S02-A-T01' }],
      tasks: [{ task_id: 'S02-A-T01' }],
    })).toEqual({ result: 'ACCEPTED', task_id: 'S02-A-T01' });
  });

  test('accepts exactly one current task', () => {
    expect(validateWorkerDispatch({ current_task_id: 'S02-A-T01' })).toEqual({
      result: 'ACCEPTED', task_id: 'S02-A-T01',
    });
  });

  test('returns the exact order mismatch and reconciliation action', () => {
    const state: PersistedTaskState[] = [
      { task_id: 'S02-A-T01', checked: true },
      { task_id: 'S02-A-T02', checked: false },
      { task_id: 'S02-A-T03', checked: false },
    ];
    expect(validateWorkerDispatch({
      slice_id: 'S02-A', current_task_id: 'S02-A-T03',
    }, state)).toEqual({
      result: 'DISPATCH_MISMATCH',
      subtype: 'TASK_ORDER_MISMATCH',
      slice_id: 'S02-A',
      expected_task_id: 'S02-A-T02',
      received_task_id: 'S02-A-T03',
      resume_action: 'reconcile_and_redispatch',
    });
  });

  test('reconciles persisted ordered state to exactly the first unchecked task', () => {
    const state: PersistedTaskState[] = [
      { task_id: 'S02-A-T01', checked: true },
      { task_id: 'S02-A-T02', checked: false },
      { task_id: 'S02-A-T03', checked: false },
    ];
    expect(redispatchFirstUncheckedTask(state)).toEqual({
      action: 'redispatch_first_unchecked_task', task_id: 'S02-A-T02',
    });
    expect(reconcileFirstUncheckedTask(state)?.task_id).toBe('S02-A-T02');
    expect(validateWorkerDispatch({ current_task_id: 'S02-A-T02' }, state)).toEqual({
      result: 'ACCEPTED', task_id: 'S02-A-T02',
    });
  });

  test('returns no dispatch when persisted state is complete', () => {
    const complete: PersistedTaskState[] = [{ task_id: 'S02-A-T01', checked: true }];
    expect(redispatchFirstUncheckedTask(complete)).toBeNull();
    expect(reconcileFirstUncheckedTask(complete)).toBeNull();
  });

  test('never selects a later task when an earlier task is unchecked', () => {
    const state: PersistedTaskState[] = [
      { task_id: 'S02-A-T01', checked: false },
      { task_id: 'S02-A-T02', checked: true },
      { task_id: 'S02-A-T03', checked: false },
    ];
    expect(redispatchFirstUncheckedTask(state)).toEqual({
      action: 'redispatch_first_unchecked_task', task_id: 'S02-A-T01',
    });
    expect(validateWorkerDispatch({ current_task_id: 'S02-A-T03' }, state)).toMatchObject({
      result: 'DISPATCH_MISMATCH',
      subtype: 'TASK_ORDER_MISMATCH',
      expected_task_id: 'S02-A-T01',
      received_task_id: 'S02-A-T03',
      resume_action: 'reconcile_and_redispatch',
    });
  });
});
