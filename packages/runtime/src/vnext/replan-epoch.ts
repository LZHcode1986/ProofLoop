/**
 * S14-A-T02 — Runtime replan epoch authority (append-only).
 *
 * ReplanEpoch is a LOGICAL authority (contract §8.8 / architecture §10.10 /
 * HP-021): it adds NO ReceiptType and NO public operation. The Runtime reuses
 * the existing `SPV_PASS` and `STAGE_PLAN` Receipt types and persists
 * epoch-qualified refs append-only under
 * `.proofloop/receipts/plan/<stage>/epochs/<epoch_digest>/`; the initial Stage
 * keeps the canonical plan receipt path unchanged.
 *
 * Fail-closed invariants:
 *  - the epoch digest is DERIVED by the Runtime from the closed epoch tuple;
 *    a caller-declared epoch digest is structurally impossible;
 *  - the current epoch is DERIVED from the validated parent chain only —
 *    never a mutable `current.json` pointer (HP-021);
 *  - a replan admission request declares ONLY stage_id, parent_epoch_digest,
 *    candidate Manifest/Plan/snapshot bindings and the Runtime preparation
 *    disposition ref/digest; the Runtime recomputes the impact set and rejects
 *    caller-forged derived sets or epoch digests (§8.8);
 *  - every epoch write is write-once (O_EXCL); a conflicting target fails
 *    closed and partial writes are rolled back.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  canonicalJson,
  computeDigest,
  validateReceipt,
  validateVNextSpvPassReceipt,
  validateVNextStagePlanReceipt,
  verifyReceiptChain,
} from '@proofloop/kernel';
import type { VNextExecutionScope, VNextManifest, VNextSpvPassReceipt, VNextStagePlanReceipt } from '@proofloop/kernel';
import { canonicalPathWithinRoot, openNoFollowRead } from '../path-guard';
import { CANONICAL_STAGE_ID_RE } from './stage-id';
import { classifyReplanImpact, ReplanImpactError } from './replan-impact';
import type {
  ReplanImpactDisposition,
  ReplanPlanSnapshotInput,
  ReplanSliceContractInput,
  ReplanTaskContractInput,
} from './replan-impact';
import { readVNextAdmissionAuthority } from './next';
import { readVNextManifest } from './dispatch';
import { readGitHead, resolveGitRoot } from '../git-source';

export const REPLAN_EPOCH_SCHEMA_VERSION = 1;
export const REPLAN_FACT_SCHEMA_VERSION = 1;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const SNAPSHOT_HEX_RE = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const REPLAN_IMPACT_SCOPES = new Set(['task-local', 'slice-wide', 'unresolved']);

export class ReplanEpochError extends Error {
  public readonly code:
    | 'REPLAN.EPOCH_INPUT_INVALID'
    | 'REPLAN.EPOCH_NO_AUTHORITY'
    | 'REPLAN.EPOCH_CHAIN_BROKEN'
    | 'REPLAN.EPOCH_CHAIN_AMBIGUOUS'
    | 'REPLAN.EPOCH_ORPHAN'
    | 'REPLAN.EPOCH_INVALID'
    | 'REPLAN.EPOCH_ALREADY_ADMITTED'
    | 'REPLAN.FACT_INVALID'
    | 'REPLAN.FACT_MISSING'
    | 'REPLAN.PERSIST_FAILED'
    | 'REPLAN.ROOT_ESCAPE';

  constructor(code: ReplanEpochError['code'], message: string) {
    super(message);
    this.name = 'ReplanEpochError';
    this.code = code;
  }
}

function fail(code: ReplanEpochError['code'], message: string): never {
  throw new ReplanEpochError(code, `${code}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertHex(value: unknown, name: string, re: RegExp, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    fail('REPLAN.EPOCH_INPUT_INVALID', `${name} must be a string`);
  }
  if (value.length === 0 && allowEmpty) return;
  if (!re.test(value)) fail('REPLAN.EPOCH_INPUT_INVALID', `${name} must be a ${re === SHA256_HEX_RE ? 'sha256 hex digest' : 'hex digest'}`);
}

function assertStringArray(value: unknown, name: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    fail('REPLAN.EPOCH_INPUT_INVALID', `${name} must be a string array`);
  }
}

// ============================================================
// Epoch digest derivation (closed tuple, content-addressed)
// ============================================================

export interface ReplanEpochDigestInput {
  readonly stage_id: string;
  /** '' only for the derived initial epoch root; otherwise 64-hex. */
  readonly parent_epoch_digest: string;
  /** '' only for the derived initial epoch root; otherwise 64-hex. */
  readonly disposition_digest: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly snapshot_digest: string;
}

/**
 * Content-addressed epoch digest over the closed epoch tuple. The Runtime
 * derives the digest itself; a caller-supplied epoch digest is never part of
 * the tuple and is rejected by every consumer of this module.
 */
export function computeReplanEpochDigest(input: ReplanEpochDigestInput): string {
  if (!isRecord(input)) fail('REPLAN.EPOCH_INPUT_INVALID', 'epoch digest input must be an object');
  if (typeof input.stage_id !== 'string' || !CANONICAL_STAGE_ID_RE.test(input.stage_id)) {
    fail('REPLAN.EPOCH_INPUT_INVALID', 'stage_id has an invalid canonical Stage ID (expected /^S\\d+$/)');
  }
  assertHex(input.parent_epoch_digest, 'parent_epoch_digest', SHA256_HEX_RE, true);
  assertHex(input.disposition_digest, 'disposition_digest', SHA256_HEX_RE, true);
  assertHex(input.manifest_digest, 'manifest_digest', SHA256_HEX_RE);
  assertHex(input.plan_digest, 'plan_digest', SHA256_HEX_RE);
  assertHex(input.snapshot_digest, 'snapshot_digest', SNAPSHOT_HEX_RE);
  return computeDigest({
    schema_version: REPLAN_EPOCH_SCHEMA_VERSION,
    stage_id: input.stage_id,
    parent_epoch_digest: input.parent_epoch_digest,
    disposition_digest: input.disposition_digest,
    manifest_digest: input.manifest_digest,
    plan_digest: input.plan_digest,
    snapshot_digest: input.snapshot_digest,
  });
}

// ============================================================
// Replan admission declaration (closed request sub-schema)
// ============================================================

/**
 * The ONLY derived facts a replan admission request may declare (§8.8):
 * stage_id (request-level), parent_epoch_digest, the candidate
 * Manifest/Plan/snapshot bindings (request-level) and the Runtime preparation
 * disposition ref/digest. Impact scope, carry-forward/invalidated sets and
 * the epoch digest itself are NEVER declarable.
 */
export interface VNextReplanAdmissionDeclaration {
  readonly parent_epoch_digest: string;
  readonly disposition_ref: string;
  readonly disposition_digest: string;
}

const REPLAN_DECLARATION_FIELDS = new Set(['parent_epoch_digest', 'disposition_ref', 'disposition_digest']);

export function validateVNextReplanAdmissionDeclaration(value: unknown): VNextReplanAdmissionDeclaration {
  if (!isRecord(value)) fail('REPLAN.EPOCH_INPUT_INVALID', 'replan admission declaration must be an object');
  for (const key of Object.keys(value)) {
    if (!REPLAN_DECLARATION_FIELDS.has(key)) {
      fail('REPLAN.EPOCH_INPUT_INVALID', `replan declaration carries a non-declarable derived fact "${key}"`);
    }
  }
  assertHex(value.parent_epoch_digest, 'replan.parent_epoch_digest', SHA256_HEX_RE);
  if (typeof value.disposition_ref !== 'string' || value.disposition_ref.length === 0) {
    fail('REPLAN.EPOCH_INPUT_INVALID', 'replan.disposition_ref must be a non-empty root-relative path');
  }
  assertHex(value.disposition_digest, 'replan.disposition_digest', SHA256_HEX_RE);
  return value as unknown as VNextReplanAdmissionDeclaration;
}

// ============================================================
// Epoch refs schema (epoch.json)
// ============================================================

export interface ReplanEpochRefs {
  readonly schema_version: 1;
  readonly stage_id: string;
  readonly epoch_digest: string;
  /** '' only for the chain root epoch; otherwise 64-hex parent epoch. */
  readonly parent_epoch_digest: string;
  /** Root-relative Runtime preparation fact ref. */
  readonly disposition_ref: string;
  readonly disposition_digest: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly snapshot_digest: string;
  readonly spv_receipt_digest: string;
  readonly stage_plan_receipt_digest: string;
}

const EPOCH_REFS_FIELDS = new Set([
  'schema_version', 'stage_id', 'epoch_digest', 'parent_epoch_digest', 'disposition_ref',
  'disposition_digest', 'manifest_digest', 'plan_digest', 'snapshot_digest',
  'spv_receipt_digest', 'stage_plan_receipt_digest',
]);

/** Closed epoch refs schema. The self `epoch_digest` must equal the Runtime
 *  derivation over the tuple — a caller-forged epoch digest fails closed. */
