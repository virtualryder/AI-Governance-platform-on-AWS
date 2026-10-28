import * as path from 'path';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as cfn from 'aws-cdk-lib/aws-cloudformation';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface GuardHooksProps {
  config: PlatformConfig;
}

/**
 * Proactive deploy-time policy-as-code: a CloudFormation Guard Hook evaluates every create/update
 * stack operation against the platform's baseline Guard rules (policies/guard/) and WARNs (default)
 * or FAILs on violations. This reference activates the hook in the account it is deployed to
 * (management/hub); org-wide rollout to the Agentic OU is via service-managed StackSets so new
 * workload accounts inherit it automatically.
 *
 * Starts in WARN so a first rollout observes before blocking; flip to FAIL once the rules are tuned.
 */
export class GuardHooks extends Construct {
  readonly hook: cfn.CfnGuardHook;
  readonly rulesBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: GuardHooksProps) {
    super(scope, id);
    const { config } = props;

    // Rules bucket — itself compliant with the baseline Guard rules it stores (BPA, TLS, encryption).
    this.rulesBucket = new s3.Bucket(this, 'Rules', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: config.environment === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: config.environment !== 'prod',
    });

    const deploy = new s3deploy.BucketDeployment(this, 'Deploy', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', '..', 'policies', 'guard'))],
      destinationBucket: this.rulesBucket,
      destinationKeyPrefix: 'rules',
    });

    // Role the Hooks service assumes to read the Guard rules from S3.
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('hooks.cloudformation.amazonaws.com'),
      description: 'CloudFormation Guard Hook execution role (reads Guard rules from S3).',
    });
    this.rulesBucket.grantRead(executionRole);

    this.hook = new cfn.CfnGuardHook(this, 'Hook', {
      alias: 'GovAI::Guard::Baseline',
      executionRole: executionRole.roleArn,
      failureMode: 'WARN',
      hookStatus: 'ENABLED',
      targetOperations: ['RESOURCE', 'STACK'],
      ruleLocation: { uri: this.rulesBucket.s3UrlForObject('rules/baseline.guard') },
    });
    // Rules must be uploaded before the hook activates.
    this.hook.node.addDependency(deploy);
  }
}
