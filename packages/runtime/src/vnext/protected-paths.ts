/**
 * Protected-path scan (mechanical).
 *
 * Rewritten input model (bootstrap unlock): the caller supplies the Work
 * Packet allowed scope (root-relative paths the worker may touch) plus the
 * canonical protected roots.  This module no longer reads Receipts, Manifest
 * or replan disposition facts; it only asserts that a Git-ignored / untracked
 * path under a protected root is NOT silently hidden from the changed-file
 * set.  Any path that escapes the project root, traverses a symlink identity
 * change, or hides a protected artifact fails closed with VNextHandoffError.
 */

import * as path from 'node:path';
import { canonicalPathWithinRoot } from '../path-guard';
import { VNextHandoffError } from './errors';

export interface ProtectedScopeInput {
  /** Work Packet allowed scope (root-relative paths the worker may touch). */
  readonly allowedPaths: readonly string[];
  /** Canonical protected roots (root-relative), e.g. ['.proofloop', '.git']. */
  readonly protectedRoots: readonly string[];
}

export const CANONICAL_PROTECTED_ROOTS: readonly string[] = ['.proofloop', '.git'] as const;

function fail(code: VNextHandoffError['code'], message: string): never {
  throw new VNextHandoffError(code, message);
}

function pathWithin(value: string, base: string): boolean {
  return value === base || value.startsWith(`${base.replace(/\/$/, '')}/`);
}

function rootRelativePath(root: string, value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('\u0000')
  ) {
    fail('path-escape', `${label} must be a canonical root-relative path`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    fail('path-escape', `${label} must be a canonical root-relative path`);
  }
  const lexical = path.resolve(root, ...parts);
  const canonical = canonicalPathWithinRoot(root, lexical);
  if (canonical === null || canonical !== lexical) {
    fail('path-escape', `${label} escapes or traverses the project root`);
  }
  return parts.join('/');
}

/**
 * Assert the protected-path boundary for a Work Packet:
 *  - every allowed path is root-bound and canonical;
 *  - no allowed path overlaps a canonical protected root;
 *  - the protected roots themselves are canonical (must not be escaped).
 */
export function assertProtectedScope(root: string, input: ProtectedScopeInput): void {
  const allowed = input.allowedPaths.map((value, index) =>
    rootRelativePath(root, value, `allowed path[${index}]`),
  );
  const protectedRoots = (input.protectedRoots.length > 0 ? input.protectedRoots : CANONICAL_PROTECTED_ROOTS)
    .map((value, index) => rootRelativePath(root, value, `protected root[${index}]`));
  for (const protectedRoot of protectedRoots) {
    if (allowed.some((allowedPath) => pathWithin(allowedPath, protectedRoot))) {
      fail(
        'execution-scope-gap',
        `Work Packet allowed scope must not overlap a canonical protected root: ${protectedRoot}`,
      );
    }
  }
}
