# Agent SDK create: registry-linked capabilities + custom skill sources + filesystem config

## Goal

For the **Claude Agent SDK** creation method (`method="container"`) in the Create Agent
wizard:

1. Make the CAPABILITIES module consume the Registry — APPROVED remote **MCP** servers
   and **AGENT_SKILLS** become selectable chips (today the container branch shows two
   hardcoded static chips and skills are harness-only).
2. Add a **custom skill source** that bypasses registry registration: upload a `.zip`
   directly, or point at a GitHub repo — the skill(s) are staged to S3 and attached to
   the agent without creating a registry record.
3. Add **AgentCore Runtime filesystem configuration** to the Claude Agent SDK config:
   default **Managed session storage** (user can disable), plus optional **BYO S3 Files**
   and **BYO EFS** access-point mounts.
4. Full test coverage (backend pytest) + Playwright browser verification.

## Background facts (verified 2026-07-12)

- `filesystemConfigurations` on Create/UpdateAgentRuntime (botocore 1.43.44 in
  `backend/.venv`) is a union list: `sessionStorage{mountPath}` |
  `s3FilesAccessPoint{accessPointArn,mountPath}` | `efsAccessPoint{accessPointArn,mountPath}`.
- Limits: ≤5 total, ≤1 sessionStorage, ≤2 s3FilesAccessPoint, ≤2 efsAccessPoint.
  Mount path: `/mnt/<single-level>` matching `/mnt/[a-zA-Z0-9._-]+/?`, 6–200 chars,
  unique, non-nested.
- BYO (S3 Files / EFS) requires `networkConfiguration.networkMode=VPC` with
  `networkModeConfig{subnets, securityGroups}` + execution-role IAM
  (`s3files:ClientMount/ClientWrite/GetAccessPoint` or
  `elasticfilesystem:ClientMount/ClientWrite`) + SG egress TCP 2049.
  Session storage needs no VPC and no extra IAM.
- Session storage lifecycle: per-session isolation, survives stop/resume,
  **wiped on runtime version update** (i.e. every re-publish), 14-day idle expiry.
- Current container path: `networkMode=PUBLIC` hardcoded, no filesystem params
  (`backend/app/services/agentcore/runtime.py:43-62,97-114`).

## Requirements

### R1 — Registry-linked CAPABILITIES for container method
- Container branch of the CAPABILITIES section shows, in addition to the informational
  `Task · subagents` / `fact-checker` chips:
  - selectable chips for APPROVED non-gateway remote MCP records (same source as the
    harness branch: `GET /api/registry/attachables`).
  - the SKILLS chip picker (currently gated `method==="harness"`) also for container.
- Selected remote MCP servers land in `spec.tools` as `{type:"mcp", name, config:{url}}`
  and are merged into the generated `MCP_SERVERS` (`{name: {type:"http", url}}`) in the
  rendered `main.py`, alongside the existing free-text MCP JSON textarea.
- Selected skills (registry `path` = `s3://…/skills/{name}/`) land in `spec.skills` and
  are **bundled into the container image** at build time under `.claude/skills/{name}/`
  so the Claude Code CLI discovers them via `setting_sources`.
- `allowed_tools` in the rendered main.py must permit the wired capabilities:
  `Task`, plus `Skill` when skills are present, plus `mcp__{server}` per MCP server
  (registry-selected and free-text-JSON keys alike).
- Gateway targets stay harness-only (gateway auth is not wired for the SDK path).

### R2 — Custom skill source (no registry record)
- In the create page skills section (container + harness), user can:
  - upload a skill `.zip` (same safety pipeline as registry ingestion), or
  - give a git repo URL (optional ref/subdir; monorepos yield multiple skills — user
    picks which to attach).
- Backend stages the bundle(s) to S3 under a non-registry prefix and returns
  `{name, description, path}` entries; the frontend adds them as selected skill chips.
