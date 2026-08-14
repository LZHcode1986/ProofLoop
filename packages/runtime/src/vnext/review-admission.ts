/**
 * vNext Stage Review admission.
 *
 * The Stage Review is the terminal downstream vNext consumer, not a legacy
 * reconcile/reducer path.  It revalidates the complete integrated prefix —
 * Stage Plan + fresh SPV authority, the Manifest/Plan/snapshot tuple, the
 * Stage Gate PASS fact that preceded the review, and the current Git
 * boundary and clean working tree — then persists a single STAGE_REVIEW_PASS
 * Receipt (verdict ACCEPTED | REPAIR) through the shared bounded
 * `runReceiptAdmission` seam.
 *
 * The Review Receipt binds:
 *   - the Manifest (`manifest_digest`);
 *   - the Authority (`stage_plan_receipt_digest` + `spv_receipt_digest`);
 *   - the Stage Gate PASS Receipt that preceded the review
 *     (`stage_gate_receipt_digest` — a vNext Stage Review is admitted only
 *     after a Gate PASS fact exists for the same tuple/snapshot);
 *   - the integrated snapshot (`snapshot_digest` = current Git HEAD).
 *
 * v2 Review receipts (schema_version 2, type STAGE_REVIEW_RESULT, action
 * STAGE_REVIEW) never enter the legacy reconcile/reader path; the v2 Review
 * consumer rejects v1 receipts in the review chain.  A review chain that
 * already ends in an ACCEPTED verdict refuses further review; a REPAIR tip
 * leaves the stage in work and admits the next review round.
 *
 * P-09 (REPAIR-driven re-run): after a REPAIR round and an explicit re-gate
 * (new GATE PASS tip at the advanced HEAD), the next Review round is
 * admitted while the earlier REPAIR Receipt — bound to the gate tip and
 * snapshot that were current at ITS time — stays as write-once chain
 * history (validated fail-closed in `validateFacts`).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  computeDigest,
  computeReceiptDigest,
  validateReceipt,
} from '@proofloop/kernel';
import type {
  Receipt,
  VNextManifest,
} from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
// S09-C-T03: the shared canonical Stage ID guard (`^S\d+$`).  Legacy parked
// labels such as S08B0/S08B fail closed before any Runtime read/write.
import { CANONICAL_STAGE_ID_RE } from './stage-id';
import { readGitHead, resolveGitRoot } from '../git-source';
import { detectPlanManifestRoute } from '../plan-services';
import { reviewReceiptDir, stageGateReceiptDir } from '../receipt-layout';
// P-11 task B: the read-only STAGE_CLOSE archived-facts probe.  An archived
// Stage is a historical snapshot: `ready_for_review` is always false and the
// report carries the `archived`/`stage_close` projection regardless of the
// Stage Gate chain tip.
import { readStageCloseFacts } from './stage-close-facts';
import type { StageReviewAdmissionRequest } from '../admission-request';
import type {
  AdmitResult,
  ReceiptBuild,
  ReceiptWriterPort,
} from '../admit-pipeline';
import { runReceiptAdmission } from '../admit-pipeline';
import {
  assertVNextManifestReferenceBindings,
  readVNextManifest,
  VNextHandoffError,
} from './dispatch';
import { readVNextAdmissionAuthority } from './next';
import type { VNextAdmissionAuthority } from './types';
import {
  VNEXT_REVIEW_ACTION,
  VNEXT_REVIEW_RESULT_TYPE,
  VNEXT_REVIEW_SCHEMA_VERSION,
  VNEXT_REVIEW_VERDICTS,
} from './types';
import type {
  VNextReviewAdmissionState,
  VNextReviewVerdict,
} from './types';

const IDENTIFIER_RE = /^[A-Za-z0-9_-]+$/;
const CANONICAL_STAGE_ID = CANONICAL_STAGE_ID_RE;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const REQUEST_FIELDS = new Set([
  'type',
  'stageId',
  'verdict',
  'manifestDigest',
  'snapshotDigest',
  'summary',
]);

// ============================================================
// Error surface
// ============================================================

type ReviewAdmissionCode =
  | 'RUNTIME.SCHEMA_MISMATCH'
  | 'RUNTIME.RECEIPT_CHAIN_BROKEN'
  | 'DOMAIN.INVALID_TRANSITION';

class VNextReviewAdmissionError extends Error {
  constructor(
    readonly code: ReviewAdmissionCode,
    message: string,
  ) {
    super(message);
    this.name = 'VNextReviewAdmissionError';
  }
}

function fail(code: ReviewAdmissionCode, message: string): never {
  throw new VNextReviewAdmissionError(code, message);
}

// ============================================================
// Request shape
// ============================================================

/**
 * Closed request shape used by the Runtime/Host Stage Review seam.  The
 * Review is stage-level: no slice is bound by the request; slices are bound
 * by the Manifest and the persisted integrated prefix.
 */
export interface VNextStageReviewAdmissionRequest {
  readonly type: 'stage_review';
  readonly stageId: string;
  readonly verdict: VNextReviewVerdict;
  readonly manifestDigest: string;
  readonly snapshotDigest: string;
  readonly summary: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a non-empty string`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireString(value, label);
  if (!SHA256_RE.test(digest)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function requireSnapshot(value: unknown, label: string): string {
  const digest = requireString(value, label);
  if (!SNAPSHOT_RE.test(digest)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a Git snapshot digest`);
  }
  return digest;
}

function canonicalProjectRoot(projectRoot: string): string {
  const absolute = path.resolve(projectRoot);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Review admission requires an existing projectRoot directory');
  }
  return absolute;
}

