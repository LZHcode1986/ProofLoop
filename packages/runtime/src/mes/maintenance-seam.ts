/**
 * @proofloop/runtime — MES_MAINTENANCE bounded maintenance/recovery entry
 * seam (S06-R-D-T01).
 *
 * The independent, bounded, auditable implementation entry for the S06
 * integrity hard-freeze maintenance lane (contracts.md §2.1.5
 * mes-maintenance-recovery-boundary, §3.1 mes-integrity-recovery-branch,
 * §4.2 JIT Work Packet, §5.1.2 MES maintenance implementation branch, §5.3
 * Git worktree lifecycle; architecture.md #/entities/
 * mes-maintenance-recovery-boundary + mes-maintenance-recovery-flow +
 * mes-remediation-risk; acceptance E2E-24 / E2E-26 / STATIC-33; contracts
 * §2.2.4a for the eventual controlled recovery transaction which is NOT
 * executed by this seam).
 *
 * The seam is ENTRY ONLY. It machine-verifies the exact MES_MAINTENANCE
 * entry tuple and, when every check closes, returns a typed entry result
 * that lets the evidence-only lane proceed. It NEVER writes: no NORMAL PVR /
 * PA, no PLAN_ACCEPTANCE, no recovery_baseline, no PRE_MES_BOOTSTRAP
 * revival, no fake Work/Task/Result/Git facts, no second MES / shadow store
 * / controller. The real `.proofloop/mes` is consumed strictly as a
 * READ-ONLY frozen tuple; `MES_MAINTENANCE` is an execution mode, not a
 * phase / status / Gate / second state machine. Any failure keeps
 * quarantine, is no-write and is never retried (contracts §2.1.5).
 *
 * Entry tuple (all fresh re-readable; any failure → typed no-entry blocker):
 *   1. recovery candidate Thin Plan ref — canonical root-relative and
 *      root-bound re-readable; the frozen S06 accepted Plan
 *      (`delivery/stages/<stage>/plan.md`) is never a valid substitute
 *      (contracts §4.2); byte-freshness is bound against the canonical
 *      project-root Git-tracked candidate at the canonical root HEAD — a
 *      carry-forward maintenance worktree at an older predecessor Plan
 *      commit is not the freshness basis;
 *   2. frozen snapshot — root-relative ref, root-bound read, sha256 EXACT
 *      match and schema-readable fact count EXACT match (a stale digest /
 *      wrong count is a typed no-entry blocker);
 *   3. forensic incident — root-relative ref, root-bound read, sha256 EXACT
 *      match;
 *   4. audit artifact — root-relative ref, root-bound read, sha256 EXACT
 *      match;
 *   5. Git basis — the current maintenance evidence worktree (resolved from
 *      the root-bound `worktree` identity) must have HEAD EXACTLY equal to
 *      the expected head, its branch identity EXACTLY equal to the expected
 *      branch (a detached HEAD is the literal branch identity `HEAD`), and
 *      its computed root-relative identity EXACTLY equal to the expected
 *      worktree; the MAIN worktree (identity `.`) and any main-worktree
 *      target are never admissible — only a root-bound ISOLATED evidence
 *      worktree can close the entry;
 *   6. physical quarantine — the `.proofloop/mes` directory under the trust
 *      root must exist and carry NO write permission bit for any class
 *      (mode 0555 under the S06 hard-freeze);
 *   7. Brain bounded authorization — the presented `actionToken` must be a
 *      non-empty opaque marker and EXACTLY equal the current Slice-lane
 *      dispatch token (`laneActionToken`); a missing marker or a token
 *      mismatch is a typed no-entry blocker (§4.3 token lifecycle).
 *
 * The shared `verifyMaintenanceBindingTuple` helper (machine refs+digests+count
 * closure) and the shared `verifyMaintenanceQuarantine` predicate (physical
 * `.proofloop/mes` read-only mode) are consumed by the mode-specific
 * Integration seam (contracts §integration.md) so the exact-match and
 * quarantine rules live in ONE place.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CANONICAL_STAGE_ID_RE } from '@proofloop/kernel';
import { canonicalPathWithinRoot, PathReadError, readRootBoundFile } from '../path-guard';
import { isCanonicalAuthorityRef, isCanonicalRootRelativeRef } from './binding';
import { resolveGitRoot, readGitHead } from '../git-source';

/** The only execution mode this seam admits (contracts §2.1.5 / §5.1.2). */
export const MES_MAINTENANCE_MODE = 'MES_MAINTENANCE' as const;


