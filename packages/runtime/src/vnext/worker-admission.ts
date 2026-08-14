/**
 * vNext Worker-result admission.
 *
 * This consumer is intentionally separate from the legacy reconcile/reducer
 * path. It validates the admitted v2 facts and then delegates only the
 * Receipt persistence mechanics to the shared Runtime writer seam.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeDigest,
  validateVNextManifest,
} from '@proofloop/kernel';
import type {
  VNextExecutionScope,
  VNextManifest,
} from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import { readGitHead, resolveGitRoot } from '../git-source';
import { readReceiptCategory } from '../receipt-reader';
import { tasksReceiptDir } from '../receipt-layout';
import { runReceiptAdmission } from '../admit-pipeline';
import type {
  AdmitResult,
  ReceiptBuild,
  ReceiptWriterPort,
} from '../admit-pipeline';
import {
  assertVNextManifestReferenceBindings,
  readVNextManifest,
} from './dispatch';
import { assertIgnoredProtectedPaths, readVNextAdmissionAuthority } from './next';
import type {
  VNextAdmissionAuthority,
  VNextWorkerContext,
  VNextWorkerAdmissionState,
} from './types';
import {
  validateVNextWorkerResultEnvelope,
} from '../relay-contract';
import type { VNextWorkerResultEnvelope } from '../relay-contract';
import { VNEXT_WORKER_COMPLETION_MODES } from './types';
import type { VNextWorkerCompletionMode } from './types';

export interface VNextWorkerAdmissionDependencies {
  readonly projectRoot: string;
  readonly writer?: ReceiptWriterPort;
}

interface TaskBinding {
  readonly slice: VNextManifest['slices'][number];
  readonly taskId: string;
  readonly taskRef: string;
  readonly executionScope: VNextExecutionScope;
  readonly planPath: string;
  readonly evidencePath: string;
}

interface ValidatedWorkerFacts {
  readonly root: string;
  readonly manifest: VNextManifest;
  readonly authority: VNextAdmissionAuthority;
  readonly context: VNextWorkerContext;
  readonly task: TaskBinding;
  readonly changedFiles: readonly string[];
}

const SYSTEM_FORBIDDEN_PATHS = [
  '.proofloop/manifests',
  '.proofloop/receipts',
  '.proofloop/context',
  '.git',
] as const;

/** Full protected-path inventory; Contexts from the current dispatch seam still carry SYSTEM_FORBIDDEN_PATHS. */
const PROTECTED_PATHS = [
  '.proofloop/receipts',
  '.proofloop/manifests',
  '.proofloop/runtime',
  '.proofloop/runtime.lock',
  '.proofloop/context',
  '.git',
] as const;

/** Closed vocabulary from `.opencode/agents/worker.md`; aliases are not accepted. */
const WORKER_STATUS_VALUES = new Set([
  'planned',
  'executing',
  'ready-for-cv',
  'repairing',
  'blocked',
]);

/**
 * HEAD-baseline Worker Status vocabulary. The HEAD side of a Plan projection
 * is a planning clean boundary artifact: the Materializer emits candidate
 * projections with the planning-era `NOT_STARTED` spelling, which is exactly
 * the canonical form that normalizePlanExecutionProjection (entity-resolver.ts)
 * normalizes Worker Status rows to. The worktree side is an execution
 * projection and stays on the closed WORKER_STATUS_VALUES set above.
 */
const HEAD_WORKER_STATUS_VALUES = new Set([
  ...WORKER_STATUS_VALUES,
  'NOT_STARTED',
]);

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

const EXECUTION_SCOPE_FIELDS = new Set([
  'kind',
  'code_paths',
  'test_paths',
  'forbidden_paths',
]);

const WORKER_SCOPE_FIELDS = new Set([
  'allowed_paths',
  'mutable_projection_paths',
  'forbidden_paths',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mismatch(message: string): never {
  throw new Error(message);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) mismatch(`${label} must be a non-null object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    mismatch(`${label} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    mismatch(`${label} must be an array of strings`);
  }
  return [...value] as string[];
}

function assertExactFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !fields.has(key));
  if (unknown.length > 0) mismatch(`${label} contains unknown field(s): ${unknown.join(', ')}`);
}

function sameValue(left: unknown, right: unknown): boolean {
  return computeDigest(left) === computeDigest(right);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function canonicalProjectRoot(projectRoot: string): string {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    mismatch('projectRoot must be an absolute canonical Git worktree path');
  }
  const lexical = path.resolve(projectRoot);
  let root: string;
  try {
    root = fs.realpathSync(lexical);
  } catch {
    mismatch(`projectRoot is not readable: ${projectRoot}`);
  }
  if (root !== lexical) mismatch('projectRoot is not the canonical worktree path');

  let gitRoot: string;
  try {
    gitRoot = fs.realpathSync(resolveGitRoot(root));
  } catch {
    mismatch('canonical Git root is unavailable');
  }
  if (gitRoot !== root) mismatch('projectRoot is not the canonical Git root');
  return root;
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

function assertCurrentSnapshot(root: string, snapshotDigest: string, admittedSnapshot: string): string {
  let head: string;
  try {
    head = readGitHead(root);
  } catch {
    mismatch('current Git HEAD is unavailable');
  }
  // The Worker result may be bound to the current HEAD (the historical
  // boundary), or to the admitted snapshot / a legal descendant execution
  // commit after Slice Commit advanced HEAD.
  if (head !== snapshotDigest && !snapshotOnAdmittedChain(root, snapshotDigest, admittedSnapshot)) {
    mismatch(
      `snapshot_digest does not match current Git HEAD nor the admitted vNext execution snapshot chain: ${snapshotDigest} != ${head}`,
    );
  }
  return head;
}

/** Require a canonical root-relative path and reject symlink identity changes. */
function rootRelativePath(root: string, value: unknown, label: string): string {
  const raw = requireString(value, label);
  if (
    path.isAbsolute(raw) ||
    raw.startsWith('//') ||
    raw.includes('\\') ||
    raw.includes('\u0000')
  ) {
    mismatch(`${label} must be a canonical root-relative path`);
  }
  const parts = raw.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    mismatch(`${label} must be a canonical root-relative path`);
  }
  const lexical = path.resolve(root, ...parts);
  const canonical = canonicalPathWithinRoot(root, lexical);
  if (canonical === null || canonical !== lexical) {
    mismatch(`${label} escapes or traverses a changed path identity`);
  }
  return parts.join('/');
}

/** Normalize an envelope changed-file path while retaining the root boundary. */
function changedFilePath(root: string, value: unknown, label: string): string {
  const raw = requireString(value, label);
  if (raw.includes('\\') || raw.includes('\u0000')) mismatch(`${label} contains an invalid path character`);
  const lexical = path.resolve(root, raw);
  const canonical = canonicalPathWithinRoot(root, lexical);
  if (canonical === null || canonical !== lexical) {
    mismatch(`${label} escapes or traverses the project root`);
  }
  const relative = path.relative(root, canonical).split(path.sep).join('/');
  return rootRelativePath(root, relative, label);
}

