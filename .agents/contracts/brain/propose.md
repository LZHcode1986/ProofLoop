# Brain Propose Dispatch Contract

Use when Brain sends exactly one selected stage to Propose for formal OpenSpec artifact generation.

Packet title:

Brain Dispatch: Propose

Required fields:
- Objective
- PRD Path
- Existing Change
- Stage ID
- Stage Name
- Stage Objective
- Stage Boundary
- Stage Out Of Scope
- Source Files
- Acceptance Criteria Source
- Acceptance Criteria
- Confirmed Decisions
- Inferred Assumptions
- Open Questions
- Constraints
- Expected Result

Rules:
- One dispatch equals one selected stage.
- Preserve acceptance criteria verbatim.
- Do not ask Propose to decompose a whole PRD in one pass.
- Put detailed background in referenced files or excerpts.
- Use None only when the field is genuinely not applicable.

Packet shape:

Brain Dispatch: Propose

Objective:
PRD Path:
Existing Change:
Stage ID:
Stage Name:
Stage Objective:
Stage Boundary:
Stage Out Of Scope:
Source Files:
Acceptance Criteria Source:
Acceptance Criteria:
 - <immutable acceptance criterion>
Confirmed Decisions:
Inferred Assumptions:
Open Questions:
Constraints:
Expected Result:
- Proposal ready
- Clarification required
- Stage repartition required
- Planning blocked
