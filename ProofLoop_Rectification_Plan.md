# ProofLoop 整改执行计划 (基于 v2 方案)

根据 `ProofLoop_OpenCode_OpenSpec_Rectification_v2.md` 的内容，当前 ProofLoop 的核心痛点在于**重文档硬阶段流程**带来的阻塞。为将体系回归到“轻量流动”的 OpenSpec 基线，同时保留“AI必须证明完成”的价值，特制定以下分阶段的实施计划。

整改的核心原则是：**不把 ProofLoop 改成更少文档，而是改造成按风险触发的动态门禁、证据协议结构化、失败归因精确的治理层。**

---

## 0. 执行护栏与基线约束
在执行任何 Change 前，必须确保**不破坏**以下基线约束：
1. **OpenSpec 基线**：
   - 绝不绕开 `proposal -> specs -> design -> tasks -> apply -> archive` 的 artifact 生命周期，而应通过 schema/template/rules 调整它们。
   - `openspec status --json` 是 artifact 状态唯一来源，Propose/Executor 不应靠猜测。
   - `openspec instructions <artifact> --json` 是动态指导来源。
   - 不能把 `openspec validate --strict` 结构校验伪装成实现就绪 (implementation readiness)。
   - 必须尊重 `tasks.md` 的 checkbox tracking。
   - Archive 只能由 `openspec archive` 完成，Reviewer 不能越权。
2. **OpenCode 机制基线**：
   - 必须保持 Primary agents (Brain) 与 subagents 的严格分离。
   - Executor 必须将 Worker/Code Verifier/Committer 的输入打包清楚（Evidence Packet），不能让子代理自己去“读整个世界”或上下文找证据。
   - 严格控制子代理权限极小化。
   - `AGENTS.md` 仅保持短小、稳定、路由级，不放入执行细节。
   - Evidence 默认走结构化 dispatch/response Packet 与 canonical evidence channels 传输，不强制落实体物理文件（长任务/强审计等情况除外）。

---

## 执行步骤清单

### 阶段一：修复证据协议 (Change 1: repair-evidence-protocol)
**优先级：最高** (解决当前 TDD evidence 频频被误判导致代码重做的痛点)
*   **目标**：通过结构化的 Evidence Packet 替代子代理自己“找证据”，并引入 Backfill 机制。
*   **涉及修改**：
    *   `.agents/contracts/executor-dispatch-packets.md`: 新增 Evidence Packet 结构、Worker Evidence Backfill 结构、Verification 结果分类。
    *   `.opencode/agents/executor.md`: 将 Executor 改造为 Evidence Broker，明确根据 Defect 类型决定下一步。
    *   `.opencode/agents/worker.md`: 支持 Evidence Backfill 模式，规范 TDD evidence 必须结构化输出。
    *   `.opencode/agents/code-verifier.md`: Code Verifier 必须基于 Evidence Packet 审查，缺失 Packet 直接阻塞，不允许因缺失证据而重做代码。
    *   `.agents/skills/test-driven-development/SKILL.md`: 增加 `OpenCode Worker non-interactive mode`，明确以 Task Packet 为批准源，不再向用户提问。
    *   `.agents/skills/openspec-apply-change/SKILL.md`: 对齐 Executor 的边界、证据和 dispatch 行为，防止新旧规则打架。
*   **验收标准**：
    *   Worker TDD evidence 必须结构化输出。
    *   Executor 必须组装 Evidence Packet。
    *   Code Verifier 不再“找证据”，只验证 Evidence Packet。
    *   Evidence missing 不触发 Worker code repair。
    *   支持 Evidence Backfill。

### 阶段二：降低门禁误杀率 (Change 2: downgrade-readiness-gates)
**优先级：高** (减少文档与现实审查时的反复阻塞)
*   **目标**：将二元(PASS/FAIL)审查重构为灵活的 `BLOCKER / WARNING / NOTE` 分级，只有真正影响执行的才阻塞。
*   **涉及修改**：
    *   `.opencode/agents/spec-verifier.md`: 结果状态改为 `BLOCKED | READY_WITH_WARNINGS | READY`。
    *   `.opencode/agents/reality-verifier.md`: 聚焦矛盾(Contradiction)，未验证(unverified)的状态不再默认阻塞流程。
    *   `openspec/QUALITY-GATE.md`: 按 Blocker, Warning, Note 进行分类，拆分为多个专注于特定 Gate 的独立文件 (如 gates/propose-readiness.md, gates/reality-readiness.md)，并在此文件保留索引。
    *   `.agents/skills/openspec-propose/SKILL.md` 与 `.opencode/agents/propose.md`: 同步调整调用方的状态兼容，使其能够解析 `BLOCKED / READY_WITH_WARNINGS / READY` 的新状态，避免因旧的硬编码（PASS/FAIL）引发流程崩溃。
*   **验收标准**：
    *   Spec Verifier 输出 BLOCKED / READY_WITH_WARNINGS / READY。
    *   Reality Verifier 输出 BLOCKED / READY_WITH_RISKS / READY。
    *   `unverified` 不默认阻塞。
    *   格式问题不阻塞，除非影响执行契约。

