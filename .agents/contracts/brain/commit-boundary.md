# Git Boundary CLI Contract

本 Contract 定义 Brain 向 Runtime `proofloop boundary close` CLI 发送的机械 Git 边界请求，以及调用前后 Brain 必须重读的 Git 事实。它只描述机械 root/path/index/dirty/allowed scope/commit/worktree 语义；不引入 Gate、Review、Manifest、Receipt 或 admission 业务前置。

Brain owns the judgment that a boundary is ready and owns recovery decisions.
Runtime owns the deterministic Git transaction. Brain and every Agent MUST NOT
establish a write Git boundary by running `git add`, `git mv`, or `git commit`
directly. The ONE explicit exception is `artifact-archive`: Brain pre-executes
the exact `git mv` (the pure rename) so that the CLI only validates the
already-staged rename and commits it; no other Agent may run any write Git
command.

For `artifact-archive`, Brain also owns WHAT is archived and WHY:
the CLI never interprets the archive's business rationale or credential — it
validates ONLY mechanical Git facts (source/destination/stage/path/HEAD/
index/blob-mode).

## Use when

Use this contract whenever an authorized change must become a Git commit.
Current Runtime CLI surface: the only active domain/operation is
`boundary close` (all legacy business-control domains were removed — see
`packages/runtime/src/cli/proofloop.ts` header). Boundary types:

- `baseline-authority` — seed authority documents;
- `stage-plan` — close a candidate Plan (+ canonical Project Stage Map) boundary before fresh SPV;
- `artifact-archive` — commit a Brain-pre-executed exact rename (purely mechanical; no business rationale);
- `authority-update` — commit an approved authority update;
- `workflow-contract-update` — commit explicitly listed Skill/Contract/agent-config alignment;
- `prototype-checkpoint` — commit an isolated Prototype checkpoint;
- `stage-close` — close an accepted Stage boundary (mechanical only);
- `direct-fix` — commit a bounded General fix;
- `runtime-repair` — commit an explicitly authorized Runtime/Host repair;
- `slice-output` — post-final-CV-PASS candidate freeze：把最终 CV `PASS` 且仍 current 的 Slice worktree 内容机械固定为 candidate commit，并建立/确认 durable canonical candidate ref（`proofloop-<stage>-<slice>`；mechanical Git commit; no admission consumer）。


