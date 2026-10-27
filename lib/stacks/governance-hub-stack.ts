import { Construct } from 'constructs';
import { PlatformStack, PlatformStackProps } from './platform-stack';

/** Agent Registry, central observability + Omni, log archive, Service Catalog portfolio (Task 5) */
export class GovernanceHubStack extends PlatformStack {
  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    this.publish('governance-hub/version', '0.1.0', 'GovernanceHub stack version');
  }
}
