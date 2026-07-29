/**
 * fixture-check.mjs
 *
 * Advanced CLI wrapper for CI fixture validation.
 * Compiles the manifest and validates the checked-in evidence skeletons
 * against the declared manifest paths. This command is strictly read-only.
 *
 * Usage:
 *   node scripts/fixture-check.mjs <path-to-tasks.md> [delivery-root]
 *
 * If delivery-root is omitted, the fixture sandbox root containing
 * delivery/stages/<stage-id>/ is inferred.
 *
 * Exits:
 *   0 — fixture is structurally valid with matching evidence
 *   1 — fixture has validation errors
 */

import { compileManifest } from '../dist/compile-manifest.js';
import { validateStage, validateStageWithManifest } from '../dist/validate-stage.js';
import path from 'node:path';
import fs from 'node:fs';

const tasksPath = process.argv[2];

if (!tasksPath) {
  console.error('Usage: node scripts/fixture-check.mjs <tasks.md-path> [delivery-root]');
  process.exit(1);
}

// Determine fixture sandbox root. Canonical fixtures are laid out as
// <fixture>/delivery/stages/<stage-id>/tasks.md and are never mutated here.
const resolvedTasksPath = path.resolve(tasksPath);
const tasksDir = path.dirname(resolvedTasksPath);
const inferredRoot = path.basename(path.dirname(tasksDir)) === 'stages' &&
  path.basename(path.dirname(path.dirname(tasksDir))) === 'delivery'
  ? path.resolve(tasksDir, '..', '..', '..')
  : tasksDir;
const deliveryRoot = path.resolve(process.argv[3] || inferredRoot);

// Step 1: Structural validation (old-style, checks tasks.md structure)
console.log(`\n--- Step 1: Structural validateStage ---`);
const structuralResult = validateStage(tasksPath);
if (!structuralResult.valid) {
  console.error(`✗ ${structuralResult.stageId}: Structural validation failed`);
  for (const err of structuralResult.errors) {
    console.error(`  - [${err.type}] ${err.message}${err.sliceId ? ` (slice: ${err.sliceId})` : ''}`);
  }
  process.exit(1);
}
console.log(`✓ ${structuralResult.stageId}: Structural validation passed`);

