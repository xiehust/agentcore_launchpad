# Fix s3files:GetAccessPoint statement in BYO mount policy

## Goal

Live BYO verification (fs-verify-agent redeploy, 2026-07-13) failed at
UpdateAgentRuntime with "Execution role is missing required permissions. Ensure
the role has s3files:GetAccessPoint" even though `_fs_policy_document` attached
exactly the AgentCore devguide's example policy.

**Root cause (proven via IAM policy simulator):** `s3files:GetAccessPoint` does
not support the `s3files:AccessPointArn` condition key (and authorizes on the
access-point ARN, not the file-system ARN). Inside the doc's single combined
statement the condition can never be satisfied for GetAccessPoint → implicitDeny,
while ClientMount/ClientWrite in the same statement evaluate allowed. The AWS
docs example is wrong.

## Requirements

- `backend/app/deployer/container.py::_fs_policy_document`: split the s3_files
  grant into two statements — ClientMount/ClientWrite keep file-system Resource
  + ArnEquals AccessPointArn condition; GetAccessPoint gets its own statement
  with Resource = the access point ARNs, no condition.
- Update `backend/tests/test_container_provision_iam.py` accordingly.
- Update the container-capabilities-filesystem spec (signatures + Wrong vs
  Correct example).

## Acceptance Criteria

- [ ] Simulator shape verified: GetAccessPoint vs AP-arn → allowed (done pre-fix).
- [ ] Backend tests green.
- [ ] Live redeploy of fs-verify-agent with the BYO S3 Files mount succeeds
      (UpdateAgentRuntime accepts; runtime READY in VPC mode).