/**
 * The current maintenance lane identity: EXACTLY one stage and one recovery
 * candidate Thin Plan ref. The seam is S06-scoped (the S06 hard-freeze
 * recovery lane); any other stage or any stale/accepted Plan ref is a typed
 * no-entry blocker (no lane widening, no candidate substitution).
 */
export const MAINTENANCE_LANE_STAGE = 'S06' as const;
export const MAINTENANCE_LANE_PLAN_REF = 'delivery/stages/S06/recovery-plan-r9.md' as const;
/** Closed Maintenance binding tuple (worker-template §4.2 canonical fields). */
export interface MaintenanceBinding {
  readonly frozen_snapshot_ref: string;
  readonly frozen_snapshot_sha256: string;
  readonly frozen_fact_count: number;
  readonly forensic_ref: string;
  readonly forensic_sha256: string;
  readonly audit_ref: string;
  readonly audit_sha256: string;
}

/** Exact Git basis of the current maintenance evidence worktree. */
export interface MaintenanceGitBasis {
  readonly head: string;
  readonly branch: string;
  readonly worktree: string;
}

/** The entry basis a maintenance lane presents (recovery candidate + tuple). */
export interface MaintenanceEntryBasis {
  readonly plan_ref: string;
  readonly authority_refs: readonly string[];
  readonly maintenance_binding: MaintenanceBinding;
  readonly git_basis: MaintenanceGitBasis;
  readonly actionToken: string;
}

/** Entry context: the lane stage + the current Brain dispatch token. */
export interface MaintenanceEntryContext {
  readonly stageId: string;
  readonly basis: MaintenanceEntryBasis;
  readonly laneActionToken: string;
}

/** Typed entry result — control passes to the evidence-only lane. */
export interface MaintenanceSeamEntry {
  readonly execution_mode: typeof MES_MAINTENANCE_MODE;
  readonly stageId: string;
  readonly plan_ref: string;
  readonly authority_refs: readonly string[];
  readonly maintenance_binding: MaintenanceBinding;
  readonly git_basis: MaintenanceGitBasis;
  readonly actionToken: string;
  readonly snapshot_sha256: string;
  readonly snapshot_fact_count: number;
  readonly forensic_sha256: string;
  readonly audit_sha256: string;
}

/** Closed fail-closed entry codes (typed blocker; no entry / no-write). */
export type MaintenanceSeamErrorCode =
  | 'MAINTENANCE.ENTRY_INVALID'
  | 'MAINTENANCE.REF_ESCAPE'
  | 'MAINTENANCE.REF_UNREADABLE'
  | 'MAINTENANCE.DIGEST_MISMATCH'
  | 'MAINTENANCE.FACT_COUNT_MISMATCH'
  | 'MAINTENANCE.SNAPSHOT_SCHEMA_INVALID'
  | 'MAINTENANCE.PLAN_SEMANTICS_INVALID'
  | 'MAINTENANCE.PLAN_FRESHNESS_MISMATCH'
  | 'MAINTENANCE.GIT_BASIS_MISMATCH'
  | 'MAINTENANCE.QUARANTINE_VIOLATED'
  | 'MAINTENANCE.AUTHORIZATION_MISSING'
  | 'MAINTENANCE.AUTHORIZATION_MISMATCH';

/** Typed no-entry blocker (structured blocker fields, contracts §7). */
export class MaintenanceSeamError extends Error {
  public readonly code: MaintenanceSeamErrorCode;
  public readonly route_code: 'RUNTIME_BLOCKER' = 'RUNTIME_BLOCKER';
  public readonly subtype: string;
  public readonly reason: string;
  public readonly invalidation_scope: readonly string[];
  public readonly resume_target: 'recovery' = 'recovery';