export function validateReplanEpochRefs(value: unknown, expectedStageId?: string): ReplanEpochRefs {
  if (!isRecord(value)) fail('REPLAN.EPOCH_INPUT_INVALID', 'epoch refs must be an object');
  for (const key of Object.keys(value)) {
    if (!EPOCH_REFS_FIELDS.has(key)) fail('REPLAN.EPOCH_INPUT_INVALID', `epoch refs carry an unknown field "${key}"`);
  }
  if (value.schema_version !== REPLAN_EPOCH_SCHEMA_VERSION) {
    fail('REPLAN.EPOCH_INPUT_INVALID', 'epoch refs schema_version must be 1');
  }
  if (typeof value.stage_id !== 'string' || !CANONICAL_STAGE_ID_RE.test(value.stage_id)) {
    fail('REPLAN.EPOCH_INPUT_INVALID', 'epoch refs stage_id must be a valid canonical Stage ID');
  }
  if (expectedStageId !== undefined && value.stage_id !== expectedStageId) {
    fail('REPLAN.EPOCH_INVALID', `epoch refs stage_id "${value.stage_id}" does not match requested Stage "${expectedStageId}"`);
  }
  assertHex(value.epoch_digest, 'epoch refs epoch_digest', SHA256_HEX_RE);
  assertHex(value.parent_epoch_digest, 'epoch refs parent_epoch_digest', SHA256_HEX_RE, true);
  if (typeof value.disposition_ref !== 'string' || value.disposition_ref.length === 0) {
    fail('REPLAN.EPOCH_INPUT_INVALID', 'epoch refs disposition_ref must be a non-empty string');
  }
  if (
    path.isAbsolute(value.disposition_ref) ||
    value.disposition_ref.includes('..') ||
    value.disposition_ref.includes('\\') ||
    value.disposition_ref.includes('\u0000')
  ) {
    fail('REPLAN.EPOCH_INPUT_INVALID', 'epoch refs disposition_ref must be a canonical root-relative path');
  }
  assertHex(value.disposition_digest, 'epoch refs disposition_digest', SHA256_HEX_RE);
  assertHex(value.manifest_digest, 'epoch refs manifest_digest', SHA256_HEX_RE);
  assertHex(value.plan_digest, 'epoch refs plan_digest', SHA256_HEX_RE);
  assertHex(value.snapshot_digest, 'epoch refs snapshot_digest', SNAPSHOT_HEX_RE);
  assertHex(value.spv_receipt_digest, 'epoch refs spv_receipt_digest', SHA256_HEX_RE);
  assertHex(value.stage_plan_receipt_digest, 'epoch refs stage_plan_receipt_digest', SHA256_HEX_RE);
  const refs = value as unknown as ReplanEpochRefs;
  const derived = computeReplanEpochDigest({
    stage_id: refs.stage_id,
    parent_epoch_digest: refs.parent_epoch_digest,
    disposition_digest: refs.disposition_digest,
    manifest_digest: refs.manifest_digest,
    plan_digest: refs.plan_digest,
    snapshot_digest: refs.snapshot_digest,
  });
  if (refs.epoch_digest !== derived) {
    fail('REPLAN.EPOCH_INPUT_INVALID', 'epoch refs epoch_digest does not match the Runtime derivation (caller-forged epoch digest is rejected)');
  }
  return refs;
}

// ============================================================
// Runtime preparation disposition fact (`.proofloop/runtime/replan/**`)
// ============================================================

export interface ReplanDispositionFact {
  readonly schema_version: 1;
  readonly stage_id: string;
  readonly previous_manifest_ref: string;
  readonly manifest_ref: string;
  readonly previous_snapshot: ReplanPlanSnapshotInput;
  readonly snapshot: ReplanPlanSnapshotInput;
  readonly completed_task_ids: readonly string[];
  readonly disposition: ReplanImpactDisposition;
  /** Self-digest over the fact without the digest field (content-addressed). */
  readonly digest: string;
}

const FACT_FIELDS = new Set([
  'schema_version', 'stage_id', 'previous_manifest_ref', 'manifest_ref',
  'previous_snapshot', 'snapshot', 'completed_task_ids', 'disposition', 'digest',
]);

function validateSnapshotShape(value: unknown, name: string): asserts value is ReplanPlanSnapshotInput {
  if (!isRecord(value)) fail('REPLAN.FACT_INVALID', `${name} must be an object`);
  if (typeof value.stage_id !== 'string' || value.stage_id.length === 0) {
    fail('REPLAN.FACT_INVALID', `${name}.stage_id must be a non-empty string`);
  }
  assertHex(value.plan_digest, `${name}.plan_digest`, SHA256_HEX_RE);
  assertHex(value.manifest_digest, `${name}.manifest_digest`, SHA256_HEX_RE);
  assertHex(value.stage_contract_digest, `${name}.stage_contract_digest`, SHA256_HEX_RE);
  assertHex(value.snapshot_digest, `${name}.snapshot_digest`, SNAPSHOT_HEX_RE);
  assertStringArray(value.authority_ref_ids, `${name}.authority_ref_ids`);
  if (!isRecord(value.reference_index)) fail('REPLAN.FACT_INVALID', `${name}.reference_index must be an object`);
  if (!Array.isArray(value.slices) || value.slices.length === 0) fail('REPLAN.FACT_INVALID', `${name}.slices must be a non-empty array`);
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) fail('REPLAN.FACT_INVALID', `${name}.tasks must be a non-empty array`);
}

function validateDispositionShape(value: unknown): asserts value is ReplanImpactDisposition {
  if (!isRecord(value)) fail('REPLAN.FACT_INVALID', 'fact.disposition must be an object');
  if (value.schema_version !== 1) fail('REPLAN.FACT_INVALID', 'fact.disposition.schema_version must be 1');
  if (typeof value.stage_id !== 'string' || value.stage_id.length === 0) {
    fail('REPLAN.FACT_INVALID', 'fact.disposition.stage_id must be a non-empty string');
  }
  assertHex(value.parent_epoch_digest, 'fact.disposition.parent_epoch_digest', SHA256_HEX_RE);
  if (typeof value.impact_scope !== 'string' || !REPLAN_IMPACT_SCOPES.has(value.impact_scope)) {
    fail('REPLAN.FACT_INVALID', 'fact.disposition.impact_scope must be task-local, slice-wide or unresolved');
  }
  assertStringArray(value.changed_task_ids, 'fact.disposition.changed_task_ids');
  assertStringArray(value.carry_forward_task_ids, 'fact.disposition.carry_forward_task_ids');
  assertStringArray(value.invalidated_task_ids, 'fact.disposition.invalidated_task_ids');
  assertHex(value.previous_manifest_digest, 'fact.disposition.previous_manifest_digest', SHA256_HEX_RE);
  assertHex(value.manifest_digest, 'fact.disposition.manifest_digest', SHA256_HEX_RE);
  assertHex(value.previous_plan_digest, 'fact.disposition.previous_plan_digest', SHA256_HEX_RE);
  assertHex(value.plan_digest, 'fact.disposition.plan_digest', SHA256_HEX_RE);
  assertHex(value.snapshot_digest, 'fact.disposition.snapshot_digest', SNAPSHOT_HEX_RE);
  const scope = value.impact_scope as ReplanImpactDisposition['impact_scope'];
  if (scope === 'unresolved') {
    if (typeof value.unresolved_reason !== 'string' || value.unresolved_reason.length === 0) {
      fail('REPLAN.FACT_INVALID', 'unresolved disposition must carry an unresolved_reason');
    }
  } else if (value.unresolved_reason !== undefined) {
    fail('REPLAN.FACT_INVALID', 'resolved disposition must not carry an unresolved_reason');
  }
}

/** Closed disposition fact schema + self-digest verification. */
export function validateReplanDispositionFact(value: unknown): ReplanDispositionFact {
  if (!isRecord(value)) fail('REPLAN.FACT_INVALID', 'replan disposition fact must be an object');
  for (const key of Object.keys(value)) {
    if (!FACT_FIELDS.has(key)) fail('REPLAN.FACT_INVALID', `replan disposition fact carries an unknown field "${key}"`);
  }
  if (value.schema_version !== REPLAN_FACT_SCHEMA_VERSION) {
    fail('REPLAN.FACT_INVALID', 'replan disposition fact schema_version must be 1');
  }
  if (typeof value.stage_id !== 'string' || value.stage_id.length === 0) {
    fail('REPLAN.FACT_INVALID', 'fact.stage_id must be a non-empty string');
  }
  if (typeof value.previous_manifest_ref !== 'string' || value.previous_manifest_ref.length === 0) {
    fail('REPLAN.FACT_INVALID', 'fact.previous_manifest_ref must be a non-empty string');
  }
  if (typeof value.manifest_ref !== 'string' || value.manifest_ref.length === 0) {
    fail('REPLAN.FACT_INVALID', 'fact.manifest_ref must be a non-empty string');
  }
  validateSnapshotShape(value.previous_snapshot, 'fact.previous_snapshot');
  validateSnapshotShape(value.snapshot, 'fact.snapshot');
  assertStringArray(value.completed_task_ids, 'fact.completed_task_ids');
  validateDispositionShape(value.disposition);
  assertHex(value.digest, 'fact.digest', SHA256_HEX_RE);
  const fact = value as unknown as ReplanDispositionFact;
  // The fact digest is computed over the JSON-serialized content: optional
  // members (e.g. disposition.unresolved_reason) serialize away, so the
  // persisted digest and the re-read digest always agree (§8.8 digest-bound
  // preparation fact).
  const derived = computeDigest(
    JSON.parse(
      JSON.stringify({
        schema_version: fact.schema_version,
        stage_id: fact.stage_id,
        previous_manifest_ref: fact.previous_manifest_ref,
        manifest_ref: fact.manifest_ref,
        previous_snapshot: fact.previous_snapshot,
        snapshot: fact.snapshot,
        completed_task_ids: fact.completed_task_ids,
        disposition: fact.disposition,
      }),
    ),
  );
  if (fact.digest !== derived) {
    fail('REPLAN.FACT_INVALID', 'disposition fact digest does not match its content (forged derived sets are rejected)');
  }
  return fact;
}

/** Canonical Runtime preparation fact area. */
export function replanFactDirectory(root: string, stageId: string): string {
  return path.join(root, '.proofloop', 'runtime', 'replan', stageId);
}

