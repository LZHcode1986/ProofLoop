/**
 * S14-A-T01 — Runtime replan impact classifier.
 *
 * Mechanical before/after Manifest/Task contract + dependency closure
 * classification. The classifier derives every derived set itself
 * (changed/carry_forward/invalidated) — caller-supplied derived facts are
 * structurally impossible (HP-021 forbidden shortcut). See
 * tech-spec/ai-coding-architecture.md §10.10 and
 * tech-spec/contract-state-matrix.md §8.8.
 */
import { computeDigest } from '@proofloop/kernel';
import type { VNextExecutionScope } from '@proofloop/kernel';

export type ReplanImpactScope = 'task-local' | 'slice-wide' | 'unresolved';

export type ReplanExecutionScopeInput = VNextExecutionScope;

export interface ReplanProofIndexInput {
  readonly slice_id: string;
  readonly goal_ref: string;
  readonly task_refs: readonly string[];
  readonly acceptance_refs: readonly string[];
  readonly seam_refs: readonly string[];
  readonly oracle_refs: readonly string[];
  readonly risk_refs: readonly ReplanRiskBindingInput[];
}

export interface ReplanRiskBindingInput {
  readonly ref_id: string;
  readonly applies_to_acceptance_refs: readonly string[];
  readonly applies_to_seam_refs: readonly string[];
}

export interface ReplanTaskContractInput {
  readonly task_id: string;
  readonly slice_id: string;
  readonly goal: string;
  readonly refs: readonly string[];
  readonly dependencies: readonly string[];
  readonly required_skills: readonly string[];
  readonly execution_scope: ReplanExecutionScopeInput;
}

export interface ReplanSliceContractInput {
  readonly slice_id: string;
  /** Static Slice contract fingerprint bound from the compiled Manifest
   *  (§8.1 slice_contract_digest). */
  readonly slice_contract_digest: string;
  readonly depends_on: readonly string[];
  readonly required_skills: readonly string[];
  readonly evidence_path: string;
  readonly proof_index: ReplanProofIndexInput;
  /** Ordered Task ids bound by this slice (execution order). */
  readonly task_ids: readonly string[];
}

export interface ReplanReferenceDescriptorInput {
  readonly kind: string;
  readonly ref: string;
  readonly file_digest: string;
  readonly section_digest: string;
}

/**
 * Closed plan contract facts of ONE epoch side. Digests are opaque plan
 * facts (bound from the compiled Manifest); the classifier never accepts a
 * derived disposition set.
 */
export interface ReplanPlanSnapshotInput {
  readonly stage_id: string;
  readonly plan_digest: string;
  readonly manifest_digest: string;
  readonly stage_contract_digest: string;
  readonly snapshot_digest: string;
  readonly authority_ref_ids: readonly string[];
  readonly reference_index: Readonly<Record<string, ReplanReferenceDescriptorInput>>;
  readonly slices: readonly ReplanSliceContractInput[];
  readonly tasks: readonly ReplanTaskContractInput[];
}

export interface ClassifyReplanImpactInput {
  readonly previous: ReplanPlanSnapshotInput;
  readonly candidate: ReplanPlanSnapshotInput;
  readonly parent_epoch_digest: string;
  readonly completed_task_ids: readonly string[];
}

/** Closed unresolved reasons (REPLAN.IMPACT_UNRESOLVED fail-closed cases). */
export const REPLAN_IMPACT_UNRESOLVED_REASONS = [
  'STAGE_MISMATCH',
  'PARENT_EPOCH_MISSING',
  'PARENT_EPOCH_INVALID',
  'CLOSURE_UNPROVABLE',
] as const;
export type ReplanImpactUnresolvedReason = (typeof REPLAN_IMPACT_UNRESOLVED_REASONS)[number];

/** Disposition schema per contract §8.8 (schema_version 1). */
export interface ReplanImpactDisposition {
  readonly schema_version: 1;
  readonly stage_id: string;
  readonly parent_epoch_digest: string;
  readonly impact_scope: ReplanImpactScope;
  readonly changed_task_ids: readonly string[];
  readonly carry_forward_task_ids: readonly string[];
  readonly invalidated_task_ids: readonly string[];
  readonly previous_manifest_digest: string;
  readonly manifest_digest: string;
  readonly previous_plan_digest: string;
  readonly plan_digest: string;
  readonly snapshot_digest: string;
  /** Present only when impact_scope === 'unresolved'. */
  readonly unresolved_reason?: ReplanImpactUnresolvedReason;
}

