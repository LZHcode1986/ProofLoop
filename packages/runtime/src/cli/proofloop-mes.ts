/**
 * Public `proofloop mes materialize` adapter (ADR-026 / E2E-33 / STATIC-41).
 *
 * The ONE shared agent-facing NORMAL MES durable-mutation transport. Both
 * hosts (Pi and OpenCode) use the same executable, so neither host needs
 * arbitrary-Node MES write permission and no second host-specific adapter
 * exists (tech-spec/contracts.md §1.1 / §1.2, acceptance STATIC-41).
 *
 * The request is a closed high-level semantic event: `event_kind` + its
 * caller-owned `payload` + the NORMAL `binding`. The adapter:
 *
 *   - never accepts `facts` / any durable-output or retention field — the
 *     closed request schema and the mechanical event catalog reject them
 *     BEFORE any state is read or written;
 *   - never routes, dispatches, arbitrates or emits a next action — it returns
 *     the narrow materialized refs/basis or a typed failure;
 *   - maps every fail-closed condition onto the canonical typed failure
 *     envelope (exit 2) and never retries;
 *   - rejects `execution_mode: MES_MAINTENANCE` (NORMAL-only seam).
 */
import { createMesSemanticEventMaterializer, MesMaterializationError } from '../mes/materialize';
import type { MesSemanticEvent, MesSemanticEventBinding } from '../mes/semantic-event';
import {
  errorEnvelope,
  okEnvelope,
  type CliCommand,
  type CliEnvelope,
  type CliRequestInput,
} from './proofloop-common';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Canonical typed failure code for one materialization failure code. */
function failureCode(code: string): string {
  return `MES.${code.toUpperCase().replace(/-/g, '_')}`;
}

/** Run one closed `mes` operation and return the canonical CLI envelope. */
export function runMesDomain(root: string, command: CliCommand, request: CliRequestInput): CliEnvelope {
  if (command.operation !== 'materialize') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `unknown mes operation "${String(command.operation)}"`,
    );
  }
  if (request.event_kind === undefined) {
    return errorEnvelope(command, 'USAGE', 'mes materialize requires --json or --request with event_kind');
  }
  try {
    const event: MesSemanticEvent = {
      event_kind: request.event_kind,
      payload: request.payload ?? {},
      binding: (request.binding ?? {}) as unknown as MesSemanticEventBinding,
    };
    return okEnvelope(command, createMesSemanticEventMaterializer(root).materialize(event));
  } catch (error) {
    if (error instanceof MesMaterializationError) {
      return errorEnvelope(command, failureCode(error.code), error.message);
    }
    return errorEnvelope(command, 'MES.RUNTIME_FAILURE', errorMessage(error));
  }
}
