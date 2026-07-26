# Brain General Direct Task Dispatch Contract

Core Packet fields are defined in brain.md — this contract defines only target-specific fields.

Dispatch a bounded, non-authority task to General.

## Use when

A bounded local task that does not require specialist ownership and does not affect authority documents.

## Target-specific required fields

- Objective
- Allowed Scope
- Forbidden Scope
- Acceptance Criteria
- Verification Method

## Rules

- General does not make specialist judgments
- General does not commit
- If the task exceeds General scope, General returns GENERAL_SCOPE_EXCEEDED

## Expected results

Edit complete, Edit blocked, or GENERAL_SCOPE_EXCEEDED.


