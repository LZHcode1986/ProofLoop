/**
 * Closed vNext Code Verifier result envelope.
 *
 * This module owns both the closed CV envelope seam and the vNext-only CV
 * admission consumer.  The validator remains pure; the consumer below reads
 * only canonical vNext facts and delegates the actual Receipt write to the
 * bounded Runtime writer seam.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SchemaValidationError } from '@proofloop/kernel';
import {
  computeDigest,
  computeReceiptDigest,
  validateReceipt,
} from '@proofloop/kernel';
import type {
  Receipt,
  VNextExecutionScope,
  VNextManifest,
  VNextManifestSlice,
} from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
// S09-C-T03: the shared canonical Stage ID guard (`^S\d+$`).  Legacy parked
// labels such as S08B0/S08B fail closed before any Runtime read/write.
import { CANONICAL_STAGE_ID_RE } from './stage-id';
import { readGitHead, resolveGitRoot } from '../git-source';
import { cvReceiptDir, tasksReceiptDir } from '../receipt-layout';
import type {
  AdmitResult,
  ReceiptBuild,
  ReceiptWriterPort,
} from '../admit-pipeline';
import { runReceiptAdmission } from '../admit-pipeline';
import {
  assertVNextManifestReferenceBindings,
  readVNextManifest,
  VNextHandoffError,
} from './dispatch';
import {
  assertClosedVNextCvPayload,
  assertVNextCvChainSequence,
  assertVNextCvProofIndexBindings,
} from './cv-validation';
import { readVNextAdmissionAuthority } from './next';
import {
  VNEXT_WORKER_COMPLETION_MODES,
} from './types';
import type { VNextAdmissionAuthority, VNextCvResultEnvelope } from './types';

interface FieldError {
  readonly path: string;
  readonly message: string;
}

const KNOWN_FIELDS = new Set([
  'schema_version',
  'type',
  'stage_id',
  'slice_id',
  'worker_receipt_digest',
  'manifest_digest',
  'plan_digest',
  'proof_index_digest',
  'context_ref',
  'context_digest',
  'snapshot_digest',
  'verification_type',
  'verdict',
  'summary',
  'acceptance_refs_checked',
  'seam_refs_checked',
  'oracle_refs_checked',
  'risk_refs_considered',
  'failed_acceptance_refs',
  'invalid_tests',
  'counterexamples',
  'scope_violations',
  'forbidden_substitutions',
  'regression_failures',
  'failed_criterion',
  'failure_signature',
  'required_recheck_scope',
  'previous_failure_signature',
  'repair_diff_digest',
]);

const IDENTIFIER_RE = /^[A-Za-z0-9_-]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function add(errors: FieldError[], path: string, message: string): void {
  errors.push({ path, message });
}

function checkUnknownFields(value: Record<string, unknown>, errors: FieldError[]): void {
  for (const key of Object.keys(value)) {
    if (!KNOWN_FIELDS.has(key)) add(errors, `cv_result.${key}`, `Unknown field "${key}"`);
  }
}

function nonEmptyString(
  value: unknown,
  path: string,
  errors: FieldError[],
): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    add(errors, path, 'Expected a non-empty string');
    return false;
  }
  return true;
}

function identifier(value: unknown, path: string, errors: FieldError[]): void {
  if (!nonEmptyString(value, path, errors)) return;
  if (!IDENTIFIER_RE.test(value)) {
    add(errors, path, 'Expected an identifier matching ^[A-Za-z0-9_-]+$');
  }
}

/**
 * S09-C-T03: canonical Stage ID field check — the SAME `^S\d+$` grammar as
 * the candidate parser, compiler, Mechanical Validator, plan/stage/review
 * status and every admission seam.  Legacy parked labels such as S08B0/S08B
 * fail closed before any Runtime read/write.
 */
function canonicalStageId(value: unknown, path: string, errors: FieldError[]): void {
  if (!nonEmptyString(value, path, errors)) return;
  if (!CANONICAL_STAGE_ID_RE.test(value)) {
    add(
      errors,
      path,
      'Expected a canonical Stage ID matching /^S\\d+$/ (e.g. S09); legacy labels such as S08B0/S08B are rejected',
    );
  }
}

function throwValidationError(errors: readonly FieldError[]): never {
  throw new SchemaValidationError(
    `VNextCvResultEnvelope schema validation failed: ${errors
      .map((error) => `${error.path}: ${error.message}`)
      .join('; ')}`,
    [...errors],
  );
}

/**
 * Validate a vNext CV result without performing admission or filesystem I/O.
 *
 * The returned value is the original object on success.  Unknown fields,
 * legacy CV level/profile fields, branch-inappropriate fields, and incomplete
 * PASS/REPAIR metadata are all rejected rather than defaulted.
 *
 * S08-REVIEW-007: the closed v2 CV_RESULT payload validation is delegated to
 * the SHARED `cv-validation` module — the same single truth the `next`
 * consumer applies to persisted CV Receipts — instead of a second hand-written
 * schema. The field-level `SchemaValidationError` vocabulary is preserved so
 * the external contract (field errors, `SchemaValidationError` type) stays
 * stable; without a binding this is the pure schema pass, and the Manifest/
 * Worker bindings (exact Proof Index refs, Worker tip, final Worker Context)
 * are applied by `validateFacts` through the same shared module.
 */
export function validateVNextCvResultEnvelope(value: unknown): VNextCvResultEnvelope {
  if (!isRecord(value)) {
    throwValidationError([
      {
        path: 'cv_result',
        message: 'Expected a non-null object',
      },
    ]);
  }

  const errors: FieldError[] = [];
  checkUnknownFields(value, errors);
  canonicalStageId(value.stage_id, 'cv_result.stage_id', errors);
  identifier(value.slice_id, 'cv_result.slice_id', errors);
  if (errors.length > 0) throwValidationError(errors);

  try {
    assertClosedVNextCvPayload(value);
  } catch (error) {
    if (error instanceof VNextHandoffError) {
      throwValidationError([{ path: 'cv_result', message: error.message }]);
    }
    throw error;
  }
  return value as unknown as VNextCvResultEnvelope;
}

/** Acronym-compatible aliases for Runtime consumers. */
export const validateVNextCVResultEnvelope = validateVNextCvResultEnvelope;
export const validateVNextCvResult = validateVNextCvResultEnvelope;
export const validateVNextCVResult = validateVNextCvResultEnvelope;

// ---------------------------------------------------------------------------
// vNext CV admission core
// ---------------------------------------------------------------------------

