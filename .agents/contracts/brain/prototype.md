# Brain Prototype Dispatch Contract

This contract defines one bounded local technical experiment for Prototype. Prototype validates a question in an isolated worktree; Brain routes the evidence to the current four-stage owner.

## Use when

A technical question requires local validation in an isolated worktree before the current Propose, Planning, Execute, or Review owner can proceed.

Hard Parts are architecture risks owned by `tech-spec/architecture.md`; this contract does not create a separate risk artifact or phase.

## Required fields

- Hard Part ID (an architecture entity reference)
- Prototype ID: `<proto-xxx>`
- Base Ref: `<git ref to branch from>`
- Branch Name: `prototype/<hard-part-id>`
- Worktree Path: `.proofloop/worktrees/prototype-<hard-part-id>`
- Tech Spec Refs
- Current phase owner: `PROPOSE | PLANNING | EXECUTE | REVIEW`
- Validation Question
- Success Criteria
- Failure Criteria
- Environment
- Cleanup Continuation: `auto | manual`
- Checkpoint Commit: `on-success | always | never`
- External Research Status: `not-required | already-provided | return-research-required`
- `actionToken` and current business binding supplied by Brain

## Expected results

### Normal completion

```yaml
result: TECHNICAL_RESULT_READY
producer: Prototype
status: VALIDATED | ASSUMPTION_REJECTED
hard_part_id: <architecture entity id>
prototype_id: <proto-xxx>
conclusion: <bounded conclusion>
validated_constraints: <list>
rejected_assumptions: <list>
recommended_tech_spec_changes: <list>
remaining_unknowns: <list>
evidence: <re-readable experiment commands and results>
```

`TECHNICAL_RESULT_READY` is a structured Result classification, not a phase completion signal, Gate, Receipt, or Authority update. `ASSUMPTION_REJECTED` is an experiment result; Brain and the current owner decide how it affects the canonical Authority or execution plan.

### Inconclusive — needs cross-phase routing

```yaml
route_code: TECHNICAL_UNKNOWN
subtype: PROTOTYPE_INCONCLUSIVE
hard_part_id: <architecture entity id>
reason: <description>
evidence: <re-readable experiment evidence>
suggested_owner: Researcher | Prototype | User
invalidation_scope: []
resume_target:
  owner: <role or Skill owner>
  phase: PROPOSE | PLANNING | EXECUTE | REVIEW
  stage: <stage-id | none>
```

### Research required

```yaml
route_code: TECHNICAL_UNKNOWN
subtype: RESEARCH_REQUIRED
hard_part_id: <architecture entity id>
reason: <description>
research_question: <description>
suggested_owner: Researcher
invalidation_scope: []
resume_target:
  owner: Prototype
  phase: PROPOSE | PLANNING | EXECUTE | REVIEW
  stage: <stage-id | none>
```

### Runtime blocker

```yaml
route_code: RUNTIME_BLOCKER
subtype: <specific blocker>
hard_part_id: <architecture entity id>
reason: <description>
suggested_owner: Brain
invalidation_scope: []
resume_target:
  owner: Prototype
  phase: PROPOSE | PLANNING | EXECUTE | REVIEW
  stage: <stage-id | none>
```

## Research continuation

When Prototype returns `TECHNICAL_UNKNOWN / RESEARCH_REQUIRED`, Brain dispatches Researcher as a separate one-shot lifecycle, validates its result, then continues the original Prototype only if Prototype ID, Hard Part, worktree, Base Ref, Validation Question, current Plan/Authority binding, and snapshot remain current. Otherwise Brain starts recovery/fresh and does not reuse the old dialogue.

## Mutation and transport boundary

- Experiment code stays in the packet-specified `prototype/<hard-part-id>` worktree/branch and does not enter the production branch.
- Prototype does not write PRD, Tech Spec, MES, Git boundary, or another Agent's result; Brain and the current owner absorb validated evidence.
- Prototype does not call Runtime CLI, merge, clean up outside the packet, or dispatch another Agent.
- Cross-agent communication uses only Subagent host adapter. No fallback, retry, or second transport.

## Completion criteria

- The experiment answers the one packet question with actual commands and re-readable expected/actual evidence, and states `VALIDATED` or `ASSUMPTION_REJECTED`; unresolved or environment failures use the typed route above.
- The complete Result passes the role schema, binding, `actionToken`, and evidence checks and is returned once to Brain.
- `idle`, `done`, `sent`, a model summary, or a successful command without a structured Result is not completion.
