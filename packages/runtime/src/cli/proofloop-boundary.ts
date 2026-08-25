/** Public `proofloop boundary close` adapter (blueprint Part B §4.1). */

import {
  closeGitBoundary,
  GitBoundaryError,
  type BoundaryCloseRequest,
  type BoundaryType,
} from '../git-boundary';
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

function requestFromCli(request: CliRequestInput): BoundaryCloseRequest {
  return {
    boundary_type: request.boundary_type as BoundaryType,
    ...(request.expected_head !== undefined ? { expected_head: request.expected_head } : {}),
    ...(request.stage !== undefined ? { stage: request.stage } : {}),
    ...(request.slice !== undefined ? { slice: request.slice } : {}),
    ...(request.manifest_digest !== undefined ? { manifest_digest: request.manifest_digest } : {}),
    ...(request.cv_receipt_digest !== undefined ? { cv_receipt_digest: request.cv_receipt_digest } : {}),
    ...(request.old_manifest_digest !== undefined ? { old_manifest_digest: request.old_manifest_digest } : {}),
    ...(request.paths !== undefined ? { paths: request.paths } : {}),
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.expected_branch !== undefined ? { expected_branch: request.expected_branch } : {}),
  };
}

/** Run one closed boundary operation and return the canonical CLI envelope. */
export function runBoundaryDomain(
  root: string,
  command: CliCommand,
  request: CliRequestInput,
): CliEnvelope {
  if (command.operation !== 'close') {
    return errorEnvelope(command, 'RUNTIME.SCHEMA_MISMATCH', `unknown boundary operation "${String(command.operation)}"`);
  }
  if (request.boundary_type === undefined) {
    return errorEnvelope(command, 'USAGE', 'boundary close requires --json or --request with boundary_type');
  }
  try {
    return okEnvelope(command, closeGitBoundary(root, requestFromCli(request)));
  } catch (error) {
    if (error instanceof GitBoundaryError) return errorEnvelope(command, error.code, error.message);
    return errorEnvelope(command, 'BOUNDARY.COMMIT_FAILED', errorMessage(error));
  }
}
