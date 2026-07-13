# Harness agents in evaluation: feasibility probe + enablement

## Goal

Evaluation (new run / insight) currently excludes managed-harness agents:
frontend filter `Evaluation.tsx:222` + backend gate
`evaluation/service.py:resolve_telemetry` (400 `eval.method_unsupported`),
rationale "no span service name for scoping". Probe live whether harness
sessions in aws/spans actually carry a usable service.name + evaluation-parseable
instrumentation scopes; if yes, enable harness in the eval pipeline.

## Requirements

- R1 (research, live): using kept demo harness `hr-assistant` — inspect its
  spans in aws/spans (service.name, scope names, gen_ai attrs), and how the
  observability module already maps harness telemetry. Determine what
  StartBatchEvaluation needs (session scoping inputs) and whether harness
  sessions satisfy it.
- R2 (if feasible): harness branch in `resolve_telemetry` (+ any invoke-path
  changes), widen `EVAL_SUPPORTED_METHODS`, drop the frontend dropdown filter
  (run/insight + keep experiment gate separate unless it also works), tests.
- R3 (verify): a real eval run (small dataset or window scope) against
  hr-assistant completes with scores.
- If NOT feasible: document the precise blocker (span evidence) in the spec and
  surface a clearer UI hint; report back.

## Acceptance Criteria

- [ ] Written probe evidence: harness span service.name / scopes / gen_ai content.
- [ ] Either: live harness eval run COMPLETED with scores + code enabled + tests
      green; or: documented infeasibility with span-level evidence.
