# Brain Execute Dispatch Contract

Use when Brain sends an implementation-ready change to Executor.

Packet title:

Brain Dispatch: Execute

Required fields:
- Change
- Execution Goal
- Worktree Path
- Stage ID
- Stage Name
- Acceptance Criteria Source
- Acceptance Criteria
- User Constraints
- Relevant PRD Decisions
- Relevant Risks
- Expected Result

Rules:
- Preserve acceptance criteria verbatim.
- Include selected worktree when known.
- Include stage metadata when execution is scoped to a stage.
- Do not include broad planning background unless needed for execution safety.

Packet shape:

Brain Dispatch: Execute

Change:
Execution Goal:
Worktree Path:
Stage ID:
Stage Name:
Acceptance Criteria Source:
Acceptance Criteria:
 - <immutable acceptance criterion>
User Constraints:
Relevant PRD Decisions:
Relevant Risks:
Expected Result:
- Execution complete
- Execution blocked
- Verification failed
