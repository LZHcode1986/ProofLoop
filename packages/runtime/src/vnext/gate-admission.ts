/**
 * vNext Stage Gate admission.
 *
 * The Gate is a downstream vNext consumer, not a legacy reconcile/reducer
 * path.  Dual-path SG (S10 backfill decision, 2026-08-13):
 *
 *  - Normal path (default): the Gate verifies ONLY that every Manifest
 *    Slice's vNext Integration Receipt chain exists, is non-empty, binds the
 *    current tuple (stage / Manifest / Plan / Proof Index / SPV snapshot)
 *    and has a valid tip.  The full Worker → CV → Slice Commit prefix is NOT
 *    revalidated here — the Integration admission already proved it
 *    machine-verified.
 *  - Fallback path (explicit `verification_source: "git_facts"` only): the
 *    Gate skips the Receipt chain check and instead verifies Git facts per
 *    Slice — an integration commit (message that EXACTLY starts with the
 *    `slice-output: <stage>-<slice>` marker, word-boundary exact-prefix
 *    match) in the HEAD ancestor chain, complete Task Evidence
 *    (`Status: COMPLETE`) and fully checked tasks.md checkboxes — BOTH at
 *    the integration commit AND at the current HEAD (a post-integration
 *    rollback that reverts Evidence/checkboxes fails the Gate).
 *    Missing/invalid declaration fails closed.  The fallback is
 *    ABSENCE-GATED (S10-SR-001-GIT-FACTS-FAIL-OPEN-001): it is legal ONLY
 *    when every Slice's INTEGRATION_PASS Receipt chain is missing — a
 *    complete authority Receipt chain can never be bypassed by merely
 *    declaring `git_facts`.
 *
 * The Gate never executes Manifest runtime_proof commands (build/test is
 * the Stage Review's job) and no longer binds a runtime_proof_digest (the
 * Runtime Proof field was deleted; the Gate verifies integration
 * completeness only).  The Gate
 * persists a single GATE_PASS/GATE_FAIL Receipt through the shared bounded
 * `runReceiptAdmission` seam.
 *
 * The Gate Receipt binds:
 *   - the Manifest (`manifest_digest`);
 *   - the Authority (`stage_plan_receipt_digest` + `spv_receipt_digest`);
 *   - the integrated snapshot (`snapshot_digest` = current Git HEAD) and each
 *     integrated Slice's binding (`integrated_slices`);
 *   - the verification path (`verification_source`: `receipts` | `git_facts`).
 *
 * v2 Gate receipts (schema_version 2, type GATE_RESULT, action GATE) never
 * enter the legacy reconcile/reader path; the v2 Gate consumer rejects v1
 * receipts in the stage-gate chain.
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
  VNextManifestSlice,
} from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
// S09-C-T03: the shared canonical Stage ID guard (`^S\d+$`).  Legacy parked
// labels such as S08B0/S08B fail closed before any Runtime read/write.
import { CANONICAL_STAGE_ID_RE } from './stage-id';
import { readGitHead, resolveGitRoot } from '../git-source';
import { detectPlanManifestRoute } from '../plan-services';
import {
  integrationReceiptDir,
  reviewReceiptDir,
  stageGateReceiptDir,
} from '../receipt-layout';
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
// Shared vNext Slice binding (Proof Index digest + evidence/plan paths from
// the Manifest, root-bound): the reduced Gate consumes only this pure
// binding — the Worker → CV → Slice Commit prefix revalidation was removed
// (the Integration admission already proved the full chain machine-verified).
import {
  sliceBinding,
  VNextIntegrationAdmissionError,
} from './integration-admission';
import type {
  SliceBinding,
  TaskBinding,
} from './integration-admission';
import {
  VNEXT_GATE_ACTION,
  VNEXT_GATE_RESULT_TYPE,
  VNEXT_GATE_SCHEMA_VERSION,
  VNEXT_GATE_VERDICTS,
} from './types';
import type {
  VNextAdmissionAuthority,
  VNextGateAdmissionState,
  VNextGateSliceIntegration,
} from './types';

const CANONICAL_STAGE_ID = CANONICAL_STAGE_ID_RE;
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const SNAPSHOT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const REQUEST_FIELDS = new Set([
  'type',
  'stageId',
  'verdict',
  'manifestDigest',
  'snapshotDigest',
  'summary',
  // Dual-path SG: explicit verification path declaration.  Absent → normal
  // receipts path; `git_facts` → explicit Git-facts fallback; any other
  // value fails closed.
  'verification_source',
  // P-09: explicit re-gate declaration (REPAIR-driven re-run after a PASS tip).
  're_gate',
]);

// ============================================================
// Error surface
// ============================================================

type GateAdmissionCode =
  | 'RUNTIME.SCHEMA_MISMATCH'
  | 'RUNTIME.RECEIPT_CHAIN_BROKEN'
  | 'DOMAIN.INVALID_TRANSITION';

class VNextGateAdmissionError extends Error {
  constructor(
    readonly code: GateAdmissionCode,
    message: string,
  ) {
    super(message);
    this.name = 'VNextGateAdmissionError';
  }
}

function fail(code: GateAdmissionCode, message: string): never {
  throw new VNextGateAdmissionError(code, message);
}

// ============================================================
// Request shape
// ============================================================

/**
 * Closed request shape used by the Runtime/Host Gate seam.  The Gate is
 * stage-level: no slice is bound by the request; slices are bound by the
 * Manifest and the persisted Integration prefix.
 */