/** Typed error for malformed plan contract facts (invalid input must never
 *  produce a disposition). */
export class ReplanImpactError extends Error {
  readonly code = 'REPLAN.IMPACT_INPUT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ReplanImpactError';
  }
}

// ============================================================
// Deterministic helpers (order-independent projections)
// ============================================================

function sortStrings(values: readonly string[]): string[] {
  return [...values].sort();
}

/** Canonical digest of one Task contract projection (§10.10): goal, refs,
 *  acceptance/proof refs via the Slice binding, dependencies,
 *  required_skills, execution_scope — every array sorted at projection
 *  construction time (order-independence invariant, §8.2). */
function taskContractDigest(task: ReplanTaskContractInput): string {
  const scope = task.execution_scope;
  return computeDigest({
    task_id: task.task_id,
    slice_id: task.slice_id,
    goal: task.goal,
    refs: sortStrings(task.refs),
    dependencies: sortStrings(task.dependencies),
    required_skills: sortStrings(task.required_skills),
    execution_scope: {
      kind: scope.kind,
      code_paths: sortStrings(scope.code_paths),
      test_paths: sortStrings(scope.test_paths),
      forbidden_paths: sortStrings(scope.forbidden_paths),
    },
  });
}

function assertRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReplanImpactError(`${name} must be an object`);
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_HEX_RE = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const EXECUTION_SCOPE_KINDS = new Set(['implementation', 'evidence-only']);

/** Canonical digest of one Slice proof index (the proof-boundary refs). */
function proofIndexDigest(proofIndex: ReplanProofIndexInput): string {
  return computeDigest({
    goal_ref: proofIndex.goal_ref,
    task_refs: sortStrings(proofIndex.task_refs),
    acceptance_refs: sortStrings(proofIndex.acceptance_refs),
    seam_refs: sortStrings(proofIndex.seam_refs),
    oracle_refs: sortStrings(proofIndex.oracle_refs),
    risk_refs: proofIndex.risk_refs
      .map((r) => ({
        ref_id: r.ref_id,
        applies_to_acceptance_refs: sortStrings(r.applies_to_acceptance_refs),
        applies_to_seam_refs: sortStrings(r.applies_to_seam_refs),
      }))
      .sort((a, b) => a.ref_id.localeCompare(b.ref_id)),
  });
}

/** Canonical digest of the Slice structural facts (depends_on,
 *  required_skills, evidence_path). */
function sliceStructuralDigest(slice: ReplanSliceContractInput): string {
  return computeDigest({
    depends_on: sortStrings(slice.depends_on),
    required_skills: sortStrings(slice.required_skills),
    evidence_path: slice.evidence_path,
  });
}

function assertStringArray(value: unknown, name: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ReplanImpactError(`${name} must be a string array`);
  }
}

function assertHexDigest(value: unknown, name: string, re: RegExp): asserts value is string {
  if (typeof value !== 'string' || !re.test(value)) {
    throw new ReplanImpactError(`${name} must be a ${re === SHA256_HEX_RE ? 'sha256 hex digest' : 'hex digest'}`);
  }
}

/** Structural validation of the whole input. Invalid facts can never be
 *  classified — they throw instead of producing a disposition. */
