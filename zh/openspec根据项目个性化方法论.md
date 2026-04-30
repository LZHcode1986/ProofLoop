# OpenSpec 根据项目个性化方法论

## 1. 目标

这份方法论用于把 OpenSpec 从默认的轻量 planning 工具，调整为适配具体项目的工程约束系统。

适用场景：

- 项目存在明确架构边界
- 存在权威状态机、核心对象、接口契约
- 规划与实施容易漂移
- 团队希望继续使用 OpenSpec，但不希望完全依赖默认模板

不追求的目标：

- 不把所有实施细节都塞进 OpenSpec
- 不把 OpenSpec 变成完整项目管理系统
- 不为了“形式完整”牺牲实际交付速度

## 2. 核心原则

### 2.1 先定义项目约束，再定义文档模板

不要先改模板。

先明确：

- 项目边界
- 核心非目标
- 权威架构来源
- Canonical Objects
- 状态机
- 前后端 authority 边界
- 测试与验证标准

这些约束先落进 `openspec/config.yaml`。

### 2.2 先修主规范，再修生成流程

如果主 `openspec/specs/` 已经退化，先修主 spec，再改 `propose` / schema。

判断标准：

- 主 spec 是否仍是正式 source of truth
- 是否还残留 `## ADDED Requirements`
- `Purpose` 是否仍是占位文案
- 主 spec 是否能脱离 archive change 被独立阅读

### 2.3 个性化要集中在 schema 与 gate，不要分散在多条流程里

优先把项目约束收敛进两类位置：

- `schema`
- `readiness gate`

不要把同一套规则同时分散在：

- prompt
- 零散注释
- 人工记忆
- 多份重复 checklist

### 2.4 OpenSpec 负责“进入实施前的质量”，实施本身继续由项目规范负责

建议分工：

- OpenSpec 负责：
  - proposal
  - design
  - specs
  - tasks
  - archive
- 项目实施规范负责：
  - 代码实现
  - 测试执行
  - 提交与发布
  - 运行时验证

## 3. 个性化改造的标准顺序

### 第一步：在 `openspec/config.yaml` 固化项目上下文

至少写清：

- 项目名称与业务域
- 产品边界
- MVP 范围
- 显式非目标
- 技术栈
- 架构原则
- 状态机
- Canonical Objects
- API 原则
- 测试策略
- 文档语言
- authority order

建议把项目中最重要的不可违背约束写进 `rules`：

- proposal 规则
- specs 规则
- design 规则
- tasks 规则
- implementation 前置规则

### 第二步：修正主 `specs/`，让它恢复为正式规范库

主 spec 必须满足：

- 文件结构统一
  - `# <capability> Specification`
  - `## Purpose`
  - `## Requirements`
- 内容不是 change delta 语言
- `Purpose` 不是占位文案
- requirement 与 scenario 能独立表达当前系统行为

主 spec 正规化是所有后续个性化的前提。

### 第三步：建立 custom schema

在 `openspec/schemas/<project-schema>/` 下创建项目 schema。

最小建议结构：

- `schema.yaml`
- `templates/proposal.md`
- `templates/design.md`
- `templates/spec.md`
- `templates/tasks.md`
- `openspec/schemas/README.md`

schema 的职责：

- 固化 planning artifacts 的结构
- 防止默认模板丢失项目关键信息
- 让 proposal/design/tasks 自动带项目约束

### 第四步：把质量门禁收敛成统一 readiness gate

不要只依赖 `openspec validate`。

`validate` 负责结构校验，不负责项目级质量判断。

需要新增一份项目级 gate 文档，例如：

- `openspec/QUALITY-GATE.md`

建议纳入三道检查：

- proofability check
- tasks readiness check
- implementation done check

### 第五步：用 `skills/openspec-propose/SKILL.md` 固化 propose 流程

不要把 gate 做成 propose 之外的平行流程。

这一步只有在目标项目已经用 `skills/openspec-propose/SKILL.md` 覆盖了原有的 `propose` skill 后，才算真正完成。

建议在 propose 内部固定执行顺序：

1. source decomposition
2. proofability check
3. design
4. specs/tasks 生成
5. tasks readiness check
6. implementation done check

这样可以避免“文档生成完成了，但仍然没有真正放行判断”的情况。

迁移规则：

- `skills/openspec-propose/SKILL.md` 是 `propose` 的主迁移源资产
- `propose-改造思路.md` 只用于解释这个 skill 的设计思路
- 如果还没覆盖目标项目原有的 `propose` skill，就不能宣称迁移完成

