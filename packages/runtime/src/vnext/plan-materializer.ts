/**
 * plan-materializer.ts — Runtime TypeScript port of the active Plan
 * Materializer deterministic rendering pipeline (A1 step 2).
 *
 * Ported from `.agents/skills/proofloop-plan/references/
 * active-plan-materializer.mjs` (A1).  Every function is ported
 * function-for-function with zero semantic change: validateInput →
 * renderCandidatePlan → validateRenderedDocument →
 * atomicWriteCandidate, plus the closed-schema field sets, fail-closed
 * behavior (result/route_code/subtype/reason), and byte-identical rendering.
 *
 * The materializer accepts ONE closed, structured planning input and writes
 * only the candidate tasks.md named by that input.  Runtime remains the
 * owner of Manifest compilation, validation, Evidence initialization,
 * SPV/admission and Receipt writes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

const OWNER = 'pluginv2-active-plan-materializer';
const CALLER = 'brain';
const SCHEMA_VERSION = 2;
const KINDS = new Set(['goal', 'task', 'acceptance', 'seam', 'oracle', 'risk', 'proof_spec']);
const REF_ID_RE = /^REF-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENTITY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENTITY_MARKER_RE = /^<!--\s*proofloop:entity\s+id="([^"]+)"\s+kind="([^"]+)"\s*-->\s*$/;

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
const RISK_BINDING_FIELDS = new Set([
  'ref_id',
  'applies_to_acceptance_refs',
  'applies_to_seam_refs',
]);
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

const FORBIDDEN_FIELD_NAMES = new Set([
  'manifest',
  'manifest_path',
  'evidence_dir',
  'receipt',
  'receipt_path',
  'runtime_state',
  'commands',
  'worker_packet',
  'cv_packet',
  'implementation_files',
  'implementation_steps',
  'code_files',
  'admission',
  'plan_digest',
  'file_digest',
  'section_digest',
  // `proof_digest` is Runtime-owned and derived at compile time;
  // a caller-supplied digest is never part of the closed candidate contract.
  'proof_digest',
]);

// ============================================================
// Structured error + fail-closed helpers (ported verbatim)
// ============================================================

/** Structured materializer failure (result/route_code/subtype/reason). */
export class MaterializerError extends Error {
  public readonly result: string;
  public readonly routeCode: string;
  public readonly subtype: string;
  public readonly reason: string;
  public readonly affectedArtifacts: string[];

  constructor(options: {
    result: string;
    routeCode: string;
    subtype: string;
    reason: string;
    affectedArtifacts?: string[];
  }) {
    super(options.reason);
    this.name = 'MaterializerError';
    this.result = options.result;
    this.routeCode = options.routeCode;
    this.subtype = options.subtype;
    this.reason = options.reason;
    this.affectedArtifacts = options.affectedArtifacts ?? [];
  }
}

function fail(
  result: string,
  routeCode: string,
  subtype: string,
  reason: string,
  affectedArtifacts: string[] = [],
): never {
  throw new MaterializerError({ result, routeCode, subtype, reason, affectedArtifacts });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function checkFields(
  value: unknown,
  allowed: ReadonlySet<string>,
  where: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${where} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_FIELD_NAMES.has(key)) {
      fail(
        'PLAN_DEFECT',
        'PLAN_GAP',
        'FORBIDDEN_PLAN_FIELD',
        `${where}.${key} is outside the active candidate contract`,
      );
    }
    if (!allowed.has(key)) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `Unknown field ${where}.${key}`);
    }
  }
}

function requireString(value: unknown, where: string, options: { singleLine?: boolean } = {}): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${where} must be a non-empty string`);
  }
  if (options.singleLine === true && /[\r\n]/.test(value)) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${where} must be a single line`);
  }
  return value;
}

function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${where} must be an array`);
  }
  return value;
}

function stringArray(value: unknown, where: string, options: { unique?: boolean; singleLine?: boolean } = {}): string[] {
  const array = requireArray(value, where);
  // Port of the helper default `singleLine = true`: every array item must be
  // a single line unless a call site explicitly opts out (no call site does).
  const singleLine = options.singleLine ?? true;
  const result = array.map((item, index) => requireString(item, `${where}[${index}]`, { singleLine }));
  if (options.unique === true && new Set(result).size !== result.length) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'DUPLICATE_PLAN_REFERENCE', `${where} contains duplicate values`);
  }
  return result;
}

function identifier(value: unknown, where: string): string {
  const result = requireString(value, where, { singleLine: true });
  if (!ENTITY_ID_RE.test(result)) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${where} is not a stable entity identifier`);
  }
  return result;
}

function refId(value: unknown, where: string): string {
  const result = requireString(value, where, { singleLine: true });
  if (!REF_ID_RE.test(result)) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${where} is not a stable ref_id`);
  }
  return result;
}

function canonicalEntityRef(value: unknown, where: string): string {
  const result = requireString(value, where, { singleLine: true });
  if (result.includes('\\')) {
    fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', `${where} must use root-relative '/' paths`);
  }
  const hash = result.indexOf('#');
  if (hash <= 0 || result.indexOf('#', hash + 1) !== -1) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'INVALID_ENTITY_REFERENCE', `${where} must contain one entity fragment`);
  }
  const pathPart = result.slice(0, hash);
  const fragment = result.slice(hash + 1);
  const segments = pathPart.split('/');
  if (
    path.isAbsolute(pathPart) ||
    segments.includes('..') ||
    segments.includes('.') ||
    pathPart.startsWith('/') ||
    !/^\/entities\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fragment)
  ) {
    fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', `${where} is not a root-bound entity reference`);
  }
  return result;
}

function entityIdFromRef(ref: string): string {
  return ref.slice(ref.indexOf('#') + '#/entities/'.length);
}

function pathWithoutFragment(ref: string): string {
  return ref.slice(0, ref.indexOf('#'));
}

function assertRootRelativePath(value: unknown, where: string): string {
  const result = requireString(value, where, { singleLine: true });
  if (
    result.includes('\\') ||
    path.isAbsolute(result) ||
    result.startsWith('//') ||
    /^[A-Za-z]:(?:\/|$)/.test(result) ||
    result.split('/').some((part) => part.length === 0 || part === '..' || part === '.') ||
    result.startsWith('/')
  ) {
    fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', `${where} must be root-relative`);
  }
  return result;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function canonicalScopePath(root: string, value: unknown, where: string): string {
  const relative = assertRootRelativePath(value, where);
  const lexical = path.resolve(root, ...relative.split('/'));
  assertWithin(root, lexical, where);

  // Scope paths may point to files which do not exist yet, so resolve the
  // nearest existing ancestor. Any existing symlink must already be the
  // canonical lexical path and must remain inside the trust root.
  let existing = lexical;
  for (;;) {
    try {
      fs.lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', `${where} is not inspectable: ${error instanceof Error ? error.message : String(error)}`);
      }
      const parent = path.dirname(existing);
      if (parent === existing) {
        fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', `${where} has no readable root ancestor`);
      }
      existing = parent;
    }
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(existing);
  } catch (error) {
    fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', `${where} cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (canonical !== root) assertWithin(root, canonical, where);
  if (canonical !== existing) {
    fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', `${where} traverses a symlink or non-canonical path`);
  }
  return relative;
}

