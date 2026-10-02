/**
 * @proofloop/runtime — mechanical catalog family: Execute Git lifecycle
 * (R4 / G6, ADR-026 / E2E-33 / STATIC-41, tech-spec/contracts.md §2.1.3 /
 * §5.3, architecture #/entities/mes-operational-transaction-boundary).
 *
 * Git mutation stays where it already belongs (boundary close / integration
 * apply / worktree create+remove). After a SUCCESSFUL mechanical Git
 * transaction, Brain authorizes the corresponding semantic persistence event
 * using the MECHANICAL RESULT, never a pre-assembled Git fact envelope:
 *
 *   - `execute.git_candidate`: candidate publication → the existing
 *     `buildCandidateFact` (canonical `candidate_ref` is Runtime-derived from
 *     the canonical Stage/Slice identity, `candidate_base_ref` / `commit_sha`
 *     / `changed_files` equal the mechanical boundary result);
 *   - `execute.git_integration`: integration apply → the existing
 *     `buildIntegrationFact` with field-for-field equality against the
 *     mechanical `integration_result` (dirty_after must be empty);
 *   - `execute.git_cleanup`: cleanup → the existing `buildCleanupFact` bound
 *     to the already-durable integration fact of the current lane (the
 *     preceding integration fact is RESOLVED, never caller-supplied).
 *
 * Runtime derives (never caller-supplied) the current open cycle, the current
 * accepted generation binding, the current Work lineage tip, `work_id`,
 * `plan_binding`, `git_basis` and the exact Git fact equality validation.
 * Git and MES remain distinct authorities with truthful partial-failure
 * semantics — this seam NEVER merges Git mutation and MES persistence into a
 * mega-transaction.
 *
 * Caller-owned: the Brain-authorized transition subject (`stage_id`,
 * `slice_id`) and the mechanical Git result of the completed transaction.
 */
import {
  isCycleBearingPlanAcceptanceGeneration,
  resolvePlanAcceptanceGenerationTips,
  resolveWorkLineageTips,
  workLineageKeyOf,
} from './binding';
import {
  buildCandidateFact,
  buildIntegrationFact,
  buildCleanupFact,
  IntegrationStateError,
} from '../execute/integration-state';
import { canonicalCandidateRef } from '../git-boundary';
import { canonicalStringify } from '../cli/proofloop-common';
import { materializeFail } from './materialization-error';
import type {
  MesSemanticEvent,
  MesSemanticEventCatalogEntry,
  MesSemanticEventHandler,
  MesSemanticEventMaterialization,
} from './semantic-event';
import type { MesFactEnvelope, MesGitBasis, MesPlanBinding } from './types';

/** The three Git-lifecycle event kinds. */
export const GIT_CANDIDATE_EVENT_KIND = 'execute.git_candidate';
export const GIT_INTEGRATION_EVENT_KIND = 'execute.git_integration';
export const GIT_CLEANUP_EVENT_KIND = 'execute.git_cleanup';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function payloadString(event: MesSemanticEvent, field: string, eventKind: string): string {
  const value = event.payload[field];
  if (!isNonEmptyString(value)) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a non-empty string ${field}`, eventKind);
  }
  return value;
}

/** Cycle anchor: ANY cycle-bearing PVR/PA planning fact (same set as store). */
function isCycleAnchoredPlanningFact(fact: MesFactEnvelope): boolean {
  if (fact.fact_kind !== 'planning_verification_result' && fact.fact_kind !== 'plan_acceptance') return false;
  return isNonEmptyString(fact.plan_binding?.delivery_cycle_id);
}

function isClosedCycle(context: readonly MesFactEnvelope[], cycle: string, eventKind: string): boolean {
  const terminal = context.find(
    (fact) => fact.fact_kind === 'project_ready' && fact.delivery_cycle_id === cycle,
  );
  if (terminal === undefined) return false;
  if (!Array.isArray(terminal.planned_stage_ids) || terminal.planned_stage_ids.length === 0) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} legal terminal closure is not re-readable — no-write`, eventKind);
  }
  return true;
}

