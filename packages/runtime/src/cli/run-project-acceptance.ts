/**
 * run-project-acceptance — new runtime CLI entry (B1c, blueprint §6.4)
 *
 * Execute a Project Acceptance E2E run over a Project Acceptance Manifest —
 * parity with the legacy runtime's `run-project-acceptance.ts` (behavior
 * authority):
 *
 *   node packages/runtime/dist/cli/run-project-acceptance.js <manifest-path> [output-dir] [project-root]
 *
 * Flow (delegated to `runProjectAcceptanceE2E`):
 *  1. load + pure-TypeScript schema-validate the manifest (fail closed);
 *  2. zero-step / all-skipped rejection, step topology validation, snapshot
 *     staleness check (expected_snapshot must equal the current git snapshot);
 *  3. sequential step execution through the B1a Process Runner (command /
 *     probe with the expected oracle; service_start / service_stop via the
 *     service lifecycle; not_applicable skipped) — stops at the first failed
 *     step;
 *  4. mandatory service cleanup (PASS and FAIL alike);
 *  5. verdict PASS when there are no errors, else FAIL (BLOCKED is reserved
 *     by the schema);
 *  6. persist the Project E2E Gate Receipt via the kernel `writeReceipt`
 *     (type PROJECT_E2E_PASS / PROJECT_E2E_FAIL / PROJECT_E2E_BLOCKED per
 *     verdict) into `[output-dir]` (default the canonical `project/` receipt
 *     category under project-root).
 *
 * Output: the `RunProjectAcceptanceE2EResult` JSON
 * `{ success, verdict, receipt, receipt_path, receipt_digest, errors }`;
 * exit 0 on PASS / 1 on FAIL — a FAIL verdict never pretends to be a PASS.
 *
 * Zero host dependencies.
 */

import * as fs from 'node:fs';
import { runProjectAcceptanceE2E } from '../project-acceptance';

/**
 * Legacy-compatible CLI:
 *   node dist/cli/run-project-acceptance.js <manifest-path> [output-dir] [project-root]
 */
export async function runProjectAcceptanceCli(argv: readonly string[]): Promise<number> {
  const [manifestPath, outputDir, projectRoot] = argv;
  if (!manifestPath) {
    console.error('Usage: node dist/cli/run-project-acceptance.js <manifest-path> [output-dir] [project-root]');
    console.error('');
    console.error('Executes the Project Acceptance E2E steps over the manifest');
    console.error('(B1a Process Runner: command/probe oracles, service lifecycle,');
    console.error('mandatory cleanup) and persists the Project E2E Gate Receipt');
    console.error('(PROJECT_E2E_PASS / PROJECT_E2E_FAIL) via the kernel writer.');
    console.error('Outputs the result JSON to stdout; exit 0 on PASS, 1 on FAIL.');
    return 1;
  }
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    console.error(`Failed to parse manifest JSON: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const result = await runProjectAcceptanceE2E(parsed, {
    receiptDir: outputDir || undefined,
    projectRoot: projectRoot || undefined,
  });
  console.log(JSON.stringify(result, null, 2));
  return result.success ? 0 : 1;
}

if (require.main === module) {
  runProjectAcceptanceCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
