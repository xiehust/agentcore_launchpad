# Registry A2A cards: enrich + visualize

## Goal

Every deployed agent's A2A record carries a card another agent (or human) can
actually act on; the Registry UI renders it as a first-class AGENT CARD panel
instead of a raw descriptor excerpt.

## Requirements

R1. `build_a2a_card` (backend/app/services/agentcore/registry.py) enrichment,
    applied on every deploy/republish register stage:
    - `url` = data-plane invocations URL
      (`https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{urlencode(arn)}/invocations/`)
      — resolvable for A2A-protocol agents; still informative for HTTP agents.
    - `skills` derived from spec: explicit `a2a_skills` if present (sibling
      task), else tools/skills/knowledge_bases → [{id, name, description, tags}].
    - `metadata.launchpad.transport`: `a2a-jsonrpc` | `agentcore-http` so
      consumers know whether standard A2A calls apply.
R2. Existing records refresh on next deploy/republish (no mass backfill job in
    scope; optional `scripts/` one-shot refresher is a nice-to-have).
R3. Registry drawer: A2A records get an AGENT CARD panel — parsed inlineContent
    rendered as: transport chip, invoke URL with copy button, skills chips with
    descriptions, capabilities row, raw-JSON expander. Bilingual labels.
R4. Unit tests for the card builder (both transports, skills derivation
    fallbacks); drawer renders from a fixture record.

## Constraints

- A2A records remain deploy-managed (no console editing added).
- Card schema stays at 0.3.0; only content enrichment.

## Acceptance criteria

- [x] Redeploying any existing agent produces a card with resolvable-format url,
      non-empty derived skills (when the spec has any tools/skills/KBs), and a
      transport tag.
- [x] Drawer shows the AGENT CARD panel for A2A records (live screenshot) and
      unchanged behavior for MCP/AGENT_SKILLS records.
- [x] Backend tests green; en/zh-CN keys present.

## Depends on / coordinates with

- `07-13-a2a-agent-create` supplies `protocol`/`a2a_skills` in specs; this task
  must not break when those fields are absent (all current agents).

## Execution sketch (lightweight task — PRD-level checklist)

1. Card builder enrichment + unit tests.
2. Drawer AGENT CARD panel + i18n.
3. Redeploy one live agent; screenshot; spec update (registry spec page).

## Acceptance evidence (2026-07-13, live)

- `derive_card_skills`: aurora-support → aurora-deck-docs (KB description as
  routing signal), hr-assistant → hr-database, zip template agents →
  calculator/current-time, code-defined agents → [] (3 unit tests).
- `scripts/refresh_a2a_cards.py` ran against the real registry (12 active
  agents). LIVE FINDING: UpdateRegistryRecord resets status to DRAFT after
  the async UPDATING settles — script now settles + re-submits + restores
  APPROVED. Statuses repaired after the discovery run: demo set
  (aurora-support, hr-assistant, aurora-support-rt, aurora-faq-a2a) APPROVED,
  others PENDING_APPROVAL, DEPRECATED untouched.
- Drawer AGENT CARD panel verified on 5175: harness record (agentcore-http
  chip, ARN endpoint, KB skill w/ description), A2A record (a2a-jsonrpc chip,
  real invocations URL + copy button, 2 skills w/ tags); MCP record shows no
  panel. i18n en/zh-CN keys present; 546 backend tests green.
