#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ProjectAcceptanceManifestSchema, ProjectE2EReceiptSchema } from './schemas.js';
import { writeProjectReviewReceipt } from './receipt-writer.js';

function computeFileDigest(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

interface FinalizeInput {
  manifestPath: string;
  e2eReceiptPath: string;
  stageReviewReceiptPaths: string[];
  stageGateReceiptPaths: string[];
  criteriaResults: Array<{ criteria: string; passed: boolean; notes?: string }>;
  outputDir: string;
}

function fail(errors: string[]): never {
  console.error(JSON.stringify({ success: false, errors }, null, 2));
  process.exit(1);
}

const [inputJson] = process.argv.slice(2);
if (!inputJson) {
  console.error('Usage: node finalize-project-review.js <input-json-path>');
  process.exit(1);
}

let input: FinalizeInput;
try {
  input = JSON.parse(fs.readFileSync(inputJson, 'utf-8'));
} catch {
  fail(['Cannot parse input JSON']);
}

const errors: string[] = [];

// 1. Read and validate Project Manifest
if (!fs.existsSync(input.manifestPath)) {
  errors.push(`Manifest file not found: ${input.manifestPath}`);
} else {
  try {
    const manifest = ProjectAcceptanceManifestSchema.parse(
      JSON.parse(fs.readFileSync(input.manifestPath, 'utf-8')),
    );
    const manifestDigest = computeFileDigest(input.manifestPath);
    const declaredDigest = path.basename(input.manifestPath).includes('manifest')
      ? manifest.expected_snapshot
      : null;

    // 2. Read and validate Project E2E Receipt
    if (!fs.existsSync(input.e2eReceiptPath)) {
      errors.push(`E2E Receipt not found: ${input.e2eReceiptPath}`);
    } else {
      const e2eContent = JSON.parse(fs.readFileSync(input.e2eReceiptPath, 'utf-8'));
      const e2eReceipt = ProjectE2EReceiptSchema.parse(e2eContent);
      const e2eDigest = computeFileDigest(input.e2eReceiptPath);

      if (e2eReceipt.verdict !== 'PASS') {
        errors.push(`E2E Gate verdict is "${e2eReceipt.verdict}", expected "PASS"`);
      }
      if (e2eReceipt.expected_snapshot && e2eReceipt.expected_snapshot !== manifest.expected_snapshot) {
        errors.push(`E2E Receipt expected_snapshot "${e2eReceipt.expected_snapshot}" != Manifest expected_snapshot "${manifest.expected_snapshot}"`);
      }
      if (e2eReceipt.executed_snapshot && e2eReceipt.executed_snapshot !== manifest.expected_snapshot) {
        errors.push(`E2E Receipt executed_snapshot "${e2eReceipt.executed_snapshot}" != Manifest expected_snapshot "${manifest.expected_snapshot}"`);
      }
    }

    // 3. Validate Stage Review Receipts
    for (const stagePath of input.stageReviewReceiptPaths) {
      if (!fs.existsSync(stagePath)) {
        errors.push(`Stage Review Receipt not found: ${stagePath}`);
      } else {
        const content = JSON.parse(fs.readFileSync(stagePath, 'utf-8'));
        if (content.verdict !== 'ACCEPTED') {
          errors.push(`Stage Review ${stagePath} verdict is "${content.verdict}", expected "ACCEPTED"`);
        }
        const declaredDigest = content.manifest_digest || content.snapshot;
      }
    }

    // 4. Validate Stage Gate Receipts
    for (const gatePath of input.stageGateReceiptPaths) {
      if (!fs.existsSync(gatePath)) {
        errors.push(`Stage Gate Receipt not found: ${gatePath}`);
      } else {
        const content = JSON.parse(fs.readFileSync(gatePath, 'utf-8'));
        if (content.verdict !== 'PASS') {
          errors.push(`Stage Gate ${gatePath} verdict is "${content.verdict}", expected "PASS"`);
        }
      }
    }

    // 5. Validate criteria cover all Manifest acceptance_criteria
    const manifestCriteria = new Set(manifest.acceptance_criteria.map(c => c.trim()));
    const resultCriteria = new Set(input.criteriaResults.map(c => c.criteria.trim()));

    for (const mc of manifestCriteria) {
      if (!resultCriteria.has(mc)) {
        errors.push(`Missing criteria result for: "${mc}"`);
      }
    }
    for (const rc of resultCriteria) {
      if (!manifestCriteria.has(rc)) {
        errors.push(`Extra criteria result not in Manifest: "${rc}"`);
      }
    }

    const allPassed = input.criteriaResults.every(c => c.passed);
    if (!allPassed) {
      errors.push('Not all criteria results are passed');
    }
  } catch (err) {
    errors.push(`Manifest validation error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (errors.length > 0) {
  console.error(JSON.stringify({ success: false, errors }, null, 2));
  process.exit(1);
}

// All checks passed — write PROJECT_ACCEPTED
const manifest = JSON.parse(fs.readFileSync(input.manifestPath, 'utf-8'));
const e2eContent = JSON.parse(fs.readFileSync(input.e2eReceiptPath, 'utf-8'));

const receiptPath = writeProjectReviewReceipt({
  outputDir: input.outputDir,
  data: {
    project_id: manifest.project_id,
    verdict: 'PROJECT_ACCEPTED',
    snapshot: manifest.expected_snapshot,
    reviewer: 'project-review-finalizer',
    project_manifest: { path: path.resolve(input.manifestPath), digest: computeFileDigest(input.manifestPath) },
    project_e2e_receipt: { path: path.resolve(input.e2eReceiptPath), digest: computeFileDigest(input.e2eReceiptPath) },
    stage_review_receipts: input.stageReviewReceiptPaths.map(p => path.resolve(p)),
    stage_gate_receipts: input.stageGateReceiptPaths.map(p => path.resolve(p)),
    criteria_results: input.criteriaResults,
  },
});

console.log(JSON.stringify({ success: true, receiptPath }, null, 2));