export function validateVNextStageReviewRequest(value: unknown): VNextStageReviewAdmissionRequest {
  if (!isRecord(value)) fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Review request must be an object');
  const unknown = Reflect.ownKeys(value).filter(
    (key) => typeof key !== 'string' || !REQUEST_FIELDS.has(key),
  );
  if (unknown.length > 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Review request contains unknown field(s): ${unknown.map(String).join(', ')}`);
  }
  if (value.type !== 'stage_review') {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Review request type must be stage_review');
  }
  const stageId = requireString(value.stageId, 'stageId');
  if (!CANONICAL_STAGE_ID.test(stageId)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'stageId must be a canonical Stage ID (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected');
  }
  if (!VNEXT_REVIEW_VERDICTS.includes(value.verdict as (typeof VNEXT_REVIEW_VERDICTS)[number])) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Review request verdict must be ACCEPTED or REPAIR');
  }
  const manifestDigest = requireSha256(value.manifestDigest, 'manifestDigest');
  const snapshotDigest = requireSnapshot(value.snapshotDigest, 'snapshotDigest');
  const summary = requireString(value.summary, 'summary');
  return {
    type: 'stage_review',
    stageId,
    verdict: value.verdict as VNextStageReviewAdmissionRequest['verdict'],
    manifestDigest,
    snapshotDigest,
    summary,
  };
}

// ============================================================
// Chain reads
// ============================================================

interface ReceiptChain {
  readonly receipts: readonly Receipt[];
  readonly tipDigest: string | null;
}

/** Read one vNext Receipt chain without invoking the legacy receipt reader. */
function readReceiptChain(root: string, directory: string, label: string): ReceiptChain {
  const lexical = path.resolve(directory);
  const canonical = canonicalPathWithinRoot(root, lexical);
  if (canonical === null || canonical !== lexical) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} is not a canonical directory under the project root`);
  }

  let names: string[];
  try {
    const stat = fs.statSync(lexical);
    if (!stat.isDirectory()) fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} is not a directory`);
    names = fs.readdirSync(lexical).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { receipts: [], tipDigest: null };
    if (error instanceof VNextReviewAdmissionError) throw error;
    fail(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const byDigest = new Map<string, Receipt>();
  for (const name of names) {
    const file = path.join(lexical, name);
    const opened = openNoFollowRead(root, file);
    if (!opened.ok || opened.filePath !== file) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} contains an unreadable or redirected Receipt: ${name}`);
    }
    let receipt: Receipt;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
      } catch (error) {
        fail(
          'RUNTIME.RECEIPT_CHAIN_BROKEN',
          `${label} Receipt ${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        receipt = validateReceipt(parsed);
      } catch (error) {
        fail(
          'RUNTIME.RECEIPT_CHAIN_BROKEN',
          `${label} Receipt ${name} failed schema validation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      fs.closeSync(opened.fd);
    }
    if (!SHA256_RE.test(receipt.digest) || name !== `${receipt.digest}.json`) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} Receipt ${name} is not digest-addressed`);
    }
    const { digest: ignoredDigest, ...content } = receipt;
    void ignoredDigest;
    if (computeReceiptDigest(content) !== receipt.digest) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} Receipt ${name} has an invalid self-digest`);
    }
    byDigest.set(receipt.digest, receipt);
  }

  // Chain ordering walks the previous_digest linkage from the single root
  // (digest-address sorted files are only the storage index, never the order):
  // a chain tip may arrive before the root in readdir order, so filename
  // order must not decide which Receipt is the chain root.
  const declaredPrevious = new Map<string, string | undefined>();
  for (const receipt of byDigest.values()) {
    declaredPrevious.set(receipt.digest, receipt['previous_digest'] as string | undefined);
  }
  if (byDigest.size === 0) {
    return { receipts: [], tipDigest: null };
  }
  const roots = [...byDigest.values()].filter((receipt) => receipt['previous_digest'] === undefined);
  if (roots.length !== 1) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} must have exactly one root Receipt (found ${roots.length})`);
  }
  const ordered: Receipt[] = [];
  const visited = new Set<string>();
  let current: Receipt | undefined = roots[0];
  let previousTimestamp = '';
  while (current !== undefined) {
    if (visited.has(current.digest)) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} Receipt chain contains a cycle at ${current.digest}`);
    }
    if (typeof current.timestamp !== 'string' || current.timestamp < previousTimestamp) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} Receipt ${current.digest} is not timestamp-ordered`);
    }
    visited.add(current.digest);
    ordered.push(current);
    const successor = [...byDigest.values()].filter(
      (receipt) => receipt['previous_digest'] === current?.digest,
    );
    if (successor.length > 1) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} Receipt ${current.digest} has more than one successor`);
    }
    previousTimestamp = typeof current.timestamp === 'string' ? current.timestamp : '';
    current = successor[0];
  }
  if (visited.size !== byDigest.size) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} Receipt chain contains dangling or forked Receipts`);
  }
  return { receipts: ordered, tipDigest: ordered.length > 0 ? ordered[ordered.length - 1].digest : null };
}

// ============================================================
// Git boundary helpers
// ============================================================

function assertStableGitBoundary(root: string, expectedSnapshot: string): void {
  const gitRoot = resolveGitRoot(root);
  const head = readGitHead(gitRoot);
  if (head === null || head !== expectedSnapshot) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      `vNext Stage Review refused: request snapshotDigest "${expectedSnapshot}" does not match the current Git HEAD "${head ?? 'unresolvable'}"`,
    );
  }
}

function assertCleanWorkingTree(root: string): void {
  let porcelain: string;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      encoding: 'utf-8',
    });
  } catch (error) {
    fail('DOMAIN.INVALID_TRANSITION', `vNext Stage Review refused: cannot read git status: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (porcelain.trim().length > 0) {
    fail('DOMAIN.INVALID_TRANSITION', 'vNext Stage Review refused: working tree is not clean (git status --porcelain non-empty)');
  }
}

/** `ancestor` must be an ancestor of (or equal to) `descendant`. */
function assertAncestor(root: string, ancestor: string, descendant: string, label: string): void {
  if (ancestor === descendant) return;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: root,
      stdio: 'ignore',
    });
  } catch {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      `vNext Stage Review refused: ${label} (${ancestor}) is not an ancestor of the integrated snapshot ${descendant}`,
    );
  }
}

// ============================================================
// Validation facts
// ============================================================

interface ValidatedReviewFacts {
  readonly root: string;
  readonly manifest: VNextManifest;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly authority: VNextAdmissionAuthority;
  readonly snapshotDigest: string;
  /** Digest of the Stage Gate PASS receipt that preceded the review. */
  readonly gateTipDigest: string;
  /** Digest of the review chain tip, or null when no review has run yet. */
  readonly reviewTipDigest: string | null;
}

interface VNextReviewValidationOptions {
  /** After-write hop: the review tip is expected to be the installed digest. */
  readonly allowInstalledReviewTip?: string;
  /** Skip the git-clean check (an installed Receipt may dirty a tracked root). */
  readonly skipCleanWorkingTree?: boolean;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return computeDigest(left) === computeDigest(right);
}

// ============================================================
// Prior Receipt closed-schema validation
// ============================================================
//
// The Review consumer revalidates every prior v2 Gate/Review Receipt at the
// same closed-schema strength the shared admit pipeline enforces when it
// writes those facts (`validateVNextGateRecord` / `validateVNextReviewRecord`
// in admit-pipeline.ts, which are module-private): exact allowed field set
// (unknown fields refused), required fields present, schema_version/type/
// action discriminators, digest/snapshot formats, closed verdict set,
// non-empty summary and `receipt_chain_valid === true`.  A prior Receipt that
// is envelope-valid and digest-self-consistent but payload-incomplete or
// polluted must fail the Review fail-closed.

const GIT_SHA_RE = /^[a-f0-9]{40}$/;

const VNEXT_GATE_RECORD_FIELDS = new Set([
  'schema_version',
  'type',
  'action',
  'stage_id',
  'manifest_digest',
  'plan_digest',
  // Legacy field: only present on archived pre-decision Gate Receipts; new
  // Receipts never carry it (the Runtime Proof it bound was deleted).
  'runtime_proof_digest',
  'stage_plan_receipt_digest',
  'spv_receipt_digest',
  'snapshot_digest',
  'verdict',
  'integrated_slices',
  'summary',
  // S09-REVIEW-001: the one-time restricted bootstrap marker (optional; only
  // present on the S09 all-not_applicable Gate Receipt).
  'restricted_bootstrap',
  // S10 backfill (dual-path SG): explicit verification path marker
  // (optional; `receipts` | `git_facts`, absent on pre-decision Receipts).
  'verification_source',
  'receipt_chain_valid',
]);

