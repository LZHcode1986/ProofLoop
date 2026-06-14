# Executor Execution Summary Contract

Use when Executor returns final apply-stage result to Brain.

This contract is Executor-owned and is not shared with other dispatch contracts.

Packet title:

Executor Execution Summary

Required fields:
- Result
- Change
- Stage
- Worker Receipts
- Git Boundary Receipts
- Code Verification Receipts
- Slice Routing
- Slice Commits
- Evidence Ledger
- Residual Risks
- Next Action

Rules:
- Summarize Execution result only.
- Reference Worker, Committer, and Code Verifier receipts by receipt ref.
- Do not duplicate full receipt bodies unless Brain needs inline evidence.
- Preserve Code Verifier verdicts exactly.
- Executor must not reinterpret Code Verifier judgment.
- Executor must not claim Brain acceptance.
- Executor must not edit Evidence Ledger.

Packet shape:

Executor Execution Summary

Result: Execution complete | Execution blocked | Verification failed

Change:
Stage:

Worker Receipts:
- task:
- receipt ref:

Git Boundary Receipts:
- boundary:
- receipt ref:
- commit hash or no-op:

Code Verification Receipts:
- slice:
- verification mode:
- receipt ref:
- verdict:
- x.V checkbox:

Slice Routing:
- slice:
- verdict:
- next action:

Slice Commits:
- slice:
- commit hash:

Evidence Ledger:
- path:
- worker sections updated:
- executor edited ledger: no

Residual Risks:

Next Action:
- return to Brain
- Worker Fix required
- blocked
