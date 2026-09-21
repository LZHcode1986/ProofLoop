/**
 * @proofloop/runtime — Worker Task Result envelope closed-set validation seam
 * (S03-B-T01).
 *
 * Pure validation of the Worker Task Result envelope (worker-template Result
 * envelope schema + tech-spec/contracts.md §4.3, E2E-19). The seam is a
 * closed function: it never reads MES facts and never writes the store — the
 * durable write boundary for accepted results stays `MesSnapshotStore.write`
 * (owned by S03-A-T01) and the read-side acceptance mapping is
 * `task-result-ack.ts` (S03-B-T02).
 *
 * Closed field set: executionMode / stageId / sliceId / taskId / outcome /
 * resultRef / changedFiles / verificationRuns / summary / planRef /
 * authorityRefs / gitBasis / actionToken / resultId. Anything else — unknown
 * keys, transport / session metadata (Link message id, pane/session,
 * sent/idle/done), next-action / route / reasoning fields — fails closed
 * (STATIC-08 / FR-014).
 *
 * Failures raise `TaskResultValidationError` carrying a closed §7 outcome:
 *   - `RESULT_INVALID` — unknown keys, control characters, invalid closed
 *     values, out-of-bound paths, NORMAL/bootstrap field violations;
 *   - `RESULT_BINDING_MISMATCH` — malformed git basis (the submitted
 *     basis cannot bind the Result; §4.3 validatedGitBasis).
 *
 * Submitted digest: `result_payload_digest` is computed with the S03-A-T01
 * frozen formula `SHA-256(SPN(result_payload_fields))` (SPN = canonical JSON,
 * keys sorted recursively, arrays keep order, UTF-8) over the semantic
 * payload fields {executionMode, stageId, sliceId, taskId, outcome, resultRef,
 * changedFiles(order), verificationRuns(order), summary, planRef,
 * authorityRefs(canonical-only, order), gitBasis{head,branch,worktree}} with
 * explicit omit = transport/session metadata, resultId (replay key) and
 * actionToken (lane control token). The digest is delivered as part of the
 * normalized result and is later persisted by Brain on the `result` kind fact.
 *
 * Sub-shapes (worker-template): a `task` result carries taskId; `slice-ready`
 * (SLICE_CANDIDATE_READY) and `repair` (taskless) both omit taskId — the
 * closed envelope has no taskId, so both are validated as the single closed
 * taskless shape (`subShape: 'taskless'`); the semantic distinction is
 * carried by the caller, not by extra envelope fields.
 */
import * as crypto from 'node:crypto';
import { CANONICAL_STAGE_ID_RE } from '@proofloop/kernel';
import { canonicalStringify } from '../cli/proofloop-common';
import { MES_SLICE_ID_RE, MES_TASK_ID_RE } from '../mes/types';
import type { MesGitBasis } from '../mes/types';
import {
  isCanonicalRootRelativeRef,
  isCanonicalAuthorityRef,
} from '../mes/binding';
import { MAINTENANCE_LANE_PLAN_REF, MAINTENANCE_LANE_STAGE } from '../mes/maintenance-seam';

/** Closed Worker Task Result execution modes (worker-template). */
export const TASK_RESULT_MODES = ['NORMAL', 'PRE_MES_BOOTSTRAP', 'MES_MAINTENANCE'] as const;
export type TaskResultMode = (typeof TASK_RESULT_MODES)[number];

/**
 * Recovery candidate Plan slice/task grammar for the MES_MAINTENANCE lane
 * (recovery-plan-r3.md slices like S06-R-D with tasks S06-R-D-T01). The
 * lane binds the recovery candidate Plan, not MES canonical identity, so its
 * ids may carry one extra `-[A-Z]+` group. NORMAL / PRE_MES_BOOTSTRAP keep
 * the strict canonical grammar unchanged.
 */
const MAINTENANCE_SLICE_ID_RE = /^S\d+-[A-Z]+(?:-[A-Z]+)?$/;
const MAINTENANCE_TASK_ID_RE = /^S\d+-[A-Z]+(?:-[A-Z]+)?-T\d+$/;

/** Closed Worker Task Result outcomes (worker-template). */
export const TASK_RESULT_OUTCOMES = [
  'completed',
  'blocked',
  'needs-decision',
  'failed',
] as const;
export type TaskResultOutcome = (typeof TASK_RESULT_OUTCOMES)[number];

