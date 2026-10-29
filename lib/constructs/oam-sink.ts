import * as oam from 'aws-cdk-lib/aws-oam';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface OamSinkProps {
  config: PlatformConfig;
}

/**
 * CloudWatch cross-account observability (OAM) sink in the hub. Spoke accounts attach a `Link` to
 * this sink to share metrics, logs, and X-Ray traces into the hub for the governance dashboard. The
 * sink resource policy scopes who may link to the customer's AWS Organization (aws:PrincipalOrgID)
 * and restricts the shared resource types. Create it only in the dedicated hub account.
 */
export class OamSink extends Construct {
  readonly sink: oam.CfnSink;

  constructor(scope: Construct, id: string, props: OamSinkProps) {
    super(scope, id);
    const { config } = props;
    // An unrestricted (Principal:* with no org condition) sink would let ANY AWS account link in.
    // Require an organization id (hub- or org-scoped) so the sink is always org-allowlisted.
    const orgId = config.hub?.organizationId ?? config.org?.organizationId;
    if (!orgId) {
      throw new Error(
        'OamSink requires an organization id (hub.organizationId or org.organizationId) to scope who ' +
          'may link to the governance sink; refusing to create an org-unrestricted sink.',
      );
    }

    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: '*',
          Action: ['oam:CreateLink', 'oam:UpdateLink'],
          Resource: '*',
          Condition: {
            'ForAllValues:StringEquals': {
              'oam:ResourceTypes': [
                'AWS::CloudWatch::Metric',
                'AWS::Logs::LogGroup',
                'AWS::XRay::Trace',
                'AWS::ApplicationSignals::Service',
              ],
            },
            // Only principals in the customer's org may link to the governance sink.
            StringEquals: { 'aws:PrincipalOrgID': orgId },
          },
        },
      ],
    };

    this.sink = new oam.CfnSink(this, 'Sink', {
      name: `govai-${config.customerName}-${config.environment}`,
      policy,
    });
  }
}
