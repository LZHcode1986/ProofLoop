# ProofLoop for OpenCode + OpenSpec 整改方案 v2

> 目标：保留 ProofLoop “AI 必须证明完成再声称完成”的核心价值，同时回到 OpenSpec 官方的轻量、流动、可迭代基线；把 ProofLoop 从“重文档硬阶段流程”整改为“OpenSpec artifact 基座 + OpenCode Agent 治理层 + 可执行证据协议”。

---

## 0. 结论先行

上一版判断 **大方向合理，但方案不够好**。

合理的部分：

1. 现在 ProofLoop 的确过重，尤其是文档 readiness、Reality readiness、TDD evidence、per-worker boundary 和多层 verifier 叠加后，普通任务会被审计级流程放大。
2. TDD “做了但 verifier 没找到证据”本质上不是 TDD 失败，而是 **证据协议与代理间传输失败**。
3. 当前失败归因太粗，容易把 `Evidence missing`、`Protocol failed`、`Planning insufficient` 都当成 `Verification failed`，导致不必要的重做。
4. 当前流程与 OpenSpec 官方“fluid / iterative / lightweight / progressive rigor”的方向不完全一致。

上一版不合理或不充分的部分：

1. 不能简单把流程拆成 Lite / Standard / Strict 然后绕过 OpenSpec。  
   ProofLoop 是建立在 OpenSpec 上的，整改必须保留：
   - `openspec status`
   - `openspec instructions`
   - `openspec validate`
   - `openspec archive`
   - schema / template / artifact dependency 模型
   - `tasks.md` checkbox tracking
   - `openspec/changes/**` 与 `openspec/specs/**` 的生命周期

2. 不应该把“轻量化”理解为少写 OpenSpec artifact。  
   更正确的做法是：
   - OpenSpec artifact 仍是基座。
   - ProofLoop 的额外治理门禁要分级。
   - 文档字段要从“表格完整性”改成“执行契约充足性”。
   - verifier 只阻塞真正影响执行安全和闭环证明的缺口。

3. 不能只给宏观建议，必须逐个整改子代理职责：
   - Brain
   - Propose
   - Spec Verifier
   - Reality Verifier
   - Executor
   - Worker
   - Code Verifier
   - Committer
   - Implementation Reviewer
   - Web Scraper

4. 不能忽略 OpenCode 的运行特性：
   - Primary agent / subagent 模型
   - 子代理通过 `@` 或 task 调用
   - agent markdown frontmatter
   - permission 精细控制
   - skills 按需加载
   - AGENTS.md 会进入上下文，过重会拖慢和污染决策
   - 子代理 child session 输出不应被假定为 verifier 自动可见

本方案的核心整改是：

> 不把 ProofLoop 改成更少文档，而是把 ProofLoop 改成：  
> **OpenSpec 官方 artifact flow 不变；ProofLoop 额外门禁按风险触发；证据协议结构化；失败归因精确；子代理职责不重叠；文档只记录执行所需契约。**

---

## 1. 基线约束

### 1.1 OpenSpec 基线不能破坏

ProofLoop 的整改必须服从以下 OpenSpec 基线：

| OpenSpec 基线 | ProofLoop 整改含义 |
| --- | --- |
| OpenSpec 是 artifact-guided workflow | ProofLoop 不能绕开 proposal/specs/design/tasks，而应通过 schema/template/rules 调整它们 |
| `openspec status --json` 是 artifact 状态来源 | Propose / Executor 不应靠猜测判断 artifact 是否 ready |
| `openspec instructions <artifact> --json` 是 agent 创建 artifact 的动态指导来源 | Propose 必须读取 instructions，而不是硬编码自己的 artifact 顺序 |
| `openspec validate --strict` 是结构校验 | 不能把它伪装成 implementation readiness |
| `tasks.md` 是 apply tracking | Worker / Executor 必须尊重 checkbox ownership |
| Archive 由 `openspec archive` 完成 | Implementation Reviewer 只能在 Brain 授权后执行 archive，不能替代 OpenSpec archive |
| OpenSpec 支持 custom schema | ProofLoop 的重治理应显式作为 ProofLoop schema，而不是伪装成官方默认 spec-driven |

### 1.2 OpenCode 基线不能忽略

ProofLoop 是给 OpenCode 用的，所以应顺着 OpenCode 机制设计：

| OpenCode 机制 | ProofLoop 整改含义 |
| --- | --- |
| Primary agents 与 subagents 分离 | Brain 是 primary / L0；其他角色是 subagent，不应越权 |
| Subagents 可被 primary agent 调用 | Executor 必须把 Worker / Code Verifier / Committer 输入打包清楚，不能让子代理读整个世界 |
| permission 控制工具能力 | 各代理权限要极小化，而不是靠自然语言约束 |
| skills 按需加载 | 不要让所有 agent 默认加载所有技能 |
| AGENTS.md 会进入上下文 | AGENTS.md 应保持短、稳定、路由级；细节放 contracts / skills / gate docs |
| 子代理 child session 输出不等于共享数据库 | verifier 必须收到明确 Evidence Packet，不应“自己去找” Worker 输出 |

---

## 2. 现状诊断

### 2.1 最大结构问题：ProofLoop 把 OpenSpec 的“流动动作”固化成了硬阶段门

OpenSpec 的思路是：

```text
proposal -> specs -> design -> tasks -> implement
```

但它并不是传统 waterfall。它允许随着代码理解更新 artifact。ProofLoop 当前虽然也写了“可以更新 artifact”，但实际操作上：

```text
PRD -> Propose -> Spec Verifier -> Reality Verifier -> Executor -> Worker -> Committer -> Code Verifier -> Implementation Reviewer -> Archive
```

每一步都可能变成硬门禁。  
这会导致一个实际问题：

> Agent 大量时间不是在澄清产品、写代码、跑测试，而是在证明前一个文档字段写得足够符合格式。

这背离了 ProofLoop 本来的目标。ProofLoop 要证明的是 **闭环完成**，不是证明每个 Markdown 字段都完美。

### 2.2 Schema 名称与行为存在认知错位

当前仓库把 ProofLoop schema 保持为 `spec-driven`，用于 OpenSpec 兼容。这个设计短期可用，但它造成了一个认知问题：

- 官方 `spec-driven` 是轻量 spec-driven baseline。
- ProofLoop 的 `spec-driven` 已经增加了：
  - proofability check
  - reality snapshot
  - Stage Acceptance Coverage Map
  - per-slice verifier
  - boundary evidence
  - TDD evidence
  - implementation done check

