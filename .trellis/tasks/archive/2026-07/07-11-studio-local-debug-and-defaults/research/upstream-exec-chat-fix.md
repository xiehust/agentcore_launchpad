# Research: Upstream Studio execute / chat / AI-fix subsystems + local-debug port plan

- **Query**: Port upstream LOCAL invoke/chat + AI-fix into launchpad Studio; document exec/chat/fix subsystems, frontend CodeState surface, local exec env, port plan, route collisions, MCP sample data-key change.
- **Scope**: mixed (upstream `strands_ui` internal + launchpad internal + host env)
- **Date**: 2026-07-11

## Source-of-truth revisions

- Upstream repo `/home/ubuntu/workspace/strands_ui`: working tree is on branch `river_dev @ 456a042` (OLD). All anchors below are read from **`origin/main` tip `4a6e3c8`** (`fix(chat): preserve newlines in multiline streaming stdout chunks`). Read with `git -C /home/ubuntu/workspace/strands_ui show origin/main:<path>`. Do NOT trust the checked-out tree.
- Launchpad repo `/home/ubuntu/workspace/agentcore_launchpad` at `main` (current working tree).
- The multiline-stdout framing fix (`4a6e3c8`) and the `[CHAT_ERROR:<json>]` sentinel are BOTH present at origin/main (verified in code below). Commits `b662aed / 596f4ca / e6c883f` referenced in the task are folded into origin/main.

---

## 1. Execution subsystem (upstream backend)

Everything lives in **`backend/main.py`** (single 1751-line module), NOT in a router. The codegen router only hosts generate/fix (see §3).

### Endpoints

| Endpoint | Location | Purpose |
|---|---|---|
| `POST /api/execute` | `backend/main.py:422` | One-shot execution (JSON result) |
| `POST /api/execute/stream` | `backend/main.py:490` | SSE-ish streaming execution (`text/plain`, chunked) |
| `GET /api/execution/{execution_id}` | `backend/main.py:614` | Fetch cached result by id |
| `POST/GET/DELETE /api/execution-history[...]` | `backend/main.py:627,649,745,771` | Execution history persistence (SKIPPABLE — see §6) |
| `WS /ws` | `backend/main.py:1179` | WebSocket for execution-complete / deployment-progress broadcasts (SKIPPABLE) |

### Request model

`ExecutionRequest` (defined in main.py earlier, referenced at `:423,491`) carries: `code: str`, `input_data: Optional[str]`, `openai_api_key`, `bedrock_api_key`, `project_id`, `version`, `flow_data`. The frontend `ExecutionRequest` type mirrors this (`src/lib/api-client.ts:127`+ area).

### Subprocess model (the important part)

- **`_build_execution_env(openai_api_key, bedrock_api_key)`** `backend/main.py:345` — copies `os.environ`, then sets:
  - `BYPASS_TOOL_CONSENT=true`, `STRANDS_NON_INTERACTIVE=true` (skip Strands tool-consent prompts that would hang a headless run) `:350-351`
  - `STUDIO_SKILLS_DIR` (re-exported explicitly) `:354-355`
  - `OPENAI_API_KEY`, `BEDROCK_API_KEY` when provided `:356-359`
- **`_spawn_execution_subprocess(code, input_data, ...)`** `backend/main.py:394`:
  - `tempfile.mkdtemp(prefix="strands_exec_")`, writes code to `generated_agent.py` `:402-405`
  - **`cmd = [sys.executable, "-u", code_file]`** `:407` — runs with the **backend's OWN python interpreter** (`sys.executable`), NOT `uv run`. Appends `--user-input <input_data>` only if `input_data is not None` `:408-409`
  - `asyncio.create_subprocess_exec(..., cwd=workdir, stdout=PIPE, stderr=PIPE, env=_build_execution_env(...), start_new_session=True)` `:411-418`. `start_new_session=True` makes the child its own process-group leader → clean group-kill.
- **`_kill_process_group(process)`** `backend/main.py:362` — `os.killpg(os.getpgid(pid), SIGKILL)` with fallback to `process.kill()`.
- **Timeout**: `EXECUTE_TIMEOUT_S = float(os.getenv("EXECUTE_TIMEOUT_S", "300"))` `backend/main.py:343` (300s default, env-configurable). On timeout the process group is killed `:574-581`, `:1434-1438`.
- **Working dir**: the temp workspace; **deps for generated code** come from whatever env `sys.executable` lives in (i.e. the backend venv must have `strands-agents` etc. installed). This is the crux for the launchpad port — see §5.

### `/api/execute/stream` SSE framing (the `4a6e3c8` fix)

