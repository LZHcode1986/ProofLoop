# Commit Boundary Dispatch Contract

This contract is self-contained.

Dispatch a Git boundary to Committer. The boundary type determines the commit scope and behavior.

## Use when

Any authoritative document change requires a Git boundary. The Committer creates the commit; Brain does not commit directly.

Conditional requirements per boundary type:

### stage-plan preconditions

- Stage Validator PASS
- Manifest compiled and stored at `.proofloop/manifests/<stage-id>.json`
- SPV PLAN_READY
- tasks.md, evidence.md, and manifest digest are consistent (SHA-256 of Manifest matches what is referenced in the boundary)
- Stage plan is on a clean branch with stable Git boundary

### stage-close preconditions

- Stage Gate PASS — verified Stage Gate Receipt exists and shows `verdict: PASS`
- Stage Reviewer ACCEPTED — Stage Review Receipt exists and shows accepted status
- Stage Gate Receipt path is valid and readable
- Stage Review Receipt path is valid and readable
- Integrated snapshot content matches receipts (receipt snapshot digest matches working tree state)
- evidence.md contains finalised Evidence for all Slices

## Boundary Type

| Boundary Type | When | Commit scope |
|---|---|---|
| `baseline-authority` | Seed or reset authority documents | `CONTEXT.md`, `PRD.md`, `tech-spec/*` |
| `stage-plan` | Planner stage plan approved | `delivery/stages/<stage>/*`, `.proofloop/manifests/<stage>.json` |
| `authority-update` | Brain updates authority after research/prototype | `tech-spec/*`, `CONTEXT.md`, `PRD.md`, `progress.md` |
| `prototype-checkpoint` | Prototype validation in isolated worktree | worktree-local — no production boundary |
| `stage-close` | Stage Review accepted by Brain | `delivery/stages/<stage>/*` — close boundary, `progress.md` summary |
| `direct-fix` | General direct fix complete | bounded scope per task |

Note: `slice-output` is dispatched by Executor, not Brain, and is not part of this contract.

## Required fields

- Boundary Type
- Description
- Changed Files

## Conditional fields by boundary type

| Boundary Type | Required additions |
|---|---|
| `prototype-checkpoint` | `prototype_id`, `worktree_path`, `expected_branch`, `no_push: true`, `no_merge: true` |
| `stage-plan` | `stage_id`, `manifest_digest` |
| `stage-close` | `stage_id`, `manifest_digest`, `stage_gate_receipt` (path), `stage_review_receipt` (path), `integrated_snapshot` (digest) |

## Expected results

Boundary closed with commit hash, or blocked with reason.

`stage-plan` output includes the compiled Manifest alongside tasks.md/evidence.md.

`stage-close` output includes final progress.md summary and confirmed receipt paths.

## Return codes

When blocked:

```yaml
route_code: RUNTIME_BLOCKER
subtype: COMMIT_BOUNDARY_FAILED
reason: <description>
suggested_owner: Brain
invalidation_scope: []
resume_target:
  owner: Committer
  phase: <phase>
  stage: <stage-id | none>
```

Precondition failure examples:

| Precondition failure | route_code | subtype |
|---|---|---|
| Validator not PASS | `PLAN_GAP` | `VALIDATION_INCOMPLETE` |
| Manifest missing or digest mismatch | `PLAN_GAP` | `MANIFEST_MISMATCH` |
| SPV not PLAN_READY | `PLAN_GAP` | `SPV_NOT_READY` |
| Stage Gate not PASS | `IMPLEMENTATION_DEFECT` | `STAGE_GATE_NOT_PASSED` |
| Stage Review not ACCEPTED | `PLAN_GAP` | `STAGE_REVIEW_NOT_ACCEPTED` |
| Receipt path invalid | `RUNTIME_BLOCKER` | `MISSING_RECEIPT` |
| Snapshot mismatch | `EVIDENCE_GAP` | `SNAPSHOT_MISMATCH` |