这已经不是 stock `spec-driven`，而是一个 **ProofLoop-opinionated spec-driven schema**。

整改建议：

```text
新项目默认使用：proofloop-spec-driven
保留旧名：spec-driven
旧名定位：legacy alias / compatibility alias
```

这样不破坏 OpenSpec，又能让用户清楚知道自己在用 ProofLoop 加强版，而不是官方默认版。

### 2.3 文档字段过多，但很多字段是重复表达

当前 `tasks.md` 模板要求每个 code-changing task 都写：

- Files
- Allowed File Scope
- Boundary Receipt Required
- TDD Test Files
- RED Verification
- GREEN Verification
- Verification

每个 verifier task 又写：

- Files
- Verification
- Covered Tasks
- Inspection Scope
- Inspection Content
- Out of Scope
- Boundary Evidence Required
- PASS/FAIL Gate

这对单个任务来说是清楚的，但在一个 slice 有多个相似任务时，会产生大量重复字段。重复越多，越容易：

- 文档漏字段
- 字段不一致
- spec-verifier 多次 fail
- Propose 花大量时间修 Markdown，而不是修执行契约

整改原则：

> 把重复字段上移到 slice-level contract；task 只写差异。

### 2.4 TDD skill 与 Worker 权限存在冲突

当前 `test-driven-development` skill 里面写了：

- Confirm with user what interface changes are needed
- Confirm with user which behaviors to test
- Ask: “What should the public interface look like?”

但 Worker 的权限是 `question: deny`，并且 Worker 是由 Executor 派发的子代理。  
这会造成隐性冲突：

- TDD skill 要问用户。
- Worker 不能问用户。
- Worker 如果严格遵守 TDD skill，就可能 blocked。
- Worker 如果不问用户，就可能被认为没有完整 TDD planning。
- Verifier 再去查 evidence 时，就可能判不通过。

整改原则：

> TDD skill 必须增加 “OpenCode Worker non-interactive mode”：  
> 当由 Worker 加载时，Task Packet 就是用户批准的接口和行为边界；Worker 不再问用户。若 Task Packet 无法定义可测试行为，返回 `Implementation blocked: untestable task packet`。

### 2.5 Evidence 不是缺少“文件”，而是缺少“协议”

当前协议已经说 dedicated evidence files 默认不需要，证据可以来自：

- Worker response fields
- verification command outputs
- git boundary receipts
- diff inspection results

这是对的。问题在于：

> Code Verifier 不应该“找证据”，它应该“收到证据包并验证证据包”。

当前 Executor 与 Code Verifier 之间没有强制 Evidence Packet。  
结果是 Worker 做了 TDD，但 evidence 没被稳定传给 Code Verifier，Code Verifier 就判失败。

整改原则：

```text
Worker Summary != Evidence Packet
Evidence Packet = Executor 在 slice gate 前组装的结构化数据
Code Verifier 先验证 Evidence Packet 是否完整，再验证代码
```

### 2.6 Per-worker commit boundary 成本过高

当前 Executor 要求每个 Worker 完成后都由 Committer 关闭 worker-output boundary。  
这在审计场景很强，但日常开发成本高。

更合理的是：

- 高风险任务：每 Worker commit
- 普通 slice：每 slice commit
- 同一 slice 内连续小任务：可用 diff snapshot / dirty scope tracking
- docs / no-op：no-op receipt

整改不是取消 boundary，而是把 boundary 从固定粒度改成 **按风险和文件交叠决定粒度**。

### 2.7 Verifier 过多地做二元判断

当前 Spec Verifier、Reality Verifier、Code Verifier、Implementation Reviewer 都倾向于 PASS / FAIL。  
这会产生“所有小问题都阻塞”的结果。

整改原则：

- Planning artifact 问题分为：`BLOCKER` / `WARNING` / `NOTE`
- Reality 问题分为：`CONTRADICTION` / `UNVERIFIED` / `CONFIRMED`
- Implementation 问题分为：`IMPLEMENTATION DEFECT` / `EVIDENCE DEFECT` / `PROTOCOL DEFECT`
- Archive review 分为：`critical` / `warning` / `suggestion`

只有真正影响最小闭环、验收标准、可执行性、安全/数据风险的问题才阻塞。

---

## 3. 目标架构

### 3.1 五层架构

```text
┌──────────────────────────────────────────────┐
│ L0 Brain Governance                           │
│ - user intent / PRD / stage / proof posture   │
│ - archive authorization                       │
└──────────────────────────────────────────────┘
                    │
┌──────────────────────────────────────────────┐
│ OpenSpec Artifact Layer                       │
│ - schema.yaml                                 │
│ - proposal.md / specs / design.md / tasks.md  │
│ - status / instructions / validate / archive  │
└──────────────────────────────────────────────┘
                    │
┌──────────────────────────────────────────────┐
│ OpenCode Agent Execution Layer                │
│ - Propose / Executor / Worker / Committer     │
│ - Code Verifier / Reality Verifier            │
└──────────────────────────────────────────────┘
                    │
┌──────────────────────────────────────────────┐
│ Evidence Protocol Layer                       │
│ - Evidence Packet                             │
│ - boundary receipt                            │
│ - command output excerpts                     │
│ - diff inspection                             │
└──────────────────────────────────────────────┘
                    │
┌──────────────────────────────────────────────┐
│ Review & Archive Layer                        │
│ - Implementation Reviewer                     │
│ - Brain archive authorization                 │
│ - openspec archive                            │
└──────────────────────────────────────────────┘
```

### 3.2 新增概念：Proof Posture，而不是独立流程

不要叫 Lite / Standard / Strict，因为这容易让人以为绕开 OpenSpec。  
建议叫 **Proof Posture**，即“证明姿态”。

| Proof Posture | 用途 | OpenSpec artifact | ProofLoop 额外门禁 | Boundary |
| --- | --- | --- | --- | --- |
| P0 Fast Proof | 小 bugfix、docs/tooling、单入口单闭环 | 仍走 OpenSpec；可用 rapid schema 或 proofloop-spec-driven 的最小模板 | 不强制独立 Spec/Reality subagent；使用 self-check + openspec validate；最终 Code Verifier 可选或单次 | final 或 slice boundary |
| P1 Stage Proof | 默认；普通功能、多文件但风险可控 | proofloop-spec-driven | Spec/Reality 输出 blocker/warning/note；每 slice 一个 Code Verifier | slice boundary |
| P2 Audit Proof | 权限、安全、数据迁移、跨模块、长期规范 | proofloop-spec-driven 全量 | Spec/Reality hard gate；per-slice 或 per-task Code Verifier；Implementation Reviewer 强审计 | worker or task boundary |

