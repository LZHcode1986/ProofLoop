/**
 * @proofloop/opencode-plugin — proofloop_stage S3 admit operation handlers
 * (S03-B-T01, PO-S03-B-01; no-write/abort partial PO-S03-B-04; CV repair
 * STAGE_ADMIT_POSTWRITE_TOCTOU_FAILURE_WITH_PERSISTED_RECEIPT).
 *
 * The four admit operations dispatch IN-PROCESS to the runtime library seams
 * (`admitWorkerResult` / `admitCVResult` / `admitSliceCommit` /
 * `admitIntegration` from `@proofloop/runtime`) — never a CLI subprocess,
 * never direct `writeReceipt` / `runAdmitPipeline` assembly. The runtime
 * methods are the ONLY Receipt creation path (AWI-006 forbidden shortcuts).
 *
 * Fail-closed ordering (contract-state-matrix.md#§1.2 / S2 boundary reuse):
 *   1. TOCTOU identity re-verify of the runtime's default manifest/tasks reads
 *      (`reverifyStagePaths`, shared with the S2 status/next handlers);
 *   2. manifest content trust-root guard (`checkManifestContentBaseline` /
 *      `reverifyManifestPathIdentity` — S2-F-001: the runtime derives read
 *      paths from manifest CONTENT, so a malicious manifest is rejected BEFORE
 *      any runtime call);
 *   3. path-valued field guard (`guardAdmitPathFields` — envelope
 *      evidenceRef / changedFiles / integration_ref root-bound +
 *      canonicalized; outside-root / symlink-escape →
 *      HOST.PATH_OUTSIDE_PROJECT);
 *   4. the explicit snake_case → camelCase `AdmissionRequest` mapper
 *      (`mapHostArgsToAdmissionRequest` — outer/inner binding, closed union,
 *      no fabricated integrationRef);
 *   5. the runtime admit dispatch (state preconditions, Receipt write, chain
 *      verification) — the ONLY write path;
 *   6. post-admission manifest re-verify — DIAGNOSTIC ONLY (CV repair
 *      STAGE_ADMIT_POSTWRITE_TOCTOU_FAILURE_WITH_PERSISTED_RECEIPT, the
 *      S03-C/S03-D-established closure): ALL hard verification completes
 *      BEFORE the runtime write, so a verification failure can never occur
 *      after the write. A manifest/path change observed AFTER the runtime
 *      admit NEVER flips an admitted result to a failure while its Receipt is
 *      already persisted — it surfaces a warn finding only (snapshot-at-
 *      admission semantics; the admitted Receipt is the completed durable
 *      outcome, same as the accepted SPV admit in plan-spv-admit.ts and the
 *      accepted stage review in review-finalize.ts);
 *   7. canonical AdmitResult projection (`accepted`, `receipt_ref` as
 *      `{ref, digest}`, bounded `new_state`, `findings`) with ToolResult refs
 *      exactly `{ ref, digest }` — never a Receipt payload.
 *
 * A refused admit (accepted:false) or any error-level Finding is a fail-closed
 * ToolResult (ok:false) with the canonical runtime Finding — the ToolResult
 * `data` still carries the canonical AdmitResult projection.
 */

import {
  admitCVResult,
  admitIntegration,
  admitSliceCommit,
  admitWorkerResult,
  defaultManifestPath,
} from '@proofloop/runtime';
import type { AdmissionDeps, AdmissionRequest, AdmitResult } from '@proofloop/runtime';
import type { Finding } from '@proofloop/kernel';
import { successResult, projectReceiptRef, toErrorResult } from '../tool-result.js';
import type { ReceiptRef, ToolResult } from '../tool-result.js';
import type { LoggerAdapter } from '../adapters/logger.js';
import {
  checkManifestContentBaseline,
  reverifyManifestContentAfterRead,
  reverifyManifestPathIdentity,
} from '../manifest-guard.js';
import type { ManifestContentBaseline } from '../manifest-guard.js';
import type { StageHandlerResult, StageResolvedArgs } from './stage.js';
import type { StageAdmitOperation } from './stage-admit-common.js';
import {
  admitReceiptRef,
  capFindings,
  guardAdmitPathFields,
  hasErrorFindings,
  mapHostArgsToAdmissionRequest,
  projectAdmitResultData,
  renderStageAdmitText,
  reverifyStagePaths,
} from './stage-admit-common.js';

