# Design: Native Strands Studio canvas in Agent management

Evidence base: `research/launchpad-agent-lifecycle.md` and `research/strands-studio-architecture.md` (file:line anchors live there; this doc only repeats anchors where load-bearing).

## 1. Architecture overview

```
CreateAgent (/create)                     CreateAgentStudio (/create/studio)
  method card "Strands Studio" ──Link──▶    ┌────────────────────────────────────┐
  AgentList Edit (method=studio) ─Link─▶    │ NodePalette │ FlowEditor │ Property │
        ?agent=<id>                         │  (left)     │  (canvas)  │ Panel    │
                                            ├────────────────────────────────────┤
                                            │ CodePanel (Monaco, read-only)       │
                                            │ Publish drawer → LaunchSequence     │
                                            └────────────────────────────────────┘
                                                       │ POST /api/agents {method:"studio",
                                                       │   code, requirements, studio_flow}
                                                       ▼
                                  existing pipeline: generate→package→provision→deploy→register
                                  (zip fast path; adapt_studio_code() wraps CLI script; UNCHANGED)
```

- **Port source**: `apps/studio/src/` (verified byte-identical to upstream clone HEAD `456a042` for all four generator/validator libs). The external `apps/studio` app stays untouched and continues to work standalone.
- **Backend reuse**: `method="studio"` is already in `SUPPORTED_METHODS`; `adapt_studio_code()` (backend/app/templates/studio_agent/__init__.py:80-94) wraps the canvas's CLI-style script into a `BedrockAgentCoreApp` entrypoint. Chat/Eval/Experiments/Observability already whitelist `studio` (evaluation/service.py:35, optimization/routers.py:67). **The only backend change is one additive spec field (§4).**

## 2. Frontend file layout (net-new unless noted)

```
frontend/src/studio/
  lib/code-generator.ts        COPY verbatim from apps/studio/src/lib/ (+ file_write fix, §6)
  lib/graph-code-generator.ts  COPY verbatim
  lib/graph-validator.ts       COPY verbatim
  lib/connection-validator.ts  COPY verbatim
  FlowEditor.tsx               ADAPT apps/studio/src/components/flow-editor.tsx
  NodePalette.tsx              ADAPT node-palette.tsx
  PropertyPanel.tsx            ADAPT property-panel.tsx (biggest: 1196L of forms)
  CodePanel.tsx                ADAPT code-panel.tsx (Monaco read-only + download + errors)
  nodes/*.tsx (8 + index)      ADAPT — restyle markup ONLY
  studio.css                   NEW — canvas-scoped styles (React Flow overrides, node cards)
frontend/src/pages/CreateAgentStudio.tsx   NEW — page/state owner (nodes/edges/graphMode),
                                           publish drawer, edit-mode loading, autosave
frontend/src/components/LaunchSequence.tsx EXTRACTED from CreateAgent.tsx:746-832 (shared)
```

Invariants when adapting (generators depend on them):
- Preserve every Handle `id` and node `data` key exactly (inventory table in research §4).
- Preserve drop-time defaults AND destructuring fallbacks so UI-displayed values match generator fallbacks.
- Keep `nodeTypes` map keys: agent, orchestrator-agent, swarm, tool, mcp-tool, input, output, custom-tool (`graph-builder` stays non-droppable; Graph Mode is a toolbar toggle).
- Keep `import '@xyflow/react/dist/style.css'` and the controlled-state pattern.

## 3. Styling strategy (OQ2 — recommended: restyle, no Tailwind)

