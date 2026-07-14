# Design — Production-grade target-based A/B canary

## Architecture overview

A canary operates on **one agent runtime** and two of its **immutable versions**,
fronted by a **dedicated, ephemeral AgentCore Gateway** running a target-based
A/B test. Real production traffic (via the platform's single invoke chain) is
routed through that gateway while the canary runs; promote/rollback conclude the
test and the platform reverts to direct-runtime invocation via a **pinned stable
endpoint**.

```
                       (during canary)                     (not canarying)
 /v1 + Chat ─▶ invoke_agent_text ─┬─ active canary? ─ yes ─▶ SigV4 POST gateway URL
                                  │                          /{control|treatment}/invocations
                                  │                          (sticky X-Amzn-…-Session-Id)
                                  │                                │ 90/10 → 50/50 → 1/99
                                  │                    ┌───────────┴───────────┐
                                  │              target C (control)      target T1 (treatment)
                                  │              qualifier=stableEP        qualifier=treatmentEP
                                  │                 → v_current               → v_candidate
                                  └─ no ──▶ invoke_agent_runtime(arn, qualifier=stableEP)  ← pinned to the live version
```

## Runtime version / endpoint topology (per canary)

`CreateAgentRuntime` → v1 + DEFAULT (auto-follows latest). We add **named
endpoints** (which pin a version and do NOT auto-follow):

- **stable endpoint** (e.g. `stable`) — pinned to `v_current` (the live version).
  This becomes the platform's canonical invoke qualifier for the agent, replacing
  reliance on DEFAULT (which auto-rolls to whatever `UpdateAgentRuntime` last
  produced and is therefore unsafe after a candidate is minted).
- **treatment endpoint** (e.g. `treatment`) — pinned to `v_candidate`.

Setup mints `v_candidate` by running `UpdateAgentRuntime` with the user's edited
spec. Because that auto-rolls DEFAULT to `v_candidate`, the stable endpoint (pinned
to `v_current`) is what keeps production on the current behavior.

**Gateway targets** (type `http-runtime`): `C` → `{arn, qualifier: stable}`,
`T1` → `{arn, qualifier: treatment}`. A/B variants map C/T1 to these targets,
weights 90/10 at start.

## The invoke-chain change (`app/services/invoke.py`) — highest-risk

`invoke_agent_text` gains a pre-dispatch decision:

1. **Lookup**: is there an active canary (`RuntimeCanary.status == "running"`,
   gateway READY) for `agent.id`? Backed by an indexed SQLite query keyed on the
   agent id + a short-TTL in-process cache (this is the hot path; must be cheap
   and must not add an AWS call per invoke).
2. **Active** → SigV4 POST to `{gateway_url}/{control_target}/invocations` with the
   sticky `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <session_id>` header; the
   gateway assigns the variant by session id and splits by weight. Reuse the
   SigV4 signer already in `service.send_gateway_traffic` (extract a shared helper
   `sigv4_post(url, body)`; response parsing shared with `runtime.invoke_runtime_text`).
3. **Not active** (or after promote/rollback) → direct
   `invoke_agent_runtime(arn, qualifier=<stable endpoint>)` — the pinned live
   version, never DEFAULT.
4. **Fail-safe**: if the gateway route errors mid-canary, fall back to the
   **stable endpoint (v_current)**, never to DEFAULT (which is v_candidate,
   untested). Surface the error to telemetry.

Non-canary agents that have never been canaried keep today's behavior (direct
ARN, DEFAULT) — the stable endpoint is only introduced once an agent is canaried,
after which the platform always targets it.

## State machine (`app/optimization/canary_service.py`)

Reuse `RUNTIME_CANARY_STAGES = [setup, traffic, verdict, ramp, complete,
rollback, cleanup]` with new mechanics:

