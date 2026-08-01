"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.admitWorkerResult = admitWorkerResult;
exports.admitCVResult = admitCVResult;
exports.admitSliceCommit = admitSliceCommit;
exports.admitIntegration = admitIntegration;
exports.admitStageReview = admitStageReview;
exports.admitProjectReview = admitProjectReview;
exports.admitStagePlan = admitStagePlan;
const kernel_1 = require("@proofloop/kernel");
const reducer_1 = require("./reducer");
const reconcile_1 = require("./reconcile");
const receipt_layout_1 = require("./receipt-layout");
const receipt_reader_1 = require("./receipt-reader");
const manifest_source_1 = require("./manifest-source");
const admit_pipeline_1 = require("./admit-pipeline");
// ============================================================
// Shared helpers
// ============================================================
/** Structured rejection builder — canonical Finding, no Receipt. */
function refuse(code, message) {
    return { accepted: false, findings: [{ code, severity: 'error', message }] };
}
/** Re-attach the Reconcile-only chain fields to a reducer-advanced state. */
function toStageResult(next, source) {
    return {
        ...next,
        receipt_chain_valid: source.receipt_chain_valid,
        receipt_categories: source.receipt_categories,
    };
}
/**
 * Advance the stage state through the reducer and verify the BOUND slice
 * reached the expected target. The reducer targets the active slice (first
 * non-INTEGRATED); when the bound slice is not that slice (or the transition
 * is illegal), the admit is refused — never a guess, never a wrong-slice
 * advance.
 */
function advanceSlice(state, sliceId, action, reduce, reached) {
    let next;
    try {
        next = reduce(state, action);
    }
    catch (err) {
        if (err instanceof kernel_1.InvalidTransitionError) {
            return refuse('DOMAIN.INVALID_TRANSITION', `state advance refused for slice "${sliceId}" via ${action.entity}.${action.event}: ${err.message}`);
        }
        throw err;
    }
    const bound = next.slices.find((s) => s.slice_id === sliceId);
    if (bound === undefined || !reached(bound)) {
        return refuse('DOMAIN.INVALID_TRANSITION', `state advance via ${action.entity}.${action.event} did not reach the expected target for slice "${sliceId}"`);
    }
    return { accepted: true, nextState: toStageResult(next, state) };
}
// ============================================================
// admitWorkerResult (PO-S02-E-02)
// ============================================================
/**
 * Admit a WorkerResultEnvelope (S02-B) into a canonical TASK_COMPLETE
 * Receipt, or reject it structurally without a Receipt.
 *
 * @param request - `{ type: 'worker_result', envelope }` — schema-validated
 *        inside the pipeline (fail closed via the S02-B envelope validator).
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
function admitWorkerResult(request, deps) {
    return (0, admit_pipeline_1.runAdmitPipeline)({
        request,
        reconcile: deps.reconcile ?? ((stageId) => (0, reconcile_1.reconcileStage)({ projectRoot: deps.projectRoot, stageId })),
        writer: deps.writer,
        steps: workerResultSteps(request, deps),
    });
}
/** Per-admit pipeline wiring for worker-result admits. */
function workerResultSteps(request, deps) {
    const envelope = request.envelope;
    const reduce = deps.reduce ?? reducer_1.reduceRuntimeAction;
    return {
        precheck: (state) => workerResultPrecheck(state, envelope, reduce, deps.projectRoot),
        buildReceipt: (state) => workerResultReceipt(state, envelope),
        targetDir: () => (0, receipt_layout_1.tasksReceiptDir)(deps.projectRoot, envelope.stageId, envelope.sliceId),
    };
}
/**
 * Worker-result precheck (PO-S02-E-02):
 *   - bound slice must exist in the reconciled state;
 *   - outcome must be `completed` (blocked / needs-decision / failed are
 *     refused — no success Receipt for a failed run, AWI-006);
 *   - per-mode state precondition + reducer advance:
 *       implement/recover  → slice IN_PROGRESS (stays);
 *       finalize-slice     → IN_PROGRESS + evidence finalized →
 *                            FINISH_TASKS → READY_FOR_CV;
 *       repair/diagnose    → READY_FOR_CV + CV_REPAIR binding (cv REPAIR) →
 *                            cv FIX → PENDING_RECHECK (slice stays
 *                            READY_FOR_CV).
 */
