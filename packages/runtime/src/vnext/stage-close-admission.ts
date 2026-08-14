/**
 * vNext Stage Close admission (P-11).
 *
 * The Stage Close is the machine-authoritative "Stage is closed" fact that
 * the legacy review-only derivation cannot produce: a restricted close (e.g.
 * S10 — user-adjudicated, no STAGE_REVIEW_PASS, possibly unintegrated
 * Slices) would otherwise stay an active Stage forever (`review status`
 * still reports `ready_for_review` and every CLI tool keeps binding-validating
 * an archived Manifest).
 *
 * `admitVNextStageClose` mirrors the gate-admission structure: closed request
 * schema → root-bound Manifest read (NO reference-binding revalidation →
 * archived Manifests are historical snapshots whose digests legitimately
 * drift from the evolved Authority files) → Stage Plan/SPV authority
 * revalidation → clean worktree + stable Git boundary → write-once
 * persistence of the v2 STAGE_CLOSE receipt into
 * `stage-close/<stage>/<digest>.json`. The Close is deliberately LIGHTER
 * than the Gate/Review consumers: it revalidates the Stage Plan/SPV
 * authority tuple and the current snapshot only — no Manifest reference
 * bindings, no Runtime Proof digest, no per-Slice Integration chains (a
 * restricted close may have none). It never enters the legacy
 * reconcile/reducer path.
 *
 * The persisted receipt is a vNext-owned envelope — `type: STAGE_CLOSE_PASS`
 * with a `schema_version: 2` payload (`type: STAGE_CLOSE_RESULT`, `action:
 * STAGE_CLOSE`). The envelope type is deliberately NOT a kernel `ReceiptType`:
 * the kernel 16-type legacy union stays closed (P-11 keeps STAGE_CLOSE out of
 * legacy), so persistence goes through this module's own bounded atomic write
 * (tmp + fsync + rename, digest-addressed, write-once) instead of the kernel
 * ReceiptWriter. The stage-close chain reader validates this closed envelope
 * shape itself.
 *
 * Write-once contract: a Stage can be closed exactly once. Any existing
 * stage-close receipt (valid chain) refuses a new close fail-closed
 * (DOMAIN.INVALID_TRANSITION). The digest-addressed file is the write-once
 * guard at the file level (a concurrent same-digest write lands on the same
 * content; a concurrent different-digest write breaks the single-root chain
 * and is detected by the post-write chain verification).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeDigest, computeReceiptDigest } from '@proofloop/kernel';
import type { VNextManifest } from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
// S09-C-T03: the shared canonical Stage ID guard (`^S\d+$`). Legacy parked
// labels such as S08B0/S08B fail closed before any Runtime read/write.
import { CANONICAL_STAGE_ID_RE } from './stage-id';
import { readGitHead, resolveGitRoot } from '../git-source';
import { detectPlanManifestRoute } from '../plan-services';
import { stageCloseReceiptDir } from '../receipt-layout';
import type { AdmitResult } from '../admit-pipeline';
import {
  readVNextManifest,
  VNextHandoffError,
} from './dispatch';
import { readVNextAdmissionAuthority } from './next';
import {
  VNEXT_STAGE_CLOSE_ACTION,
  VNEXT_STAGE_CLOSE_RESULT_TYPE,
  VNEXT_STAGE_CLOSE_SCHEMA_VERSION,
  VNEXT_STAGE_CLOSE_TYPES,
} from './types';
import type {
  VNextAdmissionAuthority,
  VNextStageCloseAdmissionState,
  VNextStageCloseType,
} from './types';

const CANONICAL_STAGE_ID = CANONICAL_STAGE_ID_RE;
const SHA256_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/**
 * The vNext-owned envelope type of the persisted Stage Close receipt. This is
 * NOT a kernel `ReceiptType` (the legacy 16-type union stays closed); the
 * stage-close chain reader is the only schema authority for this envelope.
 */
export const VNEXT_STAGE_CLOSE_PASS_TYPE = 'STAGE_CLOSE_PASS' as const;
export type VNextStageClosePassType = typeof VNEXT_STAGE_CLOSE_PASS_TYPE;

const REQUEST_FIELDS = new Set([
  'type',
  'stageId',
  'closeType',
  'reason',
  'manifestDigest',
  'snapshotDigest',
]);

// ============================================================
// Error surface
// ============================================================

type StageCloseAdmissionCode =
  | 'RUNTIME.SCHEMA_MISMATCH'
  | 'RUNTIME.RECEIPT_CHAIN_BROKEN'
  | 'DOMAIN.INVALID_TRANSITION';

class VNextStageCloseAdmissionError extends Error {
  constructor(
    readonly code: StageCloseAdmissionCode,
    message: string,
  ) {
    super(message);
    this.name = 'VNextStageCloseAdmissionError';
  }
}

function fail(code: StageCloseAdmissionCode, message: string): never {
  throw new VNextStageCloseAdmissionError(code, message);
}

// ============================================================
// Request shape
// ============================================================

/**
 * Closed request shape used by the Runtime/Host Stage Close seam. The Close
 * is stage-level: no slice is bound by the request; slices are bound by the
 * Manifest. The Stage Plan/SPV authority and the Plan digest are never taken
 * from the request — they are re-read root-bound and must bind the tuple.
 */
export interface VNextStageCloseAdmissionRequest {
  readonly type: 'stage_close';
  readonly stageId: string;
  readonly closeType: VNextStageCloseType;
  /** Non-empty close reason (fail-closed; a close without a reason is not a closed fact). */
  readonly reason: string;
  readonly manifestDigest: string;
  readonly snapshotDigest: string;
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
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Close admission requires an existing projectRoot directory');
  }
  return absolute;
}

export function validateVNextStageCloseRequest(value: unknown): VNextStageCloseAdmissionRequest {
  if (!isRecord(value)) fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Close request must be an object');
  const unknown = Reflect.ownKeys(value).filter(
    (key) => typeof key !== 'string' || !REQUEST_FIELDS.has(key),
  );
  if (unknown.length > 0) {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Close request contains unknown field(s): ${unknown.map(String).join(', ')}`);
  }
  if (value.type !== 'stage_close') {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Close request type must be stage_close');
  }
  const stageId = requireString(value.stageId, 'stageId');
  if (!CANONICAL_STAGE_ID.test(stageId)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'stageId must be a canonical Stage ID (expected /^S\\d+$/, e.g. S10); legacy labels such as S08B0/S08B are rejected');
  }
  if (!VNEXT_STAGE_CLOSE_TYPES.includes(value.closeType as VNextStageCloseType)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Close request closeType must be "full" or "restricted"');
  }
  const reason = requireString(value.reason, 'reason');
  const manifestDigest = requireSha256(value.manifestDigest, 'manifestDigest');
  const snapshotDigest = requireSnapshot(value.snapshotDigest, 'snapshotDigest');
  return {
    type: 'stage_close',
    stageId,
    closeType: value.closeType as VNextStageCloseType,
    reason,
    manifestDigest,
    snapshotDigest,
  };
}

// ============================================================
// Stage-close chain reads (vNext-owned envelope)
// ============================================================

/** The closed payload shape of an admissible v2 Stage Close Receipt. */
function validateStageClosePayload(payload: unknown, label: string): void {
  if (!isRecord(payload)) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} payload must be an object`);
  }
  if (payload.schema_version !== VNEXT_STAGE_CLOSE_SCHEMA_VERSION) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} payload schema_version must be 2`);
  }
  if (payload.type !== VNEXT_STAGE_CLOSE_RESULT_TYPE) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} payload type must be STAGE_CLOSE_RESULT`);
  }
  if (payload.action !== VNEXT_STAGE_CLOSE_ACTION) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} payload action must be STAGE_CLOSE`);
  }
  if (typeof payload.stage_id !== 'string' || payload.stage_id.length === 0) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} payload stage_id must be a non-empty string`);
  }
  if (!VNEXT_STAGE_CLOSE_TYPES.includes(payload.close_type as VNextStageCloseType)) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} payload close_type must be "full" or "restricted"`);
  }
  if (typeof payload.reason !== 'string' || payload.reason.length === 0) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} payload reason must be a non-empty string`);
  }
  for (const field of ['manifest_digest', 'plan_digest', 'stage_plan_receipt_digest', 'spv_receipt_digest']) {
    if (typeof payload[field] !== 'string' || !SHA256_RE.test(payload[field])) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} payload ${field} must be a lowercase SHA-256 digest`);
    }
  }
  if (typeof payload.snapshot_digest !== 'string' || !SNAPSHOT_RE.test(payload.snapshot_digest)) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} payload snapshot_digest must be a Git snapshot digest`);
  }
  if (payload.receipt_chain_valid !== true) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `${label} payload receipt_chain_valid must be true`);
  }
}

/** One validated stage-close receipt (envelope + typed payload binding). */
interface StageCloseChainReceipt {
  readonly digest: string;
  readonly previousDigest: string | undefined;
  readonly timestamp: string;
  readonly stageId: string;
  readonly payload: VNextStageCloseAdmissionState;
}

interface StageCloseChain {
  readonly receipts: readonly StageCloseChainReceipt[];
  readonly tipDigest: string | null;
}

/**
 * Read and validate the complete stage-close chain of one Stage.
 *
 * Root-bound (canonical path + no-follow per file) and fail-closed: every
 * `.json` entry must be a digest-addressed STAGE_CLOSE_PASS envelope with a
 * self-consistent digest and a closed v2 payload; the chain must have exactly
 * one root, no cycles, no forks and be timestamp-ordered. Any violation fails
 * closed — a tampered/foreign entry never becomes a fact.
 */
function readStageCloseChain(root: string, stageId: string): StageCloseChain {
  const directory = stageCloseReceiptDir(root, stageId);
  const lexical = path.resolve(directory);
  const canonical = canonicalPathWithinRoot(root, lexical);
  if (canonical === null || canonical !== lexical) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', 'stage-close chain is not a canonical directory under the project root');
  }

  let names: string[];
  try {
    const stat = fs.statSync(lexical);
    if (!stat.isDirectory()) fail('RUNTIME.RECEIPT_CHAIN_BROKEN', 'stage-close chain path is not a directory');
    names = fs.readdirSync(lexical).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { receipts: [], tipDigest: null };
    if (error instanceof VNextStageCloseAdmissionError) throw error;
    fail(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      `stage-close chain could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const byDigest = new Map<string, StageCloseChainReceipt>();
  for (const name of names) {
    const file = path.join(lexical, name);
    const opened = openNoFollowRead(root, file);
    if (!opened.ok || opened.filePath !== file) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close chain contains an unreadable or redirected Receipt: ${name}`);
    }
    let receipt: StageCloseChainReceipt;
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
      } catch (error) {
        fail(
          'RUNTIME.RECEIPT_CHAIN_BROKEN',
          `stage-close Receipt ${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!isRecord(parsed)) {
        fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close Receipt ${name} must be an object`);
      }
      if (parsed.version !== 1) {
        fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close Receipt ${name} version must be 1`);
      }
      if (parsed.type !== VNEXT_STAGE_CLOSE_PASS_TYPE) {
        fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close Receipt ${name} type must be STAGE_CLOSE_PASS`);
      }
      if (typeof parsed.stage_id !== 'string' || parsed.stage_id.length === 0) {
        fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close Receipt ${name} stage_id must be a non-empty string`);
      }
      const stageIdValue = parsed.stage_id;
      if (stageIdValue !== stageId) {
        fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close Receipt ${name} stage_id does not match the chain directory`);
      }
      if (typeof parsed.timestamp !== 'string' || parsed.timestamp.length === 0) {
        fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close Receipt ${name} timestamp must be a non-empty string`);
      }
      const timestamp = parsed.timestamp;
      if (typeof parsed.digest !== 'string' || !SHA256_RE.test(parsed.digest)) {
        fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close Receipt ${name} digest must be a lowercase SHA-256 digest`);
      }
      const digest = parsed.digest;
      if (name !== `${digest}.json`) {
        fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close Receipt ${name} is not digest-addressed`);
      }
      const { digest: ignoredDigest, ...content } = parsed;
      void ignoredDigest;
      if (computeReceiptDigest(content) !== digest) {
        fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close Receipt ${name} has an invalid self-digest`);
      }
      const previousDigest = parsed.previous_digest;
      if (
        previousDigest !== undefined &&
        previousDigest !== null &&
        (typeof previousDigest !== 'string' || !SHA256_RE.test(previousDigest))
      ) {
        fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close Receipt ${name} has an invalid previous_digest`);
      }
      validateStageClosePayload(parsed.payload, `stage-close Receipt ${name}`);
      receipt = {
        digest,
        previousDigest: typeof previousDigest === 'string' && previousDigest.length > 0 ? previousDigest : undefined,
        timestamp,
        stageId: stageIdValue,
        payload: parsed.payload as VNextStageCloseAdmissionState,
      };
    } finally {
      fs.closeSync(opened.fd);
    }
    byDigest.set(receipt.digest, receipt);
  }

  if (byDigest.size === 0) {
    return { receipts: [], tipDigest: null };
  }
  const roots = [...byDigest.values()].filter((receipt) => receipt.previousDigest === undefined);
  if (roots.length !== 1) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close chain must have exactly one root Receipt (found ${roots.length})`);
  }
  const ordered: StageCloseChainReceipt[] = [];
  const visited = new Set<string>();
  let current: StageCloseChainReceipt | undefined = roots[0];
  let previousTimestamp = '';
  while (current !== undefined) {
    if (visited.has(current.digest)) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close chain contains a cycle at ${current.digest}`);
    }
    if (current.timestamp < previousTimestamp) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close Receipt ${current.digest} is not timestamp-ordered`);
    }
    visited.add(current.digest);
    ordered.push(current);
    const successor = [...byDigest.values()].filter(
      (receipt) => receipt.previousDigest === current?.digest,
    );
    if (successor.length > 1) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close Receipt ${current.digest} has more than one successor`);
    }
    previousTimestamp = current.timestamp;
    current = successor[0];
  }
  if (visited.size !== byDigest.size) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', 'stage-close chain contains dangling or forked Receipts');
  }
  return { receipts: ordered, tipDigest: ordered[ordered.length - 1].digest };
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
      `vNext Stage Close refused: request snapshotDigest "${expectedSnapshot}" does not match the current Git HEAD "${head ?? 'unresolvable'}"`,
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
    fail('DOMAIN.INVALID_TRANSITION', `vNext Stage Close refused: cannot read git status: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (porcelain.trim().length > 0) {
    fail('DOMAIN.INVALID_TRANSITION', 'vNext Stage Close refused: working tree is not clean (git status --porcelain non-empty)');
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
      `vNext Stage Close refused: ${label} (${ancestor}) is not an ancestor of the current snapshot ${descendant}`,
    );
  }
}

