/**
 * E2E-25 operational transaction regression fixtures (S06-R-D-T02, isolated
 * fixture roots only — never the real `.proofloop/mes`).
 *
 * Builds synthetic seed/snapshot fixtures for the Sep 10 partial-replace,
 * Sep 12 result-write partial-replace, Sep 13 post-recovery fact-gap,
 * canonical-vs-typo `verification_result_ref`, invalid immutable history
 * after restart, caller event without full snapshot/retention/binding
 * assembly and raw full-snapshot writer negative paths (acceptance E2E-25;
 * contracts §2.1.2 / §2.1.3 / §2.1.4).
 *
 * The canonical S01 work-plan relation mirrors the incident: ONE durable
 * plan_acceptance + PVR with a SINGLE canonical verification_result_ref
 * (`mes:verification:S01:plan`) that every accepted-bound work fact must
 * EXACTLY carry (§2.1.3). Fact shapes mirror the runtime's schema-valid
 * envelope grammar (created_by / authority_refs / scope / work_id /
 * plan_binding / git_basis).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { sha } from '../helpers';
import type { MesFactEnvelope, MesGitBasis } from '../../dist/mes/types';

export const E25_PLAN_REF = 'delivery/stages/S01/plan.md';
export const E25_CANONICAL_REF = 'mes:verification:S01:plan';
export const E25_TYPO_REF = 'mes:verification:S01:plna';
export const E25_DIGEST = sha('e25-transaction-plan-v1');
export const E25_CYCLE = 'cycle-e25-regression';
export const E25_BASIS: MesGitBasis = { head: 'a'.repeat(40), branch: 'v2-subagent', worktree: '.' };

export function sha256OfBytes(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function sha256OfFile(abs: string): string {
  return sha256OfBytes(fs.readFileSync(abs));
}

export function factIdList(facts: readonly MesFactEnvelope[]): string[] {
  return facts.map((fact) => fact.fact_id);
}

/** Canonical S01 plan_acceptance support fact (planning_verification_result). */
export function e25Pvr(tag = '1'): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:planning_verification_result:S01:${tag}`,
    fact_kind: 'planning_verification_result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.2'],
    scope: { stage_id: 'S01' },
    work_id: `mes:work:S01:planning:${tag}`,
    result_ref: E25_CANONICAL_REF,
    verifier_role: 'stage-plan-verifier',
    action_token: `s01-spv-${tag}`,
    plan_binding: {
      binding_stage: 'candidate',
      candidate_plan_ref: E25_PLAN_REF,
      accepted_plan_ref: null,
      verdict: 'PLAN_READY',
      plan_digest: E25_DIGEST,
      delivery_cycle_id: E25_CYCLE,
    },
    git_basis: E25_BASIS,
  };
}

/** Canonical S01 plan_acceptance fact. */
export function e25Pa(tag = '1'): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:plan_acceptance:S01:${tag}`,
    fact_kind: 'plan_acceptance',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#2.2.2'],
    scope: { stage_id: 'S01' },
    supersedes_plan_acceptance_ref: null,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: E25_PLAN_REF,
      source_candidate_plan_ref: E25_PLAN_REF,
      verification_result_ref: E25_CANONICAL_REF,
      plan_digest: E25_DIGEST,
      delivery_cycle_id: E25_CYCLE,
    },
    git_basis: E25_BASIS,
  };
}

/** Ordinary project fact (not binding-critical). */
export function e25Project(id: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:project:${id}`,
    fact_kind: 'project',
    created_by: 'brain',
    authority_refs: ['PRD.md#FR-003'],
  };
}

/**
 * Accepted-bound work fact. `verificationResultRef` defaults to the canonical
 * ref; pass E25_TYPO_REF for the Sep-13 typo incident shape.
 */
export function e25Work(id: string, opts: { verificationResultRef?: string; planRef?: string } = {}): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:work:${id}`,
    fact_kind: 'work',
    created_by: 'brain',
    authority_refs: ['PRD.md#FR-003'],
    scope: { stage_id: 'S01', slice_id: 'S01-A', task_id: 'S01-A-T01' },
    work_id: `mes:work:${id}`,
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: opts.planRef ?? E25_PLAN_REF,
      source_candidate_plan_ref: opts.planRef ?? E25_PLAN_REF,
      verification_result_ref: opts.verificationResultRef ?? E25_CANONICAL_REF,
      plan_digest: E25_DIGEST,
      delivery_cycle_id: E25_CYCLE,
    },
    git_basis: E25_BASIS,
  };
}

