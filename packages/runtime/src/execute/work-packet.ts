/**
 * @proofloop/runtime — closed Slice Work Packet validation seam (S03-C-T01).
 *
 * This module validates the three execution inputs owned by Execute: the
 * Slice-level Work Packet, a per-task JIT Read Set, and a bounded repair
 * packet.  They are derived inputs, not planning or authority artifacts.  The
 * validators are pure and never read MES, the filesystem, or Git.
 */
import { CANONICAL_STAGE_ID_RE } from '@proofloop/kernel';
import { MES_SLICE_ID_RE, MES_TASK_ID_RE } from '../mes/types';
import { isCanonicalAuthorityRef, isCanonicalRootRelativeRef } from '../mes/binding';
import { MAINTENANCE_LANE_PLAN_REF, MAINTENANCE_LANE_STAGE } from '../mes/maintenance-seam';

/** Closed execution branches for Worker packets. */
export const WORK_PACKET_EXECUTION_MODES = ['NORMAL', 'PRE_MES_BOOTSTRAP', 'MES_MAINTENANCE'] as const;
export type WorkPacketExecutionMode = (typeof WORK_PACKET_EXECUTION_MODES)[number];

/**
 * Recovery candidate Plan slice/task grammar for the MES_MAINTENANCE lane
 * (recovery-plan-r3.md slices like S06-R-D with tasks S06-R-D-T01). The
 * lane binds the recovery candidate Plan, not MES canonical identity, so its
 * ids may carry one extra `-[A-Z]+` group. NORMAL / PRE_MES_BOOTSTRAP keep
 * the strict canonical grammar unchanged (no second NORMAL schema).
 */
const MAINTENANCE_SLICE_ID_RE = /^S\d+-[A-Z]+(?:-[A-Z]+)?$/;
const MAINTENANCE_TASK_ID_RE = /^S\d+-[A-Z]+(?:-[A-Z]+)?-T\d+$/;

function isLaneSliceId(mode: WorkPacketExecutionMode, id: string): boolean {
  return mode === 'MES_MAINTENANCE' ? MAINTENANCE_SLICE_ID_RE.test(id) : MES_SLICE_ID_RE.test(id);
}

function isLaneTaskId(mode: WorkPacketExecutionMode, id: string): boolean {
  return mode === 'MES_MAINTENANCE' ? MAINTENANCE_TASK_ID_RE.test(id) : MES_TASK_ID_RE.test(id);
}
/** Typed fail-closed outcomes used by the Work Packet seam. */
export type WorkPacketValidationCode =
  | 'RESULT_INVALID'
  | 'RESULT_BINDING_MISMATCH'
  | 'PLAN_GAP';

export interface WorkPacketFieldError {
  readonly path: string;
  readonly message: string;
}

/**
 * Closed error for malformed or stale Work Packet inputs.  `outcome` is kept
 * as an alias for callers that use the Result-validation error convention;
 * `code` is the canonical property for this seam.
 */
export class WorkPacketValidationError extends Error {
  public readonly code: WorkPacketValidationCode;
  public readonly outcome: WorkPacketValidationCode;
  public readonly fieldErrors: readonly WorkPacketFieldError[];

  constructor(
    code: WorkPacketValidationCode,
    message: string,
    fieldErrors: readonly WorkPacketFieldError[] = [],
  ) {
    super(message);
    this.name = 'WorkPacketValidationError';
    this.code = code;
    this.outcome = code;
    this.fieldErrors = fieldErrors;
    Object.setPrototypeOf(this, WorkPacketValidationError.prototype);
  }
}

/** Closed nested Git basis carried by a Work Packet. */
export interface WorkPacketGitBasis {
  readonly worktree: string;
  readonly base_ref: string;
}


/**
 * Closed MES_MAINTENANCE binding carried by a packet (canonical §4.2
 * snake_case tuple: frozen snapshot ref/sha256/count + forensic ref/sha256
 * + audit ref/sha256). Schema-only — the exact file-digest match is the
 * maintenance entry seam's machine closure.
 */
export interface WorkPacketMaintenanceBinding {
  readonly frozen_snapshot_ref: string;
  readonly frozen_snapshot_sha256: string;
  readonly frozen_fact_count: number;
  readonly forensic_ref: string;
  readonly forensic_sha256: string;
  readonly audit_ref: string;
  readonly audit_sha256: string;
}
/** Closed allowed/forbidden scope of a Slice Work Packet. */
export interface WorkPacketScope {
  readonly allowed_paths: readonly string[];
  readonly forbidden_paths: readonly string[];
}

