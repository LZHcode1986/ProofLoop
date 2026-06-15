#!/bin/bash

# Local check script for ProofLoop
# Run this before committing to catch issues early

set -e

echo "=== ProofLoop Local Check ==="

# 1. OpenSpec validation
echo "[1/5] Validating OpenSpec changes..."
if command -v openspec &> /dev/null; then
    for change_dir in openspec/changes/*/; do
        if [ -d "$change_dir" ]; then
            change_id=$(basename "$change_dir")
            echo "  Validating change: $change_id"
            openspec validate "$change_id" --strict || exit 1
        fi
    done
else
    echo "  WARNING: openspec CLI not found, skipping validation"
fi

# 2. Check for required files
echo "[2/5] Checking required files..."
error=0
for required in "AGENTS.md" "openspec/config.yaml"; do
    if [ ! -f "$required" ]; then
        echo "FAIL: Missing required file: $required"
        error=1
    fi
done
if [ "$error" -eq 1 ]; then exit 1; fi

# 3. Check for broken links (basic check)
echo "[3/5] Checking for broken internal links..."
# Add link checking logic here if needed

# 4. Check for common issues
echo "[4/5] Checking for common issues..."
# Add more checks here as needed

# 5. Spec naming check
echo "[5/5] Checking spec naming..."
error=0
shopt -s nullglob 2>/dev/null || true
for dir in openspec/specs/*/ openspec/changes/*/specs/*/; do
    if [ -d "$dir" ]; then
        name=$(basename "$dir")
        if ! echo "$name" | grep -qE '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'; then
            echo "FAIL: Invalid spec name: $name in $dir"
            error=1
        fi
        # Check for forbidden patterns
        if echo "$name" | grep -qE '^(stage-|fix-|remediation-|visible-)'; then
            echo "FAIL: Spec name contains forbidden prefix: $name in $dir"
            error=1
        fi
    fi
done
shopt -u nullglob 2>/dev/null || true
if [ "$error" -eq 1 ]; then exit 1; fi

echo "=== All checks passed ==="
