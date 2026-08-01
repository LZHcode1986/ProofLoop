/**
 * @proofloop/kernel — Domain Error Definitions
 *
 * This file defines error classes and error-related utilities for the
 * @proofloop/kernel package.
 *
 * §7 Error Contracts — InvalidTransitionError for illegal state machine
 * transitions, ReceiptChainError for receipt chain integrity failures.
 */

/**
 * Error thrown when an illegal state machine transition is attempted.
 *
 * Carries the affected entity identifier (stage, slice, etc.) and the
 * source/target state context for structured error handling.
 */
export class InvalidTransitionError extends Error {
  /** Entity identifier (stage_id, slice_id, etc.). */
  public readonly entityId: string;
  /** Source state before the attempted transition. */
  public readonly fromState: string;
  /** Target state that was attempted. */
  public readonly toState: string;

  constructor(
    message: string,
    entityId: string,
    fromState: string,
    toState: string,
  ) {
    super(message);
    this.name = 'InvalidTransitionError';
    this.entityId = entityId;
    this.fromState = fromState;
    this.toState = toState;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, InvalidTransitionError.prototype);
  }
}

/**
 * Error thrown when a receipt chain integrity failure is detected.
 *
 * code: 'RUNTIME.RECEIPT_CHAIN_BROKEN' (§7 Error Contracts)
 * subtype: one of 'duplicate', 'fork', 'predecessor', 'chain', 'self_digest'
 * digest: the affected receipt digest (if applicable)
 * detail: additional context such as expected vs actual digest values
 *
 * Used by verifyReceiptChain and writeReceipt for all chain-related failures.
 */
export class ReceiptChainError extends Error {
  /** Canonical error code. */
  public readonly code: 'RUNTIME.RECEIPT_CHAIN_BROKEN' = 'RUNTIME.RECEIPT_CHAIN_BROKEN';
  /** Specific failure subtype. */
  public readonly subtype: 'duplicate' | 'fork' | 'predecessor' | 'chain' | 'self_digest';
  /** Affected receipt digest. */
  public readonly digest?: string;
  /** Additional context. */
  public readonly detail?: string;

  constructor(
    message: string,
    subtype: 'duplicate' | 'fork' | 'predecessor' | 'chain' | 'self_digest',
    digest?: string,
    detail?: string,
  ) {
    super(message);
    this.name = 'ReceiptChainError';
    this.subtype = subtype;
    this.digest = digest;
    this.detail = detail;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, ReceiptChainError.prototype);
  }
}
