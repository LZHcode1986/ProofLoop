# Executor Worker Dispatch Contract

Dispatches a Worker to implement, finalize, recover, repair, diagnose, or resolve-conflict for one Slice.

## Modes

| Mode | When to use |
|---|---|
| `implement-task` | New Slice ready for first Task, or continuation to next Task |
| `recover-task` | Worker context lost, need to verify and continue from unchecked Task |
| `finalize-slice` | All Tasks checked but Evidence incomplete or stale |
| `repair` | First SCV FAIL, fix specific failure |
| `diagnose` | Second SCV FAIL, root-cause diagnosis and fix |
| `resolve-conflict` | Merge conflict during integration |

## Allowed results per Mode

| Mode | Allowed results |
|---|---|
| implement-task | TASK_COMPLETE or blocker |
| recover-task | TASK_COMPLETE, IMPLEMENTATION_DEFECT, or blocker |
| finalize-slice | READY_FOR_SCV or IMPLEMENTATION_DEFECT |
| repair | READY_FOR_SCV or blocker |
| diagnose | READY_FOR_SCV or blocker |
| resolve-conflict | CONFLICT_RESOLVED or SEMANTIC_CONFLICT |

recover-task only restores execution for the supplied Current Task.
It must not execute later Tasks or finalize the Slice.

## Context Groups

### Base Slice Context (all Modes)

- Slice ID
- Mode
- Slice Goal
- Observable Outcome
- Public Seam
- Seam Status
- Required Skills
- Authority Excerpts (refs)
  Note: Authority Excerpts contain exact canonical type names, field names, state names, event names, and interface names. Executor must preserve these verbatim in the Worker Packet. Do not rewrite synonyms.
- Dependency Output Summaries
- Manifest Digest
- Proof Obligations (PO list)
- PO → Test Requirements
- Risk Facts
- Mandatory Proof Profiles
- Minimum SCV Level
- Source Snapshot
- Editable tasks.md Region
- Editable evidence.md Region
- Allowed Code Scope
- Forbidden Scope
- Stop Conditions
- Expected Result

### Proof Plan (all Modes, conditional)

When Required Skills includes test-driven-development:
- Primary Seam
- Required Success Behaviors
- Required Failure Behaviors
- State Assertions
- Persistence / Integration Assertions
- Mocks Allowed / Forbidden
- Verification Commands
- Proof Profiles

Otherwise:
- Verification Commands
- Expected Results
- Check Items

### Task Context (implement-task and recover-task only)

- Current Task ID
- Current Task Goal
- Current Task Content
- Completed Task IDs
- Previous Task Result Summary (optional)
- Relevant PO IDs
- Required RED/GREEN closure for this Task

### Finalize Context (finalize-slice only)

- PO coverage matrix
- Actual test identifiers
- RED/GREEN receipts
- Full Slice verification
- Current tree SHA

### Repair Context (repair only)

- Failure Source: SCV | finalize-slice | recover-task
- Failed Criterion
- Concrete Reproduction or Counterexample
- Failure Signature
- Original Slice Packet
- Failed PO
- SCV receipt
- Whether Contract changed
- Whether fresh Worker is required

### Diagnose Context (diagnose only)

- Previous SCV Failures
- Previous Repair Attempts
- Failure Signature
- Original Slice Packet

### Conflict Context (resolve-conflict only)

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
[Base Slice Context as specified above]
[Conditional groups as specified above]
Expected Result: <per Mode allowed results>
```

## Runtime continuity

Runtime session continuity is owned by Executor.

- If a usable Worker handle exists for the same Slice, Executor continues that Worker session.
- Continuation sends the new Mode and new Task through the runtime handle.
- If no handle exists, Executor creates a fresh Worker with the complete persisted state required by the selected Mode.
- Runtime handles are not Contract fields and must not be persisted.
- Worker never creates or selects its own continuation handle.