关键点：

> Proof Posture 是 ProofLoop overlay，不是绕过 OpenSpec 的替代流程。

---

## 4. OpenSpec Schema 整改

### 4.1 Schema 命名整改

#### 当前问题

```yaml
name: spec-driven
description: <project name> reusable OpenSpec workflow schema with proposal, design, specs, tasks, and unified readiness gates before apply
```

它叫 `spec-driven`，但行为已经是 ProofLoop 加强版。

#### 建议改成

```yaml
name: proofloop-spec-driven
version: 1
description: ProofLoop governance schema built on OpenSpec spec-driven artifacts with proof posture, verifier gates, and evidence contracts.
```

#### 迁移策略

1. 新项目默认：

```yaml
schema: proofloop-spec-driven
```

2. 保留旧目录作为兼容：

```text
openspec/schemas/spec-driven/
```

但 README 明确：

```text
spec-driven is a legacy compatibility alias.
New ProofLoop installs should use proofloop-spec-driven.
```

3. 安装器增加参数：

```powershell
-UseLegacySpecDrivenName
```

默认不用旧名。

### 4.2 不要修改 OpenSpec 官方 artifact 生命周期

保留：

```text
proposal -> specs -> design -> tasks -> apply -> archive
```

但调整 ProofLoop 增强字段：

- proposal：只保留闭环、验收、风险、现实快照，不写执行细节
- specs：只写行为契约，不写内部实现
- design：只写会影响任务拆解的技术决策
- tasks：只写执行契约和验证契约，不重复 proposal/design

### 4.3 `tasks.md` 模板减重：引入 Slice Contract

#### 当前重复模式

每个任务都重复写 TDD 文件、RED/GREEN 命令、验证命令、文件范围。

#### 新模板结构

```md
## 3. Slice 1: <slice-name>

### Slice Contract

- **Slice Goal:** <one independently verifiable capability or module boundary>
- **Acceptance Criteria:**
  - AC-S1-1: <criterion>
  - AC-S1-2: <criterion>
- **Default Allowed File Scope:**
  - <files or directories>
- **TDD Contract:** required | not-applicable
- **TDD Test Files:**
  - <test files>
- **RED Command:** <command expected to fail before implementation>
- **GREEN Command:** <command expected to pass after implementation>
- **Additional Verification Commands:**
  - <command>
- **Boundary Mode:** final | slice | per-task
- **Verifier Gate:** 3.V

### Tasks

- [ ] 3.1 <task>
  - **Uses Slice Contract:** yes
  - **Overrides:** none

- [ ] 3.2 <task>
  - **Uses Slice Contract:** yes
  - **Overrides:**
    - Allowed File Scope: <only if different>

- [ ] 3.V <Slice 1 verifier>
  - **Covered Tasks:** 3.1, 3.2
  - **Evidence Packet Required:** yes
  - **Inspection Scope:** Slice 1 artifacts + changed files + TDD test files + command excerpts
  - **PASS/FAIL Gate:** all Slice 1 ACs pass; no scope violation; no critical regression
```

这样仍满足 ProofLoop 的证明需求，但减少重复字段。

### 4.4 Stage Acceptance Coverage Map 改成 ID 映射

不要把完整长句到处复制。改为：

```md
## Stage Acceptance Coverage Map

| Stage AC ID | Criterion Summary | Covered By | Proof Source |
| --- | --- | --- | --- |
| SAC-1 | User can complete login loop | Slice 1 verifier | Evidence Packet S1 + e2e command |
| SAC-2 | Invalid credentials show error | Slice 1 verifier | RED/GREEN test + verifier inspection |
| SAC-3 | Existing session behavior unchanged | Reconciliation | regression command |
```

Acceptance criteria 原文仍在 PRD / Brain Dispatch 中保持 immutable。  
`tasks.md` 只引用 ID 和 summary，避免下游改写验收标准。

### 4.5 Readiness Gate 改成三类

当前很多 checklist 是硬阻塞。改为：

```md
## Readiness Gate

### BLOCKER
- [ ] No Stage AC is missing from Coverage Map
- [ ] Every code-changing slice has a TDD Contract or an explicit reason TDD is not applicable
- [ ] Every verifier gate has covered tasks and PASS/FAIL criteria
- [ ] Minimum closed loop entry path is explicit
- [ ] Critical runtime assumptions are either confirmed or explicitly marked unverified with mitigation

### WARNING
- [ ] Some non-critical edge cases are deferred
- [ ] Some assumptions remain unverified but do not block the minimum loop
- [ ] Design has minor drift risk but tasks include validation commands

### NOTE
- [ ] Formatting or naming improvements
- [ ] Optional additional tests
- [ ] Future cleanup
```

Spec Verifier 只因 `BLOCKER` 返回 blocking status。

---

## 5. 子代理职责整改

## 5.1 Brain Agent

### 当前职责保留

Brain 继续负责：

- 用户意图
- PRD / CLARIFY / tech-spec
- stage decomposition
- acceptance criteria immutability
- subagent dispatch
- archive authorization

### 新增职责：Proof Posture Classifier

Brain 在 dispatch Propose 前必须输出：

```text
Proof Posture: P0 Fast Proof | P1 Stage Proof | P2 Audit Proof

Reason:
- risk:
- scope:
- affected files/modules:
- security/data impact:
- user-visible behavior:
- rollback complexity:
```

### 分类规则

| 条件 | Proof Posture |
| --- | --- |
| docs/tooling/no production behavior | P0 |
| 单文件 bugfix，验收清楚，无安全/数据影响 | P0 |
| 普通功能，多文件，影响一个 user loop | P1 |
| 多 slice 功能，跨模块但边界清楚 | P1 |
| auth/authz/security/privacy/payment/storage/migration | P2 |
| 跨 repo / 多服务 / 数据迁移 / 并发一致性 | P2 |
| 用户明确要求审计证据 | P2 |

### Brain 不应做的事

- 不要为所有小任务强制 PRD 大文档。
- 不要把整个 PRD 一次性发给 Propose。
- 不要让子代理向用户问产品问题。
- 不要把 Spec Verifier 的 WARNING 当成必须重做。
- 不要把 Evidence missing 当成代码失败。

### 需要修改的文件

```text
.opencode/agents/brain.md
AGENTS.md
.agents/contracts/dispatch-packets.md
```

---

## 5.2 Propose Agent

### 当前问题

Propose 当前强制所有变更都跑：

```text
openspec validate --strict
Spec Verifier
Reality Verifier
```

