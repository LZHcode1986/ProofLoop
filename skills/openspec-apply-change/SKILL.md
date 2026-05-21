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
   - If ambiguous, run `openspec list --json` to get available changes. In apply-stage executor orchestration, stop and report a blocker with the candidate changes; do not use `question`. `question` is reserved for the propose primary agent.

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

   - You MUST follow the task-level implementation workflow declared in `tasks.md`.
   - Do not load `test-driven-development` globally for all apply work.
   - Every task that changes code must be marked `Execution Type: test-first-code` and must include `Required Skills: test-driven-development`.
   - Non-code tasks such as setup, docs-sync, proof, verifier-gate, and reconciliation do not load TDD unless they explicitly change code.
   - If the change is classified as `interactive`, you MUST complete the `Blocking` section's first `Proof Task` before any later slice work begins.
   - If `tasks.md` defines explicit `Slice 1..N` verifier gates, you MUST invoke the independent `code-verifier` sub-agent at those boundaries and wait for `Verification passed` or `Verification failed`.
   - Treat `tasks.md` as scope and progress tracking; it does not override the required
     implementation order from the apply instruction.
   - Worker owns implementation task checkboxes after local completion evidence.
   - Code Verifier does not update normal implementation task checkboxes; it updates only its assigned verifier gate checkbox on `Verification passed`.
   - After every Worker result that changes files, dispatch `@committer` to close the Worker-output git boundary before any next Worker or Code Verifier dispatch.
   - Do not dispatch `@code-verifier` until every covered Worker attempt has a boundary receipt or explicit no-op receipt.

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
   - Follow the task-level workflow before or during implementation. If `Required Skills` includes `test-driven-development`, delegate RED -> GREEN -> REFACTOR explicitly.
   - If the change is `interactive`, enforce `Proof Task -> remaining Blocking -> Slice work -> Reconciliation`  
   - **Dispatch `@worker`**: Delegate implementation or proof work using a full Task Packet built from `tasks.md` and the loaded context files. **Do NOT write code or edit files yourself.**
   - Wait for `@worker` to report `Implementation finished`, `Implementation blocked`, or `Implementation failed`.
   - Worker updates only its assigned implementation task checkbox after local completion evidence.
   - Ordinary Worker tasks become `passed-for-now`; they are not final slice trust.
   - **Dispatch `@code-verifier` only at explicit verifier gates**: If the current pending item is a slice verifier gate, verifier task, or reconciliation verifier gate, invoke independent `@code-verifier` for the whole covered slice.
   - Code Verifier dispatch must include only the assigned slice/gate contract from `tasks.md` plus covered Worker evidence.
   - Code Verifier dispatch must also include boundary receipts for every covered Worker attempt, changed files in slice, diff evidence requirements, and the relevant verification command outputs.
   - Do not dispatch full Stage Acceptance Criteria to `@code-verifier`; stage-level composition belongs to `@implementation-reviewer`.
   - Wait for `@code-verifier` to return `Verification passed` or `Verification failed`.
   - **Task Completion & Checkbox**: Normal implementation checkboxes are Worker-owned. Code Verifier owns only its assigned verifier gate checkbox and updates it on `Verification passed`. Failed slice verifier gates remain unchecked until PASS.
   - Continue to next task.

   **Pause if:**
   - Task is unclear → stop and report a blocker with the exact missing decision/input
   - Worker/Verifier reveals a design issue → suggest updating artifacts
   - The current slice is missing a necessary prerequisite task or artifact → stop the slice, report the missing prerequisite and impacted task, and suggest the minimal artifact/task update
   - Fatal error or upstream blocker encountered → report and wait for guidance
   - User interrupts

8. **Run implementation done check**

   After all implementation tasks are done:
   - Read `openspec/QUALITY-GATE.md`
   - Run the mechanical `Implementation Done Check`
   - Confirm task ownership, recorded verification commands, required slice verifier `PASS` results, boundary receipts for every covered Worker attempt, interactive proof evidence when applicable, and the stage-review package
   - Do not suggest archive until boundary evidence is complete and stage review can be prepared
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
✓ Worker self-check complete

Working on task 4/7: <task description>
[...implementation happening...]
✓ Slice verifier gate passed
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
- Always honor the dynamic apply instruction before dispatching tasks
- Always read context files before starting (from the apply instructions output)
- **NEVER implement tasks yourself**. Always use `@worker` for implementation.
- If a task changes code, it must be `test-first-code` and include `test-driven-development`; explicitly instruct `@worker` to follow `RED -> GREEN -> REFACTOR`. Do not let `@worker` skip this.
- If the change is `interactive`, do not skip dispatching the first `Proof Task`; this proof is Worker self-checked and is not a Code Verifier gate.
- If `tasks.md` defines verifier gates, do not replace them with self-review; ALWAYS use the independent `@code-verifier` sub-agent.
- **Enforce Worker Scope**: Always instruct `@worker` to keep code changes minimal and strictly scoped to each task.
- **Enforce Checkbox Rules**: Worker owns normal implementation task checkboxes after local completion evidence. Code Verifier does not update normal implementation checkboxes; it owns only assigned verifier gate checkboxes.
- If task is ambiguous, pause and report a blocker before dispatching
- Do not suggest archive before `Implementation Done Check` is complete
- Pause on fatal errors, upstream blockers, or unclear requirements - don't guess
- Use contextFiles from CLI output, don't assume specific file names

**Fluid Workflow Integration**

This skill supports the "actions on a change" model:

- **Can be invoked anytime**: Before all artifacts are done (if tasks exist), after partial implementation, interleaved with other actions
- **Allows artifact updates**: If implementation reveals design issues, suggest updating artifacts - not phase-locked, work fluidly
