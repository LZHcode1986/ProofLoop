/**
 * vNext Runtime worker-dispatch projection (S04-A-T01).
 *
 * This module is deliberately separate from Reconcile / NextActionService.  It
 * consumes only a kernel-validated v2 Manifest and explicit v2 admission
 * authority; it never reads or interprets tasks.md or Evidence bodies.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeDigest, validateVNextManifest } from '@proofloop/kernel';
import type {
  VNextExecutionScope,
  VNextManifest,
  VNextSpvPassReceipt,
  VNextStagePlanReceipt,
} from '@proofloop/kernel';
import {
  validateVNextSpvPassReceipt,
  validateVNextStagePlanReceipt,
} from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import { resolveVNextReference } from './entity-resolver';
import { VNEXT_WORKER_COMPLETION_MODES } from './types';
import type {
  ProjectVNextWorkerDispatchInput,
  VNextAdmissionAuthority,
  VNextWorkerCompletionMode,
  VNextWorkerContext,
  VNextWorkerDispatch,
} from './types';

export type {
  ProjectVNextWorkerDispatchInput,
  VNextAdmissionAuthority,
  VNextWorkerContext,
  VNextWorkerDispatch,
  VNextWorkerScope,
} from './types';

/** Structured fail-closed error; no v1 fallback is represented by this type. */
export class VNextHandoffError extends Error {
  public readonly code:
    | 'v1-input'
    | 'manifest-invalid'
    | 'manifest-binding'
    | 'admission-missing'
    | 'admission-invalid'
    | 'task-anchor-gap'
    | 'execution-scope-gap'
    | 'path-escape'
    | 'reference-digest-mismatch'
    | 'snapshot-binding';

  constructor(code: VNextHandoffError['code'], message: string) {
    super(message);
    this.name = 'VNextHandoffError';
    this.code = code;
  }
}

function fail(code: VNextHandoffError['code'], message: string): never {
  throw new VNextHandoffError(code, message);
}

function descriptorPath(ref: string): string {
  const hash = ref.indexOf('#');
  return hash === -1 ? ref : ref.slice(0, hash);
}

function entityId(ref: string): string | undefined {
  const match = /#\/entities\/([^/]+)$/.exec(ref);
  return match?.[1];
}

/**
 * Select the explicitly requested Slice, or the first Slice that is provably
 * ready for dispatch.
 *
 * vNext has no persisted post-dispatch completion/state projection for
 * proving that a non-empty `depends_on` list is complete, so the dispatch
 * seam itself only treats an empty dependency list as ready. The execution
 * next consumer supplies `provenCompleteSlices` (Slices closed by an
 * admitted vNext SLICE_COMMIT fact) when it has read persisted execution
 * facts; a Slice whose declared dependencies are all in that set is then
 * provably dependency-ready and dispatchable. Without that execution fact a
 * non-empty `depends_on` list stays fail-closed. Manifest order remains the
 * deterministic tie breaker when more than one Slice is ready.
 */
function selectDependencyReadySlice(
  manifest: VNextManifest,
  requestedSliceId?: string,
  provenCompleteSlices?: ReadonlySet<string>,
): VNextManifest['slices'][number] {
  const dependencyReady = (candidate: VNextManifest['slices'][number]): boolean =>
    candidate.depends_on.length === 0 ||
    (provenCompleteSlices !== undefined &&
      candidate.depends_on.every((dependency) => provenCompleteSlices.has(dependency)));
  const slice = requestedSliceId === undefined
    ? manifest.slices.find((candidate) => dependencyReady(candidate))
    : manifest.slices.find(
        (candidate) => candidate.slice_id === requestedSliceId && dependencyReady(candidate),
      );
  if (slice === undefined) {
    fail(
      'task-anchor-gap',
      requestedSliceId === undefined
        ? 'vNext dispatch has no dependency-ready declared Slice; dependency completion state is unavailable'
        : `vNext dispatch Slice "${requestedSliceId}" is not declared dependency-ready`,
    );
  }
  return slice;
}

