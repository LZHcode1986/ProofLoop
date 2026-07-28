import { z } from 'zod';
// === IDs ===
export const StageId = z.string().regex(/^S\d{2,}(-[A-Z0-9]+)?$/);
export const SliceId = z.string().regex(/^S\d{2,}-[A-Z]$/);
export const TaskId = z.string().regex(/^S\d{2,}-[A-Z]-T\d+$/);
export const PoId = z.string().regex(/^PO-S\d{2,}-[A-Z]-\d{2}$/);
// === Runtime Proof Step ===
export const RuntimeProofStep = z.object({
    id: z.string(),
    executable: z.string(),
    args: z.array(z.string()),
    cwd: z.string().optional().default('.'),
    timeout_ms: z.number().int().positive().optional().default(300000),
    readiness_signal: z.string().optional(),
    expected_observation: z.string().optional(),
    not_applicable: z.object({
        reason: z.string(),
    }).optional(),
    expected: z.object({
        exit_code: z.number().int().optional(),
        output_contains: z.string().optional(),
        output_matches: z.string().optional(),
    }).optional().default({ exit_code: 0 }),
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
    scv_minimum_level: z.enum(['lite', 'standard', 'enhanced']).optional().default('standard'),
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
export const ScvVerdict = z.enum(['PASS', 'REPAIR', 'REPLAN', 'BLOCKED', 'ESCALATION_REQUIRED']);
export const ScvReceipt = z.object({
    slice_id: SliceId,
    snapshot: z.string(),
    scv_level: z.enum(['lite', 'standard', 'enhanced']),
    verdict: ScvVerdict,
    failed_po_ids: z.array(z.string()).optional().default([]),
    invalid_tests: z.array(z.string()).optional().default([]),
    counterexamples: z.array(z.string()).optional().default([]),
    scope_violations: z.array(z.string()).optional().default([]),
    timestamp: z.string().optional(),
});
export const StageGateVerdict = z.enum(['PASS', 'FAIL', 'BLOCKED']);
export const StageGateReceipt = z.object({
    stage_id: StageId,
    snapshot: z.string(),
    platform: z.string(),
    verdict: StageGateVerdict,
    steps: z.array(z.object({
        id: z.string(),
        exit_code: z.number().int(),
        observations: z.string().optional(),
    })),
    timestamp: z.string().optional(),
});
//# sourceMappingURL=schemas.js.map