// Step 2: Compile manifest
console.log(`\n--- Step 2: Compile Manifest ---`);
let manifest;
try {
  manifest = compileManifest(tasksPath);
  console.log(`✓ Manifest compiled: ${manifest.stage_id} (${manifest.slices.length} slices)`);
} catch (err) {
  console.error(`✗ Manifest compilation failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// Step 3: Validate pre-existing Slice Evidence files (do NOT generate skeletons).
// The checked-in fixtures must have the complete §4.4 skeleton, not just a file
// at the manifest path. Keep this check here (rather than in the runtime) because
// fixture-check is deliberately read-only and acceptance-fixture specific.
console.log(`\n--- Step 3: Validate Slice Evidence Files ---`);
let evidenceErrors = 0;
const manifestEvidenceDir = path.resolve(deliveryRoot, 'delivery', 'stages', manifest.stage_id, 'evidence');

const requiredEvidenceHeadings = [
  '## Slice Context',
  '## Task Evidence',
  '## Current Slice Evidence',
  '### Snapshot',
  '### Proof Obligation Coverage',
  '### Changed Files',
  '### Verification Commands',
  '### Actual Observations',
  '### Limitations',
  '## Current CV Status',
];

function validateEvidenceSkeleton(text, slice) {
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const positions = requiredEvidenceHeadings.map(heading => lines.indexOf(heading));
  const errors = [];

  if (positions.some(position => position < 0)) {
    for (const [index, heading] of requiredEvidenceHeadings.entries()) {
      if (positions[index] < 0) errors.push(`missing ${heading}`);
    }
    return errors;
  }
  for (let index = 1; index < positions.length; index++) {
    if (positions[index] <= positions[index - 1]) {
      errors.push(`headings are out of order near ${requiredEvidenceHeadings[index]}`);
      break;
    }
  }

  const contextStart = positions[0];
  const contextEnd = positions[1];
  const context = lines.slice(contextStart + 1, contextEnd).join('\n');
  if (!new RegExp(`^- Slice ID: ${slice.slice_id}$`, 'm').test(context)) {
    errors.push(`Slice Context does not identify ${slice.slice_id}`);
  }
  if (!/^- Stage ID: \S+$/m.test(context)) {
    errors.push('Slice Context is missing Stage ID');
  }

  const coverageStart = positions[4];
  const coverageEnd = positions[5];
  const coverage = lines.slice(coverageStart + 1, coverageEnd).join('\n');
  if (!/\| PO ID \| Test ID \/ Verification Action \| RED Receipt \| GREEN Receipt \| Current Result \|/.test(coverage)) {
    errors.push('Proof Obligation Coverage table is missing its required columns');
  }

  const cvStatus = lines.slice(positions[9] + 1).join('\n');
  if (!/^- Status: \S+/m.test(cvStatus)) {
    errors.push('Current CV Status is missing Status');
  }
  return errors;
}

for (const slice of manifest.slices) {
  const evidenceFilePath = path.resolve(deliveryRoot, slice.evidence_path);

  if (!fs.existsSync(evidenceFilePath)) {
    console.error(`  Error: Slice "${slice.slice_id}" evidence file "${slice.evidence_path}" not found at "${evidenceFilePath}"`);
    evidenceErrors++;
    continue;
  }

  try {
    const stat = fs.lstatSync(evidenceFilePath);
    if (stat.isSymbolicLink()) {
      console.error(`  Error: Slice "${slice.slice_id}" evidence file "${evidenceFilePath}" is a symlink`);
      evidenceErrors++;
      continue;
    }
    const skeletonErrors = validateEvidenceSkeleton(fs.readFileSync(evidenceFilePath, 'utf8'), slice);
    if (skeletonErrors.length > 0) {
      for (const error of skeletonErrors) {
        console.error(`  Error: Slice "${slice.slice_id}" evidence skeleton: ${error}`);
      }
      evidenceErrors += skeletonErrors.length;
      continue;
    }
  } catch {
    console.error(`  Error: Cannot read or stat Slice "${slice.slice_id}" evidence file`);
    evidenceErrors++;
    continue;
  }

  console.log(`  ✓ Valid skeleton: ${slice.evidence_path}`);
}

if (evidenceErrors > 0) {
  console.error(`  ✗ ${evidenceErrors} evidence file(s) missing or structurally invalid`);
  process.exit(1);
}
console.log(`  ✓ All ${manifest.slices.length} evidence file(s) validated`);

// Step 4: Validate against manifest
console.log(`\n--- Step 4: Manifest-aware validateStage ---`);
const manifestResult = validateStageWithManifest(manifest, tasksPath,
  fs.existsSync(manifestEvidenceDir) ? manifestEvidenceDir : undefined);

if (!manifestResult.valid) {
  console.error(`✗ ${manifestResult.stageId}: Manifest-aware validation failed`);
  for (const err of manifestResult.errors) {
    console.error(`  - [${err.type}] ${err.message}${err.sliceId ? ` (slice: ${err.sliceId})` : ''}`);
  }
  process.exit(1);
}

// Acceptance fixtures also cover two negative contract conditions that are not
// part of the generic manifest validator: an invalid in-progress Worker marker
// and a slice with no Proof Obligation declaration.
const taskText = fs.readFileSync(tasksPath, 'utf8');
const incompleteWorker = /- Status: in-progress\b/.test(taskText);
if (incompleteWorker) {
  console.error('✗ [INCOMPLETE_WORKER] Worker status is in-progress; expected incomplete Worker detection');
  process.exit(1);
}
const missingProofObligation = manifest.slices.some(slice => slice.proof_obligations.length === 0);
if (missingProofObligation) {
  console.error('✗ [MISSING_PROOF_OBLIGATION] Slice is missing a Proof Obligation declaration');
  process.exit(1);
}

console.log(`✓ ${manifestResult.stageId}: All fixture checks passed`);
process.exit(0);
