# Brain Project Review Dispatch Contract

This contract is self-contained.

Dispatch a Project Acceptance review after all Stages have been completed and accepted.

## Use when

All of the following conditions are met:
- All Architecture Work Items are closed
- All Stages have been ACCEPTED by Stage Reviewer
- The original PRD is still the current valid version
- No blocking Findings remain open

## Review method

`independent-goal-challenge` (project level)

The Project Reviewer does not re-run Stage Gates or Slice verifications. Instead, the Reviewer independently challenges whether the complete, integrated project satisfies the PRD Goals and Acceptance Criteria, using final snapshot evidence, all Stage Review Receipts, and end-to-end scenarios.

## Required fields

- PRD path (reference to PRD Goals and Acceptance Criteria)
- Final integrated snapshot (commit or tree ref)
- Stage Review Receipts (one per Stage, with verdict and path)
- Stage Gate Receipts (one per Stage, with verdict and path)
- All Architecture Work Item closure status
- All unresolved deviations (per Stage, if any)
- End-to-end scenario definitions
- Known limitations / deferred work summary

## Expected results

```yaml
Verdict: PROJECT_ACCEPTED | PROJECT_REJECTED | PROJECT_BLOCKED
```

### PROJECT_ACCEPTED

All PRD Acceptance Criteria are satisfied in the integrated snapshot. All Stage Review verdicts are ACCEPTED. End-to-end scenarios pass. Unresolved deviations (if any) are explicitly documented and accepted by Brain.

No `route_code` is returned — the project is complete.

### PROJECT_REJECTED

One or more PRD Acceptance Criteria are not satisfied in the integrated snapshot. A Stage Review has been REJECTED. An end-to-end scenario fails. Unresolved deviations block project acceptance.

```yaml
Verdict: PROJECT_REJECTED
route_code: IMPLEMENTATION_DEFECT | PLAN_GAP | AUTHORITY_GAP | EVIDENCE_GAP
subtype: <specific subtype>
finding_id: <id>
affected_stages: <list>
affected_criteria: <list>
affected_artifacts: <list>
evidence: <description>
reason: <description>
suggested_owner: <owner>
invalidation_scope: <list>
resume_target:
  owner: <owner>
  phase: <phase>
  stage: <stage-id | none>
```

### PROJECT_BLOCKED

Project Acceptance cannot proceed due to external blockers, missing prerequisites, or environment issues.

```yaml
Verdict: PROJECT_BLOCKED
route_code: RUNTIME_BLOCKER | USER_DECISION_REQUIRED | EVIDENCE_GAP
subtype: <specific subtype>
finding_id: <id | none>
affected_stages: <list>
reason: <description>
suggested_owner: <owner>
invalidation_scope: <list>
resume_target:
  owner: <owner>
  phase: <phase>
  stage: <stage-id | none>
```

## Review scope

### PRD Goals validation

- Every PRD Functional Requirement (FR-xxx) is addressed by at least one Stage Outcome
- Every PRD Acceptance Criterion (AC-xxx) is verifiable in the integrated snapshot
- No PRD requirement has been silently narrowed or removed

### Stage Review Receipts audit

- Every Stage has a Stage Review Receipt with verdict ACCEPTED
- Stage Review Receipts reference their corresponding Stage Gate Receipts
- Receipt digests are consistent with the integrated snapshot

### End-to-end scenarios

- Critical user journeys from PRD User Flow execute successfully on the integrated snapshot
- Error and edge-case scenarios from PRD are covered
- Non-functional requirements (NFR-xxx) are verifiably met

### Unresolved deviations

- Each unresolved deviation has a documented reason, impact assessment, and Brain acceptance
- Deferred work is tracked and does not block core user intent
- Degraded behavior is explicitly listed with mitigation plan

## Verdict persistence

After the Project Review verdict is determined, Brain dispatches a final `stage-close` boundary (or equivalent project-level commit) to persist the Project Review Receipt.

The Project Review Receipt is written to:
```
.proofloop/receipts/project-review.json
```

## Return codes

When Project Review is blocked or encounters issues before reaching a verdict:

```yaml
route_code: IMPLEMENTATION_DEFECT | PLAN_GAP | AUTHORITY_GAP | TECHNICAL_UNKNOWN | EVIDENCE_GAP | RUNTIME_BLOCKER
subtype: <specific subtype>
finding_id: <id | none>
reason: <description>
suggested_owner: <owner>
invalidation_scope: <list>
resume_target:
  owner: <owner>
  phase: <phase>
  stage: <stage-id | none>
```

| Gate failure | route_code | subtype |
|---|---|---|
| Missing or incomplete Stage Review Receipts | `IMPLEMENTATION_DEFECT` | `PROJECT_MISSING_STAGE_REVIEW` |
| End-to-end scenario execution failed | `IMPLEMENTATION_DEFECT` | `PROJECT_E2E_FAILURE` |
| PRD Acceptance Criterion not satisfiable | `PLAN_GAP` | `PROJECT_CRITERION_GAP` |
| Unresolved deviation blocks user intent | `EVIDENCE_GAP` | `PROJECT_DEVIATION_BLOCKING` |
| Environment precondition unmet for e2e | `RUNTIME_BLOCKER` | `PROJECT_ENV_FAILURE` |
