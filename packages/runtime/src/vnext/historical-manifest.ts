import type { VNextManifest, VNextExecutionScope } from '@proofloop/kernel';
import type { ReplanPlanSnapshotInput } from './replan-impact';

/** Reconstruct the Manifest projection bound by one persisted Replan previous_snapshot. */
export function buildVNextHistoricalManifest(
  current: VNextManifest,
  previous: ReplanPlanSnapshotInput,
): VNextManifest {
  const taskScopes: Record<string, { task_ref: string; execution_scope: VNextExecutionScope }> = {};
  for (const task of previous.tasks) {
    const descriptor = Object.values(previous.reference_index).find(
      (candidate) => candidate.kind === 'task' && candidate.ref.endsWith(`#/entities/${task.task_id}`),
    );
    taskScopes[task.task_id] = {
      task_ref: descriptor?.ref ?? `#/entities/${task.task_id}`,
      execution_scope: task.execution_scope,
    };
  }
  return {
    ...current,
    stage_id: previous.stage_id,
    plan: { ...current.plan, plan_digest: previous.plan_digest },
    reference_index: previous.reference_index as unknown as VNextManifest['reference_index'],
    task_scopes: taskScopes,
    slices: previous.slices as unknown as VNextManifest['slices'],
    ...(current.binding !== undefined
      ? { binding: { ...current.binding, stage_contract_digest: previous.stage_contract_digest } }
      : {}),
  } as VNextManifest;
}
