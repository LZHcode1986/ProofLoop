# PRD: ProofLoop v2 通用 CLI（OpenCode Plugin 已退役）

> 当前需求参考：`ProofLoop_pluginv2_流程优化方案.md`（用户于 2026-08-05 确认）；
> `docs/ProofLoop_OpenCode_Plugin_Implementation_Blueprint.md` 保留为历史/补充参考。
> 当前结构化需求上下文：`CONTEXT.md`（2026-08-09 通用 CLI / CLI-first 修订）。
> 技术设计、合同、AWI 和执行计划不在本文件重复定义。
> 基线：`packages/kernel` + `packages/runtime`（新 runtime，阶段 A/B 已完成）。
> 状态：CONFIRMED（用户于 2026-08-09 确认 harness-neutral 通用 CLI 与 CLI-first 交付顺序；技术细节继续由 Tech Spec 维护）。
>
> **OpenCode Plugin 退役登记（2026-08-14 用户裁决）**：CLI 已自举验证并完成项目验收（PROJECT_REVIEW_PASS
> `37a30b69`）；全部机械校验（admission/digest/fail-closed/SPV/CV/Gate/Review/Project Acceptance）均由
> `proofloop <domain> <operation>` CLI + kernel/runtime 承担，插件不贡献任何校验逻辑；角色权限隔离由各 harness 的
> Agent 配置承担（本项目在 Pi 中全 CLI 运行实证）。`packages/opencode-plugin` 与其入口
> `.opencode/plugins/proofloop.js` 已删除；本 PRD 中所有“OpenCode Plugin / 插件增强”表述不再构成交付义务，
> 仅保留为历史记录。FR-001/FR-006 等需求的实现载体为 CLI。

## 1. One-sentence description
一套不依赖特定 Agent harness 的 ProofLoop v2 通用 CLI，让 OpenCode、Pi、
Claude Code 等宿主中的 Agent 通过相同命令运行可恢复流程；流程正确性始终由
共享 kernel/runtime 保证。CLI 是唯一机械界面（原 OpenCode Plugin 增强已退役）。

## 2. Background and problem
- **当前问题**：ProofLoop 的同一事实会在 PRD/架构、Plan、Agent 上下文和状态投影中重复改写；现有机械入口又分散在旧 CLI、OpenCode tools 和 Agent 手工步骤中，迁移到其他 harness 时需要重新适配工具。
- **为什么现在重要**：用户需要先稳定一套 harness-neutral 的机械执行表面，使 OpenCode、Pi、Claude Code 等宿主只调整 Agent 定义，不重写工具，同时保持 Evidence、CV、Gate、Review 和 Receipt 的可审计边界。
- **当前交付顺序**：先完成并自举验证 ProofLoop v2 通用 CLI；OpenCode Plugin 的工具和 hooks 在 CLI 成熟后继续完善。`pluginv2` 开发期间保留当前 `plugin` 流程作为回退。
- **Plugin 退役（2026-08-14 用户裁决）**：CLI 成熟且项目验收通过后，OpenCode Plugin 不再实施/维护；各 harness 的 Agent 直接调用 CLI（权限由 Agent 配置隔离）。

## 3. Target users and roles
| Role | 描述 | 关键需求 |
|---|---|---|
| ProofLoop 使用者（开发者） | 在 OpenCode、Pi、Claude Code 等 harness 中开发业务项目的人 | Agent 可调用同一组 CLI；流程机械层可靠；更换 harness 不重写工具 |
| Brain Agent | 全局权威和流程编排者 | 根据持久事实选择下一责任人；不以叙事、checkbox 或 progress 授权状态 |
| Planning Skill | 规划能力 | 构造 closed 结构化输入并调用 `plan materialize` 生成最小 candidate Plan；不发明产品或技术事实 |
| Worker | 单 Task 实现者 | 只执行 Runtime 指定的 Task；先写 Evidence，再更新执行投影 |
| Code Verifier（CV） | 独立反驳者 | 先独立设计反例，再读取 Worker Evidence；使用统一验证方式 |
| Committer / Integrator | Git 边界责任人 | 只在对应 Receipt 和验证通过后提交/集成 |
| Stage Reviewer / Project Reviewer | 阶段/项目独立评审者 | 依据目标、权威、代码和 Gate/E2E 事实给出独立结论 |
| Runtime / CLI | 通用机械流程层 | 解析引用、派生状态、按角色生成最小上下文、持久化结构化结果、执行 Gate；不依赖 harness 工具 API |
| OpenCode Plugin | ~~CLI 成熟后的宿主增强~~ **已退役（2026-08-14）**：提供 OpenCode tools/hooks/权限与体验增强；不创建第二套流程语义，也不是 S10 前提。退役后由 CLI + Agent 配置承担 |

