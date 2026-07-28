#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProjectAcceptanceManifestSchema, ProjectE2EReceiptSchema, StageReviewReceiptSchema, StageGateReceipt, ProjectReviewResultSchema, } from './schemas.js';
import { writeProjectReviewReceipt } from './receipt-writer.js';
import { computeCanonicalJsonDigest } from './canonical-digest.js';
function computeFileDigest(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 16);
}
function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}
function exitError(errors) {
    console.error(JSON.stringify({ success: false, errors }, null, 2));
    process.exit(1);
}
const [inputJson] = process.argv.slice(2);
if (!inputJson) {
    console.error('Usage: node finalize-project-review.js <input-json-path>');
    process.exit(1);
}
let input;
try {
    input = JSON.parse(fs.readFileSync(inputJson, 'utf-8'));
}
catch {
    exitError(['Cannot parse input JSON']);
}
const errors = [];
// ── 1. Read & validate Project Manifest ───────────────────────────────────────────────────
if (!fs.existsSync(input.manifestPath)) {
    exitError([`Manifest not found: ${input.manifestPath}`]);
}
let manifestRaw;
let manifest;
try {
    manifestRaw = readJson(input.manifestPath);
    manifest = ProjectAcceptanceManifestSchema.parse(manifestRaw);
}
catch (err) {
    exitError([`Invalid Project Manifest: ${err instanceof Error ? err.message : String(err)}`]);
}
const manifestFileDigest = computeFileDigest(input.manifestPath);
const manifestDigest = computeCanonicalJsonDigest(ProjectAcceptanceManifestSchema, manifestRaw);
// ── 2. Read & validate Project E2E Receipt ─────────────────────────────────────────────────
if (!fs.existsSync(input.e2eReceiptPath)) {
    exitError([`E2E Receipt not found: ${input.e2eReceiptPath}`]);
}
let e2e;
try {
    e2e = ProjectE2EReceiptSchema.parse(readJson(input.e2eReceiptPath));
}
catch (err) {
    exitError([`Invalid E2E Receipt: ${err instanceof Error ? err.message : String(err)}`]);
}
const e2eFileDigest = computeFileDigest(input.e2eReceiptPath);
if (e2e.verdict !== 'PASS')
    errors.push(`E2E verdict is "${e2e.verdict}", expected "PASS"`);
if (e2e.project_id !== manifest.project_id)
    errors.push(`E2E project_id "${e2e.project_id}" != Manifest "${manifest.project_id}"`);
if (e2e.manifest_digest !== manifestDigest)
    errors.push(`E2E manifest_digest "${e2e.manifest_digest}" != computed "${manifestDigest}"`);
if (e2e.expected_snapshot !== manifest.expected_snapshot)
    errors.push(`E2E expected_snapshot "${e2e.expected_snapshot}" != Manifest "${manifest.expected_snapshot}"`);
if (e2e.executed_snapshot !== manifest.expected_snapshot)
    errors.push(`E2E executed_snapshot "${e2e.executed_snapshot}" != Manifest "${manifest.expected_snapshot}"`);
const nonSkippedSteps = e2e.steps.filter(s => !s.skipped);
if (nonSkippedSteps.length === 0)
    errors.push('E2E has zero non-skipped steps');
