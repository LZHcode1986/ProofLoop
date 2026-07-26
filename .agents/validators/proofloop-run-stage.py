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
    parser.add_argument("--validate-only", action="store_true",
                        help="Validate structure only, do not execute commands")
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
    last_returncode = None
    while time.time() - start < READINESS_TIMEOUT:
        attempts += 1
        result = run_command(readiness_signal, cwd, timeout=10)
        if result.get("status") == "completed":
            return {
                "status": "completed",
                "readiness": f"{readiness_signal} \u2192 ready",
                "attempts": str(attempts),
            }
        last_returncode = result.get("returncode", "unknown")
        time.sleep(READINESS_INTERVAL)

    return {
        "status": "failed",
        "reason": (
            f"Readiness signal not received within {READINESS_TIMEOUT}s "
            f"({attempts} attempts, last return code: {last_returncode})"
        ),
    }


# ---------------------------------------------------------------------------
# Step execution helpers
# ---------------------------------------------------------------------------

def execute_build_step(content, cwd):
    """Run the Build subsection."""
    fields = extract_fields(content)
    command = fields.get("Command", "").strip()
    step = {"name": "Build"}
    if not command:
        if _check_not_applicable(content):
            step["status"] = "not-applicable"
            step["reason"] = "declared Not Applicable"
            return step
        step["status"] = "failed"
        step["reason"] = "no Command and not marked Not Applicable"
        return step
    if command.lower() == "not applicable":
        step["status"] = "not-applicable"
        step["reason"] = "declared Not Applicable"
        return step
    # Expected Result is required for real commands
    expected = fields.get("Expected Result", "")
    if not expected:
        step["status"] = "failed"
        step["reason"] = "Expected Result is required but missing"
        return step
    result = run_command(command, cwd)
    step.update(result)
    # Verify Expected Result against output
    match, reason = check_expected_result(expected, step)
    if not match:
        step["status"] = "failed"
        step["reason"] = reason
    return step


def execute_migration_step(content, cwd):
    """Run the Migration / Setup subsection."""
    fields = extract_fields(content)
    command = fields.get("Command", "").strip()
    step = {"name": "Migration"}
    if not command:
        if _check_not_applicable(content):
            step["status"] = "not-applicable"
            step["reason"] = "declared Not Applicable"
            return step
        step["status"] = "failed"
        step["reason"] = "no Command and not marked Not Applicable"
        return step
    if command.lower() == "not applicable":
        step["status"] = "not-applicable"
        step["reason"] = "declared Not Applicable"
        return step
    # Expected Result is required for real commands
    expected = fields.get("Expected Result", "")
    if not expected:
        step["status"] = "failed"
        step["reason"] = "Expected Result is required but missing"
        return step
    result = run_command(command, cwd)
    step.update(result)
    # Verify Expected Result against output
    match, reason = check_expected_result(expected, step)
    if not match:
        step["status"] = "failed"
        step["reason"] = reason
    return step


def execute_startup_step(content, cwd):
    """Start the service and wait for readiness.

    Returns ``(step_dict, process_or_none)`` where *process_or_none* is the
    ``subprocess.Popen`` handle if the service was started successfully,
    otherwise ``None``.
    """
    fields = extract_fields(content)
    command = fields.get("Command", "").strip()
    readiness = fields.get("Readiness Signal", "").strip()

    step = {"name": "Startup"}

    if not command:
        if _check_not_applicable(content):
            step["status"] = "not-applicable"
            step["reason"] = "declared Not Applicable"
            return step, None
        step["status"] = "failed"
        step["reason"] = "no Command and not marked Not Applicable"
        return step, None

    if command.lower() == "not applicable":
        step["status"] = "not-applicable"
        step["reason"] = "declared Not Applicable"
        return step, None

    # Readiness Signal is mandatory when a real Startup command is configured
    if not readiness:
        step["status"] = "failed"
        step["reason"] = "Startup command requires Readiness Signal but none provided"
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

    # Poll readiness signal
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
    # Check top-level Status field first
    top_fields = extract_fields(content)
    if top_fields.get("Status", "").lower() == "not applicable":
        reason = top_fields.get("Reason", "")
        return [{"name": "Smoke Scenarios", "status": "not-applicable", "reason": reason or "marked Not Applicable"}]

    scenarios = parse_smoke_scenarios(content)

    # Require at least one executable scenario
    has_executable = any(
        s.get("Command / Action", "").strip()
        and s.get("Command / Action", "").strip().lower() != "not applicable"
        for s in scenarios
    )
    if not scenarios or not has_executable:
        return [{"name": "Smoke Scenarios", "status": "failed", "reason": "no executable smoke scenarios"}]

    steps = []
    for i, scenario in enumerate(scenarios, 1):
        scenario_name = scenario.get("Scenario", f"Scenario {i}")
        command = scenario.get("Command / Action", "").strip()
        step = {"name": f"Smoke Scenario {i}: {scenario_name}"}
        if not command:
            step["status"] = "not-applicable"
            step["reason"] = "declared Not Applicable"
            steps.append(step)
            continue
        if command.lower() == "not applicable":
            step["status"] = "not-applicable"
            step["reason"] = "declared Not Applicable"
            steps.append(step)
            continue
        # Expected Observation is required for real commands
        expected_obs = scenario.get("Expected Observation", "")
        if not expected_obs:
            step["status"] = "failed"
            step["reason"] = "Expected Observation is required but missing"
            steps.append(step)
            continue
        # Safety: run_command already rejects dangerous patterns
        result = run_command(command, cwd)
        step.update(result)
        # Verify Expected Observation against output
        stdout = step.get("stdout", "") or ""
        stderr = step.get("stderr", "") or ""
        if expected_obs not in stdout and expected_obs not in stderr:
            step["status"] = "failed"
            step["reason"] = (
                f"Expected Observation '{expected_obs}' not found in output"
            )
        steps.append(step)
    return steps


def _force_kill(process):
    """Force-kill a subprocess on Windows."""
    import signal
    if os.name == 'nt':
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True)
    else:
        process.kill()


def execute_shutdown_step(content, cwd, startup_process=None):
    """Run the Shutdown / Cleanup subsection, or kill the startup process."""
    step = {"name": "Shutdown"}

    # If startup process exists, must terminate it
    if startup_process is not None:
        # Try shutdown command first if provided and not N/A
        if content:
            fields = extract_fields(content)
            command = fields.get("Command", "")
            if command and command.lower() != "not applicable":
                result = run_command(command, cwd)
                step.update(result)
                # Even if command succeeded, verify process exited
                try:
                    startup_process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    # Command didn't terminate process, kill it
                    _force_kill(startup_process)
                    step["status"] = "failed"
                    step["reason"] = "Shutdown command did not terminate process; process was killed"
                    return step
                return step

        # No shutdown command or N/A: must kill startup process
        try:
            startup_process.terminate()
            startup_process.wait(timeout=10)
            if startup_process.poll() is not None:
                step["status"] = "completed"
                step["reason"] = "startup process terminated via fallback"
            else:
                _force_kill(startup_process)
                step["status"] = "completed"
                step["reason"] = "startup process force-killed"
        except Exception as e:
            try:
                _force_kill(startup_process)
            except Exception:
                pass
            if startup_process.poll() is None:
                step["status"] = "failed"
                step["reason"] = f"failed to terminate startup process: {e}"
            else:
                step["status"] = "completed"
                step["reason"] = "process exited despite error"
        return step

    # No startup process
    if content:
        fields = extract_fields(content)
        command = fields.get("Command", "")
        if command and command.lower() != "not applicable":
            result = run_command(command, cwd)
            step.update(result)
            return step
        if _check_not_applicable(content) or (command and command.lower() == "not applicable"):
            step["status"] = "not-applicable"
            step["reason"] = "declared Not Applicable"
            return step

    step["status"] = "skipped"
    step["reason"] = "no startup process and no shutdown command"
    return step


# ---------------------------------------------------------------------------
# Status determination helpers
# ---------------------------------------------------------------------------

