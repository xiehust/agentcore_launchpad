# Implementation plan: caching/effort/defaults + local debug + AI fix

Five slices; each ends buildable. Slice 1 is independent of 2-4; slices 2→3→4 build the debug stack bottom-up.

## Checklist

### Slice 1 — Canvas layer: sample + caching triad + effort + defaults
- [ ] `sample-flows/agent-with-mcp.ts`: aws-knowledge data keys (design §1).
- [ ] `code-generator.ts` + `graph-code-generator.ts` extensions (comment-marked `// launchpad extension`): `cacheSystem` → `cache_prompt="default",` in the three Bedrock model-config emitters; Bedrock effort emission `output_config.effort` beside `thinking.adaptive` with xhigh→high clamp for non-capable models (capable = id contains `claude-sonnet-5`|`claude-opus-4-8`); per-model max_tokens clamp `{nova-pro:10000, nova-premier:32000}`; streaming gate `:852` → `?? true`; maxTokens destructure fallbacks 4000→32000 (7 sites + graph :413).
- [ ] `FlowEditor.tsx` agent drop default: `streaming: true`, `maxTokens: 32000`.
- [ ] `PropertyPanel.tsx`: third cache checkbox (cacheSystem, Bedrock, agent+orchestrator); effort select now ALSO for Bedrock when thinking on (low/medium/high/xhigh; xhigh disabled+hint on non-capable models); streaming display `?? true`; maxTokens display fallback 32000 + Nova cap hint.
- [ ] i18n en/zh-CN for new labels/hints.
- [ ] Validate: tsc/lint/build + verify.sh i18n; dev smoke — drop agent, toggle three caches + thinking + effort, generated code shows `cache_prompt`/`output_config.effort`/`max_tokens=32000`/`stream_async`.

### Slice 2 — Backend: exec env + execution + conversations
- [ ] `scripts/setup_exec_env.sh` (uv venv `data/exec-venv`, deps per design §4.2) + settings keys (`studio_exec_python`, `execute_timeout_s`, `codegen_*`) in `app/core/config.py`; run the script on this host.
- [ ] `app/services/local_exec.py` (port: env builder incl. AWS region, spawn with `studio_exec_python`, process-group kill, `_chunk_to_sse`, non-stream helper, friendly missing-interpreter/missing-strands errors) + **skills**: call zip_runtime's `bundle_skills` into the workdir before spawn.
- [ ] `app/routers/execution.py` (`/api/execute`, `/api/execute/stream` with the 4a6e3c8 framing + `[STREAM_COMPLETE]`).
- [ ] `app/services/conversation_service.py` + `app/models/conversation.py` + `app/routers/conversations.py` (8 endpoints; spawn via `studio_exec_python`; failed-turn pairing; `[CHAT_ERROR]`/`[CHAT_COMPLETE]`; PUT .../code; skills bundled at session init).
- [ ] Register routers in `app/main.py`.
- [ ] Tests: chunk framing (multiline/split-UTF8), env builder, replay list construction + failed-turn exclusion, PUT code rewrite, execute endpoint with a stub interpreter (tiny python that echoes), timeout kill.
- [ ] Validate: ruff+pytest; live curl: `/api/execute` with a trivial strands-free script THEN a real generated single-agent flow (exec venv) streams output.

### Slice 3 — Backend: AI-fix codegen package
- [ ] `uv add claude-agent-sdk` (backend env).
- [ ] Port `app/codegen/` fix-half (service fix path, config, validators, workspace_builder w/ canonicalize_flow lifted, backends base/registry/claude_sdk) + guidance assets (FIX_CLAUDE.md, contract_spec.md, flow_semantics.md, VERSION) + `app/utils/sse_formatter.py`; `app/routers/codegen.py` (fix-code/stream + generate-code/status only).
- [ ] Adapt config to pydantic-settings; register router.
- [ ] Tests: validators (contract AST/ruff/import-smoke on a good+bad sample), workspace builder layout, `_read_diagnosis` normalization, environment-category revert guard, service event flow with a FAKE backend (registry injection) — no live Claude in unit tests.
- [ ] Validate: ruff+pytest; live smoke: `GET /api/generate-code/status` reports available on this host.

### Slice 4 — Frontend: CodeState + drawers + client
- [ ] `studio/lib/debug-client.ts`: executeCodeStream / conversations CRUD + sendChatMessageStream / fixCodeStream / status (upstream SSE decoders incl. `[STREAM_COMPLETE]`, `[CHAT_ERROR:<json>]`, event-JSON streams).
- [ ] CodeState lift in `CreateAgentStudio.tsx` (`{code, source:'template'|'ai', flowStale}`; canvas effect; regenerate button; publish reads codeState.code + drawer note when source==='ai'/flowStale); CodePanel consumes lifted state + AI-fixed badge.
- [ ] `studio/useAiFix.ts` hook port; `studio/ExecutionDrawer.tsx` (input/run/stream/stop/error/Fix+DiagnosisCard); `studio/ChatDrawer.tsx` (LOCAL DEBUG labeled; session lifecycle; error bubble; Fix + PUT code); toolbar buttons (Run locally / Local chat) gated by /status where relevant.
- [ ] i18n `studio.exec/chat/fix/code.*` en+zh-CN.
- [ ] Validate: tsc/lint/build + i18n parity; dev smoke via browser.

### Slice 5 — Check + E2E + docs + wrap
- [ ] trellis-check full-scope (data-key audit vs probe doc matrices; deviation/extension ledger discipline; SSE framing fidelity; route registrations; test quality).
- [ ] E2E (agent-browser :5173): (AC1) load agent-with-mcp sample → local run asks an AWS question → streamed answer via aws-knowledge MCP; (AC2) enable 3 caches → code shows all three cache params → local run OK; (AC3) new agent drop = streaming on + 32k; effort xhigh disabled on Sonnet 4.6, enabled on Sonnet 5; old agents regen+re-publish; (AC4) local chat multi-turn; break the code path (e.g. bogus model id) → explicit error; (AC5) AI Fix → diagnosis + repaired code → rerun OK → chat continues fixed → regenerate discards; (AC6) make verify + regression sweep.
- [ ] `docs/studio-integration.md`: new endpoints, exec venv setup, caching triad, effort matrix, defaults, deviation/extension ledger, local-debug-vs-platform-chat naming.
- [ ] prd ACs; commits per slice; memory + archive + journal.

## Validation commands
- `cd frontend && npx tsc --noEmit && npm run lint && npm run build`
- `cd backend && uv run ruff check . && uv run pytest -q`
- `make verify`
- `bash scripts/setup_exec_env.sh && data/exec-venv/bin/python -c "import strands, strands_tools, mcp"`

## Risky files / rollback points
- `frontend/src/studio/lib/code-generator.ts` / `graph-code-generator.ts` — extension blocks (slice 1 commit; grep-verifiable against upstream + ledger).
- `frontend/src/pages/CreateAgentStudio.tsx` — CodeState lift is the one structural change to existing UI (slice 4 commit).
- Backend additions are all net-new modules (slices 2-3 commits; safe wholesale revert). `app/main.py` router registration + config keys additive.

## Before task.py start
- [ ] User approved plan (incl. xhigh model-gating + Nova clamp calls, cache_prompt deprecation trade-off, dedicated exec venv).
- [ ] implement.jsonl / check.jsonl curated.