  constructor(code: MaintenanceSeamErrorCode, message: string, invalidationScope: readonly string[] = []) {
    super(message);
    this.name = 'MaintenanceSeamError';
    this.code = code;
    this.subtype = code;
    this.reason = message;
    this.invalidation_scope = invalidationScope;
  }
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const HEAD_SHA_RE = /^[0-9a-f]{40}$/;

function seamFail(code: MaintenanceSeamErrorCode, message: string, invalidationScope: readonly string[] = []): never {
  throw new MaintenanceSeamError(code, message, invalidationScope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Closed-object guard: the value must be a plain object whose keys are
 * EXACTLY the known set (no unknown / smuggled fields such as
 * `basis.work_id` or session metadata).
 */
function expectClosedObject(value: unknown, label: string, known: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    seamFail('MAINTENANCE.ENTRY_INVALID', `${label} must be a closed object`, [label]);
  }
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      seamFail('MAINTENANCE.ENTRY_INVALID', `${label} carries unknown field ${JSON.stringify(key)} (closed object → no entry, no-write)`, [label]);
    }
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

function sha256Utf8(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex');
}

/** Closed-shape check of one root-relative ref (no filesystem access). */
function expectRootRelativeRef(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || hasControlCharacter(value) || !isCanonicalRootRelativeRef(value)) {
    seamFail('MAINTENANCE.REF_ESCAPE', `${label} must be a canonical root-relative ref (no absolute path, no .., no backslash, no empty segment)`, [label]);
  }
  return value;
}

/** Root-bound read of a ref; maps PathReadError to the typed no-entry code. */
function readRootBound(root: string, ref: string, label: string): string {
  let content: string;
  try {
    content = readRootBoundFile(root, ref).content;
  } catch (error) {
    if (error instanceof PathReadError) {
      if (error.code === 'escape') {
        seamFail('MAINTENANCE.REF_ESCAPE', `${label} escapes the trust root (${ref})`, [label]);
      }
      seamFail('MAINTENANCE.REF_UNREADABLE', `${label} is missing or not re-readable (${ref}): ${error.message}`, [label]);
    }
    seamFail('MAINTENANCE.REF_UNREADABLE', `${label} is missing or not re-readable (${ref})`, [label]);
  }
  return content;
}

/** Root-bound read + sha256 of one immutable evidence artifact. */
function readRootBoundSha256(root: string, ref: string, label: string): string {
  const content = readRootBound(root, ref, label);
  return sha256Utf8(content);
}

/** Closed-shape validation of the maintenance binding (no filesystem access). */
function validateBindingShape(value: unknown): MaintenanceBinding {
  if (!isRecord(value)) {
    seamFail('MAINTENANCE.ENTRY_INVALID', 'maintenance_binding must be a closed object');
  }
  const KNOWN = new Set([
    'frozen_snapshot_ref',
    'frozen_snapshot_sha256',
    'frozen_fact_count',
    'forensic_ref',
    'forensic_sha256',
    'audit_ref',
    'audit_sha256',
  ]);
  for (const key of Object.keys(value)) {
    if (!KNOWN.has(key)) {
      seamFail('MAINTENANCE.ENTRY_INVALID', `maintenance_binding carries unknown field ${JSON.stringify(key)}`, ['maintenance_binding']);
    }
  }
  for (const refField of ['frozen_snapshot_ref', 'forensic_ref', 'audit_ref'] as const) {
    if (value[refField] === undefined) {
      seamFail('MAINTENANCE.ENTRY_INVALID', `maintenance_binding.${refField} is a required field (missing tuple element)`, [`maintenance_binding.${refField}`]);
    }
    expectRootRelativeRef(value[refField], `maintenance_binding.${refField}`);
  }
  for (const digestField of ['frozen_snapshot_sha256', 'forensic_sha256', 'audit_sha256'] as const) {
    const digest = value[digestField];
    if (typeof digest !== 'string' || !SHA256_HEX_RE.test(digest)) {
      seamFail('MAINTENANCE.ENTRY_INVALID', `maintenance_binding.${digestField} must be a 64-char lowercase hex sha256`, [`maintenance_binding.${digestField}`]);
    }
  }
  const count = value.frozen_fact_count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
    seamFail('MAINTENANCE.ENTRY_INVALID', 'maintenance_binding.frozen_fact_count must be a positive integer', ['maintenance_binding.frozen_fact_count']);
  }
  return {
    frozen_snapshot_ref: value.frozen_snapshot_ref as string,
    frozen_snapshot_sha256: value.frozen_snapshot_sha256 as string,
    frozen_fact_count: count,
    forensic_ref: value.forensic_ref as string,
    forensic_sha256: value.forensic_sha256 as string,
    audit_ref: value.audit_ref as string,
    audit_sha256: value.audit_sha256 as string,
  };
}

