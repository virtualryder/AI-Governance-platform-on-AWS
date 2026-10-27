import * as bac from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface AgentMemoryProps {
  config: PlatformConfig;
  /** Evidence CMK ARN (imported from the baseline stack). */
  kmsKeyArn: string;
}

/**
 * AgentCore Memory store, CMK-encrypted, with a config-driven event-expiry window. Baseline creates
 * raw event storage with no extraction strategies; use-cases add semantic/summary/user-preference
 * strategies (which require a memory execution role for LLM extraction).
 */
export class AgentMemory extends Construct {
  readonly memory: bac.CfnMemory;

  constructor(scope: Construct, id: string, props: AgentMemoryProps) {
    super(scope, id);
    const { config, kmsKeyArn } = props;
    this.memory = new bac.CfnMemory(this, 'Memory', {
      name: `govai_${config.customerName.replace(/-/g, '_')}_${config.environment}`,
      description: `Governed AgentCore memory for ${config.customerName}`,
      eventExpiryDuration: config.agentcore.memoryEventExpiryDays,
      encryptionKeyArn: kmsKeyArn,
    });
  }

  get memoryId(): string {
    return this.memory.attrMemoryId;
  }
}
