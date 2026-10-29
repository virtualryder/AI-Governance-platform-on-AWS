import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { loadConfig, PlatformConfig } from '../lib/config/platform-config';
import { GovernanceBaselineStack } from '../lib/stacks/governance-baseline-stack';
import { AgentPlatformStack } from '../lib/stacks/agent-platform-stack';
import { ControlsStack } from '../lib/stacks/controls-stack';
import { OrgFoundationStack } from '../lib/stacks/org-foundation-stack';
import { GovernanceHubStack } from '../lib/stacks/governance-hub-stack';

const config = loadConfig('config/platform.example.json');

function agentPlatformTemplate(overrides?: (c: PlatformConfig) => void) {
  const c = JSON.parse(JSON.stringify(config)) as PlatformConfig;
  overrides?.(c);
  const app = new App();
  const stack = new AgentPlatformStack(app, 'AP', { config: c, mode: 'standalone', env: { region: c.region } });
  return Template.fromStack(stack);
}

test('config loads and validates', () => {
  expect(config.customerName).toBe('example-state-agency');
  expect(config.agentcore.accessTokenValidityMinutes).toBeLessThanOrEqual(60);
});

test('baseline stack carries platform tags and metadata', () => {
  const app = new App();
  const stack = new GovernanceBaselineStack(app, 'T', { config, mode: 'standalone', env: { region: config.region } });
  const t = Template.fromStack(stack);
  t.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/governed-ai/example-state-agency/dev/governance-baseline/version',
    Tags: { Platform: 'governed-ai', Customer: 'example-state-agency' },
  });
});

function baselineTemplate() {
  const app = new App();
  const stack = new GovernanceBaselineStack(app, 'T', { config, mode: 'standalone', env: { region: config.region } });
  return Template.fromStack(stack);
}

test('evidence stores use customer-managed KMS and WORM/TLS defaults', () => {
  const t = baselineTemplate();
  t.resourceCountIs('AWS::KMS::Key', 1);
  t.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  // WORM: Object Lock enabled on the evidence bucket, public access fully blocked.
  t.hasResourceProperties('AWS::S3::Bucket', {
    ObjectLockEnabled: true,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
  // Both log groups are CMK-encrypted.
  const logGroups = t.findResources('AWS::Logs::LogGroup');
  for (const lg of Object.values(logGroups)) {
    expect((lg as any).Properties.KmsKeyId).toBeDefined();
  }
});

test('CloudTrail captures AgentCore data events via advanced selectors', () => {
  const t = baselineTemplate();
  t.hasResourceProperties('AWS::CloudTrail::Trail', {
    IsMultiRegionTrail: true,
    EnableLogFileValidation: true,
  });
  const trails = Object.values(t.findResources('AWS::CloudTrail::Trail'));
  const selectors = (trails[0] as any).Properties.AdvancedEventSelectors as any[];
  const types = selectors
    .flatMap((s) => s.FieldSelectors)
    .filter((f: any) => f.Field === 'resources.type')
    .flatMap((f: any) => f.Equals);
  expect(types).toContain('AWS::BedrockAgentCore::Gateway');
  expect(types).toContain('AWS::BedrockAgentCore::Runtime');
});

test('guardrail is versioned and ungoverned inference is denied', () => {
  const t = baselineTemplate();
  t.resourceCountIs('AWS::Bedrock::Guardrail', 1);
  t.resourceCountIs('AWS::Bedrock::GuardrailVersion', 1);
  // The Null-condition deny on bedrock:GuardrailIdentifier is the enforcement artefact.
  t.hasResourceProperties('AWS::IAM::ManagedPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Deny',
          Condition: { Null: { 'bedrock:GuardrailIdentifier': 'true' } },
        }),
      ]),
    },
  });
});

