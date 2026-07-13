# Launchpad App Guidelines (backend + frontend)

> Code-specs for the main AgentCore Launchpad app (`backend/`, `frontend/`).
> Vendor packages (lab4-interactive, strands_ui) have their own spec layers.

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Registry Skill Ingestion](./registry-skill-ingestion.md) | Multi-source skill pipeline: SkillBundle, inspect→import staging, git/url acquirers, reimport, record update (PUT) + register/edit sub-pages | Active |
| [Container Capabilities + Filesystem](./container-capabilities-filesystem.md) | Claude Agent SDK (container) method: registry MCP/skill wiring, attach-without-record skill sources (/api/agent-skills), filesystemConfigurations (session/S3 Files/EFS) + VPC + IAM inline policy | Active |
| [Evaluation Agent Eligibility](./evaluation-agent-eligibility.md) | Which methods are eval-supported + telemetry resolution: harness span identity (harness_{name}.DEFAULT, strands scope), backing-runtime log-group prefix discovery, InvokeHarness dispatch | Active |

**Language**: All documentation should be written in **English**.
