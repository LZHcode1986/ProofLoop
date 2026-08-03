/**
 * @proofloop/opencode-plugin — proofloop_review `finalize_stage_review`
 * handler (S03-D-T01, PO-S03-D-01/03/04/05; CV repair
 * S03-D-REFPATH-POSTWRITE-TOCTOU-SCOPE-001).
 *
 * The finalize flow maps the host snake_case wire args
 * (`stage_id` / `verdict` / `summary`) to the canonical camelCase runtime
 * `StageReviewAdmissionRequest` (`{ type: 'stage_review', stageId, verdict,
 * summary }`) and dispatches IN-PROCESS to the runtime public seam
 * `admitStageReview` — the ONLY stage-review Receipt creation path (never a
 * CLI subprocess, never direct `writeReceipt` / `runAdmitPipeline` assembly,
 * AWI-006 forbidden shortcuts). The ACCEPTED/REPAIR semantics are
 * runtime-handled:
 *
 *   - `ACCEPTED` on stage UNDER_REVIEW → `STAGE_REVIEW_PASS` Receipt to
 *     `review/<stage>/` + reducer COMPLETE → COMPLETED;
 *   - `REPAIR` on stage UNDER_REVIEW → legal no-Receipt branch: reducer REOPEN
 *     → EXECUTING (in-memory `new_state`), a warn Finding
 *     (`DOMAIN.INVALID_TRANSITION`, recoverable) and NO Receipt — persisted
 *     facts / fresh reconcile are never fabricated (PO-S03-D-04);
 *   - wrong state / broken chain / invalid schema → structured rejection,
 *     no Receipt (PO-S03-D-05 fail-closed).
 *
 * Admission atomicity (CV repair counterexample 3 — FINALIZE POST-WRITE
 * TOCTOU): ALL hard verification (TOCTOU manifest path identity + manifest
 * content trust-root guard) runs BEFORE `admitStageReview`, so a verification
 * failure can never occur after the runtime write. The post-admission manifest
 * re-verify is DIAGNOSTIC-ONLY (S03-C-established closure, same semantics as
 * the accepted SPV admit): it never flips an admitted ACCEPTED/REPAIR result
 * to a failure while the STAGE_REVIEW_PASS receipt is already persisted — it
 * surfaces a warn finding when the manifest changed during the call. The
 * optional `ReviewFinalizeDeps` (`beforeAdmit` / `afterAdmit`) is the
 * documented test-only fault-injection seam for the CV concurrent / post-write
 * TOCTOU proof (production never passes it).
 *
 * Fail-closed ordering:
 *   1. wire-level verdict/summary validation;
 *   2. TOCTOU identity re-verify of the runtime's default manifest/tasks reads
 *      (`reverifyStagePaths`);
 *   3. manifest path identity + content trust-root baseline (S2-F-001) — ALL
 *      hard verification completes BEFORE the runtime write;
 *   4. in-process `admitStageReview` dispatch (the ONLY write path);
 *   5. post-admission manifest re-verify — DIAGNOSTIC ONLY (warn finding,
 *      never flips an admitted result);
 *   6. the canonical AdmitResult projection — `{ accepted, receipt_ref,
 *      new_state, findings }` with `receipt_ref` projected to exactly
 *      `{ ref, digest }` (root-relative `review/<stage>/<digest>.json`) and
 *      ToolResult refs exactly `{ ref, digest }` — never a Receipt payload.
 *
 * Every failure is a canonical kernel Finding via `toErrorResult` — never a
 * bare exception.
 */

import path from 'node:path';
import { admitStageReview, defaultManifestPath } from '@proofloop/runtime';
import type { AdmitResult, StageReviewAdmissionRequest } from '@proofloop/runtime';
import type { Finding } from '@proofloop/kernel';
import { projectReceiptRef, successResult, toErrorResult } from '../tool-result.js';
import type { ReceiptRef, ToolResult } from '../tool-result.js';
import {
  checkManifestContentBaseline,
  reverifyManifestContentAfterRead,
  reverifyManifestPathIdentity,
} from '../manifest-guard.js';
import type { ManifestContentBaseline } from '../manifest-guard.js';
import {
  capFindings,
  hasErrorFindings,
  projectAdmitNewState,
  reverifyStagePaths,
} from './stage-admit-common.js';
import type { ReviewHandlerResult, ReviewResolvedArgs } from './review.js';

/**
 * Root-bound RELATIVE receipt ref for an admitted stage review: the kernel
 * writer persists `<digest>.json` in `.proofloop/receipts/review/<stage>/`
 * (the runtime `reviewReceiptDir` layout), so the canonical ref is the
 * root-relative path.
 */
export function stageReviewReceiptRef(stageId: string, digest: string): string {
  return path.posix.join('.proofloop', 'receipts', 'review', stageId, `${digest}.json`);
}