## 4. User scenarios
- **S1 安装即用**：开发者在任意 harness 中打开 ProofLoop 项目后即可用同一组 CLI 命令运行流程（trust-root 检测 `.proofloop/runtime.lock`/manifests，非 ProofLoop 项目 fail closed）；普通项目不受影响。
- **S2 最小规划**：用户/Brain 能从已确认的需求和技术权威生成精简计划；计划只是候选，未经明确认可不能执行。
- **S3 单动作执行**：Worker 每次得到一个明确 Task 和最小工作上下文，完成后提交证据；用户可追踪下一动作和阻断原因。
- **S4 断点恢复**：会话中断、Agent 丢失或 Git snapshot 变化后，系统从持久事实恢复或安全阻断，不依赖会话记忆。
- **S5 独立验证与收口**：Slice 完成后由 CV 独立反驳，随后进行提交、集成、Stage Gate、Stage Review 和 Project Acceptance。
- **S6 受控切换**：`pluginv2` 未满足切换 Gate 前，当前 `plugin` 流程可回退；旧 Stage/Receipt 不被自动迁移或静默解释。
- **S7 一致性与防篡改**：不同入口对同一事实产生一致结果，直接写受保护制品或使用过期/不一致计划会被阻止。
- **S8 跨 harness 机械执行**：OpenCode、Pi、Claude Code 等 harness 的 Agent 直接调用相同 CLI；不同阶段和角色得到各自的最小 Context，更换 harness 时只调整 Agent 定义。

## 5. Product goals
- **G1**：业务项目不再需要 `.agents/runtime`（node_modules/dist 从项目消失）。
- **G2**：用稳定的通用 CLI 命令和最小上下文完成 Authority→Planning→Execution→Gate→Review→Project Acceptance 的机械流程。
- **G3**：每类事实只有一个权威来源；Plan、Manifest、Context、Evidence 和状态投影不能互相伪装授权。
- **G4**：按角色隔离工具，默认全局 deny，并在运行时进行二次校验。
- **G5**：保留 TDD、Evidence、独立 CV、Stage Gate、Stage Review、Stage Close 和 Project Acceptance 的可审计闭环。
- **G6**：Runtime source/dist、通用 CLI 及后续插件适配对同一输入产生一致结果；CLI 不因 harness 改变。
- **G7**：降低重复上下文、Agent 会话和 token 成本；token 总量不高于旧方案，目标至少降低 10%。
- **G8**：S10 用通用 CLI 自举推进自身机械流程，证明 CLI 能保存 AI 结果、投影角色 Context、检查阶段转换并从本地事实恢复。

## 6. Success metrics
- 加载插件后业务项目无 `.agents/runtime/node_modules` 与 `.agents/runtime/dist`。
- 同一 fixture 下 CLI/插件 parity 全部通过（Finding Codes、Next Action、Receipt 规范 JSON、Digest、Gate verdict）。
- 未经计划认可、存在 stale digest 或存在阻断 Finding 时，不会产生 Worker 执行授权。
- 两个真实 Slice no-ff merge 后 Stage Gate PASS，并完成独立 Stage Review。
- 会话丢失后仅依赖 Git/Receipts/Evidence 恢复成功或返回明确阻断。
- pluginv2 切换 Gate 的全部必要条件通过，且 `plugin` 回退路径仍可用直到切换完成。
- Token 总量不高于旧方案，目标至少降低 10%（同一 fixture 对照测量）。
- 同一组 CLI 命令及输入输出合同可由 OpenCode、Pi、Claude Code 等 harness 的 Agent 直接调用；无需新增 harness 专用工具代码。
- S10 在最小 CLI bootstrap 边界之后的 Execution→Review 机械流程由通用 CLI 自举完成；Plan 全链由 fresh candidate fixture 验证，并留下 Context、Finding、Receipt、Gate 和恢复记录。

## 7. Primary user flow
1. 用户在任意受支持 harness 中由 Brain/Authority Skill 理解需求并维护 PRD/Tech Spec；AI 负责语义，CLI 不替代判断。
2. Brain/Planning Skill 生成最小候选计划；通用 CLI 解析并绑定 Authority refs，检查计划制品和 Git 边界。
3. CLI 编译、验证并受理满足条件的计划；只有完整的机械认可边界才允许进入执行。
4. CLI 根据唯一下一动作，为 Worker、CV、Committer 或 Reviewer 生成各自不同的最小 Context ref；Brain 只机械转交给对应 Agent。
5. Agent 完成语义工作后返回结构化结果；CLI 验证 Context、scope、snapshot、diff 和前序 Receipt 后保存本地事实。
6. CLI 继续推进 Slice Commit/Integration、Stage Gate、Stage Review 和 Project Acceptance；每次转换前检查所需制品。
7. 会话或 harness 更换、权威/计划/snapshot 变化时，CLI 从 Git/Manifest/Receipt/Evidence/Context 等本地事实恢复或安全阻断。

## 8. Functional requirements

### FR-001: 项目检测与初始化
- Description: CLI 在调用时检测 ProofLoop 项目标识（`.proofloop/runtime.lock`、manifests、delivery/stages）并断言 trust root，非 ProofLoop 项目不启用任何保护、不扫描、不注入任何内容（原插件加载检测语义由 CLI root 断言承担）。
- User story: 作为开发者，我希望 ProofLoop 机制只在 ProofLoop 项目中生效，这样普通项目不会被干扰。
- Acceptance criteria:
  - When 在非 ProofLoop 项目中调用 CLI，命令 fail closed（不降级运行）。
  - When 在 ProofLoop 项目中且 runtime.lock 有效，CLI 全部域可用并启用保护。
  - When runtime.lock 缺失或版本不兼容，CLI fail closed（不降级运行）。
- Status: confirmed

### FR-002: 精简规划与计划认可
- Description: 为 Brain 和规划能力提供统一的计划入口；计划从已确认的产品/技术权威生成，保留必要的阶段、Slice、Task、依赖和技能引用，不重复复制权威正文。
- User story: 作为开发者，我希望计划清楚说明要完成什么、如何验收以及当前是否获准执行，而不是在多个 Agent 提示和文件中寻找同一事实。
- Acceptance criteria:
  - When 生成候选计划，计划引用已确认的权威来源，并且不把候选计划本身当作产品或技术权威。
  - When 计划和独立验证结果满足认可条件，系统明确显示可以进入执行；否则显示阻断原因。
  - When 输入非法、引用缺失或权威过期，系统返回结构化 Finding，不静默降级、不写入错误状态。
- Status: confirmed

### FR-003: 单动作阶段执行
- Description: 为执行流程提供统一入口：查询状态、取得唯一下一动作、提交 Worker/CV/提交/集成结果以及执行阶段闸门。
- User story: 作为开发者，我希望每次执行只得到一个明确、可恢复的下一动作，避免 Agent 自己猜测状态或越过流程边界。
- Acceptance criteria:
  - When调用下一动作，系统只依据持久事实返回一个下一动作和完成该动作所需的最小上下文。
  - When提交执行结果，系统记录不可变证据，并根据结果重新计算下一动作。
  - When阶段闸门执行，系统返回可审计的步骤结果和通过/失败结论。
  - When存在阻断 Finding、过期计划或链断裂，系统 fail closed 并返回原因，不产生 Worker 授权。
- Status: confirmed

### FR-004: 独立阶段评审
- Description: 为 Stage Reviewer 提供阶段状态、评审输入和结果受理；工具不替代 Reviewer 对目标、代码、证据和反例的判断。
- Acceptance criteria:
  - When Reviewer 返回 ACCEPTED，系统记录绑定最终代码快照和 Stage Gate 的 Stage Review Receipt。
  - When Reviewer 返回 REPAIR/REJECTED，系统保留阻断事实并将流程路由到修复、重规划或权威整改，不改写为完成。
- Status: confirmed

### FR-005: proofloop_project（Brain / Project Reviewer）
- Description: 项目验收工具，操作：compile_acceptance / run_e2e / prepare_review / finalize_review / status。
- Acceptance criteria:
  - When 所有 Stage 通过，compile_acceptance 生成 ProjectAcceptanceManifest。
  - When 执行 run_e2e，产出 Project E2E Gate Receipt（`PROJECT_E2E_PASS` / `PROJECT_E2E_FAIL` / `PROJECT_E2E_BLOCKED`）。
  - When Reviewer 返回项目评审结果，finalize_review 写 Project Review Receipt。
