/**
 * @proofloop/runtime — MES fact-kind binding validator (S01-B-T01).
 *
 * Fail-closed validation of the fact-kind-appropriate Plan binding, work
 * identity, and Git basis that every MES fact must carry (mes.md write
 * principle: what / which scope / under which candidate-or-accepted Plan +
 * work identity / against which Git basis / which durable ref).
 *
 * Rules follow the Contracts Authority (tech-spec/contracts.md §2.2 /
 * §2.2.1 / §2.2.2) and the MES Contract:
 *   - `plan_binding` facts carry a candidate (pre-accept, `accepted_plan_ref:
 *     null`) or accepted (promoted) binding; only a `PLAN_READY` candidate
 *     can be promoted, and promotion keeps the same candidate ref
 *     (`source_candidate_plan_ref === accepted_plan_ref`);
 *   - `NORMAL` execution-bound facts (`work` / `result` / `git`) must bind an
 *     `accepted` Plan, a MES work identity where applicable, Authority refs,
 *     and a Git basis;
 *   - `PRE_MES_BOOTSTRAP` execution-bound facts are Git-tracked Link
 *     evidence: they must NOT carry a pre-seed MES work identity or
 *     resultRef, and they bind the candidate/accepted Git Plan ref + Git
 *     basis only — no pre-seed MES prerequisite is invented.
 *
 * The validator is a closed set: unknown fields, malformed shapes, and
 * kind/mode-inconsistent bindings all fail with the canonical
 * `SchemaValidationError` (RUNTIME.SCHEMA_MISMATCH). No caller can bypass
 * it by smuggling values through a looser path.
 */
import {
  SchemaValidationError,
  isSha256Hex,
  VNEXT_REF_GRAMMAR_RE,
  CANONICAL_STAGE_ID_RE,
} from '@proofloop/kernel';
import {
  MES_FACT_KINDS,
  MES_PLAN_BINDING_STAGES,
  MES_PLAN_VERDICTS,
  MES_SLICE_ID_RE,
  MES_TASK_ID_RE,
} from './types';
import {
  isAcceptedPlanTaskGraph,
  computeGraphDigest,
} from '../execute/plan-task-graph';
import { canonicalStringify } from '../cli/proofloop-common';
import type { AcceptedPlanTaskGraph } from '../execute/plan-task-graph';
import type {
  MesFactKind,
  MesGitBasis,
  MesPlanBinding,
  MesScope,
  MesFactEnvelope,
} from './types';

export { SchemaValidationError };

/** Closed execution modes for fact binding (MES vs pre-seed bootstrap). */
export const MES_EXECUTION_MODES = ['NORMAL', 'PRE_MES_BOOTSTRAP'] as const;
export type MesExecutionMode = (typeof MES_EXECUTION_MODES)[number];

/**
 * The single canonical verifier role for pre-accept planning verification
 * (mes.md / contracts.md §2.2.2: `verifier_role: stage-plan-verifier`).
 * `planning_verification_result` facts must carry exactly this value; any
 * other non-empty string fails closed. Single schema owner = this module.
 */
export const MES_SPV_VERIFIER_ROLE = 'stage-plan-verifier' as const;

/** Fields a binding record may carry (closed set; unknown fails). */
const RECORD_KNOWN_FIELDS = new Set([
  'fact_kind',
  'execution_mode',
  'authority_refs',
  'scope',
  'work_id',
  'result_ref',
  'plan_binding',
  'git_basis',
  'verifier_role',
  'action_token',
]);

/** Fields a scope object may carry. */
const SCOPE_KNOWN_FIELDS = new Set(['stage_id', 'slice_id', 'task_id']);

/** Fields a git_basis object may carry. */
const GIT_BASIS_KNOWN_FIELDS = new Set(['head', 'branch', 'worktree']);

/** Fields a plan binding object may carry. */
const PLAN_BINDING_KNOWN_FIELDS = new Set([
  'binding_stage',
  'candidate_plan_ref',
  'accepted_plan_ref',
  'verdict',
  'source_candidate_plan_ref',
  'verification_result_ref',
  'plan_digest',
  'delivery_cycle_id',
]);

interface FieldError {
  path: string;
  message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectErrors(
  label: string,
  fn: (errors: FieldError[]) => unknown,
): unknown {
  const errors: FieldError[] = [];
  const result = fn(errors);
  if (errors.length > 0) {
    throw new SchemaValidationError(
      `${label} validation failed: ${errors
        .map((e) => `${e.path}: ${e.message}`)
        .join('; ')}`,
      errors,
    );
  }
  return result;
}

function checkUnknownFields(
  data: Record<string, unknown>,
  known: Set<string>,
  path: string,
  errors: FieldError[],
): void {
  for (const key of Object.keys(data)) {
    if (!known.has(key)) {
      errors.push({ path: `${path}.${key}`, message: `Unknown field "${key}"` });
    }
  }
}

function expectNonEmptyString(
  value: unknown,
  path: string,
  errors: FieldError[],
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push({
      path,
      message: `Expected non-empty string, got ${value === null ? 'null' : typeof value}`,
    });
    return undefined;
  }
  return value;
}

/**
 * Canonical root-relative Plan ref check (e.g. `delivery/stages/S01/plan.md`).
 * Rejects absolute paths, backslashes, NUL, Windows drive prefixes, empty
 * segments, `.` and `..` traversal segments (CV-S01-B-02).
 */