`generate_stream()` `backend/main.py:497-600`:
- Spawns subprocess `:505`, drains **stderr concurrently** via `drain_stderr()` task `:512-519` (prevents deadlock on a full stderr pipe).
- Uses an **incremental UTF-8 decoder** `codecs.getincrementaldecoder("utf-8")(errors="replace")` `:523` so a `read()` boundary splitting a multi-byte char is handled.
- Reads `process.stdout.read(4096)` with a rolling deadline `:527-531`.
- **`_chunk_to_sse(chunk_str)`** `backend/main.py:374` is the framing fix: splits the chunk on `\n`; each newline becomes its own **empty `data: ` line** and each text segment its own `data: <segment>` line, terminated with `\n\n`. Decoded on the client, the event text is EXACTLY the chunk regardless of where read() boundaries fell. Pre-formatted `data: ` output from the code is forwarded as-is `:543-546`.
- **Completion sentinel**: `data: [STREAM_COMPLETE:<execution_time>]\n\n` `:568,572,581,589`.
- **Error path**: non-zero exit → `_chunk_to_sse(f"Error: {stderr}")` then `[STREAM_COMPLETE:...]` `:562-568`; timeout → `data: Error: Code execution timed out...` `:580`.
- Response headers `:602-612`: `media_type="text/plain"`, `Cache-Control:no-cache`, `X-Accel-Buffering:no`, `Transfer-Encoding:chunked`.

### `/api/execute` (non-streaming) helper

`execute_strands_code(code, input_data, ...)` `backend/main.py:1413`:
- Same `_spawn_execution_subprocess`, then `process.communicate()` with `EXECUTE_TIMEOUT_S` `:1427-1433`.
- Special-case `:1448` — if stderr has `ModuleNotFoundError/ImportError` AND `strands`, returns a friendly "Strands Agent SDK not available…" string instead of raising.
- Returns stdout (or "Code executed successfully (no output)").

### `--user-input` contract

Passed as a CLI flag to the generated program. The generated-code contract (`backend/codegen/guidance/contract_spec.md`) §2 `:26` guarantees an `argparse` entrypoint parsing `--user-input` AND `--messages`, with input priority `--messages > --user-input > default` (§3 `:45`). So execution and chat invoke the SAME program via different flags.

### Execution history persistence — SKIPPABLE for our port

`/api/execution-history` + `save_to_execution_history` `backend/main.py:1327` + `_convert_execution_info_to_history_item` `:1247` + artifact storage `/api/storage/artifacts` `:1461` all persist runs to a `StorageService`. This is a nice-to-have log, coupled to `deployment_service`/`storage_service`. **Skip for the launchpad port** — local debug does not need durable history; the drawer can keep the last run in component state.

---

## 2. Chat / conversation subsystem

### Endpoints (all in `backend/main.py`, `@app` routes)

| Endpoint | Location |
|---|---|
| `POST /api/conversations` (create session) | `:1597` |
| `GET /api/conversations` (list) | `:1609` |
| `GET /api/conversations/{session_id}` (history) | `:1621` |
| `DELETE /api/conversations/{session_id}` | `:1636` |
| `POST /api/conversations/{session_id}/messages` (non-stream) | `:1651` |
| `POST /api/conversations/{session_id}/messages/stream` (SSE) | `:1670` |
| **`PUT /api/conversations/{session_id}/code`** (apply fix in place) | `:1706` |
| `GET /api/conversations/{session_id}/messages` | `:1721` |

### Service: `backend/app/services/conversation_service.py` (415 lines, global singleton at `:416`)

State is **in-memory** on the singleton `ConversationService`:
- `self.sessions: Dict[str, ConversationSession]` `:26`
- `self.messages: Dict[str, List[ChatMessage]]` `:27`
- `self.agent_processes: Dict[str, {session_dir, agent_file, initialized}]` `:28`

Lifecycle:
- **create_session** `:31` — builds `ConversationSession`, then `_initialize_agent` `:49` writes `generated_code` to a temp `agent.py` under `tempfile.mkdtemp(prefix="agent_session_<id>_")`. Each session owns a persistent temp dir.
- **update_session_code** `:70` — the fix-apply path: `agent_info['agent_file'].write_text(generated_code)` rewrites the code IN PLACE; session + messages preserved. Backs `PUT /.../code`.
- **send_message** `:91` (non-stream) / **stream_message** `:226` (SSE).

### Multi-turn replay contract (`--messages` JSON)

- `_construct_messages_list(session_id, ...)` `:197` walks stored messages and emits Bedrock Converse-style `[{"role":"user"|"assistant","content":[{"text": ...}]}, ...]` `:212-216`.
- The **full history** is serialized to JSON and passed as `--messages <json>` — the subprocess replays the whole conversation each turn (`agent.py` is stateless). Non-stream `:173-182`, stream `:316-323`.
- **Subprocess command uses `uv run python`** (NOT `sys.executable`): non-stream `['uv','run','python', str(agent_file), '--messages', messages_json]` `:173-176`; stream `['uv','run','python','-u', str(agent_file), '--messages', messages_json]` `:316-318`. Env sets `PYTHONUNBUFFERED=1`, `BYPASS_TOOL_CONSENT`, `STRANDS_NON_INTERACTIVE`, optional `OPENAI_API_KEY` `:305-313`. **NOTE the inconsistency vs §1** (`/api/execute` uses `sys.executable`; chat uses `uv run python`). `cwd=agent_file.parent` (the session temp dir, which has no pyproject) — for the launchpad port, standardize on ONE interpreter strategy (see §5).
- **60s timeout** on non-stream `:179`; stream reads `stdout.read(1024)` in a loop `:326-333`.

