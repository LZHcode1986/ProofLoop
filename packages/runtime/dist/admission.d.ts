/**
 * @proofloop/runtime — AdmissionService admit methods (S02-E-T02)
 *
 * Wires the two slice-boundary admit operations onto the unified admit
 * pipeline (`runAdmitPipeline`, S02-E-T01):
 *
 *   admitWorkerResult(request, deps)  — PO-S02-E-02
 *     envelope schema validation (S02-B `validateWorkerResultEnvelope`
 *     reused by `assertAdmissionRequest`) → outcome branch:
 *       completed (implement/recover)  → TASK_COMPLETE Receipt to
 *         `tasks/<stage>/<slice>/`, slice stays IN_PROGRESS;
 *       completed (finalize-slice + evidence finalized) → TASK_COMPLETE
 *         Receipt, reducer FINISH_TASKS advances IN_PROGRESS → READY_FOR_CV;
 *       completed (repair/diagnose — CV-REPAIR recheck branch, S02-D row 6)
 *         → precondition slice derived READY_FOR_CV + CV_REPAIR receipt
 *         binding; TASK_COMPLETE Receipt (payload mode + bound cv receipt
 *         digest); slice stays READY_FOR_CV; CVStatus via kernel FIX event
 *         REPAIR → PENDING_RECHECK;
 *       blocked | needs-decision | failed → structured rejection, no Receipt;
 *       state not allowed → structured rejection, no Receipt.
 *
 *   admitCVResult(request, deps)      — PO-S02-E-03
 *     precondition slice state ∈ {READY_FOR_CV, CV_IN_PROGRESS};
 *     READY_FOR_CV → cv_dispatched composite (reducer RUN_CV: slice
 *       READY_FOR_CV → CV_IN_PROGRESS; cv by current value START_CV /
 *       RECHECK / MARK_READY+START_CV) → verdict application:
 *       PASS  → reducer PASS_CV → CV_PASSED/PASS + CV_PASS Receipt;
 *       REPAIR → reducer REVISE → READY_FOR_CV/REPAIR + CV_REPAIR Receipt;
 *     CV_IN_PROGRESS → verdict applied directly (no dispatched step);
 *     invalid verdict / missing snapshot binding → schema rejection, no
 *     Receipt.
 *
 * Every reject path returns the structured `AdmitResult` (accepted: false,
 * receipt_ref: null, canonical Finding) and never produces a Receipt
 * (AWI-006 forbidden shortcuts: no direct file writes — persistence is
 * exclusively the injected ReceiptWriterPort through the pipeline).
 */
import type { RuntimeAction, ReconciledStageState } from './state-model';
import type { ReconcileStageResult } from './reconcile';
import type { ReceiptWriterPort, AdmitResult } from './admit-pipeline';
import type { WorkerResultAdmissionRequest, CVResultAdmissionRequest, SliceCommitAdmissionRequest, IntegrationAdmissionRequest, StageReviewAdmissionRequest, ProjectReviewAdmissionRequest, StagePlanAdmissionRequest } from './admission-request';
/** Reducer seam signature (defaults to the pure runtime reducer). */
export type AdmitReduceFn = (state: ReconciledStageState, action: RuntimeAction) => ReconciledStageState;
/**
 * Dependencies of the slice-boundary admit methods.
 *
 * `reconcile` defaults to `reconcileStage` over `projectRoot`, `reduce` to
 * `reduceRuntimeAction`, and `writer` to the kernel ReceiptWriter — callers
 * only override what they need (tests inject a fake writer / spy reducer).
 */
