// Baseline grant: any authenticated OAuth principal (console users via
// Cognito password grant, agents via the M2M client-credentials client)
// may invoke launchpad-gw tools. Cedar is default-deny, so without this
// permit the ENFORCE-mode gateway would block everything.
// Fine-grained restrictions are layered on top with forbid policies.
permit(
  principal is AgentCore::OAuthUser,
  action,
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
);
