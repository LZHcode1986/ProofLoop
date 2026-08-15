/**
 * Explicit vNext mechanical Stage validator.
 *
 *   node packages/runtime/dist/cli/validate-vnext-stage.js \
 *     <tasks.md> <manifest.json> <evidence-dir> [project-root]
 *
 * The tasks file is read only to bind and audit the source path.  No goal,
 * task, proof, command, or acceptance fact is inferred from its Markdown body.
 */

import { VNEXT_SCHEMA_VERSION } from '@proofloop/kernel';
import {
  readRootBoundFile,
  resolveProjectRoot,
  errorMessage,
  validateVNextManifestArtifact,
  vnextError,
  type VNextCliError,
} from './vnext-cli-support-vnext';

export interface ValidateVNextStageResult {
  readonly valid: boolean;
  readonly stage_id: string;
  readonly schema_version: typeof VNEXT_SCHEMA_VERSION;
  readonly errors: readonly VNextCliError[];
}

function invalid(
  stageId: string,
  errors: readonly VNextCliError[],
): ValidateVNextStageResult {
  return {
    valid: false,
    stage_id: stageId,
    schema_version: VNEXT_SCHEMA_VERSION,
    errors,
  };
}

/**
 * Run the vNext mechanical gate.  This function is read-only and returns a
 * bounded result for every expected filesystem/schema failure.
 */
export function validateVNextStage(
  tasksPath: string,
  manifestPath: string,
  evidenceDir?: string,
  projectRoot?: string,
): ValidateVNextStageResult {
  let root: string;
  try {
    root = resolveProjectRoot(projectRoot);
  } catch (error) {
    return invalid('unknown', [vnextError('ROOT_ERROR', errorMessage(error))]);
  }

  try {
    // The body is deliberately discarded.  readRootBoundFile performs the
    // no-follow, regular-file, UTF-8 and post-read TOCTOU checks required for
    // the source binding, without invoking any Markdown parser.
    readRootBoundFile(root, tasksPath);
  } catch (error) {
    return invalid('unknown', [
      vnextError('TASKS_READ_FAILED', `tasks.md cannot be read as a root-bound source: ${errorMessage(error)}`, {
        path: tasksPath,
      }),
    ]);
  }

  let manifestValue: unknown;
  try {
    const read = readRootBoundFile(root, manifestPath);
    try {
      manifestValue = JSON.parse(read.content) as unknown;
    } catch (error) {
      return invalid('unknown', [
        vnextError('MANIFEST_JSON_INVALID', `manifest is not valid JSON: ${errorMessage(error)}`, {
          path: manifestPath,
        }),
      ]);
    }
  } catch (error) {
    return invalid('unknown', [
      vnextError('MANIFEST_READ_FAILED', `manifest cannot be read as a root-bound file: ${errorMessage(error)}`, {
        path: manifestPath,
      }),
    ]);
  }

  const checked = validateVNextManifestArtifact(root, manifestValue, {
    tasksPath,
    evidenceDir,
    verifyReferenceDigests: true,
    // S09-D-T01 — final all-binding Validator: every declared Evidence file
    // must bind exactly to this Manifest and no unrecovered refresh journal
    // may be present.  Mixed bindings fail closed before SPV/admission.
    verifyEvidenceBindings: true,
  });
  return {
    valid: checked.errors.length === 0,
    stage_id: checked.stage_id,
    schema_version: VNEXT_SCHEMA_VERSION,
    errors: checked.errors,
  };
}

export function validateVNextStageCli(argv: readonly string[]): number {
  const [tasksPath, manifestPath, evidenceDir, projectRoot, ...extra] = argv;
  if (!tasksPath || !manifestPath || !evidenceDir || extra.length > 0) {
    const result = invalid('unknown', [
      vnextError(
        'USAGE',
        'Usage: node dist/cli/validate-vnext-stage.js <tasks.md> <manifest.json> <evidence-dir> [project-root]',
      ),
    ]);
    console.log(JSON.stringify(result));
    return 1;
  }

  const result = validateVNextStage(tasksPath, manifestPath, evidenceDir, projectRoot);
  console.log(JSON.stringify(result));
  return result.valid ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = validateVNextStageCli(process.argv.slice(2));
}