function parseExecutionScope(root: string, value: unknown, where: string): MaterializerExecutionScope {
  checkFields(value, EXECUTION_SCOPE_FIELDS, where);
  const kind = requireString(value.kind, `${where}.kind`, { singleLine: true });
  if (kind !== 'implementation' && kind !== 'evidence-only') {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${where}.kind must be implementation or evidence-only`);
  }
  const codePaths = stringArray(value.code_paths, `${where}.code_paths`, { unique: true })
    .map((item, index) => canonicalScopePath(root, item, `${where}.code_paths[${index}]`));
  const testPaths = stringArray(value.test_paths, `${where}.test_paths`, { unique: true })
    .map((item, index) => canonicalScopePath(root, item, `${where}.test_paths[${index}]`));
  const forbiddenPaths = stringArray(value.forbidden_paths, `${where}.forbidden_paths`, { unique: true })
    .map((item, index) => canonicalScopePath(root, item, `${where}.forbidden_paths[${index}]`));

  if (kind === 'implementation' && codePaths.length === 0) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${where}.code_paths must be non-empty for implementation scope`);
  }
  if (kind === 'implementation' && testPaths.length === 0) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${where}.test_paths must be non-empty for implementation scope`);
  }
  for (const executable of [...codePaths, ...testPaths]) {
    for (const forbidden of forbiddenPaths) {
      if (pathsOverlap(executable, forbidden)) {
        fail('PLAN_DEFECT', 'PLAN_GAP', 'FORBIDDEN_SCOPE_OVERLAP', `${where}.forbidden_paths overlaps executable path "${executable}"`);
      }
    }
  }
  return { kind, code_paths: codePaths, test_paths: testPaths, forbidden_paths: forbiddenPaths };
}

function assertWithin(root: string, candidate: string, where: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', `${where} escapes the canonical trust root`);
  }
}

function realRoot(projectRoot: string): string {
  const absolute = path.resolve(projectRoot);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', `project_root does not exist: ${projectRoot}`);
  }
  if (!stat.isDirectory()) {
    fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', `project_root is not a directory: ${projectRoot}`);
  }
  return fs.realpathSync(absolute);
}

// ============================================================
// Normalized plan types (pure type surface — no runtime behavior)
// ============================================================

export interface MaterializerExecutionScope {
  readonly kind: 'implementation' | 'evidence-only';
  readonly code_paths: string[];
  readonly test_paths: string[];
  readonly forbidden_paths: string[];
}

export interface MaterializerReferenceDescriptor {
  readonly ref_id: string;
  readonly kind: string;
  readonly ref: string;
}

export interface MaterializerRiskBinding {
  readonly ref_id: string;
  readonly applies_to_acceptance_refs: string[];
  readonly applies_to_seam_refs: string[];
}

export interface MaterializerProofIndex {
  readonly slice_id: string;
  readonly goal_ref: string;
  readonly task_refs: string[];
  readonly acceptance_refs: string[];
  readonly seam_refs: string[];
  readonly oracle_refs: string[];
  readonly risk_refs: MaterializerRiskBinding[];
}

export interface MaterializerTask {
  readonly task_id: string;
  readonly entity_id: string;
  readonly goal: string;
  readonly refs: string[];
  readonly dependencies: string[];
  readonly required_skills: string[];
  readonly execution_scope: MaterializerExecutionScope;
  readonly checkbox: boolean;
  readonly status: string;
  readonly cv_status: string;
}

export interface MaterializerSlice {
  readonly slice_id: string;
  readonly goal_entity_id: string;
  readonly goal: string;
  readonly proof_index: MaterializerProofIndex;
  readonly dependencies: string[];
  readonly required_skills: string[];
  readonly evidence_path: string;
  readonly tasks: MaterializerTask[];
}

export interface MaterializerStageGoal {
  readonly entity_id: string;
  readonly ref_id: string;
  readonly goal: string;
  readonly refs: string[];
}


/** Normalized closed planning input after validateInput (root_for_io is the canonical root). */
export interface MaterializerPlan {
  readonly schema_version: 2;
  readonly mode: 'initial' | 'replan';
  readonly caller: 'brain';
  readonly owner: 'pluginv2-active-plan-materializer';
  readonly project_root: string;
  readonly stage_id: string;
  readonly candidate_plan_path: string;
  readonly selected_work_item_refs: string[];
  readonly authority_entity_refs: string[];
  readonly existing_plan_ref: string | null;
  readonly finding_refs: string[];
  readonly stage_goal: MaterializerStageGoal;
  readonly dependencies: string[];
  readonly constraints: string[];
  readonly out_of_scope: string[];
  readonly reference_index: MaterializerReferenceDescriptor[];
  readonly slices: MaterializerSlice[];
  readonly root_for_io: string;
  readonly candidate_absolute: string;
}

// ============================================================
// validateInput (ported verbatim)
// ============================================================

export function validateInput(input: unknown): MaterializerPlan {
  checkFields(input, TOP_LEVEL_FIELDS, 'input');
  if (input.schema_version !== SCHEMA_VERSION) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `input.schema_version must be ${SCHEMA_VERSION}`);
  }
  if (input.mode !== 'initial' && input.mode !== 'replan') {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', 'input.mode must be initial or replan');
  }
  if (input.caller !== CALLER) {
    fail('BLOCKED', 'OWNER_MISMATCH', 'ACTIVE_PLAN_MATERIALIZER_UNRESOLVED', 'input.caller must be brain');
  }
  if (input.owner !== OWNER) {
    fail('BLOCKED', 'OWNER_MISMATCH', 'ACTIVE_PLAN_MATERIALIZER_UNRESOLVED', 'input.owner is not the active pluginv2 owner');
  }

  const projectRoot = requireString(input.project_root, 'input.project_root', { singleLine: true });
  if (!path.isAbsolute(projectRoot)) {
    fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', 'project_root must be absolute');
  }
  const root = realRoot(projectRoot);
  const stageId = identifier(input.stage_id, 'input.stage_id');
  const candidatePath = assertRootRelativePath(input.candidate_plan_path, 'input.candidate_plan_path');
  const expectedCandidatePath = `delivery/stages/${stageId}/tasks.md`;
  if (candidatePath !== expectedCandidatePath) {
    fail(
      'RUNTIME_BLOCKER',
      'RUNTIME_BLOCKER',
      'CANDIDATE_PATH_ESCAPE',
      `candidate_plan_path must be ${expectedCandidatePath}`,
    );
  }
  const candidateAbsolute = path.resolve(root, ...candidatePath.split('/'));
  assertWithin(root, candidateAbsolute, 'candidate_plan_path');

  const selectedWorkItems = stringArray(input.selected_work_item_refs, 'input.selected_work_item_refs');
  const authorityRefs = stringArray(input.authority_entity_refs, 'input.authority_entity_refs');
  for (const [index, ref] of [...selectedWorkItems, ...authorityRefs].entries()) {
    canonicalEntityRef(ref, `input.authority_ref[${index}]`);
  }

  if (input.existing_plan_ref !== null && input.existing_plan_ref !== undefined) {
    const existing = assertRootRelativePath(input.existing_plan_ref, 'input.existing_plan_ref');
    if (existing !== candidatePath) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', 'existing_plan_ref must name the candidate tasks.md');
    }
  }
  if (input.mode === 'replan' && input.existing_plan_ref == null) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', 'replan requires existing_plan_ref');
  }
  const findingRefs = stringArray(input.finding_refs, 'input.finding_refs');
  const dependencies = stringArray(input.dependencies, 'input.dependencies', { unique: true });
  const constraints = stringArray(input.constraints, 'input.constraints');
  const outOfScope = stringArray(input.out_of_scope, 'input.out_of_scope');

  checkFields(input.stage_goal, STAGE_GOAL_FIELDS, 'input.stage_goal');
  const stageGoal = {
    entity_id: identifier(input.stage_goal.entity_id, 'input.stage_goal.entity_id'),
    ref_id: refId(input.stage_goal.ref_id, 'input.stage_goal.ref_id'),
    goal: requireString(input.stage_goal.goal, 'input.stage_goal.goal', { singleLine: true }),
    refs: stringArray(input.stage_goal.refs, 'input.stage_goal.refs', { unique: true }),
  };
  if (stageGoal.entity_id !== `${stageId}-goal`) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', 'stage_goal.entity_id must be <stage-id>-goal');
  }

  const referenceIndex: MaterializerReferenceDescriptor[] = [];
  const refById = new Map<string, MaterializerReferenceDescriptor>();
  const refByPath = new Map<string, MaterializerReferenceDescriptor>();
  const referenceIndexArray = requireArray(input.reference_index, 'input.reference_index');
  for (let index = 0; index < referenceIndexArray.length; index += 1) {
    const entry = referenceIndexArray[index];
    checkFields(entry, REFERENCE_FIELDS, `input.reference_index[${index}]`);
    const ref_id = refId(entry.ref_id, `input.reference_index[${index}].ref_id`);
    const kind = requireString(entry.kind, `input.reference_index[${index}].kind`, { singleLine: true });
    if (!KINDS.has(kind)) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'INVALID_REFERENCE_KIND', `Unknown reference kind ${kind}`);
    }
    const ref = canonicalEntityRef(entry.ref, `input.reference_index[${index}].ref`);
    if (refById.has(ref_id)) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'DUPLICATE_PLAN_REFERENCE', `Duplicate ref_id ${ref_id}`);
    }
    if (refByPath.has(ref)) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'DUPLICATE_PLAN_REFERENCE', `Duplicate entity ref ${ref}`);
    }
    const descriptor = { ref_id, kind, ref };
    referenceIndex.push(descriptor);
    refById.set(ref_id, descriptor);
    refByPath.set(ref, descriptor);
  }

  const ensureRef = (value: unknown, where: string, expectedKind: string | undefined = undefined): string => {
    const id = refId(value, where);
    const descriptor = refById.get(id);
    if (descriptor === undefined) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'INCOMPLETE_PROOF_INDEX', `${where} points to unregistered ref_id ${id}`);
    }
    if (expectedKind !== undefined && descriptor.kind !== expectedKind) {
      fail(
        'PLAN_DEFECT',
        'PLAN_GAP',
        'PROOF_INDEX_KIND_MISMATCH',
        `${where} expects ${expectedKind} but ${id} is ${descriptor.kind}`,
      );
    }
    return id;
  };

  for (const [index, ref] of selectedWorkItems.entries()) {
    if (!refByPath.has(ref)) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'INCOMPLETE_PROOF_INDEX', `selected_work_item_refs[${index}] is not indexed`);
    }
  }
  for (const [index, ref] of authorityRefs.entries()) {
    if (!refByPath.has(ref)) {
      fail('AUTHORITY_GAP', 'AUTHORITY_GAP', 'MISSING_ACCEPTANCE_AUTHORITY', `authority_entity_refs[${index}] is not indexed`);
    }
  }
  ensureRef(stageGoal.ref_id, 'input.stage_goal.ref_id', 'goal');
  if (refById.get(stageGoal.ref_id)!.ref !== `${candidatePath}#/entities/${stageGoal.entity_id}`) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'INVALID_ENTITY_REFERENCE', 'stage goal ref does not point to the stage goal marker');
  }
  for (const [index, ref] of stageGoal.refs.entries()) {
    ensureRef(ref, `input.stage_goal.refs[${index}]`);
  }

  const slices: MaterializerSlice[] = [];
  const sliceIds = new Set<string>();
  const taskIds = new Set<string>();
  const taskRefOwners = new Map<string, string>();
  const slicesArray = requireArray(input.slices, 'input.slices');
  for (let sliceIndex = 0; sliceIndex < slicesArray.length; sliceIndex += 1) {
    const value = slicesArray[sliceIndex];
    checkFields(value, SLICE_FIELDS, `input.slices[${sliceIndex}]`);
    const sliceId = identifier(value.slice_id, `input.slices[${sliceIndex}].slice_id`);
    if (!sliceId.startsWith(`${stageId}-`)) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${sliceId} is outside stage ${stageId}`);
    }
    if (sliceIds.has(sliceId)) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'DUPLICATE_SLICE_ID', `Duplicate slice_id ${sliceId}`);
    }
    sliceIds.add(sliceId);
    const goalEntityId = identifier(value.goal_entity_id, `input.slices[${sliceIndex}].goal_entity_id`);
    if (goalEntityId !== `${sliceId}-goal`) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${sliceId} goal_entity_id is not canonical`);
    }
    const goal = requireString(value.goal, `input.slices[${sliceIndex}].goal`, { singleLine: true });
    const dependenciesForSlice = stringArray(value.dependencies, `input.slices[${sliceIndex}].dependencies`, { unique: true });
    const requiredSkills = stringArray(value.required_skills, `input.slices[${sliceIndex}].required_skills`, { unique: true });
    const evidencePath = assertRootRelativePath(value.evidence_path, `input.slices[${sliceIndex}].evidence_path`);
    const expectedEvidencePath = `delivery/stages/${stageId}/evidence/${sliceId}.md`;
    if (evidencePath !== expectedEvidencePath) {
      fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', `evidence_path must be ${expectedEvidencePath}`);
    }

    checkFields(value.proof_index, PROOF_INDEX_FIELDS, `input.slices[${sliceIndex}].proof_index`);
    const proofValue = value.proof_index;
    if (proofValue.slice_id !== sliceId) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'INCOMPLETE_PROOF_INDEX', `${sliceId} Proof Index slice_id mismatch`);
    }
    const proofIndex: MaterializerProofIndex = {
      slice_id: sliceId,
      goal_ref: ensureRef(proofValue.goal_ref, `slices[${sliceIndex}].proof_index.goal_ref`, 'goal'),
      task_refs: stringArray(proofValue.task_refs, `slices[${sliceIndex}].proof_index.task_refs`, { unique: true }),
      acceptance_refs: stringArray(proofValue.acceptance_refs, `slices[${sliceIndex}].proof_index.acceptance_refs`, { unique: true }),
      seam_refs: stringArray(proofValue.seam_refs, `slices[${sliceIndex}].proof_index.seam_refs`, { unique: true }),
      oracle_refs: stringArray(proofValue.oracle_refs, `slices[${sliceIndex}].proof_index.oracle_refs`, { unique: true }),
      risk_refs: [],
    };
    if (proofIndex.goal_ref !== stageGoal.ref_id && refById.get(proofIndex.goal_ref)!.ref === `${candidatePath}#/entities/${stageGoal.entity_id}`) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'INCOMPLETE_PROOF_INDEX', `${sliceId} Proof Index reuses stage goal as slice goal`);
    }
    if (proofIndex.task_refs.length === 0 || proofIndex.acceptance_refs.length === 0 || proofIndex.seam_refs.length === 0 || proofIndex.oracle_refs.length === 0) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'INCOMPLETE_PROOF_INDEX', `${sliceId} Proof Index is incomplete`);
    }
    const riskRefsArray = requireArray(proofValue.risk_refs, `slices[${sliceIndex}].proof_index.risk_refs`);
    if (riskRefsArray.length === 0) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'INCOMPLETE_PROOF_INDEX', `${sliceId} Proof Index must declare risk_refs`);
    }
    for (const [index, ref] of proofIndex.task_refs.entries()) ensureRef(ref, `slices[${sliceIndex}].proof_index.task_refs[${index}]`, 'task');
    for (const [index, ref] of proofIndex.acceptance_refs.entries()) ensureRef(ref, `slices[${sliceIndex}].proof_index.acceptance_refs[${index}]`, 'acceptance');
    for (const [index, ref] of proofIndex.seam_refs.entries()) ensureRef(ref, `slices[${sliceIndex}].proof_index.seam_refs[${index}]`, 'seam');
    for (const [index, ref] of proofIndex.oracle_refs.entries()) ensureRef(ref, `slices[${sliceIndex}].proof_index.oracle_refs[${index}]`, 'oracle');

    for (let riskIndex = 0; riskIndex < riskRefsArray.length; riskIndex += 1) {
      const riskValue = riskRefsArray[riskIndex];
      checkFields(riskValue, RISK_BINDING_FIELDS, `slices[${sliceIndex}].proof_index.risk_refs[${riskIndex}]`);
      const risk = {
        ref_id: ensureRef(riskValue.ref_id, `slices[${sliceIndex}].proof_index.risk_refs[${riskIndex}].ref_id`, 'risk'),
        applies_to_acceptance_refs: stringArray(
          riskValue.applies_to_acceptance_refs,
          `slices[${sliceIndex}].proof_index.risk_refs[${riskIndex}].applies_to_acceptance_refs`,
          { unique: true },
        ),
        applies_to_seam_refs: stringArray(
          riskValue.applies_to_seam_refs,
          `slices[${sliceIndex}].proof_index.risk_refs[${riskIndex}].applies_to_seam_refs`,
          { unique: true },
        ),
      };
      if (proofIndex.risk_refs.some((entry) => entry.ref_id === risk.ref_id)) {
        fail('PLAN_DEFECT', 'PLAN_GAP', 'DUPLICATE_PLAN_REFERENCE', `Duplicate risk ref ${risk.ref_id} in ${sliceId}`);
      }
      for (const ref of risk.applies_to_acceptance_refs) {
        ensureRef(ref, `${sliceId}.risk.applies_to_acceptance_refs`, 'acceptance');
        if (!proofIndex.acceptance_refs.includes(ref)) {
          fail('PLAN_DEFECT', 'PLAN_GAP', 'INCOMPLETE_PROOF_INDEX', `${risk.ref_id} binds an unlisted acceptance ref`);
        }
      }
      for (const ref of risk.applies_to_seam_refs) {
        ensureRef(ref, `${sliceId}.risk.applies_to_seam_refs`, 'seam');
        if (!proofIndex.seam_refs.includes(ref)) {
          fail('PLAN_DEFECT', 'PLAN_GAP', 'INCOMPLETE_PROOF_INDEX', `${risk.ref_id} binds an unlisted seam ref`);
        }
      }
      proofIndex.risk_refs.push(risk);
    }

    const tasks: MaterializerTask[] = [];
    const taskRefSet = new Set<string>();
    const tasksArray = requireArray(value.tasks, `input.slices[${sliceIndex}].tasks`);
    for (let taskIndex = 0; taskIndex < tasksArray.length; taskIndex += 1) {
      const taskValue = tasksArray[taskIndex];
      checkFields(taskValue, TASK_FIELDS, `input.slices[${sliceIndex}].tasks[${taskIndex}]`);
      const taskId = identifier(taskValue.task_id, `tasks[${taskIndex}].task_id`);
      if (!taskId.startsWith(`${sliceId}-`)) {
        fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${taskId} is outside slice ${sliceId}`);
      }
      if (taskIds.has(taskId)) {
        fail('PLAN_DEFECT', 'PLAN_GAP', 'DUPLICATE_TASK_ID', `Duplicate task_id ${taskId}`);
      }
      taskIds.add(taskId);
      const entityId = identifier(taskValue.entity_id, `tasks[${taskIndex}].entity_id`);
      if (entityId !== taskId) {
        fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${taskId} entity_id must equal task_id`);
      }
      const taskRefs = stringArray(taskValue.refs, `tasks[${taskIndex}].refs`, { unique: true });
      let hasTaskRef = false;
      for (const ref of taskRefs) {
        const descriptor = refById.get(ref);
        if (descriptor === undefined) {
          fail('PLAN_DEFECT', 'PLAN_GAP', 'INCOMPLETE_PROOF_INDEX', `${taskId} uses unregistered ref_id ${ref}`);
        }
        if (descriptor.kind === 'task') {
          hasTaskRef = true;
          taskRefSet.add(ref);
          if (taskRefOwners.has(ref)) {
            fail('PLAN_DEFECT', 'PLAN_GAP', 'DUPLICATE_PLAN_REFERENCE', `Task ref ${ref} belongs to multiple tasks`);
          }
          taskRefOwners.set(ref, taskId);
          if (entityIdFromRef(descriptor.ref) !== entityId) {
            fail('PLAN_DEFECT', 'PLAN_GAP', 'INVALID_ENTITY_REFERENCE', `${ref} does not point to ${entityId}`);
          }
        }
      }
      if (!hasTaskRef) {
        fail('PLAN_DEFECT', 'PLAN_GAP', 'INCOMPLETE_PROOF_INDEX', `${taskId} has no task-kind entity ref`);
      }
      const executionScope = parseExecutionScope(root, taskValue.execution_scope, `${taskId}.execution_scope`);
      const task = {
        task_id: taskId,
        entity_id: entityId,
        goal: requireString(taskValue.goal, `tasks[${taskIndex}].goal`, { singleLine: true }),
        refs: taskRefs,
        dependencies: stringArray(taskValue.dependencies, `tasks[${taskIndex}].dependencies`, { unique: true }),
        required_skills: stringArray(taskValue.required_skills, `tasks[${taskIndex}].required_skills`, { unique: true }),
        execution_scope: executionScope,
        checkbox: taskValue.checkbox as boolean,
        status: taskValue.status as string,
        cv_status: taskValue.cv_status as string,
      };
      if (task.checkbox !== false || task.status !== 'NOT_STARTED' || task.cv_status !== 'NOT_RUN') {
        fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_NOT_ONLY', `${taskId} is not candidate-only`);
      }
      tasks.push(task);
    }
    if (tasks.length === 0) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'STAGE_NOT_DECOMPOSABLE', `${sliceId} must contain at least one task`);
    }
    if (taskRefSet.size !== new Set(proofIndex.task_refs).size || [...taskRefSet].some((ref) => !proofIndex.task_refs.includes(ref))) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'INCOMPLETE_PROOF_INDEX', `${sliceId} task_refs do not close over task entities`);
    }
    const goalDescriptor = refById.get(proofIndex.goal_ref);
    if (goalDescriptor === undefined || goalDescriptor.kind !== 'goal' || entityIdFromRef(goalDescriptor.ref) !== goalEntityId) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'INVALID_ENTITY_REFERENCE', `${sliceId} goal_ref does not point to its goal entity`);
    }

    slices.push({
      slice_id: sliceId,
      goal_entity_id: goalEntityId,
      goal,
      proof_index: proofIndex,
      dependencies: dependenciesForSlice,
      required_skills: requiredSkills,
      evidence_path: evidencePath,
      tasks,
    });
  }
  if (slices.length === 0) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'STAGE_NOT_DECOMPOSABLE', 'candidate plan must contain at least one slice');
  }

  const sliceDependencyMap = new Map(slices.map((slice) => [slice.slice_id, slice.dependencies]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (sliceId: string): void => {
    if (visiting.has(sliceId)) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'SLICE_DEPENDENCY_CYCLE', `Slice dependency cycle includes ${sliceId}`);
    }
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
    schema_version: SCHEMA_VERSION,
    mode: input.mode as 'initial' | 'replan',
    caller: CALLER,
    owner: OWNER,
    project_root: root,
    stage_id: stageId,
    candidate_plan_path: candidatePath,
    selected_work_item_refs: selectedWorkItems,
    authority_entity_refs: authorityRefs,
    existing_plan_ref: input.existing_plan_ref as string | null,
    finding_refs: [...findingRefs],
    stage_goal: stageGoal,
    dependencies,
    constraints,
    out_of_scope: outOfScope,
    reference_index: referenceIndex,
    slices,
    root_for_io: root,
    candidate_absolute: candidateAbsolute,
  };
}

