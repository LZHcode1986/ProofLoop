/**
 * @proofloop/opencode-plugin — proofloop_stage S3 admission shared contract
 * layer (S03-B-T01, PO-S03-B-01).
 *
 * The single adapter boundary between the host snake_case wire args and the
 * canonical runtime camelCase `AdmissionRequest` union:
 *
 *   - `STAGE_ADMIT_OPERATIONS` / `STAGE_ALL_OPERATIONS` / the rejected
 *     operation list (contract-state-matrix.md#§1.2). `run_gate`,
 *     `admit_gate_result`, `admit_gate_interrupted`, `stage_plan`,
 *     `admit_stage_plan`, `compile_acceptance`, `run_e2e`,
 *     `prepare_project_review`, `finalize_project_review` and ANY unknown
 *     value are rejected at the execute boundary with a canonical
 *     RUNTIME.SCHEMA_MISMATCH Finding — never a fallthrough, never a silent
 *     alias, never a read-only downgrade of a write op.
 *   - `mapHostArgsToAdmissionRequest` — the explicit snake_case → camelCase
 *     mapper. `worker_result` produces `{ type: 'worker_result', envelope }`
 *     ONLY (the outer `stage_id`/`slice_id` are validated as outer binding
 *     against `envelope.stageId`/`envelope.sliceId`, never passed into the
 *     request); `integration` produces `{ type: 'integration', stageId,
 *     sliceId, commitSha }` — the runtime `IntegrationAdmissionRequest` has NO
 *     `integrationRef` member and none is ever fabricated; a host-supplied
 *     `integration_ref` stays root-checked host metadata only. Unknown host
 *     fields never enter the closed union (the runtime `assertAdmissionRequest`
 *     rejects unknown request fields).
 *   - `guardAdmitPathFields` — the path-valued field guard: envelope
 *     `evidenceRef`, every `changedFiles` entry and the `integration_ref`
 *     host metadata must be root-bound + canonicalized through the shared
 *     `resolveWithinRoot` / `reverifyCanonicalPath` seams (S2 trust-root /
 *     TOCTOU boundary); an outside-root / symlink-escape fails closed with
 *     HOST.PATH_OUTSIDE_PROJECT.
 *   - `reverifyStagePaths` — the shared TOCTOU identity re-verify of the
 *     runtime's default manifest/tasks reads (same semantics as the S2
 *     stage handler boundary; moved here so status/next and the admit
 *     handlers consume one seam).
 *   - `projectAdmitResultData` / `admitReceiptRef` / `renderStageAdmitText` —
 *     the canonical AdmitResult projection `{ accepted, receipt_ref,
 *     new_state, findings }` with `receipt_ref` projected to exactly
 *     `{ ref, digest }` (the ToolResult `refs` stay `{ ref, digest }` only —
 *     never a Receipt payload).
 *
 * Every failure is a canonical kernel Finding verified through the S1
 * `toErrorResult` boundary — never a bare exception.
 */

import path from 'node:path';
import { defaultManifestPath, defaultTasksMdPath, validateWorkerResultEnvelope } from '@proofloop/runtime';
import type {
  AdmissionRequest,
  AdmitResult,
  ReconcileStageResult,
  WorkerResultEnvelope,
} from '@proofloop/runtime';
import type { Finding } from '@proofloop/kernel';
import { projectReceiptRef, toErrorResult } from '../tool-result.js';
import type { ToolResult } from '../tool-result.js';
import { resolveWithinRoot, reverifyCanonicalPath } from '../path-boundary.js';
import { FINDINGS_BUDGET } from '../compact.js';

// Canonical slice-id charset (manifest-guard.ts — shared with the S2 manifest
// content guard): a canonical slice id can never traverse, so runtime
// `receiptCategoryDir` joins stay inside the trust root.
export { CANONICAL_SLICE_ID } from '../manifest-guard.js';

// ============================================================
// Closed operation sets (contract-state-matrix.md#§1.2)
// ============================================================

