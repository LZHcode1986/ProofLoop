---
name: codebase-design
description: STAGE_SELECTION support skill：use when deep module principles, seam identification, or domain modeling is needed to select Stage Goals and Work Items.
---

# Codebase Design Skill

## Phase ownership

- Phase: STAGE_SELECTION — support skill, loaded on demand (not a standalone phase)
- Prerequisite: architecture package ready (`ARCHITECTURE_READY`) and a stage goal must be selected
- Completion: stage goal and work items selected (`STAGE_GOAL_SELECTED`)
- Handoff: the selected stage goal goes to `proofloop-plan`
- Rollback: if the user later changes the stage goal, Brain reloads this skill

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

## Applying to Stage planning

When Brain selects a Stage Goal, use these principles to validate:

1. Does the Stage center on a single domain concept?
2. Will the Stage produce a deep module (small interface, lots of behavior)?
3. Does the Public Seam hide internal complexity?
4. Is the interface a stable test surface?
5. Does the Stage have high leverage (small changes produce big value)?

## When NOT to apply

- Do not create abstractions for hypothetical future needs
- Do not add interfaces until there is a real second implementation
- Do not split modules just to have more modules
- Do not make seams for testing if the interface already works
- Do not trade simplicity for purity