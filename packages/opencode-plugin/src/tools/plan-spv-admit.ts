/**
 * @proofloop/opencode-plugin — proofloop_plan(admit_spv_result) contract
 * layer (S03-C-T01, PO-S03-C-01 primary; PO-S03-C-04 partial).
 *
 * The closed SPV_PASS adapter boundary between the host snake_case wire args
 * and the canonical runtime camelCase `SpvResultAdmissionRequest`:
 *
 *   - the host `verdict` is a WIRE-LEVEL CLOSED GATE: only `SPV_PASS` is
 *     accepted; a missing / any other verdict value fails closed with a
 *     canonical RUNTIME.SCHEMA_MISMATCH Finding BEFORE any runtime call. The
 *     runtime `SpvResultAdmissionRequest` has NO `verdict` member — the gate
 *     is never passed into the request (`{ type: 'spv_result', stageId,
 *     manifestDigest, summary }` only, admission-request.ts#SpvResultAdmissionRequest).
 *   - root/field validation: `stage_id` canonical `/^S\d+$/`, `manifest_digest`
 *     64-hex binding, `summary` REQUIRED non-empty (CV repair — the runtime
 *     `SpvResultAdmissionRequest` closed schema requires a non-empty summary,
 *     so the wire makes it required; a missing/empty summary is a canonical
 *     Finding before any runtime call, never a silent empty-string request).
 *   - SPV admission atomicity (CV repair CV-S03-C-POSTWRITE-TOCTOU-001): ALL
 *     hard verification (path identity + manifest content trust-root guard)
 *     runs BEFORE `admitSpvResult`, so a verification failure can never occur
 *     after the runtime write. The runtime `admitSpvResult` precheck binds the
 *     canonical manifest digest AT ADMISSION (snapshot semantics — a manifest
 *     change after admission is a NEW state, never a corruption of the
 *     admitted receipt). The post-admission manifest re-verify is
 *     DIAGNOSTIC-ONLY: it never flips an admitted result to accepted:false
 *     (a receipt was already persisted) — it surfaces a warn finding when the
 *     manifest changed during the call. The optional `PlanSpvAdmitDeps`
 *     (`beforeAdmit` / `afterAdmit`) is the documented test-only fault-injection
 *     seam for the CV concurrent / post-write TOCTOU proof (production never
 *     passes it).
 *   - the runtime admit dispatch is `admitSpvResult` IN-PROCESS (admit-pipeline
 *     PO-S03-H-02) — never a CLI subprocess, never direct
 *     writeReceipt/runAdmitPipeline assembly. The SPV precheck requires the
 *     stage to be derived PLANNING (a persisted legal STAGE_PLAN fact — S3
 *     NEVER exposes a hidden `stage_plan` operation) and the request
 *     manifestDigest to bind the canonical stage manifest digest; a valid
 *     admit writes exactly one SPV_PASS Receipt to `plan/<stage>/` and the
 *     reducer FINALIZE_PLAN advances PLANNING → READY.
 *   - shared boundary reuse (S03-B): the TOCTOU identity re-verify
 *     (`reverifyStagePaths`), the manifest content trust-root guard
 *     (S2-F-001), the canonical AdmitResult projection (`projectAdmitNewState`
 *     / `renderStageAdmitText`) and the finding budget seams come from
 *     `stage-admit-common.ts`. The plan receipt category ref is the
 *     stage-level `plan/<stage>/` path (plan category, no slice component).
 *   - ToolResult refs stay exactly `{ ref, digest }` (never a Receipt
 *     payload); a refused admit (accepted:false) or any error-level Finding is
 *     a fail-closed ToolResult (ok:false) with the canonical runtime Finding
 *     and `receipt_ref: null`.
 */

import path from 'node:path';
import { admitSpvResult, defaultManifestPath } from '@proofloop/runtime';
import type { AdmitResult, SpvResultAdmissionRequest } from '@proofloop/runtime';
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
  renderStageAdmitText,
  reverifyStagePaths,
} from './stage-admit-common.js';
import { assertPlanProjectRootArg } from './plan-common.js';
import { CANONICAL_STAGE_ID } from './stage.js';

/** The ONLY legal wire verdict for admit_spv_result (closed gate, §1.1). */
export const SPV_VERDICT_GATE = 'SPV_PASS' as const;

/** Canonical manifest digest binding: exactly 64 lowercase hex characters. */
export const MANIFEST_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Root-bound RELATIVE receipt ref for an SPV_PASS admit: the kernel writer
 * persists `<digest>.json` in the stage-level `plan/<stage>/` category
 * directory (`<projectRoot>/.proofloop/receipts/plan/<stage>/`), so the
 * canonical ref is the root-relative path
 * (e.g. `.proofloop/receipts/plan/S03/<digest>.json`).
 */
