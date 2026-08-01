/**
 * @proofloop/runtime — Unified admit pipeline (AWI-006 / PO-S02-E-01)
 *
 * The single Receipt-creation path for the Stage's 7 admit operations
 * (S02-E-T02..T04 wire each admit method onto this pipeline):
 *
 *   request schema validation (fail closed) → reconcile current state →
 *   reducer precheck / state advance (per-admit steps) → canonical Receipt
 *   construction (type/stage/slice/payload binding + previous_digest chain
 *   linkage) → persistence through the injected `ReceiptWriterPort`
 *   (kernel `writeReceipt` by default) → post-write chain verification →
 *   `{ accepted, receipt_ref, new_state, findings }`.
 *
 * Fail-closed contract (AWI-006 forbidden shortcuts):
 *   - invalid input or an unreconcilable state → structured rejection with a
 *     canonical Finding and NO Receipt;
 *   - a broken target category chain blocks the admit
 *     (RUNTIME.RECEIPT_CHAIN_BROKEN);
 *   - persistence ONLY through the writer port — this module performs no
 *     direct file writes (directory scaffolding via mkdir and read-only
 *     chain-tip resolution are the only fs access).
 *
 * The `AdmissionRequest` union is open for S03/S04/S05 extension (SPV /
 * GATE / GATE_INTERRUPTED / SLICE_PLAN kinds); the pipeline accepts any
 * member unchanged.
 */
import type { Finding, ReceiptType, ReceiptWriterOptions, WriteReceiptResult, ChainVerificationResult } from '@proofloop/kernel';
import type { ReconcileStageResult } from './reconcile';
import type { ReconciledStageState, RuntimeAction } from './state-model';
import type { AdmissionRequest, SpvResultAdmissionRequest, GateResultAdmissionRequest, GateInterruptedAdmissionRequest } from './admission-request';
/**
 * Persistence port through which the pipeline writes receipts.
 *
 * The default implementation delegates to the kernel ReceiptWriter seams
 * (`writeReceipt` / `verifyReceiptChain`); tests inject a fake port to prove
 * the pipeline never touches the filesystem for persistence on its own.
 */
export interface ReceiptWriterPort {
    write(data: object, options: ReceiptWriterOptions): WriteReceiptResult;
    verifyChain(receiptDir: string): ChainVerificationResult;
}
/** Default port — kernel ReceiptWriter (temp → fsync → rename → digest verify → chain + lock). */
export declare const defaultReceiptWriter: ReceiptWriterPort;
/**
 * Reducer precheck result: accepted → the pipeline proceeds to write the
 * Receipt (nextState is the advanced post-admit state); refused → the
 * pipeline returns the structured rejection WITHOUT writing anything.
 *
 * Accepted variants may additionally carry:
 *   - `findings` — canonical Findings returned alongside the success result
 *     (empty when absent);
 *   - `writeReceipt: false` — a legal branch that advances the state but
 *     MUST NOT write a Receipt (review REPAIR, PO-S02-E-05/06): the
 *     pipeline returns `{ accepted: true, receipt_ref: null }` with the
 *     findings BEFORE any chain access or write.
 */
export type AdmitPrecheckResult = {
    readonly accepted: true;
    readonly nextState: ReconcileStageResult;
    /** Canonical Findings of an accepted admit (empty when absent). */
    readonly findings?: readonly Finding[];
    /** Set to false for legal branches that must NOT write a Receipt. */
    readonly writeReceipt?: boolean;
} | {
    readonly accepted: false;
    readonly findings: readonly Finding[];
};
/**
 * Canonical Receipt body built by the admit step (version, digest and
 * previous_digest are pipeline/writer-owned: the writer computes the
 * content-addressed digest; the pipeline binds previous_digest to the
 * target category chain tip).
 */
export interface ReceiptBuild {
    /** Kernel canonical 12-type literal — never an open string. */
    readonly type: ReceiptType;
    readonly stage_id: string;
    readonly slice_id?: string;
    readonly timestamp: string;
    readonly payload: Record<string, unknown>;
}
/** Admit-specific steps — the per-operation part of the unified pipeline. */
export interface AdmitPipelineSteps {
    /** Reducer precheck / state advance (T02–T04 fill; refuse → no Receipt). */
    precheck(state: ReconcileStageResult): AdmitPrecheckResult;
    /** Construct the canonical Receipt body bound to type/stage/slice/payload. */
    buildReceipt(state: ReconcileStageResult): ReceiptBuild;
    /** Canonical category directory the receipt is appended to. */
    targetDir(state: ReconcileStageResult): string;
}
export interface AdmitPipelineInput {
    /** Request to admit (schema-validated inside the pipeline — fail closed). */
    readonly request: AdmissionRequest;
    /** Deterministic current-state source (reconcileStage for real callers). */
    readonly reconcile: (stageId: string) => ReconcileStageResult;
    /** Per-admit steps (precheck / receipt build / target directory). */
    readonly steps: AdmitPipelineSteps;
    /** Persistence port — defaults to the kernel ReceiptWriter. */
    readonly writer?: ReceiptWriterPort;
}
/**
 * Unified admit result (AWI-006): accepted flag, the written receipt digest
 * (null when refused), the post-admit state and the canonical Findings.
 *
 * `new_state` is null only when the request was rejected BEFORE
 * reconciliation (schema failure) — for every post-reconcile result it is
 * the current (or advanced) state.
 */
