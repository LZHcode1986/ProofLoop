"""
proofloop-status.py

Read-only status summary of the current ProofLoop project state.

Usage: python proofloop-status.py [--path <root-path>]
"""

import re
import sys
from pathlib import Path


def read_progress_status(root: Path) -> dict:
    progress = root / "progress.md"
    if not progress.exists():
        return {"active_stage": "unknown", "overall_status": "unknown"}

    text = progress.read_text(encoding="utf-8")
    result = {}

    active = re.search(r"Active Stage:\s*(\S+)", text)
    status = re.search(r"Overall Status:\s*(\S+)", text)

    if active:
        result["active_stage"] = active.group(1)
    if status:
        result["overall_status"] = status.group(1)

    return result


def scan_stages(root: Path) -> list:
    stages_dir = root / "delivery" / "stages"
    if not stages_dir.exists():
        return []

    stages = []
    for stage_dir in sorted(stages_dir.iterdir()):
        if not stage_dir.is_dir():
            continue
        tasks = stage_dir / "tasks.md"
        evidence = stage_dir / "evidence.md"
        stage_info = {"id": stage_dir.name, "has_tasks": tasks.exists(), "has_evidence": evidence.exists()}

        if tasks.exists():
            text = tasks.read_text(encoding="utf-8")
            slices = re.findall(r"<!-- SLICE:(\S+):BEGIN -->", text)
            checked = re.findall(r"- \[x\]", text)
            total = re.findall(r"- \[.\]", text)
            stage_info["slices"] = slices
            stage_info["tasks_checked"] = len(checked)
            stage_info["tasks_total"] = len(total)

            status = re.search(r"Status:\s*(\S+)", text)
            stage_info["status"] = status.group(1) if status else "unknown"

        stages.append(stage_info)

    return stages


def check_git_state(root: Path) -> dict:
    """Check basic git state."""
    import subprocess
    result = {"branch": "unknown", "dirty": "unknown"}
    try:
        branch = subprocess.run(
            ["git", "branch", "--show-current"],
            capture_output=True, text=True, cwd=root
        )
        if branch.returncode == 0:
            result["branch"] = branch.stdout.strip()

        status = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True, text=True, cwd=root
        )
        if status.returncode == 0:
            result["dirty"] = "yes" if status.stdout.strip() else "no"
    except Exception:
        pass
    return result


def main():
    root = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--path" else Path.cwd()
    print(f"ProofLoop Status for: {root}\n")

    # Progress
    progress = read_progress_status(root)
    print("=== Project Status ===")
    print(f"  Active Stage: {progress.get('active_stage', 'unknown')}")
    print(f"  Overall Status: {progress.get('overall_status', 'unknown')}")

    # Git
    git = check_git_state(root)
    print(f"  Git Branch: {git['branch']}")
    print(f"  Git Dirty: {git['dirty']}")

    # Stages
    stages = scan_stages(root)
    print(f"\n=== Stages ({len(stages)}) ===")
    for s in stages:
        print(f"  {s['id']}: {s.get('status', 'unknown')} | "
              f"Tasks: {s.get('tasks_checked', 0)}/{s.get('tasks_total', 0)} | "
              f"Slices: {', '.join(s.get('slices', []))}")

    # Agent files
    agent_dir = root / ".opencode" / "agents"
    if agent_dir.exists():
        agents = [f.stem for f in agent_dir.glob("*.md")]
        print(f"\n=== Agents ({len(agents)}) ===")
        for a in sorted(agents):
            print(f"  {a}")

    # Contracts
    contracts_dir = root / ".agents" / "contracts"
    if contracts_dir.exists():
        contracts = list(contracts_dir.rglob("*.md"))
        print(f"\n=== Contracts ({len(contracts)}) ===")
        for c in sorted(contracts):
            print(f"  {c.relative_to(root)}")

    sys.exit(0)


if __name__ == "__main__":
    main()