# ProofLoop `pluginv2` 流程优化方案

> 状态：Contract Foundation 收口草案（尚非最终实施计划）
>
> 本方案已经吸收审查结论：流程方向可以保留，但在删除 Planner、Executor 或精简 Manifest 之前，必须先冻结 Plan、Proof Index、Context Resolver、Runtime Proof 和制品权威边界。

## 1. 文档目的

本文重新整理 ProofLoop 的流程优化方案，并以当前 `plugin` 分支已经验证的流程机制和 Plugin Runtime 能力为基础。尚未在 Host 暴露的 S4/S5 能力属于 `pluginv2` 的后续契约工作，不视为当前能力。

本方案的目标不是在现有流程上继续叠加新的治理制品，而是进行一次明确的减法式重构：

- 保留已经有效的权威准备、TDD、Evidence、CV、Stage Gate、Stage Review 和 Project Acceptance 机制；
- 删除同一信息在 Skill、Brain Contract、Planner、`tasks.md`、Manifest 和 Dispatch Packet 之间的重复复制；
- 删除 Planner 和 Executor 作为独立 Agent 所产生的额外会话、上下文和调度成本；
- 将确定性的流程推进、状态恢复和上下文投影迁移到 Plugin Runtime；
- 将新流程放在 `pluginv2` 分支中完成，当前 `plugin` 分支在开发期间保持可用；
- `main` 分支只作为稳定回退和 CV 工作方式参考，不作为新流程的实现基础。

本方案不是当前 `plugin` 分支的直接实施计划。`pluginv2` 是一个新的流程和运行契约实验，必须先完成 Contract Foundation，再进入破坏性重构。

### 1.1 设计原则：最小必要（奥卡姆剃刀）

本流程的每个功能、门禁、机制和治理制品都必须满足最小必要原则：

- **只添加必要的**：新增任何机制前，必须能说明它防止了哪个真实失败（有实际证据或先例），否则不添加；
- **删除不必要的**：已有机制若经实践证实不再必要（无它流程同样正确运行），应删除而非保留；
- **优先复用**：已有机制能覆盖的场景，不另设新机制（如 transition check 未实现时，各环节自带校验已覆盖，则不再实现汇总型入口）；
- **纸面要求即缺陷**：文档声明了但从未被任何实际执行路径使用的能力，视为过度设计候选，应评估删除或实现，不得长期悬空。

执行案例（2026-08-13）：S10 回填中发现 `transition check` 域在契约/方案/任务目标中均有声明，但从未实现，且 S1~S11 均在其缺席下正常完成（各环节自带校验已覆盖）——判定为过度设计，决定删除（登记于 progress.md 受限关闭记录）。

---

## 2. 已确认的边界

### 2.1 分支边界

| 分支 | 定位 |
|---|---|
| `main` | 稳定流程；可随时回退；仅参考其中成熟的 CV 反驳方法 |
| `plugin` | 当前 Plugin 流程；在 `pluginv2` 开发期间保持可用 |
| `pluginv2` | 新的实验性优化流程；从 `plugin` 创建；允许破坏性重构 |

`pluginv2` 不需要在运行时长期兼容旧 Planner、旧 Executor、旧 Manifest 或旧 Stage。

开发失败或新流程尚未完成时，直接回到 `plugin`。新流程通过完整验收后，再切换使用 `pluginv2`。

### 2.2 本轮保留的机制

本轮不重构以下核心机制：

- PRD 和架构权威准备；
- Hard Part 验证；
- TDD Skill；
- Plan 阶段初始化每个 Slice 的 Evidence 文档；
- Worker 填写 Task Evidence；
- Worker 在 `finalize-slice` 填写 Current Slice Evidence；
- Evidence 先写、Task checkbox 后更新；
- CV read-only；
- CV 先独立反驳，再读取 Worker Evidence；
- fresh CV；
- bounded recheck；
- Stage Gate；
- Stage Reviewer；
- Stage Close；
- Project Acceptance；
- Receipt 和 digest 约束。

上述机制保留的是语义和安全边界，不代表所有正文、字段或工具接口原样保留。任何精简都必须由新的机器可解析引用、digest 和 Context Projection 闭环替代。

### 2.3 本轮明确不做

- 不改变 `main` 分支；
- 不把 `main` 的整个流程迁移到 `pluginv2`；
- 不新增 CV 结果可信度裁决 Agent；
- 不新增 Authority Registry、Requirement Traceability Matrix、Environment/Oracle Matrix 等治理制品；
- 不把 Evidence 全面 JSON 化；
- 不删除 Worker Evidence；
- 不建设完整 Host Run Ledger；
- 不长期维护 legacy/new 双流程配置；
- 不自动迁移旧 Stage；
- 不在 Contract Foundation 完成前删除现有 PO、Outcome、Public Seam、Risk 或 Runtime Proof 的机器可验证信息。
- 不让 Runtime 从任意 Markdown 正文解析并执行命令。

### 2.4 当前 `plugin` Host 工具基线

`pluginv2` 的工具设计必须以当前真实 Host 工具为基线，而不是假设存在独立的 `proofloop_next` 工具。

当前工具表面：

```text
proofloop_doctor
proofloop_plan
  - validate
  - compile
  - initialize_evidence
  - status
  - admit_spv_result
proofloop_stage
  - status
  - next
  - admit_worker_result
  - admit_cv_result
  - admit_slice_commit
  - admit_integration
proofloop_review
  - stage_status
  - prepare_stage_review
  - finalize_stage_review
```

当前明确缺少或未在 Host 暴露的能力包括：

- Stage Plan admission；
- `run_gate` 和 Gate Result admission；
- Project Acceptance 工具；
- 通用 Worker/CV/SPV/Reviewer Context Resolver。

这些能力是 `pluginv2` 的新契约工作，不得通过旧 CLI 或手工写 Receipt 绕过。

### 2.5 `pluginv2` Host Surface 原则

`pluginv2` 不新增大量细粒度工具。继续使用粗粒度工具边界，并扩展其 operation：

```text
proofloop_plan
  + admit_stage_plan          # vNext：Stage Plan admission
  + Context/Proof Index 相关只读投影

proofloop_stage
  + next                       # 返回结构化 NextAction + ContextRef
  + admit_worker_result
  + admit_cv_result
  + admit_slice_commit
  + admit_integration
  + run_gate                   # vNext：Runtime Gate execution/admission

proofloop_review
  + prepare_stage_review
  + finalize_stage_review

proofloop_project              # vNext：Project Acceptance
  + status
  + compile_acceptance
  + run_e2e
  + prepare_project_review
  + finalize_project_review
```

`proofloop_project` 的 operation 是闭合集合；未列出的 operation fail closed，不通过
自然语言参数扩展。

Context Resolver、Proof Index Resolver 和状态协调器优先作为 Runtime 内部服务，不注册为新的顶层工具。Worker、CV 和 Reviewer 可以继续不直接持有写入工具；Brain 只转交其结构化返回给 Runtime admission。

---

## 3. 当前 `plugin` 流程的主要重复

当前流程中的主要问题不是缺少信息，而是相同信息被多次改写和复制。

```text
PRD / Architecture / Contract / Hard Parts
        ↓
task-acceptance-matrix 再写一次工作、验收和禁止项
        ↓
Brain Stage Selection 再整理一次
        ↓
Brain → Planner Contract 再传递一次正文
        ↓
Planner 在 tasks.md 再写一次
        ↓
Manifest 编译器再复制一次
        ↓
Executor 为 Worker/CV Packet 再复制一次
```

这会带来：

1. Token 消耗；
2. 多 Agent 会话等待；
3. 同一语义在不同文件中漂移；
4. Plan 阶段承担过多架构职责；
5. Manifest 变成 `tasks.md` 的 JSON 副本；
6. Worker/CV Packet 过大；
7. 恢复流程需要读取和比对大量重复制品。

---

## 4. 优化后的权威与制品模型

## 4.1 单一事实源 + 派生投影

每类语义事实只允许一个主要权威来源；下游可以存在派生投影，但派生投影不能反向授权状态迁移。

| 信息类型 | 主要权威来源 |
|---|---|
| 用户、范围、产品行为、验收标准、非目标 | `PRD.md` / PRD Context |
| 架构边界、组件职责、运行流程、基础命令 | `tech-spec/ai-coding-architecture.md` |
| API、事件、文件、状态、错误、运行接口、验证方式 | `tech-spec/contract-state-matrix.md` |
| 风险、禁止捷径、最低可接受实现、残余风险 | `tech-spec/hard-parts-register.md` |
| 项目级架构工作项、工作依赖、权威引用 | `tech-spec/task-acceptance-matrix.md` |
| Admission 前的 candidate Stage/Slice/Task 分解 | `delivery/stages/<stage-id>/tasks.md` 的 Plan 区域 |
| Admission 后的 admitted Plan、Proof Index、digest 和运行拓扑 | `.proofloop/manifests/<stage-id>.json` |
| 不可变状态转换和执行事件 | `.proofloop/receipts/**` |
| Worker 的语义证明声明 | `delivery/stages/<stage-id>/evidence/<slice-id>.md` |
| 当前状态缓存 | Runtime State（由 Manifest、Git、Receipts、Evidence 派生） |
| 当前代码事实 | Git snapshot |

下游制品应引用权威位置，不重新复制正文。

这些来源不是跨领域的总排序，而是按事实领域分别生效：产品和技术语义由
Authority Documents 决定；admitted 执行计划由 Manifest 决定；当前代码由 Git
snapshot 决定；已接纳状态转换由 Receipt 决定；Worker 证明声明由 Evidence 决定；
Runtime State 只是由上述事实重建的派生状态。`progress.md`、checkbox 和 Agent
narrative 都不能单独授权状态迁移。

---

## 4.2 精简 `task-acceptance-matrix`

当前 `task-acceptance-matrix` 同时承担工作拆分、文件范围、Definition of Done、Acceptance Evidence、Forbidden Shortcuts 和 Traceability，和后续 Planning 存在明显重叠。

优化后，它只作为项目级 Architecture Work Item 索引。

### 保留

- AWI ID；
- 简短 Work Item Goal；
- 项目级依赖；
- PRD 引用；
- Architecture/Contract 引用；
- Hard Part 引用。

### 删除或迁移

| 当前内容 | 新位置 |
|---|---|
| Files/modules | 不作为权威规划字段；由 Worker 根据权威和代码现实决定 |
| Definition of Done 正文 | PRD 或 Contract 的权威验收位置 |
| Acceptance Evidence 正文 | Contract/Architecture 中的 Verification 或 Acceptance Evidence |
| Forbidden Shortcuts 正文 | Hard Parts |
| 重复 Traceability 文本 | 保留引用关系，不复制正文 |

### 建议结构

```markdown
| AWI ID | Goal | Depends On | Authority References |
|---|---|---|---|
| AWI-024 | OpenCode host 可以加载 ProofLoop Plugin | AWI-020 | PRD#/entities/FR-08; contract-state-matrix#/entities/Plugin-Load; hard-parts-register#/entities/HP-006 |
```

如果某项重要验收或禁止捷径目前只存在于 `task-acceptance-matrix`，应先迁移到正确的权威文件，再精简矩阵。

---

## 5. Brain 工作流优化

## 5.1 Authority Readiness Loop 保留

保留现有逻辑：

```text
PRODUCT_DEFINITION
→ CONDITIONAL_TECHNICAL_CLARIFICATION
→ ARCHITECTURE
→ HARD_PART_VALIDATION
→ AUTHORITY_READY
```

Brain 仍然负责：

- 用户入口；
- 请求分类；
- 权威流程路由；
- Hard Part 处理；
- Stage 选择；
- 全局失效传播；
- Stage Review 和 Project Acceptance 的顶层推进。

## 5.2 Stage Selection 变薄