并把 readiness 作为硬完成条件。  
这让 proposal 阶段极易因为文档字段反复失败。

### 新职责

Propose 是 **OpenSpec artifact author**，不是审计法官。

Propose 必须：

1. 读取 `openspec status --change <name> --json`
2. 读取 `openspec instructions <artifact> --change <name> --json`
3. 按 schema 创建 / 更新 artifact
4. 保持 Brain acceptance criteria immutable
5. 输出 artifact status 和 blocker/warning/note
6. 按 Proof Posture 决定 verifier 强度

### Verifier 调用策略

| Proof Posture | Spec Verifier | Reality Verifier |
| --- | --- | --- |
| P0 | 默认不派发；Propose self-check + `openspec validate` | 只做 contradictions scan；可由 Propose 自查 |
| P1 | 派发，但输出 blocker/warning/note；仅 blocker 阻塞 | 派发；contradicted critical 阻塞，unverified 变 risk |
| P2 | 派发，BLOCKER 必须修复 | 派发，critical unverified 也可阻塞 |

### Propose 输出格式

```text
Proposal ready | Planning blocked | Stage repartition required | Clarification required

Change:
Stage:
Proof Posture:
OpenSpec status:
OpenSpec validation:
Artifact readiness:
- proposal:
- specs:
- design:
- tasks:

Readiness findings:
- BLOCKER:
- WARNING:
- NOTE:

Reality findings:
- CONTRADICTION:
- UNVERIFIED:
- CONFIRMED:

Next action:
```

### 需要修改的文件

```text
.opencode/agents/propose.md
.agents/skills/openspec-propose/SKILL.md
openspec/schemas/proofloop-spec-driven/schema.yaml
openspec/schemas/proofloop-spec-driven/templates/*.md
```

---

## 5.3 Spec Verifier

### 当前问题

Spec Verifier 是二元：

```text
DOC READINESS PASS
DOC READINESS FAIL
```

它容易把格式缺失、轻微映射不清和真正无法执行混成 FAIL。

### 新职责

Spec Verifier 只判断 **文档是否足以安全执行**，不是检查所有字段是否完美。

### 新输出格式

```text
DOC READINESS: BLOCKED | READY_WITH_WARNINGS | READY

### BLOCKERS
1. Deficient Artifact(s):
2. Execution Impact:
3. Required Fix:

### WARNINGS
1. Artifact:
2. Risk:
3. Suggested Fix:

### NOTES
- optional improvement

### Acceptance Coverage
- Covered:
- Missing:
- Ambiguous:
```

### 阻塞标准

只在以下情况 BLOCKED：

- Stage Acceptance Criteria 没有覆盖
- 最小闭环入口不明确
- 任务不知道该改什么
- 任务不知道不该改什么
- 没有可执行验证方法
- code-changing slice 没有 TDD Contract，且没有说明 TDD 不适用
- verifier gate 没有 covered tasks 或 PASS/FAIL gate
- proposal/design/tasks 之间存在影响执行的冲突

不阻塞：

- 字段顺序不标准
- 轻微格式问题
- `Skill Reason` 不够漂亮
- warning 级别 edge case
- 可以由 Worker 在执行时确认的非关键事实

### 需要修改的文件

```text
.opencode/agents/spec-verifier.md
openspec/QUALITY-GATE.md
```

---

## 5.4 Reality Verifier

### 当前问题

Reality Verifier 说自己以 CodeGraph 为主要结构检查来源，但默认 OpenCode 权限未必提供 CodeGraph。  
这会造成大量 `unverified`，然后被当成 readiness fail。

### 新职责

Reality Verifier 是 **contradiction detector**，不是“证明所有现实”的 agent。

### 新输出格式

```text
REALITY READINESS: BLOCKED | READY_WITH_RISKS | READY

### Critical Contradictions
- claim:
- reality:
- evidence:
- impact:

### Unverified Assumptions
- assumption:
- why unverified:
- risk level: critical | normal | low
- mitigation:

### Confirmed Anchors
- entry path:
- handler/service:
- state/persistence:
- tests/commands:
```

### 阻塞规则

| 状态 | 是否阻塞 |
| --- | --- |
| contradicted + 影响 minimum closed loop | 阻塞 |
| contradicted + 安全/数据/迁移 | 阻塞 |
| unverified + P2 critical assumption | 阻塞 |
| unverified + 可由 Worker 在任务中确认 | 不阻塞，转 task risk |
| confirmed | 不阻塞 |

### 工具能力声明

Reality Verifier 输出必须声明：

```text
Inspection Capability:
- CodeGraph available: yes/no
- Repository grep/read available: yes/no
- Commands run:
```

如果 CodeGraph 不可用，不允许把“没有 CodeGraph”本身当 blocker。

### 需要修改的文件

```text
.opencode/agents/reality-verifier.md
.opencode/agents/reality-verifier-codegraph.md
openspec/QUALITY-GATE.md
```

---

## 5.5 Executor

### 当前问题

Executor 是卡住最多的地方：

- in-memory ledger 容易丢证据
- Code Verifier 依赖 Worker summary，但不一定收到
- 每个 Worker 后都 commit，成本高
- evidence missing 直接触发 repair
- rescue 没区分 implementation defect 和 protocol defect

### 新职责

Executor 是 **orchestrator + evidence broker**。

Executor 必须在每个 verifier gate 前组装：

```text
Executor Evidence Packet
```

Code Verifier 不再自行从上下文里“找证据”。

### Evidence Packet 标准

```text
Executor Evidence Packet

Change:
Stage:
Slice / Gate:
Proof Posture:

Covered Tasks:
- Task ID:
  Task Summary:
  Execution Type:
  Required Skills:
  TDD Contract Ref:
  Worker Status:
  Worker Summary Excerpt:
  Checkbox Updated:
  Updated Checkbox Line:

TDD Evidence:
- Task ID:
  RED:
    command:
    expected:
    observed:
    excerpt:
  GREEN:
    command:
    observed:
    excerpt:
  REFACTOR:
    changed: yes/no
    action:
    post-refactor command:
    excerpt:

Verification Commands:
- command:
  task/slice:
  result:
  excerpt:

Boundary Evidence:
- Task ID:
  boundary mode: final | slice | per-task | no-op
  receipt type: commit | no-op | diff-snapshot
  commit hash:
  files changed:
  scope check:
  diff evidence available:

Acceptance Evidence:
- Stage AC ID:
  Slice AC ID:
  Evidence source:
  Notes:

Known Residual Risks:
```

### Boundary Mode 决策

