# PRD — Harness → runtime conversion (experiment enablement)

## Background / requirement source

Experiments exclude managed-harness agents for verified reasons
(2026-07-13, spec `evaluation-agent-eligibility.md`): the harness backing
runtime is invoke-locked (`InvokeAgentRuntime` → ValidationException, only
`InvokeHarness` works) and the managed code never reads
`get_config_bundle()`, so config-bundle A/B variants would no-op.

The working escape hatch, proven by hand on `aurora-support`:
`agentcore export harness --arn <harness-arn>` converts the harness into a
standard Strands runtime project whose entrypoint accepts `{"prompt"}`
payloads — deployed as a `zip_runtime` agent it becomes experiment-eligible
(and eval/chat capable). User request (2026-07-13, follow-up to the
verification): make this conversion a product capability.

## Requirements

- **R1 Conversion action.** A user can convert an active harness agent into
  a new runtime-backed agent from the launchpad UI. The conversion runs the
  export server-side and deploys the result through the existing zip_runtime
  pipeline; the outcome is a NEW agent row (`method="zip_runtime"` or a
  marked variant) — the original harness agent is untouched.
- **R2 Experiment-page guidance.** The experiment creation select surfaces
  harness agents as non-selectable entries with an explanatory hint and a
  path to conversion (instead of silently hiding them, which prompted this
  investigation in the first place).
- **R3 Fidelity.** The converted agent preserves what the export carries:
  baked system prompt, inline tools, and — where launchpad can wire them —
  gateway MCP attachments (KB retrieval) and memory via runtime environment
  variables. Anything not wired must degrade gracefully (the exported code
  already no-ops on missing env), and the conversion result must state
  what was and wasn't carried over.
- **R4 Progress + failure.** Conversion is a long operation (export seconds,
  deploy 5–15 min): it must ride an existing async pattern (deploy pipeline
  status) with visible progress and honest failure states.
- **R5 Traceability.** The converted agent records its source harness
  (spec field), visible in agent detail; converting the same harness again
  is either blocked while one conversion runs or produces a distinctly
  named new agent — no silent overwrite.
- **R6 i18n** en + zh-CN for all new strings.
- **R7 Entry points (user-confirmed 2026-07-13).** Conversion lives as a
  per-row action on harness agents in Agent Management (the converted agent
  is platform-wide usable); the experiment creation select shows harness
  agents as disabled entries hinting at that action. Interaction is
  one-click: convert → background export+deploy through the existing deploy
  status machinery → new agent appears when active (no preview step).

## Constraints

- Reuse the existing zip_runtime deploy pipeline and its status/progress
  machinery — no parallel deploy path.
- Export mechanism: shell out to the `agentcore` CLI (present on the host,
  requires a project cwd — a scratch project under the data dir) OR
  re-implement codegen from GetHarness; decide in design after research.
  CLI availability must be checked at request time with a clean error.
- The experiment eligibility gate itself does NOT change: harness stays
  excluded; only the path to a convertible runtime agent is added.
- No changes to the harness agent's own record or AWS resources.

## Acceptance criteria

- **A1** Converting `aurora-support` (or `hr-assistant`) from the UI yields
  a new active runtime agent whose chat answers reflect the harness's
  system prompt; the agent is selectable in experiment creation.
- **A2** The conversion runs asynchronously with visible progress and a
  failure path that leaves no half-registered agent row.
- **A3** The converted agent's detail view shows its source harness.
- **A4** Experiment creation shows harness agents as disabled entries with
  a conversion hint (en + zh-CN).
- **A5** Where gateway MCP / memory wiring is feasible, the converted agent
  retains KB retrieval / memory; where not, conversion succeeds with the
  degradation stated in the result. (Fidelity floor: prompt + inline tools.)
- **A6** Backend tests cover the conversion endpoint contract (happy path
  mocked, CLI-missing error, concurrent-conversion guard); full backend
  suite green; frontend lint/build green.
- **A7** Live evidence: one real conversion end-to-end (export → deploy →
  chat sanity → appears in experiment select).

## Out of scope

- Changing experiment mechanics or the harness exclusion gate.
- Reverse conversion (runtime → harness).
- TypeScript harness exports (Python/Strands only, matching the CLI's
  default and launchpad's zip pipeline).
- Auto-deleting or deprecating the source harness.
