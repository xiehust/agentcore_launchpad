# A2A agent creation: protocol option through the unified pipeline

## Goal

A user can create an agent that speaks the standard A2A protocol from Agent
Management, with the same unified pipeline experience as every other method:
generate → package → provision → deploy → register. The result is a real A2A
server on AgentCore Runtime whose Registry card is resolvable and routable.

## Requirements

R1. **Protocol choice, not a new method.** The Strands zip CONFIGURE step gains
    a SERVICE PROTOCOL selector: `HTTP · standard invocations` (default) and
    `A2A · agent-to-agent JSON-RPC`. Existing agents are untouched (spec
    default `http`).

R2. **Agent-card skills at create time.** When A2A is selected, an AGENT CARD
    SKILLS editor appears (per-skill name/description/tags), prefilled from the
    selected template tools. These become the card's `skills` and the A2A
    server's advertised capabilities.

R3. **Real A2A server.** The generated code wraps the Strands agent in
    `strands.multiagent.a2a.A2AServer` (port 9000, serve_at_root, http_url from
    `AGENTCORE_RUNTIME_URL` env), keeps ADOT instrumentation, and deploys with
    `protocolConfiguration.serverProtocol = "A2A"`. Republish (UpdateAgentRuntime)
    preserves the protocol.

R4. **Chat/eval work unchanged from the user's seat.** `invoke_runtime_text`
    grows an A2A branch (JSON-RPC `message/send` in, Message/Task parsed out) so
    chat playground and evaluation runs treat A2A agents like any other agent.

R5. **Real registration.** The register stage writes a card whose `url` is the
    data-plane invocations URL and whose `skills` are the configured ones
    (cooperates with `07-13-a2a-registry-cards`, which owns the shared builder).

R6. **Experiments excluded with a reason.** A2A agents don't consume
    config-bundles → the experiment agent picker disables them with a hint,
    mirroring the harness pattern (`expPage.harnessDisabled` precedent).

R7. Bilingual UI (en/zh-CN); backend tests for spec validation, deploy params,
    invoke branch, and registration payload.

## Constraints

- SigV4 only for inbound auth (platform-mediated invocation); no Cognito.
- Sync `message/send` only; no A2A streaming in chat this task.
- zip-artifact + A2A protocol is UNVERIFIED (official tutorial uses containers).
  The first implementation step is a throwaway probe; if the service rejects
  zip+A2A, A2A routes through the container deploy path and the template ships
  as a Dockerfile variant instead — requirements above stay identical.

## Acceptance criteria

- [ ] Create flow: pick Strands zip → SERVICE PROTOCOL = A2A → configure skills
      → LAUNCH completes; agent row shows protocol; republish keeps A2A.
- [ ] `curl` (SigV4) of `…/runtimes/{arn}/invocations/.well-known/agent-card.json`
      returns the card with the configured skills (live proof).
- [ ] Chat playground round-trip against the A2A agent returns a clean text
      answer (no raw JSON-RPC visible to the user).
- [ ] An eval run against the A2A agent completes with scores.
- [ ] Experiment picker shows the A2A agent disabled with a bilingual reason.
- [ ] HTTP-protocol creates are byte-identical to before (regression guard).

## Depends on / coordinates with

- `07-13-a2a-registry-cards` owns `build_a2a_card` enrichment; this task feeds
  it `protocol` + `skills` from the spec. If this task lands first, it may stub
  the card fields and let the sibling generalize.
