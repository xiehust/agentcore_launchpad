# Execution plan — A2A agent creation

Validation command baseline (run before starting, after each step group):
`backend`: `.venv/bin/pytest tests/ -q` · `.venv/bin/ruff check app tests`
`frontend`: `npx tsc --noEmit` · `npm run -s lint`

## Step 0 — probe (throwaway, DO FIRST)  [rollback point: nothing merged]

- [x] boto3 `create_agent_runtime` with a trivial zip artifact +
      `protocolConfiguration={"serverProtocol": "A2A"}`; record accept/reject.
- [x] If accepted: fetch `/.well-known/agent-card.json` via SigV4 from a minimal
      A2AServer zip; record exact URL/header/session requirements.
- [x] If rejected: switch design to container path for A2A (Dockerfile variant
      of the template); update design.md before continuing.
- [x] `UpdateAgentRuntime` on the probe runtime — does protocolConfiguration
      persist / need re-sending? Record in research.
- [x] Delete probe resources.

## Step 1 — backend spec + deploy params

- [x] `AgentSpec.protocol` + `a2a_skills` + validator (422 matrix).
- [x] `create_code_runtime`/`update_code_runtime` accept protocol; wire
      `AGENTCORE_RUNTIME_URL` env per probe findings.
- [x] Unit tests: validator, param builders.

## Step 2 — A2A template + generate stage

- [x] `templates/strands_a2a_agent/` (main.py.tmpl + requirements.txt) per
      design; generate stage selects by protocol; skills rendered into card.
- [x] Unit test: generated code contains A2AServer/9000/serve_at_root; skills
      serialized; HTTP path output unchanged (snapshot guard).

## Step 3 — invoke branch + gating

- [x] `_a2a_text` parser + branch in `invoke_runtime_text`; fixtures for
      Message/Task/JSON-RPC-error shapes.
- [x] Experiment create guard + eval compatibility check (eval run scope calls
      the same invoke path — verify no other direct invokers bypass it:
      grep `invoke_agent_runtime(` callers).

## Step 4 — register stage + UI

- [x] `register_agent_record` passes protocol/skills (coordinate with sibling
      task if its builder change already landed; otherwise minimal local edit).
- [x] CreateAgent UI: protocol radio, skills editor, note card; agent
      list/detail protocol chip + card URL copy; experiment picker disabled
      state; i18n en/zh-CN.
      DEVIATION (check pass 2026-07-13): the "card URL copy" surface was NOT
      built — no card-URL/copy UI exists in the frontend. The resolvable card
      URL lives in the Registry record; surfacing it belongs to the sibling
      task's Registry drawer AGENT CARD panel (07-13-a2a-registry-cards).
      List chip ("zip_runtime · a2a") shipped as described.

## Step 5 — live proof + wrap

- [x] Create `aurora-faq-a2a` (or similar) through the UI; walk all acceptance
      criteria in prd.md; screenshots to `evidence/`.
- [x] Keep the agent (demo dependency); record in kept-resources memory.
- [x] Full-scope check (2.2), spec update (`.trellis/spec/launchpad/` new page
      `a2a-agents.md`), commit.

Review gates: after Step 0 (probe verdict may change design) and after Step 3
(before UI work) — post findings, wait for user confirmation if design shifted.