test('agent platform: MCP gateway with CUSTOM_JWT, Cedar engine, memory, browser, observability', () => {
  const t = agentPlatformTemplate();
  t.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
    AuthorizerType: 'CUSTOM_JWT',
    ProtocolType: 'MCP',
    PolicyEngineConfiguration: Match.objectLike({ Mode: 'LOG_ONLY' }),
  });
  t.resourceCountIs('AWS::BedrockAgentCore::PolicyEngine', 1);
  // Baseline Cedar is NOT attached by default (AgentCore rejects a blanket permit; tools come later).
  t.resourceCountIs('AWS::BedrockAgentCore::Policy', 0);
  t.resourceCountIs('AWS::BedrockAgentCore::Memory', 1); // example enables memory
  t.resourceCountIs('AWS::BedrockAgentCore::BrowserCustom', 1);
  t.resourceCountIs('Custom::XRayTransactionSearch', 1); // idempotent Transaction Search enablement
  // TOTP-only MFA means no Cognito SMS role.
  const roles = t.findResources('AWS::IAM::Role');
  for (const r of Object.values(roles)) {
    const principal = JSON.stringify((r as any).Properties.AssumeRolePolicyDocument);
    expect(principal).not.toContain('cognito-idp.amazonaws.com');
  }
});

test('agent platform: memory CMK-encrypted', () => {
  const t = agentPlatformTemplate();
  t.hasResourceProperties('AWS::BedrockAgentCore::Memory', {
    EncryptionKeyArn: Match.anyValue(),
  });
});

test('agent platform: runtime + endpoint only when an image is configured', () => {
  const without = agentPlatformTemplate();
  without.resourceCountIs('AWS::BedrockAgentCore::Runtime', 0);
  without.resourceCountIs('AWS::BedrockAgentCore::RuntimeEndpoint', 0);

  const withImage = agentPlatformTemplate((c) => {
    c.agentcore.runtimeImageUri = '111111111111.dkr.ecr.us-east-1.amazonaws.com/agent:latest';
    c.agentcore.enableCodeInterpreter = true;
  });
  withImage.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
  withImage.resourceCountIs('AWS::BedrockAgentCore::RuntimeEndpoint', 1);
  withImage.resourceCountIs('AWS::BedrockAgentCore::CodeInterpreterCustom', 1);
});

test('agent platform: baseline Cedar attaches only when explicitly opted in', () => {
  const t = agentPlatformTemplate((c) => {
    c.agentcore.attachBaselineCedarPolicies = true;
  });
  t.resourceCountIs('AWS::BedrockAgentCore::Policy', 1);
});

function controlsTemplate(overrides?: (c: PlatformConfig) => void) {
  const c = JSON.parse(JSON.stringify(config)) as PlatformConfig;
  overrides?.(c);
  const app = new App();
  const stack = new ControlsStack(app, 'CT', { config: c, mode: 'standalone', env: { region: c.region } });
  return Template.fromStack(stack);
}

test('controls: kill switch, monthly budget, and HITL approval', () => {
  const t = controlsTemplate();
  // Kill switch: a fail-closed SSM flag + a Lambda to engage/release.
  t.hasResourceProperties('AWS::SSM::Parameter', {
    Name: '/governed-ai/example-state-agency/dev/controls/kill-switch-state',
  });
  // Monthly cost budget with alert subscribers.
  t.hasResourceProperties('AWS::Budgets::Budget', {
    Budget: Match.objectLike({ BudgetType: 'COST', TimeUnit: 'MONTHLY' }),
  });
  // HITL (example enables it): a waitForTaskToken state machine that logs ALL events.
  t.resourceCountIs('AWS::StepFunctions::StateMachine', 1);
  t.hasResourceProperties('AWS::StepFunctions::StateMachine', {
    LoggingConfiguration: Match.objectLike({ Level: 'ALL' }),
  });
});

test('controls: HITL omitted when disabled', () => {
  const t = controlsTemplate((c) => {
    c.controls.humanInTheLoop = false;
  });
  t.resourceCountIs('AWS::StepFunctions::StateMachine', 0);
});

test('governance hub: central log archive + OAM sink in hub mode; collapsed in standalone', () => {
  const app = new App();
  const hub = Template.fromStack(
    new GovernanceHubStack(app, 'HUB', { config, mode: 'hub', env: { region: config.region } }),
  );
  hub.resourceCountIs('AWS::Oam::Sink', 1);
  hub.hasResourceProperties('AWS::S3::Bucket', { ObjectLockEnabled: true }); // WORM log archive
  // Service Catalog self-service portfolio + product.
  hub.resourceCountIs('AWS::ServiceCatalog::Portfolio', 1);
  hub.resourceCountIs('AWS::ServiceCatalog::CloudFormationProduct', 1);
  hub.resourceCountIs('Custom::AgentRegistry', 1); // governed discovery (no CFN type)

  const collapsed = Template.fromStack(
    new GovernanceHubStack(new App(), 'HUBC', { config, mode: 'standalone', env: { region: config.region } }),
  );
  collapsed.resourceCountIs('AWS::Oam::Sink', 0); // baseline provides evidence; no cross-account sink
});

