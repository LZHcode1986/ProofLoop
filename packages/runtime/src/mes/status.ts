/**
 * @proofloop/runtime — pure sparse status / bounded detail projections
 * (S01-C-T01).
 *
 * Projects the durable MES facts into the two read-only status views the
 * MES Contract defines (mes.md "status 一级视图" / "status 二级视图",
 * tech-spec/contracts.md §2.3 / §2.4):
 *
 *   - `projectSparseStatus` — the primary view exposes ONLY `scope` /
 *     `phase` / `required_skill` and the non-zero sparse anomaly counters
 *     (ADR-009 minimal exposure). Zero counters are omitted, and a counter
 *     set with nothing non-zero is omitted entirely.
 *   - `projectDetailStatus` — the bounded detail view re-reads the SAME
 *     durable facts and adds only the allowed L2 fields the facts actually
 *     carry (Git basis / accepted Plan ref / candidate Plan ref / planning
 *     verification result ref / plan digest); it never
 *     invents current-work / owner / blocked_by / latest Result-Finding ref
 *     when the durable facts do not contain them, is deterministic and
 *     read-only, and FAILS CLOSED on any input that carries
 *     `next_action` / `route` / `reasoning` or other unknown fields
 *     (HP-001 / STATIC-05: MES never generates a next action or routes).
 *
 * This module is a pure fact projection: no store I/O, no writes, no
 * mutation of the input, no second state machine (STATIC-14). The CLI
 * observation entry (S01-C-T02) feeds it the validated root-bound seed
 * record produced by `seedMesBootstrap`.
 */
import { CANONICAL_STAGE_ID_RE } from '@proofloop/kernel';
import {
  MES_ANOMALY_COUNTERS,
  MES_STATUS_PHASES,
  type MesAnomalyCounterKey,
  type MesGitBasis,
  type MesStatusTuple,
  type MesStatusPhase,
} from './bootstrap';
import {
  MES_FACT_KINDS,
  MES_TASK_ID_RE,
  MES_TASK_STATUSES,
  MES_VERIFIER_VERDICTS,
  MES_FINDING_DISPOSITIONS,
  MES_ROUTE_CODES,
  MES_RESUME_TARGETS,
  MES_GIT_SUBKINDS,
} from './types';
import type { MesFactEnvelope, MesTaskStatus } from './types';
import { duplicateAcceptedStageSupportError, isDurableAcceptedStageSupport, verifyProjectReadySupportError, verifyProjectReadySuccessionGraphError } from './terminal';
import { resolvePlanAcceptanceGenerationTips } from './binding';
import { validateMesFactEnvelope, SchemaValidationError } from './validate';
import { classifyInvalidHistory } from './history-oracle';
/** Closed failure code for a status projection input violation. */
/** Closed failure codes for a status projection input violation. */
export type MesStatusErrorCode = 'invalid-input' | 'authority-gap';

/**
 * Bounded error raised on any fail-closed projection input. The code
 * discriminates the typed failure class:
 *   - `invalid-input` — malformed / unknown / non-envelope projection input;
 *   - `authority-gap`  — (S05-C-T01) the current-cycle identity / phase
 *     cannot be proven from the durable facts (missing / duplicate /
 *     cross-cycle / no stage provenance); status stops typed AUTHORITY_GAP
 *     instead of inventing semantics (PO-S05-C-01 / STATIC-30 / HP-007).
 */
export class MesStatusError extends Error {
  public readonly code: MesStatusErrorCode;

  constructor(message: string, code: MesStatusErrorCode = 'invalid-input') {
    super(message);
    this.name = 'MesStatusError';
    this.code = code;
  }
}

function statusFail(message: string): never {
  throw new MesStatusError(message);
}

/** Fail closed typed AUTHORITY_GAP (S05-C-T01): the current-cycle identity /
 * phase cannot be proven from the durable facts — never invent it. */
function statusAuthorityGap(message: string): never {
  throw new MesStatusError(message, 'authority-gap');
}

/** True when `value` is a non-negative integer (sparse counter values). */
function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * True when `value` contains any C0 control character (U+0000–U+001F), DEL
 * (U+007F), or Unicode line/paragraph separators (U+2028/U+2029). The
 * fail-closed guard prevents newline/control injection into status output and
 * keeps human/JSON output from emitting routing or next-action text.
 */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/**
 * Require a non-empty string free of control characters (fail closed on
 * newline/CR/control injection into any status text field).
 */
function expectSafeText(field: unknown, label: string): string {
  if (typeof field !== 'string' || (field as string).length === 0) {
    statusFail(`${label} must be a non-empty string`);
  }
  if (hasControlCharacter(field as string)) {
    statusFail(`${label} must not contain control characters`);
  }
  return field as string;
}

/** Closed fields a status tuple may carry (unknown fails closed). */
const TUPLE_KNOWN_FIELDS = ['scope', 'phase', 'required_skill', 'counters'] as const;

/** Closed fields the durable seed record (detail input) may carry. */
const SEED_RECORD_KNOWN_FIELDS = [
  'schema_version',
  'seed_id',
  'authority_refs',
  'accepted_plan_ref',
  'plan_digest',
  'candidate_plan_ref',
  'planning_verification_result_ref',
  'git_basis',
  'status',
] as const;

/** Closed fields a Git basis object may carry (unknown fails closed). */
const GIT_BASIS_KNOWN_FIELDS = ['head', 'branch', 'worktree'] as const;

/**
 * Primary (L1) status view: scope / phase / required_skill plus the
 * non-zero sparse anomaly counters, in canonical counter order. The
 * `counters` field is omitted entirely when nothing is non-zero.
 */
export interface MesSparseStatus {
  readonly scope: string;
  readonly phase: string;
  readonly required_skill: string;
  readonly counters?: Readonly<Partial<Record<MesAnomalyCounterKey, number>>>;
}

/**
 * Bounded detail (L2) view: the primary projection plus ONLY the allowed
 * detail fields the durable seed facts actually carry — the Git basis
 * (head/branch/worktree), the accepted Plan ref and the Plan digest. Fields
 * for which no durable fact exists (current work / owner / blocked_by /
 * latest Result-Finding ref / cleanup) are omitted, never invented.
 */
export interface MesDetailStatus extends MesSparseStatus {
  readonly git_basis?: MesGitBasis;
  readonly accepted_plan_ref?: string;
  readonly plan_digest?: string;
  /**
   * Verified candidate (pre-accept) Plan ref, when the durable seed record
   * carries the planning binding (S02-B-T02). Never invented.
   */
  readonly candidate_plan_ref?: string;
  /**
   * Planning verification result ref of the PLAN_READY fact that produced
   * the acceptance, when the durable seed record carries it (S02-B-T02).
   * Never invented.
   */
  readonly planning_verification_result_ref?: string;
  /**
   * (S06-A-T01 / PO-S06-A-02) Projection-only `project_terminal` observation
   * adjunct (contracts §2.3.1): CURRENT_PROJECT_READY /
   * HISTORICAL_PROJECT_READY / PRE_TERMINAL with exact terminal/cycle identity
   * and planned/support closure. Present only when a current cycle / terminal
   * observation is proven; never a MES fact / phase / route / second store.
   */
  readonly project_terminal?: MesProjectTerminalAdjunct;
}

/** Validate the Brain-supplied status tuple shape (fail closed). */
function expectStatusTuple(value: unknown): MesStatusTuple {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    statusFail('status must be an object with scope/phase/required_skill');
  }
  const status = value as Record<string, unknown>;
  for (const key of Object.keys(status)) {
    if (!(TUPLE_KNOWN_FIELDS as readonly string[]).includes(key)) {
      statusFail(`status has unknown field "${key}"`);
    }
  }
  if (typeof status.scope !== 'string' || !CANONICAL_STAGE_ID_RE.test(status.scope)) {
    statusFail(`status.scope must match /^S\\d+$/, got ${JSON.stringify(status.scope)}`);
  }
  expectSafeText(status.phase, 'status.phase');
  // PO-S02-B-04: per-Stage phase is a CLOSED set (contracts.md §5.1); the
  // projection only validates the Brain-supplied tuple, never derives or
  // migrates a phase (HP-001 / STATIC-05).
  if (
    typeof status.phase !== 'string' ||
    !(MES_STATUS_PHASES as readonly string[]).includes(status.phase)
  ) {
    statusFail(`status.phase must be one of the closed per-stage phase set: ${MES_STATUS_PHASES.join(' / ')} (got ${JSON.stringify(status.phase)})`);
  }
  expectSafeText(status.required_skill, 'status.required_skill');
  if (status.counters !== undefined) {
    if (typeof status.counters !== 'object' || status.counters === null || Array.isArray(status.counters)) {
      statusFail('status.counters must be an object');
    }
    for (const [key, val] of Object.entries(status.counters as Record<string, unknown>)) {
      if (!(MES_ANOMALY_COUNTERS as readonly string[]).includes(key)) {
        statusFail(`unknown status counter "${key}"`);
      }
      if (!isNonNegativeInt(val)) {
        statusFail(`status counter ${key} must be a non-negative integer`);
      }
    }
  }
  return status as unknown as MesStatusTuple;
}

/** Validate a Git basis object shape (fail closed on unknown fields). */
function expectGitBasis(value: unknown): MesGitBasis {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    statusFail('git_basis must be an object with head/branch/worktree');
  }
  const basis = value as Record<string, unknown>;
  for (const key of Object.keys(basis)) {
    if (!(GIT_BASIS_KNOWN_FIELDS as readonly string[]).includes(key)) {
      statusFail(`git_basis has unknown field "${key}"`);
    }
  }
  for (const key of ['head', 'branch', 'worktree'] as const) {
    expectSafeText(basis[key], `git_basis.${key}`);
  }
  return { head: basis.head as string, branch: basis.branch as string, worktree: basis.worktree as string };
}