// ============================================================
// Renderer (ported verbatim — byte-identical output)
// ============================================================

function refLabel(refById: Map<string, MaterializerReferenceDescriptor>, refIdValue: string): string {
  const descriptor = refById.get(refIdValue);
  return descriptor === undefined ? `\`${refIdValue}\`` : `\`${refIdValue}\` (${descriptor.kind}) → \`${descriptor.ref}\``;
}

function candidateLocalReferenceDescriptors(plan: MaterializerPlan): MaterializerReferenceDescriptor[] {
  return plan.reference_index.filter((entry) => pathWithoutFragment(entry.ref) === plan.candidate_plan_path);
}

function requiredEntityMarkers(plan: MaterializerPlan): Array<{ id: string; kind: string }> {
  const markers: Array<{ id: string; kind: string }> = [];
  const markerById = new Map<string, { id: string; kind: string }>();
  const add = (id: string, kind: string): void => {
    const existing = markerById.get(id);
    if (existing !== undefined) {
      if (existing.kind !== kind) {
        fail('PLAN_DEFECT', 'PLAN_GAP', 'ENTITY_MARKER_KIND_MISMATCH', `entity ${id} is required as both ${existing.kind} and ${kind}`);
      }
      return;
    }
    const marker = { id, kind };
    markerById.set(id, marker);
    markers.push(marker);
  };

  add(plan.stage_goal.entity_id, 'goal');
  for (const slice of plan.slices) {
    add(slice.goal_entity_id, 'goal');
    for (const task of slice.tasks) add(task.entity_id, 'task');
  }
  for (const descriptor of candidateLocalReferenceDescriptors(plan)) {
    add(entityIdFromRef(descriptor.ref), descriptor.kind);
  }
  return markers;
}

