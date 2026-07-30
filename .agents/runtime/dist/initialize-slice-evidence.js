/**
 * initialize-slice-evidence.ts
 *
 * Creates standard Slice Evidence skeleton files for all slices declared in a Manifest.
 * Each skeleton is written at the path specified by the Slice's `evidence_path`.
 *
 * Security:
 * - All paths are resolved against a provided delivery root directory.
 * - Path traversal attacks are prevented by verifying the resolved path
 *   stays within the stage evidence directory.
 * - Existing non-empty evidence files are never overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Manifest as ManifestSchema } from './schemas.js';
import { computeCanonicalJsonDigest } from './canonical-digest.js';
// ── Symlink detection ──────────────────────────────────────────────────────────
/**
 * Check that a resolved path stays within the project root boundary.
 * Returns the normalized path if safe, or null if the path escapes the project root
 * or traverses through a symlink.
 *
 * This rejects:
 *  - Path traversal via ".." components
 *  - Any symbolic-link component along the target path, including links that
 *    resolve within the project root
 *  - Symlinks in any existing parent directory (even if the target file does not exist)
 *
 * It does NOT reject Windows 8.3 short-name aliases or benign directory junctions
 * that are not reported as symbolic links by lstat.
 */
function checkPathWithinProject(targetPath, projectRoot) {
    const normalizedTarget = path.normalize(path.resolve(targetPath));
    const normalizedRoot = path.normalize(path.resolve(projectRoot));
    const realRoot = fs.realpathSync(projectRoot);
    // Check every existing ancestor directory for symlinks.
    // This catches symlink escapes even when the target file itself doesn't exist.
    let current = normalizedTarget;
    const rootParts = normalizedRoot.split(path.sep);
    while (current.length >= normalizedRoot.length) {
        try {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink()) {
                // Reject every symbolic link, even when it resolves within the project root.
                return null;
            }
        }
        catch {
            // Path component doesn't exist yet — that's fine, continue checking existing parents
        }
        // Move to parent directory
        const parent = path.dirname(current);
        if (parent === current)
            break; // reached filesystem root
        current = parent;
    }
    // Final check: try realpath on the complete path (handles symlink in the final component)
    try {
        const realTarget = fs.realpathSync(targetPath);
        if (!realTarget.startsWith(realRoot + path.sep) && realTarget !== realRoot) {
            return null;
        }
        return realTarget;
    }
    catch {
        // Target file doesn't exist — we've already checked parents above.
        // Use normalized path; symlink escape through parents has been rejected.
        if (!normalizedTarget.startsWith(normalizedRoot + path.sep) && normalizedTarget !== normalizedRoot) {
            return null;
        }
        return normalizedTarget;
    }
}
// ── Evidence skeleton template ─────────────────────────────────────────────────
/**
 * Generate the standard Markdown skeleton for a Slice Evidence file.
 */
function generateEvidenceSkeleton(sliceId, stageId, sliceGoal, publicSeam, manifestDigest) {
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
// ── Path pattern validation ────────────────────────────────────────────────────
/**
 * Expected evidence path pattern.
 * Must be exactly: delivery/stages/<stage-id>/evidence/<slice-id>.md
 */
const EVIDENCE_PATH_PATTERN = /^delivery\/stages\/(S\d[\w-]*)\/evidence\/(S\d{2,}-[A-Z])\.md$/;
/**
 * Validate that a slice's evidence_path matches the canonical pattern.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateEvidencePathPattern(evidencePath, stageId, sliceId) {
    const match = evidencePath.match(EVIDENCE_PATH_PATTERN);
    if (!match) {
        return `Evidence path "${evidencePath}" does not match expected pattern "delivery/stages/<stage-id>/evidence/<slice-id>.md"`;
    }
    if (match[1] !== stageId) {
        return `Evidence path "${evidencePath}" has stage ID "${match[1]}" but manifest stage_id is "${stageId}"`;
    }
    if (match[2] !== sliceId) {
        return `Evidence path "${evidencePath}" has slice ID "${match[2]}" but slice slice_id is "${sliceId}"`;
    }
    return null;
}
// ── Main initializer ───────────────────────────────────────────────────────────
/**
 * Initialize Slice Evidence files for all slices in a compiled Manifest.
 *
 * For each slice:
 * 1. Validate that the evidence_path matches the canonical pattern.
 * 2. Resolve the evidence path relative to deliveryRoot.
 * 3. Verify the resolved path stays within the stage evidence directory (anti-traversal).
 * 4. If the file already exists and has non-whitespace content, skip it.
 * 5. Otherwise, write the skeleton.
 *
 * Returns a summary of created, skipped, and errored paths.
 */
export function initializeSliceEvidence(options) {
    const { manifest, deliveryRoot = process.cwd() } = options;
    const created = [];
    const skipped = [];
    const errors = [];
    // Compute canonical manifest digest using the existing stable-serialization mechanism.
    // This recursively sorts all object keys so the digest represents the full manifest structure.
    // Fail closed: if digest computation fails, return errors without writing any skeleton files.
    let manifestDigest;
    try {
        manifestDigest = computeCanonicalJsonDigest(ManifestSchema, manifest);
    }
    catch (err) {
        errors.push(`Manifest digest computation failed: ${err instanceof Error ? err.message : String(err)}`);
        return { created, skipped, errors };
    }
    // Pre-compute canonical evidence directory
    const canonicalEvidenceDir = path.resolve(deliveryRoot, 'delivery', 'stages', manifest.stage_id, 'evidence');
    for (const slice of manifest.slices) {
        const evidencePath = slice.evidence_path;
        // ── Validate evidence_path exists ──
        if (!evidencePath) {
            errors.push(`Slice "${slice.slice_id}" has no evidence_path in manifest`);
            continue;
        }
        // ── Validate evidence_path matches canonical pattern ──
        const patternError = validateEvidencePathPattern(evidencePath, manifest.stage_id, slice.slice_id);
        if (patternError) {
            errors.push(patternError);
            continue;
        }
        // ── Path traversal protection ──
        // Resolve the evidence path relative to deliveryRoot, then verify the resolved
        // directory is exactly the canonical evidence directory.
        const resolvedPath = path.resolve(deliveryRoot, evidencePath);
        const resolvedDir = path.dirname(resolvedPath);
        if (resolvedDir !== canonicalEvidenceDir) {
            errors.push(`Slice "${slice.slice_id}" evidence_path "${evidencePath}" resolves to "${resolvedPath}" ` +
                `which is outside the stage evidence directory "${canonicalEvidenceDir}". ` +
                `This may be a path traversal attempt.`);
            continue;
        }
        // ── Path boundary check ──
        // Verify the resolved path stays within the project delivery root.
        // This prevents path traversal and symlink-based attacks.
        const checkResult = checkPathWithinProject(resolvedPath, path.resolve(deliveryRoot));
        if (checkResult === null) {
            errors.push(`Slice "${slice.slice_id}" evidence path "${resolvedPath}" escapes the project root. ` +
                `Path traversal and symlink-based attacks are rejected.`);
            continue;
        }
        // ── Existing file check (non-empty → skip, empty → overwrite) ──
        // Use stat to check existence without following symlinks (lstat),
        // but we've already rejected symlinks above via realpath check.
        if (fs.existsSync(resolvedPath)) {
            const stat = fs.lstatSync(resolvedPath);
            if (stat.isSymbolicLink()) {
                errors.push(`Slice "${slice.slice_id}" evidence path "${resolvedPath}" is a symlink. Refusing to overwrite.`);
                continue;
            }
            const content = fs.readFileSync(resolvedPath, 'utf-8');
            if (content.trim().length > 0) {
                // Non-empty evidence exists — do not overwrite
                skipped.push(resolvedPath);
                continue;
            }
            // Empty file — remove it first, then create exclusively
            try {
                fs.unlinkSync(resolvedPath);
            }
            catch {
                errors.push(`Slice "${slice.slice_id}" cannot remove empty file "${resolvedPath}" for exclusive create.`);
                continue;
            }
        }
        // ── Ensure directory exists ──
        try {
            fs.mkdirSync(canonicalEvidenceDir, { recursive: true });
        }
        catch (err) {
            errors.push(`Slice "${slice.slice_id}" cannot create evidence directory "${canonicalEvidenceDir}": ` +
                `${err instanceof Error ? err.message : String(err)}`);
            continue;
        }
        // ── Write evidence skeleton using exclusive create (wx flag) ──
        // This eliminates TOCTOU by failing if the file was created between our check and write.
        const skeleton = generateEvidenceSkeleton(slice.slice_id, manifest.stage_id, slice.goal, slice.public_seam, manifestDigest);
        try {
            fs.writeFileSync(resolvedPath, skeleton, { encoding: 'utf-8', flag: 'wx' });
            created.push(resolvedPath);
        }
        catch (err) {
            if (err.code === 'EEXIST') {
                // File was created between our check and write — TOCTOU prevented
                // Read the existing content and treat it as a skip
                try {
                    const existing = fs.readFileSync(resolvedPath, 'utf-8');
                    if (existing.trim().length > 0) {
                        skipped.push(resolvedPath);
                    }
                    else {
                        errors.push(`Slice "${slice.slice_id}" race: empty file created concurrently at "${resolvedPath}".`);
                    }
                }
                catch {
                    errors.push(`Slice "${slice.slice_id}" TOCTOU race writing evidence file "${resolvedPath}".`);
                }
            }
            else {
                errors.push(`Slice "${slice.slice_id}" failed to write evidence file "${resolvedPath}": ` +
                    `${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    return { created, skipped, errors };
}
// ── CLI entry point ────────────────────────────────────────────────────────────
/**
 * CLI usage:
 * ```
 * node dist/initialize-slice-evidence.js <manifest-path> [delivery-root]
 * ```
 *
 * The manifest-path must point to a compiled JSON manifest file.
 * The delivery-root defaults to process.cwd().
 *
 * Exit codes:
 *   0 = all evidence files created (or skipped existing)
 *   1 = some errors occurred
 */
function isScriptEntry() {
    const scriptPath = process.argv[1];
    if (!scriptPath)
        return false;
    const base = path.basename(scriptPath);
    return base === 'initialize-slice-evidence.js' || base === 'initialize-slice-evidence.ts';
}
if (isScriptEntry()) {
    const manifestPath = process.argv[2];
    const deliveryRoot = process.argv[3] || process.cwd();
    if (!manifestPath) {
        console.error('Usage: node initialize-slice-evidence.js <manifest-path> [delivery-root]');
        process.exit(1);
    }
    let manifest;
    try {
        const content = fs.readFileSync(manifestPath, 'utf-8');
        const parsed = JSON.parse(content);
        manifest = ManifestSchema.parse(parsed);
    }
    catch (err) {
        console.error(`Failed to load manifest: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
    const result = initializeSliceEvidence({ manifest, deliveryRoot });
    for (const created of result.created) {
        console.log(`Created: ${created}`);
    }
    for (const skipped of result.skipped) {
        console.log(`Skipped (existing): ${skipped}`);
    }
    for (const err of result.errors) {
        console.error(`Error: ${err}`);
    }
    if (result.errors.length > 0) {
        process.exit(1);
    }
    process.exit(0);
}
//# sourceMappingURL=initialize-slice-evidence.js.map