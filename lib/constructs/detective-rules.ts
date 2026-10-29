import * as path from 'path';
import { Duration, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as config from 'aws-cdk-lib/aws-config';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface DetectiveRulesProps {
  config: PlatformConfig;
}

/** SRA-style detective layer: AWS Config custom rules that continuously check the account's governance
 * posture (Bedrock model-invocation logging configured; at least one guardrail present). Requires an
 * AWS Config recorder in the account (Control Tower / landing zone provides one). */
const CHECKS: { name: string; description: string }[] = [
  { name: 'invocation-logging', description: 'Bedrock model-invocation logging must be configured.' },
  { name: 'guardrails-present', description: 'At least one Bedrock guardrail must exist.' },
];

export class DetectiveRules extends Construct {
  readonly fn: lambda.Function;
  readonly rules: config.CfnConfigRule[] = [];

  constructor(scope: Construct, id: string, props: DetectiveRulesProps) {
    super(scope, id);
    const stack = Stack.of(this);

    this.fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'detective')),
      timeout: Duration.seconds(30),
      environment: { ACCOUNT_ID: stack.account },
      description: `SRA detective Config-rule checks for ${props.config.customerName}`,
    });
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:GetModelInvocationLoggingConfiguration', 'bedrock:ListGuardrails', 'config:PutEvaluations'],
        resources: ['*'],
      }),
    );
    this.fn.addPermission('ConfigInvoke', { principal: new iam.ServicePrincipal('config.amazonaws.com') });

    for (const check of CHECKS) {
      const rule = new config.CfnConfigRule(this, `Rule-${check.name}`, {
        configRuleName: `govai-detect-${check.name}`,
        description: check.description,
        source: {
          owner: 'CUSTOM_LAMBDA',
          sourceIdentifier: this.fn.functionArn,
          sourceDetails: [
            { eventSource: 'aws.config', messageType: 'ScheduledNotification', maximumExecutionFrequency: 'TwentyFour_Hours' },
          ],
        },
      });
      // Config must be allowed to invoke the Lambda before the rule evaluates.
      rule.node.addDependency(this.fn);
      this.rules.push(rule);
    }
  }
}
