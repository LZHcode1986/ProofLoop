/**
 * Explicit vNext Slice Evidence initializer.
 *
 *   node packages/runtime/dist/cli/initialize-vnext-slice-evidence.js \
 *     <manifest.json> [evidence-dir] [project-root]
 *
 * Only a kernel-valid, root-bound vNext Manifest can reach the write phase.
 * Evidence files are installed with temp-write + fsync + atomic no-replace
 * linking, so an interrupted write cannot expose a half-written skeleton or
 * overwrite a concurrent/pre-existing file.
 */

import {
  computeVNextManifestDigest,
  ensureDirectoryNoFollow,
  errorMessage,
  readRootBoundJson,
  renderVNextEvidenceSkeleton,
  resolveProjectRoot,
  resolveRootBoundPath,
  validateVNextManifestArtifact,
  vnextError,
  openVerifiedDirectory,
  writeAtomicEvidence,
  type VNextCliError,
} from './vnext-cli-support-vnext';
import { VNEXT_SCHEMA_VERSION, type VNextManifest } from '@proofloop/kernel';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface InitializeVNextSliceEvidenceResult {
  readonly success: boolean;
  readonly stage_id: string;
  readonly schema_version: typeof VNEXT_SCHEMA_VERSION;
  readonly initialized: readonly string[];
  readonly skipped: readonly string[];
  readonly errors: readonly VNextCliError[];
}

function failed(
  stageId: string,
  errors: readonly VNextCliError[],
): InitializeVNextSliceEvidenceResult {
  return {
    success: false,
    stage_id: stageId,
    schema_version: VNEXT_SCHEMA_VERSION,
    initialized: [],
    skipped: [],
    errors,
  };
}

function resolveEvidenceDirectory(
  root: string,
  manifest: VNextManifest,
  supplied: string | undefined,
): string {
  if (supplied !== undefined) {
    const suppliedCanonical = resolveRootBoundPath(root, supplied, 'evidence-dir');
    const expectedParents = manifest.slices.map((slice) => {
      const target = resolveRootBoundPath(root, slice.evidence_path, 'manifest evidence_path');
      return path.dirname(target);
    });
    for (const expected of expectedParents) {
      if (expected !== suppliedCanonical) {
        throw new Error(
          `evidence-dir "${supplied}" does not contain declared evidence path parent "${expected}"`,
        );
      }
    }
    return suppliedCanonical;
  }

  const parents = new Set(
    manifest.slices.map((slice) => {
      const target = resolveRootBoundPath(root, slice.evidence_path, 'manifest evidence_path');
      return path.dirname(target);
    }),
  );
  if (parents.size !== 1) {
    throw new Error('declared vNext evidence paths do not share one evidence directory; pass [evidence-dir] explicitly');
  }
  return [...parents][0];
}

/**
 * Initialize vNext evidence from a manifest path.  The positional signature
 * mirrors the dist CLI and keeps this seam independent from the v1 options
 * object/API.
 */
