/**
 * fixture-check.mjs
 *
 * CLI wrapper around validate-stage.ts for CI fixture validation.
 *
 * Usage:
 *   node scripts/fixture-check.mjs <path-to-tasks.md>
 *
 * Exits:
 *   0 — fixture is structurally valid
 *   1 — fixture has validation errors
 */

import { validateStage } from '../dist/validate-stage.js';

const tasksPath = process.argv[2];

if (!tasksPath) {
  console.error('Usage: node scripts/fixture-check.mjs <tasks.md-path>');
  process.exit(1);
}

const result = validateStage(tasksPath);

if (result.valid) {
  console.log(`✓ ${result.stageId}: Valid`);
  process.exit(0);
} else {
  console.error(`✗ ${result.stageId}: Invalid`);
  for (const err of result.errors) {
    console.error(`  - [${err.type}] ${err.message}${err.sliceId ? ` (slice: ${err.sliceId})` : ''}`);
  }
  process.exit(1);
}
