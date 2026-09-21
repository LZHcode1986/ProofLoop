# Integration 控制面 Contract

本 Contract 定义 Brain 向 Runtime `proofloop integration apply` CLI 发送的机械 Integration 事务请求，以及调用前后 Brain 必须重读的 Git 事实。Integration 是把一个 CV `PASS` 且 durable canonical candidate ref current 的 Slice candidate 集成进目标 Git evidence worktree 的**独立专用机械事务**：`NORMAL` 集成进当前 Stage 工作树并形成 normal `INTEGRATED`；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 集成只形成 Git + Git-tracked Plan/evidence，后者只能在 isolated maintenance evidence worktree 执行，不写 MES、不产生 normal `INTEGRATED`/`CLEANED` 或 Stage/terminal state。Integration 不复用/伪装成 `boundary close`，也不引入 Gate、Review、Manifest、Receipt、admission、next-action 或第二状态机语义。

Brain owns the judgment that a candidate is ready to integrate（CV `PASS` + durable canonical candidate ref current）and owns recovery decisions.
Runtime owns the deterministic Git transaction.
Brain and every Agent MUST NOT integrate by running `git merge`, `git cherry-pick`, `git apply`, `git add`, or `git commit` directly — the Integration transaction is executed only through the public CLI.

本 Contract 与 `.agents/contracts/brain/commit-boundary.md` 是同级但独立的机械事务契约：`boundary close` 保持现有独立 Git 事务（含 `slice-output` 等全部既有边界类型）不变；Integration 是等价专用机械事务，但不属于 `boundary close` 的边界类型，不折叠进 `close` 操作。

## Use when

CV `PASS` + durable canonical candidate ref current（`READY_TO_INTEGRATE`）后，Brain 决定把该 candidate 集成：`NORMAL` 进入当前 Stage 工作树；`PRE_MES_BOOTSTRAP`（首个 MES-persistence Stage）或 `MES_MAINTENANCE` 进入对应 isolated Git evidence worktree，均由本 Contract 执行机械事务。完整上游顺序由 `.agents/skills/proofloop-execute/SKILL.md` 定义，本 Contract 只消费其产物、不复制上游流程：

```text
CV basis：`NORMAL` = live Slice worktree basis；`PRE_MES_BOOTSTRAP` = candidate/accepted Git Plan + baseline/current Git basis + Worker Subagent transport evidence；`MES_MAINTENANCE` = recovery candidate + live maintenance Git basis + frozen/forensic/audit binding
READY_TO_INTEGRATE = CV PASS + durable canonical candidate ref current
→ Brain 调用 proofloop integration apply（目标 worktree 由 mode-specific binding 固定）→ mode-specific Git result
→ `NORMAL`: INTEGRATED → cleanup（CLEANUP_PENDING → CLEANED）
→ `PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE`: Git evidence integration → evidence cleanup；maintenance 后进入 evidence-only maintenance Review，不形成 MES 状态
```

- durable canonical candidate ref（`proofloop-<stage>-<slice>`）由 post-CV-PASS `slice-output` 一次性建立；Integration 只消费该 durable candidate 的补丁，应用进 mode-specific target worktree 并建立 integration commit；`NORMAL` 可形成 `INTEGRATED`，`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 只形成 Git evidence，且只集成 CV 实际通过的同一候选成果。
- **CV PASS ≠ Integration completion**：CV `PASS` 只支持进入 Integration；`NORMAL` Integration 成功才形成 `INTEGRATED`，`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 成功只形成对应 Git evidence。
- Integration 是独立步骤，不与 CV、boundary close 或 cleanup 合并。

## 与 boundary close 的关系

- `boundary close` 保持现有独立 Git 事务，覆盖其全部既有 boundary types（含 `slice-output`），语义不变更。
- Integration **不是** `boundary close` 的一个 boundary type：不新增 `boundary_type`，不折叠进 `close` 操作，不共享除机械 Git 事实之外的业务语义。
- 公共 CLI 入口独立：`node packages/runtime/dist/cli/proofloop.js integration apply --json '<closed request>'`。
- Phase A 只定义流程与机械契约；Runtime `integration apply` handler 由 Phase B 实现，本 Contract 不声称其已实现。

## Integration request（closed）

