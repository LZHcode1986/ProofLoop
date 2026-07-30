# Executor Worker Dispatch Contract

Dispatches a Worker to implement, recover, finalize, repair, diagnose, or
resolve-conflict for exactly one Slice.

## Target Agent

- **Agent route:** `worker`

## Modes

| Mode | When to use |
|---|---|
| `implement-task` | New Slice ready for first Task, or continuation to next unchecked Task |
| `recover-task` | Worker session lost, need to verify and continue from unchecked Task |
| `finalize-slice` | All Tasks checked but Slice Evidence not finalized |
| `repair` | First CV REPAIR verdict; fix specific failure |
| `diagnose` | Second CV REPAIR verdict; root-cause diagnosis and fix (uses diagnose skill) |
| `resolve-conflict` | Mechanical merge conflict during integration |

## Allowed results per Mode

| Mode | Allowed results |
|---|---|
| `implement-task` | `TASK_COMPLETE` or blocker |
| `recover-task` | `TASK_COMPLETE`, `IMPLEMENTATION_DEFECT`, or blocker |
| `finalize-slice` | `READY_FOR_CV` or `IMPLEMENTATION_DEFECT` |
| `repair` | `READY_FOR_CV` or blocker |
| `diagnose` | `READY_FOR_CV` or blocker |
| `resolve-conflict` | `CONFLICT_RESOLVED` or `SEMANTIC_CONFLICT` |

## recover-task semantics

`recover-task` is a consistency closure for a persisted Evidence/checkbox
mismatch, not a second implementation flow. The Worker MUST:
1. Verify persisted implementation and Evidence files exist at the expected paths.
2. Read the Evidence and confirm the task checkbox state matches actual evidence.
3. If Evidence proves the task and the checkbox is unchecked → check only that
   box and return `TASK_COMPLETE`.
4. If the checkbox is checked but Evidence is missing or incomplete →
   reconstruct/verify the missing Evidence first, then retain the checkbox.
5. Do NOT rerun RED/GREEN for work that is already complete.
6. If implementation is genuinely missing → return `IMPLEMENTATION_DEFECT`.

## Worker packet fields

The Worker packet MUST include an ordered list of task IDs for the current slice
(enough to detect TASK_ORDER_MISMATCH):

- **Slice Task IDs** — ordered list of all task IDs in this slice (IDs only, no future content)
- **Current Task ID** — the single current task
- **Completed Task IDs** — list of task IDs already checked and evidenced
- **`previous_task_receipts`** — REQUIRED for every non-first Task packet. An ordered structured receipt is required for each previous completed Task, with all fields: `task_id`, `evidence_path`, `source_snapshot`, `current_snapshot`, and `result`. Completed Task IDs alone do not satisfy §6.3. Receipts contain no future task content.

Every Slice has one persisted per-Slice Evidence file. It contains the per-Task
Evidence, `## Current Slice Evidence`, and `## Current CV Status` (including the
latest CV receipt reference). Worker writes the Task and Slice Evidence sections;
Executor is the sole writer of `## Current CV Status`.

## Single Task Dispatch Rule

**Every Worker packet must contain exactly one current task.**

The Executor must NEVER send:

- Full tasks.md content
- Multiple current tasks
- Future task content
- Instructions for the Worker to select the next task

### DISPATCH_MISMATCH

If the Worker receives a packet that violates the single-task rule, it MUST
return `DISPATCH_MISMATCH` (not a plan gap or implementation defect):

```yaml
result: DISPATCH_MISMATCH
subtype: MULTIPLE_TASKS_SUPPLIED
slice_id: <id>
received_task_ids: [<list>]
expected: exactly_one_current_task
resume_action: redispatch_first_unchecked_task
```

If the Worker receives a task whose ID does not match the expected next task
in the slice task order:

```yaml
result: DISPATCH_MISMATCH
subtype: TASK_ORDER_MISMATCH
slice_id: <id>
received_task_id: <id>
expected_task_id: <id>
resume_action: reconcile_and_redispatch
```

`DISPATCH_MISMATCH` does NOT enter Brain. Executor re-reads `tasks.md` and
mechanically redispatches the correct task.

## Context Groups

### Base Slice Context (all Modes)

- **Slice ID**
- **Mode**
- **Slice Goal**
- **Observable Outcome**
- **Public Seam**
- **Seam Status**
- **Required Skills**
- **Authority Excerpts** — exact canonical type names, field names, state names,
  event names, and interface names. Preserve verbatim. Do not rewrite synonyms.
- **Dependency Output Summaries**
- **Manifest Digest**
- **Proof Obligations** (PO list)
- **PO → Test Requirements**
- **Risk Facts**
- **Mandatory Proof Profiles**
- **Minimum CV Level**
- **Source Snapshot**
- **Evidence Path** (from Manifest `evidence_path` for this slice)
- **Allowed Code Scope**
- **Forbidden Scope**
- **Stop Conditions**
- **Expected Result**

### Proof Plan (all Modes, conditional)

When Required Skills includes `test-driven-development`:

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

- **Current Task ID**
- **Current Task Goal**
- **Current Task Content** — exactly one task, not the full section
- **Slice Task IDs** — ordered list of every task ID in this Slice (IDs only)
- **Completed Task IDs** — list of task IDs already checked and evidenced
- **`previous_task_receipts`** — REQUIRED for every non-first Task packet. Each previous completed Task must have a structured receipt containing `task_id`, `evidence_path`, `source_snapshot`, `current_snapshot`, and `result`; IDs alone do not satisfy §6.3. The first Task packet does not require this field. No future task content may be included.
- **Previous Task Result Summary** (optional)
- **Relevant PO IDs** — PO IDs assigned to this task only

### Finalize Context (finalize-slice only)

