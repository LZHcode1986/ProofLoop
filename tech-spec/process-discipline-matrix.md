# Process Discipline Matrix — 流程执行问题 → 防复发机制 → 固化位置

> 本矩阵是 FR-024 的权威对照表（架构 §10.8「流程执行问题整改映射」）：把
> `docs/流程执行问题.md` 的 13 条流程执行问题逐条映射到已实现的防复发机制、
> 固化位置（权威文档/代码/测试）与验证方式。矩阵随流程文档可审计（Stage
> Review）；每条标注 `已闭环`（机制已实现并验证）或 `本次整改新增`（机制在
> S12-F 整改期新固化，FR-021/FR-022/FR-024）。问题详述以 `docs/流程执行问题.md`
> 为准，本矩阵不复制现象/根因。

| # | 流程执行问题（docs/流程执行问题.md） | 标注 | 防复发机制 | 固化位置 | 验证方式 |
|---|---|---|---|---|---|
| 1 | Brain 直接操作 Git（commit/reset/checkout） | 已闭环 | Brain 只读 Git（status/log/diff/show）；一切 Git 写操作由 Runtime `boundary close` CLI 负责；CLI 是唯一 Git boundary 建立者 | `.pi/brain-workflow.md`（Brain 不执行 Git 写操作）；`.agents/contracts/brain/commit-boundary.md`（Boundary CLI 契约） | Stage Review + 本对照表审计（FR-024 矩阵存在性/覆盖测试） |
| 2 | admission 失败后重跑 plan materialize 重置 Worker 投影 | 本次整改新增（FR-021） | Stage admission 后禁止重跑 `plan materialize`（确定性渲染会重置已受理投影）；确需 replan 必须保留/恢复已受理 Slice 投影（从 HEAD 恢复、只改目标任务区）或走 recover/re-admission；新模式已受理 Slice 状态由 Receipt 推导，投影重置不影响 currentness | `.agents/skills/proofloop-plan/SKILL.md`「Admission 后 Replan 纪律」；`.pi/brain-workflow.md` STAGE_PLANNING 段后纪律；架构 §10.5/10.8 | `test/proofloop-plan-process-consistency.spec.ts`「pluginv2 admission-after replan discipline」用例 |
| 3 | `git checkout --` 误操作丢失已实现代码 | 已闭环 | Git 写操作一律由 Runtime `boundary close` CLI 执行（同 #1）；还原文件前先 `git status`/`git diff` 确认内容归属；临时编辑用手动反向编辑而非 checkout 整个文件 | `.pi/brain-workflow.md`（Git 只读纪律）；`docs/流程执行问题.md` #3 正确处理与核心教训 #1 | Stage Review + 本对照表审计 |
| 4 | admission 请求 digest 填错/截断 | 已闭环 | 派发数据包逐字段携带 digest（sha256/64-hex）并由 Runtime closed-schema 校验格式/长度/绑定；Brain 派发前与 Context/Manifest 交叉核对，不凭记忆 | `worker-template.md`「派发数据包」（manifest/plan/context/snapshot digest 字段）；`packages/runtime/src/relay-contract.ts` + `vnext/worker-admission.ts`（closed-schema digest 校验） | `worker-admission.spec.ts`「fails closed on Manifest digest mismatch / Plan digest mismatch / Context digest mismatch」 |
| 5 | tasks.md 投影修改位置错误（顶层 vs Slice 区） | 已闭环 | 只允许修改当前 Task 的 checkbox/Worker Status projection（Slice 区 Mutable Execution Projection）；顶层保持候选状态；Runtime 对 immutable/non-current projection change fail-closed | `worker-template.md`「必需规则」（tasks.md 非 implementation scope、只改当前 Task 投影）；`packages/runtime/src/vnext/worker-admission.ts`（immutable projection change 拒绝） | `worker-admission.spec.ts`「rejects an immutable Plan change」「rejects an incomplete or rolled-back current Task checkbox」 |
| 6 | Slice Commit admission 的 commit_sha / HEAD 顺序问题 | 已闭环 | slice commit 独占 HEAD（非 slice 提交在 slice admission 之后）；commit_sha 用 `git rev-parse HEAD` 的 40 位值；Boundary CLI 契约约束 pre_commit_head / slice_commit_sha | `.agents/contracts/brain/commit-boundary.md`（pre_commit_head、40-char sha）；`packages/runtime/src/vnext/commit-admission.ts`（commit_sha = HEAD 校验） | commit-admission 测试 + Stage Review（提交顺序审计） |
| 7 | CV REPAIR 未及时 admission，recheck 无法衔接 | 已闭环 | CV 结果（PASS/REPAIR）必须立即 admission——仅 PASS/REPAIR 可进入 Runtime admission（见「动作路由」）；REPAIR 是链上状态，recheck PASS 绑定前序 CV_REPAIR（previous_failure_signature 衔接） | `.agents/skills/proofloop-execute/SKILL.md`「CV 循环」「动作路由」；`packages/runtime/src/vnext/cv-admission.ts`（REPAIR → recheck 链校验） | `cv-admission.spec.ts` / `cv-admission-integration.spec.ts`（链衔接用例） |
| 8 | repair Evidence 标题级别错误（`###` 被误判为 Task 标题） | 本次整改新增（FR-022） | Evidence 标题规则：每个任务小节标题必须为 `### <task-id>` 且同文件恰好一个唯一；任务内子记录一律 `####` 或 `- label:`；admission 错误消息明确提示标题缺失/重复及违规行号 | `worker-template.md`「Task Evidence 书写规范」；`packages/runtime/src/vnext/worker-admission.ts`（assertCurrentTaskEvidence 缺失/重复明确消息，含行号与 `####`/`- label:` 提示） | `worker-admission.spec.ts`「FR-022 — Task Evidence heading rule」3 用例（重复拒绝含行号/唯一性提示、缺失拒绝含 `### ` 提示、合法单标题通过） |
| 9 | repair scope 越权（文件不在 admitted code_paths） | 已闭环 | immutable execution_scope（code/test/forbidden paths）进入 Context/Plan digest；changed_files 越界 fail-closed（不写 Receipt）；scope 变更先 replan（materialize → compile → validate → 恢复投影 → 重 admission） | `packages/runtime/src/vnext/worker-admission.ts`（`changed_files expands beyond the admitted task scope`）；Context execution_scope（`vnext/dispatch.ts`）；`worker-template.md`「必需规则」 | `worker-admission.spec.ts`（scope 越界 / forbidden changed path 用例） |
| 10 | evidence 绑定失效（scope 变化使 manifest digest 变化） | 已闭环（FR-023） | validate 对「已受理且当前有效」的 Slice 豁免绑定校验（binding-currentness 判定）；refresh-evidence / rebind 路径刷新绑定；未受理旧绑定仍 fail-closed | `packages/runtime/src/vnext/evidence-refresh.ts` + `vnext/binding-currentness.ts`（FR-023 豁免）；架构 §10.6 | `replan-binding.spec.ts`（FR-023 豁免用例：pristine 旧绑定未受理不豁免） |
| 11 | 子代理派发类型错误（用 general 承载 Worker 任务） | 已闭环 | Session Relay 按角色 + stage + 语义输入 digest 匹配恢复/新建派发；Worker 派发必须 `target_agent: worker`；临时解锁文件用后即删 | `.pi/brain-workflow.md`「Brain Session Relay」；`worker-template.md`「派发数据包」（target_agent: worker） | Stage Review + 派发审计（本对照表） |
| 12 | 上游 cwd 修复未在本地基线中 | 已闭环 | 导入上游时确认所有相关分支的修复都纳入基线（移植修复意图 + 参数化 + 补测试）；教训入核心教训清单 | `docs/流程执行问题.md` 核心教训 #7；本对照表（FR-024 审计载体） | Stage Review + 本对照表审计 |
| 13 | 全量测试写入项目配置（环境污染） | 已闭环 | 测试 fixture 用临时目录隔离（mkdtemp），绝不用真实仓库/配置作 fixture；测试前后项目配置文件不变（无污染断言） | `test/proofloop-plan-process-consistency.spec.ts`（临时 fixture 注释）；`packages/runtime/src/vnext/worker-admission.spec.ts`（mkdtemp fixture）；`PLUGINV2-S12-TEST-ORACLE`（tech-spec/ai-coding-architecture.md：配置无污染断言） | 全量测试（fixture 隔离）+ S12 测试 oracle 断言 |

## 覆盖核对

- 13/13 条覆盖：`docs/流程执行问题.md` #1..#13 全部有防复发机制归属与固化位置，无孤儿教训。
- 每条可审计：标注列区分 `已闭环`（机制先于 S12-F 已实现并验证）与 `本次整改新增`
  （#2 → FR-021、#8 → FR-022，S12-F 整改期新固化；本矩阵 → FR-024）。
- 随流程文档审计：Stage Review 以本矩阵核对每条机制的固化位置仍为当前权威位置。
