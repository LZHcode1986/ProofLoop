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
export declare class InvalidTransitionError extends Error {
    /** Entity identifier (stage_id, slice_id, etc.). */
    readonly entityId: string;
    /** Source state before the attempted transition. */
    readonly fromState: string;
    /** Target state that was attempted. */
    readonly toState: string;
    constructor(message: string, entityId: string, fromState: string, toState: string);
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
export declare class ReceiptChainError extends Error {
    /** Canonical error code. */
    readonly code: 'RUNTIME.RECEIPT_CHAIN_BROKEN';
    /** Specific failure subtype. */
    readonly subtype: 'duplicate' | 'fork' | 'predecessor' | 'chain' | 'self_digest';
    /** Affected receipt digest. */
    readonly digest?: string;
    /** Additional context. */
    readonly detail?: string;
    constructor(message: string, subtype: 'duplicate' | 'fork' | 'predecessor' | 'chain' | 'self_digest', digest?: string, detail?: string);
}
//# sourceMappingURL=errors.d.ts.map