"""
proofloop-check-agent-yaml.py

Parses all agent .md files in .opencode/agents/ and validates YAML frontmatter.
Checks that 'permission', 'bash', 'edit', 'task' sections exist and are well-formed.

Usage: python proofloop-check-agent-yaml.py [--path <root-path>]
"""

import os
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("FATAL: PyYAML not installed (pip install pyyaml)")
    sys.exit(1)


def main():
    root = Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == "--path" else Path.cwd()
    agent_dir = root / ".opencode" / "agents"
    if not agent_dir.exists():
        print(f"FATAL: Agent directory not found at {agent_dir}")
        sys.exit(1)

    errors = []
    checked = 0

    for fpath in sorted(agent_dir.glob("*.md")):
        fname = fpath.name
        content = fpath.read_text(encoding="utf-8")

        if not content.startswith("---"):
            errors.append(f"{fname}: Missing YAML frontmatter (no opening ---)")
            continue

        parts = content.split("---", 2)
        if len(parts) < 3:
            errors.append(f"{fname}: Malformed YAML frontmatter (no closing ---)")
            continue

        yaml_text = parts[1]

        try:
            data = yaml.safe_load(yaml_text)
        except yaml.YAMLError as e:
            errors.append(f"{fname}: YAML parse error: {e}")
            continue

        if not isinstance(data, dict):
            errors.append(f"{fname}: YAML frontmatter is not a dict")
            continue

        checked += 1

        if "permission" not in data:
            errors.append(f'{fname}: Missing "permission" section')
            continue

        perm = data["permission"]
        if not isinstance(perm, dict):
            errors.append(f'{fname}: "permission" is not a dict')
            continue

        # Check 'bash' is under 'permission'
        if "bash" not in perm:
            errors.append(f'{fname}: Missing "bash" under "permission"')
        else:
            bv = perm["bash"]
            if not isinstance(bv, dict) and bv not in ("allow", "deny", "ask"):
                errors.append(f'{fname}: "bash" under "permission" has unexpected type: {type(bv).__name__}')

        # Check 'edit' is under 'permission'
        if "edit" not in perm:
            errors.append(f'{fname}: Missing "edit" under "permission"')
        else:
            ev = perm["edit"]
            if not isinstance(ev, dict) and ev not in ("allow", "deny", "ask"):
                errors.append(f'{fname}: "edit" under "permission" has unexpected type: {type(ev).__name__}')

        # Check 'task' is under 'permission'
        if "task" not in perm:
            errors.append(f'{fname}: Missing "task" under "permission"')
        else:
            tv = perm["task"]
            if not isinstance(tv, dict) and tv not in ("allow", "deny", "ask"):
                errors.append(f'{fname}: "task" under "permission" has unexpected type: {type(tv).__name__}')

    if errors:
        print(f"Found {len(errors)} YAML frontmatter issue(s) out of {checked} agent files:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    else:
        print(f"All {checked} agent files have valid YAML frontmatter with correct permission structure.")
        sys.exit(0)


if __name__ == "__main__":
    main()