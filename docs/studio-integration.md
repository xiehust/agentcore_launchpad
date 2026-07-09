# Strands Studio Integration / Studio 集成

Strands Studio (方式C) is the platform's visual creation method: a
drag-and-drop canvas that generates Strands Agent SDK code, vendored as a
sub-app under `apps/studio/` and rewired so its one-click deploy lands in the
platform's unified pipeline, ledger and registry.

Strands Studio(方式C)是平台的可视化创建方式:拖拽式画布生成 Strands Agent
SDK 代码,以子应用形式集成在 `apps/studio/`,其一键部署已改接平台统一的
部署管道、台账与注册表。

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
generated import line always references.

## Running locally / 本地运行

`bash scripts/dev.sh` starts all four processes:

| Service | Port | Override |
| --- | --- | --- |
| platform backend | 8000 | `PLATFORM_API_PORT` |
| platform frontend | 5173 | `PLATFORM_UI_PORT` |
| studio backend | 8100 | `STUDIO_API_PORT` |
| studio frontend | 5273 | `STUDIO_UI_PORT` |

Cross-navigation: the platform's Create Agent 方式C card links to studio
(`VITE_STUDIO_URL`, default `http://localhost:5273`); studio's topbar has
"← Launchpad" back to the platform.

## i18n exception / 国际化例外

The studio UI itself stays English-only — it is a vendored third-party app and
forking every string would defeat the small-diff rule. Only the platform-side
方式C strings (method card, badges, link) are bilingual. This is the declared
vendored-app exception to the platform's i18n parity rule.

Studio 界面本身保持英文——它是第三方 vendored 应用,全量翻译会违背"最小改动"
原则。仅平台侧的方式C文案(方法卡片、徽标、链接)为双语,此为 i18n 平价规则
中已声明的 vendored 应用例外。
