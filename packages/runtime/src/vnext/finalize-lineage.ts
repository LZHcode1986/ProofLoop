/**
 * Cycle-free shared vNext lineage and protected-artifact seams.
 * This module is intentionally independent of `next`, `worker-admission`, and
 * `cv-admission`. Runtime consumers use it for the persisted replan lineage
 * classifier and historical finalize validation. No consumer state is written here.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeDigest,
} from '@proofloop/kernel';
import type {
  Receipt,
  VNextExecutionScope,
  VNextManifest,
  VNextManifestSlice,
} from '@proofloop/kernel';
import {
  computeExecutionBindingDigest,
  validateDependencyBinding,
  type VNextDependencyBinding,
} from '@proofloop/kernel/dist/vnext';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import { readGitHead, resolveGitRoot } from '../git-source';
import {
  committerReceiptDir,
  integrationReceiptDir,
} from '../receipt-layout';
import { assertSliceLocalCredentialBindingFields, assertUpstreamTaskCompleteSemantics } from './cv-validation';
import { VNextHandoffError } from './errors';
import { buildVNextHistoricalManifest } from './historical-manifest';
import {
  assertCommittedChangedFiles,
  readReceiptChain,
  rootRelativePath,
  sliceBinding,
  validateCvFacts,
  validateIntegrationPayload,
  validateSliceCommitPayload,
  validateWorkerFacts,
} from './integration-validation';
import type { TupleBinding } from './integration-validation';
import { loadAncestorReplanDispositionRecords } from './replan-epoch';
import type { ReplanAncestorDispositionRecord, ReplanDispositionFact } from './replan-epoch';
import type { ReplanPlanSnapshotInput } from './replan-impact';
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const SNAPSHOT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export type VNextFinalizeLineage =
  | { readonly kind: 'current' }
  | { readonly kind: 'carried-forward'; readonly dispositionFact: ReplanDispositionFact }
  | { readonly kind: 'invalidated'; readonly dispositionFact: ReplanDispositionFact };
const HISTORICAL_FINALIZE_PROTECTED_PATHS = [
  '.proofloop/manifests',
  '.proofloop/receipts',
  '.proofloop/runtime',
  '.proofloop/runtime.lock',
  '.proofloop/context',
  '.git',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.startsWith('//') || value.includes('\\') || value.includes('\u0000')) {
    throw new VNextHandoffError('path-escape', `${label} must be a canonical root-relative path`);
  }
  const parts = value.split('/');
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

function factString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new VNextHandoffError('admission-invalid', `${label} must be a non-empty string`);
  }
  return value;
}

function factDigest(value: unknown, label: string, length: 40 | 64): string {
  const digest = factString(value, label);
  const re = length === 40 ? GIT_SHA_RE : SHA256_RE;
  if (!re.test(digest)) {
    throw new VNextHandoffError('admission-invalid', `${label} is not a valid ${length === 40 ? 'Git' : 'SHA-256'} digest`);
  }
  return digest;
}

function factStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new VNextHandoffError('admission-invalid', `${label} must be an array of non-empty strings`);
  }
  return [...value] as string[];
}

function readRootBoundJson(root: string, relative: string, label: string): unknown {
  const canonicalRelative = rootRelativeFactPath(root, relative, label);
  const opened = openNoFollowRead(root, path.resolve(root, ...canonicalRelative.split('/')));
  if (!opened.ok) throw new VNextHandoffError('path-escape', `${label} is missing or not root-bound`);
  try {
    return JSON.parse(fs.readFileSync(opened.fd, 'utf8')) as unknown;
  } catch (error) {
    throw new VNextHandoffError('admission-invalid', `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    fs.closeSync(opened.fd);
  }
}

function readRootBoundRecord(root: string, relative: string, label: string): Record<string, unknown> {
  const parsed = readRootBoundJson(root, relative, label);
  if (!isRecord(parsed)) throw new VNextHandoffError('admission-invalid', `${label} must be a JSON object`);
  return parsed;
}
function assertHistoricalContextPersisted(root: string, contextRef: unknown, contextDigest: unknown, label: string): void {
  const ref = rootRelativeFactPath(root, contextRef, `${label}.context_ref`);
  const digest = factDigest(contextDigest, `${label}.context_digest`, 64);
  const context = readRootBoundRecord(root, ref, `${label} Context`);
  if (context.context_digest !== digest) {
    throw new VNextHandoffError('manifest-binding', `${label} Context digest does not match its digest address`);
  }
  const withoutDigest = { ...context };
  delete withoutDigest.context_digest;
  if (computeDigest(withoutDigest) !== digest) {
    throw new VNextHandoffError('manifest-binding', `${label} Context content digest is invalid`);
  }
}
function assertHistoricalCredentialContext(
  root: string,
  payload: Record<string, unknown>,
  stageId: string,
  sliceId: string,
  label: string,
): void {
  const contextRef = factString(payload.context_ref, `${label}.context_ref`);
  const contextDigest = factDigest(payload.context_digest, `${label}.context_digest`, 64);
  assertHistoricalContextPersisted(root, contextRef, contextDigest, label);
  const context = readRootBoundRecord(root, contextRef, `${label} Context`);
  if (context.root_path !== root || context.root_digest !== computeDigest(root) || context.stage_id !== stageId || context.slice_id !== sliceId || context.manifest_digest !== payload.manifest_digest || context.plan_digest !== payload.plan_digest || context.proof_index_digest !== payload.proof_index_digest || context.snapshot_digest !== payload.snapshot_digest) {
    throw new VNextHandoffError('manifest-binding', `${label} Context is not bound to its historical credential tuple`);
  }
  if (typeof payload.mode === 'string' && context.mode !== payload.mode) {
    throw new VNextHandoffError('manifest-binding', `${label} Context mode is not bound to its historical credential`);
  }
  if (payload.evidence_ref !== undefined && context.evidence_path !== payload.evidence_ref) {
    throw new VNextHandoffError('manifest-binding', `${label} Context evidence path is not bound to its historical credential`);
  }
  if (payload.task_id !== undefined && context.task_id !== payload.task_id) {
    throw new VNextHandoffError('manifest-binding', `${label} Context task identity is not bound to its historical credential`);
  }
  if (payload.mode === 'finalize-slice' && context.task_id !== undefined) {
    throw new VNextHandoffError('task-anchor-gap', `${label} finalize Context must be taskless`);
  }
}


function exactPreviousTuple(
  fact: ReplanDispositionFact,
  stageId: string,
  manifestDigest: string,
  planDigest: string,
  snapshotDigest: string,
): boolean {
  const previous = fact.previous_snapshot;
  return fact.stage_id === stageId &&
    fact.disposition.stage_id === stageId &&
    previous.stage_id === stageId &&
    fact.disposition.previous_manifest_digest === manifestDigest &&
    fact.disposition.previous_plan_digest === planDigest &&
    fact.disposition.snapshot_digest === fact.snapshot.snapshot_digest &&
    previous.manifest_digest === manifestDigest &&
    previous.plan_digest === planDigest &&
    previous.snapshot_digest === snapshotDigest;
}


/**
 * Classify one taskless finalize receipt against exactly one persisted
 * disposition generation. Mixed invalidated/carry-forward task sets are legal;
 * any invalidated member makes the old closure invalidated.
 */
