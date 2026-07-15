# Journal - river (Part 1)

> AI development session journal
> Started: 2026-07-11

---



## Session 1: Native Strands Studio canvas in Agent management

**Date**: 2026-07-11
**Task**: Native Strands Studio canvas in Agent management
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Ported the strands_studio_ui canvas natively into the platform: /create/studio page (React Flow editor, 8 node types, property panel, Monaco code preview) restyled onto launchpad tokens with full en/zh-CN i18n; publish rides the existing studio zip pipeline with new additive AgentSpec.studio_flow for edit/re-publish; Edit for studio agents now routes to the canvas (wizard path dropped code); LaunchSequence extracted as shared component. E2E-verified live: studio-canvas-e2e built on canvas, published active, chatted, eval run 0.83, re-published rev2 same ARN. Contract codified in docs/studio-integration.md.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `8e3a92b` | (see git log) |
| `4c927d5` | (see git log) |
| `856cfbd` | (see git log) |
| `1c12403` | (see git log) |
| `80f2e3d` | (see git log) |
| `96466e0` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: Sync native Strands Studio canvas to upstream PR #31

**Date**: 2026-07-11
**Task**: Sync native Strands Studio canvas to upstream PR #31
**Package**: lab4-interactive
**Branch**: `main`

### Summary