function workerResultPrecheck(state, envelope, reduce, projectRoot) {
    // F-3 dedup gate: receipts are immutable and content-addressed, so the
    // tasks/<stage>/<slice>/ chain is a deterministic record of every admitted
    // worker result — an existing TASK_COMPLETE receipt bound to the SAME
    // actionToken proves this envelope was already admitted. Refuse before any
    // state advance or write (no second receipt can ever exist).
    const alreadyAdmitted = (0, receipt_reader_1.readReceiptCategory)({
        projectRoot,
        category: 'tasks',
        stageId: envelope.stageId,
        sliceId: envelope.sliceId,
    }).receipts.some((r) => r.receipt.type === 'TASK_COMPLETE' &&
        r.receipt.payload?.['action_token'] === envelope.actionToken);
    if (alreadyAdmitted) {
        return refuse('DOMAIN.INVALID_TRANSITION', `actionToken "${envelope.actionToken}" has already been admitted as a TASK_COMPLETE receipt for slice "${envelope.sliceId}" — duplicate admit refused`);
    }
    const slice = state.slices.find((s) => s.slice_id === envelope.sliceId);
    if (slice === undefined) {
        return refuse('DOMAIN.STAGE_NOT_FOUND', `slice "${envelope.sliceId}" not found in stage "${envelope.stageId}"`);
    }
    if (envelope.outcome !== 'completed') {
        return refuse('DOMAIN.INVALID_TRANSITION', `worker outcome "${envelope.outcome}" is not admissible — no TASK_COMPLETE receipt is written`);
    }
    switch (envelope.mode) {
        case 'implement-task':
        case 'recover-task':
            if (slice.slice_state !== kernel_1.SliceState.IN_PROGRESS) {
                return refuse('DOMAIN.INVALID_TRANSITION', `slice "${slice.slice_id}" is ${slice.slice_state}, expected IN_PROGRESS for mode ${envelope.mode}`);
            }
            // implement/recover: slice stays IN_PROGRESS — no state advance.
            return { accepted: true, nextState: state };
        case 'finalize-slice':
            if (slice.slice_state !== kernel_1.SliceState.IN_PROGRESS) {
                return refuse('DOMAIN.INVALID_TRANSITION', `slice "${slice.slice_id}" is ${slice.slice_state}, expected IN_PROGRESS for mode finalize-slice`);
            }
            if (!slice.slice_evidence_finalized) {
                return refuse('DOMAIN.INVALID_TRANSITION', `slice "${slice.slice_id}" evidence is not finalized — finalize-slice admit refused`);
            }
            return advanceSlice(state, envelope.sliceId, { entity: 'slice', event: 'FINISH_TASKS' }, reduce, (s) => s.slice_state === kernel_1.SliceState.READY_FOR_CV);
        case 'repair':
        case 'diagnose': {
            if (slice.slice_state !== kernel_1.SliceState.READY_FOR_CV) {
                return refuse('DOMAIN.INVALID_TRANSITION', `slice "${slice.slice_id}" is ${slice.slice_state}, expected READY_FOR_CV for mode ${envelope.mode}`);
            }
            const cvReceipt = slice.latest_cv_receipt;
            if (cvReceipt === null || cvReceipt.type !== 'CV_REPAIR') {
                return refuse('DOMAIN.INVALID_TRANSITION', `slice "${slice.slice_id}" has no CV_REPAIR receipt binding — ${envelope.mode} admit refused`);
            }
            if (slice.cv_status !== kernel_1.CVStatus.REPAIR) {
                return refuse('DOMAIN.INVALID_TRANSITION', `slice "${slice.slice_id}" cv status is ${slice.cv_status}, expected REPAIR for ${envelope.mode} admit`);
            }
            // CV-REPAIR recheck branch: slice stays READY_FOR_CV; cv REPAIR → FIX
            // → PENDING_RECHECK (kernel §6 CV table).
            return advanceSlice(state, envelope.sliceId, { entity: 'cv', event: 'FIX' }, reduce, (s) => s.cv_status === kernel_1.CVStatus.PENDING_RECHECK);
        }
    }
}
/**
 * Canonical TASK_COMPLETE Receipt body (PO-S02-E-02): payload binds the
 * envelope facts (action_token / mode / evidence_ref / changed_files /
 * verification_runs / summary); repair/diagnose additionally bind the
 * CV_REPAIR receipt digest of the recheck branch.
 */
