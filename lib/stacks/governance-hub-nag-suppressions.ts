import { NagSuppressions } from 'cdk-nag';
import { Stack } from 'aws-cdk-lib';

/** Justified cdk-nag suppressions for the GovernanceHub central log archive (CLAUDE.md rule 6). */
export function applyHubNagSuppressions(stack: Stack): void {
  const sid = stack.stackName;
  NagSuppressions.addResourceSuppressionsByPath(stack, `${sid}/LogArchive/Bucket/Resource`, [
    {
      id: 'AwsSolutions-S1',
      reason:
        'This IS the central log-archive sink. Server access logging would require a secondary ' +
        'self-logging bucket; access is instead constrained by block-public-access, TLS-only, Object ' +
        'Lock (WORM), CMK encryption, and the control-plane-integrity SCP that protects evidence vaults.',
    },
    {
      id: 'HIPAA.Security-S3BucketLoggingEnabled',
      reason: 'Same as AwsSolutions-S1: the archive is the logging destination, not a source needing its own access log.',
    },
    {
      id: 'HIPAA.Security-S3BucketReplicationEnabled',
      reason:
        'Cross-region replication of the archive is a per-customer DR decision configured at rollout, not ' +
        'a platform default; durability relies on S3 + versioning + Object Lock.',
    },
  ]);
}
