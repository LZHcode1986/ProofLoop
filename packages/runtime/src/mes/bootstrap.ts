/**
 * @proofloop/runtime — one-time MES bootstrap seed (S01-B-T02).
 *
 * Bridges the Git-tracked accepted Plan / bootstrap facts into the MES
 * persistence seam and establishes the minimal operational facts the first
 * `NORMAL READ STATUS` needs (mes.md Pre-MES bootstrap section):
 *
 *   - `seedMesBootstrap` accepts ONLY canonical Authority refs, an accepted
 *     Git Plan ref and the baseline/current Git basis, plus the Brain-supplied
 *     first-`NORMAL` status tuple (`scope` / `phase` / `required_skill` and
 *     applicable non-zero anomaly counters). It validates everything
 *     fail-closed, persists the accepted Plan binding + Git basis into the
 *     MES snapshot store, and writes the root-bound ONE seed record carrying
 *     the status tuple, durably re-readable before the next `READ STATUS`;
 *   - the FIRST valid seed on an empty pre-seed store succeeds without any
 *     pre-seed MES status / work identity / resultRef (PO-S01-B-03);
 *   - the SAME seed is idempotent (no rewrite, no duplicate facts); a
 *     CONFLICTING seed or a second bootstrap fails closed, and the
 *     completion flag (`isMesSeeded`) permanently closes the
 *     `PRE_MES_BOOTSTRAP` branch for later Brain dispatch (PO-S01-B-04);
 *   - the Brain-supplied status tuple is explicitly persisted and re-readable,
 *     so the next `NORMAL READ STATUS` needs no inference (PO-S01-B-05).
 *
 * No bootstrap Receipt / Manifest / Gate / second state machine / result
 * store is created (STATIC-14): the seed record is a root-bound JSON under
 * the SAME `.proofloop/mes` directory as the MES snapshot, written with the
 * existing temp+rename atomic pattern and read through the root-bound
 * no-follow boundary.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { isSha256Hex, VNEXT_REF_GRAMMAR_RE, CANONICAL_STAGE_ID_RE } from '@proofloop/kernel';
import { canonicalStringify } from '../cli/proofloop-common';
import { canonicalPathWithinRoot, readRootBoundFile } from '../path-guard';
import { MES_SCHEMA_VERSION } from './types';
import type { MesFactEnvelope, MesGitBasis } from './types';
import { MesSnapshotStore } from './store';
import { isCanonicalRootRelativeRef, isCanonicalAuthorityRef } from './binding';

/** Root-relative seed record location (same MES dir as the snapshot). */
export const MES_SEED_REL = path.join('.proofloop', 'mes', 'seed.json');

/**
 * Closed sparse anomaly counter keys for the status tuple
 * (mes.md "Sparse anomaly counters").
 */
export const MES_ANOMALY_COUNTERS = [
  'replan',
  'blocked',
  'repair',
  'recovery',
  'human_required',
  'finding',
  'cleanup',
] as const;
export type MesAnomalyCounterKey = (typeof MES_ANOMALY_COUNTERS)[number];

/**
 * Closed per-Stage phase set for the status tuple
 * (contracts.md §5.1): the phase is VALIDATED, never derived or migrated
 * (HP-001 / STATIC-05).
 */
export const MES_STATUS_PHASES = [
  'PROPOSE',
  'PLANNING',
  'EXECUTE',
  'REVIEW',
  'STAGE_ACCEPTED',
] as const;
export type MesStatusPhase = (typeof MES_STATUS_PHASES)[number];

/**
 * Brain-supplied first-`NORMAL` status tuple. `scope` is the canonical Stage
 * ID (`^S\d+$`); `counters` uses the sparse anomaly counter keys only
 * (zero values are legal — sparse projection hides them).
 */
export interface MesStatusTuple {
  readonly scope: string;
  readonly phase: string;
  readonly required_skill: string;
  readonly counters?: Readonly<Partial<Record<MesAnomalyCounterKey, number>>>;
}

