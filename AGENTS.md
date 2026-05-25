# ProofLoop Repository Rules

## Rule Priority

- For change workflow, spec structure, proposal/design/tasks format, archive rules, and implementation process, follow `openspec/` as the single source of truth.
- Use this file for repo-specific operating rules that OpenSpec itself does not encode.
- When this file conflicts with any older archived methodology document, this file wins.

## Repo Role

- This repo is the coordination hub for the ProofLoop workflow built on OpenSpec.
- Live workflow assets live under `openspec/` at the repository root.
- `.agents/skills/` contains reusable skill source files.
- Fixed Brain subagent packet formats live in `.agents/contracts/dispatch-packets.md`.
- Fixed Executor subagent packet formats live in `.agents/contracts/executor-dispatch-packets.md`.

## Source Of Truth

- Workflow and change rules: `openspec/`
- Product intent and stage plan: `PRD.md`, `CLARIFY.md`, `tech-spec.md`
- Top-level technical constraints: `openspec/config.yaml`, `openspec/QUALITY-GATE.md`, schema and gate documents
- Repo-wide operating constraints: `AGENTS.md`

## Workflow Rule Ownership

- Brain owns PRD intake, acceptance criteria, stage planning, and archive transition decisions. 
- Propose owns one-stage OpenSpec decomposition into proposal, design, specs, and tasks. 
- Executor owns apply orchestration, Worker dispatch, run ledger, git boundary dispatch, verifier dispatch, and rescue flow. 
- Worker owns one implementation task only. 
- Committer owns git boundary closure, mechanical scope checks, and boundary receipts. 
- Reality Verifier owns code-reality readiness after Propose creates formal artifacts. 
- Code Verifier owns slice-level semantic verification after boundary receipts exist. 
- Implementation Reviewer owns stage-level integrated review and Brain-authorized archive execution. 
- Executor dispatch packet shapes for Worker, Code Verifier, and Committer are owned by `.agents/contracts/executor-dispatch-packets.md`.

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

## Task Decomposition Summary

- Propose receives exactly one Brain-selected stage.
- Propose turns that stage into OpenSpec artifacts and verifier-gated `tasks.md`.

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
