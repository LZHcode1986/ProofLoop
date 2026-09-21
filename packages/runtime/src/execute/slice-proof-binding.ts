/**
 * @proofloop/runtime — three-layer slice proof binding projection seam
 * (S03-F-T01; PRD FR-013 / HP-002; E2E-10/11/18).
 *
 * This module is the ONLY PUBLIC classification entry for Slice replan impact:
 * it projects accepted Thin Plan facts (§4.1 shape) + MES work identity + Git
 * basis + a caller-provided resolved reference index into the mechanical
 * `classifyReplanImpact` previous/candidate snapshots (raw engine stays an
 * internal module — `vnext/replan-impact`; never re-exported here).
 *
 * Frozen three-layer fingerprints (no vague normalized placeholder):
 *
 *   SPN(x)        = canonical typed JSON — object keys sorted recursively by
 *                   UTF-16 code-unit order, arrays keep THEIR APPEARANCE ORDER
 *                   (no re-sort, no dedup) — implemented by the kernel's single
 *                   canonicalization (`canonicalJson`); digests are
 *                   SHA-256(UTF-8(SPN(fields))) = kernel `computeDigest`.
 *   stage_contract_digest    = SHA-256(SPN(stage_contract_fields))
 *   proof_boundary_digest(s) = SHA-256(SPN(slice_contract_fields(s)))
 *
 *   stage_contract_fields = stage-global facts ONLY:
 *   { stage_id, project_stage_map_ref, shared_forbidden_paths(顺序),
 *     default_required_skills(顺序), map_entry_facts } — slices/tasks are
 *     EXPLICITLY excluded so slice/task edits never flip the stage digest.
 *   map_entry_facts resolves the current Map row through the existing Map seam
 *   (`resolveStageMapEntry`) and normalizes
 *   { stage_id, depends_on, goal(原文), entry_criteria(原文),
 *     authority_refs (canonical-only, row order) } — Map row edits flip the
 *   stage digest (FR-013 Case 3); missing/duplicate/invalid rows fail closed
 *   with PLAN_GAP semantics.
 *
 * Deterministic ref mapping (adapter-owned, no vague passthrough):
 *   - derived plan-internal descriptors per slice/task:
 *       goal_ref  = {kind:'goal',  ref:<plan-ref>#slice-<slice-id>}
 *       task_refs = {kind:'task',  ref:<plan-ref>#<task-id>}
 *     file_digest = SHA-256(plan file bytes at git basis), section_digest =
 *     SHA-256(SPN(slice/task block)). These plan-internal derived refs are
 *     shape-recognized by the engine and EXCLUDED from the Authority content
 *     delta / owner attribution (plan-file edits never leak stage-wide).
 *   - canonical authority/verification refs are classed by path:
 *       tech-spec/acceptance.md# → acceptance
 *       PRD.md#                  → goal      (stage-level goal authority)
 *       tech-spec/architecture.md# → risk
 *       tech-spec/contracts.md#  → seam
 *     filter = canonical no-whitespace refs only; sort within class ascending,
 *     dedup; .agents bare refs / PO test identifiers / plan-internal non-derived
 *     refs / bare or non-canonical refs are excluded. PRD.md goal-kind refs are
 *     indexed and tracked in the stage authority set but own no Slice: their
 *     change fails closed to Stage-wide (never guessed task-local). Missing /
 *     unclassifiable / duplicate resolved-index entries fail closed with
 *     REPLAN.IMPACT_INPUT_INVALID.
 *
 * Closed execution binding (sealed in this adapter): every projected snapshot
 * REQUIRED-fills `execution_binding` = { plan_ref, work_id, git_basis } and the
 * public classification entry enforces EXACT equality with the caller-provided
 * binding (plan_ref / work_id / git_basis all equal) — mismatch fails closed
 * with RESULT_BINDING_MISMATCH. The disposition snapshot_digest is the 40-hex
 * git-basis head of that binding.
 *
 * Pure seam: reads no MES, writes no store, runs no Git commands. Tests live in
 * packages/runtime/test/slice-proof-binding.test.ts (PO-S03-F-01 / F-02).
 */
