# AGENTS.md Customization Guide

This file is a minimal template for local project-wide agent instructions.

The local `AGENTS.md` should contain only rules every agent in the project must know before editing.

## Development environment

Describe the local development environment:

- OS:
- shell:
- package manager:
- runtime versions:
- required local services:
- environment variables policy:
- common setup command:
- common check command:

## Coding discipline

### Think before coding

- State assumptions explicitly when they matter.
- If a boundary is unclear, stop and name the ambiguity instead of guessing.
- If two different decompositions are plausible, compare them briefly before choosing.

### Simplicity first

- Use the minimum code that solves the problem.
- Do not add speculative behavior.
- Do not introduce abstractions for single-use code unless they create a clearer module boundary.
- Do not add unrequested flexibility or configurability.

### Surgical changes

- Touch only what the current request requires.
- Do not clean up unrelated code just because you noticed it.
- Match the existing style unless the current task is explicitly about changing the standard.