test('org foundation: lifted SCPs + SCP-exempt deployer role', () => {
  const app = new App();
  const stack = new OrgFoundationStack(app, 'ORG', { config, mode: 'org', env: { region: config.region } });
  const t = Template.fromStack(stack);
  // Two service control policies (inference perimeter + control-plane integrity).
  // inference-perimeter + control-plane-integrity + cost-freeze (detached until a budget trips it).
  t.resourceCountIs('AWS::Organizations::Policy', 3);
  t.hasResourceProperties('AWS::Organizations::Policy', { Type: 'SERVICE_CONTROL_POLICY' });
  // The SCP-exempt deployer role (names derive from customerName when org config omits them).
  t.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'govai-example-state-agency-platform-deployer',
  });
});

test('org foundation: Bedrock declarative org policy when a guardrail floor is configured', () => {
  const c = JSON.parse(JSON.stringify(config)) as PlatformConfig;
  c.org = { orgGuardrailArn: 'arn:aws:bedrock:us-east-1:111122223333:guardrail/abc:1' };
  const t = Template.fromStack(
    new OrgFoundationStack(new App(), 'ORGB', { config: c, mode: 'org', env: { region: c.region } }),
  );
  t.hasResourceProperties('AWS::Organizations::Policy', { Type: 'BEDROCK_POLICY' });
  // 3 SCPs (inference, control-plane, cost-freeze) + 1 Bedrock declarative policy.
  t.resourceCountIs('AWS::Organizations::Policy', 4);
});

test('org foundation: Budgets cost kill switch applies the freeze SCP at threshold', () => {
  const c = JSON.parse(JSON.stringify(config)) as PlatformConfig;
  c.org = { agenticOuId: 'ou-abcd-12345678' };
  const t = Template.fromStack(
    new OrgFoundationStack(new App(), 'ORGC', { config: c, mode: 'org', env: { region: c.region } }),
  );
  t.hasResourceProperties('AWS::Budgets::BudgetsAction', {
    ActionType: 'APPLY_SCP_POLICY',
    ActionThreshold: { Value: 100, Type: 'PERCENTAGE' },
  });
});

test('org foundation: proactive Guard Hook (WARN) over resource + stack ops', () => {
  const t = Template.fromStack(
    new OrgFoundationStack(new App(), 'ORGG', { config, mode: 'org', env: { region: config.region } }),
  );
  t.hasResourceProperties('AWS::CloudFormation::GuardHook', {
    HookStatus: 'ENABLED',
    FailureMode: 'WARN',
    TargetOperations: Match.arrayWith(['RESOURCE', 'STACK']),
  });
});

test('use case: tool targets + tool-scoped Cedar wired from the manifest', () => {
  const t = agentPlatformTemplate((c) => {
    c.agentcore.useCaseManifest = 'use-cases/citizen-311/manifest.yaml';
  });
  t.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 1); // svc311 MCP lambda target
  t.resourceCountIs('AWS::BedrockAgentCore::Policy', 2); // permit csr-agents + forbid submit
  t.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
    TargetConfiguration: Match.objectLike({ Mcp: Match.objectLike({ Lambda: Match.anyValue() }) }),
  });
});

test('per-user interceptor: ledger + REQUEST interceptor attached when enabled', () => {
  const t = agentPlatformTemplate((c) => {
    c.controls.perUserGovernance = { enabled: true, ratePerMinute: 60 };
  });
  // CMK-encrypted ledger with TTL.
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    SSESpecification: Match.objectLike({ SSEEnabled: true }),
    TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
  });
  // Interceptor attached to the gateway at REQUEST with headers passed (for JWT).
  t.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
    InterceptorConfigurations: Match.arrayWith([
      Match.objectLike({
        InterceptionPoints: ['REQUEST'],
        InputConfiguration: { PassRequestHeaders: true },
      }),
    ]),
  });
});
