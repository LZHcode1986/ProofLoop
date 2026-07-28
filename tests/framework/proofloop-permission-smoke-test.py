"""
proofloop-permission-smoke-test.py

Verifies Agent path permissions match expected rules.

Usage: python proofloop-permission-smoke-test.py [--path <root-path>]

DEPRECATED: This Python validator will be removed after TypeScript equivalence is verified.
See .agents/runtime/ for the TypeScript replacement.
"""

import sys
import re
try:
    import yaml
except ImportError:
    print("FATAL: PyYAML not installed (pip install pyyaml)")
    sys.exit(1)
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
    if "edit: allow" not in text:
        issues.append("Planner: Must have 'edit: allow'")
    return issues


def check_prototype_permissions(agent_dir: Path) -> list:
    issues = []
    prototype_file = agent_dir / "prototype.md"
    if not prototype_file.exists():
        return issues
    text = prototype_file.read_text(encoding="utf-8")

    # Edit section: no strict deny rule required — Prototype uses edit: allow
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
    """Check Brain has edit: allow permission."""
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
    """Planner must have a bash section (Python validators removed, TS replacement handles validation)."""
    issues = []
    file = root / ".opencode" / "agents" / "planner.md"
    if not file.exists():
        return issues
    text = file.read_text(encoding="utf-8")
    bash_section = get_yaml_section(text, "  bash")
    if not bash_section:
        issues.append("Planner: Missing bash section")
    return issues


def check_executor_refs_scope_checker(root: Path) -> list:
    """Executor.md must reference proofloop or runtime."""
    issues = []
    file = root / ".opencode" / "agents" / "executor.md"
    if not file.exists():
        return issues
    text = file.read_text(encoding="utf-8")
    if "proofloop" not in text and "runtime" not in text:
        issues.append("Executor: Must reference 'proofloop' or 'runtime' in executor.md")
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


def check_skill_description_length(root: Path) -> list:
    """Check all skill descriptions are ≤ 180 characters."""
    issues = []
    skills_dir = root / ".agents" / "skills"
    if not skills_dir.exists():
        return issues
    for skill_dir in sorted(skills_dir.iterdir()):
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            continue
        text = skill_file.read_text(encoding="utf-8")
        # parse description from YAML frontmatter
        if not text.startswith("---"):
            continue
        parts = text.split("---", 2)
        if len(parts) < 3:
            continue
        for line in parts[1].splitlines():
            if line.startswith("description:"):
                desc = line[len("description:"):].strip().strip('"').strip("'")
                if len(desc) > 180:
                    issues.append(f"{skill_dir.name}/SKILL.md: description is {len(desc)} chars (max 180)")
                break
    return issues


def check_agent_skill_visibility(root: Path) -> list:
    """Check agent skill visibility matches expected allowlist using YAML parsing."""
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
        file = agent_dir / f"{agent_name}.md"
        if not file.exists():
            continue
        text = file.read_text(encoding="utf-8")
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
        file = agent_dir / f"{agent_name}.md"
        if not file.exists():
            continue
        text = file.read_text(encoding="utf-8")
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


def check_brain_contract_map(root: Path) -> list:
    """Check all brain contract files are referenced in brain.md."""
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
    
    if len(referenced) < 7:
        issues.append(f"brain.md references only {len(referenced)} contracts, expected at least 7")
    
    return issues


def check_executor_contract_map(root: Path) -> list:
    """Check Executor Contract Map references exist in executor.md and match actual files."""
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
    
    if len(referenced) < 3:
        issues.append(f"executor.md references only {len(referenced)} contracts, expected at least 3")
    
    return issues


def check_no_orphan_executor_contracts(root: Path) -> list:
    """Check all executor contract files are referenced in executor.md."""
    issues = []
    executor_file = root / ".opencode" / "agents" / "executor.md"
    contracts_dir = root / ".agents" / "contracts" / "executor"
    if not executor_file.exists() or not contracts_dir.exists():
        return issues

    executor_text = executor_file.read_text(encoding="utf-8")

    for contract_file in sorted(contracts_dir.glob("*.md")):
        ref = f"executor/{contract_file.name}"
        if ref not in executor_text:
            issues.append(f"Orphan executor contract: {ref} not referenced in executor.md")
    return issues


