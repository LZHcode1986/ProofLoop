/**
 * vNext Integration admission.
 *
 * Integration is a downstream vNext consumer, not a legacy reducer action. It
 * revalidates the complete persisted Worker → CV → Slice Commit prefix, the
 * current Git boundary, and the active Manifest/Plan/snapshot tuple before it
 * delegates the single Receipt write to `runReceiptAdmission`.
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
  integrationReceiptDir,
  tasksReceiptDir,
} from '../receipt-layout';
import type {
  AdmitResult,
  ReceiptBuild,
  ReceiptWriterPort,
} from '../admit-pipeline';
import { runReceiptAdmission } from '../admit-pipeline';
import type { IntegrationAdmissionRequest } from '../admission-request';
import { validateVNextCvResultEnvelope } from './cv-admission';
import {
  assertVNextManifestReferenceBindings,
  readVNextManifest,
} from './dispatch';
import { readVNextAdmissionAuthority } from './next';
import {
  VNEXT_INTEGRATION_ACTION,
  VNEXT_INTEGRATION_RESULT_TYPE,
  VNEXT_INTEGRATION_SCHEMA_VERSION,
  VNEXT_SLICE_COMMIT_ACTION,
  VNEXT_SLICE_COMMIT_RESULT_TYPE,
  VNEXT_SLICE_COMMIT_SCHEMA_VERSION,
} from './types';
import type {
  VNextAdmissionAuthority,
  VNextCvResultEnvelope,
  VNextIntegrationAdmissionState,
} from './types';

const IDENTIFIER_RE = /^[A-Za-z0-9_-]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const SNAPSHOT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const CONTEXT_REF_RE = /^\.proofloop\/context\/([a-f0-9]{64})\.json$/;

const REQUEST_FIELDS = new Set(['type', 'stageId', 'sliceId', 'commitSha']);
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
const SLICE_COMMIT_PAYLOAD_FIELDS = new Set([
  'schema_version',
  'type',
  'action',
  'stage_id',
  'slice_id',
  'manifest_digest',
  'plan_digest',
  'proof_index_digest',
  'snapshot_digest',
  'commit_sha',
  'cv_receipt_digest',
  'changed_files',
  'receipt_chain_valid',
]);
const INTEGRATION_FIELDS = new Set([
  'schema_version',
  'type',
  'action',
  'stage_id',
  'slice_id',
  'manifest_digest',
  'plan_digest',
  'proof_index_digest',
  'snapshot_digest',
  'commit_sha',
  'slice_commit_receipt_digest',
  'worker_receipt_digest',
  'cv_receipt_digest',
  'changed_files',
  'receipt_chain_valid',
]);

const SYSTEM_FORBIDDEN_PATHS = ['.proofloop', '.git'] as const;
const CONTEXT_FORBIDDEN_PATHS = [
  '.proofloop/manifests',
  '.proofloop/receipts',
  '.proofloop/context',
  '.git',
] as const;

export interface TupleBinding {
  readonly stageId: string;
  readonly sliceId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly snapshotDigest: string;
}

export interface TaskBinding {
  readonly taskId: string;
  readonly taskRef: string;
  readonly executionScope: VNextExecutionScope;
  readonly allowedCodeScope: readonly string[];
}

export interface SliceBinding {
  readonly slice: VNextManifestSlice;
  readonly tasks: readonly TaskBinding[];
  readonly proofIndexDigest: string;
  readonly planPath: string;
  readonly evidencePath: string;
  readonly allowedExecutionScope: readonly string[];
  readonly forbiddenExecutionScope: readonly string[];
}

export interface WorkerFact {
  readonly receipt: Receipt;
  readonly task: TaskBinding;
  readonly contextRef: string;
  readonly contextDigest: string;
  readonly changedFiles: readonly string[];
}

export interface WorkerFacts {
  readonly receipts: readonly Receipt[];
  readonly tipDigest: string;
  readonly facts: readonly WorkerFact[];
  readonly byDigest: ReadonlyMap<string, WorkerFact>;
}

export interface CvFacts {
  readonly receipts: readonly Receipt[];
  readonly envelopes: readonly VNextCvResultEnvelope[];
  readonly tipDigest: string;
  readonly final: VNextCvResultEnvelope;
}

interface ValidatedIntegrationFacts {
  readonly root: string;
  readonly manifest: VNextManifest;
  readonly slice: SliceBinding;
  readonly tuple: TupleBinding;
  readonly authority: VNextAdmissionAuthority;
  readonly worker: WorkerFacts;
  readonly cv: CvFacts;
  readonly sliceCommitReceipt: Receipt;
  readonly sliceCommitReceiptDigest: string;
  readonly commitSha: string;
  readonly changedFiles: readonly string[];
}

interface IntegrationFactsValidationOptions {
  /** The post-install check must permit the Receipt installed by this run. */
  readonly allowInstalledIntegrationReceipt?: boolean;
}

