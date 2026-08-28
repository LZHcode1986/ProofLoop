/** vNext `next` consumer.  It never calls v1 manifest/reconcile/action code. */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeDigest,
  computeReceiptDigest,
  SchemaValidationError,
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
// S12-D-T02: the slice-local currentness oracle (S12-D-T01) is consumed at
// the slice level; the kernel closed dependency-binding validator is applied
// to the receipt-bound dependency facts before they enter the oracle.
import {
  validateDependencyBinding,
  type VNextDependencyBinding,
} from '@proofloop/kernel/dist/vnext';
import { isIntegratedSliceCurrent, type IntegrationReceiptRef } from './binding-currentness';
import type { Finding } from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import { readGitHead, resolveGitRoot } from '../git-source';
import {
  committerReceiptDir,
  cvReceiptDir,
  integrationReceiptDir,
  reviewReceiptDir,
  stageGateReceiptDir,
  tasksReceiptDir,
} from '../receipt-layout';
import {
  deriveLineageReceiptExemptions,
  loadAncestorReplanDispositionRecords,
  readCurrentVNextAdmissionAuthority,
  type ReplanAncestorDispositionRecord,
  type ReplanDispositionFact,
} from './replan-epoch';
import {
  classifyVNextFinalizeLineage,
  validateVNextHistoricalIntegrationReceipt,
  validateVNextInvalidatedFinalizeReceipt,
} from './finalize-lineage';
import { buildVNextHistoricalManifest } from './historical-manifest';
import { assertIgnoredProtectedPaths } from './protected-paths';
export { assertIgnoredProtectedPaths };
export type { VNextIgnoredProtectedPathBinding } from './protected-paths';
import type { VNextFinalizeLineage } from './finalize-lineage';
import {
  assertVNextManifestReferenceBindings,
  projectVNextWorkerDispatch,
  readVNextAdmissionAuthority,
  readVNextManifest,
  verifyVNextWorkerContextBindings,
  VNextHandoffError,
} from './dispatch';
export { readVNextAdmissionAuthority } from './dispatch';
import type {
  VNextAdmissionAuthority,
  VNextWorkerContext,
  VNextWorkerDispatch,
} from './dispatch';
import { assertStableGitBoundary } from './git-boundary';
import {
  assertClosedVNextCvPayload,
  assertSliceLocalCredentialBindingFields,
  assertUpstreamCvPassSemantics,
  assertUpstreamSliceCommitSemantics,
  assertUpstreamTaskCompleteSemantics,
  assertVNextCvChainSequence,
  assertVNextCvReceiptTypeVerdict,
  computeSliceLocalCredentialExpectation,
  credentialSchemaVersionMismatch,
  vnextSliceAllowedScope,
  vnextUpstreamSliceLocalBindingExpectation,
} from './cv-validation';
import { readReceiptChain, validateHistoricalCvGeneration } from './integration-validation';
import type { VNextCvPayloadBinding } from './cv-validation';
import { VNEXT_WORKER_COMPLETION_MODES, VNEXT_WORKER_DISPATCH_MODES } from './types';
import { readVNextStageReviewPreparedFacts } from './review-preparation';
import type {
  VNextNextAction,
  VNextResponsibleRole,
  VNextWorkerCompletionMode,
  VNextWorkerDispatchMode,
} from './types';
// P-11 task B: read-only STAGE_CLOSE archived-facts probe.  An archived Stage
// is a historical snapshot and must never be projected for dispatch/CV.
import { readStageCloseFacts } from './stage-close-facts';
import type { StageCloseFacts } from './stage-close-facts';
// S13-S17 remediation §6.2: the ONE canonical Stage lifecycle decision seam.
// The vNext service resolves/validates persisted facts; the action itself is
// decided by `deriveNextAction` — never by a parallel vNext state machine.
import { deriveNextAction } from '../derive-next-action';
import type { DerivedNextAction, PendingCvResultEnvelope } from '../derive-next-action';
import type { ReconciledSliceState } from '../state-model';
import { validateVNextWorkerResultEnvelope } from '../relay-contract';
import type { VNextWorkerResultEnvelope, WorkerResultEnvelope } from '../relay-contract';
// Runtime-safe cycle: cv-admission uses next.ts bindings only inside
// functions, never during module evaluation.
import { validateVNextCvResultEnvelope } from './cv-result-envelope';
import { CVStatus, ProjectState, SliceState, StageState } from '@proofloop/kernel';

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
  readonly mode?: VNextWorkerDispatchMode;
  readonly context_ref?: string;
  readonly manifest_digest?: string;
  readonly plan_digest?: string;
  readonly proof_index_digest?: string;
  readonly snapshot_digest?: string;
  readonly findings: readonly Finding[];
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


function resolveNextAdmissionAuthority(
  root: string,
  stageId: string,
  admissionPath?: string,
): VNextAdmissionAuthority {
  if (admissionPath) {
    return readVNextAdmissionAuthority(root, stageId, admissionPath);
  }
  // repair (current-authority parity): the no-path branch delegates to the
  // SAME canonical current-epoch reader every other vNext consumer uses.
  return readCurrentVNextAdmissionAuthority(root, stageId);
}

