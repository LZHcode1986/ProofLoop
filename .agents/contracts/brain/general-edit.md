# Brain General Edit Dispatch Contract

Use when Brain delegates non-authoritative file edits that are not owned by specialized workflow agents.

Packet title:

Brain Dispatch: General Edit

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

Required edit fields:
- Allowed File Scope
- Forbidden File Scope
- Relevant Authoritative Sources

Rules:
- Use the smallest file scope that can satisfy the request.
- Do not use this dispatch for formal change artifacts owned by planning agents.
- Do not use this dispatch for local repository discovery.
- Brain must inspect relevant context before dispatch.
- Brain must clarify or reject an incomplete, ambiguous, or contradictory packet before dispatch.

Packet shape:

Brain Dispatch: General Edit

Route: general-edit
Objective / Brain Intent:
Continuation:
Allowed Scope:
Forbidden Scope / Out of Scope:
Acceptance Criteria:
Verification Method:
Expected Evidence:
Authoritative Inputs:
Constraints:
Stop Conditions:
Expected Result:
- Edit complete
- Edit blocked
Allowed File Scope:
Forbidden File Scope:
Relevant Authoritative Sources:
