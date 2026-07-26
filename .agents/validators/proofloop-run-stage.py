#!/usr/bin/env python3
"""
Stage Runtime Proof Runner.

Usage:
    python .agents/validators/proofloop-run-stage.py --stage <stage-id> --path <repo-root> [--branch <branch>]

Parses the ## Stage Runtime Proof section from delivery/stages/<stage-id>/tasks.md
and executes each step in order: Build, Migration/Setup, Startup (with readiness
polling), Smoke Scenarios, Shutdown/Cleanup.

Outputs a JSON summary with PASS | FAIL | BLOCKED status.
Does NOT modify project content.
"""

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def parse_args():
    parser = argparse.ArgumentParser(description="Stage Runtime Proof Runner")
    parser.add_argument("--stage", required=True, help="Stage ID (e.g. S01)")
    parser.add_argument("--path", default=".", help="Repository root path")
    parser.add_argument("--branch", help="Stage branch (optional)")
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Command execution
# ---------------------------------------------------------------------------

def run_command(command, cwd, timeout=300):
    """Run a single command and return a result dict.

    Returns ``status`` one of: ``completed``, ``failed``, ``rejected``,
    ``skipped``, or ``timeout``.
    """
    if not command or not command.strip():
        return {"status": "skipped", "reason": "empty command"}

    # Security: reject shell chaining, redirects, and dangerous patterns
    dangerous_patterns = ["&&", "||", ";", "|", ">", "<", "`", "$("]
    for pattern in dangerous_patterns:
        if pattern in command:
            return {
                "status": "rejected",
                "reason": f"Dangerous pattern '{pattern}' in command: {command}",
            }

    parts = shlex.split(command)
    if not parts:
        return {"status": "rejected", "reason": "empty command after parsing"}

    try:
        result = subprocess.run(
            parts,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return {
            "status": "completed" if result.returncode == 0 else "failed",
            "returncode": result.returncode,
            "stdout": result.stdout[:2000],
            "stderr": result.stderr[:1000],
        }
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "reason": f"command timed out after {timeout}s"}
    except FileNotFoundError:
        return {"status": "failed", "reason": f"command not found: {parts[0]}"}
    except Exception as e:
        return {"status": "failed", "reason": str(e)}


# ---------------------------------------------------------------------------
# tasks.md parser — Stage Runtime Proof section
# ---------------------------------------------------------------------------

def parse_runtime_proof(content):
    """Extract the ``## Stage Runtime Proof`` section and its subsections.

    Returns a dict mapping subsection title (e.g. ``"Build"``,
    ``"Migration / Setup"``) to the raw text content of that subsection,
    or ``None`` if the section is not found.
    """
    section_match = re.search(
        r'## Stage Runtime Proof\s*\n(.*?)(?=\n## |\Z)',
        content,
        re.DOTALL,
    )
    if not section_match:
        return None

    section_text = section_match.group(1)

    # Split into subsections by ### header
    subsections = {}
    pattern = r'### ([^\n]+)\n(.*?)(?=\n### |\Z)'
    for match in re.finditer(pattern, section_text, re.DOTALL):
        name = match.group(1).strip()
        body = match.group(2).strip()
        subsections[name] = body

    return subsections


def extract_fields(content):
    """Extract ``- key: value`` lines from subsection content.

    Returns a dict of ``{key: value}``.
    """
    fields = {}
    for line in content.split("\n"):
        m = re.match(r"- ([A-Za-z /]+?):\s*(.*)", line)
        if m:
            key = m.group(1).strip()
            value = m.group(2).strip()
            fields[key] = value
    return fields


def parse_smoke_scenarios(content):
    """Parse the Smoke Scenarios subsection into a list of scenario dicts.

    Each scenario begins with ``- Scenario:`` followed by its name, then
    optional fields like ``- Command / Action:`` and
    ``- Expected Observation:``.
    """
    scenarios = []
    # Split on "- Scenario:" boundaries
    blocks = re.split(r"- Scenario:\s*", content)
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        lines = block.split("\n")
        name = lines[0].strip()
        # Skip if the name is empty or looks like a field line (starts with '- ')
        if not name or name.startswith("- "):
            continue
        scenario = {"Scenario": name}
        for line in lines[1:]:
            m = re.match(r"- ([A-Za-z /]+?):\s*(.*)", line)
            if m:
                key = m.group(1).strip()
                value = m.group(2).strip()
                scenario[key] = value
        scenarios.append(scenario)
    return scenarios


# ---------------------------------------------------------------------------
# Readiness polling
# ---------------------------------------------------------------------------

