# Prototype Research Dispatch Contract

Dispatches external research from Prototype to Researcher.

## When to use

Prototype is blocked by a missing external technical fact. Researcher can gather the needed information.

## Required fields

- Research Question
- Why It Blocks Prototype
- Local Environment and Versions
- Known Local Evidence
- Candidate Approaches
- Official Sources Required
- Repository Evidence Needed
- Out of Scope
- Expected Findings
- Stop Conditions

## Restrictions

- Prototype can only dispatch Researcher
- Researcher does not dispatch sub-agents
- Product decisions return to Brain

## Packet shape

```text
Route: researcher
Objective: <unblock prototype>
Continuation: <task_id>
Research Question: <specific question>
Why It Blocks Prototype: <context>
Local Environment and Versions: <versions>
Known Local Evidence: <what we know>
Candidate Approaches: <options>
Official Sources Required: <docs needed>
Repository Evidence Needed: <GitHub examples>
Allowed Scope: <research sources>
Out of Scope: <what not to research>
Expected Findings: <what to return>
Stop Conditions: <when to stop>
Expected Result: <Research complete | Research blocked>
```