# AgentCore Runtime filesystem configurations — verified facts (2026-07-12)

Source: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html
Cross-checked against `backend/.venv` botocore 1.43.44 service model (`bedrock-agentcore-control`).

## API shape (Create/UpdateAgentRuntime — both support it)

`filesystemConfigurations: list` — union members per entry (exactly one):

| Member | Fields | Notes |
|---|---|---|
| `sessionStorage` | `mountPath` | Managed, Preview. Max **1** per runtime. No VPC/IAM needed. |
| `s3FilesAccessPoint` | `accessPointArn`, `mountPath` | BYO. Max **2**. VPC required. |
| `efsAccessPoint` | `accessPointArn`, `mountPath` | BYO. Max **2**. VPC required. |

- ≤ **5** total configurations per runtime.
- Mount path: `/mnt/` + exactly one level, pattern `/mnt/[a-zA-Z0-9._-]+/?`, 6–200 chars,
  unique across all configs, non-nested.

## networkConfiguration (botocore-verified)

```
networkConfiguration: {networkMode: PUBLIC|VPC,
                       networkModeConfig: {subnets, securityGroups, requireServiceS3Endpoint}}
```
BYO file systems require `networkMode: VPC`; subnets must overlap mount-target AZs.

## IAM (execution role)

- S3 Files: `s3files:ClientMount`, `s3files:ClientWrite`, `s3files:GetAccessPoint`
  on the **file-system ARN** (AP arn = `arn:aws:s3files:R:A:file-system/FS/access-point/AP`
  → resource is the `file-system/FS` prefix), Condition `ArnEquals s3files:AccessPointArn`.
  `GetAccessPoint` is needed for validation **during runtime creation**.
- EFS: `elasticfilesystem:ClientMount`, `elasticfilesystem:ClientWrite`;
  EFS AP arn (`arn:aws:elasticfilesystem:R:A:access-point/AP`) does NOT embed the FS id
  → policy Resource `"*"` + `ArnEquals elasticfilesystem:AccessPointArn` condition.
- Security groups: TCP 2049 egress from runtime SG to mount-target SG (user-side setup).

## Lifecycle (drives UI copy)

| Behavior | Session storage | BYO |
|---|---|---|
| Idle expiry | 14 days → reset | none |
| Runtime version update (= every re-publish) | **wiped** | unaffected |
| DeleteAgentRuntime | all session data deleted | unmounted, data kept |
| Concurrency | per-session isolated | shared across sessions/agents |

Session storage: standard POSIX minus hard links / device files / xattr / fallocate /
cross-session locks; perms stored not enforced. Mounted only at invocation time.

## Local codebase facts

- `backend/.venv/bin/python` boto3 1.43.44 → all three union members present on
  Create + Update. System python (1.42.x) only has `sessionStorage` — always run
  backend code with the venv.
- Current container deploy: `networkMode: PUBLIC` hardcoded, no filesystem params
  (`backend/app/services/agentcore/runtime.py:43-62,97-114`).
- Execution role: shared `execution_role_arn` from `get_settings().resources`
  (bootstrap-provisioned), reused by `_stage_provision` (`deployer/container.py:85-90`).
