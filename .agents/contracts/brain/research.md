# Brain Research Dispatch Contract

This contract defines one bounded external research request to Researcher. Researcher supplies evidence; Brain routes the result to the current four-stage owner.

## Use when

A technical question requires external facts from official documentation, standards, GitHub, or other public sources, and the answer is needed by Propose, Planning, Execute, or Review.

Hard Parts are architecture risks owned by `tech-spec/architecture.md`; this contract does not create a separate risk artifact or phase.

## Target-specific required fields

- Research Goal
- Research Question
- Why It Matters
- Preferred Sources
- Out of Scope
- Current phase owner: `PROPOSE | PLANNING | EXECUTE | REVIEW`
- `actionToken` and current business binding supplied by Brain

## Expected results

### Normal completion — bounded technical result

```yaml
result: TECHNICAL_RESULT_READY
producer: Researcher
hard_part_id: <architecture entity id>
findings: <description>
sources: <list of source refs and exact relevant passages>
conclusion: <bounded conclusion>
affected_hard_parts: <list>
validated_constraints: <list>
remaining_unknowns: <list>
recommended_actions: <list>
```

`TECHNICAL_RESULT_READY` is a structured Result classification, not a phase completion signal, Gate, Receipt, or Authority update. Brain validates its binding and evidence, then the current owner absorbs the conclusion.

### Cross-phase routing

When the research is inconclusive or requires a local prototype, return:

```yaml
route_code: TECHNICAL_UNKNOWN
subtype: RESEARCH_INCONCLUSIVE | RESEARCH_REQUIRES_PROTOTYPE
finding_id: <id, when available>
hard_part_id: <architecture entity id>
evidence: <re-readable evidence reference or description>
reason: <description>
suggested_owner: Researcher | Prototype | User
invalidation_scope: []
resume_target:
  owner: <role or Skill owner>
  phase: PROPOSE | PLANNING | EXECUTE | REVIEW
  stage: <stage-id | none>
```

## Mutation and transport boundary

- Researcher is read-only with respect to the repository: it does not modify PRD, Tech Spec, MES, Git, or code.
- Researcher does not write a Hard Part, update an Authority, decide invalidation, or dispatch another Agent; Brain and the current owner do that after validating the result.
- Researcher does not call Runtime CLI or create a Git boundary.
- Cross-agent communication uses only Subagent host adapter. No fallback, retry, or second transport.

## Completion criteria

- Every material claim has a source, version/compatibility condition, and limitation; unresolved questions are explicit.
- The complete Result passes the role schema, binding, `actionToken`, and evidence checks and is returned once to Brain.
- Missing fields, unavailable external access, or unresolved conclusions return the typed route above; `idle`, `done`, `sent`, or a model summary is not completion.
