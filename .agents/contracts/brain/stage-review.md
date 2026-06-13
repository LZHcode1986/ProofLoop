# Brain Stage Review Dispatch Contract

Use when Brain asks Implementation Reviewer for stage-level acceptance or archive-readiness review.

Packet title:

Brain Dispatch: Stage Review

Required fields:
- Change
- Stage
- Acceptance Criteria Source
- Acceptance Criteria
- Relevant PRD Decisions
- Relevant Artifacts
- Relevant Verifier Results
- Expected Result

Evidence boundary:
- Dedicated evidence files are not required by default.
- Canonical evidence may include Worker response fields, verification command outputs, boundary receipts, and diff inspection.
- Do not fail a stage review only because a physical evidence file is absent, unless the task explicitly required that file.

Packet shape:

Brain Dispatch: Stage Review

Change:
Stage:
Acceptance Criteria Source:
Acceptance Criteria:
 - <immutable acceptance criterion>
Relevant PRD Decisions:
Relevant Artifacts:
Relevant Verifier Results:
Expected Result:
- Stage review passed
- Stage review failed
