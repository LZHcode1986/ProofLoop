# Brain Technical Unknown Routing Contract

This Contract defines how a bounded `TECHNICAL_UNKNOWN` result is routed and absorbed. It is not a phase, Gate, Receipt, status machine, or separate risk artifact. Hard Parts are architecture risks owned by `tech-spec/architecture.md`.

## Use when

- Brain receives `TECHNICAL_UNKNOWN` from Planning, Execute, Review, Researcher, or Prototype.
- A bounded technical question needs external research or a local prototype before the current owner can proceed.

## Ownership and routing

```text
TECHNICAL_UNKNOWN
→ Brain
→ researcher | prototype
→ structured evidence/result
→ current owner absorbs the conclusion
```

| Origin | Result owner | Required next action |
|---|---|---|
| Propose | `prd-to-ai-architecture` (or `ai-structured-prd` when the product decision changes) | Absorb verified constraints into the relevant canonical owner; continue the same unified Propose; if frontend scope exists, close `frontend-tech` and `tech-spec/frontend.md` before emitting the single `PROPOSE_READY`. A blocking frontend handoff gap returns to the owning Authority route; no new phase or status. |
| Planning | `proofloop-plan` | Re-evaluate the affected Stage/Slice/Task and revise the candidate Thin Plan. If the conclusion changes Architecture/Contracts/Acceptance, return `AUTHORITY_GAP` to the corresponding Propose owner before replanning. |
| Execute | Brain → `worker`, `proofloop-plan`, or the relevant Authority owner according to the verified impact | Keep the current work blocked or replan only the bounded affected scope; for a frontend unknown, keep the affected frontend scope blocked and route to the true Authority owner or recovery path; do not create a fifth phase. |
| Review | Brain → bounded repair, Replan, Researcher/Prototype, or the relevant Authority owner according to the finding | Preserve the finding and integrated facts; for frontend backend/product/permission/cross-boundary unknowns, keep the affected scope blocked, route to the true Authority owner, close `frontend-tech` again after Authority repair, then choose frontend fresh/recovery; do not let technical research directly produce a review verdict. |

## Result classification

A successful Researcher or Prototype response uses the result classification below. It is a structured Result, not a phase completion signal and not an Authority update by itself:

```yaml
result: TECHNICAL_RESULT_READY
producer: Researcher | Prototype
hard_part_id: <architecture entity id>
conclusion: <bounded conclusion>
validated_constraints: []
remaining_unknowns: []
recommended_actions: []
```

The producer-specific Contract may require additional fields (`sources`, `rejected_assumptions`, or experiment evidence). Brain must validate the complete role envelope, binding, `actionToken`, and re-readable evidence before routing or accepting the result.

## Cross-phase route envelope

When the question remains unresolved or requires another owner, return:

```yaml
route_code: TECHNICAL_UNKNOWN
subtype: RESEARCH_INCONCLUSIVE | RESEARCH_REQUIRES_PROTOTYPE | PROTOTYPE_INCONCLUSIVE | RESEARCH_REQUIRED
finding_id: <id, when available>
hard_part_id: <architecture entity id>
evidence: <re-readable evidence reference or description>
reason: <description>
suggested_owner: Researcher | Prototype | User | Brain
invalidation_scope: []
resume_target:
  owner: <role or Skill owner>
  phase: PROPOSE | PLANNING | EXECUTE | REVIEW
  stage: <stage-id | none>
```

`phase` identifies the current four-stage owner only; no separate Hard Part phase is valid. Missing or inconsistent binding, evidence, or owner information is a typed blocker; Brain does not infer it from progress, checkbox, dialogue, or Agent state.

## Persistence rules

- Researcher and Prototype never write PRD, Tech Spec, MES, Git boundary, or another Agent's result.
- Brain is the only route/authorization owner; MES operational transaction layer is the only durable operational fact mutator. A verified result is evidence for the current owner; it does not directly mutate `tech-spec/architecture.md`, `tech-spec/contracts.md`, `tech-spec/acceptance.md`, a Thin Plan, or MES.
- If the verified conclusion changes a canonical decision, the appropriate Propose owner updates that one canonical owner and invalidates real downstream work as required.
- No separate Hard Part phase, status, extra Gate, or fifth lifecycle is created; technical results are absorbed by the current owner.
