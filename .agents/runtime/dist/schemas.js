import { z } from 'zod';
// === IDs ===
export const StageId = z.string().regex(/^S\d{2,}(-[A-Z0-9]+)?$/);
export const SliceId = z.string().regex(/^S\d{2,}-[A-Z]$/);
export const TaskId = z.string().regex(/^S\d{2,}-[A-Z]-T\d+$/);
export const PoId = z.string().regex(/^PO-S\d{2,}-[A-Z]-\d{2}$/);
// === Step type enum ===
export const StepType = z.enum(['command', 'service_start', 'service_stop', 'probe']);
// === Runtime Proof Step ===
export const RuntimeProofStep = z.object({
    id: z.string(),
    type: StepType.optional().default('command'),
    executable: z.string(),
    args: z.array(z.string()),
    cwd: z.string().optional().default('.'),
    timeout_ms: z.number().int().positive().optional().default(300000),
    readiness_signal: z.string().optional(),
    service_ref: z.string().optional(),
    expected_observation: z.string().optional(),
    not_applicable: z.object({
        reason: z.string(),
    }).optional(),
    expected: z.object({
        exit_code: z.number().int().optional(),
        output_contains: z.string().optional(),
        output_matches: z.string().optional(),
    }).optional(),
});
// === Proof Obligation ===
export const ProofObligation = z.object({
    po_id: PoId,
    behavior: z.string(),
    public_seam: z.string(),
    oracle_source: z.string(),
    success_criteria: z.string(),
    failure_criteria: z.string().optional(),
    required_observation: z.string().optional(),
    applicable_risk_facts: z.array(z.string()).optional(),
});
// === Slice ===
export const Slice = z.object({
    slice_id: SliceId,
    goal: z.string(),
    observable_outcome: z.string(),
    public_seam: z.string(),
    dependencies: z.array(SliceId).optional().default([]),
    proof_obligations: z.array(ProofObligation).optional().default([]),
    tasks: z.array(TaskId).optional().default([]),
    risk_facts: z.array(z.string()).optional().default([]),
    evidence_path: z.string(),
    cv_minimum_level: z.enum(['lite', 'standard', 'enhanced']).optional().default('standard'),
});
// === Manifest ===
export const Manifest = z.object({
    stage_id: StageId,
    source_path: z.string(),
    source_digest: z.string(),
    stage_goal: z.string(),
    outcomes: z.array(z.string()),
    slices: z.array(Slice),
    dependencies: z.array(z.string()).optional().default([]),
    risk_facts: z.array(z.string()).optional().default([]),
    runtime_proof: z.array(RuntimeProofStep).optional().default([]),
    compiled_at: z.string().optional(),
    compiled_by: z.string().optional(),
});
// === Receipt Types ===
export const CvVerdict = z.enum(['PASS', 'REPAIR', 'REPLAN', 'BLOCKED', 'ESCALATION_REQUIRED']);
/** Persisted lifecycle state for the mutable Slice Evidence status field.
 *
 * These states deliberately do not reuse immutable CV verdict strings.  The
 * legacy verdict-shaped values remain accepted by runtime adapters only so
 * already-created evidence can be migrated without losing its receipt.
 */
export const CvLifecycleState = z.enum([
    'NOT_RUN', 'READY_FOR_CV', 'CV_VERIFYING', 'CV_REPAIR_REQUIRED',
    'CV_REPLAN_REQUIRED', 'CV_BLOCKED', 'CV_ESCALATION_REQUIRED', 'CV_PASS',
    'SLICE_COMPLETE',
]);
/** Compact, persisted proof that a slice reached Slice COMPLETE. */
export const SliceCompleteFacts = z.object({
    slice_id: SliceId,
    // Receipt references are resolved and read by run-stage; this schema only
    // accepts a meaningful path token (never whitespace or a caller boolean).
    cv: z.object({ verdict: z.literal('PASS'), receipt_ref: z.string().trim().min(1) }),
    // A COMPLETE fact names the actual Git object, not an arbitrary label.
    commit: z.object({ commit_sha: z.string().regex(/^[a-f0-9]{40}$/i) }),
    // Integration refs are persisted artifact references and are checked by the gate.
    integration: z.object({ integration_ref: z.string().trim().min(1) }),
});
/**
 * CV (Code Verification) Receipt.
 *
 * Records a Code Verifier run for a single slice. All fields are
 * business facts — no session IDs or operational metadata.
 */
