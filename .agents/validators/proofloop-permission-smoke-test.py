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
        if any('"researcher": allow' in l for l in lines):
            issues.append("Prototype: Must NOT have 'researcher: allow' in task rules (Prototype no longer dispatches Researcher)")

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


def check_subagents_external_directory(root: Path) -> list:
    """Check Worker, SPV, CV, Committer all have external_directory: deny."""
    issues = []
    agents = ["worker", "stage-plan-verifier", "code-verifier", "committer"]
    names = {"worker": "Worker", "stage-plan-verifier": "SPV", "code-verifier": "CV", "committer": "Committer"}
    for agent in agents:
        file = root / ".opencode" / "agents" / f"{agent}.md"
        if not file.exists():
            issues.append(f"{names[agent]}: File not found")
            continue
        text = file.read_text(encoding="utf-8")
        if "external_directory: deny" not in text:
            issues.append(f"{names[agent]}: Missing external_directory: deny")
    return issues


def check_prototype_no_researcher(root: Path) -> list:
    """Prototype must not have researcher: allow in task."""
    issues = []
    file = root / ".opencode" / "agents" / "prototype.md"
    if not file.exists():
        return issues
    text = file.read_text(encoding="utf-8")
    task_section = get_yaml_section(text, "  task")
    if task_section:
        lines = [l.strip() for l in task_section.splitlines() if l.strip()]
        if not lines or not lines[0].startswith('"*": deny'):
            issues.append("Prototype: First task rule must be '\"*\": deny'")
        if any('"researcher": allow' in l for l in lines):
            issues.append("Prototype: Must NOT have 'researcher: allow' in task rules")
    else:
        issues.append("Prototype: Missing task section")
    return issues


def check_brain_only_researcher_general(root: Path) -> list:
    """Only Brain may have researcher: allow and general: allow in task."""
    issues = []
    brain_file = root / ".opencode" / "agents" / "brain.md"
    if not brain_file.exists():
        issues.append("brain.md not found")
        return issues
    brain_text = brain_file.read_text(encoding="utf-8")
    brain_task = get_yaml_section(brain_text, "  task")
    if not brain_task:
        issues.append("Brain: Missing task section")
        return issues
    if not any('"researcher": allow' in l for l in brain_task.splitlines()):
        issues.append("Brain: Missing 'researcher: allow' in task")
    if not any('"general": allow' in l for l in brain_task.splitlines()):
        issues.append("Brain: Missing 'general: allow' in task")

    agent_dir = root / ".opencode" / "agents"
    others = [f for f in agent_dir.iterdir() if f.suffix == ".md" and f.stem != "brain"]
    for other in others:
        text = other.read_text(encoding="utf-8")
        task_section = get_yaml_section(text, "  task")
        if task_section:
            if any('"researcher": allow' in l for l in task_section.splitlines()):
                issues.append(f"{other.stem}: Must NOT have 'researcher: allow' in task (only Brain)")
            if any('"general": allow' in l for l in task_section.splitlines()):
                issues.append(f"{other.stem}: Must NOT have 'general: allow' in task (only Brain)")
    return issues


def check_planner_can_dispatch_spv(root: Path) -> list:
    """Planner must have stage-plan-verifier: allow in task."""
    issues = []
    file = root / ".opencode" / "agents" / "planner.md"
    if not file.exists():
        return issues
    text = file.read_text(encoding="utf-8")
    task_section = get_yaml_section(text, "  task")
    if task_section:
        if not any('"stage-plan-verifier": allow' in l for l in task_section.splitlines()):
            issues.append("Planner: Missing 'stage-plan-verifier: allow' in task rules")
    else:
        issues.append("Planner: Missing task section")
    return issues


