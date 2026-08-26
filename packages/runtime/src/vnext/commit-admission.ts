/**
 * vNext Slice Commit admission.
 *
 * This consumer is deliberately independent from the legacy
 * reconcile/reducer/receipt-reader path.  It revalidates the persisted vNext
 * Worker and CV facts, checks the committed Git boundary, and delegates the
 * single Receipt write to the bounded Runtime admission seam.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { detectPlanManifestRoute } from '../plan-services';
import {
  committerReceiptDir,
  cvReceiptDir,
  tasksReceiptDir,
} from '../receipt-layout';
import type {
  AdmitResult,
  ReceiptBuild,
  ReceiptWriterPort,
} from '../admit-pipeline';
import { runReceiptAdmission } from '../admit-pipeline';
import type { SliceCommitAdmissionRequest } from '../admission-request';
import { validateVNextCvResultEnvelope } from './cv-admission';
import {
  assertSliceLocalCredentialBindingFields,
  assertUpstreamTaskCompleteSemantics,
  credentialSchemaVersionMismatch,
} from './cv-validation';
import type { VNextSliceLocalBindingExpectation } from './cv-validation';
// S12-D-T04 (S12-D REPLAN): the slice-local binding expectation (stage/slice
// contract digests + recomputed execution binding) is the single shared
// computation of the Worker/CV/Commit/Integration credential consumers.
import { computeSliceLocalBindingExpectation } from './dispatch';
import { loadAncestorReplanDispositionRecords, readCurrentEpoch } from './replan-epoch';
import { isVNextHistoricalInvalidatedCommitPayload, isVNextHistoricalInvalidatedCvPayload, isVNextHistoricalInvalidatedWorkerPayload } from './finalize-lineage';
import { assertHistoricalInvalidatedWorkerGenerations } from './integration-validation';
import {
  loadSliceCommitPolicy,
  validateSliceCommitChangedFiles,
} from './slice-commit-policy';
import type { SliceCommitPolicyFacts } from './slice-commit-policy';
import {
  assertVNextManifestReferenceBindings,
  readVNextManifest,
} from './dispatch';
import {
  VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL,
  VNEXT_SLICE_COMMIT_ACTION,
  VNEXT_SLICE_COMMIT_RESULT_TYPE,
  VNEXT_SLICE_COMMIT_SCHEMA_VERSION,
} from './types';
import type {
  VNextAdmissionAuthority,
  VNextCvResultEnvelope,
  VNextSliceCommitAdmissionState,
} from './types';

const IDENTIFIER_RE = /^[A-Za-z0-9_-]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const SNAPSHOT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONTEXT_REF_RE = /^\.proofloop\/context\/([a-f0-9]{64})\.json$/;

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
  // S12-D-T04 (§8.3, S12-D REPLAN): slice-local binding fields — admissible
  // only on a schema_version 3 TASK_COMPLETE credential (the shared
  // assertSliceLocalCredentialBindingFields enforces the v3-only rule; the
  // schema_version discrimination runs before this exact-field set).
  'stage_contract_digest',
  'slice_contract_digest',
  'execution_binding_digest',
]);

const REQUEST_FIELDS = new Set(['type', 'stageId', 'sliceId', 'commitSha', 'cvReceiptDigest']);

const SYSTEM_FORBIDDEN_PATHS = ['.proofloop', '.git'] as const;
const CONTEXT_FORBIDDEN_PATHS = [
  '.proofloop/manifests',
  '.proofloop/receipts',
  '.proofloop/context',
  '.git',
] as const;

interface TupleBinding {
  readonly stageId: string;
  readonly sliceId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly snapshotDigest: string;
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

interface WorkerFact {
  readonly receipt: Receipt;
  readonly task: TaskBinding | null;
  readonly contextRef: string;
  readonly contextDigest: string;
  readonly changedFiles: readonly string[];
}

interface WorkerFacts {
  readonly receipts: readonly Receipt[];
  readonly tipDigest: string;
  readonly facts: readonly WorkerFact[];
  readonly byDigest: ReadonlyMap<string, WorkerFact>;
}

interface CvFacts {
  readonly receipts: readonly Receipt[];
  readonly envelopes: readonly VNextCvResultEnvelope[];
  readonly tipDigest: string;
  readonly final: VNextCvResultEnvelope;
}

interface ValidatedCommitFacts {
  readonly root: string;
  readonly manifest: VNextManifest;
  readonly slice: SliceBinding;
  readonly tuple: TupleBinding;
  readonly authority: VNextAdmissionAuthority;
  readonly worker: WorkerFacts;
  readonly cv: CvFacts;
  readonly commitSha: string;
  readonly changedFiles: readonly string[];
}

class VNextSliceCommitAdmissionError extends Error {
  readonly code: 'RUNTIME.SCHEMA_MISMATCH' | 'RUNTIME.RECEIPT_CHAIN_BROKEN' | 'DOMAIN.INVALID_TRANSITION';

  constructor(
    code: 'RUNTIME.SCHEMA_MISMATCH' | 'RUNTIME.RECEIPT_CHAIN_BROKEN' | 'DOMAIN.INVALID_TRANSITION',
    message: string,
  ) {
    super(message);
    this.name = 'VNextSliceCommitAdmissionError';
    this.code = code;
  }
}

function fail(
  code: VNextSliceCommitAdmissionError['code'],
  message: string,
): never {
  throw new VNextSliceCommitAdmissionError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a non-empty string`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!IDENTIFIER_RE.test(result)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} is not a canonical identifier`);
  }
  return result;
}

/**
 * S09-C-T03: canonical Stage ID — the SAME `^S\d+$` grammar as the candidate
 * parser, compiler, Mechanical Validator, plan/stage/review status and every
 * admission seam.  Legacy parked labels such as S08B0/S08B fail closed before
 * any Runtime read/write.
 */
function requireCanonicalStageId(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!CANONICAL_STAGE_ID_RE.test(result)) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `${label} is not a canonical Stage ID (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected`,
    );
  }
  return result;
}

function requireDigest(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!SHA256_RE.test(result)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} is not a lowercase SHA-256 digest`);
  }
  return result;
}

function requireSnapshot(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!SNAPSHOT_RE.test(result)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} is not a valid Git snapshot digest`);
  }
  return result;
}

function requireGitSha(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!GIT_SHA_RE.test(result)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a full lowercase 40-character Git commit SHA`);
  }
  return result;
}

function requireStringArray(
  value: unknown,
  label: string,
  options: { readonly nonEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be an array of strings`);
  }
  if (options.nonEmpty === true && value.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must not be empty`);
  }
  const values = value.map((item, index) => requireString(item, `${label}[${index}]`));
  if (new Set(values).size !== values.length) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} contains duplicate entries`);
  }
  return values;
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