const VNEXT_REVIEW_RECORD_FIELDS = new Set([
  'schema_version',
  'type',
  'action',
  'stage_id',
  'manifest_digest',
  'plan_digest',
  // Legacy field: only present on archived pre-decision Review Receipts; new
  // Receipts never carry it (the Runtime Proof it bound was deleted).
  'runtime_proof_digest',
  'stage_plan_receipt_digest',
  'spv_receipt_digest',
  'stage_gate_receipt_digest',
  'snapshot_digest',
  'verdict',
  'summary',
  'receipt_chain_valid',
]);

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Closed v2 GATE_RESULT record validation at the same strength as
 * `validateVNextGateRecord` in admit-pipeline.ts.  Returns an error message
 * or null when the record is closed-valid.
 */
function validateClosedGateRecord(
  value: Record<string, unknown>,
  label: string,
): string | null {
  // S09-REVIEW-001 + dual-path SG: `restricted_bootstrap` and
  // `verification_source` are optional members; `runtime_proof_digest` is a
  // legacy field tolerated on archived pre-decision Receipts only (the
  // Runtime Proof it bound was deleted).
  const unknown = Reflect.ownKeys(value).filter(
    (key) => typeof key !== 'string' || !VNEXT_GATE_RECORD_FIELDS.has(key),
  );
  if (unknown.length > 0) {
    return `${label} contains unknown field(s): ${unknown.map(String).join(', ')}`;
  }
  for (const field of VNEXT_GATE_RECORD_FIELDS) {
    if (field === 'restricted_bootstrap') continue;
    if (field === 'verification_source') continue;
    if (field === 'runtime_proof_digest') continue;
    if (!hasOwn(value, field)) return `${label}.${field} is required`;
  }
  if (value.restricted_bootstrap !== undefined && value.restricted_bootstrap !== true) {
    return `${label}.restricted_bootstrap must be true when present`;
  }
  if (
    value.verification_source !== undefined &&
    value.verification_source !== 'receipts' &&
    value.verification_source !== 'git_facts'
  ) {
    return `${label}.verification_source must be "receipts" or "git_facts" when present`;
  }
  if (value.schema_version !== 2) return `${label}.schema_version must be 2`;
  if (value.type !== 'GATE_RESULT') return `${label}.type must be GATE_RESULT`;
  if (value.action !== 'GATE') return `${label}.action must be GATE`;
  if (typeof value.stage_id !== 'string' || !CANONICAL_STAGE_ID.test(value.stage_id)) {
    return `${label}.stage_id must be a canonical Stage ID (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected`;
  }
  for (const field of [
    'manifest_digest',
    'plan_digest',
    'stage_plan_receipt_digest',
    'spv_receipt_digest',
  ]) {
    if (typeof value[field] !== 'string' || !SHA256_RE.test(value[field])) {
      return `${label}.${field} must be a lowercase SHA-256 digest`;
    }
  }
  if (
    value.runtime_proof_digest !== undefined &&
    (typeof value.runtime_proof_digest !== 'string' || !SHA256_RE.test(value.runtime_proof_digest))
  ) {
    return `${label}.runtime_proof_digest must be a lowercase SHA-256 digest when present (legacy field)`;
  }
  if (typeof value.snapshot_digest !== 'string' || !SNAPSHOT_RE.test(value.snapshot_digest)) {
    return `${label}.snapshot_digest must be a Git snapshot digest`;
  }
  if (value.verdict !== 'PASS' && value.verdict !== 'FAIL') {
    return `${label}.verdict must be PASS or FAIL`;
  }
  if (typeof value.summary !== 'string' || value.summary.length === 0) {
    return `${label}.summary must be a non-empty string`;
  }
  if (value.receipt_chain_valid !== true) {
    return `${label}.receipt_chain_valid must be true`;
  }
  if (!Array.isArray(value.integrated_slices) || value.integrated_slices.length === 0) {
    return `${label}.integrated_slices must be a non-empty array of slice bindings`;
  }
  const seenSlices = new Set<string>();
  for (let index = 0; index < value.integrated_slices.length; index += 1) {
    const binding = value.integrated_slices[index];
    const entryLabel = `${label}.integrated_slices[${index}]`;
    if (!isRecord(binding)) return `${entryLabel} must be an object`;
    const bindingFields = new Set(['slice_id', 'integration_receipt_digest', 'commit_sha']);
    const unknownFields = Reflect.ownKeys(binding).filter(
      (key) => typeof key !== 'string' || !bindingFields.has(key),
    );
    if (unknownFields.length > 0) {
      return `${entryLabel} contains unknown field(s): ${unknownFields.map(String).join(', ')}`;
    }
    const sliceId = binding.slice_id;
    if (typeof sliceId !== 'string' || !IDENTIFIER_RE.test(sliceId)) {
      return `${entryLabel}.slice_id must be a canonical identifier`;
    }
    if (seenSlices.has(sliceId)) {
      return `${entryLabel}.slice_id is duplicated`;
    }
    seenSlices.add(sliceId);
    if (typeof binding.integration_receipt_digest !== 'string' || !SHA256_RE.test(binding.integration_receipt_digest)) {
      return `${entryLabel}.integration_receipt_digest must be a lowercase SHA-256 digest`;
    }
    if (typeof binding.commit_sha !== 'string' || !GIT_SHA_RE.test(binding.commit_sha)) {
      return `${entryLabel}.commit_sha must be a full lowercase Git commit SHA`;
    }
  }
  return null;
}

/**
 * Closed v2 STAGE_REVIEW_RESULT record validation at the same strength as
 * `validateVNextReviewRecord` in admit-pipeline.ts.  Returns an error message
 * or null when the record is closed-valid.
 */
function validateClosedReviewRecord(
  value: Record<string, unknown>,
  label: string,
): string | null {
  // `runtime_proof_digest` is a legacy field tolerated on archived
  // pre-decision Review Receipts only (the Runtime Proof it bound was
  // deleted); every other member is required.
  const unknown = Reflect.ownKeys(value).filter(
    (key) => typeof key !== 'string' || !VNEXT_REVIEW_RECORD_FIELDS.has(key),
  );
  if (unknown.length > 0) {
    return `${label} contains unknown field(s): ${unknown.map(String).join(', ')}`;
  }
  for (const field of VNEXT_REVIEW_RECORD_FIELDS) {
    if (field === 'runtime_proof_digest') continue;
    if (!hasOwn(value, field)) return `${label}.${field} is required`;
  }
  if (value.schema_version !== 2) return `${label}.schema_version must be 2`;
  if (value.type !== 'STAGE_REVIEW_RESULT') return `${label}.type must be STAGE_REVIEW_RESULT`;
  if (value.action !== 'STAGE_REVIEW') return `${label}.action must be STAGE_REVIEW`;
  if (typeof value.stage_id !== 'string' || !CANONICAL_STAGE_ID.test(value.stage_id)) {
    return `${label}.stage_id must be a canonical Stage ID (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected`;
  }
  for (const field of [
    'manifest_digest',
    'plan_digest',
    'stage_plan_receipt_digest',
    'spv_receipt_digest',
    'stage_gate_receipt_digest',
  ]) {
    if (typeof value[field] !== 'string' || !SHA256_RE.test(value[field])) {
      return `${label}.${field} must be a lowercase SHA-256 digest`;
    }
  }
  if (
    value.runtime_proof_digest !== undefined &&
    (typeof value.runtime_proof_digest !== 'string' || !SHA256_RE.test(value.runtime_proof_digest))
  ) {
    return `${label}.runtime_proof_digest must be a lowercase SHA-256 digest when present (legacy field)`;
  }
  if (typeof value.snapshot_digest !== 'string' || !SNAPSHOT_RE.test(value.snapshot_digest)) {
    return `${label}.snapshot_digest must be a Git snapshot digest`;
  }
  if (value.verdict !== 'ACCEPTED' && value.verdict !== 'REPAIR') {
    return `${label}.verdict must be ACCEPTED or REPAIR`;
  }
  if (typeof value.summary !== 'string' || value.summary.length === 0) {
    return `${label}.summary must be a non-empty string`;
  }
  if (value.receipt_chain_valid !== true) {
    return `${label}.receipt_chain_valid must be true`;
  }
  return null;
}