- Rewrite Tailwind-utility markup onto launchpad's design system: `.panel`, `.btn/.btn.primary`, `.field`, `.input/.input.mono`, `.chip` tone variants, `.note`, `.code` (theme/app.css), plus a new `studio.css` for canvas-specific pieces (node cards, palette items, handles) built on tokens.css variables (`--panel`, `--ink`, `--amber`, `--s1..--s5`).
- React Flow chrome (Controls/MiniMap/Background) themed dark via its CSS variables in `studio.css`.
- Node color coding maps to launchpad chip tones: agent=amber, orchestrator=llm, swarm=blue, tool=tool, mcp=gw, custom-tool=aqua, input/output=muted.
- No Tailwind, no shadcn `ui/*`, no `cn()`/clsx, no react-syntax-highlighter (custom-tool preview uses a `.code` `<pre>`).
- Icons: add `lucide-react` (launchpad has no icon lib; icons are baked into node/palette UX).

Trade-off vs alternative (scoped Tailwind v4): Tailwind would be faster to port but risks preflight bleed into the global hand-written CSS, ships a light-theme look that clashes with the dark shell, and adds a permanent second styling system. Restyling is more hand-work (mostly PropertyPanel) but keeps one design language. → restyle.

## 4. Data contracts

### 4.1 Code generation (unchanged, pure frontend)
`generateStrandsAgentCode(nodes, edges, graphMode) → {code, imports, errors}`; file = `imports.join('\n') + '\n\n' + code`; `errors.length>0 ⇒ code=''` (blocks publish, rendered in CodePanel).

### 4.2 Publish request (existing endpoint, extended body)
`POST /api/agents` (or `POST /api/agents/{id}/redeploy` when editing) with:
```json
{
  "name": "<user input, ^[a-z][a-z0-9-]{2,47}$>",
  "method": "studio",
  "system_prompt": "<execution agent's systemPrompt, trimmed to 20000; fallback 'Strands Studio generated agent'>",
  "code": "<imports + code, max 200000 (enforce client-side too)>",
  "requirements": ["strands-agents[openai]"?],   // computed: only when a node uses modelProvider==='OpenAI'
  "memory": {"short_term": false, "long_term": false},
  "studio_flow": {"nodes": [...], "edges": [...], "graphMode": false}
}
```
- `system_prompt` doubles as the registry A2A card description (`registry_console.py:38`), so real prompt > placeholder.
- Requirements gap found in research: base reqs (strands-agents[otel], bedrock-agentcore, ADOT) + `strands-agents-tools[mem0_memory]` cover Bedrock+built-in tools+MCP (`mcp` is a strands-agents core dep); OpenAI provider needs `strands-agents[openai]` — computed client-side from nodes. (The external apps/studio never sends requirements; this is a strict improvement.)

