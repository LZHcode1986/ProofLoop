# Core Route Result

This contract defines the shared return structure for all cross-phase findings and exceptions.

## Standard fields

```yaml
route_code:
subtype:
finding_id:
affected_stage:
affected_outcomes:
affected_artifacts:
affected_work_items:
affected_hard_parts:
evidence:
reason:
suggested_owner:
invalidation_scope:
resume_target:
  owner:
  phase:
  stage:
```

## Route code enum

| Route Code | Default Owner |
|---|---|
| `IMPLEMENTATION_DEFECT` | Executor |
| `PLAN_GAP` | Planner |
| `AUTHORITY_GAP` | Corresponding authority Skill |
| `TECHNICAL_UNKNOWN` | Researcher / Prototype |
| `EVIDENCE_GAP` | Executor or verification owner |
| `RUNTIME_BLOCKER` | Brain / User |
| `USER_DECISION_REQUIRED` | User |
| `OWNER_MISMATCH` | Brain reclassify |

## Verdict format

```yaml
Verdict: ACCEPTED | REJECTED | BLOCKED
route_code: <code> | none
subtype: <specific subtype>
```

Rules:
- ACCEPTED → route_code: none
- REJECTED → defect/gap/unknown class route_code
- BLOCKED → EVIDENCE_GAP or RUNTIME_BLOCKER