export const CvReceipt = z.object({
    /** Slice this receipt covers. */
    slice_id: SliceId,
    /** Stage this receipt belongs to. */
    stage_id: StageId,
    /** Content snapshot at time of verification. */
    snapshot: z.string(),
    /** The CV level at which verification was performed. */
    cv_level: z.enum(['lite', 'standard', 'enhanced']),
    /** Type of verification (e.g. 'initial', 'recheck'). */
    verification_type: z.enum(['initial', 'recheck']).optional().default('initial'),
    /** Verdict from the Code Verifier. */
    verdict: CvVerdict,
    /** Proof obligations that failed (PO IDs). */
    failed_po_ids: z.array(z.string()).optional().default([]),
    /** Task IDs affected by the failure. */
    affected_task_ids: z.array(z.string()).optional().default([]),
    /** Test IDs that produced invalid/untrustworthy results. */
    invalid_tests: z.array(z.string()).optional().default([]),
    /** Counterexamples demonstrating the failure. */
    counterexamples: z.array(z.string()).optional().default([]),
    /** Scope violations detected. */
    scope_violations: z.array(z.string()).optional().default([]),
    /** The criterion that failed (free-text). */
    failed_criterion: z.string().optional(),
    /** Deterministic failure signature for change-detection. */
    failure_signature: z.string().optional(),
    /** Scope that must be rechecked on the next run (array of scope items). */
    required_recheck_scope: z.array(z.string()).optional().default([]),
    /** ISO-8601 timestamp. */
    timestamp: z.string().optional(),
}).superRefine((data, ctx) => {
    if (data.verdict === 'REPAIR') {
        // REPAIR receipts require a non-blank failed_criterion
        if (!data.failed_criterion || data.failed_criterion.trim().length === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['failed_criterion'],
                message: 'failed_criterion is required and must be non-empty when verdict is REPAIR',
            });
        }
        // REPAIR receipts require a non-blank failure_signature
        if (!data.failure_signature || data.failure_signature.trim().length === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['failure_signature'],
                message: 'failure_signature is required and must be non-empty when verdict is REPAIR',
            });
        }
        // REPAIR receipts require at least one actionable failure locator
        const hasLocator = (data.failed_po_ids && data.failed_po_ids.length > 0) ||
            (data.affected_task_ids && data.affected_task_ids.length > 0) ||
            (data.counterexamples && data.counterexamples.length > 0);
        if (!hasLocator) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['failed_po_ids'],
                message: 'At least one of failed_po_ids, affected_task_ids, or counterexamples must be non-empty when verdict is REPAIR',
            });
        }
        // REPAIR receipts require non-empty required_recheck_scope
        if (!data.required_recheck_scope || data.required_recheck_scope.length === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['required_recheck_scope'],
                message: 'required_recheck_scope must be non-empty when verdict is REPAIR',
            });
        }
    }
    // PASS receipts must be clean — no scope violations, no failures, no affected tasks.
    if (data.verdict === 'PASS') {
        if (data.scope_violations && data.scope_violations.length > 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['scope_violations'],
                message: 'scope_violations must be empty when verdict is PASS',
            });
        }
        if (data.failed_po_ids && data.failed_po_ids.length > 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['failed_po_ids'],
                message: 'failed_po_ids must be empty when verdict is PASS',
            });
        }
        if (data.affected_task_ids && data.affected_task_ids.length > 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['affected_task_ids'],
                message: 'affected_task_ids must be empty when verdict is PASS',
            });
        }
        if (data.invalid_tests && data.invalid_tests.length > 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['invalid_tests'],
                message: 'invalid_tests must be empty when verdict is PASS',
            });
        }
        if (data.failed_criterion && data.failed_criterion.trim().length > 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['failed_criterion'],
                message: 'failed_criterion must be empty when verdict is PASS',
            });
        }
        if (data.failure_signature && data.failure_signature.trim().length > 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['failure_signature'],
                message: 'failure_signature must be empty when verdict is PASS',
            });
        }
    }
});
// === Project Acceptance Schemas ===
export const ProjectAcceptanceManifestSchema = z.object({
    project_id: z.string().min(1),
    expected_snapshot: z.string().regex(/^[a-f0-9]{16}$/i, 'expected_snapshot must be a 16-char hex digest'),
    prd_goals: z.array(z.string().min(1)).min(1),
    acceptance_criteria: z.array(z.string().trim().min(1)).min(1),
    stage_receipts: z.array(z.object({
        stage_id: z.string().min(1),
        stage_manifest: z.object({
            path: z.string().min(1),
            digest: z.string().regex(/^[a-f0-9]{16}$/i),
        }),
        review_receipt: z.object({
            path: z.string().min(1),
            digest: z.string().regex(/^[a-f0-9]{16}$/i),
        }),
        gate_receipt: z.object({
            path: z.string().min(1),
            digest: z.string().regex(/^[a-f0-9]{16}$/i),
        }),
    })).min(1),
    e2e_steps: z.array(RuntimeProofStep).min(1),
    compiled_at: z.string().optional(),
}).superRefine((data, ctx) => {
    // Stage ID 唯一性
    const stageIds = data.stage_receipts.map(s => s.stage_id);
    if (new Set(stageIds).size !== stageIds.length) {
        ctx.addIssue({
            code: 'custom', path: ['stage_receipts'],
            message: 'Duplicate stage_id is not allowed',
        });
    }
    // Criteria 唯一性
    const criteriaSet = new Set(data.acceptance_criteria);
    if (criteriaSet.size !== data.acceptance_criteria.length) {
        ctx.addIssue({
            code: 'custom', path: ['acceptance_criteria'],
            message: 'Duplicate acceptance criteria is not allowed',
        });
    }
});
export const ProjectE2EReceiptSchema = z.object({
    project_id: z.string().min(1),
    verdict: z.enum(['PASS', 'FAIL', 'BLOCKED']),
    snapshot: z.string().regex(/^[a-f0-9]{16}$/i),
    manifest_digest: z.string().regex(/^[a-f0-9]{16}$/i),
    expected_snapshot: z.string().regex(/^[a-f0-9]{16}$/i),
    executed_snapshot: z.string().regex(/^[a-f0-9]{16}$/i),
    steps: z.array(z.object({
        step_id: z.string(),
        exit_code: z.number().int().nullable(),
        observations: z.string().optional(),
        skipped: z.boolean().optional(),
    })).min(1),
    service_cleanup: z.object({
        cleaned: z.array(z.string()),
        failed: z.array(z.object({ service: z.string(), pid: z.number(), reason: z.string() })),
        remainingPids: z.array(z.number()),
    }),
    created_at: z.string(),
}).superRefine((data, ctx) => {
    if (data.verdict === 'PASS') {
        const nonSkipped = data.steps.filter(s => !s.skipped);
        if (nonSkipped.length === 0) {
            ctx.addIssue({ code: 'custom', path: ['steps'], message: 'PASS requires at least one non-skipped step' });
        }
        for (const step of nonSkipped) {
            if (step.exit_code !== 0) {
                ctx.addIssue({ code: 'custom', path: ['steps', step.step_id, 'exit_code'], message: `PASS requires exit_code 0 for step "${step.step_id}", got ${step.exit_code}` });
            }
        }
        if (data.service_cleanup.failed.length > 0) {
            ctx.addIssue({ code: 'custom', path: ['service_cleanup', 'failed'], message: 'PASS requires no service cleanup failures' });
        }
        if (data.service_cleanup.remainingPids.length > 0) {
            ctx.addIssue({ code: 'custom', path: ['service_cleanup', 'remainingPids'], message: 'PASS requires no remaining PIDs after cleanup' });
        }
    }
});
export const StageReviewReceiptSchema = z.object({
    stage_id: z.string().min(1),
    verdict: z.enum(['ACCEPTED', 'REJECTED', 'BLOCKED']),
    snapshot: z.string().regex(/^[a-f0-9]{16}$/i),
    manifest_digest: z.string().regex(/^[a-f0-9]{16}$/i),
    stage_gate_receipt: z.object({
        path: z.string().min(1),
        digest: z.string().regex(/^[a-f0-9]{16}$/i),
    }),
    findings: z.array(z.object({
        category: z.string().min(1),
        description: z.string().min(1),
    })).optional().default([]),
    reviewer: z.string().min(1),
    reviewed_at: z.string(),
});
export const StageGateVerdict = z.enum(['PASS', 'FAIL', 'BLOCKED']);
export const StageGateReceipt = z.object({
    stage_id: StageId,
    snapshot: z.string().regex(/^[a-f0-9]{16}$/i),
    manifest_digest: z.string().regex(/^[a-f0-9]{16}$/i),
    /** The manifest slices proven complete before the gate was run. */
    completed_slice_ids: z.array(SliceId).optional().default([]),
    /** Verifiable Slice COMPLETE facts; IDs and proof fields must cover the manifest. */
    slice_complete_facts: z.array(SliceCompleteFacts).optional().default([]),
    /** Canonical manifest path used by the gate (informational, never a session id). */
    manifest_path: z.string().optional(),
    platform: z.string(),
    verdict: StageGateVerdict,
    steps: z.array(z.object({
        id: z.string(),
        exit_code: z.number().int().nullable(),
        skipped: z.boolean().optional(),
        observations: z.string().optional(),
    })),
    service_cleanup: z.object({
        cleaned: z.array(z.string()),
        failed: z.array(z.object({ service: z.string(), pid: z.number(), reason: z.string() })),
        remainingPids: z.array(z.number()),
    }),
    timestamps: z.object({
        started_at: z.string(),
        completed_at: z.string(),
    }),
});
/**
 * A Stage Gate PASS is a persisted fact only when it identifies the stage and
 * manifest and contains at least one executed proof step.  The caller must
 * additionally compare completed_slice_ids and manifest_digest with the
 * currently loaded manifest.
 */
