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
import type { WorkerResultEnvelope } from './relay-contract';
/** Request `type` discriminants — closed 10-value set (AWI-006 + PO-S03-H-02 + S05-A). */
export declare const ADMISSION_REQUEST_TYPES: readonly ["worker_result", "cv_result", "slice_commit", "integration", "stage_review", "project_review", "stage_plan", "spv_result", "gate_result", "gate_interrupted"];
export type AdmissionRequestType = (typeof ADMISSION_REQUEST_TYPES)[number];
/** CV verdicts — closed 2-value set. */
export declare const CV_VERDICTS: readonly ["PASS", "REPAIR"];
export type CvVerdict = (typeof CV_VERDICTS)[number];
/** Gate verdicts — closed 2-value set (PO-S03-H-02). */
export declare const GATE_VERDICTS: readonly ["PASS", "FAIL"];
export type GateVerdict = (typeof GATE_VERDICTS)[number];
/**
 * Gate interruption reasons — closed 2-value set (S05-A-T05, HP-004/AWI-015).
 *
 * A gate interruption is NOT a gate verdict: `GATE_INTERRUPTED` is a
 * separate 13th ReceiptType whose payload carries `reason` from this closed
 * set plus `duration_ms`. GATE_VERDICTS intentionally stays {PASS, FAIL} —
 * an interrupted gate is never admitted as a verdict receipt.
 */
export declare const GATE_INTERRUPTED_REASONS: readonly ["cancelled", "timeout"];
export type GateInterruptedReason = (typeof GATE_INTERRUPTED_REASONS)[number];
/** Review verdicts — closed 2-value set. */
export declare const REVIEW_VERDICTS: readonly ["ACCEPTED", "REPAIR"];
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
/**
 * Worker result admit — binds the canonical S02-B WorkerResultEnvelope.
 * The envelope is non-authoritative until admitted (Blueprint #13): the
 * pipeline validates it via the S02-B validator before any Receipt exists.
 */
export interface WorkerResultAdmissionRequest {
    readonly type: 'worker_result';
    readonly envelope: WorkerResultEnvelope;
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
 * SLICE_COMMIT receipt recorded (committer/integration boundary binding).
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
 * receipt to `stage-gate/<stage>/`. Additive 13th ReceiptType: the gate run
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
 * Closed 10-member AdmissionRequest union (AWI-006 + PO-S03-H-02 + S05-A).
 *
 * S05-A adds the `gate_interrupted` member (HP-004/AWI-015): an interrupted
 * gate run admits a GATE_INTERRUPTED receipt with a reason payload — never a
 * PASS/FAIL verdict. S04 extension point: a SLICE_PLAN request kind (if a
 * consumer emerges) joins this union at the type level — S03 deliberately
 * does NOT create SLICE_PLAN receipts (decision record, PO-S03-H-02). The
 * unified pipeline accepts any member unchanged.
 */
export type AdmissionRequest = WorkerResultAdmissionRequest | CVResultAdmissionRequest | SliceCommitAdmissionRequest | IntegrationAdmissionRequest | StageReviewAdmissionRequest | ProjectReviewAdmissionRequest | StagePlanAdmissionRequest | SpvResultAdmissionRequest | GateResultAdmissionRequest | GateInterruptedAdmissionRequest;
/** Canonical stage id binding of a request (envelope for worker_result). */
export declare function admissionRequestStageId(request: AdmissionRequest): string;
/**
 * Canonical slice id binding of a request, or null for stage-level kinds
 * (reviews / project review / stage plan).
 */
export declare function admissionRequestSliceId(request: AdmissionRequest): string | null;
/**
 * Reject any value that is not a canonical `AdmissionRequest` member.
 *
 * Unknown type discriminant, unknown fields, missing fields and out-of-set
 * literals throw `SchemaValidationError` (canonical code
 * RUNTIME.SCHEMA_MISMATCH) with per-field errors — never partial acceptance,
 * never silent defaulting. The `worker_result` envelope is validated through
 * the canonical S02-B `validateWorkerResultEnvelope` seam.
 */
export declare function assertAdmissionRequest(value: unknown): asserts value is AdmissionRequest;
//# sourceMappingURL=admission-request.d.ts.map