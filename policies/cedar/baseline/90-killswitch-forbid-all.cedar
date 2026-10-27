// Kill switch (layer 1): forbid every tool call on THIS gateway. `forbid` always overrides `permit`,
// so attaching this policy instantly neutralises the gateway across every agent and tool.
// NOT attached by default — the Controls stack (step 4) renders and attaches/detaches it as the
// Cedar layer of the layered kill switch. Rendered per gateway: {{GATEWAY_ARN}} is substituted.
forbid(
  principal,
  action,
  resource == AgentCore::Gateway::"{{GATEWAY_ARN}}"
);
