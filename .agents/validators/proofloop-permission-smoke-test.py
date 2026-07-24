"""
proofloop-permission-smoke-test.py

Verifies Brain and other Agent path permissions match expected rules.

Usage: python proofloop-permission-smoke-test.py [--path <root-path>]
"""

import sys
from pathlib import Path


def check_agent_permissions(agent_file: Path) -> list:
    """Check that an agent's permission model is well-formed."""
    issues = []
    text = agent_file.read_text(encoding="utf-8")

    if "permission:" not in text:
        issues.append(f"{agent_file.name}: Missing permission section")
        return issues

    # Check for edit permissions
    if "edit:" in text:
        # Extract edit section
        edit_section = text.split("edit:")[-1].split("  ")[0] if "edit:" in text else ""
        if "allow" in text.split("edit:")[1].split("\n")[0] if "edit:" in text else "":
            issues.append(f"{agent_file.name}: Has edit: allow at top level")

    return issues


def check_brain_permissions(root: Path) -> list:
    """Check Brain-specific permission rules."""
    issues = []
    brain_file = root / ".opencode" / "agents" / "brain.md"
    if not brain_file.exists():
        issues.append("brain.md not found")
        return issues

    text = brain_file.read_text(encoding="utf-8")

    # Brain must deny delivery/stages access
    if "delivery/stages/**" not in text and "deny" in text:
        issues.append("Brain: Should deny delivery/stages/ edit access")

    # Brain must allow tech-spec access
    if "tech-spec" not in text:
        issues.append("Brain: Should have tech-spec/ in its permission scope")

    return issues


def check_worker_permissions(root: Path) -> list:
    """Check Worker has edit access."""
    issues = []
    worker_file = root / ".opencode" / "agents" / "worker.md"
    if not worker_file.exists():
        issues.append("worker.md not found")
        return issues

    text = worker_file.read_text(encoding="utf-8")
    if "edit: allow" not in text:
        issues.append("Worker: Should have edit: allow")

    return issues


def check_cv_permissions(root: Path) -> list:
    """Check CV does NOT have edit access."""
    issues = []
    cv_file = root / ".opencode" / "agents" / "code-verifier.md"
    if not cv_file.exists():
        issues.append("code-verifier.md not found")
        return issues

    text = cv_file.read_text(encoding="utf-8")
    if "edit: allow" in text:
        issues.append("CV: Should NOT have edit: allow")

    return issues


def check_committer_permissions(root: Path) -> list:
    """Check Committer has git commit access."""
    issues = []
    committer_file = root / ".opencode" / "agents" / "committer.md"
    if not committer_file.exists():
        issues.append("committer.md not found")
        return issues

    text = committer_file.read_text(encoding="utf-8")
    if "git commit" not in text:
        issues.append("Committer: Should have git commit permission")

    return issues


def main():
    root = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--path" else Path.cwd()
    print(f"Permission smoke test for: {root}\n")

    all_issues = []
    all_issues.extend(check_brain_permissions(root))
    all_issues.extend(check_worker_permissions(root))
    all_issues.extend(check_cv_permissions(root))
    all_issues.extend(check_committer_permissions(root))

    # Check all agent files
    agent_dir = root / ".opencode" / "agents"
    if agent_dir.exists():
        for agent_file in sorted(agent_dir.glob("*.md")):
            all_issues.extend(check_agent_permissions(agent_file))

    if all_issues:
        print(f"Found {len(all_issues)} permission issue(s):")
        for issue in all_issues:
            print(f"  - {issue}")
        sys.exit(1)
    else:
        print("All permission checks passed.")
        sys.exit(0)


if __name__ == "__main__":
    main()