| Stage | New behavior |
|---|---|
| **setup** | Create per-canary gateway (READY); mint `v_candidate` via `UpdateAgentRuntime(edited spec)`; ensure `stable`→v_current + `treatment`→v_candidate endpoints (READY); create 2 `http-runtime` targets (qualifier=endpoint); per-variant online-eval; `create_ab_test` 90/10 RUNNING. Persist versions/endpoints/gateway/targets/ab_test in artifacts. |
| **traffic** | Optional **seed** only (relabelled) — `send_gateway_traffic`. Real traffic flows organically now. |
| **verdict** | Unchanged — `get_ab_test.results` → `compute_verdict` (per-variant online-eval). |
| **ramp** | Unchanged — `update_weights_with_pause` (pause → weights → resume) 90/10→50/50→1/99, gated by verdict. |
| **complete (promote)** | Stop test; **repoint stable endpoint → v_candidate** (`UpdateAgentRuntimeEndpoint`); optionally remove treatment endpoint. Status `completed`. Production (direct, qualifier=stable) now serves v_candidate. Drop `experimental_only`. |
| **rollback** | Stop test; leave stable endpoint at v_current (no change). Status `rolled_back`. Production reverts to v_current via stable endpoint (safe — never left it). |
| **cleanup** | Delete this canary's gateway, targets, treatment endpoint, online-eval configs, A/B test (STOPPED first). Keep the stable endpoint (it is the agent's production qualifier). |

## Data model (`app/optimization/models.py`)

Model 1 collapses champion/challenger to one agent. Minimal change (demo, no
migration): treat `champion_agent_id` as **the agent id**; drop the two-agent
semantics. Store in `artifacts.setup`: `agent_id`, `v_current`, `v_candidate`,
`stable_endpoint`, `treatment_endpoint`, `gateway{id,arn,url}`, `targets`,
`ab_test_id`, `weights`, plus the edited-spec snapshot. `challenger_agent_id`
may be repurposed/blanked. (Confirm exact column reuse during implementation;
existing demo rows are not migrated.)

## Capability + entry flow

`canary_capability(agent)` becomes "can this agent be canaried?" — active
HTTP-protocol `zip_runtime|container|studio` with a deployed runtime ARN (drop
the challenger-vs-champion framing). The frontend replaces the two-agent
dropdowns with **one agent + a candidate edit** (prompt/tools/code), which
becomes the `UpdateAgentRuntime` spec at setup.

## Telemetry / online-eval

Per-variant online-eval currently targets `{resource_id}-DEFAULT` log group and
`{runtime_name}.DEFAULT` service name. Named endpoints have their own log
group/service-name suffix. **Risk/verify**: confirm the log-group + service-name
pattern for named endpoints (likely `{resource_id}-<ENDPOINT>` /
`{runtime_name}.<ENDPOINT>`) so each variant's eval reads the right stream.

## Frontend

- `EvaluationExperiment.tsx`: tab labels already renamed (TARGET-BASED A/B /
  CONFIGURATION-BUNDLE A/B). Update meta/handoff/panel titles + remove
  "experimental only / no production change" copy → "live production traffic".
- `EvaluationRuntimeCanary.tsx`: single-agent + candidate-edit entry; version-vs-
  version display; "send **test** traffic" relabel with an augments-organic note;
  promote/rollback wording reflects real production cutover.
- i18n: en + zh keys updated together (parity gate).

## Compatibility / rollback of the change

- Replaces the experiment-only path; existing demo `runtime_canaries` rows are
  not migrated (may be cleaned).
- Feature is self-contained to the optimization module + invoke routing; rollback
  = revert the commits. The invoke-path change is guarded so non-canaried agents
  are unaffected.

## Key trade-offs & risks

- **Hot-path coupling**: invoke now consults canary state. Mitigate with an
  indexed lookup + short-TTL cache; fail-safe to the stable endpoint.
- **DEFAULT auto-roll**: forces the stable-endpoint design; documented above.
- **PAUSE-to-ramp** briefly routes all traffic to control — safe-toward-control.
- **Version accumulation**: each canary mints a version; retention limits are
  undocumented — monitor / consider cleanup.
- **AWS preview drift**: keep all A/B + endpoint calls inside the `agentcore`
  wrappers / `service.py` helpers.
- **One RUNNING test per gateway** is moot with per-canary gateways.
