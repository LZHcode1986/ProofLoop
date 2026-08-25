/** Neutral root-bound Manifest route discriminator used by Runtime consumers. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalPathWithinRoot } from '../path-guard';
import { readRootBoundFile, VNextEntityResolutionError } from './entity-resolver';

export type PlanManifestRoute = 'v1' | 'vnext' | 'unknown';

function resolveProjectRoot(projectRoot?: string): string {
  if (projectRoot !== undefined && (typeof projectRoot !== 'string' || projectRoot.length === 0)) {
    throw new Error('project-root must be a non-empty path');
  }
  const lexical = path.resolve(projectRoot ?? process.cwd());
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lexical);
  } catch (error) {
    throw new Error(`project root is not readable: ${lexical} (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!stat.isDirectory()) throw new Error(`project root is not a directory: ${lexical}`);
  return fs.realpathSync(lexical);
}

/** Inspect only the root-bound Manifest discriminator; never silently downgrade vNext. */
export function detectPlanManifestRoute(projectRoot: string, manifestPath: string): PlanManifestRoute {
  const root = resolveProjectRoot(projectRoot);
  if (canonicalPathWithinRoot(root, manifestPath) === null) return 'unknown';
  let value: unknown;
  try {
    const read = readRootBoundFile(root, manifestPath);
    value = JSON.parse(read.content) as unknown;
  } catch (error) {
    if (error instanceof VNextEntityResolutionError && error.code === 'unreadable') {
      const probePath = path.isAbsolute(manifestPath) ? manifestPath : path.resolve(root, manifestPath);
      try {
        fs.lstatSync(probePath);
      } catch (probeError) {
        if ((probeError as NodeJS.ErrnoException).code === 'ENOENT') return 'v1';
      }
    }
    return 'unknown';
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  const record = value as Record<string, unknown>;
  const version = record.version;
  const schemaVersion = record.schema_version;
  if (version !== undefined && version !== 1 && version !== 2) return 'unknown';
  if (schemaVersion !== undefined && schemaVersion !== 2) return 'unknown';
  const plan = record.plan;
  if (plan !== undefined && (plan === null || typeof plan !== 'object' || Array.isArray(plan))) return 'unknown';
  const planSchemaVersion = plan === undefined ? undefined : (plan as Record<string, unknown>).schema_version;
  if (plan !== undefined && planSchemaVersion !== 2) return 'unknown';
  const hasVNextMarker = version === 2 || schemaVersion === 2 || planSchemaVersion === 2;
  if (version === 1 && hasVNextMarker) return 'unknown';
  if (hasVNextMarker) return 'vnext';
  if (version === 1) return 'v1';
  return typeof record.stage_id === 'string' && typeof record.source_path === 'string' ? 'v1' : 'unknown';
}