type IntegrationAdmissionCode =
  | 'RUNTIME.SCHEMA_MISMATCH'
  | 'RUNTIME.RECEIPT_CHAIN_BROKEN'
  | 'DOMAIN.INVALID_TRANSITION';

class VNextIntegrationAdmissionError extends Error {
  readonly code: IntegrationAdmissionCode;

  constructor(code: IntegrationAdmissionCode, message: string) {
    super(message);
    this.name = 'VNextIntegrationAdmissionError';
    this.code = code;
  }
}

export { VNextIntegrationAdmissionError };

function fail(code: IntegrationAdmissionCode, message: string): never {
  throw new VNextIntegrationAdmissionError(code, message);
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

function assertVNextManifestRoute(root: string, manifestPath: string, stageId: string): void {
  let route: ReturnType<typeof detectPlanManifestRoute>;
  try {
    route = detectPlanManifestRoute(root, manifestPath);
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `vNext Integration Manifest route could not be determined for stage ${stageId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (route !== 'vnext') {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `vNext Integration requires a canonical vNext Manifest route; observed ${route}`,
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

export function sliceBinding(root: string, manifest: VNextManifest, sliceId: string): SliceBinding {
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
  const forbiddenExecutionScope = unique([
    ...tasks.flatMap((task) => task.executionScope.forbidden_paths),
    ...systemForbiddenPaths(root),
  ]);
  const allowedExecutionScope = unique([
    ...tasks.flatMap((task) => task.allowedCodeScope),
    evidencePath,
    planPath,
  ]);
  for (const allowed of allowedExecutionScope) {
    for (const forbidden of forbiddenExecutionScope) {
      if (pathsOverlap(allowed, forbidden)) {
        fail('RUNTIME.SCHEMA_MISMATCH', `Manifest execution scope overlaps forbidden path: ${allowed}`);
      }
    }
  }
  return {
    slice,
    tasks,
    proofIndexDigest: computeDigest(slice.proof_index),
    planPath,
    evidencePath,
    allowedExecutionScope,
    forbiddenExecutionScope,
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
  task: TaskBinding,
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
  if (
    context.root_path !== root ||
    context.root_digest !== computeDigest(root) ||
    context.stage_id !== tuple.stageId ||
    context.slice_id !== tuple.sliceId ||
    context.task_id !== task.taskId ||
    context.task_ref !== task.taskRef ||
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
    if (error instanceof VNextIntegrationAdmissionError) throw error;
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
  if (
    value.schema_version !== 2 ||
    value.manifest_digest !== tuple.manifestDigest ||
    value.plan_digest !== tuple.planDigest ||
    value.proof_index_digest !== tuple.proofIndexDigest ||
    value.snapshot_digest !== tuple.snapshotDigest
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
      fail('RUNTIME.SCHEMA_MISMATCH', `${label} expands beyond the admitted Slice scope: ${value}`);
    }
  }
}

export function validateWorkerFacts(
  root: string,
  manifest: VNextManifest,
  slice: SliceBinding,
  tuple: TupleBinding,
): WorkerFacts {
  const chain = readReceiptChain(
    root,
    tasksReceiptDir(root, tuple.stageId, tuple.sliceId),
    'vNext Worker Receipt chain',
  );
  if (chain.tipDigest === null || chain.receipts.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'all Manifest tasks must have v2 TASK_COMPLETE facts before Integration admission');
  }
  if (chain.receipts.length !== slice.tasks.length) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `Worker Receipt count ${chain.receipts.length} does not equal Manifest task count ${slice.tasks.length}`,
    );
  }

  const facts: WorkerFact[] = [];
  const byDigest = new Map<string, WorkerFact>();
  const actionTokens = new Set<string>();
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
    assertExactFields(payload, WORKER_PAYLOAD_FIELDS, `TASK_COMPLETE[${index}].payload`);
    if (
      payload.schema_version !== 2 ||
      (payload.mode !== 'implement-task' && payload.mode !== 'recover-task') ||
      payload.outcome !== 'completed'
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Worker Receipt chain contains a non-vNext completed Worker fact');
    }
    const task = slice.tasks[index];
    if (task === undefined || payload.task_id !== task.taskId) {
      fail('RUNTIME.SCHEMA_MISMATCH', `Worker Receipt order/task binding does not match Manifest task ${task?.taskId ?? '<missing>'}`);
    }
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
    const changedFiles = requireStringArray(
      payload.changed_files,
      `TASK_COMPLETE[${index}].changed_files`,
      { nonEmpty: true },
    ).map((item, fileIndex) =>
      rootRelativePath(root, item, `TASK_COMPLETE[${index}].changed_files[${fileIndex}]`),
    );
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
    const contextMatch = CONTEXT_REF_RE.exec(contextRef);
    if (contextMatch === null || contextMatch[1] !== contextDigest) {
      fail('RUNTIME.SCHEMA_MISMATCH', `TASK_COMPLETE[${index}].context_ref is not digest-addressed`);
    }
    validateContext(root, manifest, slice, tuple, task, contextRef, contextDigest);

    const fact: WorkerFact = { receipt, task, contextRef, contextDigest, changedFiles };
    facts.push(fact);
    byDigest.set(receipt.digest, fact);
  }
  return {
    receipts: chain.receipts,
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
  assertReferenceSet(envelope.acceptance_refs_checked, slice.slice.proof_index.acceptance_refs, 'CV acceptance_refs_checked');
  assertReferenceSet(envelope.seam_refs_checked, slice.slice.proof_index.seam_refs, 'CV seam_refs_checked');
  assertReferenceSet(envelope.oracle_refs_checked, slice.slice.proof_index.oracle_refs, 'CV oracle_refs_checked');
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

export function validateCvFacts(
  root: string,
  slice: SliceBinding,
  tuple: TupleBinding,
  worker: WorkerFacts,
): CvFacts {
  const chain = readReceiptChain(
    root,
    cvReceiptDir(root, tuple.stageId, tuple.sliceId),
    'vNext CV Receipt chain',
  );
  if (chain.tipDigest === null || chain.receipts.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'a vNext CV Receipt is required before Integration admission');
  }

  const envelopes: VNextCvResultEnvelope[] = [];
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
    if (envelope.context_ref !== workerFact.contextRef || envelope.context_digest !== workerFact.contextDigest) {
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
    fail('DOMAIN.INVALID_TRANSITION', 'Integration requires the latest vNext CV fact to be CV_PASS');
  }
  return {
    receipts: chain.receipts,
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

function assertWorkingTreeBoundary(root: string): void {
  const status = gitOutput(root, ['status', '--porcelain', '--untracked-files=all'], 'Git status');
  const unexpected = status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3))
    .filter((value) => value !== '' && !value.startsWith('.proofloop/'));
  if (unexpected.length > 0) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `Integration requires a clean committed boundary; unexpected Git changes: ${unexpected.join(', ')}`,
    );
  }
}

function assertCommittedChangedFiles(
  root: string,
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
  // The integrated commit must lie on the current Git boundary: in a
  // multi-Slice chain Integration is admitted once per Slice after the
  // unified execution pass, so HEAD may have advanced past this Slice's
  // committed boundary (later Slice commits or post-slice fix commits). The
  // commit must be an ancestor of (or equal to) HEAD — the same ancestor
  // contract the Gate applies to each Slice's integrated commit
  // (gate-admission.ts assertAncestor) — not necessarily HEAD itself.
  if (head !== commitSha) {
    try {
      execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', commitSha, head], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
    } catch {
      fail('DOMAIN.INVALID_TRANSITION', `commit_sha is not an ancestor of the current integrated Git HEAD: ${commitSha} != ${head}`);
    }
  }
  const resolvedCommit = gitOutput(root, ['rev-parse', '--verify', `${commitSha}^{commit}`], 'Git commit boundary').trim();
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
    fail('DOMAIN.INVALID_TRANSITION', 'commit_sha is not a descendant of the admitted vNext snapshot boundary');
  }
  // The changed-file comparison baseline is the commit's own parent, not the
  // admission snapshot (mirrors the Slice Commit consumer, a205821): in a
  // multi-Slice chain the interval from the snapshot to the current commit
  // also contains prior Slice outputs.  The snapshot ancestry binding above
  // still proves the commit is a Git descendant of the admitted snapshot,
  // while the diff below proves THIS commit carries exactly the declared
  // files of the current Slice.
  const parentCommit = gitOutput(
    root,
    ['rev-parse', '--verify', `${commitSha}^`],
    'Git parent commit boundary',
  ).trim();
  if (!GIT_SHA_RE.test(parentCommit)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'commit_sha has no resolvable parent commit boundary');
  }
  assertWorkingTreeBoundary(root);

  const raw = gitOutput(
    root,
    ['diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB', parentCommit, commitSha, '--'],
    'Git integrated changed-file boundary',
  );
  const changed = unique(
    raw
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((entry, index) => rootRelativePath(root, entry, `Git integrated changed path[${index}]`)),
  ).sort();
  if (changed.length === 0) {
    fail('DOMAIN.INVALID_TRANSITION', 'Integration requires a non-empty committed Slice boundary');
  }
  assertPathsWithinScope(changed, slice.allowedExecutionScope, slice.forbiddenExecutionScope, 'Git integrated changed files');

  const declared = unique(worker.facts.flatMap((fact) => fact.changedFiles)).sort();
  const hasRepairHistory = cv.envelopes.some((envelope) => envelope.verdict === 'REPAIR');
  if (hasRepairHistory) {
    // A Worker repair does not produce a new Worker Receipt or Worker fact,
    // so the integrated boundary may legitimately contain repair-only files
    // that no Worker fact declared (REPAIR → recheck sequence).  The scope
    // check above still bounds every integrated path inside the admitted
    // Slice scope; every declared file must still be present in the commit.
    // Without a REPAIR history the exact-match gate below stays fail-closed.
    if (!declared.every((value) => changed.includes(value))) {
      fail(
        'RUNTIME.SCHEMA_MISMATCH',
        `integrated changed-file set does not contain every persisted Worker fact (declared=${declared.join(',')} actual=${changed.join(',')})`,
      );
    }
  } else if (declared.length !== changed.length || declared.some((value, index) => value !== changed[index])) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `integrated changed-file set does not exactly match persisted Worker facts (declared=${declared.join(',')} actual=${changed.join(',')})`,
    );
  }
  return changed;
}

export function validateSliceCommitPayload(
  root: string,
  receipt: Receipt,
  tuple: TupleBinding,
  slice: SliceBinding,
  worker: WorkerFacts,
  cv: CvFacts,
  commitSha: string,
  changedFiles: readonly string[],
): Record<string, unknown> {
  if (
    receipt.version !== 1 ||
    receipt.type !== 'SLICE_COMMIT' ||
    receipt.stage_id !== tuple.stageId ||
    receipt.slice_id !== tuple.sliceId
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit Receipt is legacy, mixed, or bound to the wrong tuple');
  }
  const payload = requireRecord(receipt.payload, 'SLICE_COMMIT.payload');
  assertExactFields(payload, SLICE_COMMIT_PAYLOAD_FIELDS, 'SLICE_COMMIT.payload');
  if (payload.schema_version !== VNEXT_SLICE_COMMIT_SCHEMA_VERSION) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'SLICE_COMMIT.payload.schema_version must be 2');
  }
  if (payload.type !== VNEXT_SLICE_COMMIT_RESULT_TYPE || payload.action !== VNEXT_SLICE_COMMIT_ACTION) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit Receipt is not the closed vNext SLICE_COMMIT_RESULT fact');
  }
  if (
    payload.stage_id !== tuple.stageId ||
    payload.slice_id !== tuple.sliceId ||
    payload.manifest_digest !== tuple.manifestDigest ||
    payload.plan_digest !== tuple.planDigest ||
    payload.proof_index_digest !== tuple.proofIndexDigest ||
    payload.snapshot_digest !== tuple.snapshotDigest
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit Receipt is stale or not bound to the active vNext tuple');
  }
  if (payload.commit_sha !== commitSha) {
    fail('DOMAIN.INVALID_TRANSITION', 'commit_sha does not match the admitted Slice Commit Receipt');
  }
  if (payload.cv_receipt_digest !== cv.tipDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit Receipt is not bound to the latest vNext CV_PASS Receipt');
  }
  if (payload.receipt_chain_valid !== true) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', 'Slice Commit Receipt does not assert a valid vNext Receipt chain');
  }
  const receiptChangedFiles = requireStringArray(
    payload.changed_files,
    'SLICE_COMMIT.payload.changed_files',
    { nonEmpty: true },
  ).map((item, index) => rootRelativePath(root, item, `SLICE_COMMIT.payload.changed_files[${index}]`)).sort();
  assertPathsWithinScope(
    receiptChangedFiles,
    slice.allowedExecutionScope,
    slice.forbiddenExecutionScope,
    'SLICE_COMMIT.payload.changed_files',
  );
  const workerChangedFiles = unique(worker.facts.flatMap((fact) => fact.changedFiles)).sort();
  const hasRepairHistory = cv.envelopes.some((envelope) => envelope.verdict === 'REPAIR');
  if (hasRepairHistory) {
    // The admitted Slice Commit boundary may contain repair-only files that
    // no Worker fact declared (REPAIR → recheck sequence); the Receipt must
    // still cover every declared Worker fact file.
    if (!workerChangedFiles.every((value) => receiptChangedFiles.includes(value))) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit Receipt changed_files do not contain every Worker fact');
    }
  } else if (
    receiptChangedFiles.length !== workerChangedFiles.length ||
    receiptChangedFiles.some((value, index) => value !== workerChangedFiles[index])
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit Receipt changed_files do not match all Worker facts');
  }
  if (hasRepairHistory) {
    // The caller-supplied changedFiles is either the integrated Git diff
    // (Integration consumer) or the Worker-fact union (Gate consumer); under
    // a REPAIR → recheck history the Receipt may legitimately carry
    // repair-only files beyond either set.  The Receipt must still cover
    // every caller-declared file; without a REPAIR history the exact-match
    // gate below stays fail-closed.
    if (!changedFiles.every((value) => receiptChangedFiles.includes(value))) {
      fail(
        'RUNTIME.SCHEMA_MISMATCH',
        'Slice Commit Receipt changed_files do not contain every integrated boundary file',
      );
    }
  } else if (
    receiptChangedFiles.length !== changedFiles.length ||
    receiptChangedFiles.some((value, index) => value !== changedFiles[index])
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit Receipt changed_files do not match the integrated Git boundary');
  }
  return payload;
}

function validateIntegrationPayload(
  value: Record<string, unknown>,
  label: string,
  root: string,
): void {
  assertExactFields(value, INTEGRATION_FIELDS, label);
  if (value.schema_version !== VNEXT_INTEGRATION_SCHEMA_VERSION) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label}.schema_version must be 2`);
  }
  if (value.type !== VNEXT_INTEGRATION_RESULT_TYPE || value.action !== VNEXT_INTEGRATION_ACTION) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} is not the closed vNext INTEGRATION_RESULT fact`);
  }
  if (
    typeof value.stage_id !== 'string' ||
    !CANONICAL_STAGE_ID_RE.test(value.stage_id) ||
    !IDENTIFIER_RE.test(String(value.slice_id))
  ) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `${label}.stage_id must be a canonical Stage ID (expected /^S\\d+$/, e.g. S09) and slice_id a canonical identifier; legacy stage labels such as S08B0/S08B are rejected`,
    );
  }
  for (const field of [
    'manifest_digest',
    'plan_digest',
    'proof_index_digest',
    'slice_commit_receipt_digest',
    'worker_receipt_digest',
    'cv_receipt_digest',
  ]) {
    if (typeof value[field] !== 'string' || !SHA256_RE.test(value[field])) {
      fail('RUNTIME.SCHEMA_MISMATCH', `${label}.${field} must be a lowercase SHA-256 digest`);
    }
  }
  if (typeof value.snapshot_digest !== 'string' || !SNAPSHOT_RE.test(value.snapshot_digest)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label}.snapshot_digest must be a Git snapshot digest`);
  }
  if (typeof value.commit_sha !== 'string' || !GIT_SHA_RE.test(value.commit_sha)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label}.commit_sha must be a full lowercase Git commit SHA`);
  }
  if (value.receipt_chain_valid !== true) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label}.receipt_chain_valid must be true`);
  }
  const changedFiles = requireStringArray(value.changed_files, `${label}.changed_files`, { nonEmpty: true });
  for (const [index, changedFile] of changedFiles.entries()) {
    rootRelativePath(root, changedFile, `${label}.changed_files[${index}]`);
  }
}

