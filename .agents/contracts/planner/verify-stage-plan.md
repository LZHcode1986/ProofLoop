# Planner Verify Stage Plan SPV Contract

Planner must run SPV verification before returning to Brain.

## When to use

After writing `tasks.md` and `evidence.md`, before returning to Brain.

## Verification chain

```text
Tasks.md + Evidence.md written
  → Stage Validator (mechanical) — python .agents/validators/proofloop-validate-stage.py
  → SPV (semantic) — stage-plan-verifier task agent
  → Return to Brain
```

## Required fields

- Stage ID
- Stage Goal
- Observable Outcomes
- Authority References
- `tasks.md` path: `delivery/stages/<stage-id>/tasks.md`
- `evidence.md` path: `delivery/stages/<stage-id>/evidence.md`
- Slice DAG
- Blocking Hard Parts status

## Stage Validator mechanical checks

Planner must run `proofloop-validate-stage.py --stage <stage-id>` before calling SPV.

The validator checks:
- Required sections present
- Slice ID uniqueness
- DAG acyclicity
- Each Slice has Goal, Outcome, Public Seam, TDD, Tasks, Closure
- Blocking Hard Parts are VALIDATED
- Slice→Stage Closure covers all Outcomes

Result: `PASS` or `FAIL` (return details to Planner).

## SPV semantic checks

If Stage Validator PASSED, dispatch `stage-plan-verifier` with the Stage ID.

SPV checks:
- Slice quality (vertical, public seam, TDD observability)
- Dependency quality (blocking, acyclic, valid refs)
- Task quality (goal-type, meaningful intermediate results)
- Closure quality (Task→Slice, Slice→Stage)
- Hard Part readiness
- Architecture quality (seam issues, duplicate rules, shallow wrappers)

## SPV expected return values

| Value | Meaning |
|---|---|
| `PLAN_READY` | Plan is valid — proceed to Brain |
| `PLAN_DEFECT` | Specific plan issue found — return details to Planner |
| `AUTHORITY_GAP` | Plan references missing authority |
| `ARCHITECTURE_SEAM_UNCLEAR` | Seam definition insufficient |
| `TECHNICAL_DISCOVERY_REQUIRED` | Unvalidated Hard Part blocking |

## Planner return rule

Planner must only return to Brain after receiving `PLAN_READY`.

If SPV returns any other value, Planner must fix the issue and re-run the full verification chain (Stage Validator + SPV).

## Packet shape

```text
Route: stage-plan-verifier
Objective: <verify Stage plan>
Continuation: <task_id | none>
Stage ID: <Sxx>
Stage Goal: <one sentence>
Scope: delivery/stages/<stage-id>/
Stage Validator Result: PASS | FAIL
tasks.md: <path>
evidence.md: <path>
Authority References: <refs>
Blocking Hard Parts: <VALIDATED list>
Expected Result: PLAN_READY | PLAN_DEFECT | AUTHORITY_GAP | ARCHITECTURE_SEAM_UNCLEAR | TECHNICAL_DISCOVERY_REQUIRED
```