// ============================================================
// Validation facts
// ============================================================

interface ValidatedStageCloseFacts {
  readonly root: string;
  readonly manifest: VNextManifest;
  readonly manifestDigest: string;
  readonly planDigest: string;
  readonly authority: VNextAdmissionAuthority;
  readonly snapshotDigest: string;
}

interface VNextStageCloseValidationOptions {
  /**
   * After-write hop: the stage-close chain tip is expected to be the just-
   * installed digest (the write itself dirties the worktree, so the clean
   * check is skipped on this hop).
   */
  readonly allowInstalledCloseTip?: string;
  /** Skip the git-clean check (an installed Receipt may dirty a tracked root). */
  readonly skipCleanWorkingTree?: boolean;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return computeDigest(left) === computeDigest(right);
}

/**
 * Stage Plan/SPV authority binding revalidation — the same closed pattern the
 * Gate consumer applies (P-11 reuses the pattern by value): both authority
 * facts must bind the Stage/Manifest/Plan tuple, the Stage Plan must embed
 * the exact SPV receipt digest, the two authorities must agree on the
 * certified snapshot, and the SPV snapshot must precede (or equal) the
 * current boundary.
 */
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
      fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Close admission authority (${label}) does not bind the Manifest/Plan tuple`);
    }
  }
  if (stagePlan.spv_receipt_digest !== spv.digest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Close stagePlan does not bind its SPV receipt digest');
  }
  if (stagePlan.snapshot_digest !== spv.snapshot_digest) {
    fail(
      'RUNTIME.SCHEMA_MISMATCH',
      'vNext Stage Close stagePlan snapshot_digest does not match the SPV snapshot_digest',
    );
  }
  assertAncestor(root, spv.snapshot_digest, snapshotDigest, 'SPV snapshot');
}

/**
 * Revalidate the complete Stage Close context. Every reader here is
 * root-bound (canonical path + no-follow) and never enters the legacy
 * reconcile/reader path.
 *
 * The Manifest reference bindings (`assertVNextManifestReferenceBindings`)
 * are intentionally NOT revalidated here. A Stage Close is the machine
 * marker for a closed/archived Stage: its Manifest is a historical snapshot
 * bound to the replan-time worktree digests, and the Authority files evolve
 * afterwards (transition removals, …), so re-binding the recorded digests to
 * the current root files would fail for every legitimately archived Stage
 * (`REF-AWI-023 file_digest does not match the root bound source`). The
 * Close still requires the Manifest itself to be readable and stage-bound —
 * a missing Manifest means the Stage never existed and cannot be archived.
 */
function validateFacts(
  request: VNextStageCloseAdmissionRequest,
  dependencies: VNextStageCloseAdmissionDependencies,
  options: VNextStageCloseValidationOptions = {},
): ValidatedStageCloseFacts {
  const root = canonicalProjectRoot(dependencies.projectRoot);
  const manifestPath = path.join(root, '.proofloop', 'manifests', `${request.stageId}.json`);

  const route = detectPlanManifestRoute(root, manifestPath);
  if (route !== 'vnext') {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Close requires a vNext Manifest route, got "${route}"`);
  }

  let manifest: VNextManifest;
  try {
    manifest = readVNextManifest(root, manifestPath);
  } catch (error) {
    if (!(error instanceof VNextHandoffError)) {
      fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Close could not read the Manifest: ${error instanceof Error ? error.message : String(error)}`);
    }
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Close could not read the Manifest: ${error.message}`);
  }
  if (manifest.stage_id !== request.stageId) {
    fail('RUNTIME.SCHEMA_MISMATCH', `vNext Stage Close Manifest stage_id "${manifest.stage_id}" does not match request "${request.stageId}"`);
  }
  const manifestDigest = computeDigest(manifest);
  if (manifestDigest !== request.manifestDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Close request manifestDigest does not match the persisted Manifest');
  }
  const planDigest = manifest.plan.plan_digest;
  if (typeof planDigest !== 'string' || !SHA256_RE.test(planDigest)) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'vNext Stage Close Manifest plan_digest is not a lowercase SHA-256 digest');
  }
  // Deliberately NO `assertVNextManifestReferenceBindings` here: see the
  // validateFacts doc comment — archived Manifests are historical snapshots
  // and must not be re-bound to the current Authority files.

  let authority: VNextAdmissionAuthority;
  try {
    authority = readVNextAdmissionAuthority(root, request.stageId);
  } catch (error) {
    if (!(error instanceof VNextHandoffError)) throw error;
    fail(
      error.code === 'admission-missing' ? 'DOMAIN.INVALID_TRANSITION' : 'RUNTIME.SCHEMA_MISMATCH',
      `vNext Stage Close admission authority is unavailable: ${error.message}`,
    );
  }
  authorityBindingsAreValid(root, authority, request.stageId, manifestDigest, planDigest, request.snapshotDigest);

  if (options.skipCleanWorkingTree !== true) {
    assertCleanWorkingTree(root);
  }
  assertStableGitBoundary(root, request.snapshotDigest);
  const snapshotDigest = request.snapshotDigest;

  const closeChain = readStageCloseChain(root, request.stageId);
  if (options.allowInstalledCloseTip === undefined) {
    if (closeChain.receipts.length > 0) {
      fail(
        'DOMAIN.INVALID_TRANSITION',
        `stage "${request.stageId}" is already closed (stage-close chain is not empty; the Stage Close receipt is write-once)`,
      );
    }
  } else if (closeChain.tipDigest !== options.allowInstalledCloseTip) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'stage-close chain tip is not the just-installed Stage Close receipt');
  }

  return {
    root,
    manifest,
    manifestDigest,
    planDigest,
    authority,
    snapshotDigest,
  };
}

