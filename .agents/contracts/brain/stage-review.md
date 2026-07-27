# Brain Stage Review Dispatch Contract

Core Packet fields are defined in brain.md — this contract defines only target-specific fields.

Dispatch a Stage review to Stage Reviewer.

## Use when

A Stage execution is complete and needs goal-first review against the Stage Goal, Observable Outcomes, and authority documents.

## Target-specific required fields

- Stage ID
- Stage Goal
- Observable Outcomes
- PRD References
- Tech Spec References
- Stage branch ref
- tasks.md path
- evidence.md path
- Stage Runtime Proof location

## Expected results

ACCEPTED, REJECTED, or BLOCKED verdict returned to Brain.

## Return codes (unified route code format)

When REJECTED, return with:

```yaml
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

When BLOCKED, return with:

```yaml
route_code: RUNTIME_BLOCKER
subtype: INCOMPLETE_EVIDENCE | RUNTIME_BLOCKER
affected_stage: <stage-id>
reason: <description>
```


