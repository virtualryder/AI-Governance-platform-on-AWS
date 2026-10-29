import * as oam from 'aws-cdk-lib/aws-oam';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface ObservabilityLinkProps {
  config: PlatformConfig;
  /** The hub OAM sink ARN this spoke links to (`hub.oamSinkArn`). */
  sinkArn: string;
}

/**
 * Spoke side of CloudWatch cross-account observability (OAM): an `AWS::Oam::Link` that shares this
 * account's metrics, logs, and traces into the hub's OAM sink so the hub's governance dashboard can
 * see spoke telemetry (Gate 3). The hub sink's resource policy restricts who may link (by
 * `aws:PrincipalOrgID`); this link names the hub sink explicitly.
 *
 * NOT YET LIVE-VALIDATED across two accounts — requires a hub account + spoke account in one
 * Organization. Synth/nag/test-verified; the cross-account flow is a Gate-3 live-validation item.
 */
export class ObservabilityLink extends Construct {
  readonly link: oam.CfnLink;

  constructor(scope: Construct, id: string, props: ObservabilityLinkProps) {
    super(scope, id);
    const { config, sinkArn } = props;

    this.link = new oam.CfnLink(this, 'Link', {
      sinkIdentifier: sinkArn,
      labelTemplate: `govai-${config.customerName}-${config.environment}-$AccountName`,
      resourceTypes: [
        'AWS::CloudWatch::Metric',
        'AWS::Logs::LogGroup',
        'AWS::XRay::Trace',
        'AWS::ApplicationSignals::Service',
      ],
    });
  }
}
