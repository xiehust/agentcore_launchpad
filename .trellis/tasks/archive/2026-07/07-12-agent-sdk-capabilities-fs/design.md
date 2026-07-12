# Design — registry-linked capabilities + custom skill sources + filesystem config

## 0. Shape of the change

Additive, no data migration. Four seams:

1. **Spec** (`backend/app/schemas/agent.py`) — new `filesystem` + `network` fields with
   full validation; `skills`/`tools` reused as-is for the container method.
2. **Container build & deploy** (`backend/app/templates/claude_sdk_agent/__init__.py`,
   `backend/app/deployer/container.py`, `backend/app/deployer/zip_runtime.py`,
   `backend/app/services/agentcore/runtime.py`) — skills bundled into the image, MCP
   merge, allowed_tools, filesystemConfigurations + VPC network, IAM inline policy.
3. **Custom skill attach** (new `backend/app/routers/agent_skills.py`, small refactor in
   `backend/app/services/registry_console.py`) — reuses the registry *inspect* staging,
   adds an upload-without-record endpoint.
4. **Frontend** (`frontend/src/pages/CreateAgent.tsx`, `frontend/src/lib/api.ts`,
   locale files) — container CAPABILITIES chips, custom-source UI, FILESYSTEM group.

## 1. Spec schema (`backend/app/schemas/agent.py`)

```python
MOUNT_PATH_RE = r"^/mnt/[a-zA-Z0-9._-]+/?$"   # AWS: single level under /mnt, 6–200 chars

class SessionStorageFs(BaseModel):
    mount_path: str = Field(default="/mnt/workspace", pattern=MOUNT_PATH_RE,
                            min_length=6, max_length=200)

class ByoMount(BaseModel):
    access_point_arn: str = Field(min_length=20, max_length=2048)
    mount_path: str = Field(pattern=MOUNT_PATH_RE, min_length=6, max_length=200)

class VpcNetwork(BaseModel):
    subnets: list[str] = Field(min_length=1, max_length=8)
    security_groups: list[str] = Field(min_length=1, max_length=5)

class FilesystemConfig(BaseModel):
    # default ON — explicit JSON null disables it ("user can cancel")
    session_storage: SessionStorageFs | None = Field(default_factory=SessionStorageFs)
    s3_files: list[ByoMount] = Field(default_factory=list, max_length=2)
    efs: list[ByoMount] = Field(default_factory=list, max_length=2)

    @property
    def byo(self) -> bool: return bool(self.s3_files or self.efs)

    # model_validator(mode="after"):
    #  - mount paths unique across session+s3+efs (pattern already forbids nesting)
    #  - s3_files ARNs must contain ":s3files:" and "/access-point/"
    #  - efs ARNs must match  ^arn:aws[\w-]*:elasticfilesystem:[^:]*:\d{12}:access-point/

class AgentSpec(BaseModel):
    ...
    filesystem: FilesystemConfig = Field(default_factory=FilesystemConfig)
    network: VpcNetwork | None = None
    # model_validator: filesystem.byo and network is None → ValueError
    # ("BYO file systems require VPC network configuration")
```

Compatibility: old stored specs revalidate — `filesystem` defaults to
session-storage-ON, `network` None. The validator must NOT require `network` for a
default (session-only) config. Count limit ≤5 total is implied by 1+2+2.

## 2. Container template (`app/templates/claude_sdk_agent/__init__.py`)

`render_main_py(spec)` changes:

```python
def _skill_name(path: str) -> str:            # "s3://…/skills/web-analyzer/" → "web-analyzer"
    return path.rstrip("/").rsplit("/", 1)[-1]

def _mcp_servers(spec) -> dict:
    free = json.loads(spec.env.get("LAUNCHPAD_MCP_SERVERS") or "{}")  # tolerate bad JSON → {}
    registry = {t.name: {"type": "http", "url": t.config["url"]}
                for t in spec.tools if t.type == "mcp" and t.config.get("url")}
    return {**free, **registry}               # registry chips win on key collision

allowed = ["Task"]
if spec.skills: allowed.append("Skill")
allowed += [f"mcp__{name}" for name in mcp_config]   # every merged server
```

