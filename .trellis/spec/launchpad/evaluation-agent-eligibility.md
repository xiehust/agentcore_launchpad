# Evaluation — agent eligibility & telemetry resolution

## Scenario: which agents can be evaluated, and how their telemetry is located

### 1. Scope / Trigger

Contract between `backend/app/evaluation/service.py` (`resolve_telemetry`,
`execute_run`) and `frontend/src/pages/Evaluation.tsx` (agent dropdown).
Touch this when adding a creation method, changing span/service naming, or
altering BatchEvaluation scoping. Introduced by task `07-13-harness-eval-support`.

**Load-bearing facts (live-probed 2026-07-13, hr-assistant session):**
- ALL four methods are eval-supported: `EVAL_SUPPORTED_METHODS = {zip_runtime,
  studio, container, harness}`.
- Managed harnesses run on an internal **Strands** runtime: spans carry
  `service.name = "harness_{harnessName}.DEFAULT"` and scope
  `strands.telemetry.tracer` (the evaluation-parseable scope) with full gen_ai
  attrs — the old "no span service name" exclusion was wrong.
- The harness's **backing runtime id ≠ harnessId** (`hr_assistant-Flr7ibmASq`
  runs on `harness_hr_assistant-GIRksPB4NZ`). GetHarness does NOT expose it.
  The content-log group is therefore **discovered by prefix**
  `/aws/bedrock-agentcore/runtimes/harness_{harnessName}-` (unique-per-harness;
  a re-created harness leaves stale groups → newest creationTime wins).
- The log group only exists after the harness's FIRST invocation — cold
  harnesses get 400 `eval.harness_no_telemetry` ("run a chat session first").
- Proven end-to-end: window-scope run `fbbd4043f0fe` on hr-assistant →
  COMPLETED, Correctness 1.0 / Helpfulness 0.83.

### 2. Signatures

```python
resolve_telemetry(agent, logs_client=None) -> (service_name, log_group)
# harness → _harness_telemetry: base = resource_id.rsplit("-", 1)[0];
#   service = f"harness_{base}.DEFAULT"; log group by describe_log_groups prefix
# runtime methods → f"{agentRuntimeName}.DEFAULT" + derived runtimes/{id}-DEFAULT group
execute_run(..., method: str, ...)   # dataset invoking dispatches:
# harness → hc.invoke_harness_text (InvokeHarness) · else rt.invoke_runtime_text
```

Frontend dropdown filter is `status === "active"` only. **Experiments still
exclude harness** (`EvaluationExperiment.tsx` + POST /api/experiments gate) —
the A/B mechanism needs config-bundle support harnesses don't have; do not
"fix" that filter by analogy.

### 3. Wrong vs Correct

```python
# WRONG: deriving the harness content-log group from the ledger resource_id
log_group = f"/aws/bedrock-agentcore/runtimes/{agent.resource_id}-DEFAULT"  # 404s
# CORRECT: prefix-discover harness_{base}-* and take the newest -DEFAULT group

# WRONG: invoking harness dataset sessions through the runtime data plane
rt.invoke_runtime_text(data, harness_arn, ...)   # wrong API for harness ARNs
# CORRECT: method-dispatch to hc.invoke_harness_text
```

### 4. Tests

`tests/evaluation/test_runs_flow.py::test_harness_run_completes` (service name,
newest-group pick, InvokeHarness dispatch, scores) and
`::test_harness_without_telemetry_group_rejected` (cold harness 400).