/**
 * Machine refs+digests+count closure of the maintenance binding: frozen
 * snapshot sha256 + fact count EXACT, forensic sha256 EXACT, audit sha256
 * EXACT, all refs root-bound re-readable. Shared by the mode-specific
 * Integration seam so the exact-match rule lives in ONE place.
 *
 * @returns the validated binding (same tuple) when every check closes.
 * @throws {MaintenanceSeamError} on any failure — no entry, no-write.
 */
export function verifyMaintenanceBindingTuple(root: string, value: unknown): MaintenanceBinding {
  if (typeof root !== 'string' || root.length === 0) {
    seamFail('MAINTENANCE.ENTRY_INVALID', 'trust root must be a non-empty path');
  }
  const binding = validateBindingShape(value);

  const snapshotContent = readRootBound(root, binding.frozen_snapshot_ref, 'maintenance_binding.frozen_snapshot_ref');
  const snapshotSha = sha256Utf8(snapshotContent);
  if (snapshotSha !== binding.frozen_snapshot_sha256) {
    seamFail(
      'MAINTENANCE.DIGEST_MISMATCH',
      `frozen snapshot sha256 mismatch: expected ${binding.frozen_snapshot_sha256}, observed ${snapshotSha}（stale / tampered frozen source → no entry, no-write）`,
      ['maintenance_binding.frozen_snapshot_sha256'],
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotContent) as unknown;
  } catch {
    seamFail('MAINTENANCE.SNAPSHOT_SCHEMA_INVALID', 'frozen snapshot is not valid JSON（schema-unreadable → no entry, no-write）', ['maintenance_binding.frozen_snapshot_ref']);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.facts)) {
    seamFail('MAINTENANCE.SNAPSHOT_SCHEMA_INVALID', 'frozen snapshot must be a MES snapshot object with a facts array', ['maintenance_binding.frozen_snapshot_ref']);
  }
  const factCount = parsed.facts.length;
  if (factCount !== binding.frozen_fact_count) {
    seamFail(
      'MAINTENANCE.FACT_COUNT_MISMATCH',
      `frozen snapshot fact count mismatch: expected ${binding.frozen_fact_count}, observed ${factCount}（wrong count → no entry, no-write）`,
      ['maintenance_binding.frozen_fact_count'],
    );
  }

  const forensicSha = readRootBoundSha256(root, binding.forensic_ref, 'maintenance_binding.forensic_ref');
  if (forensicSha !== binding.forensic_sha256) {
    seamFail(
      'MAINTENANCE.DIGEST_MISMATCH',
      `forensic incident sha256 mismatch: expected ${binding.forensic_sha256}, observed ${forensicSha}（immutable forensic ref not exact → no entry, no-write）`,
      ['maintenance_binding.forensic_sha256'],
    );
  }
  const auditSha = readRootBoundSha256(root, binding.audit_ref, 'maintenance_binding.audit_ref');
  if (auditSha !== binding.audit_sha256) {
    seamFail(
      'MAINTENANCE.DIGEST_MISMATCH',
      `audit artifact sha256 mismatch: expected ${binding.audit_sha256}, observed ${auditSha}（read-only audit ref not exact → no entry, no-write）`,
      ['maintenance_binding.audit_sha256'],
    );
  }
  return binding;
}

/**
 * Machine markers that the CURRENT recovery candidate Thin Plan must carry
 * (recovery-plan-r3.md structure): the RECOVERY_REBASELINE execution mode, the
 * MES_MAINTENANCE executable mode and the candidate_plan_ref self-identity.
 * A same-path file carrying NORMAL accepted-Plan semantics is a substitution.
 */
const RECOVERY_CANDIDATE_EXECUTION_MODE = 'execution_mode: RECOVERY_REBASELINE';
const RECOVERY_CANDIDATE_EXECUTABLE_MODE = 'executable_execution_mode: MES_MAINTENANCE';
const RECOVERY_CANDIDATE_SELF_REF_PREFIX = 'candidate_plan_ref: ';
const NORMAL_ACCEPTED_PLAN_MARKER = 'accepted_plan_ref';

