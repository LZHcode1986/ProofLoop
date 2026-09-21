/**
 * @proofloop/runtime — Slice lane facts, progression and milestone barriers
 * (S03-C-T02).
 *
 * The lane seam is deliberately mechanical and read-only.  It constructs and
 * validates Brain-owned MES envelopes, checks the closed Task transition path,
 * and evaluates the two Execute milestones from supplied facts.  It never
 * writes MES, selects a successor, or persists a token.
 */
import { CANONICAL_STAGE_ID_RE, SchemaValidationError } from '@proofloop/kernel';
import {
  MES_SCHEMA_VERSION,
  MES_SLICE_ID_RE,
  MES_TASK_ID_RE,
  MES_TASK_STATUSES,
} from '../mes/types';
import type {
  MesFactEnvelope,
  MesGitBasis,
  MesPlanBinding,
  MesTaskStatus,
} from '../mes/types';
import { validateMesFactBinding, isCanonicalRootRelativeRef } from '../mes/binding';
import { validateMesFactEnvelope, isExecuteResult } from '../mes/validate';

/** Closed lane milestone names. */
export const LANE_MILESTONES = [
  'SLICE_CANDIDATE_READY',
  'EXECUTION_READY_FOR_REVIEW',
] as const;
export type LaneMilestone = (typeof LANE_MILESTONES)[number];
/** Closed Task statuses owned by the MES contract. */
export const LANE_TASK_STATUSES = MES_TASK_STATUSES;
export const TASK_STATUSES = MES_TASK_STATUSES;

/** Typed fail-closed lane outcomes. */
export type LaneProgressionCode =
  | 'RESULT_INVALID'
  | 'RESULT_BINDING_MISMATCH';

export interface LaneFieldError {
  readonly path: string;
  readonly message: string;
}

/** Error raised by malformed lane facts, illegal transitions or unmet guards. */
export class LaneProgressionError extends Error {
  public readonly code: LaneProgressionCode;
  /** Alias used by Result-style consumers. */
  public readonly outcome: LaneProgressionCode;
  public readonly fieldErrors: readonly LaneFieldError[];

  constructor(
    code: LaneProgressionCode,
    message: string,
    fieldErrors: readonly LaneFieldError[] = [],
  ) {
    super(message);
    this.name = 'LaneProgressionError';
    this.code = code;
    this.outcome = code;
    this.fieldErrors = fieldErrors;
    Object.setPrototypeOf(this, LaneProgressionError.prototype);
  }
}

/** Input accepted by the Work-fact builder (snake_case is the canonical form). */
export interface LaneWorkFactInput {
  readonly fact_id?: string;
  readonly stage_id: string;
  readonly slice_id: string;
  readonly work_id: string;
  readonly authority_refs: readonly string[];
  readonly plan_binding: MesPlanBinding;
  readonly git_basis: MesGitBasis;
  /** Dispatch token is accepted as projection input but never emitted in the fact. */
  readonly actionToken?: string;
}

/** Builder-only camelCase convenience form; output remains the MES shape. */
export interface LaneWorkFactInputCamel {
  readonly factId?: string;
  readonly stageId: string;
  readonly sliceId: string;
  readonly workId: string;
  readonly authorityRefs: readonly string[];
  readonly planBinding: MesPlanBinding;
  readonly gitBasis: MesGitBasis;
  readonly actionToken?: string;
}

/** Completion proof supplied by Brain after ACK + durable Result write. */
export interface TaskCompletionProof {
  /** Brain ACK disposition; must be ACCEPTED. */
  readonly resultDisposition?: unknown;
  /** True only after the corresponding Result is durably written. */
  readonly resultDurable?: unknown;
  /** Accepted-result aliases are supported for mechanical callers. */
  readonly resultAccepted?: unknown;
  readonly durableResult?: unknown;
  readonly acceptedResultRef?: unknown;
  readonly durableFacts?: readonly unknown[];
  readonly ack?: Record<string, unknown>;
}

/** Object form of a Task transition request. */
export interface TaskTransitionInput {
  readonly currentStatus?: MesTaskStatus;
  readonly nextStatus?: MesTaskStatus;
  readonly from?: MesTaskStatus;
  readonly to?: MesTaskStatus;
  readonly completionProof?: TaskCompletionProof;
  readonly resultDisposition?: unknown;
  readonly resultDurable?: unknown;
  readonly resultAccepted?: unknown;
  readonly durableResult?: unknown;
  readonly acceptedResultRef?: unknown;
  readonly durableFacts?: readonly unknown[];
  /**
   * Expected canonical task id for the completion barrier (residual
   * closure): when supplied, a TASK_COMPLETE completion proof's durable
   * result envelope must be scoped to exactly this task.
   */
  readonly taskId?: string;
  readonly task_id?: string;
}

/** Input to the Slice candidate milestone guard. */
export interface SliceCandidateInput {
  readonly plannedTaskIds?: readonly string[];
  readonly taskStatuses?: readonly unknown[];
  readonly durableFacts?: readonly unknown[];
  readonly selfCheckPassed?: boolean;
}

