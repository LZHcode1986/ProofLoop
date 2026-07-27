# Brain Plan Stage Dispatch Contract

Core Packet fields are defined in `core-dispatch-packet.md` — this contract defines only target-specific fields.

Dispatch a Stage planning task to Planner.

## Use when

A Stage Goal is selected and needs to be decomposed into Slices and Tasks.

## Target-specific required fields

- Stage ID
- Stage Goal
- Observable Outcomes
- Primary Domain Capability
- Expected Public Seam
- PRD References
- Tech Spec References
- Relevant Architecture Work Items
- Architecture Work Item IDs
- Work Item Acceptance Requirements
- Dependencies
- Constraints
- Out of Scope
- Blocking Hard Parts
- Existing tasks.md path, if present
- Existing evidence.md path, if present
- Latest Validator Result, if present
- Latest SPV Findings, if present

## Expected results

PLAN_READY — Stage decomposed into Slices with tasks.md and evidence.md.
Plan blocked with stop condition if unresolved.

## Return codes (unified route code format)

When plan is blocked, return with:

```yaml
route_code: PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN
subtype: <specific subtype>
affected_artifacts: <list>
affected_work_items: <list>
reason: <description>
invalidation_scope: <list>
resume_target:
  owner: <owner>
  phase: <phase>
  stage: <stage-id>
```