Brain 不再生成包含大量正文的 Stage Goal Packet。

Brain 只选择当前 dependency-ready 的 AWI：

```yaml
selected_work_item_refs:
  - tech-spec/task-acceptance-matrix.md#/entities/AWI-024
  - tech-spec/task-acceptance-matrix.md#/entities/AWI-025
```

必要时增加：

```yaml
selection_reason:
finding_refs: []
```

Stage Goal、Slice Goal 和 Task Goal 由 Planning Skill 根据所选 AWI 和权威引用生成。

## 5.3 删除 Brain → Planner Agent Contract

Planner Agent 被移除后，当前 Brain→Planner 的 `plan-stage` Contract 不再保留。

Brain 直接调用 Planning Skill。Skill 通过引用读取权威文件，不要求 Brain 在调用参数中复制权威正文。

### Planning Skill 最小输入

```yaml
mode: initial | replan
selected_work_item_refs:
  - tech-spec/task-acceptance-matrix.md#/entities/AWI-024
authority_entity_refs:
  - PRD.md#/entities/FR-008
  - tech-spec/ai-coding-architecture.md#/entities/Plugin-Load
  - tech-spec/contract-state-matrix.md#/entities/Plugin-Load-Verification
  - tech-spec/hard-parts-register.md#/entities/HP-006
existing_plan_ref: null
finding_refs: []
```

文件级 `authority_root_refs` 只能作为信任根或 allow-list，不能要求 Planning Skill 每次读取整套 PRD、Tech Spec 和 Hard Parts。实际计划输入应使用稳定的 entity reference，并由 Context Resolver 解析和绑定 digest。

---

## 6. Planning Skill 的职责

Planning Skill 只生成 Plan 阶段真正新增的信息。

### 6.1 允许生成

- Stage 数量和 Stage 边界；
- Stage Goal；
- Slice 边界；
- Slice Goal；
- Task 边界；
- Task Goal；
- 每个 Stage/Slice/Task 使用的权威引用；
- Slice 的必要依赖；
- Required Skills。

### 6.2 禁止生成

- 实现方法；
- 要修改或创建的代码文件；
- 类型、类、函数或模块设计；
- 已存在的产品验收正文；
- 已存在的接口和状态定义；
- 已存在的 Hard Part 正文；
- 重复风险事实；
- 重复 Runtime 命令；
- 完整 PO 表格；
- 完整 Proof Plan；
- Worker 实现步骤；
- CV 实现细节。

### 6.3 Plan Gap 与 Authority Gap

Planning Skill 不得用 Plan 补写缺失的产品或架构事实。

| 缺口 | 返回 |
|---|---|
| 缺少产品行为或验收标准 | `AUTHORITY_GAP / MISSING_ACCEPTANCE_AUTHORITY` |
| 缺少可观察的真实边界 | `AUTHORITY_GAP / MISSING_VERIFIABLE_BOUNDARY` |
| 缺少可执行验证定义 | `AUTHORITY_GAP / MISSING_EXECUTABLE_ACCEPTANCE` |
| 验证是否可行尚不确定 | `TECHNICAL_UNKNOWN / VERIFICATION_FEASIBILITY_UNKNOWN` |
| Stage 无法合理分解 | `PLAN_GAP / STAGE_NOT_DECOMPOSABLE` |

---

## 7. PO、Seam、Risk 和 Runtime Proof 的处理

## 7.1 Proof Obligation

不再由 Plan 创建和复制完整 PO 正文，但不能删除验证结构。

当前 Validator、SPV、CV 和 Gate 仍需要知道：

- 要证明的行为；
- 使用哪个真实接口边界；
- 独立 Oracle 是什么；
- 成功和失败如何观察；
- 哪些禁止捷径适用。

因此 `pluginv2` 使用最小 Proof Index，而不是空的引用列表。Proof Index 是 CV 的
确定性输入，不包含验证等级或 Profile 选择信息。

产品行为和验收标准来自：

- PRD；
- Contract Verification；
- AWI 引用的 Acceptance；
- Hard Part Acceptance Evidence。

Plan 只建立闭环引用：

```text
Task
→ Slice Goal
→ Acceptance References
→ Oracle/Seam References
→ Risk References
```

SPV 反向检查：

```text
Tasks 完成是否足以实现 Slice Goal？
引用的权威验收条件成立是否足以证明 Slice Goal？
所有 Slice Goal 成立是否足以实现 Stage Goal？
```

如果权威文件没有足够验收信息，返回 Authority Gap，不在 Plan 中发明 PO。

### 7.1.1 Proof Index 唯一 Schema

`pluginv2` 只接受一种机器可解析的 Proof Index 表达。所有引用先注册到当前
Manifest 的 `reference_index`，Proof Index 只保存稳定的 `ref_id`，不再同时接受
字符串 ref、带 digest 的对象或“等价索引”三种形式。

```json
{
  "kind": "goal | task | acceptance | seam | oracle | risk | proof_spec",
  "ref": "<root-relative-path>#/entities/<entity-id>",
  "file_digest": "...",
  "section_digest": "..."
}
```

`reference_index` 的对象 key 就是 `ref_id`；Descriptor value 不重复保存 id。

每个 Slice 的 Proof Index 固定提供：

```json
{
  "slice_id": "S04-A",
  "goal_ref": "REF-001",
  "task_refs": ["REF-002"],
  "acceptance_refs": ["REF-003"],
  "seam_refs": ["REF-004"],
  "oracle_refs": ["REF-005"],
  "risk_refs": [
    {
      "ref_id": "REF-006",
      "applies_to_acceptance_refs": ["REF-003"],
      "applies_to_seam_refs": ["REF-004"]
    }
  ]
}
```

`risk_refs` 中的绑定必须指向同一 Proof Index 已列出的 Acceptance 和 Seam；CV
可以对已索引但不适用于当前 diff 的风险返回
`applicability: NOT_APPLICABLE` 及原因，但不得自行扩展 Risk Reference。

`goal_ref` 和 `task_refs` 用于范围与覆盖核对，其他 refs 用于构造 CV 的最小充分
反驳上下文。Runtime 在 Context Resolver 阶段解析 `reference_index` 并绑定 digest；
CV 消费解析后的 Context，不自行搜索整套 Authority 或用 Worker 叙事补全缺失信息。

SPV、CV、Gate 和 Stage Reviewer 从 Proof Index 解析自己的最小 Context；它们不自行搜索整套权威文件，也不依赖 Agent 叙事补全缺失的验收信息。

Proof Index 缺失必要的 Acceptance、Seam 或 Oracle 时，CV 不进入正常验证，返回：

```yaml
verdict: REPLAN
route_code: PLAN_GAP
subtype: INCOMPLETE_PROOF_INDEX
```

如果缺失内容实际属于上游 Authority，则返回：

```yaml
verdict: BLOCKED
route_code: AUTHORITY_GAP
subtype: MISSING_VERIFICATION_AUTHORITY
```

## 7.2 Public Seam

Seam 应由 Architecture 或 Contract 权威定义。

Plan 只选择 Seam 所在的权威引用，不复制 Seam 正文：

```markdown
### Authority References

- `tech-spec/contract-state-matrix.md#/entities/Plugin-Load-Contract`
```

如果权威文件没有真实、可观察的接口边界，返回：

```yaml
route_code: AUTHORITY_GAP
subtype: MISSING_VERIFIABLE_BOUNDARY
```

## 7.3 Risk

Risk 不是 Plan 新信息。

风险来源：

- Hard Part；
- Contract 的 migration/auth/persistence/external integration 等属性；
- 实际 Worker diff。

建议在权威文件中使用稳定的机器风险标签，例如：

```markdown
Risk Tags:
- cross_process_behavior
- external_side_effect
```

Plan 只引用相关 Hard Part 或 Contract，并把具体风险边界放入 Slice 的
`risk_refs`。Risk References 只用于识别 CV 必须攻击的相关行为，不参与等级计算、
验证流程升级或整套额外检查的加载。CV 根据 Slice Goal、Proof Index、Authority
Context、当前代码、测试、实际 diff 和 snapshot，自主选择与当前行为直接相关的
最小充分反驳集合。

例如：

```text
authorization
→ 尝试未认证访问、跨主体访问和权限提升反例

persistent_state
→ 尝试保存、重新加载、修改、删除和数据一致性反例

concurrency
→ 尝试竞争、重复执行、原子性和数据损坏反例

cross_process_behavior
→ 尝试进程边界、取消、中断和资源清理反例

external_side_effect
→ 尝试失败恢复、重复副作用和部分完成反例
```

Planning Skill 不手写重复风险事实，也不选择验证模式；与 Slice 行为无关的风险
不得仅因抽象标签存在而进入当前验证范围。

## 7.4 Runtime Proof

不再在 `tasks.md` 中复制完整 Build/Start/Probe/Stop 命令。

命令的验证语义来自：

- Architecture Technical Context；
- Runtime Flows；
- Contract Verification；
- AWI 引用的 Acceptance Evidence。

Plan 只生成 Stage 特有的选择和顺序，例如：

```yaml
gate_ref_ids:
  - REF-008
  - REF-005
```

Authority Oracle 只声明必须观察的行为，不负责从自然语言推断命令。可执行验证
必须先存在结构化 `ProofSpecification`，再由 Runtime Proof Resolver / Validator
解析、校验并绑定 digest；Runtime 不得从任意 Markdown 正文生成或拼接命令。

```json
{
  "id": "proof-plugin-load",
  "type": "command | service_probe | file_assertion",
  "executable": "node",
  "args": ["..."],
  "cwd": "...",
  "timeout_ms": 30000,
  "expected": {
    "exit_code": 0,
    "stdout_contains": ["..."],
    "stderr_empty": true
  },
  "service_ref": null,
  "readiness_signal": null,
  "cleanup": {
    "executable": "node",
    "args": ["..."],
    "cwd": "...",
    "timeout_ms": 30000
  },
  "authority_oracle_ref": "REF-005",
  "spec_digest": "..."
}
```

`ProofSpecification` 是闭合输入；Resolver 只解析预先定义的结构，不把 Oracle
正文转换成 executable 或 args。缺少结构化 Specification 时返回 Authority Gap，
而不是猜测命令。

当前 RuntimeProofStep 至少需要绑定：

```text
id
type
executable
args[]
cwd
timeout_ms
expected
not_applicable?
service_ref?
readiness_signal?
proof_digest
proof_spec_digest
manifest_digest
authority_oracle_digest
```

执行前必须验证：

- `type` 是闭合集合；
- `executable` 不是 shell；
- `args` 是参数数组，不解析命令行字符串；
- `cwd` 位于 canonical trust root；
- `timeout_ms` 在允许范围内；
- service start/stop 成对；
- 不允许管道、重定向、命令替换和未允许的环境变量；
- Step 绑定当前 Manifest digest、Proof Specification digest 和 Authority Oracle digest。

如果权威文件缺少可执行验证定义，返回 Authority Gap。

## 7.5 Plan Digest 与 Checkbox

`tasks.md` 同时包含不可变 Plan 信息和可变执行投影。Worker 更新 checkbox 不应使 Plan 失效。

```text
Immutable Plan Projection
- Stage/Slice/Task Goal
- Authority/Acceptance/Oracle refs
- Dependencies
- Required Skills