/** Input to the stage execution milestone guard. */
export interface ExecutionReadyForReviewInput {
  readonly plannedSliceIds?: readonly string[];
  readonly plannedSlices?: readonly string[];
  readonly durableFacts: readonly unknown[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function laneFail(
  code: LaneProgressionCode,
  message: string,
  fieldErrors: readonly LaneFieldError[] = [],
): never {
  throw new LaneProgressionError(code, message, fieldErrors);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value)) {
    laneFail('RESULT_INVALID', `${label} must be a non-empty string without control characters`, [
      { path: label, message: 'Expected a non-empty string without control characters' },
    ]);
  }
  return value;
}

function canonicalStage(value: unknown, label: string): string {
  const stage = nonEmptyString(value, label);
  if (!CANONICAL_STAGE_ID_RE.test(stage)) laneFail('RESULT_INVALID', `${label} must be a canonical Stage ID`);
  return stage;
}

function canonicalSlice(value: unknown, label: string): string {
  const slice = nonEmptyString(value, label);
  if (!MES_SLICE_ID_RE.test(slice)) laneFail('RESULT_INVALID', `${label} must be a canonical Slice ID`);
  return slice;
}

function canonicalTask(value: unknown, label: string): string {
  const task = nonEmptyString(value, label);
  if (!MES_TASK_ID_RE.test(task)) laneFail('RESULT_INVALID', `${label} must be a canonical Task ID`);
  return task;
}

function expectArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) laneFail('RESULT_INVALID', `${label} must be an array`);
  return value;
}

function ensureNoUnknownFields(value: Record<string, unknown>, known: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    laneFail(
      'RESULT_INVALID',
      `${label} contains unknown field(s): ${unknown.map((key) => JSON.stringify(key)).join(', ')}`,
      unknown.map((key) => ({ path: `${label}.${key}`, message: `Unknown field "${key}"` })),
    );
  }
}

function rootRelativeWorktree(value: unknown, label: string): string {
  const worktree = nonEmptyString(value, label);
  if (
    worktree !== '.' &&
    (worktree.startsWith('/') || worktree.startsWith('//') || worktree.includes('\\') || /^[A-Za-z]:/.test(worktree) ||
      worktree.split('/').some((part) => part.length === 0 || part === '.' || part === '..'))
  ) {
    laneFail('RESULT_BINDING_MISMATCH', `${label} must be a canonical root-relative worktree path`);
  }
  return worktree;
}

function ensureSliceScope(fact: MesFactEnvelope, label: string): {
  readonly stageId: string;
  readonly sliceId: string;
} {
  const scope = fact.scope;
  if (!isObject(scope)) laneFail('RESULT_BINDING_MISMATCH', `${label} requires a closed scope`);
  const stageId = canonicalStage(scope.stage_id, `${label}.scope.stage_id`);
  const sliceId = canonicalSlice(scope.slice_id, `${label}.scope.slice_id`);
  if (sliceId.slice(0, sliceId.lastIndexOf('-')) !== stageId) {
    laneFail('RESULT_BINDING_MISMATCH', `${label} scope stage/slice mismatch`);
  }
  return { stageId, sliceId };
}

function ensureFactScope(fact: MesFactEnvelope, expectedKind: 'work' | 'task', label: string): {
  readonly stageId: string;
  readonly sliceId: string;
  readonly taskId?: string;
} {
  if (fact.fact_kind !== expectedKind) {
    laneFail('RESULT_INVALID', `${label} must be a ${expectedKind} fact (got ${JSON.stringify(fact.fact_kind)})`);
  }
  const scope = ensureSliceScope(fact, label);
  if (expectedKind === 'work') {
    if (fact.scope?.task_id !== undefined) laneFail('RESULT_INVALID', `${label} lane Work fact must not carry a task scope`);
    return scope;
  }
  const taskId = canonicalTask(fact.scope?.task_id, `${label}.scope.task_id`);
  if (taskId.slice(0, taskId.lastIndexOf('-')) !== scope.sliceId) {
    laneFail('RESULT_BINDING_MISMATCH', `${label} scope task does not belong to its slice`);
  }
  return { ...scope, taskId };
}

/**
 * Canonical MES lane work-identity grammar (single authority; consumed by
 * both this module's lane scope checks and the successor-barrier closed
 * binding validation).
 */
export const MES_LANE_WORK_ID_RE = /^mes:work:(S\d+):(S\d+-[A-Z]+)(?::.+)?$/;

function ensureWorkIdentity(fact: MesFactEnvelope, scope: { readonly stageId: string; readonly sliceId: string }, label: string): void {
  const workId = nonEmptyString(fact.work_id, `${label}.work_id`);
  // Work IDs are opaque, but the canonical MES lane form carries its scope.
  // When that form is used, a mismatching Stage/Slice is a binding error;
  // arbitrary opaque IDs remain valid for older planning identities.
  const match = MES_LANE_WORK_ID_RE.exec(workId);
  if (match !== null && (match[1] !== scope.stageId || match[2] !== scope.sliceId)) {
    laneFail('RESULT_BINDING_MISMATCH', `${label}.work_id is bound to ${match[1]}/${match[2]}, not ${scope.stageId}/${scope.sliceId}`);
  }
}