export function classifyVNextFinalizeLineage(
  stageId: string,
  taskIds: readonly string[],
  manifestDigest: string,
  planDigest: string,
  snapshotDigest: string,
  replanDispositions: readonly ReplanAncestorDispositionRecord[],
): VNextFinalizeLineage {
  const declared = new Set(taskIds);
  if (declared.size === 0 || declared.size !== taskIds.length) {
    throw new VNextHandoffError('admission-invalid', 'finalize-slice lineage task set is invalid');
  }
  const exact = replanDispositions.filter((record) => exactPreviousTuple(record.dispositionFact, stageId, manifestDigest, planDigest, snapshotDigest));
  if (exact.length === 0) return { kind: 'current' };
  if (exact.length !== 1) {
    throw new VNextHandoffError('admission-invalid', 'finalize-slice lineage has multiple exact persisted disposition authorities');
  }
  const fact = exact[0].dispositionFact;
  const stageDeclaredTaskIds = new Set<string>([
    ...fact.previous_snapshot.tasks.map((task) => task.task_id),
    ...fact.previous_snapshot.slices.flatMap((slice) => slice.task_ids),
  ]);
  const invalidatedTaskIds = fact.disposition.invalidated_task_ids;
  const carriedForwardTaskIds = fact.disposition.carry_forward_task_ids;
  const allDispositionTaskIds = [...invalidatedTaskIds, ...carriedForwardTaskIds];
  if (new Set(invalidatedTaskIds).size !== invalidatedTaskIds.length || new Set(carriedForwardTaskIds).size !== carriedForwardTaskIds.length) {
    throw new VNextHandoffError('admission-invalid', 'finalize-slice lineage disposition contains duplicate task identities');
  }
  if (allDispositionTaskIds.some((taskId) => typeof taskId !== 'string' || !stageDeclaredTaskIds.has(taskId))) {
    throw new VNextHandoffError('admission-invalid', 'finalize-slice lineage disposition contains a foreign or undeclared Stage task');
  }
  const matchingPreviousSlices = fact.previous_snapshot.slices.filter((slice) => {
    const historical = new Set(slice.task_ids);
    return historical.size === declared.size && [...declared].every((taskId) => historical.has(taskId));
  });
  if (matchingPreviousSlices.length !== 1) {
    throw new VNextHandoffError('admission-invalid', 'finalize-slice lineage previous generation has no unique exact Slice task authority');
  }
  const historicalTaskIds = matchingPreviousSlices[0].task_ids;
  if (historicalTaskIds !== undefined) {
    const historical = new Set(historicalTaskIds);
    if (historical.size !== declared.size || [...declared].some((id) => !historical.has(id))) {
      throw new VNextHandoffError('admission-invalid', 'finalize-slice lineage previous generation does not declare the active Slice task set');
    }
  }
  if (fact.disposition.impact_scope === 'unresolved') {
    throw new VNextHandoffError('admission-invalid', 'finalize-slice lineage disposition is unresolved');
  }
  const invalidated = new Set(invalidatedTaskIds.filter((id) => declared.has(id)));
  const carried = new Set(carriedForwardTaskIds.filter((id) => declared.has(id)));
  if ([...invalidated].some((id) => carried.has(id))) {
    throw new VNextHandoffError('admission-invalid', 'finalize-slice lineage has ambiguous carry-forward and invalidated bindings for one task');
  }
  const union = new Set([...invalidated, ...carried]);
  if (union.size !== declared.size || [...declared].some((id) => !union.has(id))) {
    throw new VNextHandoffError('admission-invalid', 'finalize-slice lineage is partial or ambiguous for the exact previous generation');
  }
  return invalidated.size > 0
    ? { kind: 'invalidated', dispositionFact: fact }
    : { kind: 'carried-forward', dispositionFact: fact };
}

/** Classify a persisted Worker Receipt as historical invalidated lineage. */
export function isVNextHistoricalInvalidatedWorkerPayload(
  payload: Record<string, unknown>,
  stageId: string,
  taskIds: readonly string[],
  replanDispositions: readonly ReplanAncestorDispositionRecord[],
): boolean {
  const manifestDigest = payload.manifest_digest;
  const planDigest = payload.plan_digest;
  const snapshotDigest = payload.snapshot_digest;
  if (typeof manifestDigest !== 'string' || typeof planDigest !== 'string' || typeof snapshotDigest !== 'string') return false;
  if (payload.mode === 'finalize-slice') {
    return classifyVNextFinalizeLineage(
      stageId,
      taskIds,
      manifestDigest,
      planDigest,
      snapshotDigest,
      replanDispositions,
    ).kind === 'invalidated';
  }
  const taskId = typeof payload.task_id === 'string' ? payload.task_id : undefined;
  if (taskId === undefined || !taskIds.includes(taskId)) return false;
  const exact = replanDispositions.filter((record) =>
    exactPreviousTuple(record.dispositionFact, stageId, manifestDigest, planDigest, snapshotDigest),
  );
  if (exact.length === 0) return false;
  if (exact.length !== 1) {
    throw new VNextHandoffError('admission-invalid', 'historical Worker lineage has multiple exact persisted disposition authorities');
  }
  const disposition = exact[0].dispositionFact.disposition;
  return disposition.invalidated_task_ids.includes(taskId) && !disposition.carry_forward_task_ids.includes(taskId);
}