import {
  computeDigest,
  sha256Hex,
  validateVNextReferenceIndex,
  type VNextReferenceDescriptor,
  type VNextReferenceIndex,
} from '@proofloop/kernel';
import { isCanonicalAuthorityRef, isCanonicalRootRelativeRef } from '../mes/binding';
import {
  resolveStageMapEntry,
  StageMapResolutionError,
} from '../vnext/stage-map';
import {
  classifyReplanImpact,
  type ReplanExecutionBindingGitBasis,
  type ReplanExecutionBindingInput,
  type ReplanPlanSnapshotInput,
  type ReplanProofIndexInput,
  type ReplanRiskBindingInput,
  type ReplanSliceContractInput,
  type ReplanTaskContractInput,
} from '../vnext/replan-impact';

/** Closed execution binding: accepted Plan ref + MES work identity + Git basis. */
export interface ExecutionBinding {
  readonly plan_ref: string;
  readonly work_id: string;
  readonly git_basis: ReplanExecutionBindingGitBasis;
}

/** Thin-Plan execution scope block (§4.1), mirrored from the accepted Plan. */
export interface SliceProofExecutionScope {
  readonly kind: 'implementation' | 'evidence-only';
  readonly code_paths: readonly string[];
  readonly test_paths: readonly string[];
  readonly forbidden_paths: readonly string[];
}

/** Accepted Thin-Plan task block facts consumed by the projection. */
export interface TaskFacts {
  readonly task_id: string;
  readonly slice_id: string;
  readonly goal: string;
  readonly semantic_scope: string;
  readonly dependencies: readonly string[];
  readonly required_skills: readonly string[];
  readonly proof_obligation_ids: readonly string[];
  readonly execution_scope: SliceProofExecutionScope;
  readonly code_anchors: readonly string[];
  readonly verification_refs: readonly string[];
}

/** Accepted Thin-Plan slice block facts consumed by the projection. */
export interface SliceFacts {
  readonly slice_id: string;
  readonly goal: string;
  readonly depends_on: readonly string[];
  readonly authority_refs: readonly string[];
  readonly task_ids: readonly string[];
}

/**
 * One side (previous / candidate) of the projection input — the accepted Thin
 * Plan facts + MES work identity + Git basis + resolved reference index, all
 * read at the caller's git basis (caller supplies file text; this seam never
 * reads the worktree itself).
 */
export interface SliceProofProjectionInput {
  readonly stage_id: string;
  /** Root-relative accepted Thin Plan ref (stable ref of the accepted Plan). */
  readonly plan_ref: string;
  /** 64-hex plan digest from the MES plan_binding. */
  readonly plan_digest: string;
  /** Plan file bytes at the git basis (for derived descriptor file_digest). */
  readonly plan_markdown: string;
  /** Current Map artifact text at the git basis. */
  readonly map_markdown: string;
  /** `<delivery/project-stage-map.md>#<stage-id>` binding of the Map row. */
  readonly project_stage_map_ref: string;
  readonly shared_forbidden_paths: readonly string[];
  readonly default_required_skills: readonly string[];
  readonly slices: readonly SliceFacts[];
  readonly tasks: readonly TaskFacts[];
  /** Caller-provided resolved reference index (kernel shape). */
  readonly resolved_reference_index: VNextReferenceIndex;
  readonly work_id: string;
  readonly git_basis: ReplanExecutionBindingGitBasis;
}

/** Typed fail-closed error of the binding seam (§7 outcomes). */
export type SliceProofBindingErrorCode =
  | 'PLAN_GAP'
  | 'REPLAN.IMPACT_INPUT_INVALID'
  | 'RESULT_BINDING_MISMATCH';

export class SliceProofBindingError extends Error {
  readonly code: SliceProofBindingErrorCode;
  constructor(code: SliceProofBindingErrorCode, message: string) {
    super(message);
    this.name = 'SliceProofBindingError';
    this.code = code;
  }
}