/** Resolve the unique current open delivery cycle (fail closed). */
function resolveCurrentOpenCycle(eventKind: string, current: readonly MesFactEnvelope[]): string {
  const openCycles = new Set<string>();
  for (const fact of current) {
    if (!isCycleAnchoredPlanningFact(fact)) continue;
    const cycle = fact.plan_binding?.delivery_cycle_id;
    if (isNonEmptyString(cycle) && !isClosedCycle(current, cycle, eventKind)) openCycles.add(cycle);
  }
  if (openCycles.size > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} cannot resolve a unique current open delivery cycle（multiple open cycles: ${[...openCycles].sort().join(', ')}）— no-write`,
      eventKind,
    );
  }
  if (openCycles.size === 1) return [...openCycles][0];
  materializeFail(
    'binding-mismatch',
    `semantic event ${eventKind} has no open delivery cycle — no Git materialization before an accepted Plan generation exists, no-write`,
    eventKind,
  );
}

/** Resolve the unique current accepted generation of one (stage, cycle) cohort. */
function resolveCurrentAcceptedGeneration(
  eventKind: string,
  current: readonly MesFactEnvelope[],
  stageId: string,
  cycle: string,
): MesFactEnvelope {
  const resolved = resolvePlanAcceptanceGenerationTips(current);
  if (!resolved.ok) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} cannot resolve accepted-generation tips: ${resolved.error}`, eventKind);
  }
  const cohort = resolved.tips.filter(
    (fact) =>
      fact.scope?.stage_id === stageId &&
      fact.plan_binding?.binding_stage === 'accepted' &&
      fact.plan_binding.delivery_cycle_id === cycle &&
      isCycleBearingPlanAcceptanceGeneration(fact),
  );
  if (cohort.length === 0) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds no current accepted Plan generation for stage ${JSON.stringify(stageId)} cycle ${JSON.stringify(cycle)} — no-write`,
      eventKind,
    );
  }
  if (cohort.length > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds ${cohort.length} accepted generations for stage ${JSON.stringify(stageId)} cycle ${JSON.stringify(cycle)} — no-write`,
      eventKind,
    );
  }
  return cohort[0];
}