### Failed-turn handling (`b662aed`)

- `_mark_turn_failed(user_msg, agent_msg)` `:84` sets `metadata={"error": True}` on BOTH messages of a failed turn (pair), so `_construct_messages_list` `:209-211` skips them together — keeps user/assistant alternation intact and never replays a broken turn.
- `ChatResponse.success` / `.error` `backend/app/models/conversation.py:35-41` give explicit non-stream success signaling.

### `[CHAT_ERROR:<json>]` single-line SSE sentinel

- `stream_message` `:274-280` yields, on failure: `f"[CHAT_ERROR:{json.dumps(error_text)}]"` then always `f"[CHAT_COMPLETE:{agent_message_id}]"`. JSON-encoding collapses a multiline traceback into ONE line so it survives `data:` framing.
- The stream endpoint `send_chat_message_stream` `:1670` pushes each yielded chunk through `_chunk_to_sse` `:1682` (same framing as §1) and, on endpoint-level failure, emits `data: [CHAT_ERROR:{json.dumps(str(e))}]\n\n` directly `:1687,1690`. Response is `text/plain` with `Content-Type: text/event-stream` header `:1695-1700`.

### What state lives where

- **Backend**: session registry, message history, per-session temp `agent.py`, replay logic. All in-memory (lost on restart).
- **Frontend `src/components/chat-modal.tsx`**: `session`, `messages`, `streamingContent`, `isStreaming`, `lastChatError`, `fixNotice` `:38-46`. Modal creates the session on open `:84-117`, streams turns `:168`, and on AI-fix-applied calls `apiClient.updateConversationCode(session_id, fixedCode)` `:57` to sync the session's code.

---

## 3. AI Fix subsystem

Router: **`backend/app/routers/codegen.py`** (122 lines, prefix `/api`) hosts the whole codegen family:
- `POST /api/generate-code/stream` `:73` (generation — may NOT be ported, see below)
- `POST /api/fix-code/stream` `:89` (**the AI-fix target**)
- `GET /api/generate-code/status` `:108` (backend availability → UI gating; **shared by fix & generate**)
- `DELETE /api/generate-code/cache` `:114`

`FixCodeRequest` `codegen.py:38`: `code, error, flow_data{nodes,edges}, graph_mode, input_data`. Both endpoints wrap a service async-generator in `_sse_response` `:46` using `SSEFormatter.format_json_data(event["data"], event_type=event["event"])` (`backend/app/utils/sse_formatter.py:36`), ending with `format_end_event()` (`event: end`).

### Fix pipeline — `backend/codegen/service.py`

Event vocabulary (all endpoints): `progress | agent_activity | validation | done | error | end`.

`fix_code_events(...)` `service.py:487` → worker with `asyncio.wait_for(_run_fix(...), timeout=get_timeout_s())` `:501` (180s default). **No caching** (errors are one-off). `_run_fix` `service.py:391`:
1. `build_fix_workspace(original_code, error, flow_data, graph_mode, input_data)` `:404`.
2. `GenerationTask(flow_data, graph_mode, mode="fix")` `:420` → `backend.generate(...)` `:426` (the coding agent writes `diagnosis.json` and may edit `generated_agent.py`).
3. `_read_diagnosis(workspace, fallback_summary)` `service.py:348` — loads `diagnosis.json`, normalizes `category ∈ {code, config, environment}` `:38,367-370`, `summary`, `suggestions[]` (`node_label/property/action`). Degrades gracefully if missing.
4. **Classification guard** `:433-439`: if code changed BUT `category == "environment"`, revert the change (never "fix" an env issue like a missing key by editing code).
5. If changed → validation + `_repair_loop` `:442-455` (same agent session, ≤ `get_max_repair_rounds()`=2). If validation still fails → **revert to original code** `:460-465` and append a note to the diagnosis summary. NEVER ships broken code.
6. Emits `done` with `{code, changed, diagnosis, validation_report, duration_ms}` `:472-481`.

### Repair loop + contract validation

- `_repair_loop` `service.py:113` re-queries the SAME backend session with `REPAIR_PROMPT_TEMPLATE` until `report.passed` or rounds exhausted.
- `validate_generated_code` (`backend/codegen/validators.py`) runs staged checks, short-circuit on first failing stage `validators.py:4-7`: **(1) AST contract** (`validate_contract` `:126`: async `main` signature, `__name__=="__main__"` guard `:79`, every `Agent(...)` call `:94` has `callback_handler=None`, `stream_async` presence matches flow streaming `:103`), **(2) ruff**, **(3) import smoke test** in a subprocess with credentials stripped, 20s (`IMPORT_SMOKE_TIMEOUT_S`, `config.py:26`). `ValidationReport.to_dict()` → `{passed, errors:[{stage,message}]}` `:47-57`; `stage ∈ {"ast","ruff","import"}`.

### Pluggable coding-agent backend