Mutable Execution Projection
- checkbox
- Worker Status
- CV Status
```

Manifest 的 `plan_digest` 必须由规范化 Plan AST 计算，而不是对完整 Markdown 字节计算：

- checkbox 在规范化时排除或统一为未选状态；
- Worker Status 和 Current CV Status 不进入 `plan_digest`；
- Goal、refs、dependencies、Required Skills 变化会改变 `plan_digest`；
- Plan digest 变化会使相关 Plan-dependent Receipt、Evidence 和 CV 失效。

Task 是否完成由 `TASK_COMPLETE` Receipt 和 Evidence/Git 事实证明，checkbox 只是人类投影，不能单独授权完成。

## 7.6 Context Resolver Contract

Context Resolver 是 Runtime-owned 的最小上下文生成器，不是新的治理制品体系。

### Reference Grammar

机器合同中的语义实体统一使用实体引用：

```text
<root-relative-path>#/entities/<entity-id>
```

例如：

```text
PRD.md#/entities/FR-08-acceptance
tech-spec/contract-state-matrix.md#/entities/Plugin-Load-Verification
delivery/stages/S04/tasks.md#/entities/S04-A-T01
```

Markdown 中的实体必须有唯一显式标记，例如：

```markdown
<!-- proofloop:entity id="S04-A-T01" kind="task" -->
```

Resolver 从显式标记确定实体范围；缺失、重复、kind 不匹配或范围含糊时 fail
closed。普通 heading anchor 只用于非实体说明段落，不得用于 AWI、HP、Slice、Task
或表格行定位。

JSON 制品引用：

```text
<root-relative-path>#/<json-pointer>
```

### Resolution Rules

- Markdown heading 转换为稳定 canonical anchor；
- 实体 ID 在项目范围内唯一，不能依赖 heading、表格行或列表出现顺序；
- 引用不存在、重复或含糊时 fail closed；
- 不允许模糊全文搜索作为权威解析方式；
- 所有路径必须 root-bound，并进行 TOCTOU/identity re-check。

### Entity/Section Digest

```text
section_digest = SHA-256(
  canonical_path
  + canonical_entity_ref
  + normalized_section_content
)
```

规范化只统一 UTF-8、换行、anchor 和尾部空白，不得折叠语义正文。

### Context Projection

Context 可以使用 Runtime-owned、content-addressed artifact：

```text
.proofloop/context/<context-digest>.json
```

它必须：

- write-once；
- 可自验证 digest；
- Agent 不可编辑；
- 不进入权威 Receipt chain；
- Receipt 只绑定 `context_digest`；
- 可从 Manifest、Receipts 和 Authority 重新生成；
- 作为派生缓存而非事实权威。

对于 `implement-task`，Context 还必须携带 admitted Plan 中的 immutable
`execution_scope`：`code_paths`、`test_paths` 和 `forbidden_paths`。这些路径必须
root-bound，并参与 Plan/Manifest/Context 的 digest binding；Evidence path 只能作为
额外的 Evidence 写入路径，不能作为实现任务的默认 scope。scope 缺失、为空、越界或
只有 Evidence path 时，Runtime 必须在 `DISPATCH_WORKER` 前 fail closed，而不是把
问题延迟给 Worker。

职责分工固定为：

- Runtime：解析 `reference_index`，验证 root-bound、TOCTOU、file/section digest，生成
  content-addressed Context，并在 dispatch 前 fail closed；
- CV：验证 Context 自身 digest 及其 Manifest、Plan、Proof Index、snapshot 绑定，
  发现不一致时返回 `BLOCKED`，不重复执行完整 Context Resolver。

CV 的 initial Context 是 `pre_refutation` 投影：只包含反驳所需的 Authority
excerpt、代码、测试、diff 和 snapshot，不包含 Worker Evidence 正文或摘要。
`evidence_ref` 只是受门控的地址；只有独立反驳观察结果固定后才允许读取。
Runtime/session state 必须记录 `evidence_read: false | true`，中断恢复时不得跳过
该门控。

### Invalidation

| 变化 | 失效范围 |
|---|---|
| Task Goal 变化 | 当前 Task Context、Task Receipt、后续 Evidence/CV |
| Task execution scope 变化 | 当前 Task Context、Manifest/Plan binding、Task Evidence/CV |
| Slice Goal 变化 | Slice 全部 Task Context、Evidence、CV |
| Proof Index digest 变化 | 相关 Context、Evidence、CV、Gate |
| Acceptance ref digest 变化 | 相关 Task/Slice Evidence、CV、Gate |
| Oracle ref digest 变化 | 相关 CV、Gate |
| Risk ref digest 变化 | 相关 CV、Gate |
| 纯 checkbox 变化 | 不使 Plan 或 Authority Context 失效 |
| 无关 Authority section 变化 | 不使当前 Slice 失效 |

---

## 8. 精简后的 `tasks.md`

`tasks.md` 在 admission 前保存 candidate Plan，在 admission 后作为人类可读执行投影；
admitted Plan authority 只在 Manifest admission Receipt 写入后成立。

文件内部必须区分不可变 Plan Projection 和可变 Execution Projection。checkbox、Worker Status 和 Current CV Status 是执行投影，不参与 `plan_digest`。

```markdown
# Stage S04 — Plugin Host Integration

## Stage Goal

ProofLoop Plugin 可以在真实 OpenCode host 中加载并完成基础流程调用。

## Authority References

- `tech-spec/task-acceptance-matrix.md#/entities/AWI-024`
- `tech-spec/task-acceptance-matrix.md#/entities/AWI-025`

---

## Slice S04-A

### Goal

Plugin 可以加载并注册基础 ProofLoop 工具。

### Authority References

- `tech-spec/contract-state-matrix.md#/entities/Plugin-Load-Contract`
- `tech-spec/hard-parts-register.md#/entities/HP-006`

### Required Skills

- test-driven-development

### Dependencies

- None

### Tasks

- [ ] S04-A-T01 实现 Plugin 加载和工具注册行为。
- [ ] S04-A-T02 实现加载失败时的可观察错误行为。

---

## Slice S04-B

### Goal

Brain 可以通过 Plugin 工具恢复并推进 Stage 状态。

### Authority References

- `tech-spec/contract-state-matrix.md#/entities/Runtime-State-Contract`

### Required Skills

- test-driven-development

### Dependencies

- S04-A

### Tasks