export function initializeVNextSliceEvidence(
  manifestPath: string,
  evidenceDir?: string,
  projectRoot?: string,
): InitializeVNextSliceEvidenceResult {
  let root: string;
  try {
    root = resolveProjectRoot(projectRoot);
  } catch (error) {
    return failed('unknown', [vnextError('ROOT_ERROR', errorMessage(error))]);
  }

  let manifestValue: unknown;
  try {
    manifestValue = readRootBoundJson(root, manifestPath, 'manifest').value;
  } catch (error) {
    return failed('unknown', [
      vnextError('MANIFEST_READ_FAILED', `manifest cannot be read as a root-bound JSON file: ${errorMessage(error)}`, {
        path: manifestPath,
      }),
    ]);
  }

  const checked = validateVNextManifestArtifact(root, manifestValue, {
    verifyReferenceDigests: true,
  });
  if (checked.manifest === null || checked.errors.length > 0) {
    return failed(checked.stage_id, checked.errors);
  }

  const manifest = checked.manifest;
  let targetEvidenceDir: string;
  try {
    targetEvidenceDir = resolveEvidenceDirectory(root, manifest, evidenceDir);
  } catch (error) {
    return failed(manifest.stage_id, [vnextError('EVIDENCE_PATH_INVALID', errorMessage(error), { path: evidenceDir })]);
  }

  let verifiedDirectory: ReturnType<typeof ensureDirectoryNoFollow>;
  try {
    // All validation is complete before this call.  A missing parent chain is
    // the only directory state this operation creates.
    verifiedDirectory = ensureDirectoryNoFollow(root, targetEvidenceDir);
  } catch (error) {
    return failed(manifest.stage_id, [vnextError('EVIDENCE_DIR_ERROR', errorMessage(error), { path: targetEvidenceDir })]);
  }

  let opened: ReturnType<typeof openVerifiedDirectory>;
  try {
    opened = openVerifiedDirectory(verifiedDirectory);
  } catch (error) {
    return failed(manifest.stage_id, [vnextError('EVIDENCE_DIR_CHANGED', errorMessage(error), { path: targetEvidenceDir })]);
  }

  const initialized: string[] = [];
  const skipped: string[] = [];
  const errors: VNextCliError[] = [];
  const manifestDigest = computeVNextManifestDigest(manifest);

  try {
    for (const slice of manifest.slices) {
      const targetPath = resolveRootBoundPath(root, slice.evidence_path, 'manifest evidence_path');
      if (path.dirname(targetPath) !== targetEvidenceDir) {
        errors.push(
          vnextError(
            'EVIDENCE_PATH_OUT_OF_DIR',
            `evidence_path resolves outside the verified evidence directory`,
            { path: slice.evidence_path, slice_id: slice.slice_id },
          ),
        );
        continue;
      }
      const fileName = path.basename(targetPath);
      const skeleton = renderVNextEvidenceSkeleton(manifest, slice, manifestDigest);
      const result = writeAtomicEvidence(opened.procPrefix, fileName, skeleton);
      if (result.kind === 'created') {
        initialized.push(targetPath);
      } else if (result.kind === 'skipped') {
        skipped.push(targetPath);
      } else {
        errors.push(
          vnextError('EVIDENCE_WRITE_FAILED', result.message, {
            path: targetPath,
            slice_id: slice.slice_id,
          }),
        );
      }
    }
  } catch (error) {
    errors.push(vnextError('EVIDENCE_WRITE_FAILED', errorMessage(error), { path: targetEvidenceDir }));
  } finally {
    try {
      // `openVerifiedDirectory` returns a native descriptor; keeping it open
      // throughout the loop pins the physical directory against parent swaps.
      const dirfd = opened.dirfd;
      if (typeof dirfd === 'number') {
        fs.closeSync(dirfd);
      }
    } catch {
      // best-effort descriptor cleanup; a successful file write is already
      // complete and a failed write has removed its temporary inode.
    }
  }

  return {
    success: errors.length === 0,
    stage_id: manifest.stage_id,
    schema_version: VNEXT_SCHEMA_VERSION,
    initialized,
    skipped,
    errors,
  };
}

export function initializeVNextSliceEvidenceCli(argv: readonly string[]): number {
  const [manifestPath, evidenceDir, projectRoot, ...extra] = argv;
  if (!manifestPath || extra.length > 0) {
    const result = failed('unknown', [
      vnextError(
        'USAGE',
        'Usage: node dist/cli/initialize-vnext-slice-evidence.js <manifest.json> [evidence-dir] [project-root]',
      ),
    ]);
    console.log(JSON.stringify(result));
    return 1;
  }

  const result = initializeVNextSliceEvidence(manifestPath, evidenceDir, projectRoot);
  console.log(JSON.stringify(result));
  return result.success ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = initializeVNextSliceEvidenceCli(process.argv.slice(2));
}