User caught the canvas being one baseline behind upstream (PR#31 merged the same morning as the original port). Synced: generators re-copied to merge 69318ab with deviation set now {file_write, mem0_memory}; skill node whose picker reads launchpad AGENT_SKILLS attachables; backend build_zip bundles regex-referenced skills from S3 into zip skills/<name>/ (no schema change); Mantle provider + custom model id + adaptive thinking + prompt caching in the panel; 8-sample gallery with one-click register→submit→approve for missing skills (fixed the 60s attachables cache making fresh approvals invisible). E2E live: pirate-speak skill registered from gallery, studio-skill-e2e published with 'skills bundled' evidence and chats in pirate speak; old studio-canvas-e2e re-published rev3 under the new generators (backward compat).

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c06c022` | (see git log) |
| `79e0977` | (see git log) |
| `6067779` | (see git log) |
| `470c8d6` | (see git log) |
| `610b45a` | (see git log) |
| `12f642a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Studio local debug + AI fix, caching triad, effort tiers, defaults

**Date**: 2026-07-11
**Task**: Studio local debug + AI fix, caching triad, effort tiers, defaults
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Four asks: aws-knowledge MCP sample (live-verified public server); system-prompt cache completing the caching triad (cache_prompt, probed silent-noop under 1k tokens); Bedrock reasoning-effort tiers via the live-probed output_config.effort shape with per-model xhigh gating + Nova max_tokens clamps; streaming-on/32k defaults. Ported upstream PR#31 local debug: dedicated exec venv runs /api/execute[/stream] + /api/conversations* (messages replay, failed-turn pairing, CHAT_ERROR sentinel) with registry skills bundled into workdirs; AI Fix via claude-agent-sdk over Bedrock (diagnosis categories, env-revert guard, repair loop, revert-on-failed-validation); CodeState template|ai+flowStale lifted into CreateAgentStudio. E2E live: MCP sample answered S3 limits locally, 3-cache run, multi-turn context, full AI Fix loop (bogus model -> config diagnosis -> patched -> rerun OK -> regenerate discards), old agent rev4 re-publish. Two e2e-caught bugs fixed: chat session effect self-cancelling via its own deps; drawer unmount stream leak.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ef68b20` | (see git log) |
| `ca4bbd3` | (see git log) |
| `f2fe07f` | (see git log) |
| `8385c6e` | (see git log) |
| `9326372` | (see git log) |
| `748ea9f` | (see git log) |
| `ee4f07a` | (see git log) |
| `b82cf15` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: Registry skill multi-source ingestion (zip/git/url + reimport)

**Date**: 2026-07-11
**Task**: Registry skill multi-source ingestion (zip/git/url + reimport)
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Registry /registry skill registration extended from inline-only to four sources converging on one SkillBundle pipeline (skill_ingest.py): P0 zip upload via inspect->import staging (TTL 10min, kept on failure for retry) with multi-file S3 bundles + real definition.files + source provenance, fixing the hardcoded files list and the 200k>AWS-102400 cap; P1 git import (https-only shallow clone, token redaction incl URL-embedded creds, monorepo SKILL.md discovery w/ multi-select batch import) plus git env detection: capabilities + explicit git-install endpoints and github/gitlab/gitee/bitbucket archive-zip fallback when git is missing (repo-scale extraction caps — live bug found against anthropics/skills); P2 url source (zip-vs-raw-md detection) + reimport-from-source (delete-old-prefix-then-upload, recordVersion minor bump, name preserved, git/url only). Check agents found+fixed: descriptor>100KB pre-upload guard, SSRF guard (public-addr check on every redirect hop, extended to git clone), reimport rollback stranding a live record over an empty prefix. Live-verified: AC1 zip e2e, AC3 anthropics/skills 18-skill scan + batch import, AC7 raw-md/zip URLs, AC9 git-missing fallback, reimport 1.0.0->1.1.0, AC2 real packager pulled full prefix. Backend 337 pytest + ruff clean; frontend tsc/lint/build clean. Spec: .trellis/spec/launchpad/registry-skill-ingestion.md (new layer).

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `2b7f47f` | (see git log) |
| `2d39ca3` | (see git log) |
| `cbbb8e6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: Registry register/edit standalone sub-pages + record update endpoint

**Date**: 2026-07-12
**Task**: Registry register/edit standalone sub-pages + record update endpoint
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Registry /registry register drawer replaced by an Evaluation-style ?view=register sub-page (RegisterView.tsx: ViewHead + back + eval-grid form/how-it-works panels; browser-back returns to list; record-type preselects from active tab via initialType) and a NEW record-edit capability: ?view=edit&record=<id> (EditView.tsx) backed by PUT /api/registry/records/{id} with four branches — desc-only (descriptors resent unchanged, NO version bump), MCP url rebuild, skill_md overwrite of ONLY skills/{name}/SKILL.md (supporting files + definition files/source preserved, legacy records without files/source safe), and zip full-replace via the existing inspect staging (paginated prefix clear, name always forced to record name — name immutable). Gating: A2A + DEPRECATED not editable (400 registry.not_editable, no edit button). Check agent closed 3 test gaps (legacy definition fallback, unparseable definition, staging index OOR). All ACs live browser-verified: desc edit kept 1.0.0, SKILL.md edit bumped 1.1.0 with S3 sibling untouched, zip replace 1.2.0 with prefix swap, MCP url /v1->/v2, no edit entry on A2A/DISABLED. Backend 362 pytest + ruff clean; frontend tsc/lint/build clean. Spec §8 added to registry-skill-ingestion.md. Gotcha recorded: LIST endpoint returns descriptors:null — EditView must GET by id.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `67d7348` | (see git log) |
| `a2d6be2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: Pre-validate skill frontmatter description (AWS 1024-char cap)

**Date**: 2026-07-12
**Task**: Pre-validate skill frontmatter description (AWS 1024-char cap)
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Follow-up to the anthropics/skills load test: bundle_errors now enforces SKILL_DESCRIPTION_MAX_CHARS=1024 (AWS parses skillMd frontmatter at CreateRegistryRecord and rejects >1024-char descriptions post-upload). Oversized skills now fail at inspect — 422 for single-bundle, invalid non-selectable row in git multi-select — with zero S3 writes. Live-verified on claude-api (1068 chars): 422 with precise message, 0 S3 objects. Boundary tests 1024/1025. 364 pytest + ruff clean. Spec AWS-facts note updated from 'known gap' to 'pre-validated'.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `f8f217e` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: Gate USE IN NEW AGENT on APPROVED status

**Date**: 2026-07-12
**Task**: Gate USE IN NEW AGENT on APPROVED status
**Package**: lab4-interactive
**Branch**: `main`

### Summary

User-reported: Registry detail's USE IN NEW AGENT was clickable for unpublished records, but the wizard attachables catalog is APPROVED-only so the prefill silently no-oped. Button now visible-but-disabled with an approval-gate tooltip when status != APPROVED (data-testid use-in-wizard-btn). Cleaned stale registry.register.comingSoonBody key (i18n unused-key report now clean; remaining strict failures are pre-existing vendored studio hardcoded strings). Live-verified both states: docx DRAFT disabled+tooltip, product-selection-sop APPROVED navigates to /create?skill=s3://...

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `5893cf1` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete

---

## 2026-07-12 — Agent SDK create: registry capabilities + custom skill sources + filesystem config

**Date**: 2026-07-12
**Task**: 07-12-agent-sdk-capabilities-fs
**Package**: launchpad (backend + frontend)
**Branch**: `main`

### Summary

Claude Agent SDK (container) create flow now consumes the Registry: APPROVED
remote MCP records and AGENT_SKILLS render as selectable chips (was: two
hardcoded chips; skills were harness-only). Selected MCP servers merge into the
rendered MCP_SERVERS (registry wins over free-text JSON) with proper
`mcp__{server}` allow-list entries; selected skills are downloaded at build time
into the image's `.claude/skills/{name}/`. Added attach-without-record custom
skill sources (`POST /api/agent-skills/import` consuming the registry inspect
staging; zip auto-attach, git monorepo picker with ONE batched attach call) —
uploads to `agent-skills/{uid8}/{name}/`, no registry record. Added AgentCore
filesystemConfigurations to the container config: managed session storage
default-ON at /mnt/workspace (disable-able), up to 2 BYO S3 Files + 2 EFS
access-point mounts; BYO flips networkMode PUBLIC→VPC (subnets/SGs required,
enforced by AgentSpec model_validator) and the provision stage syncs an inline
execution-role policy `launchpad-fs-{agent}` (deleted on mounts-removed and
agent delete). Verified botocore 1.43.44 union shapes; system python lacks BYO
members — venv only.

### Main Changes

- backend: schemas/agent.py (FilesystemConfig/VpcNetwork/validators),
  runtime.py (fs+vpc kwargs), deployer/container.py (_build_context skills
  bundling, _filesystem_configurations/_vpc/_fs_policy_document/_sync_fs_policy),
  zip_runtime.py (bundle_skill_paths_into refactor), routers/agent_skills.py
  (new), registry_console.upload_bundle_files (factored, incremental keys),
  main.py mount.
- frontend: CreateAgent.tsx (container MCP chips, shared skills picker w/
  zip/git custom sources + monorepo picker, FILESYSTEM group w/ VPC reveal +
  validation gating LAUNCH), lib/api.ts (inspectSkillZip/inspectSkillGit/
  attachSkillSources, FilesystemInput), locales en+zh-CN.
- specs: .trellis/spec/launchpad/container-capabilities-filesystem.md (new) +
  ingestion guide cross-note (staging now dual-consumer).

### Testing

- [OK] backend: 416 passed (58 new across 6 files: spec validators, runtime
  param shapes, IAM policy lifecycle, skill bundling, template render, attach
  endpoint, agents API round-trip)
- [OK] frontend: eslint clean (1 pre-existing warning), tsc+vite build clean
- [OK] browser evidence: frontend/scripts/sdk_caps_fs_evidence.mjs →
  design/screenshots/agent-sdk-caps-fs/ (9 shots: registry-linked capabilities,
  zip auto-attach, git picker, attached chips, session toggle, BYO S3+VPC
  required w/ LAUNCH disabled asserted true, VPC filled re-enables, edit
  reload round-trip, zh-CN)

### Status

[OK] **Completed**

### Next Steps

- Optional: "promote to registry" action for custom-attached skills; TTL sweep
  for orphaned agent-skills/ prefixes (documented non-goals)

---

## 2026-07-13 — Live verification: container filesystem config (session storage)

**Date**: 2026-07-13
**Task**: (no Trellis task — pure verification run for 07-12-agent-sdk-capabilities-fs)
**Package**: launchpad backend + real AWS
**Branch**: `main`

### Summary

Deployed a REAL container agent through the platform API to prove the new
filesystemConfigurations path end-to-end. Agent `fs-verify-agent`
(id 95557700bafc456990fbab04e44c25d8, runtime fs_verify_agent_b8fc65-AxoujZAH13,
CodeBuild 1.5m, READY) with default filesystem spec (session storage ON
@ /mnt/workspace). All four checks passed:

1. Control plane: GetAgentRuntime returned
   `filesystemConfigurations=[{sessionStorage:{mountPath:"/mnt/workspace"}}]`,
   networkMode PUBLIC (no BYO) — deploy stage passed the new params for real.
2. Mount live: in-session Bash wrote /mnt/workspace/persist.txt; `df -h` shows
   the mount is a real NFS filesystem `127.0.0.1:/export` sized **1.0G**
   (managed session storage envelope).
3. Persistence: StopRuntimeSession (200) → re-invoke SAME session id → new
   microVM restored the file (`fs-proof-20260713` read back, ls shows it).
4. Isolation: NEW session id → /mnt/workspace empty, FILE-ABSENT.

Also proven implicitly: Bash works in the container under
permission_mode=bypassPermissions even though ALLOWED_TOOLS=['Task'] —
allowed_tools whitelisting doesn't restrict under bypass, so no template change
was needed for file ops.

### Status

[OK] **Completed** — fs-verify-agent KEPT deployed as demo material (delete via
DELETE /api/agents/95557700bafc456990fbab04e44c25d8 when no longer wanted;
verification sessions stopped).

---

## 2026-07-13 — BYO S3 Files live verification + policy/propagation fixes

**Date**: 2026-07-13
**Task**: 07-13-fs-policy-getaccesspoint-fix
**Package**: launchpad backend + real AWS (minimal S3 Files env)
**Branch**: `main`

### Summary

Built a minimal S3 Files access-point environment (versioned SSE bucket +
sync role trusting elasticfilesystem.amazonaws.com + mount target in the
pre-existing agentcore-vpc's NAT-routed private subnet usw2-az2 + SG pair) and
verified the BYO path end-to-end through platform redeploys of fs-verify-agent.
Verification surfaced and fixed TWO product bugs:

1. **Execution-role policy shape** — the AgentCore devguide's example policy is
   wrong AND incomplete. IAM-simulator + UpdateAgentRuntime probes proved:
   `s3files:GetAccessPoint` authorizes on the AP ARN and does NOT carry the
   `s3files:AccessPointArn` condition key (combined conditioned statement →
   implicitDeny), and validation ALSO requires undocumented
   `s3files:ListMountTargets` on the FS ARN. `_fs_policy_document` now emits
   three statements.
2. **IAM propagation race** — deploy stage called Create/UpdateAgentRuntime
   1-2s after provision (re)wrote the inline policy; on real policy changes AWS
   rejected with "missing required permissions". Added
   `_retry_iam_propagation` (targeted retry, 6×10s); observed live: 1 retry
   sufficed on an AP-ARN change.

Also hit the **AP root-ownership gotcha** (ops, not product): posixUser only
sets operation identity; rootDirectory.creationPermissions applies ONLY if the
directory doesn't exist at first mount — seeding the bucket prefix beforehand
creates it root-owned → write EACCES. Fixed by pointing the AP at a fresh
prefix (/agent-data).

### Verified live (runtime versions v3→v6)

- GetAgentRuntime: networkMode VPC + both configs (sessionStorage + s3FilesAccessPoint)
- In-container: /mnt/datasets = NFSv4.2 127.0.0.1:/ (8.0E), /mnt/workspace 1.0G — coexist
- bucket→FS: seed object readable in-container; FS→bucket: agent-written file
  appeared in S3 after ~50s (async bidirectional sync, both directions proven)
- Rollback: removing BYO mounts → PUBLIC network, sessionStorage-only,
  inline policy auto-removed (v6)
- 419 backend tests green (3 new retry tests + policy-shape assertions)

### Teardown

All demo infra deleted (3 APs, mount target, file system, bucket+versions,
sync role, mount SG). EXCEPT: runtime SG `sg-04e7d389f0256b746` in
vpc-0e88cbfc77f28ec07 — held by AgentCore's lingering ENIs (auto-released ≤8h);
delete afterwards with `aws ec2 delete-security-group --group-id sg-04e7d389f0256b746`.
fs-verify-agent kept (session-only, PUBLIC, v6). Setup/teardown state was
tracked in data/fs-byo-state.json (gitignored).

### Status

[OK] **Completed**

---

## 2026-07-13 — Harness agents enabled in evaluation (new run / insight)

**Date**: 2026-07-13
**Task**: 07-13-harness-eval-support
**Package**: launchpad backend + frontend + real AWS probe
**Branch**: `main`

### Summary

User asked why active harnesses don't appear in the eval agent dropdown. The
old exclusion ("no span service name", evaluation/service.py) turned out WRONG:
live probe of a fresh hr-assistant session showed managed harnesses run on an
internal Strands runtime emitting service.name harness_{harnessName}.DEFAULT
with scope strands.telemetry.tracer (the evaluation-parseable scope) and full
gen_ai attrs. Enabled harness in the eval pipeline:

- resolve_telemetry harness branch — service name derived from the harnessId
  base; content-log group PREFIX-DISCOVERED (/aws/bedrock-agentcore/runtimes/
  harness_{name}-) because the backing runtime id ≠ harnessId and GetHarness
  doesn't expose it; multiple groups → newest creationTime; cold harness (no
  group yet) → 400 eval.harness_no_telemetry with a "chat first" hint.
- execute_run dataset invoking dispatches by method (InvokeHarness vs runtime
  data plane); Evaluation.tsx dropdown filter now status-only. Experiments
  KEEP excluding harness (config-bundle A/B doesn't apply).

### Verified

- Live: window:1h run fbbd4043f0fe vs hr-assistant → COMPLETED,
  Correctness 1.0 / Helpfulness 0.83 (probe session evaluated).
- Browser: both harness agents render in the ?view=new dropdown
  (design/screenshots/agent-sdk-caps-fs/11-harness-in-eval-dropdown.png).
- 420 backend tests green (excluded-test rewritten to happy path + cold-harness
  400 test); frontend lint/build clean.
- Spec: .trellis/spec/launchpad/evaluation-agent-eligibility.md (new).

### Status

[OK] **Completed**

---

## 2026-07-13 — Fix: AWS cloud datasets selectable in New Run / Insights

**Date**: 2026-07-13
**Task**: (no Trellis task — small fix, user-approved skip)
**Package**: launchpad backend + frontend
**Branch**: `main`

### Summary

New Run's DATASET dropdown only listed `/api/eval/datasets` (local rows), so
cloud-only datasets (HR_scenario_dataset_sample / HR_simulated_personas_sample,
created directly in AWS) were unselectable. Root constraint probed live:
StartBatchEvaluation has NO dataset data source — a dataset run must be driven
locally. Fix: `RunCreate.cloud_dataset_id` (same XOR slot as dataset_id) →
`_cloud_dataset_items` fetches examples via new `ac.list_dataset_examples`
(paginated), strips `exampleId`, validates, and replays them through the
existing pipeline; run row gets `dataset_name="cloud:{name}"` (scope encoding
like window:Nh, rendered "☁ name"). Predefined-schema-only gate: simulated
persona datasets 422 `run.cloud_dataset_unsupported` (need AWS LLM-actor
simulation). New GET `/api/eval/datasets/cloud/{id}` returns `runnable` +
`has_ground_truth` for lazy Trajectory* gating. Frontend: optgroup LOCAL/AWS
CLOUD, simulated options disabled with reason, cloud hint note, per-selection
GT cache. Also fixed stale harness-excluded copy (newRun.sub + how.note, en+zh)
left over from 07-13-harness-eval-support.

### Verified

- Live: run 2faaa172b136 (hr-assistant harness × cloud HR_scenario_dataset_sample,
  Correctness + Helpfulness + TrajectoryInOrderMatch) submitted through the UI
  dropdown — invoked 3 scenarios, batch eval completed (see runs list).
- GET /datasets/cloud/{id}: scenario sample → runnable+GT true; personas →
  runnable false, list_dataset_examples not called.
- 425 backend tests green (5 new), tsc/eslint/vite build clean; browser
  screenshot design/screenshots/eval-cloud-dataset-newrun.png.
- Spec: .trellis/spec/launchpad/evaluation-cloud-dataset-runs.md (new).

### Status

[OK] **Completed**

---

## 2026-07-13 — Simulated persona datasets runnable (actor LLM per run)

**Date**: 2026-07-13
**Task**: (no Trellis task — follow-up to the cloud-dataset fix)
**Package**: launchpad backend + frontend
**Branch**: `main`

### Summary

User pointed at the SDK dataset-runner sample: SimulatedScenario runs ARE
locally drivable — an LLM actor (SimulationConfig.model_id) plays the user.
Added `bedrock-agentcore[simulation]` extra (strands-agents-evals) and a thin
adapter `app/evaluation/simulation.py` around `SimulatedScenarioExecutor`:
our invokers (InvokeHarness / runtime data plane) drive the conversation so
the RUNTIME session id (what telemetry carries) is recorded — the executor's
framework session id is just a conversation key; FAILED results re-raise so
runs fail honestly. `RunCreate.actor_model_id` required whenever items carry
`actor_profile` (422 run.actor_model_required); execute_run dispatches
per-scenario (actor loop vs turn replay); persona assertions ride
sessionMetadata as before. `_validate_items`/`_infer_kind` accept the persona
shape (kind="simulated"), sync-to-aws now picks the schema by kind. Frontend:
simulated cloud datasets selectable ("personas" tag), ACTOR MODEL select
(curated us-west-2 list, default haiku-4-5) appears for simulated selections.

### Gotcha

uvicorn --reload killed the first live run: editing backend/tests/*.py mid-run
restarts the backend → in-flight run failed honestly by startup reconciliation.
Don't touch backend/**/*.py while a live eval run is in flight.

### Verified

- tests/evaluation/test_simulation.py (adapter + plumbing) and updated
  test_datasets_v2 cloud tests; 434 backend tests green; tsc/eslint clean;
  i18n parity OK (strict-mode failures are pre-existing studio/nodes strings).
- Browser: personas dataset selectable, ACTOR MODEL field renders
  (design/screenshots/eval-simulated-dataset-actormodel.png).
- Live simulated run: see run 7a34e9697730 (result recorded below once done).
- Spec: evaluation-cloud-dataset-runs.md rewritten for simulation support.

### Status

[OK] **Completed**

---

## 2026-07-13 — Evaluation dashboard: EXPERIMENT preview panel removed

**Date**: 2026-07-13
**Task**: (no Trellis task — small UI cleanup, user request)
**Package**: launchpad frontend
**Branch**: `main`

### Summary

Removed the EXPERIMENT status-preview Panel at the bottom of /evaluation —
it was a duplicate entry point: the header `⚗ EXPERIMENT` button still opens
`?view=experiment`, and ExperimentView fetches its own data. Also dropped the
now-dead `experiments` state + the `/api/experiments` poll from the 8s
dashboard refresh loop, `experimentTone`/`ExperimentInfo` imports, and 4
orphaned i18n keys (evalPage.experiment.{latest,rowMore,open,none}, en+zh).
Feature itself is untouched.

Also recorded here: the simulated-persona live run 7a34e9697730 COMPLETED
(3 personas × haiku-4.5 actor vs hr-assistant; Correctness 0.8 /
Helpfulness 0.87 / GoalSuccessRate 0.0 — assertions unmet because the harness
can't really submit PTO; semantics correct).

### Verified

- Browser: experiment-row gone from dashboard; experiment-btn still routes to
  ?view=experiment (title 实验). tsc/eslint exit 0; i18n_check PASS (1034
  keys, parity OK); vite build ✓.
- Screenshot design/screenshots/eval-dashboard-no-experiment-panel.png.

### Status

[OK] **Completed**

---

## 2026-07-13 — Observability: eval-run sessions now show their conversation

**Date**: 2026-07-13
**Task**: (no Trellis task — bug report from user testing)
**Package**: launchpad backend + frontend
**Branch**: `main`

### Summary

User: session detail for an eval-run session (simulated persona run
79d11eab1f8e) showed an empty CONVERSATION panel. Root cause chain:
`session_transcript` required a ChatSession ledger row (eval sessions have
none → `not_platform_session`), yet the conversation EXISTS in platform
memory — eval invokers pass the BARE `"default"` actor to the runtime and the
harness's managed runtime auto-persists envelope events under it (38 events
for the reported session). Fix: fallback `_eval_run_for_session` (membership
scan over recent EvalRun.session_ids) → read events under actor "default" →
same envelope decoding. Response gains `source`/`run_id`; frontend hides
OPEN IN CHAT for eval sources and shows "评估运行 · run-xxxxxx" in the panel
sub. Runtime-backed agents' eval sessions still show no turns (nothing writes
their memory) — accurate empty state.

### Verified

- Live: the reported session now renders 13 turns (persona Maya ×
  hr-assistant) — design/screenshots/obs-eval-session-transcript.png.
- New test test_transcript_falls_back_to_eval_run_session; 435 backend tests
  green; tsc/eslint 0; i18n PASS.

### Status

[OK] **Completed**

---

## 2026-07-13 — Eval transcripts for runtime agents via OTEL content logs

**Date**: 2026-07-13
**Task**: (no Trellis task — follow-up feature, user-approved)
**Package**: launchpad backend + frontend
**Branch**: `main`

### Summary

Runtime-backed agents (zip/studio/container) write no memory events during
eval runs, so their session transcripts were empty. New
`eval_turns_from_content_logs`: rebuilds USER/ASSISTANT turns from the
runtime log group's `otel-rt-logs` stream (ADOT per-span gen_ai content
records — the same content StartBatchEvaluation reads). Grouping: one
traceId = one invocation; USER = latest input user message (later records
carry full history), ASSISTANT = end_turn output w/ last-assistant fallback;
content strings are polymorphic (plain | JSON-encoded text/toolUse/toolResult
parts — tool-only → skipped). TWO gotchas found live: (1) filter_log_events
scans oldest-first — startTime from the run's created_at is load-bearing
(without it: 0 events, page budget dies in old logs); (2) insights re-runs
REUSE session_ids → _eval_run_for_session must pick the OLDEST matching run
(the creator) or the time window starts after the traffic. Also: long-term
memnote suppressed for eval sources (bare default actor aggregates across
all agents), transcript gains origin: memory|logs, frontend sub 由 OTEL
内容日志重建 / rebuilt from otel content logs.