// ── 3. Read independent Project Reviewer result ────────────────────────────────────────────
if (!fs.existsSync(input.reviewerResultPath)) {
    exitError([`Reviewer result not found: ${input.reviewerResultPath}`]);
}
let reviewerResultRaw;
let reviewerResult;
try {
    reviewerResultRaw = readJson(input.reviewerResultPath);
    reviewerResult = ProjectReviewResultSchema.parse(reviewerResultRaw);
}
catch (err) {
    exitError([`Invalid Project Reviewer result: ${err instanceof Error ? err.message : String(err)}`]);
}
// Validate Reviewer result fields
if (reviewerResult.verdict !== 'PROJECT_ACCEPTED') {
    errors.push(`Reviewer verdict is "${reviewerResult.verdict}", expected "PROJECT_ACCEPTED"`);
}
if (reviewerResult.reviewed_snapshot !== manifest.expected_snapshot) {
    errors.push(`Reviewer reviewed_snapshot "${reviewerResult.reviewed_snapshot}" != Manifest "${manifest.expected_snapshot}"`);
}
if (reviewerResult.project_manifest.digest !== manifestDigest) {
    errors.push(`Reviewer project_manifest.digest "${reviewerResult.project_manifest.digest}" != computed manifest digest "${manifestDigest}"`);
}
// Verify the file at reviewer's claimed e2e receipt path matches its declared digest
if (!fs.existsSync(reviewerResult.project_e2e_receipt.path)) {
    errors.push(`Reviewer e2e receipt path not found: ${reviewerResult.project_e2e_receipt.path}`);
}
else {
    const reviewerE2eFileDigest = computeFileDigest(reviewerResult.project_e2e_receipt.path);
    if (reviewerE2eFileDigest !== reviewerResult.project_e2e_receipt.digest) {
        errors.push(`Reviewer e2e receipt file digest "${reviewerE2eFileDigest}" != declared "${reviewerResult.project_e2e_receipt.digest}"`);
    }
    // Ensure Reviewer references the same E2E file as we have
    if (reviewerE2eFileDigest !== e2eFileDigest) {
        errors.push(`Reviewer e2e receipt file digest "${reviewerE2eFileDigest}" != actual E2E file digest "${e2eFileDigest}"`);
    }
}
// ── 4. From Manifest read all Stage evidence (single authoritative path) ───────────────────
const stageReceiptResults = [];
if (manifest.stage_receipts.length === 0) {
    errors.push('Manifest has zero stage_receipts entries');
}
for (const ms of manifest.stage_receipts) {
    const sid = ms.stage_id;
    // a. Verify stage_manifest file exists and digest matches
    if (!fs.existsSync(ms.stage_manifest.path)) {
        errors.push(`Stage manifest file not found for ${sid}: ${ms.stage_manifest.path}`);
    }
    else {
        const stageManifestDigest = computeFileDigest(ms.stage_manifest.path);
        if (stageManifestDigest !== ms.stage_manifest.digest) {
            errors.push(`Stage manifest for ${sid}: file digest "${stageManifestDigest}" != declared "${ms.stage_manifest.digest}"`);
        }
    }
    // b. Read & Schema parse StageReviewReceipt
    if (!fs.existsSync(ms.review_receipt.path)) {
        errors.push(`Review receipt not found for stage ${sid}: ${ms.review_receipt.path}`);
        continue;
    }
    let review;
    try {
        review = StageReviewReceiptSchema.parse(readJson(ms.review_receipt.path));
    }
    catch (err) {
        errors.push(`Invalid Stage Review for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
    }
    // c. Read & Schema parse StageGateReceipt
    if (!fs.existsSync(ms.gate_receipt.path)) {
        errors.push(`Gate receipt not found for stage ${sid}: ${ms.gate_receipt.path}`);
        continue;
    }
    let gate;
    try {
        gate = StageGateReceipt.parse(readJson(ms.gate_receipt.path));
    }
    catch (err) {
        errors.push(`Invalid Stage Gate for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
    }
    // d. Cross-validation
    if (review.stage_id !== sid)
        errors.push(`Review stage_id "${review.stage_id}" != manifest entry "${sid}"`);
    if (gate.stage_id !== sid)
        errors.push(`Gate stage_id "${gate.stage_id}" != manifest entry "${sid}"`);
    if (review.stage_id !== gate.stage_id)
        errors.push(`Review stage "${review.stage_id}" != Gate stage "${gate.stage_id}"`);
    if (review.verdict !== 'ACCEPTED')
        errors.push(`Review for ${sid} verdict is "${review.verdict}", expected "ACCEPTED"`);
    if (gate.verdict !== 'PASS')
        errors.push(`Gate for ${sid} verdict is "${gate.verdict}", expected "PASS"`);
    // Snapshot consistency
    if (review.snapshot !== gate.snapshot)
        errors.push(`Review snapshot "${review.snapshot}" != Gate snapshot "${gate.snapshot}" for ${sid}`);
    // Triple-binding: review.stage_gate_receipt.path file digest === review.stage_gate_receipt.digest
    if (!fs.existsSync(review.stage_gate_receipt.path)) {
        errors.push(`Review's stage_gate_receipt path not found for ${sid}: ${review.stage_gate_receipt.path}`);
    }
    else {
        const reviewGateFileDigest = computeFileDigest(review.stage_gate_receipt.path);
        if (reviewGateFileDigest !== review.stage_gate_receipt.digest) {
            errors.push(`Review for ${sid}: gate file digest "${reviewGateFileDigest}" != review declared "${review.stage_gate_receipt.digest}"`);
        }
        // Triple-binding: file digest === manifest's gate_receipt.digest
        if (reviewGateFileDigest !== ms.gate_receipt.digest) {
            errors.push(`Review for ${sid}: gate file digest "${reviewGateFileDigest}" != manifest gate_receipt.digest "${ms.gate_receipt.digest}" (triple binding)`);
        }
    }
    // Review file actual digest matches manifest's declared review digest
    const reviewFileDigest = computeFileDigest(ms.review_receipt.path);
    if (reviewFileDigest !== ms.review_receipt.digest) {
        errors.push(`Review file for ${sid}: actual digest "${reviewFileDigest}" != declared "${ms.review_receipt.digest}"`);
    }
    // Gate file actual digest matches manifest's declared gate digest
    const gateFileDigest = computeFileDigest(ms.gate_receipt.path);
    if (gateFileDigest !== ms.gate_receipt.digest) {
        errors.push(`Gate file for ${sid}: actual digest "${gateFileDigest}" != declared "${ms.gate_receipt.digest}"`);
    }
    stageReceiptResults.push({
        stage_id: sid,
        review: { path: path.resolve(ms.review_receipt.path), digest: reviewFileDigest },
        gate: { path: path.resolve(ms.gate_receipt.path), digest: gateFileDigest },
        snapshot: review.snapshot,
    });
}
// ── 5. Validate criteria one-to-one coverage ───────────────────────────────────────────────
const manifestCriteria = new Set(manifest.acceptance_criteria.map(c => c.trim()));
const resultCriteria = new Set(reviewerResult.criteria_results.map(c => c.criteria.trim()));
for (const mc of manifestCriteria) {
    if (!resultCriteria.has(mc))
        errors.push(`Missing criteria result for: "${mc}"`);
}
for (const rc of resultCriteria) {
    if (!manifestCriteria.has(rc))
        errors.push(`Extra criteria result not in Manifest: "${rc}"`);
}
if (!reviewerResult.criteria_results.every(c => c.passed)) {
    errors.push('Not all criteria results are passed');
}
// ── 6. Validate Reviewer-referenced manifest and e2e paths/digests ─────────────────────────
// reviewer_result.project_manifest.path file digest === manifestFileDigest
if (fs.existsSync(reviewerResult.project_manifest.path)) {
    const reviewerManifestFileDigest = computeFileDigest(reviewerResult.project_manifest.path);
    if (reviewerManifestFileDigest !== manifestFileDigest) {
        errors.push(`Reviewer manifest path file digest "${reviewerManifestFileDigest}" != actual manifest digest "${manifestFileDigest}"`);
    }
}
else {
    errors.push(`Reviewer manifest path not found: ${reviewerResult.project_manifest.path}`);
}
// reviewer_result.project_e2e_receipt.path file digest === e2eFileDigest
if (fs.existsSync(reviewerResult.project_e2e_receipt.path)) {
    const reviewerE2ePathDigest = computeFileDigest(reviewerResult.project_e2e_receipt.path);
    if (reviewerE2ePathDigest !== e2eFileDigest) {
        errors.push(`Reviewer e2e path file digest "${reviewerE2ePathDigest}" != actual e2e digest "${e2eFileDigest}"`);
    }
}
else {
    errors.push(`Reviewer e2e path not found: ${reviewerResult.project_e2e_receipt.path}`);
}
// ── 7. Fail if any errors ──────────────────────────────────────────────────────────────────
if (errors.length > 0)
    exitError(errors);
// ── 8. All checks passed — write PROJECT_ACCEPTED (inheriting from Reviewer) ───────────────
const receiptPath = writeProjectReviewReceipt(input.outputDir, {
    project_id: manifest.project_id,
    verdict: 'PROJECT_ACCEPTED',
    snapshot: manifest.expected_snapshot,
    reviewer: reviewerResult.reviewer,
    findings: reviewerResult.findings,
    accepted_deviations: reviewerResult.accepted_deviations,
    project_manifest: { path: path.resolve(input.manifestPath), digest: manifestFileDigest },
    project_e2e_receipt: { path: path.resolve(input.e2eReceiptPath), digest: e2eFileDigest },
    stage_receipts: stageReceiptResults,
    criteria_results: reviewerResult.criteria_results,
});
console.log(JSON.stringify({ success: true, receiptPath }, null, 2));
//# sourceMappingURL=finalize-project-review.js.map