import { CfnResource, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface OmniObservabilityProps {
  config: PlatformConfig;
}

/**
 * CloudWatch Omni upgrade (D4, hub mode) — the next-generation unified + agent observability
 * experience that supersedes the classic `AWS::CloudWatch::Dashboard` governance view. Omni works in
 * a **space** (one account + Region) that auto-discovers service topology, maps dependencies, and
 * surfaces golden metrics, correlating logs/metrics/traces in the CloudWatch Dataset.
 *
 * `AWS::CloudWatch::Space` and `AWS::CloudWatch::OmniDashboard` are newer CloudFormation types that
 * are NOT yet in the pinned `aws-cdk-lib` (2.275.0), so they are declared via the raw `CfnResource`
 * escape hatch — grounded against the CloudFormation Template Reference (2026-10-28):
 *   - Space: DataAccessRoleArn (req), DomainId (req, `d-…`), Name (req), EncryptionConfiguration?,
 *     AgentCoreEvaluationRoleArn?, Tags?; GetAtt SpaceId/Arn.
 *   - OmniDashboard: Body (req), Name (req), SpaceId (req), Description?, Tags?.
 *
 * The Omni **domain** is provisioned out-of-band during onboarding (console + SSO; there is no CFN
 * domain resource), so the caller only instantiates this when `agentcore.omni.domainId` is set.
 */
export class OmniObservability extends Construct {
  readonly spaceRole: iam.Role;
  readonly space: CfnResource;
  readonly dashboard?: CfnResource;

  constructor(scope: Construct, id: string, props: OmniObservabilityProps) {
    super(scope, id);
    const { config } = props;
    const omni = config.agentcore.omni!; // caller gates on omni?.domainId
    const stack = Stack.of(this);

    const spaceName = omni.spaceName ?? `govai-${config.customerName}-${config.environment}`;

    // Space operator / data-access role. Omni creates this itself in single-account setup; when you
    // supply your own it must carry the exact trust below (confused-deputy prevention) and the
    // CloudWatchOmniSpaceAccessPolicy base managed policy, which Omni also applies as the role's
    // permissions boundary.
    const spaceAccess = iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchOmniSpaceAccessPolicy');
    const managedPolicies = [spaceAccess];
    if (omni.enableContextGraph ?? true) {
      managedPolicies.push(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchOmniAWSIntegrationPolicy'));
    }
    if (omni.enableModelInference) {
      managedPolicies.push(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchOmniModelInferencePolicy'));
    }

    this.spaceRole = new iam.Role(this, 'SpaceRole', {
      assumedBy: new iam.ServicePrincipal('cloudwatch.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': stack.account } },
      }),
      description: `CloudWatch Omni space operator / data-access role for ${config.customerName}`,
      managedPolicies,
      permissionsBoundary: spaceAccess,
    });
    // Omni's trust policy grants more than sts:AssumeRole; match it exactly.
    const cfnRole = this.spaceRole.node.defaultChild as iam.CfnRole;
    cfnRole.addPropertyOverride('AssumeRolePolicyDocument.Statement.0.Action', [
      'sts:AssumeRole',
      'sts:TagSession',
      'sts:SetSourceIdentity',
      'sts:SetContext',
    ]);

    const spaceProps: Record<string, unknown> = {
      Name: spaceName,
      DomainId: omni.domainId,
      DataAccessRoleArn: this.spaceRole.roleArn,
      Tags: [
        { Key: 'Platform', Value: 'governed-ai' },
        { Key: 'Customer', Value: config.customerName },
        { Key: 'Environment', Value: config.environment },
      ],
    };
    if (omni.agentCoreEvaluationRoleArn) spaceProps.AgentCoreEvaluationRoleArn = omni.agentCoreEvaluationRoleArn;
    if (omni.kmsKeyArn) {
      spaceProps.EncryptionConfiguration = { EncryptionStrategy: 'CUSTOMER_MANAGED', KmsKeyArn: omni.kmsKeyArn };
    }

    this.space = new CfnResource(this, 'Space', {
      type: 'AWS::CloudWatch::Space',
      properties: spaceProps,
    });

    // Optional explicit Omni dashboard. Only emitted when the customer supplies a body — Omni's
    // dashboard definition schema is not synthesized here, so we never ship a guessed body. Without
    // one, the space's auto-discovered topology and golden-metric dashboards cover the governance view.
    if (omni.dashboardBody) {
      this.dashboard = new CfnResource(this, 'OmniDashboard', {
        type: 'AWS::CloudWatch::OmniDashboard',
        properties: {
          Name: `governed-ai-${config.customerName}-${config.environment}`,
          Description: `Governance view for ${config.customerName} (${config.environment})`,
          SpaceId: this.space.getAtt('SpaceId').toString(),
          Body: omni.dashboardBody,
        },
      });
      this.dashboard.addDependency(this.space);
    }
  }

  get spaceId(): string {
    return this.space.getAtt('SpaceId').toString();
  }
}
