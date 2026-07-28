export interface RunStageOptions {
    manifestPath: string;
    outputDir?: string;
    knownPids?: number[];
    knownPorts?: number[];
}
export interface RunStageResult {
    success: boolean;
    receiptPath?: string;
    errors: string[];
    stepCount: number;
}
/**
 * Run all Runtime Proof steps from a compiled Stage Manifest.
 *
 * Flow:
 * 1. Load and validate Manifest
 * 2. Validate all RuntimeProofStep definitions (no shells, no operators)
 * 3. Execute each step in sequence
 * 4. On first failure, stop and return FAIL verdict
 * 5. Cleanup known PIDs / ports
 * 6. Write structured receipt
 */
export declare function runStageFromManifest(options: RunStageOptions): Promise<RunStageResult>;
