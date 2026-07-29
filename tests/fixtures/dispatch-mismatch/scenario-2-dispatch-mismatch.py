#!/usr/bin/env python3
"""Scenario 2 acceptance fixture: execute the built dispatch runtime."""

import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    root = Path(__file__).resolve().parents[3]
    runtime = root / ".agents" / "runtime" / "dist" / "dispatch-packets.js"
    packet = {
        "mode": "implement-task",
        "slice_id": "S02-A",
        "current_task_ids": ["S02-A-T01", "S02-A-T02"],
    }
    task_state = [
        {"task_id": "S02-A-T01", "checked": True},
        {"task_id": "S02-A-T02", "checked": False},
        {"task_id": "S02-A-T03", "checked": False},
    ]
    script = (
        "import { validateWorkerDispatch, redispatchFirstUncheckedTask } from "
        f"'file://{runtime.as_posix()}'; "
        "const input = JSON.parse(process.argv[1]); "
        "console.log(JSON.stringify({ validation: validateWorkerDispatch(input.packet, input.task_state), "
        "redispatch: redispatchFirstUncheckedTask(input.task_state) }));"
    )
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", script, json.dumps({"packet": packet, "task_state": task_state})],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        print(completed.stderr, file=sys.stderr)
        return completed.returncode
    result = json.loads(completed.stdout)
    validation = result["validation"]
    redispatch = result["redispatch"]
    if validation.get("result") != "DISPATCH_MISMATCH" or validation.get("subtype") != "MULTIPLE_TASKS_SUPPLIED":
        print(f"FAIL: built runtime returned {validation}", file=sys.stderr)
        return 1
    if redispatch.get("task_id") != "S02-A-T02":
        print(f"FAIL: built runtime selected {redispatch}", file=sys.stderr)
        return 1

    print("PASS: built runtime DISPATCH_MISMATCH / MULTIPLE_TASKS_SUPPLIED")
    print("PASS: built runtime redispatch_first_unchecked_task -> S02-A-T02")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