function assertStageCloseFactsUnchanged(
  before: ValidatedStageCloseFacts,
  after: ValidatedStageCloseFacts,
): void {
  if (after.manifestDigest !== before.manifestDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Manifest digest changed during the Stage Close write');
  }
  if (after.planDigest !== before.planDigest) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'Plan digest changed during the Stage Close write');
  }
  if (
    after.snapshotDigest !== before.snapshotDigest ||
    after.authority.stagePlan.digest !== before.authority.stagePlan.digest ||
    after.authority.spv.digest !== before.authority.spv.digest
  ) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'snapshot or admission authority changed during the Stage Close write');
  }
}

// ============================================================
// State / envelope / persistence
// ============================================================

export interface VNextStageCloseAdmissionDependencies {
  readonly projectRoot: string;
}

function stageCloseState(
  facts: ValidatedStageCloseFacts,
  request: VNextStageCloseAdmissionRequest,
): VNextStageCloseAdmissionState {
  return {
    schema_version: VNEXT_STAGE_CLOSE_SCHEMA_VERSION,
    type: VNEXT_STAGE_CLOSE_RESULT_TYPE,
    action: VNEXT_STAGE_CLOSE_ACTION,
    stage_id: request.stageId,
    close_type: request.closeType,
    reason: request.reason,
    manifest_digest: facts.manifestDigest,
    plan_digest: facts.planDigest,
    snapshot_digest: facts.snapshotDigest,
    stage_plan_receipt_digest: facts.authority.stagePlan.digest,
    spv_receipt_digest: facts.authority.spv.digest,
    receipt_chain_valid: true,
  };
}

