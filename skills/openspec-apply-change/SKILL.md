---
name: openspec-apply-change
description: Implement tasks from an OpenSpec change. Use when the user wants to start implementing, continue implementation, or work through tasks.
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.3.1"
---

Implement tasks from an OpenSpec change.

**Input**: Optionally specify a change name. If omitted, check if it can be inferred from conversation context. If vague or ambiguous you MUST prompt for available changes.

**Steps**

1. **Select the change**

   If a name is provided, use it. Otherwise:
   - Infer from conversation context if the user mentioned a change
   - Auto-select if only one active change exists
   - If ambiguous, run `openspec list --json` to get available changes and use the **AskUserQuestion tool** to let the user select

   Always announce: "Using change: <name>" and how to override (e.g., `/opsx:apply <other>`).

2. **Check status to understand the schema**
   ```bash
   openspec status --change "<name>" --json
   ```
   Parse the JSON to understand:
   - `schemaName`: The workflow being used (e.g., "spec-driven")
   - Which artifact contains the tasks (typically "tasks" for spec-driven, check status for others)

3. **Get apply instructions**

   ```bash
   openspec instructions apply --change "<name>" --json
   ```

   This returns:
   - Context file paths (varies by schema - could be proposal/specs/design/tasks or spec/tests/implementation/docs)
   - Progress (total, complete, remaining)
   - Task list with status
   - Dynamic instruction based on current state

   **Handle states:**
   - If `state: "blocked"` (missing artifacts): show message, suggest using openspec-continue-change
   - If `state: "all_done"`: congratulate, suggest archive
   - Otherwise: proceed to implementation

4. **Honor apply workflow requirements**

   Read the dynamic `instruction` returned by `openspec instructions apply`.

   - You MUST follow the required implementation workflow before implementation starts.
   - For this repository, that means reading and entering `Tdd workflow` (`tdd-workflow`) before any task execution begins.
   - If the change is classified as `interactive`, you MUST complete the `Blocking` section's first `Proof Task` before any later slice work begins.
   - If `tasks.md` defines explicit `Slice 1..N` verifier gates, you MUST invoke the independent `verifier` sub-agent at those boundaries and wait for an explicit `PASS` or `FAIL`.
   - Treat `tasks.md` as scope and progress tracking; it does not override the required
     implementation order from the apply instruction.
   - Read the `Tdd workflow` (`tdd-workflow`) skill before writing code.
   - Execute implementation in `Step 0-> Step 7` order.
   - Do not skip `RED -> GREEN -> REFACTOR`.
   - Only mark the related task complete after the required TDD step is actually verified.

5. **Read context files**

   Read the files listed in `contextFiles` from the apply instructions output.
   The files depend on the schema being used:
   - **spec-driven**: proposal, specs, design, tasks
   - Other schemas: follow the contextFiles from CLI output

6. **Show current progress**

   Display:
   - Schema being used
   - Progress: "N/M tasks complete"
   - Remaining tasks overview
   - Dynamic instruction from CLI

7. **Implement tasks (loop until done or blocked)**

   For each pending task:
   - Show which task is being worked on
   - Follow the apply-stage workflow before or during implementation
     (for example, complete the relevant `Tdd workflow` (`tdd-workflow`) step before moving to the next coding step)
   - If the change is `interactive`, enforce `Proof Task -> remaining Blocking -> Slice work -> Reconciliation`
   - If the change defines verifier gates, enforce `Slice 1 -> Slice 1 verifier -> Slice 2 -> Slice 2 verifier -> ... -> Slice N -> Slice N verifier -> Reconciliation` at the relevant boundaries
   - Make the code changes required
   - Keep changes minimal and focused
   - Mark task complete in the tasks file: `- [ ]` → `- [x]`
   - Continue to next task

   **Pause if:**
   - Task is unclear → ask for clarification
   - Implementation reveals a design issue → suggest updating artifacts
   - The current slice is missing a necessary prerequisite task or artifact → stop the slice, report the missing prerequisite and impacted task, and suggest the minimal artifact/task update
   - Error or blocker encountered → report and wait for guidance
   - User interrupts

8. **Run implementation done check**

   After all implementation tasks are done:
   - Read `openspec/QUALITY-GATE.md`
   - Run the `Implementation Done Check`
   - Confirm the declared verification commands were actually executed
   - Confirm any required `verifier` gates were actually executed by an independent verifier sub-agent and reached `PASS`
   - If the change is `interactive`, confirm the proof used a real entry path instead of internal direct calls
   - Report failures before suggesting archive

9. **On completion or pause, show status**

   Display:
   - Tasks completed this session
   - Overall progress: "N/M tasks complete"
   - If all done: suggest archive
   - If paused: explain why and wait for guidance

**Output During Implementation**

```
## Implementing: <change-name> (schema: <schema-name>)

Working on task 3/7: <task description>
[...implementation happening...]
✓ Task complete

Working on task 4/7: <task description>
[...implementation happening...]
✓ Task complete
```

**Output On Completion**

```
## Implementation Complete

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 7/7 tasks complete ✓

### Completed This Session
- [x] Task 1
- [x] Task 2
...

All tasks complete and `Implementation Done Check` passed. Ready to archive this change.
```

**Output On Pause (Issue Encountered)**

```
## Implementation Paused

**Change:** <change-name>
**Schema:** <schema-name>
**Progress:** 4/7 tasks complete

### Issue Encountered
<description of the issue>

**Options:**
1. <option 1>
2. <option 2>
3. Other approach

What would you like to do?
```

**Guardrails**
- Keep going through tasks until done or blocked
- Always honor the dynamic apply instruction before implementing tasks
- Always read context files before starting (from the apply instructions output)
- If the schema or project rules require `tdd-workflow`, read it and follow `RED -> GREEN -> REFACTOR`
  before declaring implementation complete
- If the change is `interactive`, do not skip the first `Proof Task`
- If `tasks.md` defines verifier gates, do not replace them with self-review; use the independent `verifier` sub-agent
- If task is ambiguous, pause and ask before implementing
- If implementation reveals issues, pause and suggest artifact updates
- Keep code changes minimal and scoped to each task
- Update task checkbox immediately after completing each task
- Do not skip `RED -> GREEN -> REFACTOR` when TDD is required
- Do not suggest archive before `Implementation Done Check` is complete
- Pause on errors, blockers, or unclear requirements - don't guess
- Use contextFiles from CLI output, don't assume specific file names

**Fluid Workflow Integration**

This skill supports the "actions on a change" model:

- **Can be invoked anytime**: Before all artifacts are done (if tasks exist), after partial implementation, interleaved with other actions
- **Allows artifact updates**: If implementation reveals design issues, suggest updating artifacts - not phase-locked, work fluidly
