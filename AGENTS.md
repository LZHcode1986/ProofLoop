# AGENTS.md — Agent Continuation & Environment Contract

This file describes project-level conventions for multi-agent programming environments operating on this codebase.

It is not a workflow state document. It is not an authority document.

---

## Host Adapter Boundary

This file declares when continuation is semantically valid or required.

The programming Agent environment (Host Adapter) is responsible for locating the original session, restoring context, and routing the continuation request. This file does not describe Host Adapter internals.

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
