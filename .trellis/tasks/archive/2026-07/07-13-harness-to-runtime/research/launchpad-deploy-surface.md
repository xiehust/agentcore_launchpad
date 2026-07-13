# Research: Launchpad zip_runtime deploy surface — can it ship an arbitrary multi-file Python project?

- **Query**: Can the existing `zip_runtime` pipeline deploy the multi-file output of `agentcore export harness` (main.py + pyproject.toml + packages mcp_client/, memory/, model/, hooks/, skills/), or is it locked to its single-file template? Planning a "convert harness → runtime agent" feature.
- **Scope**: internal
- **Date**: 2026-07-13

## Verdict

**PARTIAL.** The low-level packaging (the deployment zip + its extension hook) *already* carries arbitrary files — the zip is a recursive walk of the package dir and there is a post-assembly hook that skill-bundling uses to drop whole subtrees. But the `zip_runtime` **spec→code path is locked to a single `main.py` string**: `AgentSpec` has only `code: str` (no project/bundle field), `_generate_code` returns one string, and `build_zip` writes exactly one `main.py`. Requirements are a **flat pip list**, not a `pyproject.toml`, and pip runs **wheels-only for ARM64**. There is **no gateway/MCP attach path** for zip_runtime at all (harness-only). So shipping the exported project needs BUILDING: (a) a way to carry + stage the multi-file bundle into `pkg/`, (b) translating pyproject deps into the pip list, (c) env-injection for any KB/gateway/memory wiring the exported code expects. Everything else (S3 upload, CreateAgentRuntime, register, async status) is reused unchanged.

## Findings

### Files Found

| File Path | Description |
|---|---|
| `backend/app/deployer/zip_runtime.py` | The zip fast path: generate→package→provision→deploy→register. Single-`main.py` packaging + skills-bundle hook. |
| `backend/app/deployer/pipeline.py` | Method-agnostic stage runner; `create_deployment` + `start_deploy_async`; resumable JSONL job log. |
| `backend/app/deployer/container.py` | Container method — the ONLY existing multi-file assembly precedent (whole context dir zipped via `shutil.make_archive`), but routes through CodeBuild/Docker, not the zip fast path. |
| `backend/app/deployer/harness.py` | Managed harness (方式B). Where gateway MCP + KB + memory are wired (via CreateHarness `tools`) — the fidelity target for conversion. |
| `backend/app/services/agentcore/runtime.py` | `create_code_runtime`/`update_code_runtime` — entrypoint + artifact shape. |
| `backend/app/schemas/agent.py` | `AgentSpec` — the single artifact all methods converge into; `code: str` is the only code field. |
| `backend/app/routers/agents.py` | `POST /api/agents`, `/redeploy`, `/invoke`, `/jobs/{id}` — the create/deploy contract. |
| `backend/app/templates/strands_agent/{__init__.py,main.py.tmpl,requirements.txt}` | The single-file template + base pip pins. |
| `backend/app/templates/studio_agent/__init__.py` | `adapt_studio_code` — how custom (studio) code is injected; still a single string. |
| `backend/app/templates/claude_sdk_agent/__init__.py` | `assemble_build_context` — multi-file dir assembly (container precedent). |
| `backend/app/services/local_exec.py` | Studio local-debug executor — writes code + `skills/` into a temp workdir (staging precedent, non-deploy). |
| `infra/stacks/base_stack.py` | `launchpad-agent-execution-role` IAM statements (perms the deployed agent runs with). |
| `frontend/src/pages/CreateAgent.tsx` | Create wizard + `AgentList` (per-agent edit/chat/details/delete row actions). |
| `frontend/src/pages/Overview.tsx` | Read-only agent feed (no actions). |
| `frontend/src/lib/api.ts` | `createAgent`/`redeployAgent`/`deleteAgent`; `AgentSpecInput`/`AgentInfo` types. |

### 1. zip_runtime packaging flow (where the single-file lock lives + where it doesn't)

Stage order (`pipeline.py:26`): `generate → package → provision → deploy → register`.

