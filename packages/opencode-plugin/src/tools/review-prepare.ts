/**
 * @proofloop/opencode-plugin — proofloop_review `prepare_stage_review` handler
 * (S03-D-T01, PO-S03-D-01/02/05).
 *
 * The thin read-only prepare flow: assembles the `review_scope: stage`
 * ReviewInput projection from canonical persisted facts through in-process
 * runtime/library seams — Manifest (`stage_goal` / `stage_outcomes` /
 * `risk_facts` + canonical digest), git (`branch` / `snapshot` via the
 * runtime process seam), and reconcile refs (`stage_gate_receipt_ref` from
 * the `stage-gate/<stage>/` category; per-slice `cv_receipt_refs` from the
 * CV category reader's ACTUAL persisted `latest.filePath`). Every artifact
 * reference is ref-only (`{ ref, digest }`, root-bound relative) — a Receipt
 * payload/body never surfaces (PO-S03-D-02 ref-only rule).
 *
 * CV repair (S03-D-REFPATH-POSTWRITE-TOCTOU-SCOPE-001):
 *   - AUTHORITY-REF FAIL-CLOSED (counterexample 1): `discoverAuthorityRefs`
 *     FAILS CLOSED with HOST.PATH_OUTSIDE_PROJECT when any authority artifact
 *     path (PRD.md / tech-spec dir / tech-spec/*.md) resolves outside the
 *     trust root or through a symlink escape — it is NEVER silently omitted.
 *     A missing file is an honest absence (persisted fact).
 *   - CV-REF PATH INTEGRITY (counterexample 2): CV refs use the receipt
 *     reader's ACTUAL `latest.filePath` (the canonical persisted path on
 *     disk) — never a synthesized `<digest>.json` string — so a
 *     renamed-but-valid receipt stays LOCATABLE. A broken CV chain fails
 *     closed (RUNTIME.RECEIPT_CHAIN_BROKEN).
 *
 * prepare NEVER writes: no Receipt, no state change, no category directory.
 * The host tool is read-only; the only persisted writes anywhere near the
 * flow are the diagnostic log entries (logs excepted, PO-S03-D-05).
 *
 * Fail-closed ordering (S2-F-001 + S2 trust-root boundary, same layer as the
 * S2 stage/status handlers):
 *   1. TOCTOU identity re-verify of the runtime's default manifest/tasks reads
 *      (`reverifyStagePaths`);
 *   2. manifest path identity + content trust-root baseline
 *      (`reverifyManifestPathIdentity` / `checkManifestContentBaseline`);
 *   3. canonical Manifest read + digest (`validateManifest` /
 *      `baseline.digest`);
 *   4. reconcile read (canonical persisted-facts source) — error-level
 *      findings fail closed (never a guessed status);
 *   5. `stage-gate/<stage>/` category read — a broken chain fails closed;
 *   6. git branch/HEAD reads through the runtime process seam (`runProcess`)
 *      — non-git / unborn HEAD fails closed with RUNTIME.SCHEMA_MISMATCH;
 *   7. post-read TOCTOU closure (`reverifyManifestContentAfterRead` + final
 *      manifest path identity) discards the projection on any swap.
 *
 * Every failure is a canonical kernel Finding via `toErrorResult` — never a
 * bare exception.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  defaultManifestPath,
  defaultTasksMdPath,
  readReceiptCategory,
  reconcileStage,
  runProcess,
  validateManifest,
} from '@proofloop/runtime';
import type { ValidatedManifest } from '@proofloop/runtime';
import { successResult, toErrorResult } from '../tool-result.js';
import type { ToolResult } from '../tool-result.js';
import {
  checkManifestContentBaseline,
  reverifyManifestContentAfterRead,
  reverifyManifestPathIdentity,
} from '../manifest-guard.js';
import { capFindings, hasErrorFindings, reverifyStagePaths } from './stage-admit-common.js';
import { resolveWithinRoot } from '../path-boundary.js';
import {
  deriveCleanRoom,
  deriveStageRiskLevel,
  makeReviewRefEntry,
} from './review-common.js';
import type { ReviewRefEntry, StageReviewInput } from './review-common.js';
import type { ReviewHandlerResult, ReviewResolvedArgs } from './review.js';

/**
 * One authority artifact discovery outcome (CV repair counterexample 1 /
 * diagnose recheck — AUTHORITY-REF FAIL-CLOSED + unreadable-artifact
 * classification): a candidate authority artifact path
 * (PRD.md / tech-spec dir / tech-spec/*.md) is either a root-bound entry, a
 * GENUINELY missing artifact (ENOENT → honest absence), a TRUST-ROOT ESCAPE
 * (an outside-root or symlink-escape resolution), or an UNREADABLE /
 * WRONG-TYPE artifact (EACCES/EPERM/ENOTDIR/EISDIR-on-file/any other
 * stat/read error) — the last two MUST FAIL CLOSED.
 */
