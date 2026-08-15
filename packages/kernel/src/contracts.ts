/**
 * @proofloop/kernel — Canonical Contract Type Definitions
 *
 * This file defines the canonical contract types for external artifact payloads
 * that the kernel validates: Receipt, Manifest, RuntimeLock, Finding, and
 * Finding codes.  These type definitions are drawn from the authority matrix
 * (§4 File / Artifact Contracts, §5 Canonical Type Registry, §7 Error Contracts).
 *
 * These are TYPE DEFINITIONS ONLY (not Zod schemas or validators).
 * Validation functions are added in S01-C-T02.
 */

// ============================================================
// 7. Error Contracts — Finding Codes
// ============================================================

/**
 * Canonical Finding codes enumerated in §7 Error Contracts.
 *
 * All named Finding codes are closed canonical values; any payload
 * carrying an unrecognised code is fail-closed with RUNTIME.SCHEMA_MISMATCH.
 */
export type FindingCode =
  | 'HOST.PROJECT_NOT_TRUSTED'
  | 'HOST.PATH_PROTECTED'
  | 'HOST.TOOL_NOT_ACTIVE'
  | 'HOST.PATH_OUTSIDE_PROJECT'
  | 'RUNTIME.VERSION_MISMATCH'
  | 'RUNTIME.RECEIPT_CHAIN_BROKEN'
  | 'RUNTIME.SCHEMA_MISMATCH'
  | 'DOMAIN.STAGE_NOT_FOUND'
  | 'DOMAIN.INVALID_TRANSITION';

// ============================================================
// 5. Canonical Type Registry — Finding
// ============================================================

/**
 * Structured status finding with a canonical error/warning code,
 * severity level, and human-readable message.
 *
 * The `code` field is a closed literal union of the 9 canonical
 * Finding codes (§7 Error Contracts).  Severity is restricted to
 * 'error' | 'warn'.
 */
export interface Finding {
  /** Canonical error/warning code. */
  code: FindingCode;
  /** Severity level — 'error' or 'warn'. */
  severity: 'error' | 'warn';
  /** Human-readable description of the finding. */
  message: string;
}

// ============================================================
// 4. File / Artifact Contracts — Receipt Type Literals
// ============================================================

/**
 * Canonical Receipt type literal union.
 *
 * See §4 File / Artifact Contracts — 16 receipt types.
 *
 * `GATE_INTERRUPTED` is the additive 11th type (HP-004 / AWI-015 / S05): a
 * stage gate run that was cancelled or timed out. It is NEVER a gate
 * verdict receipt (no PASS/FAIL verdict; the payload carries
 * `reason: 'cancelled' | 'timeout'` and `duration_ms`), never blocks the
 * next action like GATE_FAIL, and never passes the gate like GATE_PASS —
 * the interrupted gate is retryable. The existing 10 types are unchanged.
 *
 * `PROJECT_E2E_PASS` / `PROJECT_E2E_FAIL` / `PROJECT_E2E_BLOCKED` are the
 * additive 14th–16th types (B1c, blueprint §6.4 `run_e2e`): the project-level
 * E2E gate verdict receipts written by `run-project-acceptance`. They live in
 * the shared `project/` category (alongside PROJECT_REVIEW_PASS) but are
 * EVIDENCE artifacts only: they are read and cross-validated by
 * `finalize-project-review` and never participate in project_state
 * derivation — only PROJECT_REVIEW_PASS triggers COMPLETED, so a FAILED E2E
 * run can never prematurely complete the project. Style is aligned with
 * GATE_PASS/GATE_FAIL/GATE_INTERRUPTED. The existing 13 types are unchanged.
 */
export type ReceiptType =
  | 'SLICE_PLAN'
  | 'STAGE_PLAN'
  | 'SPV_PASS'
  | 'TASK_COMPLETE'
  | 'CV_PASS'
  | 'CV_REPAIR'
  | 'SLICE_COMMIT'
  | 'INTEGRATION_PASS'
  | 'GATE_PASS'
  | 'GATE_FAIL'
  | 'GATE_INTERRUPTED'
  | 'STAGE_REVIEW_PASS'
  | 'PROJECT_REVIEW_PASS'
  | 'PROJECT_E2E_PASS'
  | 'PROJECT_E2E_FAIL'
  | 'PROJECT_E2E_BLOCKED';

// ============================================================
// 4. File / Artifact Contracts — Receipt
// ============================================================

/**
 * Immutable receipt artifact.
 *
 * Fields match §4 File / Artifact Contracts:
 * - version: schema version (must be 1)
 * - type: receipt type literal
 * - stage_id: owning stage identifier
 * - slice_id: optional owning slice identifier
 * - timestamp: ISO 8601 creation timestamp
 * - digest: content-addressed digest
 * - previous_digest: optional previous receipt digest for chain linkage
 * - payload: arbitrary payload data
 * - signature: optional future content signing
 */