/**
 * Root-bound, digest-addressed read of the Runtime preparation disposition
 * fact. The ref must live under `.proofloop/runtime/replan/<stage>/` and the
 * basename must equal `<digest>.json`; any other location or a digest
 * mismatch fails closed.
 */
export function readReplanDispositionFact(root: string, factRef: string, expectedDigest: string): ReplanDispositionFact {
  if (typeof factRef !== 'string' || factRef.length === 0) fail('REPLAN.FACT_INVALID', 'disposition fact ref must be a non-empty string');
  const canonical = canonicalPathWithinRoot(root, factRef);
  if (canonical === null) fail('REPLAN.ROOT_ESCAPE', 'disposition fact ref escapes the project root trust boundary');
  const relative = path.relative(root, canonical).split(path.sep).join('/');
  if (!relative.startsWith('.proofloop/runtime/replan/')) {
    fail('REPLAN.FACT_INVALID', 'disposition fact must live under .proofloop/runtime/replan/');
  }
  let raw: string;
  const read = readNoFollowText(root, canonical);
  if (!read.ok) {
    if (read.missing) fail('REPLAN.FACT_MISSING', 'replan disposition fact is missing at ' + canonical);
    fail('REPLAN.FACT_INVALID', 'replan disposition fact cannot be read at ' + canonical);
  }
  raw = read.text;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { fail('REPLAN.FACT_INVALID', 'replan disposition fact is not valid JSON'); }
  const fact = validateReplanDispositionFact(parsed);
  if (fact.digest !== expectedDigest) {
    fail('REPLAN.FACT_INVALID', `disposition fact digest "${fact.digest}" does not match the declared "${expectedDigest}"`);
  }
  const factDir = path.dirname(canonical);
  if (path.basename(factDir) !== fact.stage_id) {
    fail('REPLAN.FACT_INVALID', 'disposition fact directory must be named after the fact stage_id');
  }
  if (path.basename(canonical) !== `${fact.digest}.json`) {
    fail('REPLAN.FACT_INVALID', 'disposition fact basename must be <digest>.json (content-addressed)');
  }
  return fact;
}

// ============================================================
// Receipt-derived completion & Snapshot / Producer helpers
// ============================================================

/**
 * Derive completed task IDs from the TASK_COMPLETE receipt chain of the
 * requested Stage and previous Manifest/Plan binding. Stale or foreign
 * receipts fail closed.
 */
export function deriveCompletedTaskIdsFromReceipts(
  root: string,
  stageId: string,
  previousManifestDigest: string,
  previousPlanDigest: string,
  slices?: readonly { readonly slice_id: string; readonly task_ids?: readonly string[] }[],
  previousSnapshotDigest?: string,
): { ok: true; task_ids: string[] } | { ok: false; message: string } {
  const completed = new Set<string>();
  const sliceIds = slices ? slices.map((s) => s.slice_id) : [];
  const sliceTaskMap = new Map<string, Set<string>>();
  if (slices) {
    for (const s of slices) {
      if (s.task_ids) {
        sliceTaskMap.set(s.slice_id, new Set(s.task_ids));
      }
    }
  }

  let targetSliceIds = sliceIds;
  const stageTasksDir = path.join(root, '.proofloop', 'receipts', 'tasks', stageId);
  if (targetSliceIds.length === 0) {
    try {
      if (fs.existsSync(stageTasksDir)) {
        targetSliceIds = fs.readdirSync(stageTasksDir).filter((name) => {
          try {
            return fs.statSync(path.join(stageTasksDir, name)).isDirectory();
          } catch {
            return false;
          }
        });
      }
    } catch {
      targetSliceIds = [];
    }
  }

  for (const sliceId of targetSliceIds) {
    const directory = path.join(stageTasksDir, sliceId);
    if (!fs.existsSync(directory)) continue;
    const chainResult = verifyReceiptChain(directory);
    if (!chainResult.valid) {
      return { ok: false, message: `Worker Receipt chain is invalid for ${stageId}/${sliceId}` };
    }
    const declaredTasks = sliceTaskMap.get(sliceId);
    for (const name of chainResult.receipts) {
      const fullPath = path.resolve(directory, name);
      const opened = openNoFollowRead(root, fullPath);
      if (!opened.ok) {
        return { ok: false, message: `Worker Receipt is not root-bound: ${name}` };
      }
      let receipt: unknown;
      try {
        receipt = JSON.parse(fs.readFileSync(opened.fd, 'utf8'));
      } catch {
        return { ok: false, message: `Worker Receipt cannot be read: ${name}` };
      } finally {
        try {
          fs.closeSync(opened.fd);
        } catch {
          // best effort
        }
      }
      let validated: ReturnType<typeof validateReceipt>;
      try {
        validated = validateReceipt(receipt);
      } catch {
        return { ok: false, message: `Worker Receipt is invalid: ${name}` };
      }
      if (validated.type !== 'TASK_COMPLETE' || validated.stage_id !== stageId || validated.slice_id !== sliceId) {
        return { ok: false, message: `Worker Receipt does not bind ${stageId}/${sliceId}: ${name}` };
      }
      const payload = validated.payload;
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return { ok: false, message: `Worker Receipt payload is malformed: ${name}` };
      }
      const record = payload as Record<string, unknown>;
      const taskId = record.task_id;
      if (typeof taskId !== 'string' || taskId.length === 0) {
        return { ok: false, message: `Worker Receipt has no task_id: ${name}` };
      }
      if (typeof record.snapshot_digest !== 'string' || record.snapshot_digest.length === 0) {
        return { ok: false, message: `Worker Receipt has no snapshot_digest: ${name}` };
      }
      if (typeof record.manifest_digest !== 'string' || record.manifest_digest.length === 0) {
        return { ok: false, message: `Worker Receipt has no manifest_digest: ${name}` };
      }
      if (typeof record.plan_digest !== 'string' || record.plan_digest.length === 0) {
        return { ok: false, message: `Worker Receipt has no plan_digest: ${name}` };
      }
      if (record.stage_id !== undefined && record.stage_id !== stageId) {
        return { ok: false, message: `Worker Receipt payload stage_id "${record.stage_id}" does not match receipt stage "${stageId}": ${name}` };
      }
      if (record.slice_id !== undefined && record.slice_id !== sliceId) {
        return { ok: false, message: `Worker Receipt payload slice_id "${record.slice_id}" does not match receipt slice "${sliceId}": ${name}` };
      }
      if (declaredTasks !== undefined) {
        if (!declaredTasks.has(taskId)) {
          return { ok: false, message: `Worker Receipt in slice "${sliceId}" has task_id "${taskId}" not declared in slice: ${name}` };
        }
      } else if (!taskId.startsWith(`${sliceId}-`)) {
        return { ok: false, message: `Worker Receipt in slice "${sliceId}" has cross-slice task_id "${taskId}": ${name}` };
      }
      if (record.manifest_digest !== previousManifestDigest) {
        return { ok: false, message: `Worker Receipt manifest_digest "${record.manifest_digest}" does not match previous epoch "${previousManifestDigest}": ${name}` };
      }
      if (record.plan_digest !== previousPlanDigest) {
        return { ok: false, message: `Worker Receipt plan_digest "${record.plan_digest}" does not match previous epoch "${previousPlanDigest}": ${name}` };
      }
      if (previousSnapshotDigest !== undefined && record.snapshot_digest !== previousSnapshotDigest) {
        return { ok: false, message: `Worker Receipt snapshot_digest "${record.snapshot_digest}" does not match previous epoch "${previousSnapshotDigest}": ${name}` };
      }
      completed.add(taskId);
    }
  }
  return { ok: true, task_ids: [...completed].sort() };
}

interface ParsedTaskProjection {
  goal?: string;
  refs?: string[];
  dependencies?: string[];
  required_skills?: string[];
  execution_scope?: VNextExecutionScope;
}