### Verified

- All five shapes live: zip ✓ studio ✓ container ✓ (2 turns each from logs),
  harness ✓ (13 turns, memory unchanged), deleted agent ✓ (log groups
  outlive runtimes). Screenshot obs-eval-session-logs-transcript.png.
- 437 backend tests (3 new: extraction grouping/pagination, logs fallback +
  creator-run pick); tsc/eslint 0; i18n PASS.
- Ops note: make dev's 8000/5173 were down (killed externally) — restarted
  via nohup uvicorn --reload + vite --strictPort.

### Status

[OK] **Completed**

## 2026-07-13 · 07-13-managed-kb (worktree-managed-kb)

Managed KB 管理 + agent 挂载全链路落地。要点:
- 拓扑:共享 `launchpad-kb-gw` + per-KB Retrieve target + per-agent AgenticRetrieveStream target(retrievers 绑 agent 所选 KB);v1 harness-only、S3-only。
- 活体验证抓到 4 个真 bug:KB 创建异步 1.5–3min(创建接口改快路径+source_pending 前端接力)、GetDataSource 的 connectorParameters 是 JSON 字符串、target DELETING 态不能 update(等消失再建)、**UpdateHarness omit=keep 语义**(wrap_params_for_update 现在显式发空 tools/skills——此前删光工具的 re-publish 从未真正生效,存量 bug)。
- E2E 证据:aurora-support 对话中可见 `aurora-deck-docs-bl6zkavwfb___Retrieve` TOOL CALLED×2,回答含 30-days 退款/AD-4411 workaround(样例文档独有事实)。
- 留存 demo:KB aurora-deck-docs(BL6ZKAVWFB)+ agent aurora-support + launchpad-kb-gw。e2e 脚本:backend/scripts/e2e_knowledge_base.py / e2e_kb_gateway.py。