function validateInput(input: ClassifyReplanImpactInput): void {
  assertRecord(input, 'input');
  assertRecord(input.previous, 'input.previous');
  assertRecord(input.candidate, 'input.candidate');

  for (const [name, snap] of [
    ['input.previous', input.previous],
    ['input.candidate', input.candidate],
  ] as const) {
    if (typeof snap.stage_id !== 'string' || snap.stage_id.length === 0) {
      throw new ReplanImpactError(`${name}.stage_id must be a non-empty string`);
    }
    assertHexDigest(snap.plan_digest, `${name}.plan_digest`, SHA256_HEX_RE);
    assertHexDigest(snap.manifest_digest, `${name}.manifest_digest`, SHA256_HEX_RE);
    assertHexDigest(snap.stage_contract_digest, `${name}.stage_contract_digest`, SHA256_HEX_RE);
    assertHexDigest(snap.snapshot_digest, `${name}.snapshot_digest`, SNAPSHOT_HEX_RE);
    assertStringArray(snap.authority_ref_ids, `${name}.authority_ref_ids`);
    assertRecord(snap.reference_index, `${name}.reference_index`);

    if (!Array.isArray(snap.slices) || snap.slices.length === 0) {
      throw new ReplanImpactError(`${name}.slices must be a non-empty array`);
    }
    if (!Array.isArray(snap.tasks) || snap.tasks.length === 0) {
      throw new ReplanImpactError(`${name}.tasks must be a non-empty array`);
    }

    const sliceIds = new Set<string>();
    const taskIds = new Set<string>();
    const sliceTaskBindings: Array<readonly string[]> = [];

    for (const s of snap.slices) {
      assertRecord(s, `${name}.slices[]`);
      if (typeof s.slice_id !== 'string' || s.slice_id.length === 0) {
        throw new ReplanImpactError(`${name}.slices[].slice_id must be a non-empty string`);
      }
      if (sliceIds.has(s.slice_id)) throw new ReplanImpactError(`${name}.slices has duplicate slice_id ${s.slice_id}`);
      sliceIds.add(s.slice_id);
      assertHexDigest(s.slice_contract_digest, `${name}.slices[].slice_contract_digest`, SHA256_HEX_RE);
      assertStringArray(s.depends_on, `${name}.slices[].depends_on`);
      assertStringArray(s.required_skills, `${name}.slices[].required_skills`);
      if (typeof s.evidence_path !== 'string' || s.evidence_path.length === 0) {
        throw new ReplanImpactError(`${name}.slices[].evidence_path must be a non-empty string`);
      }
      assertRecord(s.proof_index, `${name}.slices[].proof_index`);
      const pi = s.proof_index;
      if (typeof pi.goal_ref !== 'string' || pi.goal_ref.length === 0) {
        throw new ReplanImpactError(`${name}.slices[].proof_index.goal_ref must be a non-empty string`);
      }
      assertStringArray(pi.task_refs, `${name}.slices[].proof_index.task_refs`);
      assertStringArray(pi.acceptance_refs, `${name}.slices[].proof_index.acceptance_refs`);
      assertStringArray(pi.seam_refs, `${name}.slices[].proof_index.seam_refs`);
      assertStringArray(pi.oracle_refs, `${name}.slices[].proof_index.oracle_refs`);
      if (!Array.isArray(pi.risk_refs)) throw new ReplanImpactError(`${name}.slices[].proof_index.risk_refs must be an array`);
      for (const r of pi.risk_refs) {
        assertRecord(r, `${name}.slices[].proof_index.risk_refs[]`);
        if (typeof r.ref_id !== 'string' || r.ref_id.length === 0) {
          throw new ReplanImpactError(`${name}.slices[].proof_index.risk_refs[].ref_id must be a non-empty string`);
        }
        assertStringArray(r.applies_to_acceptance_refs, `${name}.slices[].proof_index.risk_refs[].applies_to_acceptance_refs`);
        assertStringArray(r.applies_to_seam_refs, `${name}.slices[].proof_index.risk_refs[].applies_to_seam_refs`);
      }
      if (!Array.isArray(s.task_ids) || s.task_ids.length === 0 || s.task_ids.some((id) => typeof id !== 'string')) {
        throw new ReplanImpactError(`${name}.slices[].task_ids must be a non-empty string array`);
      }
    if (new Set(s.task_ids).size !== s.task_ids.length) {
      throw new ReplanImpactError(`${name}.slices[].task_ids contains duplicates`);
    }
    sliceTaskBindings.push(s.task_ids);
  }

  // depends_on targets must resolve among the slice ids of the SAME snapshot
  // (checked after the id collection pass so forward references are legal).
  for (const s of snap.slices) {
    for (const dep of s.depends_on) {
      if (!sliceIds.has(dep)) throw new ReplanImpactError(`${name}.slices[].depends_on references unknown slice ${dep}`);
    }
  }

    const sliceByTask = new Map<string, string>();
    for (let i = 0; i < snap.slices.length; i += 1) {
      for (const taskId of sliceTaskBindings[i]) {
        if (sliceByTask.has(taskId)) {
          throw new ReplanImpactError(`${name}: task ${taskId} is bound by more than one slice`);
        }
        sliceByTask.set(taskId, snap.slices[i].slice_id);
      }
    }

    for (const t of snap.tasks) {
      assertRecord(t, `${name}.tasks[]`);
      if (typeof t.task_id !== 'string' || t.task_id.length === 0) {
        throw new ReplanImpactError(`${name}.tasks[].task_id must be a non-empty string`);
      }
      if (taskIds.has(t.task_id)) throw new ReplanImpactError(`${name}.tasks has duplicate task_id ${t.task_id}`);
      taskIds.add(t.task_id);
      if (typeof t.slice_id !== 'string' || !sliceIds.has(t.slice_id)) {
        throw new ReplanImpactError(`${name}.tasks[].slice_id must reference an existing slice`);
      }
      if (sliceByTask.get(t.task_id) !== t.slice_id) {
        throw new ReplanImpactError(`${name}.tasks[].task_id is not bound by its declared slice`);
      }
      if (typeof t.goal !== 'string' || t.goal.length === 0) {
        throw new ReplanImpactError(`${name}.tasks[].goal must be a non-empty string`);
      }
      assertStringArray(t.refs, `${name}.tasks[].refs`);
      assertStringArray(t.dependencies, `${name}.tasks[].dependencies`);
      assertStringArray(t.required_skills, `${name}.tasks[].required_skills`);
      assertRecord(t.execution_scope, `${name}.tasks[].execution_scope`);
      const scope = t.execution_scope;
      if (typeof scope.kind !== 'string' || !EXECUTION_SCOPE_KINDS.has(scope.kind)) {
        throw new ReplanImpactError(`${name}.tasks[].execution_scope.kind must be implementation or evidence-only`);
      }
      assertStringArray(scope.code_paths, `${name}.tasks[].execution_scope.code_paths`);
      assertStringArray(scope.test_paths, `${name}.tasks[].execution_scope.test_paths`);
      assertStringArray(scope.forbidden_paths, `${name}.tasks[].execution_scope.forbidden_paths`);
    }

    if (taskIds.size !== sliceByTask.size) {
      throw new ReplanImpactError(`${name}: tasks and slice task bindings do not partition the same set`);
    }

    // Every referenced ref id must resolve in the reference index (the
    // classifier needs binding digests to attribute authority changes).
    const referencedRefIds = new Set<string>();
    for (const s of snap.slices) {
      referencedRefIds.add(s.proof_index.goal_ref);
      for (const ref of [
        ...s.proof_index.task_refs,
        ...s.proof_index.acceptance_refs,
        ...s.proof_index.seam_refs,
        ...s.proof_index.oracle_refs,
        ...s.proof_index.risk_refs.map((r: ReplanRiskBindingInput) => r.ref_id),
      ]) {
        referencedRefIds.add(ref);
      }
    }
    for (const t of snap.tasks) {
      for (const ref of t.refs) referencedRefIds.add(ref);
    }
    for (const refId of referencedRefIds) {
      const desc = snap.reference_index[refId];
      if (desc === undefined) throw new ReplanImpactError(`${name}.reference_index is missing ref ${refId}`);
      assertRecord(desc, `${name}.reference_index[${refId}]`);
      if (typeof desc.kind !== 'string' || desc.kind.length === 0) {
        throw new ReplanImpactError(`${name}.reference_index[${refId}].kind must be a non-empty string`);
      }
      if (typeof desc.ref !== 'string' || desc.ref.length === 0) {
        throw new ReplanImpactError(`${name}.reference_index[${refId}].ref must be a non-empty string`);
      }
      assertHexDigest(desc.file_digest, `${name}.reference_index[${refId}].file_digest`, SHA256_HEX_RE);
      assertHexDigest(desc.section_digest, `${name}.reference_index[${refId}].section_digest`, SHA256_HEX_RE);
    }
  }

  assertStringArray(input.completed_task_ids, 'input.completed_task_ids');
  if (typeof input.parent_epoch_digest !== 'string') {
    throw new ReplanImpactError('input.parent_epoch_digest must be a string');
  }
}

