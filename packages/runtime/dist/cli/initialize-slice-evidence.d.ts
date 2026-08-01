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
import type { Manifest } from '@proofloop/kernel';
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
/**
 * Initialize Slice Evidence files for all slices in a compiled Manifest.
 *
 * For each slice:
 *  1. evidence_path must match the canonical pattern;
 *  2. the resolved path must stay inside the stage evidence directory;
 *  3. existing non-empty files are skipped; empty files are replaced via
 *     exclusive create.
 */
export declare function initializeSliceEvidence(options: InitializeSliceEvidenceOptions): InitializeSliceEvidenceResult;
/**
 * Legacy-compatible CLI:
 *   node dist/cli/initialize-slice-evidence.js <manifest-path> [delivery-root]
 */
export declare function initializeSliceEvidenceCli(argv: readonly string[]): number;
//# sourceMappingURL=initialize-slice-evidence.d.ts.map