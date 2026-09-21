/**
 * @proofloop/runtime — MES fact envelope & fact-kind binding validator
 * (S01-A-T01).
 *
 * Fail-closed validation of the closed, versioned MES fact envelope. Every
 * violation (unknown field, wrong schema version, malformed shape, invalid
 * canonical ref, invalid digest, kind/binding inconsistency) throws a single
 * `SchemaValidationError` (RUNTIME.SCHEMA_MISMATCH) with per-field errors.
 *
 * Canonical refs are root-relative and must never escape the trust root:
 * authority refs are `path#section` entity refs and Plan refs are
 * root-relative Git paths — traversal (`..`), absolute and backslash forms
 * are rejected (mirrors the fact-kind binding validator).
 *
 * Binding rules follow the Contracts Authority (tech-spec/contracts.md §2.2 /
 * §2.2.1) and the MES Contract: execution-bound facts (work/result/git) must
 * carry an `accepted` Plan binding and a Git basis; `work`/`result` also
 * carry a MES work identity, `result` a durable `result_ref`; `candidate` is
 * pre-accept planning verification with `accepted_plan_ref: null`; an
 * accepted binding must promote the same candidate ref it references.
 */
import {
  SchemaValidationError,
  isSha256Hex,
  CANONICAL_STAGE_ID_RE,
} from '@proofloop/kernel';
import {
  isCanonicalAuthorityRef,
  isCanonicalRootRelativeRef,
  MES_SPV_VERIFIER_ROLE,
  acceptedStageSupportShapeError,
  projectReadyClosedGitBasisError,
} from './binding';
import {
  MES_SCHEMA_VERSION,
  MES_FACT_KINDS,
  MES_PLAN_BINDING_STAGES,
  MES_PLAN_VERDICTS,
  MES_CREATED_BY,
  MES_RECOVERY_PREIMAGE_STATUSES,
  MES_SLICE_ID_RE,
  MES_TASK_ID_RE,
  MES_TASK_STATUSES,
  MES_VERIFIER_VERDICTS,
  MES_FINDING_DISPOSITIONS,
  MES_ROUTE_CODES,
  MES_RESUME_TARGETS,
  MES_GIT_SUBKINDS,
} from './types';
import type {
  MesFactEnvelope,
  MesFactKind,
  MesGitBasis,
  MesPlanBinding,
  MesScope,
} from './types';

export { SchemaValidationError };
export type { MesFactEnvelope };