function readRootBoundText(root: string, relative: string, label: string): string {
  const canonicalRelative = rootRelativePath(root, relative, label);
  const lexical = path.resolve(root, ...canonicalRelative.split('/'));
  const opened = openNoFollowRead(root, lexical);
  if (!opened.ok) mismatch(`${label} is missing or is not a regular root-bound file`);
  try {
    return fs.readFileSync(opened.fd, 'utf8');
  } finally {
    fs.closeSync(opened.fd);
  }
}

function readRootBoundJson(root: string, relative: string, label: string): Record<string, unknown> {
  const raw = readRootBoundText(root, relative, label);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    mismatch(`${label} is not valid JSON`);
  }
  return requireRecord(value, label);
}

function assertAuthorityBinding(
  authority: VNextAdmissionAuthority,
  envelope: VNextWorkerResultEnvelope,
  root: string,
): void {
  const facts = [authority.stagePlan, authority.spv];
  for (const fact of facts) {
    if (
      fact.stage_id !== envelope.stageId ||
      fact.manifest_digest !== envelope.manifestDigest ||
      fact.plan_digest !== envelope.planDigest
    ) {
      mismatch('active vNext Stage Plan/SPV authority does not bind the Worker result tuple');
    }
    // The Worker result snapshot must be the admitted snapshot or a legal
    // Git descendant of it (an execution fact after Slice Commit advanced
    // HEAD); Manifest/Plan digests stay strictly bound.
    if (!snapshotOnAdmittedChain(root, envelope.snapshotDigest, fact.snapshot_digest)) {
      mismatch('active vNext Stage Plan/SPV authority does not bind the Worker result snapshot');
    }
  }
  if (authority.stagePlan.spv_receipt_digest !== authority.spv.digest) {
    mismatch('active vNext Stage Plan is not bound to the fresh SPV receipt');
  }
}

