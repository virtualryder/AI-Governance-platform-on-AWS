// Baseline: authenticated OAuth users may reach tools on THIS gateway. This is the permissive floor
// that customer/use-case policies tighten with `forbid` rules for sensitive tools and groups.
// Rendered per gateway: {{GATEWAY_ARN}} is substituted with the concrete gateway ARN at synth.
// Cedar has no wildcard actions, so the action is left unconstrained and scoped by the resource.
permit(
  principal is AgentCore::OAuthUser,
  action,
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
);
