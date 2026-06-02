# Brain Dispatch Packets

This file defines fixed packet shapes that Brain uses when dispatching subagents.

Brain owns the decision to dispatch. This file owns the packet format.

## Rules

- Use the exact packet title for the target flow.
- Fill every field that is known.
- Write `None` only when the field is genuinely not applicable.
- Do not omit `Acceptance Criteria Source` or `Acceptance Criteria` when dispatching `@propose`, `@executor`, or `@implementation-reviewer`.
- Preserve caller-supplied acceptance criteria verbatim.
- Keep packets bounded. Put detailed background in referenced files, not in the packet body.

## External Research

Use when Brain needs external facts before PRD, routing, stage, or scope decisions can be made.

```text
Brain Dispatch: External Research

Research Goal:
Question:
Why it matters:
Preferred sources:
- official docs | official repo | standards body | high-quality examples
Out of scope:
Expected output:
- findings
- source links
- recommendation
- open risks
```

## General Edit

Use when Brain delegates non-authoritative file edits that are not owned by `@propose`, `@executor`, or `@implementation-reviewer`.

```text
Brain Dispatch: General Edit

Objective:
Allowed File Scope:
Forbidden File Scope:
Acceptance Criteria:
Relevant Authoritative Sources:
Constraints:
Expected Result:
- Edit complete
- Edit blocked
```

## Propose

Use when Brain sends exactly one selected stage to `@propose` for OpenSpec artifact generation.

```text
Brain Dispatch: Propose

Objective:
PRD Path:
Existing Change:
Stage ID:
Stage Name:
Proof Posture: P0 Fast Proof | P1 Stage Proof | P2 Audit Proof
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
```

## Execute

Use when Brain sends an implementation-ready change to `@executor`.

```text
Brain Dispatch: Execute

Change:
Execution Goal:
Worktree Path:
Stage ID:
Stage Name:
Proof Posture: P0 Fast Proof | P1 Stage Proof | P2 Audit Proof
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
```

## Stage Review

Use when Brain asks `@implementation-reviewer` for stage-level acceptance or archive-readiness review.

**Reviewer Evidence Boundary**: The reviewer MUST follow the canonical Evidence Protocol. Dedicated evidence documents/files in `output/changes/` are NOT required by default. The reviewer MUST NOT FAIL a stage review solely because a physical evidence file is missing from `output/changes/`, unless `tasks.md` explicitly required that file and a producing task declared `output/changes/` in its `Allowed File Scope`. Canonical evidence (Worker response fields, verification command outputs, boundary receipts, diff inspection) is sufficient.

```text
Brain Dispatch: Stage Review

Change:
Stage:
Proof Posture: P0 Fast Proof | P1 Stage Proof | P2 Audit Proof
Acceptance Criteria Source:
Acceptance Criteria:
 - <immutable acceptance criterion>
Relevant PRD Decisions:
Relevant Artifacts:
Relevant Verifier Results:
Expected Result:
- Stage review passed
- Stage review failed
- Stage review passed with warnings
```