READINESS_TIMEOUT = 90      # max seconds to wait for the service to be ready
READINESS_INTERVAL = 3       # seconds between polls


def wait_for_readiness(readiness_signal, cwd):
    """Poll *readiness_signal* until it returns exit code 0.

    Returns a result dict with ``status`` ``completed`` or ``failed``.
    """
    start = time.time()
    attempts = 0
    while time.time() - start < READINESS_TIMEOUT:
        attempts += 1
        result = run_command(readiness_signal, cwd, timeout=10)
        if result.get("status") == "completed":
            return {
                "status": "completed",
                "readiness": f"{readiness_signal} \u2192 ready",
                "attempts": str(attempts),
            }
        time.sleep(READINESS_INTERVAL)

    return {
        "status": "failed",
        "reason": (
            f"Readiness signal not received within {READINESS_TIMEOUT}s "
            f"({attempts} attempts)"
        ),
    }


# ---------------------------------------------------------------------------
# Step execution helpers
# ---------------------------------------------------------------------------

def execute_build_step(content, cwd):
    """Run the Build subsection."""
    fields = extract_fields(content)
    command = fields.get("Command", "")
    step = {"name": "Build"}
    if command:
        result = run_command(command, cwd)
        step.update(result)
    else:
        step["status"] = "skipped"
        step["reason"] = "no Command field"
    return step


def execute_migration_step(content, cwd):
    """Run the Migration / Setup subsection."""
    fields = extract_fields(content)
    command = fields.get("Command", "")
    step = {"name": "Migration"}
    if command:
        result = run_command(command, cwd)
        step.update(result)
    else:
        step["status"] = "skipped"
        step["reason"] = "no Command field"
    return step


