# Executor Subagent Dispatch Packets

This is the canonical contract source for every dispatch made by `@executor`.

Executor must use this file when dispatching:

- `@worker`
- `@code-verifier`
- `@committer`

Brain-to-Executor packets live in:

```text
.agents/contracts/dispatch-packets.md
```

Executor-to-subagent packets live here.

## Git boundary principles

- Committer is a boundary closure agent, not a completion judge.
- Each Worker task gets a `task-diff-snapshot` receipt.
- A slice is committed only after Code Verifier passes.
- Archive output is committed separately.
- Do not commit implementation output before slice verification passes unless Brain explicitly requested audit behavior.

## Worker Implementation

```text
Executor Dispatch: Worker Implementation

Phase:
- implementation

Brain Dispatch Contract:
Slice Contract:
Change:
Task ID:
Task Name:
Task Text:
OpenSpec Artifacts:
OpenSpec source refs:
Allowed File Scope:
Forbidden File Scope:
Required Skills:
Verification Method:
Expected Evidence:
CodeGraph Anchors:
Stop Conditions:
Checkbox Owner:

Allowed Actions:
- Use OpenSpec / Slice Contract as authority.
- Work only on this task and edit files only inside Allowed File Scope.
- Run non-interactive verification commands.
- Update assigned task checkbox in tasks.md only after local verification passes.

Forbidden Actions:
- Do not read Evidence Ledger AC hypothesis.
- Do not use AC hypothesis as implementation authority.
- Do not perform hypothesis verification or evidence backfill.
- Do not write Evidence Ledger.
- Do not broaden scope.
- Do not commit.
- Do not invoke subagents.
- Do not ask the user or request permission approval.
- Do not read denied secret files such as `.env` or `.env.*`.
- Do not wait for interactive setup or service startup.

Runtime Policy:
- Non-interactive only.
- Subject to runtime and fail-fast policies in .agents/contracts/worker-runtime-contract.md.
- Use `runtime-config-blocker` for missing config or denied secret material.
- Use `runtime-dependency-blocker` for unavailable runtime dependencies.

Expected Result:
- Implementation finished | Implementation blocked | Implementation failed

Receipt Format:
[First Line: Implementation finished | Implementation failed]

Task:
Slice:

Contract Echo:
- accepted:
- satisfied:
- not satisfied:
- conflicted:

Skills used:

Skill Evidence:
- required skills:
- evidence:
- deviation / not applicable reason:

What changed:
Files changed:
Commands run:
Verification result:
Acceptance evidence:

Task Checkbox:
- file:
- line:
- checked: yes/no

CodeGraph Evidence:
- status checked:
- stale banner encountered:
- anchors used:
- impact notes:
- fallback direct reads:

Git Boundary:
- commit created: no
- expected next boundary: task-diff-snapshot

Stop conditions encountered:
Upgrade required:
- yes/no
- reason:

Residual risk:
```

## Worker Hypothesis Verification

```text
Executor Dispatch: Worker Hypothesis Verification

Phase:
- hypothesis-verification

Completed Implementation Receipt:
OpenSpec source refs:
Slice Contract:
Assigned AC Hypotheses:
- id:
- source:
- text:
- expected evidence:

Evidence Ledger:
- path:
- assigned section:
- update mode: worker writes assigned section only

Allowed Actions:
- Inspect completed implementation, OpenSpec source refs, and Slice Contract.
- Verify assigned AC hypotheses against completed implementation.
- Write only the assigned Evidence Ledger section.
- Return Hypothesis Verification Receipt.

Forbidden Actions:
- Do not edit implementation or repair failures.
- Do not update task checkbox.
- Do not inspect unrelated Evidence Ledger sections or other Worker receipts.
- Do not broaden hypothesis or change verification target.
- Do not invoke subagents or commit.
- Do not ask the user or request permission approval.
- Do not read denied secret files such as `.env` or `.env.*`.
- Do not wait for service startup or interactive setup.

Runtime Policy:
- Non-interactive only.
- Subject to runtime and fail-fast policies in .agents/contracts/worker-runtime-contract.md.
- Use `runtime-config-blocker` for missing config or denied secret material.
- Use `runtime-dependency-blocker` for unavailable runtime dependencies.

Expected Result:
- Hypothesis verification complete | Hypothesis verification blocked

Receipt Format:
[First Line: Hypothesis verification complete]

Task:
Slice:

Evidence Ledger:
- path:
- assigned section:
- updated: yes/no

Hypothesis Verification:
- Hypothesis ID:
- Source:
- Text:
- Worker verdict:
  - supported | refuted | unproven | contract-mismatch
- Evidence:
  - implementation files:
  - tests/assertions:
  - commands:
  - runtime/manual check:
  - fixture/source:
- Worker Category:
  - none | implementation-defect | contract-defect | evidence-defect | protocol-defect
- Residual risk:
```

