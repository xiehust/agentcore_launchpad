"""BYO-mount IAM inline policy — document shape + provision/delete lifecycle."""

import json

from app.deployer import container as c
from app.schemas.agent import AgentSpec

S3_AP = "arn:aws:s3files:us-west-2:111122223333:file-system/fs-abc/access-point/ap-1"
S3_AP2 = "arn:aws:s3files:us-west-2:111122223333:file-system/fs-abc/access-point/ap-2"
EFS_AP = "arn:aws:elasticfilesystem:us-west-2:111122223333:access-point/fsap-0123"
VPC = {"subnets": ["subnet-a"], "security_groups": ["sg-1"]}


class StubIam:
    def __init__(self):
        self.put_calls: list[dict] = []
        self.delete_calls: list[dict] = []

    def put_role_policy(self, **kw):
        self.put_calls.append(kw)

    def delete_role_policy(self, **kw):
        self.delete_calls.append(kw)


def _spec(**over) -> AgentSpec:
    return AgentSpec(name="fs-agent", method="container", system_prompt="hi", **over)


def test_policy_document_none_without_byo():
    assert c._fs_policy_document(_spec()) is None


def test_policy_document_s3_files():
    spec = _spec(
        filesystem={
            "s3_files": [
                {"access_point_arn": S3_AP, "mount_path": "/mnt/d1"},
                {"access_point_arn": S3_AP2, "mount_path": "/mnt/d2"},
            ]
        },
        network=VPC,
    )
    doc = c._fs_policy_document(spec)
    (stmt,) = doc["Statement"]
    assert stmt["Action"] == [
        "s3files:ClientMount", "s3files:ClientWrite", "s3files:GetAccessPoint",
    ]
    # both APs share one file system → deduped resource, both ARNs in the condition
    assert stmt["Resource"] == [
        "arn:aws:s3files:us-west-2:111122223333:file-system/fs-abc"
    ]
    assert stmt["Condition"]["ArnEquals"]["s3files:AccessPointArn"] == [S3_AP, S3_AP2]


def test_policy_document_efs():
    spec = _spec(
        filesystem={"efs": [{"access_point_arn": EFS_AP, "mount_path": "/mnt/tools"}]},
        network=VPC,
    )
    doc = c._fs_policy_document(spec)
    (stmt,) = doc["Statement"]
    assert stmt["Action"] == [
        "elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite",
    ]
    assert stmt["Resource"] == "*"  # FS ARN not derivable from an EFS AP ARN
    assert stmt["Condition"]["ArnEquals"]["elasticfilesystem:AccessPointArn"] == [EFS_AP]


class AgentRow:
    name = "fs-agent"
    resource_id = "rt-1"


def test_sync_attaches_policy_for_byo():
    iam = StubIam()
    spec = _spec(
        filesystem={"s3_files": [{"access_point_arn": S3_AP, "mount_path": "/mnt/d"}]},
        network=VPC,
    )
    logs: list[str] = []
    detail = c._sync_fs_policy(
        iam, "arn:aws:iam::111122223333:role/launchpad-base", AgentRow(), spec, logs.append
    )
    (call,) = iam.put_calls
    assert call["RoleName"] == "launchpad-base"
    assert call["PolicyName"] == "launchpad-fs-fs-agent"
    doc = json.loads(call["PolicyDocument"])
    assert doc["Version"] == "2012-10-17"
    assert iam.delete_calls == []
    assert "launchpad-fs-fs-agent" in detail


def test_sync_removes_policy_when_mounts_removed():
    iam = StubIam()
    detail = c._sync_fs_policy(
        iam, "arn:aws:iam::111122223333:role/launchpad-base", AgentRow(), _spec(), lambda m: None
    )
    assert iam.put_calls == []
    (call,) = iam.delete_calls
    assert call == {"RoleName": "launchpad-base", "PolicyName": "launchpad-fs-fs-agent"}
    assert detail == ""


def test_sync_tolerates_missing_policy_on_delete():
    class Grumpy(StubIam):
        def delete_role_policy(self, **kw):
            raise RuntimeError("NoSuchEntity")

    # must not raise
    c._sync_fs_policy(
        Grumpy(), "arn:aws:iam::1:role/launchpad-base", AgentRow(), _spec(), lambda m: None
    )


def test_delete_agent_resources_drops_policy(monkeypatch):
    class StubControlClient:
        class exceptions:
            class ResourceNotFoundException(Exception):
                pass

        def delete_agent_runtime(self, agentRuntimeId):
            pass

    monkeypatch.setattr(c, "control_client", lambda: StubControlClient())
    monkeypatch.setattr(c.rt, "delete_runtime", lambda cl, rid: None)

    class Settings:
        region = "us-west-2"
        resources = {"execution_role_arn": "arn:aws:iam::1:role/launchpad-base"}

    monkeypatch.setattr(c, "get_settings", lambda: Settings())
    iam = StubIam()
    c.delete_agent_resources(AgentRow(), iam_client=iam)
    (call,) = iam.delete_calls
    assert call == {"RoleName": "launchpad-base", "PolicyName": "launchpad-fs-fs-agent"}
