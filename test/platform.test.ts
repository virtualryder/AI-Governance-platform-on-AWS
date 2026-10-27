import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
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
