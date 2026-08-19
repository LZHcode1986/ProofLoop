# AGENTS.md — ProofLoop 项目规则

本文件是 ProofLoop 的项目级补充，只定义项目硬约束和流程入口；具体事实、权限、字段和步骤以当前 Authority、Contract、Skill 和 Runtime 制品为准。

## 1. 事实来源与重新加载

- 开始工作前读取本文件、当前任务的 Contract、相关 Authority、active Skill 和当前持久化制品。
- 不仅依据对话记忆、Agent 叙事或 progress snapshot 作结论；Agent 返回后，Brain 必须重新读取持久化制品、Git status/diff 和相关 Gate。
- 始终区分 Authority、Manifest、Receipt、Evidence、Runtime State、Git snapshot 和派生缓存；派生制品不能反向授权状态迁移。
- 不猜测缺失的 Authority、Schema 或验证条件；缺失时返回结构化阻塞或 `PLAN_GAP`。

## 2. 范围与职责

- 只执行当前任务 Contract 明确授权的 Stage、Slice、Task、文件和验证范围。
- 每个角色只完成自己的职责，不以 Agent 叙事替代 Runtime 状态迁移或 Receipt。
- Worker 只能在 Context.allowed_paths 内工作；缺少非空 code/test scope 或 mutable projection scope 时先阻塞，不猜路径、不扩大权限。
- `scope.mutable_projection_paths` 只允许 checkbox/Worker Status projection；Plan digest 和其他 immutable scope 保持不变。
- 不修改未授权的 Authority、Manifest、Receipt、Evidence 或 Git 状态；旧路径、旧制品和兼容代码必须等对应 Cutover Gate 通过后再处理。
- 不新增无法说明真实失败防护价值的功能、门禁、机制或治理制品；已有机制不再必要时才删除。

## 3. 权威引用与持久化制品

- 优先引用权威位置，不复制已经存在的语义正文；机器语义引用使用当前 Contract 要求的稳定 ref 和 digest。
- 读取引用型任务或权威文档时，先精确定位 `task_id`、`ref_id`、`entity_id` 和 marker，再读取完整实体及必要上下文；搜索命中行不能单独作为语义或状态结论。
- 不创建第二个事实源；修改上游事实后，必须识别并报告受影响的下游制品。
- 不把临时文件、上下文缓存或 Agent session 信息写入 Authority、Manifest、Receipt、Evidence 或其他权威制品。
- 已完成或受限关闭的 Stage 属于历史归档；其 Evidence、Receipt、tasks.md 投影、Gate 和 Review 记录不作为后续 Stage/任务的决策依据。当前判断只使用当前 Authority、当前 Stage 制品和 Git 事实。

## 4. 分支入口与执行边界

- 进行 Stage 规划、candidate `tasks.md` 或 `plan materialize` 时，先读取 `.agents/skills/proofloop-plan/SKILL.md`、其引用的 materializer Contract 和 dispatch 指定的 active Contract；candidate Plan 不授予执行权。
- 规划到执行必须遵循当前 vNext 顺序：candidate Plan/Evidence skeleton → stable Git boundary → Runtime 编译/校验 → fresh SPV → Stage Plan admission → `proofloop_stage(next)`/Context → Worker。
- 进行 admitted Stage execution、Worker、CV、Committer、Integration、Gate 或 Review 时，先读取 `.agents/skills/proofloop-execute/SKILL.md` 及 dispatch 指定的 role Contract/template；Runtime 是状态和 admission 的唯一权威。
- vNext 的 Worker Result、CV、Commit、Integration、Gate 和 Review 必须使用当前 vNext consumer 与绑定链；不得把 v2 事实送入 legacy consumer，也不得用旧 v1 路由替代当前流程。
- 处理 Manifest、Context、Receipt、Evidence 或 Plan projection 时，必须按当前 Contract 验证 root、scope、digest、snapshot 和前序 Receipt；不能用 progress、checkbox 或 Agent 叙事补全绑定。

## 5. 验证与报告

- 声称完成必须有实际文件、命令、测试、Receipt 或 Git 事实支持；测试通过不自动等于业务目标完成。
- 验证失败时保留失败事实，说明影响和阻塞；不把部分完成改写为成功，也不隐瞒 out-of-scope 修改或环境限制。
- 项目报告、Plan、Progress、Evidence、Review 和 Handoff 默认使用简体中文；代码标识符、API 字段、Schema key、CLI 参数、路径、枚举值和错误码保持原样。
- 收尾信息至少说明结论和证据；按任务情况补充实际修改、验证、未完成内容、阻塞、风险和交接信息。

## 6. Git、补丁与恢复

- 所有路径必须遵守当前 Trust Root 和 Contract 边界；修改前后检查 Git status 和 diff。
- 未经明确授权，不提交、推送、删除或重置 Git 内容；不覆盖非空 Evidence、Receipt 或其他持久化制品。
- 任何文件写入工具发生失败或部分应用后，立即停止重试；重新读取当前文件、Git status 和 Git diff，确认实际落盘状态后，再基于当前内容生成新操作；禁止重放旧上下文。
- Agent 被中断或取消后，磁盘内容和 Git diff 是唯一事实源；不得假设回滚或重复覆盖 partial state。
- 尚未 Runtime admission 的 Worker 代码、测试、Evidence 或 tasks projection 必须作为 recovery patch 保留。Runtime/Host 修复单独提交并因 HEAD 变化重新执行 fresh SPV/admission，再通过 `recover-task`/`recheck` 重新绑定和接纳现有成果；不得重写或重新派发实现 Task。
- 任何 Agent 不得绕过 Runtime 手写 Receipt、Manifest 或 Context，也不得替代 Committer 建立 Git boundary。
