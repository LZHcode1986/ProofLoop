/**
 * cli-entries.spec.ts — PO-S03-H-01 call matrix (S03-H-T01)
 *
 * Call matrix (success + failure case per entry) for the six remaining new
 * runtime CLI entries:
 *
 *   initialize-slice-evidence  — skeleton creation, no-overwrite, traversal guard
 *   next-action                — path-only input → NextActionService output
 *   sync-cv-status             — reconcile-derived CV status (read-only)
 *   admit                      — 7 S02 admit operations through the pipeline
 *   prepare-gate-facts         — reconcile + git clean + HEAD + integrated
 *   run-gate                   — runtime_proof step execution (minimal, HP-004)
 *
 * plus the dist-script usage matrix for all eight entries (callable via
 * `node packages/runtime/dist/cli/<tool>.js` with the legacy arg contract).
 *
 * No mocks: real temp dirs / real git repos / real receipts. Forbidden
 * shortcut covered: the next-action and admit entries MUST go through the
 * runtime services (NextActionService / S02 admit methods) — the assertions
 * verify the service-contract output shapes, not ad-hoc derivation.
 */
export {};
//# sourceMappingURL=cli-entries.spec.d.ts.map