function authorityBindingsAreValid(
  root: string,
  authority: VNextAdmissionAuthority,
  stageId: string,
  manifestDigest: string,
  planDigest: string,
  snapshotDigest: string,
): void {
  const stagePlan = authority.stagePlan;
  const spv = authority.spv;
  for (const [label, fact] of [
    ['stagePlan', stagePlan],
    ['spv', spv],
  ] as const) {
    if (
      fact.stage_id !== stageId ||
      fact.manifest_digest !== manifestDigest ||
      fact.plan_digest !== planDigest
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Review admission authority (${label}) does not bind the Manifest/Plan tuple`);
    }
  }
  if (stagePlan.spv_receipt_digest !== spv.digest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Review stagePlan does not bind its SPV receipt digest');
  }
  // The Stage Plan and the SPV proof it embeds were certified at the SAME
  // snapshot; a Stage Plan whose snapshot_digest disagrees with the fresh SPV
  // snapshot is a forged/mismatched authority and must fail closed.
  if (stagePlan.snapshot_digest !== spv.snapshot_digest) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      'vNext Stage Review stagePlan snapshot_digest does not match the SPV snapshot_digest',
    );
  }
  // The SPV proof was certified at its own snapshot; that snapshot must
  // precede the current integrated boundary or the authority is stale.
  assertAncestor(root, spv.snapshot_digest, snapshotDigest, 'SPV snapshot');
}

/**
 * Revalidate the complete Stage Review context.  Every reader here is
 * root-bound (canonical path + no-follow) and never enters the legacy
 * reconcile/reader.
 *
 * Stage Gate precondition (fail closed): the stage-gate chain must contain
 * ONLY v2 GATE_PASS/GATE_FAIL facts bound to the active Manifest/Proof/
 * Authority tuple, the chain must be non-empty and its tip must be a PASS
 * verdict bound to the current integrated snapshot EXACTLY.  P-09
 * (REPAIR-driven re-run): a HISTORICAL Gate Receipt (non-tip) may bind an
 * ANCESTOR of the current snapshot — the re-gate appends a new PASS tip at
 * the advanced HEAD while the earlier PASS stays as write-once history; a
 * historical snapshot that is not an ancestor fails closed.  The gate tip
 * digest is bound into the Review Receipt as `stage_gate_receipt_digest`.
 *
 * Review chain rules: only v2 STAGE_REVIEW_RESULT/STAGE_REVIEW facts bound to
 * the active tuple are accepted; an ACCEPTED tip refuses any further review
 * (the stage review already passed); a REPAIR tip admits the next round.
 * P-09 (REPAIR-driven re-run): the chain TIP binds the CURRENT gate tip and
 * the CURRENT integrated snapshot EXACTLY when the tip is ACCEPTED — a
 * closed review is terminal (no re-gate may follow it), so any deviation is
 * forged and fails closed.  A HISTORICAL Review Receipt (non-tip, or an
 * open REPAIR tip that the incoming round supersedes) may bind any Stage
 * Gate Receipt that is still in the current gate chain and a snapshot that
 * is an ANCESTOR of (or equal to) the current boundary — the re-gate keeps
 * every earlier Receipt as write-once history, so the round that preceded
 * it stays legal.
 */
function validateFacts(
  request: VNextStageReviewAdmissionRequest,
  dependencies: VNextReviewAdmissionDependencies,
  options: VNextReviewValidationOptions = {},
): ValidatedReviewFacts {
  const root = canonicalProjectRoot(dependencies.projectRoot);
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${request.stageId}.json`);

  const route = detectPlanManifestRoute(root, manifestPath);
  if (route !== 'vnext') {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Review requires a vNext Manifest route, got "${route}"`);
  }

  let manifest: VNextManifest;
  try {
    manifest = readVNextManifest(root, manifestPath);
  } catch (error) {
    if (!(error instanceof VNextHandoffError)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Review could not read the Manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Review could not read the Manifest: ${error.message}`);
  }
  if (manifest.stage_id !== request.stageId) {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Review Manifest stage_id "${manifest.stage_id}" does not match request "${request.stageId}"`);
  }
  const manifestDigest = computeDigest(manifest);
  if (manifestDigest !== request.manifestDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Review request manifestDigest does not match the persisted Manifest');
  }
  const planDigest = manifest.plan.plan_digest;
  if (typeof planDigest !== 'string' || !SHA256_RE.test(planDigest)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Review Manifest plan_digest is not a lowercase SHA-256 digest');
  }
  try {
    assertVNextManifestReferenceBindings(root, manifest);
  } catch (error) {
    if (error instanceof VNextHandoffError) {
      fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Review Manifest reference bindings are broken: ${error.message}`);
    }
    throw error;
  }

  let authority: VNextAdmissionAuthority;
  try {
    authority = readVNextAdmissionAuthority(root, request.stageId);
  } catch (error) {
    if (!(error instanceof VNextHandoffError)) throw error;
    fail(
      error.code === 'admission-missing' ? 'DOMAIN.INVALID_TRANSITION' : 'RUNTIME.SCHEMA_MISMATCH',
      `vNext Stage Review admission authority is unavailable: ${error.message}`,
    );
  }
  authorityBindingsAreValid(root, authority, request.stageId, manifestDigest, planDigest, request.snapshotDigest);

  if (options.skipCleanWorkingTree !== true) {
    assertCleanWorkingTree(root);
  }
  assertStableGitBoundary(root, request.snapshotDigest);
  const snapshotDigest = request.snapshotDigest;

  // Stage Gate precondition: every Gate fact is a closed v2 fact bound to the
  // active tuple and snapshot, and the chain tip is a PASS verdict.
  const gateDirectory = stageGateReceiptDir(root, request.stageId);
  const gateChain = readReceiptChain(root, gateDirectory, 'stage-gate chain');
  if (gateChain.receipts.length === 0) {
    fail('DOMAIN.INVALID_TRANSITION', `stage "${request.stageId}" has no Stage Gate Receipt before the Stage Review`);
  }
  for (let gateIndex = 0; gateIndex < gateChain.receipts.length; gateIndex += 1) {
    const receipt = gateChain.receipts[gateIndex];
    if (receipt.type !== 'GATE_PASS' && receipt.type !== 'GATE_FAIL') {
      fail('RUNTIME.SCHEMA_MISMATCH', `stage-gate chain contains ${receipt.type}; expected only GATE_PASS/GATE_FAIL vNext facts`);
    }
    const payload = receipt.payload;
    if (!isRecord(payload) || payload.schema_version !== 2 || payload.type !== 'GATE_RESULT' || payload.action !== 'GATE') {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage-gate chain contains a legacy v1 Gate fact or a vNext Gate fact without the GATE_RESULT/GATE discriminator');
    }
    const gateRecordError = validateClosedGateRecord(
      payload,
      `stage-gate chain Receipt ${receipt.digest} payload`,
    );
    if (gateRecordError !== null) {
      fail('RUNTIME.SCHEMA_MISMATCH', `stage-gate chain contains a Gate Receipt that fails the closed v2 schema: ${gateRecordError}`);
    }
    if (
      payload.stage_id !== request.stageId ||
      payload.manifest_digest !== manifestDigest ||
      payload.plan_digest !== planDigest ||
      payload.stage_plan_receipt_digest !== authority.stagePlan.digest ||
      payload.spv_receipt_digest !== authority.spv.digest
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage-gate chain contains a Gate Receipt that does not bind the active Manifest/Authority tuple');
    }
    if (typeof payload.snapshot_digest !== 'string' || !SNAPSHOT_RE.test(payload.snapshot_digest)) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage-gate chain contains a Gate Receipt with an invalid snapshot binding');
    }
    // P-09 (REPAIR-driven re-run): the chain TIP must bind the current
    // integrated snapshot EXACTLY (unchanged); a HISTORICAL Gate Receipt
    // (non-tip) may bind an ANCESTOR of the current snapshot — the re-gate
    // appends a new PASS tip at the advanced HEAD while the earlier PASS
    // stays as write-once history.  A historical snapshot that is NOT an
    // ancestor (forged / unrelated boundary) fails closed.
    if (gateIndex === gateChain.receipts.length - 1) {
      if (payload.snapshot_digest !== snapshotDigest) {
        fail('RUNTIME.SCHEMA_MISMATCH', 'stage-gate chain tip does not bind the current integrated snapshot');
      }
    } else {
      assertAncestor(root, payload.snapshot_digest, snapshotDigest, 'stage-gate chain historical Gate Receipt snapshot');
    }
    if (payload.verdict !== 'PASS' && payload.verdict !== 'FAIL') {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage-gate chain contains a Gate Receipt with an invalid verdict');
    }
  }
  const gateTip = gateChain.receipts[gateChain.receipts.length - 1];
  if ((gateTip.payload as Record<string, unknown>).verdict !== 'PASS') {
    fail('DOMAIN.INVALID_TRANSITION', `stage "${request.stageId}" has no Stage Gate PASS tip before the Stage Review`);
  }

  // Review chain: only closed v2 Review facts bound to the active tuple.
  const reviewDirectory = reviewReceiptDir(root, request.stageId);
  const reviewChain = readReceiptChain(root, reviewDirectory, 'stage review chain');
  const reviewTipDigest = reviewChain.receipts.length > 0
    ? reviewChain.receipts[reviewChain.receipts.length - 1].digest
    : null;
  // P-09 (REPAIR-driven re-run): a re-gate advances the gate tip/snapshot
  // while every earlier Gate Receipt stays as write-once history, so a
  // Review round that preceded the re-gate binds the gate tip/snapshot that
  // were current at ITS time — not the current ones.  The chain TIP splits:
  // an ACCEPTED tip is terminal (it certifies the CURRENT gate tip and the
  // CURRENT integrated snapshot EXACTLY — a closed review can never be
  // followed by a re-gate, so any deviation is forged), while a REPAIR tip
  // is an OPEN round that the incoming Review supersedes, so it is
  // validated with the historical fail-closed rules below.
  const gateReceiptDigests = new Set(gateChain.receipts.map((gateReceipt) => gateReceipt.digest));
  for (let reviewIndex = 0; reviewIndex < reviewChain.receipts.length; reviewIndex += 1) {
    const receipt = reviewChain.receipts[reviewIndex];
    if (receipt.type !== 'STAGE_REVIEW_PASS') {
      fail('RUNTIME.SCHEMA_MISMATCH', `stage review chain contains ${receipt.type}; expected only STAGE_REVIEW_PASS vNext facts`);
    }
    const payload = receipt.payload;
    if (!isRecord(payload) || payload.schema_version !== 2 || payload.type !== 'STAGE_REVIEW_RESULT' || payload.action !== 'STAGE_REVIEW') {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage review chain contains a legacy v1 Review fact or a vNext Review fact without the STAGE_REVIEW_RESULT/STAGE_REVIEW discriminator');
    }
    const reviewRecordError = validateClosedReviewRecord(
      payload,
      `stage review chain Receipt ${receipt.digest} payload`,
    );
    if (reviewRecordError !== null) {
      fail('RUNTIME.SCHEMA_MISMATCH', `stage review chain contains a Review Receipt that fails the closed v2 schema: ${reviewRecordError}`);
    }
    // Manifest/Authority tuple bindings stay STRICT for every Receipt
    // (tip and history alike): re-gate does not change these tuples.
    if (
      payload.stage_id !== request.stageId ||
      payload.manifest_digest !== manifestDigest ||
      payload.plan_digest !== planDigest ||
      payload.stage_plan_receipt_digest !== authority.stagePlan.digest ||
      payload.spv_receipt_digest !== authority.spv.digest
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage review chain contains a Review Receipt that does not bind the active Manifest/Authority tuple');
    }
    if (typeof payload.snapshot_digest !== 'string' || !SNAPSHOT_RE.test(payload.snapshot_digest)) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage review chain contains a Review Receipt with an invalid snapshot binding');
    }
    const isChainTip = reviewIndex === reviewChain.receipts.length - 1;
    if (isChainTip && payload.verdict === 'ACCEPTED') {
      // TIP + ACCEPTED (terminal): strict bindings — the closed review must
      // certify the CURRENT gate tip and the CURRENT integrated snapshot
      // EXACTLY (unchanged).
      if (payload.stage_gate_receipt_digest !== gateTip.digest) {
        fail('RUNTIME.SCHEMA_MISMATCH', 'stage review chain tip does not bind the current Stage Gate tip');
      }
      if (payload.snapshot_digest !== snapshotDigest) {
        fail('RUNTIME.SCHEMA_MISMATCH', 'stage review chain tip does not bind the current integrated snapshot');
      }
    } else {
      // Historical Receipt (non-tip) OR an open REPAIR tip superseded by the
      // current round: the gate binding must still exist in the current gate
      // chain (a re-gate keeps every earlier PASS as write-once history; a
      // digest that is not in the chain is forged → fail-closed) and the
      // snapshot must be an ANCESTOR of (or equal to) the current boundary
      // (the old gate's snapshot precedes the advanced HEAD).
      if (
        typeof payload.stage_gate_receipt_digest !== 'string' ||
        !gateReceiptDigests.has(payload.stage_gate_receipt_digest)
      ) {
        fail('RUNTIME.SCHEMA_MISMATCH', 'stage review chain contains a Review Receipt that does not bind a persisted Stage Gate Receipt');
      }
      assertAncestor(root, payload.snapshot_digest, snapshotDigest, 'stage review chain historical Review Receipt snapshot');
    }
    if (payload.verdict !== 'ACCEPTED' && payload.verdict !== 'REPAIR') {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage review chain contains a Review Receipt with an invalid verdict');
    }
  }

  if (options.allowInstalledReviewTip === undefined) {
    if (reviewTipDigest !== null) {
      const tip = reviewChain.receipts[reviewChain.receipts.length - 1];
      if ((tip.payload as Record<string, unknown>).verdict === 'ACCEPTED') {
        fail('DOMAIN.INVALID_TRANSITION', `stage "${request.stageId}" already has a Stage Review ACCEPTED tip; re-review refused`);
      }
    }
  } else if (reviewTipDigest !== options.allowInstalledReviewTip) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'stage review chain tip is not the just-installed Review receipt');
  }

  return {
    root,
    manifest,
    manifestDigest,
    planDigest,
    authority,
    snapshotDigest,
    gateTipDigest: gateTip.digest,
    reviewTipDigest,
  };
}

