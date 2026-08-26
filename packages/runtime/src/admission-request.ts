/**
 * @proofloop/runtime — AdmissionRequest types & fail-closed schema validation
 *
 * PO-S02-E-01 (skeleton part, S02-E-T01) + PO-S03-H-02 (S03-H-T02 extension):
 * the discriminated union `AdmissionRequest` over the AWI-006 admit
 * operations (WorkerResult / CVResult / SliceCommit / Integration /
 * StageReview / ProjectReview / StagePlan) PLUS the S03 SPV/GATE admit kinds
 * (SpvResult / GateResult). All fields use kernel canonical types and closed
 * literal sets — open strings are forbidden (§5 Canonical Type Registry). The
 * `type` discriminant is a closed 9-value set; the S03 SPV/GATE members use
 * the same extension point documented in the Slice's Receipt-creation
 * ownership table.
 *
 * SLICE_PLAN creation-path decision record (PO-S03-H-02): the kernel
 * `SLICE_PLAN` receipt literal is retained, but S03 does NOT create
 * SLICE_PLAN receipts (no consumer today). A worker-result admit can never
 * create a new slice in S03 — undeclared slices are refused
 * (DOMAIN.STAGE_NOT_FOUND) and no receipt of any type (in particular no
 * SLICE_PLAN) is ever written for them. If a future flow (repartition /
 * first-entry) creates a new slice, the S04 tool flow plugs a `slice_plan`
 * request member into this same extension point.
 */

import { SchemaValidationError } from '@proofloop/kernel';
import { validateWorkerResultEnvelope, validateVNextWorkerResultEnvelope } from './relay-contract';
import type { WorkerResultEnvelope, VNextWorkerResultEnvelope } from './relay-contract';
import { validateVNextCVResultEnvelope } from './vnext/cv-admission';
import type { VNextCvResultEnvelope } from './vnext/types';

// ============================================================
// Closed literal sets
// ============================================================

/** Legacy request `type` discriminants — closed 10-value set. */
export const ADMISSION_REQUEST_TYPES = [
  'worker_result',
  'cv_result',
  'slice_commit',
  'integration',
  'stage_review',
  'project_review',
  'stage_plan',
  'spv_result',
  'gate_result',
  'gate_interrupted',
] as const;
export type AdmissionRequestType = (typeof ADMISSION_REQUEST_TYPES)[number];

/** Full closed Runtime request set, including the additive vNext CV member. */
export const RUNTIME_ADMISSION_REQUEST_TYPES = [
  ...ADMISSION_REQUEST_TYPES,
  'cv_result_vnext',
] as const;
export type RuntimeAdmissionRequestType = (typeof RUNTIME_ADMISSION_REQUEST_TYPES)[number];

/** CV verdicts — closed 2-value set. */
export const CV_VERDICTS = ['PASS', 'REPAIR'] as const;
export type CvVerdict = (typeof CV_VERDICTS)[number];

/** Gate verdicts — closed 2-value set (PO-S03-H-02). */
export const GATE_VERDICTS = ['PASS', 'FAIL'] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];

/**
 * Gate interruption reasons — closed 2-value set (S05-A-T05, HP-004/AWI-015).
 *
 * A gate interruption is NOT a gate verdict: `GATE_INTERRUPTED` is a
 * separate 11th ReceiptType whose payload carries `reason` from this closed
 * set plus `duration_ms`. GATE_VERDICTS intentionally stays {PASS, FAIL} —
 * an interrupted gate is never admitted as a verdict receipt.
 */
export const GATE_INTERRUPTED_REASONS = ['cancelled', 'timeout'] as const;
export type GateInterruptedReason = (typeof GATE_INTERRUPTED_REASONS)[number];