export interface AdmissionDeps {
    /** Project root — canonical receipt category directories resolve under it. */
    readonly projectRoot: string;
    /** Deterministic current-state source. */
    readonly reconcile?: (stageId: string) => ReconcileStageResult;
    /** Reducer seam. */
    readonly reduce?: AdmitReduceFn;
    /** Persistence port — kernel ReceiptWriter by default. */
    readonly writer?: ReceiptWriterPort;
    /**
     * Canonical manifest digest source for stage-plan admits (PO-S02-E-07).
     * Defaults to reading `<projectRoot>/.proofloop/manifests/<stage>.json` and
     * computing the runtime canonical digest.
     */
    readonly readManifestDigest?: (stageId: string) => string;
}
/**
 * Admit a WorkerResultEnvelope (S02-B) into a canonical TASK_COMPLETE
 * Receipt, or reject it structurally without a Receipt.
 *
 * @param request - `{ type: 'worker_result', envelope }` — schema-validated
 *        inside the pipeline (fail closed via the S02-B envelope validator).
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export declare function admitWorkerResult(request: WorkerResultAdmissionRequest, deps: AdmissionDeps): AdmitResult;
/**
 * Admit a CV verdict into a canonical CV_PASS / CV_REPAIR Receipt, or reject
 * it structurally without a Receipt.
 *
 * @param request - `{ type: 'cv_result', stageId, sliceId, verdict,
 *        snapshotDigest, summary }` — schema-validated inside the pipeline
 *        (verdict ∈ closed {PASS, REPAIR}; snapshot binding required).
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export declare function admitCVResult(request: CVResultAdmissionRequest, deps: AdmissionDeps): AdmitResult;
/**
 * Admit a committed slice (PO-S02-E-04, S02-E-T03): precondition slice
 * derived CV_PASSED with a valid cv receipt digest binding + non-empty
 * commit SHA → SLICE_COMMIT Receipt to `committer/<stage>/<slice>/` +
 * reducer INTEGRATE advance CV_PASSED → INTEGRATING.
 *
 * @param request - `{ type: 'slice_commit', stageId, sliceId, commitSha,
 *        cvReceiptDigest }` — schema-validated inside the pipeline
 *        (commitSha / cvReceiptDigest non-empty strings).
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export declare function admitSliceCommit(request: SliceCommitAdmissionRequest, deps: AdmissionDeps): AdmitResult;
/**
 * Admit an integrated slice (PO-S02-E-04, S02-E-T03): precondition slice
 * derived INTEGRATING with a SLICE_COMMIT receipt binding the SAME commit
 * SHA → INTEGRATION_PASS Receipt to `integration/<stage>/<slice>/` +
 * reducer FINISH_INTEGRATION advance INTEGRATING → INTEGRATED.
 *
 * @param request - `{ type: 'integration', stageId, sliceId, commitSha }`
 *        — schema-validated inside the pipeline (commitSha non-empty).
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
export declare function admitIntegration(request: IntegrationAdmissionRequest, deps: AdmissionDeps): AdmitResult;
/**
 * Admit a stage review verdict (PO-S02-E-05).
 *
 * Precondition: stage derived UNDER_REVIEW (reconcile fact).
 *   - verdict ACCEPTED → STAGE_REVIEW_PASS Receipt to `review/<stage>/` +
 *     reducer COMPLETE advance UNDER_REVIEW → COMPLETED;
 *   - verdict REPAIR → legal no-Receipt branch: reducer REOPEN advance
 *     UNDER_REVIEW → EXECUTING, returns a warn Finding;
 *   - stage not UNDER_REVIEW → structured rejection, no Receipt.
 */
export declare function admitStageReview(request: StageReviewAdmissionRequest, deps: AdmissionDeps): AdmitResult;
/**
 * Admit a project review verdict (PO-S02-E-06).
 *
 * Precondition: project derived UNDER_REVIEW (a reconcile fact, F-1 — the
 * project derives UNDER_REVIEW when the stage is COMPLETED, i.e. its stage
 * review passed, and no PROJECT_REVIEW_PASS receipt exists yet).
 *   - verdict ACCEPTED → PROJECT_REVIEW_PASS Receipt to `project/` +
 *     reducer COMPLETE advance UNDER_REVIEW → COMPLETED;
 *   - verdict REPAIR → legal no-Receipt branch: reducer REOPEN advance
 *     UNDER_REVIEW → IN_PROGRESS, returns a warn Finding;
 *   - project not derived UNDER_REVIEW → structured rejection, no Receipt.
 */
export declare function admitProjectReview(request: ProjectReviewAdmissionRequest, deps: AdmissionDeps): AdmitResult;
/**
 * Admit a stage plan (PO-S02-E-07).
 *
 * Precondition: the request `manifestDigest` binds the canonical digest of
 * `.proofloop/manifests/<stage>.json` (runtime canonical digest) AND the
 * stage is UNINITIALIZED (no STAGE_PLAN Receipt yet).
 *   - bound → STAGE_PLAN Receipt to `plan/<stage>/` + reducer PLAN advance
 *     UNINITIALIZED → PLANNING;
 *   - digest mismatch or duplicate admit (stage not UNINITIALIZED) →
 *     structured rejection, no Receipt.
 */
export declare function admitStagePlan(request: StagePlanAdmissionRequest, deps: AdmissionDeps): AdmitResult;
//# sourceMappingURL=admission.d.ts.map