function sameValue(left: unknown, right: unknown): boolean {
  try {
    return computeDigest(left) === computeDigest(right);
  } catch {
    return false;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
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

function assertVNextManifestRoute(
  root: string,
  manifestPath: string,
  stageId: string,
): void {
  let route: ReturnType<typeof detectPlanManifestRoute>;
  try {
    route = detectPlanManifestRoute(root, manifestPath);
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `vNext Slice Commit Manifest route could not be determined for stage ${stageId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (route !== 'vnext') {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `vNext Slice Commit requires a canonical vNext Manifest route; observed ${route}`,
    );
  }
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
  if (kind === 'implementation' && (codePaths.length === 0 || testPaths.length === 0)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} implementation scope must contain code and test paths`);
  }
  return {
    kind: kind as VNextExecutionScope['kind'],
    code_paths: codePaths,
    test_paths: testPaths,
    forbidden_paths: forbiddenPaths,
  };
}

function systemForbiddenPaths(root: string): string[] {
  return SYSTEM_FORBIDDEN_PATHS.map((value) => rootRelativePath(root, value, 'system forbidden path'));
}

function contextForbiddenPaths(root: string): string[] {
  return CONTEXT_FORBIDDEN_PATHS.map((value) => rootRelativePath(root, value, 'Context forbidden path'));
}

function sliceBinding(root: string, manifest: VNextManifest, sliceId: string): SliceBinding {
  const slice = manifest.slices.find((candidate) => candidate.slice_id === sliceId);
  if (slice === undefined) {
    fail('RUNTIME.SCHEMA_MISMATCH', `Manifest does not declare Slice ${sliceId}`);
  }
  if (slice.proof_index.task_refs.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `Manifest Slice ${sliceId} declares no tasks`);
  }

  const seen = new Set<string>();
  const tasks = slice.proof_index.task_refs.map((refId) => {
    const descriptor = manifest.reference_index[refId];
    if (descriptor === undefined || descriptor.kind !== 'task') {
      fail('RUNTIME.SCHEMA_MISMATCH', `Manifest Slice task ref ${refId} is unavailable or not a task`);
    }
    const match = /#\/entities\/([^/]+)$/.exec(descriptor.ref);
    if (match === null || match[1] === undefined) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Manifest Slice task ref ${refId} has no canonical entity ID`);
    }
    const taskId = match[1];
    if (!taskId.startsWith(`${sliceId}-`)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Manifest task ${taskId} is outside Slice ${sliceId}`);
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

  const planPath = rootRelativePath(root, manifest.plan.ref, 'Manifest.plan.ref');
  const evidencePath = rootRelativePath(root, slice.evidence_path, 'Manifest Slice Evidence path');
  // Execution scope is task-level: every task may touch only its own
  // code/test scope plus the shared Evidence/Plan projection, and must not
  // overlap its own forbidden list or the system forbidden paths.  Merging
  // all tasks' allowed/forbidden lists across the Slice would falsely reject
  // legal task-level scopes — one task may be admitted to edit a path that
  // another task must not touch (S12-D: T02 edits next.ts while T01/T04
  // forbid it) — so the overlap check runs per task.
  for (const task of tasks) {
    const taskAllowed = unique([...task.allowedCodeScope, evidencePath, planPath]);
    const taskForbidden = unique([
      ...task.executionScope.forbidden_paths,
      ...systemForbiddenPaths(root),
    ]);
    for (const permitted of taskAllowed) {
      for (const forbidden of taskForbidden) {
        if (pathsOverlap(permitted, forbidden)) {
          fail('RUNTIME.SCHEMA_MISMATCH', `Manifest execution scope overlaps forbidden path: ${permitted}`);
        }
      }
    }
  }
  return {
    slice,
    tasks,
    proofIndexDigest: computeDigest(slice.proof_index),
    planPath,
    evidencePath,
    allowedExecutionScope: unique([
      ...tasks.flatMap((task) => task.allowedCodeScope),
      evidencePath,
      planPath,
    ]),
    forbiddenExecutionScope: unique([
      ...tasks.flatMap((task) => task.executionScope.forbidden_paths),
      ...systemForbiddenPaths(root),
    ]),
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
  tuple: TupleBinding,
  task: TaskBinding | null,
  contextRef: string,
  contextDigest: string,
): void {
  if (contextRef !== `.proofloop/context/${contextDigest}.json`) {
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
  // S13-S17 remediation §6.4: a finalize-slice Context carries no Task
  // identity (task_id/task_ref absent); a Task Context must bind exactly its
  // declared task entity.
  if (task === null) {
    if (context.task_id !== undefined || context.task_ref !== undefined) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'finalize-slice Context must not carry a task identity');
    }
  } else if (
    context.task_id !== task.taskId ||
    context.task_ref !== task.taskRef
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context is not bound to the active vNext execution tuple');
  }
  if (
    context.root_path !== root ||
    context.root_digest !== computeDigest(root) ||
    context.stage_id !== tuple.stageId ||
    context.slice_id !== tuple.sliceId ||
    context.manifest_digest !== tuple.manifestDigest ||
    context.plan_digest !== tuple.planDigest ||
    context.proof_index_digest !== tuple.proofIndexDigest ||
    context.snapshot_digest !== tuple.snapshotDigest
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context is not bound to the active vNext execution tuple');
  }
  if (context.evidence_path !== slice.evidencePath || context.plan_projection_path !== slice.planPath) {
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

  // S13-S17 remediation §6.4: the finalize-slice Context projects the
  // evidence-only scope (no task code/test scope); a Task Context must match
  // its declared Manifest task scope exactly.
  const expectedExecutionScope = task === null
    ? { kind: 'evidence-only' as const, code_paths: [], test_paths: [], forbidden_paths: [] }
    : task.executionScope;
  const executionScope = canonicalScope(root, context.execution_scope, 'Context.execution_scope');
  if (!sameValue(executionScope, expectedExecutionScope)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Context execution_scope does not match the Manifest task scope');
  }
  const allowedCodeScope = requireStringArray(context.allowed_code_scope, 'Context.allowed_code_scope')
    .map((item, index) => rootRelativePath(root, item, `Context.allowed_code_scope[${index}]`));
  if (!sameValue(allowedCodeScope, task === null ? [] : task.allowedCodeScope)) {
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
  const expectedAllowedPaths = unique([
    ...(task === null ? [] : task.allowedCodeScope),
    slice.evidencePath,
    slice.planPath,
  ]);
  const expectedForbiddenPaths = unique([
    ...(task === null ? [] : task.executionScope.forbidden_paths),
    ...contextForbiddenPaths(root),
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
}

interface ReceiptChain {
  readonly receipts: readonly Receipt[];
  readonly tipDigest: string | null;
}

/** Read one vNext Receipt chain without invoking the legacy receipt reader. */
function readReceiptChain(root: string, directory: string, label: string): ReceiptChain {
  const lexical = path.resolve(directory);
  const canonical = canonicalPathWithinRoot(root, lexical);
  if (canonical === null || canonical !== lexical) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} is not a canonical directory under the project root`);
  }

  let names: string[];
  try {
    const stat = fs.statSync(lexical);
    if (!stat.isDirectory()) fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} is not a directory`);
    names = fs.readdirSync(lexical).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { receipts: [], tipDigest: null };
    if (error instanceof VNextSliceCommitAdmissionError) throw error;
    fail(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const byDigest = new Map<string, Receipt>();
  for (const name of names) {
    const file = path.join(lexical, name);
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
    if (!SHA256_RE.test(receipt.digest) || name !== `${receipt.digest}.json`) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} Receipt ${name} is not digest-addressed`);
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
    if (visited.has(current)) fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains a circular Receipt chain`);
    const receipt = byDigest.get(current);
    if (receipt === undefined) fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains an unreachable Receipt`);
    visited.add(current);
    ordered.push(receipt);
    current = successors.get(current);
  }
  if (visited.size !== byDigest.size) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains an unreachable Receipt branch`);
  }
  return { receipts: ordered, tipDigest: ordered[ordered.length - 1].digest };
}

function assertTuple(value: Record<string, unknown>, tuple: TupleBinding, label: string): void {
  // S12-D-T04 (S12-D REPLAN): the tuple binding is credential-version
  // agnostic — a v2 (legacy/current vNext) or v3 (slice-local) credential
  // must bind the SAME stage/slice digest tuple. The credential version is
  // discriminated separately through credentialSchemaVersionMismatch.
  if (
    (value.schema_version !== 2 && value.schema_version !== 3) ||
    value.manifest_digest !== tuple.manifestDigest ||
    value.plan_digest !== tuple.planDigest ||
    value.proof_index_digest !== tuple.proofIndexDigest ||
    value.snapshot_digest !== tuple.snapshotDigest
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} is stale or not bound to the active vNext tuple`);
  }
}


function validateWorkerFacts(
  root: string,
  manifest: VNextManifest,
  slice: SliceBinding,
  tuple: TupleBinding,
  sliceLocalBinding?: VNextSliceLocalBindingExpectation,
): WorkerFacts {
  const chain = readReceiptChain(
    root,
    tasksReceiptDir(root, tuple.stageId, tuple.sliceId),
    'vNext Worker Receipt chain',
  );
  if (chain.tipDigest === null || chain.receipts.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'all Manifest tasks must have v2 TASK_COMPLETE facts before Slice Commit admission');
  }
  const replanDispositions = loadAncestorReplanDispositionRecords(root, tuple.stageId);
  // repair (no skip-before-validation): the loop below may exclude a
  // historical invalidated Worker fact from the completion identity set
  // ONLY AFTER every distinct invalidated generation has fully validated
  // through the canonical neutral validator — closed schema, outer tuple,
  // action tokens, Context digest/scope and changed_files against its OWN
  // persisted generation authority. A tampered historical TASK_COMPLETE
  // whose old tuple matches a persisted disposition now fails closed here
  // instead of being silently skipped.
  assertHistoricalInvalidatedWorkerGenerations(
    root,
    manifest,
    tuple.stageId,
    slice,
    replanDispositions,
    chain.receipts,
    (payload) => isVNextHistoricalInvalidatedWorkerPayload(payload, tuple.stageId, slice.tasks.map((task) => task.taskId), replanDispositions),
    sliceLocalBinding,
  );
  // S13-S17 remediation §6.4 / Principle 3: Task completion is derived from
  // the completion-mode IDENTITY SET (implement-task/recover-task facts bound
  // to Manifest task ids), never from the raw Receipt count — the slice
  // finalize-slice fact carries no task identity and must never inflate or
  // satisfy the Task cardinality.

  const facts: WorkerFact[] = [];
  const byDigest = new Map<string, WorkerFact>();
  const activeReceipts: Receipt[] = [];
  const actionTokens = new Set<string>();
  const completedTaskIds = new Set<string>();
  // Prior admitted tasks' code scopes accumulate in CHAIN order — a later
  // Task may declare files of prior tasks whose uncommitted output the
  // worktree still carries.
  const priorCodeScopes: string[][] = [];
  let finalizeReceipt: Receipt | null = null;
  for (const [index, receipt] of chain.receipts.entries()) {
    if (
      receipt.version !== 1 ||
      receipt.type !== 'TASK_COMPLETE' ||
      receipt.stage_id !== tuple.stageId ||
      receipt.slice_id !== tuple.sliceId
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Worker Receipt chain contains a legacy, mixed, or wrong-slice Receipt');
    }
    const payload = requireRecord(receipt.payload, `TASK_COMPLETE[${index}].payload`);
    if (isVNextHistoricalInvalidatedWorkerPayload(payload, tuple.stageId, slice.tasks.map((task) => task.taskId), replanDispositions)) continue;
    activeReceipts.push(receipt);
    // S12-D-T04 (§8.3): the credential schema_version discrimination runs
    // BEFORE the exact-field set so a slice-local (v3) payload carrying the
    // binding fields fails with the explicit BINDING code, not as an
    // unknown-field rejection.
    const schemaMismatch = credentialSchemaVersionMismatch(
      payload.schema_version,
      manifest.binding !== undefined,
      `TASK_COMPLETE[${index}].payload`,
    );
    if (schemaMismatch !== null) {
      // The BINDING.* code is carried in the finding message: the canonical
      // FindingCode vocabulary is a closed kernel union (§7).
      fail('RUNTIME.SCHEMA_MISMATCH', schemaMismatch.message);
    }
    // S12-D-T04 (§8.3, S12-D REPLAN): in slice-local mode every v3 Worker
    // credential must carry the slice-local binding fields and bind the SAME
    // Manifest contract digests and recomputed execution binding; a v2
    // credential carrying binding fields is rejected (never silently
    // ignored).
    assertSliceLocalCredentialBindingFields(
      payload,
      `TASK_COMPLETE[${index}].payload`,
      sliceLocalBinding,
    );
    assertExactFields(payload, WORKER_PAYLOAD_FIELDS, `TASK_COMPLETE[${index}].payload`);
    const mode = requireString(payload.mode, `TASK_COMPLETE[${index}].mode`);
    const actionToken = requireString(payload.action_token, `TASK_COMPLETE[${index}].action_token`);
    if (actionTokens.has(actionToken)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Worker Receipt chain reuses action_token ${actionToken}`);
    }
    actionTokens.add(actionToken);
    assertTuple(payload, tuple, `TASK_COMPLETE[${index}]`);
    if (payload.proof_index_digest !== slice.proofIndexDigest) {
      fail('RUNTIME.SCHEMA_MISMATCH', `TASK_COMPLETE[${index}] proof_index_digest is stale`);
    }
    if (payload.evidence_ref !== slice.evidencePath) {
      fail('RUNTIME.SCHEMA_MISMATCH', `TASK_COMPLETE[${index}] evidence_ref is not Manifest-bound`);
    }

    // ── Mode discrimination (§6.4): the finalize-slice fact has no task
    //    identity; implement-task/recover-task facts are Task completions. ──
    let task: TaskBinding | null = null;
    if (mode === 'finalize-slice') {
      if (payload.task_id !== undefined) {
        fail('RUNTIME.SCHEMA_MISMATCH', 'finalize-slice TASK_COMPLETE must not carry a task_id');
      }
      if (finalizeReceipt !== null) {
        fail('RUNTIME.SCHEMA_MISMATCH', 'Worker Receipt chain contains more than one finalize-slice fact');
      }
      finalizeReceipt = receipt;
    } else {
      if (mode !== 'implement-task' && mode !== 'recover-task') {
        fail('RUNTIME.SCHEMA_MISMATCH', 'Worker Receipt chain contains a non-vNext completed Worker fact');
      }
      if (payload.outcome !== 'completed') {
        fail('RUNTIME.SCHEMA_MISMATCH', 'Worker Receipt chain contains a non-vNext completed Worker fact');
      }
      const taskId = requireString(payload.task_id, `TASK_COMPLETE[${index}].task_id`);
      task = slice.tasks.find((candidate) => candidate.taskId === taskId) ?? null;
      if (task === null) {
        fail('RUNTIME.SCHEMA_MISMATCH', `Worker Receipt chain contains an undeclared task ${taskId}`);
      }
      if (completedTaskIds.has(taskId)) {
        fail('RUNTIME.SCHEMA_MISMATCH', `Worker Receipt chain completes declared task ${taskId} twice`);
      }
      completedTaskIds.add(taskId);
    }

    const changedFiles = requireStringArray(
      payload.changed_files,
      `TASK_COMPLETE[${index}].changed_files`,
      { nonEmpty: true },
    ).map((item, fileIndex) =>
      rootRelativePath(root, item, `TASK_COMPLETE[${index}].changed_files[${fileIndex}]`),
    );
    // Scope binding: a TASK_COMPLETE fact declares the files its step
    // changed. A Task completion is bounded by its OWN allowed scope plus
    // the scopes of prior tasks whose uncommitted output the worktree still
    // carries; another task's forbidden list must not veto this task's
    // admitted files (S12-D: T01/T04 forbid next.ts while T02 is admitted to
    // edit it). The finalize-slice step converges Slice Evidence/projection
    // only, so it is bounded by the whole declared Slice scope.
    const priorCodeAndTest = unique(priorCodeScopes.flat());
    const taskAllowed = unique([
      ...priorCodeAndTest,
      ...(task === null
        ? slice.tasks.flatMap((declared) => declared.allowedCodeScope)
        : task.allowedCodeScope),
      slice.evidencePath,
      slice.planPath,
    ]);
    // User authorization A4 (same semantics as worker-admission A3): the
    // task-level forbidden list constrains the CURRENT task's own behavior,
    // not the worktree's historical state.  A declared file that belongs to
    // a prior task's code/test scope — and not to the current task's own
    // scope — is exempt from the current task's forbidden check (S12-D: T04
    // must declare T02's next.ts output while T04's own forbidden covers
    // next.ts).  The system forbidden paths and the allowed-scope check
    // still bind every declared file, and the current task's own files stay
    // bound by its own forbidden list.
    const taskLevelForbidden = unique(
      task === null ? [] : task.executionScope.forbidden_paths,
    );
    const systemForbidden = unique(systemForbiddenPaths(root));
    const changedFilesLabel = `TASK_COMPLETE[${index}].changed_files`;
    for (const changed of changedFiles) {
      if (systemForbidden.some((base) => pathsOverlap(changed, base))) {
        fail('RUNTIME.SCHEMA_MISMATCH', `${changedFilesLabel} contains a forbidden path: ${changed}`);
      }
      const priorOwned =
        priorCodeAndTest.some((base) => pathWithin(changed, base)) &&
        !(task !== null && task.allowedCodeScope.some((base) => pathWithin(changed, base)));
      if (!priorOwned && taskLevelForbidden.some((base) => pathsOverlap(changed, base))) {
        fail('RUNTIME.SCHEMA_MISMATCH', `${changedFilesLabel} contains a forbidden path: ${changed}`);
      }
      if (!taskAllowed.some((base) => pathWithin(changed, base))) {
        fail('RUNTIME.SCHEMA_MISMATCH', `${changedFilesLabel} expands beyond the admitted execution scope: ${changed}`);
      }
    }
    // User authorization A6 (admission counterpart): the Evidence/Plan
    // projection must be declared only when it is part of the current
    // worktree changes; an already-committed projection (HEAD-consistent)
    // satisfies the contract via the persisted snapshot.
    const worktreeChanges = new Set(
      gitChangedPaths(root).map((value, fileIndex) =>
        rootRelativePath(root, value, `Git changed path[${fileIndex}]`),
      ),
    );
    if (
      (worktreeChanges.has(slice.evidencePath) && !changedFiles.includes(slice.evidencePath)) ||
      (worktreeChanges.has(slice.planPath) && !changedFiles.includes(slice.planPath))
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', `TASK_COMPLETE[${index}].changed_files omits the Evidence or Plan projection`);
    }
    if (!Array.isArray(payload.verification_runs)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `TASK_COMPLETE[${index}].verification_runs must be an array`);
    }
    requireString(payload.summary, `TASK_COMPLETE[${index}].summary`);
    const contextRef = requireString(payload.context_ref, `TASK_COMPLETE[${index}].context_ref`);
    const contextDigest = requireDigest(payload.context_digest, `TASK_COMPLETE[${index}].context_digest`);
    const contextMatch = CONTEXT_REF_RE.exec(contextRef);
    if (contextMatch === null || contextMatch[1] !== contextDigest) {
      fail('RUNTIME.SCHEMA_MISMATCH', `TASK_COMPLETE[${index}].context_ref is not digest-addressed`);
    }
    validateContext(root, manifest, slice, tuple, task, contextRef, contextDigest);

    const fact: WorkerFact = { receipt, task, contextRef, contextDigest, changedFiles };
    facts.push(fact);
    byDigest.set(receipt.digest, fact);
    if (task !== null) priorCodeScopes.push([...task.allowedCodeScope]);
  }
  // §6.4 Task coverage: the completion identity set must equal the Manifest
  // declared task set exactly — no missing, no undeclared, no duplicate.
  const declaredTaskIds = new Set(slice.tasks.map((declared) => declared.taskId));
  if (
    completedTaskIds.size !== declaredTaskIds.size ||
    [...completedTaskIds].some((taskId) => !declaredTaskIds.has(taskId))
  ) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      'Worker completion facts do not cover exactly the Manifest task identity set',
    );
  }
  // §6.4 worker_tip: when a finalize-slice fact exists it must be the chain
  // tip — the committed Slice state binds the finalized chain, never an
  // earlier Task completion.
  if (finalizeReceipt !== null && finalizeReceipt.digest !== chain.tipDigest) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      'the finalize-slice fact must be the Worker Receipt chain tip at Slice Commit admission',
    );
  }
  return {
    receipts: activeReceipts,
    tipDigest: chain.tipDigest,
    facts,
    byDigest,
  };
}

