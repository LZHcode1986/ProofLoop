/**
 * initialize-slice-evidence — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * Creates the standard Slice Evidence skeleton files for every slice
 * declared in a compiled Manifest. Legacy-compatible contract:
 *
 *   node packages/runtime/dist/cli/initialize-slice-evidence.js <manifest-path> [delivery-root]
 *
 * Security (fail closed):
 *  - the manifest is validated through the kernel `validateManifest` seam;
 *  - evidence paths must match the canonical pattern
 *    `delivery/stages/<stage-id>/evidence/<slice-id>.md` and resolve inside
 *    the stage evidence directory (no path traversal, no symlink targets);
 *  - existing non-empty evidence files are never overwritten; creation uses
 *    exclusive-create so concurrent writers cannot clobber.
 *
 * Output: JSON `{ created, skipped, errors }`; exit 0 no errors / 1 errors.
 *
 * Zero host dependencies: Node builtins + `@proofloop/kernel` only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateManifest } from '@proofloop/kernel';
import type { Manifest } from '@proofloop/kernel';

// ============================================================
// Shapes
// ============================================================

export interface InitializeSliceEvidenceOptions {
  /** Kernel-validated Manifest. */
  readonly manifest: Manifest;
  /** Delivery root — evidence paths resolve under it (default cwd). */
  readonly deliveryRoot?: string;
}

export interface InitializeSliceEvidenceResult {
  readonly created: readonly string[];
  readonly skipped: readonly string[];
  readonly errors: readonly string[];
}

// ============================================================
// Skeleton
// ============================================================

function generateEvidenceSkeleton(
  sliceId: string,
  stageId: string,
  sliceGoal: string,
  publicSeam: string,
  manifestDigest: string,
): string {
  return `# Slice ${sliceId} Evidence

## Slice Context

- Slice ID: ${sliceId}
- Stage ID: ${stageId}
- Slice Goal: ${sliceGoal}
- Public Seam: ${publicSeam}
- Manifest Digest: ${manifestDigest}

## Task Evidence

*No tasks have been executed yet.*

## Current Slice Evidence

### Snapshot

*Not yet captured.*

### Proof Obligation Coverage

| PO ID | Test ID / Verification Action | RED Receipt | GREEN Receipt | Current Result |
|---|---|---|---|---|
| *None* | | | | |

### Changed Files

*No changes yet.*

### Verification Commands

*Not yet run.*

### Actual Observations

*Not yet observed.*

### Limitations

*None identified.*

## Current CV Status

- Status: NOT_RUN
- Level: *Not yet determined*
- Latest CV Receipt: *None*
- Open Finding: *None*
`;
}

// ============================================================
// Main initializer
// ============================================================

const EVIDENCE_PATH_RE = /^delivery\/stages\/(S\d[\w-]*)\/evidence\/(S\d{2,}-[A-Z])\.md$/;

/** Canonical digest used to bind the skeleton to the manifest. */
function manifestDigest(manifest: Manifest): string {
  return require('node:crypto')
    .createHash('sha256')
    .update(JSON.stringify(manifest, Object.keys(manifest).sort(), 2), 'utf-8')
    .digest('hex');
}

/**
 * Initialize Slice Evidence files for all slices in a compiled Manifest.
 *
 * For each slice:
 *  1. evidence_path must match the canonical pattern;
 *  2. the resolved path must stay inside the stage evidence directory;
 *  3. existing non-empty files are skipped; empty files are replaced via
 *     exclusive create.
 */
