/** Neutral stable Git-boundary validator shared by vNext Runtime readers. */
import { execFileSync } from 'node:child_process';
import { readGitHead, resolveGitRoot } from '../git-source';

export type StableGitBoundaryCode = 'git-unavailable' | 'worktree-dirty' | 'snapshot-binding';

export class StableGitBoundaryError extends Error {
  public readonly code: StableGitBoundaryCode;

  constructor(code: StableGitBoundaryCode, message: string) {
    super(message);
    this.name = 'StableGitBoundaryError';
    this.code = code;
  }
}

/** Require a clean worktree and, when supplied, an exact current HEAD snapshot. */
export function assertStableGitBoundary(root: string, snapshotDigest?: string): string {
  let gitRoot: string;
  try {
    gitRoot = resolveGitRoot(root);
  } catch (error) {
    throw new StableGitBoundaryError(
      'git-unavailable',
      'canonical Git project root is unavailable: ' + (error instanceof Error ? error.message : String(error)),
    );
  }

  let porcelain: string;
  try {
    porcelain = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: gitRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new StableGitBoundaryError(
      'git-unavailable',
      'current Git worktree status is unavailable: ' + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (porcelain.trim().length > 0) {
    throw new StableGitBoundaryError(
      'worktree-dirty',
      'vNext Stage Plan admission requires a clean Git worktree at the canonical project root',
    );
  }

  let head: string;
  try {
    head = readGitHead(gitRoot);
  } catch (error) {
    throw new StableGitBoundaryError(
      'git-unavailable',
      'current Git HEAD is unavailable: ' + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (snapshotDigest !== undefined && snapshotDigest !== head) {
    throw new StableGitBoundaryError(
      'snapshot-binding',
      `vNext Stage Plan admission snapshot_digest "${snapshotDigest}" does not match current Git HEAD "${head}", fresh SPV is required`,
    );
  }
  return head;
}
