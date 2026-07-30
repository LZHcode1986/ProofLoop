# Executor Code Verifier Dispatch Contract

Dispatches adversarial verification to Code Verifier (CV).

## Target Agent

- **Agent route:** `code-verifier`
- **Agent name:** Code Verifier
- **Abbreviation:** CV

## Verification Type

| Type | When to use |
|---|---|
| `initial` | Worker has completed a Slice, finalized evidence, and Executor set current CV Status to READY_FOR_CV |
| `recheck` | Worker has repaired after CV REPAIR verdict and Executor set current CV Status to PENDING_RECHECK |

## Required fields (all types)

- **Slice ID**
- **Verification Type** (`initial` | `recheck`)
- **CV Level** (`lite` | `standard` | `enhanced`)
- **Contract Ref** — `.agents/contracts/executor/code-verifier.md`
- **Level Profile Ref** — `.agents/contracts/executor/cv-levels/<level>.md`
- **Manifest Digest**
- **Snapshot** (content digest at time of verification)
- **Slice Goal**
- **Public Seam**
- **Covered Tasks** (list of task IDs with status)
- **Proof Plan**
- **Proof Obligations** (PO list with criteria)
- **Risk Facts**
- **Mandatory Profiles**
- **PO Coverage Matrix**
- **Receipt-backed scope outcome**
- **Actual Diff**
- **Changed Code / Tests** (file paths)
- **Verification Commands**
- **Authority Excerpts**
- **Out of Scope** (forbidden change boundaries)
- **Evidence Location** (Manifest `evidence_path` for this slice)

## Recheck additional fields

- **Previous Failed Criterion** (singular — one specific criterion)
- **Concrete Counterexample** (reproducible failure from previous CV)
- **Failure Signature** (deterministic hash of the failure)
- **Repair Diff** (the changes made to address the failure)
- **Required Regression Scope** (scope items that must be rechecked)

**Mandatory initial CV on structural change**: If the Contract, Goal, Seam, PO,
or Authority has changed since the previous verification, the Executor MUST
dispatch an initial CV (not a narrow recheck). A narrow recheck is only valid
when the only changes are the repair itself and the previous failure context.

## Allowed results

```
PASS
REPAIR
REPLAN
BLOCKED
ESCALATION_REQUIRED
```

## Verdict routing rules

- **PASS** — No concrete counterexample invalidated the Slice claim; all audit
  domains satisfactory for the applied CV level. Routes to Committer.
- **REPAIR** — Specific, concrete defects found that the Worker must fix.
  Implementation does not satisfy the Plan but the Plan is sound. Failure
  includes `failed_po_ids`, `affected_task_ids`, `failed_criterion`, and
  `counterexamples`. Routes to Worker repair.
- **REPLAN** — The Slice Plan is fundamentally wrong (seam selection, missing
  POs, scope violation, invalid decomposition). Routes to Brain / Planner.
- **BLOCKED** — Required verification cannot proceed due to missing context,
  runtime dependency, or contract field. Routes to Brain.
- **ESCALATION_REQUIRED** — Risk exceeds CV scope (security, safety, compliance,
  human judgment required). Routes to Brain / human review.

## Output schema

```yaml
slice_id: <string>
snapshot: <content digest>
cv_level: lite | standard | enhanced
verification_type: initial | recheck
verdict: PASS | REPAIR | REPLAN | BLOCKED | ESCALATION_REQUIRED
failed_po_ids: [<string>]
affected_task_ids: [<string>]
invalid_tests: [<string>]
counterexamples: [<string>]
scope_violations: [<string>]
failed_criterion: <string>
failure_signature: <string>
required_recheck_scope: [<string>]
```

## Evidence interaction

Code Verifier is **read-only** (`edit: deny`). It does not:

- Edit evidence, tasks, or code
- Write CV receipts
- Update CV Status sections
- Create commits or scratch files

**Permitted commands for verification** (allowed by CV packet permissions):
- `python -m pytest <args>` — run Python tests (no `python -c` arbitrary code)
- `npm test <args>`, `npm run test <args>`, `npm run build <args>`, `npm run lint <args>` — run npm scripts
- `npx tsc --noEmit <args>` — TypeScript type checking
- `make test <args>` — run tests via Makefile
- File reading (`cat`, `type`, `rg`, `diff`, `git diff`, `git show`, `git log`) — for examining code and evidence