function readAndValidateManifest(
  root: string,
  envelope: VNextWorkerResultEnvelope,
): VNextManifest {
  const manifestRelative = `.proofloop/manifests/${envelope.stageId}.json`;
  const manifestPath = rootRelativePath(root, manifestRelative, 'Manifest path');
  const manifest = readVNextManifest(root, path.resolve(root, ...manifestPath.split('/')));
  try {
    validateVNextManifest(manifest);
  } catch (error) {
    mismatch(`vNext Manifest schema validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.version !== 2 || manifest.plan.schema_version !== 2) {
    mismatch('Worker admission accepts only explicit schema-v2 Manifest input');
  }
  if (manifest.stage_id !== envelope.stageId) {
    mismatch('Manifest stage_id does not match the Worker result');
  }
  const digest = computeDigest(manifest);
  if (digest !== envelope.manifestDigest) {
    mismatch(`manifest_digest does not match the root-bound Manifest: ${envelope.manifestDigest} != ${digest}`);
  }
  if (manifest.plan.plan_digest !== envelope.planDigest) {
    mismatch('plan_digest does not match the Manifest plan binding');
  }

  const planPath = rootRelativePath(root, manifest.plan.ref, 'Manifest.plan.ref');
  // Read the exact plan projection before the reference digest re-check. The
  // re-check below is the immutable-plan binding; this read also closes the
  // missing/symlink path case when a Manifest has no direct entity descriptor.
  readRootBoundText(root, planPath, 'Manifest.plan.ref');
  try {
    assertVNextManifestReferenceBindings(root, manifest);
  } catch (error) {
    mismatch(`Manifest/Plan reference binding failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return manifest;
}

function canonicalScope(root: string, scope: VNextExecutionScope): VNextExecutionScope {
  const kind = requireString(scope.kind, 'execution_scope.kind');
  if (kind !== 'implementation' && kind !== 'evidence-only') {
    mismatch(`execution_scope.kind is unsupported: ${kind}`);
  }
  const codePaths = requireStringArray(scope.code_paths, 'execution_scope.code_paths')
    .map((value, index) => rootRelativePath(root, value, `execution_scope.code_paths[${index}]`));
  const testPaths = requireStringArray(scope.test_paths, 'execution_scope.test_paths')
    .map((value, index) => rootRelativePath(root, value, `execution_scope.test_paths[${index}]`));
  const forbiddenPaths = requireStringArray(scope.forbidden_paths, 'execution_scope.forbidden_paths')
    .map((value, index) => rootRelativePath(root, value, `execution_scope.forbidden_paths[${index}]`));
  return {
    kind: kind as VNextExecutionScope['kind'],
    code_paths: codePaths,
    test_paths: testPaths,
    forbidden_paths: forbiddenPaths,
  };
}

function taskBinding(
  root: string,
  manifest: VNextManifest,
  envelope: VNextWorkerResultEnvelope,
  context: VNextWorkerContext,
): TaskBinding {
  const slice = manifest.slices.find((candidate) => candidate.slice_id === envelope.sliceId);
  if (slice === undefined) mismatch(`Manifest does not declare slice ${envelope.sliceId}`);

  if (context.stage_id !== envelope.stageId || context.slice_id !== envelope.sliceId) {
    mismatch('Context stage/slice binding does not match the Worker result');
  }
  const taskId = context.task_id;
  const taskRefIds = slice.proof_index.task_refs.filter((refId) => {
    const descriptor = manifest.reference_index[refId];
    return descriptor?.kind === 'task' && descriptor.ref === context.task_ref;
  });
  if (taskRefIds.length !== 1) mismatch('Context task_ref is not uniquely bound by the Slice Proof Index');
  const taskDescriptor = manifest.reference_index[taskRefIds[0]];
  if (taskDescriptor === undefined || taskDescriptor.kind !== 'task') {
    mismatch('Context task descriptor is unavailable from the admitted Proof Index');
  }
  const entityMatch = /#\/entities\/([^/]+)$/.exec(taskDescriptor.ref);
  if (entityMatch?.[1] !== taskId || !taskId.startsWith(`${slice.slice_id}-`)) {
    mismatch('Context task_id is not bound to the Slice task entity');
  }
  if (envelope.taskId !== undefined && envelope.taskId !== taskId) {
    mismatch('Worker result taskId does not match the Context task_id');
  }

  const scopeBinding = manifest.task_scopes[taskId];
  if (scopeBinding === undefined || scopeBinding.task_ref !== taskDescriptor.ref) {
    mismatch(`Manifest execution scope is not bound to task ${taskId}`);
  }
  const executionScope = canonicalScope(root, scopeBinding.execution_scope);
  if (
    executionScope.kind !== 'implementation' ||
    executionScope.code_paths.length === 0 ||
    executionScope.test_paths.length === 0
  ) {
    mismatch(`Task ${taskId} has no non-empty implementation code/test scope`);
  }
  const planPath = rootRelativePath(root, manifest.plan.ref, 'Manifest.plan.ref');
  const evidencePath = rootRelativePath(root, slice.evidence_path, 'Slice Evidence path');
  return {
    slice,
    taskId,
    taskRef: taskDescriptor.ref,
    executionScope,
    planPath,
    evidencePath,
  };
}

function readAndValidateContext(
  root: string,
  manifest: VNextManifest,
  envelope: VNextWorkerResultEnvelope,
): VNextWorkerContext {
  const contextRelative = rootRelativePath(root, envelope.contextRef, 'contextRef');
  if (contextRelative !== `.proofloop/context/${envelope.contextDigest}.json`) {
    mismatch('contextRef is not digest-addressed by contextDigest');
  }
  const contextRecord = readRootBoundJson(root, contextRelative, 'Context');
  assertExactFields(contextRecord, CONTEXT_FIELDS, 'Context');
  if (contextRecord.schema_version !== 2) mismatch('Context schema_version must be 2');

  const withoutDigest = { ...contextRecord };
  delete withoutDigest.context_digest;
  if (computeDigest(withoutDigest) !== envelope.contextDigest) {
    mismatch('context_digest does not match the root-bound Context content');
  }
  if (contextRecord.context_digest !== envelope.contextDigest) {
    mismatch('Context context_digest does not match the Worker result');
  }

  const context = contextRecord as unknown as VNextWorkerContext;
  if (context.root_path !== root || context.root_digest !== computeDigest(root)) {
    mismatch('Context root binding does not match the canonical project root');
  }
  if (
    context.stage_id !== envelope.stageId ||
    context.slice_id !== envelope.sliceId ||
    context.manifest_digest !== envelope.manifestDigest ||
    context.plan_digest !== envelope.planDigest ||
    context.proof_index_digest !== envelope.proofIndexDigest ||
    context.snapshot_digest !== envelope.snapshotDigest
  ) {
    mismatch('Context digest tuple does not match the Worker result');
  }
  // S08-E-T07 §Recovery: the Context carries the persisted dispatch-mode
  // binding. A recover-task Context can never be admitted under the
  // implement-task narrative, and vice versa.
  if (
    (VNEXT_WORKER_COMPLETION_MODES as readonly string[]).includes(context.mode) === false
  ) {
    mismatch(`Context mode binding "${String(context.mode)}" is outside the closed completion vocabulary`);
  }
  if (context.mode !== envelope.mode) {
    mismatch(
      `Context mode binding "${context.mode}" does not match the Worker result mode "${envelope.mode}"`,
    );
  }
  if (context.evidence_path !== rootRelativePath(root, manifest.slices.find((slice) => slice.slice_id === envelope.sliceId)?.evidence_path, 'Slice Evidence path')) {
    mismatch('Context evidence_path is not bound to the Manifest Slice');
  }
  if (context.plan_projection_path !== rootRelativePath(root, manifest.plan.ref, 'Manifest.plan.ref')) {
    mismatch('Context plan_projection_path is not the exact Manifest.plan.ref');
  }

  requireString(context.task_id, 'Context.task_id');
  requireString(context.task_ref, 'Context.task_ref');
  requireString(context.slice_goal_ref, 'Context.slice_goal_ref');
  requireStringArray(context.required_skills, 'Context.required_skills');
  requireStringArray(context.allowed_code_scope, 'Context.allowed_code_scope');
  assertDigest(context.root_digest, 'Context.root_digest', 64);
  assertDigest(context.manifest_digest, 'Context.manifest_digest', 64);
  assertDigest(context.plan_digest, 'Context.plan_digest', 64);
  assertDigest(context.proof_index_digest, 'Context.proof_index_digest', 64);
  assertDigest(context.snapshot_digest, 'Context.snapshot_digest', 40);

  const proofIndex = requireRecord(context.proof_index, 'Context.proof_index');
  assertExactFields(proofIndex, PROOF_INDEX_FIELDS, 'Context.proof_index');
  requireString(proofIndex.goal_ref, 'Context.proof_index.goal_ref');
  for (const field of ['task_refs', 'acceptance_refs', 'seam_refs', 'oracle_refs', 'risk_refs']) {
    requireStringArray(proofIndex[field], `Context.proof_index.${field}`);
  }

  const executionScope = requireRecord(context.execution_scope, 'Context.execution_scope');
  assertExactFields(executionScope, EXECUTION_SCOPE_FIELDS, 'Context.execution_scope');
  requireString(executionScope.kind, 'Context.execution_scope.kind');
  requireStringArray(executionScope.code_paths, 'Context.execution_scope.code_paths');
  requireStringArray(executionScope.test_paths, 'Context.execution_scope.test_paths');
  requireStringArray(executionScope.forbidden_paths, 'Context.execution_scope.forbidden_paths');

  const workerScope = requireRecord(context.scope, 'Context.scope');
  assertExactFields(workerScope, WORKER_SCOPE_FIELDS, 'Context.scope');
  requireStringArray(workerScope.allowed_paths, 'Context.scope.allowed_paths');
  requireStringArray(workerScope.mutable_projection_paths, 'Context.scope.mutable_projection_paths');
  requireStringArray(workerScope.forbidden_paths, 'Context.scope.forbidden_paths');
  return context;
}

function assertDigest(value: unknown, label: string, length: 40 | 64): void {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) {
    mismatch(`${label} is not a lowercase ${length === 40 ? 'Git' : 'SHA-256'} digest`);
  }
}

function assertContextTaskBinding(
  root: string,
  manifest: VNextManifest,
  envelope: VNextWorkerResultEnvelope,
  context: VNextWorkerContext,
  task: TaskBinding,
): void {
  const expectedProofIndex = {
    goal_ref: task.slice.proof_index.goal_ref,
    task_refs: [...task.slice.proof_index.task_refs],
    acceptance_refs: [...task.slice.proof_index.acceptance_refs],
    seam_refs: [...task.slice.proof_index.seam_refs],
    oracle_refs: [...task.slice.proof_index.oracle_refs],
    risk_refs: task.slice.proof_index.risk_refs.map((risk) => risk.ref_id),
  };
  if (!sameValue(context.proof_index, expectedProofIndex)) {
    mismatch('Context Proof Index does not match the admitted Manifest Slice');
  }
  if (context.slice_goal_ref !== task.slice.proof_index.goal_ref) {
    mismatch('Context slice_goal_ref is not bound to the Slice Proof Index');
  }
  if (!sameValue(context.required_skills, task.slice.required_skills)) {
    mismatch('Context required_skills do not match the admitted Slice');
  }
  if (context.proof_index_digest !== computeDigest(task.slice.proof_index)) {
    mismatch('Context proof_index_digest does not match the admitted Proof Index');
  }

  const contextScope = canonicalScope(root, context.execution_scope);
  if (!sameValue(contextScope, task.executionScope)) {
    mismatch('Context execution_scope does not match the immutable Manifest task scope');
  }
  const codeScope = unique([...task.executionScope.code_paths, ...task.executionScope.test_paths]);
  if (!sameValue(context.allowed_code_scope, codeScope)) {
    mismatch('Context allowed_code_scope is broader than the admitted code/test scope');
  }

  const planPath = task.planPath;
  const evidencePath = task.evidencePath;
  const expectedAllowedPaths = unique([...codeScope, evidencePath, planPath]);
  const expectedForbiddenPaths = unique([
    ...task.executionScope.forbidden_paths,
    ...SYSTEM_FORBIDDEN_PATHS.map((value) => rootRelativePath(root, value, 'system forbidden path')),
  ]);
  const workerScope = context.scope;
  const allowedPaths = requireStringArray(workerScope.allowed_paths, 'Context.scope.allowed_paths')
    .map((value, index) => rootRelativePath(root, value, `Context.scope.allowed_paths[${index}]`));
  const mutablePaths = requireStringArray(workerScope.mutable_projection_paths, 'Context.scope.mutable_projection_paths')
    .map((value, index) => rootRelativePath(root, value, `Context.scope.mutable_projection_paths[${index}]`));
  const forbiddenPaths = requireStringArray(workerScope.forbidden_paths, 'Context.scope.forbidden_paths')
    .map((value, index) => rootRelativePath(root, value, `Context.scope.forbidden_paths[${index}]`));
  if (!sameValue(allowedPaths, expectedAllowedPaths)) {
    mismatch('Context scope.allowed_paths is broader than the admitted task scope');
  }
  if (!sameValue(mutablePaths, [planPath])) {
    mismatch('Context scope.mutable_projection_paths must contain only Manifest.plan.ref');
  }
  if (!sameValue(forbiddenPaths, expectedForbiddenPaths)) {
    mismatch('Context scope.forbidden_paths does not match the admitted forbidden scope');
  }
  for (const allowed of allowedPaths) {
    for (const forbidden of forbiddenPaths) {
      if (pathsOverlap(allowed, forbidden)) {
        mismatch(`Context allowed path overlaps forbidden path: ${allowed}`);
      }
    }
  }
  if (context.evidence_path !== evidencePath || context.plan_projection_path !== planPath) {
    mismatch('Context artifact paths do not match the admitted Manifest paths');
  }
  if (context.task_id !== task.taskId || context.task_ref !== task.taskRef) {
    mismatch('Context task binding does not match the admitted task entity');
  }
  if (envelope.taskId !== undefined && envelope.taskId !== task.taskId) {
    mismatch('Worker result taskId does not match the admitted task entity');
  }
  if (manifest.plan.plan_digest !== envelope.planDigest) {
    mismatch('Manifest plan binding changed during Context validation');
  }
}

/**
 * A completed Worker result must carry the current Task's Evidence subsection
 * in the Manifest-declared Slice Evidence file.  A checkbox or Worker Status
 * projection is never a substitute for that persisted proof.
 */
interface EvidenceFieldMatch {
  readonly index: number;
  readonly value: string;
}

const TASK_EVIDENCE_FIELD_LABELS = new Set([
  'Task Goal',
  'Relevant PO IDs',
  'Source Snapshot',
  'Current Snapshot',
  'Changed Files',
  'RED Receipt',
  'GREEN Receipt',
  'Status',
]);

const RED_RECEIPT_FIELDS = [
  'Test ID',
  'Command',
  'Failure Output',
  'Expected Failure',
  'Snapshot',
] as const;

const GREEN_RECEIPT_FIELDS = [
  'Test ID',
  'Command',
  'Pass Output',
  'Snapshot',
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function evidenceFieldMatches(
  lines: readonly string[],
  start: number,
  end: number,
  label: string,
): EvidenceFieldMatch[] {
  const pattern = new RegExp(`^\\s*-\\s*${escapeRegExp(label)}\\s*:\\s*(.*?)\\s*$`);
  const matches: EvidenceFieldMatch[] = [];
  for (let index = start; index < end; index += 1) {
    const match = pattern.exec(lines[index]);
    if (match !== null) matches.push({ index, value: match[1] });
  }
  return matches;
}

function hasSubstantiveEvidenceValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && !/^\*(?:Not yet captured|None|No tasks have been executed yet)\.?\*$/.test(normalized);
}

function evidenceFieldLabel(line: string): string | undefined {
  const match = /^\s*-\s*([^:]+)\s*:/.exec(line);
  return match?.[1].trim();
}

function isTaskEvidenceFieldLine(line: string): boolean {
  const label = evidenceFieldLabel(line);
  return label !== undefined && TASK_EVIDENCE_FIELD_LABELS.has(label);
}

function requireEvidenceField(
  lines: readonly string[],
  start: number,
  end: number,
  label: string,
  allowIndentedContent = false,
): EvidenceFieldMatch {
  const matches = evidenceFieldMatches(lines, start, end, label);
  if (matches.length !== 1) {
    mismatch(`Task Evidence must contain exactly one "${label}" field`);
  }
  const match = matches[0];
  if (hasSubstantiveEvidenceValue(match.value)) return match;

  if (allowIndentedContent) {
    for (let index = match.index + 1; index < end; index += 1) {
      if (isTaskEvidenceFieldLine(lines[index])) break;
      if (hasSubstantiveEvidenceValue(lines[index].trim())) return match;
    }
  }
  mismatch(`Task Evidence field "${label}" must contain substantive content`);
}

function receiptBodyEnd(
  lines: readonly string[],
  start: number,
  end: number,
  nextReceipt: string,
): number {
  for (let index = start; index < end; index += 1) {
    const label = evidenceFieldLabel(lines[index]);
    if (label === nextReceipt || label === 'Status') return index;
  }
  return end;
}

function protectedEvidenceProjection(content: string, allowedTaskIds: readonly string[]): string[] {
  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');
  const taskEvidenceHeadings = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => entry.line === '## Task Evidence');
  if (taskEvidenceHeadings.length !== 1) {
    mismatch('Manifest Slice Evidence must contain exactly one "## Task Evidence" section');
  }

  const sectionStart = taskEvidenceHeadings[0].index + 1;
  let sectionEnd = lines.length;
  for (let index = sectionStart; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) {
      sectionEnd = index;
      break;
    }
  }

  const allowedTaskHeadings = new Map<string, number>();
  for (let index = sectionStart; index < sectionEnd; index += 1) {
    const match = /^###\s+(\S+)(?:\s|$)/.exec(lines[index].trim());
    if (match !== null && allowedTaskIds.includes(match[1])) {
      if (allowedTaskHeadings.has(match[1])) {
        mismatch(`Manifest Slice Evidence contains duplicate Task Evidence for ${match[1]}`);
      }
      allowedTaskHeadings.set(match[1], index);
    }
  }

  const excludedRanges = [...allowedTaskHeadings.values()].map((taskStart) => {
    let taskEnd = sectionEnd;
    for (let index = taskStart + 1; index < sectionEnd; index += 1) {
      if (/^###\s+/.test(lines[index].trim())) {
        taskEnd = index;
        break;
      }
    }
    return { start: taskStart, end: taskEnd };
  });

  const protectedLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (excludedRanges.some((range) => index >= range.start && index < range.end)) continue;
    if (
      index >= sectionStart &&
      index < sectionEnd &&
      /^\*(?:Not yet captured|No tasks have been executed yet)\.\*$/.test(lines[index].trim())
    ) {
      continue;
    }
    const normalized = lines[index].replace(/[ \t]+$/, '');
    if (normalized.trim().length > 0) protectedLines.push(normalized);
  }
  return protectedLines;
}

