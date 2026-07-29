"""
proofloop-permission-smoke-test.py

Verifies Agent path permissions, Worker modes, CV contracts, task evidence model,
CV verdicts/receipt, Executor derive-next-action, Stage/Slice loop, repair
attempts, Agent permission boundaries, and absence of legacy old terms.

Usage: python proofloop-permission-smoke-test.py [--path <root-path>]
"""

import sys
import re
try:
    import yaml
except ImportError:
    print("FATAL: PyYAML not installed (pip install pyyaml)")
    sys.exit(1)
from pathlib import Path

# ── Legacy term detection helpers ───────────────────────────────────────────────
# These are built via concatenation so the file does not embed literal prohibited
# tokens in its own source. The scan excludes this file's own source; the
# concatenation ensures no false-positive self-match.

_O = "S"                            # first letter of the old term
_CV = "CV"                          # "Code Verifier" abbreviation
_LEGACY = _O + _CV                   # evaluates to the old term at runtime
_LEGACY_READY = "READY_FOR_" + _LEGACY
_LEGACY_HYPHEN = "ready-for-" + _O.lower() + _CV.lower()  # evaluates to "ready-for-scv"


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


# ── 1. Legacy old-term checks ──

def check_no_forbidden_old_terms(root: Path) -> list:
    # docstring avoids literal old terms
    """Check that the legacy Code Verifier identifiers are not present in
    user-visible files (README, workflow, fixtures, framework tests)."""
    issues = []
    check_files = [
        root / "README.md",
        root / ".github/workflows/proofloop-framework.yml",
    ]
    # Add all fixture tasks.md, README.md files
    for p in root.glob("tests/fixtures/**/*.md"):
        check_files.append(p)
    # Add framework files
    check_files.append(root / "tests/framework/proofloop-permission-smoke-test.py")
    check_files.append(root / "tests/framework/proofloop-smoke-test.sh")

    # Also check any fixture evidence dirs
    for p in root.glob("tests/fixtures/**/evidence/*.md"):
        check_files.append(p)

    for f in check_files:
        if not f.exists():
            continue
        try:
            text = f.read_text(encoding="utf-8")
        except Exception:
            continue
        # Skip the rectification plan document (allowed to retain old-term history)
        if "Rectification_Plan" in str(f):
            continue
        # Skip this test file itself — forbidden-term detection logic references
        # them only via runtime concatenation.
        if f.name == "proofloop-permission-smoke-test.py":
            continue
        if _LEGACY in text or _LEGACY_READY in text:
            issues.append(
                f"{f.relative_to(root)}: Contains forbidden legacy identifier"
            )
        # Skip this test file itself (same reason as above)
        if f.name == "proofloop-permission-smoke-test.py":
            continue
        if _LEGACY_HYPHEN in text.lower():
            issues.append(
                f"{f.relative_to(root)}: Contains forbidden legacy hyphenated identifier"
            )

    return issues


def check_worker_modes_manifest(root: Path) -> list:
    """Verify Worker Contract modes table references expected modes."""
    issues = []
    expected_modes = {"implement-task", "recover-task", "finalize-slice", "repair", "diagnose", "resolve-conflict"}
    worker_contract = root / ".agents" / "contracts" / "executor" / "worker.md"
    if not worker_contract.exists():
        return issues
    text = worker_contract.read_text(encoding="utf-8")

    # Extract the Modes section
    if "## Modes" not in text:
        issues.append("Worker Contract: Missing '## Modes' section")
        return issues

    mode_section = text.split("## Modes", 1)[1]
    if "## " in mode_section[1:]:
        # Find next ## heading
        next_heading = mode_section.find("\n## ")
        if next_heading >= 0:
            mode_section = mode_section[:next_heading]

    found = set()
    for m in expected_modes:
        if f"`{m}`" in mode_section:
            found.add(m)

    missing = expected_modes - found
    if missing:
        issues.append(f"Worker Contract: Missing modes: {missing}")

    # Check no extra modes
    for token in mode_section.split():
        if token.startswith("`") and token.endswith("`"):
            mode_name = token[1:-1]
            if mode_name not in expected_modes:
                issues.append(f"Worker Contract: Unexpected extra mode: {mode_name}")

    return issues


def check_worker_return_values(root: Path) -> list:
    # docstring uses concatenation to avoid literal old term
    """Verify Worker uses READY_FOR_CV rather than the legacy all-caps variant."""
    issues = []
    worker_contract = root / ".agents" / "contracts" / "executor" / "worker.md"
    if not worker_contract.exists():
        return issues
    text = worker_contract.read_text(encoding="utf-8")

    if _LEGACY_READY in text:
        issues.append("Worker Contract: Contains legacy all-caps variant (should use READY_FOR_CV)")

    if "READY_FOR_CV" not in text:
        issues.append("Worker Contract: Missing 'READY_FOR_CV' return value")

    return issues