function ensureNormalAcceptedBinding(fact: MesFactEnvelope, label: string): void {
  if (!isObject(fact.plan_binding) || fact.plan_binding.binding_stage !== 'accepted') {
    laneFail('RESULT_BINDING_MISMATCH', `${label} must bind an accepted Plan`);
  }
  if (!isObject(fact.git_basis)) laneFail('RESULT_BINDING_MISMATCH', `${label} requires a Git basis`);
  const head = fact.git_basis.head;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) {
    laneFail('RESULT_BINDING_MISMATCH', `${label}.git_basis.head must be a 40-char lowercase Git SHA`);
  }
  nonEmptyString(fact.git_basis.branch, `${label}.git_basis.branch`);
  rootRelativeWorktree(fact.git_basis.worktree, `${label}.git_basis.worktree`);
}

function validateEnvelopeOrLaneError(value: unknown, label: string): MesFactEnvelope {
  try {
    return validateMesFactEnvelope(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const fieldErrors = error instanceof SchemaValidationError ? error.fieldErrors : [];
    laneFail('RESULT_INVALID', `${label} failed MES envelope validation: ${detail}`, fieldErrors);
  }
}

/**
 * Validate a lane-start Work fact.  A Work fact is NORMAL/MES-owned, scoped to
 * exactly one Stage and Slice, and deliberately has no action token field.
 */
export function validateLaneWorkFact(value: unknown): MesFactEnvelope {
  const fact = validateEnvelopeOrLaneError(value, 'lane Work fact');
  const scope = ensureFactScope(fact, 'work', 'lane Work fact');
  ensureNormalAcceptedBinding(fact, 'lane Work fact');
  if (fact.created_by !== 'brain') laneFail('RESULT_INVALID', 'lane Work fact must be created_by brain');
  ensureWorkIdentity(fact, scope, 'lane Work fact');
  if (fact.work_id === undefined) laneFail('RESULT_BINDING_MISMATCH', 'lane Work fact requires a work_id');
  nonEmptyString(fact.work_id, 'lane Work fact.work_id');

  // Re-run the canonical fact-kind binding seam with its explicit NORMAL mode;
  // this verifies the same source facts without adding a second persistence
  // path.  `action_token` is rejected by that seam for a work fact.
  try {
    validateMesFactBinding({
      fact_kind: 'work',
      execution_mode: 'NORMAL',
      authority_refs: fact.authority_refs,
      scope: fact.scope,
      work_id: fact.work_id,
      plan_binding: fact.plan_binding,
      git_basis: fact.git_basis,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const fieldErrors = error instanceof SchemaValidationError ? error.fieldErrors : [];
    laneFail('RESULT_BINDING_MISMATCH', `lane Work fact binding failed: ${detail}`, fieldErrors);
  }
  return {
    ...fact,
    scope: { stage_id: scope.stageId, slice_id: scope.sliceId },
  };
}

function readInputField(
  input: Record<string, unknown>,
  snake: string,
  camel: string,
): unknown {
  return Object.prototype.hasOwnProperty.call(input, snake) ? input[snake] : input[camel];
}

/**
 * Construct a canonical lane-start Work fact.  The function accepts either the
 * snake_case builder form or a camelCase convenience form, but its result is
 * always the closed MES envelope and never carries actionToken.
 */
export function buildLaneWorkFact(value: unknown): MesFactEnvelope {
  const input = isObject(value) ? value : undefined;
  if (input === undefined) laneFail('RESULT_INVALID', 'lane Work fact input must be an object');

  // A caller may hand us an already assembled envelope; validate it rather
  // than copying or repairing its fields.
  if (Object.prototype.hasOwnProperty.call(input, 'schema_version') || Object.prototype.hasOwnProperty.call(input, 'fact_kind')) {
    return validateLaneWorkFact(input);
  }

  const allowed = new Set([
    'fact_id', 'factId', 'stage_id', 'stageId', 'slice_id', 'sliceId', 'work_id', 'workId',
    'authority_refs', 'authorityRefs', 'plan_binding', 'planBinding', 'git_basis', 'gitBasis',
    'actionToken',
  ]);
  ensureNoUnknownFields(input, allowed, 'lane Work fact input');
  if (Object.prototype.hasOwnProperty.call(input, 'actionToken')) nonEmptyString(input.actionToken, 'lane Work fact.actionToken');

  const stageId = canonicalStage(readInputField(input, 'stage_id', 'stageId'), 'lane Work fact.stage_id');
  const sliceId = canonicalSlice(readInputField(input, 'slice_id', 'sliceId'), 'lane Work fact.slice_id');
  if (sliceId.slice(0, sliceId.lastIndexOf('-')) !== stageId) {
    laneFail('RESULT_BINDING_MISMATCH', 'lane Work fact stage_id and slice_id do not match');
  }
  const workId = nonEmptyString(readInputField(input, 'work_id', 'workId'), 'lane Work fact.work_id');
  const suppliedFactId = readInputField(input, 'fact_id', 'factId');
  const factId = suppliedFactId === undefined
    ? workId.startsWith('mes:work:')
      ? workId.replace(/^mes:work:/, 'mes:fact:work:')
      : `mes:fact:work:${stageId}:${sliceId}:${workId}`
    : nonEmptyString(suppliedFactId, 'lane Work fact.fact_id');

  const envelope = {
    schema_version: MES_SCHEMA_VERSION,
    fact_id: factId,
    fact_kind: 'work' as const,
    created_by: 'brain' as const,
    authority_refs: readInputField(input, 'authority_refs', 'authorityRefs'),
    scope: { stage_id: stageId, slice_id: sliceId },
    work_id: workId,
    plan_binding: readInputField(input, 'plan_binding', 'planBinding'),
    git_basis: readInputField(input, 'git_basis', 'gitBasis'),
  };
  return validateLaneWorkFact(envelope);
}

/** Validate a durable Task status fact and its task/slice closure. */
export function validateTaskFact(value: unknown): MesFactEnvelope {
  const fact = validateEnvelopeOrLaneError(value, 'Task fact');
  const scope = ensureFactScope(fact, 'task', 'Task fact');
  ensureNormalAcceptedBinding(fact, 'Task fact');
  if (fact.created_by !== 'brain') laneFail('RESULT_INVALID', 'Task fact must be created_by brain');
  ensureWorkIdentity(fact, scope, 'Task fact');
  if (fact.work_id === undefined) laneFail('RESULT_BINDING_MISMATCH', 'Task fact requires a work_id');
  if (typeof fact.task_status !== 'string' || !(MES_TASK_STATUSES as readonly string[]).includes(fact.task_status)) {
    laneFail('RESULT_INVALID', 'Task fact carries an unknown task_status');
  }
  if (!Array.isArray(fact.depends_on_task_ids)) laneFail('RESULT_INVALID', 'Task fact requires depends_on_task_ids');
  return {
    ...fact,
    scope: { stage_id: scope.stageId, slice_id: scope.sliceId, task_id: scope.taskId },
  };
}

function proofObject(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined;
  return value;
}

function getProofValue(proof: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(proof, key)) return proof[key];
  }
  return undefined;
}

/**
 * Closed Execute result-ref grammar: canonical MES durable refs are always
 * `mes:result:<...>` (root-relative MES namespace, no control/whitespace). A
 * caller-supplied partial object like `{fact_kind:'result', result_ref:'fake'}`
 * can never satisfy this grammar (S03-STAGE-REVIEW-F001).
 */
function isCanonicalExecuteResultRef(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('mes:result:') || value.length <= 'mes:result:'.length) return false;
  if (hasControlCharacter(value)) return false;
  return isCanonicalRootRelativeRef(value);
}

