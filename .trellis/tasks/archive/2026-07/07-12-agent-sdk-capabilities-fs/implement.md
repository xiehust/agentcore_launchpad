# Implementation plan

Order minimizes broken intermediate states: schema → pure helpers → deployers → new
router → frontend → tests continuously → browser evidence last.

## Step 1 — Spec schema (backend)
- [ ] `backend/app/schemas/agent.py`: add `SessionStorageFs`, `ByoMount`, `VpcNetwork`,
      `FilesystemConfig` (+validators), `AgentSpec.filesystem` / `AgentSpec.network`
      (+cross-field validator: byo→network).
- [ ] New `backend/tests/test_agent_spec_filesystem.py`.
- Validate: `cd backend && .venv/bin/python -m pytest tests/test_agent_spec_filesystem.py -q`

## Step 2 — Template render (MCP merge, allowed_tools, skill names)
- [ ] `backend/app/templates/claude_sdk_agent/__init__.py`: `_mcp_servers(spec)` merge
      (free-text ∪ registry, registry wins), ALLOWED_TOOLS = Task + Skill(if skills) +
      `mcp__{k}` per merged server.
- [ ] Extend `backend/tests/test_claude_sdk_template.py`.
- Validate: `.venv/bin/python -m pytest tests/test_claude_sdk_template.py -q`

## Step 3 — Skill bundling for container builds
- [ ] `backend/app/deployer/zip_runtime.py`: `bundle_skill_paths_into(paths, dest_parent,
      log, *, s3_client=None)` (refactor shared loop with `bundle_skills_into`).
- [ ] `backend/app/deployer/container.py`: `_build_context(spec, agent, log)` helper used
      by `_stage_generate` + `_stage_package` fallback; calls the bundler into
      `context_dir/.claude/skills`.
- [ ] New `backend/tests/test_container_skill_bundle.py` (stub s3).
- Validate: `.venv/bin/python -m pytest tests/test_container_skill_bundle.py tests/test_zip_runtime*.py -q`

## Step 4 — Runtime wrappers + deploy stage + IAM provision
- [ ] `backend/app/services/agentcore/runtime.py`: `filesystem_configurations` + `vpc`
      kwargs on `create_container_runtime` / `update_container_runtime`.
- [ ] `backend/app/deployer/container.py`: `_filesystem_configurations(spec)`,
      `_vpc(spec)`, `_kwargs()` passes both; `_fs_policy_document(spec)`;
      `_stage_provision` put/delete inline policy (stubbable IAM client param);
      `delete_agent_resources` best-effort policy delete.
- [ ] New `backend/tests/test_runtime_container_fs.py` + `test_container_provision_iam.py`.
- Validate: `.venv/bin/python -m pytest tests/test_runtime_container_fs.py tests/test_container_provision_iam.py -q`
- **Review gate**: AWS param shapes vs botocore model (already verified: union members
  sessionStorage/s3FilesAccessPoint/efsAccessPoint; networkModeConfig subnets/securityGroups).

## Step 5 — Custom skill attach endpoint
- [ ] `backend/app/services/registry_console.py`: factor `upload_bundle_files(bundle,
      bucket, prefix, s3) -> list[str]` out of `register_skill_bundle` (no behavior change).
- [ ] `backend/app/routers/registry.py`: expose staging lookup + `_match_bundle` for reuse
      (module-level functions already importable — keep, just import from new router).
- [ ] New `backend/app/routers/agent_skills.py` (`POST /api/agent-skills/import`), mount
      in the FastAPI app (find `include_router` site in `backend/app/main.py`).
- [ ] New `backend/tests/test_agent_skills_attach.py`.
- Validate: `.venv/bin/python -m pytest tests/test_agent_skills_attach.py tests/test_registry_skill_ingest.py -q`
  (registry ingest suite must stay green — shared helpers refactored)

## Step 6 — Agents API round-trip
- [ ] Extend `backend/tests/test_agents_api.py`: container create with tools/skills/
      filesystem/network; 422 invalid filesystem; redeploy preserves fields.
- Validate: `.venv/bin/python -m pytest tests/test_agents_api.py -q`
- Full suite checkpoint: `.venv/bin/python -m pytest -q` (all backend tests green)
- **Rollback point**: backend self-contained & green; frontend untouched.

## Step 7 — Frontend
- [ ] `frontend/src/lib/api.ts`: `inspectSkillSource`, `attachSkillSource`, `StoredSpec`
      extensions.
- [ ] `frontend/src/pages/CreateAgent.tsx`: container MCP chips + shared skills picker,
      custom-source controls (zip/git), FILESYSTEM group, buildSpec/startEdit/resetForm/
      configValid updates.
- [ ] Locales: `frontend/src/locales/*/common.json` new keys (all languages present).
- Validate: `cd frontend && npm run lint && npm run build`

## Step 8 — Browser verification (Playwright, fetch-stubbed)
- [ ] `frontend/scripts/<evidence>.mjs` with `page.route` stubs; capture: container
      capabilities chips, custom zip + git attach, filesystem default, BYO→VPC reveal,
      invalid mount blocks launch, edit reload round-trip.
- [ ] Confirm vite port (5173/5174) before capture; use global Playwright import path.
- Validate: screenshots reviewed; note evidence paths in the journal.

## Step 9 — Wrap-up (Phase 3)
- [ ] Last-iteration full check: `pytest -q` (backend) + `npm run lint && npm run build`.
- [ ] Spec update: new/extended guide under `.trellis/spec/launchpad/` (container
      capabilities + filesystem contract; note the attach-without-record consumer in
      the registry-skill-ingestion guide).
- [ ] Journal + memory update; commit.

## Validation commands (canonical)
```bash
cd backend && .venv/bin/python -m pytest -q
cd frontend && npm run lint && npm run build
node frontend/scripts/<evidence>.mjs   # after confirming dev-server port
```

## Rollback
Single-commit revert per step boundary; no migrations; stored specs with new keys are
ignored by reverted code (pydantic default `extra` ignore — verified).