function workerResultReceipt(state, envelope) {
    const payload = {
        action_token: envelope.actionToken,
        mode: envelope.mode,
        evidence_ref: envelope.evidenceRef,
        changed_files: [...envelope.changedFiles],
        verification_runs: envelope.verificationRuns.map((r) => ({ ...r })),
        summary: envelope.summary,
    };
    if (envelope.mode === 'repair' || envelope.mode === 'diagnose') {
        const slice = state.slices.find((s) => s.slice_id === envelope.sliceId);
        const cvReceipt = slice?.latest_cv_receipt;
        if (cvReceipt !== undefined && cvReceipt !== null && cvReceipt.type === 'CV_REPAIR') {
            payload.cv_receipt_digest = cvReceipt.digest;
        }
    }
    return {
        type: 'TASK_COMPLETE',
        stage_id: envelope.stageId,
        slice_id: envelope.sliceId,
        timestamp: new Date().toISOString(),
        payload,
    };
}
// ============================================================
// admitCVResult (PO-S02-E-03)
// ============================================================
/**
 * Admit a CV verdict into a canonical CV_PASS / CV_REPAIR Receipt, or reject
 * it structurally without a Receipt.
 *
 * @param request - `{ type: 'cv_result', stageId, sliceId, verdict,
 *        snapshotDigest, summary }` — schema-validated inside the pipeline
 *        (verdict ∈ closed {PASS, REPAIR}; snapshot binding required).
 * @param deps    - projectRoot / reconcile / reduce / writer seams.
 */
function admitCVResult(request, deps) {
    return (0, admit_pipeline_1.runAdmitPipeline)({
        request,
        reconcile: deps.reconcile ?? ((stageId) => (0, reconcile_1.reconcileStage)({ projectRoot: deps.projectRoot, stageId })),
        writer: deps.writer,
        steps: cvResultSteps(request, deps),
    });
}
/** Per-admit pipeline wiring for CV-result admits. */
function cvResultSteps(request, deps) {
    const reduce = deps.reduce ?? reducer_1.reduceRuntimeAction;
    return {
        precheck: (state) => cvResultPrecheck(state, request, reduce),
        buildReceipt: () => ({
            type: request.verdict === 'PASS' ? 'CV_PASS' : 'CV_REPAIR',
            stage_id: request.stageId,
            slice_id: request.sliceId,
            timestamp: new Date().toISOString(),
            payload: {
                verdict: request.verdict,
                snapshot_digest: request.snapshotDigest,
                summary: request.summary,
            },
        }),
        targetDir: () => (0, receipt_layout_1.cvReceiptDir)(deps.projectRoot, request.stageId, request.sliceId),
    };
}
/**
 * CV-result precheck (PO-S02-E-03):
 *   - bound slice must exist; slice state ∈ {READY_FOR_CV, CV_IN_PROGRESS};
 *   - READY_FOR_CV → cv_dispatched composite (reducer RUN_CV: slice
 *     READY_FOR_CV → CV_IN_PROGRESS; cv by current value START_CV /
 *     RECHECK / MARK_READY+START_CV — the reducer's `advanceCvToInProgress`);
 *     a cv REPAIR slice refuses here (no re-CV before a repair is admitted);
 *   - verdict application via the reducer: PASS → PASS_CV (CV_PASSED/PASS),
 *     REPAIR → REVISE (READY_FOR_CV/REPAIR).
 */