---

## 2026-07-13 — KB data sources: per-document metadata table (paginated)

**Date**: 2026-07-13
**Task**: (no Trellis task — small feature, user request)
**Package**: launchpad backend + frontend
**Branch**: `main`

### Summary

KB detail's data-source cards now expose the actual documents:
`knowledge.list_documents` = ListKnowledgeBaseDocuments (works on MANAGED
KBs; token-paginated) joined with S3 object metadata (size + upload time,
one capped list_objects_v2 over the source prefix, best-effort for external
buckets). New GET /{kb_id}/data-sources/{ds_id}/documents?page_size&token.
Frontend `SourceDocuments`: lazy-expand "▤ 文档 (n)" per source → table
名称/大小/上传时间/状态/索引时间 with FAILED statusReason tooltip, ⟳ refresh,
and LOAD MORE token pagination. resourceTone learned document statuses
(INDEXED good, INDEXING/PARTIALLY_INDEXED warn, NOT_FOUND crit).

### Verified

- Live on aurora-deck-docs: 3 docs incl. Chinese-named PDF (353.2 KB,
  uploaded 06:09:31, INDEXED 06:12:42); token pagination proven at
  page_size=2 (page1 2 rows + LOAD MORE → 3 rows, button gone).
- 482 backend tests (2 new: S3-join shape + degrade-without-access);
  tsc/eslint/i18n PASS. Screenshot kb-source-documents-zh.png.

