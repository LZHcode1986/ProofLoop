/**
 * compile-project-acceptance — new runtime CLI entry (B1c, blueprint §6.4)
 *
 * Build the Project Acceptance Manifest from a plain input JSON, compute the
 * git-based expected snapshot of `project_root` and the canonical manifest
 * digest, and write the manifest to the output path — parity with the legacy
 * runtime's `compile-project-acceptance.ts` (behavior authority):
 *
 *   node packages/runtime/dist/cli/compile-project-acceptance.js <input-json-path> <output-manifest-path>
 *
 * Input JSON contract (legacy): `{ project_root, project_id, prd_goals?,
 * acceptance_criteria?, stage_receipts: [ { stage_id, stage_manifest,
 * review_receipt, gate_receipt } ], e2e_steps? }`. The manifest is written
 * ONLY after the pure-TypeScript schema validation passes (fail closed — an
 * invalid manifest is never emitted).
 *
 * Output: JSON `{ success, output_path, manifest_digest, expected_snapshot,
 * errors }`; exit 0 on success / 1 on failure.
 *
 * Zero host dependencies.
 */

import * as fs from 'node:fs';
import { compileProjectAcceptance } from '../project-acceptance';

/**
 * Legacy-compatible CLI:
 *   node dist/cli/compile-project-acceptance.js <input-json-path> <output-manifest-path>
 */
export function compileProjectAcceptanceCli(argv: readonly string[]): number {
  const [inputPath, outputPath] = argv;
  if (!inputPath || !outputPath) {
    console.error('Usage: node dist/cli/compile-project-acceptance.js <input-json-path> <output-manifest-path>');
    console.error('');
    console.error('Builds the Project Acceptance Manifest from the input JSON');
    console.error('(project_root, project_id, prd_goals, acceptance_criteria,');
    console.error('stage_receipts, e2e_steps), computes the git-based expected');
    console.error('snapshot and the canonical manifest digest, and writes the');
    console.error('manifest to the output path.');
    console.error('Outputs the result JSON to stdout; exit 0 on success, 1 on failure.');
    return 1;
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    return 1;
  }
  let input: unknown;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  } catch (err) {
    console.error(`Invalid input JSON: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const result = compileProjectAcceptance(input, outputPath);
  console.log(JSON.stringify(result, null, 2));
  return result.success ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = compileProjectAcceptanceCli(process.argv.slice(2));
}
