# Brain Stage Review Dispatch Contract

Use when Brain asks Implementation Reviewer for stage-level acceptance or archive-readiness review.

Packet title:

Brain Dispatch: Stage Review

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

Required stage-review fields:
- Change
- Stage
- Acceptance Criteria Source
- Relevant PRD Decisions
- Relevant Artifacts
- Relevant Verifier Results

Evidence boundary:
- Dedicated evidence files are not required by default.
- Canonical evidence may include Worker response fields, verification command outputs, boundary receipts, and diff inspection.
- Do not fail a stage review only because a physical evidence file is absent, unless the task explicitly required that file.

Rules:
- Brain must clarify or reject an incomplete, ambiguous, or contradictory packet before dispatch.

Packet shape:

Brain Dispatch: Stage Review

Route: implementation-reviewer
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
- Stage review passed
- Stage review failed
Change:
Stage:
Acceptance Criteria Source:
Relevant PRD Decisions:
Relevant Artifacts:
Relevant Verifier Results:
