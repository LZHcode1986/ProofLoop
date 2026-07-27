# Brain Stage Review Dispatch Contract

Core Packet fields are defined in `core-dispatch-packet.md` — this contract defines only target-specific fields.

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

## Return codes (unified route code format, per `core-route-result.md`)

When REJECTED or BLOCKED, return with:

```yaml
Verdict: REJECTED | BLOCKED
route_code: IMPLEMENTATION_DEFECT | PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | EVIDENCE_GAP | RUNTIME_BLOCKER
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