/** Reference binding digest of one ref descriptor. */
function referenceBindingDigest(desc: ReplanReferenceDescriptorInput): string {
  return computeDigest({
    kind: desc.kind,
    ref: desc.ref,
    file_digest: desc.file_digest,
    section_digest: desc.section_digest,
  });
}

/** Slice execution order (Kahn's algorithm over depends_on); null on cycle. */
function sliceTopologicalOrder(slices: readonly ReplanSliceContractInput[]): string[] | null {
  const ids = [...new Set(slices.map((s) => s.slice_id))];
  const deps = new Map(ids.map((id) => [id, new Set<string>()]));
  for (const s of slices) {
    for (const d of s.depends_on) deps.get(s.slice_id)?.add(d);
  }
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const id of ids) {
    for (const dep of deps.get(id) ?? []) indegree.set(id, (indegree.get(id) ?? 0) + 1);
  }
  const ready = [...indegree.entries()]
    .filter(([, d]) => d === 0)
    .map(([id]) => id)
    .sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const id of ids) {
      if ((deps.get(id) ?? new Set()).has(next)) {
        const deg = (indegree.get(id) ?? 0) - 1;
        indegree.set(id, deg);
        if (deg === 0) {
          ready.push(id);
          ready.sort();
        }
      }
    }
  }
  return order.length === ids.length ? order : null;
}

