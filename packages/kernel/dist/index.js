"use strict";
/**
 * @proofloop/kernel — Domain types, state machines, and contracts.
 *
 * This package has zero workspace dependencies and provides the foundational
 * type definitions and state machine logic consumed by @proofloop/runtime
 * and @proofloop/pi-extension.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KERNEL_NAME = exports.DEFAULT_LOCK_TIMEOUT_MS = exports.assertValidReceiptChain = exports.writeReceipt = exports.verifyReceiptChain = exports.verifyReceiptDigest = exports.computeReceiptDigest = exports.SchemaValidationError = exports.validateFinding = exports.validateRuntimeLock = exports.validateManifest = exports.validateReceipt = exports.transitionProject = exports.transitionCv = exports.transitionSlice = exports.transitionStage = exports.ReceiptChainError = exports.InvalidTransitionError = exports.ProjectState = exports.CVStatus = exports.SliceState = exports.StageState = void 0;
var types_1 = require("./types");
Object.defineProperty(exports, "StageState", { enumerable: true, get: function () { return types_1.StageState; } });
Object.defineProperty(exports, "SliceState", { enumerable: true, get: function () { return types_1.SliceState; } });
Object.defineProperty(exports, "CVStatus", { enumerable: true, get: function () { return types_1.CVStatus; } });
Object.defineProperty(exports, "ProjectState", { enumerable: true, get: function () { return types_1.ProjectState; } });
// Domain errors (§7 Error Contracts)
var errors_1 = require("./errors");
Object.defineProperty(exports, "InvalidTransitionError", { enumerable: true, get: function () { return errors_1.InvalidTransitionError; } });
Object.defineProperty(exports, "ReceiptChainError", { enumerable: true, get: function () { return errors_1.ReceiptChainError; } });
// State machine transition functions (§6 State Machines)
var transitions_1 = require("./transitions");
Object.defineProperty(exports, "transitionStage", { enumerable: true, get: function () { return transitions_1.transitionStage; } });
Object.defineProperty(exports, "transitionSlice", { enumerable: true, get: function () { return transitions_1.transitionSlice; } });
Object.defineProperty(exports, "transitionCv", { enumerable: true, get: function () { return transitions_1.transitionCv; } });
Object.defineProperty(exports, "transitionProject", { enumerable: true, get: function () { return transitions_1.transitionProject; } });
// Contract validators (§4 File / Artifact Contracts, §7 Error Contracts)
var validators_1 = require("./validators");
Object.defineProperty(exports, "validateReceipt", { enumerable: true, get: function () { return validators_1.validateReceipt; } });
Object.defineProperty(exports, "validateManifest", { enumerable: true, get: function () { return validators_1.validateManifest; } });
Object.defineProperty(exports, "validateRuntimeLock", { enumerable: true, get: function () { return validators_1.validateRuntimeLock; } });
Object.defineProperty(exports, "validateFinding", { enumerable: true, get: function () { return validators_1.validateFinding; } });
Object.defineProperty(exports, "SchemaValidationError", { enumerable: true, get: function () { return validators_1.SchemaValidationError; } });
// ReceiptWriter — digest & chain verification (§4 File / Artifact Contracts)
var receipt_writer_1 = require("./receipt-writer");
Object.defineProperty(exports, "computeReceiptDigest", { enumerable: true, get: function () { return receipt_writer_1.computeReceiptDigest; } });
Object.defineProperty(exports, "verifyReceiptDigest", { enumerable: true, get: function () { return receipt_writer_1.verifyReceiptDigest; } });
Object.defineProperty(exports, "verifyReceiptChain", { enumerable: true, get: function () { return receipt_writer_1.verifyReceiptChain; } });
Object.defineProperty(exports, "writeReceipt", { enumerable: true, get: function () { return receipt_writer_1.writeReceipt; } });
Object.defineProperty(exports, "assertValidReceiptChain", { enumerable: true, get: function () { return receipt_writer_1.assertValidReceiptChain; } });
Object.defineProperty(exports, "DEFAULT_LOCK_TIMEOUT_MS", { enumerable: true, get: function () { return receipt_writer_1.DEFAULT_LOCK_TIMEOUT_MS; } });
/** Canonical package name for @proofloop/kernel. */
exports.KERNEL_NAME = '@proofloop/kernel';
//# sourceMappingURL=index.js.map