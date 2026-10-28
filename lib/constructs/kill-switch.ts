import * as path from 'path';
import { Duration, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface KillSwitchProps {
  config: PlatformConfig;
  /** SSM namespace the platform publishes under, e.g. /governed-ai/<customer>/<env>. */
  paramPrefix: string;
}

/**
 * Layered kill switch. The Cedar layer (forbid-all attached to the policy engine) is the fast,
 * agent-graph-wide cut-off; a fail-closed SSM flag records state for other controls/runtime to read.
 * Invoke the function with `{"action":"engage"}` to cut off, `{"action":"release"}` to restore.
 * (Endpoint-disable and org-SCP layers are added in step 5.)
 */
export class KillSwitch extends Construct {
  readonly fn: lambda.Function;
  readonly stateParam: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: KillSwitchProps) {
    super(scope, id);
    const { paramPrefix } = props;
    const stack = Stack.of(this);

    this.stateParam = new ssm.StringParameter(this, 'State', {
      parameterName: `${paramPrefix}/controls/kill-switch-state`,
      stringValue: 'normal',
      description: 'Kill switch state: normal | engaged (fail-closed).',
    });

    this.fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'kill-switch')),
      timeout: Duration.seconds(30),
      environment: { PARAM_PREFIX: paramPrefix },
      description: 'Engage/release the governed-AI kill switch (forbid-all Cedar + SSM flag).',
    });

    // Read platform discovery params and the kill-switch flag; manage Cedar policies on the engine.
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [
          `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${paramPrefix}/*`,
        ],
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreatePolicy',
          'bedrock-agentcore:DeletePolicy',
          'bedrock-agentcore:ListPolicies',
        ],
        resources: ['*'],
      }),
    );
  }
}