function assertReferenceSet(actual: readonly string[], expected: readonly string[], label: string): void {
  if (
    actual.length !== expected.length ||
    [...new Set(actual)].sort().join('\u0000') !== [...new Set(expected)].sort().join('\u0000')
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} is not exactly the Manifest Proof Index binding`);
  }
}

function assertCvProofBindings(envelope: VNextCvResultEnvelope, slice: SliceBinding): void {
  assertReferenceSet(
    envelope.acceptance_refs_checked,
    slice.slice.proof_index.acceptance_refs,
    'CV acceptance_refs_checked',
  );
  assertReferenceSet(envelope.seam_refs_checked, slice.slice.proof_index.seam_refs, 'CV seam_refs_checked');
  assertReferenceSet(
    envelope.oracle_refs_checked,
    slice.slice.proof_index.oracle_refs,
    'CV oracle_refs_checked',
  );
  assertReferenceSet(
    envelope.risk_refs_considered.map((risk) => risk.ref_id),
    slice.slice.proof_index.risk_refs.map((risk) => risk.ref_id),
    'CV risk_refs_considered',
  );
  for (const refId of envelope.failed_acceptance_refs) {
    if (!slice.slice.proof_index.acceptance_refs.includes(refId)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `CV failed_acceptance_refs contains an out-of-scope ref ${refId}`);
    }
  }
}

function validateCvFacts(
  root: string,
  slice: SliceBinding,
  stageHasBinding: boolean,
  tuple: TupleBinding,
  worker: WorkerFacts,
  sliceLocalBinding?: VNextSliceLocalBindingExpectation,
): CvFacts {
  const chain = readReceiptChain(
    root,
    cvReceiptDir(root, tuple.stageId, tuple.sliceId),
    'vNext CV Receipt chain',
  );
  if (chain.tipDigest === null || chain.receipts.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'a vNext CV Receipt is required before Slice Commit admission');
  }
  const replanDispositions = loadAncestorReplanDispositionRecords(root, tuple.stageId);

  const envelopes: VNextCvResultEnvelope[] = [];
  const activeReceipts: Receipt[] = [];
  const seenWorkerDigests = new Set<string>();
  for (const [index, receipt] of chain.receipts.entries()) {
    if (
      receipt.version !== 1 ||
      (receipt.type !== 'CV_PASS' && receipt.type !== 'CV_REPAIR') ||
      receipt.stage_id !== tuple.stageId ||
      receipt.slice_id !== tuple.sliceId
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'CV Receipt chain contains a legacy, mixed, or wrong-slice Receipt');
    }
    let envelope: VNextCvResultEnvelope;
    try {
      envelope = validateVNextCvResultEnvelope(receipt.payload);
    } catch (error) {
      fail(
        'RUNTIME.RECEIPT_CHAIN_BROKEN',
        `vNext CV Receipt ${index} is not a valid closed CV envelope: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (isVNextHistoricalInvalidatedCvPayload(envelope as unknown as Record<string, unknown>, tuple.stageId, slice.tasks.map((task) => task.taskId), readReceiptChain(root, tasksReceiptDir(root, tuple.stageId, tuple.sliceId), 'vNext Worker Receipt chain').receipts, worker.receipts, replanDispositions)) continue;
    activeReceipts.push(receipt);
    // S12-D-T04 (§8.3): a v3 (or unknown-future) credential in the persisted
    // CV history is discriminated against the Stage mode before any tuple
    // binding is asserted.
    const schemaMismatch = credentialSchemaVersionMismatch(
      envelope.schema_version,
      stageHasBinding,
      `CV Receipt ${index}.payload`,
    );
    if (schemaMismatch !== null) {
      // The BINDING.* code is carried in the finding message: the canonical
      // FindingCode vocabulary is a closed kernel union (§7).
      fail('RUNTIME.SCHEMA_MISMATCH', schemaMismatch.message);
    }
    // S12-D-T04 (§8.3, S12-D REPLAN): in slice-local mode every persisted v3
    // CV credential must bind the Manifest contract digests and the
    // recomputed execution binding (same single-truth as the candidate).
    assertSliceLocalCredentialBindingFields(
      envelope as unknown as Record<string, unknown>,
      `CV Receipt ${index}.payload`,
      sliceLocalBinding,
    );
    if (receipt.type !== (envelope.verdict === 'PASS' ? 'CV_PASS' : 'CV_REPAIR')) {
      fail('RUNTIME.SCHEMA_MISMATCH', `CV Receipt ${index} discriminator does not match its vNext verdict`);
    }
    if (
      envelope.stage_id !== tuple.stageId ||
      envelope.slice_id !== tuple.sliceId ||
      envelope.manifest_digest !== tuple.manifestDigest ||
      envelope.plan_digest !== tuple.planDigest ||
      envelope.proof_index_digest !== tuple.proofIndexDigest ||
      envelope.snapshot_digest !== tuple.snapshotDigest
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', `CV Receipt ${index} is stale or not bound to the active tuple`);
    }
    assertCvProofBindings(envelope, slice);
    const workerDigest = envelope.worker_receipt_digest;
    if (workerDigest === undefined || !worker.byDigest.has(workerDigest)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `CV Receipt ${index} is not bound to a current Worker Receipt`);
    }
    // A Worker repair does not produce a new Worker Receipt, so a legal
    // REPAIR → recheck sequence binds the recheck to the SAME Worker Receipt
    // as the preceding CV_REPAIR. Only that tail pair is exempt from the
    // duplicate guard; everything else stays fail-closed (the transition
    // checks below still enforce REPAIR predecessor + matching failure
    // signature).
    const previousEnvelope = envelopes[envelopes.length - 1];
    const legalRecheckTail =
      envelope.verification_type === 'recheck' &&
      previousEnvelope !== undefined &&
      previousEnvelope.verdict === 'REPAIR' &&
      previousEnvelope.worker_receipt_digest === workerDigest;
    if (seenWorkerDigests.has(workerDigest) && !legalRecheckTail) {
      fail('DOMAIN.INVALID_TRANSITION', `CV history reuses Worker Receipt ${workerDigest}`);
    }
    seenWorkerDigests.add(workerDigest);
    const workerFact = worker.byDigest.get(workerDigest);
    if (workerFact === undefined) {
      fail('RUNTIME.SCHEMA_MISMATCH', `CV Receipt ${index} Worker binding is unavailable`);
    }
    if (
      envelope.context_ref !== workerFact.contextRef ||
      envelope.context_digest !== workerFact.contextDigest
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', `CV Receipt ${index} Context is not bound to its Worker Receipt`);
    }
    envelopes.push(envelope);
  }

  for (const [index, envelope] of envelopes.entries()) {
    if (index === 0) {
      if (envelope.verification_type !== 'initial') {
        fail('DOMAIN.INVALID_TRANSITION', 'the first vNext CV fact must be an initial verification');
      }
      continue;
    }
    const previous = envelopes[index - 1];
    if (envelope.verification_type !== 'recheck' || previous.verdict !== 'REPAIR') {
      fail('DOMAIN.INVALID_TRANSITION', 'only a CV_REPAIR fact may be followed by a vNext CV recheck');
    }
    if (envelope.previous_failure_signature !== previous.failure_signature) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'CV recheck previous_failure_signature does not match CV_REPAIR');
    }
  }

  const final = envelopes[envelopes.length - 1];
  if (final === undefined || final.verdict !== 'PASS') {
    fail('DOMAIN.INVALID_TRANSITION', 'Slice Commit requires the latest vNext CV fact to be CV_PASS');
  }
  return {
    receipts: activeReceipts,
    envelopes,
    tipDigest: chain.tipDigest,
    final,
  };
}