/** Dependencies of the pure vNext CV consumer. */
export interface VNextCvAdmissionDependencies {
  readonly projectRoot: string;
  readonly writer?: ReceiptWriterPort;
}

/** Upper-case acronym alias for callers that use `CV` in type names. */
export type VNextCVAdmissionDependencies = VNextCvAdmissionDependencies;

/**
 * Additive state returned after a CV Receipt is admitted.  This is deliberately
 * not a legacy `ReconcileStageResult` and does not claim Slice or Stage
 * completion.
 */
export interface VNextCvAdmissionState {
  readonly schema_version: 2;
  readonly type: 'CV_RESULT';
  readonly action: 'CV_PASS' | 'CV_REPAIR';
  readonly stage_id: string;
  readonly slice_id: string;
  readonly verdict: 'PASS' | 'REPAIR';
  readonly verification_type: 'initial' | 'recheck';
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly proof_index_digest: string;
  readonly snapshot_digest: string;
  readonly context_ref: string;
  readonly context_digest: string;
  readonly worker_receipt_digest: string;
  readonly receipt_chain_valid: true;
}

type CvAdmissionCode =
  | 'RUNTIME.SCHEMA_MISMATCH'
  | 'RUNTIME.RECEIPT_CHAIN_BROKEN'
  | 'DOMAIN.INVALID_TRANSITION';

class VNextCvAdmissionError extends Error {
  readonly code: CvAdmissionCode;

  constructor(code: CvAdmissionCode, message: string) {
    super(message);
    this.name = 'VNextCvAdmissionError';
    this.code = code;
  }
}

interface TaskBinding {
  readonly taskId: string;
  readonly taskRef: string;
  readonly executionScope: VNextExecutionScope;
  readonly allowedCodeScope: readonly string[];
}

interface SliceBinding {
  readonly slice: VNextManifestSlice;
  readonly tasks: readonly TaskBinding[];
  readonly proofIndexDigest: string;
  readonly planPath: string;
  readonly evidencePath: string;
  readonly allowedExecutionScope: readonly string[];
  readonly forbiddenExecutionScope: readonly string[];
}

interface ContextFacts {
  readonly ref: string;
  readonly digest: string;
  readonly taskId: string;
}

interface WorkerChainFacts {
  readonly receipts: readonly Receipt[];
  readonly tipDigest: string;
  readonly contexts: readonly ContextFacts[];
}

interface CvHistoryFacts {
  readonly receipts: readonly Receipt[];
  readonly envelopes: readonly VNextCvResultEnvelope[];
}

interface ValidatedCvFacts {
  readonly root: string;
  readonly manifest: VNextManifest;
  readonly slice: SliceBinding;
  readonly worker: WorkerChainFacts;
  readonly history: CvHistoryFacts;
}

const SYSTEM_FORBIDDEN_PATHS = [
  '.proofloop/manifests',
  '.proofloop/receipts',
  '.proofloop/context',
  '.git',
] as const;

const CONTEXT_FIELDS = new Set([
  'schema_version',
  'root_path',
  'root_digest',
  'stage_id',
  'slice_id',
  'task_id',
  'task_ref',
  'slice_goal_ref',
  'mode',
  'proof_index',
  'required_skills',
  'evidence_path',
  'plan_projection_path',
  'manifest_digest',
  'plan_digest',
  'proof_index_digest',
  'snapshot_digest',
  'allowed_code_scope',
  'context_digest',
  'execution_scope',
  'scope',
]);

const PROOF_INDEX_FIELDS = new Set([
  'goal_ref',
  'task_refs',
  'acceptance_refs',
  'seam_refs',
  'oracle_refs',
  'risk_refs',
]);

const EXECUTION_SCOPE_FIELDS = new Set(['kind', 'code_paths', 'test_paths', 'forbidden_paths']);
const WORKER_SCOPE_FIELDS = new Set(['allowed_paths', 'mutable_projection_paths', 'forbidden_paths']);
const WORKER_PAYLOAD_FIELDS = new Set([
  'schema_version',
  'action_token',
  'mode',
  'outcome',
  'task_id',
  'evidence_ref',
  'changed_files',
  'verification_runs',
  'summary',
  'manifest_digest',
  'plan_digest',
  'proof_index_digest',
  'snapshot_digest',
  'context_ref',
  'context_digest',
]);

function fail(code: CvAdmissionCode, message: string): never {
  throw new VNextCvAdmissionError(code, message);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a non-empty string`);
  }
  return value;
}

function requireDigest(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!SHA256_RE.test(result)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} is not a lowercase SHA-256 digest`);
  }
  return result;
}

function requireStringArray(value: unknown, label: string, nonEmpty = false): string[] {
  if (!Array.isArray(value)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be an array of strings`);
  }
  const result = value.map((item, index) => requireString(item, `${label}[${index}]`));
  if (nonEmpty && result.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must not be empty`);
  }
  if (new Set(result).size !== result.length) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} contains duplicate entries`);
  }
  return result;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be an object`);
  return value;
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !fields.has(key));
  if (unknown.length > 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} contains unknown field(s): ${unknown.join(', ')}`);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameValue(left: unknown, right: unknown): boolean {
  return computeDigest(left) === computeDigest(right);
}

function pathWithin(value: string, base: string): boolean {
  return value === base || value.startsWith(`${base}/`);
}

function pathsOverlap(left: string, right: string): boolean {
  return pathWithin(left, right) || pathWithin(right, left);
}

function canonicalProjectRoot(projectRoot: string): string {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'projectRoot must be an absolute canonical Git worktree path');
  }
  const lexical = path.resolve(projectRoot);
  let root: string;
  try {
    root = fs.realpathSync(lexical);
  } catch {
    fail('RUNTIME.SCHEMA_MISMATCH', `projectRoot is not readable: ${projectRoot}`);
  }
  if (root !== lexical) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'projectRoot is not the canonical worktree path');
  }
  let gitRoot: string;
  try {
    gitRoot = fs.realpathSync(resolveGitRoot(root));
  } catch {
    fail('RUNTIME.SCHEMA_MISMATCH', 'canonical Git root is unavailable');
  }
  if (gitRoot !== root) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'projectRoot is not the canonical Git root');
  }
  return root;
}

function rootRelativePath(root: string, value: unknown, label: string): string {
  const raw = requireString(value, label);
  if (
    path.isAbsolute(raw) ||
    raw.startsWith('//') ||
    raw.includes('\\') ||
    raw.includes('\u0000')
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a canonical root-relative path`);
  }
  const parts = raw.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a canonical root-relative path`);
  }
  const lexical = path.resolve(root, ...parts);
  const canonical = canonicalPathWithinRoot(root, lexical);
  if (canonical === null || canonical !== lexical) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} escapes or traverses a changed path identity`);
  }
  return parts.join('/');
}

