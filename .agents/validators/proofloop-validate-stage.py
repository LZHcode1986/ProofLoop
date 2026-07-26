"""
proofloop-validate-stage.py

Validates Stage plan mechanical facts:
- Required sections present
- Slice ID uniqueness
- DAG acyclicity
- Each Slice has Goal, Outcome, Public Seam, TDD, Tasks, Closure
- Blocking Hard Parts are VALIDATED
- Slice→Stage Closure covers all Outcomes

Usage: python proofloop-validate-stage.py --stage <stage-id> [--path <root-path>]
"""

import re
import sys
from pathlib import Path


def load_stage_doc(stage_path: Path) -> str:
    if not stage_path.exists():
        print(f"ERROR: {stage_path} not found")
        sys.exit(1)
    return stage_path.read_text(encoding="utf-8")


def check_required_sections(text: str, stage_id: str) -> list:
    required = [
        "Stage Goal",
        "Observable Outcomes",
        "Authority References",
        "Dependencies",
        "Constraints",
        "Out of Scope",
        "Blocking Hard Parts",
        "Slice Graph",
        "Task Acceptance Matrix References",
        "Slice → Stage Closure",
        "Stage Runtime Proof",
    ]
    missing = [s for s in required if s not in text]
    return [f"Missing section: {s}" for s in missing]


def check_slice_ids(text: str) -> list:
    issues = []
    slices = re.findall(r"<!-- SLICE:(S\d+(?:-\w+)?):BEGIN -->", text)
    seen = {}
    for s in slices:
        if s in seen:
            issues.append(f"Duplicate Slice ID: {s}")
        seen[s] = True
    return issues


def check_slice_completeness(text: str) -> list:
    issues = []
    slice_blocks = re.findall(
        r"<!-- SLICE:(S\d+(?:-\w+)?):BEGIN -->(.*?)<!-- SLICE:\1:END -->",
        text,
        re.DOTALL,
    )
    for slice_id, block in slice_blocks:
        required = ["Goal", "Observable Outcome", "Public Seam", "Required Skills", "Seam Status", "TDD Proof Plan", "Tasks", "Matrix References", "Task → Slice Closure"]
        for section in required:
            if section not in block:
                issues.append(f"{slice_id}: Missing section '{section}'")
    return issues


def check_dag(text: str) -> list:
    """Full DAG cycle detection using Kahn's algorithm."""
    issues = []
    slices = re.findall(
        r"<!-- SLICE:(S\d+(?:-\w+)?):BEGIN -->(.*?)<!-- SLICE:\1:END -->",
        text,
        re.DOTALL,
    )
    if not slices:
        return issues

    adj = {sid: [] for sid, _ in slices}
    all_ids = set(adj.keys())

    for slice_id, block in slices:
        deps_section = block.split("### Dependencies")[-1].split("###")[0] if "### Dependencies" in block else ""
        dep_ids = set(re.findall(r"S\d+(?:-\w+)?", deps_section)) & all_ids
        for dep in dep_ids:
            if dep == slice_id:
                issues.append(f"{slice_id}: Self-referencing dependency")
            else:
                adj[dep].append(slice_id)

    in_degree = {sid: 0 for sid in adj}
    for sid in adj:
        for neighbor in adj[sid]:
            in_degree[neighbor] = in_degree.get(neighbor, 0) + 1

    queue = [sid for sid, deg in in_degree.items() if deg == 0]
    sorted_count = 0
    while queue:
        node = queue.pop(0)
        sorted_count += 1
        for neighbor in adj[node]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    if sorted_count != len(adj):
        in_cycle = [sid for sid, deg in in_degree.items() if deg > 0]
        issues.append(f"DAG cycle detected: participating Slices: {', '.join(sorted(in_cycle))}")

    return issues


