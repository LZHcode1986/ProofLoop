#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { ProjectAcceptanceManifestSchema } from './schemas.js';
import { runProjectAcceptance } from './run-stage.js';

const [manifestPath, outputDir] = process.argv.slice(2);

if (!manifestPath) {
  console.error('Usage: node run-project-acceptance.js <manifest-path> [output-dir]');
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}`);
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const manifest = ProjectAcceptanceManifestSchema.parse(parsed);

const result = await runProjectAcceptance(manifest, outputDir);

if (!result.success) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(result.receipt, null, 2));
process.exit(0);
