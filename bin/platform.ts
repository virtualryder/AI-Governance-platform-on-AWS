#!/usr/bin/env node
import 'source-map-support/register';
import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks, HIPAASecurityChecks } from 'cdk-nag';
import { DeploymentMode, loadConfig } from '../lib/config/platform-config';
import { GovernanceBaselineStack } from '../lib/stacks/governance-baseline-stack';
import { AgentPlatformStack } from '../lib/stacks/agent-platform-stack';
import { ControlsStack } from '../lib/stacks/controls-stack';
import { GovernanceHubStack } from '../lib/stacks/governance-hub-stack';
import { OrgFoundationStack } from '../lib/stacks/org-foundation-stack';

const app = new App();
const mode = (app.node.tryGetContext('mode') ?? 'standalone') as DeploymentMode;
const config = loadConfig(app.node.tryGetContext('configFile') ?? 'config/platform.example.json');
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region };
const prefix = `GovAI-${config.customerName}-${config.environment}`;
const common = { env, config, mode };

switch (mode) {
  case 'standalone':
  case 'spoke': {
    const baseline = new GovernanceBaselineStack(app, `${prefix}-Baseline`, common);
    const platform = new AgentPlatformStack(app, `${prefix}-AgentPlatform`, common);
    platform.addStackDependency(baseline);
    const controls = new ControlsStack(app, `${prefix}-Controls`, common);
    controls.addStackDependency(platform);
    if (mode === 'standalone') {
      // Hub capabilities collapsed into the same account for single-account pilots.
      new GovernanceHubStack(app, `${prefix}-Hub`, common).addStackDependency(baseline);
    }
    break;
  }
  case 'hub':
    new GovernanceHubStack(app, `${prefix}-Hub`, common);
    break;
  case 'org':
    new OrgFoundationStack(app, `${prefix}-OrgFoundation`, common);
    break;
  default:
    throw new Error(`Unknown mode '${mode}'. Use standalone | hub | spoke | org.`);
}

if (app.node.tryGetContext('nag') === 'true' || app.node.tryGetContext('nag') === true) {
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  Aspects.of(app).add(new HIPAASecurityChecks({ verbose: true }));
}