def is_failure_status(status):
    return status in ("failed", "rejected", "timeout")


def all_skipped(steps):
    return all(s.get("status") in ("skipped",) for s in steps)


def check_expected_result(expected, result_dict):
    """Check if the actual result matches the expected result.

    Expected format:
      - ``exit code: N``              \u2192 assert returncode == N
      - ``output contains: TEXT``     \u2192 assert TEXT in stdout or stderr
      - ``output matches: REGEX``     \u2192 assert regex matches stdout+stderr

    Returns ``(match: bool, reason: str | None)``.
    """
    if not expected or not expected.strip():
        return True, None

    expected = expected.strip()

    # exit code: N
    m = re.match(r'^exit code:\s*(\d+)$', expected, re.IGNORECASE)
    if m:
        expected_code = int(m.group(1))
        actual_code = result_dict.get("returncode")
        if actual_code is None:
            return False, "No return code available to compare"
        if actual_code != expected_code:
            return False, f"Expected exit code {expected_code}, got {actual_code}"
        return True, None

    # output contains: TEXT
    m = re.match(r'^output contains:\s*(.+)$', expected, re.IGNORECASE | re.DOTALL)
    if m:
        text = m.group(1)
        stdout = result_dict.get("stdout", "") or ""
        stderr = result_dict.get("stderr", "") or ""
        if text not in stdout and text not in stderr:
            return False, f"Expected output to contain '{text}'"
        return True, None

    # output matches: REGEX
    m = re.match(r'^output matches:\s*(.+)$', expected, re.IGNORECASE | re.DOTALL)
    if m:
        pattern = m.group(1)
        stdout = result_dict.get("stdout", "") or ""
        stderr = result_dict.get("stderr", "") or ""
        combined = stdout + "\n" + stderr
        if not re.search(pattern, combined):
            return False, f"Expected output to match pattern '{pattern}'"
        return True, None

    # Unknown format \u2014 fail closed
    return False, "Unrecognized Expected Result format"


