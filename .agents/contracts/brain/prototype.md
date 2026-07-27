# Brain Prototype Dispatch Contract

Dispatch a local technical experiment to Prototype.

## Use when

A technical question requires local validation in an isolated worktree before it can be accepted into Tech Spec.

## Required fields

- Hard Part ID
- Prototype ID: <proto-xxx>
- Base Ref: <git ref to branch from>
- Branch Name: prototype/<hard-part-id>
- Worktree Path: .proofloop/worktrees/prototype-<hard-part-id>
- Tech Spec Refs: <refs>
- Validation Question
- Success Criteria
- Failure Criteria
- Environment
- Cleanup Continuation: <auto | manual>
- Checkpoint Commit: <on-success | always | never>
- External Research Status:
  - not-required
  - already-provided
  - return-research-required

## Expected results

### Normal completion (no route_code)

```yaml
status: VALIDATED | REJECTED
hard_part_id: <id>
conclusion: <description>
validated_constraints: <list>
rejected_assumptions: <list>
recommended_tech_spec_changes: <list>
remaining_unknowns: <list>
```

### Inconclusive — needs cross-phase routing

```yaml
route_code: TECHNICAL_UNKNOWN
subtype: PROTOTYPE_INCONCLUSIVE
hard_part_id: <id>
reason: <description>
suggested_owner: Researcher | Prototype | User
invalidation_scope: []
resume_target:
  owner: <owner>
  phase: HARD_PART_VALIDATION
  stage: <stage-id | none>
```

### Research required

```yaml
route_code: TECHNICAL_UNKNOWN
subtype: RESEARCH_REQUIRED
hard_part_id: <id>
reason: <description>
research_question: <description>
suggested_owner: Researcher
invalidation_scope: []
resume_target:
  owner: Prototype
  phase: HARD_PART_VALIDATION
  stage: <stage-id | none>
```

### Runtime blocker

```yaml
route_code: RUNTIME_BLOCKER
subtype: <specific blocker>
hard_part_id: <id>
reason: <description>
suggested_owner: Brain
invalidation_scope: []
resume_target:
  owner: Prototype
  phase: HARD_PART_VALIDATION
  stage: <stage-id | none>
```

When RESEARCH_REQUIRED is returned, Brain dispatches Researcher, validates the result, then continues the original Prototype session.