/** The canonical Slice-level packet projected by Execute. */
export interface SliceWorkPacket {
  readonly execution_mode: WorkPacketExecutionMode;
  readonly target_agent: 'worker';
  readonly caller: 'brain';
  readonly skill: 'proofloop-execute';
  readonly stage_id: string;
  readonly slice_id: string;
  readonly project_root: string;
  readonly thin_plan_ref: string;
  readonly authority_refs: readonly string[];
  readonly actionToken: string;
  readonly code_anchors: readonly string[];
  /** MES_MAINTENANCE only (worker-template §4.2); omitted otherwise. */
  readonly maintenance_binding?: WorkPacketMaintenanceBinding;
  readonly git_basis: WorkPacketGitBasis;
  readonly scope: WorkPacketScope;
  readonly required_skills: readonly string[];
  readonly slice_task_ids: readonly string[];
  readonly stop_conditions: readonly string[];
  readonly expected_result: 'SLICE_CANDIDATE_READY';
}

/** The canonical per-task JIT Read Set projected inside a Slice lane. */
export interface JitReadSet {
  readonly execution_mode: WorkPacketExecutionMode;
  readonly task_id: string;
  readonly task_goal: string;
  /**
   * Canonical worker-template field name: `plan_ref` in every mode
   * (NORMAL = same thin-plan-ref; PRE_MES_BOOTSTRAP = candidate/accepted Git
   * Plan ref; MES_MAINTENANCE = recovery candidate Thin Plan ref). The
   * non-canonical `accepted_plan_ref` alias is NOT part of the canonical
   * maintenance schema and is rejected as an unknown field.
   */
  readonly plan_ref: string;
  readonly authority_refs: readonly string[];
  readonly code_anchors: readonly string[];
  /** MES_MAINTENANCE only; omitted otherwise. */
  readonly maintenance_binding?: WorkPacketMaintenanceBinding;
  readonly allowed_scope: {
    readonly code_paths: readonly string[];
    readonly test_paths: readonly string[];
    readonly forbidden_paths: readonly string[];
  };
  readonly dependency_outputs: readonly string[];
  readonly done_criteria: readonly string[];
  readonly stop_conditions: readonly string[];
  readonly required_skills: readonly string[];
  readonly actionToken: string;
}

/** Canonical bounded Repair Work Packet.  It is intentionally taskless. */
export interface BoundedRepairWorkPacket {
  readonly repair_scope: readonly string[];
  readonly failed_criterion: string;
  readonly concrete_counterexample: string;
  readonly required_recheck_scope: readonly string[];
  readonly repair_diff_basis: string;
}

/** Alias used by callers that spell the type with the template's wording. */
export type TaskJitReadSet = JitReadSet;
export type PerTaskJitReadSet = JitReadSet;
export type RepairWorkPacket = BoundedRepairWorkPacket;

export type WorkPacketShape = 'slice' | 'jit' | 'repair';

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

function fail(
  code: WorkPacketValidationCode,
  message: string,
  fieldErrors: readonly WorkPacketFieldError[] = [],
): never {
  throw new WorkPacketValidationError(code, message, fieldErrors);
}

function objectOrFail(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) fail('RESULT_INVALID', `${label} must be an object`);
  return value;
}

function checkUnknownFields(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    fail(
      'RESULT_INVALID',
      `${label} contains unknown field(s): ${unknown.map((key) => JSON.stringify(key)).join(', ')}`,
      unknown.map((key) => ({ path: `${label}.${key}`, message: `Unknown field "${key}"` })),
    );
  }
}

function requireFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length > 0) {
    fail(
      'RESULT_INVALID',
      `${label} is missing required field(s): ${missing.join(', ')}`,
      missing.map((field) => ({ path: `${label}.${field}`, message: 'Required field is missing' })),
    );
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value)) {
    fail('RESULT_INVALID', `${label} must be a non-empty string without control characters`, [
      { path: label, message: 'Expected a non-empty string without control characters' },
    ]);
  }
  return value;
}

