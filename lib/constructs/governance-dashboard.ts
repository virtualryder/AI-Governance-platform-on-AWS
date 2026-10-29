import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface GovernanceDashboardProps {
  config: PlatformConfig;
}

/**
 * Governance dashboard (D4) for the hub — a CloudWatch dashboard summarizing the platform's
 * governance signals: Bedrock guardrail interventions, model invocations, and AgentCore gateway
 * activity. Uses `AWS::CloudWatch::Dashboard` (native, in aws-cdk-lib). This is the always-on,
 * zero-prerequisite governance view. The richer CloudWatch Omni Space (`AWS::CloudWatch::Space` /
 * `AWS::CloudWatch::OmniDashboard`) is the per-customer upgrade — see `OmniObservability`
 * (`lib/constructs/omni-observability.ts`), gated on an Omni domain existing (`agentcore.omni`).
 */
export class GovernanceDashboard extends Construct {
  readonly dashboard: cloudwatch.CfnDashboard;

  constructor(scope: Construct, id: string, props: GovernanceDashboardProps) {
    super(scope, id);
    const { config } = props;

    const body = {
      widgets: [
        {
          type: 'text',
          x: 0,
          y: 0,
          width: 24,
          height: 2,
          properties: {
            markdown:
              `# Governed AI — ${config.customerName} (${config.environment})\n` +
              'Guardrail interventions, model invocations, and gateway activity. ' +
              'Agent traces: CloudWatch Transaction Search (X-Ray) / GenAI Observability.',
          },
        },
        {
          type: 'metric',
          x: 0,
          y: 2,
          width: 12,
          height: 6,
          properties: {
            title: 'Bedrock guardrail interventions',
            region: config.region,
            stat: 'Sum',
            metrics: [['AWS/Bedrock/Guardrails', 'InvocationsIntervened']],
          },
        },
        {
          type: 'metric',
          x: 12,
          y: 2,
          width: 12,
          height: 6,
          properties: {
            title: 'Bedrock model invocations',
            region: config.region,
            stat: 'Sum',
            metrics: [['AWS/Bedrock', 'Invocations']],
          },
        },
      ],
    };

    this.dashboard = new cloudwatch.CfnDashboard(this, 'Dashboard', {
      dashboardName: `governed-ai-${config.customerName}-${config.environment}`,
      dashboardBody: JSON.stringify(body),
    });
  }
}
