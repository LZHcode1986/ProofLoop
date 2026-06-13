# Executor Git Boundary Dispatch Contract

Use when Executor closes a run checkpoint or Worker output boundary through Committer.

Packet title:

Executor Dispatch: Git Boundary

Required fields:
- Boundary Type
- Change
- Task ID
- Attempt
- Reason
- Allowed File Scope
- Expected Changed Paths
- Forbidden Paths
- Boundary Receipt Required
- Expected Action

Rules:
- Committer owns git operations.
- Executor must not stage or commit directly.
- Boundary receipt is required before the next Worker or verifier dispatch.
- If Committer returns failure, Executor stops and reports blocker.

Packet shape:

Executor Dispatch: Git Boundary

Boundary Type: run-checkpoint | worker-output
Change:
Task ID: <none for run-checkpoint>
Attempt: initial | repair-1 | repair-2 | diagnose | none
Reason:
- run-checkpoint: preserve pre-existing dirty worktree before apply execution.
- worker-output: close the completed Worker attempt before any next Worker or verifier.
Allowed File Scope:
Expected Changed Paths:
Forbidden Paths:
Boundary Receipt Required:
- commit hash or no-op receipt
- branch
- pre-commit HEAD
- parent hash
- files staged
- files outside allowed scope
- scope check
- diff evidence availability

Expected Action:
- Inspect git status.
- Stage only changes relevant to this boundary.
- Commit if relevant changes exist.
- Return the required first line and commit/no-op/failure receipt.
