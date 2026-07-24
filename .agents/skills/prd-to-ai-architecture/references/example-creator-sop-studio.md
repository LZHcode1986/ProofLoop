# Example: Creator SOP Studio

This example is based on a local AI conversation workstation PRD and technical clarification brief.

## Extracted Product Constraints

- Conversation is the only operation entry point.
- Left panel is read-only state, right panel is the conversation area.
- There are 9 stages: 00_profile through 08_review.
- Each stage persists an artifact.
- Each stage has Gate scoring and rework guidance.
- AI asks at most one question per response.
- User does not see CLI, JSON, paths, or prompts.
- AgentRuntime details are hidden from the user.

## Technical Clarifications

- Local app, no login.
- Workspace directory is account isolation.
- Stage artifacts persist as JSON.
- Chat history persists as Markdown plus metadata JSON.
- Backend uses SSE for streaming output and state changes.
- Intent-Aligner is a backend preprocessing layer.
- User can cancel streaming output through cancel API.
- File attachments are copied to stage input directories.

## Architecture Brief Sketch

### Containers

| Container | Responsibility | Notes |
|---|---|---|
| React frontend | Left stage panel, right chat window, attachment UI, SSE client | No raw JSON display |
| FastAPI backend | Chat API, SSE, TaskRunner, workspace/stage/artifact services | Port declared by architecture |
| Workspace filesystem | Stage artifacts, chat history, logs | Source of truth for local persistence |
| AgentRuntime adapters | Agy, OpenCode, Codex, Manual runtime | Hidden behind TaskRunner |

### Hard Parts

| Hard part | Forbidden shortcut | Acceptance evidence |
|---|---|---|
| SSE streaming + stage updates | Fake gradual text or polling-only status | AI reply streams and left panel updates automatically |
| Cancel running AI task | Only stop frontend rendering | Backend task enters canceled state and new message starts cleanly |
| Multi-workspace isolation | Global single state file | Switching workspace loads separate chat and stage state |
| Gate/Rework | Generic failure message | User sees plain-language reason and rework suggestion |
| Attachment handling | Only show filename | File copied to stage input path and rendered as attachment bubble |

### Foundational Task Groups

1. Workspace and stage state schema.
2. Chat history schema and persistence.
3. SSE event schema.
4. Backend chat/cancel APIs.
5. Frontend chat shell and streaming renderer.
6. Left panel stage state synchronization.
7. 00-03 flow.
8. 04-08 flow.
9. Final persistence and recovery tests.
