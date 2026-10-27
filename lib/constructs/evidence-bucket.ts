import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface EvidenceBucketProps {
  config: PlatformConfig;
  /** CMK the bucket is encrypted with (customer-managed, required by security defaults). */
  encryptionKey: kms.IKey;
}

/**
 * WORM evidence/log bucket: the account's tamper-evident sink for CloudTrail and other governance
 * artefacts. Security defaults (CLAUDE.md rule 6): customer-managed KMS, block public access,
 * TLS-only, versioning. Object Lock makes it write-once: COMPLIANCE mode in prod (immutable even to
 * root for the retention window), GOVERNANCE mode elsewhere (privileged bypass for dev teardown).
 *
 * Note: with Object Lock on, objects cannot be auto-deleted inside the retention window, so
 * `autoDeleteObjects` is never set — a non-prod `cdk destroy` needs a GOVERNANCE bypass to empty it.
 */
export class EvidenceBucket extends Construct {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: EvidenceBucketProps) {
    super(scope, id);
    const { config, encryptionKey } = props;
    const isProd = config.environment === 'prod';
    const retention = Duration.days(config.governance.logRetentionDays);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      bucketKeyEnabled: true,
      enforceSSL: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectLockEnabled: true,
      objectLockDefaultRetention: isProd
        ? s3.ObjectLockRetention.compliance(retention)
        : s3.ObjectLockRetention.governance(retention),
      lifecycleRules: [
        {
          // Expire non-current versions past retention; keep the WORM window intact for current ones.
          noncurrentVersionExpiration: retention,
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
  }
}
