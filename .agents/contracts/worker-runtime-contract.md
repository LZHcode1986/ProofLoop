# Worker Runtime Contract

All Worker phase dispatches are non-interactive.

Worker must not:
- ask the user
- request permission approval
- invoke subagents
- broaden scope
- read denied secret files such as `.env` or `.env.*`
- wait for interactive setup, login, credentials, service startup, database readiness, external API recovery, or user input
- reinterpret Brain intent

If required runtime configuration or dependency readiness cannot be established through already-authorized, non-interactive evidence, return blocked immediately.

## Blocker Categories

When returning blocked, Worker must attribute one of the following blocker categories:

- `runtime-config-blocker`:
  - Required runtime configuration is unavailable.
  - Verification requires a denied secret file such as `.env` or `.env.*`.
  - Credentials, tokens, or private keys are unavailable.
- `runtime-dependency-blocker`:
  - A required service, database, queue, browser, container, daemon, or external API is unavailable or unreachable.
  - Service startup, database migration, or environmental recovery is needed.
- `contract-defect`:
  - Upstream contract, Slice Contract, task definition, or Verification Method is ambiguous, contradictory, untestable, or incomplete.
- `evidence-defect`:
  - Evidence needed for verification is missing or insufficient (specifically for backfill phase).
- `protocol-defect`:
  - Subagent routing, receipt alignment, or checkbox updates failed.

## Blocker Receipt Format

Every Worker blocked receipt must include:

```text
Blocked

Phase:
- implementation | hypothesis-verification | evidence-backfill | fix

Blocker Type:
- runtime-config-blocker | runtime-dependency-blocker | contract-defect | evidence-defect | protocol-defect

Blocked Operation:
- <operation that failed>

Runtime Facts Needed:
- <e.g., DATABASE_URL presence, test DB readiness>

Non-secret Sources Inspected:
- <files/docs searched for local configuration>

Forbidden Sources Not Read:
- <denied files/folders bypassed>

Worker Actions:
- did not read denied secret files
- did not request permission
- did not ask user
- did not wait for interactive input

Executor May Resolve Locally:
- yes | no | unknown

Safe Resolution Hints:
- <hints for non-secret context remedy>

Required Owner Action if Not Locally Resolvable:
- <e.g., provide test DB credentials, update Slice Contract>
```

## Executor Continuation Rules

Executor may attempt at most one local non-secret context continuation per phase blocker.

Executor must return to Brain when resolution requires:
- secrets
- credentials
- user input
- permission approval
- service startup
- external environment changes
- contract or verification-method changes