- Status: confirmed

### FR-006: proofloop_doctor
- Description: 诊断工具（Brain、规划/执行能力可见）：runtime 与插件版本、Git、项目命令与服务、artifact 根目录、Receipt schema 版本、Host API 兼容性。
- Acceptance criteria:
  - When 任何环境/版本不一致，doctor 返回结构化诊断。
  - When 非 ProofLoop 项目，doctor 是唯一可用的工具。
- Status: confirmed

### FR-007: 按角色隔离工具
- Description: 默认全局 deny，按角色 allow；即使宿主只支持权限阻止，插件仍运行时二次校验调用者角色。
- Acceptance criteria:
  - When Worker/CV/Committer/Researcher/Prototype/General 请求 ProofLoop 工具，被拒绝。
  - When 角色与工具不匹配（如 Worker 请求规划或 Reviewer 请求写入），被拒绝并返回 HOST 权限 Finding。
- Status: confirmed

### FR-008: 保护钩子（Protected Artifact）
- Description: 阻止通用写工具直接操作 `.proofloop/receipts/**`、`.proofloop/runtime/**`、`.proofloop/runtime.lock`、`.proofloop/manifests/**`。
- Acceptance criteria:
  - When 任何 agent 直接写受保护路径，被阻止；Receipt 只能由 runtime admit 管线写入。
- Status: confirmed

### FR-009: 脏状态钩子（Dirty-State）
- Description: 文件/Git/命令变化后只设置 `stage_cache_dirty`，下次 status/next 才重新 Reconcile。
- Acceptance criteria:
  - When 编辑文件后立即查询，返回标记为脏；When 下次 status/next，重新 reconcile。
- Status: confirmed

### FR-010: 命令策略钩子（Command Policy）
- Description: 阻止旧 runtime CLI 调用、直接写 Receipt、未声明 cwd 的 Stage Proof；项目测试命令由 Environment Contract 与 Capability Registry 决定。
- Acceptance criteria:
  - When 命令匹配旧 runtime 路径或被禁模式，被阻止。
  - When Stage Proof 未声明 cwd，被阻止。
- Status: confirmed

### FR-011: 上下文压缩与恢复指针（Context Compaction）
- Description: 压缩后只注入最短恢复指针，不把完整权威、计划或事实正文塞回 Agent 上下文；恢复时重新读取持久事实。
- Acceptance criteria:
  - When 会话压缩后，注入内容仅含恢复指针；恢复后必须重读 Git/Manifest/Receipts。
- Status: confirmed

### FR-012: Token 预算
- Description: status summary ≤1,000 字符；next action ≤1,500 字符；findings 默认 ≤20 条；Receipt 只返回 ref + digest；完整日志写 `.proofloop/logs/`。
- Acceptance criteria:
  - When 工具输出超过预算，按预算截断并指向日志。
- Status: confirmed

### FR-013: runtime.lock 版本锁
- Description: 项目配置与 `.proofloop/runtime.lock` 记录 runtime/plugin/schema 版本；不兼容时 fail closed。
- Acceptance criteria:
  - When runtime 版本与 lock 不匹配，通用 CLI 与插件均 fail closed 并提示。
- Status: confirmed

### FR-014: CLI/Plugin parity（持续质量门）
- Description: 同一 fixture 分别调用 Runtime source/dist、通用 CLI 与插件适配，产出一致（Finding Codes、Next Action、Context/Receipt 规范 JSON、Digest、Gate verdict）。通用 CLI 是跨 harness 的稳定机械入口；后续插件可以提供宿主体验增强，但不能要求其他 harness 重写工具，也不能改变 Runtime 语义。
- User story: 作为插件维护者，我希望每次变更后都有独立对照证明插件行为与 runtime 一致，这样行为漂移会被立即发现。
- Acceptance criteria:
  - When 同一 fixture 上运行 CLI 与插件，五个维度全部一致。
  - When runtime 或插件代码变更，parity 测试集必须重跑且全过（纳入本项目的每次 Stage Gate）。
  - When Agent 更换 OpenCode、Pi 或 Claude Code harness，通用 CLI 的命令和输入输出合同保持不变。
