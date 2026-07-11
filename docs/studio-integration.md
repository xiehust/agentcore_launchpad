# Strands Studio Integration / Studio 集成

Strands Studio (方式C) is the platform's visual creation method: a
drag-and-drop canvas that generates Strands Agent SDK code. It exists in two
forms:

1. **Native canvas (paved path, 2026-07-11)** — `/create/studio` inside the
   platform frontend (`frontend/src/pages/CreateAgentStudio.tsx` +
   `frontend/src/studio/`). Fully bilingual, publishes through
   `POST /api/agents`, persists the flow graph for edit/re-publish. See
   [Native canvas](#native-canvas--原生画布) below.
2. **Vendored standalone app** — `apps/studio/` (port 5273, own backend
   :8100), kept as-is for standalone use; its Launchpad deploy section still
   works but does not persist a flow graph.

Strands Studio(方式C)是平台的可视化创建方式:拖拽式画布生成 Strands Agent
SDK 代码。现有两种形态:平台内置的原生画布 `/create/studio`(主路径,双语、
经 `POST /api/agents` 发布、持久化画布图以支持再编辑);以及保留的独立子应用
`apps/studio/`(维持原样,可独立使用,但不持久化画布图)。

## Provenance / 来源

- Upstream: [xiehust/strands_studio_ui](https://github.com/xiehust/strands_studio_ui)
  @ commit `d56f396c16815bb8983210977598c7973746675f` (vendored 2026-07-09).
- Upstream declares no OSS license at that commit — see `apps/studio/LICENSE`
  for the attribution notice.
- Excluded when vendoring: `.git/`, `node_modules/`, backend venv, binary
  screenshots (`assets/*.png`).

## Modifications / 改动清单

The diff against upstream is intentionally small:

| File | Change |
| --- | --- |
| `src/lib/launchpad-client.ts` | **new** — API client: `deployToLaunchpad` / `getLaunchpadAgent` / `getLaunchpadJob` via the `/launchpad-api` proxy |
| `src/components/launchpad-deploy-section.tsx` | **new** — "Deploy via Launchpad platform" section (name input, deploy button, live job-event feed) |
| `src/components/agentcore-deploy-panel.tsx` | mounts the section above at the top of the AgentCore deploy panel |
| `src/components/main-layout.tsx` | "← Launchpad" navigation link back to the platform |
| `vite.config.ts` | port 5273; `/api`, `/health`, `/ws` → studio backend :8100; `/launchpad-api` → platform backend :8000 (rewritten to `/api`) |

Studio's own Lambda / ECS / direct-AgentCore deploy options remain functional
but bypass the platform (no ledger entry, no registry record) — the Launchpad
section is the paved path. Local run / chat / execution history are untouched.

Studio 自带的 Lambda / ECS / 直连 AgentCore 部署仍可用,但绕过平台(无台账、
无注册表记录);Launchpad 区块是推荐路径。画布内的本地运行/聊天/历史功能保持原样。

## Deploy flow / 部署链路

```
studio canvas ──generate code──▶ Deploy via Launchpad
      │  POST /launchpad-api/agents  {name, method: "studio", code}
      ▼
platform pipeline (zip fast path)
      generate  – adapt_studio_code(): verbatim module + entrypoint wrapper
      package   – pip (manylinux2014_aarch64) → zip → S3
      provision – shared execution role
      deploy    – CreateAgentRuntime → poll READY
      register  – A2A registry record, auto-submitted
```

The studio panel polls the platform job and streams stage events inline; the
agent then appears in the platform launch feed with a `STUDIO` method chip.

## Artifact adaptation / 产物适配

`backend/app/templates/studio_agent/adapt_studio_code()` converts the studio
script into an AgentCore module **without rewriting user code**:

1. If the code already contains `@app.entrypoint`, it is used as-is.
2. Otherwise the module is kept **verbatim** (imports, MCP clients, model
   config, `async def main(...)`), the trailing argparse `__main__` block is
   cut, and a `BedrockAgentCoreApp` entrypoint is appended that calls `main()`
   (arity-probed: `main()`, `main(user_input)`, or `main(user_input, messages)`)
   and captures its streamed stdout as the result.
3. The platform config-bundle shim (`launchpad_config_bundle()`) is injected
   unless the code already reads `get_config_bundle` — studio authors can call
   it to opt into A/B config bundles (system prompt overrides are never forced
   onto arbitrary user code).

An earlier iteration used upstream's `code_adapter.py` section extractor; it
was dropped because its keyword heuristics silently lose module-level MCP
client definitions.

Requirements added on top of the studio code: the platform zip baseline
(`strands-agents[otel]`, `bedrock-agentcore`, `aws-opentelemetry-distro` for
ADOT traces) plus `strands-agents-tools[mem0_memory]`, which studio's
generated import line always references. When any node uses the **OpenAI** or
**Amazon Bedrock (Mantle)** provider, `CreateAgentStudio.tsx` adds
`strands-agents[openai]` to `spec.requirements` — both providers import
`openai` at module top level (shipped only via that extra, which also pulls
the Bedrock token generator Mantle auth needs). Prompt caching, adaptive
thinking, and skills need no extra. Generated code reads `OPENAI_API_KEY` /
`BEDROCK_API_KEY` from the runtime env; the publish body maps each node's
`apiKey` onto `spec.env` (first non-empty per provider), which the deploy
stage passes as `environmentVariables` (platform-injected keys like
`LAUNCHPAD_MEMORY_ID` win over same-named user env). The key lives in
`studio_flow` → ledger spec in plaintext, same exposure class as upstream's
localStorage — acceptable for this demo platform.

## Skill bundling / 技能打包

The canvas Skill node attaches a launchpad **AGENT_SKILLS** registry record
(the picker lists APPROVED records from `GET /api/registry/attachables`) to an
agent. The generator emits
`plugins=[AgentSkills(skills=[os.path.join(_skills_dir, "<name>")])]` plus a
module-level `_skills_dir = os.environ.get("STUDIO_SKILLS_DIR") or
str(Path(__file__).parent / "skills")`. At runtime `STUDIO_SKILLS_DIR` is
unset, so the code resolves `skills/<name>/` next to `main.py`.

`build_zip()` (`backend/app/deployer/zip_runtime.py`) bundles those dirs at
package time (studio method only):

1. Regex the adapted code for `os\.path\.join\(\s*_skills_dir\s*,\s*"([a-z0-9-]+)"\s*\)`
   (the same pattern upstream's `agentcore_deployment_service` uses) → unique
   referenced skill names.
2. Resolve each name against the APPROVED AGENT_SKILLS records
   (`registry_console.attachable_records()`, `name == s3 prefix segment`,
   `path = s3://{bucket}/skills/{name}/`).
3. Download every object under that prefix into `pkg_dir/skills/{name}/`
   (path-traversal guarded, 50 MB/skill cap) — the zip walk picks it up.

Any skill issue (missing/unapproved record, oversize, download error) logs +
skips, never fails the deploy — mirroring upstream. `adapt_studio_code` is
untouched (the `_skills_dir` line survives verbatim). `AgentSkills` /
`CacheConfig` / `OpenAIResponsesModel` all resolve from the zip pin
`strands-agents[otel]>=1.0,<2` (→ 1.47.0), so no SDK bump is needed. No schema
change: skill refs are derived from the generated code, not a new field.

画布 Skill 节点把 launchpad 的 **AGENT_SKILLS** 注册表记录附加到 agent(选择器
仅列出 `GET /api/registry/attachables` 的 APPROVED 记录)。生成代码通过
`plugins=[AgentSkills(...)]` 引用 `skills/<name>/`;`build_zip()` 在打包阶段
(仅 studio 方式)按正则从生成代码提取被引用的技能名,解析 APPROVED 记录的 S3
前缀,下载到 `pkg_dir/skills/{name}/`(含路径穿越防护与 50 MB 上限),缺失/超限
/下载失败均记录并跳过,绝不阻断部署。无需 schema 改动或 SDK 升级。

## Running locally / 本地运行

`bash scripts/dev.sh` starts all four processes:

| Service | Port | Override |
| --- | --- | --- |
| platform backend | 8000 | `PLATFORM_API_PORT` |
| platform frontend | 5173 | `PLATFORM_UI_PORT` |
| studio backend | 8100 | `STUDIO_API_PORT` |
| studio frontend | 5273 | `STUDIO_UI_PORT` |

Cross-navigation: the platform's Create Agent 方式C card links to the NATIVE
canvas (`/create/studio`, internal route — `VITE_STUDIO_URL` is no longer used
by the platform frontend); studio's topbar has "← Launchpad" back to the
platform.

## i18n exception / 国际化例外

Only the vendored `apps/studio/` app stays English-only (third-party code,
small-diff rule). The NATIVE canvas is a first-class platform page and is
fully bilingual (`studio.*` namespace, en + zh-CN parity enforced by
`scripts/verify.sh`).

仅 vendored 的 `apps/studio/` 保持英文(第三方代码、最小改动原则)。原生画布
是平台一等页面,完整双语(`studio.*` 命名空间,en 与 zh-CN 平价由
`scripts/verify.sh` 校验)。

## Native canvas / 原生画布

Code-spec for the native canvas publish contract (task
`07-11-strands-studio-canvas`; research + design in that task dir).

### 1. Scope / Trigger

Cross-layer contract: the canvas page composes a flow, generates Strands code
client-side, and publishes via the platform API. One additive schema field
(`AgentSpec.studio_flow`) carries the graph for later edit/re-publish.

### 2. Signatures

- Frontend codegen (pure, no IO): `generateStrandsAgentCode(nodes: Node[],
  edges: Edge[], graphMode = false) → { code: string; imports: string[];
  errors: string[] }` (`frontend/src/studio/lib/code-generator.ts`).
  Final file = `imports.join('\n') + '\n\n' + code`. `errors.length > 0 ⇒
  code === ''` and publish must be blocked.
- API: `POST /api/agents` (create) / `POST /api/agents/{id}/redeploy`
  (re-publish; `name` and `method` immutable — backend 400s on change).
- Schema: `AgentSpec.studio_flow: dict | None = None`
  (`backend/app/schemas/agent.py`) — stored verbatim inside the `Agent.spec`
  JSON column; every pipeline stage ignores it.

### 3. Contracts

Publish body assembled by `CreateAgentStudio.tsx`:

| Field | Value | Constraint |
| --- | --- | --- |
| `name` | user input (locked on re-publish) | `^[a-z][a-z0-9-]{2,47}$` |
| `method` | `"studio"` | fixed |
| `system_prompt` | execution agent's systemPrompt (the agent/orchestrator/swarm reached from the input node), fallback `"Strands Studio generated agent"` | trimmed to 20000; doubles as the registry A2A card description |
| `code` | `imports + '\n\n' + code` | ≤ 200000 chars (client-checked; schema max) |
| `requirements` | `["strands-agents[openai]"]` iff any node `data.modelProvider` is `'OpenAI'` or `'Amazon Bedrock (Mantle)'`, else omitted | base reqs + mem0 extra come from the backend, never sent by the client |
| `env` | `{OPENAI_API_KEY?, BEDROCK_API_KEY?}` — first non-empty `apiKey` per provider; omitted when empty | passed to the runtime as `environmentVariables`; platform keys win same-named conflicts |
| `memory` | `{short_term: false, long_term: false}` | generated code manages no launchpad memory |
| `studio_flow` | `{nodes, edges, graphMode}` (React Flow arrays verbatim) | round-trips into edit mode; carries skill nodes for the package-stage bundler |

Edit mode (`/create/studio?agent=<id>`): `GET /api/agents/{id}` →
`spec.studio_flow` restores the canvas. Studio agents WITHOUT `studio_flow`
(published by `apps/studio/`) degrade: banner + read-only `spec.code`, publish
disabled until a flow exists.

### 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| generation `errors[]` non-empty | toast + code drawer opens; publish blocked |
| name fails regex | publish button disabled |
| full code > 200000 chars | toast error, no POST |
| invalid canvas connection | `onInvalidConnection` callback → toast (never `alert()`) |
| redeploy with changed name/method | backend 400 (client locks name field instead) |
| `?agent=` id missing/non-studio | toast + redirect `/create` |

### 5. Good/Base/Bad Cases

- Good: input+agent+tool+output flow → publish → `active`, chat/eval work
  (verified end-to-end 2026-07-11, agent `studio-canvas-e2e`).
- Base: agent-only edits (prompt/model) re-published to the same ARN, new
  runtime version, revision +1.
- Bad: flow without an input or output node → generator returns errors, code
  empty, publish blocked.

### 6. Tests Required

- `scripts/verify.sh` (backend ruff/pytest, frontend eslint/tsc/build, i18n
  parity) — the standing gate.
- E2E (manual/browser): canvas build → publish → LaunchSequence completes →
  chat responds → eval run completes → edit restores flow → re-publish.
- Round-trip assertion: `GET /api/agents/{id}` echoes `spec.studio_flow`
  with the exact `{nodes, edges, graphMode}` that was posted.

### 7. Wrong vs Correct

#### Wrong

Editing a studio agent through the wizard (`startEdit` → `buildSpec()`):
`buildSpec()` does not carry `code`, so redeploy would silently replace the
canvas-generated module with template code.

#### Correct

`CreateAgent.tsx` routes Edit for `method === "studio"` to
`/create/studio?agent=<id>`; the canvas regenerates `code` from the restored
flow and posts it together with the updated `studio_flow`.

### Porting invariants / 移植不变量

`frontend/src/studio/lib/*` (`code-generator.ts`, `graph-code-generator.ts`,
`connection-validator.ts`, `graph-validator.ts`, `models.ts`, `sample-flows/*`)
are copied VERBATIM from upstream `xiehust/strands_studio_ui`
(eslint-ignored, still tsc-checked). Current baseline: **PR #31**, merge
`69318ab` (`git -C <clone> show origin/main:src/lib/<file>` reproduces each
file byte-for-byte). The `@/lib/models` alias is the only rewrite → relative
`./models` (`../lib/models` from components), since the studio subtree has no
`@` alias. The documented deviation set is now **two entries**, both
re-applied to the two generators' static `strands_tools` import line AND tool
map: **`file_write`** and **`mem0_memory`** — upstream drops both (they silently
fall back to `calculator`); launchpad keeps them so saved graphs' tool nodes
don't downgrade. When re-vendoring upstream, re-apply both.

Node components must preserve every React Flow Handle `id`/`type`/`Position`
and every node `data` key + destructuring default — the generators read them.
Styling is launchpad CSS tokens only (namespaced `studio.css`); no Tailwind.

`frontend/src/studio/lib/*`(`code-generator.ts`、`graph-code-generator.ts`、
`connection-validator.ts`、`graph-validator.ts`、`models.ts`、`sample-flows/*`)
逐字复制自上游 `xiehust/strands_studio_ui`,当前基线为 **PR #31**(合并提交
`69318ab`)。唯一改写是把 `@/lib/models` 别名改为相对路径 `./models`。已记录的
偏差现有**两项**(均在两个生成器的 `strands_tools` import 行与工具映射表中重新
应用):**`file_write`** 与 **`mem0_memory`** —— 上游都已移除(会静默回退为
`calculator`),launchpad 保留以免已保存画布的工具节点被降级。重新引入上游时
须重新应用这两项。
