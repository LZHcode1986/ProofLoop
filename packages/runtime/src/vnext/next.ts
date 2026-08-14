/** vNext `next` consumer.  It never calls v1 manifest/reconcile/action code. */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeDigest,
  validateReceipt,
  validateVNextManifest,
  validateVNextSpvPassReceipt,
  validateVNextStagePlanReceipt,
  verifyReceiptChain,
  verifyReceiptDigest,
} from '@proofloop/kernel';
import type {
  Receipt,
  VNextExecutionScope,
  VNextManifest,
  VNextManifestSlice,
} from '@proofloop/kernel';
import type { Finding } from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import { readGitHead, resolveGitRoot } from '../git-source';
import { committerReceiptDir, cvReceiptDir, tasksReceiptDir } from '../receipt-layout';
import {
  assertVNextManifestReferenceBindings,
  projectVNextWorkerDispatch,
  readVNextManifest,
  VNextHandoffError,
} from './dispatch';
import type {
  VNextAdmissionAuthority,
  VNextWorkerDispatch,
} from './dispatch';
import { assertStableGitBoundary } from './admission';
import {
  assertClosedVNextCvPayload,
  assertVNextCvChainSequence,
  assertVNextCvReceiptTypeVerdict,
} from './cv-validation';
import type { VNextCvPayloadBinding } from './cv-validation';
import { VNEXT_WORKER_COMPLETION_MODES } from './types';
import type {
  VNextNextAction,
  VNextResponsibleRole,
  VNextWorkerCompletionMode,
} from './types';
// P-11 task B: read-only STAGE_CLOSE archived-facts probe.  An archived Stage
// is a historical snapshot and must never be projected for dispatch/CV.
import { readStageCloseFacts } from './stage-close-facts';
import type { StageCloseFacts } from './stage-close-facts';
// S09-REVIEW-001: the vNext next consumer applies the shared canonical Stage
// ID guard at its EARLIEST entry (before any Manifest/Authority read) so
// parked legacy labels such as S08B0/S08B fail closed before any dispatch
// projection.
import { assertCanonicalStageId } from './stage-id';

export interface VNextNextActionInput {
  readonly projectRoot: string;
  readonly stageId: string;
  readonly manifestPath?: string;
  readonly admissionPath?: string;
  readonly snapshotDigest?: string;
  readonly persistContext?: boolean;
  readonly verifyReferenceBindings?: boolean;
}

export interface VNextNextActionOutput {
  readonly action: VNextNextAction;
  readonly action_detail: string;
  readonly responsible_role: VNextResponsibleRole;
  readonly receipt_chain_valid: boolean;
  readonly stage_id: string;
  readonly slice_id?: string;
  readonly task_id?: string;
  readonly mode?: VNextWorkerCompletionMode;
  readonly context_ref?: string;
  readonly manifest_digest?: string;
  readonly plan_digest?: string;
  readonly proof_index_digest?: string;
  readonly snapshot_digest?: string;
  readonly findings: readonly Finding[];
}

/** Binding used when scanning ignored protected artifacts at an execution boundary. */
export interface VNextIgnoredProtectedPathBinding {
  readonly stageId: string;
  readonly sliceId: string;
  readonly taskId: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly snapshotDigest: string;
  readonly contextRef: string;
  /**
   * The dispatch completion mode of the current Context. Distinct dispatch
   * rounds of the same tuple (implement-task, then a recover-task recheck of
   * the already-produced evidence) legitimately persist separate
   * digest-addressed Contexts, so the duplicate-current-Context check must
   * match the mode binding too.
   */
  readonly mode: VNextWorkerCompletionMode;
}

function authorityDirectory(root: string, stageId: string): string {
  return path.join(root, '.proofloop', 'receipts', 'plan', stageId);
}

function readJsonFiles(root: string, directory: string): unknown[] {
  if (canonicalPathWithinRoot(root, directory) === null) {
    throw new VNextHandoffError('path-escape', 'vNext admission authority path escapes the project root');
  }
  try {
    if (fs.statSync(directory).isFile()) {
      const canonicalFile = canonicalPathWithinRoot(root, directory);
      if (canonicalFile === null) throw new Error('outside root');
      return [JSON.parse(readRootBoundJson(root, canonicalFile))];
    }
  } catch (error) {
    if (error instanceof VNextHandoffError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new VNextHandoffError('admission-invalid', `vNext admission authority file could not be read: ${directory}`);
    }
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const values: unknown[] = [];
  for (const name of names) {
    const file = path.join(directory, name);
    if (canonicalPathWithinRoot(root, file) === null) {
      throw new VNextHandoffError('path-escape', 'vNext admission authority file escapes the project root');
    }
    try {
      values.push(JSON.parse(readRootBoundJson(root, file)));
    } catch {
      throw new VNextHandoffError('admission-invalid', `vNext admission authority file is not valid JSON: ${name}`);
    }
  }
  return values;
}

function readRootBoundJson(root: string, file: string): string {
  const opened = openNoFollowRead(root, file);
  if (!opened.ok) {
    throw new VNextHandoffError('path-escape', `vNext admission authority file is not root-bound: ${file}`);
  }
  try {
    return fs.readFileSync(opened.fd, 'utf-8');
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** Read exactly one v2 Stage Plan + one fresh v2 SPV fact; v1 facts are rejected. */
export function readVNextAdmissionAuthority(
  root: string,
  stageId: string,
  admissionPath?: string,
): VNextAdmissionAuthority {
  const values = admissionPath
    ? readJsonFiles(root, admissionPath).map((value) => [value]).flat()
    : readJsonFiles(root, authorityDirectory(root, stageId));
  let stagePlan: VNextAdmissionAuthority['stagePlan'] | undefined;
  let spv: VNextAdmissionAuthority['spv'] | undefined;
  for (const value of values) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.version !== 2 || record.schema_version !== 2) {
      if (record.type === 'STAGE_PLAN' || record.type === 'SPV_PASS') {
        throw new VNextHandoffError('admission-invalid', 'v1 admission authority is not accepted by the vNext consumer');
      }
      continue;
    }
    if (record.type === 'STAGE_PLAN') {
      if (stagePlan !== undefined) throw new VNextHandoffError('admission-invalid', 'multiple v2 Stage Plan authorities are ambiguous');
      stagePlan = validateVNextStagePlanReceipt(record);
    } else if (record.type === 'SPV_PASS') {
      if (spv !== undefined) throw new VNextHandoffError('admission-invalid', 'multiple v2 SPV authorities are ambiguous');
      spv = validateVNextSpvPassReceipt(record);
    }
  }
  if (stagePlan === undefined || spv === undefined) {
    throw new VNextHandoffError('admission-missing', 'Stage Plan admission authority and fresh SPV authority are required');
  }
  return { stagePlan, spv };
}

interface VNextWorkerFact {
  readonly slice: VNextManifestSlice;
  readonly taskId: string;
  /** The self-digest of the persisted TASK_COMPLETE Receipt of this task. */
  readonly workerReceiptDigest: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly snapshotDigest: string;
  readonly contextRef: string;
  readonly contextDigest: string;
  readonly changedFiles: readonly string[];
  /** The persisted completion mode of the admitted Worker fact. */
  readonly mode: VNextWorkerCompletionMode;
  /** Scope permitted for the already-admitted execution dirty boundary. */
  readonly allowedScope: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function factString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new VNextHandoffError('admission-invalid', `${label} must be a non-empty string`);
  }
  return value;
}

function factStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new VNextHandoffError('admission-invalid', `${label} must be a non-empty array of strings`);
  }
  return [...value] as string[];
}

function factDigest(value: unknown, label: string, length: 40 | 64): string {
  const digest = factString(value, label);
  if (!new RegExp(`^[a-f0-9]{${length}}$`).test(digest)) {
    throw new VNextHandoffError('admission-invalid', `${label} is not a valid ${length === 40 ? 'Git' : 'SHA-256'} digest`);
  }
  return digest;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function pathWithin(value: string, base: string): boolean {
  return value === base || value.startsWith(`${base}/`);
}

function rootRelativeFactPath(root: string, value: unknown, label: string): string {
  const raw = factString(value, label);
  if (
    path.isAbsolute(raw) ||
    raw.startsWith('//') ||
    raw.includes('\\') ||
    raw.includes('\u0000')
  ) {
    throw new VNextHandoffError('path-escape', `${label} must be a canonical root-relative path`);
  }
  const parts = raw.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new VNextHandoffError('path-escape', `${label} must be a canonical root-relative path`);
  }
  const lexical = path.resolve(root, ...parts);
  const canonical = canonicalPathWithinRoot(root, lexical);
  if (canonical === null || canonical !== lexical) {
    throw new VNextHandoffError('path-escape', `${label} escapes or traverses the project root`);
  }
  return parts.join('/');
}

function taskIdsForSlice(manifest: VNextManifest, slice: VNextManifestSlice): string[] {
  return slice.proof_index.task_refs.map((refId) => {
    const descriptor = manifest.reference_index[refId];
    const match = descriptor === undefined ? undefined : /#\/entities\/([^/]+)$/.exec(descriptor.ref);
    if (descriptor?.kind !== 'task' || match?.[1] === undefined) {
      throw new VNextHandoffError(
        'task-anchor-gap',
        `Slice "${slice.slice_id}" contains an invalid vNext task anchor`,
      );
    }
    const taskId = match[1];
    if (!taskId.startsWith(`${slice.slice_id}-`)) {
      throw new VNextHandoffError(
        'task-anchor-gap',
        `Task "${taskId}" is not bound to Slice "${slice.slice_id}"`,
      );
    }
    return taskId;
  });
}

/**
 * Whether the worktree Plan projection has the given Task checkbox checked.
 *
 * This is the S08-E-T07 recover discriminator input: a checked Task whose
 * TASK_COMPLETE fact was never admitted has already-produced implementation
 * evidence (checkbox + evidence + code diff), so the next consumer must
 * re-dispatch it as `recover-task` (a consistency recheck) and never as
 * `implement-task` (which would re-implement the Task). The check reads only
 * the root-bound persisted Plan projection — never a session/progress file.
 *
 * A MISSING Plan projection carries no checkbox evidence, so the Task is
 * dispatched as `implement-task` (there is no persisted recover binding);
 * any other unreadable/redirected Plan state fails closed.
 */
function planTaskCheckboxChecked(root: string, planPath: string, taskId: string): boolean {
  const canonicalRelative = rootRelativeFactPath(root, planPath, 'Manifest.plan.ref');
  const lexical = path.resolve(root, ...canonicalRelative.split('/'));
  // A legally absent Plan projection carries no checkbox evidence, so there
  // is no persisted recover binding and the Task stays `implement-task`.
  let planExists = false;
  try {
    planExists = fs.existsSync(lexical);
  } catch {
    planExists = false;
  }
  if (!planExists) return false;
  const opened = openNoFollowRead(root, lexical);
  if (!opened.ok) {
    throw new VNextHandoffError('path-escape', 'Plan projection is unreadable or not root-bound');
  }
  let raw: string;
  try {
    raw = fs.readFileSync(opened.fd, 'utf8');
  } finally {
    fs.closeSync(opened.fd);
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*-\s*\[([ xX])\]\s+(\S+)/.exec(line);
    if (match !== null && match[2] === taskId) return match[1].toLowerCase() === 'x';
  }
  return false;
}

/**
 * Select the completion mode for the next un-admitted Task from persisted
 * facts only (S08-E-T07 §Recovery): already-checked implementation evidence
 * without an admitted TASK_COMPLETE fact is rechecked as `recover-task`;
 * otherwise the Task is dispatched as `implement-task`.
 */
function completionModeForDispatch(
  root: string,
  manifest: VNextManifest,
  taskId: string,
): VNextWorkerCompletionMode {
  return planTaskCheckboxChecked(root, manifest.plan.ref, taskId)
    ? 'recover-task'
    : 'implement-task';
}

function taskAllowedScope(
  root: string,
  manifest: VNextManifest,
  slice: VNextManifestSlice,
  taskId: string,
): string[] {
  const descriptor = Object.values(manifest.reference_index).find((candidate) =>
    candidate.kind === 'task' && candidate.ref.endsWith(`#/entities/${taskId}`),
  );
  if (descriptor === undefined) {
    throw new VNextHandoffError('task-anchor-gap', `Task descriptor for "${taskId}" is unavailable`);
  }
  const binding = manifest.task_scopes[taskId];
  if (binding === undefined || binding.task_ref !== descriptor.ref) {
    throw new VNextHandoffError('execution-scope-gap', `Task "${taskId}" has no bound execution scope`);
  }
  const scope = binding.execution_scope;
  if (
    scope.kind !== 'implementation' ||
    scope.code_paths.length === 0 ||
    scope.test_paths.length === 0
  ) {
    throw new VNextHandoffError(
      'execution-scope-gap',
      `Task "${taskId}" has no non-empty implementation code/test scope`,
    );
  }
  const codePaths = scope.code_paths.map((value, index) =>
    rootRelativeFactPath(root, value, `Task ${taskId}.execution_scope.code_paths[${index}]`),
  );
  const testPaths = scope.test_paths.map((value, index) =>
    rootRelativeFactPath(root, value, `Task ${taskId}.execution_scope.test_paths[${index}]`),
  );
  const forbiddenPaths = scope.forbidden_paths.map((value, index) =>
    rootRelativeFactPath(root, value, `Task ${taskId}.execution_scope.forbidden_paths[${index}]`),
  );
  const planPath = rootRelativeFactPath(root, manifest.plan.ref, 'Manifest.plan.ref');
  const evidencePath = rootRelativeFactPath(root, slice.evidence_path, 'Slice Evidence path');
  const protectedPaths = [
    '.proofloop/manifests',
    '.proofloop/receipts',
    '.proofloop/context',
    '.git',
  ];
  const allForbidden = unique([...forbiddenPaths, ...protectedPaths]);
  const allowed = unique([...codePaths, ...testPaths, evidencePath, planPath]);
  for (const candidate of allowed) {
    if (allForbidden.some((forbidden) => pathsOverlap(candidate, forbidden))) {
      throw new VNextHandoffError(
        'execution-scope-gap',
        `Task "${taskId}" execution scope overlaps a protected path: ${candidate}`,
      );
    }
  }
  return allowed;
}

