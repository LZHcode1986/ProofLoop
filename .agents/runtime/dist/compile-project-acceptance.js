#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProjectAcceptanceManifestSchema } from './schemas.js';
import { computeSnapshot } from './receipt-writer.js';
const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
    console.error('Usage: node compile-project-acceptance.js <input-json-path> <output-manifest-path>');
    process.exit(1);
}
if (!existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    process.exit(1);
}
let input;
try {
    input = JSON.parse(readFileSync(inputPath, 'utf-8'));
}
catch (err) {
    console.error(`Invalid input JSON: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
}
if (!input.project_root) {
    console.error('Input must contain "project_root" field');
    process.exit(1);
}
if (!existsSync(input.project_root)) {
    console.error(`Project root not found: ${input.project_root}`);
    process.exit(1);
}
const expected_snapshot = computeSnapshot(resolve(input.project_root)).slice(0, 16);
if (!input.stage_receipts || !Array.isArray(input.stage_receipts) || input.stage_receipts.length === 0) {
    console.error('Input must contain "stage_receipts" array with at least one entry');
    process.exit(1);
}
const manifest = {
    project_id: input.project_id,
    expected_snapshot,
    prd_goals: input.prd_goals ?? [],
    acceptance_criteria: input.acceptance_criteria ?? [],
    stage_receipts: input.stage_receipts,
    e2e_steps: input.e2e_steps ?? [],
    compiled_at: new Date().toISOString(),
};
try {
    ProjectAcceptanceManifestSchema.parse(manifest);
}
catch (err) {
    console.error('Generated manifest failed Schema validation:');
    if (err instanceof Error) {
        console.error(err.message);
    }
    process.exit(1);
}
writeFileSync(outputPath, JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`Project Acceptance Manifest written to ${outputPath}`);
console.log(`Expected snapshot: ${expected_snapshot}`);
//# sourceMappingURL=compile-project-acceptance.js.map