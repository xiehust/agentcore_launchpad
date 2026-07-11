# Design: sync native canvas to upstream PR #31

Evidence: `research/pr31-canvas-delta.md` (all anchors there). Port base moves `456a042 → origin/main` (merge `69318ab`).

## 1. Sync strategy

Same doctrine as the original port: pure libs re-copied (near-verbatim, documented deviations), components extended in launchpad style (feature deltas only — upstream's own `lp-*` restyle markup is never copied). Backend gains one capability (skills bundling); schema unchanged.

## 2. Deviation policy for the verbatim libs (product decision)

Upstream's tool map drops `mem0_memory` (and never had launchpad's `file_write`), silently downgrading such tool nodes to `calculator`. To honor backward compat (prd R6) the launchpad copies re-apply BOTH mappings on top of the re-synced libs:

- `code-generator.ts`: keep `file_write` + `mem0_memory` in the static strands_tools import AND the tool map (graph-code-generator's trimmed map: add both only if trivially safe — its import line is separate).
- `STUDIO_EXTRA_REQUIREMENTS`'s `strands-agents-tools[mem0_memory]` stays meaningful and unchanged.
- Deviation set is now: {file_write, mem0_memory} — documented in docs/studio-integration.md §Porting invariants for future re-syncs.

Everything else lands as-is: skills codegen, CacheConfig/cache_tools, adaptive thinking (`{"type":"adaptive"}`, temperature pinned 1), Mantle via `OpenAIResponsesModel`, `minimal→low` coercion, `DEFAULT_MODEL_ID`, orchestrator-no-MCP NameError fix (aedebba). NEW `lib/models.ts` copied verbatim except `@/lib/models` → relative import.

## 3. Skill pipeline (the cross-layer piece)

```
Registry AGENT_SKILLS record (APPROVED)          canvas skill node {skillName, description}
  name == s3 prefix segment                        picker fed by GET /api/registry/attachables .skills[]
  s3://{bucket}/skills/{name}/SKILL.md   ──────▶   skillName == record name
                                                        │ codegen: plugins=[AgentSkills(skills=[os.path.join(_skills_dir,"<name>")])]
                                                        ▼
publish (unchanged spec shape) ──▶ _stage_package: regex generated code for
                                   os.path.join(_skills_dir, "<name>") refs (upstream-proven pattern)
                                   → resolve APPROVED record path → download s3 prefix
                                   → pkg_dir/skills/<name>/ → zip
runtime: STUDIO_SKILLS_DIR unset → Path(__file__).parent/"skills" resolves → AgentSkills loads SKILL.md
```

Decisions:
- **No schema change**: referenced skills are extracted from the generated `code` by regex in the package stage (`os\.path\.join\(\s*_skills_dir\s*,\s*"([a-z0-9-]+)"\s*\)`), exactly like upstream's `agentcore_deployment_service`. Works for any client (native canvas, apps/studio, raw API). `AgentSpec.skills` keeps its harness-only semantics untouched.
- Missing/unapproved skill at package time: log + skip (mirror upstream), never fail the deploy — the agent still runs, just without the skill dir; the canvas picker only offers APPROVED records so the normal path can't hit this.
- `adapt_studio_code` untouched (module kept verbatim; `_skills_dir` line survives).

## 4. Requirements & env at publish (CreateAgentStudio)

- `extraReqs`: add `strands-agents[openai]` when any node's `modelProvider` is `"OpenAI"` **or** `"Amazon Bedrock (Mantle)"` (both import `openai` top-level; the extra also pulls `aws-bedrock-token-generator` needed for Mantle auth). Caching/thinking/skills need no extra.
- **API keys → runtime env**: generated code reads `os.environ["OPENAI_API_KEY"]` / `os.environ.get("BEDROCK_API_KEY")`. Publish body maps node `apiKey` data → `spec.env.OPENAI_API_KEY` / `spec.env.BEDROCK_API_KEY` (first non-empty wins; warn in the publish drawer when a Mantle/OpenAI node has no key). Backend: verify the zip deploy passes `spec.env` into CreateAgentRuntime/UpdateAgentRuntime env (it already injects LAUNCHPAD_MEMORY_ID; extend to merge spec.env if not already done — check `zip_runtime.py:146-202` during implementation).
- Plaintext caveat: apiKey lives in node data → `studio_flow` → ledger spec, same exposure as upstream's localStorage; acceptable for this demo platform, noted in docs.

## 5. Frontend component deltas (launchpad-styled, feature-only)

- `nodes/skill-node.tsx` NEW: data `{label, skillName, description}`, single source Handle `id="skill-output"` Right; chip tone `mem` (distinct from tool); Sparkles icon. Export from `nodes/index.tsx`; register `skill` in FlowEditor `nodeTypes`; palette entry in Core; drop default `{label:'Skill', skillName:'', description:''}`.
- `FlowEditor.tsx`: agent drop default modelId → `DEFAULT_MODEL_ID` (+ modelName 'Claude Sonnet 4.6').
- `PropertyPanel.tsx`:
  - catalog from `lib/models.ts` (`BEDROCK_MODELS`, 15 entries — replaces the hardcoded 21-entry list; old ids in saved graphs become "custom" via `isCustomModel`, which renders the free-text input showing the stored id — old graphs stay editable);
  - provider select gains `Amazon Bedrock (Mantle)`; Mantle fields: region input (writes `{region, baseUrl: mantleBaseUrl(region)}`), Mantle model select + custom option, apiKey password field;
  - Bedrock custom-model-id option (`CUSTOM_MODEL_OPTION` sentinel writes `{modelId:'', modelName:CUSTOM_MODEL_NAME}` + free-text input);
  - thinking: drop the `thinkingBudgetTokens` input; Bedrock+thinking shows the adaptive note + temperature disabled/pinned-1; reasoning-effort select (low/medium/high/xhigh/max, `minimal` coerced) only for OpenAI/Mantle when thinking on;
  - caching checkboxes `cacheMessages`/`cacheTools` (Bedrock only);
  - skill node section: picker over `/api/registry/attachables` `.skills[]` ({name, description}); writes `{skillName, description}`; stale-selection warning when `skillName` not in the list; refresh button; "Manage in Registry" link → `/registry` (replaces upstream's ManageSkillsModal).
- `CodePanel.tsx` / monaco-theme: no change (upstream deltas are AI-codegen coupling we exclude).

## 6. Sample gallery

- Copy `lib/sample-flows/*` verbatim (pure data; `DEFAULT_MODEL_ID` import path fixed). 8 samples (6 basic, 2 advanced).
- New launchpad-styled gallery (drawer/modal from `CreateAgentStudio` toolbar "Samples" button): cards by level; load → confirm-if-canvas-nonempty → `setNodes/setEdges/setGraphMode`.
- `requiredSkills` check against attachables. Missing → card shows "register & approve skill" one-click that drives the EXISTING endpoints: `POST /api/registry/records` (AGENT_SKILLS manual registration with SKILL.md generated from the sample's `instructions`) → `POST /api/registry/records/{id}/action {submit}` → `{approve}` (console is platform-admin; mirrors Registry.tsx flows). On failure → toast + link to /registry. 409/name-exists tolerated (re-check attachables).

## 7. Backward compatibility (prd R6)

Verified non-breaking for saved graphs: additive skill rules; caching keys default false; `thinkingBudgetTokens` ignored (thinking shape changes to adaptive — behavior change but valid code); `minimal→low`; model-catalog shrink degrades to the custom-id input, not an error. With §2 deviations re-applied there is NO silent tool downgrade. AC4 re-verifies `studio-canvas-e2e` restore + regenerate + re-publish live.

## 8. Docs & registry of truth

`docs/studio-integration.md` §Native canvas updates: new baseline (origin/main merge `69318ab`), deviation set {file_write, mem0_memory}, skill bundling contract (regex + s3 prefix → zip `skills/<name>/`), env-key mapping, Mantle/OpenAI extra-requirements rule.

## 9. Risks

| Risk | Mitigation |
|---|---|
| PropertyPanel delta drift vs generators | data-key diff table (research §5) is the contract; check agent re-verifies |
| S3 download in package stage slows deploys | only for flows with skill refs; per-skill prefix is tiny (SKILL.md + few files); warn+skip on failure |
| spec.env not currently passed to runtime | verify early (slice 3 first task); if missing, additive merge in deploy stage for zip/studio path |
| Mantle e2e untestable (needs BEDROCK_API_KEY) | AC2 asserts generated-code parity, not a live Mantle call |
| Old saved graphs with removed catalog ids | isCustomModel degrades them to custom-id input (still valid codegen) — covered in AC4 |