- Status: confirmed

### FR-015: 真实 Git workflow
- Description: 两个真实 Slice 经 CV → commit → no-ff integration → Gate 后 PASS。
- Acceptance criteria:
  - When 完成两个真实 Slice 的完整闭环，Stage Gate Receipt 显示 PASS。
- Status: confirmed

### FR-016: 会话恢复
- Description: 会话丢失后只依赖 Git/Receipts 恢复，不依赖会话内存或 Agent 叙事。
- Acceptance criteria:
  - When 模拟会话丢失、权威变化、计划变化或 snapshot 变化后恢复，系统从 Git、Manifest、Receipt、Evidence 等持久事实重新计算；事实不一致时阻断而不是静默迁移。
- Status: confirmed

### FR-017: 单一权威与派生投影
- Description: 每类产品/技术事实只维护一个主要权威来源；计划、Manifest、上下文、Evidence、状态快照和 progress 都是受边界约束的投影，不能反向授权流程。
- User story: 作为项目维护者，我希望修改一处权威事实后，系统能明确失效受影响结果，而不是让多个副本产生冲突。
- Acceptance criteria:
  - When authority、Plan 或代码 snapshot 发生影响性变化，相关旧结果被标记为 stale 并要求重新验证。
  - When 只改变 checkbox 或人类进度快照，系统不把它当作新的完成或执行授权。
  - When candidate Plan、candidate input 或 Evidence skeleton 尚未进入最终且干净的 Git boundary，系统不得让 SPV/admission 产生执行授权。
  - When SPV/admission 成功后，若绑定的 Authority、Plan、Manifest 和 snapshot 未变化，系统继续推进而不重复 SPV；若发生真实边界变化，系统必须 fail closed 并要求重新验证。
  - When 缺少唯一来源或引用无法解析，系统返回 Authority Gap，不由 Plan 或 Agent 补写事实。
- Status: confirmed

### FR-018: pluginv2 受控切换与回退
- Description: pluginv2 作为新的受控流程逐步替换旧 plugin 流程；在所有 Contract Foundation、规划、执行、验证、恢复、Host parity 和项目验收 Gate 通过前，旧流程保持可回退。
- User story: 作为维护者，我希望新流程失败时可以安全回退，而不会破坏现有流程或自动解释旧 Stage/Receipt。
- Acceptance criteria:
  - When pluginv2 切换 Gate 未完成，旧 `plugin` 流程仍可用，新旧流程不通过隐式配置混合。
  - When发现旧 Manifest/Receipt/Stage，系统不自动迁移或静默解释为 pluginv2 事实。
  - When所有切换 Gate 和 Project Acceptance 通过后，才允许正式切换默认流程。
- Status: confirmed

### FR-019: harness-neutral 通用 CLI 与 CLI-first 自举
- Description: ProofLoop v2 的完整机械流程必须由不依赖特定 harness tool API 的通用 CLI
  提供。AI 负责语义工作；CLI 负责按阶段/角色投影最小 Context、检查转换前制品、受理并
  保存结构化 AI 结果、派生唯一下一动作以及从本地事实恢复。S10 先用该 CLI 自举，
  OpenCode Plugin 在 CLI 成熟后继续完善。
- User story: 作为使用不同 AI coding harness 的开发者，我希望 Agent 只需更换定义和权限就
  能调用同一组 ProofLoop 命令，而不需要为每个 harness 重新开发工具。
- Acceptance criteria:
  - When OpenCode、Pi 或 Claude Code Agent 发起同一种机械操作，调用相同 CLI 命令和输入
    合同，不依赖 harness SDK、tool registration 或 hook。
  - When 派发 Brain/Planning、SPV、Worker、CV、Committer、Stage Reviewer 或 Project
    Reviewer，CLI 根据持久事实生成该角色所需且不同的最小 Context ref；缺失或 stale
    binding 时返回 Finding，不生成派发授权。
  - When AI 返回结构化结果，CLI 校验当前 Context、scope、snapshot、changed files 和前序
    Receipt 后写入对应本地制品或 Receipt；非法结果 no-write。
  - When 流程准备进入下一阶段、Slice 状态、Gate、Review 或 Project Acceptance，CLI 先
    机械检查全部必要制品和依赖，并只返回唯一下一动作或结构化阻断。
  - When 会话或 harness 更换，CLI 只依赖项目内 Git、Authority、Manifest、Receipt、
    Evidence 和 Context 恢复，不依赖旧 Agent session 或 harness 内存。
  - When S10 完成，最小 CLI bootstrap 提交之后的 S10 Execution→Review 已使用通用 CLI
    推进；Authority/Plan 全链已在 fresh candidate fixture 上通过同一 CLI 验证，并记录 CLI
    缺口的发现、修复和回归证明；不得修改已 admitted S10 Plan 或用 OpenCode
    `proofloop_*` tools 替代该自举验收。
