# Sync native Strands Studio canvas to upstream PR #31

## Goal

Bring the native canvas (`/create/studio`, shipped in task `07-11-strands-studio-canvas`) up to the upstream baseline after `xiehust/strands_studio_ui` PR #31 (merged 2026-07-11 05:52 UTC — hours after our port baseline `456a042` was cut). Full sync of the canvas/codegen surface including the new Skill node and sample gallery; canvas-created agents keep publishing through the launchpad pipeline unchanged in spirit (backend gains skills bundling).

## User decisions (2026-07-11)

- D1: Full Trellis planning before implementation.
- D2: Scope = full sync **including Skill node + sample gallery**; Skill picker sources launchpad's own AGENT_SKILLS registry (attachables), NOT upstream's studio skill-library backend.
- D3: Still excluded (upstream-backend-coupled): AI code generation, AI Fix, execution/chat panels, upstream deploy panels, api-client, upstream's own UI restyle (we keep our launchpad styling; port feature deltas only).

## Known upstream deltas (verified by diff 456a042..origin/main; details pending research/pr31-canvas-delta.md)

- Pure libs: code-generator.ts (~276 lines), graph-code-generator.ts (~113), connection-validator.ts (~28), NEW lib/models.ts (extracted model catalog); graph-validator.ts appears unchanged.
- `file_write` no longer present in upstream code-generator — our ported deviation may be obsolete (verify whether the UI option was dropped too).
- Skill node (`skill-node.tsx`) + AgentSkills codegen convention: generated code reads `STUDIO_SKILLS_DIR` env or `skills/` next to the deployed file; `from strands import AgentSkills`. Deployment must bundle skill files → launchpad `build_zip()` change required.
- Model catalog refresh: Sonnet 5 / Grok 4.3 / GPT-5.5 / gpt-5.4, custom model id, Bedrock (Mantle) provider via OpenAI Responses API, reasoning-effort scale (low..max), Claude adaptive thinking, Bedrock prompt caching controls (cacheMessages/cacheTools).
- Codegen bug fix aedebba (orchestrator construction when it has no MCP tools).
- Sample gallery: 8 preset flows under lib/sample-flows/ (pure data) with one-click load; one sample depends on a skill.

## Requirements

- R1: Re-sync the verbatim libs (`frontend/src/studio/lib/`) to origin/main: code-generator, graph-code-generator, connection-validator (+ new models.ts); keep graph-validator if unchanged. Re-evaluate the file_write deviation — drop it if upstream removed the option end-to-end, otherwise re-apply.
- R2: Add the Skill node to the native canvas (palette entry, node component, property panel section, connection rules) preserving upstream Handle ids/data keys. The skill picker lists launchpad AGENT_SKILLS records from `/api/registry/attachables` (APPROVED only), replacing upstream's studio skill-library backend.
- R3: Port property-panel feature deltas onto our restyled panel: new model catalog via lib/models.ts, custom model id, Mantle provider, reasoning-effort scale, adaptive thinking, prompt caching toggles — exact data-key parity with upstream so generators work.
- R4: Publishing a flow with skill nodes bundles the referenced skills into the deployment zip in the layout the generated code expects (`skills/...` next to main.py); launchpad backend sources skill content from the registry/S3. Runtime import `from strands import AgentSkills` must resolve in the zip's pip resolution (verify strands version; pin/bump if needed).
- R5: Port the sample gallery (8 preset flows, pure data) with one-click load into the canvas; the skill-dependent sample maps to a launchpad AGENT_SKILLS record (seed one if needed) or degrades gracefully.
- R6: Backward compatibility: existing saved `studio_flow` graphs (e.g. agent `studio-canvas-e2e`) still restore and generate valid code after the lib re-sync; re-publish still works. Any breaking generator changes are called out and shimmed.
- R7: i18n parity (en/zh-CN) for all new UI strings; launchpad styling only (no upstream restyle markup).
- R8: Update `docs/studio-integration.md` (§Native canvas) with the new baseline commit, skill bundling contract, and the file_write deviation status.

## Acceptance Criteria

- [x] AC1: Canvas offers the Skill node; connecting a launchpad registry skill to an agent generates the upstream AgentSkills code shape; publish succeeds and the deployed agent uses the skill (observable in chat behavior).
- [x] AC2: Property panel exposes the new model catalog (incl. custom model id + Mantle provider), reasoning-effort, adaptive thinking, and prompt caching controls; generated code matches upstream for the same node data.
- [x] AC3: Sample gallery loads each preset onto the canvas; at least one sample publishes end-to-end.
- [x] AC4: The pre-existing `studio-canvas-e2e` agent's flow still restores, generates valid code, and re-publishes after the sync.
- [x] AC5: `make verify` green; i18n parity holds; no regression in wizard/chat/eval pages.
- [x] AC6: docs/studio-integration.md reflects the new baseline and skill bundling contract.

## Out of scope

- AI code generation / AI Fix / execution & chat panels / deploy panels / api-client (D3).
- Re-vendoring `apps/studio/` to the new upstream (separate task if wanted — the standalone app keeps working as-is).

## Resolved facts (research/pr31-canvas-delta.md)

- SDK: launchpad's zip pin `strands-agents[otel]>=1.0,<2` resolves to 1.47.0, which exports `AgentSkills`, `CacheConfig`, `OpenAIResponsesModel` — no pin change needed. BUT `strands.models.openai{_responses}` do top-level `import openai` (ships only via the `[openai]` extra) → publish must add `strands-agents[openai]` for **both** OpenAI and Mantle providers; caching/thinking/skills need no extra.
- Skill zip layout: `skills/<skillName>/` (SKILL.md + any extra files) beside main.py; upstream extracts referenced names from generated code by regex; launchpad sources content from APPROVED AGENT_SKILLS records (`s3://{bucket}/skills/{name}/`, record name == prefix segment == skillName).
- `file_write` NOT obsolete (upstream UI still offers it, map still lacks it) and upstream additionally dropped `mem0_memory` from the map — decision (design §2): re-apply BOTH as launchpad deviations to avoid silent tool downgrades of saved graphs.
- graph-validator.ts unchanged; upstream markup is now `lp-*`-styled but still not copyable (we keep our studio.css classes; feature deltas only).
- API keys: generated code reads `OPENAI_API_KEY` / `BEDROCK_API_KEY` env — publish maps node apiKey → `spec.env` (backend env passthrough to the runtime verified/added in slice 3).

## Open questions

None blocking. Product calls recommended in design.md pending review-gate confirmation: (1) keep file_write+mem0_memory tool mappings as deviations; (2) sample gallery's missing-skill one-click drives register→submit→approve via existing registry endpoints.
