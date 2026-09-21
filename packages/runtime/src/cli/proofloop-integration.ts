/** Public `proofloop integration apply` adapter (.agents/contracts/brain/integration.md). */
/**
 * Public `proofloop integration apply` adapter (Integration contract,
 * .agents/contracts/brain/integration.md): maps the closed CLI request into
 * the mechanical Integration transaction and emits the canonical envelope.
 * Integration is a dedicated mechanical transaction, deliberately NOT a
 * `boundary close` boundary type — no boundary_type is consumed here and
 * `close` semantics are unchanged.
 */

import {
  applyIntegration,
  IntegrationError,
  type IntegrationRequest,
} from '../git-integration';
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

function requestFromCli(request: CliRequestInput): IntegrationRequest {
  return {
    expected_head: request.expected_head as string,
    expected_branch: request.expected_branch as string,
    stage: request.stage as string,
    slice: request.slice as string,
    candidate_ref: request.candidate_ref as string,
    candidate_base_ref: request.candidate_base_ref as string,
    paths: (request.paths ?? []) as string[],
    execution_mode: request.execution_mode,
    expected_worktree: request.expected_worktree,
    maintenance_binding: request.maintenance_binding,
  };
}

/** Run one closed integration operation and return the canonical CLI envelope. */
export function runIntegrationDomain(
  root: string,
  command: CliCommand,
  request: CliRequestInput,
): CliEnvelope {
  if (command.operation !== 'apply') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `unknown integration operation "${String(command.operation)}"`,
    );
  }
  try {
    return okEnvelope(command, applyIntegration(root, requestFromCli(request)));
  } catch (error) {
    if (error instanceof IntegrationError) {
      return errorEnvelope(command, error.code, error.message);
    }
    return errorEnvelope(command, 'INTEGRATION.COMMIT_FAILED', errorMessage(error));
  }
}
