/** Public `proofloop boundary close` adapter (blueprint Part B §4.1). */
/**
 * Public `proofloop boundary close` adapter.
 *
 * Root-model closure (STATIC-40 / tech-spec/contracts.md §1.1 / §5.3):
 *  - the caller's `root` is ALWAYS the canonical Project Root
 *    (Authority/MES/Plan/status/primary repository identity);
 *  - the mechanical transaction root is resolved from the closed request's
 *    `expected_worktree` (root-relative Git worktree identity; ordinary
 *    boundaries default to `.` = the canonical Project Root);
 *  - worktree-targeted boundaries (`slice-output` / `prototype-checkpoint`)
 *    REQUIRE an explicit `expected_worktree` and may target a linked
 *    worktree inside the same Git common repository;
 *  - any other boundary carrying a non-`.` `expected_worktree` fails closed
 *    (BOUNDARY.REQUEST_INVALID, before any Git write);
 *  - the target must resolve (canonical root-relative, symlink-safe) to the
 *    EXACT Git toplevel of the SAME Git common repository as the Project
 *    Root — foreign / escaped / non-toplevel targets fail closed.
 *
 * `closeGitBoundary()` core keeps receiving one mechanical transaction root;
 * its detached-worktree semantics are unchanged.
 */
import * as fs from 'node:fs';
import {
  closeGitBoundary,
  GitBoundaryError,
  type BoundaryCloseRequest,
  type BoundaryType,
} from '../git-boundary';
import { resolveExactGitToplevel, sameGitCommonRepository } from '../git-source';
import { canonicalPathWithinRoot } from '../path-guard';
import {
  errorEnvelope,
  okEnvelope,
  type CliCommand,
  type CliEnvelope,
  type CliRequestInput,
} from './proofloop-common';

