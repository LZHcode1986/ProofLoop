/**
 * @proofloop/kernel — vNext Contract Foundation Types (S0-A bootstrap)
 *
 * Closed, versioned vNext contract types for:
 * - Canonical Plan (immutable projection vs execution projection)
 * - Reference Index (ReferenceDescriptor keyed by ref_id)
 * - Proof Index (goal/task/acceptance/seam/oracle/risk refs + risk bindings)
 * - vNext Manifest (version discriminator `version: 2`)
 *
 * These types are ADDITIVE. v1 contracts (contracts.ts / types.ts) are
 * unchanged and remain the canonical v1 surface. Old v1 artifacts must never
 * be silently interpreted as vNext facts.
 */

// ============================================================
// Version / schema discriminator
// ============================================================

/**
 * vNext schema version constant. Any vNext artifact must carry
 * `version: 2` (Manifest) or `schema_version: 2` (Plan / Manifest plan
 * section). Old v1 Manifest artifacts carry no `version` field (or `1`) and
 * are rejected instead of being silently interpreted as vNext.
 */
export const VNEXT_SCHEMA_VERSION = 2 as const;

export type VNextSchemaVersion = typeof VNEXT_SCHEMA_VERSION;

// ============================================================
// Reference Index
// ============================================================

/**
 * Closed set of reference kinds understood by the vNext Reference Index
 * (§7.1.1 Proof Index 唯一 Schema).
 */
export const VNEXT_REFERENCE_KINDS = [
  'goal',
  'task',
  'acceptance',
  'seam',
  'oracle',
  'risk',
  'proof_spec',
] as const;

export type VNextReferenceKind = (typeof VNEXT_REFERENCE_KINDS)[number];

/**
 * A single registered reference descriptor.
 *
 * The object KEY in `reference_index` is the `ref_id`; the descriptor value
 * must NOT repeat the id.
 *
 * `ref` uses the canonical entity-reference grammar:
 *   <root-relative-path>#/entities/<entity-id>
 *
 * `file_digest` / `section_digest` are lowercase 64-char hex SHA-256 digests
 * (§7.6 Entity/Section Digest).
 */
export interface VNextReferenceDescriptor {
  kind: VNextReferenceKind;
  ref: string;
  file_digest: string;
  section_digest: string;
}

/**
 * Reference Index: object keyed by `ref_id` → descriptor.
 *
 * Keys must be non-empty, unique, and every descriptor must be a valid
 * VNextReferenceDescriptor. An empty index is rejected (the Manifest must
 * not hold only "empty references").
 */
export type VNextReferenceIndex = Record<string, VNextReferenceDescriptor>;

// ============================================================
// Proof Index
// ============================================================

/**
 * A risk reference binding inside a Proof Index.
 *
 * `applies_to_acceptance_refs` must reference refs that the SAME Proof Index
 * lists in `acceptance_refs` (kind=acceptance).
 * `applies_to_seam_refs` must reference refs that the SAME Proof Index lists
 * in `seam_refs` (kind=seam).
 */
export interface VNextRiskBinding {
  ref_id: string;
  applies_to_acceptance_refs: string[];
  applies_to_seam_refs: string[];
}

/**
 * Per-slice Proof Index — the single machine schema for proof references.
 *
 * All refs are stable `ref_id`s registered in the Manifest `reference_index`.
 * No string refs, digest objects, or "equivalent index" forms are accepted.
 */
export interface VNextProofIndex {
  slice_id: string;
  goal_ref: string;
  task_refs: string[];
  acceptance_refs: string[];
  seam_refs: string[];
  oracle_refs: string[];
  risk_refs: VNextRiskBinding[];
}

// ============================================================
// Canonical Plan
// ============================================================

/**
 * Plan node kinds.
 */
export const VNEXT_PLAN_KINDS = ['stage', 'slice', 'task'] as const;

export type VNextPlanKind = (typeof VNEXT_PLAN_KINDS)[number];

/** Closed execution-scope kinds admitted by the vNext task contract. */
export const VNEXT_EXECUTION_SCOPE_KINDS = ['implementation', 'evidence-only'] as const;

export type VNextExecutionScopeKind = (typeof VNEXT_EXECUTION_SCOPE_KINDS)[number];

/**
 * Immutable, root-relative execution scope for one Task.
 *
 * The kernel validates the closed shape and lexical root-relative grammar. The
 * Runtime re-checks the paths against the live trust root and symlink/TOCTOU
 * boundary before projecting a Worker Context.
 */
