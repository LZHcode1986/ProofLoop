import fs from 'node:fs';

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

export function parseStageFile(filePath: string): ParsedStage {
  const text = fs.readFileSync(filePath, 'utf-8');
  const lines = text.split('\n');

  // Extract stage ID from first heading
  const stageIdMatch = text.match(/^# Stage\s+(S\d[\w-]*)/m);
  const stageId = stageIdMatch?.[1] ?? 'unknown';

  const slices: ParsedSlice[] = [];
  let currentSlice: ParsedSlice | null = null;

  for (const line of lines) {
    const beginMatch = line.match(/<!--\s*SLICE:(\S+):BEGIN\s*-->/);
    const endMatch = line.match(/<!--\s*SLICE:(\S+):END\s*-->/);

    if (beginMatch) {
      currentSlice = { sliceId: beginMatch[1], raw: '', lines: [] };
    } else if (endMatch && currentSlice) {
      slices.push(currentSlice);
      currentSlice = null;
    } else if (currentSlice) {
      currentSlice.raw += line + '\n';
      currentSlice.lines.push(line);
    }
  }

  return { stageId, slices, preamble: '' };
}