- Status: confirmed

## 9. Product-level constraints that affect implementation
| Area | Requirement | Status | Simple explanation |
|---|---|---|---|
| Login / account | not needed | confirmed | 插件不识别用户账户 |
| Data saving | needed — 所有流程证据持久化为项目内文件（.proofloop/receipts、manifests、runtime） | confirmed | 证据保存意味着流程状态跨会话存在 |
| Roles / permissions | needed — 按 Agent 角色隔离工具，全局 deny | confirmed | 权限定义谁可以调用什么工具 |
| Uploads | not needed | confirmed | 无文件上传 |
| Import / export | 旧 Receipt 不自动迁移，仅显式 migration 命令 | confirmed | 迁移把旧格式证据转成新格式 |
| Mobile use | not applicable | confirmed | 本地 Agent harness / CLI 场景 |
| Privacy / security | Receipt 为本地文件；网络 deny-by-default | confirmed | CLI 与插件默认不发起网络请求 |

## 10. Scope for this version

### Must have
- harness-neutral 通用 CLI 覆盖 Authority/Plan 检查、Context 投影、执行结果受理、
  Commit/Integration、Gate、Review、Project Acceptance、恢复和诊断；S10 CLI-first 自举。
- CLI 成熟后的 5 个粗粒度 OpenCode tools + 4 个 hooks + 项目检测 + runtime.lock + 角色隔离 + token 预算。
- 单一权威与派生投影边界；candidate 计划、明确认可、执行上下文和持久证据之间不能越权。
- Worker 单 Task/Evidence 顺序、独立 CV、bounded repair/recheck、Stage Gate、Stage Review 和 Project Acceptance。
- CLI/Plugin/source/dist parity、真实 Git workflow、会话恢复和 pluginv2 切换 Gate 验证。

### Can be simplified
- OC-6 token benchmark 的自动化测量脚本（可手工测量 + 记录）。
- 早期 pluginv2 阶段可以保留当前 `plugin` 作为回退，不要求一次性完成旧路径删除。
- S10 不要求完成 OpenCode Plugin tools/hooks；只需证明通用 CLI 不依赖 harness。

### Explicitly out of scope
- npm 发布（发布清单记录，插件稳定后执行）。
- Pi、Claude Code 或其他 harness 的专用 extension/tool adapter；通用 CLI 的跨 harness 可调用性属于本版本范围。
- 新领域流程语义（kernel/runtime 权威，插件不重新定义 PASS/COMPLETE；pluginv2 只实现已确认的流程边界）。
- 旧 Receipt 自动迁移。
- Authority Registry、Requirement Traceability Matrix、Environment/Oracle Matrix 等独立治理制品。
- Worker Evidence 全面 JSON 化或完整 Host Run Ledger。
- 长期维护 legacy/new 双流程配置。
- 从任意 Markdown 正文推断或执行 Runtime 命令。
- Windows/macOS 完整验证（代码注意跨平台，验收以 Linux 为准）。
- 非 ProofLoop 项目中的任何 ProofLoop 行为（doctor 除外）。

### Later versions
- npm 发布；OpenCode Plugin 完善；各 harness 的示例 Agent 定义与更多插件化能力。

