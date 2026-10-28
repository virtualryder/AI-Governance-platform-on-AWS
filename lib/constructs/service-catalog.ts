import { RemovalPolicy } from 'aws-cdk-lib';
import * as servicecatalog from 'aws-cdk-lib/aws-servicecatalog';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

/**
 * The provisioned product: a "governed data workspace" — a CMK-encrypted, block-public-access,
 * TLS-only, versioned bucket an agency team can self-service from the hub without hand-rolling the
 * platform's security defaults. A real deployment extends this ProductStack with the team's
 * use-case resources; it exists here as the reference self-service unit.
 */
class GovernedWorkspaceProduct extends servicecatalog.ProductStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const key = new kms.Key(this, 'Key', { enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN });
    new s3.Bucket(this, 'Workspace', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      enforceSSL: true,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });
  }
}

export interface PlatformCatalogProps {
  config: PlatformConfig;
}

/**
 * Service Catalog portfolio + the governed-workspace product. Shared from the hub so agency teams
 * self-service compliant building blocks (org-wide / per-OU / per-account sharing configured at rollout).
 */
export class PlatformCatalog extends Construct {
  readonly portfolio: servicecatalog.Portfolio;
  readonly product: servicecatalog.CloudFormationProduct;

  constructor(scope: Construct, id: string, props: PlatformCatalogProps) {
    super(scope, id);
    const { config } = props;

    this.portfolio = new servicecatalog.Portfolio(this, 'Portfolio', {
      displayName: `Governed AI (${config.customerName})`,
      providerName: 'Governed AI Platform',
      description: 'Self-service governed building blocks for AI workloads.',
    });

    this.product = new servicecatalog.CloudFormationProduct(this, 'GovernedWorkspace', {
      productName: 'Governed data workspace',
      owner: 'Governed AI Platform',
      productVersions: [
        {
          productVersionName: 'v1',
          cloudFormationTemplate: servicecatalog.CloudFormationTemplate.fromProductStack(
            new GovernedWorkspaceProduct(this, 'GovernedWorkspaceStack'),
          ),
        },
      ],
    });
    this.portfolio.addProduct(this.product);
  }
}