- [ ] S04-B-T01 实现状态读取和下一动作调用行为。
```

### 不再包含

- Observable Outcomes 的重复正文；
- Public Seam 正文；
- 完整 PO 正文表格；
- Proof Plan；
- 风险事实正文；
- Runtime Proof 命令；
- Task→Slice Closure 文本；
- Slice→Stage Closure 文本；
- 预期修改文件；
- 实现方法。

但必须保留或可解析得到：

- `goal_ref`；
- `task_refs`；
- `acceptance_refs`；
- `oracle_refs` / `seam_refs`；
- `risk_refs`；
- Dependencies；
- Required Skills；
- Worker 所需的最小执行字段。

---

## 9. Manifest vNext

Manifest 也必须精简，不能再成为 `tasks.md` 的 JSON 副本。

## 9.1 Manifest 的职责

Manifest 只负责：

- Stage ID；
- 规范化 Plan 引用和 `plan_digest`；
- `reference_index`（所有实体 ref、kind、file/section digest）；
- Slice ID；
- Slice/Task 的 Plan anchor；
- Proof Index（通过 `ref_id` 绑定 acceptance/oracle/seam/risk refs）；
- Required Skills；
- Slice 依赖；
- Evidence path；
- Structured Proof Specification refs、resolved RuntimeProofStep 和 proof digest；
- schema/version 元数据；
- 编译和版本元数据。

## 9.2 示例

```json
{
  "version": 2,
  "stage_id": "S04",
  "plan": {
    "ref": "delivery/stages/S04/tasks.md",
    "plan_digest": "...",
    "schema_version": 2
  },
  "reference_index": {
    "REF-001": {
      "kind": "goal",
      "ref": "delivery/stages/S04/tasks.md#/entities/S04-A-goal",
      "file_digest": "...",
      "section_digest": "..."
    },
    "REF-002": {
      "kind": "task",
      "ref": "delivery/stages/S04/tasks.md#/entities/S04-A-T01",
      "file_digest": "...",
      "section_digest": "..."
    },
    "REF-003": {
      "kind": "acceptance",
      "ref": "PRD.md#/entities/FR-08-acceptance",
      "file_digest": "...",
      "section_digest": "..."
    },
    "REF-004": {
      "kind": "seam",
      "ref": "tech-spec/contract-state-matrix.md#/entities/Plugin-Load-Contract",
      "file_digest": "...",
      "section_digest": "..."
    },
    "REF-005": {
      "kind": "oracle",
      "ref": "tech-spec/contract-state-matrix.md#/entities/Plugin-Load-Verification",
      "file_digest": "...",
      "section_digest": "..."
    },
    "REF-006": {
      "kind": "risk",
      "ref": "tech-spec/hard-parts-register.md#/entities/HP-006-cross-process-cleanup",
      "file_digest": "...",
      "section_digest": "..."
    },
    "REF-007": {
      "kind": "proof_spec",
      "ref": "tech-spec/contract-state-matrix.md#/entities/Plugin-Load-Proof-Spec",
      "file_digest": "...",
      "section_digest": "..."
    },
    "REF-008": {
      "kind": "oracle",
      "ref": "tech-spec/ai-coding-architecture.md#/entities/Technical-Context",
      "file_digest": "...",
      "section_digest": "..."
    }
  },
  "authority_ref_ids": ["REF-003", "REF-004", "REF-005", "REF-006", "REF-008"],
  "slices": [
    {
      "slice_id": "S04-A",
      "proof_index": {
        "slice_id": "S04-A",
        "goal_ref": "REF-001",
        "task_refs": ["REF-002"],
        "acceptance_refs": ["REF-003"],
        "seam_refs": ["REF-004"],
        "oracle_refs": ["REF-005"],
        "risk_refs": [
          {
            "ref_id": "REF-006",
            "applies_to_acceptance_refs": ["REF-003"],
            "applies_to_seam_refs": ["REF-004"]
          }
        ]
      },
      "required_skills": [
        "test-driven-development"
      ],
      "depends_on": [],
      "evidence_path": "delivery/stages/S04/evidence/S04-A.md"
    }
  ],
  "runtime_proof": {
    "spec_refs": ["REF-007"],
    "resolved_steps": [],
    "proof_digest": "..."
  },
  "compiled_by": "pluginv2-runtime"
}
```

## 9.3 Manifest 不保存的内容

- Stage Goal 正文；
- Slice Goal 正文；
- Observable Outcome 正文；
- Public Seam 正文；
- 完整 PO 正文；
- 风险事实正文；
- 未经验证的 Runtime Proof 命令字符串；
- Worker Packet 正文；
- Authority excerpt 副本。

需要内容时，由 Context Resolver 根据 `reference_index`、`ref_id` 和 digests 生成当前
Agent 的最小上下文。

Manifest 不得只保存“空引用”。Proof Index、Runtime Proof digest 和 Plan digest
必须足以让 SPV、CV、Gate、Review 在没有自然语言补全的情况下验证引用闭环。

### 9.4 Manifest 生命周期

```text
Planning Skill 生成 candidate tasks.md
→ Runtime 编译 candidate Manifest
→ Mechanical Validator
→ Runtime 初始化 Slice Evidence skeleton
→ 提交最终 Plan/Evidence Git boundary（canonical root，worktree clean）
→ Fresh SPV
→ Runtime admit_stage_plan（再次校验 snapshot = 当前 Git HEAD 且 worktree clean）
→ Stage Plan Receipt
→ Manifest 成为 admitted Plan authority
→ tasks.md checkbox/status 仅作为人类执行投影
```

Admission 前，`tasks.md` 是 candidate plan source，Manifest 是 candidate compiled
projection；Evidence skeleton 是 candidate 的路径/结构制品；`SPV_PASS` 是 admission
前置条件，不单独使 Manifest 成为执行权威。最终 Plan/Evidence Git boundary 必须在
Fresh SPV 前完成，且 SPV/admission 绑定同一 clean Git HEAD。只有 Stage Plan admission
Receipt 写入后，Manifest 才能授权后续执行。

`PLAN_READY` 后，如果 Authority、Plan、Manifest binding 和 snapshot 未变化，执行阶段
继续消费既有 admission，不重复 SPV；真实 HEAD/snapshot、Plan 或 Authority 变化必须
fail closed 并重新 fresh SPV。

如果 Plan 发生实质变化：

1. 生成新的 Manifest；
2. 生成新的 `plan_digest`；
3. 使相关 Plan-dependent Receipt、Evidence 和 CV 失效；
4. 重新执行 Validator、SPV 和 Stage Plan admission；
5. 禁止通过修改旧 Manifest 或旧 Receipt 恢复状态。

### 9.5 Schema Cutover

`pluginv2` 可以不兼容旧 Manifest，但必须显式区分版本：

- Manifest 声明 `schema_version: 2`；
- `.proofloop/runtime.lock` 声明匹配的 pluginv2/runtime/schema 版本；
- 旧 Manifest、旧 Receipt 或旧 Stage 不得被静默解释为 vNext 事实；
- 版本不匹配时 fail closed，并返回结构化 Finding；
- 不提供隐式旧 Stage migration；
- pluginv2 的所有新 Fixture 必须从干净的 vNext 项目初始化。

---

## 10. Evidence 策略

## 10.1 本轮保留现有 Evidence 规则

本轮不重构 Evidence 模型。

继续保留：

1. Plan/Runtime 为每个 Slice 初始化 Evidence 文档；
2. Worker 每个 Task 完成后填写 Task Evidence；
3. Evidence 写入后才更新 Task checkbox；
4. 所有 Task 完成后执行 `finalize-slice`；
5. Worker 在 `finalize-slice` 更新 Current Slice Evidence；
6. repair/diagnose 更新当前证据，不追加冗长历史；
7. CV 不修改 Evidence；
8. CV Status 由 Runtime 维护；
9. CV 将 Worker Evidence 视为待反驳声明。

Worker Evidence 继续保留以下最小语义内容：

- Task ID；
- Acceptance References covered；
- RED command 和实际失败观察；
- GREEN command 和实际行为观察；
- 相关真实 Seam；
- 已知限制；
- 无法验证的内容。

Worker Evidence 不包含验证等级、Profile 选择或 Profile Evidence；Worker 不负责
选择 CV 模式、验证范围或反例集合。

## 10.2 为什么本轮不采用混合 Evidence 重构

当前系统还没有完整、可靠的 Host Run Ledger，无法自动持久化并证明：

- RED 确实发生在实现前；
- RED 是目标行为缺失，而不是编译或配置错误；
- 某项测试证明了哪项权威要求；
- Worker 声明的观察和实际业务含义一致。

因此，Worker Evidence 仍然是必要的语义输入。

机械事实可以被 CV 和 Runtime 重新检查，但本轮不拆分 sidecar 或重写 Evidence Schema。

## 10.3 Manifest 精简后的必要适配

Evidence skeleton 可以把原有的重复上下文：

```text
Slice Goal
Public Seam
```

改为：

```text
Plan Ref
Authority References
Plan Digest
Manifest Digest
```

但保留主体：

```text
Task Evidence
Current Slice Evidence
Current CV Status
```

---

## 11. 新的 Stage Delivery Loop

```text
Brain 选择 dependency-ready AWI
→ Brain 调用 Planning Skill
→ Planning Skill 生成精简 tasks.md
→ Runtime 编译 candidate Manifest
→ Mechanical Validator
→ Runtime 初始化 Slice Evidence skeleton
→ 提交最终 Plan/Evidence Git boundary（canonical root，worktree clean）
→ Fresh SPV
→ Runtime admit_stage_plan：SPV_PASS / PLAN_READY + 当前 HEAD/clean 校验
→ Manifest admission Receipt
→ Brain 调用 proofloop_stage({ operation: "next" })
→ Runtime 返回结构化下一动作和 Context Projection
→ Brain 派发 Worker
→ Worker 加载 TDD Skill
→ Worker 完成单个 Task并填写 Evidence
→ Runtime admission: Worker Result
→ 重复至全部 Task 完成
→ Worker finalize-slice
→ Fresh unified adversarial CV
→ PASS：Committer → Integration
→ REPAIR：Worker repair → Fresh bounded recheck
→ REPLAN：Planning Skill
→ BLOCKED/ESCALATION：Brain
→ 所有 Slice 集成
→ Runtime Stage Gate
→ Fresh Stage Reviewer
→ Stage Close
→ Recompute remaining AWI
→ Project Acceptance
```

---

## 12. Planner Agent 的移除

Planner Agent 的职责迁移如下：

| 当前职责 | `pluginv2` 归属 |
|---|---|
| 读取 AWI 和权威文件 | Planning Skill |
| Stage/Slice/Task 分解 | Planning Skill |
| 写 `tasks.md` | Planning Skill |
| 编译 candidate Manifest、Stage Plan admission | Runtime Tool |
| 初始化 Evidence | Runtime Tool |
| Mechanical Validator | Runtime Tool |
| 调度 SPV | Brain |
| 修正 Plan | Planning Skill |
| Planner session recovery | 删除；从持久化 Plan 和 Findings 重新运行 Skill |

Planning Skill 是方法，不是持续会话 Agent，因此不需要 Planner continuation。

---

## 13. Executor Agent 的移除

Executor 当前承担大量职责，不能直接删除而不迁移。

| 当前职责 | `pluginv2` 归属 |
|---|---|
| Reconcile persisted state | Runtime |
| Derive next action | Runtime |
| 构造 Worker/CV Context | Runtime Context Resolver |
| Worker/CV session relay | Brain + Host runtime handle |
| Worker result admission | Runtime Tool |
| CV Context Projection | Runtime Context Resolver |
| CV initial/recheck selection | Runtime |
| CV admission | Runtime Tool |
| CV Status 更新 | Runtime Tool |
| repair attempt 计数 | Runtime State |
| Committer dispatch | Brain |
| Integration | Runtime Tool / Committer boundary |
| Stage Gate | Runtime Tool |
| blocking findings | Runtime 返回 Brain |
| interruption recovery | Runtime rehydrate + Brain redispatch |

Brain 只执行 Runtime 返回的一个 Primary Next Action，不自行推理完整 Stage 状态。

---

## 14. `proofloop_stage(next)` 和 Context Projection

当前 `next-action` 的自然语言 `action_detail` 不足以稳定构造 Worker/CV Packet。

当前 Host 调用形式是：

```json
{
  "operation": "next",
  "stage_id": "S04"
}
```

`pluginv2` 的 `proofloop_stage(next)` 应返回结构化结果，例如：

```json
{
  "action": "DISPATCH_WORKER",
  "responsible_role": "worker",
  "stage_id": "S04",
  "slice_id": "S04-A",
  "task_id": "S04-A-T01",
  "mode": "implement-task",
  "context_ref": ".proofloop/context/<context-digest>.json",
  "manifest_digest": "...",
  "snapshot_digest": "...",
  "receipt_chain_valid": true,
  "findings": []
}
```

当下一动作是派发 CV 时，Runtime 不返回任何验证等级字段，只返回统一的验证类型
和绑定信息：

```json
{
  "action": "DISPATCH_CV",
  "responsible_role": "code-verifier",
  "stage_id": "S04",
  "slice_id": "S04-A",
  "verification_type": "initial",
  "context_ref": ".proofloop/context/<digest>.json",
  "manifest_digest": "...",
  "snapshot_digest": "...",
  "receipt_chain_valid": true,
  "findings": []
}
```

Context Projection 由 Runtime 生成，只包含当前动作所需内容：

- 当前 Task ref；
- Slice Goal ref；
- Proof Index 中必要的 acceptance/seam/oracle/risk refs；
- Required Skills；
- 当前 Evidence path；
- 已完成 Task 的必要 receipt refs；
- repair/recheck 时的失败范围；
- 当前 snapshot；
- Allowed/Forbidden scope。

CV Context 至少包含：

```json
{
  "verification_type": "initial",
  "slice_id": "S04-A",
  "goal_ref": "...",
  "acceptance_refs": [],
  "seam_refs": [],
  "oracle_refs": [],
  "risk_refs": [],
  "manifest_digest": "...",
  "plan_digest": "...",
  "proof_index_digest": "...",
  "context_digest": "...",
  "snapshot_digest": "...",
  "diff_ref": "...",
  "tests_ref": "...",
  "pre_refutation_context_ref": "...",
  "evidence_ref": "...",
  "evidence_read": false
}
```

Recheck Context 额外包含：

```json
{
  "previous_failed_criterion": "...",
  "previous_counterexamples": [],
  "failure_signature": "...",
  "repair_diff_ref": "...",
  "required_regression_scope": []
}
```

CV 必须验证所有 input refs、Manifest digest、Context digest、snapshot digest 和
相关 receipt 与当前 Manifest 一致；输入缺失、失效或 digest 不匹配时 fail closed。

Brain 不手工拼装 Packet，也不复制整个 `tasks.md` 或全部权威文件。

`proofloop_stage(next)` 是 Host 工具调用；`NextActionOutput` 是 Runtime 结果合同。不得在文档、Agent Contract 或测试中把 `proofloop_next` 当作当前已存在的独立工具名。

---

## 15. Worker

Worker 保留为实现 Agent。

### Worker 必须

- 每次只执行一个 Runtime 指定的 Task；
- 首次进入 Slice 时读取 Required Skills；
- Required Skills 包含 `test-driven-development` 时加载 TDD Skill；
- RED → 最小实现 → GREEN；
- 写 Task Evidence；
- Evidence 后更新当前 Task checkbox；
- 不读取未来 Task 内容；
- 不自行扩展 Slice；
- 不提交；
- 不声明 CV verdict；
- 在所有 Task 完成后执行 `finalize-slice`；
- repair 只修复 CV 指定的 bounded failure。

### Worker 不再需要

- 解释整个 Stage；
- 读取完整 Stage Goal；
- 汇报重复 changed-file 清单给 Brain；
- 决定下一 Task；
- 选择 CV 模式、验证范围或反例集合；
- 维护 CV Status；
- 决定重试次数；
- 路由其他 Agent。

---

## 16. Code Verifier

## 16.1 定位

Code Verifier 是只读、对抗式 Slice 验证 Agent。

CV 的核心问题是：

> Worker 声称当前 Slice 已完成。是否存在一个具体、可重复的反例，可以推翻该声明？

CV 不审核 Worker 是否填写了足够多的表格，也不因为测试、Evidence 或 Receipt 存在而接受实现。

CV 不使用验证等级，也不使用 Proof Profile。

## 16.2 输入

CV 的 Context Projection 至少包含：

- Slice ID；
- Slice Goal ref；
- Acceptance refs 及解析后的必要内容；
- Seam refs 及解析后的必要内容；
- Oracle refs 及解析后的必要内容；
- Risk refs 及解析后的必要内容；
- 当前代码和测试范围；
- 当前 diff；
- 当前 Git snapshot；
- Manifest digest；
- Plan digest 和 Proof Index digest；
- Context digest；
- pre-refutation Context ref；
- Evidence ref；
- verification type：`initial | recheck`；
- recheck 时的既有失败范围。

Runtime 必须在派发前完成所有 ref 解析和 digest 校验。CV 只验证 pre-refutation
Context 的自校验 digest，以及 Context 声明的 Manifest、Plan、Proof Index 和
snapshot 绑定；不重复执行完整 Context Resolver。

Context 缺失、失效、Evidence 被提前投影或任一绑定不匹配时，CV fail closed，返回
`BLOCKED`。

## 16.3 固定验证域

每次 initial CV 都必须检查：

1. **Acceptance coverage**
   当前实现是否满足全部 Acceptance References。

2. **Test validity**
   测试是否真正约束目标行为，而不是只验证实现细节或恒真条件。

3. **Seam validity**
   验证是否通过 Authority 指定的真实边界进行。

4. **Oracle independence**
   成功判断是否独立于被验证实现。

5. **Forbidden substitution**
   是否使用了 Authority 或 Risk References 禁止的 mock、stub、fixture 或替代路径。

6. **Scope integrity**
   实际 diff 是否超出 Slice 和 Task 范围。

7. **Regression exposure**
   实际变化是否破坏相关既有行为。

8. **Independent refutation**
   CV 是否在读取 Worker Evidence 前设计并尝试了具体反例。

所有代码 Slice 都必须执行独立反驳，不存在可以跳过反驳的 Lite 模式。

## 16.4 Adversarial-first 顺序

Initial CV 必须严格按照以下顺序执行：

```text
1. 读取 Slice Goal 和 Proof Index
2. 读取解析后的 Authority Context
3. 读取当前代码、测试、diff 和 snapshot
4. 不读取 Worker Evidence
5. 识别最可能推翻 Slice 完成声明的反例
6. 执行与当前行为直接相关的最小充分反驳
7. 固定反驳观察结果
8. 读取 Worker Evidence
9. 将 Worker Evidence 作为声明，与反驳结果比较
10. 返回结构化 Verdict
```

CV 不得在独立反驳完成前读取 Worker Evidence；`evidence_read` 必须保持为 `false`，
直到反驳观察结果已经固定。

Worker Evidence 只用于检查：

- Worker 是否覆盖 CV 攻击的场景；
- Worker 声明是否被实际结果否定；
- Worker 是否遗漏重要限制；
- Evidence 是否与当前 snapshot 一致。

## 16.5 最小充分反驳

CV 应选择能够高概率发现错误的最小反驳集合。

CV 不需要因为一个风险标签而执行所有可能的高级测试。

反驳选择规则：

```text
Acceptance 明确要求的边界
→ 必须攻击

