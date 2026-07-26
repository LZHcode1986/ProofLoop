# Executor Worker Dispatch Contract

Dispatches a Worker to implement, finalize, recover, repair, diagnose, or resolve-conflict for one Slice.

## Modes

| Mode | When to use |
|---|---|
| `implement-task` | New Slice ready for first Task, or continuation to next Task |
| `recover-task` | Worker context lost, need to verify and continue from unchecked Task |
| `finalize-slice` | All Tasks checked but Evidence incomplete or stale |
| `repair` | First CV FAIL, fix specific failure |
| `diagnose` | Second CV FAIL, root-cause diagnosis and fix |
| `resolve-conflict` | Merge conflict during integration |

## Allowed results per Mode

| Mode | Allowed results |
|---|---|
| implement-task | TASK_COMPLETE or blocker |
| recover-task | TASK_COMPLETE, IMPLEMENTATION_DEFECT, or blocker |
| finalize-slice | READY_FOR_CV or IMPLEMENTATION_DEFECT |
| repair | READY_FOR_CV or blocker |
| diagnose | READY_FOR_CV or blocker |
| resolve-conflict | CONFLICT_RESOLVED or SEMANTIC_CONFLICT |

recover-task only restores execution for the supplied Current Task.
It must not execute later Tasks or finalize the Slice.

## Common fields

All Modes include:

- Slice ID
- Mode
- Slice Goal
- Observable Outcome
- Public Seam
- Seam Status
- Required Skills
- Proof Plan
  - When Required Skills includes test-driven-development:
    - Primary Seam
    - Required Success Behaviors
    - Required Failure Behaviors
    - State Assertions
    - Persistence / Integration Assertions
    - Mocks Allowed / Forbidden
    - Verification Commands
    - Proof Profiles
  - Otherwise:
    - Verification Commands
    - Expected Results
    - Check Items
- Authority Excerpts (refs)
  Note: Authority Excerpts contain exact canonical type names, field names, state names, event names, and interface names. Executor must preserve these verbatim in the Worker Packet. Do not rewrite synonyms.
- Dependency Output Summaries
- Completed Task IDs
- Current Task ID
- Current Task Goal
- Current Task Content
- Editable tasks.md Region
- Editable evidence.md Region
- Allowed Scope
- Forbidden Scope
- Stop Conditions
- Expected Result

## Mode-specific fields

### implement-task

Additional fields:
- Current Task ID
- Current Task Goal
- Previous Task Result Summary

Expected Result: TASK_COMPLETE | blocker

### finalize-slice

Additional fields:
- All Completed Tasks
- Full Slice Verification Commands
- Required Proof Profiles
- Current tasks.md Region
- Current evidence.md Region

Expected Result: READY_FOR_CV | IMPLEMENTATION_DEFECT

### recover-task

Additional fields:
- Current Task ID
- Checked Tasks
- Current Diff
- Current Code State
- Interruption Description
- Current tasks.md Region
- Current evidence.md Region

Expected Result: TASK_COMPLETE | IMPLEMENTATION_DEFECT | blocker

### repair

Additional fields:
- Failure Source: CV | finalize-slice | recover-task
- Failed Criterion
- Concrete Reproduction or Counterexample
- Failure Signature
- Original Slice Packet

### diagnose

Additional fields:
- Previous CV failures (initial + recheck #1)
- Previous repair attempts
- Failure signature
- Original Slice Packet
- Required Skills: `diagnose`

### resolve-conflict

Additional fields:
- Current Slice Goal
- Integrated Slice intent summaries
- Conflict description
- Relevant contracts
- Conflict Files

## Packet envelope

All Modes share this envelope:

```
Target Agent: worker
Contract Ref: .agents/contracts/executor/worker.md
Mode: <implement-task | recover-task | finalize-slice | repair | diagnose | resolve-conflict>
Slice ID: <same>
[Common fields as specified above]
[Mode-specific fields as specified above]
Expected Result: <per Mode allowed results>
```

## Runtime continuity

Runtime session continuity is owned by Executor.

- If a usable Worker handle exists for the same Slice, Executor continues that Worker session.
- Continuation sends the new Mode and new Task through the runtime handle.
- If no handle exists, Executor creates a fresh Worker with the complete persisted state required by the selected Mode.
- Runtime handles are not Contract fields and must not be persisted.
- Worker never creates or selects its own continuation handle.