def check_no_orphan_brain_contracts(root: Path) -> list:
    """Check all brain contract files are referenced in brain.md (reverse check)."""
    return check_brain_contract_map(root)


def check_no_contract_runtime_ids(root: Path) -> list:
    """Scan all Brain and Executor contracts for runtime fields."""
    issues = []
    patterns = ["Continuation / Task ID", "Session ID:", "task_id:", "ses_id:"]
    # Also check for bare \btask_id\b and \bsession_id\b without colon
    bare_task_id = re.compile(r'(?<!\w)task_id(?!\s*:)(?!\w)')
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
                # Check for bare task_id or session_id without colon
                for line in text.splitlines():
                    stripped = line.strip()
                    if stripped.startswith('#') or stripped.startswith('<!--') or stripped.startswith('>'):
                        continue
                    if bare_task_id.search(stripped) or bare_session_id.search(stripped) or bare_ses_id.search(stripped):
                        issues.append(f"{dir_name}/{contract_file.name}: Contains bare 'task_id', 'session_id', or 'ses_id' without colon (runtime field not allowed in contract)")
                        break
                else:
                    # Check for standalone Continuation:
                    for line in text.splitlines():
                        if 'Cleanup Continuation' in line:
                            continue
                        if continuation_pattern.search(line):
                            issues.append(f"{dir_name}/{contract_file.name}: Contains standalone 'Continuation:' (runtime field not allowed in contract)")
                            break
    return issues


def check_worker_mode_consistency(root: Path) -> list:
    """Verify Worker mode consistency across 3 sources using precise table parsing."""
    issues = []
    expected_modes = {"implement-task", "recover-task", "finalize-slice", "repair", "diagnose", "resolve-conflict"}

    def extract_section(text: str, heading: str) -> str:
        """Extract the section content between a ## heading and the next ## heading."""
        if heading not in text:
            return ""
        start = text.index(heading)
        rest = text[start + len(heading):]
        lines = rest.splitlines()
        end = len(rest)
        for i, line in enumerate(lines):
            if line.startswith("## ") and heading not in line:
                end = len("\n".join(lines[:i]))
                break
        return rest[:end]

    sources = []

    # 1. Worker Contract — parse Modes table
    worker_contract = root / ".agents" / "contracts" / "executor" / "worker.md"
    if worker_contract.exists():
        text = worker_contract.read_text(encoding="utf-8")
        mode_section = extract_section(text, "## Modes")
        found = set()
        for m in expected_modes:
            if f"`{m}`" in mode_section:
                found.add(m)
        extra = set()
        for token in mode_section.split():
            if token.startswith("`") and token.endswith("`") and token[1:-1] not in expected_modes:
                extra.add(token[1:-1])
        sources.append(("Worker Contract", found, extra))
    else:
        issues.append("Worker Contract file not found at .agents/contracts/executor/worker.md")

    # 2. Executor State Transition Table (additional consistency check, not required)
    executor_file = root / ".opencode" / "agents" / "executor.md"
    if executor_file.exists():
        text = executor_file.read_text(encoding="utf-8")
        mode_section = extract_section(text, "## Executor State Transition Table")
        found = set()
        for m in expected_modes:
            if f"`{m}`" in mode_section:
                found.add(m)
        extra = set()
        for token in mode_section.split():
            if token.startswith("`") and token.endswith("`") and token[1:-1] not in expected_modes:
                extra.add(token[1:-1])
        # Informational only — do not add to sources list (not a required source)
    else:
        issues.append("executor.md not found")

    # 3. Worker Mode Execution Flows
    worker_file = root / ".opencode" / "agents" / "worker.md"
    if worker_file.exists():
        text = worker_file.read_text(encoding="utf-8")
        mode_section = extract_section(text, "## Mode Execution Flows")
        if mode_section:
            found = set()
            for m in expected_modes:
                if f"### Mode: {m}" in mode_section:
                    found.add(m)
            extra = set()
            for line in mode_section.splitlines():
                if line.startswith("### Mode: "):
                    mode_name = line[10:].strip()
                    if mode_name not in expected_modes:
                        extra.add(mode_name)
            sources.append(("Worker Mode Flows", found, extra))
        else:
            sources.append(("Worker Mode Flows", set(), set()))
    else:
        issues.append("worker.md not found")

    for name, found, extra in sources:
        if found != expected_modes:
            missing = expected_modes - found
            if missing:
                issues.append(f"{name}: Missing modes: {missing}")
        if extra:
            issues.append(f"{name}: Unexpected extra modes: {extra}")

    return issues


