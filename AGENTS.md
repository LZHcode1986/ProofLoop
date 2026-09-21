# AGENTS.md — ProofLoop 项目规则

本文件是 ProofLoop 的项目级补充，只定义项目硬约束和流程入口；除第 0 节的流程整改例外外，具体事实、权限、字段和步骤以当前 Authority、Contract、Skill 和 Runtime 制品为准。

## 1. 事实来源与重新加载

- 开始工作前读取本文件、当前任务的 Contract、相关 Authority、active Skill 和当前持久化制品。
- 不仅依据对话记忆、Agent 叙事或 progress snapshot 作结论；Agent 返回后，Brain 必须重新读取持久化制品、Git status/diff 和相关 MES facts/Result/Finding。
- 始终区分 Authority、accepted Plan、MES facts、Result/Finding、Evidence、Git snapshot 和派生缓存；派生制品不能反向授权状态迁移。
- 不猜测缺失的 Authority、Schema 或验证条件；缺失时返回结构化阻塞或 `PLAN_GAP`。
- 每完成一批 `read`、`ffgrep`、`bash` 等工具输出的消费，并确认后续推理、验证或执行不再依赖其原始输出时，调用 `ctx_reduce` 清理这些已消费的工具输出；仍在使用、即将复核或作为当前判断依据的输出不要清理。

## 2. 范围与职责

- 只执行当前任务 Contract 明确授权的 Stage、Slice、Task、文件和验证范围。
- 每个角色只完成自己的职责，不以 Agent 叙事替代 MES 状态记录或 Result 接纳。
- Worker 只能在允许的 scope 内工作：`implement-task`/`recover-task` 必须有非空且 immutable 的 root-bound `code/test scope`；`finalize-slice` 按 taskless/evidence 规则，`repair` 按当前 CV Finding 绑定的 bounded failure scope 执行；`diagnose` 仅作为 repair 的失败输入，不单独授予 Worker mode。所选 mode 缺少必需 scope，或试图扩大 scope 时先阻塞，不猜路径、不越权。
- 不修改未授权的 Authority、accepted Plan、MES facts、Result/Finding、Evidence 或 Git 状态；历史旧路径与旧制品仅按当前 Contract 的显式 compatibility/archive 规则处理，不自动迁移或恢复。
- `artifact-archive` 是唯一受控例外：Contract 明确授权且目标为同一 Stage 内的精确纯 rename 时，Brain 可预执行该次 `git mv`；随后只由 `boundary close` 校验已 staging 的单一 rename 并提交，其他 Git 写操作仍走 Runtime Boundary CLI。
- 不新增无法说明真实失败防护价值的功能、门禁、机制或治理制品；已有机制不再必要时才删除。

## 3. 权威引用与持久化制品

- 优先引用权威位置，不复制已经存在的语义正文；机器语义引用使用当前 Contract 要求的稳定 ref 和 digest。
- 读取引用型任务或权威文档时，先精确定位 `task_id`、`ref_id`、`entity_id` 和 marker，再读取完整实体及必要上下文；搜索命中行不能单独作为语义或状态结论。
- 不创建第二个事实源；修改上游事实后，必须识别并报告受影响的下游制品。
- 不把临时文件、上下文缓存或 Agent session 信息写入 Authority、accepted Plan、MES facts、Result/Finding、Evidence 或其他权威制品。
- 已完成或受限关闭的 Stage 属于历史归档；其 Evidence、tasks.md 投影、Review 记录不作为后续 Stage/任务的决策依据。当前判断只使用当前 Authority、当前 Stage 制品和 Git 事实。

## 4. 分支入口与执行边界