/**
 * Build the sparse counter view: only non-zero counters, in canonical
 * MES_ANOMALY_COUNTERS order; the field is omitted when nothing is non-zero.
 */
function sparseCounters(tuple: MesStatusTuple): Readonly<Partial<Record<MesAnomalyCounterKey, number>>> | undefined {
  if (tuple.counters === undefined) return undefined;
  const out: Partial<Record<MesAnomalyCounterKey, number>> = {};
  let any = false;
  for (const key of MES_ANOMALY_COUNTERS) {
    const value = tuple.counters[key];
    if (value !== undefined && value > 0) {
      out[key] = value;
      any = true;
    }
  }
  return any ? out : undefined;
}

/**
 * Pure primary (L1) projection of a validated status tuple.
 *
 * @param input a status tuple (as persisted by the bootstrap seed); unknown
 * fields fail closed.
 * @returns the sparse status view; never mutates `input`.
 * @throws {MesStatusError} on any fail-closed input.
 */
export function projectSparseStatus(input: unknown): MesSparseStatus {
  const tuple = expectStatusTuple(input);
  const counters = sparseCounters(tuple);
  return {
    scope: tuple.scope,
    phase: tuple.phase,
    required_skill: tuple.required_skill,
    ...(counters !== undefined ? { counters } : {}),
  };
}

/**
 * Pure bounded detail (L2) projection of the durable seed record.
 *
 * The detail view is the primary projection plus ONLY the allowed L2 fields
 * the durable facts carry (Git basis / accepted Plan ref / Plan digest).
 * It never mutates the input, is deterministic, and fails closed on any
 * unknown / routing field (`next_action`, `route`, `reasoning`, ...).
 *
 * @param input the validated seed record (as produced by
 * `readMesSeedRecord` / `seedMesBootstrap`).
 * @returns the bounded detail view.
 * @throws {MesStatusError} on any fail-closed input.
 */
export function projectDetailStatus(input: unknown): MesDetailStatus {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    statusFail('detail input must be the seed record object');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(SEED_RECORD_KNOWN_FIELDS as readonly string[]).includes(key)) {
      statusFail(`detail input has unknown field "${key}"`);
    }
  }
  const tuple = expectStatusTuple(record.status);
  const base = projectSparseStatus(tuple);
  const gitBasis = record.git_basis !== undefined ? expectGitBasis(record.git_basis) : undefined;
  if (record.accepted_plan_ref !== undefined) {
    expectSafeText(record.accepted_plan_ref, 'accepted_plan_ref');
  }
  if (record.plan_digest !== undefined) {
    expectSafeText(record.plan_digest, 'plan_digest');
  }
  if (record.candidate_plan_ref !== undefined) {
    expectSafeText(record.candidate_plan_ref, 'candidate_plan_ref');
  }
  if (record.planning_verification_result_ref !== undefined) {
    expectSafeText(record.planning_verification_result_ref, 'planning_verification_result_ref');
  }
  return {
    ...base,
    ...(gitBasis !== undefined ? { git_basis: gitBasis } : {}),
    ...(record.accepted_plan_ref !== undefined ? { accepted_plan_ref: record.accepted_plan_ref as string } : {}),
    ...(record.plan_digest !== undefined ? { plan_digest: record.plan_digest as string } : {}),
    ...(record.candidate_plan_ref !== undefined ? { candidate_plan_ref: record.candidate_plan_ref as string } : {}),
    ...(record.planning_verification_result_ref !== undefined
      ? { planning_verification_result_ref: record.planning_verification_result_ref as string }
      : {}),
  };
}

/**
 * Deterministic human-readable rendering of the primary projection
 * (mes.md normal example: `S01 / EXECUTE`, `skill=proofloop-execute`,
 * then one `key=value` line per non-zero counter).
 */
