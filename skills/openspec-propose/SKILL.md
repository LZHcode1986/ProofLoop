---
name: openspec-propose
description: Propose a new change with all artifacts generated in one step. Use when the user wants to quickly describe what they want to build and get a complete proposal with design, specs, and tasks ready for implementation.
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.1"
  generatedBy: "1.3.1"
---

Propose a new change - create the change and generate all artifacts in one step.

I'll create a change with artifacts:
- proposal.md (what & why)
- design.md (how)
- tasks.md (implementation steps)

When ready to implement, run /opsx:apply

---

**Input**: The user's request should include a change name (kebab-case) OR a description of what they want to build. It may also include one or more source files that the proposal must be decomposed from.

If the request explicitly says `according to <file-path-list>, start task decomposition`, then:
- `<file-path-list>` means the source file or files that define the decomposition input for this change
- those files may be one file or multiple files
- those files are input references, not output targets, unless the user separately asks to edit them
- the propose workflow MUST use those files as the basis for decomposition
- the file list may change per change, but this workflow MUST stay fixed

**Steps**

1. **Identify the change and the decomposition source files**

   Determine:
   - the change name (or derive one from the user's description)
   - any user-supplied source file paths
   - whether the user explicitly requested task decomposition from those files

   If the user provided source files for decomposition, read every listed file before creating or updating any artifact. Treat those files as the primary source for:
   - scope
   - constraints
   - capabilities
   - interfaces or contracts
   - acceptance boundaries
   - explicit non-goals

   If no clear goal is provided, ask:
   > "What change do you want to work on? Describe what you want to build or fix."

   From their description, derive a kebab-case name (e.g., "add user authentication" → `add-user-auth`).

   **IMPORTANT**: Do NOT proceed without understanding what the user wants to build.

2. **If source files are provided, perform decomposition before writing artifacts**

   Build a decomposition result from the supplied file(s):
   - extract requirement items, constraints, invariants, interfaces, contracts, and acceptance expectations
   - group them into capability slices or work packages
   - identify dependencies, cross-cutting risks, and validation checkpoints
   - note any explicit ambiguity, conflict, or out-of-scope item

   This decomposition is part of the propose phase itself. Do not require the user to restate this workflow on every change.

3. **Create the change directory**
   ```bash
   openspec new change "<name>"
   ```
   This creates a scaffolded change at `openspec/changes/<name>/` with `.openspec.yaml`.

4. **Get the artifact build order**
   ```bash
   openspec status --change "<name>" --json
   ```
   Parse the JSON to get:
   - `applyRequires`: array of artifact IDs needed before implementation (e.g., `["tasks"]`)
   - `artifacts`: list of all artifacts with their status and dependencies

5. **Create artifacts in sequence until apply-ready**

   Use the task-planning tool available in the environment (for example `update_plan`; if a checklist tool exists, use it) to track progress through the artifacts.
   The progress list MUST explicitly include these gate milestones in order:
   - source decomposition complete
   - `proposal.md` drafted
   - proofability check complete
   - `design.md` drafted
   - `specs/*` drafted
   - `tasks.md` drafted
   - tasks readiness check complete

   **IMPORTANT**: gate checks are in-process blockers, not end-of-flow clean-up work. Do not postpone them until after all artifacts are written.

   Loop through artifacts in dependency order (artifacts with no pending dependencies first):

   a. **For each artifact that is `ready` (dependencies satisfied)**:
      - Get instructions:
        ```bash
        openspec instructions <artifact-id> --change "<name>" --json
        ```
      - The instructions JSON includes:
        - `context`: Project background (constraints for you - do NOT include in output)
        - `rules`: Artifact-specific rules (constraints for you - do NOT include in output)
        - `template`: The structure to use for your output file
        - `instruction`: Schema-specific guidance for this artifact type
        - `outputPath`: Where to write the artifact
        - `dependencies`: Completed artifacts to read for context
      - Read any completed dependency files for context
      - Keep the user-supplied decomposition source files as authoritative context throughout the propose flow
      - Create the artifact file using `template` as the structure
      - Apply `context` and `rules` as constraints - but do NOT copy them into the file
      - Show brief progress: "Created <artifact-id>"

      Artifact-specific workflow:
      - `proposal.md`: write the change intent, scope, capability slices, risks, and rationale from the decomposition result
      - Immediately after `proposal.md`, run **Proofability Check** before writing `design.md`
      - `design.md`: write the implementation structure, interfaces, sequencing, and validation strategy for every non-deferred proposal item
      - `specs/*` and `tasks.md`: derive them only from the validated proposal/design pair
      - `tasks.md` must follow the OpenSpec x spec-kit blended structure: Setup -> Blocking -> Slice 1..N -> Reconciliation
      - `tasks.md` must include MVP scope, dependencies, parallel opportunities, slice goals, and independent acceptance criteria
      - Each task must preserve the `1.1 / 1.2` style and support `[P]` and `[Slice-X]` tags
      - If the current change is `interactive`, the first item in `Blocking` in `tasks.md` must be `Proof Task`
      - Immediately after `specs/*` + `tasks.md`, run **Tasks Readiness Check** using `openspec/QUALITY-GATE.md` before declaring the change ready
      - By default, **Tasks Readiness Check** MUST be executed by an independent `verifier` sub-agent
      - Only if the current environment cannot spawn an independent `verifier` sub-agent may the main agent perform the check itself

      Required gate enforcement:
      - **Proofability Check** (BLOCKS design.md)
        - BEFORE writing design.md, verify proposal has a real-entry minimal loop, user action order, authority source, explicit non-evidence, and a proof method
        - If the change is `interactive`, verify the proposal states `can start but cannot be interacted with = failure`
        - Summarize the check result in the conversation
        - If any item is missing: update proposal.md, then re-check
        - DO NOT proceed to design.md until proofability is explicit
      - **Tasks Readiness Check** (BLOCKS declaring apply-ready)
        - AFTER writing specs/* and tasks.md, read `openspec/QUALITY-GATE.md`
        - Verify proposal -> design -> specs -> tasks still describes one closure loop
        - Verify tasks are executable, include verification commands, every implementation slice has a `verifier`, and if `interactive`, front-load a `Proof Task`
        - Default path: dispatch an independent `verifier` sub-agent to perform this check against the change artifacts and `openspec/QUALITY-GATE.md`
        - Fallback path: only when the environment cannot dispatch an independent `verifier` sub-agent may the main agent perform the check directly
        - The readiness result summary in the conversation MUST use this format:
          - first line: `PASS` or `FAIL`
          - then `findings`, ordered by severity
          - if result is `PASS`, still include `residual risks`
        - If any item fails: update the deficient artifact and re-run the check
        - DO NOT report apply-ready status until Tasks Readiness Check passes

      Task decomposition requirements:
      - Write `Setup` tasks first for context preparation and basic scaffolding
      - Then write `Blocking` tasks for shared prerequisites that must be completed first; if the change is `interactive`, the first item must be `Proof Task`
      - Split implementation by capability slice, using as many numbered slices as needed, and each slice must be independently verifiable
      - Each slice must include a `slice goal` and `independent acceptance criteria`
      - Finish with `Reconciliation` tasks for wrap-up, documentation, compatibility, regression, and alignment work
      - Mark parallelizable tasks with `[P]`
      - Mark slice ownership with `[Slice-1]`, `[Slice-2]`, ... `[Slice-N]` or equivalent numbered tags
      - Every task must specify file scope and a verification command
      - The independent `verifier` sub-agent used for Tasks Readiness Check must review artifacts independently and must not inherit the main agent's conclusion as evidence

   b. **Continue until all `applyRequires` artifacts are complete**
      - After creating each artifact, re-run `openspec status --change "<name>" --json`
      - Check if every artifact ID in `applyRequires` has `status: "done"` in the artifacts array
      - Stop when all `applyRequires` artifacts are done

   c. **If an artifact requires user input** (unclear context):
      - Use **AskUserQuestion tool** to clarify
      - Then continue with creation

6. **Show final status**
   ```bash
   openspec status --change "<name>"
   ```

**Output**

After completing all artifacts and finishing Tasks Readiness Check, summarize:
- Change name and location
- List of artifacts created with brief descriptions
- What's ready: "All artifacts created! Ready for implementation."
- Prompt: "Run `/opsx:apply` or ask me to implement to start working on the tasks."

**Artifact Creation Guidelines**

- Follow the `instruction` field from `openspec instructions` for each artifact type
- The schema defines what each artifact should contain - follow it
- Read dependency artifacts for context before creating new ones
- If the user supplied one or more files for decomposition, use them as required source inputs rather than optional background
- Use `template` as the structure for your output file - fill in its sections
- **IMPORTANT**: `context` and `rules` are constraints for YOU, not content for the file
  - Do NOT copy `<context>`, `<rules>`, `<project_context>` blocks into the artifact
  - These guide what you write, but should never appear in the output
- Keep the workflow fixed when decomposition files are provided:
  - source files -> decomposition
  - `proposal.md` -> proofability check
  - `design.md`
  - `specs/*` + `tasks.md`
  - tasks readiness check via `openspec/QUALITY-GATE.md`

- If you produce any process task list / plan / checklist while executing this skill, you MUST include these gate tasks explicitly:
  - proofability check
  - tasks readiness check

**Guardrails**
- Create ALL artifacts needed for implementation (as defined by schema's `apply.requires`)
- Always read dependency artifacts before creating a new one
- Do not skip decomposition when the user explicitly anchors the change to one or more files
- Do not skip `proofability check` after `proposal.md`
- Do not defer `tasks readiness check` until after you have already declared the change ready
- Do not use the main agent for `tasks readiness check` when an independent `verifier` sub-agent is available
- Do not treat the listed source files as optional reference material
- Do not declare the change ready if `openspec/QUALITY-GATE.md` has unresolved readiness failures
- If context is critically unclear, ask the user - but prefer making reasonable decisions to keep momentum
- If a change with that name already exists, ask if user wants to continue it or create a new one
- Verify each artifact file exists after writing before proceeding to next