/**
 * Dispatch one admit operation through the matching runtime public seam — the
 * ONLY Receipt creation path (AWI-006 forbidden shortcuts: no direct file
 * writes, no pipeline bypass, no CLI).
 */
function dispatchAdmit(request: AdmissionRequest, projectRoot: string): AdmitResult {
  const deps: AdmissionDeps = { projectRoot };
  switch (request.type) {
    case 'worker_result':
      return admitWorkerResult(request, deps);
    case 'cv_result':
      return admitCVResult(request, deps);
    case 'slice_commit':
      return admitSliceCommit(request, deps);
    case 'integration':
      return admitIntegration(request, deps);
    default:
      // The mapper only produces the four admit members; this is a defensive
      // fail-closed guard for a future extension (never a silent pass).
      throw new Error(
        `proofloop_stage: admit dispatch reached an unhandled request type "${String(request.type)}"`,
      );
  }
}

/**
 * Project a runtime `AdmitResult` into the unified ToolResult:
 *   - `data` — the canonical AdmitResult projection `{ accepted, receipt_ref,
 *     new_state, findings }` (receipt_ref projected to `{ ref, digest }`);
 *   - `refs` — exactly `{ ref, digest }` (the full Receipt payload never
 *     leaks, OUT-S1-05 / FR-012);
 *   - `ok` — true only when accepted AND no error-level Finding (a refused
 *     admit or a broken chain is a fail-closed ToolResult).
 *
 * `diagnostics` (optional) are DIAGNOSTIC-ONLY warn findings appended after
 * the runtime admit (CV repair STAGE_ADMIT_POSTWRITE_TOCTOU_FAILURE_WITH_
 * PERSISTED_RECEIPT — the S03-C/S03-D-established closure): a warn finding is
 * never error-level, so an admitted result stays ok:true with its persisted
 * receipt; a post-admission manifest change never flips it to a failure.
 */
export function projectAdmitToolResult(
  result: AdmitResult,
  operation: StageAdmitOperation,
  stageId: string,
  sliceId: string,
  diagnostics: readonly Finding[] = [],
): ToolResult {
  const data = projectAdmitResultData(result, operation, stageId, sliceId, diagnostics);
  const refs: ReceiptRef[] =
    result.accepted && result.receipt_ref !== null
      ? [
          projectReceiptRef(
            admitReceiptRef(operation, stageId, sliceId, result.receipt_ref),
            { digest: result.receipt_ref },
          ),
        ]
      : [];
  const findings = capFindings([...result.findings, ...diagnostics]);
  const base = successResult({ data, findings, refs });
  const ok = result.accepted && !hasErrorFindings(findings);
  return ok ? base : { ...base, ok: false };
}

/**
 * Optional dependency seam for `runStageAdmit`. Production callers never pass
 * it (the stage tool default handlers call `runStageAdmit*(input, logger)`
 * with no deps); tests use `beforeAdmit` / `afterAdmit` to deterministically
 * inject a manifest swap around the runtime admit — the documented
 * fault-injection seam for the CV post-write TOCTOU / concurrency proof
 * (STAGE_ADMIT_POSTWRITE_TOCTOU_FAILURE_WITH_PERSISTED_RECEIPT, the
 * S03-C `PlanSpvAdmitDeps` / S03-D `ReviewFinalizeDeps` pattern).
 */
export interface StageAdmitDeps {
  /**
   * Test-only hook: runs AFTER all pre-admission verification (path guard +
   * mapper) and IMMEDIATELY BEFORE the runtime admit dispatch. A manifest swap
   * injected here must be caught by the runtime's admission-time digest
   * binding / stage preconditions (snapshot semantics) → no write. Production
   * never supplies this.
   */
  beforeAdmit?: () => void;
  /**
   * Test-only hook: runs AFTER the runtime admit dispatch returns and
   * IMMEDIATELY BEFORE the post-admission DIAGNOSTIC manifest re-verify. A
   * manifest swap injected here must surface only a warn diagnostic — the
   * already-persisted Receipt is NEVER rolled back and the result NEVER flips
   * to a failure (CV repair). Production never supplies this.
   */
  afterAdmit?: () => void;
}

