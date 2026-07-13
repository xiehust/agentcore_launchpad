# Front-desk A2A demo: discovery routing sub-page + script

## Goal

A working, repeatable demo where a front-desk orchestrator agent discovers
specialists through Registry A2A cards, routes the user's question to the right
one, calls it (A2A JSON-RPC when the card says so, platform invoke otherwise),
and the UI narrates DISCOVER → SELECT → INVOKE → RESPOND — including the
governance story (reject/approve toggles availability).

## Requirements

R1. Front-desk agent (zip_runtime template or sample script deploy) with two
    tools backed by boto3 against the platform account:
    - `discover_agents(query)` → data-plane `search_registry_records`
      (APPROVED A2A records only) → cards
    - `call_agent(card, message)` → JSON-RPC message/send via
      InvokeAgentRuntime for `a2a-jsonrpc` transport; platform invoke fallback
      for `agentcore-http`
    Execution role gains the needed registry/invoke permissions.
R2. Demo sub-page (`/registry?view=a2a-demo` or similar): pick front-desk
    agent, ask a question, stage cards show the four phases with real
    payload excerpts (discovered cards, routing choice + why, request/response).
    Reuse the experiment StageCard narrative pattern.
R3. Governance script: reject a specialist's record → next question shows it
    absent from DISCOVER and an honest degraded answer; approve restores it.
    (REJECTED only — DEPRECATED is terminal.)
R4. Demo script doc (bilingual) with the 5-minute walkthrough.

## Constraints / dependencies

- DEPENDS ON `07-13-a2a-agent-create` (needs at least one real A2A-protocol
  specialist deployed — the live-proof agent from that task) and
  `07-13-a2a-registry-cards` (cards must carry transport + skills to route by).
  Do not start before both are merged.
- Specialists for the script: aurora-support (product/refunds, KB-backed) and
  hr-assistant (HR policy) — both already registered.

## Acceptance criteria

- [x] Product question routes to the aurora specialist; HR question routes to
      hr-assistant — shown live with real payloads in the sub-page.
- [x] At least one leg uses standard A2A JSON-RPC against an A2A-protocol
      runtime (not the platform-invoke fallback).
- [x] Reject/approve governance loop works within one query each way.
- [x] Bilingual UI + demo doc; backend tests for the discover/invoke endpoints
      or tools.

## Planning status

PRD-only for now; write design.md + implement.md when both dependencies are
merged (sub-page shape may change based on what the cards actually contain).

## Acceptance evidence (2026-07-13, live)

- `front-desk` agent deployed (64b838412ba848f08029746195ce5f36, runtime
  front_desk_198f76-vYUfDrEEFC) via deploy_frontdesk_agent.py; IAM inline
  policy launchpad-a2a-frontdesk added (SearchRegistryRecords, InvokeHarness).
- Product question → DISCOVER hits [aurora-support, aurora-faq-a2a,
  aurora-support-rt] → routed to aurora-support (InvokeHarness leg), real KB
  answer (30-day refund, MSA §7.2) with routing reason in trace.
- HR question → single hit hr-assistant → routed, honest no-record answer.
- Governance + A2A leg: REJECT aurora-support → discovery excludes it →
  routing flips to aurora-faq-a2a over **a2a-jsonrpc** with the JSON-RPC
  message/send envelope visible in the trace → APPROVE restored.
- UI sub-page (?view=a2a-demo) renders all four stage cards from the live
  trace (testids demo-discover/select/invoke/answer verified via browser).
- docs/a2a-demo.md bilingual walkthrough; 551 backend tests green.
- KEPT: front-desk agent (demo resource).