- 进行 Stage 规划、candidate Plan 或 `tasks.md` 时，先读取所选 Host 的 Planner 文档（`.pi/agents/proofloop-plan.md` 或 `.opencode/agents/proofloop-plan.md`）及 dispatch 指定的 active Contract；candidate Plan 不授予执行权。
- 规划到执行遵循当前顺序：candidate Plan → stable Git boundary → fresh SPV → Plan 接纳并写入 MES → MES status 记录 stage phase/required_skill（仅 observation，不作 route/dispatch 输入）→ 所选 Host Brain 按 current Project Stage Map + MES/Git facts + active Contracts 路由 dispatch Worker/CV/Integration/Review。旧 `proofloop stage next`、`context prepare/show/admit-*`、`stage admit-*`、`run-gate`、`review finalize-stage`、`project finalize-review`、`stage close` 与 `Primary Next Action` 均为 Historical/legacy，不构成 active 路由。
- Planner continuation 的 currentness 判定按语义 Planning 输入基础，不按精确仓库 HEAD：语义基础与判定规则见 `.agents/contracts/brain/agent-lifecycle.md` §5.2 与 `.agents/contracts/brain/commit-boundary.md` 的 `stage-plan` 机械前置；机械 `stage-plan` boundary 记录相同 candidate blob 推进 HEAD 不单独使 Planner 失效，Stage/Authority/candidate/code-reality/branch/trust-root/scope 真实变化才失效，SPV 保持 fresh 严格验证。
- 进行 Stage execution、Worker、CV、Boundary CLI 或 Integration 时，先读取 `.agents/skills/proofloop-execute/SKILL.md` 及所选 Host 的对应 role 文档与 Contract/template；Stage Review 由所选 Host 的 `stage-reviewer` 文档及其 Contract/Template owner 负责。MES 是 operational state 的唯一权威，Brain 是 route/dispatch/recovery owner。
- Worker Result、CV Finding、Commit、Integration 和 Review 等各 fact-kind / Execution mode 按对应 Contract 校验自身的 MES work identity 与 accepted Plan/Authority/Git basis 绑定要求（以对应 Contract/Skill 为准）；不使用旧 Receipt/Manifest/Context/Gate credential，也不用旧 v1 路由替代当前流程。
- 处理 Plan、Result/Finding、Evidence 或 Plan projection 时，必须按当前 Contract 验证 root、scope、digest、snapshot 和 work identity；不能用 progress、checkbox 或 Agent 叙事补全绑定。

## 5. 验证与报告

- 声称完成必须有实际文件、命令、测试、Result/Finding 或 Git 事实支持；测试通过不自动等于业务目标完成。
- 验证失败时保留失败事实，说明影响和阻塞；不把部分完成改写为成功，也不隐瞒 out-of-scope 修改或环境限制。
- 项目报告、Plan、Progress、Evidence、Review 和 Handoff 默认使用简体中文；代码标识符、API 字段、Schema key、CLI 参数、路径、枚举值和错误码保持原样。
- 收尾信息至少说明结论和证据；按任务情况补充实际修改、验证、未完成内容、阻塞、风险和交接信息。

## 6. Git、补丁与恢复

- 所有路径必须遵守当前 Trust Root 和 Contract 边界；修改前后检查 Git status 和 diff。
- 未经明确授权，不提交、推送、删除或重置 Git 内容；不覆盖非空 Evidence、MES facts 或其他持久化制品。
- 任何文件写入工具发生失败或部分应用后，立即停止重试；重新读取当前文件、Git status 和 Git diff，确认实际落盘状态后，再基于当前内容生成新操作；禁止重放旧上下文。
- Agent 被中断或取消后，磁盘内容和 Git diff 是唯一事实源；不得假设回滚或重复覆盖 partial state。
- 尚未接纳的 Worker 代码、测试、Evidence 或 tasks projection 必须作为 recovery patch 保留。Runtime/Host 修复单独提交；仅当其改变 Planning semantic basis（Stage/Authority/candidate/code-reality/branch/trust-root/scope 真实变化）时才要求重新 fresh SPV，普通 mechanical/unrelated HEAD advance 不自动使 Planner/SPV 失效（严格 tuple 规则仍以 lifecycle/plan Contract 为准），随后再通过 `recover-task`/`recheck` 重新绑定和接纳现有成果；不得重写或重新派发实现 Task。
- 任何 Agent 不得绕过 Brain 手写 MES fact、Result/Finding 或 Plan，也不得替代 Brain 调用 Boundary CLI 建立 Git boundary。

## 7. Brain event pointer

发生 routing、transaction 或 lifecycle decision 时，fresh-read 所选 Host 的 Brain 文档：OpenCode 为 `.opencode/agents/brain.md`，Pi 为 `.pi/brain-workflow.md`；并按对应 event-local Contract fresh-read 唯一 canonical owner。