/**
 * A FULLY VALIDATED durable Execute result envelope (S03-STAGE-REVIEW-F001):
 * the supplied object must pass the closed MES envelope validator, be a
 * `result`-kind fact that is an EXECUTE result (legacy S01 results are never a
 * completion proof), carry a canonical `mes:result:` result_ref and a
 * canonical task scope. A caller-supplied partial pseudo-envelope
 * (`{fact_kind:'result', result_ref:'fake'}`) fails envelope validation and
 * returns `undefined` — it can never satisfy TASK_COMPLETE.
 */
function validatedExecuteResultEnvelope(value: unknown): MesFactEnvelope | undefined {
  if (!isObject(value)) return undefined;
  let fact: MesFactEnvelope;
  try {
    fact = validateMesFactEnvelope(value);
  } catch {
    return undefined;
  }
  if (fact.fact_kind !== 'result' || !isExecuteResult(fact)) return undefined;
  const scope = isObject(fact.scope) ? fact.scope : undefined;
  if (typeof scope?.task_id !== 'string' || !MES_TASK_ID_RE.test(scope.task_id)) return undefined;
  if (!isCanonicalExecuteResultRef(fact.result_ref)) return undefined;
  return fact;
}

/**
 * Exact accepted ACK/result relation: the accepted result ref explicitly
 * named by the ACK (or the proof-level alias) that the durable envelope must
 * carry. Returns `undefined` when no ref is named at all (the relation is
 * then closed by the validated envelope + ACCEPTED disposition alone; the
 * boolean flag fixture path is preserved).
 */
function explicitAckResultRef(
  proof: Record<string, unknown>,
  ack: Record<string, unknown> | undefined,
): unknown {
  const direct = getProofValue(proof, 'acceptedResultRef', 'accepted_result_ref');
  if (direct !== undefined) return direct;
  if (ack === undefined) return undefined;
  return getProofValue(ack, 'acceptedResultRef', 'accepted_result_ref', 'resultRef', 'result_ref');
}

/**
 * Durable-result proof path: `true` (mechanical boolean alias, caller-
 * projected and preserved) or a FULLY VALIDATED durable Execute result
 * envelope. A caller-supplied partial object is never accepted.
 */
function durableResultValue(value: unknown): boolean {
  if (value === true) return true;
  return validatedExecuteResultEnvelope(value) !== undefined;
}

/**
 * True only when the supplied proof shows ACK ACCEPTED AND a durable Result.
 *
 * (S03-STAGE-REVIEW-F001) A caller-supplied PARTIAL object can never satisfy
 * completion:
 *   - `durableResult` / `durableFacts` entries must be FULLY VALIDATED durable
 *     Execute result envelopes (closed MES envelope validation + execute-kind
 *     predicate + canonical `mes:result:` ref + canonical task scope) — a
 *     `{fact_kind:'result', result_ref:'fake'}` pseudo-envelope fails closed;
 *   - the durableFacts path additionally requires the EXACT accepted
 *     ACK/result relation: the ref explicitly named by the ACK / proof
 *     (`acceptedResultRef` etc.) must exactly equal the durable envelope
 *     result_ref (no vacuous `undefined` match) and a NON-string named ref
 *     fails closed even in the single durableResult path;
 *   - when an `expectedTaskId` is supplied (durable buildTaskFact / task-
 *     scoped transition), the validated durable envelope's scope.task_id
 *     must EXACTLY equal it — a fully valid envelope / accepted ref for
 *     S03-A-T01 can never satisfy TASK_COMPLETE for S03-A-T02;
 *   - the preserved Brain-projected boolean flag fixture
 *     (`resultDisposition: 'ACCEPTED', resultDurable: true`) and the boolean
 *     durable aliases keep working for mechanical callers.
 */