export type AuthorityRefEntryResult =
  | { kind: 'entry'; entry: ReviewRefEntry }
  | { kind: 'absent' }
  | { kind: 'escape'; path: string }
  | { kind: 'fail'; message: string };

/** Extract the Node fs error code (ENOENT / EACCES / EPERM / ENOTDIR / …). */
function errCode(err: unknown): string | undefined {
  return (err as { code?: string })?.code;
}

/** Human-readable fs error message. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resolve one authority artifact candidate (CV repair counterexample 1 +
 * diagnose recheck#1 error classification).
 *
 * Distinguishes:
 *   - a trust-root ESCAPE (resolveWithinRoot returns null — an outside-root
 *     path or a symlink escape) → FAILS CLOSED (HOST.PATH_OUTSIDE_PROJECT);
 *   - a GENUINE ENOENT absence (stat/read reports ENOENT — the artifact does
 *     not exist) → honest absence (persisted fact, ref omitted);
 *   - an UNREADABLE / WRONG-TYPE artifact (EACCES / EPERM / ENOTDIR /
 *     EISDIR-on-file / any other stat/read error) → FAILS CLOSED
 *     (RUNTIME.SCHEMA_MISMATCH) — permission/read faults are NEVER swallowed
 *     into an incomplete authority set.
 */
function authorityRefEntry(
  canonicalRoot: string,
  absolutePath: string,
): AuthorityRefEntryResult {
  const resolved = resolveWithinRoot(canonicalRoot, absolutePath);
  if (resolved === null) {
    return { kind: 'escape', path: absolutePath };
  }

  let stat;
  try {
    stat = statSync(resolved);
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT') {
      // Genuine absence — the artifact does not exist (honest omission).
      return { kind: 'absent' };
    }
    return {
      kind: 'fail',
      message:
        `cannot stat authority artifact "${absolutePath}" (${code ?? 'unknown'}: ` +
        `${errMessage(err)}); unreadable authority artifacts fail closed`,
    };
  }
  if (!stat.isFile()) {
    // A directory (or special file) where a regular FILE is expected.
    return {
      kind: 'fail',
      message:
        `authority artifact "${absolutePath}" is not a regular file ` +
        `(got ${stat.isDirectory() ? 'directory' : 'non-regular file'}); ` +
        'unreadable authority artifacts fail closed',
    };
  }

  let raw: Buffer;
  try {
    raw = readFileSync(resolved);
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT') {
      // The file vanished between stat and read — genuine absence at read time.
      return { kind: 'absent' };
    }
    return {
      kind: 'fail',
      message:
        `cannot read authority artifact "${absolutePath}" (${code ?? 'unknown'}: ` +
        `${errMessage(err)}); unreadable authority artifacts fail closed`,
    };
  }
  const digest = createHash('sha256').update(raw).digest('hex');
  const entry = makeReviewRefEntry(canonicalRoot, resolved, digest);
  if (entry === null) {
    return { kind: 'escape', path: absolutePath };
  }
  return { kind: 'entry', entry };
}

/**
 * Outcome of the authority-document discovery (CV repair counterexample 1).
 */
export type AuthorityRefsResult =
  | { ok: true; refs: ReviewRefEntry[] }
  | { ok: false; result: ToolResult };

/**
 * Discover the canonical authority documents present in the worktree
 * (PO-S03-D-02; CV repair counterexample 1 + diagnose recheck#1): `PRD.md` at
 * the trust root plus every `tech-spec/*.md` authority document. Each ref is
 * root-bound + canonicalized through the shared `resolveWithinRoot` seam and
 * projected as `{ ref, digest }` (ref = root-relative path; digest = sha256
 * of the file bytes).
 *
 * Fail-closed classification (diagnose recheck#1 — unreadable artifacts are
 * NEVER silently treated as absent):
 *   - ENOENT (genuine absence) → honest absence — the doc simply does not
 *     appear;
 *   - ESCAPE (outside-root path / symlink escape) → HOST.PATH_OUTSIDE_PROJECT;
 *   - UNREADABLE / WRONG-TYPE (EACCES / EPERM / ENOTDIR / EISDIR-on-file /
 *     any other stat/read error) → RUNTIME.SCHEMA_MISMATCH — the operation
 *     never silently succeeds with an incomplete authority set.
 * Deterministic ordering: PRD.md first, then tech-spec files sorted by path.
 */