### Status

[OK] **Completed**

---

## 2026-07-13 · 07-13-experiment-stepwise

**Task**: .trellis/tasks/07-13-experiment-stepwise · **Branch**: main

### Summary

Experiments 模块从"单线程自动流水线"重构为 step-by-step 用户驱动流（参考
agentxray Live-on-AWS 控制台,含部署站点实访取证）。后端:11 个 action 动词复用
`POST /experiments/{id}/action`(长动作 202+daemon 线程,短动作 200 inline),
行级 `running_action/progress` 列(刷新/重启可恢复),accept 可编辑推荐,
traffic 支持数据集回放(复用 scenario_prompts 解包 dict input),
`clear_stale_running_actions()` 启动清扫(--reload 杀线程导致 409 永锁的真实缺
口,活体踩到后补齐)。前端:EvaluationExperiment.tsx 重建为 artifact 驱动的渐进
式阶段卡片(active 琥珀边框/done 绿✓),DiffPanes(CHANGED 标记)+可编辑
textarea+ACCEPT,actionBtn 模式(按钮→进度行→工件回显→失败 `action:` 前缀定位
重试),i18n en/zh-CN 各 +24 键。旧 auto-pipeline 记录零迁移兼容(A8,活体 DB 验证)。

### Verified

- 后端 506 tests 全绿(+18 stepwise;含 check 子代理补充的 rerun-preserves-accept
  与 dict-input 用例);改动文件 ruff 干净;前端 lint/build 干净。
