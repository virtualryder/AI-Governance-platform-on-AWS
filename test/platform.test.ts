import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { loadConfig, PlatformConfig } from '../lib/config/platform-config';
import { GovernanceBaselineStack } from '../lib/stacks/governance-baseline-stack';
import { AgentPlatformStack } from '../lib/stacks/agent-platform-stack';

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
  t.resourceCountIs('AWS::XRay::TransactionSearchConfig', 1);
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