### 阶段三：引入动态证明姿态 (Change 3: introduce-proof-posture)
**优先级：高** (让系统根据风险强度自适应，减少简单任务的流程负担)
*   **目标**：取消固定死板的全局门禁，由 Brain 按 `P0(Fast Proof)` / `P1(Stage Proof)` / `P2(Audit Proof)` 下发任务。
*   **涉及修改**：
    *   `.opencode/agents/brain.md`: Brain 必须在下发时判定并附带 Proof Posture。
    *   `.opencode/agents/propose.md`: 必须读取 `openspec status` / `openspec instructions`，根据 Proof Posture 调整验证强度，P0 默认不跑独立 Spec/Reality 子代理。
    *   `.agents/contracts/dispatch-packets.md`: Dispatch 数据包新增 Proof Posture 字段。
    *   `.agents/skills/openspec-propose/SKILL.md`：调整生成逻辑（注：本阶段先改 agent/contract/skill 的 Proof Posture dispatch 与判定逻辑，Schema 和 Template 的正式分叉和落地随 Change 4/5 联合完成，避免执行时重复修改或依赖混乱）。
    *   `AGENTS.md`: 大幅减重，只保留 authority order、role ownership、proof posture classifier、failure attribution rules。引入 `opencode.json` 的 instructions 特性做外部规则 lazy loading。
*   **验收标准**：
    *   Brain dispatch 必须包含 Proof Posture。
    *   Propose 根据 Proof Posture 决定 verifier 强度。
    *   P0 不默认跑独立 Spec/Reality subagent。
    *   P2 保留强审计。

### 阶段四：独立 ProofLoop Schema (Change 4: fork-proofloop-schema)
**优先级：中** (结构性解耦)
*   **目标**：明确当前的用法实际上是“ProofLoop加强版”，不再伪装成原版的 `spec-driven`。
*   **涉及修改**：
    *   `openspec/schemas/proofloop-spec-driven/**`: 复制并新建官方 schema 结构。
    *   `openspec/config.yaml.example`: 同步更名默认启用的 schema 配置。
    *   `openspec/schemas/README.md` & `README.md`: 标记旧版 `spec-driven` 为 Legacy 兼容。
    *   `install/**`: 默认安装新 schema，提供 legacy 参数。
*   **验收标准**：
    *   新项目默认 `schema: proofloop-spec-driven`。
    *   旧 `spec-driven` 作为 legacy alias。
    *   OpenSpec `schema.yaml` folder/name/config 三者一致。
    *   `openspec schema validate proofloop-spec-driven` 通过。

### 阶段五：精简任务模板 (Change 5: reduce-task-template-noise)
**优先级：中** (降低文档出错率和 Token 消耗)
*   **目标**：减少 `tasks.md` 内每一个 Task 下重复出现的环境、范围、命令说明。
*   **涉及修改**：
    *   `openspec/schemas/proofloop-spec-driven/templates/tasks.md`: 引入 `Slice Contract`，单个任务只列出与 Slice 的不同之处 (Overrides)。
    *   `.agents/skills/openspec-propose/SKILL.md`: 让 Propose 理解并使用 Slice Contract 生成任务。
    *   `.opencode/agents/propose.md` & `.opencode/agents/spec-verifier.md`: 适配基于 Slice Contract 的新审查逻辑。
*   **验收标准**：
    *   tasks 使用 Slice Contract。
    *   task 默认引用 slice contract。
    *   只有 overrides 才写 task-level 差异。
    *   Spec Verifier 接受 slice-level TDD contract。
    *   Code Verifier 能从 Slice Contract + Evidence Packet 验证。

### 阶段六：优化边界提交策略 (Change 6: optimize-boundary-strategy)
**优先级：低** (效率优化)
*   **目标**：减轻高频 Commit 的成本，在小任务中允许快照(diff-snapshot)记录。
*   **涉及修改**：
    *   `.opencode/agents/executor.md`: 基于任务风险灵活选择 Boundary Mode (final | slice | per-task | no-op)。
    *   `.opencode/agents/committer.md`: 支持 `diff-snapshot` 并在不进行 git commit 时返回相应 receipt。
    *   `.agents/contracts/executor-dispatch-packets.md`: 对齐 Boundary Evidence 数据结构。
    *   `openspec/QUALITY-GATE.md`: （同步更新门禁）。
*   **验收标准**：
    *   Boundary Mode 支持 final/slice/per-task/no-op。
    *   P1 默认 slice boundary。
    *   P2 默认 per-task boundary。
    *   Code Verifier 接受 diff-snapshot 作为非审计模式 evidence。
    *   Archive output 仍必须 Committer closure。

### 阶段七：Web Scraper 职责收敛 (Change 7: web-scraper-rectification)
**优先级：低 / 可视情况推迟**
*   **目标**：防止把外部未经验证的研究内容直接热注入 Worker 的执行流程。
*   **涉及修改**：
    *   `.opencode/agents/web-scraper.md`
    *   `.agents/contracts/dispatch-packets.md`
*   **验收标准**：
    *   Web Scraper 仅向 Brain / Propose 提供 `External Research Packet`。
    *   即使本项修改被推迟，现阶段也**严格禁止** Worker 直接调用或消费外部研究输出，必须经由 Propose 沉淀进 OpenSpec artifact 才可执行。
