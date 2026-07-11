# Studio canvas: caching/effort defaults, aws-knowledge MCP sample, local debug + AI fix

## Goal

Four user-requested improvements to the native Strands Studio canvas (2026-07-11):

1. The `agent-with-mcp` sample's "Docs MCP Server" example points at the public **aws-knowledge MCP server** (`https://knowledge-mcp.global.api.aws`) instead of `http://localhost:8811/mcp`.
2. Complete the caching triad: add **system-prompt caching** alongside the existing message (`CacheConfig(strategy="auto")`) and tool (`cache_tools="default"`) toggles, per the strands Bedrock docs.
3. New-agent defaults: **streaming ON** for main agents, a **reasoning-effort tier (low/medium/high/xhigh)** for Bedrock Claude agents, and **max output tokens default 32000**.
4. **Local invoke/chat mode** in the studio for debugging un-deployed flows, with **AI Fix** — port the upstream (strands_studio_ui origin/main) execution / conversation / fix-code subsystems into the launchpad backend and rebuild the panels launchpad-styled.

## User decisions (2026-07-11)

- D1: One Trellis task for all four items; full planning.
- D2: Item 4 depth = **port upstream modules** (subprocess execution + timeout, SSE streaming, `--messages` replay, `[CHAT_ERROR]` sentinel, AI Fix diagnosis + repair loop with a Claude-on-Bedrock coding backend) — not a lite version.

## Requirements

- R1: `frontend/src/studio/lib/sample-flows/agent-with-mcp.ts` MCP node → aws-knowledge server (streamable_http, `https://knowledge-mcp.global.api.aws`, no auth); documented as a sample-data deviation from upstream byte-parity. Sample still loads and generates valid MCPClient code.
- R2: Property panel gains a third caching toggle (system prompt cache) for Bedrock Claude agents/orchestrators; the generator emits the strands-documented pattern (exact shape per research — SystemContentBlock cachePoint vs deprecated cache_prompt); data key additive; old graphs unaffected (default off).
- R3: Reasoning-effort select (low/medium/high/xhigh) for **Bedrock** Claude agents (exact `additional_request_fields` shape verified by live probe); streaming default ON for main agents; maxTokens default 32000 (verified against catalog model output caps — clamp/per-model if needed). Backward compat: fallbacks only affect nodes that never set the keys; explicit old values respected.
- R4: Studio page gains a local debug surface: run the generated code locally (backend subprocess with timeout, streamed stdout via SSE), single-shot invoke AND multi-turn chat (`--messages` replay), explicit error signaling; works without publishing.
- R5: AI Fix: on a failed local run/chat turn, one action diagnoses (code/config/environment) and repairs the code via the ported fix pipeline (Claude on Bedrock as the coding backend); the fixed code becomes the active code for subsequent local runs/chat and can be published (code-state handling per design); user can always regenerate from the flow (discarding fixes).
- R6: The local debug env can actually run generated Strands code on this host (dedicated/managed python env with strands-agents[openai]+tools; AWS creds available); skills resolve via STUDIO_SKILLS_DIR or equivalent so skill nodes work locally too.
- R7: No route collisions with existing launchpad APIs (chat vs local-debug conversations namespaced apart); i18n parity for all new UI; launchpad styling only.
- R8: `make verify` green; docs/studio-integration.md updated (new endpoints, caching triad, effort tiers, local-debug + AI Fix contract, sample deviation).

## Acceptance Criteria

- [x] AC1: Loading the agent-with-mcp sample shows the aws-knowledge MCP node; generated code contains the `https://knowledge-mcp.global.api.aws` streamable_http client; (live) a local run answers an AWS question through it.
- [x] AC2: Toggling system cache on a Bedrock agent emits the documented system-prompt cachePoint pattern; all three caches can be enabled together and the code runs.
- [x] AC3: A freshly dropped agent node has streaming ON and maxTokens 32000; Bedrock effort tiers emit the probe-verified request fields; old saved graphs (studio-canvas-e2e, studio-skill-e2e) still restore/regenerate/re-publish unchanged in behavior.
- [x] AC4: From the canvas, local invoke of a flow streams output without deploying; multi-turn local chat holds context across turns; an intentionally broken flow surfaces an explicit error.
- [x] AC5: AI Fix on that broken flow produces a diagnosis + repaired code; re-running locally succeeds; the fix survives into chat continuation; regenerate-from-flow discards it.
- [x] AC6: `make verify` green; i18n parity; no regression in publish/edit/re-publish, platform Chat, Evaluation.

## Out of scope

- Upstream's AI code GENERATION feature (generate-from-prompt) — only AI Fix is ported (flag in design how separable they are; generation may be a follow-up).
- Re-vendoring `apps/studio/`.
- Execution history persistence UI (decide in design whether the backend keeps any history at all).

## Resolved facts (research/cache-effort-probe.md + research/upstream-exec-chat-fix.md)

- Effort (live-probed): the ONLY accepted shape is `additionalModelRequestFields={"output_config":{"effort":"<tier>"}}` combined with `thinking:{type:"adaptive"}`; effort without adaptive thinking emits no reasoning. Tier validity is model-dependent: Claude 4.6-gen accepts low/medium/high/max (REJECTS xhigh); Sonnet 5 / Opus 4.8 accept xhigh too → UI gates xhigh per model + generator clamps xhigh→high defensively (design §3).
- System cache: `BedrockModel(cache_prompt="default")` works in strands 1.47 (deprecated, one runtime UserWarning) — chosen over the SystemContentBlock form (which would touch ~10 system_prompt emission sites). Short prompts are a silent no-op (probed), no guard needed.
- 32000 max_tokens: valid for Claude/gpt-oss/qwen/deepseek; **Nova Pro caps at 10000** (would ValidationException), Nova Premier exactly 32000 → generator clamp table (design §3).
- Streaming: single codegen gate (`code-generator.ts:852`); only the top-level execution agent streams; flipping the fallback affects only undefined-streaming nodes (all sample flows are explicit).
- Local debug port: upstream subsystems inventoried (execute/stream with the multiline-SSE framing fix, /api/conversations* with --messages replay + failed-turn pairing + [CHAT_ERROR] sentinel, fix-code/stream with diagnosis/repair-loop/revert guards, ClaudeSdkBackend over Bedrock). Route collision scan CLEAN. Exec env: dedicated uv venv `data/exec-venv` (strands>=1.46) + `studio_exec_python` setting; skills for local runs reuse zip_runtime's `bundle_skills` into the workdir. CodeState `{code, source template|ai, flowStale}` lifts into CreateAgentStudio; publish reads it (AI-fixed code publishable, flow regenerate discards).
- aws-knowledge MCP live-verified: streamable_http, no auth (`serverInfo AWSKnowledgeMCP v1.0.0`).

## Open questions

None blocking. Design calls pending review-gate confirmation: xhigh model-gating + Nova clamp, `cache_prompt` deprecation trade-off, dedicated exec venv, AI-fix code publishes as-is (flowStale-badged).
