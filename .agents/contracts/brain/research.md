# Brain Research Dispatch Contract

Core Packet fields are defined in brain.md — this contract defines only target-specific fields.

Dispatch external technical research to Researcher.

## Use when

A technical question requires external facts from official documentation, GitHub, or other public sources.

## Target-specific required fields

- Research Goal
- Research Question
- Why It Matters
- Preferred Sources
- Out of Scope

## Expected results

Research findings returned. May resolve a Hard Part or inform a technical decision.

## Stop routing

- TECHNICAL_UNKNOWN → Brain may escalate to user or request broader scope
- AUTHORITY_IMPACT → Brain updates authority documents

## Packet

```text
Target Agent: researcher
Contract Ref: .agents/contracts/brain/research.md
Objective: <research goal>
Continuation: <task_id | none>
Research Goal: <what to learn>
Research Question: <specific question>
Why It Matters: <context>
Preferred Sources: <official docs, GitHub, etc.>
Allowed Scope: <research sources>
Out of Scope: <what not to research>
Acceptance Criteria: <how to verify>
Verification Method: <source quality check>
Expected Evidence: <research findings>
Authoritative Inputs: <refs>
Constraints: <limits>
Stop Conditions: <when to stop>
Expected Result: <Research complete | Research blocked>
```
