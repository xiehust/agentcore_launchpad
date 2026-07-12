# Claude Agent SDK (container) — Registry Capabilities + Filesystem Config

## Scenario: extending the container method's capabilities or runtime storage

### 1. Scope / Trigger

Cross-layer contract between `frontend/src/pages/CreateAgent.tsx` (container
branch), `backend/app/schemas/agent.py`, `backend/app/deployer/container.py`,
`backend/app/templates/claude_sdk_agent/`, `backend/app/routers/agent_skills.py`
and `backend/app/services/agentcore/runtime.py`. Touch this spec when you add a
capability source, change filesystem/VPC handling, or alter what gets baked into
the container image. Introduced by task `07-12-agent-sdk-capabilities-fs`.

**Load-bearing AWS facts** (verified 2026-07-12, botocore 1.43.44 + devguide
`runtime-filesystem-configurations`):
- `filesystemConfigurations` (Create/UpdateAgentRuntime) is a union list:
  `sessionStorage{mountPath}` | `s3FilesAccessPoint{accessPointArn,mountPath}` |
  `efsAccessPoint{accessPointArn,mountPath}`. Limits: ≤5 total, ≤1 session,
  ≤2 s3, ≤2 efs. Mount path `/mnt/<one-level>` (`/mnt/[a-zA-Z0-9._-]+/?`,
  6–200 chars, unique, non-nested).
- BYO (s3/efs) REQUIRES `networkMode: VPC` + `networkModeConfig{subnets,
  securityGroups}` + execution-role mount permissions + TCP 2049 egress.
  Session storage needs none of that.
- Session storage is per-session, survives stop/resume, **reset on every
  runtime version update (= every re-publish)**, 14-day idle expiry.
- System python's botocore (1.42.x) lacks the BYO members — always run backend
  code with `backend/.venv`.

### 2. Signatures

```python
# schemas/agent.py
class FilesystemConfig:   # AgentSpec.filesystem (default: session ON @ /mnt/workspace)
    session_storage: SessionStorageFs | None   # JSON null = disabled
    s3_files: list[ByoMount]  # ≤2, ARN must contain :s3files: …/access-point/
    efs: list[ByoMount]       # ≤2, ARN must match elasticfilesystem access-point
    byo: bool                 # property
AgentSpec.network: VpcNetwork | None  # REQUIRED when filesystem.byo (model_validator)

# deployer/container.py (pure, unit-tested)
_filesystem_configurations(spec) -> list[dict]  # AWS union shapes
_vpc(spec) -> dict | None                       # only when byo AND network set
_fs_policy_document(spec) -> dict | None        # s3files: FS-arn resource; efs: "*" + AP condition
_sync_fs_policy(iam, role_arn, agent, spec, log)  # put/delete launchpad-fs-{agent.name}
_build_context(spec, agent, log) -> Path        # assemble + bundle spec.skills into .claude/skills/

# deployer/zip_runtime.py
bundle_skill_paths_into(paths, dest_parent, log, *, s3_client=None)  # explicit s3 prefixes

# services/agentcore/runtime.py — create/update_container_runtime new kwargs
filesystem_configurations: list[dict] | None, vpc: dict | None  # vpc→networkMode VPC

# templates/claude_sdk_agent/__init__.py
_mcp_servers(spec)  # env LAUNCHPAD_MCP_SERVERS JSON ∪ spec.tools mcp refs (registry wins)
# ALLOWED_TOOLS = ["Task"] + ["Skill" if spec.skills] + ["mcp__{k}" per merged server]
```

HTTP: `POST /api/agent-skills/import {staging_id, selections:[{index?,name?,
name_override?}]}` → `{skills:[{name, ok, path?, description?, error?,
error_code?}]}`. Consumes the registry's inspect staging
(`/api/registry/skills/inspect`) but uploads to
`s3://{artifacts_bucket}/agent-skills/{uid8}/{name}/` and creates **no registry
record**. Staging drops only when every selection succeeded (frontend batches
its picks in ONE call — per-item calls would drop staging after the first).

### 3. Contracts

- Container capabilities: `spec.tools` mcp refs (`{type:"mcp",name,config.url}`)
  → merged into rendered `MCP_SERVERS` as `{name:{type:"http",url}}`; registry
  entries override same-named free-text JSON keys. Gateway targets are
  harness-only (no auth wiring in the SDK template).
- `spec.skills` (both registry `skills/{name}/` and custom
  `agent-skills/{uid}/{name}/` prefixes) are downloaded at generate-time into
  the build context `.claude/skills/{name}/` — the claude CLI discovers them
  next to `agents/` (HOME=/app). Skill failures log + skip, never sink a deploy.
- Deploy passes `filesystemConfigurations` + `vpc` on BOTH create and update;
  network flips PUBLIC→VPC exactly when BYO mounts exist. Old specs (no
  `filesystem` key) default to session-ON — safe because the version bump resets
  session storage anyway.
- IAM: inline policy `launchpad-fs-{agent.name}` on the shared execution role;
  attached when BYO, deleted when mounts removed or agent deleted (best-effort).
- Frontend `buildSpec()` sends `filesystem`/`network` for container only;
  harness payload unchanged. Edit reload derives custom-chip names from the
  path tail (`/agent-skills/` marker).

### 4. Validation & Error Matrix

| Condition | Error |
|---|---|
| bad mount path / dup paths / >2 rows / wrong-service ARN | 422 `validation.invalid_request` (pydantic) |
| BYO mounts with `network: null` | 422 (`AgentSpec` model_validator) |
| attach with unknown/expired staging | 410 `registry.staging_expired` |
| attach selection not staged | per-item `registry.skill_not_staged` |
| bad name override / invalid bundle | per-item `registry.skill_invalid` |
| S3 failure mid-upload | per-item `agents.skill_attach_failed`, partial keys deleted |

### 5. Tests Required

`test_agent_spec_filesystem.py` (validators), `test_runtime_container_fs.py`
(param shapes create+update), `test_container_provision_iam.py` (policy doc +
lifecycle), `test_container_skill_bundle.py` (S3→.claude/skills),
`test_claude_sdk_template.py` (MCP merge/ALLOWED_TOOLS),
`test_agent_skills_attach.py` (staging→S3, no record, cleanup),
`test_agents_api.py::test_create_container_agent_*` (API round-trip).
Browser evidence: `frontend/scripts/sdk_caps_fs_evidence.mjs` →
`design/screenshots/agent-sdk-caps-fs/`.

### 6. Wrong vs Correct

```python
# WRONG: requiring network for every container spec (breaks old agents + session-only)
if spec.method == "container" and spec.network is None: raise ...
# CORRECT: gate on BYO only
if self.filesystem.byo and self.network is None: raise ...

# WRONG: deriving the EFS file-system ARN from the access-point ARN (not encoded there)
resource = efs_ap_arn.split("/access-point/")[0]
# CORRECT: Resource "*" scoped by the ArnEquals AccessPointArn condition

# WRONG (frontend): attaching monorepo picks one-per-request
for i of picked: api.attachSkillSources(sid, [{index: i}])   # 1st success drops staging → 410
# CORRECT: one batched call
api.attachSkillSources(sid, picked.map(index => ({index})))
```