function bulletList(lines: string[], values: readonly string[]): void {
  if (values.length === 0) {
    lines.push('- None');
    return;
  }
  for (const value of values) lines.push(`- ${value}`);
}

// Single canonical source for the per-task `### Task → Slice Closure` block:
// it projects ONLY fields already present in the parsed closed plan input
// (task id/refs, Slice Proof Index refs, evidence_path, execution_scope), in
// input order, with a fixed format. It never copies Authority body text and
// never invents acceptance/seam facts. Both the renderer and the
// validateRenderedDocument closure checks must use exactly these lines so
// `--check` fails closed on any missing or tampered closure text.
function renderTaskClosureLines(slice: MaterializerSlice, task: MaterializerTask): string[] {
  const lines: string[] = [];
  lines.push(`- task \`${task.task_id}\` → slice \`${slice.slice_id}\``);
  lines.push(`  - goal_ref: \`${slice.proof_index.goal_ref}\``);
  lines.push(`  - task refs: ${task.refs.map((ref) => `\`${ref}\``).join(', ')}`);
  lines.push(`  - slice task_refs: ${slice.proof_index.task_refs.map((ref) => `\`${ref}\``).join(', ')}`);
  lines.push(`  - acceptance_refs: ${slice.proof_index.acceptance_refs.map((ref) => `\`${ref}\``).join(', ')}`);
  lines.push(`  - seam_refs: ${slice.proof_index.seam_refs.map((ref) => `\`${ref}\``).join(', ')}`);
  lines.push(`  - oracle_refs: ${slice.proof_index.oracle_refs.map((ref) => `\`${ref}\``).join(', ')}`);
  lines.push(`  - risk_refs: ${slice.proof_index.risk_refs.map((risk) => `\`${risk.ref_id}\``).join(', ')}`);
  lines.push(`  - evidence_path: \`${slice.evidence_path}\``);
  const scope = task.execution_scope;
  lines.push(
    `  - execution_scope: kind \`${scope.kind}\`, code_paths ${scope.code_paths.map((item) => `\`${item}\``).join(', ')}, test_paths ${scope.test_paths.map((item) => `\`${item}\``).join(', ')}`,
  );
  return lines;
}

export function renderCandidatePlan(plan: MaterializerPlan): string {
  const refById = new Map(plan.reference_index.map((entry) => [entry.ref_id, entry]));
  const lines: string[] = [];
  const emittedEntityIds = new Set<string>();
  const emitEntityMarker = (id: string, kind: string): void => {
    if (emittedEntityIds.has(id)) return;
    lines.push(`<!-- proofloop:entity id="${id}" kind="${kind}" -->`);
    emittedEntityIds.add(id);
  };
  lines.push(`# Stage ${plan.stage_id} — candidate`);
  lines.push('');
  lines.push('## Stage Goal');
  emitEntityMarker(plan.stage_goal.entity_id, 'goal');
  lines.push(plan.stage_goal.goal);
  lines.push('');
  lines.push('## Authority References');
  lines.push('### Selected Work Items');
  bulletList(lines, plan.selected_work_item_refs.map((ref) => `\`${ref}\``));
  lines.push('### Authority Entity Refs');
  bulletList(lines, plan.authority_entity_refs.map((ref) => `\`${ref}\``));
  lines.push('');
  lines.push('## Stable Entity References');
  for (const entry of plan.reference_index) {
    lines.push(`- \`${entry.ref_id}\` (${entry.kind}) → \`${entry.ref}\``);
  }
  lines.push('');
  lines.push('## Immutable Plan Projection');
  lines.push('- Stage/Slice/Task goals, stable ref_ids, Dependencies and Required Skills are immutable plan inputs.');
  lines.push('- Runtime computes authoritative `plan_digest` from this immutable projection.');
  lines.push('- This materializer does not write a digest, Manifest or admission fact.');
  lines.push('');
  lines.push('## Mutable Execution Projection');
  lines.push('- checkbox: `[ ]`');
  lines.push('- Worker Status: `NOT_STARTED`');
  lines.push('- Current CV Status: `NOT_RUN`');
  lines.push('- Mutable projection is excluded from Runtime `plan_digest`.');
  lines.push('');
  lines.push('## Dependencies');
  bulletList(lines, plan.dependencies);
  lines.push('');
  lines.push('## Constraints');
  bulletList(lines, plan.constraints);
  lines.push('');
  lines.push('## Out of Scope');
  bulletList(lines, plan.out_of_scope);
  lines.push('');
  lines.push('## Candidate Boundary');
  lines.push('- plan_state: `CANDIDATE_ONLY`');
  lines.push('- Manifest: `NOT_GENERATED_BY_THIS_OWNER`');
  lines.push('- Evidence: `NOT_GENERATED_BY_THIS_OWNER`');
  lines.push('- Receipt/admission: `NOT_WRITTEN_BY_THIS_OWNER`');
  lines.push('- Worker/CV execution: `BLOCKED_PENDING_RUNTIME_ADMISSION`');
  lines.push('');
  lines.push('## Slice Graph');
  for (const slice of plan.slices) {
    lines.push(`- ${slice.slice_id} (depends on: ${slice.dependencies.length > 0 ? slice.dependencies.join(', ') : 'none'})`);
  }
  lines.push('');

  for (const slice of plan.slices) {
    lines.push(`## Slice ${slice.slice_id} — candidate`);
    lines.push(`<!-- SLICE:${slice.slice_id}:BEGIN -->`);
    lines.push('');
    lines.push('### Goal');
    emitEntityMarker(slice.goal_entity_id, 'goal');
    lines.push(slice.goal);
    lines.push('');
    lines.push('### Proof Index References');
    lines.push(`- slice_id: \`${slice.proof_index.slice_id}\``);
    lines.push(`- goal_ref: ${refLabel(refById, slice.proof_index.goal_ref)}`);
    lines.push(`- task_refs: ${slice.proof_index.task_refs.map((ref) => refLabel(refById, ref)).join(', ')}`);
    lines.push(`- acceptance_refs: ${slice.proof_index.acceptance_refs.map((ref) => refLabel(refById, ref)).join(', ')}`);
    lines.push(`- seam_refs: ${slice.proof_index.seam_refs.map((ref) => refLabel(refById, ref)).join(', ')}`);
    lines.push(`- oracle_refs: ${slice.proof_index.oracle_refs.map((ref) => refLabel(refById, ref)).join(', ')}`);
    lines.push('- risk_refs:');
    for (const risk of slice.proof_index.risk_refs) {
      lines.push(`  - ref_id: ${refLabel(refById, risk.ref_id)}`);
      lines.push(`    applies_to_acceptance_refs: ${risk.applies_to_acceptance_refs.map((ref) => `\`${ref}\``).join(', ')}`);
      lines.push(`    applies_to_seam_refs: ${risk.applies_to_seam_refs.map((ref) => `\`${ref}\``).join(', ')}`);
    }
    lines.push('');
    lines.push('### Dependencies');
    bulletList(lines, slice.dependencies);
    lines.push('');
    lines.push('### Required Skills');
    bulletList(lines, slice.required_skills.map((skill) => `\`${skill}\``));
    lines.push('');
    lines.push('### Tasks');
    for (const task of slice.tasks) {
      emitEntityMarker(task.entity_id, 'task');
      lines.push(`- [ ] ${task.task_id} — ${task.goal}`);
      lines.push(`  - refs: ${task.refs.map((ref) => `\`${ref}\``).join(', ')}`);
      lines.push(`  - Dependencies: ${task.dependencies.length > 0 ? task.dependencies.join(', ') : 'none'}`);
      lines.push(`  - Required Skills: ${task.required_skills.length > 0 ? task.required_skills.map((skill) => `\`${skill}\``).join(', ') : 'none'}`);
      lines.push(`  - execution_scope: ${JSON.stringify(task.execution_scope)}`);
    }
    lines.push('');
    lines.push('### Task → Slice Closure');
    for (const task of slice.tasks) {
      for (const closureLine of renderTaskClosureLines(slice, task)) {
        lines.push(closureLine);
      }
    }
    lines.push('');
    lines.push('### Immutable Plan Projection');
    lines.push(`- goal_ref: \`${slice.proof_index.goal_ref}\``);
    lines.push(`- task_refs: ${slice.proof_index.task_refs.map((ref) => `\`${ref}\``).join(', ')}`);
    lines.push(`- Dependencies: ${slice.dependencies.length > 0 ? slice.dependencies.join(', ') : 'none'}`);
    lines.push(`- Required Skills: ${slice.required_skills.length > 0 ? slice.required_skills.map((skill) => `\`${skill}\``).join(', ') : 'none'}`);
    lines.push('');
    lines.push('### Mutable Execution Projection');
    lines.push('- checkbox: `[ ]`');
    lines.push('- Worker Status: `NOT_STARTED`');
    lines.push('- Current CV Status: `NOT_RUN`');
    lines.push('- `plan_digest` excludes this mutable projection.');
    lines.push('');
    lines.push('### Candidate Evidence Path');
    lines.push(`- declared path only: \`${slice.evidence_path}\``);
    lines.push('- Evidence is not created by this owner.');
    lines.push('');
    lines.push(`<!-- SLICE:${slice.slice_id}:END -->`);
    lines.push('');
  }

  const additionalCandidateMarkers = candidateLocalReferenceDescriptors(plan)
    .filter((descriptor) => !emittedEntityIds.has(entityIdFromRef(descriptor.ref)));
  if (additionalCandidateMarkers.length > 0) {
    lines.push('## Candidate Entity Markers');
    for (const descriptor of additionalCandidateMarkers) {
      const entityId = entityIdFromRef(descriptor.ref);
      emitEntityMarker(entityId, descriptor.kind);
      lines.push(`- ref_id: \`${descriptor.ref_id}\` (${descriptor.kind}) → \`${descriptor.ref}\``);
    }
    lines.push('');
  }

  lines.push('## Slice → Stage Closure');
  for (const slice of plan.slices) lines.push(`- ${slice.slice_id} → ${plan.stage_id} candidate goal only`);
  lines.push('');
  lines.push('## Runtime Handoff');
  lines.push('- Runtime must compile and mechanically validate this candidate before fresh SPV.');
  lines.push('- No Worker/CV/Committer dispatch is authorized by this file.');
  return `${lines.join('\n')}\n`;
}

