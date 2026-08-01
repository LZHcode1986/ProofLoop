/**
 * @proofloop/runtime — Manifest source reader (S02-C-T02)
 *
 * Reads the stage Manifest source of a reconcile:
 *   - resolves the canonical path `<projectRoot>/.proofloop/manifests/<stage>.json`
 *     (a custom `manifestPath` is honored);
 *   - validates the payload through the kernel `validateManifest` seam (S01);
 *   - checks the manifest `stage_id` against the input stage id.
 *
 * Failure semantics (PO-S02-C-02): a missing / unreadable / invalid-JSON /
 * schema-invalid manifest or a `stage_id` mismatch throws the structured
 * `ManifestSourceError` with the canonical code `DOMAIN.STAGE_NOT_FOUND` —
 * the manifest source cannot be used, and the reconcile layer converts the
 * condition into the canonical Finding (never a guess).
 *
 * Determinism (HP-003): pure filesystem read + kernel validation + string
 * comparison — the same input always yields the same output. Read-only;
 * never writes or repairs.
 */
import type { Manifest } from '@proofloop/kernel';
export interface ManifestSourceInput {
    readonly projectRoot: string;
    readonly stageId: string;
    /** Custom manifest path; defaults to `<projectRoot>/.proofloop/manifests/<stage>.json`. */
    readonly manifestPath?: string;
}
export interface ManifestSourceResult {
    /** Kernel-validated manifest. */
    readonly manifest: Manifest;
    /** Absolute path of the manifest file read. */
    readonly manifest_path: string;
}
/**
 * Structured manifest-source-unavailable condition (PO-S02-C-02): missing /
 * unreadable / parse-failed / schema-invalid / stage_id-mismatched manifest
 * → the canonical code DOMAIN.STAGE_NOT_FOUND.
 */
export declare class ManifestSourceError extends Error {
    readonly code: 'DOMAIN.STAGE_NOT_FOUND';
    readonly source: 'manifest';
    readonly reason: string;
    constructor(message: string);
}
/** Canonical manifest path: `<projectRoot>/.proofloop/manifests/<stage>.json`. */
export declare function defaultManifestPath(projectRoot: string, stageId: string): string;
/** Canonical JSON string of a parsed manifest (recursively sorted keys). */
export declare function canonicalManifestJson(value: unknown): string;
/**
 * Canonical content digest of a parsed manifest: SHA-256 over the canonical
 * JSON representation (64-hex). This is the runtime's canonical digest
 * computation for the `admitStagePlan` manifest lifecycle binding
 * (PO-S02-E-07) — the request's `manifestDigest` must equal this value for
 * the stage-plan admit to be accepted.
 */
export declare function canonicalManifestDigest(value: unknown): string;
/**
 * Read the canonical stage manifest file and compute its canonical digest
 * (PO-S02-E-07 binding source). Reads the same canonical path as
 * `manifestSource`; a missing / unreadable / parse-failed file throws the
 * structured `ManifestSourceError` (DOMAIN.STAGE_NOT_FOUND) — never a guess.
 */
export declare function manifestFileDigest(input: ManifestSourceInput): string;
/**
 * Read and kernel-validate the stage manifest (PO-S02-C-01 data-source part).
 *
 * @throws {ManifestSourceError} (code `DOMAIN.STAGE_NOT_FOUND`) when the
 *         manifest is missing/unreadable, not valid JSON, fails kernel schema
 *         validation, or its `stage_id` does not match the input stage id.
 */
export declare function manifestSource(input: ManifestSourceInput): ManifestSourceResult;
//# sourceMappingURL=manifest-source.d.ts.map