Oracle 明确描述的成功或失败条件
→ 必须验证

Risk Reference 指向的具体风险
→ 必须设计至少一个相关反例

Actual Diff 暴露的新边界
→ 增加必要反例

与 Slice 行为无关的风险
→ 不进入当前验证
```

CV 必须记录选择了哪些反例以及选择原因，但不记录等级。

## 16.6 Initial CV

Initial CV 验证完整 Slice：

- 全部 Acceptance References；
- 全部相关 Seam 和 Oracle；
- 当前 Slice 的全部实际 diff；
- 必要相关回归；
- Risk References 指向的相关风险；
- Worker Evidence 的完整声明。

Initial CV 必须使用 fresh CV Session。

## 16.7 Recheck

每次 Worker repair 后启动 fresh CV invocation。

Recheck 只验证：

- previous failed criterion；
- concrete counterexample；
- failure signature；
- repair diff；
- required regression scope；
- 当前 snapshot 和 Context digest。

以下任一内容变化时，不得执行 bounded recheck，必须重新执行 Initial CV：

- Slice Goal；
- Acceptance References；
- Seam References；
- Oracle References；
- Risk References；
- Manifest digest；
- Plan digest；
- Slice scope；
- 验证边界；
- repair diff 超出原失败范围。

## 16.8 Verdict

CV 返回：

- `PASS`
- `REPAIR`
- `REPLAN`
- `BLOCKED`
- `ESCALATION_REQUIRED`

#### PASS

仅当：

- 已执行独立反驳；
- 没有具体反例推翻 Slice 完成声明；
- Acceptance 全部满足；
- Seam 和 Oracle 有效；
- 测试有效；
- 没有禁止替代；
- 必要相关回归通过；
- Evidence 未被实际结果否定。

不得因为以下情况直接 PASS：

- tests pass；
- commands succeeded；
- Evidence 存在；
- Receipt 存在；
- 文件存在。

#### REPAIR

用于：

- 实现缺陷；
- 无效测试；
- 成功的具体反例；
- Acceptance 未满足；
- 禁止的 mock 或替代边界；
- 可由 Worker 在当前 Plan 内修复的问题。

`REPAIR` 通过 Runtime admission 生成 `CV_REPAIR` Receipt。

#### REPLAN

用于：

- Slice Goal 与任务分解无法闭环；
- Proof Index 缺失或错误映射；
- 选择了错误 Seam；
- Oracle 无法证明 Acceptance；
- 当前 Plan 无法通过局部实现修复。

`REPLAN` 不生成 `CV_PASS` 或 `CV_REPAIR` Receipt，返回 Brain：

```yaml
route_code: PLAN_GAP
subtype: CV_REPLAN_REQUIRED
```

#### BLOCKED

用于：

- 必要运行环境不可用；
- Context 缺失或失效；
- Authority ref 无法解析；
- 必要命令无法执行；
- snapshot 或 digest 无法确认；
- 必要反驳因环境原因无法尝试。

`BLOCKED` 不生成 CV verdict Receipt，返回相应 Route Envelope。

#### ESCALATION_REQUIRED

用于：

- 安全或合规边界超出自动 CV 能力；
- 必须依赖人工判断；
- 需要用户或领域专家决策；
- 风险无法通过当前环境安全验证。

不生成 CV verdict Receipt。

## 16.9 Admission 映射

Runtime admission 只接收：

```text
PASS
REPAIR
```

映射：

```text
PASS
→ admit_cv_result
→ CV_PASS Receipt

REPAIR
→ admit_cv_result
→ CV_REPAIR Receipt
```

`admit_cv_result` 只接受以下 `CVResultAdmissionRequest`：

```json
{
  "type": "cv_result",
  "slice_id": "S04-A",
  "verdict": "PASS | REPAIR",
  "verification_type": "initial | recheck",
  "snapshot_digest": "...",
  "manifest_digest": "...",
  "plan_digest": "...",
  "context_digest": "...",
  "proof_index_digest": "...",
  "summary": "...",
  "failure_signature": null,
  "repair_diff_digest": null
}
```

Runtime 写入的 `CV_PASS` / `CV_REPAIR` Receipt 必须原样绑定上述
`slice_id`、verdict、verification type、snapshot、Manifest、Plan、Context 和
Proof Index digest；`REPAIR` 额外绑定 failure signature 和 repair diff digest。
任一绑定变化都会使旧 CV Receipt 失效。

以下结果只进入 Brain 路由，不直接 admission：

```text
REPLAN
BLOCKED
ESCALATION_REQUIRED
```

Brain 不得把这些结果改写为 `PASS` 或 `REPAIR`。

## 16.10 输出合同

CV 输出中删除 `cv_level` 和所有 Proof Profile 字段。

CV Output 是按 `verdict` discriminated 的 closed schema；所有分支均使用
`additionalProperties: false`，不使用“只在适用时填写”的隐式缺省。

所有分支共有且必填：

```yaml
slice_id:
snapshot_digest:
manifest_digest:
plan_digest:
proof_index_digest:
context_digest:
verification_type: initial | recheck
acceptance_refs_checked: []
seam_refs_checked: []
oracle_refs_checked: []
risk_refs_considered: []
failed_acceptance_refs: []
invalid_tests: []
counterexamples: []
scope_violations: []
forbidden_substitutions: []
regression_failures: []
verdict:
```

`risk_refs_considered` 的每项固定为
`{ref_id, applicability: APPLICABLE | NOT_APPLICABLE, reason}`；CV 不得删除或新增
Risk Reference，只能对已索引风险说明适用性。

分支约束：

```yaml
PASS:
  required: [verdict, counterexamples]
  constraints:
    verdict: PASS
    counterexamples: []
    failed_acceptance_refs: []
    invalid_tests: []
    scope_violations: []
    forbidden_substitutions: []
    regression_failures: []
  forbidden: [failed_criterion, failure_signature, required_recheck_scope,
              route_code, subtype, reason, previous_failure_signature,
              repair_diff_digest]

REPAIR:
  required: [verdict, failed_criterion, failure_signature, required_recheck_scope]
  constraints: {verdict: REPAIR}
  forbidden: [route_code, subtype, reason, previous_failure_signature,
              repair_diff_digest]

REPLAN:
  required: [verdict, route_code, subtype, reason]
  constraints: {verdict: REPLAN, route_code: PLAN_GAP}
  forbidden: [failed_criterion, required_recheck_scope,
              previous_failure_signature, repair_diff_digest]

BLOCKED:
  required: [verdict, route_code, subtype, reason]
  constraints: {verdict: BLOCKED}
  forbidden: [failed_criterion, required_recheck_scope,
              previous_failure_signature, repair_diff_digest]

ESCALATION_REQUIRED:
  required: [verdict, route_code, subtype, reason]
  constraints: {verdict: ESCALATION_REQUIRED}
  forbidden: [failed_criterion, required_recheck_scope,
              previous_failure_signature, repair_diff_digest]
```

`recheck` 输出必须额外包含 `previous_failure_signature` 和
`repair_diff_digest`；`initial` 输出禁止这两个字段。Runtime 必须同时验证
branch required/forbidden fields、枚举值和 admission 所需绑定。

## 16.11 权限边界

CV 保持只读。

CV 可以：

- 读取 Context Projection；
- 读取 Authority excerpts；
- 读取代码、测试和 diff；
- 读取 Worker Evidence；
- 执行已经批准的项目验证命令；
- 执行安全、只读、无需创建文件的反驳探测。

CV 不可以：

- 修改代码或测试；
- 修改 `tasks.md`；
- 修改 Evidence；
- 写 CV Status；
- 写 Receipt；
- 创建 scratch scripts；
- 提交代码；
- 派发 Worker；
- 决定 repair 次数；
- 修改 Plan；
- 修改 Authority；
- 请求用户交互。

所有 Receipt 和状态更新由 Runtime admission 完成。

## 16.12 Validator 和 SPV

Validator 不检查验证等级、Proof Profile、Risk Fact 到验证等级的映射、最小验证
等级、Profile Evidence 模板或 Worker 是否选择 Profile。Validator 只做机械检查：

- Proof Index 字段存在；
- ref 可解析；
- ref kind 正确；
- digest 匹配；
- 每个 Slice 至少有 Acceptance 和 Oracle；
- Seam 必须可解析到真实边界；
- Risk ref 必须来自允许的 Authority 类型；
- task/slice/stage closure 完整；
- Manifest schema 有效。

SPV 不审核验证等级是否足够、Proof Profile 是否齐全或 Profile 是否和风险事实
匹配。SPV 继续审核：

- Tasks 是否足以实现 Slice Goal；
- Acceptance refs 是否足以证明 Slice Goal；
- Seam 是否可以观察目标行为；
- Oracle 是否独立；
- Risk refs 是否覆盖权威声明的重要风险；
- 所有 Slice 是否足以实现 Stage Goal；
- Runtime Proof 是否可以验证 Stage Outcome。

---

## 17. Stage Gate、Stage Review 和 Project Acceptance

## 17.1 Stage Gate

Stage Gate 由 Runtime 执行，不由 Brain 或 Agent自由拼装。

**职责（2026-08-13 用户确认的重新设计）**：SG 只验证"各 Slice 集成证明齐全"；不再重验整条执行链（每环节已有 CLI 机器强制校验：admit-worker/admit-cv/admit-slice-commit/admit-integration 均 write-once、fail-closed，集成 admission 已完整验证 Worker→CV→Commit 链），不再执行 runtime_proof 命令（构建+测试由 Stage Reviewer 评审承担）。

**双路径**：
- 正常路径（默认）：查 receipts——每 Slice 的 INTEGRATION_PASS receipt 存在、绑定当前 Manifest/Plan/snapshot，齐全即通过。
- 兜底路径（特殊）：仅 receipts 缺失且 request 显式声明 `verification_source: "git_facts"` 时启用，须经 public CLI（`proofloop gate run --verification-source git_facts` 或等价 request 字段）；验证 git 事实——每 Slice 集成提交（`slice-output: <stage>-<slice>`）在 HEAD 祖先链、该提交处 Evidence 含完整 Task Evidence（`Status: COMPLETE`）、tasks.md checkbox 全勾，**且与当前 HEAD 内容一致**（当前 HEAD 的 Evidence/checkbox 状态不得回退）；缺显式声明或任一事实不满足即 fail-closed。
- Gate Receipt 必须标注 `verification_source`（`receipts` / `git_facts`），SR 与 Project Acceptance 可审计，无法静默绕过。

输入：

- integrated snapshot；
- Manifest；
- （正常路径）Slice integration receipts；
- （兜底路径）git 集成事实 + 显式声明；
- Authority Oracle digest。

输出：

- immutable Gate Receipt（含 `verification_source`）；
- snapshot binding；
- Manifest/proof/authority digest binding；
- failure subtype。

## 17.2 Stage Reviewer

保留 fresh、goal-first、de-anchored review：

1. 先读 Stage Goal 和 Authority；
2. 读最终代码和 diff；
3. 独立设计 acceptance scenarios 和 counterexamples；
4. 执行关键挑战；
5. 最后读取 Stage Gate Receipt 和 Slice Evidence；
6. 返回 `ACCEPTED / REJECTED / BLOCKED`。

Stage Review admission 固定为：

```text
ACCEPTED
→ Runtime stage_review admission(verdict=ACCEPTED)
→ Stage Review Receipt