/** Closed sub-shapes: a per-task result, or a taskless slice-ready/repair result. */
export type TaskResultSubShape = 'task' | 'taskless';


/**
 * Closed MES_MAINTENANCE binding carried by a Task Result (worker-template
 * Result envelope, camelCase canonical fields). Omitted for NORMAL /
 * PRE_MES_BOOTSTRAP; required under MES_MAINTENANCE.
 */
export interface TaskResultMaintenanceBinding {
  readonly frozenSnapshotRef: string;
  readonly frozenSnapshotSha256: string;
  readonly frozenFactCount: number;
  readonly forensicRef: string;
  readonly forensicSha256: string;
  readonly auditRef: string;
  readonly auditSha256: string;
}
/** Closed §7 typed outcomes this seam can raise. */
export type TaskResultValidationCode = 'RESULT_INVALID' | 'RESULT_BINDING_MISMATCH';

/** Per-field error carried by TaskResultValidationError. */
export interface TaskResultFieldError {
  readonly path: string;
  readonly message: string;
}

/** Fail-closed typed error (contracts.md §7: RESULT_INVALID / RESULT_BINDING_MISMATCH). */
export class TaskResultValidationError extends Error {
  public readonly outcome: TaskResultValidationCode;
  public readonly fieldErrors: readonly TaskResultFieldError[];

  constructor(
    outcome: TaskResultValidationCode,
    message: string,
    fieldErrors: readonly TaskResultFieldError[] = [],
  ) {
    super(message);
    this.name = 'TaskResultValidationError';
    this.outcome = outcome;
    this.fieldErrors = fieldErrors;
    Object.setPrototypeOf(this, TaskResultValidationError.prototype);
  }
}

export interface WorkerTaskResultEnvelope {
  readonly executionMode: TaskResultMode;
  readonly stageId: string;
  readonly sliceId: string;
  readonly taskId?: string;
  readonly outcome: TaskResultOutcome;
  readonly resultRef?: string;
  readonly changedFiles: readonly string[];
  readonly verificationRuns: readonly string[];
  readonly summary: string;
  readonly planRef: string;
  readonly authorityRefs: readonly string[];
  readonly gitBasis: MesGitBasis;
  readonly actionToken: string;
  readonly resultId: string;
  /** MES_MAINTENANCE only; omitted for NORMAL / PRE_MES_BOOTSTRAP. */
  readonly maintenanceBinding?: TaskResultMaintenanceBinding;
}