function cvResultPrecheck(state, request, reduce) {
    const slice = state.slices.find((s) => s.slice_id === request.sliceId);
    if (slice === undefined) {
        return refuse('DOMAIN.STAGE_NOT_FOUND', `slice "${request.sliceId}" not found in stage "${request.stageId}"`);
    }
    if (slice.slice_state !== kernel_1.SliceState.READY_FOR_CV &&
        slice.slice_state !== kernel_1.SliceState.CV_IN_PROGRESS) {
        return refuse('DOMAIN.INVALID_TRANSITION', `slice "${slice.slice_id}" is ${slice.slice_state}, expected READY_FOR_CV or CV_IN_PROGRESS for CV admit`);
    }
    let mid = state;
    if (slice.slice_state === kernel_1.SliceState.READY_FOR_CV) {
        // cv_dispatched composite (PO-S02-E-03): the reducer RUN_CV advances
        // slice → CV_IN_PROGRESS and cv → IN_PROGRESS by the current CVStatus.
        const dispatched = advanceSlice(state, request.sliceId, { entity: 'slice', event: 'RUN_CV' }, reduce, (s) => s.slice_state === kernel_1.SliceState.CV_IN_PROGRESS && s.cv_status === kernel_1.CVStatus.IN_PROGRESS);
        if (!dispatched.accepted)
            return dispatched;
        mid = dispatched.nextState;
    }
    // Verdict application from CV_IN_PROGRESS (PASS_CV / REVISE).
    if (request.verdict === 'PASS') {
        return advanceSlice(mid, request.sliceId, { entity: 'slice', event: 'PASS_CV' }, reduce, (s) => s.slice_state === kernel_1.SliceState.CV_PASSED && s.cv_status === kernel_1.CVStatus.PASS);
    }
    return advanceSlice(mid, request.sliceId, { entity: 'slice', event: 'REVISE' }, reduce, (s) => s.slice_state === kernel_1.SliceState.READY_FOR_CV && s.cv_status === kernel_1.CVStatus.REPAIR);
}
// ============================================================
// admitSliceCommit / admitIntegration (PO-S02-E-04)
// ============================================================
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
function admitSliceCommit(request, deps) {
    return (0, admit_pipeline_1.runAdmitPipeline)({
        request,
        reconcile: deps.reconcile ?? ((stageId) => (0, reconcile_1.reconcileStage)({ projectRoot: deps.projectRoot, stageId })),
        writer: deps.writer,
        steps: sliceCommitSteps(request, deps),
    });
}
/** Per-admit pipeline wiring for slice-commit admits. */
function sliceCommitSteps(request, deps) {
    const reduce = deps.reduce ?? reducer_1.reduceRuntimeAction;
    return {
        precheck: (state) => sliceCommitPrecheck(state, request, reduce),
        buildReceipt: () => ({
            type: 'SLICE_COMMIT',
            stage_id: request.stageId,
            slice_id: request.sliceId,
            timestamp: new Date().toISOString(),
            payload: {
                status: 'committed',
                slice_commit_sha: request.commitSha,
                cv_receipt_digest: request.cvReceiptDigest,
            },
        }),
        targetDir: () => (0, receipt_layout_1.committerReceiptDir)(deps.projectRoot, request.stageId, request.sliceId),
    };
}
/**
 * Slice-commit precheck (PO-S02-E-04):
 *   - bound slice must exist (else DOMAIN.STAGE_NOT_FOUND);
 *   - slice must be derived CV_PASSED (reconcile fact — an un-CV'd slice
 *     and an already-committed/integrated slice are both refused);
 *   - the request's cv receipt digest must bind the latest CV_PASS receipt
 *     digest (missing / mismatched binding → refused);
 *   - commit SHA non-empty is schema-guaranteed (S02-E-T01 expectString);
 *   - reducer INTEGRATE advances CV_PASSED → INTEGRATING.
 */
function sliceCommitPrecheck(state, request, reduce) {
    const slice = state.slices.find((s) => s.slice_id === request.sliceId);
    if (slice === undefined) {
        return refuse('DOMAIN.STAGE_NOT_FOUND', `slice "${request.sliceId}" not found in stage "${request.stageId}"`);
    }
    if (slice.slice_state !== kernel_1.SliceState.CV_PASSED) {
        return refuse('DOMAIN.INVALID_TRANSITION', `slice "${slice.slice_id}" is ${slice.slice_state}, expected CV_PASSED for commit admit`);
    }
    const cvReceipt = slice.latest_cv_receipt;
    if (cvReceipt === null ||
        cvReceipt.type !== 'CV_PASS' ||
        request.cvReceiptDigest !== cvReceipt.digest) {
        return refuse('DOMAIN.INVALID_TRANSITION', `slice "${slice.slice_id}" cv receipt digest binding invalid for commit admit`);
    }
    return advanceSlice(state, request.sliceId, { entity: 'slice', event: 'INTEGRATE' }, reduce, (s) => s.slice_state === kernel_1.SliceState.INTEGRATING);
}
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
function admitIntegration(request, deps) {
    return (0, admit_pipeline_1.runAdmitPipeline)({
        request,
        reconcile: deps.reconcile ?? ((stageId) => (0, reconcile_1.reconcileStage)({ projectRoot: deps.projectRoot, stageId })),
        writer: deps.writer,
        steps: integrationSteps(request, deps),
    });
}
/** Per-admit pipeline wiring for integration admits. */
function integrationSteps(request, deps) {
    const reduce = deps.reduce ?? reducer_1.reduceRuntimeAction;
    return {
        precheck: (state) => integrationPrecheck(state, request, reduce),
        buildReceipt: () => ({
            type: 'INTEGRATION_PASS',
            stage_id: request.stageId,
            slice_id: request.sliceId,
            timestamp: new Date().toISOString(),
            payload: {
                status: 'integrated',
                slice_commit_sha: request.commitSha,
            },
        }),
        targetDir: () => (0, receipt_layout_1.integrationReceiptDir)(deps.projectRoot, request.stageId, request.sliceId),
    };
}
/**
 * Integration precheck (PO-S02-E-04):
 *   - bound slice must exist (else DOMAIN.STAGE_NOT_FOUND);
 *   - slice must be derived INTEGRATING (reconcile fact — the S02-C
 *     committed derivation behind INTEGRATING already proves a valid
 *     SLICE_COMMIT binding exists);
 *   - the SLICE_COMMIT receipt must bind the SAME commit SHA as the request
 *     (missing receipt binding / SHA mismatch → refused);
 *   - reducer FINISH_INTEGRATION advances INTEGRATING → INTEGRATED.
 */
