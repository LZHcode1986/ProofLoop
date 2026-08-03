/**
 * @proofloop/opencode-plugin — proofloop_review S3 shared ReviewInput
 * projection contract (S03-D-T01/T02, PO-S03-D-01/02/05).
 *
 * The `review_scope: stage` ReviewInput data shape the S03-D prepare flow
 * assembles from canonical persisted facts (Manifest + git + reconcile refs +
 * authority documents). S03 only supports `review_scope: stage` (the closed
 * `REVIEW_SCOPES` set); project review is out of scope for this slice and any
 * other scope value fails closed at the execute boundary.
 *
 * Ref-only rule (PO-S03-D-02 / OUT-S1-05 / FR-012): every artifact reference
 * in the ReviewInput is `ReviewRefEntry` — exactly `{ ref, digest }`. A
 * Receipt entry's `ref` is the root-relative canonical path (e.g.
 * `.proofloop/receipts/cv/S3/S03-D/<digest>.json`) and `digest` is the
 * content-addressed digest; the full Receipt payload/body NEVER surfaces.
 * The same ref-only rule applies to authority-document references (root-bound
 * relative paths + content digests).
 *
 * Root-bound path validation (security hardening): every path/ref emitted
 * into the ReviewInput must resolve inside the canonical worktree trust root
 * through the shared `path-boundary.ts` seam. `guardReviewPathRef` fails
 * closed with HOST.PATH_OUTSIDE_PROJECT when a computed ref escapes;
 * `makeReviewRefEntry` normalizes a root-bound absolute path to the canonical
 * root-relative form and returns null on a boundary violation (the prepare
 * handler maps that to the same canonical Finding). The prepare handler also
 * runs the full TOCTOU identity re-verify + manifest content trust-root guard
 * (S2-F-001) around every runtime read.
 *
 * T01 defines the projection TYPES + the ref-only rule + the root-bound
 * validation and sources the Manifest / git / reconcile-ref fields. T02
 * completes the independent persisted-facts sourcing:
 *   - `authority_refs` — root-bound PRD/tech-spec document refs with content
 *     digests (discoverAuthorityRefs in review-prepare.ts);
 *   - `risk_level` — deterministic risk-policy projection from the Manifest
 *     risk facts (deriveStageRiskLevel — the brain stage-review contract
 *     declares the low/medium/high/critical scale; no canonical risk-policy
 *     table exists in the runtime, so the mapping is a documented pure
 *     function over the persisted risk facts);
 *   - `clean_room` — the evidence-backed process fact (deriveCleanRoom:
 *     receipt_chain_valid AND every slice evidence finalized — a bounded
 *     process statement, never reviewer judgment).
 */

import path from 'node:path';
import { toErrorResult } from '../tool-result.js';
import type { ToolResult } from '../tool-result.js';
import { resolveWithinRoot } from '../path-boundary.js';

// ============================================================
// Closed review scopes (contract-state-matrix.md#§1.3)
// ============================================================

/**
 * Legal `review_scope` values. S3 supports ONLY `stage`; a project review is
 * a later capability and any other scope value fails closed at the execute
 * boundary before any runtime call.
 */
export const REVIEW_SCOPES = ['stage'] as const;

/** Legal review scope value (S3: exactly `'stage'`). */
export type ReviewScope = (typeof REVIEW_SCOPES)[number];

/** True when `value` is a legal review scope (S3: `'stage'`). */
export function isReviewScope(value: unknown): value is ReviewScope {
  return (
    typeof value === 'string' && (REVIEW_SCOPES as readonly string[]).includes(value)
  );
}

// ============================================================
// Risk-level projection (brain stage-review contract scale)
// ============================================================

/**
 * Stage risk level — the brain stage-review contract scale
 * (low / medium / high / critical). The runtime has no canonical risk-policy
 * table, so the level is projected deterministically from the Manifest
 * `risk_facts` through `deriveStageRiskLevel` (documented mapping below). It
 * is a bounded persisted-fact summary, never reviewer judgment.
 */
export type StageRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Canonical colon-form risk-fact pattern (Stage Review finding S3-REVIEW-001):
 * the COMPILED Manifest `risk_facts` array stores `"key: true|false"` entries
 * (see `.proofloop/manifests/S3.json`), so `"irreversible_operation: true"`
 * means the fact IS present and `"irreversible_operation: false"` means it is
 * NOT present (a negative fact). Bare keys (`"irreversible_operation"`) are
 * the legacy form still accepted for backward compatibility.
 */
const RISK_FACT_COLON_PATTERN = /^([a-z_]+):\s*(true|false)$/;

