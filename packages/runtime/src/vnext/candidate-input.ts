/**
 * Adapter for the active pluginv2 candidate-input contract.
 *
 * The active materializer owns the candidate JSON shape; Runtime owns the
 * version-2 compiler input.  This adapter is deliberately structural: it
 * copies only facts present in the candidate input into a
 * `CompileVNextManifestInput`, derives the Runtime-owned proof digest from
 * that structured boundary, and never reads or derives plan semantics from
 * the Markdown projection.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  VNEXT_REFERENCE_KINDS,
  type VNextCanonicalPlan,
  type VNextExecutionScope,
  type VNextReferenceKind,
} from '@proofloop/kernel';
import { canonicalPathWithinRoot } from '../path-guard';
import {
  parseEntityRef,
  readRootBoundFile,
} from './entity-resolver';
import {
  type CompileVNextManifestInput,
  type VNextReferenceSeed,
  type VNextSliceSeed,
} from './compiler';
// S09-C-T03: the shared canonical Stage ID guard (`^S\d+$`).  Legacy parked
// labels such as S08B0/S08B fail closed before any Runtime read/write.
import { CANONICAL_STAGE_ID_RE } from './stage-id';

const ACTIVE_OWNER = 'pluginv2-active-plan-materializer';
const ACTIVE_CALLER = 'brain';
const ACTIVE_SCHEMA_VERSION = 2;

const TOP_LEVEL_FIELDS = new Set([
  'schema_version',
  'mode',
  'caller',
  'owner',
  'project_root',
  'stage_id',
  'candidate_plan_path',
  'selected_work_item_refs',
  'authority_entity_refs',
  'existing_plan_ref',
  'finding_refs',
  'stage_goal',
  'dependencies',
  'constraints',
  'out_of_scope',
  'reference_index',
  'slices',
]);
const STAGE_GOAL_FIELDS = new Set(['entity_id', 'ref_id', 'goal', 'refs']);
const REFERENCE_FIELDS = new Set(['ref_id', 'kind', 'ref']);
const SLICE_FIELDS = new Set([
  'slice_id',
  'goal_entity_id',
  'goal',
  'proof_index',
  'dependencies',
  'required_skills',
  'evidence_path',
  'tasks',
]);
const PROOF_INDEX_FIELDS = new Set([
  'slice_id',
  'goal_ref',
  'task_refs',
  'acceptance_refs',
  'seam_refs',
  'oracle_refs',
  'risk_refs',
]);
const RISK_FIELDS = new Set([
  'ref_id',
  'applies_to_acceptance_refs',
  'applies_to_seam_refs',
]);
const NOT_APPLICABLE_FIELDS = new Set(['reason']);
const TASK_FIELDS = new Set([
  'task_id',
  'entity_id',
  'goal',
  'refs',
  'dependencies',
  'required_skills',
  'execution_scope',
  'checkbox',
  'status',
  'cv_status',
]);
const EXECUTION_SCOPE_FIELDS = new Set([
  'kind',
  'code_paths',
  'test_paths',
  'forbidden_paths',
]);

export interface ActiveCandidateReference {
  readonly ref_id: string;
  readonly kind: VNextReferenceKind;
  readonly ref: string;
}

export interface ActiveCandidateRiskBinding {
  readonly ref_id: string;
  readonly applies_to_acceptance_refs: string[];
  readonly applies_to_seam_refs: string[];
}

export interface ActiveCandidateProofIndex {
  readonly slice_id: string;
  readonly goal_ref: string;
  readonly task_refs: string[];
  readonly acceptance_refs: string[];
  readonly seam_refs: string[];
  readonly oracle_refs: string[];
  readonly risk_refs: ActiveCandidateRiskBinding[];
}

export interface ActiveCandidateTask {
  readonly task_id: string;
  readonly entity_id: string;
  readonly goal: string;
  readonly refs: string[];
  readonly dependencies: string[];
  readonly required_skills: string[];
  readonly execution_scope: VNextExecutionScope;
  readonly checkbox: boolean;
  readonly status: string;
  readonly cv_status: string;
}

export interface ActiveCandidateSlice {
  readonly slice_id: string;
  readonly goal_entity_id: string;
  readonly goal: string;
  readonly proof_index: ActiveCandidateProofIndex;
  readonly dependencies: string[];
  readonly required_skills: string[];
  readonly evidence_path: string;
  readonly tasks: ActiveCandidateTask[];
}

export interface ActiveCandidateInput {
  readonly schema_version: 2;
  readonly mode: 'initial' | 'replan';
  readonly caller: 'brain';
  readonly owner: typeof ACTIVE_OWNER;
  readonly project_root: string;
  readonly stage_id: string;
  readonly candidate_plan_path: string;
  readonly selected_work_item_refs: string[];
  readonly authority_entity_refs: string[];
  readonly existing_plan_ref: string | null;
  readonly finding_refs: string[];
  readonly stage_goal: {
    readonly entity_id: string;
    readonly ref_id: string;
    readonly goal: string;
    readonly refs: string[];
  };
  readonly dependencies: string[];
  readonly constraints: string[];
  readonly out_of_scope: string[];
  readonly reference_index: ActiveCandidateReference[];
  readonly slices: ActiveCandidateSlice[];
}

export type CandidateInputErrorCode =
  | 'invalid-schema'
  | 'root-mismatch'
  | 'path-escape'
  | 'reference-binding'
  | 'candidate-only';

/** Structured, fail-closed error from the active candidate adapter. */
export class CandidateInputError extends Error {
  public readonly code: CandidateInputErrorCode;