/** Resolve the unique current Work-lineage tip of the (stage, slice, cycle, generation) lane. */
function resolveCurrentWorkTip(
  eventKind: string,
  current: readonly MesFactEnvelope[],
  stageId: string,
  sliceId: string,
  acceptedBinding: MesPlanBinding & { accepted_plan_ref: string; plan_digest: string },
): MesFactEnvelope {
  const tips = resolveWorkLineageTips(current);
  if (!tips.ok) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} cannot resolve current Work lineage tips: ${tips.error}`, eventKind);
  }
  const lineageKey = workLineageKeyOf({
    schema_version: 2,
    fact_id: '',
    fact_kind: 'work',
    created_by: 'brain',
    authority_refs: [],
    scope: { stage_id: stageId, slice_id: sliceId },
    plan_binding: acceptedBinding,
    supersedes_work_ref: null,
  } as MesFactEnvelope);
  const cohortTips = tips.tips.filter((fact) => workLineageKeyOf(fact) === lineageKey);
  if (cohortTips.length > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds ${cohortTips.length} current Work tips for the same (stage, slice, cycle, generation) lane — no-write`,
      eventKind,
    );
  }
  if (cohortTips.length === 0) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds no current Work attempt for stage ${JSON.stringify(stageId)} slice ${JSON.stringify(sliceId)} — lane start must precede Git lifecycle, no-write`,
      eventKind,
    );
  }
  return cohortTips[0];
}

/** Shared relation + binding resolution for the three Git lifecycle kinds. */
function resolveLaneBasis(
  event: MesSemanticEvent,
  eventKind: string,
  context: { readonly current: readonly MesFactEnvelope[] },
): {
  readonly stageId: string;
  readonly sliceId: string;
  readonly workId: string;
  readonly planBinding: MesPlanBinding;
  readonly gitBasis: MesGitBasis;
} {
  const stageId = payloadString(event, 'stage_id', eventKind);
  const sliceId = payloadString(event, 'slice_id', eventKind);
  if (sliceId.slice(0, sliceId.indexOf('-')) !== stageId) {
    materializeFail(
      'invalid-field',
      `semantic event ${eventKind} slice_id ${JSON.stringify(sliceId)} does not belong to stage ${JSON.stringify(stageId)} — no-write`,
      eventKind,
    );
  }
  const cycle = resolveCurrentOpenCycle(eventKind, context.current);
  const generation = resolveCurrentAcceptedGeneration(eventKind, context.current, stageId, cycle);
  const acceptedBinding = generation.plan_binding;
  if (acceptedBinding === undefined || acceptedBinding.binding_stage !== 'accepted') {
    materializeFail('binding-mismatch', `semantic event ${eventKind} accepted generation ${JSON.stringify(generation.fact_id)} carries no accepted binding — no-write`, eventKind);
  }
  const workTip = resolveCurrentWorkTip(
    eventKind,
    context.current,
    stageId,
    sliceId,
    acceptedBinding as unknown as MesPlanBinding & { accepted_plan_ref: string; plan_digest: string },
  );
  const gitBasis = workTip.git_basis;
  if (gitBasis === undefined) {
    materializeFail('binding-mismatch', `semantic event ${eventKind} current Work attempt carries no Git basis — no-write`, eventKind);
  }
  return {
    stageId,
    sliceId,
    workId: workTip.work_id as string,
    planBinding: acceptedBinding as unknown as MesPlanBinding,
    gitBasis,
  };
}

function builderOrNoWrite(eventKind: string, fn: () => MesFactEnvelope): MesFactEnvelope {
  try {
    return fn();
  } catch (error) {
    const detail =
      error instanceof IntegrationStateError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    materializeFail('invalid-derived-fact', `semantic event ${eventKind} Git fact construction failed: ${detail} — no-write`, eventKind);
  }
}

/**
 * Dedup/conflict gate over the deterministic Git fact identity: a byte-
 * identical replay collapses idempotently (return the ALREADY-durable fact
 * so the transaction sees no new materialization); a same fact_id with a
 * different payload is a typed conflict no-write (the git execution payload
 * is all-or-nothing immutable history, R4 acceptance).
 */
function gitReplayOrConflict(
  eventKind: string,
  derived: MesFactEnvelope,
  current: readonly MesFactEnvelope[],
): MesFactEnvelope[] {
  const existing = current.find(
    (fact) => fact.fact_id === derived.fact_id && fact.fact_kind === 'git' && fact.git_subkind === derived.git_subkind,
  );
  if (existing === undefined) return [derived];
  if (canonicalStringify(existing) === canonicalStringify(derived)) return [existing];
  materializeFail(
    'conflict',
    `semantic event ${eventKind} durable git fact ${JSON.stringify(derived.fact_id)} already exists with a different payload — same Git lifecycle identity, different mechanical result, no-write`,
    eventKind,
  );
}


/** canonical root-relative Git ref field (candidate_ref / base_ref). */
function canonicalRef(eventKind: string, value: unknown, label: string): string {
  const raw = isNonEmptyString(value) ? value : undefined;
  if (raw === undefined || raw.startsWith('/') || raw.startsWith('./') || raw.includes('../') || raw.includes('\\')) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a canonical root-relative ${label} — no-write`, eventKind);
  }
  return raw;
}

/** commit_sha — 40-hex lowercase Git SHA. */
function canonicalCommitSha(eventKind: string, value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a 40-char lowercase Git commit_sha — no-write`, eventKind);
  }
  return value;
}

/** changed_files — non-empty array of canonical root-relative paths (no protected paths). */
function canonicalChangedFiles(eventKind: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires a non-empty changed_files array — no-write`, eventKind);
  }
  const files: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry === '.git' || entry.startsWith('.git/') || entry === '.proofloop' || entry.startsWith('.proofloop/')) {
      materializeFail('invalid-field', `semantic event ${eventKind} changed_files entry ${JSON.stringify(entry)} is not a protected-path-free root-relative path — no-write`, eventKind);
    }
    if (entry.startsWith('./') || entry.startsWith('/') || entry.includes('../') || entry.includes('\\')) {
      materializeFail('invalid-field', `semantic event ${eventKind} changed_files entry ${JSON.stringify(entry)} is not a canonical root-relative path — no-write`, eventKind);
    }
    if (seen.has(entry)) {
      materializeFail('invalid-field', `semantic event ${eventKind} changed_files contains duplicate ${JSON.stringify(entry)} — no-write`, eventKind);
    }
    seen.add(entry);
    files.push(entry);
  }
  return files;
}

/**
 * `execute.git_candidate` — candidate publication after successful boundary.
 */