/**
 * Bind the CURRENT Git-tracked recovery candidate Plan at the seam (contracts
 * §4.2 freshness + recovery candidate semantics). The SAME path must still
 * carry the exact recovery candidate semantics (RECOVERY_REBASELINE /
 * MES_MAINTENANCE / candidate_plan_ref self-identity) and be byte-fresh
 * against the canonical project-root Git-tracked candidate at the canonical
 * root HEAD — NOT against the carry-forward maintenance worktree HEAD (a
 * carry-forward candidate worktree may contain an older predecessor Plan
 * commit and is not the freshness basis). A same-path file swapped to NORMAL
 * / accepted_plan_ref semantics, or an uncommitted canonical-root edit of the
 * candidate, is a typed no-entry blocker — no second Plan/SPV store is
 * invented and the Plan itself is never modified.
 */
export function verifyRecoveryPlanCandidate(root: string, planRef: string, gitRoot: string): void {
  const content = readRootBound(root, planRef, 'plan_ref');
  if (
    !content.includes(RECOVERY_CANDIDATE_EXECUTION_MODE) ||
    !content.includes(RECOVERY_CANDIDATE_EXECUTABLE_MODE) ||
    !content.includes(`${RECOVERY_CANDIDATE_SELF_REF_PREFIX}${planRef}`)
  ) {
    seamFail(
      'MAINTENANCE.PLAN_SEMANTICS_INVALID',
      `recovery candidate Plan ${planRef} does not carry the current recovery candidate semantics (execution_mode: RECOVERY_REBASELINE / executable_execution_mode: MES_MAINTENANCE / candidate_plan_ref self-identity) — same-path substitution → no entry, no-write`,
      ['plan_ref'],
    );
  }
  if (content.includes(NORMAL_ACCEPTED_PLAN_MARKER)) {
    seamFail(
      'MAINTENANCE.PLAN_SEMANTICS_INVALID',
      `recovery candidate Plan ${planRef} carries NORMAL accepted-Plan semantics (${NORMAL_ACCEPTED_PLAN_MARKER}) — the same path must not be a NORMAL/accepted_plan_ref substitution → no entry, no-write`,
      ['plan_ref'],
    );
  }
  const planAbs = canonicalPathWithinRoot(root, planRef);
  if (planAbs === null) {
    seamFail('MAINTENANCE.REF_ESCAPE', `plan_ref escapes the trust root (${planRef})`, ['plan_ref']);
  }
  // Freshness basis: the canonical project root (repository main worktree) at
  // its HEAD — the canonical Git-tracked recovery candidate Plan. The
  // carry-forward maintenance worktree HEAD (which may hold an older
  // predecessor Plan blob) is NOT the freshness basis.
  const canonicalRoot = resolveCanonicalProjectRoot(gitRoot);
  let onDiskBlob = '';
  try {
    onDiskBlob = execFileSync('git', ['hash-object', planAbs], {
      cwd: gitRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    seamFail('MAINTENANCE.PLAN_FRESHNESS_MISMATCH', `cannot hash the on-disk recovery candidate Plan (${error instanceof Error ? error.message : String(error)}) → no entry, no-write`, ['plan_ref']);
  }
  let canonicalHeadBlob = '';
  try {
    canonicalHeadBlob = execFileSync('git', ['rev-parse', `HEAD:${planRef}`], {
      cwd: canonicalRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    seamFail('MAINTENANCE.PLAN_FRESHNESS_MISMATCH', `the recovery candidate Plan is not a Git-tracked candidate at the canonical root HEAD (${planRef}) → no entry, no-write`, ['plan_ref']);
  }
  if (onDiskBlob.length === 0 || canonicalHeadBlob.length === 0 || onDiskBlob !== canonicalHeadBlob) {
    seamFail(
      'MAINTENANCE.PLAN_FRESHNESS_MISMATCH',
      `recovery candidate Plan ${planRef} is not byte-fresh against the canonical project-root Git-tracked candidate at the canonical root HEAD (uncommitted canonical-root edit / stale on-disk content → no entry, no-write)`,
      ['plan_ref'],
    );
  }
}

/** Current branch identity of a git worktree (detached HEAD → literal `HEAD`). */
export function readBranchIdentity(gitRoot: string): string {
  try {
    const output = execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: gitRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return output.length > 0 ? output : 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/**
 * Resolve the canonical project root (the repository's main worktree) from a
 * maintenance git root via the repository common dir. The canonical root is
 * where the Git-tracked recovery candidate Plan is bound: its HEAD (not the
 * carry-forward maintenance worktree HEAD) is the plan freshness basis — a
 * carry-forward candidate worktree may legitimately be checked out at an
 * older predecessor Plan commit.
 */
function resolveCanonicalProjectRoot(gitRoot: string): string {
  let commonDir: string;
  try {
    commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: gitRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    seamFail('MAINTENANCE.GIT_BASIS_MISMATCH', 'cannot resolve the repository common dir for the maintenance worktree');
  }
  if (commonDir.length === 0) {
    seamFail('MAINTENANCE.GIT_BASIS_MISMATCH', 'cannot resolve the repository common dir for the maintenance worktree');
  }
  return path.dirname(path.resolve(gitRoot, commonDir));
}

/** Root-relative identity of a worktree vs the repository's common root. */
export function rootRelativeWorktreeIdentity(gitRoot: string, worktreeAbs: string): string {
  const repoRoot = resolveCanonicalProjectRoot(gitRoot);
  const identity = path.relative(repoRoot, worktreeAbs).split(path.sep).join('/');
  return identity.length === 0 ? '.' : identity;
}

function verifyGitBasis(root: string, basis: MaintenanceGitBasis): string {
  if (typeof basis.head !== 'string' || !HEAD_SHA_RE.test(basis.head)) {
    seamFail('MAINTENANCE.ENTRY_INVALID', 'git_basis.head must be a 40-char lowercase hex commit SHA', ['git_basis.head']);
  }
  if (typeof basis.branch !== 'string' || basis.branch.length === 0 || hasControlCharacter(basis.branch)) {
    seamFail('MAINTENANCE.ENTRY_INVALID', 'git_basis.branch must be a non-empty branch identity without control characters', ['git_basis.branch']);
  }
  if (typeof basis.worktree !== 'string' || (basis.worktree !== '.' && !isCanonicalRootRelativeRef(basis.worktree))) {
    seamFail('MAINTENANCE.ENTRY_INVALID', 'git_basis.worktree must be a canonical root-relative worktree identity', ['git_basis.worktree']);
  }
  // The MES_MAINTENANCE entry requires a root-bound ISOLATED evidence
  // worktree: the MAIN worktree (identity '.') is never admissible — the
  // S06 hard-freeze keeps main / S06-C / S06-D worktrees zero-write
  // (contracts §5.3 Git worktree lifecycle; recovery-plan-r3 §MES_MAINTENANCE
  // execution binding).
  if (basis.worktree === '.') {
    seamFail(
      'MAINTENANCE.GIT_BASIS_MISMATCH',
      'git_basis.worktree "." is the main worktree — MES_MAINTENANCE entry requires a root-bound isolated evidence worktree (main-worktree target → no entry, no-write)',
      ['git_basis.worktree'],
    );
  }
  const worktreeAbs = canonicalPathWithinRoot(root, basis.worktree);
  if (worktreeAbs === null) {
    seamFail('MAINTENANCE.GIT_BASIS_MISMATCH', `git_basis.worktree ${JSON.stringify(basis.worktree)} escapes the trust root`, ['git_basis.worktree']);
  }
  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(worktreeAbs);
  } catch (error) {
    seamFail(
      'MAINTENANCE.GIT_BASIS_MISMATCH',
      `maintenance worktree is not a re-readable git root（${error instanceof Error ? error.message : String(error)}）`,
      ['git_basis.worktree'],
    );
  }
  let actualHead: string;
  try {
    actualHead = readGitHead(gitRoot);
  } catch (error) {
    seamFail(
      'MAINTENANCE.GIT_BASIS_MISMATCH',
      `maintenance worktree HEAD is unavailable（${error instanceof Error ? error.message : String(error)}）`,
      ['git_basis.head'],
    );
  }
  if (actualHead !== basis.head) {
    seamFail(
      'MAINTENANCE.GIT_BASIS_MISMATCH',
      `maintenance worktree HEAD ${JSON.stringify(actualHead)} must EXACTLY equal the expected head ${JSON.stringify(basis.head)}（Git basis mismatch → no entry, no-write）`,
      ['git_basis.head'],
    );
  }
  const actualBranch = readBranchIdentity(gitRoot);
  if (actualBranch !== basis.branch) {
    seamFail(
      'MAINTENANCE.GIT_BASIS_MISMATCH',
      `maintenance worktree branch identity ${JSON.stringify(actualBranch)} must EXACTLY equal the expected branch ${JSON.stringify(basis.branch)}（Git basis mismatch → no entry, no-write）`,
      ['git_basis.branch'],
    );
  }
  const actualWorktree = rootRelativeWorktreeIdentity(gitRoot, worktreeAbs);
  // Any main-worktree target must fail BEFORE the entry closes: the
  // resolved identity of a main-worktree git root is '.', which can never
  // be an isolated evidence worktree (defense-in-depth behind the shape
  // check above — only root-bound isolated evidence worktrees are
  // admissible for MES_MAINTENANCE).
  if (actualWorktree === '.') {
    seamFail(
      'MAINTENANCE.GIT_BASIS_MISMATCH',
      `maintenance worktree resolves to the main worktree identity "." — only a root-bound isolated evidence worktree is admissible (main-worktree target → no entry, no-write)`,
      ['git_basis.worktree'],
    );
  }
  if (actualWorktree !== basis.worktree) {
    seamFail(
      'MAINTENANCE.GIT_BASIS_MISMATCH',
      `maintenance worktree identity ${JSON.stringify(actualWorktree)} must EXACTLY equal the expected worktree ${JSON.stringify(basis.worktree)}（Git basis mismatch → no entry, no-write）`,
      ['git_basis.worktree'],
    );
  }
  return gitRoot;
}

/**
 * Shared physical quarantine predicate: `.proofloop/mes` under the trust
 * root must exist, be a directory and carry NO write permission bit for any
 * class (mode 0555 under the S06 hard-freeze). Reused by the mode-specific
 * maintenance Integration seam so the physical quarantine rule lives in ONE
 * place — a writable `.proofloop/mes` must fail the maintenance Integration
 * BEFORE any candidate apply/stage/commit (typed zero-write).
 *
 * @throws {MaintenanceSeamError} code MAINTENANCE.QUARANTINE_VIOLATED when
 *   the physical quarantine is not in place.
 */
export function verifyMaintenanceQuarantine(root: string): void {
  const mesDir = path.join(root, '.proofloop', 'mes');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(mesDir);
  } catch {
    seamFail('MAINTENANCE.QUARANTINE_VIOLATED', `physical quarantine is not in place: ${mesDir} is missing (mode 0555 required during the S06 hard-freeze)`, ['.proofloop/mes']);
  }
  if (!stat.isDirectory()) {
    seamFail('MAINTENANCE.QUARANTINE_VIOLATED', `physical quarantine is not in place: ${mesDir} is not a directory`, ['.proofloop/mes']);
  }
  if ((stat.mode & 0o222) !== 0) {
    seamFail(
      'MAINTENANCE.QUARANTINE_VIOLATED',
      `physical quarantine violated: ${mesDir} mode ${(stat.mode & 0o777).toString(8)} has write permission bits（required read-only 0555 → no entry, no-write）`,
      ['.proofloop/mes'],
    );
  }
}

function verifyAuthorization(basisToken: unknown, laneToken: string): string {
  if (typeof basisToken !== 'string' || basisToken.length === 0 || hasControlCharacter(basisToken)) {
    seamFail('MAINTENANCE.AUTHORIZATION_MISSING', 'maintenance entry requires a non-empty opaque Brain authorization marker (actionToken)', ['actionToken']);
  }
  if (typeof laneToken !== 'string' || laneToken.length === 0 || hasControlCharacter(laneToken)) {
    seamFail('MAINTENANCE.AUTHORIZATION_MISSING', 'current Slice-lane dispatch token is not re-readable', ['laneActionToken']);
  }
  if (basisToken !== laneToken) {
    seamFail(
      'MAINTENANCE.AUTHORIZATION_MISMATCH',
      'presented actionToken does not EXACTLY equal the current Slice-lane dispatch token（Brain bounded authorization mismatch → no entry, no-write）',
      ['actionToken'],
    );
  }
  return basisToken;
}

/**
 * Machine-verify the full MES_MAINTENANCE entry tuple (see module doc).
 *
 * @returns the typed entry result when every check closes.
 * @throws {MaintenanceSeamError} on any failure — no entry, no-write,
 *   quarantine kept, no auto retry.
 */
export function verifyMaintenanceEntry(root: string, context: MaintenanceEntryContext): MaintenanceSeamEntry {
  const closedContext = expectClosedObject(context, 'maintenance entry context', ['stageId', 'basis', 'laneActionToken']);
  const stageId = closedContext.stageId;
  const basis = expectClosedObject(closedContext.basis, 'maintenance entry basis', [
    'plan_ref',
    'authority_refs',
    'maintenance_binding',
    'git_basis',
    'actionToken',
  ]);
  const laneActionToken = closedContext.laneActionToken as string;
  if (typeof stageId !== 'string' || !CANONICAL_STAGE_ID_RE.test(stageId)) {
    seamFail('MAINTENANCE.ENTRY_INVALID', 'stageId must be a canonical Stage ID (e.g. S06)', ['stageId']);
  }
  // The seam is EXACTLY the current maintenance lane: no other stage may
  // enter the lane (no lane widening).
  if (stageId !== MAINTENANCE_LANE_STAGE) {
    seamFail(
      'MAINTENANCE.ENTRY_INVALID',
      `stageId ${JSON.stringify(stageId)} is not the current maintenance lane stage ${MAINTENANCE_LANE_STAGE} — the lane is ${MAINTENANCE_LANE_STAGE}-scoped (no entry, no-write)`,
      ['stageId'],
    );
  }
  // contracts §4.2: plan_ref in MES_MAINTENANCE is EXACTLY the current
  // recovery candidate Thin Plan. Any other ref — the frozen accepted Plan
  // (`delivery/stages/S06/plan.md`), a stale candidate (recovery-plan-r2.md)
  // or any other file — is a typed no-entry blocker.
  if (typeof basis.plan_ref !== 'string' || basis.plan_ref !== MAINTENANCE_LANE_PLAN_REF) {
    seamFail(
      'MAINTENANCE.ENTRY_INVALID',
      `plan_ref ${JSON.stringify(String(basis.plan_ref))} must EXACTLY equal the current maintenance lane recovery candidate ${MAINTENANCE_LANE_PLAN_REF} (stale candidate / accepted Plan substitution → no entry, no-write)`,
      ['plan_ref'],
    );
  }
  // Same-path candidate semantics + freshness are closed by the seam below,
  // once the Git basis provides the git root for the byte-fresh check.
  if (!Array.isArray(basis.authority_refs) || basis.authority_refs.length === 0) {
    seamFail('MAINTENANCE.ENTRY_INVALID', 'authority_refs must be a non-empty array of canonical tech-spec refs', ['authority_refs']);
  }
  for (const ref of basis.authority_refs) {
    if (typeof ref !== 'string' || !isCanonicalAuthorityRef(ref) || !ref.startsWith('tech-spec/')) {
      seamFail(
        'MAINTENANCE.ENTRY_INVALID',
        'authority_refs entries must be canonical tech-spec authority refs (e.g. tech-spec/contracts.md#/entities/mes-maintenance-recovery-boundary)',
        ['authority_refs'],
      );
    }
  }
  const maintenanceBinding = verifyMaintenanceBindingTuple(root, basis.maintenance_binding);
  const closedGitBasis = expectClosedObject(basis.git_basis, 'git_basis', ['head', 'branch', 'worktree']);
  const gitBasis: MaintenanceGitBasis = {
    head: closedGitBasis.head as string,
    branch: closedGitBasis.branch as string,
    worktree: closedGitBasis.worktree as string,
  };
  const gitRoot = verifyGitBasis(root, gitBasis);
  // Bind the CURRENT Git-tracked recovery candidate Plan (same-path semantics
  // + freshness): a file that kept the path but lost the recovery candidate
  // semantics (NORMAL / accepted_plan_ref) or drifted from the Git-tracked
  // candidate is a typed no-entry blocker (contracts §4.2).
  verifyRecoveryPlanCandidate(root, basis.plan_ref, gitRoot);
  verifyMaintenanceQuarantine(root);
  const actionToken = verifyAuthorization(basis.actionToken, laneActionToken);

  return {
    execution_mode: MES_MAINTENANCE_MODE,
    stageId,
    plan_ref: basis.plan_ref,
    authority_refs: [...basis.authority_refs],
    maintenance_binding: maintenanceBinding,
    git_basis: gitBasis,
    actionToken,
    snapshot_sha256: maintenanceBinding.frozen_snapshot_sha256,
    snapshot_fact_count: maintenanceBinding.frozen_fact_count,
    forensic_sha256: maintenanceBinding.forensic_sha256,
    audit_sha256: maintenanceBinding.audit_sha256,
  };
}
