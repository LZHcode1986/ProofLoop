# Brain Execute Dispatch Contract

Use when Brain sends an implementation-ready change to Executor.

Packet title:

Brain Dispatch: Execute

Required Core Packet fields:
- Route
- Objective / Brain Intent
- Continuation
- Allowed Scope
- Forbidden Scope / Out of Scope
- Acceptance Criteria
- Verification Method
- Expected Evidence
- Authoritative Inputs
- Constraints
- Stop Conditions
- Expected Result

Required execution fields:
- Change
- Execution Goal
- Worktree Path
- Stage ID
- Stage Name
- Acceptance Criteria Source
- User Constraints
- Relevant PRD Decisions
- Relevant Risks

Rules:
- Preserve acceptance criteria verbatim.
- Include selected worktree when known.
- Include stage metadata when execution is scoped to a stage.
- Do not include broad planning background unless needed for execution safety.
- Brain must clarify or reject an incomplete, ambiguous, or contradictory packet before dispatch.

Packet shape:

Brain Dispatch: Execute

Route: executor
Objective / Brain Intent:
Continuation:
Allowed Scope:
Forbidden Scope / Out of Scope:
Acceptance Criteria:
 - <immutable acceptance criterion>
Verification Method:
Expected Evidence:
Authoritative Inputs:
Constraints:
Stop Conditions:
Expected Result:
- Execution complete
- Execution blocked
- Verification failed
Change:
Execution Goal:
Worktree Path:
Stage ID:
Stage Name:
Acceptance Criteria Source:
User Constraints:
Relevant PRD Decisions:
Relevant Risks:
