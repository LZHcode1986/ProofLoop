# Core Dispatch Packet

This contract defines the shared packet fields used by all Brain-to-Agent dispatches.

## Core fields

```yaml
route:
objective:
continuation: <task_id | none>
authoritative_inputs:
scope:
constraints:
out_of_scope:
expected_result:
```

## Usage

Each specific Contract (e.g., `brain/plan-stage.md`, `brain/execute-stage.md`) adds its own target-specific fields.

The Core Packet fields are defined here, not in brain.md. Brain dispatches according to the target Contract and this shared packet schema.