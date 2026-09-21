/**
 * @proofloop/kernel — Canonical Contract Type Definitions
 *
 * This file defines the canonical contract types for external artifact
 * payloads that the kernel validates. After the neutral cutover it holds a
 * single artifact contract: RuntimeLock (§4 File / Artifact Contracts —
 * `.proofloop/runtime.lock`).
 *
 * These are TYPE DEFINITIONS ONLY (not Zod schemas or validators).
 * Validation lives in validators.ts.
 */

// ============================================================
// 4. File / Artifact Contracts — Runtime Lock
// ============================================================

/**
 * `.proofloop/runtime.lock` artifact.
 *
 * See §4 File / Artifact Contracts — lock lifecycle is create once /
 * never overwrite.
 *
 * Fields:
 * - runtime_version: version of the runtime
 * - domain_schema_version: version of the domain schema
 * - risk_policy_version: version of the risk policy
 * - capability_policy_version: version of the capability policy
 * - host_adapter: host adapter identifier
 * - extension_package: extension package name
 * - extension_version: extension version
 */
export interface RuntimeLock {
  /** Version of the runtime. */
  runtime_version: string;
  /** Version of the domain schema. */
  domain_schema_version: number;
  /** Version of the risk policy. */
  risk_policy_version: number;
  /** Version of the capability policy. */
  capability_policy_version: number;
  /** Host adapter identifier. */
  host_adapter: string;
  /** Extension package name. */
  extension_package: string;
  /** Extension version. */
  extension_version: string;
}