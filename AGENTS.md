# AGENTS.md — Agent Continuation & Environment Contract

This file describes project-level conventions for multi-agent programming environments operating on this codebase.

It is not a workflow state document. It is not an authority document.

---

## Agent Continuation Semantics

When an Agent session is interrupted and needs to resume, the following rules determine whether to continue the original Agent or create a fresh one.

### Planner

Plan correction work prefers the original Planner. Starting a new Stage or re-planning after a substantive scope change requires a fresh Planner.

### Worker

Consecutive tasks on the same Slice prefer the original Worker. If the Slice contract, task specification, or evidence baseline has changed, a fresh Worker is required.

### SCV (Slice Code Verifier)

Pure execution interruption (timeout, tool failure) with unchanged inputs may continue the original SCV session.
If code, tests, or the verification Contract changed after the interruption, a fresh SCV is required.

### Stage Reviewer

Pure execution interruption with unchanged Stage artifacts may continue the original Reviewer.
If the Stage content, observable outcomes, or Gate results changed after the interruption, a fresh Reviewer is required.

---

## Host Adapter Boundary

This file declares when continuation is semantically valid or required.

The programming Agent environment (Host Adapter) is responsible for locating the original session, restoring context, and routing the continuation request. This file does not describe Host Adapter internals.

---

## OpenCode Current Adaptation

This project currently uses `opencode-subagent-control` for atomic agent dispatch based on task name and Session hierarchy.

The automatic relay interface is not yet implemented. When manual continuation is required, the Session ID may be copied from the interrupted session and provided to the new dispatch invocation.

---

## Session Loss Degradation

When a continuation handle is lost or cannot be resolved:

1. Read the current target Contract.
2. Read the current codebase state and working diff.
3. Read the current Finding (if any).
4. Read related Gate Receipts and SCV Receipts.
5. Create a fresh recovery Agent with bounded objective.
6. Do not resend unrelated full project context.

---

## Task Naming Convention

All Agent task names follow this pattern:

| Pattern | Example |
|---|---|
| `<Stage ID> 阶段规划` | `S01 阶段规划` |
| `<Stage ID>-<Slice ID> Slice 实施` | `S01-A Slice 实施` |
| `<Stage ID>-<Slice ID> Slice 验证` | `S01-A Slice 验证` |
| `<Stage ID> 阶段验收` | `S01 阶段验收` |

Task names are unique within a project and mappable to Stage and Slice IDs.