| 场景 | Boundary Mode |
| --- | --- |
| P2 / security / migration / public contract | per-task |
| P1 ordinary slice | slice |
| P0 small fix | final |
| docs/no-op | no-op |
| same slice tasks touch overlapping files | per-task or single Worker batch |
| same slice tasks touch disjoint files | slice |

### 新失败归因

Executor 接收 Code Verifier 结果后按类别处理：

| Verifier 结果 | Executor 动作 |
| --- | --- |
| IMPLEMENTATION DEFECT | Worker repair |
| EVIDENCE DEFECT | 补 Evidence Packet；不要改代码 |
| PROTOCOL DEFECT | 修 dispatch packet / agent contract；不要改代码 |
| PLANNING DEFECT | 返回 Propose / Brain |
| REALITY CONTRADICTION | 返回 Brain / Propose |
| PASS | 继续下一 slice |

### Evidence-only Backfill

当 Worker 做了 TDD 但 evidence 缺字段时，不要重新执行 implementation。  
Executor 派发：

```text
Executor Dispatch: Worker Evidence Backfill
```

要求 Worker：

- 不改产品代码
- 不改已完成 task checkbox
- 只补充 RED/GREEN/REFACTOR evidence
- 必要时可重跑只读测试命令
- 返回结构化 evidence

### 需要修改的文件

```text
.opencode/agents/executor.md
.agents/contracts/executor-dispatch-packets.md
.agents/skills/openspec-apply-change/SKILL.md
openspec/QUALITY-GATE.md
```

---

## 5.6 Worker

### 当前问题

Worker 既要遵守 TDD skill，又不能问用户。  
TDD evidence 还靠自然语言输出，容易不稳定。

### 新职责

Worker 是 **task executor + local evidence producer**。

Worker 必须：

1. 只执行 Executor 给出的 task 或 evidence-backfill
2. 使用 Task Packet 作为已批准的 interface / behavior source
3. 若 Task Packet 不可测试，立即 blocked
4. 若 TDD required，按 Evidence Contract 输出 RED/GREEN/REFACTOR
5. 只更新自己负责的 implementation checkbox

### TDD Non-interactive Mode

在 `test-driven-development/SKILL.md` 增加：

```md
## OpenCode Worker Non-interactive Mode

When this skill is loaded by a Worker subagent:
- Do not ask the user questions.
- Treat the Task Packet, Slice Contract, and Acceptance Criteria as the approved testing scope.
- If public interface, behavior, or verification target is missing, return:
  `Implementation blocked: untestable task packet`.
- Do not invent extra product scope to make TDD possible.
- Produce RED/GREEN/REFACTOR evidence in the required structured fields.
```

### Worker 输出格式整改

```text
Implementation finished | Implementation blocked | Implementation failed | Evidence backfilled

Task:
Execution Type:
Required Skills:
TDD Contract:
- source:
- applicable: yes/no

TDD Evidence:
- RED:
  - command:
  - expected failure:
  - observed result:
  - excerpt:
- GREEN:
  - command:
  - observed result:
  - excerpt:
- REFACTOR:
  - changed: yes/no
  - action:
  - post-refactor command:
  - excerpt:

Files changed:
Checkbox updated:
Acceptance evidence:
Verification commands:
Noticed but not changed:
Blocker or failure reason:
```

### 需要修改的文件

```text
.opencode/agents/worker.md
.agents/skills/test-driven-development/SKILL.md
.agents/contracts/executor-dispatch-packets.md
```

---

## 5.7 Code Verifier

### 当前问题

Code Verifier 同时在做：

- 代码审查
- TDD compliance
- boundary receipt 检查
- evidence 查找
- checkbox consistency
- slice acceptance 判断

这很强，但问题是：证据缺失时它只能 `Verification failed`。  
这会触发 Worker repair，导致重做。

### 新职责

Code Verifier 是 **slice gate verifier**，不是 evidence hunter。

它的输入必须包含 Evidence Packet。  
它先判断 evidence packet 是否完整，再判断代码是否通过。

### 新输出格式

```text
Verification passed | Verification failed | Verification blocked

Category:
- PASS
- IMPLEMENTATION DEFECT
- EVIDENCE DEFECT
- PROTOCOL DEFECT
- PLANNING DEFECT

Severity:
- Critical
- Normal
- Warning

Gate:
Covered tasks:

Evidence Packet Check:
- complete: yes/no
- missing fields:
- inconsistent fields:

Slice acceptance coverage:
Boundary integrity:
TDD evidence:
Diff inspection:
Checkbox consistency:

Findings:
Minimal next action:
- repair implementation
- backfill evidence
- fix executor packet
- return to propose
```

### 关键规则

- Evidence Packet 缺失：`Verification blocked / EVIDENCE DEFECT`
- Worker summary 有 evidence，但 Executor 没传：`PROTOCOL DEFECT`
- Worker 没做 RED/GREEN：`EVIDENCE DEFECT` 或 `IMPLEMENTATION DEFECT`，按是否代码逻辑有问题区分
- 代码不满足 slice AC：`IMPLEMENTATION DEFECT`
- verifier task 自己要求了协议外 evidence 文件：`PROTOCOL DEFECT`
- 不允许因 evidence missing 直接要求重写代码

### 需要修改的文件

```text
.opencode/agents/code-verifier.md
.agents/contracts/executor-dispatch-packets.md
openspec/QUALITY-GATE.md
```

---

## 5.8 Committer

### 当前问题

Committer 的职责清晰，但被调用太频繁。  
它应该继续保留 git boundary 价值，但粒度由 Executor 决定。

### 新职责

Committer 是 **boundary closure agent**，不是“每个 Worker 后必调用”的固定步骤。

### Boundary Receipt 类型

```text
commit
no-op
diff-snapshot
```

#### commit

用于：

- P2
- high-risk task
- overlapping file scope
- archive output
- user要求审计 commit

#### no-op

用于：

- read-only proof
- docs check
- Worker 没改文件

#### diff-snapshot

用于：

- P0/P1 中间小任务
- 后续仍在同一 slice 内继续修改
- Executor 需要保留 scope evidence，但不需要立即 commit

如果保留当前 Committer 只负责 commit/no-op，不建议让它写 diff-snapshot。  
可以选择两种方案：

### 方案 A：扩展 Committer

Committer 可返回：

```text
Diff snapshot recorded
```

但不写文件，只在响应中给出：

- dirty files
- allowed scope check
- diff stat inspected
- no commit hash

### 方案 B：新增 Boundary Recorder

新增轻量 subagent：

```text
.opencode/agents/boundary-recorder.md
```

权限：

