import { Construct } from 'constructs';
import { PlatformStack, PlatformStackProps } from './platform-stack';

/** Bedrock org policy, Agentic-OU SCPs, Guard hooks via StackSets (Task 5) */
export class OrgFoundationStack extends PlatformStack {
  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    this.publish('org-foundation/version', '0.1.0', 'OrgFoundation stack version');
  }
}
