"""
proofloop-validate-authority.py

Validates authority document mechanical facts:
- ID uniqueness across documents
- Reference existence
- Canonical Type consistency
- Hard Part ref validity

Usage: python proofloop-validate-authority.py [--path <root-path>]
"""

import os
import re
import sys
from pathlib import Path


def collect_ids(root: Path) -> dict:
    """Collect all IDs from authority documents."""
    ids = {}
    patterns = {
        "CAP-\\d+": "PRD capability",
        "FLOW-\\d+": "PRD flow",
        "FR-\\d+": "functional requirement",
        "AC-\\d+": "acceptance criteria",
        "NFR-\\d+": "non-functional requirement",
        "SEC-\\d+": "security requirement",
        "HP-\\d+": "hard part",
        "TYPE-\\w+": "canonical type",
        "OUT-\\w+-\\d+": "observable outcome",
    }

    for md_file in root.rglob("*.md"):
        if ".git" in md_file.parts:
            continue
        text = md_file.read_text(encoding="utf-8")
        for pattern, category in patterns.items():
            for match in re.finditer(pattern, text):
                id_val = match.group(0)
                if id_val not in ids:
                    ids[id_val] = []
                ids[id_val].append((category, str(md_file.relative_to(root))))

    return ids


def check_duplicates(ids: dict) -> list:
    """Check for duplicate IDs across different categories."""
    issues = []
    for id_val, occurrences in ids.items():
        categories = set(c for c, _ in occurrences)
        files = [f for _, f in occurrences]
        if len(set(files)) > 1 and len(occurrences) > 1:
            # Same ID in different files is OK for refs, flag if different categories
            if len(categories) > 1:
                issues.append(
                    f"DUPLICATE: {id_val} used in multiple categories: {categories}"
                )
    return issues


def check_refs(root: Path) -> list:
    """Check that references point to existing IDs."""
    issues = []
    all_ids = set()

    for md_file in root.rglob("*.md"):
        if ".git" in md_file.parts:
            continue
        text = md_file.read_text(encoding="utf-8")
        for match in re.finditer(r"(CAP-\d+|FLOW-\d+|FR-\d+|AC-\d+|NFR-\d+|SEC-\d+|HP-\d+|TYPE-\w+|OUT-\w+-\d+)", text):
            all_ids.add(match.group(0))

    # Check inline refs like [CAP-001] or CAP-001 references
    for md_file in root.rglob("*.md"):
        if ".git" in md_file.parts:
            continue
        text = md_file.read_text(encoding="utf-8")
        for match in re.finditer(r"\[([A-Z]+-\d+)\]", text):
            ref = match.group(1)
            if ref not in all_ids:
                issues.append(
                    f"MISSING REF: {ref} referenced in {md_file.relative_to(root)} but not defined"
                )

    return issues


def check_canonical_types(root: Path) -> list:
    """Check canonical type definitions for consistency."""
    issues = []
    type_pattern = re.compile(r"\| (TYPE-\w+) \| .+ \| (\w+) \|")

    types_found = {}
    for md_file in root.rglob("*.md"):
        if ".git" in md_file.parts:
            continue
        text = md_file.read_text(encoding="utf-8")
        for match in type_pattern.finditer(text):
            type_id = match.group(1)
            code_type = match.group(2).lower()
            if type_id in types_found:
                prev_type = types_found[type_id]
                if prev_type != code_type:
                    issues.append(
                        f"TYPE CONFLICT: {type_id} defined as '{code_type}' in {md_file.relative_to(root)} but previously as '{prev_type}'"
                    )
            else:
                types_found[type_id] = code_type

    return issues


def main():
    root = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--path" else Path.cwd()
    print(f"Validating authority documents in: {root}")

    ids = collect_ids(root)
    duplicates = check_duplicates(ids)
    ref_issues = check_refs(root)
    type_issues = check_canonical_types(root)

    all_issues = duplicates + ref_issues + type_issues

    if all_issues:
        print(f"\nFound {len(all_issues)} issue(s):")
        for issue in all_issues:
            print(f"  - {issue}")
        sys.exit(1)
    else:
        print(f"\nAll checks passed ({len(ids)} IDs found).")
        sys.exit(0)


if __name__ == "__main__":
    main()