export interface VNextGateResultAdmissionRequest {
  readonly type: 'gate_result';
  readonly stageId: string;
  readonly verdict: 'PASS' | 'FAIL';
  readonly manifestDigest: string;
  readonly snapshotDigest: string;
  readonly summary: string;
  /**
   * Dual-path SG: explicit verification path declaration.  Absent or
   * `receipts` → normal path (per-Slice INTEGRATION_PASS Receipt chains);
   * `git_facts` → explicit Git-facts fallback (no Receipt chains, Git
   * history facts instead).  The fallback is enabled ONLY by this explicit
   * declaration — missing declaration means the normal receipts path
   * (fail-closed, never a silent fallback).
   */
  readonly verification_source?: 'receipts' | 'git_facts';
  /**
   * P-09: explicit re-gate declaration.  When `true` and the stage-gate
   * chain already has a PASS tip, the Gate is allowed to append a NEW GATE
   * Receipt (the old PASS stays as write-once history) PROVIDED the stage
   * review chain tip is a REPAIR verdict (the REPAIR-driven re-run
   * semantics; a re-gate without a REPAIR tip fails closed).  Absent or
   * false keeps the existing fail-closed ALREADY_PASSED rule.
   */
  readonly re_gate?: boolean;
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

function requireGitSha(value: unknown, label: string): string {
  const digest = requireString(value, label);
  if (!GIT_SHA_RE.test(digest)) {
    fail('RUNTIME.SCHEMA_MISMATCH', `${label} must be a full lowercase Git commit SHA`);
  }
  return digest;
}

function canonicalProjectRoot(projectRoot: string): string {
  const absolute = path.resolve(projectRoot);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Gate admission requires an existing projectRoot directory');
  }
  return absolute;
}

export function validateVNextGateResultRequest(value: unknown): VNextGateResultAdmissionRequest {
  if (!isRecord(value)) fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Gate request must be an object');
  const unknown = Reflect.ownKeys(value).filter(
    (key) => typeof key !== 'string' || !REQUEST_FIELDS.has(key),
  );
  if (unknown.length > 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Gate request contains unknown field(s): ${unknown.map(String).join(', ')}`);
  }
  if (value.type !== 'gate_result') {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Gate request type must be gate_result');
  }
  const stageId = requireString(value.stageId, 'stageId');
  if (!CANONICAL_STAGE_ID.test(stageId)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'stageId must be a canonical Stage ID (expected /^S\\d+$/, e.g. S09); legacy labels such as S08B0/S08B are rejected');
  }
  if (!VNEXT_GATE_VERDICTS.includes(value.verdict as (typeof VNEXT_GATE_VERDICTS)[number])) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Gate request verdict must be PASS or FAIL');
  }
  const manifestDigest = requireSha256(value.manifestDigest, 'manifestDigest');
  const snapshotDigest = requireSnapshot(value.snapshotDigest, 'snapshotDigest');
  const summary = requireString(value.summary, 'summary');
  if (
    value.verification_source !== undefined &&
    value.verification_source !== 'receipts' &&
    value.verification_source !== 'git_facts'
  ) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      'vNext Gate request verification_source must be "receipts" or "git_facts" when present',
    );
  }
  if (value.re_gate !== undefined && typeof value.re_gate !== 'boolean') {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Gate request re_gate must be a boolean when present');
  }
  return {
    type: 'gate_result',
    stageId,
    verdict: value.verdict as VNextGateResultAdmissionRequest['verdict'],
    manifestDigest,
    snapshotDigest,
    summary,
    ...(value.verification_source === undefined
      ? {}
      : { verification_source: value.verification_source as 'receipts' | 'git_facts' }),
    ...(value.re_gate === undefined ? {} : { re_gate: value.re_gate }),
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
    if (error instanceof VNextGateAdmissionError) throw error;
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
      `vNext Gate refused: request snapshotDigest "${expectedSnapshot}" does not match the current Git HEAD "${head ?? 'unresolvable'}"`,
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
    fail('DOMAIN.INVALID_TRANSITION', `vNext Gate refused: cannot read git status: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (porcelain.trim().length > 0) {
    fail('DOMAIN.INVALID_TRANSITION', 'vNext Gate refused: working tree is not clean (git status --porcelain non-empty)');
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
      `vNext Gate refused: ${label} (${ancestor}) is not an ancestor of the integrated snapshot ${descendant}`,
    );
  }
}

// ============================================================
// Validation facts
// ============================================================

interface ValidatedGateFacts {
  readonly root: string;
  readonly manifest: VNextManifest;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly authority: VNextAdmissionAuthority;
  readonly snapshotDigest: string;
  readonly integratedSlices: readonly VNextGateSliceIntegration[];
  readonly gateTip: string | null;
}