def _check_not_applicable(content):
    """Check if a phase or scenario declares ``Not Applicable`` via content."""
    return "not applicable" in content.lower()


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

    # ---- Verify Git branch ----
    if args.branch:
        try:
            result = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=repo_path, capture_output=True, text=True, timeout=30)
            current_branch = result.stdout.strip()
            if current_branch != args.branch:
                output = {
                    "stage": stage_id,
                    "status": "FAIL",
                    "reason": f"Expected branch '{args.branch}', currently on '{current_branch}'",
                    "results": [],
                }
                print(json.dumps(output, indent=2))
                sys.exit(1)
        except Exception as e:
            output = {
                "stage": stage_id,
                "status": "BLOCKED",
                "reason": f"Failed to check Git branch: {e}",
                "results": [],
            }
            print(json.dumps(output, indent=2))
            sys.exit(1)

    steps = []
    startup_process = None

    # ---- Validate required phases ----
    REQUIRED_PHASES = ["Build", "Migration / Setup", "Startup", "Smoke Scenarios", "Shutdown / Cleanup"]
    missing_required = [p for p in REQUIRED_PHASES if p not in subsections]
    if missing_required:
        output = {
            "stage": stage_id,
            "status": "BLOCKED",
            "reason": f"Missing required phases: {', '.join(missing_required)}",
            "results": [],
        }
        print(json.dumps(output, indent=2))
        sys.exit(1)

    # ---- Validate non-empty Command / Not Applicable ----
    for phase_name in ["Build", "Migration / Setup", "Startup", "Shutdown / Cleanup"]:
        pfields = extract_fields(subsections[phase_name])
        pcmd = pfields.get("Command", "").strip()
        if not pcmd:
            if not _check_not_applicable(subsections[phase_name]):
                output = {
                    "stage": stage_id,
                    "status": "FAIL",
                    "reason": f"Phase '{phase_name}' has empty Command (declare 'Not Applicable' if intentional)",
                    "results": [],
                }
                print(json.dumps(output, indent=2))
                sys.exit(1)

    # Smoke Scenarios: at least one executable scenario or Not Applicable
    if not _check_not_applicable(subsections["Smoke Scenarios"]):
        scenarios = parse_smoke_scenarios(subsections["Smoke Scenarios"])
        if not scenarios or not any(
            s.get("Command / Action", "").strip()
            and s.get("Command / Action", "").strip().lower() != "not applicable"
            for s in scenarios
        ):
            output = {
                "stage": stage_id,
                "status": "FAIL",
                "reason": "Smoke Scenarios has no executable scenarios (declare 'Not Applicable' if intentional)",
                "results": [],
            }
            print(json.dumps(output, indent=2))
            sys.exit(1)

    # ---- Validate-only mode ----
    if args.validate_only:
        # Check Expected Result format for Build and Migration/Setup only
        EXPECTED_RESULT_PHASES = ["Build", "Migration / Setup"]
        for phase_name in EXPECTED_RESULT_PHASES:
            pfields = extract_fields(subsections[phase_name])
            pcmd = pfields.get("Command", "").strip()
            if pcmd and pcmd.lower() != "not applicable" and not _check_not_applicable(subsections[phase_name]):
                expected = pfields.get("Expected Result", "").strip()
                # Expected Result is mandatory when a real command is present
                if not expected:
                    output = {
                        "stage": stage_id,
                        "branch": args.branch,
                        "status": "BLOCKED",
                        "reason": f"Phase '{phase_name}' has a real command but no Expected Result",
                        "results": [],
                    }
                    print(json.dumps(output, indent=2))
                    sys.exit(1)
                if expected:
                    # Check format recognition without running commands
                    if re.match(r'^exit code:\s*\d+$', expected, re.IGNORECASE):
                        pass  # valid format
                    elif re.match(r'^output contains:\s*.+$', expected, re.IGNORECASE | re.DOTALL):
                        pass  # valid format
                    elif re.match(r'^output matches:\s*.+$', expected, re.IGNORECASE | re.DOTALL):
                        pass  # valid format
                    else:
                        output = {
                            "stage": stage_id,
                            "branch": args.branch,
                            "status": "BLOCKED",
                            "reason": f"Phase '{phase_name}' has unrecognized Expected Result format",
                            "results": [],
                        }
                        print(json.dumps(output, indent=2))
                        sys.exit(1)

        # Check Smoke Scenarios Expected Observation (top-level Status: Not Applicable only)
        smoke_fields = extract_fields(subsections["Smoke Scenarios"])
        smoke_na = smoke_fields.get("Status", "").lower() == "not applicable"
        if not smoke_na:
            scenarios = parse_smoke_scenarios(subsections["Smoke Scenarios"])
            for scenario in scenarios:
                cmd = scenario.get("Command / Action", "").strip()
                if cmd and cmd.lower() != "not applicable":
                    expected_obs = scenario.get("Expected Observation", "").strip()
                    if not expected_obs:
                        output = {
                            "stage": stage_id,
                            "branch": args.branch,
                            "status": "BLOCKED",
                            "reason": f"Smoke scenario '{scenario.get('Scenario', 'unknown')}' has a real command but no Expected Observation",
                            "results": [],
                        }
                        print(json.dumps(output, indent=2))
                        sys.exit(1)
        # Validate-only mode: check structure, don't execute
        output = {
            "stage": stage_id,
            "branch": args.branch,
            "status": "STRUCTURE_VALID",
            "reason": "Runtime Proof structure validated successfully (no commands executed)",
        }
        print(json.dumps(output, indent=2))
        sys.exit(0)

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
    # completed / not-applicable → pass; skipped / failed / timeout / rejected → fail
    all_pass = all(s.get("status") in ("completed", "not-applicable") for s in steps)
    any_blocker = any(s.get("status") == "blocked" for s in steps)

    if not steps:
        overall_status = "FAIL"
    elif any_blocker:
        overall_status = "BLOCKED"
    elif all_pass:
        overall_status = "PASS"
    else:
        overall_status = "FAIL"

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
