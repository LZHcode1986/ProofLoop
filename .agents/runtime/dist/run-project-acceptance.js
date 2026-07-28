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
let parsed;
try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
}
catch (err) {
    console.error(`Failed to parse manifest JSON: ${err}`);
    process.exit(1);
}
let manifest;
try {
    manifest = ProjectAcceptanceManifestSchema.parse(parsed);
}
catch (err) {
    console.error(`Manifest schema validation failed:\n${err}`);
    process.exit(1);
}
const result = await runProjectAcceptance(manifest, outputDir);
if (!result.success) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
}
console.log(JSON.stringify(result.receipt, null, 2));
process.exit(0);
//# sourceMappingURL=run-project-acceptance.js.map