/** Classify a persisted CV Receipt as historical invalidated lineage. */
export function isVNextHistoricalInvalidatedCvPayload(
  payload: Record<string, unknown>,
  stageId: string,
  taskIds: readonly string[],
  allWorkerReceipts: readonly Receipt[],
  currentWorkerReceipts: readonly Receipt[],
  replanDispositions: readonly ReplanAncestorDispositionRecord[],
 ): boolean {
  const manifestDigest = payload.manifest_digest;
  const planDigest = payload.plan_digest;
  const snapshotDigest = payload.snapshot_digest;
  const workerDigest = payload.worker_receipt_digest;
  if (typeof manifestDigest !== 'string' || typeof planDigest !== 'string' || typeof snapshotDigest !== 'string' || typeof workerDigest !== 'string') return false;
  if (currentWorkerReceipts.some((receipt) => receipt.digest === workerDigest)) return false;
  const linked = allWorkerReceipts.find((receipt) => receipt.digest === workerDigest);
  if (linked === undefined || !isRecord(linked.payload)) return false;
  const linkedTaskId = typeof linked.payload.task_id === 'string' ? linked.payload.task_id : undefined;
  const hasCurrentSuccessor = linkedTaskId !== undefined
    ? currentWorkerReceipts.some((receipt) => receipt.digest !== workerDigest && isRecord(receipt.payload) && receipt.payload.task_id === linkedTaskId)
    : currentWorkerReceipts.length > 0;
  if (!hasCurrentSuccessor) return false;
  const exact = replanDispositions.filter((record) =>
    exactPreviousTuple(record.dispositionFact, stageId, manifestDigest, planDigest, snapshotDigest),
  );
  if (exact.length === 0) return false;
  if (exact.length !== 1) {
    throw new VNextHandoffError('admission-invalid', 'historical CV lineage has multiple exact persisted disposition authorities');
  }
  const disposition = exact[0].dispositionFact.disposition;
  if (linkedTaskId !== undefined) {
    return taskIds.includes(linkedTaskId) && disposition.invalidated_task_ids.includes(linkedTaskId) && !disposition.carry_forward_task_ids.includes(linkedTaskId);
  }
  return taskIds.length > 0 && taskIds.every((taskId) => disposition.invalidated_task_ids.includes(taskId)) && taskIds.every((taskId) => !disposition.carry_forward_task_ids.includes(taskId));
}
/** Validate the structural part of a historical Slice Commit before skip. */
export function isVNextHistoricalInvalidatedCommitPayload(
  payload: Record<string, unknown>,
  stageId: string,
  sliceId: string,
  taskIds: readonly string[],
  replanDispositions: readonly ReplanAncestorDispositionRecord[],
 ): boolean {
  if (payload.type !== 'SLICE_COMMIT_RESULT' || payload.action !== 'SLICE_COMMIT' || payload.stage_id !== stageId || payload.slice_id !== sliceId || payload.receipt_chain_valid !== true) return false;
  if (payload.schema_version !== 2 && payload.schema_version !== 3) return false;
  if (typeof payload.manifest_digest !== 'string' || typeof payload.plan_digest !== 'string' || typeof payload.proof_index_digest !== 'string' || typeof payload.snapshot_digest !== 'string') return false;
  if (typeof payload.commit_sha !== 'string' || !GIT_SHA_RE.test(payload.commit_sha)) return false;
  if (typeof payload.cv_receipt_digest !== 'string' || !SHA256_RE.test(payload.cv_receipt_digest)) return false;
  if (!Array.isArray(payload.changed_files) || payload.changed_files.length === 0 || payload.changed_files.some((value) => typeof value !== 'string')) return false;
  return classifyVNextFinalizeLineage(
    stageId,
    taskIds,
    payload.manifest_digest,
    payload.plan_digest,
    payload.snapshot_digest,
    replanDispositions,
  ).kind === 'invalidated';
}

export function isVNextHistoricalInvalidatedIntegrationPayload(
  payload: Record<string, unknown>,
  stageId: string,
  sliceId: string,
  taskIds: readonly string[],
  replanDispositions: readonly ReplanAncestorDispositionRecord[],
 ): boolean {
  if (payload.type !== 'INTEGRATION_RESULT' || payload.action !== 'INTEGRATION' || payload.stage_id !== stageId || payload.slice_id !== sliceId || payload.receipt_chain_valid !== true) return false;
  if (payload.schema_version !== 2 && payload.schema_version !== 3) return false;
  if (typeof payload.manifest_digest !== 'string' || typeof payload.plan_digest !== 'string' || typeof payload.proof_index_digest !== 'string' || typeof payload.snapshot_digest !== 'string') return false;
  if (typeof payload.commit_sha !== 'string' || !GIT_SHA_RE.test(payload.commit_sha) || typeof payload.slice_commit_receipt_digest !== 'string' || !SHA256_RE.test(payload.slice_commit_receipt_digest) || typeof payload.cv_receipt_digest !== 'string' || !SHA256_RE.test(payload.cv_receipt_digest) || typeof payload.worker_receipt_digest !== 'string' || !SHA256_RE.test(payload.worker_receipt_digest)) return false;
  return classifyVNextFinalizeLineage(
    stageId,
    taskIds,
    payload.manifest_digest,
    payload.plan_digest,
    payload.snapshot_digest,
    replanDispositions,
  ).kind === 'invalidated';
}

export type VNextFinalizeLineagePayload = Record<string, unknown>;