function assertCurrentTaskEvidence(
  root: string,
  task: TaskBinding,
  allowedTaskIds: readonly string[] = [task.taskId],
): void {
  const content = readRootBoundText(root, task.evidencePath, 'Manifest Slice Evidence');
  const lines = content.split(/\r?\n/);
  const taskEvidenceHeadings = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => entry.line === '## Task Evidence');
  if (taskEvidenceHeadings.length !== 1) {
    mismatch(
      `Manifest Slice Evidence must contain exactly one "## Task Evidence" section for ${task.taskId}`,
    );
  }

  const start = taskEvidenceHeadings[0].index + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }

  const matchingTaskHeadings: number[] = [];
  for (let index = start; index < end; index += 1) {
    const match = /^###\s+(\S+)(?:\s|$)/.exec(lines[index].trim());
    if (match?.[1] === task.taskId) matchingTaskHeadings.push(index);
  }
  if (matchingTaskHeadings.length !== 1) {
    mismatch(`Manifest Slice Evidence is missing the current Task Evidence subsection for ${task.taskId}`);
  }

  const taskStart = matchingTaskHeadings[0] + 1;
  let taskEnd = end;
  for (let index = taskStart; index < end; index += 1) {
    if (/^###\s+/.test(lines[index].trim())) {
      taskEnd = index;
      break;
    }
  }
  const body = lines.slice(taskStart, taskEnd);
  requireEvidenceField(body, 0, body.length, 'Task Goal');
  requireEvidenceField(body, 0, body.length, 'Relevant PO IDs');
  requireEvidenceField(body, 0, body.length, 'Source Snapshot');
  requireEvidenceField(body, 0, body.length, 'Current Snapshot');
  requireEvidenceField(body, 0, body.length, 'Changed Files', true);

  const redReceipt = requireEvidenceField(body, 0, body.length, 'RED Receipt', true);
  const redEnd = receiptBodyEnd(body, redReceipt.index + 1, body.length, 'GREEN Receipt');
  for (const field of RED_RECEIPT_FIELDS) {
    requireEvidenceField(body, redReceipt.index + 1, redEnd, field);
  }

  const greenReceipt = requireEvidenceField(body, 0, body.length, 'GREEN Receipt', true);
  const greenEnd = receiptBodyEnd(body, greenReceipt.index + 1, body.length, '');
  for (const field of GREEN_RECEIPT_FIELDS) {
    requireEvidenceField(body, greenReceipt.index + 1, greenEnd, field);
  }

  const status = requireEvidenceField(body, 0, body.length, 'Status');
  if (status.value !== 'COMPLETE') {
    mismatch(`Task Evidence for ${task.taskId} has no canonical Status: COMPLETE marker`);
  }

  let baseline: string;
  try {
    baseline = execFileSync('git', ['-C', root, 'show', `HEAD:${task.evidencePath}`], { encoding: 'utf8' });
  } catch {
    mismatch(`Manifest Slice Evidence baseline is unavailable at HEAD:${task.evidencePath}`);
  }
  if (!sameValue(protectedEvidenceProjection(baseline, allowedTaskIds), protectedEvidenceProjection(content, allowedTaskIds))) {
    mismatch('Worker changed another Task/Slice Evidence section or Current CV Status');
  }
}

