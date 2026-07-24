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
        "Slice → Stage Closure",
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
        required = ["Goal", "Observable Outcome", "Public Seam", "TDD Proof Plan", "Tasks", "Task → Slice Closure"]
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
    """Check that blocking Hard Parts are VALIDATED in the register."""
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
    status_map = {}
    for line in register_text.splitlines():
        if line.startswith("|") and "|" in line[1:]:
            cols = [c.strip() for c in line.split("|")]
            if len(cols) >= 4:
                hp_id = cols[1].strip()
                status = cols[4].strip()
                if re.match(r"^HP-\d+$", hp_id):
                    status_map[hp_id] = status

    for hp_id in hp_ids:
        if hp_id not in status_map:
            issues.append(f"{hp_id}: referenced in Stage but not found in hard-parts-register.md")
        elif status_map[hp_id] != "VALIDATED":
            issues.append(f"{hp_id}: status is '{status_map[hp_id]}', must be VALIDATED")

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