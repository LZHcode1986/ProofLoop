# Hard Parts Register Template

Use this file when creating `hard-parts-register.md`.

Hard parts are implementation risks AI agents may skip, fake, or oversimplify.

## Register

| ID | Hard part | Why hard | Forbidden shortcuts | Minimum acceptable implementation | Acceptance evidence | Human confirmation |
|---|---|---|---|---|---|---|
| HP-001 |  |  |  |  |  | required/optional |

## Common Hard Parts

- Streaming output and UI synchronization.
- Task cancellation and concurrency.
- File uploads, large files, and local persistence.
- Multi-workspace isolation.
- API contract consistency.
- State restoration after refresh/restart.
- Error mapping: friendly user message plus full internal logs.
- Runtime adapters with inconsistent outputs.
- Authentication, permissions, payment, or data migration.
- Third-party integrations with rate limits or failures.

## Forbidden Shortcut Examples

- Static UI pretending to be wired to real state.
- Mock data presented as completed integration.
- TODO comments replacing implementation.
- Silent failure handling.
- New ports or routes not listed in the architecture.
- Ignoring cancellation, retry, or error paths.
- Writing files without schema validation.

## Gate

- [ ] Every high-risk feature has a hard part entry.
- [ ] Every hard part has forbidden shortcuts.
- [ ] Every hard part has acceptance evidence.
- [ ] Every hard part has a minimum acceptable implementation.
- [ ] Blocking hard parts are scheduled before dependent tasks.