interface FieldError {
  path: string;
  message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `value` contains any C0 control character (U+0000–U+001F), DEL
 * (U+007F), or Unicode line/paragraph separators (U+2028/U+2029). The
 * fail-closed guard prevents newline/control injection into durable fact
 * content (contracts §7 typed outcome, no-write).
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * Machine-closed legacy S01 result predicate (S03-A-T01): a `result` fact
 * is exempt from the result_id / result_payload_digest pair only when it is
 * an S01-scoped accepted-binding result referencing delivery/stages/S01/
 * plan.md AND carries neither of the two new fields. No label / heuristic:
 * the exact field presence + scope + binding ref decide. The 8 existing S01
 * result facts all satisfy it.
 */
export function isLegacyS01Result(value: unknown): boolean {
  if (!isObject(value)) return false;
  const scope = isObject(value.scope) ? value.scope : undefined;
  const binding = isObject(value.plan_binding) ? value.plan_binding : undefined;
  return (
    value.fact_kind === 'result' &&
    !('result_id' in value) &&
    !('result_payload_digest' in value) &&
    scope?.stage_id === 'S01' &&
    binding?.binding_stage === 'accepted' &&
    binding?.accepted_plan_ref === 'delivery/stages/S01/plan.md'
  );
}

/**
 * Replay-index predicate (S03-A-T01): exactly the non-legacy `result`
 * facts that carry the closed result_id / result_payload_digest pair.
 * S01 legacy facts never enter the duplicate/conflict index.
 */
export function isExecuteResult(value: unknown): boolean {
  return isObject(value) && value.fact_kind === 'result' && !isLegacyS01Result(value);
}

function collectErrors(
  label: string,
  fn: (errors: FieldError[]) => unknown,
): unknown {
  const errors: FieldError[] = [];
  const result = fn(errors);
  if (errors.length > 0) {
    throw new SchemaValidationError(
      `${label} schema validation failed: ${errors
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

const ENVELOPE_KNOWN_FIELDS = new Set([
  'schema_version',
  'fact_id',
  'fact_kind',
  'created_by',
  'authority_refs',
  'scope',
  'work_id',
  'result_ref',
  'plan_binding',
  'git_basis',
  'verifier_role',
  'action_token',
  // S03-A-T01 closed per-kind Execute payload fields.
  'task_status',
  'depends_on_task_ids',
  'blocked_by_task_id',
  'result_id',
  'result_payload_digest',
  'git_subkind',
  'candidate_ref',
  'candidate_base_ref',
  'commit_sha',
  'changed_files',
  'verifier_verdict',
  'finding_evidence_refs',
  'claimed_route_code',
  'disposition_ref',
  'finding_ref',
  'finding_disposition',
  'accepted_route_code',
  'basis_refs',
  'reason',
  'resume_target',
  // S04-A-T01 terminal payload: closed planned Stage-ID set.
  'planned_stage_ids',
  // Disaster re-baseline payload (recovery_baseline kind).
  'recovery_id',
  'preimage_status',
  'source_snapshot_sha256',
  'source_fact_count',
  'forensic_ref',
  'audit_ref',
  'audit_sha256',
  // S05-A-T01 closed top-level delivery-cycle identity (terminal only).
  'delivery_cycle_id',
  // S06-D-T01 closed terminal successor edge (project_ready terminal only;
  // null = new chain root, exact ref = preceding chain-tip fact_id).
  'supersedes_project_ready_ref',
  // S06 post-recovery Authority update: closed accepted-Plan generation
  // successor edge (plan_acceptance accepted generation only; null = new
  // chain root, exact ref = preceding (stage, cycle) chain-tip fact_id).
  'supersedes_plan_acceptance_ref',
]);

const SCOPE_KNOWN_FIELDS = new Set(['stage_id', 'slice_id', 'task_id']);

const GIT_BASIS_KNOWN_FIELDS = new Set(['head', 'branch', 'worktree']);

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

/** Fields a candidate (pre-accept) plan binding may carry. */
const PLAN_BINDING_CANDIDATE_FIELDS = new Set([
  'binding_stage',
  'candidate_plan_ref',
  'accepted_plan_ref',
  'verdict',
  'plan_digest',
  'delivery_cycle_id',
]);

/** Fields an accepted (promoted) plan binding may carry. */
const PLAN_BINDING_ACCEPTED_FIELDS = new Set([
  'binding_stage',
  'accepted_plan_ref',
  'source_candidate_plan_ref',
  'verification_result_ref',
  'plan_digest',
  'delivery_cycle_id',
]);

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
 * Non-empty string + canonical root-relative Plan-ref check (mirrors the
 * fact-kind binding validator): a Git-tracked Plan ref like
 * `delivery/stages/S01/plan.md` must never escape the trust root (no
 * traversal / absolute / backslash / empty segment forms).
 */
function expectRootRelativePlanRef(
  value: unknown,
  path: string,
  errors: FieldError[],
): string | undefined {
  const ref = expectNonEmptyString(value, path, errors);
  if (ref !== undefined && !isCanonicalRootRelativeRef(ref)) {
    errors.push({
      path,
      message:
        'Expected a canonical root-relative Plan ref (no absolute path, no .., no backslash, no empty segment)',
    });
  }
  return ref;
}

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

  // Variant-specific field closure: a candidate binding must not carry
  // accepted-only fields (source_candidate_plan_ref / verification_result_ref)
  // and an accepted binding must not carry candidate-only fields
  // (candidate_plan_ref / verdict).
  checkUnknownFields(
    obj,
    stage === 'candidate' ? PLAN_BINDING_CANDIDATE_FIELDS : PLAN_BINDING_ACCEPTED_FIELDS,
    path,
    errors,
  );

  // plan_digest, when present, must be a canonical SHA-256 digest.
  if (obj.plan_digest !== undefined && !isSha256Hex(obj.plan_digest)) {
    errors.push({
      path: `${path}.plan_digest`,
      message: 'Expected 64-char lowercase hex SHA-256 digest',
    });
  }

  // (S05 runtime prereq) delivery_cycle_id is the closed opaque NORMAL
  // delivery-cycle identity (contracts §2.2.2 / mes.md / architecture
  // delivery-cycle-semantics). Optional at the SCHEMA level so legacy
  // retained plan bindings that lack it keep rehydrating byte-equivalently
  // as history-only without upgrade; when present it must be a non-empty
  // opaque string without control characters.
  if (obj.delivery_cycle_id !== undefined) {
    const cycle = obj.delivery_cycle_id;
    if (typeof cycle !== 'string' || cycle.length === 0 || hasControlCharacter(cycle)) {
      errors.push({
        path: `${path}.delivery_cycle_id`,
        message: 'delivery_cycle_id must be a non-empty opaque string without control characters',
      });
    }
  }

  if (stage === 'candidate') {
    expectRootRelativePlanRef(obj.candidate_plan_ref, `${path}.candidate_plan_ref`, errors);
    if (obj.accepted_plan_ref !== null) {
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
 * Kind/binding consistency rules:
 *  - `plan_binding` fact kind requires a Plan binding;
 *  - execution-bound facts (`work` / `result` / `git`) must bind an
 *    `accepted` Plan (contracts.md §2.2 fact-kind binding rule) and carry a
 *    Stage scope; `result` additionally requires `result_ref`; `git`
 *    additionally requires `git_basis`;
 *  - `stage` requires a canonical Stage scope.
 */
function validateKindBinding(
  kind: MesFactKind,
  envelope: Record<string, unknown>,
  errors: FieldError[],
): void {

  // Per-kind payload field closure (S03-A-T01): every closed Execute-kind
  // payload field is valid ONLY on its owning kind. A cross-kind known
  // field (e.g. result_id on a task fact, task_status on a git fact) fails
  // closed — knowing the field name is not enough, the kind binding owns it.
  const perKindPayload: Record<string, readonly string[]> = {
    task: ['task_status', 'depends_on_task_ids', 'blocked_by_task_id'],
    result: ['result_id', 'result_payload_digest'],
    git: ['git_subkind', 'candidate_ref', 'candidate_base_ref', 'commit_sha', 'changed_files'],
    finding: ['verifier_verdict', 'finding_evidence_refs', 'claimed_route_code'],
    finding_disposition: [
      'disposition_ref',
      'finding_ref',
      'finding_disposition',
      'claimed_route_code',
      'accepted_route_code',
      'basis_refs',
      'reason',
      'resume_target',
    ],
    project_ready: ['planned_stage_ids'],
    recovery_baseline: [
      'recovery_id',
      'preimage_status',
      'source_snapshot_sha256',
      'source_fact_count',
      'forensic_ref',
      'audit_ref',
      'audit_sha256',
    ],
  };
  const allPayloadFields = Object.values(perKindPayload).flat();
  const allowedForKind = perKindPayload[kind] ?? [];
  for (const field of allPayloadFields) {
    if (envelope[field] === undefined) continue;
    if (!allowedForKind.includes(field)) {
      errors.push({
        path: `mes_fact.${field}`,
        message: `${field} is only valid on ${kindOfPayloadField(field)} facts (cross-kind payload field fails closed)`,
      });
    }
  }
  function kindOfPayloadField(field: string): string {
    for (const [kindName, fields] of Object.entries(perKindPayload)) {
      if (fields.includes(field)) return kindName;
    }
    return '?';
  }

  // (S05-A-T01) Per-kind `delivery_cycle_id` position rule (contracts
  // §2.2.2 / §5.1; architecture delivery-cycle-semantics "Field placement
  // is closed"): the opaque NORMAL delivery-cycle identity is plan-bound
  // for every plan-bound kind (PVR/PA and execute kinds work/task/result/
  // finding/git plus accepted `stage` carry it INSIDE plan_binding), while
  // EXACTLY the `project_ready` terminal fact carries the cycle at the
  // envelope TOP LEVEL. A top-level `delivery_cycle_id` on any non-terminal
  // kind is a position violation and fails closed (STATIC-08/STATIC-10);
  // legacy retained facts omit the field entirely and keep rehydrating
  // byte-equivalently as history-only without backfill.
  if (kind !== 'project_ready' && envelope.delivery_cycle_id !== undefined) {
    errors.push({
      path: 'mes_fact.delivery_cycle_id',
      message: `delivery_cycle_id is plan-bound for ${kind} facts (carry it inside plan_binding); only the project_ready terminal fact carries a top-level delivery_cycle_id`,
    });
  }
  // (S06-D-T01) Per-kind `supersedes_project_ready_ref` position rule
  // (contracts §5.1 / current-terminal-currentness-oracle /
  // delivery-cycle-semantics + STATIC-30/STATIC-31): the terminal successor
  // edge is a `project_ready` TERMINAL-ONLY top-level field — non-null refs
  // chain cycle-bearing terminals within one delivery cycle lineage, while
  // every other fact kind is plan-bound or carry-free. A top-level
  // `supersedes_project_ready_ref` on any non-terminal kind is a position
  // violation / cross-kind payload and fails closed (STATIC-08/10).
  if (kind !== 'project_ready' && envelope.supersedes_project_ready_ref !== undefined) {
    errors.push({
      path: 'mes_fact.supersedes_project_ready_ref',
      message: `supersedes_project_ready_ref is terminal-only; only the project_ready terminal fact carries a top-level successor edge (${kind} facts must not carry it)`,
    });
  }
  // (S06 post-recovery Authority update) Per-kind
  // `supersedes_plan_acceptance_ref` position rule (contracts §2.2.2 /
  // architecture #/entities/planning-acceptance-succession): the accepted-Plan
  // generation successor edge is `plan_acceptance`-ONLY at the envelope top
  // level. Any other fact kind carrying it is a position violation /
  // cross-kind payload and fails closed.
  if (kind !== 'plan_acceptance' && envelope.supersedes_plan_acceptance_ref !== undefined) {
    errors.push({
      path: 'mes_fact.supersedes_plan_acceptance_ref',
      message: `supersedes_plan_acceptance_ref is plan_acceptance-only; only a cycle-bearing accepted generation carries the top-level predecessor edge (${kind} facts must not carry it)`,
    });
  }

  if (kind === 'stage') {
    const scope = envelope.scope as Record<string, unknown> | undefined;
    // Fail closed on null/non-object scope: property access would raise a
    // raw TypeError instead of the canonical SchemaValidationError.
    if (scope === undefined || !isObject(scope) || typeof scope.stage_id !== 'string') {
      errors.push({ path: 'scope.stage_id', message: 'stage fact requires a canonical stage scope' });
    }
    // Accepted `stage` support shape is ALL-OR-NOTHING (contracts.md §2.1.1
    // / §2.2, S04-A-T01): a stage fact carrying any accepted relation field
    // without the complete accepted shape fails closed no-write. The single
    // shared validator is owned by binding.ts; the store write boundary
    // (validateMesFactEnvelope) reuses it, so no-write is guaranteed.
    const supportShapeError = acceptedStageSupportShapeError(envelope);
    if (supportShapeError !== undefined) {
      errors.push({ path: 'stage_support_shape', message: supportShapeError });
    }
  }
  if (kind === 'project_ready') {
    // Closed terminal payload (contracts.md §5.1 / acceptance E2E-06):
    // planned_stage_ids is a canonical `^S\d+$` Stage-ID set — non-empty,
    // de-duplicated, ascending stable order (the Brain obtains the planned
    // set from the active Project Stage Map; MES never reads the Map).
    const planned = envelope.planned_stage_ids;
    if (!Array.isArray(planned) || planned.length === 0) {
      errors.push({
        path: 'mes_fact.planned_stage_ids',
        message: 'project_ready fact requires a non-empty planned_stage_ids array',
      });
    } else {
      const seen = new Set<string>();
      for (let i = 0; i < planned.length; i++) {
        const id = planned[i];
        if (typeof id !== 'string' || !CANONICAL_STAGE_ID_RE.test(id)) {
          errors.push({
            path: `mes_fact.planned_stage_ids[${i}]`,
            message: 'Expected a canonical Stage ID matching /^S\\d+$/, e.g. S01',
          });
        } else if (seen.has(id)) {
          errors.push({
            path: `mes_fact.planned_stage_ids[${i}]`,
            message: `duplicate Stage ID ${JSON.stringify(id)}`,
          });
        } else {
          seen.add(id);
        }
      }
      for (let i = 1; i < planned.length; i++) {
        if (
          typeof planned[i] === 'string' &&
          typeof planned[i - 1] === 'string' &&
          planned[i] <= planned[i - 1]
        ) {
          errors.push({
            path: 'mes_fact.planned_stage_ids',
            message: 'planned_stage_ids must be in ascending canonical order without duplicates',
          });
          break;
        }
      }
    }
    // (S05-A-T01) The `project_ready` terminal fact carries the opaque
    // NORMAL delivery-cycle identity at the envelope TOP LEVEL (contracts
    // §5.1 / architecture delivery-cycle-semantics "Field placement is
    // closed": the terminal must not bind a Plan, so the cycle is a
    // top-level closed field). When present it must be a non-empty opaque
    // string without control characters; legacy seed/retained terminal
    // facts without the field keep rehydrating byte-equivalently as
    // history-only without backfill.
    if (envelope.delivery_cycle_id !== undefined) {
      const cycle = envelope.delivery_cycle_id;
      if (typeof cycle !== 'string' || cycle.length === 0 || hasControlCharacter(cycle)) {
        errors.push({
          path: 'mes_fact.delivery_cycle_id',
          message: 'delivery_cycle_id must be a non-empty opaque string without control characters',
        });
      }
    }
    // (S06-D-T01) Top-level closed NORMAL terminal successor edge (contracts
    // §5.1 / current-terminal-currentness-oracle / delivery-cycle-semantics,
    // STATIC-30 / E2E-23): `null` = new chain root (no retained
    // cycle-bearing terminal); a string = the exact durable `fact_id` of the
    // unique preceding validated chain tip (different delivery_cycle_id, may
    // be a retained `legacy_cycle_anchor`). Omitted = legacy shapes only
    // (cycle-bearing pre-update legacy_cycle_anchor / no-cycle legacy),
    // read-only rehydrate. Closed value: null or non-empty opaque string
    // without control chars; a supersedes edge must never target the
    // terminal's own cycle (resolution is a store-boundary machine closure).
    if (envelope.supersedes_project_ready_ref !== undefined) {
      const succ = envelope.supersedes_project_ready_ref;
      if (succ !== null && (typeof succ !== 'string' || succ.length === 0 || hasControlCharacter(succ))) {
        errors.push({
          path: 'mes_fact.supersedes_project_ready_ref',
          message: 'supersedes_project_ready_ref must be null or a non-empty opaque fact_id string without control characters',
        });
      }
      // Half-new shape: a successor edge without its own cycle identity is
      // invalid rather than guessed (supersedes requires delivery_cycle_id).
      if (typeof envelope.delivery_cycle_id !== 'string' || envelope.delivery_cycle_id.length === 0) {
        errors.push({
          path: 'mes_fact.supersedes_project_ready_ref',
          message: 'supersedes_project_ready_ref requires a top-level delivery_cycle_id on the same terminal (half-new NORMAL shape invalid)',
        });
      }
    }
    // The terminal fact's own Git basis is the COMPLETE closed shape
    // (head/branch/worktree, head 40-hex, worktree canonical root-relative);
    // missing / partial basis fails closed no-write.
    const basisError = projectReadyClosedGitBasisError(envelope.git_basis);
    if (basisError !== undefined) {
      errors.push({ path: 'mes_fact.git_basis', message: basisError });
    }
    // Terminal facts do NOT inherit unrelated Stage/Work/Result binding
    // (E2E-06): scope / work_id / result_ref / plan_binding present fail
    // closed. verifier_role / action_token are already rejected globally
    // (planning_verification_result only).
    if (envelope.scope !== undefined) {
      errors.push({
        path: 'mes_fact.scope',
        message: 'project_ready terminal fact must not carry a Stage/Work/Result scope (E2E-06)',
      });
    }
    if (envelope.work_id !== undefined) {
      errors.push({
        path: 'mes_fact.work_id',
        message: 'project_ready terminal fact must not inherit a MES work identity (E2E-06)',
      });
    }
    if (envelope.result_ref !== undefined) {
      errors.push({
        path: 'mes_fact.result_ref',
        message: 'project_ready terminal fact must not carry a durable result_ref (E2E-06)',
      });
    }
    if (envelope.plan_binding !== undefined) {
      errors.push({
        path: 'mes_fact.plan_binding',
        message: 'project_ready terminal fact must not bind a Plan (E2E-06)',
      });
    }
    // authority_refs must be canonical tech-spec refs (non-empty is already
    // enforced envelope-wide).
    if (Array.isArray(envelope.authority_refs)) {
      for (let i = 0; i < envelope.authority_refs.length; i++) {
        const ref = envelope.authority_refs[i];
        if (typeof ref !== 'string' || !isCanonicalAuthorityRef(ref) || !ref.startsWith('tech-spec/')) {
          errors.push({
            path: `mes_fact.authority_refs[${i}]`,
            message:
              'project_ready authority_refs must be canonical tech-spec refs (e.g. tech-spec/contracts.md#5.1)',
          });
        }
      }
    }
  }
  if (kind === 'recovery_baseline') {
    const recoveryId = expectNonEmptyString(envelope.recovery_id, 'mes_fact.recovery_id', errors);
    if (recoveryId !== undefined && envelope.fact_id !== `mes:fact:recovery_baseline:${recoveryId}`) {
      errors.push({ path: 'mes_fact.fact_id', message: 'recovery_baseline fact_id must equal mes:fact:recovery_baseline:<recovery_id>' });
    }
    if (typeof envelope.preimage_status !== 'string' || !(MES_RECOVERY_PREIMAGE_STATUSES as readonly string[]).includes(envelope.preimage_status)) {
      errors.push({ path: 'mes_fact.preimage_status', message: `Expected one of: ${MES_RECOVERY_PREIMAGE_STATUSES.map((s) => JSON.stringify(s)).join(', ')}` });
    }
    if (typeof envelope.source_snapshot_sha256 !== 'string' || !isSha256Hex(envelope.source_snapshot_sha256)) {
      errors.push({ path: 'mes_fact.source_snapshot_sha256', message: 'Expected a 64-character lowercase SHA-256 digest' });
    }
    if (!Number.isSafeInteger(envelope.source_fact_count) || (envelope.source_fact_count as number) < 0) {
      errors.push({ path: 'mes_fact.source_fact_count', message: 'Expected a non-negative safe integer fact count' });
    }
    for (const field of ['forensic_ref', 'audit_ref'] as const) {
      const ref = envelope[field];
      if (typeof ref !== 'string' || !isCanonicalRootRelativeRef(ref) || !ref.startsWith('.proofloop/forensics/')) {
        errors.push({ path: `mes_fact.${field}`, message: 'Expected a root-relative .proofloop/forensics ref' });
      }
    }
    if (typeof envelope.audit_sha256 !== 'string' || !isSha256Hex(envelope.audit_sha256)) {
      errors.push({ path: 'mes_fact.audit_sha256', message: 'Expected a 64-character lowercase SHA-256 digest' });
    }
    if (envelope.scope !== undefined || envelope.work_id !== undefined || envelope.result_ref !== undefined || envelope.plan_binding !== undefined || envelope.verifier_role !== undefined || envelope.action_token !== undefined) {
      errors.push({ path: 'mes_fact', message: 'recovery_baseline must not carry scope/work_id/result_ref/plan_binding/verifier_role/action_token' });
    }
    if (envelope.git_basis === undefined) {
      errors.push({ path: 'mes_fact.git_basis', message: 'recovery_baseline fact requires a git_basis' });
    }
    if (Array.isArray(envelope.authority_refs)) {
      for (let i = 0; i < envelope.authority_refs.length; i++) {
        const ref = envelope.authority_refs[i];
        if (typeof ref !== 'string' || !isCanonicalAuthorityRef(ref) || !ref.startsWith('tech-spec/')) {
          errors.push({ path: `mes_fact.authority_refs[${i}]`, message: 'recovery_baseline authority_refs must be canonical tech-spec refs' });
        }
      }
    }
    return;
  }
  if (kind === 'plan_binding') {
    if (envelope.plan_binding === undefined) {
      errors.push({ path: 'plan_binding', message: 'plan_binding fact requires a plan_binding value' });
    }
  }
  const planningKind =
    kind === 'planning_verification_result' || kind === 'plan_acceptance';
  if (planningKind) {
    // Fail closed on null/non-object plan_binding before property access:
    // the nested shape is already reported by validatePlanBindingInto, so
    // treat non-object values as absent and emit the kind rule below.
    const binding = isObject(envelope.plan_binding)
      ? (envelope.plan_binding as MesPlanBinding)
      : undefined;
    if (kind === 'planning_verification_result') {
      if (binding === undefined || binding.binding_stage !== 'candidate') {
        errors.push({
          path: 'plan_binding',
          message:
            'planning_verification_result fact must bind a candidate Plan (binding_stage: "candidate", accepted_plan_ref: null)',
        });
      }
      // YAML machinery (contracts.md §2.2.2): verifier role, SPV dispatch
      // token, planning work identity and the MES-generated durable ref are
      // all required on the pre-accept fact.
      // verifier_role is a CLOSED value: only 'stage-plan-verifier' is
      // legal (mes.md / contracts.md §2.2.2).
      const verifierRole = envelope.verifier_role;
      if (verifierRole === undefined) {
        errors.push({
          path: 'mes_fact.verifier_role',
          message: 'planning_verification_result fact requires a verifier_role',
        });
      } else if (verifierRole !== MES_SPV_VERIFIER_ROLE) {
        errors.push({
          path: 'mes_fact.verifier_role',
          message: `planning_verification_result fact verifier_role must be exactly ${JSON.stringify(MES_SPV_VERIFIER_ROLE)} (got ${JSON.stringify(verifierRole)})`,
        });
      }
      expectNonEmptyString(envelope.action_token, 'mes_fact.action_token', errors);
      expectNonEmptyString(envelope.work_id, 'mes_fact.work_id', errors);
      expectNonEmptyString(envelope.result_ref, 'mes_fact.result_ref', errors);
    } else {
      if (binding === undefined || binding.binding_stage !== 'accepted') {
        errors.push({
          path: 'plan_binding',
          message: 'plan_acceptance fact must bind an accepted Plan (binding_stage: "accepted")',
        });
      }
      // (S06 post-recovery Authority update) The accepted generation's
      // top-level predecessor edge is closed (null or a non-empty opaque
      // fact_id without control characters) and exists only together with
      // the generation's own delivery cycle inside plan_binding — a
      // predecessor edge without its cycle is a half-new NORMAL shape and
      // fails closed rather than being guessed (contracts §2.2.2 / §7).
      if (envelope.supersedes_plan_acceptance_ref !== undefined) {
        const predecessor = envelope.supersedes_plan_acceptance_ref;
        if (predecessor !== null && (typeof predecessor !== 'string' || predecessor.length === 0 || hasControlCharacter(predecessor))) {
          errors.push({
            path: 'mes_fact.supersedes_plan_acceptance_ref',
            message: 'supersedes_plan_acceptance_ref must be null or a non-empty opaque fact_id string without control characters',
          });
        }
        const paBinding = isObject(envelope.plan_binding) ? envelope.plan_binding : undefined;
        const paCycle = paBinding !== undefined ? paBinding.delivery_cycle_id : undefined;
        if (typeof paCycle !== 'string' || paCycle.length === 0) {
          errors.push({
            path: 'mes_fact.supersedes_plan_acceptance_ref',
            message: 'supersedes_plan_acceptance_ref requires plan_binding.delivery_cycle_id on the same plan_acceptance (half-new NORMAL shape invalid)',
          });
        }
      }
      // verifier_role / action_token are planning-verification-scoped.
      if (envelope.verifier_role !== undefined) {
        errors.push({
          path: 'mes_fact.verifier_role',
          message: 'verifier_role is only valid on planning_verification_result facts',
        });
      }
      if (envelope.action_token !== undefined) {
        errors.push({
          path: 'mes_fact.action_token',
          message: 'action_token is only valid on planning_verification_result facts',
        });
      }
    }
    // (S05 runtime prereq) NORMAL PVR/PA carry BOTH a stage-only scope and a
    // closed plan_binding.delivery_cycle_id (contracts §2.2.2 / mes.md /
    // architecture delivery-cycle-semantics "Planning provenance and field
    // placement are closed"). The pair rule triggers on either half of the
    // shape: a cycle-scoped fact without a canonical stage-only scope, or a
    // scope-carrying fact without a cycle, is a half-new NORMAL shape and
    // fails closed. Only the FULLY legacy shape (neither field) keeps
    // rehydrating byte-equivalently as history-only without upgrade.
    const planningScope = isObject(envelope.scope) ? envelope.scope : undefined;
    const planningBinding = isObject(envelope.plan_binding) ? envelope.plan_binding : undefined;
    const hasCycle = planningBinding !== undefined && planningBinding.delivery_cycle_id !== undefined;
    const hasStageScope = planningScope !== undefined && typeof planningScope.stage_id === 'string';
    if (hasCycle) {
      if (!hasStageScope) {
        errors.push({
          path: 'mes_fact.scope',
          message: `${kind} fact carrying plan_binding.delivery_cycle_id requires a canonical stage-only scope.stage_id (new NORMAL PVR/PA shape)`,
        });
      } else if (planningScope.slice_id !== undefined || planningScope.task_id !== undefined) {
        errors.push({
          path: 'mes_fact.scope',
          message: `${kind} fact carrying a delivery cycle must use a stage-only scope (no slice_id / task_id)`,
        });
      }
    } else if (hasStageScope) {
      errors.push({
        path: 'mes_fact.plan_binding.delivery_cycle_id',
        message: `${kind} fact carrying scope.stage_id requires a closed non-empty plan_binding.delivery_cycle_id (new NORMAL PVR/PA shape)`,
      });
    }
    if (envelope.git_basis === undefined) {
      errors.push({ path: 'git_basis', message: `${kind} fact requires a git_basis` });
    }
    return;
  }
  // verifier_role / action_token are planning-verification-scoped: every
  // other fact kind carrying them fails closed.
  if (envelope.verifier_role !== undefined) {
    errors.push({
      path: 'mes_fact.verifier_role',
      message: 'verifier_role is only valid on planning_verification_result facts',
    });
  }
  if (envelope.action_token !== undefined) {
    errors.push({
      path: 'mes_fact.action_token',
      message: 'action_token is only valid on planning_verification_result facts',
    });
  }
  if (kind === 'task') {
    // Closed payload (contracts.md §5.1 / S03-A-T01): task_status is
    // validated, never derived; depends_on_task_ids is a canonical task-id
    // set without duplicates; blocked_by_task_id is a canonical single
    // value written by Brain only on a real block. The dependency / blocked
    // graph binding (brand-bound accepted_plan_task_graph edge equality) is
    // enforced at the MesSnapshotStore.write durable boundary.
    const status = envelope.task_status;
    if (
      typeof status !== 'string' ||
      !(MES_TASK_STATUSES as readonly string[]).includes(status)
    ) {
      errors.push({
        path: 'mes_fact.task_status',
        message: `Expected one of: ${MES_TASK_STATUSES.map((s) => JSON.stringify(s)).join(', ')}`,
      });
    }
    const dependsOn = envelope.depends_on_task_ids;
    if (!Array.isArray(dependsOn)) {
      errors.push({ path: 'mes_fact.depends_on_task_ids', message: 'task fact requires a depends_on_task_ids array' });
    } else {
      const seen = new Set<string>();
      for (let i = 0; i < dependsOn.length; i++) {
        const dep = dependsOn[i];
        if (typeof dep !== 'string' || !MES_TASK_ID_RE.test(dep)) {
          errors.push({
            path: `mes_fact.depends_on_task_ids[${i}]`,
            message: 'Expected a canonical task id matching /^S\\d+-[A-Z]+-T\\d+$/',
          });
        } else if (seen.has(dep)) {
          errors.push({
            path: `mes_fact.depends_on_task_ids[${i}]`,
            message: `duplicate task id ${JSON.stringify(dep)}`,
          });
        } else {
          seen.add(dep);
        }
      }
    }
    if (envelope.blocked_by_task_id !== undefined) {
      const blocked = envelope.blocked_by_task_id;
      if (typeof blocked !== 'string' || !MES_TASK_ID_RE.test(blocked)) {
        errors.push({
          path: 'mes_fact.blocked_by_task_id',
          message: 'Expected a canonical task id matching /^S\\d+-[A-Z]+-T\\d+$/',
        });
      }
    }
    const taskScope = envelope.scope as Record<string, unknown> | undefined;
    if (
      taskScope === undefined ||
      !isObject(taskScope) ||
      typeof taskScope.stage_id !== 'string' ||
      typeof taskScope.slice_id !== 'string' ||
      typeof taskScope.task_id !== 'string' ||
      !MES_TASK_ID_RE.test(taskScope.task_id as string)
    ) {
      errors.push({ path: 'mes_fact.scope', message: 'task fact requires a stage+slice+task scope with a canonical task_id' });
    }
    // Task facts are execution-bound: accepted Plan binding + work identity +
    // Git basis (mirrors the binding validator below).
    const taskBinding = envelope.plan_binding as MesPlanBinding | undefined;
    if (taskBinding === undefined || !isObject(taskBinding) || taskBinding.binding_stage !== 'accepted') {
      errors.push({ path: 'plan_binding', message: 'task fact must bind an accepted Plan (binding_stage: "accepted")' });
    }
    if (envelope.work_id === undefined) {
      errors.push({ path: 'work_id', message: 'task fact requires a work_id' });
    }
    if (envelope.git_basis === undefined) {
      errors.push({ path: 'git_basis', message: 'task fact requires a git_basis' });
    }
    return;
  }
  if (kind === 'finding') {
    // Verifier closed verdict + claim (contracts.md §2.2.3 / E2E-20 side).
    const verdict = envelope.verifier_verdict;
    if (
      typeof verdict !== 'string' ||
      !(MES_VERIFIER_VERDICTS as readonly string[]).includes(verdict)
    ) {
      errors.push({
        path: 'mes_fact.verifier_verdict',
        message: `Expected one of: ${MES_VERIFIER_VERDICTS.map((v) => JSON.stringify(v)).join(', ')}`,
      });
    }
    const claim = envelope.claimed_route_code;
    if (typeof claim !== 'string' || !(MES_ROUTE_CODES as readonly string[]).includes(claim)) {
      errors.push({
        path: 'mes_fact.claimed_route_code',
        message: `Expected one of: ${MES_ROUTE_CODES.map((c) => JSON.stringify(c)).join(', ')}`,
      });
    }
    if (envelope.finding_evidence_refs !== undefined) {
      if (!Array.isArray(envelope.finding_evidence_refs)) {
        errors.push({ path: 'mes_fact.finding_evidence_refs', message: 'finding_evidence_refs must be an array of refs' });
      } else {
        envelope.finding_evidence_refs.forEach((ref, i) => {
          if (typeof ref !== 'string' || ref.length === 0 || hasControlCharacter(ref)) {
            errors.push({ path: `mes_fact.finding_evidence_refs[${i}]`, message: 'expected a non-empty ref without control characters' });
          }
        });
      }
    }
    const findingScope = envelope.scope as Record<string, unknown> | undefined;
    if (findingScope === undefined || !isObject(findingScope) || typeof findingScope.stage_id !== 'string') {
      errors.push({ path: 'mes_fact.scope', message: 'finding fact requires a canonical stage scope' });
    }
    const findingBinding = envelope.plan_binding as MesPlanBinding | undefined;
    if (findingBinding === undefined || !isObject(findingBinding) || findingBinding.binding_stage !== 'accepted') {
      errors.push({ path: 'plan_binding', message: 'finding fact must bind an accepted Plan (binding_stage: "accepted")' });
    }
    if (envelope.work_id === undefined) {
      errors.push({ path: 'work_id', message: 'finding fact requires a work_id' });
    }
    if (envelope.git_basis === undefined) {
      errors.push({ path: 'git_basis', message: 'finding fact requires a git_basis' });
    }
    return;
  }
  if (kind === 'finding_disposition') {
    // Brain-owned arbitration per contracts.md §2.2.3 YAML (closed fields);
    // VERIFIER_OVERREACH forces accepted_route_code null and no automatic
    // repair / Replan / HUMAN_REQUIRED.
    expectNonEmptyString(envelope.disposition_ref, 'mes_fact.disposition_ref', errors);
    expectNonEmptyString(envelope.finding_ref, 'mes_fact.finding_ref', errors);
    const disposition = envelope.finding_disposition;
    if (
      typeof disposition !== 'string' ||
      !(MES_FINDING_DISPOSITIONS as readonly string[]).includes(disposition)
    ) {
      errors.push({
        path: 'mes_fact.finding_disposition',
        message: `Expected one of: ${MES_FINDING_DISPOSITIONS.map((d) => JSON.stringify(d)).join(', ')}`,
      });
    }
    const claim = envelope.claimed_route_code;
    if (typeof claim !== 'string' || !(MES_ROUTE_CODES as readonly string[]).includes(claim)) {
      errors.push({
        path: 'mes_fact.claimed_route_code',
        message: `Expected one of: ${MES_ROUTE_CODES.map((c) => JSON.stringify(c)).join(', ')}`,
      });
    }
    const accepted = envelope.accepted_route_code;
    if (disposition === 'VERIFIER_OVERREACH') {
      if (accepted !== null) {
        errors.push({ path: 'mes_fact.accepted_route_code', message: 'accepted_route_code must be null when finding_disposition is VERIFIER_OVERREACH' });
      }
    } else if (disposition === 'ACCEPTED') {
      if (typeof accepted !== 'string' || !(MES_ROUTE_CODES as readonly string[]).includes(accepted)) {
        errors.push({ path: 'mes_fact.accepted_route_code', message: 'accepted_route_code must be a legal route code when finding_disposition is ACCEPTED' });
      }
    }
    if (envelope.basis_refs !== undefined) {
      if (!Array.isArray(envelope.basis_refs)) {
        errors.push({ path: 'mes_fact.basis_refs', message: 'basis_refs must be an array of refs' });
      } else {
        envelope.basis_refs.forEach((ref, i) => {
          if (typeof ref !== 'string' || ref.length === 0 || hasControlCharacter(ref)) {
            errors.push({ path: `mes_fact.basis_refs[${i}]`, message: 'expected a non-empty ref without control characters' });
          }
        });
      }
    }
    const reason = envelope.reason;
    if (typeof reason !== 'string' || reason.length === 0 || hasControlCharacter(reason)) {
      errors.push({ path: 'mes_fact.reason', message: 'reason must be a non-empty string without control characters' });
    }
    const target = envelope.resume_target;
    if (typeof target !== 'string' || !(MES_RESUME_TARGETS as readonly string[]).includes(target)) {
      errors.push({
        path: 'mes_fact.resume_target',
        message: `Expected one of: ${MES_RESUME_TARGETS.map((t) => JSON.stringify(t)).join(', ')}`,
      });
    }
    const dispositionScope = envelope.scope as Record<string, unknown> | undefined;
    if (dispositionScope === undefined || !isObject(dispositionScope) || typeof dispositionScope.stage_id !== 'string') {
      errors.push({ path: 'mes_fact.scope', message: 'finding_disposition fact requires a canonical stage scope' });
    }
    const dispositionBinding = envelope.plan_binding as MesPlanBinding | undefined;
    if (dispositionBinding === undefined || !isObject(dispositionBinding) || dispositionBinding.binding_stage !== 'accepted') {
      errors.push({ path: 'plan_binding', message: 'finding_disposition fact must bind an accepted Plan (binding_stage: "accepted")' });
    }
    if (envelope.git_basis === undefined) {
      errors.push({ path: 'git_basis', message: 'finding_disposition fact requires a git_basis' });
    }
    return;
  }
  if (kind === 'work' || kind === 'result' || kind === 'git') {
    const binding = envelope.plan_binding as MesPlanBinding | undefined;
    // Fail closed on null/non-object plan_binding: property access would
    // raise a raw TypeError instead of the canonical SchemaValidationError.
    if (binding === undefined || !isObject(binding) || binding.binding_stage !== 'accepted') {
      errors.push({
        path: 'plan_binding',
        message: `${kind} fact must bind an accepted Plan (binding_stage: "accepted")`,
      });
    }
    const scope = envelope.scope as Record<string, unknown> | undefined;
    // Fail closed on null/non-object scope: property access would raise a
    // raw TypeError instead of the canonical SchemaValidationError.
    if (scope === undefined || !isObject(scope) || typeof scope.stage_id !== 'string') {
      errors.push({ path: 'scope.stage_id', message: `${kind} fact requires a canonical stage scope` });
    }
    // Complete NORMAL binding (mes.md write principle, mirrors the fact-kind
    // binding validator): every execution-bound fact carries a Git basis;
    // `work` / `result` additionally carry a MES work identity, and `result`
    // a durable result_ref. An envelope with an accepted binding but no
    // work_id/git_basis must fail closed, never be durably stored.
    if (envelope.git_basis === undefined) {
      errors.push({ path: 'git_basis', message: `${kind} fact requires a git_basis` });
    }
    if ((kind === 'work' || kind === 'result') && envelope.work_id === undefined) {
      errors.push({ path: 'work_id', message: `${kind} fact requires a work_id` });
    }
    if (kind === 'result' && envelope.result_ref === undefined) {
      errors.push({ path: 'result_ref', message: 'result fact requires a durable result_ref' });
    }
    // result kind (S03-A-T01): closed result_id + result_payload_digest pair
    // with the machine-closed legacy S01 predicate. Non-S01 result facts
    // (especially S03) require BOTH fields; partial pairs (mixed state) fail
    // closed in both directions; invalid digests / control chars fail closed.
    if (kind === 'result') {
      const legacy = isLegacyS01Result(envelope);
      const hasId = envelope.result_id !== undefined;
      const hasDigest = envelope.result_payload_digest !== undefined;
      if (hasId !== hasDigest) {
        errors.push({
          path: 'mes_fact.result_id',
          message: legacy
            ? 'legacy S01 result facts must omit both result_id and result_payload_digest (no mixed state)'
            : 'result facts require both result_id and result_payload_digest together (no partial pair)',
        });
      }
      if (hasId) {
        const id = envelope.result_id;
        if (typeof id !== 'string' || id.length === 0 || hasControlCharacter(id)) {
          errors.push({ path: 'mes_fact.result_id', message: 'result_id must be a non-empty opaque string without control characters' });
        }
      }
      if (!legacy && !hasDigest) {
        errors.push({
          path: 'mes_fact.result_payload_digest',
          message: 'non-S01 result facts require both result_id and result_payload_digest (64-hex)',
        });
      }
      if (hasDigest && (typeof envelope.result_payload_digest !== 'string' || !isSha256Hex(envelope.result_payload_digest))) {
        errors.push({
          path: 'mes_fact.result_payload_digest',
          message: 'Expected 64-char lowercase hex SHA-256 digest',
        });
      }
    }
    // git kind (S03-A-T01): closed execute payload is ALL-OR-NOTHING — the
    // full set {git_subkind, candidate_ref, candidate_base_ref, commit_sha,
    // changed_files} must be carried together or none of it. A partial git
    // payload fails closed; pre-existing git facts without any payload field
    // keep rehydrating.
    const GIT_PAYLOAD_FIELDS = ['git_subkind', 'candidate_ref', 'candidate_base_ref', 'commit_sha', 'changed_files'] as const;
    const presentGitPayloadFields = GIT_PAYLOAD_FIELDS.filter((field) => envelope[field] !== undefined);
    if (presentGitPayloadFields.length > 0 && presentGitPayloadFields.length < GIT_PAYLOAD_FIELDS.length) {
      errors.push({
        path: 'mes_fact.git_payload',
        message: `git execute payload must be all-or-nothing: missing ${GIT_PAYLOAD_FIELDS.filter((field) => envelope[field] === undefined).join(', ')}`,
      });
    }
    if (kind === 'git') {
      if (envelope.git_subkind !== undefined) {
        const subkind = envelope.git_subkind;
        if (typeof subkind !== 'string' || !(MES_GIT_SUBKINDS as readonly string[]).includes(subkind)) {
          errors.push({
            path: 'mes_fact.git_subkind',
            message: `Expected one of: ${MES_GIT_SUBKINDS.map((s) => JSON.stringify(s)).join(', ')}`,
          });
        }
      }
      if (envelope.candidate_ref !== undefined) {
        expectRootRelativePlanRef(envelope.candidate_ref, 'mes_fact.candidate_ref', errors);
        if (typeof envelope.candidate_ref === 'string' && hasControlCharacter(envelope.candidate_ref)) {
          errors.push({ path: 'mes_fact.candidate_ref', message: 'candidate_ref must not contain control characters' });
        }
      }
      if (envelope.candidate_base_ref !== undefined) {
        expectRootRelativePlanRef(envelope.candidate_base_ref, 'mes_fact.candidate_base_ref', errors);
        if (typeof envelope.candidate_base_ref === 'string' && hasControlCharacter(envelope.candidate_base_ref)) {
          errors.push({ path: 'mes_fact.candidate_base_ref', message: 'candidate_base_ref must not contain control characters' });
        }
      }
      if (envelope.commit_sha !== undefined) {
        const sha40 = envelope.commit_sha;
        if (typeof sha40 !== 'string' || !/^[0-9a-f]{40}$/.test(sha40)) {
          errors.push({ path: 'mes_fact.commit_sha', message: 'Expected a 40-char lowercase hex commit SHA' });
        }
      }
      if (envelope.changed_files !== undefined) {
        if (!Array.isArray(envelope.changed_files)) {
          errors.push({ path: 'mes_fact.changed_files', message: 'changed_files must be an array of canonical root-relative paths' });
        } else {
          envelope.changed_files.forEach((file, i) => {
            if (typeof file !== 'string' || hasControlCharacter(file) || !isCanonicalRootRelativeRef(file)) {
              errors.push({ path: `mes_fact.changed_files[${i}]`, message: 'Expected a canonical root-relative path (no traversal / absolute / backslash / empty segment)' });
            }
          });
        }
      }
    }
  }
}

/**
 * Fail-closed validation of a versioned MES fact envelope.
 *
 * @returns the validated envelope (typed).
 * @throws {SchemaValidationError} on any violation (RUNTIME.SCHEMA_MISMATCH).
 */
export function validateMesFactEnvelope(value: unknown): MesFactEnvelope {
  return collectErrors('MesFactEnvelope', (errors) => {
    const obj = expectObject(value, 'mes_fact', errors);
    if (!obj) return undefined;

    checkUnknownFields(obj, ENVELOPE_KNOWN_FIELDS, 'mes_fact', errors);

    if (obj.schema_version !== MES_SCHEMA_VERSION) {
      errors.push({
        path: 'mes_fact.schema_version',
        message: `Expected ${MES_SCHEMA_VERSION}, got ${JSON.stringify(obj.schema_version)}`,
      });
    }

    const kind = obj.fact_kind;
    if (
      typeof kind !== 'string' ||
      !(MES_FACT_KINDS as readonly string[]).includes(kind)
    ) {
      errors.push({
        path: 'mes_fact.fact_kind',
        message: `Expected one of: ${MES_FACT_KINDS.map((k) => JSON.stringify(k)).join(', ')}`,
      });
      return obj as unknown as MesFactEnvelope;
    }

    expectNonEmptyString(obj.fact_id, 'mes_fact.fact_id', errors);

    if (obj.created_by !== 'brain' || !(MES_CREATED_BY as readonly string[]).includes(obj.created_by as string)) {
      errors.push({
        path: 'mes_fact.created_by',
        message: `Expected one of: ${MES_CREATED_BY.map((c) => JSON.stringify(c)).join(', ')}`,
      });
    }

    const authorityRefs = obj.authority_refs;
    if (!Array.isArray(authorityRefs) || authorityRefs.length === 0) {
      errors.push({ path: 'mes_fact.authority_refs', message: 'Expected a non-empty array of canonical refs' });
    } else {
      for (let i = 0; i < authorityRefs.length; i++) {
        const ref = authorityRefs[i];
        if (!isCanonicalAuthorityRef(ref)) {
          errors.push({
            path: `mes_fact.authority_refs[${i}]`,
            message: 'Expected canonical entity ref with a root-relative path: "<path>#<section/entity>"',
          });
        }
      }
    }

    if (obj.scope !== undefined) {
      validateScopeInto(obj.scope, 'mes_fact.scope', errors);
    }
    if (obj.work_id !== undefined) {
      expectNonEmptyString(obj.work_id, 'mes_fact.work_id', errors);
    }
    if (obj.result_ref !== undefined) {
      expectNonEmptyString(obj.result_ref, 'mes_fact.result_ref', errors);
    }
    if (obj.verifier_role !== undefined) {
      expectNonEmptyString(obj.verifier_role, 'mes_fact.verifier_role', errors);
    }
    if (obj.action_token !== undefined) {
      expectNonEmptyString(obj.action_token, 'mes_fact.action_token', errors);
    }
    if (obj.plan_binding !== undefined) {
      validatePlanBindingInto(obj.plan_binding, 'mes_fact.plan_binding', errors);
    }
    if (obj.git_basis !== undefined) {
      validateGitBasisInto(obj.git_basis, 'mes_fact.git_basis', errors);
    }

    if (typeof kind === 'string' && (MES_FACT_KINDS as readonly string[]).includes(kind)) {
      validateKindBinding(kind as MesFactKind, obj, errors);
    }

    return obj as unknown as MesFactEnvelope;
  }) as MesFactEnvelope;
}