/** Durable result fact (Sep-12 result-write incident shape). */
export function e25Result(id: string): MesFactEnvelope {
  return {
    schema_version: 2,
    fact_id: `mes:fact:result:${id}`,
    fact_kind: 'result',
    created_by: 'brain',
    authority_refs: ['tech-spec/contracts.md#4.3'],
    scope: { stage_id: 'S01', slice_id: 'S01-A', task_id: 'S01-A-T01' },
    work_id: `mes:work:${id}`,
    result_ref: `mes:result:S01:${id}`,
    // S01-legacy result shape (no result_id/result_payload_digest):
    // binds the accepted S01 Plan exactly like the durable result facts
    // the Sep-12 result-write incident carried.
    plan_binding: {
      binding_stage: 'accepted',
      accepted_plan_ref: E25_PLAN_REF,
      source_candidate_plan_ref: E25_PLAN_REF,
      verification_result_ref: E25_CANONICAL_REF,
      plan_digest: E25_DIGEST,
      delivery_cycle_id: E25_CYCLE,
    },
    git_basis: E25_BASIS,
  };
}

/**
 * Sep-10 partial-replace pre-incident durable set: one PVR + one PA + two
 * project facts + one work fact (accepted-bound, canonical ref).
 */
export function sep10PreSnapshot(): MesFactEnvelope[] {
  return [e25Pvr('1'), e25Pa('1'), e25Project('p1'), e25Project('p2'), e25Work('w1')];
}

/**
 * Sep-12 result-write incident shape: the durable set ALREADY contains a
 * result fact before the delta arrives; the delta only carries ONE new work
 * fact (the caller never resubmits the retained set).
 */
export function sep12BaseSnapshot(): MesFactEnvelope[] {
  return [e25Pvr('1'), e25Pa('1'), e25Project('p1'), e25Work('w1'), e25Result('r1')];
}

/**
 * Sep-13 post-recovery fact-gap shape: the durable set contains a work fact
 * whose accepted-plan support is MISSING (the PA/PVR are gone — a recovery
 * fact-gap). The gap fact must stay durable/readable but relation-invalid
 * (non-authorizing), deterministic after restart, never backfilled.
 */
export function sep13GapSnapshot(): MesFactEnvelope[] {
  // The durable set retains the PA/PVR anchors, but the retained work fact
  // binds a TYPO verification_result_ref — its relation to the canonical
  // relation cannot resolve. The gap is the RELATION gap: the fact stays
  // durable/readable but deterministic non-authorizing (never corrected,
  // never backfilled, no newest-wins).
  return [e25Pvr('1'), e25Pa('1'), e25Project('p1'), e25Work('w-gap', { verificationResultRef: E25_TYPO_REF })];
}

/** Snapshot sha256 at an isolated fixture root (null when absent). */
export function snapshotDigest(root: string): string | null {
  const abs = path.join(root, '.proofloop', 'mes', 'snapshot.json');
  if (!fs.existsSync(abs)) return null;
  return sha256OfFile(abs);
}

/** Fact count of the snapshot at an isolated fixture root (null when absent). */
export function snapshotFactCount(root: string): number | null {
  const abs = path.join(root, '.proofloop', 'mes', 'snapshot.json');
  if (!fs.existsSync(abs)) return null;
  const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as { facts?: unknown[] };
  return Array.isArray(parsed.facts) ? parsed.facts.length : null;
}

/**
 * Canonical project/trust-root MES observation (PO-S06-E-05).
 *
 * The suite mutates isolated fixture roots only; the canonical project MES is
 * never a mutation target, only ever observed. The observation must be
 * EFFECTIVE from a Slice worktree too: there the local root carries no MES at
 * all, so the canonical root is resolved through Git (the common `.git`
 * directory belongs to the primary worktree owning the trust root) instead of
 * a worktree-relative path that can miss the repository entirely. An
 * unobservable canonical MES is a typed, visible failure — never a silent
 * pass or skip.
 */
export class CanonicalProjectMesObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalProjectMesObservationError';
  }
}

const CANONICAL_PROJECT_MES_REL = path.join('.proofloop', 'mes', 'snapshot.json');