export function hasAcceptedDurableResult(proofValue: unknown, expectedTaskId?: string): boolean {
  const proof = proofObject(proofValue);
  if (proof === undefined) return false;

  const ack = proofObject(proof.ack);
  const disposition = getProofValue(proof, 'resultDisposition', 'result_disposition', 'ackResultDisposition') ??
    (ack === undefined ? undefined : getProofValue(ack, 'resultDisposition', 'result_disposition'));
  const acceptedAlias = getProofValue(proof, 'resultAccepted', 'result_accepted', 'accepted') === true;
  // An explicit ACK disposition is authoritative; contradictory aliases never
  // upgrade a REJECTED/unknown disposition into an accepted completion.
  if (disposition !== undefined ? disposition !== 'ACCEPTED' : !acceptedAlias) return false;

  // Brain-projected durable flags (closed booleans) — the preserved
  // legitimate completion fixture path.
  const durable = getProofValue(proof, 'resultDurable', 'result_durable', 'resultPersisted', 'result_persisted');
  if (durable === true) return true;

  // Single durableResult path: the object must be a fully validated durable
  // Execute result envelope; when the ACK names an exact accepted result ref,
  // the envelope must carry exactly that ref.
  const durableObject = getProofValue(proof, 'durableResult');
  if (durableResultValue(durableObject)) {
    const envelope = validatedExecuteResultEnvelope(durableObject);
    if (envelope === undefined) return true; // boolean alias — caller-projected, preserved
    // (residual closure) task-scoped relation: the durable envelope must be
    // scoped to the EXACT expected task when one is supplied.
    if (expectedTaskId !== undefined && envelope.scope?.task_id !== expectedTaskId) return false;
    const namedRef = explicitAckResultRef(proof, ack);
    if (namedRef !== undefined) {
      // A NON-string named ref fails closed (it is never treated as absent).
      if (typeof namedRef !== 'string') return false;
      return namedRef === envelope.result_ref;
    }
    return true;
  }

  // durableFacts array path: every counted entry must be a fully validated
  // Execute result envelope AND the ACK must name the exact result ref — a
  // missing named ref never matches vacuously.
  const durableFacts = getProofValue(proof, 'durableFacts');
  if (Array.isArray(durableFacts)) {
    const namedRef = explicitAckResultRef(proof, ack);
    if (namedRef === undefined || typeof namedRef !== 'string') return false;
    return durableFacts.some((fact) => {
      const envelope = validatedExecuteResultEnvelope(fact);
      if (envelope === undefined) return false;
      if (expectedTaskId !== undefined && envelope.scope?.task_id !== expectedTaskId) return false;
      return envelope.result_ref === namedRef;
    });
  }
  return false;
}

export const TASK_STATUS_TRANSITIONS: Readonly<Record<MesTaskStatus, readonly MesTaskStatus[]>> = {
  PLANNED: ['IN_PROGRESS'],
  IN_PROGRESS: ['TASK_RESULT_SUBMITTED'],
  TASK_RESULT_SUBMITTED: ['TASK_COMPLETE'],
  TASK_COMPLETE: [],
};

/**
 * Closed legal transition predicate, including the completion barrier.
 * When an `expectedTaskId` is supplied (durable/task-scoped completion
 * seam), the TASK_COMPLETE proof's durable result envelope must be scoped
 * to exactly that task (S03-STAGE-REVIEW-F001 residual closure).
 */
export function isLegalTaskTransition(
  currentStatus: unknown,
  nextStatus: unknown,
  proof?: unknown,
  expectedTaskId?: string,
): boolean {
  if (
    typeof currentStatus !== 'string' ||
    !(MES_TASK_STATUSES as readonly string[]).includes(currentStatus) ||
    typeof nextStatus !== 'string' ||
    !(MES_TASK_STATUSES as readonly string[]).includes(nextStatus)
  ) return false;
  if (!(TASK_STATUS_TRANSITIONS[currentStatus as MesTaskStatus] as readonly string[]).includes(nextStatus)) return false;
  if (nextStatus === 'TASK_COMPLETE' && !hasAcceptedDurableResult(proof, expectedTaskId)) return false;
  return true;
}

/**
 * Assert that a Task transition is legal and closed. An optional
 * `expectedTaskId` closes the TASK_COMPLETE completion relation to exactly
 * that task (S03-STAGE-REVIEW-F001 residual closure).
 */
export function assertTaskTransition(
  currentStatus: unknown,
  nextStatus: unknown,
  proof?: unknown,
  expectedTaskId?: string,
): asserts nextStatus is MesTaskStatus {
  if (!isLegalTaskTransition(currentStatus, nextStatus, proof, expectedTaskId)) {
    if (nextStatus === 'TASK_COMPLETE') {
      laneFail('RESULT_BINDING_MISMATCH', 'TASK_COMPLETE requires Brain ACCEPTED ACK and a durably written Result bound to the expected task');
    }
    laneFail('RESULT_INVALID', `illegal Task status transition ${JSON.stringify(currentStatus)} → ${JSON.stringify(nextStatus)}`);
  }
}

