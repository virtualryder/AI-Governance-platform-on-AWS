import * as xray from 'aws-cdk-lib/aws-xray';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface ObservabilityProps {
  config: PlatformConfig;
}

/**
 * AgentCore Observability is convention-based: agents emit OpenTelemetry (ADOT) spans that land in
 * CloudWatch Logs, and CloudWatch Transaction Search indexes a share of them into X-Ray for the
 * GenAI trace map. There is no AgentCore-specific CFN resource for it; the one account/region knob
 * is `AWS::XRay::TransactionSearchConfig`. All spans are retained in CloudWatch Logs; only
 * `indexingPercentage` drives X-Ray indexing cost, so it defaults low (5%) and is config-tunable.
 *
 * Singleton per account/region — create it in exactly one stack (the AgentPlatform).
 */
export class Observability extends Construct {
  readonly transactionSearch: xray.CfnTransactionSearchConfig;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    this.transactionSearch = new xray.CfnTransactionSearchConfig(this, 'TransactionSearch', {
      indexingPercentage: props.config.agentcore.observabilityIndexingPercentage ?? 5,
    });
  }
}
