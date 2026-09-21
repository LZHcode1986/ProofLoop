/**
 * @proofloop/runtime — MES durable fact envelope & fact-kind binding types
 * (S01-A-T01).
 *
 * The minimal closed-set, versioned MES fact envelope for the S01
 * persistence seam. Only the fact kinds S01 writes and re-reads are part of
 * the closed set: Project / Stage / Plan binding / Work / Result / Git,
 * plus the NORMAL planning durable facts (S02-B-T01):
 * planning_verification_result / plan_acceptance.
 *
 * Schema semantics are owned by the MES Contract (.agents/contracts/brain/
 * mes.md) and the Contracts Authority (tech-spec/contracts.md §2.2 / §2.2.2);
 * this module only defines the machine shape — it does not copy Authority
 * prose, does not create a second state machine, and carries no
 * Receipt/Manifest/Gate semantics (STATIC-05/13/14).
 */
import type { VNextSchemaVersion } from '@proofloop/kernel';

/** Versioned MES fact envelope schema version (vNext, `2`). */
export const MES_SCHEMA_VERSION: VNextSchemaVersion = 2;

/**
 * Closed set of MES fact kinds covered by the persistence seam.
 * Matches the fact categories the MES Contract exposes; any other kind is
 * unknown and fails closed. S02 adds the two NORMAL planning durable kinds
 * (contracts.md §2.2.2): the pre-accept SPV verdict fact and the promoted
 * acceptance fact.
 */
export const MES_FACT_KINDS = [
  'project',
  'stage',
  'plan_binding',
  'planning_verification_result',
  'plan_acceptance',
  'work',
  'result',
  'git',
  'task',
  'finding',
  'finding_disposition',
  // Brain-owned disaster recovery baseline (tech-spec recovery contract).
  'recovery_baseline',
  // S04-A-T01 terminal fact: all planned Stages accepted → PROJECT_READY
  // (contracts.md §5.1 / acceptance E2E-06).
  'project_ready',
] as const;
export type MesFactKind = (typeof MES_FACT_KINDS)[number];
/** Closed plan-binding stages: pre-accept candidate vs promoted accepted. */
export const MES_PLAN_BINDING_STAGES = ['candidate', 'accepted'] as const;
export type MesPlanBindingStage = (typeof MES_PLAN_BINDING_STAGES)[number];

/** Closed SPV verdicts a candidate planning-verification result can carry. */
export const MES_PLAN_VERDICTS = ['PLAN_READY', 'FINDINGS', 'BLOCKED'] as const;
export type MesPlanVerdict = (typeof MES_PLAN_VERDICTS)[number];

/** Only Brain/Host writes MES facts; Agent narrative never does. */
export const MES_CREATED_BY = ['brain'] as const;
export type MesCreatedBy = (typeof MES_CREATED_BY)[number];
/** Closed disaster recovery pre-image status. */
export const MES_RECOVERY_PREIMAGE_STATUSES = ['UNRECOVERABLE'] as const;
export type MesRecoveryPreimageStatus = (typeof MES_RECOVERY_PREIMAGE_STATUSES)[number];

/** Canonical Slice ID shape (e.g. `S01-A`). */
export const MES_SLICE_ID_RE = /^S\d+-[A-Z]+$/;

/** Canonical Task ID shape (e.g. `S01-A-T01`). */
export const MES_TASK_ID_RE = /^S\d+-[A-Z]+-T\d+$/;


/**
 * Closed per-task execution statuses (contracts.md §5.1). The projection
 * only VALIDATES these values, never derives or migrates them (HP-001).
 */
export const MES_TASK_STATUSES = [
  'PLANNED',
  'IN_PROGRESS',
  'TASK_RESULT_SUBMITTED',
  'TASK_COMPLETE',
] as const;
export type MesTaskStatus = (typeof MES_TASK_STATUSES)[number];

/** Closed verifier verdicts a finding fact can carry (contracts.md §2.2.3). */
export const MES_VERIFIER_VERDICTS = ['PASS', 'FINDINGS', 'BLOCKED'] as const;
export type MesVerifierVerdict = (typeof MES_VERIFIER_VERDICTS)[number];

/** Closed Brain finding dispositions (contracts.md §2.2.3). */
export const MES_FINDING_DISPOSITIONS = ['ACCEPTED', 'VERIFIER_OVERREACH'] as const;
export type MesFindingDisposition = (typeof MES_FINDING_DISPOSITIONS)[number];

/** Closed route codes (contracts.md §2.2.3: IMPLEMENTATION_DEFECT | PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | RUNTIME_BLOCKER | USER_DECISION_REQUIRED | EVIDENCE_GAP). */
export const MES_ROUTE_CODES = [
  'IMPLEMENTATION_DEFECT',
  'PLAN_GAP',
  'AUTHORITY_GAP',
  'TECHNICAL_UNKNOWN',
  'RUNTIME_BLOCKER',
  'USER_DECISION_REQUIRED',
  'EVIDENCE_GAP',
] as const;
export type MesRouteCode = (typeof MES_ROUTE_CODES)[number];

