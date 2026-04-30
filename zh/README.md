# 教你的 AI 优化 OpenSpec 流程

本仓库是一套用于根据项目约束个性化 OpenSpec 的方法论、校验文档和迁移资产。

英文版入口：[`en/README.md`](en/README.md)

原版 OpenSpec：<https://github.com/Fission-AI/OpenSpec>

使用本仓库前，必须先完成 OpenSpec 的基础配置。

## 这是什么

- 一套面向具体项目定制 OpenSpec 的方法论
- 一组用于校验 OpenSpec 生成文档、约束归档行为和变更控制的文档
- 一套可迁移的 schema 和模板骨架
- 一份教 AI 按项目约束工作的说明

## 这个仓库解决什么问题

解决原版 OpenSpec 工作流程中约束力不够，导致项目开发漂移的问题，例如：
- `propose` 阶段自动生成文档时，容易出现文档遗漏
- `tasks.md` 颗粒度不足，执行任务时容易出现猜测、幻觉、漂移
- `archive` 阶段自动同步 specs 时，容易偏离主规范或重复写规范

## 比默认 OpenSpec 多了什么

- 更完整的项目上下文先行配置，先定义边界、权威来源、核心对象、状态机
- 更明确的 schema 固化，把项目约束写进模板和生成结构
- 更统一的质量门禁，把 proposal 是否可进入 apply 的判断集中起来
- 更明确的 Active Change 规则，要求实施中新认知回写到文档
- 更明确的归档规则，避免主 spec 退化成变更残留
- 更清晰的 proposal / design / tasks 分工，让每一层各自承担职责
- 默认接入 TDD 工作流程，作为实施阶段的基础约束

## 适合谁

- 认可原版 OpenSpec 的轻量化、自动化的规范开发工作流程，但被开发过程，对 Agent 约束力不够，项目偏离问题困扰的用户
- 有明确边界、权威来源、核心对象、状态机的项目
- 新的开发项目，已经有明确的技术方案，想用 OpenSpec 的 SDD 方式协助开发，但又不知道怎么做 OpenSpec 配置的用户
- 希望 AI 能帮忙整理项目规范的用户

## 不适合谁

- 不想配置 OpenSpec 的用户
- 只需要一句话就让 AI 明白并开始实施的项目
- 不想维护配置、schema、门禁文档，只想直接开干的用户
- 不希望 AI 按项目规则工作，只希望它自由生成的用户

## AI 怎么用

告诉Agent “帮我配置这个仓库 https://github.com/LZHcode1986/Openspec-Harness”。

如果是把这套流程迁移到别的项目：

- 必须用 `skills/openspec-propose/SKILL.md` 覆盖目标项目原有的 `propose` skill
- 必须用 `skills/openspec-apply-change/SKILL.md` 覆盖目标项目原有的 `apply` skill
- 必须检查目标项目是否已有 `test-driven-development`；如果没有，则帮助用户配置到 OpenSpec skills 同目录

## 建议阅读顺序

1. 先读这份 `README.md`
2. 再读 `zh/仓库导览.md`
3. 再读 `zh/openspec根据项目个性化方法论.md`
4. 再读 `zh/openspec 资产迁移/README.md`
5. 再读 `skills/README.md` 和 `skills/openspec-propose/SKILL.md`
6. 再读三个门禁文档、schema、`config.yaml.example`、`skills/openspec-apply-change/SKILL.md` 和 `skills/test-driven-development/SKILL.md`
7. 需要对比时再看英文对比页

## 详细内容

| 类别 | 中文入口 | 用途 |
| --- | --- | --- |
| 仓库导览 | [zh/仓库导览.md](zh/仓库导览.md) | 阅读顺序和导航 |
| 方法论主文档 | [zh/openspec根据项目个性化方法论.md](zh/openspec根据项目个性化方法论.md) | 核心方法说明 |
| 迁移包说明 | [zh/openspec 资产迁移/README.md](zh/openspec 资产迁移/README.md) | 迁移资产怎么用 |
| 质量门禁 | [zh/openspec 资产迁移/QUALITY-GATE.md](zh/openspec 资产迁移/QUALITY-GATE.md) | 提案就绪检查 |
| 用户说明 | [zh/openspec 资产迁移/用户说明.md](zh/openspec 资产迁移/用户说明.md) | 给用户看的变更使用说明 |
| schema 示例 | [zh/openspec 资产迁移/schemas/project-schema/README.md](zh/openspec 资产迁移/schemas/project-schema/README.md) | 项目 schema 骨架 |
| Skills 导览 | [skills/README.md](../skills/README.md) | skill 角色与配置顺序 |
| propose skill | [skills/openspec-propose/SKILL.md](../skills/openspec-propose/SKILL.md) | `propose` 的主迁移源资产 |
| apply skill | [skills/openspec-apply-change/SKILL.md](../skills/openspec-apply-change/SKILL.md) | 进入实施时先走 TDD，再执行任务 |
| test-driven-development skill | [skills/test-driven-development/SKILL.md](../skills/test-driven-development/SKILL.md) | 默认实施约束；检查目标项目是否已有，缺失则补齐 |
| propose 改造说明 | [zh/openspec 资产迁移/propose-改造思路.md](zh/openspec 资产迁移/propose-改造思路.md) | 设计说明，不再作为主迁移入口 |
| apply 改造说明 | [zh/openspec 资产迁移/apply-改造思路.md](zh/openspec 资产迁移/apply-改造思路.md) | 设计说明，不再作为主迁移入口 |
| TDD 接入说明 | [zh/openspec 资产迁移/TDD-apply接入说明.md](zh/openspec 资产迁移/TDD-apply接入说明.md) | apply 先走 TDD 的参考说明 |
| 中英对比页 | [en/OpenSpec-vs-This-Workflow.md](en/OpenSpec-vs-This-Workflow.md) | 和原版 OpenSpec 的差异 |

## 许可

[MIT](LICENSE)
