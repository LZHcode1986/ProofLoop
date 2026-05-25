---
name: openspec-propose
description: Propose a new change with all artifacts generated in one step. Use when the user wants to quickly describe what they want to build and get a complete proposal with design, specs, and tasks ready for implementation.
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.2"
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
   - group them into independently verifiable capability slices or coherent module boundaries
   - identify dependencies, cross-cutting risks, and validation checkpoints
   - note any explicit ambiguity, conflict, or out-of-scope item

   Do not decompose only by frontend / backend / db layers.

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

5. **Create artifacts in sequence until readiness-review complete**

   Use the task-planning tool available in the environment (for example `update_plan`; if a checklist tool exists, use it) to track progress through the artifacts.
   The progress list MUST explicitly include these gate milestones in order:
   - source decomposition complete
   - reality snapshot complete
   - `proposal.md` drafted
   - proofability check complete
   - `design.md` drafted
   - `specs/*` drafted
   - `tasks.md` drafted
   - spec-verifier tasks readiness check started
   - reality readiness verifier check started
   - readiness checks complete

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
      - `proposal.md`: write the change intent, scope, capability slices, risks, rationale, reality snapshot, and critical runtime assumptions from the decomposition result
      - Immediately after `proposal.md`, run **Proofability Check** before writing `design.md`
      - `design.md`: write the implementation structure, interfaces, sequencing, and validation strategy for every non-deferred proposal item
      - `specs/*` and `tasks.md`: derive them only from the validated proposal/design pair
      - `tasks.md` must follow the OpenSpec x spec-kit blended structure and the current tasks template
      - Each task must preserve the `1.1 / 1.2` style and support `[P]` and `[Slice-X]` tags
      - If the current change is `interactive`, the first item in `Blocking` in `tasks.md` must be `Proof Task`
      - Every task must include task-level metadata: `Execution Type`, `Required Skills`, `Required Review Skills`, `Skill Reason`, and `Boundary Receipt Required` for implementation tasks
      - Any task that changes code must use `Execution Type: test-first-code` and `Required Skills: test-driven-development`
      - Non-code tasks must not load TDD by default
      - Immediately after `specs/*` + `tasks.md`, run **Tasks Readiness Check** using `openspec/QUALITY-GATE.md` before declaring the change ready

      Required gate enforcement:
      - **Proofability Check** (BLOCKS design.md)
        - This is an author-side process gate, not a standalone artifact and not a readiness review
        - The main agent performs this check directly unless the user explicitly asks for independent review
        - Use the `Proofability Check` section in `openspec/QUALITY-GATE.md` as checklist reference only
        - BEFORE writing design.md, verify proposal has a real-entry minimal loop, user action order, authority source, explicit non-evidence, and a proof method
        - If the change is `interactive`, verify the proposal states `can start but cannot be interacted with = failure`
        - Summarize the check result in the conversation
        - If any item is missing: update proposal.md, then re-check
        - DO NOT proceed to design.md until proofability is explicit
      - **Tasks Readiness Check** (BLOCKS declaring planning readiness back to Brain)
        - AFTER writing specs/* and tasks.md, read `openspec/QUALITY-GATE.md`
        - ALWAYS spawn an independent `spec-verifier` sub-agent to execute this check
        - Give the `spec-verifier` only the change path, artifact paths, `openspec/QUALITY-GATE.md`, and the exact gate to review
        - The `spec-verifier` checks the whole change artifact set: `proposal.md`, `design.md`, `specs/*`, and `tasks.md`
        - The check scope is artifact completeness, consistency, omissions, and acceptance coverage. It does not decide implementation readiness.
      - The check must fail if `tasks.md` lacks a Stage Acceptance Coverage Map, if any Stage Acceptance Criterion is uncovered, if any implementation task lacks `Allowed File Scope` or `Boundary Receipt Required`, or if any verifier task lacks `Boundary Evidence Required` or gate standards do not match the slice acceptance criteria they are supposed to verify
        - The `spec-verifier` must report deficient artifacts and findings; it must not decide whether to create another change or rewrite the scope itself
        - The `spec-verifier` must review independently rather than inheriting the main agent's conclusion
        - The document-readiness result summary in the conversation MUST use this format:
          - first line: `DOC READINESS PASS` or `DOC READINESS FAIL`
          - then `findings`, ordered by severity
          - if result is `DOC READINESS PASS`, still include `residual risks`
        - Summarize the `spec-verifier` result in the conversation
        - **Handling FAIL results (Integrated Optimization)**:
          1. Parse the "Logical Gap / Conflict" and "Actionable Missing Piece" from the findings.
          2. DO NOT just patch the single reported artifact. Trace the requirement logic from `proposal.md` -> `design.md` -> `specs/*` -> `tasks.md`.
          3. Perform a **Batch Repair**: Update ALL affected artifacts in a single coherent step before re-running the verifier.
          4. **CIRCUIT BREAKER**: If the `spec-verifier` returns `DOC READINESS FAIL` for the 3rd consecutive time on the same change, STOP. Present the findings to the user and ask for guidance.
        - Only after the `spec-verifier` returns `DOC READINESS PASS` may the main agent mark `Tasks Readiness Check` complete
        - The main agent MUST NOT self-approve, self-check, or use a degraded self-check path
        - If subagent tooling is unavailable, blocked by policy, or not yet authorized by the user, STOP and ask the user to enable or authorize subagent verification; do not continue to ready/apply-ready status
        - AFTER `spec-verifier`, ALWAYS run the configured independent reality readiness verifier on the same change before reporting readiness back to Brain
        - Use `reality-verifier` by default. Use an optional variant only when the target project explicitly configures one.
        - DO NOT report apply-ready or implementation-ready status from propose; only report that the artifacts are ready for Brain review once both independent checks finish

      Task decomposition requirements:
      - Write `Setup` tasks first for context preparation and basic scaffolding
      - Then write `Blocking` tasks for shared prerequisites that must be completed first; if the change is `interactive`, the first item must be `Proof Task` with `Execution Type: proof` and `Required Skills: None`
      - Split implementation by capability slice, using as many numbered slices as needed, and each slice must be independently verifiable
      - Each slice must include a `slice goal` and `independent acceptance criteria`
      - Include a Stage Acceptance Coverage Map that shows which slice verifier gate or reconciliation check covers each caller-supplied Stage Acceptance Criterion
      - If any Stage Acceptance Criterion is not covered by a slice verifier gate or reconciliation check, repair the decomposition before declaring the tasks ready
      - Finish with `Reconciliation` tasks for wrap-up, documentation, compatibility, regression, and alignment work
      - Mark parallelizable tasks with `[P]`
      - Mark slice ownership with `[Slice-1]`, `[Slice-2]`, ... `[Slice-N]` or equivalent numbered tags
      - **Verification Standards**: Every task must specify file scope and a **concrete, executable verification command** (e.g., `uv run pytest`, `npm test`, or a script execution). Avoid generic commands like `grep` unless raw content inspection is the specific goal.
      - **Execution Type Standards**:
        - `setup`: context preparation, environment setup, scaffolding that does not modify product code
        - `docs-sync`: artifact or documentation synchronization
        - `test-first-code`: every task that changes code; must include `Required Skills: test-driven-development`
        - `proof`: only the first Blocking task of an `interactive` change; if it needs code changes, make it `test-first-code`
        - `verifier-gate`: explicit independent Code Verifier gate
        - `reconciliation`: final alignment, docs, compatibility, or cleanup checks
      - **Required Skills Standards**:
        - Code-changing tasks: `test-driven-development`
        - Diagnose tasks are not generated during propose; Executor adds `diagnose` only during rescue
        - Non-code tasks: `None`, unless a concrete task-specific skill is explicitly needed
      - **Required Review Skills Standards**:
        - Verifier gate tasks: `code-review-and-quality`
        - Add `security-and-hardening` only when user input, auth, permissions, storage, upload, external integration, or network boundary is in scope
      - Every implementation task must explicitly include `Allowed File Scope` and `Boundary Receipt Required`
      - Every `verifier` task must explicitly include `Covered Tasks`, `Inspection Scope`, `Inspection Content`, `Out of Scope`, `Boundary Evidence Required`, and `PASS/FAIL Gate`
      - Every verifier `PASS/FAIL Gate` must align with the current slice acceptance criteria and must not expand into unrelated stage-level review
      - Implementation task verification commands and verifier gate standards must be consistent; do not add extra gates to compensate for unclear task decomposition
      - **Branch Logic**: If a task or slice contains conditional branches (e.g., "if test fails, stop and log"), these MUST be explicitly documented in the tasks.
      - Proposal assertions such as `existing`, `automatic`, `reused`, or `already supported` must include code anchors or be explicitly marked as unverified assumptions

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
- State the `spec-verifier` and configured reality readiness verifier results separately
- What's ready: "All artifacts created. Ready for Brain review."
- Prompt: "Brain should review structure, document readiness, and reality readiness before execution."

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
- Do not self-mark `Tasks Readiness Check` as passed before an independent `spec-verifier` returns `DOC READINESS PASS`
- Do not replace independent spec-verifier review with self-review, even temporarily
- Do not declare the change ready, apply-ready, or fully gated if `spec-verifier` or the configured reality readiness verifier has not run
- If spec-verifier execution is blocked by tool availability, policy, or missing user authorization, stop and request what is needed instead of downgrading the gate
- If reality readiness verifier execution is blocked by tool availability, policy, or missing user authorization, stop and request what is needed instead of downgrading the gate
- Do not treat the listed source files as optional reference material
- Do not declare the change ready if `openspec/QUALITY-GATE.md` has unresolved readiness failures
- If context is critically unclear, ask the user - but prefer making reasonable decisions to keep momentum
- If a change with that name already exists, ask if user wants to continue it or create a new one
- Verify each artifact file exists after writing before proceeding to next