/**
 * Project a runtime `AdmitResult` into the canonical ToolResult `data`:
 * `{ accepted, receipt_ref, new_state, findings }`. `receipt_ref` is projected
 * to exactly `{ ref, digest }` (root-relative review category path); the full
 * Receipt payload never surfaces. `new_state` is the bounded reconcile
 * projection (never the full reconcile object). `diagnostics` (optional) are
 * DIAGNOSTIC-ONLY warn findings appended after the runtime admit (CV repair —
 * they never change `ok` or the accepted/receipt_ref projection).
 */
export function projectStageReviewAdmitData(
  result: AdmitResult,
  stageId: string,
  diagnostics: readonly Finding[] = [],
): Record<string, unknown> {
  return {
    accepted: result.accepted,
    receipt_ref:
      result.receipt_ref === null
        ? null
        : projectReceiptRef(stageReviewReceiptRef(stageId, result.receipt_ref), {
            digest: result.receipt_ref,
          }),
    new_state: projectAdmitNewState(result.new_state),
    findings: [...result.findings, ...diagnostics],
  };
}

/**
 * Project a runtime `AdmitResult` into the unified ToolResult:
 *   - `data` — the canonical AdmitResult projection;
 *   - `refs` — exactly `{ ref, digest }` (the full Receipt payload never
 *     leaks, OUT-S1-05 / FR-012);
 *   - `ok` — true only when accepted AND no error-level Finding (a refused
 *     admit or a broken chain is a fail-closed ToolResult; the REPAIR
 *     no-Receipt branch is `ok:true` because its warn Finding is recoverable).
 *
 * `diagnostics` (optional) are DIAGNOSTIC-ONLY warn findings (CV repair —
 * post-admission manifest re-verify): a warn finding is never error-level, so
 * an admitted result stays ok:true with its persisted receipt.
 */
export function projectStageReviewToolResult(
  result: AdmitResult,
  stageId: string,
  diagnostics: readonly Finding[] = [],
): ToolResult {
  const data = projectStageReviewAdmitData(result, stageId, diagnostics);
  const refs: ReceiptRef[] =
    result.accepted && result.receipt_ref !== null
      ? [
          projectReceiptRef(stageReviewReceiptRef(stageId, result.receipt_ref), {
            digest: result.receipt_ref,
          }),
        ]
      : [];
  const findings = capFindings([...result.findings, ...diagnostics]);
  const base = successResult({ data, findings, refs });
  const ok = result.accepted && !hasErrorFindings(findings);
  return ok ? base : { ...base, ok: false };
}

/**
 * Optional dependency seam for `runReviewFinalize`. Production callers never
 * pass it (the review tool default handler calls `runReviewFinalize(input)`
 * with no deps); tests use `beforeAdmit` / `afterAdmit` to deterministically
 * inject a manifest swap around the runtime admit — the documented
 * fault-injection seam for the CV post-write TOCTOU / concurrency proof
 * (S03-D-REFPATH-POSTWRITE-TOCTOU-SCOPE-001).
 */
export interface ReviewFinalizeDeps {
  /**
   * Test-only hook: runs AFTER all pre-admission verification and IMMEDIATELY
   * BEFORE `admitStageReview`. A manifest swap injected here must be caught by
   * the runtime stage preconditions (a changed/invalid manifest makes the
   * reconcile refuse) → no write. Production never supplies this.
   */
  beforeAdmit?: () => void;
  /**
   * Test-only hook: runs AFTER `admitStageReview` returns and IMMEDIATELY
   * BEFORE the post-admission DIAGNOSTIC manifest re-verify. A manifest swap
   * injected here must surface only a warn diagnostic — the already-persisted
   * STAGE_REVIEW_PASS receipt is NEVER rolled back and the result NEVER flips
   * to a failure (CV repair). Production never supplies this.
   */
  afterAdmit?: () => void;
}

/**
 * Post-admission manifest identity verification — DIAGNOSTIC ONLY (CV repair
 * S03-D-REFPATH-POSTWRITE-TOCTOU-SCOPE-001, counterexample 3).
 *
 * All hard verification (path identity + manifest content trust-root guard)
 * runs BEFORE the runtime write, so a verification failure can never occur
 * after the write. The runtime `admitStageReview` precheck verifies the stage
 * derives UNDER_REVIEW AT ADMISSION (snapshot semantics — a manifest change
 * after admission is a NEW state, never a corruption of the admitted receipt).
 * The post-admission re-verify therefore NEVER flips an admitted result to
 * accepted:false (a receipt was already persisted); it surfaces a warn
 * diagnostic only.
 *
 * Returns warn findings (empty when the manifest is unchanged). A warn
 * finding is never error-level, so `ok`/`accepted` stay true for an admitted
 * result (projectStageReviewToolResult appends them without changing ok).
 */
