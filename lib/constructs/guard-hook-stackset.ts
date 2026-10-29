import * as cfn from 'aws-cdk-lib/aws-cloudformation';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface GuardHookStackSetProps {
  config: PlatformConfig;
  /** Central Guard-rules bucket (OrgFoundation) that spoke-account hooks read. */
  rulesBucket: s3.Bucket;
  /** Object key of the baseline Guard rules within that bucket. */
  rulesKey: string;
  organizationId: string;
  agenticOuId: string;
}

/**
 * Org-wide rollout of the baseline Guard hook (F2) via a service-managed CloudFormation StackSet with
 * auto-deployment, so every workload account in the Agentic OU — including accounts added later —
 * inherits proactive Guard evaluation. Each instance's embedded template creates a hook execution
 * role and an `AWS::CloudFormation::GuardHook` pointing at the central Guard-rules object in the hub
 * bucket (shared read to the org by PrincipalOrgID). Starts WARN; flip to FAIL once validated.
 */
export class GuardHookStackSet extends Construct {
  readonly stackSet: cfn.CfnStackSet;

  constructor(scope: Construct, id: string, props: GuardHookStackSetProps) {
    super(scope, id);
    const { config, rulesBucket, rulesKey, organizationId, agenticOuId } = props;

    // Let any principal in the org read the central Guard rules (spoke hook roles are created per
    // account by the StackSet, so scope by org rather than by role ARN).
    rulesBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'OrgReadGuardRules',
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject'],
        resources: [rulesBucket.arnForObjects('*')],
        conditions: { StringEquals: { 'aws:PrincipalOrgID': organizationId } },
      }),
    );

    const embeddedTemplate = {
      AWSTemplateFormatVersion: '2010-09-09',
      Description: 'Governed-AI baseline CloudFormation Guard hook (org-wide via StackSets).',
      Resources: {
        GuardHookRole: {
          Type: 'AWS::IAM::Role',
          Properties: {
            AssumeRolePolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                {
                  Effect: 'Allow',
                  Principal: { Service: 'hooks.cloudformation.amazonaws.com' },
                  Action: 'sts:AssumeRole',
                },
              ],
            },
            Policies: [
              {
                PolicyName: 'ReadGuardRules',
                PolicyDocument: {
                  Version: '2012-10-17',
                  Statement: [
                    { Effect: 'Allow', Action: 's3:GetObject', Resource: rulesBucket.arnForObjects(rulesKey) },
                  ],
                },
              },
            ],
          },
        },
        GuardHook: {
          Type: 'AWS::CloudFormation::GuardHook',
          Properties: {
            Alias: 'GovAI::Guard::OrgBaseline',
            ExecutionRole: { 'Fn::GetAtt': ['GuardHookRole', 'Arn'] },
            FailureMode: 'WARN',
            HookStatus: 'ENABLED',
            TargetOperations: ['RESOURCE', 'STACK'],
            RuleLocation: { Uri: rulesBucket.s3UrlForObject(rulesKey) },
          },
        },
      },
    };

    this.stackSet = new cfn.CfnStackSet(this, 'StackSet', {
      stackSetName: `govai-${config.customerName}-guard-hook`,
      description: 'Org-wide baseline Guard hook for the Agentic OU.',
      permissionModel: 'SERVICE_MANAGED',
      autoDeployment: { enabled: true, retainStacksOnAccountRemoval: false },
      capabilities: ['CAPABILITY_NAMED_IAM'],
      callAs: 'SELF',
      templateBody: JSON.stringify(embeddedTemplate),
      stackInstancesGroup: [
        {
          deploymentTargets: { organizationalUnitIds: [agenticOuId] },
          regions: [config.region],
        },
      ],
    });
  }
}