/** Closed resume targets (contracts.md §2.2.3). */
export const MES_RESUME_TARGETS = [
  'producer',
  'planner',
  'authority-owner',
  'research',
  'recovery',
  'verifier-lane',
] as const;
export type MesResumeTarget = (typeof MES_RESUME_TARGETS)[number];

/** Closed git execute payload subkinds (S03-A-T01). */
export const MES_GIT_SUBKINDS = ['candidate', 'integration', 'cleanup'] as const;
export type MesGitSubkind = (typeof MES_GIT_SUBKINDS)[number];
/**
 * Fact scope: `stage_id` is required where the fact is Stage-scoped;
 * `slice_id` / `task_id` are optional refinements. Stage IDs use the shared
 * canonical `^S\d+$` rule (kernel); slice/task IDs use the shapes above.
 */
export interface MesScope {
  readonly stage_id: string;
  readonly slice_id?: string;
  readonly task_id?: string;
}

/**
 * Git basis carried by execution- and Git-bound facts. `head` is the raw
 * `git rev-parse HEAD` output; `worktree` is the root-relative worktree.
 */
export interface MesGitBasis {
  readonly head: string;
  readonly branch: string;
  readonly worktree: string;
}

/**
 * Fact-kind-appropriate Plan binding (tech-spec/contracts.md §2.2 binding
 * rule). `candidate` is pre-accept planning verification:
 * `accepted_plan_ref` MUST be present and `null`. `accepted` is the promoted
 * Plan: `accepted_plan_ref` non-null, `source_candidate_plan_ref` MUST equal
 * the promoted ref, and a `verification_result_ref` is required.
 */
export type MesPlanBinding =
  | {
      readonly binding_stage: 'candidate';
      readonly candidate_plan_ref: string;
      /**
       * (S05) Closed opaque NORMAL delivery-cycle identity (contracts
       * §2.2.2 / mes.md / architecture delivery-cycle-semantics). Optional at
       * the schema level so legacy retained plan bindings that lack it keep
       * rehydrating byte-equivalently as history-only without upgrade; when
       * present it must be a non-empty opaque string without control
       * characters (validated in validate.ts / binding.ts).
       */
      readonly delivery_cycle_id?: string;
      readonly accepted_plan_ref: null;
      readonly verdict: MesPlanVerdict;
      readonly plan_digest?: string;
    }
  | {
      readonly binding_stage: 'accepted';
      readonly accepted_plan_ref: string;
      readonly source_candidate_plan_ref: string;
      readonly verification_result_ref: string;
      readonly plan_digest?: string;
      /**
       * (S05) Closed opaque NORMAL delivery-cycle identity (contracts
       * §2.2.2 / mes.md / architecture delivery-cycle-semantics). Optional at
       * the schema level so legacy retained plan bindings that lack it keep
       * rehydrating byte-equivalently as history-only without upgrade; when
       * present it must be a non-empty opaque string without control
       * characters (validated in validate.ts / binding.ts). Promotion
       * preserves the candidate's cycle (promotePlanReadyToAccepted).
       */
      readonly delivery_cycle_id?: string;
    };

/**
 * The versioned MES fact envelope. Every fact answers: what happened
 * (fact_kind), to which scope (scope), under which fact-kind-appropriate
 * Plan binding / work identity (plan_binding / work_id), against which Git
 * basis (git_basis), and which durable ref supports it (result_ref).
 */
export interface MesFactEnvelope {
  readonly schema_version: VNextSchemaVersion;
  readonly fact_id: string;
  readonly fact_kind: MesFactKind;
  readonly created_by: MesCreatedBy;
  readonly authority_refs: string[];
  readonly scope?: MesScope;
  readonly work_id?: string;
  readonly result_ref?: string;
  readonly plan_binding?: MesPlanBinding;
  readonly git_basis?: MesGitBasis;
  /**
   * Verifier role of the pre-accept SPV reply (contracts.md §2.2.2 YAML
   * `verifier_role`). Exactly the `planning_verification_result` fact kind
   * carries it; every other kind fails closed on it.
   */
  readonly verifier_role?: string;
  /**
   * SPV dispatch token of the pre-accept reply (contracts.md §2.2.2 YAML
   * `action_token`). Exactly the `planning_verification_result` fact kind
   * carries it; every other kind fails closed on it.
   */
  readonly action_token?: string;
  /**
   * Closed per-kind Execute payload fields (S03-A-T01). Each field is
   * optional at the envelope level and REQUIRED/validated per fact kind by
   * the kind validator — unknown kinds, non-closed values and transport /
   * session metadata (Agent Name, pane, Link message id, sent/idle/done,
   * next_task_id / next_action / route / reasoning) fail closed.
   */

  // `task` kind (contracts.md §5.1): closed task status + canonical task-id
  // dependency/blocked set. depends_on_task_ids must exactly equal the
  // accepted-Plan dependency edge set (validated against the brand-bound
  // accepted_plan_task_graph at the store boundary).
  readonly task_status?: MesTaskStatus;
  readonly depends_on_task_ids?: string[];
  readonly blocked_by_task_id?: string;