/** Seed input: canonical Authority refs + accepted Git Plan ref + Git basis + status tuple. */
export interface MesBootstrapSeedInput {
  readonly authority_refs: string[];
  readonly accepted_plan_ref: string;
  readonly plan_digest?: string;
  /**
   * Optional dedicated planning binding detail carried durably by the seed
   * record and re-exposed by the detail projection (S02-B-T02): the
   * verified candidate Plan ref (pre-accept) and the planning verification
   * result ref of the PLAN_READY fact that produced the acceptance.
   */
  readonly candidate_plan_ref?: string;
  readonly planning_verification_result_ref?: string;
  readonly git_basis: MesGitBasis;
  readonly status: MesStatusTuple;
}

/** Durable root-bound seed record persisted by `seedMesBootstrap`. */
export interface MesSeedRecord {
  readonly schema_version: typeof MES_SCHEMA_VERSION;
  readonly seed_id: string;
  readonly authority_refs: string[];
  readonly accepted_plan_ref: string;
  readonly plan_digest?: string;
  readonly candidate_plan_ref?: string;
  readonly planning_verification_result_ref?: string;
  readonly git_basis: MesGitBasis;
  readonly status: MesStatusTuple;
}

/** Closed seed failure codes (fail closed, never partial). */
export type MesBootstrapErrorCode =
  | 'escape'
  | 'already-seeded'
  | 'conflict'
  | 'invalid-seed'
  | 'corrupt-seed'
  | 'unreadable'
  | 'write-failed';

/** Bounded seed error raised on any fail-closed condition. */
export class MesBootstrapError extends Error {
  public readonly code: MesBootstrapErrorCode;

  constructor(code: MesBootstrapErrorCode, message: string) {
    super(message);
    this.name = 'MesBootstrapError';
    this.code = code;
  }
}

function seedFail(code: MesBootstrapErrorCode, message: string): never {
  throw new MesBootstrapError(code, message);
}

/** True when `value` is a non-negative integer (counter values). */
function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Validate the canonical Authority refs (fail closed on malformed input). */
function expectAuthorityRefs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    seedFail('invalid-seed', 'authority_refs must be a non-empty array');
  }
  for (const ref of value) {
    if (!isCanonicalAuthorityRef(ref)) {
      seedFail('invalid-seed', `invalid canonical Authority ref (root-relative path required): ${String(ref)}`);
    }
  }
  return value as string[];
}

/** Validate the accepted Git Plan ref + optional digest (fail closed). */
function expectPlanRef(accepted_plan_ref: string, plan_digest: unknown): void {
  if (typeof accepted_plan_ref !== 'string' || accepted_plan_ref.length === 0) {
    seedFail('invalid-seed', 'accepted_plan_ref must be a non-empty root-relative ref');
  }
  if (typeof accepted_plan_ref === 'string' && !isCanonicalRootRelativeRef(accepted_plan_ref)) {
    seedFail('invalid-seed', 'accepted_plan_ref must be a canonical root-relative Plan ref (no absolute path, no .., no backslash, no empty segment)');
  }
  if (plan_digest !== undefined && !isSha256Hex(plan_digest)) {
    seedFail('invalid-seed', 'plan_digest must be a 64-char lowercase hex SHA-256 digest');
  }
}

/** Closed fields a git_basis object may carry (unknown fails closed). */
const GIT_BASIS_KNOWN_FIELDS = ['head', 'branch', 'worktree'] as const;

/** Validate the baseline/current Git basis (fail closed on unknown fields). */
function expectGitBasis(value: unknown, code: MesBootstrapErrorCode = 'invalid-seed'): MesGitBasis {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    seedFail(code, 'git_basis must be an object with head/branch/worktree');
  }
  const basis = value as Record<string, unknown>;
  for (const key of Object.keys(basis)) {
    if (!(GIT_BASIS_KNOWN_FIELDS as readonly string[]).includes(key)) {
      seedFail(code, `git_basis has unknown field "${key}"`);
    }
  }
  for (const key of ['head', 'branch', 'worktree'] as const) {
    if (typeof basis[key] !== 'string' || (basis[key] as string).length === 0) {
      seedFail(code, `git_basis.${key} must be a non-empty string`);
    }
  }
  return { head: basis.head as string, branch: basis.branch as string, worktree: basis.worktree as string };
}