export function isValidStageGatePassReceipt(receipt, stageId, manifestDigest, expectedSliceIds) {
    const parsed = StageGateReceipt.safeParse(receipt);
    if (!parsed.success || parsed.data.verdict !== 'PASS' || parsed.data.stage_id !== stageId)
        return false;
    if (manifestDigest && parsed.data.manifest_digest !== manifestDigest)
        return false;
    // A PASS is an evidence claim, not merely a verdict string.  It must have
    // an explicit, duplicate-free slice set and every executed proof step must
    // have succeeded.  Every non-empty stage also needs compact Slice COMPLETE
    // facts proving CV PASS, commit, and integration; a caller boolean is never
    // accepted as a substitute.
    if (new Set(parsed.data.completed_slice_ids).size !== parsed.data.completed_slice_ids.length)
        return false;
    const facts = parsed.data.slice_complete_facts;
    if (facts.length !== parsed.data.completed_slice_ids.length ||
        new Set(facts.map(f => f.slice_id)).size !== facts.length ||
        facts.some(f => !parsed.data.completed_slice_ids.includes(f.slice_id)))
        return false;
    if (facts.some(f => f.cv.verdict !== 'PASS' || !f.commit.commit_sha || !f.integration.integration_ref))
        return false;
    const executedSteps = parsed.data.steps.filter(step => !step.skipped);
    if (executedSteps.length === 0 || executedSteps.some(step => step.exit_code !== 0))
        return false;
    if (parsed.data.service_cleanup.failed.length > 0 || parsed.data.service_cleanup.remainingPids.length > 0)
        return false;
    if (expectedSliceIds) {
        const actual = new Set(parsed.data.completed_slice_ids);
        const expected = new Set(expectedSliceIds);
        if (actual.size !== expected.size || expected.size !== expectedSliceIds.length ||
            expectedSliceIds.some(id => !actual.has(id)))
            return false;
    }
    return true;
}
export const ProjectReviewResultSchema = z.object({
    verdict: z.enum(['PROJECT_ACCEPTED', 'PROJECT_REJECTED', 'PROJECT_BLOCKED']),
    reviewer: z.string().min(1),
    reviewed_snapshot: z.string().regex(/^[a-f0-9]{16}$/i),
    project_manifest: z.object({
        path: z.string().min(1),
        digest: z.string().regex(/^[a-f0-9]{16}$/i),
    }),
    project_e2e_receipt: z.object({
        path: z.string().min(1),
        digest: z.string().regex(/^[a-f0-9]{16}$/i),
    }),
    criteria_results: z.array(z.object({
        criteria: z.string().trim().min(1),
        passed: z.boolean(),
        notes: z.string().optional(),
    })),
    findings: z.array(z.object({
        category: z.string().min(1),
        description: z.string().min(1),
    })).optional().default([]),
    accepted_deviations: z.array(z.string()).optional().default([]),
    reviewed_at: z.string(),
}).superRefine((data, ctx) => {
    const criteriaSet = new Set(data.criteria_results.map(c => c.criteria));
    if (criteriaSet.size !== data.criteria_results.length) {
        ctx.addIssue({
            code: 'custom', path: ['criteria_results'],
            message: 'Duplicate criteria in reviewer result is not allowed',
        });
    }
});
export const WriteProjectReviewReceiptOptionsSchema = z.object({
    project_id: z.string().min(1),
    verdict: z.enum(['PROJECT_ACCEPTED', 'PROJECT_REJECTED', 'PROJECT_BLOCKED']),
    findings: z.array(z.object({
        category: z.string().min(1),
        description: z.string().min(1),
    })).optional().default([]),
    snapshot: z.string().regex(/^[a-f0-9]{16}$/i),
    reviewed_at: z.string().optional(),
    reviewer: z.string().min(1).optional(),
    project_manifest: z.object({
        path: z.string().min(1),
        digest: z.string().regex(/^[a-f0-9]{16}$/i),
    }).optional(),
    project_e2e_receipt: z.object({
        path: z.string().min(1),
        digest: z.string().regex(/^[a-f0-9]{16}$/i),
    }).optional(),
    stage_receipts: z.array(z.object({
        stage_id: z.string().min(1),
        stage_manifest: z.object({
            path: z.string().min(1),
            digest: z.string().regex(/^[a-f0-9]{16}$/i),
        }),
        review: z.object({ path: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{16}$/i) }),
        gate: z.object({ path: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{16}$/i) }),
        snapshot: z.string(),
    })).optional().default([]),
    accepted_deviations: z.array(z.string()).optional().default([]),
    criteria_results: z.array(z.object({
        criteria: z.string(),
        passed: z.boolean(),
        notes: z.string().optional(),
    })).optional().default([]),
}).superRefine((data, ctx) => {
    if (data.verdict === 'PROJECT_ACCEPTED') {
        if (!data.project_manifest) {
            ctx.addIssue({ code: 'custom', path: ['project_manifest'], message: 'Required when verdict is PROJECT_ACCEPTED' });
        }
        if (!data.project_e2e_receipt) {
            ctx.addIssue({ code: 'custom', path: ['project_e2e_receipt'], message: 'Required when verdict is PROJECT_ACCEPTED' });
        }
        if (!data.stage_receipts || data.stage_receipts.length === 0) {
            ctx.addIssue({ code: 'custom', path: ['stage_receipts'], message: 'At least one stage receipt required when verdict is PROJECT_ACCEPTED' });
        }
        if (!data.criteria_results || data.criteria_results.length === 0) {
            ctx.addIssue({ code: 'custom', path: ['criteria_results'], message: 'At least one criteria result required when verdict is PROJECT_ACCEPTED' });
        }
        if (data.criteria_results && data.criteria_results.some(c => !c.passed)) {
            ctx.addIssue({ code: 'custom', path: ['criteria_results'], message: 'All criteria must pass when verdict is PROJECT_ACCEPTED' });
        }
    }
});
//# sourceMappingURL=schemas.js.map