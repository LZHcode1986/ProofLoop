import { z } from 'zod';

// === IDs ===
export const StageId = z.string().regex(/^S\d{2,}(-[A-Z0-9]+)?$/);
export const SliceId = z.string().regex(/^S\d{2,}-[A-Z]$/);
export const TaskId = z.string().regex(/^S\d{2,}-[A-Z]-T\d+$/);
export const PoId = z.string().regex(/^PO-S\d{2,}-[A-Z]-\d{2}$/);

// === Step type enum ===
export const StepType = z.enum(['command', 'service_start', 'service_stop', 'probe']);
export type StepType = z.infer<typeof StepType>;

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
export type RuntimeProofStep = z.infer<typeof RuntimeProofStep>;

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
export type ProofObligation = z.infer<typeof ProofObligation>;

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
export type Slice = z.infer<typeof Slice>;

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
export type Manifest = z.infer<typeof Manifest>;

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
export type ScvReceipt = z.infer<typeof ScvReceipt>;

// === Project Acceptance Schemas ===

export const ProjectAcceptanceManifestSchema = z.object({
  project_id: z.string().min(1),
  expected_snapshot: z.string().regex(/^[a-f0-9]{16}$/i, 'expected_snapshot must be a 16-char hex digest'),
  prd_goals: z.array(z.string().min(1)).min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
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
export type ProjectAcceptanceManifest = z.infer<typeof ProjectAcceptanceManifestSchema>;

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
export type StageReviewReceipt = z.infer<typeof StageReviewReceiptSchema>;
export type ProjectE2EReceipt = z.infer<typeof ProjectE2EReceiptSchema>;

export const StageGateVerdict = z.enum(['PASS', 'FAIL', 'BLOCKED']);

export const StageGateReceipt = z.object({
  stage_id: StageId,
  snapshot: z.string().regex(/^[a-f0-9]{16}$/i),
  manifest_digest: z.string().regex(/^[a-f0-9]{16}$/i),
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
export type StageGateReceipt = z.infer<typeof StageGateReceipt>;

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
    criteria: z.string().min(1),
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
export type ProjectReviewResult = z.infer<typeof ProjectReviewResultSchema>;

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
export type WriteProjectReviewReceiptOptions = z.infer<typeof WriteProjectReviewReceiptOptionsSchema>;
