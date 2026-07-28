export interface StepResult {
    id: string;
    executable: string;
    args: string[];
    exit_code: number | null;
    signal: string | null;
    timed_out: boolean;
    duration_ms: number;
    observations?: string;
}
export interface ReceiptData {
    stage_id: string;
    snapshot: string;
    platform: string;
    tool_versions: Record<string, string>;
    steps: StepResult[];
    exit_code: number;
    observations?: string;
    cleanup?: {
        cleaned: number;
        failed: string[];
    };
    verdict: 'PASS' | 'FAIL' | 'BLOCKED';
    timestamps: {
        started_at: string;
        completed_at: string;
    };
}
export interface WriteReceiptOptions {
    outputDir: string;
    data: ReceiptData;
}
/**
 * Compute a content-aware snapshot identifier for a directory tree.
 *
 * Walks files (skipping .git, node_modules and hidden dirs), hashing
 * relative paths + file contents into a SHA-256 digest, returning the
 * first 16 hex characters as a short identifier.
 */
export declare function computeSnapshot(dir: string): string;
/**
 * Write a structured JSON Stage Gate receipt to disk.
 *
 * Receipt schema matches `.agents/runtime/src/schemas.ts StageGateReceipt`
 * but with extended runtime detail.
 *
 * Returns the absolute path of the written receipt file.
 */
export declare function writeReceipt(options: WriteReceiptOptions): string;
/**
 * Validate that a receipt file exists and is parseable.
 * Returns true if valid, false with error message if not.
 */
export declare function validateReceipt(receiptPath: string): {
    valid: boolean;
    error?: string;
};