export function planSpvReceiptRef(stageId: string, digest: string): string {
  return path.posix.join('.proofloop', 'receipts', 'plan', stageId, `${digest}.json`);
}

/**
 * Project a runtime `admitSpvResult` `AdmitResult` into the unified ToolResult:
 *   - `data` — the canonical AdmitResult projection `{ accepted, receipt_ref,
 *     new_state, findings }` (receipt_ref projected to `{ ref, digest }`);
 *   - `refs` — exactly `{ ref, digest }` (the full Receipt payload never
 *     leaks, OUT-S1-05 / FR-012);
 *   - `ok` — true only when accepted AND no error-level Finding (a refused
 *     admit or a broken chain is a fail-closed ToolResult).
 *
 * `diagnostics` (optional) are DIAGNOSTIC-ONLY warn findings appended after
 * the runtime admit (CV repair CV-S03-C-POSTWRITE-TOCTOU-001): they NEVER
 * change `ok` or the accepted/receipt_ref projection — a warn finding is not
 * error-level, so an admitted result stays ok:true with its persisted receipt.
 */
export function projectPlanSpvAdmitToolResult(
  result: AdmitResult,
  stageId: string,
  diagnostics: readonly Finding[] = [],
): ToolResult {
  const receiptRef =
    result.receipt_ref === null
      ? null
      : projectReceiptRef(planSpvReceiptRef(stageId, result.receipt_ref), {
          digest: result.receipt_ref,
        });
  const combinedFindings = [...result.findings, ...diagnostics];
  const data = {
    accepted: result.accepted,
    receipt_ref: receiptRef,
    new_state: projectAdmitNewState(result.new_state),
    findings: combinedFindings,
  };
  const refs: ReceiptRef[] =
    result.accepted && result.receipt_ref !== null
      ? [
          projectReceiptRef(planSpvReceiptRef(stageId, result.receipt_ref), {
            digest: result.receipt_ref,
          }),
        ]
      : [];
  const findings = capFindings(combinedFindings);
  const base = successResult({ data, findings, refs });
  const ok = result.accepted && !hasErrorFindings(findings);
  return ok ? base : { ...base, ok: false };
}

/**
 * Project a pre-runtime SPV rejection into the SAME canonical AdmitResult
 * shape the runtime result uses: `{ accepted: false, receipt_ref: null,
 * new_state: null, findings }` (T02 parity — every refusal fixture exposes
 * the canonical accepted/receipt_ref/findings fields, matching the CLI oracle
 * contract; `new_state: null` is the pre-reconcile marker, identical to a
 * runtime schema rejection). The findings are the canonical guard/runtime
 * Findings, capped at the S1 budget.
 */
export function projectPlanSpvReject(findings: readonly Finding[]): ToolResult {
  const capped = capFindings(findings);
  const base = successResult({
    data: { accepted: false, receipt_ref: null, new_state: null, findings: capped },
    findings: capped,
  });
  return { ...base, ok: false };
}

/** Wrap a fail-closed SPV outcome in the canonical AdmitResult projection. */
function rejectSpv(result: ToolResult): { result: ToolResult; statusText: string } {
  const projected = projectPlanSpvReject(result.findings);
  return { result: projected, statusText: renderStageAdmitText(projected) };
}

/** Build a canonical fail-closed adapter result (findings validated by S1). */
function failAdapter(message: string): { ok: false; result: ToolResult } {
  return {
    ok: false,
    result: toErrorResult([
      { code: 'RUNTIME.SCHEMA_MISMATCH', severity: 'error', message },
    ]),
  };
}

/** Outcome of the SPV field validation (fail-closed, before any runtime call). */
export type PlanSpvFieldResult =
  | { ok: true; stageId: string; manifestDigest: string; summary: string }
  | { ok: false; result: ToolResult };

/**
 * Root/field validation of the host admit_spv_result wire args (PO-S03-C-01;
 * CV repair — `summary` REQUIRED non-empty): canonical `stage_id`, 64-hex
 * `manifest_digest`, non-empty `summary` and the closed `verdict: 'SPV_PASS'`
 * wire gate. Any failure is a canonical Finding BEFORE any runtime call.
 */
