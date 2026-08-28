---
name: proofloop-worker
description: Worker 行为与交接：当 Runtime dispatch packet 指定 Worker 时，按绑定 scope、Evidence 顺序和固定 `subagent` transport 完成一个 Task/repair/finalize。
---

# proofloop-worker

本 Skill 只规定跨 harness 的 Worker 行为和顺序。Contract 定义语义、字段、状态和错误码；
`references/worker-template.md` 定义 packet/result schema 与 Host-native `subagent` relay。Worker 不把本 Skill 当作 Runtime 授权。

## 触发与加载

- 收到 Runtime `DISPATCH_WORKER` 或 `mode: implement-task | recover-task | finalize-slice` Context：
  加载 `references/worker-template.md`，再按本 Skill 执行。
- 收到 taskless `mode: repair` Context：同样加载 Worker Template；repair history、root cause 和
  bounded failure scope 已由 Runtime/Brain 绑定。
- `subagent` 是唯一 Worker transport，在 Session 创建时固定并使用 Host-native relay；不能在 Session 中自动切换。

## Preflight

1. 读取 `AGENTS.md`、当前 Context、Manifest/Plan/Proof Index/Authority refs、Task/Slice Goal、PO、
   `execution_scope`、Risk Facts、snapshot 和前序 Receipt。
2. 确认 `context_digest`、`manifest_digest`、`plan_digest`、`snapshot_digest`、Task/Slice ID、
   `actionToken`、transport 和 scope 与 packet 完全一致；缺字段、过期或越界即 typed blocker。
3. `implement-task`/`recover-task` 必须有非空 root-bound `code_paths` 与 `test_paths`、唯一
   `plan_projection_path`、允许的 mutable projection 和 forbidden scope；`finalize-slice` 与 `repair`
   使用其 taskless/repair Contract，不自行附加权限。
4. 记录 baseline Git status/diff、已有 Evidence 和 tests；baseline 不是完成证明。
5. 按 packet 的 `required_skills` 精确加载 active Skills；若包含 `test-driven-development`，在该 Slice 的首次行为改动前加载并保持到 Slice 完成。

## Mode route

| mode | Worker 工作 | 允许交接 |
|---|---|---|
| `implement-task` | 对一个 Task 做最小实现与测试 | `TASK_COMPLETE` + Task Evidence + checkbox projection |
| `recover-task` | 读取现有 diff/Evidence/checkbox，完成或恢复同一 Task，不重复已验证实现 | `TASK_COMPLETE` 或 typed recovery |
| `finalize-slice` | 仅在该 Slice 所有 Task COMPLETE 后汇总 Slice Evidence 和 binding | `READY_FOR_CV`；不得带 task anchor |
| `repair` | 只修复 CV/diagnose 指定的 failure criterion、scope 和 counterexample | repair handoff + required evidence；由 Runtime 触发 fresh recheck |

未在 Runtime Context 中出现的 mode、跨 Task 批量实现和未由 Context 授权的文件都属于
`OWNER_MISMATCH`/`SCOPE_VIOLATION`，立即返回，不猜测兼容语义。

## implement/recover 顺序

1. **RED**：先运行 baseline/新增失败测试或其他 PO oracle，确认失败属于当前 Task。
2. **最小实现**：只编辑 `execution_scope.code_paths`，复用现有 seam/类型/依赖，不顺手重构。
3. **GREEN**：运行目标 test、必要回归 test、typecheck/build 和 scope/diff 检查；失败保留实际命令、
   exit code 和输出摘要。
4. **Evidence**：按 Worker Template 写 Task Evidence，包含 PO 结果、commands、actual result、
   changed files、test/seam/oracle validity、risk、regression 和 remaining unknowns；Evidence 先于 checkbox。
5. **Projection**：仅更新 Context 允许的 `tasks.md` checkbox/Worker Status；不改 immutable Plan、
   Manifest、Authority、Receipt 或其他 Slice projection。
6. **Result**：按 Template 发送一个绑定当前 Context 的 `TASK_COMPLETE`；等待 Runtime admission，
   不自行派发 CV 或下一 Task。

## finalize-slice 顺序

1. 从 Runtime Context 确认所有 Task COMPLETE、Evidence paths 存在且非空、当前 snapshot 和 Slice binding 未变。
2. 复核 Task Evidence 的闭环和 changed-file scope，生成/更新本 Slice Evidence；保留 concrete
   test/oracle 事实，不复制全局 Authority。
3. 返回 `READY_FOR_CV` 及 Template 要求的 Slice-level binding；不带 `task_id`/`task_ref`，不声称
   CV PASS、Commit 或 Integration 完成。

## repair 与 diagnose 顺序

1. 读取 CV finding、`repairs_cv_receipt_digest`、failed criterion、counterexample、repair scope、
   previous snapshot 和 recheck requirement；缺 binding 时返回 `RUNTIME_BLOCKER`。
2. 先复现 failure，再做最小修复；不得扩大到新的 Task、Goal、PO、Authority、Manifest 或 scope。
3. 运行 bounded repair test 和必要回归，记录 before/after；仅写入 Runtime `scope` 允许的 Evidence（若有），不更新 `tasks.md` checkbox、Plan 或其他 projection。
4. 发送 `mode: repair` handoff，不进入普通 Worker admission；Runtime `stage next` 负责置为
   `PENDING_RECHECK` 并派 fresh CV。CV/Contract/Goal/Seam/Authority/snapshot 变化时停止并要求
   full initial CV。
5. 多轮 repair/diagnose 的 history、root cause、round cap 和升级由
   `.agents/contracts/brain/multi-round-repair.md` 处理，不由 Worker 自行延长。

## Transport 与 Result
- `subagent` 是唯一 transport：通过 Host-native wrapper 回传同一 Template schema；禁止把 host callback 当作
  Receipt 或状态迁移。结果缺失、截断、重复或绑定错误时 fail closed。
- 每个结果只对应当前 `actionToken`/Context；结果字段、枚举、Evidence marker、digest 和错误码只读
  Worker Template/Contract，不在此文件复制第二份 schema。

## 完成标准与边界

Worker 完成标准按 `mode` 分别判定：
- `implement-task` / `recover-task`：`execution_scope.code_paths` 与 `test_paths` 中的实际 code/test 已完成，Task Evidence 已按 Template 非空落盘，且 Context 允许的 `tasks.md` checkbox/Worker Status projection 已更新。
- `finalize-slice`：当前 Slice 的完整 Slice Evidence 与 Slice-level binding 已落盘，并经固定 transport 返回 `READY_FOR_CV`；不要求新增 code/test，也不得虚构 Task-level code/test 或 projection。
- `repair`：bounded repair evidence/handoff 已按 Runtime 允许的 repair scope 落盘，并携带当前 `repairsCvReceiptDigest` 经固定 transport 发出；不要求或更新 `tasks.md` projection。
- 各 mode 的结果都必须可由 Brain/Runtime 重新读取；以下均不能单独算完成：Agent `idle`/`done`、模型摘要、checkbox、transport delivery、测试通过但无 Evidence，或声称已写 Receipt。

Worker 不调用 Runtime admission、不写 Manifest/Context/Receipt/Gate/Review 状态、不创建 Git boundary、
不提交 Git、不派发其他 Agent；需要权限、Authority、Plan、scope、环境或 Runtime 修复时返回 typed blocker。