### 4.3 Flow persistence for edit/re-publish (the one backend change)
- `AgentSpec` gains `studio_flow: dict | None = None` (backend/app/schemas/agent.py). Additive; stored inside the existing `Agent.spec` JSON column — no DB migration, old records unaffected, pipeline stages ignore it.
- Edit flow: CreateAgent AgentList "Edit" for `method==="studio"` navigates to `/create/studio?agent=<id>` instead of the wizard (also fixes a latent hazard: the wizard's `startEdit` would rebuild `spec` via `buildSpec()` which drops `code` — redeploying a studio agent from the wizard would deploy template code instead of canvas code).
- Canvas edit mode: `GET /api/agents/{id}` → `spec.studio_flow` → restore nodes/edges/graphMode; publish button becomes re-publish (`redeployAgent`, name/method immutable per routers/agents.py:139-179).
- Studio agents WITHOUT `studio_flow` (created by the external app before this feature): canvas opens with an empty graph + a notice toast; CodePanel shows `spec.code` read-only; re-publish disabled until the user builds a flow (first re-publish then attaches `studio_flow`).

### 4.4 Frontend typed client
Extend `AgentSpecInput` (frontend/src/lib/api.ts:54-62) with `code?`, `requirements?`, `env?`, `studio_flow?`. `api.createAgent`/`redeployAgent` signatures unchanged otherwise.

## 5. Page behavior (CreateAgentStudio)

- **Layout**: full-height page under Shell. ViewHead + toolbar (Graph Mode toggle, Generate Code, Publish, back-to-create link). Three columns: NodePalette / FlowEditor / PropertyPanel (selected node). CodePanel as a bottom drawer toggled by Generate Code.
- **State**: page owns `nodes/edges/graphMode` (controlled FlowEditor, same as upstream main-layout). Selection state drives PropertyPanel.
- **Autosave**: debounced (500ms) draft to localStorage key `launchpad_studio_draft` (new-agent mode only; edit mode loads from spec and does not autosave over the draft). "New" clears the draft.
- **Publish UX**: Publish → validates generation result (errors block) → drawer with name input (regex-validated), generated-code summary, requirements preview → POST → embedded LaunchSequence (extracted component) polls `api.getAgent`+`api.getJob` every 2s until active/failed (same UX as wizard step 3) → success links to `/chat?agent=<id>`.
- **Invalid connection feedback**: replace upstream `alert()` with `useToast` (flow-editor.tsx:147).
- **Method card**: the existing studio card/link in CreateAgent.tsx:300-318 becomes an internal `<Link to="/create/studio">`; `VITE_STUDIO_URL` external link removed from the card (env var may remain for the standalone app's own use).
- **Model catalog**: port `bedrockModels[]` (property-panel.tsx:55-136) and prepend launchpad's default `global.anthropic.claude-sonnet-4-6` so the platform default is selectable.

## 6. Deliberate deviations from upstream (documented bug fixes)

1. `file_write` built-in: selectable in UI but unmapped in the generator (silently becomes `calculator`). Fix: add `file_write` to the tool map AND the static `strands_tools` import list in the copied `code-generator.ts` (graph generator's smaller map: add there too or exclude file_write in Graph Mode palette hints).
2. `alert()` on invalid connection → launchpad toast.
3. OpenAI-provider requirements computed and sent (upstream sends none).

## 7. i18n

- New `studio.*` namespace in `frontend/src/locales/{en,zh-CN}/common.json` (parity required — the vendored-app exemption does not apply to a native page).
- Scope: page chrome, palette entries/categories, publish drawer, LaunchSequence labels, property-panel section titles and field labels, validation/toast messages. Enum option values (model IDs, transport types, format names) stay as-is.

## 8. Compatibility & rollout

- Purely additive: new route + one optional spec field. No existing agent record changes shape; old studio agents keep working (§4.3 fallback).
- `apps/studio` standalone app untouched; can be deprecated later once the native canvas proves out (not in this task).
- New frontend deps: `@xyflow/react@^12`, `@monaco-editor/react@^4` (Monaco loads via its default CDN loader, same as the in-repo apps/studio already does), `lucide-react`. All React-18 compatible (peer-checked in research §7). No React/Vite upgrades.
- Rollback: revert the commits. The only data written by the feature is `spec.studio_flow` on agents published from the canvas; old code ignores unknown spec keys (`AgentSpec` is reconstructed via `AgentSpec(**agent.spec)` — pydantic would reject unknown keys on old code, BUT the field ships in the same commit as any data that could contain it, and reverting only disables re-edit of canvas agents, whose deployed runtimes keep running).

## 9. Risks

| Risk | Mitigation |
|---|---|
| PropertyPanel restyle (1196L) introduces field/data-key drift | Port field-by-field against the node `data` inventory table (research §4); AC5 round-trip test |
| React Flow dark theming looks off | studio.css themes RF vars; visual check via agent-browser screenshots |
| Generated code fails at runtime in AgentCore (env differences, e.g. stdio MCP commands not present in runtime image) | Out of scope for canvas correctness; same behavior as external studio today. AC3 chat test covers the happy path (Bedrock model + built-in tool) |
| `spec.code` 200k limit exceeded by huge flows | Client-side size check before publish with a clear error |
| pydantic rejects `studio_flow` on rollback (old backend + new data) | Acceptable: only blocks re-edit/redeploy of canvas agents after a revert; documented in §8 |