## 11. Product Stage Candidates（产品价值边界，不是技术任务）
| Candidate | User-visible objective | Product boundary | Out of scope | AC refs |
|---|---|---|---|---|
| P1 可安全加载 | 用户可在 ProofLoop 项目中启用插件，普通项目不受影响 | 安装/检测/版本锁/诊断/角色边界 | 业务流程执行 | FR-001/006/007/013 |
| P2 可审计规划 | 用户能看到候选计划、验收范围和是否获准执行 | 需求到计划的可追踪边界、明确认可、无隐式迁移 | Worker 实现 | FR-002/017/018 |
| P3 可恢复执行 | 用户能按单动作推进任务并获得证据、阻断和恢复结果 | Worker/Evidence/Admission/Context/恢复 | 项目最终验收 | FR-003/008/009/011/016 |
| P4 可独立收口 | 用户能获得独立 CV、Stage Gate、Stage Review 和 Project Acceptance 结论 | 验证、修复、集成、评审和项目验收 | 发布与更多宿主 | FR-004/005/014/015 |
| P5 可受控切换 | 维护者在 pluginv2 满足切换 Gate 后才切换，失败时可回退 | parity、恢复、安全边界、旧路径回退 | 隐式旧制品迁移 | FR-014/016/018 |
| P6 通用 CLI 自举 | 用户可在不同 harness 中让 Agent 调用同一 CLI 完成机械流程 | 角色 Context、结果保存、转换检查、恢复、S10 self-host | harness 专用工具适配 | FR-003/004/005/006/016/017/019 |

## 12. Risks and edge cases
- **opencode plugin API 能力边界**（工具权限、钩子生命周期、agent 身份、取消）——OC-0 Spike 必须前置验证；若宿主不支持某能力，用运行时校验兜底（FR-007 已含）。
- **非 ProofLoop 项目误触发**——检测标识严格；默认不扫描全仓库。
- **Token 基线测量**——插件完成后用同一 fixture 对照 CLI 方案测量；若旧方案基线不可复现，用记录数据或文档说明。
- **多项目/会话切换**——Host Context Adapter 使用 worktree 根作为信任根，禁用裸 process.cwd()。
- **服务进程泄漏**——Process Runner 强制超时 + 进程树清理 + cleanup（runtime 已实现）。
- **权威重复或过期**——如果 PRD、Tech Spec、candidate、Manifest、Receipt 或 progress 描述冲突，以对应事实域的唯一权威为准；影响性变化必须让下游结果失效并重新验证。
- **pluginv2 切换过早**——Contract Foundation、parity、恢复、Gate/Review 或 Project Acceptance 未完成时保持 `plugin` 回退，不删除旧路径。
- **把 OpenCode tool 当通用 CLI**——S10 必须从普通命令行进程证明全部机械操作；Host tool
  只能作为后续 parity 入口，不能作为 CLI 缺口的替代品。
- **角色输入一刀切**——不同 Agent 必须由 CLI/Runtime 从相同持久事实生成各自最小 Context；
  不允许把完整 PRD、Plan 或通用原文包复制给所有角色。

## Rollout / Migration
- 本地加载：开发期将插件放入项目级 `.opencode/plugins/**`（或用户级 `~/.config/opencode/plugins/**`），由 opencode 自动加载；发布版在 `opencode.json` 的 `plugin` 数组中填写 npm 包名。发布要求（固定版本、tag、changelog、SHA-256、无 install 脚本、Bundle）记录为发布清单，本版本不执行。
- `pluginv2` 在切换 Gate 前保持受控实验和 `plugin` 回退；S10 先以通用 CLI 自举，后续再完善 OpenCode Plugin。CLI 不自动迁移旧 Receipt、Manifest 或 Stage；切换时必须有明确的迁移/回退决定，不以文档或 checkbox 宣称完成。

## Legal / Privacy / Security
- 无敏感数据处理；网络 deny-by-default；Receipt 不可变写入（digest + chain）。

## 13. Glossary
| Term | Simple explanation |
|---|---|
| ProofLoop | AI 编码流程框架：阶段 → Stage → Slice → Task，配机械校验与证据 |
| Kernel | 领域规则包（状态机、契约、Receipt 校验） |
| Runtime | 应用服务包（reconcile、admit、next-action、process runner） |
| Receipt | 不可变证据文件（digest + chain），机器权威 |
| Manifest | 阶段清单（slices、tasks、proof obligations、runtime proof） |
| Gate | 阶段闸门（runtime proof 步骤执行与判定） |
| Hook | opencode 宿主生命周期钩子（事件回调） |
| Tool | opencode 自定义工具（插件向 agent 暴露的调用面） |
| Harness | 承载 Agent 的宿主，例如 OpenCode、Pi 或 Claude Code |
| 通用 CLI | 不依赖 harness 工具 API，由不同 Agent 直接调用的同一组 ProofLoop 命令 |
| 机械执行 | 引用解析、状态派生、Context 投影、制品检查、结果受理和本地持久化；不包含 AI 语义判断 |
| Parity | 同一输入在不同入口（CLI/插件）产生一致输出 |
| Context Projection | Runtime 按当前动作生成的最小工作上下文，不是完整 Prompt 或第二事实源 |
| Stage Plan admission | Runtime 对计划、Manifest、独立验证和代码 snapshot 的明确认可边界；未认可不能执行 |
| pluginv2 | 新的受控 ProofLoop 流程；完成切换 Gate 前不是旧流程的隐式替换 |

