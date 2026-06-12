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

Phase:
- blind-refutation

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

Allowed Actions:
- Use OpenSpec / Slice Contract as authority.
- Try to construct a real counterexample for the slice.
- Prefer runtime/API/UI paths over structural inspection.
- Every Slice AC must have a refutation attempt; if any AC is unchallenged, verdict is inconclusive.
- Return Blind Slice Refutation Receipt.

Forbidden Actions:
- Do not inspect Worker evidence (Worker Completion Receipts, Hypothesis Verification Receipts, Evidence Ledger worker sections) before blind refutation is complete.
- Do not modify implementation or write Evidence Ledger.
- Do not dispatch Committer.
- Do not PASS solely because tests pass.
- Do not ask the user or request permission approval.
- Do not read denied secret files such as `.env` or `.env.*`.
- Do not wait for service startup, credentials, or interactive setup.

Runtime Policy:
- Non-interactive only.
- Subject to runtime and fail-fast policies in .agents/contracts/worker-runtime-contract.md.
- If required runtime config or dependency is unavailable, return blocked immediately with `runtime-config-blocker` or `runtime-dependency-blocker` using the Blocked Receipt format defined in the contract.

Expected Result:
- Blind slice refutation complete | Blind slice refutation blocked

Receipt Format:
[First Line: Blind slice refutation complete]

Slice:
Covered Tasks:

OpenSpec Expected Behavior:

Counterexamples Attempted:
- case:
- path/input:
- expected:
- actual:
- result:
  - refuted | not-refuted | inconclusive

Blind Refutation Result:
- refuted | not-refuted | inconclusive

Preliminary Category:
- none
- implementation-defect
- contract-defect
- evidence-defect
- protocol-defect

Notes:
```

## Code Verification - Evidence Review

```text
Executor Dispatch: Code Verification - Evidence Review

Phase:
- evidence-review

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

Allowed Actions:
- Read and verify Worker evidence (receipts, ledger sections, diff snapshots) only from the inline content provided in this dispatch packet.
- Evaluate blind refutation result against Worker evidence.
- Attribute task-level defects if verification fails or blocks.
- After Final Slice Verdict = pass, update the verifier gate checkbox [x] in tasks.md.
- Return Code Verifier Receipt with Final Slice Verdict.

Forbidden Actions:
- Do not independently scan the filesystem for receipts, ledger sections, or snapshot files.
- Do not modify implementation or write Evidence Ledger.
- Do not dispatch Committer.
- Do not introduce project-specific requirements not declared upstream.
- Do not ask the user or request permission approval.
- Do not read denied secret files such as `.env` or `.env.*`.
- Do not wait for service startup, credentials, or interactive setup.

Runtime Policy:
- Non-interactive only.
- Subject to runtime and fail-fast policies in .agents/contracts/worker-runtime-contract.md.
- If required inline review payload is missing from the dispatch, return blocked immediately with `protocol-defect` (do not classify missing inline payload as `evidence-defect`).
- If required runtime config or dependency is unavailable, return blocked immediately with `runtime-config-blocker` or `runtime-dependency-blocker` using the Blocked Receipt format defined in the contract.

Decision Rules:
- Blind refutation = refuted:
    Final Slice Verdict = fail
    Category = IMPLEMENTATION DEFECT or CONTRACT DEFECT
    Task attribution required = yes
- Blind refutation = not-refuted AND Worker evidence sufficient AND no worker contract-mismatch AND no unresolved evidence defect:
    Final Slice Verdict = pass
    Category = PASS
- Blind refutation = not-refuted AND Worker evidence insufficient:
    Final Slice Verdict = blocked
    Category = EVIDENCE DEFECT
    Task attribution required = yes
- Blind refutation = inconclusive:
    Final Slice Verdict = blocked
    Category = EVIDENCE DEFECT or PROTOCOL DEFECT
    Task attribution required = yes
- Worker contract-mismatch found:
    Final Slice Verdict = blocked
    Category = CONTRACT DEFECT
    Task attribution required = yes

Evidence Sufficiency Rules:
PASS only when all conditions are satisfied:
1. Declared slice acceptance is covered.
2. Required Verification Method was executed.
3. Expected Evidence is present.
4. Required Skill Evidence is present (structured format, not just skill name).
5. Boundary receipts are present as inline content in this dispatch where required.
6. No unresolved contract conflict remains.
7. Scope and CodeGraph rules are satisfied.

Gate Classification Rules:
- IMPLEMENTATION DEFECT: implementation contradicts declared contract.
- EVIDENCE DEFECT: implementation may be correct, but required evidence is missing or too weak.
- CONTRACT DEFECT: upstream contract is ambiguous, inconsistent, omitted, or unmapped.
- PROTOCOL DEFECT: agent skipped required receipt, ledger update, skill evidence, or boundary protocol.

Missing Evidence Review Payload Classification:
- If Worker produced evidence but Executor failed to inline it, classify as: PROTOCOL DEFECT
- If Worker did not produce required evidence, classify as: EVIDENCE DEFECT
- If Code Verifier cannot tell whether evidence exists because inline dispatch payload is missing, classify as: PROTOCOL DEFECT

Expected Result:
- Slice verification passed | Slice verification failed | Slice verification blocked

Receipt Format:
[First Line: Slice verification passed | Slice verification failed | Slice verification blocked]

Category:
- PASS
- IMPLEMENTATION DEFECT
- EVIDENCE DEFECT
- CONTRACT DEFECT
- PROTOCOL DEFECT

Severity:

Slice:
Covered Tasks:

Blind Refutation:
- result:
- counterexamples attempted:

Evidence Review:
- worker hypotheses checked:
- supported:
- refuted:
- unproven:
- contract-mismatch:
- evidence missing:
- fixture/source issues:

Task Attribution:
- required: yes/no
- Task ID:
- Hypothesis ID:
- Failure type:
  - implementation-defect
  - contract-defect
  - evidence-defect
  - protocol-defect
- Refutation:
- Minimal next action:
  - repair implementation
  - backfill evidence
  - return to Propose
  - return to Brain

Contract Echo Check:
- received:
- evidence present:
- evidence missing:
- conflicted:

Skill Evidence Check:
- Required Skills:
- Required Review Skills:
- evidence present:
- missing:

Task Snapshot Receipt Check:
CodeGraph Impact Check:
Boundary / Scope Check:

Findings:
- BLOCKER:
- WARNING:
- NOTE:

Verifier Gate Checkbox:
- file:
- line:
- checked: yes/no

Final Slice Verdict:
- pass | fail | blocked
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
