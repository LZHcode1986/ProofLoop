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

- Brain supplies one selected stage and immutable acceptance criteria before task decomposition begins.
- Propose turns that single stage into verifiable `tasks.md` work; it must not plan across unrelated stages.
- Executor consumes prepared tasks; it must not redefine task scope, acceptance criteria, or stage boundaries during execution.
- Acceptance criteria are immutable after Brain dispatch. Propose may decompose them into task and verifier-gate standards; Executor consumes those prepared standards. Reviewers verify only their assigned scope; no agent may rewrite the original criteria.

## Verification Boundaries

- `spec-verifier` checks stage planning artifacts for readiness and acceptance coverage.
- `code-verifier` checks slice-level implementation gates.
- `implementation-reviewer` checks stage-level integrated outcomes.
- `committer` only closes git boundaries.

### Subagent Reliability

- Reuse the existing `task_id` for any continuation of the same Change, Stage, Slice, or task. Do not start a fresh session to recover context.
- Start a new session only when the scope is new, the previous session is complete and no longer needed, or the reused session returns an unrecoverable error.
- Every subagent dispatch must include an expected timeout. Default to 120 seconds when no better estimate exists.
- On timeout, retry once with the same `task_id` and instruct the subagent to continue from the last completed checkpoint.
- If the same-session retry also stalls, start one fresh session with a narrower packet that excludes the suspected stall trigger.
- If the fresh session fails, stop. Executor reports `Execution blocked` to Brain; Brain reports `Blocked` to the user with the reason and retry history.

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