export function validatePlanSpvFields(rawArgs: unknown): PlanSpvFieldResult {
  if (typeof rawArgs !== 'object' || rawArgs === null) {
    return failAdapter(
      'proofloop_plan: args must be an object carrying `stage_id`, `manifest_digest`, `summary`, `verdict`.',
    );
  }
  const args = rawArgs as Record<string, unknown>;

  const stageId = args['stage_id'];
  if (typeof stageId !== 'string' || stageId.length === 0) {
    return failAdapter(
      'proofloop_plan: `stage_id` is required for admit_spv_result and must be a non-empty string.',
    );
  }
  if (!CANONICAL_STAGE_ID.test(stageId)) {
    return failAdapter(
      `proofloop_plan: stage_id "${stageId}" is not a canonical stage id ` +
        '(expected /^S\\d+$/, e.g. S03); path traversal / absolute paths are ' +
        'rejected before any runtime call.',
    );
  }

  const manifestDigest = args['manifest_digest'];
  if (typeof manifestDigest !== 'string' || !MANIFEST_DIGEST_PATTERN.test(manifestDigest)) {
    return failAdapter(
      'proofloop_plan: `manifest_digest` is required for admit_spv_result and must be a 64-hex string.',
    );
  }

  // CV repair (counterexample 2): the runtime `SpvResultAdmissionRequest`
  // closed schema REQUIRES a non-empty summary, so the wire makes it required
  // — a missing/empty summary is a canonical Finding before any runtime call,
  // never a silent empty-string request.
  const summaryRaw = args['summary'];
  if (typeof summaryRaw !== 'string' || summaryRaw.length === 0) {
    return failAdapter(
      'proofloop_plan: `summary` is required for admit_spv_result and must be a non-empty string.',
    );
  }

  // Closed SPV_PASS wire gate: the runtime request has NO `verdict` member —
  // the gate is enforced here and the value never enters the request.
  if (args['verdict'] !== SPV_VERDICT_GATE) {
    const label =
      args['verdict'] === undefined ? '(missing)' : JSON.stringify(args['verdict']);
    return failAdapter(
      `proofloop_plan: verdict must be exactly "SPV_PASS" for admit_spv_result ` +
        `(closed wire gate); got ${label}. The SPV_PASS gate is a wire-level gate ` +
        'and is never passed into the runtime request.',
    );
  }

  return { ok: true, stageId, manifestDigest, summary: summaryRaw };
}

/**
 * Optional dependency seam for `runPlanSpvAdmit`. Production callers never
 * pass it (the plan tool default handler calls `runPlanSpvAdmit(root, args)`
 * with no deps); tests use `beforeAdmit` / `afterAdmit` to deterministically
 * inject a manifest swap around the runtime admit — the documented
 * fault-injection seam for the CV post-write TOCTOU / concurrency proof
 * (CV-S03-C-POSTWRITE-TOCTOU-001).
 */
export interface PlanSpvAdmitDeps {
  /**
   * Test-only hook: runs AFTER all pre-admission verification and IMMEDIATELY
   * BEFORE `admitSpvResult`. A manifest swap injected here must be caught by
   * the runtime's admission-time digest binding (snapshot semantics) → no
   * write. Production never supplies this.
   */
  beforeAdmit?: () => void;
  /**
   * Test-only hook: runs AFTER `admitSpvResult` returns and IMMEDIATELY BEFORE
   * the post-admission DIAGNOSTIC manifest re-verify. A manifest swap injected
   * here must surface only a warn diagnostic — the already-persisted receipt
   * is NEVER rolled back and the result NEVER flips to accepted:false.
   * Production never supplies this.
   */
  afterAdmit?: () => void;
}

/**
 * Post-admission manifest identity verification — DIAGNOSTIC ONLY (CV
 * CV-S03-C-POSTWRITE-TOCTOU-001 repair, option (a) REORDER).
 *
 * All hard verification (path identity + manifest content trust-root guard)
 * runs BEFORE the runtime write, so a verification failure can never occur
 * after the write. The runtime `admitSpvResult` digest binding is SNAPSHOT
 * semantics: the SPV_PASS receipt records the manifest digest captured at
 * admission time, so a manifest change observed AFTER admission is a NEW
 * state — never a corruption of the admitted receipt. The post-admission
 * re-verify therefore NEVER flips an admitted result to accepted:false (a
 * receipt was already persisted); it surfaces a warn diagnostic only.
 *
 * Returns warn findings (empty when the manifest is unchanged). A warn
 * finding is never error-level, so `ok`/`accepted` stay true for an admitted
 * result (projectPlanSpvAdmitToolResult appends them without changing ok).
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
        'proofloop_plan: manifest content changed during the SPV admit ' +
        '(post-admission diagnostic). The admitted SPV_PASS receipt is bound ' +
        'to the manifest digest captured at admission (snapshot semantics); ' +
        'the observed change is a new state, not a corruption of the admitted ' +
        'receipt.',
    });
  }
  const identity = reverifyManifestPathIdentity(canonicalRoot, manifestPath);
  if (!identity.ok) {
    findings.push({
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'warn',
      message:
        'proofloop_plan: manifest path was redirected after the SPV admit ' +
        '(post-admission diagnostic). The admitted SPV_PASS receipt is bound ' +
        'to the digest captured at admission; the observed redirect is a new ' +
        'state, not a corruption of the admitted receipt.',
    });
  }
  return findings;
}

/**
 * In-process SPV admit adapter: root/field validation → TOCTOU identity
 * re-verify → manifest content trust-root guard → the explicit snake_case →
 * camelCase `SpvResultAdmissionRequest` mapping → the runtime `admitSpvResult`
 * dispatch (the ONLY Receipt creation path) → the canonical AdmitResult
 * projection with a DIAGNOSTIC-ONLY post-admission manifest re-verify (CV
 * repair — never flips an admitted result; see `diagnosticPostAdmission`).
 */