- fetch-stub 浏览器取证 13 张(evidence/):fresh/running/diff-accept/gwab/
  traffic 数据集选择/verdict 非显著(次级 PROMOTE+建议注记)/verdict 显著/canary
  权重条+RAMP/failed 重试/old-row A8。
- e2e_experiment.py 重写为逐 action 驱动,真实 AWS 运行中(记录于本任务)。

### Notes

- impl-backend 子代理连续两次 API 504(~80min 零产出)→ 改为主会话直接实现;
  check 子代理 PASS-WITH-FIXES:自修 2 处(scenario_prompts 复用+测试),另提出
  2 个结构性问题——bundles 重试不幂等(已修:create_bundle_idempotent,
  ListConfigurationBundles adopt-by-name)+ status=failed 仅遗留语义(已写入 spec:
  stepwise 失败保持 running+内联重试,cleanup 是唯一占位逃生口)。
- 活体踩坑复盘:--reload 两次杀掉进行中线程(编辑 backend py 触发),启动清扫都
  正确转为可重试错误;e2e 脚本因此加了 resume(按工件跳过已完成 action)。
  数据集路由是 /api/eval/datasets(前端与 e2e 初版都写错成 /api/evaluation/,
  fetch-stub 掩盖了 404——stub URL 必须镜像真实路由)。
