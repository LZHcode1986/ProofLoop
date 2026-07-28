"""
proofloop-check-slice-doc-scope.py

Checks that the current branch only modified its own SLICE/EVIDENCE markers.
Ensures markers are unique, properly ordered, and non-slice regions unchanged.

Usage: python proofloop-check-slice-doc-scope.py --stage <stage-id> --slice <slice-id> --base <base-ref>

DEPRECATED: This Python validator will be removed after TypeScript equivalence is verified.
See .agents/runtime/ for the TypeScript replacement.
"""

import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path


def get_base_text(base_ref: str, file_path: Path, cwd: Path) -> str:
    rel_path = str(file_path.relative_to(cwd))
    result = subprocess.run(
        ["git", "show", f"{base_ref}:{rel_path}"],
        capture_output=True, text=True, encoding="utf-8"
    )
    if result.returncode != 0:
        print(f"FATAL: Cannot read base version from {base_ref}:{rel_path}: {result.stderr.strip()}")
        sys.exit(1)
    return result.stdout


def remove_marker_blocks(text: str, marker_type: str, slice_id: str) -> str:
    """Remove all marker blocks of the given type for the given slice."""
    escaped = re.escape(slice_id)
    pattern = rf"<!-- {marker_type}:{escaped}:BEGIN -->.*?<!-- {marker_type}:{escaped}:END -->"
    return re.sub(pattern, "", text, flags=re.DOTALL)


def find_all_markers(text: str) -> list[tuple[int, str, str, str]]:
    pattern = r"<!-- (SLICE|EVIDENCE):(\S+):(BEGIN|END) -->"
    return [(m.start(), m.group(1), m.group(2), m.group(3)) for m in re.finditer(pattern, text)]


def check_marker_integrity(text: str) -> list[str]:
    issues = []
    markers = find_all_markers(text)

    by_key = defaultdict(list)
    for pos, mtype, sid, kind in markers:
        by_key[(mtype, sid)].append((pos, kind))

    for (mtype, sid), entries in by_key.items():
        begins = [p for p, k in entries if k == "BEGIN"]
        ends = [p for p, k in entries if k == "END"]

        if len(begins) > 1:
            issues.append(f"Duplicate BEGIN markers for {mtype}:{sid} (found {len(begins)})")
        if len(ends) > 1:
            issues.append(f"Duplicate END markers for {mtype}:{sid} (found {len(ends)})")
        if len(begins) == 0:
            issues.append(f"Missing BEGIN marker for {mtype}:{sid}")
        if len(ends) == 0:
            issues.append(f"Missing END marker for {mtype}:{sid}")
        if len(begins) == 1 and len(ends) == 1 and begins[0] > ends[0]:
            issues.append(f"Marker {mtype}:{sid}: END appears before BEGIN")

    return issues


def check_target_marker_exists(text: str, marker_type: str, slice_id: str, label: str) -> list[str]:
    issues = []
    escaped = re.escape(slice_id)
    begin = re.search(rf"<!-- {marker_type}:{escaped}:BEGIN -->", text)
    end = re.search(rf"<!-- {marker_type}:{escaped}:END -->", text)
    if not begin:
        issues.append(f"{label}: Missing BEGIN marker for {marker_type}:{slice_id}")
    if not end:
        issues.append(f"{label}: Missing END marker for {marker_type}:{slice_id}")
    return issues


def get_marker_set(text: str) -> set[tuple[str, str]]:
    return {(mtype, sid) for _, mtype, sid, _ in find_all_markers(text)}


def check_non_slice_unchanged(
    current_text: str, base_text: str, slice_id: str, marker_type: str
) -> list[str]:
    stripped_current = remove_marker_blocks(current_text, marker_type, slice_id)
    stripped_base = remove_marker_blocks(base_text, marker_type, slice_id)
    if stripped_current != stripped_base:
        return [f"Non-{marker_type} regions differ from base (modified content outside your slice markers)"]
    return []


def main():
    if "--slice" not in sys.argv or "--base" not in sys.argv or "--stage" not in sys.argv:
        print("Usage: python proofloop-check-slice-doc-scope.py --stage <stage-id> --slice <slice-id> --base <base-ref>")
        sys.exit(1)

    slice_idx = sys.argv.index("--slice")
    slice_id = sys.argv[slice_idx + 1]

    base_idx = sys.argv.index("--base")
    base_ref = sys.argv[base_idx + 1]

    stage_idx = sys.argv.index("--stage")
    stage_id = sys.argv[stage_idx + 1]

    cwd = Path.cwd()
    stage_dir = cwd / "delivery" / "stages" / stage_id
    tasks_file = stage_dir / "tasks.md"
    evidence_file = stage_dir / "evidence.md"

    if not tasks_file.exists():
        print(f"FATAL: tasks.md not found at {tasks_file}")
        sys.exit(1)

    if not evidence_file.exists():
        print(f"FATAL: evidence.md not found at {evidence_file}")
        sys.exit(1)

    current_tasks = tasks_file.read_text(encoding="utf-8")
    current_evidence = evidence_file.read_text(encoding="utf-8")

    base_tasks = get_base_text(base_ref, tasks_file, cwd)
    base_evidence = get_base_text(base_ref, evidence_file, cwd)

    all_issues = []

    all_issues.extend(check_marker_integrity(current_tasks))
    all_issues.extend(check_marker_integrity(current_evidence))

    all_issues.extend(check_target_marker_exists(current_tasks, "SLICE", slice_id, "current tasks.md"))
    all_issues.extend(check_target_marker_exists(base_tasks, "SLICE", slice_id, "base tasks.md"))
    all_issues.extend(check_target_marker_exists(current_evidence, "EVIDENCE", slice_id, "current evidence.md"))
    all_issues.extend(check_target_marker_exists(base_evidence, "EVIDENCE", slice_id, "base evidence.md"))

    current_slice_markers = get_marker_set(current_tasks)
    base_slice_markers = get_marker_set(base_tasks)
    if current_slice_markers != base_slice_markers:
        added = current_slice_markers - base_slice_markers
        removed = base_slice_markers - current_slice_markers
        parts = []
        if added:
            parts.append(f"added {sorted(added)}")
        if removed:
            parts.append(f"removed {sorted(removed)}")
        all_issues.append(f"SLICE markers in tasks.md differ from base: {'; '.join(parts)}")

    current_evidence_markers = get_marker_set(current_evidence)
    base_evidence_markers = get_marker_set(base_evidence)
    if current_evidence_markers != base_evidence_markers:
        added = current_evidence_markers - base_evidence_markers
        removed = base_evidence_markers - current_evidence_markers
        parts = []
        if added:
            parts.append(f"added {sorted(added)}")
        if removed:
            parts.append(f"removed {sorted(removed)}")
        all_issues.append(f"EVIDENCE markers in evidence.md differ from base: {'; '.join(parts)}")

    all_issues.extend(check_non_slice_unchanged(current_tasks, base_tasks, slice_id, "SLICE"))
    all_issues.extend(check_non_slice_unchanged(current_evidence, base_evidence, slice_id, "EVIDENCE"))

    if all_issues:
        for issue in all_issues:
            print(f"ISSUE: {issue}")
        sys.exit(1)

    print(f"All markers valid for {slice_id}")
    sys.exit(0)


if __name__ == "__main__":
    main()