## Worker Fix

```text
Executor Dispatch: Worker Fix

Phase:
- fix

Brain Dispatch Contract:
Slice Contract:
OpenSpec Artifacts:
OpenSpec source refs:
Failed Slice / Gate:
Covered Tasks:
Fix Mode: repair | diagnose
Verifier Failure:
Original Task Constraints:
Allowed File Scope:
Required Skills:
Verification Method:
Stop Conditions:

Allowed Actions:
- Inspect verifier failure and completed implementation.
- Edit only files inside Allowed File Scope.
- Fix only the attributed defect.
- Run non-interactive verification commands.
- Return Fix Phase Receipt (reuse Implementation Phase Receipt format).

Forbidden Actions:
- Do not broaden scope or repair unrelated issues.
- Do not redefine the OpenSpec contract or change task acceptance criteria.
- Do not invoke subagents or commit.
- Do not ask the user or request permission approval.
- Do not read denied secret files such as `.env` or `.env.*`.
- Do not wait for interactive setup or service startup.

Runtime Policy:
- Non-interactive only.
- Subject to runtime and fail-fast policies in .agents/contracts/worker-runtime-contract.md.
- Use `runtime-config-blocker` for missing config or denied secret material.
- Use `runtime-dependency-blocker` for unavailable runtime dependencies.

Expected Result:
- Worker fix complete | Worker fix blocked | Worker fix failed

Receipt Format:
Use the Implementation Phase Receipt format with the first line matching:
`Worker fix complete` | `Worker fix failed`
```

## Worker Evidence Backfill

```text
Executor Dispatch: Worker Evidence Backfill

Phase:
- evidence-backfill

Change:
Task ID:
Task Name:
OpenSpec source refs:
Slice Contract:
Hypothesis ID:
Required Evidence:
Verification Commands:
Allowed File Scope:

Evidence Ledger:
- path:
- assigned section:
- update mode: worker writes assigned section only

Allowed Actions:
- Inspect completed implementation and assigned OpenSpec source refs.
- Rerun assigned verification commands to produce required evidence.
- Write only the assigned Evidence Ledger section.
- Return Evidence Backfill Receipt.

Forbidden Actions:
- Do not edit implementation or repair failures.
- Do not update task checkbox.
- Do not change verification strategy or invent evidence.
- Do not inspect unrelated ledger sections.
- Do not invoke subagents or commit.
- Do not ask the user or request permission approval.
- Do not read denied secret files such as `.env` or `.env.*`.
- Do not wait for service startup or interactive setup.

Runtime Policy:
- Non-interactive only.
- Subject to runtime and fail-fast policies in .agents/contracts/worker-runtime-contract.md.
- Use `runtime-config-blocker` for missing config or denied secret material.
- Use `runtime-dependency-blocker` for unavailable runtime dependencies.

Expected Result:
- Evidence backfill complete | Evidence backfill blocked

Receipt Format:
[First Line: Evidence backfill complete]

Task:
Slice:

Evidence Ledger:
- path:
- assigned section:
- updated: yes/no

Backfill:
- Hypothesis ID:
- Required evidence:
- Verification commands run:
- Evidence produced:
- Evidence still missing:

Worker Category:
- none
- evidence-defect

Residual risk:
```

## Worker Runtime Context Continuation

```text
Executor Dispatch: Worker Runtime Context Continuation

Phase:
- implementation | hypothesis-verification | evidence-backfill | fix

Original Worker Dispatch:
- phase:
- task:
- packet summary:

Previous Worker Receipt:
- blocker type:
- blocked operation:
- runtime facts needed:
- safe resolution hints:

Runtime Context Addendum:
- non-secret sources inspected:
- config names discovered:
- available fixture path:
- local service declaration:
- safe command alternative:
- unavailable facts:
- forbidden sources not read:

Allowed Actions:
- Continue the same task and same phase as specified in original dispatch.
- Use the original dispatch packet plus the Runtime Context Addendum.
- Return the receipt format required by the active phase.

Forbidden Actions:
- Do not read denied secret files such as `.env` or `.env.*`.
- Do not request permission approval or ask the user.
- Do not wait for service startup, credentials, login, or interactive setup.

Runtime Policy:
- Non-interactive only.
- Subject to runtime and fail-fast policies in .agents/contracts/worker-runtime-contract.md.
- If still blocked, return blocked with updated blocker type and receipt.

Expected Result:
- Result matching active phase outcome (e.g. Implementation finished, Hypothesis verification complete, or Blocked)

Receipt Format:
Use the receipt format specified by the active phase.
```

## Code Verification - Blind Refutation