/** Closed fields a status tuple may carry (unknown fails closed). */
const STATUS_KNOWN_FIELDS = ['scope', 'phase', 'required_skill', 'counters'] as const;

/** Validate the Brain-supplied status tuple (fail closed on unknown fields). */
function expectStatusTuple(value: unknown, code: MesBootstrapErrorCode = 'invalid-seed'): MesStatusTuple {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    seedFail(code, 'status must be an object with scope/phase/required_skill');
  }
  const status = value as Record<string, unknown>;
  for (const key of Object.keys(status)) {
    if (!(STATUS_KNOWN_FIELDS as readonly string[]).includes(key)) {
      seedFail(code, `status has unknown field "${key}"`);
    }
  }
  if (typeof status.scope !== 'string' || !CANONICAL_STAGE_ID_RE.test(status.scope)) {
    seedFail(code, `status.scope must match /^S\\d+$/, got ${JSON.stringify(status.scope)}`);
  }
  if (
    typeof status.phase !== 'string' ||
    !(MES_STATUS_PHASES as readonly string[]).includes(status.phase)
  ) {
    seedFail(
      code,
      `status.phase must be one of the closed per-stage phase set: ${MES_STATUS_PHASES.join(' / ')} (got ${JSON.stringify(status.phase)})`,
    );
  }
  if (typeof status.required_skill !== 'string' || status.required_skill.length === 0) {
    seedFail(code, 'status.required_skill must be a non-empty string');
  }
  if (status.counters !== undefined) {
    if (typeof status.counters !== 'object' || status.counters === null || Array.isArray(status.counters)) {
      seedFail(code, 'status.counters must be an object');
    }
    for (const [key, val] of Object.entries(status.counters as Record<string, unknown>)) {
      if (!(MES_ANOMALY_COUNTERS as readonly string[]).includes(key)) {
        seedFail(code, `unknown status counter "${key}"`);
      }
      if (!isNonNegativeInt(val)) {
        seedFail(code, `status counter ${key} must be a non-negative integer`);
      }
    }
  }
  return status as unknown as MesStatusTuple;
}

/** Deterministic fingerprint of the seed content (for idempotency/conflict). */
function seedFingerprint(input: MesBootstrapSeedInput): string {
  return canonicalStringify({
    authority_refs: input.authority_refs,
    accepted_plan_ref: input.accepted_plan_ref,
    plan_digest: input.plan_digest,
    candidate_plan_ref: input.candidate_plan_ref,
    planning_verification_result_ref: input.planning_verification_result_ref,
    git_basis: input.git_basis,
    status: input.status,
  });
}

/** Closed top-level fields a seed input may carry (unknown fails closed). */
const SEED_INPUT_KNOWN_FIELDS = [
  'authority_refs',
  'accepted_plan_ref',
  'plan_digest',
  'candidate_plan_ref',
  'planning_verification_result_ref',
  'git_basis',
  'status',
] as const;

/** Closed top-level fields a persisted seed record may carry. */
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


/**
 * Validate the optional planning-binding detail the seed can carry durably
 * (S02-B-T02): `candidate_plan_ref` must be a canonical root-relative Plan
 * ref; `planning_verification_result_ref` a non-empty string. Unknown /
 * malformed values fail closed with the given code.
 */