Integration 不是本 Contract 的边界类型：把一个 CV `PASS` 且 durable canonical candidate ref current 的 Slice candidate 集成进当前 Stage 工作树是独立的专用机械事务，定义在 `.agents/contracts/brain/integration.md`（公共入口 `proofloop integration apply`）。`boundary close` 的全部既有边界类型（含 `slice-output`）语义保持不变；本 Contract 不新增 Integration boundary type，也不把 Integration 折叠进 `close` 操作。
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
  "paths": ["<explicit root-relative paths>"],
  "other_slice_declared_files": ["<slice-output only: other-Slice declared dirty paths>"],
  "tolerated_paths": ["<ordinary-boundary exact dirty files to leave uncommitted>"],
  "description": "<single-line description>"
}
```

Only fields applicable to the selected boundary type are sent. The CLI rejects
unknown fields, path escapes, protected `.git/**`/`.proofloop/**` paths, and an
unexpected HEAD/branch. Ordinary boundaries also require an initially empty
index; `artifact-archive` is the sole exception, allowing exactly one already
staged exact pure rename (validated before commit).

The digest/path fields are type-scoped and closed:

- `other_slice_declared_files` — `slice-output` ONLY. The other-Slice
  declared dirty paths (tolerance scope only): they may remain dirty in an
  interleaved worktree but are NEVER selected, staged or committed by this
  boundary (see the Slice isolation rules below). Rejected for every other
  boundary type.
- `tolerated_paths` — ordinary-boundary exact-file tolerance. Each path is
  root-relative, duplicate-free, non-protected, and must be dirty when the
  transaction starts. It is admitted to the strict dirty scope but is never
  selected, staged, or committed; the result reports the same sorted paths.
  It is rejected for `slice-output`, which uses `other_slice_declared_files`.
- The retired `manifest_digest` / `cv_receipt_digest` request fields are
  GONE from the closed schema; the retired artifact-archive digest request
  field is GONE as well. Sending any of them is rejected as unknown fields
  (`RUNTIME.INPUT_INVALID`). They are not replaced.

For `slice-output`, Brain MUST send `stage`, `slice` and `expected_head` (the
current HEAD is pinned so a mismatch fails before any Git write).
The boundary establishes or confirms the durable canonical candidate ref
(`proofloop-<stage>-<slice>`) in one freeze of the final CV-passed worktree
content: ref absent → create; ref already points to the same commit →
idempotent; ref already points to a DIFFERENT commit → refuse overwrite
(fail closed, typed recovery blocker — never force-update, delete-and-
recreate, or port via `direct-fix`).

Slice isolation semantics (P0 interleaved worktree):

- `paths` is the current Slice COMMITTABLE scope — exactly the Work Packet
  allowed scope;
- `other_slice_declared_files` is the TOLERANCE scope — other Slices'
  declared dirty paths that may remain in the worktree but are NEVER
  selected, staged or committed by this boundary;
- every `paths` / `other_slice_declared_files` entry is canonical,
  root-bound and never protected; each list is duplicate-free; the two lists
  must be mutually NON-OVERLAPPING — a prefix overlap fails closed with
  `BOUNDARY.SLICE_POLICY_INVALID` before any Git write;
- the strict dirty gate tolerates `paths` ∪ `other_slice_declared_files`
  and commits exactly `paths`; remaining other-Slice dirt is reported
  through `dirty_after`.

There is no Manifest, Evidence, Receipt, CV digest or admission prerequisite.

## Preconditions

Brain must re-read and establish, before invoking the CLI:

- canonical Trust Root and expected branch;
- current HEAD and an empty index (except `artifact-archive`, where Brain has already staged the single exact rename);
- the selected boundary's exact mechanical scope and no unresolved scope decision;
- for `slice-output`: `expected_head`, `stage`, `slice`, the Work Packet
  committable `paths` and (when other Slices have declared dirty output)
  `other_slice_declared_files`；该 boundary 的调用前置（post-final-CV-PASS freeze、Brain 已 fresh-read current worktree diff）由 `.agents/skills/proofloop-execute/SKILL.md` 上游保证，本 Contract 只做机械校验，不复制 Execute 流程。
- `slice-output` 在 `MES_MAINTENANCE` 上游只固化 isolated maintenance Git evidence；candidate commit/ref 不产生 MES Git fact、不进入 normal `READY_TO_INTEGRATE`/`INTEGRATED` 状态，后续 mode-specific Integration/maintenance Review 仍须由 Brain 以 recovery binding 复核。
- for `artifact-archive`: exactly one tracked source and one absent
  destination inside the same Stage directory, with the
  `git mv` already staged by Brain.

### Boundary-specific mechanical preconditions

- `stage-plan`: candidate Plan 与 Planner 产出/更新的 Project Stage Map（确切路径为 `delivery/project-stage-map.md`）位于同一原子 tracked Git boundary，以保证 candidate Plan 与引用的 Map entry 共享同一 candidate Git basis；SPV `PLAN_READY`
  不属于本次提交前置条件，必须在 boundary 完成后对新 HEAD fresh 执行。
  该 boundary 是记录 candidate Plan 及对应 Project Stage Map 的机械 Git 提交：推进 HEAD 记录相同 candidate
  blob（包含 candidate Plan 与 candidate Map entry）且语义 Planning 输入基础未变时不单独使 Planner continuation 失效（Planner
  currentness 见 `.agents/contracts/brain/agent-lifecycle.md` §5.2）；Stage/
  Authority/candidate/code-reality/branch/trust-root/scope 真实变化仍使 binding
  失效。其机械范围严格限定于当前 Stage 目录 `delivery/stages/<stage-id>/` 及确切规范 Map 路径 `delivery/project-stage-map.md`；Map 唯一 writer 仍唯有 Planner，Brain 保持纯机械边界归属，不引入新 phase、fact、Gate 或 Receipt。SPV 的 exact candidate Plan/Git tuple 严格性与 Plan revision 后 fresh
  full initial 要求不受影响（见 lifecycle §5.2）。
  When unrelated dirty Stage artifacts must be preserved, Brain may list their exact
  root-relative files in `tolerated_paths`; those files pass the strict gate but
  are excluded from the candidate commit and remain visible in `dirty_after`.
- `stage-close`: 机械 Git 关闭；无 Gate/Review/Receipt/Manifest 业务前置。
- `artifact-archive`: Brain 决定归档的 artifact、时机与理由（Brain owns
  the archive judgment），并预执行精确 `git mv`；CLI 不判断归档理由或
  credential。CLI 只做纯机械的 pre-staged exact rename 校验：source
  tracked 且 pre-commit HEAD 未改变、destination 缺失、blob/mode 保留、
  路径 root-bound 且在同一 Stage 目录。
- `authority-update` / `workflow-contract-update`: Brain 已取得相应批准，并提供
  完整、精确、无歧义的 root-relative path set；不得把边界 CLI 当作 authority 或
  contract 语义判断者。
- `prototype-checkpoint`: 使用指定 Prototype worktree 与 expected branch；
  no-push、no-merge 约束由 Brain 保持，CLI 只建立本地边界。
- `runtime-repair`: packet 必须声明 governing recovery Contract、exact repair
  paths、pre-commit HEAD 和 test evidence；这是 Runtime/Host repair boundary，
  不是 Slice Commit，也不得包含 Stage、Receipt、Authority 或 Agent configuration。

Strict dirty gate: BEFORE any Git write (and before the CLI resolves the
commit path set), every actual dirty/untracked path must belong to the
selected boundary scope or be listed in `tolerated_paths`. A scope-external dirty
path — including an outside-only worktree where the declared/prefix scope has no
hits — fails closed with `BOUNDARY.SCOPE_VIOLATION` (never mis-reported as
`NO_CHANGES`) and leaves HEAD and the index unchanged; the CLI never resets,
unstages, or stashes. Explicit tolerated files remain dirty and are NEVER
selected/staged/committed; they are reported in the boundary result. For
`slice-output`, the current Slice committable paths plus the other-Slice declared
files are tolerated in the worktree, but other-Slice files are NEVER committed.

## Scope table

| Boundary Type | Scope rule |
|---|---|
| `baseline-authority` | `CONTEXT.md`, `PRD.md`, `tech-spec/*`, `progress.md` |
| `stage-plan` | dirty paths under `delivery/stages/<stage-id>/` and the exact canonical Project Stage Map path `delivery/project-stage-map.md`; exact Brain-declared `tolerated_paths` may remain dirty but are never committed |
| `artifact-archive` | exactly the two requested source/destination paths inside the same `delivery/stages/<stage-id>/`; Brain pre-executes the exact `git mv`; the CLI validates the already-staged pure rename (source tracked at pre-commit HEAD, destination absent, blob/mode preserved) and commits it with the stable message `artifact-archive: <stage-id>` |
| `authority-update` | explicit paths under approved authority roots |
| `workflow-contract-update` | explicit paths under `.agents/skills`, `.agents/contracts`, `.pi/agents/*.md + .pi/subagents.json`, `.opencode/agents` and `.pi/extensions` (no arbitrary `.pi` files) |
| `prototype-checkpoint` | explicit Prototype worktree paths with an expected branch |
| `stage-close` | dirty paths under `delivery/stages/<stage-id>/` and `progress.md` |
| `direct-fix` | explicit task-bounded paths |
| `runtime-repair` | explicit paths, excluding Stage/Receipt/Authority/agent configuration roots |
| `slice-output` | Work Packet path policy: `paths` is the committable scope; `other_slice_declared_files` is the tolerated-but-never-committable scope (overlapping prefixes fail `BOUNDARY.SLICE_POLICY_INVALID`); system-protected paths are always forbidden |

## CLI transaction

Brain invokes the CLI through the single public entry:

```text
node packages/runtime/dist/cli/proofloop.js boundary close --json '<closed request>'
```

The exact CLI argument encoding comes from this Contract and the current Runtime
CLI source (dispatcher/parser and operation-handler validation; the boundary
adapter is `packages/runtime/src/cli/proofloop-boundary.ts`, git mechanics in
`packages/runtime/src/git-boundary.ts`). The public `--help` currently exposes
only global usage/domain-list output, not operation-specific fields or closed
schemas, so it is not the operation-contract authority. Brain must not construct
a parallel Git command sequence. The CLI performs, in one transaction:

1. canonical root, HEAD, branch, index, status and request checks;
2. boundary-specific scope derivation;
3. `diff --check` and exact staging; for `artifact-archive`, validation of the Brain-staged exact rename (no `git mv` by the CLI);
4. staged-set and cached-diff verification;
5. the canonical Git commit message and `git commit`;
6. post-commit HEAD and changed-file verification;
7. a structured result containing `pre_commit_head`, `commit_sha`,
   `commit_message`, `changed_files` and `dirty_after`.
  `tolerated_paths` (the exact dirty files left uncommitted).

The CLI never stashes, resets, restores, rebases, merges, pushes, edits
artifact content, or writes a Receipt. In particular, a hook/commit failure
after staging does not trigger an implicit reset or unstage. Brain must
re-read `git status`, `git diff`, `git diff --cached`, HEAD and the CLI result
before choosing recovery.

## Result handoff

A successful boundary result is a Git fact, not business admission. Brain must:

1. verify the result against the freshly re-read Git facts;
   `tolerated_paths` is supporting mechanical evidence and is never a committable scope.
2. 对 `NORMAL` 把 `commit_sha`、`changed_files` 和 `dirty_after` 作为 boundary-result semantic event 交给 MES transaction layer materialize；对 `PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 仅记入 Git + Git-tracked Plan/evidence，不写 MES；
3. continue to the next action from the current MES status + Skill (not from a
   Receipt chain or a derived Primary Next Action).

## Recovery and return codes

Boundary errors are fail-closed and carry a `BOUNDARY.*` code. Brain handles
`HEAD_MISMATCH`, `INDEX_NOT_EMPTY`, `SCOPE_VIOLATION`, `DIFF_INVALID`,
`COMMIT_FAILED`, `POST_COMMIT_INVALID` and policy failures by re-reading the
current durable state and routing a recovery decision; it must not guess a
rollback. A partially staged index is a fact to inspect, not an instruction to
reset.

For `slice-output`, a `POST_COMMIT_INVALID` whose cause is specifically a
canonical candidate ref (`proofloop-<stage>-<slice>`) establishment/confirmation
failure is a typed recovery stop: the candidate commit is already durable and
is PRESERVED, it never enters `READY_TO_INTEGRATE`, and recovery must not
re-run the full boundary request, force-update or delete-and-recreate the ref,
or port via `direct-fix`. There is no public ref-only recovery seam, so no
automatic ref-only recovery is claimed — Brain re-reads the durable Git facts
(commit present, ref absent or mismatched) and routes a typed recovery
decision. Any OTHER post-commit `POST_COMMIT_INVALID` for `slice-output` (e.g.
the committed changed-file set being empty or containing a protected path, a
committed-path drift from the validated boundary, or a dirty-after detection
failure) is not a ref failure and follows the general re-read/recovery
semantics above.

After a pure Runtime interruption, the same request may be retried only when
HEAD, index, worktree and changed-file set are byte-for-byte unchanged. Any
other interruption or input change requires a fresh request and fresh Runtime
facts.

## Prohibited actions

- Direct write Git commands from Worker, CV, Reviewer, Prototype or any Agent
  other than the single `artifact-archive` exception where Brain pre-executes
  the exact `git mv` rename;
- `git add .`, broad staging, implicit path expansion or a second scope policy;
- treating `dirty_after`, checkbox state, progress text or agent narrative as
  admission, Gate, Receipt or Manifest fact;
- introducing Gate/Review/Manifest/Receipt/admission semantics into this
  contract — it is mechanical root/path/index/dirty/allowed scope/commit/worktree only.
