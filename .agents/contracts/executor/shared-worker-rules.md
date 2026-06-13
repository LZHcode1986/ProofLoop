# Executor Shared Worker Dispatch Rules

Required Skills:
- Must be a final explicit list for this dispatch.
- Do not send formulas such as inherited skills or original skills plus another skill.
- If no skill is required, write None.

Skill instructions:
- Load every listed skill before implementation or fixing.
- Report evidence that each required skill was used.
- If diagnose is listed, load diagnose and follow its diagnosis loop.
- If Required Skills is None, do not load build skills unnecessarily.

Context files:
- Include only the minimum files or excerpts needed for the current task or fix.
- Do not include broad repository background.

Allowed file scope:
- Must be explicit.
- Must be narrow enough to prevent unrelated work.

Common Worker rules:
- Do not commit.
- Do not invoke subagents.
- Do not broaden scope.
- If required context is missing, return Implementation blocked: insufficient task context.
