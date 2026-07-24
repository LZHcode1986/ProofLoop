"""
proofloop-permission-smoke-test.py

Verifies Agent path permissions match expected rules.

Usage: python proofloop-permission-smoke-test.py [--path <root-path>]
"""

import sys
from pathlib import Path


def get_yaml_section(text: str, section: str) -> str | None:
    """Extract a YAML section's value lines from frontmatter."""
    in_section = False
    lines = []
    indent = None
    for line in text.splitlines():
        if line.startswith("---"):
            continue
        if in_section:
            if indent is not None and not line.startswith(" " * (indent + 1)) and not line.startswith("  "):
                break
            lines.append(line)
        if line.startswith(f"{section}:"):
            in_section = True
            indent = len(line) - len(line.lstrip())
            rest = line[len(f"{section}:"):].strip()
            if rest:
                lines.append(rest)
    return "\n".join(lines) if lines else None


def check_planner_permissions(agent_dir: Path) -> list:
    issues = []
    planner_file = agent_dir / "planner.md"
    if not planner_file.exists():
        return issues
    text = planner_file.read_text(encoding="utf-8")
    edit_section = get_yaml_section(text, "  edit")
    if edit_section:
        lines = [l.strip() for l in edit_section.splitlines() if l.strip()]
        if lines and not lines[0].startswith('"*": deny'):
            issues.append("Planner: First edit rule must be '\"*\": deny'")
    return issues


def check_prototype_permissions(agent_dir: Path) -> list:
    issues = []
    prototype_file = agent_dir / "prototype.md"
    if not prototype_file.exists():
        return issues
    text = prototype_file.read_text(encoding="utf-8")

    edit_section = get_yaml_section(text, "  edit")
    if edit_section:
        lines = [l.strip() for l in edit_section.splitlines() if l.strip()]
        if lines and not lines[0].startswith('"*": deny'):
            issues.append("Prototype: First edit rule must be '\"*\": deny'")

    task_section = get_yaml_section(text, "  task")
    if task_section:
        lines = [l.strip() for l in task_section.splitlines() if l.strip()]
        if lines and not lines[0].startswith('"*": deny'):
            issues.append("Prototype: First task rule must be '\"*\": deny'")
        if not any('"researcher": allow' in l for l in lines):
            issues.append("Prototype: Must have 'researcher: allow' in task rules")

    return issues


def check_executor_permissions(agent_dir: Path) -> list:
    issues = []
    executor_file = agent_dir / "executor.md"
    if not executor_file.exists():
        return issues
    text = executor_file.read_text(encoding="utf-8")

    bash_section = get_yaml_section(text, "  bash")
    if bash_section:
        if not any('"git worktree *"' in l or "git worktree *" in l for l in bash_section.splitlines()):
            issues.append("Executor: Should have 'git worktree *' bash permission")

    edit_section = get_yaml_section(text, "  edit")
    if edit_section:
        lines = [l.strip() for l in edit_section.splitlines() if l.strip()]
        if lines and not lines[0].startswith('"*": deny'):
            issues.append("Executor: First edit rule must be '\"*\": deny'")

    return issues


def check_brain_permissions(root: Path) -> list:
    """Check Brain-specific permission rules."""
    issues = []
    brain_file = root / ".opencode" / "agents" / "brain.md"
    if not brain_file.exists():
        issues.append("brain.md not found")
        return issues

    text = brain_file.read_text(encoding="utf-8")

    if "delivery/stages/**" not in text and "deny" in text:
        issues.append("Brain: Should deny delivery/stages/ edit access")

    if "tech-spec" not in text:
        issues.append("Brain: Should have tech-spec/ in its permission scope")

    edit_section = get_yaml_section(text, "  edit")
    if edit_section:
        if not any('"**/*.md": allow' in l for l in edit_section.splitlines()):
            issues.append("Brain: Should have '**/*.md': allow in edit rules")

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
    """Check CV does NOT have edit access and bash is restricted."""
    issues = []
    cv_file = root / ".opencode" / "agents" / "code-verifier.md"
    if not cv_file.exists():
        issues.append("code-verifier.md not found")
        return issues

    text = cv_file.read_text(encoding="utf-8")
    if "edit: allow" in text:
        issues.append("CV: Should NOT have edit: allow")

    bash_section = get_yaml_section(text, "  bash")
    if bash_section:
        first_line = bash_section.splitlines()[0].strip() if bash_section.splitlines() else ""
        if first_line == "allow":
            issues.append("CV: bash should be restricted (not 'bash: allow')")

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

    agent_dir = root / ".opencode" / "agents"

    all_issues = []
    all_issues.extend(check_brain_permissions(root))
    all_issues.extend(check_worker_permissions(root))
    all_issues.extend(check_cv_permissions(root))
    all_issues.extend(check_committer_permissions(root))
    all_issues.extend(check_planner_permissions(agent_dir))
    all_issues.extend(check_prototype_permissions(agent_dir))
    all_issues.extend(check_executor_permissions(agent_dir))

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