export function isCanonicalRootRelativeRef(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\u0000') ||
    value.startsWith('/') ||
    value.startsWith('//') ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/**
 * Canonical authority ref check: `<root-relative-path>#<section/entity>` where
 * the path part must itself be a canonical root-relative path (CV-S01-B-06).
 */
export function isCanonicalAuthorityRef(value: unknown): value is string {
  if (typeof value !== 'string' || !VNEXT_REF_GRAMMAR_RE.test(value)) return false;
  const hash = value.indexOf('#');
  const pathPart = hash === -1 ? '' : value.slice(0, hash);
  const sectionPart = hash === -1 ? '' : value.slice(hash + 1);
  return isCanonicalRootRelativeRef(pathPart) && sectionPart.length > 0;
}

/** Non-empty string + canonical root-relative Plan-ref check. */
function expectRootRelativePlanRef(
  value: unknown,
  path: string,
  errors: FieldError[],
): string | undefined {
  const ref = expectNonEmptyString(value, path, errors);
  if (ref !== undefined && !isCanonicalRootRelativeRef(ref)) {
    errors.push({
      path,
      message: 'Expected a canonical root-relative Plan ref (no absolute path, no .., no backslash, no empty segment)',
    });
  }
  return ref;
}

function expectObject(
  value: unknown,
  path: string,
  errors: FieldError[],
): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    errors.push({
      path,
      message: `Expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
    });
    return undefined;
  }
  return value;
}

/** Validate an optional scope object (canonical stage/slice/task shapes). */
function validateScopeInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): MesScope | undefined {
  const obj = expectObject(value, path, errors);
  if (!obj) return undefined;
  checkUnknownFields(obj, SCOPE_KNOWN_FIELDS, path, errors);
  const stageId = expectNonEmptyString(obj.stage_id, `${path}.stage_id`, errors);
  if (stageId !== undefined && !CANONICAL_STAGE_ID_RE.test(stageId)) {
    errors.push({
      path: `${path}.stage_id`,
      message: 'Expected a canonical Stage ID matching /^S\\d+$/, e.g. S01',
    });
  }
  if (obj.slice_id !== undefined) {
    const sliceId = expectNonEmptyString(obj.slice_id, `${path}.slice_id`, errors);
    if (sliceId !== undefined && !MES_SLICE_ID_RE.test(sliceId)) {
      errors.push({
        path: `${path}.slice_id`,
        message: 'Expected a canonical Slice ID shape like S01-A',
      });
    }
  }
  if (obj.task_id !== undefined) {
    const taskId = expectNonEmptyString(obj.task_id, `${path}.task_id`, errors);
    if (taskId !== undefined && !MES_TASK_ID_RE.test(taskId)) {
      errors.push({
        path: `${path}.task_id`,
        message: 'Expected a canonical Task ID shape like S01-A-T01',
      });
    }
  }
  return obj as unknown as MesScope;
}

/** Validate an optional git_basis object (head/branch/worktree). */
function validateGitBasisInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): MesGitBasis | undefined {
  const obj = expectObject(value, path, errors);
  if (!obj) return undefined;
  checkUnknownFields(obj, GIT_BASIS_KNOWN_FIELDS, path, errors);
  expectNonEmptyString(obj.head, `${path}.head`, errors);
  expectNonEmptyString(obj.branch, `${path}.branch`, errors);
  expectNonEmptyString(obj.worktree, `${path}.worktree`, errors);
  return obj as unknown as MesGitBasis;
}

/**
 * Validate a plan binding object against the variant closure:
 * candidate (pre-accept) vs accepted (promoted). A candidate binding must
 * keep `accepted_plan_ref: null`; an accepted binding must promote the same
 * candidate ref it references (`source_candidate_plan_ref` equality).
 */
function validatePlanBindingInto(
  value: unknown,
  path: string,
  errors: FieldError[],
): MesPlanBinding | undefined {
  const obj = expectObject(value, path, errors);
  if (!obj) return undefined;
  checkUnknownFields(obj, PLAN_BINDING_KNOWN_FIELDS, path, errors);

  const stage = obj.binding_stage;
  if (
    typeof stage !== 'string' ||
    !(MES_PLAN_BINDING_STAGES as readonly string[]).includes(stage)
  ) {
    errors.push({
      path: `${path}.binding_stage`,
      message: `Expected one of: ${MES_PLAN_BINDING_STAGES.map((s) => JSON.stringify(s)).join(', ')}`,
    });
    return obj as unknown as MesPlanBinding;
  }

  // Variant-specific field closure (mirrors the envelope validator).
  const candidateFields = new Set([
    'binding_stage',
    'candidate_plan_ref',
    'accepted_plan_ref',
    'verdict',
    'plan_digest',
    'delivery_cycle_id',
  ]);
  const acceptedFields = new Set([
    'binding_stage',
    'accepted_plan_ref',
    'source_candidate_plan_ref',
    'verification_result_ref',
    'plan_digest',
    'delivery_cycle_id',
  ]);
  checkUnknownFields(
    obj,
    stage === 'candidate' ? candidateFields : acceptedFields,
    path,
    errors,
  );

  if (obj.plan_digest !== undefined && !isSha256Hex(obj.plan_digest)) {
    errors.push({
      path: `${path}.plan_digest`,
      message: 'Expected 64-char lowercase hex SHA-256 digest',
    });
  }

  // (S05 runtime prereq) delivery_cycle_id is the closed opaque NORMAL
  // delivery-cycle identity (contracts §2.2.2 / mes.md / architecture
  // delivery-cycle-semantics). Optional at the schema level so legacy
  // retained plan bindings that lack it keep rehydrating byte-equivalently
  // as history-only without upgrade; when present it must be a non-empty
  // opaque string without control characters.
  if (obj.delivery_cycle_id !== undefined) {
    const cycle = obj.delivery_cycle_id;
    if (
      typeof cycle !== 'string' ||
      cycle.length === 0 ||
      /[\u0000-\u001f\u007f\u2028\u2029]/.test(cycle)
    ) {
      errors.push({
        path: `${path}.delivery_cycle_id`,
        message: 'delivery_cycle_id must be a non-empty opaque string without control characters',
      });
    }
  }

  if (stage === 'candidate') {
    expectRootRelativePlanRef(obj.candidate_plan_ref, `${path}.candidate_plan_ref`, errors);
    if (!('accepted_plan_ref' in obj) || obj.accepted_plan_ref !== null) {
      errors.push({
        path: `${path}.accepted_plan_ref`,
        message: 'candidate binding requires accepted_plan_ref to be present and null',
      });
    }
    const verdict = obj.verdict;
    if (
      typeof verdict !== 'string' ||
      !(MES_PLAN_VERDICTS as readonly string[]).includes(verdict)
    ) {
      errors.push({
        path: `${path}.verdict`,
        message: `Expected one of: ${MES_PLAN_VERDICTS.map((v) => JSON.stringify(v)).join(', ')}`,
      });
    }
  } else {
    const accepted = expectRootRelativePlanRef(obj.accepted_plan_ref, `${path}.accepted_plan_ref`, errors);
    const source = expectRootRelativePlanRef(obj.source_candidate_plan_ref, `${path}.source_candidate_plan_ref`, errors);
    if (accepted !== undefined && source !== undefined && accepted !== source) {
      errors.push({
        path: `${path}.source_candidate_plan_ref`,
        message: 'source_candidate_plan_ref must equal the promoted accepted_plan_ref',
      });
    }
    expectNonEmptyString(obj.verification_result_ref, `${path}.verification_result_ref`, errors);
  }

  return obj as unknown as MesPlanBinding;
}

/**
 * Machine-closed accepted `stage` support shape predicate (S04-A-T01).
 *
 * A `stage` fact carrying ANY accepted relation field — an accepted
 * plan_binding (`binding_stage: "accepted"`), a `result_ref` or a
 * `git_basis` — must carry the COMPLETE accepted support shape
 * (contracts.md §2.1.1 / §2.2): canonical Stage scope + accepted
 * plan_binding (root-relative accepted_plan_ref, source_candidate_plan_ref
 * equality, non-empty verification_result_ref) + git_basis + non-empty
 * result_ref (`created_by: brain` is enforced envelope-wide). Mixed /
 * partial shapes fail closed no-write; a pure scope-only stage fact stays
 * legal. Single owner = this module; the envelope validator reuses the
 * same predicate (no second Stage schema, no review_result_ref).
 *
 * @returns `undefined` when the shape closes, or a fail-closed message.
 */
export function acceptedStageSupportShapeError(record: {
  scope?: unknown;
  plan_binding?: unknown;
  result_ref?: unknown;
  git_basis?: unknown;
}): string | undefined {
  const binding = isObject(record.plan_binding)
    ? (record.plan_binding as Record<string, unknown>)
    : undefined;
  const hasAcceptedBinding = binding?.binding_stage === 'accepted';
  const hasResultRef = record.result_ref !== undefined;
  const hasGitBasis = record.git_basis !== undefined;
  // Pure scope-only stage facts (no accepted relation field) stay legal —
  // machine-closed presence predicate, not a label/heuristic.
  if (!hasAcceptedBinding && !hasResultRef && !hasGitBasis) return undefined;

  const scope = isObject(record.scope) ? record.scope : undefined;
  if (
    scope === undefined ||
    typeof scope.stage_id !== 'string' ||
    !CANONICAL_STAGE_ID_RE.test(scope.stage_id)
  ) {
    return 'stage fact with accepted support fields requires a canonical Stage scope (scope.stage_id matching /^S\\d+$/)';
  }
  if (!hasAcceptedBinding) {
    return 'stage fact with accepted support fields requires an accepted plan_binding (binding_stage: "accepted")';
  }
  const b = binding as Record<string, unknown>;
  if (typeof b.accepted_plan_ref !== 'string' || !isCanonicalRootRelativeRef(b.accepted_plan_ref)) {
    return 'accepted stage support requires a canonical root-relative accepted_plan_ref';
  }
  if (b.source_candidate_plan_ref !== b.accepted_plan_ref) {
    return 'accepted stage support requires source_candidate_plan_ref to equal the promoted accepted_plan_ref';
  }
  if (typeof b.verification_result_ref !== 'string' || b.verification_result_ref.length === 0) {
    return 'accepted stage support requires a non-empty verification_result_ref';
  }
  if (!hasGitBasis) {
    return 'stage fact with accepted support fields requires a git_basis';
  }
  // The per-fact Git basis of an accepted stage support must be the
  // complete closed shape (head/branch/worktree full set, head 40-hex,
  // worktree canonical root-relative with the trust-root `.` legal) —
  // presence alone is not a closed shape (CV S04-A-01).
  const basisShapeError = closedGitBasisShapeError(record.git_basis, 'accepted stage support');
  if (basisShapeError !== undefined) {
    return basisShapeError;
  }
  if (typeof record.result_ref !== 'string' || record.result_ref.length === 0) {
    return 'stage fact with accepted support fields requires a non-empty result_ref';
  }
  return undefined;
}

/**
 * Machine-closed per-fact Git basis shape for the `project_ready` terminal
 * fact (S04-A-T01 / closure item 4): head/branch/worktree full set, head
 * 40-char lowercase hex, branch non-empty, worktree canonical root-relative.
 * Each terminal fact carries its OWN verified basis — no cross-fact
 * equality is required (accepted-stage supports may carry different heads).
 *
 * @returns `undefined` when the basis closes, or a fail-closed message.
 */
/**
 * Shared closed per-fact Git basis shape (closure item 4): head/branch/
 * worktree full set, head 40-char lowercase hex, branch non-empty without
 * control characters, worktree canonical root-relative (the trust-root `.`
 * used by the durable S01/S02/S03 accepted stage facts is legal; traversal
 * / absolute / backslash / control-char forms fail closed). Every durable
 * fact carries its OWN verified basis — no cross-fact equality required.
 *
 * @returns `undefined` when the basis closes, or a fail-closed message.
 */
function closedGitBasisShapeError(basis: unknown, label: string): string | undefined {
  if (!isObject(basis)) {
    return `${label} requires a git_basis (head/branch/worktree full set)`;
  }
  if (typeof basis.head !== 'string' || !/^[0-9a-f]{40}$/.test(basis.head)) {
    return `${label} git_basis.head must be a 40-char lowercase hex commit SHA`;
  }
  // Control characters (C0, DEL, U+2028/U+2029) fail closed: the closed
  // per-fact basis must never smuggle injection into a durable fact.
  if (typeof basis.branch !== 'string' || basis.branch.length === 0 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(basis.branch)) {
    return `${label} git_basis.branch must be a non-empty string without control characters`;
  }
  if (typeof basis.worktree !== 'string' || /[\u0000-\u001f\u007f\u2028\u2029]/.test(basis.worktree)) {
    return `${label} git_basis.worktree must be a canonical root-relative path without control characters`;
  }
  // `.` (the trust root itself) and root-relative worktrees
  // (`.proofloop/worktrees/...`) are both legal.
  if (basis.worktree !== '.' && !isCanonicalRootRelativeRef(basis.worktree)) {
    return `${label} git_basis.worktree must be a canonical root-relative path`;
  }
  return undefined;
}

export function projectReadyClosedGitBasisError(basis: unknown): string | undefined {
  return closedGitBasisShapeError(basis, 'project_ready');
}

/**
 * Kind/mode binding rules:
 *  - `plan_binding` fact requires a plan_binding value;
 *  - execution-bound facts (`work` / `result` / `git`) require a canonical
 *    stage scope, and then diverge by mode:
 *    - NORMAL binds an accepted Plan + MES work identity (work/result) +
 *      durable refs (result) + Git basis;
 *    - PRE_MES_BOOTSTRAP must not carry a pre-seed MES work identity or
 *      resultRef, and always binds a Git basis (Link evidence is Git-bound).
 */
function validateKindModeRules(
  kind: MesFactKind,
  mode: MesExecutionMode,
  record: Record<string, unknown>,
  errors: FieldError[],
): void {
  // verifier_role / action_token are planning-verification-scoped fields:
  // every other fact kind carrying them fails closed.
  if (kind !== 'planning_verification_result') {
    if (record.verifier_role !== undefined) {
      errors.push({
        path: 'verifier_role',
        message: 'verifier_role is only valid on planning_verification_result facts',
      });
    }
    if (record.action_token !== undefined) {
      errors.push({
        path: 'action_token',
        message: 'action_token is only valid on planning_verification_result facts',
      });
    }
  }
  if (kind === 'plan_binding') {
    if (record.plan_binding === undefined) {
      errors.push({ path: 'plan_binding', message: 'plan_binding fact requires a plan_binding value' });
    }
    return;
  }

  // NORMAL planning durable facts (contracts.md §2.2.2 / mes.md Planning
  // durable facts): pre-accept verification binds a candidate plan and
  // carries its machinery; acceptance binds the promoted accepted plan.
  const planningKind =
    kind === 'planning_verification_result' || kind === 'plan_acceptance';
  if (planningKind) {
    if (mode !== 'NORMAL') {
      errors.push({
        path: 'execution_mode',
        message: `${kind} is a NORMAL-only durable fact (PRE_MES_BOOTSTRAP never writes it)`,
      });
    }
    const binding = isObject(record.plan_binding)
      ? (record.plan_binding as MesPlanBinding)
      : undefined;
    if (kind === 'planning_verification_result') {
      if (binding === undefined || binding.binding_stage !== 'candidate') {
        errors.push({
          path: 'plan_binding',
          message:
            'planning_verification_result fact must bind a candidate Plan (binding_stage: "candidate", accepted_plan_ref: null)',
        });
      }
      if (record.work_id === undefined) {
        errors.push({
          path: 'work_id',
          message: `planning_verification_result fact requires a MES planning work identity (work_id)`,
        });
      }
      if (record.result_ref === undefined) {
        errors.push({
          path: 'result_ref',
          message: 'planning_verification_result fact requires a durable result_ref',
        });
      }
      if (record.verifier_role === undefined) {
        errors.push({
          path: 'verifier_role',
          message: 'planning_verification_result fact requires a verifier_role',
        });
      } else if (record.verifier_role !== MES_SPV_VERIFIER_ROLE) {
        errors.push({
          path: 'verifier_role',
          message: `planning_verification_result fact verifier_role must be exactly ${JSON.stringify(MES_SPV_VERIFIER_ROLE)} (got ${JSON.stringify(record.verifier_role)})`,
        });
      }
      if (record.action_token === undefined) {
        errors.push({
          path: 'action_token',
          message: 'planning_verification_result fact requires an action_token',
        });
      }
    } else {
      if (binding === undefined || binding.binding_stage !== 'accepted') {
        errors.push({
          path: 'plan_binding',
          message: 'plan_acceptance fact must bind an accepted Plan (binding_stage: "accepted")',
        });
      }
    }
    if (record.git_basis === undefined) {
      errors.push({ path: 'git_basis', message: `${kind} fact requires a git_basis` });
    }
    // (S05 runtime prereq) NORMAL PVR/PA carry BOTH a stage-only scope and a
    // closed plan_binding.delivery_cycle_id (contracts §2.2.2 / mes.md /
    // architecture delivery-cycle-semantics); the pair rule mirrors the
    // envelope validator. Either half alone is a half-new shape and fails
    // closed; the fully legacy shape (neither field) stays legal.
    const planningScope = isObject(record.scope) ? record.scope : undefined;
    const planningBinding = isObject(record.plan_binding) ? record.plan_binding : undefined;
    const hasCycle = planningBinding !== undefined && planningBinding.delivery_cycle_id !== undefined;
    const hasStageScope = planningScope !== undefined && typeof planningScope.stage_id === 'string';
    if (hasCycle) {
      if (!hasStageScope) {
        errors.push({
          path: 'scope',
          message: `${kind} fact carrying plan_binding.delivery_cycle_id requires a canonical stage-only scope.stage_id (new NORMAL PVR/PA shape)`,
        });
      } else if (planningScope.slice_id !== undefined || planningScope.task_id !== undefined) {
        errors.push({
          path: 'scope',
          message: `${kind} fact carrying a delivery cycle must use a stage-only scope (no slice_id / task_id)`,
        });
      }
    } else if (hasStageScope) {
      errors.push({
        path: 'plan_binding.delivery_cycle_id',
        message: `${kind} fact carrying scope.stage_id requires a closed non-empty plan_binding.delivery_cycle_id (new NORMAL PVR/PA shape)`,
      });
    }
    return;
  }

  if (kind === 'project_ready') {
    // Terminal fact (contracts.md §5.1 / acceptance E2E-06): NORMAL-only
    // durable fact — PRE_MES_BOOTSTRAP never writes a second operational
    // store (STATIC-13/14).
    if (mode !== 'NORMAL') {
      errors.push({
        path: 'execution_mode',
        message: 'project_ready is a NORMAL-only durable fact (PRE_MES_BOOTSTRAP never writes it)',
      });
    }
    // Terminal facts do NOT inherit unrelated Stage/Work/Result binding
    // (E2E-06): scope / work_id / result_ref / plan_binding present fail
    // closed. verifier_role / action_token are already rejected globally.
    if (record.scope !== undefined) {
      errors.push({ path: 'scope', message: 'project_ready terminal fact must not carry a Stage/Work/Result scope (E2E-06)' });
    }
    if (record.work_id !== undefined) {
      errors.push({ path: 'work_id', message: 'project_ready terminal fact must not inherit a MES work identity (E2E-06)' });
    }
    if (record.result_ref !== undefined) {
      errors.push({ path: 'result_ref', message: 'project_ready terminal fact must not carry a durable result_ref (E2E-06)' });
    }
    if (record.plan_binding !== undefined) {
      errors.push({ path: 'plan_binding', message: 'project_ready terminal fact must not bind a Plan (E2E-06)' });
    }
    // Per-fact Git basis is the complete closed shape (missing / partial
    // basis fails closed no-write; each fact carries its own verified basis).
    const basisError = projectReadyClosedGitBasisError(record.git_basis);
    if (basisError !== undefined) {
      errors.push({ path: 'git_basis', message: basisError });
    }
    // authority_refs must be canonical tech-spec refs (non-empty is already
    // enforced record-wide); the envelope path enforces the same closure.
    if (Array.isArray(record.authority_refs)) {
      for (let i = 0; i < record.authority_refs.length; i++) {
        const ref = record.authority_refs[i];
        if (typeof ref !== 'string' || !isCanonicalAuthorityRef(ref) || !ref.startsWith('tech-spec/')) {
          errors.push({
            path: `authority_refs[${i}]`,
            message:
              'project_ready authority_refs must be canonical tech-spec refs (e.g. tech-spec/contracts.md#5.1)',
          });
        }
      }
    }
    return;
  }
  if (kind === 'stage') {
    const scope = isObject(record.scope) ? record.scope : undefined;
    if (scope === undefined || typeof scope.stage_id !== 'string') {
      errors.push({ path: 'scope.stage_id', message: 'stage fact requires a canonical stage scope' });
    }
    // Accepted `stage` support shape all-or-nothing (contracts.md §2.1.1):
    // any accepted relation field without the complete shape fails closed.
    const supportShapeError = acceptedStageSupportShapeError(record);
    if (supportShapeError !== undefined) {
      errors.push({ path: 'stage_support_shape', message: supportShapeError });
    }
    return;
  }

  // S03-A-T01 Execute kinds: task / finding / finding_disposition are NORMAL
  // MES operational facts (contracts.md §2.2.3 dispositions are NORMAL; §5.1
  // task status facts are MES operational; STATIC-14: bootstrap never writes
  // a second operational store). Candidate can NEVER substitute accepted;
  // task/finding carry a MES work identity, finding_disposition is
  // Brain-owned arbitration without a dispatch work.
  const newExecuteKinds =
    kind === 'task' || kind === 'finding' || kind === 'finding_disposition';
  if (newExecuteKinds) {
    if (mode !== 'NORMAL') {
      errors.push({
        path: 'execution_mode',
        message: `${kind} is a NORMAL-only durable fact (PRE_MES_BOOTSTRAP never writes it)`,
      });
    }
    const scope = isObject(record.scope) ? record.scope : undefined;
    if (scope === undefined || typeof scope.stage_id !== 'string') {
      errors.push({ path: 'scope.stage_id', message: `${kind} fact requires a canonical stage scope` });
    }
    const binding = isObject(record.plan_binding) ? (record.plan_binding as MesPlanBinding) : undefined;
    if (binding === undefined || binding.binding_stage !== 'accepted') {
      errors.push({
        path: 'plan_binding',
        message: `${kind} fact must bind an accepted Plan (binding_stage: "accepted"; candidate cannot substitute accepted)`,
      });
    }
    if (record.git_basis === undefined) {
      errors.push({ path: 'git_basis', message: `${kind} fact requires a git_basis` });
    }
    if ((kind === 'task' || kind === 'finding') && record.work_id === undefined) {
      errors.push({ path: 'work_id', message: `${kind} fact requires a MES work identity (work_id)` });
    }
    return;
  }

  const executionBound = kind === 'work' || kind === 'result' || kind === 'git';
  if (!executionBound) return;
  // Fail closed (CV S01-STAGE-REVIEW-F001): null / non-object scope and
  // plan_binding must never reach property access — a raw TypeError would
  // bypass the canonical SchemaValidationError. The nested shape error is
  // already reported by validateScopeInto / validatePlanBindingInto above,
  // so treat non-object values as absent here and let the kind/mode rules
  // emit their own fail-closed errors.
  const scope = isObject(record.scope) ? record.scope : undefined;
  if (scope === undefined || typeof scope.stage_id !== 'string') {
    errors.push({ path: 'scope.stage_id', message: `${kind} fact requires a canonical stage scope` });
  }

  const binding = isObject(record.plan_binding) ? (record.plan_binding as MesPlanBinding) : undefined;

  if (mode === 'NORMAL') {
    if (binding === undefined || binding.binding_stage !== 'accepted') {
      errors.push({
        path: 'plan_binding',
        message: `NORMAL ${kind} fact must bind an accepted Plan (binding_stage: "accepted")`,
      });
    }
    if (record.git_basis === undefined) {
      errors.push({ path: 'git_basis', message: `NORMAL ${kind} fact requires a git_basis` });
    }
    if ((kind === 'work' || kind === 'result') && record.work_id === undefined) {
      errors.push({ path: 'work_id', message: `NORMAL ${kind} fact requires a MES work identity (work_id)` });
    }
    if (kind === 'result' && record.result_ref === undefined) {
      errors.push({ path: 'result_ref', message: 'result fact requires a durable result_ref' });
    }
    return;
  }

  // PRE_MES_BOOTSTRAP: Git-tracked Link evidence — every execution-bound
  // fact must carry a valid candidate/accepted Git Plan binding, the nested
  // binding refs must not point to a pre-seed MES resultRef (CV-S01-B-05),
  // and the Git basis stays mandatory.
  if (
    binding === undefined ||
    (binding.binding_stage !== 'candidate' && binding.binding_stage !== 'accepted')
  ) {
    errors.push({
      path: 'plan_binding',
      message: `PRE_MES_BOOTSTRAP ${kind} fact must bind a candidate or accepted Git Plan (plan_binding)`,
    });
  }
  if (binding !== undefined && binding.binding_stage === 'accepted' && binding.verification_result_ref !== undefined) {
    // A pre-seed MES ref (e.g. `mes:result:...` / `mes:verification:...`)
    // is never valid bootstrap evidence: bootstrap verification refs are
    // Git-bound (CV-S01-B-05).
    if (/^mes:/.test(binding.verification_result_ref)) {
      errors.push({
        path: 'plan_binding.verification_result_ref',
        message: `PRE_MES_BOOTSTRAP verification_result_ref must not point to a pre-seed MES ref (got ${binding.verification_result_ref})`,
      });
    }
  }
  if (record.work_id !== undefined) {
    errors.push({
      path: 'work_id',
      message: 'PRE_MES_BOOTSTRAP must not carry a pre-seed MES work identity',
    });
  }
  if (record.result_ref !== undefined) {
    errors.push({
      path: 'result_ref',
      message: 'PRE_MES_BOOTSTRAP must not carry a MES resultRef (Link evidence only)',
    });
  }
  if (record.git_basis === undefined) {
    errors.push({ path: 'git_basis', message: `PRE_MES_BOOTSTRAP ${kind} fact requires a git_basis` });
  }
}

/**
 * Fail-closed validation of a fact-kind binding record.
 *
 * @returns the validated, typed binding record.
 * @throws {SchemaValidationError} on any violation (RUNTIME.SCHEMA_MISMATCH).
 */
export function validateMesFactBinding(value: unknown): MesFactBindRecord {
  return collectErrors('MesFactBindRecord', (errors) => {
    const obj = expectObject(value, 'binding_record', errors);
    if (!obj) return undefined;

    checkUnknownFields(obj, RECORD_KNOWN_FIELDS, 'binding_record', errors);

    const kind = obj.fact_kind;
    if (
      typeof kind !== 'string' ||
      !(MES_FACT_KINDS as readonly string[]).includes(kind)
    ) {
      errors.push({
        path: 'binding_record.fact_kind',
        message: `Expected one of: ${MES_FACT_KINDS.map((k) => JSON.stringify(k)).join(', ')}`,
      });
      return obj as unknown as MesFactBindRecord;
    }

    const mode = obj.execution_mode;
    if (
      typeof mode !== 'string' ||
      !(MES_EXECUTION_MODES as readonly string[]).includes(mode)
    ) {
      errors.push({
        path: 'binding_record.execution_mode',
        message: `Expected one of: ${MES_EXECUTION_MODES.map((m) => JSON.stringify(m)).join(', ')}`,
      });
      return obj as unknown as MesFactBindRecord;
    }

    const authorityRefs = obj.authority_refs;
    if (!Array.isArray(authorityRefs) || authorityRefs.length === 0) {
      errors.push({ path: 'binding_record.authority_refs', message: 'Expected a non-empty array of canonical refs' });
    } else {
      for (let i = 0; i < authorityRefs.length; i++) {
        if (!isCanonicalAuthorityRef(authorityRefs[i])) {
          errors.push({
            path: `binding_record.authority_refs[${i}]`,
            message: 'Expected canonical entity ref with a root-relative path: "<path>#<section/entity>"',
          });
        }
      }
    }

    if (obj.scope !== undefined) {
      validateScopeInto(obj.scope, 'binding_record.scope', errors);
    }
    if (obj.work_id !== undefined) {
      expectNonEmptyString(obj.work_id, 'binding_record.work_id', errors);
    }
    if (obj.result_ref !== undefined) {
      expectNonEmptyString(obj.result_ref, 'binding_record.result_ref', errors);
    }
    if (obj.verifier_role !== undefined) {
      expectNonEmptyString(obj.verifier_role, 'binding_record.verifier_role', errors);
    }
    if (obj.action_token !== undefined) {
      expectNonEmptyString(obj.action_token, 'binding_record.action_token', errors);
    }
    if (obj.plan_binding !== undefined) {
      validatePlanBindingInto(obj.plan_binding, 'binding_record.plan_binding', errors);
    }
    if (obj.git_basis !== undefined) {
      validateGitBasisInto(obj.git_basis, 'binding_record.git_basis', errors);
    }

    validateKindModeRules(kind as MesFactKind, mode as MesExecutionMode, obj, errors);

    return obj as unknown as MesFactBindRecord;
  }) as MesFactBindRecord;
}

/** Promotion input: a candidate binding + the PLAN_READY verification ref. */
export interface PlanReadyPromotionInput {
  readonly candidate: MesPlanBinding;
  readonly verification_result_ref: string;
}

/**
 * Promote a `PLAN_READY` candidate into an accepted Plan binding.
 *
 * Fail-closed promotion gate (contracts.md §2.2.2): only a candidate with
 * `verdict: "PLAN_READY"` may be promoted; FINDINGS / BLOCKED can never
 * produce an acceptance, and an already-accepted binding is not promotion
 * input. The promoted accepted binding keeps the same candidate ref.
 *
 * @throws {SchemaValidationError} when the input is not a PLAN_READY
 * candidate or the verification result ref is missing.
 */
export function promotePlanReadyToAccepted(
  input: PlanReadyPromotionInput,
): MesPlanBinding {
  return collectErrors('PromotionInput', (errors) => {
    const obj = expectObject(input as unknown, 'promotion_input', errors);
    if (!obj) return undefined;
    // CV-S01-B-07: closed promotion input — reject unknown top-level fields.
    checkUnknownFields(obj, new Set(['candidate', 'verification_result_ref']), 'promotion_input', errors);
    const candidate = validatePlanBindingInto(
      input.candidate as unknown,
      'promotion_input.candidate',
      errors,
    );
    const verification = expectNonEmptyString(
      input.verification_result_ref,
      'promotion_input.verification_result_ref',
      errors,
    );

    if (candidate !== undefined) {
      if (candidate.binding_stage !== 'candidate') {
        errors.push({
          path: 'promotion_input.candidate.binding_stage',
          message: 'only a candidate binding is promotion input (accepted bindings are not promotable)',
        });
      } else if (candidate.verdict !== 'PLAN_READY') {
        errors.push({
          path: 'promotion_input.candidate.verdict',
          message: `only a PLAN_READY candidate can be promoted, got ${JSON.stringify(candidate.verdict)}`,
        });
      }
    }

    if (errors.length > 0) return undefined;

    // At this point candidate is a validated PLAN_READY candidate; only the
    // candidate variant carries candidate_plan_ref / plan_digest.
    const verifiedCandidate = candidate as MesPlanBinding & {
      binding_stage: 'candidate';
    };
    const accepted: MesPlanBinding = {
      binding_stage: 'accepted',
      accepted_plan_ref: verifiedCandidate.candidate_plan_ref,
      source_candidate_plan_ref: verifiedCandidate.candidate_plan_ref,
      verification_result_ref: verification!,
      ...(verifiedCandidate.plan_digest !== undefined
        ? { plan_digest: verifiedCandidate.plan_digest }
        : {}),
      ...(verifiedCandidate.delivery_cycle_id !== undefined
        ? { delivery_cycle_id: verifiedCandidate.delivery_cycle_id }
        : {}),
    };
    return accepted;
  }) as MesPlanBinding;
}

/**
 * Relational closure for a durable `plan_acceptance` fact (S02-SR-F001).
 *
 * The acceptance's `plan_binding.verification_result_ref` must resolve to a
 * real, re-readable PLAN_READY `planning_verification_result` fact in the SAME
 * durable snapshot (mes.md / contracts.md §2.2.2): the support fact is either
 * part of the submitted fact set or already persisted in the current valid
 * snapshot. The relation closes only when:
 *
 *   - the support fact kind is `planning_verification_result`, binds a
 *     candidate Plan (`binding_stage: "candidate"`) and carries verdict
 *     `PLAN_READY` (FINDINGS / BLOCKED can never underpin an acceptance);
 *   - the support's own durable `result_ref` equals the referenced ref and
 *     the verification/acceptance agree on the promoted candidate/accepted
 *     plan ref (`accepted_plan_ref === source_candidate_plan_ref ===
 *     candidate_plan_ref`) and on `plan_digest` when present;
 *   - both facts carry the same verified Git basis (`git_basis.head` exact
 *     equality — the contract's same-basis requirement).
 *
 * No MES status, Agent narrative, Link metadata, pane/session state or hidden
 * conversation is ever consulted to close the relation.
 *
 * @returns `undefined` when the relation closes, or a fail-closed message
 * (the caller wraps it into its typed no-write error before snapshot
 * replacement).
 */
export function verifyPlanAcceptanceSupport(
  acceptance: MesFactEnvelope,
  support: MesFactEnvelope | undefined,
): string | undefined {
  const binding = acceptance.plan_binding;
  // Defensive: envelope validation already guarantees the accepted variant
  // here; a non-object / malformed binding must fail closed via the typed
  // relational gate, never surface a raw TypeError.
  if (!binding || binding.binding_stage !== 'accepted') {
    return 'plan_acceptance fact must bind an accepted Plan for relational closure';
  }
  const referencedRef = binding.verification_result_ref;
  if (support === undefined) {
    return `plan_acceptance verification_result_ref ${JSON.stringify(referencedRef)} does not resolve to a durable planning_verification_result fact in the submitted set or current valid snapshot`;
  }
  if (support.fact_kind !== 'planning_verification_result') {
    return `plan_acceptance verification_result_ref ${JSON.stringify(referencedRef)} resolves to fact ${JSON.stringify(support.fact_id)} with kind ${JSON.stringify(support.fact_kind)} — expected planning_verification_result`;
  }
  const supportBinding = support.plan_binding;
  if (!supportBinding || supportBinding.binding_stage !== 'candidate') {
    return `supporting fact ${JSON.stringify(support.fact_id)} must bind a candidate Plan (binding_stage: "candidate", accepted_plan_ref: null)`;
  }
  if (supportBinding.verdict !== 'PLAN_READY') {
    return `supporting fact ${JSON.stringify(support.fact_id)} verdict is ${JSON.stringify(supportBinding.verdict)} — only a PLAN_READY planning_verification_result can underpin a plan_acceptance`;
  }
  if (support.result_ref !== referencedRef) {
    return `supporting fact ${JSON.stringify(support.fact_id)} result_ref ${JSON.stringify(support.result_ref)} must exactly equal the referenced verification_result_ref ${JSON.stringify(referencedRef)}`;
  }
  if (binding.accepted_plan_ref !== supportBinding.candidate_plan_ref) {
    return `plan_acceptance accepted_plan_ref ${JSON.stringify(binding.accepted_plan_ref)} must equal the supporting verification candidate_plan_ref ${JSON.stringify(supportBinding.candidate_plan_ref)}`;
  }
  if (binding.source_candidate_plan_ref !== supportBinding.candidate_plan_ref) {
    return `plan_acceptance source_candidate_plan_ref ${JSON.stringify(binding.source_candidate_plan_ref)} must equal the supporting verification candidate_plan_ref ${JSON.stringify(supportBinding.candidate_plan_ref)}`;
  }
  if ((binding.plan_digest ?? undefined) !== (supportBinding.plan_digest ?? undefined)) {
    return `plan_acceptance and supporting verification must agree on plan_digest (acceptance ${JSON.stringify(binding.plan_digest ?? null)} vs verification ${JSON.stringify(supportBinding.plan_digest ?? null)})`;
  }
  if ((acceptance.git_basis?.head ?? undefined) !== (support.git_basis?.head ?? undefined)) {
    return `plan_acceptance git_basis.head ${JSON.stringify(acceptance.git_basis?.head ?? null)} must equal the supporting verification git_basis.head ${JSON.stringify(support.git_basis?.head ?? null)} (same verified candidate basis)`;
  }
  // (S05 runtime prereq) PVR->PA cycle closure: the acceptance and its
  // supporting verification must carry the SAME delivery_cycle_id whenever
  // either carries one (contracts §2.2.2 / architecture
  // delivery-cycle-semantics "Cross-fact cycle equality is a write
  // invariant"). Legacy history-only facts lacking the field relate under
  // the pre-cycle rules only and can never underpin a cycle-scoped
  // acceptance.
  const acceptanceCycle = binding.delivery_cycle_id ?? undefined;
  const supportCycle = supportBinding.delivery_cycle_id ?? undefined;
  if (acceptanceCycle !== supportCycle) {
    return `plan_acceptance and supporting verification must carry the same delivery_cycle_id (acceptance ${JSON.stringify(acceptanceCycle ?? null)} vs verification ${JSON.stringify(supportCycle ?? null)})`;
  }
  return undefined;
}

/**
 * Relational closure for an accepted `stage` fact and its Review `result`
 * (S05-A-T02 / PO-S05-A-02, contracts.md §2.1.1 review-result-contract +
 * architecture delivery-cycle-semantics "Scope-role closure is normative").
 *
 * The accepted stage's `result_ref` must exact-resolve to a durable
 * Review-owned `result` fact in the SAME persisted snapshot (submitted ∪
 * retained facts) that:
 *   - is fact_kind "result" (cross-kind facts never masquerade);
 *   - carries a stage-only scope (scope.stage_id canonical, no
 *     slice_id/task_id) — under an accepted Plan a stage-only
 *     work/result/finding is Review-owned durable output, while
 *     Execute-owned facts MUST carry slice_id or task_id, so an
 *     execute/generic/opaque result can never underpin an accepted stage
 *     even with the same delivery_cycle_id (scope-role closure /
 *     review-result-contract);
 *   - binds the SAME accepted Plan (accepted_plan_ref equality +
 *     plan_digest agreement when present);
 *   - carries the SAME delivery_cycle_id as the stage whenever either
 *     carries one (cross-fact cycle equality is a write invariant; legacy
 *     history-only facts lacking the field relate under the pre-cycle
 *     rules only).
 *
 * Each durable fact keeps its OWN git_basis (never compared across facts);
 * the relation closes by stage + kind + scope-role + accepted Plan + cycle
 * identity only.
 *
 * @returns `undefined` when the relation closes, or a fail-closed message.
 */
export function verifyAcceptedStageReviewResultSupport(
  stage: MesFactEnvelope,
  result: MesFactEnvelope | undefined,
): string | undefined {
  const stageBinding = stage.plan_binding;
  if (!stageBinding || stageBinding.binding_stage !== 'accepted') {
    return 'accepted stage fact must bind an accepted Plan for review-result closure';
  }
  const referencedRef = stage.result_ref;
  if (typeof referencedRef !== 'string' || referencedRef.length === 0) {
    return 'accepted stage fact requires a non-empty result_ref for review-result closure';
  }
  if (result === undefined) {
    return `accepted stage result_ref ${JSON.stringify(referencedRef)} does not resolve to a durable Review-owned result fact in the submitted set or current valid snapshot`;
  }
  if (result.fact_kind !== 'result') {
    return `accepted stage result_ref ${JSON.stringify(referencedRef)} resolves to fact ${JSON.stringify(result.fact_id)} with kind ${JSON.stringify(result.fact_kind)} — expected a Review-owned result`;
  }
  // Scope-role closure (review-result-contract / architecture
  // delivery-cycle-semantics): a Review-owned result is stage-only scope.
  const resultScope = isObject(result.scope) ? result.scope : undefined;
  if (
    resultScope === undefined ||
    typeof resultScope.stage_id !== 'string' ||
    !CANONICAL_STAGE_ID_RE.test(resultScope.stage_id)
  ) {
    return `supporting result ${JSON.stringify(result.fact_id)} must carry a canonical stage-only scope (scope.stage_id matching /^S\\d+$/) — Review-owned only`;
  }
  if (resultScope.slice_id !== undefined || resultScope.task_id !== undefined) {
    return `supporting result ${JSON.stringify(result.fact_id)} is execute-owned (scope carries slice_id/task_id) — execute/generic/opaque results cannot masquerade as the Review result, even with the same delivery_cycle_id (scope-role closure / review-result-contract)`;
  }
  const stageScope = isObject(stage.scope) ? stage.scope : undefined;
  if (stageScope === undefined || stageScope.stage_id !== resultScope.stage_id) {
    return `accepted stage scope.stage_id ${JSON.stringify(stageScope?.stage_id ?? null)} must equal the Review result scope.stage_id ${JSON.stringify(resultScope.stage_id)}`;
  }
  if (result.result_ref !== referencedRef) {
    return `supporting result ${JSON.stringify(result.fact_id)} result_ref ${JSON.stringify(result.result_ref)} must exactly equal the accepted stage referenced result_ref ${JSON.stringify(referencedRef)}`;
  }
  const resultBinding = result.plan_binding;
  if (!resultBinding || resultBinding.binding_stage !== 'accepted') {
    return `supporting result ${JSON.stringify(result.fact_id)} must bind an accepted Plan (binding_stage: "accepted")`;
  }
  if (resultBinding.accepted_plan_ref !== stageBinding.accepted_plan_ref) {
    return `accepted stage accepted_plan_ref ${JSON.stringify(stageBinding.accepted_plan_ref)} must equal the Review result accepted_plan_ref ${JSON.stringify(resultBinding.accepted_plan_ref)} (same accepted Plan)`;
  }
  if ((resultBinding.plan_digest ?? undefined) !== (stageBinding.plan_digest ?? undefined)) {
    return `accepted stage and Review result must agree on plan_digest (stage ${JSON.stringify(stageBinding.plan_digest ?? null)} vs result ${JSON.stringify(resultBinding.plan_digest ?? null)})`;
  }
  // (S05-A-T02) Cross-fact cycle equality (contracts §2.2.2 / architecture
  // delivery-cycle-semantics "Cross-fact cycle equality is a write
  // invariant"): the accepted stage and its Review result must carry the
  // SAME delivery_cycle_id whenever either carries one. Legacy history-only
  // facts lacking the field relate under the pre-cycle rules only and can
  // never underpin a cycle-scoped accepted stage.
  const stageCycle = stageBinding.delivery_cycle_id ?? undefined;
  const resultCycle = resultBinding.delivery_cycle_id ?? undefined;
  if (stageCycle !== resultCycle) {
    return `accepted stage and its Review result must carry the same delivery_cycle_id (stage ${JSON.stringify(stageCycle ?? null)} vs result ${JSON.stringify(resultCycle ?? null)})`;
  }
  return undefined;
}

/** A validated fact-kind binding record. */
export interface MesFactBindRecord {
  readonly fact_kind: MesFactKind;
  readonly execution_mode: MesExecutionMode;
  readonly authority_refs: string[];
  readonly scope?: MesScope;
  readonly work_id?: string;
  readonly result_ref?: string;
  readonly plan_binding?: MesPlanBinding;
  readonly git_basis?: MesGitBasis;
  readonly verifier_role?: string;
  readonly action_token?: string;
}

/**
 * Closed task-scope consistency check (S03-STAGE-REVIEW-F001): the
 * stage/slice DERIVED from the canonical task_id must exactly equal the task
 * fact's own scope.stage_id / scope.slice_id. A cross-stage/cross-slice task
 * fact (e.g. a task id S03-B-T01 that IS part of the accepted S03 plan graph
 * but scoped to stage S02 / slice S02-A) passes the phantom-task check — the
 * canonical id is genuinely in the graph — so it is rejected HERE: overloaded
 * task facts can never claim a foreign stage/slice scope. Both the graph
 * binding validator and the MesSnapshotStore durable write-through enforce
 * this single helper before any file is touched (no-write).
 *
 * @returns `undefined` when the scope is consistent, or a fail-closed
 *   message when the task_id-derived stage/slice contradicts the fact scope.
 */
export function taskFactScopeConsistencyError(fact: MesFactEnvelope): string | undefined {
  const scope = isObject(fact.scope) ? fact.scope : undefined;
  const taskId = scope?.task_id;
  if (scope === undefined || typeof taskId !== 'string') {
    return 'task fact requires a canonical task_id scope for graph binding';
  }
  const derivedStage = taskId.slice(0, taskId.indexOf('-'));
  const derivedSlice = taskId.slice(0, taskId.lastIndexOf('-'));
  if (scope.stage_id !== derivedStage || scope.slice_id !== derivedSlice) {
    return `task fact scope stage/slice (${JSON.stringify(scope.stage_id)}/${JSON.stringify(scope.slice_id)}) must equal the task_id-derived ${JSON.stringify(derivedStage)}/${JSON.stringify(derivedSlice)} (cross-stage/slice task facts rejected no-write)`;
  }
  return undefined;
}

/**
 * Task-kind graph binding validation (S03-A-T01). The MES snapshot store
 * forwards the brand-bound accepted_plan_task_graph capability here BEFORE
 * any durable write: plain JSON / deserialized / caller-built / phantom
 * graphs fail closed on the brand first, then closed shape, then
 * accepted_plan_ref / accepted_plan_digest equality with the fact binding,
 * graph_digest recomputation (SHA-256(SPN({task_ids ascending, edges
 * serialized sorted}))), the fact task must exist in the graph (phantom
 * task ids rejected), the FACT SCOPE must be task_id-consistent
 * (S03-STAGE-REVIEW-F001: the task_id-derived stage/slice must equal the
 * fact scope.stage_id / scope.slice_id — a cross-stage/slice task fact
 * would otherwise pass the phantom check because its canonical task id IS
 * part of the accepted plan graph), fact.depends_on_task_ids must EQUAL
 * the dependency edge set of the fact task (missing/extra edges rejected),
 * and
 * blocked_by_task_id must be a real accepted-plan dependency of the task.
 *
 * @returns `undefined` when the graph binding closes, or a fail-closed
 *   message (the caller wraps it into its typed no-write error before any
 *   snapshot replacement).
 */
export function validateTaskFactGraphBinding(
  fact: MesFactEnvelope,
  graph: unknown,
): string | undefined {
  if (!isAcceptedPlanTaskGraph(graph)) {
    return 'accepted_plan_task_graph must be the opaque capability minted by packages/runtime/src/execute/plan-task-graph.ts (brand-provenance check via isAcceptedPlanTaskGraph)';
  }
  const g = graph as unknown as AcceptedPlanTaskGraph;
  if (
    typeof g.accepted_plan_ref !== 'string' ||
    typeof g.accepted_plan_digest !== 'string' ||
    typeof g.graph_digest !== 'string' ||
    !Array.isArray(g.task_ids) ||
    !Array.isArray(g.edges)
  ) {
    return 'accepted_plan_task_graph does not match the closed capability shape';
  }
  for (const edge of g.edges) {
    if (
      !isObject(edge) ||
      typeof edge.from !== 'string' ||
      typeof edge.to !== 'string' ||
      (edge.kind !== 'dependency' && edge.kind !== 'blocked_by')
    ) {
      return 'accepted_plan_task_graph contains a malformed edge';
    }
  }
  const binding = fact.plan_binding;
  if (!binding || binding.binding_stage !== 'accepted') {
    return 'task fact must bind an accepted Plan for graph binding';
  }
  if (g.accepted_plan_ref !== binding.accepted_plan_ref) {
    return `accepted_plan_task_graph.accepted_plan_ref ${JSON.stringify(g.accepted_plan_ref)} must equal the task fact plan_binding.accepted_plan_ref ${JSON.stringify(binding.accepted_plan_ref)}`;
  }
  if (g.accepted_plan_digest !== (binding.plan_digest ?? undefined)) {
    return `accepted_plan_task_graph.accepted_plan_digest must equal the task fact plan_binding.plan_digest (${JSON.stringify(g.accepted_plan_digest)} vs ${JSON.stringify(binding.plan_digest ?? null)})`;
  }
  if (computeGraphDigest(g.task_ids, g.edges) !== g.graph_digest) {
    return 'accepted_plan_task_graph.graph_digest does not match the recomputed SHA-256(SPN({task_ids ascending, edges serialized sorted}))';
  }
  const taskId = fact.scope?.task_id;
  if (taskId === undefined) {
    return 'task fact requires a task_id scope for graph binding';
  }
  // (S03-STAGE-REVIEW-F001) Cross-stage/slice smuggling: the canonical task
  // id is already proven part of the accepted plan graph, so the derived-
  // stage/slice equality below is the ONLY guard against a task fact that
  // claims a foreign scope.stage_id / scope.slice_id while staying inside
  // the accepted plan.
  const scopeError = taskFactScopeConsistencyError(fact);
  if (scopeError !== undefined) {
    return scopeError;
  }
  if (!g.task_ids.includes(taskId)) {
    return `task id ${JSON.stringify(taskId)} is not part of the accepted plan task graph (phantom task id)`;
  }
  const depTargets = g.edges
    .filter((edge) => edge.kind === 'dependency' && edge.from === taskId)
    .map((edge) => edge.to);
  const factDeps = fact.depends_on_task_ids ?? [];
  if (!setEquals(depTargets, factDeps)) {
    return `task fact depends_on_task_ids must exactly equal the accepted plan dependency edge set for ${JSON.stringify(taskId)} (missing/extra edges rejected)`;
  }
  const blockedBy = fact.blocked_by_task_id;
  if (blockedBy !== undefined && !depTargets.includes(blockedBy)) {
    return `blocked_by_task_id ${JSON.stringify(blockedBy)} must be a real accepted-plan dependency of ${JSON.stringify(taskId)}`;
  }
  return undefined;
}


/**
 * (S06 post-recovery Authority update) Accepted-Plan generation succession
 * (contracts §2.2.2 / architecture #/entities/planning-acceptance-succession,
 * STATIC-34 / E2E-27 / T13).
 *
 * A cycle-bearing `plan_acceptance` accepted generation is one accepted Plan
 * generation for its (stage, delivery cycle). All such generations of one
 * (stage, cycle) must form ONE append-only acyclic chain through the top-level
 * `supersedes_plan_acceptance_ref` edge, whose unique tip is the current
 * accepted generation. The helpers below are pure functions of the durable
 * fact set — they never read MES status, the Map, insertion order, timestamps,
 * Git recency or a second pointer/store, so restart / rehydrate rebuilds the
 * same chain and the same tip.
 */
interface PlanAcceptanceGenerationGroup {
  readonly stage_id: string;
  readonly delivery_cycle_id: string;
  readonly nodes: readonly MesFactEnvelope[];
}

/** Exact cycle-bearing accepted-generation predicate (stage scope + cycle). */
export function isCycleBearingPlanAcceptanceGeneration(fact: MesFactEnvelope): boolean {
  if (fact.fact_kind !== 'plan_acceptance') return false;
  const binding = fact.plan_binding;
  if (binding === undefined || binding.binding_stage !== 'accepted') return false;
  if (typeof binding.delivery_cycle_id !== 'string' || binding.delivery_cycle_id.length === 0) return false;
  const stageId = fact.scope?.stage_id;
  return typeof stageId === 'string' && stageId.length > 0;
}

/** Group cycle-bearing accepted generations by exact (stage, delivery cycle). */
function groupPlanAcceptanceGenerations(
  facts: readonly MesFactEnvelope[],
): PlanAcceptanceGenerationGroup[] {
  const groups = new Map<string, { stage_id: string; delivery_cycle_id: string; nodes: MesFactEnvelope[] }>();
  for (const fact of facts) {
    if (!isCycleBearingPlanAcceptanceGeneration(fact)) continue;
    const stageId = fact.scope!.stage_id;
    const cycle = fact.plan_binding!.delivery_cycle_id as string;
    const key = canonicalStringify([stageId, cycle]);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { stage_id: stageId, delivery_cycle_id: cycle, nodes: [fact] });
    } else {
      existing.nodes.push(fact);
    }
  }
  return [...groups.values()];
}

/**
 * Atomic succession-graph validation over the WHOLE resulting set
 * (submitted ∪ retained facts): every (stage, delivery cycle) group of
 * cycle-bearing accepted generations must form exactly one acyclic chain
 * with a unique tip. Self-reference, missing / non-generation target,
 * cross-stage / cross-cycle target, duplicate target (branch), directed
 * cycle, an explicit `null` predecessor next to another generation, and
 * zero / multiple tips all fail closed. A retained pre-update generation
 * that omits the predecessor field is a read-only compatibility root;
 * no-cycle legacy acceptances are history-only and never join a chain.
 *
 * @returns `undefined` when every group closes, or a fail-closed message
 *   (the caller wraps it into a typed no-write / typed AUTHORITY_GAP).
 */
export function verifyPlanAcceptanceSuccessionGraphError(
  facts: readonly MesFactEnvelope[],
): string | undefined {
  const byId = new Map<string, MesFactEnvelope>();
  for (const fact of facts) byId.set(fact.fact_id, fact);
  for (const group of groupPlanAcceptanceGenerations(facts)) {
    const nodes = group.nodes;
    const localById = new Map(nodes.map((fact) => [fact.fact_id, fact] as const));
    const referencedPredecessors = new Map<string, string>();
    for (const node of nodes) {
      const predecessor = node.supersedes_plan_acceptance_ref;
      if (predecessor === undefined) continue; // retained compat root / omitted legacy
      if (predecessor === null) continue; // new chain root (submit-time uniqueness is enforced at the write boundary)
      if (typeof predecessor !== 'string' || predecessor.length === 0) {
        return `plan_acceptance generation ${JSON.stringify(node.fact_id)} carries a malformed supersedes_plan_acceptance_ref（no-write）`;
      }
      if (predecessor === node.fact_id) {
        return `plan_acceptance generation ${JSON.stringify(node.fact_id)} supersedes itself（self-reference no-write）`;
      }
      const target = localById.get(predecessor);
      if (target === undefined) {
        const foreign = byId.get(predecessor);
        if (foreign === undefined) {
          return `plan_acceptance generation ${JSON.stringify(node.fact_id)} predecessor ${JSON.stringify(predecessor)} does not resolve to a durable fact in the resulting set（missing target no-write）`;
        }
        return `plan_acceptance generation ${JSON.stringify(node.fact_id)} predecessor ${JSON.stringify(predecessor)} resolves to ${JSON.stringify(foreign.fact_id)} which is not a cycle-bearing plan_acceptance generation of the same (stage, delivery cycle)（cross-stage / cross-cycle / non-generation target no-write）`;
      }
      const referrer = referencedPredecessors.get(predecessor);
      if (referrer !== undefined && referrer !== node.fact_id) {
        return `plan_acceptance generations ${JSON.stringify(referrer)} and ${JSON.stringify(node.fact_id)} both supersede ${JSON.stringify(predecessor)}（duplicate target / branch no-write）`;
      }
      referencedPredecessors.set(predecessor, node.fact_id);
    }
    for (const start of nodes) {
      const seen = new Set<string>();
      let cursor = start;
      while (typeof cursor.supersedes_plan_acceptance_ref === 'string' && cursor.supersedes_plan_acceptance_ref.length > 0) {
        if (seen.has(cursor.fact_id)) {
          return `plan_acceptance generation chain for (stage ${JSON.stringify(group.stage_id)}, cycle ${JSON.stringify(group.delivery_cycle_id)}) contains a directed cycle through ${JSON.stringify(cursor.fact_id)}（directed cycle no-write）`;
        }
        seen.add(cursor.fact_id);
        const next = localById.get(cursor.supersedes_plan_acceptance_ref);
        if (next === undefined) break; // missing target reported above
        cursor = next;
      }
    }
    const tips = nodes.filter((fact) => !referencedPredecessors.has(fact.fact_id));
    if (tips.length !== 1) {
      return `plan_acceptance generations for (stage ${JSON.stringify(group.stage_id)}, cycle ${JSON.stringify(group.delivery_cycle_id)}) must form exactly one acyclic chain with a unique tip; found ${tips.length} tip(s)（ambiguous zero/multiple tips no-write）`;
    }
  }
  return undefined;
}

/**
 * Unique current accepted generation per (stage, delivery cycle) chain tip.
 * A broken / ambiguous chain is returned as a fail-closed error rather than
 * a partially-resolved tip set (status translates it into typed
 * AUTHORITY_GAP; the write boundary into atomic no-write).
 */
export function resolvePlanAcceptanceGenerationTips(
  facts: readonly MesFactEnvelope[],
): { readonly ok: true; readonly tips: readonly MesFactEnvelope[] } | { readonly ok: false; readonly error: string } {
  const graphError = verifyPlanAcceptanceSuccessionGraphError(facts);
  if (graphError !== undefined) return { ok: false, error: graphError };
  const tips: MesFactEnvelope[] = [];
  for (const group of groupPlanAcceptanceGenerations(facts)) {
    const referenced = new Set(
      group.nodes
        .filter((fact) => typeof fact.supersedes_plan_acceptance_ref === 'string' && (fact.supersedes_plan_acceptance_ref as string).length > 0)
        .map((fact) => fact.supersedes_plan_acceptance_ref as string),
    );
    const groupTips = group.nodes.filter((fact) => !referenced.has(fact.fact_id));
    if (groupTips.length === 1) tips.push(groupTips[0]);
  }
  return { ok: true, tips };
}

/**
 * (S06-R-B-T01) Canonical binding-critical identity resolution over the
 * current durable relation (contracts.md #/entities/mes-binding-critical-identity
 * / §2.1.3, acceptance E2E-24 / E2E-25).
 *
 * The caller never copies or assembles canonical identity: the canonical
 * `verification_result_ref`, `delivery_cycle_id` and accepted-Plan identity are
 * resolved EXCLUSIVELY from the durable fact set itself — never from insertion
 * order, fact filename, ref spelling, timestamp, Git recency, status projection,
 * newest-wins or a second pointer/store.
 *
 * Resolution closes only when exactly ONE durable `plan_acceptance` fact binds
 * the requested accepted Plan and its `verification_result_ref` exact-resolves to
 * exactly ONE durable PLAN_READY `planning_verification_result` fact (full
 * relational closure via `verifyPlanAcceptanceSupport`: exact result_ref
 * equality, promoted candidate/plan agreement, plan_digest agreement, same Git
 * basis head, same delivery_cycle_id).
 *
 * @returns `{ ok: true }` with the canonical relation, or a fail-closed message
 *   (missing / ambiguous / relation-broken → the caller turns it into a typed
 *   no-write before any snapshot replacement).
 */
export interface MesCanonicalAcceptanceRelation {
  readonly accepted_plan_ref: string;
  readonly source_candidate_plan_ref: string;
  readonly verification_result_ref: string;
  readonly plan_digest?: string;
  readonly delivery_cycle_id?: string;
  readonly acceptance_fact_id: string;
  readonly verification_fact_id: string;
}

export type MesCanonicalAcceptanceResolution =
  | { readonly ok: true; readonly canonical: MesCanonicalAcceptanceRelation }
  | { readonly ok: false; readonly error: string };

export function resolveCanonicalAcceptanceRelation(
  facts: readonly MesFactEnvelope[],
  acceptedPlanRef: string,
): MesCanonicalAcceptanceResolution {
  // (S06 post-recovery Authority update) Candidate `planning_verification_result`
  // facts are verification evidence only: they never participate in currentness
  // selection. The canonical acceptance candidate set is the unique current
  // generation tip of every (stage, delivery cycle) chain, plus legacy no-cycle
  // accepted facts (history-only single-node generations that never join a
  // chain). A broken / ambiguous chain fails closed before any identity match.
  const tips = resolvePlanAcceptanceGenerationTips(facts);
  if (!tips.ok) {
    return {
      ok: false,
      error: `plan_acceptance generation succession for accepted Plan ${JSON.stringify(acceptedPlanRef)} is ambiguous: ${tips.error}`,
    };
  }
  const legacyAcceptances = facts.filter(
    (f) =>
      f.fact_kind === 'plan_acceptance' &&
      f.plan_binding !== undefined &&
      f.plan_binding.binding_stage === 'accepted' &&
      (f.plan_binding.delivery_cycle_id === undefined || f.plan_binding.delivery_cycle_id.length === 0),
  );
  const acceptances = [...tips.tips, ...legacyAcceptances].filter(
    (f) =>
      f.plan_binding !== undefined &&
      f.plan_binding.binding_stage === 'accepted' &&
      f.plan_binding.accepted_plan_ref === acceptedPlanRef,
  );
  if (acceptances.length === 0) {
    return {
      ok: false,
      error: `no durable plan_acceptance fact binds accepted Plan ${JSON.stringify(acceptedPlanRef)} in the current relation（missing，no-write）`,
    };
  }
  if (acceptances.length > 1) {
    return {
      ok: false,
      error: `binding-critical identity for accepted Plan ${JSON.stringify(acceptedPlanRef)} is ambiguous: ${acceptances.length} current plan_acceptance generation(s) (${acceptances.map((a) => a.fact_id).join(', ')}) — unique resolution required，no-write`,
    };
  }
  const acceptance = acceptances[0];
  const binding = acceptance.plan_binding;
  if (!binding || binding.binding_stage !== 'accepted') {
    return {
      ok: false,
      error: `durable plan_acceptance ${JSON.stringify(acceptance.fact_id)} does not carry an accepted binding`,
    };
  }
  const referenced = binding.verification_result_ref;
  if (typeof referenced !== 'string' || referenced.length === 0) {
    return {
      ok: false,
      error: `plan_acceptance ${JSON.stringify(acceptance.fact_id)} lacks a non-empty verification_result_ref（no-write）`,
    };
  }
  // Exact result_ref resolution to a UNIQUE durable PLAN_READY PVR. A typo /
  // old ref / approximate ref yields zero supports; two PVRs sharing the ref
  // yields ambiguity — both fail closed, never newest-wins.
  const supports = facts.filter(
    (f) => f.fact_kind === 'planning_verification_result' && f.result_ref === referenced,
  );
  if (supports.length === 0) {
    return {
      ok: false,
      error: `verification_result_ref ${JSON.stringify(referenced)} does not exact-resolve to a durable planning_verification_result fact in the current relation（missing support，no-write）`,
    };
  }
  if (supports.length > 1) {
    return {
      ok: false,
      error: `verification_result_ref ${JSON.stringify(referenced)} is ambiguous: ${supports.length} planning_verification_result facts share it (${supports.map((s) => s.fact_id).join(', ')}) — unique exact resolution required，no-write`,
    };
  }
  const support = supports[0];
  const closure = verifyPlanAcceptanceSupport(acceptance, support);
  if (closure !== undefined) {
    return {
      ok: false,
      error: `binding-critical closure for ${JSON.stringify(acceptance.fact_id)} failed: ${closure}（no-write）`,
    };
  }
  return {
    ok: true,
    canonical: {
      accepted_plan_ref: binding.accepted_plan_ref,
      source_candidate_plan_ref: binding.source_candidate_plan_ref,
      verification_result_ref: referenced,
      ...(binding.plan_digest !== undefined ? { plan_digest: binding.plan_digest } : {}),
      ...(binding.delivery_cycle_id !== undefined
        ? { delivery_cycle_id: binding.delivery_cycle_id }
        : {}),
      acceptance_fact_id: acceptance.fact_id,
      verification_fact_id: support.fact_id,
    },
  };
}

/**
 * (S06-R-B-T01) Exact-match no-write gate for a submitted accepted-bound fact
 * against the canonical binding-critical relation resolved from the current
 * durable set (contracts.md #/entities/mes-binding-critical-identity / §2.1.3,
 * acceptance E2E-24 / E2E-25 / E2E-26).
 *
 * The submitted fact's binding-critical identity (accepted_plan_ref,
 * source_candidate_plan_ref, verification_result_ref, plan_digest,
 * delivery_cycle_id) must EXACTLY equal the canonical relation resolved from
 * `facts` (the resulting set = current ∪ submitted). Any deviation — typo, old
 * ref, approximate ref, cross-cycle, missing or ambiguous relation — is a
 * fail-closed message; the caller turns it into atomic no-write, snapshot bytes
 * and fact identities unchanged.
 *
 * Facts without an accepted plan_binding carry no binding-critical identity to
 * match and pass this gate (their own kind rules still apply elsewhere).
 *
 * @returns `undefined` when the submitted binding exact-matches the canonical
 *   relation, or a fail-closed message.
 */
export function exactMatchBindingCriticalIdentityError(
  facts: readonly MesFactEnvelope[],
  submitted: MesFactEnvelope,
): string | undefined {
  const binding = submitted.plan_binding;
  if (!binding || binding.binding_stage !== 'accepted') {
    return undefined;
  }
  const resolution = resolveCanonicalAcceptanceRelation(facts, binding.accepted_plan_ref);
  if (!resolution.ok) {
    return `fact ${JSON.stringify(submitted.fact_id)}: ${resolution.error}`;
  }
  const canonical = resolution.canonical;
  if (binding.accepted_plan_ref !== canonical.accepted_plan_ref) {
    return `fact ${JSON.stringify(submitted.fact_id)} accepted_plan_ref ${JSON.stringify(binding.accepted_plan_ref)} must EXACTLY equal the canonical accepted_plan_ref ${JSON.stringify(canonical.accepted_plan_ref)}（no-write）`;
  }
  if (binding.source_candidate_plan_ref !== canonical.source_candidate_plan_ref) {
    return `fact ${JSON.stringify(submitted.fact_id)} source_candidate_plan_ref ${JSON.stringify(binding.source_candidate_plan_ref)} must EXACTLY equal the canonical source_candidate_plan_ref ${JSON.stringify(canonical.source_candidate_plan_ref)}（no-write）`;
  }
  if (binding.verification_result_ref !== canonical.verification_result_ref) {
    return `fact ${JSON.stringify(submitted.fact_id)} verification_result_ref ${JSON.stringify(binding.verification_result_ref)} must EXACTLY equal the canonical verification_result_ref ${JSON.stringify(canonical.verification_result_ref)} resolved from the current durable relation（typo / old ref / approximate ref → atomic no-write，snapshot bytes unchanged）`;
  }
  if ((binding.plan_digest ?? undefined) !== (canonical.plan_digest ?? undefined)) {
    return `fact ${JSON.stringify(submitted.fact_id)} plan_digest ${JSON.stringify(binding.plan_digest ?? null)} must equal the canonical plan_digest ${JSON.stringify(canonical.plan_digest ?? null)}（no-write）`;
  }
  if ((binding.delivery_cycle_id ?? undefined) !== (canonical.delivery_cycle_id ?? undefined)) {
    return `fact ${JSON.stringify(submitted.fact_id)} delivery_cycle_id ${JSON.stringify(binding.delivery_cycle_id ?? null)} must equal the canonical delivery_cycle_id ${JSON.stringify(canonical.delivery_cycle_id ?? null)}（cross-cycle → atomic no-write）`;
  }
  return undefined;
}

/** Normalized set equality (sorted, unique) for dependency edge comparison. */
function setEquals(a: readonly string[], b: readonly string[]): boolean {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((value, i) => value === sb[i]);
}