- **PO coverage matrix**
- **Actual test identifiers**
- **RED/GREEN receipts** (from Task Evidence entries)
- **Full Slice verification** (all verification commands for the slice)
- **Current tree SHA**

### Repair Context (repair only)

- **Failure Source**: `CV` | `finalize-slice` | `recover-task`
- **Failed Criterion**
- **Concrete Reproduction or Counterexample**
- **Failure Signature**
- **Original Slice Packet**
- **Failed PO**
- **CV receipt** (path or reference)
- **Whether Contract changed**
- **Whether fresh Worker is required**

### Fresh recover-task packet (session loss before any CV failure)

When the Worker session is lost before any CV-failure receipt exists, the
Executor MUST construct a fresh packet from persisted facts using the same
structure as `buildRecoveryPacket`. The packet MUST include exactly these
fields; refs point to the current Slice Evidence unless otherwise noted:

```yaml
# List fields are required and may be empty.
mode: recover
completed_task_ids: [<task-id>]
task_evidence_refs:
  <completed-task-id>: <persisted-evidence-ref>
current_slice_evidence_ref: <persisted-evidence-ref>
current_task: <single-task-id>
current_code_snapshot: <source-snapshot>
```

The packet MUST NOT contain a `cv_failure_receipt` or CV failure-scope fields
(`failed_po_ids`, `counterexamples`, `required_recheck_scope`).  Recovery is a
consistency closure for persisted evidence/checkbox state, not a repair of a
known CV failure.  This packet matches `buildRecoveryPacket` in the runtime.

### Fresh repair packet (CV failure-driven)

When a repair or diagnose must run in a fresh Worker session driven by an
existing CV failure receipt, the Executor MUST construct a packet from
persisted facts using the same structure as `buildRepairPacket`. The packet
MUST include all of these fields:

```yaml
# completed_task_ids and task_evidence_refs may be empty only for initial
# recovery (pre-CV-failure).  For a REPAIR-driven packet, at least one of
# failed_po_ids, affected_task_ids, or counterexamples MUST be non-empty
# (actionable failure locator), and required_recheck_scope MUST be non-empty.
mode: repair
completed_task_ids: [<task-id>]
task_evidence_refs:
  <completed-task-id>: <persisted-evidence-ref>
current_slice_evidence_ref: <persisted-evidence-ref>
cv_failure_receipt:
  receipt_ref: <immutable-persisted-receipt-ref>
  verdict: <REPAIR | REPLAN | BLOCKED | ESCALATION_REQUIRED>
  failed_criterion: <string>
  failure_signature: <string>
failed_po_ids: [<po-id>]
affected_task_ids: [<task-id>]
counterexamples: [<counterexample>]
required_recheck_scope: [<scope-item>]
```

`completed_task_ids` and `task_evidence_refs` may be empty only for an initial
recovery packet (no CV failure yet). For a REPAIR-driven repair packet they
reflect tasks completed before the CV failure and MUST be non-empty when at
least one task was completed. `task_evidence_refs` must match `completed_task_ids`
exactly: each completed Task has one persisted evidence ref and no other Task may
appear. `cv_failure_receipt` must preserve the immutable CV failure receipt
together with its non-PASS verdict, failed criterion, and failure signature.
`affected_task_ids` is bound to the immutable CV failure receipt; it identifies
which tasks the failure covers and must not be broadened beyond the receipt's
scope. When the receipt verdict is REPAIR, `required_recheck_scope` MUST be
non-empty (§CvReceipt.superRefine), and at least one of `failed_po_ids`,
`affected_task_ids`, or `counterexamples` MUST be non-empty to provide an
actionable failure locator.

### Diagnose Context (diagnose only)

- **Previous CV Failures** (all failed criteria from prior attempts)
- **Previous Repair Attempts** (summary of what was tried)
- **Failure Signature**
- **Original Slice Packet**

### Conflict Context (resolve-conflict only)

- **Current Slice Goal**
- **Integrated Slice intent summaries**
- **Conflict description**
- **Relevant contracts**
- **Conflict Files**

## Packet envelope

All Modes share this envelope:

```yaml
Target Agent: worker
Contract Ref: .agents/contracts/executor/worker.md
Mode: <implement-task | recover-task | finalize-slice | repair | diagnose | resolve-conflict>
Slice ID: <id>
[Base Slice Context as specified above]
[Conditional groups as specified above]
Expected Result: <per Mode allowed results>
```

## Evidence Path

The `evidence_path` is sourced from the Manifest, not hardcoded. Worker reads
and writes evidence exclusively at the path specified in the packet.

Worker must only modify the Slice Evidence file at the given `evidence_path`.
It must NOT modify other slice evidence files or shared evidence sections. Worker
returns readiness/repair results but never writes or claims `READY_FOR_CV` or
`PENDING_RECHECK` in `## Current CV Status`; Executor is the sole status writer.

## Dispatch Mismatch Recovery

On receiving `DISPATCH_MISMATCH`, Executor:

1. Re-reads `tasks.md` and Manifest to determine the correct first unchecked task
2. Re-dispatches the Worker (continuation if session alive, fresh if lost)
3. Sends only the correct single current task
4. Does NOT route to Brain

## Runtime continuity

Runtime session continuity is owned by Executor. Session IDs/handles are runtime
relay data only and are never persisted in packets, tasks, Evidence, receipts,
manifests, progress, or Git history.

- If a usable Worker handle exists for the same Slice, Executor continues that
  Worker session.
- Continuation sends the new Mode and new Task through the runtime handle.
- If no handle exists, Executor creates a fresh Worker with the complete
  persisted state required by the selected Mode.
- Runtime handles are not Contract fields and must not be persisted.
- Worker never creates or selects its own continuation handle.
