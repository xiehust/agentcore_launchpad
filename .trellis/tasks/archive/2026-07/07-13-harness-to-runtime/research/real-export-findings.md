# Real `agentcore export harness` output — first-hand facts (2026-07-13)

Source: live export of `aurora-support`
(`arn:aws:bedrock-agentcore:us-west-2:434444145045:harness/aurora_support-wdwexeZD2R`)
on this host, CLI `@aws/agentcore` 0.21.1. Output inspected at
`/tmp/harness-export/harnessinspect/app/aurora_supportAgent/` (regenerate the
same way if gone). These answer the deploy-surface research's two caveats.

## CLI mechanics (verified)

- CLI IS present on host (`agentcore` 0.21.1; update 0.24.0 available).
- `agentcore export harness --arn <harness-arn> --build CodeZip --json`
  **requires an agentcore project cwd** — otherwise
  `{"success":false,"error":"No agentcore project found…"}`. A scratch
  project works: `agentcore create --project-name X --no-agent --json`
  (~seconds, purely local, no AWS resources).
- Success JSON: `{"success":true,"agentName":"aurora_supportAgent",
  "agentPath":"…/app/aurora_supportAgent","notesPath":"…/EXPORT_NOTES.md"}`.
  Export itself took ~10s.

## Project shape (7 py files, 682 lines total + pyproject)

```
main.py (259)            # BedrockAgentCoreApp entrypoint
mcp_client/client.py(35) # gateway MCP wiring
memory/session.py (28)   # AgentCore memory session manager
model/load.py (6) + model/mantle_compat.py (21)
hooks/execution_limits.py (54)
skills/fetcher.py (279)
pyproject.toml           # hatchling; deps below
.gitignore README.md EXPORT_NOTES.md
```

Deps (`[project].dependencies`): `aws-opentelemetry-distro`,
`bedrock-agentcore >= 1.9.1`, `botocore[crt] >= 1.35.0`, `mcp >= 1.19.0`,
`strands-agents >= 1.15.0` — all satisfiable by launchpad's base pins
(base `bedrock-agentcore==1.17.*` satisfies `>=1.9.1`); all pure-python or
aarch64-wheeled (mcp/strands pure, awscrt has manylinux aarch64).

## Entrypoint / payload contract (verified — experiment-compatible)

`main.py` `@app.entrypoint invoke(payload, context)` →
`_extract_prompt(payload)`: accepts harness-style `messages[]`,
`tool_results[]`, **or plain `{"prompt": str}`** — so the experiment
gateway's `{"prompt", "sessionId"}` POST and launchpad's
`invoke_runtime_text` both work as-is. System prompt is a BAKED constant
`DEFAULT_SYSTEM_PROMPT` (why config-bundle A/B needs the converted copy —
wait, note: baked constant means config bundles ALSO no-op on the exported
code unless the template is adapted to read get_config_bundle; see design
implication below).

## Env contract (NOT baked URLs — env-injected, graceful degradation)

- Gateway MCP: `os.environ.get("GATEWAY_GATEWAY_LAUNCHPAD_KB_GW_PMYQ7MCHUM_URL")`
  → if unset, logs a warning and SKIPS the gateway client (no crash). Auth =
  AgentCore Identity M2M `@requires_access_token(provider_name=
  "launchpad-gw-m2m", scopes=["launchpad-gw/invoke"], auth_flow="M2M")` —
  if the env IS set but the token fetch fails, module import raises → the
  runtime crashes. So only inject the URL after confirming the new
  runtime's workload identity can obtain that token.
- Memory: `os.getenv("MEMORY_MEMORY_LAUNCHPAD_MEMORY_HURAGN3ENF_ID")` → if
  unset, `get_memory_session_manager` returns None (clean no-memory mode).
- Model: hardcoded `BedrockModel(model_id="global.anthropic.claude-sonnet-4-6")`
  — exec role must allow that model (launchpad roles already invoke Bedrock).
- Env var names are deterministic: `GATEWAY_GATEWAY_{GW_ID_UPPER}_URL`,
  `MEMORY_MEMORY_{MEMORY_ID_UPPER}_ID` — discoverable by grepping the
  exported files for `os.environ.get(`/`os.getenv(`.

## Design implication spotted during export review (IMPORTANT for the
experiment story)

The exported code's system prompt is a baked constant — **it does NOT read
`BedrockAgentCoreContext.get_config_bundle()` either**. Launchpad's own
zip_runtime template presumably does (experiments on zip agents work — the
bundle A/B mechanism). For the converted agent to be a REAL experiment
subject, the conversion must adapt `main.py` the way launchpad's template
consumes config bundles (or the bundle variants would no-op exactly like on
the harness). Check `backend/app/deployer/templates` / `_generate_code` for
the get_config_bundle pattern and graft it onto the exported main.py
(prompt = bundle override ?? DEFAULT_SYSTEM_PROMPT).

## Invoke-lock context (why conversion is needed at all)

Direct `InvokeAgentRuntime` on the harness backing runtime fails:
`ValidationException: … is managed by a harness and cannot be invoked
directly. Use the InvokeHarness API…` (verified live). Backing runtimes ARE
listed by ListAgentRuntimes (`harness_{name}` prefix, READY).