function gitOutput(root: string, args: readonly string[], label: string): string {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * S12-E REPAIR-FINAL round 3 — context 落盘绑定: the context_ref file of a
 * declared TASK_COMPLETE receipt must EXIST at
 * `.proofloop/context/<context_digest>.json` and its content digest must
 * equal context_digest.  A forged receipt naming a Context that was never
 * persisted (or whose content does not match) never expands the A8
 * tolerated/allowed side.
 */
function assertDeclaredContextPersisted(root: string, contextRef: string, contextDigest: string): void {
  const context = readRootJson(root, contextRef, 'TASK_COMPLETE Context');
  const withoutDigest = { ...context };
  delete withoutDigest.context_digest;
  if (context.context_digest !== contextDigest || computeDigest(withoutDigest) !== contextDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'TASK_COMPLETE Context is not persisted at its digest address');
  }
}

function assertWorkingTreeBoundary(root: string, manifest: VNextManifest, tuple: TupleBinding): void {
  const status = gitOutput(root, ['status', '--porcelain', '--untracked-files=all'], 'Git status');
  // User authorization A8: worktree changes that are declared by an ALREADY
  // ADMITTED TASK_COMPLETE receipt of a Manifest-DECLARED Slice of this
  // Stage are expected (shared worktree with interleaved Slice outputs —
  // S12-D/S12-E) and do not block the committed boundary.  S12-E
  // REPAIR-FINAL: unknown slices / receipt directories not declared in the
  // current Manifest are ignored (they never expand the tolerated set), and
  // every TASK_COMPLETE receipt must pass the complete admission-chain
  // payload semantics.  S12-E REPAIR-FINAL round 3: every declared file
  // must also stay inside the declaring Slice's Manifest task scope (the
  // union of all its tasks' allowedCodeScope plus evidence/plan
  // projections) and its Context must be persisted (context 落盘绑定).
  // Un-declared changes still fail closed.
  const declaredFiles = new Set<string>();
  for (const declaredSlice of manifest.slices) {
    if (declaredSlice.proof_index.task_refs.length === 0) continue;
    const declaredSliceScope = sliceBinding(root, manifest, declaredSlice.slice_id).allowedExecutionScope;
    const declaredReceipts = readReceiptChain(
      root,
      tasksReceiptDir(root, tuple.stageId, declaredSlice.slice_id),
      `vNext Worker Receipt chain for ${declaredSlice.slice_id}`,
    );
    for (const receipt of declaredReceipts.receipts) {
      if (receipt.type !== 'TASK_COMPLETE') continue;
      const payload = requireRecord(receipt.payload, `TASK_COMPLETE[${declaredSlice.slice_id}].payload`);
      try {
        assertUpstreamTaskCompleteSemantics(
          payload,
          declaredSlice.evidence_path,
          `TASK_COMPLETE[${declaredSlice.slice_id}]`,
          {
            verifyContextPersisted: (contextRef, contextDigest) =>
              assertDeclaredContextPersisted(root, contextRef, contextDigest),
            stageHasBinding: manifest.binding !== undefined,
            allowedScope: declaredSliceScope,
          },
        );
      } catch (error) {
        fail(
          'RUNTIME.SCHEMA_MISMATCH',
          `TASK_COMPLETE[${declaredSlice.slice_id}] does not pass the complete admission-chain semantics: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const files = payload['changed_files'];
      if (Array.isArray(files)) {
        for (const f of files) declaredFiles.add(rootRelativePath(root, f, 'admitted declared file'));
      }
    }
  }
  const unexpected = status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3))
    .filter((value) => value !== '' && !value.startsWith('.proofloop/') && !declaredFiles.has(rootRelativePath(root, value, 'Git status path')));
  if (unexpected.length > 0) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `Slice Commit requires a clean committed boundary; unexpected Git changes: ${unexpected.join(', ')}`,
    );
  }
}

function collectOtherSliceDeclaredFiles(
  root: string,
  manifest: VNextManifest,
  stageId: string,
  currentSliceId: string,
): string[] {
  const declared = new Set<string>();
  for (const otherSlice of manifest.slices) {
    if (otherSlice.slice_id === currentSliceId || otherSlice.proof_index.task_refs.length === 0) continue;
    const otherSliceScope = sliceBinding(root, manifest, otherSlice.slice_id).allowedExecutionScope;
    const otherReceipts = readReceiptChain(
      root,
      tasksReceiptDir(root, stageId, otherSlice.slice_id),
      `vNext Worker Receipt chain for ${otherSlice.slice_id}`,
    );
    for (const receipt of otherReceipts.receipts) {
      if (receipt.type !== 'TASK_COMPLETE') continue;
      const payload = requireRecord(receipt.payload, `TASK_COMPLETE[${otherSlice.slice_id}].payload`);
      try {
        assertUpstreamTaskCompleteSemantics(
          payload,
          otherSlice.evidence_path,
          `TASK_COMPLETE[${otherSlice.slice_id}]`,
          {
            verifyContextPersisted: (contextRef, contextDigest) =>
              assertDeclaredContextPersisted(root, contextRef, contextDigest),
            stageHasBinding: manifest.binding !== undefined,
            allowedScope: otherSliceScope,
          },
        );
      } catch (error) {
        fail(
          'RUNTIME.SCHEMA_MISMATCH',
          `TASK_COMPLETE[${otherSlice.slice_id}] does not pass the complete admission-chain semantics: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const files = payload['changed_files'];
      if (Array.isArray(files)) {
        for (const file of files) {
          declared.add(rootRelativePath(root, file, 'other Slice declared file'));
        }
      }
    }
  }
  return [...declared];
}

function buildSliceCommitPolicyFacts(
  root: string,
  manifest: VNextManifest,
  tuple: TupleBinding,
  slice: SliceBinding,
  worker: WorkerFacts,
  cv: CvFacts,
): SliceCommitPolicyFacts {
  const otherSliceDeclaredFiles = collectOtherSliceDeclaredFiles(
    root,
    manifest,
    tuple.stageId,
    tuple.sliceId,
  );
  return {
    root,
    stageId: tuple.stageId,
    sliceId: tuple.sliceId,
    manifestDigest: tuple.manifestDigest,
    planDigest: tuple.planDigest,
    snapshotDigest: tuple.snapshotDigest,
    cvReceiptDigest: cv.tipDigest as string,
    allowedPaths: unique([...slice.allowedExecutionScope, ...otherSliceDeclaredFiles]),
    forbiddenPaths: systemForbiddenPaths(root),
    workerChangedFiles: unique(worker.facts.flatMap((fact) => fact.changedFiles)),
    hasRepairHistory: cv.envelopes.some((envelope) => envelope.verdict === 'REPAIR'),
  };
}

function assertCommittedChangedFiles(
  root: string,
  manifest: VNextManifest,
  tuple: TupleBinding,
  commitSha: string,
  slice: SliceBinding,
  worker: WorkerFacts,
  cv: CvFacts,
): string[] {
  if (!GIT_SHA_RE.test(commitSha)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'commit_sha must be a full lowercase Git commit SHA');
  }
  const head = readGitHead(root);
  if (head !== commitSha) {
    fail('DOMAIN.INVALID_TRANSITION', `commit_sha is not the current Git HEAD: ${commitSha} != ${head}`);
  }
  const resolvedCommit = gitOutput(
    root,
    ['rev-parse', '--verify', `${commitSha}^{commit}`],
    'Git commit boundary',
  ).trim();
  if (resolvedCommit !== commitSha) {
    fail('DOMAIN.INVALID_TRANSITION', 'commit_sha does not resolve to the current committed boundary');
  }
  if (!GIT_SHA_RE.test(tuple.snapshotDigest)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'the vNext snapshot is not a Git commit boundary');
  }
  const resolvedSnapshot = gitOutput(
    root,
    ['rev-parse', '--verify', `${tuple.snapshotDigest}^{commit}`],
    'Git snapshot boundary',
  ).trim();
  if (resolvedSnapshot !== tuple.snapshotDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'snapshot_digest does not resolve to a Git commit boundary');
  }
  try {
    execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', tuple.snapshotDigest, commitSha], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    fail('DOMAIN.INVALID_TRANSITION', 'commit_sha is not a descendant of the CV snapshot boundary');
  }
  // The changed-file comparison baseline is the commit's own parent, not the
  // admission snapshot: in a multi-Slice chain the interval from the snapshot
  // to the current commit also contains prior Slice outputs and interleaved
  // fix commits.  The snapshot binding above still proves the commit is a Git
  // descendant of the admitted snapshot, while the diff below proves this
  // commit itself carries exactly the declared files.
  const parentCommit = gitOutput(
    root,
    ['rev-parse', '--verify', `${commitSha}^`],
    'Git parent commit boundary',
  ).trim();
  if (!GIT_SHA_RE.test(parentCommit)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'commit_sha has no resolvable parent commit boundary');
  }
  assertWorkingTreeBoundary(root, manifest, tuple);

  const raw = gitOutput(
    root,
    ['diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB', parentCommit, commitSha, '--'],
    'Git committed changed-file boundary',
  );
  const changed = unique(raw.split('\0').filter((entry) => entry.length > 0).map((entry, index) =>
    rootRelativePath(root, entry, `Git committed changed path[${index}]`),
  )).sort();
  if (changed.length === 0) {
    fail('DOMAIN.INVALID_TRANSITION', 'Slice Commit requires a non-empty committed Slice boundary');
  }
  const policy = loadSliceCommitPolicy(buildSliceCommitPolicyFacts(root, manifest, tuple, slice, worker, cv));
  try {
    validateSliceCommitChangedFiles(policy, changed, {
      treePaths: gitTreePaths(root, commitSha),
      phase: 'post-commit',
    });
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      error instanceof Error ? error.message : String(error),
    );
  }
  return changed;
}