/** Lexical root-relative path check; it performs no filesystem lookup. */
function rootRelativePath(value: unknown, label: string, allowDot = false): string {
  const stringValue = nonEmptyString(value, label);
  if (
    stringValue.startsWith('/') ||
    stringValue.startsWith('//') ||
    stringValue.includes('\\') ||
    /^[A-Za-z]:/.test(stringValue)
  ) {
    fail('RESULT_INVALID', `${label} must be a canonical root-relative path`, [
      { path: label, message: 'Absolute, drive-letter and backslash paths are not allowed' },
    ]);
  }
  const parts = stringValue.split('/');
  if (
    parts.some((part) => part.length === 0 || part === '..' || (part === '.' && !(allowDot && parts.length === 1)))
  ) {
    fail('RESULT_INVALID', `${label} must be a canonical root-relative path`, [
      { path: label, message: 'Empty, dot and traversal segments are not allowed' },
    ]);
  }
  // Keep the canonical helper as the common grammar authority where it can
  // express this path.  The explicit checks above additionally reject control
  // characters and make the `.` worktree root explicit.
  if (!allowDot || stringValue !== '.') {
    if (!isCanonicalRootRelativeRef(stringValue)) {
      fail('RESULT_INVALID', `${label} must be a canonical root-relative path`, [
        { path: label, message: 'Path is not root-bound' },
      ]);
    }
  }
  return stringValue;
}

function listOfStrings(
  value: unknown,
  label: string,
  options: { readonly nonEmpty?: boolean; readonly paths?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) fail('RESULT_INVALID', `${label} must be an array`);
  if (options.nonEmpty === true && value.length === 0) {
    fail('RESULT_INVALID', `${label} must be non-empty`);
  }
  const output: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    const normalized = options.paths === true
      ? rootRelativePath(entry, entryLabel)
      : nonEmptyString(entry, entryLabel);
    if (seen.has(normalized)) {
      fail('RESULT_INVALID', `${label} contains duplicate entry ${JSON.stringify(normalized)}`, [
        { path: entryLabel, message: 'Duplicate entries are not allowed' },
      ]);
    }
    seen.add(normalized);
    output.push(normalized);
  });
  return output;
}

function authorityRefs(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) fail('RESULT_INVALID', `${label} must be an array of canonical authority refs`);
  if (value.length === 0) fail('RESULT_INVALID', `${label} must be non-empty`);
  const seen = new Set<string>();
  const output: string[] = [];
  value.forEach((entry, index) => {
    if (!isCanonicalAuthorityRef(entry) || hasControlCharacter(entry)) {
      fail('RESULT_INVALID', `${label}[${index}] must be a canonical authority ref`, [
        { path: `${label}[${index}]`, message: 'Expected <root-relative-path>#<section/entity>' },
      ]);
    }
    if (seen.has(entry)) fail('RESULT_INVALID', `${label} contains duplicate entry ${JSON.stringify(entry)}`);
    seen.add(entry);
    output.push(entry);
  });
  return output;
}

function opaque(value: unknown, label: string): string {
  return nonEmptyString(value, label);
}

function executionMode(value: unknown, label: string): WorkPacketExecutionMode {
  if (
    typeof value !== 'string' ||
    !(WORK_PACKET_EXECUTION_MODES as readonly string[]).includes(value)
  ) {
    fail('RESULT_INVALID', `${label} must be one of ${WORK_PACKET_EXECUTION_MODES.join(', ')}`);
  }
  return value as WorkPacketExecutionMode;
}

function stageId(value: unknown, label: string): string {
  const id = nonEmptyString(value, label);
  if (!CANONICAL_STAGE_ID_RE.test(id)) fail('RESULT_INVALID', `${label} must be a canonical Stage ID (e.g. S03)`);
  return id;
}

function sliceId(value: unknown, label: string, mode: WorkPacketExecutionMode): string {
  const id = nonEmptyString(value, label);
  if (!isLaneSliceId(mode, id)) fail('RESULT_INVALID', `${label} must be a canonical Slice ID (e.g. S03-C)`);
  return id;
}

function taskId(value: unknown, label: string, mode: WorkPacketExecutionMode): string {
  const id = nonEmptyString(value, label);
  if (!isLaneTaskId(mode, id)) fail('RESULT_INVALID', `${label} must be a canonical Task ID (e.g. S03-C-T01)`);
  return id;
}

function plainTextList(value: unknown, label: string, nonEmpty = false): string[] {
  return listOfStrings(value, label, { nonEmpty });
}