# ── 2. CV contract checks ──

def check_cv_contract(root: Path) -> list:
    """Verify CV (Code Verifier) contract has edit: deny, no python -c."""
    issues = []
    cv_file = root / ".opencode" / "agents" / "code-verifier.md"
    if not cv_file.exists():
        issues.append("code-verifier.md not found")
        return issues

    text = cv_file.read_text(encoding="utf-8")
    if "edit: allow" in text:
        issues.append("CV: Should NOT have 'edit: allow'")

    bash_section = get_yaml_section(text, "  bash")
    if bash_section:
        lines = [l.strip() for l in bash_section.splitlines() if l.strip()]
        if lines and lines[0] == "allow":
            issues.append("CV: bash should be restricted (not 'bash: allow')")
        if any('"python -c' in l or "python -c" in l for l in lines):
            issues.append("CV: Must NOT have 'python -c *' in bash permissions")

    return issues


def check_cv_verdicts_contract(root: Path) -> list:
    # docstring avoids literal old term
    """Verify CV contract uses standard verdicts (PASS, REPAIR, REPLAN, etc.)."""
    issues = []
    cv_contract = root / ".agents" / "contracts" / "executor" / "code-verifier.md"
    if not cv_contract.exists():
        issues.append("code-verifier.md not found")
        return issues

    text = cv_contract.read_text(encoding="utf-8")
    expected_verdicts = ["PASS", "REPAIR", "REPLAN", "BLOCKED", "ESCALATION_REQUIRED"]
    for v in expected_verdicts:
        if v not in text:
            issues.append(f"CV Contract: Missing verdict '{v}'")

    # Check legacy identifier is not present
    if _LEGACY in text:
        issues.append("CV Contract: Contains legacy identifier (should use 'CV' or 'Code Verifier')")

    return issues


# ── 3. Executor derive-next-action checks ──

def check_executor_derive_next_action(root: Path) -> list:
    # docstring avoids literal old term
    """Verify Executor has derive-next-action logic and CV dispatch."""
    issues = []
    executor_file = root / ".opencode" / "agents" / "executor.md"
    if not executor_file.exists():
        issues.append("executor.md not found")
        return issues

    text = executor_file.read_text(encoding="utf-8")

    # Should reference derive-next-action
    if "derive-next-action" not in text and "deriveNextAction" not in text:
        issues.append("Executor: Missing reference to derive-next-action")

    # Should reference CV dispatch
    if "code-verifier" not in text:
        issues.append("Executor: Missing reference to code-verifier dispatch")

    # Should reference repair attempts
    if "repair_attempt" not in text and "repair attempt" not in text.lower():
        issues.append("Executor: Missing reference to repair attempt tracking")

    # Should reference READY_FOR_CV (not the legacy variant)
    if _LEGACY_READY in text:
        issues.append("Executor: Contains legacy all-caps variant (should be READY_FOR_CV)")

    return issues


# ── 4. Task evidence before checkbox checks ──

def check_task_evidence_model(root: Path) -> list:
    # docstring avoids literal old term
    """Verify the task-evidence-before-checkbox model exists in the codebase.
    The model is implemented in runtime derive-next-action and referenced
    in contracts/agent files."""
    issues = []
    # Check derive-next-action source implements evidence_written field
    derive_src = root / ".agents" / "runtime" / "src" / "derive-next-action.ts"
    if derive_src.exists():
        text = derive_src.read_text(encoding="utf-8")
        if "evidence_written" not in text:
            issues.append("Runtime: derive-next-action.ts missing 'evidence_written' field")

    # Check Worker agent file mentions evidence-before-checkbox order
    worker_agent = root / ".opencode" / "agents" / "worker.md"
    if worker_agent.exists():
        text = worker_agent.read_text(encoding="utf-8")
        if "evidence before" not in text.lower():
            issues.append("Worker Agent: Missing evidence-before-checkbox ordering rule")

    return issues


# ── 5. Stage/Slice loop checks ──

def check_stage_slice_loop(root: Path) -> list:
    """Verify Executor describes Stage Loop and Slice Loop."""
    issues = []
    executor_file = root / ".opencode" / "agents" / "executor.md"
    if not executor_file.exists():
        issues.append("executor.md not found")
        return issues

    text = executor_file.read_text(encoding="utf-8")
    if "Stage Loop" not in text and "stage_gate" not in text:
        issues.append("Executor: Missing Stage Loop description")
    if "Slice Loop" not in text and "slice_complete" not in text:
        issues.append("Executor: Missing Slice Loop description")

    return issues


