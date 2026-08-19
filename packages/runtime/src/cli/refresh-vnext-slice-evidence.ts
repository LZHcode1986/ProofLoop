/**
 * Explicit vNext Evidence refresh CLI.
 *
 * Pre-admission / FR-021 layout (backward compatible, unchanged):
 *
 *   node packages/runtime/dist/cli/refresh-vnext-slice-evidence.js \
 *     <manifest.json> <previous-manifest-digest> [evidence-dir] [project-root] [refresh|recover|rollback|rebind]
 *
 * mode=replan layout (S15-A-T02, §8.8):
 *
 *   node packages/runtime/dist/cli/refresh-vnext-slice-evidence.js \
 *     <manifest.json> <previous-manifest-digest> <disposition-ref> <disposition-digest> \
 *     [evidence-dir] [project-root] replan [rotate|recover|rollback]
 *
 * The mode token disambiguates the two layouts (mode=replan carries the
 * Runtime preparation disposition ref/digest before the optional
 * evidence-dir/project-root).
 *
 * `refresh` is the Runtime-owned pre-admission operation: only legal while the
 * Stage has no plan/execution Receipts and every declared Evidence file is
 * still the pristine skeleton bound to the previous Manifest digest.  `rebind`
 * (S12-E-T01, FR-021) is the post-admission counterpart: after a replan, the
 * evidence of an ADMITTED and CURRENT slice (slice-local mode) may carry
 * historical Task Evidence content — only its binding header is rewritten to
 * the new Manifest, the content is preserved and a `## Refresh Record` section
 * (`- label:` format) is appended; un-admitted / un-finished evidence keeps
 * the pristine-only semantics.  `replan` (S15-A-T02) is the post-admission
 * Replan preparation/rotation seam: the Runtime verifies the digest-addressed
 * preparation disposition fact + current/parent epoch binding, archives the
 * old Evidence append-only, writes the current canonical skeleton with
 * carried Task Evidence preserved and restores the bounded tasks.md
 * projection; `recover`/`rollback` phases complete/revert journaled rotation
 * transactions.  All modes are transactions (journal + per-file
 * compare-and-swap) with rollback and restart recovery; they never report a
 * partial update as success and never write a Receipt or change Task/CV state.
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
  type ReplanRefreshPhase,
} from '../vnext/evidence-refresh';
import { vnextError, type VNextCliError } from './vnext-cli-support-vnext';

const MODE_TOKENS: readonly string[] = ['refresh', 'recover', 'rollback', 'rebind', 'replan'];

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
        'Usage: node dist/cli/refresh-vnext-slice-evidence.js <manifest.json> <previous-manifest-digest> [evidence-dir] [project-root] [refresh|recover|rollback|rebind]\n' +
          '       replan: <manifest.json> <previous-manifest-digest> <disposition-ref> <disposition-digest> [evidence-dir] [project-root] replan [rotate|recover|rollback]',
      ),
    ],
  };
}

export function refreshVNextSliceEvidenceCli(argv: readonly string[]): number {
  if (!argv[0] || !argv[1]) {
    const result = usage('unknown');
    console.log(JSON.stringify(result));
    return 1;
  }
  const manifestPath = argv[0];
  const previousManifestDigest = argv[1];

  // The mode token disambiguates the layouts.  Pre-admission/FR-021 keeps
  // the legacy positional order; mode=replan carries the Runtime preparation
  // disposition ref/digest before the optional evidence-dir/project-root.
  const modeIndex = argv.findIndex((token) => MODE_TOKENS.includes(token));
  const modeToken = modeIndex === -1 ? undefined : argv[modeIndex];

  let mode: RefreshVNextMode;
  let dispositionRef: string | undefined;
  let dispositionDigest: string | undefined;
  let evidenceDir: string | undefined;
  let projectRoot: string | undefined;
  let replanPhase: ReplanRefreshPhase | undefined;

  if (modeToken === 'replan') {
    // replan layout:
    // [manifest, previous-digest, [disposition-ref, disposition-digest]?, evidence-dir?, project-root?, replan, phase?]
    const before = argv.slice(2, modeIndex);
    const after = argv.slice(modeIndex + 1);
    if (before.length > 4 || after.length > 1) {
      const result = usage('unknown');
      console.log(JSON.stringify(result));
      return 1;
    }
    if (before.length >= 2 && /^[a-f0-9]{64}$/.test(before[1])) {
      dispositionRef = before[0];
      dispositionDigest = before[1];
      evidenceDir = before[2];
      projectRoot = before[3];
    } else {
      evidenceDir = before[0];
      projectRoot = before[1];
    }
    mode = 'replan';
    if (after.length === 1) {
      replanPhase = after[0] as ReplanRefreshPhase;
      if (replanPhase !== 'rotate' && replanPhase !== 'recover' && replanPhase !== 'rollback') {
        const result = usage('unknown');
        console.log(JSON.stringify(result));
        return 1;
      }
    }
  } else {
    // Legacy layout (unchanged positional contract):
    // [manifest, previous-digest, evidence-dir?, project-root?, mode?]
    evidenceDir = argv[2];
    projectRoot = argv[3];
    const legacyMode = argv[4];
    if (argv.length > 5 || (legacyMode !== undefined && !MODE_TOKENS.includes(legacyMode))) {
      const result = usage('unknown');
      console.log(JSON.stringify(result));
      return 1;
    }
    mode = (legacyMode ?? 'refresh') as RefreshVNextMode;
  }
  if (mode !== 'refresh' && mode !== 'recover' && mode !== 'rollback' && mode !== 'rebind' && mode !== 'replan') {
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
    dispositionRef,
    dispositionDigest,
    replanPhase,
  });
  console.log(JSON.stringify(result));
  return result.success ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = refreshVNextSliceEvidenceCli(process.argv.slice(2));
}