function assertNoProtectedPath(paths: readonly string[], label: string): void {
  for (const entry of paths) {
    if (
      entry === '.git' ||
      entry.startsWith('.git/') ||
      entry === '.proofloop' ||
      entry.startsWith('.proofloop/')
    ) {
      fail('RESULT_INVALID', `${label} must not include a protected path: ${entry}`);
    }
  }
}

function pathWithin(value: string, base: string): boolean {
  return value === base || value.startsWith(`${base}/`);
}

function assertDisjoint(
  first: readonly string[],
  second: readonly string[],
  firstLabel: string,
  secondLabel: string,
): void {
  for (const left of first) {
    for (const right of second) {
      if (pathWithin(left, right) || pathWithin(right, left)) {
        fail('RESULT_INVALID', `${firstLabel} overlaps ${secondLabel}: ${left} / ${right}`);
      }
    }
  }
}

function validateScope(value: unknown, label: string): WorkPacketScope {
  const scope = objectOrFail(value, label);
  checkUnknownFields(scope, new Set(['allowed_paths', 'forbidden_paths']), label);
  requireFields(scope, ['allowed_paths', 'forbidden_paths'], label);
  const allowed = listOfStrings(scope.allowed_paths, `${label}.allowed_paths`, { nonEmpty: true, paths: true });
  const forbidden = listOfStrings(scope.forbidden_paths, `${label}.forbidden_paths`, { paths: true });
  assertNoProtectedPath(allowed, `${label}.allowed_paths`);
  assertDisjoint(allowed, forbidden, `${label}.allowed_paths`, `${label}.forbidden_paths`);
  return { allowed_paths: allowed, forbidden_paths: forbidden };
}

function validateJitScope(value: unknown, label: string): JitReadSet['allowed_scope'] {
  const scope = objectOrFail(value, label);
  checkUnknownFields(scope, new Set(['code_paths', 'test_paths', 'forbidden_paths']), label);
  requireFields(scope, ['code_paths', 'test_paths', 'forbidden_paths'], label);
  const codePaths = listOfStrings(scope.code_paths, `${label}.code_paths`, { nonEmpty: true, paths: true });
  const testPaths = listOfStrings(scope.test_paths, `${label}.test_paths`, { nonEmpty: true, paths: true });
  const forbidden = listOfStrings(scope.forbidden_paths, `${label}.forbidden_paths`, { paths: true });
  assertNoProtectedPath(codePaths, `${label}.code_paths`);
  assertNoProtectedPath(testPaths, `${label}.test_paths`);
  assertDisjoint(codePaths, forbidden, `${label}.code_paths`, `${label}.forbidden_paths`);
  assertDisjoint(testPaths, forbidden, `${label}.test_paths`, `${label}.forbidden_paths`);
  return { code_paths: codePaths, test_paths: testPaths, forbidden_paths: forbidden };
}

function validatePacketGitBasis(value: unknown, label: string): WorkPacketGitBasis {
  const basis = objectOrFail(value, label);
  checkUnknownFields(basis, new Set(['worktree', 'base_ref']), label);
  requireFields(basis, ['worktree', 'base_ref'], label);
  return {
    worktree: rootRelativePath(basis.worktree, `${label}.worktree`, true),
    base_ref: opaque(basis.base_ref, `${label}.base_ref`),
  };
}

/**
 * Closed-shape validation of a packet maintenance_binding (canonical §4.2
 * snake_case tuple). Schema-only; unknown fields / bad digests / non-positive
 * counts fail closed.
 */
function validateMaintenanceBinding(value: unknown, label: string): WorkPacketMaintenanceBinding {
  const binding = objectOrFail(value, label);
  const KNOWN = new Set([
    'frozen_snapshot_ref',
    'frozen_snapshot_sha256',
    'frozen_fact_count',
    'forensic_ref',
    'forensic_sha256',
    'audit_ref',
    'audit_sha256',
  ]);
  checkUnknownFields(binding, KNOWN, label);
  requireFields(binding, [...KNOWN], label);
  for (const refField of ['frozen_snapshot_ref', 'forensic_ref', 'audit_ref'] as const) {
    rootRelativePath(binding[refField], `${label}.${refField}`);
  }
  for (const digestField of ['frozen_snapshot_sha256', 'forensic_sha256', 'audit_sha256'] as const) {
    const digest = binding[digestField];
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      fail('RESULT_INVALID', `${label}.${digestField} must be a 64-char lowercase hex sha256`);
    }
  }
  const count = binding.frozen_fact_count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
    fail('RESULT_INVALID', `${label}.frozen_fact_count must be a positive integer`);
  }
  return {
    frozen_snapshot_ref: binding.frozen_snapshot_ref as string,
    frozen_snapshot_sha256: binding.frozen_snapshot_sha256 as string,
    frozen_fact_count: count,
    forensic_ref: binding.forensic_ref as string,
    forensic_sha256: binding.forensic_sha256 as string,
    audit_ref: binding.audit_ref as string,
    audit_sha256: binding.audit_sha256 as string,
  };
}

