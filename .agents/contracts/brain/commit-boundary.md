# Commit Boundary Dispatch Contract

This contract is self-contained.

Dispatch a Git boundary to Committer. The boundary type determines the commit scope and behavior.

## Use when

Any authoritative document change requires a Git boundary. The Committer creates the commit; Brain does not commit directly.

Conditional requirements per boundary type:

### stage-plan preconditions

- Stage Validator PASS
- Manifest compiled and stored at `.proofloop/manifests/<stage-id>.json`
- Manifest-declared Slice Evidence skeletons are complete; manifest digest is consistent (SHA-256 of Manifest matches what is referenced in the boundary)
- Every `implement-task` in the candidate Plan declares immutable, root-relative
  `execution_scope` with non-empty `code_paths` and `test_paths`; no implement task relies
  on an Evidence-only default.
- Candidate Plan, candidate input and Evidence skeletons are in the final tracked Git boundary;
  the canonical worktree is clean and the boundary HEAD is stable
- **SPV PLAN_READY is not a precondition of this Git boundary**. Fresh SPV runs after this
  commit against the resulting HEAD; Stage Plan admission remains Runtime-owned and follows SPV.

### stage-close preconditions

- Stage Gate PASS — verified Stage Gate Receipt exists and shows `verdict: PASS`
- Stage Reviewer ACCEPTED — Stage Review Receipt exists and shows accepted status
- Stage Gate Receipt path is valid and readable
- Stage Review Receipt path is valid and readable
- Integrated snapshot content matches receipts (receipt snapshot digest matches working tree state)
- Manifest-declared Slice Evidence is finalised for all Slices

### artifact-archive preconditions

- The packet identifies an exact pre-admission planning artifact set invalidated by a
  Validator/SPV finding; no admitted Stage Plan or execution Receipt may depend on it.
- Every source is tracked, root-bound, content-complete and unchanged at the expected
  HEAD. Evidence sources must be pristine skeletons (`Not yet captured`, CV `NOT_RUN`,
  no Receipt) and the packet must state their old Manifest digest.
- Source and destination are explicit paths inside the same Stage directory. The
  destination is digest-qualified, absent, and must not be an active Manifest-declared
  Evidence path.
- The worktree is clean. Committer performs a Git-native rename only; it never edits,
  copies, deletes or recreates artifact content and never calls Runtime initialization.

## Boundary Type

| Boundary Type | When | Commit scope |
|---|---|---|
| `baseline-authority` | Seed or reset authority documents | `CONTEXT.md`, `PRD.md`, `tech-spec/*` |
| `stage-plan` | Final candidate Plan/Evidence Git boundary before fresh SPV | `delivery/stages/<stage>/*`; `.proofloop/manifests/<stage>.json` remains Runtime-owned and is not force-added when ignored |
| `artifact-archive` | Preserve invalidated pristine pre-admission planning artifacts before Runtime regenerates canonical paths | Exact packet-declared source→digest-qualified destination paths inside `delivery/stages/<stage>/` |
| `authority-update` | Brain updates authority after user decision, research or prototype | `tech-spec/*`, `CONTEXT.md`, `PRD.md`, `progress.md`, approved user-requirement reference documents explicitly listed in the dispatch packet |
| `workflow-contract-update` | Brain aligns active Skills/Contracts and role-specific read-only verifier permissions with confirmed global route semantics | Explicit `.agents/skills/*`, `.agents/contracts/*` and `.opencode/agents/*` paths listed in the dispatch packet |
| `prototype-checkpoint` | Prototype validation in isolated worktree | worktree-local — no production boundary |
| `stage-close` | Stage Review accepted by Brain | `delivery/stages/<stage>/*` — close boundary, `progress.md` summary |
| `direct-fix` | General direct fix complete | bounded scope per task |
| `runtime-repair` | User-confirmed Runtime/Host repair under an explicit recovery Contract | exact Runtime/Host implementation and test paths only; no Stage Receipt or authority artifact |

Note: `slice-output` is dispatched by Executor, not Brain, and is not part of this contract.

## Boundary command workflows

Committer must use these path-scoped commands in order. Replace placeholders with the
exact paths in the dispatch packet; do not broaden them. The universal command rules
and forbidden commands are defined by the Committer Agent. If an unrelated dirty file
cannot be separated with the permitted commands, return `BLOCKED` instead of changing it.

### Common preflight and postflight

```text
git status --short --untracked-files=all
git diff --check
git diff --name-status -- <allowed paths>
```

After staging and after the commit:

```text
git diff --cached --name-only
git diff --cached --check
git status --short --untracked-files=all
```

When a complete, explicitly listed recovery file must be parked before a boundary:

```text
git stash push --include-untracked -m "recovery: <boundary>" -- <complete paths>
git stash list
git stash show --stat stash@{0}
```

Only a verified matching stash may later be restored:

```text
git stash apply stash@{0}
```

Never stash a file containing mixed implementation and recovery hunks.

### baseline-authority

```text
git add -- CONTEXT.md PRD.md progress.md tech-spec/
git diff --cached --name-status
git diff --cached --check
git commit -m "baseline-authority: initial authority documents"
git status --short --untracked-files=all
```

### stage-plan

```text
git add -- delivery/stages/<stage-id>/
git diff --cached --name-only
git diff --cached --check
git commit -m "stage-plan: <stage-id>"
git status --short --untracked-files=all
```

`.proofloop/manifests/<stage-id>.json` remains Runtime-owned unless the packet
explicitly authorizes a tracked file at that path.

### artifact-archive

```text
git mv -- <exact source path> <exact digest-qualified destination path>
git diff --summary -- <source path> <destination path>
git diff --check -- <source path> <destination path>
git add -- <source path> <destination path>
git diff --cached --summary
git diff --cached --check
git commit -m "artifact-archive: <stage-id> <old-manifest-digest>"
git status --short --untracked-files=all
```

For a directory archive, source and destination parent paths must already satisfy the
packet boundary; one exact `git mv` may rename the whole directory so no filesystem
`mkdir`, copy, delete or content-edit command is needed. Cached diff must show only
renames with unchanged blob identities; otherwise stop and return `BLOCKED`.

### authority-update

```text
git add -- tech-spec/ CONTEXT.md PRD.md progress.md <explicit approved requirement-reference paths>
git diff --cached --name-status
git diff --cached --check
git commit -m "authority-update: <description>"
git status --short --untracked-files=all
```

### workflow-contract-update

```text
git add -- <explicit active Skill/Contract/role-config paths>
git diff --cached --name-status
git diff --cached --check
git commit -m "workflow-contract-update: <description>"
git status --short --untracked-files=all
```

### stage-close

```text
git add -- delivery/stages/<stage-id>/ progress.md
git diff --cached --name-only
git diff --cached --check
git commit -m "stage-close: <stage-id>"
git status --short --untracked-files=all
```

Runtime Receipt files are included only when the packet explicitly declares the
canonical committed Receipt boundary; Committer never creates or edits them.

### direct-fix

```text
git add -- <fix files>
git diff --cached --name-status
git diff --cached --check
git commit -m "direct-fix: <description>"
git status --short --untracked-files=all
```

### runtime-repair

```text
git add -- <exact Runtime/Host repair files>
git diff --cached --name-status
git diff --cached --check
git commit -m "runtime-repair: <description>"
git status --short --untracked-files=all
```

`runtime-repair` is allowed only when the dispatch packet names the governing recovery
Contract, exact stage/recovery boundary, exact changed files, pre-commit HEAD and test
evidence. Committer must not stage Stage Plan, tasks projection, Evidence, Manifest,
Context, Receipt, authority or agent-configuration files. The commit is a Runtime/Host
repair Git boundary, not a Slice Commit; Runtime must later require fresh SPV/Stage Plan
admission after the HEAD change.

### prototype-checkpoint

```text
git add -- <prototype files>
git diff --cached --name-status
git diff --cached --check
git commit -m "prototype-checkpoint: <description>"
git status --short --untracked-files=all
```

## Required fields

- Boundary Type
- Description
- Changed Files

## Conditional fields by boundary type

| Boundary Type | Required additions |
|---|---|
| `prototype-checkpoint` | `prototype_id`, `worktree_path`, `expected_branch`, `no_push: true`, `no_merge: true` |
| `stage-plan` | `stage_id`, `manifest_digest` |
| `artifact-archive` | `stage_id`, `invalidation_finding`, `old_manifest_digest`, exact `source_paths`, exact `destination_paths`, `expected_head` |
| `stage-close` | `stage_id`, `manifest_digest`, `stage_gate_receipt` (path), `stage_review_receipt` (path), `integrated_snapshot` (digest) |
| `runtime-repair` | `stage_id`, `recovery_contract`, exact `changed_files`, `pre_commit_head`, `test_evidence` |

## Expected results

Boundary closed with commit hash, or blocked with reason.

`stage-plan` output includes the compiled Manifest alongside tasks.md and per-Slice Evidence declared in the Manifest.

`artifact-archive` output includes the commit hash and exact rename/blob-identity facts;
it never claims that replacement Evidence exists or that planning can advance.

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
| Stage Gate not PASS | `IMPLEMENTATION_DEFECT` | `STAGE_GATE_NOT_PASSED` |
| Stage Review not ACCEPTED | `PLAN_GAP` | `STAGE_REVIEW_NOT_ACCEPTED` |
| Receipt path invalid | `RUNTIME_BLOCKER` | `MISSING_RECEIPT` |
| Snapshot mismatch | `EVIDENCE_GAP` | `SNAPSHOT_MISMATCH` |
