# Design — Harness → runtime conversion (experiment enablement)

Research: `research/launchpad-deploy-surface.md` (deploy pipeline map),
`research/real-export-findings.md` (first-hand export facts — read BOTH).

## 0. Core insight and stance

The export alone is NOT enough for the experiment story: the exported
`main.py` bakes `DEFAULT_SYSTEM_PROMPT` as a constant and never reads
`get_config_bundle()` — config-bundle A/B would no-op exactly as it would on
the harness. The conversion therefore has three jobs:

1. **Export** the harness to a Strands project (`agentcore` CLI, scratch
   project cwd).
2. **Graft** launchpad's config-bundle contract onto the exported
   `main.py` (the `resolve_system_prompt()` pattern from
   `backend/app/templates/strands_agent/main.py.tmpl:79-90`).
3. **Deploy** the multi-file project through the existing zip_runtime
   pipeline (which needs a small contract extension to carry multiple
   files).

**Graft failure fails the conversion** (clear error, no agent row left
behind). Rationale: experiment enablement is this feature's purpose; a
silently non-A/B-able "converted" agent recreates the exact trap this task
exists to remove. The graft targets the deterministic codegen of the pinned
CLI (0.21.x: `DEFAULT_SYSTEM_PROMPT = """…"""` constant +
`system_prompt=DEFAULT_SYSTEM_PROMPT` at Agent construction) and is
unit-tested against a fixture copy of the real export.

## 1. Backend

### 1.1 AgentSpec extension (`backend/app/schemas/agent.py`)

```python
code_bundle: dict[str, str] | None = None   # relpath → content; multi-file source
source_harness: dict[str, str] | None = None
# {"agent_id", "agent_name", "harness_arn"} — traceability (R5/A3)
conversion_notes: dict[str, str] | None = None
# per-capability wiring outcome: {"memory": "wired", "kb_gateway": "not wired — …", ...}
```

Validation: `code_bundle` keys must be safe relative paths (no absolute, no
`..`, ≤64 entries, total content ≤1MB, must contain `main.py`). `code` and
`code_bundle` are mutually exclusive.

### 1.2 zip pipeline (`backend/app/deployer/zip_runtime.py`)

