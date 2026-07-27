# Brain Plan Stage Dispatch Contract

Dispatch a Stage planning task to Planner.

## Use when

A Stage Goal is selected and needs to be decomposed into Slices and Tasks.

## Dispatch packet

```yaml
route: planner
objective:
continuation: <task_id | none>
stage_id:
stage_goal:
observable_outcomes:
authoritative_inputs:
  prd_refs:
  tech_spec_refs:
  architecture_work_items:
  work_item_ids:
  work_item_acceptance:
  blocking_hard_parts:
scope:
  domain:
  codebase:
constraints:
out_of_scope:
expected_result: PLAN_READY
```

## Required fields

- Stage ID
- Stage Goal
- Observable Outcomes
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

## Return codes

```yaml
route_code: PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | RUNTIME_BLOCKER
subtype: <specific subtype>
finding_id: <id | none>
affected_stage: <stage-id>
affected_artifacts: <list>
affected_work_items: <list>
evidence: <description | none>
reason: <description>
suggested_owner: <owner>
invalidation_scope: <list>
resume_target:
  owner: <owner>
  phase: <phase>
  stage: <stage-id | none>
```

RUNTIME_BLOCKER example:

```yaml
route_code: RUNTIME_BLOCKER
subtype: PLANNER_STAGE_WRITE_PERMISSION_DENIED
reason: Planner cannot create Stage artifacts.
suggested_owner: Brain
invalidation_scope: []
resume_target:
  owner: Planner
  phase: STAGE_PLANNING
  stage: S01
```