/** The normalized, validated result: closed fields + the submitted digest. */
export interface ValidatedWorkerTaskResult {
  readonly executionMode: TaskResultMode;
  readonly stageId: string;
  readonly sliceId: string;
  readonly taskId?: string;
  readonly outcome: TaskResultOutcome;
  readonly resultRef?: string;
  readonly changedFiles: readonly string[];
  readonly verificationRuns: readonly string[];
  readonly summary: string;
  readonly planRef: string;
  readonly authorityRefs: readonly string[];
  readonly gitBasis: MesGitBasis;
  readonly actionToken: string;
  readonly resultId: string;
  readonly subShape: TaskResultSubShape;
  /** MES_MAINTENANCE only; omitted for NORMAL / PRE_MES_BOOTSTRAP. */
  readonly maintenanceBinding?: TaskResultMaintenanceBinding;
  /** 64-hex SHA-256(SPN(result_payload_fields)) per the S03-A-T01 formula. */
  readonly resultPayloadDigest: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** C0 control / DEL / line/paragraph separator guard (same rule as MES facts). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function validationFail(
  outcome: TaskResultValidationCode,
  message: string,
  fieldErrors: readonly TaskResultFieldError[],
): never {
  throw new TaskResultValidationError(outcome, message, fieldErrors);
}

/**
 * S03-A-T01 frozen submitted-digest formula:
 * `result_payload_digest = SHA-256(SPN(result_payload_fields))` over the
 * semantic payload fields, omitting resultId (replay key) and actionToken
 * (lane control token) and transport/session metadata. `authorityRefs` enters
 * canonical-only (order preserved); absent optional fields are dropped, never
 * null.
 */
export function computeResultPayloadDigest(
  result: ValidatedWorkerTaskResult,
): string {
  const payload: Record<string, unknown> = {
    executionMode: result.executionMode,
    stageId: result.stageId,
    sliceId: result.sliceId,
    outcome: result.outcome,
    changedFiles: result.changedFiles,
    verificationRuns: result.verificationRuns,
    summary: result.summary,
    planRef: result.planRef,
    authorityRefs: result.authorityRefs.filter((ref) => isCanonicalAuthorityRef(ref)),
    gitBasis: {
      head: result.gitBasis.head,
      branch: result.gitBasis.branch,
      worktree: result.gitBasis.worktree,
    },
  };
  if (result.taskId !== undefined) payload.taskId = result.taskId;
  if (result.resultRef !== undefined) payload.resultRef = result.resultRef;
  if (result.maintenanceBinding !== undefined) payload.maintenanceBinding = result.maintenanceBinding;
  const canonical = canonicalStringify(payload);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Validate a submitted Worker Task Result envelope (worker-template + §4.3).
 *
 * @throws {TaskResultValidationError} on any closed-set violation (no partial
 *   acceptance); the normalized result with the submitted digest is returned
 *   otherwise.
 */

/** Closed maintenance binding fields on a Task Result (camelCase). */
const RESULT_MAINTENANCE_BINDING_FIELDS = new Set([
  'frozenSnapshotRef',
  'frozenSnapshotSha256',
  'frozenFactCount',
  'forensicRef',
  'forensicSha256',
  'auditRef',
  'auditSha256',
]);

/**
 * Closed-shape validation of the Result maintenanceBinding (camelCase
 * worker-template fields). Schema-only; any violation pushes a field error
 * and returns undefined.
 */
function validateResultMaintenanceBinding(
  value: unknown,
  errors: TaskResultFieldError[],
): TaskResultMaintenanceBinding | undefined {
  if (!isObject(value)) {
    errors.push({ path: 'result.maintenanceBinding', message: 'Expected a closed object with the frozen/forensic/audit tuple' });
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!RESULT_MAINTENANCE_BINDING_FIELDS.has(key)) {
      errors.push({ path: `result.maintenanceBinding.${key}`, message: `Unknown field "${key}"` });
    }
  }
  for (const refField of ['frozenSnapshotRef', 'forensicRef', 'auditRef'] as const) {
    const ref = value[refField];
    if (typeof ref !== 'string' || ref.length === 0 || hasControlCharacter(ref) || !isCanonicalRootRelativeRef(ref)) {
      errors.push({ path: `result.maintenanceBinding.${refField}`, message: 'Expected a canonical root-relative ref' });
    }
  }
  for (const digestField of ['frozenSnapshotSha256', 'forensicSha256', 'auditSha256'] as const) {
    const digest = value[digestField];
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      errors.push({ path: `result.maintenanceBinding.${digestField}`, message: 'Expected a 64-char lowercase hex sha256' });
    }
  }
  const count = value.frozenFactCount;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
    errors.push({ path: 'result.maintenanceBinding.frozenFactCount', message: 'Expected a positive integer' });
    return undefined;
  }
  return {
    frozenSnapshotRef: value.frozenSnapshotRef as string,
    frozenSnapshotSha256: value.frozenSnapshotSha256 as string,
    frozenFactCount: count,
    forensicRef: value.forensicRef as string,
    forensicSha256: value.forensicSha256 as string,
    auditRef: value.auditRef as string,
    auditSha256: value.auditSha256 as string,
  };
}
export function validateWorkerTaskResult(
  value: unknown,
): ValidatedWorkerTaskResult {
  if (!isObject(value)) {
    validationFail(
      'RESULT_INVALID',
      'Worker Task Result envelope must be an object',
      [],
    );
  }
  const record = value as Record<string, unknown>;
  const errors: TaskResultFieldError[] = [];
  const bindingErrors: TaskResultFieldError[] = [];

  const pushError = (
    list: TaskResultFieldError[],
    path: string,
    message: string,
  ): void => {
    list.push({ path, message });
  };

  // 1) Closed field set — unknown keys (incl. transport/session metadata,
  //    next-action / route / reasoning fields) fail closed.
  const KNOWN_FIELDS = new Set([
    'executionMode',
    'stageId',
    'sliceId',
    'taskId',
    'outcome',
    'resultRef',
    'changedFiles',
    'verificationRuns',
    'summary',
    'planRef',
    'authorityRefs',
    'gitBasis',
    'actionToken',
    'resultId',
    'maintenanceBinding',
  ]);
  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.has(key)) {
      pushError(
        errors,
        `result.${key}`,
        `Unknown field "${key}" — transport/session metadata and next-action/route/reasoning fields are never Result content`,
      );
    }
  }

  // 2) executionMode (top-level discriminator) + outcome (closed).
  const executionMode = record.executionMode;
  if (
    typeof executionMode !== 'string' ||
    !(TASK_RESULT_MODES as readonly string[]).includes(executionMode)
  ) {
    pushError(
      errors,
      'result.executionMode',
      `Expected one of: ${TASK_RESULT_MODES.map((m) => JSON.stringify(m)).join(', ')}`,
    );
  }
  const outcome = record.outcome;
  if (
    typeof outcome !== 'string' ||
    !(TASK_RESULT_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    pushError(
      errors,
      'result.outcome',
      `Expected one of: ${TASK_RESULT_OUTCOMES.map((o) => JSON.stringify(o)).join(', ')}`,
    );
  }

  // 3) Canonical ids.
  const expectCanonical = (
    value: unknown,
    path: string,
    re: RegExp,
    hint: string,
  ): string | undefined => {
    if (!isNonEmptyString(value)) {
      pushError(errors, path, 'Expected a non-empty string');
      return undefined;
    }
    if (!re.test(value)) {
      pushError(errors, path, `Expected ${hint}`);
      return undefined;
    }
    if (hasControlCharacter(value)) {
      pushError(errors, path, 'Must not contain control characters');
      return undefined;
    }
    return value;
  };

  const stageId = expectCanonical(
    record.stageId,
    'result.stageId',
    CANONICAL_STAGE_ID_RE,
    'a canonical Stage ID matching /^S\\d+$/, e.g. S01',
  );
  const sliceId = expectCanonical(
    record.sliceId,
    'result.sliceId',
    executionMode === 'MES_MAINTENANCE' ? MAINTENANCE_SLICE_ID_RE : MES_SLICE_ID_RE,
    'a canonical Slice ID shape like S03-B',
  );
  const taskId =
    record.taskId === undefined
      ? undefined
      : expectCanonical(
          record.taskId,
          'result.taskId',
          executionMode === 'MES_MAINTENANCE' ? MAINTENANCE_TASK_ID_RE : MES_TASK_ID_RE,
          'a canonical Task ID shape like S03-B-T01',
        );

  // 3b) taskId stage/slice closure: a per-task result's taskId must belong
  //     to the envelope stageId/sliceId (cross-scope task ids fail closed).
  //     Taskless shapes (slice-ready / repair) omit taskId but still require
  //     stage/slice closure — stageId/sliceId are always required (3).
  if (taskId !== undefined && stageId !== undefined && sliceId !== undefined) {
    const derivedStage = taskId.slice(0, taskId.indexOf('-'));
    const derivedSlice = taskId.slice(0, taskId.lastIndexOf('-'));
    if (derivedStage !== stageId || derivedSlice !== sliceId) {
      pushError(
        errors,
        'result.taskId',
        `taskId ${JSON.stringify(taskId)} must belong to the envelope stage/slice (${stageId} / ${sliceId}) — cross-scope task ids fail closed`,
      );
    }
  }

  // 4) Opaque lane / replay keys: non-empty, no control characters. The token
  //    is never derived from Link message id / Agent Name / pane / session —
  //    it is opaque input only (contracts §4.3).
  const expectOpaque = (
    value: unknown,
    path: string,
  ): string | undefined => {
    if (!isNonEmptyString(value)) {
      pushError(errors, path, 'Expected a non-empty string');
      return undefined;
    }
    if (hasControlCharacter(value)) {
      pushError(errors, path, 'Must not contain control characters');
      return undefined;
    }
    return value;
  };
  const actionToken = expectOpaque(record.actionToken, 'result.actionToken');
  const resultId = expectOpaque(record.resultId, 'result.resultId');

  // 5) planRef / resultRef — canonical root-relative refs; control chars fail.
  const expectRootRelative = (
    value: unknown,
    path: string,
    label: string,
  ): string | undefined => {
    if (!isNonEmptyString(value)) {
      pushError(errors, path, `Expected a non-empty string`);
      return undefined;
    }
    if (hasControlCharacter(value)) {
      pushError(errors, path, `${label} must not contain control characters`);
      return undefined;
    }
    if (!isCanonicalRootRelativeRef(value)) {
      pushError(
        errors,
        path,
        `${label} must be a canonical root-relative ref (no absolute path, no .., no backslash, no empty segment)`,
      );
      return undefined;
    }
    return value;
  };
  const planRef = expectRootRelative(record.planRef, 'result.planRef', 'planRef');
  if (executionMode === 'MES_MAINTENANCE') {
    if (stageId !== MAINTENANCE_LANE_STAGE) {
      pushError(errors, 'result.stageId', `MES_MAINTENANCE results must carry stageId EXACTLY ${MAINTENANCE_LANE_STAGE} — the maintenance lane is ${MAINTENANCE_LANE_STAGE}-scoped (no lane widening)`);
    }
    if (sliceId !== undefined && stageId !== undefined && !sliceId.startsWith(`${stageId}-`)) {
      pushError(errors, 'result.sliceId', `sliceId ${JSON.stringify(sliceId)} must belong to stage ${stageId} (cross-stage slice fails closed)`);
    }
    if (planRef !== MAINTENANCE_LANE_PLAN_REF) {
      pushError(errors, 'result.planRef', `MES_MAINTENANCE planRef must EXACTLY equal the recovery candidate ${MAINTENANCE_LANE_PLAN_REF} (stale candidate / accepted Plan substitution fails closed)`);
    }
  }
  const resultRef =
    record.resultRef === undefined
      ? undefined
      : expectRootRelative(record.resultRef, 'result.resultRef', 'resultRef');

  // 6) resultRef mode rule: NORMAL requires it, bootstrap forbids it.
  if (executionMode === 'NORMAL' && resultRef === undefined) {
    pushError(
      errors,
      'result.resultRef',
      'NORMAL Task Result requires a root-relative MES resultRef',
    );
  }
  if (executionMode === 'PRE_MES_BOOTSTRAP' && record.resultRef !== undefined) {
    pushError(
      errors,
      'result.resultRef',
      'PRE_MES_BOOTSTRAP Task Result must not carry a MES resultRef (Git-bound Link evidence only)',
    );
  }
  if (executionMode === 'MES_MAINTENANCE' && record.resultRef !== undefined) {
    pushError(
      errors,
      'result.resultRef',
      'MES_MAINTENANCE Task Result must not carry a MES resultRef (Git-bound Link evidence only)',
    );
  }
  // 6b) MES_MAINTENANCE evidence-only closure: maintenanceBinding REQUIRED
  //     under MES_MAINTENANCE, forbidden under NORMAL / PRE_MES_BOOTSTRAP
  //     (no second schema, no smuggling).
  let maintenanceBinding: TaskResultMaintenanceBinding | undefined;
  if (executionMode === 'MES_MAINTENANCE' && record.maintenanceBinding === undefined) {
    pushError(
      errors,
      'result.maintenanceBinding',
      'MES_MAINTENANCE Task Result requires a maintenanceBinding (frozen/forensic/audit exact tuple)',
    );
  } else if (executionMode !== 'MES_MAINTENANCE' && record.maintenanceBinding !== undefined) {
    pushError(
      errors,
      'result.maintenanceBinding',
      'maintenanceBinding is only valid under MES_MAINTENANCE',
    );
  } else if (record.maintenanceBinding !== undefined) {
    maintenanceBinding = validateResultMaintenanceBinding(record.maintenanceBinding, errors);
  }

  // 7) changedFiles / verificationRuns — arrays of canonical root-relative refs.
  const expectPathList = (
    value: unknown,
    path: string,
    label: string,
  ): readonly string[] | undefined => {
    if (!Array.isArray(value)) {
      pushError(errors, path, `${label} must be an array of canonical root-relative refs`);
      return undefined;
    }
    const out: string[] = [];
    value.forEach((entry, index) => {
      if (typeof entry !== 'string' || entry.length === 0) {
        pushError(errors, `${path}[${index}]`, 'Expected a non-empty string');
        return;
      }
      if (hasControlCharacter(entry)) {
        pushError(errors, `${path}[${index}]`, 'Must not contain control characters');
        return;
      }
      if (!isCanonicalRootRelativeRef(entry)) {
        pushError(
          errors,
          `${path}[${index}]`,
          `${label} entries must be canonical root-relative refs (no absolute path, no .., no backslash, no empty segment)`,
        );
        return;
      }
      out.push(entry);
    });
    return out;
  };
  const changedFiles = expectPathList(
    record.changedFiles,
    'result.changedFiles',
    'changedFiles',
  );
  const verificationRuns = expectPathList(
    record.verificationRuns,
    'result.verificationRuns',
    'verificationRuns',
  );

  // 8) summary — non-empty, no control chars.
  const summary = record.summary;
  if (!isNonEmptyString(summary)) {
    pushError(errors, 'result.summary', 'Expected a non-empty summary');
  } else if (hasControlCharacter(summary)) {
    pushError(errors, 'result.summary', 'Summary must not contain control characters');
  }

  // 9) authorityRefs — array of canonical authority refs (<path>#<section>).
  if (!Array.isArray(record.authorityRefs)) {
    pushError(
      errors,
      'result.authorityRefs',
      'authorityRefs must be an array of canonical authority refs',
    );
  } else {
    (record.authorityRefs as unknown[]).forEach((entry, index) => {
      if (!isCanonicalAuthorityRef(entry)) {
        pushError(
          errors,
          `result.authorityRefs[${index}]`,
          'Expected canonical entity ref with a root-relative path: "<path>#<section/entity>"',
        );
      }
    });
  }

  // 10) gitBasis — closed object {head, branch, worktree} (binding element;
  //     malformed basis → RESULT_BINDING_MISMATCH per §7).
  let gitBasis: MesGitBasis | undefined;
  const basis = record.gitBasis;
  if (!isObject(basis)) {
    pushError(
      bindingErrors,
      'result.gitBasis',
      'gitBasis must be an object {head, branch, worktree}',
    );
  } else {
    const GIT_BASIS_FIELDS = new Set(['head', 'branch', 'worktree']);
    for (const key of Object.keys(basis)) {
      if (!GIT_BASIS_FIELDS.has(key)) {
        pushError(
          bindingErrors,
          `result.gitBasis.${key}`,
          `Unknown field "${key}"`,
        );
      }
    }
    const head = basis.head;
    if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) {
      pushError(
        bindingErrors,
        'result.gitBasis.head',
        'Expected a 40-char lowercase hex Git HEAD',
      );
    }
    const branch = basis.branch;
    if (!isNonEmptyString(branch) || hasControlCharacter(branch)) {
      pushError(
        bindingErrors,
        'result.gitBasis.branch',
        'Expected a non-empty branch name without control characters',
      );
    }
    const worktree = basis.worktree;
    if (
      !isNonEmptyString(worktree) ||
      hasControlCharacter(worktree) ||
      !isCanonicalRootRelativeRef(worktree)
    ) {
      pushError(
        bindingErrors,
        'result.gitBasis.worktree',
        'Expected a canonical root-relative worktree path',
      );
    }
    if (bindingErrors.length === 0) {
      gitBasis = { head: head as string, branch: branch as string, worktree: worktree as string };
    }
  }

  // 11) Fail closed: any violation aborts (no partial acceptance).
  if (errors.length > 0) {
    validationFail(
      'RESULT_INVALID',
      `Worker Task Result validation failed: ${errors
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ')}`,
      errors,
    );
  }
  if (bindingErrors.length > 0) {
    validationFail(
      'RESULT_BINDING_MISMATCH',
      `Worker Task Result git basis validation failed: ${bindingErrors
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ')}`,
      bindingErrors,
    );
  }

  const normalized: ValidatedWorkerTaskResult = {
    executionMode: executionMode as TaskResultMode,
    stageId: stageId!,
    sliceId: sliceId!,
    outcome: outcome as TaskResultOutcome,
    changedFiles: changedFiles!,
    verificationRuns: verificationRuns!,
    summary: summary as string,
    planRef: planRef!,
    authorityRefs: (record.authorityRefs as unknown[]).map(String),
    gitBasis: gitBasis!,
    actionToken: actionToken!,
    resultId: resultId!,
    subShape: taskId === undefined ? 'taskless' : 'task',
    ...(taskId !== undefined ? { taskId } : {}),
    ...(resultRef !== undefined ? { resultRef } : {}),
    ...(maintenanceBinding !== undefined ? { maintenanceBinding } : {}),
    resultPayloadDigest: '',
  };

  return {
    ...normalized,
    resultPayloadDigest: computeResultPayloadDigest(normalized),
  };
}
