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

## Common fields

All Modes include:

- Slice ID
- Mode
- Continuation / Task ID (when applicable)
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
- Failed CV criteria
- Concrete counterexample
- Failure signature
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
Expected Result: <per Mode>
```