function validateFacts(
  request: IntegrationAdmissionRequest,
  dependencies: VNextIntegrationAdmissionDependencies,
  options: IntegrationFactsValidationOptions = {},
): ValidatedIntegrationFacts {
  const root = canonicalProjectRoot(dependencies.projectRoot);
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${request.stageId}.json`);
  assertVNextManifestRoute(root, manifestPath, request.stageId);

  let manifest: VNextManifest;
  try {
    manifest = readVNextManifest(root, manifestPath);
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `vNext Integration requires a valid explicit vNext Manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.version !== 2 || manifest.plan.schema_version !== 2 || manifest.stage_id !== request.stageId) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Integration accepts only the current vNext schema-v2 Manifest');
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
    authority = readVNextAdmissionAuthority(root, request.stageId);
  } catch (error) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `vNext Stage Plan/SPV authority is unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const snapshotDigest = authority.spv.snapshot_digest;
  const slice = sliceBinding(root, manifest, request.sliceId);
  const tuple: TupleBinding = {
    stageId: request.stageId,
    sliceId: request.sliceId,
    manifestDigest,
    planDigest: manifest.plan.plan_digest,
    proofIndexDigest: slice.proofIndexDigest,
    snapshotDigest,
  };
  for (const fact of [authority.stagePlan, authority.spv]) {
    if (
      fact.stage_id !== tuple.stageId ||
      fact.manifest_digest !== tuple.manifestDigest ||
      fact.plan_digest !== tuple.planDigest ||
      fact.snapshot_digest !== tuple.snapshotDigest
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Stage Plan/SPV authority is stale or not bound to the current Manifest/Plan/snapshot');
    }
  }
  if (authority.stagePlan.spv_receipt_digest !== authority.spv.digest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Stage Plan authority is not bound to the fresh SPV_PASS fact');
  }

  const worker = validateWorkerFacts(root, manifest, slice, tuple);
  const cv = validateCvFacts(root, slice, tuple, worker);
  if (cv.final.worker_receipt_digest !== worker.tipDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'latest CV_PASS is not bound to the current complete Worker Receipt chain');
  }

  const committerChain = readReceiptChain(
    root,
    committerReceiptDir(root, request.stageId, request.sliceId),
    'vNext Slice Commit Receipt chain',
  );
  if (committerChain.receipts.length !== 1 || committerChain.tipDigest === null) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      'Integration requires exactly one previously admitted vNext SLICE_COMMIT Receipt for this Slice',
    );
  }
  const sliceCommitReceipt = committerChain.receipts[0];
  if (sliceCommitReceipt === undefined) {
    fail('DOMAIN.INVALID_TRANSITION', 'vNext Slice Commit Receipt is missing');
  }
  const changedFiles = assertCommittedChangedFiles(root, tuple, request.commitSha, slice, worker, cv);
  validateSliceCommitPayload(
    root,
    sliceCommitReceipt,
    tuple,
    slice,
    worker,
    cv,
    request.commitSha,
    changedFiles,
  );

  const integrationChain = readReceiptChain(
    root,
    integrationReceiptDir(root, request.stageId, request.sliceId),
    'vNext Integration Receipt chain',
  );
  if (!options.allowInstalledIntegrationReceipt && integrationChain.receipts.length > 0) {
    for (const [index, receipt] of integrationChain.receipts.entries()) {
      if (
        receipt.version !== 1 ||
        receipt.type !== 'INTEGRATION_PASS' ||
        receipt.stage_id !== request.stageId ||
        receipt.slice_id !== request.sliceId
      ) {
        fail('RUNTIME.SCHEMA_MISMATCH', `Integration Receipt ${index} is legacy, mixed, or bound to the wrong tuple`);
      }
      validateIntegrationPayload(requireRecord(receipt.payload, `INTEGRATION_PASS[${index}].payload`), `INTEGRATION_PASS[${index}].payload`, root);
    }
    fail('DOMAIN.INVALID_TRANSITION', 'a vNext Integration Receipt already exists for this Slice');
  }

  return {
    root,
    manifest,
    slice,
    tuple,
    authority,
    worker,
    cv,
    sliceCommitReceipt,
    sliceCommitReceiptDigest: committerChain.tipDigest,
    commitSha: request.commitSha,
    changedFiles,
  };
}

function assertIntegrationFactsUnchanged(
  expected: ValidatedIntegrationFacts,
  current: ValidatedIntegrationFacts,
): void {
  if (
    !sameValue(current.manifest, expected.manifest) ||
    !sameValue(current.authority, expected.authority) ||
    !sameValue(current.sliceCommitReceipt, expected.sliceCommitReceipt) ||
    !sameValue(integrationState(current), integrationState(expected))
  ) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      'vNext Integration Manifest, Plan/snapshot, predecessor Receipt tips, commit boundary, or changed-files facts changed after validation',
    );
  }
}

function assertInstalledIntegrationReceipt(
  facts: ValidatedIntegrationFacts,
  writeResult: { readonly path: string; readonly digest: string },
): void {
  const directory = integrationReceiptDir(
    facts.root,
    facts.tuple.stageId,
    facts.tuple.sliceId,
  );
  const expectedPath = path.join(directory, `${writeResult.digest}.json`);
  if (writeResult.path !== expectedPath) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      'vNext Integration writer result is not the canonical installed Receipt for this Slice',
    );
  }

  const chain = readReceiptChain(
    facts.root,
    directory,
    'vNext Integration Receipt chain after install',
  );
  if (chain.receipts.length !== 1 || chain.receipts[0]?.digest !== writeResult.digest) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      'vNext Integration Receipt chain changed during install; the installed Receipt is not the sole current Integration fact',
    );
  }
  const receipt = chain.receipts[0];
  if (receipt === undefined) {
    fail('DOMAIN.INVALID_TRANSITION', 'vNext Integration Receipt disappeared during install');
  }
  validateIntegrationPayload(
    requireRecord(receipt.payload, 'INTEGRATION_PASS.afterInstall.payload'),
    'INTEGRATION_PASS.afterInstall.payload',
    facts.root,
  );
  if (!sameValue(receipt.payload, integrationState(facts))) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'installed Integration Receipt payload does not match validated facts');
  }
}

function validateRequest(value: unknown): IntegrationAdmissionRequest {
  const request = requireRecord(value, 'vNext Integration request');
  assertExactFields(request, REQUEST_FIELDS, 'vNext Integration request');
  if (request.type !== 'integration') {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Integration request type must be integration');
  }
  requireCanonicalStageId(request.stageId, 'integration.stageId');
  requireIdentifier(request.sliceId, 'integration.sliceId');
  requireGitSha(request.commitSha, 'integration.commitSha');
  return request as unknown as IntegrationAdmissionRequest;
}

function integrationState(facts: ValidatedIntegrationFacts): VNextIntegrationAdmissionState {
  return {
    schema_version: VNEXT_INTEGRATION_SCHEMA_VERSION,
    type: VNEXT_INTEGRATION_RESULT_TYPE,
    action: VNEXT_INTEGRATION_ACTION,
    stage_id: facts.tuple.stageId,
    slice_id: facts.tuple.sliceId,
    manifest_digest: facts.tuple.manifestDigest,
    plan_digest: facts.tuple.planDigest,
    proof_index_digest: facts.tuple.proofIndexDigest,
    snapshot_digest: facts.tuple.snapshotDigest,
    commit_sha: facts.commitSha,
    slice_commit_receipt_digest: facts.sliceCommitReceiptDigest,
    worker_receipt_digest: facts.worker.tipDigest,
    cv_receipt_digest: facts.cv.tipDigest,
    changed_files: [...facts.changedFiles],
    receipt_chain_valid: true,
  };
}

function integrationReceiptBuild(facts: ValidatedIntegrationFacts): ReceiptBuild {
  return {
    type: 'INTEGRATION_PASS',
    stage_id: facts.tuple.stageId,
    slice_id: facts.tuple.sliceId,
    timestamp: new Date().toISOString(),
    payload: { ...integrationState(facts) },
  };
}

function rejectedIntegration(
  message: string,
  code: IntegrationAdmissionCode = 'RUNTIME.SCHEMA_MISMATCH',
): AdmitResult<VNextIntegrationAdmissionState> {
  return {
    accepted: false,
    receipt_ref: null,
    new_state: null,
    findings: [{ code, severity: 'error', message }],
  };
}

export interface VNextIntegrationAdmissionDependencies {
  readonly projectRoot: string;
  readonly writer?: ReceiptWriterPort;
}

/** Validate the closed request shape used by the Runtime/Host integration seam. */
export function validateVNextIntegrationRequest(value: unknown): IntegrationAdmissionRequest {
  try {
    return validateRequest(value);
  } catch (error) {
    throw new Error(
      `vNext Integration request schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Admit one vNext Integration fact without entering legacy reconcile/reducer
 * code. The only persistence operation is the shared bounded Receipt seam.
 */