// ============================================================
// validateRenderedDocument (ported verbatim — fail-closed)
// ============================================================

export function validateRenderedDocument(text: string, plan: MaterializerPlan): boolean {
  if (!text.startsWith(`# Stage ${plan.stage_id} — candidate\n`)) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', 'candidate tasks.md has an invalid Stage heading');
  }
  if (!text.includes('## Immutable Plan Projection') || !text.includes('## Mutable Execution Projection')) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', 'candidate tasks.md lacks projection boundary');
  }
  const begins = [...text.matchAll(/<!-- SLICE:([^\s:]+):BEGIN\s*-->/g)].map((match) => match[1]);
  const ends = [...text.matchAll(/<!-- SLICE:([^\s:]+):END\s*-->/g)].map((match) => match[1]);
  const expected = plan.slices.map((slice) => slice.slice_id);
  if (begins.length !== expected.length || ends.length !== expected.length || begins.some((id, index) => id !== expected[index]) || ends.some((id, index) => id !== expected[index])) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', 'candidate tasks.md Slice markers are not a closed ordered set');
  }
  const markers: Array<{ id: string; kind: string }> = [];
  for (const [lineIndex, line] of text.split('\n').entries()) {
    if (!line.includes('proofloop:entity')) continue;
    const match = ENTITY_MARKER_RE.exec(line);
    if (match === null) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'INVALID_ENTITY_MARKER', `invalid proofloop:entity marker on line ${lineIndex + 1}`);
    }
    markers.push({ id: match[1], kind: match[2] });
  }
  const markersById = new Map<string, { id: string; kind: string }>();
  for (const marker of markers) {
    if (markersById.has(marker.id)) fail('PLAN_DEFECT', 'PLAN_GAP', 'DUPLICATE_ENTITY_MARKER', `duplicate entity marker ${marker.id}`);
    if (!KINDS.has(marker.kind)) fail('PLAN_DEFECT', 'PLAN_GAP', 'INVALID_ENTITY_MARKER_KIND', `unknown entity marker kind ${marker.kind}`);
    markersById.set(marker.id, marker);
  }
  const requiredMarkers = requiredEntityMarkers(plan);
  const requiredById = new Map(requiredMarkers.map((marker) => [marker.id, marker]));
  for (const marker of markers) {
    if (!requiredById.has(marker.id)) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'UNEXPECTED_ENTITY_MARKER', `unexpected entity marker ${marker.id}`);
    }
  }
  for (const marker of requiredMarkers) {
    const actual = markersById.get(marker.id);
    if (actual === undefined) {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'MISSING_ENTITY_MARKER', `missing entity marker ${marker.kind}:${marker.id}`);
    }
    if (actual.kind !== marker.kind) {
      fail(
        'PLAN_DEFECT',
        'PLAN_GAP',
        'ENTITY_MARKER_KIND_MISMATCH',
        `entity marker ${marker.id} declares ${actual.kind}, expected ${marker.kind}`,
      );
    }
  }
  for (const slice of plan.slices) {
    const sliceStart = text.indexOf(`<!-- SLICE:${slice.slice_id}:BEGIN -->`);
    const sliceEnd = text.indexOf(`<!-- SLICE:${slice.slice_id}:END -->`);
    const section = text.slice(sliceStart, sliceEnd);
    for (const task of slice.tasks) {
      const scopeLine = `  - execution_scope: ${JSON.stringify(task.execution_scope)}`;
      if (!section.includes(scopeLine)) {
        fail('PLAN_DEFECT', 'PLAN_GAP', 'EXECUTION_SCOPE_MISMATCH', `${task.task_id} execution_scope is not preserved canonically`);
      }
    }
    for (const heading of ['### Proof Index References', '### Dependencies', '### Required Skills', '### Tasks', '### Task → Slice Closure', '### Immutable Plan Projection', '### Mutable Execution Projection']) {
      if (!section.includes(heading)) {
        fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `${slice.slice_id} lacks ${heading}`);
      }
    }
    // Task → Slice Closure is fail-closed: the heading must appear exactly
    // once per Slice, and the non-empty lines between it and the next
    // `### `/`## ` heading must equal the canonical per-task closure lines
    // in slice.tasks order. Any duplicate, reorder, tamper, forged binding
    // or line-count drift is a PLAN_DEFECT — mere substring existence checks
    // are fail-open and must never be used for this region.
    const closureHeading = '### Task → Slice Closure';
    const sectionLines = section.split('\n');
    const closureHeadingCount = sectionLines.filter((line) => line === closureHeading).length;
    if (closureHeadingCount !== 1) {
      fail(
        'PLAN_DEFECT',
        'PLAN_GAP',
        'TASK_SLICE_CLOSURE_MISMATCH',
        `${slice.slice_id} Task → Slice Closure heading must appear exactly once per Slice (found ${closureHeadingCount})`,
      );
    }
    const closureHeadingIndex = sectionLines.findIndex((line) => line === closureHeading);
    const actualClosureLines: string[] = [];
    for (let lineIndex = closureHeadingIndex + 1; lineIndex < sectionLines.length; lineIndex += 1) {
      const line = sectionLines[lineIndex];
      if (/^#{2,3} /.test(line)) break;
      if (line.trim() === '') continue;
      actualClosureLines.push(line);
    }
    const canonicalClosureLines: string[] = [];
    for (const task of slice.tasks) {
      canonicalClosureLines.push(...renderTaskClosureLines(slice, task));
    }
    if (actualClosureLines.length !== canonicalClosureLines.length) {
      fail(
        'PLAN_DEFECT',
        'PLAN_GAP',
        'TASK_SLICE_CLOSURE_MISMATCH',
        `${slice.slice_id} Task → Slice Closure region has ${actualClosureLines.length} non-empty lines, expected ${canonicalClosureLines.length}`,
      );
    }
    for (let lineIndex = 0; lineIndex < canonicalClosureLines.length; lineIndex += 1) {
      if (actualClosureLines[lineIndex] !== canonicalClosureLines[lineIndex]) {
        fail(
          'PLAN_DEFECT',
          'PLAN_GAP',
          'TASK_SLICE_CLOSURE_MISMATCH',
          `${slice.slice_id} Task → Slice Closure line ${lineIndex + 1} is not canonical (expected \`${canonicalClosureLines[lineIndex]}\`, got \`${actualClosureLines[lineIndex]}\`)`,
        );
      }
    }
  }
  return true;
}

