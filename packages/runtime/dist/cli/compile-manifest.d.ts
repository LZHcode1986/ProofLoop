/**
 * compile-manifest — new runtime CLI entry (PO-S03-H-01, S03-H-T01)
 *
 * `tasks.md` → a canonical Manifest that passes the kernel `validateManifest`
 * seam (fail closed: an invalid manifest is never emitted). Parameter
 * contract matches the legacy CLI:
 *
 *   node packages/runtime/dist/cli/compile-manifest.js <tasks-path> <output-manifest-path>
 *
 * Multi-slice dependency list parsing: each slice's `### Dependencies` list
 * item may declare one dependency per line (`- S03-A`) or multiple
 * dependencies per line (`- S03-A S03-B`); every whitespace-separated token
 * matching the slice-id pattern is a dependency, so the machine-readable DAG
 * equals the tasks.md declarations (declaration order preserved). Prose-only
 * items produce no dependency (never a guess).
 *
 * The `## Stage Runtime Proof` section is parsed from the documented YAML
 * subset used by the Stage tasks (steps flow list; scalar fields; flow args
 * arrays with quoted elements; nested `expected:` / `not_applicable:`
 * maps). No third-party YAML dependency is introduced (zero host deps,
 * AWI-024/ADR-012 — stdlib only).
 *
 * Zero host dependencies: imports only Node builtins, `@proofloop/kernel`
 * and package-internal modules.
 */
import type { Manifest, RuntimeProofStep } from '@proofloop/kernel';
/**
 * Extract the content of a Markdown section by heading (## or ###).
 * The heading text must match exactly after trimming (e.g. `### Goal`).
 */
export declare function extractSection(lines: readonly string[], heading: string): string;
/** Extract `- item` list items from text. */
export declare function extractListItems(text: string): string[];
/**
 * Parse a slice dependency list. Each `- ` list item may declare one
 * dependency per line (`- S03-A`) or multiple dependencies per line
 * (`- S03-A S03-B`, optionally separated by `+`/`&`/`,`/`/`). Only the
 * LEADING run of slice-id/separator tokens counts — description prose that
 * merely mentions another slice id (e.g. "经 S03-F 传递") is never parsed as
 * a dependency (never a guess; declaration order preserved).
 */
export declare function parseSliceDependencies(text: string): string[];
declare const ALL_KNOWN_RISK_FACTS: Set<string>;
export { ALL_KNOWN_RISK_FACTS };
/** Normalize a raw risk fact entry: `authorization: false` → `authorization`. */
export declare function normalizeRiskFact(fact: string): string;
/**
 * Compute the slice CV minimum level from its declared Risk Facts (canonical
 * mapping): any enhanced fact → 'enhanced'; else any standard fact →
 * 'standard'; else 'lite'. Unknown facts fail closed.
 */
export declare function computeCvMinimumLevel(riskFacts: readonly string[]): 'lite' | 'standard' | 'enhanced';
/**
 * Parse the `## Stage Runtime Proof` section (the documented YAML subset):
 *
 *   steps:
 *     - id: build
 *       type: command
 *       executable: npm
 *       args: [run, build]
 *       cwd: .
 *       timeout_ms: 300000
 *       expected:
 *         exit_code: 0
 *       not_applicable:
 *         reason: ...
 *
 * Returns [] when the section is absent/empty.
 */
export declare function parseRuntimeProofSteps(section: string): RuntimeProofStep[];
/**
 * Compile a Stage tasks.md into a canonical Manifest.
 *
 * The result is passed through the kernel `validateManifest` seam before it
 * is returned — a manifest that fails kernel validation is never produced
 * (fail closed).
 */
export declare function compileManifest(tasksPath: string): Manifest;
/**
 * Legacy-compatible CLI:
 *   node dist/cli/compile-manifest.js <tasks-path> <output-manifest-path>
 */
export declare function compileManifestCli(argv: readonly string[]): number;
//# sourceMappingURL=compile-manifest.d.ts.map