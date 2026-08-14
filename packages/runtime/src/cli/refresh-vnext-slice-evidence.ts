/**
 * Explicit vNext Evidence refresh CLI.
 *
 *   node packages/runtime/dist/cli/refresh-vnext-slice-evidence.js \
 *     <manifest.json> <previous-manifest-digest> [evidence-dir] [project-root] [refresh|recover|rollback]
 *
 * Runtime-owned pre-admission operation: only legal while the Stage has no
 * plan/execution Receipts and every declared Evidence file is still the
 * pristine skeleton bound to the previous Manifest digest.  The refresh is a
 * transaction (journal + per-file compare-and-swap) with rollback and restart
 * recovery; it never reports a partial update as success and never writes a
 * Receipt or changes Task/CV state.
 *
 * Brain bootstrap boundary (S09-D-T02): Brain and Agents may invoke ONLY this
 * BUILT dist entry (packages/runtime/dist/cli/refresh-vnext-slice-evidence.js)
 * and must consume its structured JSON result; they never call the source/TS
 * entry or the internal refresh service directly, and never hand-edit Slice
 * Evidence to rebind it.
 */

import { VNEXT_SCHEMA_VERSION } from '@proofloop/kernel';
import {
  refreshVNextSliceEvidence,
  type RefreshVNextSliceEvidenceResult,
  type RefreshVNextMode,
} from '../vnext/evidence-refresh';
import { vnextError, type VNextCliError } from './vnext-cli-support-vnext';

function usage(stageId: string): RefreshVNextSliceEvidenceResult {
  return {
    success: false,
    stage_id: stageId,
    schema_version: VNEXT_SCHEMA_VERSION,
    mode: 'refresh',
    refreshed: [],
    recovered: false,
    rolled_back: false,
    blocked_recovery: false,
    errors: [
      vnextError(
        'USAGE',
        'Usage: node dist/cli/refresh-vnext-slice-evidence.js <manifest.json> <previous-manifest-digest> [evidence-dir] [project-root] [refresh|recover|rollback]',
      ),
    ],
  };
}

export function refreshVNextSliceEvidenceCli(argv: readonly string[]): number {
  const [manifestPath, previousManifestDigest, evidenceDir, projectRoot, modeArg, ...extra] = argv;
  if (!manifestPath || !previousManifestDigest || extra.length > 0) {
    const result = usage('unknown');
    console.log(JSON.stringify(result));
    return 1;
  }
  const mode: RefreshVNextMode = (modeArg ?? 'refresh') as RefreshVNextMode;
  if (mode !== 'refresh' && mode !== 'recover' && mode !== 'rollback') {
    const result = usage('unknown');
    console.log(JSON.stringify(result));
    return 1;
  }

  const result = refreshVNextSliceEvidence({
    manifestPath,
    previousManifestDigest,
    evidenceDir,
    projectRoot,
    mode,
  });
  console.log(JSON.stringify(result));
  return result.success ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = refreshVNextSliceEvidenceCli(process.argv.slice(2));
}