export interface VNextExecutionScope {
  kind: VNextExecutionScopeKind;
  code_paths: string[];
  test_paths: string[];
  forbidden_paths: string[];
}

/** Manifest binding for a task id and its canonical task entity reference. */
export interface VNextTaskScope {
  task_ref: string;
  execution_scope: VNextExecutionScope;
}

/**
 * A single Canonical Plan node.
 *
 * IMMUTABLE Plan Projection (participates in `plan_digest`):
 *   id, kind, goal, refs, dependencies, required_skills, execution_scope
 *
 * MUTABLE Execution Projection (excluded from `plan_digest`):
 *   checkbox (Worker), status (Worker Status), cv_status (Current CV Status)
 */
export interface VNextPlanNode {
  id: string;
  kind: VNextPlanKind;
  /** Immutable — Stage/Slice/Task Goal. */
  goal: string;
  /** Immutable — Authority/Acceptance/Oracle refs (semantic refs). */
  refs: string[];
  /** Immutable — dependencies. */
  dependencies: string[];
  /** Immutable — Required Skills. */
  required_skills: string[];
  /** Immutable — required for Task nodes; absent on Stage/Slice nodes. */
  execution_scope?: VNextExecutionScope;
  /** Mutable — task checkbox; excluded from plan_digest. */
  checkbox?: boolean;
  /** Mutable — Worker Status; excluded from plan_digest. */
  status?: string;
  /** Mutable — Current CV Status; excluded from plan_digest. */
  cv_status?: string;
}

/**
 * A Canonical Plan: versioned container of ordered plan nodes.
 */
export interface VNextCanonicalPlan {
  schema_version: VNextSchemaVersion;
  items: VNextPlanNode[];
}

/**
 * Immutable projection extracted from a Canonical Plan — the exact input
 * used to compute `plan_digest`.
 */
export interface VNextPlanProjection {
  schema_version: VNextSchemaVersion;
  items: Array<{
    id: string;
    kind: VNextPlanKind;
    goal: string;
    refs: string[];
    dependencies: string[];
    required_skills: string[];
    execution_scope?: VNextExecutionScope;
  }>;
}

// ============================================================
// vNext Manifest
// ============================================================

/**
 * Runtime Proof section of the vNext Manifest (optional, data-contract level).
 *
 * Deep Runtime Proof semantics are S0-B scope; the kernel only checks the
 * closed field shape when present.
 */
export interface VNextRuntimeProofSection {
  spec_refs: string[];
  resolved_steps: unknown[];
  proof_digest: string;
}

// ============================================================
// vNext admission authority
// ============================================================

/** The only SPV verdict which can authorize a vNext Stage Plan. */
export interface VNextSpvPassReceipt {
  version: VNextSchemaVersion;
  schema_version: VNextSchemaVersion;
  type: 'SPV_PASS';
  stage_id: string;
  manifest_digest: string;
  plan_digest: string;
  snapshot_digest: string;
  digest: string;
}

/**
 * A vNext Stage Plan admission fact.  This is a consumer-side schema only;
 * S04 does not create or admit this artifact.
 */
export interface VNextStagePlanReceipt {
  version: VNextSchemaVersion;
  schema_version: VNextSchemaVersion;
  type: 'STAGE_PLAN';
  stage_id: string;
  manifest_digest: string;
  plan_digest: string;
  snapshot_digest: string;
  spv_receipt_digest: string;
  digest: string;
}

/**
 * A slice entry inside the vNext Manifest.
 */
export interface VNextManifestSlice {
  slice_id: string;
  proof_index: VNextProofIndex;
  required_skills: string[];
  depends_on: string[];
  evidence_path: string;
}

/**
 * vNext Manifest (schema `version: 2`).
 *
 * Distinct from the v1 Manifest: it carries an explicit `version: 2`
 * discriminator, a normalized plan reference + plan_digest, and a
 * `reference_index` + per-slice `proof_index` closed reference surface.
 * See §9 Manifest vNext of the pluginv2 plan.
 */
export interface VNextManifest {
  version: VNextSchemaVersion;
  stage_id: string;
  plan: {
    ref: string;
    plan_digest: string;
    schema_version: VNextSchemaVersion;
  };
  reference_index: VNextReferenceIndex;
  authority_ref_ids?: string[];
  /** Immutable per-task scope bindings consumed by Runtime dispatch. */
  task_scopes: Record<string, VNextTaskScope>;
  slices: VNextManifestSlice[];
  runtime_proof?: VNextRuntimeProofSection;
  compiled_by?: string;
}
