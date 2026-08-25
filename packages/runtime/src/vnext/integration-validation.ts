/**
 * Canonical read-only vNext Worker/CV/Commit/Integration validators.
 *
 * This module contains no producer, writer, Host router, or vNext consumer
 * imports; historical lineage and admission consumers share these validators.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeDigest,
  computeReceiptDigest,
  validateReceipt,
} from '@proofloop/kernel';
// S12-D repair (v3 consumer chain): the kernel closed dependency-binding
// validator is applied to the persisted INTEGRATION_PASS
// `dependency_bindings` facts (same closed validator `next` / `validate`
// apply to the read side).
import { validateDependencyBinding } from '@proofloop/kernel/dist/vnext';
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
import { detectPlanManifestRoute } from './manifest-route';
import { buildVNextHistoricalManifest } from './historical-manifest';
import {
  cvReceiptDir,
  tasksReceiptDir,
} from '../receipt-layout';
import { validateVNextCvResultEnvelope } from './cv-result-envelope';
import {
  assertSliceLocalCredentialBindingFields,
  assertUpstreamTaskCompleteSemantics,
  credentialSchemaVersionMismatch,
} from './cv-validation';
import type { VNextSliceLocalBindingExpectation } from './cv-validation';
// S12-D-T04 (S12-D REPLAN): the slice-local binding expectation (stage/slice
// contract digests + recomputed execution binding) is the single shared
// computation of the Worker/CV/Commit/Integration credential consumers.
import {
  VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL,
  VNEXT_INTEGRATION_ACTION,
  VNEXT_INTEGRATION_RESULT_TYPE,
  VNEXT_INTEGRATION_SCHEMA_VERSION,
  VNEXT_SLICE_COMMIT_ACTION,
  VNEXT_SLICE_COMMIT_RESULT_TYPE,
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
import { loadAncestorReplanDispositionRecords } from './replan-epoch';
import type { ReplanAncestorDispositionRecord } from './replan-epoch';
export const REQUEST_FIELDS = new Set(['type', 'stageId', 'sliceId', 'commitSha']);
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
  // S12-D-T04 (§8.3, S12-D REPLAN): slice-local binding fields — admissible
  // only on a schema_version 3 SLICE_COMMIT credential (the shared
  // assertSliceLocalCredentialBindingFields enforces the v3-only rule; the
  // schema_version discrimination runs before this exact-field set).
  'stage_contract_digest',
  'slice_contract_digest',
  'execution_binding_digest',
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
  // S12-D-T04 (§8.3, S12-D REPLAN): slice-local binding fields — admissible
  // only on a schema_version 3 INTEGRATION_PASS credential (the shared
  // assertSliceLocalCredentialBindingFields enforces the v3-only rule; the
  // schema_version discrimination runs before this exact-field set).
  'stage_contract_digest',
  'slice_contract_digest',
  'execution_binding_digest',
  // S12-D repair (v3 consumer chain): the persisted slice-local
  // INTEGRATION_PASS credential carries the receipt-bound dependency
  // binding facts (§8.2 `dependency_bindings`) it was admitted against —
  // the read-side consumers (`next` / `validate-vnext-stage`) recompute the
  // execution binding from these persisted facts instead of an empty list.
  // v2 credentials must not carry the field (enforced below); the field is
  // admissible only on the schema_version 3 credential.
  'dependency_bindings',
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
  readonly task: TaskBinding | null;
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

export interface ValidatedIntegrationFacts {
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

export interface IntegrationFactsValidationOptions {
  /** The post-install check must permit the Receipt installed by this run. */
  readonly allowInstalledIntegrationReceipt?: boolean;
}

export type IntegrationAdmissionCode =
  | 'RUNTIME.SCHEMA_MISMATCH'
  | 'RUNTIME.RECEIPT_CHAIN_BROKEN'
  | 'DOMAIN.INVALID_TRANSITION';

export class VNextIntegrationAdmissionError extends Error {
  readonly code: IntegrationAdmissionCode;

  constructor(code: IntegrationAdmissionCode, message: string) {
    super(message);
    this.name = 'VNextIntegrationAdmissionError';
    this.code = code;
  }
}


export function fail(code: IntegrationAdmissionCode, message: string): never {
  throw new VNextIntegrationAdmissionError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be an object`);
  return value;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a non-empty string`);
  }
  return value;
}

export function requireIdentifier(value: unknown, label: string): string {
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
export function requireCanonicalStageId(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!CANONICAL_STAGE_ID_RE.test(result)) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `${label} is not a canonical Stage ID (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected`,
    );
  }
  return result;
}

export function requireDigest(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!SHA256_RE.test(result)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} is not a lowercase SHA-256 digest`);
  }
  return result;
}

export function requireSnapshot(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!SNAPSHOT_RE.test(result)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} is not a valid Git snapshot digest`);
  }
  return result;
}

export function requireGitSha(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!GIT_SHA_RE.test(result)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a full lowercase 40-character Git commit SHA`);
  }
  return result;
}

export function requireStringArray(
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

export function assertExactFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !fields.has(key));
  if (unknown.length > 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} contains unknown field(s): ${unknown.join(', ')}`);
  }
}

export function sameValue(left: unknown, right: unknown): boolean {
  try {
    return computeDigest(left) === computeDigest(right);
  } catch {
    return false;
  }
}

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function pathWithin(value: string, base: string): boolean {
  return value === base || value.startsWith(`${base}/`);
}