Rationale: today `ALLOWED_TOOLS = [t.name for mcp tools] or ["Task"]` — container specs
never carried tools, so the observable output was always `["Task"]`; free-text MCP
servers were configured but their tools not allow-listed (latent bug). New mapping uses
Claude Code's `mcp__<server>` allow-list convention and fixes that. `Skill` is the tool
Claude Code uses to invoke agent skills; skills land in `/app/.claude/skills/` next to
the existing `agents/fact-checker.md` (same discovery mechanism, `HOME=/app`).

`assemble_build_context` stays pure (no AWS) — skill download happens in the deployer
(next section) into `context_dir/.claude/skills/`.

## 3. Skill bundling into the image (`deployer/zip_runtime.py` + `container.py`)

New sibling of `bundle_skills_into` in `zip_runtime.py` (shares `_parse_s3_uri`,
`_download_skill_prefix`, the 50 MB cap and the "log + skip, never raise" posture):

```python
def bundle_skill_paths_into(paths, dest_parent, log, *, s3_client=None) -> dict:
    """Download each explicit s3://bucket/prefix/ into dest_parent/{name}/ —
    the spec.skills consumer (container path); no registry lookup, no code parsing."""
```

`container.py::_stage_generate`: after `assemble_build_context`, call
`bundle_skill_paths_into(spec.skills, context_dir/".claude"/"skills", ctx.log)`, include
the bundled file count in the stage detail. (`_stage_package`'s fallback
`assemble_build_context` re-run also re-bundles — extract a tiny
`_build_context(spec, agent, log)` helper used by both stages.)

## 4. Runtime wrappers (`services/agentcore/runtime.py`)

`create_container_runtime` / `update_container_runtime` gain keyword-only params,
default None (all call sites explicit, tests inject stub clients):

```python
def create_container_runtime(client, *, runtime_name, container_uri, role_arn,
                             environment=None,
                             filesystem_configurations: list[dict] | None = None,
                             vpc: dict | None = None) -> dict:
    params["networkConfiguration"] = (
        {"networkMode": "VPC", "networkModeConfig": {"subnets": vpc["subnets"],
                                                     "securityGroups": vpc["security_groups"]}}
        if vpc else {"networkMode": "PUBLIC"})
    if filesystem_configurations:
        params["filesystemConfigurations"] = filesystem_configurations
```

Spec→AWS conversion lives in `deployer/container.py` (pure, unit-testable):

```python
def _filesystem_configurations(spec) -> list[dict]:
    # [{"sessionStorage": {"mountPath": …}}, {"s3FilesAccessPoint": {...}}, {"efsAccessPoint": {...}}]
def _vpc(spec) -> dict | None:   # {"subnets": [...], "security_groups": [...]} or None
```

`_stage_deploy._kwargs()` passes both. Update path (re-publish) sends the same params —
UpdateAgentRuntime accepts `filesystemConfigurations`, and a version bump resets managed
session storage (documented in the UI note).

## 5. IAM inline policy for BYO mounts (`deployer/container.py` provision stage)

```python
def _fs_policy_document(spec) -> dict | None:
    # S3 Files stmt: Action [s3files:ClientMount, s3files:ClientWrite, s3files:GetAccessPoint]
    #   Resource: access-point ARN with "/access-point/…" stripped (the file-system ARN)
    #   Condition: ArnEquals s3files:AccessPointArn = [arns]
    # EFS stmt:   Action [elasticfilesystem:ClientMount, elasticfilesystem:ClientWrite]
    #   Resource: "*"  (FS ARN not derivable from an AP ARN)
    #   Condition: ArnEquals elasticfilesystem:AccessPointArn = [arns]
```

`_stage_provision`: role name = `role_arn.rsplit("/", 1)[-1]`, policy name =
`launchpad-fs-{agent.name}`. BYO present → `iam.put_role_policy`; absent →
best-effort `iam.delete_role_policy` (cleans up when mounts are removed on re-publish).
`delete_agent_resources` also best-effort-deletes the policy. IAM client is a parameter
with a boto3 default so tests stub it.

## 6. Custom skill attach — reuse inspect, add attach-without-record

