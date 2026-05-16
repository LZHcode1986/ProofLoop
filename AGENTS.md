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
- Product intent and stage plan: `PRD.md`
- Top-level technical constraints: `tech-spec.md`
- Repo-wide operating constraints: `AGENTS.md`

## Environment Notes

- OS: Windows
- Shell: PowerShell (`pwsh`)
- Command style: prefer PowerShell-native commands and `;` for sequencing
- Live OpenSpec assets now live in `openspec/`, not `adapters/openspec/`

## Design Philosophy

Use these ideas when choosing stage boundaries, module boundaries, and task shapes:

- Manage complexity first.
  Complexity shows up as change amplification, high cognitive load, and unknown unknowns.

- Prefer deep modules over shallow wrappers.
  A good stage should move one meaningful capability or module boundary, not scatter thin changes across unrelated areas.

- Protect information hiding.
  Avoid stages that leak many internal details across module boundaries or require callers to learn hidden sequencing rules.

- Favor strategic design over tactical patching.
  Do not optimize only for this prompt if the boundary clearly harms future maintainability.

- Design twice when the boundary matters.
  If a stage or module split is important, compare at least two different partitions before choosing one.

## Stage Planning Rules

- Brain owns PRD decomposition into stages.
- Each stage should represent one independently valuable function or one coherent module boundary.
- One stage should not mix multiple unrelated modules or multiple top-level user capabilities.
- A stage must include:
  - objective
  - boundary
  - explicit out-of-scope items
  - immutable acceptance criteria
  - major dependencies or design risks
- Prefer stage boundaries that reduce change amplification and keep the cognitive load local.
- If a proposed stage combines unrelated features, hidden cross-module coupling, or ambiguous ownership, reject the partition and repartition before task decomposition.

## Task Decomposition Rules

- Propose decomposes exactly one stage at a time.
- Do not let a single `tasks.md` smear work across multiple independent stages.
- Every task must trace back to the current stage objective and acceptance criteria.
- Keep tasks narrow enough for direct execution, but do not split into shallow pass-through tasks that add ceremony without reducing complexity.
- Acceptance criteria are immutable once Brain dispatches them. L1 agents may map them; L2 reviewers may verify them; neither may rewrite them.

## Verification Boundaries

- `spec-verifier` checks stage planning artifacts for readiness and acceptance coverage.
- `code-verifier` checks slice-level implementation gates.
- `implementation-reviewer` checks stage-level integrated outcomes.
- `committer` only closes git boundaries.

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