export interface Receipt {
  /** Schema version (must be 1). */
  version: 1;
  /** Receipt type literal (16-type closed set). */
  type: ReceiptType;
  /** Owning stage identifier. */
  stage_id: string;
  /** Owning slice identifier (optional). */
  slice_id?: string;
  /** ISO 8601 timestamp of creation. */
  timestamp: string;
  /** Content-addressed digest. */
  digest: string;
  /** Previous receipt digest for chain linkage (optional). */
  previous_digest?: string;
  /** Arbitrary payload data. */
  payload: Record<string, unknown>;
  /** Future: content signing (optional). */
  signature?: string;
}

// ============================================================
// 4. File / Artifact Contracts — Proof Obligation
// ============================================================

/**
 * A proof obligation entry within a slice definition.
 */
export interface ProofObligation {
  /** PO identifier. */
  po_id: string;
  /** Behavioral description. */
  behavior: string;
  /** Public seam used for verification. */
  public_seam: string;
  /** Oracle source reference. */
  oracle_source: string;
  /** Success criteria description. */
  success_criteria: string;
  /** Required observation description. */
  required_observation: string;
  /** Applicable risk fact identifiers. */
  applicable_risk_facts: string[];
}

// ============================================================
// 4. File / Artifact Contracts — Runtime Proof Step
// ============================================================

/**
 * Canonical closed set of executable Runtime Proof step types.
 *
 * The seam (§5.3 executable Runtime Proof / Evidence refresh bootstrap
 * contracts) admits exactly `command | service_start | service_stop |
 * probe`; `service_start` may add `readiness_signal`, `service_stop` may
 * add `service_ref`. No second set of types (e.g. `service_probe`,
 * `file_assertion`) may be introduced by any consumer.
 */
export type RuntimeProofStepType =
  | 'command'
  | 'service_start'
  | 'service_stop'
  | 'probe';

/**
 * An executable Runtime Proof step (S09-C-T01 canonical shape).
 *
 * Required fields are `id`, `type`, `executable`, `args`, `cwd`,
 * `timeout_ms` and `expected`. `readiness_signal` is only meaningful for
 * `service_start`, `service_ref` only for `service_stop`; unknown fields,
 * empty `executable`, non-string `args`, non-root-bound `cwd` and
 * non-positive `timeout_ms` are rejected before any Manifest write.
 */
export interface ExecutableRuntimeProofStep {
  /** Step identifier. */
  id: string;
  /** Step type from the canonical closed set. */
  type: RuntimeProofStepType;
  /** Executable command. */
  executable: string;
  /** Command arguments. */
  args: string[];
  /** Root-relative working directory. */
  cwd: string;
  /** Timeout in milliseconds (positive integer). */
  timeout_ms: number;
  /** Expected outcomes. */
  expected: Record<string, unknown>;
  /** Optional service ref for service_stop steps. */
  service_ref?: string;
  /** Optional readiness signal for service_start steps. */
  readiness_signal?: string;
}

/**
 * An explicit not-applicable boundary: a step is either a canonical
 * executable step or `not_applicable{reason}` — never both.
 */
export interface NotApplicableRuntimeProofStep {
  not_applicable: {
    /** Human-readable reason the step does not apply. */
    reason: string;
  };
}

/**
 * Canonical closed union for a single Runtime Proof step: executable step
 * or explicit not-applicable boundary (S09-C-T01).
 */
export type CanonicalRuntimeProofStep =
  | ExecutableRuntimeProofStep
  | NotApplicableRuntimeProofStep;

/**
 * A single proof step in a manifest's runtime_proof section.
 *
 * v1 compatibility shape (kept permissive on purpose: the v1 YAML compiler
 * may emit `not_applicable` alongside executable fields). The canonical
 * vNext seam uses `CanonicalRuntimeProofStep` instead.
 */
export interface RuntimeProofStep {
  /** Step identifier. */
  id: string;
  /** Step type from the canonical closed set. */
  type: RuntimeProofStepType;
  /** Executable command. */
  executable: string;
  /** Command arguments. */
  args: string[];
  /** Working directory. */
  cwd: string;
  /** Timeout in milliseconds. */
  timeout_ms: number;
  /** Expected outcomes. */
  expected?: Record<string, unknown>;
  /** Optional not-applicable reason. */
  not_applicable?: Record<string, unknown>;
  /** Optional service ref for service_stop steps. */
  service_ref?: string;
  /** Optional readiness signal for service_start steps. */
  readiness_signal?: string;
}

