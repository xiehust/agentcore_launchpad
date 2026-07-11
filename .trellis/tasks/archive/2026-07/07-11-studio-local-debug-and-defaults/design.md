# Design: caching triad / effort tiers / defaults / aws-knowledge sample / local debug + AI fix

Evidence: `research/cache-effort-probe.md` (live Bedrock probes) + `research/upstream-exec-chat-fix.md` (upstream subsystem inventory @ origin/main 4a6e3c8). Anchors live there.

## 0. Deviation & extension ledger (supersedes previous docs' list)

The generator libs remain upstream-synced; launchpad-specific edits are now tracked in two classes (docs/studio-integration.md must restate this):

- **Deviations** (re-apply on every upstream re-sync): `file_write` + `mem0_memory` in both generators' import+map.
- **Extensions** (launchpad-only features, clearly comment-marked `// launchpad extension` blocks): system-prompt cache (`cacheSystem` → `cache_prompt="default"`), Bedrock `output_config.effort` emission (+ per-model xhigh clamp), per-model `max_tokens` clamp table, streaming/maxTokens fallback defaults, aws-knowledge sample data.

## 1. Item 1 — aws-knowledge MCP sample (data-only)

`sample-flows/agent-with-mcp.ts` mcp-tool node: `url → https://knowledge-mcp.global.api.aws`, `serverName → aws_knowledge`, label/description/flow-description cosmetics; `transportType: streamable_http` unchanged; no auth (probe: initialize OK, serverInfo AWSKnowledgeMCP v1.0.0). Generator emits `MCPClient(lambda: streamablehttp_client("<url>"))` — works as-is. Sample no longer byte-identical to upstream → extension ledger.

## 2. Item 2 — system-prompt cache (caching triad complete)

- New node data key `cacheSystem: boolean` (default false; agent + orchestrator, Bedrock only — same placement as the existing two toggles).
- Codegen (probe §1d Option A): in the three `generateModelConfig*` Bedrock branches, `if (cacheSystem)` emit `cache_prompt="default",` alongside `cache_config`/`cache_tools`. Keeps `system_prompt="""..."""` untouched at all ~10 emission sites; works in strands 1.47 (deprecated: one runtime UserWarning on stderr — acceptable, documented). Short prompts are a silent no-op (probed), so no min-length UI guard needed; add a hint line instead.
- UI: third checkbox "Cache system prompt" in the caching group + i18n.

## 3. Item 3 — streaming ON / effort tiers / 32k default

### Streaming (probe §3a)
- Flip the single codegen gate `code-generator.ts:852` → `?? true` AND PropertyPanel display `:592` → `?? true` (consistent pair), plus explicit `streaming: true` in the FlowEditor agent drop default. Only the top-level execution agent streams (structural — swarm/sub-agents unaffected).
- Backward compat: only nodes with `streaming === undefined` flip on (all sample flows set it explicitly; `studio-canvas-e2e`'s agent has it undefined → will start streaming — benign: `adapt_studio_code`'s entrypoint captures streamed stdout identically; AC verifies).

### Reasoning effort for Bedrock Claude (probe §2 — live-verified)
- Emit shape: `additional_request_fields = {"thinking": {"type": "adaptive"}, "output_config": {"effort": "<tier>"}}` when `thinkingEnabled` on the Bedrock branch (today the branch ignores `reasoningEffort`). Same key reused (`reasoningEffort`), no new data key.
- Tiers exposed: **low / medium / high / xhigh** (user's four). Model gating (probe §2b): Claude 4.6-gen rejects `xhigh` — PropertyPanel disables the xhigh option (with hint) when the selected model id contains `claude-sonnet-4-6` (or is not in the xhigh-capable set {sonnet-5, opus-4-8}); generator defensively clamps `xhigh→high` for non-capable models (covers stale node data). UI: the effort select becomes visible for Bedrock too when thinking is on (replacing today's note-only rendering); note stays ("adaptive thinking — temperature pinned to 1").

### max_tokens default 32000 (probe §3b/3c)
- Change all fallbacks to 32000: generator destructures (7 sites), graph generator, FlowEditor drop default, both PropertyPanel display fallbacks (also fixes the pre-existing 4000-vs-10000 inconsistency).
- **Nova guard**: generator-side clamp table `{nova-pro: 10000, nova-premier: 32000}` applied to the emitted `max_tokens` (id substring match) — prevents ValidationException for old/undefined-maxTokens Nova nodes; PropertyPanel shows a cap hint when a Nova model is selected. Claude/gpt-oss/qwen/deepseek accept 32000 (probed).

## 4. Item 4 — local invoke/chat + AI Fix (port upstream)

### 4.1 Backend layout (new, adapted from upstream per research §6)

```
backend/app/routers/execution.py       POST /api/execute, /api/execute/stream
backend/app/routers/conversations.py   /api/conversations* (8 endpoints incl. PUT .../code)
backend/app/routers/codegen.py         POST /api/fix-code/stream, GET /api/generate-code/status
backend/app/services/local_exec.py     _build_execution_env/_spawn/_kill_pg/_chunk_to_sse/execute_strands_code
backend/app/services/conversation_service.py  (in-memory sessions, --messages replay, failed-turn pairing)
backend/app/codegen/{service,config,validators,workspace_builder}.py + backends/{base,registry,claude_sdk}.py
backend/app/codegen/guidance/{FIX_CLAUDE.md,contract_spec.md,flow_semantics.md,VERSION}
backend/app/utils/sse_formatter.py
```
Skipped: execution history, WebSocket broadcasts, storage artifacts, project CRUD, generate-code path + cache.py (lift `canonicalize_flow` into workspace_builder). Routers registered in `app/main.py` beside existing ones. Route collisions: none (scan clean; `/api/chat/*` = deployed agents, `/api/conversations/*` = local debug).

