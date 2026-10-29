import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface EvidenceBucketProps {
  config: PlatformConfig;
  /** CMK the bucket is encrypted with (customer-managed, required by security defaults). */
  encryptionKey: kms.IKey;
  /** Spoke→hub evidence delivery (Gate 3): replicate this (source) bucket to the hub archive. */
  replicateTo?: { bucketArn: string; kmsKeyArn?: string; accountId: string };
  /** Hub archive: allow inbound cross-account replication from these spoke accounts' replication
   * roles (deterministic name `govai-*-evidence-replication`). */
  allowReplicationFromAccounts?: string[];
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
    const { config, encryptionKey, replicateTo, allowReplicationFromAccounts } = props;
    const isProd = config.environment === 'prod';
    const retention = Duration.days(config.governance.logRetentionDays);
    const stack = Stack.of(this);
    const replicationRoleName = `govai-${config.customerName}-${config.environment}-evidence-replication`;

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

    // --- Gate 3: spoke → hub evidence replication (source side) ---
    // Set via the CfnBucket escape hatch to avoid the role↔bucket circular dependency (the role
    // references the source bucket ARN, the bucket's replication config references the role).
    if (replicateTo) {
      const replRole = new iam.Role(this, 'ReplicationRole', {
        roleName: replicationRoleName,
        assumedBy: new iam.ServicePrincipal('s3.amazonaws.com'),
        description: 'S3 replication role delivering evidence to the hub central archive.',
      });
      replRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ReadSource',
          actions: [
            's3:GetReplicationConfiguration',
            's3:ListBucket',
            's3:GetObjectVersionForReplication',
            's3:GetObjectVersionAcl',
            's3:GetObjectVersionTagging',
            's3:GetObjectLegalHold',
            's3:GetObjectRetention',
          ],
          resources: [this.bucket.bucketArn, `${this.bucket.bucketArn}/*`],
        }),
      );
      replRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ReplicateToHub',
          actions: ['s3:ReplicateObject', 's3:ReplicateDelete', 's3:ReplicateTags', 's3:ObjectOwnerOverrideToBucketOwner'],
          resources: [`${replicateTo.bucketArn}/*`],
        }),
      );
      encryptionKey.grantDecrypt(replRole); // decrypt source objects
      if (replicateTo.kmsKeyArn) {
        kms.Key.fromKeyArn(this, 'HubArchiveKey', replicateTo.kmsKeyArn).grantEncrypt(replRole); // encrypt replicas
      }

      (this.bucket.node.defaultChild as s3.CfnBucket).replicationConfiguration = {
        role: replRole.roleArn,
        rules: [
          {
            status: 'Enabled',
            priority: 0,
            deleteMarkerReplication: { status: 'Disabled' },
            filter: {},
            destination: {
              bucket: replicateTo.bucketArn,
              account: replicateTo.accountId,
              // Hand replica ownership to the hub account so it fully controls the evidence.
              accessControlTranslation: { owner: 'Destination' },
              ...(replicateTo.kmsKeyArn
                ? { encryptionConfiguration: { replicaKmsKeyId: replicateTo.kmsKeyArn } }
                : {}),
            },
            ...(replicateTo.kmsKeyArn ? { sourceSelectionCriteria: { sseKmsEncryptedObjects: { status: 'Enabled' } } } : {}),
          },
        ],
      };
    }

    // --- Gate 3: hub archive accepts inbound replication from spoke accounts (destination side) ---
    if (allowReplicationFromAccounts?.length) {
      const spokeRoleArns = allowReplicationFromAccounts.map(
        (acct) => `arn:${stack.partition}:iam::${acct}:role/govai-${config.customerName}-*-evidence-replication`,
      );
      this.bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowSpokeEvidenceReplication',
          principals: allowReplicationFromAccounts.map((a) => new iam.AccountPrincipal(a)),
          actions: ['s3:ReplicateObject', 's3:ReplicateDelete', 's3:ReplicateTags', 's3:ObjectOwnerOverrideToBucketOwner', 's3:GetBucketVersioning', 's3:PutBucketVersioning'],
          resources: [this.bucket.bucketArn, `${this.bucket.bucketArn}/*`],
          conditions: { StringLike: { 'aws:PrincipalArn': spokeRoleArns } },
        }),
      );
      // The hub archive CMK must let the spoke replication roles encrypt the replicas.
      if (encryptionKey instanceof kms.Key) {
        encryptionKey.addToResourcePolicy(
          new iam.PolicyStatement({
            sid: 'AllowSpokeReplicaEncryption',
            principals: allowReplicationFromAccounts.map((a) => new iam.AccountPrincipal(a)),
            actions: ['kms:Encrypt', 'kms:GenerateDataKey'],
            resources: ['*'],
            conditions: { StringLike: { 'aws:PrincipalArn': spokeRoleArns } },
          }),
        );
      }
    }
  }
}
