/**
 * @proofloop/runtime — successor barrier / dependency-ready task selection
 * (S03-B-T03).
 *
 * Pure predicate/selection seam per contracts.md §4.3 / §5.1 / E2E-19: given
 * the durable task/result facts (consumed read-side through the existing
 * `MesSnapshotStore.read` output) plus the accepted Thin Plan's STABLE task
 * order of the current slice AND a closed CURRENT accepted Plan/work/Git
 * binding input (S03-STAGE-REVIEW-F001), return the FIRST task that is
 * simultaneously incomplete, whose every dependency has a durably accepted
 * output, and whose binding/scope is current (empty list when no candidate
 * exists).
 *
 * A predecessor is "durably accepted" exactly when a durable `result` fact
 * exists for that task (NORMAL result facts are only written for ACCEPTED
 * results — the acceptance barrier writes the fact before the ACK) OR a
 * durable `task` fact with task_status TASK_COMPLETE exists for it (TASK
 * COMPLETE only becomes durable after Brain ACCEPTED + durable write).
 * TASK_RESULT_SUBMITTED / IN_PROGRESS / PLANNED task facts never count:
 * a submitted-but-not-accepted predecessor blocks every successor (fail
 * closed, §4.3: 任何 predecessor 未被 durable 接纳时 successor 不得启动).
 *
 *   - (S03-STAGE-REVIEW-F001) the barrier REQUIRES a closed CURRENT accepted
 *     Plan/work/Git binding input; only scope-consistent facts that EXACTLY
 *     match the current accepted Plan binding (accepted_plan_ref + plan_digest),
 *     and — for predecessors scoped to the CURRENT slice — the current lane
 *     work identity + Git head, are indexed as durably accepted output. A
 *     predecessor bound to an old/non-current Plan, work identity or Git
 *     basis can never unlock a current successor; a missing or malformed
 *     binding input and malformed durable entries produce the typed
 *     `SuccessorBarrierError`.
 *   - cross-slice dependencies (tasks outside the current slice) legitimately
 *     carry their own lane's work identity + Git basis (their own boundary);
 *     they are covered by the accepted-Plan equality only.
 *
 * Selection is deterministic: replay / recovery recomputes the identical
 * result from the same durable facts + task order. The seam produces no
 * next-task directive: the returned list is the pure selection input that
 * Brain running `proofloop-execute` consumes per Step — Brain selects the
 * current dependency-ready Task and only projects that Task's JIT input to the
 * same Worker, which never selects or reorders a successor and never receives a
 * future Task body. Task-order changes and replan classification are S03-F
 * territory, not implemented here.
 *
 * The seam is read-only: it never writes the store and never consults hidden
 * session / conversation / credential chains (fail closed on malformed input
 * via `SuccessorBarrierError`).
 */
import { MES_SLICE_ID_RE, MES_TASK_ID_RE } from '../mes/types';
import type { MesFactEnvelope } from '../mes/types';
import { isExecuteResult, validateMesFactEnvelope } from '../mes/validate';
import { isCanonicalRootRelativeRef } from '../mes/binding';
import { MES_LANE_WORK_ID_RE } from './lane';

/** One stable task-order entry projected from the accepted Thin Plan. */
export interface SliceTaskOrderEntry {
  /** Canonical task id of the current slice (e.g. `S03-B-T01`). */
  readonly taskId: string;
  /** Canonical dependency task ids in accepted-plan order (may cross slices). */
  readonly dependsOnTaskIds: readonly string[];
}

/**
 * Closed CURRENT accepted Plan / lane work / lane Git binding the barrier
 * indexes durable facts against (S03-STAGE-REVIEW-F001 residuals). The lane
 * executing under the current accepted Plan always knows its work identity
 * and Git basis; facts must EXACTLY match this closed binding to count as
 * durably accepted output.
 *
 * The input is TRULY CLOSED (residual closure): only these exact top-level
 * fields are accepted (unknown fields → typed SuccessorBarrierError), the
 * git_basis carries exactly head / branch / worktree, `accepted_plan_ref`
 * must be a canonical root-relative Plan ref, `work_id` a canonical MES lane
 * work identity (grammar owned by lane.ts) whose embedded stage/slice must
 * equal the barrier input sliceId (its own stage prefix) — a canonical-but-
 * foreign work identity fails closed before indexing; `head` a 40-hex SHA,
 * `branch` a
 * non-empty branch name and `worktree` a canonical root-relative path that
 * is NOT the reserved `.git` / `.proofloop` directory itself.
 */