function readRootJson(root: string, relative: string, label: string): Record<string, unknown> {
  const canonicalRelative = rootRelativePath(root, relative, label);
  const opened = openNoFollowRead(root, path.resolve(root, ...canonicalRelative.split('/')));
  if (!opened.ok) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} is missing or is not a regular root-bound file`);
  }
  try {
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
    } catch (error) {
      fail(
        'RUNTIME.SCHEMA_MISMATCH',
        `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return requireRecord(value, label);
  } finally {
    fs.closeSync(opened.fd);
  }
}

function canonicalScope(root: string, value: unknown, label: string): VNextExecutionScope {
  const record = requireRecord(value, label);
  assertExactFields(record, EXECUTION_SCOPE_FIELDS, label);
  const kind = requireString(record.kind, `${label}.kind`);
  if (kind !== 'implementation' && kind !== 'evidence-only') {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label}.kind is unsupported: ${kind}`);
  }
  const codePaths = requireStringArray(record.code_paths, `${label}.code_paths`).map((item, index) =>
    rootRelativePath(root, item, `${label}.code_paths[${index}]`),
  );
  const testPaths = requireStringArray(record.test_paths, `${label}.test_paths`).map((item, index) =>
    rootRelativePath(root, item, `${label}.test_paths[${index}]`),
  );
  const forbiddenPaths = requireStringArray(record.forbidden_paths, `${label}.forbidden_paths`).map((item, index) =>
    rootRelativePath(root, item, `${label}.forbidden_paths[${index}]`),
  );
  return {
    kind: kind as VNextExecutionScope['kind'],
    code_paths: codePaths,
    test_paths: testPaths,
    forbidden_paths: forbiddenPaths,
  };
}

function canonicalSystemForbiddenPaths(root: string): string[] {
  return SYSTEM_FORBIDDEN_PATHS.map((value) => rootRelativePath(root, value, 'system forbidden path'));
}

function taskIdsAndBindings(root: string, manifest: VNextManifest, slice: VNextManifestSlice): TaskBinding[] {
  if (slice.proof_index.task_refs.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `Manifest Slice ${slice.slice_id} declares no tasks`);
  }
  const seen = new Set<string>();
  return slice.proof_index.task_refs.map((refId, index) => {
    const descriptor = manifest.reference_index[refId];
    if (descriptor === undefined || descriptor.kind !== 'task') {
      fail('RUNTIME.SCHEMA_MISMATCH', `Manifest Slice task ref ${refId} is unavailable or not a task`);
    }
    const match = /#\/entities\/([^/]+)$/.exec(descriptor.ref);
    if (match === null || match[1] === undefined) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Manifest Slice task ref ${refId} has no canonical entity ID`);
    }
    const taskId = match[1];
    if (!taskId.startsWith(`${slice.slice_id}-`)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Manifest task ${taskId} is outside Slice ${slice.slice_id}`);
    }
    if (seen.has(taskId)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Manifest Slice contains duplicate task ${taskId}`);
    }
    seen.add(taskId);
    const scopeBinding = manifest.task_scopes[taskId];
    if (scopeBinding === undefined || scopeBinding.task_ref !== descriptor.ref) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Manifest execution scope is not bound to task ${taskId}`);
    }
    const executionScope = canonicalScope(root, scopeBinding.execution_scope, `task ${taskId}.execution_scope`);
    if (
      executionScope.kind !== 'implementation' ||
      executionScope.code_paths.length === 0 ||
      executionScope.test_paths.length === 0
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Task ${taskId} has no non-empty implementation code/test scope`);
    }
    return {
      taskId,
      taskRef: descriptor.ref,
      executionScope,
      allowedCodeScope: unique([...executionScope.code_paths, ...executionScope.test_paths]),
    };
  });
}

function sliceBinding(root: string, manifest: VNextManifest, sliceId: string): SliceBinding {
  const slice = manifest.slices.find((candidate) => candidate.slice_id === sliceId);
  if (slice === undefined) {
    fail('RUNTIME.SCHEMA_MISMATCH', `Manifest does not declare Slice ${sliceId}`);
  }
  const tasks = taskIdsAndBindings(root, manifest, slice);
  const planPath = rootRelativePath(root, manifest.plan.ref, 'Manifest.plan.ref');
  const evidencePath = rootRelativePath(root, slice.evidence_path, 'Manifest Slice Evidence path');
  const allCodeScope = unique(tasks.flatMap((task) => task.allowedCodeScope));
  const allForbidden = unique([
    ...tasks.flatMap((task) => task.executionScope.forbidden_paths),
    ...canonicalSystemForbiddenPaths(root),
  ]);
  const allowed = unique([...allCodeScope, evidencePath, planPath]);
  for (const permitted of allowed) {
    for (const forbidden of allForbidden) {
      if (pathsOverlap(permitted, forbidden)) {
        fail('RUNTIME.SCHEMA_MISMATCH', `Manifest execution scope overlaps forbidden path: ${permitted}`);
      }
    }
  }
  return {
    slice,
    tasks,
    proofIndexDigest: computeDigest(slice.proof_index),
    planPath,
    evidencePath,
    allowedExecutionScope: allowed,
    forbiddenExecutionScope: allForbidden,
  };
}

function expectedContextProofIndex(slice: VNextManifestSlice): Record<string, unknown> {
  return {
    goal_ref: slice.proof_index.goal_ref,
    task_refs: [...slice.proof_index.task_refs],
    acceptance_refs: [...slice.proof_index.acceptance_refs],
    seam_refs: [...slice.proof_index.seam_refs],
    oracle_refs: [...slice.proof_index.oracle_refs],
    risk_refs: slice.proof_index.risk_refs.map((risk) => risk.ref_id),
  };
}