function assertReviewFactsUnchanged(
  before: ValidatedReviewFacts,
  after: ValidatedReviewFacts,
): void {
  if (after.manifestDigest !== before.manifestDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Manifest digest changed during the Stage Review write');
  }
  if (after.planDigest !== before.planDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Plan digest changed during the Stage Review write');
  }
  if (
    after.snapshotDigest !== before.snapshotDigest ||
    after.authority.stagePlan.digest !== before.authority.stagePlan.digest ||
    after.authority.spv.digest !== before.authority.spv.digest ||
    after.gateTipDigest !== before.gateTipDigest
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'snapshot, admission authority or Stage Gate tip changed during the Stage Review write');
  }
}

function assertInstalledReviewReceipt(
  facts: ValidatedReviewFacts,
  writeResult: { readonly path: string; readonly digest: string },
): void {
  const reviewChain = readReceiptChain(
    facts.root,
    reviewReceiptDir(facts.root, facts.manifest.stage_id),
    'stage review chain after write',
  );
  const tip = reviewChain.receipts[reviewChain.receipts.length - 1];
  if (reviewChain.tipDigest !== writeResult.digest || tip === undefined) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'the freshly written Stage Review receipt is not the stage review chain tip');
  }
}

// ============================================================
// State / build / persistence
// ============================================================

