export interface ParsedSlice {
    sliceId: string;
    raw: string;
    lines: string[];
}
export interface ParsedStage {
    stageId: string;
    slices: ParsedSlice[];
    preamble: string;
}
export declare function parseStageFile(filePath: string): ParsedStage;
