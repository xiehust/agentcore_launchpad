import os

import aws_cdk as cdk

from stacks.base_stack import LaunchpadBaseStack

app = cdk.App()
LaunchpadBaseStack(
    app,
    "launchpad-base",
    env=cdk.Environment(
        account=os.environ.get("CDK_DEFAULT_ACCOUNT"),
        region=os.environ.get("CDK_DEFAULT_REGION", "us-west-2"),
    ),
    description="AgentCore Launchpad shared infrastructure",
)
app.synth()
