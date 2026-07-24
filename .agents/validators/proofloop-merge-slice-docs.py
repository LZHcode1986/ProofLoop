"""
proofloop-merge-slice-docs.py

Merges a Slice branch's marker region into the latest Stage branch.
Only the current Slice region is taken from the Slice branch; all other regions
come from the Stage branch.

Usage: python proofloop-merge-slice-docs.py --slice <slice-id> --stage-file <path> --slice-file <path>
"""

import re
import sys
from pathlib import Path


def replace_region(text: str, marker_type: str, slice_id: str, new_content: str) -> str:
    """Replace the content between markers with new content."""
    pattern = rf"(<!-- {marker_type}:{slice_id}:BEGIN -->).*?(<!-- {marker_type}:{slice_id}:END -->)"
    replacement = rf"\1{new_content}\2"
    result = re.sub(pattern, replacement, text, count=1, flags=re.DOTALL)
    return result


def extract_region_content(text: str, marker_type: str, slice_id: str) -> str | None:
    """Extract content between markers (excluding the markers themselves)."""
    pattern = rf"<!-- {marker_type}:{slice_id}:BEGIN -->(.*?)<!-- {marker_type}:{slice_id}:END -->"
    match = re.search(pattern, text, re.DOTALL)
    return match.group(1) if match else None


def main():
    if not all(f in sys.argv for f in ["--slice", "--stage-file", "--slice-file"]):
        print("Usage: python proofloop-merge-slice-docs.py --slice <slice-id> --stage-file <path> --slice-file <path>")
        sys.exit(1)

    slice_idx = sys.argv.index("--slice")
    slice_id = sys.argv[slice_idx + 1]

    stage_idx = sys.argv.index("--stage-file")
    stage_path = Path(sys.argv[stage_idx + 1])

    slice_idx2 = sys.argv.index("--slice-file")
    slice_path = Path(sys.argv[slice_idx2 + 1])

    if not stage_path.exists():
        print(f"ERROR: Stage file {stage_path} not found")
        sys.exit(1)
    if not slice_path.exists():
        print(f"ERROR: Slice file {slice_path} not found")
        sys.exit(1)

    stage_text = stage_path.read_text(encoding="utf-8")
    slice_text = slice_path.read_text(encoding="utf-8")

    # Determine file type from name
    marker_type = "SLICE" if "tasks" in stage_path.name else "EVIDENCE"

    # Extract current Slice content from Slice branch
    slice_content = extract_region_content(slice_text, marker_type, slice_id)
    if slice_content is None:
        print(f"ERROR: Slice {slice_id} not found in {slice_path}")
        sys.exit(1)

    # Check that the Stage branch has the same markers
    if f"<!-- {marker_type}:{slice_id}:BEGIN -->" not in stage_text:
        print(f"ERROR: Slice {slice_id} markers not found in Stage branch file {stage_path}")
        sys.exit(1)

    # Replace the region in the Stage branch file
    result = replace_region(stage_text, marker_type, slice_id, slice_content)

    # Verify the result still has valid markers
    if f"<!-- {marker_type}:{slice_id}:BEGIN -->" not in result:
        print("ERROR: Merge produced invalid markers")
        sys.exit(1)

    # Write the result
    stage_path.write_text(result, encoding="utf-8")
    print(f"Merged Slice {slice_id} into {stage_path}")
    sys.exit(0)


if __name__ == "__main__":
    main()