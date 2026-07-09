// R-02: finance write tools require the platform-admin role.
// Cognito access tokens carry the user's groups in the cognito:groups
// claim, surfaced as a principal tag. forbid overrides the baseline permit.
forbid(
  principal is AgentCore::OAuthUser,
  action == AgentCore::Action::"hr-database___create_payout",
  resource == AgentCore::Gateway::"__GATEWAY_ARN__"
) unless {
  principal.hasTag("cognito:groups") &&
  principal.getTag("cognito:groups") like "*platform-admin*"
};
