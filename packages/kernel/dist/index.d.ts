/**
 * @proofloop/kernel — Domain types, state machines, and contracts.
 *
 * This package has zero workspace dependencies and provides the foundational
 * type definitions and state machine logic consumed by @proofloop/runtime
 * and @proofloop/pi-extension.
 */
export type { StageID, SliceID, NextAction, RoleType, } from './types';
export { StageState, SliceState, CVStatus, ProjectState, } from './types';
export type { StageEvent, SliceEvent, CvEvent, ProjectEvent, } from './types';
export type { FindingCode, Finding, ReceiptType, Receipt, ManifestSlice, Manifest, RuntimeLock, ProofObligation, RuntimeProofStep, } from './contracts';
export { InvalidTransitionError, ReceiptChainError } from './errors';
export { transitionStage, transitionSlice, transitionCv, transitionProject, } from './transitions';
export { validateReceipt, validateManifest, validateRuntimeLock, validateFinding, SchemaValidationError, } from './validators';
export type { ValidatedReceipt, ValidatedManifest, ValidatedRuntimeLock, ValidatedFinding, } from './validators';
export { computeReceiptDigest, verifyReceiptDigest, verifyReceiptChain, writeReceipt, assertValidReceiptChain, DEFAULT_LOCK_TIMEOUT_MS, } from './receipt-writer';
export type { ReceiptWriterOptions, WriteReceiptResult, VerifyReceiptChainOptions, ChainVerificationResult, } from './receipt-writer';
/** Minimal type for workspace import chain demonstration. */
export type PackageName = string;
/** Canonical package name for @proofloop/kernel. */
export declare const KERNEL_NAME: PackageName;
//# sourceMappingURL=index.d.ts.map