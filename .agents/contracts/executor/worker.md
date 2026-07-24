# Executor Worker Dispatch Contract

Dispatches a Worker to implement, finalize, recover, repair, diagnose, or resolve-conflict for one Slice.

## Modes

| Mode | When to use |
|---|---|
| `implement` | New Slice ready for initial implementation |
| `finalize` | All Tasks checked but Evidence incomplete |
| `recover` | Worker context lost, need to verify and continue |
| `repair` | First CV FAIL, fix specific failure |
| `diagnose` | Second CV FAIL, root-cause diagnosis and fix |
| `resolve-conflict` | Merge conflict during integration |

## Allowed results per Mode

| Mode | Allowed results |
|---|---|
| implement | READY_FOR_CV or blocker |
| finalize | READY_FOR_CV or IMPLEMENTATION_DEFECT |
| recover | READY_FOR_CV, IMPLEMENTATION_DEFECT, or blocker |
| repair | READY_FOR_CV or blocker |
| diagnose | READY_FOR_CV or blocker |
| resolve-conflict | CONFLICT_RESOLVED or SEMANTIC_CONFLICT |

## Common fields

All Modes include:

- Slice ID
- Mode
- Slice Goal
- Observable Outcome
- Public Seam
- Authority Excerpts (refs)
- Dependency Output Summaries
- TDD Proof Plan
  - Primary Seam
  - Required Success Behaviors
  - Required Failure Behaviors
  - State Assertions
  - Mocks Allowed / Forbidden
  - Verification Commands
  - Proof Profiles
- Tasks
- Editable tasks.md Region
- Editable evidence.md Region
- Allowed Scope
- Forbidden Scope
- Stop Conditions
- Expected Result

## Mode-specific fields

### implement

No additional fields beyond common.

### finalize

Additional fields:
- Current Slice Packet (original)
- Current evidence.md Region

### recover

Additional fields:
- Current Slice Packet (original)
- Current tasks.md Region
- Current evidence.md Region
- Checked Tasks
- Unchecked Tasks
- Recent Diff
- Interruption Description

### repair

Additional fields:
- Failure Source: CV | finalize | recover
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
Mode: <implement | finalize | recover | repair | diagnose | resolve-conflict>
Slice ID: <same>
[Mode-specific fields as specified above]
Expected Result: <per Mode allowed results>
```

## Runtime continuity

Runtime session continuity is owned by Executor.

- If a usable Worker handle exists for the same Slice, Executor continues that Worker session.
- If no handle exists, Executor creates a fresh Worker with the complete persisted state required by the selected Mode.
- Runtime handles are not Contract fields and must not be persisted.
- Worker never creates or selects its own continuation handle.