/** Review verdicts — closed 2-value set. */
export const REVIEW_VERDICTS = ['ACCEPTED', 'REPAIR'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

// ============================================================
// 7 AdmissionRequest members (discriminated union on `type`)
// ============================================================

/**
 * Worker result admit — binds the canonical S02-B WorkerResultEnvelope.
 * The envelope is non-authoritative until admitted (Blueprint #13): the
 * pipeline validates it via the S02-B validator before any Receipt exists.
 */
export interface WorkerResultAdmissionRequest {
  readonly type: 'worker_result';
  /** Nested schema discriminator: 1 selects the legacy validator, 2 vNext. */
  readonly envelope: WorkerResultEnvelope | VNextWorkerResultEnvelope;
}

/**
 * CV result admit — `verdict` is the closed {PASS, REPAIR} set and
 * `snapshotDigest` binds the CV run to a concrete git snapshot (no open
 * strings, no unbound CV outcome).
 */
export interface CVResultAdmissionRequest {
  readonly type: 'cv_result';
  readonly stageId: string;
  readonly sliceId: string;
  readonly verdict: CvVerdict;
  readonly snapshotDigest: string;
  readonly summary: string;
}

/**
 * vNext CV result admit — the closed snake_case CV_RESULT envelope is the
 * complete request payload. It is intentionally a distinct discriminant so a
 * vNext result cannot enter the legacy CV reducer/writer path.
 */
export interface VNextCVResultAdmissionRequest {
  readonly type: 'cv_result_vnext';
  readonly envelope: VNextCvResultEnvelope;
}

/** Lower-case acronym alias for callers that use `Cv` in type names. */
export type VNextCvResultAdmissionRequest = VNextCVResultAdmissionRequest;

/**
 * Slice commit admit — `commitSha` binds the committed git SHA and
 * `cvReceiptDigest` binds the prerequisite CV_PASS receipt digest.
 */
export interface SliceCommitAdmissionRequest {
  readonly type: 'slice_commit';
  readonly stageId: string;
  readonly sliceId: string;
  readonly commitSha: string;
  readonly cvReceiptDigest: string;
}

/**
 * Integration admit — `commitSha` must bind the SAME commit SHA the
 * SLICE_COMMIT receipt recorded (Slice Commit/Integration boundary binding).
 */
export interface IntegrationAdmissionRequest {
  readonly type: 'integration';
  readonly stageId: string;
  readonly sliceId: string;
  readonly commitSha: string;
}

/** Stage review admit — `verdict` is the closed {ACCEPTED, REPAIR} set. */
export interface StageReviewAdmissionRequest {
  readonly type: 'stage_review';
  readonly stageId: string;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
}

/** Project review admit — `verdict` is the closed {ACCEPTED, REPAIR} set. */
export interface ProjectReviewAdmissionRequest {
  readonly type: 'project_review';
  readonly stageId: string;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
}

/**
 * Stage plan admit — `manifestDigest` binds the request to the canonical
 * `.proofloop/manifests/<stage>.json` digest (manifest lifecycle binding).
 */
export interface StagePlanAdmissionRequest {
  readonly type: 'stage_plan';
  readonly stageId: string;
  readonly manifestDigest: string;
}

/**
 * SPV result admit (PO-S03-H-02) — `SPV_PASS` receipt to `plan/<stage>/`;
 * `manifestDigest` binds the request to the canonical manifest digest (the
 * stage must be derived PLANNING). Stage-level kind, no slice binding.
 */
export interface SpvResultAdmissionRequest {
  readonly type: 'spv_result';
  readonly stageId: string;
  readonly manifestDigest: string;
  readonly summary: string;
}

/**
 * Gate result admit (PO-S03-H-02) — `GATE_PASS` / `GATE_FAIL` receipt to
 * `stage-gate/<stage>/`. `verdict` is the closed {PASS, FAIL} set;
 * `manifestDigest` binds the canonical manifest digest; `snapshotDigest`
 * binds the gate run to the git HEAD the gate was executed against (must
 * equal the current HEAD). Stage-level kind, no slice binding.
 */
export interface GateResultAdmissionRequest {
  readonly type: 'gate_result';
  readonly stageId: string;
  readonly verdict: GateVerdict;
  readonly manifestDigest: string;
  readonly snapshotDigest: string;
  readonly summary: string;
}

/**
 * Gate interruption admit (S05-A-T05, HP-004/AWI-015) — `GATE_INTERRUPTED`
 * receipt to `stage-gate/<stage>/`. Additive 11th ReceiptType: the gate run
 * was cancelled or timed out. `reason` is the closed {cancelled, timeout}
 * set (NOT a verdict — GATE_VERDICTS stays {PASS, FAIL}); `durationMs` is
 * the bounded run duration; `manifestDigest` / `snapshotDigest` bind the
 * interrupted run exactly like a gate result (the stage-gate context). An
 * interrupted gate is retryable — NextAction derives RUN_GATE again because
 * `gate_fail_present` matches only GATE_FAIL and `gate_pass_present` only
 * GATE_PASS. Stage-level kind, no slice binding.
 */
export interface GateInterruptedAdmissionRequest {
  readonly type: 'gate_interrupted';
  readonly stageId: string;
  readonly reason: GateInterruptedReason;
  readonly durationMs: number;
  readonly manifestDigest: string;
  readonly snapshotDigest: string;
}

/**
 * Closed 10-member legacy AdmissionRequest union (AWI-006 + PO-S03-H-02 + S05-A).
 *
 * S05-A adds the `gate_interrupted` member (HP-004/AWI-015): an interrupted
 * gate run admits a GATE_INTERRUPTED receipt with a reason payload — never a
 * PASS/FAIL verdict. S04 extension point: a SLICE_PLAN request kind (if a
 * consumer emerges) joins this union at the type level — S03 deliberately
 * does NOT create SLICE_PLAN receipts (decision record, PO-S03-H-02). The
 * unified pipeline accepts any member unchanged.
 */
export type AdmissionRequest =
  | WorkerResultAdmissionRequest
  | CVResultAdmissionRequest
  | SliceCommitAdmissionRequest
  | IntegrationAdmissionRequest
  | StageReviewAdmissionRequest
  | ProjectReviewAdmissionRequest
  | StagePlanAdmissionRequest
  | SpvResultAdmissionRequest
  | GateResultAdmissionRequest
  | GateInterruptedAdmissionRequest;

/**
 * Full Runtime request union, including the additive vNext CV consumer.
 * Legacy callers retain the original `AdmissionRequest` type so their
 * legacy-only dispatch tables cannot accidentally treat vNext facts as a
 * legacy request.
 */
export type RuntimeAdmissionRequest = AdmissionRequest | VNextCVResultAdmissionRequest;

/** Alias for callers that want to make the additive boundary explicit. */
export type AdmissionRequestWithVNext = RuntimeAdmissionRequest;

// ============================================================
// Binding helpers
// ============================================================

/** Canonical stage id binding of a request (envelope for worker/CV vNext). */
export function admissionRequestStageId(request: RuntimeAdmissionRequest): string {
  return request.type === 'worker_result'
    ? request.envelope.stageId
    : request.type === 'cv_result_vnext'
      ? request.envelope.stage_id
      : request.stageId;
}

/**
 * Canonical slice id binding of a request, or null for stage-level kinds
 * (reviews / project review / stage plan).
 */
export function admissionRequestSliceId(request: RuntimeAdmissionRequest): string | null {
  switch (request.type) {
    case 'worker_result':
      return request.envelope.sliceId;
    case 'cv_result_vnext':
      return request.envelope.slice_id;
    case 'cv_result':
    case 'slice_commit':
    case 'integration':
      return request.sliceId;
    default:
      return null;
  }
}

// ============================================================
// Fail-closed schema validation (RUNTIME.SCHEMA_MISMATCH)
// ============================================================

/** Field-locatable validation error. */
interface FieldError {
  path: string;
  message: string;
}

/** Per-member known field sets — strict mode rejects any unknown field. */
const WORKER_RESULT_FIELDS = new Set(['type', 'envelope']);
const CV_RESULT_FIELDS = new Set([
  'type', 'stageId', 'sliceId', 'verdict', 'snapshotDigest', 'summary',
]);
const CV_RESULT_VNEXT_FIELDS = new Set(['type', 'envelope']);
const SLICE_COMMIT_FIELDS = new Set([
  'type', 'stageId', 'sliceId', 'commitSha', 'cvReceiptDigest',
]);
const INTEGRATION_FIELDS = new Set(['type', 'stageId', 'sliceId', 'commitSha']);
const REVIEW_FIELDS = new Set(['type', 'stageId', 'verdict', 'summary']);
const STAGE_PLAN_FIELDS = new Set(['type', 'stageId', 'manifestDigest']);
const SPV_RESULT_FIELDS = new Set(['type', 'stageId', 'manifestDigest', 'summary']);
const GATE_RESULT_FIELDS = new Set([
  'type', 'stageId', 'verdict', 'manifestDigest', 'snapshotDigest', 'summary',
]);
const GATE_INTERRUPTED_FIELDS = new Set([
  'type', 'stageId', 'reason', 'durationMs', 'manifestDigest', 'snapshotDigest',
]);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function checkUnknownFields(
  obj: Record<string, unknown>,
  known: Set<string>,
  errors: FieldError[],
): void {
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      errors.push({ path: key, message: `Unknown field "${key}"` });
    }
  }
}