/**
 * Normalize ONE Manifest risk_fact entry to its bare key, or `null` when the
 * fact is NOT present (Stage Review finding S3-REVIEW-001):
 *   - `"key: true"`   → `key` (the fact IS present);
 *   - `"key: false"`  → `null` (negative fact — NOT present);
 *   - a bare key `"key"` → `key` (legacy form, backward compatible);
 *   - unknown / malformed entries (non-boolean colon values, empty strings,
 *     colon-bearing garbage) → `null` (ignored deterministically).
 *
 * Pure deterministic function — no I/O (HP-003).
 */
export function normalizeRiskFact(fact: string): string | null {
  const colon = fact.match(RISK_FACT_COLON_PATTERN);
  if (colon !== null) {
    return colon[2] === 'true' ? colon[1] : null;
  }
  if (fact.length > 0 && !fact.includes(':')) {
    return fact;
  }
  return null;
}

/**
 * Deterministic risk-level projection from the Manifest risk facts
 * (PO-S03-D-02; Stage Review finding S3-REVIEW-001). Each input fact is
 * normalized through `normalizeRiskFact` — the COMPILED manifest colon form
 * (`"irreversible_operation: true"`) and the legacy bare key both count as
 * present; a `": false"` fact is absent. The mapping is a documented, bounded
 * policy over the persisted facts:
 *   - `critical` — `irreversible_operation` combined with an
 *     `external_side_effect` or `core_state_machine` fact;
 *   - `high` — any of `irreversible_operation` / `core_state_machine` /
 *     `external_side_effect`;
 *   - `medium` — any of `persistent_state` / `authorization` /
 *     `cross_process_behavior` / `concurrency`;
 *   - `low` — otherwise (e.g. `public_api_change` alone, or no risk facts).
 *
 * Pure function — no I/O; the same facts always yield the same level (HP-003).
 */
export function deriveStageRiskLevel(riskFacts: readonly string[]): StageRiskLevel {
  const facts = new Set<string>();
  for (const fact of riskFacts) {
    const bare = normalizeRiskFact(fact);
    if (bare !== null) facts.add(bare);
  }
  if (
    facts.has('irreversible_operation') &&
    (facts.has('external_side_effect') || facts.has('core_state_machine'))
  ) {
    return 'critical';
  }
  if (
    facts.has('irreversible_operation') ||
    facts.has('core_state_machine') ||
    facts.has('external_side_effect')
  ) {
    return 'high';
  }
  if (
    facts.has('persistent_state') ||
    facts.has('authorization') ||
    facts.has('cross_process_behavior') ||
    facts.has('concurrency')
  ) {
    return 'medium';
  }
  return 'low';
}

// ============================================================
// Clean-room process fact (PO-S03-D-02)
// ============================================================

/**
 * Bounded process facts consumed by `deriveCleanRoom` — sourced from the
 * reconcile output (receipt chain validity + per-slice evidence finalized).
 */
export interface CleanRoomFacts {
  /** Whether every scanned receipt category chain is valid. */
  readonly receipt_chain_valid: boolean;
  /** Per-slice evidence-finalized facts in manifest declaration order. */
  readonly slices: readonly { readonly slice_id: string; readonly evidence_finalized: boolean }[];
}

/**
 * Clean-room process fact (PO-S03-D-02): whether the stage's process is
 * evidence-backed — the receipt chain is valid AND every slice's evidence is
 * finalized. This is a bounded statement sourced from the persisted reconcile
 * facts (never reviewer judgment, never an invented isolation policy). A stage
 * with zero slices carries no evidence-backed process fact (false).
 */
export function deriveCleanRoom(facts: CleanRoomFacts): boolean {
  return (
    facts.receipt_chain_valid &&
    facts.slices.length > 0 &&
    facts.slices.every((s) => s.evidence_finalized)
  );
}

// ============================================================
// Ref-only projection types
// ============================================================

/**
 * Ref-only artifact reference: exactly `{ ref, digest }` — never a Receipt
 * payload/body, never a full artifact object (OUT-S1-05 / FR-012). `ref` is
 * the root-bound RELATIVE canonical path; `digest` is the content-addressed
 * digest.
 */
export interface ReviewRefEntry {
  /** Root-bound relative canonical path (e.g. `.proofloop/receipts/cv/…`). */
  readonly ref: string;
  /** Content-addressed digest (receipt self-digest or authority content digest). */
  readonly digest: string;
}

