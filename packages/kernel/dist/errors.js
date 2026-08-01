"use strict";
/**
 * @proofloop/kernel — Domain Error Definitions
 *
 * This file defines error classes and error-related utilities for the
 * @proofloop/kernel package.
 *
 * §7 Error Contracts — InvalidTransitionError for illegal state machine
 * transitions, ReceiptChainError for receipt chain integrity failures.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReceiptChainError = exports.InvalidTransitionError = void 0;
/**
 * Error thrown when an illegal state machine transition is attempted.
 *
 * Carries the affected entity identifier (stage, slice, etc.) and the
 * source/target state context for structured error handling.
 */
class InvalidTransitionError extends Error {
    /** Entity identifier (stage_id, slice_id, etc.). */
    entityId;
    /** Source state before the attempted transition. */
    fromState;
    /** Target state that was attempted. */
    toState;
    constructor(message, entityId, fromState, toState) {
        super(message);
        this.name = 'InvalidTransitionError';
        this.entityId = entityId;
        this.fromState = fromState;
        this.toState = toState;
        // Maintain proper prototype chain for instanceof checks
        Object.setPrototypeOf(this, InvalidTransitionError.prototype);
    }
}
exports.InvalidTransitionError = InvalidTransitionError;
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
class ReceiptChainError extends Error {
    /** Canonical error code. */
    code = 'RUNTIME.RECEIPT_CHAIN_BROKEN';
    /** Specific failure subtype. */
    subtype;
    /** Affected receipt digest. */
    digest;
    /** Additional context. */
    detail;
    constructor(message, subtype, digest, detail) {
        super(message);
        this.name = 'ReceiptChainError';
        this.subtype = subtype;
        this.digest = digest;
        this.detail = detail;
        // Maintain proper prototype chain for instanceof checks
        Object.setPrototypeOf(this, ReceiptChainError.prototype);
    }
}
exports.ReceiptChainError = ReceiptChainError;
//# sourceMappingURL=errors.js.map