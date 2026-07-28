# Brain Stage Review Dispatch Contract

Dispatch a Stage review to Stage Reviewer.

## Use when

A Stage execution is complete and needs goal-first review against the Stage Goal, Observable Outcomes, and authority documents.

## Review method

`independent-goal-challenge`

The Reviewer does not re-run the declared runtime proof. Instead, the Reviewer independently challenges whether the implementation satisfies the Stage Goal using evidence, integrated code, and authority documents.

## Required fields

- Stage ID
- Stage Goal
- Observable Outcomes
- PRD References
- Tech Spec References
- Stage branch ref
- tasks.md path
- evidence.md path
- Integrated snapshot (commit or tree ref)
- Manifest digest
- Stage Gate Receipt ref
- SCV Receipt refs (one per Slice)
- Stage risk level (low / medium / high / critical)
- Clean-room requirement (yes / no)

## Expected results

ACCEPTED, REJECTED, or BLOCKED verdict returned to Brain.

## Return codes

### REJECTED

```yaml
Verdict: REJECTED
route_code: IMPLEMENTATION_DEFECT | PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | EVIDENCE_GAP
subtype: <specific subtype>
finding_id: <id>
affected_stage: <stage-id>
affected_outcomes: <list>
affected_artifacts: <list>
evidence: <description>
reason: <description>
suggested_owner: <owner>
invalidation_scope: <list>
resume_target:
  owner: <owner>
  phase: <phase>
  stage: <stage-id>
```

### BLOCKED

```yaml
Verdict: BLOCKED
route_code: RUNTIME_BLOCKER | USER_DECISION_REQUIRED | EVIDENCE_GAP
subtype: <specific subtype>
finding_id: <id | none>
affected_stage: <stage-id>
reason: <description>
suggested_owner: <owner>
invalidation_scope: <list>
resume_target:
  owner: <owner>
  phase: <phase>
  stage: <stage-id | none>
```

## Receipt Persistence Ownership

The Stage Reviewer returns a structured verdict only. The Stage Reviewer does **not** write JSON receipts — its `edit: deny` permission prevents this by design.

**Receipt persistence is Brain's responsibility:**

```
Stage Reviewer returns structured verdict (ACCEPTED | REJECTED | BLOCKED)
→ Brain calls writeStageReviewReceipt() from .agents/runtime/src/receipt-writer.ts
   Receipt written to .proofloop/receipts/stage-review-<stage-id>.json
→ Brain routes to STAGE_CLOSE (if ACCEPTED) or typed recovery
```

The Committer requires the persisted Stage Review Receipt to exist before executing stage-close. The `commit-boundary.md` contract's `stage-close` preconditions reference it by path.
