import * as path from 'path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface GatewayInterceptorProps {
  config: PlatformConfig;
  /** CMK for the ledger table. */
  encryptionKey: kms.IKey;
}

/**
 * Per-user Gateway governance: a single-table DynamoDB ledger + a REQUEST interceptor Lambda that
 * enforces per-user block, model allowlist (by Cognito group), and per-user rate limit. Instantiated
 * by the AgentPlatform stack (gated on `controls.perUserGovernance.enabled`) so the gateway can attach
 * it at creation via `interceptorConfigurations` — cleaner and more robust than an UpdateGateway
 * custom resource (PORT-MAP's attach pattern). Token/USD budgets + auto-downgrade are slice-2b
 * (RESPONSE-side) extensions.
 */
export class GatewayInterceptor extends Construct {
  readonly fn: lambda.Function;
  readonly ledger: dynamodb.Table;

  constructor(scope: Construct, id: string, props: GatewayInterceptorProps) {
    super(scope, id);
    const { config, encryptionKey } = props;
    const pug = config.controls.perUserGovernance ?? { enabled: true };
    const isProd = config.environment === 'prod';

    this.ledger = new dynamodb.Table(this, 'Ledger', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.fn = new lambda.Function(this, 'Fn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'interceptor')),
      timeout: Duration.seconds(10),
      description: 'Per-user governance REQUEST interceptor (block / model allowlist / rate limit).',
      environment: {
        LEDGER_TABLE: this.ledger.tableName,
        RATE_PER_MINUTE: String(pug.ratePerMinute ?? config.controls.gatewayRequestsPerMinute ?? 0),
        ALLOWED_MODELS_BY_GROUP: JSON.stringify(pug.allowedModelsByGroup ?? {}),
      },
    });
    this.ledger.grantReadWriteData(this.fn);
  }
}