export interface AdmitResult {
    readonly accepted: boolean;
    readonly receipt_ref: string | null;
    readonly new_state: ReconcileStageResult | null;
    readonly findings: readonly Finding[];
}
/**
 * Run the unified admit pipeline (AWI-006) for one AdmissionRequest.
 *
 * Every rejection path returns a structured `AdmitResult` with
 * `accepted: false`, `receipt_ref: null` and a canonical Finding — no
 * Receipt is ever produced for an invalid input or an unsatisfied state.
 */
export declare function runAdmitPipeline(input: AdmitPipelineInput): AdmitResult;
/** Reducer seam signature for the SPV/GATE admits. */
export type SpvGateReduceFn = (state: ReconciledStageState, action: RuntimeAction) => ReconciledStageState;
/**
 * Dependencies of the SPV/GATE admit methods (PO-S03-H-02).
 *
 * `reconcile` defaults to `reconcileStage` over `projectRoot`, `reduce` to
 * `reduceRuntimeAction`, `writer` to the kernel ReceiptWriter, and
 * `readManifestDigest` to the canonical `.proofloop/manifests/<stage>.json`
 * digest — callers only override what they need (tests inject a fake writer).
 */
export interface SpvGateAdmissionDeps {
    /** Project root — canonical receipt category directories resolve under it. */
    readonly projectRoot: string;
    /** Deterministic current-state source. */
    readonly reconcile?: (stageId: string) => ReconcileStageResult;
    /** Reducer seam. */
    readonly reduce?: SpvGateReduceFn;
    /** Persistence port — kernel ReceiptWriter by default. */
    readonly writer?: ReceiptWriterPort;
    /**
     * Canonical manifest digest source (manifest lifecycle binding, same seam
     * as PO-S02-E-07). Defaults to reading
     * `<projectRoot>/.proofloop/manifests/<stage>.json` and computing the
     * runtime canonical digest.
     */
    readonly readManifestDigest?: (stageId: string) => string;
}
/**
 * Admit the SPV result of a planned stage: `SPV_PASS` Receipt to
 * `plan/<stage>/`. Preconditions (fail closed): the stage is derived PLANNING
 * and the request `manifestDigest` binds the canonical stage manifest digest.
 * On acceptance the reducer `FINALIZE_PLAN` advances PLANNING → READY (§6).
 *
 * @param request - `{ type: 'spv_result', stageId, manifestDigest, summary }`
 *        — schema-validated inside the pipeline.
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export declare function admitSpvResult(request: SpvResultAdmissionRequest, deps: SpvGateAdmissionDeps): AdmitResult;
/**
 * Admit the result of a Stage Gate run: `GATE_PASS` / `GATE_FAIL` Receipt to
 * `stage-gate/<stage>/`. Preconditions (fail closed, all verified on real
 * fixtures): every slice is derived INTEGRATED, the working tree is git-clean,
 * the request `snapshotDigest` binds the current git HEAD, and the request
 * `manifestDigest` binds the canonical stage manifest digest. A stage already
 * reviewed (COMPLETED) is refused. On PASS the stage stays at its derived
 * UNDER_REVIEW state (receipts-only reconciliation already derives
 * UNDER_REVIEW from SPV_PASS + all-integrated, §6 READY/UNDER_REVIEW rules);
 * a FAIL writes the receipt without any state advance.
 *
 * @param request - `{ type: 'gate_result', stageId, verdict, manifestDigest,
 *        snapshotDigest, summary }` — schema-validated inside the pipeline.
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export declare function admitGateResult(request: GateResultAdmissionRequest, deps: SpvGateAdmissionDeps): AdmitResult;
/**
 * Admit an INTERRUPTED Stage Gate run: `GATE_INTERRUPTED` Receipt to
 * `stage-gate/<stage>/` (additive 13th ReceiptType). The gate run was
 * cancelled or timed out — this is NOT a verdict: no PASS/FAIL is ever
 * written, the payload carries `reason: 'cancelled' | 'timeout'` and
 * `duration_ms`, and the receipt never blocks the next action like
 * GATE_FAIL nor passes the gate like GATE_PASS — the interrupted gate is
 * retryable (derive-next-action Row 11 still derives RUN_GATE because
 * `gate_fail_present` matches only GATE_FAIL).
 *
 * Preconditions (fail closed, mirror the gate-result context):
 *   1. every manifest slice is derived INTEGRATED;
 *   2. the stage is derived UNDER_REVIEW (the gate runs between execution
 *      and review);
 *   3. the request HEAD binding must equal the current git HEAD;
 *   4. the request manifest digest must bind the canonical stage manifest
 *      digest.
 *
 * Unlike `admitGateResult`, the working-tree git-clean check is NOT a
 * precondition: an interrupted run may leave a dirty tree, and the
 * interruption fact must still be recorded so the gate can be retried.
 * No state advance — the receipt is the fact; derive-next-action consumes
 * gate receipt presence.
 *
 * @param request - `{ type: 'gate_interrupted', stageId, reason,
 *        durationMs, manifestDigest, snapshotDigest }` — schema-validated
 *        inside the pipeline (reason ∈ closed {cancelled, timeout}).
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export declare function admitGateInterrupted(request: GateInterruptedAdmissionRequest, deps: SpvGateAdmissionDeps): AdmitResult;
//# sourceMappingURL=admit-pipeline.d.ts.map