function pathsOverlap(left: string, right: string): boolean {
  return pathWithin(left, right) || pathWithin(right, left);
}

export function canonicalProjectRoot(projectRoot: string): string {
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

export function assertVNextManifestRoute(root: string, manifestPath: string, stageId: string): void {
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

export function rootRelativePath(root: string, value: unknown, label: string): string {
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
  // User authorization A4 (integration sliceBinding counterpart): the
  // overlap check is task-level — each task's own allowed scope against its
  // own forbidden list plus the system forbidden paths.  Another task's
  // forbidden list must not veto this task's admitted files (S12-D: T02
  // edits next.ts while T01/T04 forbid it).
  for (const task of tasks) {
    const taskForbidden = unique([
      ...task.executionScope.forbidden_paths,
      ...systemForbiddenPaths(root),
    ]);
    for (const allowed of unique([...task.allowedCodeScope, evidencePath, planPath])) {
      for (const forbidden of taskForbidden) {
        if (pathsOverlap(allowed, forbidden)) {
          fail('RUNTIME.SCHEMA_MISMATCH', `Manifest execution scope overlaps forbidden path: ${allowed}`);
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
  task: TaskBinding | null,
  contextRef: string,
  contextDigest: string,
  historicalScope = false,
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
  if (!historicalScope && !sameValue(forbiddenPaths, expectedForbiddenPaths)) {
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

export interface ReceiptChain {
  readonly receipts: readonly Receipt[];
  readonly tipDigest: string | null;
}

/** Read one vNext Receipt chain without invoking the legacy receipt reader. */
export function readReceiptChain(root: string, directory: string, label: string, allowMultipleGenerations = false): ReceiptChain {
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
  if (genesis.length !== 1 && !allowMultipleGenerations) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} must contain exactly one chain genesis`);
  }
  const ordered: Receipt[] = [];
  const visited = new Set<string>();
  for (const rootDigest of genesis.sort()) {
    let current: string | undefined = rootDigest;
    while (current !== undefined) {
      if (visited.has(current)) fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains a circular or overlapping Receipt chain`);
      const receipt = byDigest.get(current);
      if (receipt === undefined) fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains an unreachable Receipt`);
      visited.add(current);
      ordered.push(receipt);
      current = successors.get(current);
    }
  }
  if (visited.size !== byDigest.size) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains an unreachable Receipt branch`);
  }
  return { receipts: ordered, tipDigest: ordered[ordered.length - 1].digest };
}

/** Select one canonical Receipt generation, excluding only older invalidated lineage. */
export function selectVNextReceiptGeneration(
  chain: ReceiptChain,
  asOfTipDigest: string | undefined,
  label: string,
  isHistoricalInvalidated: (payload: Record<string, unknown>) => boolean,
 ): ReceiptChain {
  const asOfIndex = asOfTipDigest === undefined
    ? chain.receipts.length - 1
    : chain.receipts.findIndex((receipt) => receipt.digest === asOfTipDigest);
  if (asOfIndex < 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} as-of tip ${asOfTipDigest} is not in the canonical chain`);
  }
  const receipts = chain.receipts.slice(0, asOfIndex + 1);
  const generationTip = asOfTipDigest === undefined ? undefined : receipts[receipts.length - 1]?.payload;
  const activeReceipts = receipts.filter((receipt) => {
    if (!isRecord(receipt.payload)) return false;
    if (isRecord(generationTip) && receipt.payload.manifest_digest === generationTip.manifest_digest && receipt.payload.plan_digest === generationTip.plan_digest && receipt.payload.snapshot_digest === generationTip.snapshot_digest) {
      return true;
    }
    return !isHistoricalInvalidated(receipt.payload);
  });
  return {
    receipts: activeReceipts,
    tipDigest: activeReceipts[activeReceipts.length - 1]?.digest ?? null,
  };
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

/**
 * User authorization A8 (integration counterpart, S12-E REPAIR-001/REPAIR-
 * FINAL): the union of the changed_files declared by every ALREADY ADMITTED
 * TASK_COMPLETE receipt of the OTHER Slices DECLARED BY THE CURRENT MANIFEST
 * (manifest.slices where slice_id ≠ current and task_refs is non-empty).  In
 * a shared worktree with interleaved Slice outputs (S12-D/S12-E) the
 * committed/integrated boundary of one Slice legitimately carries files
 * declared by another Slice's admitted receipts — the allowed side of the
 * boundary scope check is extended with this union (mirrors
 * commit-admission's A8 implementation).
 *
 * S12-E REPAIR-FINAL: only Manifest-declared other slices are consulted — an
 * unknown slice / a receipt directory not declared in the Manifest NEVER
 * expands the allowed side — and every TASK_COMPLETE receipt must pass the
 * complete admission-chain semantics (readReceiptChain chain valid + payload
 * semantics: mode/outcome/changed_files/evidence_ref/context); a
 * semantically incomplete receipt contributes nothing (fail-closed).  S12-E
 * REPAIR-FINAL round 3: every declared file must also stay inside the
 * declaring Slice's Manifest task scope (the union of all its tasks'
 * allowedCodeScope plus evidence/plan projections) and its Context must be
 * persisted — a forged "declared Slice" credential can never pass
 * out-of-scope files through the A8 merge.
 */
function otherSliceDeclaredFiles(root: string, manifest: VNextManifest, tuple: TupleBinding): string[] {
  const declared = new Set<string>();
  for (const otherSlice of manifest.slices) {
    if (otherSlice.slice_id === tuple.sliceId) continue;
    // A Manifest Slice must declare tasks to hold admitted Worker facts; a
    // taskless declaration never contributes declarations.
    if (otherSlice.proof_index.task_refs.length === 0) continue;
    const otherSliceScope = sliceBinding(root, manifest, otherSlice.slice_id).allowedExecutionScope;
    const otherReceipts = readReceiptChain(
      root,
      tasksReceiptDir(root, tuple.stageId, otherSlice.slice_id),
      `vNext Worker Receipt chain for ${otherSlice.slice_id}`,
    );
    for (const receipt of otherReceipts.receipts) {
      if (receipt.type !== 'TASK_COMPLETE') continue;
      const payload = requireRecord(receipt.payload, `TASK_COMPLETE[${otherSlice.slice_id}].payload`);
      // The complete admission-chain payload semantics: a forged or
      // semantically incomplete TASK_COMPLETE (missing fields / context not
      // persisted / out-of-scope declaration) never contributes declarations
      // to the allowed side.
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
        for (const f of files) declared.add(rootRelativePath(root, f, 'other Slice declared file'));
      }
    }
  }
  return [...declared];
}
function isHistoricalInvalidatedWorkerPayloadForIntegration(
  payload: Record<string, unknown>,
  stageId: string,
  taskIds: readonly string[],
  dispositions: readonly ReplanAncestorDispositionRecord[],
 ): boolean {
  const manifestDigest = payload.manifest_digest;
  const planDigest = payload.plan_digest;
  const snapshotDigest = payload.snapshot_digest;
  if (typeof manifestDigest !== 'string' || typeof planDigest !== 'string' || typeof snapshotDigest !== 'string') return false;
  const exact = dispositions.filter((record) => {
    const previous = record.dispositionFact.previous_snapshot;
    return previous.stage_id === stageId && previous.manifest_digest === manifestDigest && previous.plan_digest === planDigest && previous.snapshot_digest === snapshotDigest;
  });
  if (exact.length === 0) return false;
  if (exact.length !== 1) fail('RUNTIME.SCHEMA_MISMATCH', 'historical Worker lineage has multiple exact persisted disposition authorities');
  const disposition = exact[0].dispositionFact.disposition;
  if (payload.mode === 'finalize-slice') {
    return taskIds.length > 0 && taskIds.every((taskId) => disposition.invalidated_task_ids.includes(taskId) || disposition.carry_forward_task_ids.includes(taskId)) && taskIds.some((taskId) => disposition.invalidated_task_ids.includes(taskId));
  }
  const taskId = typeof payload.task_id === 'string' ? payload.task_id : undefined;
  return taskId !== undefined && taskIds.includes(taskId) && disposition.invalidated_task_ids.includes(taskId) && !disposition.carry_forward_task_ids.includes(taskId);
}

function historicalWorkerTupleKey(payload: Record<string, unknown>): string | null {
  const stageId = payload.stage_id;
  const manifestDigest = payload.manifest_digest;
  const planDigest = payload.plan_digest;
  const snapshotDigest = payload.snapshot_digest;
  if (typeof stageId !== 'string' || typeof manifestDigest !== 'string' || typeof planDigest !== 'string' || typeof snapshotDigest !== 'string') return null;
  return `${stageId}:${manifestDigest}:${planDigest}:${snapshotDigest}`;
}

function validateHistoricalWorkerGeneration(
  root: string,
  currentManifest: VNextManifest,
  stageId: string,
  currentSlice: SliceBinding,
  dispositionRecords: readonly ReplanAncestorDispositionRecord[],
  generationTip: Receipt,
  generationPayload: Record<string, unknown>,
  sliceLocalBinding?: VNextSliceLocalBindingExpectation,
 ): void {
  const exact = dispositionRecords.filter((record) => {
    const previous = record.dispositionFact.previous_snapshot;
    return previous.stage_id === stageId &&
      previous.manifest_digest === generationPayload.manifest_digest &&
      previous.plan_digest === generationPayload.plan_digest &&
      previous.snapshot_digest === generationPayload.snapshot_digest;
  });
  if (exact.length !== 1) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'historical Worker generation has no unique persisted disposition authority');
  }
  const previous = exact[0].dispositionFact.previous_snapshot;
  const historicalSliceInput = previous.slices.find((candidate) => candidate.slice_id === currentSlice.slice.slice_id);
  if (historicalSliceInput === undefined) {
    fail('RUNTIME.SCHEMA_MISMATCH', `historical Worker generation does not declare Slice ${currentSlice.slice.slice_id}`);
  }
  const historicalManifest = buildVNextHistoricalManifest(currentManifest, previous);
  const historicalSlice = sliceBinding(root, historicalManifest, currentSlice.slice.slice_id);
  const historicalTuple: TupleBinding = {
    stageId: previous.stage_id,
    sliceId: currentSlice.slice.slice_id,
    manifestDigest: previous.manifest_digest,
    planDigest: previous.plan_digest,
    proofIndexDigest: computeDigest(historicalSliceInput.proof_index),
    snapshotDigest: previous.snapshot_digest,
  };
  const historicalBinding = historicalManifest.binding === undefined ? undefined : {
    stageContractDigest: previous.stage_contract_digest,
    sliceContractDigest: historicalSliceInput.slice_contract_digest,
    executionBindingDigest: requireDigest(generationPayload.execution_binding_digest, 'historical Worker execution_binding_digest'),
  };
  validateWorkerFacts(
    root,
    historicalManifest,
    historicalSlice,
    historicalTuple,
    historicalBinding ?? sliceLocalBinding,
    generationTip.digest,
    true,
  );
}

/**
 * Canonical pre-skip validation for historical invalidated Worker generations.
 * Before ANY consumer may exclude proven-invalidated Worker facts from its
 * currentness/active identity set, every DISTINCT invalidated generation
 * present in the scanned receipts must first fully validate through the
 * canonical neutral validator (`validateHistoricalWorkerGeneration` →
 * `validateWorkerFacts` against its OWN persisted generation authority):
 * closed schema, outer payload tuple, action tokens, Context digest/scope,
 * changed_files scope and the generation/parent-diff bindings. The LAST
 * receipt of each generation tuple is its generation tip (prefix semantics
 * mirror `selectVNextReceiptGeneration`). A tampered, foreign, partially-
 * invalidated or ambiguous history fails closed here and can never be
 * silently skipped by a downstream consumer loop.
 */
export function assertHistoricalInvalidatedWorkerGenerations(
  root: string,
  currentManifest: VNextManifest,
  stageId: string,
  currentSlice: SliceBinding,
  replanDispositions: readonly ReplanAncestorDispositionRecord[],
  scannedReceipts: readonly Receipt[],
  isInvalidatedPayload: (payload: Record<string, unknown>) => boolean,
  sliceLocalBinding?: VNextSliceLocalBindingExpectation,
): void {
  const generationTips = new Map<string, Receipt>();
  for (const receipt of scannedReceipts) {
    const payload = requireRecord(receipt.payload, `historical Worker generation scan ${receipt.digest}.payload`);
    if (!isInvalidatedPayload(payload)) continue;
    const manifestDigest = payload.manifest_digest;
    const planDigest = payload.plan_digest;
    const snapshotDigest = payload.snapshot_digest;
    if (typeof manifestDigest !== 'string' || typeof planDigest !== 'string' || typeof snapshotDigest !== 'string') {
      fail('RUNTIME.SCHEMA_MISMATCH', 'historical Worker lineage has an invalid generation tuple');
    }
    generationTips.set(`${stageId}\u0000${manifestDigest}\u0000${planDigest}\u0000${snapshotDigest}`, receipt);
  }
  for (const tip of generationTips.values()) {
    validateHistoricalWorkerGeneration(
      root,
      currentManifest,
      stageId,
      currentSlice,
      replanDispositions,
      tip,
      requireRecord(tip.payload, `historical Worker generation tip ${tip.digest}.payload`),
      sliceLocalBinding,
    );
  }
}

export function validateWorkerFacts(
  root: string,
  manifest: VNextManifest,
  slice: SliceBinding,
  tuple: TupleBinding,
  sliceLocalBinding?: VNextSliceLocalBindingExpectation,
  asOfTipDigest?: string,
  skipHistoricalGenerationValidation = false,
 ): WorkerFacts {
  const chain = readReceiptChain(
    root,
    tasksReceiptDir(root, tuple.stageId, tuple.sliceId),
    'vNext Worker Receipt chain',
  );
  if (chain.tipDigest === null || chain.receipts.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'all Manifest tasks must have v2 TASK_COMPLETE facts before Integration admission');
  }
  const replanDispositions = loadAncestorReplanDispositionRecords(root, tuple.stageId);
  if (!skipHistoricalGenerationValidation) {
    const asOfIndex = asOfTipDigest === undefined
      ? chain.receipts.length - 1
      : chain.receipts.findIndex((receipt) => receipt.digest === asOfTipDigest);
    if (asOfIndex < 0) fail('RUNTIME.SCHEMA_MISMATCH', `Worker Receipt chain as-of tip ${asOfTipDigest} is not in the canonical chain`);
    const generationTips = new Map<string, Receipt>();
    for (const receipt of chain.receipts.slice(0, asOfIndex + 1)) {
      if (!isRecord(receipt.payload)) fail('RUNTIME.SCHEMA_MISMATCH', 'Worker Receipt payload is not a closed object');
      const payload = receipt.payload;
      if (!isHistoricalInvalidatedWorkerPayloadForIntegration(payload, tuple.stageId, slice.tasks.map((task) => task.taskId), replanDispositions)) continue;
      const key = historicalWorkerTupleKey(payload);
      if (key !== null) generationTips.set(key, receipt);
    }
    for (const generationTip of generationTips.values()) {
      const payload = requireRecord(generationTip.payload, 'historical Worker generation tip payload');
      validateHistoricalWorkerGeneration(root, manifest, tuple.stageId, slice, replanDispositions, generationTip, payload, sliceLocalBinding);
    }
  }
  const generation = selectVNextReceiptGeneration(
    chain,
    asOfTipDigest,
    'Worker Receipt chain',
    (payload) => isHistoricalInvalidatedWorkerPayloadForIntegration(payload, tuple.stageId, slice.tasks.map((task) => task.taskId), replanDispositions),
  );
  const activeReceipts = generation.receipts;
  // S13-S17 remediation §6.4 / Principle 3: Task completion is derived from
  // the completion-mode IDENTITY SET (implement-task/recover-task facts bound
  // to Manifest task ids), never from the raw Receipt count — the slice
  // finalize-slice fact carries no task identity and must never inflate or
  // satisfy the Task cardinality.

  const facts: WorkerFact[] = [];
  const byDigest = new Map<string, WorkerFact>();
  const actionTokens = new Set<string>();
  const completedTaskIds = new Set<string>();
  let finalizeReceipt: Receipt | null = null;
  for (const [index, receipt] of activeReceipts.entries()) {
    if (
      receipt.version !== 1 ||
      receipt.type !== 'TASK_COMPLETE' ||
      receipt.stage_id !== tuple.stageId ||
      receipt.slice_id !== tuple.sliceId
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Worker Receipt chain contains a legacy, mixed, or wrong-slice Receipt');
    }
    const payload = requireRecord(receipt.payload, `TASK_COMPLETE[${index}].payload`);
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
    // User authorization A4 (same semantics as worker-admission A3): the
    // task-level forbidden list constrains the CURRENT task's own behavior,
    // not the worktree's historical state.  A declared file that belongs to
    // a prior task's code/test scope — and not to the current task's own
    // scope — is exempt from the current task's forbidden check (S12-D: T04
    // must declare T02's next.ts output while T04's own forbidden covers
    // next.ts).  The system forbidden paths and the Slice allowed-scope
    // check still bind every declared file, and the current task's own
    // files stay bound by its own forbidden list.
    const priorCodeAndTest = unique(
      slice.tasks.slice(0, index).flatMap((prior) => prior.allowedCodeScope),
    );
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
      if (!slice.allowedExecutionScope.some((base) => pathWithin(changed, base))) {
        fail('RUNTIME.SCHEMA_MISMATCH', `${changedFilesLabel} expands beyond the admitted Slice scope: ${changed}`);
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
    validateContext(root, manifest, slice, tuple, task, contextRef, contextDigest, asOfTipDigest !== undefined);

    const fact: WorkerFact = { receipt, task, contextRef, contextDigest, changedFiles };
    facts.push(fact);
    byDigest.set(receipt.digest, fact);
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
  // tip — the integrated Slice state binds the finalized chain, never an
  // earlier Task completion.
  if (finalizeReceipt !== null && finalizeReceipt.digest !== activeReceipts[activeReceipts.length - 1]?.digest) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      'the finalize-slice fact must be the Worker Receipt chain tip at Integration admission',
    );
  }
  return {
    receipts: activeReceipts,
    tipDigest: activeReceipts[activeReceipts.length - 1]?.digest ?? null,
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
function isHistoricalInvalidatedCvPayloadForIntegration(
  payload: Record<string, unknown>,
  stageId: string,
  slice: SliceBinding,
  allWorkerReceipts: readonly Receipt[],
  currentWorkerReceipts: readonly Receipt[],
  dispositions: readonly ReplanAncestorDispositionRecord[],
  allowHistoricalGeneration = false,
 ): boolean {
  const matching = dispositions.filter((record) => {
    const previous = record.dispositionFact.previous_snapshot;
    return previous.stage_id === stageId && previous.manifest_digest === payload.manifest_digest && previous.plan_digest === payload.plan_digest && previous.snapshot_digest === payload.snapshot_digest;
  });
  if (matching.length === 0) return false;
  if (matching.length !== 1) fail('RUNTIME.SCHEMA_MISMATCH', 'historical CV lineage has multiple exact persisted disposition authorities');
  const workerDigest = payload.worker_receipt_digest;
  if (typeof workerDigest !== 'string' || currentWorkerReceipts.some((receipt) => receipt.digest === workerDigest)) return false;
  const linked = allWorkerReceipts.find((receipt) => receipt.digest === workerDigest);
  if (linked === undefined || !isRecord(linked.payload)) return false;
  const linkedTaskId = typeof linked.payload.task_id === 'string' ? linked.payload.task_id : undefined;
  if (!allowHistoricalGeneration && linkedTaskId !== undefined && !currentWorkerReceipts.some((receipt) => isRecord(receipt.payload) && receipt.payload.task_id === linkedTaskId)) return false;
  if (!allowHistoricalGeneration && linkedTaskId === undefined && currentWorkerReceipts.length === 0) return false;
  const disposition = matching[0].dispositionFact.disposition;
  const taskIds = slice.tasks.map((task) => task.taskId);
  if (linkedTaskId !== undefined) return taskIds.includes(linkedTaskId) && disposition.invalidated_task_ids.includes(linkedTaskId) && !disposition.carry_forward_task_ids.includes(linkedTaskId);
  return taskIds.length > 0 && taskIds.every((taskId) => disposition.invalidated_task_ids.includes(taskId)) && taskIds.every((taskId) => !disposition.carry_forward_task_ids.includes(taskId));
}

export function validateHistoricalCvGeneration(
  root: string,
  currentManifest: VNextManifest,
  stageHasBinding: boolean,
  currentSlice: VNextManifestSlice,
  dispositionRecords: readonly ReplanAncestorDispositionRecord[],
  allWorkerReceipts: readonly Receipt[],
  generationTip: Receipt,
  generationPayload: Record<string, unknown>,
  sliceLocalBinding?: VNextSliceLocalBindingExpectation,
 ): void {
  const tupleMatches = (value: { readonly stage_id: string; readonly manifest_digest: string; readonly plan_digest: string; readonly snapshot_digest: string }): boolean =>
    value.stage_id === generationPayload.stage_id &&
    value.manifest_digest === generationPayload.manifest_digest &&
    value.plan_digest === generationPayload.plan_digest &&
    value.snapshot_digest === generationPayload.snapshot_digest;
  const generationMatches = dispositionRecords.filter((record) => tupleMatches(record.dispositionFact.snapshot));
  if (generationMatches.length > 1) fail('RUNTIME.SCHEMA_MISMATCH', 'historical CV generation has multiple persisted generation authorities');
  const authority = generationMatches.length === 1
    ? generationMatches[0].dispositionFact.snapshot
    : (() => {
        const previousMatches = dispositionRecords.filter((record) => tupleMatches(record.dispositionFact.previous_snapshot));
        if (previousMatches.length !== 1) fail('RUNTIME.SCHEMA_MISMATCH', 'historical CV generation has no unique persisted disposition authority');
        return previousMatches[0].dispositionFact.previous_snapshot;
      })();
  const historicalSliceInput = authority.slices.find((candidate) => candidate.slice_id === currentSlice.slice_id);
  if (historicalSliceInput === undefined) fail('RUNTIME.SCHEMA_MISMATCH', `historical CV generation does not declare Slice ${currentSlice.slice_id}`);
  const historicalManifest = buildVNextHistoricalManifest(currentManifest, authority);
  const historicalSlice = sliceBinding(root, historicalManifest, currentSlice.slice_id);
  const historicalTuple: TupleBinding = {
    stageId: authority.stage_id,
    sliceId: currentSlice.slice_id,
    manifestDigest: authority.manifest_digest,
    planDigest: authority.plan_digest,
    proofIndexDigest: computeDigest(historicalSliceInput.proof_index),
    snapshotDigest: authority.snapshot_digest,
  };
  const historicalBinding = historicalManifest.binding === undefined ? undefined : {
    stageContractDigest: authority.stage_contract_digest,
    sliceContractDigest: historicalSliceInput.slice_contract_digest,
    executionBindingDigest: requireDigest(generationPayload.execution_binding_digest, 'historical CV execution_binding_digest'),
  };
  const workerDigest = generationPayload.worker_receipt_digest;
  if (typeof workerDigest !== 'string') fail('RUNTIME.SCHEMA_MISMATCH', 'historical CV generation is missing worker_receipt_digest');
  const linkedWorker = allWorkerReceipts.find((receipt) => receipt.digest === workerDigest);
  if (linkedWorker === undefined) fail('RUNTIME.SCHEMA_MISMATCH', 'historical CV generation references an unknown Worker Receipt');
  const linkedWorkerPayload = requireRecord(linkedWorker.payload, 'historical CV linked Worker payload');
  const linkedWorkerKey = historicalWorkerTupleKey(linkedWorkerPayload);
  const workerTip = linkedWorkerKey === null ? linkedWorker : [...allWorkerReceipts].reverse().find((receipt) => {
    const payload = isRecord(receipt.payload) ? receipt.payload : null;
    return payload !== null && historicalWorkerTupleKey(payload) === linkedWorkerKey;
  });
  if (workerTip === undefined) fail('RUNTIME.SCHEMA_MISMATCH', 'historical CV generation has no Worker Receipt for its own generation');
  const historicalWorker = validateWorkerFacts(
    root,
    historicalManifest,
    historicalSlice,
    historicalTuple,
    historicalBinding ?? sliceLocalBinding,
    workerTip.digest,
    true,
  );
  // Validate the complete CV sequence, not only the candidate envelope, before the outer selector can exclude it.
  validateCvFacts(
    root,
    historicalSlice,
    stageHasBinding,
    historicalTuple,
    historicalWorker,
    historicalBinding ?? sliceLocalBinding,
    generationTip.digest,
    false,
    historicalManifest,
  );
}

export function validateCvFacts(
  root: string,
  slice: SliceBinding,
  stageHasBinding: boolean,
  tuple: TupleBinding,
  worker: WorkerFacts,
  sliceLocalBinding?: VNextSliceLocalBindingExpectation,
  asOfTipDigest?: string,
  skipHistoricalGenerationValidation = false,
  currentManifest?: VNextManifest,
 ): CvFacts {
  const chain = readReceiptChain(
    root,
    cvReceiptDir(root, tuple.stageId, tuple.sliceId),
    'vNext CV Receipt chain',
    true,
  );
  if (chain.tipDigest === null || chain.receipts.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'a vNext CV Receipt is required before Integration admission');
  }
  const replanDispositions = loadAncestorReplanDispositionRecords(root, tuple.stageId);
  const allWorkerReceipts = readReceiptChain(root, tasksReceiptDir(root, tuple.stageId, tuple.sliceId), 'vNext Worker Receipt chain').receipts;
  if (!skipHistoricalGenerationValidation) {
    const asOfIndex = asOfTipDigest === undefined
      ? chain.receipts.length - 1
      : chain.receipts.findIndex((receipt) => receipt.digest === asOfTipDigest);
    if (asOfIndex < 0) fail('RUNTIME.SCHEMA_MISMATCH', `CV Receipt chain as-of tip ${asOfTipDigest} is not in the canonical chain`);
    const generationTips = new Map<string, Receipt>();
    for (const receipt of chain.receipts.slice(0, asOfIndex + 1)) {
      if (!isRecord(receipt.payload)) fail('RUNTIME.SCHEMA_MISMATCH', 'CV Receipt payload is not a closed object');
      const payload = receipt.payload;
      if (!isHistoricalInvalidatedCvPayloadForIntegration(payload, tuple.stageId, slice, allWorkerReceipts, worker.receipts, replanDispositions)) continue;
      const key = historicalWorkerTupleKey(payload);
      if (key !== null) generationTips.set(key, receipt);
    }
    for (const generationTip of generationTips.values()) {
      const payload = requireRecord(generationTip.payload, 'historical CV generation tip payload');
      if (currentManifest === undefined) fail('RUNTIME.SCHEMA_MISMATCH', 'historical CV validation requires the current Manifest projection');
      validateHistoricalCvGeneration(root, currentManifest, stageHasBinding, slice.slice, replanDispositions, allWorkerReceipts, generationTip, payload, sliceLocalBinding);
    }
  }
  const generation = selectVNextReceiptGeneration(
    chain,
    asOfTipDigest,
    'CV Receipt chain',
    (payload) => isHistoricalInvalidatedCvPayloadForIntegration(payload, tuple.stageId, slice, allWorkerReceipts, worker.receipts, replanDispositions, asOfTipDigest !== undefined),
  );
  const activeReceipts = generation.receipts;

  const envelopes: VNextCvResultEnvelope[] = [];
  const seenWorkerDigests = new Set<string>();
  for (const [index, receipt] of activeReceipts.entries()) {
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
    receipts: activeReceipts,
    envelopes,
    tipDigest: activeReceipts[activeReceipts.length - 1]?.digest ?? null,
    final,
  };
}

export function gitOutput(root: string, args: readonly string[], label: string): string {
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

function assertWorkingTreeBoundary(root: string, manifest: VNextManifest, tuple: TupleBinding): void {
  const status = gitOutput(root, ['status', '--porcelain', '--untracked-files=all'], 'Git status');
  // User authorization A8 (integration counterpart): worktree changes
  // declared by an ALREADY ADMITTED TASK_COMPLETE receipt of a Manifest-
  // DECLARED Slice of this Stage are expected (shared worktree with
  // interleaved Slice outputs — S12-D/S12-E) and do not block the
  // integration boundary.  S12-E REPAIR-FINAL: unknown slices / receipt
  // directories not declared in the current Manifest are ignored (they
  // never expand the tolerated set), and every TASK_COMPLETE receipt must
  // pass the complete admission-chain payload semantics.  S12-E REPAIR-
  // FINAL round 3: every declared file must also stay inside the declaring
  // Slice's Manifest task scope and its Context must be persisted.  Un-
  // declared changes still fail closed.
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
      `Integration requires a clean committed boundary; unexpected Git changes: ${unexpected.join(', ')}`,
    );
  }
}

export function assertCommittedChangedFiles(
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
  assertWorkingTreeBoundary(root, manifest, tuple);

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
  // User authorization A4 (integration commit-level counterpart): the
  // integrated boundary may legitimately contain any task's admitted files
  // (S12-D: next.ts is T02's admitted file while T01/T04 forbid it), so the
  // forbidden side for the committed boundary is system paths only —
  // mirroring commit-admission's commit-level semantics.  User authorization
  // A8 (S12-E REPAIR-001): the allowed side is the union of this Slice's
  // execution scope and the changed_files declared by every OTHER admitted
  // Worker receipt of the same Stage (a shared worktree with interleaved
  // Slice outputs — S12-D/S12-E) — the same A8 semantics commit-admission
  // applies to the committed boundary.
  assertPathsWithinScope(
    changed,
    unique([...slice.allowedExecutionScope, ...otherSliceDeclaredFiles(root, manifest, tuple)]),
    systemForbiddenPaths(root),
    'Git integrated changed files',
  );

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
  } else if (
    // User authorization A8b/A8c (integration counterpart): the exact-match
    // gate becomes declared-subset with the HEAD-tree escape — a declared
    // projection already present in HEAD history satisfies its declaration
    // through the persisted snapshot.
    !declared.every((value) => changed.includes(value) || gitTreeContains(root, commitSha, value))
  ) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `integrated changed-file set does not contain every persisted Worker fact (declared=${declared.join(',')} actual=${changed.join(',')})`,
    );
  }
  return changed;
}

export function validateSliceCommitPayload(
  root: string,
  manifest: VNextManifest,
  receipt: Receipt,
  tuple: TupleBinding,
  stageHasBinding: boolean,
  slice: SliceBinding,
  worker: WorkerFacts,
  cv: CvFacts,
  commitSha: string,
  changedFiles: readonly string[],
  sliceLocalBinding?: VNextSliceLocalBindingExpectation,
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
  // S12-D-T04 (§8.3): the credential schema_version discrimination runs
  // BEFORE the exact-field set so a slice-local (v3) payload carrying the
  // binding fields fails with the explicit BINDING code, not as an
  // unknown-field rejection.
  const schemaMismatch = credentialSchemaVersionMismatch(
    payload.schema_version,
    stageHasBinding,
    'SLICE_COMMIT.payload',
  );
  if (schemaMismatch !== null) {
    // The BINDING.* code is carried in the finding message: the canonical
    // FindingCode vocabulary is a closed kernel union (§7).
    fail('RUNTIME.SCHEMA_MISMATCH', schemaMismatch.message);
  }
  // S12-D-T04 (§8.3, S12-D REPLAN): in slice-local mode the SLICE_COMMIT
  // credential must carry the slice-local binding fields and bind the SAME
  // Manifest contract digests and recomputed execution binding; a v2
  // credential carrying binding fields is rejected (never silently ignored).
  assertSliceLocalCredentialBindingFields(payload, 'SLICE_COMMIT.payload', sliceLocalBinding);
  assertExactFields(payload, SLICE_COMMIT_PAYLOAD_FIELDS, 'SLICE_COMMIT.payload');
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
  // User authorization A4 (SLICE_COMMIT counterpart): the commit fact
  // declares the whole Slice boundary, which may contain any task's
  // admitted files (S12-D: next.ts is T02's admitted file while T01/T04
  // forbid it); the forbidden side is system paths only.  User authorization
  // A8 (S12-E REPAIR-001): the allowed side is extended with the changed_files
  // declared by every OTHER admitted Worker receipt of the same Stage — the
  // SLICE_COMMIT boundary of one Slice legitimately carries interleaved files
  // of other Slices (mirrors commit-admission's A8 implementation).
  assertPathsWithinScope(
    receiptChangedFiles,
    unique([...slice.allowedExecutionScope, ...otherSliceDeclaredFiles(root, manifest, tuple)]),
    systemForbiddenPaths(root),
    'SLICE_COMMIT.payload.changed_files',
  );
  const workerChangedFiles = unique(worker.facts.flatMap((fact) => fact.changedFiles)).sort();
  const hasRepairHistory = cv.envelopes.some((envelope) => envelope.verdict === 'REPAIR');
  if (hasRepairHistory) {
    // The admitted Slice Commit boundary may contain repair-only files that
    // no Worker fact declared (REPAIR → recheck sequence); the Receipt must
    // still cover every declared Worker fact file.
    if (!workerChangedFiles.every((value) =>
      receiptChangedFiles.includes(value) || gitTreeContains(root, commitSha, value))) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit Receipt changed_files do not contain every Worker fact');
    }
  } else if (
    // User authorization A8b/c (integration counterpart): the Slice Commit
    // Receipt must COVER every Worker fact file (or the file must already
    // be present in the committed HEAD tree — a declared projection like
    // tasks.md that cannot change without breaking Manifest binding);
    // extra committed files (interleaved infrastructure commits) are
    // bounded by the allowed-scope checks above.
    !workerChangedFiles.every((value) =>
      receiptChangedFiles.includes(value) || gitTreeContains(root, commitSha, value))
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Slice Commit Receipt changed_files do not contain every Worker fact');
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

export function validateIntegrationPayload(
  value: Record<string, unknown>,
  label: string,
  root: string,
  stageHasBinding: boolean,
  sliceLocalBinding?: VNextSliceLocalBindingExpectation,
): void {
  // S12-D-T04 (§8.3): the credential schema_version discrimination runs
  // BEFORE the exact-field set so a slice-local (v3) payload carrying the
  // binding fields fails with the explicit BINDING code, not as an
  // unknown-field rejection.
  const schemaMismatch = credentialSchemaVersionMismatch(
    value.schema_version,
    stageHasBinding,
    label,
  );
  if (schemaMismatch !== null) {
    // The BINDING.* code is carried in the finding message: the canonical
    // FindingCode vocabulary is a closed kernel union (§7).
    fail('RUNTIME.SCHEMA_MISMATCH', schemaMismatch.message);
  }
  // S12-D-T04 (§8.3, S12-D REPLAN): in slice-local mode the INTEGRATION_PASS
  // credential must carry the slice-local binding fields and bind the SAME
  // Manifest contract digests and recomputed execution binding; a v2
  // credential carrying binding fields is rejected (never silently ignored).
  assertSliceLocalCredentialBindingFields(value, label, sliceLocalBinding);
  assertExactFields(value, INTEGRATION_FIELDS, label);
  // S12-D repair (v3 consumer chain): `dependency_bindings` is a
  // slice-local credential field — a v2 credential must never smuggle it
  // past a v2 consumer, and a v3 credential must carry the closed
  // dependency-binding shape (kernel `validateDependencyBinding`).
  if (value.schema_version === VNEXT_CREDENTIAL_SCHEMA_VERSION_SLICE_LOCAL) {
    const rawDependencies = value.dependency_bindings;
    if (!Array.isArray(rawDependencies)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `${label}.dependency_bindings must be an array`);
    }
    for (const [index, raw] of rawDependencies.entries()) {
      try {
        validateDependencyBinding(raw);
      } catch (error) {
        fail(
          'RUNTIME.SCHEMA_MISMATCH',
          `${label}.dependency_bindings[${index}] is malformed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(value, 'dependency_bindings')) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      `${label} is a v2 credential and must not carry the slice-local field \"dependency_bindings\"`,
    );
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

function gitTreeContains(root: string, commitSha: string, filePath: string): boolean {
  try {
    const listing = gitOutput(
      root,
      ['ls-tree', '-r', '--name-only', commitSha, '--'],
      'Git HEAD tree listing',
    );
    return listing.split('\n').some((line) => line.trimEnd() === filePath);
  } catch {
    return false;
  }
}