// ============================================================
// Classification
// ============================================================

function computeChangedTaskIds(
  prevDigests: ReadonlyMap<string, string>,
  candDigests: ReadonlyMap<string, string>,
): string[] {
  const changed = new Set<string>();
  for (const [taskId, digest] of prevDigests) {
    if (candDigests.get(taskId) !== digest) changed.add(taskId);
  }
  for (const taskId of candDigests.keys()) {
    if (!prevDigests.has(taskId)) changed.add(taskId);
  }
  return [...changed].sort();
}

function buildDisposition(
  input: ClassifyReplanImpactInput,
  impactScope: ReplanImpactScope,
  changedTaskIds: readonly string[],
  carryForwardTaskIds: readonly string[],
  invalidatedTaskIds: readonly string[],
  unresolvedReason?: ReplanImpactUnresolvedReason,
): ReplanImpactDisposition {
  return {
    schema_version: 1,
    stage_id: input.candidate.stage_id,
    parent_epoch_digest: input.parent_epoch_digest,
    impact_scope: impactScope,
    changed_task_ids: [...changedTaskIds],
    carry_forward_task_ids: [...carryForwardTaskIds],
    invalidated_task_ids: [...invalidatedTaskIds],
    previous_manifest_digest: input.previous.manifest_digest,
    manifest_digest: input.candidate.manifest_digest,
    previous_plan_digest: input.previous.plan_digest,
    plan_digest: input.candidate.plan_digest,
    snapshot_digest: input.candidate.snapshot_digest,
    ...(unresolvedReason !== undefined ? { unresolved_reason: unresolvedReason } : {}),
  };
}

/** Downstream dependency closure of the changed Tasks (§10.10):
 *  - same-slice successors in execution order (后续 Tasks);
 *  - Task-level dependents (tasks whose dependencies reach the closure);
 *  - every Task of Slices that transitively depend on a changed Task's Slice.
 *  Returns null when the closure cannot be proven (unknown dependency target
 *  or a dependency cycle). */