export interface SuccessorBarrierBindingInput {
  /** Exact accepted Plan ref (e.g. `delivery/stages/S03/plan.md`). */
  readonly accepted_plan_ref: string;
  /** Exact accepted Plan digest — facts bound to an old/different plan never count. */
  readonly plan_digest: string;
  /** MES work identity of the current lane (exact match for same-slice facts). */
  readonly work_id: string;
  /** Full Git basis of the current lane (head / branch / worktree). */
  readonly git_basis: {
    readonly head: string;
    readonly branch: string;
    readonly worktree: string;
  };
}

/** Input to the successor barrier. */
export interface SuccessorBarrierInput {
  /** Canonical slice id of the lane (e.g. `S03-B`). */
  readonly sliceId: string;
  /** Stable accepted-Thin-Plan task order of the current slice. */
  readonly taskOrder: readonly SliceTaskOrderEntry[];
  /** Durable facts from MesSnapshotStore.read() (never written here). */
  readonly durableFacts: readonly MesFactEnvelope[];
  /** Closed CURRENT accepted Plan/work/Git binding (REQUIRED). */
  readonly binding: SuccessorBarrierBindingInput;
}

/** Fail-closed typed error for malformed input. */
export class SuccessorBarrierError extends Error {
  public readonly code: 'INVALID_INPUT' = 'INVALID_INPUT';

  constructor(message: string) {
    super(message);
    this.name = 'SuccessorBarrierError';
    Object.setPrototypeOf(this, SuccessorBarrierError.prototype);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function barrierFail(message: string): never {
  throw new SuccessorBarrierError(message);
}

const BINDING_TOP_LEVEL_FIELDS = new Set(['accepted_plan_ref', 'plan_digest', 'work_id', 'git_basis']);
const BINDING_GIT_BASIS_FIELDS = new Set(['head', 'branch', 'worktree']);

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * Canonical, non-reserved root-relative worktree: `.` (repo root) or a
 * clean relative path that is never the reserved `.git` / `.proofloop`
 * directory itself (their subpaths — e.g. real lane worktrees under
 * `.proofloop/worktrees/...` — remain legal).
 */
function isCanonicalWorktreePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value)) return false;
  if (value === '.') return true;
  if (!isCanonicalRootRelativeRef(value)) return false;
  return value !== '.git' && value !== '.proofloop';
}

/** Closed task statuses that mark a durably ACCEPTED output. */
const DURABLE_ACCEPTED_TASK_STATUS = 'TASK_COMPLETE' as const;

/**
 * Select the first dependency-ready task of the current slice.
 *
 * @param input the lane slice id, the accepted-Thin-Plan task order, the
 *   durable facts and the REQUIRED closed CURRENT accepted Plan/work/Git
 *   binding (S03-STAGE-REVIEW-F001) — only facts exactly matching that
 *   binding (plus scope-consistency) may index as durably accepted output.
 * @returns a list containing the first ready task id, or `[]` when no task
 *   is ready (all incomplete candidates are blocked on a predecessor without
 *   durably accepted output).
 * @throws {SuccessorBarrierError} on malformed closed input.
 */