export function discoverAuthorityRefs(canonicalRoot: string): AuthorityRefsResult {
  const refs: ReviewRefEntry[] = [];
  const prd = path.join(canonicalRoot, 'PRD.md');
  const prdResult = authorityRefEntry(canonicalRoot, prd);
  if (prdResult.kind === 'escape') {
    return {
      ok: false,
      result: toErrorResult([
        {
          code: 'HOST.PATH_OUTSIDE_PROJECT',
          severity: 'error',
          message:
            `proofloop_review: prepare — authority artifact "${prdResult.path}" ` +
            `resolves outside the trust root (${canonicalRoot}); a root-bound ` +
            'authority ref is required (symlink escapes fail closed).',
        },
      ]),
    };
  }
  if (prdResult.kind === 'fail') {
    return {
      ok: false,
      result: toErrorResult([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message: `proofloop_review: prepare — ${prdResult.message}.`,
        },
      ]),
    };
  }
  if (prdResult.kind === 'entry') refs.push(prdResult.entry);

  const techSpecDir = path.join(canonicalRoot, 'tech-spec');
  const resolvedTech = resolveWithinRoot(canonicalRoot, techSpecDir);
  if (resolvedTech === null) {
    return {
      ok: false,
      result: toErrorResult([
        {
          code: 'HOST.PATH_OUTSIDE_PROJECT',
          severity: 'error',
          message:
            `proofloop_review: prepare — authority directory "${techSpecDir}" ` +
            `resolves outside the trust root (${canonicalRoot}); a root-bound ` +
            'tech-spec ref is required (symlink escapes fail closed).',
        },
      ]),
    };
  }
  let entries: string[];
  try {
    entries = readdirSync(resolvedTech).filter((n) => n.endsWith('.md')).sort();
  } catch (err) {
    const code = errCode(err);
    if (code === 'ENOENT') {
      // Genuine absence — no tech-spec authority directory (honest omission).
      entries = [];
    } else {
      // EACCES / EPERM / ENOTDIR / any other read error → fail closed — an
      // unreadable authority directory is NEVER silently treated as empty.
      return {
        ok: false,
        result: toErrorResult([
          {
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message:
              `proofloop_review: prepare — cannot list tech-spec authority ` +
              `directory "${techSpecDir}" (${code ?? 'unknown'}: ${errMessage(err)}); ` +
              'unreadable authority artifacts fail closed.',
          },
        ]),
      };
    }
  }
  for (const name of entries) {
    const result = authorityRefEntry(canonicalRoot, path.join(resolvedTech, name));
    if (result.kind === 'escape') {
      return {
        ok: false,
        result: toErrorResult([
          {
            code: 'HOST.PATH_OUTSIDE_PROJECT',
            severity: 'error',
            message:
              `proofloop_review: prepare — authority artifact "${result.path}" ` +
              `resolves outside the trust root (${canonicalRoot}); a root-bound ` +
              'authority ref is required (symlink escapes fail closed).',
          },
        ]),
      };
    }
    if (result.kind === 'fail') {
      return {
        ok: false,
        result: toErrorResult([
          {
            code: 'RUNTIME.SCHEMA_MISMATCH',
            severity: 'error',
            message: `proofloop_review: prepare — ${result.message}.`,
          },
        ]),
      };
    }
    if (result.kind === 'entry') refs.push(result.entry);
  }
  return { ok: true, refs };
}

/** Build the canonical prepare fail-closed result (findings validated by S1). */
function failPrepare(
  findings: Parameters<typeof toErrorResult>[0],
): ReviewHandlerResult {
  return { result: toErrorResult(findings) };
}

/** Canonical schema/fail-closed finding for a boundary violation. */
function pathOutside(label: string, value: string, root: string): ReviewHandlerResult {
  return failPrepare([
    {
      code: 'HOST.PATH_OUTSIDE_PROJECT',
      severity: 'error',
      message:
        `proofloop_review: prepare — ${label} "${value}" resolves outside the ` +
        `trust root (${root}); the ReviewInput refs/paths must stay root-bound.`,
    },
  ]);
}

/**
 * Compact prepare summary text (fed to `renderCompact` for the FR-012 status
 * budget): review scope, stage id, git branch/snapshot, manifest path+digest,
 * tasks path, the gate receipt ref and the ref counts. Receipt digests are
 * bounded (digest only, never the payload/body).
 */