interface VNextGateValidationOptions {
  /** After-write hop: the stage-gate tip is expected to be the installed digest. */
  readonly allowInstalledGateTip?: string;
  /** Skip the git-clean check (an installed Receipt may dirty a tracked root). */
  readonly skipCleanWorkingTree?: boolean;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return computeDigest(left) === computeDigest(right);
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
      fail('RUNTIME.SCHEMA_MISMATCH', `vNext Gate admission authority (${label}) does not bind the Manifest/Plan tuple`);
    }
  }
  if (stagePlan.spv_receipt_digest !== spv.digest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Gate stagePlan does not bind its SPV receipt digest');
  }
  // The Stage Plan and the SPV proof it embeds were certified at the SAME
  // snapshot; a Stage Plan whose snapshot_digest disagrees with the fresh SPV
  // snapshot is a forged/mismatched authority and must fail closed.
  if (stagePlan.snapshot_digest !== spv.snapshot_digest) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      'vNext Gate stagePlan snapshot_digest does not match the SPV snapshot_digest',
    );
  }
  // The SPV proof was certified at its own snapshot; that snapshot must
  // precede the current integrated boundary or the authority is stale.
  assertAncestor(root, spv.snapshot_digest, snapshotDigest, 'SPV snapshot');
}

interface SliceIntegrationBinding {
  readonly sliceId: string;
  readonly integrationReceiptDigest: string;
  readonly commitSha: string;
}

/**
 * Wrap a shared Integration/prefix validator so its fail-closed codes are
 * preserved in the Gate's error surface.
 */
function guardedShared<T>(label: string, work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof VNextIntegrationAdmissionError) {
      throw new VNextGateAdmissionError(error.code, `${label}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Assert that a Manifest-declared Slice has a complete, valid vNext
 * Integration Receipt chain and return its tip binding.  Legacy (v1)
 * integration facts mixed into the chain are refused.
 *
 * Dual-path SG: the Gate verifies ONLY the integration completeness — every
 * Receipt in the chain is an INTEGRATION_PASS v2 fact bound to the active
 * tuple (stage / Manifest / Plan / Proof Index / SPV snapshot) with a valid
 * commit binding and a valid tip.  The Worker → CV → Slice Commit prefix is
 * NOT revalidated here: the Integration admission already proved that chain
 * machine-verified (decision 2026-08-13).
 */
function readSliceIntegrationBinding(
  root: string,
  stageId: string,
  manifest: VNextManifest,
  slice: VNextManifestSlice,
  manifestDigest: string,
  planDigest: string,
  spvSnapshotDigest: string,
  snapshotDigest: string,
): SliceIntegrationBinding {
  const directory = integrationReceiptDir(root, stageId, slice.slice_id);
  const chain = readReceiptChain(root, directory, `integration chain for ${slice.slice_id}`);
  if (chain.receipts.length === 0) {
    fail('DOMAIN.INVALID_TRANSITION', `Slice "${slice.slice_id}" has no vNext Integration Receipt before the Gate`);
  }

  // Pure Manifest binding (Proof Index digest + artifact paths); never a
  // Receipt-chain read.
  const binding = guardedShared(`slice binding for ${slice.slice_id}`, () =>
    sliceBinding(root, manifest, slice.slice_id),
  );

  for (const receipt of chain.receipts) {
    if (receipt.type !== 'INTEGRATION_PASS') {
      fail('RUNTIME.SCHEMA_MISMATCH', `integration chain for ${slice.slice_id} contains ${receipt.type}; expected only INTEGRATION_PASS`);
    }
    const payload = receipt.payload;
    if (!isRecord(payload) || payload.schema_version !== 2) {
      fail('RUNTIME.SCHEMA_MISMATCH', `integration chain for ${slice.slice_id} contains a legacy v1 Integration fact`);
    }
    if (
      payload.type !== 'INTEGRATION_RESULT' ||
      payload.action !== 'INTEGRATION' ||
      payload.stage_id !== stageId ||
      payload.slice_id !== slice.slice_id ||
      payload.manifest_digest !== manifestDigest ||
      payload.plan_digest !== planDigest ||
      payload.receipt_chain_valid !== true
    ) {
      fail('RUNTIME.SCHEMA_MISMATCH', `integration chain for ${slice.slice_id} does not bind the active Manifest/Plan tuple`);
    }
    // T06: the Integration fact must be bound to the CURRENT Proof Index
    // digest (exact match), not merely a well-formed 64-hex digest. A
    // format-valid but foreign proof_index_digest (e.g. a sibling Slice's
    // Proof Index) would otherwise bypass the downstream Proof binding.
    if (
      typeof payload.proof_index_digest !== 'string' ||
      payload.proof_index_digest !== binding.proofIndexDigest
    ) {
      fail(
        'RUNTIME.SCHEMA_MISMATCH',
        `integration chain for ${slice.slice_id} proof_index_digest does not equal the current Proof Index digest`,
      );
    }
    // The Integration fact must be bound to the exact SPV-authority snapshot;
    // a format-valid but foreign snapshot_digest (e.g. the integrated HEAD)
    // is refused.
    if (typeof payload.snapshot_digest !== 'string' || payload.snapshot_digest !== spvSnapshotDigest) {
      fail(
        'RUNTIME.SCHEMA_MISMATCH',
        `integration chain for ${slice.slice_id} snapshot_digest does not equal the SPV authority snapshot`,
      );
    }
    if (typeof payload.commit_sha !== 'string' || !GIT_SHA_RE.test(payload.commit_sha)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `integration chain for ${slice.slice_id} has an invalid commit binding`);
    }
  }
  const tip = chain.receipts[chain.receipts.length - 1];
  const tipPayload = tip.payload as Record<string, unknown>;
  const commitSha = tipPayload.commit_sha as string;
  // The Slice's integrated commit must lie on the current integrated boundary.
  assertAncestor(root, commitSha, snapshotDigest, `Slice "${slice.slice_id}" integrated commit`);
  return {
    sliceId: slice.slice_id,
    integrationReceiptDigest: tip.digest,
    commitSha,
  };
}

/**
 * S10-SR-001-GIT-FACTS-FAIL-OPEN-001: absence-gate the git_facts fallback.
 * The fallback is legal ONLY when EVERY Slice's vNext INTEGRATION_PASS
 * Receipt chain is missing; if any Slice still carries a valid Integration
 * Receipt chain (or a chain that fails validation — which the receipts path
 * would refuse the same way), the Gate refuses git_facts fail-closed and
 * requires the normal receipts path.
 */
function assertGitFactsFallbackAbsent(
  root: string,
  stageId: string,
  manifest: VNextManifest,
): void {
  for (const slice of manifest.slices) {
    const chain = readReceiptChain(
      root,
      integrationReceiptDir(root, stageId, slice.slice_id),
      `integration chain for ${slice.slice_id}`,
    );
    if (chain.receipts.length > 0) {
      fail(
        'DOMAIN.INVALID_TRANSITION',
        `git_facts fallback refused: Slice "${slice.slice_id}" has vNext Integration receipts; git_facts is only available when every Slice's Integration receipts are missing (use the normal receipts path)`,
      );
    }
  }
}

