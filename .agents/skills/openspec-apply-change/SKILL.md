---
name: openspec-apply-change
description: Read OpenSpec apply substrate for an active change. Use when Executor needs change selection, status, apply instructions, context files, progress, and remaining task state before ProofLoop execution.
license: MIT
compatibility: Requires openspec CLI.
metadata:
  author: openspec
  version: "1.0"
  generatedBy: "1.3.1"
---

# openspec-apply-change

Use this skill to obtain OpenSpec apply substrate for an active change.

When used by `@executor`, this skill does not implement tasks directly.
ProofLoop multi-agent execution is owned by `executor.md`.

## Input

Optionally specify a change name.

If omitted:
- infer from conversation context if one active change is clear;
- auto-select if only one active change exists;
- if ambiguous, run `openspec list --json` and return `Execution blocked` with candidate changes.

Do not ask the user directly from Executor mode.

Always announce:

```text
Using change: <name>
```

## Steps

### 1. Select the change

Use the provided change name, inferred change name, or the only active change.

If ambiguous:

```text
Execution blocked
Reason: ambiguous OpenSpec change
Candidates:
- <change>
```

### 2. Check status

Run:

```bash
openspec status --change "<name>" --json
```

Parse:
- schemaName;
- task artifact;
- artifact completion state.

### 3. Get apply instructions

Run:

```bash
openspec instructions apply --change "<name>" --json
```

Use the result for:
- contextFiles;
- progress;
- task list and status;
- dynamic apply instruction;
- apply state.

### 4. Handle apply state

If `state: "blocked"`:

```text
Execution blocked
Reason: missing or incomplete OpenSpec apply artifacts
```

If `state: "all_done"`:

```text
Apply substrate complete
State: all_done
Next owner: Executor / Brain flow
```

Do not declare archive readiness.

Otherwise:

```text
Apply substrate ready
State: active
```

### 5. Read context files

Read every file path listed under `contextFiles` from the apply instructions output.

Use contextFiles from the CLI output. Do not assume fixed filenames.

## ProofLoop Executor Mode

When used by `@executor`, this skill provides OpenSpec apply substrate only.

Executor may use this skill to:
- select or confirm the active change;
- run `openspec status --change "<name>" --json`;
- run `openspec instructions apply --change "<name>" --json`;
- read returned `contextFiles`;
- understand progress, state, remaining tasks, and dynamic apply instruction.

This skill does not own ProofLoop multi-subagent execution.

When used by `@executor`, do not:
- implement code directly;
- edit files directly;
- mark task checkboxes directly;
- ask the user directly;
- update planning artifacts directly;
- declare archive readiness.

If the selected change is ambiguous, artifacts are missing, or the apply substrate is blocked, return `Execution blocked` with the smallest blocker summary to Brain.

After apply substrate discovery, Executor follows `executor.md` for ProofLoop execution state sequencing.

## Output

```text
OpenSpec Apply Substrate

Change:
Schema:
State: active | blocked | all_done
Progress:
Context Files:
- <path>
Remaining Tasks:
- <task id / summary>
Dynamic Instruction:
- <summary>
Blocker:
- <only if blocked>
```
