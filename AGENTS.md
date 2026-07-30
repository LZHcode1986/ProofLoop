# AGENTS.md — Host Adapter Boundary & Task Naming

This file covers host-adapter boundaries and task naming only.

It is not a workflow state document. It is not an authority document.

---

## Host Adapter Boundary

Role-specific continuation semantics belong to the Brain and Executor contracts.

---

## Task Naming Convention

All Agent task names follow this pattern:

| Pattern | Example |
|---|---|
| `<Stage ID> 阶段规划` | `S01 阶段规划` |
| `<Stage ID>-<Slice ID> Slice 实施` | `S01-A Slice 实施` |
| `<Stage ID>-<Slice ID> Slice 验证` | `S01-A Slice 验证` |
| `<Stage ID> 阶段验收` | `S01 阶段验收` |

Task names are unique within a project and mappable to Stage and Slice IDs.
