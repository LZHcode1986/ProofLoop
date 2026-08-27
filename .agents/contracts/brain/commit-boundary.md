# Git Boundary CLI Contract

This contract is self-contained. It defines the request that Brain sends to the
Runtime `proofloop boundary close` CLI and the facts that Brain must re-read
around the call.

Brain owns the judgment that a boundary is ready and owns recovery decisions.
Runtime owns the deterministic Git transaction and all Runtime Receipt
admission. Brain and every Agent MUST NOT establish a write Git boundary by
running `git add`, `git mv`, or `git commit` directly. The ONE explicit
exception is `artifact-archive`: Brain pre-executes the exact `git mv` (the
pure rename) so that the CLI only validates the already-staged rename and
commits it; no other Agent may run any write Git command.


## Use when

Use this contract whenever an authorized change must become a Git commit:

- `baseline-authority` — seed authority documents;
- `stage-plan` — close the candidate Plan/Evidence boundary before fresh SPV;
- `artifact-archive` — preserve an exact invalidated planning artifact rename;
- `authority-update` — commit an approved authority update;
- `workflow-contract-update` — commit explicitly listed Skill/Contract/agent-config alignment;
- `prototype-checkpoint` — commit an isolated Prototype checkpoint;
- `stage-close` — close an accepted Stage;
- `direct-fix` — commit a bounded General fix;
- `runtime-repair` — commit an explicitly authorized Runtime/Host repair;
- `slice-output` — close a CV-passed Slice boundary before Slice Commit admission.

The Runtime `stage admit-slice-commit` consumer remains the sole writer of the
`SLICE_COMMIT` Receipt. The compatibility directory
`.proofloop/receipts/committer/` and its `committerReceiptDir()` name are not
renamed by this contract.

## Boundary request

The request is a closed object sent to the public Runtime CLI:

```json
{
  "domain": "boundary",
  "operation": "close",
  "boundary_type": "<Boundary Type>",
  "expected_head": "<40-char sha>",
  "expected_branch": "<branch>",
  "stage": "S<digits>",
  "slice": "<slice-id>",
  "manifest_digest": "<sha256>",
  "cv_receipt_digest": "<sha256>",
  "old_manifest_digest": "<sha256>",
  "paths": ["<explicit root-relative paths>"],
  "description": "<single-line description>"
}
```

Only fields applicable to the selected boundary type are sent. The CLI rejects
unknown fields, path escapes, protected `.git/**`/`.proofloop/**` paths, and an
unexpected HEAD/branch. Ordinary boundaries also require an initially empty
index; `artifact-archive` is the sole exception, allowing exactly one already
staged exact pure rename (validated before commit).

For `slice-output`, Brain MUST send `stage`, `slice`, `cv_receipt_digest` and
`expected_head` (the current HEAD is pinned so a mismatch fails before any Git
write); `manifest_digest` is also sent when available. It does not supply a
second scope authority through `paths`. Runtime loads the current Manifest,
Stage Plan/SPV, Worker chain and CV chain, then derives the shared Slice Commit
policy. The CLI validates the policy before and after the commit.

## Preconditions

Brain must re-read and establish, before invoking the CLI:

- canonical Trust Root and expected branch;
- current HEAD and an empty index (except `artifact-archive`, where Brain has already staged the single exact rename);
- the selected boundary's exact scope and no unresolved scope decision;
- the applicable Manifest/Plan/Evidence/Receipt bindings;
- for `slice-output`: admitted Worker completion facts, finalized Evidence,
  latest CV PASS, matching `cv_receipt_digest`, and a current Runtime policy;
- for `stage-close`: Stage Gate PASS and Stage Review ACCEPTED;
- for `artifact-archive`: exactly one tracked source and one absent,
  digest-qualified destination inside the same Stage directory.

### Boundary-specific semantic preconditions

- `stage-plan`: Validator PASS；Manifest 已由 Runtime 编译并存储，所有 Manifest-declared Slice Evidence skeleton 完整且 digest 一致；每个 `implement-task` 都有非空、不可变、root-relative `execution_scope.code_paths` 与 `test_paths`；candidate Plan、candidate input 和 Evidence skeleton 位于最终 tracked Git boundary。`manifest_digest` 必填且必须等于 Runtime 持久化 Manifest 的实际 digest（CLI 在写操作前校验）；SPV `PLAN_READY` 不属于本次提交前置条件，必须在 boundary 完成后对新 HEAD fresh 执行。
- `stage-close`: Stage Gate PASS、Stage Reviewer ACCEPTED、对应 Receipt 路径可读且语义有效、integrated snapshot 与 Receipt 一致，并且所有 Manifest-declared Slice Evidence 已 finalized。CLI 在写操作前做强校验（只读，不写 Receipt）：Gate tip 为 GATE_PASS 且其 snapshot_digest 精确等于当前 integrated HEAD；Review tip 为 ACCEPTED 且其 snapshot_digest 精确等于当前 HEAD 并绑定当前 Gate tip digest；已 archived 的 Stage 一律 fail-closed 拒绝再次 close；每个 Manifest-declared Slice Evidence 通过 `isSliceEvidenceFinalized`（经 no-follow 打开 fd 读取内容）校验为非 skeleton/placeholder（`*None*` 占位行视为未 finalized 并拒绝）。
- `artifact-archive`: packet 必须证明待归档 artifact 是 Validator/SPV 使其失效的、admission 前的 pristine planning artifact；没有 admitted Stage Plan 或执行 Receipt 依赖它；source 已 tracked 且在 expected HEAD 未改变，destination 缺失、带 old Manifest digest，且不是 active Manifest-declared Evidence path。
- `authority-update` / `workflow-contract-update`: Brain 已取得相应批准，并提供完整、精确、无歧义的 root-relative path set；不得把边界 CLI 当作 authority 或 contract 语义判断者。
- `prototype-checkpoint`: 使用指定 Prototype worktree 与 expected branch；no-push、no-merge 约束由 Brain 保持，CLI 只建立本地边界。
- `runtime-repair`: packet 必须声明 governing recovery Contract、exact repair paths、pre-commit HEAD 和 test evidence；这是 Runtime/Host repair boundary，不是 Slice Commit，也不得包含 Stage、Receipt、Authority 或 Agent configuration。

