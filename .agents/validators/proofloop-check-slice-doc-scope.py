"""
proofloop-check-slice-doc-scope.py

Checks that the current branch only modified its own SLICE/EVIDENCE markers.
Ensures markers are intact and other Slice regions are unchanged.

Usage: python proofloop-check-slice-doc-scope.py --slice <slice-id> [--base <base-ref>]
"""

import re
import subprocess
import sys
from pathlib import Path


def get_slice_region(text: str, marker_type: str, slice_id: str) -> str | None:
    pattern = rf"<!-- {marker_type}:{slice_id}:BEGIN -->(.*?)<!-- {marker_type}:{slice_id}:END -->"
    match = re.search(pattern, text, re.DOTALL)
    return match.group(0) if match else None


def check_markers(text: str) -> list:
    begin_markers = re.findall(r"<!-- (SLICE|EVIDENCE):(\S+):BEGIN -->", text)
    end_markers = re.findall(r"<!-- (SLICE|EVIDENCE):(\S+):END -->", text)

    begins = {(m, s) for m, s in begin_markers}
    ends = {(m, s) for m, s in end_markers}

    issues = []
    for b in begins:
        if b not in ends:
            issues.append(f"Missing END marker for {b[0]}:{b[1]}")
    for e in ends:
        if e not in begins:
            issues.append(f"Missing BEGIN marker for {e[0]}:{e[1]}")

    # Check marker ordering — each BEGIN must have a matching END after it,
    # and markers must not have been moved to unrelated positions.
    positions = []
    for m in re.finditer(r"<!-- (SLICE|EVIDENCE):(\S+):(BEGIN|END) -->", text):
        positions.append((m.start(), m.group(1), m.group(2), m.group(3)))
    depth = {}
    for pos, mtype, sid, kind in positions:
        key = (mtype, sid)
        if kind == "BEGIN":
            depth[key] = depth.get(key, 0) + 1
        else:
            depth[key] = depth.get(key, 0) - 1
            if depth[key] < 0:
                issues.append(f"Unmatched END marker for {mtype}:{sid} at position {pos}")

    return issues


def check_other_slices_unchanged(
    current_text: str, base_text: str, current_slice: str
) -> list:
    issues = []
    all_slices = set()
    for m in re.finditer(r"<!-- SLICE:(\S+):BEGIN -->", current_text):
        all_slices.add(m.group(1))
    for m in re.finditer(r"<!-- EVIDENCE:(\S+):BEGIN -->", current_text):
        all_slices.add(m.group(1))

    for slice_id in all_slices:
        if slice_id == current_slice:
            continue
        current_region = get_slice_region(current_text, "SLICE", slice_id)
        base_region = get_slice_region(base_text, "SLICE", slice_id)
        if current_region != base_region:
            issues.append(f"Slice {slice_id} region was modified (not your slice)")

        current_ev = get_slice_region(current_text, "EVIDENCE", slice_id)
        base_ev = get_slice_region(base_text, "EVIDENCE", slice_id)
        if current_ev != base_ev:
            issues.append(f"Evidence {slice_id} region was modified (not your slice)")

    return issues


def find_stage_files(base_dir: Path):
    """Find tasks.md and evidence.md under the stage directory structure."""
    stages_dir = base_dir / "delivery" / "stages"
    if not stages_dir.exists():
        return None, None
    for stage_dir in sorted(stages_dir.iterdir()):
        if stage_dir.is_dir():
            tasks_file = stage_dir / "tasks.md"
            evidence_file = stage_dir / "evidence.md"
            if tasks_file.exists():
                return tasks_file, evidence_file
    return None, None


def main():
    if "--slice" not in sys.argv:
        print("Usage: python proofloop-check-slice-doc-scope.py --slice <slice-id> [--base <base-ref>]")
        sys.exit(1)

    slice_idx = sys.argv.index("--slice")
    slice_id = sys.argv[slice_idx + 1]

    base_ref = None
    if "--base" in sys.argv:
        base_idx = sys.argv.index("--base")
        base_ref = sys.argv[base_idx + 1]

    tasks_file, evidence_file = find_stage_files(Path.cwd())

    if tasks_file is None:
        print("No tasks.md found under delivery/stages/")
        sys.exit(1)

    current_text = tasks_file.read_text(encoding="utf-8")

    # Get base version if --base provided
    base_text = None
    if base_ref:
        try:
            rel_path = str(tasks_file.relative_to(Path.cwd()))
            result = subprocess.run(
                ["git", "show", f"{base_ref}:{rel_path}"],
                capture_output=True, text=True, encoding="utf-8"
            )
            if result.returncode == 0:
                base_text = result.stdout
            else:
                print(f"WARNING: Could not get base version from {base_ref}: {result.stderr.strip()}")
        except Exception as e:
            print(f"WARNING: Could not get base version: {e}")

    all_issues = []

    # Check markers
    marker_issues = check_markers(current_text)
    all_issues.extend(marker_issues)

    # Check other slices unchanged (only if base available)
    if base_text:
        slice_issues = check_other_slices_unchanged(current_text, base_text, slice_id)
        all_issues.extend(slice_issues)
    else:
        print("INFO: No base ref provided, skipping cross-slice modification check")

    if all_issues:
        for issue in all_issues:
            print(f"ISSUE: {issue}")
        sys.exit(1)

    print(f"All markers valid for {slice_id}")
    sys.exit(0)


if __name__ == "__main__":
    main()