export function initializeSliceEvidence(
  options: InitializeSliceEvidenceOptions,
): InitializeSliceEvidenceResult {
  const manifest = options.manifest;
  const deliveryRoot = path.resolve(options.deliveryRoot ?? process.cwd());
  const created: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  let digest: string;
  try {
    digest = manifestDigest(manifest);
  } catch (err) {
    errors.push(`Manifest digest computation failed: ${err instanceof Error ? err.message : String(err)}`);
    return { created, skipped, errors };
  }

  const canonicalEvidenceDir = path.resolve(
    deliveryRoot,
    'delivery',
    'stages',
    manifest.stage_id,
    'evidence',
  );

  for (const slice of manifest.slices) {
    const evidencePath = slice.evidence_path;
    if (!evidencePath) {
      errors.push(`Slice "${slice.slice_id}" has no evidence_path in manifest`);
      continue;
    }
    const match = evidencePath.match(EVIDENCE_PATH_RE);
    if (!match || match[1] !== manifest.stage_id || match[2] !== slice.slice_id) {
      errors.push(
        `Slice "${slice.slice_id}" evidence_path "${evidencePath}" does not match ` +
          `the canonical pattern "delivery/stages/${manifest.stage_id}/evidence/${slice.slice_id}.md"`,
      );
      continue;
    }
    const resolvedPath = path.resolve(deliveryRoot, evidencePath);
    const resolvedDir = path.dirname(resolvedPath);
    if (resolvedDir !== canonicalEvidenceDir) {
      errors.push(
        `Slice "${slice.slice_id}" evidence_path "${evidencePath}" resolves to "${resolvedPath}" ` +
          `outside the stage evidence directory "${canonicalEvidenceDir}" — path traversal rejected`,
      );
      continue;
    }
    if (fs.existsSync(resolvedPath)) {
      const stat = fs.lstatSync(resolvedPath);
      if (stat.isSymbolicLink()) {
        errors.push(`Slice "${slice.slice_id}" evidence path "${resolvedPath}" is a symlink — refusing to overwrite`);
        continue;
      }
      if (stat.isDirectory()) {
        errors.push(`Slice "${slice.slice_id}" evidence path "${resolvedPath}" is a directory`);
        continue;
      }
      const content = fs.readFileSync(resolvedPath, 'utf-8');
      if (content.trim().length > 0) {
        skipped.push(resolvedPath);
        continue;
      }
      try {
        fs.unlinkSync(resolvedPath);
      } catch (err) {
        errors.push(`Slice "${slice.slice_id}" cannot remove empty file "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
    try {
      fs.mkdirSync(canonicalEvidenceDir, { recursive: true });
    } catch (err) {
      errors.push(`Slice "${slice.slice_id}" cannot create evidence directory "${canonicalEvidenceDir}": ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const skeleton = generateEvidenceSkeleton(
      slice.slice_id,
      manifest.stage_id,
      slice.goal,
      slice.public_seam,
      digest,
    );
    try {
      fs.writeFileSync(resolvedPath, skeleton, { encoding: 'utf-8', flag: 'wx' });
      created.push(resolvedPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        try {
          const existing = fs.readFileSync(resolvedPath, 'utf-8');
          if (existing.trim().length > 0) {
            skipped.push(resolvedPath);
          } else {
            errors.push(`Slice "${slice.slice_id}" race: empty file created concurrently at "${resolvedPath}"`);
          }
        } catch {
          errors.push(`Slice "${slice.slice_id}" TOCTOU race writing evidence file "${resolvedPath}"`);
        }
      } else {
        errors.push(`Slice "${slice.slice_id}" failed to write evidence file "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { created, skipped, errors };
}

// ============================================================
// CLI entry
// ============================================================

/**
 * Legacy-compatible CLI:
 *   node dist/cli/initialize-slice-evidence.js <manifest-path> [delivery-root]
 */
export function initializeSliceEvidenceCli(argv: readonly string[]): number {
  const [manifestPath, deliveryRoot] = argv;
  if (!manifestPath) {
    console.error('Usage: node dist/cli/initialize-slice-evidence.js <manifest-path> [delivery-root]');
    console.error('');
    console.error('Creates Slice Evidence skeletons for every slice of a compiled Manifest.');
    console.error('Existing non-empty evidence files are never overwritten.');
    return 1;
  }
  let manifest: Manifest;
  try {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    manifest = validateManifest(JSON.parse(content));
  } catch (err) {
    console.error(`Failed to load manifest: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const result = initializeSliceEvidence({ manifest, deliveryRoot });
  for (const created of result.created) console.log(`Created: ${created}`);
  for (const skipped of result.skipped) console.log(`Skipped (existing): ${skipped}`);
  for (const err of result.errors) console.error(`Error: ${err}`);
  console.log(JSON.stringify({ created: result.created, skipped: result.skipped, errors: result.errors }));
  return result.errors.length > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exitCode = initializeSliceEvidenceCli(process.argv.slice(2));
}
