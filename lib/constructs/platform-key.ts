import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface PlatformKeyProps {
  config: PlatformConfig;
  /** Human-readable purpose, used in the alias and description, e.g. 'evidence'. */
  purpose: string;
}

/**
 * Customer-managed CMK used to encrypt a governance store (logs, evidence, guardrail).
 * Rotation is always on. The key policy additionally authorises the regional CloudWatch Logs
 * service principal so CloudTrail -> CloudWatch Logs and other log groups can use it
 * (grounded against AWS docs: CloudWatch Logs encryption with a CMK requires a key-policy grant,
 * not an IAM grant, because the service — not a role — calls KMS).
 */
export class PlatformKey extends Construct {
  readonly key: kms.Key;

  constructor(scope: Construct, id: string, props: PlatformKeyProps) {
    super(scope, id);
    const { config, purpose } = props;
    const region = Stack.of(this).region;

    this.key = new kms.Key(this, 'Key', {
      description: `governed-ai ${config.customerName} ${config.environment} ${purpose} CMK`,
      alias: `governed-ai/${config.customerName}/${config.environment}/${purpose}`,
      enableKeyRotation: true,
      // Retain evidence keys in prod so encrypted logs stay readable after a stack delete.
      removalPolicy: config.environment === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Allow the regional CloudWatch Logs service to use the key, scoped to this account's log groups.
    this.key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new iam.ServicePrincipal(`logs.${region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${Stack.of(this).partition}:logs:${region}:${
              Stack.of(this).account
            }:log-group:*`,
          },
        },
      }),
    );
  }
}
