"""
proofloop-check-slice-doc-scope.py

Checks that the current branch only modified its own SLICE/EVIDENCE markers.
Ensures markers are unique, properly ordered, and non-slice regions unchanged.

Usage: python proofloop-check-slice-doc-scope.py --stage <stage-id> --slice <slice-id> --base <base-ref>
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


def check_non_slice_unchanged(
    current_text: str, base_text: str, slice_id: str, marker_type: str
) -> list[str]:
    stripped_current = remove_marker_blocks(current_text, marker_type, slice_id)
    stripped_base = remove_marker_blocks(base_text, marker_type, slice_id)
    if stripped_current != stripped_base:
        return [f"Non-{marker_type} regions differ from base (modified content outside your slice markers)"]
    return []


def main():
    if "--slice" not in sys.argv or "--base" not in sys.argv:
        print("Usage: python proofloop-check-slice-doc-scope.py --stage <stage-id> --slice <slice-id> --base <base-ref>")
        sys.exit(1)

    slice_idx = sys.argv.index("--slice")
    slice_id = sys.argv[slice_idx + 1]

    base_idx = sys.argv.index("--base")
    base_ref = sys.argv[base_idx + 1]

    stage_id = None
    if "--stage" in sys.argv:
        stage_idx = sys.argv.index("--stage")
        stage_id = sys.argv[stage_idx + 1]

    cwd = Path.cwd()
    stage_dir = cwd / "delivery" / "stages" / (stage_id or "")
    tasks_file = stage_dir / "tasks.md"
    evidence_file = stage_dir / "evidence.md"

    if not tasks_file.exists():
        print(f"FATAL: tasks.md not found at {tasks_file}")
        sys.exit(1)

    current_tasks = tasks_file.read_text(encoding="utf-8")
    current_evidence = evidence_file.read_text(encoding="utf-8") if evidence_file.exists() else None

    base_tasks = get_base_text(base_ref, tasks_file, cwd)
    base_evidence = get_base_text(base_ref, evidence_file, cwd) if evidence_file.exists() else None

    all_issues = []

    all_issues.extend(check_marker_integrity(current_tasks))
    if current_evidence:
        all_issues.extend(check_marker_integrity(current_evidence))

    all_issues.extend(check_non_slice_unchanged(current_tasks, base_tasks, slice_id, "SLICE"))
    if current_evidence and base_evidence:
        all_issues.extend(check_non_slice_unchanged(current_evidence, base_evidence, slice_id, "EVIDENCE"))

    if all_issues:
        for issue in all_issues:
            print(f"ISSUE: {issue}")
        sys.exit(1)

    print(f"All markers valid for {slice_id}")
    sys.exit(0)


if __name__ == "__main__":
    main()