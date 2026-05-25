# Skills Guide

本目录里的技能分成两层，不要混为一谈。

## 1. OpenSpec canonical skills

这些名字是 OpenSpec 分发、安装、profile 映射、tool detection 会用到的 canonical skill surface。若要保持 OpenSpec 兼容，**不要随意改名**。

- `openspec-propose/SKILL.md`
  - 正式 propose 工件生成能力
  - 由 `propose` agent 加载

- `openspec-explore/SKILL.md`
  - 本地探索与技术澄清能力

- `openspec-apply-change/SKILL.md`
  - 正式 apply 执行能力
  - 由 `executor` agent 加载

- `openspec-archive-change/SKILL.md`
  - 正式 archive 能力

- `test-driven-development/SKILL.md`
  - 代码实施时的默认测试纪律

## 2. Workflow orchestration skills

这些技能是 Brain 和上层编排使用的补充能力，不替代 OpenSpec canonical skills。

- `workflow-intake/SKILL.md`
  - Brain 前置 intake 能力
  - 把用户原始需求沉淀成 `PRD.md`、决策账本与 stage plan

当前只保留已经落地的编排层技能；不再保留空目录占位，避免制造“流程已经存在”的假象。

## 推荐职责分层

1. Brain 先加载 `workflow-intake`，把用户需求变成 `PRD.md` 与 stage plan。
2. Brain 再加载 `grill-me-prd`，只补关键缺口，不重复做开放式发现。
3. Brain 按根级 `AGENTS.md` 的 stage 划分规则选择一个 stage，然后 dispatch `propose` agent；`propose` agent 再加载 `openspec-propose`，并把 Brain 给出的验收标准原样传给 `spec-verifier` 与已配置的 reality readiness verifier。
4. `executor` agent 加载 `openspec-apply-change` 并编排 `worker`、`code-verifier`、`committer`；`code-verifier` 只接收当前切片/校验门的标准。
5. Brain 在阶段边界 dispatch `implementation-reviewer` 做阶段级验收；完整 stage 验收标准由 `implementation-reviewer` 组合检查。
6. 代码任务默认继续由 `test-driven-development` 约束。

## 标准迁移顺序

1. 先迁移 `config.yaml.example`、schema 与质量门禁。
2. 保留 OpenSpec canonical skills 的原名并安装到目标工具目录。
3. 如需 Brain 层治理，再额外安装 `workflow-intake` 和相关 agents。
4. 检查目标项目是否已有 `test-driven-development`；如果没有，再补装它。

## 说明

- `zh/openspec 资产迁移/propose-改造思路.md` 与 `apply-改造思路.md` 现在只用于解释设计思路，不再是主迁移入口。
- 本仓库中的 workflow-* 技能是编排层补充，不是对 openspec-* canonical skills 的重命名替代。