/** Boundary types whose mechanical transaction root may be a linked worktree. */
const WORKTREE_TARGETED_BOUNDARY_TYPES: ReadonlySet<BoundaryType> = new Set([
  'slice-output',
  'prototype-checkpoint',
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestFromCli(request: CliRequestInput): BoundaryCloseRequest {
  return {
    boundary_type: request.boundary_type as BoundaryType,
    ...(request.expected_head !== undefined ? { expected_head: request.expected_head } : {}),
    ...(request.stage !== undefined ? { stage: request.stage } : {}),
    ...(request.slice !== undefined ? { slice: request.slice } : {}),
    ...(request.other_slice_declared_files !== undefined
      ? { other_slice_declared_files: request.other_slice_declared_files }
      : {}),
    ...(request.tolerated_paths !== undefined
      ? { tolerated_paths: request.tolerated_paths }
      : {}),
    ...(request.paths !== undefined ? { paths: request.paths } : {}),
    ...(request.description !== undefined ? { description: request.description } : {}),
    ...(request.expected_branch !== undefined ? { expected_branch: request.expected_branch } : {}),
  };
}

/**
 * Resolve the mechanical transaction root for one boundary request against
 * the canonical Project Root (`root`). Never infers the target from cwd or
 * from the directory name; every non-`.` target is validated mechanically.
 */
function resolveBoundaryTransactionRoot(
  root: string,
  expectedWorktree: string | undefined,
  boundaryType: BoundaryType,
  stage: string | undefined,
  slice: string | undefined,
): string {
  const worktreeTargeted = WORKTREE_TARGETED_BOUNDARY_TYPES.has(boundaryType);

  if (!worktreeTargeted) {
    // Ordinary boundaries default to the canonical Project Root; a non-`.`
    // target is reserved for the Authority-closed worktree-targeted set.
    if (expectedWorktree !== undefined && expectedWorktree !== '.') {
      throw new GitBoundaryError(
        'BOUNDARY.REQUEST_INVALID',
        `boundary type ${boundaryType} is not worktree-targeted; expected_worktree must be "."`,
      );
    }
    return root;
  }

  if (expectedWorktree === undefined || expectedWorktree.length === 0) {
    throw new GitBoundaryError(
      'BOUNDARY.REQUEST_INVALID',
        `${boundaryType} is a worktree-targeted boundary and requires an explicit root-relative expected_worktree`,
    );
  }
  // Lane identity binding (Authority tech-spec/contracts.md §5.3 / STATIC-40):
  // the worktree target must BE this boundary's own canonical lane, so a
  // request cannot freeze Slice A's content into Slice B's worktree.
  if (boundaryType === 'slice-output') {
    if (stage === undefined || slice === undefined) {
      throw new GitBoundaryError(
        'BOUNDARY.REQUEST_INVALID',
        'slice-output requires stage and slice for lane identity binding',
      );
    }
    const canonicalLane = `.proofloop/worktrees/${stage}-${slice}`;
    if (expectedWorktree !== canonicalLane) {
      throw new GitBoundaryError(
        'BOUNDARY.REQUEST_INVALID',
        `slice-output expected_worktree must equal the canonical Slice lane ${canonicalLane} (received ${expectedWorktree})`,
      );
    }
  } else if (boundaryType === 'prototype-checkpoint') {
    if (!expectedWorktree.startsWith('.proofloop/worktrees/prototype-')) {
      throw new GitBoundaryError(
        'BOUNDARY.REQUEST_INVALID',
        `prototype-checkpoint expected_worktree must be a Prototype lane under .proofloop/worktrees/prototype- (received ${expectedWorktree})`,
      );
    }
  }

  // 1. root-relative / no escape / symlink-safe canonical resolution.
  const canonical = canonicalPathWithinRoot(root, expectedWorktree);
  if (canonical === null) {
    throw new GitBoundaryError(
      'BOUNDARY.REQUEST_INVALID',
      `expected_worktree escapes the canonical project root: ${expectedWorktree}`,
    );
  }

  // 2. realpath readable directory.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch {
    throw new GitBoundaryError(
      'BOUNDARY.REQUEST_INVALID',
      `expected_worktree is not a readable directory: ${expectedWorktree}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new GitBoundaryError(
      'BOUNDARY.REQUEST_INVALID',
      `expected_worktree is not a directory: ${expectedWorktree}`,
    );
  }

  // 3. exact Git toplevel (subdirectory / plain dir / fake marker fails).
  let toplevel: string;
  try {
    toplevel = resolveExactGitToplevel(canonical);
  } catch (error) {
    throw new GitBoundaryError(
      'BOUNDARY.REQUEST_INVALID',
      `expected_worktree is not an exact Git toplevel: ${expectedWorktree} (${errorMessage(error)})`,
    );
  }

  // 4. same Git common repository as the canonical Project Root.
  if (!sameGitCommonRepository(root, toplevel)) {
    throw new GitBoundaryError(
      'BOUNDARY.REQUEST_INVALID',
      `expected_worktree belongs to a different Git common repository: ${expectedWorktree}`,
    );
  }
  return toplevel;
}

/** Run one closed boundary operation and return the canonical CLI envelope. */
export function runBoundaryDomain(
  root: string,
  command: CliCommand,
  request: CliRequestInput,
): CliEnvelope {
  if (command.operation !== 'close') {
    return errorEnvelope(
      command,
      'RUNTIME.SCHEMA_MISMATCH',
      `unknown boundary operation "${String(command.operation)}"`,
    );
  }
  if (request.boundary_type === undefined) {
    return errorEnvelope(command, 'USAGE', 'boundary close requires --json or --request with boundary_type');
  }
  try {
    const boundaryRequest = requestFromCli(request);
    const transactionRoot = resolveBoundaryTransactionRoot(root, request.expected_worktree, boundaryRequest.boundary_type, boundaryRequest.stage, boundaryRequest.slice);
    return okEnvelope(command, closeGitBoundary(transactionRoot, boundaryRequest));
  } catch (error) {
    if (error instanceof GitBoundaryError) {
      return errorEnvelope(command, error.code, error.message);
    }
    return errorEnvelope(command, 'BOUNDARY.COMMIT_FAILED', errorMessage(error));
  }
}