function integrationPrecheck(state, request, reduce) {
    const slice = state.slices.find((s) => s.slice_id === request.sliceId);
    if (slice === undefined) {
        return refuse('DOMAIN.STAGE_NOT_FOUND', `slice "${request.sliceId}" not found in stage "${request.stageId}"`);
    }
    if (slice.slice_state !== kernel_1.SliceState.INTEGRATING) {
        return refuse('DOMAIN.INVALID_TRANSITION', `slice "${slice.slice_id}" is ${slice.slice_state}, expected INTEGRATING for integration admit`);
    }
    const commitReceipt = slice.latest_commit_receipt;
    if (commitReceipt === null || commitReceipt.type !== 'SLICE_COMMIT') {
        return refuse('DOMAIN.INVALID_TRANSITION', `slice "${slice.slice_id}" has no SLICE_COMMIT receipt binding — integration admit refused`);
    }
    const recordedSha = commitReceipt.payload?.['slice_commit_sha'];
    if (typeof recordedSha !== 'string' ||
        recordedSha.length === 0 ||
        request.commitSha !== recordedSha) {
        return refuse('DOMAIN.INVALID_TRANSITION', `slice "${slice.slice_id}" commit SHA mismatch — request "${request.commitSha}" does not match the SLICE_COMMIT receipt "${String(recordedSha)}"`);
    }
    return advanceSlice(state, request.sliceId, { entity: 'slice', event: 'FINISH_INTEGRATION' }, reduce, (s) => s.slice_state === kernel_1.SliceState.INTEGRATED);
}
// ============================================================
// admitStageReview / admitProjectReview / admitStagePlan
// (PO-S02-E-05 / PO-S02-E-06 / PO-S02-E-07 — S02-E-T04)
// ============================================================
/**
 * Warn Finding for the review-REPAIR legal branch (PO-S02-E-05/06): the
 * review did not pass but the repair is a legitimate outcome — the entity
 * returns to work, no review-pass Receipt is written. Severity `warn`
 * (recoverable), canonical domain code.
 */
function reviewRepairFinding(entity, id, target) {
    return {
        code: 'DOMAIN.INVALID_TRANSITION',
        severity: 'warn',
        message: `${entity} review REPAIR: ${entity} "${id}" returned to ${target} — ` +
            `no review-pass receipt written`,
    };
}
/**
 * Advance the stage state through the reducer and verify the expected
 * target was reached. An illegal transition or a missed target refuses the
 * admit (DOMAIN.INVALID_TRANSITION) — never a guess, never a wrong advance.
 */
function advanceStage(state, action, reduce, reached) {
    let next;
    try {
        next = reduce(state, action);
    }
    catch (err) {
        if (err instanceof kernel_1.InvalidTransitionError) {
            return refuse('DOMAIN.INVALID_TRANSITION', `state advance refused for stage "${state.stage_id}" via ${action.entity}.${action.event}: ${err.message}`);
        }
        throw err;
    }
    if (!reached(next.stage_state)) {
        return refuse('DOMAIN.INVALID_TRANSITION', `state advance via ${action.entity}.${action.event} did not reach the expected target for stage "${state.stage_id}"`);
    }
    return { accepted: true, nextState: toStageResult(next, state) };
}
/**
 * Advance the project state (a property of the reconciled stage) through
 * the reducer and verify the expected target was reached.
 */