export function renderReviewPrepareText(input: StageReviewInput): string {
  const lines: string[] = [];
  lines.push(`Scope: ${input.review_scope}`);
  lines.push(`Stage: ${input.stage_id}`);
  lines.push(`Branch: ${input.branch}`);
  lines.push(`Snapshot: ${input.snapshot}`);
  lines.push(`Manifest: ${input.manifest_path} (${input.manifest_digest})`);
  lines.push(`Tasks: ${input.tasks_path}`);
  lines.push(
    `Gate receipt: ${input.stage_gate_receipt_ref?.ref ?? 'none'}` +
      (input.stage_gate_receipt_ref !== null && input.stage_gate_receipt_ref !== undefined
        ? ` (${input.stage_gate_receipt_ref.digest})`
        : ''),
  );
  lines.push(`CV receipts (${input.cv_receipt_refs.length})`);
  lines.push(`Risk facts (${input.risk_facts.length})`);
  lines.push(`Risk level: ${input.risk_level}`);
  lines.push(`Clean room: ${input.clean_room ? 'yes' : 'no'}`);
  return lines.join('\n');
}

/**
 * `prepare_stage_review` handler — read-only ReviewInput projection from
 * canonical persisted facts (Manifest + git + reconcile refs).
 *
 * Async because the git branch/HEAD facts are read through the runtime
 * process seam (`runProcess`, the same seam the doctor uses). The execute
 * awaits handlers, so the cooperative cancellation post-check still applies.
 */
