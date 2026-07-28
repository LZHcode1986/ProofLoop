"""
proofloop-validate-authority.py

Validates authority document mechanical facts:
- ID uniqueness across documents
- Reference existence
- Canonical Type consistency
- Hard Part ref validity

Usage: python proofloop-validate-authority.py [--path <root-path>]

DEPRECATED: This Python validator will be removed after TypeScript equivalence is verified.
See .agents/runtime/ for the TypeScript replacement.
"""

import re
import sys
from pathlib import Path


ID_PATTERNS = {
    "CAP-\\d+": "PRD capability",
    "FLOW-\\d+": "PRD flow",
    "FR-\\d+": "functional requirement",
    "AC-\\d+": "acceptance criteria",
    "NFR-\\d+": "non-functional requirement",
    "SEC-\\d+": "security requirement",
    "HP-\\d+": "hard part",
    "TYPE-\\w+": "canonical type",
    "OUT-\\w+-\\d+": "observable outcome",
    "AWI-\\d+": "architecture work item",
}


def is_definition_line(line: str, id_val: str) -> bool:
    """Check if a line contains an ID definition (not just a reference)."""
    stripped = line.strip()
    if stripped.startswith(f"### {id_val}") or stripped.startswith(f"## {id_val}"):
        return True
    if stripped.startswith(f"| {id_val} ") or stripped.startswith(f"|{id_val} "):
        return True
    if re.match(rf"^\*\*{re.escape(id_val)}\*\*", stripped):
        return True
    if re.match(rf"^- {re.escape(id_val)}:", stripped):
        return True
    return False


def collect_definitions(root: Path) -> dict:
    """Collect IDs that are defined (not just referenced) in authority documents."""
    ids = {}
    authority_files = []
    for p in [root / "CONTEXT.md", root / "PRD.md"]:
        if p.exists():
            authority_files.append(p)
    authority_files.extend((root / "tech-spec").rglob("*.md"))
    authority_files.extend((root / "delivery" / "stages").rglob("*.md"))
    for md_file in authority_files:
        if ".git" in md_file.parts:
            continue
        text = md_file.read_text(encoding="utf-8")
        for pattern, category in ID_PATTERNS.items():
            for match in re.finditer(pattern, text):
                id_val = match.group(0)
                line_start = text.rfind("\n", 0, match.start()) + 1
                line_end = text.find("\n", match.end())
                if line_end == -1:
                    line_end = len(text)
                line = text[line_start:line_end]
                if is_definition_line(line, id_val):
                    if id_val not in ids:
                        ids[id_val] = []
                    ids[id_val].append((category, str(md_file.relative_to(root))))
    return ids


def check_duplicates(defs: dict) -> list:
    """Check for duplicate IDs defined in multiple files."""
    issues = []
    for id_val, occurrences in defs.items():
        files = [f for _, f in occurrences]
        if len(set(files)) > 1:
            issues.append(
                f"DUPLICATE: {id_val} defined in multiple files: {files}"
            )
    return issues


def check_refs(root: Path, defs: dict) -> list:
    """Check that references point to defined IDs."""
    issues = []
    defined_ids = set(defs.keys())

    authority_files = []
    for p in [root / "CONTEXT.md", root / "PRD.md"]:
        if p.exists():
            authority_files.append(p)
    authority_files.extend((root / "tech-spec").rglob("*.md"))
    authority_files.extend((root / "delivery" / "stages").rglob("*.md"))
    for md_file in authority_files:
        if ".git" in md_file.parts:
            continue
        text = md_file.read_text(encoding="utf-8")
        for match in re.finditer(r"\[([A-Z]+-\d+)\]", text):
            ref = match.group(1)
            if ref not in defined_ids:
                issues.append(
                    f"MISSING REF: {ref} referenced in {md_file.relative_to(root)} but not defined"
                )

    return issues


def check_canonical_types(root: Path) -> list:
    """Check canonical type definitions for consistency."""
    issues = []
    type_pattern = re.compile(r"\| (TYPE-\w+) \| .+ \| (\w+) \|")

    types_found = {}
    authority_files = []
    for p in [root / "CONTEXT.md", root / "PRD.md"]:
        if p.exists():
            authority_files.append(p)
    authority_files.extend((root / "tech-spec").rglob("*.md"))
    authority_files.extend((root / "delivery" / "stages").rglob("*.md"))
    for md_file in authority_files:
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

    defs = collect_definitions(root)
    duplicates = check_duplicates(defs)
    ref_issues = check_refs(root, defs)
    type_issues = check_canonical_types(root)

    all_issues = duplicates + ref_issues + type_issues

    if all_issues:
        print(f"\nFound {len(all_issues)} issue(s):")
        for issue in all_issues:
            print(f"  - {issue}")
        sys.exit(1)
    else:
        print(f"\nAll checks passed ({len(defs)} IDs defined).")
        sys.exit(0)


if __name__ == "__main__":
    main()