  // `result` kind (S03-A-T01): closed opaque result_id (durable replay /
  // conflict key) + closed result_payload_digest (64-hex payload key);
  // legacy S01 result facts (is_legacy_s01_result) omit both.
  readonly result_id?: string;
  readonly result_payload_digest?: string;

  // `git` kind (S03-A-T01): closed execute payload consumed by ACK replay
  // and INTEGRATED / cleanup fact projection.
  readonly git_subkind?: MesGitSubkind;
  readonly candidate_ref?: string;
  readonly candidate_base_ref?: string;
  readonly commit_sha?: string;
  readonly changed_files?: string[];

  // `finding` kind (contracts.md §2.2.3): verifier closed verdict + claim.
  readonly verifier_verdict?: MesVerifierVerdict;
  readonly finding_evidence_refs?: string[];
  readonly claimed_route_code?: MesRouteCode;

  // `finding_disposition` kind (contracts.md §2.2.3 YAML, Brain-owned).
  readonly disposition_ref?: string;
  readonly finding_ref?: string;
  readonly finding_disposition?: MesFindingDisposition;
  readonly accepted_route_code?: MesRouteCode | null;
  readonly basis_refs?: string[];
  readonly reason?: string;
  readonly resume_target?: MesResumeTarget;

  /**
   * `project_ready` kind (S04-A-T01 / contracts.md §5.1, acceptance
   * E2E-06): closed terminal payload — the canonical `^S\d+$` planned
   * Stage-ID set (non-empty, de-duplicated, ascending stable). The Brain
   * obtains the planned set from the active Project Stage Map; MES never
   * reads or generates the Map.
   */
  readonly planned_stage_ids?: string[];
  /**
   * (S05-A-T01) Top-level closed opaque NORMAL delivery-cycle identity
   * (contracts §5.1 / architecture delivery-cycle-semantics "Field
   * placement is closed"): EXACTLY the `project_ready` terminal fact
   * carries it at the envelope TOP LEVEL (the terminal still rejects
   * `scope` / `work_id` / `result_ref` / `plan_binding` inheritance,
   * E2E-06). Every other fact kind is plan-bound — the cycle lives INSIDE
   * `plan_binding` (validated by the per-kind position rule in validate.ts
   * / binding.ts), or is absent for recovery_baseline / legacy history.
   * Optional at the schema level so legacy seed/retained terminal facts
   * that lack it keep rehydrating byte-equivalently as history-only; when
   * present it must be a non-empty opaque string without control
   * characters.
   */
  readonly delivery_cycle_id?: string;
  /**
   * (S06-D-T01) Top-level closed NORMAL terminal successor edge
   * (contracts §5.1 / current-terminal-currentness-oracle / architecture
   * delivery-cycle-semantics, STATIC-30 / E2E-23): EXACTLY the `project_ready`
   * terminal fact carries it at the envelope TOP LEVEL, and only together with
   * a top-level `delivery_cycle_id`. `null` = new chain root (no retained
   * cycle-bearing terminal); a string = the exact durable `fact_id` of the
   * unique preceding validated chain tip (different delivery_cycle_id, may be
   * a retained `legacy_cycle_anchor`); omitted = retained pre-update
   * `legacy_cycle_anchor` / no-cycle legacy history (read-only, never
   * backfilled). Every other fact kind carrying it fails closed (position
   * rule in validate.ts / binding.ts).
   */
  readonly supersedes_project_ready_ref?: string | null;
  /**
   * (S06 post-recovery Authority update) Top-level closed accepted-Plan
   * generation successor edge (contracts §2.2.2 / architecture
   * #/entities/planning-acceptance-succession, STATIC-34 / E2E-27): EXACTLY
   * the cycle-bearing `plan_acceptance` accepted generation carries it at
   * the envelope TOP LEVEL, and only together with a
   * `plan_binding.delivery_cycle_id`. `null` = new chain root (no other
   * cycle-bearing generation for this (stage, delivery cycle) exists in
   * submitted ∪ retained facts); a string = the exact durable `fact_id` of
   * the unique preceding chain tip for the same (stage, cycle); omitted =
   * retained pre-update compatibility root / no-cycle legacy history
   * (read-only, never backfilled). Every other fact kind carrying it fails
   * closed (position rule in validate.ts / binding.ts). The generation
   * identity is decided by the chain structure alone — never by
   * (ref, digest), fingerprint, timestamp, insertion order or newest-wins.
   */
  readonly supersedes_plan_acceptance_ref?: string | null;

  /** Closed `recovery_baseline` payload (NORMAL disaster recovery only). */
  readonly recovery_id?: string;
  readonly preimage_status?: MesRecoveryPreimageStatus;
  readonly source_snapshot_sha256?: string;
  readonly source_fact_count?: number;
  readonly forensic_ref?: string;
  readonly audit_ref?: string;
  readonly audit_sha256?: string;
}
