# Research: Strands Studio canvas PR #31 delta (456a042 → origin/main)

- **Query**: What FEATURE deltas did upstream PR #31 add to the Strands Studio canvas surface (codegen libs, models catalog, skill node, prompt caching / reasoning / Mantle, sample gallery, connection rules, bug fixes), and exactly how do we sync them into the launchpad port at `frontend/src/studio/` + `backend/app/deployer/` without breaking saved `studio_flow` graphs?
- **Scope**: mixed (upstream clone `/home/ubuntu/workspace/strands_ui` @ `origin/main` = merge `69318ab` of PR #31; launchpad `/home/ubuntu/workspace/agentcore_launchpad`)
- **Date**: 2026-07-11

> **Anchors**: upstream refs cited as `origin/main:<path>:<line>` (view with `git show origin/main:<path>`); launchpad refs are repo-relative absolute paths. Port base `456a042` ("fix system prompt setting", 2025-10-16) is a true ancestor of `origin/main` (verified `git merge-base --is-ancestor`). The archived port contract is `/home/ubuntu/workspace/agentcore_launchpad/.trellis/tasks/archive/2026-07/07-11-strands-studio-canvas/research/strands-studio-architecture.md`.

---

## TL;DR / critical facts

1. **The four pure libs re-sync cleanly.** `connection-validator.ts` (+23/-5), `code-generator.ts` (+210/-66), `graph-code-generator.ts` (+101/-12) changed; `graph-validator.ts` is **byte-identical** (unchanged). One **new** pure lib `src/lib/models.ts` holds the shared model catalog + helpers.
2. **Upstream's origin/main markup is ALREADY launchpad-styled** (commit `815613e` restyled the fork). Skill node uses `lp-node` classes, there's a `monaco-theme.ts`, etc. **We still can't copy the `.tsx` markup** — launchpad uses hand-written `frontend/src/studio/studio.css` classes, not the fork's Tailwind-`lp-*` classes. Port FEATURE deltas (data keys, generated code, catalog) only.
3. **`AgentSkills`, `CacheConfig`, `OpenAIResponsesModel` all exist in strands-agents 1.47.0** (verified by unpacking the wheel). Launchpad's zip pin `strands-agents[otel]>=1.0,<2` resolves to 1.47.0, so all three imports work.
4. **REQUIREMENTS GAP (must fix):** `strands/models/openai_responses.py:32` and `strands/models/openai.py:14` do an **unconditional top-level `import openai`**. The `openai` package ships only via the `[openai]`/`[all]` extra — **not `[otel]`**. `CreateAgentStudio.tsx:77-83` already adds `strands-agents[openai]` for the `"OpenAI"` provider but **NOT** for the new Mantle provider. Any Mantle (or OpenAI) flow will `ImportError` at runtime unless the extra is present.
5. **SKILL BUNDLING GAP (must build):** generated skill code resolves `Path(__file__).parent / "skills"`, but launchpad's `build_zip()` (`backend/app/deployer/zip_runtime.py:43`) bundles only `main.py` + `requirements.txt` — **no `skills/` directory**. Launchpad skills live in S3 (`s3://{bucket}/skills/{name}/SKILL.md`), reached via `registry_console.attachable_records()`, not upstream's `backend/storage/skills/`. We must download the referenced S3 skill bundles into the zip's `skills/{name}/` at package time.
6. **Backward-compat call-outs (saved `studio_flow` graphs):** `thinkingBudgetTokens` is no longer read (adaptive thinking); `reasoningEffort:'minimal'` is coerced to `'low'`; the default model id changed but is only a fallback. The one **behavior change**: `mem0_memory` was dropped from the strands_tools import + tool map upstream — a verbatim re-copy would silently turn `mem0_memory` tool nodes into `calculator`. Launchpad also carries a **`file_write` deviation** (added to import + map) that a verbatim re-copy would drop.

---

## §1. Pure-lib deltas (`src/lib/`)

### 1a. `graph-validator.ts` — UNCHANGED
`git diff --stat 456a042 origin/main -- src/lib/graph-validator.ts` = empty. Launchpad's `frontend/src/studio/lib/graph-validator.ts` needs no change.

### 1b. NEW `src/lib/models.ts` (137 lines) — the shared catalog

Exported API the property panel imports (`origin/main:src/components/property-panel.tsx:4`):

| Export | Value / signature | Notes |
|---|---|---|
| `DEFAULT_MODEL_ID` | `'global.anthropic.claude-sonnet-4-6'` | **matches launchpad `AgentSpec.DEFAULT_MODEL_ID`** (`backend/app/schemas/agent.py:9`) |
| `CUSTOM_MODEL_OPTION` | `'__custom__'` | sentinel `<option>` value |
| `CUSTOM_MODEL_NAME` | `'Custom model'` | stored in `modelName` to flag custom-id mode |
| `BedrockModelOption` | `{ model_id, model_name }` | |
| `BEDROCK_MODELS` | 15-entry array | Claude Sonnet 5 (global/US), Sonnet 4.6 (global/US/EU), Opus 4.8 (global/US/EU), GPT-OSS-120B, Qwen3 235B/32B/Coder-480B, DeepSeek-V3.1, Nova Premier/Pro |
| `MANTLE_PROVIDER` | `'Amazon Bedrock (Mantle)'` | provider string used everywhere |
| `DEFAULT_MANTLE_REGION` | `'us-east-1'` | |
| `mantleBaseUrl(region)` | → `https://bedrock-mantle.{region}.api.aws/openai/v1` | region-templated (fixed by `918bfc4`) |
| `MANTLE_MODELS` | `xai.grok-4.3`, `openai.gpt-5.5`, `openai.gpt-5.4` | reachable only via Mantle |
| `DEFAULT_MANTLE_MODEL_ID` | `MANTLE_MODELS[0].model_id` = `xai.grok-4.3` | |
| `isCustomModel(modelId, modelName?)` | true if `modelName===CUSTOM_MODEL_NAME` OR id not in `BEDROCK_MODELS` | drives the custom-id input |
| `isCustomMantleModel(...)` | same, against `MANTLE_MODELS` | |

Import path is aliased `@/lib/models`; **launchpad must use a relative path** (e.g. `../lib/models`) — launchpad has no `@` alias for the studio subtree.

### 1c. `connection-validator.ts` (+23/-5) — skill edge rules only

Three additive changes (`origin/main:src/lib/connection-validator.ts`):
- New rule (`~:49`): `skill.skill-output → agent.tools` ("Skills can be attached to agents").
- New rule (`~:105`): `skill.skill-output → orchestrator-agent.tools`.
- Swarm guard (`~:416`) extended: `skill` added to the list of source types that **cannot** connect to a `swarm` node; message becomes "Tools and skills cannot connect to swarm nodes."

No other logic touched. Backward compatible (purely additive rules).

### 1d. `code-generator.ts` (+210/-66) — full functional inventory

**Imports (`generateStrandsAgentCode`, `origin/main:src/lib/code-generator.ts:30-31`):**
- `from strands.models import BedrockModel` → `from strands.models import BedrockModel, CacheConfig`
- strands_tools line **drops `mem0_memory`**: now `calculator, file_read, shell, current_time, http_request, editor, retrieve`
- New conditional import when any agent uses Mantle (`:70-74`): `from strands.models.openai_responses import OpenAIResponsesModel`
- New conditional block when any agent has a connected skill (`:123-133`):
  ```
  from pathlib import Path
  from strands import AgentSkills
  ```
  plus module-level code:
  ```python
  # Studio-managed skills directory (env override locally; packaged skills/ next to this file when deployed)
  _skills_dir = os.environ.get("STUDIO_SKILLS_DIR") or str(Path(__file__).parent / "skills")
  ```

**New helpers (`:487-527`):**
- `findConnectedSkills(agentNode, allNodes, edges)`: edges where `target===agent.id && targetHandle==='tools'`, source `type==='skill'`, collects unique `data.skillName`.
- `buildSkillsPluginArg(skillNames, indent)`: returns `,\n{indent}plugins=[AgentSkills(skills=[os.path.join(_skills_dir, "<name>"), ...])]` (empty string when no skills).

**Skills threaded into every agent constructor** (appended after `callback_handler=None`): `generateAgentCode` (`:325`), `generateSwarmAgentCode` (`:378`), `generateAgentAsToolCode` (both MCP and non-MCP branches, `:1094/:1122`), `generateOrchestratorAsToolCode` (`:1206/:1242`), `generateOrchestratorCode` non-MCP branch (`:1389`), and the in-`main()` execution-agent construction (both orchestrator and regular, `:740/:760`).

**Model-config signature change** — `thinkingBudgetTokens` param **removed** from `generateModelConfigForCode`, `generateModelConfigForTool`, and every caller; two new trailing params `cacheMessages?, cacheTools?` added everywhere. Data destructuring in every agent generator drops `thinkingBudgetTokens = 2048` and adds `cacheMessages = false, cacheTools = false`.

**`generateModelConfigForCode` (`:1417`) new behavior:**
- `if (reasoningEffort === 'minimal') reasoningEffort = 'low'` (legacy coercion).
- **Mantle branch** (`modelProvider === MANTLE_PROVIDER`): emits `OpenAIResponsesModel` with `client_args={"api_key": os.environ.get("BEDROCK_API_KEY"), "base_url": "<baseUrl>"}`, `model_id`, `params={"max_output_tokens": N, ...}`; when `thinkingEnabled && reasoningEffort` → `"reasoning": {"effort": "<effort>"}` and temperature omitted, else `"temperature": <temp>`.
- **OpenAI branch** unchanged except signature.
- **Bedrock branch**: thinking now emits `additional_request_fields={"thinking": {"type": "adaptive"}}` (was `{"type":"enabled","budget_tokens":N}`); condition is now just `if (thinkingEnabled)` (no budget). New caching suffixes: `if (cacheMessages)` → `,\n    cache_config=CacheConfig(strategy="auto")`; `if (cacheTools)` → `,\n    cache_tools="default"`. `finalTemperature` is still pinned to 1 when Bedrock+thinking.

`generateModelConfigForTool` is the same logic at deeper indentation.

**Orchestrator-no-MCP construction fix (`aedebba`, `:200-214`):** old code generated model-only for *any* execution orchestrator; now it only does model-only when `isExecutionOrchestrator && orchestratorHasMCP` (`findConnectedMCPTools(...).length > 0`). Otherwise the orchestrator `Agent` is constructed at module level — fixing a `NameError` on the coordinator variable when an execution orchestrator had **no** MCP tools. **This is a real bug fix launchpad's copy lacks.**

**`file_write` / `mem0_memory` in the tool map (`origin/main:src/lib/code-generator.ts:476-486`):** upstream map = `calculator, file_read, file_reader→file_read, shell, current_time, http_request, editor, retrieve`; **no `file_write`, no `mem0_memory`**. `file_write` still exists as a property-panel `<option value="file_write">` (`:931`) but falls back to `calculator`. So the upstream `file_write` deviation is **NOT** obsolete — it's the same silent-fallback as before, just with `mem0_memory` additionally removed.

### 1e. `graph-code-generator.ts` (+101/-12) — mirror of 1d for Graph Mode

- imports `DEFAULT_MODEL_ID, MANTLE_PROVIDER` from `./models`; base import → `BedrockModel, CacheConfig` (`:314`); conditional Mantle (`:355`) and skills (`:374-384`) imports + the same `_skills_dir` line.
- adds `findConnectedSkills` / `buildSkillsPluginArg` (`:187-224`).
- `generateModelConfig` gets the identical Mantle/adaptive-thinking/caching treatment and the `minimal→low` coercion; `thinkingBudgetTokens` removed, `cacheMessages/cacheTools` added.
- per-agent loop (`:404-437`): `modelId` fallback → `DEFAULT_MODEL_ID`; drops `thinkingBudgetTokens`; adds `cacheMessages/cacheTools`; appends `${skillsCode}` after `callback_handler=None`.
- Graph mode's trimmed strands_tools import (`calculator, file_read, shell, current_time`) is unchanged.

---

## §2. Skill node contract

**`skill-node.tsx` data schema** (`origin/main:src/components/nodes/skill-node.tsx`):
```ts
interface SkillNodeData { label?: string; skillName?: string; description?: string; }
```
**Single handle:** `type="source" position=Right id="skill-output"`. No target handle.

**Palette entry** (`origin/main:src/components/node-palette.tsx:66-72`): `{ type:'skill', label:'Skill Node', icon:Sparkles, description:'Attach a skill from the Studio skill library to agents', category:'Core' }`. Registered in `flow-editor.tsx` `nodeTypes` as `skill: SkillNode` (`:47`) and exported from `nodes/index.tsx` (`export { SkillNode }`). Drop default (`flow-editor.tsx:211-217`): `{ label:'Skill', skillName:'', description:'' }`.

**Connection rules:** see §1c — `skill-output → {agent|orchestrator-agent}.tools`; blocked into swarm.

**Property-panel skill section** (`origin/main:src/components/property-panel.tsx:339-420`): a `<select>` bound to `data.skillName`, options from `apiClient.listSkills()` (upstream `/api/skills`), each `<option value={skill.name}>{name — description}</option>`; `handleSelect(name)` writes `{ skillName: name, description: <picked skill's description> }`. Shows a "missing from library" option + warning when `data.skillName` isn't in the fetched list. A refresh button re-calls `listSkills`, and a "Manage skills" button opens `ManageSkillsModal` (import/delete UI). **The picker needs exactly `{ name, description }` per skill** (the SkillInfo shape, §3).

**Codegen consumption:** `findConnectedSkills` reads `skillNode.data.skillName`; `buildSkillsPluginArg` emits `os.path.join(_skills_dir, "<skillName>")`. So **`skillName` must equal the on-disk/in-S3 skill directory name.**

**EXACT generated Python — agent with one skill** (`pirate-speak`, Bedrock Sonnet 4.6, `cacheMessages`+`cacheTools`, no MCP; from the `skilled-pirate-assistant` sample):

Added imports:
```python
from pathlib import Path
from strands import AgentSkills
from strands.models import BedrockModel, CacheConfig
```
Module-level (emitted once):
```python
# Studio-managed skills directory (env override locally; packaged skills/ next to this file when deployed)
_skills_dir = os.environ.get("STUDIO_SKILLS_DIR") or str(Path(__file__).parent / "skills")
```
Agent block:
```python
# Pirate Assistant Configuration
pirate_assistant_model = BedrockModel(
    model_id="global.anthropic.claude-sonnet-4-6",
    temperature=0.7,
    max_tokens=4000,
    cache_config=CacheConfig(strategy="auto"),
    cache_tools="default"
)

pirate_assistant = Agent(
    model=pirate_assistant_model,
    system_prompt="""...""",
    callback_handler=None,
    plugins=[AgentSkills(skills=[os.path.join(_skills_dir, "pirate-speak")])]
)
```
(Multiple skills on one agent → comma-joined paths inside the single `AgentSkills(skills=[...])`.)

---

## §3. Skill runtime / deploy convention

### 3a. Upstream backend (`origin/main:backend/app/services/skill_service.py`)
- Skills imported **once** into `backend/storage/skills/{name}/` (`SKILLS_ROOT`, `:52`). Each skill dir has **`SKILL.md`** (required) + any extra files + a `.studio-meta.json` sidecar (source_type/origin/imported_at). `Skill` parsing via `from strands.vended_plugins.skills.skill import Skill`.
- Directory name **==** SKILL.md frontmatter `name` (regex `^[a-z0-9][a-z0-9-]{0,63}$`, also a path-traversal guard).
- Four import sources (`SkillImportRequest.source_type`): `inline` (name/description/instructions → generated SKILL.md), `https` (raw SKILL.md URL), `git` (public GitHub `repo`/`ref`/`path` via codeload zip), `s3` (`s3://bucket/prefix` full-dir download). 50 MB/skill cap.
- Router `origin/main:backend/app/routers/skills.py`: `GET /api/skills` (→ `{skills:[...]}`), `POST /api/skills/import` (409 if name exists), `DELETE /api/skills/{name}`.
- **SkillInfo** (`origin/main:src/lib/api-client.ts:270`): `{ name, description, source_type?, imported_at? }`.

**Two runtime consumption paths (`skill_service.py` docstring):**
1. **Local exec / chat:** `backend/main.py:170-171` sets `os.environ.setdefault("STUDIO_SKILLS_DIR", str(SKILLS_ROOT.resolve()))`, and subprocess env forwards it (`:354-355`). Generated code's `os.environ.get("STUDIO_SKILLS_DIR")` picks it up.
2. **AgentCore deploy:** `origin/main:backend/deployment/agentcore/package_builder.py` copies each referenced skill dir into the zip as **`skills/{name}/`** at the zip root, next to the entrypoint (`build_package(..., skill_names, skills_root=DEFAULT_SKILLS_ROOT)`, `:62-118`). Missing skills are logged+skipped, never block deploy. The **referenced skill names are extracted from generated code by regex** `os\.path\.join\(\s*_skills_dir\s*,\s*"([a-z0-9-]+)"\s*\)` (`agentcore_deployment_service.py:334`). At runtime the generated code's `Path(__file__).parent / "skills"` fallback resolves them (STUDIO_SKILLS_DIR unset in the runtime).

So the **runtime layout the generated code requires**: `skills/<skillName>/SKILL.md` (+ any bundled files) sitting beside `main.py`. `AgentSkills` receives **directory paths**, loads SKILL.md lazily at agent init.

### 3b. Launchpad side (today)
- `AgentSpec.skills: list[str]` (`backend/app/schemas/agent.py:38`) is **harness-only**: `harness.py:83` does `params["skills"] = [{"path": path} for path in spec.skills]` — passes S3 paths to AgentCore's **native** `skills` runtime param. The zip/studio path never reads `spec.skills`.
- `build_zip()` (`backend/app/deployer/zip_runtime.py:43-83`) writes only `main.py` + `requirements.txt` into `pkg_dir`, then zips. **No `skills/` bundling anywhere** (grep of `app/deployer/` + `app/templates/studio_agent/` for skills/`_skills_dir`/`AgentSkills` = 0 hits).
- `adapt_studio_code()` (`backend/app/templates/studio_agent/__init__.py`) keeps the studio module **verbatim** (drops the argparse `__main__` block, appends a `BedrockAgentCoreApp` entrypoint + config-bundle shim). So the generated `_skills_dir = ... Path(__file__).parent / "skills"` line + `AgentSkills(...)` **survive into the deployed `main.py`** unmodified — good, but the `skills/` dir they point at won't exist unless we bundle it.
- Launchpad skill catalog = **AGENT_SKILLS registry records** (not `backend/storage/skills/`). `registry_console.attachable_records()` (`backend/app/services/registry_console.py:193-243`) returns `{ mcp_servers, skills }` where each skill = `{ name, description, path, record_id }` and `path = s3://{bucket}/skills/{name}/` (record name == S3 prefix segment; see `register_skill` `:287/:295` → `Key=f"skills/{name}/SKILL.md"`, `path=f"s3://{bucket}/skills/{name}/"`). Only **APPROVED** records are returned. Frontend fetches `GET /api/registry/attachables` (`backend/app/routers/registry.py:98-109`, 60 s cache), returning `.skills[]`.

### 3c. Mapping to spec (launchpad skill records → canvas → zip)
1. **Picker source:** point the studio skill picker at `GET /api/registry/attachables` → `.skills[]` (`{name, description, path}`). `name` → node `data.skillName`; `description` → node `data.description`. (Do **not** reuse upstream's `/api/skills` + `ManageSkillsModal`; launchpad has no `backend/storage/skills/` and imports go through the registry `register_skill` flow instead.)
2. **Referenced-skill extraction at publish/package:** either (a) extract from `studio_flow` skill nodes (`data.skillName` where node.type==='skill' and it's connected to an agent's `tools` handle) or (b) regex the generated code exactly like upstream (`os.path.join(_skills_dir, "<name>")`). (a) is cleaner since launchpad already persists `studio_flow`.
3. **Zip bundling:** for each referenced `name`, resolve the APPROVED AGENT_SKILLS record's `path` (`s3://{bucket}/skills/{name}/`), download every object under that prefix into `pkg_dir/skills/{name}/` before zipping (mirror upstream `package_builder`: warn+skip on missing, never block). The record name == prefix segment == `skillName`, so `skills/{skillName}/SKILL.md` lands exactly where `AgentSkills(skills=[os.path.join(_skills_dir, "<skillName>")])` expects it.

---

## §4. `AgentSkills` SDK availability

- **Upstream requires** `strands-agents[openai]>=1.46.0` (`origin/main:backend/pyproject.toml` / `backend/requirements.txt`) — the version the `AgentSkills` feature landed in (SDK-upgrade commit `531e3ac`). Backend imports `from strands.vended_plugins.skills.skill import Skill`; generated code imports `from strands import AgentSkills`.
- **Launchpad zip resolves** `strands-agents[otel]>=1.0,<2` (`backend/app/templates/strands_agent/requirements.txt`) → latest 1.x = **1.47.0** (PyPI `pip index versions strands-agents`: 1.47.0 newest, 1.46.0 present).
- **Verified in the 1.47.0 wheel** (downloaded + unzipped):
  - `strands/__init__.py:17` `from .vended_plugins.skills import AgentSkills, Skill`; `:22` exports `"AgentSkills"`. → `from strands import AgentSkills` ✅
  - `strands/models/__init__.py:10` `from .model import ... CacheConfig, CacheToolsConfig ...`; `:17` exports `"CacheConfig"`. → `from strands.models import CacheConfig` ✅
  - `strands/models/openai_responses.py` exists → `from strands.models.openai_responses import OpenAIResponsesModel` ✅
- **The `[otel]`-vs-`[openai]` catch:** `strands/models/openai_responses.py:32` and `strands/models/openai.py:14` both do unconditional top-level `import openai`. Wheel METADATA: `openai<3.0.0,>=1.68.0` is pulled by extras `openai` / `all` / `litellm` / `sagemaker` — **not `otel`**. The `openai` extra also pulls `aws-bedrock-token-generator` (used for Bedrock API-key auth, relevant to Mantle). **AgentSkills, CacheConfig, and adaptive thinking need NO extra** (they're base / pure-Bedrock). Only **Mantle and OpenAI** flows need `strands-agents[openai]` added to the zip requirements.

---

## §5. Property-panel feature deltas (functional only)

Launchpad `frontend/src/studio/PropertyPanel.tsx` is at 456a042 feature level: hardcoded `bedrockModels` array (`:107`, Claude 4.5 Haiku/Sonnet/4/3.7 catalog), providers **AWS Bedrock / OpenAI only** (`:191`), a `thinkingBudgetTokens` number input (`:317`), plain `reasoningEffort` select default `medium` (`:330`), and **no** caching / skill / Mantle / custom-model UI. Upstream origin/main adds (all keyed off `data.modelProvider` being Bedrock/undefined vs Mantle vs OpenAI):

**Provider dropdown** (`origin/main:src/components/property-panel.tsx:627-634`, orchestrator mirror `:1196-1203`): `AWS Bedrock`, `{MANTLE_PROVIDER}` = `Amazon Bedrock (Mantle)`, `OpenAI`.

**Model catalog:** now `BEDROCK_MODELS` from `models.ts` (§1b). Bedrock select value uses `isCustomModel(data.modelId, data.modelName) ? CUSTOM_MODEL_OPTION : (data.modelId || bedrockModels[0].model_id)` (`:648`); selecting "Custom model ID…" writes `{ modelId:'', modelName:CUSTOM_MODEL_NAME }` and reveals a free-text `modelId` input (`:677-690`).

**Mantle fields** (`renderMantleFields`, `:525-600`): a **`region`** text input (default `us-east-1`) whose onChange writes `{ region, baseUrl: mantleBaseUrl(region) }`; a model `<select>` over `MANTLE_MODELS` + custom option; a **`apiKey`** password field (stored → `BEDROCK_API_KEY` env). Switching to Mantle (`:502-511`) seeds `{ modelProvider, region, baseUrl: mantleBaseUrl(region), modelId: DEFAULT_MANTLE_MODEL_ID, modelName: DEFAULT_MANTLE_MODEL_ID }`.

**Reasoning effort** (`:832-857`): shown only when `thinkingEnabled` AND provider is **not** Bedrock. Bedrock+thinking instead shows an "Adaptive thinking — temperature pinned to 1" note (**the `thinkingBudgetTokens` input is gone**). Effort scale options: **`low / medium / high / xhigh / max`** (labels Low/Medium/High/Extra High/Max). Select value coerces `'minimal' → 'low'`. So reasoning-effort applies to **OpenAI + Mantle** providers; Bedrock uses adaptive thinking with no effort knob.

**Prompt caching** (`:860-882`): shown only for Bedrock/undefined. Two checkboxes → `data.cacheMessages` ("Cache conversation (auto)") and `data.cacheTools` ("Cache tools").

**Claude adaptive thinking (`9229844`):** the `thinkingEnabled` checkbox stays; when on for Bedrock, temperature slider is disabled and pinned to 1 (`:757-774`), and codegen emits `{"type":"adaptive"}`.

### Exact per-node-type data-key diff (the backward-compat contract)

| node types | key | 456a042 (launchpad now) | origin/main | migration impact |
|---|---|---|---|---|
| agent, orchestrator-agent, swarm | `thinkingBudgetTokens` | written by panel; read by generators | **not written, not read** | old graphs keep the key; harmlessly ignored. Thinking output changes from `enabled+budget` to `adaptive`. |
| agent, orchestrator-agent, swarm | `reasoningEffort` | `medium` default | same key; `'minimal'`→`'low'` coerced | old `'minimal'` still valid |
| agent, orchestrator-agent, swarm | `cacheMessages` | absent | new boolean (default false) | old graphs → no caching (unchanged behavior) |
| agent, orchestrator-agent, swarm | `cacheTools` | absent | new boolean (default false) | same |
| agent, orchestrator-agent, swarm | `modelProvider` | `AWS Bedrock`/`OpenAI` | + `Amazon Bedrock (Mantle)` | additive |
| agent, orchestrator-agent, swarm | `region` | absent | new (Mantle only) | additive |
| agent, orchestrator-agent, swarm | `modelName` | display label | also the **custom-model sentinel** (`'Custom model'`) | additive semantics |
| agent, orchestrator-agent, swarm | `modelId`/`baseUrl`/`apiKey` | present | same; Mantle sets `baseUrl` from region | compatible |
| **skill** (NEW) | `label`,`skillName`,`description` | n/a | new node type | additive |
| tool | `toolName` | map incl. `file_write`(launchpad)+`mem0_memory` | map drops both `file_write`+`mem0_memory` | **behavior change** — see §7 |

No **renames** — every existing key keeps its name. The only true behavior changes are the thinking-shape change (adaptive) and the `mem0_memory`/`file_write` tool-map drop.

---

## §6. Sample gallery

- **Format** (`origin/main:src/lib/sample-flows/types.ts`): `SampleFlow = { id, name, description, level:'basic'|'advanced', graphMode, nodes:Node[], edges:Edge[], requiredSkills?: SampleSkillDefinition[] }`; `SampleSkillDefinition = { name, description, instructions }`.
- **Registry** (`sample-flows/index.ts`): `SAMPLE_FLOWS` = 6 basic (single-agent, agent-with-tools, agent-with-mcp, orchestrator-sub-agents, agent-swarm, graph-dag) + 2 advanced (skilled-pirate-assistant, cached-research-pipeline). Each sample is a plain nodes/edges/graphMode literal using `DEFAULT_MODEL_ID` and the same `data` keys the generators read (samples set an extra `inputType:'user-prompt'` on input nodes — **not** part of the input-node schema nor read by codegen; a harmless cosmetic field).
- **Loader UI** (`origin/main:src/components/sample-gallery-modal.tsx`): renders basic/advanced cards; on click (no missing skills) calls `onLoadSample(sample)`. Wired in `main-layout.tsx` (`showSampleGallery` state, `:12/:127`) where `onLoadSample` sets `nodes/edges/graphMode`. **Backend coupling:** the modal calls `apiClient.listSkills()` (to know which `requiredSkills` are missing) and, for the "Import & Load" button, `apiClient.importSkill({source_type:'inline', name, description, instructions})` (tolerates 409 "already imported").
- **skilled-pirate-assistant** (`sample-flows/skilled-pirate-assistant.ts`): input → agent (Bedrock Sonnet 4.6, `streaming`, `cacheMessages`+`cacheTools`) → output, plus a `skill` node `{skillName:'pirate-speak', description:'Answer in pirate speak'}` whose `skill-output` connects to the agent's `tools` handle. `requiredSkills:[{name:'pirate-speak', description, instructions:'When this skill is active, ALWAYS respond in exaggerated pirate speak…'}]`. **Launchpad mapping:** to run this sample we need a `pirate-speak` AGENT_SKILLS record. Upstream's one-click inline import maps to launchpad's `register_skill(name, description, skill_md)` (`registry_console.py:275`), but that record starts **DRAFT** and only APPROVED records appear in `attachable_records()` — so an auto-import path would need the record promoted before the picker/zip can use it. Simplest for the port: seed `pirate-speak` as an APPROVED sample record, or gate the advanced sample on its presence.
- `cached-research-pipeline` is a Graph-Mode DAG (planner → researcher+reviewer → output), every agent `cacheMessages:true`, **no** skill dependency — a pure caching demo, no backend coupling.

---

## §7. flow-editor / node-palette / code-panel deltas relevant to us

- **flow-editor.tsx** (`+36/-11`): functional bits = register `skill: SkillNode` in `nodeTypes` (`:47`), skill drop default (`:211-217`), agent drop default now `modelId: DEFAULT_MODEL_ID, modelName:'Claude Sonnet 4.6'` (`:207-208`). Everything else (Graph-Mode toggle, MiniMap/Background props) is **restyle** — launchpad already has its own `FlowEditor.tsx`; port only the skill registration + drop default + the new agent default id.
- **node-palette.tsx** (`+46/-14`): add the `skill` entry (Sparkles icon, Core category); the rest is restyle. Launchpad's `NodePalette.tsx` must add a skill palette item in launchpad style.
- **nodes/index.tsx** (`+1`): `export { SkillNode }`.
- **code-panel.tsx** (`+448/-…`) and **`monaco-theme.ts`**: heavily entangled with the excluded AI-codegen `CodeState`. Launchpad's `CodePanel.tsx` renders from `generateStrandsAgentCode` directly and uses its own viewer. `monaco-theme.ts` is **just a vs-dark-derived theme** (`LAUNCHPAD_MONACO_THEME`) — **skip it**; launchpad already styles its code surface. Nothing in code-panel is required for the feature sync.
- **graph-builder-node.tsx** (`+30`): pure restyle, **no functional/data-key/handle change** (still not palette-droppable). Skip.

---

## §8. Minimal port plan hints

### Frontend — `frontend/src/studio/`
**Re-sync pure libs (logic only; adjust `@/lib/models`→relative import):**
- `lib/connection-validator.ts` — add the 2 skill rules + swarm-guard skill entry (§1c). (Verbatim-safe.)
- `lib/code-generator.ts` — re-sync §1d. **Decisions to preserve launchpad deviations on top:** (a) keep `file_write` in the strands_tools import + tool map if we want File-Write to keep working (upstream drops it → `calculator`); (b) decide on `mem0_memory` — dropping it (upstream) turns existing `mem0_memory` tool nodes into `calculator` and makes `STUDIO_EXTRA_REQUIREMENTS`'s `strands-agents-tools[mem0_memory]` moot. Everything else (skills, caching, adaptive thinking, Mantle, `DEFAULT_MODEL_ID`, orchestrator-no-MCP fix) ports as-is.
- `lib/graph-code-generator.ts` — re-sync §1e (same deviation decisions; graph mode's tool import already excludes both).
- `lib/graph-validator.ts` — **no change**.
- **NEW** `lib/models.ts` — copy verbatim (relative import only).

**Components (extend launchpad-styled files; do NOT copy upstream markup):**
- `nodes/skill-node.tsx` — new node in launchpad `studio.css` style; data `{label,skillName,description}`, single source handle `id="skill-output"` on the right.
- `nodes/index.tsx` — export `SkillNode`.
- `FlowEditor.tsx` — register `skill` in `nodeTypes`; add skill drop default; bump agent drop default id to `DEFAULT_MODEL_ID`/`'Claude Sonnet 4.6'`.
- `NodePalette.tsx` — add the skill palette item (Core).
- `PropertyPanel.tsx` — replace hardcoded `bedrockModels` with `BEDROCK_MODELS`; add Mantle provider option + `renderMantleFields` (`region`/`baseUrl`/`apiKey`, Mantle model select + custom id); add custom-model-id for Bedrock; swap the `thinkingBudgetTokens` input for the adaptive-thinking note; change reasoning-effort options to `low/medium/high/xhigh/max` (OpenAI+Mantle only) with `minimal→low` coercion; add `cacheMessages`/`cacheTools` checkboxes (Bedrock only); add a **skill node** property section whose picker is fed by `GET /api/registry/attachables` `.skills[]` (writes `skillName`+`description`).
- **Sample gallery (optional):** copy `lib/sample-flows/*` (pure data); build a launchpad-styled gallery modal; wire `onLoadSample` → `setNodes/setEdges/setGraphMode` in `CreateAgentStudio.tsx`. Point missing-skill checks at `/api/registry/attachables`; handle the DRAFT-vs-APPROVED gap for `skilled-pirate-assistant` (§6).

**`CreateAgentStudio.tsx` (`frontend/src/pages/CreateAgentStudio.tsx`):**
- **`extraReqs` (`:77-83`) must also trigger on the Mantle provider.** Today it adds `strands-agents[openai]` only when a node's `modelProvider === "OpenAI"`. Change to also include `Amazon Bedrock (Mantle)` (both need the `openai` extra — §4). Prompt caching / adaptive thinking / skills need **no** extra requirement.
- **Send skills to the backend.** The publish body (`:234-242`) currently omits skills. Add the referenced skill names (from `nodes` skill nodes connected to an agent `tools` handle) so the backend can bundle them — e.g. populate `AgentSpec.skills` for studio, or a new field. (Alternatively the backend regexes the generated `code`; but the frontend already has the node list.)

### Backend
- **`backend/app/deployer/zip_runtime.py` `build_zip()` — add `skills/` bundling.** For studio agents, resolve each referenced skill name → its APPROVED AGENT_SKILLS `path` (`s3://{bucket}/skills/{name}/` via `registry_console.attachable_records()` / a direct record lookup), download all objects under that prefix into `pkg_dir/skills/{name}/` before zipping (warn+skip missing, mirroring upstream `package_builder`). This satisfies the generated `Path(__file__).parent / "skills"` fallback (STUDIO_SKILLS_DIR is unset in the AgentCore runtime). Extraction of referenced names: from `spec.studio_flow` skill nodes, or regex the code with `os\.path\.join\(\s*_skills_dir\s*,\s*"([a-z0-9-]+)"\s*\)`.
- **`STUDIO_EXTRA_REQUIREMENTS` (`zip_runtime.py:95-98`)**: `strands-agents-tools[mem0_memory]` becomes optional if the generator drops `mem0_memory`; leave as-is unless removing mem0. The `strands-agents[openai]` extra is already passed through `spec.requirements` from the frontend (so no backend change needed if the frontend fix in `extraReqs` lands).
- **`AgentSpec` (`backend/app/schemas/agent.py`)**: `skills: list[str]` is currently harness-native s3 paths. For studio bundling, either reuse it (studio would store skill **names**, not paths — a semantic overlap to disambiguate) or add a dedicated field. Recommend a distinct representation so harness `skills[{path}]` and studio `skills/{name}/` bundling don't collide.
- `adapt_studio_code` needs **no change** — it preserves the module verbatim, so `_skills_dir` + `AgentSkills` survive.

### Breaking-change summary for saved `studio_flow` graphs
Non-breaking: skill rules, caching keys, Mantle, custom-model, `DEFAULT_MODEL_ID` fallback, adaptive-thinking (old `thinkingBudgetTokens` ignored), `reasoningEffort:'minimal'`→`'low'`. **Only** behavior change from a verbatim lib re-copy: `mem0_memory` tool nodes → `calculator` (and losing launchpad's `file_write` mapping unless re-applied). Neither errors; both silently downgrade a tool. Call these out and decide per §1d/§7.

---

## Caveats / Not found
- I did not exhaustively read `main-layout.tsx`/`code-panel.tsx`/`api-client.ts` internals beyond the skill+sample+model surface (they're dominated by the excluded AI-codegen / execution / chat features).
- Whether launchpad wants to keep `mem0_memory`/`file_write` in the tool map is a product decision, not resolvable from the diff — flagged, not decided.
- The DRAFT→APPROVED promotion path for auto-imported sample skills exists (`register_skill` starts DRAFT; `attachable_records` filters APPROVED) but the exact promotion API wasn't traced here (see `registry_console.py` state machine and the archived launchpad-lifecycle research).
- strands-agents 1.47.0 symbol checks were done against the **wheel contents**, not a runtime import (the launchpad backend venv has no `strands` installed — expected, since it's only vendored into the deploy zip).