interface ChangedLine {
  readonly index: number;
  readonly text: string;
}

interface LineChangeGroup {
  readonly removed: readonly ChangedLine[];
  readonly added: readonly ChangedLine[];
}

function lineChanges(before: readonly string[], after: readonly string[]): LineChangeGroup[] {
  const table = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i] === after[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const groups: LineChangeGroup[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const removed: ChangedLine[] = [];
    const added: ChangedLine[] = [];
    while (i < before.length || j < after.length) {
      if (i < before.length && j < after.length && before[i] === after[j]) break;
      if (i < before.length && (j === after.length || table[i + 1][j] >= table[i][j + 1])) {
        removed.push({ index: i, text: before[i] });
        i += 1;
      } else if (j < after.length) {
        added.push({ index: j, text: after[j] });
        j += 1;
      }
    }
    groups.push({ removed, added });
  }
  return groups;
}

function sliceAtLine(lines: readonly string[], index: number): string | undefined {
  let current: string | undefined;
  for (let i = 0; i <= index && i < lines.length; i += 1) {
    const match = /^##\s+Slice\s+(\S+)/.exec(lines[i]);
    if (match !== null) current = match[1];
  }
  return current;
}

function taskCheckboxLine(line: string, taskId: string): boolean {
  return taskCheckboxId(line) === taskId;
}

function taskCheckboxId(line: string): string | undefined {
  const match = /^\s*-\s*\[[ xX]\]\s+(\S+)/.exec(line);
  return match?.[1];
}

function normalizedCheckboxLine(line: string): string {
  return line.replace(/\[[xX]\]/, '[ ]');
}

/**
 * The Mutable Execution Projection `- checkbox: `[ ]`` / `- checkbox: `[x]``
 * row mirrors the execution-only Task checkbox state inside each Slice
 * projection (see delivery/stages/S08/tasks.md). It is neither a Task row nor
 * the Worker Status row, so it needs its own closed line grammar. The shape
 * matches the normalizePlanExecutionProjection canonicalization in
 * entity-resolver.ts: optional indent and bullet, `checkbox:` prefix, a
 * backtick-wrapped checkbox and the closing backtick at end of line.
 */
function mutableProjectionCheckboxLine(line: string): boolean {
  return /^\s*(?:[-*]\s*)?checkbox\s*:\s*`\[[ xX]\]`\s*$/i.test(line);
}

function normalizedMutableProjectionCheckboxLine(line: string): string {
  return line.replace(/\[[xX]\]/, '[ ]');
}

function workerStatusLine(line: string, sliceId: string, lines: readonly string[], index: number): boolean {
  return /^\s*-\s*Worker Status\s*:/i.test(line) && sliceAtLine(lines, index) === sliceId;
}

function normalizedWorkerStatusLine(line: string): string {
  const match = /^(\s*-\s*Worker Status\s*:\s*).*/i.exec(line);
  return match === null ? line : match[1];
}

function workerStatusValue(line: string): string | undefined {
  const match = /^\s*-\s*Worker Status\s*:\s*(.*?)\s*$/i.exec(line);
  if (match === null) return undefined;
  const raw = match[1].trim();
  if (raw.startsWith('`') && raw.endsWith('`') && raw.length >= 2) {
    return raw.slice(1, -1);
  }
  return raw;
}

interface CurrentTaskCheckbox {
  readonly index: number;
  readonly checked: boolean;
}

function currentTaskCheckboxes(
  lines: readonly string[],
  sliceId: string,
  taskId: string,
): CurrentTaskCheckbox[] {
  const checkboxes: CurrentTaskCheckbox[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (sliceAtLine(lines, index) !== sliceId) continue;
    const match = /^\s*-\s*\[([ xX])\]\s+(\S+)/.exec(lines[index]);
    if (match?.[2] === taskId) {
      checkboxes.push({ index, checked: match[1].toLowerCase() === 'x' });
    }
  }
  return checkboxes;
}

