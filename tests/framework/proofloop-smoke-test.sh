#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
STAGE_ID="S99-SMOKE"
STAGE_DIR="delivery/stages/${STAGE_ID}"
MANIFEST_PATH=".proofloop/manifests/${STAGE_ID}.json"
GATE_OUTPUT_DIR=".proofloop/receipts/stage-gate/${STAGE_ID}"
FRAMEWORK_DIR="tests/framework"
PASS=0
FAIL=0
ERRORS=()

cleanup() {
  rm -rf "${ROOT_DIR:?}/${STAGE_DIR}"
  rm -f "${ROOT_DIR:?}/${MANIFEST_PATH}"
  rm -rf "${ROOT_DIR:?}/${GATE_OUTPUT_DIR}"
}
trap cleanup EXIT

step_pass() {
  echo "  [PASS] $1"
  PASS=$((PASS + 1))
}
step_fail() {
  echo "  [FAIL] $1"
  FAIL=$((FAIL + 1))
  ERRORS+=("$1")
}

# Run a tool: pass if it executes (any exit code), fail only if command not found
run_tool() {
  local name="$1"
  shift
  if "$@" 2>&1; then
    step_pass "${name}"
  else
    local rc=$?
    if [ "${rc}" -eq 127 ]; then
      step_fail "${name} (command not found, exit ${rc})"
    else
      step_fail "${name} (exit ${rc})"
    fi
  fi
}

echo "=========================================="
echo " ProofLoop Smoke Test — ${STAGE_ID}"
echo "=========================================="
echo ""

cd "${ROOT_DIR}"

# ──────────────────────────────────────────────
# Step 1: Create test stage directory (per-Slice evidence)
# ──────────────────────────────────────────────
echo "--- Step 1: Create test stage ---"
mkdir -p "${STAGE_DIR}/evidence"

cat > "${STAGE_DIR}/tasks.md" << 'TASKS_EOF'
# Stage S99-SMOKE — Smoke Test

## Stage Goal

Verify all ProofLoop tools run without errors.

## Observable Outcomes

- OUT-SMOKE-01: All validators execute without crash
- OUT-SMOKE-02: YAML frontmatter is valid across all agents

## Authority References

- PRD-001

## Dependencies

None

## Constraints

None

## Out of Scope

- Real implementation logic

## Blocking Hard Parts

None

---

## Slice Graph

S99-A → S99-B

---

## Slice S99-A — Validator Smoke
<!-- SLICE:S99-A:BEGIN -->

### Goal

Run each validator tool and confirm it produces expected output.

### Observable Outcome

OUT-SMOKE-01

### Public Seam

CLI exit codes

### Authority References

- PRD-001

### Dependency Outputs

None

### Dependencies

None

### Risk Facts

- none

### TDD Proof Plan

Primary Seam: CLI invocation
Required Success Behaviors: Each tool exits 0 or handles missing input gracefully
Required Failure Behaviors: Invalid arguments produce non-zero exit
State Assertions: Test directory is created and cleaned up

### Evidence

Per-Slice evidence file: evidence/S99-A.md

### Tasks

- [ ] S99-A-T01: Create test stage files
- [ ] S99-A-T02: Run each validator

### Task → Slice Closure

S99-A-T01 + S99-A-T02 → OUT-SMOKE-01

### Worker Status

- Status: planned

<!-- SLICE:S99-A:END -->

---

## Slice S99-B — YAML Frontmatter Check
<!-- SLICE:S99-B:BEGIN -->

### Goal

Verify all agent YAML frontmatter is valid.

### Observable Outcome

OUT-SMOKE-02

### Public Seam

Python yaml.safe_load()

### Authority References

- PRD-001

### Dependency Outputs

S99-A: Validator tools are available

### Dependencies

- S99-A

### Risk Facts

- none

### TDD Proof Plan

Primary Seam: Python yaml parsing
Required Success Behaviors: All agent files have parseable YAML
Required Failure Behaviors: Malformed YAML is reported

### Evidence

Per-Slice evidence file: evidence/S99-B.md

### Tasks

- [ ] S99-B-T01: Parse each agent frontmatter
- [ ] S99-B-T02: Verify permission section structure

### Task → Slice Closure

S99-B-T01 + S99-B-T02 → OUT-SMOKE-02

### Worker Status

- Status: planned

<!-- SLICE:S99-B:END -->

---

## Slice → Stage Closure

OUT-SMOKE-01: validated by running all tools
OUT-SMOKE-02: validated by YAML frontmatter check

## Stage Runtime Proof

```yaml
steps:
  - id: smoke-proof
    type: command
    executable: node
    args:
      - -e
      - console.log('stage smoke proof')
    timeout_ms: 30000
    expected:
      exit_code: 0
      output_contains: stage smoke proof
```
TASKS_EOF

cat > "${STAGE_DIR}/evidence/S99-A.md" << 'EVIDENCE_S99_A_EOF'
# Slice S99-A Evidence — Validator Smoke

## Current CV Status

- Status: READY_FOR_CV
- Level: lite
- Latest CV Receipt: *None*
- Open Finding: *None*

## Worker Statement

All validators were executed and their exit codes recorded.

## Implementation

Created test stage directory with tasks.md and per-slice evidence.

## Verification

- Commands: All validators invoked
- Results: Exit codes captured
- Observed Behavior: Tools respond to CLI invocation
- Proof Profiles: smoke-test

## Limitations

None
EVIDENCE_S99_A_EOF

cat > "${STAGE_DIR}/evidence/S99-B.md" << 'EVIDENCE_S99_B_EOF'
# Slice S99-B Evidence — YAML Frontmatter Check

## Current CV Status