- Abstraction: `CodingAgentBackend` (ABC) `backend/codegen/backends/base.py:26` — `check_available() -> (bool, reason)` `:35`, `generate(workspace, task, on_progress)` `:40`, `close()` `:56`. `GenerationTask` dataclass `:10` fields: `flow_data, graph_mode, template_code, previous_code, validation_errors, mode("generate"|"fix")`.
- Registry `backend/codegen/backends/registry.py:13`: `{"claude": ClaudeSdkBackend}` — add-one-module extensibility. `get_backend(name)` `:28`, `UnknownBackendError` `:19`.
- **Claude Agent SDK backend** `backend/codegen/backends/claude_sdk.py`:
  - `name = "claude"` `:88`; holds a `ClaudeSDKClient` alive across repair rounds `:91,159-164`.
  - `check_available()` `:93`: (1) `import claude_agent_sdk` `:96`; (2) **`shutil.which("claude")`** — the Claude Code CLI must be on PATH (SDK spawns it) `:101`; (3) `boto3.Session().get_credentials()` resolvable `:108-115`.
  - **Invocation** `_build_options` `:121`: `ClaudeAgentOptions(cwd=workspace, system_prompt=FIX_SYSTEM_PROMPT|SYSTEM_PROMPT, allowed_tools=["Read","Write","Edit","Grep","Glob"], permission_mode="acceptEdits", max_turns=30 (CODEGEN_MAX_TURNS config.py:23), mcp_servers={"strands":{stdio, command:"uvx", args:["strands-agents-mcp-server"]}}, env={"CLAUDE_CODE_USE_BEDROCK":"1", "ANTHROPIC_MODEL": config.get_model()})` `:124-141`.
  - **Model**: `config.get_model()` = env `CODEGEN_MODEL` else `DEFAULT_CODEGEN_MODEL="global.anthropic.claude-sonnet-4-6"` (`config.py:20,34`). Auth via **Bedrock** (`CLAUDE_CODE_USE_BEDROCK=1`).
  - `generate()` `:143` streams `AssistantMessage` TextBlock/ToolUseBlock → `on_progress` (`[tool] <summary>` for tool uses `:184`); `ResultMessage.is_error` → `GenerationError` `:187`. Asserts `generated_agent.py` exists afterward `:194-198`.
- Config knobs (`backend/codegen/config.py`): `CODEGEN_BACKEND`(default "claude"), `CODEGEN_MODEL`, `CODEGEN_TIMEOUT_S`(180), `CODEGEN_MAX_REPAIR_ROUNDS`(2), guidance `VERSION` file (cache key).

### Fix workspace layout — `backend/codegen/workspace_builder.py`

`build_fix_workspace(code, error, flow_data, graph_mode, input_data)` `:131`:
- Copies FIX guidance: `FIX_CLAUDE.md → CLAUDE.md`, `contract_spec.md`, `flow_semantics.md` (`FIX_GUIDANCE_FILES` `:40`).
- Writes canonical `flow.json` (`canonicalize_flow`, layout stripped) `:148`.
- Writes the failing code to `generated_agent.py` (agent edits in place) `:151`.
- Writes `error.txt` = optional user-input header + **tail-truncated error (last 8KB)** `:155-162` (`ERROR_TAIL_BYTES=8*1024` `:46`; root cause is at the end). NO golden examples (the current code is the strongest context).

### Applying the fix / how chat & execution consume updated code

- Backend never writes the app's code state — it just returns `{code, changed}` in the `done` event.
- **Frontend applies it** via the `useAiFix` hook `onDone` `src/hooks/use-ai-fix.ts:69-76`: `if (result.changed) onApplied(result.code)`. In `main-layout` that runs `handleApplyFixedCode` → `setCodeState({code, source:'ai', flowStale:prev.flowStale})` (§4).
- In the Chat modal, applying the fix ALSO calls `PUT /api/conversations/{session}/code` `chat-modal.tsx:57` so the running session's `agent.py` is rewritten and subsequent turns use the fixed code.

### Generation vs Fix separability (may port ONLY fix)

- They **share** the pluggable backend, `_repair_loop`, `_validate_and_emit`, `_EventEmitter`/`_pump_events`, `SSEFormatter`, and the `runCodegenSseStream` frontend dispatcher. The DIFFERENCE is: generation uses `build_workspace` + golden examples + caching + template-fallback (`generate_code_events` `service.py:263`); fix uses `build_fix_workspace` + `diagnosis.json` + revert-on-doubt + no cache.
- **To port fix only**: keep `codegen/{service.py (fix half), config, cache(optional), validators, workspace_builder(fix half), backends/*}` + guidance `{FIX_CLAUDE.md, contract_spec.md, flow_semantics.md}`. You can drop `generate_code_events`, `build_workspace`, `select_examples`, golden `examples/*.py`, `CLAUDE.md` (generate variant), and the `/generate-code/stream` + cache endpoints. `get_status` (`service.py:41`) is still useful to gate the Fix button. `cache.py` is only needed by generation — fix does no caching, so cache.py can be dropped if generation is dropped (but `canonicalize_flow` from cache.py is imported by workspace_builder `:29` — keep that helper).