export async function runReviewPrepare(
  input: ReviewResolvedArgs,
): Promise<ReviewHandlerResult> {
  // 1. TOCTOU identity re-verify of the runtime's default manifest/tasks reads.
  const reverified = reverifyStagePaths({
    projectRoot: input.projectRoot,
    stageId: input.stageId,
  });
  if (reverified !== null) {
    return { result: reverified };
  }

  // 2. Manifest path identity + content trust-root baseline (S2-F-001 round 1).
  const manifestPath = defaultManifestPath(input.projectRoot, input.stageId);
  const identity = reverifyManifestPathIdentity(input.projectRoot, manifestPath);
  if (!identity.ok) {
    return { result: identity.result };
  }
  const pre = checkManifestContentBaseline(input.projectRoot, identity.path);
  if (!pre.ok) {
    return { result: pre.result };
  }
  const manifestDigest = pre.baseline.digest;

  // 3. Canonical Manifest read + kernel validation (persisted facts source).
  let manifest: ValidatedManifest;
  try {
    manifest = validateManifest(
      JSON.parse(readFileSync(identity.path, 'utf-8')),
    );
  } catch (error) {
    return failPrepare([
      {
        code: 'DOMAIN.STAGE_NOT_FOUND',
        severity: 'error',
        message:
          `proofloop_review: prepare could not read the canonical manifest: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      },
    ]);
  }

  // 4. Reconcile read — the canonical persisted-facts source for per-slice CV
  //    receipts and the fail-closed chain/state guard. Error-level findings
  //    fail closed; recoverable warn findings are surfaced with ok:true.
  const reconciled = reconcileStage({
    projectRoot: input.projectRoot,
    stageId: input.stageId,
  });
  if (hasErrorFindings(reconciled.findings)) {
    return { result: toErrorResult(reconciled.findings) };
  }

  // 5. Stage Gate receipt ref (ref-only). A broken stage-gate chain fails
  //    closed (never trust a tampered gate fact).
  const gate = readReceiptCategory({
    projectRoot: input.projectRoot,
    category: 'stage-gate',
    stageId: input.stageId,
  });
  if (!gate.chainValid) {
    return failPrepare([
      {
        code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
        severity: 'error',
        message:
          `proofloop_review: prepare — stage-gate receipt chain is broken for ` +
          `stage "${input.stageId}"; no gate fact is derived.`,
      },
    ]);
  }
  let stageGateReceiptRef: StageReviewInput['stage_gate_receipt_ref'] = null;
  if (gate.latest !== null) {
    const gateEntry = makeReviewRefEntry(
      input.projectRoot,
      gate.latest.filePath,
      gate.latest.receipt.digest,
    );
    if (gateEntry === null) {
      return pathOutside('stage gate receipt ref', gate.latest.filePath, input.projectRoot);
    }
    stageGateReceiptRef = gateEntry;
  }

  // 6. Per-slice CV receipt refs (ref-only, ACTUAL persisted filePath — CV
  //    repair counterexample 2: the ref uses the receipt reader's real
  //    `latest.filePath`, never a synthesized `<digest>.json` string, so a
  //    renamed-but-valid receipt stays LOCATABLE). A broken CV chain fails
  //    closed (reconcile already blocks the CV fact; defense-in-depth re-check).
  const cvReceiptRefs: ReviewRefEntry[] = [];
  for (const slice of reconciled.slices) {
    const cvCat = readReceiptCategory({
      projectRoot: input.projectRoot,
      category: 'cv',
      stageId: input.stageId,
      sliceId: slice.slice_id,
    });
    if (!cvCat.chainValid) {
      return failPrepare([
        {
          code: 'RUNTIME.RECEIPT_CHAIN_BROKEN',
          severity: 'error',
          message:
            `proofloop_review: prepare — cv receipt chain is broken for slice ` +
            `"${slice.slice_id}" in stage "${input.stageId}"; no CV fact is derived.`,
        },
      ]);
    }
    if (cvCat.latest === null) continue;
    const cvEntry = makeReviewRefEntry(
      input.projectRoot,
      cvCat.latest.filePath,
      cvCat.latest.receipt.digest,
    );
    if (cvEntry === null) {
      return pathOutside(
        `cv receipt ref for slice ${slice.slice_id}`,
        cvCat.latest.filePath,
        input.projectRoot,
      );
    }
    cvReceiptRefs.push(cvEntry);
  }

  // 7. Git facts (branch + snapshot) through the runtime process seam — the
  //    same seam the doctor uses. Non-git / unborn HEAD fails closed.
  const branch = await runProcess({
    executable: 'git',
    args: ['rev-parse', '--abbrev-ref', 'HEAD'],
    cwd: input.projectRoot,
  });
  if (branch.exitCode !== 0) {
    return failPrepare([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          `proofloop_review: prepare could not read the git branch at ` +
          `${input.projectRoot}: ${branch.stderr.trim() || 'git unavailable or unborn HEAD'}`,
      },
    ]);
  }
  const head = await runProcess({
    executable: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: input.projectRoot,
  });
  if (head.exitCode !== 0) {
    return failPrepare([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          `proofloop_review: prepare could not resolve git HEAD at ` +
          `${input.projectRoot}: ${head.stderr.trim() || 'git unavailable or unborn HEAD'}`,
      },
    ]);
  }

  // 8. Post-read TOCTOU closure + final manifest path identity (S2-F-001
  //    rounds 2-3): a manifest swap during the reads discards the projection.
  const toctou = reverifyManifestContentAfterRead(
    input.projectRoot,
    identity.path,
    pre.baseline,
  );
  if (toctou !== null) {
    return { result: toctou };
  }
  const finalIdentity = reverifyManifestPathIdentity(input.projectRoot, identity.path);
  if (!finalIdentity.ok) {
    return { result: finalIdentity.result };
  }

  // 9. Build the ref-only ReviewInput projection (PO-S03-D-02): every field is
  //    sourced from canonical persisted facts — Manifest, git, reconcile refs,
  //    authority documents (PRD.md / tech-spec/*.md with content digests; a
  //    trust-root ESCAPE fails closed, CV repair counterexample 1), and the
  //    risk/clean-room facts (deriveStageRiskLevel / deriveCleanRoom). No
  //    field is fabricated, no verdict is computed, no Receipt body surfaces.
  const authorityResult = discoverAuthorityRefs(input.projectRoot);
  if (!authorityResult.ok) {
    return { result: authorityResult.result };
  }
  const reviewInput: StageReviewInput = {
    review_scope: 'stage',
    stage_id: input.stageId,
    stage_goal: manifest.stage_goal,
    stage_outcomes: [...manifest.outcomes],
    authority_refs: authorityResult.refs,
    branch: branch.stdout.trim(),
    snapshot: head.stdout.trim(),
    tasks_path: path.posix.normalize(
      path.relative(
        input.projectRoot,
        defaultTasksMdPath(input.projectRoot, input.stageId),
      ),
    ),
    manifest_path: path.posix.normalize(path.relative(input.projectRoot, identity.path)),
    manifest_digest: manifestDigest,
    stage_gate_receipt_ref: stageGateReceiptRef,
    cv_receipt_refs: cvReceiptRefs,
    risk_facts: [...manifest.risk_facts],
    risk_level: deriveStageRiskLevel(manifest.risk_facts),
    clean_room: deriveCleanRoom({
      receipt_chain_valid: reconciled.receipt_chain_valid,
      slices: reconciled.slices.map((s) => ({
        slice_id: s.slice_id,
        evidence_finalized: s.slice_evidence_finalized,
      })),
    }),
  };

  const result = successResult({
    data: { ...reviewInput },
    findings: capFindings(reconciled.findings),
  });
  return { result, statusText: renderReviewPrepareText(reviewInput) };
}
