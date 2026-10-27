import { Construct } from 'constructs';
import { PlatformStack, PlatformStackProps } from './platform-stack';

/** Kill switch, HITL, budgets, rate limits, Guard hooks, Service Catalog (Task 4) */
export class ControlsStack extends PlatformStack {
  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    this.publish('controls/version', '0.1.0', 'Controls stack version');
  }
}