/**
 * Post-admission manifest identity verification — DIAGNOSTIC ONLY (CV repair
 * STAGE_ADMIT_POSTWRITE_TOCTOU_FAILURE_WITH_PERSISTED_RECEIPT, option (a)
 * REORDER — the S03-C/S03-D-established closure).
 *
 * All hard verification (path identity + manifest content trust-root guard)
 * runs BEFORE the runtime write, so a verification failure can never occur
 * after the write. The runtime admit precheck verifies the stage/slice state
 * and binds the manifest digest AT ADMISSION (snapshot semantics — a manifest
 * change after admission is a NEW state, never a corruption of the admitted
 * receipt). The post-admission re-verify therefore NEVER flips an admitted
 * result to accepted:false (a Receipt was already persisted); it surfaces a
 * warn diagnostic only.
 *
 * Returns warn findings (empty when the manifest is unchanged). A warn
 * finding is never error-level, so `ok`/`accepted` stay true for an admitted
 * result (projectAdmitToolResult appends them without changing ok).
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
        'proofloop_stage: manifest content changed during the admit ' +
        '(post-admission diagnostic). The admitted Receipt is the completed ' +
        'durable outcome, bound to the manifest digest captured at admission ' +
        '(snapshot semantics); the observed change is a new state, not a ' +
        'corruption of the admitted receipt.',
    });
  }
  const identity = reverifyManifestPathIdentity(canonicalRoot, manifestPath);
  if (!identity.ok) {
    findings.push({
      code: 'RUNTIME.SCHEMA_MISMATCH',
      severity: 'warn',
      message:
        'proofloop_stage: manifest path was redirected after the admit ' +
        '(post-admission diagnostic). The admitted Receipt is the completed ' +
        'durable outcome, bound to the digest captured at admission; the ' +
        'observed redirect is a new state, not a corruption of the admitted ' +
        'receipt.',
    });
  }
  return findings;
}

/**
 * Run one admit operation through the fail-closed contract boundary and the
 * runtime public seam.
 *
 * S03-B REPAIR fixes:
 *   - the path guard returns the canonicalized (root-bound realpath-normalized)
 *     path values, and the mapper consumes them — the runtime request/payload
 *     never carries raw non-canonical host strings;
 *   - a malformed `integration_ref` FAILS CLOSED in the guard (never silently
 *     dropped while the integration admit proceeds);
 *   - the integration host metadata is logged ONLY AFTER the guard passes
 *     (validate → guard → log → dispatch), so host values are never observed
 *     before root validation.
 *
 * CV repair (STAGE_ADMIT_POSTWRITE_TOCTOU_FAILURE_WITH_PERSISTED_RECEIPT —
 * the S03-C/S03-D-established closure): ALL hard verification completes
 * BEFORE the runtime write; the post-admission manifest re-verify is
 * DIAGNOSTIC-ONLY (warn finding, never flips an admitted result with a
 * persisted receipt). The optional `deps` is the documented test-only
 * fault-injection seam (`beforeAdmit` / `afterAdmit`).
 */