## 14. Decision ledger

### Confirmed
- 基于新 runtime（packages/kernel + packages/runtime）；旧 runtime 退役。
- `ProofLoop_pluginv2_流程优化方案.md` 作为当前用户需求参考；其中技术细节按事实域迁移到 Tech Spec，不与 PRD 重复。
- 方案的切换 Gate 和最终目标流程作为 pluginv2 的交付边界输入；未满足前不切换、不自动迁移。
- 阶段 C 完整走 Brain 流程；OC-0..OC-6 映射 6 个 Stage。
- 开发期本地插件放入 `.opencode/plugins/**`（或用户级 `~/.config/opencode/plugins/**`）；`opencode.json` 的 `plugin` 数组只接受 npm 包名（2026-08-03 根据官方文档与本地实证更正）。
- Project E2E Gate Receipt 类型使用 kernel 闭集中的 `PROJECT_E2E_PASS` / `PROJECT_E2E_FAIL` / `PROJECT_E2E_BLOCKED`（2026-08-03 根据 kernel 与 Contract Matrix 对照更正）。
- S10 先交付 harness-neutral 通用 CLI；OpenCode、Pi、Claude Code 等 harness 只调整 Agent
  定义，不调整 CLI 工具；OpenCode Plugin 完善后置（用户 2026-08-09 确认）。
- S10 使用通用 CLI 自举机械流程；CLI 按角色生成不同 Context、保存结构化 AI 结果并在
  阶段转换前检查制品（用户 2026-08-09 确认）。
- S10 final Plan boundary 前先执行一次性 S09 bootstrap，补齐 executable Runtime Proof
  与 pristine Evidence refresh；S10 必须实际执行 proof step，不能沿用 all-skipped
  `not_applicable`（用户 2026-08-09 确认）。
- Runtime Stage 使用 `S` 加数字的稳定编号；bootstrap 为 `S09`，通用 CLI 为 `S10`。旧
  `S08B0`/`S08B` 标签只保留为历史导航，不进入执行请求（用户 2026-08-09 确认）。

### Inferred
- 包名 @proofloop/opencode-plugin；版本从 0.1.0 起步。

### Decided During Intake
- 开发期本地加载验收，npm 发布记录清单、后续执行（用户确认）；此前“`opencode.json` 指向本地路径”的表述废止。

### Open
- 最小 opencode 版本 / API 能力边界 → OC-0 Spike 验证。
- 旧 .agents/runtime 删除时点 → 阶段 C 后期（完成定义达成时）。
- token 基线测量方式 → 插件完成后对照测量。
- 方案中哪些内部流程边界需要转成最终用户可见的产品承诺 → 影响后续 PRD 验收措辞；当前采用“用户可观察结果进入 PRD，内部实现留在 Tech Spec”的默认。
- pluginv2 正式切换的负责人和发布时间 → 影响旧 `plugin` 回退路径的关闭时点。

### Optional / Non-blocking
- CLI 独立包 vs 内嵌（保持内嵌）。
- Windows/macOS 验证（Linux 验收）。

## 15. Readiness for next step
**Ready for S09 bootstrap planning** — 用户已确认 harness-neutral 通用 CLI、CLI-first
自举与一次性 executable Runtime Proof bootstrap；产品语义无未决项，当前阻塞是技术能力和
Stage Plan，不得继续使用旧 S08B/S10 的 `not_applicable` Manifest。

Recommended next step:
1. 完成 AWI-024 / S09 restricted bootstrap 的规划与 admission；
2. S09 完成后 replan/recompile S10，并通过 Runtime refresh 当前 pristine Evidence；
3. S10 Manifest 含真实 executable proof 后，才建立 final boundary、fresh SPV 和 admission。