function assertCurrentWorkerStatusVocabulary(
  lines: readonly string[],
  sliceId: string,
  source: 'HEAD' | 'worktree',
): void {
  const statusLines = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => workerStatusLine(entry.line, sliceId, lines, entry.index));
  if (statusLines.length !== 1) {
    mismatch(
      `AUTHORITY_GAP: ${source} Plan projection must contain exactly one current Slice Worker Status for ${sliceId}`,
    );
  }
  const value = workerStatusValue(statusLines[0].line);
  // The two sides draw from different vocabularies by construction: the HEAD
  // baseline is a planning clean boundary artifact that may still carry the
  // planning-era `NOT_STARTED` spelling (the canonical normalizePlanExecution
  // Projection form), while the worktree side is an execution projection and
  // Worker must advance Status into the closed execution vocabulary.
  const accepted = source === 'HEAD' ? HEAD_WORKER_STATUS_VALUES : WORKER_STATUS_VALUES;
  if (value === undefined || !accepted.has(value)) {
    mismatch(
      `AUTHORITY_GAP: ${source} Worker Status "${value ?? ''}" is outside the closed Worker Contract vocabulary ` +
      `(${[...accepted].join(', ')}); aliases are not accepted`,
    );
  }
}

/**
 * One removed/added line pair is a legal projection change when exactly one of
 * the three closed change vocabularies holds: the current Task checkbox row,
 * the current Slice Worker Status row, or the current Slice mutable
 * `- checkbox:` projection row. Everything else fails closed.
 */
function projectionChangePair(
  oldLine: ChangedLine,
  newLine: ChangedLine,
  beforeLines: readonly string[],
  afterLines: readonly string[],
  sliceId: string,
  allowedTaskIds: readonly string[],
): boolean {
  const changedTaskId = taskCheckboxId(oldLine.text);
  const checkboxChange =
    changedTaskId !== undefined &&
    allowedTaskIds.includes(changedTaskId) &&
    taskCheckboxLine(newLine.text, changedTaskId) &&
    sliceAtLine(beforeLines, oldLine.index) === sliceId &&
    sliceAtLine(afterLines, newLine.index) === sliceId &&
    normalizedCheckboxLine(oldLine.text) === normalizedCheckboxLine(newLine.text);
  const statusChange =
    workerStatusLine(oldLine.text, sliceId, beforeLines, oldLine.index) &&
    workerStatusLine(newLine.text, sliceId, afterLines, newLine.index) &&
    normalizedWorkerStatusLine(oldLine.text) === normalizedWorkerStatusLine(newLine.text);
  const projectionCheckboxChange =
    mutableProjectionCheckboxLine(oldLine.text) &&
    mutableProjectionCheckboxLine(newLine.text) &&
    sliceAtLine(beforeLines, oldLine.index) === sliceId &&
    sliceAtLine(afterLines, newLine.index) === sliceId &&
    normalizedMutableProjectionCheckboxLine(oldLine.text) ===
      normalizedMutableProjectionCheckboxLine(newLine.text);
  return checkboxChange || statusChange || projectionCheckboxChange;
}

/**
 * The Plan projection is file-allowed but field-bounded. Only the current
 * Task checkbox, the current Slice Worker Status and the current Slice
 * `- checkbox:` projection row may differ from HEAD. A `- checkbox:` row and
 * the adjacent Worker Status row can be folded into one LCS group (e.g. a 2v2
 * group), so each group is judged as a line-pair matching problem: it passes
 * only when every removed line can be mapped one-to-one to an added line
 * through a legal projection change, regardless of pair order.
 */
function validateMutablePlanProjection(
  root: string,
  planPath: string,
  taskId: string,
  sliceId: string,
  allowedTaskIds: readonly string[] = [taskId],
): void {
  let before: string;
  try {
    before = execFileSync('git', ['-C', root, 'show', `HEAD:${planPath}`], { encoding: 'utf8' });
  } catch {
    mismatch(`Plan projection baseline is unavailable at HEAD:${planPath}`);
  }
  const after = readRootBoundText(root, planPath, 'Manifest.plan.ref');
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  assertCurrentWorkerStatusVocabulary(beforeLines, sliceId, 'HEAD');
  assertCurrentWorkerStatusVocabulary(afterLines, sliceId, 'worktree');

  for (const allowedTaskId of allowedTaskIds) {
    const beforeCheckboxes = currentTaskCheckboxes(beforeLines, sliceId, allowedTaskId);
    const afterCheckboxes = currentTaskCheckboxes(afterLines, sliceId, allowedTaskId);
    if (beforeCheckboxes.length !== 1 || afterCheckboxes.length !== 1) {
      mismatch(`Plan projection must contain exactly one current Task checkbox for ${allowedTaskId}`);
    }
    if (!afterCheckboxes[0].checked) {
      mismatch(`Task ${allowedTaskId} must be checked before Worker completion is admitted`);
    }
  }

  const afterStatus = afterLines
    .map((line, index) => ({ line, index }))
    .filter((entry) => workerStatusLine(entry.line, sliceId, afterLines, entry.index))
    .map((entry) => workerStatusValue(entry.line))[0];
  if (afterStatus !== 'executing') {
    mismatch(`Worker completion requires Worker Status executing, received ${afterStatus ?? ''}`);
  }

  for (const group of lineChanges(beforeLines, afterLines)) {
    if (group.removed.length !== group.added.length) {
      mismatch('tasks.md changes exceed the current Task checkbox/Worker Status projection');
    }
    const unmatchedRemoved = [...group.removed];
    const unmatchedAdded = [...group.added];
    while (unmatchedRemoved.length > 0) {
      let mapped = false;
      for (let removedIndex = 0; removedIndex < unmatchedRemoved.length && !mapped; removedIndex += 1) {
        for (let addedIndex = 0; addedIndex < unmatchedAdded.length; addedIndex += 1) {
          if (
            projectionChangePair(
              unmatchedRemoved[removedIndex],
              unmatchedAdded[addedIndex],
              beforeLines,
              afterLines,
              sliceId,
              allowedTaskIds,
            )
          ) {
            unmatchedRemoved.splice(removedIndex, 1);
            unmatchedAdded.splice(addedIndex, 1);
            mapped = true;
            break;
          }
        }
      }
      if (!mapped) {
        mismatch('tasks.md contains an immutable or non-current projection change');
      }
    }
  }
}

function gitChangedPaths(root: string): string[] {
  const run = (args: readonly string[]): string[] => {
    try {
      const output = execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return output.split('\0').filter((entry) => entry.length > 0);
    } catch {
      mismatch('Git worktree change list is unavailable');
    }
  };
  return [
    ...run(['diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB', 'HEAD', '--']),
    ...run(['ls-files', '--others', '--exclude-standard', '-z']),
  ];
}

