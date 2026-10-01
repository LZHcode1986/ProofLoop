/**
 * Public `proofloop worktree` mechanical seam adapter.
 *
 * This domain is a THIN adapter over the existing git-worktree primitives
 * (`createGitWorktree` / `listGitWorktrees` / `removeGitWorktree`). It owns
 * no lifecycle decision: Brain/Execute Flow decides WHEN/WHICH Slice lane,
 * the mechanical seam decides HOW/WHERE (canonical path computed by the
 * Runtime, never caller-supplied). No second lifecycle state, no raw
 * `git worktree` invocation by Brain, no `.pi/...` or custom worktree path.
 *
 * Closed request sets (proofloop-common.ts):
 *   worktree create  → { domain, operation, stage, slice, base_ref }
 *   worktree remove  → { domain, operation, stage, slice }
 *   worktree list    → { domain, operation }  (no mutation body)
 *
 * `.agents/contracts/brain/commit-boundary.md` and
 * `tech-spec/contracts.md` §5.3 own the create/remove/cleanup semantics;
 * this file only maps the closed CLI input into the mechanical primitives
 * and emits the canonical envelope.
 */
import {
  createGitWorktree,
  listGitWorktrees,
  removeGitWorktree,
  GitWorktreeError,
  type GitWorktreeRequest,
} from '../git-worktree';
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

/** Map the closed CLI input onto the mechanical worktree request identity. */
function requestFromCli(request: CliRequestInput): GitWorktreeRequest {
  return {
    ...(request.stage !== undefined ? { stage: request.stage } : {}),
    ...(request.slice !== undefined ? { slice: request.slice } : {}),
    ...(request.base_ref !== undefined ? { base_ref: request.base_ref } : {}),
  };
}

/** Run one closed worktree operation and return the canonical CLI envelope. */
export function runWorktreeDomain(
  root: string,
  command: CliCommand,
  request: CliRequestInput,
): CliEnvelope {
  const operation = command.operation;
  if (operation === 'create') {
    if (request.stage === undefined || request.slice === undefined || request.base_ref === undefined) {
      return errorEnvelope(
        command,
        'USAGE',
        'worktree create requires stage, slice and base_ref (--json or --request)',
      );
    }
    try {
      return okEnvelope(command, createGitWorktree(root, requestFromCli(request)));
    } catch (error) {
      if (error instanceof GitWorktreeError) {
        return errorEnvelope(command, error.code, error.message);
      }
      return errorEnvelope(command, 'WORKTREE.CREATE_FAILED', errorMessage(error));
    }
  }
  if (operation === 'list') {
    try {
      return okEnvelope(command, listGitWorktrees(root));
    } catch (error) {
      if (error instanceof GitWorktreeError) {
        return errorEnvelope(command, error.code, error.message);
      }
      return errorEnvelope(command, 'WORKTREE.LIST_FAILED', errorMessage(error));
    }
  }
  if (operation === 'remove') {
    if (request.stage === undefined || request.slice === undefined) {
      return errorEnvelope(
        command,
        'USAGE',
        'worktree remove requires stage and slice (--json or --request)',
      );
    }
    try {
      return okEnvelope(command, removeGitWorktree(root, requestFromCli(request)));
    } catch (error) {
      if (error instanceof GitWorktreeError) {
        return errorEnvelope(command, error.code, error.message);
      }
      return errorEnvelope(command, 'WORKTREE.REMOVE_FAILED', errorMessage(error));
    }
  }
  return errorEnvelope(
    command,
    'RUNTIME.SCHEMA_MISMATCH',
    `unknown worktree operation "${String(operation)}"`,
  );
}