/** The four S3 admission operations (Executor write boundary). */
export const STAGE_ADMIT_OPERATIONS = [
  'admit_worker_result',
  'admit_cv_result',
  'admit_slice_commit',
  'admit_integration',
] as const;

/** Legal S3 admit operation value. */
export type StageAdmitOperation = (typeof STAGE_ADMIT_OPERATIONS)[number];

/** Full `proofloop_stage` operation set: S2 read ops + the four admit ops. */
export const STAGE_ALL_OPERATIONS = ['status', 'next', ...STAGE_ADMIT_OPERATIONS] as const;

/** Legal `proofloop_stage` operation value. */
export type StageOperation = (typeof STAGE_ALL_OPERATIONS)[number];

/**
 * Operations that are NEVER legal for `proofloop_stage`
 * (contract-state-matrix.md#§1.2 / OUT-S2-05 read-only boundary):
 * `run_gate` / `admit_gate_result` / `admit_gate_interrupted` belong to the
 * stage-gate tool (S5); `stage_plan` / `admit_stage_plan` / `admit_spv_result`
 * belong to the plan tool; `compile_acceptance` / `run_e2e` belong to the
 * project tool; project-review ops belong to the project review flow. The
 * execute boundary rejects every value here with a canonical Finding and NEVER
 * dispatches a write branch.
 */
export const STAGE_REJECTED_OPERATIONS = [
  'run_gate',
  'admit_gate_result',
  'admit_gate_interrupted',
  'stage_plan',
  'admit_stage_plan',
  'compile_acceptance',
  'run_e2e',
  'prepare_project_review',
  'finalize_project_review',
] as const;

/**
 * Operation-dependent required host fields, enforced by execute's fail-closed
 * second validation (`parseStageArgs`) — NEVER by the host schema alone.
 * `summary` is required for `admit_cv_result` because the runtime closed
 * schema (`CVResultAdmissionRequest`) requires a non-empty summary.
 */
export const REQUIRED_ADMIT_FIELDS_BY_OPERATION: Record<
  StageAdmitOperation,
  readonly string[]
> = {
  admit_worker_result: ['envelope'],
  admit_cv_result: ['verdict', 'snapshot_digest', 'summary'],
  admit_slice_commit: ['commit_sha', 'cv_receipt_digest'],
  admit_integration: ['commit_sha'],
};

/** True when `value` is one of the four admit operations. */
export function isStageAdmitOperation(value: unknown): value is StageAdmitOperation {
  return (
    typeof value === 'string' &&
    (STAGE_ADMIT_OPERATIONS as readonly string[]).includes(value)
  );
}

/** True when `value` is a legal `proofloop_stage` operation. */
export function isStageOperation(value: unknown): value is StageOperation {
  return (
    typeof value === 'string' &&
    (STAGE_ALL_OPERATIONS as readonly string[]).includes(value)
  );
}

/**
 * Reject a non-legal `proofloop_stage` operation at the execute boundary.
 * Every rejected value (run_gate, gate/project operations, unknown values)
 * fails closed with a canonical RUNTIME.SCHEMA_MISMATCH Finding and NEVER
 * reaches a dispatch/write branch.
 */
export function rejectStageOperation(
  operation: unknown,
): { ok: false; result: ToolResult } {
  const label = typeof operation === 'string' && operation.length > 0 ? operation : '(missing)';
  return {
    ok: false,
    result: toErrorResult([
      {
        code: 'RUNTIME.SCHEMA_MISMATCH',
        severity: 'error',
        message:
          `proofloop_stage: operation "${label}" is not supported (supported: ` +
          'status | next | admit_worker_result | admit_cv_result | ' +
          'admit_slice_commit | admit_integration). Rejected operations ' +
          '(run_gate, admit_gate_result, admit_gate_interrupted, stage_plan, ' +
          'admit_stage_plan, compile_acceptance, run_e2e, ' +
          'prepare_project_review, finalize_project_review) and unknown values ' +
          'never dispatch through this tool.',
      },
    ]),
  };
}