export function runStageAdmit(
  input: StageResolvedArgs,
  operation: StageAdmitOperation,
  logger?: LoggerAdapter,
  deps?: StageAdmitDeps,
): StageHandlerResult {
  if (input.admit === undefined) {
    return {
      result: toErrorResult([
        {
          code: 'RUNTIME.SCHEMA_MISMATCH',
          severity: 'error',
          message:
            `proofloop_stage: admit operation "${operation}" is missing its wire ` +
            'args (slice_id + operation fields).',
        },
      ]),
    };
  }

  // 1. TOCTOU identity re-verify of the runtime's canonical reads.
  const reverified = reverifyStagePaths({
    projectRoot: input.projectRoot,
    stageId: input.stageId,
  });
  if (reverified !== null) {
    return { result: reverified };
  }

  // 2. Manifest content trust-root guard (S2-F-001 round 1 + path identity).
  //    ALL hard verification completes BEFORE the runtime write — a
  //    verification failure can never occur after the write (CV repair).
  const manifestPath =
    input.manifestPath ?? defaultManifestPath(input.projectRoot, input.stageId);
  const identity = reverifyManifestPathIdentity(input.projectRoot, manifestPath);
  if (!identity.ok) {
    return { result: identity.result };
  }
  const pre = checkManifestContentBaseline(input.projectRoot, identity.path);
  if (!pre.ok) {
    return { result: pre.result };
  }

  // 3. Path-valued field guard (envelope / host-metadata paths). Returns the
  //    canonicalized root-bound values on success; a malformed integration_ref
  //    or an outside-root / symlink-escape path fails closed BEFORE any log of
  //    the host value and BEFORE any dispatch.
  const pathGuard = guardAdmitPathFields(
    input.projectRoot,
    operation,
    input.admit.rawArgs,
  );
  if (!pathGuard.ok) {
    return { result: pathGuard.result };
  }

  // 3b. The integration host metadata is observed ONLY after the guard passed
  //     (REPAIR counterexample 3 — validate → guard → log → dispatch). The
  //     logged value is the canonical root-bound form; it is NEVER a runtime
  //     request member.
  if (
    operation === 'admit_integration' &&
    pathGuard.canonical.integrationRef !== undefined
  ) {
    logger?.info('stage tool: integration host metadata', {
      integration_ref: pathGuard.canonical.integrationRef,
    });
  }

  // 4. The single adapter boundary: snake_case wire → camelCase request,
  //    consuming the canonicalized path values (single-boundary
  //    canonicalization — the mapper is the ONLY place paths are canonicalized
  //    into the runtime request).
  const mapped = mapHostArgsToAdmissionRequest(
    operation,
    {
      stageId: input.stageId,
      sliceId: input.admit.sliceId,
      rawArgs: input.admit.rawArgs,
    },
    pathGuard.canonical,
  );
  if (!mapped.ok) {
    return { result: mapped.result };
  }

  // 4b. Documented test-only fault-injection seam (production never passes it).
  deps?.beforeAdmit?.();

  // 5. Runtime admit dispatch — the ONLY Receipt creation path. Synchronous:
  //    an abort surfaced during the call is observed by the execute
  //    post-check (cooperative cancellation boundary). The runtime precheck
  //    binds the manifest/state at admission (snapshot semantics) and refuses
  //    a changed manifest BEFORE writing.
  const admit = dispatchAdmit(mapped.request, input.projectRoot);

  // 5b. Documented test-only fault-injection seam (production never passes it).
  deps?.afterAdmit?.();

  // 6. Post-admission manifest re-verify — DIAGNOSTIC ONLY (CV repair). The
  //    runtime result (accepted/receipt_ref/new_state) is NEVER discarded by
  //    this check: a warn finding is appended when the manifest changed, and
  //    an admitted result stays ok:true with its persisted receipt.
  const diagnostics = diagnosticPostAdmission(input.projectRoot, identity.path, pre.baseline);

  // 7. Canonical AdmitResult projection (with the diagnostic warn findings).
  const result = projectAdmitToolResult(
    admit,
    operation,
    input.stageId,
    input.admit.sliceId,
    diagnostics,
  );
  return { result, statusText: renderStageAdmitText(result) };
}

/** `admit_worker_result` handler seam (T01 default wiring). */
export function runStageAdmitWorkerResult(
  input: StageResolvedArgs,
  logger?: LoggerAdapter,
  deps?: StageAdmitDeps,
): StageHandlerResult {
  return runStageAdmit(input, 'admit_worker_result', logger, deps);
}

/** `admit_cv_result` handler seam (T01 default wiring). */
export function runStageAdmitCvResult(
  input: StageResolvedArgs,
  logger?: LoggerAdapter,
  deps?: StageAdmitDeps,
): StageHandlerResult {
  return runStageAdmit(input, 'admit_cv_result', logger, deps);
}

/** `admit_slice_commit` handler seam (T01 default wiring). */
export function runStageAdmitSliceCommit(
  input: StageResolvedArgs,
  logger?: LoggerAdapter,
  deps?: StageAdmitDeps,
): StageHandlerResult {
  return runStageAdmit(input, 'admit_slice_commit', logger, deps);
}

/** `admit_integration` handler seam (T01 default wiring). */
export function runStageAdmitIntegration(
  input: StageResolvedArgs,
  logger?: LoggerAdapter,
  deps?: StageAdmitDeps,
): StageHandlerResult {
  return runStageAdmit(input, 'admit_integration', logger, deps);
}