### 第六步：恢复 active change 驱动

团队约定建议单独落文档，例如：

- `openspec/用户说明.md`

至少写清：

- 何时新建 change
- 何时更新当前 change
- 何时允许 archive
- 实现中新认知必须回写到哪里

关键规则：

- task 完成，不等于 archive
- 代码写完，不等于 archive
- change 收口完成，才 archive

### 第七步：按官方 archive 行为收口

不再单独维护单独的 archive checklist 文件。

推荐直接遵循官方 `archive` 行为：

- 先用 `openspec list --json` 或 `openspec status --change "<name>" --json` 确认目标 change
- 对未完成 artifacts 或未完成 `tasks.md` 只发出警告，不再手工补做归档前收口
- 默认直接执行 `openspec archive "<name>" --yes`
- 只有明确是 docs/tooling 且不影响主 spec 的 change，才使用 `--skip-specs`
- 不再手工 merge delta specs
- 不再手工移动 `openspec/changes/...`

## 4. 各 artifact 的个性化方法

### 4.1 proposal 个性化方法

proposal 不应只写“做什么”，还必须写“为什么这次只做到这里”。

建议固定包含：

- 整改映射 / Why & Mapping
- What Changes
- 验收标准
- 非目标
- 风险
- 影响对象
- 状态迁移影响
- Capabilities
- 验证命令
- Readiness Gate

适合高约束项目，因为 proposal 会成为 design 和 tasks 的约束源。

### 4.2 design 个性化方法

design 必须承担“把 proposal 变成可实施结构”的职责。

建议固定包含：

- Context
- Goals / Non-Goals
- 状态迁移影响
- Persistence 影响
- API / Contract 影响
- 前后端 Authority 边界
- Decisions
- Risks / Trade-offs
- Readiness Gate

重点不是写更多，而是写清对当前项目真正重要的架构边界。

### 4.3 spec 个性化方法

对于 change 内的 delta spec：

- 允许继续使用 `ADDED / MODIFIED / REMOVED`

对于主 `openspec/specs/`：

- 不保留 delta 语义
- 只描述当前正式行为

如果项目有强约束：

- spec 中必须复用 canonical 命名
- 不允许自由发明对象、状态或跨模块 contract

### 4.4 tasks 个性化方法

tasks 是最容易“看起来完整，实际上不可实施”的地方。

建议任务模板至少保证：

- 非目标提醒
- MVP 建议范围
- 文件范围
- 依赖关系
- 并行机会
- 明确任务顺序
- 每步有验证命令

进一步可引入 “OpenSpec x spec-kit 融合版” 分解方式：

- `Setup`
- `Blocking`
- `Slice A`
- `Slice B`
- `Reconciliation`

每个 `Slice` 都应写：

- 切片目标
- 独立验收标准

任务条目建议保持兼容 OpenSpec 的现有样式：

- `- [ ] 1.1 ...`

可增加补充标签：

- `[P]`：可并行
- `[Slice-A]` / `[Slice-B]`：切片归属

这套做法的目的，不是照搬 spec-kit，而是借用其“可独立交付切片”的方法论。

### 4.5 apply 阶段的 TDD 接入

把默认的 `test-driven-development` 约束放进 `apply`，不要塞进 `tasks` 模板本体。

推荐做法：

- 默认按 `test-driven-development` 处理，不再询问用户是否启用
- 覆盖 `apply` skill，并把 TDD 约束写入项目配置
- Agent 还要检查目标项目是否已有 `test-driven-development` skill；如果没有，就补齐到 OpenSpec skills 同目录
- `apply` 里要明确要求：编写或改动代码前，默认先执行 `test-driven-development`
- `apply` 仍然尊重项目已有的实施、测试、交付规范，不替代它们

这样可以保证：

- `propose` 继续保持轻量
- `tasks` 继续只承担实施拆分
- 真正的 TDD 顺序在实施阶段生效

如果要迁移到其他项目，`TDD-apply接入说明.md` 可以继续保留，但只作为补充设计说明，不再是主入口。

## 5. readiness gate 的个性化方法

readiness gate 的原则：

- 不做平行流程
- 不只做格式检查
- 必须直接服务于是否进入 `apply`

建议最小检查项：

### 5.1 Authority 检查

- 是否与主 spec / 架构权威一致
- 是否明确 authority 边界

### 5.2 需求明确性检查

- scope 是否明确
- non-goals 是否明确
- risks 是否明确
- acceptance criteria 是否可验证
- 是否存在无法落地的模糊项

