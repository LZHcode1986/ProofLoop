"""
proofloop-extract-slice.py

Extracts the Worker/CV minimum context for a specific Slice from Stage documents.
Outputs a clean packet with only the relevant Slice region.

Usage: python proofloop-extract-slice.py --stage <stage-id> --slice <slice-id>
"""

import re
import sys
from pathlib import Path


def extract_region(text: str, marker_type: str, slice_id: str) -> str | None:
    pattern = rf"<!-- {marker_type}:{slice_id}:BEGIN -->(.*?)<!-- {marker_type}:{slice_id}:END -->"
    match = re.search(pattern, text, re.DOTALL)
    return match.group(0) if match else None


def extract_slice_tasks(tasks_text: str, slice_id: str):
    """Extract the Slice region from tasks.md."""
    region = extract_region(tasks_text, "SLICE", slice_id)
    if not region:
        return None

    result = {}
    result["region"] = region

    for field in ["Goal", "Observable Outcome", "Public Seam", "TDD Proof Plan", "Tasks", "Task → Slice Closure"]:
        if field == "Tasks":
            tasks_section = region.split("### Tasks")[-1].split("###")[0] if "### Tasks" in region else ""
            result["tasks"] = re.findall(r"- \[.\] (\S+)", tasks_section)
            result["completed_tasks"] = re.findall(r"- \[x\] (\S+)", tasks_section)
        else:
            value = region.split(f"### {field}")[-1].split("###")[0] if f"### {field}" in region else ""
            result[field.lower().replace(" ", "_")] = value.strip()

    return result


def extract_slice_evidence(evidence_text: str, slice_id: str) -> str | None:
    return extract_region(evidence_text, "EVIDENCE", slice_id)


def main():
    if "--slice" not in sys.argv:
        print("Usage: python proofloop-extract-slice.py --stage <stage-id> --slice <slice-id>")
        print("  or: python proofloop-extract-slice.py --path <tasks.md-path> --slice <slice-id>")
        sys.exit(1)

    slice_idx = sys.argv.index("--slice")
    slice_id = sys.argv[slice_idx + 1]

    if "--path" in sys.argv:
        path_idx = sys.argv.index("--path")
        tasks_path = Path(sys.argv[path_idx + 1])
    elif "--stage" in sys.argv:
        stage_idx = sys.argv.index("--stage")
        stage_id = sys.argv[stage_idx + 1]
        tasks_path = Path.cwd() / "delivery" / "stages" / stage_id / "tasks.md"
    else:
        # Auto-detect
        tasks_path = Path.cwd() / "delivery"
        for stage_dir in tasks_path.iterdir():
            if stage_dir.is_dir():
                tp = stage_dir / "tasks.md"
                if tp.exists():
                    tasks_path = tp
                    break

    evidence_path = tasks_path.parent / "evidence.md"

    if not tasks_path.exists():
        print(f"ERROR: {tasks_path} not found")
        sys.exit(1)

    tasks_text = tasks_path.read_text(encoding="utf-8")
    slice_data = extract_slice_tasks(tasks_text, slice_id)

    if not slice_data:
        print(f"ERROR: Slice {slice_id} not found in {tasks_path}")
        sys.exit(1)

    print(f"=== Slice {slice_id} Packet ===")
    print(f"\n--- Tasks ---")
    for t in slice_data.get("tasks", []):
        checked = "x" if t in slice_data.get("completed_tasks", []) else " "
        print(f"  [{checked}] {t}")

    print(f"\n--- Region ---")
    print(slice_data["region"])

    if evidence_path.exists():
        ev_text = evidence_path.read_text(encoding="utf-8")
        ev_region = extract_slice_evidence(ev_text, slice_id)
        if ev_region:
            print(f"\n--- Evidence ---")
            print(ev_region)

    sys.exit(0)


if __name__ == "__main__":
    main()