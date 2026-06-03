# CodeGraph Tool Protocol

CodeGraph is ProofLoop's standard code-reality lookup tool.

It replaces the default Reality Verifier / Reality Investigation Agent role.  
It is a tool, not an agent.

## Purpose

Use CodeGraph to locate and understand current code reality:

- entry points
- symbols
- callers and callees
- impact radius
- related files
- affected tests
- structural anchors

Do not use CodeGraph to decide:

- user intent
- product scope
- acceptance criteria
- risk acceptance
- archive readiness
- whether a requirement should change

Those decisions belong to Brain.

## Availability check

Before relying on CodeGraph, check status:

```text
codegraph_status
```

or CLI:

```bash
codegraph status
```

If CodeGraph is not initialized:

- subagents must not initialize it without Brain authorization
- return to Brain with a blocker
- Brain decides whether to initialize CodeGraph or proceed with direct file reads

## Freshness and sync

Do not run manual sync before every query.

Default behavior relies on CodeGraph automatic synchronization.

Manual sync or wait is required only when:

- status shows pending sync affecting current files
- a staleness banner appears
- watcher is disabled or unavailable
- running in script / non-MCP mode
- git checkout / merge / pull happened while server was offline
- Brain explicitly requests pre-flight sync

If stale results appear:

```text
Do not trust stale graph result as final.
Read live files directly or wait for sync.
Record fallback direct read in the receipt.
```

## Agent usage

### Brain

May use CodeGraph for routing and rough scope. Brain must not use CodeGraph to perform implementation.

### general

May use CodeGraph for Direct Task execution. For bugfixes with `diagnose`, use CodeGraph to locate reproduction entry, suspected call path, affected symbols, and affected tests.

### Propose

Uses CodeGraph to anchor OpenSpec artifacts to real code. Propose must not invent code reality.

### Planning Contract Verifier

Uses CodeGraph only to verify referenced anchors. It must not discover new scope or redesign the plan.

### Worker

Uses CodeGraph only inside assigned task scope.

### Code Verifier

Uses CodeGraph to check changed symbol impact, callers/callees, affected tests, sensitive entry coverage, and scope consistency.

### Implementation Reviewer

May use CodeGraph for light stage-level consistency checks only.

## Evidence format

Completion Receipt / Evidence Packet should include:

```text
CodeGraph Evidence:
- status checked: yes/no
- pending sync: yes/no
- stale banner encountered: yes/no
- queries used:
  - codegraph_context:
  - codegraph_search:
  - codegraph_impact:
  - codegraph_affected:
- anchors:
  - symbol:
  - file:
  - reason:
- fallback direct reads:
  - file:
  - reason:
```

## Evidence Ledger recording

When CodeGraph is used in OpenSpec Change execution:

- CodeGraph Evidence must be appended to the Evidence Ledger in the relevant slice evidence section.
- Stale results or fallback direct reads must be recorded in the relevant slice evidence section with the reason.