export interface VNextReviewAdmissionDependencies {
  readonly projectRoot: string;
  readonly writer?: ReceiptWriterPort;
}

/**
 * Assemble the closed vNext Stage Review request from the shared Host/Runtime
 * `StageReviewAdmissionRequest` and the persisted facts.  The Host layer never
 * computes digests: every binding (Manifest digest, current Git HEAD snapshot,
 * deterministic Runtime Proof digest) is derived here from root-bound reads
 * and re-verified inside `admitVNextStageReview`.  Failures return a rejected
 * AdmitResult (never a bare exception).
 */
export function assembleVNextStageReviewRequest(
  request: StageReviewAdmissionRequest,
  projectRoot: string,
):
  | { ok: true; request: VNextStageReviewAdmissionRequest }
  | { ok: false; result: AdmitResult<VNextReviewAdmissionState> } {
  const root = canonicalProjectRoot(projectRoot);
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${request.stageId}.json`);

  const route = detectPlanManifestRoute(root, manifestPath);
  if (route !== 'vnext') {
    return {
      ok: false,
      result: rejectedReview(
        `vNext Stage Review assembly requires a vNext Manifest route, got "${route}"`,
      ),
    };
  }

  let manifest: VNextManifest;
  try {
    manifest = readVNextManifest(root, manifestPath);
  } catch (error) {
    return {
      ok: false,
      result: rejectedReview(
        `vNext Stage Review assembly could not read the Manifest: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  if (manifest.stage_id !== request.stageId) {
    return {
      ok: false,
      result: rejectedReview(
        `vNext Stage Review Manifest stage_id "${manifest.stage_id}" does not match request "${request.stageId}"`,
      ),
    };
  }
  const manifestDigest = computeDigest(manifest);

  let snapshotDigest: string;
  try {
    const gitRoot = resolveGitRoot(root);
    const head = readGitHead(gitRoot);
    if (head === null || !SNAPSHOT_RE.test(head)) {
      return {
        ok: false,
        result: rejectedReview(
          'vNext Stage Review assembly cannot resolve the current Git HEAD as the integrated snapshot',
        ),
      };
    }
    snapshotDigest = head;
  } catch (error) {
    return {
      ok: false,
      result: rejectedReview(
        `vNext Stage Review assembly cannot resolve the Git boundary: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }

  return {
    ok: true,
    request: {
      type: 'stage_review',
      stageId: request.stageId,
      verdict: request.verdict as VNextStageReviewAdmissionRequest['verdict'],
      manifestDigest,
      snapshotDigest,
      summary: request.summary,
    },
  };
}

function reviewState(facts: ValidatedReviewFacts, request: VNextStageReviewAdmissionRequest): VNextReviewAdmissionState {
  return {
    schema_version: VNEXT_REVIEW_SCHEMA_VERSION,
    type: VNEXT_REVIEW_RESULT_TYPE,
    action: VNEXT_REVIEW_ACTION,
    stage_id: request.stageId,
    manifest_digest: facts.manifestDigest,
    plan_digest: facts.planDigest,
    stage_plan_receipt_digest: facts.authority.stagePlan.digest,
    spv_receipt_digest: facts.authority.spv.digest,
    stage_gate_receipt_digest: facts.gateTipDigest,
    snapshot_digest: facts.snapshotDigest,
    verdict: request.verdict,
    summary: request.summary,
    receipt_chain_valid: true,
  };
}

function reviewReceiptBuild(facts: ValidatedReviewFacts, request: VNextStageReviewAdmissionRequest): ReceiptBuild {
  return {
    type: 'STAGE_REVIEW_PASS',
    stage_id: request.stageId,
    timestamp: new Date().toISOString(),
    payload: { ...reviewState(facts, request) },
  };
}

function rejectedReview(
  message: string,
  code: ReviewAdmissionCode = 'RUNTIME.SCHEMA_MISMATCH',
): AdmitResult<VNextReviewAdmissionState> {
  return {
    accepted: false,
    receipt_ref: null,
    new_state: null,
    findings: [{ code, severity: 'error', message }],
  };
}

/**
 * Admit one vNext Stage Review fact without entering legacy reconcile/reducer
 * code.  The only persistence operation is the shared bounded Receipt seam.
 */
export function admitVNextStageReview(
  value: unknown,
  dependencies: VNextReviewAdmissionDependencies,
): AdmitResult<VNextReviewAdmissionState> {
  let request: VNextStageReviewAdmissionRequest;
  try {
    request = validateVNextStageReviewRequest(value);
  } catch (error) {
    const code = error instanceof VNextReviewAdmissionError ? error.code : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedReview(
      `vNext Stage Review request rejected by closed schema: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  let facts: ValidatedReviewFacts;
  try {
    facts = validateFacts(request, dependencies);
  } catch (error) {
    const code = error instanceof VNextReviewAdmissionError ? error.code : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedReview(
      `vNext Stage Review admission blocked: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  const state = reviewState(facts, request);
  const root = facts.root;
  return runReceiptAdmission<VNextReviewAdmissionState>({
    build: reviewReceiptBuild(facts, request),
    targetDir: reviewReceiptDir(root, request.stageId),
    nextState: state,
    writer: dependencies.writer,
    projectRoot: root,
    admissionKey: `vnext-review:${request.stageId}:${request.snapshotDigest}`,
    beforeWrite: () => {
      assertVNextReviewRoute(root, request.stageId);
      const current = validateFacts(request, dependencies, {});
      assertReviewFactsUnchanged(facts, current);
    },
    afterWrite: (writeResult) => {
      assertVNextReviewRoute(root, request.stageId);
      const current = validateFacts(request, dependencies, {
        allowInstalledReviewTip: writeResult.digest,
        skipCleanWorkingTree: true,
      });
      assertReviewFactsUnchanged(facts, current);
      assertInstalledReviewReceipt(facts, writeResult);
    },
  });
}

function assertVNextReviewRoute(root: string, stageId: string): void {
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${stageId}.json`);
  const route = detectPlanManifestRoute(root, manifestPath);
  if (route !== 'vnext') {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Review route changed during admission (got "${route}")`);
  }
}

// ============================================================
// S10-D-T01: read-only Stage Review status seam
// ============================================================
//
// `readVNextStageReviewStatus` is the read-only projection the review CLI
// domain consumes (`review status` / `review prepare-stage`).  It revalidates
// the integrated prefix FROM PERSISTED RECEIPTS at the same closed-schema
// strength as the admit path (type closure, payload closed schema, stage/tuple
// bindings, snapshot format, verdict enums) but WITHOUT the admit-only
// preconditions (a Gate PASS tip and a non-ACCEPTED review tip are reported as
// facts, never demanded): an empty review chain is a normal queryable state.
// Every read is root-bound/no-follow and never enters legacy reconcile.  A
// broken/misplaced/forged chain fails closed (canonical Finding, no write).

/** One chain-tip projection (never leaks a full Receipt payload). */
export interface VNextReviewChainTipReport {
  readonly receipt_type: string;
  readonly verdict: string;
  readonly digest: string;
  /** Root-relative digest-addressed Receipt ref. */
  readonly ref: string;
}

/** Read-only Stage Review status report（CLI envelope 直接投影）。 */
export interface VNextStageReviewStatusReport {
  readonly schema_version: 2;
  readonly stage_id: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly snapshot_digest: string;
  readonly review: {
    readonly receipt_count: number;
    readonly latest: VNextReviewChainTipReport | null;
  };
  readonly stage_gate: {
    readonly receipt_count: number;
    readonly latest: VNextReviewChainTipReport | null;
  };
  /** A next review round is admissible: Gate PASS tip && review tip !== ACCEPTED. */
  readonly ready_for_review: boolean;
  /**
   * P-11 task B: whether the Stage carries a legal v2 STAGE_CLOSE_RESULT
   * envelope (the Stage is closed/archived — a historical snapshot).  An
   * archived Stage is never ready for review.
   */
  readonly archived: boolean;
  /** P-11 task B: archived-marker projection（未归档时为 0 / null）。 */
  readonly stage_close: {
    readonly receipt_count: number;
    readonly latest: {
      readonly digest: string;
      readonly receipt_type: string;
      readonly close_type: string;
    } | null;
  };
}

function reviewReceiptRef(stageId: string, digest: string): string {
  return path.posix.join('.proofloop', 'receipts', 'review', stageId, `${digest}.json`);
}

function stageGateReceiptRef(stageId: string, digest: string): string {
  return path.posix.join('.proofloop', 'receipts', 'stage-gate', stageId, `${digest}.json`);
}

/**
 * Read-only Stage Review status projection（零写入）。
 *
 * Validates, at closed-schema strength:
 *  - canonical Stage ID（`^S\d+$`；legacy labels fail closed）;
 *  - vNext Manifest route + Manifest/plan digest bindings;
 *  - current Git HEAD as the integrated snapshot;
 *  - the admission authority tuple（stagePlan ↔ spv ↔ manifest/plan/snapshot）;
 *  - every persisted stage-gate Receipt: type closure（GATE_PASS/GATE_FAIL）、
 *    outer stage_id、closed GATE_RESULT payload schema、tuple bindings、
 *    snapshot format、verdict enum;
 *  - every persisted review Receipt: type closure（STAGE_REVIEW_PASS）、
 *    outer stage_id、closed STAGE_REVIEW_RESULT payload schema、tuple
 *    bindings（incl. `stage_gate_receipt_digest` present in the gate chain）、
 *    snapshot format、verdict enum;
 *  - chain topology + digest addressing + self-digests（readReceiptChain）.
 *
 * An empty gate/review chain is a normal pre-review state（reported, not
 * refused）; a broken chain fails closed（RUNTIME.RECEIPT_CHAIN_BROKEN）.
 */
export function readVNextStageReviewStatus(
  projectRoot: string,
  stageId: string,
): VNextStageReviewStatusReport {
  const root = canonicalProjectRoot(projectRoot);
  if (!CANONICAL_STAGE_ID.test(stageId)) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      'stageId must be a canonical Stage ID (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected',
    );
  }
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${stageId}.json`);
  const route = detectPlanManifestRoute(root, manifestPath);
  if (route !== 'vnext') {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Review status requires a vNext Manifest route, got "${route}"`);
  }

  let manifest: VNextManifest;
  try {
    manifest = readVNextManifest(root, manifestPath);
  } catch (error) {
    if (!(error instanceof VNextHandoffError)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Review status could not read the Manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Review status could not read the Manifest: ${error.message}`);
  }
  if (manifest.stage_id !== stageId) {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Review status Manifest stage_id "${manifest.stage_id}" does not match "${stageId}"`);
  }
  const manifestDigest = computeDigest(manifest);
  const planDigest = manifest.plan.plan_digest;
  if (typeof planDigest !== 'string' || !SHA256_RE.test(planDigest)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Review status Manifest plan_digest is not a lowercase SHA-256 digest');
  }

  let snapshotDigest: string;
  try {
    const gitRoot = resolveGitRoot(root);
    const head = readGitHead(gitRoot);
    if (head === null || !SNAPSHOT_RE.test(head)) {
      fail('DOMAIN.INVALID_TRANSITION', 'vNext Stage Review status cannot resolve the current Git HEAD as the integrated snapshot');
    }
    snapshotDigest = head;
  } catch (error) {
    fail('DOMAIN.INVALID_TRANSITION', `vNext Stage Review status cannot resolve the Git boundary: ${error instanceof Error ? error.message : String(error)}`);
  }

  let authority: VNextAdmissionAuthority;
  try {
    authority = readVNextAdmissionAuthority(root, stageId);
  } catch (error) {
    if (!(error instanceof VNextHandoffError)) throw error;
    fail(
      error.code === 'admission-missing' ? 'DOMAIN.INVALID_TRANSITION' : 'RUNTIME.SCHEMA_MISMATCH',
      `vNext Stage Review status admission authority is unavailable: ${error.message}`,
    );
  }
  authorityBindingsAreValid(root, authority, stageId, manifestDigest, planDigest, snapshotDigest);

  // Stage-gate chain（前缀事实；空链 = 尚未 Gate，正常状态）。
  const gateChain = readReceiptChain(root, stageGateReceiptDir(root, stageId), 'stage-gate chain');
  const gateDigests = new Set<string>();
  for (const receipt of gateChain.receipts) {
    gateDigests.add(receipt.digest);
    if (receipt.type !== 'GATE_PASS' && receipt.type !== 'GATE_FAIL') {
      fail('RUNTIME.SCHEMA_MISMATCH', `stage-gate chain contains ${receipt.type}; expected only GATE_PASS/GATE_FAIL vNext facts`);
    }
    const payload = receipt.payload;
    if (!isRecord(payload) || payload.schema_version !== 2 || payload.type !== 'GATE_RESULT' || payload.action !== 'GATE') {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage-gate chain contains a legacy v1 Gate fact or a vNext Gate fact without the GATE_RESULT/GATE discriminator');
    }
    const gateRecordError = validateClosedGateRecord(
      payload,
      `stage-gate chain Receipt ${receipt.digest} payload`,
    );
    if (gateRecordError !== null) {
      fail('RUNTIME.SCHEMA_MISMATCH', `stage-gate chain contains a Gate Receipt that fails the closed v2 schema: ${gateRecordError}`);
    }
    if (
      payload.stage_id !== stageId ||
      payload.manifest_digest !== manifestDigest ||
      payload.plan_digest !== planDigest ||
      payload.stage_plan_receipt_digest !== authority.stagePlan.digest ||
      payload.spv_receipt_digest !== authority.spv.digest
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage-gate chain contains a Gate Receipt that does not bind the active Manifest/Authority tuple');
    }
    if (typeof payload.snapshot_digest !== 'string' || !SNAPSHOT_RE.test(payload.snapshot_digest)) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage-gate chain contains a Gate Receipt with an invalid snapshot binding');
    }
    if (payload.verdict !== 'PASS' && payload.verdict !== 'FAIL') {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage-gate chain contains a Gate Receipt with an invalid verdict');
    }
  }

  // Review chain（终态事实；空链 = 尚未 Review，正常状态）。
  const reviewChain = readReceiptChain(root, reviewReceiptDir(root, stageId), 'stage review chain');
  for (const receipt of reviewChain.receipts) {
    if (receipt.type !== 'STAGE_REVIEW_PASS') {
      fail('RUNTIME.SCHEMA_MISMATCH', `stage review chain contains ${receipt.type}; expected only STAGE_REVIEW_PASS vNext facts`);
    }
    const payload = receipt.payload;
    if (!isRecord(payload) || payload.schema_version !== 2 || payload.type !== 'STAGE_REVIEW_RESULT' || payload.action !== 'STAGE_REVIEW') {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage review chain contains a legacy v1 Review fact or a vNext Review fact without the STAGE_REVIEW_RESULT/STAGE_REVIEW discriminator');
    }
    const reviewRecordError = validateClosedReviewRecord(
      payload,
      `stage review chain Receipt ${receipt.digest} payload`,
    );
    if (reviewRecordError !== null) {
      fail('RUNTIME.SCHEMA_MISMATCH', `stage review chain contains a Review Receipt that fails the closed v2 schema: ${reviewRecordError}`);
    }
    if (
      payload.stage_id !== stageId ||
      payload.manifest_digest !== manifestDigest ||
      payload.plan_digest !== planDigest ||
      payload.stage_plan_receipt_digest !== authority.stagePlan.digest ||
      payload.spv_receipt_digest !== authority.spv.digest
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage review chain contains a Review Receipt that does not bind the active Manifest/Authority tuple');
    }
    if (typeof payload.snapshot_digest !== 'string' || !SNAPSHOT_RE.test(payload.snapshot_digest)) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage review chain contains a Review Receipt with an invalid snapshot binding');
    }
    if (typeof payload.stage_gate_receipt_digest !== 'string' || !gateDigests.has(payload.stage_gate_receipt_digest)) {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage review chain contains a Review Receipt that does not bind a persisted Stage Gate Receipt');
    }
  }
  if (reviewChain.receipts.length > 0 && gateChain.receipts.length === 0) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', 'stage review chain exists but the stage-gate chain is empty (inconsistent prefix)');
  }

  const gateTip = gateChain.receipts.length > 0
    ? gateChain.receipts[gateChain.receipts.length - 1]
    : null;
  const gateTipPayload = gateTip !== null && isRecord(gateTip.payload) ? gateTip.payload : null;
  const reviewTip = reviewChain.receipts.length > 0
    ? reviewChain.receipts[reviewChain.receipts.length - 1]
    : null;
  const reviewTipPayload = reviewTip !== null && isRecord(reviewTip.payload) ? reviewTip.payload : null;

  const gateLatest: VNextReviewChainTipReport | null = gateTip === null || gateTipPayload === null
    ? null
    : {
        receipt_type: gateTip.type,
        verdict: gateTipPayload.verdict as string,
        digest: gateTip.digest,
        ref: stageGateReceiptRef(stageId, gateTip.digest),
      };
  const reviewLatest: VNextReviewChainTipReport | null = reviewTip === null || reviewTipPayload === null
    ? null
    : {
        receipt_type: reviewTip.type,
        verdict: reviewTipPayload.verdict as string,
        digest: reviewTip.digest,
        ref: reviewReceiptRef(stageId, reviewTip.digest),
      };

  const gateTipVerdict = gateTipPayload !== null && gateTipPayload.verdict === 'PASS';
  const reviewTipAccepted = reviewTipPayload !== null && reviewTipPayload.verdict === 'ACCEPTED';

  // P-11 task B: the STAGE_CLOSE probe is root-bound and fail-closed — an
  // unreadable/corrupt stage-close directory blocks the status report instead
  // of degrading to "not archived".
  let closeFacts: ReturnType<typeof readStageCloseFacts>;
  try {
    closeFacts = readStageCloseFacts(root, stageId);
  } catch (error) {
    fail(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      `stage-close facts are unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const archived = closeFacts.archived;
  const stageCloseLatest = archived && closeFacts.latest !== undefined && closeFacts.latest !== null
    ? {
        digest: closeFacts.latest.digest,
        receipt_type: closeFacts.latest.receipt_type,
        close_type: closeFacts.latest.close_type,
      }
    : null;

  return {
    schema_version: 2,
    stage_id: stageId,
    manifest_digest: manifestDigest,
    plan_digest: planDigest,
    snapshot_digest: snapshotDigest,
    review: {
      receipt_count: reviewChain.receipts.length,
      latest: reviewLatest,
    },
    stage_gate: {
      receipt_count: gateChain.receipts.length,
      latest: gateLatest,
    },
    // An archived Stage is a historical snapshot: even a Gate PASS tip must
    // never project it as ready for a next review round.
    ready_for_review: gateTipVerdict && !reviewTipAccepted && !archived,
    archived,
    stage_close: {
      receipt_count: archived ? (closeFacts.receipt_count ?? 0) : 0,
      latest: stageCloseLatest,
    },
  };
}