Frontend calls the **existing** `POST /api/registry/skills/inspect` (multipart zip or
JSON git/url source) for acquisition + validation + preview — zero new ingestion code,
full error matrix inherited (400/413/422/503 + SSRF guard).

New router `backend/app/routers/agent_skills.py`, mounted at `/api/agent-skills`
(avoids any overlap with `/api/agents/{agent_id}` route shapes):

```
POST /api/agent-skills/import   {staging_id, selections: [{index?, name?}]}
→ 200 {skills: [{name, ok, path?, description?, error?, error_code?}]}
```

Behavior mirrors registry import except **no record is created**: each selected staged
bundle's files upload to `s3://{artifacts_bucket}/agent-skills/{uid8}/{name}/`
(`uid8 = uuid4().hex[:8]` per request). Same staging store + `_match_bundle` semantics —
factor `_STAGING` access + `_match_bundle` into shared helpers in `registry.py` (import
from there; no behavior change to registry routes). Staging is dropped only when every
selection succeeded (same retry semantics as registry import). Name collisions inside
one request → per-item error `registry.name_exists`-style code `agents.skill_name_dup`.

S3 upload loop: factor the file-walk/upload from
`registry_console.register_skill_bundle` into
`upload_bundle_files(bundle, bucket, prefix, s3) -> list[str]` used by both callers
(registry path keeps its cleanup-on-failure semantics).

The returned `path` (`s3://…/agent-skills/{uid8}/{name}/`) is a plain skills prefix —
both the harness deployer (`_skill_source`) and the new container bundler consume it
with no changes. Orphaned prefixes (user never launches) are accepted (documented
non-goal; same bucket already holds per-build sources).

## 7. Frontend (`CreateAgent.tsx`, `lib/api.ts`, locales)

New state:

```ts
const [customSkills, setCustomSkills] = useState<{name: string; path: string}[]>([]);
const [sessionFs, setSessionFs] = useState(true);
const [sessionMount, setSessionMount] = useState("/mnt/workspace");
const [s3Mounts, setS3Mounts] = useState<{arn: string; path: string}[]>([]);   // ≤2
const [efsMounts, setEfsMounts] = useState<{arn: string; path: string}[]>([]); // ≤2
const [vpcSubnets, setVpcSubnets] = useState("");  // comma/space separated ids
const [vpcSgs, setVpcSgs] = useState("");
```

**CAPABILITIES (container branch)**: keep the two informational chips, append the same
`remoteMcp` selectable chips the harness branch renders (shared `selectedMcp` state).
Skills picker condition widens from `method === "harness"` to
`method === "harness" || method === "container"`; inside it, custom chips from
`customSkills` render with names (existing "path not in catalog" chips remain the
fallback for edit-reload).

**Custom source controls** (inside the skills field): `[UPLOAD .ZIP]` (hidden file
input) and `[FROM GIT]` (url + optional ref/subdir inline inputs). Both call
`api.inspectSkillSource(...)` → discovered valid skills render as pending chips; clicking
one calls `api.attachSkillSource(stagingId, {index})` → on ok, push to `customSkills` +
`skills`. Errors surface via the existing toast + `apiErrors.*` i18n mapping.

**FILESYSTEM group** (container only, after the MCP textarea):

```
FILESYSTEM — AGENTCORE RUNTIME
[✓] managed session storage   mount: [/mnt/workspace]
[＋ S3 FILES MOUNT] [＋ EFS MOUNT]        (each row: ARN input · mount input · ✕)
(when byo) VPC REQUIRED: subnets [subnet-a, subnet-b]  security groups [sg-…]
note: re-publish creates a new runtime version — session storage is reset
```

`buildSpec()` additions (container only; harness payload untouched):

```ts
tools: method === "harness" ? […existing…]
     : selectedMcp.flatMap(mcp {type:"mcp",name,config:{url}}),
...(skills.length && method !== "zip_runtime" ? { skills } : {}),
...(method === "container" ? {
  filesystem: {
    session_storage: sessionFs ? { mount_path: sessionMount } : null,
    s3_files: s3Mounts.map(m => ({ access_point_arn: m.arn, mount_path: m.path })),
    efs: efsMounts.map(m => ({ access_point_arn: m.arn, mount_path: m.path })),
  },
  ...(byo ? { network: { subnets: split(vpcSubnets), security_groups: split(vpcSgs) } } : {}),
} : {})
```

