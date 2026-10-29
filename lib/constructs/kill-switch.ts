import * as path from 'path';
import { Duration, Stack } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface KillSwitchProps {
  config: PlatformConfig;
  /** SSM namespace the platform publishes under, e.g. /governed-ai/<customer>/<env>. */
  paramPrefix: string;
  /** Evidence CMK — the policy engine encrypts Cedar policy content with it, so creating the
   * forbid-all policy requires KMS access to this key. */
  encryptionKey: kms.IKey;
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
    const { paramPrefix, encryptionKey } = props;
    const stack = Stack.of(this);

    this.stateParam = new ssm.StringParameter(this, 'State', {
      parameterName: `${paramPrefix}/controls/kill-switch-state`,
      stringValue: 'normal',
      description: 'Kill switch state: normal | engaged (fail-closed).',
    });

    this.fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      // Bundle a current boto3: the runtime's bundled SDK predates newer AgentCore policy operations
      // (e.g. ListPolicySummaries and create_policy's enforcementMode), which the kill switch needs.
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'kill-switch'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_13.bundlingImage,
          command: ['bash', '-c', 'pip install --no-cache-dir boto3 -t /asset-output && cp index.py /asset-output'],
        },
      }),
      timeout: Duration.seconds(120), // polls async Create/DeletePolicy to completion
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
    // Break-glass control: creating the forbid-all Cedar policy requires the policy-engine ops PLUS
    // read/call access to the gateway (CreatePolicy validates the policy against the gateway's live
    // tool schema — it lists targets AND calls the gateway). Rather than enumerate every validation
    // action, grant bedrock-agentcore:* SCOPED to THIS platform's gateway + policy engines (not
    // account-wide) — justified for an emergency kill switch and resilient to validation-path changes.
    const c = props.config;
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'KillSwitchAgentCore',
        actions: ['bedrock-agentcore:*'],
        resources: [
          `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:gateway/govai-${c.customerName}-${c.environment}-*`,
          `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:policy-engine/*`,
        ],
      }),
    );
    // The policy engine encrypts Cedar policy content with the evidence CMK; creating the forbid-all
    // policy needs GenerateDataKey/Encrypt (and Decrypt) on it.
    encryptionKey.grantEncryptDecrypt(this.fn);
  }
}