```json
{
  "domain": "integration",
  "operation": "apply",
  "expected_head": "<40-char sha>",
  "expected_branch": "<branch>",
  "expected_worktree": "<root-relative-target-worktree>",
  "stage": "S<digits>",
  "execution_mode": "NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE",
  "slice": "<slice-id>",
  "candidate_ref": "<candidate Git ref>",
  "candidate_base_ref": "<candidate base Git ref>",
  "paths": ["<declared exact root-relative changed paths>"],
  "maintenance_binding": {
    "frozen_snapshot_ref": "<root-relative-frozen-MES-snapshot>",
    "frozen_snapshot_sha256": "<exact-source-sha256>",
    "frozen_fact_count": "<exact-source-fact-count>",
    "forensic_ref": "<root-relative-immutable-incident-ref>",
    "forensic_sha256": "<exact-incident-sha256>",
    "audit_ref": "<root-relative-read-only-audit-ref>",
    "audit_sha256": "<exact-audit-sha256>"
  }
}
```

- 闭合 schema：unknown field、path escape、protected path 与意外 HEAD/branch 一律拒绝（`RUNTIME.INPUT_INVALID` / `INTEGRATION.*`）。
- `execution_mode`、`expected_worktree` 与 conditional `maintenance_binding` 是闭集字段；除 `maintenance_binding` 在非 maintenance mode 被省略外，不存在其他可选字段。
- `execution_mode` 必须与上游 CV/Plan binding 一致；`NORMAL` 目标为当前 Stage worktree，`PRE_MES_BOOTSTRAP` 仅首个 MES-persistence Stage，`MES_MAINTENANCE` 仅 S06 hard-freeze 的 isolated maintenance evidence worktree。
- `expected_worktree` 必须等于当前 target worktree 的 root-relative identity；maintenance 不得指向 frozen S06 main/C worktree。
- `maintenance_binding` 仅在 `MES_MAINTENANCE` 出现，且 frozen snapshot/forensic/audit refs 与 digest/count 必须 exact-match；其他 mode 发送该字段一律拒绝。
- `expected_head` 是当前 mode-specific target worktree 的 pinned HEAD：mismatch 在任何 Git 写之前失败。
- `paths` 必须与 candidate 补丁（`candidate_base_ref..candidate_ref`）的精确变更路径集合一致：既不能声明补丁外的路径（scope widening），也不能遗漏补丁内的路径。
- `candidate_ref` 与 `candidate_base_ref` 都是 Git ref（Phase B 按 Runtime 的 ref 解析规则解析；durable canonical candidate ref 形如 `proofloop-<stage>-<slice>`，由 post-CV-PASS `slice-output` 建立）。

## Preconditions

Brain 在调用 CLI 前必须重读并确认：

- canonical Trust Root、expected branch、expected target worktree 与 mode-specific target；
- 当前 HEAD == `expected_head`，且 index 为空、target worktree 干净（`NORMAL` 目标 = 当前 Stage 工作树；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 目标 = 对应 isolated evidence worktree；maintenance 不触碰 frozen S06 main/C worktree）；
- stage/slice 与 candidate binding 明确（来自 `READY_TO_INTEGRATE` 的 CV `PASS` + durable canonical candidate ref）；
- 无未决 scope decision。

## 机械校验与事务顺序

CLI 按确定顺序执行；任何校验失败都在 Git 写之前 fail closed（零写）：

1. **前置检查**：canonical root、expected branch、`expected_worktree`、HEAD（== `expected_head`）、空 index、target worktree clean。
2. **candidate 形态**：`candidate_ref` 存在并解析为恰好一个 commit；`candidate_base_ref` 存在、解析为 commit，且是 `candidate_ref` 的祖先（补丁良构）。
3. **base 关系（stale-base）**：`candidate_base_ref` 必须是当前 mode-specific target worktree HEAD 的祖先（含相等）。允许 stale-base：base 是 target HEAD 祖先且 candidate 补丁可无冲突应用时，**不要求 fast-forward-only**；若 base 不是 target HEAD 祖先 → fail closed（`INTEGRATION.BASE_NOT_ANCESTOR`）。
4. **scope 与 protected path**：补丁变更路径集合 == 声明 `paths`；全部 root-bound、duplicate-free；无 `.git/**` / `.proofloop/**` / control path（最低保护集与 commit-boundary 相同；Phase B 可扩展系统保护集，但不能缩小）；无 scope widening。
5. **diff 检查**：`git diff --check` 通过。
6. **冲突预检**：candidate 补丁（`candidate_base_ref..candidate_ref`）对当前 HEAD 树的 three-way 应用检查必须无冲突；任何 genuine conflict → `INTEGRATION.CONFLICT`，此时**没有任何 Git 写发生**，HEAD/index/worktree 保持调用前状态。CLI 从不部分提交、从不静默跳过。
7. **应用与提交**：全部检查通过后，把补丁应用到 index + worktree（确定性单次 staged apply），复核 staged 集合 == 声明 `paths` 且 `diff --check` 通过，然后创建 canonical integration commit：

   `integration: <stage-id>-<slice-id>`

   （Phase B 在 Runtime canonical commit-message types 中注册 `integration`，与 `slice-output` 同级；消息格式不得重新设计。）