REJECTED
→ Runtime stage_review admission(verdict=REPAIR)
→ Stage Review Receipt
→ Brain 按 finding 路由 IMPLEMENTATION_DEFECT / PLAN_GAP / AUTHORITY_GAP / EVIDENCE_GAP

BLOCKED
→ 不得改写为 ACCEPTED 或 REPAIR
→ 返回 RUNTIME_BLOCKER / AUTHORITY_GAP / EVIDENCE_GAP Route Envelope
→ 可写 blocked-attempt Receipt，但不写完成态 Stage Review Receipt
```

Stage Review Receipt 必须绑定 `stage_id`、review verdict、integrated snapshot digest、
Manifest digest、Gate Receipt digest、review Context digest 和 summary。

```yaml
type: stage_review
stage_id: S04
verdict: ACCEPTED | REPAIR
snapshot_digest: ...
manifest_digest: ...
gate_receipt_digest: ...
context_digest: ...
summary: ...
```

## 17.3 Project Acceptance

全部 AWI 和 Stage 完成后：

- Runtime 编译 Project Acceptance Manifest；
- 运行项目级 E2E；
- fresh Stage Reviewer 以 project scope 审查；
- 返回 `PROJECT_ACCEPTED / PROJECT_REJECTED / PROJECT_BLOCKED`。

Project Review admission 使用同一边界：

```text
PROJECT_ACCEPTED
→ finalize_project_review(verdict=PROJECT_ACCEPTED)
→ Project Review Receipt

PROJECT_REJECTED
→ finalize_project_review(verdict=REPAIR)
→ Project Review Receipt
→ Brain 路由到相应 Authority 或 Stage recovery

PROJECT_BLOCKED
→ 不得改写为 PROJECT_ACCEPTED 或 REPAIR
→ 返回对应 Route Envelope，并记录 blocked attempt
```

Project Review Receipt 必须绑定 Project Acceptance Manifest digest、Project E2E Gate
Receipt digest、最终 snapshot digest、review Context digest 和 summary。

---

## 18. `pluginv2` 重构实施计划

## Stage 0 — Contract Foundation

### Stage Goal

在删除 Planner、Executor 或精简 Manifest 之前，冻结 `pluginv2` 的 Plan、Proof Index、Context、Runtime Proof、状态权威和失效合同。

Stage 0 不是新的治理制品体系，而是让现有 Runtime、Plugin、Agent Contract 和测试可以共同消费同一套机器合同的基础阶段。

### Slice 0.1 — Canonical Plan Model

**Slice Goal**

定义不可变 Plan 区域、可变执行投影区域、规范化 Plan AST 和 `plan_digest`。

**Tasks**

- 明确 Stage/Slice/Task Goal、refs、dependencies、Required Skills 等不可变字段；
- 明确 checkbox、Worker Status、Current CV Status 等可变字段；
- 定义 checkbox 规范化/排除规则；
- 定义 Plan 变化的失效范围；
- 验证同一 Plan 在不同 checkbox 状态下产生相同 `plan_digest`。

### Slice 0.2 — Proof Index Contract

**Slice Goal**

定义 acceptance、oracle/seam、risk 和 task 的最小可解析闭环引用。

**Tasks**

- 定义唯一 `reference_index`、`ReferenceDescriptor` 和 `ref_id` Schema；
- 定义 `goal_ref`、`task_refs`、`acceptance_refs`、`oracle_refs`、`seam_refs`、`risk_refs`；
- 为每个 ReferenceDescriptor 绑定 `kind`、`file_digest` 和 `section_digest`；
- 定义 Risk Binding 的 Acceptance/Seam applicability；
- 定义 SPV、CV、Gate、Stage Reviewer 对 Proof Index 的消费规则；
- 禁止以 Agent 叙事补全缺失的验收或 Oracle 信息。

### Slice 0.3 — Context Resolver Contract

**Slice Goal**

定义 root-bound、digest-bound、按角色和动作投影的 Context Resolver。

**Tasks**

- 定义 `#/entities/<entity-id>` 实体引用和 Markdown 显式 entity marker；
- 定义 JSON 制品的 JSON Pointer 引用语法；
- 定义 section 定位、规范化和 digest 算法；
- 定义重复/缺失/模糊引用的 fail-closed 行为；
- 定义 Worker、CV、SPV、Stage Reviewer 的 Context Projection；
- 定义 content-addressed Context artifact 的保护、生命周期和重建规则；
- 定义 authority、plan、snapshot、risk 变化的精确失效范围。

### Slice 0.4 — Runtime Proof Contract

**Slice Goal**

定义从 Authority Oracle 到类型化 `RuntimeProofStep` 的安全编译边界。

**Tasks**

- 固定 `ProofSpecification` 和 resolved `RuntimeProofStep` 的闭合字段和版本；
- 定义 Runtime Proof Resolver / Validator，只解析预先定义的结构化 Proof Specification；
- 禁止从任意 Markdown 正文直接拼装命令；
- 绑定 executable、args、cwd、timeout、service lifecycle 和 expected result；
- 复用 process runner 的 shell/operator、trust-root、timeout、cancellation 和 cleanup 约束；
- 定义 Proof digest、Authority Oracle digest 和 Manifest digest 的绑定关系。

### Slice 0.5 — Artifact Authority and Invalidation

**Slice Goal**

冻结 Authority、Manifest、Git、Receipt、Evidence、Runtime State、tasks.md 和 progress.md 的优先级及失效传播。

**Tasks**

- 明确 Receipt 是不可变状态转换事实；
- 明确 Evidence 是 Worker 语义声明，必须由 CV 反驳；
- 明确 Runtime State 是可重建派生物；
- 明确 tasks.md checkbox 不能单独授权完成；
- 明确 Plan 变化、Authority section 变化、Snapshot 变化和纯 checkbox 变化的不同失效范围。

### Slice 0.6 — Unified CV Contract

**Slice Goal**

定义无等级、无 Proof Profile 的统一 adversarial-first CV 合同。

**Authority References**

- 当前 `plugin` Code Verifier Contract；
- `main` Code Verifier 的 adversarial-first 顺序；
- 本方案 Proof Index Contract；
- Artifact Authority and Invalidation Contract。

**Required Skills**

- None

**Tasks**

- 定义统一的 initial CV 输入和输出；
- 定义每次 CV 必须执行独立反驳；
- 定义 Acceptance、Seam、Oracle 和 Risk refs 的消费规则；
- 定义最小充分反驳选择原则；
- 定义 initial 与 bounded recheck；
- 定义 `PASS / REPAIR` admission；
- 定义 `REPLAN / BLOCKED / ESCALATION_REQUIRED` 路由；
- 删除 CV Level 和 Proof Profile 的全部合同依赖；
- 定义 CV Context closed schema；
- 定义 CV Output closed schema。

### Stage 0 Gate

只有以下条件全部满足，才允许进入后续 Runtime 和 Agent 重构：

- 新 Manifest 可以表达完整 Proof Index；
- checkbox 不改变 `plan_digest`；
- Context Ref 可以稳定解析并验证 digest；
- Authority section 变化可以精确失效相关结果；
- Gate 不执行任意 Markdown 命令；
- Runtime State 可以从持久化事实重建；
- Brain 新权限和 Contract 已定义；
- Plugin Host Tool surface 已定义并有 parity 计划；
- CV Contract 不包含验证等级；
- CV Contract 不依赖 Proof Profile；
- 每次 initial CV 都必须执行独立反驳；
- Risk refs 不触发整套无关验证升级；
- CV 输出可以明确映射到 admission 或 Brain route；
- Proof Index 只使用唯一 `reference_index`/`ref_id` Schema；
- AWI、HP、Slice 和 Task 都有稳定实体引用；
- Runtime Proof 只解析结构化 Proof Specification；
- CV Receipt 绑定 snapshot、Manifest、Plan、Context 和 Proof Index digest；
- CV Output 的 verdict 分支使用 discriminated closed schema；
- pre-refutation Context 不包含 Evidence 内容或摘要；
- `proofloop_project` operation 集合已闭合并有 Host parity 测试。

### Stage/Slice dispatch metadata closure

以下元数据是每个 Slice 进入 `tasks.md` 和 Worker dispatch 前的必填项；`None` 是
明确值，不是省略。表中的 Authority References 是最小集合，生成具体 Plan 时必须
展开为稳定 `ref_id`：

| Slice | Authority References | Required Skills |
|---|---|---|
| 0.1 | Canonical Plan Model、Artifact Authority | None |
| 0.2 | Proof Index、Validator、SPV Contract | None |
| 0.3 | Context Resolver、Artifact Authority | None |
| 0.4 | Runtime Proof、Process Runner、Contract Verification | None |
| 0.5 | Artifact Authority、Receipt Contract | None |
| 0.6 | Unified CV Contract、Proof Index、Context Resolver | None |
| 1.1 | PRD、Architecture、Contract、Hard Parts、AWI Matrix | None |
| 2.1–2.2 | Canonical Plan、Proof Index、Planning Contract | None |
| 3.1–3.2 | Manifest、Proof Index、Context Resolver、Plan Admission | None |
| 4.1–4.3 | Runtime Controller、Receipt、Stage Gate Contract | test-driven-development |
| 5.1–5.2 | Brain Boundary、Runtime Controller、Context Resolver | test-driven-development |
| 6.1–6.2 | Unified CV、Stage Review、Project Acceptance Contract | test-driven-development |
| 7.1–7.2 | Schema Cutover、全部已接纳 Contract、Host Parity | test-driven-development |

这张表补齐路线级计划的闭环，不复制 Authority 正文；最终 `tasks.md` 仍必须为每个
Slice 生成具体的 `authority_ref_ids` 和 `required_skills` 字段。

---

## Stage 1 — Authority 去重

### Stage Goal

使 Architecture Work Items 只保存项目级工作索引和权威引用。

### Slice 1.1

**Slice Goal**

精简 `task-acceptance-matrix`，移除和 PRD、Contract、Hard Parts 重复的正文。

**Tasks**

- 将仅存在于矩阵中的验收要求迁移到正确权威文件；
- 将 Forbidden Shortcuts 迁移到 Hard Parts；
- 将 Verification 定义迁移到 Contract/Architecture；
- 将矩阵改为 AWI、依赖和 Authority References 索引。

**Authority References**

