# Technical design — front-desk A2A demo

Probes done (2026-07-13): data-plane `search_registry_records` returns FULL
records incl. inline agent-card descriptors and `status` (no second GET
needed); semantic query "product questions refunds pricing" ranks
aurora-faq-a2a #1. Execution role has InvokeAgentRuntime but lacks
SearchRegistryRecords + InvokeHarness → deploy script ensures an inline
policy `launchpad-a2a-frontdesk`.

## Front-desk agent

zip_runtime + `code_bundle` (the harness-conversion multi-file channel), HTTP
protocol (it's a normal chat-able agent). main.py:

- strands Agent, tools `discover_agents(query)` + `call_agent(agent_name,
  message, reason)`; module-level `TRACE: list` reset per invocation; the
  entrypoint returns `{"result": text, "a2a_trace": TRACE}` (extra payload
  fields ride through InvokeAgentRuntime untouched).
- discover: search_registry_records(registryIds=[env LAUNCHPAD_REGISTRY_ID],
  query, maxResults=8) → keep descriptorType==A2A, status==APPROVED, name !=
  env FRONTDESK_NAME → parse `descriptors.a2a.agentCard.inlineContent` →
  [{name, description, skills, transport, url, method, arn?}]. Trace
  {stage: discover, query, hits}.
- call_agent: locate the hit from the last discover (fallback: fresh search
  by name). transport a2a-jsonrpc → InvokeAgentRuntime with JSON-RPC
  message/send (Task artifacts parsing — never history); agentcore-http +
  method harness → InvokeHarness; else InvokeAgentRuntime {prompt}. The ARN
  is recovered from the card url (unquote the /runtimes/{arn}/ segment) or
  card url itself when it's an ARN (harness). Trace {stage: invoke, target,
  transport, reason, request_excerpt, response_excerpt}.
- system prompt: always discover first; route by skills/descriptions; state
  which specialist answered; degrade honestly when discovery returns nothing.

## Backend

`POST /api/registry/a2a-demo` {agent_id, question} → validates active
zip_runtime agent → direct `invoke_agent_runtime` (NOT invoke_runtime_text —
we need the extra `a2a_trace` field) → {answer, trace, session_id,
latency_ms}. Errors → AppError envelope.

## UI

Registry page `?view=a2a-demo` sub-page (pattern: register/edit sub-pages):
agent select (agents whose name contains "front-desk" first), question input,
ASK button; four stage cards rendered from the trace — DISCOVER (query +
hits table w/ transport chip + skill chips), SELECT (per-invoke target +
model's stated reason), INVOKE (transport + request/response excerpts in code
blocks), RESPOND (answer). Governance note card explains the reject/approve
script. Entry button on the Registry list header. Bilingual.

## Rollout / rollback

Additive endpoint + sub-page + one sample script; revert commits to roll
back. The front-desk agent is a normal ledger agent (delete like any other).

## Test strategy

Backend: endpoint unit tests with a stubbed data client (happy path w/ trace
passthrough, agent-not-found 404, non-runtime 400). Front-desk code_bundle:
compile check + tool unit smoke via import in a test (pure-python parts:
card parsing, arn recovery). Live: the PRD's three-scenario walk.