/**
 * The vNext-owned Stage Close receipt envelope: kernel-shaped outer shell
 * (`version: 1`) with the vNext-only `STAGE_CLOSE_PASS` type and the closed
 * `schema_version: 2` payload (`STAGE_CLOSE_RESULT` / `STAGE_CLOSE`).
 */
interface StageCloseReceiptEnvelope {
  readonly version: 1;
  readonly type: VNextStageClosePassType;
  readonly stage_id: string;
  readonly timestamp: string;
  readonly digest: string;
  readonly payload: VNextStageCloseAdmissionState;
}

function buildStageCloseEnvelope(
  state: VNextStageCloseAdmissionState,
): { readonly envelope: StageCloseReceiptEnvelope; readonly digest: string } {
  const content = {
    version: 1 as const,
    type: VNEXT_STAGE_CLOSE_PASS_TYPE,
    stage_id: state.stage_id,
    timestamp: new Date().toISOString(),
    payload: { ...state },
  };
  const digest = computeReceiptDigest(content);
  return { envelope: { ...content, digest }, digest };
}

/**
 * Bounded, atomic, write-once persistence of the Stage Close envelope.
 *
 * The target directory is derived from the canonical project root and the
 * canonical Stage ID (`^S\d+$`), then re-verified root-bound. The file is
 * written through a same-directory temp file (exclusive create + fsync) and
 * atomically renamed into the digest-addressed final name — a rename cannot
 * follow a symlink and never escapes the directory. The final name is
 * checked before the write (a same-digest receipt already on disk is a
 * duplicate, never overwritten), and the installed file is read back and
 * digest/content-verified before the caller sees success.
 */
function writeStageCloseReceipt(
  root: string,
  stageId: string,
  envelope: StageCloseReceiptEnvelope,
  digest: string,
): string {
  const directory = stageCloseReceiptDir(root, stageId);
  const lexical = path.resolve(directory);
  const canonical = canonicalPathWithinRoot(root, lexical);
  if (canonical === null || canonical !== lexical) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', 'stage-close write target is not a canonical directory under the project root');
  }
  fs.mkdirSync(canonical, { recursive: true });

  const finalPath = path.join(canonical, `${digest}.json`);
  if (fs.existsSync(finalPath)) {
    fail(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      `duplicate stage-close receipt rejected — file already exists at ${finalPath} (write-once)`,
    );
  }

  const tmpPath = path.join(canonical, `.${digest}.json.tmp.${process.pid}`);
  const raw = `${JSON.stringify(envelope, null, 2)}\n`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o644);
    fs.writeFileSync(fd, raw, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort */ }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    if (error instanceof VNextStageCloseAdmissionError) throw error;
    fail(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      `stage-close receipt temp write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    fs.closeSync(fd);
  } catch { /* best-effort */ }

  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort */ }
    fail(
      'RUNTIME.RECEIPT_CHAIN_BROKEN',
      `stage-close receipt install failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Readback verification: the installed file must be exactly the envelope
  // this run built (digest + content), root-bound and no-follow.
  const opened = openNoFollowRead(root, finalPath);
  if (!opened.ok || opened.filePath !== finalPath) {
    fail('RUNTIME.RECEIPT_CHAIN_BROKEN', 'stage-close receipt readback is not the installed root-bound file');
  }
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
    } catch (error) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', `stage-close receipt readback is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!sameJsonValue(parsed, envelope)) {
      fail('RUNTIME.RECEIPT_CHAIN_BROKEN', 'stage-close receipt readback does not match the written envelope');
    }
  } finally {
    fs.closeSync(opened.fd);
  }
  return finalPath;
}