---

## 4. Frontend surface + minimal CodeState machine

### Upstream files

| File | Lines | Role |
|---|---|---|
| `src/lib/project-manager.ts` | — | **CodeState type** (`:7-19`) |
| `src/components/main-layout.tsx` | 742 | Owns lifted `codeState`, canvas-change effect, fix/manual/generate handlers |
| `src/components/code-panel.tsx` | 397 | Monaco editor (editable), consumes `codeState`, emits `onManualEdit` |
| `src/components/execution-panel.tsx` | 870 | Run button, streaming output, AI-fix button + diagnosis (via `useAiFix`) |
| `src/components/chat-modal.tsx` | 492 | Multi-turn chat + AI-fix on failed turn |
| `src/hooks/use-ai-fix.ts` | 98 | Shared AI-fix state machine |
| `src/lib/api-client.ts` | 1098 | All HTTP + SSE decoders |

### The CodeState machine (`src/lib/project-manager.ts`)

```
export type CodeSource = 'template' | 'ai' | 'manual';           // :7
export interface ProjectCodeState { code: string; source: CodeSource }  // :10 (persisted)
export interface CodeState extends ProjectCodeState { flowStale: boolean } // :17 (runtime)
```
- `'template'` = live-generated from canvas (refreshes on every canvas change); `'ai'` = backend-generated OR AI-fixed (locked vs canvas); `'manual'` = user-edited (locked). `flowStale` = canvas changed while source is ai/manual (code intentionally NOT overwritten) `:4-6,16`.

### Where it lives & transitions (`main-layout.tsx`)