/**
 * Advance a Task status.  Both `(current, next, proof)` and object forms are
 * accepted for callers at different seams; no object form can smuggle a new
 * status machine because the same closed transition table is always used.
 */
export function transitionTaskStatus(
  currentStatus: MesTaskStatus,
  nextStatus: MesTaskStatus,
  proof?: TaskCompletionProof,
): MesTaskStatus;
export function transitionTaskStatus(input: TaskTransitionInput): MesTaskStatus;
export function transitionTaskStatus(
  currentOrInput: unknown,
  nextMaybe?: unknown,
  proofMaybe?: unknown,
): MesTaskStatus {
  let currentStatus: unknown;
  let nextStatus: unknown;
  let proof: unknown;
  let expectedTaskId: string | undefined;
  if (isObject(currentOrInput)) {
    currentStatus = currentOrInput.currentStatus ?? currentOrInput.from;
    nextStatus = currentOrInput.nextStatus ?? currentOrInput.to;
    proof = currentOrInput.completionProof ?? currentOrInput;
    // (residual closure) an object-form transition may carry the expected
    // task id to close the TASK_COMPLETE completion relation to that task.
    const rawTaskId = currentOrInput.taskId ?? currentOrInput.task_id;
    if (rawTaskId !== undefined) {
      expectedTaskId = canonicalTask(rawTaskId, 'task transition.taskId');
    }
  } else {
    currentStatus = currentOrInput;
    nextStatus = nextMaybe;
    proof = proofMaybe;
  }
  assertTaskTransition(currentStatus, nextStatus, proof, expectedTaskId);
  return nextStatus as MesTaskStatus;
}

/** Build a durable Task fact from a builder input (Brain still owns the write). */
export function buildTaskFact(value: unknown, completionProof?: TaskCompletionProof): MesFactEnvelope {
  const input = isObject(value) ? value : undefined;
  if (input === undefined) laneFail('RESULT_INVALID', 'Task fact input must be an object');
  if (Object.prototype.hasOwnProperty.call(input, 'schema_version') || Object.prototype.hasOwnProperty.call(input, 'fact_kind')) {
    const candidate = { ...input };
    const embeddedProof = candidate.completionProof;
    delete candidate.completionProof;
    const fact = validateTaskFact(candidate);
    // (residual closure) durable TASK_COMPLETE building requires the proof's
    // durable Execute result envelope to be scoped to EXACTLY this task.
    if (fact.task_status === 'TASK_COMPLETE' && !hasAcceptedDurableResult(completionProof ?? embeddedProof, fact.scope?.task_id)) {
      laneFail('RESULT_BINDING_MISMATCH', 'building TASK_COMPLETE requires an ACCEPTED + durable Result proof bound to the exact task');
    }
    return fact;
  }

  const known = new Set([
    'fact_id', 'factId', 'task_id', 'taskId', 'task_status', 'status', 'depends_on_task_ids',
    'dependsOnTaskIds', 'blocked_by_task_id', 'blockedByTaskId', 'authority_refs', 'authorityRefs',
    'work_id', 'workId', 'plan_binding', 'planBinding', 'git_basis', 'gitBasis', 'completionProof',
  ]);
  ensureNoUnknownFields(input, known, 'Task fact input');
  const id = canonicalTask(readInputField(input, 'task_id', 'taskId'), 'Task fact.task_id');
  const statusValue = readInputField(input, 'task_status', 'status');
  if (typeof statusValue !== 'string' || !(MES_TASK_STATUSES as readonly string[]).includes(statusValue)) {
    laneFail('RESULT_INVALID', 'Task fact.status must be a closed MES task status');
  }
  const status = statusValue as MesTaskStatus;
  const stageId = id.slice(0, id.indexOf('-'));
  const sliceId = id.slice(0, id.lastIndexOf('-'));
  const workId = nonEmptyString(readInputField(input, 'work_id', 'workId'), 'Task fact.work_id');
  const suppliedFactId = readInputField(input, 'fact_id', 'factId');
  const factId = suppliedFactId === undefined
    ? `mes:fact:task:${id}:${status}`
    : nonEmptyString(suppliedFactId, 'Task fact.fact_id');
  const depends = readInputField(input, 'depends_on_task_ids', 'dependsOnTaskIds');
  const blocked = readInputField(input, 'blocked_by_task_id', 'blockedByTaskId');
  const proof = completionProof ?? input.completionProof;
  // (residual closure) durable TASK_COMPLETE building requires the proof's
  // durable Execute result envelope to be scoped to EXACTLY this task id.
  if (status === 'TASK_COMPLETE' && !hasAcceptedDurableResult(proof, id)) {
    laneFail('RESULT_BINDING_MISMATCH', 'building TASK_COMPLETE requires an ACCEPTED + durable Result proof bound to the exact task');
  }
  const envelope: Record<string, unknown> = {
    schema_version: MES_SCHEMA_VERSION,
    fact_id: factId,
    fact_kind: 'task',
    created_by: 'brain',
    authority_refs: readInputField(input, 'authority_refs', 'authorityRefs'),
    scope: { stage_id: stageId, slice_id: sliceId, task_id: id },
    work_id: workId,
    plan_binding: readInputField(input, 'plan_binding', 'planBinding'),
    git_basis: readInputField(input, 'git_basis', 'gitBasis'),
    task_status: status,
    depends_on_task_ids: depends,
  };
  if (blocked !== undefined) envelope.blocked_by_task_id = blocked;
  return validateTaskFact(envelope);
}