function computeDownstreamClosure(
  changedTaskIds: readonly string[],
  previous: ReplanPlanSnapshotInput,
  candidate: ReplanPlanSnapshotInput,
): Set<string> | null {
  const closure = new Set(changedTaskIds);

  // Task order per slice: candidate order wins; removed Tasks fall back to
  // the previous order so their successors stay determinable.
  const orderBySlice = new Map<string, string[]>();
  const sliceOfTask = new Map<string, string>();
  const tasksBySlice = new Map<string, ReplanTaskContractInput[]>();
  for (const snap of [candidate, previous]) {
    for (const slice of snap.slices) {
      for (const taskId of slice.task_ids) {
        if (!orderBySlice.has(slice.slice_id)) orderBySlice.set(slice.slice_id, []);
        const order = orderBySlice.get(slice.slice_id)!;
        if (!order.includes(taskId)) order.push(taskId);
        if (!sliceOfTask.has(taskId)) sliceOfTask.set(taskId, slice.slice_id);
      }
    }
    for (const t of snap.tasks) {
      const list = tasksBySlice.get(t.slice_id) ?? [];
      if (!list.some((x) => x.task_id === t.task_id)) list.push(t);
      tasksBySlice.set(t.slice_id, list);
    }
  }

  // Every dependency target of every Task in both snapshots must resolve to
  // a known Task id — an unknown target anywhere makes the closure
  // unprovable (fail closed, never guessed as task-local).
  const knownTaskIds = new Set([...candidate.tasks, ...previous.tasks].map((t) => t.task_id));
  for (const snap of [candidate, previous]) {
    for (const t of snap.tasks) {
      for (const dep of t.dependencies) {
        if (!knownTaskIds.has(dep)) return null;
      }
    }
  }

  // Task-level dependents (fixpoint over the dependency edges).
  for (let pass = 0; pass < candidate.tasks.length + 1; pass += 1) {
    let grew = false;
    for (const snap of [candidate, previous]) {
      for (const t of snap.tasks) {
        if (closure.has(t.task_id)) continue;
        if (t.dependencies.some((dep) => closure.has(dep))) {
          closure.add(t.task_id);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }

  // Slice-level downstream: every Slice that DEPENDS on a changed Task's
  // Slice (reverse reachability over depends_on). The changed Slices
  // themselves are never added here — their own Tasks are covered by the
  // successor/dependent rules above, and their PREDECESSORS must stay
  // outside the closure (they are the carry-forward candidates).
  const dependsOn = new Map<string, string[]>();
  for (const snap of [candidate, previous]) {
    for (const s of snap.slices) {
      const deps = dependsOn.get(s.slice_id) ?? [];
      for (const d of s.depends_on) if (!deps.includes(d)) deps.push(d);
      dependsOn.set(s.slice_id, deps);
    }
  }
  const allSliceIds = [...new Set([...previous.slices, ...candidate.slices].map((s) => s.slice_id))];
  // A dependency cycle in the Slice graph makes the downstream closure
  // unorderable and unprovable (fail closed).
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (sliceId: string): boolean => {
    if (visiting.has(sliceId)) return false;
    if (visited.has(sliceId)) return true;
    visiting.add(sliceId);
    for (const dep of dependsOn.get(sliceId) ?? []) {
      if (!visit(dep)) return false;
    }
    visiting.delete(sliceId);
    visited.add(sliceId);
    return true;
  };
  for (const sliceId of allSliceIds) {
    if (!visit(sliceId)) return null;
  }
  const changedSlices = new Set<string>();
  for (const taskId of changedTaskIds) {
    const sliceId = sliceOfTask.get(taskId);
    if (sliceId === undefined) return null;
    changedSlices.add(sliceId);
  }
  const downstreamSlices = new Set<string>();
  for (let pass = 0; pass < allSliceIds.length + 1; pass += 1) {
    let grew = false;
    for (const sliceId of allSliceIds) {
      if (downstreamSlices.has(sliceId) || changedSlices.has(sliceId)) continue;
      const deps = dependsOn.get(sliceId) ?? [];
      if (deps.some((d) => downstreamSlices.has(d) || changedSlices.has(d))) {
        downstreamSlices.add(sliceId);
        grew = true;
      }
    }
    if (!grew) break;
  }
  for (const sliceId of downstreamSlices) {
    for (const t of tasksBySlice.get(sliceId) ?? []) {
      closure.add(t.task_id);
    }
  }

  // Same-slice successors of the changed Tasks (后续 Tasks in execution
  // order, §10.10 "当前 Task 及其后续 Tasks").
  for (const taskId of changedTaskIds) {
    const sliceId = sliceOfTask.get(taskId);
    const order = sliceId === undefined ? undefined : orderBySlice.get(sliceId);
    if (order === undefined) return null;
    const position = order.indexOf(taskId);
    if (position === -1) return null;
    for (let i = position + 1; i < order.length; i += 1) {
      closure.add(order[i]);
    }
  }

  return closure;
}

/** Carry-forward rule (§8.8): only Tasks that are completed, contract-digest
 *  identical, outside the invalidated closure, and strictly BEFORE the first
 *  changed Task of their Slice may carry forward. */
function computeCarryForward(
  completedTaskIds: readonly string[],
  changedTaskIds: readonly string[],
  invalidated: ReadonlySet<string>,
  prevDigests: ReadonlyMap<string, string>,
  candDigests: ReadonlyMap<string, string>,
  candidate: ReplanPlanSnapshotInput,
): string[] {
  const sliceOrder = new Map(candidate.slices.map((s) => [s.slice_id, s.task_ids]));
  const sliceOfTask = new Map(candidate.tasks.map((t) => [t.task_id, t.slice_id]));
  const carry: string[] = [];
  for (const taskId of uniqueSorted(completedTaskIds)) {
    if (!candDigests.has(taskId)) continue; // removed from the candidate plan
    if (invalidated.has(taskId)) continue; // affected by the change
    if (prevDigests.get(taskId) !== candDigests.get(taskId)) continue; // contract changed
    const sliceId = sliceOfTask.get(taskId);
    const order = sliceId === undefined ? undefined : sliceOrder.get(sliceId);
    if (order === undefined) continue;
    const firstChanged = order.find((id) => changedTaskIds.includes(id));
    if (firstChanged !== undefined && order.indexOf(taskId) > order.indexOf(firstChanged)) {
      continue; // not strictly before the first changed Task of its Slice
    }
    carry.push(taskId);
  }
  return carry;
}

export function classifyReplanImpact(input: ClassifyReplanImpactInput): ReplanImpactDisposition {
  validateInput(input);

  const { previous: prev, candidate: cand } = input;

  // Fail-closed unresolved cases (§10.10 / §8.8: REPLAN.IMPACT_UNRESOLVED).
  // A parent epoch digest is mandatory for every replan classification; an
  // empty or malformed one can never authorize inheritance.
  if (input.parent_epoch_digest === '') {
    return buildDisposition(input, 'unresolved', [], [], [], 'PARENT_EPOCH_MISSING');
  }
  if (!SHA256_HEX_RE.test(input.parent_epoch_digest)) {
    return buildDisposition(input, 'unresolved', [], [], [], 'PARENT_EPOCH_INVALID');
  }
  if (prev.stage_id !== cand.stage_id) {
    return buildDisposition(input, 'unresolved', [], [], [], 'STAGE_MISMATCH');
  }

  const prevTaskDigests = new Map(prev.tasks.map((t) => [t.task_id, taskContractDigest(t)]));
  const candTaskDigests = new Map(cand.tasks.map((t) => [t.task_id, taskContractDigest(t)]));
  const changedTaskIds = computeChangedTaskIds(prevTaskDigests, candTaskDigests);

  const sliceWide = (): ReplanImpactDisposition => {
    const allTaskIds = uniqueSorted([...prevTaskDigests.keys(), ...candTaskDigests.keys()]);
    return buildDisposition(input, 'slice-wide', changedTaskIds, [], allTaskIds);
  };

  // Stage contract is the top boundary: any change re-establishes the whole
  // execution boundary (§10.10) — nothing carries forward, every Task is
  // invalidated.
  if (prev.stage_contract_digest !== cand.stage_contract_digest) return sliceWide();

  // A cyclic Slice dependency graph makes the execution order (and therefore
  // the downstream closure) unprovable: fail closed as unresolved before any
  // structural comparison is trusted (§10.10: 无法完整证明 → fail-closed).
  const topoOrder = sliceTopologicalOrder([...prev.slices, ...cand.slices]);
  if (topoOrder === null) {
    return buildDisposition(input, 'unresolved', [], [], [], 'CLOSURE_UNPROVABLE');
  }

  // Slice set identity: adding or removing a Slice is a slice-wide change.
  const prevSliceIds = new Set(prev.slices.map((s) => s.slice_id));
  const candSliceIds = new Set(cand.slices.map((s) => s.slice_id));
  if (prevSliceIds.size !== candSliceIds.size || [...prevSliceIds].some((id) => !candSliceIds.has(id))) {
    return sliceWide();
  }

  // Authority reference set identity (§10.10: 权威引用变化 → slice-wide).
  const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
    const sa = uniqueSorted(a);
    const sb = uniqueSorted(b);
    return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
  };
  if (!sameSet(prev.authority_ref_ids, cand.authority_ref_ids)) return sliceWide();

  // Per-Slice proof boundary and structural facts must be identical; a Slice
  // without changed Tasks must also keep its whole Slice contract digest
  // (§10.10: Slice proof index / 执行范围变化 → slice-wide).
  const sliceOfTask = new Map<string, string>();
  for (const snap of [prev, cand]) {
    for (const t of snap.tasks) {
      if (!sliceOfTask.has(t.task_id)) sliceOfTask.set(t.task_id, t.slice_id);
    }
  }
  const changedSlices = new Set<string>();
  for (const taskId of changedTaskIds) {
    const sliceId = sliceOfTask.get(taskId);
    if (sliceId !== undefined) changedSlices.add(sliceId);
  }
  const prevSliceById = new Map(prev.slices.map((s) => [s.slice_id, s]));
  const candSliceById = new Map(cand.slices.map((s) => [s.slice_id, s]));
  for (const sliceId of candSliceIds) {
    const ps = prevSliceById.get(sliceId)!;
    const cs = candSliceById.get(sliceId)!;
    if (proofIndexDigest(ps.proof_index) !== proofIndexDigest(cs.proof_index)) return sliceWide();
    if (sliceStructuralDigest(ps) !== sliceStructuralDigest(cs)) return sliceWide();
    if (!changedSlices.has(sliceId) && ps.slice_contract_digest !== cs.slice_contract_digest) return sliceWide();
  }

  // Reference binding attribution: authority content changes are slice-wide
  // unless every changed binding belongs to a changed Task (§10.10: 权威引用
  // 变化 → slice-wide; the replanned Task's own entity re-render is expected).
  const prevBindings = new Map(
    Object.entries(prev.reference_index).map(([refId, desc]) => [refId, referenceBindingDigest(desc)] as const),
  );
  const candBindings = new Map(
    Object.entries(cand.reference_index).map(([refId, desc]) => [refId, referenceBindingDigest(desc)] as const),
  );
  const bindingDelta = new Set<string>([
    ...[...prevBindings.keys(), ...candBindings.keys()].filter((refId) => prevBindings.get(refId) !== candBindings.get(refId)),
  ]);
  if (bindingDelta.size > 0) {
    const ownedByChanged = new Set<string>();
    for (const snap of [prev, cand]) {
      for (const t of snap.tasks) {
        if (changedTaskIds.includes(t.task_id)) for (const ref of t.refs) ownedByChanged.add(ref);
      }
    }
    if ([...bindingDelta].some((refId) => !ownedByChanged.has(refId))) return sliceWide();
  }

  if (changedTaskIds.length === 0) {
    // No Task contract changed and every Stage/Slice/authority boundary is
    // identical: a task-local no-op; every completed Task still in the
    // candidate plan carries forward (its contract digest matches by
    // construction).
    const carry = uniqueSorted(input.completed_task_ids.filter((id) => candTaskDigests.has(id)));
    return buildDisposition(input, 'task-local', [], carry, []);
  }

  // Single-root rule: the change must be "current Task + its downstream
  // dependency closure" (§10.10). The root is the earliest changed Task in
  // global execution order; every other changed Task must lie inside the
  // root's closure, otherwise the change has independent roots → slice-wide.
  const globalOrder: string[] = [];
  for (const sliceId of topoOrder) {
    for (const taskId of candSliceById.get(sliceId)?.task_ids ?? prevSliceById.get(sliceId)?.task_ids ?? []) {
      if (!globalOrder.includes(taskId)) globalOrder.push(taskId);
    }
  }
  const root = [...changedTaskIds].sort((a, b) => globalOrder.indexOf(a) - globalOrder.indexOf(b))[0];

  const closure = computeDownstreamClosure([root], prev, cand);
  if (closure === null) {
    // The dependency closure cannot be proven (unknown dependency target or
    // a dependency cycle): fail closed, never guess task-local.
    return buildDisposition(input, 'unresolved', [], [], [], 'CLOSURE_UNPROVABLE');
  }
  if (changedTaskIds.some((taskId) => !closure.has(taskId))) return sliceWide();

  const invalidated = [...closure].sort();
  const carry = computeCarryForward(
    input.completed_task_ids,
    changedTaskIds,
    closure,
    prevTaskDigests,
    candTaskDigests,
    cand,
  );
  return buildDisposition(input, 'task-local', changedTaskIds, carry, invalidated);
}
