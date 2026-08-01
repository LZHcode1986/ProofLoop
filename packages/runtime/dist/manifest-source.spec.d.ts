/**
 * manifestSource — S02-C-T02 (PO-S02-C-01 data-source part / PO-S02-C-02 source-error part)
 *
 * Verifies the runtime Manifest source seam against REAL filesystem fixtures
 * (temp directory + real `.proofloop/manifests/<stage>.json` file). The
 * manifest is validated through the kernel `validateManifest` seam (S01).
 *
 * Behaviors under test:
 *   - the canonical manifest path is `<projectRoot>/.proofloop/manifests/<stage>.json`
 *     (custom `manifestPath` also honored);
 *   - a valid manifest is kernel-validated and returned with its slices;
 *   - missing manifest / invalid JSON / schema-invalid payload / stage_id
 *     mismatch → structured `ManifestSourceError` with the canonical code
 *     `DOMAIN.STAGE_NOT_FOUND` (PO-S02-C-02 — manifest stage_id mismatch /
 *     missing manifest);
 *   - determinism (HP-003): two reads of the same fixture are deep-equal.
 */
export {};
//# sourceMappingURL=manifest-source.spec.d.ts.map