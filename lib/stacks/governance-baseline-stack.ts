import { Construct } from 'constructs';
import { PlatformStack, PlatformStackProps } from './platform-stack';
import { PlatformKey } from '../constructs/platform-key';
import { EvidenceBucket } from '../constructs/evidence-bucket';
import { AuditTrail } from '../constructs/audit-trail';
import { InvocationLogging } from '../constructs/invocation-logging';
import { PlatformGuardrail } from '../constructs/guardrail';
import { toRetentionDays } from '../constructs/retention';
import { applyBaselineNagSuppressions } from './baseline-nag-suppressions';

/**
 * Per-account evidence layer (Task 2): customer-managed KMS, WORM evidence/log bucket, CloudTrail
 * with AgentCore data events, Bedrock model-invocation logging, and a versioned guardrail with an
 * account-level ungoverned-inference deny. Deployed in standalone and spoke modes.
 */
export class GovernanceBaselineStack extends PlatformStack {
  readonly evidenceKey: PlatformKey;
  readonly evidenceBucket: EvidenceBucket;
  readonly auditTrail: AuditTrail;
  readonly guardrail?: PlatformGuardrail;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    this.evidenceKey = new PlatformKey(this, 'EvidenceKey', {
      config: this.config,
      purpose: 'evidence',
    });

    this.evidenceBucket = new EvidenceBucket(this, 'Evidence', {
      config: this.config,
      encryptionKey: this.evidenceKey.key,
    });

    this.auditTrail = new AuditTrail(this, 'Audit', {
      config: this.config,
      bucket: this.evidenceBucket.bucket,
      encryptionKey: this.evidenceKey.key,
    });

    if (this.config.governance.invocationLogging) {
      new InvocationLogging(this, 'InvocationLogging', {
        config: this.config,
        encryptionKey: this.evidenceKey.key,
        retention: toRetentionDays(this.config.governance.logRetentionDays),
      });
    }

    if (this.config.governance.guardrail.enabled) {
      this.guardrail = new PlatformGuardrail(this, 'Guardrail', {
        config: this.config,
        encryptionKey: this.evidenceKey.key,
      });
      this.publish('baseline/guardrail-id', this.guardrail.guardrailId, 'Baseline guardrail identifier');
      this.publish('baseline/guardrail-version', this.guardrail.version.attrVersion, 'Pinned guardrail version');
      if (this.guardrail.ungovernedInferenceDenyPolicy) {
        this.publish(
          'baseline/ungoverned-inference-deny-arn',
          this.guardrail.ungovernedInferenceDenyPolicy.managedPolicyArn,
          'Managed policy denying inference without a guardrail',
        );
      }
    }

    this.publish('baseline/evidence-key-arn', this.evidenceKey.key.keyArn, 'Evidence CMK ARN');
    this.publish('baseline/evidence-bucket', this.evidenceBucket.bucket.bucketName, 'Evidence/log bucket name');
    this.publish('baseline/trail-arn', this.auditTrail.trail.trailArn, 'CloudTrail trail ARN');
    this.publish('governance-baseline/version', '0.4.0', 'GovernanceBaseline stack version');

    applyBaselineNagSuppressions(this);
  }
}