`configValid` for container additionally requires: session mount matches
`/^\/mnt\/[a-zA-Z0-9._-]+$/` when enabled; every BYO row has non-empty ARN + valid
mount; unique mounts; `byo → subnets && sgs non-empty`.

`startEdit` reads back `spec.filesystem` / `spec.network` / container `spec.tools`
(mcp → `selectedMcp`) / `spec.skills` (catalog match → chip name, else derive name from
path tail into `customSkills`). `resetForm` resets all new state.

`lib/api.ts`: `inspectSkillSource(input: File | {source: GitOrUrlSource})` (multipart vs
JSON to `/api/registry/skills/inspect`) and
`attachSkillSource(stagingId, selection)` → `POST /api/agent-skills/import`. `StoredSpec`
gains `filesystem?` / `network?`.

Locales: add `create.configure.*` keys to `frontend/src/locales/*/common.json` (check
which languages exist; keep parity).

## 8. Tests

Backend (all stub-based, no AWS):
- `test_agent_spec_filesystem.py` — defaults (session ON), null disables, mount regex,
  dup paths, >2 rows, ARN sanity, BYO-without-network 422 via API model, old-spec compat.
- `test_runtime_container_fs.py` — wrapper param construction: PUBLIC default,
  VPC + filesystemConfigurations passthrough on create & update (stub client records kwargs).
- `test_claude_sdk_template.py` (extend) — MCP merge precedence, ALLOWED_TOOLS
  (`Task`/`Skill`/`mcp__*`), bad free-text JSON tolerated, rendered main.py `py_compile`.
- `test_container_skill_bundle.py` — `bundle_skill_paths_into` downloads prefixes into
  `.claude/skills/{name}/` (stub s3 paginator), cap/skip behavior, name from path tail.
- `test_agent_skills_attach.py` — inspect→import happy path (zip fixture through the
  real staging), no registry record created, S3 keys under `agent-skills/`, staging
  survival on partial failure, expired staging 410, selection-by-index/name.
- `test_container_provision_iam.py` — `_fs_policy_document` shapes; put/delete
  role-policy calls (stub IAM) for byo/non-byo/delete.
- `test_agents_api.py` (extend) — create container agent with full new spec 200;
  invalid filesystem 422 envelope; redeploy round-trip preserves fields.

Frontend/browser: `frontend/scripts/` new Playwright evidence script with `page.route`
stubs (attachables, inspect, agent-skills import, agents POST): container capabilities
chips, custom zip+git flows, filesystem defaults, BYO→VPC reveal, invalid-mount disable,
edit reload. Screenshots under the script's evidence dir; dev server port confirmed
before capture (floats 5173/5174).

## 9. Compatibility / rollout / rollback

- Purely additive API surface; no DB migration (spec JSON column).
- Old agents: redeploy now sends `filesystemConfigurations=[sessionStorage@/mnt/workspace]`
  by default — allowed by UpdateAgentRuntime; session data was reset by the version bump
  regardless. Documented in UI note + spec guide.
- Harness/zip/studio paths untouched (buildSpec harness branch unchanged; deployers
  ignore the new fields).
- Rollback: revert the commit — stored specs with `filesystem`/`network` keys are
  ignored by pydantic? **No** — extra keys are dropped by default model config; verify
  `AgentSpec` doesn't use `extra="forbid"` (it doesn't — default ignore), so old code
  tolerates new stored specs. Runtime-side VPC/mount config persists until next deploy.

## 10. Open questions resolved

- **Gateway chips for container?** No — gateway MCP needs OAuth headers the SDK template
  doesn't wire. Harness-only (PRD non-goal).
- **Where does custom-source preview live?** Registry inspect endpoint, unchanged — the
  staging store is generic and record creation only happens at the registry's own
  `/skills/import`.
- **EFS policy Resource** — `"*"` + ArnEquals AccessPointArn condition (FS ARN not
  derivable from AP ARN); S3 Files uses the derived file-system ARN.