- PRD；
- `tech-spec/ai-coding-architecture.md`；
- `tech-spec/contract-state-matrix.md`；
- `tech-spec/hard-parts-register.md`；
- 当前 `task-acceptance-matrix`。

---

## Stage 2 — Planning Skill 与精简 Plan

### Stage Goal

用 Planning Skill 替代 Planner Agent，并生成最小 `tasks.md`。

### Slice 2.1

**Slice Goal**

定义 Planning Skill 的输入、输出和 Gap 路由。

**Tasks**

- 输入改为 AWI entity refs、authority ref IDs、existing plan ref 和 finding refs；
- 输出仅保留 Stage/Slice/Task 分解、authority refs、dependencies、required skills；
- 明确禁止实现方案和代码文件清单；
- 定义 Authority Gap、Technical Unknown 和 Plan Gap。

### Slice 2.2

**Slice Goal**

精简 `tasks.md` 格式。

**Tasks**

- 删除 PO、Proof Plan、风险事实、Runtime Proof 和 Closure 正文的重复副本；
- 保留 Stage Goal、Slice Goal、Task、Authority References、Dependencies 和 Required Skills；
- 保留 Proof Index 所需的 acceptance/oracle/seam/risk refs；
- 保留 Task checkbox 和 Worker Status 所需的最小运行字段。

---

## Stage 3 — Manifest、Plan Admission 与 Context Projection

### Stage Goal

将 Manifest 改为引用优先的最小机器索引。

### Slice 3.1

**Slice Goal**

实现 Manifest vNext。

**Tasks**

- 保存 Plan ref/digest；
- 保存 `reference_index`、kind 和 file/section digests；
- 保存 Slice/Task refs、Proof Index、dependencies、skills 和 evidence path；
- 保存 Structured Proof Specification refs、resolved RuntimeProofStep 和 proof digest；
- 保存完整 Proof Index；
- 保存 CV 所需的 Acceptance、Seam、Oracle 和 Risk refs；
- 确保 CV Context 可以从 Manifest 和当前 snapshot 确定性生成；
- 生成 candidate Manifest 并执行 Mechanical Validator；
- 让 Fresh SPV 通过 `admit_stage_plan` 接纳 Plan；
- 只有 Stage Plan admission Receipt 写入后，Manifest 才成为 admitted Plan authority；
- 删除重复 Goal、Seam、PO、Risk 和 Runtime command 正文，但不删除机器可验证引用。

### Slice 3.2

**Slice Goal**

实现引用解析和最小 Context Projection。

**Tasks**

- 根据当前 action 读取必要的 Plan section；
- 读取必要的 Authority section；
- 为 Worker、CV、SPV、Stage Reviewer 生成不同的最小 Context；
- Context 使用 digest 绑定；
- 缺失或失效引用时 fail closed。

---

## Stage 4 — Runtime Controller

### Stage Goal

将 Executor 的机械职责迁移到 Runtime。

### Slice 4.1

**Slice Goal**

扩展 reconcile 和 next-action 的结构化输出。

**Tasks**

- next-action 返回 stage/slice/task/mode/context ref；
- 不再把关键字段嵌入自然语言 `action_detail`；
- 保持每次只返回一个 Primary Next Action。

### Slice 4.2

**Slice Goal**

迁移 admission 和状态同步。

**Tasks**

- Worker result admission；
- Task 状态核对；
- CV Status 更新；
- initial/recheck 判断；
- CV Context generation；
- CV initial/recheck selection；
- CV result admission；
- CV repair attempt count；
- stale snapshot 失效；
- Context digest 失效；
- interruption recovery。

### Slice 4.3

**Slice Goal**

迁移 Commit、Integration 和 Stage Gate 推进。

**Tasks**

- Committer boundary；
- Integration receipt；
- integrated snapshot；
- Stage Gate；
- Stage Gate failure routing。

---

## Stage 5 — Brain Direct Delivery Loop

### Stage Goal

Brain 直接调用 Planning Skill 和 Runtime Tool，不再依赖 Planner/Executor Agent。

### Slice 5.1

**Slice Goal**

实现 Brain 的单动作控制循环。

**Tasks**

- rehydrate；
- 调用 `proofloop_stage({ operation: "next" })`；
- 执行一个 Runtime 指定动作；
- admission；
- recompute；
- blocking finding 返回 Authority、Planning、Worker、User 或环境 owner。
- 更新 Brain 的 responsibility boundary、task permissions 和 Capability Map；
- 明确 Brain 可以直接派发 Worker/CV/SPV/Committer/Stage Reviewer 的条件；
- 保留 Runtime 作为唯一状态和 Receipt admission owner。

### Slice 5.2

**Slice Goal**

实现 Worker/CV/Committer/Stage Reviewer 的直接派发。

**Tasks**

- 使用 Runtime 生成的 Context Ref；
- 不由 Brain 手工复制正文；
- runtime session handle 不持久化；
- session 丢失时从持久化事实重建。
- Worker/CV/SPV/Reviewer 的 dispatch contract 改为引用型输入；
- Brain 不把 CV/SR 的 REPAIR/REJECT 改写为 PASS/ACCEPTED；
- Committer、Integration 和 Gate 的信任边界不因移除 Executor 而消失。

---

## Stage 6 — CV、Review 和 Acceptance

### Stage Goal

在 `pluginv2` 中完成完整验证闭环。

### Slice 6.1

**Slice Goal**

实现无等级、无 Proof Profile 的统一 adversarial-first CV。

**Authority References**

- Stage 0 Unified CV Contract；
- Proof Index Contract；
- Context Resolver Contract；
- 当前 `plugin` CV 的 fresh session 和 bounded recheck 规则；
- `main` CV 的 Evidence 后读和独立反驳顺序。

**Required Skills**

- test-driven-development

**Tasks**

- 删除 Lite、Standard 和 Enhanced 分支；
- 删除 CV Level dispatch 和输出字段；
- 删除 Proof Profile 读取和选择逻辑；
- 实现统一 initial CV；
- 实现 Acceptance、Seam、Oracle 和 Risk ref 驱动的反驳选择；
- 保证 Evidence 在独立反驳后读取；
- 实现 bounded recheck；
- 实现 `PASS / REPAIR` admission；
- 实现 `REPLAN / BLOCKED / ESCALATION_REQUIRED` 路由；
- 保持 CV read-only；
- 增加无等级 CV 的 Contract、Runtime 和 Host parity tests。

### Slice 6.2

**Slice Goal**

完成 Stage Review 和 Project Acceptance。

**Tasks**

- Stage Reviewer 使用最小 Context；
- Gate Receipt 与 integrated snapshot 绑定；
- Stage Close；
- Project Acceptance Manifest；
- project-scope review；
- `proofloop_project` 闭合 operation 集合和 Host parity tests。

---

## Stage 7 — 删除旧路径并切换

### Stage Goal

在 `pluginv2` 内删除旧 Planner/Executor 流程，并完成正式切换准备。

### Slice 7.1

**Slice Goal**

删除旧流程。

**Tasks**

- 删除 Planner Agent；
- 删除 Executor Agent；
- 删除 Brain→Planner Contract；
- 删除 Executor-owned dispatch contracts 中已经迁移的重复路径；
- 删除旧 Manifest compiler 语义（仅在 Manifest vNext parity 和恢复测试通过后）；
- 删除旧 next-action 自然语言上下文依赖；
- 更新安装配置、README 和 Agent 权限；
- 删除 `.agents/contracts/executor/cv-levels/` 及其中的 `lite.md`、`standard.md`、`enhanced.md`；
- 删除 `proof-profiles.md`；
- 删除 Agent Contract、Skill、Validator、SPV、Runtime、测试和文档中的 Proof Profile 引用；
- 删除 Manifest validator 中的 `cv_minimum_level`；
- 删除 Risk Fact 到 CV Level 的映射；
- 删除 CV output 中的 `cv_level`；
- 删除 Context Packet 中的 CV Level、Level Profile Ref 和 Profile Ref；
- 删除 Worker Evidence 模板中的 Proof Profile 和 Profile Evidence 字段；
- 删除旧 Profile completeness tests 和 Profile selection tests；
- 增加无等级 CV migration fail-closed 测试，确保旧 Manifest 不被静默解释；
- 确认旧 `.proofloop` Stage 不被隐式迁移或误读；
- 保留 `plugin` 分支可回退，不在 `pluginv2` 之外删除旧实现。

### Slice 7.2

**Slice Goal**

完成端到端验收。

**Tasks**

- 正常 Stage；
- Worker session 丢失；
- Brain session 丢失；
- CV REPAIR；
- CV REPLAN；
- Authority ref 变更；
- Plan/Manifest digest 不一致；
- dirty snapshot；
- Gate 后代码变化；
- Stage Reviewer REJECTED；
- Project Acceptance；
- 真实 OpenCode host 加载和调用。
- 新旧 checkbox 状态产生相同 `plan_digest`；
- section ref 缺失、重复、digest 变化的 fail-closed；
- Runtime Proof shell/operator、cwd、timeout、service cleanup 安全矩阵；
- Stage Plan admission、SPV admission 和 Plugin Host parity。

---

## 19. `pluginv2` 切换 Gate

只有以下条件全部满足，才切换使用 `pluginv2`：

- Contract Foundation Stage 0 Gate 通过；
- Planning Skill 可以从真实 Authority 生成精简 Plan；
- SPV 可以基于 Proof Index 和解析后的 Authority Context 完成反向闭环审查；
- Manifest 不复制权威正文，但保留完整 Proof Index、Runtime Proof digest 和 Plan digest；
- checkbox 变化不会改变 `plan_digest`；
- Context Projection 可为每个角色生成充分且最小的上下文；
- Brain 不需要 Planner/Executor Agent 即可推进完整 Stage；
- Worker TDD 和 Evidence 顺序保持有效；
- 所有 initial CV 都执行独立反驳；
- CV 不依赖验证等级或 Proof Profile；
- Risk ref 只产生与当前行为相关的反驳，不加载无关验证；
- CV Context 可以完全从 Manifest、Authority、Git 和 Receipt 生成；
- Evidence 只在独立反驳后读取；
- `PASS / REPAIR` admission 正确；
- `REPLAN / BLOCKED / ESCALATION_REQUIRED` 不被错误 admission；
- bounded recheck 只验证失败范围和必要回归；
- Goal、Proof Index、Manifest 或 verification boundary 变化会强制 initial CV；
- 取消 CV 分级后没有残留字段、目录、Validator 或 Runtime 分支；
- Commit、Integration、Gate 和 Review Receipt 正确；
- session 丢失后可从持久化事实恢复；
- authority/digest/snapshot 变化会正确失效旧结果；
- 无关 Authority section 变化不会误使当前 Slice 失效；
- Runtime 不会从任意 Markdown 解析或执行命令；
- Project Acceptance 闭环通过；
- 真实 Plugin host seam 测试通过；
- `plugin` 分支仍可作为回退。

---

## 20. 最终目标流程

```text
User
→ Brain Authority Readiness
→ Select AWI References
→ Planning Skill
→ Minimal tasks.md
→ Candidate Manifest
→ Validator
→ Evidence skeleton
→ Final Plan/Evidence Git boundary（clean worktree）
→ Fresh SPV
→ Stage Plan admission / Manifest Receipt（HEAD/clean recheck）
→ proofloop_stage({ operation: "next" })
→ Worker + TDD + Evidence
→ Runtime Admission
→ Worker finalize-slice
→ Fresh unified adversarial CV
   ├─ PASS → Committer → Integration
   ├─ REPAIR → Worker Repair → Fresh Bounded Recheck
   ├─ REPLAN → Planning Skill
   └─ BLOCKED / ESCALATION → Brain
→ Runtime Stage Gate
→ Fresh Stage Reviewer
→ Stage Close
→ Recompute Remaining AWI
→ Project Acceptance
→ Terminal
```