/**
 * `review_scope: stage` ReviewInput projection (brain stage-review contract
 * #Required fields). The prepare flow is read-only: it assembles ONLY
 * canonical persisted facts and ref-only entries; it never computes a
 * verdict, never writes a Receipt, and never returns a Receipt payload.
 *
 * Every required field is sourced from canonical persisted facts and is
 * verifiable against an independent fixture oracle (PO-S03-D-02):
 *   - Manifest: `stage_goal` / `stage_outcomes` / `risk_facts` /
 *     `manifest_digest`; root-bound `tasks_path` / `manifest_path`;
 *   - git: `branch` / `snapshot`;
 *   - authority documents (PRD.md / tech-spec/*.md): `authority_refs`
 *     (root-bound refs + content digests);
 *   - reconcile refs: `stage_gate_receipt_ref` (ref-only) + per-slice
 *     `cv_receipt_refs` (ref-only);
 *   - risk/clean-room facts: `risk_level` (deriveStageRiskLevel) +
 *     `clean_room` (deriveCleanRoom).
 */
export interface StageReviewInput {
  /** S3 only supports `review_scope: stage`. */
  readonly review_scope: 'stage';
  /** Canonical stage id (e.g. S3). */
  readonly stage_id: string;
  /** Stage goal from the canonical Manifest. */
  readonly stage_goal: string;
  /** Observable outcomes from the canonical Manifest. */
  readonly stage_outcomes: readonly string[];
  /**
   * Authority-document references (ref-only): root-bound relative paths to
   * the canonical authority documents present in the worktree (PRD.md /
   * tech-spec/*.md) with their content digests (sha256 of the file bytes).
   */
  readonly authority_refs: readonly ReviewRefEntry[];
  /** Git branch of the canonical worktree. */
  readonly branch: string;
  /** Integrated snapshot (git HEAD commit sha). */
  readonly snapshot: string;
  /** Root-bound relative tasks.md path. */
  readonly tasks_path: string;
  /** Root-bound relative manifest path (`.proofloop/manifests/<stage>.json`). */
  readonly manifest_path: string;
  /** Canonical manifest digest (runtime canonical digest binding). */
  readonly manifest_digest: string;
  /** Ref-only Stage Gate receipt reference, or null when no gate receipt exists. */
  readonly stage_gate_receipt_ref: ReviewRefEntry | null;
  /** Ref-only CV receipt references, one per Slice (latest CV receipt). */
  readonly cv_receipt_refs: readonly ReviewRefEntry[];
  /** Risk facts from the canonical Manifest. */
  readonly risk_facts: readonly string[];
  /** Risk level projected from the Manifest risk facts (brain contract scale). */
  readonly risk_level: StageRiskLevel;
  /** Evidence-backed process fact (receipt chain valid + evidence finalized). */
  readonly clean_room: boolean;
}

// ============================================================
// Root-bound path / ref validation (security hardening)
// ============================================================

/**
 * Root-bound validation of a computed ReviewInput path/ref (PO-S03-D-05).
 *
 * The projection only emits paths that are derived from canonical persisted
 * facts, but defense-in-depth re-validates every emitted artifact path through
 * the shared `resolveWithinRoot` seam (component-wise realpath walk — `..`,
 * absolute and symlink escapes are rejected). Returns a fail-closed
 * HOST.PATH_OUTSIDE_PROJECT ToolResult when the path escapes the trust root,
 * else `null`.
 */
export function guardReviewPathRef(
  canonicalRoot: string,
  absolutePath: string,
  label: string,
): ToolResult | null {
  const resolved = resolveWithinRoot(canonicalRoot, absolutePath);
  if (resolved === null) {
    return toErrorResult([
      {
        code: 'HOST.PATH_OUTSIDE_PROJECT',
        severity: 'error',
        message:
          `proofloop_review: ${label} "${absolutePath}" resolves outside the ` +
          `trust root (${canonicalRoot}).`,
      },
    ]);
  }
  return null;
}

/**
 * Build a ref-only `ReviewRefEntry` from a root-bound ABSOLUTE artifact path.
 *
 * Normalizes the path to the canonical root-relative form (posix separators,
 * `./`/`..` collapsed — the same convention the S03-B admission projection
 * uses) and returns `null` when the path is not inside the trust root (a
 * boundary violation the caller must fail closed on, e.g. with
 * `guardReviewPathRef`).
 */
export function makeReviewRefEntry(
  canonicalRoot: string,
  absolutePath: string,
  digest: string,
): ReviewRefEntry | null {
  const rel = path.posix.normalize(path.relative(canonicalRoot, absolutePath));
  if (rel.length === 0 || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    return null;
  }
  return { ref: rel, digest };
}
