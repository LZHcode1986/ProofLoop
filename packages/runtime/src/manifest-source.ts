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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { validateManifest } from '@proofloop/kernel';
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
export class ManifestSourceError extends Error {
  public readonly code: 'DOMAIN.STAGE_NOT_FOUND' = 'DOMAIN.STAGE_NOT_FOUND';
  public readonly source: 'manifest' = 'manifest';
  public readonly reason: string;

  constructor(message: string) {
    super(message);
    this.name = 'ManifestSourceError';
    this.reason = message;
  }
}

/** Canonical manifest path: `<projectRoot>/.proofloop/manifests/<stage>.json`. */
export function defaultManifestPath(projectRoot: string, stageId: string): string {
  return path.join(projectRoot, '.proofloop', 'manifests', `${stageId}.json`);
}

// ============================================================
// Canonical manifest digest (PO-S02-E-07 manifest lifecycle binding)
// ============================================================

/**
 * Recursively sort object keys — the canonical JSON serialization used for
 * content-addressed digesting (HP-003 determinism: identical content in any
 * key order yields the identical canonical string). Arrays keep their order;
 * primitives pass through untouched.
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

/** Canonical JSON string of a parsed manifest (recursively sorted keys). */
export function canonicalManifestJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * Canonical content digest of a parsed manifest: SHA-256 over the canonical
 * JSON representation (64-hex). This is the runtime's canonical digest
 * computation for the `admitStagePlan` manifest lifecycle binding
 * (PO-S02-E-07) — the request's `manifestDigest` must equal this value for
 * the stage-plan admit to be accepted.
 */
export function canonicalManifestDigest(value: unknown): string {
  return createHash('sha256').update(canonicalManifestJson(value), 'utf-8').digest('hex');
}

/**
 * Read the canonical stage manifest file and compute its canonical digest
 * (PO-S02-E-07 binding source). Reads the same canonical path as
 * `manifestSource`; a missing / unreadable / parse-failed file throws the
 * structured `ManifestSourceError` (DOMAIN.STAGE_NOT_FOUND) — never a guess.
 */
export function manifestFileDigest(input: ManifestSourceInput): string {
  const { projectRoot, stageId } = input;
  const manifestPath = input.manifestPath ?? defaultManifestPath(projectRoot, stageId);

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestSourceError(
      `manifest not found or unreadable at ${manifestPath}: ${reason}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestSourceError(
      `manifest at ${manifestPath} is not valid JSON: ${reason}`,
    );
  }

  return canonicalManifestDigest(parsed);
}

/**
 * Read and kernel-validate the stage manifest (PO-S02-C-01 data-source part).
 *
 * @throws {ManifestSourceError} (code `DOMAIN.STAGE_NOT_FOUND`) when the
 *         manifest is missing/unreadable, not valid JSON, fails kernel schema
 *         validation, or its `stage_id` does not match the input stage id.
 */
export function manifestSource(input: ManifestSourceInput): ManifestSourceResult {
  const { projectRoot, stageId } = input;
  const manifestPath = input.manifestPath ?? defaultManifestPath(projectRoot, stageId);

  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestSourceError(
      `manifest not found or unreadable at ${manifestPath}: ${reason}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestSourceError(
      `manifest at ${manifestPath} is not valid JSON: ${reason}`,
    );
  }

  let manifest: Manifest;
  try {
    manifest = validateManifest(parsed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ManifestSourceError(
      `manifest at ${manifestPath} failed schema validation: ${reason}`,
    );
  }

  if (manifest.stage_id !== stageId) {
    throw new ManifestSourceError(
      `manifest stage_id "${manifest.stage_id}" does not match input stage_id "${stageId}"`,
    );
  }

  return { manifest, manifest_path: manifestPath };
}