function diagnosticPostAdmission(
  canonicalRoot: string,
  manifestPath: string,
  baseline: ManifestContentBaseline,
): readonly Finding[] {
  const findings: Finding[] = [];
  const toctou = reverifyManifestContentAfterRead(canonicalRoot, manifestPath, baseline);
  if (toctou !== null) {
    findings.push({
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'warn',
      message:
        'proofloop_review: manifest content changed during the stage-review ' +
        'admit (post-admission diagnostic). The admitted STAGE_REVIEW_PASS ' +
        'receipt is the completed durable outcome; the observed change is a ' +
        'new state, never a corruption of the admitted receipt.',
    });
  }
  const identity = reverifyManifestPathIdentity(canonicalRoot, manifestPath);
  if (!identity.ok) {
    findings.push({
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'warn',
      message:
        'proofloop_review: manifest path was redirected after the stage-review ' +
        'admit (post-admission diagnostic). The admitted STAGE_REVIEW_PASS ' +
        'receipt is the completed durable outcome; the observed redirect is a ' +
        'new state, never a corruption of the admitted receipt.',
    });
  }
  return findings;
}

/**
 * Compact finalize summary text (fed to `renderCompact` for the FR-012
 * status budget): accepted flag, bounded receipt digest (never the Receipt
 * body) and the post-admit stage state from the projected `new_state`.
 */
export function renderReviewFinalizeText(result: ToolResult): string {
  const data = result.data as
    | {
        accepted?: unknown;
        receipt_ref?: { digest?: unknown } | null;
        new_state?: { stage_state?: unknown } | null;
      }
    | undefined;
  const lines: string[] = [];
  lines.push(`Accepted: ${data?.accepted === true ? 'true' : 'false'}`);
  const digest =
    data?.receipt_ref !== null &&
    data?.receipt_ref !== undefined &&
    typeof data.receipt_ref === 'object' &&
    typeof data.receipt_ref.digest === 'string'
      ? data.receipt_ref.digest
      : undefined;
  lines.push(`Receipt: ${digest ?? 'none'}`);
  const state = data?.new_state;
  if (state !== null && state !== undefined && typeof state === 'object') {
    if (typeof state.stage_state === 'string') {
      lines.push(`Stage: ${state.stage_state}`);
    }
  }
  return lines.join('\n');
}

/**
 * `finalize_stage_review` handler — maps the host wire args to the canonical
 * `StageReviewAdmissionRequest` and dispatches IN-PROCESS to the runtime
 * `admitStageReview` seam (the ONLY stage-review Receipt creation path).
 *
 * CV repair (counterexample 3): ALL hard verification completes BEFORE the
 * runtime write; the post-admission manifest re-verify is DIAGNOSTIC-ONLY
 * (warn finding, never flips an admitted result with a persisted receipt).
 */
export function runReviewFinalize(
  input: ReviewResolvedArgs,
  deps?: ReviewFinalizeDeps,
): ReviewHandlerResult {
  // Fail-closed second validation: the runtime request requires a closed
  // verdict and a non-empty summary (admission-request.ts expectString).
  if (input.verdict === undefined) {
    return {
      result: toErrorResult([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'proofloop_review: finalize_stage_review requires `verdict` ' +
            '(one of: ACCEPTED, REPAIR).',
        },
      ]),
    };
  }
  if (input.summary === undefined || input.summary.length === 0) {
    return {
      result: toErrorResult([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            'proofloop_review: finalize_stage_review requires a non-empty ' +
            '`summary` (the StageReviewAdmissionRequest schema requires it).',
        },
      ]),
    };
  }

  // 1. TOCTOU identity re-verify of the runtime's default manifest/tasks reads.
  const reverified = reverifyStagePaths({
    projectRoot: input.projectRoot,
    stageId: input.stageId,
  });
  if (reverified !== null) {
    return { result: reverified };
  }

  // 2. Manifest path identity + content trust-root baseline (S2-F-001 round 1).
  //    ALL hard verification completes BEFORE the runtime write — a
  //    verification failure can never occur after the write (CV repair).
  const manifestPath = defaultManifestPath(input.projectRoot, input.stageId);
  const identity = reverifyManifestPathIdentity(input.projectRoot, manifestPath);
  if (!identity.ok) {
    return { result: identity.result };
  }
  const pre = checkManifestContentBaseline(input.projectRoot, identity.path);
  if (!pre.ok) {
    return { result: pre.result };
  }

  // 3. Canonical request + in-process runtime dispatch (the ONLY write path).
  const request: StageReviewAdmissionRequest = {
    type: 'stage_review',
    stageId: input.stageId,
    verdict: input.verdict,
    summary: input.summary,
  };

  // 3b. Documented test-only fault-injection seam (production never passes it).
  deps?.beforeAdmit?.();

  const admit = admitStageReview(request, { projectRoot: input.projectRoot });

  // 3c. Documented test-only fault-injection seam (production never passes it).
  deps?.afterAdmit?.();

  // 4. Post-admission manifest re-verify — DIAGNOSTIC ONLY (CV repair). The
  //    runtime result (accepted/receipt_ref/new_state) is NEVER discarded by
  //    this check: a warn finding is appended when the manifest changed, and
  //    an admitted result stays ok:true with its persisted receipt.
  const diagnostics = diagnosticPostAdmission(input.projectRoot, identity.path, pre.baseline);

  // 5. Canonical AdmitResult projection (with the diagnostic warn findings).
  const result = projectStageReviewToolResult(admit, input.stageId, diagnostics);
  return { result, statusText: renderReviewFinalizeText(result) };
}