function assertRootPath(root: string, relative: string, label: string): string {
  if (
    typeof relative !== 'string' ||
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative.startsWith('//') ||
    /^[A-Za-z]:(?:\/|$)/.test(relative)
  ) fail('path-escape', `${label} must be a non-empty root-relative path`);
  if (relative.includes('\\') || relative.includes('\u0000')) fail('path-escape', `${label} contains an invalid path character`);
  const parts = relative.split("/");
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) fail('path-escape', `${label} is not a canonical root-relative path`);
  const canonicalRoot = canonicalPathWithinRoot(root, root);
  if (canonicalRoot === null) fail('path-escape', 'root cannot be canonicalized');
  const lexical = path.resolve(canonicalRoot, ...parts);
  const canonical = canonicalPathWithinRoot(canonicalRoot, lexical);
  if (canonical === null) fail('path-escape', `${label} escapes the project root`);
  if (canonical !== lexical) fail('path-escape', `${label} traverses a symlink or changed identity`);
  return parts.join("/");
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function cloneExecutionScope(scope: VNextExecutionScope): VNextExecutionScope {
  return {
    kind: scope.kind,
    code_paths: [...scope.code_paths],
    test_paths: [...scope.test_paths],
    forbidden_paths: [...scope.forbidden_paths],
  };
}

export function assertVNextManifestReferenceBindings(root: string, manifest: VNextManifest): void {
  assertRootPath(root, manifest.plan.ref, "Manifest plan ref");
  for (const [refId, descriptor] of Object.entries(manifest.reference_index)) {
    try {
      const resolved = resolveVNextReference({ root, ref: descriptor.ref, expectedKind: descriptor.kind });
      if (resolved.ref !== descriptor.ref) fail("reference-digest-mismatch", "Reference " + refId + " is not bound to its canonical entity ref");
      if (resolved.fileDigest !== descriptor.file_digest) fail("reference-digest-mismatch", "Reference " + refId + " file_digest does not match the root bound source");
      if (resolved.sectionDigest !== descriptor.section_digest) fail("reference-digest-mismatch", "Reference " + refId + " section_digest does not match the root bound entity");
    } catch (error) {
      if (error instanceof VNextHandoffError) throw error;
      fail("reference-digest-mismatch", "Reference " + refId + " could not be re-resolved: " + (error instanceof Error ? error.message : String(error)));
    }
  }
}

/**
 * Self-verification of a generated current Task Context (S08-C-T02).
 *
 * The Context is a Runtime-derived projection; a consumer must be able to
 * re-verify every binding from the Context's own content without trusting
 * strings, and the projection must fail closed if the source Plan/Manifest
 * drifts. This seam re-derives every binding from the admitted Manifest and
 * the root-bound entity sources:
 *
 *   - the Context content digest is self-consistent and root-bound;
 *   - task_ref resolves to a registered task entity whose id equals
 *     task_id, with the admitted file/section digests;
 *   - slice_goal_ref is the Slice Proof Index goal and resolves with the
 *     admitted digests;
 *   - proof_index_digest, proof_index refs, skills and artifact paths match
 *     the Manifest Slice;
 *   - execution_scope / allowed_code_scope / worker scope are the exact
 *     root-bound scope projected from the Manifest task scope (never
 *     invented by Brain/Worker/checkbox).
 *
 * @throws {VNextHandoffError} on every failed binding (fail closed).
 */