function expectString(value: unknown, path: string, errors: FieldError[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push({
      path,
      message: `Expected non-empty string, got ${value === null ? 'null' : typeof value}`,
    });
  }
}

/**
 * Identifier charset check (F-2): stageId / sliceId are used verbatim in
 * receipt category path construction, so they are restricted to the safe
 * charset `^[A-Za-z0-9_-]+$` — path separators and traversal segments
 * (`../../evil`, `..\evil`, spaces, ...) are rejected at the schema layer
 * before any path is built or receipt written.
 */
const IDENTIFIER_CHARSET = /^[A-Za-z0-9_-]+$/;

function expectIdentifier(value: unknown, path: string, errors: FieldError[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push({
      path,
      message: `Expected non-empty string, got ${value === null ? 'null' : typeof value}`,
    });
    return;
  }
  if (!IDENTIFIER_CHARSET.test(value)) {
    errors.push({
      path,
      message: `Expected identifier matching ^[A-Za-z0-9_-]+$, got ${JSON.stringify(value)}`,
    });
  }
}

function expectStringLiteral(
  value: unknown,
  literals: readonly string[],
  path: string,
  errors: FieldError[],
): void {
  if (typeof value !== 'string') {
    errors.push({ path, message: `Expected string, got ${value === null ? 'null' : typeof value}` });
    return;
  }
  if (!(literals as readonly string[]).includes(value)) {
    errors.push({
      path,
      message: `Expected one of: ${literals.map((l) => JSON.stringify(l)).join(', ')}`,
    });
  }
}

