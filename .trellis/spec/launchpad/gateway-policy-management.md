# Existing Gateway Policy Management

## Scenario: Govern an existing AgentCore MCP Gateway

### 1. Scope / Trigger

Use this contract when changing Gateway discovery, Gateway-level Registry
records, Harness attachment, Policy lifecycle, decision evidence, or the
Governance console. AWS is the source of current Gateway, Registry, Engine,
Policy, and telemetry state. SQLite stores only immutable mutation history and
operation progress.

### 2. Signatures

Core console APIs:

```text
GET    /api/governance/gateways
GET    /api/governance/gateways/{gateway_id}
POST   /api/governance/gateways/{gateway_id}/manage
DELETE /api/governance/gateways/{gateway_id}/manage
GET    /api/governance/gateways/{gateway_id}/registry-preview
POST   /api/governance/gateways/{gateway_id}/registry-import
POST   /api/governance/gateways/{gateway_id}/retire-legacy-records
POST   /api/governance/gateways/{gateway_id}/engine
GET    /api/governance/gateways/{gateway_id}/policies
POST   /api/governance/gateways/{gateway_id}/policies
PUT    /api/governance/gateways/{gateway_id}/policies/{policy_id}
POST   /api/governance/gateways/{gateway_id}/policies/{policy_id}/promote
POST   /api/governance/gateways/{gateway_id}/policies/{policy_id}/rollback
POST   /api/governance/gateways/{gateway_id}/mode
GET    /api/governance/gateways/{gateway_id}/decisions
GET    /api/governance/gateways/{gateway_id}/audit
GET    /api/governance/operations/{operation_id}
```

The `policy_changes` table stores Gateway/Engine/Policy identifiers, operator,
operation, before/requested/after JSON, expected timestamp, override reason,
status, error, and timestamps. Identifier and request snapshots are immutable
after insertion.

### 3. Contracts

- Listing and detail calls are read-only live AWS reads.
- Managed state is exactly the two Launchpad-owned Gateway tags. Unmanage
  removes only those tags.
- One Gateway maps to one MCP Registry record. Registry approval controls
  catalog visibility; it never changes Gateway targets or Policy.
- A Gateway record exposes the full Gateway. Harness auth is derived
  server-side: `AWS_IAM -> awsIam`, no auth -> `none`, managed
  `launchpad-gw` CUSTOM_JWT -> configured OAuth. Other CUSTOM_JWT Gateways are
  catalog-only.
- Mutations re-read live state and compare
  `expected_gateway_updated_at`/`expected_policy_updated_at`.
- Shared Engine mutations require the complete live
  `acknowledged_gateway_ids` set.
- New Engine attachments and policies start `LOG_ONLY`.
- Editing ACTIVE creates a LOG_ONLY candidate. Cutover activates candidate
  first; rollback reactivates original first.
- Mutation response: `{"operation": GovernanceOperation}`. Polling uses the
  same envelope.
- Generation start response:
  `{"operation": ..., "generation_id": ..., "status": ...}`.
- Policy decisions return an explicit `available=false` until real Policy span
  fields have been captured. Never infer rollout evidence from demo rows.

### 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Gateway absent/non-MCP | `governance.gateway_not_found` or `gateway_unsupported` |
| Mutation on unmanaged Gateway | `governance.gateway_not_managed` |
| Live `updatedAt` differs | `governance.concurrent_change` |
| Shared Engine acknowledgement stale | `governance.shared_engine_changed` |
| IAM simulation deny/unknown | `governance.iam_preflight_failed`/`unknown` |
| Registry name points to another URL | `governance.registry_name_conflict` |
| Legacy retirement before Gateway record approval | `governance.registry_record_not_approved` |
| Promotion has no evidence and no typed override | `governance.evidence_required` |
| Confirmation name differs | `governance.confirmation_mismatch` |
| Second mutation while one is running | `governance.operation_in_flight` |

### 5. Good/Base/Bad Cases

- Good: manage a READY disposable Gateway, attach in LOG_ONLY, create a
  LOG_ONLY policy, observe decisions, then explicitly promote.
- Base: read an unmanaged Gateway and preview its catalog without changing AWS.
- Bad: trust browser-supplied OAuth/provider data, treat a Registry target as
  an authorization boundary, replace an attached Engine, or auto-edit an
  external Gateway IAM role.

### 6. Tests Required

- Wrapper tests assert pagination, wait failures, and complete UpdateGateway
  payload preservation.
- Gateway tests assert read-only discovery, tag-only management, exact action
  names, shared impact, and IAM pass/fail/unknown.
- Registry/Harness tests assert one Gateway record, idempotent import,
  explicit legacy retirement, server-side auth, multiple Gateways, and legacy
  config-less refs.
- Lifecycle tests assert LOG_ONLY update, ACTIVE candidate, conservative
  cutover/partial retry/rollback, timestamp conflict, mutex, and audit
  immutability.
- Router tests assert operation and generation envelopes match
  `frontend/src/lib/api.ts`.
- Final validation is `make verify`; real AWS runs use the guarded
  `backend/scripts/e2e_gateway_policy_management.py`.

### 7. Wrong vs Correct

#### Wrong

```python
# Browser data chooses credentials and a Registry target is treated as a
# separately attached/authorized tool.
outbound_auth = request.tool.config["outboundAuth"]
```

#### Correct

```python
# Resolve the approved record and live Gateway again, then derive auth from the
# live authorizer and Launchpad-managed provider mapping.
attachments = registry_console.resolve_gateway_attachments(spec.tools)
```

The same rule applies to Policy state: journal snapshots support audit and
rollback, but every current view and mutation preflight reads AWS again.