export function verifyVNextWorkerContextBindings(
  root: string,
  manifest: VNextManifest,
  context: VNextWorkerContext,
): void {
  // Content digest self-consistency.
  const withoutDigest = { ...context } as Record<string, unknown>;
  delete withoutDigest.context_digest;
  if (computeDigest(withoutDigest) !== context.context_digest) {
    fail('manifest-binding', 'Context content does not match its context_digest');
  }
  // Root binding.
  if (computeDigest(root) !== context.root_digest) {
    fail('manifest-binding', 'Context root_digest does not match the project root');
  }
  // Manifest / Plan / snapshot binding.
  if (computeDigest(manifest) !== context.manifest_digest) {
    fail('manifest-binding', 'Context manifest_digest does not match the admitted v2 Manifest');
  }
  if (manifest.plan.plan_digest !== context.plan_digest) {
    fail('manifest-binding', 'Context plan_digest does not match the admitted Manifest Plan');
  }
  if (typeof context.snapshot_digest !== 'string' || !/^[a-f0-9]{40}$/.test(context.snapshot_digest)) {
    fail('snapshot-binding', 'Context snapshot_digest must be a canonical Git HEAD digest');
  }
  // Task entity resolution: the projected task_ref must be a registered task
  // reference whose root-bound entity id equals the projected task_id.
  const taskDescriptor = Object.values(manifest.reference_index).find(
    (descriptor) => descriptor.kind === 'task' && descriptor.ref === context.task_ref,
  );
  if (taskDescriptor === undefined) {
    fail('task-anchor-gap', `Context task_ref "${context.task_ref}" is not a registered task reference`);
  }
  let resolvedTask;
  try {
    resolvedTask = resolveVNextReference({ root, ref: context.task_ref, expectedKind: 'task' });
  } catch (error) {
    if (error instanceof VNextHandoffError) throw error;
    fail('reference-digest-mismatch', `Context task_ref could not be re-resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (resolvedTask.entityId !== context.task_id) {
    fail('task-anchor-gap', `Context task_ref entity "${resolvedTask.entityId}" does not match task_id "${context.task_id}"`);
  }
  if (resolvedTask.fileDigest !== taskDescriptor.file_digest || resolvedTask.sectionDigest !== taskDescriptor.section_digest) {
    fail('reference-digest-mismatch', 'Context task_ref digests do not match the admitted Manifest binding');
  }
  // Slice / goal entity resolution.
  const slice = manifest.slices.find((candidate) => candidate.slice_id === context.slice_id);
  if (slice === undefined) {
    fail('task-anchor-gap', `Context slice "${context.slice_id}" is not declared by the Manifest`);
  }
  if (slice.proof_index.goal_ref !== context.slice_goal_ref) {
    fail('task-anchor-gap', 'Context slice_goal_ref is not bound to the Slice Proof Index');
  }
  const goalDescriptor = manifest.reference_index[context.slice_goal_ref];
  if (goalDescriptor === undefined || goalDescriptor.kind !== 'goal') {
    fail('task-anchor-gap', `Context slice_goal_ref "${context.slice_goal_ref}" is not a registered goal reference`);
  }
  let resolvedGoal;
  try {
    resolvedGoal = resolveVNextReference({ root, ref: goalDescriptor.ref, expectedKind: 'goal' });
  } catch (error) {
    if (error instanceof VNextHandoffError) throw error;
    fail('reference-digest-mismatch', `Context slice_goal_ref could not be re-resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (resolvedGoal.fileDigest !== goalDescriptor.file_digest || resolvedGoal.sectionDigest !== goalDescriptor.section_digest) {
    fail('reference-digest-mismatch', 'Context slice_goal_ref digests do not match the admitted Manifest binding');
  }
  // Proof Index digest and refs, skills, artifact paths.
  if (computeDigest(slice.proof_index) !== context.proof_index_digest) {
    fail('reference-digest-mismatch', 'Context proof_index_digest does not match the Manifest Slice');
  }
  const expectedProofIndex = {
    goal_ref: slice.proof_index.goal_ref,
    task_refs: [...slice.proof_index.task_refs],
    acceptance_refs: [...slice.proof_index.acceptance_refs],
    seam_refs: [...slice.proof_index.seam_refs],
    oracle_refs: [...slice.proof_index.oracle_refs],
    risk_refs: slice.proof_index.risk_refs.map((risk) => risk.ref_id),
  };
  if (JSON.stringify(context.proof_index) !== JSON.stringify(expectedProofIndex)) {
    fail('reference-digest-mismatch', 'Context Proof Index does not match the Manifest Slice');
  }
  if (JSON.stringify(context.required_skills) !== JSON.stringify([...slice.required_skills])) {
    fail('manifest-binding', 'Context required_skills do not match the Manifest Slice');
  }
  const evidencePath = assertRootPath(root, context.evidence_path, 'Context evidence path');
  const planProjectionPath = assertRootPath(root, context.plan_projection_path, 'Context plan projection path');
  if (evidencePath !== slice.evidence_path) {
    fail('manifest-binding', 'Context evidence_path does not match the Manifest Slice');
  }
  if (planProjectionPath !== manifest.plan.ref) {
    fail('manifest-binding', 'Context plan_projection_path does not match Manifest.plan.ref');
  }
  // Execution scope / allowed code scope / worker scope must be the exact
  // root-bound projection of the admitted Manifest task scope.
  const taskScopeBinding = manifest.task_scopes[context.task_id];
  if (taskScopeBinding === undefined || taskScopeBinding.task_ref !== context.task_ref) {
    fail('execution-scope-gap', 'Context task_id is not bound to an admitted Manifest task scope');
  }
  const executionScope = taskScopeBinding.execution_scope;
  if (executionScope.kind !== 'implementation') {
    fail('execution-scope-gap', `Context task "${context.task_id}" has "${executionScope.kind}" scope and cannot be dispatched as implement-task`);
  }
  const codePaths = executionScope.code_paths.map((value) => assertRootPath(root, value, 'execution_scope.code_paths path'));
  const testPaths = executionScope.test_paths.map((value) => assertRootPath(root, value, 'execution_scope.test_paths path'));
  const declaredForbiddenPaths = executionScope.forbidden_paths.map((value) => assertRootPath(root, value, 'execution_scope.forbidden_paths path'));
  const systemForbiddenPaths = ['.proofloop/manifests', '.proofloop/receipts', '.proofloop/context', '.git']
    .map((value) => assertRootPath(root, value, 'system forbidden scope path'));
  const forbiddenPaths = uniquePaths([...declaredForbiddenPaths, ...systemForbiddenPaths]);
  const allowedCodeScope = uniquePaths([...codePaths, ...testPaths]);
  const allowedPaths = uniquePaths([...allowedCodeScope, evidencePath, planProjectionPath]);
  if (JSON.stringify(context.execution_scope) !== JSON.stringify({
    kind: executionScope.kind,
    code_paths: codePaths,
    test_paths: testPaths,
    forbidden_paths: declaredForbiddenPaths,
  })) {
    fail('execution-scope-gap', 'Context execution_scope does not match the Manifest task scope');
  }
  if (JSON.stringify(context.allowed_code_scope) !== JSON.stringify(allowedCodeScope)) {
    fail('execution-scope-gap', 'Context allowed_code_scope is not the exact code/test scope');
  }
  if (JSON.stringify(context.scope.allowed_paths) !== JSON.stringify(allowedPaths)) {
    fail('execution-scope-gap', 'Context scope.allowed_paths is not the exact admitted scope');
  }
  if (JSON.stringify(context.scope.mutable_projection_paths) !== JSON.stringify([planProjectionPath])) {
    fail('execution-scope-gap', 'Context scope.mutable_projection_paths is not exactly the Plan projection');
  }
  if (JSON.stringify(context.scope.forbidden_paths) !== JSON.stringify(forbiddenPaths)) {
    fail('execution-scope-gap', 'Context scope.forbidden_paths does not match the Manifest scope');
  }
}

function assertAuthority(
  authority: VNextAdmissionAuthority | undefined,
  stageId: string,
  manifestDigest: string,
  planDigest: string,
  snapshotDigest: string,
): asserts authority is VNextAdmissionAuthority {
  if (authority === undefined) {
    fail('admission-missing', 'Stage Plan admission authority and fresh SPV authority are required');
  }
  let stagePlan: VNextStagePlanReceipt;
  let spv: VNextSpvPassReceipt;
  try {
    stagePlan = validateVNextStagePlanReceipt(authority.stagePlan);
    spv = validateVNextSpvPassReceipt(authority.spv);
  } catch (error) {
    fail('admission-invalid', `vNext admission authority is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const matches = (fact: { stage_id: string; manifest_digest: string; plan_digest: string; snapshot_digest: string }) =>
    fact.stage_id === stageId && fact.manifest_digest === manifestDigest &&
    fact.plan_digest === planDigest && fact.snapshot_digest === snapshotDigest;
  if (!matches(stagePlan) || !matches(spv) || stagePlan.spv_receipt_digest !== spv.digest) {
    fail('admission-invalid', 'Stage Plan admission, fresh SPV, Manifest, Plan, and snapshot digests do not bind');
  }
}

/**
 * Project one Worker dispatch from admitted v2 facts.  This pure seam does not
 * write a Context artifact; callers may persist the returned context by digest.
 */
export function projectVNextWorkerDispatch(
  input: ProjectVNextWorkerDispatchInput,
): VNextWorkerDispatch {
  let manifest: VNextManifest;
  try {
    manifest = validateVNextManifest(input.manifest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(input.manifest && typeof input.manifest === 'object' && (input.manifest as Record<string, unknown>).version === 1
      ? 'v1-input'
      : 'manifest-invalid', `vNext Manifest rejected; v1 input is never a fallback: ${message}`);
  }
  if (manifest.version !== 2 || manifest.plan.schema_version !== 2) {
    fail('v1-input', 'Only explicit version: 2 / schema_version: 2 is accepted');
  }
  if (typeof input.root !== 'string' || input.root.length === 0) fail('path-escape', 'root is required');
  const actualManifestDigest = computeDigest(manifest);
  if (input.manifestDigest !== actualManifestDigest) {
    fail('manifest-binding', 'manifest_digest does not match the admitted v2 Manifest');
  }
  const dispatchMode: VNextWorkerCompletionMode = input.mode ?? 'implement-task';
  if (!(VNEXT_WORKER_COMPLETION_MODES as readonly string[]).includes(dispatchMode)) {
    fail(
      'manifest-binding',
      `Worker dispatch mode "${dispatchMode}" is outside the closed completion vocabulary ` +
      `(${VNEXT_WORKER_COMPLETION_MODES.join(', ')})`,
    );
  }

  // Preserve the admitted single-Slice pilot contract when no explicit Slice
  // was selected. The execution-state consumer supplies `sliceId` after
  // reading persisted facts, and the temporary multi-Slice path still uses
  // only the dependency-ready selection above.
  let slice: VNextManifest['slices'][number];
  if (manifest.slices.length === 1) {
    const singleSlice = manifest.slices[0];
    if (input.sliceId !== undefined && input.sliceId !== singleSlice.slice_id) {
      fail('task-anchor-gap', `vNext dispatch Slice "${input.sliceId}" is not declared by the Manifest`);
    }
    // Preserve the admitted single-Slice pilot boundary: its external stage
    // dependency is not a locally available execution fact.
    slice = singleSlice;
  } else {
    slice = selectDependencyReadySlice(manifest, input.sliceId, input.provenCompleteSlices);
  }
  if (!slice.slice_id.startsWith(`${manifest.stage_id}-`)) {
    fail('task-anchor-gap', 'Slice id is not bound to the Manifest stage');
  }
  const completedTaskIds = new Set(input.completedTaskIds ?? []);
  const taskRefId = slice.proof_index.task_refs.find((refId) => {
    const descriptor = manifest.reference_index[refId];
    const id = descriptor === undefined ? undefined : entityId(descriptor.ref);
    return id === undefined || !completedTaskIds.has(id);
  });
  if (taskRefId === undefined) fail('task-anchor-gap', 'Task anchor is not available from the verified Proof Index');
  const taskDescriptor = manifest.reference_index[taskRefId];
  const taskId = taskDescriptor === undefined ? undefined : entityId(taskDescriptor.ref);
  if (taskDescriptor?.kind !== 'task' || taskId === undefined) {
    fail('task-anchor-gap', 'Task anchor is not available from the verified Proof Index');
  }
  if (!taskId.startsWith(`${slice.slice_id}-`)) {
    fail('task-anchor-gap', 'Task anchor is not bound to the declared Slice');
  }
  const sliceGoal = manifest.reference_index[slice.proof_index.goal_ref];
  if (sliceGoal?.kind !== 'goal') fail('task-anchor-gap', 'Slice Goal ref is not available from the verified Proof Index');

  const planProjectionPath = assertRootPath(input.root, manifest.plan.ref, 'Manifest plan ref');
  const evidencePath = assertRootPath(input.root, slice.evidence_path, 'declared Evidence path');
  for (const descriptor of Object.values(manifest.reference_index)) {
    assertRootPath(input.root, descriptorPath(descriptor.ref), 'Proof Index ref');
  }
  if (typeof input.snapshotDigest !== 'string' || !/^[a-f0-9]{40}$/.test(input.snapshotDigest)) {
    fail('snapshot-binding', 'dispatch snapshot_digest must be a canonical Git HEAD digest');
  }
  assertAuthority(input.authority, manifest.stage_id, input.manifestDigest, manifest.plan.plan_digest, input.snapshotDigest);
  if (input.verifyReferenceBindings !== false) assertVNextManifestReferenceBindings(input.root, manifest);

  const taskScopeBinding = manifest.task_scopes[taskId];
  if (taskScopeBinding === undefined) {
    fail('execution-scope-gap', `Manifest has no execution scope for task "${taskId}"`);
  }
  if (taskScopeBinding.task_ref !== taskDescriptor.ref) {
    fail('execution-scope-gap', `Task scope for "${taskId}" is not bound to its admitted task ref`);
  }
  const executionScope = taskScopeBinding.execution_scope;
  if (executionScope.kind !== 'implementation') {
    fail('execution-scope-gap', `Task "${taskId}" has "${executionScope.kind}" scope and cannot be dispatched as implement-task`);
  }
  if (executionScope.code_paths.length === 0 || executionScope.test_paths.length === 0) {
    fail('execution-scope-gap', `Task "${taskId}" implementation scope requires non-empty code_paths and test_paths`);
  }

  const codePaths = executionScope.code_paths.map((value) =>
    assertRootPath(input.root, value, 'execution_scope.code_paths path'),
  );
  const testPaths = executionScope.test_paths.map((value) =>
    assertRootPath(input.root, value, 'execution_scope.test_paths path'),
  );
  const declaredForbiddenPaths = executionScope.forbidden_paths.map((value) =>
    assertRootPath(input.root, value, 'execution_scope.forbidden_paths path'),
  );
  const systemForbiddenPaths = ['.proofloop/manifests', '.proofloop/receipts', '.proofloop/context', '.git']
    .map((value) => assertRootPath(input.root, value, 'system forbidden scope path'));
  const forbiddenPaths = uniquePaths([
    ...declaredForbiddenPaths,
    ...systemForbiddenPaths,
    ...(input.forbiddenPaths ?? []).map((value) => assertRootPath(input.root, value, 'forbidden scope path')),
  ]);
  // `allowed_code_scope` is deliberately limited to implementation paths.  The
  // Plan projection and Evidence are separate mutable/artifact permissions and
  // must never be smuggled into production code scope.
  const allowedCodeScope = uniquePaths([...codePaths, ...testPaths]);
  const mutableProjectionPaths = [planProjectionPath];
  const nonProjectionAllowedPaths = uniquePaths([...allowedCodeScope, evidencePath]);
  const scopeAllowedPaths = uniquePaths([
    ...nonProjectionAllowedPaths,
    ...mutableProjectionPaths,
  ]);
  const requestedAllowedPaths = (input.allowedPaths ?? []).map((value) =>
    assertRootPath(input.root, value, 'allowed scope path'),
  );
  for (const requested of requestedAllowedPaths) {
    const isMutableProjection = mutableProjectionPaths.includes(requested);
    const isCodeOrEvidencePath = nonProjectionAllowedPaths.some(
      (base) => requested === base || requested.startsWith(`${base}/`),
    );
    if (!isMutableProjection && !isCodeOrEvidencePath) {
      fail('execution-scope-gap', `caller allowed path "${requested}" expands the admitted execution scope`);
    }
  }
  const allowedPaths = uniquePaths([...scopeAllowedPaths, ...requestedAllowedPaths]);
  for (const allowed of allowedPaths) {
    for (const forbidden of forbiddenPaths) {
      if (pathsOverlap(allowed, forbidden)) {
        fail('execution-scope-gap', `execution scope path "${allowed}" overlaps forbidden path "${forbidden}"`);
      }
    }
  }

  const proofIndexDigest = computeDigest(slice.proof_index);
  const rootDigest = computeDigest(input.root);
  const contextWithoutDigest = {
    schema_version: 2 as const,
    root_path: input.root,
    root_digest: rootDigest,
    stage_id: manifest.stage_id,
    slice_id: slice.slice_id,
    task_id: taskId,
    task_ref: taskDescriptor.ref,
    slice_goal_ref: slice.proof_index.goal_ref,
    mode: dispatchMode,
    proof_index: {
      goal_ref: slice.proof_index.goal_ref,
      task_refs: [...slice.proof_index.task_refs],
      acceptance_refs: [...slice.proof_index.acceptance_refs],
      seam_refs: [...slice.proof_index.seam_refs],
      oracle_refs: [...slice.proof_index.oracle_refs],
      risk_refs: slice.proof_index.risk_refs.map((risk) => risk.ref_id),
    },
    required_skills: [...slice.required_skills],
    evidence_path: evidencePath,
    plan_projection_path: planProjectionPath,
    manifest_digest: input.manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    proof_index_digest: proofIndexDigest,
    snapshot_digest: input.snapshotDigest,
    allowed_code_scope: allowedCodeScope,
    execution_scope: cloneExecutionScope(executionScope),
    scope: {
      allowed_paths: allowedPaths,
      mutable_projection_paths: mutableProjectionPaths,
      forbidden_paths: forbiddenPaths,
    },
  };
  const contextDigest = computeDigest(contextWithoutDigest);
  const context = { ...contextWithoutDigest, context_digest: contextDigest } as VNextWorkerContext;
  return {
    action: 'DISPATCH_WORKER',
    responsible_role: 'worker',
    stage_id: manifest.stage_id,
    slice_id: slice.slice_id,
    task_id: taskId,
    mode: dispatchMode,
    context_ref: `.proofloop/context/${contextDigest}.json`,
    manifest_digest: input.manifestDigest,
    plan_digest: manifest.plan.plan_digest,
    proof_index_digest: proofIndexDigest,
    snapshot_digest: input.snapshotDigest,
    receipt_chain_valid: true,
    findings: [],
    context,
  };
}

/** Read-only v2 manifest source; unlike manifestSource this never invokes v1 validation. */
export function readVNextManifest(root: string, manifestPath: string): VNextManifest {
  const canonical = canonicalPathWithinRoot(root, manifestPath);
  if (canonical === null) fail('path-escape', 'vNext Manifest path escapes the project root');
  try {
    const opened = openNoFollowRead(root, canonical);
    if (!opened.ok) fail('manifest-invalid', 'vNext Manifest source is missing or not a regular root-bound file');
    let raw: string;
    try {
      raw = fs.readFileSync(opened.fd, 'utf-8');
    } finally {
      fs.closeSync(opened.fd);
    }
    return validateVNextManifest(JSON.parse(raw));
  } catch (error) {
    if (error instanceof VNextHandoffError) throw error;
    fail('manifest-invalid', `vNext Manifest source is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