// ============================================================
// Git-facts fallback (dual-path SG)
// ============================================================

/** Marker of the Slice integration commit: `slice-output: <stage>-<slice>`. */
function sliceOutputMarker(stageId: string, sliceId: string): string {
  return `slice-output: ${stageId}-${sliceId}`;
}

/**
 * Exact-prefix commit-subject match for the Slice integration marker
 * (S10-SR-001-GIT-FACTS-FAIL-OPEN-001): the subject must equal the marker or
 * start with the marker followed by a word boundary (whitespace).  A subject
 * that merely CONTAINS the marker as a substring — e.g.
 * `slice-output: S10-S10-A-repair`, `docs: slice-output: S10-S10-A noted` —
 * is NOT the Slice's integration commit and is refused.
 */
function isSliceOutputSubject(subject: string, marker: string): boolean {
  if (subject === marker) return true;
  if (!subject.startsWith(marker)) return false;
  return /^\s/.test(subject.slice(marker.length));
}

/** Read one root-relative file at a Git commit (fail-closed on any error). */
function readFileAtCommit(root: string, commitSha: string, relative: string, label: string): string {
  try {
    return execFileSync('git', ['-C', root, 'show', `${commitSha}:${relative}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      `${label} is not present at the Slice integration commit ${commitSha}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Extract the SINGLE `## Task Evidence` section (structured, line-based):
 * exactly one heading must exist and the section runs to the next `## `
 * heading or end-of-file.  Returns the section lines (after the heading).
 */
function taskEvidenceSectionLines(content: string, label: string): readonly string[] {
  const lines = content.split(/\r?\n/);
  const headings = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => entry.line === '## Task Evidence');
  if (headings.length !== 1) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      `${label} must contain exactly one "## Task Evidence" section`,
    );
  }
  const start = headings[0].index + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index].trim())) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end);
}

/**
 * Structured per-Slice Task Evidence check (S10-SR-001-GIT-FACTS-FAIL-OPEN-001):
 * within the single `## Task Evidence` section, EVERY Manifest-declared task
 * must have EXACTLY one `### <task-id>` subsection and that subsection must
 * carry a canonical `- Status: COMPLETE` line.  Full-text `includes` is never
 * used — forged `- Status: COMPLETE` text outside the Slice's Task Evidence
 * subsections cannot satisfy the check.
 */
function assertCompleteSliceTaskEvidence(
  content: string,
  tasks: readonly TaskBinding[],
  label: string,
): void {
  const section = taskEvidenceSectionLines(content, label);
  for (const task of tasks) {
    const heading = `### ${task.taskId}`;
    const headingIndexes: number[] = [];
    for (let index = 0; index < section.length; index += 1) {
      if (section[index].trim() === heading) headingIndexes.push(index);
    }
    if (headingIndexes.length !== 1) {
      fail(
        'DOMAIN.INVALID_TRANSITION',
        `${label} Task Evidence subsection for "${task.taskId}" is not complete (expected exactly one "### ${task.taskId}" heading)`,
      );
    }
    let taskEnd = section.length;
    for (let index = headingIndexes[0] + 1; index < section.length; index += 1) {
      if (/^###\s+/.test(section[index].trim())) {
        taskEnd = index;
        break;
      }
    }
    const body = section.slice(headingIndexes[0] + 1, taskEnd);
    const complete = body.some((line) => /^\s*-\s*Status:\s*COMPLETE\s*$/.test(line));
    if (!complete) {
      fail(
        'DOMAIN.INVALID_TRANSITION',
        `${label} Task Evidence subsection for "${task.taskId}" is not complete (expected "- Status: COMPLETE")`,
      );
    }
  }
}