// ============================================================
// 4. File / Artifact Contracts — Manifest
// ============================================================

/**
 * A slice entry within a stage Manifest.
 *
 * Each entry identifies one slice belonging to the stage with its
 * goal, observable outcome, public seam, dependencies, proof obligations,
 * tasks, risk facts, evidence path, and CV minimum level.
 */
export interface ManifestSlice {
  /** Slice identifier (e.g., "S01-A"). */
  slice_id: string;
  /** Slice goal description. */
  goal: string;
  /** Observable outcome of the slice. */
  observable_outcome: string;
  /** Public seam for verification. */
  public_seam: string;
  /** Dependency slice identifiers. */
  dependencies: string[];
  /** Proof obligations for this slice. */
  proof_obligations: ProofObligation[];
  /** Task identifiers belonging to this slice. */
  tasks: string[];
  /** Risk facts applicable to this slice. */
  risk_facts: string[];
  /** Evidence file path. */
  evidence_path: string;
  /** Minimum CV verification level. */
  cv_minimum_level: string;
}

/**
 * Stage manifest artifact consumed by ReconcileService.
 *
 * See §4 File / Artifact Contracts — `.proofloop/manifests/*.json`.
 *
 * Fields:
 * - stage_id: owning stage identifier
 * - source_path: path to the tasks definition source
 * - source_digest: digest of the source at compile time
 * - stage_goal: high-level goal of the stage
 * - outcomes: declared outcome descriptions
 * - slices: ordered list of slice entries belonging to the stage
 * - dependencies: stage dependency identifiers
 * - risk_facts: declared risk fact identifiers
 * - runtime_proof: optional runtime verification steps
 * - compiled_at: ISO 8601 compilation timestamp (optional)
 * - compiled_by: tool or entity that compiled the manifest (optional)
 * - repartition_requested: canonical persisted fact source for the REPARTITION
 *   action (§4 Manifest contract, F-S02-08); absent defaults to false/not requested
 */
export interface Manifest {
  /** Stage identifier. */
  stage_id: string;
  /** Path to the tasks definition source. */
  source_path: string;
  /** Digest of the source at compile time. */
  source_digest: string;
  /** High-level goal of the stage. */
  stage_goal: string;
  /** Declared outcome descriptions. */
  outcomes: string[];
  /** Ordered list of slice entries belonging to the stage. */
  slices: ManifestSlice[];
  /** Stage dependency identifiers. */
  dependencies: string[];
  /** Declared risk fact identifiers. */
  risk_facts: string[];
  /** Runtime verification steps (optional). */
  runtime_proof?: RuntimeProofStep[];
  /** ISO 8601 compilation timestamp (optional). */
  compiled_at?: string;
  /** Tool or entity that compiled the manifest (optional). */
  compiled_by?: string;
  /**
   * Canonical persisted fact source for the REPARTITION action (§4 Manifest
   * contract, F-S02-08).
   *
   * When `true`, the stage (in COMPLETED state) requests a repartition pass;
   * the NextAction derivation may then produce `REPARTITION`. Absent defaults
   * to `false` (not requested). Optional — manifests without this field remain
   * valid.
   */
  repartition_requested?: boolean;
}

// ============================================================
// 4. File / Artifact Contracts — Runtime Lock
// ============================================================

/**
 * `.proofloop/runtime.lock` artifact.
 *
 * See §4 File / Artifact Contracts — lock lifecycle is create once /
 * never overwrite.
 *
 * Fields:
 * - runtime_version: version of the runtime
 * - domain_schema_version: version of the domain schema
 * - risk_policy_version: version of the risk policy
 * - capability_policy_version: version of the capability policy
 * - host_adapter: host adapter identifier
 * - extension_package: extension package name
 * - extension_version: extension version
 */
export interface RuntimeLock {
  /** Version of the runtime. */
  runtime_version: string;
  /** Version of the domain schema. */
  domain_schema_version: number;
  /** Version of the risk policy. */
  risk_policy_version: number;
  /** Version of the capability policy. */
  capability_policy_version: number;
  /** Host adapter identifier. */
  host_adapter: string;
  /** Extension package name. */
  extension_package: string;
  /** Extension version. */
  extension_version: string;
}

// ============================================================
// Canonical Stage ID type (S09-C-T03)
// ============================================================

/**
 * Canonical Stage ID string: `S` followed by one or more decimal digits
 * (`^S\d+$`, e.g. `S09`).  Legacy parked labels such as `S08B0` / `S08B`
 * are NOT canonical Stage IDs and fail closed at every Runtime boundary.
 * The single grammar authority is `CANONICAL_STAGE_ID_RE` in validators.ts.
 */
export type CanonicalStageId = string;