function assertInstalledStageCloseReceipt(
  facts: ValidatedStageCloseFacts,
  digest: string,
): void {
  const chain = readStageCloseChain(facts.root, (facts.manifest as VNextManifest).stage_id);
  const tip = chain.receipts[chain.receipts.length - 1];
  if (chain.tipDigest !== digest || tip === undefined) {
    fail('RUNTIME.SCHEMA_MISMATCH', 'the freshly written Stage Close receipt is not the stage-close chain tip');
  }
}

function rejectedStageClose(
  message: string,
  code: StageCloseAdmissionCode = 'RUNTIME.SCHEMA_MISMATCH',
): AdmitResult<VNextStageCloseAdmissionState> {
  return {
    accepted: false,
    receipt_ref: null,
    new_state: null,
    findings: [{ code, severity: 'error', message }],
  };
}

/**
 * Admit one vNext Stage Close fact without entering legacy reconcile/reducer
 * code. Persistence is this module's bounded write-once seam only.
 */
export function admitVNextStageClose(
  value: unknown,
  dependencies: VNextStageCloseAdmissionDependencies,
): AdmitResult<VNextStageCloseAdmissionState> {
  let request: VNextStageCloseAdmissionRequest;
  try {
    request = validateVNextStageCloseRequest(value);
  } catch (error) {
    const code = error instanceof VNextStageCloseAdmissionError ? error.code : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedStageClose(
      `vNext Stage Close request rejected by closed schema: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  let facts: ValidatedStageCloseFacts;
  try {
    facts = validateFacts(request, dependencies);
  } catch (error) {
    const code = error instanceof VNextStageCloseAdmissionError
      ? error.code
      : error instanceof VNextHandoffError
        ? 'RUNTIME.SCHEMA_MISMATCH'
        : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedStageClose(
      `vNext Stage Close admission blocked: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  const state = stageCloseState(facts, request);
  const root = facts.root;
  const { envelope, digest } = buildStageCloseEnvelope(state);
  try {
    // Final read-only revalidation immediately before the write: the Stage
    // must still be unclosed, the tuple unchanged and the boundary stable.
    const beforeWrite = validateFacts(request, dependencies, {});
    assertStageCloseFactsUnchanged(facts, beforeWrite);

    writeStageCloseReceipt(root, request.stageId, envelope, digest);

    // After-write hop: the clean-worktree check is skipped (the receipt now
    // exists) and the chain tip must be the just-installed digest.
    const afterWrite = validateFacts(request, dependencies, {
      allowInstalledCloseTip: digest,
      skipCleanWorkingTree: true,
    });
    assertStageCloseFactsUnchanged(facts, afterWrite);
    assertInstalledStageCloseReceipt(facts, digest);
  } catch (error) {
    const code = error instanceof VNextStageCloseAdmissionError
      ? error.code
      : error instanceof VNextHandoffError
        ? 'RUNTIME.SCHEMA_MISMATCH'
        : 'RUNTIME.SCHEMA_MISMATCH';
    return rejectedStageClose(
      `vNext Stage Close admission blocked: ${error instanceof Error ? error.message : String(error)}`,
      code,
    );
  }

  return {
    accepted: true,
    receipt_ref: digest,
    new_state: null,
    vnext_state: state,
    findings: [],
  };
}

/** A direct alias for callers that name the seam without the Result suffix. */
export const admitVNextStageCloseResult = admitVNextStageClose;
