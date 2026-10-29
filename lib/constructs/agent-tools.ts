import * as bac from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface AgentToolsProps {
  config: PlatformConfig;
}

/**
 * Managed AgentCore tools, each gated by config:
 *  - Browser (`enableBrowser`): PUBLIC network mode — web browsing needs egress; switch to VPC when
 *    a customer requires private routing.
 *  - CodeInterpreter (`enableCodeInterpreter`): SANDBOX network mode — isolated, no network egress,
 *    the safest default for running model-generated code.
 */
export class AgentTools extends Construct {
  readonly browser?: bac.CfnBrowserCustom;
  readonly codeInterpreter?: bac.CfnCodeInterpreterCustom;

  constructor(scope: Construct, id: string, props: AgentToolsProps) {
    super(scope, id);
    const { config } = props;
    const base = `govai_${config.customerName.replace(/-/g, '_')}_${config.environment}`;

    const net = config.agentcore.network;
    if (config.agentcore.enableBrowser) {
      // Private networking (Gate 5): put the browser in the customer VPC when configured, so web
      // egress goes through the customer's controlled path rather than AgentCore-managed PUBLIC egress.
      const browserNetwork =
        net?.mode === 'VPC'
          ? { networkMode: 'VPC', vpcConfig: { subnets: net.subnetIds!, securityGroups: net.securityGroupIds! } }
          : { networkMode: 'PUBLIC' };
      this.browser = new bac.CfnBrowserCustom(this, 'Browser', {
        name: `${base}_browser`,
        description: `Governed browser tool for ${config.customerName}`,
        networkConfiguration: browserNetwork,
      });
    }

    if (config.agentcore.enableCodeInterpreter) {
      this.codeInterpreter = new bac.CfnCodeInterpreterCustom(this, 'CodeInterpreter', {
        name: `${base}_code`,
        description: `Governed code interpreter for ${config.customerName}`,
        networkConfiguration: { networkMode: 'SANDBOX' },
      });
    }
  }
}
