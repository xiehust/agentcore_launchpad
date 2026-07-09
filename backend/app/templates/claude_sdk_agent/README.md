# Claude Agent SDK container template

ARM64 image for AgentCore Runtime. Pinned versions verified 2026-07-09:

| Component | Version |
|---|---|
| python base | `python:3.12-slim` (arm64) |
| node | 22.x (nodesource) |
| `@anthropic-ai/claude-code` CLI | ≥2.1 (2.1.205 verified) |
| `claude-agent-sdk` (python) | ≥0.2,<1 (0.2.114 verified) |
| `bedrock-agentcore` | 1.17.* |
| `aws-opentelemetry-distro` | ≥0.10,<1 |

Bedrock mode: `CLAUDE_CODE_USE_BEDROCK=1` is baked into the image; the claude CLI
uses the runtime execution role for `bedrock:InvokeModel*` — no API key anywhere.

Subagents: drop markdown definitions into `.claude/agents/` (one sample,
`fact-checker`, ships with the scaffold). `setting_sources=["project"]` makes the
SDK load them from `/app/.claude`.