export const gitCandidateHandler: MesSemanticEventHandler = (event, context) => {
  const eventKind = event.event_kind;
  const basis = resolveLaneBasis(event, eventKind, context);
  // The canonical candidate_ref is derived from the Stage/Slice identity by
  // the trusted builder (canonicalCandidateRef) — never caller-supplied.
  const candidateRef = canonicalCandidateRef(basis.stageId, basis.sliceId);
  const baseRef = canonicalRef(eventKind, event.payload.candidate_base_ref, 'candidate_base_ref');
  const commitSha = canonicalCommitSha(eventKind, event.payload.commit_sha);
  const changedFiles = canonicalChangedFiles(eventKind, event.payload.changed_files);

  const fact = builderOrNoWrite(eventKind, () =>
    buildCandidateFact({
      stage_id: basis.stageId,
      slice_id: basis.sliceId,
      work_id: basis.workId,
      authority_refs: [...event.binding.authority_refs],
      plan_binding: basis.planBinding,
      git_basis: basis.gitBasis,
      candidate_ref: candidateRef,
      candidate_base_ref: baseRef,
      commit_sha: commitSha,
      changed_files: changedFiles,
    }),
  );
  return { facts: gitReplayOrConflict(eventKind, fact, context.current) };
};

/**
 * `execute.git_integration` — integration apply after successful mechanical
 * apply with a clean worktree (dirty_after []).
 */
export const gitIntegrationHandler: MesSemanticEventHandler = (event, context) => {
  const eventKind = event.event_kind;
  const basis = resolveLaneBasis(event, eventKind, context);
  const result = isRecord(event.payload.integration_result) ? event.payload.integration_result : undefined;
  if (result === undefined) {
    materializeFail('invalid-field', `semantic event ${eventKind} requires an integration_result payload — no-write`, eventKind);
  }
  const integrationResult = {
    candidate_ref: result.candidate_ref ?? result.candidateRef,
    candidate_base_ref: result.candidate_base_ref ?? result.candidateBaseRef,
    commit_sha: result.commit_sha ?? result.commitSha,
    changed_files: result.changed_files ?? result.changedFiles,
    dirty_after: result.dirty_after ?? result.dirtyAfter ?? [],
  };
  if (!Array.isArray(integrationResult.changed_files) || integrationResult.changed_files.length === 0) {
    materializeFail('invalid-field', `semantic event ${eventKind} integration_result.changed_files must be a non-empty array — no-write`, eventKind);
  }
  if (!Array.isArray(integrationResult.dirty_after) || integrationResult.dirty_after.length !== 0) {
    materializeFail('invalid-field', `semantic event ${eventKind} integration_result must be clean after apply (dirty_after []) — no-write`, eventKind);
  }
  canonicalRef(eventKind, integrationResult.candidate_ref, 'integration_result.candidate_ref');
  canonicalRef(eventKind, integrationResult.candidate_base_ref, 'integration_result.candidate_base_ref');
  canonicalCommitSha(eventKind, integrationResult.commit_sha);

  const fact = builderOrNoWrite(eventKind, () =>
    buildIntegrationFact(
      {
        stage_id: basis.stageId,
        slice_id: basis.sliceId,
        work_id: basis.workId,
        authority_refs: [...event.binding.authority_refs],
        plan_binding: basis.planBinding,
        git_basis: basis.gitBasis,
      },
      {
        candidate_ref: String(integrationResult.candidate_ref),
        candidate_base_ref: String(integrationResult.candidate_base_ref),
        commit_sha: String(integrationResult.commit_sha),
        changed_files: [...(integrationResult.changed_files as string[])],
        dirty_after: [],
      },
    ),
  );
  return { facts: gitReplayOrConflict(eventKind, fact, context.current) };
};


/**
 * `execute.git_cleanup` — cleanup after integration; the preceding durable
 * integration fact of the current lane is RESOLVED, never caller-supplied.
 */
