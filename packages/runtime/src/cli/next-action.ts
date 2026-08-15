/** Canonical path only next action CLI with explicit v1 and vNext routing. */

import * as fs from "node:fs";
import * as path from "node:path";
import { NextActionService } from "../next-action-service";
import type { NextActionOutput } from "../next-action-service";
import { defaultManifestPath } from "../manifest-source";
import { detectVNextManifestDiscriminator, VNextNextActionService } from "../vnext";
import type { VNextNextActionOutput } from "../vnext";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
export interface NextActionCliInput {
  readonly stage_id?: string;
  readonly project_root?: string;
  readonly manifest_path?: string;
  readonly tasks_path?: string;
  readonly snapshot_digest?: string;
  readonly stageId?: string;
  readonly projectRoot?: string;
  readonly manifestPath?: string;
  readonly tasksPath?: string;
  readonly snapshotDigest?: string;
}
export function nextActionFromInput(raw: unknown): NextActionOutput | VNextNextActionOutput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError("next-action input must be a JSON object");
  const input = raw as Record<string, unknown>;
  const projectRoot = str(input.project_root) ?? str(input.projectRoot);
  const stageId = str(input.stage_id) ?? str(input.stageId);
  if (projectRoot === undefined) throw new TypeError("next-action input requires project_root (string)");
  if (stageId === undefined) throw new TypeError("next-action input requires stage_id (string)");
  const resolveWithin = (value: string | undefined): string | undefined => value === undefined || path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
  const manifestPath = resolveWithin(str(input.manifest_path) ?? str(input.manifestPath)) ?? defaultManifestPath(projectRoot, stageId);
  if (detectVNextManifestDiscriminator(projectRoot, manifestPath)) {
    return new VNextNextActionService().nextAction({
      projectRoot,
      stageId,
      manifestPath,
      snapshotDigest: str(input.snapshot_digest) ?? str(input.snapshotDigest),
      persistContext: true,
    });
  }
  return new NextActionService().nextAction({
    projectRoot,
    stageId,
    manifestPath,
    tasksPath: resolveWithin(str(input.tasks_path) ?? str(input.tasksPath)),
  });
}
function readInputArg(argv: readonly string[]): string {
  const [arg1, arg2] = argv;
  if (arg1 === "--json") return arg2 ?? "";
  if (arg1 !== undefined) return fs.readFileSync(arg1, "utf8");
  return "";
}
export function nextActionCli(argv: readonly string[]): number {
  let raw: string;
  try { raw = readInputArg(argv); }
  catch (error) { console.error("Error: Cannot read input file: " + (error instanceof Error ? error.message : String(error))); return 1; }
  if (!raw) { console.error("Usage: node dist/cli/next-action.js <input.json>"); return 1; }
  let data: unknown;
  try { data = JSON.parse(raw); }
  catch (error) { console.error("Error: Invalid JSON: " + (error instanceof Error ? error.message : String(error))); return 1; }
  try { console.log(JSON.stringify(nextActionFromInput(data), null, 2)); return 0; }
  catch (error) { console.error("Error: " + (error instanceof Error ? error.message : String(error))); return 1; }
}
if (require.main === module) process.exitCode = nextActionCli(process.argv.slice(2));