# ── 6. Agent permission boundary checks ──

def check_brain_permissions(root: Path) -> list:
    issues = []
    brain_file = root / ".opencode" / "agents" / "brain.md"
    if not brain_file.exists():
        issues.append("brain.md not found")
        return issues
    text = brain_file.read_text(encoding="utf-8")
    if "edit: allow" not in text:
        issues.append("Brain: Must have 'edit: allow'")
    return issues


def check_worker_permissions(root: Path) -> list:
    issues = []
    worker_file = root / ".opencode" / "agents" / "worker.md"
    if not worker_file.exists():
        issues.append("worker.md not found")
        return issues
    text = worker_file.read_text(encoding="utf-8")
    if "edit: allow" not in text:
        issues.append("Worker: Should have edit: allow")
    return issues


def check_committer_permissions(root: Path) -> list:
    issues = []
    committer_file = root / ".opencode" / "agents" / "committer.md"
    if not committer_file.exists():
        issues.append("committer.md not found")
        return issues
    text = committer_file.read_text(encoding="utf-8")
    if "git commit" not in text:
        issues.append("Committer: Should have git commit permission")
    return issues


def check_planner_permissions(agent_dir: Path) -> list:
    issues = []
    planner_file = agent_dir / "planner.md"
    if not planner_file.exists():
        return issues
    text = planner_file.read_text(encoding="utf-8")
    if "edit: allow" not in text:
        issues.append("Planner: Must have 'edit: allow'")
    return issues


def check_prototype_permissions(agent_dir: Path) -> list:
    issues = []
    prototype_file = agent_dir / "prototype.md"
    if not prototype_file.exists():
        return issues
    text = prototype_file.read_text(encoding="utf-8")
    task_section = get_yaml_section(text, "  task")
    if task_section:
        lines = [l.strip() for l in task_section.splitlines() if l.strip()]
        if lines and not lines[0].startswith('"*": deny'):
            issues.append("Prototype: First task rule must be '\"*\": deny'")
    return issues


def check_executor_permissions(agent_dir: Path) -> list:
    issues = []
    executor_file = agent_dir / "executor.md"
    if not executor_file.exists():
        return issues
    text = executor_file.read_text(encoding="utf-8")
    edit_section = get_yaml_section(text, "  edit")
    if edit_section:
        lines = [l.strip() for l in edit_section.splitlines() if l.strip()]
        if lines and not lines[0].startswith('"*": deny'):
            issues.append("Executor: First edit rule must be '\"*\": deny'")
    return issues


def check_subagents_external_directory(root: Path) -> list:
    issues = []
    agents = ["worker", "stage-plan-verifier", "code-verifier", "committer"]
    names = {"worker": "Worker", "stage-plan-verifier": "SPV", "code-verifier": "CV", "committer": "Committer"}
    for agent_name in agents:
        f = root / ".opencode" / "agents" / f"{agent_name}.md"
        if not f.exists():
            issues.append(f"{names[agent_name]}: File not found")
            continue
        text = f.read_text(encoding="utf-8")
        if "external_directory: deny" not in text:
            issues.append(f"{names[agent_name]}: Missing external_directory: deny")
    return issues


def check_brain_only_researcher_general(root: Path) -> list:
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


def check_brain_contract_map(root: Path) -> list:
    issues = []
    brain_file = root / ".opencode" / "agents" / "brain.md"
    contracts_dir = root / ".agents" / "contracts" / "brain"
    if not brain_file.exists() or not contracts_dir.exists():
        return issues
    brain_text = brain_file.read_text(encoding="utf-8")
    actual_files = set(f.name for f in contracts_dir.glob("*.md"))
    referenced = set()
    for fname in actual_files:
        if fname in brain_text:
            referenced.add(fname)
    missing_from_brain = actual_files - referenced
    for fname in sorted(missing_from_brain):
        issues.append(f"Brain contract '{fname}' exists but is not referenced in brain.md")
    return issues


def check_executor_contract_map(root: Path) -> list:
    issues = []
    executor_file = root / ".opencode" / "agents" / "executor.md"
    contracts_dir = root / ".agents" / "contracts" / "executor"
    if not executor_file.exists() or not contracts_dir.exists():
        return issues
    executor_text = executor_file.read_text(encoding="utf-8")
    actual_files = set(f.name for f in contracts_dir.glob("*.md"))
    referenced = set()
    for fname in actual_files:
        if fname in executor_text:
            referenced.add(fname)
    missing_from_executor = actual_files - referenced
    for fname in sorted(missing_from_executor):
        issues.append(f"Executor contract '{fname}' exists but is not referenced in executor.md")
    return issues