function readRootBoundRecord(root: string, relative: string, label: string): Record<string, unknown> {
  const canonicalRelative = rootRelativeFactPath(root, relative, label);
  const opened = openNoFollowRead(root, path.resolve(root, ...canonicalRelative.split('/')));
  if (!opened.ok) {
    throw new VNextHandoffError('path-escape', `${label} is missing or not root-bound`);
  }
  try {
    const raw = fs.readFileSync(opened.fd, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new VNextHandoffError('admission-invalid', `${label} must be a JSON object`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof VNextHandoffError) throw error;
    throw new VNextHandoffError(
      'admission-invalid',
      `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    fs.closeSync(opened.fd);
  }
}

const IGNORED_PROTECTED_SCAN_PATHS = [
  '.proofloop/receipts',
  '.proofloop/manifests',
  '.proofloop/runtime',
  '.proofloop/runtime.lock',
  '.proofloop/context',
] as const;

const RUNTIME_ARTIFACT_FILES = new Set([
  'gate-result.json',
  'reconcile-input.json',
  'slice-complete-facts.json',
]);

const RUNTIME_LOCK_FIELDS = new Set([
  'runtime_version',
  'domain_schema_version',
  'risk_policy_version',
  'capability_policy_version',
  'host_adapter',
  'plugin_package',
  'plugin_version',
]);

function ignoredProtectedMismatch(message: string): never {
  throw new VNextHandoffError('execution-scope-gap', message);
}

function readIgnoredProtectedJson(root: string, relative: string, label: string): unknown {
  const canonicalRelative = rootRelativeFactPath(root, relative, label);
  const opened = openNoFollowRead(root, path.resolve(root, ...canonicalRelative.split('/')));
  if (!opened.ok) {
    throw new VNextHandoffError('path-escape', `${label} is missing or not root-bound`);
  }
  try {
    return JSON.parse(fs.readFileSync(opened.fd, 'utf8')) as unknown;
  } catch (error) {
    throw new VNextHandoffError(
      'admission-invalid',
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    fs.closeSync(opened.fd);
  }
}

function assertIgnoredRuntimeLock(root: string, relative: string): void {
  const value = readIgnoredProtectedJson(root, relative, 'ignored Runtime lock');
  if (!isRecord(value)) ignoredProtectedMismatch(`ignored Runtime lock is not a JSON object: ${relative}`);
  const unknown = Object.keys(value).filter((key) => !RUNTIME_LOCK_FIELDS.has(key));
  if (unknown.length > 0) {
    ignoredProtectedMismatch(`ignored Runtime lock contains unknown field(s): ${unknown.join(', ')}`);
  }
  if (typeof value.runtime_version !== 'string' || value.runtime_version.length === 0) {
    ignoredProtectedMismatch(`ignored Runtime lock.runtime_version is invalid: ${relative}`);
  }
  for (const field of [
    'domain_schema_version',
    'risk_policy_version',
    'capability_policy_version',
  ] as const) {
    const number = value[field];
    if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
      ignoredProtectedMismatch(`ignored Runtime lock.${field} is invalid: ${relative}`);
    }
  }
  for (const field of ['host_adapter', 'plugin_package', 'plugin_version'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      ignoredProtectedMismatch(`ignored Runtime lock.${field} is invalid: ${relative}`);
    }
  }
}

function assertIgnoredRuntimeArtifact(root: string, relative: string): void {
  const match = /^\.proofloop\/runtime\/([^/]+)\/([^/]+)$/.exec(relative);
  if (match === null || !RUNTIME_ARTIFACT_FILES.has(match[2])) {
    ignoredProtectedMismatch(`ignored protected path is not an admitted Runtime artifact: ${relative}`);
  }
  const value = readIgnoredProtectedJson(root, relative, 'ignored Runtime artifact');
  if (match[2] === 'slice-complete-facts.json') {
    if (!Array.isArray(value)) {
      ignoredProtectedMismatch(`ignored Runtime slice-complete facts must be a JSON array: ${relative}`);
    }
    return;
  }
  if (!isRecord(value)) {
    ignoredProtectedMismatch(`ignored Runtime artifact is not a JSON object: ${relative}`);
  }
  if (value.stage_id !== match[1]) {
    ignoredProtectedMismatch(`ignored Runtime artifact stage_id does not match its path: ${relative}`);
  }
}

/**
 * Scan the protected paths Git hides from normal changed-file listings.
 * Worker admission and execution next use this same allowlist so ignored
 * manifests, Contexts, Receipts, Runtime artifacts and runtime.lock cannot
 * silently bypass a boundary.
 */
export function assertIgnoredProtectedPaths(
  root: string,
  bindings: readonly VNextIgnoredProtectedPathBinding[],
): void {
  if (bindings.length === 0) return;
  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(root);
  } catch (error) {
    throw new VNextHandoffError(
      'manifest-binding',
      `Git ignored protected-path list is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let output: string;
  try {
    output = execFileSync(
      'git',
      ['-C', gitRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...IGNORED_PROTECTED_SCAN_PATHS],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    throw new VNextHandoffError('manifest-binding', 'Git ignored protected-path list is unavailable');
  }

  const stageId = bindings[0].stageId;
  const currentManifest = `.proofloop/manifests/${stageId}.json`;
  const currentStageHiddenManifestPrefix = `.proofloop/manifests/${stageId}-`;
  const allowedContextRefs = new Set(bindings.map((binding) => binding.contextRef));
  const contextPattern = /^\.proofloop\/context\/[a-f0-9]{64}\.json$/;
  const receiptPattern = /(?:^|\/)(?:[a-f0-9]{64}|vnext-(?:spv-pass|stage-plan)(?:-[A-Za-z0-9_-]+)?)\.json$/;

  for (const raw of output.split('\0').filter((entry) => entry.length > 0)) {
    const relative = rootRelativeFactPath(gitRoot, raw, 'ignored protected path');
    if (relative === currentManifest || allowedContextRefs.has(relative)) continue;
    if (relative === '.proofloop/runtime.lock') {
      assertIgnoredRuntimeLock(gitRoot, relative);
      continue;
    }
    if (relative.startsWith('.proofloop/runtime/')) {
      assertIgnoredRuntimeArtifact(gitRoot, relative);
      continue;
    }
    if (relative.startsWith('.proofloop/context/')) {
      if (!contextPattern.test(relative)) {
        ignoredProtectedMismatch(`ignored protected path is not a digest-addressed Context: ${relative}`);
      }
      const context = readIgnoredProtectedJson(gitRoot, relative, 'ignored Context');
      if (!isRecord(context)) ignoredProtectedMismatch(`ignored Context is not a JSON object: ${relative}`);
      const digest = path.posix.basename(relative, '.json');
      const withoutDigest = { ...context };
      delete withoutDigest.context_digest;
      if (
        context.schema_version !== 2 ||
        context.context_digest !== digest ||
        computeDigest(withoutDigest) !== digest
      ) {
        ignoredProtectedMismatch(`ignored protected path is not a valid Runtime Context: ${relative}`);
      }
      if (bindings.some((binding) =>
        context.stage_id === binding.stageId &&
        context.slice_id === binding.sliceId &&
        context.task_id === binding.taskId &&
        context.manifest_digest === binding.manifestDigest &&
        context.plan_digest === binding.planDigest &&
        context.snapshot_digest === binding.snapshotDigest &&
        context.mode === binding.mode
      )) {
        ignoredProtectedMismatch(`ignored protected path contains an unexpected duplicate current Context: ${relative}`);
      }
      continue;
    }
    if (relative.startsWith(`.proofloop/receipts/plan/${stageId}/`)) {
      const planAuthority = readIgnoredProtectedJson(gitRoot, relative, 'ignored vNext plan authority');
      if (
        isRecord(planAuthority) &&
        planAuthority.version === 2 &&
        planAuthority.schema_version === 2 &&
        (planAuthority.type === 'STAGE_PLAN' || planAuthority.type === 'SPV_PASS')
      ) {
        continue;
      }
    }
    if (relative.startsWith('.proofloop/receipts/') && receiptPattern.test(relative)) continue;
    if (relative.startsWith('.proofloop/manifests/')) {
      const manifest = readIgnoredProtectedJson(gitRoot, relative, 'ignored Manifest');
      if (!isRecord(manifest)) ignoredProtectedMismatch(`ignored Manifest is not a JSON object: ${relative}`);
      const isCurrentStageHiddenManifest =
        relative.startsWith(currentStageHiddenManifestPrefix) || manifest.stage_id === stageId;
      if (!isCurrentStageHiddenManifest) continue;
      try {
        const validated = validateVNextManifest(manifest);
        if (validated.stage_id !== stageId) {
          ignoredProtectedMismatch(`ignored protected path Manifest stage_id does not match the Worker Stage: ${relative}`);
        }
      } catch {
        ignoredProtectedMismatch(`ignored protected path is not a valid vNext Manifest: ${relative}`);
      }
      ignoredProtectedMismatch(`ignored protected path is not an admitted Manifest: ${relative}`);
    }
    if (relative.startsWith('.proofloop/receipts/')) {
      ignoredProtectedMismatch(`ignored protected path cannot be hidden from changed_files: ${relative}`);
    }
    ignoredProtectedMismatch(`ignored protected path cannot be hidden from changed_files: ${relative}`);
  }
}

function readVNextTaskReceipts(root: string, stageId: string, sliceId: string): Receipt[] {
  const directory = tasksReceiptDir(root, stageId, sliceId);
  if (canonicalPathWithinRoot(root, directory) === null) {
    throw new VNextHandoffError('path-escape', 'vNext Worker Receipt directory escapes the project root');
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new VNextHandoffError(
      'admission-invalid',
      `vNext Worker Receipt directory could not be read: ${directory}`,
    );
  }
  if (names.length === 0) return [];

  const chain = verifyReceiptChain(directory);
  if (!chain.valid) {
    throw new VNextHandoffError(
      'admission-invalid',
      `vNext Worker Receipt chain is invalid for ${stageId}/${sliceId}`,
    );
  }

  const receipts: Receipt[] = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const opened = openNoFollowRead(root, file);
    if (!opened.ok) {
      throw new VNextHandoffError('path-escape', `vNext Worker Receipt is not root-bound: ${name}`);
    }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
      const receipt = validateReceipt(parsed);
      if (receipt.type !== 'TASK_COMPLETE') {
        throw new VNextHandoffError(
          'admission-invalid',
          `Receipt ${name} is not a TASK_COMPLETE fact in the Worker category`,
        );
      }
      if (!verifyReceiptDigest(file)) {
        throw new VNextHandoffError('admission-invalid', `Receipt ${name} has an invalid digest`);
      }
      receipts.push(receipt);
    } catch (error) {
      if (error instanceof VNextHandoffError) throw error;
      throw new VNextHandoffError(
        'admission-invalid',
        `vNext Worker Receipt ${name} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      fs.closeSync(opened.fd);
    }
  }
  return receipts.sort((left, right) => {
    if (left.timestamp < right.timestamp) return -1;
    if (left.timestamp > right.timestamp) return 1;
    if (left.digest < right.digest) return -1;
    if (left.digest > right.digest) return 1;
    return 0;
  });
}

function assertWorkerContextBinding(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
  snapshotDigest: string,
  slice: VNextManifestSlice,
  taskId: string,
  taskScope: VNextExecutionScope,
  taskRef: string,
  proofIndexDigest: string,
  contextRef: string,
  contextDigest: string,
  mode: VNextWorkerCompletionMode,
): void {
  if (contextRef !== `.proofloop/context/${contextDigest}.json`) {
    throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE context_ref is not digest-addressed');
  }
  const context = readRootBoundRecord(root, contextRef, 'TASK_COMPLETE Context');
  if (context.schema_version !== 2 || context.context_digest !== contextDigest) {
    throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Context discriminator or digest is invalid');
  }
  const withoutDigest = { ...context };
  delete withoutDigest.context_digest;
  if (computeDigest(withoutDigest) !== contextDigest) {
    throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Context content does not match context_digest');
  }
  if (context.mode !== mode) {
    throw new VNextHandoffError(
      'manifest-binding',
      `TASK_COMPLETE Context mode binding "${String(context.mode)}" does not match the admitted Worker mode "${mode}"`,
    );
  }
  if (
    context.root_path !== root ||
    context.root_digest !== computeDigest(root) ||
    context.stage_id !== manifest.stage_id ||
    context.slice_id !== slice.slice_id ||
    context.task_id !== taskId ||
    context.task_ref !== taskRef ||
    context.manifest_digest !== manifestDigest ||
    context.plan_digest !== manifest.plan.plan_digest ||
    context.proof_index_digest !== proofIndexDigest ||
    context.snapshot_digest !== snapshotDigest
  ) {
    throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Context is not bound to the active vNext execution tuple');
  }
  if (context.evidence_path !== slice.evidence_path || context.plan_projection_path !== manifest.plan.ref) {
    throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Context artifact paths do not match the Manifest');
  }
  if (computeDigest(context.execution_scope) !== computeDigest(taskScope)) {
    throw new VNextHandoffError('execution-scope-gap', 'TASK_COMPLETE Context scope does not match the Manifest task scope');
  }
}

function readVNextWorkerFacts(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
  snapshotDigest: string,
): VNextWorkerFact[] {
  const facts: VNextWorkerFact[] = [];
  for (const slice of manifest.slices) {
    const receipts = readVNextTaskReceipts(root, manifest.stage_id, slice.slice_id);
    if (receipts.length === 0) continue;
    const taskIds = taskIdsForSlice(manifest, slice);
    const taskFacts = new Map<string, VNextWorkerFact>();
    const actionTokens = new Set<string>();
    for (const receipt of receipts) {
      if (receipt.stage_id !== manifest.stage_id || receipt.slice_id !== slice.slice_id) {
        throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Receipt stage/slice binding is invalid');
      }
      const payload = receipt.payload;
      if (!isRecord(payload) || payload.schema_version !== 2) {
        throw new VNextHandoffError(
          'admission-invalid',
          'v1 or unknown Worker Receipt facts cannot be consumed by the vNext next action',
        );
      }
      if (
        payload.outcome !== 'completed' ||
        (payload.mode !== 'implement-task' && payload.mode !== 'recover-task')
      ) {
        throw new VNextHandoffError(
          'admission-invalid',
          'TASK_COMPLETE Receipt has no admitted implement/recover completion outcome',
        );
      }
      const actionToken = factString(payload.action_token, 'TASK_COMPLETE.action_token');
      if (actionTokens.has(actionToken)) {
        throw new VNextHandoffError('admission-invalid', `multiple TASK_COMPLETE facts reuse action_token "${actionToken}"`);
      }
      actionTokens.add(actionToken);
      const taskId = factString(payload.task_id, 'TASK_COMPLETE.task_id');
      const taskIndex = taskIds.indexOf(taskId);
      if (taskIndex < 0) {
        throw new VNextHandoffError('task-anchor-gap', `TASK_COMPLETE task "${taskId}" is not in the Manifest Slice`);
      }
      if (taskFacts.has(taskId)) {
        throw new VNextHandoffError('admission-invalid', `multiple TASK_COMPLETE facts are ambiguous for task "${taskId}"`);
      }
      const taskRefDescriptor = manifest.reference_index[slice.proof_index.task_refs[taskIndex]];
      if (taskRefDescriptor === undefined) {
        throw new VNextHandoffError('task-anchor-gap', `Task descriptor for "${taskId}" is unavailable`);
      }
      const taskScopeBinding = manifest.task_scopes[taskId];
      if (taskScopeBinding === undefined || taskScopeBinding.task_ref !== taskRefDescriptor.ref) {
        throw new VNextHandoffError('execution-scope-gap', `Task "${taskId}" scope is not bound to its Manifest ref`);
      }
      const taskScope = taskScopeBinding.execution_scope;
      const proofIndexDigest = computeDigest(slice.proof_index);
      const currentManifestDigest = factDigest(payload.manifest_digest, 'TASK_COMPLETE.manifest_digest', 64);
      const planDigest = factDigest(payload.plan_digest, 'TASK_COMPLETE.plan_digest', 64);
      const currentProofIndexDigest = factDigest(payload.proof_index_digest, 'TASK_COMPLETE.proof_index_digest', 64);
      const currentSnapshotDigest = factDigest(payload.snapshot_digest, 'TASK_COMPLETE.snapshot_digest', 40);
      if (
        currentManifestDigest !== manifestDigest ||
        planDigest !== manifest.plan.plan_digest ||
        currentProofIndexDigest !== proofIndexDigest
      ) {
        throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Receipt is stale or not bound to the active Manifest/Plan');
      }
      // A Worker fact produced during execution binds the admitted snapshot
      // (or a legal descendant execution commit). It must stay on the
      // admission snapshot's Git chain; an unrelated/reverted snapshot fails
      // closed without discarding the already-admitted execution facts.
      assertReceiptSnapshotOnExecutionChain(root, currentSnapshotDigest, snapshotDigest, 'TASK_COMPLETE Receipt');
      const contextRef = factString(payload.context_ref, 'TASK_COMPLETE.context_ref');
      const contextDigest = factDigest(payload.context_digest, 'TASK_COMPLETE.context_digest', 64);
      const payloadMode = factString(payload.mode, 'TASK_COMPLETE.mode');
      if (payloadMode !== 'implement-task' && payloadMode !== 'recover-task') {
        throw new VNextHandoffError(
          'admission-invalid',
          `TASK_COMPLETE payload mode "${payloadMode}" is outside the closed completion vocabulary`,
        );
      }
      assertWorkerContextBinding(
        root,
        manifest,
        manifestDigest,
        currentSnapshotDigest,
        slice,
        taskId,
        taskScope,
        taskRefDescriptor.ref,
        proofIndexDigest,
        contextRef,
        contextDigest,
        payloadMode,
      );
      if (payload.evidence_ref !== slice.evidence_path) {
        throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE evidence_ref is not bound to the Manifest Slice');
      }
      const changedFiles = unique(
        factStringArray(payload.changed_files, 'TASK_COMPLETE.changed_files').map((value, index) =>
          rootRelativeFactPath(root, value, `TASK_COMPLETE.changed_files[${index}]`),
        ),
      );
      if (changedFiles.length === 0) {
        throw new VNextHandoffError('execution-scope-gap', 'TASK_COMPLETE.changed_files cannot be empty');
      }
      const changedFileSet = new Set(changedFiles);
      for (const requiredPath of [slice.evidence_path, manifest.plan.ref]) {
        const canonicalRequiredPath = rootRelativeFactPath(root, requiredPath, 'Manifest execution projection path');
        if (!changedFileSet.has(canonicalRequiredPath)) {
          throw new VNextHandoffError(
            'execution-scope-gap',
            `TASK_COMPLETE.changed_files must include the admitted execution projection path: ${canonicalRequiredPath}`,
          );
        }
      }
      const priorScope = taskIds
        .slice(0, taskIndex)
        .flatMap((priorTaskId) => taskAllowedScope(root, manifest, slice, priorTaskId));
      const allowedScope = unique([
        ...priorScope,
        ...taskAllowedScope(root, manifest, slice, taskId),
      ]);
      const forbidden = ['.proofloop/manifests', '.proofloop/receipts', '.proofloop/context', '.git'];
      for (const changed of changedFiles) {
        if (forbidden.some((base) => pathsOverlap(changed, base)) || !allowedScope.some((base) => pathWithin(changed, base))) {
          throw new VNextHandoffError('execution-scope-gap', `TASK_COMPLETE.changed_files expands beyond the admitted execution scope: ${changed}`);
        }
      }
      const fact: VNextWorkerFact = {
        slice,
        taskId,
        workerReceiptDigest: receipt.digest,
        manifestDigest: currentManifestDigest,
        planDigest,
        proofIndexDigest: currentProofIndexDigest,
        snapshotDigest: currentSnapshotDigest,
        contextRef,
        contextDigest,
        changedFiles,
        mode: payloadMode,
        allowedScope,
      };
      taskFacts.set(taskId, fact);
    }
    let gap = false;
    for (const taskId of taskIds) {
      if (!taskFacts.has(taskId)) gap = true;
      else if (gap) {
        throw new VNextHandoffError('task-anchor-gap', 'TASK_COMPLETE facts skip an earlier Manifest task');
      }
    }
    facts.push(...taskIds.flatMap((taskId) => {
      const fact = taskFacts.get(taskId);
      return fact === undefined ? [] : [fact];
    }));
  }
  return facts;
}

interface VNextCvReceiptFacts {
  /** The CV chain tip Receipt, or null when no CV Receipt exists for the Slice. */
  readonly tip: Receipt | null;
  /** Whether the persisted CV history contains a CV_REPAIR fact. */
  readonly hasRepairHistory: boolean;
}

/**
 * Read the persisted vNext CV Receipt chain of one Slice with the same
 * root-bound rigor as the Worker chain: chain links, self-digests, receipt
 * category, stage/slice binding AND the closed v2 CV_RESULT payload shape
 * (S08-REVIEW-005) are verified; a corrupt or non-closed CV chain fails
 * closed. The SLICE_COMMIT semantic bindings consume exactly two facts from
 * it: the chain tip (the latest CV receipt must be a CV_PASS the commit binds)
 * and whether a CV_REPAIR fact exists (REPAIR history legitimizes repair-only
 * changed files in the committed boundary).
 */
function readVNextCvReceiptFacts(
  root: string,
  stageId: string,
  sliceId: string,
  binding: VNextCvPayloadBinding,
  admittedSnapshot: string,
): VNextCvReceiptFacts {
  const directory = cvReceiptDir(root, stageId, sliceId);
  if (canonicalPathWithinRoot(root, directory) === null) {
    throw new VNextHandoffError('path-escape', 'vNext CV Receipt directory escapes the project root');
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tip: null, hasRepairHistory: false };
    throw new VNextHandoffError(
      'admission-invalid',
      `vNext CV Receipt directory could not be read: ${directory}`,
    );
  }
  if (names.length === 0) return { tip: null, hasRepairHistory: false };

  const chain = verifyReceiptChain(directory);
  if (!chain.valid) {
    throw new VNextHandoffError(
      'admission-invalid',
      `vNext CV Receipt chain is invalid for ${stageId}/${sliceId}`,
    );
  }
  const receipts: Receipt[] = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const opened = openNoFollowRead(root, file);
    if (!opened.ok) {
      throw new VNextHandoffError('path-escape', `vNext CV Receipt is not root-bound: ${name}`);
    }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
      const receipt = validateReceipt(parsed);
      if (receipt.type !== 'CV_PASS' && receipt.type !== 'CV_REPAIR') {
        throw new VNextHandoffError(
          'admission-invalid',
          `Receipt ${name} is not a CV_PASS/CV_REPAIR fact in the CV category`,
        );
      }
      if (!verifyReceiptDigest(file)) {
        throw new VNextHandoffError('admission-invalid', `Receipt ${name} has an invalid digest`);
      }
      if (receipt.stage_id !== stageId || receipt.slice_id !== sliceId) {
        throw new VNextHandoffError('manifest-binding', 'vNext CV Receipt stage/slice binding is invalid');
      }
      // S08-REVIEW-005/006: a self-digest-correct CV Receipt whose payload is
      // not the closed v2 CV_RESULT fact (vocabulary, tuple bindings, or the
      // full branch/context/refs field set), whose outer type contradicts the
      // payload verdict, or whose chain position is illegal, must never
      // become the CV tip a SLICE_COMMIT binds; the CV snapshot must also
      // stay on the admitted execution Git chain like every other execution
      // fact.
      assertVNextCvReceiptTypeVerdict(receipt.type, receipt.payload);
      assertClosedVNextCvPayload(receipt.payload, binding);
      const cvSnapshot = factDigest(receipt.payload.snapshot_digest, 'CV_RESULT.snapshot_digest', 40);
      assertReceiptSnapshotOnExecutionChain(root, cvSnapshot, admittedSnapshot, 'CV_RESULT');
      receipts.push(receipt);
    } catch (error) {
      if (error instanceof VNextHandoffError) throw error;
      throw new VNextHandoffError(
        'admission-invalid',
        `vNext CV Receipt ${name} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      fs.closeSync(opened.fd);
    }
  }
  const referenced = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.previous_digest !== undefined && receipt.previous_digest !== '') {
      referenced.add(receipt.previous_digest);
    }
  }
  // A real CV chain is a single linked Receipt chain (the admission contract
  // rejects any other topology). Multiple genesis receipts or a fork would
  // make the "latest CV_PASS tip" ambiguous, so they fail closed.
  const genesis = receipts.filter(
    (receipt) => receipt.previous_digest === undefined || receipt.previous_digest === '',
  );
  if (genesis.length !== 1) {
    throw new VNextHandoffError(
      'admission-invalid',
      `vNext CV Receipt chain for ${stageId}/${sliceId} must contain exactly one chain genesis`,
    );
  }
  const referencedBy = new Map<string, string>();
  for (const receipt of receipts) {
    if (receipt.previous_digest !== undefined && receipt.previous_digest !== '') {
      const prior = referencedBy.get(receipt.previous_digest);
      if (prior !== undefined) {
        throw new VNextHandoffError(
          'admission-invalid',
          `vNext CV Receipt chain for ${stageId}/${sliceId} contains a fork at predecessor ${receipt.previous_digest}`,
        );
      }
      referencedBy.set(receipt.previous_digest, receipt.digest);
    }
  }
  // Reconstruct the Receipts in chain order (genesis → … → tip): receipt
  // file names are digest-addressed, so directory order is NOT the CV chain
  // order. The sequence validation must run on the linked chain order.
  const chainOrder: Receipt[] = [];
  {
    const byDigest = new Map(receipts.map((receipt) => [receipt.digest, receipt] as const));
    let cursor: Receipt | undefined = genesis[0];
    while (cursor !== undefined) {
      chainOrder.push(cursor);
      const nextDigest = referencedBy.get(cursor.digest);
      cursor = nextDigest === undefined ? undefined : byDigest.get(nextDigest);
    }
  }
  // S08-REVIEW-006: the persisted CV history must be a legal
  // initial → REPAIR → recheck chain (a second initial, a recheck without a
  // preceding CV_REPAIR, a diverged previous_failure_signature, or any
  // continuation after a CV_PASS fails closed).
  assertVNextCvChainSequence(chainOrder);
  const tip = receipts.find((receipt) => !referenced.has(receipt.digest));
  if (tip === undefined) {
    throw new VNextHandoffError(
      'admission-invalid',
      `vNext CV Receipt chain for ${stageId}/${sliceId} has no resolvable chain tip`,
    );
  }
  return {
    tip,
    hasRepairHistory: receipts.some((receipt) => receipt.type === 'CV_REPAIR'),
  };
}

/**
 * Read the set of Manifest Slices whose execution chain is already closed by
 * an admitted vNext SLICE_COMMIT fact. A committed Slice must never be
 * re-projected for Worker dispatch or CV; the next consumer advances past it
 * to the next dependency-ready Slice.
 *
 * The committer category chain is validated like the Worker chain: every
 * Receipt must be a closed vNext SLICE_COMMIT fact bound to the active
 * Manifest/Plan tuple and to the admission snapshot's Git chain. In addition
 * (S08-REVIEW-004) the Receipt's semantic bindings are revalidated against
 * the persisted facts it claims — proof_index_digest, commit_sha on the Git
 * execution chain, cv_receipt_digest equal to the Slice's latest CV_PASS tip,
 * changed_files agreeing with the Worker fact union (with the REPAIR-history
 * exemption), and receipt_chain_valid. A legacy, malformed, or semantically
 * incomplete committer fact fails closed instead of being guessed around.
 */
function readVNextCommittedSliceIds(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
  planDigest: string,
  admittedSnapshot: string,
  workerFacts: readonly VNextWorkerFact[],
): Set<string> {
  const committed = new Set<string>();
  for (const slice of manifest.slices) {
    const directory = committerReceiptDir(root, manifest.stage_id, slice.slice_id);
    if (canonicalPathWithinRoot(root, directory) === null) {
      throw new VNextHandoffError('path-escape', 'vNext Slice Commit Receipt directory escapes the project root');
    }
    let names: string[];
    try {
      names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new VNextHandoffError(
        'admission-invalid',
        `vNext Slice Commit Receipt directory could not be read: ${directory}`,
      );
    }
    if (names.length === 0) continue;

    const chain = verifyReceiptChain(directory);
    if (!chain.valid) {
      throw new VNextHandoffError(
        'admission-invalid',
        `vNext Slice Commit Receipt chain is invalid for ${manifest.stage_id}/${slice.slice_id}`,
      );
    }
    for (const name of names) {
      const file = path.join(directory, name);
      const opened = openNoFollowRead(root, file);
      if (!opened.ok) {
        throw new VNextHandoffError('path-escape', `vNext Slice Commit Receipt is not root-bound: ${name}`);
      }
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
        const receipt = validateReceipt(parsed);
        if (receipt.type !== 'SLICE_COMMIT') {
          throw new VNextHandoffError(
            'admission-invalid',
            `Receipt ${name} is not a SLICE_COMMIT fact in the committer category`,
          );
        }
        if (!verifyReceiptDigest(file)) {
          throw new VNextHandoffError('admission-invalid', `Receipt ${name} has an invalid digest`);
        }
        if (receipt.stage_id !== manifest.stage_id || receipt.slice_id !== slice.slice_id) {
          throw new VNextHandoffError('manifest-binding', 'SLICE_COMMIT Receipt stage/slice binding is invalid');
        }
        const payload = receipt.payload;
        if (!isRecord(payload) || payload.schema_version !== 2) {
          throw new VNextHandoffError(
            'admission-invalid',
            'v1 or unknown Slice Commit facts cannot be consumed by the vNext next action',
          );
        }
        if (payload.type !== 'SLICE_COMMIT_RESULT' || payload.action !== 'SLICE_COMMIT') {
          throw new VNextHandoffError(
            'admission-invalid',
            'Slice Commit Receipt is not the closed vNext SLICE_COMMIT_RESULT fact',
          );
        }
        if (payload.manifest_digest !== manifestDigest || payload.plan_digest !== planDigest) {
          throw new VNextHandoffError('manifest-binding', 'SLICE_COMMIT Receipt is stale or not bound to the active Manifest/Plan');
        }
        const commitSnapshot = factDigest(payload.snapshot_digest, 'SLICE_COMMIT.snapshot_digest', 40);
        assertReceiptSnapshotOnExecutionChain(root, commitSnapshot, admittedSnapshot, 'SLICE_COMMIT');
        // ── Semantic bindings (S08-REVIEW-004): a self-digest-correct but
        // semantically incomplete SLICE_COMMIT record must never project the
        // Slice as committed. Every binding is revalidated against persisted
        // facts (Manifest Proof Index, Git execution chain, CV chain tip,
        // Worker changed-file union).
        if (payload.receipt_chain_valid !== true) {
          throw new VNextHandoffError(
            'admission-invalid',
            'SLICE_COMMIT Receipt does not assert a valid vNext Receipt chain',
          );
        }
        const proofIndexDigest = factDigest(payload.proof_index_digest, 'SLICE_COMMIT.proof_index_digest', 64);
        if (proofIndexDigest !== computeDigest(slice.proof_index)) {
          throw new VNextHandoffError(
            'manifest-binding',
            'SLICE_COMMIT Receipt proof_index_digest does not equal the current Proof Index digest',
          );
        }
        // commit_sha must be a real Git boundary on the admitted execution
        // chain (the admitted snapshot itself or a Git descendant of it) AND
        // on the current branch (the current Git HEAD or an ancestor of it);
        // a foreign, reverted, side-branch, or non-existent commit fails
        // closed.
        const commitSha = factDigest(payload.commit_sha, 'SLICE_COMMIT.commit_sha', 40);
        assertReceiptSnapshotOnExecutionChain(root, commitSha, admittedSnapshot, 'SLICE_COMMIT.commit_sha');
        assertCommitOnCurrentHead(root, commitSha, 'SLICE_COMMIT.commit_sha');
        // The declared changed_files must agree with the persisted Worker
        // facts of the Slice: an exact match without a REPAIR history, and a
        // coverage check (every Worker fact file present, repair-only files
        // allowed) when the CV history contains a CV_REPAIR fact.
        const sliceWorkerFacts = workerFacts.filter((fact) => fact.slice.slice_id === slice.slice_id);
        if (sliceWorkerFacts.length === 0) {
          throw new VNextHandoffError(
            'admission-invalid',
            `SLICE_COMMIT Receipt has no persisted vNext Worker facts for ${manifest.stage_id}/${slice.slice_id}`,
          );
        }
        // S08-REVIEW-005: a committed Slice must be backed by a TASK_COMPLETE
        // fact for EVERY Manifest task. A strict subset of completed tasks
        // (e.g. only the first tasks admitted) must never project the Slice
        // as committed, even when the CV chain and the changed_files of the
        // completed subset look consistent.
        const sliceTaskIds = taskIdsForSlice(manifest, slice);
        for (const taskId of sliceTaskIds) {
          if (!sliceWorkerFacts.some((fact) => fact.taskId === taskId)) {
            throw new VNextHandoffError(
              'admission-invalid',
              `SLICE_COMMIT Receipt is not backed by TASK_COMPLETE facts for every Manifest task of ${manifest.stage_id}/${slice.slice_id}; missing ${taskId}`,
            );
          }
        }
        // The CV tip binding includes the closed v2 CV_RESULT payload check
        // and the Worker chain tip: the CV payload's worker_receipt_digest
        // must equal the digest of the latest TASK_COMPLETE Receipt of the
        // Slice (taskIdsForSlice order is the Worker chain order).
        const lastTaskId = sliceTaskIds[sliceTaskIds.length - 1];
        const workerTipFact = sliceWorkerFacts.find((fact) => fact.taskId === lastTaskId);
        if (workerTipFact === undefined || workerTipFact.workerReceiptDigest === undefined) {
          throw new VNextHandoffError(
            'admission-invalid',
            `SLICE_COMMIT Receipt cannot resolve the Worker chain tip for ${manifest.stage_id}/${slice.slice_id}`,
          );
        }
        const workerTipDigest = workerTipFact.workerReceiptDigest;
        // S08-REVIEW-007: the shared CV validator is bound to the persisted
        // Manifest/Worker facts — the EXACT Manifest Slice Proof Index
        // reference sets and the digest of the final Worker Context — so a
        // self-digest-correct CV chain that diverges from the Proof Index or
        // binds a nonexistent/earlier Context can never back a SLICE_COMMIT.
        const cvFacts = readVNextCvReceiptFacts(
          root,
          manifest.stage_id,
          slice.slice_id,
          {
            stageId: manifest.stage_id,
            sliceId: slice.slice_id,
            manifestDigest,
            planDigest,
            proofIndexDigest: computeDigest(slice.proof_index),
            workerTipDigest,
            expectedAcceptanceRefs: slice.proof_index.acceptance_refs,
            expectedSeamRefs: slice.proof_index.seam_refs,
            expectedOracleRefs: slice.proof_index.oracle_refs,
            expectedRiskRefs: slice.proof_index.risk_refs.map((risk) => risk.ref_id),
            expectedContextDigest: workerTipFact.contextDigest,
          },
          admittedSnapshot,
        );
        if (cvFacts.tip === null || cvFacts.tip.type !== 'CV_PASS') {
          throw new VNextHandoffError(
            'admission-invalid',
            `SLICE_COMMIT Receipt is not backed by a persisted CV_PASS tip for ${manifest.stage_id}/${slice.slice_id}`,
          );
        }
        const cvReceiptDigest = factDigest(payload.cv_receipt_digest, 'SLICE_COMMIT.cv_receipt_digest', 64);
        if (cvReceiptDigest !== cvFacts.tip.digest) {
          throw new VNextHandoffError(
            'manifest-binding',
            'SLICE_COMMIT Receipt is not bound to the latest vNext CV_PASS Receipt',
          );
        }
        const workerChangedFiles = unique(
          sliceWorkerFacts.flatMap((fact) => fact.changedFiles),
        ).sort();
        const receiptChangedFiles = unique(
          factStringArray(payload.changed_files, 'SLICE_COMMIT.changed_files').map((value, index) =>
            rootRelativeFactPath(root, value, `SLICE_COMMIT.changed_files[${index}]`),
          ),
        ).sort();
        if (receiptChangedFiles.length === 0) {
          throw new VNextHandoffError('execution-scope-gap', 'SLICE_COMMIT.changed_files cannot be empty');
        }
        // Repair-only files (REPAIR → recheck) must still stay inside the
        // Manifest-declared Slice execution scope; protected paths are never
        // admissible changed files.
        const sliceAllowedScope = unique(
          taskIdsForSlice(manifest, slice).flatMap((taskId) =>
            taskAllowedScope(root, manifest, slice, taskId),
          ),
        );
        const sliceForbiddenScope = [
          '.proofloop/manifests',
          '.proofloop/receipts',
          '.proofloop/context',
          '.git',
        ];
        for (const changed of receiptChangedFiles) {
          if (
            sliceForbiddenScope.some((base) => pathsOverlap(changed, base)) ||
            !sliceAllowedScope.some((base) => pathWithin(changed, base))
          ) {
            throw new VNextHandoffError(
              'execution-scope-gap',
              `SLICE_COMMIT.changed_files expands beyond the admitted Slice execution scope: ${changed}`,
            );
          }
        }
        if (cvFacts.hasRepairHistory) {
          if (!workerChangedFiles.every((value) => receiptChangedFiles.includes(value))) {
            throw new VNextHandoffError(
              'admission-invalid',
              'SLICE_COMMIT Receipt changed_files do not contain every persisted Worker fact',
            );
          }
        } else if (
          receiptChangedFiles.length !== workerChangedFiles.length ||
          receiptChangedFiles.some((value, index) => value !== workerChangedFiles[index])
        ) {
          throw new VNextHandoffError(
            'admission-invalid',
            'SLICE_COMMIT Receipt changed_files do not match all Worker facts',
          );
        }
        // S08-REVIEW-005: the commit_sha boundary must be cross-validated
        // against the real Git file set of parent..commit. The declared
        // changed_files must EXACTLY equal the actual commit diff: a commit
        // carrying undeclared files (e.g. out-of-scope or foreign content) or
        // missing declared files (e.g. a reverted Worker change) fails closed.
        const commitDiffFiles = gitCommitChangedPaths(root, commitSha);
        if (
          commitDiffFiles.length !== receiptChangedFiles.length ||
          commitDiffFiles.some((value, index) => value !== receiptChangedFiles[index])
        ) {
          throw new VNextHandoffError(
            'admission-invalid',
            `SLICE_COMMIT Receipt commit_sha diff does not exactly match the declared changed_files for ${manifest.stage_id}/${slice.slice_id}`,
          );
        }
      } catch (error) {
        if (error instanceof VNextHandoffError) throw error;
        throw new VNextHandoffError(
          'admission-invalid',
          `vNext Slice Commit Receipt ${name} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        fs.closeSync(opened.fd);
      }
    }
    committed.add(slice.slice_id);
  }
  return committed;
}

function gitChangedPaths(root: string): string[] {
  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(root);
  } catch (error) {
    throw new VNextHandoffError('manifest-binding', `Git root is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const run = (args: readonly string[]): string[] => {
    try {
      const output = execFileSync('git', ['-C', gitRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return output.split('\0').filter((entry) => entry.length > 0);
    } catch (error) {
      throw new VNextHandoffError('manifest-binding', `Git changed-file scope is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return unique([
    ...run(['diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB', 'HEAD', '--']),
    ...run(['ls-files', '--others', '--exclude-standard', '-z']),
  ]).map((value, index) => rootRelativeFactPath(gitRoot, value, `Git changed path[${index}]`));
}

/**
 * The root-relative, sorted, unique file set of the real Git boundary
 * `parent..commit` (`git diff --name-only <commit>^ <commit>`).
 *
 * Used by the S08-REVIEW-005 SLICE_COMMIT cross-validation: the declared
 * changed_files must exactly equal the actual file set of the commit_sha
 * boundary. A commit without a parent (root commit) cannot resolve `commit^`
 * and fails closed, which is safe because a legal SLICE_COMMIT always declares
 * non-empty changed_files while a root commit carries no diff.
 */
function gitCommitChangedPaths(root: string, commit: string): string[] {
  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(root);
  } catch (error) {
    throw new VNextHandoffError(
      'manifest-binding',
      `Git root is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let output: string;
  try {
    output = execFileSync(
      'git',
      ['-C', gitRoot, 'diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB', `${commit}^`, commit, '--'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    throw new VNextHandoffError(
      'manifest-binding',
      `SLICE_COMMIT commit diff is unavailable for ${commit}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return unique(
    output
      .split('\0')
      .filter((entry) => entry.length > 0)
      .map((value, index) => rootRelativeFactPath(gitRoot, value, `commit diff path[${index}]`)),
  ).sort();
}

/**
 * Assert that `candidate` is the admitted execution snapshot itself or a Git
 * descendant of it (`git merge-base --is-ancestor <admitted> <candidate>`).
 *
 * Slice Commit is a normal execution Git boundary: it legitimately advances
 * HEAD — and may advance later execution facts — to a descendant of the
 * admission snapshot. Only a candidate that is neither the snapshot nor one
 * of its descendants (reset, rebase, revert, or an unrelated commit) is a
 * stale/foreign execution snapshot and fails closed; an unavailable Git
 * boundary also fails closed.
 */
function assertExecutionSnapshotChain(
  gitRoot: string,
  candidate: string,
  admittedSnapshot: string,
  label: string,
): void {
  if (candidate === admittedSnapshot) return;
  try {
    execFileSync(
      'git',
      ['-C', gitRoot, 'merge-base', '--is-ancestor', admittedSnapshot, candidate],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
  } catch {
    throw new VNextHandoffError(
      'manifest-binding',
      `${label} snapshot_digest is not the admitted snapshot or a Git descendant of it: ${candidate} != ${admittedSnapshot}`,
    );
  }
}

/**
 * Root-bound variant of {@link assertExecutionSnapshotChain} used while
 * reading persisted execution facts, where the Git root has not been
 * resolved yet.
 */
function assertReceiptSnapshotOnExecutionChain(
  root: string,
  candidate: string,
  admittedSnapshot: string,
  label: string,
): void {
  if (candidate === admittedSnapshot) return;
  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(root);
  } catch (error) {
    throw new VNextHandoffError(
      'manifest-binding',
      `Git snapshot chain is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  assertExecutionSnapshotChain(gitRoot, candidate, admittedSnapshot, label);
}

/**
 * S08-REVIEW-006: `commit` must be the current Git HEAD or an ancestor of it
 * (`git merge-base --is-ancestor <commit> <HEAD>`), the same ancestry
 * contract Integration admission applies to each Slice's integrated commit
 * (integration-admission.ts assertCommittedChangedFiles). A side-branch
 * commit that carries the exact Slice diff but never entered the current
 * execution branch fails closed: the Slice output was not integrated into
 * the active branch, so the dependent Slice must not be dispatched from it.
 * An unavailable Git boundary also fails closed.
 */
function assertCommitOnCurrentHead(root: string, commit: string, label: string): void {
  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(root);
  } catch (error) {
    throw new VNextHandoffError(
      'manifest-binding',
      `Git HEAD ancestry is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const head = readGitHead(gitRoot);
  if (head === commit) return;
  try {
    execFileSync(
      'git',
      ['-C', gitRoot, 'merge-base', '--is-ancestor', commit, head],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
  } catch {
    throw new VNextHandoffError(
      'manifest-binding',
      `${label} is not the current Git HEAD or an ancestor of it: ${commit} != ${head}`,
    );
  }
}

/**
 * After a Worker fact exists, permit only dirty paths covered by the
 * previously admitted task scopes. This is deliberately separate from the
 * strict planning clean boundary used by Stage Plan admission.
 *
 * The admitted execution snapshot is the Git boundary at admission time.
 * Slice Commit is a normal execution Git boundary that legitimately advances
 * HEAD to a descendant of that snapshot, so the HEAD check accepts the
 * snapshot itself or any Git descendant; a reset/rebase/reverted/unrelated
 * HEAD fails closed.
 */
function assertExecutionDirtyBoundary(
  root: string,
  snapshotDigest: string,
  allowedScope: readonly string[],
): string {
  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(root);
  } catch (error) {
    throw new VNextHandoffError('manifest-binding', `Git root is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const head = readGitHead(gitRoot);
  assertExecutionSnapshotChain(gitRoot, head, snapshotDigest, 'execution');
  const forbidden = ['.proofloop/manifests', '.proofloop/receipts', '.proofloop/context', '.git'];
  for (const changed of gitChangedPaths(gitRoot)) {
    if (
      forbidden.some((base) => pathsOverlap(changed, base)) ||
      !allowedScope.some((base) => pathWithin(changed, base))
    ) {
      throw new VNextHandoffError(
        'execution-scope-gap',
        `execution dirty path is outside the admitted Worker scope: ${changed}`,
      );
    }
  }
  return head;
}

/** Persist only the generated, digest-addressed Context projection. */
export function persistVNextWorkerContext(root: string, dispatch: VNextWorkerDispatch): void {
  const target = path.join(root, dispatch.context_ref);
  const canonical = canonicalPathWithinRoot(root, target);
  if (canonical === null) throw new VNextHandoffError("path-escape", "ContextRef escapes the project root");
  const context = dispatch.context;
  const digest = context.context_digest;
  const withoutDigest = { ...context } as Record<string, unknown>;
  delete withoutDigest.context_digest;
  if (dispatch.context_ref !== ".proofloop/context/" + digest + ".json" || computeDigest(withoutDigest) !== digest) throw new VNextHandoffError("manifest-binding", "ContextRef is not bound to the generated Context digest");
  const payload = JSON.stringify(context, null, 2) + "\n";
  try {
    fs.lstatSync(canonical);
    const opened = openNoFollowRead(root, canonical);
    if (!opened.ok) throw new VNextHandoffError("manifest-binding", "existing ContextRef is not a regular root bound file");
    let actual: string;
    try { actual = fs.readFileSync(opened.fd, "utf8"); } finally { fs.closeSync(opened.fd); }
    if (actual !== payload) throw new VNextHandoffError("manifest-binding", "existing ContextRef content does not match its digest");
    return;
  } catch (error) {
    if (error instanceof VNextHandoffError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new VNextHandoffError("manifest-binding", "ContextRef cannot be inspected");
  }
  const parent = canonicalPathWithinRoot(root, path.dirname(canonical));
  if (parent === null) throw new VNextHandoffError("path-escape", "ContextRef parent escapes the project root");
  fs.mkdirSync(parent, { recursive: true });
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(canonical, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const opened = openNoFollowRead(root, canonical);
      if (!opened.ok) throw new VNextHandoffError("manifest-binding", "ContextRef race target is not a regular root bound file");
      let actual: string;
      try { actual = fs.readFileSync(opened.fd, "utf8"); } finally { fs.closeSync(opened.fd); }
      if (actual !== payload) throw new VNextHandoffError("manifest-binding", "existing ContextRef content does not match its digest");
      return;
    }
    throw new VNextHandoffError("manifest-binding", "ContextRef could not be persisted write once: " + (error instanceof Error ? error.message : String(error)));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function detectVNextManifestDiscriminator(root: string, manifestPath: string): boolean {
  const canonical = canonicalPathWithinRoot(root, manifestPath);
  if (canonical === null) return false;
  const opened = openNoFollowRead(root, canonical);
  if (!opened.ok) return false;
  let raw: string;
  try { raw = fs.readFileSync(opened.fd, "utf8"); } finally { fs.closeSync(opened.fd); }
  if (/[" ]version[" ]*:[ ]*2/.test(raw) || /[" ]schema_version[" ]*:[ ]*2/.test(raw)) return true;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const plan = parsed.plan as Record<string, unknown> | undefined;
    return parsed.version === 2 || plan?.schema_version === 2;
  } catch { return false; }
}

function failureOutput(stageId: string, error: unknown): VNextNextActionOutput {
  const message = error instanceof Error ? error.message : String(error);
  return {
    action: 'VALIDATE',
    action_detail: `VALIDATE — vNext dispatch is blocked: ${message}`,
    responsible_role: 'executor',
    receipt_chain_valid: false,
    stage_id: stageId,
    findings: [{ code: 'RUNTIME.SCHEMA_MISMATCH', severity: 'error', message }],
  };
}

/**
 * P-11 task B: archived-Stage next projection.  A Stage with a legal v2
 * STAGE_CLOSE_RESULT envelope is a historical snapshot — the next consumer
 * must never project DISPATCH_WORKER / RUN_CV / any further execution for
 * it.  The closed VNEXT_NEXT_ACTIONS vocabulary stays unchanged (no ARCHIVED
 * member): the archived state is reported as bounded VALIDATE with an
 * explicit `STAGE.ARCHIVED` finding.
 */
function archivedOutput(stageId: string, closeFacts: StageCloseFacts): VNextNextActionOutput {
  const closeType = closeFacts.close_type !== undefined ? `, close_type=${closeFacts.close_type}` : '';
  const digest = closeFacts.receipt_digest !== undefined ? ` (receipt ${closeFacts.receipt_digest})` : '';
  return {
    action: 'VALIDATE',
    action_detail: `VALIDATE — stage ${stageId} is archived (STAGE_CLOSE${closeType}${digest}); no dispatch/CV projection is possible for an archived stage`,
    responsible_role: 'executor',
    receipt_chain_valid: false,
    stage_id: stageId,
    findings: [
      {
        // The kernel FindingCode vocabulary is a closed 9-value set (kernel
        // is out of P-11 task B scope), so the archived state is reported
        // under the closest closed transition code with an explicit message.
        code: 'DOMAIN.INVALID_TRANSITION',
        severity: 'error',
        message: `stage "${stageId}" is archived (STAGE_CLOSE${closeType}${digest}); the Stage is a historical snapshot and is never dispatched`,
      },
    ],
  };
}

function assertActiveVNextAuthority(
  authority: VNextAdmissionAuthority,
  stageId: string,
  manifestDigest: string,
  planDigest: string,
  snapshotDigest: string,
): void {
  if (!/^[a-f0-9]{40}$/.test(snapshotDigest)) {
    throw new VNextHandoffError(
      'snapshot-binding',
      'admitted snapshot_digest must be a canonical Git HEAD digest',
    );
  }
  let stagePlan: VNextAdmissionAuthority['stagePlan'];
  let spv: VNextAdmissionAuthority['spv'];
  try {
    stagePlan = validateVNextStagePlanReceipt(authority.stagePlan);
    spv = validateVNextSpvPassReceipt(authority.spv);
  } catch (error) {
    throw new VNextHandoffError(
      'admission-invalid',
      `vNext admission authority is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const matches = (fact: {
    stage_id: string;
    manifest_digest: string;
    plan_digest: string;
    snapshot_digest: string;
  }): boolean =>
    fact.stage_id === stageId &&
    fact.manifest_digest === manifestDigest &&
    fact.plan_digest === planDigest &&
    fact.snapshot_digest === snapshotDigest;
  if (!matches(stagePlan) || !matches(spv) || stagePlan.spv_receipt_digest !== spv.digest) {
    throw new VNextHandoffError(
      'admission-invalid',
      'Stage Plan admission, fresh SPV, Manifest, Plan, and snapshot digests do not bind',
    );
  }
}

function runCvOutput(
  input: VNextNextActionInput,
  slice: VNextManifestSlice,
  manifestDigest: string,
  planDigest: string,
  snapshotDigest: string,
): VNextNextActionOutput {
  return {
    action: 'RUN_CV',
    action_detail:
      `RUN_CV for slice ${slice.slice_id} — all Manifest tasks have valid persisted ` +
      'vNext TASK_COMPLETE facts; no CV verdict is asserted by this consumer',
    responsible_role: 'code-verifier',
    receipt_chain_valid: true,
    stage_id: input.stageId,
    slice_id: slice.slice_id,
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    proof_index_digest: computeDigest(slice.proof_index),
    snapshot_digest: snapshotDigest,
    findings: [],
  };
}

export class VNextNextActionService {
  nextAction(input: VNextNextActionInput): VNextNextActionOutput {
    try {
      // S09-REVIEW-001: canonical Stage ID guard at the earliest entry — the
      // Manifest/Authority must never be read for a parked legacy label.
      assertCanonicalStageId(input.stageId, 'stageId');
      // P-11 task B: archived-Stage guard at the earliest entry — a Stage
      // with a legal v2 STAGE_CLOSE_RESULT envelope must never be projected
      // for dispatch/CV (its Manifest is a historical snapshot).  The probe
      // is root-bound and fail-closed; an unreadable/corrupt stage-close
      // directory falls into the shared VALIDATE failure contract below.
      const closeFacts = readStageCloseFacts(input.projectRoot, input.stageId);
      if (closeFacts.archived) {
        return archivedOutput(input.stageId, closeFacts);
      }
      const manifestPath = input.manifestPath ?? path.join(input.projectRoot, '.proofloop', 'manifests', `${input.stageId}.json`);
      const manifest = readVNextManifest(input.projectRoot, manifestPath);
      if (manifest.stage_id !== input.stageId) {
        throw new VNextHandoffError('manifest-binding', `Manifest stage_id "${manifest.stage_id}" does not match "${input.stageId}"`);
      }
      const manifestDigest = computeDigest(manifest);
      const authority = readVNextAdmissionAuthority(input.projectRoot, input.stageId, input.admissionPath);
      if (input.verifyReferenceBindings !== false) {
        assertVNextManifestReferenceBindings(input.projectRoot, manifest);
      }
      const authoritySnapshot = authority.spv.snapshot_digest;
      const workerFacts = readVNextWorkerFacts(
        input.projectRoot,
        manifest,
        manifestDigest,
        authoritySnapshot,
      );
      const committedSliceIds = readVNextCommittedSliceIds(
        input.projectRoot,
        manifest,
        manifestDigest,
        manifest.plan.plan_digest,
        authoritySnapshot,
        workerFacts,
      );
      // A committed Slice's execution chain is closed (Worker → CV → Slice
      // Commit); its persisted Worker facts must never re-project RUN_CV or a
      // Worker dispatch for that Slice. Only facts of not-yet-committed
      // Slices drive the current execution state.
      const activeWorkerFacts = workerFacts.filter(
        (fact) => !committedSliceIds.has(fact.slice.slice_id),
      );
      if (activeWorkerFacts.length > 0) {
        assertIgnoredProtectedPaths(
          input.projectRoot,
          activeWorkerFacts.map((fact) => ({
            stageId: manifest.stage_id,
            sliceId: fact.slice.slice_id,
            taskId: fact.taskId,
            manifestDigest: fact.manifestDigest,
            planDigest: fact.planDigest,
            snapshotDigest: fact.snapshotDigest,
            contextRef: fact.contextRef,
            mode: fact.mode,
          })),
        );
      }
      const requestedSnapshot = input.snapshotDigest ?? authoritySnapshot;
      if (typeof input.snapshotDigest === 'string' && !/^[a-f0-9]{40}$/.test(input.snapshotDigest)) {
        throw new VNextHandoffError(
          'snapshot-binding',
          'requested snapshot_digest must be a canonical Git HEAD digest',
        );
      }
      if (requestedSnapshot !== authoritySnapshot) {
        throw new VNextHandoffError(
          'manifest-binding',
          'requested snapshot_digest does not match the admitted vNext Stage Plan snapshot',
        );
      }
      // Before any Worker fact exists, the pre-execution boundary is the
      // planning clean gate. When a Worker session was lost AFTER producing
      // implementation evidence but BEFORE its TASK_COMPLETE was admitted
      // (S08-E-T07 §Recovery), the worktree is already dirty with no Receipt.
      // That dirty state is the persisted recover binding: it must fall
      // exactly inside the Manifest-declared execution scope of the dispatch
      // Slice, and the next dispatch is then a `recover-task` consistency
      // recheck instead of a planning-clean implement dispatch.
      const factSlices = unique(activeWorkerFacts.map((fact) => fact.slice.slice_id));
      if (factSlices.length > 1) {
        throw new VNextHandoffError(
          'task-anchor-gap',
          'vNext execution facts for multiple Slices are ambiguous before downstream CV admission',
        );
      }
      const selectedSlice =
        activeWorkerFacts.length > 0
          ? activeWorkerFacts[0].slice
          : manifest.slices.length === 1
            ? (committedSliceIds.has(manifest.slices[0].slice_id)
                ? undefined
                : manifest.slices[0])
            : manifest.slices.find(
                (candidate) =>
                  !committedSliceIds.has(candidate.slice_id) &&
                  candidate.depends_on.every((dependency) => committedSliceIds.has(dependency)),
              );
      if (selectedSlice === undefined) {
        throw new VNextHandoffError(
          'task-anchor-gap',
          'vNext dispatch has no dependency-ready declared Slice; dependency completion state is unavailable',
        );
      }
      // The Manifest-declared Slice scope is needed only when an execution
      // dirty boundary must be proven (recovery with no admitted fact, or an
      // in-flight Task of the current Slice); a clean pre-execution boundary
      // never consults the scope.
      const selectedSliceScope = () => unique(
        taskIdsForSlice(manifest, selectedSlice).flatMap((taskId) =>
          taskAllowedScope(input.projectRoot, manifest, selectedSlice, taskId),
        ),
      );
      const preExecutionDirty = gitChangedPaths(input.projectRoot);
      // Once any execution boundary exists (a Worker fact or a committed
      // Slice), the execution dirty boundary applies: HEAD may legitimately
      // have advanced to a descendant of the admission snapshot via Slice
      // Commit, so the strict planning clean gate must not be re-applied.
      const executionStarted = activeWorkerFacts.length > 0 || committedSliceIds.size > 0;
      if (!executionStarted) {
        if (preExecutionDirty.length === 0) {
          assertStableGitBoundary(input.projectRoot, requestedSnapshot);
        } else {
          // Pre-execution scope-bound dirty is admissible ONLY as a persisted
          // recover binding: the first Task checkbox of the dispatch Slice
          // must already be checked (session loss after implementation
          // evidence, before the TASK_COMPLETE fact was admitted). The scope
          // check runs first so an out-of-scope dirty path reports the
          // execution dirty boundary violation; a scope-bound dirty worktree
          // without a checked checkbox has no recover binding, so it fails
          // the planning clean gate closed — it must never dispatch into a
          // dirty worktree as implement-task.
          assertExecutionDirtyBoundary(input.projectRoot, requestedSnapshot, selectedSliceScope());
          const firstTaskId = taskIdsForSlice(manifest, selectedSlice)[0];
          if (firstTaskId === undefined) {
            throw new VNextHandoffError('task-anchor-gap', 'Slice has no declarable Task anchor');
          }
          if (completionModeForDispatch(input.projectRoot, manifest, firstTaskId) === 'implement-task') {
            throw new VNextHandoffError(
              'execution-scope-gap',
              `planning clean boundary: scope-bound dirty worktree without Worker facts and without a recover binding fails closed (${firstTaskId} checkbox is unchecked)`,
            );
          }
        }
      } else {
        assertExecutionDirtyBoundary(
          input.projectRoot,
          requestedSnapshot,
          unique([
            ...activeWorkerFacts.flatMap((fact) => fact.allowedScope),
            // In-flight/recovery scope: a Task dispatched from the current
            // Slice may legitimately dirty its Manifest-declared scope
            // before its TASK_COMPLETE is admitted (session loss); the
            // immutable Manifest scope is the recovery binding for that
            // dirty state.
            ...selectedSliceScope(),
          ]),
        );
      }
      // The authority binding is asserted against the admitted snapshot, not
      // the current HEAD: Slice Commit legitimately advanced HEAD past the
      // admission boundary while the authority stays bound to it.
      assertActiveVNextAuthority(
        authority,
        input.stageId,
        manifestDigest,
        manifest.plan.plan_digest,
        requestedSnapshot,
      );

      if (activeWorkerFacts.length > 0) {
        const slice = activeWorkerFacts[0].slice;
        const unprovenDependencies = slice.depends_on.filter(
          (dependency) => !committedSliceIds.has(dependency),
        );
        if (manifest.slices.length > 1 && unprovenDependencies.length > 0) {
          throw new VNextHandoffError(
            'task-anchor-gap',
            `vNext execution Slice "${slice.slice_id}" has unproven dependencies`,
          );
        }
        const taskIds = taskIdsForSlice(manifest, slice);
        const completedTaskIds = new Set(activeWorkerFacts.map((fact) => fact.taskId));
        if (taskIds.every((taskId) => completedTaskIds.has(taskId))) {
          // S08-REVIEW-009: the RUN_CV projection must read and validate the
          // persisted CV history with the SAME strength as the recovery/
          // Commit consumers (`readVNextCommittedSliceIds`). A
          // self-digest-correct CV history fact that binds an earlier Context
          // or a non-tip Worker Receipt is rejected by `readVNextCvReceiptFacts`
          // (expectedContextDigest/workerTipDigest exact binding), so RUN_CV
          // must fail closed to bounded VALIDATE instead of projecting a CV
          // verdict the Commit/restart path would reject.
          const lastTaskId = taskIds[taskIds.length - 1];
          const workerTipFact = activeWorkerFacts.find((fact) => fact.taskId === lastTaskId);
          if (workerTipFact === undefined || workerTipFact.workerReceiptDigest === undefined) {
            throw new VNextHandoffError(
              'admission-invalid',
              `RUN_CV cannot resolve the Worker chain tip for ${manifest.stage_id}/${slice.slice_id}`,
            );
          }
          readVNextCvReceiptFacts(
            input.projectRoot,
            manifest.stage_id,
            slice.slice_id,
            {
              stageId: manifest.stage_id,
              sliceId: slice.slice_id,
              manifestDigest,
              planDigest: manifest.plan.plan_digest,
              proofIndexDigest: computeDigest(slice.proof_index),
              workerTipDigest: workerTipFact.workerReceiptDigest,
              expectedAcceptanceRefs: slice.proof_index.acceptance_refs,
              expectedSeamRefs: slice.proof_index.seam_refs,
              expectedOracleRefs: slice.proof_index.oracle_refs,
              expectedRiskRefs: slice.proof_index.risk_refs.map((risk) => risk.ref_id),
              expectedContextDigest: workerTipFact.contextDigest,
            },
            authoritySnapshot,
          );
          return runCvOutput(
            input,
            slice,
            manifestDigest,
            manifest.plan.plan_digest,
            requestedSnapshot,
          );
        }
        const dispatchMode = completionModeForDispatch(
          input.projectRoot,
          manifest,
          taskIds.find((taskId) => !completedTaskIds.has(taskId)) as string,
        );
        const dispatch = projectVNextWorkerDispatch({
          root: input.projectRoot,
          manifest,
          manifestDigest,
          snapshotDigest: requestedSnapshot,
          authority,
          sliceId: slice.slice_id,
          completedTaskIds: [...completedTaskIds],
          mode: dispatchMode,
          provenCompleteSlices: committedSliceIds,
          verifyReferenceBindings: input.verifyReferenceBindings,
        });
        if (input.persistContext === true) persistVNextWorkerContext(input.projectRoot, dispatch);
        return {
          action: dispatch.action,
          action_detail: "DISPATCH_WORKER mode=" + dispatch.mode + " for slice " + dispatch.slice_id + " task " + dispatch.task_id + " context_ref " + dispatch.context_ref,
          responsible_role: dispatch.responsible_role,
          receipt_chain_valid: dispatch.receipt_chain_valid,
          stage_id: dispatch.stage_id,
          slice_id: dispatch.slice_id,
          task_id: dispatch.task_id,
          mode: dispatch.mode,
          context_ref: dispatch.context_ref,
          manifest_digest: dispatch.manifest_digest,
          plan_digest: dispatch.plan_digest,
          proof_index_digest: dispatch.proof_index_digest,
          snapshot_digest: dispatch.snapshot_digest,
          findings: dispatch.findings,
        };
      }

      // The dispatch Slice selection mirrors the dispatch seam's dependency
      // rule (single-Slice pilot or the first dependency-ready Slice) and was
      // already resolved above for the pre-execution boundary.
      const firstTaskId = taskIdsForSlice(manifest, selectedSlice)[0];
      if (firstTaskId === undefined) {
        throw new VNextHandoffError('task-anchor-gap', 'Slice has no declarable Task anchor');
      }
      const dispatch = projectVNextWorkerDispatch({
        root: input.projectRoot,
        manifest,
        manifestDigest,
        snapshotDigest: requestedSnapshot,
        authority,
        sliceId: selectedSlice.slice_id,
        mode: completionModeForDispatch(input.projectRoot, manifest, firstTaskId),
        provenCompleteSlices: committedSliceIds,
        verifyReferenceBindings: input.verifyReferenceBindings,
      });
      if (input.persistContext === true) persistVNextWorkerContext(input.projectRoot, dispatch);
      return {
        action: dispatch.action,
        action_detail: "DISPATCH_WORKER mode=" + dispatch.mode + " for slice " + dispatch.slice_id + " task " + dispatch.task_id + " context_ref " + dispatch.context_ref,
        responsible_role: dispatch.responsible_role,
        receipt_chain_valid: dispatch.receipt_chain_valid,
        stage_id: dispatch.stage_id,
        slice_id: dispatch.slice_id,
        task_id: dispatch.task_id,
        mode: dispatch.mode,
        context_ref: dispatch.context_ref,
        manifest_digest: dispatch.manifest_digest,
        plan_digest: dispatch.plan_digest,
        proof_index_digest: dispatch.proof_index_digest,
        snapshot_digest: dispatch.snapshot_digest,
        findings: dispatch.findings,
      };
    } catch (error) {
      return failureOutput(input.stageId, error);
    }
  }
}

// ===========================================================================
// S10-B-T02 — role Context projection seam and CV Evidence read gate
// ===========================================================================
//
// The CLI `context` domain (proofloop-context.ts) consumes ONLY this seam for
// role projection and refutation-observation semantics.  The seam is a pure
// projection: it never writes `.proofloop/context` itself — the caller may
// persist a Worker dispatch through the existing `persistVNextWorkerContext`
// Runtime write path, and every other role Context stays a verifiable
// projection result (ref + digest), keeping the Runtime-owned area behind the
// Runtime seam.
//
// Role closure (Seam Role transfer): Planning/SPV/Worker/CV/Committer/Stage
// Reviewer/Project Reviewer use distinct Contexts; `role` is part of the
// Context content digest, so a Context projected for one role can never be
// reused for another role (the role check fails closed on content digest or
// explicit role mismatch).
//
// CV Evidence read gate: the initial CV Context carries
// `evidence_read_gate { required: 'refutation-observation', satisfied: false }`.
// `admit-refutation-observation` projects a digest-bound REFUTATION_OBSERVATION
// record bound to the same stage/slice/task/evidence_path/snapshot tuple;
// `verifyVNextRefutationObservationBinding` re-derives that binding so the
// gate can only be satisfied by an observation that provably belongs to the
// Context's Evidence tuple.

/** Closed role set projected by the vNext role Context seam (S10-B-T02). */
export const VNEXT_CONTEXT_ROLES = [
  'planning',
  'spv',
  'worker',
  'cv',
  'committer',
  'stage-reviewer',
  'project-reviewer',
] as const;
export type VNextContextRole = (typeof VNEXT_CONTEXT_ROLES)[number];

export function isVNextContextRole(value: string): value is VNextContextRole {
  return (VNEXT_CONTEXT_ROLES as readonly string[]).includes(value);
}

export interface VNextRoleContextProjectionInput {
  readonly root: string;
  /** Kernel-validated v2 Manifest object (the same artifact next dispatches on). */
  readonly manifest: unknown;
  readonly manifestDigest: string;
  readonly snapshotDigest: string;
  readonly role: string;
  readonly stageId: string;
  /** Optional Slice binding; when present it must be declared by the Manifest. */
  readonly sliceId?: string;
  /** Optional Task binding; when present it must belong to the bound Slice. */
  readonly taskId?: string;
  readonly verifyReferenceBindings?: boolean;
  /** Persisted role facts (Committer receipts/changed files). */
  readonly roleFacts?: VNextRoleFacts;
}

/**
 * Role Context projection for the CLI `context prepare/show` operations.
 * The Worker role Context keeps the existing dispatch projection
 * (`projectVNextWorkerDispatch` + `persistVNextWorkerContext`) so CLI prepare
 * and next dispatch stay byte-identical; this seam projects the remaining
 * roles and carries `role` as part of the digest-bound content.
 */
export interface VNextRoleContext {
  readonly schema_version: 2;
  readonly root_path: string;
  readonly root_digest: string;
  readonly stage_id: string;
  readonly role: VNextContextRole;
  readonly slice_id?: string;
  readonly task_id?: string;
  readonly plan_projection_path: string;
  readonly evidence_path?: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly proof_index_digest?: string;
  readonly snapshot_digest: string;
  /** CV role only: the initial CV Evidence read gate declaration. */
  readonly evidence_read_gate?: {
    readonly required: 'refutation-observation';
    readonly satisfied: false;
  };
  /** Contract §0.5 minimum role-specific semantic fields. */
  readonly role_fields: Record<string, unknown>;
  /**
   * Runtime admission provenance（repair round 5）：only records written by
   * the Runtime seam carry this marker（part of the digest）; any
   * structurally-valid self-digest artifact without it is a forged record.
   */
  readonly created_by: 'vnext-runtime-seam';
  readonly context_digest: string;
}

export interface VNextRoleContextProjection {
  readonly role: VNextContextRole;
  readonly context_ref: string;
  readonly context: VNextRoleContext;
  readonly stage_id: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly snapshot_digest: string;
}

/**
 * Minimum role-specific semantic fields per contract §0.5: every closed role
 * projection carries the role semantics its consumer needs (authority/goal/
 * proof refs, evidence-read binding for initial CV, boundary/receipt facts for
 * Committer, review scope + full review refs for Reviewers).  `role` AND
 * `role_fields` are part of the Context digest, so cross-role reuse stays
 * impossible.
 */
function roleFieldsFor(
  role: VNextContextRole,
  manifest: VNextManifest,
  snapshotDigest: string,
  roleFacts: VNextRoleFacts,
): Record<string, unknown> {
  const authorityRefs = [...(manifest.authority_ref_ids ?? [])];
  const goalRefs = [...new Set(manifest.slices.map((slice) => slice.proof_index.goal_ref))];
  // Full review refs: the union of every Slice Proof Index refs (stage scope).
  const reviewRefs = () => {
    const acceptanceRefs = [...new Set(manifest.slices.flatMap((slice) => slice.proof_index.acceptance_refs))];
    const seamRefs = [...new Set(manifest.slices.flatMap((slice) => slice.proof_index.seam_refs))];
    const oracleRefs = [...new Set(manifest.slices.flatMap((slice) => slice.proof_index.oracle_refs))];
    const riskRefs = [...new Set(manifest.slices.flatMap((slice) => slice.proof_index.risk_refs.map((risk) => risk.ref_id)))];
    return { acceptance_refs: acceptanceRefs, seam_refs: seamRefs, oracle_refs: oracleRefs, risk_refs: riskRefs };
  };
  // Proof Index refs (SPV): union of every Slice Proof Index refs.
  const proofIndexRefs = () => {
    const taskRefs = [...new Set(manifest.slices.flatMap((slice) => slice.proof_index.task_refs))];
    const acceptanceRefs = [...new Set(manifest.slices.flatMap((slice) => slice.proof_index.acceptance_refs))];
    const seamRefs = [...new Set(manifest.slices.flatMap((slice) => slice.proof_index.seam_refs))];
    const oracleRefs = [...new Set(manifest.slices.flatMap((slice) => slice.proof_index.oracle_refs))];
    const riskRefs = [...new Set(manifest.slices.flatMap((slice) => slice.proof_index.risk_refs.map((risk) => risk.ref_id)))];
    return { task_refs: taskRefs, acceptance_refs: acceptanceRefs, seam_refs: seamRefs, oracle_refs: oracleRefs, risk_refs: riskRefs };
  };
  switch (role) {
    case 'planning':
      // §0.5 Planning: selected AWI, Authority refs, constraints,
      // out-of-scope, existing findings (manifest-projected minimum).
      return {
        authority_refs: authorityRefs,
        selected_work_item_refs: goalRefs,
        constraints: [],
        out_of_scope: [],
        finding_refs: [],
      };
    case 'spv':
      // §0.5 SPV: Stage goal, candidate Plan, Proof Index, Authority digests,
      // Git snapshot, Evidence skeleton refs.
      return {
        stage_goal_refs: goalRefs,
        authority_refs: authorityRefs,
        evidence_paths: manifest.slices.map((slice) => slice.evidence_path),
        plan_ref: manifest.plan.ref,
        proof_index: proofIndexRefs(),
      };
    case 'cv': {
      // §0.5 Initial CV / CV recheck: pre-refutation binding with
      // evidence_read:false — Evidence stays locked until a bound refutation
      // observation exists.  The cv role is slice-scoped: goal/proof/code
      // refs come from the bound Slice Proof Index.
      const slice = manifest.slices.find((candidate) => candidate.slice_id === roleFacts.sliceId);
      if (slice === undefined) {
        throw new VNextHandoffError('task-anchor-gap', 'cv role Context requires a slice binding for proof refs');
      }
      const hasRepair = roleFacts.cvRepairHistory?.hasRepair === true;
      if (hasRepair) {
        // Round 6: cv-validation closed recheck semantics — a repair history
        // without the closed recheck fields must never project as recheck.
        const history = roleFacts.cvRepairHistory;
        if (
          typeof history?.repairDiffDigest !== 'string' ||
          history.repairDiffDigest.length === 0 ||
          typeof history.failedCriterion !== 'string' ||
          history.failedCriterion.length === 0 ||
          typeof history.previousFailureSignature !== 'string' ||
          history.previousFailureSignature.length === 0 ||
          (history.counterexamples ?? []).length === 0 ||
          (history.requiredRecheckScope ?? []).length === 0
        ) {
          throw new VNextHandoffError(
            'manifest-binding',
            'CV repair history lacks the closed recheck fields (repair_diff_digest/failed_criterion/failure_signature/counterexamples/required_recheck_scope); recheck Context projection fails closed',
          );
        }
      }
      return {
        verification: hasRepair ? 'recheck' : 'initial',
        evidence_read: false,
        previous_failure_signature: roleFacts.cvRepairHistory?.previousFailureSignature ?? null,
        // Round 5: recheck semantics from the REAL CV_REPAIR Receipt payload.
        repair_diff_digest: roleFacts.cvRepairHistory?.repairDiffDigest ?? null,
        failed_criterion: roleFacts.cvRepairHistory?.failedCriterion ?? null,
        counterexamples: [...(roleFacts.cvRepairHistory?.counterexamples ?? [])],
        required_recheck_scope: [...(roleFacts.cvRepairHistory?.requiredRecheckScope ?? [])],
        goal_refs: [slice.proof_index.goal_ref],
        task_refs: [...slice.proof_index.task_refs],
        acceptance_refs: [...slice.proof_index.acceptance_refs],
        seam_refs: [...slice.proof_index.seam_refs],
        oracle_refs: [...slice.proof_index.oracle_refs],
        risk_refs: slice.proof_index.risk_refs.map((risk) => risk.ref_id),
      };
    }
    case 'committer':
      // §0.5 Committer: accepted CV/Task Receipt refs, exact Git boundary,
      // changed-file set, expected HEAD/index/worktree.
      return {
        boundary: 'slice-commit',
        expected_head: snapshotDigest,
        expected_index: roleFacts.gitState?.index ?? 'clean',
        expected_worktree: roleFacts.gitState?.worktree ?? 'clean',
        receipt_refs: [...(roleFacts.receiptRefs ?? [])],
        changed_files: [...(roleFacts.changedFiles ?? [])],
      };
    case 'stage-reviewer':
      // §0.5 Stage Reviewer: Stage goal, integrated snapshot, Stage
      // Gate/CV/Slice refs, unresolved findings, Authority refs + full
      // review refs and persisted Receipt refs.
      return {
        review_scope: 'stage',
        integrated_snapshot: snapshotDigest,
        authority_refs: authorityRefs,
        ...reviewRefs(),
        receipt_refs: [...(roleFacts.receiptRefs ?? [])],
        finding_refs: [],
      };
    case 'project-reviewer':
      // §0.5 Project Reviewer: PRD goals/AC refs, all accepted Stage
      // Review/Gate refs, E2E Receipt, limitations.
      return {
        review_scope: 'project',
        authority_refs: authorityRefs,
        ...reviewRefs(),
        receipt_refs: [...(roleFacts.receiptRefs ?? [])],
        e2e_status: roleFacts.e2eStatus ?? null,
        limitations: [],
      };
    default:
      return {};
  }
}

/** Persisted facts a role projection may bind (repair round 3/5). */
export interface VNextRoleFacts {
  readonly sliceId?: string;
  /** Digest-addressed Receipt refs of the bound Slice (tasks/cv/committer). */
  readonly receiptRefs?: readonly string[];
  /** Union of the admitted Worker changed-file sets of the bound Slice. */
  readonly changedFiles?: readonly string[];
  /** CV history of the bound Slice (initial vs recheck verification). */
  readonly cvRepairHistory?: {
    readonly hasRepair: boolean;
    readonly previousFailureSignature?: string;
    /** Round 5: full recheck semantics read from the REAL CV_REPAIR Receipt. */
    readonly repairDiffDigest?: string;
    readonly failedCriterion?: string;
    readonly counterexamples?: readonly string[];
    readonly requiredRecheckScope?: readonly string[];
  };
  /** Git boundary state for the Committer role (index/worktree). */
  readonly gitState?: { readonly index: string; readonly worktree: string };
  /** Project E2E status for the Project Reviewer role. */
  readonly e2eStatus?: string | null;
}

export function projectVNextRoleContext(
  input: VNextRoleContextProjectionInput,
): VNextRoleContextProjection {
  if (!isVNextContextRole(input.role)) {
    throw new VNextHandoffError(
      'manifest-binding',
      `Context role "${input.role}" is outside the closed role set (${VNEXT_CONTEXT_ROLES.join('|')})`,
    );
  }
  assertCanonicalStageId(input.stageId, 'stageId');
  let manifest: VNextManifest;
  try {
    manifest = validateVNextManifest(input.manifest);
  } catch (error) {
    throw new VNextHandoffError(
      'manifest-invalid',
      `vNext Manifest rejected for role Context projection: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.version !== 2 || manifest.plan.schema_version !== 2) {
    throw new VNextHandoffError('v1-input', 'Only explicit version: 2 / schema_version: 2 is accepted');
  }
  if (manifest.stage_id !== input.stageId) {
    throw new VNextHandoffError(
      'manifest-binding',
      `Manifest stage_id "${manifest.stage_id}" does not match "${input.stageId}"`,
    );
  }
  if (computeDigest(manifest) !== input.manifestDigest) {
    throw new VNextHandoffError('manifest-binding', 'manifest_digest does not match the admitted v2 Manifest');
  }
  if (typeof input.snapshotDigest !== 'string' || !/^[a-f0-9]{40}$/.test(input.snapshotDigest)) {
    throw new VNextHandoffError('snapshot-binding', 'Context snapshot_digest must be a canonical Git HEAD digest');
  }
  if (input.verifyReferenceBindings !== false) {
    assertVNextManifestReferenceBindings(input.root, manifest);
  }
  const planProjectionPath = rootRelativeFactPath(input.root, manifest.plan.ref, 'Manifest.plan.ref');
  const slice = input.sliceId === undefined
    ? undefined
    : manifest.slices.find((candidate) => candidate.slice_id === input.sliceId);
  if (input.sliceId !== undefined && slice === undefined) {
    throw new VNextHandoffError('task-anchor-gap', `Context slice "${input.sliceId}" is not declared by the Manifest`);
  }
  if (input.taskId !== undefined) {
    if (slice === undefined) {
      throw new VNextHandoffError('task-anchor-gap', 'Context task_id requires a bound slice_id');
    }
    if (!taskIdsForSlice(manifest, slice).includes(input.taskId)) {
      throw new VNextHandoffError('task-anchor-gap', `Context task "${input.taskId}" is not bound to Slice "${slice.slice_id}"`);
    }
  }
  if (input.role === 'cv' && slice === undefined) {
    throw new VNextHandoffError('task-anchor-gap', 'cv role Context requires a slice binding (Evidence read gate is slice-scoped)');
  }
  const contextWithoutDigest: Record<string, unknown> = {
    schema_version: 2,
    root_path: input.root,
    root_digest: computeDigest(input.root),
    stage_id: manifest.stage_id,
    role: input.role,
    plan_projection_path: planProjectionPath,
    manifest_digest: input.manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    snapshot_digest: input.snapshotDigest,
  };
  if (slice !== undefined) {
    contextWithoutDigest.slice_id = slice.slice_id;
    contextWithoutDigest.evidence_path = rootRelativeFactPath(input.root, slice.evidence_path, 'Slice Evidence path');
    contextWithoutDigest.proof_index_digest = computeDigest(slice.proof_index);
  }
  if (input.taskId !== undefined) {
    contextWithoutDigest.task_id = input.taskId;
  }
  if (input.role === 'cv') {
    contextWithoutDigest.evidence_read_gate = { required: 'refutation-observation', satisfied: false };
  }
  contextWithoutDigest.role_fields = roleFieldsFor(
    input.role,
    manifest,
    input.snapshotDigest,
    {
      sliceId: input.sliceId,
      receiptRefs: input.roleFacts?.receiptRefs ?? [],
      changedFiles: input.roleFacts?.changedFiles ?? [],
      cvRepairHistory: input.roleFacts?.cvRepairHistory,
      gitState: input.roleFacts?.gitState,
      e2eStatus: input.roleFacts?.e2eStatus,
    },
  );
  contextWithoutDigest.created_by = 'vnext-runtime-seam';
  const contextDigest = computeDigest(contextWithoutDigest);
  const context = {
    ...contextWithoutDigest,
    context_digest: contextDigest,
  } as VNextRoleContext;
  return {
    role: input.role,
    context_ref: `.proofloop/context/${contextDigest}.json`,
    context,
    stage_id: manifest.stage_id,
    manifest_digest: input.manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    snapshot_digest: input.snapshotDigest,
  };
}

export interface VNextRefutationObservationInput {
  readonly root: string;
  readonly stageId: string;
  readonly sliceId: string;
  readonly taskId: string;
  /** Root-relative Manifest Slice Evidence path the gate protects. */
  readonly evidencePath: string;
  readonly snapshotDigest: string;
  /** Non-empty closed observation text recorded by the initial CV. */
  readonly observation: string;
  /**
   * S10-B-T02 repair round 3: the observation carries admission provenance —
   * the digest-addressed CV Context that must already exist (prepared
   * first), plus the submission timestamp.  The gate only accepts
   * observations whose CV Context binding is verifiable on disk.
   */
  readonly cvContextRef: string;
  readonly cvContextDigest: string;
  /** ISO-8601 submission timestamp (part of the digest). */
  readonly recordedAt: string;
}

export interface VNextRefutationObservation {
  readonly schema_version: 2;
  readonly type: 'REFUTATION_OBSERVATION';
  readonly stage_id: string;
  readonly slice_id: string;
  readonly task_id: string;
  readonly role: 'cv';
  readonly evidence_path: string;
  readonly snapshot_digest: string;
  readonly observation: string;
  /** Gate order binding: must be false — observation precedes Evidence read. */
  readonly evidence_read: false;
  /** Admission provenance: the CV Context that must exist before admission. */
  readonly cv_context_ref: string;
  readonly cv_context_digest: string;
  /** ISO-8601 submission timestamp（part of the digest）. */
  readonly recorded_at: string;
  /** Runtime admission provenance（repair round 5）。 */
  readonly created_by: 'vnext-runtime-seam';
  /**
   * S10-B-T02 repair round 2: the persisted record is digest-addressed like a
   * Context artifact (.proofloop/context/<context_digest>.json) and written
   * write-once by the Runtime seam; `context_digest` is its self-digest.
   */
  readonly context_digest: string;
}

export interface VNextRefutationObservationProjection {
  /** Digest-addressed projection ref (Runtime-owned area; no write by the CLI). */
  readonly ref: string;
  readonly observation: VNextRefutationObservation;
}

/**
 * Project a digest-bound refutation observation.  This is the record the
 * initial CV must produce BEFORE reading Evidence (Evidence read gate).  The
 * projection is verifiable (digest self-consistent, bound to the exact
 * stage/slice/task/evidence_path/snapshot tuple of the CV Context); it is not
 * persisted by this seam — Runtime-owned persistence is left to the Runtime
 * owner/admission (S10-C consumes the digest-bound record).
 */
export function projectVNextRefutationObservation(
  input: VNextRefutationObservationInput,
): VNextRefutationObservationProjection {
  assertCanonicalStageId(input.stageId, 'stageId');
  if (typeof input.sliceId !== 'string' || input.sliceId.length === 0) {
    throw new VNextHandoffError('task-anchor-gap', 'refutation observation requires a non-empty slice_id');
  }
  if (typeof input.taskId !== 'string' || input.taskId.length === 0) {
    throw new VNextHandoffError('task-anchor-gap', 'refutation observation requires a non-empty task_id');
  }
  if (typeof input.observation !== 'string' || input.observation.trim().length === 0) {
    throw new VNextHandoffError('manifest-binding', 'refutation observation text must be non-empty');
  }
  if (!/^[a-f0-9]{40}$/.test(input.snapshotDigest)) {
    throw new VNextHandoffError('snapshot-binding', 'refutation observation snapshot_digest must be a canonical Git HEAD digest');
  }
  if (input.cvContextRef !== `.proofloop/context/${input.cvContextDigest}.json`) {
    throw new VNextHandoffError(
      'manifest-binding',
      'refutation observation cv_context_ref is not digest-addressed',
    );
  }
  if (typeof input.recordedAt !== 'string' || input.recordedAt.length === 0) {
    throw new VNextHandoffError('manifest-binding', 'refutation observation recorded_at must be a non-empty timestamp');
  }
  const evidencePath = rootRelativeFactPath(input.root, input.evidencePath, 'refutation observation evidence path');
  const recordWithoutDigest = {
    schema_version: 2,
    type: 'REFUTATION_OBSERVATION',
    stage_id: input.stageId,
    slice_id: input.sliceId,
    task_id: input.taskId,
    role: 'cv',
    evidence_path: evidencePath,
    snapshot_digest: input.snapshotDigest,
    observation: input.observation,
    evidence_read: false,
    cv_context_ref: input.cvContextRef,
    cv_context_digest: input.cvContextDigest,
    recorded_at: input.recordedAt,
    created_by: 'vnext-runtime-seam',
  } as const;
  const digest = computeDigest(recordWithoutDigest);
  // The persisted record is digest-addressed like a Context artifact:
  // `.proofloop/context/<digest>.json` with a self-consistent context_digest,
  // so the Runtime protected-path scan accepts it (schema_version 2 +
  // digest self-check) and it stays a verifiable Runtime-owned record.
  return {
    ref: `.proofloop/context/${digest}.json`,
    observation: { ...recordWithoutDigest, context_digest: digest },
  };
}

/**
 * Persist the digest-addressed refutation observation write-once through the
 * Runtime seam (S10-B-T02 repair round 2).  The gate ONLY accepts records
 * that were admitted this way — a caller-declared observation that was never
 * persisted (or was forged after Evidence was read) cannot satisfy the gate.
 */
export function persistVNextRefutationObservation(
  root: string,
  projection: VNextRefutationObservationProjection,
): void {
  const target = path.join(root, projection.ref);
  const canonical = canonicalPathWithinRoot(root, target);
  if (canonical === null) {
    throw new VNextHandoffError('path-escape', 'refutation observation ref escapes the project root');
  }
  const record = projection.observation;
  const digest = record.context_digest;
  const withoutDigest = { ...record } as Record<string, unknown>;
  delete withoutDigest.context_digest;
  if (projection.ref !== `.proofloop/context/${digest}.json` || computeDigest(withoutDigest) !== digest) {
    throw new VNextHandoffError(
      'manifest-binding',
      'refutation observation ref is not bound to the record digest',
    );
  }
  const payload = JSON.stringify(record, null, 2) + '\n';
  try {
    fs.lstatSync(canonical);
    const opened = openNoFollowRead(root, canonical);
    if (!opened.ok) {
      throw new VNextHandoffError('manifest-binding', 'existing refutation observation is not a regular root bound file');
    }
    let actual: string;
    try {
      actual = fs.readFileSync(opened.fd, 'utf8');
    } finally {
      fs.closeSync(opened.fd);
    }
    if (actual !== payload) {
      throw new VNextHandoffError('manifest-binding', 'existing refutation observation content does not match its digest');
    }
    return;
  } catch (error) {
    if (error instanceof VNextHandoffError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new VNextHandoffError('manifest-binding', 'refutation observation cannot be inspected');
    }
  }
  const parent = canonicalPathWithinRoot(root, path.dirname(canonical));
  if (parent === null) {
    throw new VNextHandoffError('path-escape', 'refutation observation parent escapes the project root');
  }
  fs.mkdirSync(parent, { recursive: true });
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(canonical, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const opened = openNoFollowRead(root, canonical);
      if (!opened.ok) {
        throw new VNextHandoffError('manifest-binding', 'refutation observation race target is not a regular root bound file');
      }
      let actual: string;
      try {
        actual = fs.readFileSync(opened.fd, 'utf8');
      } finally {
        fs.closeSync(opened.fd);
      }
      if (actual !== payload) {
        throw new VNextHandoffError('manifest-binding', 'existing refutation observation content does not match its digest');
      }
      return;
    }
    throw new VNextHandoffError(
      'manifest-binding',
      'refutation observation could not be persisted write once: ' + (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export type VNextRefutationObservationBinding =
  | { readonly ok: true }
  | { readonly ok: false; readonly field: string; readonly message: string };

/**
 * Re-verify that a refutation observation binds the CV Context it is offered
 * for: digest self-consistency plus exact stage/slice/task/evidence_path/
 * snapshot equality with the Context projection.  Any mismatch fails closed —
 * an observation for another tuple can never satisfy this Context's Evidence
 * read gate.
 */
export function verifyVNextRefutationObservationBinding(
  root: string,
  observation: VNextRefutationObservation,
  context: Pick<
    VNextRoleContext,
    'stage_id' | 'slice_id' | 'task_id' | 'evidence_path' | 'snapshot_digest'
  >,
): VNextRefutationObservationBinding {
  if (typeof root !== 'string' || root.length === 0) {
    return { ok: false, field: 'root', message: 'project root is required' };
  }
  if (observation.role !== 'cv') {
    return { ok: false, field: 'role', message: `observation role "${observation.role}" is not the cv role` };
  }
  if (observation.evidence_read !== false) {
    return {
      ok: false,
      field: 'evidence_read',
      message: 'observation claims Evidence was already read; the gate requires observation BEFORE Evidence read',
    };
  }
  if (
    typeof observation.cv_context_ref !== 'string' ||
    typeof observation.cv_context_digest !== 'string' ||
    observation.cv_context_ref !== `.proofloop/context/${observation.cv_context_digest}.json`
  ) {
    return {
      ok: false,
      field: 'cv_context',
      message: 'observation carries no digest-addressed CV Context provenance',
    };
  }
  if (typeof observation.recorded_at !== 'string' || observation.recorded_at.length === 0) {
    return {
      ok: false,
      field: 'recorded_at',
      message: 'observation carries no submission timestamp',
    };
  }
  const withoutDigest = { ...observation } as Record<string, unknown>;
  delete withoutDigest.context_digest;
  if (computeDigest(withoutDigest) !== observation.context_digest) {
    return {
      ok: false,
      field: 'context_digest',
      message: 'observation content does not match its context_digest',
    };
  }
  const bindings: ReadonlyArray<readonly [string, string | undefined, string | undefined]> = [
    ['stage_id', observation.stage_id, context.stage_id],
    ['slice_id', observation.slice_id, context.slice_id],
    ['task_id', observation.task_id, context.task_id],
    ['evidence_path', observation.evidence_path, context.evidence_path],
    ['snapshot_digest', observation.snapshot_digest, context.snapshot_digest],
  ];
  for (const [field, actual, expected] of bindings) {
    if (actual !== expected) {
      return {
        ok: false,
        field,
        message: `observation ${field} "${String(actual)}" does not bind the Context ${field} "${String(expected)}"`,
      };
    }
  }
  return { ok: true };
}

/**
 * Persist only the generated, digest-addressed role Context projection
 * (S10-B-T02 repair): write-once through the Runtime seam, re-deriving the
 * digest self-check exactly like `persistVNextWorkerContext`.  An existing
 * file with identical content is idempotent; any other state fails closed.
 */
export function persistVNextRoleContext(
  root: string,
  projection: VNextRoleContextProjection,
): void {
  const target = path.join(root, projection.context_ref);
  const canonical = canonicalPathWithinRoot(root, target);
  if (canonical === null) {
    throw new VNextHandoffError('path-escape', 'role Context ref escapes the project root');
  }
  const context = projection.context;
  const digest = context.context_digest;
  const withoutDigest = { ...context } as Record<string, unknown>;
  delete withoutDigest.context_digest;
  if (
    projection.context_ref !== `.proofloop/context/${digest}.json` ||
    computeDigest(withoutDigest) !== digest
  ) {
    throw new VNextHandoffError(
      'manifest-binding',
      'role Context ref is not bound to the generated Context digest',
    );
  }
  const payload = JSON.stringify(context, null, 2) + '\n';
  try {
    fs.lstatSync(canonical);
    const opened = openNoFollowRead(root, canonical);
    if (!opened.ok) {
      throw new VNextHandoffError('manifest-binding', 'existing role Context is not a regular root bound file');
    }
    let actual: string;
    try {
      actual = fs.readFileSync(opened.fd, 'utf8');
    } finally {
      fs.closeSync(opened.fd);
    }
    if (actual !== payload) {
      throw new VNextHandoffError('manifest-binding', 'existing role Context content does not match its digest');
    }
    return;
  } catch (error) {
    if (error instanceof VNextHandoffError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new VNextHandoffError('manifest-binding', 'role Context cannot be inspected');
    }
  }
  const parent = canonicalPathWithinRoot(root, path.dirname(canonical));
  if (parent === null) {
    throw new VNextHandoffError('path-escape', 'role Context parent escapes the project root');
  }
  fs.mkdirSync(parent, { recursive: true });
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(canonical, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const opened = openNoFollowRead(root, canonical);
      if (!opened.ok) {
        throw new VNextHandoffError('manifest-binding', 'role Context race target is not a regular root bound file');
      }
      let actual: string;
      try {
        actual = fs.readFileSync(opened.fd, 'utf8');
      } finally {
        fs.closeSync(opened.fd);
      }
      if (actual !== payload) {
        throw new VNextHandoffError('manifest-binding', 'existing role Context content does not match its digest');
      }
      return;
    }
    throw new VNextHandoffError(
      'manifest-binding',
      'role Context could not be persisted write once: ' + (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