export function runPlanSpvAdmit(
  canonicalRoot: string,
  rawArgs: unknown,
  deps?: PlanSpvAdmitDeps,
): { result: ToolResult; statusText: string } {
  // 1. project_root consistency assertion (ADR-004; mismatch →
  //    HOST.PROJECT_NOT_TRUSTED, never overrides the trust root). Every
  //    failure is projected into the canonical AdmitResult shape
  //    ({ accepted:false, receipt_ref:null, new_state:null, findings }) so the
  //    host output stays parity-verifiable on every refusal fixture.
  const rootAssertion = assertPlanProjectRootArg(canonicalRoot, rawArgs);
  if (rootAssertion !== null) {
    return rejectSpv(rootAssertion);
  }

  // 2. Root/field validation (closed SPV_PASS gate, canonical stage id, 64-hex
  //    manifest digest, REQUIRED non-empty summary) — canonical Finding before
  //    any runtime call.
  const fields = validatePlanSpvFields(rawArgs);
  if (!fields.ok) {
    return rejectSpv(fields.result);
  }

  // 3. TOCTOU identity re-verify of the runtime's default manifest/tasks reads.
  const reverified = reverifyStagePaths({
    projectRoot: canonicalRoot,
    stageId: fields.stageId,
  });
  if (reverified !== null) {
    return rejectSpv(reverified);
  }

  // 4. Manifest content trust-root guard (S2-F-001 round 1 + path identity).
  //    ALL hard verification completes BEFORE the runtime write — a
  //    verification failure can never occur after the write (CV repair).
  const manifestPath = defaultManifestPath(canonicalRoot, fields.stageId);
  const identity = reverifyManifestPathIdentity(canonicalRoot, manifestPath);
  if (!identity.ok) {
    return rejectSpv(identity.result);
  }
  const pre = checkManifestContentBaseline(canonicalRoot, identity.path);
  if (!pre.ok) {
    return rejectSpv(pre.result);
  }

  // 5. Closed SPV_PASS adapter: the ONLY runtime request shape. The host
  //    `verdict` gate is consumed above and never passed into the request —
  //    unknown host fields never enter the closed union.
  const request: SpvResultAdmissionRequest = {
    type: 'spv_result',
    stageId: fields.stageId,
    manifestDigest: fields.manifestDigest,
    summary: fields.summary,
  };

  // 5b. Documented test-only fault-injection seam (production never passes it).
  deps?.beforeAdmit?.();

  // 6. Runtime admit dispatch — the ONLY Receipt creation path
  //    (admitSpvResult, PO-S03-H-02). The runtime precheck binds the manifest
  //    digest at admission (snapshot semantics) and refuses a changed/digest-
  //    mismatched manifest BEFORE writing. Synchronous: an abort surfaced
  //    during the call is observed by the execute post-check.
  const admit = admitSpvResult(request, { projectRoot: canonicalRoot });

  // 6b. Documented test-only fault-injection seam (production never passes it).
  deps?.afterAdmit?.();

  // 7. Post-admission manifest re-verify — DIAGNOSTIC ONLY (CV repair). The
  //    runtime result (accepted/receipt_ref/new_state) is NEVER discarded by
  //    this check: a warn finding is appended when the manifest changed, and
  //    an admitted result stays ok:true with its persisted receipt.
  const diagnostics = diagnosticPostAdmission(canonicalRoot, identity.path, pre.baseline);

  // 8. Canonical AdmitResult projection (with the diagnostic warn findings).
  const result = projectPlanSpvAdmitToolResult(admit, fields.stageId, diagnostics);
  return { result, statusText: renderStageAdmitText(result) };
}
