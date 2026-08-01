/**
 * compile-manifest CLI — PO-S03-H-01 call matrix (S03-H-T01)
 *
 * Public seam: `packages/runtime/src/cli/compile-manifest.ts` (+ the dist
 * script `packages/runtime/dist/cli/compile-manifest.js`).
 *
 * Covered here:
 *  - tasks.md → Manifest that passes the kernel `validateManifest` seam
 *    (the manifest is only accepted when kernel-valid — fail closed);
 *  - multi-slice dependency list parsing: each dependency on its own line
 *    AND multiple dependencies per line (按行解析) — the machine-readable
 *    DAG equals the tasks.md declarations (declaration order preserved);
 *  - proof-obligation parsing with multi-line values and defaults;
 *  - `## Stage Runtime Proof` step parsing (the documented YAML subset:
 *    command/probe/service_start/service_stop, args flow arrays with
 *    quoted elements, expected.exit_code, not_applicable, service_ref,
 *    readiness_signal);
 *  - cv_minimum_level computed from declared Risk Facts (canonical mapping);
 *  - CLI failure cases (missing tasks file, missing args → usage).
 *
 * No mocks: fixtures are real temporary files. The kernel validator is the
 * oracle (not an implementation-derived expectation).
 */
export {};
//# sourceMappingURL=compile-manifest.spec.d.ts.map