/**
 * The primary worktree that owns the common `.git` directory, resolved from an
 * EXPLICIT base directory (default: this module's own directory, which keeps the
 * previous behaviour for every existing caller). A base dir inside a LINKED
 * worktree still resolves to the primary worktree root, so the canonical root is
 * never the base dir, never `process.cwd()` and never a worktree-local root.
 */
export function resolveCanonicalProjectRoot(baseDir: string = __dirname): string {
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  if (baseDir.length === 0) {
    throw new CanonicalProjectMesObservationError('cannot resolve the canonical project/trust root from an empty base directory');
  }
  let commonDir: string;
  try {
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: baseDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
  } catch (error) {
    throw new CanonicalProjectMesObservationError(
      `cannot resolve the canonical project/trust root from ${baseDir}: ${(error as Error).message}`,
    );
  }
  if (commonDir.length === 0) {
    throw new CanonicalProjectMesObservationError('git reported an empty common directory');
  }
  return path.dirname(commonDir);
}

export interface CanonicalProjectMesObservation {
  readonly root: string;
  readonly path: string;
  readonly sha256: string;
  readonly factCount: number;
  readonly factIds: readonly string[];
}

/** Read-only observation of the canonical project MES (never a mutation target). */
export function observeCanonicalProjectMes(baseDir: string = __dirname): CanonicalProjectMesObservation {
  const root = resolveCanonicalProjectRoot(baseDir);
  const abs = path.join(root, CANONICAL_PROJECT_MES_REL);
  if (!fs.existsSync(abs)) {
    throw new CanonicalProjectMesObservationError(
      `the canonical project MES is not observable at ${abs} (canonical root ${root})`,
    );
  }
  const bytes = fs.readFileSync(abs);
  const parsed = JSON.parse(bytes.toString('utf8')) as { facts?: Array<{ fact_id?: unknown }> };
  if (!Array.isArray(parsed.facts)) {
    throw new CanonicalProjectMesObservationError(`the canonical project MES at ${abs} carries no fact array`);
  }
  return {
    root,
    path: abs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    factCount: parsed.facts.length,
    factIds: parsed.facts.map((fact) => String(fact.fact_id)),
  };
}

export interface CanonicalProjectArtifactObservation {
  readonly root: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}

/**
 * Read-only observation of a ROOT-RELATIVE artifact inside the canonical
 * project/trust root (never a mutation target).
 *
 * The value is resolved strictly INSIDE the canonical root: an empty value, an
 * absolute path, a value that escapes the canonical root, an unobservable
 * artifact, a failed Git resolution and an empty common directory all raise the
 * existing typed observation error — never a silent skip, never a fallback to
 * the base directory and never a worktree-local copy.
 *
 * The bound is enforced on the REAL path too: an intermediate symlink inside
 * the canonical root that points outside it is an escape, not an observation.
 */
export function observeCanonicalProjectArtifact(
  relativePath: string,
  baseDir: string = __dirname,
): CanonicalProjectArtifactObservation {
  const root = resolveCanonicalProjectRoot(baseDir);
  if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new CanonicalProjectMesObservationError(
      `the canonical project artifact ref must be a non-empty root-relative path, received ${JSON.stringify(relativePath)}`,
    );
  }
  const abs = path.resolve(root, relativePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new CanonicalProjectMesObservationError(
      `the canonical project artifact ref ${relativePath} escapes the canonical root ${root}`,
    );
  }
  if (!fs.existsSync(abs)) {
    throw new CanonicalProjectMesObservationError(
      `the canonical project artifact is not observable at ${abs} (canonical root ${root})`,
    );
  }
  // Root-bound beyond symlinks: an intermediate path component INSIDE the root
  // can be a symlink pointing outside it, so the lexical check above is not
  // enough — the observed artifact must physically resolve inside the root.
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(abs);
    realRoot = fs.realpathSync(root);
  } catch (error) {
    throw new CanonicalProjectMesObservationError(
      `cannot resolve the real path of ${abs} inside the canonical root ${root}: ${(error as Error).message}`,
    );
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new CanonicalProjectMesObservationError(
      `the canonical project artifact ref ${relativePath} resolves to ${real}, outside the canonical root ${realRoot}`
    );
  }
  const bytes = fs.readFileSync(real);
  return {
    root,
    path: abs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes
  };
}