type LoadedCommitFacts = Omit<ValidatedCommitFacts, 'commitSha' | 'changedFiles'>;

function loadCommitFacts(
  request: Pick<SliceCommitAdmissionRequest, 'stageId' | 'sliceId' | 'cvReceiptDigest'>,
  dependencies: VNextSliceCommitAdmissionDependencies,
): LoadedCommitFacts {
  const root = canonicalProjectRoot(dependencies.projectRoot);
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${request.stageId}.json`);
  assertVNextManifestRoute(root, manifestPath, request.stageId);
  let manifest: VNextManifest;
  try {
    manifest = readVNextManifest(root, manifestPath);
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `vNext Slice Commit requires a valid explicit vNext Manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.version !== 2 || manifest.plan.schema_version !== 2 || manifest.stage_id !== request.stageId) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit accepts only the current vNext schema-v2 Manifest');
  }
  const manifestDigest = computeDigest(manifest);
  try {
    assertVNextManifestReferenceBindings(root, manifest);
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `Manifest/Plan reference binding failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let authority: VNextAdmissionAuthority;
  try {
    const currentEpoch = readCurrentEpoch(root, request.stageId);
    authority = { stagePlan: currentEpoch.stagePlan, spv: currentEpoch.spv };
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `vNext Stage Plan/SPV authority is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const snapshotDigest = authority.spv.snapshot_digest;
  const tupleBase = {
    stageId: request.stageId,
    sliceId: request.sliceId,
    manifestDigest,
    planDigest: manifest.plan.plan_digest,
    snapshotDigest,
  };
  for (const fact of [authority.stagePlan, authority.spv]) {
    if (
      fact.stage_id !== tupleBase.stageId ||
      fact.manifest_digest !== tupleBase.manifestDigest ||
      fact.plan_digest !== tupleBase.planDigest ||
      fact.snapshot_digest !== tupleBase.snapshotDigest
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Stage Plan/SPV authority is stale or not bound to the current Manifest/Plan/snapshot');
    }
  }
  if (authority.stagePlan.spv_receipt_digest !== authority.spv.digest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Stage Plan authority is not bound to the fresh SPV_PASS fact');
  }

  const slice = sliceBinding(root, manifest, request.sliceId);
  const tuple: TupleBinding = {
    ...tupleBase,
    proofIndexDigest: slice.proofIndexDigest,
  };
  // S12-D-T04 (S12-D REPLAN): the slice-local binding expectation is shared
  // by the Worker/CV/Slice Commit/Integration credential consumers.
  const sliceLocalBinding =
    manifest.binding !== undefined
      ? computeSliceLocalBindingExpectation(
          root,
          manifest,
          request.sliceId,
          authority.spv.snapshot_digest,
        )
      : undefined;
  const worker = validateWorkerFacts(root, manifest, slice, tuple, sliceLocalBinding);
  const cv = validateCvFacts(root, slice, manifest.binding !== undefined, tuple, worker, sliceLocalBinding);
  if (cv.final.worker_receipt_digest !== worker.tipDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'latest CV_PASS is not bound to the current complete Worker Receipt chain');
  }
  if (request.cvReceiptDigest !== cv.tipDigest) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      `cv_receipt_digest does not match the latest vNext CV_PASS Receipt: ${request.cvReceiptDigest} != ${cv.tipDigest}`,
    );
  }
  const committerChain = readReceiptChain(
    root,
    committerReceiptDir(root, request.stageId, request.sliceId),
    'vNext Slice Commit Receipt chain',
  );
  if (committerChain.receipts.length > 0) {
    const replanDispositions = loadAncestorReplanDispositionRecords(root, request.stageId);
    const allWorkerReceipts = readReceiptChain(root, tasksReceiptDir(root, request.stageId, request.sliceId), 'vNext Worker Receipt chain').receipts;
    const allCvReceipts = readReceiptChain(root, cvReceiptDir(root, request.stageId, request.sliceId), 'vNext CV Receipt chain').receipts;
    const historicalOnly = committerChain.receipts.every((receipt) => {
      if (!isRecord(receipt.payload)) return false;
      if (!isVNextHistoricalInvalidatedCommitPayload(receipt.payload, request.stageId, request.sliceId, slice.tasks.map((task) => task.taskId), replanDispositions)) return false;
      const cvDigest = receipt.payload.cv_receipt_digest;
      const historicalCv = allCvReceipts.find((candidate) => candidate.digest === cvDigest);
      if (historicalCv === undefined || !isRecord(historicalCv.payload)) return false;
      return isVNextHistoricalInvalidatedCvPayload(historicalCv.payload, request.stageId, slice.tasks.map((task) => task.taskId), allWorkerReceipts, worker.receipts, replanDispositions);
    });
    if (!historicalOnly) fail('DOMAIN.INVALID_TRANSITION', 'a vNext Slice Commit Receipt already exists for this Slice');
  }
  return { root, manifest, slice, tuple, authority, worker, cv };
}