### 5.3 架构影响检查

- impacted objects 是否列出
- API / contract 影响是否列出
- state transition impact 是否列出
- persistence impact 是否列出

### 5.4 实施落地性检查

- tasks 粒度是否足够
- 是否有文件范围
- 是否有验证命令
- 若采用切片任务法：是否有 MVP、blocking、slice 验收标准、并行机会

### 5.5 archive 适用性检查

- 这次 change 是否允许直接执行官方 `openspec archive`
- 是否明确属于 docs/tooling-only，只有这种场景才允许 `--skip-specs`

## 6. active change 的个性化方法

如果项目复杂度较高，必须把 active change 当成“开发中的单一事实来源”。

做法：

- 新需求先建 change
- 实现中发现认知变化，先更新 change
- 不允许只改代码不回写规划

何时更新当前 change：

- 同一意图
- 同一主路径
- 只是收敛实现细节

何时新建 change：

- 能力边界明显变化
- 影响对象扩大超过原范围
- 引入新子系统

## 7. archive 的个性化方法

archive 的正确定位：

- 不是“任务做完”
- 不是“代码写完”
- 而是“change 已收口，准备并入正式规范库”

archive 前建议确认：

- change 对应实现已完成
- 代码与 proposal/design/specs/tasks 已重新对齐
- 验证命令已通过
- 新认知已回写
- 归档后主 spec 不会退化
- 目标 change 已通过 `openspec list --json` 或 `openspec status --change "<name>" --json` 确认

archive 时建议规则：

- 优先直接执行 `openspec archive "<name>" --yes`
- 对 CLI 报告的未完成 artifacts 或未完成 `tasks.md` 保持警告语义，不额外发明手工收口步骤
- 仅 docs/tooling-only change 才使用 `--skip-specs`
- 不再手工 merge delta specs，也不再手工移动 `openspec/changes/...`

## 8. 可以直接迁移到其他项目的最小组合

如果要把当前这套做法迁移到别的项目，建议最少复制这 6 类资产：

1. `openspec/config.yaml` 的写法框架
2. `openspec/schemas/<project-schema>/`
3. `openspec/QUALITY-GATE.md`
4. `openspec/用户说明.md`
5. `skills/openspec-propose/SKILL.md`
6. `skills/README.md`

迁移时不要直接复制业务内容，只复制方法：

- 约束类型
- gate 类型
- schema 结构
- tasks 分解方式
- archive 规则

另外必须执行一条自动检查：

- Agent 是否已经检查并补齐 `skills/test-driven-development/SKILL.md`

规则是：

- 默认按 `test-driven-development` 处理，不再询问用户是否启用
- 覆盖 `apply` skill 并写入对应 TDD 规则
- 一旦检查到缺失，Agent 不能跳过对 `test-driven-development` skill 的补齐

## 9. 推荐迁移步骤

在新项目里，建议按下面顺序迁移：

1. 先写 `openspec/config.yaml`
2. 再建 custom schema
3. 再落 `QUALITY-GATE.md`
4. 再落 `用户说明.md`
5. 再用 `skills/openspec-propose/SKILL.md` 覆盖目标项目原有的 `propose` skill
6. 再覆盖 `skills/openspec-apply-change/SKILL.md`，并写入对应 TDD 约束
7. 再检查目标项目是否已有 `skills/test-driven-development/SKILL.md` 对应 skill，缺失则补齐
8. 最后确认归档直接走官方 `openspec archive`

不要一开始就先改 tasks 模板。

如果主 spec 还是退化状态，先修主 spec。

## 10. 适配判断清单

如果一个项目满足以下任意三项，就建议使用这套个性化方法：

- 有明确架构 authority
- 有状态机或流程阶段
- 有 canonical objects / 核心 contract
- 有较高测试要求
- 规划与实施曾经明显漂移
- 团队需要 archive 后仍可长期维护的主规范库

如果项目只是简单 demo、一次性脚本、低复杂度应用，则不建议引入全部个性化层。

## 11. 一句话总结

OpenSpec 的项目级个性化，不是“改更多模板”，而是按下面顺序做收敛：

- 用 `config` 固化项目约束
- 用 `schema` 固化 planning 结构
- 用 `readiness gate` 固化放行标准
- 用 `active change` 固化开发过程
- 用 `archive checklist` 固化主 spec 质量

这样 OpenSpec 才能从默认轻量 planning 工具，稳定变成适配具体项目的工程约束系统。
