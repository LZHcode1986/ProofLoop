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
- Fixed Brain subagent packet formats live in `agents/contracts/dispatch-packets.md`.

## Source Of Truth

- Workflow and change rules: `openspec/`
- Product intent and stage plan: `PRD.md`, `CLARIFY.md`, `tech-spec.md`
- Top-level technical constraints: `openspec/config.yaml`, `openspec/QUALITY-GATE.md`, schema and gate documents
- Repo-wide operating constraints: `AGENTS.md`

## Workflow Rule Ownership

- Brain owns PRD intake, acceptance criteria, stage planning, and archive transition decisions. See `agents/brain.md`.
- Brain dispatch packet shapes are owned by `agents/contracts/dispatch-packets.md`.
- Propose owns one-stage OpenSpec decomposition into proposal, design, specs, and tasks. See `agents/propose.md`.
- Executor owns apply orchestration, Worker dispatch, run ledger, git boundary dispatch, verifier dispatch, and rescue flow. See `agents/executor.md`.
- Worker owns one implementation task only. See `agents/worker.md`.
- Committer owns git boundary closure, mechanical scope checks, and boundary receipts. See `agents/committer.md`.
- Reality Verifier owns code-reality readiness after Propose creates formal artifacts. See `agents/reality-verifier.md`; projects with CodeGraph may opt into `agents/reality-verifier-codegraph.md`.
- Code Verifier owns slice-level semantic verification after boundary receipts exist. See `agents/code-verifier.md`.
- Implementation Reviewer owns stage-level integrated review and Brain-authorized archive execution. See `agents/implementation-reviewer.md`.

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

## Stage Planning Summary

- Brain owns PRD decomposition into stages.
- Stages must represent one independently valuable capability or one coherent module boundary.
- If a boundary is unclear, Brain should compare plausible partitions before choosing one.
- Detailed stage planning rules live in `agents/brain.md`.

## Task Decomposition Summary

- Propose receives exactly one Brain-selected stage.
- Propose turns that stage into OpenSpec artifacts and verifier-gated `tasks.md`.
- Detailed task decomposition rules live in `agents/propose.md`.

## Verification Boundaries

- `spec-verifier` checks stage planning artifacts for readiness and acceptance coverage.
- `reality-verifier` checks planning artifacts against current repository reality before execution.
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
