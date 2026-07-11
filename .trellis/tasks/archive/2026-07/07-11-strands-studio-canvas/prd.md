# Agent management: create Strands agent via Strands Studio canvas

## Goal

Add a native "Strands Studio" creation method to Agent management: a canvas (visual flow editor) page inside the launchpad frontend where the user composes a Strands agent from nodes, previews the generated Python code, and publishes through the launchpad's existing pipeline. The resulting agent behaves exactly like agents created any other way — Chat, Evaluation, Experiments, and Insights work with no special-casing.

## Background & confirmed facts

- Canvas source: strands_studio_ui (`xiehust/strands_studio_ui`). The in-repo vendored app `apps/studio/` is byte-identical to upstream HEAD `456a042` for all four generator/validator libs — it is the port source; the external clone is not needed. `apps/studio` stays untouched as a standalone app.
- Today the studio experience is only an external link: `CreateAgent.tsx:300-318` links out to `VITE_STUDIO_URL` (standalone app, port 5273). There is no native canvas page.
- The backend `method="studio"` path already exists end-to-end: `AgentSpec.code` + `requirements` fields, studio in `SUPPORTED_METHODS`, zip fast path shared with `zip_runtime`, `adapt_studio_code()` wraps canvas CLI-style scripts into an AgentCore entrypoint, and eval/experiments whitelist `studio`. Basic publish needs zero backend changes (research/launchpad-agent-lifecycle.md).
- Code generation is 100% frontend and pure (`generateStrandsAgentCode(nodes, edges, graphMode) → {code, imports, errors}`); 8 droppable node types (agent, orchestrator-agent, swarm, tool, mcp-tool, custom-tool, input, output) + Graph Mode toggle; Bedrock + OpenAI-compatible model providers (research/strands-studio-architecture.md).
- Stack compatibility: `@xyflow/react@12` and `@monaco-editor/react@4` run on launchpad's React 18 — no framework upgrades. Styling clash (Tailwind light theme vs launchpad's hand-written dark CSS token system) is the main port effort.
- User decisions (2026-07-11): full Trellis planning before implementation (D1); canvas only orchestrates + generates code — deployment reuses the launchpad pipeline; strands_studio's own AgentCore/ECS/Lambda deploy panels are NOT ported (D2).

## Requirements

- R1: Agent management offers a Strands Studio method that opens a native canvas page (route `/create/studio`) inside the launchpad shell, replacing the current external link.
- R2: The canvas ports strands_studio_ui's full editing capability: 8 node types, connection rules, property editing, Graph Mode toggle — restyled to launchpad's design system (dark theme, no Tailwind).
- R3: The user can generate and preview the Strands Python code (with validation errors surfaced) before publishing; generation errors block publish.
- R4: Publish posts `{name, method:"studio", system_prompt, code, requirements, studio_flow}` to the existing `POST /api/agents`; the pipeline and registry behave exactly as for other studio agents; after publish the agent is usable in Chat, Evaluation, Experiments, Insights with zero special-casing. `requirements` is computed from the flow (adds `strands-agents[openai]` when an OpenAI-provider node exists — a gap the external app never covered).
- R5: The flow graph `{nodes, edges, graphMode}` persists in the agent spec (new additive `AgentSpec.studio_flow` field — the only backend change) so Edit on a studio agent reopens the canvas with the flow restored and re-publish works (`redeployAgent`; name/method immutable). Studio agents without a stored flow (created by the external app) degrade gracefully: empty canvas + notice + read-only code, publish disabled until a flow exists.
- R6: New page follows launchpad conventions: i18n parity (en + zh-CN `studio.*` keys), shared components (`useToast`, extracted `LaunchSequence`), theme tokens.
- R7: Documented upstream bug fixes ship with the port: `file_write` tool mapped in the generators (upstream silently generates `calculator`), invalid-connection `alert()` replaced with toast.

## Acceptance criteria

- [x] AC1: From `/create`, the Strands Studio card opens `/create/studio`; user can build a minimal flow (input + agent + built-in tool + output), connect it under the ported connection rules, and see valid generated Python code.
- [x] AC2: Publishing completes via the existing pipeline (generate→package→provision→deploy→register visible in LaunchSequence); the agent reaches `active` and its A2A registry record appears with the normal state machine.
- [x] AC3: The published canvas agent responds in Chat (`/chat?agent=<id>`).
- [x] AC4: The agent is selectable in Evaluation and completes at least one evaluation run like other runtime-backed agents.
- [x] AC5: Edit on the canvas agent restores the saved flow; modifying it and re-publishing succeeds (revision increments, same ARN).
- [x] AC6: `make verify` green (backend ruff+pytest, frontend lint+build); no regression in the wizard (step 3 LaunchSequence extraction), Chat, or Evaluation pages; en/zh-CN both render the new page without missing keys.

## Out of scope

- strands_studio_ui deploy panels (AgentCore/ECS/Lambda), execution/run-history subsystem, chat modal, and its FastAPI backend.
- Removing or refactoring the standalone `apps/studio` app.
- Sourcing the canvas model catalog from a backend registry (v1 ports the hardcoded list + launchpad's default model).

## Open questions

None. Styling strategy confirmed at review gate (2026-07-11): restyle onto launchpad's CSS token system, no Tailwind (design.md §3). Plan approved; implementation started same day.
