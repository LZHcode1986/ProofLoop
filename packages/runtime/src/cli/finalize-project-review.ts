/**
 * finalize-project-review — new runtime CLI entry (B1c, blueprint §6.4)
 *
 * Cross-validate the Project Acceptance Manifest + Project E2E Gate Receipt +
 * independent Project Review Result and, when everything passes, persist the
 * final Project Review Receipt (PROJECT_REVIEW_PASS, kernel `writeReceipt`,
 * previous_digest chained to the E2E gate receipt) — parity with the legacy
 * runtime's `finalize-project-review.ts` (behavior authority):
 *
 *   node packages/runtime/dist/cli/finalize-project-review.js <input-json-path>
 *
 * `<input-json-path>` holds `{ manifestPath, e2eReceiptPath,
 * reviewerResultPath, outputDir }` (legacy FinalizeInput contract). The
 * validation checklist is kept verbatim: manifest schema + canonical digest,
 * E2E kernel-envelope + payload PASS + project_id / manifest_digest /
 * expected_snapshot / executed_snapshot binding, reviewer PROJECT_ACCEPTED +
 * snapshot / digest binding + e2e file-digest triple, per-stage
 * manifest/review/gate triple-binding, criteria one-to-one coverage.
 *
 * Output: `{ success, receipt_path, receipt_digest, errors }`; exit 0 on
 * success / 1 on failure. Nothing is written on failure.
 *
 * Zero host dependencies.
 */

import * as fs from 'node:fs';
import { finalizeProjectReview } from '../project-acceptance';
import type { FinalizeProjectReviewInput } from '../project-acceptance';

/**
 * Legacy-compatible CLI:
 *   node dist/cli/finalize-project-review.js <input-json-path>
 */
export function finalizeProjectReviewCli(argv: readonly string[]): number {
  const [inputPath] = argv;
  if (!inputPath) {
    console.error('Usage: node dist/cli/finalize-project-review.js <input-json-path>');
    console.error('');
    console.error('Cross-validates the Project Manifest + Project E2E Gate');
    console.error('Receipt + Project Review Result and writes the final');
    console.error('PROJECT_REVIEW_PASS receipt (chained to the E2E gate)');
    console.error('when all checks pass.');
    console.error('Input JSON: { manifestPath, e2eReceiptPath, reviewerResultPath, outputDir }.');
    console.error('Outputs the result JSON to stdout; exit 0 on success, 1 on failure.');
    return 1;
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`Input file not found: ${inputPath}`);
    return 1;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  } catch (err) {
    console.error(`Invalid input JSON: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.error('Input JSON must be an object: { manifestPath, e2eReceiptPath, reviewerResultPath, outputDir }');
    return 1;
  }
  const input = raw as Record<string, unknown>;
  for (const key of ['manifestPath', 'e2eReceiptPath', 'reviewerResultPath', 'outputDir'] as const) {
    if (typeof input[key] !== 'string' || (input[key] as string).length === 0) {
      console.error(`Input JSON must contain a non-empty "${key}" field`);
      return 1;
    }
  }
  const result = finalizeProjectReview(input as unknown as FinalizeProjectReviewInput);
  console.log(JSON.stringify(result, null, 2));
  return result.success ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = finalizeProjectReviewCli(process.argv.slice(2));
}