/**
 * Mode closure of the packet maintenance_binding: required exactly under
 * MES_MAINTENANCE and forbidden under NORMAL / PRE_MES_BOOTSTRAP (no second
 * schema, no smuggling).
 */
function closeMaintenanceBinding(mode: WorkPacketExecutionMode, value: unknown, label: string): WorkPacketMaintenanceBinding | undefined {
  const present = value !== undefined;
  if (mode === 'MES_MAINTENANCE' && !present) {
    fail('RESULT_INVALID', `${label} requires maintenance_binding under MES_MAINTENANCE (frozen/forensic/audit exact tuple)`);
  }
  if (mode !== 'MES_MAINTENANCE' && present) {
    fail('RESULT_INVALID', `${label}.maintenance_binding is only valid under MES_MAINTENANCE`);
  }
  return present ? validateMaintenanceBinding(value, `${label}.maintenance_binding`) : undefined;
}

/** Validate a projected Slice-level Work Packet. */
export function validateSliceWorkPacket(value: unknown): SliceWorkPacket {
  const packet = objectOrFail(value, 'work_packet');
  const known = new Set([
    'execution_mode',
    'target_agent',
    'caller',
    'skill',
    'stage_id',
    'slice_id',
    'project_root',
    'thin_plan_ref',
    'authority_refs',
    'actionToken',
    'code_anchors',
    'maintenance_binding',
    'git_basis',
    'scope',
    'required_skills',
    'slice_task_ids',
    'stop_conditions',
    'expected_result',
  ]);
  checkUnknownFields(packet, known, 'work_packet');
  // maintenance_binding is CONDITIONAL (required exactly under
  // MES_MAINTENANCE): it belongs to the closed known set but never to the
  // always-required set (closeMaintenanceBinding enforces the mode rule).
  requireFields(
    packet,
    [...known].filter((field) => field !== 'maintenance_binding'),
    'work_packet',
  );

  const mode = executionMode(packet.execution_mode, 'work_packet.execution_mode');
  if (packet.target_agent !== 'worker') fail('RESULT_INVALID', 'work_packet.target_agent must be "worker"');
  if (packet.caller !== 'brain') fail('RESULT_INVALID', 'work_packet.caller must be "brain"');
  if (packet.skill !== 'proofloop-execute') fail('RESULT_INVALID', 'work_packet.skill must be "proofloop-execute"');
  const stage = stageId(packet.stage_id, 'work_packet.stage_id');
  const slice = sliceId(packet.slice_id, 'work_packet.slice_id', mode);
  if (slice.slice(0, slice.indexOf('-')) !== stage) {
    fail('RESULT_INVALID', `work_packet.slice_id ${slice} must belong to stage ${stage}`);
  }
  const projectRoot = nonEmptyString(packet.project_root, 'work_packet.project_root');
  const planRef = rootRelativePath(packet.thin_plan_ref, 'work_packet.thin_plan_ref');
  if (mode === 'MES_MAINTENANCE') {
    if (stage !== MAINTENANCE_LANE_STAGE) {
      fail('RESULT_INVALID', `work_packet.stage_id under MES_MAINTENANCE must be EXACTLY ${MAINTENANCE_LANE_STAGE} — the maintenance lane is ${MAINTENANCE_LANE_STAGE}-scoped (no lane widening)`);
    }
    if (planRef !== MAINTENANCE_LANE_PLAN_REF) {
      fail('RESULT_INVALID', `work_packet.thin_plan_ref under MES_MAINTENANCE must EXACTLY equal the recovery candidate ${MAINTENANCE_LANE_PLAN_REF} (stale candidate / accepted Plan substitution fails closed)`);
    }
  }
  const refs = authorityRefs(packet.authority_refs, 'work_packet.authority_refs');
  const token = opaque(packet.actionToken, 'work_packet.actionToken');
  const anchors = listOfStrings(packet.code_anchors, 'work_packet.code_anchors', { nonEmpty: true, paths: true });
  assertNoProtectedPath(anchors, 'work_packet.code_anchors');
  const gitBasis = validatePacketGitBasis(packet.git_basis, 'work_packet.git_basis');
  const scope = validateScope(packet.scope, 'work_packet.scope');
  const skills = plainTextList(packet.required_skills, 'work_packet.required_skills', true);
  const taskIds = listOfStrings(packet.slice_task_ids, 'work_packet.slice_task_ids', { nonEmpty: true });
  for (const [index, id] of taskIds.entries()) {
    if (!isLaneTaskId(mode, id)) fail('RESULT_INVALID', `work_packet.slice_task_ids[${index}] must be a canonical Task ID`);
    if (id.slice(0, id.lastIndexOf('-')) !== slice) {
      fail('RESULT_INVALID', `work_packet.slice_task_ids[${index}] must belong to slice ${slice}`);
    }
  }
  const stopConditions = plainTextList(packet.stop_conditions, 'work_packet.stop_conditions', true);
  if (packet.expected_result !== 'SLICE_CANDIDATE_READY') {
    fail('RESULT_INVALID', 'work_packet.expected_result must be "SLICE_CANDIDATE_READY"');
  }

  // `mode` is deliberately read/validated here even though both branches use
  // the same lexical Plan-ref grammar.  The branch distinction belongs to the
  // caller's binding; this seam must not invent MES prerequisites for bootstrap.
  return {
    execution_mode: mode,
    target_agent: 'worker',
    caller: 'brain',
    skill: 'proofloop-execute',
    stage_id: stage,
    slice_id: slice,
    project_root: projectRoot,
    thin_plan_ref: planRef,
    authority_refs: refs,
    actionToken: token,
    code_anchors: anchors,
    maintenance_binding: closeMaintenanceBinding(mode, packet.maintenance_binding, 'work_packet'),
    git_basis: gitBasis,
    scope,
    required_skills: skills,
    slice_task_ids: taskIds,
    stop_conditions: stopConditions,
    expected_result: 'SLICE_CANDIDATE_READY',
  };
}

