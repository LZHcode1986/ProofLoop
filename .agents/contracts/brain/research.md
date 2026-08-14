# Brain Research Dispatch Contract

This contract is self-contained.

Dispatch external technical research to Researcher.

## Use when

A technical question requires external facts from official documentation, GitHub, or other public sources.

## Target-specific required fields

- Research Goal
- Research Question
- Why It Matters
- Preferred Sources
- Out of Scope

## Expected results

### Normal completion — Hard Part resolved

```yaml
result: HARD_PART_RESULT_READY
findings: <description>
sources: <list>
conclusion: <description>
affected_hard_parts: <list>
recommended_actions: <list>
```

### Cross-phase routing

When returning a finding that requires further action:

```yaml
route_code: TECHNICAL_UNKNOWN
subtype: RESEARCH_INCONCLUSIVE | RESEARCH_REQUIRES_PROTOTYPE
finding_id: <id>
affected_hard_parts: <list>
evidence: <description>
reason: <description>
suggested_owner: Researcher | Prototype | User
invalidation_scope: []
resume_target:
  owner: <owner>
  phase: HARD_PART_VALIDATION
  stage: <stage-id | none>
```