function policyFactsFromLoadedFacts(facts: LoadedCommitFacts): SliceCommitPolicyFacts {
  return buildSliceCommitPolicyFacts(facts.root, facts.manifest, facts.tuple, facts.slice, facts.worker, facts.cv);
}

function validateFacts(
  request: SliceCommitAdmissionRequest,
  dependencies: VNextSliceCommitAdmissionDependencies,
): ValidatedCommitFacts {
  const loaded = loadCommitFacts(request, dependencies);
  const changedFiles = assertCommittedChangedFiles(
    loaded.root,
    loaded.manifest,
    loaded.tuple,
    request.commitSha,
    loaded.slice,
    loaded.worker,
    loaded.cv,
  );
  return { ...loaded, commitSha: request.commitSha, changedFiles };
}

function validateRequest(value: unknown): SliceCommitAdmissionRequest {
  const request = requireRecord(value, 'vNext Slice Commit request');
  assertExactFields(request, REQUEST_FIELDS, 'vNext Slice Commit request');
  if (request.type !== 'slice_commit') {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Slice Commit request type must be slice_commit');
  }
  requireCanonicalStageId(request.stageId, 'slice_commit.stageId');
  requireIdentifier(request.sliceId, 'slice_commit.sliceId');
  requireGitSha(request.commitSha, 'slice_commit.commitSha');
  requireDigest(request.cvReceiptDigest, 'slice_commit.cvReceiptDigest');
  return request as unknown as SliceCommitAdmissionRequest;
}

