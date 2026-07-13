# A2A end-to-end: creatable A2A agents, real registry cards, front-desk demo

Parent task — owns the source requirement set, the child map, cross-child
acceptance criteria, and the final integration review. No direct implementation
work; do not `task.py start` the parent.

## Source requirements (user, 2026-07-13)

1. 研究 Registry 里的 A2A，并设计 Demo 场景演示 A2A。
2. 除了 Demo 之外，增加产品功能：可以创建一个支持 A2A 的 Agent。

Research findings persisted at `research/a2a-registry-findings.md` (verified
live facts: current cards are descriptive-only — ARN url, empty skills; AWS
runtime natively supports serverProtocol A2A with JSON-RPC passthrough).

## Problem statement

The Registry's A2A tab is a wall of business cards nothing can actually call:
`url` is an ARN, `skills` is empty, and no deployed agent speaks the A2A
protocol. Discovery exists (semantic search, approval workflow) but the
communication half of A2A is missing. We want (a) a product path to CREATE
real A2A-protocol agents, (b) cards rich enough to route by, and (c) a demo
that shows discovery → routing → invocation → governance end to end.

## Child map

| Child | Deliverable | Depends on |
|---|---|---|
| `07-13-a2a-agent-create` | SERVICE PROTOCOL option (HTTP/A2A) on the Strands zip create path: A2A template, protocolConfiguration deploy, JSON-RPC invoke for chat/eval, real agent-card registration | — |
| `07-13-a2a-registry-cards` | AgentCard enrichment for ALL deploys (resolvable url, derived skills, transport metadata) + Registry drawer AGENT CARD panel | — (merge order with agent-create matters only in `build_a2a_card`) |
| `07-13-a2a-frontdesk-demo` | Front-desk orchestrator agent (registry discover + A2A invoke tools), DISCOVER→SELECT→INVOKE→RESPOND demo sub-page, governance script | both siblings |

Dependency notes live in each child's prd (tree position is not a dependency
system). Suggested execution order: agent-create → registry-cards → demo.

## Cross-child acceptance criteria (integration review)

- [ ] An A2A agent created through the UI appears in Registry with a card whose
      `url` resolves (well-known agent-card fetch succeeds via SigV4) and whose
      `skills` match what was configured at create time.
- [ ] Chat playground works against an A2A agent (JSON-RPC under the hood) with
      the same UX as HTTP agents.
- [ ] The front-desk demo discovers ONLY APPROVED records: rejecting a
      specialist's record removes it from routing within one query; re-approving
      restores it (governance loop uses REJECTED, never DEPRECATED — terminal).
- [ ] A2A agents are excluded from experiments with a reasoned disabled state
      (no config-bundle consumption), mirroring the harness gating pattern.
- [ ] Bilingual (en/zh-CN) for every new UI surface; backend tests green.

## Out of scope (parent-level)

- OAuth/Cognito inbound auth for A2A runtimes (SigV4 only; platform-mediated).
- A2A streaming responses in chat (sync message/send first; streaming later).
- Cross-account / external A2A agent registration.
- AGUI protocol (enum exists; not this effort).