/** Alias matching callers that use the progression wording. */
export const buildTaskProgressionFact = buildTaskFact;
export const validateTaskProgressionFact = validateTaskFact;

function normalizeTaskIds(value: unknown, label: string): string[] {
  const values = expectArray(value, label);
  if (values.length === 0) laneFail('RESULT_INVALID', `${label} must be non-empty`);
  const seen = new Set<string>();
  const output: string[] = [];
  values.forEach((entry, index) => {
    const id = canonicalTask(entry, `${label}[${index}]`);
    if (seen.has(id)) laneFail('RESULT_INVALID', `${label} contains duplicate task ${id}`);
    seen.add(id);
    output.push(id);
  });
  return output;
}

function normalizeStatuses(value: unknown, label: string): MesTaskStatus[] {
  const values = expectArray(value, label);
  if (values.length === 0) laneFail('RESULT_INVALID', `${label} must be non-empty`);
  return values.map((entry, index) => {
    if (typeof entry !== 'string' || !(MES_TASK_STATUSES as readonly string[]).includes(entry)) {
      laneFail('RESULT_INVALID', `${label}[${index}] is not a closed MES task status`);
    }
    return entry as MesTaskStatus;
  });
}

function taskStatusesFromFacts(value: unknown): Map<string, MesTaskStatus> {
  const facts = expectArray(value, 'slice_candidate.durableFacts');
  const latest = new Map<string, MesTaskStatus>();
  for (const [index, raw] of facts.entries()) {
    if (!isObject(raw)) laneFail('RESULT_INVALID', `slice_candidate.durableFacts[${index}] must be an object`);
    if (raw.fact_kind !== 'task') continue;
    // A TASK_COMPLETE marker is only meaningful when the entire durable Task
    // envelope is closed and accepted-bound.  Do not trust a status field from
    // a caller-provided projection as a substitute for Brain/MES facts.
    const fact = validateTaskFact(raw);
    const id = fact.scope?.task_id;
    if (id === undefined) laneFail('RESULT_BINDING_MISMATCH', `slice_candidate.durableFacts[${index}] has no task scope`);
    const status = fact.task_status;
    if (typeof status !== 'string' || !(MES_TASK_STATUSES as readonly string[]).includes(status)) {
      laneFail('RESULT_INVALID', `slice_candidate.durableFacts[${index}] carries an unknown task_status`);
    }
    latest.set(id, status as MesTaskStatus);
  }
  return latest;
}

function evaluateSliceCandidate(value: unknown): boolean {
  const input = isObject(value) ? value : undefined;
  if (input === undefined) laneFail('RESULT_INVALID', 'slice candidate input must be an object');
  ensureNoUnknownFields(input, new Set(['plannedTaskIds', 'taskStatuses', 'durableFacts', 'selfCheckPassed', 'planned_task_ids', 'task_statuses', 'durable_facts', 'self_check_passed']), 'slice_candidate');
  const selfCheck = input.selfCheckPassed ?? input.self_check_passed;
  if (selfCheck !== undefined && typeof selfCheck !== 'boolean') laneFail('RESULT_INVALID', 'slice_candidate.selfCheckPassed must be boolean');
  if (selfCheck !== true) return false;
  const rawIds = input.plannedTaskIds ?? input.planned_task_ids;
  const plannedIds = rawIds === undefined ? undefined : normalizeTaskIds(rawIds, 'slice_candidate.plannedTaskIds');
  if (plannedIds === undefined) return false;
  const rawStatuses = input.taskStatuses ?? input.task_statuses;
  const statuses = rawStatuses === undefined ? undefined : normalizeStatuses(rawStatuses, 'slice_candidate.taskStatuses');
  const rawFacts = input.durableFacts ?? input.durable_facts;
  const factStatuses = rawFacts === undefined ? undefined : taskStatusesFromFacts(rawFacts);

  if (statuses === undefined && factStatuses === undefined) {
    laneFail('RESULT_INVALID', 'slice_candidate requires taskStatuses or durableFacts');
  }
  if (plannedIds !== undefined && statuses !== undefined && statuses.length !== plannedIds.length) return false;
  if (plannedIds !== undefined && factStatuses !== undefined) {
    return plannedIds.every((id) => factStatuses.get(id) === 'TASK_COMPLETE') &&
      (statuses === undefined || statuses.every((status) => status === 'TASK_COMPLETE'));
  }
  if (statuses !== undefined) return statuses.every((status) => status === 'TASK_COMPLETE');
  return [...factStatuses!.values()].length > 0 && [...factStatuses!.values()].every((status) => status === 'TASK_COMPLETE');
}

/** Return whether the Slice has crossed the candidate-ready barrier. */
export function isSliceCandidateReady(value: unknown): boolean {
  return evaluateSliceCandidate(value);
}

