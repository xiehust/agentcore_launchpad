# Implementation plan: PR #31 sync

Slices ordered so every step ends buildable; backend bundling before the frontend features that exercise it.

## Checklist

### Slice 1 — Pure libs re-sync (+ deviations)
- [ ] Copy from `/home/ubuntu/workspace/strands_ui` @ origin/main into `frontend/src/studio/lib/`: `code-generator.ts`, `graph-code-generator.ts`, `connection-validator.ts`, NEW `models.ts` (fix `@/lib/models` → `./models`). `graph-validator.ts` untouched (verified unchanged).
- [ ] Re-apply deviations on the fresh copies (design §2): `file_write` AND `mem0_memory` in code-generator's static strands_tools import + tool map; mirror in graph-code-generator only if its import/map structure allows the same two-line addition (it currently ships a trimmed 4-tool map — extend map+import consistently or leave trimmed; document choice).
- [ ] Grep-verify deviation set + zero other diffs vs upstream (`diff <(git -C /home/ubuntu/workspace/strands_ui show origin/main:src/lib/code-generator.ts) frontend/src/studio/lib/code-generator.ts` shows ONLY the deviation + import-path lines).
- [ ] Validate: `cd frontend && npx tsc --noEmit && npm run build` (PropertyPanel still compiles against new lib signatures — if generators' exported types changed, fix call sites minimally; full panel rework is slice 2).

### Slice 2 — Skill node + PropertyPanel feature deltas + palette/editor
- [ ] `nodes/skill-node.tsx` (new, launchpad style; Handle `skill-output` source Right; data {label, skillName, description}); export in `nodes/index.tsx`; `FlowEditor.tsx` nodeTypes + drop default; agent drop default → `DEFAULT_MODEL_ID`; `NodePalette.tsx` skill entry (Core, Sparkles).
- [ ] `PropertyPanel.tsx` deltas per design §5: BEDROCK_MODELS catalog + custom-model sentinel; Mantle provider + region/baseUrl/apiKey/model fields; adaptive-thinking note (drop budget input, pin temperature display); reasoning-effort low..max for OpenAI/Mantle; caching checkboxes; skill picker fed by `/api/registry/attachables` (reuse the existing fetch pattern from CreateAgent.tsx attachables; 60s-cached endpoint).
- [ ] i18n: `studio.*` additions en + zh-CN for all new labels.
- [ ] Validate: tsc + lint + build; parity spot-check: build a flow with caching+thinking+skill in dev, confirm generated code matches research §2 exact-Python sample.

### Slice 3 — Backend skills bundling + env passthrough
- [ ] FIRST verify `zip_runtime.py` deploy stage env handling: does CreateAgentRuntime/UpdateAgentRuntime receive `spec.env`? If not, merge `spec.env` into the runtime env for the zip path (additive).
- [ ] `zip_runtime.py` package stage: after writing main.py, regex the adapted code for `os\.path\.join\(\s*_skills_dir\s*,\s*"([a-z0-9-]+)"\s*\)`; for each unique name resolve the APPROVED AGENT_SKILLS record (via registry_console; name==s3 prefix segment), download every object under `s3://{bucket}/skills/{name}/` into `pkg_dir/skills/{name}/`; log `skills bundled: [...]` / warn+skip missing. Cap per-skill total size (mirror upstream's 50MB guard) to avoid runaway zips.
- [ ] Tests: `backend/tests/` — unit for the regex extractor (multi-skill, none, malicious name no-match) + a package-stage test with a stubbed S3/registry (follow existing test idioms in test_agents_api.py / harness tests).
- [ ] Validate: `cd backend && uv run ruff check . && uv run pytest -q`.

### Slice 4 — Publish body + sample gallery (CreateAgentStudio)
- [ ] `extraReqs`: OpenAI **or Mantle** provider → `strands-agents[openai]`.
- [ ] apiKey → env mapping: Mantle `apiKey` → `env.BEDROCK_API_KEY`, OpenAI `apiKey` → `env.OPENAI_API_KEY` (first non-empty; publish-drawer note when a Mantle/OpenAI node lacks a key).
- [ ] Sample gallery: copy `lib/sample-flows/*` (fix models import path); toolbar "Samples" button → launchpad-styled modal (cards, basic/advanced); load with confirm when canvas non-empty; `requiredSkills` check vs attachables; missing-skill one-click register→submit→approve chain via existing registry endpoints; failure → toast + /registry link.
- [ ] i18n for gallery + publish additions (en/zh-CN).
- [ ] Validate: tsc + lint + build + i18n parity.

### Slice 5 — Verify, docs, wrap
- [ ] `make verify` full gate.
- [ ] E2E (agent-browser, port 5173): (a) AC4 first — open `/create/studio?agent=<studio-canvas-e2e id>`, flow restores, generate, re-publish → active rev+1; (b) load `skilled-pirate-assistant` sample → register/approve `pirate-speak` skill via the one-click → publish `studio-skill-e2e` → active → chat answers in pirate speak (AC1/AC3); (c) property panel shows new catalog/Mantle/caching/reasoning controls; caching flow generates `CacheConfig` code (AC2 code-parity, no live Mantle call).
- [ ] Check zip content evidence: job log `skills bundled` + (optional) `aws s3 cp` the deployment zip and list `skills/pirate-speak/SKILL.md`.
- [ ] Update `docs/studio-integration.md` (design §8) + archived-task cross-link.
- [ ] Update prd ACs; commit slices; spec/journal wrap per Phase 3.

## Validation commands
- `cd frontend && npx tsc --noEmit && npm run lint && npm run build`
- `cd backend && uv run ruff check . && uv run pytest -q`
- `make verify`

## Risky files / rollback points
- `frontend/src/studio/lib/*` full re-copy — commit slice 1 alone (easy revert to 456a042-era libs).
- `frontend/src/studio/PropertyPanel.tsx` — biggest hand-merge; slice 2 commit.
- `backend/app/deployer/zip_runtime.py` — the only backend file; slice 3 commit.
- `frontend/src/pages/CreateAgentStudio.tsx` — slice 4 commit.

## Before task.py start
- [ ] User approved plan + the two product calls (keep file_write+mem0_memory mappings; skill one-click register→approve in gallery).
- [ ] implement.jsonl / check.jsonl curated.
