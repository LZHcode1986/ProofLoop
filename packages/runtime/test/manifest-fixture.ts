/**
 * Minimal-but-schema-valid v2 Manifest fixture for the boundary-repair tests.
 *
 * `readVNextManifest`/`validateVNextManifest` validate only the JSON shape
 * (no file-system references), so a schema-valid manifest is enough to exercise
 * the stage-plan manifest_digest preflight and the stage-close preflight read.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { sha } from './helpers';

/** Build a schema-valid legacy (no binding) v2 Manifest with one slice and one task. */
export function buildValidManifest(stageId: string): Record<string, unknown> {
  const taskRef = `delivery/stages/${stageId}/tasks.md#/entities/${stageId}-T01`;
  const goalRef = `delivery/stages/${stageId}/tasks.md#/entities/${stageId}-G01`;
  const accRef = `delivery/stages/${stageId}/tasks.md#/entities/${stageId}-A01`;
  const seamRef = `delivery/stages/${stageId}/tasks.md#/entities/${stageId}-S01`;
  const oracleRef = `delivery/stages/${stageId}/tasks.md#/entities/${stageId}-O01`;
  const riskRef = `delivery/stages/${stageId}/tasks.md#/entities/${stageId}-R01`;
  const sliceId = `${stageId}-sliceA`;
  const reference = (kind: string, ref: string): Record<string, unknown> => ({
    kind,
    ref,
    file_digest: sha(`${kind}-file`),
    section_digest: sha(`${kind}-section`),
  });
  return {
    version: 2,
    stage_id: stageId,
    plan: {
      ref: `delivery/stages/${stageId}/tasks.md`,
      plan_digest: sha('plan'),
      schema_version: 2,
    },
    reference_index: {
      [`${stageId}-G01`]: reference('goal', goalRef),
      [`${stageId}-T01`]: reference('task', taskRef),
      [`${stageId}-A01`]: reference('acceptance', accRef),
      [`${stageId}-S01`]: reference('seam', seamRef),
      [`${stageId}-O01`]: reference('oracle', oracleRef),
      [`${stageId}-R01`]: reference('risk', riskRef),
    },
    authority_ref_ids: [`${stageId}-G01`],
    slices: [
      {
        slice_id: sliceId,
        proof_index: {
          slice_id: sliceId,
          goal_ref: `${stageId}-G01`,
          task_refs: [`${stageId}-T01`],
          acceptance_refs: [`${stageId}-A01`],
          seam_refs: [`${stageId}-S01`],
          oracle_refs: [`${stageId}-O01`],
          risk_refs: [
            {
              ref_id: `${stageId}-R01`,
              applies_to_acceptance_refs: [`${stageId}-A01`],
              applies_to_seam_refs: [],
            },
          ],
        },
        required_skills: [],
        depends_on: [],
        evidence_path: `delivery/stages/${stageId}/evidence/sliceA.md`,
      },
    ],
    task_scopes: {
      [`${stageId}-T01`]: {
        task_ref: taskRef,
        execution_scope: {
          kind: 'implementation',
          code_paths: [`delivery/stages/${stageId}/src`],
          test_paths: [`delivery/stages/${stageId}/test`],
          forbidden_paths: [],
        },
      },
    },
    compiled_by: 'test',
  };
}

/** Persist a schema-valid manifest for a stage and return its computed digest. */
export function persistValidManifest(root: string, stageId: string): string {
  const manifest = buildValidManifest(stageId);
  const file = path.join(root, '.proofloop', 'manifests', `${stageId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
  // Compute the digest exactly as the runtime does: computeDigest(parsedJson).
  const { computeDigest } = require('../../kernel/dist/index');
  return computeDigest(manifest);
}