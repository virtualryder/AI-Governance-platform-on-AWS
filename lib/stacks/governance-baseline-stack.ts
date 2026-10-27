import { Construct } from 'constructs';
import { PlatformStack, PlatformStackProps } from './platform-stack';

/** Per-account evidence layer: KMS, log bucket, CloudTrail, Bedrock invocation logging, guardrails (Task 2) */
export class GovernanceBaselineStack extends PlatformStack {
  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    this.publish('governance-baseline/version', '0.1.0', 'GovernanceBaseline stack version');
  }
}