function expectPlanningDetailRefs(
  value: Record<string, unknown>,
  code: MesBootstrapErrorCode,
): { candidate_plan_ref?: string; planning_verification_result_ref?: string } {
  const candidate_plan_ref = value.candidate_plan_ref;
  if (candidate_plan_ref !== undefined) {
    if (typeof candidate_plan_ref !== 'string' || candidate_plan_ref.length === 0) {
      seedFail(code, 'candidate_plan_ref must be a non-empty root-relative Plan ref');
    }
    if (!isCanonicalRootRelativeRef(candidate_plan_ref)) {
      seedFail(
        code,
        'candidate_plan_ref must be a canonical root-relative Plan ref (no absolute path, no .., no backslash, no empty segment)',
      );
    }
  }
  const planning_verification_result_ref = value.planning_verification_result_ref;
  if (planning_verification_result_ref !== undefined) {
    if (
      typeof planning_verification_result_ref !== 'string' ||
      planning_verification_result_ref.length === 0
    ) {
      seedFail(code, 'planning_verification_result_ref must be a non-empty string');
    }
  }
  return {
    ...(candidate_plan_ref !== undefined ? { candidate_plan_ref } : {}),
    ...(planning_verification_result_ref !== undefined
      ? { planning_verification_result_ref }
      : {}),
  };
}
/** Validate the seed input fully (fail closed, never partial). */
function validateSeedInput(value: unknown): MesBootstrapSeedInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    seedFail('invalid-seed', 'seed input must be an object');
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(SEED_INPUT_KNOWN_FIELDS as readonly string[]).includes(key)) {
      seedFail('invalid-seed', `seed input has unknown field "${key}"`);
    }
  }
  const authority_refs = expectAuthorityRefs(input.authority_refs);
  expectPlanRef(input.accepted_plan_ref as string, input.plan_digest);
  if (typeof input.accepted_plan_ref !== 'string') {
    seedFail('invalid-seed', 'accepted_plan_ref must be a string');
  }
  const accepted_plan_ref = input.accepted_plan_ref as string;
  const git_basis = expectGitBasis(input.git_basis);
  const status = expectStatusTuple(input.status);
  const planningDetail = expectPlanningDetailRefs(input, 'invalid-seed');
  const out: MesBootstrapSeedInput = {
    authority_refs,
    accepted_plan_ref,
    git_basis,
    status,
    ...(input.plan_digest !== undefined ? { plan_digest: input.plan_digest as string } : {}),
    ...(planningDetail.candidate_plan_ref !== undefined ? { candidate_plan_ref: planningDetail.candidate_plan_ref } : {}),
    ...(planningDetail.planning_verification_result_ref !== undefined
      ? { planning_verification_result_ref: planningDetail.planning_verification_result_ref }
      : {}),
  };
  return out;
}

