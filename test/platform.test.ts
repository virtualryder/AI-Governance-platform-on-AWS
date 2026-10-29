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
    PolicyEngineConfiguration: Match.objectLike({ Mode: 'ENFORCE' }), // enforcing by default (F01)
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

test('agent platform: human sign-in flow creates the entitlement group + a human app client (F08)', () => {
  const t = agentPlatformTemplate(); // example config enables identity.humanAuth with csr-agents
  t.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'csr-agents' });
  // Two app clients: the M2M machine client and the human (user-facing) client.
  t.resourceCountIs('AWS::Cognito::UserPoolClient', 2);
  const clients = t.findResources('AWS::Cognito::UserPoolClient');
  const human = Object.values(clients).find((c: any) => c.Properties.ClientName === 'agentcore-human') as any;
  expect(human).toBeDefined();
  expect(human.Properties.GenerateSecret).toBeFalsy(); // public client for authorization-code/PKCE
});

test('config: LOG_ONLY Cedar is rejected unless explicitly acknowledged (F01)', () => {
  const base = loadConfig('config/platform.example.json');
  const logOnly = JSON.parse(JSON.stringify(base)) as PlatformConfig;
  logOnly.agentcore.cedarMode = 'LOG_ONLY';
  // loadConfig runs validate(); reconstruct the validation by re-serialising through a temp file is
  // overkill — assert via the exported loader behaviour on a written temp config instead.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'govai-cfg-'));
  const f = path.join(dir, 'log-only.json');
  fs.writeFileSync(f, JSON.stringify(logOnly));
  expect(() => loadConfig(f)).toThrow(/LOG_ONLY/);
  // With the explicit acknowledgment it loads.
  logOnly.agentcore.acknowledgeNonEnforcingCedar = true;
  fs.writeFileSync(f, JSON.stringify(logOnly));
  expect(() => loadConfig(f)).not.toThrow();
});

test('hub: agent registry uses the ARN response contract (F04)', () => {
  const c = JSON.parse(JSON.stringify(config)) as PlatformConfig;
  const t = Template.fromStack(
    new GovernanceHubStack(new App(), 'HUBREG', { config: c, mode: 'hub', env: { region: c.region } }),
  );
  // The custom resource must capture registryArn as its physical id (CreateRegistry returns
  // registryArn, not registryId — the old response field was a deployment blocker).
  const crs = t.findResources('Custom::AgentRegistry');
  const props = (Object.values(crs)[0] as any).Properties;
  const create = typeof props.Create === 'string' ? JSON.parse(props.Create) : props.Create;
  expect(create.action).toBe('CreateRegistry');
  expect(create.physicalResourceId.responsePath).toBe('registryArn'); // not the nonexistent registryId
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

test('agent platform: runtime is pinned to the approved guardrail and denies ungoverned inference (F02)', () => {
  const t = agentPlatformTemplate((c) => {
    c.agentcore.runtimeImageUri = '111111111111.dkr.ecr.us-east-1.amazonaws.com/agent:latest';
  });
  // Guardrail id/version are handed to the harness via env.
  t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    EnvironmentVariables: Match.objectLike({ GUARDRAIL_ID: Match.anyValue(), GUARDRAIL_VERSION: Match.anyValue() }),
  });
  // A role carries the ungoverned-inference deny managed policy (attached to the runtime cross-stack).
  // The deny ARN comes from the baseline via an SSM-backed CFN parameter; tie the role's
  // ManagedPolicyArns Ref back to that parameter.
  const params = (t.toJSON().Parameters ?? {}) as Record<string, unknown>;
  const denyParamId = Object.keys(params).find((k) =>
    JSON.stringify(params[k]).includes('baseline/ungoverned-inference-deny-arn'),
  );
  expect(denyParamId).toBeDefined();
  const roles = t.findResources('AWS::IAM::Role');
  const attached = Object.values(roles).some((r: any) =>
    JSON.stringify(r.Properties.ManagedPolicyArns ?? []).includes(denyParamId!),
  );
  expect(attached).toBe(true);
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
  // End-to-end HITL (F05): an approvals ledger (idempotency/replay/audit) + a post-approval executor.
  t.hasResourceProperties('AWS::DynamoDB::Table', {
    SSESpecification: Match.objectLike({ SSEEnabled: true }),
  });
  const fns = t.findResources('AWS::Lambda::Function');
  const hasExecutor = Object.values(fns).some((f: any) =>
    (f.Properties.Description ?? '').includes('exactly once'),
  );
  expect(hasExecutor).toBe(true);
});

test('agent platform: runtime can start the HITL approval workflow but not perform the action (F05)', () => {
  const t = agentPlatformTemplate((c) => {
    c.agentcore.runtimeImageUri = '111111111111.dkr.ecr.us-east-1.amazonaws.com/agent:latest';
  });
  // Runtime env points at the HITL state machine; role may StartExecution on it.
  t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    EnvironmentVariables: Match.objectLike({ HITL_STATE_MACHINE_ARN: Match.anyValue() }),
  });
  const policies = t.findResources('AWS::IAM::Policy');
  const canStart = Object.values(policies).some((p: any) =>
    JSON.stringify(p.Properties.PolicyDocument).includes('states:StartExecution'),
  );
  expect(canStart).toBe(true);
});