**Forbidden commands:**
- `git add`, `git commit`, `git push` — no writes
- Any write edits to evidence, tasks, or source files
- `chmod` that would enable write access
- `python -c` arbitrary code execution (restricted by explicit allowlist)

Executor persists the CV verdict via:
1. `node .agents/runtime/dist/receipt-writer.js cv '<json with data and optional receiptRoot>'`
   — writes an immutable CV Receipt JSON to `.proofloop/receipts/cv/<stage-id>/<slice-id>/`
2. `node .agents/runtime/dist/update-current-cv-status.js --json '<json>'`
   — updates the `## Current CV Status` section in the Slice Evidence file,
   using the immutable receipt as authorization.

**Only Executor updates Current CV Status.** Worker never writes or claims
`READY_FOR_CV` or `PENDING_RECHECK` in the `## Current CV Status` section. Worker
repairs Evidence and returns a readiness/repair result; Executor persists the
status before dispatching CV.

## Fresh Session rule

Session IDs are runtime relay information only; they are not Contract fields and
must not be persisted in manifests, tasks, Evidence, receipts, progress, or Git
history.

- Every verification cycle (`initial` or `recheck`) starts with a **fresh**
  Code Verifier Session.
- A fresh CV Session is required after Worker repair or diagnose.
- Continuation of an existing CV Session is only allowed when ALL of the
  following hold:
  - The interruption was a pure runtime interruption
  - The original CV Session inputs are completely unchanged
  - The independent refutation ordering is still known and trustworthy
- If any condition is not met, dispatch a fresh initial CV.

## Runtime Interruption Recovery

### Step 1: status-and-resume

Use when the original CV Session failed to return a final verdict due to pure
runtime interruption. Only valid when all Fresh Session rule conditions hold.

Required continuation fields:

- Continuation Type: `status-and-resume`
- Previous Result: `no final verdict due to interruption`
- Changed Inputs: `none`

The CV must return one of:

1. **VERIFICATION_RESUMABLE** — verification state is reliable and can continue
   - Interruption Reason
   - Current Verification Checkpoint
   - Completed Verification Work
   - State Reliability: `reliable`
   - Whether Worker Evidence Was Read
   - Resume Safety: `safe`

2. **VERIFICATION_RESTART_REQUIRED** — cannot safely resume
   - Interruption Reason
   - Current Verification Checkpoint
   - State Reliability: `reliable` | `unreliable`
   - Why Resume Is Unsafe

VERIFICATION_RESUMABLE and VERIFICATION_RESTART_REQUIRED are not CV verdicts.
They are allowed only as responses to status-and-resume when continuation
conditions are met.

### Step 2: resume-verification

Use only after receiving VERIFICATION_RESUMABLE.

Required continuation fields:

- Continuation Type: `resume-verification`
- Previous Result: `VERIFICATION_RESUMABLE`
- Required Next Action: resume from the reported checkpoint and return a final
  verdict

The CV must return one of:

1. PASS
2. REPAIR
3. REPLAN
4. BLOCKED
5. ESCALATION_REQUIRED
6. VERIFICATION_RESTART_REQUIRED

### Checkpoint values

Current Verification Checkpoint:

- `independent-refutation-not-started`
- `independent-refutation-running`
- `independent-refutation-fixed`
- `evidence-comparison-running`
- `final-verdict-pending`

CV must not return intermediate checkpoints during normal verification.
Checkpoint information is returned only when Executor explicitly sends a
status-and-resume continuation after an interruption.

## Level-specific counterexample rule

The Base flow requires independent refutation for `standard` and `enhanced`.
`lite` performs the mechanical checks in `cv-levels/lite.md` and must not invent
an independent-counterexample obligation. This level boundary does not weaken
any Standard or Enhanced requirement.

## Recheck scope

On recheck, CV verifies ONLY:

- Previous failed criterion
- Repair changes (the diff between previous snapshot and current snapshot)
- Required regression scope items

It must NOT restart full Slice verification unless the repair changed the Slice
boundary, authority refs, or verification context.

If orchestration session is lost and previous CV result is unavailable, rerun
initial CV on current code and evidence.