function validateContext(
  root: string,
  manifest: VNextManifest,
  slice: SliceBinding,
  envelope: VNextCvResultEnvelope,
  task: TaskBinding,
  contextRef: string,
  contextDigest: string,
  mode: string,
): ContextFacts {
  const expectedRef = `.proofloop/context/${contextDigest}.json`;
  if (contextRef !== expectedRef) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context ref is not digest-addressed by context_digest');
  }
  const context = readRootJson(root, contextRef, 'Context');
  assertExactFields(context, CONTEXT_FIELDS, 'Context');
  if (context.schema_version !== 2 || context.context_digest !== contextDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context discriminator or context_digest is invalid');
  }
  const withoutDigest = { ...context };
  delete withoutDigest.context_digest;
  if (computeDigest(withoutDigest) !== contextDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context content does not match context_digest');
  }
  if ((VNEXT_WORKER_COMPLETION_MODES as readonly string[]).includes(context.mode as string) === false) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context mode binding is outside the closed completion vocabulary');
  }
  if (context.mode !== mode) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `Context mode binding "${String(context.mode)}" does not match the Worker fact mode "${mode}"`,
    );
  }

  const expectedRootDigest = computeDigest(root);
  if (
    context.root_path !== root ||
    context.root_digest !== expectedRootDigest ||
    context.stage_id !== envelope.stage_id ||
    context.slice_id !== envelope.slice_id ||
    context.task_id !== task.taskId ||
    context.task_ref !== task.taskRef ||
    context.manifest_digest !== envelope.manifest_digest ||
    context.plan_digest !== envelope.plan_digest ||
    context.proof_index_digest !== envelope.proof_index_digest ||
    context.snapshot_digest !== envelope.snapshot_digest
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context is not bound to the active vNext execution tuple');
  }
  if (
    context.evidence_path !== slice.evidencePath ||
    context.plan_projection_path !== slice.planPath
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context artifact paths do not match the Manifest');
  }

  const proofIndex = requireRecord(context.proof_index, 'Context.proof_index');
  assertExactFields(proofIndex, PROOF_INDEX_FIELDS, 'Context.proof_index');
  if (!sameValue(proofIndex, expectedContextProofIndex(slice.slice))) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context Proof Index does not match the Manifest Slice');
  }
  if (context.slice_goal_ref !== slice.slice.proof_index.goal_ref) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context slice_goal_ref is not bound to the Slice Proof Index');
  }
  const requiredSkills = requireStringArray(context.required_skills, 'Context.required_skills');
  if (!sameValue(requiredSkills, slice.slice.required_skills)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context required_skills do not match the Manifest Slice');
  }
  if (context.proof_index_digest !== slice.proofIndexDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context proof_index_digest does not match the Manifest Slice');
  }

  const executionScope = canonicalScope(root, context.execution_scope, 'Context.execution_scope');
  if (!sameValue(executionScope, task.executionScope)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context execution_scope does not match the Manifest task scope');
  }
  const allowedCodeScope = requireStringArray(context.allowed_code_scope, 'Context.allowed_code_scope')
    .map((item, index) => rootRelativePath(root, item, `Context.allowed_code_scope[${index}]`));
  if (!sameValue(allowedCodeScope, task.allowedCodeScope)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context allowed_code_scope is not the exact task code/test scope');
  }

  const scope = requireRecord(context.scope, 'Context.scope');
  assertExactFields(scope, WORKER_SCOPE_FIELDS, 'Context.scope');
  const allowedPaths = requireStringArray(scope.allowed_paths, 'Context.scope.allowed_paths')
    .map((item, index) => rootRelativePath(root, item, `Context.scope.allowed_paths[${index}]`));
  const mutableProjectionPaths = requireStringArray(
    scope.mutable_projection_paths,
    'Context.scope.mutable_projection_paths',
  ).map((item, index) => rootRelativePath(root, item, `Context.scope.mutable_projection_paths[${index}]`));
  const forbiddenPaths = requireStringArray(scope.forbidden_paths, 'Context.scope.forbidden_paths')
    .map((item, index) => rootRelativePath(root, item, `Context.scope.forbidden_paths[${index}]`));
  const expectedAllowedPaths = unique([...task.allowedCodeScope, slice.evidencePath, slice.planPath]);
  const expectedForbiddenPaths = unique([
    ...task.executionScope.forbidden_paths,
    ...canonicalSystemForbiddenPaths(root),
  ]);
  if (!sameValue(allowedPaths, expectedAllowedPaths)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context scope.allowed_paths is broader than the Manifest task scope');
  }
  if (!sameValue(mutableProjectionPaths, [slice.planPath])) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context mutable projection is not exactly Manifest.plan.ref');
  }
  if (!sameValue(forbiddenPaths, expectedForbiddenPaths)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context scope.forbidden_paths does not match the Manifest scope');
  }
  for (const allowed of allowedPaths) {
    for (const forbidden of forbiddenPaths) {
      if (pathsOverlap(allowed, forbidden)) {
        fail('RUNTIME.SCHEMA_MISMATCH', `Context allowed path overlaps forbidden path: ${allowed}`);
      }
    }
  }
  return { ref: contextRef, digest: contextDigest, taskId: task.taskId };
}

