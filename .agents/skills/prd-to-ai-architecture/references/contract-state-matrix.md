# Contract and State Matrix Template

Use this file when creating `contract-state-matrix.md`.

## 1. HTTP/API Contracts

| Route | Method | Producer | Consumer | Request | Response | Errors | Auth | Verification |
|---|---|---|---|---|---|---|---|---|

## 2. Event / Stream Contracts

| Event/stream | Producer | Consumer | Payload | Ordering | End condition | Error condition | Verification |
|---|---|---|---|---|---|---|---|

## 3. File / Artifact Contracts

| Path | Producer | Consumer | Format | Required fields | Lifecycle | Validation |
|---|---|---|---|---|---|---|

## 4. Data Model / Schema

| Entity | Fields | Source of truth | Read/write owner | Validation | Migration risk |
|---|---|---|---|---|---|

## 5. State Machines

| State machine | States | Valid transitions | Invalid transitions | Persistence | UI reflection |
|---|---|---|---|---|---|

## 6. Ports and Runtime Configuration

| Service | Port | Protocol | Start command | Environment variables | Collision handling |
|---|---|---|---|---|---|

## 7. Error Contracts

| Error source | Internal error | User-facing message | Logged details | Recovery path |
|---|---|---|---|---|

## Contract Gate

- [ ] Every frontend call has a backend route or explicit mock ban.
- [ ] Every persisted file has an owner and schema.
- [ ] Every event stream has payload and termination rules.
- [ ] Every user-visible error has internal logging and friendly copy.
- [ ] Every port is declared once.
- [ ] Every state transition is valid and recoverable.