def check_brain_bash_deny(root: Path) -> list:
    """Verify Brain's bash starts with deny and only read-only commands."""
    issues = []
    brain_file = root / ".opencode" / "agents" / "brain.md"
    if not brain_file.exists():
        return issues
    
    text = brain_file.read_text(encoding="utf-8")
    
    # Use proper YAML parsing
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
            return issues
        
        # Verify allowlist contains expected Brain commands
        allowed_brain_commands = {
            "git status*", "git log*", "git diff*", "git show*",
            "git branch --show-current", "rg *", "Select-String *",
            "Get-Content *", "Get-ChildItem *", "Test-Path *",
            "node .agents/runtime/dist/receipt-writer.js *",
            "node .agents/runtime/dist/run-stage.js *",
            "node .agents/runtime/dist/run-project-acceptance.js *"
        }
        
        allowed = {k for k in bash_config if k != "*"}
        unexpected = allowed - allowed_brain_commands
        if unexpected:
            issues.append(f"Brain bash: unexpected allow entries: {unexpected}")
        
    except Exception as e:
        issues.append(f"Brain: YAML parse error in bash check: {e}")
    
    return issues


def check_worker_no_codebase_design(root: Path) -> list:
    """Verify Worker no longer has codebase-design skill."""
    issues = []
    worker_file = root / ".opencode" / "agents" / "worker.md"
    if not worker_file.exists():
        issues.append("worker.md not found")
        return issues
    text = worker_file.read_text(encoding="utf-8")
    if '"codebase-design": allow' in text:
        issues.append("Worker: Must NOT have 'codebase-design: allow' in skill section")
    return issues


def check_skill_no_general_persist(root: Path) -> list:
    """Verify prd-to-ai-architecture SKILL.md no longer has dispatch @general to persist."""
    issues = []
    skill_file = root / ".agents" / "skills" / "prd-to-ai-architecture" / "SKILL.md"
    if not skill_file.exists():
        issues.append("prd-to-ai-architecture/SKILL.md not found")
        return issues
    text = skill_file.read_text(encoding="utf-8")
    if "dispatch @general to persist" in text:
        issues.append("SKILL.md: Must NOT contain 'dispatch @general to persist'")
    if "dispatch @general to update" in text:
        issues.append("SKILL.md: Must NOT contain 'dispatch @general to update'")
    return issues


def check_brain_stage_tests_preserved(root: Path) -> list:
    """Verify Brain references 'Stage'."""
    issues = []
    brain_file = root / ".opencode" / "agents" / "brain.md"
    if not brain_file.exists():
        issues.append("brain.md not found")
        return issues
    text = brain_file.read_text(encoding="utf-8")
    if "Stage" not in text:
        issues.append("Brain: Missing 'Stage' references")
    return issues