function canonicalReceiptDirectory(root: string, directory: string, label: string): string {
  const lexical = path.resolve(directory);
  const canonical = canonicalPathWithinRoot(root, lexical);
  if (canonical === null || canonical !== lexical) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} is not a canonical directory under the project root`);
  }
  return lexical;
}

interface ReceiptChainFacts {
  readonly receipts: readonly Receipt[];
  readonly tipDigest: string | null;
}

/** Read one canonical Receipt chain without using the legacy receipt reader. */
function readReceiptChain(root: string, directory: string, label: string): ReceiptChainFacts {
  const canonicalDirectory = canonicalReceiptDirectory(root, directory, label);
  let names: string[];
  try {
    const stat = fs.statSync(canonicalDirectory);
    if (!stat.isDirectory()) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} is not a directory`);
    }
    names = fs.readdirSync(canonicalDirectory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { receipts: [], tipDigest: null };
    }
    if (error instanceof VNextCvAdmissionError) throw error;
    fail(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const byDigest = new Map<string, Receipt>();
  for (const name of names) {
    const file = path.join(canonicalDirectory, name);
    const opened = openNoFollowRead(root, file);
    if (!opened.ok || opened.filePath !== file) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains an unreadable or redirected Receipt: ${name}`);
    }
    let receipt: Receipt;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
      } catch (error) {
        fail(
          'RUNTIME.RECEIPT_CHAIN_BROKEN',
          `${label} Receipt ${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        receipt = validateReceipt(parsed);
      } catch (error) {
        fail(
          'RUNTIME.RECEIPT_CHAIN_BROKEN',
          `${label} Receipt ${name} failed schema validation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      fs.closeSync(opened.fd);
    }
    if (!SHA256_RE.test(receipt.digest)) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} Receipt ${name} has an invalid digest`);
    }
    if (name !== `${receipt.digest}.json`) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} Receipt filename is not digest-addressed: ${name}`);
    }
    const { digest: ignoredDigest, ...content } = receipt;
    void ignoredDigest;
    if (computeReceiptDigest(content) !== receipt.digest) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} Receipt ${name} has an invalid self-digest`);
    }
    if (byDigest.has(receipt.digest)) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains duplicate Receipt digest ${receipt.digest}`);
    }
    byDigest.set(receipt.digest, receipt);
  }

  if (byDigest.size === 0) return { receipts: [], tipDigest: null };
  const successors = new Map<string, string>();
  const genesis: string[] = [];
  for (const receipt of byDigest.values()) {
    const previous = receipt.previous_digest;
    if (previous === undefined || previous === '') {
      genesis.push(receipt.digest);
      continue;
    }
    if (!SHA256_RE.test(previous) || !byDigest.has(previous)) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} has a broken previous_digest link at ${receipt.digest}`);
    }
    if (successors.has(previous)) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains a fork at predecessor ${previous}`);
    }
    successors.set(previous, receipt.digest);
  }
  if (genesis.length !== 1) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} must contain exactly one chain genesis`);
  }

  const ordered: Receipt[] = [];
  const visited = new Set<string>();
  let current: string | undefined = genesis[0];
  while (current !== undefined) {
    if (visited.has(current)) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains a circular Receipt chain`);
    }
    const receipt = byDigest.get(current);
    if (receipt === undefined) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains an unreachable Receipt`);
    }
    visited.add(current);
    ordered.push(receipt);
    current = successors.get(current);
  }
  if (visited.size !== byDigest.size) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains an unreachable Receipt branch`);
  }
  return { receipts: ordered, tipDigest: ordered[ordered.length - 1].digest };
}

function assertTuple(
  value: Record<string, unknown>,
  envelope: VNextCvResultEnvelope,
  label: string,
): void {
  if (
    value.schema_version !== 2 ||
    value.manifest_digest !== envelope.manifest_digest ||
    value.plan_digest !== envelope.plan_digest ||
    value.proof_index_digest !== envelope.proof_index_digest ||
    value.snapshot_digest !== envelope.snapshot_digest
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} is stale or not bound to the active vNext tuple`);
  }
}

function assertPathsWithinScope(
  paths: readonly string[],
  allowed: readonly string[],
  forbidden: readonly string[],
  label: string,
): void {
  for (const value of paths) {
    if (forbidden.some((base) => pathsOverlap(value, base))) {
      fail('RUNTIME.SCHEMA_MISMATCH', `${label} contains a forbidden path: ${value}`);
    }
    if (!allowed.some((base) => pathWithin(value, base))) {
      fail('RUNTIME.SCHEMA_MISMATCH', `${label} expands beyond the admitted execution scope: ${value}`);
    }
  }
}

function validateWorkerChain(
  root: string,
  manifest: VNextManifest,
  slice: SliceBinding,
  envelope: VNextCvResultEnvelope,
): WorkerChainFacts {
  const chain = readReceiptChain(
    root,
    tasksReceiptDir(root, envelope.stage_id, envelope.slice_id),
    'vNext Worker Receipt chain',
  );
  if (chain.receipts.length === 0 || chain.tipDigest === null) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'all Manifest tasks must have v2 TASK_COMPLETE Receipts before CV admission');
  }
  if (chain.receipts.length !== slice.tasks.length) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `Worker Receipt count ${chain.receipts.length} does not equal Manifest task count ${slice.tasks.length}`,
    );
  }

  const contexts: ContextFacts[] = [];
  const actionTokens = new Set<string>();
  for (const [index, receipt] of chain.receipts.entries()) {
    if (
      receipt.version !== 1 ||
      receipt.type !== 'TASK_COMPLETE' ||
      receipt.stage_id !== envelope.stage_id ||
      receipt.slice_id !== envelope.slice_id
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Worker Receipt chain contains a legacy, mixed, or wrong-slice Receipt');
    }
    const payload = requireRecord(receipt.payload, `TASK_COMPLETE[${index}].payload`);
    assertExactFields(payload, WORKER_PAYLOAD_FIELDS, `TASK_COMPLETE[${index}].payload`);
    const task = slice.tasks[index];
    if (task === undefined) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Worker Receipt chain contains an undeclared task');
    }
    if (
      (payload.mode !== 'implement-task' && payload.mode !== 'recover-task') ||
      payload.outcome !== 'completed'
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Worker Receipt chain contains a non-completed or legacy Worker fact');
    }
    const actionToken = requireString(payload.action_token, `TASK_COMPLETE[${index}].action_token`);
    if (actionTokens.has(actionToken)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Worker Receipt chain reuses action_token ${actionToken}`);
    }
    actionTokens.add(actionToken);
    if (payload.task_id !== task.taskId) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Worker Receipt order/task binding does not match Manifest task ${task.taskId}`);
    }
    assertTuple(payload, envelope, `TASK_COMPLETE[${index}]`);
    if (payload.proof_index_digest !== slice.proofIndexDigest) {
      fail('RUNTIME.SCHEMA_MISMATCH', `TASK_COMPLETE[${index}] proof_index_digest is stale`);
    }
    if (payload.evidence_ref !== slice.evidencePath) {
      fail('RUNTIME.SCHEMA_MISMATCH', `TASK_COMPLETE[${index}] evidence_ref is not Manifest-bound`);
    }
    const changedFiles = requireStringArray(payload.changed_files, `TASK_COMPLETE[${index}].changed_files`, true)
      .map((item, fileIndex) => rootRelativePath(root, item, `TASK_COMPLETE[${index}].changed_files[${fileIndex}]`));
    assertPathsWithinScope(
      changedFiles,
      slice.allowedExecutionScope,
      slice.forbiddenExecutionScope,
      `TASK_COMPLETE[${index}].changed_files`,
    );
    if (!changedFiles.includes(slice.evidencePath) || !changedFiles.includes(slice.planPath)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `TASK_COMPLETE[${index}].changed_files omits the Evidence or Plan projection`);
    }
    if (!Array.isArray(payload.verification_runs)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `TASK_COMPLETE[${index}].verification_runs must be an array`);
    }
    requireString(payload.summary, `TASK_COMPLETE[${index}].summary`);
    const contextRef = requireString(payload.context_ref, `TASK_COMPLETE[${index}].context_ref`);
    const contextDigest = requireDigest(payload.context_digest, `TASK_COMPLETE[${index}].context_digest`);
    const context = validateContext(
      root,
      manifest,
      slice,
      envelope,
      task,
      contextRef,
      contextDigest,
      requireString(payload.mode, `TASK_COMPLETE[${index}].mode`),
    );
    contexts.push(context);
  }
  return {
    receipts: chain.receipts,
    tipDigest: chain.tipDigest,
    contexts,
  };
}