/** Validate a per-task JIT Read Set. */
export function validateJitReadSet(value: unknown): JitReadSet {
  const readSet = objectOrFail(value, 'jit_read_set');
  const known = new Set([
    'execution_mode',
    'task_id',
    'task_goal',
    'plan_ref',
    'authority_refs',
    'code_anchors',
    'maintenance_binding',
    'allowed_scope',
    'dependency_outputs',
    'done_criteria',
    'stop_conditions',
    'required_skills',
    'actionToken',
  ]);
  checkUnknownFields(readSet, known, 'jit_read_set');
  // maintenance_binding is CONDITIONAL (required exactly under
  // MES_MAINTENANCE): it belongs to the closed known set but never to the
  // always-required set (closeMaintenanceBinding enforces the mode rule).
  requireFields(
    readSet,
    [...known].filter((field) => field !== 'maintenance_binding'),
    'jit_read_set',
  );
  const mode = executionMode(readSet.execution_mode, 'jit_read_set.execution_mode');
  const id = taskId(readSet.task_id, 'jit_read_set.task_id', mode);
  const goal = nonEmptyString(readSet.task_goal, 'jit_read_set.task_goal');
  const planRef = rootRelativePath(readSet.plan_ref, 'jit_read_set.plan_ref');
  if (mode === 'MES_MAINTENANCE') {
    if (id.slice(0, id.indexOf('-')) !== MAINTENANCE_LANE_STAGE) {
      fail('RESULT_INVALID', `jit_read_set.task_id under MES_MAINTENANCE must belong to the ${MAINTENANCE_LANE_STAGE} maintenance lane (no lane widening)`);
    }
    if (planRef !== MAINTENANCE_LANE_PLAN_REF) {
      fail('RESULT_INVALID', `jit_read_set.plan_ref under MES_MAINTENANCE must EXACTLY equal the recovery candidate ${MAINTENANCE_LANE_PLAN_REF} (stale candidate / accepted Plan substitution fails closed)`);
    }
  }
  const refs = authorityRefs(readSet.authority_refs, 'jit_read_set.authority_refs');
  const anchors = listOfStrings(readSet.code_anchors, 'jit_read_set.code_anchors', { nonEmpty: true, paths: true });
  assertNoProtectedPath(anchors, 'jit_read_set.code_anchors');
  const scope = validateJitScope(readSet.allowed_scope, 'jit_read_set.allowed_scope');
  const dependencyOutputs = plainTextList(readSet.dependency_outputs, 'jit_read_set.dependency_outputs');
  const doneCriteria = plainTextList(readSet.done_criteria, 'jit_read_set.done_criteria', true);
  const stopConditions = plainTextList(readSet.stop_conditions, 'jit_read_set.stop_conditions', true);
  const skills = plainTextList(readSet.required_skills, 'jit_read_set.required_skills', true);
  const token = opaque(readSet.actionToken, 'jit_read_set.actionToken');
  return {
    execution_mode: mode,
    task_id: id,
    task_goal: goal,
    plan_ref: planRef,
    authority_refs: refs,
    code_anchors: anchors,
    maintenance_binding: closeMaintenanceBinding(mode, readSet.maintenance_binding, 'jit_read_set'),
    allowed_scope: scope,
    dependency_outputs: dependencyOutputs,
    done_criteria: doneCriteria,
    stop_conditions: stopConditions,
    required_skills: skills,
    actionToken: token,
  };
}