function manifestSliceTaskIds(manifest: VNextManifest, sliceId: string): string[] {
  const slice = manifest.slices.find((candidate) => candidate.slice_id === sliceId);
  if (slice === undefined) mismatch(`Manifest does not declare slice ${sliceId}`);
  return slice.proof_index.task_refs.map((refId) => {
    const descriptor = manifest.reference_index[refId];
    const match = descriptor === undefined ? undefined : /#\/entities\/([^/]+)$/.exec(descriptor.ref);
    if (descriptor?.kind !== 'task' || match?.[1] === undefined) {
      mismatch(`Manifest Slice ${sliceId} has an invalid task anchor`);
    }
    return match[1];
  });
}

/** Read already-admitted vNext facts so later Worker results can retain scope-bound dirty paths. */
function priorVNextTaskIds(
  root: string,
  manifest: VNextManifest,
  envelope: VNextWorkerResultEnvelope,
  currentTaskId: string,
): string[] {
  const category = readReceiptCategory({
    projectRoot: root,
    category: 'tasks',
    stageId: envelope.stageId,
    sliceId: envelope.sliceId,
  });
  if (!category.chainValid || category.invalidFiles.length > 0 || category.misplaced.length > 0) {
    mismatch(`Worker Receipt category is not a valid chain: ${category.dir}`);
  }
  const taskIds = manifestSliceTaskIds(manifest, envelope.sliceId);
  const seen = new Set<string>();
  for (const entry of category.receipts) {
    const receipt = entry.receipt;
    if (receipt.stage_id !== envelope.stageId || receipt.slice_id !== envelope.sliceId) {
      mismatch('existing Worker Receipt stage/slice binding does not match the active result');
    }
    const payload = receipt.payload;
    if (payload.schema_version !== 2) {
      mismatch('legacy or unknown Worker Receipt facts cannot be mixed into a vNext Worker chain');
    }
    const taskId = requireString(payload.task_id, 'existing TASK_COMPLETE.task_id');
    if (!taskIds.includes(taskId)) {
      mismatch(`existing TASK_COMPLETE task ${taskId} is not declared by the Manifest Slice`);
    }
    if (
      payload.manifest_digest !== envelope.manifestDigest ||
      payload.plan_digest !== envelope.planDigest ||
      payload.snapshot_digest !== envelope.snapshotDigest
    ) {
      mismatch(`existing TASK_COMPLETE fact for ${taskId} is stale or not bound to the active tuple`);
    }
    if (seen.has(taskId)) mismatch(`multiple existing TASK_COMPLETE facts are ambiguous for task ${taskId}`);
    seen.add(taskId);
  }
  const currentIndex = taskIds.indexOf(currentTaskId);
  if (currentIndex < 0) {
    mismatch(`current Worker task ${currentTaskId} is not declared by the Manifest Slice`);
  }
  for (const [index, taskId] of taskIds.entries()) {
    if (index < currentIndex && !seen.has(taskId)) {
      mismatch(
        `cannot admit task ${currentTaskId} before the complete Manifest task prefix; ` +
        `missing prior Receipt for ${taskId}`,
      );
    }
    if (index > currentIndex && seen.has(taskId)) {
      mismatch(`Manifest task ${taskId} cannot be admitted before current task ${currentTaskId}`);
    }
  }
  return taskIds.slice(0, currentIndex).filter((taskId) => seen.has(taskId));
}

function assertChangedFiles(
  root: string,
  envelope: VNextWorkerResultEnvelope,
  context: VNextWorkerContext,
  manifest: VNextManifest,
  task: TaskBinding,
  allowedTaskIds: readonly string[],
): string[] {
  const declared = envelope.changedFiles.map((value, index) =>
    changedFilePath(root, value, `changedFiles[${index}]`),
  );
  if (new Set(declared).size !== declared.length) {
    mismatch('changed_files contains duplicate canonical paths');
  }

  const codeAndTest = unique([
    ...task.executionScope.code_paths,
    ...task.executionScope.test_paths,
  ]);
  const priorCodeAndTest = unique(
    allowedTaskIds
      .filter((taskId) => taskId !== task.taskId)
      .flatMap((taskId) => {
        const binding = manifest.task_scopes[taskId];
        if (binding === undefined) mismatch(`Manifest execution scope is unavailable for prior task ${taskId}`);
        return [
          ...binding.execution_scope.code_paths.map((value, index) =>
            rootRelativePath(root, value, `prior task ${taskId}.execution_scope.code_paths[${index}]`),
          ),
          ...binding.execution_scope.test_paths.map((value, index) =>
            rootRelativePath(root, value, `prior task ${taskId}.execution_scope.test_paths[${index}]`),
          ),
        ];
      }),
  );
  const forbidden = unique([
    ...task.executionScope.forbidden_paths,
    ...allowedTaskIds
      .filter((taskId) => taskId !== task.taskId)
      .flatMap((taskId) => {
        const binding = manifest.task_scopes[taskId];
        if (binding === undefined) mismatch(`Manifest execution scope is unavailable for prior task ${taskId}`);
        return binding.execution_scope.forbidden_paths.map((value, index) =>
          rootRelativePath(root, value, `prior task ${taskId}.execution_scope.forbidden_paths[${index}]`),
        );
      }),
    ...PROTECTED_PATHS.map((value) => rootRelativePath(root, value, 'system forbidden path')),
  ]);
  const allowed = [...codeAndTest, ...priorCodeAndTest, task.evidencePath, task.planPath];
  const isUnder = (value: string, base: string): boolean =>
    value === base || value.startsWith(`${base}/`);

  for (const changed of declared) {
    if (forbidden.some((base) => pathsOverlap(changed, base))) {
      mismatch(`changed_files contains a forbidden protected path: ${changed}`);
    }
    if (!allowed.some((base) => isUnder(changed, base))) {
      mismatch(`changed_files expands beyond the admitted task scope: ${changed}`);
    }
  }

  const declaredSet = new Set(declared);
  if (!declaredSet.has(task.evidencePath)) {
    mismatch('changed_files must include the current Manifest Slice Evidence path');
  }
  assertIgnoredProtectedPaths(root, [{
    stageId: envelope.stageId,
    sliceId: envelope.sliceId,
    taskId: task.taskId,
    manifestDigest: envelope.manifestDigest,
    planDigest: envelope.planDigest,
    snapshotDigest: envelope.snapshotDigest,
    contextRef: envelope.contextRef,
    // The admission mode gate above already restricted envelope.mode to the
    // closed completion vocabulary {implement-task, recover-task}.
    mode: envelope.mode as VNextWorkerCompletionMode,
  }]);
  const actual = unique(gitChangedPaths(root).map((value, index) =>
    changedFilePath(root, value, `Git changed path[${index}]`),
  ));
  const actualSet = new Set(actual);
  if (declared.length !== actual.length || declared.some((value) => !actualSet.has(value)) || actual.some((value) => !declaredSet.has(value))) {
    mismatch(`changed_files does not exactly describe the current Git worktree changes (declared=${declared.join(',')} actual=${actual.join(',')})`);
  }

  validateMutablePlanProjection(root, task.planPath, task.taskId, envelope.sliceId, allowedTaskIds);
  if (context.scope.mutable_projection_paths.length !== 1 || context.scope.mutable_projection_paths[0] !== task.planPath) {
    mismatch('Context mutable projection is not exactly Manifest.plan.ref');
  }
  return declared;
}

