# Prototype Research Required Contract

Describes the packet Prototype returns to Brain when blocked by an external fact gap.

## When to use

Prototype is blocked by a missing external technical fact that cannot be resolved locally. Prototype returns `RESEARCH_REQUIRED` instead of dispatching any agent.

## Required fields

- Research Question
- Why It Blocks Prototype
- Local Environment and Versions
- Known Local Evidence
- Candidate Approaches
- Expected Findings

## Flow

```text
Prototype → Brain
→ Brain 派 Researcher
→ Brain continuation 原 Prototype
```

## Packet shape

```text
Route: brain
Status: RESEARCH_REQUIRED
Prototype ID: <id>
Hard Part: <hard-part>
Research Question: <specific question>
Why It Blocks Prototype: <context>
Local Environment and Versions: <versions>
Known Local Evidence: <what we know>
Candidate Approaches: <options>
Expected Findings: <what to find>
```

## Restrictions

- Prototype does NOT dispatch Researcher directly
- Brain decides whether to dispatch Researcher
- Brain decides whether to resume or terminate the Prototype