// ============================================================
// Wire args / mapper input
// ============================================================

/**
 * Fully validated admit-operation wire input handed to the mapper. `sliceId`
 * is already canonical (`/^S\d{2,}-[A-Z]$/`) and `rawArgs` carries the host
 * operation-dependent fields (envelope / verdict / snapshot_digest / summary /
 * commit_sha / cv_receipt_digest / integration_ref).
 */
export interface StageAdmitWireArgs {
  /** Canonical stage id (validated by the parser). */
  readonly stageId: string;
  /** Canonical slice id (validated by the parser). */
  readonly sliceId: string;
  /** Raw host args for the admit operation. */
  readonly rawArgs: Record<string, unknown>;
}

/** Mapper outcome: the canonical request or a fail-closed result. */
export type StageAdmitMapResult =
  | { ok: true; request: AdmissionRequest }
  | { ok: false; result: ToolResult };

/**
 * Canonicalized path-valued fields produced by `guardAdmitPathFields`
 * (S03-B REPAIR counterexample 1 — path canonicalization MUST be propagated
 * into the runtime request/payload). The values are the root-bound
 * realpath-normalized absolute forms computed through the shared
 * `resolveWithinRoot` seam — the ONLY canonicalization boundary. The mapper
 * consumes these values so the persisted Receipt/payload reflects canonical
 * paths, never raw host strings (e.g. `delivery/./stages/...` is normalized).
 *
 * Fields are optional: a field is present only when the host supplied it and
 * it passed the root-bound check. A malformed envelope field that the runtime
 * schema requires (e.g. a missing evidenceRef) is deliberately left absent —
 * the runtime `validateWorkerResultEnvelope` then rejects it fail-closed.
 */
export interface AdmitCanonicalEnvelope {
  /** Canonical root-bound evidenceRef (realpath-normalized absolute path). */
  readonly evidenceRef?: string;
  /** Canonical root-bound changedFiles entries (realpath-normalized). */
  readonly changedFiles?: readonly string[];
}

/** Canonicalized path-valued host fields per operation (REPAIR fix). */
export interface AdmitCanonicalPaths {
  /** Canonicalized worker envelope path fields (admit_worker_result). */
  readonly envelope?: AdmitCanonicalEnvelope;
  /**
   * Canonicalized root-bound integration host metadata (admit_integration).
   * Never a runtime request member — the IntegrationAdmissionRequest has no
   * integrationRef field; this is the validated value that may be logged.
   */
  readonly integrationRef?: string;
}

/** Outcome of the path-valued field guard (validation + canonicalization). */
export type AdmitPathGuardResult =
  | { ok: true; canonical: AdmitCanonicalPaths }
  | { ok: false; result: ToolResult };

/** Build a canonical fail-closed mapper result (findings validated by S1). */
function failMap(message: string): StageAdmitMapResult {
  return {
    ok: false,
    result: toErrorResult([
      { code: 'RUNTIME.SCHEMA_MISMATCH', severity: 'error', message },
    ]),
  };
}

// ============================================================
// snake_case → camelCase AdmissionRequest mapper (single adapter boundary)
// ============================================================