function parseTaskFromPlanContent(planContent: string, taskId: string): ParsedTaskProjection | null {
  // The Task entity marker must anchor the WHOLE line: any prefix/suffix text,
  // indentation or trailing content on the marker line is a structural defect
  // and must fail closed (CV S15-A-REPAIR10-PLAN-MARKER-SECTION-OWNERSHIP).
  const lines = planContent.split('\n');
  const firstLine = lines[0] ?? '';
  const anchoredMarker = new RegExp(
    `^<!--\\s*proofloop:entity\\s+id="${taskId}"\\s+kind="task"\\s*-->\\s*$`,
  ).exec(firstLine);
  if (anchoredMarker === null) return null;
  const block = lines.slice(1).join('\n');

  const result: ParsedTaskProjection = {};

  // Goal (same-line only)
  const goalMatch = new RegExp(`^[ \\t]*-[ \\t]*\\[[ xX]\\][ \\t]+${taskId}[ \\t]+(?:—|-)[ \\t]*([^\\r\\n]+)`, 'm').exec(block);
  if (goalMatch) {
    const rawGoal = goalMatch[1].trim();
    if (rawGoal.length > 0) {
      result.goal = rawGoal;
    }
  }

  // refs
  const refsMatch = /^\s*-\s*refs:\s*([^\n\r]+)$/m.exec(block);
  if (refsMatch) {
    const raw = refsMatch[1].trim();
    if (raw.toLowerCase() !== 'none' && raw.length > 0) {
      result.refs = raw
        .split(',')
        .map((r) => r.replace(/[`\s]/g, '').trim())
        .filter((r) => r.length > 0);
    } else {
      result.refs = [];
    }
  }

  // Dependencies
  const depsMatch = /^\s*-\s*Dependencies:\s*([^\n\r]+)$/m.exec(block);
  if (depsMatch) {
    const raw = depsMatch[1].trim();
    if (raw.toLowerCase() !== 'none' && raw.length > 0) {
      result.dependencies = raw
        .split(',')
        .map((d) => d.replace(/[`\s]/g, '').trim())
        .filter((d) => d.length > 0);
    } else {
      result.dependencies = [];
    }
  }

  // Required Skills
  const skillsMatch = /^\s*-\s*Required Skills:\s*([^\n\r]+)$/m.exec(block);
  if (skillsMatch) {
    const raw = skillsMatch[1].trim();
    if (raw.toLowerCase() !== 'none' && raw.length > 0) {
      result.required_skills = raw
        .split(',')
        .map((s) => s.replace(/[`\s]/g, '').trim())
        .filter((s) => s.length > 0);
    } else {
      result.required_skills = [];
    }
  }

  // execution_scope
  const scopeMatch = /^\s*-\s*execution_scope:\s*(\{.*\})$/m.exec(block);
  if (scopeMatch) {
    try {
      result.execution_scope = JSON.parse(scopeMatch[1]);
    } catch {
      // ignore
    }
  }

  return result;
}

/**
 * Convert a compiled VNextManifest to ReplanPlanSnapshotInput.
 */
export function manifestToReplanPlanSnapshot(
  manifest: VNextManifest,
  snapshotDigest: string,
  planContent?: string,
): ReplanPlanSnapshotInput {
  if (typeof planContent !== 'string' || planContent.trim().length === 0) {
    throw new ReplanEpochError(
      'REPLAN.FACT_INVALID',
      'planContent is required and must not be empty for manifestToReplanPlanSnapshot',
    );
  }

  const binding = manifest.binding as unknown as { stage_contract_digest?: string } | undefined;
  const stageContractDigest =
    binding?.stage_contract_digest ??
    computeDigest({
      stage_id: manifest.stage_id,
      plan_digest: manifest.plan.plan_digest,
    });

  const taskScopes = manifest.task_scopes ?? {};
  const tasks: ReplanTaskContractInput[] = [];
  const slices: ReplanSliceContractInput[] = [];

  const resolveRef = (ref: string): string => {
    if (!ref) return ref;
    if (manifest.reference_index && !(ref in manifest.reference_index)) {
      const found = Object.entries(manifest.reference_index).find(
        ([_refId, desc]: [string, { ref: string }]) => desc.ref === ref,
      );
      if (found) return found[0];
    }
    return ref;
  };

  const SLICE_BEGIN_MARKER_RE = /^\s*<!--\s*SLICE:([A-Za-z0-9_-]+):BEGIN\s*-->\s*$/;
  const SLICE_END_MARKER_RE = /^\s*<!--\s*SLICE:([A-Za-z0-9_-]+):END\s*-->\s*$/;
  // Anchored to the WHOLE line: any prefix/suffix pollution of a Task entity
  // marker is a structural defect and must fail closed (CV
  // S15-A-REPAIR10-PLAN-MARKER-SECTION-OWNERSHIP-SELF-ORACLE, counterexample 1).
  const TASK_ENTITY_MARKER_RE = /^<!--\s*proofloop:entity\s+id="([^"]+)"\s+kind="task"\s*-->\s*$/;

  const manifestSliceIds = new Set(manifest.slices.map((s) => s.slice_id));
  const sliceTaskMap = new Map<string, Set<string>>();
  const allDeclaredTasks = new Set<string>();

  for (const s of manifest.slices) {
    const sliceTaskIds = Object.keys(taskScopes).filter((id) => id.startsWith(`${s.slice_id}-`));
    sliceTaskMap.set(s.slice_id, new Set(sliceTaskIds));
    for (const taskId of sliceTaskIds) {
      allDeclaredTasks.add(taskId);
    }
  }

  const lines = planContent.split('\n');
  let currentSliceId: string | null = null;
  const seenSliceBegins = new Set<string>();
  const seenSliceEnds = new Set<string>();
  const seenTaskIds = new Set<string>();
  const taskBlocks = new Map<string, string>();
  let currentTaskId: string | null = null;
  let currentTaskLines: string[] = [];

  const flushTaskBlock = () => {
    if (currentTaskId !== null) {
      taskBlocks.set(currentTaskId, currentTaskLines.join('\n'));
      currentTaskId = null;
      currentTaskLines = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const sliceBegin = SLICE_BEGIN_MARKER_RE.exec(line);
    if (sliceBegin !== null) {
      flushTaskBlock();
      const sliceId = sliceBegin[1];
      if (!manifestSliceIds.has(sliceId)) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan contains undeclared slice section "${sliceId}"`,
        );
      }
      if (currentSliceId !== null) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan contains nested slice section "${sliceId}" inside "${currentSliceId}"`,
        );
      }
      if (seenSliceBegins.has(sliceId)) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan contains duplicate slice section "${sliceId}"`,
        );
      }
      seenSliceBegins.add(sliceId);
      currentSliceId = sliceId;
      continue;
    }

    const sliceEnd = SLICE_END_MARKER_RE.exec(line);
    if (sliceEnd !== null) {
      flushTaskBlock();
      const sliceId = sliceEnd[1];
      if (currentSliceId === null) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan contains unmatched slice end marker "${sliceId}"`,
        );
      }
      if (currentSliceId !== sliceId) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan contains mismatched slice end marker "${sliceId}" for active slice "${currentSliceId}"`,
        );
      }
      if (seenSliceEnds.has(sliceId)) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan contains duplicate slice end marker "${sliceId}"`,
        );
      }
      seenSliceEnds.add(sliceId);
      currentSliceId = null;
      continue;
    }

    const taskMarker = TASK_ENTITY_MARKER_RE.exec(line);
    if (taskMarker !== null) {
      flushTaskBlock();
      const taskId = taskMarker[1];
      if (currentSliceId === null) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Task entity marker "${taskId}" is located outside any slice section`,
        );
      }
      const declaredSliceTasks = sliceTaskMap.get(currentSliceId);
      if (!declaredSliceTasks || !declaredSliceTasks.has(taskId) || !taskId.startsWith(`${currentSliceId}-`)) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Task entity marker "${taskId}" is located in wrong slice section "${currentSliceId}"`,
        );
      }
      if (!allDeclaredTasks.has(taskId)) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan contains undeclared task entity marker "${taskId}"`,
        );
      }
      if (seenTaskIds.has(taskId)) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan contains duplicate task entity marker "${taskId}"`,
        );
      }
      seenTaskIds.add(taskId);
      currentTaskId = taskId;
      currentTaskLines = [line];
      continue;
    }

    if (currentTaskId !== null) {
      if (
        line.startsWith('<!-- proofloop:entity') ||
        line.startsWith('## ') ||
        line.startsWith('### Mutable Execution Projection') ||
        line.startsWith('### ')
      ) {
        flushTaskBlock();
      } else {
        currentTaskLines.push(line);
      }
    }
  }

  flushTaskBlock();

  if (currentSliceId !== null) {
    throw new ReplanEpochError(
      'REPLAN.FACT_INVALID',
      `Plan contains unclosed slice section "${currentSliceId}"`,
    );
  }

  for (const s of manifest.slices) {
    if (!seenSliceBegins.has(s.slice_id)) {
      throw new ReplanEpochError(
        'REPLAN.FACT_INVALID',
        `Plan is missing slice section for declared slice "${s.slice_id}"`,
      );
    }
    if (!seenSliceEnds.has(s.slice_id)) {
      throw new ReplanEpochError(
        'REPLAN.FACT_INVALID',
        `Plan is missing slice end marker for declared slice "${s.slice_id}"`,
      );
    }
  }

  for (const taskId of allDeclaredTasks) {
    if (!seenTaskIds.has(taskId)) {
      throw new ReplanEpochError(
        'REPLAN.FACT_INVALID',
        `Plan is missing required task entity marker for declared task "${taskId}"`,
      );
    }
  }

  for (const s of manifest.slices) {
    const sliceTaskIds = Object.keys(taskScopes).filter((id) => id.startsWith(`${s.slice_id}-`));
    for (const taskId of sliceTaskIds) {
      const scope = taskScopes[taskId];
      const block = taskBlocks.get(taskId) ?? '';
      const parsedTask = parseTaskFromPlanContent(block, taskId);

      if (parsedTask === null) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan is missing required task entity marker for declared task "${taskId}"`,
        );
      }
      if (!parsedTask.goal || parsedTask.goal.trim().length === 0) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan is missing valid goal definition for task "${taskId}"`,
        );
      }
      if (parsedTask.refs === undefined || parsedTask.refs.length === 0) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan is missing required "refs:" declaration for task "${taskId}"`,
        );
      }
      if (parsedTask.dependencies === undefined) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan is missing required "Dependencies:" declaration for task "${taskId}"`,
        );
      }
      if (parsedTask.required_skills === undefined) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan is missing required "Required Skills:" declaration for task "${taskId}"`,
        );
      }

      if (!parsedTask.execution_scope) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan is missing required "execution_scope:" declaration for task "${taskId}"`,
        );
      }
      if (!scope?.execution_scope) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Manifest is missing execution_scope definition for task "${taskId}"`,
        );
      }
      if (canonicalJson(parsedTask.execution_scope) !== canonicalJson(scope.execution_scope)) {
        throw new ReplanEpochError(
          'REPLAN.FACT_INVALID',
          `Plan execution_scope does not match Manifest task_scopes.execution_scope for task "${taskId}"`,
        );
      }
      const executionScope = parsedTask.execution_scope;

      tasks.push({
        task_id: taskId,
        slice_id: s.slice_id,
        goal: parsedTask.goal,
        refs: parsedTask.refs.map(resolveRef),
        dependencies: parsedTask.dependencies,
        required_skills: parsedTask.required_skills,
        execution_scope: executionScope,
      });
    }

    slices.push({
      slice_id: s.slice_id,
      slice_contract_digest:
        s.slice_contract_digest ??
        computeDigest({
          slice_id: s.slice_id,
          dependencies: s.depends_on,
          required_skills: s.required_skills,
          evidence_path: s.evidence_path,
          proof_index: s.proof_index,
        }),
      depends_on: s.depends_on ?? [],
      required_skills: s.required_skills ?? [],
      evidence_path: s.evidence_path,
      proof_index: s.proof_index as unknown as ReplanPlanSnapshotInput['slices'][number]['proof_index'],
      task_ids: sliceTaskIds,
    });
  }

  return {
    stage_id: manifest.stage_id,
    plan_digest: manifest.plan.plan_digest,
    manifest_digest: computeDigest(manifest),
    stage_contract_digest: stageContractDigest,
    snapshot_digest: snapshotDigest,
    authority_ref_ids: manifest.authority_ref_ids ?? [],
    reference_index: manifest.reference_index as unknown as ReplanPlanSnapshotInput['reference_index'],
    slices,
    tasks,
  };
}

