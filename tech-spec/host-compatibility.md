# Host Compatibility Matrix — OpenCode Plugin API（OC-0 Spike 产物与复核边界）

> 来源：HP-001 Prototype spike（proto-oc0，隔离 worktree 实测 + 文档查证）与 2026-08-02 官方加载规则复核。
> 环境：OpenCode CLI 1.18.11 / Node 25.9.0 / @opencode-ai/plugin@1.18.4 / Linux（WSL2）。
> 状态：VALIDATED（2026-08-03）。原 spike 报告与 `/tmp` 日志已清理；OC-01 加载结论由官方文档、本仓库薄入口、`test/opencode-cli-integration.spec.ts` 以及用户 fresh `opencode serve` 的真实工具列表验证共同支撑。

## Compatibility Matrix

| Capability | Result | Implementation evidence / mechanism | Fallback or constraint |
|---|---|---|---|
| 本地插件加载 | 支持（规则与真实 CLI 已复核） | 开发期项目级 `.opencode/plugins/**` 或用户级 `~/.config/opencode/plugins/**` 自动加载；`opencode.json` 的 `plugin` 数组只接受 npm 包名 | 不把 `opencode.json` 本地路径或 `file://` 解析当作支持结论；宿主与 `@opencode-ai/plugin` 版本需配对测试 |
| ESM 导出形状 | 支持（真实 CLI 已复核） | 插件入口必须导出宿主可调用的函数；`test/opencode-plugin-load.spec.ts` 覆盖 built entry，真实 CLI 集成测试覆盖宿主注册 | 避免 named/default 非函数导出触发 `Plugin export is not a function` |
| 自定义工具注册与调用 | 支持（实测） | 返回 `{ tool: { name: tool({ description, args, execute }) } }`；/experimental/tool 自动生成 JSON Schema | API 字段名是 `args`（Zod shape）而非 `inputSchema`；宿主暴露 translated `parameters` |
| Agent/角色工具权限 | 部分支持（实测） | agent 配置 `tools: { <tool>: true/false }` 变为有效 permission 规则（allow/deny）；deny 的 agent 看不到工具 | 是 agent×工具矩阵，非领域角色策略 → **全局 deny + 按 agent allow + execute(context.agent) 二次校验** |
| Hook 生命周期与拦截 | 支持（核心实测） | event、chat.message、tool.execute.before/after 真实触发；before 抛错可阻止工具执行（after 不执行） | permission.ask、command.execute.before、compaction 仅类型/文档确认未单独触发 → 保留宿主集成测试 |
| directory / worktree | 支持（实测） | PluginInput 与 ToolContext 均含两者，解析为 worktree 路径；另有 project、client、serverUrl、experimental_workspace | **worktree = artifact 信任根；directory = 会话相对工作目录；禁止裸 process.cwd()** |
| Cancellation | 部分支持（实测） | ToolContext.abort = AbortSignal；真实 /session/{id}/abort 被工具监听到 | 协作式取消：工具须监听 abort 并传播 AbortError；before/after 不是取消信号 |
| Logging | 支持（实测） | client.app.log({ body: { service, level, message, extra } }) 写入宿主日志 | 持久证据用 .proofloop/logs/** 适配器；client.app.log 作宿主侧 |
| Agent identity | 支持但 hook-dependent（实测） | ToolContext.agent 在真实调用中提供（hp001_allowed）；chat.message 也带 agent；**tool.execute.before/after 不带 agent** | 角色校验放 execute(context.agent)；pre-hook 需要身份时维护 sessionID→agent 观察或配置矩阵 |
| 真实 CLI 进程加载与工具注册 | 支持（2026-08-03 实测） | `test/opencode-cli-integration.spec.ts` 启动真实 `opencode serve`，轮询 `/experimental/tool/ids`，断言 `read`、`proofloop_doctor`、活动 ProofLoop 项目的 `proofloop_stage` | 无 CLI 环境可 skip，但测试与断言路径必须保留 |

## 最小加载条件与诊断矩阵

真实宿主复核确认：本地插件不是全局安装。必须从该 ProofLoop worktree 根目录或其子目录启动 OpenCode（宿主能把 cwd 归属到该 worktree），且同时满足：

- 不使用 `--pure`；
- `.opencode/plugins/proofloop.js` 可读，并能 re-export `packages/opencode-plugin/dist/index.js`；
- `dist/index.js` 已构建且可读；workspace 依赖与 `.opencode/node_modules/zod` 可解析；
- `.proofloop/runtime.lock` 存在且版本匹配 `@proofloop/runtime` / plugin；
- `opencode.json` 的 `plugin` 数组保持 npm 包名，不写本地路径。

预期工具表面：

| 条件 | 预期 |
|---|---|
| 有效 runtime.lock + dist + 依赖 + 活动 ProofLoop 项目 | `proofloop_doctor`、`proofloop_plan`、`proofloop_stage`、`proofloop_review` |
| 普通项目、缺失/无效 runtime.lock、缺失 zod | 仅 `proofloop_doctor`（插件已加载但 fail closed） |
| 非该 worktree、`--pure`、入口/dist 不存在或不可读 | 不出现 ProofLoop 工具（插件未加载或被宿主跳过） |

手工验证优先检查启动 cwd、`--pure`、入口/dist、lock 与 zod；不要仅凭“看不到 stage”判断插件未加载，因为 invalid lock/zod 缺失时 doctor 仍应出现。

## 已采纳的架构决策（更新 authority）

1. **AWI-001 / ADR-003（本地分发）**：开发期本地插件放入项目级 `.opencode/plugins/**`（或用户级 `~/.config/opencode/plugins/**`）自动加载；`opencode.json` 仅用于 npm 包名；不把本地路径或 `file://` 作为宿主支持结论。
2. **AWI-011（角色隔离）**：role→tool 映射用各 agent 的 `tools` 配置实现（默认 deny + 按 agent allow）；`context.agent` 作为运行时调用者信号，每个 ProofLoop 工具在调用 runtime/kernel 前二次校验，不匹配返回 `HOST.CAPABILITY.MISSING` finding；不依赖 permission.ask 作为 ProofLoop 角色授权。
3. **AWI-012（hooks）**：Protected Artifact 与 Command Policy 用 fail-closed 的 `tool.execute.before` / `command.execute.before` 适配器（违反即抛结构化 host-policy 错误）；`tool.execute.after` 仅用于日志/脏状态观察（被阻止的调用不会触发 after）；compaction 用 `experimental.session.compacting` 但保留宿主集成测试；所有宿主签名收敛在 adapter 层。
4. **ADR-005 升级为 confirmed**：宿主提供 agent name（非 ProofLoop role），角色映射是插件策略职责。
5. **新增 ADR-009（版本约束）**：开发与验收环境锁定 OpenCode CLI 1.18.11 + @opencode-ai/plugin 1.18.4；兼容范围需 CI 矩阵。

## Remaining verification gaps（不改变已确认架构，记录）

- permission.ask / command.execute.before / compaction 需宿主集成测试补触发验证。
- 未来 OpenCode 版本兼容范围需 CI 矩阵。
- 宿主提供 agent name，ProofLoop role 映射由插件策略维护。

## pluginv2 Host surface boundary（derived from confirmed PRD）

以下是技术实现状态，不是第二个产品需求源：

- 当前继续使用 `proofloop_plan`、`proofloop_stage`、`proofloop_review` 等粗粒度工具，
  不新增独立的 `proofloop_next` 工具。
- pluginv2 的 Stage Plan admission、Context Resolver、Gate/Project Acceptance 和统一
  CV 需要分别完成 Runtime/Host 合同与 parity；在它们完成前，不得把缺失 operation
  通过旧 CLI、自然语言参数或手工 Receipt 补齐。
- `proofloop_stage(next)` 的下一动作和 Context 投影必须由 Runtime 派生；Host 只做
  trust-root、调用者和结果边界适配。
- `pluginv2` 未通过切换 Gate 前，当前 `plugin` surface 保持可回退；旧 Manifest/Receipt
  不自动迁移或静默解释为 vNext 事实。