export function admitVNextIntegration(
  value: unknown,
  dependencies: VNextIntegrationAdmissionDependencies,
): AdmitResult<VNextIntegrationAdmissionState> {
  let request: IntegrationAdmissionRequest;
  try {
    request = validateRequest(value);
  } catch (error) {
    const code = error instanceof VNextIntegrationAdmissionError ? error.code : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedIntegration(
      `vNext Integration request rejected by closed schema: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  let facts: ValidatedIntegrationFacts;
  try {
    facts = validateFacts(request, dependencies);
  } catch (error) {
    const code = error instanceof VNextIntegrationAdmissionError ? error.code : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedIntegration(
      `vNext Integration admission blocked: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  const state = integrationState(facts);
  return runReceiptAdmission<VNextIntegrationAdmissionState>({
    build: integrationReceiptBuild(facts),
    targetDir: integrationReceiptDir(facts.root, request.stageId, request.sliceId),
    nextState: state,
    writer: dependencies.writer,
    projectRoot: facts.root,
    admissionKey: `vnext-integration:${request.stageId}:${request.sliceId}:${request.commitSha}`,
    beforeWrite: () => {
      assertVNextManifestRoute(
        facts.root,
        path.join(facts.root, '.proofloop', 'manifests', `${request.stageId}.json`),
        request.stageId,
      );
      const current = validateFacts(request, dependencies);
      assertIntegrationFactsUnchanged(facts, current);
    },
    afterWrite: (writeResult) => {
      assertVNextManifestRoute(
        facts.root,
        path.join(facts.root, '.proofloop', 'manifests', `${request.stageId}.json`),
        request.stageId,
      );
      const current = validateFacts(request, dependencies, {
        allowInstalledIntegrationReceipt: true,
      });
      assertIntegrationFactsUnchanged(facts, current);
      assertInstalledIntegrationReceipt(facts, writeResult);
    },
  });
}

export const admitVNextIntegrationResult = admitVNextIntegration;