/**
 * Map the host snake_case wire args to the canonical runtime camelCase
 * `AdmissionRequest` member for one admit operation.
 *
 * Fail-closed contract:
 *   - `worker_result` → `{ type: 'worker_result', envelope }` ONLY — the outer
 *     `stage_id`/`slice_id` are validated as outer binding against
 *     `envelope.stageId`/`envelope.sliceId` and are NEVER passed into the
 *     request (the runtime `WorkerResultAdmissionRequest` has exactly
 *     type+envelope).
 *   - `cv_result` → `{ type: 'cv_result', stageId, sliceId, verdict,
 *     snapshotDigest, summary }` with the closed {PASS, REPAIR} verdict.
 *   - `slice_commit` → `{ type: 'slice_commit', stageId, sliceId, commitSha,
 *     cvReceiptDigest }`.
 *   - `integration` → `{ type: 'integration', stageId, sliceId, commitSha }` —
 *     the runtime `IntegrationAdmissionRequest` has NO `integrationRef`
 *     member; a host-supplied `integration_ref` is never fabricated into the
 *     request (the path guard root-checks it as host metadata instead).
 *   - Unknown host fields never enter the closed union.
 *
 * Path canonicalization is the SINGLE adapter boundary: `canonical` carries the
 * root-bound realpath-normalized forms produced by `guardAdmitPathFields`. When
 * provided, the worker envelope's `evidenceRef` / `changedFiles` are replaced
 * with the canonical values so the runtime request/payload never carries raw
 * non-canonical host strings (S03-B REPAIR counterexample 1). Callers that
 * dispatch to the runtime MUST run the guard first and pass its canonical map
 * (the plugin's `runStageAdmit` does exactly this); a standalone call without
 * `canonical` is only for non-path mapping (cv_result / slice_commit /
 * integration shape checks) and is documented as such.
 */
