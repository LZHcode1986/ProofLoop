# Executor Resolve Integration Conflict Dispatch Contract

Dispatches the original Worker to resolve a code conflict during Slice integration.

## Dispatch Envelope Mode

This contract is read by Worker only when Executor supplies the path as `Contract Ref`.

## When to use

A Slice branch has a merge conflict with the latest Stage branch during integration.

## Required fields

- Slice ID
- Current Slice Goal
- Integrated Slice intent summaries
- Conflict description
- Relevant contracts

## Rules

- Worker reads the current Slice Goal
- Worker reads the integrated Slice's intent summary
- Worker reads relevant contracts
- Worker preserves both intents
- Worker does not add authority-external behavior
- Worker runs affected tests
- If implementation changes, Worker updates Evidence

## Conflict resolution ethics

- Do NOT discard another Slice's behavior
- Do NOT accept one side entirely to avoid conflict
- Do NOT split code mechanically to avoid Git conflicts
- Do NOT skip tests
- Do NOT create new product semantics

## Packet shape

```text
Target Agent: worker
Contract Ref: .agents/contracts/executor/resolve-integration-conflict.md
Slice ID: <same>
Current Slice Goal: <goal>
Integrated Slices: <list with intent summaries>
Conflict Files: <list>
Conflict Description: <description>
Relevant Contracts: <refs>
Expected Result: <Conflict resolved | SEMANTIC_CONFLICT>
```