function advanceProject(state, action, reduce, reached) {
    let next;
    try {
        next = reduce(state, action);
    }
    catch (err) {
        if (err instanceof kernel_1.InvalidTransitionError) {
            return refuse('DOMAIN.INVALID_TRANSITION', `state advance refused for project of stage "${state.stage_id}" via ${action.entity}.${action.event}: ${err.message}`);
        }
        throw err;
    }
    if (!reached(next.project_state)) {
        return refuse('DOMAIN.INVALID_TRANSITION', `state advance via ${action.entity}.${action.event} did not reach the expected target for project of stage "${state.stage_id}"`);
    }
    return { accepted: true, nextState: toStageResult(next, state) };
}
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
function admitStageReview(request, deps) {
    return (0, admit_pipeline_1.runAdmitPipeline)({
        request,
        reconcile: deps.reconcile ?? ((stageId) => (0, reconcile_1.reconcileStage)({ projectRoot: deps.projectRoot, stageId })),
        writer: deps.writer,
        steps: stageReviewSteps(request, deps),
    });
}
/** Per-admit pipeline wiring for stage-review admits. */
function stageReviewSteps(request, deps) {
    const reduce = deps.reduce ?? reducer_1.reduceRuntimeAction;
    return {
        precheck: (state) => stageReviewPrecheck(state, request, reduce),
        buildReceipt: () => ({
            type: 'STAGE_REVIEW_PASS',
            stage_id: request.stageId,
            timestamp: new Date().toISOString(),
            payload: { verdict: request.verdict, summary: request.summary },
        }),
        targetDir: () => (0, receipt_layout_1.reviewReceiptDir)(deps.projectRoot, request.stageId),
    };
}
/**
 * Stage-review precheck (PO-S02-E-05): the stage must be derived
 * UNDER_REVIEW (reconcile fact). ACCEPTED → reducer COMPLETE (stage
 * COMPLETED) with a Receipt; REPAIR → reducer REOPEN (stage EXECUTING),
 * a warn Finding and NO Receipt (writeReceipt: false).
 */
function stageReviewPrecheck(state, request, reduce) {
    if (state.stage_state !== kernel_1.StageState.UNDER_REVIEW) {
        return refuse('DOMAIN.INVALID_TRANSITION', `stage "${state.stage_id}" is ${state.stage_state}, expected UNDER_REVIEW for stage review admit`);
    }
    if (request.verdict === 'ACCEPTED') {
        return advanceStage(state, { entity: 'stage', event: 'COMPLETE' }, reduce, (s) => s === kernel_1.StageState.COMPLETED);
    }
    // verdict REPAIR — legal no-Receipt branch (review repair).
    const reopened = advanceStage(state, { entity: 'stage', event: 'REOPEN' }, reduce, (s) => s === kernel_1.StageState.EXECUTING);
    if (!reopened.accepted)
        return reopened;
    return {
        accepted: true,
        nextState: reopened.nextState,
        findings: [reviewRepairFinding('stage', state.stage_id, 'EXECUTING')],
        writeReceipt: false,
    };
}
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
function admitProjectReview(request, deps) {
    return (0, admit_pipeline_1.runAdmitPipeline)({
        request,
        reconcile: deps.reconcile ?? ((stageId) => (0, reconcile_1.reconcileStage)({ projectRoot: deps.projectRoot, stageId })),
        writer: deps.writer,
        steps: projectReviewSteps(request, deps),
    });
}
/** Per-admit pipeline wiring for project-review admits. */
function projectReviewSteps(request, deps) {
    const reduce = deps.reduce ?? reducer_1.reduceRuntimeAction;
    return {
        precheck: (state) => projectReviewPrecheck(state, request, reduce),
        buildReceipt: () => ({
            type: 'PROJECT_REVIEW_PASS',
            stage_id: request.stageId,
            timestamp: new Date().toISOString(),
            payload: { verdict: request.verdict, summary: request.summary },
        }),
        targetDir: () => (0, receipt_layout_1.projectReceiptDir)(deps.projectRoot),
    };
}
/**
 * Project-review precheck (PO-S02-E-06, F-1): the project state is a REAL
 * gate — reconcile derives it deterministically from persisted facts
 * (PROJECT_REVIEW_PASS receipt → COMPLETED; stage COMPLETED without a
 * project receipt → UNDER_REVIEW; else IN_PROGRESS). A project not derived
 * UNDER_REVIEW is refused (DOMAIN.INVALID_TRANSITION with the current value
 * and the expected UNDER_REVIEW). No synthetic SUBMIT_FOR_REVIEW dispatch
 * exists — the project is already UNDER_REVIEW when this gate passes;
 * ACCEPTED → reducer COMPLETE (project COMPLETED) with a Receipt; REPAIR →
 * reducer REOPEN (project IN_PROGRESS), a warn Finding and NO Receipt.
 */