In `_stage_package`/`build_zip` seam (research fact #1): when
`spec.code_bundle` is set, skip `_generate_code`; write every bundle file
under `pkg_dir` (parents created); the existing recursive-walk zip carries
them. Entrypoint stays `main.py` (bundle validation guarantees it). The
`on_pkg_ready` skills hook is untouched and composes.

Requirements: flatten the exported `pyproject.toml`
`[project].dependencies` into `spec.requirements` at conversion time
(conversion-side, not deployer-side — the deployer keeps its flat-list
contract). Dedupe against `base_requirements()` pins: base pins win
(`bedrock-agentcore==1.17.*` satisfies the export's `>=1.9.1`; verified
all export deps are pure-python or aarch64-wheeled).

### 1.3 Conversion service (`backend/app/services/harness_convert.py`, new)

```python
def export_harness(harness_arn: str, workdir: Path, progress) -> Path
    # ensure scratch agentcore project (create once under DATA_DIR/"harness-export",
    # reuse afterwards); run `agentcore export harness --arn … --build CodeZip --json`
    # (subprocess, ~10s, timeout 120s); parse agentPath from JSON; clean error if
    # CLI missing (FileNotFoundError → AppError agent.convert_cli_missing)

def graft_config_bundle(main_py: str) -> str
    # insert _config_bundle()/resolve_system_prompt() helpers after the
    # DEFAULT_SYSTEM_PROMPT constant; replace `system_prompt=DEFAULT_SYSTEM_PROMPT`
    # with `system_prompt=resolve_system_prompt()`; raise ConversionError when
    # either anchor is missing

def discover_env(files: dict[str, str]) -> dict[str, str | None]
    # regex os.environ.get("K")/os.getenv("K") over bundle files → {K: value|None}
    # fill: MEMORY_MEMORY_*_ID from settings.resources memory id when the
    # embedded id matches; GATEWAY_*_URL deliberately NOT wired in v1 (see 1.5)

def build_conversion_spec(harness_agent, files, env) -> AgentSpec
    # method="zip_runtime", code_bundle=files, requirements=flattened deps,
    # env=wired vars, source_harness=…, conversion_notes=…
```

### 1.4 API (`backend/app/routers/agents.py`)

```
POST /api/agents/{agent_id}/convert  → 202 {"agent": <new agent row>}
```

Guards: source must be `method=="harness" && status=="active"` (400
`agent.convert_unsupported`); 409 `agent.convert_in_flight` when a
non-failed converted agent from this source is still deploying (check
`source_harness.agent_id` over in-flight rows); name = `{name}-rt` with
`-2`, `-3` suffix dedupe. Flow: create the agent row via the existing
create/deploy path with the conversion spec, with the export+graft running
as a pre-step of the async deploy job (progress: "exporting harness code…"
→ "adapting config-bundle contract…" → normal deploy stages). If the
pipeline's job structure resists a pre-step, fallback = run export+graft
synchronously in the request (~10-15s) and hand the pipeline a ready
bundle — decide at implementation, contract unchanged either way.
Failure anywhere → the row goes to the deploy pipeline's existing `failed`
state (A2: no half-registered rows outside the normal lifecycle).

### 1.5 Fidelity policy (R3/A5)

| Capability | v1 outcome | Why |
|---|---|---|
| system prompt | wired (+ bundle override via graft) | core |
| inline tools (shell/file/code) | carried verbatim | in main.py |
| memory | wired via discovered `MEMORY_MEMORY_*_ID` env when it matches the launchpad memory; else unset (code no-ops cleanly) | export reads env, degrades to None |
| KB / gateway MCP | **not wired** — `GATEWAY_*_URL` left unset; exported client logs a warning and skips | setting the URL without verified M2M token access crashes the runtime at import (`@requires_access_token` raises); launchpad's KB-attach is harness-only today. Recorded in `conversion_notes.kb_gateway` and surfaced in UI |
| skills fetcher | carried; behaves per exported code | inert without its config |

`conversion_notes` is rendered in agent detail so the degradation is
explicit, satisfying R3's honesty requirement.

## 2. Frontend

- `api.convertAgent(id)` in `frontend/src/lib/api.ts`; `AgentInfo` gains
  `source_harness?` (+ `conversion_notes?` via detail).
- **Agent Management** (`CreateAgent.tsx` AgentList rows): action
  `⇄ 转换为 RUNTIME` on `method==="harness" && status==="active"` rows →
  ConfirmDialog (what converts, ~5-15 min, KB not carried in v1) → POST →
  toast + the new row appears with the existing deploy-status chip.
- **Agent detail**: `source: harness <name>` mono line + conversion notes
  list when `source_harness` present.
- **Experiment page** (`EvaluationExperiment.tsx`): the start-form select
  additionally lists active harness agents as `disabled` options labeled
  `… · harness（需转换）`; below the select, when any exist, a note:
  "harness agent 需先转换为 runtime 才能实验 — 前往 Agent 管理" (en
  mirror). The eligibility filter itself is unchanged.
- i18n: `agentsPage.convert.*` + `expPage.harnessHint` keys, en + zh-CN.

## 3. Testing

- **Unit (backend)**: `graft_config_bundle` (fixture = real export's
  main.py; asserts helpers inserted + construction site replaced + anchor-
  missing raises), `discover_env` (get/getenv forms, unknown keys → None),
  bundle validation (traversal, missing main.py, size caps), requirements
  flatten+dedupe.
- **API**: convert guards (non-harness 400, inactive 400, in-flight 409),
  happy path with export subprocess mocked → 202, spec persisted with
  code_bundle+source_harness, deploy job kicked (pipeline mocked as in
  existing deployer tests), CLI-missing → clean 502-ish AppError.
- **Deployer**: `build_zip` packages bundle files (tmp pkg_dir assertion,
  follows existing zip tests' pattern).
- **Frontend**: lint/build; fetch-stub states (harness row action, disabled
  experiment options + hint); live evidence per A7.

## 4. Rollout / risks

- Additive spec fields; old rows unaffected. Rollback = revert.
- CLI version drift (0.21.x → 0.24) may change codegen anchors — the graft
  raises cleanly and the conversion fails with a readable error; fixture
  test pins expectations.
- `--only-binary` aarch64 deps: verified for the current export's dep set;
  a future export with an sdist-only dep fails at the pip step with the
  pipeline's normal failure reporting.
- Spec update at wrap-up: extend `evaluation-agent-eligibility.md`
  (conversion path) + new section or page for the conversion contract.