// ============================================================
// Candidate target + atomic write (ported verbatim)
// ============================================================

function candidateTarget(root: string, candidatePath: string, options: { createParent?: boolean } = {}): string {
  const createParent = options.createParent ?? true;
  const target = path.resolve(root, ...candidatePath.split('/'));
  assertWithin(root, target, 'candidate_plan_path');
  const parent = path.dirname(target);
  if (createParent) fs.mkdirSync(parent, { recursive: true });
  let realParent: string;
  try {
    realParent = fs.realpathSync(parent);
  } catch (error) {
    fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_MISSING', `candidate parent is not readable: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertWithin(root, realParent, 'candidate_plan_path parent');
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', 'candidate tasks.md cannot be a symlink');
    }
    if (!stat.isFile()) {
      fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', 'candidate tasks.md must be a regular file');
    }
  } catch (error) {
    if (error instanceof MaterializerError) throw error;
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  }
  return target;
}

function atomicWriteCandidate(target: string, content: string): void {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* cleanup is best effort */ }
    }
    try { fs.unlinkSync(temporary); } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
    }
  }
}

// ============================================================
// Input read + structured output envelopes (ported verbatim)
// ============================================================

function readJson(inputPath: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(inputPath, 'utf8');
  } catch (error) {
    fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'TRANSIENT_INPUT_UNREADABLE', `cannot read input: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_SCHEMA_INVALID', `input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface MaterializeSuccessPayload {
  readonly ok: true;
  readonly result: 'CANDIDATE_READY' | 'CANDIDATE_CHECKED';
  readonly owner: string;
  readonly caller: string;
  readonly stage_id: string;
  readonly candidate_plan_path: string;
  readonly candidate_only: true;
  readonly writes: string[];
  readonly runtime_handoff: {
    readonly manifest: 'DEFERRED_TO_RUNTIME';
    readonly validator: 'DEFERRED_TO_RUNTIME';
    readonly evidence_initializer: 'DEFERRED_TO_RUNTIME';
    readonly spv: 'FRESH_DISPATCH_BY_BRAIN';
    readonly admission: 'DEFERRED_TO_RUNTIME';
  };
}

export interface MaterializeFailurePayload {
  readonly ok: false;
  readonly result: string;
  readonly route_code: string;
  readonly subtype: string;
  readonly reason: string;
  readonly affected_artifacts: string[];
  readonly suggested_owner: 'User' | 'Brain';
  readonly invalidation_scope: unknown[];
  readonly resume_target: {
    readonly owner: 'User' | 'Brain';
    readonly phase: string;
    readonly stage: 'none';
  };
}

export type MaterializeResult = MaterializeSuccessPayload | MaterializeFailurePayload;

function outputSuccess(result: 'CANDIDATE_READY' | 'CANDIDATE_CHECKED', plan: MaterializerPlan, writes: string[]): MaterializeSuccessPayload {
  return {
    ok: true,
    result,
    owner: OWNER,
    caller: CALLER,
    stage_id: plan.stage_id,
    candidate_plan_path: plan.candidate_plan_path,
    candidate_only: true,
    writes,
    runtime_handoff: {
      manifest: 'DEFERRED_TO_RUNTIME',
      validator: 'DEFERRED_TO_RUNTIME',
      evidence_initializer: 'DEFERRED_TO_RUNTIME',
      spv: 'FRESH_DISPATCH_BY_BRAIN',
      admission: 'DEFERRED_TO_RUNTIME',
    },
  };
}

function outputFailure(error: unknown): MaterializeFailurePayload {
  const materializerError = error instanceof MaterializerError
    ? error
    : new MaterializerError({
        result: 'RUNTIME_BLOCKER',
        routeCode: 'RUNTIME_BLOCKER',
        subtype: 'ACTIVE_HELPER_FAILURE',
        reason: error instanceof Error ? error.message : String(error),
      });
  return {
    ok: false,
    result: materializerError.result,
    route_code: materializerError.routeCode,
    subtype: materializerError.subtype,
    reason: materializerError.reason,
    affected_artifacts: materializerError.affectedArtifacts,
    suggested_owner: materializerError.routeCode === 'AUTHORITY_GAP' ? 'User' : 'Brain',
    invalidation_scope: [],
    resume_target: {
      owner: materializerError.routeCode === 'AUTHORITY_GAP' ? 'User' : 'Brain',
      phase: materializerError.routeCode === 'AUTHORITY_GAP' ? 'AUTHORITY_READINESS' : 'STAGE_PLANNING',
      stage: 'none',
    },
  };
}

// ============================================================
// Main entry (port of the .mjs `main`, minus argv/stdio)
// ============================================================

export interface MaterializeOptions {
  /** Read-only recheck of the already-rendered candidate (no write). */
  readonly check?: boolean;
  /** Optional output override; must equal candidate_plan_path (port of `--output`). */
  readonly output?: string;
}

/**
 * Render (or recheck) the candidate tasks.md for one closed planning input.
 *
 * `root` is the canonical trust root and must resolve to the same canonical
 * directory as the input's `project_root`; `inputPath` is root-relative.
 * On success the candidate tasks.md named by the input has been written
 * (CANDIDATE_READY) or rechecked read-only (CANDIDATE_CHECKED); on failure a
 * structured MaterializeFailurePayload with the helper's result/route_code/
 * subtype/reason is returned — never a partial write.
 */
export function materializeCandidatePlan(
  root: string,
  inputPath: string,
  options: MaterializeOptions = {},
): MaterializeResult {
  try {
    const inputAbsolute = path.resolve(root, inputPath);
    const raw = readJson(inputAbsolute);
    const plan = validateInput(raw);
    assertWithin(plan.root_for_io, inputAbsolute, 'transient input');
    // Trust-root binding: the caller's root must BE the canonical project
    // root of the input (the CLI pre-check enforces the same rule; kept here
    // so the module API can never render into a foreign tree).
    const canonicalTrustRoot = realRoot(root);
    if (plan.root_for_io !== canonicalTrustRoot) {
      fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', 'root does not match candidate project_root');
    }
    const target = candidateTarget(plan.root_for_io, options.output ?? plan.candidate_plan_path, { createParent: options.check !== true });
    if (path.relative(plan.root_for_io, target).split(path.sep).join('/') !== plan.candidate_plan_path) {
      fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_PATH_ESCAPE', 'output does not match candidate_plan_path');
    }

    if (options.check === true) {
      let content: string;
      try {
        content = fs.readFileSync(target, 'utf8');
      } catch (error) {
        fail('RUNTIME_BLOCKER', 'RUNTIME_BLOCKER', 'CANDIDATE_MISSING', `candidate tasks.md is not readable: ${error instanceof Error ? error.message : String(error)}`);
      }
      validateRenderedDocument(content, plan);
      return outputSuccess('CANDIDATE_CHECKED', plan, []);
    }

    let targetExists = false;
    try {
      targetExists = fs.existsSync(target);
    } catch {
      targetExists = false;
    }
    if (targetExists && plan.mode === 'initial') {
      fail('PLAN_DEFECT', 'PLAN_GAP', 'CANDIDATE_EXISTS', 'initial materialization will not overwrite an existing candidate; use mode: replan');
    }
    const content = renderCandidatePlan(plan);
    validateRenderedDocument(content, plan);
    atomicWriteCandidate(target, content);
    return outputSuccess('CANDIDATE_READY', plan, [plan.candidate_plan_path]);
  } catch (error) {
    return outputFailure(error);
  }
}