export interface ClassifySliceProofImpactInput {
  /** Caller-authoritative closed execution binding (current lane). */
  readonly execution_binding: ExecutionBinding;
  readonly previous: SliceProofProjectionInput;
  readonly candidate: SliceProofProjectionInput;
  readonly completed_task_ids: readonly string[];
}

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const GIT_HEAD_HEX_RE = /^[a-f0-9]{40}$/;
const ACCEPTANCE_PATH = 'tech-spec/acceptance.md';
const CONTRACTS_PATH = 'tech-spec/contracts.md';
const ARCHITECTURE_PATH = 'tech-spec/architecture.md';
const PRD_PATH = 'PRD.md';

type CanonicalClass = 'acceptance' | 'goal' | 'risk' | 'seam';

/**
 * Canonical refs only: `path#section`, root-relative, no whitespace, not an
 * `.agents` ref, not a PO test identifier, and not plan-internal (path equals
 * the plan ref). Everything else (bare paths, `.agents` file refs, PO ids,
 * plan-internal non-derived refs, non-canonical strings) is excluded.
 */
function isCitableCanonicalRef(ref: string, planRef: string): boolean {
  if (!isCanonicalAuthorityRef(ref)) return false;
  const hash = ref.indexOf('#');
  const section = ref.slice(hash + 1);
  if (ref.slice(0, hash).startsWith('.agents')) return false;
  if (/^PO-S\d+/.test(section)) return false;
  if (ref.slice(0, hash) === planRef) return false; // plan-internal non-derived ref
  return true;
}

