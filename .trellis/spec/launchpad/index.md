# Launchpad App Guidelines (backend + frontend)

> Code-specs for the main AgentCore Launchpad app (`backend/`, `frontend/`).
> Vendor packages (lab4-interactive, strands_ui) have their own spec layers.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Registry Skill Ingestion](./registry-skill-ingestion.md) | Multi-source skill pipeline: SkillBundle, inspect→import staging, git/url acquirers, reimport, record update (PUT) + register/edit sub-pages | Active |
| [Container Capabilities + Filesystem](./container-capabilities-filesystem.md) | Claude Agent SDK (container) method: registry MCP/skill wiring, attach-without-record skill sources (/api/agent-skills), filesystemConfigurations (session/S3 Files/EFS) + VPC + IAM inline policy | Active |
| [Evaluation Agent Eligibility](./evaluation-agent-eligibility.md) | Which methods are eval-supported + telemetry resolution: harness span identity (harness_{name}.DEFAULT, strands scope), backing-runtime log-group prefix discovery, InvokeHarness dispatch | Active |
| [Evaluation Cloud Dataset Runs](./evaluation-cloud-dataset-runs.md) | AWS cloud datasets + simulated personas as run scopes: ListDatasetExamples-driven execution (no AWS-side dataset source), SDK LLM-actor simulation w/ per-run actor_model_id, cloud: scope encoding, lazy GT detail endpoint | Active |
| [Managed Knowledge Bases](./managed-kb.md) | Managed KB CRUD + S3 sources + Playground; launchpad-kb-gw connector topology (per-KB Retrieve + per-agent AgenticRetrieveStream targets), harness-only attach, kb-role IAM, async create/ingest quirks | Active |
| [Experiment Stepwise Actions](./experiment-stepwise.md) | User-triggered stage actions (`POST /experiments/{id}/action` verb set, 202/200 semantics), running_action/progress polling contract, artifact-driven stage cards, old-row compat, stale-action startup sweep | Active |
| [Harness → Runtime Conversion](./harness-conversion.md) | `POST /agents/{id}/convert`: agentcore CLI export + mandatory config-bundle graft + AgentSpec.code_bundle multi-file deploy; fidelity policy (memory wired, KB gateway not), SSE flattening for streaming runtimes | Active |

**Language**: All documentation should be written in **English**.