export function selectNextReadyTask(input: SuccessorBarrierInput): string[] {
  if (!isObject(input)) {
    barrierFail('successor barrier input must be an object');
  }
  const { sliceId, taskOrder, durableFacts, binding } = input;

  // 1) Closed input: canonical slice id, ordered array of canonical task
  //    entries without duplicates, canonical dependencies.
  if (typeof sliceId !== 'string' || !MES_SLICE_ID_RE.test(sliceId)) {
    barrierFail(`sliceId must be a canonical Slice ID matching /^S\\d+-[A-Z]+$/ (got ${JSON.stringify(sliceId)})`);
  }
  // 1a) (residual closure) TRULY closed binding input is REQUIRED: only the
  //     exact top-level fields above are accepted, the git_basis is closed to
  //     head / branch / worktree and every value is validated canonically —
  //     unknown fields / malformed values fail with the typed
  //     SuccessorBarrierError BEFORE any indexing.
  if (!isObject(binding)) {
    barrierFail('successor barrier requires a closed binding input (accepted_plan_ref / plan_digest / work_id / git_basis{head,branch,worktree})');
  }
  for (const key of Object.keys(binding)) {
    if (!BINDING_TOP_LEVEL_FIELDS.has(key)) {
      barrierFail(`binding carries an unknown field ${JSON.stringify(key)} (closed binding: accepted_plan_ref / plan_digest / work_id / git_basis only)`);
    }
  }
  const bindingRecord = binding as unknown as SuccessorBarrierBindingInput;
  if (typeof bindingRecord.accepted_plan_ref !== 'string' || !isCanonicalRootRelativeRef(bindingRecord.accepted_plan_ref)) {
    barrierFail(`binding.accepted_plan_ref must be a canonical root-relative Plan ref (got ${JSON.stringify(bindingRecord.accepted_plan_ref)})`);
  }
  if (typeof bindingRecord.plan_digest !== 'string' || !/^[0-9a-f]{64}$/.test(bindingRecord.plan_digest)) {
    barrierFail('binding.plan_digest must be a 64-char lowercase hex SHA-256 digest');
  }
  if (
    typeof bindingRecord.work_id !== 'string' ||
    bindingRecord.work_id.length === 0 ||
    hasControlCharacter(bindingRecord.work_id) ||
    /\s/.test(bindingRecord.work_id) ||
    !MES_LANE_WORK_ID_RE.test(bindingRecord.work_id)
  ) {
    barrierFail(`binding.work_id must be a canonical MES work identity matching /^mes:work:S\d+:S\d+-[A-Z]+(?::.+)?$/ (got ${JSON.stringify(bindingRecord.work_id)})`);
  }
  // (recheck residual S03-STAGE-REVIEW-F001-recheck-1) The binding work
  // identity must be the CURRENT lane's: the stage/slice embedded in the
  // canonical work_id must equal the barrier input sliceId (and its stage
  // prefix) — a canonical-but-foreign work id (mes:work:S02:S03-B:1 →
  // foreign stage; mes:work:S03:S03-A:1 → foreign slice) fails closed with
  // the typed error BEFORE any indexing.
  const workIdMatch = MES_LANE_WORK_ID_RE.exec(bindingRecord.work_id);
  if (workIdMatch === null) {
    barrierFail(`binding.work_id must be a canonical MES work identity (got ${JSON.stringify(bindingRecord.work_id)})`);
  }
  const workIdStage = workIdMatch[1];
  const workIdSlice = workIdMatch[2];
  const sliceIdStage = sliceId.slice(0, sliceId.lastIndexOf('-'));
  if (workIdStage !== sliceIdStage || workIdSlice !== sliceId) {
    barrierFail(`binding.work_id ${JSON.stringify(bindingRecord.work_id)} embeds ${workIdStage}/${workIdSlice}, which must equal the barrier input slice ${sliceIdStage}/${sliceId} (foreign work identity fails closed before indexing)`);
  }
  if (!isObject(bindingRecord.git_basis)) {
    barrierFail('binding.git_basis must be a closed object with exactly head / branch / worktree');
  }
  const gitBasis = bindingRecord.git_basis as unknown as Record<string, unknown>;
  for (const key of Object.keys(gitBasis)) {
    if (!BINDING_GIT_BASIS_FIELDS.has(key)) {
      barrierFail(`binding.git_basis carries an unknown field ${JSON.stringify(key)} (closed git basis: head / branch / worktree only)`);
    }
  }
  if (typeof gitBasis.head !== 'string' || !/^[0-9a-f]{40}$/.test(gitBasis.head)) {
    barrierFail('binding.git_basis.head must be a 40-char lowercase hex commit SHA');
  }
  if (typeof gitBasis.branch !== 'string' || gitBasis.branch.length === 0 || hasControlCharacter(gitBasis.branch)) {
    barrierFail('binding.git_basis.branch must be a non-empty branch name without control characters');
  }
  if (!isCanonicalWorktreePath(gitBasis.worktree)) {
    barrierFail(`binding.git_basis.worktree must be a canonical root-relative path (no absolute / traversal, not the reserved .git or .proofloop dirs) (got ${JSON.stringify(gitBasis.worktree)})`);
  }
  if (!Array.isArray(taskOrder)) {
    barrierFail('taskOrder must be an array of {taskId, dependsOnTaskIds} entries');
  }
  // Re-bind the narrowed array to the closed entry type (Array.isArray would
  // otherwise widen the loop variable to any[]).
  const orderEntries = taskOrder as readonly SliceTaskOrderEntry[];
  if (!Array.isArray(durableFacts)) {
    barrierFail('durableFacts must be an array of MES fact envelopes');
  }
  const seen = new Set<string>();
  for (const entry of orderEntries) {
    if (!isObject(entry) || typeof entry.taskId !== 'string' || !MES_TASK_ID_RE.test(entry.taskId)) {
      barrierFail(`every taskOrder entry must carry a canonical task id matching /^S\d+-[A-Z]+-T\d+$/`);
    }
    // Every taskOrder taskId must belong to the input slice; cross-slice
    // ids are only allowed inside dependsOnTaskIds.
    if (entry.taskId.slice(0, entry.taskId.lastIndexOf('-')) !== sliceId) {
      barrierFail(`taskOrder task ${JSON.stringify(entry.taskId)} must belong to the input slice ${JSON.stringify(sliceId)} (cross-slice ids are only allowed in dependsOnTaskIds)`);
    }
    if (seen.has(entry.taskId)) {
      barrierFail(`duplicate task id ${JSON.stringify(entry.taskId)} in the task order`);
    }
    seen.add(entry.taskId);
    if (!Array.isArray(entry.dependsOnTaskIds)) {
      barrierFail(`task ${JSON.stringify(entry.taskId)} dependsOnTaskIds must be an array of canonical task ids`);
    }
    for (const dep of entry.dependsOnTaskIds as readonly unknown[]) {
      if (typeof dep !== 'string' || !MES_TASK_ID_RE.test(dep)) {
        barrierFail(`task ${JSON.stringify(entry.taskId)} dependency ${JSON.stringify(dep)} is not a canonical task id`);
      }
    }
  }

  // 2) Durable accepted-output index over the facts: a task has durably
  //    accepted output when a durable accepted `result` fact is scoped to it
  //    (is_execute_result — legacy S01 facts never count) or a durable
  //    accepted-bound `task` fact with task_status TASK_COMPLETE is scoped to
  //    it. Everything else (SUBMITTED / IN_PROGRESS / PLANNED) is NOT
  //    accepted output and blocks successors (fail closed).
  //
  //    (S03-STAGE-REVIEW-F001) Only scope-consistent facts that EXACTLY match
  //    the closed CURRENT binding are indexed:
  //      - every indexed fact must bind the current accepted Plan
  //        (binding_stage accepted + accepted_plan_ref + plan_digest EXACT
  //        equality) — a predecessor bound to an old/non-current Plan can
  //        never unlock a current successor;
  //      - predecessors scoped to the CURRENT slice must additionally carry
  //        the current lane work identity + Git head (exact equality) — a
  //        same-slice fact bound to a stale work identity / stale Git basis
  //        is never counted;
  //      - cross-slice predecessors carry their own lane's work + Git basis
  //        (their own boundary) and are covered by the accepted-Plan equality.
  //    (residual closure) EVERY task-scoped durable fact must pass the FULL
  //    closed MES envelope validation (validateMesFactEnvelope) — partial
  //    result/task/finding/disposition/git entries fail with the typed
  //    SuccessorBarrierError instead of being partially indexed on selected
  //    fields, while unrelated non-task-scoped facts (work / git integration /
  //    planning facts) remain handled deterministically.
  const acceptedOutput = new Set<string>();
  const completeByTask = new Set<string>();
  for (const fact of durableFacts) {
    // Fail closed on null / non-object entries: a malformed durable fact
    // must never be silently ignored while others are indexed.
    if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) {
      barrierFail('every durable fact must be a MES fact envelope object (null / non-object entries fail closed)');
    }
    const scope = isObject((fact as { scope?: unknown }).scope)
      ? ((fact as { scope: Record<string, unknown> }).scope)
      : undefined;
    const taskId = scope?.task_id;
    if (typeof taskId !== 'string') continue; // unrelated (work/git/planning...) fact — deterministic skip
    // (residual closure) FULL closed envelope validation for every
    // task-scoped durable fact BEFORE any field is trusted.
    let validated: MesFactEnvelope;
    try {
      validated = validateMesFactEnvelope(fact);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      barrierFail(`durable fact ${JSON.stringify((fact as { fact_id?: unknown }).fact_id)} failed closed MES envelope validation: ${detail}`);
    }
    if (!MES_TASK_ID_RE.test(taskId)) {
      barrierFail(`durable fact scope.task_id ${JSON.stringify(taskId)} is not a canonical task id (malformed durable entry)`);
    }
    const validatedScope = validated.scope;
    if (validatedScope === undefined) continue;
    // Accepted-output facts must be scope-consistent: the stage/slice
    // derived from the canonical task_id must match the fact scope before
    // the fact is indexed (a scope-inconsistent predecessor is never counted
    // as accepted output → its successor stays blocked).
    const derivedStage = taskId.slice(0, taskId.indexOf('-'));
    const derivedSlice = taskId.slice(0, taskId.lastIndexOf('-'));
    if (validatedScope.stage_id !== derivedStage || validatedScope.slice_id !== derivedSlice) continue;
    const pb = isObject(validated.plan_binding) ? validated.plan_binding : undefined;
    const planMatchesCurrent =
      pb !== undefined &&
      pb.binding_stage === 'accepted' &&
      pb.accepted_plan_ref === bindingRecord.accepted_plan_ref &&
      (pb.plan_digest ?? undefined) === bindingRecord.plan_digest;
    if (!planMatchesCurrent) continue; // old/non-current Plan: never counted
    const sameSlice = derivedSlice === sliceId;
    if (sameSlice) {
      const gb = isObject(validated.git_basis) ? validated.git_basis : undefined;
      const laneMatchesCurrent =
        validated.work_id === bindingRecord.work_id &&
        gb !== undefined &&
        gb.head === bindingRecord.git_basis.head;
      if (!laneMatchesCurrent) continue; // stale work / Git basis: never counted
    }
    if (isExecuteResult(validated)) {
      acceptedOutput.add(taskId);
      completeByTask.add(taskId);
      continue;
    }
    if (validated.fact_kind === 'task' && validated.task_status === DURABLE_ACCEPTED_TASK_STATUS) {
      // TASK_COMPLETE is a durably accepted output too: it satisfies both
      // the task's own completeness AND its dependents' dependency check.
      acceptedOutput.add(taskId);
      completeByTask.add(taskId);
    }
  }

  // 3) First incomplete task whose every dependency has a durably accepted
  //    output (in stable accepted-plan order); empty when no candidate.
  for (const entry of orderEntries) {
    if (completeByTask.has(entry.taskId)) continue; // complete — not a candidate
    const allDepsAccepted = entry.dependsOnTaskIds.every((dep) => acceptedOutput.has(dep));
    if (!allDepsAccepted) continue; // successor barrier holds
    return [entry.taskId];
  }
  return [];
}