export const gitCleanupHandler: MesSemanticEventHandler = (event, context) => {
  const eventKind = event.event_kind;
  const basis = resolveLaneBasis(event, eventKind, context);
  const integrationFacts = context.current.filter(
    (fact) => fact.fact_kind === 'git' && fact.git_subkind === 'integration' && fact.work_id === basis.workId && fact.scope?.slice_id === basis.sliceId,
  );
  if (integrationFacts.length === 0) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds no durable integration Git fact for the current lane (${basis.stageId}/${basis.sliceId}) — cleanup requires a preceding integration, no-write`,
      eventKind,
    );
  }
  if (integrationFacts.length > 1) {
    materializeFail(
      'binding-mismatch',
      `semantic event ${eventKind} finds ${integrationFacts.length} durable integration facts for the current lane — no-write`,
      eventKind,
    );
  }
  const integration = integrationFacts[0];
  const fact = builderOrNoWrite(eventKind, () =>
    buildCleanupFact({
      stage_id: basis.stageId,
      slice_id: basis.sliceId,
      work_id: basis.workId,
      authority_refs: [...event.binding.authority_refs],
      plan_binding: basis.planBinding,
      git_basis: basis.gitBasis,
      integration_fact: integration,
    }),
  );
  return { facts: gitReplayOrConflict(eventKind, fact, context.current) };
};

/** The catalog entries of the three Git-lifecycle families. */
const gitEntryBase = {
  runtime_derived_fields: ['fact_id', 'work_id', 'plan_binding', 'git_basis', 'candidate_ref', 'delivery_cycle_id', 'generation', 'work_tip'],
  reused_oracles: [
    'buildCandidateFact',
    'buildIntegrationFact',
    'buildCleanupFact',
    'resolvePlanAcceptanceGenerationTips',
    'isCycleBearingPlanAcceptanceGeneration',
    'resolveWorkLineageTips',
    'workLineageKeyOf',
  ],
  forbidden_caller_fields: [
    'fact_id',
    'fact_ids',
    'work_id',
    'plan_binding',
    'git_basis',
    'delivery_cycle_id',
    'generation',
    'work_tip',
    'facts',
    'mes_fact_envelopes',
    'integration_fact',
    'candidate_ref',
    'git_fact',
    'next_action',
    'route',
  ],
  failure_codes: ['invalid-field', 'binding-mismatch', 'conflict', 'invalid-derived-fact', 'unreadable'],
};

export const GIT_CANDIDATE_ENTRY: MesSemanticEventCatalogEntry = {
  ...gitEntryBase,
  event_kind: GIT_CANDIDATE_EVENT_KIND,
  caller_fields: ['stage_id', 'slice_id', 'candidate_base_ref', 'commit_sha', 'changed_files'],
  required_caller_fields: ['stage_id', 'slice_id', 'candidate_base_ref', 'commit_sha', 'changed_files'],
  durable_outputs: [{ fact_kind: 'git', mutability: 'immutable' }],
  replay_identity: ['stage_id', 'slice_id', 'delivery_cycle_id', 'verification_result_ref', 'candidate_base_ref', 'commit_sha', 'changed_files'],
  canonicalization: [
    'fact_id = mes:fact:git:<stage>:<slice>:candidate (deterministic)',
    'candidate_ref = canonicalCandidateRef(stage, slice) derived by the existing builder (never caller-supplied)',
    'candidate_base_ref / commit_sha / changed_files equal the mechanical boundary result',
  ],
};

export const GIT_INTEGRATION_ENTRY: MesSemanticEventCatalogEntry = {
  ...gitEntryBase,
  event_kind: GIT_INTEGRATION_EVENT_KIND,
  caller_fields: ['stage_id', 'slice_id', 'integration_result'],
  required_caller_fields: ['stage_id', 'slice_id', 'integration_result'],
  durable_outputs: [{ fact_kind: 'git', mutability: 'immutable' }],
  replay_identity: ['stage_id', 'slice_id', 'delivery_cycle_id', 'verification_result_ref', 'integration_result'],
  canonicalization: [
    'fact_id = mes:fact:git:<stage>:<slice>:integration (deterministic)',
    'integration payload field-for-field equals the mechanical integration apply result (dirty_after must be [])',
    'binding/work_id/git_basis resolved from the current accepted generation + Work lineage tip',
  ],
};

export const GIT_CLEANUP_ENTRY: MesSemanticEventCatalogEntry = {
  ...gitEntryBase,
  event_kind: GIT_CLEANUP_EVENT_KIND,
  caller_fields: ['stage_id', 'slice_id'],
  required_caller_fields: ['stage_id', 'slice_id'],
  durable_outputs: [{ fact_kind: 'git', mutability: 'immutable' }],
  replay_identity: ['stage_id', 'slice_id', 'delivery_cycle_id', 'verification_result_ref'],
  canonicalization: [
    'fact_id = mes:fact:git:<stage>:<slice>:cleanup (deterministic)',
    'the preceding durable integration fact of the current lane is resolved, never caller-supplied',
    'cleanup payload field-for-field equals the preceding integration fact (existing builder)',
  ],
};