function assertCvProofBindings(envelope: VNextCvResultEnvelope, slice: SliceBinding): void {
  // S08-REVIEW-007: the exact Proof Index reference set validation is the
  // SHARED cv-validation module (the single truth the next consumer also
  // applies through `assertClosedVNextCvPayload`), not a hand-written copy.
  // The shared errors are projected as RUNTIME.SCHEMA_MISMATCH like the
  // pre-existing cv-admission contract.
  try {
    assertVNextCvProofIndexBindings(envelope as unknown as Record<string, unknown>, {
      acceptanceRefs: slice.slice.proof_index.acceptance_refs,
      seamRefs: slice.slice.proof_index.seam_refs,
      oracleRefs: slice.slice.proof_index.oracle_refs,
      riskRefIds: slice.slice.proof_index.risk_refs.map((risk) => risk.ref_id),
    });
  } catch (error) {
    if (error instanceof VNextHandoffError) {
      fail('RUNTIME.SCHEMA_MISMATCH', error.message);
    }
    throw error;
  }
}

function validateCvHistory(
  root: string,
  slice: SliceBinding,
  envelope: VNextCvResultEnvelope,
  worker: WorkerChainFacts,
): CvHistoryFacts {
  const chain = readReceiptChain(
    root,
    cvReceiptDir(root, envelope.stage_id, envelope.slice_id),
    'vNext CV Receipt chain',
  );
  const workerDigests = new Set(worker.receipts.map((receipt) => receipt.digest));
  const envelopes: VNextCvResultEnvelope[] = [];
  for (const [index, receipt] of chain.receipts.entries()) {
    if (
      receipt.version !== 1 ||
      (receipt.type !== 'CV_PASS' && receipt.type !== 'CV_REPAIR') ||
      receipt.stage_id !== envelope.stage_id ||
      receipt.slice_id !== envelope.slice_id
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'CV Receipt chain contains a legacy, mixed, or wrong-slice Receipt');
    }
    let prior: VNextCvResultEnvelope;
    try {
      prior = validateVNextCvResultEnvelope(receipt.payload);
    } catch (error) {
      fail(
        'RUNTIME.RECEIPT_CHAIN_BROKEN',
        `vNext CV Receipt ${index} is not a valid closed CV envelope: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (prior.verdict === 'PASS' && receipt.type !== 'CV_PASS') {
      fail('RUNTIME.SCHEMA_MISMATCH', `CV Receipt ${index} discriminator does not match verdict PASS`);
    }
    if (prior.verdict === 'REPAIR' && receipt.type !== 'CV_REPAIR') {
      fail('RUNTIME.SCHEMA_MISMATCH', `CV Receipt ${index} discriminator does not match verdict REPAIR`);
    }
    if (prior.stage_id !== envelope.stage_id || prior.slice_id !== envelope.slice_id) {
      fail('RUNTIME.SCHEMA_MISMATCH', `CV Receipt ${index} stage/slice binding is stale`);
    }
    assertTuple(prior as unknown as Record<string, unknown>, envelope, `CV Receipt ${index}`);
    if (!workerDigests.has(prior.worker_receipt_digest as string)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `CV Receipt ${index} is not bound to the current Worker Receipt chain`);
    }
    assertCvProofBindings(prior, slice);
    // S08-REVIEW-009: every persisted CV fact of the Slice must satisfy the
    // SAME full shared-validator binding the `next` recovery consumer applies
    // (`readVNextCvReceiptFacts`): the exact Manifest Proof Index reference
    // sets, the Worker chain TIP (not merely membership in the Worker chain),
    // and the FINAL Worker Context digest. A self-digest-correct history fact
    // that binds an earlier Context or a non-tip Worker Receipt is legal for
    // neither consumer — admission must reach the same verdict as recovery so
    // a CV chain can never be written that a later Commit/restart rejects.
    // The latest completed Worker Context is the only digest an admitted CV
    // fact may bind (a Worker repair does not produce a new Worker Receipt,
    // so REPAIR → recheck both bind the same final Context).
    const latestWorkerContext = worker.contexts[worker.contexts.length - 1];
    try {
      assertClosedVNextCvPayload(prior as unknown as Record<string, unknown>, {
        stageId: envelope.stage_id,
        sliceId: envelope.slice_id,
        manifestDigest: envelope.manifest_digest,
        planDigest: envelope.plan_digest,
        proofIndexDigest: slice.proofIndexDigest,
        workerTipDigest: worker.tipDigest,
        expectedAcceptanceRefs: slice.slice.proof_index.acceptance_refs,
        expectedSeamRefs: slice.slice.proof_index.seam_refs,
        expectedOracleRefs: slice.slice.proof_index.oracle_refs,
        expectedRiskRefs: slice.slice.proof_index.risk_refs.map((risk) => risk.ref_id),
        expectedContextDigest: latestWorkerContext?.digest,
      });
    } catch (error) {
      if (error instanceof VNextHandoffError) {
        fail(
          'RUNTIME.SCHEMA_MISMATCH',
          `CV Receipt ${index} is not bound to the active vNext Worker/Manifest facts: ${error.message}`,
        );
      }
      throw error;
    }
    envelopes.push(prior);
  }
  return { receipts: chain.receipts, envelopes };
}

/**
 * Whether `candidate` is on the admitted execution snapshot chain: equal to
 * the admitted snapshot or a Git descendant of it
 * (`git merge-base --is-ancestor <admitted> <candidate>`).
 *
 * Slice Commit is a normal execution Git boundary: it legitimately advances
 * HEAD — and may advance later execution facts — to a descendant of the
 * admission snapshot. An unrelated/reverted snapshot is never an execution
 * fact; an unavailable Git boundary also fails closed.
 */
function snapshotOnAdmittedChain(root: string, candidate: string, admittedSnapshot: string): boolean {
  if (candidate === admittedSnapshot) return true;
  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(root);
  } catch {
    return false;
  }
  try {
    execFileSync(
      'git',
      ['-C', gitRoot, 'merge-base', '--is-ancestor', admittedSnapshot, candidate],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return true;
  } catch {
    return false;
  }
}

function validateFacts(
  value: VNextCvResultEnvelope,
  dependencies: VNextCvAdmissionDependencies,
): ValidatedCvFacts {
  const root = canonicalProjectRoot(dependencies.projectRoot);
  // The authority is read before the snapshot assertion so the CV result can
  // be checked against the admitted snapshot chain (Slice Commit legitimately
  // advanced HEAD to a descendant of the admission snapshot).
  let authority: VNextAdmissionAuthority;
  try {
    authority = readVNextAdmissionAuthority(root, value.stage_id);
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `vNext Stage Plan/SPV authority is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const admittedSnapshot = authority.spv.snapshot_digest;
  const currentHead = readGitHead(root);
  if (currentHead !== value.snapshot_digest && !snapshotOnAdmittedChain(root, value.snapshot_digest, admittedSnapshot)) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `snapshot_digest does not match current Git HEAD nor the admitted vNext execution snapshot chain: ${value.snapshot_digest} != ${currentHead}`,
    );
  }

  const manifestPath = path.join(root, '.proofloop', 'manifests', `${value.stage_id}.json`);
  const manifest = readVNextManifest(root, manifestPath);
  if (manifest.version !== 2 || manifest.plan.schema_version !== 2) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'CV admission accepts only an explicit vNext schema-v2 Manifest');
  }
  if (manifest.stage_id !== value.stage_id) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Manifest stage_id does not match the CV result');
  }
  if (computeDigest(manifest) !== value.manifest_digest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'manifest_digest does not match the canonical vNext Manifest');
  }
  if (manifest.plan.plan_digest !== value.plan_digest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'plan_digest does not match Manifest.plan.plan_digest');
  }
  try {
    assertVNextManifestReferenceBindings(root, manifest);
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `Manifest/Plan reference binding failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const fact of [authority.stagePlan, authority.spv]) {
    if (
      fact.stage_id !== value.stage_id ||
      fact.manifest_digest !== value.manifest_digest ||
      fact.plan_digest !== value.plan_digest
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Stage Plan/SPV authority does not bind the CV result tuple');
    }
    // The CV result snapshot must be the admitted snapshot or a legal Git
    // descendant of it (an execution fact after Slice Commit advanced HEAD);
    // Manifest/Plan digests stay strictly bound.
    if (!snapshotOnAdmittedChain(root, value.snapshot_digest, fact.snapshot_digest)) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Stage Plan/SPV authority does not bind the CV result snapshot');
    }
  }
  if (authority.stagePlan.spv_receipt_digest !== authority.spv.digest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Stage Plan authority is not bound to the fresh SPV_PASS Receipt');
  }

  const slice = sliceBinding(root, manifest, value.slice_id);
  if (value.proof_index_digest !== slice.proofIndexDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'proof_index_digest does not match the Manifest Slice Proof Index');
  }
  const worker = validateWorkerChain(root, manifest, slice, value);
  if (value.worker_receipt_digest !== worker.tipDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'worker_receipt_digest does not match the current Worker Receipt chain tip');
  }
  const latestTask = slice.tasks[slice.tasks.length - 1];
  const latestContext = worker.contexts[worker.contexts.length - 1];
  if (latestTask === undefined || latestContext === undefined) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'current Slice has no complete Worker Context chain');
  }
  // S08-REVIEW-007: the shared validator is bound to the persisted
  // Manifest/Worker facts — the EXACT Proof Index reference sets and the
  // final Worker Context digest — so CV admission applies the same
  // single-truth checks as the `next` consumer (a CV bound to a
  // nonexistent/earlier Context or divergent refs is rejected identically).
  try {
    assertClosedVNextCvPayload(value, {
      stageId: value.stage_id,
      sliceId: value.slice_id,
      manifestDigest: value.manifest_digest,
      planDigest: value.plan_digest,
      proofIndexDigest: slice.proofIndexDigest,
      workerTipDigest: worker.tipDigest,
      expectedAcceptanceRefs: slice.slice.proof_index.acceptance_refs,
      expectedSeamRefs: slice.slice.proof_index.seam_refs,
      expectedOracleRefs: slice.slice.proof_index.oracle_refs,
      expectedRiskRefs: slice.slice.proof_index.risk_refs.map((risk) => risk.ref_id),
      expectedContextDigest: latestContext.digest,
    });
  } catch (error) {
    if (error instanceof VNextHandoffError) {
      fail('RUNTIME.SCHEMA_MISMATCH', error.message);
    }
    throw error;
  }
  validateContext(
    root,
    manifest,
    slice,
    value,
    latestTask,
    value.context_ref,
    value.context_digest,
    requireString(
      worker.receipts[worker.receipts.length - 1]?.payload['mode'],
      'latest TASK_COMPLETE.mode',
    ),
  );

  const history = validateCvHistory(root, slice, value, worker);
  // A Worker repair does not produce a new Worker Receipt, so a legal
  // REPAIR → recheck sequence binds the recheck to the SAME Worker Receipt
  // tip as the preceding CV_REPAIR — and that successor relation may repeat
  // for every round of a multi-round repair loop (initial REPAIR → recheck
  // REPAIR → recheck REPAIR → … → recheck PASS, all on the same tip).
  // S08-REVIEW-008 requires admission to reach the same verdict as recovery
  // (`assertVNextCvChainSequence` allows any number of same-tip rechecks
  // whose immediate predecessor is a same-tip REPAIR), so when the candidate
  // is a legal recheck tail the duplicate guard exempts the WHOLE tail
  // segment of consecutive same-tip envelopes whose every non-head member's
  // predecessor is a same-tip REPAIR: scanning backwards from the tail, keep
  // exempting while the tip stays identical and the predecessor is a REPAIR;
  // stop at a different tip or a non-REPAIR predecessor. Everything else
  // stays fail-closed (the recheck branch below still enforces a REPAIR
  // predecessor + matching failure signature).
  const previousEnvelope = history.envelopes[history.envelopes.length - 1];
  const legalRecheckTail =
    value.verification_type === 'recheck' &&
    previousEnvelope !== undefined &&
    previousEnvelope.verdict === 'REPAIR' &&
    previousEnvelope.worker_receipt_digest === value.worker_receipt_digest;
  let exemptTailStart = history.envelopes.length;
  if (legalRecheckTail && history.envelopes.length > 0) {
    exemptTailStart = history.envelopes.length - 1;
    while (exemptTailStart > 0) {
      const predecessor = history.envelopes[exemptTailStart - 1];
      if (predecessor.worker_receipt_digest !== value.worker_receipt_digest) break;
      if (predecessor.verdict !== 'REPAIR') break;
      exemptTailStart -= 1;
    }
  }
  const duplicatePredecessor = history.envelopes.some(
    (prior, index) =>
      prior.worker_receipt_digest === value.worker_receipt_digest && index < exemptTailStart,
  );
  if (duplicatePredecessor) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      `Worker Receipt ${value.worker_receipt_digest} already has an admitted vNext CV result`,
    );
  }
  if (value.verification_type === 'initial' && history.envelopes.length > 0) {
    fail('DOMAIN.INVALID_TRANSITION', 'initial CV admission is already present for this Slice');
  }
  if (value.verification_type === 'recheck') {
    const previous = history.envelopes[history.envelopes.length - 1];
    if (previous === undefined || previous.verdict !== 'REPAIR') {
      fail('DOMAIN.INVALID_TRANSITION', 'CV recheck requires a preceding CV_REPAIR Receipt');
    }
    if (previous.failure_signature !== value.previous_failure_signature) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'previous_failure_signature does not match the latest CV_REPAIR fact');
    }
  }
  // S08-REVIEW-008: the FULL persisted CV chain + this candidate must also
  // satisfy the closed chain sequence the `next` recovery consumer applies
  // (`assertVNextCvChainSequence`). `validateCvHistory` validates each
  // persisted fact individually and the transition rules above bind the
  // candidate to the LAST history fact, but a bad-fact chain — e.g. a
  // closed-schema-valid recheck CV_REPAIR persisted as the chain genesis —
  // can still carry a matching-signature recheck candidate through both:
  // admission would write a Receipt the next restart recovery rejects as an
  // illegal genesis. The chain sequence check covers history + candidate so
  // admission and recovery reach the same verdict, and a non-initial genesis
  // or any other illegal predecessor relation fails closed before any write
  // (S08-E seam: no wrong Receipt is written on a missing/illegal preceding
  // fact). The candidate is not yet persisted, so it is passed as a
  // composite member beside the persisted history receipts.
  try {
    assertVNextCvChainSequence([
      ...history.receipts,
      {
        type: value.verdict === 'PASS' ? 'CV_PASS' : 'CV_REPAIR',
        payload: value,
      },
    ]);
  } catch (error) {
    if (error instanceof VNextHandoffError) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', error.message);
    }
    throw error;
  }
  return { root, manifest, slice, worker, history };
}

function cvReceiptBuild(
  envelope: VNextCvResultEnvelope,
): ReceiptBuild {
  return {
    type: envelope.verdict === 'PASS' ? 'CV_PASS' : 'CV_REPAIR',
    stage_id: envelope.stage_id,
    slice_id: envelope.slice_id,
    timestamp: new Date().toISOString(),
    payload: {
      ...envelope,
      risk_refs_considered: envelope.risk_refs_considered.map((risk) => ({ ...risk })),
      acceptance_refs_checked: [...envelope.acceptance_refs_checked],
      seam_refs_checked: [...envelope.seam_refs_checked],
      oracle_refs_checked: [...envelope.oracle_refs_checked],
      failed_acceptance_refs: [...envelope.failed_acceptance_refs],
      invalid_tests: [...envelope.invalid_tests],
      counterexamples: [...envelope.counterexamples],
      scope_violations: [...envelope.scope_violations],
      forbidden_substitutions: [...envelope.forbidden_substitutions],
      regression_failures: [...envelope.regression_failures],
      ...(envelope.verdict === 'REPAIR'
        ? { required_recheck_scope: [...envelope.required_recheck_scope] }
        : {}),
    },
  };
}

function cvState(
  envelope: VNextCvResultEnvelope,
  workerReceiptDigest: string,
): VNextCvAdmissionState {
  return {
    schema_version: 2,
    type: 'CV_RESULT',
    action: envelope.verdict === 'PASS' ? 'CV_PASS' : 'CV_REPAIR',
    stage_id: envelope.stage_id,
    slice_id: envelope.slice_id,
    verdict: envelope.verdict,
    verification_type: envelope.verification_type,
    manifest_digest: envelope.manifest_digest,
    plan_digest: envelope.plan_digest,
    proof_index_digest: envelope.proof_index_digest,
    snapshot_digest: envelope.snapshot_digest,
    context_ref: envelope.context_ref,
    context_digest: envelope.context_digest,
    worker_receipt_digest: workerReceiptDigest,
    receipt_chain_valid: true,
  };
}

function rejectedCv(
  message: string,
  code: CvAdmissionCode = 'RUNTIME.SCHEMA_MISMATCH',
): AdmitResult<VNextCvAdmissionState> {
  return {
    accepted: false,
    receipt_ref: null,
    new_state: null,
    findings: [{ code, severity: 'error', message }],
  };
}

/** Admit one explicit v2 CV result without entering legacy reconcile/reducer code. */
export function admitVNextCVResult(
  value: unknown,
  dependencies: VNextCvAdmissionDependencies,
): AdmitResult<VNextCvAdmissionState> {
  let envelope: VNextCvResultEnvelope;
  try {
    envelope = validateVNextCvResultEnvelope(value);
  } catch (error) {
    return rejectedCv(
      `vNext CV result rejected by closed schema: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let facts: ValidatedCvFacts;
  try {
    facts = validateFacts(envelope, dependencies);
  } catch (error) {
    const code = error instanceof VNextCvAdmissionError ? error.code : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedCv(
      `vNext CV admission blocked: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  const admissionKey = `vnext-cv:${envelope.stage_id}:${envelope.slice_id}`;
  return runReceiptAdmission<VNextCvAdmissionState>({
    build: cvReceiptBuild(envelope),
    targetDir: cvReceiptDir(facts.root, envelope.stage_id, envelope.slice_id),
    nextState: cvState(envelope, facts.worker.tipDigest),
    writer: dependencies.writer,
    projectRoot: facts.root,
    admissionKey,
    beforeWrite: () => {
      const current = validateFacts(envelope, dependencies);
      if (current.worker.tipDigest !== facts.worker.tipDigest) {
        fail('RUNTIME.SCHEMA_MISMATCH', 'Worker Receipt chain changed before CV Receipt write');
      }
    },
  });
}

/** Lower-case acronym alias retained for Runtime naming symmetry. */
export const admitVNextCvResult = admitVNextCVResult;
