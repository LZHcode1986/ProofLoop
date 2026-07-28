#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProjectAcceptanceManifestSchema, ProjectE2EReceiptSchema, StageReviewReceiptSchema, StageGateReceipt, } from './schemas.js';
import { writeProjectReviewReceipt } from './receipt-writer.js';
function computeFileDigest(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 16);
}
/**
 * Compute the manifest digest the same way as run-stage.ts:
 * parse with Zod (so defaults like type:"command" are populated),
 * then stringify with JSON.stringify(obj, null, 2).
 */
function computeManifestDigest(filePath) {
    const raw = readJson(filePath);
    const parsed = ProjectAcceptanceManifestSchema.parse(raw);
    return crypto.createHash('sha256').update(JSON.stringify(parsed, null, 2)).digest('hex').slice(0, 16);
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
// ── 1. Validate Project Manifest ────────────────────────────────────────────────
if (!fs.existsSync(input.manifestPath)) {
    exitError([`Manifest not found: ${input.manifestPath}`]);
}
let manifest;
try {
    manifest = ProjectAcceptanceManifestSchema.parse(readJson(input.manifestPath));
}
catch (err) {
    exitError([`Invalid Project Manifest: ${err instanceof Error ? err.message : String(err)}`]);
}
const manifestFileDigest = computeManifestDigest(input.manifestPath);
// ── 2. Validate Project E2E Receipt ─────────────────────────────────────────────
if (!fs.existsSync(input.e2eReceiptPath)) {
    errors.push(`E2E Receipt not found: ${input.e2eReceiptPath}`);
}
else {
    let e2e;
    try {
        e2e = ProjectE2EReceiptSchema.parse(readJson(input.e2eReceiptPath));
    }
    catch (err) {
        errors.push(`Invalid E2E Receipt: ${err instanceof Error ? err.message : String(err)}`);
        exitError(errors);
    }
    const e2eDigest = computeFileDigest(input.e2eReceiptPath);
    if (e2e.verdict !== 'PASS')
        errors.push(`E2E verdict is "${e2e.verdict}", expected "PASS"`);
    if (e2e.project_id !== manifest.project_id)
        errors.push(`E2E project_id "${e2e.project_id}" != Manifest "${manifest.project_id}"`);
    if (e2e.manifest_digest !== manifestFileDigest)
        errors.push(`E2E manifest_digest "${e2e.manifest_digest}" != actual "${manifestFileDigest}"`);
    if (e2e.expected_snapshot !== manifest.expected_snapshot)
        errors.push(`E2E expected_snapshot "${e2e.expected_snapshot}" != Manifest "${manifest.expected_snapshot}"`);
    if (e2e.executed_snapshot !== manifest.expected_snapshot)
        errors.push(`E2E executed_snapshot "${e2e.executed_snapshot}" != Manifest "${manifest.expected_snapshot}"`);
    if (e2e.steps.length === 0)
        errors.push('E2E has zero executed steps');
}
// ── 3. Validate Stage Receipts (pairs) ─────────────────────────────────────────
const manifestStageIds = new Set(manifest.stage_receipts.map(s => s.stage_id));
const inputStageIds = new Set();
const stageReceiptResults = [];
for (const sr of input.stageReceipts) {
    const sid = sr.stage_id;
    if (inputStageIds.has(sid)) {
        errors.push(`Duplicate stage_id in input: "${sid}"`);
        continue;
    }
    inputStageIds.add(sid);
    if (!fs.existsSync(sr.review_receipt)) {
        errors.push(`Review receipt not found for stage ${sid}: ${sr.review_receipt}`);
        continue;
    }
    if (!fs.existsSync(sr.gate_receipt)) {
        errors.push(`Gate receipt not found for stage ${sid}: ${sr.gate_receipt}`);
        continue;
    }
    // Validate Review Receipt with Schema
    let review;
    try {
        review = StageReviewReceiptSchema.parse(readJson(sr.review_receipt));
    }
    catch (err) {
        errors.push(`Invalid Stage Review for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
    }
    // Validate Gate Receipt with Schema
    let gate;
    try {
        gate = StageGateReceipt.parse(readJson(sr.gate_receipt));
    }
    catch (err) {
        errors.push(`Invalid Stage Gate for ${sid}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
    }
    // Cross-validation
    if (review.stage_id !== sid)
        errors.push(`Review stage_id "${review.stage_id}" != input "${sid}"`);
    if (gate.stage_id !== sid)
        errors.push(`Gate stage_id "${gate.stage_id}" != input "${sid}"`);
    if (review.stage_id !== gate.stage_id)
        errors.push(`Review stage "${review.stage_id}" != Gate stage "${gate.stage_id}"`);
    if (review.verdict !== 'ACCEPTED')
        errors.push(`Review for ${sid} verdict is "${review.verdict}", expected ACCEPTED`);
    if (gate.verdict !== 'PASS')
        errors.push(`Gate for ${sid} verdict is "${gate.verdict}", expected PASS`);
    // Verify Review's claimed Gate digest matches actual Gate file
    const actualGateDigest = computeFileDigest(sr.gate_receipt);
    if (review.stage_gate_receipt.digest !== actualGateDigest) {
        errors.push(`Review for ${sid} claims gate digest "${review.stage_gate_receipt.digest}" but actual is "${actualGateDigest}"`);
    }
    // Snapshots
    if (review.snapshot !== gate.snapshot)
        errors.push(`Review snapshot "${review.snapshot}" != Gate snapshot "${gate.snapshot}" for ${sid}`);
    stageReceiptResults.push({
        stage_id: sid,
        review: { path: path.resolve(sr.review_receipt), digest: computeFileDigest(sr.review_receipt) },
        gate: { path: path.resolve(sr.gate_receipt), digest: actualGateDigest },
        snapshot: review.snapshot,
    });
}
// ── 4. Verify input stage set matches Manifest stage set ────────────────────────
for (const ms of manifestStageIds) {
    if (!inputStageIds.has(ms))
        errors.push(`Stage "${ms}" is in Manifest but missing from finalizer input`);
}
for (const is of inputStageIds) {
    if (!manifestStageIds.has(is))
        errors.push(`Stage "${is}" is in finalizer input but not in Manifest`);
}
// ── 5. Validate criteria cover all Manifest acceptance_criteria ────────────────
const manifestCriteria = new Set(manifest.acceptance_criteria.map(c => c.trim()));
const resultCriteria = new Set(input.criteriaResults.map(c => c.criteria.trim()));
for (const mc of manifestCriteria) {
    if (!resultCriteria.has(mc))
        errors.push(`Missing criteria result for: "${mc}"`);
}
for (const rc of resultCriteria) {
    if (!manifestCriteria.has(rc))
        errors.push(`Extra criteria result not in Manifest: "${rc}"`);
}
if (!input.criteriaResults.every(c => c.passed))
    errors.push('Not all criteria results are passed');
// ── 6. Fail if any errors ───────────────────────────────────────────────────────
if (errors.length > 0)
    exitError(errors);
// ── 7. All checks passed — write PROJECT_ACCEPTED ──────────────────────────────
const receiptPath = writeProjectReviewReceipt({
    outputDir: input.outputDir,
    data: {
        project_id: manifest.project_id,
        verdict: 'PROJECT_ACCEPTED',
        snapshot: manifest.expected_snapshot,
        reviewer: 'finalize-project-review',
        findings: [],
        accepted_deviations: [],
        project_manifest: { path: path.resolve(input.manifestPath), digest: manifestFileDigest },
        project_e2e_receipt: { path: path.resolve(input.e2eReceiptPath), digest: computeFileDigest(input.e2eReceiptPath) },
        stage_receipts: stageReceiptResults,
        criteria_results: input.criteriaResults,
    },
});
console.log(JSON.stringify({ success: true, receiptPath }, null, 2));
//# sourceMappingURL=finalize-project-review.js.map