/** Line-based checkbox match: the task-id is a word boundary (end or whitespace). */
function isTaskCheckboxLine(line: string, taskId: string, checked: boolean): boolean {
  const trimmed = line.trim();
  const prefix = checked ? `- [x] ${taskId}` : `- [ ] ${taskId}`;
  if (trimmed === prefix) return true;
  return trimmed.startsWith(prefix) && /^\s/.test(trimmed.slice(prefix.length));
}

/**
 * Structured tasks.md checkbox check for ONE Slice (S10-SR-001-GIT-FACTS-FAIL-OPEN-001):
 * locate the `<!-- SLICE:<slice>:BEGIN -->` … `<!-- SLICE:<slice>:END -->`
 * region and assert — INSIDE that region only — that every Manifest-declared
 * task has exactly one `- [x] <task-id>` line and no `- [ ] <task-id>` line.
 * Full-text `includes` is never used: another Slice's checkboxes neither
 * satisfy nor break this Slice's check, and missing region markers fail
 * closed.
 */
function assertSliceTasksChecked(
  content: string,
  sliceId: string,
  tasks: readonly TaskBinding[],
  label: string,
): void {
  const lines = content.split(/\r?\n/);
  const beginMarker = `<!-- SLICE:${sliceId}:BEGIN -->`;
  const endMarker = `<!-- SLICE:${sliceId}:END -->`;
  let begin = -1;
  let end = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (begin === -1 && trimmed === beginMarker) begin = index;
    if (trimmed === endMarker) end = index;
  }
  if (begin === -1 || end === -1 || end <= begin) {
    fail(
      'DOMAIN.INVALID_TRANSITION',
      `${label} is missing the "<!-- SLICE:${sliceId}:BEGIN/END -->" task region markers`,
    );
  }
  const region = lines.slice(begin + 1, end);
  for (const task of tasks) {
    let checked = 0;
    let unchecked = 0;
    for (const line of region) {
      if (isTaskCheckboxLine(line, task.taskId, true)) checked += 1;
      else if (isTaskCheckboxLine(line, task.taskId, false)) unchecked += 1;
    }
    if (checked !== 1 || unchecked !== 0) {
      fail(
        'DOMAIN.INVALID_TRANSITION',
        `${label} task "${task.taskId}" checkbox is not fully checked in the Slice region (expected exactly one "- [x] ${task.taskId}" and no "- [ ] ${task.taskId}")`,
      );
    }
  }
}

/**
 * Find the Slice's integration commit: the first commit in the HEAD ancestor
 * chain whose subject EXACTLY starts with the `slice-output: <stage>-<slice>`
 * marker (word-boundary exact-prefix — see `isSliceOutputSubject`; a subject
 * that merely contains the marker as a substring is never accepted).
 * Absent → the Slice has no committed integration proof on the current
 * boundary — fail closed.
 */