```text
Executor Dispatch: Code Verification - Blind Refutation

Brain Dispatch Contract:
Slice Contract:
Change:
Slice / Gate:
Covered Tasks:
OpenSpec Artifacts:
OpenSpec source refs:
Files Changed In Slice:
Required Review Skills:
Allowed File Scope:
Forbidden File Scope:
Checkbox Owner:

Rules:
- Do not inspect Worker evidence.
- Do not inspect Evidence Ledger worker sections.
- Do not inspect Worker Completion Receipts.
- Do not inspect Worker Hypothesis Verification Receipts.
- Use OpenSpec / Slice Contract as authority.
- Try to construct a real counterexample for the slice.
- Prefer runtime/API/UI paths over structural inspection.
- Do not PASS solely because tests pass.
- Every Slice AC must have a refutation attempt; if any AC is unchallenged, verdict is inconclusive.
- Return Blind Slice Refutation Receipt.
```

## Code Verification - Evidence Review

```text
Executor Dispatch: Code Verification - Evidence Review

Blind Slice Refutation Receipt:
Worker Implementation Receipts:
- inline content only:
  - task:
  - receipt:
      <paste Worker Implementation Receipt content here>

Worker Hypothesis Verification Receipts:
- inline content only:
  - task:
  - hypothesis:
  - receipt:
      <paste Worker Hypothesis Verification Receipt content here>

Task Diff Snapshot Receipts:
- inline content only:
  - task:
  - boundary:
  - receipt:
      <paste task-diff-snapshot Boundary Receipt content here>

Evidence Ledger worker task/hypothesis sections for covered tasks:
- inline content only:
  - task:
  - hypothesis:
  - ledger section:
      <paste the assigned Evidence Ledger section here>

Files Changed In Slice:
Required Review Skills:
Checkbox Owner: Code Verifier

Rules:
- Evidence Review inputs are inline payloads, not file path references.
- Executor must paste the relevant receipt and ledger contents into this dispatch.
- File paths may be included only as source labels, never as substitutes for content.
- Code Verifier must not independently scan the filesystem for receipts or ledger sections.
- If required inline evidence is missing, Code Verifier returns "Slice verification blocked" with PROTOCOL DEFECT.
- Executor must not create synthetic, placeholder, or redundant receipt files to satisfy this packet.
- If blind refutation is refuted, slice fails.
- If blind refutation is not-refuted, inspect Worker evidence.
- If evidence is sufficient, slice passes.
- If evidence is insufficient, slice is blocked.
- If blind refutation is inconclusive, slice is blocked.
- If slice fails or blocks, perform task-level attribution.
- Final Slice Verdict goes in Code Verifier Receipt, not in Evidence Ledger.
- Worker evidence is a claim to challenge, not a fact to trust.
- After Final Slice Verdict = pass, open tasks.md and mark the verifier gate checkbox [x].
- Return Code Verifier Receipt with Final Slice Verdict.
```

## Git Boundary

Use when Executor dispatches Committer.

```text
Executor Dispatch: Git Boundary

Boundary Type:
- run-preflight
- task-diff-snapshot
- slice-output

Boundary Policy:
- normal | audit

Expected Receipt Type:
- clean
- diff-snapshot
- commit
- blocked

Change:
Stage:
Slice:
Task ID:
Reason:
Allowed File Scope:
Expected Changed Paths:
Forbidden Paths:
Expected Commit Message:

Expected Action:
- inspect git status
- inspect name-only diff
- inspect diff stat
- inspect relevant diff when needed
- if Expected Receipt Type is commit, stage only relevant files and commit
- if Expected Receipt Type is diff-snapshot, do not stage or commit
- return boundary receipt
```

## Boundary receipt

Committer must return:

```text
Boundary closed | Boundary snapshot recorded | Boundary clean | Boundary blocked | Boundary failed

Boundary:
- Type:
- Policy:
- Change:
- Stage:
- Slice:
- Task:
- Reason:

Git State:
- Branch:
- Pre-boundary HEAD:
- Dirty before:
- Dirty after:

Scope:
- Allowed File Scope:
- Files changed:
- Files outside allowed scope:
- Scope check:

Diff Evidence:
- Name-only inspected:
- Diff stat inspected:
- Relevant diff inspected:

Commit:
- Created:
- Commit hash:
- Commit message:

Blocker:
- Reason:
- Required Brain action:
```

## Contract Echo trimming

Each subagent uses a trimmed Contract Echo in its receipt:

- **Worker**: `accepted` | `satisfied` | `not satisfied` | `conflicted`
- **Code Verifier**: `received` | `evidence present` | `evidence missing` | `conflicted`
- **Committer**: no Echo required (returns Boundary Receipt only)