def check_no_contract_runtime_ids(root: Path) -> list:
    issues = []
    # Only flag bare "task_id:" when it appears as a standalone heading/entry,
    # not when it's part of a compound field name like "received_task_id:" or
    # "expected_task_id:" which are legitimate contract-intrinsic data fields.
    patterns = ["Continuation / Task ID", "Session ID:", "ses_id:"]
    bare_task_id_line = re.compile(r'^\s*task_id:\s*')
    bare_session_id = re.compile(r'(?<!\w)session_id(?!\s*:)(?!\w)')
    bare_ses_id = re.compile(r'(?<!\w)ses_id(?!\s*:)(?!\w)')
    continuation_pattern = re.compile(r'(?<!\w)Continuation:(?!\s*(?:is not|is owned by|handle|Fresh|not a Contract|not persisted|must not))')
    for dir_name in ["brain", "executor"]:
        contracts_dir = root / ".agents" / "contracts" / dir_name
        if not contracts_dir.exists():
            continue
        for contract_file in sorted(contracts_dir.glob("*.md")):
            text = contract_file.read_text(encoding="utf-8")
            for pattern in patterns:
                if pattern in text:
                    issues.append(f"{dir_name}/{contract_file.name}: Contains '{pattern}' (runtime field not allowed in contract)")
                    break
            else:
                # Check for standalone "task_id:" at start of line (not compound names)
                for line in text.splitlines():
                    if bare_task_id_line.search(line):
                        issues.append(f"{dir_name}/{contract_file.name}: Contains standalone 'task_id:' (runtime field not allowed in contract)")
                        break
                else:
                    for line in text.splitlines():
                        stripped = line.strip()
                        if stripped.startswith('#') or stripped.startswith('<!--') or stripped.startswith('>'):
                            continue
                        if bare_session_id.search(stripped) or bare_ses_id.search(stripped):
                            issues.append(f"{dir_name}/{contract_file.name}: Contains bare 'session_id' or 'ses_id' without colon (runtime field not allowed in contract)")
                            break
                    else:
                        for line in text.splitlines():
                            if 'Cleanup Continuation' in line:
                                continue
                            if continuation_pattern.search(line):
                                issues.append(f"{dir_name}/{contract_file.name}: Contains standalone 'Continuation:' (runtime field not allowed in contract)")
                                break
    return issues


def check_brain_bash_deny(root: Path) -> list:
    issues = []
    brain_file = root / ".opencode" / "agents" / "brain.md"
    if not brain_file.exists():
        return issues
    text = brain_file.read_text(encoding="utf-8")
    try:
        parts = text.split("---", 2)
        if len(parts) < 3:
            return issues
        data = yaml.safe_load(parts[1])
        if not isinstance(data, dict):
            return issues
        perm = data.get("permission", {})
        bash_config = perm.get("bash", {})
        if not isinstance(bash_config, dict):
            issues.append("Brain: bash must be a dict")
            return issues
        if bash_config.get("*") != "deny":
            issues.append("Brain: First bash rule must be '\"*\": deny'")
    except Exception as e:
        issues.append(f"Brain: YAML parse error in bash check: {e}")
    return issues


def check_worker_no_codebase_design(root: Path) -> list:
    issues = []
    worker_file = root / ".opencode" / "agents" / "worker.md"
    if not worker_file.exists():
        issues.append("worker.md not found")
        return issues
    text = worker_file.read_text(encoding="utf-8")
    if '"codebase-design": allow' in text:
        issues.append("Worker: Must NOT have 'codebase-design: allow' in skill section")
    return issues