```yaml
edit: deny
bash:
  "git status*": allow
  "git diff*": allow
```

只返回 diff snapshot，不 commit。

推荐：**先用方案 A，减少代理数量。**

### 需要修改的文件

```text
.opencode/agents/committer.md
.agents/contracts/executor-dispatch-packets.md
.opencode/agents/executor.md
```

---

## 5.9 Implementation Reviewer

### 当前问题

Implementation Reviewer 的定位是 stage-level review，这是对的。  
但它容易重复 Code Verifier 的工作，或把所有 residual risk 都变 archive blocker。

### 新职责

Implementation Reviewer 应对齐 OpenSpec verify 的三个维度：

```text
Completeness
Correctness
Coherence
```

### 新输出格式

```text
Stage review passed | Stage review failed | Stage review passed with warnings

Change:
Stage:
Proof Posture:

Completeness:
- tasks:
- stage AC coverage:
- unresolved items:

Correctness:
- verifier gates:
- critical behavior:
- tests / commands:

Coherence:
- proposal/design/spec/tasks alignment:
- implementation alignment:
- known drift:

Archive recommendation:
- ready
- ready-with-warnings
- not-ready
- not-applicable

Critical blockers:
Warnings:
Suggestions:
Next action:
```

### Archive 规则

| Review Result | Brain Action |
| --- | --- |
| passed + ready | 可授权 archive |
| passed with warnings + ready-with-warnings | Brain 可按风险授权 archive，并记录 warnings |
| failed + not-ready | 不 archive |
| workflow defect | Brain 更新 workflow docs，不让 Worker 重做 |

### 需要修改的文件

```text
.opencode/agents/implementation-reviewer.md
.opencode/agents/brain.md
openspec/QUALITY-GATE.md
```

---

## 5.10 Web Scraper

### 当前问题

Web Scraper 当前职责相对清晰，但需要避免把外部研究热注入 Worker。

### 新职责

Web Scraper 只给 Brain / Propose 提供外部事实包：

```text
External Research Packet

Question:
Scope:
Sources:
Findings:
Confidence:
How this affects PRD/proposal/design/tasks:
What is still unknown:
```

Worker 不应直接使用 Web Scraper 输出，除非 Propose 已把它沉淀进 OpenSpec artifact。

### 需要修改的文件

```text
.opencode/agents/web-scraper.md
.agents/contracts/dispatch-packets.md
```

---

## 6. 关键流程整改

## 6.1 新 Propose 流程

```text
Brain
  -> classify Proof Posture
  -> dispatch one stage

Propose
  -> openspec status --json
  -> openspec instructions proposal/specs/design/tasks --json
  -> create/update artifacts
  -> openspec validate <change> --strict
  -> self-check Proofability
  -> if P1/P2: dispatch Spec Verifier
  -> if P1/P2: dispatch Reality Verifier
  -> summarize blocker/warning/note
  -> return Brain
```

P0 不默认派发 Spec Verifier / Reality Verifier，除非：

- Brain 标记 risk
- Propose 发现 contradiction
- OpenSpec validation invalid
- task 无法验证
- acceptance criteria 不可映射

## 6.2 新 Apply 流程

```text
Executor
  -> openspec status --change <name> --json
  -> openspec instructions apply --change <name> --json
  -> read tasks.md and context files
  -> build Slice Execution Plan
  -> choose Boundary Mode
  -> dispatch Worker for task or safe task group
  -> collect Worker Summary
  -> close boundary according to Boundary Mode
  -> assemble Evidence Packet
  -> dispatch Code Verifier at explicit slice gate
  -> handle result by category
```

## 6.3 新 Evidence Flow

```text
Worker produces local evidence
        │
        ▼
Executor normalizes into Evidence Packet
        │
        ▼
Code Verifier validates packet + code + diff
        │
        ├── PASS -> next slice
        ├── EVIDENCE DEFECT -> evidence backfill
        ├── PROTOCOL DEFECT -> fix dispatch/contract
        ├── IMPLEMENTATION DEFECT -> Worker repair
        └── PLANNING DEFECT -> Propose/Brain
```

## 6.4 新 Rescue Flow

### 当前问题

```text
Verification failed -> Worker repair
```

太粗。

### 新规则

```text
IMPLEMENTATION DEFECT
  -> Worker repair
  -> max 2 attempts
  -> diagnose

EVIDENCE DEFECT
  -> Evidence backfill
  -> max 1 attempt
  -> if still missing, protocol blocker

PROTOCOL DEFECT
  -> Executor fixes packet or Brain updates contract
  -> no code changes

PLANNING DEFECT
  -> return to Propose
  -> patch artifacts
  -> no Worker repair

REALITY CONTRADICTION
  -> return to Brain
  -> re-stage / re-plan
```

---

## 7. 文档减重方案

## 7.1 AGENTS.md 减重

AGENTS.md 应只保留：

- authority order
- role ownership
- proof posture classifier
- failure attribution rules
- “do not bypass OpenSpec”
- “do not treat evidence missing as implementation failure”

把长细节移动到：

```text
.agents/contracts/*.md
openspec/QUALITY-GATE.md
.opencode/agents/*.md
.agents/skills/*/SKILL.md
```

OpenCode 支持通过 `opencode.json` 的 `instructions` 加载外部规则。建议：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": [
    "AGENTS.md",
    "openspec/QUALITY-GATE.md",
    ".agents/contracts/*.md"
  ]
}
```

如果上下文太重，则不要全量 instructions，而是在 AGENTS.md 里写 lazy loading 规则。

## 7.2 QUALITY-GATE.md 重写

当前 `QUALITY-GATE.md` 是统一 checklist。  
建议拆为：

```text
openspec/QUALITY-GATE.md
openspec/gates/propose-readiness.md
openspec/gates/reality-readiness.md
openspec/gates/implementation-done.md
openspec/gates/archive-readiness.md
```

`QUALITY-GATE.md` 作为索引：

```md
# ProofLoop Quality Gate Index

- Propose Readiness: gates/propose-readiness.md
- Reality Readiness: gates/reality-readiness.md
- Implementation Done: gates/implementation-done.md
- Archive Readiness: gates/archive-readiness.md

Rules:
- BLOCKER blocks.
- WARNING records risk but does not block unless Brain escalates.
- NOTE never blocks.
```

## 7.3 tasks.md 字段减少

将每 task 的重复字段改成：

```md
- [ ] 3.1 <task>
  - **Contract:** Slice 1
  - **Overrides:** none