/** Assert and return the closed Slice candidate milestone. */
export function assertSliceCandidateReady(value: unknown): 'SLICE_CANDIDATE_READY' {
  if (!evaluateSliceCandidate(value)) laneFail('RESULT_INVALID', 'SLICE_CANDIDATE_READY requires all planned Tasks TASK_COMPLETE and self-check passed');
  return 'SLICE_CANDIDATE_READY';
}

/** Read-only result object for callers that prefer an explicit readiness view. */
export function checkSliceCandidateReady(value: unknown): { readonly state: LaneMilestone; readonly ready: boolean } {
  return {
    state: 'SLICE_CANDIDATE_READY',
    ready: evaluateSliceCandidate(value),
  };
}

function normalizeSliceIds(value: unknown, label: string): string[] {
  const values = expectArray(value, label);
  if (values.length === 0) laneFail('RESULT_INVALID', `${label} must be non-empty`);
  const seen = new Set<string>();
  const output: string[] = [];
  values.forEach((entry, index) => {
    const id = canonicalSlice(entry, `${label}[${index}]`);
    if (seen.has(id)) laneFail('RESULT_INVALID', `${label} contains duplicate Slice ${id}`);
    seen.add(id);
    output.push(id);
  });
  return output;
}

function evaluateExecutionReady(value: unknown): boolean {
  const input = isObject(value) ? value : undefined;
  if (input === undefined) laneFail('RESULT_INVALID', 'execution milestone input must be an object');
  ensureNoUnknownFields(input, new Set(['plannedSliceIds', 'plannedSlices', 'planned_slice_ids', 'durableFacts', 'durable_facts']), 'execution_milestone');
  const rawSlices = input.plannedSliceIds ?? input.plannedSlices ?? input.planned_slice_ids;
  const planned = normalizeSliceIds(rawSlices, 'execution_milestone.plannedSliceIds');
  const rawFacts = input.durableFacts ?? input.durable_facts;
  const facts = expectArray(rawFacts, 'execution_milestone.durableFacts');
  const integrated = new Set<string>();
  for (const [index, raw] of facts.entries()) {
    if (!isObject(raw)) laneFail('RESULT_INVALID', `execution_milestone.durableFacts[${index}] must be an object`);
    // All durable facts entering this seam must already be MES-validated.  A
    // malformed known fact is not silently ignored; unrelated valid facts are
    // simply irrelevant to this stage-level barrier.
    let fact: MesFactEnvelope;
    try {
      fact = validateMesFactEnvelope(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      laneFail('RESULT_INVALID', `execution_milestone durable fact validation failed: ${detail}`);
    }
    if (fact.fact_kind !== 'git' || fact.git_subkind !== 'integration') continue;
    const scope = ensureSliceScope(fact, 'integration Git fact');
    // A Git integration fact is Slice-scoped; task scopes are not accepted at
    // the Stage execution barrier.
    if (fact.scope?.task_id !== undefined) laneFail('RESULT_INVALID', 'integration Git fact must be Slice-scoped, not Task-scoped');
    ensureNormalAcceptedBinding(fact, 'integration Git fact');
    integrated.add(scope.sliceId);
  }
  return planned.every((sliceId) => integrated.has(sliceId));
}

/** Return whether every planned Slice has a durable integration Git fact. */
export function isExecutionReadyForReview(value: unknown): boolean {
  return evaluateExecutionReady(value);
}

/** Assert and return the closed Stage execution milestone. */
export function assertExecutionReadyForReview(value: unknown): 'EXECUTION_READY_FOR_REVIEW' {
  if (!evaluateExecutionReady(value)) {
    laneFail('RESULT_INVALID', 'EXECUTION_READY_FOR_REVIEW requires an INTEGRATED durable fact for every planned Slice');
  }
  return 'EXECUTION_READY_FOR_REVIEW';
}

/** Explicit readiness view for the stage-level barrier. */
export function checkExecutionReadyForReview(value: unknown): { readonly state: LaneMilestone; readonly ready: boolean } {
  return {
    state: 'EXECUTION_READY_FOR_REVIEW',
    ready: evaluateExecutionReady(value),
  };
}

/** Aliases for generic lane consumers. */
export const validateWorkFact = validateLaneWorkFact;
export const createLaneWorkFact = buildLaneWorkFact;
export const canCompleteTask = hasAcceptedDurableResult;
export const validateTaskStatusTransition = assertTaskTransition;
export const buildWorkFact = buildLaneWorkFact;
export const validateLaneStartWorkFact = validateLaneWorkFact;
export const buildLaneStartFact = buildLaneWorkFact;
export const transitionTask = transitionTaskStatus;
export const advanceTaskStatus = transitionTaskStatus;
export const isValidTaskTransition = isLegalTaskTransition;
export const validateTaskTransition = assertTaskTransition;
export function assertTaskComplete(proof: unknown, expectedTaskId?: string): void {
  if (!hasAcceptedDurableResult(proof, expectedTaskId)) {
    laneFail('RESULT_BINDING_MISMATCH', 'TASK_COMPLETE requires Brain ACCEPTED ACK and a durably written Result bound to the expected task');
  }
}
export const validateSliceCandidate = assertSliceCandidateReady;
export const validateExecutionReadyForReview = assertExecutionReadyForReview;
export const LaneError = LaneProgressionError;
export const TaskProgressionError = LaneProgressionError;
