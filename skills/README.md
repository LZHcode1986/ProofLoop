# Skills Guide

本目录存放本仓库提供的技能实现，它们是迁移 OpenSpec 工作流时的直接源资产。

## 角色划分

- `skills/openspec-propose/SKILL.md`
  - `propose` 的默认实现
  - 配置本仓库到其他项目时的必配资产
  - Agent 必须用它覆盖用户原有的 `propose` skill

- `skills/openspec-apply-change/SKILL.md`
  - `apply` 的实施实现
  - Agent 必须用它覆盖用户原有的 `apply` skill，并在进入任务执行前显性先走 `test-driven-development`

- `skills/test-driven-development/SKILL.md`
  - `test-driven-development` 的参考实现
  - 默认实施约束
  - Agent 必须检查目标项目是否已有该 skill
  - 如果目标项目没有该 skill，Agent 必须帮助用户把它配置到 OpenSpec skills 目录

## 标准配置顺序

1. 开始配置前，默认按 `test-driven-development` 处理，不再询问是否需要。
2. 再迁移 `config.yaml.example`、schema、质量门禁与用户说明。
3. 用 `skills/openspec-propose/SKILL.md` 覆盖目标项目原有的 `propose` skill。
4. 用 `skills/openspec-apply-change/SKILL.md` 覆盖目标项目原有的 `apply` skill。
5. 同时修改 `config.yaml` 和 schema，把代码变更前默认要求 `test-driven-development` 的规则写入项目配置。
6. 然后检查目标项目是否已有 `test-driven-development` skill；如果没有，则帮助用户把 `skills/test-driven-development/SKILL.md` 配置到 OpenSpec skills 目录。

## 说明

- `zh/openspec 资产迁移/propose-改造思路.md` 与 `apply-改造思路.md` 现在只用于解释设计思路，不再是主迁移入口。
- 如果用户目标是 1:1 复刻本仓库，则仍按上述顺序执行，只是第一轮 TDD 询问更可能得到“是”。