def check_hard_parts(text: str, root: Path) -> list:
    """Check that blocking Hard Parts are VALIDATED or DEFERRED with Brain acceptance."""
    issues = []
    hp_section = text.split("Blocking Hard Parts")[-1].split("---")[0] if "Blocking Hard Parts" in text else ""
    hp_ids = re.findall(r"HP-\d+", hp_section)
    if not hp_ids:
        return issues

    register_path = root / "tech-spec" / "hard-parts-register.md"
    if not register_path.exists():
        issues.append(f"Hard Parts register not found at {register_path}")
        return issues

    register_text = register_path.read_text(encoding="utf-8")

    # Find column indices by header names
    header_line = ""
    for line in register_text.splitlines():
        if line.startswith("| ID |"):
            header_line = line
            break

    if not header_line:
        issues.append("hard-parts-register.md: Missing header row starting with '| ID |'")
        return issues

    headers = [h.strip().lower() for h in header_line.split("|")]
    try:
        id_idx = headers.index("id")
    except ValueError:
        issues.append("hard-parts-register.md: Missing 'ID' column in header")
        return issues

    # Find Status column index
    status_idx = None
    deferral_idx = None
    risk_idx = None
    for i, h in enumerate(headers):
        if h == "status":
            status_idx = i
        if "deferral" in h or "approval" in h:
            deferral_idx = i
        if "residual" in h or "risk" in h:
            risk_idx = i

    status_map = {}
    deferral_map = {}
    risk_map = {}
    for line in register_text.splitlines():
        if not line.startswith("|") or "|" not in line[1:]:
            continue
        cols = [c.strip() for c in line.split("|")]
        if len(cols) <= id_idx:
            continue
        hp_id = cols[id_idx].strip()
        if not re.match(r"^HP-\d+$", hp_id):
            continue
        if status_idx and len(cols) > status_idx:
            status_map[hp_id] = cols[status_idx].strip()
        if deferral_idx and len(cols) > deferral_idx:
            deferral_map[hp_id] = cols[deferral_idx].strip()
        if risk_idx and len(cols) > risk_idx:
            risk_map[hp_id] = cols[risk_idx].strip()

    for hp_id in hp_ids:
        if hp_id not in status_map:
            issues.append(f"{hp_id}: referenced in Stage but not found in hard-parts-register.md")
            continue
        status = status_map[hp_id]
        if status not in ("VALIDATED", "DEFERRED"):
            issues.append(f"{hp_id}: status is '{status}', must be VALIDATED or DEFERRED")
        elif status == "DEFERRED":
            deferral = deferral_map.get(hp_id, "")
            risk = risk_map.get(hp_id, "")
            if not deferral:
                issues.append(f"{hp_id}: DEFERRED but missing Deferral approval (Brain acceptance required)")
            elif "accept" not in deferral.lower():
                issues.append(f"{hp_id}: DEFERRED but Deferral approval does not mention Brain acceptance")
            if not risk:
                issues.append(f"{hp_id}: DEFERRED but missing Residual risk documentation")

    return issues


def check_outcome_coverage(text: str) -> list:
    """Check if Slice→Stage Closure references all Outcomes."""
    issues = []
    outcomes = re.findall(r"OUT-\w+-\d+", text.split("Observable Outcomes")[-1].split("---")[0] if "Observable Outcomes" in text else "")
    closure = text.split("Slice → Stage Closure")[-1] if "Slice → Stage Closure" in text else ""
    for outcome in outcomes:
        if outcome not in closure:
            issues.append(f"Outcome {outcome} not covered in Slice → Stage Closure")
    return issues


def check_matrix_id_existence(text: str, root: Path) -> list:
    """Check all Matrix IDs in Stage References exist in task-acceptance-matrix.md."""
    issues = []
    matrix_path = root / "tech-spec" / "task-acceptance-matrix.md"
    if not matrix_path.exists():
        issues.append(f"task-acceptance-matrix.md not found at {matrix_path}")
        return issues

    matrix_text = matrix_path.read_text(encoding="utf-8")

    # Parse actual Task IDs from the ## Matrix section only
    actual_ids = set()
    if "## Matrix" in matrix_text:
        start = matrix_text.index("## Matrix")
        rest = matrix_text[start + len("## Matrix"):]
        lines = rest.splitlines()
        end = len(rest)
        for i, line in enumerate(lines):
            if line.startswith("## ") and "## Matrix" not in line:
                end = len("\n".join(lines[:i]))
                break
        matrix_section = rest[:end]
        in_table = False
        for line in matrix_section.splitlines():
            if line.startswith("| Task ID |"):
                in_table = True
                continue
            if in_table and line.startswith("|---"):
                continue
            if in_table and line.startswith("|") and "|" in line[1:]:
                cols = [c.strip() for c in line.split("|")]
                if len(cols) >= 2 and cols[1]:
                    actual_ids.add(cols[1])

    # Parse Stage Matrix References
    stage_section = text.split("## Task Acceptance Matrix References")[-1]
    if "##" in stage_section:
        stage_section = stage_section.split("##")[0]
    stage_ids = set()
    for line in stage_section.splitlines():
        if line.strip().startswith("-"):
            parts = line.strip().split()
            if len(parts) >= 2:
                stage_ids.add(parts[1])

    # Bidirectional set constraints:
    # 1. Stage IDs must be non-empty (if architecture has tasks)
    if not stage_ids and actual_ids:
        issues.append("Stage has no Task Acceptance Matrix References but architecture matrix defines tasks")

    # 2. stage_ids ⊆ actual_ids  (Stage cannot reference non-existent architecture tasks)
    for sid in sorted(stage_ids):
        if sid not in actual_ids:
            issues.append(f"{sid}: referenced in Stage Matrix References but not found in task-acceptance-matrix.md")

    return issues