- No registry record is created; registry list/attachables are unaffected.
- Validation caps and safety (zip-bomb/traversal/SSRF/description ≤1024) reuse
  `skill_ingest` as-is.

### R3 — Filesystem configuration (container method only)
- New "FILESYSTEM" group in the container config form:
  - **Managed session storage**: toggle, default ON, mount path input default
    `/mnt/workspace`.
  - **BYO S3 Files**: up to 2 rows of {access point ARN, mount path}.
  - **BYO EFS**: up to 2 rows of {access point ARN, mount path}.
  - When ≥1 BYO row exists, a VPC sub-form (subnet IDs, security group IDs) appears and
    is required.
- Spec carries the config; the deploy stage passes `filesystemConfigurations` (and
  `networkConfiguration=VPC` when BYO present) on Create/UpdateAgentRuntime.
- When BYO mounts are present, the provision stage attaches the required mount
  permissions to the shared execution role as an inline policy scoped to the given
  access points (removed on agent delete, best-effort).
- Validation (backend pydantic, mirrored client-side where cheap): mount-path pattern /
  uniqueness / count limits; ARN service sanity (`s3files` vs `elasticfilesystem`);
  VPC required with ≥1 subnet and ≥1 SG when BYO present.
- Re-publish keeps working for pre-existing agents whose spec has no `filesystem` key
  (default applies: session storage ON — harmless since a version update resets session
  storage anyway; the UI shows a note about the reset).
- Other methods (harness / zip_runtime / studio) are out of scope: the spec field exists
  but only the container deployer consumes it.

### R4 — Tests & verification
- Backend pytest: spec validation, runtime wrapper param construction, template
  rendering (skills bundling, MCP merge, allowed_tools), custom skill-source endpoint
  (zip + git + error matrix), agents API create/redeploy with the new fields, IAM
  policy attach logic. No real AWS in unit tests (stub clients, monkeypatch).
- Browser verification: Playwright evidence script(s) with `page.route` fetch stubs
  covering — container CAPABILITIES with registry chips, custom zip/git skill flow,
  filesystem defaults, BYO reveal + VPC requirement, edit/re-publish state reload.

## Acceptance Criteria

- [ ] Container create form shows registry MCP + skill chips (from attachables) and the
      selected ones survive a round-trip through `startEdit` (re-publish editing).
- [ ] `buildSpec` for container includes `tools` (mcp refs), `skills`, `filesystem`,
      `network`; harness payload is unchanged from today's for the same inputs.
- [ ] Rendered `main.py` contains merged MCP_SERVERS (registry + textarea JSON) and
      correct ALLOWED_TOOLS (`Task`/`Skill`/`mcp__*`); build context contains
      `.claude/skills/{name}/**` for every spec skill (downloaded from S3).
- [ ] `POST` custom skill source (zip and git) returns attachable `{name,path}` entries,
      uploads to a non-registry S3 prefix, enforces the ingestion error matrix
      (400/413/422), and creates no registry record.
- [ ] CreateAgentRuntime/UpdateAgentRuntime receive `filesystemConfigurations` matching
      the spec (session/s3/efs union members) and `networkConfiguration` flips
      PUBLIC→VPC exactly when BYO mounts exist.
- [ ] Invalid filesystem specs (bad mount path, >2 s3, missing VPC with BYO, dup paths)
      are rejected 422 with the standard error envelope.
- [ ] Inline role policy for BYO mounts is attached on provision & detached on delete
      (verified with stubbed IAM client).
- [ ] All existing backend tests still pass (`pytest backend/tests`).
- [ ] Playwright browser evidence captured for the states listed in R4.

## Non-goals / deferred

- Gateway MCP chips for the container method (needs auth wiring).
- Filesystem config for harness/zip_runtime/studio methods.
- Provisioning of the S3 Files / EFS access points themselves (user supplies ARNs;
  Launchpad only mounts them).
- Registry record creation from the custom-source flow ("promote to registry" later).
- TTL cleanup of orphaned custom-skill S3 staging prefixes (documented, not built).