- spec 新增 .trellis/spec/launchpad/experiment-stepwise.md(7-section code-spec)。

### Status

[OK] Blocks 1–2 complete; Block 3 e2e running


## Session 8: Experiment stepwise rework: user-driven stage actions (agentxray Live parity)

**Date**: 2026-07-13
**Task**: Experiment stepwise rework: user-driven stage actions (agentxray Live parity)
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Refactored the experiments module from a single auto-pipeline thread into 11 user-triggered stage actions (async 202 + daemon runner w/ row-level running_action/progress, sync 200 inline; prereq guard matrix; editable accept; dataset traffic replay; bundle conflict-adopt; stale-action startup sweep). Frontend rebuilt as artifact-driven progressive stage cards with per-action progress and retry pinning; +24 i18n keys en/zh-CN. Backend 508 tests green; 13 fetch-stub evidence states + live A2 reload-resume; e2e_experiment.py rewritten (per-action, resume-by-artifact) and PASSED end-to-end on real AWS incl. two mid-flow backend restarts. Spec: launchpad/experiment-stepwise.md.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `a4a3efb` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete

---

## 2026-07-13 · 07-13-harness-to-runtime

**Task**: .trellis/tasks/07-13-harness-to-runtime · **Branch**: main

### Summary

harness → runtime 一键转换落地(实验使能)。起因:用户纠正"harness 没有 runtime
ARN"的错误判断→实测三层事实(backing runtime 在 ListAgentRuntimes 可见但
InvokeAgentRuntime 被锁死只能 InvokeHarness;`agentcore export harness` 导出代码
提示词烤死、不读 get_config_bundle)。方案:POST /api/agents/{id}/convert =
请求内同步 export(CLI 需项目 cwd,data/harness-export 暂存工程)+**强制嫁接**
config-bundle 契约(resolve_system_prompt 模式,锚点缺失即失败——否则实验 A/B
空转,正是本任务要消除的陷阱)+ spec 物化 code_bundle(新字段:多文件承载,
main.py 必含/路径安全/≤64 文件 1MB,XOR code)走现有 zip 管线(write_bundle_files
经 on_pkg_ready)。保真度 v1:提示词+内联工具+memory env 接线;KB 网关 URL 刻意
不接(M2M token 未验证时注入会 import 崩溃),conversion_notes 全程明示并在
Agent 详情渲染。命名 {name}-rt[-N],来源 source_harness 可追溯。意外收获:
转换 agent 是流式入口→invoke_runtime_text 新增 flatten_sse_text(SSE 拍平,
惠及 chat/eval 全下游)。前端:Agent 管理 CONVERT ⇄ RT 行动作+确认框、详情
CONVERTED AGENT 面板、实验页 harness 禁用项+引导注记,i18n en/zh-CN。

### Verified

- 后端 516 tests 全绿(+13 convert:真实导出 fixture 的嫁接/锚点失败/env 发现/
  依赖去重/bundle 校验/端点守卫/命名去重/无残留行/SSE 拍平);ruff/lint/build 干净。