### 4.2 Execution environment (research §5; decision)
- **Dedicated exec venv**: `scripts/setup_exec_env.sh` creates uv venv at `data/exec-venv` (host py3.12) with `strands-agents[openai]>=1.46,<2`, `strands-agents-tools`, `mcp`, `bedrock-agentcore`. Settings: `studio_exec_python` (default `<repo>/data/exec-venv/bin/python`), `execute_timeout_s` (300), `codegen_model` (global.anthropic.claude-sonnet-4-6), `codegen_timeout_s` (180), `codegen_max_repair_rounds` (2). Bootstrap hook optional; endpoints return a friendly "run scripts/setup_exec_env.sh" 503 when the interpreter is missing.
- BOTH execute and chat spawn with `studio_exec_python` (fixes upstream's sys.executable-vs-uv-run inconsistency). `start_new_session=True` + process-group SIGKILL + timeout as upstream. Env: BYPASS_TOOL_CONSENT, STRANDS_NON_INTERACTIVE, AWS region, optional OPENAI/BEDROCK keys from request.
- **Skills for local runs**: reuse slice-3's `bundle_skills()` (zip_runtime) — before spawn/session-init, regex the code and download referenced APPROVED skills into the workdir's `skills/` (the generated `Path(__file__).parent/"skills"` fallback resolves them; no STUDIO_SKILLS_DIR needed).
- AI-fix backend: `uv add claude-agent-sdk` to the backend env; ClaudeSdkBackend spawns the `claude` CLI (on PATH, verified) with `CLAUDE_CODE_USE_BEDROCK=1` + `ANTHROPIC_MODEL=codegen_model`. `GET /api/generate-code/status` gates the Fix button (sdk import + CLI + creds checks). uvx-fetched strands MCP server needs network at fix time — status/degrade documented.

### 4.3 SSE contracts (ported verbatim)
- execute/stream: `_chunk_to_sse` newline framing (upstream 4a6e3c8 fix), `[STREAM_COMPLETE:<t>]` sentinel, stderr drained concurrently, incremental UTF-8 decode.
- chat stream: `[CHAT_ERROR:<json-one-line>]` + `[CHAT_COMPLETE:<id>]`; failed turns pair-marked and excluded from `--messages` replay; `PUT /api/conversations/{id}/code` rewrites the session's agent.py after an applied fix.
- fix stream: JSON events `progress|agent_activity|validation|done|error|end` via SSEFormatter; done = `{code, changed, diagnosis{category,summary,suggestions[]}, validation_report, duration_ms}`; environment-category guard reverts code edits; ≤2 repair rounds; revert-to-original if validation still fails (never ships broken code).

### 4.4 Frontend (launchpad-styled; upstream behavior, never markup)
- **CodeState lift** into `CreateAgentStudio.tsx`: `{code, source: 'template'|'ai', flowStale}` (manual editing NOT in MVP — CodePanel stays read-only). Canvas-change effect: template → regenerate; ai → `flowStale=true`. "Regenerate from flow" button discards fixes. Publish reads `codeState.code` (a fixed-code publish carries the fix; publish drawer shows a flowStale/AI-fixed note; `studio_flow` still persisted). CodePanel consumes lifted state (+ AI-fixed badge) instead of self-generating.
- **ExecutionDrawer** (new): input box, Run (stream) with live output, stop, error surface, AI Fix button + DiagnosisCard; props `{code, flowData, graphMode, onApplyFixedCode}`.
- **ChatDrawer** (new): local debug chat — session create on open, streamed turns, error bubble on `[CHAT_ERROR]`, AI Fix on failed turn (applies fix + `PUT .../code` so the session continues fixed), clear "LOCAL DEBUG" labeling vs the platform Chat page.
- **`useAiFix` hook** ported (~100 lines); **`frontend/src/studio/lib/debug-client.ts`** (new): executeCodeStream / conversation CRUD+stream / fixCodeStream SSE decoders (upstream framing, research §4).
- i18n: `studio.exec.*`, `studio.chat.*`, `studio.fix.*`, `studio.code.state*` (en/zh-CN parity).

## 5. Backward compatibility

- New data keys additive (`cacheSystem`); effort reuses `reasoningEffort`; old explicit streaming/maxTokens values respected; undefined-streaming nodes flip to streaming (benign, verified in AC); undefined-maxTokens nodes get 32000 (clamped for Nova).
- Old agents (`studio-canvas-e2e`, `studio-skill-e2e`) must restore/regen/re-publish (AC3).
- Local debug is purely additive UI+API; publish pipeline untouched except none.

## 6. Risks

| Risk | Mitigation |
|---|---|
| AI-fix agent unavailable (no sdk/CLI/creds/network) | /status gates the Fix button; graceful 503 messages |
| Local exec runs arbitrary generated code on host | local dev tool by design (same as upstream); timeout + process-group kill + no shell; documented |
| exec venv missing/stale | setup script + 503 hint; strands pinned >=1.46,<2 |
| Fix produces code diverging from flow | flowStale badge + regenerate button + publish-drawer note |
| Claude 4.6 xhigh / Nova 32k runtime errors | UI gating + generator clamps (probe-verified matrices) |
| In-memory chat sessions lost on backend reload (uvicorn --reload in dev) | acceptable for local debug; documented; drawer recreates session on demand |