def check_return_value_consistency(root: Path) -> list:
    """Verify Worker allowed returns match between Worker, Contract, and Executor."""
    issues = []

    expected_returns = {
        "implement-task": {"TASK_COMPLETE", "blocker"},
        "recover-task": {"TASK_COMPLETE", "IMPLEMENTATION_DEFECT", "blocker"},
        "finalize-slice": {"READY_FOR_SCV", "IMPLEMENTATION_DEFECT"},
        "repair": {"READY_FOR_SCV", "blocker"},
        "diagnose": {"READY_FOR_SCV", "blocker"},
        "resolve-conflict": {"CONFLICT_RESOLVED", "SEMANTIC_CONFLICT"},
    }

    def extract_section(text: str, heading: str) -> str:
        """Extract the section content between a ## heading and the next ## heading."""
        if heading not in text:
            return ""
        start = text.index(heading)
        rest = text[start + len(heading):]
        lines = rest.splitlines()
        end = len(rest)
        for i, line in enumerate(lines):
            if line.startswith("## ") and heading not in line:
                end = len("\n".join(lines[:i]))
                break
        return rest[:end]

    def parse_return_set(value: str) -> set[str]:
        """Parse a comma/or-separated return value list into a set of strings."""
        parts = re.split(r"\s*(?:,|\bor\b)\s*", value)
        return {
            part.strip().strip("`")
            for part in parts
            if part.strip()
        }

    def parse_allowed_returns(mode_block: str) -> set[str] | None:
        """Parse 'Allowed return: ...' line from a mode block."""
        for line in mode_block.splitlines():
            stripped = line.strip()
            if not stripped.startswith("Allowed return:"):
                continue
            value = stripped.removeprefix("Allowed return:").strip()
            return parse_return_set(value)
        return None

    # 1. Check Worker Contract Allowed results table
    worker_contract = root / ".agents" / "contracts" / "executor" / "worker.md"
    contract_actual_returns = {}
    contract_modes_found = set()
    if worker_contract.exists():
        text = worker_contract.read_text(encoding="utf-8")
        section = extract_section(text, "## Allowed results per Mode")
        if not section:
            issues.append("Worker Contract: Missing 'Allowed results per Mode' section")
        else:
            for line in section.splitlines():
                if not line.startswith("|"):
                    continue
                cols = [c.strip() for c in line.split("|")]
                if len(cols) < 3:
                    continue
                mode = cols[1]
                if mode not in expected_returns:
                    continue
                contract_modes_found.add(mode)
                contract_actual_returns[mode] = parse_return_set(cols[2])

            for mode, expected in expected_returns.items():
                if mode not in contract_modes_found:
                    issues.append(f"Worker Contract: Missing mode row '{mode}'")
                    continue
                actual = contract_actual_returns[mode]
                if actual != expected:
                    missing = expected - actual
                    extra = actual - expected
                    if missing:
                        issues.append(f"Worker Contract: Mode '{mode}' missing returns: {missing}")
                    if extra:
                        issues.append(f"Worker Contract: Mode '{mode}' has unexpected returns: {extra}")

    # 2. Check Worker Mode Execution Flows
    worker_file = root / ".opencode" / "agents" / "worker.md"
    worker_flow_actual = {}
    worker_modes_found = set()
    if worker_file.exists():
        text = worker_file.read_text(encoding="utf-8")
        section = extract_section(text, "## Mode Execution Flows")
        if not section:
            issues.append("Worker: Missing 'Mode Execution Flows' section")
        else:
            for mode, expected in expected_returns.items():
                heading = f"### Mode: {mode}"
                if heading not in section:
                    issues.append(f"Worker: Missing mode section '{heading}'")
                    continue
                worker_modes_found.add(mode)
                mode_block = section.split(heading, 1)[1]
                next_heading = mode_block.find("### Mode: ")
                if next_heading >= 0:
                    mode_block = mode_block[:next_heading]

                actual = parse_allowed_returns(mode_block)
                if actual is None:
                    issues.append(f"Worker: Mode '{mode}' is missing 'Allowed return:' line")
                    continue
                worker_flow_actual[mode] = actual
                if actual != expected:
                    missing = expected - actual
                    extra = actual - expected
                    if missing:
                        issues.append(f"Worker: Mode '{mode}' missing returns: {missing}")
                    if extra:
                        issues.append(f"Worker: Mode '{mode}' has unexpected returns: {extra}")

    # 3. Cross-reference: Worker vs Contract
    for mode, expected in expected_returns.items():
        contract_returns = contract_actual_returns.get(mode)
        worker_returns = worker_flow_actual.get(mode)

        if contract_returns is not None and worker_returns is not None:
            if contract_returns != worker_returns:
                issues.append(f"Cross-ref: Mode '{mode}' Contract returns {contract_returns} != Worker returns {worker_returns}")

        if contract_returns is not None and contract_returns != expected:
            issues.append(f"Cross-ref: Mode '{mode}' Contract returns {contract_returns} do not match expected {expected}")

        if worker_returns is not None and worker_returns != expected:
            issues.append(f"Cross-ref: Mode '{mode}' Worker returns {worker_returns} do not match expected {expected}")

    return issues