- Single source of truth: `const [codeState, setCodeState] = useState<CodeState>(...)` `:137`. `codeSourceRef` `:141` reads source inside the canvas effect without retriggering.
- Canvas-change effect `:160-176`: if `source==='template'` → regenerate template `setCodeState({code, source:'template', flowStale:false})` `:166`; else mark `flowStale:true` (don't overwrite) `:172-173`.
- `handleManualCodeEdit(code)` `:180` → `source:'manual'` (unless still pristine template) `:181-187`.
- `handleAiCodeGenerated(code)` `:190` → `setCodeState({code, source:'ai', flowStale:false})` `:192`.
- **`handleApplyFixedCode(code): boolean`** `:199` → `setCodeState(prev => ({code, source:'ai', flowStale:prev.flowStale}))` `:205` (preserves flowStale — the fix is for the same flow). Returns whether applied (false = user declined to overwrite manual edits) — this is the `onApplied` contract of `useAiFix`.
- Persistence: `codeState` (code+source only) saved to auto-save + project `:237,322,346`; `restoreCodeState` `:63` restores ai/manual, falls back to template.

### `useAiFix` hook (`src/hooks/use-ai-fix.ts`) — the minimal state machine

State `:19-23`: `isFixing, fixEvents[], fixError, fixDiagnosis, fixApplied`. `startFix(request: FixCodeRequest)` `:50` guards re-entry `:51`, resets, then `apiClient.fixCodeStream(request, {onProgress, onAgentActivity, onValidation, onDone, onError})` `:58`. `onDone` `:69` sets diagnosis and, if `result.changed`, calls `onApplied(result.code)` and stores `fixApplied`. Returns `{isFixing, fixEvents, fixError, fixDiagnosis, fixApplied, startFix, resetFixState, dismissDiagnosis, reportFixError}` `:87`. Both `execution-panel.tsx:74` and `chat-modal.tsx:50` consume it with an `onApplied` that ultimately calls `onApplyFixedCode` (execution-panel prop `:19,47,867`).

### What the execution panel needs from the page

`ExecutionPanelProps` `execution-panel.tsx:9-19`: **generated `code`**, `flowData{nodes,edges}` `:15`, `graphMode` `:16`, `onApplyFixedCode(code)=>boolean` `:19`. It reads `inputData` from its own state/localStorage `:51`, builds the execute request (`input_data: inputData.trim()||undefined`, `flow_data`, `graph_mode`) `:130-132,381-384`, streams via `apiClient.executeCodeStream(...)` `:403`, and on failure builds a `FixCodeRequest {code, error, flow_data, graph_mode, input_data}` `chat-modal.tsx:243`-style / hook. API keys are extracted from agent nodes `:80,356-358`.

### api-client SSE decoders (exact framing)

- `executeCodeStream(request, onChunk, onComplete, onError)` `api-client.ts:407`: splits buffer on `\n\n` `:446`; within an event concatenates `data: ` values, treating empty `data:`/`data: ` line as `\n` `:457-464`; sentinels `[STREAM_COMPLETE]`/`[STREAM_COMPLETE:<t>]` `:469,476`, `Error: ` prefix stored until completion `:486-488`.
- `postSseStream(path, body, onEvent)` `:511` — shared `event:`/`data:` parser for JSON-event streams. `runCodegenSseStream<TDone>` `:569` dispatches `progress|agent_activity|validation|done|error|end` to callbacks (JSON-parses `data`). `generateCodeStream` `:637`, **`fixCodeStream` `:650`** both use it. Result/callback types: `FixResult{code,changed,diagnosis,validation_report,duration_ms}` `:111`, `FixCodeStreamCallbacks` `:119`, `FixDiagnosis`/`FixSuggestion` `:99-110`.
- Chat stream decode `sendChatMessageStream` `:951`: same framing; sentinels `[CHAT_ERROR:<json>]` `:1000` (regex `/^\[CHAT_ERROR:([\s\S]+)\]$/` `:1003`) and `[CHAT_COMPLETE:<id>]` `:1013`. `updateConversationCode` `:1045` → `PUT /api/conversations/{id}/code`.

### Mapping to launchpad (the gap)

Launchpad **`frontend/src/studio/CodePanel.tsx`** (105 lines, `cat`-read) is **self-contained + read-only**: it takes only `{nodes, edges, graphMode, className}` `:9-14` and regenerates template code in a `useMemo(generateStrandsAgentCode(...))` `:20-26`, Monaco `readOnly:true` `:94`. There is **no CodeState, no source tracking, no manual edit, no lifting**.

**`frontend/src/pages/CreateAgentStudio.tsx`** (570 lines) owns the canvas: `nodes/edges/graphMode` `:51-53`, `codeOpen` drawer toggle `:55`, `readonlyCode` (external-app agents) `:62`, and ALREADY computes `generateStrandsAgentCode(nodes, edges, graphMode)` in a memo `:77-79` whose `fullCode` feeds Publish (`code: fullCode`, `studio_flow:{nodes,edges,graphMode}` → `api.createAgent(spec)` `:299,306`). Renders `<CodePanel nodes edges graphMode />` at `:456`.

**Design implication (document only):** to support AI-fix (and optionally manual edit), lift a CodeState `{code, source:'template'|'ai'|'manual', flowStale}` into `CreateAgentStudio`, drive BOTH the CodePanel/drawer and the Publish summary from it (replacing the two independent `generateStrandsAgentCode` calls), and pass `onApplyFixedCode` down to the new execution/chat drawers. The upstream `main-layout` canvas-effect + handlers (`:160-213`) are the reference behavior to adapt. Manual-edit lock is optional for MVP (launchpad CodePanel is read-only today); the minimum needed for AI-fix is `template` vs `ai(fixed)` with `flowStale`.

---

## 5. Local execution environment on THIS host

### Upstream backend deps (what generated code needs)

`backend/pyproject.toml` (origin/main) `:7-28` requires: `strands-agents[openai]>=1.46.0`, `strands-agents-tools>=0.8.3`, `openai>=2.0.0,<3`, `mcp>=1.23.0`, `bedrock-agentcore`, `claude-agent-sdk>=0.1.0`, fastapi/uvicorn/websockets/boto3, etc. `requirements.txt` mirrors (legacy). The backend and the generated code run in the **same** env (execute uses `sys.executable`).

### Reusable venv already on this host

`/home/ubuntu/workspace/strands_ui/backend/.venv` (Oct 2025) — VERIFIED via its interpreter:
- Python **3.12.3**
- `strands-agents 1.9.0`, `strands-agents-tools 0.2.6`, `openai 1.107.1`, `mcp 1.13.1`, `boto3 1.40.27` — all import OK.
- **`claude-agent-sdk` MISSING** (`ModuleNotFoundError`).
- CAVEAT: this venv is at strands **1.9.0**, but upstream pyproject now targets **>=1.46.0** — the .venv predates the pyproject bump. Generated code targeting newer Strands APIs may need a re-sync/upgrade. It is fine for running the current-contract generated code, but verify against the sample flows before relying on it.

### Launchpad backend env

- `backend/pyproject.toml` `:1-14`: control-plane only — `fastapi, uvicorn, sqlalchemy, pydantic-settings, pyyaml, boto3, bedrock-agentcore==1.17.*, playwright`. **NO strands, NO claude-agent-sdk, NO openai.** `import strands` in `backend/.venv` FAILS.
- Launched via `uv run uvicorn app.main:app --reload --port 8000` (`Makefile:13`, cwd `backend`). Bootstrap `uv run python ../scripts/bootstrap.py` (`Makefile:10`).
- `DATA_DIR = REPO_ROOT/data` (`backend/app/core/config.py:22`), sqlite at `data/launchpad.db` `:47`. Natural home for a dedicated exec venv (`data/`).
- Generated code already emits the skill convention `_skills_dir = os.environ.get("STUDIO_SKILLS_DIR") or Path(__file__).parent/"skills"` (`frontend/src/studio/lib/code-generator.ts:133-134`), but the launchpad backend sets `STUDIO_SKILLS_DIR` **nowhere** (grep empty) — local exec must set it for skill flows (e.g. `skilled-pirate-assistant` sample) to resolve.

### AWS creds / Bedrock (for generated `BedrockModel` calls)

- Static creds at `~/.aws/credentials` (present, 420B) + `~/.aws/config` region **`us-west-2`** (verified). Env also has `AWS_BEARER_TOKEN_BEDROCK`, `BEDROCK_API_KEY`, `BEDROCK_MANTLE_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK=0`. `boto3.Session().get_credentials()` resolves → contract §8 (`contract_spec.md:169-176`) says `BedrockModel` needs NO key arg (ambient creds). So generated Bedrock agents can run locally; ensure `AWS_REGION`/`AWS_DEFAULT_REGION` is propagated (default profile region `us-west-2`).
- For the AI-fix coding agent: **`claude` CLI IS on PATH** (`/home/ubuntu/.local/bin/claude`), **`uv`/`uvx` present** (`/home/ubuntu/.local/bin/`). The claude_sdk backend overrides `CLAUDE_CODE_USE_BEDROCK=1` in its own options env `:138`, so the shell's `=0` doesn't block it.

### Recommended execution-env strategy (for design.md to decide)

Two clean options, both documented:
1. **Dedicated exec interpreter** — create a uv-managed venv with `strands-agents[openai]` + `strands-agents-tools` (+ optional group in `backend/pyproject.toml`, materialized under `data/exec-venv/` or similar). Point the execute subprocess at that interpreter via a configurable env/setting (e.g. `STUDIO_EXEC_PYTHON`), defaulting to it. Keeps the lean control-plane backend env unpolluted.
2. **Reuse `strands_ui/backend/.venv`** for execution (has strands today) via `STUDIO_EXEC_PYTHON=/home/ubuntu/workspace/strands_ui/backend/.venv/bin/python`. Fast to stand up for the demo, but external/undeclared dependency and pinned at strands 1.9.0.

Either way: (a) spawn generated code with the CHOSEN interpreter (mirror upstream `_spawn_execution_subprocess`, but replace `sys.executable` with the configured exec python) — do NOT rely on `uv run` inside a pyproject-less temp dir; (b) install **`claude-agent-sdk`** into the launchpad backend's OWN uv env for the AI-fix coding agent (which runs in-process in the FastAPI worker and shells out to the `claude` CLI); (c) set `STUDIO_SKILLS_DIR` for both exec and chat subprocesses.

---

## 6. Port plan hints

### Backend modules to copy/adapt into `backend/app/`

From `strands_ui/backend/`, adapt (sizes = origin/main line counts):
- **Execution** (extract from `main.py` into a new small router+service, ~250 lines): `_build_execution_env` `:345`, `_kill_process_group` `:362`, `_chunk_to_sse` `:374`, `_spawn_execution_subprocess` `:394` (swap `sys.executable`→configured exec python), `/api/execute` `:422`, `/api/execute/stream` `:490`, `execute_strands_code` `:1413`. SKIP execution-history + WebSocket + storage artifacts.
- **Conversation**: `app/services/conversation_service.py` (415) + `app/models/conversation.py` (53) + the 8 `/api/conversations*` endpoints (extract to a router). Keep in-memory sessions for MVP (local debug). Swap chat subprocess `uv run python`→configured exec python for consistency with execute.
- **AI-fix codegen**: `app/routers/codegen.py` (122, keep only fix + status; optionally drop generate + cache endpoints) + `codegen/service.py` (522, fix half — `fix_code_events`, `_run_fix`, `_read_diagnosis`, shared helpers) + `codegen/config.py` (61) + `codegen/validators.py` (384) + `codegen/workspace_builder.py` (169, keep `build_fix_workspace`, `canonicalize_flow` import, `cleanup_workspace`) + `codegen/backends/{base.py 58, registry.py 42, claude_sdk.py 207}` + `codegen/cache.py` ONLY if keeping generation (else lift `canonicalize_flow` into workspace_builder).
- **Guidance assets** (fix subset): `codegen/guidance/{FIX_CLAUDE.md, contract_spec.md, flow_semantics.md, VERSION}`. Drop `CLAUDE.md`(generate), `examples/*`.
- **Utils**: `app/utils/sse_formatter.py` (105) — or reuse a launchpad equivalent.

### FastAPI wiring differences

- Launchpad registers routers explicitly in `backend/app/main.py:57-67` (no upstream try/except optional-import guards). Add `app.include_router(execution_router)`, `app.include_router(conversation_router)` (local-debug), `app.include_router(codegen_router)` there. Set `STUDIO_SKILLS_DIR` at startup (upstream does it in the skills-router block `main.py:163-173`). Launchpad uses `pydantic-settings` config (`app/core/config.py`) — surface `EXECUTE_TIMEOUT_S`, `CODEGEN_*`, `STUDIO_EXEC_PYTHON`, `STUDIO_SKILLS_DIR` there.
- Launchpad main.py imports: mirror pattern of existing routers (`from app.routers.<x> import router as <x>_router`).

### What to skip

Execution history, deployment-history, storage/artifacts, WebSocket broadcasts, project CRUD, and the whole `generate-code` path (unless generation is also wanted). Local chat is EPHEMERAL — no durable persistence needed.

### Frontend components to build (launchpad-styled)

- **Execution drawer** — adapt `execution-panel.tsx`: input box + Run (stream) + live output + AI-fix button + diagnosis card. Wire `useAiFix` (port `src/hooks/use-ai-fix.ts` — small, mostly reusable) with `onApplied → handleApplyFixedCode`.
- **Chat drawer** — adapt `chat-modal.tsx`: session create-on-open, streaming turns, `[CHAT_ERROR]`/`[CHAT_COMPLETE]` handling, AI-fix-on-failed-turn + `updateConversationCode`.
- **Diagnosis card** — renders `FixDiagnosis {category, summary, suggestions[]}`.
- Port the api-client methods: `executeCodeStream`, `postSseStream`+`runCodegenSseStream`, `fixCodeStream`, `createConversationSession`/`sendChatMessageStream`/`updateConversationCode` (launchpad has its own api client — add these).
- **CodeState lift** into `CreateAgentStudio.tsx` (§4) — the one structural change to existing launchpad code.
- **i18n scope**: launchpad Studio already uses `react-i18next` (`CodePanel.tsx:2`, keys `studio.code.*`). Add `studio.exec.*`, `studio.chat.*`, `studio.fix.*` keys.

### Local debug chat vs the platform Chat page — NO collision

- Launchpad's existing chat is `backend/app/routers/chat.py` prefix `/api` → `POST /api/chat/{agent_id}`, `GET /api/chat/{agent_id}/sessions|history|memory` `:66,109,148,173`. It invokes **deployed AgentCore runtimes** (`app/services/chat.py`, `invoke.py`).
- The ported local-debug chat is `/api/conversations*` — **completely separate namespace**, runs UN-deployed generated code in a local subprocess. **Route-collision scan CONFIRMED CLEAN**: grep across `backend/app/` for `/execute`, `/conversations`, `/generate-code`, `/fix-code` returns EMPTY — none of these paths exist in launchpad today. Naming is unambiguous (`/api/chat/*` = deployed; `/api/conversations/*` = local debug). Recommend UI labels make the distinction explicit ("Local debug chat" vs the Agent "Chat" page).

---

## 7. Task item-1: `agent-with-mcp.ts` → aws-knowledge MCP

Sample: `frontend/src/studio/lib/sample-flows/agent-with-mcp.ts` (80 lines, `cat`-read). Target: point at **aws-knowledge MCP** `https://knowledge-mcp.global.api.aws`, streamable_http, **no auth**.

**Upstream check**: the upstream sample `src/lib/sample-flows/agent-with-mcp.ts@origin/main` is **byte-identical** to launchpad's (same `serverName:'docs_server'`, `transportType:'streamable_http'`, `url:'http://localhost:8811/mcp'`). **origin/main did NOT change this sample** — no upstream change to inherit.

**Data keys to change** (the `mcp-tool` node `data` at `agent-with-mcp.ts:39-46`, plus the flow description `:7`):

| Key | Current | Change to |
|---|---|---|
| `data.url` `:43` | `http://localhost:8811/mcp` | `https://knowledge-mcp.global.api.aws` |
| `data.serverName` `:41` | `docs_server` | e.g. `aws_knowledge` (becomes the python client var: codegen lowercases + slugifies `serverName` → `<slug>_client_<id4>`, see `code-generator.ts:419,642-643`) |
| `data.label` `:40` | `Docs MCP Server` | e.g. `AWS Knowledge MCP` (cosmetic) |
| `data.description` `:45` | `Documentation search MCP server` | e.g. `AWS Knowledge MCP (public, no auth)` (cosmetic) |
| flow `description` `:7` | mentions `http://localhost:8811/mcp` default | update to the aws-knowledge URL |
| `data.transportType` `:42` | `streamable_http` | **unchanged** (correct transport) |
| `data.timeout` `:44` | `30` | keep (bump if remote latency warrants) |
| agent `systemPrompt` `:29` | "documentation assistant… search and fetch documentation" | fine as-is; optionally mention AWS docs |

**No auth needed**: the codegen for `streamable_http` emits `MCPClient(lambda: streamablehttp_client("<url>"), ...)` with NO headers/auth arg (`frontend/src/studio/lib/code-generator.ts:439-441`). aws-knowledge MCP is public/no-auth, so just changing `url` produces a working client. (If auth were ever needed, the generator would have to be extended — it currently supports none.)

---

## Caveats / Not found

- The reusable venv (`strands_ui/backend/.venv`) is **strands 1.9.0**, older than upstream pyproject's `>=1.46.0` target — validate generated sample flows against it or upgrade before relying on it for execution.
- `claude-agent-sdk` is NOT installed anywhere on this host's python envs — must be `uv add`-ed to the launchpad backend env for AI-fix.
- Conversation sessions are in-memory only (lost on backend restart) — acceptable for local debug; flagged in case durability is later wanted.
- `strands-agents-mcp-server` (used as the fix agent's MCP tool, `claude_sdk.py:133`) is fetched via `uvx` at fix time — network access required during AI-fix; not verified reachable in this sandbox.
- I did not exhaustively read `flow_semantics.md` / `FIX_CLAUDE.md` bodies (guidance prose) — they are copy-as-is assets for the port; their existence and role are confirmed via `workspace_builder.py` and `claude_sdk.py`.
