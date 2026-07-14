# Brain Propose Dispatch Contract

Use when Brain sends exactly one selected stage to Propose for formal OpenSpec artifact generation.

Packet title:

Brain Dispatch: Propose

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

Required proposal fields:
- PRD Path
- Existing Change
- Stage ID
- Stage Name
- Stage Objective
- Stage Boundary
- Stage Out Of Scope
- Source Files
- Acceptance Criteria Source
- Confirmed Decisions
- Inferred Assumptions
- Open Questions

Rules:
- One dispatch equals one selected stage.
- Preserve acceptance criteria verbatim.
- Do not ask Propose to decompose a whole PRD in one pass.
- Put detailed background in referenced files or excerpts.
- Use None only when the field is genuinely not applicable.
- Brain must clarify or reject an incomplete, ambiguous, or contradictory packet before dispatch.

Packet shape:

Brain Dispatch: Propose

Route: propose
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
- Proposal ready
- Clarification required
- Stage repartition required
- Planning blocked
PRD Path:
Existing Change:
Stage ID:
Stage Name:
Stage Objective:
Stage Boundary:
Stage Out Of Scope:
Source Files:
Acceptance Criteria Source:
Confirmed Decisions:
Inferred Assumptions:
Open Questions:
