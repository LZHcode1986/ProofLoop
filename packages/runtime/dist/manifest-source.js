"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManifestSourceError = void 0;
exports.defaultManifestPath = defaultManifestPath;
exports.canonicalManifestJson = canonicalManifestJson;
exports.canonicalManifestDigest = canonicalManifestDigest;
exports.manifestFileDigest = manifestFileDigest;
exports.manifestSource = manifestSource;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const kernel_1 = require("@proofloop/kernel");
/**
 * Structured manifest-source-unavailable condition (PO-S02-C-02): missing /
 * unreadable / parse-failed / schema-invalid / stage_id-mismatched manifest
 * → the canonical code DOMAIN.STAGE_NOT_FOUND.
 */
class ManifestSourceError extends Error {
    code = 'DOMAIN.STAGE_NOT_FOUND';
    source = 'manifest';
    reason;
    constructor(message) {
        super(message);
        this.name = 'ManifestSourceError';
        this.reason = message;
    }
}
exports.ManifestSourceError = ManifestSourceError;
/** Canonical manifest path: `<projectRoot>/.proofloop/manifests/<stage>.json`. */
function defaultManifestPath(projectRoot, stageId) {
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
function sortKeys(value) {
    if (value === null || typeof value !== 'object')
        return value;
    if (Array.isArray(value))
        return value.map(sortKeys);
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
        sorted[key] = sortKeys(value[key]);
    }
    return sorted;
}
/** Canonical JSON string of a parsed manifest (recursively sorted keys). */
function canonicalManifestJson(value) {
    return JSON.stringify(sortKeys(value));
}
/**
 * Canonical content digest of a parsed manifest: SHA-256 over the canonical
 * JSON representation (64-hex). This is the runtime's canonical digest
 * computation for the `admitStagePlan` manifest lifecycle binding
 * (PO-S02-E-07) — the request's `manifestDigest` must equal this value for
 * the stage-plan admit to be accepted.
 */
function canonicalManifestDigest(value) {
    return (0, node_crypto_1.createHash)('sha256').update(canonicalManifestJson(value), 'utf-8').digest('hex');
}
/**
 * Read the canonical stage manifest file and compute its canonical digest
 * (PO-S02-E-07 binding source). Reads the same canonical path as
 * `manifestSource`; a missing / unreadable / parse-failed file throws the
 * structured `ManifestSourceError` (DOMAIN.STAGE_NOT_FOUND) — never a guess.
 */
function manifestFileDigest(input) {
    const { projectRoot, stageId } = input;
    const manifestPath = input.manifestPath ?? defaultManifestPath(projectRoot, stageId);
    let raw;
    try {
        raw = fs.readFileSync(manifestPath, 'utf-8');
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new ManifestSourceError(`manifest not found or unreadable at ${manifestPath}: ${reason}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new ManifestSourceError(`manifest at ${manifestPath} is not valid JSON: ${reason}`);
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
function manifestSource(input) {
    const { projectRoot, stageId } = input;
    const manifestPath = input.manifestPath ?? defaultManifestPath(projectRoot, stageId);
    let raw;
    try {
        raw = fs.readFileSync(manifestPath, 'utf-8');
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new ManifestSourceError(`manifest not found or unreadable at ${manifestPath}: ${reason}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new ManifestSourceError(`manifest at ${manifestPath} is not valid JSON: ${reason}`);
    }
    let manifest;
    try {
        manifest = (0, kernel_1.validateManifest)(parsed);
    }
    catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new ManifestSourceError(`manifest at ${manifestPath} failed schema validation: ${reason}`);
    }
    if (manifest.stage_id !== stageId) {
        throw new ManifestSourceError(`manifest stage_id "${manifest.stage_id}" does not match input stage_id "${stageId}"`);
    }
    return { manifest, manifest_path: manifestPath };
}
//# sourceMappingURL=manifest-source.js.map