export interface ProduceReplanDispositionFactInput {
  readonly stageId: string;
  readonly manifestPath: string;
  readonly previousManifestDigest: string;
  readonly previousManifestRef?: string;
}

/**
 * Runtime producer for the ReplanDisposition preparation fact: derives the
 * disposition fact from current epoch, candidate Manifest, Task/Receipt/Evidence/Git
 * facts, and write-once persists it under `.proofloop/runtime/replan/<stage_id>/`.
 */
export function produceAndPersistReplanDispositionFact(
  root: string,
  params: ProduceReplanDispositionFactInput,
): {
  readonly fact: ReplanDispositionFact;
  readonly factRef: string;
  readonly factDigest: string;
} {
  const stageId = params.stageId;
  const current = readCurrentEpoch(root, stageId);

  const prevManifestDigest = current.kind === 'initial' ? current.spv.manifest_digest : current.epoch.manifest_digest;
  const prevPlanDigest = current.kind === 'initial' ? current.spv.plan_digest : current.epoch.plan_digest;
  const prevSnapshotDigest = current.kind === 'initial' ? current.spv.snapshot_digest : current.epoch.snapshot_digest;

  if (params.previousManifestDigest !== prevManifestDigest) {
    fail(
      'REPLAN.FACT_INVALID',
      `requested previous_manifest_digest "${params.previousManifestDigest}" does not match current epoch manifest_digest "${prevManifestDigest}"`,
    );
  }

  // 1. Locate previous manifest
  let previousManifestRef: string | null = null;
  let previousManifest: VNextManifest | null = null;

  if (params.previousManifestRef) {
    const canonical = canonicalPathWithinRoot(root, params.previousManifestRef);
    if (canonical === null) fail('REPLAN.ROOT_ESCAPE', 'previous_manifest_ref escapes the root boundary');
    try {
      const parsed = readVNextManifest(root, canonical);
      if (computeDigest(parsed) === prevManifestDigest && parsed.stage_id === stageId) {
        previousManifestRef = path.relative(root, canonical).split(path.sep).join('/');
        previousManifest = parsed;
      }
    } catch {
      // try scanning
    }
  }

  if (previousManifestRef === null || previousManifest === null) {
    const candidateDirs = [
      path.posix.dirname(params.manifestPath),
      `delivery/stages/${stageId}`,
      '.proofloop/manifests',
      `.proofloop/manifests/${stageId}`,
    ];
    for (const relDir of candidateDirs) {
      const canonicalDir = canonicalPathWithinRoot(root, relDir);
      if (canonicalDir === null || !fs.existsSync(canonicalDir)) continue;
      try {
        const entries = fs.readdirSync(canonicalDir);
        for (const entry of entries) {
          if (!entry.endsWith('.json')) continue;
          const fullPath = path.join(canonicalDir, entry);
          try {
            const parsed = readVNextManifest(root, fullPath);
            if (computeDigest(parsed) === prevManifestDigest && parsed.stage_id === stageId) {
              previousManifestRef = path.relative(root, fullPath).split(path.sep).join('/');
              previousManifest = parsed;
              break;
            }
          } catch {
            // ignore non-manifest json
          }
        }
      } catch {
        // ignore
      }
      if (previousManifestRef !== null && previousManifest !== null) break;
    }
  }

  // If not on disk, read from git commit of the previous epoch
  if (previousManifestRef === null || previousManifest === null) {
    try {
      const gitRoot = resolveGitRoot(root);
      const normPath = path.posix.normalize(params.manifestPath).replace(/^\.\//, '');
      const gitManifestContent = execFileSync(
        'git',
        ['-C', gitRoot, 'show', `${prevSnapshotDigest}:${normPath}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const parsed = JSON.parse(gitManifestContent);
      if (computeDigest(parsed) === prevManifestDigest && parsed.stage_id === stageId) {
        previousManifestRef = normPath;
        previousManifest = parsed as VNextManifest;
      }
    } catch {
      // ignore
    }
  }

  if (previousManifestRef === null || previousManifest === null) {
    fail('REPLAN.FACT_INVALID', `cannot locate previous Manifest matching digest "${prevManifestDigest}" for Stage "${stageId}"`);
  }

  // 2. Read candidate manifest
  const candidateCanonical = canonicalPathWithinRoot(root, params.manifestPath);
  if (candidateCanonical === null) fail('REPLAN.ROOT_ESCAPE', 'candidate manifest_path escapes the root boundary');
  const candidateManifest = readVNextManifest(root, candidateCanonical);
  if (candidateManifest.stage_id !== stageId) {
    fail('REPLAN.FACT_INVALID', `candidate Manifest stage_id "${candidateManifest.stage_id}" does not match "${stageId}"`);
  }
  const candidateManifestDigest = computeDigest(candidateManifest);
  const candidateManifestRef = path.relative(root, candidateCanonical).split(path.sep).join('/');

  // 3. Read git HEAD
  let head: string;
  try {
    head = readGitHead(resolveGitRoot(root));
  } catch (error) {
    fail('REPLAN.FACT_INVALID', 'current Git HEAD is unavailable: ' + (error instanceof Error ? error.message : String(error)));
  }

  // 4. Build snapshots
  let candidatePlanContent: string | undefined;
  try {
    const planCanonical = canonicalPathWithinRoot(root, candidateManifest.plan.ref);
    if (planCanonical && fs.existsSync(planCanonical)) {
      candidatePlanContent = fs.readFileSync(planCanonical, 'utf8');
    }
  } catch {
    // ignore
  }

  let previousPlanContent: string | undefined;
  try {
    const gitRoot = resolveGitRoot(root);
    const normPlanPath = path.posix.normalize(previousManifest.plan.ref).replace(/^\.\//, '');
    previousPlanContent = execFileSync(
      'git',
      ['-C', gitRoot, 'show', `${prevSnapshotDigest}:${normPlanPath}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch {
    try {
      const prevPlanCanonical = canonicalPathWithinRoot(root, previousManifest.plan.ref);
      if (prevPlanCanonical && fs.existsSync(prevPlanCanonical)) {
        previousPlanContent = fs.readFileSync(prevPlanCanonical, 'utf8');
      }
    } catch {
      // ignore
    }
  }

  const previousSnapshot = manifestToReplanPlanSnapshot(previousManifest, prevSnapshotDigest, previousPlanContent);
  const candidateSnapshot = manifestToReplanPlanSnapshot(candidateManifest, head, candidatePlanContent);

  // 5. Derive completed_task_ids from receipts
  const derived = deriveCompletedTaskIdsFromReceipts(
    root,
    stageId,
    prevManifestDigest,
    previousManifest.plan.plan_digest,
    previousSnapshot.slices,
    prevSnapshotDigest,
  );
  if (!derived.ok) {
    fail('REPLAN.FACT_INVALID', `Worker Receipt chain error: ${derived.message}`);
  }

  // 6. Compute impact disposition
  let disposition: ReplanImpactDisposition;
  try {
    disposition = classifyReplanImpact({
      previous: previousSnapshot,
      candidate: candidateSnapshot,
      parent_epoch_digest: current.epoch_digest,
      completed_task_ids: derived.task_ids,
    });
  } catch (error) {
    fail('REPLAN.FACT_INVALID', 'impact classification failed: ' + (error instanceof Error ? error.message : String(error)));
  }

  if (disposition.impact_scope === 'unresolved') {
    fail('REPLAN.FACT_INVALID', `disposition is unresolved (${disposition.unresolved_reason ?? 'unknown'}); replan is not authorized`);
  }

  // 7. Assemble and persist fact
  const factPayload = {
    schema_version: 1 as const,
    stage_id: stageId,
    previous_manifest_ref: previousManifestRef,
    manifest_ref: candidateManifestRef,
    previous_snapshot: previousSnapshot,
    snapshot: candidateSnapshot,
    completed_task_ids: derived.task_ids,
    disposition: disposition,
  };
  const factDigest = computeDigest(JSON.parse(JSON.stringify(factPayload)));
  const fact: ReplanDispositionFact = {
    ...factPayload,
    digest: factDigest,
  };

  const factDir = replanFactDirectory(root, stageId);
  fs.mkdirSync(factDir, { recursive: true });
  const factFile = path.join(factDir, `${factDigest}.json`);
  const factRef = `.proofloop/runtime/replan/${stageId}/${factDigest}.json`;

  try {
    const existing = readNoFollowText(root, factFile);
    if (existing.ok) {
      if (canonicalJson(JSON.parse(existing.text)) !== canonicalJson(fact)) {
        fail('REPLAN.PERSIST_FAILED', `conflicting disposition fact already exists at ${factFile}`);
      }
    } else {
      writeOnce(factFile, fact);
    }
  } catch (error) {
    if (error instanceof ReplanEpochError) throw error;
    fail('REPLAN.PERSIST_FAILED', 'could not persist disposition fact: ' + (error instanceof Error ? error.message : String(error)));
  }

  return { fact, factRef, factDigest };
}

// ============================================================
// Current epoch readback (derived from the validated parent chain)
// ============================================================

export type ReplanCurrentEpoch =
  | {
      readonly kind: 'initial';
      readonly stage_id: string;
      /** Derived initial epoch digest over the canonical receipt tuple. */
      readonly epoch_digest: string;
      readonly spv: VNextSpvPassReceipt;
      readonly stagePlan: VNextStagePlanReceipt;
    }
  | {
      readonly kind: 'epoch';
      readonly stage_id: string;
      readonly epoch_digest: string;
      readonly epoch: ReplanEpochRefs;
      readonly spv: VNextSpvPassReceipt;
      readonly stagePlan: VNextStagePlanReceipt;
    };

export function replanEpochDirectory(root: string, stageId: string, epochDigest: string): string {
  return path.join(root, '.proofloop', 'receipts', 'plan', stageId, 'epochs', epochDigest);
}

/**
 * Read a file through the no-follow boundary (fd read, not path read).
 * Distinguishes a missing target from an unreadable/malformed one so the
 * callers can fail closed with the right code.
 */
function readNoFollowText(root: string, filePath: string): { ok: true; text: string } | { ok: false; missing: boolean } {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, missing: true };
    return { ok: false, missing: false };
  }
  if (!stat.isFile()) return { ok: false, missing: false };
  const opened = openNoFollowRead(root, filePath);
  if (!opened.ok) return { ok: false, missing: false };
  try {
    const buf = fs.readFileSync(opened.fd);
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { ok: false, missing: false };
  } finally {
    try { fs.closeSync(opened.fd); } catch { /* ignore close failure */ }
  }
}

function readEpochJson<T>(root: string, file: string, code: ReplanEpochError['code'], label: string): T {
  const read = readNoFollowText(root, file);
  if (!read.ok) {
    if (read.missing) fail(code, `${label} is missing at ${file}`);
    fail(code, `${label} cannot be read at ${file}`);
  }
  try { return JSON.parse(read.text) as T; }
  catch { fail(code, `${label} is not valid JSON at ${file}`); }
}

/**
 * Derive the current epoch from the validated parent chain. When no epoch
 * directory exists yet the canonical initial receipt path remains the
 * authority (legacy/initial regression). There is NEVER a mutable
 * `current.json` pointer (HP-021).
 */
export function readCurrentEpoch(root: string, stageId: string): ReplanCurrentEpoch {
  if (typeof stageId !== 'string' || !CANONICAL_STAGE_ID_RE.test(stageId)) {
    fail('REPLAN.EPOCH_INPUT_INVALID', 'stage_id has an invalid canonical Stage ID');
  }
  const epochsDir = canonicalPathWithinRoot(root, path.join('.proofloop', 'receipts', 'plan', stageId, 'epochs'));
  if (epochsDir === null) fail('REPLAN.ROOT_ESCAPE', 'epochs directory escapes the project root trust boundary');

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(epochsDir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      fail('REPLAN.EPOCH_INVALID', 'epochs directory cannot be inspected: ' + (error instanceof Error ? error.message : String(error)));
    }
    entries = [];
  }
  if (entries.length === 0) {
    let authority: { stagePlan: VNextStagePlanReceipt; spv: VNextSpvPassReceipt };
    try {
      authority = readVNextAdmissionAuthority(root, stageId);
    } catch (error) {
      fail(
        'REPLAN.EPOCH_NO_AUTHORITY',
        'no admission authority is available for the initial epoch: ' + (error instanceof Error ? error.message : String(error)),
      );
    }
    const { spv, stagePlan } = authority;
    const epochDigest = computeReplanEpochDigest({
      stage_id: stageId,
      parent_epoch_digest: '',
      disposition_digest: '',
      manifest_digest: spv.manifest_digest,
      plan_digest: spv.plan_digest,
      snapshot_digest: spv.snapshot_digest,
    });
    return { kind: 'initial', stage_id: stageId, epoch_digest: epochDigest, spv, stagePlan };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !SHA256_HEX_RE.test(entry.name)) {
      fail('REPLAN.EPOCH_INVALID', 'epochs directory contains a malformed entry: ' + entry.name);
    }
  }

  const byDigest = new Map<string, { refs: ReplanEpochRefs; spv: VNextSpvPassReceipt; stagePlan: VNextStagePlanReceipt }>();
  for (const entry of entries) {
    const dir = path.join(epochsDir, entry.name);
    // A directory that holds ONLY a fresh epoch-qualified SPV_PASS is a
    // PENDING epoch: the SPV seam runs before the Stage Plan seam. It is
    // skipped here and completed (epoch.json + STAGE_PLAN) by the Stage Plan
    // admission. Anything else without epoch refs is malformed (fail closed).
    const refsPath = path.join(dir, 'epoch.json');
    let refsStat: fs.Stats;
    try {
      refsStat = fs.lstatSync(refsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const spvPath = path.join(dir, 'vnext-spv-pass.json');
        try {
          const spvStat = fs.lstatSync(spvPath);
          if (spvStat.isFile()) continue; // pending epoch (fresh SPV only)
        } catch {
          /* fall through to fail closed */
        }
      }
      fail('REPLAN.EPOCH_INVALID', `epoch refs is missing at ${refsPath}`);
    }
    if (!refsStat.isFile()) {
      fail('REPLAN.EPOCH_INVALID', `epoch refs is not a file at ${refsPath}`);
    }
    const refs = validateReplanEpochRefs(readEpochJson<unknown>(root, refsPath, 'REPLAN.EPOCH_INVALID', 'epoch refs'), stageId);
    if (refs.stage_id !== stageId) {
      fail('REPLAN.EPOCH_INVALID', `epoch "${entry.name}" stage_id "${refs.stage_id}" does not match requested Stage "${stageId}"`);
    }
    const dispCanonical = canonicalPathWithinRoot(root, refs.disposition_ref);
    if (dispCanonical === null) {
      fail('REPLAN.ROOT_ESCAPE', `epoch "${entry.name}" disposition_ref escapes the root trust boundary: ${refs.disposition_ref}`);
    }
    const dispRel = path.relative(root, dispCanonical).split(path.sep).join('/');
    if (!dispRel.startsWith(`.proofloop/runtime/replan/${stageId}/`)) {
      fail('REPLAN.EPOCH_INVALID', `epoch "${entry.name}" disposition_ref must live under .proofloop/runtime/replan/${stageId}/: ${refs.disposition_ref}`);
    }
    if (refs.epoch_digest !== entry.name) {
      fail('REPLAN.EPOCH_INVALID', `epoch directory "${entry.name}" does not match its refs epoch_digest "${refs.epoch_digest}"`);
    }
    const spv = validateVNextSpvPassReceipt(
      readEpochJson<unknown>(root, path.join(dir, 'vnext-spv-pass.json'), 'REPLAN.EPOCH_INVALID', 'epoch SPV_PASS receipt'),
    );
    const stagePlan = validateVNextStagePlanReceipt(
      readEpochJson<unknown>(root, path.join(dir, 'vnext-stage-plan.json'), 'REPLAN.EPOCH_INVALID', 'epoch STAGE_PLAN receipt'),
    );
    if (
      spv.digest !== refs.spv_receipt_digest ||
      spv.stage_id !== refs.stage_id ||
      spv.manifest_digest !== refs.manifest_digest ||
      spv.plan_digest !== refs.plan_digest ||
      spv.snapshot_digest !== refs.snapshot_digest
    ) {
      fail('REPLAN.EPOCH_INVALID', `epoch "${entry.name}" SPV_PASS receipt does not match its epoch refs binding`);
    }
    if (
      stagePlan.digest !== refs.stage_plan_receipt_digest ||
      stagePlan.spv_receipt_digest !== spv.digest ||
      stagePlan.stage_id !== refs.stage_id ||
      stagePlan.manifest_digest !== refs.manifest_digest ||
      stagePlan.plan_digest !== refs.plan_digest ||
      stagePlan.snapshot_digest !== refs.snapshot_digest
    ) {
      fail('REPLAN.EPOCH_INVALID', `epoch "${entry.name}" STAGE_PLAN receipt does not match its epoch refs binding`);
    }
    byDigest.set(entry.name, { refs, spv, stagePlan });
  }

  // Parent chain: every non-empty parent must resolve either to a persisted
  // epoch or to the DERIVED initial epoch digest (the canonical initial
  // receipts are the chain root; they are never duplicated into an epoch
  // directory — legacy/initial regression). The tip is the epoch that no
  // other epoch references as parent. Exactly one tip is a valid linear
  // chain; anything else fails closed.
  let derivedInitialDigest: string | undefined;
  const initialEpochDigest = (): string => {
    if (derivedInitialDigest === undefined) {
      let authority: { spv: VNextSpvPassReceipt; stagePlan: VNextStagePlanReceipt };
      try {
        authority = readVNextAdmissionAuthority(root, stageId);
      } catch (error) {
        fail(
          'REPLAN.EPOCH_CHAIN_BROKEN',
          'epoch chain roots at the initial epoch but the canonical initial receipts cannot be verified: ' +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      if (authority.spv.stage_id !== stageId || authority.stagePlan.stage_id !== stageId) {
        fail('REPLAN.EPOCH_INVALID', `initial authority receipts do not match stage "${stageId}"`);
      }
      derivedInitialDigest = computeReplanEpochDigest({
        stage_id: stageId,
        parent_epoch_digest: '',
        disposition_digest: '',
        manifest_digest: authority.spv.manifest_digest,
        plan_digest: authority.spv.plan_digest,
        snapshot_digest: authority.spv.snapshot_digest,
      });
    }
    return derivedInitialDigest;
  };
  const referencedAsParent = new Set<string>();
  for (const digest of byDigest.keys()) {
    const parent = byDigest.get(digest)!.refs.parent_epoch_digest;
    if (parent === '') continue;
    if (byDigest.has(parent)) {
      referencedAsParent.add(parent);
      continue;
    }
    if (parent === initialEpochDigest()) {
      referencedAsParent.add(parent);
      continue;
    }
    fail('REPLAN.EPOCH_CHAIN_BROKEN', `epoch "${digest}" references a missing parent epoch "${parent}"`);
  }
  const tips = [...byDigest.keys()].filter((digest) => !referencedAsParent.has(digest));
  if (tips.length === 0) fail('REPLAN.EPOCH_CHAIN_BROKEN', 'epoch parent chain contains a cycle (no tip epoch)');
  if (tips.length > 1) fail('REPLAN.EPOCH_CHAIN_AMBIGUOUS', `epoch parent chain has ${tips.length} candidate tips; the current epoch is ambiguous`);

  const tip = tips[0];
  const visited = new Set<string>();
  let cursor: string | undefined = tip;
  while (cursor !== undefined) {
    const epoch = byDigest.get(cursor);
    if (epoch === undefined) fail('REPLAN.EPOCH_CHAIN_BROKEN', `epoch "${cursor}" is not persisted`);
    const parent: string = epoch.refs.parent_epoch_digest;
    if (parent === '') break;
    if (parent === initialEpochDigest()) break;
    if (parent === cursor || visited.has(parent)) {
      fail('REPLAN.EPOCH_CHAIN_BROKEN', `epoch parent chain contains a cycle at "${cursor}"`);
    }
    if (!byDigest.has(parent)) fail('REPLAN.EPOCH_CHAIN_BROKEN', `epoch "${cursor}" references a missing parent epoch "${parent}"`);
    visited.add(cursor);
    cursor = parent;
  }
  if (cursor !== undefined) visited.add(cursor);
  if (visited.size !== byDigest.size) {
    fail('REPLAN.EPOCH_ORPHAN', 'epoch parent chain does not cover every persisted epoch (orphan epoch)');
  }

  const current = byDigest.get(tip)!;
  return { kind: 'epoch', stage_id: stageId, epoch_digest: tip, epoch: current.refs, spv: current.spv, stagePlan: current.stagePlan };
}

// ============================================================
// Epoch-qualified authority persistence (append-only, write-once)
// ============================================================

export interface PersistReplanEpochAuthorityInput {
  readonly root: string;
  readonly stage_id: string;
  readonly epoch_digest: string;
  readonly parent_epoch_digest: string;
  readonly disposition_ref: string;
  readonly disposition_digest: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly snapshot_digest: string;
  readonly spv: VNextSpvPassReceipt;
  readonly stage_plan: VNextStagePlanReceipt;
}

export interface PersistReplanEpochAuthorityResult {
  readonly epoch_refs_path: string;
  readonly spv_receipt_path: string;
  readonly stage_plan_receipt_path: string;
  readonly epoch_refs: ReplanEpochRefs;
}

function writeOnce(target: string, value: unknown): void {
  const payload = JSON.stringify(value, null, 2) + '\n';
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
  } catch (error) {
    fail('REPLAN.PERSIST_FAILED', 'epoch authority file could not be written without overwrite: ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Persist the epoch-qualified authority append-only under
 * `.proofloop/receipts/plan/<stage>/epochs/<epoch_digest>/`. The existing
 * initial canonical receipt files are never touched (旧 Receipt 不覆盖). An
 * already-present epoch.json / Stage Plan fact fails closed; an already-present
 * fresh SPV is reused only when byte-identical. Partial writes are rolled back.
 */
export function persistReplanEpochAuthority(input: PersistReplanEpochAuthorityInput): PersistReplanEpochAuthorityResult {
  if (!isRecord(input)) fail('REPLAN.EPOCH_INPUT_INVALID', 'persist input must be an object');
  const epochRefs: ReplanEpochRefs = {
    schema_version: REPLAN_EPOCH_SCHEMA_VERSION,
    stage_id: input.stage_id,
    epoch_digest: input.epoch_digest,
    parent_epoch_digest: input.parent_epoch_digest,
    disposition_ref: input.disposition_ref,
    disposition_digest: input.disposition_digest,
    manifest_digest: input.manifest_digest,
    plan_digest: input.plan_digest,
    snapshot_digest: input.snapshot_digest,
    spv_receipt_digest: input.spv.digest,
    stage_plan_receipt_digest: input.stage_plan.digest,
  };
  validateReplanEpochRefs(epochRefs);
  validateVNextSpvPassReceipt(input.spv);
  validateVNextStagePlanReceipt(input.stage_plan);

  const directory = canonicalPathWithinRoot(input.root, replanEpochDirectory(input.root, input.stage_id, input.epoch_digest));
  if (directory === null) fail('REPLAN.ROOT_ESCAPE', 'epoch authority directory escapes the project root trust boundary');
  const epochRefsPath = path.join(directory, 'epoch.json');
  const spvPath = path.join(directory, 'vnext-spv-pass.json');
  const stagePlanPath = path.join(directory, 'vnext-stage-plan.json');

  for (const target of [epochRefsPath, stagePlanPath]) {
    try {
      fs.lstatSync(target);
      fail('REPLAN.EPOCH_ALREADY_ADMITTED', 'epoch authority target already exists (write-once): ' + target);
    } catch (error) {
      if (error instanceof ReplanEpochError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        fail('REPLAN.PERSIST_FAILED', 'epoch authority target cannot be inspected: ' + target);
      }
    }
  }

  // The fresh SPV may already be persisted by the independent SPV admission
  // seam; reuse it ONLY when byte-identical, otherwise fail closed.
  let spvAlreadyWritten = false;
  try {
    const existing = readNoFollowText(input.root, spvPath);
    if (!existing.ok) throw Object.assign(new Error('unreadable'), { code: 'ENOENT' });
    if (canonicalJson(JSON.parse(existing.text)) !== canonicalJson(input.spv)) {
      fail('REPLAN.EPOCH_ALREADY_ADMITTED', 'epoch SPV_PASS authority conflicts with the fresh SPV (write-once): ' + spvPath);
    }
    spvAlreadyWritten = true;
  } catch (error) {
    if (error instanceof ReplanEpochError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      fail('REPLAN.PERSIST_FAILED', 'epoch SPV_PASS authority cannot be inspected: ' + spvPath);
    }
  }

  fs.mkdirSync(directory, { recursive: true });
  const written: string[] = [];
  try {
    writeOnce(epochRefsPath, epochRefs);
    written.push(epochRefsPath);
    if (!spvAlreadyWritten) {
      writeOnce(spvPath, input.spv);
      written.push(spvPath);
    }
    writeOnce(stagePlanPath, input.stage_plan);
    written.push(stagePlanPath);
  } catch (error) {
    for (const target of written.reverse()) {
      try { fs.unlinkSync(target); } catch { /* best-effort rollback */ }
    }
    throw error;
  }
  return { epoch_refs_path: epochRefsPath, spv_receipt_path: spvPath, stage_plan_receipt_path: stagePlanPath, epoch_refs: epochRefs };
}

// ============================================================
// Shared replan admission checks (stage-plan seam and SPV seam)
// ============================================================

export interface ReplanAdmissionBindings {
  readonly stage_id: string;
  readonly parent_epoch_digest: string;
  readonly manifest_digest: string;
  readonly plan_digest: string;
  readonly snapshot_digest: string;
}

/**
 * Validate the disposition fact against the admission bindings and recompute
 * the impact set with the Runtime classifier. Returns the fact when every
 * declared binding matches and the recomputed disposition is identical to the
 * declared one (caller-forged derived sets fail closed, §8.8).
 */
export function verifyReplanAdmissionFact(
  root: string,
  factRef: string,
  factDigest: string,
  bindings: ReplanAdmissionBindings,
  requireManifestRef?: string,
): { fact: ReplanDispositionFact; recomputed: ReplanImpactDisposition } {
  const fact = readReplanDispositionFact(root, factRef, factDigest);
  if (fact.stage_id !== bindings.stage_id) {
    fail('REPLAN.FACT_INVALID', `disposition fact stage_id "${fact.stage_id}" does not match the request stage_id "${bindings.stage_id}"`);
  }
  const factPrevManifest = canonicalPathWithinRoot(root, fact.previous_manifest_ref);
  if (factPrevManifest === null) fail('REPLAN.ROOT_ESCAPE', 'disposition fact previous_manifest_ref escapes the project root trust boundary');
  const factManifest = canonicalPathWithinRoot(root, fact.manifest_ref);
  if (factManifest === null) fail('REPLAN.ROOT_ESCAPE', 'disposition fact manifest_ref escapes the project root trust boundary');

  if (requireManifestRef !== undefined) {
    const expected = canonicalPathWithinRoot(root, requireManifestRef);
    if (expected === null || factManifest !== expected) {
      fail('REPLAN.FACT_INVALID', 'disposition fact manifest_ref does not match the admitted Manifest path');
    }
  }
  if (fact.disposition.impact_scope === 'unresolved') {
    fail('REPLAN.FACT_INVALID', `disposition fact is unresolved (${fact.disposition.unresolved_reason ?? 'unknown'}); replan admission is not authorized`);
  }
  if (fact.disposition.parent_epoch_digest !== bindings.parent_epoch_digest) {
    fail('REPLAN.FACT_INVALID', 'disposition fact parent_epoch_digest does not match the request declaration');
  }

  // Bind previous snapshot to current epoch authority facts
  const current = readCurrentEpoch(root, bindings.stage_id);
  if (current.epoch_digest !== bindings.parent_epoch_digest) {
    fail('REPLAN.FACT_INVALID', `disposition parent_epoch_digest "${bindings.parent_epoch_digest}" does not match current epoch "${current.epoch_digest}"`);
  }
  const prevManifestDigest = current.kind === 'initial' ? current.spv.manifest_digest : current.epoch.manifest_digest;
  const prevPlanDigest = current.kind === 'initial' ? current.spv.plan_digest : current.epoch.plan_digest;
  const prevSnapshotDigest = current.kind === 'initial' ? current.spv.snapshot_digest : current.epoch.snapshot_digest;

  if (fact.previous_snapshot.stage_id !== bindings.stage_id) {
    fail('REPLAN.FACT_INVALID', `fact.previous_snapshot.stage_id "${fact.previous_snapshot.stage_id}" does not match stage "${bindings.stage_id}"`);
  }
  if (fact.previous_snapshot.manifest_digest !== prevManifestDigest) {
    fail('REPLAN.FACT_INVALID', `fact.previous_snapshot.manifest_digest "${fact.previous_snapshot.manifest_digest}" does not match current epoch manifest_digest "${prevManifestDigest}"`);
  }
  if (fact.previous_snapshot.plan_digest !== prevPlanDigest) {
    fail('REPLAN.FACT_INVALID', `fact.previous_snapshot.plan_digest "${fact.previous_snapshot.plan_digest}" does not match current epoch plan_digest "${prevPlanDigest}"`);
  }
  if (fact.previous_snapshot.snapshot_digest !== prevSnapshotDigest) {
    fail('REPLAN.FACT_INVALID', `fact.previous_snapshot.snapshot_digest "${fact.previous_snapshot.snapshot_digest}" does not match current epoch snapshot_digest "${prevSnapshotDigest}"`);
  }

  if (
    fact.snapshot.stage_id !== bindings.stage_id ||
    fact.snapshot.manifest_digest !== bindings.manifest_digest ||
    fact.snapshot.plan_digest !== bindings.plan_digest ||
    fact.snapshot.snapshot_digest !== bindings.snapshot_digest
  ) {
    fail('REPLAN.FACT_INVALID', 'disposition fact candidate snapshot bindings do not match the request');
  }
  if (
    fact.disposition.stage_id !== bindings.stage_id ||
    fact.disposition.manifest_digest !== bindings.manifest_digest ||
    fact.disposition.plan_digest !== bindings.plan_digest ||
    fact.disposition.snapshot_digest !== bindings.snapshot_digest
  ) {
    fail('REPLAN.FACT_INVALID', 'disposition fact disposition bindings do not match the request');
  }

  // 1. Reconstruct and verify candidate snapshot from real candidate Manifest + tasks.md
  let realCandManifest: VNextManifest;
  try {
    realCandManifest = readVNextManifest(root, factManifest);
  } catch (error) {
    fail('REPLAN.FACT_INVALID', `cannot read candidate Manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candManifestDigest = computeDigest(realCandManifest);
  if (candManifestDigest !== bindings.manifest_digest) {
    fail('REPLAN.FACT_INVALID', `candidate Manifest digest "${candManifestDigest}" does not match request "${bindings.manifest_digest}"`);
  }

  let candPlanContent: string | undefined;
  try {
    const candPlanCanonical = canonicalPathWithinRoot(root, realCandManifest.plan.ref);
    if (candPlanCanonical && fs.existsSync(candPlanCanonical)) {
      candPlanContent = fs.readFileSync(candPlanCanonical, 'utf8');
    }
  } catch {
    // best-effort
  }
  const realCandidateSnapshot = manifestToReplanPlanSnapshot(realCandManifest, bindings.snapshot_digest, candPlanContent);

  // 2. Reconstruct and verify previous snapshot from real previous Manifest + tasks.md
  let realPrevManifest: VNextManifest | null = null;
  let prevPlanContent: string | undefined;

  if (fs.existsSync(factPrevManifest)) {
    try {
      const parsed = readVNextManifest(root, factPrevManifest);
      if (computeDigest(parsed) === prevManifestDigest && parsed.stage_id === bindings.stage_id) {
        realPrevManifest = parsed;
        const prevPlanCanonical = canonicalPathWithinRoot(root, parsed.plan.ref);
        if (prevPlanCanonical && fs.existsSync(prevPlanCanonical)) {
          prevPlanContent = fs.readFileSync(prevPlanCanonical, 'utf8');
        }
      }
    } catch {
      // try git
    }
  }

  if (realPrevManifest === null) {
    try {
      const gitRoot = resolveGitRoot(root);
      const normManifest = path.posix.normalize(fact.previous_manifest_ref).replace(/^\.\//, '');
      const gitManifestContent = execFileSync(
        'git',
        ['-C', gitRoot, 'show', `${prevSnapshotDigest}:${normManifest}`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const parsed = JSON.parse(gitManifestContent);
      if (computeDigest(parsed) === prevManifestDigest && parsed.stage_id === bindings.stage_id) {
        realPrevManifest = parsed as VNextManifest;
        try {
          const normPlan = path.posix.normalize(parsed.plan.ref).replace(/^\.\//, '');
          prevPlanContent = execFileSync(
            'git',
            ['-C', gitRoot, 'show', `${prevSnapshotDigest}:${normPlan}`],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          );
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  let realPreviousSnapshot: ReplanPlanSnapshotInput;
  if (realPrevManifest !== null) {
    realPreviousSnapshot = manifestToReplanPlanSnapshot(realPrevManifest, prevSnapshotDigest, prevPlanContent);
    if (canonicalJson(realPreviousSnapshot) !== canonicalJson(fact.previous_snapshot)) {
      throw new ReplanEpochError(
        'REPLAN.FACT_INVALID',
        'disposition fact previous_snapshot does not match real previous plan contract snapshot',
      );
    }
  } else {
    // If previous manifest cannot be reconstructed from disk/git (e.g. untracked .proofloop in gitignore),
    // verify that fact.previous_snapshot matches the authority's bound previous digests.
    if (
      fact.previous_snapshot.manifest_digest !== prevManifestDigest ||
      fact.previous_snapshot.plan_digest !== prevPlanDigest ||
      fact.previous_snapshot.stage_id !== bindings.stage_id ||
      fact.previous_snapshot.snapshot_digest !== prevSnapshotDigest
    ) {
      throw new ReplanEpochError(
        'REPLAN.FACT_INVALID',
        'disposition fact previous_snapshot digests do not match the current epoch authority',
      );
    }
    realPreviousSnapshot = fact.previous_snapshot;
  }

  // 3. Reject forged previous_snapshot or candidate snapshot
  const serializedRealPrev = canonicalJson(JSON.parse(JSON.stringify(realPreviousSnapshot)));
  const serializedFactPrev = canonicalJson(JSON.parse(JSON.stringify(fact.previous_snapshot)));
  if (serializedRealPrev !== serializedFactPrev) {
    fail('REPLAN.FACT_INVALID', 'disposition fact previous_snapshot does not match real previous plan snapshot projection (forged task contract or closure detected)');
  }

  const serializedRealCand = canonicalJson(JSON.parse(JSON.stringify(realCandidateSnapshot)));
  const serializedFactCand = canonicalJson(JSON.parse(JSON.stringify(fact.snapshot)));
  if (serializedRealCand !== serializedFactCand) {
    fail('REPLAN.FACT_INVALID', 'disposition fact snapshot does not match real candidate plan snapshot projection (forged task contract or closure detected)');
  }

  // Derive completed_task_ids from TASK_COMPLETE receipt chain of previous epoch
  const derived = deriveCompletedTaskIdsFromReceipts(
    root,
    bindings.stage_id,
    prevManifestDigest,
    prevPlanDigest,
    realPreviousSnapshot.slices,
    prevSnapshotDigest,
  );
  if (!derived.ok) {
    fail('REPLAN.FACT_INVALID', `Worker Receipt chain error: ${derived.message}`);
  }
  if (derived.task_ids.join('\n') !== [...fact.completed_task_ids].sort().join('\n')) {
    fail(
      'REPLAN.FACT_INVALID',
      `disposition completed_task_ids do not match the Receipt-derived completion fact (declared [${[...fact.completed_task_ids].join(', ')}], Runtime-derived [${derived.task_ids.join(', ')}])`,
    );
  }

  let recomputed: ReplanImpactDisposition;
  try {
    recomputed = classifyReplanImpact({
      previous: realPreviousSnapshot,
      candidate: realCandidateSnapshot,
      parent_epoch_digest: bindings.parent_epoch_digest,
      completed_task_ids: derived.task_ids,
    });
  } catch (error) {
    fail('REPLAN.FACT_INVALID', 'impact recomputation rejected the disposition fact: ' + (error instanceof ReplanImpactError ? error.message : String(error)));
  }
  // Serialized-form comparison: optional members (unresolved_reason)
  // serialize away, so the persisted fact and the recomputed disposition are
  // compared on their JSON content, never on in-memory key presence.
  const serializedRecomputed = canonicalJson(JSON.parse(JSON.stringify(recomputed)));
  const serializedDeclared = canonicalJson(JSON.parse(JSON.stringify(fact.disposition)));
  if (serializedRecomputed !== serializedDeclared) {
    fail(
      'REPLAN.FACT_INVALID',
      'Runtime recomputed a different impact set than the disposition fact declares; caller-forged derived sets are rejected',
    );
  }
  return { fact, recomputed };
}