- **generate** (`zip_runtime.py:290-297`) → `_generate_code(spec)` (`:270-276`) returns ONE string: `render_main_py(spec)` (strands template) OR, for `method="studio"`, `adapt_studio_code(spec.code)`. Requirements = `_method_requirements(spec)` (`:285-287`) = `base_requirements() + STUDIO_EXTRA + spec.requirements` — a **flat pip list**.
- **package** (`zip_runtime.py:300-327`) → `build_zip(code, requirements, build_dir, on_pkg_ready=_on_pkg_ready)`:
  - `build_zip` (`:44-93`): `pip install *requirements -t pkg_dir --platform manylinux2014_aarch64 --only-binary=:all: --python-version 3.13` (`:62-74`) → **ARM64 wheels only, Python 3.13**. Any sdist-only dep FAILS the build.
  - **`(pkg_dir / "main.py").write_text(code)` (`:79`)** — writes exactly ONE `main.py` from the string. This is the single-file lock.
  - **`on_pkg_ready(pkg_dir)` hook (`:82-83`)** runs AFTER main.py is written; it receives the full `pkg_dir`. `_stage_package` wires it to `bundle_skills` only (`:313-314`).
  - **Zip = recursive walk of `pkg_dir` (`:86-92`)** — so the zip FORMAT already carries arbitrary files/subdirs. Skill bundling proves this: it drops `pkg_dir/skills/{name}/` trees (`bundle_skills_into` → `_download_named_skills` → `dest_parent/"skills"/name`, `:230-267`). **The extension point for multi-file already exists** — it's `on_pkg_ready` + the recursive walk; the gap is only that nothing writes the exported project's sibling packages there, and `code` is a single string.
  - Upload: `s3://{artifacts_bucket}/agents/{name}/deployment_package.zip` (`:320-321`).
- **provision** (`zip_runtime.py:330-335`) → reuses `settings.resources.execution_role_arn` (no per-agent IAM for the zip path).
- **deploy** (`zip_runtime.py:338-395`) → `rt.create_code_runtime(...)` / `update_code_runtime` on re-publish. `_kwargs()` (`:346-362`) passes `s3_bucket`, `s3_key`, `role_arn`, `environment`. **Env injection is the ONLY platform wiring**: user `spec.env` + `LAUNCHPAD_MEMORY_ID` when memory enabled (`:349-353`). No tools/gateway/MCP anywhere.
- `method="studio"` rides the SAME stages (`register_method("studio", STAGES)`, `:413`). Studio's "custom code" injection = `adapt_studio_code` (`studio_agent/__init__.py:80-94`): keeps the module verbatim, strips the argparse `__main__`, appends a `BedrockAgentCoreApp` entrypoint. **It is still a single string written to one `main.py`** — NOT multi-file. So the studio precedent does NOT give multi-file; it gives "carry a user-authored single file".

### 2. Runtime artifact + entrypoint (fixed to main.py)

`create_code_runtime` (`runtime.py:16-40`) and `_code_artifact` (`:83-90`):
```
codeConfiguration.code.s3 = {bucket, prefix}
runtime = "PYTHON_3_13"
entryPoint = ["opentelemetry-instrument", "main.py"]   # HARDCODED
networkConfiguration = {"networkMode": "PUBLIC"}
```
The exported project's entrypoint is `main.py`, so the hardcoded entrypoint MATCHES — but every sibling package (`mcp_client/`, `memory/`, `model/`, `hooks/`) must sit next to `main.py` inside the zip root (`pkg/`) for `import mcp_client` etc. to resolve. AgentCore code-runtime supports a directory of files (S3 prefix), so the format is fine; the deployer just never populates siblings today.

### 3. POST /api/agents contract + AgentSpec (no multi-file field)

