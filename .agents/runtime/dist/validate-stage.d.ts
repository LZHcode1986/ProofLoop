export interface ValidationResult {
    valid: boolean;
    stageId: string;
    errors: ValidationError[];
}
export interface ValidationError {
    type: string;
    message: string;
    sliceId?: string;
}
export declare function validateStage(tasksPath: string, evidencePath?: string): ValidationResult;