def check_agent_skill_visibility(root: Path) -> list:
    issues = []
    agent_dir = root / ".opencode" / "agents"
    expected = {
        "brain": {"*": "deny", "ai-structured-prd": "allow", "prd-to-tech-design-prep": "allow", "prd-to-ai-architecture": "allow", "codebase-design": "allow"},
        "planner": {"*": "deny", "codebase-design": "allow"},
        "worker": {"*": "deny", "test-driven-development": "allow", "diagnose": "allow"},
        "stage-reviewer": {"*": "deny", "code-review-and-quality": "allow", "security-and-hardening": "allow"},
    }
    deny_agents = {"executor", "code-verifier", "researcher", "prototype", "committer"}
    for agent_name in sorted(expected.keys()):
        f = agent_dir / f"{agent_name}.md"
        if not f.exists():
            continue
        text = f.read_text(encoding="utf-8")
        try:
            parts = text.split("---", 2)
            if len(parts) < 3:
                continue
            data = yaml.safe_load(parts[1])
            if not isinstance(data, dict):
                continue
            perm = data.get("permission", {})
            skill_config = perm.get("skill", {})
            if not isinstance(skill_config, dict):
                continue
            expected_skills = expected[agent_name]
            for sk, expected_val in expected_skills.items():
                actual_val = skill_config.get(sk)
                if actual_val != expected_val:
                    issues.append(f"{agent_name}.md: skill '{sk}' is '{actual_val}', expected '{expected_val}'")
            for sk in skill_config:
                if sk not in expected_skills:
                    issues.append(f"{agent_name}.md: unexpected extra skill '{sk}' in allowlist")
        except Exception as e:
            issues.append(f"{agent_name}.md: YAML parse error: {e}")

    for agent_name in sorted(deny_agents):
        f = agent_dir / f"{agent_name}.md"
        if not f.exists():
            continue
        text = f.read_text(encoding="utf-8")
        try:
            parts = text.split("---", 2)
            if len(parts) < 3:
                continue
            data = yaml.safe_load(parts[1])
            perm = data.get("permission", {})
            skill_config = perm.get("skill", "MISSING")
            if skill_config is None or skill_config == "MISSING":
                issues.append(f"{agent_name}.md: missing 'skill' section")
            elif isinstance(skill_config, str) and skill_config != "deny":
                issues.append(f"{agent_name}.md: skill is '{skill_config}', expected 'deny'")
            elif isinstance(skill_config, dict):
                issues.append(f"{agent_name}.md: skill is a dict, expected flat 'deny'")
        except Exception as e:
            issues.append(f"{agent_name}.md: YAML parse error: {e}")

    return issues


def main():
    root = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--path" else Path.cwd()
    print(f"Permission smoke test for: {root}\n")

    agent_dir = root / ".opencode" / "agents"

    check_results = []

    # ── CV/Slice/Evidence contract checks ──
    for issue in check_no_forbidden_old_terms(root):
        check_results.append(("FAIL", issue))
    for issue in check_worker_modes_manifest(root):
        check_results.append(("FAIL", issue))
    for issue in check_worker_return_values(root):
        check_results.append(("FAIL", issue))
    for issue in check_cv_contract(root):
        check_results.append(("FAIL", issue))
    for issue in check_cv_verdicts_contract(root):
        check_results.append(("FAIL", issue))
    for issue in check_executor_derive_next_action(root):
        check_results.append(("FAIL", issue))
    for issue in check_task_evidence_model(root):
        check_results.append(("FAIL", issue))
    for issue in check_stage_slice_loop(root):
        check_results.append(("FAIL", issue))

    # ── Agent permission checks ──
    for issue in check_brain_permissions(root):
        check_results.append(("FAIL", issue))
    for issue in check_worker_permissions(root):
        check_results.append(("FAIL", issue))
    for issue in check_committer_permissions(root):
        check_results.append(("FAIL", issue))
    for issue in check_planner_permissions(agent_dir):
        check_results.append(("FAIL", issue))
    for issue in check_prototype_permissions(agent_dir):
        check_results.append(("FAIL", issue))
    for issue in check_executor_permissions(agent_dir):
        check_results.append(("FAIL", issue))
    for issue in check_subagents_external_directory(root):
        check_results.append(("FAIL", issue))
    for issue in check_brain_only_researcher_general(root):
        check_results.append(("FAIL", issue))
    for issue in check_brain_contract_map(root):
        check_results.append(("FAIL", issue))
    for issue in check_executor_contract_map(root):
        check_results.append(("FAIL", issue))
    for issue in check_no_contract_runtime_ids(root):
        check_results.append(("FAIL", issue))
    for issue in check_brain_bash_deny(root):
        check_results.append(("FAIL", issue))
    for issue in check_worker_no_codebase_design(root):
        check_results.append(("FAIL", issue))
    for issue in check_agent_skill_visibility(root):
        check_results.append(("FAIL", issue))

    if check_results:
        for status, detail in check_results:
            print(f"  [{status}] {detail}")
        print(f"\n{len([r for r in check_results if r[0]=='PASS'])} passed, {len(check_results)} total")
        sys.exit(1 if any(r[0] == "FAIL" for r in check_results) else 0)
    else:
        print("All permission checks passed.")
        sys.exit(0)


if __name__ == "__main__":
    main()