- `create_agent` (`agents.py:79-101`): body IS an `AgentSpec`; validates method ∈ {harness, zip_runtime, container, studio}, name uniqueness; persists `spec.model_dump()` on the `Agent` row; `create_deployment` + `start_deploy_async`. `redeploy_agent` (`:139-179`) runs the pipeline in `mode="update"` (name/method immutable).
- **`AgentSpec` (`schemas/agent.py:113-152`)** accepted fields: `name`, `method`, `model_id`, `system_prompt` (**required, min_length=1**), `tools[ToolRef]`, `skills[str]` (S3 prefixes), `requirements[str]` (extra pip, on top of base), **`code: str | None` (max 200000)** — "pre-generated agent code (studio method)", `studio_flow`, `memory`, `env`, `max_iterations`, `timeout_seconds`, `filesystem` (container-only), `network`, `knowledge_bases` (**harness-only**, validator `:146-152`).
- **There is NO multi-file / project-bundle / pyproject field.** The only code carrier is the single `code` string. Skill zips (`skills[]`) are S3 prefixes downloaded at package time, not agent source. So multi-file agent SOURCE is unsupported at the contract level — must be added.

### 4. Requirements: flat pip list vs the exported pyproject

- Base pins (`strands_agent/requirements.txt`): `strands-agents[otel]>=1.0,<2`, `bedrock-agentcore==1.17.*`, `aws-opentelemetry-distro>=0.10,<1`.
- Effective set = `base_requirements() + (STUDIO_EXTRA if studio) + spec.requirements` (`zip_runtime.py:285-287`). `STUDIO_EXTRA = ["strands-agents-tools[mem0_memory]"]` (`:279-282`).
- The exported project declares deps in **`pyproject.toml`** (`strands-agents>=1.15.0`, `bedrock-agentcore`, `mcp`, …). The pipeline does NOT read pyproject — deps must be flattened into `spec.requirements`. Caveats: (a) `strands-agents>=1.15.0` satisfies the base `<2` but **`bedrock-agentcore==1.17.*` base pin may conflict** with the exported project's looser/pinned version; (b) `--only-binary=:all:` (`:68`) fails if `mcp` or any transitive dep is sdist-only for aarch64. Whether to keep base pins or defer entirely to the exported deps is a design decision.

### 5. Execution role perms (what the deployed agent can do)

`launchpad-agent-execution-role` (`infra/stacks/base_stack.py:172-…`), assumed by `bedrock-agentcore.amazonaws.com`:
- `bedrock:InvokeModel[WithResponseStream]` (`:185-191`).
- **Memory data plane** (`:192-221`): `RetrieveMemoryRecords`, `GetMemoryRecord`, `ListMemoryRecords`, `CreateEvent`, `GetEvent`, `ListEvents`, `ListSessions`, `ListActors` — so an exported project's memory calls WORK **if it reads `LAUNCHPAD_MEMORY_ID`** (the platform injects that env, `zip_runtime.py:349-353`). The strands template's own memory helpers key off that exact env (`main.py.tmpl:28`, `recall_context`/`remember_turn`). Exported code that uses a different memory-id source will no-op gracefully.
- Code-interpreter + browser builtins (`:209-217`).
- Skill-bundle S3 (`GetObject skills/*`, `ListBucket`) (`:239-255`), ECR pull, telemetry (logs/xray/cloudwatch) (`:290-…`).
- Gateway: `GetGateway`, `GetGatewayTarget`, `ListGatewayTargets`, `InvokeAgentRuntime`, gateway-rule CRUD, `GetConfigurationBundle*` (`:256-280`) — present for A/B orchestration. `IdentityVaultSecrets` GetSecretValue on `bedrock-agentcore-identity!*` (`:281-289`).

**Gateway/MCP wiring gap for zip_runtime**: harness attaches the shared gateway with CLIENT_CREDENTIALS OAuth via CreateHarness `tools` (`harness.py:91-128`) and remote MCP servers via `remote_mcp` (`:82-90`); the harness runtime fetches Cognito M2M tokens itself. **zip_runtime has NO equivalent** — `create_code_runtime` takes no tools/gateway args; the only channel is env vars. So a converted agent's KB retrieval / gateway MCP will NOT be authenticated unless the conversion (a) injects the gateway MCP URL + a token (or M2M creds) as env AND (b) the exported code reads them. The exported project's `mcp_client/` package presumably points at gateway URLs baked in by the export — those URLs need a valid token at call time, which is the hard part of R3/A5. Memory via env is feasible; gateway MCP is the degradation risk.