function commitReceiptBuild(facts: ValidatedCommitFacts): ReceiptBuild {
  // S12-D-T04 (S12-D REPLAN): the credential schema_version follows the
  // Stage credential mode. Legacy Manifest (no binding) → v2 SLICE_COMMIT
  // (zero behavior change). Slice-local Manifest → v3 SLICE_COMMIT carrying
  // the three binding fields (stage/slice contract digests from the Manifest
  // and the recomputed execution binding through the kernel oracle).
  const sliceLocalBinding =
    facts.manifest.binding !== undefined
      ? computeSliceLocalBindingExpectation(
          facts.root,
          facts.manifest,
          facts.tuple.sliceId,
          facts.authority.spv.snapshot_digest,
        )
      : undefined;
  const payload: Record<string, unknown> = {
    schema_version:
      sliceLocalBinding !== undefined
        ? VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL
        : VNEXT_SLICE_COMMIT_SCHEMA_VERSION,
    type: VNEXT_SLICE_COMMIT_RESULT_TYPE,
    action: VNEXT_SLICE_COMMIT_ACTION,
    stage_id: facts.tuple.stageId,
    slice_id: facts.tuple.sliceId,
    manifest_digest: facts.tuple.manifestDigest,
    plan_digest: facts.tuple.planDigest,
    proof_index_digest: facts.tuple.proofIndexDigest,
    snapshot_digest: facts.tuple.snapshotDigest,
    commit_sha: facts.commitSha,
    cv_receipt_digest: facts.cv.tipDigest,
    changed_files: [...facts.changedFiles],
    receipt_chain_valid: true,
  };
  if (sliceLocalBinding !== undefined) {
    payload.stage_contract_digest = sliceLocalBinding.stageContractDigest;
    payload.slice_contract_digest = sliceLocalBinding.sliceContractDigest;
    payload.execution_binding_digest = sliceLocalBinding.executionBindingDigest;
  }
  return {
    type: 'SLICE_COMMIT',
    stage_id: facts.tuple.stageId,
    slice_id: facts.tuple.sliceId,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function commitState(facts: ValidatedCommitFacts): VNextSliceCommitAdmissionState {
  return {
    schema_version: VNEXT_SLICE_COMMIT_SCHEMA_VERSION,
    type: VNEXT_SLICE_COMMIT_RESULT_TYPE,
    action: VNEXT_SLICE_COMMIT_ACTION,
    stage_id: facts.tuple.stageId,
    slice_id: facts.tuple.sliceId,
    manifest_digest: facts.tuple.manifestDigest,
    plan_digest: facts.tuple.planDigest,
    proof_index_digest: facts.tuple.proofIndexDigest,
    snapshot_digest: facts.tuple.snapshotDigest,
    commit_sha: facts.commitSha,
    cv_receipt_digest: facts.cv.tipDigest,
    changed_files: [...facts.changedFiles],
    receipt_chain_valid: true,
  };
}

function rejectedCommit(
  message: string,
  code: VNextSliceCommitAdmissionError['code'] = 'RUNTIME.SCHEMA_MISMATCH',
): AdmitResult<VNextSliceCommitAdmissionState> {
  return {
    accepted: false,
    receipt_ref: null,
    new_state: null,
    findings: [{ code, severity: 'error', message }],
  };
}

export interface VNextSliceCommitAdmissionDependencies {
  readonly projectRoot: string;
  readonly writer?: ReceiptWriterPort;
}

/** Validate the closed vNext-compatible shape used by the existing Host seam. */
export function validateVNextSliceCommitRequest(value: unknown): SliceCommitAdmissionRequest {
  try {
    return validateRequest(value);
  } catch (error) {
    throw new Error(
      `vNext Slice Commit request schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface VNextSliceCommitPolicyInput {
  readonly stageId: string;
  readonly sliceId: string;
  readonly cvReceiptDigest: string;
}

/** Load the same persisted Slice/CV/Worker facts used by Slice Commit admission. */
export function loadVNextSliceCommitPolicyFacts(
  input: VNextSliceCommitPolicyInput,
  dependencies: VNextSliceCommitAdmissionDependencies,
): SliceCommitPolicyFacts {
  return policyFactsFromLoadedFacts(loadCommitFacts(input, dependencies));
}

/**
 * Admit one Slice Commit using only vNext persisted facts and the committed
 * Git boundary.  No legacy reconcile/reducer consumer is reachable here.
 */
export function admitVNextSliceCommit(
  value: unknown,
  dependencies: VNextSliceCommitAdmissionDependencies,
): AdmitResult<VNextSliceCommitAdmissionState> {
  let request: SliceCommitAdmissionRequest;
  try {
    request = validateRequest(value);
  } catch (error) {
    const code = error instanceof VNextSliceCommitAdmissionError ? error.code : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedCommit(
      `vNext Slice Commit request rejected by closed schema: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  let facts: ValidatedCommitFacts;
  try {
    facts = validateFacts(request, dependencies);
  } catch (error) {
    const code = error instanceof VNextSliceCommitAdmissionError ? error.code : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedCommit(
      `vNext Slice Commit admission blocked: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  const state = commitState(facts);
  return runReceiptAdmission<VNextSliceCommitAdmissionState>({
    build: commitReceiptBuild(facts),
    targetDir: committerReceiptDir(facts.root, request.stageId, request.sliceId),
    nextState: state,
    writer: dependencies.writer,
    projectRoot: facts.root,
    admissionKey: `vnext-slice-commit:${request.stageId}:${request.sliceId}:${request.commitSha}`,
    beforeWrite: () => {
      assertVNextManifestRoute(
        facts.root,
        path.join(facts.root, '.proofloop', 'manifests', `${request.stageId}.json`),
        request.stageId,
      );
      const current = validateFacts(request, dependencies);
      if (current.cv.tipDigest !== facts.cv.tipDigest || current.worker.tipDigest !== facts.worker.tipDigest) {
        fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Slice Commit facts changed before Receipt write');
      }
    },
  });
}

export const admitVNextSliceCommitResult = admitVNextSliceCommit;

function gitChangedPaths(root: string): string[] {
  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(root);
  } catch (error) {
    throw new Error(`Git root is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const run = (args: readonly string[]): string[] => {
    try {
      const output = execFileSync('git', ['-C', gitRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return output.split('\0').filter((entry) => entry.length > 0);
    } catch (error) {
      throw new Error(`Git changed-file scope is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return unique([
    ...run(['diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB', 'HEAD', '--']),
    ...run(['ls-files', '--others', '--exclude-standard', '-z']),
  ]).map((value, index) => rootRelativePath(root, value, `Git changed path[${index}]`));
}

function gitTreePaths(root: string, commitSha: string): string[] {
  return gitOutput(
    root,
    ['ls-tree', '-r', '--name-only', commitSha, '--'],
    'Git HEAD tree listing',
  )
    .split('\n')
    .map((value) => value.trimEnd())
    .filter((value) => value.length > 0)
    .map((value, index) => rootRelativePath(root, value, `Git tree path[${index}]`));
}
