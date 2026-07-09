import aws_cdk as cdk
import pytest
from aws_cdk.assertions import Match, Template

from stacks.base_stack import LaunchpadBaseStack


@pytest.fixture(scope="module")
def template() -> Template:
    app = cdk.App()
    stack = LaunchpadBaseStack(
        app, "launchpad-base", env=cdk.Environment(account="111111111111", region="us-west-2")
    )
    return Template.from_stack(stack)


def test_core_resources_present(template: Template):
    template.resource_count_is("AWS::S3::Bucket", 1)
    template.resource_count_is("AWS::ECR::Repository", 1)
    template.resource_count_is("AWS::CodeBuild::Project", 1)
    template.resource_count_is("AWS::Cognito::UserPool", 1)


def test_cognito_groups_and_users(template: Template):
    template.resource_count_is("AWS::Cognito::UserPoolGroup", 2)
    template.resource_count_is("AWS::Cognito::UserPoolUser", 2)
    template.has_resource_properties(
        "AWS::Cognito::UserPoolGroup", {"GroupName": "platform-admin"}
    )
    template.has_resource_properties("AWS::Cognito::UserPoolGroup", {"GroupName": "hr-analyst"})


def test_codebuild_is_arm64(template: Template):
    template.has_resource_properties(
        "AWS::CodeBuild::Project",
        {"Environment": Match.object_like({"Type": "ARM_CONTAINER"})},
    )


def test_execution_role_trusts_agentcore(template: Template):
    template.has_resource_properties(
        "AWS::IAM::Role",
        Match.object_like(
            {
                "RoleName": "launchpad-agent-execution-role",
                "AssumeRolePolicyDocument": Match.object_like(
                    {
                        "Statement": Match.array_with(
                            [
                                Match.object_like(
                                    {
                                        "Principal": {
                                            "Service": "bedrock-agentcore.amazonaws.com"
                                        }
                                    }
                                )
                            ]
                        )
                    }
                ),
            }
        ),
    )


def test_outputs_exported(template: Template):
    outputs = template.to_json()["Outputs"]
    for key in (
        "ArtifactsBucketName",
        "EcrRepoName",
        "EcrRepoUri",
        "CodeBuildProjectName",
        "UserPoolId",
        "UserPoolClientId",
        "AgentExecutionRoleArn",
    ):
        assert key in outputs, f"missing output {key}"