  constructor(code: CandidateInputErrorCode, message: string) {
    super(message);
    this.name = 'CandidateInputError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: CandidateInputErrorCode, message: string): never {
  throw new CandidateInputError(code, message);
}

function checkFields(value: unknown, allowed: ReadonlySet<string>, field: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail('invalid-schema', `${field} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('invalid-schema', `${field} contains unknown field "${key}"`);
    }
  }
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
    fail('invalid-schema', `${field} must be a non-empty single-line string`);
  }
  return value;
}

function identifier(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) {
    fail('invalid-schema', `${field} is not a stable identifier`);
  }
  return result;
}

function refId(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (!/^REF-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) {
    fail('invalid-schema', `${field} is not a stable ref_id`);
  }
  return result;
}

function stringArray(value: unknown, field: string, unique = false): string[] {
  if (!Array.isArray(value)) fail('invalid-schema', `${field} must be an array`);
  const result = value.map((item, index) => stringValue(item, `${field}[${index}]`));
  if (unique && new Set(result).size !== result.length) {
    fail('invalid-schema', `${field} contains duplicate values`);
  }
  return result;
}

function canonicalRoot(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (!path.isAbsolute(result)) fail('path-escape', `${field} must be an absolute canonical trust root`);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(result);
  } catch (error) {
    fail('path-escape', `${field} is not readable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isDirectory()) fail('path-escape', `${field} is not a directory`);
  try {
    return fs.realpathSync(result);
  } catch (error) {
    fail('path-escape', `${field} cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSameRoot(trustedRoot: string | undefined, embeddedRoot: unknown): string {
  const embedded = canonicalRoot(embeddedRoot, 'candidate.project_root');
  if (trustedRoot === undefined) return embedded;
  const trusted = canonicalRoot(trustedRoot, 'trusted project root');
  if (trusted !== embedded) {
    fail(
      'root-mismatch',
      `candidate.project_root resolves to "${embedded}", not the trusted project root "${trusted}"`,
    );
  }
  return trusted;
}

function rootRelative(root: string, value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (
    result.includes('\\') ||
    path.isAbsolute(result) ||
    result.startsWith('//') ||
    /^[A-Za-z]:(?:\/|$)/.test(result) ||
    result.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    fail('path-escape', `${field} must be a canonical root-relative path`);
  }
  const canonical = canonicalPathWithinRoot(root, result);
  if (canonical === null) fail('path-escape', `${field} escapes the project root: "${result}"`);
  const canonicalRelative = path.relative(root, canonical).split(path.sep).join('/');
  if (canonicalRelative !== result) {
    fail(
      'path-escape',
      `${field} is not bound to its canonical root-relative path: "${result}" resolves as "${canonicalRelative}"`,
    );
  }
  return result;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function parseExecutionScope(root: string, value: unknown, field: string): VNextExecutionScope {
  checkFields(value, EXECUTION_SCOPE_FIELDS, field);
  const kind = stringValue(value.kind, `${field}.kind`);
  if (kind !== 'implementation' && kind !== 'evidence-only') {
    fail('invalid-schema', `${field}.kind must be implementation or evidence-only`);
  }
  const codePaths = stringArray(value.code_paths, `${field}.code_paths`, true)
    .map((item, index) => rootRelative(root, item, `${field}.code_paths[${index}]`));
  const testPaths = stringArray(value.test_paths, `${field}.test_paths`, true)
    .map((item, index) => rootRelative(root, item, `${field}.test_paths[${index}]`));
  const forbiddenPaths = stringArray(value.forbidden_paths, `${field}.forbidden_paths`, true)
    .map((item, index) => rootRelative(root, item, `${field}.forbidden_paths[${index}]`));

  if (kind === 'implementation' && codePaths.length === 0) {
    fail('invalid-schema', `${field}.code_paths must be non-empty for implementation scope`);
  }
  if (kind === 'implementation' && testPaths.length === 0) {
    fail('invalid-schema', `${field}.test_paths must be non-empty for implementation scope`);
  }
  for (const executable of [...codePaths, ...testPaths]) {
    for (const forbidden of forbiddenPaths) {
      if (pathsOverlap(executable, forbidden)) {
        fail('path-escape', `${field}.forbidden_paths overlaps executable path "${executable}"`);
      }
    }
  }
  return {
    kind: kind as VNextExecutionScope['kind'],
    code_paths: codePaths,
    test_paths: testPaths,
    forbidden_paths: forbiddenPaths,
  };
}

function canonicalEntityReference(root: string, value: unknown, field: string): string {
  const result = stringValue(value, field);
  let parsed: ReturnType<typeof parseEntityRef>;
  try {
    parsed = parseEntityRef(result);
  } catch (error) {
    fail('reference-binding', `${field} is not a valid entity reference: ${error instanceof Error ? error.message : String(error)}`);
  }
  const relative = rootRelative(root, parsed.path, `${field} path`);
  const canonical = `${relative}#/entities/${parsed.entityId}`;
  if (canonical !== result) {
    fail('reference-binding', `${field} is not canonical; expected "${canonical}"`);
  }
  return canonical;
}

function requireRegistered(
  value: unknown,
  field: string,
  refs: ReadonlyMap<string, ActiveCandidateReference>,
  expectedKind?: VNextReferenceKind,
): string {
  const id = refId(value, field);
  const descriptor = refs.get(id);
  if (descriptor === undefined) {
    fail('reference-binding', `${field} points to unregistered ref_id ${id}`);
  }
  if (expectedKind !== undefined && descriptor.kind !== expectedKind) {
    fail(
      'reference-binding',
      `${field} expects kind "${expectedKind}" but ${id} is "${descriptor.kind}"`,
    );
  }
  return id;
}

function ensureEntityId(ref: string, expected: string, field: string, refs: ReadonlyMap<string, ActiveCandidateReference>): void {
  const descriptor = refs.get(ref);
  if (descriptor === undefined) fail('reference-binding', `${field} points to an unregistered ref_id ${ref}`);
  let parsed: ReturnType<typeof parseEntityRef>;
  try {
    parsed = parseEntityRef(descriptor.ref);
  } catch (error) {
    fail('reference-binding', `${field} has an invalid entity ref: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed.entityId !== expected) {
    fail('reference-binding', `${field} must point to entity "${expected}"`);
  }
}

function uniqueRefs(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function cloneExecutionScope(scope: VNextExecutionScope): VNextExecutionScope {
  return {
    kind: scope.kind,
    code_paths: [...scope.code_paths],
    test_paths: [...scope.test_paths],
    forbidden_paths: [...scope.forbidden_paths],
  };
}

function activeCandidate(value: unknown): ActiveCandidateInput {
  checkFields(value, TOP_LEVEL_FIELDS, 'candidate input');

  if (value.schema_version !== ACTIVE_SCHEMA_VERSION) {
    fail('invalid-schema', `candidate input.schema_version must be ${ACTIVE_SCHEMA_VERSION}`);
  }
  if (value.mode !== 'initial' && value.mode !== 'replan') {
    fail('invalid-schema', 'candidate input.mode must be initial or replan');
  }
  if (value.caller !== ACTIVE_CALLER) fail('invalid-schema', 'candidate input.caller must be brain');
  if (value.owner !== ACTIVE_OWNER) {
    fail('invalid-schema', `candidate input.owner must be ${ACTIVE_OWNER}`);
  }

  const projectRoot = canonicalRoot(value.project_root, 'candidate input.project_root');
  // S09-C-T03: canonical Stage ID grammar — the SAME `^S\d+$` rule as the
  // compiler, Mechanical Validator, plan/stage/review status and every
  // admission seam.  Legacy parked labels (S08B0/S08B) fail closed here,
  // before the candidate_plan_path is derived or any Runtime read happens.
  const stageId = stringValue(value.stage_id, 'candidate input.stage_id');
  if (!CANONICAL_STAGE_ID_RE.test(stageId)) {
    fail(
      'invalid-schema',
      `candidate input.stage_id "${stageId}" is not a canonical Stage ID (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected`,
    );
  }
  const candidatePath = rootRelative(projectRoot, value.candidate_plan_path, 'candidate input.candidate_plan_path');
  const expectedCandidatePath = `delivery/stages/${stageId}/tasks.md`;
  if (candidatePath !== expectedCandidatePath) {
    fail('path-escape', `candidate input.candidate_plan_path must be ${expectedCandidatePath}`);
  }

  const selectedWorkItems = stringArray(value.selected_work_item_refs, 'candidate input.selected_work_item_refs');
  const authorityEntityRefs = stringArray(value.authority_entity_refs, 'candidate input.authority_entity_refs');
  const normalizedSelected = selectedWorkItems.map((ref, index) =>
    canonicalEntityReference(projectRoot, ref, `candidate input.selected_work_item_refs[${index}]`),
  );
  const normalizedAuthority = authorityEntityRefs.map((ref, index) =>
    canonicalEntityReference(projectRoot, ref, `candidate input.authority_entity_refs[${index}]`),
  );
  const existingPlanRef = value.existing_plan_ref === null || value.existing_plan_ref === undefined
    ? null
    : rootRelative(projectRoot, value.existing_plan_ref, 'candidate input.existing_plan_ref');
  if (existingPlanRef !== null && existingPlanRef !== candidatePath) {
    fail('invalid-schema', 'candidate input.existing_plan_ref must name candidate_plan_path');
  }
  if (value.mode === 'replan' && existingPlanRef === null) {
    fail('invalid-schema', 'replan candidate input requires existing_plan_ref');
  }

  const findingRefs = stringArray(value.finding_refs, 'candidate input.finding_refs');
  const dependencies = stringArray(value.dependencies, 'candidate input.dependencies', true);
  const constraints = stringArray(value.constraints, 'candidate input.constraints');
  const outOfScope = stringArray(value.out_of_scope, 'candidate input.out_of_scope');

  checkFields(value.stage_goal, STAGE_GOAL_FIELDS, 'candidate input.stage_goal');
  const stageGoal = {
    entity_id: identifier(value.stage_goal.entity_id, 'candidate input.stage_goal.entity_id'),
    ref_id: refId(value.stage_goal.ref_id, 'candidate input.stage_goal.ref_id'),
    goal: stringValue(value.stage_goal.goal, 'candidate input.stage_goal.goal'),
    refs: stringArray(value.stage_goal.refs, 'candidate input.stage_goal.refs', true),
  };
  if (stageGoal.entity_id !== `${stageId}-goal`) {
    fail('invalid-schema', 'candidate input.stage_goal.entity_id must be <stage-id>-goal');
  }

  if (!Array.isArray(value.reference_index)) {
    fail('invalid-schema', 'candidate input.reference_index must be an array');
  }
  const references: ActiveCandidateReference[] = [];
  const refsById = new Map<string, ActiveCandidateReference>();
  const refsByRef = new Map<string, ActiveCandidateReference>();
  for (const [index, raw] of value.reference_index.entries()) {
    checkFields(raw, REFERENCE_FIELDS, `candidate input.reference_index[${index}]`);
    const ref = {
      ref_id: refId(raw.ref_id, `candidate input.reference_index[${index}].ref_id`),
      kind: stringValue(raw.kind, `candidate input.reference_index[${index}].kind`) as VNextReferenceKind,
      ref: canonicalEntityReference(projectRoot, raw.ref, `candidate input.reference_index[${index}].ref`),
    };
    if (!(VNEXT_REFERENCE_KINDS as readonly string[]).includes(ref.kind)) {
      fail('invalid-schema', `candidate input.reference_index[${index}].kind is not a vNext reference kind`);
    }
    if (refsById.has(ref.ref_id) || refsByRef.has(ref.ref)) {
      fail('reference-binding', `candidate input.reference_index contains duplicate ref_id or entity ref ${ref.ref_id}`);
    }
    references.push(ref);
    refsById.set(ref.ref_id, ref);
    refsByRef.set(ref.ref, ref);
  }

  const stageRef = requireRegistered(stageGoal.ref_id, 'candidate input.stage_goal.ref_id', refsById, 'goal');
  ensureEntityId(stageRef, stageGoal.entity_id, 'candidate input.stage_goal.ref_id', refsById);
  for (const [index, ref] of stageGoal.refs.entries()) {
    requireRegistered(ref, `candidate input.stage_goal.refs[${index}]`, refsById);
  }
  for (const [index, ref] of normalizedSelected.entries()) {
    if (!refsByRef.has(ref)) fail('reference-binding', `selected_work_item_refs[${index}] is not indexed`);
  }
  for (const [index, ref] of normalizedAuthority.entries()) {
    if (!refsByRef.has(ref)) fail('reference-binding', `authority_entity_refs[${index}] is not indexed`);
  }

  if (!Array.isArray(value.slices)) fail('invalid-schema', 'candidate input.slices must be an array');
  if (value.slices.length === 0) fail('invalid-schema', 'candidate input.slices must contain at least one slice');
  const slices: ActiveCandidateSlice[] = [];
  const sliceIds = new Set<string>();
  const taskIds = new Set<string>();
  for (const [sliceIndex, rawSlice] of value.slices.entries()) {
    checkFields(rawSlice, SLICE_FIELDS, `candidate input.slices[${sliceIndex}]`);
    const sliceId = identifier(rawSlice.slice_id, `candidate input.slices[${sliceIndex}].slice_id`);
    if (!sliceId.startsWith(`${stageId}-`)) fail('invalid-schema', `${sliceId} is outside stage ${stageId}`);
    if (sliceIds.has(sliceId)) fail('invalid-schema', `duplicate slice_id ${sliceId}`);
    sliceIds.add(sliceId);
    const goalEntityId = identifier(rawSlice.goal_entity_id, `candidate input.slices[${sliceIndex}].goal_entity_id`);
    if (goalEntityId !== `${sliceId}-goal`) fail('invalid-schema', `${sliceId} goal_entity_id is not canonical`);
    const sliceGoal = stringValue(rawSlice.goal, `candidate input.slices[${sliceIndex}].goal`);
    const sliceDependencies = stringArray(rawSlice.dependencies, `candidate input.slices[${sliceIndex}].dependencies`, true);
    const requiredSkills = stringArray(rawSlice.required_skills, `candidate input.slices[${sliceIndex}].required_skills`, true);
    const evidencePath = rootRelative(projectRoot, rawSlice.evidence_path, `candidate input.slices[${sliceIndex}].evidence_path`);
    const expectedEvidencePath = `delivery/stages/${stageId}/evidence/${sliceId}.md`;
    if (evidencePath !== expectedEvidencePath) fail('path-escape', `evidence_path must be ${expectedEvidencePath}`);

    checkFields(rawSlice.proof_index, PROOF_INDEX_FIELDS, `candidate input.slices[${sliceIndex}].proof_index`);
    if (rawSlice.proof_index.slice_id !== sliceId) fail('reference-binding', `${sliceId} Proof Index slice_id mismatch`);
    const proof: ActiveCandidateProofIndex = {
      slice_id: sliceId,
      goal_ref: requireRegistered(rawSlice.proof_index.goal_ref, `slices[${sliceIndex}].proof_index.goal_ref`, refsById, 'goal'),
      task_refs: stringArray(rawSlice.proof_index.task_refs, `slices[${sliceIndex}].proof_index.task_refs`, true),
      acceptance_refs: stringArray(rawSlice.proof_index.acceptance_refs, `slices[${sliceIndex}].proof_index.acceptance_refs`, true),
      seam_refs: stringArray(rawSlice.proof_index.seam_refs, `slices[${sliceIndex}].proof_index.seam_refs`, true),
      oracle_refs: stringArray(rawSlice.proof_index.oracle_refs, `slices[${sliceIndex}].proof_index.oracle_refs`, true),
      risk_refs: [],
    };
    if (proof.goal_ref === stageGoal.ref_id) fail('reference-binding', `${sliceId} Proof Index cannot reuse the stage goal ref`);
    ensureEntityId(proof.goal_ref, goalEntityId, `${sliceId}.proof_index.goal_ref`, refsById);
    for (const [index, ref] of proof.task_refs.entries()) requireRegistered(ref, `${sliceId}.proof_index.task_refs[${index}]`, refsById, 'task');
    for (const [index, ref] of proof.acceptance_refs.entries()) requireRegistered(ref, `${sliceId}.proof_index.acceptance_refs[${index}]`, refsById, 'acceptance');
    for (const [index, ref] of proof.seam_refs.entries()) requireRegistered(ref, `${sliceId}.proof_index.seam_refs[${index}]`, refsById, 'seam');
    for (const [index, ref] of proof.oracle_refs.entries()) requireRegistered(ref, `${sliceId}.proof_index.oracle_refs[${index}]`, refsById, 'oracle');
    if (proof.task_refs.length === 0 || proof.acceptance_refs.length === 0 || proof.seam_refs.length === 0 || proof.oracle_refs.length === 0) {
      fail('reference-binding', `${sliceId} Proof Index is incomplete`);
    }

    if (!Array.isArray(rawSlice.proof_index.risk_refs) || rawSlice.proof_index.risk_refs.length === 0) {
      fail('reference-binding', `${sliceId} Proof Index must declare risk_refs`);
    }
    const riskRefs: ActiveCandidateRiskBinding[] = [];
    const seenRisk = new Set<string>();
    for (const [riskIndex, rawRisk] of rawSlice.proof_index.risk_refs.entries()) {
      checkFields(rawRisk, RISK_FIELDS, `${sliceId}.proof_index.risk_refs[${riskIndex}]`);
      const riskId = requireRegistered(rawRisk.ref_id, `${sliceId}.proof_index.risk_refs[${riskIndex}].ref_id`, refsById, 'risk');
      if (seenRisk.has(riskId)) fail('reference-binding', `duplicate risk ref ${riskId} in ${sliceId}`);
      seenRisk.add(riskId);
      const appliesAcceptance = stringArray(rawRisk.applies_to_acceptance_refs, `${sliceId}.risk.applies_to_acceptance_refs`, true);
      const appliesSeam = stringArray(rawRisk.applies_to_seam_refs, `${sliceId}.risk.applies_to_seam_refs`, true);
      for (const ref of appliesAcceptance) {
        requireRegistered(ref, `${sliceId}.risk.applies_to_acceptance_refs`, refsById, 'acceptance');
        if (!proof.acceptance_refs.includes(ref)) fail('reference-binding', `${riskId} binds an unlisted acceptance ref`);
      }
      for (const ref of appliesSeam) {
        requireRegistered(ref, `${sliceId}.risk.applies_to_seam_refs`, refsById, 'seam');
        if (!proof.seam_refs.includes(ref)) fail('reference-binding', `${riskId} binds an unlisted seam ref`);
      }
      riskRefs.push({ ref_id: riskId, applies_to_acceptance_refs: appliesAcceptance, applies_to_seam_refs: appliesSeam });
    }

    if (!Array.isArray(rawSlice.tasks) || rawSlice.tasks.length === 0) fail('invalid-schema', `${sliceId} must contain at least one task`);
    const tasks: ActiveCandidateTask[] = [];
    const taskRefSet = new Set<string>();
    for (const [taskIndex, rawTask] of rawSlice.tasks.entries()) {
      checkFields(rawTask, TASK_FIELDS, `${sliceId}.tasks[${taskIndex}]`);
      const taskId = identifier(rawTask.task_id, `${sliceId}.tasks[${taskIndex}].task_id`);
      if (!taskId.startsWith(`${sliceId}-`)) fail('invalid-schema', `${taskId} is outside slice ${sliceId}`);
      if (taskIds.has(taskId)) fail('invalid-schema', `duplicate task_id ${taskId}`);
      taskIds.add(taskId);
      const entityId = identifier(rawTask.entity_id, `${taskId}.entity_id`);
      if (entityId !== taskId) fail('invalid-schema', `${taskId}.entity_id must equal task_id`);
      const taskRefs = stringArray(rawTask.refs, `${taskId}.refs`, true);
      let hasTaskRef = false;
      for (const ref of taskRefs) {
        const descriptor = refsById.get(ref);
        if (descriptor === undefined) fail('reference-binding', `${taskId} uses unregistered ref_id ${ref}`);
        if (descriptor.kind === 'task') {
          hasTaskRef = true;
          taskRefSet.add(ref);
          ensureEntityId(ref, entityId, `${taskId}.refs`, refsById);
        }
      }
      if (!hasTaskRef) fail('reference-binding', `${taskId} has no task-kind entity ref`);
      const executionScope = parseExecutionScope(projectRoot, rawTask.execution_scope, `${taskId}.execution_scope`);
      if (rawTask.checkbox !== false || rawTask.status !== 'NOT_STARTED' || rawTask.cv_status !== 'NOT_RUN') {
        fail('candidate-only', `${taskId} is not candidate-only`);
      }
      tasks.push({
        task_id: taskId,
        entity_id: entityId,
        goal: stringValue(rawTask.goal, `${taskId}.goal`),
        refs: taskRefs,
        dependencies: stringArray(rawTask.dependencies, `${taskId}.dependencies`, true),
        required_skills: stringArray(rawTask.required_skills, `${taskId}.required_skills`, true),
        execution_scope: executionScope,
        checkbox: false,
        status: 'NOT_STARTED',
        cv_status: 'NOT_RUN',
      });
    }
    if (taskRefSet.size !== new Set(proof.task_refs).size || [...taskRefSet].some((ref) => !proof.task_refs.includes(ref))) {
      fail('reference-binding', `${sliceId} task_refs do not close over task entities`);
    }
    slices.push({
      slice_id: sliceId,
      goal_entity_id: goalEntityId,
      goal: sliceGoal,
      proof_index: { ...proof, risk_refs: riskRefs },
      dependencies: sliceDependencies,
      required_skills: requiredSkills,
      evidence_path: evidencePath,
      tasks,
    });
  }

  const sliceDependencyMap = new Map(slices.map((slice) => [slice.slice_id, slice.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (sliceId: string): void => {
    if (visiting.has(sliceId)) fail('invalid-schema', `slice dependency cycle includes ${sliceId}`);
    if (visited.has(sliceId)) return;
    visiting.add(sliceId);
    for (const dependency of sliceDependencyMap.get(sliceId) ?? []) {
      if (sliceDependencyMap.has(dependency)) visit(dependency);
    }
    visiting.delete(sliceId);
    visited.add(sliceId);
  };
  for (const slice of slices) visit(slice.slice_id);

  return {
    schema_version: 2,
    mode: value.mode,
    caller: 'brain',
    owner: ACTIVE_OWNER,
    project_root: projectRoot,
    stage_id: stageId,
    candidate_plan_path: candidatePath,
    selected_work_item_refs: normalizedSelected,
    authority_entity_refs: normalizedAuthority,
    existing_plan_ref: existingPlanRef,
    finding_refs: findingRefs,
    stage_goal: stageGoal,
    dependencies,
    constraints,
    out_of_scope: outOfScope,
    reference_index: references,
    slices,
  };
}

/** Return true only for the active materializer candidate shape. */
export function isActiveCandidateInput(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (
    Object.prototype.hasOwnProperty.call(value, 'candidate_plan_path') ||
    Object.prototype.hasOwnProperty.call(value, 'reference_index')
  );
}

/** Validate and adapt active candidate JSON into the Runtime compiler input. */
export function adaptCandidateInputToCompileVNextManifestInput(
  value: unknown,
  trustedRoot?: string,
): CompileVNextManifestInput {
  const candidate = activeCandidate(value);
  const root = assertSameRoot(trustedRoot, candidate.project_root);
  if (root !== candidate.project_root) {
    // `activeCandidate` canonicalizes the embedded root.  This branch keeps
    // the root binding explicit if a caller supplied a non-canonical spelling.
    fail('root-mismatch', 'candidate input root is not canonical');
  }

  const refsById = new Map(candidate.reference_index.map((ref) => [ref.ref_id, ref]));
  const stageRefs = [candidate.stage_goal.ref_id];
  const planItems: VNextCanonicalPlan['items'] = [
    {
      id: candidate.stage_id,
      kind: 'stage',
      goal: candidate.stage_goal.goal,
      refs: stageRefs,
      dependencies: [...candidate.dependencies],
      required_skills: [],
    },
  ];
  const slices: VNextSliceSeed[] = [];
  for (const slice of candidate.slices) {
    const proofRefs = uniqueRefs([
      slice.proof_index.goal_ref,
      ...slice.proof_index.task_refs,
      ...slice.proof_index.acceptance_refs,
      ...slice.proof_index.seam_refs,
      ...slice.proof_index.oracle_refs,
      ...slice.proof_index.risk_refs.map((risk) => risk.ref_id),
    ]);
    planItems.push({
      id: slice.slice_id,
      kind: 'slice',
      goal: slice.goal,
      refs: proofRefs,
      dependencies: [...slice.dependencies],
      required_skills: [...slice.required_skills],
    });
    for (const task of slice.tasks) {
      planItems.push({
        id: task.task_id,
        kind: 'task',
        goal: task.goal,
        refs: [...task.refs],
        dependencies: [...task.dependencies],
        required_skills: [...task.required_skills],
        execution_scope: cloneExecutionScope(task.execution_scope),
        checkbox: task.checkbox,
        status: task.status,
        cv_status: task.cv_status,
      });
    }
    slices.push({
      slice_id: slice.slice_id,
      proof_index: slice.proof_index,
      required_skills: [...slice.required_skills],
      depends_on: [...slice.dependencies],
      evidence_path: slice.evidence_path,
    });
  }

  const authorityRefIds = candidate.authority_entity_refs.map((ref, index) => {
    const descriptor = candidate.reference_index.find((entry) => entry.ref === ref);
    if (descriptor === undefined) {
      fail('reference-binding', `authority_entity_refs[${index}] is not indexed`);
    }
    return descriptor.ref_id;
  });

  // Keep this lookup in the adapter so a future schema change cannot silently
  // drop an indexed reference while constructing the closed compiler input.
  for (const ref of stageRefs) {
    if (!refsById.has(ref)) fail('reference-binding', `plan stage ref ${ref} is not indexed`);
  }

  return {
    root: candidate.project_root,
    stage_id: candidate.stage_id,
    plan: { schema_version: 2, items: planItems },
    plan_path: candidate.candidate_plan_path,
    refs: candidate.reference_index.map((ref): VNextReferenceSeed => ({
      ref_id: ref.ref_id,
      kind: ref.kind,
      ref: ref.ref,
    })),
    slices,
    authority_ref_ids: authorityRefIds,
  };
}

/** Naming alias used by Host/CLI adapters. */
export const candidateInputToCompileVNextManifestInput =
  adaptCandidateInputToCompileVNextManifestInput;

/** Read one candidate-input JSON object through the Runtime trust boundary. */
export function readActiveCandidateInput(
  root: string,
  inputPath: string,
): { readonly input: ActiveCandidateInput; readonly filePath: string } {
  const read = readRootBoundFile(root, inputPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content) as unknown;
  } catch (error) {
    fail('invalid-schema', `candidate input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidate = activeCandidate(parsed);
  const trusted = canonicalRoot(root, 'trusted project root');
  if (candidate.project_root !== trusted) {
    fail('root-mismatch', `candidate input.project_root must equal trusted project root "${trusted}"`);
  }
  return { input: candidate, filePath: read.filePath };
}