8. **post-commit 验证**：复核 target worktree 的 HEAD、branch、index、worktree、changed-files 与 `diff --check`；candidate ref 不被删除（保持可追溯）。
## Result handoff

成功结果是 Git 事实，不是业务 admission。CLI 返回结构化结果：

```json
{
  "execution_mode": "NORMAL | PRE_MES_BOOTSTRAP | MES_MAINTENANCE",
  "expected_worktree": "<root-relative-target-worktree>",
  "pre_integration_head": "<40-char sha>",
  "commit_sha": "<40-char sha>",
  "commit_message": "integration: <stage-id>-<slice-id>",
  "changed_files": [],
  "candidate_ref": "<candidate Git ref>",
  "candidate_base_ref": "<candidate base Git ref>",
  "dirty_after": []
}
```
对 `MES_MAINTENANCE`，CLI result 的 `execution_mode`/`expected_worktree` 只标识机械目标；Brain 必须把它与原 maintenance binding、CV PASS、candidate ref 和 fresh Git facts exact-match 后，才接纳为 evidence。

Brain 必须：

1. 把结果与 fresh-re-read 的 Git 事实核对（`git status`、`git diff`、`git diff --cached`、HEAD、changed-files）；
2. 对 `NORMAL` 把 `commit_sha`、`changed_files`、`candidate_ref` / `candidate_base_ref` 交给 MES transaction layer materialize 对应 normal Integration facts；对 `PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 仅写入 Git + Git-tracked Plan/evidence，maintenance 不写 MES、不产生 `INTEGRATED`/`CLEANED` 或任何 Stage/terminal fact；
3. `NORMAL` 从当前 MES status + Skill 继续；`PRE_MES_BOOTSTRAP` / `MES_MAINTENANCE` 从 Git + Plan/evidence（maintenance 另含 frozen/forensic/audit tuple）继续，不从 Receipt 链或 derived next action 继续。

## Recovery 与返回码

Integration 错误 fail closed，携带 `INTEGRATION.*` 代码；Brain 处理任何 `INTEGRATION.*` 都必须重读当前 durable Git 事实后路由恢复决策，不猜测回滚：

| 代码 | 触发 | 状态影响 |
|---|---|---|
| `HEAD_MISMATCH` | 当前 HEAD != `expected_head` | 零写 |
| `BRANCH_MISMATCH` | 当前 branch != `expected_branch` | 零写 |
| `INDEX_NOT_EMPTY` | index 非空 | 零写 |
| `DIRTY_WORKTREE` | worktree 不干净 | 零写 |
| `CANDIDATE_REF_INVALID` | candidate ref 缺失 / 不是 commit | 零写 |
| `CANDIDATE_BASE_INVALID` | base 缺失 / 不是 commit / 不是 candidate 祖先 | 零写 |
| `BASE_NOT_ANCESTOR` | base 不是当前 mode-specific target worktree HEAD 祖先 | 零写 |
| `SCOPE_VIOLATION` | 声明路径与补丁不一致 / 非 root-bound / protected path / scope widening | 零写 |
| `DIFF_INVALID` | `git diff --check` 失败 | 零写 |
| `CONFLICT` | genuine conflict（three-way 预检失败） | 零写；HEAD/index/worktree 保持调用前 |
| `COMMIT_FAILED` | staging 后 hook/commit 失败 | 不自动 reset/unstage；部分 staged index 是要 inspect 的事实，不是 reset 指令 |
| `POST_COMMIT_INVALID` | post-commit 复核失败 | 保持已写事实供 Brain 复核 |

- 纯 Runtime 中断后，只有 HEAD、index、worktree 与 changed-file set 字节不变时才可原样 retry；其他变化需要 fresh request + fresh Runtime facts。
- candidate ref 的生命周期（保留/清理）是独立 Brain 决定，不属于本事务；本事务不删除 candidate ref。

## Prohibited actions

- Brain/Agent 直接运行 `git merge` / `git cherry-pick` / `git apply` / `git add` / `git commit` 来集成；
- 把 Integration 折叠进 `boundary close`（不新增 boundary type，不改 `close` 语义）；
- 引入 Gate / Review / Manifest / Receipt / admission / next-action / 第二状态机语义；
- 把 `dirty_after`、checkbox、progress 或 agent narrative 当作 `INTEGRATED` / admission 事实；
- 声称 Phase B / Runtime `integration apply` 已实现（本 Contract 只定义流程与机械契约）。