def check_planner_can_run_stage_validator(root: Path) -> list:
    """Planner's bash must have python .agents/validators/proofloop-validate-stage.py."""
    issues = []
    file = root / ".opencode" / "agents" / "planner.md"
    if not file.exists():
        return issues
    text = file.read_text(encoding="utf-8")
    bash_section = get_yaml_section(text, "  bash")
    if bash_section:
        if not any("proofloop-validate-stage" in l for l in bash_section.splitlines()):
            issues.append("Planner: bash must include 'python .agents/validators/proofloop-validate-stage.py'")
    else:
        issues.append("Planner: Missing bash section")
    return issues


def check_executor_refs_scope_checker(root: Path) -> list:
    """Executor.md must reference proofloop-check-slice-doc-scope."""
    issues = []
    file = root / ".opencode" / "agents" / "executor.md"
    if not file.exists():
        return issues
    text = file.read_text(encoding="utf-8")
    if "proofloop-check-slice-doc-scope" not in text:
        issues.append("Executor: Must reference 'proofloop-check-slice-doc-scope' in executor.md")
    return issues


def check_cv_no_python_c(root: Path) -> list:
    """CV must NOT have python -c * in its permissions."""
    issues = []
    file = root / ".opencode" / "agents" / "code-verifier.md"
    if not file.exists():
        return issues
    text = file.read_text(encoding="utf-8")
    bash_section = get_yaml_section(text, "  bash")
    if bash_section:
        if any('"python -c' in l or "python -c" in l for l in bash_section.splitlines()):
            issues.append("CV: Must NOT have 'python -c *' in bash permissions")
    return issues


def check_prototype_no_tag(root: Path) -> list:
    """Prototype.md must NOT use 'checkpoint tag' terminology."""
    issues = []
    file = root / ".opencode" / "agents" / "prototype.md"
    if not file.exists():
        return issues
    text = file.read_text(encoding="utf-8")
    if "checkpoint tag" in text.lower():
        issues.append("Prototype: Must use 'checkpoint commit' instead of 'checkpoint tag'")
    return issues


def main():
    root = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--path" else Path.cwd()
    print(f"Permission smoke test for: {root}\n")

    agent_dir = root / ".opencode" / "agents"

    check_results = []

    # Existing checks
    for issue in check_brain_permissions(root):
        check_results.append(("FAIL", issue))
    for issue in check_worker_permissions(root):
        check_results.append(("FAIL", issue))
    for issue in check_cv_permissions(root):
        check_results.append(("FAIL", issue))
    for issue in check_committer_permissions(root):
        check_results.append(("FAIL", issue))
    for issue in check_planner_permissions(agent_dir):
        check_results.append(("FAIL", issue))
    for issue in check_prototype_permissions(agent_dir):
        check_results.append(("FAIL", issue))
    for issue in check_executor_permissions(agent_dir):
        check_results.append(("FAIL", issue))

    # New checks
    for issue in check_subagents_external_directory(root):
        check_results.append(("FAIL", issue))
    for issue in check_prototype_no_researcher(root):
        check_results.append(("FAIL", issue))
    for issue in check_brain_only_researcher_general(root):
        check_results.append(("FAIL", issue))
    for issue in check_planner_can_dispatch_spv(root):
        check_results.append(("FAIL", issue))
    for issue in check_planner_can_run_stage_validator(root):
        check_results.append(("FAIL", issue))
    for issue in check_executor_refs_scope_checker(root):
        check_results.append(("FAIL", issue))
    for issue in check_cv_no_python_c(root):
        check_results.append(("FAIL", issue))
    for issue in check_prototype_no_tag(root):
        check_results.append(("FAIL", issue))

    passed = sum(1 for r in check_results if r[0] == "PASS")

    if check_results:
        for status, detail in check_results:
            print(f"  [{status}] {detail}")
        print(f"\n{passed} passed, {len(check_results)} total")
        sys.exit(1 if any(r[0] == "FAIL" for r in check_results) else 0)
    else:
        print("All permission checks passed.")
        sys.exit(0)


if __name__ == "__main__":
    main()