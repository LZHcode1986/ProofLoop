# Domain Context

## Stage

一个能够作为整体审查的产品交付边界。

*Avoid*: Phase、Module、Task、Technical Layer

## Slice

Stage 内一个窄但完整、可以独立验证的行为路径。

*Avoid*: Component Task、Frontend Slice、Backend Slice

## Task

Slice 内的一个实施中间目标。Task 是目标型（如"实现保存行为"），不是文件操作清单（如"创建 xxx.ts"）。

*Avoid*: 文件路径、代码行号、独立 CV、独立 commit

## TDD Proof Plan

一个 Slice 有一套 TDD Proof Plan，包含 Primary Seam、Required Success/Failure Behaviors、State Assertions、Proof Profiles。

*Avoid*: 每个 Task 独立 TDD

## Evidence

当前 Slice 的持久化事实记录。包含每个 Task 的 Evidence、Current Slice Evidence，以及由 Executor 独占维护的 Current CV Status（含最新 CV Receipt）。CV 将其作为待攻击目标。

*Avoid*: 修复历史、旧 Evidence、commit hash

## Code Verifier (CV)

对抗式验证者。在读取 Evidence 前先独立寻找反例，再根据 Evidence 做 profile-specific refutation。

*Avoid*: Evidence 审阅者、合并检查器、修复者

## Stage Reviewer

对完整 Stage 做 Goal-first 审查，先看代码再看 Evidence。

*Avoid*: Slice 验证者、Evidence 读者

## Hard Part

一个可验证的技术问题，不是风险备注。必须写成"在 X 条件下，Y 是否 Z"的形式。

*Avoid*: "这里很难"、模糊描述

## Brain

用户入口和全局纠偏路由者。维护权威文档，不实现代码，不创建 Slice/Task。

*Avoid*: 代码实现、直接修改 tasks.md、Manifest-declared Slice Evidence

## Planner

Stage→Slice→Task 规划者。创建 tasks.md 并通过 compile-manifest 初始化 Manifest，再调用 initialize-slice-evidence 生成 per-Slice Evidence 文件。

*Avoid*: 预测代码文件清单、实现代码

## Executor

Active Stage 的运行时编排器。管理 Worktree、Worker Session、CV 派发、集成队列。

*Avoid*: 编辑代码或 Markdown、替 Worker 勾选 checkbox

## Worker

一次只接收 Executor 派发的一个 Task。仅在被重新派发时，才可在同一 Slice 内按顺序继续处理后续 Task。

*Avoid*: 读取完整 Stage Goal、修改其他 Slice 区域

## Committer

Git 边界唯一所有者。只创建边界，不编辑内容。

*Avoid*: 编辑代码、判断质量

## Researcher

外部技术方案研究者。优先官方文档，比较至少两个方案。

*Avoid*: 产品决策、编辑仓库

## Prototype

在隔离 worktree 中回答具体技术问题的实验者。

*Avoid*: 写生产代码、修改权威、直接合入 Stage

## General

受限通用执行代理。处理独立、局部、非 Active Stage 的任务。

*Avoid*: 修复 Active Stage Slice、修改权威文档、commit