function findSliceIntegrationCommit(root: string, stageId: string, sliceId: string): string {
  let log: string;
  try {
    log = execFileSync('git', ['-C', root, 'log', '--format=%H%x00%s', 'HEAD'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    fail('DOMAIN.INVALID_TRANSITION', `vNext Gate refused: cannot read the Git history: ${error instanceof Error ? error.message : String(error)}`);
  }
  const marker = sliceOutputMarker(stageId, sliceId);
  for (const line of log.split('\n')) {
    const separator = line.indexOf('\u0000');
    if (separator === -1) continue;
    const commitSha = line.slice(0, separator);
    const subject = line.slice(separator + 1);
    if (isSliceOutputSubject(subject, marker)) return commitSha;
  }
  fail(
    'DOMAIN.INVALID_TRANSITION',
    `Slice "${sliceId}" has no integration commit ("${marker}") in the HEAD ancestor chain`,
  );
}

/**
 * Verify the Git facts of ONE Slice (explicit `verification_source:
 * "git_facts"` fallback): the integration commit is in the HEAD ancestor
 * chain, its Task Evidence is complete (`Status: COMPLETE`) and its tasks.md
 * checkboxes are all checked — verified BOTH at the integration commit AND
 * at the current HEAD (S10-SR-001: the fallback must not PASS when the
 * working tree content was rolled back after integration; the HEAD read uses
 * the Git object database, never the working tree).  All content checks are
 * STRUCTURED and Slice-scoped (S10-SR-001-GIT-FACTS-FAIL-OPEN-001): the
 * integration-commit subject must exactly start with the slice-output marker,
 * Task Evidence is validated per `### <task-id>` subsection inside the single
 * `## Task Evidence` section, and tasks.md checkboxes are validated inside
 * the `<!-- SLICE:<slice>:BEGIN/END -->` region — full-text `includes` is
 * never used.  Any missing fact fails closed.  The binding's
 * `integration_receipt_digest` is the deterministic digest of the verified
 * Git facts (there is no Receipt chain on this path) — the Receipt's
 * `verification_source: "git_facts"` marker disambiguates it from a Receipt
 * digest for every downstream auditor.
 */
function verifySliceGitFacts(
  root: string,
  stageId: string,
  manifest: VNextManifest,
  slice: VNextManifestSlice,
  snapshotDigest: string,
): VNextGateSliceIntegration {
  const binding = guardedShared(`slice binding for ${slice.slice_id}`, () =>
    sliceBinding(root, manifest, slice.slice_id),
  );
  const commitSha = findSliceIntegrationCommit(root, stageId, slice.slice_id);
  // The marker commit must lie on the integrated boundary (defence in depth:
  // the rev-list scan above is ancestor-only, this re-asserts it explicitly).
  assertAncestor(root, commitSha, snapshotDigest, `Slice "${slice.slice_id}" integration commit`);

  verifySliceFactsAtCommit(
    root,
    commitSha,
    binding,
    slice.slice_id,
    `the integration commit ${commitSha}`,
  );

  // S10-SR-001 repair: the fallback must ALSO bind the CURRENT HEAD content,
  // not only the integration commit.  A rollback that reverts the Evidence to
  // pristine (no `Status: COMPLETE`) or unchecks a tasks.md checkbox after
  // the integration commit must fail the Gate even though the marker commit
  // itself still carries the complete facts.  The HEAD content is read from
  // the Git object database (`git show <snapshot>:<path>`), never from the
  // working tree — the clean-worktree precondition and the stable-boundary
  // assertion above guarantee snapshotDigest is the current HEAD, so the
  // HEAD read is deterministic and root-bound.
  verifySliceFactsAtCommit(
    root,
    snapshotDigest,
    binding,
    slice.slice_id,
    `the current HEAD ${snapshotDigest}`,
  );

  return {
    slice_id: slice.slice_id,
    integration_receipt_digest: computeDigest({
      verification: 'git_facts',
      slice_id: slice.slice_id,
      commit_sha: commitSha,
      evidence: 'complete',
      checkboxes: 'checked',
    }),
    commit_sha: commitSha,
  };
}

/**
 * Verify ONE Slice's Git facts at ONE commit: the Evidence file must carry a
 * single structured `## Task Evidence` section with exactly one complete
 * `### <task-id>` subsection per Manifest-declared task, and the tasks.md
 * Slice region (`<!-- SLICE:<slice>:BEGIN/END -->`) must have every task
 * checkbox checked exactly once with no unchecked checkbox.  Every check is
 * line/region-scoped — full-text `includes` matching is never used.
 */
function verifySliceFactsAtCommit(
  root: string,
  commitSha: string,
  binding: SliceBinding,
  sliceId: string,
  where: string,
): void {
  const prefix = `Slice "${sliceId}" at ${where}`;
  const evidence = readFileAtCommit(
    root,
    commitSha,
    binding.evidencePath,
    `Evidence file ${binding.evidencePath} at ${where}`,
  );
  assertCompleteSliceTaskEvidence(evidence, binding.tasks, `${prefix} Evidence file ${binding.evidencePath}`);
  const tasksMd = readFileAtCommit(
    root,
    commitSha,
    binding.planPath,
    `Plan projection ${binding.planPath} at ${where}`,
  );
  assertSliceTasksChecked(tasksMd, sliceId, binding.tasks, `${prefix} Plan projection ${binding.planPath}`);
}

/**
 * Revalidate the complete Gate context.  Every reader here is root-bound
 * (canonical path + no-follow) and never enters the legacy reconcile/reader.
 */
function validateFacts(
  request: VNextGateResultAdmissionRequest,
  dependencies: VNextGateAdmissionDependencies,
  options: VNextGateValidationOptions = {},
): ValidatedGateFacts {
  const root = canonicalProjectRoot(dependencies.projectRoot);
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${request.stageId}.json`);

  const route = detectPlanManifestRoute(root, manifestPath);
  if (route !== 'vnext') {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Gate requires a vNext Manifest route, got "${route}"`);
  }

  let manifest: VNextManifest;
  try {
    manifest = readVNextManifest(root, manifestPath);
  } catch (error) {
    if (!(error instanceof VNextHandoffError)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `vNext Gate could not read the Manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Gate could not read the Manifest: ${error.message}`);
  }
  if (manifest.stage_id !== request.stageId) {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Gate Manifest stage_id "${manifest.stage_id}" does not match request "${request.stageId}"`);
  }
  const manifestDigest = computeDigest(manifest);
  if (manifestDigest !== request.manifestDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Gate request manifestDigest does not match the persisted Manifest');
  }
  const planDigest = manifest.plan.plan_digest;
  if (typeof planDigest !== 'string' || !SHA256_RE.test(planDigest)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Gate Manifest plan_digest is not a lowercase SHA-256 digest');
  }
  try {
    assertVNextManifestReferenceBindings(root, manifest);
  } catch (error) {
    if (error instanceof VNextHandoffError) {
      fail('RUNTIME.SCHEMA_MISMATCH', `vNext Gate Manifest reference bindings are broken: ${error.message}`);
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
      `vNext Gate admission authority is unavailable: ${error.message}`,
    );
  }
  authorityBindingsAreValid(root, authority, request.stageId, manifestDigest, planDigest, request.snapshotDigest);

  if (options.skipCleanWorkingTree !== true) {
    assertCleanWorkingTree(root);
  }
  assertStableGitBoundary(root, request.snapshotDigest);
  const snapshotDigest = request.snapshotDigest;

  const integratedSlices: VNextGateSliceIntegration[] = [];
  if (request.verification_source === 'git_facts') {
    // S10-SR-001-GIT-FACTS-FAIL-OPEN-001 (defect 1): the fallback is
    // ABSENCE-GATED.  An explicit git_facts declaration is legal ONLY when
    // every Slice's INTEGRATION_PASS Receipt chain is missing — if ANY Slice
    // still carries a valid Integration Receipt chain, git_facts is refused
    // (fail-closed) and the normal receipts path is required: a complete
    // authority receipts chain can never be bypassed by merely declaring
    // `git_facts`.
    assertGitFactsFallbackAbsent(root, request.stageId, manifest);
    // Explicit fallback (dual-path SG): Git facts replace the Receipt chains
    // entirely — no INTEGRATION_PASS chain is read.  Every Git fact must hold
    // per Slice (integration commit in the HEAD ancestor chain, complete Task
    // Evidence, fully checked checkboxes); any missing fact fails closed.
    for (const slice of manifest.slices) {
      integratedSlices.push(verifySliceGitFacts(root, request.stageId, manifest, slice, snapshotDigest));
    }
  } else {
    for (const slice of manifest.slices) {
      const binding = readSliceIntegrationBinding(
        root,
        request.stageId,
        manifest,
        slice,
        manifestDigest,
        planDigest,
        authority.spv.snapshot_digest,
        snapshotDigest,
      );
      integratedSlices.push({
        slice_id: binding.sliceId,
        integration_receipt_digest: binding.integrationReceiptDigest,
        commit_sha: binding.commitSha,
      });
    }
  }

  const gateDirectory = stageGateReceiptDir(root, request.stageId);
  const gateChain = readReceiptChain(root, gateDirectory, 'stage-gate chain');
  const gateTip = gateChain.receipts.length > 0
    ? gateChain.receipts[gateChain.receipts.length - 1].digest
    : null;
  for (const receipt of gateChain.receipts) {
    if (receipt.type !== 'GATE_PASS' && receipt.type !== 'GATE_FAIL') {
      fail('RUNTIME.SCHEMA_MISMATCH', `stage-gate chain contains ${receipt.type}; expected only GATE_PASS/GATE_FAIL vNext facts`);
    }
    const payload = receipt.payload;
    if (!isRecord(payload) || payload.schema_version !== 2 || payload.type !== 'GATE_RESULT' || payload.action !== 'GATE') {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage-gate chain contains a legacy v1 Gate fact or a vNext Gate fact without the GATE_RESULT/GATE discriminator');
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
    if (payload.verdict !== 'PASS' && payload.verdict !== 'FAIL') {
      fail('RUNTIME.SCHEMA_MISMATCH', 'stage-gate chain contains a Gate Receipt with an invalid verdict');
    }
  }

  if (options.allowInstalledGateTip === undefined) {
    if (gateTip !== null) {
      const tip = gateChain.receipts[gateChain.receipts.length - 1];
      if ((tip.payload as Record<string, unknown>).verdict === 'PASS' && request.re_gate !== true) {
        fail(
          'DOMAIN.INVALID_TRANSITION',
          `stage "${request.stageId}" already has a Gate PASS tip; re-gate refused (pass re_gate: true after a REPAIR review to re-gate)`,
        );
      }
    }
  } else if (gateTip !== options.allowInstalledGateTip) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'stage-gate chain tip is not the just-installed Gate receipt');
  }

  // P-09: an explicit re-gate is the REPAIR-driven re-run path — legal ONLY
  // when the stage review chain tip is a REPAIR verdict.  The review chain
  // read is root-bound and fail-closed (readReceiptChain); an empty chain or
  // a tip that is not a closed v2 REPAIR fact refuses the re-gate so the
  // PASS-tip relaxation can never be abused to re-run a Gate without a
  // review-requested repair.
  if (request.re_gate === true) {
    const reviewChain = readReceiptChain(
      root,
      reviewReceiptDir(root, request.stageId),
      'stage review chain',
    );
    if (reviewChain.receipts.length === 0) {
      fail(
        'DOMAIN.INVALID_TRANSITION',
        `re-gate refused: stage "${request.stageId}" has no Stage Review REPAIR tip (re-gate requires a REPAIR-driven re-run)`,
      );
    }
    const reviewTip = reviewChain.receipts[reviewChain.receipts.length - 1];
    const reviewPayload = reviewTip.payload;
    if (
      reviewTip.type !== 'STAGE_REVIEW_PASS' ||
      !isRecord(reviewPayload) ||
      reviewPayload.schema_version !== 2 ||
      reviewPayload.type !== 'STAGE_REVIEW_RESULT' ||
      reviewPayload.action !== 'STAGE_REVIEW' ||
      reviewPayload.verdict !== 'REPAIR'
    ) {
      fail(
        'DOMAIN.INVALID_TRANSITION',
        `re-gate refused: stage "${request.stageId}" review chain tip is not a valid v2 REPAIR verdict (re-gate requires a REPAIR-driven re-run)`,
      );
    }
  }

  return {
    root,
    manifest,
    manifestDigest,
    planDigest,
    authority,
    snapshotDigest,
    integratedSlices,
    gateTip,
  };
}

function assertGateFactsUnchanged(
  before: ValidatedGateFacts,
  after: ValidatedGateFacts,
): void {
  if (after.manifestDigest !== before.manifestDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Manifest digest changed during the Gate write');
  }
  if (after.planDigest !== before.planDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Plan digest changed during the Gate write');
  }
  if (
    after.snapshotDigest !== before.snapshotDigest ||
    after.authority.stagePlan.digest !== before.authority.stagePlan.digest ||
    after.authority.spv.digest !== before.authority.spv.digest
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'snapshot or admission authority changed during the Gate write');
  }
  if (!sameJsonValue(after.integratedSlices, before.integratedSlices)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'integrated Slice bindings changed during the Gate write');
  }
}

function assertInstalledGateReceipt(
  facts: ValidatedGateFacts,
  writeResult: { readonly path: string; readonly digest: string },
): void {
  const gateChain = readReceiptChain(facts.root, stageGateReceiptDir(facts.root, writeResultChainStage(facts)), 'stage-gate chain after write');
  const tip = gateChain.receipts[gateChain.receipts.length - 1];
  if (gateChain.tipDigest !== writeResult.digest || tip === undefined) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'the freshly written Gate receipt is not the stage-gate chain tip');
  }
}

function writeResultChainStage(facts: ValidatedGateFacts): string {
  return (facts.manifest as VNextManifest).stage_id;
}

// ============================================================
// State / build / persistence
// ============================================================

export interface VNextGateAdmissionDependencies {
  readonly projectRoot: string;
  readonly writer?: ReceiptWriterPort;
}

function gateState(facts: ValidatedGateFacts, request: VNextGateResultAdmissionRequest): VNextGateAdmissionState {
  return {
    schema_version: VNEXT_GATE_SCHEMA_VERSION,
    type: VNEXT_GATE_RESULT_TYPE,
    action: VNEXT_GATE_ACTION,
    stage_id: request.stageId,
    manifest_digest: facts.manifestDigest,
    plan_digest: facts.planDigest,
    stage_plan_receipt_digest: facts.authority.stagePlan.digest,
    spv_receipt_digest: facts.authority.spv.digest,
    snapshot_digest: facts.snapshotDigest,
    verdict: request.verdict,
    integrated_slices: facts.integratedSlices,
    summary: request.summary,
    // Dual-path SG: the Receipt records which verification path produced it
    // — `receipts` (default) or the explicit `git_facts` fallback — so SR /
    // project acceptance can audit it and no fallback can be silently used.
    verification_source: request.verification_source ?? 'receipts',
    receipt_chain_valid: true,
  };
}

function gateReceiptBuild(facts: ValidatedGateFacts, request: VNextGateResultAdmissionRequest): ReceiptBuild {
  return {
    type: request.verdict === 'PASS' ? 'GATE_PASS' : 'GATE_FAIL',
    stage_id: request.stageId,
    timestamp: new Date().toISOString(),
    payload: { ...gateState(facts, request) },
  };
}

function rejectedGate(
  message: string,
  code: GateAdmissionCode = 'RUNTIME.SCHEMA_MISMATCH',
): AdmitResult<VNextGateAdmissionState> {
  return {
    accepted: false,
    receipt_ref: null,
    new_state: null,
    findings: [{ code, severity: 'error', message }],
  };
}

/**
 * Admit one vNext Stage Gate fact without entering legacy reconcile/reducer
 * code.  The only persistence operation is the shared bounded Receipt seam.
 */
export function admitVNextGateResult(
  value: unknown,
  dependencies: VNextGateAdmissionDependencies,
): AdmitResult<VNextGateAdmissionState> {
  let request: VNextGateResultAdmissionRequest;
  try {
    request = validateVNextGateResultRequest(value);
  } catch (error) {
    const code = error instanceof VNextGateAdmissionError ? error.code : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedGate(
      `vNext Gate request rejected by closed schema: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  let facts: ValidatedGateFacts;
  try {
    facts = validateFacts(request, dependencies);
  } catch (error) {
    const code = error instanceof VNextGateAdmissionError ? error.code : error instanceof VNextHandoffError ? 'RUNTIME.SCHEMA_MISMATCH' : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedGate(
      `vNext Gate admission blocked: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  const state = gateState(facts, request);
  const root = facts.root;
  return runReceiptAdmission<VNextGateAdmissionState>({
    build: gateReceiptBuild(facts, request),
    targetDir: stageGateReceiptDir(root, request.stageId),
    nextState: state,
    writer: dependencies.writer,
    projectRoot: root,
    admissionKey: `vnext-gate:${request.stageId}:${request.snapshotDigest}`,
    beforeWrite: () => {
      assertVNextGateRoute(root, request.stageId);
      const current = validateFacts(request, dependencies, {});
      assertGateFactsUnchanged(facts, current);
    },
    afterWrite: (writeResult) => {
      assertVNextGateRoute(root, request.stageId);
      const current = validateFacts(request, dependencies, {
        allowInstalledGateTip: writeResult.digest,
        skipCleanWorkingTree: true,
      });
      assertGateFactsUnchanged(facts, current);
      assertInstalledGateReceipt(facts, writeResult);
    },
  });
}

/** A direct alias for callers that name the result as a Gate verdict. */
export const admitVNextGate = admitVNextGateResult;

function assertVNextGateRoute(root: string, stageId: string): void {
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${stageId}.json`);
  const route = detectPlanManifestRoute(root, manifestPath);
  if (route !== 'vnext') {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Gate route changed during admission (got "${route}")`);
  }
}