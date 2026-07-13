# Execution plan — front-desk A2A demo

## Step 0 — probes  [DONE 2026-07-13]
- [x] search_registry_records returns full records + descriptors + status
- [x] execution role: has InvokeAgentRuntime; lacks SearchRegistryRecords /
      InvokeHarness → inline policy needed

## Step 1 — front-desk agent + deploy script
- [x] `backend/samples/frontdesk_agent/main.py` (code_bundle source; pure
      helpers importable for tests)
- [x] `backend/scripts/deploy_frontdesk_agent.py`: ensure IAM inline policy
      `launchpad-a2a-frontdesk` (SearchRegistryRecords on the registry arn,
      InvokeHarness on harness resources), build spec (code_bundle + env
      LAUNCHPAD_REGISTRY_ID/FRONTDESK_NAME), create via agents service, wait
      active
- [x] Deploy live; chat smoke ("Aurora Deck refund policy?") shows routed
      answer

## Step 2 — backend endpoint
- [x] POST /api/registry/a2a-demo + tests (trace passthrough, 404/400)

## Step 3 — UI sub-page
- [x] `?view=a2a-demo` stage cards + list-header entry + i18n en/zh-CN
- [x] tsc/lint green

## Step 4 — live acceptance + wrap
- [x] Product question → aurora-faq-a2a via a2a-jsonrpc (REAL A2A leg)
- [x] HR question → hr-assistant via InvokeHarness fallback
- [x] Governance: reject aurora-faq-a2a record → discovery misses it →
      degraded answer; approve → restored
- [x] `docs/a2a-demo.md` bilingual script; spec update; evidence; commit;
      archive; merge decision with user