function throwIfErrors(errors: FieldError[]): never | void {
  if (errors.length > 0) {
    throw new SchemaValidationError(
      `Schema validation failed: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
      errors,
    );
  }
}

/**
 * Validate a Worker envelope through its explicit schemaVersion discriminator.
 * Unknown or missing versions are rejected without entering either consumer;
 * in particular, a schema-v2 envelope never falls through to the v1 validator.
 */
function validateWorkerEnvelopeBySchemaVersion(value: unknown): void {
  if (!isRecord(value)) {
    throw new SchemaValidationError(
      'Schema validation failed: worker envelope must be a non-null, non-array object',
      [{ path: '', message: 'Worker envelope must be a non-null, non-array object' }],
    );
  }

  switch (value.schemaVersion) {
    case 1:
      validateWorkerResultEnvelope(value);
      return;
    case 2:
      validateVNextWorkerResultEnvelope(value);
      return;
    default:
      throw new SchemaValidationError(
        `Schema validation failed: envelope.schemaVersion must be 1 or 2, got ${JSON.stringify(value.schemaVersion)}`,
        [{ path: 'schemaVersion', message: 'Expected schemaVersion discriminator 1 or 2' }],
      );
  }
}

/**
 * Reject any value that is not a canonical `AdmissionRequest` member.
 *
 * Unknown type discriminant, unknown fields, missing fields and out-of-set
 * literals throw `SchemaValidationError` (canonical code
 * RUNTIME.SCHEMA_MISMATCH) with per-field errors — never partial acceptance,
 * never silent defaulting. The `worker_result` envelope is routed by its
 * explicit schemaVersion discriminator to exactly one versioned validator.
 */
export function assertAdmissionRequest(value: unknown): asserts value is RuntimeAdmissionRequest {
  if (!isRecord(value)) {
    throw new SchemaValidationError(
      `Schema validation failed: : Expected object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`,
      [{ path: '', message: 'AdmissionRequest must be a non-null, non-array object' }],
    );
  }

  const errors: FieldError[] = [];
  const type = value.type;
  if (
    typeof type !== 'string' ||
    !(RUNTIME_ADMISSION_REQUEST_TYPES as readonly string[]).includes(type)
  ) {
    errors.push({
      path: 'type',
      message:
        `type must be one of: ${RUNTIME_ADMISSION_REQUEST_TYPES.map((t) => JSON.stringify(t)).join(', ')}`,
    });
    throwIfErrors(errors);
  }

  switch (type) {
    case 'worker_result': {
      checkUnknownFields(value, WORKER_RESULT_FIELDS, errors);
      // Canonical S02-B seam: the envelope validator produces its own
      // field-located errors; re-prefix them under `envelope.` so the
      // request-level error locates the offending envelope field.
      try {
        validateWorkerEnvelopeBySchemaVersion(value.envelope);
      } catch (err) {
        if (err instanceof SchemaValidationError) {
          for (const fe of err.fieldErrors) {
            errors.push({
              path: fe.path === '' ? 'envelope' : `envelope.${fe.path}`,
              message: fe.message,
            });
          }
        } else {
          throw err;
        }
      }
      break;
    }
    case 'cv_result': {
      checkUnknownFields(value, CV_RESULT_FIELDS, errors);
      expectIdentifier(value.stageId, 'stageId', errors);
      expectIdentifier(value.sliceId, 'sliceId', errors);
      expectStringLiteral(value.verdict, CV_VERDICTS, 'verdict', errors);
      expectString(value.snapshotDigest, 'snapshotDigest', errors);
      expectString(value.summary, 'summary', errors);
      break;
    }
    case 'cv_result_vnext': {
      checkUnknownFields(value, CV_RESULT_VNEXT_FIELDS, errors);
      try {
        validateVNextCVResultEnvelope(value.envelope);
      } catch (err) {
        if (err instanceof SchemaValidationError) {
          for (const fe of err.fieldErrors) {
            errors.push({
              path: fe.path === '' ? 'envelope' : `envelope.${fe.path}`,
              message: fe.message,
            });
          }
        } else {
          throw err;
        }
      }
      break;
    }
    case 'slice_commit': {
      checkUnknownFields(value, SLICE_COMMIT_FIELDS, errors);
      expectIdentifier(value.stageId, 'stageId', errors);
      expectIdentifier(value.sliceId, 'sliceId', errors);
      expectString(value.commitSha, 'commitSha', errors);
      expectString(value.cvReceiptDigest, 'cvReceiptDigest', errors);
      break;
    }
    case 'integration': {
      checkUnknownFields(value, INTEGRATION_FIELDS, errors);
      expectIdentifier(value.stageId, 'stageId', errors);
      expectIdentifier(value.sliceId, 'sliceId', errors);
      expectString(value.commitSha, 'commitSha', errors);
      break;
    }
    case 'stage_review': {
      checkUnknownFields(value, REVIEW_FIELDS, errors);
      expectIdentifier(value.stageId, 'stageId', errors);
      expectStringLiteral(value.verdict, REVIEW_VERDICTS, 'verdict', errors);
      expectString(value.summary, 'summary', errors);
      break;
    }
    case 'project_review': {
      checkUnknownFields(value, REVIEW_FIELDS, errors);
      expectIdentifier(value.stageId, 'stageId', errors);
      expectStringLiteral(value.verdict, REVIEW_VERDICTS, 'verdict', errors);
      expectString(value.summary, 'summary', errors);
      break;
    }
    case 'stage_plan': {
      checkUnknownFields(value, STAGE_PLAN_FIELDS, errors);
      expectIdentifier(value.stageId, 'stageId', errors);
      expectString(value.manifestDigest, 'manifestDigest', errors);
      break;
    }
    case 'spv_result': {
      checkUnknownFields(value, SPV_RESULT_FIELDS, errors);
      expectIdentifier(value.stageId, 'stageId', errors);
      expectString(value.manifestDigest, 'manifestDigest', errors);
      expectString(value.summary, 'summary', errors);
      break;
    }
    case 'gate_result': {
      checkUnknownFields(value, GATE_RESULT_FIELDS, errors);
      expectIdentifier(value.stageId, 'stageId', errors);
      expectStringLiteral(value.verdict, GATE_VERDICTS, 'verdict', errors);
      expectString(value.manifestDigest, 'manifestDigest', errors);
      expectString(value.snapshotDigest, 'snapshotDigest', errors);
      expectString(value.summary, 'summary', errors);
      break;
    }
    case 'gate_interrupted': {
      checkUnknownFields(value, GATE_INTERRUPTED_FIELDS, errors);
      expectIdentifier(value.stageId, 'stageId', errors);
      expectStringLiteral(value.reason, GATE_INTERRUPTED_REASONS, 'reason', errors);
      if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
        errors.push({
          path: 'durationMs',
          message: `Expected non-negative finite number, got ${typeof value.durationMs}`,
        });
      }
      expectString(value.manifestDigest, 'manifestDigest', errors);
      expectString(value.snapshotDigest, 'snapshotDigest', errors);
      break;
    }
    default: {
      // Unreachable for validated type values; runtime guard only — a JS
      // caller bypassing the discriminant check never gets a silent pass.
      errors.push({
        path: 'type',
        message: `Unknown AdmissionRequest type ${JSON.stringify(type)}`,
      });
    }
  }

  throwIfErrors(errors);
}