def execute_startup_step(content, cwd):
    """Start the service and wait for readiness.

    Returns ``(step_dict, process_or_none)`` where *process_or_none* is the
    ``subprocess.Popen`` handle if the service was started successfully,
    otherwise ``None``.
    """
    fields = extract_fields(content)
    command = fields.get("Command", "")
    readiness = fields.get("Readiness Signal", "")

    step = {"name": "Startup"}

    if not command:
        step["status"] = "skipped"
        step["reason"] = "no Command field"
        return step, None

    # Security check (same patterns as ``run_command``)
    dangerous_patterns = ["&&", "||", ";", "|", ">", "<", "`", "$("]
    for pattern in dangerous_patterns:
        if pattern in command:
            step["status"] = "rejected"
            step["reason"] = f"Dangerous pattern '{pattern}' in command"
            return step, None

    parts = shlex.split(command)
    if not parts:
        step["status"] = "rejected"
        step["reason"] = "empty command after parsing"
        return step, None

    # Start the service process in the background
    try:
        process = subprocess.Popen(
            parts,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except FileNotFoundError:
        step["status"] = "failed"
        step["reason"] = f"command not found: {parts[0]}"
        return step, None
    except Exception as e:
        step["status"] = "failed"
        step["reason"] = f"Failed to start: {e}"
        return step, None

    # Give the process a moment to fail fast (e.g. invalid config)
    time.sleep(1)
    if process.poll() is not None and process.returncode != 0:
        stdout = process.stdout.read(2000) if process.stdout else ""
        stderr = process.stderr.read(1000) if process.stderr else ""
        step["status"] = "failed"
        step["returncode"] = str(process.returncode)
        step["stdout"] = stdout[:2000]
        step["stderr"] = stderr[:1000]
        step["reason"] = "process exited prematurely"
        return step, None

    # Poll readiness signal if one is declared
    if readiness:
        readiness_result = wait_for_readiness(readiness, cwd)
        if readiness_result["status"] != "completed":
            # Service didn't become ready — kill it
            try:
                process.kill()
                process.wait(timeout=10)
            except Exception:
                pass
            step["status"] = "failed"
            step["readiness_attempts"] = readiness_result.get("attempts", "0")
            step["reason"] = readiness_result.get("reason", "readiness check failed")
            return step, None
        step["readiness"] = readiness_result.get("readiness", "")

    step["status"] = "completed"
    return step, process


def execute_smoke_scenarios_step(content, cwd):
    """Run all smoke test scenarios declared in the subsection.

    Returns a list of step result dicts (one per scenario).
    """
    scenarios = parse_smoke_scenarios(content)
    steps = []
    for i, scenario in enumerate(scenarios, 1):
        scenario_name = scenario.get("Scenario", f"Scenario {i}")
        command = scenario.get("Command / Action", "")
        step = {"name": f"Smoke Scenario {i}: {scenario_name}"}
        if command:
            # Safety: run_command already rejects dangerous patterns
            result = run_command(command, cwd)
            step.update(result)
        else:
            step["status"] = "skipped"
            step["reason"] = "no Command / Action field"
        steps.append(step)
    return steps


def execute_shutdown_step(content, cwd, startup_process=None):
    """Run the Shutdown / Cleanup subsection, or kill the startup process."""
    step = {"name": "Shutdown"}

    if content:
        fields = extract_fields(content)
        command = fields.get("Command", "")
        if command:
            result = run_command(command, cwd)
            step.update(result)
            return step

    # Fallback: kill the startup process if we have one
    if startup_process is not None:
        try:
            startup_process.kill()
            startup_process.wait(timeout=10)
            step["status"] = "completed"
            step["reason"] = "startup process terminated"
        except Exception as e:
            step["status"] = "completed"
            step["reason"] = f"attempted termination: {e}"
        return step

    step["status"] = "skipped"
    step["reason"] = "no Command field and no startup process to terminate"
    return step


# ---------------------------------------------------------------------------
# Status determination helpers
# ---------------------------------------------------------------------------

def is_failure_status(status):
    return status in ("failed", "rejected", "timeout")


def all_skipped(steps):
    return all(s.get("status") in ("skipped",) for s in steps)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    args = parse_args()
    stage_id = args.stage
    repo_path = os.path.abspath(args.path)

    # ---- Locate tasks.md ----
    tasks_md = os.path.join(repo_path, "delivery", "stages", stage_id, "tasks.md")
    if not os.path.exists(tasks_md):
        output = {
            "stage": stage_id,
            "status": "BLOCKED",
            "reason": f"tasks.md not found at {tasks_md}",
            "results": [],
        }
        print(json.dumps(output, indent=2))
        sys.exit(1)

    # ---- Read tasks.md ----
    with open(tasks_md, "r", encoding="utf-8") as f:
        tasks_content = f.read()

    # ---- Parse Runtime Proof section ----
    subsections = parse_runtime_proof(tasks_content)
    if not subsections:
        output = {
            "stage": stage_id,
            "status": "BLOCKED",
            "reason": "## Stage Runtime Proof section not found in tasks.md",
            "results": [],
        }
        print(json.dumps(output, indent=2))
        sys.exit(1)

    steps = []
    startup_process = None

    # ---- Step 1: Build ----
    if "Build" in subsections:
        step = execute_build_step(subsections["Build"], repo_path)
        steps.append(step)

    # ---- Step 2: Migration / Setup ----
    if "Migration / Setup" in subsections:
        step = execute_migration_step(subsections["Migration / Setup"], repo_path)
        steps.append(step)

    # ---- Step 3: Startup ----
    if "Startup" in subsections:
        step, proc = execute_startup_step(subsections["Startup"], repo_path)
        startup_process = proc
        steps.append(step)

    # ---- Step 4: Smoke Scenarios ----
    if "Smoke Scenarios" in subsections:
        scenario_steps = execute_smoke_scenarios_step(
            subsections["Smoke Scenarios"], repo_path
        )
        steps.extend(scenario_steps)

    # ---- Step 5: Shutdown / Cleanup ----
    shutdown_content = subsections.get("Shutdown / Cleanup", "")
    step = execute_shutdown_step(shutdown_content, repo_path, startup_process)
    steps.append(step)

    # ---- Determine overall status ----
    if not steps:
        overall_status = "FAIL"
        output = {
            "stage": stage_id,
            "branch": args.branch,
            "status": overall_status,
            "reason": "no steps executed",
        }
        print(json.dumps(output, indent=2))
        sys.exit(1)

    # Determine if any step failed
    any_failure = any(is_failure_status(s.get("status")) for s in steps)
    everything_skipped = all_skipped(steps)

    if everything_skipped:
        overall_status = "FAIL"
        output = {
            "stage": stage_id,
            "branch": args.branch,
            "status": overall_status,
            "reason": "all steps skipped (no commands configured)",
            "steps": steps,
        }
    elif any_failure:
        overall_status = "FAIL"
        output = {
            "stage": stage_id,
            "branch": args.branch,
            "status": overall_status,
            "steps": steps,
        }
    else:
        overall_status = "PASS"
        output = {
            "stage": stage_id,
            "branch": args.branch,
            "status": overall_status,
            "steps": steps,
        }

    print(json.dumps(output, indent=2))
    sys.exit(0 if overall_status == "PASS" else 1)


if __name__ == "__main__":
    main()
