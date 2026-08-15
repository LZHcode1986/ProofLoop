# AGENTS.md — Project-wide Agent Rules

## 1. 沟通与语言
- 用户是一个不懂技术的产品经理，沟通要用普通用户能理解的语言，不能用专业术语（或添加解释）。
- 除代码、代码标识符、API 字段、命令、路径、枚举值和错误码外，Agent 思考，交流和项目文档默认使用中文。
- 不翻译会影响机器解析的名称、Schema key、CLI 参数和 route code。
- 引用英文权威原文时保留原文，并可补充中文说明。
- 报告、Plan、Progress、Evidence、Review 和 Handoff 默认使用中文。
- **提问必须带建议与理由**：需要用户决策时，先给出你推荐的做法和理由（基于成本/先例/证据），再请用户确认；不得只抛问题让用户自己想办法。

## 2. Rehydration and authority
- 开始工作前读取本文件、目标 Contract、相关 Authority 和当前持久化制品。
- 不仅依据对话记忆、Agent narrative 或 progress snapshot 作结论；Agent 返回后，Brain 必须重新读取持久化制品、Git status/diff 和相关 Gate。
- 必须区分 Authority、Manifest、Receipt、Evidence、Runtime State、
  Git snapshot 和派生缓存。
- 派生制品不能反向授权状态迁移。
- 不猜测缺失的 Authority、Schema 或验证条件；缺失时报告阻塞。

## 3. Scope and ownership
- 只执行当前任务 Contract 明确授权的范围。
- 不替代其他角色完成其专属职责。
- 不自行扩大 Stage、Slice、Task、文件或验证范围。
- 不修改未授权的 Authority、Manifest、Receipt、Evidence 或 Git 状态。
- 不删除旧路径、旧制品或兼容代码，除非对应 Cutover Gate 已通过。
- **最小必要原则（奥卡姆剃刀）**：不添加非必要的功能、门禁、机制或治理制品；每新增一个机制必须能说明它防止了哪个真实失败（有实际证据/先例），否则不添加。同样，已有机制若不再必要，应删除而非保留。

## 4. Artifact and reference discipline
- 优先引用权威位置，不复制已经存在的语义正文。
- 机器语义引用必须使用项目当前 Contract 要求的稳定引用和 digest。
- 读取引用型任务或权威文档时，默认使用项目提供的 `Grep`/`Glob` 工具定位 `task_id`、`ref_id`、`entity_id` 和 marker；若必须在 shell 中搜索，优先使用 `rg` 而不是递归 `grep`。搜索只负责定位，随后用 `Read` 读取命中的完整实体/小节及局部必要上下文；不得仅凭搜索命中行作语义或状态判断。
- 不创建第二个事实源。
- 修改上游事实后，必须识别并报告受影响的下游制品。
- 不把临时文件、上下文缓存、Agent session 信息写入权威制品。
- **已完成 Stage 是历史归档**：已完成（含受限关闭）Stage 的 Evidence、Receipts、tasks.md 投影、Gate/Review 记录等过程文档属于历史归档，**不作为后续 Stage/任务的决策依据**；分析当前任务时只参考当前 Authority、当前 Stage 制品与 Git 事实。历史审查遗漏不得被当作合理先例（“过去没发现”不等于“当前不需要”）。

## 5. Verification and reporting
- 声称完成必须有实际文件、命令、测试、Receipt 或 Git 事实支持。
- 测试通过不自动等于业务目标完成。
- 验证失败时保留失败事实，不改写为成功。
- 报告必须包含：
  - 实际修改；
  - 实际验证；
  - 未完成内容；
  - 阻塞原因；
  - 建议的下一责任人。
- 不隐瞒 out-of-scope 修改或环境限制。

## 6. Safety and Git
- 不提交 Secrets、凭据、个人信息或未经授权的外部内容。
- 所有路径必须遵守当前 Trust Root 和 Contract 的边界。
- 修改前后检查 Git status 和 diff。
- 未经明确授权，不提交、推送、删除或重置 Git 内容。
- 不覆盖非空 Evidence、Receipt 或其他持久化制品。
- 破坏性操作必须有明确范围和可验证依据。

## 7. Patch and recovery discipline
- 遇到 `% Patch failed` 必须立即停止当前 Patch 重试；重新读取当前磁盘文件、`git status` 和 `git diff`，确认哪些 hunks 已经成功应用后，再根据当前内容生成新 Patch。禁止使用旧上下文盲目重放 Patch。
- `apply_patch` 必须使用完整的 `patchText` envelope（`*** Begin Patch` / 文件操作 / `*** End Patch`）；每次只处理一个逻辑文件批次。每批 Patch 后必须重新读取文件、检查 diff/diff --check，并运行适用的最小验证。
- Agent 被中断或取消后，磁盘内容和 Git diff 是唯一事实源；不得假设文件已回滚，不得重复覆盖可能已部分应用的修改。发现 partial state 时必须先报告实际状态和阻塞。
- 已产生但尚未 Runtime admission 的 Worker 代码、测试、Evidence 或 tasks projection 修改必须作为 recovery patch 保留。后续 Runtime/Host 修复不得 reset、丢弃或重新派发实现 Task；应单独提交 Runtime 修复，因 HEAD 变化 fresh SPV/admission，再原样恢复 patch，并用 `recover-task`/`recheck` 重新绑定 Context 和接纳现有成果。
- 任何 Agent 不得绕过 Runtime 写 Receipt、Manifest 或 Context，也不得替代 Committer 建立 Git boundary。
