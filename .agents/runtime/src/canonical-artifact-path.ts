/**
 * canonical-artifact-path.ts
 *
 * Shared canonical path resolution for artifact references.
 *
 * Rules:
 * - Allow trustRoot itself to resolve to a real path through system alias
 *   (e.g. macOS /var -> /private/var).
 * - Reject any symlink strictly BELOW the trusted root.
 * - Verify the resolved path is a regular file within the trusted root.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Exported functions ─────────────────────────────────────────────────────────

/**
 * Resolve an artifact reference to a canonical file path.
 *
 * Searches multiple candidate locations (absolute, relative to trustRoot,
 * relative to cwd, under .proofloop/receipts/) and validates the result
 * via `assertRegularFileBelowTrustedRoot`.
 *
 * @param reference - The artifact reference (absolute or relative path).
 * @param trustRoot - The trusted root directory for path validation.
 * @param searchPaths - Additional base directories to resolve relative references against.
 * @returns The canonical real path if found and valid, or null.
 */
export function resolveCanonicalArtifact(
  reference: string,
  trustRoot: string,
  searchPaths?: string[],
): string | null {
  // Absolute references: validate directly
  if (path.isAbsolute(reference)) {
    return assertRegularFileBelowTrustedRoot(reference, trustRoot);
  }

  // Build candidate bases for relative references
  const bases: string[] = [
    trustRoot,
    path.resolve(trustRoot, '.proofloop', 'receipts'),
    process.cwd(),
    path.resolve(process.cwd(), '.proofloop', 'receipts'),
  ];

  // Include custom search paths if provided
  if (searchPaths) {
    for (const sp of searchPaths) {
      bases.push(sp);
    }
  }

  // Try each base — deduplication is handled by the fact that
  // assertRegularFileBelowTrustedRoot returns null for invalid paths,
  // and we return on the first valid match.
  const seen = new Set<string>();
  for (const base of bases) {
    const candidate = path.resolve(base, reference);
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const result = assertRegularFileBelowTrustedRoot(normalized, trustRoot);
    if (result !== null) return result;
  }

  return null;
}

/**
 * Assert that a resolved path is a regular file below a trusted root,
 * with no symlink components strictly below that root.
 *
 * 1. Resolve trustRoot to absolute + realpath (to handle system aliases).
 * 2. Resolve targetPath to absolute.
 * 3. Walk ancestors from targetPath up to (but not including) trustRoot;
 *    if any is a symlink, reject.
 * 4. Check `statSync().isFile()` — must be a regular file.
 * 5. Use `realpathSync()` to get the real path and verify it starts with realRoot.
 * 6. Return the real path on success, or null on any failure.
 *
 * @param targetPath - The path to validate.
 * @param trustRoot  - The trusted root directory.
 * @returns The real (symlink-resolved) path on success, or null on failure.
 */
export function assertRegularFileBelowTrustedRoot(
  targetPath: string,
  trustRoot: string,
): string | null {
  try {
    // 1. Resolve trustRoot to absolute + realpath (handle system aliases)
    const resolvedRoot = path.resolve(trustRoot);
    const realRoot = fs.realpathSync(resolvedRoot);

    // 2. Resolve targetPath to absolute
    const resolvedTarget = path.resolve(targetPath);

    // 3. Walk ancestors checking for symlinks below trustRoot
    const symlinkCheck = checkNoSymlinkBelowTrustRoot(resolvedTarget, resolvedRoot);
    if (symlinkCheck !== null) return null;

    // 4. Must be a regular file
    if (!fs.statSync(resolvedTarget).isFile()) return null;

    // 5. Get real path and verify it starts with realRoot
    const realTarget = fs.realpathSync(resolvedTarget);
    const realRootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    if (!realTarget.startsWith(realRootPrefix) && realTarget !== realRoot) return null;

    // 6. Return the real path
    return realTarget;
  } catch {
    return null;
  }
}

/**
 * Check that no component of targetPath (strictly below trustRoot) is a symlink.
 *
 * Walks from targetPath up to trustRoot boundary (exclusive), checking each
 * existing ancestor with `lstatSync().isSymbolicLink()`.
 *
 * Symlinks at or above trustRoot (e.g. macOS /var -> /private/var) are accepted
 * because the walk stops before reaching the trustRoot itself.
 *
 * @param targetPath - The path whose ancestor components are checked.
 * @param trustRoot  - The trusted root boundary (exclusive).
 * @returns Null if clean, or an error message string if a symlink is found.
 */
export function checkNoSymlinkBelowTrustRoot(
  targetPath: string,
  trustRoot: string,
): string | null {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(trustRoot);

  // Walk from targetPath up to (but not including) trustRoot
  let current = resolvedTarget;
  while (current.length > resolvedRoot.length) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        return `Path component "${current}" is a symlink below the trusted root "${resolvedRoot}". Rejected.`;
      }
    } catch {
      // Component doesn't exist — continue checking existing parents
    }

    const parent = path.dirname(current);
    if (parent === current || parent.length <= resolvedRoot.length) break;
    current = parent;
  }

  return null; // clean
}
