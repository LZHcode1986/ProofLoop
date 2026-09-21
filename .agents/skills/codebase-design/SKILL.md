---
name: codebase-design
description: 按需 capability（capability-only、无 workflow status）：use when deep module principles, seam identification, or domain modeling is needed to inform Stage/Slice decomposition.
---

# Codebase Design Skill

## 定位（capability，不是 phase）

- 定位: 按需加载的 module/seam/domain-boundary/Slice-decomposition capability（capability-only：不承担独立规划 phase、不持有完成状态、不发 workflow status；decomposition ownership 仍归 Planner）
- 加载方: 由 `proofloop-plan`（或在 Propose 架构步骤中）按需加载；decomposition ownership 仍归 Planner
- 两级 composition 判断输入: `Project Stage boundary test`（Project Stage Map 的 Stage 边界 / depends_on / entry criteria / exit outcome）与 `Vertical Slice boundary test`（选定 Stage 内的 Stage→Slice 分解）；capability 只返回判断输入，不写 Project Stage Map、不声明 Stage readiness、不发 workflow status/route
- Rollback: 不适用——capability 不持有状态

Deep module design principles from "A Philosophy of Software Design" adapted for AI coding agents.

## Core principle

A deep module has a small interface relative to the complexity of its implementation. A shallow module has a large interface relative to its implementation.

```text
Deep module:        |  small interface  |
                    |  lots of behavior |
                    |  hidden inside    |

Shallow module:     |  big interface  |
                    |  tiny behavior  |
```

## When to use

- When designing a new module boundary
- When reviewing whether a module is deep or shallow
- When identifying seams for testing
- When decomposing a Stage into vertical Slices
- When composing or revising the Project Stage Map（Stage 边界、真实 depends_on、entry criteria）

## Key concepts

### Deep module

Small interface hiding lots of behavior. The calling code is simple because the complexity is inside.

Questions to ask:
- How many methods/functions does the caller need to know?
- Does the module hide its internal complexity?
- Can the caller accomplish its goal with few calls?

### Shallow module (anti-pattern)

Large interface relative to behavior. The caller must know many details to use it.

Signs of a shallow module:
- Pass-through methods that just delegate to another module
- Configuration-heavy constructors
- Callers must sequence multiple calls to get work done
- Many public methods with few lines each

### Seam

A seam is a place where behavior can be observed or intercepted without modifying the module itself.

For testing:
- The interface IS the test surface
- Deep modules have smaller, more stable seams
- Test through the public interface, not internal details

### Leverage

Small changes in the module produce large changes in behavior for callers.

High leverage means:
- A new feature requires adding a method, not changing callers
- A bug fix is contained in one module
- Internal refactoring does not affect callers

### Locality

Related behavior should be close together in the codebase. Unrelated behavior should be far apart.

Signs of poor locality:
- A change requires touching many files spread across the tree
- Related concepts are in different directories
- Cross-cutting concerns are scattered

## Applying to Stage decomposition
When Planner composes or revises Stage/Slice boundaries (Project Stage Map at Stage level, or Stage→Slice decomposition inside a chosen Stage; Architecture may also shape module boundaries), apply these principles to validate the shape. The two composition levels each have a boundary test below; this capability only provides composition judgment input, decomposition ownership stays with the Planner:

1. Does the Stage center on a single domain concept?
2. Will the Stage produce a deep module (small interface, lots of behavior)?
3. Does the Public Seam hide internal complexity?
4. Is the interface a stable test surface?
5. Does the Stage have high leverage (small changes produce big value)?

### Project Stage boundary test
当 composition branch 作用于 Project Stage Map（Stage 级新增、删除、拆分、合并或重新划分依赖）时，先按以下条目验证每个候选 Stage 作为独立交付单元的形状，再冻结 `depends_on`、entry criteria 与 Authority refs：

- **独立交付 outcome**：每个 Stage 只承诺一个可独立验证的交付 outcome；outcome 指向可观察的产品/系统结果，不把“完成某技术层或某机制”当作 Stage 存在的唯一依据。
- **stable downstream seam**：Stage 给下游一个稳定、可引用的 seam（下游只消费其 outcome / refs，不需理解内部实现）；seam 变化必须显式升级为依赖变化，不静默改变下游契约。
- **真实 dependency**：`depends_on` 只列下游真实需要、且上游 outcome 能提供的事实依赖；没有该依赖也能独立完成的 Stage 不得声明依赖，不虚构依赖链。
- **避免技术层横切**：不要把按技术层（如存储 / 服务 / 界面）划分的 Stage 当作独立交付单元；仅当该切分本身是连贯、可独立验证的能力时才允许。
- **entry criteria**：每个 Stage 有可由当前事实重放求值的准入谓词（entry predicate：包含所需依赖条件、Authority refs 可解析、code reality 基线明确）；无 entry 即不算 dependency-ready。
- **exit outcome**：每个 Stage 有可检查的 exit outcome（交付 outcome + 对应 acceptance/verification refs + 交给下游的 seam）；无 exit 即不能判定 Stage 完成。

Completion (checkable): 每个 Stage 恰好一个独立交付 outcome、一个 stable downstream seam、一组真实且最小的 `depends_on`、可检查的 entry criteria 与 exit outcome，且没有按技术层横切、也没有虚构依赖的 Stage。

### Vertical Slice boundary test
When the composition branch is active at Stage→Slice level (inside the chosen Stage), evaluate each Slice as an independently verifiable outcome or coherent domain/module boundary:

- Keep one public outcome, input/output shape, and downstream consumer set coherent within a Slice.
- Give each Slice a stable public seam and an acceptance/test oracle that can verify it without the full Stage.
- Make dependencies and sequencing explicit; a Slice does not hide work that a downstream Slice must understand.
- Keep unrelated transformations or consumer contracts in separate Slices; keep a cross-cutting concern separate only when it is itself a coherent, independently verifiable capability.
- Compare plausible partitions when the boundary is ambiguous. Express the chosen boundary through existing Stage/Slice goals, dependencies, seams and refs; schema ownership remains unchanged.

Completion (checkable): every Slice has one coherent outcome, an observable seam/oracle, explicit dependencies, and no unrelated transformation or consumer contract is bundled into it.

## When NOT to apply

- Do not create abstractions for hypothetical future needs
- Do not add interfaces until there is a real second implementation
- Do not split modules just to have more modules
- Do not make seams for testing if the interface already works
- Do not trade simplicity for purity