Strict dirty gate: BEFORE any Git write (and before the CLI resolves the
commit path set), every actual dirty/untracked path must belong to the
selected boundary's tolerated scope. A scope-external dirty path — including
an outside-only worktree where the declared/prefix scope has no hits — fails
closed with `BOUNDARY.SCOPE_VIOLATION` (never mis-reported as `NO_CHANGES`)
and leaves HEAD and the index unchanged; the CLI never resets, unstages, or
stashes. For `slice-output`, the current Slice committable paths plus the
other-Slice declared dirty files are tolerated in the worktree, but other-Slice
files are NEVER committed by this boundary (they remain dirty and are reported
through `dirty_after`).

## Scope table

| Boundary Type | Scope rule |
|---|---|
| `baseline-authority` | `CONTEXT.md`, `PRD.md`, `tech-spec/*`, `progress.md` |
| `stage-plan` | dirty paths under `delivery/stages/<stage-id>/` |
| `artifact-archive` | exactly the two requested source/destination paths; Brain pre-executes the exact `git mv`; the CLI validates the already-staged pure rename and commits it |
| `authority-update` | explicit paths under approved authority roots |
| `workflow-contract-update` | explicit paths under `.agents/skills`, `.agents/contracts`, `.opencode/agents`, `.pi/brain-workflow.md` and active `.pi/agents` (no arbitrary `.pi` files) |
| `prototype-checkpoint` | explicit Prototype worktree paths with an expected branch |
| `stage-close` | dirty paths under `delivery/stages/<stage-id>/` and `progress.md` |
| `direct-fix` | explicit task-bounded paths |
| `runtime-repair` | explicit paths, excluding Stage/Receipt/Authority/agent configuration roots |
| `slice-output` | Runtime-derived Slice policy: current Slice execution scope only (other-Slice declared dirty files are tolerated but NEVER committable); system-protected paths are always forbidden |

## CLI transaction

Brain invokes the CLI through the single public entry, for example:

```text
node packages/runtime/dist/cli/proofloop.js boundary close --json '<closed request>'
```

The exact CLI argument encoding comes from the Runtime `--help` contract; Brain
must not construct a parallel Git command sequence. The CLI performs, in one
transaction:

1. canonical root, HEAD, branch, index, status and request checks;
2. boundary-specific scope derivation;
3. `diff --check` and exact staging; for `artifact-archive`, validation of the Brain-staged exact rename (no `git mv` by the CLI);
4. staged-set and cached-diff verification;
5. the canonical Git commit message and `git commit`;
6. post-commit HEAD and changed-file verification;
7. a structured result containing `pre_commit_head`, `commit_sha`,
   `commit_message`, `changed_files` and `dirty_after`.

The CLI never stashes, resets, restores, rebases, merges, pushes, edits
artifact content, or writes a Receipt. In particular, a hook/commit failure
after staging does not trigger an implicit reset or unstage. Brain must
re-read `git status`, `git diff`, `git diff --cached`, HEAD and the CLI result
before choosing recovery.

## Result handoff

A successful boundary result is not itself Runtime admission. Brain must:

1. verify the result against the freshly re-read Git facts;
2. for `slice-output`, send only the structured `commit_sha`,
   `cv_receipt_digest`, stage and slice tuple to
   `proofloop stage admit-slice-commit`;
3. wait for Runtime admission and re-read the persisted Receipt chain;
4. continue to Integration/Gate/Review only from the new Runtime Primary Next
   Action.

Runtime Receipt paths, schemas and admission keys remain the authoritative
facts. Progress snapshots, checkbox projections and Agent narratives cannot
authorize a boundary or complete admission.

## Recovery and return codes

Boundary errors are fail-closed and carry a `BOUNDARY.*` code. Brain handles
`HEAD_MISMATCH`, `INDEX_NOT_EMPTY`, `SCOPE_VIOLATION`, `DIFF_INVALID`,
`COMMIT_FAILED`, `POST_COMMIT_INVALID` and policy failures by re-reading the
current durable state and routing a recovery decision; it must not guess a
rollback. A partially staged index is a fact to inspect, not an instruction to
reset.

After a pure Runtime interruption, the same request may be retried only when
HEAD, index, worktree and changed-file set are byte-for-byte unchanged. Any
other interruption or input change requires a fresh request and fresh Runtime
facts.

## Prohibited actions

- Direct write Git commands from Worker, CV, Reviewer, Prototype or any Agent
  other than the single `artifact-archive` exception where Brain pre-executes
  the exact `git mv` rename;
- `git add .`, broad staging, implicit path expansion or a second scope policy;
- manual `SLICE_COMMIT`, Integration, Gate or Review Receipt creation;
- replacing the compatibility Receipt category as part of this refactor;
- treating `dirty_after`, checkbox state or progress text as admission.