- 活体 A7:aurora-support 转换 15s 请求(export→graft→spec)+ ~2min 部署→
  aurora-support-rt ACTIVE;chat 人设生效且如实演示 KB 降级("无法检索知识库,
  不猜测");实验页第一个可选项;详情面板四项接线明细。证据 4 张(evidence/)。
- spec 新页 harness-conversion.md(7-section)+ eligibility 页早前已补
  invoke-lock/ListAgentRuntimes 事实。

### Status

[OK] **Completed**


## Session 9: Harness → runtime conversion: one-click experiment enablement

**Date**: 2026-07-13
**Task**: Harness → runtime conversion: one-click experiment enablement
**Package**: lab4-interactive
**Branch**: `main`

### Summary

User challenged the 'harness has no runtime ARN' claim — verified the real gating facts live (backing runtime listed but invoke-locked; exported code never reads config bundles) and corrected the spec. Then shipped POST /api/agents/{id}/convert: agentcore CLI export + mandatory config-bundle graft + AgentSpec.code_bundle multi-file deploy through the existing zip pipeline; fidelity policy (memory wired, KB gateway deliberately not, all in conversion_notes); flatten_sse_text for streaming runtimes; CONVERT ⇄ RT row action + details provenance panel + experiment-page harness guidance, en/zh-CN. 516 backend tests; live-proven aurora-support → aurora-support-rt ACTIVE and experiment-selectable.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `e983613` | (see git log) |
| `e028413` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 10: Evaluators/Datasets sub-pages adopt Experiment-style interaction

**Date**: 2026-07-13
**Task**: Evaluators/Datasets sub-pages adopt Experiment-style interaction
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Refactored ?view=evaluators and ?view=datasets to the Experiment interaction: top table Panel with URL-param row selection (?ev=<id>|new; ?ds=<id>|cloud:<id>|new), detail/editor panel below (Delete/Sync/Save moved in from list rows; builtin evaluators + cloud-only datasets get read-only variants), how-it-works side panel. Editor rehydration keyed on stable selKey (+selRef) so load() refreshes never wipe unsaved edits. i18n en/zh-CN keys added/pruned in sync. Verified live: evaluator create→auto-select→delete, idempotent PUT save, dataset form+import create, edit save, real sync (cloud copy ACTIVE) then UI cloud delete, draft-leak reset, deep links + browser back; 10 screenshots in design/screenshots/eval-pages/. New spec launchpad/evaluation-subpage-interaction.md.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ef0d412` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 11: Dataset editor: user simulation scenario type

**Date**: 2026-07-13
**Task**: Dataset editor: user simulation scenario type
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Added the devguide user-simulation scenario type to the dataset editor (frontend-only; backend already validated/inferred/synced simulated items). Create form gains MULTI-TURN | USER SIMULATION selchips; sim cards author scenario_id/description/actor context/goal/traits rows/first message/max_turns/assertions per devguide schema (verified via AWS docs MCP: no turns/expected_response/expected_trajectory). toSimDrafts/toSimItems round-trip byte-identical (max_turns omitted when =10 default); fixed broken editing of simulated datasets (previously empty hydration + kind_immutable 400 on save); mixed imported datasets collapse to a warning note (no save) instead of silent data loss. Live-verified: prefill create -> KIND=simulated, New Run ACTOR MODEL linkage, edit save round-trip across row switches, real sync -> AGENTCORE_EVALUATION_SIMULATED_V1 ACTIVE, mixed guard via manual PUT; probe dataset + cloud copy deleted after. Spec section added to launchpad/evaluation-subpage-interaction.md; 4 new screenshots.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `eb28cc4` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 12: Align experiment promotion with AgentCore

**Date**: 2026-07-14
**Task**: Align experiment promotion with AgentCore
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Replaced legacy 1/99 promotion with stop-and-deploy production promotion, added capability and bundle contracts, updated the experiment UI, and verified backend, frontend, and browser behavior.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c73aead` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 13: Canary challenger eligibility

**Date**: 2026-07-14
**Task**: Canary challenger eligibility
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Separated runtime canary eligibility from bundle experiment eligibility, enforced the capability in the API, exposed disabled reasons in the selector, and verified the live experiment UI.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `4e59e72` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 14: Split configuration A/B from Runtime Canary

**Date**: 2026-07-14
**Task**: Split configuration A/B from Runtime Canary
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Separated configuration-bundle experiments from Runtime Canary with independent records, APIs, UI workflows, shared-Gateway conflict guards, per-stage evidence gates, resource-safe cleanup, compatibility handling, tests, browser validation, and updated code-specs.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ff7756c` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 15: Production-grade target-based A/B canary

**Date**: 2026-07-15
**Task**: Production-grade target-based A/B canary
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Turned the Runtime Canary (target-based A/B) into a real production canary: Model-1 single-agent + candidate version via named-endpoint mint, dedicated per-canary gateway, live-traffic invoke routing (SigV4 through the gateway; provisioning/live route forms; control-safe fail-safe), DEFAULT-as-production-truth with roll-forward rollback, real promote. Phased (spike→P1..P3.5→frontend), adversarially reviewed (fixed a HIGH setup-failure production-safety hole + 4 more), spec'd, and validated end-to-end on real AWS (self-cleaning e2e that also surfaced + fixed teardown eventual-consistency retries). Also this session: /init CLAUDE.md, zh-CN i18n fixes, tab rename to TARGET-BASED/CONFIGURATION-BUNDLE A/B. make verify green (643 backend).

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `84e885e` | (see git log) |
| `a2e0db2` | (see git log) |
| `9cd11ec` | (see git log) |
| `e98e3d9` | (see git log) |
| `bc8c695` | (see git log) |
| `47b8a4c` | (see git log) |
| `8595c9a` | (see git log) |
| `e88fa8c` | (see git log) |
| `4a536bd` | (see git log) |
| `65f1eea` | (see git log) |
| `67310c9` | (see git log) |
| `98a4741` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 16: Local console password login

**Date**: 2026-07-15
**Task**: Local console password login
**Package**: lab4-interactive
**Branch**: `main`

### Summary

Added an optional AWS-independent local operator login with signed HttpOnly sessions, protected console APIs, frontend auth gate, tests, docs, browser QA, and passing make verify.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `849e1dc` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
