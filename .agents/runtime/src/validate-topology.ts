import { RuntimeProofStep } from './schemas.js';

export interface TopologyError {
  type: 'DUPLICATE_STEP_ID' | 'SERVICE_START_WITHOUT_STOP' | 'STOP_REF_MISSING' | 'STOP_BEFORE_START' | 'ALL_STEPS_NOT_APPLICABLE';
  message: string;
}

export function validateRuntimeProofTopology(steps: RuntimeProofStep[]): TopologyError[] {
  const errors: TopologyError[] = [];
  if (steps.length === 0) return errors;

  // 1. Step ID uniqueness
  const seenStepIds = new Set<string>();
  for (const step of steps) {
    if (seenStepIds.has(step.id)) {
      errors.push({ type: 'DUPLICATE_STEP_ID', message: `Duplicate step ID: "${step.id}"` });
    }
    seenStepIds.add(step.id);
  }

  // 2. service_start / service_stop matching
  const serviceStartIds = new Set(
    steps.filter(s => s.type === 'service_start').map(s => s.id),
  );

  const serviceStopInfos = steps
    .filter(s => s.type === 'service_stop')
    .map(s => ({ id: s.id, ref: s.service_ref ?? s.id }));

  for (const startId of serviceStartIds) {
    const hasStop = serviceStopInfos.some(s => s.ref === startId);
    if (!hasStop) {
      errors.push({ type: 'SERVICE_START_WITHOUT_STOP', message: `service_start "${startId}" has no matching service_stop` });
    }
  }

  for (const sInfo of serviceStopInfos) {
    if (!serviceStartIds.has(sInfo.ref)) {
      errors.push({ type: 'STOP_REF_MISSING', message: `service_stop "${sInfo.id}" references non-existent service_start "${sInfo.ref}"` });
    }
    // Check stop doesn't appear before start
    const startIdx = steps.findIndex(s => s.id === sInfo.ref);
    const stopIdx = steps.findIndex(s => s.id === sInfo.id);
    if (startIdx >= 0 && stopIdx >= 0 && stopIdx < startIdx) {
      errors.push({ type: 'STOP_BEFORE_START', message: `service_stop "${sInfo.id}" appears before its service_start "${sInfo.ref}"` });
    }
  }

  return errors;
}