export function formatSparseStatus(projection: MesSparseStatus): string {
  const lines = [`${projection.scope} / ${projection.phase}`, `skill=${projection.required_skill}`];
  if (projection.counters !== undefined) {
    for (const key of MES_ANOMALY_COUNTERS) {
      const value = projection.counters[key];
      if (value !== undefined && value > 0) {
        lines.push(`${key}=${value}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Deterministic human-readable rendering of the bounded detail projection:
 * the primary lines plus one line per allowed detail field the durable
 * facts actually carry (git_head/git_branch/git_worktree,
 * accepted_plan_ref, plan_digest). No route / next-action / reasoning text
 * is ever rendered.
 */
export function formatDetailStatus(projection: MesDetailStatus): string {
  const lines = formatSparseStatus(projection).split('\n');
  if (projection.git_basis !== undefined) {
    lines.push(`git_head=${projection.git_basis.head}`);
    lines.push(`git_branch=${projection.git_basis.branch}`);
    lines.push(`git_worktree=${projection.git_basis.worktree}`);
  }
  if (projection.accepted_plan_ref !== undefined) {
    lines.push(`accepted_plan_ref=${projection.accepted_plan_ref}`);
  }
  if (projection.plan_digest !== undefined) {
    lines.push(`plan_digest=${projection.plan_digest}`);
  }
  if (projection.candidate_plan_ref !== undefined) {
    lines.push(`candidate_plan_ref=${projection.candidate_plan_ref}`);
  }
  if (projection.planning_verification_result_ref !== undefined) {
    lines.push(`planning_verification_result_ref=${projection.planning_verification_result_ref}`);
  }
  if (projection.project_terminal !== undefined) {
    lines.push(`project_terminal=${projection.project_terminal.state}`);
  }
  return lines.join('\n');
}

/**
 * Closed Slice execution states (contracts.md §5.1 / §2.4, S03-A-T02).
 * The projection derives ONLY the member the durable facts support and
 * never invents a state the facts cannot signal (CLEANUP_PENDING is part of
 * the legal closed set; with the current fact vocabulary it is not emitted,
 * matching E2E-15: a cleanup failure keeps the business state INTEGRATED).
 */
export const MES_SLICE_EXECUTE_STATES = [
  'EXECUTING',
  'SLICE_CANDIDATE_READY',
  'CV_PASSED',
  'READY_TO_INTEGRATE',
  'INTEGRATED',
  'CLEANUP_PENDING',
  'CLEANED',
  'REPLAN',
  'BLOCKED_BY',
] as const;
export type MesSliceExecuteStateValue = (typeof MES_SLICE_EXECUTE_STATES)[number];

/** Per-task L2 projection (S03-A-T02). */
export interface MesTaskExecuteState {
  readonly task_id: string;
  readonly task_status: MesTaskStatus;
  readonly depends_on_task_ids: readonly string[];
  /** Effective blocker: direct blocked_by_task_id or propagated from a
   * blocked dependency along the real depends_on_task_ids edge. */
  readonly blocked_by?: string;
}

/** Per-slice L2 projection (S03-A-T02). */
export interface MesSliceExecuteState {
  readonly slice_id: string;
  readonly state: MesSliceExecuteStateValue;
  /** Propagated effective blocker of the slice (task id), when blocked. */
  readonly blocked_by?: string;
  /** True while an integration git fact exists without a cleanup git fact (§2.4). */
  readonly cleanup_pending?: boolean;
  /** Latest result_ref of the slice's result facts (fact order). */
  readonly latest_result_ref?: string;
  /** Latest finding fact_id of the slice's finding facts (fact order). */
  readonly latest_finding_ref?: string;
  /** candidate_ref of the slice's candidate git fact, when present. */
  readonly candidate_ref?: string;
  /** candidate_ref of the slice's integration git fact, when present. */
  readonly integration_ref?: string;
}

/**
 * Bounded execute L2 detail view: slices + tasks projected deterministically
 * from the durable MES facts (S03-A-T02).
 */
export interface MesExecuteDetail {
  readonly slices: readonly MesSliceExecuteState[];
  readonly tasks: readonly MesTaskExecuteState[];
}

/**
 * Read-only L2 execute projection (S03-A-T02, PO-S03-A-03 / PO-S03-A-04).
 *
 * Derives Slice / Task execution state from DURABLE FACTS ONLY (the
 * S03-A-T01-validated task-fact closed payload fields depends_on_task_ids /
 * blocked_by_task_id / task_status plus the git / finding /
 * finding_disposition execute facts). It is Plan-independent (never parses
 * Plan text), deterministic, read-only, emits NO next action / route /
 * reasoning (HP-001 / STATIC-05 / HP-007), never invents a field the facts
 * do not carry, and fails closed on non-array input or unknown fact kinds.
 *
 * Slice state rule (first match wins):
 *   1. cleanup git fact          → CLEANED
 *   2. integration git fact      → INTEGRATED (+ cleanup_pending)
 *   3. any blocked task          → BLOCKED_BY (+ propagated blocked_by)
 *   4. PLAN_GAP disposition      → REPLAN
 *   5. CV PASS + candidate git   → READY_TO_INTEGRATE
 *   6. CV PASS finding           → CV_PASSED
 *   7. all tasks TASK_COMPLETE   → SLICE_CANDIDATE_READY
 *   8. otherwise                 → EXECUTING
 *
 * @throws {MesStatusError} on any fail-closed input.
 */
export function projectExecuteDetail(facts: readonly MesFactEnvelope[]): MesExecuteDetail {
  if (!Array.isArray(facts)) {
    statusFail('execute detail input must be an array of validated MES facts');
  }
  const kindSet = new Set<string>(MES_FACT_KINDS as readonly string[]);
  for (const fact of facts) {
    if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) {
      statusFail('execute detail input facts must be envelope objects');
    }
    const kind = (fact as MesFactEnvelope).fact_kind;
    if (typeof kind !== 'string' || !kindSet.has(kind)) {
      statusFail(`execute detail input fact has unknown fact_kind ${JSON.stringify(kind)}`);
    }
    // Fail closed on malformed KNOWN facts (the closed payload the projection
    // consumes): the projection must never derive from a shape the envelope
    // validator would reject.
    const envelope = fact as MesFactEnvelope;
    if (kind === 'task') {
      if (typeof envelope.task_status !== 'string' || !(MES_TASK_STATUSES as readonly string[]).includes(envelope.task_status)) {
        statusFail(`task fact ${JSON.stringify(envelope.fact_id)} carries a non-closed task_status`);
      }
      const taskId = envelope.scope?.task_id;
      if (typeof taskId !== 'string' || !MES_TASK_ID_RE.test(taskId)) {
        statusFail(`task fact ${JSON.stringify(envelope.fact_id)} requires a canonical task_id scope`);
      }
      const dependsOn = envelope.depends_on_task_ids;
      if (!Array.isArray(dependsOn)) {
        statusFail(`task fact ${JSON.stringify(envelope.fact_id)} requires a depends_on_task_ids array`);
      } else {
        const seenTaskIds = new Set<string>();
        for (const dep of dependsOn) {
          if (typeof dep !== 'string' || !MES_TASK_ID_RE.test(dep)) {
            statusFail(`task fact ${JSON.stringify(envelope.fact_id)} depends_on_task_ids contains a non-canonical task id`);
          }
          if (seenTaskIds.has(dep)) {
            statusFail(`task fact ${JSON.stringify(envelope.fact_id)} depends_on_task_ids contains a duplicate task id`);
          }
          seenTaskIds.add(dep);
        }
      }
      if (envelope.blocked_by_task_id !== undefined && (typeof envelope.blocked_by_task_id !== 'string' || !MES_TASK_ID_RE.test(envelope.blocked_by_task_id))) {
        statusFail(`task fact ${JSON.stringify(envelope.fact_id)} carries a non-canonical blocked_by_task_id`);
      }
    } else if (kind === 'git') {
      // All-or-nothing execute payload + closed git_subkind (CV-S03-A-R2).
      const gitFields = ['git_subkind', 'candidate_ref', 'candidate_base_ref', 'commit_sha', 'changed_files'] as const;
      const presentGit = gitFields.filter((field) => envelope[field] !== undefined);
      if (presentGit.length > 0 && presentGit.length < gitFields.length) {
        statusFail(`git fact ${JSON.stringify(envelope.fact_id)} carries a partial execute payload (all-or-nothing)`);
      }
      if (envelope.git_subkind !== undefined && (typeof envelope.git_subkind !== 'string' || !(MES_GIT_SUBKINDS as readonly string[]).includes(envelope.git_subkind))) {
        statusFail(`git fact ${JSON.stringify(envelope.fact_id)} carries a non-closed git_subkind`);
      }
    } else if (kind === 'finding') {
      // Verifier closed verdict + claim are REQUIRED (CV-S03-A-R2).
      if (typeof envelope.verifier_verdict !== 'string' || !(MES_VERIFIER_VERDICTS as readonly string[]).includes(envelope.verifier_verdict)) {
        statusFail(`finding fact ${JSON.stringify(envelope.fact_id)} requires a closed verifier_verdict`);
      }
      if (typeof envelope.claimed_route_code !== 'string' || !(MES_ROUTE_CODES as readonly string[]).includes(envelope.claimed_route_code)) {
        statusFail(`finding fact ${JSON.stringify(envelope.fact_id)} requires a closed claimed_route_code`);
      }
    } else if (kind === 'finding_disposition') {
      // Brain-owned arbitration closed shape (§2.2.3) is REQUIRED.
      if (typeof envelope.disposition_ref !== 'string' || envelope.disposition_ref.length === 0) {
        statusFail(`finding_disposition fact ${JSON.stringify(envelope.fact_id)} requires a disposition_ref`);
      }
      if (typeof envelope.finding_ref !== 'string' || envelope.finding_ref.length === 0) {
        statusFail(`finding_disposition fact ${JSON.stringify(envelope.fact_id)} requires a finding_ref`);
      }
      if (typeof envelope.finding_disposition !== 'string' || !(MES_FINDING_DISPOSITIONS as readonly string[]).includes(envelope.finding_disposition)) {
        statusFail(`finding_disposition fact ${JSON.stringify(envelope.fact_id)} requires a closed finding_disposition`);
      }
      if (typeof envelope.claimed_route_code !== 'string' || !(MES_ROUTE_CODES as readonly string[]).includes(envelope.claimed_route_code)) {
        statusFail(`finding_disposition fact ${JSON.stringify(envelope.fact_id)} requires a closed claimed_route_code`);
      }
      if (!Array.isArray(envelope.basis_refs)) {
        statusFail(`finding_disposition fact ${JSON.stringify(envelope.fact_id)} requires a basis_refs array`);
      }
      if (typeof envelope.reason !== 'string' || envelope.reason.length === 0) {
        statusFail(`finding_disposition fact ${JSON.stringify(envelope.fact_id)} requires a non-empty reason`);
      }
      if (typeof envelope.resume_target !== 'string' || !(MES_RESUME_TARGETS as readonly string[]).includes(envelope.resume_target)) {
        statusFail(`finding_disposition fact ${JSON.stringify(envelope.fact_id)} requires a closed resume_target`);
      }
      const accepted = envelope.accepted_route_code;
      if (accepted !== null && (typeof accepted !== 'string' || !(MES_ROUTE_CODES as readonly string[]).includes(accepted))) {
        statusFail(`finding_disposition fact ${JSON.stringify(envelope.fact_id)} carries a non-closed accepted_route_code`);
      }
    } else if (kind === 'result') {
      // The projection surfaces the durable result ref; it must be present.
      if (typeof envelope.result_ref !== 'string' || envelope.result_ref.length === 0) {
        statusFail(`result fact ${JSON.stringify(envelope.fact_id)} requires a result_ref`);
      }
    }
  }
  const typed = facts as readonly MesFactEnvelope[];
  // (S06-R-C-T02 / PO: contracts.md #/entities/mes-invalid-history-oracle)
  // Relation-invalid immutable history (misbound binding-critical identity)
  // is readable / auditable but NEVER authorizing: it cannot drive the slice
  // completion states (CLEANED / INTEGRATED / READY_TO_INTEGRATE /
  // SLICE_CANDIDATE_READY) or the CV verdict. The oracle classification is a
  // pure function of the durable fact set, so restart / re-hydrate yields the
  // identical projection.
  const oracle = classifyInvalidHistory(typed);
  const nonAuthorizingIds = new Set<string>([...oracle.invalidFactIds, ...oracle.unverifiableFactIds]);
  const isAuthorizing = (fact: MesFactEnvelope): boolean => !nonAuthorizingIds.has(fact.fact_id);

  // --- per-task effective blocked_by (direct wins; propagation along the
  // real depends_on_task_ids edges in fact order; defensive cycle guard).
  const taskFacts = typed.filter((fact) => fact.fact_kind === 'task');
  const taskById = new Map<string, MesFactEnvelope>();
  for (const fact of taskFacts) {
    if (fact.scope?.task_id !== undefined) taskById.set(fact.scope.task_id, fact);
  }
  const effectiveBlocked = new Map<string, string | undefined>();
  const computeBlocked = (taskId: string, visiting: Set<string>): string | undefined => {
    if (effectiveBlocked.has(taskId)) return effectiveBlocked.get(taskId);
    if (visiting.has(taskId)) return undefined;
    visiting.add(taskId);
    const fact = taskById.get(taskId);
    let result: string | undefined;
    if (fact !== undefined) {
      if (fact.blocked_by_task_id !== undefined) {
        result = fact.blocked_by_task_id;
      } else {
        for (const dep of fact.depends_on_task_ids ?? []) {
          const depBlocked = computeBlocked(dep, visiting);
          if (depBlocked !== undefined) {
            result = depBlocked;
            break;
          }
        }
      }
    }
    visiting.delete(taskId);
    effectiveBlocked.set(taskId, result);
    return result;
  };
  for (const fact of taskFacts) {
    if (fact.scope?.task_id !== undefined) computeBlocked(fact.scope.task_id, new Set());
  }

  const tasks: MesTaskExecuteState[] = taskFacts.map((fact) => {
    const taskId = fact.scope?.task_id as string;
    const blocked = effectiveBlocked.get(taskId);
    const out: MesTaskExecuteState = {
      task_id: taskId,
      task_status: fact.task_status as MesTaskStatus,
      depends_on_task_ids: fact.depends_on_task_ids ?? [],
      ...(blocked !== undefined ? { blocked_by: blocked } : {}),
    };
    return out;
  });

  // --- per-slice grouping (first-appearance order is deterministic).
  const sliceOrder: string[] = [];
  const sliceFacts = new Map<string, MesFactEnvelope[]>();
  for (const fact of typed) {
    const sliceId = fact.scope?.slice_id;
    if (sliceId === undefined) continue;
    if (!sliceFacts.has(sliceId)) {
      sliceFacts.set(sliceId, []);
      sliceOrder.push(sliceId);
    }
    sliceFacts.get(sliceId)!.push(fact);
  }

  const slices: MesSliceExecuteState[] = sliceOrder.map((sliceId) => {
    const sliceFactSet = sliceFacts.get(sliceId)!;
    const tasksInSlice = sliceFactSet.filter((fact) => fact.fact_kind === 'task');
    const gitFacts = sliceFactSet.filter((fact) => fact.fact_kind === 'git');
    const findings = sliceFactSet.filter((fact) => fact.fact_kind === 'finding');
    const results = sliceFactSet.filter((fact) => fact.fact_kind === 'result');
    const dispositions = sliceFactSet.filter((fact) => fact.fact_kind === 'finding_disposition');

    const cleanupFact = gitFacts.find((fact) => fact.git_subkind === 'cleanup');
    const integrationFact = gitFacts.find((fact) => fact.git_subkind === 'integration');
    const candidateFact = gitFacts.find((fact) => fact.git_subkind === 'candidate');
    // (S06-R-C-T02) Completion-driving git facts must be relation-valid: a
    // misbound (relation-invalid) git fact stays readable/auditable but can
    // never project CLEANED / INTEGRATED / READY_TO_INTEGRATE.
    const authorizingCleanupFact = cleanupFact !== undefined && isAuthorizing(cleanupFact) ? cleanupFact : undefined;
    const authorizingIntegrationFact = integrationFact !== undefined && isAuthorizing(integrationFact) ? integrationFact : undefined;
    const authorizingCandidateFact = candidateFact !== undefined && isAuthorizing(candidateFact) ? candidateFact : undefined;
    // CV verdict uses the LATEST AUTHORIZING finding (facts order): a
    // historical PASS followed by a later FINDINGS must NOT keep the slice
    // CV_PASSED, and a relation-invalid finding never drives cvPass — the
    // projection reflects the current authorizing durable facts only.
    const authorizingFindings = findings.filter((fact) => isAuthorizing(fact));
    const latestAuthorizingFinding = authorizingFindings.length > 0 ? authorizingFindings[authorizingFindings.length - 1] : undefined;
    const cvPass = latestAuthorizingFinding !== undefined && latestAuthorizingFinding.verifier_verdict === 'PASS';
    // Disposition verdict uses the LATEST disposition (facts order): an
    // earlier PLAN_GAP disposition followed by a later non-PLAN_GAP one no
    // longer projects REPLAN (CV-S03-A-R2).
    const latestDisposition = dispositions.length > 0 ? dispositions[dispositions.length - 1] : undefined;
    const replan = latestDisposition !== undefined && latestDisposition.accepted_route_code === 'PLAN_GAP';

    const firstBlockedTask = tasksInSlice.find((fact) => {
      const taskId = fact.scope?.task_id;
      return taskId !== undefined && effectiveBlocked.get(taskId) !== undefined;
    });
    const blockedBy = firstBlockedTask?.scope?.task_id !== undefined
      ? effectiveBlocked.get(firstBlockedTask.scope.task_id)
      : undefined;

    let state: MesSliceExecuteStateValue;
    if (authorizingCleanupFact !== undefined) {
      state = 'CLEANED';
    } else if (authorizingIntegrationFact !== undefined) {
      state = 'INTEGRATED';
    } else if (blockedBy !== undefined) {
      state = 'BLOCKED_BY';
    } else if (replan) {
      state = 'REPLAN';
    } else if (cvPass && authorizingCandidateFact !== undefined) {
      state = 'READY_TO_INTEGRATE';
    } else if (cvPass) {
      state = 'CV_PASSED';
    } else if (
      tasksInSlice.length > 0 &&
      tasksInSlice.every((fact) => isAuthorizing(fact) && fact.task_status === 'TASK_COMPLETE')
    ) {
      state = 'SLICE_CANDIDATE_READY';
    } else {
      state = 'EXECUTING';
    }

    const lastResult = results.length > 0 ? results[results.length - 1] : undefined;
    const latestFinding = findings.length > 0 ? findings[findings.length - 1] : undefined;
    // Readable refs come from the DURABLE facts (invalid immutable history is
    // never hidden): refs stay observable even when they do not authorize.
    const out: MesSliceExecuteState = {
      slice_id: sliceId,
      state,
      ...(blockedBy !== undefined ? { blocked_by: blockedBy } : {}),
      ...(integrationFact !== undefined && cleanupFact === undefined ? { cleanup_pending: true } : {}),
      ...(lastResult?.result_ref !== undefined ? { latest_result_ref: lastResult.result_ref } : {}),
      ...(latestFinding !== undefined ? { latest_finding_ref: latestFinding.fact_id } : {}),
      ...(candidateFact?.candidate_ref !== undefined ? { candidate_ref: candidateFact.candidate_ref } : {}),
      ...(integrationFact?.candidate_ref !== undefined ? { integration_ref: integrationFact.candidate_ref } : {}),
    };
    return out;
  });

  return { slices, tasks };
}

/**
 * Validate a read-only projection input fact array (S05-C-T01): every fact
 * must be an envelope with a CLOSED fact kind and pass the full envelope
 * validator (unknown fields, inherited Stage/Work/Result binding on
 * project_ready, malformed git_basis / created_by / authority_refs and
 * partial accepted-stage shapes fail closed with a TYPED MesStatusError —
 * never an untyped TypeError). Shared by the terminal and cycle-filtered
 * projections.
 */
function expectValidatedFacts(facts: unknown, label: string): MesFactEnvelope[] {
  if (!Array.isArray(facts)) {
    statusFail(`${label} input must be an array of validated MES facts`);
  }
  const kindSet = new Set<string>(MES_FACT_KINDS as readonly string[]);
  const typed: MesFactEnvelope[] = [];
  for (const fact of facts) {
    if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) {
      statusFail(`${label} input facts must be envelope objects`);
    }
    try {
      validateMesFactEnvelope(fact);
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        statusFail(`${label} input fact fails closed envelope validation: ${(err as Error).message}`);
      }
      throw err;
    }
    const kind = (fact as MesFactEnvelope).fact_kind;
    if (typeof kind !== 'string' || !kindSet.has(kind)) {
      statusFail(`${label} input fact has unknown fact_kind ${JSON.stringify(kind)}`);
    }
    typed.push(fact as MesFactEnvelope);
  }
  return typed;
}

/**
 * Durable delivery-cycle identity of a fact (architecture
 * delivery-cycle-semantics "Field placement is closed"): plan-bound facts
 * carry the opaque ID INSIDE `plan_binding`; ONLY the `project_ready`
 * terminal carries it at the envelope TOP LEVEL. Legacy retained facts /
 * recovery_baseline facts carry none and stay history-only.
 */
function cycleOf(fact: MesFactEnvelope): string | undefined {
  if (fact.fact_kind === 'project_ready') {
    return fact.delivery_cycle_id;
  }
  return fact.plan_binding?.delivery_cycle_id;
}

/**
 * (S06-A-T01 / PO-S06-A-01) Durable-fact currentness observation per the
 * current-terminal-currentness-oracle (contracts §2.3 /
 * /entities/current-terminal-currentness-oracle; STATIC-30/31; E2E-23):
 * terminal validation precedes selection, then open_cycle_ids decide the
 * current cycle.
 *
 * Participating terminals are the cycle-bearing `project_ready` facts whose
 * delivery_cycle_id appears among the cycle-bearing PVR/PA planning bindings
 * (planning_verification_result / plan_acceptance with a closed
 * plan_binding.delivery_cycle_id). Every participating terminal's OWN
 * cycle-scoped accepted-stage support relation must exactly close, and the
 * participating succession chain must be one acyclic chain with a unique tip
 * (missing target / branch / directed cycle / repeated cycle / multiple tips
 * fail closed typed AUTHORITY_GAP). Foreign-cycle terminals (no planning
 * binding for their cycle in this store) and no-cycle legacy terminals are
 * history-only and NEVER poison selection (EC-2 / EC-5 / CV S05-C-cv-1).
 *
 * open_cycle_ids = cycle-bearing PVR/PA cycles with NO legal matching
 * terminal. Open determination depends ONLY on "no legal matching terminal",
 * never on accepted-stage support completeness — a cycle whose accepted-stage
 * supports all exist but that has no terminal stays OPEN (PRE_TERMINAL /
 * distinguishable pre-terminal STAGE_ACCEPTED). Exactly one open cycle is
 * current (open-cycle precedence); zero open cycles select the validated chain
 * tip (current legal PROJECT_READY); no cycle-bearing terminal means legacy
 * history only. Currentness never consults insertion order / fact ID ordering
 * / Git recency / filenames / Map / timestamp / actionToken / transport / a
 * second pointer (STATIC-30).
 */
interface CurrentnessObservation {
  /** Distinct delivery-cycle ids carried by cycle-bearing PVR/PA planning bindings. */
  readonly planningCycles: string[];
  /** Cycle-bearing project_ready whose delivery_cycle_id appears among planningCycles. */
  readonly participating: MesFactEnvelope[];
  /** open_cycle_ids: planningCycles with no legal matching participating terminal. */
  readonly openCycleIds: string[];
  /** Validated unique chain tip (zero open cycles) — the current legal PROJECT_READY terminal. */
  readonly tip?: MesFactEnvelope;
}

function observeCurrentness(typed: readonly MesFactEnvelope[]): CurrentnessObservation {
  const planningSet = new Set<string>();
  for (const fact of typed) {
    if (fact.fact_kind !== 'planning_verification_result' && fact.fact_kind !== 'plan_acceptance') continue;
    const cycle = fact.plan_binding?.delivery_cycle_id;
    if (cycle !== undefined && cycle.length > 0) planningSet.add(cycle);
  }
  const planningCycles = [...planningSet];
  const cycleTerminals = typed.filter(
    (fact) =>
      fact.fact_kind === 'project_ready' &&
      typeof fact.delivery_cycle_id === 'string' &&
      fact.delivery_cycle_id.length > 0,
  );
  // (CV S06-A-cv-1 + cv-2) Terminal relation validation precedes selection:
  // every cycle-bearing terminal in the CHAIN DOMAIN (participating +
  // supersedes-connected predecessors/successors, or all cycle-bearing
  // terminals when none participates) must exactly close against its OWN
  // cycle-scoped accepted-stage supports — including a retained
  // legacy_cycle_anchor or legal chain tip whose cycle has no PVR/PA planning
  // binding. Disconnected cycle-bearing terminals that are neither
  // participating nor supersedes-connected stay history-only and NEVER enter
  // closure or chain validation (EC-2 / EC-5 / CV S05-C-cv-1 poisonFree).
  const participating = cycleTerminals.filter((fact) => planningSet.has(fact.delivery_cycle_id as string));
  const cycleTerminalById = new Map(cycleTerminals.map((fact) => [fact.fact_id, fact] as const));
  const inChain = new Set<string>(participating.map((fact) => fact.fact_id));
  const chainDomain: MesFactEnvelope[] = [...participating];
  let chainGrew = true;
  while (chainGrew) {
    chainGrew = false;
    for (const terminal of [...chainDomain]) {
      const ref = terminal.supersedes_project_ready_ref;
      if (typeof ref === 'string' && ref.length > 0) {
        const predecessor = cycleTerminalById.get(ref);
        if (predecessor !== undefined && !inChain.has(predecessor.fact_id)) {
          inChain.add(predecessor.fact_id);
          chainDomain.push(predecessor);
          chainGrew = true;
        }
      }
      for (const other of cycleTerminals) {
        if (other.supersedes_project_ready_ref === terminal.fact_id && !inChain.has(other.fact_id)) {
          inChain.add(other.fact_id);
          chainDomain.push(other);
          chainGrew = true;
        }
      }
    }
  }
  const effectiveChain = chainDomain.length > 0 ? chainDomain : [...cycleTerminals];
  // (CV S06-A-cv-2) Complete closure validation: EVERY terminal in the chain
  // domain must exactly close against its own cycle-scoped supports — not just
  // participating ones. A malformed connected anchor (in chainDomain via
  // supersedes) and a malformed lone cycle-bearing terminal (zero participating
  // → effectiveChain = all cycle-bearing) previously escaped closure validation.
  for (const terminal of effectiveChain) {
    const closureError = verifyProjectReadySupportError(terminal, typed);
    if (closureError !== undefined) {
      statusAuthorityGap(`cycle-bearing terminal ${JSON.stringify(terminal.fact_id)} relation is broken: ${closureError}`);
    }
  }
  // (CV S06-A-cv-3 + cv-4 + cv-5 + cv-6) Complete-graph validation covers
  // EVERY cycle-bearing terminal in the durable set — no history-only filter
  // may exclude a cycle-bearing terminal before validation. A legal (own
  // relation closes) INDEPENDENT cycle-bearing terminal disjoint from the
  // participating chain forms a second chain, a cycle-bearing terminal
  // carrying an explicit supersedes_project_ready_ref (null or exact ref)
  // is a NORMAL/submitted shape, and a malformed OMITTED-predecessor
  // cycle-bearing terminal — with NO own-cycle accepted-stage support cohort
  // (cv-5) or with a NON-EMPTY but non-closing own-cycle support cohort
  // (cv-6) — is a malformed/half-new submitted terminal: “A malformed or
  // half-new submitted terminal is not treated as history” (contracts §2.3)
  // and a legacy_cycle_anchor requires “its own support closure remains
  // valid” (architecture delivery-cycle-semantics). ALL of them enter the
  // complete graph validation: the whole set can never be one acyclic chain
  // with a unique tip → fail closed AUTHORITY_GAP (oracle Succession
  // relation: all cycle-bearing terminals in the resulting durable set must
  // form one acyclic chain). Only a NO-CYCLE legacy terminal (never present
  // in cycleTerminals) is history-only; a retained foreign-cycle cohort
  // stays legal only as a chain-connected predecessor whose own relation
  // closes, never as an invisible disjoint root.
  const graphTerminals = cycleTerminals;
  if (graphTerminals.length > 0) {
    const graphError = verifyProjectReadySuccessionGraphError(graphTerminals);
    if (graphError !== undefined) {
      statusAuthorityGap(`cycle-bearing terminal succession is broken: ${graphError}`);
    }
  }
  const closedCycles = new Set(participating.map((fact) => fact.delivery_cycle_id as string));
  const openCycleIds = planningCycles.filter((cycle) => !closedCycles.has(cycle));
  let tip: MesFactEnvelope | undefined;
  if (openCycleIds.length === 0 && graphTerminals.length > 0) {
    const referenced = new Set(
      graphTerminals
        .filter((fact) => typeof fact.supersedes_project_ready_ref === 'string')
        .map((fact) => fact.supersedes_project_ready_ref as string),
    );
    const tips = graphTerminals.filter((fact) => !referenced.has(fact.fact_id));
    if (tips.length !== 1) {
      statusAuthorityGap('cycle-bearing terminals must form one acyclic chain with a unique tip');
    }
    tip = tips[0];
  }
  return { planningCycles, participating, openCycleIds, tip };
}

/** Ascending canonical accepted-stage support ids bound to `cycle` (undefined = no-cycle cohort). */
function cycleScopedAcceptedStageIds(typed: readonly MesFactEnvelope[], cycle: string | undefined): string[] {
  return typed
    .filter(
      (fact) =>
        isDurableAcceptedStageSupport(fact) &&
        (fact.plan_binding?.delivery_cycle_id ?? undefined) === (cycle ?? undefined),
    )
    .map((fact) => fact.scope!.stage_id)
    .sort();
}

/**
 * (S06 post-recovery Authority update) The SINGLE ambiguity-cohort gate EVERY
 * closure / readiness-declaring projection must pass before it may declare
 * `exact_closure:true`, `CURRENT_PROJECT_READY`, `PRE_TERMINAL` support ids or a
 * terminal detail: the cycle's AMBIGUITY cohort (cycle-matched durable
 * accepted-stage supports minus the PROVABLY-superseded members) must not carry
 * a duplicate Stage ID. `cycle === undefined` denotes the no-cycle legacy cohort.
 *
 * It reuses the SHARED `duplicateAcceptedStageSupportError` single source
 * (`terminal.ts`) — which itself reuses the single canonical classification
 * source — so no projection can invent its own cohort rule and the write
 * boundary / read projections can never disagree.
 */
function assertUnambiguousCycleSupport(typed: readonly MesFactEnvelope[], cycle: string | undefined): void {
  const duplicateSupportError = duplicateAcceptedStageSupportError(typed, cycle);
  if (duplicateSupportError !== undefined) {
    statusAuthorityGap(duplicateSupportError);
  }
}

/**
 * Resolve the unique current NORMAL cycle per the currentness oracle
 * (open-cycle precedence / validated chain tip).
 *
 * @throws {MesStatusError} code `authority-gap` when no current cycle can be
 *   proven (multiple open cycles, broken chain, or legacy history only).
 */
function resolveCurrentCycle(
  typed: readonly MesFactEnvelope[],
  opts: { currentCycleId?: string },
): string {
  const obs = observeCurrentness(typed);
  if (opts.currentCycleId !== undefined) {
    const pinned = opts.currentCycleId;
    if (pinned.length === 0) {
      statusAuthorityGap('current cycle id must be a non-empty opaque string');
    }
    // Cross-cycle check against OPEN cycles only: retained closed-cycle facts
    // are history-only and never poison the pinned observation.
    for (const cycle of obs.openCycleIds) {
      if (cycle !== pinned) {
        statusAuthorityGap(`cross-cycle durable facts: found open cycle ${JSON.stringify(cycle)} while observing current cycle ${JSON.stringify(pinned)}`);
      }
    }
    if (obs.openCycleIds.length === 0 && obs.tip !== undefined && obs.tip.delivery_cycle_id !== pinned) {
      statusAuthorityGap(`cross-cycle durable facts: chain tip cycle ${JSON.stringify(obs.tip.delivery_cycle_id)} while observing current cycle ${JSON.stringify(pinned)}`);
    }
    return pinned;
  }
  if (obs.openCycleIds.length === 1) return obs.openCycleIds[0];
  if (obs.openCycleIds.length > 1) {
    statusAuthorityGap(`cross-cycle durable facts: multiple open cycles present (${obs.openCycleIds.join(', ')}) — status cannot select the current cycle`);
  }
  if (obs.tip !== undefined) return obs.tip.delivery_cycle_id as string;
  statusAuthorityGap('no current NORMAL delivery cycle: no open cycle and no cycle-bearing terminal (legacy history only)');
}

/**
 * Cycle-filtered status currentness (S05-C-T01 / PO-S05-C-01).
 *
 * Derives the current scope / phase / required_skill of the current NORMAL
 * delivery cycle from the DURABLE MES facts alone (mes.md status 一级视图,
 * contracts.md §2.3, architecture delivery-cycle-semantics "Current phase is
 * cycle-filtered"):
 *
 *   1. the unique current cycle is the opaque delivery_cycle_id shared by
 *      the cycle's plan-bound facts (`project_ready` carries it top-level);
 *   2. the current Stage is the UNIQUE same-cycle in-flight candidate — a
 *      same-cycle stage-scoped planning binding or downstream fact whose
 *      stage has NO same-cycle accepted-stage support (zero / multiple /
 *      cross-cycle / no stage provenance fail closed typed AUTHORITY_GAP);
 *   3. the phase is derived from the same-cycle scope shapes: stage-only
 *      Review work/result/finding → REVIEW; task or slice/task-scoped
 *      execution facts → EXECUTE; otherwise the current planning binding
 *      → PLANNING. The `task` fact participates in the current-scope
 *      candidate.
 *
 * The projection is read-only, deterministic, Plan-independent, emits NO
 * next action / route / reasoning (HP-001 / HP-007 / STATIC-05) and never
 * infers the current Stage from Map, filenames, Git ordering, insertion
 * order or opaque refs (STATIC-30). Legacy retained facts (no cycle
 * field) stay history-only and never participate.
 *
 * @throws {MesStatusError} on any fail-closed input; code `authority-gap`
 *   when the current-cycle observation path cannot be proven.
 */
export interface MesCycleFilteredStatus {
  /** The unique opaque current delivery-cycle ID. */
  readonly cycle_id: string;
  /** The current in-flight Stage (`^S\d+$`). */
  readonly scope: string;
  /**
   * Cycle-filtered per-stage phase: PLANNING / EXECUTE / REVIEW, or
   * STAGE_ACCEPTED once the unique in-flight stage has a same-cycle
   * accepted-stage support (contracts §5.1 closed per-stage phase set).
   */
  readonly phase: MesStatusPhase;
  /** The required skill of the projected phase (never invented). */
  readonly required_skill: string;
}

export function projectCycleFilteredStatus(
  facts: unknown,
  opts: { currentCycleId?: string } = {},
): MesCycleFilteredStatus {
  const typed = expectValidatedFacts(facts, 'cycle-filtered status');
  const currentCycle = resolveCurrentCycle(typed, opts);
  // (repair CV S06-A-restart-cv-1 + S06 post-recovery Authority update) Duplicate
  // same-cycle accepted-stage supports are ambiguous provenance: the SINGLE
  // ambiguity-cohort gate fails closed typed AUTHORITY_GAP before phase projection
  // instead of deduping silently via Set. A superseded-generation support is
  // provably non-current and never joins the cohort; a misbound one does.
  assertUnambiguousCycleSupport(typed, currentCycle);

  // Same-cycle non-terminal facts: `project_ready` never carries a scope.
  const sameCycle: MesFactEnvelope[] = [];
  for (const fact of typed) {
    if (cycleOf(fact) === currentCycle && fact.fact_kind !== 'project_ready') sameCycle.push(fact);
  }
  // Stage provenance is REQUIRED for every same-cycle fact: a cycle-carrying
  // fact without a canonical stage scope can never supply the current Stage
  // identity (STATIC-30 / PO-S05-C-01).
  for (const fact of sameCycle) {
    const stageId = fact.scope?.stage_id;
    if (typeof stageId !== 'string' || !CANONICAL_STAGE_ID_RE.test(stageId)) {
      statusAuthorityGap(`same-cycle fact ${JSON.stringify(fact.fact_id)} carries no canonical stage provenance (scope.stage_id must match /^S\d+$/)`);
    }
  }

  // (S06 post-recovery Authority update; supersedes the EC-3 distinct-plan-
  // identity check) Accepted-Plan currentness is decided by the (stage, cycle)
  // accepted-Plan generation chain tip — NOT by the set of distinct plan
  // identities among same-cycle PVR/PA facts. Candidate `planning_verification_
  // result` facts are verification evidence only and do not participate;
  // several PVRs / generations may legitimately carry a different or an
  // identical (accepted) plan ref and digest. A broken / ambiguous chain
  // (branch, directed cycle, multiple tips, cross-stage / cross-cycle / missing
  // target, explicit null predecessor next to another generation) fails closed
  // typed AUTHORITY_GAP; no generation is ever chosen by (ref, digest),
  // fingerprint, insertion order or newest-wins.
  const generationTips = resolvePlanAcceptanceGenerationTips(sameCycle);
  if (!generationTips.ok) {
    statusAuthorityGap(`accepted-Plan generation succession is ambiguous in the current cycle: ${generationTips.error}`);
  }

  const candidateStages = [...new Set(sameCycle.map((fact) => fact.scope!.stage_id))].sort();
  // (S06-R-C-T02) A relation-invalid accepted-stage support is readable
  // immutable history but can NEVER authorize STAGE_ACCEPTED: the stage it
  // claims to close stays in-flight on its remaining valid same-cycle facts.
  const oracle = classifyInvalidHistory(typed);
  const nonAuthorizingIds = new Set<string>([...oracle.invalidFactIds, ...oracle.unverifiableFactIds]);
  const acceptedStages = new Set(
    typed
      .filter(
        (fact) =>
          isDurableAcceptedStageSupport(fact) &&
          fact.plan_binding?.delivery_cycle_id === currentCycle &&
          !nonAuthorizingIds.has(fact.fact_id),
      )
      .map((fact) => fact.scope!.stage_id),
  );
  const inFlight = candidateStages.filter((stage) => !acceptedStages.has(stage));

  if (inFlight.length === 1) {
    const stage = inFlight[0];
    const stageFacts = sameCycle.filter((fact) => fact.scope!.stage_id === stage);
    // mes.md current-phase ordering: stage-only Review work/result/finding
    // → REVIEW (Review wins over the coexisting slice-scoped execute facts).
    const reviewFact = stageFacts.some(
      (fact) =>
        (fact.fact_kind === 'work' || fact.fact_kind === 'result' || fact.fact_kind === 'finding') &&
        fact.scope?.slice_id === undefined &&
        fact.scope?.task_id === undefined,
    );
    // task or slice/task-scoped execution facts → EXECUTE; the `task` fact
    // must participate in the current-scope candidate.
    const executeFact = stageFacts.some((fact) => {
      if (fact.fact_kind === 'task') return true;
      const scope = fact.scope;
      return (
        (fact.fact_kind === 'work' ||
          fact.fact_kind === 'result' ||
          fact.fact_kind === 'git' ||
          fact.fact_kind === 'finding' ||
          fact.fact_kind === 'finding_disposition') &&
        (scope?.slice_id !== undefined || scope?.task_id !== undefined)
      );
    });
    const phase: MesStatusPhase = reviewFact ? 'REVIEW' : executeFact ? 'EXECUTE' : 'PLANNING';
    const requiredSkill = phase === 'REVIEW' ? 'stage-reviewer' : phase === 'EXECUTE' ? 'proofloop-execute' : 'proofloop-plan';
    return { cycle_id: currentCycle, scope: stage, phase, required_skill: requiredSkill };
  }
  if (inFlight.length === 0 && candidateStages.length === 1) {
    // The unique in-flight stage now carries a same-cycle accepted-stage
    // support (contracts §5.1 STAGE_ACCEPTED).
    return { cycle_id: currentCycle, scope: candidateStages[0], phase: 'STAGE_ACCEPTED', required_skill: 'stage-reviewer' };
  }
  if (inFlight.length === 0) {
    statusAuthorityGap('no in-flight stage: every same-cycle candidate stage has a same-cycle accepted-stage support (missing in-flight candidate)');
  }
  statusAuthorityGap(`ambiguous in-flight stage: ${inFlight.length} same-cycle candidate stages without accepted-stage support (${inFlight.join(', ')})`);
}

/**
 * Cycle-filtered bounded detail (L2) view (S05-C-T02 / PO-S05-C-03): the
 * sparse cycle-filtered status plus ONLY the allowed detail fields the
 * same-cycle binding facts actually carry — the durable Git basis and the
 * accepted Plan ref / digest (from the current-cycle plan_acceptance
 * binding) and the candidate Plan ref / planning verification result ref
 * (from the current-cycle planning_verification_result). Fields for which
 * no durable fact exists are omitted, never invented; no next action /
 * route / reasoning is emitted (HP-001 / STATIC-05 / HP-007).
 */
export function projectCycleFilteredDetail(
  facts: unknown,
  opts: { currentCycleId?: string } = {},
): MesDetailStatus {
  const typed = expectValidatedFacts(facts, 'cycle-filtered detail');
  const current = projectCycleFilteredStatus(typed, opts);
  const base: MesDetailStatus = {
    scope: current.scope,
    phase: current.phase,
    required_skill: current.required_skill,
  };
  // (EC-4 / CV S05-C-cv-1) The detail binding facts are resolved from the
  // SELECTED current stage + cycle only: a same-cycle PA/PVR of another
  // stage (e.g. an earlier accepted stage of the same cycle) must never
  // supply the binding detail via first fact-order.
  // (S06 post-recovery Authority update) The accepted detail comes from the
  // CURRENT accepted generation — the unique tip of the (stage, cycle)
  // `plan_acceptance` chain — never from an earlier generation and never from
  // first fact-order. A broken / ambiguous chain was already rejected as typed
  // AUTHORITY_GAP by the filtered status projection; no generation is guessed
  // here.
  const generationCandidates = typed.filter(
    (fact) =>
      fact.fact_kind === 'plan_acceptance' &&
      fact.scope?.stage_id === current.scope &&
      cycleOf(fact) === current.cycle_id,
  );
  const generationTips = resolvePlanAcceptanceGenerationTips(generationCandidates);
  const paFact = generationTips.ok && generationTips.tips.length === 1 ? generationTips.tips[0] : undefined;
  const candidatePvrs = typed.filter(
    (fact) =>
      fact.fact_kind === 'planning_verification_result' &&
      fact.scope?.stage_id === current.scope &&
      cycleOf(fact) === current.cycle_id,
  );
  // Candidate `planning_verification_result` facts are evidence only: when a
  // current generation exists its bound PVR is the honest detail; otherwise a
  // single unique candidate PVR is unambiguous, and multiple distinct
  // candidates are never resolved by insertion order / fact-id order (the
  // candidate detail is simply omitted).
  const pvrFact = (() => {
    if (paFact !== undefined && paFact.plan_binding?.binding_stage === 'accepted') {
      const boundRef = paFact.plan_binding.verification_result_ref;
      return candidatePvrs.find((fact) => fact.result_ref === boundRef);
    }
    return candidatePvrs.length === 1 ? candidatePvrs[0] : undefined;
  })();
  const extra: Record<string, string | MesGitBasis> = {};
  if (paFact !== undefined) {
    const binding = paFact.plan_binding;
    if (binding !== undefined && binding.binding_stage === 'accepted') {
      extra.accepted_plan_ref = binding.accepted_plan_ref;
      if (binding.plan_digest !== undefined) extra.plan_digest = binding.plan_digest;
    }
    if (paFact.git_basis !== undefined) extra.git_basis = paFact.git_basis;
  } else if (pvrFact !== undefined && pvrFact.git_basis !== undefined) {
    // Candidate-only state (PLAN_READY not yet accepted): the candidate
    // binding's Git basis is the honest durable detail.
    extra.git_basis = pvrFact.git_basis;
  }
  if (pvrFact !== undefined && pvrFact.plan_binding?.binding_stage === 'candidate') {
    extra.candidate_plan_ref = pvrFact.plan_binding.candidate_plan_ref;
    if (pvrFact.result_ref !== undefined) extra.planning_verification_result_ref = pvrFact.result_ref;
  }
  const adjunct = projectTerminalAdjunct(typed, opts);
  return {
    ...base,
    ...(extra as Partial<MesDetailStatus>),
    ...(adjunct !== undefined ? { project_terminal: adjunct } : {}),
  };
}
/**
 * Terminal (PROJECT_READY) read-only detail view (S04-C-T01,
 * PO-S04-C-01 / E2E-06 / contracts.md §5.1).
 *
 * Deterministically projects the PROJECT_READY terminal state from the
 * SAME validated durable MES facts as `projectExecuteDetail`: whether a
 * durable `project_ready` terminal fact exists, its closed
 * `planned_stage_ids` (ascending canonical), the durable accepted-stage
 * support set (ascending canonical; machine-closed predicate
 * `isDurableAcceptedStageSupport` reused from terminal.ts — never
 * re-implemented here) and whether the two EXACTLY close.
 *
 * The projection NEVER fabricates a completion state (STATIC-10 /
 * HP-007): a broken relation (missing / extra / mismatched / duplicate
 * support, malformed planned set, conflicting terminal facts, unknown
 * fact kind, non-envelope input) fails closed with a typed
 * `MesStatusError`. A durable set WITHOUT a terminal fact projects
 * project_ready=false with the honest support set — it is a legal
 * pre-terminal state, not an error.
 *
 * Re-read of the same durable facts (restart) yields the identical
 * view — deterministic, no hidden state, no cache — and the output
 * contains no next action / route / reasoning / Stage graph
 * (HP-001 / STATIC-05 / STATIC-20).
 */
export interface MesTerminalDetail {
  /** Whether a durable `project_ready` terminal fact exists. */
  readonly project_ready: boolean;
  /**
   * Ascending canonical planned Stage IDs carried by the terminal fact
   * (empty when no terminal fact exists).
   */
  readonly planned_stage_ids: readonly string[];
  /**
   * Ascending canonical Stage IDs of the durable accepted-stage
   * supports projected from the facts (empty when none exist).
   */
  readonly accepted_stage_support_ids: readonly string[];
  /**
   * Whether the planned set exactly equals the accepted-stage support
   * set. Only ever true when a terminal fact exists AND the durable
   * relation exactly closes; every broken closure fails closed above.
   */
  readonly exact_closure: boolean;
}

/**
 * Pure read-only terminal projection (S04-C-T01, PO-S04-C-01).
 *
 * @throws {MesStatusError} on any fail-closed input (unknown kind,
 *   non-envelope shape, malformed terminal payload, or a durable
 *   terminal relation that does not exactly close).
 */
export function projectTerminalDetail(
  facts: unknown,
  opts: { currentCycleId?: string } = {},
): MesTerminalDetail {
  const typed = expectValidatedFacts(facts, 'terminal detail');

  // (S06-A-T01 / PO-S06-A-01) Current-cycle identity follows the
  // currentness oracle: terminal validation precedes selection (participating
  // cycle-bearing terminals only — foreign-cycle and no-cycle legacy facts are
  // history-only and never poison selection); exactly one open cycle is
  // current; zero open cycles select the validated chain tip (current legal
  // PROJECT_READY); no cycle-bearing terminal means legacy history only
  // (currentCycle undefined). Pinned observations cross-check OPEN cycles and
  // the chain-tip cycle only — retained closed-cycle facts never poison.
  const observation = observeCurrentness(typed);
  let currentCycle: string | undefined;
  if (opts.currentCycleId !== undefined) {
    const pinned = opts.currentCycleId;
    if (pinned.length === 0) {
      statusAuthorityGap('current cycle id must be a non-empty opaque string');
    }
    for (const cycle of observation.openCycleIds) {
      if (cycle !== pinned) {
        statusAuthorityGap(`cross-cycle durable facts: found open cycle ${JSON.stringify(cycle)} while observing current cycle ${JSON.stringify(pinned)}`);
      }
    }
    if (observation.openCycleIds.length === 0 && observation.tip !== undefined && observation.tip.delivery_cycle_id !== pinned) {
      statusAuthorityGap(`cross-cycle durable facts: chain tip cycle ${JSON.stringify(observation.tip.delivery_cycle_id)} while observing current cycle ${JSON.stringify(pinned)}`);
    }
    currentCycle = pinned;
  } else if (observation.openCycleIds.length === 1) {
    currentCycle = observation.openCycleIds[0];
  } else if (observation.openCycleIds.length > 1) {
    statusAuthorityGap(`cross-cycle durable facts: multiple open cycles present (${observation.openCycleIds.join(', ')}) — status cannot select the current cycle`);
  } else if (observation.tip !== undefined) {
    currentCycle = observation.tip.delivery_cycle_id;
  } else {
    currentCycle = undefined; // legacy history only
  }

  // Cycle-scoped accepted-stage support cohort (ascending canonical): a
  // current NORMAL terminal binds ONLY the same-cycle accepted-stage
  // supports; a legacy terminal (no cycle) binds ONLY the no-cycle
  // supports. Legacy and current cohorts with the SAME planned Stage IDs
  // coexist and rebuild independently (E2E-23 / STATIC-30 / PO-S05-C-02).
  // (cv-s06-r-c2) Relation-invalid immutable history supports are readable
  // but NEVER authorize terminal completion: a support with a misbound
  // binding-critical identity (typo against a RESOLVED canonical PVR/PA
  // relation) closes nothing. Relation-unverifiable supports (legacy
  // no-cycle / no-plan_acceptance durable history whose canonical relation
  // cannot be resolved from the set) keep their frozen authorizing
  // semantics — the established S04/S05-C/S06-A terminal contract (only a
  // misbound support can never close). Restart / re-hydrate of the same
  // durable bytes classify identically.
  // (S06 post-recovery Authority update / F3) This projection DECLARES a terminal
  // detail (support ids + `exact_closure`) and therefore must pass the SAME
  // ambiguity-cohort gate as `projectCycleFilteredStatus` / `projectTerminalAdjunct`
  // BEFORE emitting anything: a cycle whose cycle-matched supports carry a
  // duplicate Stage ID (a misbound support is a cohort member; a superseded one
  // is not) can never be projected as a closed terminal — it fails closed typed
  // AUTHORITY_GAP, exactly like the phase and adjunct projections.
  assertUnambiguousCycleSupport(typed, currentCycle);
  const terminalOracle = classifyInvalidHistory(typed);
  const terminalNonAuthorizing = new Set<string>(terminalOracle.invalidFactIds);
  // Authorizing view: relation-invalid facts are excluded from closure
  // computation everywhere below (support cohort + verifyProjectReadySupportError)
  // so a misbound support can never close a terminal; relation-unverifiable
  // and relation-valid durable facts remain (frozen terminal contract).
  const authorizingFacts = typed.filter((fact) => !terminalNonAuthorizing.has(fact.fact_id));
  const supportIds: string[] = authorizingFacts
    .filter(
      (fact) =>
        isDurableAcceptedStageSupport(fact) &&
        (fact.plan_binding?.delivery_cycle_id ?? undefined) === (currentCycle ?? undefined) &&
        !terminalNonAuthorizing.has(fact.fact_id),
    )
    .map((fact) => fact.scope!.stage_id)
    .sort();
  const supportSeen = new Set<string>();
  for (const id of supportIds) {
    if (supportSeen.has(id)) {
      statusFail(`duplicate accepted-stage support for stage ${JSON.stringify(id)} in the persisted result set`);
    }
    supportSeen.add(id);
  }

  // Terminal facts of the CURRENT cohort only: historical/legacy terminals
  // never participate in current phase/route; they are attached as
  // historical detail only when no new cycle has started.
  const terminalFacts = typed.filter(
    (fact) =>
      fact.fact_kind === 'project_ready' &&
      (fact.delivery_cycle_id ?? undefined) === (currentCycle ?? undefined),
  );
  // (EC-5 / CV S05-C-cv-1) Duplicate current-cycle PROJECT_READY terminals
  // are duplicate terminal provenance: a cycle's legal current cohort is
  // EXACTLY ONE terminal fact. Two same-cycle terminals (identical or
  // conflicting payload) fail typed AUTHORITY_GAP — the projection never
  // picks one silently. Legacy history (currentCycle undefined) keeps its
  // deterministic collapse of identical payloads (S04 behavior) and valid
  // history/current coexistence stays legal.
  if (currentCycle !== undefined && terminalFacts.length > 1) {
    statusAuthorityGap(`duplicate current-cycle PROJECT_READY terminals (${terminalFacts.length} facts carry delivery_cycle_id ${JSON.stringify(currentCycle)}) — a legal current cohort is exactly one terminal`);
  }
  if (terminalFacts.length === 0) {
    // Legal pre-terminal state: no current-cycle terminal → the project is
    // simply not ready; the honest cycle-scoped support set is still
    // projected and no closure is invented.
    return {
      project_ready: false,
      planned_stage_ids: [],
      accepted_stage_support_ids: supportIds,
      exact_closure: false,
    };
  }

  // Every current-cohort terminal must EXACTLY close against the SAME
  // persisted result set (submitted ∪ retained facts): planned set == the
  // cycle-scoped accepted-stage support set, ascending canonical form.
  // Missing / extra / mismatched / duplicate / malformed planned sets fail
  // closed (RESULT_INVALID / RESULT_BINDING_MISMATCH, contracts §7);
  // CONFLICTING terminal facts (different planned sets in the same cycle)
  // cannot both close against one durable set, so at least one fails
  // closed deterministically (E2E-06 / STATIC-10 / PO-S05-C-02).
  let planned: readonly string[] = [];
  for (const pr of terminalFacts) {
    const closureError = verifyProjectReadySupportError(pr, authorizingFacts);
    if (closureError !== undefined) {
      statusFail(closureError);
    }
    const prPlanned = pr.planned_stage_ids as readonly string[] | undefined;
    if (planned.length > 0 && JSON.stringify(prPlanned ?? []) !== JSON.stringify(planned)) {
      statusFail('conflicting project_ready facts with different planned Stage IDs in the current cycle');
    }
    planned = prPlanned ?? [];
  }
  return {
    project_ready: true,
    planned_stage_ids: [...planned],
    accepted_stage_support_ids: supportIds,
    exact_closure: true,
  };
}

/**
 * Projection-only `project_terminal` adjunct states (contracts §2.3.1): the
 * current legal PROJECT_READY terminal, the unique open-cycle pre-terminal, or
 * a valid historical (legacy/no-cycle) terminal. The adjunct is NOT a MES fact,
 * phase, route, cache or second store (STATIC-14 / STATIC-30/31).
 */
export type MesProjectTerminalState = 'CURRENT_PROJECT_READY' | 'HISTORICAL_PROJECT_READY' | 'PRE_TERMINAL';

/**
 * Projection-only `project_terminal` observation adjunct (contracts §2.3.1
 * closed shape): `CURRENT_PROJECT_READY` (unique legal chain-tip terminal +
 * non-empty cycle + exact project_ready_ref + exact planned/support closure +
 * exact_closure: true), `PRE_TERMINAL` (unique open cycle — even when all
 * accepted-stage supports exist the cycle stays open; omits project_ready_ref;
 * project_ready: false; planned_stage_ids: []; support ids from that current
 * cycle; exact_closure: false), or `HISTORICAL_PROJECT_READY` (a valid terminal
 * that is not current, incl. legacy/no-cycle history; delivery_cycle_id omitted
 * only for legacy HISTORICAL; no routing authority). `project_ready_ref` is a
 * projection of the durable fact's `fact_id`, never a new pointer.
 */
export interface MesProjectTerminalAdjunct {
  readonly state: MesProjectTerminalState;
  readonly project_ready: boolean;
  readonly project_ready_ref?: string;
  readonly delivery_cycle_id?: string;
  readonly planned_stage_ids: readonly string[];
  readonly accepted_stage_support_ids: readonly string[];
  readonly exact_closure: boolean;
}

/**
 * Project the projection-only `project_terminal` adjunct (PO-S06-A-02).
 *
 * Follows the same currentness oracle as the status projections: exactly one
 * open cycle → PRE_TERMINAL; zero open cycles with a validated chain tip →
 * CURRENT_PROJECT_READY (exact terminal/cycle identity + exact closure); zero
 * open cycles without a cycle-bearing terminal → HISTORICAL_PROJECT_READY for a
 * valid no-cycle legacy terminal; nothing provable → `undefined` (adjunct
 * omitted). Ambiguity (multiple open cycles / multi-tip / broken chain / broken
 * participating terminal relation) fails closed typed AUTHORITY_GAP.
 */
export function projectTerminalAdjunct(
  facts: unknown,
  opts: { currentCycleId?: string } = {},
): MesProjectTerminalAdjunct | undefined {
  const typed = expectValidatedFacts(facts, 'project_terminal adjunct');
  // (cv-s06-r-c2 + S06 post-recovery Authority update / F1) Currentness and
  // closure are derived from the SAME cohort rules as every other projection and
  // as the write boundary: `verifyProjectReadySupportError` (closure cohort =
  // cycle-matched supports − relation-invalid; ambiguity cohort = cycle-matched
  // supports − provably-superseded) resolves against the FULL validated fact set,
  // never against a pre-filtered view. A relation-invalid support therefore still
  // cannot drive CURRENT_PROJECT_READY / PRE_TERMINAL (it is excluded from the
  // closure cohort) while a misbound one still makes the cohort ambiguous (it is
  // NOT provably superseded) — so this projection can no longer disagree with
  // `projectTerminalDetail` / `projectCycleFilteredStatus`. `authorizingFacts` is
  // used ONLY for the reported support-id cohort (relation-invalid excluded),
  // never for currentness selection.
  const adjunctOracle = classifyInvalidHistory(typed);
  const adjunctNonAuthorizing = new Set<string>(adjunctOracle.invalidFactIds);
  const authorizingFacts = typed.filter((fact) => !adjunctNonAuthorizing.has(fact.fact_id));
  const obs = observeCurrentness(typed);
  if (opts.currentCycleId !== undefined) {
    const pinned = opts.currentCycleId;
    if (pinned.length === 0) {
      statusAuthorityGap('current cycle id must be a non-empty opaque string');
    }
    for (const cycle of obs.openCycleIds) {
      if (cycle !== pinned) {
        statusAuthorityGap(`cross-cycle durable facts: found open cycle ${JSON.stringify(cycle)} while observing current cycle ${JSON.stringify(pinned)}`);
      }
    }
    if (obs.openCycleIds.length === 0 && obs.tip !== undefined && obs.tip.delivery_cycle_id !== pinned) {
      statusAuthorityGap(`cross-cycle durable facts: chain tip cycle ${JSON.stringify(obs.tip.delivery_cycle_id)} while observing current cycle ${JSON.stringify(pinned)}`);
    }
  }
  if (obs.openCycleIds.length === 1) {
    const cycle = obs.openCycleIds[0];
    // (repair CV S06-A-restart-cv-1 + S06 post-recovery Authority update) The
    // open cycle's own accepted-stage support cohort must not carry a duplicate
    // Stage ID — the SAME single ambiguity-cohort gate as every other
    // closure-declaring projection (a superseded member is excluded; a misbound
    // member is not), so PRE_TERMINAL can never project duplicates.
    assertUnambiguousCycleSupport(typed, cycle);
    return {
      state: 'PRE_TERMINAL',
      project_ready: false,
      delivery_cycle_id: cycle,
      planned_stage_ids: [],
      accepted_stage_support_ids: cycleScopedAcceptedStageIds(authorizingFacts, cycle),
      exact_closure: false,
    };
  }
  if (obs.openCycleIds.length > 1) {
    statusAuthorityGap(`cross-cycle durable facts: multiple open cycles present (${obs.openCycleIds.join(', ')}) — status cannot select the current cycle`);
  }
  if (obs.tip !== undefined) {
    const tip = obs.tip;
    // (S06 post-recovery Authority update / F1) Declaring
    // `CURRENT_PROJECT_READY` + `exact_closure:true` requires the tip cycle's
    // ambiguity cohort to be unambiguous — the SAME gate as every other
    // closure-declaring projection. Without it a raw fact set that the write
    // boundary already refuses (terminal + current-generation support + misbound
    // support for one Stage) could still be projected as an exact closure here
    // while `projectTerminalDetail` / `projectCycleFilteredStatus` fail closed.
    assertUnambiguousCycleSupport(typed, tip.delivery_cycle_id as string);
    return {
      state: 'CURRENT_PROJECT_READY',
      project_ready: true,
      project_ready_ref: tip.fact_id,
      delivery_cycle_id: tip.delivery_cycle_id as string,
      planned_stage_ids: [...(tip.planned_stage_ids ?? [])],
      accepted_stage_support_ids: cycleScopedAcceptedStageIds(authorizingFacts, tip.delivery_cycle_id),
      exact_closure: true,
    };
  }
  // Zero open cycles + no cycle-bearing terminal: a VALID no-cycle legacy
  // terminal is attached as HISTORICAL detail only (no routing authority);
  // broken / conflicting legacy relations fail closed (S04 legacy behavior).
  // (S06 post-recovery Authority update) The no-cycle legacy cohort obeys the
  // SAME ambiguity-cohort gate (`cycle === undefined`): a duplicate Stage ID
  // among the no-cycle supports — a superseded member never exists without a
  // cycle, so any same-Stage duplicate counts — can never be projected as an
  // exact legacy closure.
  assertUnambiguousCycleSupport(typed, undefined);
  const legacy = typed.filter(
    (fact) => fact.fact_kind === 'project_ready' && (fact.delivery_cycle_id ?? undefined) === undefined,
  );
  if (legacy.length === 0) return undefined;
  let planned: readonly string[] | undefined;
  for (const pr of legacy) {
    const closureError = verifyProjectReadySupportError(pr, authorizingFacts);
    if (closureError !== undefined) statusFail(closureError);
    const prPlanned = pr.planned_stage_ids ?? [];
    if (planned !== undefined && JSON.stringify(prPlanned) !== JSON.stringify(planned)) {
      statusFail('conflicting legacy project_ready facts with different planned Stage IDs');
    }
    planned = prPlanned;
  }
  return {
    state: 'HISTORICAL_PROJECT_READY',
    project_ready: true,
    project_ready_ref: legacy[0].fact_id,
    planned_stage_ids: [...(planned ?? [])],
    accepted_stage_support_ids: cycleScopedAcceptedStageIds(authorizingFacts, undefined),
    exact_closure: true,
  };
}

/** Human renderer of the projection-only adjunct (contracts §2.3.1: renders `project_terminal=<state>`). */
export function formatProjectTerminalAdjunct(adjunct: MesProjectTerminalAdjunct): string {
  return `project_terminal=${adjunct.state}`;
}