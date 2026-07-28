import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProjectAcceptance } from '../src/run-stage.js';
import { computeSnapshot } from '../src/receipt-writer.js';
import type { ProjectAcceptanceManifest } from '../src/schemas.js';

// ── Helpers ─────────────────────────────────────────────────────────────────────

let tmpDir: string;

const BASE_MANIFEST: ProjectAcceptanceManifest = {
  project_id: 'test-project',
  expected_snapshot: computeSnapshot(process.cwd()),
  prd_goals: ['Implement core feature X'],
  acceptance_criteria: ['AC-01: Feature X works'],
  stage_receipts: [{
    stage_id: 'S01',
    stage_manifest: { path: 'stage-manifest-S01.json', digest: 'a1b2c3d4e5f6a7b8' },
    review_receipt: { path: 'stage-review-S01.json', digest: 'a1b2c3d4e5f6a7b8' },
    gate_receipt: { path: 'stage-gate-S01.json', digest: 'a1b2c3d4e5f6a7b8' },
  }],
  e2e_steps: [],
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'project-acceptance-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('runProjectAcceptance', () => {

  describe('正向路径', () => {
    test('E2E steps pass → PASS', async () => {
      const manifest: ProjectAcceptanceManifest = {
        ...BASE_MANIFEST,
        e2e_steps: [
          {
            id: 'smoke-1',
            executable: 'node',
            args: ['-e', 'console.log("e2e ok")'],
            expected: { output_contains: 'e2e ok' },
          },
          {
            id: 'smoke-2',
            executable: 'node',
            args: ['-e', 'process.exit(0)'],
          },
        ],
      };

      const result = await runProjectAcceptance(manifest, tmpDir);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.receipt).toBeDefined();
      expect(result.receipt!.verdict).toBe('PASS');
      expect(result.receipt!.steps).toHaveLength(2);

      const steps = result.receipt!.steps;
      expect(steps[0].step_id).toBe('smoke-1');
      expect(steps[0].exit_code).toBe(0);
      expect(steps[1].step_id).toBe('smoke-2');
      expect(steps[1].exit_code).toBe(0);
    }, 15000);
  });

  describe('负向路径', () => {
    test('empty e2e_steps → PROJECT_E2E_ZERO_STEPS', async () => {
      const manifest: ProjectAcceptanceManifest = {
        ...BASE_MANIFEST,
        e2e_steps: [],
      };

      const result = await runProjectAcceptance(manifest, tmpDir);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('PROJECT_E2E_ZERO_STEPS');
      expect(result.receipt).toBeUndefined();
    }, 15000);

    test('all e2e_steps skipped → PROJECT_E2E_ALL_SKIPPED', async () => {
      const manifest: ProjectAcceptanceManifest = {
        ...BASE_MANIFEST,
        e2e_steps: [
          {
            id: 'skipped-1',
            executable: 'node',
            args: ['-e', 'console.log("x")'],
            not_applicable: { reason: 'Not applicable in this context' },
          },
        ],
      };

      const result = await runProjectAcceptance(manifest, tmpDir);

      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('PROJECT_E2E_ALL_SKIPPED');
      expect(result.receipt).toBeUndefined();
    }, 15000);

    test('E2E step fails → FAIL', async () => {
      const manifest: ProjectAcceptanceManifest = {
        ...BASE_MANIFEST,
        e2e_steps: [
          {
            id: 'fail-step',
            executable: 'node',
            args: ['-e', 'process.exit(1)'],
          },
        ],
      };

      const result = await runProjectAcceptance(manifest, tmpDir);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.receipt).toBeDefined();
      expect(result.receipt!.verdict).toBe('FAIL');
      expect(result.receipt!.steps).toHaveLength(1);
      expect(result.receipt!.steps[0].exit_code).toBe(1);
    }, 15000);

    test('topology validation fails → FAIL', async () => {
      const manifest: ProjectAcceptanceManifest = {
        ...BASE_MANIFEST,
        e2e_steps: [
          {
            id: 'start-only',
            type: 'service_start',
            executable: 'node',
            args: ['-e', 'setInterval(function() {}, 60000)'],
            readiness_signal: 'ready',
            timeout_ms: 3000,
          },
          // No matching service_stop — topology error
        ],
      };

      const result = await runProjectAcceptance(manifest, tmpDir);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e: string) => e.includes('SERVICE_START_WITHOUT_STOP'))).toBe(true);
      // Topology failure means no steps executed, no receipt generated
      expect(result.receipt).toBeUndefined();
    }, 15000);

    test('empty expected_snapshot is rejected', async () => {
      const badManifest: ProjectAcceptanceManifest = {
        ...BASE_MANIFEST,
        expected_snapshot: '',
        e2e_steps: [
          {
            id: 'smoke-1',
            executable: 'node',
            args: ['-e', 'console.log("ok")'],
          },
        ],
      };
      const result = await runProjectAcceptance(badManifest, tmpDir);
      expect(result.success).toBe(false);
      expect(result.errors.some((e: string) => e.includes('PROJECT_SOURCE_STALE'))).toBe(true);
    }, 15000);

    test('probe with wrong expected output → FAIL', async () => {
      const manifest: ProjectAcceptanceManifest = {
        ...BASE_MANIFEST,
        e2e_steps: [
          {
            id: 'wrong-output',
            executable: 'node',
            args: ['-e', 'console.log("actual")'],
            expected: { output_contains: 'nonexistent text' },
          },
        ],
      };

      const result = await runProjectAcceptance(manifest, tmpDir);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e: string) => e.includes('does not contain expected text'))).toBe(true);
      expect(result.receipt).toBeDefined();
      expect(result.receipt!.verdict).toBe('FAIL');
    }, 15000);
  });
});
