import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { loadConfig } from '../lib/config/platform-config';
import { GovernanceBaselineStack } from '../lib/stacks/governance-baseline-stack';

const config = loadConfig('config/platform.example.json');

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