function assertNoDuplicateAdmission(
  root: string,
  envelope: VNextWorkerResultEnvelope,
  taskId: string,
): void {
  const category = readReceiptCategory({
    projectRoot: root,
    category: 'tasks',
    stageId: envelope.stageId,
    sliceId: envelope.sliceId,
  });
  if (!category.chainValid || category.invalidFiles.length > 0 || category.misplaced.length > 0) {
    mismatch(`Worker Receipt category is not a valid chain: ${category.dir}`);
  }
  if (category.receipts.some((entry) => entry.receipt.payload?.['action_token'] === envelope.actionToken)) {
    mismatch(`actionToken "${envelope.actionToken}" has already been admitted`);
  }
  if (category.receipts.some((entry) => entry.receipt.payload?.['task_id'] === taskId)) {
    mismatch(`TASK_COMPLETE for task "${taskId}" has already been admitted`);
  }
}

function validateFacts(
  envelope: VNextWorkerResultEnvelope,
  dependencies: VNextWorkerAdmissionDependencies,
): ValidatedWorkerFacts {
  const root = canonicalProjectRoot(dependencies.projectRoot);
  rootRelativePath(
    root,
    `.proofloop/receipts/plan/${envelope.stageId}`,
    'vNext admission authority path',
  );
  rootRelativePath(
    root,
    `.proofloop/receipts/tasks/${envelope.stageId}/${envelope.sliceId}`,
    'vNext Worker Receipt path',
  );
  // The authority is read before the snapshot assertion so the Worker
  // result can be checked against the admitted snapshot chain.
  const authority = readVNextAdmissionAuthority(root, envelope.stageId);
  const admittedSnapshot = authority.spv.snapshot_digest;
  assertCurrentSnapshot(root, envelope.snapshotDigest, admittedSnapshot);
  const manifest = readAndValidateManifest(root, envelope);
  assertAuthorityBinding(authority, envelope, root);
  const context = readAndValidateContext(root, manifest, envelope);
  const task = taskBinding(root, manifest, envelope, context);
  assertContextTaskBinding(root, manifest, envelope, context, task);
  const allowedTaskIds = unique([
    ...priorVNextTaskIds(root, manifest, envelope, task.taskId),
    task.taskId,
  ]);
  assertCurrentTaskEvidence(root, task, allowedTaskIds);
  if (changedFilePath(root, envelope.evidenceRef, 'evidenceRef') !== task.evidencePath) {
    mismatch('Worker evidenceRef is not the current Slice Evidence path bound by the Manifest');
  }
  const changedFiles = assertChangedFiles(root, envelope, context, manifest, task, allowedTaskIds);
  assertNoDuplicateAdmission(root, envelope, task.taskId);
  // Re-assert right before the write so a HEAD advance between validation
  // and admission cannot slip through (TOCTOU guard, snapshot-chain aware).
  assertCurrentSnapshot(root, envelope.snapshotDigest, admittedSnapshot);
  return { root, manifest, authority, context, task, changedFiles };
}

function rejected(message: string): AdmitResult {
  return {
    accepted: false,
    receipt_ref: null,
    new_state: null,
    findings: [{ code: 'RUNTIME.SCHEMA_MISMATCH', severity: 'error', message }],
  };
}

function vNextState(
  envelope: VNextWorkerResultEnvelope,
  facts: ValidatedWorkerFacts,
): VNextWorkerAdmissionState {
  return {
    schema_version: 2,
    action: 'TASK_COMPLETE',
    stage_id: envelope.stageId,
    slice_id: envelope.sliceId,
    task_id: facts.task.taskId,
    mode: envelope.mode,
    outcome: 'completed',
    manifest_digest: envelope.manifestDigest,
    plan_digest: envelope.planDigest,
    proof_index_digest: envelope.proofIndexDigest,
    snapshot_digest: envelope.snapshotDigest,
    context_ref: envelope.contextRef,
    context_digest: envelope.contextDigest,
    changed_files: [...facts.changedFiles],
    receipt_chain_valid: true,
  };
}

function workerReceipt(
  envelope: VNextWorkerResultEnvelope,
  facts: ValidatedWorkerFacts,
): ReceiptBuild {
  return {
    type: 'TASK_COMPLETE',
    stage_id: envelope.stageId,
    slice_id: envelope.sliceId,
    timestamp: new Date().toISOString(),
    payload: {
      schema_version: 2,
      action_token: envelope.actionToken,
      mode: envelope.mode,
      outcome: envelope.outcome,
      task_id: facts.task.taskId,
      evidence_ref: facts.task.evidencePath,
      changed_files: [...facts.changedFiles],
      verification_runs: envelope.verificationRuns,
      summary: envelope.summary,
      manifest_digest: envelope.manifestDigest,
      plan_digest: envelope.planDigest,
      proof_index_digest: envelope.proofIndexDigest,
      snapshot_digest: envelope.snapshotDigest,
      context_ref: envelope.contextRef,
      context_digest: envelope.contextDigest,
    },
  };
}

/** Admit one explicit v2 Worker result without entering legacy reconcile. */
export function admitVNextWorkerResult(
  value: unknown,
  dependencies: VNextWorkerAdmissionDependencies,
): AdmitResult {
  let envelope: VNextWorkerResultEnvelope;
  try {
    envelope = validateVNextWorkerResultEnvelope(value);
  } catch (error) {
    return rejected(`vNext Worker result rejected by closed schema: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (envelope.outcome !== 'completed') {
    return rejected(`vNext Worker outcome "${envelope.outcome}" is not admissible; no Receipt is written`);
  }
  // S08-E-T07 §Recovery: implement-task and recover-task are the only closed
  // completion modes with a persisted Context mode binding. recover-task is a
  // consistency recheck of already-produced implementation evidence; repair /
  // finalize-slice have no vNext persisted mode binding yet and
  // therefore fail closed instead of being guessed from the legacy state
  // machine. A recover-task result is never a CV verdict and never an
  // implement-task narrative.
  if (
    envelope.mode !== 'implement-task' &&
    envelope.mode !== 'recover-task'
  ) {
    return rejected(
      `vNext Worker mode "${envelope.mode}" has no admitted Context mode binding; ` +
      `only ${VNEXT_WORKER_COMPLETION_MODES.join(', ')} are admissible`,
    );
  }

  let facts: ValidatedWorkerFacts;
  try {
    facts = validateFacts(envelope, dependencies);
  } catch (error) {
    return rejected(`vNext Worker admission blocked: ${error instanceof Error ? error.message : String(error)}`);
  }
  const state = vNextState(envelope, facts);
  return runReceiptAdmission({
    build: workerReceipt(envelope, facts),
    targetDir: tasksReceiptDir(facts.root, envelope.stageId, envelope.sliceId),
    nextState: state,
    writer: dependencies.writer,
    projectRoot: facts.root,
    admissionKey: envelope.actionToken,
    beforeWrite: () => {
      validateFacts(envelope, dependencies);
    },
  });
}
