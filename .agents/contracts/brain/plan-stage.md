# Brain Plan Stage Dispatch Contract

Dispatch a Stage planning task to Planner.

## Use when

A Stage Goal is selected and needs to be decomposed into Slices and Tasks.

## Dispatch packet

```yaml
route: planner
objective:
dispatch_mode: initial | continue | recover

continuation_context:
  target_role: planner
  task_name:
  finding_ids: []
  changed_inputs: []
  unchanged_inputs_digest:

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

## Planner output requirements

```yaml
expected_outputs:
  tasks_md: delivery/stages/<stage-id>/tasks.md
  evidence_skeleton: delivery/stages/<stage-id>/evidence.md
  manifest_candidate: <description of what to compile into Manifest after Validator PASS>
  risk_facts: <list of Stage-level Risk Facts>
```

`manifest_candidate` is not a hand-written JSON; it is a description that the Executor/Committer should compile into a Manifest after the Stage Validator passes and SPV returns PLAN_READY.

## Expected results

PLAN_READY requires:
- tasks.md written with full Slice decomposition
- evidence.md skeleton aligned with Slice markers
- Stage Validator PASS (mechanical checks)
- SPV PLAN_READY (semantic checks)
- Manifest compiled from manifest_candidate
- Risk Facts declared at Stage and Slice level

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