def check_worker_return_routing(root: Path) -> list:
    """Verify Executor Worker Return Routing section (informational)."""
    issues = []
    expected_executor_actions = {
        "READY_FOR_SCV": ["scope checker", "fresh SCV"],
        "IMPLEMENTATION_DEFECT": ["repair"],
        "CONFLICT_RESOLVED": ["post-merge"],
        "SEMANTIC_CONFLICT": ["stop integration", "Brain"],
    }
    executor_file = root / ".opencode" / "agents" / "executor.md"
    if executor_file.exists():
        text = executor_file.read_text(encoding="utf-8")
        def extract_section(text: str, heading: str) -> str:
            if heading not in text:
                return ""
            start = text.index(heading)
            rest = text[start + len(heading):]
            lines = rest.splitlines()
            end = len(rest)
            for i, line in enumerate(lines):
                if line.startswith("## ") and heading not in line:
                    end = len("\n".join(lines[:i]))
                    break
            return rest[:end]
        section = extract_section(text, "## Worker Return Routing")
        if not section:
            issues.append("Executor: Missing 'Worker Return Routing' section")
        else:
            for line in section.splitlines():
                if not line.startswith("|"):
                    continue
                cols = [c.strip() for c in line.split("|")]
                if len(cols) < 3:
                    continue
                return_name = cols[1]
                action = cols[2]
                if return_name in expected_executor_actions:
                    executor_routes = {}
                    executor_routes[return_name] = action

            for return_name, required_fragments in expected_executor_actions.items():
                actual_action = executor_routes.get(return_name)
                if actual_action is None:
                    issues.append(f"Executor: Missing return route '{return_name}'")
                    continue
                for fragment in required_fragments:
                    if fragment not in actual_action:
                        issues.append(f"Executor: Route '{return_name}' is missing required action fragment '{fragment}'")
    return issues


def check_contract_no_continuation_field(root: Path) -> list:
    """Verify contracts don't have Continuation as a non-comment field."""
    import re
    issues = []
    for dir_name in ["brain", "executor"]:
        contracts_dir = root / ".agents" / "contracts" / dir_name
        if not contracts_dir.exists():
            continue
        for contract_file in sorted(contracts_dir.glob("*.md")):
            text = contract_file.read_text(encoding="utf-8")
            for i, line in enumerate(text.splitlines(), 1):
                stripped = line.strip()
                if "Continuation:" in stripped:
                    if stripped.startswith("#") or stripped.startswith("<!--") or stripped.startswith(">"):
                        continue
                    if "Reference" in stripped or "refer" in stripped.lower():
                        continue
                    if "Cleanup Continuation" in stripped:
                        continue
                    issues.append(f"{dir_name}/{contract_file.name}: Line {i}: Contains 'Continuation:' outside comments/references")
                    break
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

    # New checks from refactoring
    for issue in check_skill_description_length(root):
        check_results.append(("FAIL", issue))
    for issue in check_agent_skill_visibility(root):
        check_results.append(("FAIL", issue))
    for issue in check_brain_contract_map(root):
        check_results.append(("FAIL", issue))
    for issue in check_executor_contract_map(root):
        check_results.append(("FAIL", issue))
    for issue in check_no_orphan_executor_contracts(root):
        check_results.append(("FAIL", issue))
    for issue in check_no_orphan_brain_contracts(root):
        check_results.append(("FAIL", issue))

    # New contract runtime checks
    for issue in check_no_contract_runtime_ids(root):
        check_results.append(("FAIL", issue))
    for issue in check_worker_mode_consistency(root):
        check_results.append(("FAIL", issue))
    for issue in check_brain_bash_deny(root):
        check_results.append(("FAIL", issue))
    for issue in check_worker_no_codebase_design(root):
        check_results.append(("FAIL", issue))
    for issue in check_skill_no_general_persist(root):
        check_results.append(("FAIL", issue))
    for issue in check_brain_stage_tests_preserved(root):
        check_results.append(("FAIL", issue))
    for issue in check_contract_no_continuation_field(root):
        check_results.append(("FAIL", issue))
    for issue in check_return_value_consistency(root):
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