核心变化可以概括为：

```text
Authority 只写一次
Plan 只做执行分解
Manifest 保存不可变 Plan、Proof Index 和类型化 Runtime Proof 索引
Runtime 只做机械推进
Worker 只做单 Task 实现与 Evidence
CV 只做独立反驳
Brain 只做全局路由和一个动作的执行
```

`pluginv2` 的实施前置条件是 Contract Foundation，而不是先删除旧 Agent。任何无法由 Plan digest、Proof Index、Context digest、Receipt 或 Git snapshot 解释的状态，都必须阻断流程并返回结构化 Finding。

---

## 2026-08-08 用户裁决：威胁模型与写入豁免（S08-REVIEW-002）

**背景**：S08 Stage Review 发现 `packages/runtime/src/vnext/admission.ts` 的 Stage Plan authority
写入路径（authority directory/file 检查 + 普通 `mkdirSync({recursive:true})` + raw-path
`openSync` 写入）未使用 bounded writer（`writeReceiptBounded`/root-fd/`O_NOFOLLOW`）。

**用户裁决**：

1. **威胁模型限定**：本项目是面向个人开发者的 SWE 流程工具，威胁模型限定为**防误操作
   与防外部进程干扰**（非恶意路径穿越、工具自身缺陷、外部脚本误写）；**不针对恶意本地
   攻击者**（adversarial local attacker 明确超出范围，不为该威胁投入防御）。既有 bounded
   writer 加固保留为纵深防御，但不再要求所有写入路径满足 adversarial 级别 containment。
2. **Stage Plan authority 写入豁免**：`admission.ts` 的 Stage Plan authority 写入路径
   **豁免** bounded writer 要求（恶意本地攻击者在检查与 mkdir/open 之间替换父目录为外部
   symlink 的场景超出防御范围）；root-bound 检查仍保留（防误操作/防外部进程）。其余
   vNext Receipt 写入继续使用 bounded writer 作为纵深防御。若未来威胁模型变更，须重新
   评估该豁免并回填加固。
3. **记录位置说明**：本裁决**不写入** `tech-spec/hard-parts-register.md`（HP-013 条目）——
   该文件被 Stage Manifest 的 reference_index 以 file_digest 绑定，内容变化会使已 admission
   的 Stage 绑定全部失效（S08-REVIEW-003 已证实）。裁决记录存放于本方案文件（未被 Manifest
   引用）与 `progress.md`。若未来需要将豁免正式登记到 HP-013，须先提供 Runtime 的
   reference rebind/refresh 通道（S08-REVIEW-003 记录的需求）。

## 2026-08-08 用户裁决：动作授权语义（S08-REVIEW-001 驳回）

Stage Reviewer 曾提出"CV_REPAIR 后没有 Runtime 派发的修复动作"违反正式执行边界。
**用户裁决（驳回）**：每个动作的语义授权由 Brain 判断（CV 意见必须经 Brain 与权威文档/
用户需求核对，不能盲从 CV）；系统只负责信息传递与状态/完成消息（Receipt、next 提示）。
Brain 派发 Worker 修复 + 系统登记（admit）的流程正确；repair_diff_digest 由 Brain 提供
真实 Git diff 摘要，现状满足。此裁决同时澄清：vNext 执行链的"每个动作唯一 owner"中的
owner 包括 Brain 的语义授权动作，不限于 Runtime 机械派发。

## 2026-08-09 S09/S10：executable proof bootstrap 与 harness-neutral CLI-first self-host

S08 已完成 Worker→CV→Commit→Integration→Gate→Review 正式执行闭环（受
S08-REVIEW-010 限制）。用户进一步确认：S10（旧标签 S08B）不是只补 Stage CLI，也不是以 OpenCode
Plugin tool 为主；它必须形成不依赖 OpenCode、Pi、Claude Code 等特定 harness 工具 API 的
ProofLoop v2 通用 CLI。不同 harness 只调整 Agent 定义和命令权限，不调整工具。

### 产品与技术边界

- 通用 public seam 为 `proofloop <domain> <operation>`。现有 `dist/cli/*.js` 只是迁移期内部
  entry；OpenCode tools 是 CLI 成熟后的 adapter，不得补偿 CLI 缺失的机械 operation。
- AI 负责理解用户、维护 Authority、规划、实现、反驳和评审；CLI 负责按阶段/角色解析
  Authority/Plan/Manifest/Receipt/Evidence/Git，生成不同最小 Context，机械检查 transition，
  并把 closed AI result 交给 Runtime owner 持久化。
- CLI 必须覆盖 Authority/Plan preflight 与 materialization、Manifest/Validator/Evidence/
  SPV/Stage Plan admission、Worker/CV/Commit/Integration、Gate、Stage Review、Project
  Acceptance、doctor/recovery；所有调用使用统一 structured request/result/exit contract。
- 旧 S08B 首次 compile/Validator/Evidence initialization 复核发现 Manifest Runtime Proof 仍为
  `not_applicable`，不能直接建立 final boundary。用户批准先执行独立 S09 restricted bootstrap：
  统一 executable Runtime Proof candidate/compiler/dispatch/Gate schema，并增加 Runtime-owned
  pristine Evidence refresh；随后 replan/recompile/refresh S10，使 Manifest 含真实 executable step。
- Runtime Stage ID 使用 `^S\d+$`；bootstrap 为 `S09`，通用 CLI 为 `S10`。旧 `S08B0`/`S08B`
  只保留为 invalid candidate/历史导航，不进入 status/admission request。
- S09 完成且 S10 final admission 后，S10-A 的 CLI bootstrap boundary 提交并集成；此后
  S10 所有机械操作必须走 public CLI，不得修改已 admitted Plan 来伪造自举。
- 删除顺序固定为：CLI bootstrap → Authority/Plan/Context → Stage execution →
  Review/Project/doctor → self-host/restart/harness-neutral process oracle → 迁移旧 oracle →
  删除 v1 stage CLI 与 `cv_level`/`sync-cv-status`/旧注释和权限。
- 旧 Manifest/Receipt/Stage 继续显式检测并 fail closed，不静默迁移；三项既有失败必须先
  按 canonical public CLI 行为判断根因。Runtime/CLI 问题本阶段修复；纯 OpenCode adapter
  问题登记到后续 Plugin 工作，禁止为追求全仓绿混入 Plugin 实现、放宽 CLI 断言或以 Host
  tool 结果代替 CLI 证据。
- S08-REVIEW-010 的真实 Runtime Proof 回填及全链重验单独排期，不纳入 S10。
- **S08-REVIEW-010 正式关闭（2026-08-14）**：该限制（“Gate 必须真实执行命令”）随 SG 职责
  缩减（SG 不再执行 runtime_proof 命令，构建+测试由 SR 评审承担）与 S10 受限关闭、AWI-023
  按 git_facts 兜底 Gate + 受限关闭新先例闭合而自然失效；回填不再单独排期。

### Authority 引用

- Bootstrap Goal：`tech-spec/task-acceptance-matrix.md#/entities/AWI-024`
- Bootstrap Acceptance：`tech-spec/task-acceptance-matrix.md#/entities/PLUGINV2-S08B0-BOOTSTRAP-ACCEPTANCE`
- Bootstrap Seam：`tech-spec/contract-state-matrix.md#/entities/PLUGINV2-S08B0-BOOTSTRAP-SEAM`
- Bootstrap Oracle：`tech-spec/ai-coding-architecture.md#/entities/PLUGINV2-S08B0-BOOTSTRAP-ORACLE`
- Bootstrap Risk：`tech-spec/hard-parts-register.md#/entities/HP-015-EXECUTABLE-PROOF-BOOTSTRAP`
- Goal：`tech-spec/task-acceptance-matrix.md#/entities/AWI-023`
- Acceptance：`tech-spec/task-acceptance-matrix.md#/entities/PLUGINV2-S08B-CLI-ACCEPTANCE`
- Seam：`tech-spec/contract-state-matrix.md#/entities/PLUGINV2-S08B-CLI-SEAM`
- Oracle：`tech-spec/ai-coding-architecture.md#/entities/PLUGINV2-S08B-CLI-ORACLE`
- Risks：`tech-spec/hard-parts-register.md#/entities/PLUGINV2-S08-D-RISK`、
  `tech-spec/hard-parts-register.md#/entities/PLUGINV2-S08-E-RISK`、HP-004/HP-010/HP-011/HP-014/HP-015。

### Candidate Stage 分解方向

以下只是 Materializer 的结构化输入方向，不是第二份 Stage Plan 权威：

0. S09-A/B：executable Runtime Proof closed schema/digest/Gate execution、canonical Stage ID
   parity + pre-admission pristine Evidence refresh transaction/recovery；一次性 `not_applicable`
   只记录 restricted bootstrap，
   不关闭 AWI-023；
1. S10-A：stable `proofloop` dispatcher、I/O/result/exit contract 和 no-harness-dependency
   bootstrap boundary；
2. S10-B：Authority/Plan commands、全角色 Context 和 CV Evidence gate；
3. S10-C：Stage next/status、Worker/CV/Commit/Integration admission 与 Gate；
4. S10-D：Stage Review、Project Acceptance、doctor/recovery；
5. S10-E：bootstrap 后真实 CLI self-host、fresh Plan fixture、三类 harness-neutral caller、
   restart、三个既有 Host 失败分类、旧 oracle/v1 CLI/legacy CV 残留 cutover。

S09 关闭后必须先 replan/recompile/refresh S10，并确认 Manifest 至少一个 executable proof
step；否则不得建立 S10 final boundary。每个 implement Task 必须在 candidate Plan 中声明
非空 `execution_scope.code_paths`、
`execution_scope.test_paths` 和禁止 `.proofloop/**`、`.git` 的 `forbidden_paths`。本次用户已批准
S09 规划一直推进到 Runtime Stage Plan admission；admission 成功后必须在派发
第一个 Worker 前停止，供用户检查。

## 2026-08-13 用户裁决：S10/S11 受限收尾（双 Stage Gate proof 缺陷登记）

用户选择选项 B（受限收尾，S08-REVIEW-010 / S09 restricted_bootstrap 先例精神）：

1. **事实**：S11 执行链完整（Worker → CV 四轮收敛 PASS → Slice Commit → Integration），
   但 `gate run` 的 `s11-context-tests` 步骤（`npx vitest run src/cli/proofloop-context.spec.ts`，
   cwd packages/runtime）与仓库 monorepo vitest 配置不兼容，永远找不到测试；S10 全部五个
   Slice 集成完成，但 `gate run` 的 `s10-cli-context-prepare` 步骤（`context prepare --role
   worker --stage S10`）在全部 Task 完成后无 Task anchor。两者均为 plan 级
   `runtime_proof.resolved_steps` 缺陷（SPV 未拦截命令-工具链一致性）。
2. **受限登记**：S11、S10 以 `COMPLETED-restricted` 关闭执行域；限制项为"Stage Gate 真实
   Runtime Proof 未通过（proof 步骤 plan 缺陷）"。代码成果有效且已提交（S11 链 tip 修复、
   S10-E cutover patch，build 全绿）。
3. **回填排期**：新 Stage 回填两个 Stage 的 Runtime Proof——修正失败步骤 →
   replan/recompile → Evidence rebind → fresh SPV → 重建 Stage Plan admission → 重验受影响
   Slice、Gate、Review（S08-REVIEW-010 模式：不得沿用旧绑定成果）。回填完成前，
   AWI-023 的 executable Gate proof 部分保持未闭合，PROJECT_ACCEPTANCE 不得启动。
4. **登记位置**：本文件与 `progress.md`；不写入 `hard-parts-register.md`（被 Manifest
   file_digest 绑定，改动会 invalidate 已 admission Stage）。