### Code Patterns — multi-file precedents that DO exist

- **Container path** (`container.py:38-53`, `claude_sdk_agent/__init__.py:57-75`): `assemble_build_context` copies a set of template files (Dockerfile, requirements.txt, buildspec.yml, tracing.py, main.py) + optional `.claude/skills/` into a dir, then `_stage_package` `shutil.make_archive(context_dir, "zip")` uploads the WHOLE dir to S3 for CodeBuild. This is the cleanest existing "zip an arbitrary directory of files" pattern — but it targets Docker/ECR, not the code-runtime fast path.
- **Local-exec staging** (`local_exec.py:120-151`): writes `generated_agent.py` + `skills/` into a `tempfile.mkdtemp` workdir and runs it. Same "stage files into a dir" shape; reuses `bundle_skills_into` (`:106-118`).
- The **smallest reuse** for zip_runtime multi-file: feed the exported project files into `pkg_dir` via the existing `on_pkg_ready` hook (or a new pre-write step), letting `build_zip`'s recursive walk carry them — no change to S3/deploy/register.

### Frontend entry points

- **Create wizard** `CreateAgent.tsx`: step-1 method cards (`:486-…`, methods `harness|zip_runtime|container` at `:26`), `buildSpec()` (`:255-296`) assembles the AgentSpec, `submit()` (`:298-…`) calls `api.createAgent` or `api.redeployAgent` (edit mode via `startEdit`, `:319-323`). Studio edits route to `/create/studio?agent=id` (`:552-553`).
- **Per-agent actions** live in the `AgentList` component (`CreateAgent.tsx:1160-1243`): row actions render at `:1200-1228` — Edit (disabled while deploying), Chat (active only), Details (if deployment), Delete. **A "Convert" rowact for harness rows drops in here**, gated `a.method === "harness" && a.status === "active"`, next to the existing buttons.
- `Overview.tsx` is a read-only feed (`:188-222`) — no actions; not the place for a convert action.
- **api client** (`api.ts`): `createAgent`/`redeployAgent`/`deleteAgent` (`:354-374`), `AgentSpecInput` (`:70-`), `AgentInfo` with `spec: Record<string,unknown>` (`:21-31`). A `convertAgent(id)` call + a `source_harness` field on AgentInfo/spec would be the additions.
- Experiment select: `EvaluationExperiment.tsx` (matched the method grep) is where harness rows must become disabled entries with a conversion hint (R2/A4).

## Caveats / Not Found

- **`agentcore export harness` output is not present in the repo** — no sample exported project, no existing parser. The exact file layout (which packages, whether `mcp_client/` hardcodes gateway URLs, how memory-id is sourced) is asserted by the PRD only; the design should capture a real export of `aurora-support`/`hr-assistant` to confirm the package set and dep list before wiring. The `agentcore` CLI presence on the host was NOT verified here (PRD says "present on the host, requires a project cwd").
- Did not verify whether `mcp` and the exported transitive deps all publish aarch64 wheels (needed for `--only-binary=:all:`). This is a build-time risk to probe live.
- Whether AgentCore code-runtime imposes any package-layout constraints beyond "main.py at root" was not confirmed against the control API docs.
- No existing `source_harness` / conversion field, endpoint, or i18n strings exist yet — all net-new.

## Related Specs

- `.trellis/spec/launchpad/evaluation-agent-eligibility.md` — the harness-exclusion rationale that motivates this task (referenced grep hit; harness `InvokeAgentRuntime` → ValidationException, managed code never reads `get_config_bundle()`).
- `.trellis/tasks/archive/2026-07/07-11-studio-local-debug-and-defaults/research/upstream-exec-chat-fix.md` — mentions export harness in the studio-exec context.
