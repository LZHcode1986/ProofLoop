import type { RuntimeProofStep } from './schemas.js';
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
export interface StageReviewReceipt {
    stage_id: string;
    verdict: 'ACCEPTED' | 'REJECTED' | 'BLOCKED';
    finding_id?: string;
    route_code?: string;
    subtype?: string;
    affected_outcomes?: string[];
    affected_artifacts?: string[];
    evidence?: string;
    reason?: string;
    reviewed_at: string;
    reviewer: string;
}
export interface WriteStageReviewReceiptOptions {
    outputDir: string;
    data: StageReviewReceipt;
}
/**
 * Write a structured JSON Stage Review Receipt to disk.
 *
 * Returns the absolute path of the written receipt file.
 */
export declare function writeStageReviewReceipt(options: WriteStageReviewReceiptOptions): string;
export interface ProjectAcceptanceManifest {
    project_id: string;
    steps: RuntimeProofStep[];
    compiled_at: string;
}
export interface ProjectReviewReceipt {
    project_id: string;
    verdict: 'PROJECT_ACCEPTED' | 'PROJECT_REJECTED' | 'PROJECT_BLOCKED';
    findings?: Array<{
        category: string;
        description: string;
    }>;
    snapshot: string;
    reviewed_at: string;
    reviewer: string;
}
export interface WriteProjectReviewReceiptOptions {
    outputDir: string;
    data: ProjectReviewReceipt;
}
/**
 * Write a structured JSON Project Review Receipt to disk.
 *
 * Returns the absolute path of the written receipt file.
 */
export declare function writeProjectReviewReceipt(options: WriteProjectReviewReceiptOptions): string;
export declare function validateReceipt(receiptPath: string): {
    valid: boolean;
    error?: string;
};
