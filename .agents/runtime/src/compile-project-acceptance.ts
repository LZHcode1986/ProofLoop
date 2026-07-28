#!/usr/bin/env node
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { computeSnapshot } from './receipt-writer.js';

const [outputPath, projectRoot, e2eStepsJson] = process.argv.slice(2);

if (!outputPath || !projectRoot || !e2eStepsJson) {
  console.error('Usage: node compile-project-acceptance.js <output-path> <project-root> <e2e-steps-json>');
  process.exit(1);
}

if (!existsSync(projectRoot)) {
  console.error(`Project root not found: ${projectRoot}`);
  process.exit(1);
}

let e2eSteps;
try {
  e2eSteps = JSON.parse(e2eStepsJson);
} catch {
  console.error('E2E steps JSON is invalid');
  process.exit(1);
}

const snapshot = computeSnapshot(resolve(projectRoot)).slice(0, 16);

const manifest = {
  project_id: 'project-1',
  expected_snapshot: snapshot,
  prd_goals: ['Complete the ProofLoop v2 restructuring'],
  acceptance_criteria: ['All P0 issues resolved', 'CI passes on all platforms'],
  stage_review_receipts: [],
  e2e_steps: e2eSteps,
  compiled_at: new Date().toISOString(),
};

writeFileSync(outputPath, JSON.stringify(manifest, null, 2), 'utf-8');
console.log(`Project Acceptance Manifest written to ${outputPath}`);
console.log(`Expected snapshot: ${snapshot}`);
