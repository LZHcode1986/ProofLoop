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

Rules:
- Worker receives only the Slice Packet, not the Stage Goal
- Worker must check off each Task immediately after implementation
- Worker must run full Slice TDD before writing Evidence
- Worker must overwrite Evidence (not append)

### finalize

Additional fields:
- Current Slice Packet (original)
- Current evidence.md Region

Rules:
- Worker runs the full Slice TDD suite
- Worker overwrites the Evidence section
- Worker does NOT modify Tasks or code
- Worker returns READY_FOR_CV

### recover

Additional fields:
- Current Slice Packet (original)
- Current tasks.md Region
- Current evidence.md Region
- Checked Tasks
- Unchecked Tasks
- Recent Diff
- Interruption Description

Rules:
- Recovery Worker checks checked Tasks against code reality
- Recovery Worker does NOT redo checked work by default
- Recovery Worker continues from first unchecked Task
- If checked Tasks are inconsistent with code, return BLOCKED

### repair

Additional fields:
- Failed CV criteria
- Concrete counterexample
- Failure signature
- Original Slice Packet

Rules:
- Worker fixes only the listed failure
- Worker runs full Slice TDD again
- Worker overwrites Evidence (does not append history)
- Tasks remain checked (CV FAIL does not uncheck)
- Worker returns READY_FOR_CV

### diagnose

Additional fields:
- Previous CV failures (initial + recheck #1)
- Previous repair attempts
- Failure signature
- Original Slice Packet
- Required Skills: `diagnose`

Rules:
1. Reproduce the failure
2. Find the minimum failure path
3. Distinguish symptoms from root cause
4. Check real production call chain
5. Check for workarounds
6. Explain why original test did not find the issue
7. Fix root cause
8. Add necessary regression proof
9. Update Evidence

### resolve-conflict

Additional fields:
- Current Slice Goal
- Integrated Slice intent summaries
- Conflict description
- Relevant contracts
- Conflict Files

Rules:
- Worker reads the current Slice Goal
- Worker reads the integrated Slice's intent summary
- Worker reads relevant contracts
- Worker preserves both intents
- Worker does not add authority-external behavior
- Worker runs affected tests
- If implementation changes, Worker updates Evidence

Conflict resolution ethics:
- Do NOT discard another Slice's behavior
- Do NOT accept one side entirely to avoid conflict
- Do NOT split code mechanically to avoid Git conflicts
- Do NOT skip tests
- Do NOT create new product semantics

## Packet shape templates

### implement

```
Target Agent: worker
Contract Ref: .agents/contracts/executor/worker.md
Mode: implement
Slice ID:
Slice Goal:
Observable Outcome:
Public Seam:
Authority Excerpts: <refs>
Dependency Output Summaries: <summaries>
TDD Proof Plan:
  Primary Seam:
  Required Success Behaviors:
  Required Failure Behaviors:
  State Assertions:
  Mocks Allowed:
  Mocks Forbidden:
  Verification Commands:
  Proof Profiles:
Tasks:
  - [ ] Sx-T1
  - [ ] Sx-T2
Editable tasks.md Region: <markers>
Editable evidence.md Region: <markers>
Allowed Scope: <paths>
Forbidden Scope: <paths>
Stop Conditions: <blocker types>
Expected Result: READY_FOR_CV | <blocker>
```

### finalize

```
Target Agent: worker
Contract Ref: .agents/contracts/executor/worker.md
Mode: finalize
Slice ID: <same>
Current Slice Packet: <original>
Current evidence.md Region: <markers>
Expected Result: READY_FOR_CV | BLOCKED
```

### recover

```
Target Agent: worker
Contract Ref: .agents/contracts/executor/worker.md
Mode: recover
Slice ID: <same>
Current Slice Packet: <original>
Current tasks.md Region: <markers>
Current evidence.md Region: <markers>
Checked Tasks: <list>
Unchecked Tasks: <list>
Recent Diff: <diff>
Interruption Description: <what happened>
Expected Result: READY_FOR_CV | BLOCKED | <blocker>
```

### repair

```
Target Agent: worker
Contract Ref: .agents/contracts/executor/worker.md
Mode: repair
Slice ID: <same>
Failed Criteria: <list>
Concrete Counterexample: <description>
Failure Signature: <signature>
Original Slice Packet: <original>
Expected Result: READY_FOR_CV | <blocker>
```

### diagnose

```
Target Agent: worker
Contract Ref: .agents/contracts/executor/worker.md
Mode: diagnose
Slice ID: <same>
Failed Attempts:
  - repair-1: <action, result>
  - recheck-1: <result>
Failure Signature: <signature>
Original Slice Packet: <original>
Required Skills: <diagnose>
Expected Result: READY_FOR_CV | <blocker>
```

### resolve-conflict

```
Target Agent: worker
Contract Ref: .agents/contracts/executor/worker.md
Mode: resolve-conflict
Slice ID: <same>
Current Slice Goal: <goal>
Integrated Slices: <list with intent summaries>
Conflict Files: <list>
Conflict Description: <description>
Relevant Contracts: <refs>
Expected Result: Conflict resolved | SEMANTIC_CONFLICT
```

## Rules

- Worker receives only the Slice Packet, not the Stage Goal
- Worker must check off each Task immediately after implementation (implement mode)
- Worker must run full Slice TDD before writing Evidence (implement mode)
- Worker must overwrite Evidence (not append)
- Tasks remain checked across repair cycles
- Recovery Worker verifies checked Tasks against code reality
