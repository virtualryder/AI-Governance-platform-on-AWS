import { Construct } from 'constructs';
import { PlatformStack, PlatformStackProps } from './platform-stack';

/** AgentCore Identity, Gateway + Policy engine (Cedar), Memory, Runtime/Harness, Browser, observability (Task 3) */
export class AgentPlatformStack extends PlatformStack {
  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    this.publish('agent-platform/version', '0.1.0', 'AgentPlatform stack version');
  }
}
