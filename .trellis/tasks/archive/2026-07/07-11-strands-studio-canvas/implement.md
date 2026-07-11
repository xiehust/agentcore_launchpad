# Implementation plan: native Strands Studio canvas

Order matters: backend field first (unblocks the publish contract), then pure libs, then UI bottom-up, then wiring, then i18n, then end-to-end verification. Each step ends buildable.

## Checklist

### Step 1 — Backend spec field + typed client (small, unblocks everything)
- [ ] `backend/app/schemas/agent.py`: add `studio_flow: dict | None = None` to `AgentSpec` (after `code`).
- [ ] `frontend/src/lib/api.ts`: extend `AgentSpecInput` with `code?: string`, `requirements?: string[]`, `env?: Record<string,string>`, `studio_flow?: { nodes: unknown[]; edges: unknown[]; graphMode: boolean }`.
- [ ] Validate: `cd backend && uv run ruff check . && uv run pytest -q`; POST a studio agent with `studio_flow` via curl against a dev backend and confirm `GET /api/agents/{id}` echoes it in `spec`.

### Step 2 — Frontend deps
- [ ] `cd frontend && npm i @xyflow/react @monaco-editor/react lucide-react`.
- [ ] Validate: `npm run build` still green.

### Step 3 — Copy pure generator libs
- [ ] Copy verbatim from `apps/studio/src/lib/` → `frontend/src/studio/lib/`: `code-generator.ts`, `graph-code-generator.ts`, `graph-validator.ts`, `connection-validator.ts`.
- [ ] Apply documented deviation: add `file_write` to the built-in tool map (`code-generator.ts:443-453`) and to the static `strands_tools` import line (`code-generator.ts:30-38`); mirror in `graph-code-generator.ts:113-119` map.
- [ ] Validate: `npx tsc --noEmit` (frontend); spot-generate: temporary vitest-less sanity — import `generateStrandsAgentCode` in a scratch page or node script and check a 4-node flow yields non-empty code (delete scratch after).

### Step 4 — Node components (restyle only)
- [ ] Port `apps/studio/src/components/nodes/{agent,orchestrator-agent,swarm,tool,custom-tool,mcp-tool,input,output}-node.tsx` + `index.tsx` → `frontend/src/studio/nodes/`, replacing Tailwind markup with launchpad classes + `studio.css` node-card styles. PRESERVE: every Handle `id`, every `data` key, every destructuring fallback default (inventory: research/strands-studio-architecture.md §4). custom-tool preview: `.code` `<pre>` instead of react-syntax-highlighter.
- [ ] Create `frontend/src/studio/studio.css` (node cards, palette, RF dark-theme variable overrides) using `theme/tokens.css` variables.

### Step 5 — FlowEditor, NodePalette, PropertyPanel, CodePanel
- [ ] `FlowEditor.tsx`: keep controlled-state pattern, `nodeTypes` map (8 types), drag-drop defaults, `isValidConnection` wiring, `@xyflow/react/dist/style.css` import; swap `alert()` → `useToast`.
- [ ] `NodePalette.tsx`: keep `dataTransfer` type `application/reactflow` + categories; restyle; lucide icons.
- [ ] `PropertyPanel.tsx`: restyle field-by-field against the data-key inventory; port `bedrockModels[]` and prepend `global.anthropic.claude-sonnet-4-6`; drop the dead `file_write`-less assumptions (file_write now valid).
- [ ] `CodePanel.tsx`: Monaco (`vs-dark`, read-only) + errors list + download `strands_agent.py`; keep `imports.join('\n') + '\n\n' + code` assembly.
- [ ] Validate: `npx tsc --noEmit && npm run build`.

### Step 6 — Page, route, wiring
- [ ] Extract `LaunchSequence` from `pages/CreateAgent.tsx:746-832` → `components/LaunchSequence.tsx`; CreateAgent imports it (no behavior change — verify wizard step 3 still renders).
- [ ] New `pages/CreateAgentStudio.tsx`: 3-column layout + toolbar (Graph Mode toggle, Generate Code, Publish, back link); owns nodes/edges/graphMode/selection; localStorage draft autosave (new mode only, key `launchpad_studio_draft`); publish drawer (name regex `^[a-z][a-z0-9-]{2,47}$`, code-size ≤200000 check, computed `requirements` — `strands-agents[openai]` iff any node `modelProvider==='OpenAI'`, system_prompt from execution agent); POST via `api.createAgent` / `api.redeployAgent`; embedded LaunchSequence polling; success → `/chat?agent=<id>` link.
- [ ] Edit mode: read `?agent=<id>`, load `spec.studio_flow` (restore) else empty-canvas notice + read-only `spec.code` in CodePanel + publish disabled until a flow exists.
- [ ] `App.tsx`: add route `/create/studio`.
- [ ] `CreateAgent.tsx`: studio card link (lines ~300-318) → internal `<Link to="/create/studio">`; AgentList Edit for `method==="studio"` → navigate `/create/studio?agent=<id>` (wizard editing of studio agents was a latent code-loss hazard — design §4.3).
- [ ] Validate: `npm run build`; manual dev-server smoke.

### Step 7 — i18n
- [ ] Add `studio.*` keys to `frontend/src/locales/en/common.json` AND `frontend/src/locales/zh-CN/common.json` (parity): page chrome, palette, property-panel sections/labels, publish drawer, toasts, LaunchSequence reuse of `create.stages.*`.
- [ ] Validate: language toggle in dev; no missing-key console warnings.

### Step 8 — Full verification (last-iteration full-scope check)
- [ ] `make verify` (ruff + pytest + frontend lint/build sections) green.
- [ ] E2E via agent-browser (dev servers: `make dev`; NOTE vite port floats 5173/5174 — confirm before capturing evidence):
  1. `/create` → studio card → canvas renders (AC1).
  2. Drag input + agent + tool(calculator) + output; connect; Generate Code shows valid Python incl. `file_write` absent unless used (AC1).
  3. Publish as `studio-canvas-e2e` → LaunchSequence completes → agent active (AC2); registry record appears (A2A, PENDING_APPROVAL per auto-submit).
  4. `/chat?agent=<id>` → send message → streamed/complete response (AC3).
  5. Evaluation page: agent selectable; run one evaluation (AC4).
  6. Back to `/create` → Edit the agent → canvas restores flow → tweak systemPrompt → re-publish → active, revision+1 (AC5).
  7. Existing pages regression: wizard create step 3 (LaunchSequence extraction), Chat, Evaluation dashboards load (AC6).
- [ ] Screenshot evidence for canvas render, generated code, chat response.

## Validation commands
- `cd backend && uv run ruff check . && uv run pytest -q`
- `cd frontend && npx tsc --noEmit && npm run lint && npm run build`
- `make verify` (canonical gate)

## Risky files / rollback points
- `frontend/src/pages/CreateAgent.tsx` — LaunchSequence extraction + edit routing + card link. Riskiest existing-file change; do it in its own commit (rollback point).
- `frontend/src/lib/api.ts` — additive types only.
- `backend/app/schemas/agent.py` — additive field; ships in the same commit as Step 1 (rollback caveat: design §8).
- All `frontend/src/studio/**` files are net-new (safe to revert wholesale).
- Suggested commit slices: (1) backend field + api types; (2) studio libs + nodes + panels (builds but unrouted); (3) page + route + CreateAgent wiring + LaunchSequence extraction; (4) i18n + polish + e2e fixes.

## Before task.py start
- [ ] User has approved styling strategy (restyle to launchpad classes, no Tailwind — design §3) and the overall plan.
- [ ] implement.jsonl / check.jsonl curated with research + spec entries (done alongside this plan).