function projectReviewPrecheck(state, request, reduce) {
    if (state.project_state !== kernel_1.ProjectState.UNDER_REVIEW) {
        return refuse('DOMAIN.INVALID_TRANSITION', `project of stage "${state.stage_id}" is ${state.project_state}, expected UNDER_REVIEW for project review admit`);
    }
    if (request.verdict === 'ACCEPTED') {
        return advanceProject(state, { entity: 'project', event: 'COMPLETE' }, reduce, (p) => p === kernel_1.ProjectState.COMPLETED);
    }
    // verdict REPAIR — legal no-Receipt branch (review repair).
    const reopened = advanceProject(state, { entity: 'project', event: 'REOPEN' }, reduce, (p) => p === kernel_1.ProjectState.IN_PROGRESS);
    if (!reopened.accepted)
        return reopened;
    return {
        accepted: true,
        nextState: reopened.nextState,
        findings: [reviewRepairFinding('project', state.stage_id, 'IN_PROGRESS')],
        writeReceipt: false,
    };
}
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
function admitStagePlan(request, deps) {
    return (0, admit_pipeline_1.runAdmitPipeline)({
        request,
        reconcile: deps.reconcile ?? ((stageId) => (0, reconcile_1.reconcileStage)({ projectRoot: deps.projectRoot, stageId })),
        writer: deps.writer,
        steps: stagePlanSteps(request, deps),
    });
}
/** Per-admit pipeline wiring for stage-plan admits. */
function stagePlanSteps(request, deps) {
    const reduce = deps.reduce ?? reducer_1.reduceRuntimeAction;
    return {
        precheck: (state) => stagePlanPrecheck(state, request, deps, reduce),
        buildReceipt: () => ({
            type: 'STAGE_PLAN',
            stage_id: request.stageId,
            timestamp: new Date().toISOString(),
            payload: { status: 'planned', manifest_digest: request.manifestDigest },
        }),
        targetDir: () => (0, receipt_layout_1.planReceiptDir)(deps.projectRoot, request.stageId),
    };
}
/**
 * Stage-plan precheck (PO-S02-E-07): stage must be derived UNINITIALIZED
 * (no STAGE_PLAN Receipt yet — duplicate admit refused) and the request
 * `manifestDigest` must bind the canonical digest of the stage manifest
 * (Manifest lifecycle binding). A missing manifest source is refused as
 * DOMAIN.STAGE_NOT_FOUND. On binding, reducer PLAN advances the stage to
 * PLANNING.
 */
function stagePlanPrecheck(state, request, deps, reduce) {
    if (state.stage_state !== kernel_1.StageState.UNINITIALIZED) {
        return refuse('DOMAIN.INVALID_TRANSITION', `stage "${state.stage_id}" is ${state.stage_state}, expected UNINITIALIZED for STAGE_PLAN admit (duplicate plan or already planned)`);
    }
    const readDigest = deps.readManifestDigest ??
        ((stageId) => (0, manifest_source_1.manifestFileDigest)({ projectRoot: deps.projectRoot, stageId }));
    let canonical;
    try {
        canonical = readDigest(request.stageId);
    }
    catch (err) {
        return refuse('DOMAIN.STAGE_NOT_FOUND', `manifest digest unavailable for stage "${request.stageId}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (request.manifestDigest !== canonical) {
        return refuse('DOMAIN.INVALID_TRANSITION', `manifest digest binding mismatch for stage "${state.stage_id}": request "${request.manifestDigest}" does not match canonical "${canonical}"`);
    }
    return advanceStage(state, { entity: 'stage', event: 'PLAN' }, reduce, (s) => s === kernel_1.StageState.PLANNING);
}
//# sourceMappingURL=admission.js.map