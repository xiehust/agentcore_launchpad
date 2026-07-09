#!/usr/bin/env python3
"""Launchpad bootstrap CLI.

Deploys the shared CDK stack when missing, then idempotently ensures the
AgentCore singletons (registry, memory) and writes config/launchpad.yaml.

Run from the backend venv so the app package resolves:
    cd backend && uv run python ../scripts/bootstrap.py [--skip-cdk]
"""

import argparse
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

from botocore.exceptions import ClientError  # noqa: E402

from app.services import bootstrap as bs  # noqa: E402


def stack_exists(region: str) -> bool:
    try:
        bs.get_stack_outputs(region)
        return True
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ValidationError":
            return False
        raise


def deploy_cdk() -> None:
    print(f"── stack {bs.STACK_NAME} not found — running cdk deploy…")
    subprocess.run(
        ["uv", "run", "cdk", "deploy", "--require-approval", "never"],
        cwd=REPO_ROOT / "infra",
        check=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Bootstrap AgentCore Launchpad shared infra")
    parser.add_argument("--region", default=None, help="AWS region (default: settings)")
    parser.add_argument("--skip-cdk", action="store_true", help="never invoke cdk deploy")
    args = parser.parse_args()

    region = args.region or bs.get_settings().region
    if not stack_exists(region):
        if args.skip_cdk:
            print(f"stack {bs.STACK_NAME} missing and --skip-cdk given — aborting", flush=True)
            return 1
        deploy_cdk()

    summary = bs.run_bootstrap(region)

    rows = [
        ("account", summary["account_id"]),
        ("region", summary["region"]),
        ("registry", f"{summary['registry']['arn']}"),
        ("registry state", "created" if summary["registry"]["created"] else "reused"),
        ("memory", f"{summary['memory']['arn']}"),
        ("memory state", "created" if summary["memory"]["created"] else "reused"),
        ("artifacts bucket", summary["stack_outputs"]["ArtifactsBucketName"]),
        ("ecr repo", summary["stack_outputs"]["EcrRepoUri"]),
        ("codebuild", summary["stack_outputs"]["CodeBuildProjectName"]),
        ("user pool", summary["stack_outputs"]["UserPoolId"]),
        ("demo passwords", "set (see config/launchpad.yaml)"
         if summary["demo_passwords_set"] else "unchanged"),
    ]
    width = max(len(k) for k, _ in rows)
    print("\n══ bootstrap summary ══")
    for key, value in rows:
        print(f"  {key:<{width}}  {value}")
    print(f"\nconfig written → {bs.CONFIG_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