/** Read + validate the seed record structure (fail closed on corruption). */
function parseSeedRecord(raw: string, source: string): MesSeedRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    seedFail('corrupt-seed', `MES seed record at ${source} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    seedFail('corrupt-seed', 'MES seed record must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(SEED_RECORD_KNOWN_FIELDS as readonly string[]).includes(key)) {
      seedFail('corrupt-seed', `MES seed record has unknown field "${key}"`);
    }
  }
  if (obj.schema_version !== MES_SCHEMA_VERSION) {
    seedFail('corrupt-seed', `MES seed record schema_version must be ${MES_SCHEMA_VERSION}`);
  }
  if (typeof obj.seed_id !== 'string' || obj.seed_id.length === 0) {
    seedFail('corrupt-seed', 'MES seed record seed_id must be a non-empty string');
  }
  // Reuse the same fail-closed validators as the seed input.
  const authority_refs = expectAuthorityRefs(obj.authority_refs);
  expectPlanRef(obj.accepted_plan_ref as string, obj.plan_digest);
  if (typeof obj.accepted_plan_ref !== 'string') {
    seedFail('corrupt-seed', 'MES seed record accepted_plan_ref must be a string');
  }
  const git_basis = expectGitBasis(obj.git_basis, 'corrupt-seed');
  const status = expectStatusTuple(obj.status, 'corrupt-seed');
  const planningDetail = expectPlanningDetailRefs(obj, 'corrupt-seed');
  const record: MesSeedRecord = {
    schema_version: MES_SCHEMA_VERSION,
    seed_id: obj.seed_id as string,
    authority_refs,
    accepted_plan_ref: obj.accepted_plan_ref as string,
    git_basis,
    status,
    ...(obj.plan_digest !== undefined ? { plan_digest: obj.plan_digest as string } : {}),
    ...(planningDetail.candidate_plan_ref !== undefined ? { candidate_plan_ref: planningDetail.candidate_plan_ref } : {}),
    ...(planningDetail.planning_verification_result_ref !== undefined
      ? { planning_verification_result_ref: planningDetail.planning_verification_result_ref }
      : {}),
  };
  return record;

}
/** Structurally validate an existing persisted record (fail closed). */
function validateRecord(record: unknown): MesSeedRecord {
  return parseSeedRecord(canonicalStringify(record), 'memory');
}

/**
 * Probe the raw seed path component-by-component without following links.
 * A whole-path lstat can report ENOENT for a dangling final or intermediate
 * symlink, which must remain present-invalid rather than becoming `null`.
 */
function probeSeedAbsence(
  root: string,
  rel: string,
): { absent: boolean; symlinkAt?: string; reason?: string } {
  const parts = rel.split(path.sep).filter((part) => part.length > 0 && part !== '.');
  let current = root;
  for (const part of parts) {
    const next = path.join(current, part);
    let lst: fs.Stats;
    try {
      lst = fs.lstatSync(next);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { absent: true };
      return { absent: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (lst.isSymbolicLink()) return { absent: false, symlinkAt: next };
    current = next;
  }
  return { absent: false, reason: 'seed path exists during absence probe' };
}

/** Reject any present seed path before an atomic seed write can replace it. */
function assertSeedPathAvailableForWrite(root: string): void {
  const probe = probeSeedAbsence(path.resolve(root), MES_SEED_REL);
  if (probe.absent) return;
  if (probe.symlinkAt !== undefined) {
    seedFail(
      'escape',
      `MES seed record path "${MES_SEED_REL}" contains a symlink at "${probe.symlinkAt}" — a symlinked seed is never writable`,
    );
  }
  seedFail('unreadable', `cannot confirm MES seed record absence: ${probe.reason ?? 'unknown'}`);
}

/**
 * Read the persisted root-bound seed record.
 *
 * @returns the validated record, or `null` when the store has not been
 * seeded yet. Any present-but-invalid state (escape / symlink / corrupt /
 * unknown shape) fails closed — never a partial record.
 */
export function readMesSeedRecord(root: string): MesSeedRecord | null {
  const canonical = canonicalPathWithinRoot(path.resolve(root), MES_SEED_REL);
  if (canonical === null) {
    seedFail('escape', `MES seed record path "${MES_SEED_REL}" escapes the trust root`);
  }
  try {
    fs.lstatSync(canonical!);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const probe = probeSeedAbsence(path.resolve(root), MES_SEED_REL);
      if (!probe.absent) {
        if (probe.symlinkAt !== undefined) {
          seedFail(
            'escape',
            `MES seed record path "${MES_SEED_REL}" contains a symlink at "${probe.symlinkAt}" — a symlinked seed is never a missing record`,
          );
        }
        seedFail('unreadable', `cannot confirm MES seed record absence: ${probe.reason ?? 'unknown'}`);
      }
      return null;
    }
    seedFail('unreadable', `cannot stat MES seed record: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: string;
  try {
    raw = readRootBoundFile(root, MES_SEED_REL).content;
  } catch (err) {
    seedFail('unreadable', `cannot read MES seed record: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseSeedRecord(raw, MES_SEED_REL);
}

/**
 * True once the store has been seeded — this permanently closes the
 * `PRE_MES_BOOTSTRAP` branch for subsequent Brain dispatch.
 *
 * Seed completion requires BOTH a valid seed record AND every expected
 * plan_binding + git seed fact with canonical matching values. Additional
 * schema-valid operational facts are permitted and do not unset completion.
 * Missing or mismatched expected facts fail closed; corrupt records still
 * fail closed rather than guessing.
 */
export function isMesSeeded(root: string): boolean {
  const record = readMesSeedRecord(root);
  if (record === null) return false;
  return snapshotMatchesExpected(root, seedRecordToInput(record));
}

/** Reconstruct the seed input from a persisted seed record. */
function seedRecordToInput(record: MesSeedRecord): MesBootstrapSeedInput {
  return {
    authority_refs: record.authority_refs,
    accepted_plan_ref: record.accepted_plan_ref,
    git_basis: record.git_basis,
    status: record.status,
    ...(record.plan_digest !== undefined ? { plan_digest: record.plan_digest } : {}),
    ...(record.candidate_plan_ref !== undefined ? { candidate_plan_ref: record.candidate_plan_ref } : {}),
    ...(record.planning_verification_result_ref !== undefined
      ? { planning_verification_result_ref: record.planning_verification_result_ref }
      : {}),
  };
}

/**
 * Seed completion requires both a valid seed record and the complete
 * canonical expected plan_binding + git seed facts. Additional schema-valid
 * operational facts may coexist without changing the seeded state. Missing or
 * mismatched expected facts remain fail-closed; corrupt records/snapshots
 * still fail closed rather than guessing.
 */
function snapshotMatchesExpected(root: string, validated: MesBootstrapSeedInput): boolean {
  const store = new MesSnapshotStore(root);
  const actual = store.read();
  const expected = buildSeedFacts(validated);
  return expected.every((expectedFact) => {
    const matches = actual.filter((fact) => fact.fact_id === expectedFact.fact_id);
    return matches.length === 1 && canonicalStringify(matches[0]) === canonicalStringify(expectedFact);
  });
}

/** Atomic root-bound write of the seed record (temp + fsync + rename). */
function writeSeedRecord(root: string, record: MesSeedRecord): void {
  // Re-check the raw path immediately before mkdir/rename so a dangling
  // final or intermediate link cannot be replaced through its target.
  assertSeedPathAvailableForWrite(root);
  const canonical = canonicalPathWithinRoot(path.resolve(root), MES_SEED_REL);
  if (canonical === null) {
    seedFail('escape', `MES seed record path "${MES_SEED_REL}" escapes the trust root`);
  }
  const dir = path.dirname(canonical!);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    seedFail('write-failed', `cannot create seed directory: ${err instanceof Error ? err.message : String(err)}`);
  }
  const content = canonicalStringify(record);
  const tmp = path.join(dir, `.seed.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, canonical!);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    seedFail('write-failed', `cannot atomically persist MES seed record: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * One-time bootstrap seed operation.
 *
 * Accepts ONLY canonical Authority refs, an accepted Git Plan ref
 * (optionally with digest) and the baseline/current Git basis, plus the
 * Brain-supplied first-`NORMAL` status tuple. On an empty pre-seed store it
 * persists the root-bound seed record and writes the accepted Plan binding +
 * Git basis facts into the MES snapshot store. The SAME seed is idempotent
 * (returns the existing record, nothing re-written), while a CONFLICTING
 * seed or any re-seed attempt after completion fails closed.
 *
 * Atomicity (CV-S01-B-04): the seed record is persisted FIRST; only then
 * are the snapshot facts written. A seed-record write failure leaves the
 * snapshot untouched (clean failure, retryable). A snapshot write failure
 * rolls back by removing the freshly written seed record, so no partial
 * bootstrap state survives and the next attempt can recover cleanly.
 *
 * @returns the persisted seed record.
 * @throws {MesBootstrapError} on any fail-closed condition.
 */
export function seedMesBootstrap(root: string, input: unknown): MesSeedRecord {
  if (typeof root !== 'string' || root.length === 0) {
    seedFail('escape', 'store root must be a non-empty path');
  }
  const validated = validateSeedInput(input);

  // A persisted seed record decides idempotency vs conflict:
  // same fingerprint -> idempotent; different -> conflicting seed fails.
  const existing = readMesSeedRecord(root);
  if (existing !== null) {
    const existingInput = seedRecordToInput(existing);
    if (seedFingerprint(existingInput) === seedFingerprint(validated)) {
      const store = new MesSnapshotStore(root);
      // Idempotent: same seed. If any expected seed fact is missing or
      // mismatched, replace only the seed-owned fact IDs and preserve every
      // additional validated operational fact already in the snapshot.
      if (!snapshotMatchesExpected(root, validated)) {
        const expectedFacts = buildSeedFacts(validated);
        const expectedFactIds = new Set(expectedFacts.map((fact) => fact.fact_id));
        const existingFacts = store.read();
        store.write([
          ...expectedFacts,
          ...existingFacts.filter((fact) => !expectedFactIds.has(fact.fact_id)),
        ]);
      }
      return existing;
    }
    seedFail('conflict', 'conflicting seed: this store is already seeded with a different bootstrap seed');
  }

  // Empty pre-seed path: the snapshot store must be empty too (a store with
  // facts but no seed record is an inconsistent pre-seed state).
  const store = new MesSnapshotStore(root);
  const facts = store.read();
  if (facts.length > 0) {
    seedFail('already-seeded', 'MES snapshot store already holds facts; refusing a second bootstrap seed');
  }

  const record: MesSeedRecord = {
    schema_version: MES_SCHEMA_VERSION,
    seed_id: crypto.randomBytes(12).toString('hex'),
    authority_refs: validated.authority_refs,
    accepted_plan_ref: validated.accepted_plan_ref,
    git_basis: validated.git_basis,
    status: validated.status,
    ...(validated.plan_digest !== undefined ? { plan_digest: validated.plan_digest } : {}),
    ...(validated.candidate_plan_ref !== undefined ? { candidate_plan_ref: validated.candidate_plan_ref } : {}),
    ...(validated.planning_verification_result_ref !== undefined
      ? { planning_verification_result_ref: validated.planning_verification_result_ref }
      : {}),
  };

  // 1) Seed record FIRST: a failure here leaves the snapshot untouched.
  writeSeedRecord(root, record);
  try {
    // 2) Snapshot facts SECOND: a failure here rolls the seed record back.
    store.write(buildSeedFacts(validated));
  } catch (err) {
    rollbackSeedRecord(root);
    seedFail('write-failed', `cannot persist MES snapshot facts; seed record rolled back: ${err instanceof Error ? err.message : String(err)}`);
  }

  return validateRecord(record);
}

/** Build the accepted Plan binding + Git basis facts for the seed. */
function buildSeedFacts(validated: MesBootstrapSeedInput) {
  // The verification ref is Git-bound (bootstrap PLAN_READY is Git-tracked
  // evidence, not a MES resultRef) — no pre-seed MES identity/resultRef is
  // required.
  const binding = {
    binding_stage: 'accepted',
    accepted_plan_ref: validated.accepted_plan_ref,
    source_candidate_plan_ref: validated.accepted_plan_ref,
    verification_result_ref: `bootstrap:verification:${validated.git_basis.head}` as string,
    ...(validated.plan_digest !== undefined ? { plan_digest: validated.plan_digest } : {}),
  } as const;

  const planBindingFact = {
    schema_version: MES_SCHEMA_VERSION,
    fact_id: `mes:fact:plan_binding:${validated.status.scope}` as string,
    fact_kind: 'plan_binding' as const,
    created_by: 'brain' as const,
    authority_refs: validated.authority_refs,
    plan_binding: binding,
  };

  const gitFact = {
    schema_version: MES_SCHEMA_VERSION,
    fact_id: `mes:fact:git:${validated.status.scope}` as string,
    fact_kind: 'git' as const,
    created_by: 'brain' as const,
    authority_refs: validated.authority_refs,
    scope: { stage_id: validated.status.scope },
    plan_binding: binding,
    git_basis: validated.git_basis,
  };

  return [planBindingFact, gitFact];
}

/** Remove the seed record (best-effort rollback; used only on snapshot failure). */
function rollbackSeedRecord(root: string): void {
  const canonical = canonicalPathWithinRoot(path.resolve(root), MES_SEED_REL);
  if (canonical === null) return;
  try {
    fs.rmSync(canonical, { force: true });
  } catch {
    /* best-effort: the failure is reported anyway */
  }
}

/**
 * (S05-C-T02 / PO-S05-C-03) Read-only snapshot-facts read for the
 * post-recovery status observation path: returns the durable MES snapshot
 * facts (root-bound, fail-closed on corrupt content; a missing pre-seed
 * snapshot reads as `[]`). The public `proofloop status` entry uses this
 * seam when the one-time seed record / seed-owned facts are unavailable
 * after a legal recovery baseline — it NEVER backfills missing seed-owned
 * facts and NEVER revives the permanently-closed PRE_MES_BOOTSTRAP branch.
 */
export function readMesSnapshotFacts(root: string): MesFactEnvelope[] {
  if (typeof root !== 'string' || root.length === 0) {
    seedFail('escape', 'store root must be a non-empty path');
  }
  return new MesSnapshotStore(root).read();
}
export type { MesGitBasis };