/** Closed class of a canonical ref by path; unclassifiable → fail closed. */
function classifyRef(ref: string): CanonicalClass {
  const path = ref.slice(0, ref.indexOf('#'));
  if (path === ACCEPTANCE_PATH) return 'acceptance';
  if (path === PRD_PATH) return 'goal';
  if (path === ARCHITECTURE_PATH) return 'risk';
  if (path === CONTRACTS_PATH) return 'seam';
  throw new SliceProofBindingError(
    'REPLAN.IMPACT_INPUT_INVALID',
    `canonical ref ${JSON.stringify(ref)} has no closed class (acceptance/goal/risk/seam)`,
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function canonicalOnly(values: readonly string[], planRef: string): string[] {
  return [...new Set(values.filter((v) => isCitableCanonicalRef(v, planRef)))];
}

/** Row-order tokenization of an opaque Map authority-refs cell. */
function mapCellCanonicalRefs(cell: string): string[] {
  return cell
    .split(/[；、，,;\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && isCanonicalAuthorityRef(t));
}

// ---------------------------------------------------------------------------
// Frozen SPN digest formulas (S03-F-T01)
// ---------------------------------------------------------------------------

/** `task_contract_fields(task)` as a typed object (SPN block). */
function taskContractBlock(task: TaskFacts, planRef: string): Record<string, unknown> {
  return {
    task_id: task.task_id,
    goal: task.goal,
    semantic_scope: task.semantic_scope,
    dependencies: [...task.dependencies],
    required_skills: [...task.required_skills],
    proof_obligation_ids: [...task.proof_obligation_ids],
    execution_scope: {
      kind: task.execution_scope.kind,
      code_paths: [...task.execution_scope.code_paths],
      test_paths: [...task.execution_scope.test_paths],
    },
    code_anchors: [...canonicalOnly(task.code_anchors, planRef)],
    verification_refs: [...canonicalOnly(task.verification_refs, planRef)],
  };
}

/** `slice_contract_fields(slice)` as a typed object (SPN block). */
function sliceContractBlock(
  slice: SliceFacts,
  tasks: readonly TaskFacts[],
  planRef: string,
): Record<string, unknown> {
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const taskBlocks = slice.task_ids.map((taskId) => {
    const task = byId.get(taskId);
    if (task === undefined) {
      throw new SliceProofBindingError(
        'REPLAN.IMPACT_INPUT_INVALID',
        `slice ${JSON.stringify(slice.slice_id)} references unknown task ${JSON.stringify(taskId)}, or the task is not bound to this slice`,
      );
    }
    if (task.slice_id !== slice.slice_id) {
      throw new SliceProofBindingError(
        'REPLAN.IMPACT_INPUT_INVALID',
        `task ${JSON.stringify(taskId)} is declared in slice ${JSON.stringify(task.slice_id)} but listed in slice ${JSON.stringify(slice.slice_id)} task_ids`,
      );
    }
    return taskContractBlock(task, planRef);
  });
  return {
    slice_id: slice.slice_id,
    goal: slice.goal,
    depends_on: [...slice.depends_on],
    authority_refs: [...canonicalOnly(slice.authority_refs, planRef)],
    tasks: taskBlocks,
  };
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function assertSha256Hex(value: unknown, name: string): void {
  if (typeof value !== 'string' || !SHA256_HEX_RE.test(value)) {
    throw new SliceProofBindingError(
      'REPLAN.IMPACT_INPUT_INVALID',
      `${name} must be a 64-hex sha256 digest`,
    );
  }
}

function assertGitHead(value: unknown, name: string): void {
  if (typeof value !== 'string' || !GIT_HEAD_HEX_RE.test(value)) {
    throw new SliceProofBindingError(
      'REPLAN.IMPACT_INPUT_INVALID',
      `${name} must be a 40-hex git head`,
    );
  }
}

function assertNonEmptyString(value: unknown, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SliceProofBindingError(
      'REPLAN.IMPACT_INPUT_INVALID',
      `${name} must be a non-empty string`,
    );
  }
}

/**
 * Deterministically derive the closed snapshot descriptor for one accepted
 * Plan side. Never reads files / MES / Git: the caller supplies the plan
 * bytes, the Map text and the resolved reference index at the git basis.
 */
export function projectSliceProofSnapshot(
  side: SliceProofProjectionInput,
  binding: ExecutionBinding,
): ReplanPlanSnapshotInput {
  assertNonEmptyString(side.stage_id, 'stage_id');
  assertNonEmptyString(side.plan_ref, 'plan_ref');
  assertSha256Hex(side.plan_digest, 'plan_digest');
  assertNonEmptyString(side.plan_markdown, 'plan_markdown');
  assertNonEmptyString(side.map_markdown, 'map_markdown');
  assertNonEmptyString(side.project_stage_map_ref, 'project_stage_map_ref');
  assertNonEmptyString(side.work_id, 'work_id');
  assertGitHead(side.git_basis.head, 'git_basis.head');
  assertNonEmptyString(side.git_basis.branch, 'git_basis.branch');
  assertNonEmptyString(side.git_basis.worktree, 'git_basis.worktree');

  // Map row resolution (existing seam, PLAN_GAP fail-closed semantics).
  let entry;
  try {
    entry = resolveStageMapEntry(side.map_markdown, side.project_stage_map_ref);
  } catch (error) {
    if (error instanceof StageMapResolutionError) {
      throw new SliceProofBindingError('PLAN_GAP', `Map entry resolution failed: ${error.message}`);
    }
    throw error;
  }
  if (entry.stage_id !== side.stage_id) {
    throw new SliceProofBindingError(
      'PLAN_GAP',
      `Map entry stage ${JSON.stringify(entry.stage_id)} does not equal plan stage_id ${JSON.stringify(side.stage_id)}`,
    );
  }

  // --- stage_contract_fields (stage-global facts only; slices/tasks excluded) ---
  const mapEntryFacts = {
    stage_id: entry.stage_id,
    depends_on: entry.depends_on,
    goal: entry.goal,
    entry_criteria: entry.entry_criteria,
    authority_refs: mapCellCanonicalRefs(entry.authority_refs),
  };
  const stageContractFields = {
    stage_id: side.stage_id,
    project_stage_map_ref: side.project_stage_map_ref,
    shared_forbidden_paths: [...side.shared_forbidden_paths],
    default_required_skills: [...side.default_required_skills],
    map_entry_facts: mapEntryFacts,
  };
  const stageContractDigest = computeDigest(stageContractFields);

  // --- per-slice contract blocks + deterministic ref mapping ---
  const sliceById = new Map(side.slices.map((s) => [s.slice_id, s]));
  const tasksBySlice = new Map<string, TaskFacts[]>();
  for (const t of side.tasks) {
    if (!sliceById.has(t.slice_id)) {
      throw new SliceProofBindingError(
        'REPLAN.IMPACT_INPUT_INVALID',
        `task ${JSON.stringify(t.task_id)} declares unknown slice ${JSON.stringify(t.slice_id)}`,
      );
    }
    const list = tasksBySlice.get(t.slice_id) ?? [];
    list.push(t);
    tasksBySlice.set(t.slice_id, list);
  }
  for (const slice of side.slices) {
    const bound = tasksBySlice.get(slice.slice_id) ?? [];
    const boundIds = new Set(bound.map((t) => t.task_id));
    if (slice.task_ids.length === 0 || slice.task_ids.some((id) => !boundIds.has(id))) {
      throw new SliceProofBindingError(
        'REPLAN.IMPACT_INPUT_INVALID',
        `slice ${JSON.stringify(slice.slice_id)} task_ids must be a non-empty subset of its declared tasks in plan order`,
      );
    }
  }

  // Canonical ref source = slice authority_refs + task verification_refs.
  const stageCanonical = new Map<string, CanonicalClass>();
  const sliceAcceptance = new Map<string, string[]>();
  const sliceSeam = new Map<string, string[]>();
  const sliceRisk = new Map<string, string[]>();
  const addClassed = (sliceId: string | null, ref: string): void => {
    if (!isCitableCanonicalRef(ref, side.plan_ref)) return;
    const cls = classifyRef(ref);
    stageCanonical.set(ref, cls);
    if (sliceId === null) return;
    const bucket =
      cls === 'acceptance' ? sliceAcceptance : cls === 'seam' ? sliceSeam : cls === 'risk' ? sliceRisk : null;
    if (bucket === null) return; // goal-kind (PRD.md) stays stage-level
    const list = bucket.get(sliceId) ?? [];
    list.push(ref);
    bucket.set(sliceId, list);
  };
  for (const slice of side.slices) {
    for (const ref of slice.authority_refs) addClassed(slice.slice_id, ref);
    for (const t of side.tasks) {
      if (t.slice_id !== slice.slice_id) continue;
      for (const ref of t.verification_refs) addClassed(slice.slice_id, ref);
    }
  }

  // Every classed canonical ref must resolve in the caller's index (fail-closed).
  const referenceIndex: Record<string, VNextReferenceDescriptor> = {};
  for (const [ref, cls] of stageCanonical) {
    const desc = side.resolved_reference_index[ref];
    if (desc === undefined) {
      throw new SliceProofBindingError(
        'REPLAN.IMPACT_INPUT_INVALID',
        `resolved reference index is missing descriptor for canonical ref ${JSON.stringify(ref)}`,
      );
    }
    if (desc.kind !== cls) {
      throw new SliceProofBindingError(
        'REPLAN.IMPACT_INPUT_INVALID',
        `resolved descriptor kind ${JSON.stringify(desc.kind)} for ${JSON.stringify(ref)} contradicts its class ${JSON.stringify(cls)}`,
      );
    }
    referenceIndex[ref] = desc;
  }

  // Derived plan-internal descriptors (goal/task refs).
  const planFileDigest = sha256Hex(side.plan_markdown);
  const derivedGoalRefs = new Map<string, string>(); // sliceId -> ref id
  const derivedTaskRefs = new Map<string, string>(); // taskId -> ref id
  for (const slice of side.slices) {
    const goalRef = `${side.plan_ref}#slice-${slice.slice_id}`;
    derivedGoalRefs.set(slice.slice_id, goalRef);
    const sliceBlock = sliceContractBlock(slice, side.tasks, side.plan_ref);
    referenceIndex[goalRef] = {
      kind: 'goal',
      ref: goalRef,
      file_digest: planFileDigest,
      section_digest: computeDigest(sliceBlock),
    };
    for (const taskId of slice.task_ids) {
      const taskRef = `${side.plan_ref}#${taskId}`;
      derivedTaskRefs.set(taskId, taskRef);
      const task = side.tasks.find((t) => t.task_id === taskId)!;
      referenceIndex[taskRef] = {
        kind: 'task',
        ref: taskRef,
        file_digest: planFileDigest,
        section_digest: computeDigest(taskContractBlock(task, side.plan_ref)),
      };
    }
  }

  // Assembled index still passes the kernel validator (incl. generated ones).
  try {
    validateVNextReferenceIndex(referenceIndex);
  } catch (error) {
    throw new SliceProofBindingError(
      'REPLAN.IMPACT_INPUT_INVALID',
      `assembled reference index failed vNext validation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // --- engine slice contracts (proof_index + derived digests) ---
  const slices: ReplanSliceContractInput[] = side.slices.map((slice) => {
    const achievement = sliceAcceptance.get(slice.slice_id) ?? [];
    const seam = sliceSeam.get(slice.slice_id) ?? [];
    const risk = sliceRisk.get(slice.slice_id) ?? [];
    const proofIndex: ReplanProofIndexInput = {
      slice_id: slice.slice_id,
      goal_ref: derivedGoalRefs.get(slice.slice_id)!,
      task_refs: slice.task_ids.map((id) => derivedTaskRefs.get(id)!),
      acceptance_refs: uniqueSorted(achievement),
      seam_refs: uniqueSorted(seam),
      oracle_refs: [],
      risk_refs: uniqueSorted(risk).map(
        (refId): ReplanRiskBindingInput => ({
          ref_id: refId,
          applies_to_acceptance_refs: [],
          applies_to_seam_refs: [],
        }),
      ),
    };
    return {
      slice_id: slice.slice_id,
      slice_contract_digest: computeDigest(sliceContractBlock(slice, side.tasks, side.plan_ref)),
      // Slice-LEVEL proof-boundary digest (engine cv-1 guard): the slice's
      // OWN contract fields WITHOUT task blocks — goal / depends_on /
      // authority refs — so a slice-level boundary change is visible even
      // when a same-slice task goal/contract also changed (the engine
      // compares it before the changedSlices mask).
      slice_level_digest: computeDigest({
        slice_id: slice.slice_id,
        goal: slice.goal,
        depends_on: [...slice.depends_on],
        authority_refs: [...canonicalOnly(slice.authority_refs, side.plan_ref)],
      }),
      depends_on: [...slice.depends_on],
      required_skills: [],
      evidence_path: `delivery/stages/${side.stage_id}/evidence/${slice.slice_id}.md`,
      proof_index: proofIndex,
      task_ids: [...slice.task_ids],
    };
  });

  const tasks: ReplanTaskContractInput[] = side.tasks.map((t) => ({
    task_id: t.task_id,
    slice_id: t.slice_id,
    goal: t.goal,
    refs: uniqueSorted(canonicalOnly(t.verification_refs, side.plan_ref)),
    dependencies: [...t.dependencies],
    required_skills: [...t.required_skills],
    execution_scope: {
      kind: t.execution_scope.kind,
      code_paths: [...t.execution_scope.code_paths],
      test_paths: [...t.execution_scope.test_paths],
      forbidden_paths: [...t.execution_scope.forbidden_paths],
    },
    // Task-LEVEL proof-boundary digest (cv-1-recheck-1): the task's
    // proof-boundary fields that are NOT part of the ordinary task contract
    // digest. The engine compares it per task per slice UNCONDITIONALLY so a
    // completed predecessor's boundary change forces slice-wide invalidation
    // even when another same-slice task has an ordinary change.
    task_proof_digest: computeDigest({
      semantic_scope: t.semantic_scope,
      proof_obligation_ids: [...t.proof_obligation_ids],
      code_anchors: [...canonicalOnly(t.code_anchors, side.plan_ref)],
      verification_refs: [...canonicalOnly(t.verification_refs, side.plan_ref)],
    }),
  }));

  const executionBinding: ReplanExecutionBindingInput = {
    plan_ref: binding.plan_ref,
    work_id: binding.work_id,
    git_basis: binding.git_basis,
  };

  return {
    stage_id: side.stage_id,
    plan_ref: side.plan_ref,
    plan_digest: side.plan_digest,
    stage_contract_digest: stageContractDigest,
    snapshot_digest: side.git_basis.head,
    authority_ref_ids: uniqueSorted([...stageCanonical.keys()]),
    reference_index: referenceIndex,
    slices,
    tasks,
    execution_binding: executionBinding,
  };
}

function assertBindingShape(binding: ExecutionBinding): void {
  // Closed top-level field set (cv-1-recheck-2): only plan_ref / work_id /
  // git_basis are legal; any unknown key fails closed before projection.
  const allowedTopLevel = new Set(['plan_ref', 'work_id', 'git_basis']);
  for (const key of Object.keys(binding)) {
    if (!allowedTopLevel.has(key)) {
      throw new SliceProofBindingError(
        'RESULT_BINDING_MISMATCH',
        `execution_binding contains unknown top-level field ${JSON.stringify(key)}`,
      );
    }
  }
  if (typeof binding.git_basis !== 'object' || binding.git_basis === null || Array.isArray(binding.git_basis)) {
    throw new SliceProofBindingError(
      'RESULT_BINDING_MISMATCH',
      'execution_binding.git_basis must be a closed object',
    );
  }
  const allowedGit = new Set(['head', 'branch', 'worktree']);
  for (const key of Object.keys(binding.git_basis)) {
    if (!allowedGit.has(key)) {
      throw new SliceProofBindingError(
        'RESULT_BINDING_MISMATCH',
        `execution_binding.git_basis contains unknown field ${JSON.stringify(key)}`,
      );
    }
  }
  // plan_ref must be a canonical root-relative accepted Plan ref — absolute
  // / non-canonical refs fail closed (cv-1-recheck-2).
  assertNonEmptyString(binding.plan_ref, 'execution_binding.plan_ref');
  if (!isCanonicalRootRelativeRef(binding.plan_ref)) {
    throw new SliceProofBindingError(
      'RESULT_BINDING_MISMATCH',
      `execution_binding.plan_ref ${JSON.stringify(binding.plan_ref)} must be a canonical root-relative accepted Plan ref`,
    );
  }
  assertNonEmptyString(binding.work_id, 'execution_binding.work_id');
  assertGitHead(binding.git_basis.head, 'execution_binding.git_basis.head');
  assertNonEmptyString(binding.git_basis.branch, 'execution_binding.git_basis.branch');
  assertNonEmptyString(binding.git_basis.worktree, 'execution_binding.git_basis.worktree');
}

/**
 * The ONLY public classification entry. Projects both sides REQUIRED-filling
 * `execution_binding` and enforces EXACT equality with the caller-provided
 * binding against the candidate side (the current lane execution basis):
 * plan_ref / work_id / git_basis must all equal — otherwise
 * RESULT_BINDING_MISMATCH (no wrap, never guessed).
 */
export function classifySliceProofImpact(
  input: ClassifySliceProofImpactInput,
): ReturnType<typeof classifyReplanImpact> {
  assertBindingShape(input.execution_binding);
  const binding = input.execution_binding;
  // Candidate is the current execution binding: exact equality enforced.
  if (binding.plan_ref !== input.candidate.plan_ref) {
    throw new SliceProofBindingError(
      'RESULT_BINDING_MISMATCH',
      `execution_binding.plan_ref ${JSON.stringify(binding.plan_ref)} must equal candidate plan_ref ${JSON.stringify(input.candidate.plan_ref)}`,
    );
  }
  if (binding.work_id !== input.candidate.work_id) {
    throw new SliceProofBindingError(
      'RESULT_BINDING_MISMATCH',
      `execution_binding.work_id ${JSON.stringify(binding.work_id)} must equal candidate work_id ${JSON.stringify(input.candidate.work_id)}`,
    );
  }
  if (
    binding.git_basis.head !== input.candidate.git_basis.head ||
    binding.git_basis.branch !== input.candidate.git_basis.branch ||
    binding.git_basis.worktree !== input.candidate.git_basis.worktree
  ) {
    throw new SliceProofBindingError(
      'RESULT_BINDING_MISMATCH',
      'execution_binding.git_basis must exactly equal candidate git_basis',
    );
  }

  const previousSnapshot = projectSliceProofSnapshot(input.previous, binding);
  const candidateSnapshot = projectSliceProofSnapshot(input.candidate, binding);
  return classifyReplanImpact({
    previous: previousSnapshot,
    candidate: candidateSnapshot,
    completed_task_ids: [...input.completed_task_ids],
  });
}