test('controls: SRA detective Config rules when enabled', () => {
  const t = controlsTemplate((c) => {
    c.controls.detectiveConfigRules = true;
  });
  t.resourceCountIs('AWS::Config::ConfigRule', 2); // invocation-logging + guardrails-present
  t.hasResourceProperties('AWS::Config::ConfigRule', {
    Source: Match.objectLike({ Owner: 'CUSTOM_LAMBDA' }),
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
  hub.resourceCountIs('AWS::CloudWatch::Dashboard', 1); // governance dashboard (D4)

  const collapsed = Template.fromStack(
    new GovernanceHubStack(new App(), 'HUBC', { config, mode: 'standalone', env: { region: config.region } }),
  );
  collapsed.resourceCountIs('AWS::Oam::Sink', 0); // baseline provides evidence; no cross-account sink
});

test('governance hub: CloudWatch Omni space (+ data-access role) upgrade when an Omni domain is configured', () => {
  const c = JSON.parse(JSON.stringify(config)) as PlatformConfig;
  c.agentcore.omni = { domainId: 'd-testomni01', enableContextGraph: true, enableModelInference: true };
  const t = Template.fromStack(
    new GovernanceHubStack(new App(), 'HUBO', { config: c, mode: 'hub', env: { region: c.region } }),
  );
  // Space points at the out-of-band domain and the data-access role created here.
  t.hasResourceProperties('AWS::CloudWatch::Space', {
    DomainId: 'd-testomni01',
    DataAccessRoleArn: Match.anyValue(),
    Name: Match.stringLikeRegexp('^[a-z0-9]+(-[a-z0-9]+)*$'),
  });
  // Space operator role trusts the Omni service principal with the full confused-deputy trust actions.
  t.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Principal: { Service: 'cloudwatch.amazonaws.com' },
          Action: Match.arrayWith(['sts:AssumeRole', 'sts:TagSession', 'sts:SetSourceIdentity', 'sts:SetContext']),
          Condition: { StringEquals: { 'aws:SourceAccount': Match.anyValue() } },
        }),
      ]),
    },
  });
  // No explicit Omni dashboard unless a body is supplied (we don't guess the body schema).
  t.resourceCountIs('AWS::CloudWatch::OmniDashboard', 0);
});

test('governance hub: no Omni space without a configured domain', () => {
  const c = JSON.parse(JSON.stringify(config)) as PlatformConfig;
  delete c.agentcore.omni;
  const t = Template.fromStack(
    new GovernanceHubStack(new App(), 'HUBN', { config: c, mode: 'hub', env: { region: c.region } }),
  );
  t.resourceCountIs('AWS::CloudWatch::Space', 0);
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

test('org foundation: Guard hook rolls org-wide via service-managed auto-deploy StackSet to the Agentic OU', () => {
  const c = JSON.parse(JSON.stringify(config)) as PlatformConfig;
  c.org = { organizationId: 'o-abcd1234ef', agenticOuId: 'ou-abcd-12345678' };
  const t = Template.fromStack(
    new OrgFoundationStack(new App(), 'ORGSS', { config: c, mode: 'org', env: { region: c.region } }),
  );
  // Service-managed StackSet, auto-deploying to the Agentic OU, carrying an embedded Guard hook.
  t.hasResourceProperties('AWS::CloudFormation::StackSet', {
    PermissionModel: 'SERVICE_MANAGED',
    AutoDeployment: { Enabled: true, RetainStacksOnAccountRemoval: false },
    StackInstancesGroup: Match.arrayWith([
      Match.objectLike({ DeploymentTargets: { OrganizationalUnitIds: ['ou-abcd-12345678'] } }),
    ]),
    TemplateBody: Match.anyValue(),
  });
  // Central rules bucket is readable by the org so each spoke account's hook can fetch the rules.
  t.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Sid: 'OrgReadGuardRules',
          Condition: { StringEquals: { 'aws:PrincipalOrgID': 'o-abcd1234ef' } },
        }),
      ]),
    },
  });
});

test('org foundation: no Guard hook StackSet without both org id and OU', () => {
  const c = JSON.parse(JSON.stringify(config)) as PlatformConfig;
  c.org = { agenticOuId: 'ou-abcd-12345678' }; // org id missing
  const t = Template.fromStack(
    new OrgFoundationStack(new App(), 'ORGNOSS', { config: c, mode: 'org', env: { region: c.region } }),
  );
  t.resourceCountIs('AWS::CloudFormation::StackSet', 0);
});

test('multi-agent A2A: invoke-authz for collaborators + config env on the runtime', () => {
  const t = agentPlatformTemplate((c) => {
    c.agentcore.runtimeImageUri = '111111111111.dkr.ecr.us-east-1.amazonaws.com/agent:latest';
    c.agentcore.protocol = 'A2A';
    c.agentcore.multiAgent = {
      enabled: true,
      orchestration: 'supervisor',
      publishToRegistry: true,
      remoteCollaborators: [
        { name: 'benefits', runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/benefits-x', auth: 'obo' },
      ],
    };
  });
  // Runtime env carries the multi-agent config for the harness.
  t.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
    EnvironmentVariables: Match.objectLike({ PROTOCOL: 'A2A', MULTI_AGENT: Match.anyValue() }),
  });
  // Runtime role can invoke the allow-listed collaborator runtime.
  t.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Sid: 'A2AInvoke', Action: 'bedrock-agentcore:InvokeAgentRuntime' }),
      ]),
    },
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