function assertCommitAncestor(root: string, ancestor: string, descendant: string, label: string): void {
  if (!GIT_SHA_RE.test(ancestor) || !GIT_SHA_RE.test(descendant)) {
    throw new VNextHandoffError('manifest-binding', `${label} is not bound to canonical Git commits`);
  }
  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(root);
    execFileSync('git', ['-C', gitRoot, 'merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    throw new VNextHandoffError('manifest-binding', `${label} is not an ancestor-chain binding: ${ancestor} -> ${descendant}`);
  }
}

function assertOnCurrentHead(root: string, commit: string, label: string): void {
  const gitRoot = resolveGitRoot(root);
  const head = readGitHead(gitRoot);
  assertCommitAncestor(root, commit, head, label);
}


function requirePayload(receipt: Receipt, label: string): Record<string, unknown> {
  if (!isRecord(receipt.payload)) throw new VNextHandoffError('admission-invalid', `${label}.payload must be an object`);
  return receipt.payload;
}

function validateIntegrationCredential(
  root: string,
  receipt: Receipt,
  stageId: string,
  sliceId: string,
  visited: Set<string>,
  historicalManifest: VNextManifest,
  asOfSnapshotDigest: string,
  historicalGenerationSnapshotDigest?: string,
 ): Record<string, unknown> {
  const label = `INTEGRATION_PASS ${stageId}/${sliceId}/${receipt.digest}`;
  if (receipt.type !== 'INTEGRATION_PASS' || receipt.stage_id !== stageId || receipt.slice_id !== sliceId) {
    throw new VNextHandoffError('manifest-binding', `${label} has an invalid stage/slice/type binding`);
  }
  const payload = requirePayload(receipt, label);
  try {
    const tuple: TupleBinding = {
      stageId,
      sliceId,
      manifestDigest: factDigest(payload.manifest_digest, `${label}.manifest_digest`, 64),
      planDigest: factDigest(payload.plan_digest, `${label}.plan_digest`, 64),
      proofIndexDigest: factDigest(payload.proof_index_digest, `${label}.proof_index_digest`, 64),
      snapshotDigest: factDigest(payload.snapshot_digest, `${label}.snapshot_digest`, 40),
    };
    const commitSha = factDigest(payload.commit_sha, `${label}.commit_sha`, 40);
    const stageContractDigest = factDigest(payload.stage_contract_digest, `${label}.stage_contract_digest`, 64);
    const sliceContractDigest = factDigest(payload.slice_contract_digest, `${label}.slice_contract_digest`, 64);
    const executionBindingDigest = factDigest(payload.execution_binding_digest, `${label}.execution_binding_digest`, 64);
    if (payload.receipt_chain_valid !== true || payload.schema_version !== 3 || !Array.isArray(payload.dependency_bindings)) {
      throw new VNextHandoffError('admission-invalid', `${label} is not a closed schema_version 3 Integration credential`);
    }
    const dependencyBindings: VNextDependencyBinding[] = [];
    for (const [index, raw] of payload.dependency_bindings.entries()) {
      try { validateDependencyBinding(raw); } catch (error) { throw new VNextHandoffError('admission-invalid', `${label}.dependency_bindings[${index}] is malformed: ${error instanceof Error ? error.message : String(error)}`); }
      dependencyBindings.push(raw as VNextDependencyBinding);
    }
    const expectedBinding = computeExecutionBindingDigest({ stage_id: stageId, slice_id: sliceId, stage_contract_digest: stageContractDigest, slice_contract_digest: sliceContractDigest, dependency_bindings: dependencyBindings, base_snapshot_digest: tuple.snapshotDigest });
    if (executionBindingDigest !== expectedBinding) throw new VNextHandoffError('manifest-binding', `${label}.execution_binding_digest is not self-consistent`);
    assertCommitAncestor(root, tuple.snapshotDigest, commitSha, `${label} candidate snapshot -> integration head`);
    if (historicalGenerationSnapshotDigest !== undefined) assertCommitAncestor(root, tuple.snapshotDigest, historicalGenerationSnapshotDigest, `${label} candidate snapshot -> historical generation`);
    if (visited.has(receipt.digest)) return payload;
    visited.add(receipt.digest);
    const slice = sliceBinding(root, historicalManifest, sliceId);
    const expectedLocalBinding = { stageContractDigest, sliceContractDigest, executionBindingDigest };
    validateIntegrationPayload(payload, `${label}.payload`, root, true, expectedLocalBinding);
    const workerTipDigest = factDigest(payload.worker_receipt_digest, `${label}.worker_receipt_digest`, 64);
    const cvTipDigest = factDigest(payload.cv_receipt_digest, `${label}.cv_receipt_digest`, 64);
    for (const dependency of dependencyBindings) {
      const dependencyChain = readReceiptChain(root, integrationReceiptDir(root, stageId, dependency.slice_id), `${label} dependency ${dependency.slice_id} Integration`);
      const referenced = dependencyChain.receipts.find((candidate) => candidate.digest === dependency.integration_receipt_digest);
      if (referenced === undefined) throw new VNextHandoffError('manifest-binding', `${label} references missing dependency Integration Receipt ${dependency.integration_receipt_digest}`);
      const dependencyPayload = validateIntegrationCredential(root, referenced, stageId, dependency.slice_id, visited, historicalManifest, asOfSnapshotDigest, historicalGenerationSnapshotDigest);
      if (dependencyPayload.commit_sha !== dependency.integration_head_sha || dependencyPayload.slice_contract_digest !== dependency.slice_contract_digest) throw new VNextHandoffError('manifest-binding', `${label} dependency binding does not match persisted Integration credential`);
      assertCommitAncestor(root, dependency.integration_head_sha, tuple.snapshotDigest, `${label} dependency ${dependency.slice_id}`);
      assertCommitAncestor(root, dependency.integration_head_sha, asOfSnapshotDigest, `${label} dependency ${dependency.slice_id} as-of snapshot`);
    }
    assertCommitAncestor(root, commitSha, asOfSnapshotDigest, `${label} integration head as-of snapshot`);
    const worker = validateWorkerFacts(root, historicalManifest, slice, tuple, expectedLocalBinding, workerTipDigest);
    const cv = validateCvFacts(root, slice, true, tuple, worker, expectedLocalBinding, cvTipDigest, false, historicalManifest);
    if (cv.final.worker_receipt_digest !== worker.tipDigest) throw new VNextHandoffError('manifest-binding', `${label} CV is not bound to the complete historical Worker chain`);
    const commitChain = readReceiptChain(root, committerReceiptDir(root, stageId, sliceId), `${label} Slice Commit`);
    const commit = commitChain.receipts.find((candidate) => candidate.digest === payload.slice_commit_receipt_digest);
    if (commit === undefined || commit.type !== 'SLICE_COMMIT') throw new VNextHandoffError('manifest-binding', `${label} Slice Commit reference is not a complete historical credential`);
    const changedFiles = factStringArray(payload.changed_files, `${label}.changed_files`);
    validateSliceCommitPayload(root, historicalManifest, commit, tuple, true, slice, worker, cv, commitSha, changedFiles, expectedLocalBinding);
    const declaredChangedFiles = unique(changedFiles.map((value, index) => rootRelativePath(root, value, `${label}.changed_files[${index}]`))).sort();
    const actualChangedFiles = assertCommittedChangedFiles(root, historicalManifest, tuple, commitSha, slice, worker, cv);
    if (computeDigest(actualChangedFiles) !== computeDigest(declaredChangedFiles)) throw new VNextHandoffError('manifest-binding', `${label}.changed_files does not equal the canonical parent-to-commit Git diff`);
    if (payload.worker_receipt_digest !== worker.tipDigest || payload.cv_receipt_digest !== cv.tipDigest) throw new VNextHandoffError('manifest-binding', `${label} upstream Receipt references do not bind the canonical historical tips`);
    return payload;
  } catch (error) {
    if (error instanceof VNextHandoffError) throw error;
    throw new VNextHandoffError('manifest-binding', `${label} historical chain validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isHistoricalDependencyCandidateInvalidated(
  root: string,
  previous: ReplanPlanSnapshotInput,
  dependencySlice: ReplanPlanSnapshotInput['slices'][number],
  payload: Record<string, unknown>,
 ): boolean {
  let candidateManifestDigest: string;
  let candidatePlanDigest: string;
  let candidateSnapshotDigest: string;
  try {
    candidateManifestDigest = factDigest(payload.manifest_digest, 'historical dependency Integration.manifest_digest', 64);
    candidatePlanDigest = factDigest(payload.plan_digest, 'historical dependency Integration.plan_digest', 64);
    candidateSnapshotDigest = factDigest(payload.snapshot_digest, 'historical dependency Integration.snapshot_digest', 40);
    assertCommitAncestor(root, candidateSnapshotDigest, previous.snapshot_digest, 'historical dependency candidate snapshot -> historical finalize snapshot');
  } catch {
    return true;
  }
  const tupleKey = (value: { readonly stage_id: string; readonly manifest_digest: string; readonly plan_digest: string; readonly snapshot_digest: string }): string =>
    `${value.stage_id}:${value.manifest_digest}:${value.plan_digest}:${value.snapshot_digest}`;
  const candidateTuple = {
    stage_id: previous.stage_id,
    manifest_digest: candidateManifestDigest,
    plan_digest: candidatePlanDigest,
    snapshot_digest: candidateSnapshotDigest,
  };
  const targetTuple = {
    stage_id: previous.stage_id,
    manifest_digest: previous.manifest_digest,
    plan_digest: previous.plan_digest,
    snapshot_digest: previous.snapshot_digest,
  };
  const sameArray = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  const sameDependencySlice = (left: ReplanPlanSnapshotInput['slices'][number], right: ReplanPlanSnapshotInput['slices'][number]): boolean =>
    left.slice_id === right.slice_id &&
    left.slice_contract_digest === right.slice_contract_digest &&
    sameArray(left.task_ids, right.task_ids) &&
    sameArray(left.depends_on, right.depends_on) &&
    computeDigest(left.proof_index) === computeDigest(right.proof_index);
  const dispositionIsClosedForSnapshot = (
    snapshot: ReplanPlanSnapshotInput,
    record: ReplanAncestorDispositionRecord,
  ): boolean => {
    const declared = new Set([
      ...snapshot.tasks.map((task) => task.task_id),
      ...snapshot.slices.flatMap((slice) => slice.task_ids),
    ]);
    const invalidated = record.dispositionFact.disposition.invalidated_task_ids;
    const carried = record.dispositionFact.disposition.carry_forward_task_ids;
    if (new Set(invalidated).size !== invalidated.length || new Set(carried).size !== carried.length) return false;
    if (invalidated.some((taskId) => !declared.has(taskId)) || carried.some((taskId) => !declared.has(taskId))) return false;
    if (invalidated.some((taskId) => carried.includes(taskId))) return false;
    return record.dispositionFact.disposition.impact_scope !== 'unresolved';
  };
  let records: ReplanAncestorDispositionRecord[];
  try {
    records = loadAncestorReplanDispositionRecords(root, previous.stage_id).filter((record) => {
      try {
        assertCommitAncestor(root, record.dispositionFact.snapshot.snapshot_digest, previous.snapshot_digest, 'historical dependency disposition as-of snapshot');
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return true;
  }
  if (tupleKey(candidateTuple) === tupleKey(targetTuple)) return false;
  const chronological = [...records].reverse();
  let cursor = candidateTuple;
  let started = false;
  for (const record of chronological) {
    const disposition = record.dispositionFact;
    const previousSnapshot = disposition.previous_snapshot;
    const candidateSnapshot = disposition.snapshot;
    if (!started) {
      if (tupleKey(previousSnapshot) !== tupleKey(cursor)) continue;
      started = true;
    } else if (tupleKey(previousSnapshot) !== tupleKey(cursor)) {
      return true;
    }
    if (!dispositionIsClosedForSnapshot(previousSnapshot, record)) return true;
    const previousDependency = previousSnapshot.slices.find((slice) => slice.slice_id === dependencySlice.slice_id);
    const nextDependency = candidateSnapshot.slices.find((slice) => slice.slice_id === dependencySlice.slice_id);
    if (previousDependency === undefined || nextDependency === undefined || !sameDependencySlice(previousDependency, nextDependency)) return true;
    const dependencyTaskIds = previousDependency.task_ids;
    const invalidated = disposition.disposition.invalidated_task_ids;
    const carried = disposition.disposition.carry_forward_task_ids;
    if (dependencyTaskIds.some((taskId) => !carried.includes(taskId) || invalidated.includes(taskId))) return true;
    cursor = {
      stage_id: candidateSnapshot.stage_id,
      manifest_digest: candidateSnapshot.manifest_digest,
      plan_digest: candidateSnapshot.plan_digest,
      snapshot_digest: candidateSnapshot.snapshot_digest,
    };
  }
  return !started || tupleKey(cursor) !== tupleKey(targetTuple);
}

function historicalDependencyBindings(
  root: string,
  previous: ReplanPlanSnapshotInput,
  sliceId: string,
  expectedExecutionBindingDigest: string,
  historicalManifest: VNextManifest,
  currentSnapshotDigest: string,
 ): VNextDependencyBinding[] {
  const slice = previous.slices.find((candidate) => candidate.slice_id === sliceId);
  if (slice === undefined) throw new VNextHandoffError('manifest-binding', `historical previous_snapshot does not declare Slice ${sliceId}`);
  const candidateSets: Array<readonly VNextDependencyBinding[]> = [];
  for (const dependencyId of slice.depends_on) {
    const historicalDependency = previous.slices.find((candidate) => candidate.slice_id === dependencyId);
    if (historicalDependency === undefined) throw new VNextHandoffError('manifest-binding', `historical previous_snapshot does not declare dependency Slice ${dependencyId}`);
    const receipts = readReceiptChain(root, integrationReceiptDir(root, previous.stage_id, dependencyId), `historical dependency ${dependencyId} Integration`);
    const candidates: VNextDependencyBinding[] = [];
    for (const receipt of receipts.receipts) {
      if (receipt.type !== 'INTEGRATION_PASS' || receipt.stage_id !== previous.stage_id || receipt.slice_id !== dependencyId) continue;
      const payload = requirePayload(receipt, `historical dependency ${dependencyId} Integration`);
      const candidateIsInvalidated = isHistoricalDependencyCandidateInvalidated(root, previous, historicalDependency, payload);
      const candidateAuthorities = loadAncestorReplanDispositionRecords(root, previous.stage_id).flatMap((record) => {
        const fact = record.dispositionFact;
        const matches = (value: { readonly stage_id: string; readonly manifest_digest: string; readonly plan_digest: string; readonly snapshot_digest: string }): boolean =>
          value.stage_id === payload.stage_id && value.manifest_digest === payload.manifest_digest && value.plan_digest === payload.plan_digest && value.snapshot_digest === payload.snapshot_digest;
        return matches(fact.snapshot) || matches(fact.previous_snapshot) ? [matches(fact.snapshot) ? fact.snapshot : fact.previous_snapshot] : [];
      }).filter((authority, index, all) => all.findIndex((other) => other.stage_id === authority.stage_id && other.manifest_digest === authority.manifest_digest && other.plan_digest === authority.plan_digest && other.snapshot_digest === authority.snapshot_digest) === index);
      if (candidateAuthorities.length > 1) throw new VNextHandoffError('manifest-binding', `historical dependency ${dependencyId} candidate has multiple exact persisted generation authorities`);
      const candidateManifest = candidateAuthorities.length === 1
        ? buildVNextHistoricalManifest(historicalManifest, candidateAuthorities[0])
        : historicalManifest;
      const validatedPayload = validateIntegrationCredential(root, receipt, previous.stage_id, dependencyId, new Set(), candidateManifest, currentSnapshotDigest, previous.snapshot_digest);
      if (candidateIsInvalidated) continue;
      if (validatedPayload.schema_version !== 3 || validatedPayload.proof_index_digest !== computeDigest(historicalDependency.proof_index) || validatedPayload.stage_contract_digest !== previous.stage_contract_digest || validatedPayload.slice_contract_digest !== historicalDependency.slice_contract_digest) {
        throw new VNextHandoffError('manifest-binding', `historical dependency ${dependencyId} candidate is foreign or not contract/proof-stable as of the old finalize`);
      }
      const commit = validatedPayload.commit_sha;
      if (typeof commit !== 'string' || !GIT_SHA_RE.test(commit)) throw new VNextHandoffError('manifest-binding', `historical dependency ${dependencyId} candidate commit is malformed`);
      const binding: VNextDependencyBinding = { slice_id: dependencyId, slice_contract_digest: validatedPayload.slice_contract_digest as string, integration_receipt_digest: receipt.digest, integration_head_sha: commit };
      try { validateDependencyBinding(binding); } catch (error) { throw new VNextHandoffError('manifest-binding', `historical dependency ${dependencyId} candidate binding is malformed: ${error instanceof Error ? error.message : String(error)}`); }
      candidates.push(binding);
    }
    if (candidates.length === 0) throw new VNextHandoffError('manifest-binding', `historical dependency ${dependencyId} has no complete ancestor-bound Integration credential`);
    candidateSets.push(candidates);
  }
  const matches: VNextDependencyBinding[][] = [];
  const visit = (index: number, selected: VNextDependencyBinding[]): void => {
    if (matches.length > 1) return;
    if (index === candidateSets.length) {
      const digest = computeExecutionBindingDigest({ stage_id: previous.stage_id, slice_id: sliceId, stage_contract_digest: previous.stage_contract_digest, slice_contract_digest: slice.slice_contract_digest, dependency_bindings: selected, base_snapshot_digest: previous.snapshot_digest });
      if (digest === expectedExecutionBindingDigest) matches.push([...selected]);
      return;
    }
    for (const candidate of candidateSets[index]) visit(index + 1, [...selected, candidate]);
  };
  visit(0, []);
  if (matches.length !== 1) throw new VNextHandoffError('manifest-binding', `historical dependency binding selection has ${matches.length} execution_binding_digest matches; exactly one is required`);
  return matches[0];
}

function assertHistoricalContextBinding(
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
  mode: 'implement-task' | 'recover-task' | 'finalize-slice',
): Record<string, unknown> {
  if (contextRef !== `.proofloop/context/${contextDigest}.json`) throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE context_ref is not digest-addressed');
  const context = readRootBoundRecord(root, contextRef, 'TASK_COMPLETE Context');
  if (context.schema_version !== 2 || context.context_digest !== contextDigest) throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Context discriminator or digest is invalid');
  const withoutDigest = { ...context };
  delete withoutDigest.context_digest;
  if (computeDigest(withoutDigest) !== contextDigest) throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Context content does not match context_digest');
  if (context.mode !== mode) throw new VNextHandoffError('manifest-binding', `TASK_COMPLETE Context mode binding does not match ${mode}`);
  if (context.root_path !== root || context.root_digest !== computeDigest(root) || context.stage_id !== manifest.stage_id || context.slice_id !== slice.slice_id || context.task_id !== taskId || context.task_ref !== taskRef || context.manifest_digest !== manifestDigest || context.plan_digest !== planDigest || context.proof_index_digest !== proofIndexDigest || context.snapshot_digest !== snapshotDigest) {
    throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Context is not bound to the historical vNext execution tuple');
  }
  if (context.evidence_path !== slice.evidence_path || context.plan_projection_path !== manifest.plan.ref) throw new VNextHandoffError('manifest-binding', 'TASK_COMPLETE Context artifact paths do not match the historical Manifest');
  if (taskScope !== undefined && computeDigest(context.execution_scope) !== computeDigest(taskScope)) throw new VNextHandoffError('execution-scope-gap', 'TASK_COMPLETE Context scope does not match the historical Manifest task scope');
  return context;
}

/** Validate a historical taskless finalize before it is skipped or carried. */
export function validateVNextHistoricalFinalizeReceipt(
  root: string,
  manifest: VNextManifest,
  slice: VNextManifestSlice,
  payload: Record<string, unknown>,
  dispositionFact: ReplanDispositionFact,
  currentSnapshotDigest: string,
  historicalReceiptDigest?: string,
 ): void {
  const previous = dispositionFact.previous_snapshot;
  const historicalSlice = previous.slices.find((candidate) => candidate.slice_id === slice.slice_id);
  if (historicalSlice === undefined) throw new VNextHandoffError('manifest-binding', `disposition previous_snapshot does not declare Slice ${slice.slice_id}`);
  const schemaVersion = payload.schema_version;
  if ((manifest.binding !== undefined && schemaVersion !== 3) || (manifest.binding === undefined && schemaVersion !== 2)) {
    throw new VNextHandoffError('admission-invalid', 'historical finalize credential schema_version does not match the active Stage credential mode');
  }
  const payloadManifestDigest = factDigest(payload.manifest_digest, 'TASK_COMPLETE.manifest_digest', 64);
  const payloadPlanDigest = factDigest(payload.plan_digest, 'TASK_COMPLETE.plan_digest', 64);
  const payloadSnapshotDigest = factDigest(payload.snapshot_digest, 'TASK_COMPLETE.snapshot_digest', 40);
  if (!exactPreviousTuple(dispositionFact, manifest.stage_id, payloadManifestDigest, payloadPlanDigest, payloadSnapshotDigest)) throw new VNextHandoffError('manifest-binding', 'historical finalize tuple is not bound to its persisted disposition previous_snapshot');
  if (payload.mode !== 'finalize-slice' || payload.outcome !== 'completed' || Object.prototype.hasOwnProperty.call(payload, 'task_id')) throw new VNextHandoffError('task-anchor-gap', 'finalize-slice TASK_COMPLETE payload must be completed and taskless');
  factString(payload.action_token, 'TASK_COMPLETE.action_token');
  const historicalProofIndexDigest = computeDigest(historicalSlice.proof_index);
  if (factDigest(payload.proof_index_digest, 'TASK_COMPLETE.proof_index_digest', 64) !== historicalProofIndexDigest) throw new VNextHandoffError('manifest-binding', 'historical finalize proof_index_digest does not match its persisted previous_snapshot');
  const generationSnapshotDigest = factDigest(dispositionFact.snapshot.snapshot_digest, 'persisted disposition snapshot_digest', 40);
  factDigest(currentSnapshotDigest, 'current admitted snapshot_digest', 40);
  assertCommitAncestor(root, previous.snapshot_digest, generationSnapshotDigest, 'historical finalize previous/generation snapshot');
  assertCommitAncestor(root, generationSnapshotDigest, currentSnapshotDigest, 'historical finalize generation/current admitted snapshot');
  assertOnCurrentHead(root, currentSnapshotDigest, 'current admitted snapshot');
  const historicalManifest = buildVNextHistoricalManifest(manifest, previous);
  const contextRef = factString(payload.context_ref, 'TASK_COMPLETE.context_ref');
  const contextDigest = factDigest(payload.context_digest, 'TASK_COMPLETE.context_digest', 64);
  const context = assertHistoricalContextBinding(
    root,
    historicalManifest,
    previous.manifest_digest,
    previous.plan_digest,
    previous.snapshot_digest,
    historicalSlice as unknown as VNextManifestSlice,
    undefined,
    undefined,
    undefined,
    historicalProofIndexDigest,
    contextRef,
    contextDigest,
    'finalize-slice',
  );
  if (payload.evidence_ref !== historicalSlice.evidence_path) throw new VNextHandoffError('manifest-binding', 'historical finalize evidence_ref is not bound to its persisted previous_snapshot Slice');
  let expectedExecutionBindingDigest: string | undefined;
  if (manifest.binding !== undefined) {
    expectedExecutionBindingDigest = factDigest(payload.execution_binding_digest, 'TASK_COMPLETE.execution_binding_digest', 64);
    const dependencies = historicalDependencyBindings(root, previous, slice.slice_id, expectedExecutionBindingDigest, historicalManifest, currentSnapshotDigest);
    assertSliceLocalCredentialBindingFields(
      payload,
      'TASK_COMPLETE.payload',
      {
        stageContractDigest: previous.stage_contract_digest,
        sliceContractDigest: historicalSlice.slice_contract_digest,
        executionBindingDigest: expectedExecutionBindingDigest,
      },
    );
    void dependencies;
  } else {
    assertSliceLocalCredentialBindingFields(payload, 'TASK_COMPLETE.payload');
  }
  assertUpstreamTaskCompleteSemantics(
    payload,
    historicalSlice.evidence_path,
    'TASK_COMPLETE.payload',
    {
      stageHasBinding: manifest.binding !== undefined,
      allowedScope: [historicalSlice.evidence_path, historicalManifest.plan.ref],
      ...(expectedExecutionBindingDigest === undefined ? {} : {
        expectedSliceLocalBinding: {
          stageContractDigest: previous.stage_contract_digest,
          sliceContractDigest: historicalSlice.slice_contract_digest,
          executionBindingDigest: expectedExecutionBindingDigest,
        },
      }),
      verifyContextPersisted: (ref, digest) => assertHistoricalContextPersisted(root, ref, digest, 'TASK_COMPLETE.payload'),
    },
  );
  if (historicalReceiptDigest !== undefined) {
    const historicalTuple: TupleBinding = {
      stageId: previous.stage_id,
      sliceId: slice.slice_id,
      manifestDigest: previous.manifest_digest,
      planDigest: previous.plan_digest,
      proofIndexDigest: historicalProofIndexDigest,
      snapshotDigest: previous.snapshot_digest,
    };
    const historicalSliceBinding = sliceBinding(root, historicalManifest, slice.slice_id);
    validateWorkerFacts(
      root,
      historicalManifest,
      historicalSliceBinding,
      historicalTuple,
      expectedExecutionBindingDigest === undefined ? undefined : {
        stageContractDigest: previous.stage_contract_digest,
        sliceContractDigest: historicalSlice.slice_contract_digest,
        executionBindingDigest: expectedExecutionBindingDigest,
      },
      historicalReceiptDigest,
    );
  }
  const expectedProofIndex = {
    goal_ref: historicalSlice.proof_index.goal_ref,
    task_refs: [...historicalSlice.proof_index.task_refs],
    acceptance_refs: [...historicalSlice.proof_index.acceptance_refs],
    seam_refs: [...historicalSlice.proof_index.seam_refs],
    oracle_refs: [...historicalSlice.proof_index.oracle_refs],
    risk_refs: historicalSlice.proof_index.risk_refs.map((risk) => risk.ref_id),
  };
  if (!isRecord(context.proof_index) || computeDigest(context.proof_index) !== computeDigest(expectedProofIndex)) throw new VNextHandoffError('manifest-binding', 'historical finalize Context Proof Index does not match its persisted previous_snapshot Slice');
  const contextScope = context.scope;
  if (!isRecord(contextScope)) throw new VNextHandoffError('execution-scope-gap', 'historical finalize Context.scope must be an object');
  const allowedPaths = unique(factStringArray(contextScope.allowed_paths, 'TASK_COMPLETE Context.scope.allowed_paths').map((value, index) => rootRelativeFactPath(root, value, `TASK_COMPLETE Context.scope.allowed_paths[${index}]`)));
  const expectedAllowedPaths = [historicalSlice.evidence_path, historicalManifest.plan.ref].map((value, index) => rootRelativeFactPath(root, value, `historical finalize Context allowed path ${index}`));
  if (computeDigest(allowedPaths) !== computeDigest(expectedAllowedPaths)) throw new VNextHandoffError('execution-scope-gap', 'historical finalize Context allowed_paths are broader than its evidence/plan scope');
  if (allowedPaths.some((allowed) => HISTORICAL_FINALIZE_PROTECTED_PATHS.some((protectedPath) => pathsOverlap(allowed, protectedPath)))) throw new VNextHandoffError('execution-scope-gap', 'historical finalize Context allowed_paths overlap protected system paths');
  const mutableProjectionPaths = factStringArray(contextScope.mutable_projection_paths, 'TASK_COMPLETE Context.scope.mutable_projection_paths').map((value, index) => rootRelativeFactPath(root, value, `TASK_COMPLETE Context.scope.mutable_projection_paths[${index}]`));
  if (mutableProjectionPaths.length !== 1 || mutableProjectionPaths[0] !== historicalManifest.plan.ref) throw new VNextHandoffError('execution-scope-gap', 'historical finalize Context mutable projection is not the persisted plan projection');
  const forbiddenPaths = factStringArray(contextScope.forbidden_paths, 'TASK_COMPLETE Context.scope.forbidden_paths').map((value, index) => rootRelativeFactPath(root, value, `TASK_COMPLETE Context.scope.forbidden_paths[${index}]`));
  if (allowedPaths.some((allowed) => forbiddenPaths.some((forbiddenPath) => pathsOverlap(allowed, forbiddenPath)))) throw new VNextHandoffError('execution-scope-gap', 'historical finalize Context allowed_paths overlap forbidden paths');
  const executionScope = context.execution_scope;
  if (!isRecord(executionScope) || executionScope.kind !== 'evidence-only' || factStringArray(executionScope.code_paths, 'TASK_COMPLETE Context.execution_scope.code_paths').length !== 0 || factStringArray(executionScope.test_paths, 'TASK_COMPLETE Context.execution_scope.test_paths').length !== 0) throw new VNextHandoffError('execution-scope-gap', 'historical finalize Context must bind an evidence-only execution scope');
  const changedFiles = unique(factStringArray(payload.changed_files, 'TASK_COMPLETE.changed_files').map((value, index) => rootRelativeFactPath(root, value, `TASK_COMPLETE.changed_files[${index}]`)));
  if (changedFiles.length === 0) throw new VNextHandoffError('execution-scope-gap', 'TASK_COMPLETE.changed_files cannot be empty');
  const requiredPaths = [historicalSlice.evidence_path, historicalManifest.plan.ref].map((value, index) => rootRelativeFactPath(root, value, `historical finalize projection path ${index}`));
  for (const requiredPath of requiredPaths) {
    if (!changedFiles.includes(requiredPath)) throw new VNextHandoffError('execution-scope-gap', `historical finalize changed_files must include ${requiredPath}`);
  }
  for (const changed of changedFiles) {
    if (HISTORICAL_FINALIZE_PROTECTED_PATHS.some((protectedPath) => pathsOverlap(changed, protectedPath)) || forbiddenPaths.some((forbiddenPath) => pathsOverlap(changed, forbiddenPath)) || !allowedPaths.some((allowed) => pathWithin(changed, allowed))) throw new VNextHandoffError('execution-scope-gap', `historical finalize changed_files expands beyond its persisted Context scope: ${changed}`);
  }
  // The historical generation must flow into the currently admitted snapshot, which must itself be reachable from the real HEAD.
  const currentSnapshot = factDigest(currentSnapshotDigest, 'current admitted snapshot', 40);
  assertCommitAncestor(root, previous.snapshot_digest, currentSnapshot, 'historical finalize previous snapshot -> current admitted snapshot');
  assertOnCurrentHead(root, currentSnapshot, 'current admitted snapshot');
}

/** Validate one historical INTEGRATION_PASS with the same full chain validators used by admission. */
export function validateVNextHistoricalIntegrationReceipt(
  root: string,
  receipt: Receipt,
  historicalManifest: VNextManifest,
  sliceId: string,
  asOfSnapshotDigest: string,
  historicalGenerationSnapshotDigest?: string,
 ): Record<string, unknown> {
  const payload = requirePayload(receipt, `historical INTEGRATION_PASS ${historicalManifest.stage_id}/${sliceId}/${receipt.digest}`);
  const snapshotDigest = factDigest(payload.snapshot_digest, 'historical INTEGRATION_PASS.snapshot_digest', 40);
  return validateIntegrationCredential(
    root,
    receipt,
    historicalManifest.stage_id,
    sliceId,
    new Set<string>(),
    historicalManifest,
    asOfSnapshotDigest,
    historicalGenerationSnapshotDigest ?? snapshotDigest,
  );
}

/** Backward-compatible name retained for existing vNext consumers. */
export const validateVNextInvalidatedFinalizeReceipt = validateVNextHistoricalFinalizeReceipt;
