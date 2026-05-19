# ProofLoop Repository Rules

## Rule Priority

- For change workflow, spec structure, proposal/design/tasks format, archive rules, and implementation process, follow `openspec/` as the single source of truth.
- Use this file for repo-specific operating rules that OpenSpec itself does not encode.
- When this file conflicts with any older archived methodology document, this file wins.

## Repo Role

- This repo is the coordination hub for the ProofLoop workflow built on OpenSpec.
- Live workflow assets live under `openspec/` at the repository root.
- `skills/` contains reusable skill source files.
- `agents/` contains opencode-style agent definitions and dispatch contracts.


## Source Of Truth

- Workflow and change rules: `openspec/`
- Product intent and stage plan: 
- Top-level technical constraints: 
- Repo-wide operating constraints: `AGENTS.md`

## Environment Notes

- OS:  
- Shell:  
- Command style: prefer PowerShell-native commands and `;` for sequencing


## Design Philosophy

- Manage complexity before optimizing for local convenience.
- Prefer stage and module boundaries that hide internal sequencing from callers.
- Do not introduce shallow wrapper stages that move work without creating a clearer module boundary.
- If the boundary matters and two partitions are plausible, compare both before choosing.
- Do not optimize only for the current prompt when the boundary would increase future change amplification.

## Stage Planning Rules

- Brain owns PRD decomposition into stages.
- Define the stage objective, boundary, explicit out-of-scope, immutable acceptance criteria, and major risks before task decomposition.
- Decompose only stages that represent one independently valuable capability or one coherent module boundary.
- Do not decompose a stage that mixes unrelated capabilities, unrelated modules, or ambiguous ownership.
- If the stage boundary increases change amplification without a clear module or delivery benefit, reject it and repartition before writing tasks.

## Task Decomposition Rules

- Propose decomposes exactly one stage at a time.
- Do not let a single `tasks.md` smear work across multiple independent stages.
- Make every task trace directly to the current stage objective and acceptance criteria.
- Do not create pass-through tasks that only hand work between agents without changing an artifact or verification boundary.
- If a task cannot be verified or mapped to acceptance criteria, rewrite or remove it before execution.
- Acceptance criteria are immutable once Brain dispatches them. L1 agents may map them; L2 reviewers may verify them; neither may rewrite them.

## Verification Boundaries

- `spec-verifier` checks stage planning artifacts for readiness and acceptance coverage.
- `code-verifier` checks slice-level implementation gates.
- `implementation-reviewer` checks stage-level integrated outcomes.
- `committer` only closes git boundaries.

### Subagent Reliability

**Session Reuse**: For subsequent operations on the same Change / Stage / task, you must reuse existing subagent sessions (via the `task_id` parameter) and must not create new sessions each time. Creating new sessions loses context, leading to repeated exploration and token waste.

- When Brain dispatches L1 subagents (`@propose`, `@executor`, `@implementation-reviewer`): if it is a continuation of the same Change, pass the `task_id` returned last time to restore the session.
- When Executor dispatches L2 subagents (`@code-verifier`, `@spec-verifier`, `@worker`): if it is a re-verification of the same Slice, similarly reuse the `task_id`.
- New sessions may only be created in the following cases: ① A completely new Change/Stage ② The previous session has completed and context is no longer needed ③ The subagent returns an unrecoverable error after reusing `task_id`.

**Stall Recovery**: Any subagent (L1/L2) may become unresponsive due to security scanning, network timeout, resource contention, etc. When the parent agent dispatches, it should estimate a reasonable timeout in the task description (default 120 seconds). If not returned by the deadline, it is considered `stalled`. Recovery process:

1. Re-dispatch using **the same `task_id`**, appending in the task description: "Previous timeout, please continue from the completed checkpoint."
2. If retrying with the same `task_id` twice still yields no response, create a new session (excluding the operation that caused the stall in the task description).
3. If the new session still fails → Executor reports to Brain as `Execution blocked`; Brain reports to the user as `Blocked`, with the reason and retry history.

## Git Worktree Policy

- Current MVP policy is manual selection, not automatic management.
- Brain or the human operator selects the active worktree for a change or stage.
- Executor runs inside the selected worktree.
- Worker, verifiers, and committer stay inside that worktree.
- Automatic worktree creation, cleanup, or rebase belongs to a future `manager` role and is out of scope for the current MVP.

## Think Before Coding

- State assumptions explicitly when they matter.
- If a boundary is unclear, stop and name the ambiguity instead of guessing.
- If two different decompositions are plausible, compare them briefly before choosing.

## Simplicity First

- Minimum code that solves the problem. Nothing speculative.
- No abstractions for single-use code unless they create a clearly deeper module.
- No flexibility or configurability that was not requested.

## Surgical Changes

- Touch only what the current request requires.
- Do not clean up unrelated code just because you noticed it.
- Match the existing style unless the current task is explicitly about changing the standard.

## Goal-Driven Execution

- Define success criteria before implementation.
- Break work into verifiable stage and task boundaries.
- Prefer strong acceptance criteria over vague completion language.