/** Validate a taskless bounded Repair Work Packet. */
export function validateBoundedRepairWorkPacket(value: unknown): BoundedRepairWorkPacket {
  const packet = objectOrFail(value, 'repair_work_packet');
  const known = new Set([
    'repair_scope',
    'failed_criterion',
    'concrete_counterexample',
    'required_recheck_scope',
    'repair_diff_basis',
  ]);
  checkUnknownFields(packet, known, 'repair_work_packet');
  requireFields(packet, [...known], 'repair_work_packet');
  const repairScope = listOfStrings(packet.repair_scope, 'repair_work_packet.repair_scope', { nonEmpty: true, paths: true });
  const recheckScope = listOfStrings(packet.required_recheck_scope, 'repair_work_packet.required_recheck_scope', { paths: true });
  assertNoProtectedPath(repairScope, 'repair_work_packet.repair_scope');
  assertNoProtectedPath(recheckScope, 'repair_work_packet.required_recheck_scope');
  return {
    repair_scope: repairScope,
    failed_criterion: nonEmptyString(packet.failed_criterion, 'repair_work_packet.failed_criterion'),
    concrete_counterexample: nonEmptyString(packet.concrete_counterexample, 'repair_work_packet.concrete_counterexample'),
    required_recheck_scope: recheckScope,
    repair_diff_basis: opaque(packet.repair_diff_basis, 'repair_work_packet.repair_diff_basis'),
  };
}

/** Canonical alias matching the short template name. */
export const validateRepairWorkPacket = validateBoundedRepairWorkPacket;
/** Canonical aliases used by callers that spell out the per-task wording. */
export const validateTaskJitReadSet = validateJitReadSet;
export const validatePerTaskJitReadSet = validateJitReadSet;

/**
 * Determine which closed Work Packet shape an input intends to use.  This is
 * only a dispatch helper; it does not accept the input or relax a validator.
 */
export function getWorkPacketShape(value: unknown): WorkPacketShape {
  const object = isObject(value) ? value : undefined;
  if (object !== undefined && Object.prototype.hasOwnProperty.call(object, 'repair_scope')) return 'repair';
  if (object !== undefined && Object.prototype.hasOwnProperty.call(object, 'task_id')) return 'jit';
  return 'slice';
}

export type ValidatedWorkPacket = SliceWorkPacket | JitReadSet | BoundedRepairWorkPacket;

/** Validate any of the three canonical shapes using closed-shape dispatch. */
export function validateWorkPacket(value: unknown, shape: WorkPacketShape = getWorkPacketShape(value)): ValidatedWorkPacket {
  if (shape === 'slice') return validateSliceWorkPacket(value);
  if (shape === 'jit') return validateJitReadSet(value);
  if (shape === 'repair') return validateBoundedRepairWorkPacket(value);
  // Defensive guard for JavaScript callers passing an unknown discriminator.
  fail('RESULT_INVALID', `unknown Work Packet shape ${JSON.stringify(shape)}`);
}

/** Convenience alias for generic callers. */
export const validatePacket = validateWorkPacket;
