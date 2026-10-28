import { Construct } from 'constructs';
import { PlatformStack, PlatformStackProps } from './platform-stack';
import { PlatformKey } from '../constructs/platform-key';
import { EvidenceBucket } from '../constructs/evidence-bucket';
import { OamSink } from '../constructs/oam-sink';
import { PlatformCatalog } from '../constructs/service-catalog';
import { applyHubNagSuppressions } from './governance-hub-nag-suppressions';

/**
 * Governance hub (Task 5): dedicated AI-governance account shared services. Slice 1 ships the central
 * log archive (WORM) and the OAM cross-account observability sink. Slice 2 adds the Agent Registry
 * (+ RAM share), CloudWatch Omni dashboard, and the Service Catalog portfolio/product.
 *
 * Cross-account features are created only in dedicated `hub` mode. In `standalone` the hub is
 * "collapsed" — the per-account baseline already provides evidence/audit, so this stack stays minimal.
 */
export class GovernanceHubStack extends PlatformStack {
  readonly logArchive?: EvidenceBucket;
  readonly oamSink?: OamSink;
  readonly catalog?: PlatformCatalog;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    if (this.mode === 'hub') {
      const key = new PlatformKey(this, 'LogArchiveKey', { config: this.config, purpose: 'log-archive' });
      this.logArchive = new EvidenceBucket(this, 'LogArchive', {
        config: this.config,
        encryptionKey: key.key,
      });
      this.oamSink = new OamSink(this, 'Oam', { config: this.config });
      this.catalog = new PlatformCatalog(this, 'Catalog', { config: this.config });

      this.publish('hub/log-archive-bucket', this.logArchive.bucket.bucketName, 'Central log archive bucket');
      this.publish('hub/oam-sink-arn', this.oamSink.sink.attrArn, 'OAM observability sink ARN');
      this.publish('hub/catalog-portfolio-id', this.catalog.portfolio.portfolioId, 'Service Catalog portfolio ID');
      applyHubNagSuppressions(this);
    }

    this.publish('governance-hub/version', '0.2.0', 'GovernanceHub stack version');
  }
}