- Status: READY_FOR_CV
- Level: lite
- Latest CV Receipt: *None*
- Open Finding: *None*

## Worker Statement

All agent YAML frontmatter was parsed and validated.

## Implementation

Used Python yaml.safe_load() to parse each agent's frontmatter.

## Verification

- Commands: Python yaml parsing
- Results: All frontmatter valid
- Observed Behavior: YAML parses successfully
- Proof Profiles: smoke-test

## Limitations

None
EVIDENCE_S99_B_EOF

step_pass "Test stage created at ${STAGE_DIR} with per-Slice evidence"

# ──────────────────────────────────────────────
# Step 2: Compile and validate the stage manifest
# ──────────────────────────────────────────────
echo ""
echo "--- Step 2: Compile Manifest ---"
MANIFEST_DIR="${ROOT_DIR}/.proofloop/manifests"
mkdir -p "${MANIFEST_DIR}"
if node "${ROOT_DIR}/.agents/runtime/dist/compile-manifest.js" "${STAGE_DIR}/tasks.md" "${ROOT_DIR}/${MANIFEST_PATH}"; then
  step_pass "compile-manifest"
else
  step_fail "compile-manifest"
fi

# ──────────────────────────────────────────────
# Step 3: Validate the manifest
# ──────────────────────────────────────────────
echo ""
echo "--- Step 3: Validate Manifest ---"
EVIDENCE_DIR="${ROOT_DIR}/${STAGE_DIR}/evidence"
if node "${ROOT_DIR}/.agents/runtime/dist/validate-stage.js" "${STAGE_DIR}/tasks.md" "${ROOT_DIR}/${MANIFEST_PATH}" "${EVIDENCE_DIR}"; then
  step_pass "validate-stage"
else
  step_fail "validate-stage"
fi

# ──────────────────────────────────────────────
# Step 4: Run Stage Gate (runtime pipeline)
# ──────────────────────────────────────────────
echo ""
echo "--- Step 4: Run Stage Gate ---"
GATE_OUTPUT_DIR_ABS="${ROOT_DIR}/${GATE_OUTPUT_DIR}"
COMMIT_SHA="$(git rev-parse --verify HEAD)"
mkdir -p "${GATE_OUTPUT_DIR_ABS}/receipt" "${GATE_OUTPUT_DIR_ABS}/integration"
for slice_id in S99-A S99-B; do
  cat > "${GATE_OUTPUT_DIR_ABS}/receipt/${slice_id}.json" <<RECEIPT_EOF
{
  "slice_id": "${slice_id}",
  "stage_id": "${STAGE_ID}",
  "snapshot": "smoke-fixture",
  "cv_level": "lite",
  "verdict": "PASS"
}
RECEIPT_EOF
  cat > "${GATE_OUTPUT_DIR_ABS}/integration/${slice_id}.json" <<INTEGRATION_EOF
{
  "stage_id": "${STAGE_ID}",
  "slice_id": "${slice_id}",
  "commit_sha": "${COMMIT_SHA}",
  "status": "integrated"
}
INTEGRATION_EOF
done
if node --input-type=module - "${ROOT_DIR}/${MANIFEST_PATH}" "${GATE_OUTPUT_DIR_ABS}" "${COMMIT_SHA}" <<'NODE_EOF'
import { runStageFromManifest } from './.agents/runtime/dist/run-stage.js';

const manifestPath = process.argv[2];
const outputDir = process.argv[3];
const commitSha = process.argv[4];
const facts = ['S99-A', 'S99-B'].map((sliceId) => ({
  slice_id: sliceId,
  cv: { verdict: 'PASS', receipt_ref: `receipt/${sliceId}.json` },
  commit: { commit_sha: commitSha },
  integration: { integration_ref: `integration/${sliceId}.json` },
}));
const result = await runStageFromManifest({ manifestPath, outputDir, sliceCompleteFacts: facts });
if (!result.success) {
  console.error(result.errors.join('\\n'));
  process.exit(1);
}
console.log(`Stage Gate PASSED (${result.stepCount} steps)`);
NODE_EOF
then
  step_pass "run-stage"
else
  step_fail "run-stage"
fi

# ──────────────────────────────────────────────
# Step 5: Permission Smoke Test
# ──────────────────────────────────────────────
echo ""
echo "--- Step 5: Permission Smoke Test ---"
run_tool "proofloop-permission-smoke-test.py" \
  python "${FRAMEWORK_DIR}/proofloop-permission-smoke-test.py" \
    --path "${ROOT_DIR}"

# ──────────────────────────────────────────────
# Step 6: YAML Frontmatter Check
# ──────────────────────────────────────────────
echo ""
echo "--- Step 6: YAML Frontmatter Check ---"
run_tool "proofloop-check-agent-yaml.py" \
  python "${FRAMEWORK_DIR}/proofloop-check-agent-yaml.py" \
    --path "${ROOT_DIR}"

# ──────────────────────────────────────────────
# Step 7: Scenario 2 dispatch mismatch acceptance
# ──────────────────────────────────────────────
echo ""
echo "--- Step 7: Scenario 2 dispatch mismatch acceptance ---"
run_tool "scenario-2-dispatch-mismatch.py" \
  python "${ROOT_DIR}/tests/fixtures/dispatch-mismatch/scenario-2-dispatch-mismatch.py"

# ──────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────
echo ""
echo "=========================================="
echo " Smoke Test Complete"
echo " Passed: ${PASS}"
echo " Failed: ${FAIL}"
echo "=========================================="

if [ "${FAIL}" -gt 0 ]; then
  echo ""
  echo "Failed steps:"
  for e in "${ERRORS[@]}"; do
    echo "  - ${e}"
  done
  exit 1
fi

exit 0
