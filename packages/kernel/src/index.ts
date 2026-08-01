/**
 * @proofloop/kernel — Domain types, state machines, and contracts.
 *
 * This package has zero workspace dependencies and provides the foundational
 * type definitions and state machine logic consumed by @proofloop/runtime
 * and @proofloop/pi-extension.
 */

// Canonical type surface (§5 Canonical Type Registry) — non-contract types
export type {
  StageID,
  SliceID,
  NextAction,
  RoleType,
} from './types';
export {
  StageState,
  SliceState,
  CVStatus,
  ProjectState,
} from './types';
export type {
  StageEvent,
  SliceEvent,
  CvEvent,
  ProjectEvent,
} from './types';

// Contract artifact types (§4 File / Artifact Contracts)
export type {
  FindingCode,
  Finding,
  ReceiptType,
  Receipt,
  ManifestSlice,
  Manifest,
  RuntimeLock,
  ProofObligation,
  RuntimeProofStep,
} from './contracts';

// Domain errors (§7 Error Contracts)
export { InvalidTransitionError, ReceiptChainError } from './errors';

// State machine transition functions (§6 State Machines)
export {
  transitionStage,
  transitionSlice,
  transitionCv,
  transitionProject,
} from './transitions';

// Contract validators (§4 File / Artifact Contracts, §7 Error Contracts)
export {
  validateReceipt,
  validateManifest,
  validateRuntimeLock,
  validateFinding,
  SchemaValidationError,
} from './validators';
export type {
  ValidatedReceipt,
  ValidatedManifest,
  ValidatedRuntimeLock,
  ValidatedFinding,
} from './validators';

// ReceiptWriter — digest & chain verification (§4 File / Artifact Contracts)
export {
  computeReceiptDigest,
  verifyReceiptDigest,
  verifyReceiptChain,
  writeReceipt,
  assertValidReceiptChain,
  DEFAULT_LOCK_TIMEOUT_MS,
} from './receipt-writer';
export type {
  ReceiptWriterOptions,
  WriteReceiptResult,
  VerifyReceiptChainOptions,
  ChainVerificationResult,
} from './receipt-writer';

/** Minimal type for workspace import chain demonstration. */
export type PackageName = string;

/** Canonical package name for @proofloop/kernel. */
export const KERNEL_NAME: PackageName = '@proofloop/kernel';