def check_matrix_slice_coverage(text: str) -> list:
    """Enforce bidirectional set constraints: slice_ids ⊆ stage_ids and stage_ids ⊆ slice_ids."""
    issues = []
    # Parse Stage Matrix References
    stage_section = text.split("## Task Acceptance Matrix References")[-1]
    if "##" in stage_section:
        stage_section = stage_section.split("##")[0]
    stage_ids = set()
    for line in stage_section.splitlines():
        if line.strip().startswith("-"):
            parts = line.strip().split()
            if len(parts) >= 2:
                stage_ids.add(parts[1])

    # Parse all Slice Matrix References
    slice_blocks = re.findall(r"<!-- SLICE:(S\d+(?:-\w+)?):BEGIN -->(.*?)<!-- SLICE:\1:END -->", text, re.DOTALL)
    slice_ids = set()
    for slice_id, block in slice_blocks:
        ref_section = block.split("### Matrix References")[-1]
        if "###" in ref_section:
            ref_section = ref_section.split("###")[0]
        for line in ref_section.splitlines():
            if line.strip().startswith("-"):
                parts = line.strip().split()
                if len(parts) >= 2:
                    slice_ids.add(parts[1])

    # slice_ids ⊆ stage_ids:  Slice cannot reference tasks not in Stage
    for sid in sorted(slice_ids):
        if sid not in stage_ids:
            issues.append(f"{sid}: referenced in Slice Matrix References but not in Stage Matrix References")

    # stage_ids ⊆ slice_ids:  Every Stage task must be covered by at least one Slice
    for sid in sorted(stage_ids):
        if sid not in slice_ids:
            issues.append(f"{sid}: defined in Stage Matrix References but not referenced by any Slice")

    return issues


def check_matrix_closure_coverage(text: str) -> list:
    """Check that Slices referencing Matrix items appear in Slice→Stage Closure."""
    issues = []
    slice_blocks = re.findall(r"<!-- SLICE:(S\d+(?:-\w+)?):BEGIN -->(.*?)<!-- SLICE:\1:END -->", text, re.DOTALL)
    slice_ids = set()
    for slice_id, block in slice_blocks:
        ref_section = block.split("### Matrix References")[-1]
        if "###" in ref_section:
            ref_section = ref_section.split("###")[0]
        has_ref = any(line.strip().startswith("-") for line in ref_section.splitlines())
        if has_ref:
            slice_ids.add(slice_id)

    closure = text.split("## Slice → Stage Closure")[-1] if "## Slice → Stage Closure" in text else ""
    for sid in sorted(slice_ids):
        if sid not in closure:
            issues.append(f"{sid}: references Matrix items but not covered in Slice → Stage Closure")
    return issues


def check_required_skills(text: str) -> list:
    issues = []
    slice_blocks = re.findall(
        r"<!-- SLICE:(S\d+(?:-\w+)?):BEGIN -->(.*?)<!-- SLICE:\1:END -->",
        text,
        re.DOTALL,
    )
    allowed_skills = {"test-driven-development", "None"}
    for slice_id, block in slice_blocks:
        skills_section = block.split("### Required Skills")[-1].split("###")[0] if "### Required Skills" in block else ""
        skills_found = set(re.findall(r"- (\S+)", skills_section))
        for skill in skills_found:
            if skill not in allowed_skills:
                issues.append(f"{slice_id}: Unknown or deprecated skill '{skill}'. Allowed: {', '.join(sorted(allowed_skills))}")
        # When test-driven-development is used, must have Public Seam, Seam Status, TDD Proof Plan
        if "test-driven-development" in skills_found:
            if "Public Seam" not in block:
                issues.append(f"{slice_id}: Required Skills includes test-driven-development but missing Public Seam")
            if "Seam Status" not in block:
                issues.append(f"{slice_id}: Required Skills includes test-driven-development but missing Seam Status")
            if "PRE_AGREED" not in block:
                issues.append(f"{slice_id}: Required Skills includes test-driven-development but Seam Status is not PRE_AGREED")
            if "TDD Proof Plan" not in block:
                issues.append(f"{slice_id}: Required Skills includes test-driven-development but missing TDD Proof Plan")
    return issues


def main():
    if "--stage" not in sys.argv:
        print("Usage: python proofloop-validate-stage.py --stage <stage-id> [--path <root-path>]")
        sys.exit(1)

    stage_idx = sys.argv.index("--stage")
    stage_id = sys.argv[stage_idx + 1]
    root = Path(sys.argv[sys.argv.index("--path") + 1]) if "--path" in sys.argv else Path.cwd()

    stage_path = root / "delivery" / "stages" / stage_id / "tasks.md"
    if not stage_path.exists():
        # Try alternate: stage_id may be a full path
        stage_path = root / "delivery" / "stages" / stage_id / "tasks.md"

    if not stage_path.exists():
        print(f"ERROR: Stage file not found at {stage_path}")
        sys.exit(1)

    text = load_stage_doc(stage_path)
    all_issues = []
    all_issues.extend(check_required_sections(text, stage_id))
    all_issues.extend(check_slice_ids(text))
    all_issues.extend(check_slice_completeness(text))
    all_issues.extend(check_dag(text))
    all_issues.extend(check_hard_parts(text, root))
    all_issues.extend(check_outcome_coverage(text))
    all_issues.extend(check_matrix_id_existence(text, root))
    all_issues.extend(check_matrix_slice_coverage(text))
    all_issues.extend(check_matrix_closure_coverage(text))
    all_issues.extend(check_required_skills(text))

    if all_issues:
        print(f"Stage {stage_id} validation FAILED:")
        for issue in all_issues:
            print(f"  - {issue}")
        sys.exit(1)
    else:
        print(f"Stage {stage_id} validation PASSED")
        sys.exit(0)


if __name__ == "__main__":
    main()