```

只有当 task 偏离 slice contract 才写 overrides。

## 7.4 Evidence 不默认落文件

不要默认要求每次都写 physical evidence 文件。  
默认走 Evidence Packet。  
只有以下场景才写 `output/changes/<change>/`：

- 截图
- 录屏
- 浏览器交互 proof
- 外部系统导出
- P2 audit
- 上下文容易丢失的长任务

---

## 8. 需要落地的文件修改清单

### 8.1 第一优先级：证据链与 TDD

| 文件 | 修改 |
| --- | --- |
| `.agents/contracts/executor-dispatch-packets.md` | 新增 Evidence Packet、Worker Evidence Backfill、Verification result categories |
| `.opencode/agents/executor.md` | Executor 成为 evidence broker；区分 defect categories |
| `.opencode/agents/worker.md` | 新增 Evidence Backfill 模式；规范 TDD evidence 输出 |
| `.opencode/agents/code-verifier.md` | 新增 `Verification blocked`、EVIDENCE/PROTOCOL/IMPLEMENTATION 分类 |
| `.agents/skills/test-driven-development/SKILL.md` | 新增 OpenCode Worker non-interactive mode |

### 8.2 第二优先级：Verifier 降噪

| 文件 | 修改 |
| --- | --- |
| `.opencode/agents/spec-verifier.md` | PASS/FAIL 改为 BLOCKED/READY_WITH_WARNINGS/READY |
| `.opencode/agents/reality-verifier.md` | contradiction-first；unverified 不默认阻塞 |
| `openspec/QUALITY-GATE.md` | blocker/warning/note 分类 |

### 8.3 第三优先级：Schema 与模板

| 文件 | 修改 |
| --- | --- |
| `openspec/schemas/spec-driven/` | 保留为 legacy alias |
| `openspec/schemas/proofloop-spec-driven/` | 新建正式 ProofLoop schema |
| `openspec/schemas/proofloop-spec-driven/schema.yaml` | 加 Proof Posture 与 slice contract 指令 |
| `openspec/schemas/proofloop-spec-driven/templates/tasks.md` | 重写为 slice contract 模式 |
| `openspec/schemas/proofloop-spec-driven/templates/proposal.md` | 精简执行细节，强化 minimum closed loop |
| `openspec/schemas/proofloop-spec-driven/templates/design.md` | 只保留影响实现的技术决策 |
| `install/install-proofloop.ps1` | 默认安装新 schema，提供 legacy 参数 |
| `install/README.md` | 说明 ProofLoop schema 与官方 spec-driven 的关系 |

### 8.4 第四优先级：边界与 archive

| 文件 | 修改 |
| --- | --- |
| `.opencode/agents/committer.md` | 支持 boundary mode 与 diff-snapshot receipt |
| `.opencode/agents/implementation-reviewer.md` | 对齐 completeness/correctness/coherence |
| `.opencode/agents/brain.md` | Brain archive decision 支持 ready-with-warnings |

---

## 9. 建议的 Git 改造顺序

### Change 1：repair-evidence-protocol

目标：先解决你现在最痛的 TDD evidence 误判问题。

范围：

```text
.agents/contracts/executor-dispatch-packets.md
.opencode/agents/executor.md
.opencode/agents/worker.md
.opencode/agents/code-verifier.md
.agents/skills/test-driven-development/SKILL.md
```

验收标准：

- Worker TDD evidence 必须结构化输出。
- Executor 必须组装 Evidence Packet。
- Code Verifier 不再“找证据”，只验证 Evidence Packet。
- Evidence missing 不触发 Worker code repair。
- 支持 Evidence Backfill。

### Change 2：downgrade-readiness-gates

目标：减少文档反复 fail。

范围：

```text
.opencode/agents/spec-verifier.md
.opencode/agents/reality-verifier.md
openspec/QUALITY-GATE.md
```

验收标准：

- Spec Verifier 输出 BLOCKED / READY_WITH_WARNINGS / READY。
- Reality Verifier 输出 BLOCKED / READY_WITH_RISKS / READY。
- `unverified` 不默认阻塞。
- 格式问题不阻塞，除非影响执行契约。

### Change 3：introduce-proof-posture

目标：让 Brain / Propose 根据风险选择治理强度。

范围：

```text
.opencode/agents/brain.md
.opencode/agents/propose.md
.agents/contracts/dispatch-packets.md
AGENTS.md
```

验收标准：

- Brain dispatch 必须包含 Proof Posture。
- Propose 根据 Proof Posture 决定 verifier 强度。
- P0 不默认跑独立 Spec/Reality subagent。
- P2 保留强审计。

### Change 4：fork-proofloop-schema

目标：把 ProofLoop schema 从官方 `spec-driven` 语义中显式区分出来。

范围：

```text
openspec/schemas/proofloop-spec-driven/**
openspec/schemas/README.md
install/**
README.md
```

验收标准：

- 新项目默认 `schema: proofloop-spec-driven`。
- 旧 `spec-driven` 作为 legacy alias。
- OpenSpec `schema.yaml` folder/name/config 三者一致。
- `openspec schema validate proofloop-spec-driven` 通过。

### Change 5：reduce-task-template-noise

目标：减少 tasks.md 重复字段和文档错误率。

范围：

```text
openspec/schemas/proofloop-spec-driven/templates/tasks.md
.agents/skills/openspec-propose/SKILL.md
.opencode/agents/propose.md
.opencode/agents/spec-verifier.md
```

验收标准：

- tasks 使用 Slice Contract。
- task 默认引用 slice contract。
- 只有 overrides 才写 task-level 差异。
- Spec Verifier 接受 slice-level TDD contract。
- Code Verifier 能从 Slice Contract + Evidence Packet 验证。

### Change 6：optimize-boundary-strategy

目标：减少每个小任务 commit 的时间成本。

范围：

```text
.opencode/agents/executor.md
.opencode/agents/committer.md
.agents/contracts/executor-dispatch-packets.md
openspec/QUALITY-GATE.md
```

验收标准：

- Boundary Mode 支持 final/slice/per-task/no-op。
- P1 默认 slice boundary。
- P2 默认 per-task boundary。
- Code Verifier 接受 diff-snapshot 作为非审计模式 evidence。
- Archive output 仍必须 Committer closure。

---

## 10. 最小补丁示例

### 10.1 Evidence Packet 添加到 contracts

```md
## Evidence Packet

Use when Executor dispatches Code Verifier.

```text
Executor Evidence Packet

Change:
Stage:
Slice / Gate:
Proof Posture:

Covered Tasks:
- Task ID:
  Task Text:
  Execution Type:
  Required Skills:
  Worker Status:
  Worker Summary Excerpt:
  Checkbox Updated:
  Updated Checkbox Line:

TDD Evidence:
- Task ID:
  RED Command:
  RED Expected:
  RED Observed:
  RED Output Excerpt:
  GREEN Command:
  GREEN Observed:
  GREEN Output Excerpt:
  REFACTOR Changed:
  REFACTOR Evidence:

Verification Commands:
- Command:
  Result:
  Output Excerpt:

Boundary Evidence:
- Boundary Mode:
  Receipt Type:
  Commit Hash:
  Files Changed:
  Scope Check:
  Diff Evidence:

Acceptance Evidence:
- Stage AC ID:
  Slice AC ID:
  Evidence:
```
```

### 10.2 Code Verifier 新分类

```md
## Verification Result Categories

Return one of:

- `Verification passed`
- `Verification failed`
- `Verification blocked`

Category must be one of:

- `PASS`
- `IMPLEMENTATION DEFECT`
- `EVIDENCE DEFECT`
- `PROTOCOL DEFECT`
- `PLANNING DEFECT`

Rules:
- Missing Evidence Packet => `Verification blocked`, `EVIDENCE DEFECT`
- Executor failed to pass Worker evidence that exists => `Verification blocked`, `PROTOCOL DEFECT`
- Code does not satisfy slice AC => `Verification failed`, `IMPLEMENTATION DEFECT`
- tasks/proposal lacks executable contract => `Verification blocked`, `PLANNING DEFECT`
```

### 10.3 Worker Evidence Backfill

```md
## Worker Evidence Backfill

Use when implementation is already complete but required evidence was missing.

Rules:
- Do not edit product code.
- Do not change completed implementation checkbox state.
- May rerun verification commands.
- Return only structured evidence.
- If evidence cannot be reconstructed, explain why.
```

### 10.4 Spec Verifier Severity

```md
## Output

DOC READINESS: BLOCKED | READY_WITH_WARNINGS | READY

BLOCKERS:
- Only issues that prevent safe execution.

WARNINGS:
- Risks that should be known but do not block apply.

NOTES:
- Formatting or clarity suggestions.
```

---

## 11. 质量指标

整改后应该用这些指标衡量是否成功：

| 指标 | 当前问题 | 目标 |
| --- | --- | --- |
| proposal 阶段平均 verifier fail 次数 | 多次反复 | P1 <= 1 次，P0 默认 0 次 |
| TDD evidence missing 导致重做代码 | 经常发生 | 0；改为 evidence backfill |
| 普通功能完成耗时 | 过长 | 减少 30%-50% |
| 每个 slice 的 commit 数 | 过多 | P1 默认 1 个 |
| Code Verifier 失败归因 | 混杂 | 100% 带 category |
| Spec Verifier BLOCKER 精度 | 过宽 | 只阻塞执行契约缺失 |
| Worker blocked by TDD questions | 可能发生 | 0；Task Packet 作为批准源 |
| Archive 前返工 | 不稳定 | 只因 critical blocker 返工 |

---

## 12. 风险与取舍

### 12.1 降低门禁会不会削弱 ProofLoop？

不会。  
因为整改不是去掉证明，而是把证明从“文档字段完整”转成：

- acceptance criteria 映射
- TDD contract
- command evidence
- diff evidence
- boundary receipt
- verifier category
- implementation review

证明更接近执行事实。

### 12.2 P0 会不会让 AI 又开始假完成？

P0 不是无证明。  
P0 仍要求：

- OpenSpec change
- tasks checkbox
- verification command
- Worker evidence
- final diff / command result
- Brain/Executor summary

只是不会为小任务强制多个独立 verifier。

### 12.3 不默认 physical evidence file 会不会丢证据？

短任务不会。  
长任务 / P2 / interactive proof 可以启用 evidence file。  
默认使用 Evidence Packet 更轻，且更符合当前 ProofLoop 已有“canonical evidence channels”的方向。

### 12.4 Schema 改名会不会破坏兼容？

短期需要迁移，但长期更清晰。  
保留 legacy alias 可以平滑过渡。

---

## 13. 最终建议

我建议按以下顺序落地：

1. **先修 Evidence Protocol**  
   这是你现在 TDD 被误判、重复执行的直接根因。

2. **再修 Verifier Severity**  
   把文档/现实审查从二元 fail 改为 blocker/warning/note。

3. **再引入 Proof Posture**  
   让 Brain / Propose 根据风险选择治理强度。

4. **最后 fork schema 并减重 tasks 模板**  
   这是结构性优化，需要对安装器和文档做同步。

最重要的设计准则：

> ProofLoop 不应该变成“更多 Markdown 的 OpenSpec”。  
> ProofLoop 应该是“OpenSpec artifact + OpenCode agent + executable evidence”的闭环治理层。

---

## 14. 参考依据

- OpenSpec 官方仓库：`https://github.com/Fission-AI/OpenSpec`
- OpenSpec Concepts：`https://github.com/Fission-AI/OpenSpec/blob/main/docs/concepts.md`
- OpenSpec Workflows：`https://github.com/Fission-AI/OpenSpec/blob/main/docs/workflows.md`
- OpenSpec CLI：`https://github.com/Fission-AI/OpenSpec/blob/main/docs/cli.md`
- OpenSpec Customization：`https://github.com/Fission-AI/OpenSpec/blob/main/docs/customization.md`
- OpenCode Agents：`https://opencode.ai/docs/agents/`
- OpenCode Skills：`https://opencode.ai/docs/skills/`
- OpenCode Rules：`https://opencode.ai/docs/rules/`
- ProofLoop repository files reviewed:
  - `README.md`
  - `AGENTS.md`
  - `.opencode/agents/brain.md`
  - `.opencode/agents/propose.md`
  - `.opencode/agents/executor.md`
  - `.opencode/agents/worker.md`
  - `.opencode/agents/code-verifier.md`
  - `.opencode/agents/spec-verifier.md`
  - `.opencode/agents/reality-verifier.md`
  - `.opencode/agents/implementation-reviewer.md`
  - `.opencode/agents/committer.md`
  - `.agents/contracts/executor-dispatch-packets.md`
  - `.agents/skills/openspec-propose/SKILL.md`
  - `.agents/skills/openspec-apply-change/SKILL.md`
  - `.agents/skills/test-driven-development/SKILL.md`
  - `.agents/skills/workflow-intake/SKILL.md`
  - `openspec/QUALITY-GATE.md`
  - `openspec/schemas/spec-driven/schema.yaml`
  - `openspec/schemas/spec-driven/templates/tasks.md`