export function mapHostArgsToAdmissionRequest(
  operation: StageAdmitOperation,
  wire: StageAdmitWireArgs,
  canonical?: AdmitCanonicalPaths,
): StageAdmitMapResult {
  switch (operation) {
    case 'admit_worker_result':
      return mapWorkerResult(wire, canonical);
    case 'admit_cv_result':
      return mapCvResult(wire);
    case 'admit_slice_commit':
      return mapSliceCommit(wire);
    case 'admit_integration':
      return mapIntegration(wire);
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Non-empty-string required field (fail-closed; the parser re-checks first). */
function requireWireString(
  value: unknown,
  label: string,
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return {
      ok: false,
      message: `proofloop_stage: \`${label}\` must be a non-empty string for this admit operation.`,
    };
  }
  return { ok: true, value };
}

function mapWorkerResult(
  wire: StageAdmitWireArgs,
  canonical?: AdmitCanonicalPaths,
): StageAdmitMapResult {
  const envelopeRaw = wire.rawArgs['envelope'];
  if (!isRecord(envelopeRaw)) {
    return failMap(
      'proofloop_stage: `envelope` must be a non-null, non-array object for admit_worker_result.',
    );
  }
  // Single-boundary canonicalization (S03-B REPAIR): the guard produced the
  // root-bound realpath-normalized forms; ONLY those values reach the runtime
  // request, so the persisted Receipt/payload reflects canonical paths.
  const envelopeInput: Record<string, unknown> = { ...envelopeRaw };
  if (canonical?.envelope?.evidenceRef !== undefined) {
    envelopeInput['evidenceRef'] = canonical.envelope.evidenceRef;
  }
  if (canonical?.envelope?.changedFiles !== undefined) {
    envelopeInput['changedFiles'] = canonical.envelope.changedFiles;
  }
  let envelope: WorkerResultEnvelope;
  try {
    // Reuse the runtime's canonical closed-schema validator — the envelope is
    // non-authoritative until admitted (Blueprint #13); the mapper rejects a
    // malformed envelope before any runtime call.
    envelope = validateWorkerResultEnvelope(envelopeInput);
  } catch (error) {
    return failMap(
      `proofloop_stage: envelope failed the runtime WorkerResultEnvelope schema: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Outer/inner binding: the outer stage_id/slice_id must match the envelope
  // stageId/sliceId — a mismatch is a canonical Finding before any runtime
  // call. The outer ids are NEVER passed into the request.
  if (envelope.stageId !== wire.stageId || envelope.sliceId !== wire.sliceId) {
    return failMap(
      `proofloop_stage: envelope binding mismatch — outer stage_id/slice_id ` +
        `(${wire.stageId}/${wire.sliceId}) do not match envelope.stageId/` +
        `envelope.sliceId (${envelope.stageId}/${envelope.sliceId}).`,
    );
  }
  return { ok: true, request: { type: 'worker_result', envelope } };
}

function mapCvResult(wire: StageAdmitWireArgs): StageAdmitMapResult {
  const verdict = wire.rawArgs['verdict'];
  if (verdict !== 'PASS' && verdict !== 'REPAIR') {
    return failMap(
      'proofloop_stage: `verdict` must be one of: PASS, REPAIR for admit_cv_result.',
    );
  }
  const snapshot = requireWireString(wire.rawArgs['snapshot_digest'], 'snapshot_digest');
  if (!snapshot.ok) return failMap(snapshot.message);
  const summary = requireWireString(wire.rawArgs['summary'], 'summary');
  if (!summary.ok) return failMap(summary.message);
  return {
    ok: true,
    request: {
      type: 'cv_result',
      stageId: wire.stageId,
      sliceId: wire.sliceId,
      verdict,
      snapshotDigest: snapshot.value,
      summary: summary.value,
    },
  };
}

function mapSliceCommit(wire: StageAdmitWireArgs): StageAdmitMapResult {
  const commitSha = requireWireString(wire.rawArgs['commit_sha'], 'commit_sha');
  if (!commitSha.ok) return failMap(commitSha.message);
  const cvDigest = requireWireString(wire.rawArgs['cv_receipt_digest'], 'cv_receipt_digest');
  if (!cvDigest.ok) return failMap(cvDigest.message);
  return {
    ok: true,
    request: {
      type: 'slice_commit',
      stageId: wire.stageId,
      sliceId: wire.sliceId,
      commitSha: commitSha.value,
      cvReceiptDigest: cvDigest.value,
    },
  };
}

function mapIntegration(wire: StageAdmitWireArgs): StageAdmitMapResult {
  const commitSha = requireWireString(wire.rawArgs['commit_sha'], 'commit_sha');
  if (!commitSha.ok) return failMap(commitSha.message);
  // The runtime IntegrationAdmissionRequest has NO integrationRef member —
  // only type/stageId/sliceId/commitSha are ever passed. A host-supplied
  // `integration_ref` is root-checked by `guardAdmitPathFields` as host
  // metadata; it is never a request member (S3 constraint).
  return {
    ok: true,
    request: {
      type: 'integration',
      stageId: wire.stageId,
      sliceId: wire.sliceId,
      commitSha: commitSha.value,
    },
  };
}

// ============================================================
// Path-valued field guard (S2 trust-root / TOCTOU boundary)
// ============================================================

/**
 * Root-bound + canonicalize every path-valued host field before any runtime
 * call (PO-S03-B-01; S03-B REPAIR counterexamples 1–2): the worker envelope
 * `evidenceRef`, every `changedFiles` entry and the integration `integration_ref`
 * host metadata must resolve inside the canonical worktree trust root through
 * the shared `resolveWithinRoot` seam (every existing ancestor component
 * realpath-checked — a symlink-parent escape is rejected even when the final
 * target does not exist).
 *
 * The resolved canonical paths are then identity re-verified
 * (`reverifyCanonicalPath`) immediately before dispatch — an in-root symlink
 * redirect swapped after resolution fails closed (S2 TOCTOU closure).
 *
 * REPAIR fixes:
 *   1. The canonicalized values (root-bound realpath-normalized, expressed as
 *      the ROOT-RELATIVE normalized path — `./`/`..` collapsed, symlinks
 *      resolved) are RETURNED in `canonical` so the mapper propagates them into
 *      the runtime request/payload — never the raw host strings.
 *   2. A MALFORMED `integration_ref` (non-string, empty, outside-root,
 *      symlink-escape) FAILS CLOSED with a canonical Finding
 *      (RUNTIME.SCHEMA_MISMATCH / HOST.PATH_OUTSIDE_PROJECT) instead of being
 *      silently dropped — a valid integration admit never proceeds on a
 *      malformed metadata value.
 *
 * Returns `{ ok: true, canonical }` when every path-valued field is root-bound
 * and unchanged, else `{ ok: false, result }` (fail-closed).
 */
export function guardAdmitPathFields(
  canonicalRoot: string,
  operation: StageAdmitOperation,
  rawArgs: Record<string, unknown>,
): AdmitPathGuardResult {
  let envelopeCanonical: AdmitCanonicalEnvelope | undefined;
  let integrationRefCanonical: string | undefined;
  const resolved: Array<{ label: string; path: string }> = [];

  if (operation === 'admit_worker_result') {
    const envelope = rawArgs['envelope'];
    if (isRecord(envelope)) {
      let canonicalEvidenceRef: string | undefined;
      let canonicalChanged: string[] | undefined;

      const evidenceRef = envelope['evidenceRef'];
      if (evidenceRef !== undefined) {
        if (typeof evidenceRef !== 'string' || evidenceRef.length === 0) {
          return {
            ok: false,
            result: toErrorResult([
              {
                code: 'RUNTIME.SCHEMA_MISMATCH',
                severity: 'error',
                message:
                  'proofloop_stage: `envelope.evidenceRef` must be a non-empty string.',
              },
            ]),
          };
        }
        const resolvedEvidence = resolveWithinRoot(canonicalRoot, evidenceRef);
        if (resolvedEvidence === null) {
          return {
            ok: false,
            result: pathOutside(
              `envelope.evidenceRef "${evidenceRef}" resolves outside the trust root (${canonicalRoot})`,
            ),
          };
        }
        resolved.push({ label: 'envelope.evidenceRef', path: resolvedEvidence });
        // Canonical value: the ROOT-RELATIVE normalized path (realpath applied,
        // `./`/`..` collapsed) — root-independent and matching the runtime's
        // relative-path convention.
        canonicalEvidenceRef = path.posix.normalize(path.relative(canonicalRoot, resolvedEvidence));
      }

      const changedFiles = envelope['changedFiles'];
      if (changedFiles !== undefined) {
        if (!Array.isArray(changedFiles)) {
          return {
            ok: false,
            result: toErrorResult([
              {
                code: 'RUNTIME.SCHEMA_MISMATCH',
                severity: 'error',
                message: 'proofloop_stage: `envelope.changedFiles` must be an array.',
              },
            ]),
          };
        }
        canonicalChanged = [];
        for (let i = 0; i < changedFiles.length; i += 1) {
          const entry = changedFiles[i];
          if (typeof entry !== 'string' || entry.length === 0) {
            return {
              ok: false,
              result: toErrorResult([
                {
                  code: 'RUNTIME.SCHEMA_MISMATCH',
                  severity: 'error',
                  message:
                    `proofloop_stage: envelope.changedFiles[${i}] must be a ` +
                    'non-empty string.',
                },
              ]),
            };
          }
          const resolvedEntry = resolveWithinRoot(canonicalRoot, entry);
          if (resolvedEntry === null) {
            return {
              ok: false,
              result: pathOutside(
                `envelope.changedFiles[${i}] "${entry}" resolves outside the trust root (${canonicalRoot})`,
              ),
            };
          }
          resolved.push({ label: `envelope.changedFiles[${i}]`, path: resolvedEntry });
          canonicalChanged.push(path.posix.normalize(path.relative(canonicalRoot, resolvedEntry)));
        }
      }

      if (canonicalEvidenceRef !== undefined || canonicalChanged !== undefined) {
        envelopeCanonical = {
          ...(canonicalEvidenceRef !== undefined ? { evidenceRef: canonicalEvidenceRef } : {}),
          ...(canonicalChanged !== undefined ? { changedFiles: canonicalChanged } : {}),
        };
      }
    }
  }

  if (operation === 'admit_integration') {
    const integrationRef = rawArgs['integration_ref'];
    if (integrationRef !== undefined) {
      // REPAIR fix (counterexample 2): a malformed integration_ref FAILS
      // CLOSED — it is never silently dropped while the integration admit
      // proceeds.
      if (typeof integrationRef !== 'string' || integrationRef.length === 0) {
        return {
          ok: false,
          result: toErrorResult([
            {
              code: 'RUNTIME.SCHEMA_MISMATCH',
              severity: 'error',
              message:
                'proofloop_stage: `integration_ref` must be a non-empty string ' +
                'when provided for admit_integration.',
            },
          ]),
        };
      }
      const resolvedRef = resolveWithinRoot(canonicalRoot, integrationRef);
      if (resolvedRef === null) {
        return {
          ok: false,
          result: pathOutside(
            `integration_ref "${integrationRef}" resolves outside the trust root (${canonicalRoot})`,
          ),
        };
      }
      resolved.push({ label: 'integration_ref', path: resolvedRef });
      integrationRefCanonical = path.posix.normalize(path.relative(canonicalRoot, resolvedRef));
    }
  }

  // TOCTOU identity re-verify (S2 pattern): every canonical path must STILL
  // re-resolve inside the root AND to the SAME path immediately before the
  // runtime read/write.
  for (const check of resolved) {
    if (reverifyCanonicalPath(canonicalRoot, check.path) === null) {
      return {
        ok: false,
        result: pathOutside(
          `${check.label} "${check.path}" was redirected or escaped during verification (TOCTOU); the canonical path must be read unchanged`,
        ),
      };
    }
  }

  return {
    ok: true,
    canonical: {
      ...(envelopeCanonical !== undefined ? { envelope: envelopeCanonical } : {}),
      ...(integrationRefCanonical !== undefined ? { integrationRef: integrationRefCanonical } : {}),
    },
  };
}

function pathOutside(message: string): ToolResult {
  return toErrorResult([
    { code: 'HOST.PATH_OUTSIDE_PROJECT', severity: 'error', message },
  ]);
}

// ============================================================
// Shared TOCTOU identity re-verify (moved from the S2 stage handler)
// ============================================================

/**
 * Re-verify the canonical manifest/tasks paths immediately before a runtime
 * read/write (CV S02-B-RECHECK-PO01-INROOT-SYMLINK-REDIRECT,
 * S02-B-RECHECK-3-STAGE-DEFAULT-PATH — same-layer semantics as plan-validate
 * `reverifyResolvedPaths` and the S2 stage `reverifyStagePaths`).
 *
 * When an explicit path is absent the runtime reads its DEFAULT path
 * (`defaultManifestPath` / `defaultTasksMdPath` for the stage); that default
 * must ALSO be identity re-verified, because a swapped in-root alternate at
 * the default location would otherwise be silently read. Returns a fail-closed
 * handler result when any path changed, else `null`.
 */
export function reverifyStagePaths(input: {
  projectRoot: string;
  stageId: string;
  manifestPath?: string;
  tasksPath?: string;
}): ToolResult | null {
  const checks: ReadonlyArray<{ label: string; path: string }> = [
    {
      label: 'manifest_path',
      path:
        input.manifestPath ?? defaultManifestPath(input.projectRoot, input.stageId),
    },
    {
      label: 'tasks_path',
      path: input.tasksPath ?? defaultTasksMdPath(input.projectRoot, input.stageId),
    },
  ];
  for (const check of checks) {
    if (reverifyCanonicalPath(input.projectRoot, check.path) === null) {
      return toErrorResult([
        {
          code: 'HOST.PATH_OUTSIDE_PROJECT',
          severity: 'error',
          message:
            `proofloop_stage: ${check.label} "${check.path}" was redirected or ` +
            'escaped during verification (TOCTOU); the canonical path must be ' +
            'read unchanged.',
        },
      ]);
    }
  }
  return null;
}

// ============================================================
// AdmitResult projection ({ accepted, receipt_ref, new_state, findings })
// ============================================================

/** Canonical receipt content category per admit operation (§3). */
const ADMIT_RECEIPT_CATEGORY: Record<StageAdmitOperation, string> = {
  admit_worker_result: 'tasks',
  admit_cv_result: 'cv',
  admit_slice_commit: 'committer',
  admit_integration: 'integration',
};

/**
 * Root-bound RELATIVE artifact ref for an admitted receipt: the kernel writer
 * persists `<digest>.json` in the operation's canonical category directory
 * (`<projectRoot>/.proofloop/receipts/<category>/<stage>/<slice>/`), so the
 * canonical ref is the root-relative path (e.g.
 * `.proofloop/receipts/cv/S3/S03-B/<digest>.json`).
 */
export function admitReceiptRef(
  operation: StageAdmitOperation,
  stageId: string,
  sliceId: string,
  digest: string,
): string {
  return path.posix.join(
    '.proofloop',
    'receipts',
    ADMIT_RECEIPT_CATEGORY[operation],
    stageId,
    sliceId,
    `${digest}.json`,
  );
}

/**
 * Bounded projection of the runtime `AdmitResult.new_state` reconcile object —
 * the ToolResult data never leaks the full reconcile object or Receipt bodies
 * (FR-012 / OUT-S1-05). Returns `null` for a pre-reconcile schema rejection.
 */
export function projectAdmitNewState(
  state: ReconcileStageResult | null,
): Record<string, unknown> | null {
  if (state === null) return null;
  return {
    stage_id: state.stage_id,
    stage_state: state.stage_state,
    project_state: state.project_state,
    receipt_chain_valid: state.receipt_chain_valid,
    slices: state.slices.map((s) => ({
      slice_id: s.slice_id,
      slice_state: s.slice_state,
      cv_status: s.cv_status,
      complete: s.complete,
      integrated: s.integrated,
      committed: s.committed,
    })),
  };
}

/**
 * Project a runtime `AdmitResult` into the canonical ToolResult `data`:
 * `{ accepted, receipt_ref, new_state, findings }`. `receipt_ref` is projected
 * to exactly `{ ref, digest }` (the full Receipt payload never surfaces); the
 * `findings` are the runtime's canonical kernel Findings. `diagnostics`
 * (optional) are DIAGNOSTIC-ONLY warn findings appended after the runtime
 * admit (CV repair STAGE_ADMIT_POSTWRITE_TOCTOU_FAILURE_WITH_PERSISTED_RECEIPT —
 * the S03-C/S03-D-established closure): a post-admission manifest change never
 * flips an admitted result to a failure while its Receipt is persisted; it
 * surfaces a warn finding appended to the canonical projection.
 */
export function projectAdmitResultData(
  result: AdmitResult,
  operation: StageAdmitOperation,
  stageId: string,
  sliceId: string,
  diagnostics: readonly Finding[] = [],
): Record<string, unknown> {
  return {
    accepted: result.accepted,
    receipt_ref:
      result.receipt_ref === null
        ? null
        : projectReceiptRef(
            admitReceiptRef(operation, stageId, sliceId, result.receipt_ref),
            { digest: result.receipt_ref },
          ),
    new_state: projectAdmitNewState(result.new_state),
    findings: [...result.findings, ...diagnostics],
  };
}

/**
 * Compact admit summary text (fed to `renderCompact` for the FR-012 budget):
 * the accepted flag, the receipt digest (bounded — never the Receipt body)
 * and the post-admit stage/slice states from the projected `new_state`.
 */
export function renderStageAdmitText(result: ToolResult): string {
  const data = result.data as
    | {
        accepted?: unknown;
        receipt_ref?: { digest?: unknown } | null;
        new_state?:
          | { stage_state?: unknown; slices?: Array<{ slice_id?: unknown; slice_state?: unknown }> }
          | null;
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
    for (const slice of state.slices ?? []) {
      if (typeof slice.slice_id === 'string' && typeof slice.slice_state === 'string') {
        lines.push(`Slice ${slice.slice_id}: ${slice.slice_state}`);
      }
    }
  }
  return lines.join('\n');
}

// ============================================================
// Shared finding helpers (S1 compact budgets)
// ============================================================

/** Cap findings at the S1 compact budget (FR-012: ≤ 20). */
export function capFindings(findings: readonly Finding[]): Finding[] {
  return findings.length > FINDINGS_BUDGET
    ? findings.slice(0, FINDINGS_BUDGET)
    : [...findings];
}

/** True when any canonical Finding is error-level (fail-closed signal). */
export function hasErrorFindings(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}