interface VNextWorkerFact {
  readonly slice: VNextManifestSlice;
  readonly taskId?: string;
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

interface VNextFinalizeFact {
  readonly slice: VNextManifestSlice;
  readonly workerReceiptDigest: string;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly proofIndexDigest: string;
  readonly snapshotDigest: string;
  readonly contextRef: string;
  readonly contextDigest: string;
  readonly changedFiles: readonly string[];
  readonly mode: 'finalize-slice';
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


function computeChainInvalidatedTaskIds(
  dispositionRecords: readonly ReplanAncestorDispositionRecord[],
): Set<string> {
  const invalidated = new Set<string>();
  // Process from oldest ancestor (tail) to newest tip (head)
  for (let i = dispositionRecords.length - 1; i >= 0; i--) {
    const disp = dispositionRecords[i].dispositionFact.disposition;
    for (const taskId of disp.invalidated_task_ids) {
      if (!disp.carry_forward_task_ids.includes(taskId)) {
        invalidated.add(taskId);
      }
    }
    for (const taskId of disp.carry_forward_task_ids) {
      invalidated.delete(taskId);
    }
  }
  return invalidated;
}

/**
 * Select the completion mode for the next un-admitted Task from persisted
 * facts only (S08-E-T07 §Recovery): already-checked implementation evidence
 * without an admitted TASK_COMPLETE fact or an invalidated task from a prior
 * Replan epoch is rechecked as `recover-task`; otherwise the Task is
 * dispatched as `implement-task`.
 */
function completionModeForDispatch(
  root: string,
  manifest: VNextManifest,
  taskId: string,
  historicalInvalidatedTaskIds?: ReadonlySet<string>,
): VNextWorkerCompletionMode {
  return (historicalInvalidatedTaskIds?.has(taskId) || planTaskCheckboxChecked(root, manifest.plan.ref, taskId))
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
  planDigest: string,
  snapshotDigest: string,
  slice: VNextManifestSlice,
  taskId: string | undefined,
  taskScope: VNextExecutionScope | undefined,
  taskRef: string | undefined,
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
    context.plan_digest !== planDigest ||
    context.proof_index_digest !== proofIndexDigest ||
    context.snapshot_digest !== snapshotDigest
  ) {
    throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Context is not bound to the active vNext execution tuple');
  }
  if (context.evidence_path !== slice.evidence_path || context.plan_projection_path !== manifest.plan.ref) {
    throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Context artifact paths do not match the Manifest');
  }
  if (taskScope !== undefined) {
    if (computeDigest(context.execution_scope) !== computeDigest(taskScope)) {
      throw new VNextHandoffError('execution-scope-gap', 'TASK_COMPLETE Context scope does not match the Manifest task scope');
    }
  }
}

/**
 * S12-E REPAIR-FINAL round 3 — context 落盘绑定: the context_ref file must
 * EXIST at `.proofloop/context/<context_digest>.json` and its content digest
 * must equal context_digest.  A TASK_COMPLETE credential whose Context was
 * never persisted — or whose persisted content does not match the digest —
 * is never a CURRENT upstream credential and fails closed.
 */
function assertUpstreamContextPersisted(root: string, contextRef: string, contextDigest: string): void {
  const context = readRootBoundRecord(root, contextRef, 'TASK_COMPLETE Context');
  const withoutDigest = { ...context };
  delete withoutDigest.context_digest;
  if (context.context_digest !== contextDigest || computeDigest(withoutDigest) !== contextDigest) {
    throw new VNextHandoffError(
      'manifest-binding',
      'TASK_COMPLETE Context is not persisted at its digest address (content digest mismatch)',
    );
  }
}

// ============================================================
// Slice-local currentness consumption (S12-D-T02)
// ============================================================

/**
 * One entry of the Stage's persisted integration receipt chain, together
 * with the receipt-bound dependency integration facts of the Slice's
 * execution binding (§8.2 `dependency_bindings`).
 */
interface VNextSliceLocalChainEntry {
  readonly ref: IntegrationReceiptRef;
  readonly dependencyBindings: readonly VNextDependencyBinding[];
}

/**
 * S12-E REPAIR-FINAL: read ONE receipt addressed by digest from a persisted
 * receipt category chain (the chain must be valid).  Returns null when the
 * digest-addressed receipt does not exist; a broken chain or an unreadable /
 * non-root-bound file fails closed.
 */
interface VNextUpstreamChainReceipt {
  readonly digest: string;
  readonly type: string;
  readonly stage_id: string;
  readonly slice_id: string | undefined;
  readonly payload: Record<string, unknown>;
}

function readUpstreamReceipt(
  root: string,
  directory: string,
  digest: string,
  category: string,
): VNextUpstreamChainReceipt | null {
  const chainResult = verifyReceiptChain(directory);
  if (!chainResult.valid) {
    throw new VNextHandoffError('admission-invalid', `${category} Receipt chain is invalid`);
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new VNextHandoffError(
      'admission-invalid',
      `${category} Receipt directory could not be read: ${directory}`,
    );
  }
  const file = names.find((name) => name === `${digest}.json`);
  if (file === undefined) return null;
  const fullPath = path.join(directory, file);
  const opened = openNoFollowRead(root, fullPath);
  if (!opened.ok) {
    throw new VNextHandoffError('path-escape', `${category} Receipt is not root-bound: ${file}`);
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
    const receipt = validateReceipt(parsed);
    if (receipt.digest !== digest) {
      throw new VNextHandoffError(
        'admission-invalid',
        `${category} Receipt ${file} is not digest-addressed by ${digest}`,
      );
    }
    if (!verifyReceiptDigest(fullPath)) {
      throw new VNextHandoffError('admission-invalid', `${category} Receipt ${file} has an invalid digest`);
    }
    const payload = receipt.payload;
    if (!isRecord(payload)) {
      throw new VNextHandoffError('admission-invalid', `${category} Receipt payload must be a JSON object`);
    }
    return {
      digest: receipt.digest,
      type: receipt.type,
      stage_id: receipt.stage_id,
      slice_id: receipt.slice_id,
      payload,
    };
  } catch (error) {
    if (error instanceof VNextHandoffError) throw error;
    throw new VNextHandoffError(
      'admission-invalid',
      `${category} Receipt ${file} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** The digest of the Worker (TASK_COMPLETE) chain tip of one Slice (null
 *  when no Worker receipts exist). */
function workerReceiptChainTipDigest(root: string, stageId: string, sliceId: string): string | null {
  const directory = tasksReceiptDir(root, stageId, sliceId);
  const chainResult = verifyReceiptChain(directory);
  if (!chainResult.valid) {
    throw new VNextHandoffError(
      'admission-invalid',
      `vNext Worker Receipt chain is invalid for ${stageId}/${sliceId}`,
    );
  }
  const tipPath = chainResult.receipts[chainResult.receipts.length - 1];
  if (tipPath === undefined) return null;
  return path.basename(tipPath).replace(/\.json$/, '');
}

/**
 * Read the current INTEGRATION_PASS receipt chain of every Slice (slice-local
 * mode only, §8.7). Each persisted receipt must carry the receipt-bound
 * stage/slice contract digests and the merged canonical HEAD (`commit_sha`)
 * the slice-level currentness criterion consumes; a legacy/v2 Integration
 * Receipt without the binding fields can never back a slice-local
 * currentness claim and fails closed (never guessed around).
 *
 * S12-D-T02 (§8.3) + T04b (user authorization): the payload schema_version
 * is discriminated FIRST through the shared credential helper — v2 receipts
 * carrying binding fields are illegal credentials in a slice-local Stage
 * (BINDING.MODE_MIXED), a schema_version 3 receipt IS the legal slice-local
 * credential (its three binding fields are validated against the Manifest
 * contract digests and the recomputed execution binding through the shared
 * cv-validation helpers), and unknown future versions (>3) fail closed
 * explicitly (BINDING.SCHEMA_FUTURE).
 */

function historicalIntegrationManifestFor(
  manifest: VNextManifest,
  payload: Record<string, unknown>,
  dispositions: readonly ReplanAncestorDispositionRecord[],
  label: string,
): VNextManifest {
  const manifestDigest = factDigest(payload.manifest_digest, `${label}.manifest_digest`, 64);
  const planDigest = factDigest(payload.plan_digest, `${label}.plan_digest`, 64);
  const snapshotDigest = factDigest(payload.snapshot_digest, `${label}.snapshot_digest`, 40);
  const tupleMatches = (value: { readonly stage_id: string; readonly manifest_digest: string; readonly plan_digest: string; readonly snapshot_digest: string }): boolean =>
    value.stage_id === manifest.stage_id &&
    value.manifest_digest === manifestDigest &&
    value.plan_digest === planDigest &&
    value.snapshot_digest === snapshotDigest;
  const generationMatches = dispositions.filter((record) => tupleMatches(record.dispositionFact.snapshot));
  if (generationMatches.length > 1) {
    throw new VNextHandoffError(
      'manifest-binding',
      `${label} has multiple persisted generation authorities (${generationMatches.length})`,
    );
  }
  if (generationMatches.length === 1) {
    return buildVNextHistoricalManifest(manifest, generationMatches[0].dispositionFact.snapshot);
  }
  const previousMatches = dispositions.filter((record) => tupleMatches(record.dispositionFact.previous_snapshot));
  if (previousMatches.length !== 1) {
    throw new VNextHandoffError(
      'manifest-binding',
      `${label} requires exactly one persisted historical disposition (found ${previousMatches.length})`,
    );
  }
  return buildVNextHistoricalManifest(manifest, previousMatches[0].dispositionFact.previous_snapshot);
}

/** Read exactly one v2 Stage Plan + one fresh v2 SPV fact; v1 facts are rejected. */
function readVNextIntegrationReceiptChain(
  root: string,
  manifest: VNextManifest,
  historicalInvalidatedTaskIds: ReadonlySet<string> = new Set(),
): VNextSliceLocalChainEntry[] {
  const chain: VNextSliceLocalChainEntry[] = [];
  const replanDispositions = loadAncestorReplanDispositionRecords(root, manifest.stage_id);
  for (const slice of manifest.slices) {
    if (taskIdsForSlice(manifest, slice).some((taskId) => historicalInvalidatedTaskIds.has(taskId))) continue;
    const directory = integrationReceiptDir(root, manifest.stage_id, slice.slice_id);
    if (canonicalPathWithinRoot(root, directory) === null) {
      throw new VNextHandoffError('path-escape', 'vNext Integration Receipt directory escapes the project root');
    }
    let names: string[];
    try {
      names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new VNextHandoffError(
        'admission-invalid',
        `vNext Integration Receipt directory could not be read: ${directory}`,
      );
    }
    if (names.length === 0) continue;

    const chainResult = verifyReceiptChain(directory);
    if (!chainResult.valid) {
      throw new VNextHandoffError(
        'admission-invalid',
        `vNext Integration Receipt chain is invalid for ${manifest.stage_id}/${slice.slice_id}`,
      );
    }
    // S12-E REPAIR-FINAL: only the INTEGRATION_PASS chain TIP is a CURRENT
    // credential.  Historical chain members are still fully validated below
    // (schema, digest, stage/slice, binding fields) but never contribute
    // currentness facts.
    const orderedChainPaths = chainResult.receipts;
    const tipPath = orderedChainPaths[orderedChainPaths.length - 1];
    const tipName = tipPath === undefined ? null : path.basename(tipPath);
    for (const name of names) {
      const file = path.join(directory, name);
      const opened = openNoFollowRead(root, file);
      if (!opened.ok) {
        throw new VNextHandoffError('path-escape', `vNext Integration Receipt is not root-bound: ${name}`);
      }
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
        const receipt = validateReceipt(parsed);
        if (receipt.type !== 'INTEGRATION_PASS') {
          throw new VNextHandoffError(
            'admission-invalid',
            `Receipt ${name} is not an INTEGRATION_PASS fact in the integration category`,
          );
        }
        if (!verifyReceiptDigest(file)) {
          throw new VNextHandoffError('admission-invalid', `Receipt ${name} has an invalid digest`);
        }
        if (receipt.stage_id !== manifest.stage_id || receipt.slice_id !== slice.slice_id) {
          throw new VNextHandoffError(
            'manifest-binding',
            'vNext Integration Receipt stage/slice binding is invalid',
          );
        }
        const payload = receipt.payload;
        if (!isRecord(payload)) {
          throw new VNextHandoffError(
            'admission-invalid',
            'INTEGRATION_PASS payload must be a JSON object',
          );
        }
        if (tipName !== null && name !== tipName) {
          const historicalManifest = historicalIntegrationManifestFor(
            manifest,
            payload,
            replanDispositions,
            `INTEGRATION_PASS ${manifest.stage_id}/${slice.slice_id}/${receipt.digest}`,
          );
          const historicalSlice = historicalManifest.slices.find((candidate) => candidate.slice_id === slice.slice_id);
          if (historicalSlice === undefined) {
            throw new VNextHandoffError('manifest-binding', 'historical Integration receipt references a foreign Slice');
          }
          validateVNextHistoricalIntegrationReceipt(
            root,
            receipt,
            historicalManifest,
            historicalSlice.slice_id,
            readGitHead(root),
            factDigest(payload.snapshot_digest, 'historical INTEGRATION_PASS.snapshot_digest', 40),
          );
          // Historical chain members are fully validated against their own
          // persisted generation before they are excluded from currentness.
          continue;
        }
        // S12-D-T02 (§8.3) + T04b (user authorization): explicit credential
        // schema_version discrimination runs BEFORE the binding-field reads —
        // a v2 receipt carrying binding fields is an illegal credential in a
        // slice-local Stage (BINDING.MODE_MIXED), a slice-local (3) receipt
        // IS the legal credential of a slice-local Stage (S12-D REPLAN), and
        // an unknown future version (>3) fails closed explicitly. Same
        // semantics as the shared credentialSchemaVersionMismatch helper.
        const schemaMismatch = credentialSchemaVersionMismatch(
          payload.schema_version,
          manifest.binding !== undefined,
          'INTEGRATION_PASS.payload',
        );
        if (schemaMismatch !== null) {
          throw new VNextHandoffError('admission-invalid', schemaMismatch.message);
        }
        if (payload.receipt_chain_valid !== true) {
          throw new VNextHandoffError(
            'admission-invalid',
            'INTEGRATION_PASS Receipt does not assert a valid vNext Receipt chain',
          );
        }
        // Slice-local currentness requires the receipt-bound contract
        // digests (§8.5); a legacy/v2 Receipt without them cannot be
        // consumed by the slice-local path and fails closed.
        const stageContractDigest = factDigest(
          payload.stage_contract_digest,
          'INTEGRATION_PASS.stage_contract_digest',
          64,
        );
        const sliceContractDigest = factDigest(
          payload.slice_contract_digest,
          'INTEGRATION_PASS.slice_contract_digest',
          64,
        );
        const integrationHead = factDigest(payload.commit_sha, 'INTEGRATION_PASS.commit_sha', 40);
        // §8.2 dependency_bindings (Phase 1 serial execution: empty or a
        // single dependency). Kernel closed validator, fail-closed shape.
        // S12-D repair (v3 consumer chain, read-side fail-closed): a v3
        // INTEGRATION_PASS credential MUST carry the field — the write side
        // always persists it (an empty array for a no-dependency slice), so
        // a missing or non-array value is an explicit rejection, never a
        // silent empty-list recompute (an empty-list recompute would
        // wrongly exempt a dependency slice whose persisted binding facts
        // were dropped, and would diverge from the write-side gate).
        const rawDependencies = payload.dependency_bindings;
        if (rawDependencies === undefined || !Array.isArray(rawDependencies)) {
          throw new VNextHandoffError(
            'admission-invalid',
            'INTEGRATION_PASS.dependency_bindings is required on a v3 credential and must be an array',
          );
        }
        const dependencyBindings: VNextDependencyBinding[] = [];
        for (const [index, raw] of rawDependencies.entries()) {
          try {
            validateDependencyBinding(raw);
          } catch (error) {
            throw new VNextHandoffError(
              'admission-invalid',
              `INTEGRATION_PASS.dependency_bindings[${index}] is malformed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          dependencyBindings.push(raw as VNextDependencyBinding);
        }
        // T04b (user authorization): in slice-local mode the v3 credential's
        // three binding fields are validated through the SHARED cv-validation
        // helpers (imported, never copied) — 64-hex shape, exact match with
        // the Manifest stage/slice contract digests and the recomputed
        // execution binding (kernel bindings.ts oracle over the
        // receipt-bound dependency bindings and the credential's own base
        // snapshot). A v3 credential that is not self-consistent fails
        // closed here, before it can back a currentness claim. The schema
        // discrimination above already rejected v2-in-slice-local
        // (MODE_MIXED) and unknown future versions (SCHEMA_FUTURE).
        assertSliceLocalCredentialBindingFields(
          payload,
          'INTEGRATION_PASS.payload',
          manifest.binding !== undefined
            ? computeSliceLocalCredentialExpectation(
                manifest,
                slice.slice_id,
                dependencyBindings,
                payload,
              )
            : undefined,
        );
        if (tipName !== null && name !== tipName) {
          // Historical INTEGRATION_PASS chain member: fully validated above
          // but never a CURRENT credential (the chain tip alone is current).
          continue;
        }
        // S12-E REPAIR-FINAL — complete admission-chain semantics: the
        // referenced upstream credentials must EXIST in their persisted
        // chains (each chain valid), bind the same stage/slice, and carry
        // the full field semantics (TASK_COMPLETE changed_files non-empty /
        // evidence_ref bound / context bound / mode+outcome; CV_RESULT
        // verdict PASS bound to the Worker chain tip; SLICE_COMMIT commit_sha
        // a real Git commit on the current branch).  Digest self-consistency
        // and outer chain validity are never sufficient — a semantically
        // incomplete upstream credential fails closed and can never back a
        // CURRENT claim.
        const sliceCommitDigest = factDigest(
          payload.slice_commit_receipt_digest,
          'INTEGRATION_PASS.slice_commit_receipt_digest',
          64,
        );
        const workerDigest = factDigest(
          payload.worker_receipt_digest,
          'INTEGRATION_PASS.worker_receipt_digest',
          64,
        );
        const cvDigest = factDigest(
          payload.cv_receipt_digest,
          'INTEGRATION_PASS.cv_receipt_digest',
          64,
        );
        const workerReceipt = readUpstreamReceipt(
          root,
          tasksReceiptDir(root, manifest.stage_id, slice.slice_id),
          workerDigest,
          'vNext Worker',
        );
        if (workerReceipt === null || workerReceipt.type !== 'TASK_COMPLETE') {
          throw new VNextHandoffError(
            'admission-invalid',
            'INTEGRATION_PASS references a TASK_COMPLETE Receipt that does not exist',
          );
        }
        if (workerReceipt.stage_id !== manifest.stage_id || workerReceipt.slice_id !== slice.slice_id) {
          throw new VNextHandoffError(
            'manifest-binding',
            'INTEGRATION_PASS upstream Worker Receipt binding is invalid',
          );
        }
        assertUpstreamTaskCompleteSemantics(workerReceipt.payload, slice.evidence_path, 'TASK_COMPLETE', {
          verifyContextPersisted: (contextRef, contextDigest) =>
            assertUpstreamContextPersisted(root, contextRef, contextDigest),
          stageHasBinding: manifest.binding !== undefined,
          expectedSliceLocalBinding: vnextUpstreamSliceLocalBindingExpectation(
            manifest,
            slice.slice_id,
            dependencyBindings,
            workerReceipt.payload,
            'TASK_COMPLETE',
          ),
          allowedScope: vnextSliceAllowedScope(manifest, slice.slice_id),
        });
        const workerChainTipDigest = workerReceiptChainTipDigest(
          root,
          manifest.stage_id,
          slice.slice_id,
        );
        if (workerChainTipDigest === null) {
          throw new VNextHandoffError(
            'admission-invalid',
            'INTEGRATION_PASS references a Worker chain that does not exist',
          );
        }
        const cvReceipt = readUpstreamReceipt(
          root,
          cvReceiptDir(root, manifest.stage_id, slice.slice_id),
          cvDigest,
          'vNext CV',
        );
        if (cvReceipt === null || cvReceipt.type !== 'CV_PASS') {
          throw new VNextHandoffError(
            'admission-invalid',
            'INTEGRATION_PASS references a CV_PASS Receipt that does not exist',
          );
        }
        if (cvReceipt.stage_id !== manifest.stage_id || cvReceipt.slice_id !== slice.slice_id) {
          throw new VNextHandoffError(
            'manifest-binding',
            'INTEGRATION_PASS upstream CV Receipt binding is invalid',
          );
        }
        assertUpstreamCvPassSemantics(
          cvReceipt.payload,
          'CV_RESULT',
          {
            stageHasBinding: manifest.binding !== undefined,
            expectedSliceLocalBinding: vnextUpstreamSliceLocalBindingExpectation(
              manifest,
              slice.slice_id,
              dependencyBindings,
              cvReceipt.payload,
              'CV_RESULT',
            ),
          },
          workerChainTipDigest,
        );
        const sliceCommitReceipt = readUpstreamReceipt(
          root,
          committerReceiptDir(root, manifest.stage_id, slice.slice_id),
          sliceCommitDigest,
          'vNext Slice Commit',
        );
        if (sliceCommitReceipt === null || sliceCommitReceipt.type !== 'SLICE_COMMIT') {
          throw new VNextHandoffError(
            'admission-invalid',
            'INTEGRATION_PASS references a SLICE_COMMIT Receipt that does not exist',
          );
        }
        if (
          sliceCommitReceipt.stage_id !== manifest.stage_id ||
          sliceCommitReceipt.slice_id !== slice.slice_id
        ) {
          throw new VNextHandoffError(
            'manifest-binding',
            'INTEGRATION_PASS upstream SLICE_COMMIT Receipt binding is invalid',
          );
        }
        assertUpstreamSliceCommitSemantics(sliceCommitReceipt.payload, 'SLICE_COMMIT', {
          stageHasBinding: manifest.binding !== undefined,
          expectedSliceLocalBinding: vnextUpstreamSliceLocalBindingExpectation(
            manifest,
            slice.slice_id,
            dependencyBindings,
            sliceCommitReceipt.payload,
            'SLICE_COMMIT',
          ),
          allowedScope: vnextSliceAllowedScope(manifest, slice.slice_id),
        });
        if (sliceCommitReceipt.payload.commit_sha !== integrationHead) {
          throw new VNextHandoffError(
            'manifest-binding',
            'INTEGRATION_PASS.commit_sha does not match the upstream SLICE_COMMIT credential',
          );
        }
        assertCommitOnCurrentHead(root, integrationHead, 'INTEGRATION_PASS.commit_sha');
        chain.push({
          ref: {
            slice_id: slice.slice_id,
            receipt_digest: receipt.digest,
            integration_head_sha: integrationHead,
            stage_contract_digest: stageContractDigest,
            slice_contract_digest: sliceContractDigest,
          },
          dependencyBindings,
        });
      } catch (error) {
        if (error instanceof VNextHandoffError) throw error;
        throw new VNextHandoffError(
          'admission-invalid',
          `vNext Integration Receipt ${name} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        fs.closeSync(opened.fd);
      }
    }
  }
  return chain;
}

/**
 * The set of Slice ids that are INTEGRATED and CURRENT in slice-local mode
 * (§8.5/§10.5): an integrated slice whose stage/slice contract, dependency
 * bindings and integration receipt chain are current stays valid across a
 * replan, and its historical whole-plan digest bindings are legal history.
 *
 * Legacy manifests (no `binding`) return the empty set: the legacy read path
 * stays strict and untouched. Un-integrated slices are never exempted
 * (§8.5: no auto carry-forward across Plan revisions). A slice whose
 * currentness cannot be evaluated (malformed chain/binding facts) fails
 * closed through the typed kernel oracle errors.
 */
function readVNextCurrentIntegratedSliceIds(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
  sliceLocalChain: readonly VNextSliceLocalChainEntry[],
  historicalInvalidatedTaskIds: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const current = new Set<string>();
  if (manifest.binding === undefined) return current;
  const chain = sliceLocalChain.length > 0 ? sliceLocalChain : readVNextIntegrationReceiptChain(root, manifest);
  if (chain.length === 0) return current;
  const bySlice = new Map(chain.map((entry) => [entry.ref.slice_id, entry] as const));
  const receiptChain = chain.map((entry) => entry.ref);
  for (const slice of manifest.slices) {
    const entry = bySlice.get(slice.slice_id);
    if (entry === undefined) continue; // un-integrated: strict checks stay
    if (taskIdsForSlice(manifest, slice).some((taskId) => historicalInvalidatedTaskIds.has(taskId))) continue;
    try {
      if (
        isIntegratedSliceCurrent({
          manifest,
          sliceId: slice.slice_id,
          manifestDigest,
          planDigest: manifest.plan.plan_digest,
          stageContractDigest: entry.ref.stage_contract_digest,
          sliceContractDigest: entry.ref.slice_contract_digest,
          dependencyBindings: entry.dependencyBindings,
          integrationReceipts: receiptChain,
        })
      ) {
        current.add(slice.slice_id);
      }
    } catch (error) {
      if (error instanceof SchemaValidationError) {
        throw new VNextHandoffError(
          'manifest-binding',
          `Slice currentness evaluation failed closed for ${manifest.stage_id}/${slice.slice_id}: ${error.message}`,
        );
      }
      throw error;
    }
  }
  return current;
}

/**
 * Slice-local (S12-D repair, v3 consumer chain): the receipt-bound
 * dependency binding facts of one Slice, derived from the persisted
 * INTEGRATION_PASS chain of its declared dependency slices (§8.2). The same
 * facts the admission consumers used to compute the v3 credential's
 * execution binding (`readSliceLocalDependencyBindings`), re-derived here
 * from the read-side chain so `next` can recompute the expectation without
 * any filesystem or Git I/O beyond the already-read chain. A declared
 * dependency without a current INTEGRATION_PASS chain entry fails closed: a
 * v3 credential bound to it could never have been admitted (serial
 * execution order), so it is never guessed around.
 */
function sliceLocalDependencyBindingsForSlice(
  sliceLocalChain: readonly VNextSliceLocalChainEntry[],
  slice: VNextManifestSlice,
): VNextDependencyBinding[] {
  const bySlice = new Map(sliceLocalChain.map((entry) => [entry.ref.slice_id, entry] as const));
  const bindings: VNextDependencyBinding[] = [];
  for (const dependencyId of slice.depends_on ?? []) {
    const entry = bySlice.get(dependencyId);
    if (entry === undefined) {
      throw new VNextHandoffError(
        'manifest-binding',
        `slice-local dependency ${dependencyId} of ${slice.slice_id} has no current INTEGRATION_PASS Receipt; the v3 credential binding cannot be recomputed`,
      );
    }
    const binding: VNextDependencyBinding = {
      slice_id: dependencyId,
      slice_contract_digest: entry.ref.slice_contract_digest,
      integration_receipt_digest: entry.ref.receipt_digest,
      integration_head_sha: entry.ref.integration_head_sha,
    };
    try {
      validateDependencyBinding(binding);
    } catch (error) {
      throw new VNextHandoffError(
        'admission-invalid',
        `dependency binding of ${slice.slice_id} is malformed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    bindings.push(binding);
  }
  return bindings;
}

function readVNextWorkerFacts(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
  snapshotDigest: string,
  currentIntegratedSliceIds: ReadonlySet<string>,
  sliceLocalChain: readonly VNextSliceLocalChainEntry[],
  replanDispositions: readonly ReplanAncestorDispositionRecord[] = [],
): {
  workerFacts: VNextWorkerFact[];
  finalizeFacts: Map<string, VNextFinalizeFact>;
  historicalInvalidatedTaskIds: Set<string>;
} {
  const facts: VNextWorkerFact[] = [];
  const finalizeFacts = new Map<string, VNextFinalizeFact>();
  const historicalInvalidatedTaskIds = computeChainInvalidatedTaskIds(replanDispositions);
  const lineageReceiptExemptions = deriveLineageReceiptExemptions(replanDispositions);
  const matchesLineageBinding = (
    binding: { readonly stage_id: string; readonly manifest_digest: string; readonly plan_digest: string; readonly snapshot_digest: string; readonly task_id: string },
    taskId: string | undefined,
    receiptManifestDigest: string,
    receiptPlanDigest: string,
    receiptSnapshotDigest: string,
  ): boolean =>
    taskId !== undefined &&
    binding.stage_id === manifest.stage_id &&
    binding.manifest_digest === receiptManifestDigest &&
    binding.plan_digest === receiptPlanDigest &&
    binding.snapshot_digest === receiptSnapshotDigest &&
    binding.task_id === taskId;
  for (const slice of manifest.slices) {
    const receipts = readVNextTaskReceipts(root, manifest.stage_id, slice.slice_id);
    if (receipts.length === 0) continue;
    const taskIds = taskIdsForSlice(manifest, slice);
    const taskFacts = new Map<string, VNextWorkerFact>();
    const actionTokens = new Set<string>();
    const sliceBoundTuples = new Map<
      string,
      { manifestDigest: string; planDigest: string; proofIndexDigest: string }
    >();
    const finalizeReceiptGenerations = new Set<string>();
    let activeFinalizeGeneration: string | undefined;
    for (const receipt of receipts) {
      if (receipt.stage_id !== manifest.stage_id || receipt.slice_id !== slice.slice_id) {
        throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Receipt stage/slice binding is invalid');
      }
      const payload = receipt.payload;
      if (!isRecord(payload)) {
        throw new VNextHandoffError(
          'admission-invalid',
          'TASK_COMPLETE payload must be a JSON object',
        );
      }
      // S12-D repair (v3 consumer chain): explicit credential schema_version
      // discrimination through the shared helper runs BEFORE any fact read —
      // legacy mode stays v2-only, a v2 credential in a slice-local Stage is
      // an illegal credential (BINDING.MODE_MIXED), a slice-local (3)
      // credential IS the legal credential of a slice-local Stage, and
      // unknown future versions (>3) fail closed explicitly
      // (BINDING.SCHEMA_FUTURE).
      const schemaMismatch = credentialSchemaVersionMismatch(
        payload.schema_version,
        manifest.binding !== undefined,
        'TASK_COMPLETE.payload',
      );
      if (schemaMismatch !== null) {
        throw new VNextHandoffError('admission-invalid', schemaMismatch.message);
      }
      if (
        payload.outcome !== 'completed' ||
        (payload.mode !== 'implement-task' && payload.mode !== 'recover-task' && payload.mode !== 'finalize-slice')
      ) {
        throw new VNextHandoffError(
          'admission-invalid',
          'TASK_COMPLETE Receipt has no admitted implement/recover/finalize completion outcome',
        );
      }
      const actionToken = factString(payload.action_token, 'TASK_COMPLETE.action_token');
      if (actionTokens.has(actionToken)) {
        throw new VNextHandoffError('admission-invalid', `multiple TASK_COMPLETE facts reuse action_token "${actionToken}"`);
      }
      actionTokens.add(actionToken);
      const payloadMode = factString(payload.mode, 'TASK_COMPLETE.mode');
      if (payloadMode !== 'implement-task' && payloadMode !== 'recover-task' && payloadMode !== 'finalize-slice') {
        throw new VNextHandoffError(
          'admission-invalid',
          `TASK_COMPLETE payload mode "${payloadMode}" is outside the closed completion vocabulary`,
        );
      }
      const taskId = payloadMode === 'finalize-slice' ? undefined : factString(payload.task_id, 'TASK_COMPLETE.task_id');
      if (payloadMode === 'finalize-slice') {
        if (Object.prototype.hasOwnProperty.call(payload, 'task_id')) {
          throw new VNextHandoffError(
            'task-anchor-gap',
            'finalize-slice TASK_COMPLETE payload must not carry task_id',
          );
        }
      }
      const taskIndex = taskId ? taskIds.indexOf(taskId) : -1;
      if (payloadMode !== 'finalize-slice' && taskIndex < 0) {
        throw new VNextHandoffError('task-anchor-gap', `TASK_COMPLETE task "${taskId}" is not in the Manifest Slice`);
      }
      const currentManifestDigest = factDigest(payload.manifest_digest, 'TASK_COMPLETE.manifest_digest', 64);
      const planDigest = factDigest(payload.plan_digest, 'TASK_COMPLETE.plan_digest', 64);
      const currentProofIndexDigest = factDigest(payload.proof_index_digest, 'TASK_COMPLETE.proof_index_digest', 64);
      const currentSnapshotDigest = factDigest(payload.snapshot_digest, 'TASK_COMPLETE.snapshot_digest', 40);
      const finalizeGeneration = payloadMode === 'finalize-slice'
        ? `${currentManifestDigest}:${planDigest}:${currentSnapshotDigest}`
        : undefined;
      if (finalizeGeneration !== undefined) {
        if (finalizeReceiptGenerations.has(finalizeGeneration)) {
          throw new VNextHandoffError(
            'admission-invalid',
            `multiple finalize-slice TASK_COMPLETE facts reuse generation ${finalizeGeneration}`,
          );
        }
        finalizeReceiptGenerations.add(finalizeGeneration);
      }

      // A receipt is historical only when its complete (stage, Manifest, Plan,
      // snapshot, Task) tuple is bound by the persisted Replan lineage.  The
      // lineage consumer distinguishes dead invalidated receipts from exact
      // carry-forward receipts; neither category is inferred from a partial
      // tuple or from the current task projection.
      const finalizeLineage: VNextFinalizeLineage = payloadMode === 'finalize-slice'
        ? classifyVNextFinalizeLineage(
            manifest.stage_id,
            taskIds,
            currentManifestDigest,
            planDigest,
            currentSnapshotDigest,
            replanDispositions,
          )
        : { kind: 'current' };
      const isHistoricalInvalidated = lineageReceiptExemptions.invalidated.some((binding) =>
        matchesLineageBinding(
          binding,
          taskId,
          currentManifestDigest,
          planDigest,
          currentSnapshotDigest,
        ),
      );
      const isCarriedForward = payloadMode === 'finalize-slice'
        ? finalizeLineage.kind === 'carried-forward'
        : lineageReceiptExemptions.carriedForward.some((binding) =>
            matchesLineageBinding(
              binding,
              taskId,
              currentManifestDigest,
              planDigest,
              currentSnapshotDigest,
            ),
          );
      if (payloadMode === 'finalize-slice' && finalizeLineage.kind !== 'invalidated') {
        if (finalizeGeneration === undefined) {
          throw new VNextHandoffError('admission-invalid', 'finalize-slice generation binding is unavailable');
        }
        if (activeFinalizeGeneration !== undefined) {
          throw new VNextHandoffError(
            'admission-invalid',
            `multiple non-invalidated finalize-slice TASK_COMPLETE facts are ambiguous for ${manifest.stage_id}/${slice.slice_id}`,
          );
        }
        activeFinalizeGeneration = finalizeGeneration;
      }
      // A stale finalize-slice closure is ignored only after its exact
      // persisted tuple, historical Context, credential and scope have been
      // validated against the disposition's own previous_snapshot.
      if (finalizeLineage.kind === 'invalidated') {
        validateVNextInvalidatedFinalizeReceipt(
          root,
          manifest,
          slice,
          payload,
          finalizeLineage.dispositionFact,
          snapshotDigest,
        );
        continue;
      }
      if (isHistoricalInvalidated) {
        if (payload.evidence_ref !== slice.evidence_path) {
          throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE evidence_ref is not bound to the Manifest Slice');
        }
        factString(payload.context_ref, 'TASK_COMPLETE.context_ref');
        factDigest(payload.context_digest, 'TASK_COMPLETE.context_digest', 64);
        const changedFiles = unique(
          factStringArray(payload.changed_files, 'TASK_COMPLETE.changed_files').map((value, index) =>
            rootRelativeFactPath(root, value, `TASK_COMPLETE.changed_files[${index}]`),
          ),
        );
        if (changedFiles.length === 0) {
          throw new VNextHandoffError('execution-scope-gap', 'TASK_COMPLETE.changed_files cannot be empty');
        }
        // The active invalidation set already accounts for newer carry-forward records.
        // Do not mark a superseded historical receipt as an invalidated task again.
        continue;
      }
      if (taskId && taskFacts.has(taskId)) {
        throw new VNextHandoffError('admission-invalid', `multiple TASK_COMPLETE facts are ambiguous for task "${taskId}"`);
      }
      // S12-D repair (v3 consumer chain): in slice-local mode the v3 Worker
      // credential's three binding fields are validated through the SHARED
      // cv-validation helpers — 64-hex shape, exact match with the Manifest
      // stage/slice contract digests and the recomputed execution binding
      // (kernel bindings.ts oracle over the receipt-bound dependency
      // bindings and the credential's OWN payload snapshot — the historical
      // base snapshot the admission consumer computed against at write
      // time, NOT the current authority snapshot; after an integration
      // commit + fresh SPV the current snapshot legitimately advances while
      // the historical credential stays bound to its own snapshot, and a
      // base-snapshot mismatch must never block an integrated CURRENT
      // slice, FR-020). A v3 credential that is not self-consistent fails
      // closed before it can back any dispatch or CV projection. A v2
      // credential carrying binding fields was already rejected by the
      // discrimination above.
      assertSliceLocalCredentialBindingFields(
        payload,
        'TASK_COMPLETE.payload',
        manifest.binding !== undefined
          ? computeSliceLocalCredentialExpectation(
              manifest,
              slice.slice_id,
              sliceLocalDependencyBindingsForSlice(sliceLocalChain, slice),
              payload,
            )
          : undefined,
      );
      const taskRefDescriptor = taskId !== undefined
        ? manifest.reference_index[slice.proof_index.task_refs[taskIndex]]
        : undefined;
      if (taskId !== undefined && taskRefDescriptor === undefined) {
        throw new VNextHandoffError('task-anchor-gap', `Task descriptor for "${taskId}" is unavailable`);
      }
      let taskScopeBinding: { readonly task_ref: string; readonly execution_scope: VNextExecutionScope } | undefined;
      if (taskId !== undefined && taskRefDescriptor !== undefined) {
        taskScopeBinding = manifest.task_scopes[taskId];
        if (taskScopeBinding === undefined || taskScopeBinding.task_ref !== taskRefDescriptor.ref) {
          throw new VNextHandoffError('execution-scope-gap', `Task "${taskId}" scope is not bound to its Manifest ref`);
        }
      }
      const taskScope = taskScopeBinding?.execution_scope;
      const proofIndexDigest = computeDigest(slice.proof_index);
      // S12-D-T02 slice-local exemption: an INTEGRATED + CURRENT slice keeps
      // its proof valid across a replan — the whole-plan digests bound by its
      // historical TASK_COMPLETE facts are legal history (§8.5) and must not
      // be rejected as stale. Un-integrated slices keep the strict check.
      const exempt = currentIntegratedSliceIds.has(slice.slice_id) || isCarriedForward;
      if (
        currentManifestDigest !== manifestDigest ||
        planDigest !== manifest.plan.plan_digest ||
        currentProofIndexDigest !== proofIndexDigest
      ) {
        if (!exempt) {
          throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Receipt is stale or not bound to the active Manifest/Plan');
        }
        // The exempted Slice's Worker facts must all bind the SAME
        // historical tuple: mixing Plan revisions inside one integrated
        // Slice is never legal history and fails closed.
        const prior = sliceBoundTuples.get(slice.slice_id);
        if (
          prior !== undefined &&
          (prior.manifestDigest !== currentManifestDigest ||
            prior.planDigest !== planDigest ||
            prior.proofIndexDigest !== currentProofIndexDigest)
        ) {
          throw new VNextHandoffError(
            'manifest-binding',
            'TASK_COMPLETE Receipts of the integrated Slice bind inconsistent historical Manifest/Plan tuples',
          );
        }
        sliceBoundTuples.set(slice.slice_id, {
          manifestDigest: currentManifestDigest,
          planDigest,
          proofIndexDigest: currentProofIndexDigest,
        });
      }
      // A Worker fact produced during execution binds the admitted snapshot
      // (or a legal descendant execution commit). It must stay on the
      // admission snapshot's Git chain; an unrelated/reverted snapshot fails
      // closed without discarding the already-admitted execution facts. For
      // an exempted integrated slice the snapshot is historical and only
      // needs to be reachable from the current branch.
      assertReceiptSnapshotOnExecutionChain(root, currentSnapshotDigest, snapshotDigest, 'TASK_COMPLETE Receipt', exempt);
      const contextRef = factString(payload.context_ref, 'TASK_COMPLETE.context_ref');
      const contextDigest = factDigest(payload.context_digest, 'TASK_COMPLETE.context_digest', 64);
      assertWorkerContextBinding(
        root,
        manifest,
        exempt ? currentManifestDigest : manifestDigest,
        exempt ? planDigest : manifest.plan.plan_digest,
        currentSnapshotDigest,
        slice,
        taskId,
        taskScope,
        taskRefDescriptor?.ref,
        exempt ? currentProofIndexDigest : proofIndexDigest,
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
      // ADR-021 (user authorization A7): every admitted TASK_COMPLETE
      // Receipt must declare the Evidence and Plan projection paths in its
      // changed_files — the declaration is per-receipt and unconditional.
      // The Evidence/Plan projections are always declarable regardless of
      // worktree state (A7 worker-admission counterpart allows declaring
      // them even when HEAD-clean), so a multi-task Slice recovered in one
      // pass re-admits each task with its own files plus Evidence/Plan.
      for (const requiredPath of [slice.evidence_path, manifest.plan.ref]) {
        const canonicalRequiredPath = rootRelativeFactPath(root, requiredPath, 'Manifest execution projection path');
        if (!changedFileSet.has(canonicalRequiredPath)) {
          throw new VNextHandoffError(
            'execution-scope-gap',
            `TASK_COMPLETE.changed_files must include the admitted execution projection path: ${canonicalRequiredPath}`,
          );
        }
      }
      let allowedScope: readonly string[];
      if (taskId !== undefined) {
        const priorScope = taskIds
          .slice(0, taskIndex)
          .flatMap((priorTaskId) => taskAllowedScope(root, manifest, slice, priorTaskId));
        allowedScope = unique([
          ...priorScope,
          ...taskAllowedScope(root, manifest, slice, taskId),
        ]);
      } else {
        // finalize-slice allowedScope is the entire slice task scopes + projections
        allowedScope = unique([
          ...taskIds.flatMap((id) => taskAllowedScope(root, manifest, slice, id)),
          slice.evidence_path,
          manifest.plan.ref,
        ]);
      }
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
      if (taskId !== undefined) {
        taskFacts.set(taskId, fact);
      } else {
        finalizeFacts.set(slice.slice_id, fact as unknown as VNextFinalizeFact);
      }
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
  return { workerFacts: facts, finalizeFacts, historicalInvalidatedTaskIds };
}

interface VNextCvReceiptFacts {
  /** The CV chain tip Receipt, or null when no CV Receipt exists for the Slice. */
  readonly tip: Receipt | null;
  /** Whether the persisted CV history contains a CV_REPAIR fact. */
  readonly hasRepairHistory: boolean;
  /** Number of CV_REPAIR facts in the validated chain (canonical repair_attempt). */
  readonly repairCount: number;
  /** The worker_receipt_digest bound by the chain tip (undefined when tip is null). */
  readonly tipWorkerReceiptDigest?: string;
}

/**
 * runtime-cv-linked-lineage: resolve the linked Worker task identity and
 * Receipt digest a persisted CV fact validates, by reading the digest-addressed
 * TASK_COMPLETE receipt of the SAME Slice root-bound and validating its task
 * identity before either value is trusted. Returns null — never throws — when
 * without a well-formed worker_receipt_digest/task_id all fail closed into
 * "no identity", which denies the ancestor exemption unless the closed
 * taskless finalize-slice Worker credential proves a whole-Slice lineage.
 * or partial linked Worker receipt, a broken Worker chain, or a payload
 * without a well-formed worker_receipt_digest/task_id all fail closed into
 * "no identity", which denies the ancestor exemption and leaves the CV
 * subject to the strict current-Manifest binding validation.
 */
function linkedWorkerReceiptForCvReceipt(
  root: string,
  manifest: VNextManifest,
  sliceId: string,
  payload: Record<string, unknown>,
): { readonly taskId?: string; readonly workerReceiptDigest: string } | null {
  let workerDigest: string;
  try {
    workerDigest = factDigest(payload['worker_receipt_digest'], 'CV_RESULT.worker_receipt_digest', 64);
  } catch {
    return null;
  }
  try {
    const receipt = readUpstreamReceipt(
      root,
      tasksReceiptDir(root, manifest.stage_id, sliceId),
      workerDigest,
      'TASK_COMPLETE',
    );
    if (receipt === null) return null;
    if (receipt.type !== 'TASK_COMPLETE') return null;
    if (receipt.stage_id !== manifest.stage_id || receipt.slice_id !== sliceId) return null;
    const taskId = receipt.payload['task_id'];
    if (typeof taskId === 'string' && taskId.length > 0) return { taskId, workerReceiptDigest: workerDigest };
    if (receipt.payload['mode'] === 'finalize-slice' && !Object.prototype.hasOwnProperty.call(receipt.payload, 'task_id')) return { workerReceiptDigest: workerDigest };
    return null;
  } catch {
    // Fail closed: an unprovable linked-Worker identity never qualifies a CV
    // for the dead-epoch exemption; the strict binding validation below then
    // decides the CV receipt's fate with its own precise error surface.
    return null;
  }
}

/**
 * runtime-cv-linked-lineage (supersedes the runtime-cv-epoch-fix whole-Slice
 * aggregate): whether ONE persisted CV Receipt belongs to an invalidated
 * ancestor Replan epoch of this Slice. The exemption applies ONLY when ALL
 * of the following hold:
 *  - the receipt's manifest_digest/plan_digest/snapshot_digest triple equals
 *    a persisted disposition's previous_snapshot tuple EXACTLY (the whole
 *    prior epoch this fact was admitted in);
 *  - the CV's OWN LINKED WORKER TASK identity — resolved root-bound from the
 *    digest-addressed linked TASK_COMPLETE receipt — is declared by the
 *    current Manifest projection of the Slice;
 *  - THAT exact disposition lists the linked task in invalidated_task_ids and
 *    not in its carry_forward_task_ids; and
 *  - the current validated Worker facts contain a DIFFERENT Receipt for the
 *    same linked task, proving that the stale CV is superseded by newer
 *    admitted execution rather than by lineage metadata alone.
 * A carry-forward disposition without that newer Worker Receipt, a missing,
 * foreign, malformed or partial linked Worker receipt, a current tuple, and
 * any non-matching stale CV fact keep failing closed against the current
 * Manifest bindings.
 */
function isFullyInvalidatedAncestorCvPayload(
  root: string,
  manifest: VNextManifest,
  sliceId: string,
  declaredTaskIds: readonly string[],
  payload: unknown,
  dispositions: readonly ReplanAncestorDispositionRecord[],
  currentWorkerFacts: readonly VNextWorkerFact[],
): boolean {
  if (!isRecord(payload) || declaredTaskIds.length === 0 || dispositions.length === 0) return false;
  const manifestDigest = payload['manifest_digest'];
  const planDigest = payload['plan_digest'];
  const snapshotDigest = payload['snapshot_digest'];
  if (typeof manifestDigest !== 'string' || typeof planDigest !== 'string' || typeof snapshotDigest !== 'string') {
    return false;
  }
  // Collect ONLY the dispositions whose previous_snapshot claims this CV's
  // tuple as its own epoch; the linked-Worker read below must never run for
  // current-tuple receipts that the exemption could not grant anyway.
  const matchingIndexes: number[] = [];
  for (let i = 0; i < dispositions.length; i++) {
    const disp = dispositions[i].dispositionFact;
    if (
      manifestDigest !== disp.previous_snapshot.manifest_digest ||
      planDigest !== disp.previous_snapshot.plan_digest ||
      snapshotDigest !== disp.previous_snapshot.snapshot_digest
    ) {
      continue;
    }
    matchingIndexes.push(i);
  }
  if (matchingIndexes.length === 0) return false;
  const linkedWorker = linkedWorkerReceiptForCvReceipt(root, manifest, sliceId, payload);
  if (linkedWorker === null) return false;
  if (linkedWorker.taskId !== undefined && !declaredTaskIds.includes(linkedWorker.taskId)) return false;
  for (const i of matchingIndexes) {
    const disp = dispositions[i].dispositionFact.disposition;
    const invalidated = linkedWorker.taskId === undefined
      ? declaredTaskIds.every((taskId) => disp.invalidated_task_ids.includes(taskId) && !disp.carry_forward_task_ids.includes(taskId))
      : disp.invalidated_task_ids.includes(linkedWorker.taskId) && !disp.carry_forward_task_ids.includes(linkedWorker.taskId);
    if (!invalidated) continue;
    // A disposition's carry-forward status is only lineage metadata. The
    // stale CV can be skipped only after the current validated Worker read
    // proves a different Receipt for this task or Slice-wide finalize. This
    // prevents carry-forward-only history from suppressing current bindings.
    const hasNewerValidatedWorker = currentWorkerFacts.some(
      (fact) =>
        fact.slice.slice_id === sliceId &&
        (linkedWorker.taskId === undefined || fact.taskId === linkedWorker.taskId) &&
        fact.workerReceiptDigest !== linkedWorker.workerReceiptDigest,
    );
    if (hasNewerValidatedWorker) return true;
  }
  return false;
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
 *
 * runtime-cv-linked-lineage: `replanDispositions` carries the persisted
 * ancestor ReplanDisposition chain and `currentWorkerFacts` carries the
 * already-validated Worker facts from the same next-action read. A CV Receipt
 * whose WHOLE prior tuple matches a persisted disposition's previous_snapshot,
 * whose OWN LINKED WORKER task is invalidated by THAT disposition with no
 * carry-forward, and whose linked task has a DIFFERENT validated Worker Receipt
 * is legal history of a dead epoch: it is skipped BEFORE current-Manifest
 * binding validation instead of failing closed on old credentials (for example
 * CV_RESULT.stage_contract_digest). A carry-forward disposition by itself is
 * not enough; malformed, foreign, current-epoch, partially-invalidated and
 * non-invalidated stale CV receipts keep failing closed.
 */
function readVNextCvReceiptFacts(
  root: string,
  manifest: VNextManifest,
  sliceId: string,
  binding: VNextCvPayloadBinding,
  admittedSnapshot: string,
  sliceLocalChain: readonly VNextSliceLocalChainEntry[],
  allowHistoricalSnapshot = false,
  replanDispositions: readonly ReplanAncestorDispositionRecord[] = [],
  currentWorkerFacts: readonly VNextWorkerFact[] = [],
): VNextCvReceiptFacts {
  const directory = cvReceiptDir(root, manifest.stage_id, sliceId);
  if (canonicalPathWithinRoot(root, directory) === null) {
    throw new VNextHandoffError('path-escape', 'vNext CV Receipt directory escapes the project root');
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tip: null, hasRepairHistory: false, repairCount: 0 };
    throw new VNextHandoffError(
      'admission-invalid',
      `vNext CV Receipt directory could not be read: ${directory}`,
    );
  }
  if (names.length === 0) return { tip: null, hasRepairHistory: false, repairCount: 0 };
  // The Slice must be declared by the Manifest — resolved once for the whole
  // directory scan (runtime-cv-linked-lineage: also feeds the
  // ancestor-invalidation exemption's linked-task membership check).
  const slice = manifest.slices.find((candidate) => candidate.slice_id === sliceId);
  if (slice === undefined) {
    throw new VNextHandoffError('task-anchor-gap', `Manifest does not declare slice ${sliceId}`);
  }
  const declaredTaskIds = taskIdsForSlice(manifest, slice);

  const chain = verifyReceiptChain(directory);
  if (!chain.valid) {
    throw new VNextHandoffError(
      'admission-invalid',
      `vNext CV Receipt chain is invalid for ${manifest.stage_id}/${sliceId}`,
    );
  }
  // repair (no skip-before-validation): the directory scan may NEVER
  // early-return before reading and validating the persisted CV Receipts.
  // Every historical generation must first complete its own closed schema,
  // outer tuple, worker tip, action/Context/digest, CV sequence/chain and
  // generation validation below; only PROVEN invalidated ancestors are then
  // excluded per Receipt by the linked-lineage exemption. Unknown, partial,
  // mixed or current facts keep failing closed.
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
      if (receipt.stage_id !== manifest.stage_id || receipt.slice_id !== sliceId) {
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
      // S12-D repair (v3 consumer chain): explicit credential schema_version
      // discrimination through the shared helper runs BEFORE any binding-
      // field read — legacy mode stays v2-only, a v2 credential in a
      // slice-local Stage is an illegal credential (BINDING.MODE_MIXED), a
      // slice-local (3) credential IS the legal credential of a slice-local
      // Stage, and unknown future versions (>3) fail closed explicitly
      // (BINDING.SCHEMA_FUTURE). Same discrimination every other vNext
      // consumer applies.
      const schemaMismatch = credentialSchemaVersionMismatch(
        isRecord(receipt.payload) ? receipt.payload.schema_version : undefined,
        manifest.binding !== undefined,
        'CV_RESULT.payload',
      );
      if (schemaMismatch !== null) {
        throw new VNextHandoffError('admission-invalid', schemaMismatch.message);
      }
      // S12-D repair (v3 consumer chain): in slice-local mode the persisted
      // CV_RESULT credential's three binding fields are validated through
      // the SHARED cv-validation helpers — 64-hex shape (assertCredential-
      // SchemaVersion), exact match with the Manifest stage/slice contract
      // digests and the recomputed execution binding (kernel bindings.ts
      // oracle over the receipt-bound dependency bindings and the
      // credential's OWN payload snapshot — the historical base snapshot
      // CV admission computed against at write time, NOT the current
      // authority snapshot; after an integration commit + fresh SPV the
      // current snapshot legitimately advances while the historical CV
      // credential stays bound to its own snapshot, FR-020). A v3 CV
      // credential that is not self-consistent fails closed here and can
      // never back a SLICE_COMMIT or a RUN_CV projection; it is never
      // silently accepted.
      // runtime-cv-epoch-fix: a CV Receipt of an ancestor epoch whose WHOLE
      // prior tuple is invalidated by a persisted ReplanDisposition (exact
      // previous_snapshot match + every declared task invalidated with no
      // carry-forward) is legal history of a dead epoch and must not be
      // validated against the CURRENT Manifest slice-local credentials. All
      // structural/digest/type/schema checks above already ran, so anything
      // malformed/foreign/current-epoch still reaches the strict path below.
      // runtime-cv-linked-lineage: the exemption keys on the CV's OWN linked
      // Worker task identity (resolved root-bound below) and a DIFFERENT
      // current validated Worker Receipt for that task; carry-forward metadata
      // alone never suppresses the strict current-Manifest binding checks.
      if (replanDispositions.length > 0 && isFullyInvalidatedAncestorCvPayload(root, manifest, sliceId, declaredTaskIds, receipt.payload, replanDispositions, currentWorkerFacts)) {
        const allWorkerReceipts = readReceiptChain(
          root,
          tasksReceiptDir(root, manifest.stage_id, sliceId),
          `historical ${manifest.stage_id}/${sliceId} Worker`,
        ).receipts;
        validateHistoricalCvGeneration(
          root,
          manifest,
          manifest.binding !== undefined,
          slice,
          replanDispositions,
          allWorkerReceipts,
          receipt,
          receipt.payload as Record<string, unknown>,
        );
        continue;
      }
      const sliceLocalBinding = manifest.binding !== undefined && isRecord(receipt.payload)
        ? computeSliceLocalCredentialExpectation(
            manifest,
            sliceId,
            sliceLocalDependencyBindingsForSlice(sliceLocalChain, slice),
            receipt.payload,
          )
        : undefined;
      assertClosedVNextCvPayload(receipt.payload, {
        ...binding,
        sliceLocalBinding,
      });
      const cvSnapshot = factDigest(receipt.payload.snapshot_digest, 'CV_RESULT.snapshot_digest', 40);
      assertReceiptSnapshotOnExecutionChain(root, cvSnapshot, admittedSnapshot, 'CV_RESULT', allowHistoricalSnapshot);
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
  // runtime-cv-epoch-fix: every Receipt of the directory belonged to a fully
  // invalidated ancestor epoch — the Slice has NO current-epoch CV history
  // (the physical chain above was still verified; the exemption is a
  // consumer-level skip, not a chain-integrity change).
  if (receipts.length === 0) {
    return { tip: null, hasRepairHistory: false, repairCount: 0 };
  }
  const referencedBy = new Map<string, string>();
  const byDigest = new Map(receipts.map((receipt) => [receipt.digest, receipt] as const));
  const genesis = receipts.filter((receipt) => receipt.previous_digest === undefined || receipt.previous_digest === '' || !byDigest.has(receipt.previous_digest));
  for (const receipt of receipts) {
    if (receipt.previous_digest === undefined || receipt.previous_digest === '') continue;
    const prior = referencedBy.get(receipt.previous_digest);
    if (prior !== undefined) {
      throw new VNextHandoffError(
        'admission-invalid',
        `vNext CV Receipt chain for ${manifest.stage_id}/${sliceId} contains a fork at predecessor ${receipt.previous_digest}`,
      );
    }
    referencedBy.set(receipt.previous_digest, receipt.digest);
  }
  const generationChains: Receipt[][] = [];
  const visited = new Set<string>();
  for (const rootReceipt of genesis) {
    const chainOrder: Receipt[] = [];
    let cursor: Receipt | undefined = rootReceipt;
    while (cursor !== undefined) {
      if (visited.has(cursor.digest)) {
        throw new VNextHandoffError('admission-invalid', `vNext CV Receipt chain for ${manifest.stage_id}/${sliceId} overlaps generations`);
      }
      visited.add(cursor.digest);
      chainOrder.push(cursor);
      const nextDigest = referencedBy.get(cursor.digest);
      cursor = nextDigest === undefined ? undefined : byDigest.get(nextDigest);
    }
    generationChains.push(chainOrder);
  }
  if (visited.size !== receipts.length) {
    throw new VNextHandoffError('admission-invalid', `vNext CV Receipt chain for ${manifest.stage_id}/${sliceId} has an unreachable Receipt branch`);
  }
  const selectedGeneration = generationChains.find((candidate) => {
    const tipPayload = candidate[candidate.length - 1]?.payload;
    return isRecord(tipPayload) && tipPayload.worker_receipt_digest === binding.workerTipDigest;
  }) ?? (generationChains.length === 1 ? generationChains[0] : undefined);
  if (selectedGeneration === undefined || selectedGeneration.length === 0) {
    throw new VNextHandoffError('admission-invalid', `vNext CV Receipt chain for ${manifest.stage_id}/${sliceId} has no generation bound to the current Worker tip`);
  }
  // S08-REVIEW-006: each selected generation must be a legal initial →
  // REPAIR → recheck sequence; historical generations are validated by the
  // shared integration-validation selector before they are excluded.
  assertVNextCvChainSequence(selectedGeneration);
  const tip = selectedGeneration[selectedGeneration.length - 1];
  const tipPayload = isRecord(tip.payload) ? tip.payload : undefined;
  return {
    tip,
    hasRepairHistory: selectedGeneration.some((receipt) => receipt.type === 'CV_REPAIR'),
    repairCount: selectedGeneration.filter((receipt) => receipt.type === 'CV_REPAIR').length,
    tipWorkerReceiptDigest:
      typeof tipPayload?.['worker_receipt_digest'] === 'string'
        ? (tipPayload['worker_receipt_digest'] as string)
        : undefined,
  };
}

/**
 * Read the set of Manifest Slices whose execution chain is already closed by
 * an admitted vNext SLICE_COMMIT fact. A committed Slice must never be
 * re-projected for Worker dispatch or CV; the next consumer advances past it
 * to the next dependency-ready Slice.
 *
 * The SLICE_COMMIT receipt chain is validated like the Worker chain: every
 * Receipt must be a closed vNext SLICE_COMMIT fact bound to the active
 * Manifest/Plan tuple and to the admission snapshot's Git chain. In addition
 * (S08-REVIEW-004) the Receipt's semantic bindings are revalidated against
 * the persisted facts it claims — proof_index_digest, commit_sha on the Git
 * execution chain, cv_receipt_digest equal to the Slice's latest CV_PASS tip,
 * changed_files agreeing with the Worker fact union (with the REPAIR-history
 * exemption), and receipt_chain_valid. A legacy, malformed, or semantically
 * incomplete SLICE_COMMIT fact fails closed instead of being guessed around.
 */
function readVNextCommittedSliceIds(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
  planDigest: string,
  admittedSnapshot: string,
  workerFacts: readonly VNextWorkerFact[],
  finalizeFacts: ReadonlyMap<string, VNextFinalizeFact>,
  currentIntegratedSliceIds: ReadonlySet<string>,
  sliceLocalChain: readonly VNextSliceLocalChainEntry[],
  replanDispositions: readonly ReplanAncestorDispositionRecord[] = [],
): Set<string> {
  const committed = new Set<string>();
  const invalidatedTaskIds = computeChainInvalidatedTaskIds(replanDispositions);
  for (const slice of manifest.slices) {
    if (taskIdsForSlice(manifest, slice).some((taskId) => invalidatedTaskIds.has(taskId))) continue;
    // S12-D-T02 slice-local exemption: an INTEGRATED + CURRENT slice keeps
    // its proof valid across a replan, so its historical SLICE_COMMIT facts
    // (bound to the previous whole-plan tuple) are legal history. The
    // exemption is decided BEFORE the whole-plan digest checks below.
    const exempt = currentIntegratedSliceIds.has(slice.slice_id);
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
    const chain = verifyReceiptChain(directory);
    if (!chain.valid) {
      throw new VNextHandoffError(
        'admission-invalid',
        `vNext Slice Commit Receipt chain is invalid for ${manifest.stage_id}/${slice.slice_id}`,
      );
    }
    const commitTipPath = chain.receipts[chain.receipts.length - 1];
    const commitTipName = commitTipPath === undefined ? null : path.basename(commitTipPath);

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
            `Receipt ${name} is not a SLICE_COMMIT fact in the SLICE_COMMIT category`,
          );
        }
        if (!verifyReceiptDigest(file)) {
          throw new VNextHandoffError('admission-invalid', `Receipt ${name} has an invalid digest`);
        }
        if (receipt.stage_id !== manifest.stage_id || receipt.slice_id !== slice.slice_id) {
          throw new VNextHandoffError('manifest-binding', 'SLICE_COMMIT Receipt stage/slice binding is invalid');
        }
        const payload = receipt.payload;
        if (!isRecord(payload)) {
          throw new VNextHandoffError(
            'admission-invalid',
            'Slice Commit payload must be a JSON object',
          );
        }
        if (commitTipName !== null && name !== commitTipName) {
          const integrationChain = readReceiptChain(
            root,
            integrationReceiptDir(root, manifest.stage_id, slice.slice_id),
            `historical ${manifest.stage_id}/${slice.slice_id} Integration`,
          );
          const integrationReceipt = integrationChain.receipts.find((candidate) => {
            const candidatePayload = candidate.payload;
            return candidate.type === 'INTEGRATION_PASS' && isRecord(candidatePayload) && candidatePayload.slice_commit_receipt_digest === receipt.digest;
          });
          if (integrationReceipt === undefined || !isRecord(integrationReceipt.payload)) {
            throw new VNextHandoffError('manifest-binding', 'historical Slice Commit has no complete Integration credential');
          }
          const historicalManifest = historicalIntegrationManifestFor(
            manifest,
            integrationReceipt.payload,
            replanDispositions,
            `SLICE_COMMIT ${manifest.stage_id}/${slice.slice_id}/${receipt.digest}`,
          );
          const historicalSlice = historicalManifest.slices.find((candidate) => candidate.slice_id === slice.slice_id);
          if (historicalSlice === undefined) {
            throw new VNextHandoffError('manifest-binding', 'historical Slice Commit references a foreign Slice');
          }
          validateVNextHistoricalIntegrationReceipt(
            root,
            integrationReceipt,
            historicalManifest,
            historicalSlice.slice_id,
            admittedSnapshot,
            factDigest(integrationReceipt.payload.snapshot_digest, 'historical INTEGRATION_PASS.snapshot_digest', 40),
          );
          // The complete historical Integration→Worker→CV→Commit chain was
          // validated before this superseded Commit was excluded from currentness.
          continue;
        }
        // S12-D repair (v3 consumer chain): explicit credential
        // schema_version discrimination through the shared helper runs
        // BEFORE any fact read — legacy mode stays v2-only, a v2 credential
        // in a slice-local Stage is an illegal credential
        // (BINDING.MODE_MIXED), a slice-local (3) credential IS the legal
        // credential of a slice-local Stage, and unknown future versions
        // (>3) fail closed explicitly (BINDING.SCHEMA_FUTURE).
        const schemaMismatch = credentialSchemaVersionMismatch(
          payload.schema_version,
          manifest.binding !== undefined,
          'SLICE_COMMIT.payload',
        );
        if (schemaMismatch !== null) {
          throw new VNextHandoffError('admission-invalid', schemaMismatch.message);
        }
        // S12-D repair (v3 consumer chain): in slice-local mode the v3
        // SLICE_COMMIT credential's three binding fields are validated
        // through the SHARED cv-validation helpers against the Manifest
        // contract digests and the recomputed execution binding (kernel
        // oracle over the receipt-bound dependency bindings and the
        // credential's OWN payload snapshot — the historical base snapshot
        // commit admission computed against at write time, NOT the current
        // authority snapshot; after an integration commit + fresh SPV the
        // current snapshot legitimately advances while the historical
        // SLICE_COMMIT credential stays bound to its own snapshot,
        // FR-020). A v3 credential that is not self-consistent fails
        // closed before it can project the Slice as committed. A v2
        // credential carrying binding fields was already rejected by the
        // discrimination above.
        assertSliceLocalCredentialBindingFields(
          payload,
          'SLICE_COMMIT.payload',
          manifest.binding !== undefined
            ? computeSliceLocalCredentialExpectation(
                manifest,
                slice.slice_id,
                sliceLocalDependencyBindingsForSlice(sliceLocalChain, slice),
                payload,
              )
            : undefined,
        );
        if (payload.type !== 'SLICE_COMMIT_RESULT' || payload.action !== 'SLICE_COMMIT') {
          throw new VNextHandoffError(
            'admission-invalid',
            'Slice Commit Receipt is not the closed vNext SLICE_COMMIT_RESULT fact',
          );
        }
        if (payload.manifest_digest !== manifestDigest || payload.plan_digest !== planDigest) {
          if (!exempt) {
            throw new VNextHandoffError('manifest-binding', 'SLICE_COMMIT Receipt is stale or not bound to the active Manifest/Plan');
          }
          // Exempted: the historical tuple must equal the whole-plan tuple
          // bound by the Slice's persisted Worker facts (never a mix of Plan
          // revisions between the Worker chain and the commit fact).
          const boundFact = workerFacts.find((fact) => fact.slice.slice_id === slice.slice_id);
          if (
            boundFact === undefined ||
            payload.manifest_digest !== boundFact.manifestDigest ||
            payload.plan_digest !== boundFact.planDigest
          ) {
            throw new VNextHandoffError(
              'manifest-binding',
              'SLICE_COMMIT Receipt is not bound to the persisted historical execution tuple of the Slice',
            );
          }
        }
        const commitSnapshot = factDigest(payload.snapshot_digest, 'SLICE_COMMIT.snapshot_digest', 40);
        assertReceiptSnapshotOnExecutionChain(root, commitSnapshot, admittedSnapshot, 'SLICE_COMMIT', exempt);
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
        assertReceiptSnapshotOnExecutionChain(root, commitSha, admittedSnapshot, 'SLICE_COMMIT.commit_sha', exempt);
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
        const finalizeFact = finalizeFacts.get(slice.slice_id);
        const lastTaskId = sliceTaskIds[sliceTaskIds.length - 1];
        const lastTaskFact = sliceWorkerFacts.find((fact) => fact.taskId === lastTaskId);
        const workerTipFact = finalizeFact ?? lastTaskFact;
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
          manifest,
          slice.slice_id,
          {
            stageId: manifest.stage_id,
            sliceId: slice.slice_id,
            manifestDigest: exempt ? workerTipFact.manifestDigest : manifestDigest,
            planDigest: exempt ? workerTipFact.planDigest : manifest.plan.plan_digest,
            proofIndexDigest: exempt ? workerTipFact.proofIndexDigest : computeDigest(slice.proof_index),
            workerTipDigest,
            expectedAcceptanceRefs: slice.proof_index.acceptance_refs,
            expectedSeamRefs: slice.proof_index.seam_refs,
            expectedOracleRefs: slice.proof_index.oracle_refs,
            expectedRiskRefs: slice.proof_index.risk_refs.map((risk) => risk.ref_id),
            expectedContextDigest: workerTipFact.contextDigest,
          },
          admittedSnapshot,
          sliceLocalChain,
          exempt,
          replanDispositions,
          workerFacts,
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
        // admissible changed files.  User authorization A8 (next counterpart,
        // S12-E REPAIR-001): the committed boundary of one Slice may
        // legitimately carry files declared by ALREADY ADMITTED TASK_COMPLETE
        // receipts of OTHER Slices of the same Stage (shared worktree with
        // interleaved Slice outputs — S12-D/S12-E).  The allowed side is
        // therefore the union of this Slice's execution scope and every other
        // admitted Worker fact's changed_files — the same A8 semantics
        // commit-admission / integration-admission apply to the committed/
        // integrated boundary.  S12-E REPAIR-FINAL round 3: every file the
        // other Slice's facts declare must itself stay inside THAT Slice's
        // Manifest task scope (the union of all its tasks' allowedCodeScope
        // plus evidence/plan projections) — a forged "declared Slice"
        // credential can never pass out-of-scope files through the A8 merge.
        const otherSliceDeclaredFiles = unique(
          workerFacts
            .filter((fact) => fact.slice.slice_id !== slice.slice_id)
            .flatMap((fact) => {
              const otherSliceScope = vnextSliceAllowedScope(manifest, fact.slice.slice_id);
              for (const file of fact.changedFiles) {
                if (!otherSliceScope.some((base) => pathWithin(file, base))) {
                  throw new VNextHandoffError(
                    'execution-scope-gap',
                    `Other Slice declared file is outside its Manifest task scope: ${file}`,
                  );
                }
              }
              return fact.changedFiles;
            }),
        );
        const sliceAllowedScope = unique([
          ...taskIdsForSlice(manifest, slice).flatMap((taskId) =>
            taskAllowedScope(root, manifest, slice, taskId),
          ),
          ...otherSliceDeclaredFiles,
        ]);
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
          // User authorization A8c (next counterpart): declared projections
          // already present in the committed HEAD tree (tasks.md cannot
          // change without breaking Manifest binding) satisfy their
          // declaration through the persisted snapshot.
          !workerChangedFiles.every((value) =>
            receiptChangedFiles.includes(value) || gitTreeContains(root, commitSha, value))
        ) {
          throw new VNextHandoffError(
            'admission-invalid',
            'SLICE_COMMIT Receipt changed_files do not contain every persisted Worker fact',
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

/**
 * S13-S17 remediation §6.3 — downstream integration facts for the next
 * projection: the set of Manifest Slices whose execution chain is closed by
 * a CURRENT INTEGRATION_PASS fact.
 *
 * Slice-local mode reuses the already-read, fully validated INTEGRATION
 * chain currentness set (contract digests, dependency bindings, execution
 * binding oracle) — never a second weaker read. Legacy mode reads each
 * Slice's INTEGRATION_PASS chain with the same rigor as the Gate consumer
 * (`readSliceIntegrationBinding`): closed v2 payload discriminators, active
 * Manifest/Plan tuple binding, exact Proof Index digest binding, exact SPV
 * authority snapshot binding, and an integrated commit on the current Git
 * branch. A malformed or stale Integration fact fails closed instead of
 * projecting the Slice as integrated.
 */
function readVNextDownstreamIntegratedSliceIds(
  root: string,
  manifest: VNextManifest,
  manifestDigest: string,
  planDigest: string,
  admittedSnapshot: string,
  currentIntegratedSliceIds: ReadonlySet<string>,
): Set<string> {
  if (manifest.binding !== undefined) {
    return new Set(currentIntegratedSliceIds);
  }
  const integrated = new Set<string>();
  for (const slice of manifest.slices) {
    const directory = integrationReceiptDir(root, manifest.stage_id, slice.slice_id);
    if (canonicalPathWithinRoot(root, directory) === null) {
      throw new VNextHandoffError('path-escape', 'vNext Integration Receipt directory escapes the project root');
    }
    let names: string[];
    try {
      names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new VNextHandoffError(
        'admission-invalid',
        `vNext Integration Receipt directory could not be read: ${directory}`,
      );
    }
    if (names.length === 0) continue;
    const chain = verifyReceiptChain(directory);
    if (!chain.valid) {
      throw new VNextHandoffError(
        'admission-invalid',
        `vNext Integration Receipt chain is invalid for ${manifest.stage_id}/${slice.slice_id}`,
      );
    }
    const proofIndexDigest = computeDigest(slice.proof_index);
    for (const name of names) {
      const file = path.join(directory, name);
      const opened = openNoFollowRead(root, file);
      if (!opened.ok) {
        throw new VNextHandoffError('path-escape', `vNext Integration Receipt is not root-bound: ${name}`);
      }
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
        const receipt = validateReceipt(parsed);
        if (receipt.type !== 'INTEGRATION_PASS') {
          throw new VNextHandoffError(
            'admission-invalid',
            `Receipt ${name} is not an INTEGRATION_PASS fact in the integration category`,
          );
        }
        if (!verifyReceiptDigest(file)) {
          throw new VNextHandoffError('admission-invalid', `Receipt ${name} has an invalid digest`);
        }
        if (receipt.stage_id !== manifest.stage_id || receipt.slice_id !== slice.slice_id) {
          throw new VNextHandoffError('manifest-binding', 'INTEGRATION_PASS Receipt stage/slice binding is invalid');
        }
        const payload = receipt.payload;
        if (
          !isRecord(payload) ||
          payload.schema_version !== 2 ||
          payload.type !== 'INTEGRATION_RESULT' ||
          payload.action !== 'INTEGRATION'
        ) {
          throw new VNextHandoffError(
            'admission-invalid',
            `Integration Receipt ${name} is not the closed vNext v2 INTEGRATION_RESULT fact`,
          );
        }
        if (
          payload.stage_id !== manifest.stage_id ||
          payload.slice_id !== slice.slice_id ||
          payload.manifest_digest !== manifestDigest ||
          payload.plan_digest !== planDigest ||
          payload.receipt_chain_valid !== true
        ) {
          throw new VNextHandoffError(
            'manifest-binding',
            `Integration Receipt ${name} does not bind the active Manifest/Plan tuple`,
          );
        }
        if (payload.proof_index_digest !== proofIndexDigest) {
          throw new VNextHandoffError(
            'manifest-binding',
            `Integration Receipt ${name} proof_index_digest does not equal the current Proof Index digest`,
          );
        }
        if (payload.snapshot_digest !== admittedSnapshot) {
          throw new VNextHandoffError(
            'manifest-binding',
            `Integration Receipt ${name} snapshot_digest does not equal the SPV authority snapshot`,
          );
        }
        const commitSha = factDigest(payload.commit_sha, 'INTEGRATION_PASS.commit_sha', 40);
        assertCommitOnCurrentHead(
          root,
          commitSha,
          `integrated commit of ${manifest.stage_id}/${slice.slice_id}`,
        );
      } catch (error) {
        if (error instanceof VNextHandoffError) throw error;
        throw new VNextHandoffError(
          'admission-invalid',
          `vNext Integration Receipt ${name} is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        fs.closeSync(opened.fd);
      }
    }
    integrated.add(slice.slice_id);
  }
  return integrated;
}

/** Binding every stage-level Gate/Review fact must carry to be consumable by the next projection. */
interface VNextStageLevelFactBinding {
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly stagePlanReceiptDigest: string;
  readonly spvReceiptDigest: string;
  /**
   * S13-S17 remediation (forged-snapshot hardening): the admitted execution
   * snapshot every stage-level fact's payload snapshot_digest is validated
   * against — it must be the admitted snapshot or a verified Git descendant
   * of it AND stay on the current execution branch (HEAD ancestry).
   */
  readonly admittedSnapshot: string;
}

/**
 * S13-S17 remediation (forged-snapshot hardening): a persisted stage-level
 * fact is only consumable when its payload snapshot_digest lies on the legal
 * execution chain — the admitted SPV snapshot or a Git descendant of it —
 * and on the current branch (HEAD or an ancestor of HEAD). A Gate/Review
 * recorded against a pre-admission boundary, an abandoned side branch or a
 * foreign commit must never drive the RUN_GATE / Stage Review projection.
 */
function assertStageLevelFactSnapshotBinding(
  root: string,
  payloadSnapshotDigest: string,
  label: string,
  binding: VNextStageLevelFactBinding,
): void {
  assertReceiptSnapshotOnExecutionChain(root, payloadSnapshotDigest, binding.admittedSnapshot, label);
  assertCommitOnCurrentHead(root, payloadSnapshotDigest, label);
}

export interface VNextStageGateTipFacts {
  /** The verdict of the stage-gate chain tip. */
  readonly verdict: 'PASS' | 'FAIL';
  /** The digest-addressed name of the tip Receipt. */
  readonly digest: string;
  /** The snapshot digest bound by the tip Receipt. */
  readonly snapshot_digest: string;
}

/**
 * S13-S17 remediation §6.3 (Case G/H) — the persisted stage-gate chain tip
 * for the next projection, read with the same root-bound rigor as the Stage
 * Review status consumer: closed v2 GATE_RESULT payload discriminators and
 * the full active Manifest/Authority tuple binding on EVERY chain member.
 * An empty chain yields null (the Gate has not run yet); a malformed or
 * stale Gate fact fails closed.
 */
function readVNextStageGateTipFacts(
  root: string,
  stageId: string,
  binding: VNextStageLevelFactBinding,
): VNextStageGateTipFacts | null {
  const directory = stageGateReceiptDir(root, stageId);
  if (canonicalPathWithinRoot(root, directory) === null) {
    throw new VNextHandoffError('path-escape', 'stage-gate Receipt directory escapes the project root');
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new VNextHandoffError('admission-invalid', `stage-gate Receipt directory could not be read: ${directory}`);
  }
  if (names.length === 0) return null;
  const chain = verifyReceiptChain(directory);
  if (!chain.valid) {
    throw new VNextHandoffError('admission-invalid', `stage-gate Receipt chain is invalid for ${stageId}`);
  }
  let tip: VNextStageGateTipFacts | null = null;
  for (const item of chain.receipts) {
    const name = path.basename(item);
    const file = path.join(directory, name);
    const opened = openNoFollowRead(root, file);
    if (!opened.ok) {
      throw new VNextHandoffError('path-escape', `stage-gate Receipt is not root-bound: ${name}`);
    }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
      const receipt = validateReceipt(parsed);
      if (receipt.type !== 'GATE_PASS' && receipt.type !== 'GATE_FAIL') {
        throw new VNextHandoffError(
          'admission-invalid',
          `Receipt ${name} is not a GATE_PASS/GATE_FAIL fact in the stage-gate category`,
        );
      }
      // Self-digest from the SAME opened-fd content that the tuple checks
      // below consume — never a second path-following read (TOCTOU).
      const { digest: storedGateDigest, ...gateContent } = parsed as Record<string, unknown>;
      if (computeReceiptDigest(gateContent) !== storedGateDigest) {
        throw new VNextHandoffError('admission-invalid', `Receipt ${name} has an invalid self-digest`);
      }
      const payload = receipt.payload;
      if (
        !isRecord(payload) ||
        payload.schema_version !== 2 ||
        payload.type !== 'GATE_RESULT' ||
        payload.action !== 'GATE'
      ) {
        throw new VNextHandoffError(
          'admission-invalid',
          `stage-gate Receipt ${name} is not the closed vNext v2 GATE_RESULT fact`,
        );
      }
      if (
        payload.stage_id !== stageId ||
        payload.manifest_digest !== binding.manifestDigest ||
        payload.plan_digest !== binding.planDigest ||
        payload.stage_plan_receipt_digest !== binding.stagePlanReceiptDigest ||
        payload.spv_receipt_digest !== binding.spvReceiptDigest ||
        payload.receipt_chain_valid !== true
      ) {
        throw new VNextHandoffError(
          'manifest-binding',
          `stage-gate Receipt ${name} does not bind the active Manifest/Authority tuple`,
        );
      }
      // S13-S17 remediation (forged-snapshot hardening): the recorded Gate
      // snapshot must lie on the admitted execution chain and on the current
      // branch — a Gate "PASS" forged against a foreign/side-branch/pre-
      // admission snapshot never drives the downstream projection.
      assertStageLevelFactSnapshotBinding(
        root,
        factDigest(payload.snapshot_digest, `stage-gate Receipt ${name}.payload.snapshot_digest`, 40),
        `stage-gate Receipt ${name} snapshot`,
        binding,
      );
      if (payload.verdict !== 'PASS' && payload.verdict !== 'FAIL') {
        throw new VNextHandoffError('admission-invalid', `stage-gate Receipt ${name} has an invalid verdict`);
      }
      tip = { verdict: payload.verdict, digest: receipt.digest, snapshot_digest: payload.snapshot_digest as string };
    } catch (error) {
      if (error instanceof VNextHandoffError) throw error;
      throw new VNextHandoffError(
        'admission-invalid',
        `stage-gate Receipt ${name} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      fs.closeSync(opened.fd);
    }
  }
  return tip;
}

export interface VNextStageReviewTipFacts {
  /** The verdict of the stage review chain tip. */
  readonly verdict: 'ACCEPTED' | 'REPAIR';
  /** The digest-addressed name of the tip Receipt. */
  readonly digest: string;
  /** The stage-gate receipt digest bound by the tip Receipt, if any. */
  readonly stage_gate_receipt_digest?: string;
  /** The snapshot digest bound by the tip Receipt. */
  readonly snapshot_digest?: string;
}

/**
 * S13-S17 remediation §6.3 (Case H) — the persisted stage review chain tip
 * for the next projection, validated at the same strength as the Stage
 * Review status consumer: closed v2 STAGE_REVIEW_RESULT payload
 * discriminators and the full active Manifest/Authority tuple binding on
 * EVERY chain member. An empty chain yields null (no Review round yet); a
 * malformed or stale Review fact fails closed.
 */
function readVNextStageReviewTipFacts(
  root: string,
  stageId: string,
  binding: VNextStageLevelFactBinding,
): VNextStageReviewTipFacts | null {
  const directory = reviewReceiptDir(root, stageId);
  if (canonicalPathWithinRoot(root, directory) === null) {
    throw new VNextHandoffError('path-escape', 'stage review Receipt directory escapes the project root');
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new VNextHandoffError('admission-invalid', `stage review Receipt directory could not be read: ${directory}`);
  }
  if (names.length === 0) return null;
  const chain = verifyReceiptChain(directory);
  if (!chain.valid) {
    throw new VNextHandoffError('admission-invalid', `stage review Receipt chain is invalid for ${stageId}`);
  }
  let tip: VNextStageReviewTipFacts | null = null;
  for (const item of chain.receipts) {
    const name = path.basename(item);
    const file = path.join(directory, name);
    const opened = openNoFollowRead(root, file);
    if (!opened.ok) {
      throw new VNextHandoffError('path-escape', `stage review Receipt is not root-bound: ${name}`);
    }
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
      const receipt = validateReceipt(parsed);
      if (receipt.type !== 'STAGE_REVIEW_PASS') {
        throw new VNextHandoffError(
          'admission-invalid',
          `Receipt ${name} is not a STAGE_REVIEW_PASS fact in the stage review category`,
        );
      }
      // Self-digest from the SAME opened-fd content that the tuple checks
      // below consume — never a second path-following read (TOCTOU).
      const { digest: storedReviewDigest, ...reviewContent } = parsed as Record<string, unknown>;
      if (computeReceiptDigest(reviewContent) !== storedReviewDigest) {
        throw new VNextHandoffError('admission-invalid', `Receipt ${name} has an invalid self-digest`);
      }
      const payload = receipt.payload;
      if (
        !isRecord(payload) ||
        payload.schema_version !== 2 ||
        payload.type !== 'STAGE_REVIEW_RESULT' ||
        payload.action !== 'STAGE_REVIEW'
      ) {
        throw new VNextHandoffError(
          'admission-invalid',
          `stage review Receipt ${name} is not the closed vNext v2 STAGE_REVIEW_RESULT fact`,
        );
      }
      if (
        payload.stage_id !== stageId ||
        payload.manifest_digest !== binding.manifestDigest ||
        payload.plan_digest !== binding.planDigest ||
        payload.stage_plan_receipt_digest !== binding.stagePlanReceiptDigest ||
        payload.spv_receipt_digest !== binding.spvReceiptDigest ||
        payload.receipt_chain_valid !== true
      ) {
        throw new VNextHandoffError(
          'manifest-binding',
          `stage review Receipt ${name} does not bind the active Manifest/Authority tuple`,
        );
      }
      // S13-S17 remediation (forged-snapshot hardening): the recorded Review
      // snapshot must lie on the admitted execution chain and on the current
      // branch — a Review verdict forged against a foreign/side-branch/
      // pre-admission snapshot never drives the downstream projection.
      assertStageLevelFactSnapshotBinding(
        root,
        factDigest(payload.snapshot_digest, `stage review Receipt ${name}.payload.snapshot_digest`, 40),
        `stage review Receipt ${name} snapshot`,
        binding,
      );
      if (payload.verdict !== 'ACCEPTED' && payload.verdict !== 'REPAIR') {
        throw new VNextHandoffError('admission-invalid', `stage review Receipt ${name} has an invalid verdict`);
      }
      tip = {
        verdict: payload.verdict,
        digest: receipt.digest,
        stage_gate_receipt_digest: typeof payload.stage_gate_receipt_digest === 'string' ? payload.stage_gate_receipt_digest : undefined,
        snapshot_digest: typeof payload.snapshot_digest === 'string' ? payload.snapshot_digest : undefined,
      };
    } catch (error) {
      if (error instanceof VNextHandoffError) throw error;
      throw new VNextHandoffError(
        'admission-invalid',
        `stage review Receipt ${name} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      fs.closeSync(opened.fd);
    }
  }
  return tip;
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
  allowHistoricalAncestry = false,
): void {
  if (candidate === admittedSnapshot) return;
  if (allowHistoricalAncestry) {
    // S12-D-T02 slice-local exemption: the historical snapshot of an
    // integrated CURRENT slice's facts is legal history — it must only be a
    // Git commit reachable from the current branch (HEAD or an ancestor of
    // it), never a reverted/side-branch/foreign boundary.
    assertCommitOnCurrentHead(root, candidate, label);
    return;
  }
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
  // S13-S17 remediation §10: the contract pending-results directory is
  // Runtime-owned transport state — a persisted Worker/CV result envelope
  // is the very fact the ADMIT_WORKER_RESULT / ADMIT_CV_RESULT rows
  // consume, so its on-disk presence must never fail the execution dirty
  // boundary. Entries under it are skipped before the scope check.
  const exemptDirtyBases = ['.pi/proofloop-runtime/results'];
  const forbidden = ['.proofloop/manifests', '.proofloop/receipts', '.proofloop/context', '.git'];
  for (const changed of gitChangedPaths(gitRoot)) {
    if (exemptDirtyBases.some((base) => pathsOverlap(changed, base))) continue;
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

// ===========================================================================
// S13-S17 remediation §6.2 — canonical decision bridge
//
// vNext fact resolver → canonical Stage decision (`deriveNextAction`) →
// NextAction. The resolver maps ONLY validated persisted vNext facts into the
// canonical `DeriveNextActionInput` shape; every lifecycle row (pending
// result admission, CV, Slice Commit, Integration, Gate, Stage Review,
// dispatch) is decided once, by the canonical table — never by a parallel
// vNext action state machine.
// ===========================================================================

/** Minimal claimable pending-result fact (identity + token binding only). */
interface VNextPendingWorkerResult {
  readonly stageId: string;
  readonly sliceId: string;
  readonly taskId?: string;
  readonly actionToken: string;
}

/**
 * Deterministic read of the contract pending-results directory
 * (`.pi/proofloop-runtime/results/`, the SAME mechanism the canonical v1
 * extras use). Only schema-valid envelopes bound to this stage are claimable;
 * unparseable/schema-invalid files never become a pending fact (HP-003), and
 * an envelope whose actionToken/worker tip is already admitted is consumed,
 * not pending. A directory whose canonical path escapes the root fails
 * closed.
 */
function readVNextPendingResultFacts(
  root: string,
  stageId: string,
  admittedActionTokens: ReadonlySet<string>,
  admittedCvWorkerReceiptDigests: ReadonlySet<string>,
): { worker: readonly VNextPendingWorkerResult[]; cv: readonly PendingCvResultEnvelope[] } {
  const directory = path.join(root, '.pi', 'proofloop-runtime', 'results');
  if (canonicalPathWithinRoot(root, directory) === null) {
    throw new VNextHandoffError('path-escape', 'pending results directory escapes the project root');
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { worker: [], cv: [] };
    throw new VNextHandoffError('admission-invalid', `pending results directory could not be read: ${directory}`);
  }
  const worker: VNextPendingWorkerResult[] = [];
  const cv: PendingCvResultEnvelope[] = [];
  for (const name of names) {
    const file = path.join(directory, name);
    // Trust-root boundary (S2-F-003, same discipline as the canonical v1
    // pending-results reader): every pending file is read through an
    // O_NOFOLLOW fd against its canonical parent. A final-component symlink
    // or an escaping symlink is SKIPPED fail-closed — it never becomes a
    // claimable pending fact, so it can never drive ADMIT_WORKER_RESULT /
    // ADMIT_CV_RESULT.
    const opened = openNoFollowRead(root, file);
    if (!opened.ok) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
    } catch {
      continue;
    } finally {
      fs.closeSync(opened.fd);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion === 2 && record.stageId === stageId) {
      try {
        const envelope = validateVNextWorkerResultEnvelope(record);
        // Repair envelopes are handoff facts for the CV recheck projection,
        // never claimable completion results — they must not surface as
        // ADMIT_WORKER_RESULT pending facts.
        if (envelope.mode !== 'repair' && !admittedActionTokens.has(envelope.actionToken)) {
          worker.push({
            stageId: envelope.stageId,
            sliceId: envelope.sliceId,
            taskId: envelope.taskId,
            actionToken: envelope.actionToken,
          });
        }
      } catch {
        // Schema-invalid files are never claimable pending facts.
      }
      continue;
    }
    if (
      (record.schema_version === 2 || record.schema_version === 3) &&
      record.type === 'CV_RESULT' &&
      record.stage_id === stageId
    ) {
      try {
        const envelope = validateVNextCvResultEnvelope(record);
        if (
          typeof envelope.worker_receipt_digest === 'string' &&
          !admittedCvWorkerReceiptDigests.has(envelope.worker_receipt_digest)
        ) {
          cv.push({ stageId: envelope.stage_id, sliceId: envelope.slice_id });
        }
      } catch {
        // Schema-invalid files are never claimable pending facts.
      }
    }
  }
  return { worker, cv };
}

/**
 * Repair handoff validation (CV REPAIR closed loop): a CV_REPAIR verdict is
 * only allowed to advance to its bounded recheck (PENDING_RECHECK) after a
 * schema-valid mode='repair' WorkerResultEnvelope exists that binds exactly
 * that verdict — stage/slice, active Manifest/Plan tuple, the repaired
 * CV_REPAIR Receipt digest, and a persisted repair Context whose digest
 * matches the envelope. Anything else fails closed: no repair fact means the
 * Slice stays in REPAIR and the canonical table dispatches the repair Worker.
 */
function readValidRepairEnvelopeForCvRepairTip(
  root: string,
  manifestDigest: string,
  manifest: VNextManifest,
  sliceId: string,
  cvRepairReceiptDigest: string,
): boolean {
  const directory = path.join(root, '.pi', 'proofloop-runtime', 'results');
  if (canonicalPathWithinRoot(root, directory) === null) {
    throw new VNextHandoffError('path-escape', 'pending results directory escapes the project root');
  }
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new VNextHandoffError('admission-invalid', `pending results directory could not be read: ${directory}`);
  }
  for (const name of names) {
    const file = path.join(directory, name);
    const opened = openNoFollowRead(root, file);
    if (!opened.ok) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
    } catch {
      continue;
    } finally {
      fs.closeSync(opened.fd);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== 2 || record.stageId !== manifest.stage_id) continue;
    let envelope: VNextWorkerResultEnvelope;
    try {
      envelope = validateVNextWorkerResultEnvelope(record);
    } catch {
      continue;
    }
    if (envelope.mode !== 'repair') continue;
    if (envelope.sliceId !== sliceId) continue;
    if (envelope.manifestDigest !== manifestDigest || envelope.planDigest !== manifest.plan.plan_digest) continue;
    if (envelope.repairsCvReceiptDigest !== cvRepairReceiptDigest) continue;
    // The repair Context must exist on disk and match the envelope binding:
    // digest-addressed context file, same mode, same repaired verdict.
    const contextFile = path.join(root, '.proofloop', 'context', `${envelope.contextDigest}.json`);
    if (canonicalPathWithinRoot(root, contextFile) === null) continue;
    const contextOpened = openNoFollowRead(root, contextFile);
    if (!contextOpened.ok) continue;
    let context: unknown;
    try {
      context = JSON.parse(fs.readFileSync(contextOpened.fd, 'utf8'));
    } catch {
      continue;
    } finally {
      fs.closeSync(contextOpened.fd);
    }
    if (context === null || typeof context !== 'object' || Array.isArray(context)) continue;
    const ctx = context as Record<string, unknown>;
    if (ctx['context_digest'] !== envelope.contextDigest) continue;
    if (ctx['mode'] !== 'repair') continue;
    if (ctx['slice_id'] !== sliceId) continue;
    if (ctx['manifest_digest'] !== manifestDigest) continue;
    if (ctx['repairs_cv_receipt_digest'] !== cvRepairReceiptDigest) continue;
    try {
      verifyVNextWorkerContextBindings(root, manifest, ctx as unknown as VNextWorkerContext);
    } catch {
      continue;
    }
    return true;
  }
  return false;
}

function readReceiptJsonFiles(root: string, directory: string): unknown[] {
  try {
    const names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
    return names.map((name) => JSON.parse(readRootBoundJson(root, path.join(directory, name))));
  } catch {
    return [];
  }
}

function collectAdmittedWorkerActionTokens(root: string, manifest: VNextManifest): Set<string> {
  const tokens = new Set<string>();
  for (const slice of manifest.slices) {
    for (const value of readReceiptJsonFiles(root, tasksReceiptDir(root, manifest.stage_id, slice.slice_id))) {
      if (
        typeof value === 'object' && value !== null && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>)['payload'] === 'object'
      ) {
        const payload = (value as Record<string, unknown>)['payload'] as Record<string, unknown>;
        if (typeof payload['action_token'] === 'string') tokens.add(payload['action_token']);
      }
    }
  }
  return tokens;
}

/** Every worker_receipt_digest bound by a persisted CV Receipt of the stage. */
function collectAdmittedCvWorkerReceiptDigests(root: string, manifest: VNextManifest): Set<string> {
  const digests = new Set<string>();
  for (const slice of manifest.slices) {
    for (const value of readReceiptJsonFiles(root, cvReceiptDir(root, manifest.stage_id, slice.slice_id))) {
      if (
        typeof value === 'object' && value !== null && !Array.isArray(value) &&
        typeof (value as Record<string, unknown>)['payload'] === 'object'
      ) {
        const payload = (value as Record<string, unknown>)['payload'] as Record<string, unknown>;
        if (typeof payload['worker_receipt_digest'] === 'string') digests.add(payload['worker_receipt_digest']);
      }
    }
  }
  return digests;
}

/** Input to the vNext → canonical decision bridge. */
interface VNextCanonicalBridgeInput {
  readonly input: VNextNextActionInput;
  readonly manifest: VNextManifest;
  readonly manifestDigest: string;
  readonly authority: VNextAdmissionAuthority;
  readonly authoritySnapshot: string;
  readonly currentIntegratedSliceIds: ReadonlySet<string>;
  readonly workerFacts: readonly VNextWorkerFact[];
  readonly finalizeFacts: ReadonlyMap<string, VNextWorkerFact>;
  readonly committedSliceIds: ReadonlySet<string>;
  readonly sliceLocalChain: readonly VNextSliceLocalChainEntry[];
  readonly historicalInvalidatedTaskIds: ReadonlySet<string>;
  readonly replanDispositions: readonly ReplanAncestorDispositionRecord[];
}

/**
 * Resolve the validated vNext facts into the canonical decision input and run
 * the ONE canonical priority table. Any invalid persisted fact fails closed
 * (the readers throw; nextAction maps the failure to bounded VALIDATE).
 */
function deriveVNextCanonicalNextAction(
  bridge: VNextCanonicalBridgeInput,
  cvRepairTipsOut?: Map<string, string>,
): DerivedNextAction {
  const {
    input,
    manifest,
    manifestDigest,
    authority,
    authoritySnapshot,
    currentIntegratedSliceIds,
    workerFacts,
    finalizeFacts,
    committedSliceIds,
    sliceLocalChain,
    historicalInvalidatedTaskIds,
    replanDispositions,
  } = bridge;

  const integratedSliceIds = readVNextDownstreamIntegratedSliceIds(
    input.projectRoot,
    manifest,
    manifestDigest,
    manifest.plan.plan_digest,
    authoritySnapshot,
    currentIntegratedSliceIds,
  );

  const slices: ReconciledSliceState[] = [];
  // Slice → digest of the outstanding CV_REPAIR chain tip (REPAIR status only).
  // Consumed by the DISPATCH_WORKER projection so a repair dispatch binds the
  // exact verdict it closes.
  const cvRepairTips = new Map<string, string>();
  for (const slice of manifest.slices) {
    const sliceId = slice.slice_id;
    const taskIds = taskIdsForSlice(manifest, slice);
    const sliceFacts = workerFacts.filter((fact) => fact.slice.slice_id === sliceId);
    const completedTaskIds = new Set(
      sliceFacts.flatMap((fact) => (fact.taskId !== undefined ? [fact.taskId] : [])),
    );
    const finalizeFact = finalizeFacts.get(sliceId);
    const integrated = integratedSliceIds.has(sliceId);
    const committed = committedSliceIds.has(sliceId);

    // A persisted TASK_COMPLETE Receipt is the completion truth (§6.4): a
    // completed Task is always checked AND evidence-written, never a row-10b
    // mismatch. For a Task WITHOUT a Receipt, a checked plan-projection
    // checkbox or a persisted Replan invalidation of already-executed work is
    // exactly the recover binding — the canonical row 10b mismatch then
    // re-dispatches it as `recover-task`, never re-implements it.
    const tasks = taskIds.map((taskId) => {
      const completed = completedTaskIds.has(taskId);
      return {
        task_id: taskId,
        checked:
          completed ||
          planTaskCheckboxChecked(input.projectRoot, manifest.plan.ref, taskId) ||
          historicalInvalidatedTaskIds.has(taskId),
        evidence_written: completed,
      };
    });

    // CV facts at full admission strength — an invalid persisted CV chain
    // throws and lands as bounded VALIDATE, identical to the recovery/Commit
    // consumers.
    let cvPassed = false;
    let cvStatus = CVStatus.NOT_STARTED;
    let repairAttempt = 0;
    if (!committed && !integrated && (sliceFacts.length > 0 || finalizeFact !== undefined)) {
      const lastTaskId = taskIds[taskIds.length - 1];
      const workerTipFact =
        finalizeFact ??
        sliceFacts.find((fact) => fact.taskId === lastTaskId) ??
        sliceFacts[sliceFacts.length - 1];
      if (workerTipFact !== undefined && workerTipFact.workerReceiptDigest !== undefined) {
        const cvFacts = readVNextCvReceiptFacts(
          input.projectRoot,
          manifest,
          sliceId,
          {
            stageId: manifest.stage_id,
            sliceId,
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
          sliceLocalChain,
          false,
          replanDispositions,
          workerFacts,
        );
        // Off-by-one discipline: the canonical table counts COMPLETED repairs
        // (attempt 0 = first repair outstanding). The chain tip is the
        // (repairCount)-th CV_REPAIR, so the completed count is repairCount - 1.
        if (cvFacts.tip !== null && cvFacts.tip.type === 'CV_REPAIR') {
          repairAttempt = Math.max(0, cvFacts.repairCount - 1);
        } else {
          repairAttempt = cvFacts.repairCount;
        }
        if (cvFacts.tip !== null) {
          if (cvFacts.tip.type === 'CV_PASS') {
            cvPassed = true;
          } else if (cvFacts.tip.type === 'CV_REPAIR') {
            // Closed REPAIR loop: the verdict may only advance to its bounded
            // recheck after a validated mode='repair' envelope binds exactly
            // this CV_REPAIR Receipt. Without it the Slice stays REPAIR and
            // the canonical table dispatches the repair Worker.
            const repairEnvelopePresent = readValidRepairEnvelopeForCvRepairTip(
              input.projectRoot,
              manifestDigest,
              manifest,
              sliceId,
              cvFacts.tip.digest,
            );
            cvStatus = repairEnvelopePresent ? CVStatus.PENDING_RECHECK : CVStatus.REPAIR;
            if (!repairEnvelopePresent) {
              cvRepairTips.set(sliceId, cvFacts.tip.digest);
            }
          } else {
            cvStatus = CVStatus.PENDING_RECHECK;
          }
        }
      }
    }

    // Kernel canonical slice lifecycle mapping.
    let sliceState: SliceState;
    if (integrated) sliceState = SliceState.INTEGRATED;
    else if (committed) sliceState = SliceState.INTEGRATING;
    else if (cvPassed) sliceState = SliceState.CV_PASSED;
    else if (finalizeFact !== undefined) sliceState = SliceState.READY_FOR_CV;
    else if (tasks.some((task) => task.checked) || completedTaskIds.size > 0) sliceState = SliceState.IN_PROGRESS;
    else sliceState = SliceState.PLANNED;

    slices.push({
      slice_id: sliceId,
      // Only UNPROVEN dependencies DECLARED by this Manifest gate the
      // canonical rows. Dependencies pointing outside the Manifest (prior
      // Stage Slices) are proven through the committed/proven set by the
      // dispatch seam, not by canonical table lookups.
      dependencies: slice.depends_on.filter(
        (dependency) =>
          manifest.slices.some((declared) => declared.slice_id === dependency) &&
          !committedSliceIds.has(dependency),
      ),
      tasks,
      slice_state: sliceState,
      cv_status: cvStatus,
      slice_evidence_finalized: finalizeFact !== undefined,
      repair_attempt: repairAttempt,
      scope_check_passed: cvPassed,
      committed,
      integrated,
      complete: integrated,
      latest_cv_receipt: null,
      latest_commit_receipt: null,
    });
  }

  // Stage-level Gate/Review tips — validated against the full active tuple
  // AND the execution snapshot chain (forged snapshots fail closed).
  const stageLevelBinding = {
    manifestDigest,
    planDigest: manifest.plan.plan_digest,
    stagePlanReceiptDigest: authority.stagePlan.digest,
    spvReceiptDigest: authority.spv.digest,
    admittedSnapshot: authoritySnapshot,
  };
  const findings: Finding[] = [];
  let gatePassPresent = false;
  let gateFailPresent = false;
  const gateTip = readVNextStageGateTipFacts(input.projectRoot, input.stageId, stageLevelBinding);
  const gitHead = readGitHead(resolveGitRoot(input.projectRoot));
  const currentGitHead = gitHead ?? authoritySnapshot;
  if (gateTip !== null && gateTip.verdict === 'PASS' && gateTip.snapshot_digest === currentGitHead) {
    gatePassPresent = true;
  }
  if (gateTip !== null && gateTip.verdict === 'FAIL') gateFailPresent = true;
  // P0-2 closed Review chain: Gate PASS derives PREPARE_STAGE_REVIEW until a
  // prepared fact binds exactly this Gate PASS tip (stale facts never count).
  let reviewPreparedPresent = false;
  if (gatePassPresent && gateTip !== null) {
    reviewPreparedPresent =
      readVNextStageReviewPreparedFacts(input.projectRoot, input.stageId, {
        manifestDigest,
        planDigest: manifest.plan.plan_digest,
        gateReceiptDigest: gateTip.digest,
        snapshotDigest: gateTip.snapshot_digest,
      }) !== null;
  }
  if (gatePassPresent && gateTip !== null) {
    const reviewTip = readVNextStageReviewTipFacts(input.projectRoot, input.stageId, stageLevelBinding);
    if (reviewTip?.verdict === 'ACCEPTED') {
      // §6.3: Review ACCEPTED converges through the PUBLIC Stage Close
      // contract — no extra NextAction is invented for it; the canonical
      // error-finding row keeps the projection bounded instead.
      findings.push({
        code: 'DOMAIN.INVALID_TRANSITION',
        severity: 'error',
        message:
          `stage "${input.stageId}" Stage Review is ACCEPTED; run the public Stage Close contract to archive the stage`,
      });
    } else if (reviewTip?.verdict === 'REPAIR') {
      if (reviewTip.stage_gate_receipt_digest === undefined || reviewTip.stage_gate_receipt_digest === gateTip.digest) {
        findings.push({
          code: 'DOMAIN.INVALID_TRANSITION',
          severity: 'error',
          message:
            `stage "${input.stageId}" has a STAGE_REVIEW REPAIR tip; a re-gate (new GATE_PASS at the advanced HEAD) is required before the next review round`,
        });
      }
    }
  }

  // Pending result envelopes (§6.3: returned-but-unadmitted Worker/CV
  // results), detected from the contract results dir minus already-admitted
  // credentials.
  const pending = readVNextPendingResultFacts(
    input.projectRoot,
    input.stageId,
    collectAdmittedWorkerActionTokens(input.projectRoot, manifest),
    collectAdmittedCvWorkerReceiptDigests(input.projectRoot, manifest),
  );

  // The canonical table consumes minimal identity bindings only; the
  // remaining WorkerResultEnvelope fields are admission concerns already
  // carried by the pending file itself.
  const pendingWorkerForTable = pending.worker.map(
    (entry) =>
      ({
        schemaVersion: 1,
        actionToken: entry.actionToken,
        stageId: entry.stageId,
        sliceId: entry.sliceId,
        taskId: entry.taskId,
        mode: 'implement-task',
        evidenceRef: '',
        changedFiles: [],
        verificationRuns: [],
      }) as unknown as WorkerResultEnvelope,
  );

  const derived = deriveNextAction({
    stage_id: input.stageId,
    slices,
    stage_state: gatePassPresent ? StageState.UNDER_REVIEW : StageState.EXECUTING,
    project_state: ProjectState.IN_PROGRESS,
    receipt_chain: [],
    findings,
    receipt_chain_valid: true,
    ...(gatePassPresent ? { gate_pass_present: true } : {}),
    ...(gateFailPresent ? { gate_fail_present: true } : {}),
    ...(pendingWorkerForTable.length > 0 ? { pending_worker_result_envelopes: pendingWorkerForTable } : {}),
    ...(pending.cv.length > 0 ? { pending_cv_result_envelopes: pending.cv } : {}),
    ...(reviewPreparedPresent ? { review_prepared_present: true } : {}),
  });
  if (cvRepairTipsOut !== undefined) {
    for (const [repairSliceId, repairTipDigest] of cvRepairTips) {
      cvRepairTipsOut.set(repairSliceId, repairTipDigest);
    }
  }
  return derived;
}

/**
 * Derive the exact VNextWorkerDispatch tuple for a DISPATCH_WORKER canonical decision.
 */
export function deriveWorkerDispatch(
  input: VNextNextActionInput,
  manifest: VNextManifest,
  manifestDigest: string,
  authority: VNextAdmissionAuthority,
  requestedSnapshot: string,
  derived: DerivedNextAction,
  workerFacts: readonly VNextWorkerFact[],
  committedSliceIds: ReadonlySet<string>,
  cvRepairTips: ReadonlyMap<string, string>,
): VNextWorkerDispatch {
  const slice = manifest.slices.find((candidate) => candidate.slice_id === derived.slice_id);
  if (slice === undefined || derived.mode === undefined) {
    throw new VNextHandoffError(
      'task-anchor-gap',
      `canonical decision dispatched an unresolvable Slice/mode: ${derived.slice_id ?? '<missing>'}/${derived.mode ?? '<missing>'}`,
    );
  }
  const sliceId = slice.slice_id;
  const completedTaskIds = new Set(
    workerFacts
      .filter((fact) => fact.slice.slice_id === sliceId && fact.taskId !== undefined)
      .map((fact) => fact.taskId as string),
  );
  if (derived.mode === 'repair') {
    const repairedCvReceiptDigest = cvRepairTips.get(slice.slice_id);
    if (repairedCvReceiptDigest === undefined) {
      throw new VNextHandoffError(
        'task-anchor-gap',
        `canonical repair dispatch for slice "${slice.slice_id}" has no outstanding CV_REPAIR chain tip`,
      );
    }
    return projectVNextWorkerDispatch({
      root: input.projectRoot,
      manifest,
      manifestDigest,
      snapshotDigest: requestedSnapshot,
      authority,
      sliceId,
      completedTaskIds: [],
      mode: 'repair',
      repairsCvReceiptDigest: repairedCvReceiptDigest,
      provenCompleteSlices: committedSliceIds,
      verifyReferenceBindings: input.verifyReferenceBindings,
    });
  }
  return projectVNextWorkerDispatch({
    root: input.projectRoot,
    manifest,
    manifestDigest,
    snapshotDigest: requestedSnapshot,
    authority,
    sliceId,
    completedTaskIds: [...completedTaskIds],
    mode: derived.mode,
    provenCompleteSlices: committedSliceIds,
    verifyReferenceBindings: input.verifyReferenceBindings,
  });
}

/**
 * Translate the canonical decision into the vNext output contract. DISPATCH
 * decisions still flow through the dispatch seam (Context generation stays a
 * vNext execution fact, not a lifecycle decision); RUN_CV reuses the shared
 * CV output builder; every other canonical action is projected verbatim with
 * the active Manifest/Plan/snapshot binding.
 */
function projectVNextDerivedAction(
  input: VNextNextActionInput,
  manifest: VNextManifest,
  manifestDigest: string,
  authority: VNextAdmissionAuthority,
  requestedSnapshot: string,
  derived: DerivedNextAction,
  workerFacts: readonly VNextWorkerFact[],
  committedSliceIds: ReadonlySet<string>,
  cvRepairTips: ReadonlyMap<string, string>,
): VNextNextActionOutput {
  if (derived.action === 'DISPATCH_WORKER') {
    const dispatch = deriveWorkerDispatch(
      input,
      manifest,
      manifestDigest,
      authority,
      requestedSnapshot,
      derived,
      workerFacts,
      committedSliceIds,
      cvRepairTips,
    );
    if (input.persistContext === true) persistVNextWorkerContext(input.projectRoot, dispatch);
    if (dispatch.mode === 'repair') {
      return {
        action: dispatch.action,
        action_detail:
          'DISPATCH_WORKER mode=' + dispatch.mode + ' for slice ' + dispatch.slice_id +
          ' repairs CV_REPAIR receipt ' + (dispatch.context as unknown as Record<string, unknown>).repairs_cv_receipt_digest +
          ' context_ref ' + dispatch.context_ref,
        responsible_role: dispatch.responsible_role,
        receipt_chain_valid: dispatch.receipt_chain_valid,
        stage_id: dispatch.stage_id,
        slice_id: dispatch.slice_id,
        mode: dispatch.mode,
        context_ref: dispatch.context_ref,
        manifest_digest: dispatch.manifest_digest,
        plan_digest: dispatch.plan_digest,
        proof_index_digest: dispatch.proof_index_digest,
        snapshot_digest: dispatch.snapshot_digest,
        findings: dispatch.findings,
      };
    }
    return {
      action: dispatch.action,
      action_detail:
        'DISPATCH_WORKER mode=' + dispatch.mode + ' for slice ' + dispatch.slice_id +
        (dispatch.task_id !== undefined ? ' task ' + dispatch.task_id : '') +
        ' context_ref ' + dispatch.context_ref,
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
  if (derived.action === 'RUN_CV') {
    const slice = manifest.slices.find((candidate) => candidate.slice_id === derived.slice_id);
    if (slice === undefined) {
      throw new VNextHandoffError('task-anchor-gap', `canonical RUN_CV decision has no resolvable Slice: ${derived.slice_id ?? '<missing>'}`);
    }
    return runCvOutput(input, slice, manifestDigest, manifest.plan.plan_digest, requestedSnapshot);
  }
  return {
    action: derived.action,
    action_detail: derived.action_detail,
    responsible_role: derived.responsible_role,
    receipt_chain_valid: derived.receipt_chain_valid,
    stage_id: input.stageId,
    ...(derived.slice_id !== undefined ? { slice_id: derived.slice_id } : {}),
    ...(derived.task_id !== undefined ? { task_id: derived.task_id } : {}),
    manifest_digest: manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    snapshot_digest: requestedSnapshot,
    findings: derived.findings,
  };
}

type ResolvedNextContext =
  | { readonly archived: true; readonly closeFacts: ReturnType<typeof readStageCloseFacts> }
  | {
      readonly archived: false;
      readonly manifest: VNextManifest;
      readonly manifestDigest: string;
      readonly authority: VNextAdmissionAuthority;
      readonly authoritySnapshot: string;
      readonly requestedSnapshot: string;
      readonly derived: DerivedNextAction;
      readonly workerFacts: readonly VNextWorkerFact[];
      readonly committedSliceIds: ReadonlySet<string>;
      readonly cvRepairTips: ReadonlyMap<string, string>;
    };

function resolveVNextNextActionContext(input: VNextNextActionInput): ResolvedNextContext {
  assertCanonicalStageId(input.stageId, 'stageId');
  const closeFacts = readStageCloseFacts(input.projectRoot, input.stageId);
  if (closeFacts.archived) {
    return { archived: true, closeFacts };
  }
  const manifestPath = input.manifestPath ?? path.join(input.projectRoot, '.proofloop', 'manifests', `${input.stageId}.json`);
  const manifest = readVNextManifest(input.projectRoot, manifestPath);
  if (manifest.stage_id !== input.stageId) {
    throw new VNextHandoffError('manifest-binding', `Manifest stage_id "${manifest.stage_id}" does not match "${input.stageId}"`);
  }
  const manifestDigest = computeDigest(manifest);
  const authority = resolveNextAdmissionAuthority(input.projectRoot, input.stageId, input.admissionPath);
  if (input.verifyReferenceBindings !== false) {
    assertVNextManifestReferenceBindings(input.projectRoot, manifest);
  }
  const authoritySnapshot = authority.spv.snapshot_digest;
  const replanDispositions = loadAncestorReplanDispositionRecords(input.projectRoot, input.stageId);
  const historicalInvalidatedForCurrentness = computeChainInvalidatedTaskIds(replanDispositions);
  const sliceLocalChain =
    manifest.binding !== undefined
      ? readVNextIntegrationReceiptChain(input.projectRoot, manifest, historicalInvalidatedForCurrentness)
      : [];
  const currentIntegratedSliceIds = readVNextCurrentIntegratedSliceIds(
    input.projectRoot,
    manifest,
    manifestDigest,
    sliceLocalChain,
    historicalInvalidatedForCurrentness,
  );
  const { workerFacts, finalizeFacts, historicalInvalidatedTaskIds } = readVNextWorkerFacts(
    input.projectRoot,
    manifest,
    manifestDigest,
    authoritySnapshot,
    currentIntegratedSliceIds,
    sliceLocalChain,
    replanDispositions,
  );
  const committedSliceIds = readVNextCommittedSliceIds(
    input.projectRoot,
    manifest,
    manifestDigest,
    manifest.plan.plan_digest,
    authoritySnapshot,
    workerFacts,
    finalizeFacts,
    currentIntegratedSliceIds,
    sliceLocalChain,
    replanDispositions,
  );
  const activeWorkerFacts = workerFacts.filter(
    (fact) => !committedSliceIds.has(fact.slice.slice_id),
  );
  if (activeWorkerFacts.length > 0) {
    assertIgnoredProtectedPaths(
      input.projectRoot,
      activeWorkerFacts.map((fact) => ({
        stageId: manifest.stage_id,
        sliceId: fact.slice.slice_id,
        taskId: fact.taskId ?? '',
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
    assertExecutionSnapshotChain(
      resolveGitRoot(input.projectRoot),
      requestedSnapshot,
      authoritySnapshot,
      'requested',
    );
  }
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
  const selectedSliceScope = () =>
    selectedSlice === undefined
      ? []
      : unique(
          taskIdsForSlice(manifest, selectedSlice).flatMap((taskId) =>
            taskAllowedScope(input.projectRoot, manifest, selectedSlice, taskId),
          ),
        );
  const preExecutionDirty = gitChangedPaths(input.projectRoot);
  const executionStarted = activeWorkerFacts.length > 0 || committedSliceIds.size > 0 || replanDispositions.length > 0;
  if (!executionStarted) {
    if (preExecutionDirty.length === 0) {
      assertStableGitBoundary(input.projectRoot, requestedSnapshot);
    } else {
      assertExecutionDirtyBoundary(input.projectRoot, authoritySnapshot, selectedSliceScope());
      const firstTaskId = selectedSlice === undefined ? undefined : taskIdsForSlice(manifest, selectedSlice)[0];
      if (firstTaskId === undefined) {
        throw new VNextHandoffError('task-anchor-gap', 'Slice has no declarable Task anchor');
      }
      if (completionModeForDispatch(input.projectRoot, manifest, firstTaskId, historicalInvalidatedTaskIds) === 'implement-task') {
        throw new VNextHandoffError(
          'execution-scope-gap',
          `planning clean boundary: scope-bound dirty worktree without Worker facts and without a recover binding fails closed (${firstTaskId} checkbox is unchecked)`,
        );
      }
    }
  } else {
    assertExecutionDirtyBoundary(
      input.projectRoot,
      authoritySnapshot,
      unique([
        ...activeWorkerFacts.flatMap((fact) => fact.allowedScope),
        ...selectedSliceScope(),
      ]),
    );
  }
  assertActiveVNextAuthority(
    authority,
    input.stageId,
    manifestDigest,
    manifest.plan.plan_digest,
    authoritySnapshot,
  );
  const cvRepairTips = new Map<string, string>();
  const derived = deriveVNextCanonicalNextAction(
    {
      input,
      manifest,
      manifestDigest,
      authority,
      authoritySnapshot,
      currentIntegratedSliceIds,
      workerFacts,
      finalizeFacts,
      committedSliceIds,
      sliceLocalChain,
      historicalInvalidatedTaskIds,
      replanDispositions,
    },
    cvRepairTips,
  );
  return {
    archived: false,
    manifest,
    manifestDigest,
    authority,
    authoritySnapshot,
    requestedSnapshot,
    derived,
    workerFacts,
    committedSliceIds,
    cvRepairTips,
  };
}

export function deriveVNextWorkerDispatchForStage(
  projectRoot: string,
  stageId: string,
  options?: { readonly verifyReferenceBindings?: boolean; readonly snapshotDigest?: string },
): VNextWorkerDispatch {
  const input: VNextNextActionInput = {
    projectRoot,
    stageId,
    persistContext: false,
    verifyReferenceBindings: options?.verifyReferenceBindings,
    snapshotDigest: options?.snapshotDigest,
  };
  const resolved = resolveVNextNextActionContext(input);
  if (resolved.archived) {
    throw new VNextHandoffError('task-anchor-gap', `stage "${stageId}" is archived`);
  }
  if (resolved.derived.action !== 'DISPATCH_WORKER') {
    throw new VNextHandoffError(
      'task-anchor-gap',
      `stage "${stageId}" is not in DISPATCH_WORKER state (current action: ${resolved.derived.action})`,
    );
  }
  return deriveWorkerDispatch(
    input,
    resolved.manifest,
    resolved.manifestDigest,
    resolved.authority,
    resolved.requestedSnapshot,
    resolved.derived,
    resolved.workerFacts,
    resolved.committedSliceIds,
    resolved.cvRepairTips,
  );
}

export class VNextNextActionService {
  nextAction(input: VNextNextActionInput): VNextNextActionOutput {
    try {
      const resolved = resolveVNextNextActionContext(input);
      if (resolved.archived) {
        return archivedOutput(input.stageId, resolved.closeFacts);
      }
      return projectVNextDerivedAction(
        input,
        resolved.manifest,
        resolved.manifestDigest,
        resolved.authority,
        resolved.requestedSnapshot,
        resolved.derived,
        resolved.workerFacts,
        resolved.committedSliceIds,
        resolved.cvRepairTips,
      );
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
// Role closure (Seam Role transfer): all active roles use distinct Contexts;
// `role` is part of the Context content digest, so a Context projected for one role can never
// be reused for another role (the role check fails closed on content digest or explicit role mismatch).
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
  /** Persisted role facts used by the active role projections. */
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
 * proof refs, evidence-read binding for initial CV, review scope + full review refs for Reviewers).  `role` AND
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
  /** Digest-addressed Receipt refs of the bound Slice (tasks/cv/SLICE_COMMIT). */
  readonly receiptRefs?: readonly string[];
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
      cvRepairHistory: input.roleFacts?.cvRepairHistory,
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

function gitTreeContains(root: string, commitSha: string, filePath: string): boolean {
  try {
    const listing = execFileSync('git', ['-C', root, 'ls-tree', '-r', '--name-only', commitSha, '--'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return listing.split('\n').some((line) => line.trimEnd() === filePath);
  } catch {
    return false;
  }
}
